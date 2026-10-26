// Shared tender core: stage derivation, buyer authority matrix, supplier entity checks, the hash-chained audit trail, and the single
// gate every sealed envelope read goes through. Every capability and file route calls these, so the rules live in one place.
import { createHash } from 'node:crypto';
import { pool, one, many } from '../db.js';
import { encrypt, decrypt } from '../crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin } from '../helpers.js';
import { hasOrgGrant } from '../org-access.js';
import { notify } from '../notify.js';

export const BUYER_ROLES = ['owner', 'author', 'technical_evaluator', 'commercial_evaluator', 'chair', 'approver', 'legal_reviewer', 'auditor', 'stakeholder', 'opener'];

/** What each buyer role may do. Authority never comes from a generic organisation membership or a supplier role. */
const CAN = {
  owner: ['view', 'edit', 'request_approval', 'publish', 'addendum', 'schedule', 'invite', 'qna', 'members', 'report', 'scenario', 'order', 'rounds', 'files'],
  author: ['view', 'edit', 'request_approval', 'addendum', 'invite', 'qna', 'report', 'files'],
  technical_evaluator: ['view', 'score_technical', 'read_technical'],
  commercial_evaluator: ['view', 'score_commercial', 'read_commercial'],
  chair: ['view', 'consensus', 'rank', 'scenario', 'recommend', 'read_technical', 'read_commercial', 'rounds', 'report', 'gate', 'disqualify_request', 'order'],
  approver: ['view', 'approve', 'report'],
  legal_reviewer: ['view', 'qna'],
  auditor: ['view', 'audit', 'report', 'read_register'],
  stakeholder: ['view'],
  opener: ['view', 'open'],
};
// owner may also qualify bids and run the process, but reading sealed commercial content is limited to the roles that need it
CAN.owner.push('approve', 'gate', 'read_technical', 'read_commercial', 'rank', 'recommend', 'consensus', 'disqualify_request', 'open');

export const can = (roles, action) => roles.some((r) => CAN[r]?.includes(action));

export const stageOf = (p, now = new Date()) => {
  const t = (d) => (d ? new Date(d).getTime() : null), n = now.getTime();
  if (p.status === 'cancelled') return 'cancelled';
  if (p.status === 'archived') return 'archived';
  if (p.status === 'draft') return 'draft';
  if (p.status === 'in_review') return 'approval';
  if (p.status === 'approved') return p.publish_at && t(p.publish_at) > n ? 'scheduled' : 'approved';
  if (p.status === 'published') {
    if (p.suspended_at) return 'suspended';
    if (t(p.publish_at) && t(p.publish_at) > n) return 'scheduled';
    if (t(p.closes_at) && n >= t(p.closes_at)) return 'closed';
    if (t(p.clarification_deadline) && n >= t(p.clarification_deadline)) return 'submission';
    return 'open';
  }
  return { evaluation: 'evaluation', award: 'award', awarded: 'awarded', closed: 'closed' }[p.status] ?? p.status;
};

