// Academy OS 3/3: management-accounting PROJECTIONS over the canonical records. Nothing here moves or stores money. Revenue comes from
// academy_charges (the fee snapshot) and payments (provider cash and refunds); costs come from academy_cost_entries, which are labelled
// management entries because no payroll/timesheet source exists until Academy OS 2/3. Each currency is reported on its own and is never
// summed with another. A figure that cannot be known from data is null ("missing"), never 0.
import { many, one } from './db.js';

export const DEFINITIONS = {
  basis: 'Management view, not statutory accounts. Revenue is on an invoice (accrual-like) basis by charge due date; cash is on a cash basis by payment date.',
  gross_billed: 'Sum of charge gross amounts due in the period (cancelled charges excluded).',
  discounts: 'Sibling / multi-programme discounts on those charges.',
  funded: 'Scholarship, bursary and sponsor-funded part of those charges, shown separately by source.',
  net_invoiced: 'Amount the payer owes: gross - discounts - funded (includes tax).',
  refunds: 'Refunded amount on payments for those charges.',
  management_revenue: 'gross billed - discounts - tax - refunds. The funded part counts as revenue because a funder carries it.',
  cash_collected: 'Provider payments received in the period (paid_at); cash_refunded is refunds made in the period.',
  outstanding: 'Net invoiced amount of those charges still awaiting payment.',
  direct_costs: 'Management cost entries (staff, venue, other direct) incurred in the period and attached to the programme.',
  contribution: 'management revenue - known direct costs. Marked incomplete while a cost category has no entries.',
  allocated_overhead: 'Overhead entries spread by the entry\'s own rule (participants, revenue share or explicit split).',
  operating_result: 'contribution - allocated overhead.',
  margin_pct: 'operating result / management revenue, only when the cost picture is complete.',
};

const n = (v) => (v == null ? null : Number(v));
/** A percentage (0-100) to `dp` places; null when either side is missing or the denominator is 0. */
export const ratio = (a, b, dp = 1) => (a == null || b == null || !Number(b) ? null : Math.round((Number(a) / Number(b)) * 100 * 10 ** dp) / 10 ** dp);
const per = (a, b) => (a == null || !b ? null : Math.round(Number(a) / Number(b)));
const sum = (arr) => arr.reduce((s, x) => s + x, 0);

const CHARGE_BASE = `
  FROM academy_charges ch LEFT JOIN org_enrolments e ON e.id=ch.enrolment_id LEFT JOIN academy_applications a ON a.id=ch.application_id`;

