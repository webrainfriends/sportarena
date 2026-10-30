// Best-of-N series and multi-leg (aggregate) ties. Each game / leg is an ordinary fixture; these functions only decide what the games add up to.
// Nothing here assumes a convention: away goals count only when the pinned config says `away_goals: true`.

export const SERIES_LENGTHS = [3, 5, 7, 9];
export const HOME_ROTATIONS = ['alternate', 'two_two_one_one_one', 'fixed_a', 'fixed_b'];
export const LEG_DECIDERS = ['extra_time_then_penalties', 'penalties', 'golden_point', 'replay', 'manual'];

export const winsNeeded = (bestOf) => Math.floor(bestOf / 2) + 1;

/** Which games side A hosts: array of booleans, one per game. a is the higher seed / first-named side. */
export function homeRotation(policy, bestOf) {
  if (policy === 'fixed_a') return Array(bestOf).fill(true);
  if (policy === 'fixed_b') return Array(bestOf).fill(false);
  if (policy === 'two_two_one_one_one') {
    const pattern = { 3: [1, 0, 1], 5: [1, 1, 0, 0, 1], 7: [1, 1, 0, 0, 1, 0, 1], 9: [1, 1, 0, 0, 1, 0, 1, 0, 1] }[bestOf];
    if (!pattern) throw new Error(`No 2-2-1-1-1 pattern for best of ${bestOf}`);
    return pattern.map(Boolean);
  }
  return Array.from({ length: bestOf }, (_, i) => i % 2 === 0);
}

/**
 * @param {number} bestOf
 * @param {{winner:'a'|'b'|null, status?:string}[]} games in play order
 * @returns {{a:number,b:number,needed:number,decided:boolean,winner:'a'|'b'|null,played:number,not_required:number[],status:'pending'|'in_progress'|'decided'}}
 */
export function seriesState(bestOf, games) {
  const needed = winsNeeded(bestOf);
  let a = 0, b = 0, decidedAt = -1, played = 0;
  games.forEach((g, i) => {
    if (decidedAt >= 0 || g.status === 'cancelled' || !g.winner) return;
    played++;
    if (g.winner === 'a') a++; else b++;
    if (a >= needed || b >= needed) decidedAt = i;
  });
  const decided = decidedAt >= 0;
  return {
    a, b, needed, decided, winner: decided ? (a > b ? 'a' : 'b') : null, played,
    // games after the deciding one are not required (kept as history, never deleted)
    not_required: decided ? games.map((_, i) => i).filter((i) => i > decidedAt && !games[i].winner) : [],
    status: decided ? 'decided' : played ? 'in_progress' : 'pending',
  };
}

/**
 * Aggregate over N legs.
 * @param {{a_score:number|null,b_score:number|null,a_home:boolean,done:boolean,winner?:'a'|'b'|null}[]} legs
 * @param {{away_goals?:boolean, legs:number}} cfg
 */
export function aggregateState(legs, cfg) {
  const total = cfg.legs ?? legs.length;
  const done = legs.filter((l) => l.done && l.a_score != null && l.b_score != null);
  const a = done.reduce((s, l) => s + l.a_score, 0), b = done.reduce((s, l) => s + l.b_score, 0);
  const complete = done.length >= total;
  const out = { a, b, legs_played: done.length, legs: total, complete, decided: false, winner: null, method: null, needs_decider: false };
  if (!complete) return out;
  if (a !== b) return { ...out, decided: true, winner: a > b ? 'a' : 'b', method: 'aggregate' };
  if (cfg.away_goals === true) {
    const aa = done.reduce((s, l) => s + (l.a_home ? 0 : l.a_score), 0), ba = done.reduce((s, l) => s + (l.a_home ? l.b_score : 0), 0);
    if (aa !== ba) return { ...out, decided: true, winner: aa > ba ? 'a' : 'b', method: 'away_goals' };
  }
  const last = legs[legs.length - 1];
  if (last?.winner && last.a_score === last.b_score) return { ...out, decided: true, winner: last.winner, method: 'decider' }; // the final leg ended level (extra time / penalties) and has an explicit winner
  return { ...out, needs_decider: true };
}
