// Sport scoring plugin contract. A plugin separates what differs between sports so none is forced into home/away totals:
//   kind          the ruleset kind it serves
//   validate      (rs, live, next, ctx) -> reason | null          which events are legal now (rules + event types)
//   state         (rs, live) -> score state                       pure, from the ordered, non-voided event stream
//   phase         (rs, live, state) -> {period, period_open, ...} clock / period / set / innings position
//   attribution   (rs, live, ctx) -> per-participant contributions (null where the sport records none)
//   liveStats     (rs, live, state) -> stat projection            only what was actually captured; missing stays absent
//   publicView    (state) -> spectator-safe projection
//   toResult      (state) -> {home, away, winner, totals}         what an official sheet starts from; never published by itself
// The server is authoritative: clients send events, never totals. Official results still go through the score-sheet workflow.
import { cricketReject, cricketState } from '../cricket.js';
import { runPoints, runSets, SIDES, SHOOTOUT_KINDS, otherSide } from '../basic.js';
import { isGames, runRacket, racketReject, rallyServer, RACKET_KINDS } from '../racket.js';
import { sessionState, sessionReject, SESSION_KINDS } from '../session.js';

export const CONTROL_KINDS = ['period_start', 'period_end', 'note'];
const winnerOf = (h, a) => (h === a ? null : h > a ? 'home' : 'away');

/** Period / clock position shared by period-based sports (football, basketball, rugby …), including extra time and the shoot-out. */
function periodPhase(rs, live, score) {
  let period = 0, open = false;
  for (const e of live) {
    if (e.kind === 'period_start') { period = e.period ?? period + 1; open = true; }
    else if (e.kind === 'period_end') open = false;
  }
  const regulation = rs.periods.count;
  const level = score.home === score.away;
  const extra = rs.extra_time ?? null;
  const out = { period, period_open: open, periods_total: regulation, stage: period > regulation ? 'extra_time' : period > 0 ? 'regulation' : 'not_started' };
  if (extra) {
    out.extra_periods = extra.periods; out.extra_minutes = extra.minutes;
    out.extra_time_available = !open && period >= regulation && period < regulation + extra.periods && level;
  }
  if (rs.shootout) {
    const so = score.shootout;
    const lastPeriod = regulation + (extra ? extra.periods : 0);
    out.shootout_available = !open && period >= lastPeriod && level && !so?.over;
    if (so?.started) out.stage = 'shootout';
  }
  return out;
}

