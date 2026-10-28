// Sport Integrity & Anti-Doping Administration (#489): who may see and act on an integrity matter, the append-only history, and the one place the
// rest of the platform reads an active sporting sanction from (competition eligibility, #477). Strictly need-to-know: a body's integrity officers
// (and its owners/admins), panel members given access to ONE case, and the subject (or their verified guardian). Platform admins, sponsors, media,
// coaches, clubs and ancestors of the body have no standing here and get a 404, so existence is never leaked.
import { pool } from './db.js';
import { isGuardianOf } from './federation.js';
import { forbidden, notFound } from './errors.js';
import { notify } from './notify.js';
import { guardiansOf } from './youth.js';

export const KINDS = ['anti_doping', 'match_integrity', 'betting_conflict', 'accreditation_fraud', 'other'];
export const KIND_LABEL = { anti_doping: 'Anti-doping administration', match_integrity: 'Match integrity referral', betting_conflict: 'Betting / conflict disclosure', accreditation_fraud: 'Accreditation or identity referral', other: 'Other authorised integrity matter' };
export const STATES = ['received', 'under_review', 'response_due', 'decision_pending', 'decided', 'closed', 'suspended', 'deferred', 'withdrawn'];
export const STATE_LABEL = { received: 'Referral received', under_review: 'Under review', response_due: 'Response due', decision_pending: 'Decision pending', decided: 'Decided', closed: 'Closed', suspended: 'Suspended', deferred: 'Deferred', withdrawn: 'Withdrawn' };
export const NOT_A_FINDING = 'A referral, an allegation or a pending test is not a finding. Nothing here is a decision until an authorised body records one.';
export const REFERENCE_ONLY = 'Administrative reference to what the authoritative source supplied, exactly as supplied. SportArena does not interpret results.';

/** What each action does from each state. The engine is fixed; the labels and deadlines are the body's. */
export const FLOW = {
  start_review: { from: ['received', 'response_due', 'decision_pending'], to: 'under_review' },
  request_response: { from: ['received', 'under_review'], to: 'response_due' },
  move_to_decision: { from: ['under_review', 'response_due'], to: 'decision_pending' },
  suspend: { from: ['under_review', 'response_due', 'decision_pending'], to: 'suspended' },
  defer: { from: ['received', 'under_review', 'response_due', 'decision_pending'], to: 'deferred' },
  withdraw: { from: ['received', 'under_review', 'response_due', 'decision_pending', 'suspended', 'deferred'], to: 'withdrawn' },
  close: { from: ['decided'], to: 'closed' },
};

export const today = () => new Date().toISOString().slice(0, 10);
export const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

/** Is the caller an integrity officer of this body (integrity role, or owner/admin of the body's organisation)? Platform admins and ancestors are not. */
export async function officerOf(user, bodyId, { c = pool } = {}) {
  if (!user) return null;
  const body = (await c.query('SELECT organisation_id FROM governing_bodies WHERE id=$1', [bodyId])).rows[0];
  if (!body) return null;
  // direct membership checks: orgRole() would make a platform admin an owner of every organisation, which integrity must never do
  const ok = (await c.query(
    `SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active' AND role IN ('owner','admin')
     UNION ALL SELECT 1 FROM governing_body_roles WHERE body_id=$3 AND user_id=$2 AND role='integrity' AND status='active' LIMIT 1`, [body.organisation_id, user.id, bodyId])).rowCount > 0;
  return ok ? { body: bodyId } : null;
}
export async function needOfficer(user, bodyId, opts) {
  const auth = await officerOf(user, bodyId, opts);
  if (!auth) throw notFound('Governing body');
  return auth;
}

export const log = (c, bodyId, caseId, type, subjectId, action, { from = null, to = null, actor = null, reason = null, detail = {} } = {}) =>
  c.query('INSERT INTO int_events(body_id, case_id, subject_type, subject_id, action, from_status, to_status, actor_id, reason, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [bodyId, caseId, type, subjectId, action, from, to, actor, reason, detail]);

export const historyOf = async (caseId, c = pool) => (await c.query(
  `SELECT e.id, e.subject_type, e.action, e.from_status, e.to_status, e.reason, e.detail, e.created_at, u.display_name AS actor_name
     FROM int_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.case_id=$1 ORDER BY e.created_at, e.id`, [caseId])).rows;

/** The case, and how the caller stands to it: officer | panel | reviewer | subject (own case or a youth's guardian). 404 for anyone else. */
export async function caseFor(user, caseId, { c = pool, lock = false } = {}) {
  const row = (await c.query(`SELECT * FROM int_cases WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [caseId])).rows[0];
  if (!row) throw notFound('Case');
  if (await officerOf(user, row.body_id, { c })) return { row, as: 'officer' };
  const grant = (await c.query('SELECT role FROM int_case_access WHERE case_id=$1 AND user_id=$2 AND revoked_at IS NULL', [caseId, user.id])).rows[0];
  if (grant) return { row, as: grant.role };
  if (row.subject_id === user.id) return { row, as: 'subject' };
  if (await isGuardianOf(user.id, row.subject_id, c)) return { row, as: 'subject', guardian: true };
  throw notFound('Case');
}
export function mayDecide(s) { return s.as === 'officer' || s.as === 'panel'; }
export function needDecide(s) { if (!mayDecide(s)) throw forbidden('Only an integrity officer or a panel member can do that'); }

/** A generic notice: it says only that there is something to open. Never the category, the person or the substance. */
export async function tell(c, userId, caseRow, { guardians = true } = {}) {
  const msg = { kind: 'integrity_update', title: 'Update on a governance matter', body: 'Open SportArena to view it.', data: { governance_notice: true } };
  await notify(c, userId, { ...msg, dedupe_key: `int:${caseRow.id}:${caseRow.row_version}:${userId}` });
  if (guardians && userId === caseRow.subject_id) for (const g of await guardiansOf(userId, c)) await notify(c, g, { ...msg, dedupe_key: `int:${caseRow.id}:${caseRow.row_version}:${g}` });
}

export async function nextCaseNo(c, bodyId) {
  const r = (await c.query('UPDATE governing_bodies SET integrity_seq=integrity_seq+1 WHERE id=$1 RETURNING integrity_seq AS n, abbreviation', [bodyId])).rows[0];
  return `${r.abbreviation}-INT-${new Date().getUTCFullYear()}-${String(r.n).padStart(4, '0')}`;
}

/**
 * The one read of an active sporting sanction that competition eligibility (#477) makes: a recorded, current decision with `sporting_sanction`, in force
 * today, from a body that governs the sport. It exposes only that a sanction exists and until when: never the case, the category or the source.
 * When the disciplinary domain (#479) lands, this is the single function to point at its sanction table.
 */
export async function activeSportingSanction(c, userId, sportId, onDay = today()) {
  const r = await c.query(
    `SELECT d.id, d.effective_to::text AS valid_until FROM int_decisions d JOIN int_cases k ON k.id=d.case_id
      WHERE k.subject_id=$1 AND d.superseded_at IS NULL AND d.sporting_sanction AND d.outcome='finding_recorded'
        AND (d.effective_from IS NULL OR d.effective_from <= $3::date) AND (d.effective_to IS NULL OR d.effective_to >= $3::date)
        AND EXISTS (SELECT 1 FROM governing_body_sports s WHERE s.body_id=d.body_id AND s.sport_id=$2 AND s.ended_on IS NULL)
      ORDER BY d.effective_to DESC NULLS FIRST LIMIT 1`, [userId, sportId, onDay]);
  return r.rows[0] ?? null;
}
