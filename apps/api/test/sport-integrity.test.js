// Sport Integrity & Anti-Doping Administration (#489): need-to-know access, administrative references only (strict, replay-safe, revisioned, never interpreted),
// the case lifecycle with configurable states, decisions with full history, the live sporting-sanction handoff to competition eligibility, appeals,
// education without scores, narrow declarations, cross-role leakage, audit, token scopes and REST/OpenAPI/MCP parity.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { capabilities } = await import('../src/registry.js');

let server, base, n = 0, cricket;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined)))}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: r.status, body: parsed };
};
const rpc = async (method, params, token) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) });
  return (await r.json()).result;
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const q = async (sql, args = []) => (await pool.query(sql, args)).rows;
const day = (offset = 0) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const inst = (offset = 0) => new Date(Date.now() + offset * 864e5).toISOString();
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `in_${n}_${roles[0]}`, display_name: `Int ${n}`, email: `in${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  cricket = (await q("SELECT id, slug FROM sports WHERE slug='cricket'"))[0];
});
after(async () => { server.close(); await pool.end(); });

/** A governing body for cricket, its owner, two integrity officers, an athlete, a category, a manual source. */
async function world(over = {}) {
  const owner = await signup(), o1 = await signup(), o2 = await signup(), athlete = await signup(), outsider = await signup();
  const body = must(await api('POST', '/federation/bodies', { token: owner.token, body: { name: `Federation ${++n}`, level: 'national', abbreviation: `I${String(n).padStart(3, '0')}`, country: 'SG', sports: [{ sport_id: cricket.id }] } }), 201);
  for (const o of [o1, o2]) must(await api('POST', `/federation/bodies/${body.id}/roles`, { token: owner.token, body: { user_id: o.id, role: 'integrity' } }), 201);
  const cat = must(await api('POST', `/integrity/bodies/${body.id}/categories`, { token: o1.token, body: { kind: 'anti_doping', label: `Anti-doping ${n}`, response_days: 10, decision_days: 40, state_labels: { received: 'Referral logged' }, ...over.category } }), 201);
  const src = must(await api('POST', `/integrity/bodies/${body.id}/sources`, { token: o1.token, body: { name: `Authority ${n}`, designation: 'authoritative' } }), 201);
  return { owner, o1, o2, athlete, outsider, body, cat, src };
}
const open = (w, over = {}) => api('POST', `/integrity/bodies/${w.body.id}/cases`, { token: w.o1.token, body: { category_id: w.cat.id, subject_id: w.athlete.id, summary: 'Referral from the testing authority', sport_id: cricket.id, ...over } });
const act = (w, k, action, extra = {}, who = w.o1) => api('POST', `/integrity/cases/${k.id}/transition`, { token: who.token, body: { action, ...extra } });
const decideIt = (w, k, over = {}, who = w.o1) => api('POST', `/integrity/cases/${k.id}/decisions`, { token: who.token, body: { made_by: 'external_body', authority_label: 'Independent tribunal', decision_ref: 'DEC-1', outcome: 'finding_recorded', ...over } });
const toDecision = async (w, k) => { must(await act(w, k, 'start_review')); must(await act(w, k, 'move_to_decision')); };

test('access: only a body\'s integrity officers (and owners/admins) see integrity; platform admin, other roles and bodies learn nothing', async () => {
  const w = await world();
  const admin = (await q("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('in_root','in_root','{admin}','x','x','in_root') RETURNING id"))[0];
  const { signToken } = await import('../src/auth.js');
  const adminToken = await signToken({ id: admin.id, roles: ['admin'] });
  const k = must(await open(w), 201);
  const sponsor = await signup(['sponsor']), coach = await signup(['coach']), media = await signup(['athlete']);
  const other = await world();
  for (const who of [{ token: adminToken }, w.outsider, sponsor, coach, media, w.athlete, other.o1]) {
    assert.equal((await api('GET', `/integrity/bodies/${w.body.id}/categories`, { token: who.token })).status, 404, 'categories');
    assert.equal((await api('GET', `/integrity/bodies/${w.body.id}/cases`, { token: who.token })).status, 404, 'case list');
    assert.equal((await api('GET', `/integrity/bodies/${w.body.id}/test-references`, { token: who.token })).status, 404, 'test references');
    assert.equal((await api('GET', `/integrity/bodies/${w.body.id}/exemptions`, { token: who.token })).status, 404, 'exemptions');
    assert.equal((await api('GET', `/integrity/bodies/${w.body.id}/report`, { token: who.token })).status, 404, 'report');
  }
  for (const who of [{ token: adminToken }, w.outsider, sponsor, coach, other.o1]) assert.equal((await api('GET', `/integrity/cases/${k.id}`, { token: who.token })).status, 404, 'case detail');
  assert.equal((await api('GET', '/integrity/bodies/' + w.body.id + '/cases')).status, 401);
  // the body owner is staff too
  must(await api('GET', `/integrity/bodies/${w.body.id}/cases`, { token: w.owner.token }));
  // a revoked officer loses access immediately
  const grants = await q("SELECT id FROM governing_body_roles WHERE body_id=$1 AND user_id=$2", [w.body.id, w.o2.id]);
  must(await api('DELETE', `/federation/bodies/${w.body.id}/roles/${grants[0].id}`, { token: w.owner.token }));
  assert.equal((await api('GET', `/integrity/bodies/${w.body.id}/cases`, { token: w.o2.token })).status, 404);
});

test('categories: configurable deadlines and state names; safeguarding stays out; labels flow into the case', async () => {
  const w = await world();
  const bad = await api('POST', `/integrity/bodies/${w.body.id}/categories`, { token: w.o1.token, body: { kind: 'other', label: 'Harassment complaints' } });
  assert.equal(bad.status, 400);
  const list = must(await api('GET', `/integrity/bodies/${w.body.id}/categories`, { token: w.o1.token }));
  assert.equal(list.items.length, 1); assert.equal(list.items[0].response_days, 10); assert.equal(list.kinds.length, 5);
  const k = must(await open(w), 201);
  assert.equal(k.status, 'received'); assert.equal(k.status_label, 'Referral logged', 'the body\'s own name for the state');
  assert.ok(/-INT-\d{4}-0001$/.test(k.case_no));
  assert.equal(k.decision_due_on, day(40));
  const upd = must(await api('POST', `/integrity/bodies/${w.body.id}/categories`, { token: w.o1.token, body: { category_id: w.cat.id, kind: 'anti_doping', label: w.cat.label, response_days: 5, decision_days: 20, state_labels: {} } }), 201);
  assert.equal(upd.response_days, 5);
  const dup = await api('POST', `/integrity/bodies/${w.body.id}/categories`, { token: w.o1.token, body: { kind: 'anti_doping', label: w.cat.label } });
  assert.equal(dup.status, 409);
});

test('lifecycle: legal transitions only, deadlines from the category, stale versions refused, generic notices, an allegation is not a finding', async () => {
  const w = await world();
  const k = must(await open(w), 201);
  assert.match(must(await api('GET', `/integrity/cases/${k.id}`, { token: w.o1.token })).notice, /not a finding/i);
  assert.equal((await act(w, k, 'close')).status, 409, 'cannot close what was never decided');
  assert.equal((await act(w, k, 'suspend', { reason: 'x' })).status, 409, 'received cannot be suspended');
  assert.equal((await act(w, k, 'withdraw')).status, 400, 'a reason is required');
  assert.equal((await act(w, k, 'start_review', { version: 99 })).status, 409, 'stale');
  assert.equal(must(await act(w, k, 'start_review', { version: 1 })).status, 'under_review');
  const asked = must(await act(w, k, 'request_response'));
  assert.equal(asked.status, 'response_due'); assert.equal(asked.response_due_on, day(10));
  assert.equal((await act(w, k, 'request_response', { response_due_on: day(-1) })).status, 409);
  must(await act(w, k, 'defer', { reason: 'Awaiting the authority' }));
  assert.equal(must(await act(w, k, 'resume')).status, 'response_due', 'resumes where it was');
  // overdue shows up in the list and the report
  await q("UPDATE int_cases SET response_due_on=current_date-2 WHERE id=$1", [k.id]);
  const over = must(await api('GET', `/integrity/bodies/${w.body.id}/cases`, { token: w.o1.token, query: { overdue: 'true' } }));
  assert.equal(over.total, 1); assert.equal(over.items[0].response_overdue, true);
  assert.equal(must(await api('GET', `/integrity/bodies/${w.body.id}/report`, { token: w.o1.token })).overdue.responses, 1);
  // notices to the subject say nothing of substance
  const notes = await q("SELECT title, body, data FROM notifications WHERE user_id=$1 AND kind='integrity_update'", [w.athlete.id]);
  assert.ok(notes.length >= 2);
  for (const t of notes) { const s = JSON.stringify(t).toLowerCase(); for (const bad of ['doping', 'anti', 'violation', 'sanction', 'test', 'integrity']) assert.ok(!s.includes(bad), `notice leaks "${bad}": ${s}`); }
  // history is append-only
  await assert.rejects(q("UPDATE int_events SET action='x'"), /append-only/);
  await assert.rejects(q('DELETE FROM int_events'), /append-only/);
  const detail = must(await api('GET', `/integrity/cases/${k.id}`, { token: w.o1.token }));
  assert.deepEqual(detail.history.map((h) => h.action).slice(0, 4), ['opened', 'start_review', 'request_response', 'defer']);
});

test('testing references: administrative only, strict, unverified until a second officer reviews, replay-safe, revisioned, tombstoned, append-only custody', async () => {
  const w = await world();
  const k = must(await open(w), 201);
  const base_ = { subject_id: w.athlete.id, case_id: k.id, source_id: w.src.id, external_ref: 'TST-2026-0001', testing_authority: 'National Anti-Doping Org', collected_at: inst(-3), context: 'in_competition', external_status: 'Received by authority', result_category: 'Awaiting authority' };
  const post = (b, who = w.o1) => api('POST', `/integrity/bodies/${w.body.id}/test-references`, { token: who.token, body: b });
  // nothing analytical or interpretive can be stored: unknown fields are refused
  for (const extra of [{ analyte_concentration: 12.3 }, { violation: true }, { substance: 'x' }, { adverse_finding: true }, { notes_diagnosis: 'x' }]) assert.equal((await post({ ...base_, ...extra })).status, 400, JSON.stringify(extra));
  assert.equal((await post(base_, w.outsider)).status, 404);
  assert.equal((await post({ ...base_, case_id: (await open(await { ...w, athlete: await signup() }).then((r) => r.body.id)) })).status, 400, 'case is about someone else');
  const first = must(await post(base_), 201);
  assert.equal(first.verification, 'unverified'); assert.equal(first.revision, 1); assert.equal(first.external_ref, 'TST-2026-0001'); assert.equal(first.replayed, false);
  assert.match(first.reference_only, /does not interpret/);
  // stored encrypted; identity by blind index only
  const raw = (await q('SELECT external_ref_enc, external_ref_idx FROM int_test_refs WHERE id=$1', [first.id]))[0];
  assert.ok(!raw.external_ref_enc.includes('TST-2026') && !raw.external_ref_idx.includes('TST'));
  // replay: same content again is the same record
  const again = must(await post(base_), 201);
  assert.equal(again.id, first.id); assert.equal(again.replayed, true);
  assert.equal((await q('SELECT count(*)::int AS n FROM int_test_refs WHERE body_id=$1', [w.body.id]))[0].n, 1);
  // a correction is a new revision that supersedes, nothing overwritten
  const rev = must(await post({ ...base_, external_status: 'Result management in progress', result_category: 'Under authority review' }), 201);
  assert.equal(rev.revision, 2); assert.notEqual(rev.id, first.id);
  const rows = await q('SELECT revision, superseded_at, external_status FROM int_test_refs WHERE body_id=$1 ORDER BY revision', [w.body.id]);
  assert.equal(rows.length, 2); assert.ok(rows[0].superseded_at); assert.equal(rows[0].external_status, 'Received by authority'); assert.equal(rows[1].superseded_at, null);
  // review: not by the entering officer
  assert.equal((await api('POST', `/integrity/references/${rev.id}/review`, { token: w.o1.token, body: { type: 'test_reference' } })).status, 403);
  assert.equal((await api('POST', `/integrity/references/${first.id}/review`, { token: w.o2.token, body: { type: 'test_reference' } })).status, 409, 'superseded revisions cannot be reviewed');
  assert.equal(must(await api('POST', `/integrity/references/${rev.id}/review`, { token: w.o2.token, body: { type: 'test_reference' } })).verification, 'reviewed');
  // custody: append-only, idempotent on the source's own identifier
  const ev1 = must(await api('POST', `/integrity/test-references/${rev.id}/custody`, { token: w.o1.token, body: { step: 'Received at laboratory', actor_label: 'Accredited laboratory', occurred_at: inst(-2), external_id: 'CUS-1' } }), 201);
  const ev1b = must(await api('POST', `/integrity/test-references/${rev.id}/custody`, { token: w.o1.token, body: { step: 'Received at laboratory', actor_label: 'Accredited laboratory', occurred_at: inst(-2), external_id: 'CUS-1' } }), 201);
  assert.equal(ev1b.id, ev1.id);
  await assert.rejects(q("UPDATE int_custody_events SET step='x'"), /append-only/);
  await assert.rejects(q('DELETE FROM int_custody_events'), /append-only/);
  assert.equal((await api('POST', `/integrity/test-references/${first.id}/custody`, { token: w.o1.token, body: { step: 'Late step', actor_label: 'Lab', occurred_at: inst(-1) } })).status, 409, 'only the current revision');
  // list: audit-logged, history on request
  const cur = must(await api('GET', `/integrity/bodies/${w.body.id}/test-references`, { token: w.o1.token, query: { subject_id: w.athlete.id } }));
  assert.equal(cur.items.length, 1); assert.equal(cur.items[0].custody.length, 1);
  assert.equal(must(await api('GET', `/integrity/bodies/${w.body.id}/test-references`, { token: w.o1.token, query: { history: 'true' } })).items.length, 2);
  assert.ok((await q("SELECT 1 FROM audit_log WHERE action='integrity_test_references_read' AND actor_id=$1", [w.o1.id])).length >= 1);
  // tombstone keeps the record, drops it from current
  must(await api('POST', `/integrity/references/${rev.id}/tombstone`, { token: w.o2.token, body: { type: 'test_reference', reason: 'Withdrawn by the authority' } }));
  assert.equal(must(await api('GET', `/integrity/bodies/${w.body.id}/test-references`, { token: w.o1.token, query: { history: 'true' } })).items.find((x) => x.id === rev.id).current, false);
  assert.equal((await q('SELECT count(*)::int AS n FROM int_test_refs WHERE body_id=$1', [w.body.id]))[0].n, 2);
  // the subject never receives test references through any integrity surface
  const mine = must(await api('GET', '/me/integrity', { token: w.athlete.token }));
  assert.ok(!JSON.stringify(mine).includes('TST-2026') && !JSON.stringify(mine).includes('Under authority review'));
  assert.equal((await api('GET', `/integrity/bodies/${w.body.id}/test-references`, { token: w.athlete.token })).status, 404);
});

test('exemptions: minimum projection only, no clinical fields, revisioned and re-verified, subject sees only status', async () => {
  const w = await world();
  const post = (b, who = w.o1) => api('POST', `/integrity/bodies/${w.body.id}/exemptions`, { token: who.token, body: b });
  const e = { subject_id: w.athlete.id, source_id: w.src.id, external_ref: 'TUE-77', issuing_authority: 'National Anti-Doping Org', external_status: 'Granted', valid_from: day(-30), valid_until: day(300), scope_note: 'All competitions' };
  for (const extra of [{ diagnosis: 'x' }, { medication: 'x' }, { rationale: 'x' }, { clinical_notes: 'x' }, { condition: 'x' }]) assert.equal((await post({ ...e, ...extra })).status, 400, JSON.stringify(extra));
  assert.equal((await post({ ...e, valid_until: day(-40) })).status, 400);
  const a = must(await post(e), 201);
  assert.equal(a.in_force, true); assert.equal(a.verification, 'unverified'); assert.equal(a.external_ref, 'TUE-77');
  const cols = (await q("SELECT column_name FROM information_schema.columns WHERE table_name IN ('int_exemptions','int_test_refs')")).map((r) => r.column_name).join(' ');
  for (const bad of ['diagnos', 'medic', 'rationale', 'clinical', 'analyt', 'concentration', 'substance', 'score', 'risk']) assert.ok(!cols.includes(bad), `schema must not carry ${bad}`);
  const re = must(await post(e), 201);
  assert.equal(re.id, a.id); assert.equal(re.replayed, true);
  const rev = must(await post({ ...e, external_status: 'Expired', valid_until: day(-1) }), 201);
  assert.equal(rev.revision, 2); assert.equal(rev.in_force, false);
  assert.equal(must(await api('GET', `/integrity/bodies/${w.body.id}/exemptions`, { token: w.o1.token })).items.length, 1);
  const mine = must(await api('GET', '/me/integrity', { token: w.athlete.token }));
  assert.equal(mine.exemptions.length, 1); assert.equal(mine.exemptions[0].external_status, 'Expired');
  assert.ok(!('external_ref' in mine.exemptions[0]));
  assert.equal((await api('GET', `/integrity/bodies/${w.body.id}/exemptions`, { token: w.outsider.token })).status, 404);
});

test('decisions: exact reference and source, human only, history kept through amendment and reversal; the person sees status, not internals', async () => {
  const w = await world();
  const k = must(await open(w), 201);
  assert.equal((await decideIt(w, k)).status, 409, 'not open for decision yet');
  await toDecision(w, k);
  assert.equal((await decideIt(w, k, { sporting_sanction: true, outcome: 'no_finding' })).status, 400);
  assert.equal((await decideIt(w, k, { sporting_sanction: true })).status, 400, 'a sanction needs its effective date');
  assert.equal((await decideIt(w, k, {}, w.outsider)).status, 404);
  const d1 = must(await decideIt(w, k, { effective_from: day(-1), effective_to: day(100), sporting_sanction: true, scope_note: 'All sanctioned cricket' }), 201);
  assert.equal(d1.seq, 1); assert.equal(d1.handoff_status, 'delivered_to_eligibility');
  assert.equal(must(await api('GET', `/integrity/cases/${k.id}`, { token: w.o1.token })).status, 'decided');
  assert.equal((await decideIt(w, k)).status, 409, 'a second initial decision is refused');
  const d2 = must(await decideIt(w, k, { kind: 'amendment', decision_ref: 'DEC-1-A', effective_from: day(-1), effective_to: day(30), sporting_sanction: true }), 201);
  assert.equal(d2.seq, 2);
  const rows = await q('SELECT seq, superseded_at, handoff_status, supersedes_id FROM int_decisions WHERE case_id=$1 ORDER BY seq', [k.id]);
  assert.ok(rows[0].superseded_at); assert.equal(rows[0].handoff_status, 'lifted'); assert.equal(rows[1].supersedes_id !== null, true); assert.equal(rows[1].superseded_at, null);
  assert.equal((await decideIt(w, k, { kind: 'reversal', outcome: 'finding_recorded' })).status, 400, 'a reversal cannot record a finding');
  must(await decideIt(w, k, { kind: 'reversal', outcome: 'no_finding', decision_ref: 'DEC-1-R', made_by: 'internal_panel', authority_label: 'Appeals panel' }), 201);
  const after_ = await q('SELECT count(*)::int AS n, count(*) FILTER (WHERE superseded_at IS NULL)::int AS cur FROM int_decisions WHERE case_id=$1', [k.id]);
  assert.deepEqual([after_[0].n, after_[0].cur], [3, 1], 'three decisions kept, one current');
  for (const t of ['int_decisions', 'int_cases']) await assert.rejects(q(`DELETE FROM ${t}`), /append-only/, `${t} rows are never deleted`);
  // the subject's view
  const mine = must(await api('GET', `/integrity/cases/${k.id}`, { token: w.athlete.token }));
  assert.equal(mine.summary, null, 'the subject does not see the officers\' internal summary'); assert.equal(mine.access, undefined); assert.equal(mine.as, 'subject');
  assert.equal(mine.decisions.length, 3); assert.deepEqual(mine.actions, []);
  for (const h of mine.history) assert.deepEqual(h.detail, {}, 'no internal detail in the subject\'s history');
  assert.equal((await api('GET', `/integrity/cases/${k.id}`, { token: (await signup()).token })).status, 404, 'another athlete');
  assert.ok((await q("SELECT 1 FROM audit_log WHERE action='integrity_case_read_by_subject' AND actor_id=$1", [w.athlete.id])).length >= 1);
  // closing
  must(await act(w, k, 'close'));
  assert.equal((await act(w, k, 'start_review')).status, 409);
});

/* ---------- eligibility handoff ---------- */
const day5 = (o) => day(o);
async function competition(w) {
  const org = await signup(['organizer']), mgr = await signup(['athlete']), mgr2 = await signup(['athlete']);
  const team = must(await api('POST', '/teams', { token: mgr.token, body: { name: `Bats ${++n}`, sport: 'cricket' } }), 201);
  const rival = must(await api('POST', '/teams', { token: mgr2.token, body: { name: `Rivals ${++n}`, sport: 'cricket' } }), 201);
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: `Cup ${n}`, sport: 'cricket', starts_on: day5(5), ends_on: day5(30) } }), 201);
  for (const [t, tok] of [[team, mgr.token], [rival, mgr2.token]]) {
    const en = must(await api('POST', `/events/${ev.id}/entries`, { token: tok, body: { team_id: t.id } }), 201);
    must(await api('PATCH', `/entries/${en.id}`, { token: org.token, body: { status: 'accepted' } }));
  }
  must(await api('POST', `/events/${ev.id}/registration/policy`, { token: org.token, body: { rules: {}, expected_version: 0 } }), 201);
  must(await api('POST', `/teams/${team.id}/members`, { token: mgr.token, body: { user_id: w.athlete.id } }), 201);
  const reg = must(await api('POST', `/events/${ev.id}/registrations`, { token: mgr.token, body: { team_id: team.id, user_id: w.athlete.id } }), 201);
  must(await api('POST', `/registrations/${reg.id}/review`, { token: org.token, body: { action: 'register', row_version: reg.row_version } }));
  return { org, mgr, team, ev, check: () => api('GET', `/events/${ev.id}/eligibility`, { token: org.token, query: { team_id: team.id, user_id: w.athlete.id } }) };
}

test('sanction handoff: eligibility reads the active sporting sanction live, shows only "suspended", lifts on amendment/reversal/appeal, never leaks the case', async () => {
  const w = await world();
  const comp = await competition(w);
  assert.equal(must(await comp.check()).decisions[0].decision, 'eligible');
  const k = must(await open(w), 201);
  await toDecision(w, k);
  // a finding WITHOUT a sporting sanction does not touch eligibility; a pending case never does
  assert.equal(must(await comp.check()).decisions[0].decision, 'eligible', 'a pending matter is not a suspension');
  const d1 = must(await decideIt(w, k, { effective_from: day(-1), effective_to: day(60), sporting_sanction: true }), 201);
  const blocked = must(await comp.check()).decisions[0];
  assert.equal(blocked.decision, 'ineligible');
  const susp = blocked.checks.find((c) => c.rule === 'suspension');
  assert.equal(susp.status, 'fail'); assert.match(susp.reason, /Suspended until/);
  const wire = JSON.stringify(blocked).toLowerCase();
  for (const bad of ['doping', 'integrity', 'anti', 'tribunal', 'dec-1', k.case_no.toLowerCase()]) assert.ok(!wire.includes(bad), `eligibility leaks "${bad}"`);
  assert.ok(!('source_ref' in (susp.source ?? {})));
  // the manager and organiser's other surfaces do not carry it either
  assert.ok(!JSON.stringify(must(await api('GET', `/events/${comp.ev.id}/registration/dependencies`, { token: comp.org.token }))).includes(k.case_no));
  // amendment to a past end date lifts it with nothing to clean up
  must(await decideIt(w, k, { kind: 'amendment', decision_ref: 'DEC-1-A', effective_from: day(-10), effective_to: day(-2), sporting_sanction: true }), 201);
  assert.equal(must(await comp.check()).decisions[0].decision, 'eligible', 'a lapsed sanction no longer blocks');
  must(await decideIt(w, k, { kind: 'amendment', decision_ref: 'DEC-1-B', effective_from: day(-1), effective_to: null, sporting_sanction: true }), 201);
  assert.equal(must(await comp.check()).decisions[0].decision, 'ineligible', 'open-ended');
  // appeal: lodged by the subject only, reviewed by someone who did not decide, overturn lifts the sanction, history stays
  assert.equal((await api('POST', `/integrity/cases/${k.id}/appeals`, { token: w.o1.token, body: { grounds: 'I am staff, not the subject' } })).status, 403);
  assert.equal((await api('POST', `/integrity/cases/${k.id}/appeals`, { token: w.athlete.token, body: { grounds: 'short' } })).status, 400);
  const ap = must(await api('POST', `/integrity/cases/${k.id}/appeals`, { token: w.athlete.token, body: { grounds: 'The sample reference was recorded against the wrong person.' } }), 201);
  assert.equal((await api('POST', `/integrity/cases/${k.id}/appeals`, { token: w.athlete.token, body: { grounds: 'A second appeal on the same decision' } })).status, 409);
  assert.equal((await api('POST', `/integrity/appeals/${ap.id}/ruling`, { token: w.o1.token, body: { action: 'start_review' } })).status, 403, 'the officer who decided cannot review the appeal');
  assert.equal((await api('POST', `/integrity/appeals/${ap.id}/ruling`, { token: w.athlete.token, body: { action: 'overturned' } })).status, 403, 'the person concerned cannot rule on their own appeal');
  assert.equal((await api('POST', `/integrity/appeals/${ap.id}/ruling`, { token: w.outsider.token, body: { action: 'overturned' } })).status, 404);
  must(await api('POST', `/integrity/appeals/${ap.id}/ruling`, { token: w.o2.token, body: { action: 'start_review', panel_label: 'Appeals panel' } }));
  assert.equal((await api('POST', `/integrity/appeals/${ap.id}/ruling`, { token: w.o2.token, body: { action: 'overturned' } })).status, 400, 'the new decision must be fully described');
  must(await api('POST', `/integrity/appeals/${ap.id}/ruling`, { token: w.o2.token, body: { action: 'overturned', reason: 'Wrong subject', decision: { made_by: 'internal_panel', authority_label: 'Appeals panel', decision_ref: 'APP-1', outcome: 'no_finding' } } }));
  assert.equal(must(await comp.check()).decisions[0].decision, 'eligible', 'overturned');
  const hist = await q('SELECT seq, kind, outcome, superseded_at IS NOT NULL AS old FROM int_decisions WHERE case_id=$1 ORDER BY seq', [k.id]);
  assert.deepEqual(hist.map((h) => h.kind), ['initial', 'amendment', 'amendment', 'appeal_outcome']);
  assert.equal(hist.filter((h) => !h.old).length, 1);
  assert.equal(d1.seq, 1);
  const cd = must(await api('GET', `/integrity/cases/${k.id}`, { token: w.o1.token }));
  assert.equal(cd.appeals[0].status, 'overturned'); assert.ok(cd.history.some((h) => h.subject_type === 'appeal' && h.action === 'overturned'));
  assert.equal((await api('POST', `/integrity/appeals/${ap.id}/ruling`, { token: w.o2.token, body: { action: 'upheld' } })).status, 409, 'already ruled');
});

test('appeal outcomes: upheld leaves the sanction, reduced supersedes it, remitted reopens the case; only people rule', async () => {
  const w = await world();
  const comp = await competition(w);
  const k = must(await open(w), 201);
  await toDecision(w, k);
  must(await decideIt(w, k, { effective_from: day(-1), effective_to: day(90), sporting_sanction: true }), 201);
  const lodge = async () => must(await api('POST', `/integrity/cases/${k.id}/appeals`, { token: w.athlete.token, body: { grounds: 'I disagree with this decision, see my response.' } }), 201);
  const rule = (a, body, who = w.o2) => api('POST', `/integrity/appeals/${a.id}/ruling`, { token: who.token, body });
  let a = await lodge();
  must(await rule(a, { action: 'upheld' }));
  assert.equal(must(await comp.check()).decisions[0].decision, 'ineligible');
  a = await lodge();
  must(await rule(a, { action: 'reduced', decision: { made_by: 'internal_panel', authority_label: 'Appeals panel', decision_ref: 'APP-2', outcome: 'finding_recorded', effective_from: day(-1), effective_to: day(-1), sporting_sanction: true } }));
  assert.equal(must(await comp.check()).decisions[0].decision, 'eligible', 'reduced to time already served');
  a = await lodge();
  assert.equal((await rule(a, { action: 'remitted' })).status, 403, 'the panel that recorded the reduced decision cannot review its appeal');
  must(await rule(a, { action: 'remitted', reason: 'Procedural error' }, w.o1));
  assert.equal(must(await api('GET', `/integrity/cases/${k.id}`, { token: w.o1.token })).status, 'under_review');
  assert.equal((await q("SELECT count(*)::int AS n FROM int_appeals WHERE case_id=$1", [k.id]))[0].n, 3);
});

test('responses and need-to-know: the subject answers privately; a panel member sees ONE case until revoked; the subject cannot sit on their own panel', async () => {
  const w = await world();
  const k = must(await open(w, { summary: 'Internal summary for officers only' }), 201), k2 = must(await open(w, {}), 201);
  must(await act(w, k, 'start_review')); must(await act(w, k, 'request_response'));
  must(await api('POST', `/integrity/cases/${k.id}/response`, { token: w.athlete.token, body: { body: 'My account of events.' } }), 201);
  assert.equal((await api('POST', `/integrity/cases/${k.id}/response`, { token: w.outsider.token, body: { body: 'Not mine' } })).status, 404);
  assert.equal((await api('POST', `/integrity/cases/${k.id}/response`, { token: w.o1.token, body: { body: 'Staff cannot answer for them' } })).status, 403);
  assert.ok(!(await q('SELECT body_enc FROM int_case_messages WHERE case_id=$1', [k.id]))[0].body_enc.includes('account'), 'encrypted at rest');
  const panelist = await signup(['coach']);
  assert.equal((await api('POST', `/integrity/cases/${k.id}/access`, { token: w.o1.token, body: { user_id: w.athlete.id, role: 'panel' } })).status, 400);
  assert.equal((await api('POST', `/integrity/cases/${k.id}/access`, { token: panelist.token, body: { user_id: panelist.id, role: 'panel' } })).status, 404, 'a stranger cannot grant themselves access');
  must(await api('POST', `/integrity/cases/${k.id}/access`, { token: w.o1.token, body: { user_id: panelist.id, role: 'reviewer' } }), 201);
  const seen = must(await api('GET', `/integrity/cases/${k.id}`, { token: panelist.token }));
  assert.equal(seen.as, 'reviewer'); assert.equal(seen.summary, 'Internal summary for officers only'); assert.equal(seen.messages.length, 1);
  assert.equal((await api('GET', `/integrity/cases/${k2.id}`, { token: panelist.token })).status, 404, 'only the one case');
  assert.equal((await decideIt(w, k, {}, panelist)).status, 403, 'a reviewer reads only');
  assert.equal(must(await api('GET', `/integrity/bodies/${w.body.id}/cases`, { token: panelist.token })).total, 1);
  assert.equal((await api('GET', `/integrity/bodies/${w.body.id}/test-references`, { token: panelist.token })).status, 404);
  assert.equal((await api('POST', `/integrity/cases/${k.id}/transition`, { token: panelist.token, body: { action: 'close' } })).status, 403);
  const acc = seen.access ?? must(await api('GET', `/integrity/cases/${k.id}`, { token: w.o1.token })).access;
  must(await api('DELETE', `/integrity/cases/${k.id}/access/${acc[0].id}`, { token: w.o1.token }));
  assert.equal((await api('GET', `/integrity/cases/${k.id}`, { token: panelist.token })).status, 404, 'revoked at once');
  // the subject's own view carries no other party's material
  const mine = must(await api('GET', `/integrity/cases/${k.id}`, { token: w.athlete.token }));
  assert.equal(mine.summary, null); assert.equal(mine.messages.length, 1); assert.equal(mine.messages[0].mine, true);
  assert.equal(must(await api('GET', '/me/integrity', { token: w.athlete.token })).cases.length, 2);
  assert.equal(must(await api('GET', '/me/integrity', { token: w.outsider.token })).cases.length, 0);
});

test('education: requirement versions, assignment (named and licence holders), completion with expiry, counts not scores', async () => {
  const w = await world();
  const other = await signup(['athlete']);
  const req = must(await api('POST', `/integrity/bodies/${w.body.id}/education`, { token: w.o1.token, body: { title: 'Clean sport basics', valid_months: 12 } }), 201);
  assert.equal(req.version, 1);
  assert.equal((await api('POST', `/integrity/bodies/${w.body.id}/education`, { token: w.outsider.token, body: { title: 'Nope' } })).status, 404);
  assert.equal((await api('POST', `/integrity/education/${req.id}/assign`, { token: w.o1.token, body: {} })).status, 400);
  const asg = must(await api('POST', `/integrity/education/${req.id}/assign`, { token: w.o1.token, body: { user_ids: [w.athlete.id, other.id] } }), 201);
  assert.equal(asg.assigned, 2);
  assert.equal(must(await api('POST', `/integrity/education/${req.id}/assign`, { token: w.o1.token, body: { user_ids: [w.athlete.id] } }), 201).assigned, 0, 'idempotent');
  const rec = (await q('SELECT id FROM int_education_records WHERE user_id=$1', [w.athlete.id]))[0];
  assert.equal((await api('POST', `/integrity/education-records/${rec.id}/complete`, { token: other.token, body: {} })).status, 404, "someone else's record");
  assert.equal((await api('POST', `/integrity/education-records/${rec.id}/complete`, { token: w.athlete.token, body: { completed_on: day(2) } })).status, 400);
  const done = must(await api('POST', `/integrity/education-records/${rec.id}/complete`, { token: w.athlete.token, body: { completed_on: day(-5), evidence_ref: 'CERT-123' } }));
  assert.ok(done.expires_on > day(300));
  const list = must(await api('GET', `/integrity/bodies/${w.body.id}/education`, { token: w.o1.token }));
  assert.deepEqual([list.items[0].assigned, list.items[0].completed, list.items[0].expired], [2, 1, 0]);
  assert.equal(list.outstanding.length, 1);
  assert.ok(!JSON.stringify(list).match(/score|rank|risk/i));
  await q("UPDATE int_education_records SET expires_on=current_date-1 WHERE id=$1", [rec.id]);
  assert.equal(must(await api('GET', `/integrity/bodies/${w.body.id}/education`, { token: w.o1.token })).items[0].expired, 1);
  // a new version keeps earlier completions under the version they were made
  const v2 = must(await api('POST', `/integrity/bodies/${w.body.id}/education`, { token: w.o1.token, body: { requirement_id: req.id, title: 'Clean sport basics', valid_months: 12 } }), 201);
  assert.equal(v2.version, 2);
  assert.equal((await q('SELECT version FROM int_education_records WHERE id=$1', [rec.id]))[0].version, 1);
  const mine = must(await api('GET', '/me/integrity', { token: w.athlete.token }));
  assert.equal(mine.education.length, 1); assert.equal(mine.education[0].expired, true);
  assert.equal(must(await api('GET', '/me/integrity', { token: other.token })).education[0].status, 'assigned');
});

test('declarations: only where the body asks, purpose and retention required, readable by the declarant and officers only, hidden after retention', async () => {
  const w = await world();
  const body = { kind: 'betting_interest', purpose: 'Required by the code of conduct', detail: 'I hold a shareholding in an operator.', retain_until: day(365) };
  assert.equal((await api('POST', `/integrity/bodies/${w.body.id}/declarations`, { token: w.athlete.token, body })).status, 404, 'the body has not switched declarations on');
  must(await api('POST', `/integrity/bodies/${w.body.id}/categories`, { token: w.o1.token, body: { kind: 'betting_conflict', label: 'Betting and conflict declarations' } }), 201);
  assert.equal((await api('POST', `/integrity/bodies/${w.body.id}/declarations`, { token: w.athlete.token, body: { ...body, purpose: 'x' } })).status, 400);
  assert.equal((await api('POST', `/integrity/bodies/${w.body.id}/declarations`, { token: w.athlete.token, body: { ...body, retain_until: day(-1) } })).status, 400);
  must(await api('POST', `/integrity/bodies/${w.body.id}/declarations`, { token: w.athlete.token, body: { ...body, history: 'bank statements' } }), 201); // unknown extras are stripped, never stored
  const d = (await q('SELECT id, detail_enc FROM int_declarations WHERE body_id=$1 ORDER BY created_at LIMIT 1', [w.body.id]))[0];
  assert.ok(!d.detail_enc.includes('shareholding'));
  const list = must(await api('GET', `/integrity/bodies/${w.body.id}/declarations`, { token: w.o1.token }));
  assert.equal(list.items[0].detail, 'I hold a shareholding in an operator.');
  for (const who of [w.outsider, await signup(['sponsor']), await signup(['coach'])]) assert.equal((await api('GET', `/integrity/bodies/${w.body.id}/declarations`, { token: who.token })).status, 404);
  assert.equal((await api('POST', `/integrity/declarations/${d.id}/withdraw`, { token: w.outsider.token })).status, 404);
  await q("UPDATE int_declarations SET retain_until=current_date-1 WHERE id=$1", [d.id]);
  assert.equal(must(await api('GET', `/integrity/bodies/${w.body.id}/declarations`, { token: w.o1.token })).items[0].detail, null, 'past retention the content is no longer shown');
  const body2 = { ...body, retain_until: day(30) };
  const d2 = must(await api('POST', `/integrity/bodies/${w.body.id}/declarations`, { token: w.athlete.token, body: body2 }), 201);
  must(await api('POST', `/integrity/declarations/${d2.id}/withdraw`, { token: w.athlete.token }));
  assert.equal(must(await api('GET', '/me/integrity', { token: w.athlete.token })).declarations.filter((x) => x.status === 'withdrawn').length, 1);
});

test('reporting is operational counts only; no per-person ranking or risk score exists anywhere', async () => {
  const w = await world();
  must(await open(w), 201);
  const r = must(await api('GET', `/integrity/bodies/${w.body.id}/report`, { token: w.o1.token }));
  assert.equal(r.by_status.find((x) => x.status === 'received').n, 1);
  assert.equal(r.sync_failures, 0); assert.match(r.sync_note, /No external feed is connected/);
  assert.ok(!JSON.stringify(r).includes(w.athlete.display_name));
  assert.ok(!JSON.stringify(r).match(/risk|score|rank/i));
  const src = must(await api('GET', `/integrity/bodies/${w.body.id}/sources`, { token: w.o1.token }));
  assert.match(src.integration_note, /blocked/i); assert.equal(src.items[0].integration, 'blocked_awaiting_credentials');
});

test('REST, OpenAPI and MCP expose the same capabilities with the same permissions; narrow tokens never reach integrity', async () => {
  const w = await world();
  const k = must(await open(w), 201);
  const names = capabilities.filter((c) => c.tag === 'Sport integrity').map((c) => c.name);
  assert.ok(names.length >= 28);
  for (const c of capabilities.filter((x) => x.tag === 'Sport integrity')) assert.equal(c.scope, 'admin', `${c.name} must be admin-scoped`);
  const spec = must(await api('GET', '/openapi.json'));
  for (const name of names) assert.ok(Object.values(spec.paths).some((p) => Object.values(p).some((op) => op.operationId === name)), `${name} in OpenAPI`);
  const tools = (await rpc('tools/list', {}, w.o1.token)).tools.map((x) => x.name);
  for (const name of names) assert.ok(tools.includes(name), `${name} over MCP`);
  const viaMcp = await rpc('tools/call', { name: 'get_integrity_case', arguments: { id: k.id } }, w.o1.token);
  assert.ok(!viaMcp.isError, JSON.stringify(viaMcp));
  const denied = await rpc('tools/call', { name: 'get_integrity_case', arguments: { id: k.id } }, w.outsider.token);
  assert.equal(denied.isError, true, 'same 404 over MCP');
  assert.ok(!JSON.stringify(denied).includes(k.case_no));
  // API tokens: a read or write token cannot touch integrity; an admin-scoped one can, and still only as the user
  for (const scopes of [['read'], ['write'], ['read', 'write', 'clinical', 'payment']]) {
    const t = must(await api('POST', '/me/tokens', { token: w.o1.token, body: { name: `t${++n}`, scopes } }), 201);
    assert.equal((await api('GET', `/integrity/cases/${k.id}`, { token: t.token })).status, 403, scopes.join());
    assert.equal((await api('GET', `/integrity/bodies/${w.body.id}/cases`, { token: t.token })).status, 403, scopes.join());
  }
  // the admin scope can only be minted by platform admins, who have no standing in integrity: so no token of any kind reaches it, only a signed-in session
  assert.equal((await api('POST', '/me/tokens', { token: w.o1.token, body: { name: `adm${++n}`, scopes: ['admin'] } })).status, 400);
});

test('additive migration: existing federation roles and data survive; the role check only widened', async () => {
  const w = await world();
  const defs = (await q("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname='governing_body_roles_role_check'"))[0].d;
  for (const r of ['registrar', 'licensing', 'sanctioner', 'secretary', 'compliance', 'auditor', 'integrity']) assert.ok(defs.includes(r), r);
  assert.equal((await q("SELECT count(*)::int AS n FROM governing_body_roles WHERE body_id=$1 AND role='integrity'", [w.body.id]))[0].n, 2);
  // no integrity role leaks into other federation work
  const reg = must(await api('GET', `/federation/bodies/${w.body.id}/home`, { token: w.o1.token }));
  assert.equal(reg.me.can.integrity, true); assert.equal(reg.me.can.sanctions, false); assert.equal(reg.me.can.licences, false);
});
