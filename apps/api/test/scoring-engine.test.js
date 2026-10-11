import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builtinRuleset, rulesetSchema, builtinSlugs } from '../src/scoring/rulesets.js';
import { computeScore, matchPhase, rejectReason } from '../src/scoring/engine.js';

const ev = (kind, side, period = 1, extra = {}) => ({ kind, side, period, ...extra });
const rally = (list) => list.flatMap(([side, n]) => Array.from({ length: n }, () => ev('point', side)));

test('every built-in ruleset is valid and the catalogue falls back sensibly', () => {
  for (const slug of builtinSlugs()) assert.ok(rulesetSchema.safeParse(builtinRuleset({ slug })).success, slug);
  assert.equal(builtinRuleset({ slug: 'futsal-xyz', scoring: 'goals', name: 'Mini goals' }).kind, 'points_events');
  assert.equal(builtinRuleset({ slug: 'new-racket', scoring: 'sets', name: 'New racket' }).kind, 'sets');
  assert.equal(builtinRuleset({ slug: 'archery', scoring: 'points' }).kind, 'manual');
});

test('football: goals add up per half, parameters are counted, voided events are ignored', () => {
  const rs = builtinRuleset({ slug: 'football' });
  const s = computeScore(rs, [ev('goal', 'home', 1), ev('foul', 'away', 1), ev('goal', 'away', 2), ev('goal', 'home', 2), ev('goal', 'home', 2, { voided_at: new Date() }), ev('yellow_card', 'home', 2)]);
  assert.deepEqual([s.home, s.away, s.winner, s.level], [2, 1, 'home', false]);
  assert.deepEqual(s.periods, [{ period: 1, home: 1, away: 0 }, { period: 2, home: 1, away: 1 }]);
  assert.equal(s.stats.away.foul, 1);
  assert.equal(s.stats.home.yellow_card, 1);
  assert.equal(computeScore(rs, [ev('goal', 'home'), ev('goal', 'away')]).level, true);
});

test('basketball and kabaddi use weighted scoring events', () => {
  const bb = computeScore(builtinRuleset({ slug: 'basketball' }), [ev('three_pointer', 'home'), ev('two_pointer', 'home'), ev('free_throw', 'away'), ev('rebound', 'away')]);
  assert.deepEqual([bb.home, bb.away], [5, 1]);
  const kb = computeScore(builtinRuleset({ slug: 'kabaddi' }), [ev('raid_point', 'home'), ev('all_out', 'home'), ev('tackle_point', 'away'), ev('super_raid', 'home')]);
  assert.deepEqual([kb.home, kb.away], [3, 1]);
  assert.equal(computeScore(builtinRuleset({ slug: 'rugby' }), [ev('try', 'home'), ev('conversion', 'home'), ev('penalty_goal', 'away')]).home, 7);
});

// A set that ends h–a: the sides trade points, then the leader takes the rest.
const play = (h, a) => {
  const out = [];
  const both = Math.min(h, a);
  for (let i = 0; i < both; i++) out.push(ev('point', 'home'), ev('point', 'away'));
  for (let i = both; i < h; i++) out.push(ev('point', 'home'));
  for (let i = both; i < a; i++) out.push(ev('point', 'away'));
  return out;
};

test('badminton: win by two, 30 point cap, best of three', () => {
  const rs = builtinRuleset({ slug: 'badminton' });
  assert.deepEqual(computeScore(rs, play(21, 19)).sets, [{ home: 21, away: 19, winner: 'home' }]);
  assert.equal(computeScore(rs, play(21, 21)).sets.length, 0, '21-21 is not over');
  assert.equal(computeScore(rs, play(20, 20)).sets.length, 0);
  assert.equal(computeScore(rs, play(22, 20)).sets.length, 1, 'win by two at 22-20');
  assert.deepEqual(computeScore(rs, play(29, 30)).sets, [{ home: 29, away: 30, winner: 'away' }], 'cap ends it at 30');
  const one = computeScore(rs, [...play(21, 10), ...play(10, 21), ...play(21, 15)]);
  assert.deepEqual([one.home, one.away, one.over, one.winner], [2, 1, true, 'home']);
  const straight = [...play(21, 5), ...play(21, 8)];
  assert.equal(computeScore(rs, straight).over, true);
  assert.equal(matchPhase(rs, straight).can_score, false);
  assert.equal(computeScore(rs, [...play(21, 5), ...play(9, 4)]).current_set.home, 9);
});

test('volleyball: the decider is played to 15', () => {
  const rs = builtinRuleset({ slug: 'volleyball' });
  const four = [...play(25, 20), ...play(20, 25), ...play(25, 22), ...play(22, 25)];
  const s = computeScore(rs, [...four, ...play(15, 13)]);
  assert.deepEqual([s.home, s.away, s.over, s.winner], [3, 2, true, 'home']);
  assert.deepEqual(s.sets.at(-1), { home: 15, away: 13, winner: 'home' });
  const early = computeScore(rs, [...four, ...play(14, 13)]);
  assert.equal(early.over, false);
  assert.deepEqual(early.current_set, { home: 14, away: 13 });
  assert.equal(computeScore(rs, [...four, ...play(14, 12)]).over, false, '14-12 has not reached 15');
});

test('phase tracks periods; rejectReason guards unknown kinds and decided matches', () => {
  const rs = builtinRuleset({ slug: 'football' });
  assert.equal(matchPhase(rs, []).period, 0);
  const ph = matchPhase(rs, [ev('period_start', null, 1), ev('goal', 'home', 1), ev('period_end', null, 1), ev('period_start', null, 2)]);
  assert.deepEqual([ph.period, ph.period_open, ph.periods_total], [2, true, 2]);
  assert.match(rejectReason(rs, [], { kind: 'three_pointer', side: 'home' }), /not part of the Football rules/);
  assert.match(rejectReason(rs, [], { kind: 'goal' }), /side/);
  assert.equal(rejectReason(rs, [], { kind: 'note' }), null);
  assert.match(rejectReason(builtinRuleset({ slug: 'archery', scoring: 'points' }), [], { kind: 'foul', side: 'home' }), /totals/);
  const bd = builtinRuleset({ slug: 'badminton' });
  assert.match(rejectReason(bd, rally([['home', 21], ['home', 21]]), { kind: 'point', side: 'away' }), /already decided/);
});

test('custom rulesets are validated', () => {
  const ok = rulesetSchema.safeParse({ kind: 'points_events', label: 'House rules', events: [{ kind: 'basket', label: 'Basket', points: 2 }] });
  assert.ok(ok.success);
  assert.ok(!rulesetSchema.safeParse({ kind: 'points_events', label: 'Empty' }).success, 'needs events');
  assert.ok(!rulesetSchema.safeParse({ kind: 'sets', label: 'No sets' }).success, 'needs sets');
  assert.ok(!rulesetSchema.safeParse({ kind: 'sets', label: 'Even', sets: { best_of: 4, points_to_win: 21, win_by: 2 } }).success, 'best_of odd');
  assert.ok(!rulesetSchema.safeParse({ kind: 'points_events', label: 'Dupes', events: [{ kind: 'a', label: 'A', points: 1 }, { kind: 'a', label: 'B', points: 2 }] }).success);
});
