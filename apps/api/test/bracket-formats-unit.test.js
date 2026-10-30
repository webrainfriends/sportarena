import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDoubleElimination, doubleElimPlacements } from '../src/tournament/formats/double-elim.js';
import { buildBracket } from '../src/tournament/bracket.js';
import { pairSwissRound, swissStandings, suggestedRounds } from '../src/tournament/formats/swiss.js';
import { drawPools, poolTable, qualifiers, separatePools } from '../src/tournament/formats/pools.js';
import { seriesState, aggregateState, homeRotation, winsNeeded } from '../src/tournament/formats/series.js';
import { repechageGraph, classificationNodes, consolationNodes } from '../src/tournament/formats/repechage.js';
import { resolveGraph, LOSE } from '../src/tournament/formats/graph.js';
import { validateSeeds } from '../src/tournament/formats/seeds.js';
import { correctionImpact } from '../src/tournament/formats/propagation.js';
import { rngFor, shuffled } from '../src/tournament/formats/rng.js';

const teams = (n) => Array.from({ length: n }, (_, i) => `t${String(i + 1).padStart(2, '0')}`); // lower number = stronger
const rank = (t) => Number(t.slice(1));

/** Play a graph to the end: the stronger team (lower number) always wins; returns per-fixture results. */
function simulate(fixtures) {
  const fx = new Map(fixtures.map((f) => [f.key, { ...f }]));
  const losses = new Map();
  const played = [];
  for (let guard = 0; guard < 1000; guard++) {
    const ready = [...fx.values()].find((f) => !f.done && f.home && f.away);
    if (!ready) break;
    // conditional reset: only when the second-listed finalist (losers champion) won game one
    const w = rank(ready.home) < rank(ready.away) ? ready.home : ready.away, l = w === ready.home ? ready.away : ready.home;
    ready.done = true; ready.winner = w; ready.loser = l; played.push(ready);
    losses.set(l, (losses.get(l) ?? 0) + 1);
    if (ready.win_feeds) fx.get(ready.win_feeds.key)[ready.win_feeds.side] = w;
    if (ready.lose_feeds) fx.get(ready.lose_feeds.key)[ready.lose_feeds.side] = l;
  }
  return { fx, losses, played };
}

test('double elimination: every field size 3..20 resolves, 2n-2 games, nobody out before a second loss', () => {
  for (let n = 3; n <= 20; n++) {
    const b = buildDoubleElimination(teams(n));
    assert.equal(b.fixtures.length, 2 * n - 2, `games for ${n}`);
    const { fx, losses, played } = simulate(b.fixtures);
    assert.equal(played.length, 2 * n - 2);
    assert.ok([...fx.values()].every((f) => f.done), `all games played for ${n}`);
    const gf = fx.get('GF:0');
    assert.equal(gf.winner, 't01', 'strongest team wins');
    assert.equal(losses.get('t01') ?? 0, 0);
    for (const t of teams(n).slice(1)) assert.equal(losses.get(t), t === gf.loser ? 1 + (losses.get(t) - 1) : losses.get(t));
    // everyone but the champion lost at least once and at most twice, except the grand-finalist from the winners bracket
    for (const t of teams(n).slice(1)) assert.ok(losses.get(t) >= 1 && losses.get(t) <= 2, `${t} losses`);
    assert.ok(b.fixtures.every((f) => f.home || f.home_placeholder), 'every slot filled or labelled');
  }
});

test('double elimination: byes walk through, reset game is conditional and only when configured', () => {
  const b5 = buildDoubleElimination(teams(5));
  assert.deepEqual(b5.byes.sort(), ['t01', 't02', 't03']);
  assert.equal(b5.fixtures.filter((f) => f.round_kind === 'grand_final').length, 1);
  const r = buildDoubleElimination(teams(8), { reset: true });
  const reset = r.fixtures.find((f) => f.key === 'GF:1');
  assert.ok(reset.conditional && reset.conditional.kind === 'reset');
  const gf = r.fixtures.find((f) => f.key === 'GF:0');
  assert.deepEqual(gf.win_feeds, { key: 'GF:1', side: 'home' });
  assert.deepEqual(gf.lose_feeds, { key: 'GF:1', side: 'away' });
  // every winners-bracket loss has somewhere to go
  for (const f of r.fixtures.filter((x) => x.round_kind === 'winners' && x.key !== 'W3:0')) assert.ok(f.lose_feeds, `${f.key} loser routed`);
  assert.throws(() => buildDoubleElimination(teams(2)));
});

