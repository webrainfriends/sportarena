import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builtinRuleset, cricketRuleset, rulesetSchema, liveModelOf } from '../src/scoring/rulesets.js';
import { computeScore, matchPhase, rejectReason } from '../src/scoring/engine.js';
import { pluginFor, sportPlugins, sessionPlugin, registerSportPlugin } from '../src/scoring/plugins/index.js';
import { rallyServer } from '../src/scoring/racket.js';
import { shootoutState } from '../src/scoring/basic.js';
import { sessionState, sessionDefaults } from '../src/scoring/session.js';

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
  assert.deepEqual([...sportPlugins()].filter((k) => k !== 'demo_kind').sort(), ['cards', 'cricket', 'manual', 'points_events', 'racket', 'sets']);
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

test('round-card bouts (boxing, MMA, muay thai, kickboxing): the decision comes from the judges\' cards, like the Tools scorebook', () => {
  const rs = builtinRuleset({ slug: 'boxing', scoring: 'points', category: 'combat' });
  assert.equal(rs.kind, 'manual'); assert.deepEqual(rs.cards, { rounds: 3, judges: 3 });
  assert.equal(pluginFor(rs).kind, 'cards', 'a refinement of manual, so the Tools tracker still sees a manual ruleset');
  assert.ok(!rulesetSchema.safeParse({ kind: 'sets', label: 'x', sets: rs.sets, cards: rs.cards }).success, 'cards{} refines manual only');
  const b = book(rs);
  const card = (judge, round, home, away) => b.add('round_card', null, { payload: { judge, round, home, away } });
  assert.throws(() => card(4, 1, 10, 9), /judge must be 1 to 3/);
  assert.throws(() => card(1, 4, 10, 9), /round must be 1 to 3/);
  assert.throws(() => card(1, 1, 11, 9), /0 to 10/);
  for (const r of [1, 2, 3]) { card(1, r, 10, 9); card(2, r, 10, 9); }
  assert.equal(b.score().over, false, 'a judge is still to score');
  assert.equal(b.score().scorecard.kind, 'unanimous (so far)');
  assert.throws(() => card(1, 1, 9, 10), /already scored round 1/);
  for (const r of [1, 2]) card(3, r, 9, 10);
  card(3, 3, 10, 10);
  const s = b.score();
  assert.equal(s.over, true); assert.equal(s.winner, 'home'); assert.deepEqual([s.home, s.away], [2, 1]);
  assert.equal(s.scorecard.kind, 'split');
  assert.throws(() => card(2, 1, 10, 9), /already decided/);
  assert.deepEqual(pluginFor(rs).toResult(s), { home: 2, away: 1, winner: 'home', totals: { scorecard: s.scorecard, stats: s.stats } });
  assert.equal(matchPhase(rs, b.log).can_score, false);
  const k = book(rs); k.add('knockdown', 'away');
  assert.deepEqual(k.score().stats.away, { knockdown: 1 });
  for (const slug of ['mma', 'muay-thai', 'kickboxing']) assert.ok(builtinRuleset({ slug, scoring: 'combat' }).cards, slug);
});

test('stoppage time is an announced number of minutes and shows in the period phase', () => {
  const rs = builtinRuleset({ slug: 'football' });
  const b = book(rs);
  b.add('period_start', null);
  assert.throws(() => b.add('added_time', null, { payload: { minutes: 0 } }), /1 to 30/);
  assert.throws(() => b.add('added_time', null, { payload: {} }), /1 to 30/);
  b.add('added_time', null, { payload: { minutes: 3 } });
  assert.equal(b.phase().added_time, 3);
  b.add('period_end', null); b.add('period_start', null);
  assert.equal(b.phase().added_time, null, 'a new period starts without added time');
  assert.equal(rejectReason(cricketRuleset('T20'), [], { kind: 'added_time', payload: { minutes: 2 } }), null, 'every ruleset accepts it');
});

