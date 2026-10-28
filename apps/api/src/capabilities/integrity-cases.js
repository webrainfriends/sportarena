// Sport Integrity & Anti-Doping Administration (#489) 1/2: categories, authoritative sources, the case lifecycle, panel access, the subject's own view and
// operational reporting. Governed matters only: this never decides guilt, never interprets results, and never ranks or scores a person.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { encrypt, decrypt } from '../crypto.js';
import { audit } from '../helpers.js';
import { requireApproved } from '../access.js';
import { bodyById, lockBody, mustBeActive } from '../federation.js';
import { KINDS, KIND_LABEL, STATES, STATE_LABEL, FLOW, NOT_A_FINDING, REFERENCE_ONLY, today, addDays, officerOf, needOfficer, log, historyOf, caseFor, mayDecide, tell, nextCaseNo } from '../integrity.js';

const TAG = 'Sport integrity';
const SCOPE = 'admin'; // sensitive class: a narrow API token or agent token never reaches integrity matters
const text = (n) => z.string().trim().max(n);
const day = z.string().date();

const CASE_COLS = `k.id, k.body_id, k.case_no, k.category_id, c.kind AS category_kind, c.label AS category_label, c.state_labels, k.subject_id, su.display_name AS subject_name, k.sport_id, sp.name AS sport_name,
  k.status, k.response_due_on::text AS response_due_on, k.decision_due_on::text AS decision_due_on, k.source_label, k.notice_sent_at, k.row_version, k.created_at, k.closed_at,
  (k.status = 'response_due' AND k.response_due_on < current_date) AS response_overdue, (k.status IN ('under_review','response_due','decision_pending') AND k.decision_due_on < current_date) AS decision_overdue`;
const CASE_FROM = 'int_cases k JOIN int_categories c ON c.id=k.category_id JOIN users su ON su.id=k.subject_id LEFT JOIN sports sp ON sp.id=k.sport_id';
const label = (r) => ({ ...r, status_label: r.state_labels?.[r.status] ?? STATE_LABEL[r.status] });
const caseRow = async (cid, c = pool) => { const r = (await c.query(`SELECT ${CASE_COLS} FROM ${CASE_FROM} WHERE k.id=$1`, [cid])).rows[0]; return r ? label(r) : null; };

// ------------------------------------------------------------------ categories (the body's own governance: deadlines and state names)
cap({
  name: 'list_integrity_categories', method: 'GET', path: '/integrity/bodies/:id/categories', tag: TAG, scope: SCOPE,
  summary: 'The integrity matters a governing body handles, with each category\'s response and decision deadlines and the names the body gives each state (integrity officers).',
  input: z.object({ id }),
  async handler({ user }, i) {
    await needOfficer(user, i.id);
    return { kinds: KINDS.map((k) => ({ kind: k, label: KIND_LABEL[k] })), states: STATES.map((s) => ({ state: s, default_label: STATE_LABEL[s] })),
      items: await many("SELECT id, kind, label, response_days, decision_days, state_labels, policy_ref, status FROM int_categories WHERE body_id=$1 AND status='active' ORDER BY kind, label", [i.id]) };
  },
});
cap({
  name: 'save_integrity_category', method: 'POST', path: '/integrity/bodies/:id/categories', tag: TAG, scope: SCOPE, status: 201,
  summary: 'Define or change an integrity category for the body: its kind, the response and decision deadlines in days, the policy reference it follows and the names the body uses for each state. Safeguarding and harassment complaints are not integrity categories: they stay in the safeguarding case domain.',
  input: z.object({ id, category_id: id.optional(), kind: z.enum(KINDS), label: text(80).min(2), response_days: z.number().int().min(1).max(365).default(14), decision_days: z.number().int().min(1).max(730).default(30),
    state_labels: z.partialRecord(z.enum(STATES), text(40).min(2)).default({}), policy_ref: text(200).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    await needOfficer(user, i.id, { c });
    mustBeActive(await bodyById(i.id, c));
    if (/safeguard|harass|abuse/i.test(i.label)) throw badRequest('Safeguarding and harassment complaints belong in the safeguarding case domain, not here');
    let row;
    try {
      if (i.category_id) {
        row = (await c.query("UPDATE int_categories SET kind=$3, label=$4, response_days=$5, decision_days=$6, state_labels=$7, policy_ref=$8 WHERE id=$1 AND body_id=$2 AND status='active' RETURNING *",
          [i.category_id, i.id, i.kind, i.label, i.response_days, i.decision_days, JSON.stringify(i.state_labels), i.policy_ref ?? null])).rows[0];
        if (!row) throw notFound('Category');
      } else {
        row = (await c.query('INSERT INTO int_categories(body_id, kind, label, response_days, decision_days, state_labels, policy_ref, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
          [i.id, i.kind, i.label, i.response_days, i.decision_days, JSON.stringify(i.state_labels), i.policy_ref ?? null, user.id])).rows[0];
      }
    } catch (e) { if (e.code === '23505') throw conflict('The body already has a category with that name'); throw e; }
    await log(c, i.id, null, 'category', row.id, i.category_id ? 'changed' : 'created', { actor: user.id, detail: { kind: i.kind, label: i.label, response_days: i.response_days, decision_days: i.decision_days } });
    return row;
  }),
});