export async function pnl(orgId, { from, to, programmeId = null, sport = null } = {}) {
  const programmes = await many('SELECT id, title, sport, capacity, status FROM academy_programmes WHERE organisation_id=$1 ORDER BY title, id', [orgId]);
  const byId = new Map(programmes.map((p) => [p.id, p]));
  const charges = await many(
    `SELECT ch.id, ch.currency, ch.status, ch.gross_minor, ch.discount_minor, ch.funded_minor, ch.funding_source, ch.tax_minor, ch.amount_minor, coalesce(e.programme_id, a.programme_id) AS programme_id, coalesce(e.user_id, a.athlete_id) AS athlete_id,
            coalesce(p.refunded, 0) AS refunded_minor
       ${CHARGE_BASE}
       LEFT JOIN LATERAL (SELECT sum(refunded_cents) AS refunded FROM payments WHERE purpose_type='academy_charge' AND purpose_id=ch.id AND status IN ('paid','refunded')) p ON true
      WHERE ch.organisation_id=$1 AND ch.due_on BETWEEN $2 AND $3 AND ch.status <> 'cancelled'`, [orgId, from, to]);
  const cashIn = await many(
    `SELECT pay.currency, coalesce(e.programme_id, a.programme_id) AS programme_id, sum(pay.amount_cents)::bigint AS collected
       FROM payments pay JOIN academy_charges ch ON ch.id=pay.purpose_id ${CHARGE_BASE.replace('FROM academy_charges ch ', '')}
      WHERE pay.purpose_type='academy_charge' AND ch.organisation_id=$1 AND pay.status IN ('paid','refunded') AND pay.paid_at::date BETWEEN $2 AND $3 GROUP BY 1, 2`, [orgId, from, to]);
  const cashOut = await many(
    `SELECT pay.currency, coalesce(e.programme_id, a.programme_id) AS programme_id, sum(pay.refunded_cents)::bigint AS refunded
       FROM payments pay JOIN academy_charges ch ON ch.id=pay.purpose_id ${CHARGE_BASE.replace('FROM academy_charges ch ', '')}
      WHERE pay.purpose_type='academy_charge' AND ch.organisation_id=$1 AND pay.refunded_cents > 0 AND pay.refunded_at::date BETWEEN $2 AND $3 GROUP BY 1, 2`, [orgId, from, to]);
  const costs = await many('SELECT * FROM academy_cost_entries WHERE organisation_id=$1 AND voided_at IS NULL AND incurred_on BETWEEN $2 AND $3 ORDER BY incurred_on, id', [orgId, from, to]);
  const participants = new Map((await many(
    `SELECT e.programme_id, count(DISTINCT e.user_id)::int AS n FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id
      WHERE k.organisation_id=$1 AND e.programme_id IS NOT NULL AND e.enrolled_at::date <= $3 AND (e.withdrawn_at IS NULL OR e.withdrawn_at::date >= $2) GROUP BY 1`, [orgId, from, to])).map((r) => [r.programme_id, r.n]));
  const sessions = new Map((await many(
    `SELECT k.programme_id, count(DISTINCT (a.cohort_id, a.session_date))::int AS n FROM org_attendance a JOIN org_cohorts k ON k.id=a.cohort_id
      WHERE k.organisation_id=$1 AND k.programme_id IS NOT NULL AND a.session_date BETWEEN $2 AND $3 GROUP BY 1`, [orgId, from, to])).map((r) => [r.programme_id, r.n]));

  const cur = new Map(); // currency -> programme_id -> row
  const row = (c, pid) => {
    if (!cur.has(c)) cur.set(c, new Map());
    const m = cur.get(c);
    if (!m.has(pid)) m.set(pid, { programme_id: pid, gross: 0, discounts: 0, funded: { scholarship: 0, bursary: 0, sponsor: 0 }, net_invoiced: 0, tax: 0, refunds: 0, outstanding: 0, cash_collected: 0, cash_refunded: 0, athletes: new Set(), cost: { staff: null, venue: null, other_direct: null }, overhead: 0, charge_count: 0, cost_count: 0 });
    return m.get(pid);
  };
  for (const ch of charges) {
    const r = row(ch.currency, ch.programme_id);
    r.charge_count++; r.gross += n(ch.gross_minor); r.discounts += n(ch.discount_minor); r.net_invoiced += n(ch.amount_minor); r.tax += n(ch.tax_minor); r.refunds += n(ch.refunded_minor);
    if (ch.funding_source) r.funded[ch.funding_source] += n(ch.funded_minor);
    if (ch.status === 'awaiting_payment') r.outstanding += n(ch.amount_minor);
    if (ch.athlete_id) r.athletes.add(ch.athlete_id);
  }
  for (const c of cashIn) row(c.currency, c.programme_id).cash_collected += n(c.collected);
  for (const c of cashOut) row(c.currency, c.programme_id).cash_refunded += n(c.refunded);
  for (const ce of costs.filter((x) => x.category !== 'overhead')) {
    const r = row(ce.currency, ce.programme_id);
    r.cost[ce.category] = (r.cost[ce.category] ?? 0) + n(ce.amount_minor); r.cost_count++;
  }
  const finish = (r, c) => {
    const revenue = r.gross - r.discounts - r.tax - r.refunds;
    const known = sum(Object.values(r.cost).map((v) => v ?? 0));
    const missing = Object.entries(r.cost).filter(([, v]) => v == null).map(([k]) => k);
    const complete = r.cost.staff != null; // venue / other may honestly be nil; staff cost is the one that must be entered
    return { revenue, known, missing, complete };
  };
  // overhead spread across programmes of the same currency
  const unallocated = new Map();
  for (const ce of costs.filter((x) => x.category === 'overhead')) {
    const m = cur.get(ce.currency) ?? (cur.set(ce.currency, new Map()), cur.get(ce.currency));
    const rows = [...m.values()].filter((r) => r.programme_id);
    const rev = (r) => Math.max(0, r.gross - r.discounts - r.tax - r.refunds);
    let weights = [];
    const a = ce.allocation ?? {};
    if (a.method === 'participants') weights = rows.map((r) => [r, participants.get(r.programme_id) ?? 0]);
    else if (a.method === 'revenue_share') weights = rows.map((r) => [r, rev(r)]);
    else if (a.method === 'split') weights = (a.splits ?? []).map((s) => [row(ce.currency, s.programme_id), s.pct]);
    const total = sum(weights.map(([, w]) => w));
    if (!total) { unallocated.set(ce.currency, (unallocated.get(ce.currency) ?? 0) + n(ce.amount_minor)); continue; }
    let left = n(ce.amount_minor);
    weights.forEach(([r, w], idx) => { const share = idx === weights.length - 1 ? left : Math.round((n(ce.amount_minor) * w) / total); r.overhead += share; left -= share; });
  }

  const out = [];
  for (const [currency, m] of [...cur.entries()].sort(([x], [y]) => x.localeCompare(y))) {
    let rows = [...m.values()].map((r) => {
      const p = byId.get(r.programme_id);
      const f = finish(r, currency);
      const contribution = f.revenue - f.known;
      const operating = contribution - r.overhead;
      const athletes = r.athletes.size;
      const sess = sessions.get(r.programme_id) ?? 0;
      return {
        programme_id: r.programme_id, title: p?.title ?? 'Charges not linked to a programme', sport: p?.sport ?? null,
        gross_billed_minor: r.gross, discounts_minor: r.discounts, funded_minor: r.funded, net_invoiced_minor: r.net_invoiced, tax_minor: r.tax, refunds_minor: r.refunds,
        management_revenue_minor: f.revenue, cash_collected_minor: r.cash_collected, cash_refunded_minor: r.cash_refunded, outstanding_minor: r.outstanding,
        staff_cost_minor: r.cost.staff, venue_cost_minor: r.cost.venue, other_direct_cost_minor: r.cost.other_direct, missing_costs: f.missing,
        contribution_minor: contribution, contribution_complete: f.complete, allocated_overhead_minor: r.overhead, operating_result_minor: operating,
        margin_pct: f.complete && f.revenue > 0 ? ratio(operating, f.revenue) : null,
        sources: { charges: r.charge_count, cost_entries: r.cost_count },
        unit: {
          capacity: p?.capacity ?? null, participants: participants.get(r.programme_id) ?? 0, utilisation_pct: p?.capacity ? ratio(participants.get(r.programme_id) ?? 0, p.capacity) : null,
          athletes_billed: athletes, sessions_delivered: sess || null,
          revenue_per_athlete_minor: per(f.revenue, athletes), revenue_per_session_minor: per(f.revenue, sess),
          staff_cost_per_athlete_minor: per(r.cost.staff, athletes), staff_cost_per_session_minor: per(r.cost.staff, sess), venue_cost_per_session_minor: per(r.cost.venue, sess),
          contribution_per_athlete_minor: f.complete ? per(contribution, athletes) : null, contribution_per_session_minor: f.complete ? per(contribution, sess) : null,
          break_even_participants: f.complete && athletes && f.revenue > 0 && f.known > 0 ? Math.ceil(f.known / (f.revenue / athletes)) : null,
          discount_and_funding_pct: ratio(r.discounts + sum(Object.values(r.funded)), r.gross), refund_rate_pct: ratio(r.refunds, r.cash_collected || null), receivable_rate_pct: ratio(r.outstanding, r.net_invoiced),
        },
      };
    });
    rows = rows.filter((r) => (!programmeId || r.programme_id === programmeId) && (!sport || r.sport === sport));
    const t = (k) => sum(rows.map((r) => r[k] ?? 0));
    const anyMissingStaff = rows.some((r) => !r.contribution_complete);
    const revenue = t('management_revenue_minor');
    const op = t('operating_result_minor') - (programmeId || sport ? 0 : unallocated.get(currency) ?? 0);
    out.push({
      currency,
      totals: {
        gross_billed_minor: t('gross_billed_minor'), discounts_minor: t('discounts_minor'), funded_minor: { scholarship: sum(rows.map((r) => r.funded_minor.scholarship)), bursary: sum(rows.map((r) => r.funded_minor.bursary)), sponsor: sum(rows.map((r) => r.funded_minor.sponsor)) },
        net_invoiced_minor: t('net_invoiced_minor'), tax_minor: t('tax_minor'), refunds_minor: t('refunds_minor'), management_revenue_minor: revenue, cash_collected_minor: t('cash_collected_minor'), cash_refunded_minor: t('cash_refunded_minor'), outstanding_minor: t('outstanding_minor'),
        staff_cost_minor: rows.some((r) => r.staff_cost_minor != null) ? sum(rows.map((r) => r.staff_cost_minor ?? 0)) : null, venue_cost_minor: rows.some((r) => r.venue_cost_minor != null) ? sum(rows.map((r) => r.venue_cost_minor ?? 0)) : null,
        other_direct_cost_minor: rows.some((r) => r.other_direct_cost_minor != null) ? sum(rows.map((r) => r.other_direct_cost_minor ?? 0)) : null,
        contribution_minor: t('contribution_minor'), allocated_overhead_minor: t('allocated_overhead_minor'), unallocated_overhead_minor: programmeId || sport ? null : unallocated.get(currency) ?? 0,
        operating_result_minor: op, margin_pct: !anyMissingStaff && revenue > 0 ? ratio(op, revenue) : null, cost_picture_complete: !anyMissingStaff,
      },
      programmes: rows,
    });
  }
  return { period: { from, to }, basis: { revenue: 'invoice (accrual-like) by charge due date', cash: 'cash by payment date' }, definitions: DEFINITIONS, currencies: out };
}

