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
const setup = async (sport = 'football', { roundKind } = {}) => {
  const org = await signup(['organizer']), ref = await signup(['referee']), m1 = await signup(['coach']), m2 = await signup(['coach']), rando = await signup(['athlete']);
  const ev = (await api('POST', '/events', { token: org.token, body: { name: `Live Cup ${++n}`, sport } })).body;
  const home = await mkTeam(m1, sport), away = await mkTeam(m2, sport);
  const fx = (await pool.query('INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at, round_kind) VALUES ($1,$2,$3, now(), $4) RETURNING id', [ev.id, home.id, away.id, roundKind ?? null])).rows[0].id;
  await pool.query("INSERT INTO fixture_officials(fixture_id, user_id, role, status) VALUES ($1,$2,'referee','accepted')", [fx, ref.id]);
  return { org, ref, m1, m2, rando, ev, home, away, fx };
};
const log = (u, fx, body) => api('POST', `/fixtures/${fx}/events`, { token: u.token, body });
const start = (u, fx) => api('POST', `/fixtures/${fx}/start`, { token: u.token });

/** Read a server-sent-event stream for up to `ms`, or until `done(frames)`; returns the parsed frames. */
async function frames(path, { token, headers = {}, ms = 1500, done } = {}) {
  const ac = new AbortController();
  const r = await fetch(`${base}/api/v1${path}`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, signal: ac.signal });
  if (r.status !== 200) { const body = await r.text(); ac.abort(); return { status: r.status, frames: [], body }; }
  const out = [];
  const timer = setTimeout(() => ac.abort(), ms);
  let buf = '';
  try {
    for await (const chunk of r.body) {
      buf += Buffer.from(chunk).toString();
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2);
        const f = {};
        for (const line of raw.split('\n')) { const m = /^(\w+): ?(.*)$/.exec(line); if (m) f[m[1]] = m[2]; }
        if (f.event) out.push({ id: f.id, event: f.event, data: JSON.parse(f.data) });
      }
      if (done?.(out)) break;
    }
  } catch { /* aborted */ }
  clearTimeout(timer); ac.abort();
  return { status: 200, frames: out };
}

test('retries cannot duplicate events, scorers are serialised, and stale writers are told', async () => {
  const { ref, org, fx } = await setup();
  await start(ref, fx);
  await log(ref, fx, { kind: 'period_start' });
  // the same tap sent five times at once (flaky network retry) is one event
  const same = await Promise.all(Array.from({ length: 5 }, () => log(ref, fx, { kind: 'goal', side: 'home', client_key: 'tap-0001' })));
  assert.deepEqual(same.map((r) => r.status), [201, 201, 201, 201, 201]);
  assert.equal(same.filter((r) => r.body.duplicate).length, 4);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM match_events WHERE fixture_id=$1 AND kind='goal'", [fx])).rows[0].n, 1);
  // two officials scoring at the same time never share or skip a sequence number
  const both = await Promise.all(Array.from({ length: 10 }, (_, k) => log(k % 2 ? ref : org, fx, { kind: 'foul', side: k % 2 ? 'home' : 'away', client_key: `par-${k}-xxxxxxxx` })));
  assert.ok(both.every((r) => r.status === 201));
  const seqs = (await pool.query('SELECT seq FROM match_events WHERE fixture_id=$1 ORDER BY seq', [fx])).rows.map((r) => r.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1), 'a gap-free log');
  // a scorer that last saw seq 2 is refused with the current state
  const stale = await log(ref, fx, { kind: 'goal', side: 'away', expected_seq: 2, client_key: 'late-00001' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.details.code, 'stale_state');
  assert.equal(stale.body.error.details.state.score.away, 0);
  const fresh = await log(ref, fx, { kind: 'goal', side: 'away', expected_seq: stale.body.error.details.last_seq, client_key: 'late-00001' });
  assert.equal(fresh.status, 201);
  // authority is stored with the event
  const rows = (await pool.query('SELECT DISTINCT source_authority FROM match_events WHERE fixture_id=$1 AND kind=$2', [fx, 'foul'])).rows.map((r) => r.source_authority).sort();
  assert.deepEqual(rows, ['official', 'organiser']);
});

test('corrections keep the original, name the authority, replay the rest of the game, and the database refuses silent edits', async () => {
  const { ref, org, rando, m1, fx } = await setup();
  await start(ref, fx);
  await log(ref, fx, { kind: 'period_start' });
  const g1 = (await log(ref, fx, { kind: 'goal', side: 'home', clock_seconds: 300 })).body.event;
  await log(ref, fx, { kind: 'goal', side: 'home', clock_seconds: 600 });
  assert.equal((await api('POST', `/match-events/${g1.id}/correct`, { token: rando.token, body: { reason: 'wrong team', side: 'away' } })).status, 403);
  assert.equal((await api('POST', `/match-events/${g1.id}/correct`, { token: m1.token, body: { reason: 'wrong team', side: 'away' } })).status, 403, 'team managers cannot correct');
  assert.equal((await api('POST', `/match-events/${g1.id}/correct`, { token: ref.token, body: { reason: 'nothing to change' } })).status, 400);
  const c = await api('POST', `/match-events/${g1.id}/correct`, { token: ref.token, body: { reason: 'scored for the other side', side: 'away', client_key: 'corr-00001' } });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.deepEqual([c.body.state.score.home, c.body.state.score.away], [1, 1]);
  assert.equal(c.body.event.supersedes_id, g1.id);
  assert.equal(c.body.event.position_seq, g1.seq, 'the replacement keeps its place in play order');
  assert.equal((await api('POST', `/match-events/${g1.id}/correct`, { token: ref.token, body: { reason: 'again', side: 'home' } })).status, 409, 'the original is already corrected');
  assert.equal((await api('POST', `/match-events/${g1.id}/correct`, { token: ref.token, body: { reason: 'retry', side: 'away', client_key: 'corr-00001' } })).body.duplicate, true);
  // history: original is voided, never gone; the revision names who, as what, and why
  const orig = (await pool.query('SELECT voided_at, void_reason FROM match_events WHERE id=$1', [g1.id])).rows[0];
  assert.ok(orig.voided_at); assert.match(orig.void_reason, /Corrected: scored for the other side/);
  const rev = (await pool.query('SELECT action, authority, reason, before, after FROM match_event_revisions WHERE match_event_id=$1', [g1.id])).rows;
  assert.equal(rev.length, 1); assert.equal(rev[0].action, 'correct'); assert.equal(rev[0].authority, 'official'); assert.equal(rev[0].before.side, 'home'); assert.equal(rev[0].after.side, 'away');
  const g2 = (await pool.query("SELECT id FROM match_events WHERE fixture_id=$1 AND kind='goal' AND voided_at IS NULL AND side='home'", [fx])).rows[0].id;
  assert.equal((await api('POST', `/match-events/${g2}/void`, { token: org.token, body: { reason: 'offside, goal disallowed' } })).status, 200);
  assert.deepEqual((await pool.query('SELECT action, authority FROM match_event_revisions WHERE match_event_id=$1', [g2])).rows, [{ action: 'void', authority: 'organiser' }]);
  // the database itself refuses to edit or delete a recorded event or its revisions
  await assert.rejects(pool.query("UPDATE match_events SET side='away' WHERE id=$1", [g1.id]), /cannot be edited/);
  await assert.rejects(pool.query('DELETE FROM match_events WHERE id=$1', [g1.id]), /never deleted/);
  await assert.rejects(pool.query("UPDATE match_event_revisions SET reason='x' WHERE match_event_id=$1", [g1.id]), /append-only/);
  await assert.rejects(pool.query('DELETE FROM match_event_revisions WHERE match_event_id=$1', [g1.id]), /append-only/);
  // timeline: spectators see what counts (with the correction marked), officials also see what was voided
  const spectator = (await api('GET', `/fixtures/${fx}/timeline`)).body, official = (await api('GET', `/fixtures/${fx}/timeline`, { token: ref.token })).body;
  assert.ok(spectator.events.every((e) => !e.voided));
  assert.equal(spectator.events.find((e) => e.corrects_seq === g1.seq).side, 'away');
  assert.ok(official.events.some((e) => e.voided && e.void_reason));
  assert.ok(spectator.events.every((e) => e.void_reason === undefined && e.id === undefined), 'no internals for spectators');
  assert.equal(official.version, official.last_seq + 2, 'version moves on every correction and void');
});

