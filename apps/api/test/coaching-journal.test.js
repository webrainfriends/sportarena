import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
let n = 0;
const signup = async (roles) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `cj_${n}_${roles[0]}`, display_name: `CJ ${n}`, email: `cj${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

// A team coached by `coach` with three players, plus a second assistant coach.
const setup = async () => {
  const coach = await signup(['coach']), assistant = await signup(['coach']), outsider = await signup(['coach']);
  const players = [await signup(['athlete']), await signup(['athlete']), await signup(['athlete'])];
  const team = ok(await api('POST', '/teams', { token: coach.token, body: { name: `Journal FC ${n}`, sport: 'football' } }), 201);
  const { rows: [sport] } = await pool.query("SELECT id FROM sports WHERE slug='football'");
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'coach','active') ON CONFLICT (team_id, user_id) DO UPDATE SET role='coach', status='active'", [team.id, coach.id]);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'coach','active')", [team.id, assistant.id]);
  for (const p of players) await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [team.id, p.id]);
  return { coach, assistant, outsider, players, team, sport };
};
const openSession = async (s, extra = {}) => ok(await api('POST', '/coaching/sessions', { token: s.coach.token, body: { source_type: 'team_session', source_id: randomUUID(), team_id: s.team.id, title: 'Tuesday training', scheduled_at: new Date().toISOString(), ...extra } }), 201);

test('one team session = one record with every player as a participant; repeating it creates nothing new', async () => {
  const s = await setup();
  const key = randomUUID();
  const a = await openSession(s, { source_id: key });
  const b = ok(await api('POST', '/coaching/sessions', { token: s.coach.token, body: { source_type: 'team_session', source_id: key, team_id: s.team.id, title: 'Tuesday training' } }), 201);
  assert.equal(a.id, b.id);
  const ws = ok(await api('GET', `/coaching/sessions/${a.id}`, { token: s.coach.token }));
  assert.deepEqual(ws.participants.map((p) => p.id).sort(), s.players.map((p) => p.id).sort());
  assert.ok(ws.participants.every((p) => p.attendance === 'expected'));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM bookings")).rows[0].n, 0, 'no booking is created');
  assert.equal((await api('POST', '/coaching/sessions', { token: s.outsider.token, body: { source_type: 'team_session', source_id: randomUUID(), team_id: s.team.id, title: 'x1' } })).status, 403, 'an unrelated coach cannot open a session for the team');
  assert.equal((await api('GET', `/coaching/sessions/${a.id}`, { token: s.outsider.token })).status, 404, 'guessing the id gives nothing');
  assert.equal((await api('POST', '/coaching/sessions', { token: s.players[0].token, body: { source_type: 'team_session', source_id: randomUUID(), team_id: s.team.id, title: 'x1' } })).status, 403);
});

test('plan versions are append-only; the version a session started with stays readable; completed sessions are frozen', async () => {
  const s = await setup();
  const rec = await openSession(s);
  const v1 = ok(await api('POST', `/coaching/sessions/${rec.id}/plan`, { token: s.coach.token, body: { blocks: [{ kind: 'warm_up', title: 'Rondo', duration_min: 10 }, { kind: 'skill_drill', title: 'First touch', cues: ['head up'] }] } }));
  assert.equal(v1.plan.version, 1);
  assert.ok(v1.plan.blocks.every((b) => b.id));
  assert.equal(ok(await api('POST', `/coaching/sessions/${rec.id}/start`, { token: s.coach.token })).started_plan_version, 1);
  const again = ok(await api('POST', `/coaching/sessions/${rec.id}/start`, { token: s.coach.token }));
  assert.equal(again.row_version, ok(await api('POST', `/coaching/sessions/${rec.id}/start`, { token: s.coach.token })).row_version, 'restart changes nothing');
  assert.equal((await api('POST', `/coaching/sessions/${rec.id}/plan`, { token: s.coach.token, body: { blocks: [], expected_version: 0 } })).status, 409, 'stale plan edit refused');
  const v2 = ok(await api('POST', `/coaching/sessions/${rec.id}/plan`, { token: s.coach.token, body: { blocks: [{ ...v1.plan.blocks[0] }], expected_version: 1 } }));
  assert.equal(v2.plan.version, 2);
  const ws = ok(await api('GET', `/coaching/sessions/${rec.id}`, { token: s.coach.token }));
  assert.equal(ws.plan.blocks.length, 1);
  assert.equal(ws.plan_at_start.blocks.length, 2, 'the plan it started with is intact');
  ok(await api('POST', `/coaching/sessions/${rec.id}/blocks/${v2.plan.blocks[0].id}`, { token: s.coach.token, body: { status: 'completed' } }));
  assert.equal((await api('POST', `/coaching/sessions/${rec.id}/blocks/nope`, { token: s.coach.token, body: { status: 'skipped' } })).status, 404);
  ok(await api('POST', `/coaching/sessions/${rec.id}/complete`, { token: s.coach.token, body: { team_summary: 'Good tempo' } }));
  assert.equal((await api('POST', `/coaching/sessions/${rec.id}/plan`, { token: s.coach.token, body: { blocks: [] } })).status, 409);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM coaching_session_plan_versions WHERE session_record_id=$1', [rec.id]);
  assert.equal(rows[0].n, 2);
});

test('attendance is idempotent, limited to the roster, and unmarked players are "not recorded" rather than absent', async () => {
  const s = await setup();
  const rec = await openSession(s);
  const entries = [{ athlete_id: s.players[0].id, attendance: 'present' }, { athlete_id: s.players[1].id, attendance: 'late', focus: 'Scanning' }];
  const r1 = ok(await api('POST', `/coaching/sessions/${rec.id}/attendance`, { token: s.coach.token, body: { entries } }));
  const r2 = ok(await api('POST', `/coaching/sessions/${rec.id}/attendance`, { token: s.coach.token, body: { entries } }));
  assert.deepEqual(r1.map((x) => [x.id, x.attendance, x.arrived_at]), r2.map((x) => [x.id, x.attendance, x.arrived_at]));
  assert.equal(r2.find((x) => x.id === s.players[1].id).focus, 'Scanning');
  const stranger = await signup(['athlete']);
  assert.equal((await api('POST', `/coaching/sessions/${rec.id}/attendance`, { token: s.coach.token, body: { entries: [{ athlete_id: stranger.id, attendance: 'present' }] } })).status, 400);
  assert.equal((await api('POST', `/coaching/sessions/${rec.id}/attendance`, { token: s.outsider.token, body: { entries } })).status, 404);
  const done = ok(await api('POST', `/coaching/sessions/${rec.id}/complete`, { token: s.coach.token, body: {} }));
  assert.equal(done.not_recorded, 1);
  assert.equal(ok(await api('GET', `/coaching/sessions/${rec.id}`, { token: s.coach.token })).participants.find((p) => p.id === s.players[2].id).attendance, 'expected');
});

test('observation visibility is enforced for the player, the team, other coaches and the timeline', async () => {
  const s = await setup();
  const rec = await openSession(s);
  const [p0, p1] = s.players;
  const mk = async (body) => ok(await api('POST', '/coaching/observations', { token: s.coach.token, body: { session_record_id: rec.id, ...body } }), 201);
  const priv = await mk({ athlete_id: p0.id, note: 'PRIVATE: loses focus late', skill_tag: 'focus' });
  const staff = await mk({ athlete_id: p0.id, team_id: s.team.id, note: 'STAFF: pressing triggers', visibility: 'staff', skill_tag: 'pressing' });
  const shared = await mk({ athlete_id: p0.id, note: 'SHARED: great first touch', visibility: 'player', skill_tag: 'first touch', obs_type: 'strength', follow_up: true });
  const teamNote = await mk({ team_id: s.team.id, note: 'TEAM: compact shape', visibility: 'team' });
  const other = await mk({ athlete_id: p1.id, note: 'OTHER PLAYER private' });

  const mine = ok(await api('GET', '/me/coaching-notes', { token: p0.token }));
  assert.deepEqual(mine.map((x) => x.id).sort(), [shared.id, teamNote.id].sort(), 'player sees only shared + team notes');
  assert.ok(!JSON.stringify(mine).includes('PRIVATE') && !JSON.stringify(mine).includes('STAFF'));
  assert.deepEqual(ok(await api('GET', '/me/coaching-notes', { token: p1.token })).map((x) => x.id), [teamNote.id]);
  const unrelated = await signup(['athlete']);
  assert.deepEqual(ok(await api('GET', '/me/coaching-notes', { token: unrelated.token })), []);

  const asst = ok(await api('GET', `/coaching/athletes/${p0.id}/timeline`, { token: s.assistant.token }));
  const seen = asst.filter((x) => x.kind === 'observation').map((x) => x.source_id);
  assert.deepEqual(seen, [staff.id], 'assistant coach sees only staff-visible notes, never private/shared ones');
  const own = ok(await api('GET', `/coaching/athletes/${p0.id}/timeline`, { token: s.coach.token })).filter((x) => x.kind === 'observation').map((x) => x.source_id);
  assert.deepEqual(own.sort(), [priv.id, staff.id, shared.id].sort());
  assert.ok(!own.includes(other.id));
  assert.equal((await api('GET', `/coaching/athletes/${p0.id}/timeline`, { token: s.outsider.token })).status, 403);

  const filtered = ok(await api('GET', `/coaching/athletes/${p0.id}/timeline?skill_tag=${encodeURIComponent('first touch')}`, { token: s.coach.token }));
  assert.deepEqual(filtered.map((x) => x.source_id), [shared.id]);

  const teamTl = ok(await api('GET', `/coaching/teams/${s.team.id}/timeline`, { token: s.assistant.token }));
  assert.deepEqual(teamTl.filter((x) => x.kind === 'observation').map((x) => x.source_id).sort(), [staff.id].sort(), 'assistant sees staff notes only (team-level notes are shared with the team, not staff-scoped)');
  assert.equal((await api('GET', `/coaching/teams/${s.team.id}/timeline`, { token: s.outsider.token })).status, 403);
  assert.equal((await api('GET', `/coaching/teams/${s.team.id}/timeline`, { token: p0.token })).status, 403);
});

test('invalid visibility combinations and unrelated athletes are refused; retries with a client_key are idempotent', async () => {
  const s = await setup();
  const [p0] = s.players;
  const post = (token, body) => api('POST', '/coaching/observations', { token, body });
  assert.equal((await post(s.coach.token, { note: 'no target' })).status, 400);
  assert.equal((await post(s.coach.token, { athlete_id: p0.id, note: 'x', visibility: 'team' })).status, 400, 'team visibility cannot carry an individual note');
  assert.equal((await post(s.coach.token, { team_id: s.team.id, note: 'x', visibility: 'player' })).status, 400);
  assert.equal((await post(s.coach.token, { athlete_id: p0.id, note: 'x', visibility: 'staff' })).status, 400);
  const lone = await signup(['athlete']);
  assert.equal((await post(s.coach.token, { athlete_id: lone.id, note: 'guess' })).status, 403, 'no relationship, no note');
  assert.equal((await post(s.outsider.token, { athlete_id: p0.id, note: 'guess' })).status, 403);
  assert.equal((await post(s.outsider.token, { team_id: s.team.id, note: 'guess' })).status, 403);
  const key = `device-${randomUUID()}`;
  const a = ok(await post(s.coach.token, { athlete_id: p0.id, note: 'first', client_key: key }), 201);
  const b = ok(await post(s.coach.token, { athlete_id: p0.id, note: 'first', client_key: key }), 201);
  assert.equal(a.id, b.id);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM coaching_observations WHERE coach_id=$1 AND client_key=$2', [s.coach.id, key])).rows[0].n, 1);
});

test('editing keeps history, stale edits are refused, only the author can edit', async () => {
  const s = await setup();
  const [p0] = s.players;
  const o = ok(await api('POST', '/coaching/observations', { token: s.coach.token, body: { athlete_id: p0.id, team_id: s.team.id, note: 'v1', visibility: 'staff' } }), 201);
  const e1 = ok(await api('PATCH', `/coaching/observations/${o.id}`, { token: s.coach.token, body: { row_version: 1, note: 'v2', visibility: 'coach_private' } }));
  assert.equal(e1.row_version, 2);
  assert.equal((await api('PATCH', `/coaching/observations/${o.id}`, { token: s.coach.token, body: { row_version: 1, note: 'stale' } })).status, 409);
  assert.equal((await api('PATCH', `/coaching/observations/${o.id}`, { token: s.assistant.token, body: { row_version: 2, note: 'hijack' } })).status, 404);
  const hist = ok(await api('GET', `/coaching/observations/${o.id}/history`, { token: s.coach.token }));
  assert.deepEqual(hist.map((h) => [h.rev, h.note, h.visibility]), [[1, 'v1', 'staff']]);
  // now private: the assistant no longer sees it
  const tl = ok(await api('GET', `/coaching/athletes/${p0.id}/timeline`, { token: s.assistant.token }));
  assert.equal(tl.filter((x) => x.kind === 'observation').length, 0);
});

test('when the relationship ends the coach keeps their own history but cannot add, edit or see others\' notes', async () => {
  const s = await setup();
  const [p0] = s.players;
  const mine = ok(await api('POST', '/coaching/observations', { token: s.coach.token, body: { athlete_id: p0.id, note: 'kept' } }), 201);
  await pool.query('UPDATE teams SET owner_id=$2 WHERE id=$1', [s.team.id, s.outsider.id]); // the coach no longer runs the team either
  await pool.query("UPDATE team_members SET status='left' WHERE team_id=$1 AND user_id=$2", [s.team.id, s.coach.id]);
  assert.equal((await api('POST', '/coaching/observations', { token: s.coach.token, body: { athlete_id: p0.id, note: 'new' } })).status, 403);
  assert.equal((await api('PATCH', `/coaching/observations/${mine.id}`, { token: s.coach.token, body: { row_version: 1, note: 'edit' } })).status, 403);
  assert.equal((await api('POST', '/coaching/sessions', { token: s.coach.token, body: { source_type: 'team_session', source_id: randomUUID(), team_id: s.team.id, title: 'again' } })).status, 403);
  const tl = ok(await api('GET', `/coaching/athletes/${p0.id}/timeline`, { token: s.coach.token }));
  assert.deepEqual(tl.filter((x) => x.kind === 'observation').map((x) => x.source_id), [mine.id]);
});

test('performance home lists running sessions, reviews owed and open follow-ups, scoped to the coach', async () => {
  const s = await setup();
  const [p0] = s.players;
  const rec = await openSession(s);
  ok(await api('POST', `/coaching/sessions/${rec.id}/start`, { token: s.coach.token }));
  ok(await api('POST', '/coaching/observations', { token: s.coach.token, body: { athlete_id: p0.id, note: 'revisit this', follow_up: true, session_record_id: rec.id } }), 201);
  let home = ok(await api('GET', '/coaching/home', { token: s.coach.token }));
  assert.deepEqual(home.running.map((x) => x.id), [rec.id]);
  assert.equal(home.follow_ups.length, 1);
  ok(await api('POST', `/coaching/sessions/${rec.id}/complete`, { token: s.coach.token, body: {} }));
  home = ok(await api('GET', '/coaching/home', { token: s.coach.token }));
  assert.deepEqual(home.needs_review.map((x) => x.id), [rec.id], 'completed without any summary needs a review');
  const other = ok(await api('GET', '/coaching/home', { token: s.outsider.token }));
  assert.equal(other.running.length + other.needs_review.length + other.follow_ups.length, 0);
  // the next session shows what was said last time
  const next = await openSession(s);
  const ws = ok(await api('GET', `/coaching/sessions/${next.id}`, { token: s.coach.token }));
  assert.equal(ws.previous_notes.filter((x) => x.athlete_id === p0.id && x.follow_up).length, 1);
  assert.equal((await api('GET', '/coaching/home', { token: p0.token })).status, 403);
});
