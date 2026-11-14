// Golf performance analytics adapter.
// Covers golf, disc-golf.
// Lower is always better for stroke/score metrics. Direction read from metric_definitions where available,
// but stroke-play metrics always default to 'lower' — never inferred from key name.
// Official competition: game_participants WHERE score_units='against-par' + stats JSONB.
// Self-reported: player_matches.stats_snapshot + performances table rows.
// Min 3 rounds before computing averages.

export const CALC_VERSION = 'golf_v1';
const MIN_ROUNDS = 3;

const NUM = (obj, k) => { const v = obj?.[k]; return v === null || v === undefined ? null : Number(v); };
const round2 = (n) => Math.round(n * 100) / 100;

// Stroke-play metrics are always direction: 'lower' (fewer strokes = better).
// Accuracy metrics (GIR, fairways) are direction: 'higher'.
const STROKE_METRICS = {
  gross_score:        { direction: 'lower',  unit: 'strokes', definition: 'Total strokes for the round (gross)' },
  net_score:          { direction: 'lower',  unit: 'strokes', definition: 'Net score after handicap allowance' },
  putts_per_round:    { direction: 'lower',  unit: 'putts',   definition: 'Total putts taken in the round' },
  score_to_par:       { direction: 'lower',  unit: 'strokes', definition: 'Score relative to par (negative = under par)' },
};
const ACCURACY_METRICS = {
  gir_pct:            { direction: 'higher', unit: '%',       definition: 'Greens in regulation: holes where the green was reached in the target number of strokes' },
  fairways_hit_pct:   { direction: 'higher', unit: '%',       definition: 'Fairways hit off the tee on par-4 and par-5 holes' },
};
const SCORING_BREAKDOWN_KEYS = ['eagles', 'birdies', 'pars', 'bogeys', 'double_bogeys', 'worse'];

function extractRoundStats(stats) {
  const out = { strokes: {}, accuracy: {}, breakdown: {} };
  for (const [k, def] of Object.entries(STROKE_METRICS)) {
    const v = NUM(stats, k) ?? (k === 'gross_score' ? NUM(stats, 'strokes') : null);
    if (v !== null) out.strokes[k] = { value: v, ...def };
  }
  for (const [k, def] of Object.entries(ACCURACY_METRICS)) {
    const v = NUM(stats, k);
    if (v !== null) out.accuracy[k] = { value: v, ...def };
  }
  for (const k of SCORING_BREAKDOWN_KEYS) {
    const v = NUM(stats, k);
    if (v !== null) out.breakdown[k] = v;
  }
  return out;
}

function buildTrack(rounds, evid, limitations) {
  if (!rounds.length) return null;
  if (rounds.length < MIN_ROUNDS) {
    limitations.push(`${evid}: only ${rounds.length} round${rounds.length === 1 ? '' : 's'} — ${MIN_ROUNDS} needed for meaningful averages`);
  }

  const grossScores = rounds.map((r) => r.gross_score).filter((v) => v !== null);
  const netScores = rounds.map((r) => r.net_score).filter((v) => v !== null);
  const puttCounts = rounds.map((r) => r.putts_per_round).filter((v) => v !== null);
  const girValues = rounds.map((r) => r.gir_pct).filter((v) => v !== null);
  const fairwayValues = rounds.map((r) => r.fairways_hit_pct).filter((v) => v !== null);

  const best_round = grossScores.length ? Math.min(...grossScores) : null;
  const scoring_average = grossScores.length ? round2(grossScores.reduce((a, b) => a + b, 0) / grossScores.length) : null;

  // Handicap index: most recent value (from stats JSONB or separate performances row)
  const handicaps = rounds.map((r) => r.handicap_index).filter((v) => v !== null);
  const current_handicap = handicaps.length ? handicaps[handicaps.length - 1] : null;
  const best_handicap = handicaps.length ? Math.min(...handicaps) : null;

  // Scoring breakdown totals
  const breakdown = {};
  for (const k of SCORING_BREAKDOWN_KEYS) {
    const total = rounds.reduce((s, r) => s + (r.breakdown?.[k] ?? 0), 0);
    if (total > 0) breakdown[k] = total;
  }

  // Course splits (min 3 rounds on the same course)
  const byCourse = {};
  for (const r of rounds) {
    if (!r.course_name) continue;
    const c = r.course_name;
    if (!byCourse[c]) byCourse[c] = [];
    byCourse[c].push(r.gross_score);
  }
  const course_splits = Object.fromEntries(
    Object.entries(byCourse)
      .filter(([, scores]) => scores.filter((v) => v !== null).length >= 3)
      .map(([course, scores]) => {
        const valid = scores.filter((v) => v !== null);
        return [course, { rounds: valid.length, best: Math.min(...valid), average: round2(valid.reduce((a, b) => a + b, 0) / valid.length) }];
      })
  );

  return {
    evidence: evid,
    rounds: rounds.length,
    best_round: best_round !== null ? { value: best_round, unit: 'strokes', direction: 'lower', definition: 'Lowest gross score in the period' } : null,
    scoring_average: scoring_average !== null ? { value: scoring_average, unit: 'strokes', direction: 'lower', definition: 'Mean gross score per round', sample_size: grossScores.length } : null,
    net_scoring_average: netScores.length ? { value: round2(netScores.reduce((a, b) => a + b, 0) / netScores.length), unit: 'strokes', direction: 'lower', definition: 'Mean net score per round', sample_size: netScores.length } : null,
    putts_per_round: puttCounts.length ? { value: round2(puttCounts.reduce((a, b) => a + b, 0) / puttCounts.length), unit: 'putts', direction: 'lower', definition: 'Average putts per round', sample_size: puttCounts.length } : null,
    gir_pct: girValues.length ? { value: round2(girValues.reduce((a, b) => a + b, 0) / girValues.length), unit: '%', direction: 'higher', definition: 'Greens in regulation percentage', sample_size: girValues.length } : null,
    fairways_hit_pct: fairwayValues.length ? { value: round2(fairwayValues.reduce((a, b) => a + b, 0) / fairwayValues.length), unit: '%', direction: 'higher', definition: 'Fairways hit percentage', sample_size: fairwayValues.length } : null,
    handicap: handicaps.length ? { current: current_handicap, best: best_handicap, direction: 'lower', definition: 'Handicap index (lower = better scratch performance)', sample_size: handicaps.length } : null,
    scoring_breakdown: Object.keys(breakdown).length ? breakdown : null,
    course_splits: Object.keys(course_splits).length ? course_splits : null,
    insufficient: rounds.length < MIN_ROUNDS,
  };
}

