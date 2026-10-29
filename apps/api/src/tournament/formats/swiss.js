// Swiss-system pairing. There is no single universal Swiss algorithm, so the competition picks a named, versioned policy and every
// round records which one produced it, the inputs it saw, and why each pair was made.
//
//   score_group_dutch@1     players are ranked by (points, tie-breaks, seed); inside a score group the top half meets the bottom half.
//   score_group_adjacent@1  inside a score group the best meets the next best (1v2, 3v4 ...).
//
// Both: no rematch unless it is unavoidable (then a warning says so), an odd field gives the bye to the lowest-ranked player who has not had
// one, an odd score group floats a player down, and home/away is balanced from each player's history. Neither claims to be a federation's
// certified pairing system.
import { rngFor, shuffled } from './rng.js';

export const SWISS_POLICIES = {
  score_group_dutch: { version: 1, label: 'Score groups — top half v bottom half', note: 'Simplified Dutch-style pairing; not a certified federation system.' },
  score_group_adjacent: { version: 1, label: 'Score groups — adjacent in ranking', note: 'Neighbours in the ranking meet (1v2, 3v4 ...).' },
};
export const SWISS_TIEBREAKS = ['buchholz', 'median_buchholz', 'sonneborn_berger', 'wins', 'score_diff', 'head_to_head', 'seed'];
export const FIRST_ROUND = ['seeded', 'random', 'manual'];
export const DEFAULT_SWISS = { rounds: 5, policy: 'score_group_dutch', first_round: 'seeded', tie_breaks: ['buchholz', 'sonneborn_berger', 'wins', 'seed'], bye_points: 'win', allow_rematch: false, balance_home_away: true };
export const suggestedRounds = (n) => Math.max(1, Math.ceil(Math.log2(Math.max(2, n))));

/**
 * Standings from finished games. games: [{ round, home, away, home_score, away_score }] (away null = bye for home).
 * @returns {{team, rank, points, wins, draws, losses, played, buchholz, median_buchholz, sonneborn_berger, score_diff, byes}[]}
 */
