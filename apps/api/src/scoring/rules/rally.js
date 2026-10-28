// Rally-sport rules derived from the event stream: timeouts and substitutions left, technical timeouts, intervals, change of ends, the serving
// rotation (volleyball) and the service court (badminton). Everything works on the current set only. Prompts are advisory ("due") and clear
// when the scorer logs the matching stat (`technical_timeout`, `interval`, `change_ends`); only a timeout or substitution over the limit is refused.
import { SIDES, otherSide } from '../basic.js';

const count = (events, kind, side) => events.filter((e) => e.kind === kind && (!side || e.side === side)).length;

/** The part of the stream that belongs to the set now being played (runSets reports where it began). */
export function rallyContext(rs, live, sets) {
  const from = sets.current_from ?? 0;
  const win = live.slice(from);
  const cur = sets.current_set ?? { home: 0, away: 0 };
  const need = Math.ceil(rs.sets.best_of / 2);
  const decider = rs.sets.best_of > 1 && sets.home === need - 1 && sets.away === need - 1;
  return { win, cur, decider };
}

export function rallyState(rs, live, sets, server) {
  const R = rs.rally;
  if (!R) return null;
  const { win, cur, decider } = rallyContext(rs, live, sets);
  const top = Math.max(cur.home, cur.away), total = cur.home + cur.away;
  const out = {
    timeouts_left: R.timeouts_per_set == null ? null : { home: Math.max(0, R.timeouts_per_set - count(win, 'timeout', 'home')), away: Math.max(0, R.timeouts_per_set - count(win, 'timeout', 'away')) },
    subs_left: R.subs_per_set == null ? null : { home: Math.max(0, R.subs_per_set - count(win, 'substitution', 'home')), away: Math.max(0, R.subs_per_set - count(win, 'substitution', 'away')) },
    decider,
  };
  const prompts = [];
  if (!decider && R.technical_at.length) {
    const due = R.technical_at.filter((t) => top >= t).length;
    if (due > count(win, 'technical_timeout')) prompts.push('technical_timeout');
  }
  if (R.interval_at && top >= R.interval_at && !count(win, 'interval')) prompts.push('interval');
  const cc = R.court_change;
  const switches = decider ? (cc.decider_at_leader ? (top >= cc.decider_at_leader ? 1 : 0) : cc.decider_every ? Math.floor(total / cc.decider_every) : 0) : cc.every ? Math.floor(total / cc.every) : 0;
  if (switches > count(win, 'change_ends')) prompts.push('change_ends');
  out.prompts = prompts;
  if (R.service_court && server) {
    const mine = cur[server];
    out.service_court = mine % 2 === 0 ? 'right' : 'left';
    out.server_score = mine;
  }
  if (R.rotation) out.rotation = rotationOf(win);
  return out;
}

/** Serving rotation (1 to 6) per side: it advances each time a side wins the rally from the side that was serving. */
function rotationOf(win) {
  const rot = { home: 1, away: 1 };
  let serving = win.find((e) => e.kind === 'server' && SIDES.includes(e.side))?.side ?? null;
  for (const e of win) {
    if (e.kind !== 'point' || !SIDES.includes(e.side)) continue;
    if (serving && e.side !== serving) rot[e.side] = (rot[e.side] % 6) + 1;
    serving = e.side;
  }
  return { ...rot, serving };
}

export function rallyReject(rs, live, next, sets) {
  const R = rs.rally;
  if (!R || !SIDES.includes(next.side)) return null;
  const st = rallyState(rs, live, sets, null);
  if (next.kind === 'timeout' && st.timeouts_left && st.timeouts_left[next.side] === 0) return `${next.side === 'home' ? 'Home' : 'Away'} has no timeouts left in this set`;
  if (next.kind === 'substitution' && st.subs_left && st.subs_left[next.side] === 0) return `${next.side === 'home' ? 'Home' : 'Away'} has used all substitutions for this set`;
  return null;
}
export { otherSide };
