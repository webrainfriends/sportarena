// Academy OS 3/3: cost figures READ from the canonical Academy OS 2/3 and venue records. Nothing is copied or written here.
//  - staff cost  = approved payroll runs (academy_payroll_runs/lines), attributed through each timesheet's programme and work date;
//  - venue cost  = the confirmed venue booking line that hosts a session (session_venue_links), split exactly across the sessions sharing it.
// Every row carries its canonical source type/id so a P&L figure can be drilled to the record behind it. A figure that cannot be known
// is reported as missing (unpriced timesheets, sessions with no booking), never as zero. Currencies are never mixed.
import { many } from './db.js';

/** Approved-payroll staff cost by currency and programme (programme null = "not tied to a programme"), one row per payroll line. */
export async function payrollCost(orgId, from, to) {
  const rows = await many(
    `SELECT r.currency, t.programme_id, l.id AS line_id, r.id AS run_id, max(t.work_date) AS on_date, sum((d->>'amount_minor')::bigint)::bigint AS amount_minor, count(*)::int AS timesheets
       FROM academy_payroll_lines l JOIN academy_payroll_runs r ON r.id=l.run_id AND r.status='approved', jsonb_array_elements(l.detail) d
       JOIN academy_timesheets t ON t.id=(d->>'timesheet_id')::uuid
      WHERE r.organisation_id=$1 AND d ? 'timesheet_id' AND t.work_date BETWEEN $2 AND $3
      GROUP BY r.currency, t.programme_id, l.id, r.id ORDER BY r.currency, on_date, l.id`, [orgId, from, to]);
  // Adjustments (bonuses, deductions) belong to a person and a run, not a programme: kept visible as unattributed staff cost.
  const adj = await many(
    `SELECT r.currency, l.id AS line_id, r.id AS run_id, a.on_date, sum((d->>'amount_minor')::bigint)::bigint AS amount_minor
       FROM academy_payroll_lines l JOIN academy_payroll_runs r ON r.id=l.run_id AND r.status='approved', jsonb_array_elements(l.detail) d
       JOIN academy_pay_adjustments a ON a.id=(d->>'adjustment_id')::uuid
      WHERE r.organisation_id=$1 AND d ? 'adjustment_id' AND a.on_date BETWEEN $2 AND $3
      GROUP BY r.currency, l.id, r.id, a.on_date ORDER BY r.currency, a.on_date, l.id`, [orgId, from, to]);
  const unpriced = await many(
    `SELECT coalesce(sum(jsonb_array_length(unpriced)),0)::int AS n FROM academy_payroll_runs WHERE organisation_id=$1 AND status='approved' AND period_start <= $3 AND period_end >= $2`, [orgId, from, to]);
  const toCost = (x, programme_id) => ({ category: 'staff', currency: x.currency, programme_id, amount_minor: Number(x.amount_minor), on_date: x.on_date, source_type: 'academy_payroll_line', source_id: x.line_id, run_id: x.run_id });
  return {
    rows: [...rows.map((x) => toCost(x, x.programme_id)), ...adj.map((x) => ({ ...toCost(x, null), adjustment: true }))],
    unpriced_timesheets: unpriced[0]?.n ?? 0,
  };
}

/**
 * Venue cost of delivered/planned (not cancelled) academy sessions. A booking line's price is split exactly across the live session links that
 * share it (whole minor units, the remainder going to the first sessions by id), so the shares always add back to the booking price.
 * Sessions with no confirmed booking are counted in `unbooked_sessions` (cost missing, not zero).
 */
export async function venueCost(orgId, from, to) {
  const rows = await many(
    `WITH live AS (
       SELECT l.booking_id, l.session_id, l.id AS link_id, b.price_cents, rv.currency, res.venue_id,
              count(*) OVER (PARTITION BY l.booking_id)::int AS n, row_number() OVER (PARTITION BY l.booking_id ORDER BY l.session_id) AS rn
         FROM session_venue_links l JOIN bookings b ON b.id=l.booking_id AND b.status='confirmed' JOIN reservations rv ON rv.id=b.reservation_id JOIN resources res ON res.id=b.resource_id
        WHERE l.session_type='academy_session' AND l.released_at IS NULL AND b.price_cents IS NOT NULL)
     SELECT s.id AS session_id, s.programme_id, s.cohort_id, (s.starts_at AT TIME ZONE s.timezone)::date AS on_date, live.link_id, live.booking_id, live.venue_id, live.currency,
            (live.price_cents / live.n + CASE WHEN live.rn <= live.price_cents % live.n THEN 1 ELSE 0 END)::bigint AS amount_minor
       FROM academy_sessions s JOIN live ON live.session_id=s.id
      WHERE s.organisation_id=$1 AND s.status <> 'cancelled' AND (s.starts_at AT TIME ZONE s.timezone)::date BETWEEN $2 AND $3
      ORDER BY on_date, s.id`, [orgId, from, to]);
  const unbooked = await many(
    `SELECT s.programme_id, count(*)::int AS n FROM academy_sessions s
      WHERE s.organisation_id=$1 AND s.status <> 'cancelled' AND (s.starts_at AT TIME ZONE s.timezone)::date BETWEEN $2 AND $3
        AND NOT EXISTS (SELECT 1 FROM session_venue_links l JOIN bookings b ON b.id=l.booking_id AND b.status='confirmed' AND b.price_cents IS NOT NULL
                         WHERE l.session_type='academy_session' AND l.session_id=s.id AND l.released_at IS NULL)
      GROUP BY s.programme_id`, [orgId, from, to]);
  return {
    rows: rows.filter((x) => x.currency).map((x) => ({ category: 'venue', currency: x.currency, programme_id: x.programme_id, cohort_id: x.cohort_id, venue_id: x.venue_id, amount_minor: Number(x.amount_minor), on_date: x.on_date, source_type: 'venue_booking', source_id: x.booking_id, session_id: x.session_id, link_id: x.link_id })),
    unbooked_by_programme: new Map(unbooked.map((x) => [x.programme_id, x.n])),
    unbooked_sessions: unbooked.reduce((s, x) => s + x.n, 0),
  };
}

/**
 * Derived (canonical) cost rows win over manual management entries for the same currency + programme + category, so a period already covered by
 * payroll or a booking is never counted twice. Manual entries that are set aside are returned in `superseded` and stay visible in the lines.
 */
export function mergeCosts(manual, derived) {
  const key = (c) => `${c.currency}|${c.programme_id ?? ''}|${c.category}`;
  const covered = new Set(derived.filter((d) => d.programme_id).map(key));
  const kept = [], superseded = [];
  for (const m of manual) (m.category !== 'overhead' && covered.has(key(m)) ? superseded : kept).push(m);
  return { manual: kept, superseded };
}
