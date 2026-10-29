// Turns a format + an ordered field into the fixtures to create (pure, deterministic): the single place formats become games.
// The result has the same shape for every format, so one writer persists it and one scheduler places it:
//   items:   one per game { key, round, round_kind, bracket_side, round_no, slot, pool, home_team_id, away_team_id, home_placeholder, away_placeholder,
//                           win_feeds:{key,side}|null, lose_feeds:{key,side}|null, conditional, tie?, leg_no?, leg_swap?, winner_optional? }
//   matches: for the scheduler { key, home, away, after:[keys] }
import { buildBracket, ROUND_LABEL, MAX_KNOCKOUT_TEAMS } from './bracket.js';
import { buildDoubleElimination, MAX_DOUBLE_TEAMS } from './formats/double-elim.js';
import { classificationNodes, consolationNodes } from './formats/repechage.js';
import { resolveGraph, LOSE } from './formats/graph.js';
import { pairSwissRound, DEFAULT_SWISS, SWISS_POLICIES } from './formats/swiss.js';
import { drawPools, DEFAULT_POOLS, poolName } from './formats/pools.js';
import { homeRotation, SERIES_LENGTHS, HOME_ROTATIONS } from './formats/series.js';
import { roundRobinPairs } from './scheduler.js';
import { rngFor, shuffled } from './formats/rng.js';

export const FORMATS = ['round_robin', 'knockout', 'double_elimination', 'swiss', 'pools'];
export const STAGE_KIND = { round_robin: 'round_robin', knockout: 'knockout', double_elimination: 'double_elimination', swiss: 'swiss', pools: 'pools' };
const SIDE_ORDER = { winners: 0, pool: 0, swiss: 0, main: 0, losers: 1, repechage: 1, placement: 2, consolation: 2, grand_final: 3 };

const knockoutLabel = (f) => `${ROUND_LABEL[f.round_kind]}${['final', 'third_place'].includes(f.round_kind) ? '' : ` ${f.slot + 1}`}`;

/** Order the field for a draw: seeded as given, or random with the top N protected; returns the order and the persisted seed. */
export function orderField(teamIds, draw = {}, drawSeed) {
  if (draw.mode !== 'random') return { order: teamIds.slice(), drawSeed: null };
  const keep = Math.min(draw.protect_top ?? 0, teamIds.length);
  const seed = drawSeed ?? draw.draw_seed;
  if (!seed) throw new Error('A random draw needs a draw seed');
  return { order: [...teamIds.slice(0, keep), ...shuffled(teamIds.slice(keep), rngFor(`${seed}:field`))], drawSeed: seed };
}

function tieFor(cfg, node) {
  const t = cfg.tie;
  if (!t || !t.mode) return null;
  if (['third_place', 'placement'].includes(node.round_kind)) return null;
  if (t.apply_to === 'except_final' && ['final', 'grand_final'].includes(node.round_kind)) return null;
  if (node.conditional) return null;
  return t;
}

/** depth of every item = longest chain of feeders above it (so the scheduler sees feeders first) */
function orderByDepth(items) {
  const byKey = new Map(items.map((x) => [x.key, x]));
  const feeders = new Map(items.map((x) => [x.key, []]));
  for (const x of items) for (const f of [x.win_feeds, x.lose_feeds]) if (f && feeders.has(f.key)) feeders.get(f.key).push(x.key);
  const depth = new Map();
  const d = (k) => { if (depth.has(k)) return depth.get(k); depth.set(k, 0); const v = feeders.get(k).length ? 1 + Math.max(...feeders.get(k).map(d)) : 0; depth.set(k, v); return v; };
  items.forEach((x) => d(x.key));
  return { sorted: items.slice().sort((a, b) => depth.get(a.key) - depth.get(b.key) || (b.round_kind === 'third_place') - (a.round_kind === 'third_place') || (SIDE_ORDER[a.bracket_side] ?? 0) - (SIDE_ORDER[b.bracket_side] ?? 0) || (a.round_no ?? 0) - (b.round_no ?? 0) || a.slot - b.slot), feeders };
}

