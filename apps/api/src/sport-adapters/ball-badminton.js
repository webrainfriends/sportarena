// Ball badminton performance analytics adapter.
// Covers ball-badminton (a distinct South Asian racket sport using a woollen ball, not a shuttlecock).
// Reuses the racket-sport evidence model (approved_competition / self_reported).
// Match/set win rates + side splits (outdoor/indoor) + surface splits.
// Evidence tracks always separate.

export const CALC_VERSION = 'ball_badminton_v1';
const MIN_MATCHES = 5;
const MIN_SPLIT = 3;

const NUM = (obj, k) => { const v = obj?.[k]; return v === null || v === undefined ? null : Number(v); };
const round2 = (n) => Math.round(n * 100) / 100;

const METRIC_DEFS = {
  smashes:            { direction: 'higher', unit: '', definition: 'Winning smash shots' },
  drop_shots:         { direction: 'higher', unit: '', definition: 'Winning drop shots' },
  service_errors:     { direction: 'lower',  unit: '', definition: 'Service errors (direct faults)' },
  aces:               { direction: 'higher', unit: '', definition: 'Service aces (direct point from serve)' },
  unforced_errors:    { direction: 'lower',  unit: '', definition: 'Unforced errors' },
  winners:            { direction: 'higher', unit: '', definition: 'Outright winners (all types)' },
};

function extractStats(stats) {
  const out = {};
  for (const key of Object.keys(METRIC_DEFS)) {
    const v = NUM(stats, key);
    if (v !== null) out[key] = v;
  }
  return out;
}

function aggregate(rows) {
  const totals = {}, counts = {};
  for (const row of rows) {
    const m = extractStats(row.stats ?? row.stats_snapshot ?? {});
    for (const [k, v] of Object.entries(m)) {
      totals[k] = (totals[k] ?? 0) + v;
      counts[k] = (counts[k] ?? 0) + 1;
    }
  }
  return { totals, counts, matches: rows.length };
}

function matchWinRate(rows) {
  const decided = rows.filter((r) => r.result && r.result !== 'unknown');
  const wins = decided.filter((r) => r.result === 'win').length;
  return { total: rows.length, decided: decided.length, wins, win_rate: decided.length ? Math.round((wins / decided.length) * 1000) / 10 : null };
}

function setWinRate(rows) {
  const withSets = rows.filter((r) => r.sets_won !== null && r.sets_lost !== null);
  const totalWon = withSets.reduce((s, r) => s + (NUM(r, 'sets_won') || 0), 0);
  const totalLost = withSets.reduce((s, r) => s + (NUM(r, 'sets_lost') || 0), 0);
  const total = totalWon + totalLost;
  return { sets_won: totalWon, sets_lost: totalLost, set_win_rate: total ? Math.round((totalWon / total) * 1000) / 10 : null };
}

function buildTrack(rows, evid, limitations) {
  if (!rows.length) return null;
  if (rows.length < MIN_MATCHES) {
    limitations.push(`${evid}: only ${rows.length} match${rows.length === 1 ? '' : 'es'} — ${MIN_MATCHES} needed for reliable statistics`);
  }
  const agg = aggregate(rows);
  const metrics = {};
  for (const [k, total] of Object.entries(agg.totals)) {
    const def = METRIC_DEFS[k] ?? { direction: 'higher', unit: '', definition: k };
    metrics[k] = { value: total, per_match: round2(total / agg.matches), sample_size: agg.counts[k], ...def };
  }
  // Surface/format splits
  const bySurface = {};
  for (const r of rows) {
    const s = (r.surface ?? r.format ?? 'unknown').toLowerCase();
    if (!bySurface[s]) bySurface[s] = [];
    bySurface[s].push(r);
  }
  const surface_splits = Object.fromEntries(
    Object.entries(bySurface)
      .filter(([, rs]) => rs.length >= MIN_SPLIT)
      .map(([s, rs]) => [s, { matches: rs.length, ...matchWinRate(rs), ...setWinRate(rs) }])
  );
  return {
    evidence: evid,
    matches: agg.matches,
    match_win_rate: { ...matchWinRate(rows), direction: 'higher', unit: '%', definition: 'Matches won as a percentage of decided matches' },
    set_win_rate: { ...setWinRate(rows), direction: 'higher', unit: '%', definition: 'Sets won as a percentage of total sets played' },
    metrics: Object.keys(metrics).length ? metrics : null,
    surface_splits: Object.keys(surface_splits).length ? surface_splits : null,
    insufficient: rows.length < MIN_MATCHES,
  };
}

export async function compute(db, userId, { sportId, evidence = 'approved_competition', from = null, to = null }) {
  const limitations = [];

  async function loadOfficial() {
    const rows = await db.query(
      `SELECT gp.stats, g.starts_at::date AS played_on,
              CASE c.outcome WHEN 'win' THEN 'win' WHEN 'loss' THEN 'loss' WHEN 'tie' THEN 'draw' ELSE NULL END AS result,
              (gp.stats->>'sets_won')::float AS sets_won, (gp.stats->>'sets_lost')::float AS sets_lost,
              coalesce(gp.stats->>'surface', gp.stats->>'format') AS surface
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
              m.result, m.match_type AS format,
              (m.stats_snapshot->>'sets_won')::float AS sets_won,
              (m.stats_snapshot->>'sets_lost')::float AS sets_lost,
              coalesce(m.stats_snapshot->>'surface', m.match_type) AS surface
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
    else limitations.push('Self-reported track: no self-logged match data in this period');
  }

  return { sport: 'ball-badminton', calc_version: CALC_VERSION, period: { from, to }, tracks, limitations };
}
