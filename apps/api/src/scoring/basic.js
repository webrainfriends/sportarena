// The two general-purpose scoring models: score that adds up from scoring events (football, basketball, rugby …) and rally points that make
// sets that make a match (badminton, volleyball, table tennis …). Pure functions, no database and no clock. Voided events are removed
// by the caller. Team-game extras (extra time, penalty shoot-out, sent-off players) are derived here too, from the same event log.

export const SIDES = ['home', 'away'];
export const otherSide = (s) => (s === 'home' ? 'away' : 'home');
export const SHOOTOUT_KINDS = ['shootout_goal', 'shootout_miss'];
const CARD_YELLOW = 'yellow_card', CARD_RED = 'red_card';

/** Penalty shoot-out from alternating kicks: first to be out of reach wins inside `rounds` each, then sudden death. */
export function shootoutState(rounds, events) {
  const kicks = events.filter((e) => SHOOTOUT_KINDS.includes(e.kind) && SIDES.includes(e.side));
  const goals = { home: 0, away: 0 }, taken = { home: 0, away: 0 };
  let winner = null;
  const seq = [];
  for (const k of kicks) {
    if (winner) break;
    taken[k.side]++; seq.push({ side: k.side, scored: k.kind === 'shootout_goal', player_id: k.player_id ?? null });
    if (k.kind === 'shootout_goal') goals[k.side]++;
    if (taken.home >= rounds && taken.away >= rounds) {
      // all the regulation kicks are done: sudden death, decided only once both sides have kicked the same number
      if (taken.home === taken.away && goals.home !== goals.away) winner = goals.home > goals.away ? 'home' : 'away';
    } else {
      // inside the regulation kicks a side wins as soon as the other cannot catch up
      const left = { home: Math.max(0, rounds - taken.home), away: Math.max(0, rounds - taken.away) };
      if (goals.home > goals.away + left.away) winner = 'home';
      else if (goals.away > goals.home + left.home) winner = 'away';
    }
  }
  const last = seq[seq.length - 1]?.side ?? null;
  // kicks alternate; the side that kicked first kicks first again
  const first = seq[0]?.side ?? null;
  const next = winner ? null : first == null ? null : taken.home === taken.away ? first : otherSide(first);
  return { rounds, goals, taken, sequence: seq, winner, over: !!winner, next, last_kick: last, started: kicks.length > 0 };
}

function playersSentOff(events) {
  const yellow = new Map(), out = [];
  const sent = new Set();
  for (const e of events) {
    if (!e.player_id || !SIDES.includes(e.side)) continue;
    if (e.kind === CARD_RED && !sent.has(e.player_id)) { sent.add(e.player_id); out.push({ player_id: e.player_id, side: e.side, reason: 'red_card' }); }
    if (e.kind === CARD_YELLOW) {
      const n = (yellow.get(e.player_id) ?? 0) + 1; yellow.set(e.player_id, n);
      if (n >= 2 && !sent.has(e.player_id)) { sent.add(e.player_id); out.push({ player_id: e.player_id, side: e.side, reason: 'second_yellow' }); }
    }
  }
  return out;
}

export function runPoints(rs, events) {
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
  const out = { home: total.home, away: total.away, periods: [...periods.values()].sort((a, b) => a.period - b.period), stats };
  if (rs.shootout) out.shootout = shootoutState(rs.shootout.rounds, events);
  const off = playersSentOff(events);
  if (off.length) out.sent_off = off;
  return out;
}

export function runSets(rs, events) {
  const { best_of, points_to_win, win_by, cap, deciding_points } = rs.sets;
  const need = Math.ceil(best_of / 2);
  const sets = [];
  const stats = { home: {}, away: {} };
  let cur = { home: 0, away: 0 };
  const won = { home: 0, away: 0 };
  let over = false, currentFrom = 0;
  for (const [i, e] of events.entries()) {
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
      currentFrom = i + 1;
      if (won[w] >= need) over = true;
    }
  }
  return { home: won.home, away: won.away, sets, current_set: over ? null : cur, over, stats, current_from: currentFrom };
}
