// Pools (groups) → knockout. Pools are drawn from the seeds (snake or pots), play round robin, and a rule decides who goes through:
// the top N of every pool plus, optionally, the best of the next place (wildcards). Qualifiers are then seeded into a knockout so that
// teams from the same pool avoid meeting in round one where the field allows it. Every tie-break criterion is named in the config.
import { rngFor, shuffled } from './rng.js';
import { seedOrder } from '../bracket.js';

export const POOL_TIEBREAKS = ['head_to_head', 'goal_diff', 'goals_for', 'wins', 'fewest_goals_against', 'seed'];
export const DEFAULT_POOLS = { pool_count: 2, draw: 'snake', advance_per_pool: 2, wildcards: 0, wildcard_from_place: null, tie_breaks: ['head_to_head', 'goal_diff', 'goals_for', 'wins', 'seed'], avoid_same_pool_round_one: true, third_place: false };
export const poolName = (i) => String.fromCharCode(65 + (i % 26)) + (i >= 26 ? String(Math.floor(i / 26)) : '');

/**
 * Draw teams into pools.
 * snake: seed 1→A, 2→B … then back (1,2,3,3,2,1). pots: seeds are cut into pots of pool_count; each pot is drawn at random (seeded RNG) over the pools,
 * seed 1 pot first (so top seeds are protected from each other). manual: the caller's assignment, validated.
 */
export function drawPools(teams, { pool_count, draw = 'snake', drawSeed, manual } = {}) {
  const n = teams.length, k = pool_count;
  if (k < 2) throw new Error('Pools need at least 2 pools');
  if (n < k * 2) throw new Error(`${k} pools need at least ${k * 2} teams`);
  const pools = Array.from({ length: k }, (_, i) => ({ name: poolName(i), teams: [] }));
  if (draw === 'manual') {
    if (!manual?.length) throw new Error('Manual draw needs the pool of every team');
    const seen = new Set();
    for (const m of manual) { const p = pools.find((x) => x.name === m.pool); if (!p) throw new Error(`Unknown pool ${m.pool}`); if (!teams.includes(m.team) || seen.has(m.team)) throw new Error('Manual draw names a team twice or one that is not in the field'); seen.add(m.team); p.teams.push(m.team); }
    if (seen.size !== n) throw new Error('Every team must be placed in a pool');
  } else if (draw === 'pots') {
    const rng = rngFor(`${drawSeed ?? 'pools'}:pots`);
    for (let i = 0; i < n; i += k) {
      const pot = teams.slice(i, i + k);
      const idx = shuffled(pools.map((_, j) => j).filter((j) => pools[j].teams.length === Math.floor(i / k)), rng);
      // pools that already hold more teams than this pot's depth do not receive another one from a short last pot
      pot.forEach((t, j) => pools[idx[j] ?? idx[idx.length - 1]].teams.push(t));
    }
  } else {
    teams.forEach((t, i) => { const lap = Math.floor(i / k), j = i % k; pools[lap % 2 ? k - 1 - j : j].teams.push(t); });
  }
  return pools;
}

/** Pool table with explicit tie-breaks. games: completed { home, away, home_score, away_score }. */
export function poolTable(teams, games, { pointsWin = 3, pointsDraw = 1, pointsLoss = 0, tieBreaks = DEFAULT_POOLS.tie_breaks } = {}) {
  const seedOf = new Map(teams.map((t, i) => [t, i]));
  const row = new Map(teams.map((t) => [t, { team: t, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, points: 0 }]));
  const among = (set) => { // mini-table among a subset (head to head)
    const m = new Map([...set].map((t) => [t, { points: 0, gd: 0, gf: 0 }]));
    for (const g of games) if (set.has(g.home) && set.has(g.away) && g.home_score != null) {
      const h = m.get(g.home), a = m.get(g.away), d = g.home_score - g.away_score;
      h.gd += d; a.gd -= d; h.gf += g.home_score; a.gf += g.away_score;
      if (d > 0) h.points += pointsWin; else if (d < 0) a.points += pointsWin; else { h.points += pointsDraw; a.points += pointsDraw; }
    }
    return m;
  };
  for (const g of games) {
    const h = row.get(g.home), a = row.get(g.away);
    if (!h || !a || g.home_score == null || g.away_score == null) continue;
    h.played++; a.played++; h.gf += g.home_score; h.ga += g.away_score; a.gf += g.away_score; a.ga += g.home_score;
    if (g.home_score > g.away_score) { h.won++; a.lost++; h.points += pointsWin; a.points += pointsLoss; }
    else if (g.home_score < g.away_score) { a.won++; h.lost++; a.points += pointsWin; h.points += pointsLoss; }
    else { h.drawn++; a.drawn++; h.points += pointsDraw; a.points += pointsDraw; }
  }
  const rows = [...row.values()];
  const byPoints = new Map();
  for (const r of rows) (byPoints.get(r.points) ?? byPoints.set(r.points, []).get(r.points)).push(r);
  const ordered = [...byPoints.keys()].sort((x, y) => y - x).flatMap((pts) => orderTied(byPoints.get(pts), tieBreaks, seedOf, among));
  return ordered.map((r, i) => ({ ...r, rank: i + 1, goal_diff: r.gf - r.ga }));
}

