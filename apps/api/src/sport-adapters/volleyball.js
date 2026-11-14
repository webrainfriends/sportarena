// Volleyball performance analytics adapter.
// Covers volleyball, beach-volleyball, sitting-volleyball.
// FIVB-standard metrics: kills/aces/digs/blocks/reception. Evidence tracks always separate.
// Direction: kills/aces/digs/blocks/reception_pct = higher; errors = lower.

export const CALC_VERSION = 'volleyball_v1';
const MIN_MATCHES = 5;
const MIN_SPLIT = 5;

const NUM = (obj, k) => { const v = obj?.[k]; return v === null || v === undefined ? null : Number(v); };

const METRIC_DEFS = {
  kills:              { direction: 'higher', unit: '', definition: 'Attack points (kill shots)' },
  kill_pct:           { direction: 'higher', unit: '%', definition: 'Kills as a percentage of total attack attempts' },
  attack_errors:      { direction: 'lower',  unit: '', definition: 'Attack errors (direct faults on attack)' },
  aces:               { direction: 'higher', unit: '', definition: 'Service aces (direct point from serve)' },
  service_errors:     { direction: 'lower',  unit: '', definition: 'Service errors (faults or out on serve)' },
  digs:               { direction: 'higher', unit: '', definition: 'Defensive digs (successful floor defence)' },
  blocks:             { direction: 'higher', unit: '', definition: 'Block points (direct block touches scoring a point)' },
  block_errors:       { direction: 'lower',  unit: '', definition: 'Block errors (faults on blocking)' },
  reception_errors:   { direction: 'lower',  unit: '', definition: 'Reception errors (direct fault on first contact)' },
  reception_pct:      { direction: 'higher', unit: '%', definition: 'Reception efficiency: positive/perfect receptions as a percentage of attempts' },
  setting_efficiency: { direction: 'higher', unit: '%', definition: 'Setting efficiency (assists / set attempts, when captured)' },
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

function perMatch(total, matches) {
  return matches > 0 ? Math.round((total / matches) * 100) / 100 : null;
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
  return { sets_won: totalWon, sets_lost: totalLost, set_win_rate: total ? Math.round((totalWon / total) * 1000) / 10 : null, sample_size: withSets.length };
}

function formatSplits(rows) {
  const byFormat = {};
  for (const r of rows) {
    const f = (r.format ?? 'indoor').toLowerCase();
    if (!byFormat[f]) byFormat[f] = [];
    byFormat[f].push(r);
  }
  return Object.fromEntries(
    Object.entries(byFormat)
      .filter(([, rs]) => rs.length >= MIN_SPLIT)
      .map(([f, rs]) => [f, { matches: rs.length, ...matchWinRate(rs), ...setWinRate(rs) }])
  );
}

function buildTrack(rows, evid, limitations) {
  if (!rows.length) return null;
  if (rows.length < MIN_MATCHES) {
    limitations.push(`${evid}: only ${rows.length} match${rows.length === 1 ? '' : 'es'} — ${MIN_MATCHES} needed for reliable per-match rates`);
  }
  const agg = aggregate(rows);
  const metrics = {};
  for (const [k, total] of Object.entries(agg.totals)) {
    const def = METRIC_DEFS[k] ?? { direction: 'higher', unit: '', definition: k };
    metrics[k] = { value: total, per_match: perMatch(total, agg.matches), sample_size: agg.counts[k], ...def };
  }
  const formats = formatSplits(rows);
  return {
    evidence: evid,
    matches: agg.matches,
    match_win_rate: { ...matchWinRate(rows), direction: 'higher', definition: 'Matches won as a percentage of decided matches', unit: '%' },
    set_win_rate: { ...setWinRate(rows), direction: 'higher', unit: '%', definition: 'Sets won as a percentage of total sets played' },
    metrics: Object.keys(metrics).length ? metrics : null,
    format_splits: Object.keys(formats).length ? formats : null,
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
              coalesce(gp.stats->>'format', 'indoor') AS format
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
              (m.stats_snapshot->>'sets_lost')::float AS sets_lost
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

  return {
    sport: 'volleyball',
    calc_version: CALC_VERSION,
    period: { from, to },
    tracks,
    limitations,
  };
}