/** Expand tie nodes into one item per game and wire dependencies. nodes: resolved bracket fixtures (graph shape). */
function toItems(nodes, cfg, labelOf) {
  const out = [];
  const anchor = new Map(), last = new Map();
  const games = new Map();
  for (const n of nodes) {
    const tie = tieFor(cfg, n);
    const count = !tie ? 1 : tie.mode === 'best_of' ? tie.best_of : tie.legs;
    games.set(n.key, count);
    anchor.set(n.key, tie ? `${n.key}#1` : n.key);
    last.set(n.key, tie ? `${n.key}#${count}` : n.key);
  }
  const { sorted, feeders } = orderByDepth(nodes.map((n) => ({ ...n, slot: n.slot ?? 0 })));
  const target = (f) => (f ? { key: anchor.get(f.key), side: f.side } : null);
  const matches = [];
  for (const n of sorted) {
    const tie = tieFor(cfg, n), count = games.get(n.key);
    const label = labelOf(n);
    const base = { round_kind: n.round_kind, bracket_side: n.bracket_side ?? null, round_no: n.round_no ?? null, slot: n.slot ?? 0, pool: n.pool ?? null, conditional: n.conditional ?? null };
    const after = (feeders.get(n.key) ?? []).map((k) => last.get(k));
    if (!tie) {
      out.push({ ...base, key: n.key, round: label, home_team_id: n.home, away_team_id: n.away, home_placeholder: n.home_placeholder, away_placeholder: n.away_placeholder, win_feeds: target(n.win_feeds), lose_feeds: target(n.lose_feeds) });
      matches.push({ key: n.key, home: n.home, away: n.away, after });
      continue;
    }
    const rot = tie.mode === 'best_of' ? homeRotation(tie.home_rotation ?? 'alternate', count) : Array.from({ length: count }, (_, g) => g % 2 === 0);
    for (let g = 1; g <= count; g++) {
      const key = `${n.key}#${g}`, swap = !rot[g - 1];
      out.push({ ...base, key, round: `${label} · ${tie.mode === 'best_of' ? `Game ${g} of ${count}` : `Leg ${g} of ${count}`}`, leg_no: g, leg_swap: swap, winner_optional: tie.mode === 'legs',
        home_team_id: swap ? n.away : n.home, away_team_id: swap ? n.home : n.away, home_placeholder: swap ? n.away_placeholder : n.home_placeholder, away_placeholder: swap ? n.home_placeholder : n.away_placeholder,
        win_feeds: null, lose_feeds: null,
        tie: g === 1 ? { key: n.key, kind: tie.mode === 'best_of' ? 'best_of' : 'legs', config: tie.mode === 'best_of' ? { best_of: tie.best_of, home_rotation: tie.home_rotation ?? 'alternate' } : { legs: tie.legs, away_goals: tie.away_goals === true, decider: tie.decider ?? 'extra_time_then_penalties' }, label, win_feeds: target(n.win_feeds), lose_feeds: target(n.lose_feeds) } : { key: n.key } });
      matches.push({ key, home: n.home, away: n.away, after: g === 1 ? after : [`${n.key}#${g - 1}`] });
    }
  }
  return { items: out, matches };
}

function validateTie(t) {
  if (!t) return;
  if (t.mode === 'best_of') { if (!SERIES_LENGTHS.includes(t.best_of)) throw new Error(`Best-of must be one of ${SERIES_LENGTHS.join(', ')}`); if (t.home_rotation && !HOME_ROTATIONS.includes(t.home_rotation)) throw new Error('Unknown home rotation'); }
  else if (t.mode === 'legs') { if (!(t.legs >= 2 && t.legs <= 4)) throw new Error('A multi-leg tie has 2 to 4 legs'); }
  else throw new Error('Tie mode must be best_of or legs');
}

/**
 * @param {string} format
 * @param {string[]} teams ordered best seed first (after any draw)
 * @param {object} cfg the stage's format config
 * @param {{drawSeed?:string, points?:object, warnings?:string[]}} ctx
 */
