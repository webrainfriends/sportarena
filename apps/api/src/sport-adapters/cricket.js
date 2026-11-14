// Cricket performance analytics adapter (issue #506).
// Computes batting and bowling analytics from per-match stats (player_matches.stats_snapshot for self-reported,
// game_participants.stats for official competition results). Evidence tracks are always separate.
// Direction semantics: batting average/SR/runs = higher is better; bowling economy/average = lower is better.

export const CALC_VERSION = 'cricket_v1';
const MIN_INNINGS = 5;
const MIN_SPELLS = 3;

const NUM = (row, key) => { const v = row?.[key]; return v === null || v === undefined ? null : Number(v); };

// All valid metric keys this adapter reads from stats JSONB
const BAT_KEYS = ['runs', 'balls_faced', 'fours', 'sixes', 'not_out', 'dismissal_type'];
const BOWL_KEYS = ['overs_bowled', 'runs_conceded', 'wickets', 'wides', 'no_balls', 'bowling_wicket_type',
  'powerplay_overs', 'powerplay_runs', 'middle_overs', 'middle_runs', 'death_overs', 'death_runs'];
const FORMAT_KEYS = ['format']; // T20 / ODI / Test / other

function oversToBalls(overs) {
  if (overs === null || overs === undefined) return null;
  const whole = Math.floor(Number(overs));
  const frac = Math.round((Number(overs) - whole) * 10);
  return whole * 6 + Math.min(frac, 5);
}

function batting(rows) {
  const innings = rows.filter((r) => r.runs !== null);
  const n = innings.length;
  if (n < MIN_INNINGS) return { innings_count: n, insufficient: true, min_required: MIN_INNINGS };

  const notOuts = innings.filter((r) => r.not_out === 1 || r.not_out === true).length;
  const dismissed = n - notOuts;
  const totalRuns = innings.reduce((s, r) => s + (Number(r.runs) || 0), 0);
  const totalBalls = innings.reduce((s, r) => s + (Number(r.balls_faced) || 0), 0);
  const totalFours = innings.reduce((s, r) => s + (Number(r.fours) || 0), 0);
  const totalSixes = innings.reduce((s, r) => s + (Number(r.sixes) || 0), 0);
  const highScore = Math.max(...innings.map((r) => Number(r.runs) || 0));
  const avg = dismissed > 0 ? Math.round((totalRuns / dismissed) * 100) / 100 : null;
  const sr = totalBalls > 0 ? Math.round((totalRuns / totalBalls) * 10000) / 100 : null;
  const boundaryPct = totalBalls > 0 ? Math.round(((totalFours * 4 + totalSixes * 6) / totalRuns) * 1000) / 10 : null;

  // Dismissal breakdown
  const dismissals = {};
  for (const r of innings.filter((r) => !r.not_out && r.dismissal_type)) {
    const d = String(r.dismissal_type).toLowerCase();
    dismissals[d] = (dismissals[d] ?? 0) + 1;
  }

  // Format splits (only if at least 2 innings per format)
  const formats = {};
  for (const r of innings) {
    if (!r.format) continue;
    const f = String(r.format).toLowerCase();
    if (!formats[f]) formats[f] = [];
    formats[f].push(r);
  }
  const format_splits = Object.fromEntries(
    Object.entries(formats)
      .filter(([, rs]) => rs.length >= 2)
      .map(([f, rs]) => {
        const fRuns = rs.reduce((s, r) => s + (Number(r.runs) || 0), 0);
        const fDismissed = rs.filter((r) => !r.not_out).length;
        const fBalls = rs.reduce((s, r) => s + (Number(r.balls_faced) || 0), 0);
        return [f, { innings: rs.length, runs: fRuns, average: fDismissed > 0 ? Math.round((fRuns / fDismissed) * 100) / 100 : null, strike_rate: fBalls > 0 ? Math.round((fRuns / fBalls) * 10000) / 100 : null }];
      })
  );

  // Phase splits (only when ball counts are captured)
  const withPhase = innings.filter((r) => r.powerplay_runs !== null && r.powerplay_runs !== undefined);
  const phase_splits = withPhase.length >= 2 ? {
    powerplay: { innings: withPhase.length, runs: withPhase.reduce((s, r) => s + (Number(r.powerplay_runs) || 0), 0) },
    middle: { innings: withPhase.length, runs: withPhase.reduce((s, r) => s + (Number(r.middle_runs) || 0), 0) },
    death: { innings: withPhase.length, runs: withPhase.reduce((s, r) => s + (Number(r.death_runs) || 0), 0) },
    phase_coverage: withPhase.length,
    total_innings: n,
  } : null;

  return {
    innings_count: n, not_outs: notOuts, dismissed, total_runs: totalRuns, high_score: highScore,
    batting_average: { value: avg, unit: 'runs/dismissal', direction: 'higher', definition: 'Runs scored divided by times dismissed (not-outs excluded from denominator)', sample_size: n, sample_unit: 'innings' },
    strike_rate: { value: sr, unit: 'runs per 100 balls', direction: 'higher', definition: 'Runs scored × 100 ÷ balls faced; only innings with balls_faced captured', sample_size: innings.filter((r) => r.balls_faced !== null).length, sample_unit: 'innings' },
    total_fours: totalFours, total_sixes: totalSixes,
    boundary_pct: boundaryPct !== null ? { value: boundaryPct, unit: '%', direction: 'higher', definition: 'Runs from boundaries as a percentage of total runs', sample_size: n, sample_unit: 'innings' } : null,
    dismissal_breakdown: dismissals,
    format_splits: Object.keys(format_splits).length ? format_splits : null,
    phase_splits,
    insufficient: false,
  };
}