export const getProject = async (id, c = pool) => {
  const p = (await c.query('SELECT * FROM proc_projects WHERE id=$1', [id])).rows[0];
  if (!p) throw notFound('Tender');
  return p;
};
export const lockProject = async (c, id) => {
  const p = (await c.query('SELECT * FROM proc_projects WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!p) throw notFound('Tender');
  return p;
};

/** Mandate roles the user holds for this organisation/event (live: revoked or expired mandates give nothing). */
export const mandatesOf = async (user, orgId, eventId, c = pool) => orgId
  ? (await c.query('SELECT role FROM proc_mandates WHERE organisation_id=$1 AND user_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND (event_id IS NULL OR event_id IS NOT DISTINCT FROM $3)', [orgId, user.id, eventId ?? null])).rows.map((r) => r.role)
  : [];

/** Venue authority, read live on every call: the owner, an active manager (not plain staff), or an owner/admin of the organisation the venue belongs to. */
export async function venueAuthority(user, venueId, c = pool) {
  if (!user || !venueId) return false;
  if (isAdmin(user)) return true;
  const v = (await c.query('SELECT owner_id, organisation_id FROM venues WHERE id=$1', [venueId])).rows[0];
  if (!v) return false;
  if (v.owner_id === user.id) return true;
  if ((await c.query("SELECT 1 FROM venue_staff WHERE venue_id=$1 AND user_id=$2 AND role='manager' AND removed_at IS NULL", [venueId, user.id])).rowCount) return true;
  return v.organisation_id ? hasOrgGrant(user, v.organisation_id, ['owner', 'admin'], c) : false;
}

/** Who may start a tender for an organisation, an event or a venue: org owner/admin, a procurement mandate, the event's organiser, or the venue's owner or manager. */
export async function assertMayCreate(user, { organisation_id, event_id, venue_id }, c = pool) {
  if (isAdmin(user)) return;
  if (venue_id) {
    if (!(await c.query('SELECT 1 FROM venues WHERE id=$1', [venue_id])).rowCount) throw notFound('Venue');
    if (await venueAuthority(user, venue_id, c)) return;
    throw forbidden('Only the venue owner or a venue manager can hire suppliers for this venue');
  }
  let ev = null;
  if (event_id) ev = (await c.query('SELECT organizer_id, organisation_id FROM events WHERE id=$1', [event_id])).rows[0];
  if (event_id && !ev) throw notFound('Event');
  if (ev && organisation_id && ev.organisation_id && ev.organisation_id !== organisation_id) throw badRequest('That event belongs to a different organisation');
  const org = organisation_id ?? ev?.organisation_id ?? null;
  if (org && (await hasOrgGrant(user, org, ['owner', 'admin'], c))) return;
  if (org && (await mandatesOf(user, org, event_id, c)).some((r) => ['procurement_admin', 'author'].includes(r))) return;
  if (ev && ev.organizer_id === user.id && !org) return;
  if (ev && ev.organizer_id === user.id && org && !(await c.query("SELECT 1 FROM organisations WHERE id=$1 AND status='archived'", [org])).rowCount) return;
  throw forbidden('You do not have procurement authority for this organisation or event');
}

/** Effective buyer roles for a user on a project. Empty array = not part of the buying side. */
export async function buyerRoles(user, p, c = pool) {
  const roles = new Set();
  if (!user) return [];
  if (isAdmin(user)) roles.add('owner');
  if (p.owner_user_id === user.id) roles.add('owner');
  if (p.organisation_id && (await hasOrgGrant(user, p.organisation_id, ['owner', 'admin'], c))) roles.add('owner');
  if (p.organisation_id && (await mandatesOf(user, p.organisation_id, p.event_id, c)).includes('procurement_admin')) roles.add('owner');
  if (p.venue_id && !roles.has('owner') && (await venueAuthority(user, p.venue_id, c))) roles.add('owner');
  if (p.event_id && !roles.has('owner')) {
    const ev = (await c.query('SELECT organizer_id, organisation_id FROM events WHERE id=$1', [p.event_id])).rows[0];
    if (ev && ev.organizer_id === user.id) roles.add('owner');
  }
  for (const r of (await c.query('SELECT role FROM proc_members WHERE project_id=$1 AND user_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())', [p.id, user.id])).rows) roles.add(r.role);
  return [...roles];
}

/**
 * Load a project for a buyer-side action. Outsiders get 404 (existence is not leaked); a member whose role lacks the action gets 403.
 * Returns { project, roles }.
 */
export async function requireBuyer(user, projectId, action, c = pool, { lock = false } = {}) {
  const project = lock ? await lockProject(c, projectId) : await getProject(projectId, c);
  const roles = await buyerRoles(user, project, c);
  if (!roles.length) throw notFound('Tender');
  if (action && !can(roles, action)) throw forbidden('Your role on this tender does not allow that');
  return { project, roles };
}

// ------------------------------------------------------------------ supplier side
export async function entityRole(user, entityId, c = pool) {
  if (!user) return null;
  const r = (await c.query("SELECT m.role, e.status FROM supplier_entity_members m JOIN supplier_entities e ON e.id=m.entity_id WHERE m.entity_id=$1 AND m.user_id=$2 AND m.status='active'", [entityId, user.id])).rows[0];
  return r ? r.role : null;
}
/** A supplier entity the user belongs to (404 otherwise). roles limits which entity roles may act. */
export async function requireEntity(user, entityId, roles, c = pool) {
  const e = (await c.query('SELECT * FROM supplier_entities WHERE id=$1', [entityId])).rows[0];
  const role = e ? await entityRole(user, entityId, c) : null;
  if (!e || !role) throw notFound('Supplier');
  if (roles && !roles.includes(role)) throw forbidden('Your role in this supplier does not allow that');
  if (e.status !== 'active') throw conflict('This supplier account is not active');
  return { entity: e, role };
}
export const myEntityIds = async (user, c = pool) => (await c.query("SELECT entity_id FROM supplier_entity_members WHERE user_id=$1 AND status='active'", [user.id])).rows.map((r) => r.entity_id);

/** Can this user see the notice of a published project? Returns the participation row (or null) when yes; throws 404 otherwise. */
export async function noticeAccess(user, p, c = pool) {
  const buyer = await buyerRoles(user, p, c);
  const ents = await myEntityIds(user, c);
  const part = ents.length ? (await c.query('SELECT * FROM proc_participants WHERE project_id=$1 AND entity_id = ANY($2) ORDER BY created_at LIMIT 1', [p.id, ents])).rows[0] ?? null : null;
  if (buyer.length) return { buyer, part, entityIds: ents };
  const visibleStatus = ['published', 'evaluation', 'award', 'awarded', 'closed'].includes(p.status) || (p.status === 'cancelled' && part);
  const live = p.publish_at ? new Date(p.publish_at) <= new Date() : true;
  const ok = visibleStatus && live && (p.publication === 'public' || (p.publication === 'restricted' && (ents.length || part)) || (['restricted', 'invite_only'].includes(p.publication) && part && part.status !== 'declined'));
  if (!ok) throw notFound('Tender');
  return { buyer: [], part, entityIds: ents };
}

/** JSON with sorted keys, so a hash survives a round trip through jsonb (which reorders keys). */
export const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' && !(v instanceof Date) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v ?? null));

// ------------------------------------------------------------------ audit (append-only hash chain)
export async function auditLog(c, projectId, actorId, action, detail = {}) {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`proc_audit:${projectId}`]);
  const prev = (await c.query('SELECT hash FROM proc_audit WHERE project_id=$1 ORDER BY id DESC LIMIT 1', [projectId])).rows[0]?.hash ?? null;
  const at = new Date().toISOString();
  const hash = createHash('sha256').update(canon([prev, projectId, actorId, action, detail, at])).digest('hex');
  await c.query('INSERT INTO proc_audit(project_id, actor_id, action, detail, prev_hash, hash, at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [projectId, actorId, action, detail, prev, hash, at]);
}
/** Recompute the chain; returns the first broken row id or null. */
export async function verifyAudit(projectId, c = pool) {
  let prev = null;
  for (const r of (await c.query('SELECT * FROM proc_audit WHERE project_id=$1 ORDER BY id', [projectId])).rows) {
    const h = createHash('sha256').update(canon([prev, r.project_id, r.actor_id, r.action, r.detail, new Date(r.at).toISOString()])).digest('hex');
    if (r.prev_hash !== prev || r.hash !== h) return r.id;
    prev = r.hash;
  }
  return null;
}

// ------------------------------------------------------------------ sealing
// Threat model (also in docs/tender-zone.md): submitted content is encrypted with AES-256-GCM bound to the submission row id, using the platform
// master key (KMS-wrapped in production). Every read path goes through readEnvelope(), which refuses before the deadline and before the
// recorded opening, and writes an audit row. This keeps the content from API/UI/export/search/log/cache/notification paths and from
// ordinary buyer insiders. It does NOT protect against an operator who holds both the database and the master key: such an operator
// could decrypt offline. That access is outside the application, so it is disclosed here, not hidden behind the UI.
const ctx = (env, id) => `proc_submissions.${env}:${id}`;
export const sealJson = (obj, env, id) => encrypt(JSON.stringify(obj), ctx(env, id));
export const unsealJson = (enc, env, id) => (enc ? JSON.parse(decrypt(enc, ctx(env, id))) : null);
export const contentHash = (parts) => createHash('sha256').update(canon(parts)).digest('hex');

export const opening = async (projectId, envelope, round, c = pool) => (await c.query('SELECT * FROM proc_openings WHERE project_id=$1 AND envelope=$2 AND round=$3', [projectId, envelope, round])).rows[0] ?? null;

/**
 * The only way to decrypt a submission. Enforces: deadline passed (server time), envelope opened per the register (sealed modes), technical
 * sign-off before commercial (dual mode), role (technical evaluators never see prices), and records the read.
 */
export async function assertEnvelopeAccess(user, roles, p, proposal, envelope, c = pool) {
  if (p.closes_at && new Date() < new Date(p.closes_at) && proposal.round === 1) throw forbidden('Proposals stay sealed until the submission deadline');
  if (!can(roles, envelope === 'technical' ? 'read_technical' : 'read_commercial')) throw forbidden('Your role on this tender cannot read that envelope');
  if (p.envelope_mode !== 'open') {
    const need = envelope === 'technical' ? 'technical' : p.envelope_mode === 'sealed_single' ? 'technical' : 'commercial';
    if (!(await opening(p.id, need, proposal.round, c))) throw forbidden(`The ${need} envelope has not been opened yet`);
    if (envelope === 'commercial' && p.envelope_mode === 'sealed_dual' && (proposal.tech_signoff !== 'pass' || !proposal.commercial_unlocked_at)) throw forbidden('The commercial envelope unlocks only after the technical sign-off passes');
  } else if (!(await opening(p.id, 'technical', proposal.round, c))) throw forbidden('Proposals are read after the evaluation has been started');
}

/** The only way to decrypt a submission. Enforces the deadline, the opening register, the sign-off order and the role, and records the read. */
export async function readEnvelope(user, roles, p, sub, envelope, c = pool) {
  const proposal = (await c.query('SELECT * FROM proc_proposals WHERE id=$1', [sub.proposal_id])).rows[0];
  await assertEnvelopeAccess(user, roles, p, proposal, envelope, c);
  await auditLog(c, p.id, user.id, 'envelope_read', { submission_id: sub.id, envelope });
  return unsealJson(envelope === 'technical' ? sub.tech_enc : sub.comm_enc, envelope === 'technical' ? 'tech_enc' : 'comm_enc', sub.id);
}

// ------------------------------------------------------------------ notifications
export const buyerIds = async (p, roles, c = pool) => [...new Set([p.owner_user_id, ...(await c.query('SELECT user_id FROM proc_members WHERE project_id=$1 AND revoked_at IS NULL AND role = ANY($2)', [p.id, roles])).rows.map((r) => r.user_id)])];
export const entityUserIds = async (entityId, c = pool, roles = ['owner', 'bid_manager', 'contributor', 'signatory']) => (await c.query("SELECT user_id FROM supplier_entity_members WHERE entity_id=$1 AND status='active' AND role = ANY($2)", [entityId, roles])).rows.map((r) => r.user_id);

/** Tell people about a tender event. Previews carry the tender reference and a neutral title only: never prices, scores or bidder names. */
export async function tellUsers(c, userIds, p, kind, title, body, key) {
  for (const uid of new Set(userIds)) await notify(c, uid, { kind, title, body, data: { project_id: p.id, ref: p.ref }, dedupe_key: `${kind}:${p.id}:${key ?? ''}:${uid}` });
}

export const issuerOf = async (p, c = pool) => p.organisation_id
  ? (await c.query('SELECT name, true AS org FROM organisations WHERE id=$1', [p.organisation_id])).rows[0]
  : p.venue_id ? (await c.query('SELECT name, false AS org FROM venues WHERE id=$1', [p.venue_id])).rows[0]
  : (await c.query('SELECT display_name AS name, false AS org FROM users WHERE id=$1', [p.owner_user_id])).rows[0];