export function buildPlan(format, teams, cfg = {}, ctx = {}) {
  const warnings = [];
  validateTie(cfg.tie);
  if (format === 'round_robin') {
    const rr = roundRobinPairs(teams);
    return { stageKind: 'round_robin', stageName: 'Group stage', algorithm: 'round_robin/circle@1', byes: [], warnings,
      matches: rr.map((m, n) => ({ key: `rr:${n}`, home: m.home, away: m.away, after: [] })),
      items: rr.map((m, n) => ({ key: `rr:${n}`, round: `Round ${m.round}`, round_kind: 'group', bracket_side: null, round_no: m.round, slot: null, pool: null, home_team_id: m.home, away_team_id: m.away, home_placeholder: null, away_placeholder: null, win_feeds: null, lose_feeds: null, conditional: null })) };
  }
  if (format === 'knockout') {
    if (teams.length > MAX_KNOCKOUT_TEAMS) throw new Error(`A knockout supports at most ${MAX_KNOCKOUT_TEAMS} teams`);
    const upTo = cfg.placement_up_to ?? 0;
    const b = buildBracket(teams, { thirdPlace: !!cfg.third_place || upTo >= 3 });
    const nodes = b.fixtures.map((f) => ({ ...f, bracket_side: 'main', round_no: f.round_index + 1 }));
    const extra = [];
    if (upTo >= 8) {
      const refs = nodes.filter((f) => f.round_kind === 'quarter').map((f) => LOSE(f.key));
      if (refs.length) extra.push(...classificationNodes(refs, 5, 'PL')); else warnings.push('Fewer than 8 teams: there are no quarter-final losers to classify');
      if (upTo >= 16) {
        const r16 = nodes.filter((f) => f.round_kind === 'round_of_16').map((f) => LOSE(f.key));
        if (r16.length) extra.push(...classificationNodes(r16, 9, 'PM')); else warnings.push('Fewer than 16 teams: there is no round of 16 to classify');
      }
    }
    if (cfg.consolation) {
      if (upTo >= 8) throw new Error('Choose either a consolation bracket or placement play-offs, not both: they use the same eliminated teams');
      const firstRound = nodes.filter((f) => f.round_index === 0 && f.home && f.away);
      if (firstRound.length >= 2) extra.push(...consolationNodes(firstRound.map((f) => LOSE(f.key))));
      else warnings.push('Not enough first-round games for a consolation bracket');
    }
    let all = nodes;
    if (extra.length) {
      const r = resolveGraph(extra, { external: nodes });
      for (const ef of r.externalFeeds) {
        const src = nodes.find((x) => x.key === ef.from);
        if (src[ef.slot]) throw new Error(`${src.key} already sends its ${ef.slot === 'win_feeds' ? 'winner' : 'loser'} elsewhere`);
        src[ef.slot] = ef.to;
      }
      all = [...nodes, ...r.fixtures];
    }
    const { items, matches } = toItems(all, cfg, (f) => (f.label && f.round_kind === 'placement' ? f.label : knockoutLabel(f)));
    return { stageKind: 'knockout', stageName: 'Knockout', algorithm: 'knockout/seed-order@1', byes: b.byes, warnings, items, matches };
  }
  if (format === 'double_elimination') {
    if (teams.length > MAX_DOUBLE_TEAMS) throw new Error(`A double-elimination bracket supports at most ${MAX_DOUBLE_TEAMS} teams`);
    const b = buildDoubleElimination(teams, { reset: !!cfg.reset });
    const { items, matches } = toItems(b.fixtures, cfg, (f) => f.label);
    return { stageKind: 'double_elimination', stageName: 'Double elimination', algorithm: `double_elimination/seed-order@1${cfg.reset ? '+reset' : ''}`, byes: b.byes, warnings, items, matches };
  }
  if (format === 'swiss') {
    const sw = { ...DEFAULT_SWISS, ...(cfg.swiss ?? {}) };
    if (!SWISS_POLICIES[sw.policy]) throw new Error(`Unknown Swiss pairing policy "${sw.policy}"`);
    if (teams.length < 4) throw new Error('A Swiss event needs at least 4 teams');
    if (sw.rounds < 1 || sw.rounds > 15) throw new Error('Swiss rounds must be between 1 and 15');
    if (sw.rounds >= teams.length) warnings.push('More rounds than opponents: repeat opponents become unavoidable');
    const r = pairSwissRound(teams, [], sw, { round: 1, drawSeed: ctx.drawSeed, manual: cfg.manual_pairings, ...(ctx.points ?? {}) });
    return swissPlan(r, sw, teams, warnings);
  }
  if (format === 'pools') {
    const pc = { ...DEFAULT_POOLS, ...(cfg.pools ?? {}) };
    const pools = drawPools(teams, { pool_count: pc.pool_count, draw: pc.draw, drawSeed: ctx.drawSeed, manual: pc.manual });
    const items = [], matches = [];
    for (const p of pools) {
      roundRobinPairs(p.teams).forEach((m, n) => {
        const key = `pool${p.name}:${n}`;
        items.push({ key, round: `Pool ${p.name} · Round ${m.round}`, round_kind: 'group', bracket_side: 'pool', round_no: m.round, slot: n, pool: p.name, home_team_id: m.home, away_team_id: m.away, home_placeholder: null, away_placeholder: null, win_feeds: null, lose_feeds: null, conditional: null });
        matches.push({ key, home: m.home, away: m.away, after: [], order: m.round });
      });
    }
    matches.sort((a, b) => a.order - b.order);
    return { stageKind: 'pools', stageName: 'Pools', algorithm: `pools/${pc.draw}@1`, byes: [], warnings, items, matches, pools };
  }
  throw new Error(`Unknown format "${format}"`);
}

