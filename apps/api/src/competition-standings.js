// Competition standings (#476): a pure function of canonical results + a season's versioned rules + separately recorded adjustments. Nothing here reads or
// writes the database, so a completed season is reproducible from its inputs (and frozen as a hash in comp_standing_snapshots). The match tables are never edited:
// a forfeit is a reasoned decision recorded beside the fixture, and an adjustment is its own append-only row.
import { createHash } from 'node:crypto';

export const TIEBREAKERS = {
  points: 'Points',
  head_to_head_points: 'Head-to-head points',
  head_to_head_diff: 'Head-to-head score difference',
  head_to_head_for: 'Head-to-head scored',
  diff: 'Score difference',
  for: 'Scored',
  wins: 'Wins',
  away_for: 'Scored away',
  name: 'Name (A–Z)',
};
export const DEFAULT_RULES = {
  points: { win: 3, draw: 1, loss: 0 },
  forfeit: { winner_for: 3, winner_against: 0, loser_points: 0 },          // a forfeit is recorded as this score for the side that did not forfeit
  tiebreakers: ['points', 'head_to_head_points', 'head_to_head_diff', 'diff', 'for', 'wins', 'name'],
  movement: { champion: true, promote: 0, relegate: 0, playoff: 0, qualify: 0 },   // per division: how many promote / relegate / go to a playoff / qualify
};

/** The unit a sport's score is counted in, so a table never calls cricket runs "goals". Unlisted sports get the labelled generic fallback. */
const UNIT = { goals: ['Goals', 'GF', 'GA', 'GD'], points: ['Points scored', 'PF', 'PA', 'PD'], sets: ['Sets', 'SF', 'SA', 'SD'], time: ['Result', 'F', 'A', 'D'], distance: ['Result', 'F', 'A', 'D'] };
export const unitFor = (scoring) => { const u = UNIT[scoring]; return u ? { unit: u[0], for: u[1], against: u[2], diff: u[3], generic: false } : { unit: 'Score', for: 'F', against: 'A', diff: 'D', generic: true }; };

export function normaliseRules(r = {}) {
  const out = {
    points: { ...DEFAULT_RULES.points, ...(r.points ?? {}) },
    forfeit: { ...DEFAULT_RULES.forfeit, ...(r.forfeit ?? {}) },
    tiebreakers: Array.isArray(r.tiebreakers) && r.tiebreakers.length ? r.tiebreakers.filter((t) => TIEBREAKERS[t]) : DEFAULT_RULES.tiebreakers,
    movement: { ...DEFAULT_RULES.movement, ...(r.movement ?? {}) },
  };
  if (!out.tiebreakers.includes('points')) out.tiebreakers.unshift('points');
  if (!out.tiebreakers.includes('name')) out.tiebreakers.push('name');
  return out;
}

const blank = (t) => ({ team_id: t.team_id, name: t.name ?? null, played: 0, won: 0, drawn: 0, lost: 0, for: 0, against: 0, away_for: 0, forfeits: 0, base_points: 0, adjustment: 0, points: 0 });

/** Result of one fixture seen from both sides: the real score, or the forfeit score when a decision says so. null when it does not count yet. */
export function resultOf(f, rules) {
  const o = f.outcome ?? 'played';
  if (o === 'double_forfeit') return { h: 0, a: 0, hp: rules.forfeit.loser_points, ap: rules.forfeit.loser_points, forfeit: 'both' };
  if (o === 'forfeit_home') return { h: rules.forfeit.winner_against, a: rules.forfeit.winner_for, forfeit: 'home' };
  if (o === 'forfeit_away') return { h: rules.forfeit.winner_for, a: rules.forfeit.winner_against, forfeit: 'away' };
  if (f.status !== 'completed' || f.home_score == null || f.away_score == null) return null;
  return { h: f.home_score, a: f.away_score, forfeit: null };
}

function tally(teams, fixtures, rules) {
  const row = new Map(teams.map((t) => [t.team_id, blank(t)]));
  for (const f of fixtures) {
    const h = row.get(f.home_team_id), a = row.get(f.away_team_id);
    if (!h || !a) continue;
    const r = resultOf(f, rules);
    if (!r) continue;
    h.played++; a.played++; h.for += r.h; h.against += r.a; a.for += r.a; a.against += r.h; a.away_for += r.a;
    if (r.forfeit === 'both') { h.lost++; a.lost++; h.forfeits++; a.forfeits++; h.base_points += r.hp; a.base_points += r.ap; continue; }
    if (r.forfeit) {
      const [w, l] = r.forfeit === 'home' ? [a, h] : [h, a];
      w.won++; l.lost++; l.forfeits++; w.base_points += rules.points.win; l.base_points += rules.forfeit.loser_points;
      continue;
    }
    if (r.h > r.a) { h.won++; a.lost++; h.base_points += rules.points.win; a.base_points += rules.points.loss; }
    else if (r.h < r.a) { a.won++; h.lost++; a.base_points += rules.points.win; h.base_points += rules.points.loss; }
    else { h.drawn++; a.drawn++; h.base_points += rules.points.draw; a.base_points += rules.points.draw; }
  }
  return row;
}

