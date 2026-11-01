import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { sendFollowerAlerts } = await import('../src/spectator.js');

let server, base, n = 0;
const raw = (method, path, { token, body } = {}) => fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
const api = async (method, path, o) => { const r = await raw(method, `/api/v1${path}`, o); return { status: r.status, body: await r.json() }; };
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const signup = async (roles = ['athlete'], extra = {}) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `sp_${n}_${roles[0]}`, display_name: `Spec ${n}`, email: `sp${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } });
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

/** An open event with two teams (each with an adult player) and one game. */
async function world(extra = {}) {
  const org = await signup(['organizer']), m1 = await signup(['coach']), m2 = await signup(['coach']), p1 = await signup(['athlete']), p2 = await signup(['athlete']), fan = await signup(['athlete']);
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: `Public Cup ${++n}`, sport: 'football', city: 'Mumbai', ...extra } }), 201);
  must(await api('PATCH', `/events/${ev.id}`, { token: org.token, body: { status: 'open' } }));
  const home = must(await api('POST', '/teams', { token: m1.token, body: { name: `Reds ${n}`, sport: 'football' } }), 201);
  const away = must(await api('POST', '/teams', { token: m2.token, body: { name: `Blues ${n}`, sport: 'football' } }), 201);
  for (const [t, p] of [[home, p1], [away, p2]]) {
    await pool.query("INSERT INTO event_entries(event_id, team_id, status) VALUES ($1,$2,'accepted')", [ev.id, t.id]);
    await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active') ON CONFLICT (team_id, user_id) DO UPDATE SET status='active'", [t.id, p.id]);
  }
  const fx = (await pool.query("INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at, round) VALUES ($1,$2,$3, now() + interval '1 hour', 'Round 1') RETURNING id", [ev.id, home.id, away.id])).rows[0].id;
  return { org, m1, m2, p1, p2, fan, ev, home, away, fx };
}
const goal = (u, fx, side, player_id) => api('POST', `/fixtures/${fx}/events`, { token: u.token, body: { kind: 'goal', side, ...(player_id ? { player_id } : {}) } });
const log = (u, fx, body) => api('POST', `/fixtures/${fx}/events`, { token: u.token, body });

test('the live centre is one projection of the canonical game: clock, line-ups, subs, discipline, stats, standings impact', async () => {
  const w = await world();
  must(await api('POST', `/fixtures/${w.fx}/lineup`, { token: w.org.token, body: { side: 'home', starters: [w.p1.id] } }));
  must(await api('POST', `/fixtures/${w.fx}/lineup`, { token: w.org.token, body: { side: 'away', starters: [w.p2.id] } }));
  const before = must(await api('GET', `/public/fixtures/${w.fx}`));
  assert.equal(before.centre.clock.state, 'not_started');
  assert.equal(before.centre.standings_impact.available, false, 'nothing to project before kick-off');
  assert.deepEqual(before.centre.lineups.teams.map((t) => t.players.map((p) => p.id)), [[w.p1.id], [w.p2.id]]);
  must(await api('POST', `/fixtures/${w.fx}/start`, { token: w.org.token, body: {} }));
  must(await log(w.org, w.fx, { kind: 'period_start' }), 201);
  must(await goal(w.org, w.fx, 'home', w.p1.id), 201);
  must(await log(w.org, w.fx, { kind: 'yellow_card', side: 'away', player_id: w.p2.id, clock_seconds: 600 }), 201);
  const live = must(await api('GET', `/public/fixtures/${w.fx}`));
  assert.equal(live.centre.clock.state, 'running');
  assert.equal(live.centre.clock.official, true, 'entered by the organiser');
  assert.deepEqual(live.centre.discipline.map((e) => e.kind), ['yellow_card']);
  const goals = live.centre.stats.rows.find((r) => r.kind === 'goal');
  assert.deepEqual([goals.home, goals.away, goals.scoring], [1, 0, true]);
  const imp = live.centre.standings_impact;
  assert.equal(imp.available, true);
  assert.equal(imp.label, 'provisional');
  assert.equal(imp.rows[0].team_id, w.home.id, 'the side ahead leads the table if it ended now');
  assert.equal(imp.rows[0].moved, 1, 'it climbed one place against the official table (level on 0, ordered by name)');
  assert.equal(imp.rows[0].was_rank, 2);
  assert.ok(!JSON.stringify(live.centre).match(/email|phone|password/i));
});

test('organisers switch live-centre modules off; fans then see nothing of them; youth events never name players', async () => {
  const w = await world();
  const s = must(await api('PATCH', `/events/${w.ev.id}/public-settings`, { token: w.org.token, body: { modules: ['stats'] } }));
  assert.deepEqual(s.modules, ['stats']);
  const p = must(await api('GET', `/public/fixtures/${w.fx}`));
  assert.equal(p.centre.lineups, null);
  assert.equal(p.centre.discipline, null);
  assert.ok(p.centre.stats);
  assert.ok([403, 404].includes((await api('PATCH', `/events/${w.ev.id}/public-settings`, { token: w.fan.token, body: { modules: [] } })).status), 'only the organiser may change modules');
  const y = await world({ max_age: 14 });
  await pool.query("INSERT INTO match_appearances(fixture_id, team_id, user_id, status, source) VALUES ($1,$2,$3,'started','lineup')", [y.fx, y.home.id, y.p1.id]);
  const yp = must(await api('GET', `/public/fixtures/${y.fx}`));
  assert.equal(yp.centre.lineups.available, false);
  assert.ok(!JSON.stringify(yp).includes(y.p1.display_name), 'no player name on a youth event');
});

test('staff see operational detail from the same game; spectators and outsiders never do', async () => {
  const w = await world();
  must(await api('POST', `/fixtures/${w.fx}/start`, { token: w.org.token, body: {} }));
  must(await log(w.org, w.fx, { kind: 'period_start' }), 201);
  const staff = must(await api('GET', `/fixtures/${w.fx}/live?limit=1`, { token: w.org.token }));
  assert.equal(staff.ops.clock_official, true);
  assert.equal(staff.ops.voided_events, 0);
  assert.equal(staff.ops.sheet_status, null);
  for (const token of [w.fan.token, undefined]) assert.equal(must(await api('GET', `/fixtures/${w.fx}/live?limit=1`, { token })).ops, undefined, 'no operational block for fans');
});
