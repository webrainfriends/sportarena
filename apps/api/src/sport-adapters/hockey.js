// Hockey performance analytics adapter.
// Covers field hockey, field-hockey-indoor, ice-hockey.
// Shares the goal-game family structure with football.js but with hockey-specific stats:
// penalty corners, drag flicks, green/yellow/red cards; per-match rates (not per-90).
// Evidence tracks always separate. Youth/coach privacy mirrors player-insights.js.

export const CALC_VERSION = 'hockey_v1';
const MIN_APPEARANCES = 3;
const MIN_VERIFIED_MINUTES = 60; // per-60-min rates (hockey periods are 35-min halves / 20-min ice periods)

const NUM = (obj, k) => { const v = obj?.[k]; return v === null || v === undefined ? null : Number(v); };
const round2 = (n) => Math.round(n * 100) / 100;

const POSITION_GROUPS = {
  gk:       ['gk', 'goalkeeper', 'keeper', 'goalie'],
  defender: ['defender', 'df', 'back', 'sweeper', 'stopper'],
  midfielder: ['midfielder', 'mf', 'midfield', 'half'],
  forward:  ['forward', 'fw', 'striker', 'winger', 'inside', 'centre-forward'],
};
function positionGroup(raw) {
  if (!raw) return 'unknown';
  const s = String(raw).toLowerCase().replace(/[^a-z-]/g, '');
  for (const [g, aliases] of Object.entries(POSITION_GROUPS)) if (aliases.some((a) => s.startsWith(a))) return g;
  return 'unknown';
}

