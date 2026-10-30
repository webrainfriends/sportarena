// Federation & Governing Body OS (#475): the shared core. A governing body is an organisation plus one `governing_bodies` row; everything else
// (clubs, teams, events, people, rule packs, cases) is referenced, never copied. This module owns the three things every capability needs:
// who may act on a body (live, least-privilege), which governing requirement applied on a date (versioned, inherited down the hierarchy) and the
// append-only decision history.
import { z } from 'zod';
import { pool } from './db.js';
import { orgRole } from './org-access.js';
import { isAdmin } from './helpers.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { guardianLink } from './youth.js';

export const LEVELS = ['international', 'continental', 'national', 'regional', 'state', 'district', 'league'];
export const ROLES = ['registrar', 'licensing', 'sanctioner', 'secretary', 'compliance', 'auditor', 'integrity'];
export const ROLE_LABEL = {
  registrar: 'Registrar (affiliations)', licensing: 'Licensing officer', sanctioner: 'Sanctioning officer', secretary: 'Secretary (policies and calendar)',
  compliance: 'Compliance (evidence and exception reviews)', auditor: 'Auditor (read-only, reports)', integrity: 'Integrity officer (sport integrity and anti-doping administration)',
};
// What each scoped role may do. Owners and admins of the body's organisation may do all of it; nobody here ever reaches a club's finance, coaching or medical data.
const PERMS = { exceptions: ['compliance'], affiliations: ['registrar'], licences: ['licensing'], sanctions: ['sanctioner'], governance: ['secretary'], evidence: ['registrar', 'licensing', 'sanctioner', 'compliance'], integrity: ['integrity'], reports: ['auditor', 'compliance', 'registrar', 'licensing', 'sanctioner', 'secretary'] };
export const UNSCOPED = '00000000-0000-0000-0000-000000000000';

export const BODY_SQL = `SELECT b.*, o.name, o.legal_name, o.registration_no, o.website, o.contact_email, o.contact_phone, o.description, o.status AS org_status
  FROM governing_bodies b JOIN organisations o ON o.id=b.organisation_id`;