const key = (c, r, mini) => {
  switch (c) {
    case 'points': return r.points;
    case 'head_to_head_points': return mini ? mini.get(r.team_id)?.base_points ?? 0 : 0;
    case 'head_to_head_diff': return mini ? (mini.get(r.team_id)?.for ?? 0) - (mini.get(r.team_id)?.against ?? 0) : 0;
    case 'head_to_head_for': return mini ? mini.get(r.team_id)?.for ?? 0 : 0;
    case 'diff': return r.for - r.against;
    case 'for': return r.for;
    case 'wins': return r.won;
    case 'away_for': return r.away_for;
    default: return 0;
  }
};

/** Order a set of teams by the criteria in turn; teams still level after a criterion are re-ordered among themselves by the next (head-to-head is recomputed for each tied group). */
function order(rows, criteria, fixtures, rules) {
  if (rows.length < 2 || !criteria.length) return rows.sort((x, y) => String(x.name ?? '').localeCompare(String(y.name ?? '')) || x.team_id.localeCompare(y.team_id));
  const [c, ...rest] = criteria;
  if (c === 'name') return rows.sort((x, y) => String(x.name ?? '').localeCompare(String(y.name ?? '')) || x.team_id.localeCompare(y.team_id));
  const h2h = c.startsWith('head_to_head');
  const ids = new Set(rows.map((r) => r.team_id));
  const mini = h2h ? tally(rows, fixtures.filter((f) => ids.has(f.home_team_id) && ids.has(f.away_team_id)), rules) : null;
  const groups = new Map();
  for (const r of rows) { const k = key(c, r, mini); (groups.get(k) ?? groups.set(k, []).get(k)).push(r); }
  const out = [];
  for (const k of [...groups.keys()].sort((a, b) => b - a)) {
    const g = groups.get(k);
    // when head-to-head separates nobody (all in one group) fall through to the remaining criteria with the full set
    out.push(...(g.length === rows.length ? order(g, rest, fixtures, rules) : order(g, g.length > 1 && h2h ? criteria : rest, fixtures, rules)));
  }
  return out;
}

/**
 * @param {{team_id:string,name?:string}[]} teams   members of the division
 * @param {{home_team_id,away_team_id,status,home_score,away_score,outcome?}[]} fixtures   the division's canonical fixtures
 * @param {object} rawRules  the season rule version's `rules`
 * @param {{team_id:string,points_delta:number}[]} adjustments
 */
export function computeStandings(teams, fixtures, rawRules, adjustments = []) {
  const rules = normaliseRules(rawRules);
  const rows = [...tally(teams, fixtures, rules).values()];
  for (const a of adjustments) { const r = rows.find((x) => x.team_id === a.team_id); if (r) r.adjustment += a.points_delta; }
  for (const r of rows) r.points = r.base_points + r.adjustment;
  const sorted = order(rows, rules.tiebreakers.filter((c) => c !== 'name'), fixtures, rules);
  return sorted.map((r, i) => ({ rank: i + 1, ...r, diff: r.for - r.against }));
}

export const tableHash = (table, rulesVersion) => createHash('sha256').update(JSON.stringify({ v: rulesVersion, t: table.map((r) => [r.team_id, r.rank, r.played, r.won, r.drawn, r.lost, r.for, r.against, r.adjustment, r.points]) })).digest('hex');

/** Single or double round robin (circle method). Returns rounds of [home, away] pairs; an odd field gets a bye (null). Round 2 of a double mirrors round 1's home/away. */
export function roundRobin(teamIds, { double = false } = {}) {
  const t = [...teamIds];
  if (t.length < 2) return [];
  if (t.length % 2) t.push(null);
  const n = t.length, rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      let h = t[i], a = t[n - 1 - i];
      if (h == null || a == null) continue;
      if (i === 0 && r % 2) [h, a] = [a, h];                    // alternate the fixed team's venue so nobody has all home games
      else if (i > 0 && (r + i) % 2) [h, a] = [a, h];
      pairs.push([h, a]);
    }
    rounds.push(pairs);
    t.splice(1, 0, t.pop());
  }
  return double ? [...rounds, ...rounds.map((p) => p.map(([h, a]) => [a, h]))] : rounds;
}

/** Season-end movements from final tables: champion, promotion, playoff, qualification, relegation and the rest stay. Tier 1 is the top. */
export function proposeMovements(divisions) {
  const out = [];
  for (const d of divisions) {
    const m = normaliseRules(d.rules).movement, n = d.table.length;
    const promote = Math.min(m.promote, n), relegate = Math.min(m.relegate, Math.max(0, n - promote)), playoff = Math.min(m.playoff, Math.max(0, n - promote - relegate));
    d.table.forEach((r, i) => {
      let kind = 'stay';
      if (i < promote && d.tier > 1) kind = 'promotion';
      else if (i >= n - relegate && relegate > 0) kind = 'relegation';
      else if (i >= promote && i < promote + playoff) kind = 'playoff';
      else if (i < m.qualify) kind = 'qualification';
      if (i === 0 && m.champion && kind === 'stay') kind = 'champion';
      out.push({ team_id: r.team_id, from_division_id: d.id, rank: r.rank, kind, to_tier: kind === 'promotion' ? d.tier - 1 : kind === 'relegation' ? d.tier + 1 : d.tier });
    });
  }
  return out;
}
