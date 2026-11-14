// Chess performance analytics adapter.
// Covers chess, speed-chess, chess960.
// Chess is fundamentally rating-based. Analytics centre on rating progression
// (ELO/FIDE/rapid/blitz) stored in the performances table, plus win/draw/loss breakdown.
// Direction: all rating metrics = higher is better. Rating aggregation = 'last' (most recent).
// Falls back to match result analysis when no rating data exists.

export const CALC_VERSION = 'chess_v1';
const MIN_RATING_POINTS = 3;
const MIN_GAMES = 5;

const round2 = (n) => Math.round(n * 100) / 100;

const RATING_METRICS = ['elo_rating', 'fide_rating', 'rapid_rating', 'blitz_rating', 'bullet_rating', 'classical_rating', 'online_rating'];

// Time controls that map to known formats
const TIME_CONTROLS = {
  bullet: ['bullet', 'ultrabullet', '1+0', '2+1'],
  blitz:  ['blitz', '3+0', '3+2', '5+0', '5+3'],
  rapid:  ['rapid', '10+0', '15+10', '25+0'],
  classical: ['classical', 'standard', 'slow', '90+30'],
};
function timeControl(format) {
  if (!format) return 'unknown';
  const s = String(format).toLowerCase();
  for (const [tc, aliases] of Object.entries(TIME_CONTROLS)) if (aliases.some((a) => s.includes(a))) return tc;
  return 'unknown';
}

function progression(points) {
  if (points.length < 2) return null;
  const first = points[0].value, last = points[points.length - 1].value;
  const delta = round2(last - first);
  return { from: first, to: last, delta, improving: delta > 0, over_points: points.length };
}

function variance(values) {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const std = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1));
  return { mean: round2(mean), std_dev: round2(std) };
}

function buildResultStats(games) {
  if (!games.length) return null;
  const decided = games.filter((g) => g.result && !['unknown', 'forfeit'].includes(g.result));
  const wins = decided.filter((g) => g.result === 'win').length;
  const draws = decided.filter((g) => g.result === 'draw').length;
  const losses = decided.filter((g) => g.result === 'loss').length;
  const total = decided.length;
  return {
    games: games.length, decided: total,
    wins, draws, losses,
    win_rate: total ? round2((wins / total) * 100) : null,
    draw_rate: total ? round2((draws / total) * 100) : null,
    loss_rate: total ? round2((losses / total) * 100) : null,
    score_pct: total ? round2(((wins + draws * 0.5) / total) * 100) : null,
  };
}

