// Boxing performance analytics adapter.
// Covers boxing, kickboxing, muay-thai, bare-knuckle-boxing.
// Win method breakdown: KO/TKO/decision/split-decision/DQ.
// Punch statistics when captured (CompuBox-style): jabs, power punches, total.
// Evidence tracks always separate.

export const CALC_VERSION = 'boxing_v1';
const MIN_BOUTS = 3;

const NUM = (obj, k) => { const v = obj?.[k]; return v === null || v === undefined ? null : Number(v); };
const round2 = (n) => Math.round(n * 100) / 100;

const BOUT_METRICS = {
  rounds_boxed:         { direction: 'higher', unit: '', definition: 'Total rounds completed (not knocked down or stopped early)' },
  knockdowns_scored:    { direction: 'higher', unit: '', definition: 'Knockdowns scored against opponent' },
  knockdowns_received:  { direction: 'lower',  unit: '', definition: 'Knockdowns received from opponent' },
  jabs_landed:          { direction: 'higher', unit: '', definition: 'Jabs landed (when CompuBox-style data available)' },
  jabs_attempted:       { direction: 'higher', unit: '', definition: 'Jabs attempted' },
  power_landed:         { direction: 'higher', unit: '', definition: 'Power punches landed' },
  power_attempted:      { direction: 'higher', unit: '', definition: 'Power punches attempted' },
  total_punches_landed: { direction: 'higher', unit: '', definition: 'Total punches landed (all types)' },
  total_punches_thrown: { direction: 'higher', unit: '', definition: 'Total punches thrown' },
  warnings:             { direction: 'lower',  unit: '', definition: 'Warnings and point deductions received' },
};

const pct = (landed, attempted) => (attempted > 0 ? Math.round((landed / attempted) * 1000) / 10 : null);

function matchWinRate(rows) {
  const decided = rows.filter((r) => r.result && !['unknown', 'nc', 'no_contest'].includes(r.result));
  const wins = decided.filter((r) => r.result === 'win').length;
  return { total: rows.length, decided: decided.length, wins, win_rate: decided.length ? Math.round((wins / decided.length) * 1000) / 10 : null };
}

function winMethodBreakdown(rows) {
  const methods = {};
  for (const r of rows) {
    if (r.result !== 'win') continue;
    const m = (r.win_method ?? 'unknown').toLowerCase().replace(/[\s-]+/g, '_');
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

  // Computed accuracy percentages
  const jabAcc = agg.totals.jabs_landed !== undefined && agg.totals.jabs_attempted ? pct(agg.totals.jabs_landed, agg.totals.jabs_attempted) : null;
  const powerAcc = agg.totals.power_landed !== undefined && agg.totals.power_attempted ? pct(agg.totals.power_landed, agg.totals.power_attempted) : null;
  const totalAcc = agg.totals.total_punches_landed !== undefined && agg.totals.total_punches_thrown ? pct(agg.totals.total_punches_landed, agg.totals.total_punches_thrown) : null;
  const accuracy = {};
  if (jabAcc !== null) accuracy.jab_accuracy = { value: jabAcc, unit: '%', direction: 'higher', definition: 'Jab connect percentage' };
  if (powerAcc !== null) accuracy.power_accuracy = { value: powerAcc, unit: '%', direction: 'higher', definition: 'Power punch connect percentage' };
  if (totalAcc !== null) accuracy.total_accuracy = { value: totalAcc, unit: '%', direction: 'higher', definition: 'Overall punch connect percentage' };

  return {
    evidence: evid,
    bouts: rows.length,
    win_rate: { ...matchWinRate(rows), direction: 'higher', unit: '%', definition: 'Bouts won as a percentage of decided bouts' },
    win_methods: winMethodBreakdown(rows),
    metrics: Object.keys(metrics).length ? metrics : null,
    punch_accuracy: Object.keys(accuracy).length ? accuracy : null,
    insufficient: rows.length < MIN_BOUTS,
  };
}

export async function compute(db, userId, { sportId, evidence = 'approved_competition', from = null, to = null }) {
  const limitations = [];

  async function loadOfficial() {
    const rows = await db.query(
      `SELECT gp.stats, g.starts_at::date AS played_on,
              CASE c.outcome WHEN 'win' THEN 'win' WHEN 'loss' THEN 'loss' ELSE NULL END AS result,
              coalesce(gp.stats->>'win_method', gp.stats->>'result_method') AS win_method
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
              m.result, coalesce(m.stats_snapshot->>'win_method', m.stats_snapshot->>'result_method') AS win_method
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

  return { sport: 'boxing', calc_version: CALC_VERSION, period: { from, to }, tracks, limitations };
}
