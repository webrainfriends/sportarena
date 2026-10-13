import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { setAiTransport } = await import('../src/ai.js');

let server, base, n = 0;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const signup = async () => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `ins_${n}`, display_name: `Ins ${n}`, email: `ins${n}@example.com`, password: 'correct-horse-battery', roles: ['athlete'] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
// a player with `wins` wins and `losses` losses in football, each win with `goals` goals, playing out of `region`
const player = async ({ region, level = 'amateur', wins, losses = 0, goals = 1 }) => {
  const u = await signup();
  const p = (await api('POST', '/me/sport-profiles', { token: u.token, body: { sport: 'football', role: 'athlete', level, ...(region ? { region } : {}) } })).body;
  const rows = [
    ...Array.from({ length: wins }, (_, k) => ({ played_on: `2026-02-${String(1 + k).padStart(2, '0')}`, result: 'win', rating: 8, goals })),
    ...Array.from({ length: losses }, (_, k) => ({ played_on: `2026-01-${String(1 + k).padStart(2, '0')}`, result: 'loss', rating: 5, goals: 0 })),
  ];
  const r = await api('POST', '/me/matches/import', { token: u.token, body: { sport_profile_id: p.id, rows } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { ...u, profile: p };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { setAiTransport(null); server.close(); await pool.end(); });

test('insights need enough matches, then compare with the region, level and sport, only once 5 other players back it', async () => {
  const me = await player({ region: 'Chennai', wins: 4, losses: 0, goals: 3 });
  assert.equal((await api('GET', '/me/insights')).status, 401);

  // alone: nothing to compare with, and nothing invented
  let r = (await api('GET', '/me/insights', { token: me.token })).body;
  assert.equal(r.ready, true);
  assert.ok(r.scopes.every((s) => s.available === false && s.comparisons.length === 0), 'no cohort of 5 yet');
  assert.equal(r.summary.ai, false, 'built-in rules when AI is off');

  // four others near me: still below the privacy floor
  for (let k = 0; k < 4; k++) await player({ region: ' chennai ', wins: 1, losses: 3, goals: 1 });
  r = (await api('GET', '/me/insights', { token: me.token })).body;
  assert.equal(r.scopes.find((s) => s.scope === 'region').available, false);
  assert.equal(r.scopes.find((s) => s.scope === 'region').size, 4);

  // a fifth, plus two elsewhere
  await player({ region: 'Chennai', wins: 1, losses: 3, goals: 1 });
  await player({ region: 'Delhi', wins: 2, losses: 2 });
  r = (await api('GET', '/me/insights', { token: me.token })).body;
  const region = r.scopes.find((s) => s.scope === 'region');
  assert.equal(region.available, true); assert.equal(region.size, 5);
  const win = region.comparisons.find((c) => c.key === 'win_rate');
  assert.equal(win.mine, 100); assert.equal(win.cohort_median, 25); assert.equal(win.percentile, 100);
  assert.equal(region.comparisons.find((c) => c.key === 'goals').percentile, 100, 'per-match stat compared too');
  assert.equal(r.scopes.find((s) => s.scope === 'sport').size, 6, 'sport-wide includes other regions');
  assert.ok(r.summary.insights.some((x) => x.tone === 'good'), 'a strength is called out');
  assert.ok(!JSON.stringify(r).includes('ins_'), 'no other player is identifiable');
});

test('a player with fewer than 3 matches is told what is needed, and AI wording is used and cached when switched on', async () => {
  const few = await player({ region: 'Pune', wins: 2 });
  const r = (await api('GET', '/me/insights', { token: few.token })).body;
  assert.equal(r.ready, false); assert.equal(r.needed, 3); assert.equal(r.matches, 2);

  const me = await player({ region: 'Pune', wins: 3, losses: 1 });
  let calls = 0;
  setAiTransport(async () => { calls++; return JSON.stringify({ headline: 'A strong start', insights: [{ title: 'Win rate', body: 'You win most matches.', tone: 'good' }], next_step: 'Keep logging.' }); });
  const a = (await api('GET', '/me/insights', { token: me.token })).body;
  assert.equal(a.summary.ai, true); assert.equal(a.summary.headline, 'A strong start');
  const b = (await api('GET', '/me/insights', { token: me.token })).body;
  assert.equal(b.summary.cached, true); assert.equal(calls, 1, 'same numbers, same answer, no second model call');
  setAiTransport(async () => 'not json');
  await api('POST', '/me/matches', { token: me.token, body: { sport_profile_id: me.profile.id, played_on: '2026-03-01', result: 'loss' } });
  const c = (await api('GET', '/me/insights', { token: me.token })).body;
  assert.equal(c.summary.ai, false, 'a bad model answer falls back to the built-in rules');
});

test('regions suggest venue cities and areas players use; a profile region can be edited', async () => {
  const u = await player({ region: 'Mumbai', wins: 3 });
  const list = (await api('GET', '/regions?q=mum', { token: u.token })).body;
  assert.deepEqual(list, ['Mumbai']);
  assert.equal((await api('PATCH', `/me/sport-profiles/${u.profile.id}`, { token: u.token, body: { region: 'Thane' } })).status, 200);
  const card = (await api('GET', '/me/sport-profiles', { token: u.token })).body.find((p) => p.id === u.profile.id);
  assert.equal(card.region, 'Thane');
});
