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
const signup = async () => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `pf_${n}`, display_name: `Pf ${n}`, email: `pf${n}@example.com`, password: 'correct-horse-battery', roles: ['athlete'] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const day = (offset = 0) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const log = async (u, sport, metric, value, offset) => {
  const r = await api('POST', '/performances', { token: u.token, body: { sport, metric, value, achieved_on: day(offset) } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('personal records follow the metric direction, track the previous best, and stay private', async () => {
  const a = await signup(), b = await signup();
  assert.equal((await api('GET', '/me/records')).status, 401);
  assert.deepEqual((await api('GET', '/me/records', { token: a.token })).body, [], 'no results, no records: nothing invented');

  // a time: lower is better
  await log(a, 'athletics', 'sprint_time', 12.5, -60);
  await log(a, 'athletics', 'sprint_time', 12.1, -20);
  await log(a, 'athletics', 'sprint_time', 12.3, -10);
  // a count: higher is better
  await log(a, 'football', 'goals', 2, -5);
  await log(a, 'football', 'goals', 4, -3);

  const recs = (await api('GET', '/me/records', { token: a.token })).body;
  const sprint = recs.find((r) => r.metric === 'sprint_time'), jump = recs.find((r) => r.metric === 'goals');
  assert.equal(sprint.direction, 'lower'); assert.equal(sprint.value, 12.1); assert.equal(sprint.achieved_on, day(-20));
  assert.equal(sprint.previous_best, 12.5); assert.equal(sprint.improved_by, 0.4); assert.equal(sprint.entries, 3); assert.equal(sprint.recent, true);
  assert.equal(sprint.evidence, 'self_reported'); assert.match(sprint.evidence_label, /practice/i);
  assert.equal(jump.direction, 'higher'); assert.equal(jump.value, 4); assert.equal(jump.previous_best, 2); assert.equal(jump.improved_by, 2);

  // a first result has no previous best; an old record is not "new"
  await log(a, 'football', 'assists', 7, -90);
  const first = (await api('GET', '/me/records?sport=football', { token: a.token })).body.find((r) => r.metric === 'assists');
  assert.equal(first.previous_best, null); assert.equal(first.improved_by, null); assert.equal(first.recent, false);
  assert.equal((await api('GET', '/me/records?sport=swimming', { token: a.token })).body.length, 0, 'sport filter');

  // practice and approved competition are kept apart: a competition row is its own record, never mixed with practice
  const ath = (await pool.query("SELECT id FROM sports WHERE slug='athletics'")).rows[0].id;
  await pool.query(`INSERT INTO performances(user_id, sport_id, metric, value, points, recorded_by, provenance, status, unit, direction, achieved_on)
                    VALUES ($1,$2,'sprint_time',11.9,0,$1,'approved_competition','approved','s','lower',$3)`, [a.id, ath, day(-2)]);
  const both = (await api('GET', '/me/records?sport=athletics', { token: a.token })).body.filter((r) => r.metric === 'sprint_time');
  assert.deepEqual(both.map((r) => [r.evidence, r.value]).sort(), [['approved_competition', 11.9], ['self_reported', 12.1]]);
  // unapproved competition results do not count
  await pool.query(`INSERT INTO performances(user_id, sport_id, metric, value, points, recorded_by, provenance, status, unit, direction, achieved_on)
                    VALUES ($1,$2,'sprint_time',10.0,0,$1,'approved_competition','submitted','s','lower',$3)`, [a.id, ath, day(-1)]);
  assert.equal((await api('GET', '/me/records?sport=athletics', { token: a.token })).body.find((r) => r.evidence === 'approved_competition').value, 11.9);

  assert.deepEqual((await api('GET', '/me/records', { token: b.token })).body, [], 'nobody else sees your records');
});

test('trend: oldest first, running best flagged, evidence filter, validation', async () => {
  const a = await signup();
  await log(a, 'athletics', 'sprint_time', 12.5, -60);
  await log(a, 'athletics', 'sprint_time', 12.1, -20);
  await log(a, 'athletics', 'sprint_time', 12.3, -10);
  const t = (await api('GET', '/me/trends?sport=athletics&metric=sprint_time', { token: a.token })).body;
  assert.deepEqual(t.points.map((p) => p.value), [12.5, 12.1, 12.3]);
  assert.deepEqual(t.points.map((p) => p.is_pr), [true, true, false]);
  assert.equal(t.direction, 'lower'); assert.equal(t.best, 12.1); assert.equal(t.unit, 's');
  assert.equal((await api('GET', '/me/trends?sport=athletics&metric=sprint_time&evidence=imported', { token: a.token })).body.points.length, 0);
  assert.equal((await api('GET', `/me/trends?sport=athletics&metric=sprint_time&from=${day(-30)}&to=${day(0)}`, { token: a.token })).body.points.length, 2);
  assert.equal((await api('GET', `/me/trends?sport=athletics&metric=sprint_time&from=${day(0)}&to=${day(-30)}`, { token: a.token })).status, 400);
  assert.equal((await api('GET', '/me/trends?sport=athletics', { token: a.token })).status, 400, 'metric is required');
  const none = (await api('GET', '/me/trends?sport=athletics&metric=nothing', { token: a.token })).body;
  assert.deepEqual(none.points, []); assert.equal(none.best, null);
});

test('logged matches are archived, not deleted, and stay out of history and re-imports', async () => {
  const a = await signup(), b = await signup();
  const prof = (await api('POST', '/me/sport-profiles', { token: a.token, body: { sport: 'football', role: 'athlete' } })).body;
  const m = (await api('POST', '/me/matches', { token: a.token, body: { sport_profile_id: prof.id, played_on: day(-3), opponent: 'Rovers', competition: 'League', result: 'win', score_for: 2, score_against: 1 } })).body;
  assert.equal((await api('GET', `/me/matches?sport_profile_id=${prof.id}`, { token: a.token })).body.length, 1);
  assert.equal((await api('DELETE', `/me/matches/${m.id}`, { token: b.token })).status, 404, 'not yours');
  assert.equal((await api('DELETE', `/me/matches/${m.id}`, { token: a.token })).status, 200);
  assert.equal((await api('DELETE', `/me/matches/${m.id}`, { token: a.token })).status, 404, 'already removed');
  assert.equal((await api('GET', `/me/matches?sport_profile_id=${prof.id}`, { token: a.token })).body.length, 0);
  const row = (await pool.query('SELECT archived_at, opponent FROM player_matches WHERE id=$1', [m.id])).rows[0];
  assert.ok(row.archived_at); assert.equal(row.opponent, 'Rovers', 'the data is still there');
  const s = (await api('GET', '/me/sport-profiles', { token: a.token })).body.find((p) => p.id === prof.id);
  assert.equal(s.summary.matches, 0, 'totals no longer count it');
});
