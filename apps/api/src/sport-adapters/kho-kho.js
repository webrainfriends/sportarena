// Kho-kho performance analytics adapter.
// Covers kho-kho (Indian tag sport played in two innings: chasing and defending).
// Two discipline roles tracked: chaser (attacker) and defender (runner).
// Evidence tracks always separate.

export const CALC_VERSION = 'kho_kho_v1';
const MIN_MATCHES = 3;

const NUM = (obj, k) => { const v = obj?.[k]; return v === null || v === undefined ? null : Number(v); };
const round2 = (n) => Math.round(n * 100) / 100;

// Chaser metrics
const CHASER_METRICS = {
  touches:              { direction: 'higher', unit: '', definition: 'Opponents tagged/touched out during chasing innings' },
  chasing_innings:      { direction: 'higher', unit: '', definition: 'Chasing innings played' },
  touch_rate:           { direction: 'higher', unit: '', definition: 'Touches per chasing inning' },
  khos_given:           { direction: 'higher', unit: '', definition: 'Valid kho passes given to teammates' },
};

// Defender metrics
const DEFENDER_METRICS = {
  survival_time_s:      { direction: 'higher', unit: 's', definition: 'Total time survived as a runner (seconds)' },
  times_out:            { direction: 'lower',  unit: '', definition: 'Number of times tagged/put out as a runner' },
  avg_survival_s:       { direction: 'higher', unit: 's', definition: 'Average survival time per turn as a runner' },
};

function extractStats(stats, defs) {
  const out = {};
  for (const key of Object.keys(defs)) {
    const v = NUM(stats, key);
    if (v !== null) out[key] = v;
  }
  return out;
}

function aggregate(rows, defs) {
  const totals = {}, counts = {};
  for (const row of rows) {
    const m = extractStats(row.stats ?? row.stats_snapshot ?? {}, defs);
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

function buildSection(agg, defs) {
  const out = {};
  for (const [k, total] of Object.entries(agg.totals)) {
    const def = defs[k] ?? { direction: 'higher', unit: '', definition: k };
    out[k] = { value: total, per_match: round2(total / agg.matches), sample_size: agg.counts[k], ...def };
  }
  return Object.keys(out).length ? out : null;
}

function buildTrack(rows, evid, limitations) {
  if (!rows.length) return null;
  if (rows.length < MIN_MATCHES) {
    limitations.push(`${evid}: only ${rows.length} match${rows.length === 1 ? '' : 'es'} — ${MIN_MATCHES} needed`);
  }
  return {
    evidence: evid,
    matches: rows.length,
    match_win_rate: { ...matchWinRate(rows), direction: 'higher', unit: '%', definition: 'Matches won as a percentage of decided matches' },
    chaser_metrics: buildSection(aggregate(rows, CHASER_METRICS), CHASER_METRICS),
    defender_metrics: buildSection(aggregate(rows, DEFENDER_METRICS), DEFENDER_METRICS),
    insufficient: rows.length < MIN_MATCHES,
  };
}

export async function compute(db, userId, { sportId, evidence = 'approved_competition', from = null, to = null }) {
  const limitations = [];

  async function loadOfficial() {
    const rows = await db.query(
      `SELECT gp.stats, g.starts_at::date AS played_on,
              CASE c.outcome WHEN 'win' THEN 'win' WHEN 'loss' THEN 'loss' WHEN 'tie' THEN 'draw' ELSE NULL END AS result
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
      `SELECT m.stats_snapshot AS stats, coalesce(m.played_on, m.created_at::date) AS played_on, m.result
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

  return { sport: 'kho-kho', calc_version: CALC_VERSION, period: { from, to }, tracks, limitations };
}