test('a correction that would make a later event illegal is refused and names that event', async () => {
  const { org, ref, ev, fx } = await setup('badminton');
  const rs = { kind: 'sets', label: 'Short', sets: { best_of: 1, points_to_win: 3, win_by: 1, cap: null, deciding_points: null }, draw_allowed: false, events: [], stats: [] };
  assert.equal((await api('POST', `/events/${ev.id}/scoring-template`, { token: org.token, body: { ruleset: rs } })).status, 201);
  await start(ref, fx);
  const ids = [];
  for (const side of ['home', 'home', 'away', 'away', 'home']) ids.push((await log(ref, fx, { kind: 'point', side })).body.event);
  assert.equal((await log(ref, fx, { kind: 'point', side: 'away' })).status, 400, '3-2 decided the set');
  // 4th point was away: making the 3rd point home would end the set at 3-0, so points 4 and 5 become illegal
  const bad = await api('POST', `/match-events/${ids[2].id}/correct`, { token: ref.token, body: { reason: 'it was home', side: 'home' } });
  assert.equal(bad.status, 409, JSON.stringify(bad.body));
  assert.equal(bad.body.error.details.code, 'correction_invalidates_later_events');
  assert.match(bad.body.error.message, /already decided/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM match_events WHERE fixture_id=$1 AND supersedes_id IS NOT NULL", [fx])).rows[0].n, 0, 'nothing was written');
});

test('tennis: points make games and sets; the projection shows the call, tie-break and server', async () => {
  const { ref, fx } = await setup('tennis');
  await start(ref, fx);
  await log(ref, fx, { kind: 'server', side: 'home' });
  for (const side of ['home', 'away', 'home', 'away', 'home', 'away']) await log(ref, fx, { kind: 'point', side });   // 40-40
  let p = (await api('GET', `/fixtures/${fx}/projection`)).body;
  assert.equal(p.ruleset.kind, 'sets'); assert.equal(p.projection.current_game.call, 'Deuce'); assert.equal(p.projection.server, 'home');
  await log(ref, fx, { kind: 'point', side: 'away' }); await log(ref, fx, { kind: 'point', side: 'away' });
  p = (await api('GET', `/fixtures/${fx}/projection`)).body;
  assert.deepEqual(p.projection.current_set, { home: 0, away: 1 });
  assert.equal(p.projection.server, 'away', 'serve changes after every game');
  assert.equal(p.live.state, 'live');
  assert.equal((await log(ref, fx, { kind: 'server', side: 'away' })).status, 400, 'the first server is set before the first point');
});

test('cricket: ball by ball with a declared batting order; projection has run rate, target and attributed scorecard', async () => {
  const { ref, fx } = await setup('cricket');
  await start(ref, fx);
  const players = [];
  for (let k = 0; k < 4; k++) players.push(await signup(['athlete']));
  const order = { home: players.map((p) => p.id), away: [] };
  assert.equal((await log(ref, fx, { kind: 'lineup', payload: { home: [players[0].id, players[0].id] } })).status, 400, 'a batting order has no duplicates');
  assert.equal((await log(ref, fx, { kind: 'lineup', payload: order })).status, 201);
  const ball = (side, runs, extra = {}) => log(ref, fx, { kind: 'ball', side, period: side === 'home' ? 1 : 2, payload: { bowler: 0, runs, ...extra } });
  for (const r of [4, 1, 6, 0, 2, 1]) assert.equal((await ball('home', r)).status, 201);
  assert.equal((await log(ref, fx, { kind: 'innings_end', side: 'home' })).status, 201);
  assert.equal((await ball('away', 4)).status, 201);
  const p = (await api('GET', `/fixtures/${fx}/projection`)).body;
  assert.equal(p.projection.target, 15); assert.equal(p.projection.to_win, 11);
  assert.equal(p.projection.current_run_rate, 24); assert.equal(typeof p.projection.required_run_rate, 'number');
  assert.equal(p.projection.innings[0].runs, 14);
  const bat = p.players.find((x) => x.role === 'batting' && x.innings === 1 && x.slot === 0);
  assert.equal(bat.player_id, players[0].id); assert.equal(bat.runs, 5, '4 then a single, then strike is rotated');
  assert.equal(p.players.find((x) => x.role === 'batting' && x.innings === 2 && x.slot === 0).player_id, null, 'no batting order for the away side: nothing invented');
});

test('football cup tie: extra time, then a shoot-out, only in a knockout game and only when level', async () => {
  const { org, ref, ev, fx } = await setup('football', { roundKind: 'final' });
  const rs = { kind: 'points_events', label: 'Cup football', periods: { count: 2, label: 'Half' }, events: [{ kind: 'goal', label: 'Goal', points: 1 }], stats: [{ kind: 'yellow_card', label: 'Yellow card' }], extra_time: { periods: 2, minutes: 15 }, shootout: { rounds: 3 }, draw_allowed: false };
  assert.equal((await api('POST', `/events/${ev.id}/scoring-template`, { token: org.token, body: { ruleset: rs } })).status, 201);
  await start(ref, fx);
  const period = async (k, ...evts) => { await log(ref, fx, { kind: 'period_start', period: k }); for (const e of evts) await log(ref, fx, e); return log(ref, fx, { kind: 'period_end' }); };
  await period(1, { kind: 'goal', side: 'home' }); await period(2, { kind: 'goal', side: 'away' });
  assert.equal((await log(ref, fx, { kind: 'shootout_goal', side: 'home' })).status, 400, 'extra time is played first');
  await period(3); await period(4);
  assert.equal((await log(ref, fx, { kind: 'period_start', period: 5 })).status, 400);
  const seq = [['home', 'shootout_goal'], ['away', 'shootout_miss'], ['home', 'shootout_goal']];
  for (const [side, kind] of seq) assert.equal((await log(ref, fx, { kind, side })).status, 201);
  assert.equal((await log(ref, fx, { kind: 'shootout_goal', side: 'home' })).status, 400, "it is away's kick");
  const last = await log(ref, fx, { kind: 'shootout_miss', side: 'away' });
  assert.equal(last.body.state.score.shootout.winner, 'home');
  const p = (await api('GET', `/fixtures/${fx}/projection`)).body;
  assert.deepEqual([p.projection.home, p.projection.away], [1, 1], 'the shoot-out never changes the match score');
  assert.equal(p.projection.shootout.goals.home, 2);
  // a group game with the same rules has neither
  const g = await setup('football');
  assert.equal((await api('POST', `/events/${g.ev.id}/scoring-template`, { token: g.org.token, body: { ruleset: rs } })).status, 201);
  await start(g.ref, g.fx);
  for (const k of [1, 2]) { await log(g.ref, g.fx, { kind: 'period_start', period: k }); await log(g.ref, g.fx, { kind: 'period_end' }); }
  const no = await log(g.ref, g.fx, { kind: 'period_start', period: 3 });
  assert.equal(no.status, 400); assert.match(no.body.error.message, /knockout/);
});

test('players named on an event must be in the declared lineup; a sent-off player cannot be used again', async () => {
  const { ref, home, fx } = await setup();
  const a = await signup(['athlete']), b = await signup(['athlete']), outsider = await signup(['athlete']);
  await pool.query("INSERT INTO match_appearances(fixture_id, team_id, user_id, status, source) VALUES ($1,$2,$3,'started','lineup'),($1,$2,$4,'started','lineup')", [fx, home.id, a.id, b.id]);
  await start(ref, fx);
  await log(ref, fx, { kind: 'period_start' });
  const bad = await log(ref, fx, { kind: 'goal', side: 'home', player_id: outsider.id });
  assert.equal(bad.status, 400); assert.match(bad.body.error.message, /lineup/);
  assert.equal((await log(ref, fx, { kind: 'goal', side: 'home', player_id: a.id, payload: { assist_player_id: b.id } })).status, 201);
  assert.equal((await log(ref, fx, { kind: 'goal', side: 'home', player_id: a.id, payload: { assist_player_id: outsider.id } })).status, 400);
  assert.equal((await log(ref, fx, { kind: 'red_card', side: 'home', player_id: b.id })).status, 201);
  const again = await log(ref, fx, { kind: 'foul', side: 'home', player_id: b.id });
  assert.equal(again.status, 400); assert.match(again.body.error.message, /sent off/);
  const p = (await api('GET', `/fixtures/${fx}/projection`)).body;
  assert.equal(p.players.find((x) => x.player_id === a.id).points, 1);
  assert.equal(p.players.find((x) => x.player_id === b.id).events.assist, 1);
});

test('spectators and team managers can read live state but not mutate it, over REST and MCP alike', async () => {
  const { ref, rando, m1, fx } = await setup();
  await start(ref, fx);
  await log(ref, fx, { kind: 'period_start' });
  const goal = (await log(ref, fx, { kind: 'goal', side: 'home' })).body.event;
  for (const [who, expect] of [[rando, 403], [m1, 403], [{ token: undefined }, 401]]) {
    for (const [method, path, body] of [
      ['POST', `/fixtures/${fx}/events`, { kind: 'goal', side: 'home' }],
      ['POST', `/match-events/${goal.id}/void`, { reason: 'because' }],
      ['POST', `/match-events/${goal.id}/correct`, { reason: 'because', side: 'away' }],
      ['POST', `/fixtures/${fx}/scorer-lease`, {}],
      ['POST', `/fixtures/${fx}/pause`, {}],
    ]) assert.equal((await api(method, path, { token: who.token, body })).status, expect, `${who.handle ?? 'anon'} ${path}`);
  }
  for (const [name, args] of [['log_match_event', { id: fx, kind: 'goal', side: 'home' }], ['correct_match_event', { id: goal.id, reason: 'because', side: 'away' }], ['claim_scorer_lease', { id: fx }]]) {
    const denied = await mcp(name, args, rando.token);
    assert.equal(denied.isError, true, name); assert.equal(JSON.parse(denied.content[0].text).code, 'forbidden', name);
    const ok = await mcp(name, args, ref.token);
    assert.notEqual(ok.isError, true, `${name}: ${ok.content?.[0]?.text}`);
  }
  for (const path of [`/fixtures/${fx}/projection`, `/fixtures/${fx}/timeline`, `/fixtures/${fx}/live`]) assert.equal((await api('GET', path)).status, 200, path);
  const live = (await api('GET', `/fixtures/${fx}/projection`)).body;
  assert.equal(live.viewer.can_score, false); assert.equal(live.scorer, undefined, 'the scorer lease is for officials');
  assert.equal((await api('GET', `/fixtures/${fx}/projection`, { token: ref.token })).body.viewer.can_score, true);
});

test('the scorer lease is a hint: held by one official, taken over only by the organiser', async () => {
  const { org, ref, fx } = await setup();
  await start(ref, fx);
  const c1 = await api('POST', `/fixtures/${fx}/scorer-lease`, { token: ref.token, body: { device: 'iPad' } });
  assert.equal(c1.status, 200, JSON.stringify(c1.body));
  const other = await signup(['referee']);
  await pool.query("INSERT INTO fixture_officials(fixture_id, user_id, role, status) VALUES ($1,$2,'scorer','accepted')", [fx, other.id]);
  const held = await api('POST', `/fixtures/${fx}/scorer-lease`, { token: other.token });
  assert.equal(held.status, 409); assert.equal(held.body.error.details.code, 'lease_held');
  assert.equal((await api('POST', `/fixtures/${fx}/scorer-lease`, { token: other.token, body: { takeover: true } })).status, 403, 'an official cannot take over');
  assert.equal((await api('POST', `/fixtures/${fx}/scorer-lease`, { token: org.token, body: { takeover: true } })).status, 200);
  assert.equal((await api('GET', `/fixtures/${fx}/projection`, { token: ref.token })).body.scorer.user_id, org.id);
  assert.equal((await api('POST', `/fixtures/${fx}/scorer-lease/release`, { token: org.token })).body.released, true);
  assert.equal((await api('POST', `/fixtures/${fx}/scorer-lease`, { token: other.token })).status, 200);
  assert.equal((await log(ref, fx, { kind: 'period_start' })).status, 201, 'the lease never blocks the server\'s own ordering');
});

test('live stream: spectators resume from a cursor; scorer streams are private and close the moment authority is revoked', async () => {
  const { org, ref, rando, fx } = await setup();
  await start(ref, fx);
  await log(ref, fx, { kind: 'period_start' });
  await log(ref, fx, { kind: 'goal', side: 'home' });
  await log(ref, fx, { kind: 'goal', side: 'away' });
  // a fresh spectator gets a state frame with an id; reconnecting with it returns only what was missed
  const first = await frames(`/live/fixtures/${fx}`, { done: (f) => f.length >= 1 });
  assert.equal(first.status, 200);
  const s1 = first.frames[0];
  assert.match(s1.id, /^\d+:\d+$/); assert.equal(s1.data.last_seq, 3);
  await log(ref, fx, { kind: 'goal', side: 'home' });
  const resumed = await frames(`/live/fixtures/${fx}`, { headers: { 'last-event-id': s1.id }, done: (f) => f.length >= 1 });
  assert.deepEqual(resumed.frames[0].data.events.map((e) => e.seq), [4], 'only the missed event');
  assert.equal(resumed.frames[0].data.score.home, 2);
  assert.ok(resumed.frames[0].data.events.every((e) => !('void_reason' in e) && !('source_authority' in e)), 'no internals for spectators');
  // the scorer stream is for officials only; to anyone else it does not exist
  assert.equal((await frames(`/live/fixtures/${fx}/scorer`)).status, 401);
  assert.equal((await frames(`/live/fixtures/${fx}/scorer`, { token: rando.token })).status, 404);
  // revoke the official while the stream is open, then score: the stream says so and closes
  const watching = frames(`/live/fixtures/${fx}/scorer`, { token: ref.token, ms: 4000, done: (f) => f.some((x) => x.event === 'revoked') });
  await new Promise((r) => setTimeout(r, 400));
  await pool.query("UPDATE fixture_officials SET status='released' WHERE fixture_id=$1 AND user_id=$2", [fx, ref.id]);
  await log(org, fx, { kind: 'goal', side: 'away' });
  const out = await watching;
  assert.equal(out.status, 200);
  assert.equal(out.frames[0].event, 'state'); assert.equal(out.frames[0].data.scorer, null);
  assert.ok(out.frames.some((f) => f.event === 'revoked'), JSON.stringify(out.frames.map((f) => [f.event, f.data.message ?? f.data.last_seq])));
  assert.equal((await log(ref, fx, { kind: 'goal', side: 'home' })).status, 403, 'and the next write is refused');
});

test('sessions: a heat is run live, stays provisional, then becomes the official result through record_session_results', async () => {
  const org = await signup(['organizer']), ref = await signup(['referee']), stranger = await signup(['athlete']);
  const T = org.token;
  const ev = (await api('POST', '/events', { token: T, body: { name: `Track Day ${++n}`, sport: 'multi-sport', kind: 'tournament' } })).body;
  assert.equal((await api('PATCH', `/events/${ev.id}/programme`, { token: T, body: { public_names: true } })).status, 200);
  const house = (await api('POST', `/events/${ev.id}/houses`, { token: T, body: { name: 'Red', color: '#e11' } })).body;
  const people = [];
  for (let k = 0; k < 3; k++) people.push((await api('POST', `/events/${ev.id}/participants`, { token: T, body: { full_name: `Runner ${n}-${k}`, house_id: house.id, gender: 'male', grade: '7', roll_no: `L${n}-${k}` } })).body);
  const d = (await api('POST', `/events/${ev.id}/disciplines`, { token: T, body: { sport: 'athletics', name: '100m', officials_required: 0, result_type: 'time' } })).body;
  for (const [k, p] of people.entries()) assert.equal((await api('POST', `/disciplines/${d.id}/nominations`, { token: T, body: { participant_id: p.id, seed: 12 + k } })).status, 201);
  assert.equal((await api('POST', `/disciplines/${d.id}/heats`, { token: T, body: { lanes: 4 } })).status, 201);
  const sess = (await api('GET', `/events/${ev.id}/sessions`, { query: { discipline_id: d.id } })).body[0];
  const detail = (await api('GET', `/sessions/${sess.id}`, { token: T })).body;
  const [e1, e2, e3] = detail.entries.map((e) => e.id);
  // the assigned official: hired, accepted, on a shift for this session
  assert.equal((await api('PATCH', `/sessions/${sess.id}`, { token: T, body: { scheduled_at: new Date(Date.now() + 5 * 864e5).toISOString(), location: 'Track' } })).status, 200);
  assert.equal((await api('POST', '/me/sport-profiles', { token: ref.token, body: { sport: 'athletics', role: 'referee' } })).status, 201);
  const post = (await api('POST', `/events/${ev.id}/staff`, { token: T, body: { user_id: ref.id, role: 'referee', sport: 'athletics' } })).body;
  await api('POST', `/event-staff/${post.id}/respond`, { token: ref.token, body: { response: 'accept' } });
  const shift = await api('POST', `/event-staff/${post.id}/shifts`, { token: T, body: { session_id: sess.id } });
  assert.equal(shift.status, 201);
  const ev$ = (u, body) => api('POST', `/sessions/${sess.id}/events`, { token: u.token, body });
  assert.equal((await ev$(stranger, { kind: 'start' })).status, 403);
  assert.equal((await ev$({ token: undefined }, { kind: 'start' })).status, 401);
  assert.equal((await ev$(ref, { kind: 'status', payload: { status: 'call_room' } })).status, 201);
  assert.equal((await ev$(ref, { kind: 'start', client_key: 'gun-000001' })).status, 201);
  assert.equal((await ev$(ref, { kind: 'start', client_key: 'gun-000001' })).body.duplicate, true);
  assert.equal((await ev$(ref, { kind: 'split', entry_id: e1, payload: { distance_m: 50, value: 5.4 } })).status, 201);
  assert.equal((await ev$(ref, { kind: 'split', entry_id: e1, payload: { distance_m: 40, value: 4.9 } })).status, 400, 'splits only increase');
  assert.equal((await ev$(ref, { kind: 'finish', entry_id: e2, payload: { value: 11.9 } })).status, 201);
  assert.equal((await ev$(ref, { kind: 'finish', entry_id: e1, payload: { value: 11.2 } })).status, 201);
  const mis = await ev$(ref, { kind: 'finish', entry_id: e3, payload: { value: 99 } });
  assert.equal(mis.status, 201);
  await api('POST', `/session-events/${mis.body.event.id}/void`, { token: ref.token, body: { reason: 'wrong lane' } });
  assert.equal((await ev$(ref, { kind: 'finish', entry_id: e3, payload: { value: 12.4 }, expected_seq: 1 })).body.error.details.code, 'stale_state');
  assert.equal((await ev$(ref, { kind: 'finish', entry_id: e3, payload: { value: 12.4 } })).status, 201);
  const live = (await api('GET', `/sessions/${sess.id}/live`)).body;
  assert.equal(live.live.state, 'provisional'); assert.equal(live.live.provisional, true);
  assert.deepEqual(live.projection.entries.map((e) => [e.entry_id, e.rank]), [[e1, 1], [e2, 2], [e3, 3]]);
  assert.match(live.projection.entries[0].name, /Runner/);
  assert.equal(live.projection.entries.every((e) => e.q === ''), true, 'no progression was pinned, so none is shown');
  assert.equal(live.events.some((e) => e.id !== undefined), false, 'spectators get no internals');
  assert.equal((await api('GET', `/sessions/${sess.id}`)).body.entries.every((e) => e.position == null), true, 'nothing official yet');
  // pinned progression drives Q/q, and only that
  assert.equal((await api('PATCH', `/disciplines/${d.id}/live-rules`, { token: ref.token, body: { qualifiers_per_session: 1, wildcards: 1 } })).status, 403);
  assert.equal((await api('PATCH', `/disciplines/${d.id}/live-rules`, { token: T, body: { qualifiers_per_session: 1, wildcards: 1 } })).status, 200);
  assert.deepEqual((await api('GET', `/sessions/${sess.id}/live`)).body.projection.entries.map((e) => e.q), ['Q', 'q', '']);
  // the assigned official's scorer stream closes the moment their shift is cancelled
  assert.equal((await frames(`/live/sessions/${sess.id}/scorer`)).status, 401);
  const watching = frames(`/live/sessions/${sess.id}/scorer`, { token: ref.token, ms: 4000, done: (f) => f.some((x) => x.event === 'revoked') });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await api('POST', `/shifts/${shift.body.id}/cancel`, { token: T })).status, 200);
  assert.equal((await ev$(org, { kind: 'split', entry_id: e2, payload: { distance_m: 50, value: 5.9 } })).status, 201);
  const closed = await watching;
  assert.equal(closed.frames[0].event, 'state');
  assert.ok(closed.frames.some((f) => f.event === 'revoked'), 'the session scorer stream is closed when the shift is cancelled');
  assert.equal((await ev$(ref, { kind: 'finish', entry_id: e3, payload: { value: 10 } })).status, 403, 'and so are writes');
  // finalise: same checks as record_session_results, now official
  assert.equal((await api('POST', `/sessions/${sess.id}/finalize-live`, { token: stranger.token })).status, 403);
  const fin = await api('POST', `/sessions/${sess.id}/finalize-live`, { token: T });
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  assert.equal(fin.body.completed, true);
  assert.deepEqual(fin.body.entries.map((e) => [e.id, e.position]).sort(), [[e1, 1], [e2, 2], [e3, 3]].sort());
  assert.equal((await api('GET', `/sessions/${sess.id}/live`)).body.live.state, 'final');
  // recording the result again after completion is a correction, and the public view says so
  const redo = await api('POST', `/sessions/${sess.id}/results`, { token: T, body: { complete: true, results: [{ entry_id: e1, value: 11.45 }, { entry_id: e2, value: 11.87 }, { entry_id: e3, value: 12.4 }] } });
  assert.equal(redo.status, 200, JSON.stringify(redo.body));
  const corrected = (await api('GET', `/sessions/${sess.id}/live`)).body;
  assert.equal(corrected.live.state, 'corrected'); assert.equal(corrected.live.corrected, true);
  assert.equal((await ev$(org, { kind: 'finish', entry_id: e3, payload: { value: 10 } })).status, 409, 'a completed session is corrected through its result');
  await assert.rejects(pool.query('DELETE FROM session_events WHERE session_id=$1', [sess.id]), /never deleted/);
  // live scorer stream for sessions is private too
  assert.equal((await frames(`/live/sessions/${sess.id}/scorer`, { token: stranger.token })).status, 404);
  const pub = await frames(`/live/sessions/${sess.id}`, { done: (f) => f.length >= 1 });
  assert.equal(pub.frames[0].data.live.state, 'corrected', 'the public stream carries the corrected state too');
});

