// Academy OS 3/3: management-accounting PROJECTIONS over the canonical records. Nothing here moves or stores money. Revenue comes from
// academy_charges (the fee snapshot) and payments (provider cash and refunds); costs come from academy_cost_entries, which are labelled
// management entries ONLY where the canonical Academy OS 2/3 source has nothing for that programme: staff cost is read from approved payroll runs and
// venue cost from confirmed venue bookings (src/academy-cost-sources.js). Each currency is reported on its own and is never
// summed with another. A figure that cannot be known from data is null ("missing"), never 0.
import { many, one } from './db.js';
import { payrollCost, venueCost, supplierCost, paymentFeeCost, mergeCosts, loadDecisions, allocationVersion, decisionKey } from './academy-cost-sources.js';

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
  supplier_cost: 'Final cost of supplier requests that were delivered or done, on the delivery date. A request belongs to a venue (and so a branch) but to no programme: it stays unattributed until a person attributes it in the reconciliation queue.',
  payment_fees: 'Payment-provider fees on academy charge payments, read from the canonical Finance ledger and attributed with their charge. Revenue is gross, so a fee is a cost, never netted off revenue twice.',
  cohort: 'A cohort figure uses only records that name the cohort (its enrolments\' charges, timesheets of its sessions, bookings of its sessions). What cannot be tied to a cohort is shown as "not tied to a cohort" so the cohorts and the remainder add back to the programme; a cost category with no cohort-attributable record is unknown, not zero.',
  provenance: 'Every report states its basis, currency policy, cut-off time and cost-allocation version (the number of human attribution decisions in force). Decisions never change a canonical record.',
  direct_costs: 'Staff cost = approved payroll runs (by timesheet work date and programme). Venue cost = confirmed venue booking lines split across the sessions that share them (by session date, cancelled sessions excluded). Other direct cost, and any staff/venue cost with no canonical source for that programme, = management cost entries. A canonical source replaces manual entries for the same programme, currency and category, so nothing is counted twice.',
  branch: 'A programme belongs to at most one branch; a branch is the plain sum of its programmes. Programmes with no branch are shown as Unassigned.',
  unattributed_cost: 'Approved payroll adjustments and timesheets with no programme: real cost that cannot be tied to one programme. Shown separately and deducted from the organisation total, never spread silently.',
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