/** Plan items for a ready-made set of graph fixtures (repechage ladders), with the same tie / label handling as the main plans. */
export const graphPlan = (fixtures, cfg = {}, labelOf = (f) => f.label) => toItems(fixtures, cfg, labelOf);

/** A Swiss round as plan items (also used for later rounds). */
export function swissPlan(r, sw, teams, warnings = []) {
  const items = r.pairings.map((p) => ({ key: `sw${r.round}:${p.board}`, round: `Round ${r.round} · Board ${p.board}`, round_kind: 'group', bracket_side: 'swiss', round_no: r.round, slot: p.board, pool: null,
    home_team_id: p.home, away_team_id: p.away, home_placeholder: null, away_placeholder: null, win_feeds: null, lose_feeds: null, conditional: null, reason: p.reason }));
  return { stageKind: 'swiss', stageName: 'Swiss', algorithm: r.algorithm, byes: r.bye ? [r.bye.team] : [], bye: r.bye, warnings: [...warnings, ...r.warnings], items,
    matches: items.map((x) => ({ key: x.key, home: x.home_team_id, away: x.away_team_id, after: [] })), pairing: r, config: sw };
}

export { poolName };

// ---------------------------------------------------------------- which sports a bracket is native to
const HEAD_TO_HEAD = { goals: 'Two sides, scored in goals', sets: 'Two sides, scored in sets and games', points: 'Two sides, scored in points', combat: 'Two competitors, scored in bouts' };
const MEASURED = { time: 'timed', distance: 'measured by distance or height', judged: 'marked by judges', weight: 'lifted for weight' };

/**
 * How a bracket fits a sport. Contests between two sides (goals, sets, points, combat) are native: every game is a fixture with a score.
 * Sports decided by time, distance, judges or weight are normally run as heats and finals through the Games programme; a head-to-head bracket is
 * available for them but is labelled a fallback (each game is two entrants and a score), never presented as the sport's own format.
 */
export function coverageOf(sport) {
  if (!sport) return { mode: 'native', family: 'unspecified', note: null };
  if (HEAD_TO_HEAD[sport.scoring]) return { mode: 'native', family: sport.scoring, note: null };
  if (MEASURED[sport.scoring]) return { mode: 'fallback', family: sport.scoring, note: `${sport.name} is normally ${MEASURED[sport.scoring]}, with heats and finals run from the Games programme. This head-to-head bracket is a generic fallback: each game is two entrants and a score.` };
  return { mode: 'fallback', family: sport.scoring ?? 'unknown', note: `${sport.name ?? 'This sport'} has no native bracket model; this head-to-head bracket is a generic fallback.` };
}