test('the public state moves scheduled → live → provisional → final → corrected, and the sheet starts from the corrected log', async () => {
  const t = await setup();
  const { org, ref, m1, m2, fx } = t;
  const state = async () => (await api('GET', `/fixtures/${fx}/projection`)).body.live;
  assert.equal((await state()).state, 'scheduled');
  await start(ref, fx);
  await log(ref, fx, { kind: 'period_start' });
  assert.equal((await state()).state, 'live');
  const wrong = (await log(ref, fx, { kind: 'goal', side: 'away' })).body.event;
  await log(ref, fx, { kind: 'goal', side: 'home' });
  await api('POST', `/match-events/${wrong.id}/correct`, { token: ref.token, body: { reason: 'it was the home side', side: 'home' } });
  assert.deepEqual(await state(), { state: 'live', paused: false, corrected: true });
  await log(ref, fx, { kind: 'period_end' });
  assert.equal((await api('POST', `/fixtures/${fx}/end`, { token: ref.token })).status, 200);
  assert.equal((await state()).state, 'provisional', 'full time but not yet published');
  const sheet = (await api('GET', `/fixtures/${fx}/score-sheet`, { token: org.token })).body;
  assert.deepEqual([sheet.home_score, sheet.away_score], [2, 0], 'the sheet starts from the corrected log');
  const post = (u, path, body = {}) => api('POST', path, { token: u.token, body });
  assert.equal((await post(ref, `/score-sheets/${sheet.id}/submit`)).status, 200);
  assert.equal((await post(m1, `/score-sheets/${sheet.id}/sign`, { decision: 'signed' })).status, 200);
  assert.equal((await post(m2, `/score-sheets/${sheet.id}/sign`, { decision: 'signed' })).status, 200);
  assert.equal((await post(org, `/score-sheets/${sheet.id}/approve`)).status, 200);
  assert.equal((await post(org, `/score-sheets/${sheet.id}/publish`)).status, 200);
  assert.deepEqual(await state(), { state: 'final', paused: false, corrected: true });
  assert.equal((await api('GET', `/fixtures/${fx}/live`)).body.live.state, 'final');
  const rev = await post(org, `/fixtures/${fx}/score-sheet/revise`, { reason: 'Goal credited to the wrong side' });
  assert.equal(rev.status, 201);
  assert.equal((await state()).state, 'final', 'the published result stays official while a revision is in progress');
  assert.equal((await api('PATCH', `/score-sheets/${rev.body.id}`, { token: ref.token, body: { home_score: 1, away_score: 1 } })).status, 200);
  assert.equal((await post(ref, `/score-sheets/${rev.body.id}/submit`)).status, 200);
  assert.equal((await post(m1, `/score-sheets/${rev.body.id}/sign`, { decision: 'signed' })).status, 200);
  assert.equal((await post(m2, `/score-sheets/${rev.body.id}/sign`, { decision: 'signed' })).status, 200);
  assert.equal((await post(org, `/score-sheets/${rev.body.id}/approve`)).status, 200);
  assert.equal((await post(org, `/score-sheets/${rev.body.id}/publish`)).status, 200);
  const after = (await api('GET', `/fixtures/${fx}/projection`)).body;
  assert.equal(after.live.state, 'corrected', 'a published result that was revised is shown as corrected');
  assert.deepEqual([after.fixture.final.home, after.fixture.final.away], [1, 1]);
});