export async function pnl(orgId, { from, to, programmeId = null, sport = null, branchId = null } = {}) {
  const programmes = await many('SELECT id, title, sport, capacity, status, branch_id FROM academy_programmes WHERE organisation_id=$1 ORDER BY title, id', [orgId]);
  const branchNames = new Map((await many('SELECT id, name, archived_at FROM academy_branches WHERE organisation_id=$1', [orgId])).map((b) => [b.id, b]));
  const byId = new Map(programmes.map((p) => [p.id, p]));
  const cohortNames = new Map((await many('SELECT id, name FROM org_cohorts WHERE organisation_id=$1', [orgId])).map((k) => [k.id, k.name]));
  const charges = await many(
    `SELECT ch.id, ch.currency, ch.status, ch.gross_minor, ch.discount_minor, ch.funded_minor, ch.funding_source, ch.tax_minor, ch.amount_minor, ch.settled_minor, ch.adjusted_minor, coalesce(e.programme_id, a.programme_id) AS programme_id, e.cohort_id, coalesce(e.user_id, a.athlete_id) AS athlete_id,
            coalesce(p.refunded, 0) AS refunded_minor
       ${CHARGE_BASE}
       LEFT JOIN LATERAL (SELECT sum(refunded_cents) AS refunded FROM payments WHERE purpose_type='academy_charge' AND purpose_id=ch.id AND status IN ('paid','refunded')) p ON true
      WHERE ch.organisation_id=$1 AND ch.due_on BETWEEN $2 AND $3 AND ch.status <> 'cancelled'`, [orgId, from, to]);
  const cashIn = await many(
    `SELECT pay.currency, ch.id AS charge_id, coalesce(e.programme_id, a.programme_id) AS programme_id, sum(pay.amount_cents)::bigint AS collected
       FROM payments pay JOIN academy_charges ch ON ch.id=pay.purpose_id ${CHARGE_BASE.replace('FROM academy_charges ch ', '')}
      WHERE pay.purpose_type='academy_charge' AND ch.organisation_id=$1 AND pay.status IN ('paid','refunded') AND pay.paid_at::date BETWEEN $2 AND $3 GROUP BY 1, 2, 3`, [orgId, from, to]);
  const cashOut = await many(
    `SELECT pay.currency, ch.id AS charge_id, coalesce(e.programme_id, a.programme_id) AS programme_id, sum(pay.refunded_cents)::bigint AS refunded
       FROM payments pay JOIN academy_charges ch ON ch.id=pay.purpose_id ${CHARGE_BASE.replace('FROM academy_charges ch ', '')}
      WHERE pay.purpose_type='academy_charge' AND ch.organisation_id=$1 AND pay.refunded_cents > 0 AND pay.refunded_at::date BETWEEN $2 AND $3 GROUP BY 1, 2, 3`, [orgId, from, to]);
  const decisions = await loadDecisions(orgId);
  const decided = (type, id) => decisions.get(decisionKey(type, id));
  // a charge no record could tie to a programme can be attributed by a person; the charge itself is never edited
  const progOf = (chargeId, pid) => pid ?? (decided('academy_charge', chargeId)?.decision === 'programme' ? decided('academy_charge', chargeId).programme_id : null);
  const manualEntries = await many('SELECT * FROM academy_cost_entries WHERE organisation_id=$1 AND voided_at IS NULL AND incurred_on BETWEEN $2 AND $3 ORDER BY incurred_on, id', [orgId, from, to]);
  const manualAll = manualEntries.filter((m) => decided('academy_cost_entry', m.id)?.decision !== 'keep_canonical');
  const keepManual = new Set(manualEntries.filter((m) => decided('academy_cost_entry', m.id)?.decision === 'keep_manual').map((m) => m.id));
  const [payroll, venue, supplier, fees, allocVersion] = await Promise.all([payrollCost(orgId, from, to, decisions), venueCost(orgId, from, to), supplierCost(orgId, from, to, decisions), paymentFeeCost(orgId, from, to, decisions), allocationVersion(orgId)]);
  const derived = [...payroll.rows, ...venue.rows, ...supplier.rows, ...fees.rows];
  const { manual: kept, superseded } = mergeCosts(manualAll, derived, keepManual);
  // derived cost a person classed as overhead is spread by their chosen rule, like a manual overhead entry
  const costs = [...kept, ...derived.filter((d) => d.overhead_method && !d.programme_id).map((d) => ({ id: d.source_id, category: 'overhead', currency: d.currency, amount_minor: d.amount_minor, allocation: { method: d.overhead_method } }))];
  const unattributed = new Map(); // currency -> minor, cost with no programme
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
    if (!m.has(pid)) m.set(pid, { programme_id: pid, gross: 0, discounts: 0, funded: { scholarship: 0, bursary: 0, sponsor: 0 }, net_invoiced: 0, tax: 0, refunds: 0, outstanding: 0, cash_collected: 0, cash_refunded: 0, athletes: new Set(), cost: { staff: null, venue: null, other_direct: null, supplier: null, payment_fee: null }, overhead: 0, charge_count: 0, cost_count: 0, payroll_lines: 0, supplier_requests: 0, fee_lines: 0, venue_bookings: new Set() });
    return m.get(pid);
  };
  const cohortRows = new Map(); // currency -> cohort_id -> figures tied to that cohort
  const cohort = (cur2, cid, pid) => {
    if (!cohortRows.has(cur2)) cohortRows.set(cur2, new Map());
    const m = cohortRows.get(cur2);
    if (!m.has(cid)) m.set(cid, { cohort_id: cid, programme_id: pid, revenue: 0, athletes: new Set(), staff: null, venue: null, fee: null, charges: 0 });
    return m.get(cid);
  };
  const add = (o, k, v) => { o[k] = (o[k] ?? 0) + v; };
  for (const ch0 of charges) {
    const ch = { ...ch0, programme_id: progOf(ch0.id, ch0.programme_id) };
    const r = row(ch.currency, ch.programme_id);
    if (ch.cohort_id && ch.programme_id) { const k = cohort(ch.currency, ch.cohort_id, ch.programme_id); k.charges++; k.revenue += n(ch.gross_minor) - n(ch.discount_minor) - n(ch.tax_minor) - n(ch.refunded_minor); if (ch.athlete_id) k.athletes.add(ch.athlete_id); }
    r.charge_count++; r.gross += n(ch.gross_minor); r.discounts += n(ch.discount_minor); r.net_invoiced += n(ch.amount_minor); r.tax += n(ch.tax_minor); r.refunds += n(ch.refunded_minor);
    if (ch.funding_source) r.funded[ch.funding_source] += n(ch.funded_minor);
    if (ch.status === 'awaiting_payment') r.outstanding += n(ch.amount_minor) - n(ch.settled_minor) - n(ch.adjusted_minor);
    if (ch.athlete_id) r.athletes.add(ch.athlete_id);
  }
  for (const c of cashIn) row(c.currency, progOf(c.charge_id, c.programme_id)).cash_collected += n(c.collected);
  for (const c of cashOut) row(c.currency, progOf(c.charge_id, c.programme_id)).cash_refunded += n(c.refunded);
  const branchLevel = new Map(); // currency -> branch_id -> venue-level cost (supplier) that belongs to a branch but to no programme
  for (const ce of costs.filter((x) => x.category !== 'overhead')) {
    const r = row(ce.currency, ce.programme_id);
    r.cost[ce.category] = (r.cost[ce.category] ?? 0) + n(ce.amount_minor); r.cost_count++;
  }
  for (const d of derived) {
    if (!d.programme_id) {
      if (d.overhead_method) continue;   // spread as overhead below
      unattributed.set(d.currency, (unattributed.get(d.currency) ?? 0) + d.amount_minor);
      if (d.branch_id) { if (!branchLevel.has(d.currency)) branchLevel.set(d.currency, new Map()); const bm = branchLevel.get(d.currency); bm.set(d.branch_id, (bm.get(d.branch_id) ?? 0) + d.amount_minor); }
      continue;
    }
    const r = row(d.currency, d.programme_id);
    r.cost[d.category] = (r.cost[d.category] ?? 0) + d.amount_minor;
    if (d.category === 'staff') r.payroll_lines++; else if (d.category === 'venue') r.venue_bookings.add(d.source_id); else if (d.category === 'supplier') r.supplier_requests++; else r.fee_lines++;
    if (d.cohort_id) { const k = cohort(d.currency, d.cohort_id, d.programme_id); const f = { staff: 'staff', venue: 'venue', payment_fee: 'fee' }[d.category]; if (f) add(k, f, d.amount_minor); }
  }
  const finish = (r, c) => {
    const revenue = r.gross - r.discounts - r.tax - r.refunds;
    const known = sum(Object.values(r.cost).map((v) => v ?? 0));
    const missing = ['staff', 'venue', 'other_direct'].filter((k) => r.cost[k] == null);
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
        programme_id: r.programme_id, title: p?.title ?? 'Charges not linked to a programme', sport: p?.sport ?? null, branch_id: p?.branch_id ?? null,
        gross_billed_minor: r.gross, discounts_minor: r.discounts, funded_minor: r.funded, net_invoiced_minor: r.net_invoiced, tax_minor: r.tax, refunds_minor: r.refunds,
        management_revenue_minor: f.revenue, cash_collected_minor: r.cash_collected, cash_refunded_minor: r.cash_refunded, outstanding_minor: r.outstanding,
        staff_cost_minor: r.cost.staff, venue_cost_minor: r.cost.venue, other_direct_cost_minor: r.cost.other_direct, supplier_cost_minor: r.cost.supplier, payment_fee_minor: r.cost.payment_fee, missing_costs: f.missing,
        contribution_minor: contribution, contribution_complete: f.complete, allocated_overhead_minor: r.overhead, operating_result_minor: operating,
        margin_pct: f.complete && f.revenue > 0 ? ratio(operating, f.revenue) : null,
        sources: { charges: r.charge_count, cost_entries: r.cost_count, payroll_lines: r.payroll_lines, venue_bookings: r.venue_bookings.size, supplier_requests: r.supplier_requests, fee_lines: r.fee_lines },
        venue_sessions_unbooked: venue.unbooked_by_programme.get(r.programme_id) ?? 0,
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
    rows = rows.filter((r) => (!programmeId || r.programme_id === programmeId) && (!sport || r.sport === sport) && (!branchId || r.branch_id === branchId));
    const t = (k) => sum(rows.map((r) => r[k] ?? 0));
    const anyMissingStaff = rows.some((r) => !r.contribution_complete);
    const revenue = t('management_revenue_minor');
    const unattr = programmeId || sport || branchId ? null : unattributed.get(currency) ?? 0;
    const op = t('operating_result_minor') - (programmeId || sport || branchId ? 0 : (unallocated.get(currency) ?? 0) + unattr);
    out.push({
      currency,
      totals: {
        gross_billed_minor: t('gross_billed_minor'), discounts_minor: t('discounts_minor'), funded_minor: { scholarship: sum(rows.map((r) => r.funded_minor.scholarship)), bursary: sum(rows.map((r) => r.funded_minor.bursary)), sponsor: sum(rows.map((r) => r.funded_minor.sponsor)) },
        net_invoiced_minor: t('net_invoiced_minor'), tax_minor: t('tax_minor'), refunds_minor: t('refunds_minor'), management_revenue_minor: revenue, cash_collected_minor: t('cash_collected_minor'), cash_refunded_minor: t('cash_refunded_minor'), outstanding_minor: t('outstanding_minor'),
        staff_cost_minor: rows.some((r) => r.staff_cost_minor != null) ? sum(rows.map((r) => r.staff_cost_minor ?? 0)) : null, venue_cost_minor: rows.some((r) => r.venue_cost_minor != null) ? sum(rows.map((r) => r.venue_cost_minor ?? 0)) : null,
        other_direct_cost_minor: rows.some((r) => r.other_direct_cost_minor != null) ? sum(rows.map((r) => r.other_direct_cost_minor ?? 0)) : null,
        supplier_cost_minor: rows.some((r) => r.supplier_cost_minor != null) ? sum(rows.map((r) => r.supplier_cost_minor ?? 0)) : null, payment_fee_minor: rows.some((r) => r.payment_fee_minor != null) ? sum(rows.map((r) => r.payment_fee_minor ?? 0)) : null,
        contribution_minor: t('contribution_minor'), allocated_overhead_minor: t('allocated_overhead_minor'), unallocated_overhead_minor: programmeId || sport || branchId ? null : unallocated.get(currency) ?? 0, unattributed_cost_minor: unattr,
        operating_result_minor: op, margin_pct: !anyMissingStaff && revenue > 0 ? ratio(op, revenue) : null, cost_picture_complete: !anyMissingStaff,
      },
      programmes: rows,
      by_branch: byBranch(rows, branchNames, programmeId || sport || branchId ? new Map() : branchLevel.get(currency) ?? new Map()),
      by_cohort: byCohort(rows, cohortRows.get(currency) ?? new Map(), cohortNames),
    });
  }
  // a currency with only unattributed cost still needs its own block so the cost is not lost
  for (const [currency, minor] of unattributed) if (!out.some((o) => o.currency === currency) && !programmeId && !sport && !branchId) out.push({ currency, totals: { unattributed_cost_minor: minor, operating_result_minor: -minor - (unallocated.get(currency) ?? 0), cost_picture_complete: false }, programmes: [] });
  out.sort((x, y) => x.currency.localeCompare(y.currency));
  return {
    period: { from, to }, basis: { revenue: 'invoice (accrual-like) by charge due date', cash: 'cash by payment date', staff_cost: 'approved payroll runs, by timesheet work date', venue_cost: 'confirmed venue bookings, by session date' },
    cost_sources: { manual_entries_superseded: superseded.length, payroll_unpriced_timesheets: payroll.unpriced_timesheets, venue_sessions_unbooked: venue.unbooked_sessions, supplier_requests: supplier.rows.length, payment_fee_lines: fees.rows.length },
    provenance: { basis: 'Management view, not statutory accounts', currency_policy: 'Each currency is reported on its own and never summed with another', cut_off_at: new Date().toISOString(), cost_allocation_version: allocVersion,
      sources: { staff: 'academy_payroll_line (approved runs)', venue: 'venue_booking (confirmed)', supplier: 'academy_supplier_request (delivered or done)', payment_fee: 'fin_transaction (Finance ledger)', manual: 'academy_cost_entry' }, decisions_in_force: allocVersion },
    definitions: DEFINITIONS, currencies: out,
  };
}

