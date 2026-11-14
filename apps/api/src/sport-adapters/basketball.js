// Basketball performance analytics adapter.
// Covers basketball, 3x3-basketball, wheelchair-basketball.
// FIBA-standard metrics: points/rebounds/assists/steals/blocks/shooting percentages.
// Per-game rates computed from games played (not verified minutes — basketball doesn't use a per-90 concept).
// Evidence tracks always separate.

export const CALC_VERSION = 'basketball_v1';
const MIN_GAMES = 5;
const MIN_SPLIT = 5;

const NUM = (obj, k) => { const v = obj?.[k]; return v === null || v === undefined ? null : Number(v); };
const pct = (made, attempted) => (attempted > 0 ? Math.round((made / attempted) * 1000) / 10 : null);
const round2 = (n) => Math.round(n * 100) / 100;

const POSITION_GROUPS = {
  guard:   ['guard', 'pg', 'sg', 'point guard', 'shooting guard'],
  forward: ['forward', 'sf', 'pf', 'small forward', 'power forward'],
  centre:  ['centre', 'center', 'c'],
};
function positionGroup(raw) {
  if (!raw) return 'unknown';
  const s = String(raw).toLowerCase();
  for (const [g, aliases] of Object.entries(POSITION_GROUPS)) if (aliases.some((a) => s.includes(a))) return g;
  return 'unknown';
}

const METRIC_DEFS = {
  points:              { direction: 'higher', unit: '', definition: 'Total points scored' },
  rebounds:            { direction: 'higher', unit: '', definition: 'Total rebounds (offensive + defensive)' },
  offensive_rebounds:  { direction: 'higher', unit: '', definition: 'Offensive rebounds' },
  defensive_rebounds:  { direction: 'higher', unit: '', definition: 'Defensive rebounds' },
  assists:             { direction: 'higher', unit: '', definition: 'Assists (passes leading directly to a basket)' },
  steals:              { direction: 'higher', unit: '', definition: 'Steals' },
  blocks:              { direction: 'higher', unit: '', definition: 'Blocked shots' },
  turnovers:           { direction: 'lower',  unit: '', definition: 'Turnovers (ball lost to opposition)' },
  fouls:               { direction: 'lower',  unit: '', definition: 'Personal fouls committed' },
  fg_made:             { direction: 'higher', unit: '', definition: 'Field goals made' },
  fg_attempted:        { direction: 'higher', unit: '', definition: 'Field goals attempted' },
  three_made:          { direction: 'higher', unit: '', definition: 'Three-point field goals made' },
  three_attempted:     { direction: 'higher', unit: '', definition: 'Three-point field goals attempted' },
  ft_made:             { direction: 'higher', unit: '', definition: 'Free throws made' },
  ft_attempted:        { direction: 'higher', unit: '', definition: 'Free throws attempted' },
  plus_minus:          { direction: 'higher', unit: '', definition: 'Plus/minus: net team points when player is on court' },
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
  return { totals, counts, games: rows.length };
}

function matchWinRate(rows) {
  const decided = rows.filter((r) => r.result && r.result !== 'unknown');
  const wins = decided.filter((r) => r.result === 'win').length;
  return { total: rows.length, decided: decided.length, wins, win_rate: decided.length ? Math.round((wins / decided.length) * 1000) / 10 : null };
}

function buildTrack(rows, evid, posGrp, limitations) {
  if (!rows.length) return null;
  if (rows.length < MIN_GAMES) {
    limitations.push(`${evid}: only ${rows.length} game${rows.length === 1 ? '' : 's'} — ${MIN_GAMES} needed for reliable per-game averages`);
  }
  const agg = aggregate(rows);
  const metrics = {};
  for (const [k, total] of Object.entries(agg.totals)) {
    const def = METRIC_DEFS[k] ?? { direction: 'higher', unit: '', definition: k };
    metrics[k] = { value: total, per_game: round2(total / agg.games), sample_size: agg.counts[k], ...def };
  }

  // Computed shooting percentages (only when made + attempted both captured)
  const fgPct = agg.totals.fg_made !== undefined && agg.totals.fg_attempted ? pct(agg.totals.fg_made, agg.totals.fg_attempted) : null;
  const threePct = agg.totals.three_made !== undefined && agg.totals.three_attempted ? pct(agg.totals.three_made, agg.totals.three_attempted) : null;
  const ftPct = agg.totals.ft_made !== undefined && agg.totals.ft_attempted ? pct(agg.totals.ft_made, agg.totals.ft_attempted) : null;

  const shooting = {};
  if (fgPct !== null) shooting.fg_pct = { value: fgPct, unit: '%', direction: 'higher', definition: 'Field goal percentage (made / attempted)', sample_size: agg.counts.fg_attempted };
  if (threePct !== null) shooting.three_point_pct = { value: threePct, unit: '%', direction: 'higher', definition: 'Three-point field goal percentage', sample_size: agg.counts.three_attempted };
  if (ftPct !== null) shooting.free_throw_pct = { value: ftPct, unit: '%', direction: 'higher', definition: 'Free throw percentage', sample_size: agg.counts.ft_attempted };

  return {
    evidence: evid,
    games: agg.games,
    match_win_rate: { ...matchWinRate(rows), direction: 'higher', definition: 'Games won as a percentage of decided games', unit: '%' },
    position_group: posGrp,
    metrics: Object.keys(metrics).length ? metrics : null,
    shooting_pct: Object.keys(shooting).length ? shooting : null,
    insufficient: rows.length < MIN_GAMES,
  };
}

export async function compute(db, userId, { sportId, evidence = 'approved_competition', from = null, to = null }) {
  const limitations = [];

  const sp = await db.query('SELECT position, positions FROM sport_profiles WHERE user_id=$1 AND sport_id=$2 ORDER BY created_at DESC LIMIT 1', [userId, sportId]);
  const rawPos = sp.rows[0]?.position ?? sp.rows[0]?.positions?.[0] ?? null;
  const position_group = positionGroup(rawPos);

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
    const t = buildTrack(rows, 'approved_competition', position_group, limitations);
    if (t) tracks.approved_competition = t;
    else limitations.push('Official track: no approved competition data in this period');
  }
  if (evidence === 'self_reported' || evidence === 'combined') {
    const rows = await loadSelf();
    const t = buildTrack(rows, 'self_reported', position_group, limitations);
    if (t) tracks.self_reported = t;
    else limitations.push('Self-reported track: no self-logged game data in this period');
  }

  return {
    sport: 'basketball',
    calc_version: CALC_VERSION,
    period: { from, to },
    tracks,
    limitations,
  };
}
