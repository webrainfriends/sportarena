// Player benchmarks (issue #321): how one player compares with a cohort, honestly.
//  * direction-aware: a percentile always means "ahead of this share of the cohort *in the good direction*" (turnovers, fouls, times: lower wins)
//  * metric-specific denominators: a stat is averaged over the matches that recorded it, never over every match, and says how many that was
//  * two evidence tracks that are never blended: 'self_reported' (matches the player logged or imported) and 'official' (approved competition results)
//  * cohorts narrow by sport, then optionally position and match format, level or region; never fewer than MIN_COHORT other players
//  * a young person is in a cohort, or sees one, only while a guardian's current 'coaching' consent is in force (checked on every read)
// Only aggregates leave this module: no other player's name, id or single result.
import { CONSENT_OK } from './coaching-shared.js';
import { ruleFor } from './scoring/performance-rules.js';

export const MIN_MATCHES = 3;  // recorded matches/results before a metric is shown or counts toward a cohort
export const MIN_COHORT = 5;   // fewer other players than this would single people out
export const EVIDENCE = {
  self_reported: 'Self-logged matches',
  official: 'Approved competition results',
};

export const nice = (k) => String(k).replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());
export const round = (n, d = 2) => (n === null || n === undefined ? null : Math.round(n * 10 ** d) / 10 ** d);
export const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };

// Keys are split on "_" and matched word by word, so "cardio" is not a "card" and "second_serve" is not a time.
const LOWER = new Set(['turnover', 'turnovers', 'foul', 'fouls', 'error', 'errors', 'fault', 'faults', 'conceded', 'against', 'penalty', 'penalties', 'card', 'cards',
  'miss', 'misses', 'missed', 'lost', 'loss', 'losses', 'offside', 'offsides', 'unforced', 'bogey', 'bogeys', 'strokes', 'time', 'sec', 'secs', 'seconds']);
const HIGHER = new Set(['goal', 'goals', 'assist', 'assists', 'point', 'points', 'run', 'runs', 'wicket', 'wickets', 'ace', 'aces', 'save', 'saves', 'tackle', 'tackles',
  'rebound', 'rebounds', 'block', 'blocks', 'steal', 'steals', 'shot', 'shots', 'pass', 'passes', 'winner', 'winners', 'kill', 'kills', 'catch', 'catches', 'dig', 'digs',
  'win', 'wins', 'distance', 'throw', 'jump', 'rating', 'minutes', 'sheet', 'interception', 'interceptions', 'dribble', 'dribbles', 'boundaries', 'sixes', 'fours', 'sets', 'games']);

/** Which way is better for a metric: 'lower' (errors, fouls, conceded, times), 'higher' (goals, points, distance …) or 'unknown'. */
export function metricDirection(key, stored = null) {
  if (stored === 'lower' || stored === 'higher') return stored;
  const words = String(key).toLowerCase().split('_');
  if (words.some((w) => LOWER.has(w))) return 'lower';
  const rule = ruleFor({}, key);
  if (rule.unit === 's') return 'lower';
  if (rule.unit === 'm') return 'higher';
  return words.some((w) => HIGHER.has(w)) ? 'higher' : 'unknown';
}

/** Share (0-100) of `others` this value is ahead of in the metric's good direction, ties counting as half. */
export function percentileDirected(mine, others, direction) {
  const beat = (o) => (direction === 'lower' ? o > mine : o < mine);
  return Math.round((100 * (others.filter(beat).length + 0.5 * others.filter((o) => o === mine).length)) / others.length);
}

/** Players who may be counted: athletes with a live card, and young people only with a guardian's current coaching consent. */
const ELIGIBLE = `sp.role = 'athlete' AND sp.archived_at IS NULL AND ${CONSENT_OK('sp.user_id')}`;
const POSITION = (n) => `($${n}::text IS NULL OR EXISTS (SELECT 1 FROM unnest(sp.positions || ARRAY[coalesce(sp.position, '')]) x WHERE lower(btrim(x)) = lower($${n})))`;

/** Self-logged evidence: per player, totals and the number of matches that actually recorded each stat. */
export async function loadSelf(db, sportId, { position = null, matchType = null } = {}) {
  const f = [sportId, position, matchType];
  const [players, stats] = await Promise.all([
    db.query(`SELECT sp.user_id, sp.level, lower(btrim(sp.region)) AS region, count(*)::int AS matches,
                     count(*) FILTER (WHERE m.result IS NOT NULL)::int AS decided, count(*) FILTER (WHERE m.result = 'win')::int AS wins,
                     count(m.rating)::int AS rated, avg(m.rating)::float8 AS rating
                FROM player_matches m JOIN sport_profiles sp ON sp.id = m.sport_profile_id
               WHERE sp.sport_id = $1 AND ${ELIGIBLE} AND ${POSITION(2)} AND m.archived_at IS NULL AND ($3::text IS NULL OR m.match_type = $3)
               GROUP BY sp.user_id, sp.level, lower(btrim(sp.region))`, f),
    db.query(`SELECT m.user_id, e.key, sum(e.value::numeric)::float8 AS total, count(*)::int AS n
                FROM player_matches m JOIN sport_profiles sp ON sp.id = m.sport_profile_id, jsonb_each_text(m.stats) e
               WHERE sp.sport_id = $1 AND ${ELIGIBLE} AND ${POSITION(2)} AND m.archived_at IS NULL AND ($3::text IS NULL OR m.match_type = $3)
                 AND e.value ~ '^-?[0-9]+(\\.[0-9]+)?$'
               GROUP BY m.user_id, e.key`, f),
  ]);
  const byUser = new Map(players.rows.map((p) => [p.user_id, { ...p, region: p.region || null, metrics: {} }]));
  for (const s of stats.rows) { const u = byUser.get(s.user_id); if (u) u.metrics[s.key] = { value: s.total / s.n, n: s.n, total: u.matches, unit: 'per match', direction: metricDirection(s.key) }; }
  for (const u of byUser.values()) {
    if (u.decided) u.metrics.win_rate = { value: 100 * u.wins / u.decided, n: u.decided, total: u.matches, unit: '%', direction: 'higher', label: 'Win rate' };
    if (u.rated) u.metrics.avg_rating = { value: u.rating, n: u.rated, total: u.matches, unit: '/10', direction: 'higher', label: 'Average self-rating' };
    u.metrics.matches = { value: u.matches, n: u.matches, total: u.matches, unit: '', direction: 'higher', label: 'Matches logged' };
  }
  return byUser;
}