/** Programme rows rolled up by branch, one currency. Programmes with no branch are an explicit "Unassigned" group, never dropped. Sums are plain sums of the programme figures, so they reconcile. */
function byBranch(rows, names, venueLevel = new Map()) {
  const g = new Map();
  for (const k of venueLevel.keys()) if (!rows.some((r) => r.branch_id === k)) g.set(k, { branch_id: k, name: names.get(k)?.name ?? 'Branch', archived: !!names.get(k)?.archived_at, programmes: 0, management_revenue_minor: 0, cash_collected_minor: 0, outstanding_minor: 0, contribution_minor: 0, operating_result_minor: 0, contribution_complete: true });
  for (const r of rows) {
    const k = r.branch_id ?? null;
    if (!g.has(k)) g.set(k, { branch_id: k, name: k ? names.get(k)?.name ?? 'Branch' : 'Unassigned', archived: !!(k && names.get(k)?.archived_at), programmes: 0, management_revenue_minor: 0, cash_collected_minor: 0, outstanding_minor: 0, contribution_minor: 0, operating_result_minor: 0, contribution_complete: true });
    const b = g.get(k);
    b.programmes++; b.management_revenue_minor += r.management_revenue_minor; b.cash_collected_minor += r.cash_collected_minor; b.outstanding_minor += r.outstanding_minor; b.contribution_minor += r.contribution_minor; b.operating_result_minor += r.operating_result_minor;
    if (!r.contribution_complete) b.contribution_complete = false;
  }
  return [...g.values()].map((b) => ({ ...b, venue_level_cost_minor: b.branch_id ? venueLevel.get(b.branch_id) ?? 0 : 0, margin_pct: b.contribution_complete ? ratio(b.operating_result_minor, b.management_revenue_minor) : null })).sort((x, y) => (x.branch_id === null) - (y.branch_id === null) || x.name.localeCompare(y.name));
}

