// Football / futsal performance analytics adapter (issue #506).
// Per-90 rates require verified minutes from match_appearances; without them they are labelled insufficient.
// Position context (GK / DF / MF / FW) uses the athlete's sport_profile.position or positions array.
// Evidence tracks are always separate: approved competition uses game_participants + match_appearances;
// self-reported uses player_matches.stats_snapshot.

export const CALC_VERSION = 'football_v1';
const MIN_VERIFIED_MINUTES = 90;

const NUM = (obj, k) => { const v = obj?.[k]; return v === null || v === undefined ? null : Number(v); };

const POSITION_GROUPS = {
  gk: ['gk', 'goalkeeper', 'keeper'],
  df: ['df', 'cb', 'lb', 'rb', 'lwb', 'rwb', 'defender', 'centre-back', 'full-back'],
  mf: ['mf', 'cm', 'cdm', 'cam', 'lm', 'rm', 'midfielder', 'midfield'],
  fw: ['fw', 'cf', 'st', 'lw', 'rw', 'ss', 'forward', 'striker', 'winger'],
};
function positionGroup(raw) {
  if (!raw) return 'unknown';
  const s = String(raw).toLowerCase().replace(/[^a-z-]/g, '');
  for (const [g, aliases] of Object.entries(POSITION_GROUPS)) if (aliases.some((a) => s.startsWith(a))) return g;
  return 'unknown';
}

const METRIC_DEFS = {
  goals: { direction: 'higher', unit: '', definition: 'Goals scored in finished matches' },
  assists: { direction: 'higher', unit: '', definition: 'Goal assists in finished matches' },
  yellow_cards: { direction: 'lower', unit: '', definition: 'Yellow cards received' },
  red_cards: { direction: 'lower', unit: '', definition: 'Red cards received' },
  shots_on_target: { direction: 'higher', unit: '', definition: 'Shots on target' },
  tackles: { direction: 'higher', unit: '', definition: 'Successful tackles' },
  interceptions: { direction: 'higher', unit: '', definition: 'Interceptions' },
  saves: { direction: 'higher', unit: '', definition: 'Goalkeeper saves' },
  clean_sheets: { direction: 'higher', unit: '', definition: 'Matches where no goals conceded' },
  passes_completed: { direction: 'higher', unit: '', definition: 'Completed passes' },
  key_passes: { direction: 'higher', unit: '', definition: 'Passes leading directly to a shot' },
};

function extractMetrics(stats) {
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
    const m = extractMetrics(row.stats ?? row.stats_snapshot ?? {});
    for (const [k, v] of Object.entries(m)) {
      totals[k] = (totals[k] ?? 0) + v;
      counts[k] = (counts[k] ?? 0) + 1;
    }
  }
  return { totals, counts, appearances: rows.length };
}

function per90(value, verifiedMinutes) {
  if (verifiedMinutes < MIN_VERIFIED_MINUTES) return { value: null, insufficient: true, verified_minutes: verifiedMinutes, min_required: MIN_VERIFIED_MINUTES, reason: `Need at least ${MIN_VERIFIED_MINUTES} verified minutes for per-90 rates (currently ${verifiedMinutes} min)` };
  return { value: Math.round((value / verifiedMinutes) * 90 * 100) / 100, insufficient: false, verified_minutes: verifiedMinutes };
}

export async function compute(db, userId, { sportId, evidence = 'approved_competition', from = null, to = null }) {
  const limitations = [];

  // Fetch position from sport_profile
  const sp = await db.query('SELECT position, positions FROM sport_profiles WHERE user_id=$1 AND sport_id=$2 ORDER BY created_at DESC LIMIT 1', [userId, sportId]);
  const rawPos = sp.rows[0]?.position ?? sp.rows[0]?.positions?.[0] ?? null;
  const position_group = positionGroup(rawPos);

  async function loadOfficial() {
    const rows = await db.query(
      `SELECT gp.stats, g.starts_at::date AS played_on, f.id AS fixture_id,
              ma.minutes_played::float AS verified_minutes,
              coalesce(ev.name, f.round) AS competition,
              coalesce(vn.name, f.location) AS venue,
              CASE WHEN f.home_team_id = ma.team_id THEN ot.name ELSE ht.name END AS opponent,
              CASE WHEN sq.format IS NOT NULL THEN sq.format ELSE 'league' END AS format
         FROM game_participants gp
         JOIN games g ON g.id = gp.game_id
         LEFT JOIN fixtures f ON f.id = g.fixture_id
         LEFT JOIN match_appearances ma ON ma.fixture_id = g.fixture_id AND ma.user_id = $1 AND ma.archived_at IS NULL AND ma.status IN ('started','substitute_on')
         LEFT JOIN events ev ON ev.id = g.competition_id
         LEFT JOIN venues vn ON vn.id = g.venue_id
         LEFT JOIN teams ht ON ht.id = f.home_team_id
         LEFT JOIN teams ot ON ot.id = f.away_team_id
         LEFT JOIN LATERAL (SELECT match_type AS format FROM player_matches pm JOIN sport_profiles sp2 ON sp2.id = pm.sport_profile_id WHERE sp2.user_id = $1 AND pm.played_on = g.starts_at::date LIMIT 1) sq ON true
        WHERE gp.user_id = $1 AND g.sport_id = $2 AND g.status = 'post-event'
          AND ($3::date IS NULL OR g.starts_at::date >= $3)
          AND ($4::date IS NULL OR g.starts_at::date <= $4)`,
      [userId, sportId, from, to]);
    return rows.rows;
  }

  async function loadSelf() {
    const rows = await db.query(
      `SELECT m.stats_snapshot AS stats, coalesce(m.played_on, m.created_at::date) AS played_on,
              m.match_type AS format, m.result
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
    if (!rows.length) limitations.push('Official track: no approved competition data in this period');
    const agg = aggregate(rows);
    const verifiedMinutes = rows.reduce((s, r) => s + (Number(r.verified_minutes) || 0), 0);
    const metrics = {};
    for (const [k, total] of Object.entries(agg.totals)) {
      const def = METRIC_DEFS[k] ?? { direction: 'higher', unit: '', definition: k };
      metrics[k] = { value: total, ...def, sample_size: agg.counts[k], sample_unit: 'appearances', per_90: per90(total, verifiedMinutes) };
    }
    if (!verifiedMinutes) limitations.push('Per-90 rates unavailable: no verified minutes recorded via official lineup sheets');
    tracks.approved_competition = { evidence: 'approved_competition', appearances: agg.appearances, verified_minutes: verifiedMinutes, metrics, position_group };
  }
  if (evidence === 'self_reported' || evidence === 'combined') {
    const rows = await loadSelf();
    if (!rows.length) limitations.push('Self-reported track: no self-logged match data in this period');
    const agg = aggregate(rows);
    const metrics = {};
    for (const [k, total] of Object.entries(agg.totals)) {
      const def = METRIC_DEFS[k] ?? { direction: 'higher', unit: '', definition: k };
      metrics[k] = { value: total, ...def, sample_size: agg.counts[k], sample_unit: 'appearances', per_90: { value: null, insufficient: true, reason: 'Per-90 rates require verified minutes from official lineup sheets; self-reported appearances do not carry verified minutes' } };
    }
    tracks.self_reported = { evidence: 'self_reported', appearances: agg.appearances, verified_minutes: 0, metrics, position_group };
  }

  return {
    sport: 'football',
    calc_version: CALC_VERSION,
    period: { from, to },
    tracks,
    limitations,
  };
}
