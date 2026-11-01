import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// #637: what offline scoring still lacked after the match-day pack (#7): the heat / final / field-flight model in the pack, the time an
// event was really pressed, replay-safe void, and the events a scorer missed while offline.
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
  const r = await api('POST', '/auth/register', { body: { handle: `og_${n}_${roles[0]}`, display_name: `Og ${n}`, email: `og${n}@example.com`, password: 'correct-horse-battery', roles } });
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

const post = (u, path, body) => api('POST', path, { token: u.token, body });
const mkTeam = async (u, sport) => (await api('POST', '/teams', { token: u.token, body: { name: `Team ${++n}`, sport } })).body;
const game = async () => {
  const org = await signup(['organizer']), ref = await signup(['referee']), ref2 = await signup(['referee']), m1 = await signup(['coach']), m2 = await signup(['coach']);
  const ev = (await api('POST', '/events', { token: org.token, body: { name: `Gap Cup ${++n}`, sport: 'football' } })).body;
  const home = await mkTeam(m1, 'football'), away = await mkTeam(m2, 'football');
  const fx = (await pool.query('INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at, status) VALUES ($1,$2,$3, now(), $4) RETURNING id', [ev.id, home.id, away.id, 'scheduled'])).rows[0].id;
  for (const r of [ref, ref2]) await pool.query("INSERT INTO fixture_officials(fixture_id, user_id, role, status) VALUES ($1,$2,'referee','accepted')", [fx, r.id]);
  await post(ref, `/fixtures/${fx}/start`, {});
  return { org, ref, ref2, fx };
};

test('a scoring event keeps the time it was pressed (bounded), and a retry is a no-op', async () => {
  const g = await game();
  const pressed = new Date(Date.now() - 20 * 60e3).toISOString();
  const a = await post(g.ref, `/fixtures/${g.fx}/events`, { kind: 'goal', side: 'home', client_key: 'o-1', occurred_at: pressed });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.ok(Math.abs(Date.parse(a.body.event.occurred_at) - Date.parse(pressed)) < 1000, 'the time of the tap, not of the sync');
  assert.ok(Date.parse(a.body.event.recorded_at) > Date.parse(pressed) + 10 * 60e3, 'recorded_at stays the server\'s own time');
  const again = await post(g.ref, `/fixtures/${g.fx}/events`, { kind: 'goal', side: 'home', client_key: 'o-1', occurred_at: new Date().toISOString() });
  assert.equal(again.body.duplicate, true);
  assert.ok(Math.abs(Date.parse(again.body.event.occurred_at) - Date.parse(pressed)) < 1000);
  const old = await post(g.ref, `/fixtures/${g.fx}/events`, { kind: 'goal', side: 'away', client_key: 'o-2', occurred_at: new Date(Date.now() - 9 * 864e5).toISOString() });
  assert.ok(Date.parse(old.body.event.occurred_at) >= Date.now() - 24 * 3600e3 - 2000, 'never more than a day back');
  const fut = await post(g.ref, `/fixtures/${g.fx}/events`, { kind: 'goal', side: 'away', client_key: 'o-3', occurred_at: new Date(Date.now() + 5 * 3600e3).toISOString() });
  assert.ok(Date.parse(fut.body.event.occurred_at) <= Date.now() + 1000, 'never in the future');
  assert.equal((await post(g.ref, `/fixtures/${g.fx}/events`, { kind: 'goal', side: 'away', occurred_at: 'soon' })).status, 400);
  const none = await post(g.ref, `/fixtures/${g.fx}/events`, { kind: 'goal', side: 'away' });
  assert.equal(none.body.event.occurred_at, null, 'an online tap carries no device time');
  await assert.rejects(pool.query('UPDATE match_events SET occurred_at=now() WHERE id=$1', [a.body.event.id]), /cannot be edited/, 'the time is a fact like the rest of the event');
});