/**
 * Cohort rows of one currency. Only figures that name the cohort are attributed to it; each programme's remainder (what no record ties to a cohort) is its own
 * row with cohort_id null, so cohorts + remainder add back to the programme. A cost category with no cohort-attributable record is null (unknown), never 0.
 */
function byCohort(rows, cohorts, names) {
  const out = [];
  for (const p of rows) {
    if (!p.programme_id) continue;
    const mine = [...cohorts.values()].filter((k) => k.programme_id === p.programme_id);
    for (const k of mine) {
      const known = (k.staff ?? 0) + (k.venue ?? 0) + (k.fee ?? 0);
      out.push({ cohort_id: k.cohort_id, name: names.get(k.cohort_id) ?? 'Cohort', programme_id: p.programme_id, programme: p.title, athletes_billed: k.athletes.size, management_revenue_minor: k.revenue, staff_cost_minor: k.staff, venue_cost_minor: k.venue, payment_fee_minor: k.fee,
        contribution_minor: k.staff == null ? null : k.revenue - known, contribution_complete: k.staff != null, margin_pct: k.staff == null ? null : ratio(k.revenue - known, k.revenue) });
    }
    const t = (f) => mine.reduce((s, k) => s + (k[f] ?? 0), 0);
    const rest = (total, f) => (total == null ? null : total - t(f));
    out.push({ cohort_id: null, name: null, programme_id: p.programme_id, programme: p.title, athletes_billed: Math.max(0, p.unit.athletes_billed - mine.reduce((s, k) => s + k.athletes.size, 0)), management_revenue_minor: p.management_revenue_minor - t('revenue'),
      staff_cost_minor: rest(p.staff_cost_minor, 'staff'), venue_cost_minor: rest(p.venue_cost_minor, 'venue'), payment_fee_minor: rest(p.payment_fee_minor, 'fee'), supplier_cost_minor: p.supplier_cost_minor, contribution_minor: null, contribution_complete: false, margin_pct: null });
  }
  return out;
}