export function swissStandings(teams, games, { pointsWin = 3, pointsDraw = 1, pointsLoss = 0, byePoints = 'win', tieBreaks = DEFAULT_SWISS.tie_breaks } = {}) {
  const seedOf = new Map(teams.map((t, i) => [t, i]));
  const row = new Map(teams.map((t) => [t, { team: t, points: 0, wins: 0, draws: 0, losses: 0, played: 0, score_diff: 0, byes: 0, opp: [], results: new Map() }]));
  for (const g of games) {
    const h = row.get(g.home), a = g.away ? row.get(g.away) : null;
    if (!h) continue;
    if (!g.away) { h.byes++; h.played++; const p = byePoints === 'win' ? pointsWin : byePoints === 'draw' ? pointsDraw : 0; h.points += p; if (byePoints === 'win') h.wins++; else if (byePoints === 'draw') h.draws++; continue; }
    if (!a || g.home_score == null || g.away_score == null) continue;
    h.played++; a.played++; h.opp.push(g.away); a.opp.push(g.home);
    h.score_diff += g.home_score - g.away_score; a.score_diff += g.away_score - g.home_score;
    const [hp, ap, hr, ar] = g.home_score > g.away_score ? [pointsWin, pointsLoss, 'wins', 'losses'] : g.home_score < g.away_score ? [pointsLoss, pointsWin, 'losses', 'wins'] : [pointsDraw, pointsDraw, 'draws', 'draws'];
    h.points += hp; a.points += ap; h[hr]++; a[ar]++;
    h.results.set(g.away, (h.results.get(g.away) ?? 0) + hp); a.results.set(g.home, (a.results.get(g.home) ?? 0) + ap);
  }
  const pts = (t) => row.get(t)?.points ?? 0;
  for (const r of row.values()) {
    const opp = r.opp.map(pts).sort((x, y) => x - y);
    r.buchholz = opp.reduce((s, x) => s + x, 0);
    r.median_buchholz = opp.length > 2 ? opp.slice(1, -1).reduce((s, x) => s + x, 0) : r.buchholz;
    r.sonneborn_berger = [...r.results].reduce((s, [o, p]) => s + (p > 0 ? pts(o) * (p / Math.max(1, pointsWin)) : 0), 0);
  }
  const H2H = (a, b) => (row.get(a).results.get(b) ?? 0) - (row.get(b).results.get(a) ?? 0);
  const key = { buchholz: (r) => r.buchholz, median_buchholz: (r) => r.median_buchholz, sonneborn_berger: (r) => r.sonneborn_berger, wins: (r) => r.wins, score_diff: (r) => r.score_diff };
  const cmp = (a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    for (const tb of tieBreaks) {
      if (tb === 'seed') break;
      if (tb === 'head_to_head') { const d = H2H(b.team, a.team); if (d) return d; continue; }
      const d = key[tb]?.(b) - key[tb]?.(a);
      if (d) return d;
    }
    return seedOf.get(a.team) - seedOf.get(b.team);
  };
  return [...row.values()].sort(cmp).map((r, i) => ({ team: r.team, rank: i + 1, points: r.points, wins: r.wins, draws: r.draws, losses: r.losses, played: r.played, score_diff: r.score_diff, byes: r.byes,
    buchholz: round2(r.buchholz), median_buchholz: round2(r.median_buchholz), sonneborn_berger: round2(r.sonneborn_berger) }));
}
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Pair one round.
 * @param {string[]} teams best seed first
 * @param {object[]} games every finished (or already paired) game so far: { round, home, away, home_score, away_score }
 * @param {object} cfg Swiss config (DEFAULT_SWISS merged with the stage's)
 * @param {{round:number, drawSeed?:string, manual?:{home:string,away:string}[], pointsWin?, pointsDraw?, pointsLoss?}} ctx
 */
export function pairSwissRound(teams, games, cfg, ctx) {
  const c = { ...DEFAULT_SWISS, ...cfg };
  if (!SWISS_POLICIES[c.policy]) throw new Error(`Unknown Swiss pairing policy "${c.policy}"`);
  const round = ctx.round, warnings = [];
  const algorithm = `swiss/${c.policy}@${SWISS_POLICIES[c.policy].version}`;
  const inputs = { round, policy: c.policy, first_round: c.first_round, tie_breaks: c.tie_breaks, allow_rematch: c.allow_rematch, bye_points: c.bye_points, teams, previous_games: games.length, draw_seed: ctx.drawSeed ?? null };

  const played = new Set(), homeCount = new Map(), awayCount = new Map(), hadBye = new Set();
  for (const g of games) {
    if (!g.away) { hadBye.add(g.home); continue; }
    played.add(pairKey(g.home, g.away));
    homeCount.set(g.home, (homeCount.get(g.home) ?? 0) + 1); awayCount.set(g.away, (awayCount.get(g.away) ?? 0) + 1);
  }
  const seedOf = new Map(teams.map((t, i) => [t, i + 1]));

  let order; // ranking this round
  if (ctx.manual?.length || (round === 1 && c.first_round === 'manual')) return manualRound(teams, { ...ctx, round }, c, algorithm, inputs);
  if (round === 1) {
    order = c.first_round === 'random' ? shuffled(teams, rngFor(`${ctx.drawSeed ?? 'swiss'}:r1`)) : teams.slice();
    if (c.first_round === 'random' && !ctx.drawSeed) warnings.push('Random first round without a persisted draw seed cannot be reproduced');
  } else order = swissStandings(teams, games, { pointsWin: ctx.pointsWin ?? 3, pointsDraw: ctx.pointsDraw ?? 1, pointsLoss: ctx.pointsLoss ?? 0, byePoints: c.bye_points, tieBreaks: c.tie_breaks }).map((r) => r.team);
  const pointsOf = new Map(round === 1 ? teams.map((t) => [t, 0]) : swissStandings(teams, games, { pointsWin: ctx.pointsWin ?? 3, pointsDraw: ctx.pointsDraw ?? 1, pointsLoss: ctx.pointsLoss ?? 0, byePoints: c.bye_points, tieBreaks: c.tie_breaks }).map((r) => [r.team, r.points]));

  // bye: lowest-ranked player without a previous bye (everyone had one: lowest-ranked overall)
  let bye = null, pool = order.slice();
  const explain = new Map();
  if (pool.length % 2) {
    const cand = [...pool].reverse().find((t) => !hadBye.has(t)) ?? pool[pool.length - 1];
    bye = cand; pool = pool.filter((t) => t !== cand);
    explain.set(cand, hadBye.has(cand) ? 'Bye (everyone has had one: lowest ranked)' : 'Bye: lowest ranked without an earlier bye');
  }

  const half = (grp) => (c.policy === 'score_group_dutch' ? Math.ceil(grp.length / 2) : null);
  /** Preference order of partners for `p` among the still unpaired players (same score group first, then nearest group). */
  function partners(p, left) {
    const mine = pointsOf.get(p);
    const same = left.filter((q) => pointsOf.get(q) === mine);
    const others = left.filter((q) => pointsOf.get(q) !== mine).sort((x, y) => Math.abs(pointsOf.get(x) - mine) - Math.abs(pointsOf.get(y) - mine) || order.indexOf(x) - order.indexOf(y));
    let list;
    if (c.policy === 'score_group_dutch') {
      const full = [p, ...same].sort((x, y) => order.indexOf(x) - order.indexOf(y));
      // an odd score group floats its lowest-ranked player down, so split the even remainder
      const floater = full.length % 2 && full.length > 1 ? full[full.length - 1] : null;
      const grp = floater ? full.slice(0, -1) : full;
      const h = half(grp);
      // p is the top of the remaining group: its natural partner is the player at the same offset in the bottom half
      const ideal = grp[h] ? [grp[h], ...grp.slice(h + 1), ...grp.slice(1, h).reverse()] : grp.slice(1);
      list = [...ideal, ...(floater ? [floater] : [])];
    } else list = same.sort((x, y) => order.indexOf(x) - order.indexOf(y));
    return [...list, ...others];
  }
  const rematch = (a, b) => played.has(pairKey(a, b));

  function solve(allowRematch) {
    let budget = 200000;
    const pairs = [];
    const go = (left) => {
      if (!left.length) return true;
      if (--budget < 0) return false;
      const [p, ...rest] = left;
      for (const q of partners(p, rest)) {
        if (!allowRematch && rematch(p, q)) continue;
        pairs.push([p, q]);
        if (go(rest.filter((x) => x !== q))) return true;
        pairs.pop();
      }
      return false;
    };
    return go(pool) ? pairs.slice() : null;
  }
  let pairs = solve(false);
  if (!pairs) {
    if (!c.allow_rematch) throw Object.assign(new Error('No pairing without a rematch exists for this round; allow rematches in the format or pair this round by hand'), { code: 'swiss_no_pairing' });
    pairs = solve(true);
    if (!pairs) throw Object.assign(new Error('The pairing search could not complete; pair this round by hand'), { code: 'swiss_no_pairing' });
    warnings.push('A rematch was unavoidable this round');
  }

  const out = pairs.map(([a, b], i) => {
    const [home, away] = c.balance_home_away ? orient(a, b, homeCount, awayCount, seedOf) : [a, b];
    const same = pointsOf.get(a) === pointsOf.get(b);
    if (rematch(a, b)) warnings.push(`Rematch: ${a} v ${b}`);
    return { board: i + 1, home, away, points: [pointsOf.get(a), pointsOf.get(b)], reason: round === 1 ? (c.first_round === 'random' ? 'Random first-round draw (seeded RNG)' : `Seed ${seedOf.get(a)} v seed ${seedOf.get(b)} (top half v bottom half)`) : same ? `Same score group (${pointsOf.get(a)} pts)` : `Floated: ${pointsOf.get(a)} pts v ${pointsOf.get(b)} pts` };
  });
  return { round, pairings: out, bye: bye ? { team: bye, reason: explain.get(bye) } : null, warnings, algorithm, inputs };
}

function manualRound(teams, ctx, c, algorithm, inputs) {
  const m = ctx.manual;
  if (!m?.length) throw Object.assign(new Error('The first round is set to manual: send the pairings'), { code: 'swiss_manual_required' });
  const seen = new Set();
  for (const p of m) for (const t of [p.home, p.away]) { if (!teams.includes(t)) throw new Error('A manual pairing names a team that is not in the field'); if (seen.has(t)) throw new Error('A team appears twice in the manual pairings'); seen.add(t); }
  const left = teams.filter((t) => !seen.has(t));
  if (left.length > 1) throw new Error('Every team must be paired (one may take the bye)');
  return { round: ctx.round, pairings: m.map((p, i) => ({ board: i + 1, home: p.home, away: p.away, points: [0, 0], reason: 'Organiser pairing (recorded as a manual draw)' })), bye: left[0] ? { team: left[0], reason: 'Bye (organiser draw)' } : null, warnings: [], algorithm, inputs };
}

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
/** The player who has had fewer home games is home; level: the better seed alternates by the count. */
function orient(a, b, home, away, seedOf) {
  const bal = (t) => (home.get(t) ?? 0) - (away.get(t) ?? 0);
  if (bal(a) !== bal(b)) return bal(a) < bal(b) ? [a, b] : [b, a];
  return seedOf.get(a) < seedOf.get(b) ? [a, b] : [b, a];
}

/** True once the pairing cannot be repeated by a stage that already has fixtures in a round. */
export const roundsComplete = (games, round) => games.filter((g) => g.round === round && g.away).every((g) => g.home_score != null && g.away_score != null);
