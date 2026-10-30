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
const mcp = async (name, args, token) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  return (await r.json()).result;
};
let n = 0;
const signup = async (roles) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `ls_${n}_${roles[0]}`, display_name: `Ls ${n}`, email: `ls${n}@example.com`, password: 'correct-horse-battery', roles } });
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


const mkTeam = async (u, sport) => (await api('POST', '/teams', { token: u.token, body: { name: `Team ${++n}`, sport } })).body;
const setup = async (sport = 'football', { at = 'now()', status = 'scheduled' } = {}) => {
  const org = await signup(['organizer']), ref = await signup(['referee']), m1 = await signup(['coach']), m2 = await signup(['coach']), rando = await signup(['athlete']);
  const ev = (await api('POST', '/events', { token: org.token, body: { name: `Pack Cup ${++n}`, sport } })).body;
  const home = await mkTeam(m1, sport), away = await mkTeam(m2, sport);
  const fx = (await pool.query(`INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at, status) VALUES ($1,$2,$3, ${at}, $4) RETURNING id`, [ev.id, home.id, away.id, status])).rows[0].id;
  await pool.query("INSERT INTO fixture_officials(fixture_id, user_id, role, status) VALUES ($1,$2,'referee','accepted')", [fx, ref.id]);
  return { org, ref, m1, m2, rando, ev, home, away, fx };
};
const post = (u, path, body) => api('POST', path, { token: u.token, body });

test('the pack holds only the games the caller may score, with state, pinned rules and lineup', async () => {
  const s = await setup();
  const other = await setup('basketball', { at: "now() + interval '3 days'" });   // outside the window
  const mine = await api('GET', '/me/scorer-pack', { token: s.ref.token });
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.deepEqual(mine.body.games.map((g) => g.fixture.id), [s.fx]);
  const g = mine.body.games[0];
  assert.ok(g.ruleset.kind && Array.isArray(g.lineup) && g.viewer.can_score === true && typeof g.last_seq === 'number');
  // the organiser has it too; a team manager, a stranger and the other game's referee do not
  assert.deepEqual((await api('GET', '/me/scorer-pack', { token: s.org.token })).body.games.map((x) => x.fixture.id), [s.fx]);
  for (const u of [s.m1, s.rando, other.ref]) assert.deepEqual((await api('GET', '/me/scorer-pack', { token: u.token })).body.games, [], 'not a scorer of any game in the window');
  assert.equal((await api('GET', '/me/scorer-pack')).status, 401);
  // a wider window brings the later game in for its own referee only
  assert.equal((await api('GET', '/me/scorer-pack', { token: other.ref.token, query: { hours_ahead: 100 } })).body.games.length, 1);
  assert.equal((await pool.query("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='scorer_pack.download'", [s.ref.id])).rowCount, 1, 'taking a pack is audited');
});

test('a released official loses the pack on the next read', async () => {
  const s = await setup();
  assert.equal((await api('GET', '/me/scorer-pack', { token: s.ref.token })).body.games.length, 1);
  await pool.query("UPDATE fixture_officials SET status='released' WHERE fixture_id=$1", [s.fx]);
  assert.deepEqual((await api('GET', '/me/scorer-pack', { token: s.ref.token })).body.games, []);
});

test('controls sent late keep the real time and a retry cannot act twice', async () => {
  const s = await setup();
  const pressed = new Date(Date.now() - 40 * 60e3).toISOString();
  const k1 = (await post(s.ref, `/fixtures/${s.fx}/start`, { client_key: 'c-start', occurred_at: pressed }));
  assert.equal(k1.status, 200, JSON.stringify(k1.body));
  const row = () => pool.query('SELECT status, started_at, finished_at FROM fixtures WHERE id=$1', [s.fx]).then((r) => r.rows[0]);
  assert.ok(Math.abs(new Date((await row()).started_at) - Date.parse(pressed)) < 1000, 'kick-off is when it was pressed, not when it was sent');
  const again = await post(s.ref, `/fixtures/${s.fx}/start`, { client_key: 'c-start', occurred_at: new Date().toISOString() });
  assert.equal(again.status, 200, 'the lost-reply retry is a no-op, not a 409');
  assert.ok(Math.abs(new Date((await row()).started_at) - Date.parse(pressed)) < 1000, 'and does not move the kick-off');
  assert.equal((await post(s.ref, `/fixtures/${s.fx}/start`, { client_key: 'other' })).status, 409, 'a different key on a live game is refused as before');
  assert.equal((await post(s.ref, `/fixtures/${s.fx}/pause`, { client_key: 'c-pause' })).status, 200);
  assert.equal((await post(s.ref, `/fixtures/${s.fx}/pause`, { client_key: 'c-pause' })).status, 200, 'pause retry');
  assert.equal((await post(s.ref, `/fixtures/${s.fx}/resume`, { client_key: 'c-resume' })).status, 200);
  assert.equal((await post(s.ref, `/fixtures/${s.fx}/resume`, { client_key: 'c-resume' })).status, 200, 'resume retry');
  const end = await post(s.ref, `/fixtures/${s.fx}/end`, { client_key: 'c-end' });
  assert.equal(end.status, 200, JSON.stringify(end.body));
  const end2 = await post(s.ref, `/fixtures/${s.fx}/end`, { client_key: 'c-end' });
  assert.equal(end2.status, 200);
  assert.equal(end2.body.id, end.body.id, 'the same sheet comes back, no second sheet');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM score_sheets WHERE fixture_id=$1', [s.fx])).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM fixture_control_ops WHERE fixture_id=$1', [s.fx])).rows[0].n, 4);
});