function orderTied(group, tieBreaks, seedOf, among) {
  if (group.length < 2) return group;
  let groups = [group];
  for (const tb of tieBreaks) {
    if (tb === 'seed') break;
    const next = [];
    for (const g of groups) {
      if (g.length < 2) { next.push(g); continue; }
      let val;
      if (tb === 'head_to_head') { const m = among(new Set(g.map((r) => r.team))); val = (r) => m.get(r.team).points * 1e6 + m.get(r.team).gd * 1e3 + m.get(r.team).gf; }
      else val = { goal_diff: (r) => r.gf - r.ga, goals_for: (r) => r.gf, wins: (r) => r.won, fewest_goals_against: (r) => -r.ga }[tb] ?? (() => 0);
      const sorted = g.slice().sort((x, y) => val(y) - val(x));
      let cur = [sorted[0]];
      for (const r of sorted.slice(1)) { if (val(r) === val(cur[0])) cur.push(r); else { next.push(cur); cur = [r]; } }
      next.push(cur);
    }
    groups = next;
  }
  return groups.flatMap((g) => g.slice().sort((x, y) => seedOf.get(x.team) - seedOf.get(y.team)));
}

/**
 * Who goes through. tables: { A: [rows…], B: […] } ordered by pool_table. Returns qualifiers in knockout seeding order:
 * pool winners (best record first), then second places … then wildcards. Wildcards are ranked on points per game (pools may differ in size).
 */
export function qualifiers(tables, { advance_per_pool = 2, wildcards = 0, wildcard_from_place = null } = {}) {
  const names = Object.keys(tables);
  const ppg = (r) => (r.played ? r.points / r.played : 0);
  const rank = (a, b) => ppg(b) - ppg(a) || b.goal_diff / Math.max(1, b.played) - a.goal_diff / Math.max(1, a.played) || b.gf / Math.max(1, b.played) - a.gf / Math.max(1, a.played);
  const out = [];
  for (let place = 1; place <= advance_per_pool; place++) {
    const tier = names.map((p) => ({ ...tables[p][place - 1], pool: p, pool_rank: place })).filter((r) => r.team).sort((a, b) => rank(a, b) || names.indexOf(a.pool) - names.indexOf(b.pool));
    tier.forEach((r) => out.push({ team: r.team, pool: r.pool, pool_rank: r.pool_rank, kind: 'direct' }));
  }
  if (wildcards > 0) {
    const place = wildcard_from_place ?? advance_per_pool + 1;
    const pick = names.map((p) => ({ ...tables[p][place - 1], pool: p, pool_rank: place })).filter((r) => r.team).sort((a, b) => rank(a, b) || names.indexOf(a.pool) - names.indexOf(b.pool)).slice(0, wildcards);
    pick.forEach((r) => out.push({ team: r.team, pool: r.pool, pool_rank: r.pool_rank, kind: 'wildcard' }));
  }
  return out;
}

/**
 * Order a list of qualifiers (best first) so that, where the field allows, round-one opponents come from different pools. Teams only move
 * between positions on the same side of their pair (the lower half of the draw), so a pool winner never loses its top-seed standing.
 * Returns { teams: qualifier[] in seed order, conflicts: number of round-one pairs still from one pool }.
 */
export function separatePools(quals, { avoid = true } = {}) {
  const n = quals.length;
  if (!avoid || n < 4) return { teams: quals.slice(), conflicts: countConflicts(quals) };
  const size = (() => { let s = 2; while (s < n) s *= 2; return s; })(), order = seedOrder(size);
  const best = (list) => list;
  const arr = quals.slice();
  const pairs = [];
  for (let s = 0; s < size / 2; s++) pairs.push([order[2 * s], order[2 * s + 1]]); // seed numbers in round one
  const poolAt = (seed) => arr[seed - 1]?.pool;
  const clash = ([a, b]) => arr[a - 1] && arr[b - 1] && poolAt(a) === poolAt(b);
  // try swapping the lower seeds of conflicting pairs with the lower seeds of other pairs (all of one "tier": the higher number of each pair)
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (let i = 0; i < pairs.length; i++) {
      if (!clash(pairs[i])) continue;
      const low = Math.max(...pairs[i]);
      for (let j = 0; j < pairs.length && clash(pairs[i]); j++) {
        if (j === i) continue;
        const lowJ = Math.max(...pairs[j]);
        if (!arr[lowJ - 1]) continue; // a bye slot
        [arr[low - 1], arr[lowJ - 1]] = [arr[lowJ - 1], arr[low - 1]];
        if (clash(pairs[i]) || clash(pairs[j])) { [arr[low - 1], arr[lowJ - 1]] = [arr[lowJ - 1], arr[low - 1]]; } else changed = true;
      }
    }
    if (!changed) break;
  }
  return { teams: best(arr), conflicts: pairs.filter(clash).length };
}
function countConflicts(q) {
  const n = q.length, size = (() => { let s = 2; while (s < n) s *= 2; return s; })(), order = seedOrder(size);
  let c = 0;
  for (let s = 0; s < size / 2; s++) { const a = q[order[2 * s] - 1], b = q[order[2 * s + 1] - 1]; if (a && b && a.pool === b.pool) c++; }
  return c;
}
