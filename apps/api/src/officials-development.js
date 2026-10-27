// Officials Development & Assessment (#486): the shared core. Assignments stay in #88 (`fixture_officials`) and grades/licences stay in the federation
// OS (`fed_licences`): this module only reads them. It owns who may act (assessor, development staff, the official, mentor), the immutable history,
// private narrative sealing, and the progression checks the existing licence approval consumes.
import { z } from 'zod';
import { pool } from './db.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { encrypt, decrypt } from './crypto.js';
import { audit } from './helpers.js';
import { authority, can, subtree, lineage, check, LIC_STATUS, addMonths, plain } from './federation.js';
import { hasOrgGrant } from './org-access.js';

export const OFFICIAL_ROLES = ['referee', 'umpire', 'linesman', 'scorer'];
export const PURPOSES = ['routine', 'promotion', 'mentoring', 'probation', 'return', 'other'];
export const RECOMMENDATIONS = ['maintain_grade', 'ready_for_review', 'further_observation'];
export const FAVOURABLE = ['maintain_grade', 'ready_for_review'];
const ZERO = '00000000-0000-0000-0000-000000000000';
export { ZERO };

/** Append one step to the immutable history. */
export const logOff = (c, bodyId, subjectType, subjectId, action, { from = null, to = null, actor = null, reason = null, detail = {} } = {}) =>
  c.query('INSERT INTO off_events(body_id, subject_type, subject_id, action, from_status, to_status, actor_id, reason, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [bodyId, subjectType, subjectId, action, from, to, actor, reason ? String(reason).slice(0, 500) : null, detail]);
export const historyOf = async (type, id, c = pool) => (await c.query(
  `SELECT e.id, e.action, e.from_status, e.to_status, e.reason, e.created_at, u.display_name AS actor_name
     FROM off_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.subject_type=$1 AND e.subject_id=$2 ORDER BY e.created_at, e.id`, [type, id])).rows;

// ------------------------------------------------------------------ private text
export const seal = (obj, ctx) => encrypt(JSON.stringify(obj), ctx);
export const unseal = (enc, ctx) => (enc ? JSON.parse(decrypt(enc, ctx)) : null);
export const sealText = (t, ctx) => (t ? encrypt(t, ctx) : null);
export const unsealText = (enc, ctx) => (enc ? decrypt(enc, ctx) : null);
export const CTX = { narrative: 'off_assessment_versions.narrative', response: 'off_assessment_responses.body', appeal: 'off_appeals.grounds', decision: 'off_appeals.decision', coi: 'off_observations.coi_note',
  item: 'off_dev_items.title', detail: 'off_dev_items.detail', scope: 'off_mentorships.scope', cpd: 'off_cpd_records.evidence', fitness: 'off_fitness_results.reference' };

/** A private read is always audit-logged. */
export const auditRead = (c, user, entity, id) => audit(c, user.id, `read_${entity}`, entity, id);

// ------------------------------------------------------------------ narrative shape
const line = z.string().trim().min(1).max(600);
export const narrativeSchema = z.object({
  strengths: z.array(line).max(10).default([]),
  development_areas: z.array(line).max(10).default([]),
  required_actions: z.array(line).max(10).default([]),
  recommended_support: z.array(line).max(10).default([]),
  observations: z.array(z.object({ note: line, minute: z.number().int().min(0).max(300).optional(), evidence: z.string().trim().max(300).optional().describe('where the evidence is: a clip, incident, report or timestamp reference') })).max(30).default([]),
}).strict();

// ------------------------------------------------------------------ standing (read live from the sources)
/** Effective state of an assessor appointment: it lapses with its dates and with the licence it rests on. */
export const ASSESSOR_STATUS = (a = 'a') => `CASE WHEN ${a}.status <> 'active' THEN ${a}.status
  WHEN current_date < ${a}.valid_from THEN 'pending' WHEN current_date > ${a}.valid_until THEN 'expired'
  WHEN NOT EXISTS (SELECT 1 FROM fed_licences cl WHERE cl.id=${a}.credential_licence_id AND cl.holder_id=${a}.user_id AND (${LIC_STATUS('cl')})='active') THEN 'lapsed' ELSE 'active' END`;

/** The official's current grade for a sport, read from the licence in force (highest rank). Never stored on the assessment as a rule input. */
export async function currentGrade(userId, sportId, c = pool) {
  const r = (await c.query(
    `SELECT l.id AS licence_id, l.body_id, l.licence_no, t.id AS type_id, t.name AS type_name, t.grade, t.grade_rank, t.sport_id, l.issued_on::text AS issued_on, l.expires_on::text AS expires_on, bo.name AS body_name, b.abbreviation AS body_abbreviation
       FROM fed_licences l JOIN fed_licence_types t ON t.id=l.type_id JOIN governing_bodies b ON b.id=l.body_id JOIN organisations bo ON bo.id=b.organisation_id
      WHERE l.holder_id=$1 AND t.holder_role='official' AND ($2::uuid IS NULL OR t.sport_id=$2) AND (${LIC_STATUS('l')})='active'
      ORDER BY t.grade_rank DESC, l.expires_on DESC LIMIT 1`, [userId, sportId ?? null])).rows[0];
  return r ?? null;
}

// ------------------------------------------------------------------ authority
/**
 * Development staff of a body: owner/admin or a licensing officer (optionally for one sport), read live. Outsiders get 404 so a body's staff is not probed.
 * Returns the federation authority; `staff` is true when the caller may decide.
 */
export async function devStaff(user, bodyId, { c = pool, sportId = null, optional = false } = {}) {
  const auth = await authority(user, bodyId, { c, optional: true });
  if (!auth) { if (optional) return null; throw notFound('Governing body'); }
  const staff = can(auth, 'licences', sportId);
  if (!staff && !optional) throw forbidden(`Your role on ${auth.body.name} does not allow that`);
  return { ...auth, staff };
}
export const needDevStaff = (user, bodyId, opts) => devStaff(user, bodyId, opts);

/** May the caller read this body's aggregate development figures? Staff of the body or of a body above it. */
export async function reportAuthority(user, bodyId, { c = pool } = {}) {
  const auth = await authority(user, bodyId, { c });
  const full = can(auth, 'reports') || can(auth, 'licences');
  return { auth, full, aggregateOnly: !full };
}

/** Is `fixture`'s event inside the body's jurisdiction: sanctioned by the body (or one beneath it) or officiated by someone it licenses? */
export async function inJurisdiction(c, bodyId, { eventId, officialId }) {
  const ids = await subtree(bodyId, c);
  if ((await c.query("SELECT 1 FROM fed_sanctions WHERE event_id=$1 AND body_id = ANY($2) AND status IN ('approved','suspended') LIMIT 1", [eventId, ids])).rowCount) return 'sanctioned';
  if ((await c.query(`SELECT 1 FROM fed_licences l JOIN fed_licence_types t ON t.id=l.type_id WHERE l.holder_id=$1 AND l.body_id = ANY($2) AND t.holder_role='official' AND (${LIC_STATUS('l')})='active' LIMIT 1`, [officialId, ids])).rowCount) return 'licensed';
  return null;
}
/** Does the caller organise this event? (organiser, or an owner/admin of the organisation running it). */
export async function runsEvent(user, ev, c = pool) {
  return ev.organizer_id === user.id || (!!ev.organisation_id && await hasOrgGrant(user, ev.organisation_id, ['owner', 'admin'], c));
}

/** The caller's live appointment as assessor for a body (any sport) or a specific one. */
export async function liveAppointments(c, userId, bodyIds = null) {
  return (await c.query(
    `SELECT a.*, ${ASSESSOR_STATUS('a')} AS effective_status FROM off_assessors a WHERE a.user_id=$1 AND ($2::uuid[] IS NULL OR a.body_id = ANY($2)) AND (${ASSESSOR_STATUS('a')})='active'`, [userId, bodyIds])).rows.map(plain);
}

/** Does this person hold (or have held) a licence from the body, one above it or one beneath it? Used to bound CPD, mentoring and fitness records to a real relationship. */
export async function holdsLicenceUnder(c, userId, bodyId, { currentOnly = false } = {}) {
  const ids = [...new Set([...(await lineage(bodyId, c)), ...(await subtree(bodyId, c))])];
  return (await c.query(
    `SELECT 1 FROM fed_licences l WHERE l.holder_id=$1 AND l.body_id = ANY($2) AND ${currentOnly ? `(${LIC_STATUS('l')})='active'` : "l.status IN ('active','suspended','expired','revoked')"} LIMIT 1`, [userId, ids])).rowCount > 0;
}

// ------------------------------------------------------------------ rubric helpers
export const scaleSchema = z.object({
  min: z.number().int().min(0).max(1), max: z.number().int().min(2).max(10),
  labels: z.record(z.string().regex(/^\d+$/), z.string().trim().min(1).max(160)),
}).strict().superRefine((s, ctx) => {
  for (let n = s.min; n <= s.max; n++) if (!s.labels[String(n)]) ctx.addIssue({ code: 'custom', message: `Describe what a ${n} means` });
  for (const k of Object.keys(s.labels)) if (Number(k) < s.min || Number(k) > s.max) ctx.addIssue({ code: 'custom', message: `${k} is outside the scale` });
});
export const dimensionSchema = z.object({
  key: z.string().trim().regex(/^[a-z][a-z0-9_]{1,39}$/, 'a short lower-case key'), label: z.string().trim().min(2).max(80),
  description: z.string().trim().max(400).default(''), evidence_expectation: z.string().trim().max(300).default(''),
  evidence_required: z.boolean().default(false), allow_na: z.boolean().default(true),
}).strict();
export const scoreSchema = z.object({ key: z.string().max(40), score: z.number().int().min(0).max(10).nullable().default(null), na: z.boolean().default(false), evidence: z.string().trim().max(500).default('') }).strict();

/** Check scores against the rubric version the assessment is bound to. `final` also demands a complete report. */
export function validateScores(version, scores, { final = false } = {}) {
  const dims = new Map(version.dimensions.map((d) => [d.key, d]));
  const seen = new Set();
  for (const s of scores) {
    const d = dims.get(s.key);
    if (!d) throw badRequest(`"${s.key}" is not a dimension of this rubric`);
    if (seen.has(s.key)) throw badRequest(`"${s.key}" is scored twice`);
    seen.add(s.key);
    if (s.na && s.score != null) throw badRequest(`${d.label}: choose a score or N/A, not both`);
    if (s.na && !d.allow_na) throw badRequest(`${d.label} cannot be marked N/A`);
    if (s.score != null && (s.score < version.scale.min || s.score > version.scale.max)) throw badRequest(`${d.label}: a score from ${version.scale.min} to ${version.scale.max}`);
    if (final && s.score != null && d.evidence_required && !s.evidence) throw badRequest(`${d.label}: add the evidence for this rating`);
  }
  if (final) {
    const missing = version.dimensions.filter((d) => !seen.has(d.key) || (scores.find((s) => s.key === d.key).score == null && !scores.find((s) => s.key === d.key).na));
    if (missing.length) throw badRequest(`Score or mark N/A: ${missing.map((d) => d.label).join(', ')}`);
  }
}

// ------------------------------------------------------------------ progression checks consumed by the licence approval
export const liveRequirement = async (c, typeId) => (await c.query(
  `SELECT r.*, pt.name AS prerequisite_name, ft.name AS fitness_name, ft.validity_months AS fitness_validity_months FROM off_grade_requirements r
     LEFT JOIN fed_licence_types pt ON pt.id=r.prerequisite_type_id LEFT JOIN off_fitness_test_types ft ON ft.id=r.fitness_test_type_id WHERE r.licence_type_id=$1 AND r.superseded_at IS NULL`, [typeId])).rows[0] ?? null;

export const cpdHours = async (c, userId, bodyId, { since, until }) => Number((await c.query(
  `SELECT coalesce(sum(hours),0) AS h FROM off_cpd_records WHERE user_id=$1 AND body_id=$2 AND status='verified' AND completed_on >= $3::date AND completed_on <= $4::date AND (expires_on IS NULL OR expires_on >= $4::date)`, [userId, bodyId, since, until])).rows[0].h);

/** The standing of a fitness test for a person: the latest valid result that counts. */
export const fitnessStanding = async (c, userId, testTypeId, onDate) => {
  const r = (await c.query(
    `SELECT id, outcome, taken_on::text AS taken_on, valid_until::text AS valid_until FROM off_fitness_results WHERE official_id=$1 AND test_type_id=$2 AND voided_at IS NULL ORDER BY taken_on DESC, created_at DESC LIMIT 1`, [userId, testTypeId])).rows[0];
  if (!r) return { status: 'missing' };
  if (r.outcome === 'fail') return { status: 'failed', ...r };
  if (r.valid_until < onDate) return { status: 'expired', ...r };
  return { status: 'valid', ...r };
};

/** Assessor recommendations on file for the official in the window: counts only, never scores. */
export const assessmentRecord = async (c, userId, sportId, { since }) => (await c.query(
  `SELECT count(*)::int AS total, count(*) FILTER (WHERE v.recommendation = ANY($4))::int AS favourable,
          count(*) FILTER (WHERE o.purpose='promotion' AND v.recommendation='ready_for_review')::int AS promotion_ready
     FROM off_assessments a JOIN off_observations o ON o.id=a.observation_id
     JOIN off_assessment_versions v ON v.assessment_id=a.id AND v.version=a.current_version
    WHERE a.official_id=$1 AND a.sport_id=$2 AND a.status='published' AND a.published_at >= $3::date`, [userId, sportId, since, FAVOURABLE])).rows[0];

const monthsBefore = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 10); };