test('spectators are never told who a young person is without a guardian\'s current consent; officials still see everything', async () => {
  const { ref, home, away, fx } = await setup();
  const adult = await signup(['athlete']), kid = await signup(['athlete']), rival = await signup(['athlete']);
  await pool.query('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);
  for (const [u, team] of [[adult, home], [kid, home], [rival, away]]) await pool.query("INSERT INTO match_appearances(fixture_id, team_id, user_id, status, source) VALUES ($1,$2,$3,'started','lineup')", [fx, team.id, u.id]);
  await start(ref, fx);
  await log(ref, fx, { kind: 'period_start' });
  await log(ref, fx, { kind: 'goal', side: 'home', player_id: adult.id, payload: { assist_player_id: kid.id } });
  await log(ref, fx, { kind: 'goal', side: 'home', player_id: kid.id });
  await log(ref, fx, { kind: 'yellow_card', side: 'away', player_id: rival.id });
  const ids = (events) => events.map((e) => e.player_id);
  const pub = (await api('GET', `/fixtures/${fx}/live`)).body, off = (await api('GET', `/fixtures/${fx}/live`, { token: ref.token })).body;
  assert.deepEqual(ids(pub.events.filter((e) => e.kind === 'goal')), [adult.id, null], 'the young person is not named publicly');
  assert.equal(pub.events.find((e) => e.kind === 'goal').payload.assist_player_id, null);
  assert.deepEqual(ids(off.events.filter((e) => e.kind === 'goal')), [adult.id, kid.id], 'officials see who scored');
  const tl = (await api('GET', `/fixtures/${fx}/timeline`)).body;
  assert.equal(tl.events.some((e) => e.player_id === kid.id), false);
  const proj = (await api('GET', `/fixtures/${fx}/projection`)).body;
  assert.equal(proj.players.some((p) => p.player_id === kid.id), false); assert.ok(proj.players.some((p) => p.player_id === adult.id));
  assert.ok((await api('GET', `/fixtures/${fx}/projection`, { token: ref.token })).body.players.some((p) => p.player_id === kid.id));
  const sse = await frames(`/live/fixtures/${fx}`, { done: (f) => f.length >= 1 });
  assert.equal(JSON.stringify(sse.frames[0].data).includes(kid.id), false, 'nor on the live stream');
  // a guardian's current consent brings them back, and withdrawing it hides them again on the very next read
  const guardian = await signup(['athlete']);
  await pool.query("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [guardian.id, kid.id]);
  await pool.query("INSERT INTO youth_consents(child_id, purpose, granted_by, policy_version, expires_at) VALUES ($1,'participation',$2,1, now() + interval '30 days')", [kid.id, guardian.id]);
  assert.deepEqual(ids((await api('GET', `/fixtures/${fx}/live`)).body.events.filter((e) => e.kind === 'goal')), [adult.id, kid.id]);
  await pool.query("UPDATE youth_consents SET revoked_at=now(), revoked_by=$2 WHERE child_id=$1", [kid.id, guardian.id]);
  assert.deepEqual(ids((await api('GET', `/fixtures/${fx}/live`)).body.events.filter((e) => e.kind === 'goal')), [adult.id, null]);
});

test('every sport in the catalogue has a defined live model; nothing is silently left without one', async () => {
  const sports = (await pool.query('SELECT slug, name, scoring, category, play_type FROM sports ORDER BY slug')).rows;
  assert.ok(sports.length >= 200, `catalogue has ${sports.length} sports`);
  const { builtinRuleset, rulesetSchema, liveModelOf } = await import('../src/scoring/rulesets.js');
  const { pluginFor } = await import('../src/scoring/plugins/index.js');
  const { computeScore, rejectReason } = await import('../src/scoring/engine.js');
  const MODELS = new Set(['points_events', 'sets', 'racket', 'cricket', 'cards', 'outcome', 'session']);
  const by = {};
  for (const sport of sports) {
    const { model, aggregate } = liveModelOf(sport);
    assert.ok(MODELS.has(model), `${sport.slug}: ${model}`);
    (by[model] ??= []).push(sport.slug);
    if (model === 'session') { assert.ok(['best', 'sum', 'panel'].includes(aggregate), `${sport.slug}: ${aggregate}`); continue; }
    const rs = rulesetSchema.parse(builtinRuleset(sport));
    const plugin = pluginFor(rs);
    for (const fn of ['state', 'validate', 'phase', 'attribution', 'liveStats', 'publicView', 'toResult']) assert.equal(typeof plugin[fn], 'function', `${sport.slug}: ${fn}`);
    assert.equal(typeof computeScore(rs, []).home, 'number', sport.slug);
    // a real scoring event is accepted and moves the score
    const ev = model === 'outcome' ? { kind: 'result', payload: { outcome: 'home', method: 'decision' } } : model === 'cards' ? { kind: 'round_card', payload: { judge: 1, round: 1, home: 10, away: 9 } }
      : rs.kind === 'points_events' ? { kind: rs.events[0].kind, side: 'home' } : rs.kind === 'cricket' ? { kind: 'ball', side: 'home', payload: { bowler: 0, runs: 1 } } : { kind: 'point', side: 'home' };
    assert.equal(rejectReason(rs, [], ev), null, `${sport.slug}: ${ev.kind} is accepted`);
    const after = computeScore(rs, [{ ...ev, seq: 1 }]);
    assert.ok(after.home > 0 || after.cricket?.home > 0 || after.current_game?.home > 0 || after.current_set?.home > 0 || after.scorecard?.judges?.[0]?.red > 0, `${sport.slug}: the score moves`);
  }
  // sports with a running score between two sides always get a head-to-head model
  for (const sport of sports.filter((x) => ['goals', 'sets', 'combat'].includes(x.scoring) || (x.scoring === 'points' && ['team_ball', 'mind', 'esports', 'combat', 'racquet'].includes(x.category)))) {
    assert.notEqual(liveModelOf(sport).model, 'session', `${sport.slug} is head to head`);
  }
  for (const slug of ['chess', 'judo', 'valorant']) if (sports.some((x) => x.slug === slug)) assert.equal(liveModelOf(sports.find((x) => x.slug === slug)).model, 'outcome', slug);
  // judged, timed and measured sports are scored as sessions with the right aggregate
  for (const sport of sports.filter((x) => x.scoring === 'judged')) assert.equal(liveModelOf(sport).aggregate, 'panel', sport.slug);
  for (const sport of sports.filter((x) => x.scoring === 'time')) assert.deepEqual([liveModelOf(sport).model, liveModelOf(sport).lowerIsBetter], ['session', true], sport.slug);
  assert.ok(by.cricket.includes('cricket') && by.racket.includes('tennis') && by.racket.includes('padel') && by.cards.includes('boxing'), 'native models are used where they exist');
  assert.equal(Object.values(by).reduce((n, l) => n + l.length, 0), sports.length, 'every sport has exactly one model');
  console.log('# live model by sport:', Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.length])));
});