test('session aggregates: sum of attempts (archery, golf lowest wins), judges\' panel with dropped extremes and a multiplier, best mark', () => {
  const at = (id, round, value) => ({ kind: 'attempt', payload: { entry_id: id, round, outcome: 'valid', value } });
  const arch = sessionState({ resultType: 'score', entryIds: ['a', 'b'], aggregate: 'sum' }, [at('a', 1, 54), at('a', 2, 57), at('b', 1, 58), at('b', 2, 55)]);
  assert.deepEqual(arch.entries.map((e) => [e.entry_id, e.best, e.rank]), [['a', 111, 1], ['b', 113, 1 + 1]].sort((x, y) => y[1] - x[1]).map(([k, v], i) => [k, v, i + 1]), 'higher total wins');
  const golf = sessionState({ resultType: 'score', entryIds: ['a', 'b'], aggregate: 'sum', lowerIsBetter: true }, [at('a', 1, 72), at('a', 2, 70), at('b', 1, 69), at('b', 2, 74)]);
  assert.deepEqual(golf.entries.map((e) => [e.entry_id, e.best]), [['a', 142], ['b', 143]], 'lowest strokes win');
  const judge = (id, j, value, round = 1, multiplier) => ({ kind: 'judge_score', payload: { entry_id: id, judge: j, round, value, ...(multiplier ? { multiplier } : {}) } });
  const marks = [7, 8, 8.5, 9, 6];
  const panel = sessionState({ resultType: 'score', entryIds: ['a', 'b'], aggregate: 'panel', dropExtremes: true }, [...marks.map((v, i) => judge('a', i + 1, v)), ...[8, 8, 8, 8, 8].map((v, i) => judge('b', i + 1, v))]);
  assert.deepEqual(panel.entries.map((e) => [e.entry_id, e.best]), [['b', 8], ['a', 7.833]], 'the 6 and the 9 are dropped: (7 + 8 + 8.5) / 3');
  const dive = sessionState({ resultType: 'score', entryIds: ['a'], aggregate: 'panel' }, [judge('a', 1, 8, 1, 2.0), judge('a', 2, 9, 1, 2.0), judge('a', 1, 7, 2, 1.5)]);
  assert.equal(dive.entries[0].best, 17 + 10.5, 'per round: panel mean times difficulty, added over the rounds');
  const cfg = { resultType: 'score', entryIds: ['a'], aggregate: 'panel' };
  const st = sessionState(cfg, [judge('a', 1, 8)]);
  assert.match(sessionPlugin.validate(cfg, st, judge('a', 1, 9)), /already scored round 1/);
  assert.match(sessionPlugin.validate(cfg, st, { kind: 'finish', payload: { entry_id: 'a', value: 9 } }), /judges' panel/);
  assert.match(sessionPlugin.validate(cfg, st, at('a', 1, 5)), /judges' panel/);
  assert.match(sessionPlugin.validate({ ...cfg, aggregate: 'best' }, st, judge('a', 2, 9)), /not scored by a judges' panel/);
  assert.match(sessionPlugin.validate(cfg, st, judge('a', 21, 9)), /judge must be 1 to 20/);
  assert.match(sessionPlugin.validate(cfg, st, judge('a', 2, 1001)), /0 to 1000/);
  // the official result follows the live ranking and its direction, via explicit positions
  assert.deepEqual(sessionPlugin.toResult(golf).map((r) => [r.entry_id, r.value, r.position]), [['a', 142, 1], ['b', 143, 2]]);
});

test('every sport family has a live model, and the defaults are the sport\'s own direction', () => {
  assert.deepEqual(sessionDefaults({ scoring: 'judged' }), { aggregate: 'panel', lowerIsBetter: false });
  assert.deepEqual(sessionDefaults({ scoring: 'time' }), { aggregate: 'best', lowerIsBetter: true });
  assert.deepEqual(sessionDefaults({ scoring: 'weight' }), { aggregate: 'best', lowerIsBetter: false });
  assert.deepEqual(sessionDefaults({ slug: 'golf', scoring: 'points', category: 'precision' }), { aggregate: 'sum', lowerIsBetter: true });
  assert.deepEqual(sessionDefaults({ slug: 'archery', scoring: 'points', category: 'precision' }), { aggregate: 'sum', lowerIsBetter: false });
  assert.equal(liveModelOf({ slug: 'judo', scoring: 'combat' }).model, 'outcome', 'judo and chess stay manual in the Tools tracker: the result is the score');
  assert.equal(liveModelOf({ slug: 'chess', scoring: 'points', category: 'mind' }).model, 'outcome');
  assert.equal(builtinRuleset({ slug: 'dodgeball', scoring: 'points', category: 'team_ball', name: 'Dodgeball' }).label, 'Dodgeball (points)', 'a labelled fallback for team ball sports');
  assert.equal(liveModelOf({ slug: 'tennis', scoring: 'sets' }).model, 'racket');
  assert.equal(liveModelOf({ slug: 'boxing', scoring: 'points', category: 'combat' }).model, 'cards');
  assert.equal(liveModelOf({ slug: 'artistic-gymnastics', scoring: 'judged' }).model, 'session');
});

test('outcome sports (chess, esports, judo): the result is recorded live, once, with a method from the fixed list', () => {
  const rs = builtinRuleset({ slug: 'chess', scoring: 'points', category: 'mind' });
  assert.equal(rs.kind, 'manual');
  const b = book(rs);
  assert.throws(() => b.add('result', null, { payload: { outcome: 'both' } }), /outcome must be one of/);
  assert.throws(() => b.add('result', null, { payload: { outcome: 'home', method: 'witchcraft' } }), /method must be one of/);
  b.add('period_start', null);
  b.add('result', null, { payload: { outcome: 'away', method: 'checkmate' } });
  const s = b.score();
  assert.deepEqual([s.home, s.away, s.winner, s.over], [0, 1, 'away', true]);
  assert.deepEqual(s.result, { outcome: 'away', method: 'checkmate' });
  assert.throws(() => b.add('result', null, { payload: { outcome: 'home' } }), /already recorded/);
  assert.equal(matchPhase(rs, b.log).can_score, false);
  assert.deepEqual(pluginFor(rs).toResult(s).totals, { result: { outcome: 'away', method: 'checkmate' } });
  const draw = book(rs); draw.add('result', null, { payload: { outcome: 'draw' } });
  assert.deepEqual([draw.score().winner, draw.score().level, draw.score().over], [null, true, true]);
});

// ------------------------------------------------------------------ sport rules: basketball, kabaddi, volleyball, badminton
const sport = (slug) => builtinRuleset({ slug });

test('basketball: team fouls reset each quarter, the bonus follows, a fifth foul puts a player out, timeouts run out', () => {
  const b = book(sport('basketball'));
  b.add('period_start', null);
  for (let i = 0; i < 4; i++) b.add('foul', 'home', { player_id: 'p1' });
  assert.equal(b.score().rules.bonus.away, false);
  b.add('foul', 'home', { player_id: 'p2' });
  assert.deepEqual([b.score().rules.team_fouls.home, b.score().rules.bonus.away, b.score().rules.bonus.home], [5, true, false]);
  assert.deepEqual(b.score().rules.fouled_out, []);
  b.add('foul', 'home', { player_id: 'p1' });
  assert.deepEqual(b.score().rules.fouled_out, [{ player_id: 'p1', side: 'home' }]);
  assert.throws(() => b.add('two_pointer', 'home', { player_id: 'p1' }), /fouled out/);
  b.add('two_pointer', 'home', { player_id: 'p2' });
  b.add('period_end', null); b.add('period_start', null);
  assert.equal(b.score().rules.team_fouls.home, 0);
  assert.equal(b.score().rules.bonus.away, false);
  // two timeouts in the first half, a third is refused; the second half has its own three
  b.add('timeout', 'away'); b.add('timeout', 'away');
  assert.throws(() => b.add('timeout', 'away'), /no timeouts left/);
  b.add('period_end', null); b.add('period_start', null);
  assert.equal(b.score().rules.timeouts_left.away, 3);
});

test('3x3 basketball ends the moment a side reaches 21 and has a 7-foul bonus', () => {
  const rs = sport('3x3-basketball');
  assert.equal(rs.basketball.target_score, 21);
  const b = book(rs);
  b.add('period_start', null);
  for (let i = 0; i < 6; i++) b.add('foul', 'away');
  assert.equal(b.score().rules.bonus.home, false);
  b.add('foul', 'away');
  assert.equal(b.score().rules.bonus.home, true);
  for (let i = 0; i < 10; i++) b.add('two_pointer', 'home');
  assert.equal(b.score().over, false);
  b.add('one_pointer', 'home');
  assert.deepEqual([b.score().home, b.score().over, b.score().winner], [21, true, 'home']);
  assert.equal(b.phase().can_score, false);
  assert.throws(() => b.add('one_pointer', 'away'), /already decided/);
});

test('kabaddi: players on the mat, revivals, do-or-die raids and the all-out prompt', () => {
  const b = book(sport('kabaddi'));
  b.add('period_start', null);
  b.add('raid_point', 'home'); b.add('raid_point', 'home');
  assert.deepEqual(b.score().rules.on_mat, { home: 7, away: 5 });
  b.add('tackle_point', 'away'); // the raider is out; the tackling side gets one back
  assert.deepEqual(b.score().rules.on_mat, { home: 6, away: 6 });
  b.add('empty_raid', 'home');
  assert.equal(b.score().rules.do_or_die.home, false);
  b.add('empty_raid', 'home');
  assert.equal(b.score().rules.do_or_die.home, true);
  b.add('bonus_point', 'home');
  assert.equal(b.score().rules.do_or_die.home, false);
  assert.equal(b.score().rules.all_out_for, null);
  const all = book(sport('kabaddi')); all.add('period_start', null);
  for (let i = 0; i < 7; i++) all.add('raid_point', 'home');
  assert.deepEqual([all.score().rules.on_mat.away, all.score().rules.all_out_for], [0, 'home']);
  all.add('all_out', 'home');
  assert.deepEqual([all.score().rules.on_mat.away, all.score().rules.all_out_for], [7, null]);
  assert.equal(all.score().home, 7 + 2);
});

test('volleyball: rotation follows side-outs, timeouts and substitutions are limited per set, technical timeouts and the decider switch are prompted', () => {
  const b = book(sport('volleyball'));
  b.add('server', 'home');
  b.add('point', 'away'); b.add('point', 'home'); b.add('point', 'away'); b.add('point', 'away');
  assert.deepEqual(b.score().rules.rotation, { home: 2, away: 3, serving: 'away' });
  b.add('timeout', 'home'); b.add('timeout', 'home');
  assert.throws(() => b.add('timeout', 'home'), /no timeouts left/);
  for (let i = 0; i < 6; i++) b.add('substitution', 'away');
  assert.throws(() => b.add('substitution', 'away'), /used all substitutions/);
  for (let i = 0; i < 8; i++) b.point('home');
  assert.ok(b.score().rules.prompts.includes('technical_timeout'));
  b.add('technical_timeout', 'home');
  assert.ok(!b.score().rules.prompts.includes('technical_timeout'));
  // a new set resets the limits
  b.point('home', 25);
  assert.equal(b.score().sets.length, 1);
  assert.deepEqual(b.score().rules.timeouts_left, { home: 2, away: 2 });
  assert.equal(b.score().rules.decider, false);
});

test('volleyball deciding set prompts a change of ends when the leader reaches 8; beach volleyball every 7 points', () => {
  const b = book(sport('volleyball'));
  for (let s = 0; s < 4; s++) { b.point(s % 2 ? 'away' : 'home', 25); }
  assert.equal(b.score().rules.decider, true);
  b.point('home', 7);
  assert.ok(!b.score().rules.prompts.includes('change_ends'));
  b.point('home');
  assert.ok(b.score().rules.prompts.includes('change_ends'));
  b.add('change_ends', 'home');
  assert.ok(!b.score().rules.prompts.includes('change_ends'));
  const bv = book(sport('beach-volleyball'));
  bv.point('home', 6); assert.deepEqual(bv.score().rules.prompts, []);
  bv.point('away'); assert.deepEqual(bv.score().rules.prompts, ['change_ends']);
});

test('badminton: service court from the server\'s own score, interval at 11, and a server can be named for each set', () => {
  const b = book(sport('badminton'));
  b.add('server', 'home');
  assert.equal(b.score().rules.service_court, 'right');
  b.point('home');
  assert.deepEqual([b.score().rules.service_court, b.score().rules.server_score], ['left', 1]);
  b.point('away'); // the receiver wins the rally and serves from its own (odd) score
  assert.deepEqual([b.score().server, b.score().rules.service_court], ['away', 'left']);
  b.point('home', 10);
  assert.deepEqual(b.score().rules.prompts, ['interval']);
  b.add('interval', 'home');
  assert.deepEqual(b.score().rules.prompts, []);
  b.point('home', 10); // 21-1: set one done (home), set two begins
  b.point('home', 21); // home takes set two and the match
  assert.equal(b.score().over, true);
  // a three-set match: the server of set two is named explicitly
  const c = book(sport('badminton'));
  c.add('server', 'home'); c.point('home', 21);
  c.add('server', 'away');
  assert.equal(c.score().server, 'away');
  assert.equal(c.score().rules.service_court, 'right');
  assert.throws(() => c.add('server', 'home') && (c.point('away'), c.add('server', 'home')), /before the first point of the set/);
});

test('every new rules block parses back through the schema and belongs only to its kind', () => {
  for (const slug of ['basketball', '3x3-basketball', 'wheelchair-basketball', 'kabaddi', 'volleyball', 'beach-volleyball', 'badminton']) {
    const rs = sport(slug);
    assert.deepEqual(rulesetSchema.parse(JSON.parse(JSON.stringify(rs))), rs, slug);
  }
  assert.throws(() => rulesetSchema.parse({ ...sport('football'), rally: { timeouts_per_set: 1 } }), /refines a sets ruleset/);
  assert.throws(() => rulesetSchema.parse({ ...sport('badminton'), kabaddi: {} }), /refine a points_events ruleset/);
  // an old pinned ruleset without any of the blocks still works
  const old = { ...sport('badminton') }; delete old.rally;
  assert.equal(computeScore(rulesetSchema.parse(old), [{ kind: 'point', side: 'home' }]).home, 0);
  assert.equal(computeScore(rulesetSchema.parse(old), [{ kind: 'point', side: 'home' }]).rules, undefined);
});