const BUCKETS = [['not_yet_due', -Infinity, 0], ['d1_30', 1, 30], ['d31_60', 31, 60], ['d61_90', 61, 90], ['d90_plus', 91, Infinity]];

/** Receivables as of a date. A charge counts when it existed by then and was still unpaid on that day (paid later counts as outstanding then). Uses the charge terms as they stand now. */
export async function ageing(orgId, asOf, { lines = 0 } = {}) {
  const rows = await many(
    `SELECT ch.id, ch.currency, ch.kind, ch.due_on, ch.amount_minor, ch.status, coalesce(e.programme_id, a.programme_id) AS programme_id, pr.title AS programme, coalesce(e.user_id, a.athlete_id) AS athlete_id, u.display_name AS athlete_name,
            ($2::date - ch.due_on) AS days_past_due
       ${CHARGE_BASE} LEFT JOIN academy_programmes pr ON pr.id=coalesce(e.programme_id, a.programme_id) LEFT JOIN users u ON u.id=coalesce(e.user_id, a.athlete_id)
      WHERE ch.organisation_id=$1 AND ch.created_at::date <= $2 AND ch.amount_minor > 0 AND (ch.status='awaiting_payment' OR (ch.status IN ('paid','refunded') AND ch.paid_at::date > $2))
      ORDER BY ch.due_on, ch.id`, [orgId, asOf]);
  const cur = new Map();
  for (const r of rows) {
    if (!cur.has(r.currency)) cur.set(r.currency, { currency: r.currency, buckets: Object.fromEntries(BUCKETS.map(([k]) => [k, { count: 0, amount_minor: 0 }])), total_minor: 0, due_within_14_days_minor: 0, lines: [] });
    const c = cur.get(r.currency);
    const d = Number(r.days_past_due);
    const [key] = BUCKETS.find(([, lo, hi]) => d >= lo && d <= hi);
    c.buckets[key].count++; c.buckets[key].amount_minor += n(r.amount_minor); c.total_minor += n(r.amount_minor);
    if (d <= 0 && d >= -14) c.due_within_14_days_minor += n(r.amount_minor);
    if (c.lines.length < lines) c.lines.push({ source_type: 'academy_charge', source_id: r.id, kind: r.kind, due_on: r.due_on, days_past_due: Math.max(0, d), amount_minor: n(r.amount_minor), programme_id: r.programme_id, programme: r.programme, athlete_id: r.athlete_id, athlete_name: r.athlete_name });
  }
  return { as_of: asOf, basis: 'Net invoiced amount awaiting payment on that date, by days past due date. Not a statement of anyone\'s conduct.', currencies: [...cur.values()].sort((x, y) => x.currency.localeCompare(y.currency)) };
}

