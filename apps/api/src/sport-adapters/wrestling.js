// Wrestling performance analytics adapter.
// Covers wrestling (freestyle, Greco-Roman, folkstyle).
// UWW scoring: pin/fall, technical fall (10+ point lead), decision (points), major decision.
// Points breakdown: takedowns (2), escapes (1), reversals (2), near-fall (2 or 3).
// Evidence tracks always separate.

export const CALC_VERSION = 'wrestling_v1';
const MIN_BOUTS = 3;

const NUM = (obj, k) => { const v = obj?.[k]; return v === null || v === undefined ? null : Number(v); };
const round2 = (n) => Math.round(n * 100) / 100;

const BOUT_METRICS = {
  takedowns:          { direction: 'higher', unit: '', definition: 'Takedowns scored (2 pts each)' },
  escapes:            { direction: 'higher', unit: '', definition: 'Escapes from bottom position (1 pt each)' },
  reversals:          { direction: 'higher', unit: '', definition: 'Reversals (gaining top from bottom, 2 pts each)' },
  near_fall_points:   { direction: 'higher', unit: '', definition: 'Near-fall points (2 or 3 pts for back exposure)' },
  total_points:       { direction: 'higher', unit: '', definition: 'Total competition points scored in the period' },
  penalty_points:     { direction: 'lower',  unit: '', definition: 'Penalty points conceded (cautions, stalling, illegal holds)' },
  cautions:           { direction: 'lower',  unit: '', definition: 'Cautions received' },
};

function matchWinRate(rows) {
  const decided = rows.filter((r) => r.result && r.result !== 'unknown');
  const wins = decided.filter((r) => r.result === 'win').length;
  return { total: rows.length, decided: decided.length, wins, win_rate: decided.length ? Math.round((wins / decided.length) * 1000) / 10 : null };
}

function winMethodBreakdown(rows) {
  const methods = {};
  for (const r of rows) {
    if (r.result !== 'win') continue;
    const m = (r.win_method ?? 'unknown').toLowerCase().replace(/\s+/g, '_');
    methods[m] = (methods[m] ?? 0) + 1;
  }
  return Object.keys(methods).length ? methods : null;
}

function aggregate(rows) {
  const totals = {}, counts = {};
  for (const row of rows) {
    const stats = row.stats ?? row.stats_snapshot ?? {};
    for (const key of Object.keys(BOUT_METRICS)) {
      const v = NUM(stats, key);
      if (v !== null) {
        totals[key] = (totals[key] ?? 0) + v;
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
  }
  return { totals, counts };
}

// Style splits (freestyle / greco-roman / folkstyle)
function styleSplits(rows) {
  const byStyle = {};
  for (const r of rows) {
    const s = (r.style ?? 'unknown').toLowerCase().replace(/[^a-z-]/g, '');
    if (!byStyle[s]) byStyle[s] = [];
    byStyle[s].push(r);
  }
  return Object.fromEntries(
    Object.entries(byStyle)
      .filter(([, rs]) => rs.length >= 2)
      .map(([s, rs]) => [s, { bouts: rs.length, ...matchWinRate(rs) }])
  );
}

function buildTrack(rows, evid, limitations) {
  if (!rows.length) return null;
  if (rows.length < MIN_BOUTS) {
    limitations.push(`${evid}: only ${rows.length} bout${rows.length === 1 ? '' : 's'} — ${MIN_BOUTS} needed`);
  }
  const agg = aggregate(rows);
  const metrics = {};
  for (const [k, total] of Object.entries(agg.totals)) {
    const def = BOUT_METRICS[k] ?? { direction: 'higher', unit: '', definition: k };
    metrics[k] = { value: total, per_bout: round2(total / rows.length), sample_size: agg.counts[k], ...def };
  }
  const splits = styleSplits(rows);
  return {
    evidence: evid,
    bouts: rows.length,
    win_rate: { ...matchWinRate(rows), direction: 'higher', unit: '%', definition: 'Bouts won as a percentage of decided bouts' },
    win_methods: winMethodBreakdown(rows),
    metrics: Object.keys(metrics).length ? metrics : null,
    style_splits: Object.keys(splits).length ? splits : null,
    insufficient: rows.length < MIN_BOUTS,
  };
}

export async function compute(db, userId, { sportId, evidence = 'approved_competition', from = null, to = null }) {
  const limitations = [];

  async function loadOfficial() {
    const rows = await db.query(
      `SELECT gp.stats, g.starts_at::date AS played_on,
              CASE c.outcome WHEN 'win' THEN 'win' WHEN 'loss' THEN 'loss' ELSE 'unknown' END AS result,
              coalesce(gp.stats->>'win_method', gp.stats->>'result_method') AS win_method,
              coalesce(gp.stats->>'style', gp.stats->>'format') AS style
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
      `SELECT m.stats_snapshot AS stats, coalesce(m.played_on, m.created_at::date) AS played_on,
              m.result,
              coalesce(m.stats_snapshot->>'win_method', m.stats_snapshot->>'result_method') AS win_method,
              coalesce(m.stats_snapshot->>'style', m.match_type) AS style
         FROM player_matches m
         JOIN sport_profiles sp ON sp.id = m.sport_profile_id
        WHERE sp.user_id = $1 AND sp.sport_id = $2 AND m.archived_at IS NULL
          AND ($3::date IS NULL OR coalesce(m.played_on, m.created_at::date) >= $3)
          AND ($4::date IS NULL OR coalesce(m.played_on, m.created_at::date) <= $4)`,
      [userId, sportId, from, to]);
    return rows.rows;
  }

  const tracks = {};
  if (evidence === 'approved_competition' || evidence === 'combined') {
    const rows = await loadOfficial();
    const t = buildTrack(rows, 'approved_competition', limitations);
    if (t) tracks.approved_competition = t;
    else limitations.push('Official track: no approved competition data in this period');
  }
  if (evidence === 'self_reported' || evidence === 'combined') {
    const rows = await loadSelf();
    const t = buildTrack(rows, 'self_reported', limitations);
    if (t) tracks.self_reported = t;
    else limitations.push('Self-reported track: no self-logged bout data in this period');
  }

  return { sport: 'wrestling', calc_version: CALC_VERSION, period: { from, to }, tracks, limitations };
}