export async function compute(db, userId, { sportId, evidence = 'approved_competition', from = null, to = null }) {
  const limitations = [];

  async function loadOfficial() {
    // Official competition: game_participants with score_units='against-par' (stroke play rounds)
    const rows = await db.query(
      `SELECT gp.stats,
              g.starts_at::date AS played_on,
              gp.score::float AS score_to_par,
              (gp.stats->>'gross_score')::float AS gross_score,
              (gp.stats->>'net_score')::float AS net_score,
              (gp.stats->>'putts_per_round')::float AS putts_per_round,
              (gp.stats->>'gir_pct')::float AS gir_pct,
              (gp.stats->>'fairways_hit_pct')::float AS fairways_hit_pct,
              (gp.stats->>'handicap_index')::float AS handicap_index,
              gp.stats->>'course_name' AS course_name
         FROM game_participants gp
         JOIN games g ON g.id = gp.game_id
        WHERE gp.user_id = $1 AND g.sport_id = $2 AND g.status = 'post-event'
          AND gp.score_units = 'against-par'
          AND ($3::date IS NULL OR g.starts_at::date >= $3)
          AND ($4::date IS NULL OR g.starts_at::date <= $4)
        ORDER BY g.starts_at`,
      [userId, sportId, from, to]);
    return rows.rows.map((r) => ({
      ...r,
      breakdown: {
        eagles: NUM(r.stats, 'eagles'), birdies: NUM(r.stats, 'birdies'), pars: NUM(r.stats, 'pars'),
        bogeys: NUM(r.stats, 'bogeys'), double_bogeys: NUM(r.stats, 'double_bogeys'), worse: NUM(r.stats, 'worse'),
      },
    }));
  }

  async function loadSelf() {
    const rows = await db.query(
      `SELECT m.stats_snapshot AS stats,
              coalesce(m.played_on, m.created_at::date) AS played_on,
              (m.stats_snapshot->>'gross_score')::float AS gross_score,
              (m.stats_snapshot->>'net_score')::float AS net_score,
              (m.stats_snapshot->>'putts_per_round')::float AS putts_per_round,
              (m.stats_snapshot->>'gir_pct')::float AS gir_pct,
              (m.stats_snapshot->>'fairways_hit_pct')::float AS fairways_hit_pct,
              (m.stats_snapshot->>'handicap_index')::float AS handicap_index,
              m.stats_snapshot->>'course_name' AS course_name
         FROM player_matches m
         JOIN sport_profiles sp ON sp.id = m.sport_profile_id
        WHERE sp.user_id = $1 AND sp.sport_id = $2 AND m.archived_at IS NULL
          AND ($3::date IS NULL OR coalesce(m.played_on, m.created_at::date) >= $3)
          AND ($4::date IS NULL OR coalesce(m.played_on, m.created_at::date) <= $4)
        ORDER BY coalesce(m.played_on, m.created_at::date)`,
      [userId, sportId, from, to]);
    return rows.rows.map((r) => ({
      ...r,
      breakdown: {
        eagles: NUM(r.stats, 'eagles'), birdies: NUM(r.stats, 'birdies'), pars: NUM(r.stats, 'pars'),
        bogeys: NUM(r.stats, 'bogeys'), double_bogeys: NUM(r.stats, 'double_bogeys'), worse: NUM(r.stats, 'worse'),
      },
    }));
  }

  const tracks = {};
  if (evidence === 'approved_competition' || evidence === 'combined') {
    const rows = await loadOfficial();
    const t = buildTrack(rows, 'approved_competition', limitations);
    if (t) tracks.approved_competition = t;
    else limitations.push('Official track: no approved competition round data in this period');
  }
  if (evidence === 'self_reported' || evidence === 'combined') {
    const rows = await loadSelf();
    const t = buildTrack(rows, 'self_reported', limitations);
    if (t) tracks.self_reported = t;
    else limitations.push('Self-reported track: no self-logged round data in this period');
  }

  return {
    sport: 'golf',
    calc_version: CALC_VERSION,
    period: { from, to },
    tracks,
    limitations,
    note: 'All stroke and score metrics: lower is better. Accuracy metrics (GIR, fairways): higher is better.',
  };
}
