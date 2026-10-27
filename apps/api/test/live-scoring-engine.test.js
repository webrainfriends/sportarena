import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builtinRuleset, cricketRuleset, rulesetSchema } from '../src/scoring/rulesets.js';
import { computeScore, matchPhase, rejectReason } from '../src/scoring/engine.js';
import { pluginFor, sportPlugins, sessionPlugin, registerSportPlugin } from '../src/scoring/plugins/index.js';
import { rallyServer } from '../src/scoring/racket.js';
import { shootoutState } from '../src/scoring/basic.js';
import { sessionState } from '../src/scoring/session.js';

/** A scorer that keeps a log and refuses what the engine refuses, like log_match_event does. */
const book = (rs, ctx) => {
  const log = [];
  const add = (kind, side, extra = {}) => {
    const e = { kind, side, seq: log.length + 1, ...extra };
    const why = rejectReason(rs, log, e, ctx);
    if (why) throw new Error(why);
    log.push(e);
    return e;
  };
  return { log, add, score: () => computeScore(rs, log), phase: () => matchPhase(rs, log), point: (s, n = 1) => { for (let i = 0; i < n; i++) add('point', s); } };
};
const game = (b, winner, loser = null, loserPoints = 0) => { b.point(loser ?? (winner === 'home' ? 'away' : 'home'), loserPoints); b.point(winner, 4); };

test('every built-in ruleset kind has a plugin implementing the contract', () => {
  assert.deepEqual([...sportPlugins()].sort(), ['cricket', 'manual', 'points_events', 'racket', 'sets']);
  for (const slug of ['football', 'badminton', 'tennis', 'padel', 'karate']) {
    const p = pluginFor(builtinRuleset({ slug }));
    for (const fn of ['state', 'validate', 'phase', 'attribution', 'liveStats', 'publicView', 'toResult']) assert.equal(typeof p[fn], 'function', `${slug}.${fn}`);
  }
  assert.equal(pluginFor(builtinRuleset({ slug: 'tennis' })).kind, 'racket', 'game-style racket sports use the racket plugin');
  assert.equal(pluginFor(builtinRuleset({ slug: 'badminton' })).kind, 'sets');
  registerSportPlugin({ kind: 'demo_kind', state: () => ({}) });
  assert.ok(sportPlugins().includes('demo_kind'), 'a new sport registers without touching the engine');
});

test('racket{} is only valid on a sets ruleset and old governed rulesets still parse', () => {
  assert.ok(!rulesetSchema.safeParse({ kind: 'points_events', label: 'x', events: [{ kind: 'g', label: 'G', points: 1 }], racket: {} }).success);
  const legacy = { kind: 'sets', label: 'Old', sets: { best_of: 3, points_to_win: 21, win_by: 2, cap: 30, deciding_points: null }, draw_allowed: false };
  assert.equal(rulesetSchema.parse(legacy).racket, undefined);
});

test('tennis: points, deuce and advantage, games, a tie-break, sets and the winner', () => {
  const rs = builtinRuleset({ slug: 'tennis' });
  const b = book(rs);
  b.add('server', 'home');
  b.point('home', 3); b.point('away', 3);
  assert.equal(b.score().current_game.call, 'Deuce');
  b.point('away');
  assert.equal(b.score().current_game.call, 'Ad-In (away)');
  b.point('home');
  assert.equal(b.score().current_game.call, 'Deuce');
  b.point('home', 2);
  assert.deepEqual(b.score().current_set, { home: 1, away: 0 });
  assert.equal(b.score().server, 'away', 'the server changes every game');
  for (let i = 0; i < 5; i++) { game(b, 'away'); game(b, 'home'); }      // 6-5
  game(b, 'away');                                                         // 6-6 after 12 games
  assert.deepEqual(b.score().current_set, { home: 6, away: 6 });
  assert.equal(b.score().current_game.tiebreak, true);
  b.point('home', 7);                                                      // 7-0 tie-break
  const s = b.score();
  assert.deepEqual(s.sets[0], { home: 7, away: 6, winner: 'home', tiebreak: { home: 7, away: 0 } });
  assert.equal(s.home, 1);
  for (let i = 0; i < 5; i++) game(b, 'home');
  assert.equal(b.score().over, false, '5-0 in the second set is not a won set yet');
  game(b, 'home');
  const done = b.score();
  assert.equal(done.over, true); assert.equal(done.winner, 'home'); assert.equal(done.home, 2);
  assert.throws(() => b.point('away'), /already decided/);
});

