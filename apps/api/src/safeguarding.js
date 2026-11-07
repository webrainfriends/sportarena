// Academy safeguarding & welfare case orchestration (#784): the rules. It EXTENDS academy_safety_events (#788) and the compliance module (#595):
// a case is opened from a safety event, staff suitability is read from verified compliance records only (never copied), and the platform never
// decides or sends a mandatory report: it surfaces the configured rule and records the human's decision.
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { decrypt, encrypt } from './crypto.js';
import { notify } from './notify.js';
import { evaluateSubject, gate, hasObligations } from './compliance.js';
import { openSafetyEvent, policyFor, safeguardingOfficers } from './pickup.js';

export const CATEGORIES = ['welfare', 'conduct', 'online', 'injury_neglect', 'pickup', 'other'];
export const RISKS = ['low', 'medium', 'high', 'critical'];
export const STATUSES = ['received', 'assessment', 'action', 'review', 'closed'];
export const ACTION_KINDS = ['risk_review', 'guardian_contact', 'referral', 'training_or_checks', 'monitoring', 'report_review', 'other'];
export const TIERS = { 1: 'campus_officer', 2: 'lead_officer', 3: 'leadership_liaison' };
export const DEFAULT_SG = {
  ack_hours: { low: 48, medium: 24, high: 4, critical: 1 }, review_hours: { low: 168, medium: 72, high: 24, critical: 8 }, escalate_after_hours: { low: 240, medium: 96, high: 24, critical: 4 },
  retention_years: 7, require_guardian_copy: true, allow_private_channels: false, quiet_from: null, quiet_to: null,
};
const E = { summary: 'academy_sg_cases.summary', outcome: 'academy_sg_cases.outcome', note: 'academy_sg_actions.note', label: 'academy_sg_evidence.label', url: 'academy_sg_evidence.url', rationale: 'academy_sg_report_decisions.rationale' };
export const enc = (kind, v) => encrypt(v, E[kind]);
export const dec = (kind, v) => decrypt(v, E[kind]);

export const sgPolicy = async (c, orgId) => (await c.query('SELECT * FROM academy_sg_policies WHERE organisation_id=$1 AND retired_at IS NULL', [orgId])).rows[0] ?? { organisation_id: orgId, version: 0, ...DEFAULT_SG };
const hours = (n) => new Date(Date.now() + n * 3600_000);
export const deadlines = (policy, risk) => ({ ack_due_at: hours(policy.ack_hours[risk]), review_due_at: hours(policy.review_hours[risk]), escalate_due_at: hours(policy.escalate_after_hours[risk]) });

export async function logCase(c, caseId, kind, actorId, detail = null) {
  await c.query('INSERT INTO academy_sg_case_log(case_id, kind, actor_id, detail) VALUES ($1,$2,$3,$4)', [caseId, kind, actorId, detail]);
}