test('a void sent twice after a lost reply acts once, over REST and MCP', async () => {
  const g = await game();
  const e = (await post(g.ref, `/fixtures/${g.fx}/events`, { kind: 'goal', side: 'home' })).body.event;
  const v1 = await post(g.ref, `/match-events/${e.id}/void`, { reason: 'wrong side', client_key: 'v-1' });
  assert.equal(v1.status, 200, JSON.stringify(v1.body));
  const v2 = await post(g.ref, `/match-events/${e.id}/void`, { reason: 'wrong side', client_key: 'v-1' });
  assert.equal(v2.status, 200, 'the retry is not a 409');
  assert.equal(v2.body.score.home, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM match_event_revisions WHERE fixture_id=$1 AND action='void'", [g.fx])).rows[0].n, 1);
  assert.equal((await post(g.ref, `/match-events/${e.id}/void`, { reason: 'again' })).status, 409, 'without a key it is refused as before');
  const e2 = (await post(g.ref, `/fixtures/${g.fx}/events`, { kind: 'goal', side: 'home' })).body.event;
  const m = await mcp('void_match_event', { id: e2.id, reason: 'mcp void', client_key: 'v-m' }, g.ref.token);
  assert.ok(!m.isError, JSON.stringify(m));
  assert.equal((await post(g.org, `/match-events/${e2.id}/void`, { reason: 'mcp void', client_key: 'v-m' })).status, 200);
});

test('a stale tap is told what it missed, without who scored it', async () => {
  const g = await game();
  const seen = (await post(g.ref, `/fixtures/${g.fx}/events`, { kind: 'goal', side: 'home' })).body.state.last_seq;
  await post(g.ref2, `/fixtures/${g.fx}/events`, { kind: 'goal', side: 'away' });
  await post(g.ref, `/fixtures/${g.fx}/events`, { kind: 'yellow_card', side: 'home' });
  const r = await post(g.ref, `/fixtures/${g.fx}/events`, { kind: 'goal', side: 'home', expected_seq: seen });
  assert.equal(r.status, 409);
  const d = r.body.error.details;
  assert.equal(d.code, 'stale_state');
  assert.deepEqual(d.missed.map((m) => [m.kind, m.by_you]), [['goal', false], ['yellow_card', true]]);
  assert.ok(d.missed.every((m) => !('recorded_by' in m) && !('player_id' in m)), 'no identity leaks into the conflict view');
});

// ---- sessions (heats, finals, field flights): the 106 timed / measured / judged sports
const session = async () => {
  const org = await signup(['organizer']), ref = await signup(['referee']), stranger = await signup(['athlete']);
  const T = org.token;
  const ev = (await api('POST', '/events', { token: T, body: { name: `Track Day ${++n}`, sport: 'multi-sport', kind: 'tournament' } })).body;
  await api('PATCH', `/events/${ev.id}/programme`, { token: T, body: { public_names: true } });
  const house = (await api('POST', `/events/${ev.id}/houses`, { token: T, body: { name: 'Red', color: '#e11' } })).body;
  const people = [];
  for (let k = 0; k < 3; k++) people.push((await api('POST', `/events/${ev.id}/participants`, { token: T, body: { full_name: `Runner ${n}-${k}`, house_id: house.id, gender: 'male', grade: '7', roll_no: `G${n}-${k}` } })).body);
  const d = (await api('POST', `/events/${ev.id}/disciplines`, { token: T, body: { sport: 'athletics', name: '100m', officials_required: 0, result_type: 'time' } })).body;
  for (const [k, p] of people.entries()) await api('POST', `/disciplines/${d.id}/nominations`, { token: T, body: { participant_id: p.id, seed: 12 + k } });
  await api('POST', `/disciplines/${d.id}/heats`, { token: T, body: { lanes: 4 } });
  const sess = (await api('GET', `/events/${ev.id}/sessions`, { query: { discipline_id: d.id } })).body[0];
  const entries = (await api('GET', `/sessions/${sess.id}`, { token: T })).body.entries.map((e) => e.id);
  await api('PATCH', `/sessions/${sess.id}`, { token: T, body: { scheduled_at: new Date(Date.now() + 3600e3).toISOString(), location: 'Track' } });
  await api('POST', '/me/sport-profiles', { token: ref.token, body: { sport: 'athletics', role: 'referee' } });
  const staff = (await api('POST', `/events/${ev.id}/staff`, { token: T, body: { user_id: ref.id, role: 'referee', sport: 'athletics' } })).body;
  await api('POST', `/event-staff/${staff.id}/respond`, { token: ref.token, body: { response: 'accept' } });
  assert.equal((await api('POST', `/event-staff/${staff.id}/shifts`, { token: T, body: { session_id: sess.id } })).status, 201);
  return { org, ref, stranger, sess, entries };
};

test('the pack carries the heats the caller may score, with the log and the pinned config the device projects from', async () => {
  const s = await session();
  const mine = await api('GET', '/me/scorer-pack', { token: s.ref.token });
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.deepEqual(mine.body.sessions.map((x) => x.session.id), [s.sess.id]);
  const p = mine.body.sessions[0];
  assert.equal(p.viewer.can_score, true);
  assert.deepEqual(p.config.entryIds.slice().sort(), s.entries.slice().sort());
  assert.equal(p.config.resultType, 'time');
  assert.equal(typeof p.config.lowerIsBetter, 'boolean');
  assert.deepEqual(p.events, []);
  assert.deepEqual((await api('GET', '/me/scorer-pack', { token: s.org.token })).body.sessions.map((x) => x.session.id), [s.sess.id], 'the organiser too');
  assert.deepEqual((await api('GET', '/me/scorer-pack', { token: s.stranger.token })).body.sessions, [], 'a stranger gets nothing');
  assert.deepEqual((await api('GET', '/me/scorer-pack', { token: s.stranger.token, query: { session_id: s.sess.id } })).body.sessions, [], 'nor by id, and no hint the session exists');
  assert.equal((await api('GET', '/me/scorer-pack', { token: s.ref.token, query: { session_id: s.sess.id } })).body.sessions.length, 1);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='scorer_pack.download'", [s.ref.id])).rowCount >= 1, 'taking it is audited');
  const m = await mcp('get_scorer_pack', {}, s.ref.token);
  assert.ok(!m.isError, JSON.stringify(m));
  const sc = m.structuredContent ?? JSON.parse(m.content[0].text);
  assert.equal((sc.sessions ?? sc.result?.sessions).length, 1, 'the same capability over MCP');
});

test('a heat keeps the device time and a void retry acts once; the pack includes voided events for the device to replay', async () => {
  const s = await session();
  const pressed = new Date(Date.now() - 15 * 60e3).toISOString();
  const [e1, e2] = s.entries;
  const f1 = await post(s.ref, `/sessions/${s.sess.id}/events`, { kind: 'finish', entry_id: e1, payload: { value: 11.2 }, client_key: 'sf-1', occurred_at: pressed });
  assert.equal(f1.status, 201, JSON.stringify(f1.body));
  assert.ok(Math.abs(Date.parse(f1.body.event.occurred_at) - Date.parse(pressed)) < 1000);
  const bad = (await post(s.ref, `/sessions/${s.sess.id}/events`, { kind: 'finish', entry_id: e2, payload: { value: 99 }, client_key: 'sf-2' })).body.event;
  const v1 = await post(s.ref, `/session-events/${bad.id}/void`, { reason: 'wrong lane', client_key: 'sv-1' });
  assert.equal(v1.status, 200, JSON.stringify(v1.body));
  assert.equal((await post(s.ref, `/session-events/${bad.id}/void`, { reason: 'wrong lane', client_key: 'sv-1' })).status, 200, 'the retry is not a 409');
  assert.equal((await post(s.ref, `/session-events/${bad.id}/void`, { reason: 'again' })).status, 409);
  const p = (await api('GET', '/me/scorer-pack', { token: s.ref.token })).body.sessions[0];
  assert.deepEqual(p.events.map((e) => [e.seq, e.voided]), [[1, false], [2, true]], 'the whole log with its voids');
  const stale = await post(s.ref, `/sessions/${s.sess.id}/events`, { kind: 'finish', entry_id: e2, payload: { value: 12 }, expected_seq: 0 });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body.error.details.missed.map((m) => [m.kind, m.by_you]), [['finish', true], ['finish', true]]);
});

