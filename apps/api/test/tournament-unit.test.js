import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedOrder, buildBracket } from '../src/tournament/bracket.js';
import { planSchedule, roundRobinPairs } from '../src/tournament/scheduler.js';
import { rateTeams, ratingOf } from '../src/tournament/ranking.js';

const H = 3600_000;
const slots = (day, hours, res = 'c1') => hours.map((h) => ({ start: new Date(Date.UTC(2030, 0, day, h)), end: new Date(Date.UTC(2030, 0, day, h + 1)) }));

test('seedOrder pairs 1 v N, 2 v N-1 and keeps the top seeds apart', () => {
  assert.deepEqual(seedOrder(2), [1, 2]);
  assert.deepEqual(seedOrder(4), [1, 4, 2, 3]);
  assert.deepEqual(seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
});

test('8 teams: quarter → semi → final with winners feeding forward', () => {
  const teams = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const b = buildBracket(teams, { thirdPlace: true });
  const by = (k) => b.fixtures.filter((f) => f.round_kind === k);
  assert.equal(by('quarter').length, 4); assert.equal(by('semi').length, 2); assert.equal(by('final').length, 1); assert.equal(by('third_place').length, 1);
  assert.deepEqual(by('quarter').map((f) => [f.home, f.away]), [['A', 'H'], ['D', 'E'], ['B', 'G'], ['C', 'F']]);
  const q = by('quarter');
  assert.equal(q[0].win_feeds.key, 'semi:0'); assert.equal(q[0].win_feeds.side, 'home');
  assert.equal(q[1].win_feeds.key, 'semi:0'); assert.equal(q[1].win_feeds.side, 'away');
  assert.equal(by('semi')[0].win_feeds.key, 'final:0');
  assert.equal(by('semi')[1].lose_feeds.key, 'third_place:0');
  assert.match(by('final')[0].home_placeholder, /Winner Semi-final 1/);
  assert.deepEqual(b.byes, []);
});

test('6 teams: seeds 1 and 2 get byes straight into the semi-finals', () => {
  const b = buildBracket(['A', 'B', 'C', 'D', 'E', 'F']);
  const quarters = b.fixtures.filter((f) => f.round_kind === 'quarter');
  assert.deepEqual(quarters.map((f) => [f.home, f.away]), [['D', 'E'], ['C', 'F']]);
  const semis = b.fixtures.filter((f) => f.round_kind === 'semi');
  assert.equal(semis[0].home, 'A'); assert.equal(semis[0].home_placeholder, null); assert.match(semis[0].away_placeholder, /Winner Quarter-final 2/);
  assert.equal(semis[1].home, 'B');
  assert.deepEqual(b.byes.sort(), ['A', 'B']);
  assert.throws(() => buildBracket(['A']), /at least 2/);
});

test('3 teams: one semi-final, bye for the top seed, no third-place game', () => {
  const b = buildBracket(['A', 'B', 'C'], { thirdPlace: true });
  assert.equal(b.fixtures.filter((f) => f.round_kind === 'third_place').length, 0);
  assert.deepEqual(b.fixtures.filter((f) => f.round_kind === 'semi').map((f) => [f.home, f.away]), [['B', 'C']]);
  assert.equal(b.fixtures.find((f) => f.round_kind === 'final').home, 'A');
});

test('scheduler never double-books a team or a court and respects rest and dependencies', () => {
  const matches = roundRobinPairs(['A', 'B', 'C', 'D']).map((m, n) => ({ key: `m${n}`, home: m.home, away: m.away }));
  const days = [1, 2, 3, 4].map((d) => ({ date: `2030-01-0${d}`, runs: [{ resourceId: 'c1', slots: slots(d, [9, 10, 11, 12]) }, { resourceId: 'c2', slots: slots(d, [9, 10, 11, 12]) }] }));
  const { placed, unplaced } = planSchedule({ matches, days, durationMin: 60, restMin: 60, maxPerTeamPerDay: 1 });
  assert.equal(unplaced.length, 0); assert.equal(placed.length, 6);
  for (const [i, a] of placed.entries()) for (const b of placed.slice(i + 1)) {
    const clash = a.start < b.end && b.start < a.end;
    if (a.resource_id === b.resource_id) assert.ok(!clash, 'same court overlap');
    const ma = matches.find((m) => m.key === a.key), mb = matches.find((m) => m.key === b.key);
    if ([ma.home, ma.away].some((t) => [mb.home, mb.away].includes(t))) assert.ok(a.date !== b.date, 'a team played twice in a day');
  }
  const ko = planSchedule({
    matches: [{ key: 'qf', home: 'A', away: 'B' }, { key: 'f', after: ['qf'] }],
    days: [{ date: '2030-01-01', runs: [{ resourceId: 'c1', slots: slots(1, [9, 10, 11]) }] }], durationMin: 60, restMin: 60,
  });
  assert.deepEqual(ko.placed.map((p) => [p.key, p.start.getUTCHours()]), [['qf', 9], ['f', 11]], 'final waits for the feeder plus rest');
});

test('scheduler reports what does not fit instead of dropping games silently', () => {
  const matches = [{ key: 'a', home: 'A', away: 'B' }, { key: 'b', home: 'C', away: 'D' }, { key: 'c', home: 'A', away: 'C' }];
  const { placed, unplaced } = planSchedule({ matches, days: [{ date: '2030-01-01', runs: [{ resourceId: 'c1', slots: slots(1, [9]) }] }], durationMin: 60 });
  assert.equal(placed.length, 1); assert.deepEqual(unplaced.map((u) => u.key), ['b', 'c']);
  const dep = planSchedule({ matches: [{ key: 'x', home: 'A', away: 'B' }, { key: 'y', after: ['x'] }], days: [], durationMin: 60 });
  assert.match(dep.unplaced[1].reason, /waiting on x/);
});

test('scheduler honours games a team already has elsewhere', () => {
  const busy = new Map([['A', [{ start: new Date(Date.UTC(2030, 0, 1, 9)), end: new Date(Date.UTC(2030, 0, 1, 10, 30)) }]]]);
  const { placed } = planSchedule({ matches: [{ key: 'm', home: 'A', away: 'B' }], days: [{ date: '2030-01-01', runs: [{ resourceId: 'c', slots: slots(1, [9, 10, 11, 12]) }] }], durationMin: 60, restMin: 60, teamBusy: busy });
  assert.equal(placed[0].start.getUTCHours(), 12, 'needs an hour of rest after the 10:30 finish');
});

test('ratings: recent dominant results rank first, small samples are pulled to the average', () => {
  const now = new Date('2030-06-01');
  const g = (home, away, hs, as, days) => ({ home, away, hs, as, at: new Date(+now - days * 864e5) });
  const games = [];
  for (let i = 0; i < 6; i++) games.push(g('Top', 'Mid', 3, 0, 10 + i), g('Mid', 'Low', 2, 0, 20 + i));
  games.push(g('Lucky', 'Low', 1, 0, 5));
  const r = rateTeams(games, { now });
  assert.ok(ratingOf(r, 'Top').rating > ratingOf(r, 'Mid').rating);
  assert.ok(ratingOf(r, 'Mid').rating > ratingOf(r, 'Low').rating);
  assert.ok(ratingOf(r, 'Lucky').rating < ratingOf(r, 'Top').rating, 'one win is not a #1');
  assert.equal(ratingOf(r, 'Nobody').played, 0);
  assert.equal(ratingOf(r, 'Nobody').rating, r.mean);
  const old = rateTeams([g('A', 'B', 3, 0, 1500), g('B', 'C', 3, 0, 1), g('C', 'A', 0, 0, 1)], { now });
  assert.ok(ratingOf(old, 'B').rating > ratingOf(old, 'A').rating, 'old results count for less than fresh ones');
});