test('a private event is invisible to outsiders on every new read and stream; the public page stream still works and resumes', async () => {
  const { org, ref, rando, ev, fx } = await setup();
  await start(ref, fx);
  await log(ref, fx, { kind: 'period_start' });
  await log(ref, fx, { kind: 'goal', side: 'home' });
  // public: the allow-listed spectator stream (#501) carries my frame ids and cursor
  const pub = await frames(`/live/public/fixtures/${fx}`, { done: (f) => f.length >= 1 });
  assert.equal(pub.status, 200);
  assert.match(pub.frames[0].id, /^\d+:\d+$/);
  assert.ok(Array.isArray(pub.frames[0].data.timeline) && pub.frames[0].data.timeline.length === 2, 'the public view is the allow-listed shape');
  assert.equal(pub.frames[0].data.events, undefined);
  // private: only the organiser and participants
  await pool.query("UPDATE events SET public_visibility='private' WHERE id=$1", [ev.id]);
  for (const path of [`/fixtures/${fx}/projection`, `/fixtures/${fx}/timeline`, `/fixtures/${fx}/live`]) {
    assert.equal((await api('GET', path)).status, 404, `anonymous ${path}`);
    assert.equal((await api('GET', path, { token: rando.token })).status, 404, `outsider ${path}`);
    assert.equal((await api('GET', path, { token: org.token })).status, 200, `organiser ${path}`);
  }
  assert.equal((await frames(`/live/fixtures/${fx}`)).status, 404);
  assert.equal((await frames(`/live/public/fixtures/${fx}`)).status, 404);
  assert.equal((await frames(`/live/fixtures/${fx}/scorer`, { token: ref.token, ms: 800, done: (f) => f.length >= 1 })).status, 200, 'the assigned official still scores a private event');
});