// ---- the device: every sport family is accounted for, now including the session model
test('offline catalogue walk: every session-model sport keeps scoring on the device with the server\'s own plugin, and every sport has exactly one native model', async () => {
  const sports = (await pool.query('SELECT slug, name, scoring, category, play_type FROM sports ORDER BY slug')).rows;
  const { liveModelOf } = await import('../src/scoring/rulesets.js');
  const { sessionDefaults } = await import('../src/scoring/session.js');
  const { projectSession, sessionReject } = await import('../../app/src/scorer/local.js');
  let walked = 0;
  for (const sport of sports) {
    if (liveModelOf(sport).model !== 'session') continue;
    walked++;
    const d = sessionDefaults(sport);
    const config = { resultType: sport.scoring === 'time' ? 'time' : sport.scoring === 'distance' ? 'distance' : 'score', entryIds: ['a', 'b'], field: d.aggregate !== 'best' || sport.scoring === 'distance', aggregate: d.aggregate, lowerIsBetter: d.lowerIsBetter || sport.scoring === 'time', dropExtremes: false, progression: {} };
    const pack = { session: { id: 's', status: 'scheduled' }, config, events: [], last_seq: 0, projection: { entries: [{ entry_id: 'a', name: 'A' }, { entry_id: 'b', name: 'B' }] }, live: { state: 'scheduled' } };
    const taps = (entry, v) => (d.aggregate === 'panel' ? { kind: 'judge_score', entry_id: entry, payload: { judge: 1, round: 1, value: v } }
      : config.field ? { kind: 'attempt', entry_id: entry, payload: { round: 1, outcome: 'valid', value: v } } : { kind: 'finish', entry_id: entry, payload: { value: v } });
    const first = taps('a', 10), second = taps('b', 12);
    let g = projectSession(pack, []);
    assert.equal(sessionReject(g, first.kind, first.entry_id, first.payload), null, `${sport.slug}: the first entry is accepted offline`);
    g = projectSession(pack, [{ ...first, client_key: 'k1' }, { ...second, client_key: 'k2' }]);
    assert.equal(g.provisional, true, sport.slug);
    assert.equal(g.waiting, 2);
    const ranked = g.projection.entries.filter((e) => e.rank != null).sort((x, y) => x.rank - y.rank);
    assert.equal(ranked.length, 2, `${sport.slug}: both marks are placed on the device`);
    assert.equal(ranked[0].entry_id, config.lowerIsBetter ? 'a' : 'b', `${sport.slug}: the direction of the sport decides the winner, as on the server`);
    assert.equal(g.projection.entries.find((e) => e.entry_id === 'a').name, 'A', 'names come from the saved read');
    // a void waiting to be sent removes the mark at once, and a heat the device finalises is shown as waiting, not as official
    const saved = { ...pack, events: [{ id: 'ev1', seq: 1, ...first, voided: false }], last_seq: 1 };
    const voided = projectSession(saved, [{ op: 'void', target: 'ev1', client_key: 'v1' }, { op: 'finalize', client_key: 'f1' }]);
    assert.equal(voided.projection.entries.find((e) => e.entry_id === 'a').rank, null, `${sport.slug}: a waiting void takes the mark off`);
    assert.equal(voided.finalizing, true);
    assert.notEqual(voided.live.state, 'final');
  }
  assert.ok(walked >= 100, `walked ${walked} session sports`);
});

