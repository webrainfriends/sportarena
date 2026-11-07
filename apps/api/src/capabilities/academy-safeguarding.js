// Academy safeguarding & welfare case orchestration (#784): the officer desk, the staff intake, the policy and the redacted leadership view.
// Rules live in src/safeguarding.js. This extends academy_safety_events (#788) and compliance (#595): no parallel case database, no copied eligibility.
// Case content is readable only by designated officers; everyone else gets 404. Every read and change is in the append-only case log and the audit log.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { tx } from '../db.js';
import { conflict, forbidden, notFound, badRequest } from '../errors.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { opsAccess, ADMINS } from '../academy-ops.js';
import { guardianLink, isYouth } from '../youth.js';
import { ACTION_KINDS, CATEGORIES, RISKS, STATUSES, caseVisibleTo, deadlines, dec, enc, escalateCase, logCase, officerRows, officersFor, openCase, rulesFor, sgPolicy, staffSuitability, viewCase, DEFAULT_SG } from '../safeguarding.js';

const TAG = 'Academy safeguarding';
const orgInput = { id };
const JUR = z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/, 'Use an ISO code such as IN, IN-KA or ES');
const hoursMap = z.object({ low: z.number().int().min(1).max(2160), medium: z.number().int().min(1).max(2160), high: z.number().int().min(1).max(2160), critical: z.number().int().min(1).max(2160) });