/** Every line behind a programme's P&L figures, each with its canonical source. */
export async function pnlLines(orgId, { from, to, programmeId, currency }) {
  const charges = await many(
    `SELECT 'academy_charge' AS source_type, ch.id AS source_id, ch.kind, ch.due_on AS on_date, ch.status, ch.gross_minor, ch.discount_minor, ch.funded_minor, ch.funding_source, ch.funding_sponsorship_id, ch.tax_minor, ch.amount_minor
       ${CHARGE_BASE} WHERE ch.organisation_id=$1 AND ch.due_on BETWEEN $2 AND $3 AND ch.status <> 'cancelled' AND ch.currency=$4 AND coalesce(e.programme_id, a.programme_id)=$5 ORDER BY ch.due_on, ch.id LIMIT 500`, [orgId, from, to, currency, programmeId]);
  const costs = await many(
    `SELECT 'academy_cost_entry' AS source_type, id AS source_id, category, incurred_on AS on_date, amount_minor, description, source_ref, allocation FROM academy_cost_entries
      WHERE organisation_id=$1 AND voided_at IS NULL AND incurred_on BETWEEN $2 AND $3 AND currency=$4 AND (programme_id=$5 OR (category='overhead' AND (allocation->>'method' <> 'split' OR allocation->'splits' @> jsonb_build_array(jsonb_build_object('programme_id', $5::text))) )) ORDER BY incurred_on, id LIMIT 500`, [orgId, from, to, currency, programmeId]);
  return { charges, cost_entries: costs };
}

