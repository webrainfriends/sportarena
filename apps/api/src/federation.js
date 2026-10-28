// Federation & Governing Body OS (#475): the shared core. A governing body is an organisation plus one `governing_bodies` row; everything else
// (clubs, teams, events, people, rule packs, cases) is referenced, never copied. This module owns the three things every capability needs:
// who may act on a body (live, least-privilege), which governing requirement applied on a date (versioned, inherited down the hierarchy) and the
// append-only decision history.
import { z } from 'zod';
import { pool } from './db.js';
import { orgRole } from './org-access.js';
import { isAdmin } from './helpers.js';
import { conflict, forbidden, notFound } from './errors.js';
import { guardianLink } from './youth.js';

export const LEVELS = ['international', 'continental', 'national', 'regional', 'state', 'district', 'league'];
export const ROLES = ['registrar', 'licensing', 'sanctioner', 'secretary', 'compliance', 'auditor', 'integrity'];
export const ROLE_LABEL = {
  registrar: 'Registrar (affiliations)', licensing: 'Licensing officer', sanctioner: 'Sanctioning officer', secretary: 'Secretary (policies and calendar)',
  compliance: 'Compliance (read-only, incl. evidence)', auditor: 'Auditor (read-only, reports)', integrity: 'Integrity officer (sport integrity and anti-doping administration)',
};
// What each scoped role may do. Owners and admins of the body's organisation may do all of it; nobody here ever reaches a club's finance, coaching or medical data.
const PERMS = { affiliations: ['registrar'], licences: ['licensing'], sanctions: ['sanctioner'], governance: ['secretary'], evidence: ['registrar', 'licensing', 'sanctioner', 'compliance'], integrity: ['integrity'], reports: ['auditor', 'compliance', 'registrar', 'licensing', 'sanctioner', 'secretary'] };
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
  const roles = (await c.query("SELECT role, sport_id FROM governing_body_roles WHERE body_id=$1 AND user_id=$2 AND status='active'", [bodyId, user.id])).rows;
  if (admin || roles.length) return { body, admin, roles, viaAncestor: false, org_role: orgR };
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
/** Is the caller allowed to do `perm` (affiliations | licences | sanctions | governance | evidence | reports) on this body, for this sport? */
export function can(auth, perm, sportId = null) {
  if (!auth || auth.viaAncestor) return false;
  if (auth.admin) return true;
  return auth.roles.some((r) => PERMS[perm]?.includes(r.role) && (!r.sport_id || !sportId || r.sport_id === sportId));
}
export function need(auth, perm, sportId = null) {
  if (!can(auth, perm, sportId)) throw forbidden(`Your role on ${auth?.body?.name ?? 'this body'} does not allow that`);
}
/** The body must be taking new work. Reading and history stay open. */
export function mustBeActive(body) {
  if (body.status !== 'active' || body.org_status === 'archived') throw conflict(`${body.name} is ${body.status === 'active' ? 'archived' : body.status} and is not taking new applications or decisions`);
}

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
  for (const bid of await lineage(bodyId, c)) {
    const r = await c.query(
      `SELECT p.id AS policy_id, p.title, p.body_id, p.sport_id, p.category, p.season_year, v.id AS version_id, v.version, v.effective_from::text AS effective_from, v.summary, v.params
         FROM fed_policies p JOIN LATERAL (SELECT * FROM fed_policy_versions x WHERE x.policy_id=p.id AND x.effective_from <= $6::date ORDER BY x.effective_from DESC LIMIT 1) v ON true
        WHERE p.body_id=$1 AND p.kind=$2 AND p.status='active'
          AND (p.sport_id IS NULL OR p.sport_id=$3) AND (p.category='' OR p.category=$4) AND (p.season_year IS NULL OR p.season_year=$5)
        ORDER BY (p.sport_id IS NOT NULL) DESC, (p.category <> '') DESC, (p.season_year IS NOT NULL) DESC, p.created_at, p.id LIMIT 1`,
      [bid, kind, sportId, category, seasonYear, date]);
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
