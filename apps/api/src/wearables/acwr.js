// ACWR (Acute:Chronic Workload Ratio) and readiness composite (#583 elite extensions).
// ACWR = 7-day avg training load / 28-day avg training load. This is the sport-science
// gold standard for load management, used by elite academies worldwide.
// NOTHING here makes a diagnosis, predicts injury or clears an athlete to play.
import { one, many } from '../db.js';
import { METRICS } from './normalise.js';

/** ACWR zone thresholds — these are load zones, never medical categories. */
export const ACWR_ZONES = { underload: [0, 0.8], optimal: [0.8, 1.3], caution: [1.3, 1.5], excessive: [1.5, Infinity] };
export function acwrZone(ratio) {
  if (ratio === null) return 'no_data';
  if (ratio < 0.8) return 'underload';
  if (ratio <= 1.3) return 'optimal';
  if (ratio <= 1.5) return 'caution';
  return 'excessive';
}

const r3 = (n) => (n === null || n === undefined ? null : Math.round(Number(n) * 1000) / 1000);
const r1 = (n) => (n === null || n === undefined ? null : Math.round(Number(n) * 10) / 10);

/**
 * Compute ACWR for a single user from wearable_metrics (training_load) + session_rpe_logs.
 * Uses up to 35 days of history (28 chronic window + 7 acute window).
 * sRPE load = rpe × duration_minutes (session RPE method, Bannister 1991).
 */
export async function computeACWR(userId) {
  // Combined daily training load: wearable device load + sRPE-derived load
  const rows = await many(
    `SELECT day, sum(load)::float AS load FROM (
       -- device-sourced training load (sum across providers per day)
       SELECT recorded_on::text AS day, SUM(value) AS load
         FROM wearable_metrics
         WHERE user_id=$1 AND metric_key='training_load' AND recorded_on > current_date - 35
         GROUP BY recorded_on
       UNION ALL
       -- sRPE load (rpe × duration_minutes = arbitrary units, same scale as training_load)
       SELECT logged_on::text AS day, SUM(rpe * duration_minutes) AS load
         FROM session_rpe_logs
         WHERE user_id=$1 AND archived_at IS NULL AND logged_on > current_date - 35
         GROUP BY logged_on
     ) combined
     GROUP BY day ORDER BY day`,
    [userId],
  );
  const byDay = new Map(rows.map((r) => [r.day, r.load]));
  const acute = avgOver(byDay, 7);
  const chronic = avgOver(byDay, 28);
  const ratio = chronic > 0 ? r3(acute / chronic) : null;
  return { acute: r1(acute), chronic: r1(chronic), ratio, zone: acwrZone(ratio), days_with_data: byDay.size };
}

function avgOver(byDay, windowDays) {
  let sum = 0, count = 0;
  for (let i = 0; i < windowDays; i++) {
    const d = dateOffset(i);
    if (byDay.has(d)) { sum += byDay.get(d); count++; }
  }
  return count ? sum / windowDays : 0; // days with no data contribute 0 (not excluded)
}

function dateOffset(daysAgo) {
  const d = new Date(); d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

/**
 * Compute ACWR for a list of athlete ids (for the team heatmap).
 * Returns one entry per athlete with per-day load for the last N days.
 */
export async function computeTeamACWR(athleteIds, days = 14) {
  if (!athleteIds.length) return [];
  const results = [];
  for (const uid of athleteIds) {
    const dailyRows = await many(
      `SELECT day, sum(load)::float AS load FROM (
         SELECT recorded_on::text AS day, SUM(value) AS load
           FROM wearable_metrics
           WHERE user_id=$1 AND metric_key='training_load' AND recorded_on > current_date - $2::int
           GROUP BY recorded_on
         UNION ALL
         SELECT logged_on::text AS day, SUM(rpe * duration_minutes) AS load
           FROM session_rpe_logs
           WHERE user_id=$1 AND archived_at IS NULL AND logged_on > current_date - $2::int
           GROUP BY logged_on
       ) c GROUP BY day ORDER BY day`,
      [uid, days + 21], // +21 for the chronic window
    );
    const byDay = new Map(dailyRows.map((r) => [r.day, r.load]));
    const acute = avgOver(byDay, 7);
    const chronic = avgOver(byDay, 28);
    const ratio = chronic > 0 ? r3(acute / chronic) : null;
    // Per-day load for the visible window
    const daily = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = dateOffset(i);
      daily.push({ date: d, load: byDay.get(d) ?? null, zone: byDay.has(d) ? null : 'no_data' });
    }
    results.push({ user_id: uid, acute: r1(acute), chronic: r1(chronic), ratio, zone: acwrZone(ratio), daily });
  }
  return results;
}

