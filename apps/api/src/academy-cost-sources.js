// Academy OS 3/3: cost figures READ from the canonical Academy OS 2/3 and venue records. Nothing is copied or written here.
//  - staff cost  = approved payroll runs (academy_payroll_runs/lines), attributed through each timesheet's programme and work date;
//  - venue cost  = the confirmed venue booking line that hosts a session (session_venue_links), split exactly across the sessions sharing it.
// Every row carries its canonical source type/id so a P&L figure can be drilled to the record behind it. A figure that cannot be known
// is reported as missing (unpriced timesheets, sessions with no booking), never as zero. Currencies are never mixed.
import { many } from './db.js';

// Human corrections (#787) live in academy_cost_attributions, append-only; the newest decision for a source wins. A decision never edits the canonical record: it
// only says which programme / cohort a cost belongs to, that it is overhead, or which of two overlapping records the P&L should count.
export const decisionKey = (type, id) => `${type}:${id}`;
export async function loadDecisions(orgId) {
  const rows = await many('SELECT DISTINCT ON (source_type, source_id) * FROM academy_cost_attributions WHERE organisation_id=$1 ORDER BY source_type, source_id, version DESC', [orgId]);
  return new Map(rows.map((r) => [decisionKey(r.source_type, r.source_id), r]));
}
/** The cost-allocation version the figures were produced under: the number of decisions recorded for the organisation (0 = none yet). */
export async function allocationVersion(orgId) {
  return Number((await many('SELECT coalesce(max(version),0)::bigint AS v FROM academy_cost_attributions WHERE organisation_id=$1', [orgId]))[0].v);
}
/** Apply attribution decisions to derived rows that no canonical record could tie to a programme. Rows already tied to a programme are left exactly as the source says. */
function attribute(rows, decisions) {
  return rows.map((r) => {
    if (r.programme_id) return r;
    const d = decisions.get(decisionKey(r.source_type, r.source_id));
    if (!d) return r;
    if (d.decision === 'programme') return { ...r, programme_id: d.programme_id, cohort_id: d.cohort_id ?? r.cohort_id ?? null, decided: d.id };
    if (d.decision === 'overhead') return { ...r, overhead_method: d.overhead_method, decided: d.id };
    return r;
  });
}

