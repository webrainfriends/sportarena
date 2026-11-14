// Racket-sport performance analytics adapter (issue #506).
// Covers tennis, squash, badminton, table tennis, padel.
// Set/game win rates, opponent history (canonical id only), surface/category splits, deciding-set performance.
// Minimum 10 matches per dimension split before a context split is shown.

export const CALC_VERSION = 'racket_v1';
const MIN_MATCHES = 10;
const MIN_SPLIT = 10;

const NUM = (obj, k) => { const v = obj?.[k]; return v === null || v === undefined ? null : Number(v); };

const METRIC_DEFS = {
  sets_won: { direction: 'higher', unit: '', definition: 'Sets won across all matches' },
  sets_lost: { direction: 'lower', unit: '', definition: 'Sets lost across all matches' },
  games_won: { direction: 'higher', unit: '', definition: 'Games won (tennis/badminton points in squash)' },
  games_lost: { direction: 'lower', unit: '', definition: 'Games lost' },
  aces: { direction: 'higher', unit: '', definition: 'Aces served (when captured)' },
  double_faults: { direction: 'lower', unit: '', definition: 'Double faults (when captured)' },
  first_serve_pct: { direction: 'higher', unit: '%', definition: 'First serve percentage (when captured)' },
  winners: { direction: 'higher', unit: '', definition: 'Winners hit' },
  unforced_errors: { direction: 'lower', unit: '', definition: 'Unforced errors' },
  break_points_won: { direction: 'higher', unit: '', definition: 'Break points won' },
  break_points_faced: { direction: 'lower', unit: '', definition: 'Break points faced' },
};

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

function decidingSetPerf(rows) {
  // A deciding-set match is one where sets_won and sets_lost are equal before the last set
  // Heuristic: total sets played is 2*sets_won - 1 for a winner; detecting deciding set needs sets_played or final_set_won field
  const withDeciding = rows.filter((r) => r.final_set_won !== null && r.final_set_won !== undefined);
  if (withDeciding.length < 3) return null;
  const wins = withDeciding.filter((r) => r.final_set_won === 1 || r.final_set_won === true).length;
  return { sample: withDeciding.length, wins, win_rate: Math.round((wins / withDeciding.length) * 1000) / 10, definition: 'Win rate in matches that went to a deciding set/game' };
}

function surfaceSplits(rows) {
  const bySurface = {};
  for (const r of rows) {
    if (!r.surface) continue;
    const s = String(r.surface).toLowerCase();
    if (!bySurface[s]) bySurface[s] = [];
    bySurface[s].push(r);
  }
  return Object.fromEntries(
    Object.entries(bySurface)
      .filter(([, rs]) => rs.length >= MIN_SPLIT)
      .map(([s, rs]) => [s, { ...matchWinRate(rs), ...setWinRate(rs) }])
  );
}

function opponentHistory(rows) {
  // Canonical opponent_id only (never freetext name inference)
  const byOpponent = {};
  for (const r of rows) {
    if (!r.opponent_user_id && !r.opponent_team_id) continue;
    const oid = r.opponent_user_id ?? r.opponent_team_id;
    if (!byOpponent[oid]) byOpponent[oid] = { opponent_id: oid, opponent_label: r.opponent_label ?? 'Opponent', matches: [] };
    byOpponent[oid].matches.push(r);
  }
  return Object.values(byOpponent)
    .filter((o) => o.matches.length >= MIN_SPLIT)
    .map((o) => ({ opponent_id: o.opponent_id, opponent_label: o.opponent_label, ...matchWinRate(o.matches), ...setWinRate(o.matches) }));
}