test('tennis tie-break serve rotation and a tie-break needs a two point lead', () => {
  const rs = builtinRuleset({ slug: 'tennis' });
  const b = book(rs);
  b.add('server', 'home');
  for (let i = 0; i < 6; i++) { game(b, 'home'); game(b, 'away'); }
  assert.equal(b.score().server, 'home', 'home serves the first tie-break point');
  b.point('home'); assert.equal(b.score().server, 'away');
  b.point('away'); assert.equal(b.score().server, 'away', 'then two points each');
  b.point('away'); assert.equal(b.score().server, 'home');
  b.point('home', 5); b.point('away', 4);
  assert.equal(b.score().current_game.tiebreak, true, '7-7 is not over: a two point lead is needed');
});

test('padel: no-ad games and a match tie-break instead of a deciding set', () => {
  const rs = builtinRuleset({ slug: 'padel' });
  const b = book(rs);
  b.point('home', 3); b.point('away', 3);
  assert.equal(b.score().current_game.call, '40-40');
  b.point('away');
  assert.deepEqual(b.score().current_set, { home: 0, away: 1 }, 'sudden death: the next point wins the game');
  for (let i = 0; i < 6; i++) game(b, 'home');                              // home wins set 1 (6-1)
  for (let i = 0; i < 6; i++) game(b, 'away');                              // away wins set 2
  assert.equal(b.score().current_game.match_tiebreak, false);
  b.point('home', 9); b.point('away', 9);
  assert.equal(b.score().current_game.match_tiebreak, true);
  b.point('home', 2);
  const s = b.score();
  assert.equal(s.over, true); assert.equal(s.winner, 'home');
  assert.deepEqual(s.sets[2], { home: 1, away: 0, winner: 'home', tiebreak: { home: 11, away: 9 } });
});

test('retirement and walkover decide a racket match; a walkover cannot follow play', () => {
  const rs = builtinRuleset({ slug: 'tennis' });
  const b = book(rs);
  b.point('home', 2);
  assert.throws(() => b.add('walkover', 'away'), /retirement/);
  b.add('retire', 'away');
  const s = b.score();
  assert.equal(s.over, true); assert.equal(s.winner, 'home'); assert.equal(s.outcome, 'retired');
  const w = book(rs); w.add('walkover', 'home');
  assert.equal(w.score().winner, 'away'); assert.equal(w.score().outcome, 'walkover');
});

test('rally sports derive the server: rally winner serves, table tennis alternates every two', () => {
  const bad = book(builtinRuleset({ slug: 'badminton' }));
  bad.add('server', 'home'); bad.point('away');
  assert.equal(bad.score().server, 'away');
  bad.point('home'); assert.equal(bad.score().server, 'home');
  const tt = book(builtinRuleset({ slug: 'table-tennis' }));
  tt.add('server', 'home'); tt.point('home'); assert.equal(tt.score().server, 'home');
  tt.point('away'); assert.equal(tt.score().server, 'away');
  assert.equal(rallyServer(builtinRuleset({ slug: 'squash' }), []), null, 'unknown until a first server or a point exists');
  assert.throws(() => bad.add('server', 'away'), /before the first point/);
});

test('football: a sent-off player cannot take part again; two yellows are a red', () => {
  const rs = builtinRuleset({ slug: 'football' });
  const b = book(rs);
  b.add('yellow_card', 'home', { player_id: 'p1' });
  b.add('yellow_card', 'home', { player_id: 'p1' });
  assert.deepEqual(b.score().sent_off, [{ player_id: 'p1', side: 'home', reason: 'second_yellow' }]);
  assert.throws(() => b.add('foul', 'home', { player_id: 'p1' }), /sent off/);
  b.add('red_card', 'away', { player_id: 'p2' });
  assert.equal(b.score().sent_off.length, 2);
});