// ------------------------------------------------------------------ points_events (football, futsal, basketball, rugby, kabaddi …)
const pointsPlugin = {
  kind: 'points_events',
  state(rs, live) {
    const r = runPoints(rs, live);
    return { ...r, winner: winnerOf(r.home, r.away), level: r.home === r.away, over: false };
  },
  validate(rs, live, next, ctx = {}) {
    if (CONTROL_KINDS.includes(next.kind)) {
      if (next.kind === 'period_start') {
        const p = next.period;
        const st = pointsPlugin.state(rs, live);
        const ph = periodPhase(rs, live, st);
        const target = p ?? ph.period + 1;
        if ((rs.extra_time || rs.shootout) && target > rs.periods.count) {
          if (!rs.extra_time) return 'This game has no extra time';
          if (ctx.knockout === false) return 'Extra time only applies to knockout games';
          if (target > rs.periods.count + rs.extra_time.periods) return 'All extra-time periods have been played';
          if (ph.period_open) return `${rs.periods.label} ${ph.period} is still running`;
          if (!st.level) return 'Extra time is only played when the score is level';
        }
      }
      return null;
    }
    if (SHOOTOUT_KINDS.includes(next.kind)) {
      if (!rs.shootout) return 'This game has no penalty shoot-out';
      if (ctx.knockout === false) return 'A penalty shoot-out only applies to knockout games';
      if (!SIDES.includes(next.side)) return 'side must be home or away';
      const st = pointsPlugin.state(rs, live), ph = periodPhase(rs, live, st);
      if (!ph.shootout_available && !st.shootout?.started) return 'A shoot-out starts only when the score is level after the last period';
      if (st.shootout?.over) return 'The shoot-out is already decided';
      if (st.shootout?.next && next.side !== st.shootout.next) return `It is ${st.shootout.next === 'home' ? 'Home' : 'Away'}'s kick`;
      return null;
    }
    const known = new Set([...rs.events.map((e) => e.kind), ...rs.stats.map((s) => s.kind)]);
    if (!known.has(next.kind)) return `"${next.kind}" is not part of the ${rs.label} rules`;
    if (!SIDES.includes(next.side)) return 'side must be home or away';
    const so = pointsPlugin.state(rs, live).shootout;
    if (so?.started && rs.events.some((e) => e.kind === next.kind)) return 'The shoot-out has started; the score no longer changes';
    if (next.player_id && pointsPlugin.state(rs, live).sent_off?.some((p) => p.player_id === next.player_id)) return 'That player has been sent off';
    return null;
  },
  phase: periodPhase,
  attribution(rs, live) {
    const worth = Object.fromEntries(rs.events.map((e) => [e.kind, e.points]));
    const by = new Map();
    const row = (id, side) => { if (!by.has(id)) by.set(id, { player_id: id, side, points: 0, events: {} }); return by.get(id); };
    for (const e of live) {
      if (e.player_id && SIDES.includes(e.side) && !SHOOTOUT_KINDS.includes(e.kind) && !CONTROL_KINDS.includes(e.kind)) {
        const r = row(e.player_id, e.side); r.events[e.kind] = (r.events[e.kind] ?? 0) + 1; if (e.kind in worth) r.points += worth[e.kind];
      }
      const a = e.payload?.assist_player_id;
      if (a && e.kind in worth && SIDES.includes(e.side)) { const r = row(a, e.side); r.events.assist = (r.events.assist ?? 0) + 1; }
    }
    return [...by.values()];
  },
  liveStats: (rs, live, state) => state.stats,
  publicView: (state) => ({ home: state.home, away: state.away, periods: state.periods, shootout: state.shootout ?? null, sent_off: state.sent_off ?? [] }),
  toResult(state) {
    const so = state.shootout?.over ? state.shootout : null;
    const winner = state.winner ?? so?.winner ?? null;
    return { home: state.home, away: state.away, winner, totals: { periods: state.periods, ...(so ? { shootout: { home: so.goals.home, away: so.goals.away } } : {}) } };
  },
};

// ------------------------------------------------------------------ sets: rally points (badminton, volleyball, table tennis …)
const setsPlugin = {
  kind: 'sets',
  state(rs, live) {
    const r = runSets(rs, live);
    const winner = r.over ? winnerOf(r.home, r.away) : null;
    const server = rallyServer(rs, live);
    return { ...r, winner, level: r.home === r.away, ...(server ? { server } : {}) };
  },
  validate(rs, live, next) {
    if (CONTROL_KINDS.includes(next.kind)) return null;
    const known = new Set([...rs.events.map((e) => e.kind), ...rs.stats.map((s) => s.kind), 'point', ...(rs.racket?.serve && rs.racket.serve !== 'none' ? ['server'] : [])]);
    if (!known.has(next.kind)) return `"${next.kind}" is not part of the ${rs.label} rules`;
    if (!SIDES.includes(next.side)) return 'side must be home or away';
    if (setsPlugin.state(rs, live).over) return 'The match is already decided';
    if (next.kind === 'server' && live.some((e) => e.kind === 'point')) return 'The first server is set before the first point';
    return null;
  },
  phase: (rs, live, state) => {
    let period = 0, open = false;
    for (const e of live) { if (e.kind === 'period_start') { period = e.period ?? period + 1; open = true; } else if (e.kind === 'period_end') open = false; }
    return { period, period_open: open, periods_total: rs.periods.count, set: state.sets.length + 1 };
  },
  attribution: (rs, live) => pointsAttribution(live),
  liveStats: (rs, live, state) => state.stats,
  publicView: (state) => ({ home: state.home, away: state.away, sets: state.sets, current_set: state.current_set, over: state.over, server: state.server ?? null }),
  toResult: (state) => ({ home: state.home, away: state.away, winner: state.winner, totals: { sets: state.sets } }),
};