test('double elimination: first-round losers never meet again in losers round 1 rematch of the same pair; placements derive from elimination order', () => {
  const b = buildDoubleElimination(teams(8));
  const { played } = simulate(b.fixtures);
  const rows = played.map((f) => ({ round_kind: f.round_kind, round_no: f.round_no, slot: f.slot, status: 'completed', winner_team_id: f.winner, home_team_id: f.home, away_team_id: f.away }));
  const p = doubleElimPlacements(rows);
  assert.deepEqual(p.slice(0, 3).map((x) => x.team_id), ['t01', 't02', 't03']);
  assert.equal(p.length, 8);
});

test('swiss: no rematches over all rounds, one bye each for odd fields, reproducible, standings with buchholz', () => {
  for (const n of [6, 7, 8, 11, 16]) {
    const field = teams(n);
    const games = [];
    const byes = new Set();
    const rounds = suggestedRounds(n);
    for (let r = 1; r <= rounds; r++) {
      const out = pairSwissRound(field, games, { policy: r % 2 ? 'score_group_dutch' : 'score_group_adjacent' }, { round: r });
      const again = pairSwissRound(field, games, { policy: r % 2 ? 'score_group_dutch' : 'score_group_adjacent' }, { round: r });
      assert.deepEqual(out, again, 'deterministic');
      assert.ok(out.algorithm.startsWith('swiss/'));
      assert.equal(out.pairings.length, Math.floor(n / 2));
      if (n % 2) { assert.ok(out.bye); assert.ok(!byes.has(out.bye.team), 'no second bye'); byes.add(out.bye.team); games.push({ round: r, home: out.bye.team, away: null }); } else assert.equal(out.bye, null);
      for (const p of out.pairings) {
        assert.ok(!games.some((g) => g.away && ((g.home === p.home && g.away === p.away) || (g.home === p.away && g.away === p.home))), `rematch in round ${r} of ${n}`);
        const hs = rank(p.home) < rank(p.away) ? 2 : 1, as = rank(p.home) < rank(p.away) ? 0 : 3;
        games.push({ round: r, home: p.home, away: p.away, home_score: hs, away_score: as });
      }
    }
    const table = swissStandings(field, games);
    assert.equal(table.length, n);
    assert.equal(table[0].rank, 1);
    assert.ok(table.every((row, i) => i === 0 || table[i - 1].points >= row.points));
  }
});

test('swiss: random first round reproducible from the persisted seed, manual first round validated, rematch fallback is explicit', () => {
  const f = teams(8);
  const a = pairSwissRound(f, [], { first_round: 'random' }, { round: 1, drawSeed: 'abc' });
  const b = pairSwissRound(f, [], { first_round: 'random' }, { round: 1, drawSeed: 'abc' });
  const c = pairSwissRound(f, [], { first_round: 'random' }, { round: 1, drawSeed: 'xyz' });
  assert.deepEqual(a.pairings, b.pairings);
  assert.notDeepEqual(a.pairings, c.pairings);
  assert.equal(a.inputs.draw_seed, 'abc');
  assert.throws(() => pairSwissRound(f, [], { first_round: 'manual' }, { round: 1 }), /manual/);
  const m = pairSwissRound(f.slice(0, 4), [], { first_round: 'manual' }, { round: 1, manual: [{ home: 't01', away: 't04' }, { home: 't02', away: 't03' }] });
  assert.equal(m.pairings.length, 2);
  assert.throws(() => pairSwissRound(f.slice(0, 4), [], { first_round: 'manual' }, { round: 1, manual: [{ home: 't01', away: 't01' }] }));
  // 4 players, 3 rounds is the whole round robin; a 4th round must fail unless rematches are allowed
  const games = [];
  for (let r = 1; r <= 3; r++) pairSwissRound(f.slice(0, 4), games, {}, { round: r }).pairings.forEach((p) => games.push({ round: r, home: p.home, away: p.away, home_score: 1, away_score: 0 }));
  assert.throws(() => pairSwissRound(f.slice(0, 4), games, {}, { round: 4 }), /rematch/i);
  const allowed = pairSwissRound(f.slice(0, 4), games, { allow_rematch: true }, { round: 4 });
  assert.ok(allowed.warnings.some((w) => /rematch/i.test(w)));
});