const adminAccess = (user, orgId, c, write = false) => opsAccess(user, orgId, { write, c }).then((a) => { if (!a.admin) throw forbidden('Only the academy owner or admin can do this'); return a; });
/** Oversight (redacted counts, officer list, policy): owner/admin, safeguarding permission or a designated officer. Never case content. */
const oversight = async (user, orgId, c) => {
  const a = await opsAccess(user, orgId, { c });
  const officer = (await officerRows(c, orgId, user.id)).length > 0;
  if (!a.admin && !a.has('safeguarding') && !officer) throw forbidden('You do not have safeguarding oversight of this academy');
  return { a, officer };
};
const needOfficer = async (user, orgId, c) => {
  try { await opsAccess(user, orgId, { c }); } catch { throw notFound('Case'); }
  if (!(await officerRows(c, orgId, user.id)).length) throw notFound('Case');
};
const nameOf = async (c, uid) => (uid ? (await c.query('SELECT display_name FROM users WHERE id=$1', [uid])).rows[0]?.display_name ?? null : null);
const caseOf = async (c, caseId, user, lock = false) => {
  const k = (await c.query(`SELECT * FROM academy_sg_cases WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [caseId])).rows[0];
  if (!k || !(await caseVisibleTo(c, k, user.id))) throw notFound('Case');
  return k;
};
const namesOf = async (c, k) => ({ athlete: await nameOf(c, k.athlete_id), assignee: await nameOf(c, k.assignee_id), campus: k.unit_id ? (await c.query('SELECT name FROM org_units WHERE id=$1', [k.unit_id])).rows[0]?.name ?? null : null });

/** Officers a case could be handed to: designated for its campus, not the person concerned, not the reporter, with names. */
const assignable = async (c, k) => {
  const rows = (await c.query("SELECT DISTINCT ON (o.user_id) o.user_id, o.tier, u.display_name AS name FROM academy_sg_officers o JOIN users u ON u.id=o.user_id WHERE o.organisation_id=$1 AND o.status='active' AND (o.unit_id IS NULL OR o.unit_id IS NOT DISTINCT FROM $2::uuid) AND o.user_id <> ALL($3::uuid[]) ORDER BY o.user_id, o.tier DESC", [k.organisation_id, k.unit_id, [k.conflicted_user_id, k.opened_by].filter(Boolean)])).rows;
  return rows.sort((x, y) => x.tier - y.tier || x.name.localeCompare(y.name));
};

// ------------------------------------------------------------------------------------------------------------------ officers
cap({
  name: 'designate_academy_sg_officer', method: 'POST', path: '/organisations/:id/academy/safeguarding/officers', tag: TAG, status: 201,
  summary: 'Owner/admin: designate a safeguarding officer for the whole academy or one campus, at a tier of the escalation hierarchy (1 campus officer, 2 lead officer, 3 leadership liaison). The person must be an active member of the academy and cleared by its youth-access obligations (#595). Designations are ended, never deleted.',
  input: z.object({ ...orgInput, user_id: id, unit_id: id.optional(), tier: z.number().int().min(1).max(3).default(1) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await adminAccess(user, i.id, c, true);
      if (!(await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [i.id, i.user_id])).rowCount) throw notFound('Member');
      if (i.unit_id && !(await c.query("SELECT 1 FROM org_units WHERE id=$1 AND organisation_id=$2 AND kind='campus' AND status='active'", [i.unit_id, i.id])).rowCount) throw notFound('Campus');
      const s = await staffSuitability(c, i.id, i.user_id);
      if (!s.cleared) throw conflict('Safeguarding eligibility must be cleared before a person can be designated', { code: 'compliance_required', reasons: s.reasons });
      const row = (await c.query('INSERT INTO academy_sg_officers(organisation_id, user_id, unit_id, tier, appointed_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING *', [i.id, i.user_id, i.unit_id ?? null, i.tier, user.id])).rows[0];
      if (!row) throw conflict('This person is already designated for that campus', { code: 'already_designated' });
      await audit(c, user.id, 'designate_academy_sg_officer', 'academy_sg_officers', row.id);
      await notify(c, i.user_id, { kind: 'academy_sg_officer', title: 'You were designated a safeguarding officer', body: 'Open Academy > Safety & pickup > Cases.', data: { organisation_id: i.id }, dedupe_key: `sg-off:${row.id}` });
      return row;
    });
  },
});

cap({
  name: 'end_academy_sg_officer', method: 'POST', path: '/academy/safeguarding/officers/:id/end', tag: TAG,
  summary: 'Owner/admin: end a designation (kept as history). Open cases assigned to that person are returned to the officer queue for reassignment and the officer loses access at once. The last officer cannot be ended while cases are open.',
  input: z.object({ id, reason: z.string().min(3).max(300) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const o = (await c.query("SELECT * FROM academy_sg_officers WHERE id=$1 AND status='active' FOR UPDATE", [i.id])).rows[0];
      if (!o) throw notFound('Officer');
      await adminAccess(user, o.organisation_id, c, true);
      const others = (await c.query("SELECT count(*)::int AS n FROM academy_sg_officers WHERE organisation_id=$1 AND status='active' AND id<>$2", [o.organisation_id, o.id])).rows[0].n;
      const open = (await c.query("SELECT count(*)::int AS n FROM academy_sg_cases WHERE organisation_id=$1 AND status<>'closed'", [o.organisation_id])).rows[0].n;
      if (!others && open) throw conflict('Designate another officer first: cases are still open', { code: 'last_officer' });
      await c.query("UPDATE academy_sg_officers SET status='ended', ended_at=now(), ended_by=$2, end_reason=$3 WHERE id=$1", [o.id, user.id, i.reason]);
      const freed = (await c.query("UPDATE academy_sg_cases SET assignee_id=NULL, row_version=row_version+1 WHERE organisation_id=$1 AND assignee_id=$2 AND status<>'closed' RETURNING id", [o.organisation_id, o.user_id])).rows;
      for (const k of freed) await logCase(c, k.id, 'unassigned', user.id, 'officer designation ended');
      await audit(c, user.id, 'end_academy_sg_officer', 'academy_sg_officers', o.id);
      return { id: o.id, status: 'ended', cases_unassigned: freed.length };
    });
  },
});

cap({
  name: 'list_academy_sg_officers', method: 'GET', path: '/organisations/:id/academy/safeguarding/officers', tag: TAG,
  summary: 'Designated officers with campus, tier and whether each is currently cleared. Visible to owners/admins, safeguarding staff and officers; names only, never case content.',
  input: z.object({ ...orgInput }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await oversight(user, i.id, c);
      const rows = (await c.query("SELECT o.*, u.display_name, g.name AS campus_name FROM academy_sg_officers o JOIN users u ON u.id=o.user_id LEFT JOIN org_units g ON g.id=o.unit_id WHERE o.organisation_id=$1 AND o.status='active' ORDER BY o.tier, u.display_name", [i.id])).rows;
      const out = [];
      for (const r of rows) out.push({ id: r.id, user_id: r.user_id, name: r.display_name, tier: r.tier, unit_id: r.unit_id, campus_name: r.campus_name ?? null, appointed_at: r.appointed_at, suitability: (await staffSuitability(c, i.id, r.user_id)).state });
      return { items: out };
    });
  },
});

// ------------------------------------------------------------------------------------------------------------------ policy and reporting rules
cap({
  name: 'get_academy_sg_policy', method: 'GET', path: '/organisations/:id/academy/safeguarding/policy', tag: TAG,
  summary: 'Safeguarding settings: acknowledgement, review and escalation deadlines by risk, retention, communication boundaries, and the configured mandatory-reporting rules by jurisdiction and incident type (these only prompt a human review).',
  input: z.object({ ...orgInput }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await oversight(user, i.id, c);
      const p = await sgPolicy(c, i.id);
      const rules = (await c.query('SELECT id, jurisdiction, incident_type, authority_label, notify_within_hours, guidance, created_at FROM academy_sg_report_rules WHERE organisation_id=$1 AND retired_at IS NULL ORDER BY jurisdiction, incident_type', [i.id])).rows;
      return { version: p.version, ack_hours: p.ack_hours, review_hours: p.review_hours, escalate_after_hours: p.escalate_after_hours, retention_years: p.retention_years, require_guardian_copy: p.require_guardian_copy, allow_private_channels: p.allow_private_channels, quiet_from: p.quiet_from, quiet_to: p.quiet_to, rules, defaults: version0(p) };
    });
  },
});
const version0 = (p) => p.version === 0;

cap({
  name: 'set_academy_sg_policy', method: 'POST', path: '/organisations/:id/academy/safeguarding/policy', tag: TAG,
  summary: 'Owner/admin: save the safeguarding settings. The previous version is retired, not changed. Private one-to-one channels stay off unless allowed here; a guardian is copied on staff messages to under-18s by default.',
  input: z.object({ ...orgInput, ack_hours: hoursMap.default(DEFAULT_SG.ack_hours), review_hours: hoursMap.default(DEFAULT_SG.review_hours), escalate_after_hours: hoursMap.default(DEFAULT_SG.escalate_after_hours), retention_years: z.number().int().min(1).max(50).default(7), require_guardian_copy: z.boolean().default(true), allow_private_channels: z.boolean().default(false), quiet_from: z.string().regex(/^\d{2}:\d{2}$/).nullable().default(null), quiet_to: z.string().regex(/^\d{2}:\d{2}$/).nullable().default(null) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await adminAccess(user, i.id, c, true);
      const old = (await c.query('UPDATE academy_sg_policies SET retired_at=now() WHERE organisation_id=$1 AND retired_at IS NULL RETURNING version', [i.id])).rows[0];
      const row = (await c.query('INSERT INTO academy_sg_policies(organisation_id, version, ack_hours, review_hours, escalate_after_hours, retention_years, require_guardian_copy, allow_private_channels, quiet_from, quiet_to, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
        [i.id, (old?.version ?? 0) + 1, i.ack_hours, i.review_hours, i.escalate_after_hours, i.retention_years, i.require_guardian_copy, i.allow_private_channels, i.quiet_from, i.quiet_to, user.id])).rows[0];
      await audit(c, user.id, 'set_academy_sg_policy', 'academy_sg_policies', row.id);
      return { version: row.version };
    });
  },
});

cap({
  name: 'save_academy_sg_report_rule', method: 'POST', path: '/organisations/:id/academy/safeguarding/report-rules', tag: TAG, status: 201,
  summary: 'Owner/admin: configure which authority a case of an incident type should be considered for, in a jurisdiction, and by when. The platform never decides or sends a report: the rule is shown to the case officer, who records a human decision. Send retire=true to retire a rule (kept as history).',
  input: z.object({ ...orgInput, jurisdiction: JUR, incident_type: z.enum(CATEGORIES), authority_label: z.string().min(2).max(120), notify_within_hours: z.number().int().min(1).max(720).optional(), guidance: z.string().max(1000).optional(), retire: z.boolean().default(false) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await adminAccess(user, i.id, c, true);
      await c.query('UPDATE academy_sg_report_rules SET retired_at=now() WHERE organisation_id=$1 AND jurisdiction=$2 AND incident_type=$3 AND retired_at IS NULL', [i.id, i.jurisdiction, i.incident_type]);
      if (i.retire) return { retired: true };
      const row = (await c.query('INSERT INTO academy_sg_report_rules(organisation_id, jurisdiction, incident_type, authority_label, notify_within_hours, guidance, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, jurisdiction, incident_type, authority_label, notify_within_hours', [i.id, i.jurisdiction, i.incident_type, i.authority_label, i.notify_within_hours ?? null, i.guidance ?? null, user.id])).rows[0];
      await audit(c, user.id, 'save_academy_sg_report_rule', 'academy_sg_report_rules', row.id);
      return row;
    });
  },
});

// ------------------------------------------------------------------------------------------------------------------ intake
cap({
  name: 'open_academy_sg_case', method: 'POST', path: '/organisations/:id/academy/safeguarding/cases', tag: TAG, status: 201,
  summary: 'Raise a concern. Staff with attendance or safeguarding access, the athlete (an adult or a young person for themself) and a verified guardian may raise one. It is classified, deadlines start from the academy policy, and it is routed to a designated officer of the campus: never the reporter, never the person the concern is about (conflicted_user_id). The reporter gets only the case number and "received", never the case. Send idempotency_key to retry safely.',
  input: z.object({ ...orgInput, athlete_id: id, category: z.enum(CATEGORIES), risk: z.enum(RISKS).default('medium'), summary: z.string().min(5).max(4000), unit_id: id.optional(), session_id: id.optional(), event_id: id.optional(), conflicted_user_id: id.optional(), jurisdiction: JUR.optional(), idempotency_key: z.string().min(8).max(80).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      let standing = null;
      if (user.id === i.athlete_id) standing = 'athlete';
      else if (await guardianLink(user.id, i.athlete_id, c)) standing = 'guardian';
      else { try { const a = await opsAccess(user, i.id, { write: true, c }); if (a.has('safeguarding') || a.has('attendance') || a.admin) standing = 'staff'; } catch { /* not staff */ } }
      if (!standing) throw notFound('Athlete');
      if (!(await c.query('SELECT 1 FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.organisation_id=$1 AND e.user_id=$2', [i.id, i.athlete_id])).rowCount) throw notFound('Athlete');
      if (i.session_id && !(await c.query('SELECT 1 FROM academy_sessions WHERE id=$1 AND organisation_id=$2', [i.session_id, i.id])).rowCount) throw notFound('Session');
      if (i.conflicted_user_id && !(await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [i.id, i.conflicted_user_id])).rowCount) throw notFound('Member');
      const { kase, replayed } = await openCase(c, { orgId: i.id, athleteId: i.athlete_id, category: i.category, risk: i.risk, summary: i.summary, unitId: i.unit_id ?? null, eventId: i.event_id ?? null, conflictedUserId: i.conflicted_user_id ?? null, jurisdiction: i.jurisdiction ?? null, openedBy: user.id, idempotencyKey: i.idempotency_key ?? null, sessionId: i.session_id ?? null });
      if (!replayed) await audit(c, user.id, 'open_academy_sg_case', 'academy_sg_cases', kase.id);
      return { case_no: kase.case_no, status: 'received', replayed };
    });
  },
});

// ------------------------------------------------------------------------------------------------------------------ officer desk
cap({
  name: 'list_academy_sg_cases', method: 'GET', path: '/organisations/:id/academy/safeguarding/cases', tag: TAG,
  summary: 'Designated officers: the cases they may see, most urgent first (overdue, then risk, then age) with status, risk, tier, assignee and deadlines. No narrative here: open a case to read it (audit-logged). Anyone who is not a designated officer gets 404.',
  input: z.object({ ...orgInput, status: z.enum([...STATUSES, 'open']).optional(), risk: z.enum(RISKS).optional(), mine: z.coerce.boolean().optional(), unassigned: z.coerce.boolean().optional(), q: z.string().max(60).optional(), ...page }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await needOfficer(user, i.id, c);
      const rows = (await c.query(
        `SELECT k.*, a.display_name AS athlete_name, s.display_name AS assignee_name, g.name AS campus_name FROM academy_sg_cases k JOIN users a ON a.id=k.athlete_id LEFT JOIN users s ON s.id=k.assignee_id LEFT JOIN org_units g ON g.id=k.unit_id
          WHERE k.organisation_id=$1 AND k.conflicted_user_id IS DISTINCT FROM $2 AND EXISTS (SELECT 1 FROM academy_sg_officers o WHERE o.organisation_id=k.organisation_id AND o.user_id=$2 AND o.status='active' AND (o.unit_id IS NULL OR o.unit_id=k.unit_id))
            AND ($3::text IS NULL OR k.status=$3 OR ($3='open' AND k.status<>'closed')) AND ($4::text IS NULL OR k.risk=$4) AND (NOT $5::boolean OR k.assignee_id=$2) AND (NOT $6::boolean OR k.assignee_id IS NULL)
            AND ($7::text IS NULL OR k.case_no ILIKE '%'||$7||'%' OR a.display_name ILIKE '%'||$7||'%' OR g.name ILIKE '%'||$7||'%')
          ORDER BY (k.status='closed'), (k.status<>'closed' AND ((k.acknowledged_at IS NULL AND k.ack_due_at<now()) OR k.escalate_due_at<now())) DESC, array_position(ARRAY['critical','high','medium','low'], k.risk), k.opened_at LIMIT $8 OFFSET $9`,
        [i.id, user.id, i.status ?? null, i.risk ?? null, !!i.mine, !!i.unassigned, i.q ?? null, i.limit, i.offset])).rows;
      return { items: rows.map((k) => viewCase(k, { names: { athlete: k.athlete_name, assignee: k.assignee_name, campus: k.campus_name } })) };
    });
  },
});

cap({
  name: 'get_academy_sg_case', method: 'GET', path: '/academy/safeguarding/cases/:id', tag: TAG,
  summary: 'A designated officer reads one case: classification, decrypted summary, actions, evidence references, applicable mandatory-reporting rules and decisions, and the append-only log. The read itself is logged. Others get 404.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const k = await caseOf(c, i.id, user);
      await logCase(c, k.id, 'read', user.id);
      await audit(c, user.id, 'read_academy_sg_case', 'academy_sg_cases', k.id);
      const actions = (await c.query('SELECT a.*, u.display_name AS owner_name FROM academy_sg_actions a LEFT JOIN users u ON u.id=a.owner_id WHERE a.case_id=$1 ORDER BY a.created_at', [k.id])).rows.map((a) => ({ id: a.id, kind: a.kind, status: a.status, owner_id: a.owner_id, owner_name: a.owner_name, due_at: a.due_at, done_at: a.done_at, note: dec('note', a.note_enc) }));
      const evidence = (await c.query('SELECT * FROM academy_sg_evidence WHERE case_id=$1 ORDER BY added_at', [k.id])).rows.map((e) => ({ id: e.id, kind: e.kind, ref_id: e.ref_id, label: dec('label', e.label_enc), url: dec('url', e.url_enc), added_at: e.added_at }));
      const decisions = (await c.query('SELECT d.*, r.authority_label, u.display_name AS by_name FROM academy_sg_report_decisions d LEFT JOIN academy_sg_report_rules r ON r.id=d.rule_id JOIN users u ON u.id=d.decided_by WHERE d.case_id=$1 ORDER BY d.decided_at', [k.id])).rows.map((d) => ({ id: d.id, rule_id: d.rule_id, authority_label: d.authority_label, decision: d.decision, rationale: dec('rationale', d.rationale_enc), decided_by: d.by_name, decided_at: d.decided_at }));
      const log = (await c.query('SELECT l.kind, l.detail, l.created_at, u.display_name AS actor_name FROM academy_sg_case_log l LEFT JOIN users u ON u.id=l.actor_id WHERE l.case_id=$1 ORDER BY l.id', [k.id])).rows;
      return { ...viewCase(k, { names: await namesOf(c, k) }), summary: dec('summary', k.summary_enc), outcome: dec('outcome', k.outcome_enc), actions, evidence, report_rules: await rulesFor(c, k.organisation_id, k.jurisdiction, k.category), report_decisions: decisions, log,
        assignable: await assignable(c, k) };
    });
  },
});

cap({
  name: 'update_academy_sg_case', method: 'PATCH', path: '/academy/safeguarding/cases/:id', tag: TAG,
  summary: 'Officer workflow: acknowledge, reclassify (risk restarts the deadlines), assign (to a designated officer who is cleared, is not the reporter and is not the person concerned), escalate one tier, move to the next stage, or close. Closing needs an outcome and a reason, and, where a mandatory-reporting rule applies, a recorded human decision. Needs the row_version you loaded.',
  input: z.object({ id, action: z.enum(['acknowledge', 'reclassify', 'assign', 'escalate', 'advance', 'close']), row_version: z.number().int(), risk: z.enum(RISKS).optional(), assignee_id: id.optional(), status: z.enum(['assessment', 'action', 'review']).optional(), outcome: z.string().min(5).max(4000).optional(), close_reason: z.enum(['resolved', 'no_further_action', 'referred', 'monitoring_ended']).optional(), note: z.string().max(300).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      let k = await caseOf(c, i.id, user, true);
      if (k.row_version !== i.row_version) throw conflict('This case changed since you opened it', { code: 'stale_version' });
      if (k.status === 'closed') throw conflict('This case is closed', { code: 'already_closed' });
      if (i.action === 'acknowledge') {
        k = (await c.query('UPDATE academy_sg_cases SET acknowledged_at=coalesce(acknowledged_at, now()), status=CASE WHEN status=\'received\' THEN \'assessment\' ELSE status END, row_version=row_version+1 WHERE id=$1 RETURNING *', [k.id])).rows[0];
        await logCase(c, k.id, 'acknowledged', user.id);
      } else if (i.action === 'reclassify') {
        if (!i.risk) throw badRequest('Choose a risk level');
        const d = deadlines(await sgPolicy(c, k.organisation_id), i.risk);
        k = (await c.query('UPDATE academy_sg_cases SET risk=$2, review_due_at=$3, escalate_due_at=$4, row_version=row_version+1 WHERE id=$1 RETURNING *', [k.id, i.risk, d.review_due_at, d.escalate_due_at])).rows[0];
        await logCase(c, k.id, 'reclassified', user.id, `${i.risk}${i.note ? `: ${i.note}` : ''}`);
      } else if (i.action === 'assign') {
        if (!i.assignee_id) throw badRequest('Choose an officer');
        if (i.assignee_id === k.conflicted_user_id) throw conflict('The person a concern is about cannot handle it', { code: 'conflict_of_interest' });
        if (i.assignee_id === k.opened_by) throw conflict('The person who raised a concern cannot also decide it', { code: 'separation_of_duty' });
        const offs = await officerRows(c, k.organisation_id, i.assignee_id);
        if (!offs.some((o) => o.unit_id === null || o.unit_id === k.unit_id)) throw conflict('Only a designated officer for this campus can be assigned', { code: 'not_an_officer' });
        const s = await staffSuitability(c, k.organisation_id, i.assignee_id);
        if (!s.cleared) throw conflict('That officer\'s safeguarding eligibility is not cleared', { code: 'compliance_required', reasons: s.reasons });
        k = (await c.query('UPDATE academy_sg_cases SET assignee_id=$2, tier=GREATEST(tier, $3), row_version=row_version+1 WHERE id=$1 RETURNING *', [k.id, i.assignee_id, Math.max(...offs.filter((o) => o.unit_id === null || o.unit_id === k.unit_id).map((o) => o.tier))])).rows[0];
        await logCase(c, k.id, 'assigned', user.id);
        await notify(c, i.assignee_id, { kind: 'academy_sg_case', title: 'A safeguarding case was assigned to you', body: 'Open Academy > Safety & pickup > Cases.', data: { case_id: k.id, organisation_id: k.organisation_id }, dedupe_key: `sg-as:${k.id}:${i.assignee_id}:${k.row_version}` });
      } else if (i.action === 'escalate') k = await escalateCase(c, k, user.id, 'manual');
      else if (i.action === 'advance') {
        if (!i.status) throw badRequest('Choose the next stage');
        if (STATUSES.indexOf(i.status) < STATUSES.indexOf(k.status)) throw conflict('A case moves forward only', { code: 'bad_transition' });
        k = (await c.query('UPDATE academy_sg_cases SET status=$2, row_version=row_version+1 WHERE id=$1 RETURNING *', [k.id, i.status])).rows[0];
        await logCase(c, k.id, 'advanced', user.id, i.status);
      } else {
        if (!i.outcome || !i.close_reason) throw badRequest('Record the outcome and the reason for closing');
        if (!k.acknowledged_at) throw conflict('Acknowledge the case before closing it', { code: 'not_acknowledged' });
        if (k.opened_by === user.id) throw conflict('The person who raised a concern cannot close it', { code: 'separation_of_duty' });
        const applicable = await rulesFor(c, k.organisation_id, k.jurisdiction, k.category);
        if (applicable.length && !(await c.query('SELECT 1 FROM academy_sg_report_decisions WHERE case_id=$1', [k.id])).rowCount) throw conflict('A reporting rule applies: record the human decision before closing', { code: 'report_decision_required' });
        if ((await c.query("SELECT 1 FROM academy_sg_actions WHERE case_id=$1 AND status='open' AND kind='report_review'", [k.id])).rowCount) throw conflict('Finish or cancel the reporting review first', { code: 'open_actions' });
        k = (await c.query("UPDATE academy_sg_cases SET status='closed', closed_at=now(), closed_by=$2, outcome_enc=$3, close_reason=$4, row_version=row_version+1 WHERE id=$1 RETURNING *", [k.id, user.id, enc('outcome', i.outcome), i.close_reason])).rows[0];
        await logCase(c, k.id, 'closed', user.id, i.close_reason);
      }
      await audit(c, user.id, `${i.action}_academy_sg_case`, 'academy_sg_cases', k.id);
      return viewCase(k, { names: await namesOf(c, k) });
    });
  },
});

cap({
  name: 'save_academy_sg_action', method: 'POST', path: '/academy/safeguarding/cases/:id/actions', tag: TAG, status: 201,
  summary: 'Officer: add an action to a case (risk review, guardian contact, referral, training or checks, monitoring, report review) with an owner and a due date, or complete or cancel one (send action_id and status). Notes are encrypted.',
  input: z.object({ id, action_id: id.optional(), kind: z.enum(ACTION_KINDS).optional(), owner_id: id.optional(), due_at: z.string().datetime().optional(), note: z.string().max(2000).optional(), status: z.enum(['open', 'done', 'cancelled']).default('open') }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const k = await caseOf(c, i.id, user, true);
      if (k.status === 'closed') throw conflict('This case is closed', { code: 'already_closed' });
      if (i.action_id) {
        const a = (await c.query("UPDATE academy_sg_actions SET status=$3, done_at=CASE WHEN $3='done' THEN now() END, done_by=CASE WHEN $3='done' THEN $4::uuid END, note_enc=coalesce($5, note_enc) WHERE id=$1 AND case_id=$2 AND status='open' RETURNING *", [i.action_id, k.id, i.status, user.id, i.note ? enc('note', i.note) : null])).rows[0];
        if (!a) throw notFound('Action');
        await logCase(c, k.id, `action_${i.status}`, user.id, a.kind);
        return { id: a.id, status: a.status };
      }
      if (!i.kind) throw badRequest('Choose the kind of action');
      if (i.owner_id && !(await officerRows(c, k.organisation_id, i.owner_id)).length) throw conflict('An action is owned by a designated officer', { code: 'not_an_officer' });
      const a = (await c.query('INSERT INTO academy_sg_actions(case_id, kind, owner_id, due_at, note_enc, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, status', [k.id, i.kind, i.owner_id ?? k.assignee_id, i.due_at ?? null, i.note ? enc('note', i.note) : null, user.id])).rows[0];
      await logCase(c, k.id, 'action_added', user.id, i.kind);
      return a;
    });
  },
});

cap({
  name: 'add_academy_sg_evidence', method: 'POST', path: '/academy/safeguarding/cases/:id/evidence', tag: TAG, status: 201,
  summary: 'Officer: reference evidence for a case. It is a pointer, never a copy: a compliance file (#595) or safety event of this academy, or an https link. Labels and links are encrypted; reading them is audit-logged with the case.',
  input: z.object({ id, kind: z.enum(['compliance_file', 'safety_event', 'link']), ref_id: id.optional(), label: z.string().min(2).max(200), url: z.string().url().refine((u) => u.startsWith('https://'), 'Use an https link').optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const k = await caseOf(c, i.id, user, true);
      if (k.status === 'closed') throw conflict('This case is closed', { code: 'already_closed' });
      if (i.kind === 'link' && !i.url) throw badRequest('Add the link');
      if (i.kind === 'safety_event' && !(await c.query('SELECT 1 FROM academy_safety_events WHERE id=$1 AND organisation_id=$2', [i.ref_id, k.organisation_id])).rowCount) throw notFound('Safety event');
      if (i.kind === 'compliance_file' && !(await c.query('SELECT 1 FROM comp_files WHERE id=$1', [i.ref_id])).rowCount) throw notFound('File');
      if (i.kind !== 'link' && !i.ref_id) throw badRequest('Choose the record');
      const e = (await c.query('INSERT INTO academy_sg_evidence(case_id, kind, ref_id, label_enc, url_enc, added_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, kind', [k.id, i.kind, i.ref_id ?? null, enc('label', i.label), i.url ? enc('url', i.url) : null, user.id])).rows[0];
      await logCase(c, k.id, 'evidence_added', user.id, i.kind);
      return e;
    });
  },
});

cap({
  name: 'record_academy_sg_report_decision', method: 'POST', path: '/academy/safeguarding/cases/:id/report-decision', tag: TAG, status: 201,
  summary: 'The human decision on a mandatory-reporting rule: reported, not required or deferred, with a written rationale. The platform never reports to an authority and never decides this for the officer. A deferral keeps the case flagged for review.',
  input: z.object({ id, rule_id: id.optional(), decision: z.enum(['reported', 'not_required', 'deferred']), rationale: z.string().min(10).max(2000) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const k = await caseOf(c, i.id, user, true);
      if (k.status === 'closed') throw conflict('This case is closed', { code: 'already_closed' });
      if (i.rule_id && !(await c.query('SELECT 1 FROM academy_sg_report_rules WHERE id=$1 AND organisation_id=$2', [i.rule_id, k.organisation_id])).rowCount) throw notFound('Rule');
      const d = (await c.query('INSERT INTO academy_sg_report_decisions(case_id, rule_id, decision, rationale_enc, decided_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, decision, decided_at', [k.id, i.rule_id ?? null, i.decision, enc('rationale', i.rationale), user.id])).rows[0];
      await c.query("UPDATE academy_sg_cases SET reporting_state=$2, row_version=row_version+1 WHERE id=$1", [k.id, i.decision === 'deferred' ? 'needs_human_review' : 'decision_recorded']);
      await logCase(c, k.id, 'report_decision', user.id, i.decision);
      await audit(c, user.id, 'record_academy_sg_report_decision', 'academy_sg_cases', k.id);
      return d;
    });
  },
});

// ------------------------------------------------------------------------------------------------------------------ oversight, suitability, boundaries
cap({
  name: 'get_academy_sg_overview', method: 'GET', path: '/organisations/:id/academy/safeguarding', tag: TAG,
  summary: 'Redacted leadership indicators for owners/admins, safeguarding staff and officers: counts of open, unassigned, overdue and escalated cases, by risk, stage and campus, median days to close, share of reporting reviews completed, officer coverage and roster clearance. No names, no narrative. Groups under five are returned as null.',
  input: z.object({ ...orgInput }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await oversight(user, i.id, c);
      const one = async (sql) => (await c.query(sql, [i.id])).rows[0];
      const t = await one("SELECT count(*) FILTER (WHERE status<>'closed')::int AS open, count(*) FILTER (WHERE status<>'closed' AND assignee_id IS NULL)::int AS unassigned, count(*) FILTER (WHERE status<>'closed' AND ((acknowledged_at IS NULL AND ack_due_at<now()) OR escalate_due_at<now()))::int AS overdue, count(*) FILTER (WHERE status<>'closed' AND tier>1)::int AS escalated, count(*) FILTER (WHERE status<>'closed' AND reporting_state='needs_human_review')::int AS awaiting_review, count(*) FILTER (WHERE status='closed')::int AS closed, (percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM closed_at-opened_at)/86400) FILTER (WHERE status='closed')) AS median_days FROM academy_sg_cases WHERE organisation_id=$1");
      const g = (n) => (n >= 5 || n === 0 ? n : null);
      const by = async (col) => Object.fromEntries((await c.query(`SELECT ${col} AS k, count(*)::int AS n FROM academy_sg_cases WHERE organisation_id=$1 AND status<>'closed' GROUP BY 1`, [i.id])).rows.map((r) => [r.k ?? 'none', g(r.n)]));
      const officers = (await one("SELECT count(*)::int AS n FROM academy_sg_officers WHERE organisation_id=$1 AND status='active'")).n;
      const staff = (await c.query("SELECT m.user_id FROM organisation_members m LEFT JOIN org_staff_engagements e ON e.user_id=m.user_id AND e.organisation_id=m.organisation_id WHERE m.organisation_id=$1 AND m.status='active' AND coalesce(e.state,'active')='active'", [i.id])).rows;
      let cleared = 0; for (const s of staff) if ((await staffSuitability(c, i.id, s.user_id)).cleared) cleared++;
      return { open: t.open, unassigned: t.unassigned, overdue: t.overdue, escalated: t.escalated, awaiting_review: t.awaiting_review, closed: t.closed, median_days_to_close: t.median_days === null ? null : Math.round(t.median_days * 10) / 10, by_risk: await by('risk'), by_stage: await by('status'), by_campus: await by('unit_id'), officers, roster: { staff: staff.length, cleared, pct_cleared: staff.length ? Math.round((100 * cleared) / staff.length) : null } };
    });
  },
});

cap({
  name: 'get_academy_staff_suitability', method: 'GET', path: '/organisations/:id/academy/safeguarding/suitability', tag: TAG,
  summary: 'Roster suitability from verified compliance records only (#595): per staff member cleared, expiring, revoked or not cleared with the reasons, and the upcoming sessions they are assigned to that need reassignment. Revoked or lapsed eligibility blocks every new session assignment. Owners/admins, safeguarding staff and officers.',
  input: z.object({ ...orgInput, ...page }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await oversight(user, i.id, c);
      const staff = (await c.query("SELECT u.id AS user_id, u.display_name, e.job_title FROM users u LEFT JOIN org_staff_engagements e ON e.user_id=u.id AND e.organisation_id=$1 WHERE (u.id IN (SELECT user_id FROM organisation_members WHERE organisation_id=$1 AND status='active') AND coalesce(e.state,'active')='active') ORDER BY u.display_name, u.id LIMIT $2 OFFSET $3", [i.id, i.limit, i.offset])).rows;
      const items = [];
      for (const s of staff) {
        const x = await staffSuitability(c, i.id, s.user_id);
        const upcoming = x.cleared ? 0 : (await c.query("SELECT count(*)::int AS n FROM academy_session_staff st JOIN academy_sessions z ON z.id=st.session_id WHERE z.organisation_id=$1 AND st.user_id=$2 AND st.status IN ('assigned','confirmed') AND z.status IN ('draft','published') AND z.starts_at>now()", [i.id, s.user_id])).rows[0].n;
        items.push({ user_id: s.user_id, name: s.display_name, title: s.job_title ?? null, state: x.state, cleared: x.cleared, expiring: x.expiring, reasons: x.reasons, sessions_to_reassign: upcoming });
      }
      return { items, configured: items.length ? items.some((s) => s.state !== 'not_configured') : null };
    });
  },
});

cap({
  name: 'get_my_academy_safeguarding', method: 'GET', path: '/organisations/:id/academy/safeguarding/mine', tag: TAG,
  summary: 'For an athlete or a verified guardian: the academy\'s safe-communication boundaries (guardian copy, private channels, quiet hours), who the designated officers are for the athlete\'s campus, and how to raise a concern privately. Never shows whether a case exists.',
  input: z.object({ ...orgInput, athlete_id: id.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const athlete = i.athlete_id ?? user.id;
      if (athlete !== user.id && !(await guardianLink(user.id, athlete, c))) throw notFound('Athlete');
      if (!(await c.query('SELECT 1 FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.organisation_id=$1 AND e.user_id=$2', [i.id, athlete])).rowCount) throw notFound('Athlete');
      const p = await sgPolicy(c, i.id);
      const officers = (await c.query("SELECT u.display_name AS name, o.tier FROM academy_sg_officers o JOIN users u ON u.id=o.user_id WHERE o.organisation_id=$1 AND o.status='active' AND o.tier<=2 ORDER BY o.tier, u.display_name LIMIT 6", [i.id])).rows;
      return { athlete_id: athlete, is_young: await isYouth(athlete, c), boundaries: { guardian_copied: p.require_guardian_copy, private_channels_allowed: p.allow_private_channels, quiet_from: p.quiet_from, quiet_to: p.quiet_to }, officers };
    });
  },
});

cap({
  name: 'evaluate_academy_contact', method: 'POST', path: '/organisations/:id/academy/safeguarding/contact-check', tag: TAG,
  summary: 'Staff: ask whether a direct contact with an athlete is within the academy\'s safe-communication rules (guardian copy for under-18s, no private one-to-one channels unless allowed, quiet hours) before sending. Returns the rule outcomes; it does not send anything.',
  input: z.object({ ...orgInput, athlete_id: id, channel: z.enum(['academy_channel', 'private_message', 'phone_or_email']).default('academy_channel'), at: z.string().datetime().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = await opsAccess(user, i.id, { c });
      if (!a.has('attendance') && !a.has('roster') && !a.has('wellbeing') && !a.admin) throw forbidden('Staff only');
      const p = await sgPolicy(c, i.id), young = await isYouth(i.athlete_id, c);
      const t = i.at ? new Date(i.at) : new Date(), hm = `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
      const quiet = p.quiet_from && p.quiet_to && (p.quiet_from <= p.quiet_to ? hm >= p.quiet_from.slice(0, 5) && hm < p.quiet_to.slice(0, 5) : hm >= p.quiet_from.slice(0, 5) || hm < p.quiet_to.slice(0, 5));
      const checks = [
        { code: 'channel', ok: i.channel === 'academy_channel' || p.allow_private_channels || !young, message: i.channel === 'academy_channel' ? 'Academy channel' : 'Private one-to-one channels with under-18s are not allowed' },
        { code: 'guardian_copy', ok: true, required: young && p.require_guardian_copy, message: young && p.require_guardian_copy ? 'A verified guardian must be copied' : 'No guardian copy needed' },
        { code: 'quiet_hours', ok: !quiet, message: quiet ? 'Inside quiet hours (UTC)' : 'Outside quiet hours' },
      ];
      return { allowed: checks.every((x) => x.ok), is_young: young, checks };
    });
  },
});

cap({
  name: 'list_academy_sg_athletes', method: 'GET', path: '/organisations/:id/academy/safeguarding/athletes', tag: TAG,
  summary: 'Athletes a staff member may raise a concern about (enrolled in the academy), searchable by name. Names only. Needs attendance, roster or safeguarding access.',
  input: z.object({ ...orgInput, q: z.string().max(60).optional(), ...page }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = await opsAccess(user, i.id, { c });
      if (!a.admin && !a.has('attendance') && !a.has('roster') && !a.has('safeguarding')) throw forbidden('Staff only');
      return { items: (await c.query("SELECT DISTINCT u.id AS athlete_id, u.display_name FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id JOIN users u ON u.id=e.user_id WHERE k.organisation_id=$1 AND e.status IN ('enrolled','paused') AND ($2::text IS NULL OR u.display_name ILIKE '%'||$2||'%') ORDER BY u.display_name, u.id LIMIT $3 OFFSET $4", [i.id, i.q ?? null, i.limit, i.offset])).rows };
    });
  },
});
