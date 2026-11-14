// Judo performance analytics adapter.
// Covers judo, para-judo.
// IJF scoring: ippon (decisive), waza-ari (half-point; two = ippon), shido (penalty; 3 = hansoku-make).
// Win method breakdown: ippon / waza-ari / decision / walkover. Penalties direction: lower.
// Evidence tracks always separate.

export const CALC_VERSION = 'judo_v1';
const MIN_CONTESTS = 3;

const NUM = (obj, k) => { const v = obj?.[k]; return v === null || v === undefined ? null : Number(v); };
const round2 = (n) => Math.round(n * 100) / 100;

const CONTEST_METRICS = {
  ippon:              { direction: 'higher', unit: '', definition: 'Ippons scored (decisive single-throw/submission victory)' },
  waza_ari:           { direction: 'higher', unit: '', definition: 'Waza-ari scores (near-ippon; two = ippon)' },
  shido_given:        { direction: 'lower',  unit: '', definition: 'Shido penalties given to player' },
  shido_received:     { direction: 'higher', unit: '', definition: 'Shido penalties opponent received (beneficial to player)' },
  penalties_given:    { direction: 'lower',  unit: '', definition: 'Total penalties (shido + hansoku-make) given to player' },
  throws_attempted:   { direction: 'higher', unit: '', definition: 'Total throw attempts (when captured)' },
  throws_scored:      { direction: 'higher', unit: '', definition: 'Throws scoring ippon or waza-ari' },
  holds:              { direction: 'higher', unit: '', definition: 'Holds (osae-komi) successful' },
  submissions:        { direction: 'higher', unit: '', definition: 'Submissions (choke or arm-lock) successful' },
};

function matchWinRate(rows) {
  const decided = rows.filter((r) => r.result && r.result !== 'unknown');
  const wins = decided.filter((r) => r.result === 'win').length;
  return { total: rows.length, decided: decided.length, wins, win_rate: decided.length ? Math.round((wins / decided.length) * 1000) / 10 : null };
}

function winMethodBreakdown(rows) {
  const methods = {};
  for (const r of rows) {
    const m = (r.win_method ?? 'unknown').toLowerCase();
    methods[m] = (methods[m] ?? 0) + 1;
  }
  return methods;
}

function aggregate(rows) {
  const totals = {}, counts = {};
  for (const row of rows) {
    const stats = row.stats ?? row.stats_snapshot ?? {};
    for (const key of Object.keys(CONTEST_METRICS)) {
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
  if (rows.length < MIN_CONTESTS) {
    limitations.push(`${evid}: only ${rows.length} contest${rows.length === 1 ? '' : 's'} — ${MIN_CONTESTS} needed`);
  }
  const agg = aggregate(rows);
  const metrics = {};
  for (const [k, total] of Object.entries(agg.totals)) {
    const def = CONTEST_METRICS[k] ?? { direction: 'higher', unit: '', definition: k };
    metrics[k] = { value: total, per_contest: round2(total / rows.length), sample_size: agg.counts[k], ...def };
  }
  return {
    evidence: evid,
    contests: rows.length,
    win_rate: { ...matchWinRate(rows), direction: 'higher', unit: '%', definition: 'Contests won as a percentage of decided contests' },
    win_methods: winMethodBreakdown(rows.filter((r) => r.result === 'win')),
    metrics: Object.keys(metrics).length ? metrics : null,
    insufficient: rows.length < MIN_CONTESTS,
  };
}

export async function compute(db, userId, { sportId, evidence = 'approved_competition', from = null, to = null }) {
  const limitations = [];

  async function loadOfficial() {
    const rows = await db.query(
      `SELECT gp.stats, g.starts_at::date AS played_on,
              CASE c.outcome WHEN 'win' THEN 'win' WHEN 'loss' THEN 'loss' ELSE 'unknown' END AS result,
              gp.stats->>'win_method' AS win_method
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
              m.result, m.stats_snapshot->>'win_method' AS win_method
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
    else limitations.push('Self-reported track: no self-logged contest data in this period');
  }

  return { sport: 'judo', calc_version: CALC_VERSION, period: { from, to }, tracks, limitations };
}