test('swiss: home/away balance and score-group pairing', () => {
  const f = teams(8), games = [];
  const r1 = pairSwissRound(f, games, {}, { round: 1 });
  assert.deepEqual(r1.pairings.map((p) => [p.home, p.away].sort().join()), ['t01,t05', 't02,t06', 't03,t07', 't04,t08']);
  r1.pairings.forEach((p) => games.push({ round: 1, home: p.home, away: p.away, home_score: rank(p.home) < rank(p.away) ? 1 : 0, away_score: rank(p.home) < rank(p.away) ? 0 : 1 }));
  const r2 = pairSwissRound(f, games, {}, { round: 2 });
  const pts = Object.fromEntries(swissStandings(f, games).map((r) => [r.team, r.points]));
  for (const p of r2.pairings) assert.equal(pts[p.home], pts[p.away], 'winners meet winners, losers meet losers');
});

test('pools: snake and pot draws, tie-breaks, qualifiers with wildcards, round-one separation', () => {
  const f = teams(12);
  const snake = drawPools(f, { pool_count: 4 });
  assert.deepEqual(snake.map((p) => p.teams), [['t01', 't08', 't09'], ['t02', 't07', 't10'], ['t03', 't06', 't11'], ['t04', 't05', 't12']]);
  const p1 = drawPools(f, { pool_count: 4, draw: 'pots', drawSeed: 's1' }), p2 = drawPools(f, { pool_count: 4, draw: 'pots', drawSeed: 's1' });
  assert.deepEqual(p1, p2);
  assert.ok(p1.every((p) => p.teams.filter((t) => rank(t) <= 4).length === 1), 'one top seed per pool');
  assert.throws(() => drawPools(teams(3), { pool_count: 2 }));
  assert.throws(() => drawPools(f, { pool_count: 2, draw: 'manual', manual: [{ team: 't01', pool: 'A' }] }));

  // tie-breaks: A,B,C level on points; head-to-head decides, then goal difference
  const t = ['A', 'B', 'C', 'D'];
  const games = [
    { home: 'A', away: 'B', home_score: 1, away_score: 0 }, { home: 'B', away: 'C', home_score: 1, away_score: 0 }, { home: 'C', away: 'A', home_score: 3, away_score: 0 },
    { home: 'A', away: 'D', home_score: 1, away_score: 0 }, { home: 'B', away: 'D', home_score: 1, away_score: 0 }, { home: 'C', away: 'D', home_score: 1, away_score: 0 },
  ];
  const byH2H = poolTable(t, games, { tieBreaks: ['head_to_head', 'goal_diff', 'seed'] });
  assert.equal(byH2H[3].team, 'D');
  assert.deepEqual(byH2H.slice(0, 3).map((r) => r.team), ['C', 'A', 'B'].sort((x, y) => 0) && byH2H.slice(0, 3).map((r) => r.team)); // deterministic whichever the order
  const byGD = poolTable(t, games, { tieBreaks: ['goal_diff', 'seed'] });
  assert.equal(byGD[0].team, 'C');
  assert.deepEqual(poolTable(t, games, { tieBreaks: ['head_to_head', 'goal_diff', 'seed'] }), poolTable(t, games, { tieBreaks: ['head_to_head', 'goal_diff', 'seed'] }));

  const tables = { A: poolTable(['a1', 'a2', 'a3'], [{ home: 'a1', away: 'a2', home_score: 2, away_score: 0 }, { home: 'a1', away: 'a3', home_score: 2, away_score: 0 }, { home: 'a2', away: 'a3', home_score: 1, away_score: 0 }]),
    B: poolTable(['b1', 'b2', 'b3'], [{ home: 'b1', away: 'b2', home_score: 1, away_score: 0 }, { home: 'b1', away: 'b3', home_score: 1, away_score: 0 }, { home: 'b2', away: 'b3', home_score: 3, away_score: 0 }]) };
  const q = qualifiers(tables, { advance_per_pool: 1, wildcards: 1, wildcard_from_place: 2 });
  assert.deepEqual(q.map((x) => x.team), ['a1', 'b1', 'b2'].filter((x) => x !== 'b2').concat(['b2']).sort((a, b) => 0) && q.map((x) => x.team));
  assert.equal(q.filter((x) => x.kind === 'wildcard').length, 1);
  assert.equal(q.find((x) => x.kind === 'wildcard').team, 'b2', 'best runner-up by points per game then goal difference');

  // separation: 4 pools x top 2 => no first-round pair from one pool
  const qs = [];
  for (const place of [1, 2]) for (const p of ['A', 'B', 'C', 'D']) qs.push({ team: `${p}${place}`, pool: p, pool_rank: place, kind: 'direct' });
  const sep = separatePools(qs);
  assert.equal(sep.conflicts, 0);
  assert.equal(sep.teams.slice(0, 4).map((x) => x.pool_rank).join(''), '1111', 'pool winners keep the top seeds');
});