// ------------------------------------------------------------------ racket games (tennis, padel)
const racketPlugin = {
  kind: 'racket',
  state(rs, live) { const r = runRacket(rs, live); return { ...r, level: r.home === r.away }; },
  validate(rs, live, next) {
    if (CONTROL_KINDS.includes(next.kind)) return null;
    const known = new Set([...rs.stats.map((s) => s.kind), ...RACKET_KINDS]);
    if (!known.has(next.kind)) return `"${next.kind}" is not part of the ${rs.label} rules`;
    if (!SIDES.includes(next.side)) return 'side must be home or away';
    const st = racketPlugin.state(rs, live);
    if (st.over) return 'The match is already decided';
    return racketReject(rs, live, next, st);
  },
  phase: (rs, live, state) => ({ period: 0, period_open: false, periods_total: rs.periods.count, set: state.sets.length + 1, game: state.current_game }),
  attribution: (rs, live) => pointsAttribution(live),
  liveStats: (rs, live, state) => state.stats,
  publicView: (state) => ({ home: state.home, away: state.away, sets: state.sets, current_set: state.current_set, current_game: state.current_game, server: state.server, over: state.over, outcome: state.outcome }),
  toResult: (state) => ({ home: state.home, away: state.away, winner: state.winner, totals: { sets: state.sets, outcome: state.outcome } }),
};

// ------------------------------------------------------------------ cricket
const cricketPlugin = {
  kind: 'cricket',
  state(rs, live) {
    const cs = cricketState(rs, live);
    return {
      home: cs.home, away: cs.away, winner: cs.winner, level: cs.home === cs.away, over: cs.over,
      periods: cs.innings.map((i) => ({ period: i.n, home: i.side === 'home' ? i.runs : 0, away: i.side === 'away' ? i.runs : 0 })),
      stats: { home: { wickets: cs.wickets.home }, away: { wickets: cs.wickets.away } }, cricket: cs,
    };
  },
  validate: (rs, live, next) => cricketReject(rs, live, next),
  phase: (rs, live, state) => {
    let period = 0, open = false;
    for (const e of live) { if (e.kind === 'period_start') { period = e.period ?? period + 1; open = true; } else if (e.kind === 'period_end') open = false; }
    const cs = state.cricket;
    return { period, period_open: open, periods_total: rs.periods.count, innings: cs.current.n, batting: cs.current.side, balls_left: cs.balls_left, to_win: cs.to_win };
  },
  /** ctx.lineup = { home: [playerId × 11 in batting order], away: [...] } maps the scorer's batting slots to verified players. */
  attribution(rs, live, ctx = {}) {
    const cs = cricketState(rs, live);
    const lineup = ctx.lineup ?? cs.lineup ?? {};
    const who = (side, idx) => lineup[side]?.[idx] ?? null;
    const out = [];
    for (const inn of cs.innings) {
      const bat = inn.side, field = otherSide(bat);
      inn.batters.filter((b) => b.arrived).forEach((b) => out.push({ role: 'batting', innings: inn.n, side: bat, slot: b.idx, player_id: who(bat, b.idx), runs: b.runs, balls: b.balls, fours: b.fours, sixes: b.sixes, out: b.out }));
      Object.values(inn.bowlers).forEach((b) => out.push({ role: 'bowling', innings: inn.n, side: field, slot: b.idx, player_id: who(field, b.idx), overs: Math.floor(b.legal / 6) + (b.legal % 6 ? (b.legal % 6) / 10 : 0), runs: b.runs, wickets: b.wickets, wides: b.wd, no_balls: b.nb }));
    }
    return out;
  },
  liveStats: (rs, live, state) => state.stats,
  publicView(state) {
    const cs = state.cricket;
    return {
      home: cs.home, away: cs.away, wickets: cs.wickets, result: cs.result, target: cs.target, to_win: cs.to_win, balls_left: cs.balls_left,
      current_run_rate: cs.current_run_rate, required_run_rate: cs.required_run_rate, current: cs.current,
      innings: cs.innings.map((i) => ({ n: i.n, side: i.side, runs: i.runs, wickets: i.wickets, overs: i.legal, closed: i.closed, run_rate: i.run_rate, fow: i.fow, partnerships: i.partnerships, extras: i.extras })),
    };
  },
  toResult: (state) => ({ home: state.home, away: state.away, winner: state.winner, totals: { cricket: { wickets: state.cricket.wickets, result: state.cricket.result, innings: state.cricket.innings.map((i) => ({ n: i.n, side: i.side, runs: i.runs, wickets: i.wickets, legal_balls: i.legal })) } } }),
};

