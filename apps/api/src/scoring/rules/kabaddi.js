// Kabaddi mat state derived from the event stream: players on the mat per side, revivals, empty-raid streaks (do-or-die) and the all-out.
// Every flag is advisory: it tells the scorer what the rules say should happen next, it never refuses a tap, because real matches contain
// scorer error and the official result is still entered on the score sheet.
import { SIDES, otherSide } from '../basic.js';

const REVIVE_ON = new Set(['raid_point', 'tackle_point', 'bonus_point']);

export function kabaddiState(rs, live) {
  const K = rs.kabaddi;
  if (!K) return null;
  const out = { home: 0, away: 0 };
  const empty = { home: 0, away: 0 };
  const sub = (o, side, n) => { o[side] = Math.max(0, o[side] - n); };
  for (const e of live) {
    if (!SIDES.includes(e.side)) continue;
    const opp = otherSide(e.side);
    if (e.kind === 'empty_raid') { empty[e.side]++; continue; }
    if (e.kind === 'raid_point') { out[opp] = Math.min(K.players, out[opp] + 1); empty[e.side] = 0; }
    if (e.kind === 'tackle_point') { out[opp] = Math.min(K.players, out[opp] + 1); empty[opp] = 0; }
    if (e.kind === 'bonus_point') empty[e.side] = 0;
    if (REVIVE_ON.has(e.kind)) sub(out, e.side, 1);
    if (e.kind === 'all_out') { out[opp] = 0; sub(out, e.side, 2); }
  }
  const on = { home: K.players - out.home, away: K.players - out.away };
  return {
    on_mat: on,
    empty_raids: empty,
    do_or_die: { home: empty.home >= K.do_or_die_after, away: empty.away >= K.do_or_die_after },
    super_tackle: { home: on.home <= K.super_tackle_at && on.home > 0, away: on.away <= K.super_tackle_at && on.away > 0 },
    // the side that should be credited with an all-out because the other has no player left on the mat
    all_out_for: on.home === 0 ? 'away' : on.away === 0 ? 'home' : null,
  };
}
