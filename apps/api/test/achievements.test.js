import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { capabilities } = await import('../src/capabilities/index.js');
const { weeklyStreak, personalBestRun, personalBestCount, weekOf, evaluate, modelFor } = await import('../src/achievements/engine.js');
const { FAMILIES, familyOf } = await import('../src/rankings/families.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
let n = 0;
const signup = async () => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `ac_${n}`, display_name: `Ac ${n}`, email: `ac${n}@example.com`, password: 'correct-horse-battery', roles: ['athlete'] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const sportId = async (slug) => (await pool.query('SELECT id FROM sports WHERE slug=$1', [slug])).rows[0].id;
const perf = async (user, by, slug, metric, value, on, { provenance = 'approved_competition', status = 'approved', direction = null, eventId = null } = {}) =>
  (await pool.query(
    `INSERT INTO performances(user_id, sport_id, event_id, metric, value, points, recorded_by, provenance, status, achieved_on, official_points, direction)
     VALUES ($1,$2,$3,$4,$5,0,$6,$7,$8,$9,0,$10) RETURNING id`, [user.id, await sportId(slug), eventId, metric, value, by.id, provenance, status, on, direction])).rows[0].id;

test('weekly streaks count Monday-to-Sunday weeks and survive this week and the last', () => {
  // 2026-10-26 is a Monday
  assert.equal(weekOf('2026-10-26'), weekOf('2026-11-01'));
  assert.notEqual(weekOf('2026-11-01'), weekOf('2026-11-02'));
  const s = weeklyStreak(['2026-10-05', '2026-10-13', '2026-10-20', '2026-10-21', '2026-10-28'], '2026-10-30');
  assert.deepEqual([s.current, s.longest, s.weeks], [4, 4, 4]);
  assert.equal(weeklyStreak(['2026-10-05', '2026-10-13'], '2026-10-30').current, 0, 'a gap of more than one week ends the run');
  assert.equal(weeklyStreak(['2026-10-20'], '2026-10-30').current, 1, 'last week still counts');
  assert.deepEqual(weeklyStreak([], '2026-10-30'), { current: 0, longest: 0, last_week_on: null, weeks: 0 });
});

test('personal-best runs respect direction: lower is better for times', () => {
  assert.deepEqual(personalBestRun([10, 12, 15, 14, 18], 'higher'), { current: 1, longest: 2 });
  assert.deepEqual(personalBestRun([12.0, 11.8, 11.5, 11.9], 'lower'), { current: 0, longest: 2 });
  assert.deepEqual(personalBestRun([5], 'higher'), { current: 0, longest: 0 });
});

test('every sport in the catalogue has a model; only the generic family is a labelled fallback', async () => {
  const sports = (await pool.query('SELECT slug, scoring, category FROM sports')).rows;
  assert.ok(sports.length > 20);
  for (const s of sports) {
    const fam = familyOf(s);
    const m = modelFor(fam);
    assert.ok(FAMILIES[fam], s.slug);
    assert.equal(m.native, FAMILIES[fam].native, s.slug);
    if (!m.native) assert.match(m.note, /Labelled fallback/, s.slug);
    assert.ok(m.shared.includes('results'), s.slug);
  }
  const r = await api('GET', '/achievements/models');
  assert.equal(r.status, 200);
  assert.equal(r.body.sports.length, sports.length);
  assert.ok(r.body.sports.every((s) => typeof s.native === 'boolean' && s.family));
  assert.ok(r.body.families.find((f) => f.family === 'generic' && !f.native));
});

test('streaks and achievements come only from approved competition results and are explained', async () => {
  const org = await signup(); const ath = await signup();
  const goal = 'football' ;
  const days = [];
  for (let i = 0; i < 4; i++) days.push(new Date(Date.now() - i * 7 * 86400000).toISOString().slice(0, 10));
  const slug = (await pool.query("SELECT slug FROM sports WHERE scoring='goals' ORDER BY slug LIMIT 1")).rows[0].slug;
  for (const d of days) await perf(ath, org, slug, 'goals', 3, d);
  // unverified evidence never counts
  await perf(ath, org, slug, 'goals', 99, days[0], { provenance: 'self_reported', status: 'recorded' });
  await perf(ath, org, slug, 'goals', 99, days[0], { status: 'submitted' });
  await pool.query("INSERT INTO awards(name, kind, user_id, awarded_by) VALUES ('Gold','medal_gold',$1,$2),('Badge only','badge',$1,$2)", [ath.id, org.id]);

  const st = await api('GET', '/me/streaks', { token: ath.token });
  assert.equal(st.status, 200);
  assert.equal(st.body.weekly.current, 4);
  assert.equal(st.body.weekly.longest, 4);

  const a = await api('GET', '/me/achievements', { token: ath.token });
  assert.equal(a.status, 200);
  assert.equal(a.body.totals.results, 4, 'only the four approved results');
  assert.equal(a.body.totals.medals, 1, 'medals count, badges do not');
  const keys = a.body.achievements.map((x) => x.key);
  assert.ok(keys.includes('results:1') && keys.includes('weekly_streak:4') && keys.includes('medals:1'));
  assert.ok(!keys.includes('results:10'));
  const first = a.body.achievements.find((x) => x.key === 'results:1');
  assert.ok(first.evidence.length >= 1 && first.evidence[0].id, 'each badge says which verified results earned it');
  assert.ok(a.body.next_up.some((x) => x.key === 'results:10' && x.progress === 4));

  // sport filter keeps native families
  const f = await api('GET', `/me/achievements?sport=${slug}`, { token: ath.token });
  assert.equal(f.body.totals.results, 4);
  assert.equal(f.body.totals.medals, 0);
});

test('a reversed result removes its achievement; nothing is stored or deleted', async () => {
  const org = await signup(); const ath = await signup();
  const id = await perf(ath, org, 'football', 'goals', 1, new Date().toISOString().slice(0, 10));
  assert.ok((await api('GET', '/me/achievements', { token: ath.token })).body.achievements.some((x) => x.key === 'results:1'));
  await pool.query("UPDATE performances SET status='rejected' WHERE id=$1", [id]);
  const r = await api('GET', '/me/achievements', { token: ath.token });
  assert.equal(r.body.achievements.length, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM performances WHERE id=$1', [id])).rows[0].n, 1);
});

test('public view: unknown person is 404, young people return nothing, evidence ids are not exposed', async () => {
  const org = await signup(); const ath = await signup(); const kid = await signup();
  const today = new Date().toISOString().slice(0, 10);
  await perf(ath, org, 'football', 'goals', 1, today);
  await perf(kid, org, 'football', 'goals', 1, today);
  await pool.query('UPDATE users SET youth_until = current_date + 400 WHERE id=$1', [kid.id]);
  const pub = await api('GET', `/people/${ath.id}/achievements`);
  assert.equal(pub.status, 200);
  assert.ok(pub.body.achievements.length >= 1);
  assert.ok(pub.body.achievements.every((x) => !('evidence' in x)));
  const k = await api('GET', `/people/${kid.id}/achievements`);
  assert.equal(k.status, 200);
  assert.deepEqual(k.body.achievements, []);
  assert.equal((await api('GET', '/people/00000000-0000-4000-8000-000000000000/achievements')).status, 404);
  assert.equal((await api('GET', '/me/streaks')).status, 401);
});

test('goal-game and cricket milestones are native; shared ones apply to any sport', () => {
  const base = { today: '2026-10-30' };
  const goals = evaluate({ ...base, results: [{ id: 'a', sport: 'football', family: 'goal_game', metric: 'goals', value: 12, direction: 'higher', on: '2026-10-01', event_id: 'e1' }] });
  assert.ok(goals.achievements.some((x) => x.key === 'goal_game_goals:10'));
  const run = evaluate({ ...base, results: [{ id: 'b', sport: 'sprint', family: 'measured', metric: 'time', value: 11, direction: 'lower', on: '2026-10-01', event_id: 'e2' }] });
  assert.ok(run.achievements.some((x) => x.key === 'results:1'));
  assert.ok(!run.achievements.some((x) => x.group?.startsWith('goal_game')));
});

test('every native family has its own milestones; only the generic fallback has none', () => {
  for (const f of ['cricket', 'goal_game', 'racket', 'measured']) assert.ok(modelFor(f).milestones.length >= 2, f);
  assert.equal(modelFor('generic').milestones.length, 0);
  const d = (id, sport, family, metric, value, on, direction = 'higher') => ({ id, sport, family, metric, value, direction, on, event_id: `e-${on}` });
  const racket = evaluate({ today: '2026-10-30', results: [d('1', 'tennis', 'racket', 'aces', 30, '2026-10-01'), d('2', 'tennis', 'racket', 'aces', 25, '2026-10-08'), d('3', 'tennis', 'racket', 'matches_won', 5, '2026-10-08'), d('4', 'tennis', 'racket', 'sets_won', 99, '2026-10-09')] });
  const keys = racket.achievements.map((x) => x.key);
  assert.ok(keys.includes('racket_aces:50') && keys.includes('racket_matches_won:5') && keys.includes('racket_sets_won:10'));
  assert.ok(!keys.includes('racket_aces:250'));
  // times are never summed: only improvements and the spread of events count
  const run = evaluate({ today: '2026-10-30', results: [
    d('a', 'athletics-100m', 'measured', '100m_time_s', 12.5, '2026-09-01', 'lower'), d('b', 'athletics-100m', 'measured', '100m_time_s', 12.1, '2026-09-15', 'lower'),
    d('c', 'athletics-100m', 'measured', '100m_time_s', 12.3, '2026-10-01', 'lower'), d('e', 'athletics-100m', 'measured', '100m_time_s', 11.9, '2026-10-10', 'lower'),
    d('f', 'long-jump', 'measured', 'distance_m', 5.1, '2026-09-02'), d('g', 'long-jump', 'measured', 'distance_m', 5.4, '2026-10-05'), d('h', 'swimming-50m', 'measured', '50m_time_s', 30, '2026-10-06', 'lower')] });
  const rec = run.achievements.find((x) => x.key === 'measured_records:1');
  const five = run.achievements.find((x) => x.key === 'measured_records:5');
  assert.ok(rec && !five, 'two improvements in the 100m plus one in the jump is three records');
  assert.equal(run.next_up.find((x) => x.key === 'measured_records:5').progress, 3);
  assert.ok(run.achievements.some((x) => x.key === 'measured_measures:3'), 'three different events');
  assert.deepEqual(personalBestCount([10, 9, 11, 8], 'lower'), [1, 3]);
});

test('capabilities are exposed over REST, OpenAPI and MCP', () => {
  const names = capabilities.map((c) => c.name);
  for (const nme of ['get_my_streaks', 'get_my_achievements', 'get_athlete_achievements', 'list_achievement_models']) assert.ok(names.includes(nme), nme);
});