export async function bodyById(id, c = pool) {
  const b = (await c.query(`${BODY_SQL} WHERE b.id=$1`, [id])).rows[0];
  if (!b) throw notFound('Governing body');
  return b;
}
/** Lock a body row for the rest of the transaction: numbering, status changes and hierarchy edits on it run one at a time. */
export async function lockBody(c, id) {
  const b = (await c.query('SELECT * FROM governing_bodies WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!b) throw notFound('Governing body');
  return b;
}

/** Ids of `id` and every body above it (recognised parents, nearest first). Cycle-safe. */
export async function lineage(id, c = pool) {
  const r = await c.query(
    `WITH RECURSIVE up(id, depth) AS (SELECT $1::uuid, 0 UNION SELECT l.parent_id, up.depth + 1 FROM governing_body_links l JOIN up ON l.child_id=up.id WHERE l.status='recognised' AND up.depth < 12)
     SELECT id FROM (SELECT id, min(depth) AS depth FROM up GROUP BY id) x ORDER BY depth`, [id]);
  return r.rows.map((x) => x.id);
}
/** Ids of `id` and every recognised body beneath it. */
export async function subtree(id, c = pool) {
  const r = await c.query(
    `WITH RECURSIVE down(id, depth) AS (SELECT $1::uuid, 0 UNION SELECT l.child_id, down.depth + 1 FROM governing_body_links l JOIN down ON l.parent_id=down.id WHERE l.status='recognised' AND down.depth < 12)
     SELECT DISTINCT id FROM down`, [id]);
  return r.rows.map((x) => x.id);
}

/**
 * Who the caller is to a body, read live on every call. `admin` = owner/admin of the body's organisation (or the platform team); `roles` = active scoped
 * roles; `viaAncestor` = a read-only view because they run a body above it. Outsiders get a 404 so a body's staff list is not probed.
 */
export async function authority(user, bodyId, { c = pool, optional = false } = {}) {
  const body = (await c.query(`${BODY_SQL} WHERE b.id=$1`, [bodyId])).rows[0];
  const none = () => { if (optional) return null; throw notFound('Governing body'); };
  if (!body || !user) return none();
  const orgR = await orgRole(user, body.organisation_id, c);
  const admin = isAdmin(user) || ['owner', 'admin'].includes(orgR);
  const roles = (await c.query("SELECT role, sport_id, jurisdiction_ids FROM governing_body_roles WHERE body_id=$1 AND user_id=$2 AND status='active'", [bodyId, user.id])).rows;
  // Delegated roles (#525): an explicit grant on a node above, live, unexpired and reaching this depth. One query; never a per-row check.
  const delegated = (await c.query(
    `WITH RECURSIVE up(id, depth) AS (SELECT $1::uuid, 0 UNION SELECT l.parent_id, up.depth + 1 FROM governing_body_links l JOIN up ON l.child_id=up.id WHERE l.status='recognised' AND up.depth < 12)
     SELECT d.role, d.sport_id, '{}'::uuid[] AS jurisdiction_ids, d.id AS delegation_id FROM fed_delegations d JOIN (SELECT id, min(depth) AS depth FROM up GROUP BY id) u ON u.id=d.body_id
      WHERE d.user_id=$2 AND d.status='active' AND (d.expires_on IS NULL OR d.expires_on >= current_date) AND u.depth <= d.max_depth`, [bodyId, user.id])).rows;
  roles.push(...delegated.map((d) => ({ ...d, delegated: true })));
  if (admin || roles.length) return { body, admin, roles, viaAncestor: false, org_role: orgR, delegated: delegated.length > 0 };
  const above = (await lineage(bodyId, c)).filter((x) => x !== bodyId);
  if (above.length) {
    const hit = await c.query(
      `SELECT 1 FROM governing_bodies b WHERE b.id = ANY($1) AND (
         EXISTS (SELECT 1 FROM organisation_members m WHERE m.organisation_id=b.organisation_id AND m.user_id=$2 AND m.status='active' AND m.role IN ('owner','admin'))
         OR EXISTS (SELECT 1 FROM governing_body_roles r WHERE r.body_id=b.id AND r.user_id=$2 AND r.status='active')) LIMIT 1`, [above, user.id]);
    if (hit.rowCount) return { body, admin: false, roles: [], viaAncestor: true, org_role: null };
  }
  return none();
}
/**
 * Is the caller allowed to do `perm` (affiliations | licences | sanctions | governance | evidence | reports | exceptions) on this body, for this sport?
 * `jurisdictionId` is the record's jurisdiction. A role limited to some jurisdictions only covers records in them; a record with no jurisdiction, and every
 * body-wide action (reports, policies, the whole calendar), fails closed for such a role. Owners/admins and unlimited roles cover everything.
 */
export function can(auth, perm, sportId = null, jurisdictionId = null) {
  if (!auth || auth.viaAncestor) return false;
  if (auth.admin) return true;
  return auth.roles.some((r) => PERMS[perm]?.includes(r.role) && (!r.sport_id || !sportId || r.sport_id === sportId)
    && (!r.jurisdiction_ids?.length || (jurisdictionId && r.jurisdiction_ids.includes(jurisdictionId))));
}
/** Does the caller hold `perm` at all, for some sport or jurisdiction? (Used to show the right tabs; records are still checked one by one with `can`.) */
export const canSome = (auth, perm) => !!auth && !auth.viaAncestor && (auth.admin || auth.roles.some((r) => PERMS[perm]?.includes(r.role)));
/** Which jurisdictions the caller's lists and queues are limited to: null = no limit (owner/admin, a body above, or any unlimited role), otherwise the allowed ids. */
export function jurisdictionScope(auth) {
  if (!auth || auth.viaAncestor || auth.admin || !auth.roles.length || auth.roles.some((r) => !r.jurisdiction_ids?.length)) return null;
  return [...new Set(auth.roles.flatMap((r) => r.jurisdiction_ids))];
}
/** A record's jurisdiction must be one of the body's live ones. */
export async function mustBeJurisdictionOf(c, bodyId, jurisdictionId) {
  if (!jurisdictionId) return null;
  if (!(await c.query('SELECT 1 FROM fed_jurisdictions WHERE id=$1 AND body_id=$2 AND archived_at IS NULL', [jurisdictionId, bodyId])).rowCount) throw badRequest('That jurisdiction does not belong to this body');
  return jurisdictionId;
}
export function need(auth, perm, sportId = null, jurisdictionId = null) {
  if (!can(auth, perm, sportId, jurisdictionId)) throw forbidden(`Your role on ${auth?.body?.name ?? 'this body'} does not allow that`);
}
/** The body must be taking new work. Reading and history stay open. */
export function mustBeActive(body) {
  if (body.status !== 'active' || body.org_status === 'archived') throw conflict(`${body.name} is ${body.status === 'active' ? 'archived' : body.status} and is not taking new applications or decisions`);
}

/** A decision approved over a failed requirement becomes an open compliance exception, due for review in 90 days. Idempotent per record while one is open. */
export async function openException(c, bodyId, type, subjectId, reason, checks, userId) {
  const failed = JSON.parse(typeof checks === 'string' ? checks : JSON.stringify(checks ?? [])).filter((x) => x.required && x.status === 'fail').map((x) => ({ key: x.key, label: x.label, detail: x.detail }));
  const r = await c.query(
    `INSERT INTO fed_exceptions(body_id, subject_type, subject_id, reason, failed, review_due, decided_by) VALUES ($1,$2,$3,$4,$5,current_date + 90,$6)
     ON CONFLICT (subject_type, subject_id) WHERE status IN ('open','extended') DO NOTHING RETURNING id`, [bodyId, type, subjectId, reason, JSON.stringify(failed), userId]);
  if (r.rows[0]) await logFed(c, bodyId, 'exception', r.rows[0].id, 'opened', { to: 'open', actor: userId, reason, detail: { subject_type: type, subject_id: subjectId } });
}

/** The register of exceptions with what each is about (label, status as today, jurisdiction). */
export const EXC_COLS = `e.id, e.body_id, e.subject_type, e.subject_id, e.reason, e.failed, e.status, e.review_due::text AS review_due, (e.status IN ('open','extended') AND e.review_due < current_date) AS overdue,
  e.decided_at, du.display_name AS decided_by_name, e.reviewed_at, e.review_note, e.review_count, e.row_version,
  coalesce(ao.name, lu.display_name || ' · ' || lt.name, ev.name) AS label, coalesce(a.jurisdiction_id, l.jurisdiction_id, s.jurisdiction_id) AS jurisdiction_id,
  coalesce(lt.sport_id, ev.sport_id, ac.sport_id) AS sport_id, bo.name AS body_name`;
export const EXC_FROM = `fed_exceptions e JOIN governing_bodies b ON b.id=e.body_id JOIN organisations bo ON bo.id=b.organisation_id
  LEFT JOIN fed_affiliations a ON e.subject_type='affiliation' AND a.id=e.subject_id LEFT JOIN organisations ao ON ao.id=a.organisation_id LEFT JOIN fed_affiliation_categories ac ON ac.id=a.category_id
  LEFT JOIN fed_licences l ON e.subject_type='licence' AND l.id=e.subject_id LEFT JOIN users lu ON lu.id=l.holder_id LEFT JOIN fed_licence_types lt ON lt.id=l.type_id
  LEFT JOIN fed_sanctions s ON e.subject_type='sanction' AND s.id=e.subject_id LEFT JOIN events ev ON ev.id=s.event_id LEFT JOIN users du ON du.id=e.decided_by`;

/** Append one step to the immutable history. */
export const logFed = (c, bodyId, subjectType, subjectId, action, { from = null, to = null, actor = null, reason = null, detail = {} } = {}) =>
  c.query('INSERT INTO fed_events(body_id, subject_type, subject_id, action, from_status, to_status, actor_id, reason, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [bodyId, subjectType, subjectId, action, from, to, actor, reason, detail]);
export const historyOf = async (type, id, c = pool) => (await c.query(
  `SELECT e.id, e.action, e.from_status, e.to_status, e.reason, e.detail, e.created_at, u.display_name AS actor_name
     FROM fed_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.subject_type=$1 AND e.subject_id=$2 ORDER BY e.created_at, e.id`, [type, id])).rows;

/** Human-readable number, issued inside the caller's transaction on a locked body so two decisions never share one. */
export async function nextNumber(c, bodyId, kind, year) {
  const col = { affiliation: 'affiliation_seq', licence: 'licence_seq', sanction: 'sanction_seq' }[kind];
  const code = { affiliation: 'AFF', licence: 'LIC', sanction: 'SAN' }[kind];
  const r = (await c.query(`UPDATE governing_bodies SET ${col}=${col}+1 WHERE id=$1 RETURNING ${col} AS n, abbreviation`, [bodyId])).rows[0];
  return `${r.abbreviation}-${code}-${year}-${String(r.n).padStart(4, '0')}`;
}

// ------------------------------------------------------------------ status as the world sees it today (lazy, so nothing waits for a sweep)
export const AFF_STATUS = (a = 'a') => `CASE WHEN ${a}.status IN ('approved','suspended') AND ${a}.effective_to < current_date THEN 'expired' ELSE ${a}.status END`;
export const LIC_STATUS = (l = 'l') => `CASE WHEN ${l}.status='suspended' AND ${l}.suspended_until IS NOT NULL AND ${l}.suspended_until < current_date THEN (CASE WHEN ${l}.expires_on < current_date THEN 'expired' ELSE 'active' END)
  WHEN ${l}.status IN ('active','suspended') AND ${l}.expires_on < current_date THEN 'expired' ELSE ${l}.status END`;
const pad2 = (n) => String(n).padStart(2, '0');
/** pg hands DATE columns back as local-midnight Dates; the module works in plain 'YYYY-MM-DD' strings so no time zone can move a day. */
export const dateStr = (d) => (d instanceof Date ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` : d ?? null);
const DATE_KEYS = ['effective_from', 'effective_to', 'issued_on', 'expires_on', 'suspended_until', 'requested_starts_on', 'requested_ends_on', 'approved_starts_on', 'approved_ends_on', 'fee_paid_on', 'starts_on', 'ends_on', 'started_on', 'ended_on'];
export const plain = (row) => { if (!row) return row; const o = { ...row }; for (const k of DATE_KEYS) if (o[k] instanceof Date) o[k] = dateStr(o[k]); return o; };
export const today = () => new Date().toISOString().slice(0, 10);
export const addMonths = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); const day = d.getUTCDate(); d.setUTCMonth(d.getUTCMonth() + n); if (d.getUTCDate() !== day) d.setUTCDate(0); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };

// ------------------------------------------------------------------ governed requirements
const labels = z.array(z.string().trim().min(1).max(80)).max(20).default([]);
const rank = z.number().int().min(0).max(20);
export const POLICY_KINDS = {
  affiliation: { label: 'Club affiliation requirements', enforced: true, params: z.object({ required_documents: labels, min_teams: z.number().int().min(0).max(500).default(0), renewal_notice_days: z.number().int().min(0).max(365).default(30) }).strict() },
  licence: { label: 'Licence requirements', enforced: true, params: z.object({ required_documents: labels, renewal_notice_days: z.number().int().min(0).max(365).default(30) }).strict() },
  sanction: { label: 'Competition sanctioning conditions', enforced: true, params: z.object({
    lead_time_days: z.number().int().min(0).max(730).default(0), require_venue: z.boolean().default(false), require_ruleset: z.boolean().default(false), min_ruleset_version: z.number().int().min(1).max(999).optional(),
    min_officials: z.number().int().min(0).max(200).default(0), min_official_grade_rank: rank.default(0), require_licensed_officials: z.boolean().default(false), require_insurance: z.boolean().default(false), require_affiliated_entrants: z.boolean().default(false),
    required_documents: labels }).strict() },
  eligibility: { label: 'Participant eligibility', enforced: false, params: z.object({ min_age: z.number().int().min(3).max(99).optional(), max_age: z.number().int().min(3).max(99).optional(), categories: labels, note: z.string().trim().max(500).optional() }).strict() },
  roster: { label: 'Roster limits', enforced: false, params: z.object({ min_players: z.number().int().min(0).max(500).optional(), max_players: z.number().int().min(1).max(500).optional(), max_foreign: z.number().int().min(0).max(500).optional(), note: z.string().trim().max(500).optional() }).strict() },
  competition_entry: { label: 'Competition entry conditions', enforced: false, params: z.object({ requires_affiliation: z.boolean().default(true), requires_licensed_players: z.boolean().default(true), max_entries_per_club: z.number().int().min(1).max(100).optional(), note: z.string().trim().max(500).optional() }).strict() },
  official_grade: { label: 'Official grade requirements', enforced: false, params: z.object({ grades: z.array(z.object({ level: z.string().trim().min(1).max(60), min_grade_rank: rank })).max(20).default([]), note: z.string().trim().max(500).optional() }).strict() },
  registration: { label: 'Player registration rules', enforced: false, params: z.object({ max_active_clubs: z.number().int().min(1).max(10).default(1), requires_guardian_consent_under_18: z.boolean().default(true), note: z.string().trim().max(500).optional() }).strict() },
  transfer: { label: 'Transfer-window rules', enforced: false, params: z.object({ max_transfers_per_window: z.number().int().min(0).max(20).optional(), fee_cap_minor: z.number().int().min(0).optional(), note: z.string().trim().max(500).optional() }).strict() },
  discipline: { label: 'Disciplinary accumulation rules', enforced: false, params: z.object({ points_threshold: z.number().int().min(1).max(1000).optional(), suspension_matches: z.number().int().min(1).max(100).optional(), reset_after_days: z.number().int().min(1).max(3650).optional(), note: z.string().trim().max(500).optional() }).strict() },
  para_classification: { label: 'Para-classification requirements', enforced: false, params: z.object({ classification_required: z.boolean().default(true), classes: labels, valid_for_months: z.number().int().min(1).max(120).optional(), note: z.string().trim().max(500).optional() }).strict() },
};

/**
 * The governing requirement in force on `date`: the most specific policy (sport, category, season) of the nearest body up the hierarchy that has one,
 * and within it the latest version whose effective date has arrived. The caller stores the returned version id with its decision.
 */
export async function policyAt(bodyId, kind, { sportId = null, category = '', seasonYear = null, date = today() } = {}, c = pool) {
  const chain = await lineage(bodyId, c);
  // A locked requirement (#525) binds everything below it: the highest locked one applies even where a nearer body published its own.
  const anyLocked = (await c.query("SELECT 1 FROM fed_policies WHERE body_id = ANY($1) AND local_override='locked' AND kind=$2 AND status='active' LIMIT 1", [chain, kind])).rowCount > 0;
  for (const locked of anyLocked ? [true, false] : [false]) for (const bid of locked ? [...chain].reverse() : chain) {
    const r = await c.query(
      `SELECT p.id AS policy_id, p.title, p.body_id, p.sport_id, p.category, p.season_year, p.local_override, v.id AS version_id, v.version, v.effective_from::text AS effective_from, v.summary, v.params
         FROM fed_policies p JOIN LATERAL (SELECT * FROM fed_policy_versions x WHERE x.policy_id=p.id AND x.effective_from <= $6::date ORDER BY x.effective_from DESC LIMIT 1) v ON true
        WHERE p.body_id=$1 AND p.kind=$2 AND p.status='active' AND ($7::boolean = false OR p.local_override='locked')
          AND (p.sport_id IS NULL OR p.sport_id=$3) AND (p.category='' OR p.category=$4) AND (p.season_year IS NULL OR p.season_year=$5)
        ORDER BY (p.sport_id IS NOT NULL) DESC, (p.category <> '') DESC, (p.season_year IS NOT NULL) DESC, p.created_at, p.id LIMIT 1`,
      [bid, kind, sportId, category, seasonYear, date, locked]);
    if (r.rows[0]) return { ...r.rows[0], inherited: bid !== bodyId };
  }
  return null;
}
/** The parsed, defaulted params of a resolved policy ({} when no policy applies). */
export const paramsOf = (kind, p) => (p ? POLICY_KINDS[kind].params.parse(p.params) : POLICY_KINDS[kind].params.parse({}));

// ------------------------------------------------------------------ checks
/** A requirement check. `required` ones block approval unless the decider records an override reason. */
export const check = (key, label, ok, detail, { required = true } = {}) => ({ key, label, status: ok ? 'pass' : 'fail', required, detail: detail ?? null });
export const blocking = (checks) => checks.filter((x) => x.required && x.status === 'fail');

// ------------------------------------------------------------------ who is the other party
export const isGuardianOf = async (userId, holderId, c = pool) => !!(await guardianLink(userId, holderId, c));

/** Org staff who can apply for / manage the organisation's affiliation: owner or admin, live. */
export async function mustRunOrg(user, orgId, c = pool) {
  const org = (await c.query('SELECT * FROM organisations WHERE id=$1', [orgId])).rows[0];
  const role = org ? await orgRole(user, orgId, c) : null;
  if (!org || !['owner', 'admin'].includes(role)) throw notFound('Organisation');
  if (org.status !== 'active') throw conflict('This organisation is archived and read-only');
  return org;
}