/** Approved-payroll staff cost by currency and programme (programme null = "not tied to a programme"), one row per payroll line. */
export async function payrollCost(orgId, from, to, decisions = new Map()) {
  const rows = await many(
    `SELECT r.currency, t.programme_id, s.cohort_id, l.id AS line_id, r.id AS run_id, max(t.work_date) AS on_date, sum((d->>'amount_minor')::bigint)::bigint AS amount_minor, count(*)::int AS timesheets
       FROM academy_payroll_lines l JOIN academy_payroll_runs r ON r.id=l.run_id AND r.status='approved', jsonb_array_elements(l.detail) d
       JOIN academy_timesheets t ON t.id=(d->>'timesheet_id')::uuid LEFT JOIN academy_sessions s ON s.id=t.session_id
      WHERE r.organisation_id=$1 AND d ? 'timesheet_id' AND t.work_date BETWEEN $2 AND $3
      GROUP BY r.currency, t.programme_id, s.cohort_id, l.id, r.id ORDER BY r.currency, on_date, l.id`, [orgId, from, to]);
  // Adjustments (bonuses, deductions) belong to a person and a run, not a programme: kept visible as unattributed staff cost.
  const adj = await many(
    `SELECT r.currency, l.id AS line_id, r.id AS run_id, a.on_date, sum((d->>'amount_minor')::bigint)::bigint AS amount_minor
       FROM academy_payroll_lines l JOIN academy_payroll_runs r ON r.id=l.run_id AND r.status='approved', jsonb_array_elements(l.detail) d
       JOIN academy_pay_adjustments a ON a.id=(d->>'adjustment_id')::uuid
      WHERE r.organisation_id=$1 AND d ? 'adjustment_id' AND a.on_date BETWEEN $2 AND $3
      GROUP BY r.currency, l.id, r.id, a.on_date ORDER BY r.currency, a.on_date, l.id`, [orgId, from, to]);
  const unpriced = await many(
    `SELECT coalesce(sum(jsonb_array_length(unpriced)),0)::int AS n FROM academy_payroll_runs WHERE organisation_id=$1 AND status='approved' AND period_start <= $3 AND period_end >= $2`, [orgId, from, to]);
  const toCost = (x, programme_id) => ({ category: 'staff', currency: x.currency, programme_id, cohort_id: x.cohort_id ?? null, amount_minor: Number(x.amount_minor), on_date: x.on_date, source_type: 'academy_payroll_line', source_id: x.line_id, run_id: x.run_id });
  return {
    rows: attribute([...rows.map((x) => toCost(x, x.programme_id)), ...adj.map((x) => ({ ...toCost(x, null), adjustment: true }))], decisions),
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
export function mergeCosts(manual, derived, keep = new Set()) {
  const key = (c) => `${c.currency}|${c.programme_id ?? ''}|${c.category}`;
  const covered = new Set(derived.filter((d) => d.programme_id).map(key));
  const supplier = derived.filter((d) => d.category === 'supplier');
  const dayMs = (d) => new Date(d).getTime();
  // a manual "other direct" entry that repeats a delivered supplier request (same currency and amount, within 45 days) is the same money: the supplier record wins unless a person keeps the manual one
  const dupOfSupplier = (m) => m.category === 'other_direct' && supplier.some((d) => d.currency === m.currency && d.amount_minor === Number(m.amount_minor) && Math.abs(dayMs(d.on_date) - dayMs(m.incurred_on)) <= 45 * 864e5);
  const kept = [], superseded = [];
  for (const m of manual) ((m.category !== 'overhead' && covered.has(key(m)) || dupOfSupplier(m)) && !keep.has(m.id) ? superseded : kept).push(m);
  return { manual: kept, superseded };
}

/** venue id -> the one live branch that lists it. A venue listed by two branches is ambiguous, so it is absent: cost there is "unknown branch", never guessed. */
export async function venueBranches(orgId) {
  const rows = await many('SELECT id, venue_ids FROM academy_branches WHERE organisation_id=$1 AND archived_at IS NULL', [orgId]);
  const seen = new Map();
  for (const b of rows) for (const v of b.venue_ids) seen.set(v, seen.has(v) ? null : b.id);
  return new Map([...seen].filter(([, b]) => b));
}

/**
 * Supplier spend: the final cost of a request that was delivered or done (academy_supplier_requests.actual_cost_minor), on the day it was delivered. A request
 * belongs to a venue (hence a branch) but to no programme, so it is unattributed until a person attributes it. If the person decided the manual entry is the
 * right record (keep_manual) the request is left out so the same money is not counted twice.
 */
export async function supplierCost(orgId, from, to, decisions = new Map()) {
  const rows = await many(
    `SELECT q.id, q.currency, q.actual_cost_minor, q.delivered_at::date AS on_date, q.venue_id, q.supplier_id, q.invoice_ref, q.title
       FROM academy_supplier_requests q
      WHERE q.organisation_id=$1 AND q.status IN ('delivered','done') AND q.actual_cost_minor > 0 AND q.currency IS NOT NULL AND q.delivered_at::date BETWEEN $2 AND $3 ORDER BY q.delivered_at, q.id`, [orgId, from, to]);
  const vb = await venueBranches(orgId);
  const out = rows.filter((x) => decisions.get(decisionKey('academy_supplier_request', x.id))?.decision !== 'keep_manual')
    .map((x) => ({ category: 'supplier', currency: x.currency, programme_id: null, cohort_id: null, venue_id: x.venue_id, branch_id: x.venue_id ? vb.get(x.venue_id) ?? null : null, amount_minor: Number(x.actual_cost_minor), on_date: x.on_date, source_type: 'academy_supplier_request', source_id: x.id, invoice_ref: x.invoice_ref, label: x.title }));
  return { rows: attribute(out, decisions) };
}

/** Payment-provider fees on academy charge payments, read from the canonical ledger (fin_transactions.fee_minor). A fee follows its charge to the programme and cohort. */
export async function paymentFeeCost(orgId, from, to, decisions = new Map()) {
  const rows = await many(
    `SELECT f.id, f.currency, f.fee_minor, f.occurred_at::date AS on_date, f.source_id AS charge_id, f.payment_id, coalesce(e.programme_id, a.programme_id) AS programme_id, e.cohort_id
       FROM fin_transactions f JOIN academy_charges ch ON ch.id=f.source_id AND ch.organisation_id=$1
       LEFT JOIN org_enrolments e ON e.id=ch.enrolment_id LEFT JOIN academy_applications a ON a.id=ch.application_id
      WHERE f.kind='payment' AND f.source_type='academy_charge' AND f.status='settled' AND f.fee_minor > 0 AND f.occurred_at::date BETWEEN $2 AND $3 ORDER BY f.occurred_at, f.id`, [orgId, from, to]);
  return { rows: rows.map((x) => {
    const d = decisions.get(decisionKey('academy_charge', x.charge_id));
    const programme_id = x.programme_id ?? (d?.decision === 'programme' ? d.programme_id : null);
    return { category: 'payment_fee', currency: x.currency, programme_id, cohort_id: x.cohort_id ?? (d?.decision === 'programme' ? d.cohort_id : null) ?? null, amount_minor: Number(x.fee_minor), on_date: x.on_date, source_type: 'fin_transaction', source_id: x.id, payment_id: x.payment_id, charge_id: x.charge_id };
  }) };
}
