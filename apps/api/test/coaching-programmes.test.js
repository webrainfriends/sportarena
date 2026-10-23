import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

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
  const r = await api('POST', '/auth/register', { body: { handle: `cp_${n}_${roles[0]}`, display_name: `CP Person${n}`, email: `cp${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const post = (t, p, body) => api('POST', p, { token: t, body });
const get = (t, p) => api('GET', p, { token: t });
const d = (days) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const setup = async () => {
  const coach = await signup(['coach']), outsider = await signup(['coach']), gk = await signup(['athlete']), st = await signup(['athlete']);
  const team = ok(await post(coach.token, '/teams', { name: `Prog FC ${n}`, sport: 'football' }), 201);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'coach','active') ON CONFLICT (team_id, user_id) DO UPDATE SET role='coach', status='active'", [team.id, coach.id]);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status, position) VALUES ($1,$2,'player','active','Goalkeeper')", [team.id, gk.id]);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status, position) VALUES ($1,$2,'player','active','Striker')", [team.id, st.id]);
  return { coach, outsider, gk, st, team };
};

test('programmes frame goals over a period; goals attach to the right subject; progress is counts from your records', async () => {
  const s = await setup();
  assert.equal((await post(s.coach.token, '/coaching/programmes', { athlete_id: s.gk.id, title: 'x', starts_on: d(10), ends_on: d(0) })).status, 400);
  assert.equal((await post(s.outsider.token, '/coaching/programmes', { athlete_id: s.gk.id, title: 'Season', starts_on: d(0), ends_on: d(90) })).status, 403);
  const p = ok(await post(s.coach.token, '/coaching/programmes', { athlete_id: s.gk.id, kind: 'season', title: 'Autumn season', objective: 'Command the box', position: 'Goalkeeper', starts_on: d(-30), ends_on: d(60), review_cadence_days: 14 }), 201);
  const g = ok(await post(s.coach.token, '/coaching/goals', { athlete_id: s.gk.id, programme_id: p.id, title: 'Claim crosses', position: 'Goalkeeper' }), 201);
  assert.equal(g.programme_id, p.id);
  assert.equal((await post(s.coach.token, '/coaching/goals', { athlete_id: s.st.id, programme_id: p.id, title: 'Wrong player' })).status, 400, 'a programme is about one subject');
  assert.equal((await post(s.outsider.token, '/coaching/goals', { athlete_id: s.gk.id, programme_id: p.id, title: 'x1' })).status, 403);
  const goalsOf = ok(await get(s.coach.token, `/coaching/goals?programme_id=${p.id}`));
  assert.deepEqual(goalsOf.map((x) => x.id), [g.id]);
  const detail = ok(await get(s.coach.token, `/coaching/programmes/${p.id}`));
  assert.equal(detail.summary.goals_total, 1); assert.equal(detail.summary.goals_achieved, 0); assert.equal(detail.summary.sessions_held, 0);
  assert.equal((await get(s.outsider.token, `/coaching/programmes/${p.id}`)).status, 404);
  const upd = ok(await api('PATCH', `/coaching/programmes/${p.id}`, { token: s.coach.token, body: { row_version: 1, status: 'active' } }));
  assert.equal(upd.status, 'active');
  assert.equal((await api('PATCH', `/coaching/programmes/${p.id}`, { token: s.coach.token, body: { row_version: 1, status: 'completed' } })).status, 409);
  ok(await api('PATCH', `/coaching/programmes/${p.id}`, { token: s.coach.token, body: { row_version: 2, status: 'completed' } }));
  assert.equal(ok(await get(s.coach.token, `/coaching/goals?programme_id=${p.id}`))[0].status, 'planned', 'closing a programme never changes goals');
  assert.deepEqual(ok(await get(s.coach.token, `/coaching/programmes?status=completed`)).map((x) => x.id), [p.id]);
  // a team programme
  const tp = ok(await post(s.coach.token, '/coaching/programmes', { team_id: s.team.id, kind: 'block', title: 'Pre-season block', starts_on: d(0), ends_on: d(28) }), 201);
  assert.ok(tp.team_id);
});

test('a note can be linked to goals when written; the link is shared evidence, only to your own goals about the same person', async () => {
  const s = await setup();
  const g1 = ok(await post(s.coach.token, '/coaching/goals', { athlete_id: s.gk.id, title: 'Claim crosses' }), 201);
  const gOther = ok(await post(s.coach.token, '/coaching/goals', { athlete_id: s.st.id, title: 'Finishing' }), 201);
  const o = ok(await post(s.coach.token, '/coaching/observations', { athlete_id: s.gk.id, note: 'Caught three crosses', goal_ids: [g1.id] }), 201);
  const ev = ok(await get(s.coach.token, `/coaching/goals/${g1.id}`)).evidence;
  assert.deepEqual(ev.map((e) => e.evidence_id), [o.id]);
  assert.equal((await post(s.coach.token, '/coaching/observations', { athlete_id: s.gk.id, note: 'x1', goal_ids: [gOther.id] })).status, 400, 'a goal about someone else');
  const tl = ok(await get(s.coach.token, `/coaching/athletes/${s.gk.id}/timeline`)).find((x) => x.source_id === o.id);
  assert.deepEqual(tl.goal_ids, [g1.id]);
});

test('rubrics can be limited to a sport and to positions; scoring outside that is refused; units and direction are kept', async () => {
  const s = await setup();
  const r = ok(await post(s.coach.token, '/coaching/rubrics', { name: 'Goalkeeping', sport: 'football', positions: ['Goalkeeper'], dimensions: [{ key: 'claiming', name: 'Claiming crosses', scale_min: 1, scale_max: 5 }, { key: 'sprint', name: 'Sprint', scale_min: 2, scale_max: 6, direction: 'lower_is_better', unit: 's' }] }), 201);
  const score = (athlete, v = 4) => post(s.coach.token, '/coaching/observations', { athlete_id: athlete.id, team_id: s.team.id, note: 'scored', rubric_id: r.id, dimension_key: 'claiming', score: v });
  ok(await score(s.gk), 201);
  const bad = await score(s.st);
  assert.equal(bad.status, 400); assert.match(bad.body.error.message, /Goalkeeper only/);
  const listFor = async (q) => ok(await get(s.coach.token, `/coaching/rubrics?${q}`)).filter((x) => !x.standard_key).map((x) => x.id);   // the standard library is covered in coaching-goals
  assert.deepEqual(await listFor('position=Goalkeeper'), [r.id]);
  assert.deepEqual(await listFor('position=Striker'), [], 'not offered for a striker');
  assert.deepEqual(await listFor('sport=football'), [r.id]);
  assert.deepEqual(await listFor('sport=cricket'), []);
  const sprint = ok(await get(s.coach.token, '/coaching/rubrics')).find((x) => x.id === r.id).dimensions.find((d) => d.key === 'sprint');
  assert.equal(sprint.unit, 's'); assert.equal(sprint.direction, 'lower_is_better');
  // widening the positions in a new version applies from then on, and old scores keep their version
  const v2 = ok(await post(s.coach.token, '/coaching/rubrics', { rubric_id: r.id, positions: [], dimensions: [{ key: 'claiming', name: 'Claiming crosses', scale_min: 1, scale_max: 5 }] }), 201);
  assert.equal(v2.version, 2);
  assert.equal((await score(s.st)).status, 201);
});