/**
 * Compute readiness composite (0–100) from the last 7 days of HRV, sleep and resting HR.
 * Higher HRV → better. More sleep → better. Lower resting HR → better.
 * Weights: HRV 40%, sleep 30%, resting HR 30%.
 * Direction: compare 7-day avg to prior 7-day avg.
 * NOT a medical clearance. Never returns a fitness-to-play verdict.
 */
export async function computeReadiness(userId) {
  const NOT_MEDICAL = 'A training readiness indicator only. Not a diagnosis, medical clearance or fitness-to-play verdict.';
  async function stats(metric) {
    return one(
      `SELECT
         AVG(value) FILTER (WHERE recorded_on > current_date - 7)::float AS recent,
         AVG(value) FILTER (WHERE recorded_on <= current_date - 7 AND recorded_on > current_date - 14)::float AS prior,
         COUNT(*) FILTER (WHERE recorded_on > current_date - 7)::int AS n
       FROM wearable_metrics WHERE user_id=$1 AND metric_key=$2 AND recorded_on > current_date - 14`,
      [userId, metric],
    );
  }
  const [hrv, sleep, hr] = await Promise.all([stats('hrv_rmssd'), stats('sleep_duration'), stats('resting_hr')]);

  const components = [];

  // HRV: scale over physiological range 5–300 ms. Higher = better readiness.
  if (hrv.n >= 2) {
    const score = Math.min(100, Math.max(0, Math.round(((hrv.recent - 5) / (300 - 5)) * 100)));
    const delta = hrv.prior ? hrv.recent - hrv.prior : null;
    components.push({ key: 'hrv_rmssd', label: METRICS.hrv_rmssd.label, unit: METRICS.hrv_rmssd.unit, value: r1(hrv.recent), score, delta: r1(delta), weight: 0.4 });
  }
  // Sleep: target 8h = 100 pts. Scale 0–10h.
  if (sleep.n >= 2) {
    const score = Math.min(100, Math.max(0, Math.round((sleep.recent / 10) * 100)));
    const delta = sleep.prior ? sleep.recent - sleep.prior : null;
    components.push({ key: 'sleep_duration', label: METRICS.sleep_duration.label, unit: METRICS.sleep_duration.unit, value: r1(sleep.recent), score, delta: r1(delta), weight: 0.3 });
  }
  // Resting HR: lower is better. Scale inverted: 25 bpm = 100 pts, 140 bpm = 0 pts.
  if (hr.n >= 2) {
    const score = Math.min(100, Math.max(0, Math.round(((140 - hr.recent) / (140 - 25)) * 100)));
    const delta = hr.prior ? hr.prior - hr.recent : null; // improvement = HR fell
    components.push({ key: 'resting_hr', label: METRICS.resting_hr.label, unit: METRICS.resting_hr.unit, value: r1(hr.recent), score, delta: r1(delta), weight: 0.3 });
  }

  if (!components.length) return { score: null, direction: 'no_data', components: [], basis: NOT_MEDICAL };

  // Weighted average over the components that have data, re-normalising weights
  const totalWeight = components.reduce((s, c) => s + c.weight, 0);
  const score = Math.round(components.reduce((s, c) => s + c.score * (c.weight / totalWeight), 0));
  const improving = components.filter((c) => c.delta !== null && c.delta > 0).length;
  const declining = components.filter((c) => c.delta !== null && c.delta < 0).length;
  const direction = improving > declining ? 'improving' : declining > improving ? 'declining' : 'stable';
  return { score, direction, components: components.map(({ weight: _, ...rest }) => rest), basis: NOT_MEDICAL };
}