/** Scenario maths. Pure: takes the baseline read from actuals plus editable assumptions, returns a separate projected result. Never writes to programmes, prices, payroll or bookings. */
export function runScenario(baseline, a) {
  const retained = Math.round((baseline.enrolled * a.renewal_pct) / 100);
  const wanted = retained + a.new_athletes + a.extra_cohorts * a.extra_cohort_size;
  const capacity = baseline.capacity == null ? null : baseline.capacity + a.extra_cohorts * a.extra_cohort_size;
  const athletes = capacity == null ? wanted : Math.min(wanted, capacity);
  const unit = baseline.fee_minor == null ? null : Math.round(baseline.fee_minor * (1 + a.price_change_pct / 100) * (1 - a.discount_pct / 100));
  const revenue = unit == null ? null : athletes * unit * a.billing_periods + a.scholarship_funding_minor;
  const staff = a.staff_cost_minor ?? baseline.staff_cost_per_period_minor, venue = a.venue_cost_minor ?? baseline.venue_cost_per_period_minor;
  const extra = a.extra_cohorts * a.extra_cohort_cost_minor;
  const missing = [staff == null ? 'staff' : null, venue == null ? 'venue' : null].filter(Boolean);
  const costs = (staff ?? 0) + (venue ?? 0) + extra;
  const contribution = revenue == null ? null : revenue - costs;
  return {
    athletes: { enrolled_now: baseline.enrolled, retained, wanted, projected: athletes, capacity, capped: athletes < wanted, waitlist_left: Math.max(0, wanted - athletes) },
    unit_price_minor: unit, revenue_minor: revenue, staff_cost_minor: staff, venue_cost_minor: venue, extra_cohort_cost_minor: extra, known_costs_minor: costs, missing_costs: missing,
    contribution_minor: contribution, contribution_complete: missing.length === 0 && revenue != null,
    break_even_athletes: unit && costs > 0 ? Math.ceil((costs - a.scholarship_funding_minor) / (unit * a.billing_periods)) : null,
    formulas: {
      athletes: 'retained = enrolled x renewal%; projected = retained + new + extra cohorts x size, capped at capacity (+ extra cohort seats)',
      revenue: 'projected athletes x unit price x (1 + price change%) x (1 - discount%) x billing periods + scholarship / sponsor funding',
      contribution: 'revenue - staff - venue - extra cohort cost (null staff/venue shown as missing, not 0)',
    },
  };
}

export async function scenarioBaseline(orgId, programmeId) {
  const p = await one('SELECT * FROM academy_programmes WHERE id=$1 AND organisation_id=$2', [programmeId, orgId]);
  if (!p) return null;
  const v = await one('SELECT * FROM academy_programme_versions WHERE programme_id=$1 ORDER BY version DESC LIMIT 1', [p.id]);
  const enrolled = (await one("SELECT count(*)::int AS n FROM org_enrolments WHERE programme_id=$1 AND status IN ('enrolled','paused')", [p.id])).n;
  const future = await one("SELECT coalesce(sum(ch.amount_minor),0)::bigint AS minor, count(*)::int AS n FROM academy_charges ch JOIN org_enrolments e ON e.id=ch.enrolment_id WHERE e.programme_id=$1 AND ch.status='awaiting_payment' AND ch.due_on >= current_date", [p.id]);
  const cost = Object.fromEntries((await many("SELECT category, sum(amount_minor)::bigint AS minor FROM academy_cost_entries WHERE programme_id=$1 AND voided_at IS NULL AND incurred_on >= current_date - 90 GROUP BY 1", [p.id])).map((r) => [r.category, Number(r.minor)]));
  return { programme_id: p.id, title: p.title, currency: v?.currency ?? null, fee_minor: v ? Number(v.fee_minor) : null, billing_model: v?.billing_model ?? null, capacity: p.capacity, enrolled,
    confirmed_future_invoices_minor: Number(future.minor), confirmed_future_invoices: future.n, staff_cost_per_period_minor: cost.staff ?? null, venue_cost_per_period_minor: cost.venue ?? null, source_period: 'last 90 days of cost entries; current enrolment; latest programme version' };
}