test('offline undo and correct: a waiting void or correction is applied by the same engine, a correction of something already gone is refused', async () => {
  const { builtinRuleset, rulesetSchema } = await import('../src/scoring/rulesets.js');
  const { computeScore } = await import('../src/scoring/engine.js');
  const { project, correctionReject } = await import('../../app/src/scorer/local.js');
  const rs = rulesetSchema.parse(builtinRuleset({ slug: 'football', scoring: 'goals', category: 'team_ball', play_type: 'team' }));
  const mk = (seq, kind, side, extra = {}) => ({ id: `e${seq}`, seq, kind, side, period: 1, payload: {}, voided_at: null, ...extra });
  const events = [mk(1, 'period_start', null), mk(2, 'goal', 'home'), mk(3, 'goal', 'away')];
  const game = { fixture: { status: 'live' }, ruleset: rs, events, last_seq: 3, knockout: false, live: { state: 'live' }, version: 3, score: computeScore(rs, events) };
  assert.deepEqual(project(game, []).score, { ...game.score });
  const undone = project(game, [{ op: 'void', target: 'e2', reason: 'oops', client_key: 'v', occurred_at: new Date().toISOString() }]);
  assert.equal(undone.score.home, 0, 'the void shows at once');
  assert.equal(undone.events.find((e) => e.id === 'e2').void_reason, 'Waiting to be sent');
  assert.equal(game.events.find((e) => e.id === 'e2').voided_at, null, 'the saved log itself is untouched');
  const fixed = project(game, [{ op: 'correct', target: 'e2', side: 'away', reason: 'wrong side', client_key: 'c' }]);
  assert.deepEqual([fixed.score.home, fixed.score.away], [0, 2], 'the correction replaces the goal where it was');
  assert.equal(correctionReject(game, 'e2', { side: 'away' }), null);
  assert.match(correctionReject(game, 'nope', { side: 'away' }), /already voided or corrected/);
});
