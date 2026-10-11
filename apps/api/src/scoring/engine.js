// Pure scoring engine: turns an ordered list of match events into a score. No database, no clock.
// side is 'home' | 'away'. Voided events must be filtered out by the caller.

const other = (s) => (s === 'home' ? 'away' : 'home');
const SIDES = ['home', 'away'];
export const CONTROL_KINDS = ['period_start', 'period_end', 'note'];

function runPoints(rs, events) {
  const worth = Object.fromEntries(rs.events.map((e) => [e.kind, e.points]));
  const total = { home: 0, away: 0 };
  const periods = new Map();
  const stats = { home: {}, away: {} };
  for (const e of events) {
    if (!SIDES.includes(e.side)) continue;
    stats[e.side][e.kind] = (stats[e.side][e.kind] ?? 0) + 1;
    if (e.kind in worth) {
      total[e.side] += worth[e.kind];
      const p = periods.get(e.period ?? 1) ?? { period: e.period ?? 1, home: 0, away: 0 };
      p[e.side] += worth[e.kind];
      periods.set(e.period ?? 1, p);
    }
  }
  return { home: total.home, away: total.away, periods: [...periods.values()].sort((a, b) => a.period - b.period), stats };
}

function runSets(rs, events) {
  const { best_of, points_to_win, win_by, cap, deciding_points } = rs.sets;
  const need = Math.ceil(best_of / 2);
  const sets = [];
  const stats = { home: {}, away: {} };
  let cur = { home: 0, away: 0 };
  const won = { home: 0, away: 0 };
  let over = false;
  for (const e of events) {
    if (!SIDES.includes(e.side)) continue;
    stats[e.side][e.kind] = (stats[e.side][e.kind] ?? 0) + 1;
    if (e.kind !== 'point' || over) continue;
    cur[e.side]++;
    const decider = best_of > 1 && won.home === need - 1 && won.away === need - 1;
    const target = decider && deciding_points ? deciding_points : points_to_win;
    const lead = Math.abs(cur.home - cur.away), top = Math.max(cur.home, cur.away);
    if ((top >= target && lead >= win_by) || (cap && top >= cap)) {
      const w = cur.home > cur.away ? 'home' : 'away';
      sets.push({ ...cur, winner: w });
      won[w]++;
      cur = { home: 0, away: 0 };
      if (won[w] >= need) over = true;
    }
  }
  return { home: won.home, away: won.away, sets, current_set: over ? null : cur, over, stats };
}

/** @returns {{home:number, away:number, winner:'home'|'away'|null, level:boolean, over:boolean, periods?:any[], sets?:any[], current_set?:any, stats:any}} */
export function computeScore(rs, events) {
  const live = events.filter((e) => !e.voided_at);
  if (rs.kind === 'manual') return { home: 0, away: 0, winner: null, level: true, over: false, stats: { home: {}, away: {} } };
  const r = rs.kind === 'sets' ? runSets(rs, live) : runPoints(rs, live);
  const winner = r.home === r.away ? null : r.home > r.away ? 'home' : 'away';
  return { ...r, winner: rs.kind === 'sets' && !r.over ? null : winner, level: r.home === r.away, over: rs.kind === 'sets' ? r.over : false };
}

/** Where the match is: current period, whether it is running, and whether more points may still be logged. */
export function matchPhase(rs, events) {
  const live = events.filter((e) => !e.voided_at);
  let period = 0, open = false;
  for (const e of live) {
    if (e.kind === 'period_start') { period = e.period ?? period + 1; open = true; }
    else if (e.kind === 'period_end') open = false;
  }
  const score = computeScore(rs, live);
  return { period, period_open: open, periods_total: rs.periods.count, can_score: !(rs.kind === 'sets' && score.over), score };
}

/** Why an event cannot be logged right now, or null. */
export function rejectReason(rs, events, next) {
  if (CONTROL_KINDS.includes(next.kind)) return null;
  const known = new Set([...rs.events.map((e) => e.kind), ...rs.stats.map((s) => s.kind), ...(rs.kind === 'sets' ? ['point'] : [])]);
  if (!known.has(next.kind)) return `"${next.kind}" is not part of the ${rs.label} rules`;
  if (!SIDES.includes(next.side)) return 'side must be home or away';
  if (rs.kind === 'manual') return 'This sport is scored by entering the totals on the score sheet';
  if (rs.kind === 'sets' && computeScore(rs, events).over) return 'The match is already decided';
  return null;
}
export { other as otherSide };
