// Double elimination: a winners bracket, a losers bracket fed by every winners-bracket loss, and a grand final. A team is out after its
// second loss. Byes (a field that is not a power of two) are removed by the shared graph resolver, so a team that would have met a bye
// simply walks through. An optional "reset" game is only created when the competition policy says so, and is only played when the
// losers-bracket champion wins the first grand final.
import { resolveGraph, WIN, LOSE, TEAM } from './graph.js';
import { seedOrder } from '../bracket.js';

export const MAX_DOUBLE_TEAMS = 64;
const nextPow2 = (n) => { let s = 2; while (s < n) s *= 2; return s; };

/**
 * @param {string[]} teams best seed first
 * @param {{reset?: boolean}} opts reset: create the conditional second grand final
 */
export function buildDoubleElimination(teams, { reset = false } = {}) {
  const n = teams.length;
  if (n < 3) throw new Error('A double-elimination bracket needs at least 3 teams (use a knockout for 2)');
  if (n > MAX_DOUBLE_TEAMS) throw new Error(`A double-elimination bracket supports at most ${MAX_DOUBLE_TEAMS} teams`);
  const size = nextPow2(n), k = Math.log2(size), order = seedOrder(size);
  const at = (seed) => TEAM(seed <= n ? teams[seed - 1] : null);
  const nodes = [];
  const wb = (r, s) => `W${r}:${s}`, lb = (r, s) => `L${r}:${s}`;

  // winners bracket
  for (let r = 1; r <= k; r++) {
    const count = size / 2 ** r;
    for (let s = 0; s < count; s++) {
      const inputs = r === 1 ? [at(order[2 * s]), at(order[2 * s + 1])] : [WIN(wb(r - 1, 2 * s)), WIN(wb(r - 1, 2 * s + 1))];
      nodes.push({ key: wb(r, s), label: r === k ? 'Winners final' : `Winners R${r}${count > 1 ? ` ${s + 1}` : ''}`, round_kind: 'winners', bracket_side: 'winners', round_no: r, slot: s, inputs });
    }
  }
  // losers bracket: round 1 pairs winners-round-1 losers; even rounds add that winners round's losers (order reversed on alternate drops to
  // avoid immediate rematches); odd rounds (>1) pair the previous losers-round winners.
  const lbRounds = 2 * (k - 1);
  let prevCount = 0;
  for (let r = 1; r <= lbRounds; r++) {
    let count, make;
    if (r === 1) { count = size / 4; make = (s) => [LOSE(wb(1, 2 * s)), LOSE(wb(1, 2 * s + 1))]; }
    else if (r % 2 === 0) {
      const j = r / 2, drops = size / 2 ** (j + 1); // winners round j+1 has `drops` matches
      count = prevCount;
      const rev = j % 2 === 1;
      make = (s) => [WIN(lb(r - 1, s)), LOSE(wb(j + 1, rev ? drops - 1 - s : s))];
    } else { count = prevCount / 2; make = (s) => [WIN(lb(r - 1, 2 * s)), WIN(lb(r - 1, 2 * s + 1))]; }
    for (let s = 0; s < count; s++) {
      nodes.push({ key: lb(r, s), label: r === lbRounds ? 'Losers final' : `Losers R${r}${count > 1 ? ` ${s + 1}` : ''}`, round_kind: 'losers', bracket_side: 'losers', round_no: r, slot: s, inputs: make(s) });
    }
    prevCount = count;
  }
  nodes.push({ key: 'GF:0', label: 'Grand final', round_kind: 'grand_final', bracket_side: 'grand_final', round_no: 1, slot: 0, inputs: [WIN(wb(k, 0)), WIN(lb(lbRounds, 0))] });
  if (reset) nodes.push({ key: 'GF:1', label: 'Grand final reset', round_kind: 'grand_final', bracket_side: 'grand_final', round_no: 2, slot: 1, inputs: [WIN('GF:0'), LOSE('GF:0')], conditional: { kind: 'reset', played_when: 'losers_champion_wins' } });

  const { fixtures, byes } = resolveGraph(nodes);
  // The reset game (if any) takes both grand finalists: the first final's winner as home, its loser as away.
  return { size, fixtures, byes, reset, rounds: { winners: k, losers: lbRounds } };
}

/** Elimination-order placements once a double-elimination stage is complete: champion, runner-up, then losers-bracket losers from the last round back. */
export function doubleElimPlacements(fixtures) {
  const done = (f) => f.status === 'completed' && f.winner_team_id;
  const loser = (f) => (f.winner_team_id === f.home_team_id ? f.away_team_id : f.home_team_id);
  const gf = fixtures.filter((f) => f.round_kind === 'grand_final').sort((a, b) => a.round_no - b.round_no);
  const decisive = gf.filter(done).slice(-1)[0];
  if (!decisive) return [];
  const out = [{ place: 1, team_id: decisive.winner_team_id }, { place: 2, team_id: loser(decisive) }];
  const lbs = fixtures.filter((f) => f.round_kind === 'losers' && done(f)).sort((a, b) => b.round_no - a.round_no || a.slot - b.slot);
  let place = 3, lastRound = null, group = [];
  const flush = () => { group.forEach((t) => out.push({ place, team_id: t, shared: group.length > 1 })); place += group.length; group = []; };
  for (const f of lbs) { if (lastRound != null && f.round_no !== lastRound) flush(); lastRound = f.round_no; group.push(loser(f)); }
  if (group.length) flush();
  return out;
}