/** Official evidence: approved competition results only. Counts are averaged per result; times and distances use the best result. */
export async function loadOfficial(db, sportId, { position = null } = {}) {
  const [players, rows] = await Promise.all([
    db.query(`SELECT sp.user_id, sp.level, lower(btrim(sp.region)) AS region FROM sport_profiles sp WHERE sp.sport_id = $1 AND ${ELIGIBLE} AND ${POSITION(2)}`, [sportId, position]),
    db.query(`SELECT p.user_id, p.metric, count(*)::int AS n, avg(p.value)::float8 AS avg, min(p.value)::float8 AS lo, max(p.value)::float8 AS hi,
                     min(coalesce(p.direction, 'higher')) AS direction, min(p.unit) AS unit
                FROM performances p WHERE p.sport_id = $1 AND p.provenance = 'approved_competition' AND p.status = 'approved'
               GROUP BY p.user_id, p.metric`, [sportId]),
  ]);
  const byUser = new Map(players.rows.map((p) => [p.user_id, { ...p, region: p.region || null, matches: 0, metrics: {} }]));
  for (const r of rows.rows) {
    const u = byUser.get(r.user_id); if (!u) continue;
    const direction = metricDirection(r.metric, r.direction);
    const counted = r.unit === 'count' || r.unit === null;
    u.metrics[r.metric] = { value: counted ? r.avg : (direction === 'lower' ? r.lo : r.hi), n: r.n, total: r.n, unit: counted ? 'per result' : `best ${r.unit}`, direction };
    u.matches = Math.max(u.matches, r.n);
  }
  return byUser;
}

/** My metrics against one cohort. Every row says how it was reached and why it is, or is not, ranked. */
export function compare(me, cohort, evidence) {
  const others = cohort.filter((p) => p.matches >= MIN_MATCHES);
  const rows = [];
  for (const key of Object.keys(me.metrics).sort()) {
    const m = me.metrics[key];
    const base = { key, label: m.label ?? nice(key), unit: m.unit, direction: m.direction, evidence, mine: round(m.value), coverage: { recorded: m.n, total: m.total } };
    if (key !== 'matches' && m.n < MIN_MATCHES) { rows.push({ ...base, status: 'insufficient_data', note: `Recorded in only ${m.n} of ${m.total}; ${MIN_MATCHES} are needed` }); continue; }
    const vals = others.map((p) => p.metrics[key]).filter((x) => x && (key === 'matches' || x.n >= MIN_MATCHES)).map((x) => x.value);
    if (vals.length < MIN_COHORT) { rows.push({ ...base, status: 'cohort_too_small', note: `Only ${vals.length} comparable players; ${MIN_COHORT} are needed` }); continue; }
    const row = { ...base, cohort_avg: round(vals.reduce((a, b) => a + b, 0) / vals.length), cohort_median: round(median(vals)), n: vals.length };
    rows.push(m.direction === 'unknown'
      ? { ...row, status: 'unranked_direction', note: 'No ranking: it is not defined whether more or less is better' }
      : { ...row, status: 'ranked', percentile: percentileDirected(m.value, vals, m.direction) });
  }
  const available = others.length >= MIN_COHORT;
  return { available, size: others.length, comparisons: available ? rows : [], all: rows };
}

/** Self-ratings only, over the matches the player rated. Never mixed with coach or peer judgements, which this module does not read. */
export function selfRatingTrend(ratings) {
  const part = (xs) => ({ n: xs.length, avg: xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length, 1) : null });
  const recent = part(ratings.slice(0, 5)), previous = part(ratings.slice(5, 10));
  const sufficient = recent.n >= MIN_MATCHES && previous.n >= MIN_MATCHES;
  const change = sufficient ? round(recent.avg - previous.avg, 1) : null;
  return {
    source: 'self', label: 'Your own ratings of your matches, not peer or coach ratings', rated_matches: ratings.length, recent, previous, sufficient, change,
    trend: change === null ? null : change > 0 ? 'up' : change < 0 ? 'down' : 'flat',
  };
}