function bowling(rows) {
  const spells = rows.filter((r) => r.overs_bowled !== null);
  const n = spells.length;
  if (n < MIN_SPELLS) return { spell_count: n, insufficient: true, min_required: MIN_SPELLS };

  const totalBalls = spells.reduce((s, r) => s + (oversToBalls(r.overs_bowled) || 0), 0);
  const totalRuns = spells.reduce((s, r) => s + (Number(r.runs_conceded) || 0), 0);
  const totalWickets = spells.reduce((s, r) => s + (Number(r.wickets) || 0), 0);
  const economy = totalBalls > 0 ? Math.round((totalRuns / (totalBalls / 6)) * 100) / 100 : null;
  const bowlingAvg = totalWickets > 0 ? Math.round((totalRuns / totalWickets) * 100) / 100 : null;
  const bowlingSR = totalWickets > 0 ? Math.round((totalBalls / totalWickets) * 100) / 100 : null;

  const wicketSources = {};
  for (const r of spells.filter((r) => r.bowling_wicket_type)) {
    const w = String(r.bowling_wicket_type).toLowerCase();
    wicketSources[w] = (wicketSources[w] ?? 0) + 1;
  }

  const withPhase = spells.filter((r) => r.powerplay_overs !== null && r.powerplay_overs !== undefined);
  const phase_splits = withPhase.length >= 2 ? {
    powerplay: { spells: withPhase.length, economy: withPhase.reduce((s, r) => s + (Number(r.powerplay_runs) || 0), 0) > 0 ? Math.round(withPhase.reduce((s, r) => s + (Number(r.powerplay_runs) || 0), 0) / withPhase.reduce((s, r) => s + ((oversToBalls(r.powerplay_overs) || 0) / 6), 0) * 100) / 100 : null },
    middle: { spells: withPhase.length, economy: withPhase.reduce((s, r) => s + (Number(r.middle_runs) || 0), 0) > 0 ? Math.round(withPhase.reduce((s, r) => s + (Number(r.middle_runs) || 0), 0) / withPhase.reduce((s, r) => s + ((oversToBalls(r.middle_overs) || 0) / 6), 0) * 100) / 100 : null },
    death: { spells: withPhase.length, economy: withPhase.reduce((s, r) => s + (Number(r.death_runs) || 0), 0) > 0 ? Math.round(withPhase.reduce((s, r) => s + (Number(r.death_runs) || 0), 0) / withPhase.reduce((s, r) => s + ((oversToBalls(r.death_overs) || 0) / 6), 0) * 100) / 100 : null },
    coverage: withPhase.length,
    total_spells: n,
  } : null;

  return {
    spell_count: n, total_wickets: totalWickets,
    economy: { value: economy, unit: 'runs/over', direction: 'lower', definition: 'Total runs conceded ÷ overs bowled', sample_size: n, sample_unit: 'spells' },
    bowling_average: { value: bowlingAvg, unit: 'runs/wicket', direction: 'lower', definition: 'Total runs conceded ÷ total wickets taken (null when no wickets)', sample_size: n, sample_unit: 'spells' },
    bowling_strike_rate: { value: bowlingSR, unit: 'balls/wicket', direction: 'lower', definition: 'Total balls bowled ÷ total wickets taken', sample_size: n, sample_unit: 'spells' },
    wicket_sources: Object.keys(wicketSources).length ? wicketSources : null,
    phase_splits,
    insufficient: false,
  };
}

function limitation(label, msg) { return `${label}: ${msg}`; }

export async function compute(db, userId, { sportId, evidence = 'approved_competition', from = null, to = null }) {
  const limitations = [];

  // Self-reported path: player_matches.stats_snapshot
  async function loadSelfReported() {
    const rows = await db.query(
      `SELECT m.stats_snapshot
         FROM player_matches m
         JOIN sport_profiles sp ON sp.id = m.sport_profile_id
        WHERE sp.user_id = $1 AND sp.sport_id = $2 AND m.archived_at IS NULL
          AND ($3::date IS NULL OR coalesce(m.played_on, m.created_at::date) >= $3)
          AND ($4::date IS NULL OR coalesce(m.played_on, m.created_at::date) <= $4)
          AND m.stats_snapshot IS NOT NULL`,
      [userId, sportId, from, to]);
    return rows.rows.map((r) => r.stats_snapshot ?? {});
  }

  // Official competition path: game_participants.stats
  async function loadOfficial() {
    const rows = await db.query(
      `SELECT gp.stats, g.starts_at::date AS played_on
         FROM game_participants gp
         JOIN games g ON g.id = gp.game_id
        WHERE gp.user_id = $1 AND g.sport_id = $2 AND g.status = 'post-event'
          AND ($3::date IS NULL OR g.starts_at::date >= $3)
          AND ($4::date IS NULL OR g.starts_at::date <= $4)
          AND gp.stats IS NOT NULL`,
      [userId, sportId, from, to]);
    return rows.rows.map((r) => r.stats ?? {});
  }

  const tracks = {};
  if (evidence === 'approved_competition' || evidence === 'combined') {
    const rows = await loadOfficial();
    if (!rows.length) limitations.push(limitation('Official track', 'No approved competition data in this period'));
    tracks.approved_competition = rows;
  }
  if (evidence === 'self_reported' || evidence === 'combined') {
    const rows = await loadSelfReported();
    if (!rows.length) limitations.push(limitation('Self-reported track', 'No self-logged match data in this period'));
    tracks.self_reported = rows;
  }

  const result = {};
  for (const [evid, rows] of Object.entries(tracks)) {
    result[evid] = {
      evidence: evid,
      batting: batting(rows),
      bowling: bowling(rows),
    };
  }

  return {
    sport: 'cricket',
    calc_version: CALC_VERSION,
    period: { from, to },
    tracks: result,
    limitations,
  };
}