const METRIC_DEFS = {
  goals:                  { direction: 'higher', unit: '', definition: 'Goals scored in finished matches' },
  assists:                { direction: 'higher', unit: '', definition: 'Goal assists in finished matches' },
  penalty_corners:        { direction: 'higher', unit: '', definition: 'Penalty corners won by the player' },
  penalty_corner_goals:   { direction: 'higher', unit: '', definition: 'Goals scored from penalty corners' },
  penalty_strokes:        { direction: 'higher', unit: '', definition: 'Penalty stroke goals (including drag flicks)' },
  drag_flicks:            { direction: 'higher', unit: '', definition: 'Drag-flick shots attempted (when captured)' },
  saves:                  { direction: 'higher', unit: '', definition: 'Goalkeeper saves' },
  clean_sheets:           { direction: 'higher', unit: '', definition: 'Matches where no goals conceded (GK)' },
  tackles:                { direction: 'higher', unit: '', definition: 'Tackles won' },
  interceptions:          { direction: 'higher', unit: '', definition: 'Interceptions' },
  green_cards:            { direction: 'lower',  unit: '', definition: 'Green cards (temporary suspension)' },
  yellow_cards:           { direction: 'lower',  unit: '', definition: 'Yellow cards (temporary suspension)' },
  red_cards:              { direction: 'lower',  unit: '', definition: 'Red cards (match suspension)' },
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

function perMatch(total, appearances) {
  return appearances > 0 ? round2(total / appearances) : null;
}

function per60(total, verifiedMinutes) {
  if (verifiedMinutes < MIN_VERIFIED_MINUTES) return { value: null, insufficient: true, verified_minutes: verifiedMinutes, min_required: MIN_VERIFIED_MINUTES, reason: `Need at least ${MIN_VERIFIED_MINUTES} verified minutes for per-60 rates (currently ${verifiedMinutes} min)` };
  return { value: round2((total / verifiedMinutes) * 60), insufficient: false, verified_minutes: verifiedMinutes };
}

function matchWinRate(rows) {
  const decided = rows.filter((r) => r.result && r.result !== 'unknown');
  const wins = decided.filter((r) => r.result === 'win').length;
  return { total: rows.length, decided: decided.length, wins, win_rate: decided.length ? Math.round((wins / decided.length) * 1000) / 10 : null };
}

export async function compute(db, userId, { sportId, evidence = 'approved_competition', from = null, to = null }) {
  const limitations = [];

  const sp = await db.query('SELECT position, positions FROM sport_profiles WHERE user_id=$1 AND sport_id=$2 ORDER BY created_at DESC LIMIT 1', [userId, sportId]);
  const rawPos = sp.rows[0]?.position ?? sp.rows[0]?.positions?.[0] ?? null;
  const position_group = positionGroup(rawPos);

  async function loadOfficial() {
    const rows = await db.query(
      `SELECT gp.stats, g.starts_at::date AS played_on,
              CASE c.outcome WHEN 'win' THEN 'win' WHEN 'loss' THEN 'loss' WHEN 'tie' THEN 'draw' ELSE NULL END AS result,
              ma.minutes_played::float AS verified_minutes,
              coalesce(ev.name, f.round) AS competition,
              coalesce(gp.stats->>'match_type', 'league') AS format
         FROM game_participants gp
         JOIN games g ON g.id = gp.game_id
         LEFT JOIN fixtures f ON f.id = g.fixture_id
         LEFT JOIN match_appearances ma ON ma.fixture_id = g.fixture_id AND ma.user_id = $1 AND ma.archived_at IS NULL AND ma.status IN ('started','substitute_on')
         LEFT JOIN events ev ON ev.id = g.competition_id
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
              m.result, m.match_type AS format
         FROM player_matches m
         JOIN sport_profiles sp ON sp.id = m.sport_profile_id
        WHERE sp.user_id = $1 AND sp.sport_id = $2 AND m.archived_at IS NULL
          AND ($3::date IS NULL OR coalesce(m.played_on, m.created_at::date) >= $3)
          AND ($4::date IS NULL OR coalesce(m.played_on, m.created_at::date) <= $4)`,
      [userId, sportId, from, to]);
    return rows.rows;
  }

  function buildTrack(rows, evid) {
    if (!rows.length) return null;
    if (rows.length < MIN_APPEARANCES) {
      limitations.push(`${evid}: only ${rows.length} appearance${rows.length === 1 ? '' : 's'} — ${MIN_APPEARANCES} needed`);
    }
    const agg = aggregate(rows);
    const verifiedMinutes = rows.reduce((s, r) => s + (Number(r.verified_minutes) || 0), 0);
    const metrics = {};
    for (const [k, total] of Object.entries(agg.totals)) {
      const def = METRIC_DEFS[k] ?? { direction: 'higher', unit: '', definition: k };
      metrics[k] = {
        value: total, ...def,
        per_match: perMatch(total, agg.appearances),
        per_60: evid === 'approved_competition' ? per60(total, verifiedMinutes) : { value: null, insufficient: true, reason: 'Per-60 rates require verified minutes from official lineup sheets' },
        sample_size: agg.counts[k], sample_unit: 'appearances',
      };
    }
    if (!verifiedMinutes && evid === 'approved_competition') limitations.push('Per-60 rates unavailable: no verified minutes recorded via official lineup sheets');
    return {
      evidence: evid, appearances: agg.appearances, verified_minutes: verifiedMinutes, position_group,
      match_win_rate: { ...matchWinRate(rows), direction: 'higher', definition: 'Matches won as a percentage of decided matches', unit: '%' },
      metrics: Object.keys(metrics).length ? metrics : null,
    };
  }

  const tracks = {};
  if (evidence === 'approved_competition' || evidence === 'combined') {
    const rows = await loadOfficial();
    const t = buildTrack(rows, 'approved_competition');
    if (t) tracks.approved_competition = t;
    else limitations.push('Official track: no approved competition data in this period');
  }
  if (evidence === 'self_reported' || evidence === 'combined') {
    const rows = await loadSelf();
    const t = buildTrack(rows, 'self_reported');
    if (t) tracks.self_reported = t;
    else limitations.push('Self-reported track: no self-logged match data in this period');
  }

  return {
    sport: 'hockey',
    calc_version: CALC_VERSION,
    period: { from, to },
    tracks,
    limitations,
  };
}