// ------------------------------------------------------------------ sources
cap({
  name: 'list_integrity_sources', method: 'GET', path: '/integrity/bodies/:id/sources', tag: TAG, scope: SCOPE,
  summary: 'The sources the body treats as authoritative or as reference. Manual entry is always its own unverified source. No external anti-doping integration is connected: the signed feed depends on the data-exchange layer and an agreement with the authority.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await needOfficer(user, i.id);
    return { integration_note: 'Automatic ingestion from an anti-doping organisation is blocked until a supported API, credentials and a governance agreement exist. Entries made here stay unverified until a second officer reviews them.',
      items: await many("SELECT id, name, designation, integration, note, status, created_at FROM int_sources WHERE body_id=$1 AND status='active' ORDER BY designation, name", [i.id]) };
  },
});
cap({
  name: 'save_integrity_source', method: 'POST', path: '/integrity/bodies/:id/sources', tag: TAG, scope: SCOPE, status: 201,
  summary: 'Name a source of testing or exemption references and designate it authoritative, a verified reference or manual. The designation is explicit and recorded; it does not by itself make an entered record verified.',
  input: z.object({ id, name: text(120).min(2), designation: z.enum(['authoritative', 'verified_reference', 'manual']), note: text(500).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    await needOfficer(user, i.id, { c });
    mustBeActive(await bodyById(i.id, c));
    let row;
    try {
      row = (await c.query('INSERT INTO int_sources(body_id, name, designation, integration, note, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
        [i.id, i.name, i.designation, i.designation === 'manual' ? 'none' : 'blocked_awaiting_credentials', i.note ?? null, user.id])).rows[0];
    } catch (e) { if (e.code === '23505') throw conflict('A source with that name already exists'); throw e; }
    await log(c, i.id, null, 'source', row.id, 'designated', { actor: user.id, detail: { designation: i.designation } });
    return row;
  }),
});