test('a boxing bout is scored by three judges\' round cards and the sheet starts from the derived decision', async () => {
  const { org, ref, m1, m2, fx } = await setup('boxing');
  await start(ref, fx);
  const card = (judge, round, home, away) => log(ref, fx, { kind: 'round_card', payload: { judge, round, home, away } });
  assert.equal((await card(1, 1, 10, 9)).status, 201);
  assert.equal((await card(1, 1, 9, 10)).status, 400, 'a card is scored once; correct it through history');
  assert.equal((await card(4, 1, 10, 9)).status, 400);
  for (const [j, r, h, a] of [[1, 2, 10, 9], [1, 3, 10, 9], [2, 1, 10, 9], [2, 2, 10, 9], [2, 3, 9, 10], [3, 1, 9, 10], [3, 2, 10, 9], [3, 3, 10, 9]]) assert.equal((await card(j, r, h, a)).status, 201);
  const proj = (await api('GET', `/fixtures/${fx}/projection`)).body;
  assert.equal(proj.ruleset.kind, 'manual');
  assert.deepEqual([proj.projection.votes.red, proj.projection.votes.blue], [3, 0]);
  assert.equal(proj.projection.complete, true); assert.equal(proj.projection.winner, 'home');
  assert.equal((await card(1, 2, 10, 9)).status, 400, 'the bout is decided');
  assert.equal((await log(ref, fx, { kind: 'knockdown', side: 'away' })).status, 201);
  assert.equal((await api('POST', `/fixtures/${fx}/end`, { token: ref.token })).status, 200);
  const sheet = (await api('GET', `/fixtures/${fx}/score-sheet`, { token: org.token })).body;
  assert.deepEqual([sheet.home_score, sheet.away_score], [3, 0], 'judges\' votes, the same as the Tools scorecard');
  assert.ok(sheet.m1 === undefined && m1 && m2);
});