test('a device clock cannot rewrite history: the time is clamped to the last 24 hours and never the future', async () => {
  const s = await setup();
  const future = await post(s.ref, `/fixtures/${s.fx}/start`, { client_key: 'f', occurred_at: new Date(Date.now() + 5 * 3600e3).toISOString() });
  assert.equal(future.status, 200);
  const t = new Date((await pool.query('SELECT started_at FROM fixtures WHERE id=$1', [s.fx])).rows[0].started_at).getTime();
  assert.ok(t <= Date.now() + 1000, 'not in the future');
  const s2 = await setup();
  await post(s2.ref, `/fixtures/${s2.fx}/start`, { client_key: 'old', occurred_at: new Date(Date.now() - 9 * 24 * 3600e3).toISOString() });
  const t2 = new Date((await pool.query('SELECT started_at FROM fixtures WHERE id=$1', [s2.fx])).rows[0].started_at).getTime();
  assert.ok(t2 >= Date.now() - 24 * 3600e3 - 2000, 'not more than a day back');
  assert.equal((await post(s2.ref, `/fixtures/${s2.fx}/pause`, { client_key: 'x', occurred_at: 'not a time' })).status, 400);
});

test('only the organiser or the match officials can use the controls, with or without a key', async () => {
  const s = await setup();
  for (const u of [s.m1, s.rando]) for (const op of ['start', 'pause', 'resume', 'end']) assert.equal((await post(u, `/fixtures/${s.fx}/${op}`, { client_key: `k-${op}` })).status, 403, op);
  assert.equal((await pool.query('SELECT status FROM fixtures WHERE id=$1', [s.fx])).rows[0].status, 'scheduled');
});

test('the controls and the pack are exposed over MCP too, from the same definitions', async () => {
  const s = await setup();
  const r = await mcp('get_scorer_pack', {}, s.ref.token);
  assert.ok(!r.isError, JSON.stringify(r));
  const sc = r.structuredContent ?? JSON.parse(r.content[0].text);
  assert.equal((sc.games ?? sc.result?.games).length, 1);
  const st = await mcp('start_match', { id: s.fx, client_key: 'm-1' }, s.ref.token);
  assert.ok(!st.isError, JSON.stringify(st));
});

test('the pack carries the whole log (not a page) and one game can be refreshed by id', async () => {
  const s = await setup();
  await post(s.ref, `/fixtures/${s.fx}/start`, {});
  for (let k = 0; k < 60; k++) await post(s.ref, `/fixtures/${s.fx}/events`, { kind: 'period_start', client_key: `p${k}` }).then(() => null);
  const g = (await api('GET', '/me/scorer-pack', { token: s.ref.token, query: { fixture_id: s.fx } })).body.games[0];
  assert.equal(g.events.length, g.last_seq, 'every event, so the device can replay the game');
  assert.equal(typeof g.knockout, 'boolean');
  assert.deepEqual((await api('GET', '/me/scorer-pack', { token: s.m1.token, query: { fixture_id: s.fx } })).body.games, [], 'a team manager gets nothing, not an error that confirms the game');
});