// ------------------------------------------------------------------ cases
cap({
  name: 'open_integrity_case', method: 'POST', path: '/integrity/bodies/:id/cases', tag: TAG, scope: SCOPE, status: 201,
  summary: 'Record a referral or administrative reference as an integrity case for one person (integrity officers). It starts as "Referral received": an allegation is never presented as a finding. The subject is told only that there is a matter to open; the notice carries no details. The deadlines come from the category.',
  input: z.object({ id, category_id: id, subject_id: id, sport_id: id.optional(), summary: text(2000).min(5), source_label: text(200).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    requireApproved(user);
    await needOfficer(user, i.id, { c });
    await lockBody(c, i.id);
    mustBeActive(await bodyById(i.id, c));
    const cat = (await c.query("SELECT * FROM int_categories WHERE id=$1 AND body_id=$2 AND status='active'", [i.category_id, i.id])).rows[0];
    if (!cat) throw notFound('Category');
    if (!(await c.query('SELECT 1 FROM users WHERE id=$1', [i.subject_id])).rowCount) throw notFound('Person');
    if (i.sport_id && !(await c.query('SELECT 1 FROM governing_body_sports WHERE body_id=$1 AND sport_id=$2 AND ended_on IS NULL', [i.id, i.sport_id])).rowCount) throw badRequest('This body does not govern that sport');
    const no = await nextCaseNo(c, i.id);
    const row = (await c.query(
      `INSERT INTO int_cases(body_id, category_id, case_no, subject_id, sport_id, summary_enc, source_label, decision_due_on, opened_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [i.id, i.category_id, no, i.subject_id, i.sport_id ?? null, encrypt(i.summary, 'int_cases.summary'), i.source_label ?? null, addDays(today(), cat.decision_days), user.id])).rows[0];
    await log(c, i.id, row.id, 'case', row.id, 'opened', { to: 'received', actor: user.id });
    await tell(c, row.subject_id, row);
    await audit(c, user.id, 'integrity_case_opened', 'int_cases', row.id);
    return caseRow(row.id, c);
  }),
});

cap({
  name: 'list_integrity_cases', method: 'GET', path: '/integrity/bodies/:id/cases', tag: TAG, scope: SCOPE,
  summary: 'The body\'s integrity cases (officers), or only the cases a panel member has been given access to. Filter by status, category, overdue steps or text (case number or person).',
  input: z.object({ id, status: z.enum(STATES).optional(), category_id: id.optional(), overdue: z.coerce.boolean().optional(), q: text(80).optional(), ...page }),
  async handler({ user }, i) {
    const officer = await officerOf(user, i.id);
    const where = `k.body_id=$1 AND ($2::text IS NULL OR k.status=$2) AND ($3::uuid IS NULL OR k.category_id=$3) AND ($4::boolean IS NULL OR $4 = ((k.status='response_due' AND k.response_due_on < current_date) OR (k.status IN ('under_review','response_due','decision_pending') AND k.decision_due_on < current_date)))
      AND ($5::text IS NULL OR k.case_no ILIKE '%'||$5||'%' OR su.display_name ILIKE '%'||$5||'%') AND ($6::boolean OR EXISTS (SELECT 1 FROM int_case_access a WHERE a.case_id=k.id AND a.user_id=$7 AND a.revoked_at IS NULL))`;
    const a = [i.id, i.status ?? null, i.category_id ?? null, i.overdue ?? null, i.q || null, !!officer, user.id];
    if (!officer && !(await one('SELECT 1 FROM int_case_access a JOIN int_cases k ON k.id=a.case_id WHERE k.body_id=$1 AND a.user_id=$2 AND a.revoked_at IS NULL LIMIT 1', [i.id, user.id]))) throw notFound('Governing body');
    const total = await one(`SELECT count(*)::int AS n FROM ${CASE_FROM} WHERE ${where}`, a);
    const items = await many(`SELECT ${CASE_COLS} FROM ${CASE_FROM} WHERE ${where} ORDER BY (k.status IN ('received','under_review','response_due','decision_pending')) DESC, k.created_at DESC, k.id LIMIT $8 OFFSET $9`, [...a, i.limit, i.offset]);
    return { total: total.n, items: items.map(label), notice: NOT_A_FINDING };
  },
});

async function caseDetail(s, user, c = pool) {
  const k = s.row, row = await caseRow(k.id, c);
  const subjectView = s.as === 'subject';
  const decisions = (await c.query(
    `SELECT d.id, d.seq, d.kind, d.made_by, d.authority_label, d.outcome, d.effective_from::text AS effective_from, d.effective_to::text AS effective_to, d.scope_note, d.sporting_sanction, d.handoff_status, d.supersedes_id, d.superseded_at, d.created_at,
            d.decision_ref_enc, d.outcome_text_enc FROM int_decisions d WHERE d.case_id=$1 ORDER BY d.seq`, [k.id])).rows;
  const appeals = (await c.query('SELECT id, decision_id, status, panel_label, created_at, decided_at, grounds_enc, lodged_by FROM int_appeals WHERE case_id=$1 ORDER BY created_at', [k.id])).rows;
  await audit(c, user.id, subjectView ? 'integrity_case_read_by_subject' : 'integrity_case_read', 'int_cases', k.id);
  const out = {
    ...row, as: s.as, notice: NOT_A_FINDING,
    summary: subjectView ? null : decrypt(k.summary_enc, 'int_cases.summary'),
    decisions: decisions.map(({ decision_ref_enc, outcome_text_enc, ...d }) => ({ ...d, current: !d.superseded_at, decision_ref: decrypt(decision_ref_enc, 'int_decisions.ref'), outcome_text: outcome_text_enc ? decrypt(outcome_text_enc, 'int_decisions.outcome') : null })),
    appeals: appeals.map(({ grounds_enc, ...a }) => ({ ...a, grounds: decrypt(grounds_enc, 'int_appeals.grounds') })),
    messages: (await c.query("SELECT m.id, m.kind, m.body_enc, m.created_at, u.display_name AS author_name, (m.author_id=$2) AS mine FROM int_case_messages m JOIN users u ON u.id=m.author_id WHERE m.case_id=$1 ORDER BY m.created_at", [k.id, user.id])).rows
      .map(({ body_enc, ...m }) => ({ ...m, body: decrypt(body_enc, 'int_case_messages.body') })),
    history: (await historyOf(k.id, c)).filter((h) => !subjectView || ['case', 'decision', 'appeal'].includes(h.subject_type)).map((h) => ({ ...h, detail: subjectView ? {} : h.detail })),
    actions: s.as === 'officer' ? Object.entries(FLOW).filter(([, f]) => f.from.includes(k.status)).map(([a]) => a).concat(k.status === 'suspended' || k.status === 'deferred' ? ['resume'] : []) : [],
    can: { decide: mayDecide(s), respond: subjectView && !['closed', 'withdrawn'].includes(k.status), appeal: subjectView && decisions.some((d) => !d.superseded_at && d.outcome === 'finding_recorded'), manage_access: s.as === 'officer' },
  };
  if (!subjectView) out.access = (await c.query('SELECT a.id, a.user_id, u.display_name, a.role, a.granted_at FROM int_case_access a JOIN users u ON u.id=a.user_id WHERE a.case_id=$1 AND a.revoked_at IS NULL ORDER BY a.granted_at', [k.id])).rows;
  return out;
}
cap({
  name: 'get_integrity_case', method: 'GET', path: '/integrity/cases/:id', tag: TAG, scope: SCOPE,
  summary: 'One integrity case. Officers and panel members see the full record, decrypted and audit-logged. The subject (or a youth\'s verified guardian) sees status, deadlines, decisions as recorded, their own responses and appeal options, never internal notes or other parties\' references.',
  input: z.object({ id }),
  async handler({ user }, i) { return caseDetail(await caseFor(user, i.id), user); },
});

cap({
  name: 'transition_integrity_case', method: 'POST', path: '/integrity/cases/:id/transition', tag: TAG, scope: SCOPE,
  summary: 'Move a case through its lifecycle (integrity officers): start_review, request_response (sets the response deadline from the category, or the date you give, and notifies the subject), move_to_decision, suspend, defer, resume, withdraw, close. A decision itself is recorded with record_integrity_decision. Pass `version` to refuse a change on a case that moved meanwhile.',
  input: z.object({ id, action: z.enum([...Object.keys(FLOW), 'resume']), reason: text(500).optional(), response_due_on: day.optional(), version: z.number().int().min(1).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = await caseFor(user, i.id, { c, lock: true });
    if (s.as !== 'officer') throw forbidden('Only an integrity officer can move a case');
    const k = s.row;
    if (i.version && i.version !== k.row_version) throw conflict('This case changed since you opened it; reload and try again', { code: 'stale_version' });
    let to, patch = {};
    if (i.action === 'resume') {
      if (!['suspended', 'deferred'].includes(k.status)) throw conflict(`A ${k.status} case cannot be resumed`);
      to = k.prior_status ?? 'under_review';
    } else {
      const f = FLOW[i.action];
      if (!f.from.includes(k.status)) throw conflict(`You cannot ${i.action.replace(/_/g, ' ')} a case that is ${k.status.replace(/_/g, ' ')}`);
      to = f.to;
    }
    if (['suspend', 'defer', 'withdraw'].includes(i.action) && !i.reason?.trim()) throw badRequest('Give a reason; it is kept in the history');
    if (i.action === 'request_response') {
      const cat = (await c.query('SELECT response_days FROM int_categories WHERE id=$1', [k.category_id])).rows[0];
      const due = i.response_due_on ?? addDays(today(), cat.response_days);
      if (due < today()) throw badRequest('The response date is in the past');
      patch = { response_due_on: due, notice_sent_at: new Date() };
    }
    if (to === 'closed' || to === 'withdrawn') patch.closed_at = new Date();
    if (['suspended', 'deferred'].includes(to)) patch.prior_status = k.status;
    const keys = Object.keys(patch);
    await c.query(`UPDATE int_cases SET status=$2, row_version=row_version+1, updated_at=now()${keys.map((x, n) => `, ${x}=$${n + 3}`).join('')} WHERE id=$1`, [k.id, to, ...keys.map((x) => patch[x])]);
    await log(c, k.body_id, k.id, 'case', k.id, i.action, { from: k.status, to, actor: user.id, reason: i.reason, detail: patch.response_due_on ? { response_due_on: patch.response_due_on } : {} });
    if (['request_response', 'move_to_decision', 'suspend', 'defer', 'resume', 'withdraw', 'close'].includes(i.action)) await tell(c, k.subject_id, { ...k, row_version: k.row_version + 1 });
    await audit(c, user.id, `integrity_case_${i.action}`, 'int_cases', k.id);
    return caseRow(k.id, c);
  }),
});

cap({
  name: 'respond_to_integrity_case', method: 'POST', path: '/integrity/cases/:id/response', tag: TAG, scope: SCOPE, status: 201,
  summary: 'The subject (or a youth\'s verified guardian) answers a case: a written response, kept encrypted and visible to the officers and panel only. Allowed until the case is closed or withdrawn.',
  input: z.object({ id, body: text(4000).min(2) }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = await caseFor(user, i.id, { c, lock: true });
    if (s.as !== 'subject') throw forbidden('Only the person concerned, or their guardian, responds');
    if (['closed', 'withdrawn'].includes(s.row.status)) throw conflict('This case is no longer open');
    const m = (await c.query("INSERT INTO int_case_messages(case_id, author_id, kind, body_enc) VALUES ($1,$2,'response',$3) RETURNING id, created_at", [s.row.id, user.id, encrypt(i.body, 'int_case_messages.body')])).rows[0];
    await log(c, s.row.body_id, s.row.id, 'case', s.row.id, 'response_received', { actor: user.id });
    return m;
  }),
});

// ------------------------------------------------------------------ need-to-know access for one case
cap({
  name: 'grant_integrity_case_access', method: 'POST', path: '/integrity/cases/:id/access', tag: TAG, scope: SCOPE, status: 201,
  summary: 'Give a panel member (can read and record decisions) or a reviewer (read only) access to this ONE case (integrity officers). Revocable at any time; access never extends to other cases. The person concerned cannot be on their own panel.',
  input: z.object({ id, user_id: id, role: z.enum(['panel', 'reviewer']) }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = await caseFor(user, i.id, { c, lock: true });
    if (s.as !== 'officer') throw forbidden('Only an integrity officer can grant access');
    if (i.user_id === s.row.subject_id) throw badRequest('The person concerned cannot sit on their own case');
    if (!(await c.query('SELECT 1 FROM users WHERE id=$1', [i.user_id])).rowCount) throw notFound('Person');
    try { await c.query('INSERT INTO int_case_access(case_id, user_id, role, granted_by) VALUES ($1,$2,$3,$4)', [s.row.id, i.user_id, i.role, user.id]); }
    catch (e) { if (e.code === '23505') throw conflict('That person already has access to this case'); throw e; }
    await log(c, s.row.body_id, s.row.id, 'case', s.row.id, 'access_granted', { actor: user.id, detail: { role: i.role } });
    await audit(c, user.id, 'integrity_access_granted', 'int_cases', s.row.id);
    return { ok: true };
  }),
});
cap({
  name: 'revoke_integrity_case_access', method: 'DELETE', path: '/integrity/cases/:id/access/:access_id', tag: TAG, scope: SCOPE,
  summary: 'Take case access away at once (integrity officers). The grant stays in the history.',
  input: z.object({ id, access_id: id }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = await caseFor(user, i.id, { c, lock: true });
    if (s.as !== 'officer') throw forbidden('Only an integrity officer can revoke access');
    const r = await c.query('UPDATE int_case_access SET revoked_at=now(), revoked_by=$3 WHERE id=$1 AND case_id=$2 AND revoked_at IS NULL', [i.access_id, s.row.id, user.id]);
    if (!r.rowCount) throw notFound('Access');
    await log(c, s.row.body_id, s.row.id, 'case', s.row.id, 'access_revoked', { actor: user.id });
    await audit(c, user.id, 'integrity_access_revoked', 'int_cases', s.row.id);
    return { ok: true };
  }),
});

// ------------------------------------------------------------------ the person's own view
cap({
  name: 'get_my_integrity', method: 'GET', path: '/me/integrity', tag: TAG, scope: SCOPE,
  summary: 'What the signed-in person (or, with `child_id`, their verified ward) can see about themselves: matters opened about them with plain status and deadlines, exemption status as the authority supplied it, education requirements and declarations. Nothing about anyone else.',
  input: z.object({ child_id: id.optional() }),
  async handler({ user }, i) {
    let subject = user.id;
    if (i.child_id) { const { isGuardianOf } = await import('../federation.js'); if (!(await isGuardianOf(user.id, i.child_id))) throw notFound('Person'); subject = i.child_id; }
    const cases = await many(`SELECT ${CASE_COLS} FROM ${CASE_FROM} WHERE k.subject_id=$1 ORDER BY k.created_at DESC`, [subject]);
    const exemptions = await many(
      `SELECT x.id, bo.name AS body_name, x.issuing_authority, x.external_status, x.valid_from::text AS valid_from, x.valid_until::text AS valid_until, x.scope_note, x.last_verified_at, x.verification
         FROM int_exemptions x JOIN governing_bodies b ON b.id=x.body_id JOIN organisations bo ON bo.id=b.organisation_id WHERE x.subject_id=$1 AND x.superseded_at IS NULL AND x.tombstoned_at IS NULL ORDER BY x.created_at DESC`, [subject]);
    const education = await many(
      `SELECT r.id, e.title, r.version, r.status, r.completed_on::text AS completed_on, r.expires_on::text AS expires_on, (r.expires_on < current_date) AS expired, bo.name AS body_name
         FROM int_education_records r JOIN int_education_requirements e ON e.id=r.requirement_id JOIN governing_bodies b ON b.id=r.body_id JOIN organisations bo ON bo.id=b.organisation_id WHERE r.user_id=$1 ORDER BY r.created_at DESC`, [subject]);
    const declarations = await many(
      `SELECT d.id, bo.name AS body_name, d.kind, d.purpose, d.retain_until::text AS retain_until, d.status, d.created_at FROM int_declarations d JOIN governing_bodies b ON b.id=d.body_id JOIN organisations bo ON bo.id=b.organisation_id WHERE d.user_id=$1 ORDER BY d.created_at DESC`, [subject]);
    if (cases.length || exemptions.length) await audit(null, user.id, 'integrity_self_view', 'users', subject);
    return { notice: NOT_A_FINDING, cases: cases.map(label), exemptions, education, declarations };
  },
});

// ------------------------------------------------------------------ operational reporting: counts of work, never a person
cap({
  name: 'get_integrity_report', method: 'GET', path: '/integrity/bodies/:id/report', tag: TAG, scope: SCOPE,
  summary: 'Operational metrics for integrity staff: open cases by status and category, overdue responses and decisions, references awaiting a second review, sanction handoff state and education completion. Counts of work only: no ranking of people, no risk scores.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await needOfficer(user, i.id);
    const b = i.id;
    const [byStatus, byCategory, overdue, unreviewed, handoff, edu, appeals] = await Promise.all([
      many('SELECT status, count(*)::int AS n FROM int_cases WHERE body_id=$1 GROUP BY status', [b]),
      many('SELECT c.id, c.label, c.kind, count(k.id) FILTER (WHERE k.status IN (\'received\',\'under_review\',\'response_due\',\'decision_pending\'))::int AS open FROM int_categories c LEFT JOIN int_cases k ON k.category_id=c.id WHERE c.body_id=$1 AND c.status=\'active\' GROUP BY c.id ORDER BY c.label', [b]),
      one("SELECT count(*) FILTER (WHERE status='response_due' AND response_due_on < current_date)::int AS responses, count(*) FILTER (WHERE status IN ('under_review','response_due','decision_pending') AND decision_due_on < current_date)::int AS decisions FROM int_cases WHERE body_id=$1", [b]),
      one("SELECT (SELECT count(*) FROM int_test_refs WHERE body_id=$1 AND superseded_at IS NULL AND tombstoned_at IS NULL AND verification='unverified')::int AS test_refs, (SELECT count(*) FROM int_exemptions WHERE body_id=$1 AND superseded_at IS NULL AND tombstoned_at IS NULL AND verification='unverified')::int AS exemptions", [b]),
      many("SELECT handoff_status AS status, count(*)::int AS n FROM int_decisions WHERE body_id=$1 AND sporting_sanction AND superseded_at IS NULL GROUP BY 1", [b]),
      one("SELECT count(*)::int AS assigned, count(*) FILTER (WHERE status='completed' AND (expires_on IS NULL OR expires_on >= current_date))::int AS current, count(*) FILTER (WHERE status='completed' AND expires_on < current_date)::int AS expired FROM int_education_records WHERE body_id=$1", [b]),
      one("SELECT count(*) FILTER (WHERE status IN ('lodged','under_review'))::int AS open FROM int_appeals WHERE body_id=$1", [b]),
    ]);
    return { by_status: byStatus, by_category: byCategory, overdue, awaiting_second_review: unreviewed, sanction_handoff: handoff, education: edu, appeals_open: appeals.open,
      sync_failures: 0, sync_note: 'No external feed is connected, so there are no sync failures to report. Connector health will appear here once the data-exchange layer has a supported integration.',
      reference_only: REFERENCE_ONLY };
  },
});