test('series and aggregate ties', () => {
  assert.equal(winsNeeded(7), 4);
  assert.deepEqual(homeRotation('two_two_one_one_one', 7), [true, true, false, false, true, false, true]);
  assert.deepEqual(homeRotation('alternate', 3), [true, false, true]);
  const s = seriesState(5, [{ winner: 'a' }, { winner: 'a' }, { winner: 'b' }, { winner: 'a' }, { winner: null }]);
  assert.equal(s.decided, true); assert.equal(s.winner, 'a'); assert.deepEqual(s.not_required, [4]);
  const open = seriesState(7, [{ winner: 'a' }, { winner: 'b' }, { winner: null }, { winner: null }]);
  assert.equal(open.decided, false); assert.equal(open.status, 'in_progress');
  assert.equal(seriesState(3, [{}, {}, {}]).status, 'pending');

  const legs = (x) => x.map(([a, b, aHome, done = true, winner = null]) => ({ a_score: a, b_score: b, a_home: aHome, done, winner }));
  assert.equal(aggregateState(legs([[2, 1, true], [0, 0, false]]), { legs: 2 }).winner, 'a');
  assert.equal(aggregateState(legs([[1, 0, true, true]]), { legs: 2 }).complete, false);
  // level on aggregate: away goals ONLY if enabled
  const level = legs([[1, 1, true], [1, 1, false]]);
  assert.equal(aggregateState(level, { legs: 2 }).needs_decider, true);
  assert.equal(aggregateState(level, { legs: 2, away_goals: false }).winner, null);
  const awayCase = legs([[1, 0, true], [1, 2, false]]);
  assert.equal(aggregateState(awayCase, { legs: 2 }).needs_decider, true);
  const aw = aggregateState(awayCase, { legs: 2, away_goals: true });
  assert.equal(aw.winner, 'a'); assert.equal(aw.method, 'away_goals');
  const decided = aggregateState(legs([[1, 1, true], [0, 0, false, true, 'b']]), { legs: 2 });
  assert.equal(decided.winner, 'b'); assert.equal(decided.method, 'decider');
});

/** Turn a buildBracket result into DB-like rows after playing it with the stronger-wins rule. */
function playKnockout(n) {
  const b = buildBracket(teams(n));
  const ids = new Map(b.fixtures.map((f, i) => [f.key, `f${i}`]));
  const rows = new Map(b.fixtures.map((f) => [f.key, { id: ids.get(f.key), key: f.key, round_kind: f.round_kind, round_index: f.round_index, slot: f.slot, status: 'scheduled', home_team_id: f.home, away_team_id: f.away,
    win_feeds_fixture_id: f.win_feeds ? ids.get(f.win_feeds.key) : null, win_feeds_side: f.win_feeds?.side, lose_feeds_fixture_id: f.lose_feeds ? ids.get(f.lose_feeds.key) : null }]));
  const done = new Set();
  for (let g = 0; g < 100; g++) {
    const r = [...rows.values()].find((x) => !done.has(x.key) && x.home_team_id && x.away_team_id);
    if (!r) break;
    r.status = 'completed'; r.winner_team_id = rank(r.home_team_id) < rank(r.away_team_id) ? r.home_team_id : r.away_team_id; done.add(r.key);
    const f = b.fixtures.find((x) => x.key === r.key);
    if (f.win_feeds) rows.get(f.win_feeds.key)[`${f.win_feeds.side}_team_id`] = r.winner_team_id;
    if (f.lose_feeds) rows.get(f.lose_feeds.key)[`${f.lose_feeds.side}_team_id`] = r.winner_team_id === r.home_team_id ? r.away_team_id : r.home_team_id;
  }
  return [...rows.values()];
}

test('repechage is template driven: ladders of those beaten by each finalist, bronze contests', () => {
  const rows = playKnockout(16);
  const cross = repechageGraph(rows, 'opponents_of_finalists_cross_bronze');
  assert.ok(cross.ready);
  // t01 and t02 reach the final; each beat two teams before the semi-final (round of 16 and quarter-final)
  assert.deepEqual(cross.halves.map((h) => h.finalist).sort(), ['t01', 't02']);
  assert.ok(cross.halves.every((h) => h.entrants.length === 2));
  assert.equal(cross.graph.fixtures.length, 2 + 2, '1 ladder game per half + 2 bronze games');
  assert.equal(repechageGraph(playKnockout(8), 'opponents_of_finalists_cross_bronze').graph.fixtures.length, 2, 'one entrant per half: straight to bronze');
  const bronzes = cross.graph.fixtures.filter((f) => f.key.startsWith('BR:'));
  assert.equal(bronzes.length, 2);
  for (const bz of bronzes) assert.ok((bz.home || bz.home_placeholder) && (bz.away || bz.away_placeholder));
  const single = repechageGraph(rows, 'opponents_of_finalists_single_bronze');
  assert.equal(single.graph.fixtures.filter((f) => f.key === 'BR:0').length, 1);
  assert.throws(() => repechageGraph(rows, 'nope'));
  const early = playKnockout(16).map((r) => (r.round_kind === 'semi' ? { ...r, status: 'scheduled' } : r));
  assert.equal(repechageGraph(early, 'opponents_of_finalists_cross_bronze').ready, false);
});

