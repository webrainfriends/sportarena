import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base;
const api = async (method, path, { token, body, query } = {}) => {
  const qs = query ? '?' + new URLSearchParams(query) : '';
  const r = await fetch(`${base}/api/v1${path}${qs}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
let n = 0;
const signup = async (roles) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `sp_${n}_${roles[0]}`, display_name: `Sp ${n}`, email: `sp${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const day = (days) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

/** A sports day with a 100 m of four runners in one heat. */
async function heat({ resultType } = {}) {
  const org = await signup(['organizer']);
  const ev = (await api('POST', '/events', { token: org.token, body: { name: `Sprint Day ${n}`, sport: 'multi-sport', kind: 'tournament', starts_on: day(5), ends_on: day(5) } })).body;
  await api('PATCH', `/events/${ev.id}/programme`, { token: org.token, body: { rest_gap_min: 15, public_names: false } });
  const house = (await api('POST', `/events/${ev.id}/houses`, { token: org.token, body: { name: 'Red', color: '#e11' } })).body;
  const people = [];
  for (let k = 0; k < 4; k++) people.push((await api('POST', `/events/${ev.id}/participants`, { token: org.token, body: { full_name: `Runner ${n}-${k}`, house_id: house.id, gender: 'male', grade: '7', roll_no: `Q${n}-${k}` } })).body);
  const d = (await api('POST', `/events/${ev.id}/disciplines`, { token: org.token, body: { sport: 'athletics', name: '100m', officials_required: 0, ...(resultType ? { result_type: resultType } : {}) } })).body;
  for (const [k, p] of people.entries()) await api('POST', `/disciplines/${d.id}/nominations`, { token: org.token, body: { participant_id: p.id, seed: 12 + k } });
  const gen = await api('POST', `/disciplines/${d.id}/heats`, { token: org.token, body: { lanes: 4 } });
  assert.equal(gen.status, 201, JSON.stringify(gen.body));
  const session = (await api('GET', `/sessions/${gen.body.sessions[0].id}`, { token: org.token })).body;
  // an event policy that a session can satisfy: the organiser reviews
  await api('POST', `/events/${ev.id}/result-approval-policy`, { token: org.token, body: { policy: { mode: 'parallel', requirements: [{ key: 'organiser', label: 'Organiser', roles: ['organiser'] }], allow_public_submission: true } } });
  return { org, ev, d, session };
}
const sheetFor = async (u, rows, { variant = 'Track heat', sport = 'athletics' } = {}) => {
  const s = (await api('POST', '/tracking/sheets', { token: u.token, body: { sport, variant } })).body;
  assert.ok(s.id, JSON.stringify(s));
  const r = await api('PATCH', `/tracking/sheets/${s.id}`, { token: u.token, body: { rows } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await api('POST', `/tracking/sheets/${s.id}/complete`, { token: u.token })).status, 200);
  return s;
};

test('a timekeeper\'s heat sheet is proposed for a session, reviewed by the organiser and applied through the session results path', async () => {
  const { org, ev, session } = await heat();
  const timer = await signup(['athlete']), nobody = await signup(['athlete']);
  const lanes = [...session.entries].sort((a, b) => a.lane - b.lane);
  assert.equal(lanes.length, 4);
  const times = ['12.40', '11.90', '12.10', '13.00'];
  const s = await sheetFor(timer, lanes.map((_, i) => ({ lane: String(i + 1), name: `Lane ${i + 1}`, result: times[i] })));

  const cand = await api('GET', '/tracking/session-candidates', { token: timer.token, query: { sheet_id: s.id } });
  assert.equal(cand.status, 200, JSON.stringify(cand.body));
  const c = cand.body.find((x) => x.id === session.id);
  assert.ok(c, 'the heat is offered'); assert.equal(c.entries.length, 4);
  assert.ok(c.entries.every((e) => e.name === null && e.lane >= 1), 'names stay private; lanes are enough to match');
  const mapping = lanes.map((e, i) => ({ row: i, entry_id: e.id }));

  const bad = await api('POST', `/tracking/sheets/${s.id}/session-proposals`, { token: timer.token, body: { session_id: session.id, mapping: mapping.slice(0, 3) } });
  assert.equal(bad.status, 422); assert.match(bad.body.error.message, /not matched to a row/);
  const dupe = await api('POST', `/tracking/sheets/${s.id}/session-proposals`, { token: timer.token, body: { session_id: session.id, mapping: [...mapping.slice(0, 3), { row: 0, entry_id: mapping[3].entry_id }] } });
  assert.equal(dupe.status, 400);
  assert.equal((await api('POST', `/tracking/sheets/${s.id}/session-proposals`, { token: nobody.token, body: { session_id: session.id, mapping } })).status, 404, 'not their sheet');

  const sub = await api('POST', `/tracking/sheets/${s.id}/session-proposals`, { token: timer.token, body: { session_id: session.id, mapping } });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  assert.equal(sub.body.state, 'proposed'); assert.equal(sub.body.payload.results.length, 4);
  assert.deepEqual(sub.body.payload.results.map((r) => r.value), [12.4, 11.9, 12.1, 13]);
  const again = await api('POST', `/tracking/sheets/${s.id}/session-proposals`, { token: timer.token, body: { session_id: session.id, mapping } });
  assert.equal(again.status, 201); assert.equal(again.body.duplicate, true); assert.equal(again.body.id, sub.body.id, 'a repeat does not make a second proposal');

  // nothing official moved
  const before_ = (await api('GET', `/sessions/${session.id}`, { token: org.token })).body;
  assert.ok(before_.entries.every((e) => e.result_status === 'registered'));
  assert.notEqual(before_.status, 'completed');

  // reviewers: the submitter and strangers cannot approve; the organiser sees it waiting
  assert.equal((await api('POST', `/tracking/proposals/${sub.body.id}/review`, { token: timer.token, body: { decision: 'approve' } })).status, 403);
  assert.equal((await api('GET', `/tracking/proposals/${sub.body.id}`, { token: nobody.token })).status, 404);
  const waiting = await api('GET', '/tracking/awaiting-review', { token: org.token });
  assert.equal(waiting.body.some((p) => p.id === sub.body.id && p.action === 'review' && p.kind === 'session'), true);
  const view = await api('GET', `/tracking/proposals/${sub.body.id}`, { token: org.token });
  assert.equal(view.status, 200); assert.equal(view.body.kind, 'session'); assert.equal(view.body.session.label, session.label);
  assert.equal(view.body.can_review, true); assert.equal(view.body.can_apply, false);
  assert.equal((await api('POST', `/tracking/proposals/${sub.body.id}/apply`, { token: org.token })).status, 409, 'approval first');

  const ok = await api('POST', `/tracking/proposals/${sub.body.id}/review`, { token: org.token, body: { decision: 'approve' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.state, 'approved');
  assert.equal((await api('POST', `/tracking/proposals/${sub.body.id}/apply`, { token: nobody.token })).status, 404);
  const applied = await api('POST', `/tracking/proposals/${sub.body.id}/apply`, { token: org.token });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.already_applied, false);
  const after_ = (await api('GET', `/sessions/${session.id}`, { token: org.token })).body;
  assert.equal(after_.status, 'completed');
  const byLane = Object.fromEntries(after_.entries.map((e) => [e.lane, e]));
  assert.equal(+byLane[2].result_value, 11.9); assert.equal(byLane[2].position, 1, 'the fastest time takes first place');
  assert.deepEqual(lanes.map((e) => byLane[e.lane].position), [3, 1, 2, 4]);
  const again2 = await api('POST', `/tracking/proposals/${sub.body.id}/apply`, { token: org.token });
  assert.equal(again2.body.already_applied, true, 'applying twice records nothing twice');
  assert.equal((await api('GET', `/tracking/proposals/${sub.body.id}`, { token: org.token })).body.state, 'applied');
  assert.equal((await api('GET', `/tracking/sheets/${s.id}`, { token: timer.token })).body.session.label, session.label, 'the sheet remembers its session');
});

test('a changed session makes an approved proposal stale; reviews can ask for changes; units and marks are checked', async () => {
  const { org, session } = await heat();
  const timer = await signup(['athlete']);
  const lanes = [...session.entries].sort((a, b) => a.lane - b.lane);
  const s = await sheetFor(timer, lanes.map((_, i) => ({ lane: String(i + 1), name: `L${i + 1}`, result: `${12 + i}.5` })));
  const mapping = lanes.map((e, i) => ({ row: i, entry_id: e.id }));
  const sub = (await api('POST', `/tracking/sheets/${s.id}/session-proposals`, { token: timer.token, body: { session_id: session.id, mapping } })).body;
  const ch = await api('POST', `/tracking/proposals/${sub.id}/review`, { token: org.token, body: { decision: 'changes_requested', comment: 'Lane 3 looks wrong' } });
  assert.equal(ch.body.state, 'changes_requested');
  const resub = await api('POST', `/tracking/sheets/${s.id}/session-proposals`, { token: timer.token, body: { session_id: session.id, mapping } });
  assert.equal(resub.body.round, 2, 'resubmitting opens a new review round');
  assert.equal((await api('POST', `/tracking/proposals/${sub.id}/review`, { token: org.token, body: { decision: 'approve' } })).body.state, 'approved');
  // the organiser records a result by hand before applying: the approved proposal is now stale
  await api('POST', `/sessions/${session.id}/results`, { token: org.token, body: { complete: false, results: [{ entry_id: lanes[0].id, value: 20 }] } });
  const stale = await api('POST', `/tracking/proposals/${sub.id}/apply`, { token: org.token });
  assert.equal(stale.status, 409); assert.match(stale.body.error.message, /changed/);
  assert.equal((await api('GET', `/tracking/proposals/${sub.id}`, { token: org.token })).body.can_apply, false);

  // a distance sheet is not a time sheet; unreadable marks are refused; DNS is fine
  const field = await sheetFor(timer, [{ name: 'A', result: '7.1' }], { variant: 'Horizontal jump / throw' });
  const wrongUnit = await api('POST', `/tracking/sheets/${field.id}/session-proposals`, { token: timer.token, body: { session_id: session.id, mapping: [{ row: 0, entry_id: lanes[0].id }] } });
  assert.equal(wrongUnit.status, 409); assert.match(wrongUnit.body.error.message, /distances/);
  const second = await heat();
  const l2 = [...second.session.entries].sort((a, b) => a.lane - b.lane);
  const unreadable = await sheetFor(timer, [{ lane: '1', name: 'A', result: 'fast' }, { lane: '2', name: 'B', status: 'DNS' }, { lane: '3', name: 'C', result: '12.0' }, { lane: '4', name: 'D', result: '12.2' }]);
  const map2 = l2.map((e, i) => ({ row: i, entry_id: e.id }));
  const un = await api('POST', `/tracking/sheets/${unreadable.id}/session-proposals`, { token: timer.token, body: { session_id: second.session.id, mapping: map2 } });
  assert.equal(un.status, 422); assert.match(un.body.error.message, /no readable time/);
  const fixed = await sheetFor(timer, [{ lane: '1', name: 'A', result: '12.1' }, { lane: '2', name: 'B', status: 'DNS' }, { lane: '3', name: 'C', result: '12.0' }, { lane: '4', name: 'D', result: '12.2' }]);
  const ok = await api('POST', `/tracking/sheets/${fixed.id}/session-proposals`, { token: timer.token, body: { session_id: second.session.id, mapping: map2 } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.payload.results.map((r) => r.status), ['finished', 'dns', 'finished', 'finished']);
  await api('POST', `/tracking/proposals/${ok.body.id}/review`, { token: second.org.token, body: { decision: 'approve' } });
  assert.equal((await api('POST', `/tracking/proposals/${ok.body.id}/apply`, { token: second.org.token })).status, 200);
  const done = (await api('GET', `/sessions/${second.session.id}`, { token: second.org.token })).body;
  assert.equal(done.entries.find((e) => e.lane === l2[1].lane).result_status, 'dns');
  assert.equal(done.entries.find((e) => e.lane === l2[2].lane).position, 1);
});

test('an event that does not accept public submissions refuses a stranger\'s heat sheet', async () => {
  const { org, ev, session } = await heat();
  await api('POST', `/events/${ev.id}/result-approval-policy`, { token: org.token, body: { policy: { mode: 'parallel', requirements: [{ key: 'organiser', label: 'Organiser', roles: ['organiser'] }], allow_public_submission: false } } });
  const stranger = await signup(['athlete']);
  const lanes = [...session.entries].sort((a, b) => a.lane - b.lane);
  const s = await sheetFor(stranger, lanes.map((_, i) => ({ lane: String(i + 1), name: `L${i + 1}`, result: `${12 + i}.0` })));
  const r = await api('POST', `/tracking/sheets/${s.id}/session-proposals`, { token: stranger.token, body: { session_id: session.id, mapping: lanes.map((e, i) => ({ row: i, entry_id: e.id })) } });
  assert.equal(r.status, 403);
  const mine = await sheetFor(org, lanes.map((_, i) => ({ lane: String(i + 1), name: `L${i + 1}`, result: `${12 + i}.0` })));
  assert.equal((await api('POST', `/tracking/sheets/${mine.id}/session-proposals`, { token: org.token, body: { session_id: session.id, mapping: lanes.map((e, i) => ({ row: i, entry_id: e.id })) } })).status, 201, 'the organiser can always propose');
});