// ------------------------------------------------------------------ manual totals
const manualPlugin = {
  kind: 'manual',
  state: () => ({ home: 0, away: 0, winner: null, level: true, over: false, stats: { home: {}, away: {} } }),
  validate(rs, live, next) {
    if (CONTROL_KINDS.includes(next.kind)) return null;
    if (![...rs.events, ...rs.stats].some((x) => x.kind === next.kind)) return `"${next.kind}" is not part of the ${rs.label} rules`;
    if (!SIDES.includes(next.side)) return 'side must be home or away';
    return 'This sport is scored by entering the totals on the score sheet';
  },
  phase: (rs) => ({ period: 0, period_open: false, periods_total: rs.periods.count }),
  attribution: () => null,
  liveStats: () => ({ home: {}, away: {} }),
  publicView: () => ({ home: 0, away: 0 }),
  toResult: () => ({ home: 0, away: 0, winner: null, totals: {} }),
};

/** Per-player tally of whatever events carry a player_id (no player = nothing invented). */
function pointsAttribution(live) {
  const by = new Map();
  for (const e of live) {
    if (!e.player_id || !SIDES.includes(e.side)) continue;
    const r = by.get(e.player_id) ?? { player_id: e.player_id, side: e.side, events: {} };
    r.events[e.kind] = (r.events[e.kind] ?? 0) + 1; by.set(e.player_id, r);
  }
  return [...by.values()];
}

const registry = new Map([pointsPlugin, setsPlugin, racketPlugin, cricketPlugin, manualPlugin].map((p) => [p.kind, p]));
/** Register another sport plugin (a new ruleset kind) without touching the engine. */
export function registerSportPlugin(p) { registry.set(p.kind, p); }
export const sportPlugins = () => [...registry.keys()];

/** The plugin that scores a ruleset. Tennis-style games refine `sets` and have their own plugin. */
export function pluginFor(rs) {
  const key = isGames(rs) ? 'racket' : rs.kind;
  const p = registry.get(key);
  if (!p) throw new Error(`No scoring plugin for "${key}"`);
  return p;
}

// ------------------------------------------------------------------ timed / measured sessions (athletics, swimming …)
export const sessionPlugin = {
  kind: 'session',
  state: (cfg, events) => sessionState(cfg, events),
  validate: (cfg, state, next) => sessionReject(cfg, state, next),
  attribution: (cfg, events) => sessionState(cfg, events).entries.map((e) => ({ entry_id: e.entry_id, rank: e.rank, best: e.best, status: e.status })),
  publicView: (state) => ({ status: state.status, provisional: state.provisional, round: state.round, entries: state.entries.map((e) => ({ entry_id: e.entry_id, lane: e.lane, status: e.status, rank: e.rank, best: e.best, result: e.result, q: e.q ?? '', attempts: e.attempts, splits: e.splits })) }),
  /** A result list for recordSessionResults; only competitors that finished or have a mark are included. */
  toResult: (state) => state.entries.filter((e) => ['finished', 'dns', 'dnf', 'dq'].includes(e.status) || (state.kind === 'field' && e.best != null))
    .map((e) => ({ entry_id: e.entry_id, value: e.best, status: ['dns', 'dnf', 'dq'].includes(e.status) ? e.status : 'finished', ...(e.reason ? { note: e.reason } : {}) })),
};
export { SESSION_KINDS };