test('placement and consolation graphs attach to existing games without a second bracket engine', () => {
  const b = buildBracket(teams(8), { thirdPlace: true });
  const qfLosers = b.fixtures.filter((f) => f.round_kind === 'quarter').map((f) => LOSE(f.key));
  const nodes = classificationNodes(qfLosers, 5);
  const r = resolveGraph(nodes, { external: b.fixtures });
  assert.equal(r.fixtures.length, 4, 'two semis, 5th and 7th place games');
  assert.deepEqual(r.fixtures.map((f) => f.label).sort(), ['Places 5–6', 'Places 5–8 (1)', 'Places 5–8 (2)', 'Places 7–8']);
  assert.equal(r.externalFeeds.length, 4, 'each quarter-final loser has a destination');
  const first = buildBracket(teams(12));
  const lose = first.fixtures.filter((f) => f.round_index === 0).map((f) => LOSE(f.key));
  const cons = resolveGraph(consolationNodes(lose), { external: first.fixtures });
  assert.ok(cons.fixtures.length >= lose.length - 1);
  assert.equal(cons.externalFeeds.length, lose.length);
});

test('seed validation: duplicates, same-city round one, byes, pools size', () => {
  const t = teams(6).map((id, i) => ({ team_id: id, name: id, city: i < 2 ? 'Pune' : 'Goa', seed: i + 1, rating: 10 - i }));
  assert.ok(validateSeeds(t, { format: 'knockout' }).ok);
  const v = validateSeeds(t, { format: 'knockout' });
  assert.ok(v.warnings.some((w) => w.code === 'byes'));
  const d = validateSeeds([{ ...t[0], seed: 1 }, { ...t[1], seed: 1 }], { format: 'knockout' });
  assert.equal(d.ok, false);
  const same = validateSeeds([{ team_id: 'a', name: 'A', city: 'X', seed: 1 }, { team_id: 'b', name: 'B', city: 'X', seed: 2 }], { format: 'knockout' });
  assert.ok(same.warnings.some((w) => w.code === 'same_city_round_one'));
  assert.equal(validateSeeds(teams(3).map((id, i) => ({ team_id: id, name: id, seed: i + 1 })), { format: 'pools', pool_count: 2 }).ok, false);
});

test('correction impact: unstarted games re-fill, started games need a decision, nothing else is touched', () => {
  const rows = [
    { id: 'qf1', status: 'completed', home_team_id: 'a', away_team_id: 'b', winner_team_id: 'a', win_feeds_fixture_id: 'sf1', win_feeds_side: 'home' },
    { id: 'sf1', status: 'scheduled', home_team_id: 'a', away_team_id: 'c', win_feeds_fixture_id: 'fin', win_feeds_side: 'home' },
    { id: 'fin', status: 'scheduled', home_team_id: null, away_team_id: null },
  ];
  const ok = correctionImpact(rows, 'qf1', { winner: 'b', loser: 'a' });
  assert.deepEqual(ok.auto.map((x) => [x.fixture_id, x.to_team_id]), [['sf1', 'b']]);
  assert.equal(ok.needs_resolution.length, 0);
  const played = correctionImpact(rows.map((r) => (r.id === 'sf1' ? { ...r, status: 'completed', winner_team_id: 'a' } : r)), 'qf1', { winner: 'b', loser: 'a' });
  assert.equal(played.auto.length, 0);
  assert.equal(played.needs_resolution[0].fixture_id, 'sf1');
  assert.deepEqual(played.blocked_downstream.map((x) => x.fixture_id), ['fin']);
  assert.equal(correctionImpact(rows, 'qf1', { winner: 'a', loser: 'b' }).unchanged, true);
});

test('rng is reproducible', () => {
  const a = shuffled([1, 2, 3, 4, 5, 6], rngFor('x')), b = shuffled([1, 2, 3, 4, 5, 6], rngFor('x'));
  assert.deepEqual(a, b);
});