const BUCKETS = [['not_yet_due', -Infinity, 0], ['d1_30', 1, 30], ['d31_60', 31, 60], ['d61_90', 61, 90], ['d90_plus', 91, Infinity]];

/** Receivables as of a date. A charge counts when it existed by then and still had a balance on that day: its amount less receipts and waivers/concessions recorded by then (paid later counts as outstanding then). Uses the charge terms as they stand now. */
export async function ageing(orgId, asOf, { lines = 0 } = {}) {
  const rows = await many(
    `SELECT ch.id, ch.currency, ch.kind, ch.due_on, b.bal AS amount_minor, ch.status, coalesce(e.programme_id, a.programme_id) AS programme_id, pr.title AS programme, coalesce(e.user_id, a.athlete_id) AS athlete_id, u.display_name AS athlete_name,
            ($2::date - ch.due_on) AS days_past_due
       ${CHARGE_BASE} LEFT JOIN academy_programmes pr ON pr.id=coalesce(e.programme_id, a.programme_id) LEFT JOIN users u ON u.id=coalesce(e.user_id, a.athlete_id)
       JOIN LATERAL (SELECT ch.amount_minor - coalesce((SELECT sum(x.amount_minor) FROM charge_receipts x WHERE x.charge_id=ch.id AND x.created_at::date <= $2), 0)
                                            - coalesce((SELECT sum(x.amount_minor) FROM charge_adjustments x WHERE x.charge_id=ch.id AND x.created_at::date <= $2), 0) AS bal) b ON b.bal > 0
      WHERE ch.organisation_id=$1 AND ch.created_at::date <= $2 AND ch.amount_minor > 0 AND (ch.status IN ('awaiting_payment','waived') OR (ch.status IN ('paid','refunded') AND ch.paid_at::date > $2))
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
  // canonical cost lines (approved payroll, confirmed venue bookings) for this programme; manual entries they replace are flagged, not hidden
  const decisions = await loadDecisions(orgId);
  const [payroll, venue, supplier, fees] = await Promise.all([payrollCost(orgId, from, to, decisions), venueCost(orgId, from, to), supplierCost(orgId, from, to, decisions), paymentFeeCost(orgId, from, to, decisions)]);
  const derived = [...payroll.rows, ...venue.rows, ...supplier.rows, ...fees.rows].filter((d) => d.currency === currency && d.programme_id === programmeId);
  const { superseded } = mergeCosts(costs.map((c) => ({ ...c, programme_id: c.category === 'overhead' ? null : programmeId, currency })), derived);
  const gone = new Set(superseded.map((c) => c.source_id));
  return {
    charges,
    cost_entries: costs.map((c) => ({ ...c, superseded_by_canonical: gone.has(c.source_id) })),
    canonical_costs: derived.map((d) => ({ source_type: d.source_type, source_id: d.source_id, category: d.category, on_date: d.on_date, amount_minor: d.amount_minor, session_id: d.session_id ?? null, payroll_run_id: d.run_id ?? null })),
  };
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
  // canonical sources for the same last 90 days replace the manual figure for their category (same rule as the P&L)
  const today = new Date().toISOString().slice(0, 10), start = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
  const cur = v?.currency;
  const [pay, ven] = await Promise.all([payrollCost(orgId, start, today), venueCost(orgId, start, today)]);
  const sumOf = (rows) => rows.filter((x) => x.programme_id === p.id && x.currency === cur).reduce((a, x) => a + x.amount_minor, 0);
  const hasP = pay.rows.some((x) => x.programme_id === p.id && x.currency === cur), hasV = ven.rows.some((x) => x.programme_id === p.id && x.currency === cur);
  if (hasP) cost.staff = sumOf(pay.rows);
  if (hasV) cost.venue = sumOf(ven.rows);
  return { programme_id: p.id, title: p.title, currency: v?.currency ?? null, fee_minor: v ? Number(v.fee_minor) : null, billing_model: v?.billing_model ?? null, capacity: p.capacity, enrolled,
    confirmed_future_invoices_minor: Number(future.minor), confirmed_future_invoices: future.n, staff_cost_per_period_minor: cost.staff ?? null, venue_cost_per_period_minor: cost.venue ?? null, source_period: 'last 90 days of approved payroll and confirmed venue bookings (manual cost entries where those have nothing); current enrolment; latest programme version' };
}