test('judged and precision sessions: a gymnastics panel and a golf round score through the same live session and official result', async () => {
  const org = await signup(['organizer']);
  const T = org.token;
  const ev = (await api('POST', '/events', { token: T, body: { name: `Mixed Day ${++n}`, sport: 'multi-sport', kind: 'tournament' } })).body;
  assert.equal((await api('PATCH', `/events/${ev.id}/programme`, { token: T, body: { public_names: true } })).status, 200);
  const house = (await api('POST', `/events/${ev.id}/houses`, { token: T, body: { name: 'Red', color: '#e11' } })).body;
  const people = [];
  for (let k = 0; k < 3; k++) people.push((await api('POST', `/events/${ev.id}/participants`, { token: T, body: { full_name: `Athlete ${n}-${k}`, house_id: house.id, gender: 'male', grade: '7', roll_no: `M${n}-${k}` } })).body);
  const run = async (sport, name, rules) => {
    const d = (await api('POST', `/events/${ev.id}/disciplines`, { token: T, body: { sport, name, officials_required: 0, result_type: 'score' } })).body;
    assert.ok(d.id, JSON.stringify(d));
    for (const [k, p] of people.entries()) assert.equal((await api('POST', `/disciplines/${d.id}/nominations`, { token: T, body: { participant_id: p.id, seed: 1 + k } })).status, 201);
    assert.equal((await api('POST', `/disciplines/${d.id}/heats`, { token: T, body: { lanes: 8 } })).status, 201);
    if (rules) assert.equal((await api('PATCH', `/disciplines/${d.id}/live-rules`, { token: T, body: rules })).status, 200);
    const sess = (await api('GET', `/events/${ev.id}/sessions`, { query: { discipline_id: d.id } })).body[0];
    const ids = (await api('GET', `/sessions/${sess.id}`, { token: T })).body.entries.map((e) => e.id);
    return { d, sess, ids, post: (body) => api('POST', `/sessions/${sess.id}/events`, { token: T, body }) };
  };
  // gymnastics: judges' panel by default, five judges with the extremes dropped
  const g = await run('artistic-gymnastics', 'Floor', { drop_extremes: true });
  assert.equal((await g.post({ kind: 'attempt', entry_id: g.ids[0], payload: { round: 1, outcome: 'valid', value: 5 } })).status, 400, 'a panel session takes judges\' marks, not attempts');
  const marks = [[7, 8, 8.5, 9, 6], [8, 8, 8, 8, 8], [9, 9, 9, 9, 9.5]];
  for (const [k, list] of marks.entries()) for (const [j, v] of list.entries()) assert.equal((await g.post({ kind: 'judge_score', entry_id: g.ids[k], payload: { judge: j + 1, value: v } })).status, 201);
  assert.equal((await g.post({ kind: 'judge_score', entry_id: g.ids[0], payload: { judge: 1, value: 9 } })).status, 400, 'a judge scores a round once');
  const live = (await api('GET', `/sessions/${g.sess.id}/live`)).body;
  assert.equal(live.projection.aggregate, 'panel');
  assert.deepEqual(live.projection.entries.map((e) => [e.entry_id, e.best, e.rank]), [[g.ids[2], 9.0, 1], [g.ids[1], 8, 2], [g.ids[0], 7.833, 3]]);
  const fin = await api('POST', `/sessions/${g.sess.id}/finalize-live`, { token: T });
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  assert.deepEqual(fin.body.entries.map((e) => [e.id, e.position]).sort(), [[g.ids[0], 3], [g.ids[1], 2], [g.ids[2], 1]].sort());
  // golf: strokes are added up and the lowest total wins
  const golf = await run('golf', 'Round 1');
  for (const [k, strokes] of [[72, 70], [69, 74], [75, 71]].entries()) for (const [r, v] of strokes.entries()) assert.equal((await golf.post({ kind: 'attempt', entry_id: golf.ids[k], payload: { round: r + 1, outcome: 'valid', value: v } })).status, 201);
  const gl = (await api('GET', `/sessions/${golf.sess.id}/live`)).body;
  assert.equal(gl.projection.aggregate, 'sum'); assert.equal(gl.projection.lower_is_better, true);
  assert.deepEqual(gl.projection.entries.map((e) => [e.entry_id, e.best, e.rank]), [[golf.ids[0], 142, 1], [golf.ids[1], 143, 2], [golf.ids[2], 146, 3]], 'lowest total first');
  const gf = await api('POST', `/sessions/${golf.sess.id}/finalize-live`, { token: T });
  assert.equal(gf.status, 200, JSON.stringify(gf.body));
  assert.deepEqual(gf.body.entries.map((e) => [e.id, e.position]).sort(), [[golf.ids[0], 1], [golf.ids[1], 2], [golf.ids[2], 3]].sort(), 'the official places follow the live ranking, lowest strokes first');
});