export async function compute(db, userId, { sportId, evidence = 'approved_competition', from = null, to = null }) {
  const limitations = [];

  async function loadOfficial() {
    const rows = await db.query(
      `SELECT gp.stats, g.starts_at::date AS played_on,
              CASE c.outcome WHEN 'win' THEN 'win' WHEN 'loss' THEN 'loss' WHEN 'tie' THEN 'draw' ELSE NULL END AS result,
              opp_p.user_id AS opponent_user_id, coalesce(opp_t.name, opp_u.display_name) AS opponent_label,
              NULL::uuid AS opponent_team_id,
              g.venue_id,
              coalesce(gp.stats->>'surface', ev.metadata->>'surface') AS surface,
              gp.stats->>'final_set_won' AS final_set_won_raw,
              (gp.stats->>'sets_won')::float AS sets_won, (gp.stats->>'sets_lost')::float AS sets_lost
         FROM game_participants gp
         JOIN games g ON g.id = gp.game_id
         LEFT JOIN events ev ON ev.id = g.competition_id
         LEFT JOIN LATERAL (SELECT p2.user_id FROM game_participants p2 WHERE p2.game_id = g.id AND p2.user_id <> $1 LIMIT 1) opp_p ON true
         LEFT JOIN LATERAL (SELECT u.display_name FROM users u WHERE u.id = opp_p.user_id) opp_u ON true
         LEFT JOIN teams opp_t ON false
         JOIN game_participants c ON c.game_id = g.id AND c.user_id = $1
        WHERE gp.user_id = $1 AND g.sport_id = $2 AND g.status = 'post-event'
          AND ($3::date IS NULL OR g.starts_at::date >= $3)
          AND ($4::date IS NULL OR g.starts_at::date <= $4)`,
      [userId, sportId, from, to]);
    return rows.rows.map((r) => ({ ...r, final_set_won: r.final_set_won_raw === '1' || r.final_set_won_raw === 'true' ? 1 : r.final_set_won_raw === '0' || r.final_set_won_raw === 'false' ? 0 : null }));
  }

  async function loadSelf() {
    const rows = await db.query(
      `SELECT m.stats_snapshot AS stats, coalesce(m.played_on, m.created_at::date) AS played_on,
              m.result, m.opponent_user_id, m.match_type AS format,
              (m.stats_snapshot->>'surface') AS surface,
              (m.stats_snapshot->>'sets_won')::float AS sets_won,
              (m.stats_snapshot->>'sets_lost')::float AS sets_lost,
              (m.stats_snapshot->>'final_set_won')::float AS final_set_won
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
    if (rows.length < MIN_MATCHES) {
      limitations.push(`${evid}: only ${rows.length} match${rows.length === 1 ? '' : 'es'} — ${MIN_MATCHES} needed for reliable analytics`);
    }
    const service_metrics = {};
    for (const k of ['aces', 'double_faults', 'first_serve_pct', 'winners', 'unforced_errors', 'break_points_won', 'break_points_faced']) {
      const withK = rows.filter((r) => NUM(r.stats ?? {}, k) !== null);
      if (withK.length >= 3) {
        service_metrics[k] = { value: withK.reduce((s, r) => s + (NUM(r.stats ?? {}, k) || 0), 0), sample_size: withK.length, ...METRIC_DEFS[k] };
      }
    }
    const surfaces = surfaceSplits(rows);
    const opponents = evid === 'approved_competition' ? opponentHistory(rows) : [];
    const decidingSet = decidingSetPerf(rows);
    return {
      evidence: evid, matches: rows.length,
      match_win_rate: { ...matchWinRate(rows), direction: 'higher', definition: 'Matches won as a percentage of decided matches', unit: '%' },
      set_win_rate: { ...setWinRate(rows), direction: 'higher', unit: '%', definition: 'Sets won as a percentage of total sets played' },
      deciding_set_performance: decidingSet,
      service_metrics: Object.keys(service_metrics).length ? service_metrics : null,
      surface_splits: Object.keys(surfaces).length ? surfaces : null,
      opponent_history: opponents.length ? opponents : null,
      surface_coverage_note: !Object.keys(surfaces).length ? `Surface data not captured, or no surface with ${MIN_SPLIT}+ matches` : null,
      opponent_note: !opponents.length ? `No canonical opponent with ${MIN_SPLIT}+ matches; freetext opponent names are not used` : null,
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
    sport: 'racket',
    calc_version: CALC_VERSION,
    period: { from, to },
    tracks,
    limitations,
  };
}
