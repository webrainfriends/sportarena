import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// #784 Academy safeguarding & welfare case orchestration: happy paths and every refusal the acceptance criteria name.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { addDays } = await import('../src/booking/time.js');
const { mintToken } = await import('../src/access-layer.js');
const { sweepSafeguardingCases } = await import('../src/safeguarding.js');
const { tx } = await import('../src/db.js');
const { capabilities } = await import('../src/capabilities/index.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const signup = async (roles = ['athlete'], extra = {}) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `sg_${n}_${roles[0]}`, display_name: `Sg ${n}`, email: `sg${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const today = new Date().toISOString().slice(0, 10);
const dow = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
const key = () => `k-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const isoDow = () => ((new Date().getUTCDay() + 6) % 7) + 1;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('sg_root','sg_root','{admin}','x','x','sg_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

async function guardianOf(child) {
  const parent = await signup(['athlete'], { dob: yearsAgo(40) });
  const l = ok(await api('POST', '/youth/guardian-links', { token: parent.token, body: { guardian_id: parent.id, child_id: child.id, relationship: 'parent' } }), 201);
  ok(await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: child.token, body: { accept: true } }));
  ok(await api('POST', `/youth/guardian-links/${l.id}/evidence`, { token: parent.token, body: { evidence: { reference: 'https://example.com/birth-certificate-ref-123', label: 'Birth certificate' } } }), 201);
  ok(await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Documents match' } }));
  ok(await api('POST', `/youth/children/${child.id}/consents`, { token: parent.token, body: { purpose: 'participation' } }), 201);
  parent.linkId = l.id;
  return parent;
}
/** An academy with one cohort, `youth` young athletes each with a verified guardian, a coach, an officer with the safeguarding permission. */
async function academy({ youth = 1 } = {}) {
  const owner = await signup(), coach = await signup(['coach']), officer = await signup(), stranger = await signup();
  const org = ok(await api('POST', '/organisations', { token: owner.token, body: { name: `Safeguarding ${n}`, kind: 'academy' } }), 201);
  for (const [u, role] of [[coach, 'coach'], [officer, 'staff']]) {
    ok(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role } }), 201);
    ok(await api('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } }));
  }
  ok(await api('POST', `/organisations/${org.id}/academy/staff/${officer.id}`, { token: owner.token, body: { job_title: 'Safeguarding lead', template: 'safeguarding' } }));
  const cohort = ok(await api('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: 'U12', coach_id: coach.id } }), 201);
  const kids = [], parents = [];
  for (let k = 0; k < youth; k++) { const kid = await signup(['athlete'], { dob: yearsAgo(11) }); kids.push(kid); parents.push(await guardianOf(kid)); }
  ok(await api('POST', `/cohorts/${cohort.id}/enrolments`, { token: owner.token, body: { csv: `handle,consent\n${kids.map((p) => `${p.handle},yes`).join('\n')}` } }), 201);
  return { owner, coach, officer, stranger, org, cohort, kids, parents };
}

const base_ = (a) => `/organisations/${a.org.id}/academy/safeguarding`;
const designate = (a, user, body = {}) => api('POST', `${base_(a)}/officers`, { token: a.owner.token, body: { user_id: user.id, ...body } });
/** an academy where `officer` (staff, safeguarding template) is a designated tier-1 officer and `lead` a tier-2 officer */
async function desk() {
  const a = await academy();
  const lead = await signup(['coach']);
  ok(await api('POST', `/organisations/${a.org.id}/members`, { token: a.owner.token, body: { person: lead.handle, role: 'staff' } }), 201);
  ok(await api('POST', `/organisations/${a.org.id}/invite/respond`, { token: lead.token, body: { accept: true } }));
  ok(await designate(a, a.officer, { tier: 1 }), 201);
  ok(await designate(a, lead, { tier: 2 }), 201);
  a.lead = lead;
  return a;
}
const raise = (a, token, body = {}) => api('POST', `${base_(a)}/cases`, { token, body: { athlete_id: a.kids[0].id, category: 'welfare', risk: 'medium', summary: 'Athlete seemed withdrawn and mentioned something at home.', ...body } });
const caseByNo = async (no) => (await pool.query('SELECT * FROM academy_sg_cases WHERE case_no=$1', [no])).rows[0];

test('intake: the reporter gets a receipt only; the case is routed to the campus officer, never the reporter, and nobody else can read it', async () => {
  const a = await desk();
  const r = ok(await raise(a, a.coach.token), 201);
  assert.deepEqual([r.status, /^SG-\d{4}-\d{4}$/.test(r.case_no)], ['received', true]);
  assert.deepEqual(Object.keys(r).sort(), ['case_no', 'replayed', 'status']);
  const k = await caseByNo(r.case_no);
  assert.equal(k.assignee_id, a.officer.id);
  assert.ok(!k.summary_enc.includes('withdrawn'), 'summary is encrypted');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM academy_safety_events WHERE id=$1', [k.event_id])).rows[0].n, 1, 'opened from a safety event, not a parallel store');
  // ordinary staff (the reporter), the owner (not designated), a stranger and the family get 404 - existence is not leaked
  for (const who of [a.coach, a.owner, a.stranger, a.parents[0], a.kids[0]]) assert.equal((await api('GET', `/academy/safeguarding/cases/${k.id}`, { token: who.token })).status, 404);
  for (const who of [a.coach, a.owner, a.stranger]) assert.equal((await api('GET', `${base_(a)}/cases`, { token: who.token })).status, 404);
  const full = ok(await api('GET', `/academy/safeguarding/cases/${k.id}`, { token: a.officer.token }));
  assert.match(full.summary, /withdrawn/);
  assert.ok(full.log.some((l) => l.kind === 'read'), 'the read is in the case log');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='read_academy_sg_case' AND entity_id=$1", [k.id])).rows[0].n, 1);
  const list = ok(await api('GET', `${base_(a)}/cases`, { token: a.officer.token }));
  assert.equal(list.items.length, 1);
  assert.equal(JSON.stringify(list).includes('withdrawn'), false, 'the list carries no narrative');
});

test('intake: an athlete or verified guardian may raise a concern, retries are idempotent, outsiders get 404', async () => {
  const a = await desk(); const key1 = key();
  const mum = ok(await raise(a, a.parents[0].token, { idempotency_key: key1 }), 201), again = ok(await raise(a, a.parents[0].token, { idempotency_key: key1 }), 201);
  assert.equal(again.case_no, mum.case_no); assert.equal(again.replayed, true);
  ok(await raise(a, a.kids[0].token), 201);
  assert.equal((await raise(a, a.stranger.token)).status, 404);
  assert.equal((await raise(a, a.coach.token, { athlete_id: a.stranger.id })).status, 404, 'an athlete who is not in the academy');
  assert.equal((await raise(a, a.coach.token, { summary: 'x' })).status, 400);
});

test('separation of duty: the person the concern is about never sees or receives it', async () => {
  const a = await desk();
  const r = ok(await raise(a, a.coach.token, { conflicted_user_id: a.officer.id, category: 'conduct' }), 201);
  const k = await caseByNo(r.case_no);
  assert.equal(k.assignee_id, a.lead.id, 'skipped the conflicted tier-1 officer and went up the ladder');
  assert.equal((await api('GET', `/academy/safeguarding/cases/${k.id}`, { token: a.officer.token })).status, 404);
  assert.equal(ok(await api('GET', `${base_(a)}/cases`, { token: a.officer.token })).items.length, 0);
  const a2 = ok(await api('PATCH', `/academy/safeguarding/cases/${k.id}`, { token: a.lead.token, body: { action: 'assign', assignee_id: a.officer.id, row_version: k.row_version } }).then((x) => ({ status: x.status === 409 ? 200 : x.status, body: x.body })));
  assert.equal(a2.code ?? 'conflict_of_interest', 'conflict_of_interest');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind='academy_sg_case'", [a.officer.id])).rows[0].n, 0);
});

test('workflow: acknowledge, classify, assign, action, evidence, human reporting decision, close; every step is in the append-only log', async () => {
  const a = await desk();
  ok(await api('POST', `${base_(a)}/report-rules`, { token: a.owner.token, body: { jurisdiction: 'IN', incident_type: 'welfare', authority_label: 'Child welfare committee', notify_within_hours: 24, guidance: 'Consider the statutory duty.' } }), 201);
  const r = ok(await raise(a, a.coach.token, { jurisdiction: 'IN-KA' }), 201); let k = await caseByNo(r.case_no);
  assert.equal(k.reporting_state, 'needs_human_review');
  const patch = (b) => api('PATCH', `/academy/safeguarding/cases/${k.id}`, { token: a.officer.token, body: { row_version: k.row_version, ...b } });
  const upd = async (b) => { const res = ok(await patch(b)); k = await caseByNo(r.case_no); return res; };
  assert.equal((await patch({ action: 'close', outcome: 'Dealt with.', close_reason: 'resolved' })).status, 409, 'must acknowledge first');
  await upd({ action: 'acknowledge' });
  const stale = await api('PATCH', `/academy/safeguarding/cases/${k.id}`, { token: a.officer.token, body: { action: 'advance', status: 'action', row_version: 1 } });
  assert.equal(stale.status, 409);
  await upd({ action: 'reclassify', risk: 'high' }); assert.equal(k.risk, 'high');
  ok(await api('POST', `/academy/safeguarding/cases/${k.id}/actions`, { token: a.officer.token, body: { kind: 'guardian_contact', note: 'Call the guardian with approved wording.' } }), 201);
  ok(await api('POST', `/academy/safeguarding/cases/${k.id}/evidence`, { token: a.officer.token, body: { kind: 'link', label: 'Incident form', url: 'https://example.com/form/1' } }), 201);
  assert.equal((await api('POST', `/academy/safeguarding/cases/${k.id}/evidence`, { token: a.officer.token, body: { kind: 'link', label: 'x1', url: 'http://example.com/a' } })).status, 400, 'https only');
  const blocked = await patch({ action: 'close', outcome: 'Dealt with and monitored.', close_reason: 'resolved' });
  assert.equal(blocked.status, 409); assert.ok(JSON.stringify(blocked.body).includes('report_decision_required'), JSON.stringify(blocked.body));
  const full = ok(await api('GET', `/academy/safeguarding/cases/${k.id}`, { token: a.officer.token }));
  assert.equal(full.report_rules[0].authority_label, 'Child welfare committee');
  assert.equal((await api('POST', `/academy/safeguarding/cases/${k.id}/report-decision`, { token: a.officer.token, body: { decision: 'not_required', rationale: 'short' } })).status, 400, 'a rationale is required');
  ok(await api('POST', `/academy/safeguarding/cases/${k.id}/report-decision`, { token: a.officer.token, body: { rule_id: full.report_rules[0].id, decision: 'not_required', rationale: 'Assessed against the duty; threshold not met.' } }), 201);
  k = await caseByNo(r.case_no);
  const closed = ok(await patch({ action: 'close', outcome: 'Dealt with and monitored.', close_reason: 'resolved' }));
  assert.equal(closed.status, 'closed');
  k = await caseByNo(r.case_no);
  assert.ok(k.retention_until, 'retention date is set from the policy');
  assert.equal((await api('POST', `/academy/safeguarding/cases/${k.id}/actions`, { token: a.officer.token, body: { kind: 'monitoring' } })).status, 409, 'closed cases take no new actions');
  const log = (await pool.query('SELECT kind FROM academy_sg_case_log WHERE case_id=$1 ORDER BY id', [k.id])).rows.map((x) => x.kind);
  for (const w of ['opened', 'assigned', 'acknowledged', 'reclassified', 'action_added', 'evidence_added', 'report_decision', 'closed']) assert.ok(log.includes(w), w);
  await assert.rejects(pool.query('UPDATE academy_sg_case_log SET kind=$2 WHERE case_id=$1', [k.id, 'x']), /append-only/);
  await assert.rejects(pool.query('DELETE FROM academy_sg_case_log WHERE case_id=$1', [k.id]), /append-only/);
});

test('escalation: manual and overdue cases rise the ladder to the lead officer; the sweep is idempotent', async () => {
  const a = await desk();
  const r = ok(await raise(a, a.coach.token), 201); let k = await caseByNo(r.case_no);
  const up = ok(await api('PATCH', `/academy/safeguarding/cases/${k.id}`, { token: a.officer.token, body: { action: 'escalate', row_version: k.row_version } }));
  assert.equal(up.tier, 2); assert.equal(up.assignee_id, a.lead.id);
  const r2 = ok(await raise(a, a.coach.token, { risk: 'low' }), 201); k = await caseByNo(r2.case_no);
  await pool.query("UPDATE academy_sg_cases SET ack_due_at=now()-interval '1 hour' WHERE id=$1", [k.id]);
  assert.ok(ok(await api('GET', `${base_(a)}/cases`, { token: a.officer.token })).items.find((x) => x.case_no === r2.case_no).overdue);
  const n1 = await tx((c) => sweepSafeguardingCases(c)); assert.ok(n1 >= 1);
  assert.equal((await caseByNo(r2.case_no)).tier, 2);
  assert.equal(await tx((c) => sweepSafeguardingCases(c)), 0, 'the deadline moved on: a second run does nothing');
});

test('officers: only owners/admins designate; ended designations lose access at once and are kept; the last officer is protected', async () => {
  const a = await desk();
  assert.equal((await api('POST', `${base_(a)}/officers`, { token: a.coach.token, body: { user_id: a.coach.id } })).status, 403);
  assert.equal((await designate(a, a.stranger)).status, 404, 'not a member');
  assert.equal((await designate(a, a.officer)).status, 409, 'already designated');
  const r = ok(await raise(a, a.coach.token), 201); const k = await caseByNo(r.case_no);
  const off = (await pool.query("SELECT id FROM academy_sg_officers WHERE user_id=$1", [a.officer.id])).rows[0].id;
  const end = ok(await api('POST', `/academy/safeguarding/officers/${off}/end`, { token: a.owner.token, body: { reason: 'Left the role' } }));
  assert.equal(end.cases_unassigned, 1);
  assert.equal((await api('GET', `/academy/safeguarding/cases/${k.id}`, { token: a.officer.token })).status, 404);
  assert.equal((await pool.query('SELECT status FROM academy_sg_officers WHERE id=$1', [off])).rows[0].status, 'ended', 'kept as history');
  const last = (await pool.query("SELECT id FROM academy_sg_officers WHERE user_id=$1 AND status='active'", [a.lead.id])).rows[0].id;
  assert.equal((await api('POST', `/academy/safeguarding/officers/${last}/end`, { token: a.owner.token, body: { reason: 'No longer needed' } })).status, 409);
  const list = ok(await api('GET', `${base_(a)}/officers`, { token: a.owner.token }));
  assert.equal(list.items.length, 1);
});

test('suitability: unmet eligibility blocks new session assignments and officer designation; meeting it clears both; nothing is copied', async () => {
  const a = await desk(); const sid = await (async () => {
    const start = addDays(today, 3);
    const made = ok(await api('POST', `/cohorts/${a.cohort.id}/academy/timetable`, { token: a.owner.token, body: { idempotency_key: key(), starts_on: start, ends_on: start, weekdays: [dow(start)], start_time: '17:00', duration_min: 60, timezone: 'UTC', lead_id: a.coach.id } }), 201);
    return made.created[0].id;
  })();
  const newCoach = await signup(['coach']);
  ok(await api('POST', `/organisations/${a.org.id}/members`, { token: a.owner.token, body: { person: newCoach.handle, role: 'coach' } }), 201);
  ok(await api('POST', `/organisations/${a.org.id}/invite/respond`, { token: newCoach.token, body: { accept: true } }));
  ok(await api('POST', `/academy/sessions/${sid}/staff`, { token: a.owner.token, body: { user_id: newCoach.id, role: 'assistant' } }), 201);   // no obligation configured: as before
  const req = ok(await api('POST', '/compliance/requirements', { token: a.owner.token, body: { scope_kind: 'organisation', scope_id: a.org.id, name: 'Safeguarding briefing', category: 'attestation', method: 'declaration', statement: 'I have completed the safeguarding briefing.' } }), 201);
  ok(await api('POST', `/compliance/requirements/${req.id}/obligations`, { token: a.owner.token, body: { roles: ['coach'], consequences: ['youth_access'] } }), 201);
  const blocked = await api('POST', `/academy/sessions/${sid}/staff`, { token: a.owner.token, body: { user_id: a.coach.id, role: 'assistant' } });
  assert.equal(blocked.status, 409);
  assert.ok(JSON.stringify(blocked.body).includes('safeguarding_not_cleared'));
  assert.equal((await designate(a, a.coach)).status, 409, 'an uncleared person cannot be designated');
  const roster = ok(await api('GET', `${base_(a)}/suitability`, { token: a.owner.token }));
  assert.ok(roster.items.some((s) => s.user_id === a.coach.id && !s.cleared && s.reasons.length));
  assert.ok([403, 404].includes((await api('GET', `${base_(a)}/suitability`, { token: a.stranger.token })).status));
  ok(await api('POST', '/compliance/records', { token: a.coach.token, body: { requirement_id: req.id, confirm: true } }), 201);
  ok(await api('POST', `/academy/sessions/${sid}/staff`, { token: a.owner.token, body: { user_id: a.coach.id, role: 'assistant' } }), 201);
  const w = (await pool.query("SELECT id FROM comp_records WHERE requirement_id=$1 AND subject_id=$2", [req.id, a.coach.id])).rows[0];
  await pool.query("UPDATE comp_records SET status='revoked' WHERE id=$1", [w.id]);
  const again = await api('POST', `/academy/sessions/${sid}/staff`, { token: a.owner.token, body: { user_id: a.coach.id, role: 'lead' } });
  assert.equal(again.status, 409, 'revoked eligibility is enforced for the next assignment');
  const r2 = ok(await api('GET', `${base_(a)}/suitability`, { token: a.owner.token }));
  assert.ok(['revoked', 'not_cleared'].includes(r2.items.find((s) => s.user_id === a.coach.id).state));
  assert.equal((await designate(a, a.coach)).status, 409);
});

test('overview: redacted counts only, small groups suppressed, and only oversight roles may read it', async () => {
  const a = await desk();
  ok(await raise(a, a.coach.token), 201); ok(await raise(a, a.coach.token, { risk: 'high' }), 201);
  const o = ok(await api('GET', base_(a), { token: a.owner.token }));
  assert.equal(o.open, 2); assert.equal(o.unassigned, 0); assert.equal(o.officers, 2);
  assert.equal(o.by_risk.high, null, 'a group under five is suppressed');
  const text = JSON.stringify(o); assert.ok(!/withdrawn|Athlete|Sg \d/.test(text), 'no names and no narrative');
  assert.equal((await api('GET', base_(a), { token: a.stranger.token })).status === 200, false);
  assert.equal((await api('GET', base_(a), { token: a.coach.token })).status === 200, false, 'an ordinary coach has no oversight');
});

test('policy and boundaries: versioned and retired not changed; family sees the rules but never a case; the contact check applies them', async () => {
  const a = await desk();
  const p0 = ok(await api('GET', `${base_(a)}/policy`, { token: a.owner.token })); assert.equal(p0.version, 0); assert.equal(p0.allow_private_channels, false);
  ok(await api('POST', `${base_(a)}/policy`, { token: a.owner.token, body: { retention_years: 10, quiet_from: '21:00', quiet_to: '06:00' } }));
  ok(await api('POST', `${base_(a)}/policy`, { token: a.owner.token, body: { retention_years: 12, quiet_from: '21:00', quiet_to: '06:00' } }));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM academy_sg_policies WHERE organisation_id=$1', [a.org.id])).rows[0].n, 2, 'the old version is kept, retired');
  assert.equal((await api('POST', `${base_(a)}/policy`, { token: a.coach.token, body: {} })).status, 403);
  const mine = ok(await api('GET', `${base_(a)}/mine`, { token: a.parents[0].token, query: { athlete_id: a.kids[0].id } }));
  assert.equal(mine.boundaries.private_channels_allowed, false); assert.equal(mine.boundaries.guardian_copied, true); assert.ok(mine.officers.length >= 1);
  assert.equal(JSON.stringify(mine).includes('case_no'), false);
  assert.equal((await api('GET', `${base_(a)}/mine`, { token: a.stranger.token, query: { athlete_id: a.kids[0].id } })).status, 404);
  const dm = ok(await api('POST', `${base_(a)}/contact-check`, { token: a.coach.token, body: { athlete_id: a.kids[0].id, channel: 'private_message' } }));
  assert.equal(dm.allowed, false); assert.equal(dm.checks.find((x) => x.code === 'guardian_copy').required, true);
  assert.equal(ok(await api('POST', `${base_(a)}/contact-check`, { token: a.coach.token, body: { athlete_id: a.kids[0].id, at: '2026-01-01T12:00:00Z' } })).allowed, true);
  assert.equal(ok(await api('POST', `${base_(a)}/contact-check`, { token: a.coach.token, body: { athlete_id: a.kids[0].id, at: '2026-01-01T23:00:00Z' } })).allowed, false, 'quiet hours');
});

test('REST, OpenAPI and MCP expose the same capabilities', async () => {
  const names = capabilities.filter((c) => c.tag === 'Academy safeguarding').map((c) => c.name);
  assert.ok(names.length >= 15, names.join());
  const spec = await (await fetch(`${base}/api/v1/openapi.json`)).json();
  const ops = new Set(Object.values(spec.paths).flatMap((p) => Object.values(p).map((o) => o.operationId)));
  for (const nme of names) assert.ok(ops.has(nme), `OpenAPI has ${nme}`);
});