test('offline: every head-to-head sport in the catalogue is scored on the device by the server\'s own engine, and every sport is accounted for', async () => {
  const sports = (await pool.query('SELECT slug, name, scoring, category, play_type FROM sports ORDER BY slug')).rows;
  assert.ok(sports.length >= 200, `catalogue has ${sports.length} sports`);
  const { builtinRuleset, rulesetSchema, liveModelOf } = await import('../src/scoring/rulesets.js');
  const { computeScore } = await import('../src/scoring/engine.js');
  const { project, localReject, controlReject } = await import('../../app/src/scorer/local.js');
  const by = {};
  for (const sport of sports) {
    const { model } = liveModelOf(sport);
    (by[model] ??= []).push(sport.slug);
    if (model === 'session') continue;   // heats, finals and field flights run in the session pad (same queue, no match controls)
    const rs = rulesetSchema.parse(builtinRuleset(sport));
    const game = { fixture: { status: 'scheduled' }, ruleset: rs, events: [], last_seq: 0, knockout: false, live: { state: 'scheduled' }, version: 0, score: computeScore(rs, []) };
    assert.equal(controlReject(game, 'start'), null, `${sport.slug}: kick-off is allowed on a scheduled game`);
    assert.ok(controlReject(game, 'pause'), `${sport.slug}: a game that has not started cannot be paused`);
    const ev = model === 'outcome' ? { kind: 'result', payload: { outcome: 'home', method: 'decision' } } : model === 'cards' ? { kind: 'round_card', payload: { judge: 1, round: 1, home: 10, away: 9 } }
      : rs.kind === 'points_events' ? { kind: rs.events[0].kind, side: 'home' } : rs.kind === 'cricket' ? { kind: 'ball', side: 'home', payload: { bowler: 0, runs: 1 } } : { kind: 'point', side: 'home' };
    const pending = [{ op: 'start', client_key: 'k0', occurred_at: new Date().toISOString() }];
    if (rs.kind === 'points_events') pending.push({ kind: 'period_start', client_key: 'k1' });
    const started = project(game, pending);
    assert.equal(started.fixture.status, 'live', `${sport.slug}: the queued kick-off makes the game live on the device`);
    assert.equal(localReject(started, ev), null, `${sport.slug}: ${ev.kind} is accepted offline`);
    const out = project(game, [...pending, { ...ev, client_key: 'k2' }]);
    assert.equal(out.provisional, true);
    assert.equal(out.waiting, pending.length + 1);
    assert.equal(out.last_seq, pending.filter((p) => !p.op).length + 1, `${sport.slug}: waiting taps continue the sequence`);
    assert.deepEqual(out.score, computeScore(rs, out.events), `${sport.slug}: the device shows what the server's engine computes from the same log`);
    assert.equal(localReject(project(game, []), ev), 'Start the match first', `${sport.slug}: nothing can be scored before kick-off`);
  }
  assert.equal(Object.values(by).reduce((n, l) => n + l.length, 0), sports.length, 'every sport has exactly one model');
  console.log('# offline models by sport:', Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.length])));
});

test('the device merges a newer read into its saved copy, and asks for a fresh download when it cannot join them', async () => {
  const { mergeLive, project } = await import('../../app/src/scorer/local.js');
  const { builtinRuleset, rulesetSchema } = await import('../src/scoring/rulesets.js');
  const rs = rulesetSchema.parse(builtinRuleset({ slug: 'football', scoring: 'goals', category: 'team_ball', play_type: 'team' }));
  const ev = (seq, kind, extra = {}) => ({ seq, kind, side: 'home', period: 1, payload: {}, voided_at: null, ...extra });
  const saved = { fixture: { status: 'live' }, ruleset: rs, events: [ev(1, 'period_start', { side: null }), ev(2, 'goal')], last_seq: 2, version: 2, knockout: false, lineup: [{ user_id: 'u1' }], viewer: { can_score: true } };
  const next = (events, last_seq, version) => ({ fixture: { status: 'live' }, ruleset: rs, events, last_seq, version, viewer: { can_score: true } });
  const joined = mergeLive(saved, next([ev(2, 'goal'), ev(3, 'goal')], 3, 3));
  assert.equal(joined.last_seq, 3);
  assert.equal(joined.score.home, 2, 'the new goal is added to the saved log');
  assert.deepEqual(joined.lineup, saved.lineup, 'the saved lineup is kept');
  const voided = mergeLive(saved, next([ev(2, 'goal', { voided_at: '2026-01-01T00:00:00Z' })], 2, 3));
  assert.equal(voided.score.home, 0, 'a void made elsewhere is picked up');
  assert.equal(mergeLive(saved, next([ev(9, 'goal')], 9, 9)), null, 'events 3 to 8 are missing: download the game again');
  assert.equal(mergeLive(null, next([], 0, 0)), null);
  // taps still waiting sit on top of whatever was merged
  const shown = project(joined, [{ kind: 'goal', side: 'away', client_key: 'w1' }]);
  assert.deepEqual([shown.score.home, shown.score.away], [2, 1]);
});
