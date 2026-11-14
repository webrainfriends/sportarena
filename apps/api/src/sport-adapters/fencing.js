// Fencing performance analytics adapter.
// Covers fencing (all three weapons: foil, épée, sabre), wheelchair fencing.
// FIE scoring: touches scored/received; win by 15 touches (direct elimination) or most touches.
// Weapon splits always kept separate (foil/épée/sabre have different target areas and rules).
// Evidence tracks always separate.

export const CALC_VERSION = 'fencing_v1';
const MIN_BOUTS = 3;

const NUM = (obj, k) => { const v = obj?.[k]; return v === null || v === undefined ? null : Number(v); };
const round2 = (n) => Math.round(n * 100) / 100;

const BOUT_METRICS = {
  touches_scored:     { direction: 'higher', unit: '', definition: 'Touches (hits) scored on the opponent' },
  touches_received:   { direction: 'lower',  unit: '', definition: 'Touches received from the opponent' },
  touch_ratio:        { direction: 'higher', unit: '', definition: 'Touches scored / touches received ratio (> 1 = positive)' },
  cards_received:     { direction: 'lower',  unit: '', definition: 'Yellow and red cards received' },
};

function matchWinRate(rows) {
  const decided = rows.filter((r) => r.result && r.result !== 'unknown');
  const wins = decided.filter((r) => r.result === 'win').length;
  return { total: rows.length, decided: decided.length, wins, win_rate: decided.length ? Math.round((wins / decided.length) * 1000) / 10 : null };
}

function aggregate(rows) {
  const totals = {}, counts = {};
  for (const row of rows) {
    const stats = row.stats ?? row.stats_snapshot ?? {};
    // touch_ratio is computed, not stored
    const scored = NUM(stats, 'touches_scored');
    const received = NUM(stats, 'touches_received');
    for (const key of ['touches_scored', 'touches_received', 'cards_received']) {
      const v = NUM(stats, key);
      if (v !== null) {
        totals[key] = (totals[key] ?? 0) + v;
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
  }
  // Computed touch ratio from totals
  if (totals.touches_scored !== undefined && totals.touches_received !== undefined && totals.touches_received > 0) {
    totals.touch_ratio = round2(totals.touches_scored / totals.touches_received);
    counts.touch_ratio = counts.touches_scored;
  }
  return { totals, counts };
}

function weaponSplits(rows) {
  const byWeapon = {};
  for (const r of rows) {
    const w = (r.weapon ?? 'unknown').toLowerCase();
    if (!byWeapon[w]) byWeapon[w] = [];
    byWeapon[w].push(r);
  }
  return Object.fromEntries(
    Object.entries(byWeapon)
      .filter(([, rs]) => rs.length >= 2)
      .map(([w, rs]) => {
        const agg = aggregate(rs);
        return [w, {
          bouts: rs.length,
          ...matchWinRate(rs),
          touches_scored: agg.totals.touches_scored ?? null,
          touches_received: agg.totals.touches_received ?? null,
          touch_ratio: agg.totals.touch_ratio ?? null,
        }];
      })
  );
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
    metrics[k] = {
      value: total,
      ...(k !== 'touch_ratio' ? { per_bout: round2(total / rows.length) } : {}),
      sample_size: agg.counts[k],
      ...def,
    };
  }
  const splits = weaponSplits(rows);
  return {
    evidence: evid,
    bouts: rows.length,
    win_rate: { ...matchWinRate(rows), direction: 'higher', unit: '%', definition: 'Bouts won as a percentage of decided bouts' },
    metrics: Object.keys(metrics).length ? metrics : null,
    weapon_splits: Object.keys(splits).length ? splits : null,
    insufficient: rows.length < MIN_BOUTS,
  };
}

export async function compute(db, userId, { sportId, evidence = 'approved_competition', from = null, to = null }) {
  const limitations = [];

  async function loadOfficial() {
    const rows = await db.query(
      `SELECT gp.stats, g.starts_at::date AS played_on,
              CASE c.outcome WHEN 'win' THEN 'win' WHEN 'loss' THEN 'loss' ELSE 'unknown' END AS result,
              coalesce(gp.stats->>'weapon', gp.stats->>'format') AS weapon
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
              m.result, coalesce(m.stats_snapshot->>'weapon', m.match_type) AS weapon
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

  return { sport: 'fencing', calc_version: CALC_VERSION, period: { from, to }, tracks, limitations };
}
