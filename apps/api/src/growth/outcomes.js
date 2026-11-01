// Experiment outcomes (#73): what "success" and "guardrail" mean for a person who was shown an experiment. Each is a yes/no per person over the window
// that starts at their first exposure, decided from the canonical records (never from telemetry), so a replayed event cannot move a result.
// `better` says which direction is good, so a guardrail knows what counts as harm.
import { completedActivitySql } from '../kpi/activity.js';

// t0/t1 = the person's exposure window; x.user_id the person.
export const OUTCOMES = {
  completed_activity: { label: 'Completes an activity', better: 'higher',
    sql: 'EXISTS (SELECT 1 FROM act a WHERE a.user_id = x.user_id AND a.at >= x.t0 AND a.at < x.t1)' },
  repeat_participation: { label: 'Takes part on two different days', better: 'higher',
    sql: '(SELECT count(DISTINCT a.at::date) FROM act a WHERE a.user_id = x.user_id AND a.at >= x.t0 AND a.at < x.t1) >= 2' },
  payment_failure: { label: 'Has a failed payment', better: 'lower',
    sql: "EXISTS (SELECT 1 FROM payments p WHERE p.payer_id = x.user_id AND p.status = 'failed' AND p.created_at >= x.t0 AND p.created_at < x.t1)" },
  booking_failure: { label: 'Has a booking that fails', better: 'lower',
    sql: "EXISTS (SELECT 1 FROM bookings b WHERE b.user_id = x.user_id AND b.starts_at >= x.t0 AND b.starts_at < x.t1 AND b.status IN ('no_show','cancelled') AND NOT (b.status = 'cancelled' AND b.cancelled_by = b.user_id))" },
};
export const OUTCOME_KEYS = Object.keys(OUTCOMES);

/** One row per variant: exposed people, how many have finished their window (mature), and how many of those met each outcome. */
export function outcomesSql(keys) {
  const cols = keys.map((k) => `count(*) FILTER (WHERE x.t1 <= now() AND ${OUTCOMES[k].sql})::int AS o_${k}`).join(', ');
  return `WITH act AS (${completedActivitySql()}),
    x AS (SELECT e.user_id, e.variant, e.first_exposed_at AS t0, e.first_exposed_at + make_interval(days => $2::int) AS t1
            FROM experiment_exposures e JOIN analytics_consents c ON c.user_id = e.user_id AND c.granted WHERE e.experiment_id = $1)
    SELECT x.variant, count(*)::int AS exposed, count(*) FILTER (WHERE x.t1 <= now())::int AS mature${cols ? `, ${cols}` : ''} FROM x GROUP BY x.variant`;
}

/** 95% Wilson score interval for k of n (percent, one decimal); null when there is nobody to measure. */
export function wilson(k, n) {
  if (!n) return { rate: null, low: null, high: null };
  const z = 1.96, p = k / n, d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d, half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  const pc = (v) => Math.round(v * 1000) / 10;
  return { rate: pc(p), low: pc(Math.max(0, centre - half)), high: pc(Math.min(1, centre + half)) };
}
