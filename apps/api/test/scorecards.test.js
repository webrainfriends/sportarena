import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxingDecision, rankLifts, roundProblem } from '../src/scoring/scorecards.js';

const card = (...rounds) => ({ rounds: rounds.map(([red, blue]) => ({ red, blue })) });

test('boxing 10-point must: rounds are checked, judges decide, the bout goes to most judges', () => {
  assert.equal(roundProblem({ red: 10, blue: 9 }), null);
  assert.equal(roundProblem({ red: 10, blue: 10 }), null, 'an even round');
  assert.match(roundProblem({ red: 9, blue: 9 }), /gets 10/);
  assert.match(roundProblem({ red: 11, blue: 9 }), /0 to 10/);
  const unanimous = boxingDecision([card([10, 9], [10, 9], [9, 10]), card([10, 9], [10, 9], [10, 9]), card([10, 9], [9, 10], [10, 9])], 3);
  assert.equal(unanimous.winner, 'red'); assert.equal(unanimous.kind, 'unanimous'); assert.deepEqual(unanimous.votes, { red: 3, blue: 0, draw: 0 });
  assert.equal(unanimous.judges[0].red, 29); assert.equal(unanimous.judges[0].blue, 28);
  const split = boxingDecision([card([10, 9], [10, 9], [10, 9]), card([9, 10], [9, 10], [10, 9]), card([10, 9], [9, 10], [10, 9])], 3);
  assert.equal(split.winner, 'red'); assert.equal(split.kind, 'split');
  const majority = boxingDecision([card([10, 9], [10, 9], [10, 9]), card([10, 10], [10, 10], [10, 10]), card([10, 9], [9, 10], [10, 9])], 3);
  assert.equal(majority.kind, 'majority'); assert.equal(majority.winner, 'red'); assert.equal(majority.votes.draw, 1);
  const draw = boxingDecision([card([10, 9], [9, 10]), card([9, 10], [10, 9])], 2);
  assert.equal(draw.winner, 'draw'); assert.equal(draw.kind, 'draw');
  const bad = boxingDecision([card([10, 9], [9, 9], [10, 9])], 3);
  assert.equal(bad.problems.length, 1); assert.match(bad.problems[0].message, /Judge 1, round 2/);
  assert.equal(bad.judges[0].rounds, 2, 'a bad round is not counted'); assert.equal(bad.complete, false);
  assert.equal(boxingDecision([], 3).winner, null);
});

test('weightlifting: best good lifts, the total, bomb-outs, ties by body weight and falling weights', () => {
  const at = (...a) => a.map(([kg, ok]) => ({ kg, ok }));
  const r = rankLifts([
    { name: 'A', body_kg: 80, attempts: at([100, true], [105, false], [105, true], [130, true], [135, false], [135, false]) },     // 105 + 130 = 235
    { name: 'B', body_kg: 79, attempts: at([100, true], [105, true], [110, false], [125, true], [130, true], [135, false]) },     // 105 + 130 = 235 lighter
    { name: 'C', body_kg: 90, attempts: at([120, false], [120, false], [120, false], [150, true], [155, true], [160, true]) },    // no snatch: no total
    { name: 'D', body_kg: 70, attempts: at([90, true], [95, true], [100, true], [120, true], [125, true], [130, true]) },         // 100 + 130 = 230
    { name: 'E', body_kg: 70, attempts: at([95, true], [90, true]) },
  ]);
  assert.deepEqual(r.rows.map((x) => x.total), [235, 235, null, 230, null]);
  assert.deepEqual(r.rows.map((x) => x.rank), [2, 1, null, 3, null], 'equal totals: the lighter lifter ranks first');
  assert.equal(r.rows[2].bust, true); assert.equal(r.rows[0].best_snatch, 105); assert.equal(r.rows[1].best_cj, 130);
  assert.equal(r.warnings.length, 1); assert.match(r.warnings[0].message, /E: a snatch attempt went down/);
  const alone = rankLifts([{ attempts: at([100, true], [100, true], [100, true], [120, true]) }], 3);
  assert.equal(alone.rows[0].rank, 1);
  assert.equal(rankLifts([{ body_kg: 60, attempts: at([50, true], [0, null], [0, null], [60, true]) }, { body_kg: 60, attempts: at([50, true], [0, null], [0, null], [60, true]) }]).rows.map((x) => x.rank).join(), '1,1', 'same total and weight share a place');
});