// ------------------------------------------------------------------------------------------------------------------ who may see a case
/** The caller's live designation, if any. unit_id null covers every campus. */
export const officerRows = async (c, orgId, userId) => (await c.query("SELECT * FROM academy_sg_officers WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [orgId, userId])).rows;
export const officersFor = async (c, orgId, unitId, tier, exclude = []) => (await c.query(
  `SELECT user_id FROM academy_sg_officers WHERE organisation_id=$1 AND status='active' AND tier=$2 AND (unit_id IS NULL OR unit_id=$3::uuid) AND NOT (user_id = ANY($4::uuid[])) ORDER BY (unit_id IS NULL), appointed_at, id`,
  [orgId, tier, unitId ?? null, exclude])).rows.map((r) => r.user_id);

/**
 * A case is readable only by a designated, active officer whose campus covers it, and never by the person the concern is about. Everyone else
 * (ordinary staff, finance, scouts, even owners who are not designated) gets 404 so the existence of a case is not disclosed.
 */
export async function caseVisibleTo(c, kase, userId) {
  if (!kase || kase.conflicted_user_id === userId) return false;
  const rows = await officerRows(c, kase.organisation_id, userId);
  return rows.some((o) => o.unit_id === null || o.unit_id === kase.unit_id);
}

// ------------------------------------------------------------------------------------------------------------------ staff suitability
/** Eligibility is only what the compliance module already verified for working with young people in this academy. */
export async function staffSuitability(c, orgId, userId) {
  const ctx = { organisation_ids: [orgId] };
  if (!(await hasObligations(c, 'youth_access', ctx))) return { state: 'not_configured', cleared: true, reasons: [], expiring: 0 };
  const g = await gate(c, userId, 'youth_access', ctx);
  const ev = await evaluateSubject(c, { kind: 'person', id: userId }, { consequence: 'youth_access', scopes: [{ kind: 'platform', id: null }, { kind: 'organisation', id: orgId }], context: ctx });
  const expiring = ev.counts?.expiring ?? 0;
  if (g.decision === 'clear') return { state: expiring ? 'expiring' : 'cleared', cleared: true, reasons: [], expiring };
  const revoked = g.items.some((i) => i.state === 'rejected' || i.state === 'revoked' || i.state === 'blocked');
  return { state: revoked ? 'revoked' : 'not_cleared', cleared: false, reasons: g.reasons, expiring };
}
/** A new assignment is refused when eligibility is not cleared. Returns an issue in the shape staffIssues uses, or null. */
export async function suitabilityIssue(c, orgId, userId) {
  const s = await staffSuitability(c, orgId, userId);
  return s.cleared ? null : { kind: 'safeguarding', code: 'safeguarding_not_cleared', message: `Safeguarding eligibility is not cleared (${s.reasons[0] ?? s.state})`, source_type: 'compliance' };
}

// ------------------------------------------------------------------------------------------------------------------ reporting rules (surface only)
export const rulesFor = async (c, orgId, jurisdiction, category) => (await c.query(
  `SELECT id, jurisdiction, incident_type, authority_label, notify_within_hours, guidance FROM academy_sg_report_rules
    WHERE organisation_id=$1 AND retired_at IS NULL AND incident_type=$3 AND ($2::text IS NULL OR jurisdiction=$2 OR jurisdiction=split_part($2,'-',1)) ORDER BY jurisdiction DESC`, [orgId, jurisdiction ?? null, category])).rows;

// ------------------------------------------------------------------------------------------------------------------ open / escalate
const caseNo = async (c) => `SG-${new Date().getUTCFullYear()}-${String((await c.query("SELECT nextval('academy_sg_case_seq') AS n")).rows[0].n).padStart(4, '0')}`;
const EVENT_KIND = (cat) => (cat === 'pickup' ? 'incident' : cat === 'welfare' ? 'welfare_concern' : 'incident');

/** Open a case (and its safety event when none is given). Routed to a tier-1 officer of the campus, never the reporter or the person concerned; falls back up the ladder. */
export async function openCase(c, { orgId, athleteId, category, risk, summary, unitId = null, eventId = null, conflictedUserId = null, jurisdiction = null, openedBy, idempotencyKey = null, sessionId = null }) {
  if (idempotencyKey) {
    const dup = (await c.query('SELECT * FROM academy_sg_cases WHERE organisation_id=$1 AND idempotency_key=$2', [orgId, idempotencyKey])).rows[0];
    if (dup) return { kase: dup, replayed: true };
  }
  if (unitId && !(await c.query("SELECT 1 FROM org_units WHERE id=$1 AND organisation_id=$2 AND kind='campus'", [unitId, orgId])).rowCount) throw notFound('Campus');
  const policy = await sgPolicy(c, orgId);
  const exclude = [openedBy, conflictedUserId].filter(Boolean);
  let tier = 1, assignee = null;
  for (; tier <= 3 && !assignee; tier++) assignee = (await officersFor(c, orgId, unitId, tier, exclude))[0] ?? null;
  tier = assignee ? tier - 1 : 1;
  let evId = eventId;
  if (evId) {
    if (!(await c.query('SELECT 1 FROM academy_safety_events WHERE id=$1 AND organisation_id=$2 AND athlete_id=$3', [evId, orgId, athleteId])).rowCount) throw notFound('Safety event');
  } else {
    const officers = await safeguardingOfficers(c, orgId, await policyFor(c, orgId));
    evId = (await openSafetyEvent(c, { orgId, sessionId, athleteId, kind: EVENT_KIND(category), severity: risk === 'low' ? 'low' : risk === 'medium' ? 'medium' : 'high', summary: null, routedTo: officers, actorId: openedBy })).event.id;
  }
  const d = deadlines(policy, risk);
  const rules = await rulesFor(c, orgId, jurisdiction, category);
  const kase = (await c.query(
    `INSERT INTO academy_sg_cases(organisation_id, case_no, event_id, athlete_id, unit_id, category, risk, tier, assignee_id, conflicted_user_id, jurisdiction, summary_enc, reporting_state, ack_due_at, review_due_at, escalate_due_at, opened_by, idempotency_key, retention_until)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,(current_date + ($19::int * interval '1 year'))::date) RETURNING *`,
    [orgId, await caseNo(c), evId, athleteId, unitId, category, risk, tier, assignee, conflictedUserId, jurisdiction, enc('summary', summary), rules.length ? 'needs_human_review' : 'not_assessed', d.ack_due_at, d.review_due_at, d.escalate_due_at, openedBy, idempotencyKey, policy.retention_years])).rows[0];
  await logCase(c, kase.id, 'opened', openedBy, `${category}/${risk}`);
  if (assignee) await logCase(c, kase.id, 'assigned', openedBy, `tier ${tier}`);
  for (const u of assignee ? [assignee] : await safeguardingOfficers(c, orgId, null)) {
    if (u === openedBy || u === conflictedUserId) continue;
    await notify(c, u, { kind: 'academy_sg_case', title: 'A safeguarding case needs attention', body: 'Open Academy > Safety & pickup > Cases. Details are shown only to designated officers.', urgent: risk === 'high' || risk === 'critical', data: { case_id: kase.id, organisation_id: orgId }, dedupe_key: `sg:${kase.id}:${u}` });
  }
  return { kase, replayed: false };
}

/** Raise a case one tier (campus officer → lead officer → leadership liaison). A person never receives a case about themselves; with nobody above, the owners are told. */
export async function escalateCase(c, kase, actorId, why = 'manual') {
  if (kase.status === 'closed') throw conflict('This case is closed', { code: 'already_closed' });
  const next = Math.min(3, kase.tier + 1);
  let assignee = null, tier = kase.tier;
  for (let t = next; t <= 3 && !assignee; t++) { assignee = (await officersFor(c, kase.organisation_id, kase.unit_id, t, [kase.conflicted_user_id, kase.opened_by].filter(Boolean)))[0] ?? null; tier = t; }
  const policy = await sgPolicy(c, kase.organisation_id);
  const row = (await c.query(
    `UPDATE academy_sg_cases SET tier=$2, assignee_id=coalesce($3, assignee_id), escalate_due_at=$4, ack_due_at=CASE WHEN acknowledged_at IS NULL THEN $6 ELSE ack_due_at END, risk=CASE WHEN risk IN ('low','medium') AND $5='sweep' THEN 'high' ELSE risk END, row_version=row_version+1 WHERE id=$1 RETURNING *`,
    [kase.id, assignee ? tier : kase.tier, assignee, hours(policy.escalate_after_hours[kase.risk] ?? 24), why, hours(policy.ack_hours[kase.risk] ?? 24)])).rows[0];
  await logCase(c, kase.id, 'escalated', actorId, `${why}: tier ${row.tier}`);
  const tell = assignee ? [assignee] : (await safeguardingOfficers(c, kase.organisation_id, null)).filter((u) => u !== kase.conflicted_user_id);
  for (const u of tell) await notify(c, u, { kind: 'academy_sg_case', title: 'A safeguarding case was escalated', body: 'Open Academy > Safety & pickup > Cases.', urgent: true, data: { case_id: kase.id, organisation_id: kase.organisation_id }, dedupe_key: `sg-esc:${kase.id}:${row.tier}:${u}` });
  return row;
}

/** Background sweep: an unacknowledged case past its acknowledgement deadline, or an open one past its escalation deadline, rises one tier. Idempotent: the deadline moves on each time. */
export async function sweepSafeguardingCases(c) {
  const due = (await c.query(
    `SELECT * FROM academy_sg_cases WHERE status <> 'closed' AND ((acknowledged_at IS NULL AND ack_due_at < now()) OR escalate_due_at < now()) ORDER BY escalate_due_at LIMIT 100 FOR UPDATE SKIP LOCKED`)).rows;
  let n = 0;
  for (const k of due) { await escalateCase(c, k, null, 'sweep'); n++; }
  return n;
}

export const viewCase = (k, { names = {} } = {}) => ({
  id: k.id, case_no: k.case_no, organisation_id: k.organisation_id, athlete_id: k.athlete_id, athlete_name: names.athlete ?? null, unit_id: k.unit_id, campus_name: names.campus ?? null, category: k.category, risk: k.risk, status: k.status, tier: k.tier, tier_label: TIERS[k.tier],
  assignee_id: k.assignee_id, assignee_name: names.assignee ?? null, jurisdiction: k.jurisdiction, reporting_state: k.reporting_state, ack_due_at: k.ack_due_at, acknowledged_at: k.acknowledged_at, review_due_at: k.review_due_at, escalate_due_at: k.escalate_due_at,
  overdue: k.status !== 'closed' && ((!k.acknowledged_at && new Date(k.ack_due_at) < new Date()) || new Date(k.escalate_due_at) < new Date()),
  opened_at: k.opened_at, closed_at: k.closed_at, close_reason: k.close_reason, retention_until: k.retention_until, event_id: k.event_id, row_version: k.row_version,
});
export { badRequest, forbidden, notFound };