test('football extra time and the shoot-out follow the pinned ruleset', () => {
  const rs = rulesetSchema.parse({ ...builtinRuleset({ slug: 'football' }), extra_time: { periods: 2, minutes: 15 }, shootout: { rounds: 3 } });
  const b = book(rs, { knockout: true });
  b.add('period_start', null, { period: 1 }); b.add('goal', 'home'); b.add('period_end', null);
  b.add('period_start', null, { period: 2 }); b.add('goal', 'away'); b.add('period_end', null);
  assert.equal(b.phase().extra_time_available, true);
  assert.throws(() => b.add('shootout_goal', 'home'), /level after the last period/, 'extra time comes first');
  b.add('period_start', null, { period: 3 }); b.add('period_end', null);
  b.add('period_start', null, { period: 4 }); b.add('period_end', null);
  assert.throws(() => b.add('period_start', null, { period: 5 }), /All extra-time periods/);
  assert.equal(b.phase().shootout_available, true);
  for (const [side, kind] of [['home', 'shootout_goal'], ['away', 'shootout_miss'], ['home', 'shootout_goal']]) b.add(kind, side);
  assert.throws(() => b.add('shootout_goal', 'home'), /Away's kick/);
  assert.throws(() => b.add('goal', 'home'), /shoot-out has started/);
  assert.equal(b.score().shootout.over, false);
  b.add('shootout_miss', 'away');
  assert.throws(() => b.add('shootout_goal', 'home'), /already decided/);
  const s = b.score();
  assert.equal(s.shootout.winner, 'home', 'home leads 2-0 with one kick left each: away cannot catch up');
  assert.equal(pluginFor(rs).toResult(s).winner, 'home');
  assert.equal(s.home, 1); assert.equal(s.away, 1, 'regulation score is unchanged by the shoot-out');
  const group = book(rs, { knockout: false });
  group.add('period_start', null, { period: 1 }); group.add('period_end', null);
  group.add('period_start', null, { period: 2 }); group.add('period_end', null);
  assert.throws(() => group.add('period_start', null, { period: 3 }), /knockout/);
});

test('shoot-out: sudden death is decided only after equal kicks', () => {
  const kick = (side, scored) => ({ kind: scored ? 'shootout_goal' : 'shootout_miss', side });
  const seq = [kick('home', 1), kick('away', 1), kick('home', 0), kick('away', 0), kick('home', 1), kick('away', 1), kick('home', 1)];
  assert.equal(shootoutState(3, seq).over, false, 'home scored first in sudden death but away has not replied');
  assert.equal(shootoutState(3, [...seq, kick('away', 0)]).winner, 'home');
  assert.equal(shootoutState(3, [...seq, kick('away', 1)]).over, false);
});

test('cricket: partnerships, run rates, target and pinned powerplays', () => {
  const rs = rulesetSchema.parse({ ...cricketRuleset('T20'), cricket: { ...cricketRuleset('T20').cricket, powerplays: [{ from_over: 0, to_over: 1 }] } });
  const b = book(rs);
  const ball = (runs, extra = {}, bowler = 0) => b.add('ball', 'home', { payload: { bowler, runs, ...extra } });
  ball(4); ball(1); ball(1); ball(0); ball(0); ball(0);                     // over 1: 6 runs
  const st = computeScore(rs, b.log).cricket;
  assert.equal(st.innings[0].run_rate, 6);
  assert.equal(st.innings[0].powerplay, true);
  assert.deepEqual(st.innings[0].current_partnership.runs, 6);
  b.add('ball', 'home', { payload: { bowler: 1, runs: 0, wicket: { how: 'bowled' } } });
  const after = computeScore(rs, b.log).cricket.innings[0];
  assert.deepEqual(after.partnerships.map((p) => [p.wicket, p.runs, p.balls]), [[1, 6, 7]]);
  assert.equal(after.current_partnership.runs, 0);
  assert.equal(after.powerplay, true);
  // chase: away needs 7 off 120 balls
  b.add('innings_end', 'home');
  b.add('ball', 'away', { payload: { bowler: 0, runs: 6 } });
  const chase = computeScore(rs, b.log).cricket;
  assert.equal(chase.target, 7); assert.equal(chase.to_win, 1);
  assert.equal(chase.required_run_rate, Math.round((1 * 6 / 119) * 100) / 100);
  assert.equal(chase.current_run_rate, 36);
});

test('cricket attribution maps batting slots to verified players only when a lineup is given', () => {
  const rs = cricketRuleset('T20');
  const live = [{ kind: 'ball', side: 'home', payload: { bowler: 0, runs: 4 } }];
  const lineup = { home: Array.from({ length: 11 }, (_, i) => `h${i}`), away: Array.from({ length: 11 }, (_, i) => `a${i}`) };
  const withIds = pluginFor(rs).attribution(rs, live, { lineup });
  assert.equal(withIds.find((r) => r.role === 'batting' && r.slot === 0).player_id, 'h0');
  assert.equal(withIds.find((r) => r.role === 'bowling').player_id, 'a0', 'the bowler belongs to the fielding side');
  assert.equal(pluginFor(rs).attribution(rs, live).find((r) => r.role === 'batting').player_id, null, 'no lineup: nothing is invented');
});

test('session: a heat is provisional until the official result; Q and q come from the pinned rules only', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const ev = (kind, payload) => ({ kind, payload });
  const cfg = { resultType: 'time', entryIds: ids, progression: { qp: 1, qt: 1 } };
  assert.equal(sessionState(cfg, []).status, 'scheduled');
  const log = [ev('status', { status: 'call_room' }), ev('lane', { entry_id: 'a', lane: 4 }), ev('start', {}), ev('split', { entry_id: 'a', distance_m: 50, value: 5.1 }),
    ev('finish', { entry_id: 'a', value: 10.2 }), ev('finish', { entry_id: 'b', value: 10.4 }), ev('finish', { entry_id: 'c', value: 10.4 }), ev('entry_status', { entry_id: 'd', status: 'dq', reason: 'false start' })];
  const s = sessionState(cfg, log);
  assert.equal(s.status, 'provisional'); assert.equal(s.provisional, true);
  assert.deepEqual(s.entries.map((e) => [e.entry_id, e.rank, e.q ?? '']), [['a', 1, 'Q'], ['b', 2, 'q'], ['c', 2, ''], ['d', null, '']]);
  assert.equal(sessionState({ ...cfg, progression: {} }, log).qualified.length, 0, 'no pinned rule means no qualification');
  assert.deepEqual(sessionPlugin.toResult(s).map((r) => [r.entry_id, r.status]), [['a', 'finished'], ['b', 'finished'], ['c', 'finished'], ['d', 'dq']]);
  assert.match(sessionPlugin.validate(cfg, s, { kind: 'finish', payload: { entry_id: 'a', value: 9 } }), /already finished/);
  assert.match(sessionPlugin.validate(cfg, s, { kind: 'finish', payload: { entry_id: 'd', value: 9 } }), /DQ/);
  assert.match(sessionPlugin.validate(cfg, s, { kind: 'status', payload: { status: 'ready' } }), /already provisional/);
  assert.equal(sessionPlugin.validate(cfg, s, { kind: 'split', payload: { entry_id: 'b', distance_m: 50, value: 5.3 } }), null);
});

test('session: field attempts rank by best mark with deterministic tie-breaks and a pinned cut', () => {
  const cfg = { resultType: 'distance', entryIds: ['a', 'b', 'c'], field: true, progression: { cut_after_round: 2, cut_to: 2 } };
  const at = (id, round, value) => ({ kind: 'attempt', payload: { entry_id: id, round, outcome: value ? 'valid' : 'foul', value } });
  const log = [at('a', 1, 7.5), at('b', 1, 7.5), at('c', 1, 0), at('a', 2, 7.2), at('b', 2, 7.4), at('c', 2, 6.9)];
  const s = sessionState(cfg, log);
  assert.deepEqual(s.entries.map((e) => [e.entry_id, e.rank]), [['b', 1], ['a', 2], ['c', 3]], 'equal bests are split by the next best mark');
  assert.deepEqual(s.entries.map((e) => [e.entry_id, e.continues]), [['b', true], ['a', true], ['c', false]]);
  assert.match(sessionPlugin.validate(cfg, s, at('c', 3, 7)), /did not make the cut/);
  assert.match(sessionPlugin.validate(cfg, s, at('a', 2, 7)), /already has an attempt/);
});