test('stoppage time is announced by the referee and shows to everyone', async () => {
  const { ref, fx } = await setup();
  await start(ref, fx);
  await log(ref, fx, { kind: 'period_start' });
  assert.equal((await log(ref, fx, { kind: 'added_time', payload: { minutes: 40 } })).status, 400);
  assert.equal((await log(ref, fx, { kind: 'added_time', payload: { minutes: 4 } })).status, 201);
  assert.equal((await api('GET', `/fixtures/${fx}/projection`)).body.phase.added_time, 4);
  assert.equal((await api('GET', `/fixtures/${fx}/live`)).body.phase.added_time, 4);
});

test('basketball over REST: a fouled-out player and an exhausted timeout are refused; spectators see the bonus and mat state without anything private', async () => {
  const { ref, rando, fx, m1 } = await setup('basketball');
  await start(ref, fx);
  await log(ref, fx, { kind: 'period_start' });
  for (let i = 0; i < 5; i++) assert.equal((await log(ref, fx, { kind: 'foul', side: 'home', player_id: rando.id })).status, 201);
  const out = await log(ref, fx, { kind: 'two_pointer', side: 'home', player_id: rando.id });
  assert.equal(out.status, 400);
  assert.match(JSON.stringify(out.body), /fouled out/);
  const live = (await api('GET', `/fixtures/${fx}/live`)).body;
  assert.equal(live.score.rules.bonus.away, true);
  assert.equal(live.score.rules.fouled_out.length, 1);
  await log(ref, fx, { kind: 'timeout', side: 'away' }); await log(ref, fx, { kind: 'timeout', side: 'away' });
  assert.equal((await log(ref, fx, { kind: 'timeout', side: 'away' })).status, 400);
  // a team manager cannot score
  assert.equal((await log(m1, fx, { kind: 'foul', side: 'away' })).status, 403);
  // the same projection is served over MCP
  const proj = await mcp('get_live_projection', { id: fx });
  assert.match(JSON.stringify(proj), /"bonus":\{"home":false,"away":true\}/);
});

test('3x3, kabaddi and volleyball over REST follow their own rules', async () => {
  const t = await setup('3x3-basketball');
  await start(t.ref, t.fx); await log(t.ref, t.fx, { kind: 'period_start' });
  for (let i = 0; i < 21; i++) assert.equal((await log(t.ref, t.fx, { kind: 'one_pointer', side: 'home' })).status, 201);
  assert.equal((await log(t.ref, t.fx, { kind: 'one_pointer', side: 'away' })).status, 400, 'the game is over at 21');
  assert.equal((await api('GET', `/fixtures/${t.fx}/live`)).body.phase.can_score, false);

  const k = await setup('kabaddi');
  await start(k.ref, k.fx); await log(k.ref, k.fx, { kind: 'period_start' });
  for (let i = 0; i < 7; i++) await log(k.ref, k.fx, { kind: 'raid_point', side: 'home' });
  let kr = (await api('GET', `/fixtures/${k.fx}/live`)).body.score.rules;
  assert.deepEqual([kr.on_mat.away, kr.all_out_for], [0, 'home']);
  await log(k.ref, k.fx, { kind: 'all_out', side: 'home' });
  kr = (await api('GET', `/fixtures/${k.fx}/live`)).body.score.rules;
  assert.deepEqual([kr.on_mat.away, kr.all_out_for], [7, null]);

  const v = await setup('volleyball');
  await start(v.ref, v.fx);
  await log(v.ref, v.fx, { kind: 'server', side: 'home' });
  await log(v.ref, v.fx, { kind: 'point', side: 'away' });
  await log(v.ref, v.fx, { kind: 'timeout', side: 'home' }); await log(v.ref, v.fx, { kind: 'timeout', side: 'home' });
  assert.equal((await log(v.ref, v.fx, { kind: 'timeout', side: 'home' })).status, 400);
  const vr = (await api('GET', `/fixtures/${v.fx}/live`)).body.score.rules;
  assert.deepEqual([vr.rotation.away, vr.rotation.serving, vr.timeouts_left.home], [2, 'away', 0]);

  const b = await setup('badminton');
  await start(b.ref, b.fx);
  await log(b.ref, b.fx, { kind: 'server', side: 'home' });
  await log(b.ref, b.fx, { kind: 'point', side: 'home' });
  const br = (await api('GET', `/fixtures/${b.fx}/live`)).body.score.rules;
  assert.deepEqual([br.service_court, br.server_score], ['left', 1]);
});