/**
 * The development requirements for a licence, as checks. Used by the existing licence approval (and its preview): promotion, renewal and first issue all
 * go through that one decision, so nothing here approves anything and a score alone can never promote.
 */
export async function developmentChecks(c, l, type, { issuedOn }) {
  const req = await liveRequirement(c, type.id);
  if (!req) return [];
  const out = [];
  if (req.prerequisite_type_id && !l.previous_id) {
    const p = (await c.query(
      `SELECT min(issued_on)::text AS first_issued, bool_or((${LIC_STATUS('x')})='active') AS current FROM fed_licences x WHERE x.holder_id=$1 AND x.type_id=$2 AND x.status IN ('active','suspended','expired')`, [l.holder_id, req.prerequisite_type_id])).rows[0];
    const held = !!p?.current && (!req.min_months_at_prerequisite || p.first_issued <= monthsBefore(issuedOn, req.min_months_at_prerequisite));
    out.push(check('prerequisite_grade', `Holds ${req.prerequisite_name}${req.min_months_at_prerequisite ? ` for ${req.min_months_at_prerequisite}+ months` : ''}`, held, held ? null : (p?.current ? `Held since ${p.first_issued}` : `Needs a current ${req.prerequisite_name} licence`)));
  }
  if (req.min_assessments > 0 || req.require_promotion_assessment) {
    const rec = await assessmentRecord(c, l.holder_id, type.sport_id, { since: monthsBefore(issuedOn, req.assessment_window_months) });
    const ok = rec.total >= req.min_assessments && rec.favourable >= req.min_favourable && (!req.require_promotion_assessment || rec.promotion_ready > 0);
    out.push(check('assessments', `${req.min_assessments} formal assessment${req.min_assessments === 1 ? '' : 's'} in ${req.assessment_window_months} months${req.min_favourable ? `, ${req.min_favourable} supportive` : ''}${req.require_promotion_assessment ? ', one for promotion' : ''}`, ok,
      `${rec.total} on file, ${rec.favourable} supportive${req.require_promotion_assessment ? `, ${rec.promotion_ready} promotion-ready` : ''}`));
  }
  if (Number(req.cpd_hours) > 0) {
    const h = await cpdHours(c, l.holder_id, l.body_id, { since: monthsBefore(issuedOn, req.cpd_window_months), until: issuedOn });
    out.push(check('cpd', `${Number(req.cpd_hours)} verified CPD hours in ${req.cpd_window_months} months`, h >= Number(req.cpd_hours), `${h} verified hours`));
  }
  if (req.fitness_test_type_id) {
    const f = await fitnessStanding(c, l.holder_id, req.fitness_test_type_id, issuedOn);
    out.push(check('fitness', `${req.fitness_name} current`, f.status === 'valid', f.status === 'valid' ? `Valid until ${f.valid_until}` : { missing: 'No result on file', failed: 'The latest result was not a pass', expired: `Expired ${f.valid_until}` }[f.status]));
  }
  return out;
}

export { addMonths, plain };