export async function compute(db, userId, { sportId, evidence = 'approved_competition', from = null, to = null }) {
  const limitations = [];

  const VALID_OFFICIAL = `(p.provenance='approved_competition' AND p.status='approved')`;
  const VALID_SELF = `(p.provenance IN ('self_reported','imported') AND p.status='recorded')`;
  const VALID = evidence === 'approved_competition' ? VALID_OFFICIAL : evidence === 'self_reported' ? VALID_SELF : `(${VALID_OFFICIAL} OR ${VALID_SELF})`;

  // Rating data from performances table
  const ratingRows = await db.query(
    `SELECT p.metric, p.provenance, p.value::float8 AS value,
            to_char(coalesce(p.achieved_on, p.recorded_at::date),'YYYY-MM-DD') AS on_date
       FROM performances p
      WHERE p.user_id=$1 AND p.sport_id=$2 AND p.metric = ANY($5::text[]) AND ${VALID}
        AND ($3::date IS NULL OR coalesce(p.achieved_on, p.recorded_at::date) >= $3)
        AND ($4::date IS NULL OR coalesce(p.achieved_on, p.recorded_at::date) <= $4)
      ORDER BY p.metric, coalesce(p.achieved_on, p.recorded_at::date), p.recorded_at`,
    [userId, sportId, from, to, RATING_METRICS]);

  // Game results (win/draw/loss) from official + self-reported
  async function loadOfficial() {
    const rows = await db.query(
      `SELECT CASE c.outcome WHEN 'win' THEN 'win' WHEN 'loss' THEN 'loss' WHEN 'tie' THEN 'draw' ELSE 'unknown' END AS result,
              g.starts_at::date AS played_on,
              coalesce(gp.stats->>'time_control', gp.stats->>'format') AS format
         FROM game_participants gp
         JOIN games g ON g.id = gp.game_id
         JOIN game_participants c ON c.game_id = g.id AND c.user_id = $1
        WHERE gp.user_id = $1 AND g.sport_id = $2 AND g.status = 'post-event'
          AND ($3::date IS NULL OR g.starts_at::date >= $3)
          AND ($4::date IS NULL OR g.starts_at::date <= $4)`,
      [userId, sportId, from, to]);
    return rows.rows;
  }

  async function loadSelf() {
    const rows = await db.query(
      `SELECT m.result, coalesce(m.played_on, m.created_at::date) AS played_on,
              coalesce(m.match_type, m.stats_snapshot->>'time_control') AS format
         FROM player_matches m
         JOIN sport_profiles sp ON sp.id = m.sport_profile_id
        WHERE sp.user_id = $1 AND sp.sport_id = $2 AND m.archived_at IS NULL
          AND ($3::date IS NULL OR coalesce(m.played_on, m.created_at::date) >= $3)
          AND ($4::date IS NULL OR coalesce(m.played_on, m.created_at::date) <= $4)`,
      [userId, sportId, from, to]);
    return rows.rows;
  }

  // Group rating data by metric + evidence track
  const byRatingMetric = new Map();
  for (const r of ratingRows.rows) {
    const key = `${r.metric}:${r.provenance}`;
    if (!byRatingMetric.has(key)) byRatingMetric.set(key, { metric: r.metric, provenance: r.provenance, points: [] });
    byRatingMetric.get(key).points.push({ value: r.value, on: r.on_date });
  }

  const ratings = [];
  for (const [, m] of byRatingMetric) {
    const vals = m.points.map((p) => p.value);
    const peak = Math.max(...vals);
    const current = vals[vals.length - 1];
    const peakIdx = vals.indexOf(peak);
    const pointsAnnotated = m.points.map((p, i) => ({ ...p, evidence: m.provenance, is_pb: i === peakIdx }));
    if (m.points.length < MIN_RATING_POINTS) {
      ratings.push({ metric: m.metric, evidence: m.provenance, insufficient: true, points: m.points.length, min_required: MIN_RATING_POINTS });
      continue;
    }
    ratings.push({
      metric: m.metric,
      metric_label: m.metric.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      evidence: m.provenance,
      direction: 'higher',
      current_rating: { value: current, on: m.points[m.points.length - 1].on },
      peak_rating: { value: peak, on: m.points[peakIdx].on },
      progression: progression(m.points),
      variance: variance(vals),
      points: pointsAnnotated,
      definition: 'Chess rating (ELO-based); higher = stronger player',
      insufficient: false,
    });
  }

  if (!ratings.length) limitations.push('No rating data found — ensure ELO/FIDE rating results are logged in performances with metric keys elo_rating, fide_rating, rapid_rating, blitz_rating, or bullet_rating');

  const tracks = {};

  if (evidence === 'approved_competition' || evidence === 'combined') {
    const official = await loadOfficial();
    if (!official.length) {
      limitations.push('Official track: no approved competition results in this period');
    } else {
      if (official.length < MIN_GAMES) limitations.push(`Official track: only ${official.length} game${official.length === 1 ? '' : 's'} — ${MIN_GAMES} recommended for reliable statistics`);
      const results = buildResultStats(official);
      const tcSplits = {};
      for (const g of official) {
        const tc = timeControl(g.format);
        if (!tcSplits[tc]) tcSplits[tc] = [];
        tcSplits[tc].push(g);
      }
      const time_control_splits = Object.fromEntries(
        Object.entries(tcSplits)
          .filter(([, gs]) => gs.length >= 3)
          .map(([tc, gs]) => [tc, buildResultStats(gs)])
      );
      tracks.approved_competition = { evidence: 'approved_competition', ...results, time_control_splits: Object.keys(time_control_splits).length ? time_control_splits : null };
    }
  }
  if (evidence === 'self_reported' || evidence === 'combined') {
    const self = await loadSelf();
    if (!self.length) {
      limitations.push('Self-reported track: no self-logged game results in this period');
    } else {
      if (self.length < MIN_GAMES) limitations.push(`Self-reported track: only ${self.length} game${self.length === 1 ? '' : 's'} — ${MIN_GAMES} recommended`);
      const results = buildResultStats(self);
      const tcSplits = {};
      for (const g of self) {
        const tc = timeControl(g.format);
        if (!tcSplits[tc]) tcSplits[tc] = [];
        tcSplits[tc].push(g);
      }
      const time_control_splits = Object.fromEntries(
        Object.entries(tcSplits)
          .filter(([, gs]) => gs.length >= 3)
          .map(([tc, gs]) => [tc, buildResultStats(gs)])
      );
      tracks.self_reported = { evidence: 'self_reported', ...results, time_control_splits: Object.keys(time_control_splits).length ? time_control_splits : null };
    }
  }

  return {
    sport: 'chess',
    calc_version: CALC_VERSION,
    period: { from, to },
    ratings,
    tracks,
    limitations,
  };
}
