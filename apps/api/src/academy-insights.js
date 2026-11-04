// Academy OS 3/3 close-out: the leadership layer. Pure READ projections over the canonical records (charges, payments, approved payroll, venue
// bookings, sessions, attendance, enrolments, retention signals): a monthly revenue / cost / result trend with period-on-period change, and a
// branch scorecard whose every status is a stated rule over a measured figure (no score, no model). Nothing here stores or changes anything.
import { many, one, pool } from './db.js';
import { payrollCost, venueCost, mergeCosts } from './academy-cost-sources.js';
import { pnl } from './academy-finance.js';
import { staffingExceptions } from './academy-ops.js';
import { signals } from './academy-signals.js';

const n = (v) => (v == null ? null : Number(v));
const pct = (a, b, dp = 1) => (a == null || !b ? null : Math.round((Number(a) / Number(b)) * 100 * 10 ** dp) / 10 ** dp);
const ymd = (d) => d.toISOString().slice(0, 10);
const addDays = (s, k) => ymd(new Date(Date.parse(`${s}T00:00:00Z`) + k * 864e5));
const monthsBetween = (from, to) => { const out = []; let y = +from.slice(0, 4), m = +from.slice(5, 7); const ey = +to.slice(0, 4), em = +to.slice(5, 7); while (y < ey || (y === ey && m <= em)) { out.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; y++; } } return out; };

// ------------------------------------------------------------------ monthly trend
async function window(orgId, from, to, programmeIds) {
  const inScope = (pid) => !programmeIds || (pid && programmeIds.has(pid));
  const charges = await many(
    `SELECT ch.currency, to_char(ch.due_on,'YYYY-MM') AS m, coalesce(e.programme_id, a.programme_id) AS programme_id, ch.gross_minor, ch.discount_minor, ch.tax_minor, coalesce(p.refunded,0) AS refunded
       FROM academy_charges ch LEFT JOIN org_enrolments e ON e.id=ch.enrolment_id LEFT JOIN academy_applications a ON a.id=ch.application_id
       LEFT JOIN LATERAL (SELECT sum(refunded_cents) AS refunded FROM payments WHERE purpose_type='academy_charge' AND purpose_id=ch.id AND status IN ('paid','refunded')) p ON true
      WHERE ch.organisation_id=$1 AND ch.due_on BETWEEN $2 AND $3 AND ch.status <> 'cancelled'`, [orgId, from, to]);
  const cash = await many(
    `SELECT pay.currency, to_char(pay.paid_at,'YYYY-MM') AS m, coalesce(e.programme_id, a.programme_id) AS programme_id, pay.amount_cents
       FROM payments pay JOIN academy_charges ch ON ch.id=pay.purpose_id LEFT JOIN org_enrolments e ON e.id=ch.enrolment_id LEFT JOIN academy_applications a ON a.id=ch.application_id
      WHERE pay.purpose_type='academy_charge' AND ch.organisation_id=$1 AND pay.status IN ('paid','refunded') AND pay.paid_at::date BETWEEN $2 AND $3`, [orgId, from, to]);
  const manualAll = await many("SELECT currency, category, programme_id, amount_minor, to_char(incurred_on,'YYYY-MM') AS m FROM academy_cost_entries WHERE organisation_id=$1 AND voided_at IS NULL AND incurred_on BETWEEN $2 AND $3", [orgId, from, to]);
  const [pay, ven] = await Promise.all([payrollCost(orgId, from, to), venueCost(orgId, from, to)]);
  const derived = [...pay.rows, ...ven.rows].map((d) => ({ ...d, m: String(d.on_date instanceof Date ? ymd(d.on_date) : d.on_date).slice(0, 7) }));
  const { manual } = mergeCosts(manualAll, derived);
  const cur = new Map();
  const row = (c, m) => { if (!cur.has(c)) cur.set(c, new Map()); const mm = cur.get(c); if (!mm.has(m)) mm.set(m, { month: m, revenue_minor: 0, cash_minor: 0, staff_minor: 0, venue_minor: 0, other_minor: 0 }); return mm.get(m); };
  const staffSeen = new Set();
  for (const c of charges) if (inScope(c.programme_id)) row(c.currency, c.m).revenue_minor += n(c.gross_minor) - n(c.discount_minor) - n(c.tax_minor) - n(c.refunded);
  for (const c of cash) if (inScope(c.programme_id)) row(c.currency, c.m).cash_minor += n(c.amount_cents);
  for (const d of derived) { if (!inScope(d.programme_id) && !(programmeIds == null && d.programme_id == null)) continue; row(d.currency, d.m)[d.category === 'staff' ? 'staff_minor' : 'venue_minor'] += d.amount_minor; if (d.category === 'staff') staffSeen.add(d.currency); }
  for (const m of manual) { if (m.category === 'overhead' ? programmeIds != null : !inScope(m.programme_id)) continue; const r = row(m.currency, m.m); const a = n(m.amount_minor); if (m.category === 'staff') { r.staff_minor += a; staffSeen.add(m.currency); } else if (m.category === 'venue') r.venue_minor += a; else r.other_minor += a; }
  return { cur, staffSeen };
}
const totalsOf = (months) => months.reduce((t, r) => ({ revenue_minor: t.revenue_minor + r.revenue_minor, cash_minor: t.cash_minor + r.cash_minor, staff_minor: t.staff_minor + r.staff_minor, venue_minor: t.venue_minor + r.venue_minor, other_minor: t.other_minor + r.other_minor }), { revenue_minor: 0, cash_minor: 0, staff_minor: 0, venue_minor: 0, other_minor: 0 });
const resultOf = (t) => t.revenue_minor - t.staff_minor - t.venue_minor - t.other_minor;
const change = (now, before) => (before ? Math.round(((now - before) / Math.abs(before)) * 1000) / 10 : null);

/** Monthly revenue / cash / cost / result per currency, with totals, the prior window of equal length and the percentage change. Per currency, never summed across. */
export async function pnlTrend(orgId, { from, to, branchId = null }) {
  let ids = null;
  if (branchId) ids = new Set((await many('SELECT id FROM academy_programmes WHERE organisation_id=$1 AND branch_id=$2', [orgId, branchId])).map((r) => r.id));
  const span = Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1;
  const pFrom = addDays(from, -span), pTo = addDays(from, -1);
  const [now, before] = await Promise.all([window(orgId, from, to, ids), window(orgId, pFrom, pTo, ids)]);
  const months = monthsBetween(from, to);
  const out = [];
  for (const currency of [...new Set([...now.cur.keys(), ...before.cur.keys()])].sort()) {
    const byMonth = now.cur.get(currency) ?? new Map();
    const series = months.map((m) => { const r = byMonth.get(m) ?? { month: m, revenue_minor: 0, cash_minor: 0, staff_minor: 0, venue_minor: 0, other_minor: 0 }; return { ...r, result_minor: resultOf(r) }; });
    const t = totalsOf(series), p = totalsOf([...(before.cur.get(currency)?.values() ?? [])]);
    out.push({
      currency, months: series, totals: { ...t, result_minor: resultOf(t) }, cost_complete: now.staffSeen.has(currency),
      prior: { ...p, result_minor: resultOf(p), from: pFrom, to: pTo },
      change_pct: { revenue: change(t.revenue_minor, p.revenue_minor), cash: change(t.cash_minor, p.cash_minor), cost: change(t.staff_minor + t.venue_minor + t.other_minor, p.staff_minor + p.venue_minor + p.other_minor), result: change(resultOf(t), resultOf(p)) },
    });
  }
  return {
    period: { from, to }, branch_id: branchId, granularity: 'month',
    basis: 'Revenue = gross billed - discounts - tax - refunds, by charge due month (invoice basis). Cash by payment month (cash basis). Staff cost = approved payroll by timesheet date; venue cost = confirmed bookings by session date; other = manual management entries. Result = revenue - costs. Not statutory accounts.',
    prior_note: 'The prior window is the same number of days immediately before the period.', currencies: out,
  };
}

// ------------------------------------------------------------------ branch scorecard
export const STATUS_RULES = {
  utilisation: 'Enrolled athletes / programme capacity. Green 60-100%, amber 40-59%, red under 40% or over capacity. Unknown without a capacity.',
  attendance: 'Present, late or left early / athletes marked, on sessions in the period. Green 85% or more, amber 70-84%, red under 70%.',
  cancellation: 'Cancelled / (scheduled + cancelled) sessions starting in the period. Green up to 5%, amber up to 10%, red above 10%.',
  staffing: 'Share of published or completed sessions that break a configured ratio, minimum-coach, lead or credential rule. Green none, amber up to 10%, red above 10%.',
  retention: 'Athletes with at least one stated retention indicator / enrolled athletes. Green up to 10%, amber up to 20%, red above 20%.',
  margin: 'Operating result / management revenue, only when staff cost is known. Green 15% or more, amber 0-14%, red below 0.',
};
const band = (v, good, ok, { high = true } = {}) => (v == null ? 'unknown' : high ? (v >= good ? 'green' : v >= ok ? 'amber' : 'red') : (v <= good ? 'green' : v <= ok ? 'amber' : 'red'));
const st = (rule, value, status, extra = {}) => ({ value, status, rule: STATUS_RULES[rule], ...extra });
/** The status a measured figure gets under a named rule (the same rule the branch scorecard uses). `exceptions`/`flagged` are the counts behind staffing and retention. */
export function statusOf(rule, value, { exceptions } = {}) {
  if (rule === 'utilisation') return st(rule, value, value == null ? 'unknown' : value > 100 ? 'red' : band(value, 60, 40));
  if (rule === 'attendance') return st(rule, value, band(value, 85, 70));
  if (rule === 'cancellation') return st(rule, value, band(value, 5, 10, { high: false }));
  if (rule === 'staffing') return st(rule, value, value == null ? 'unknown' : exceptions === 0 ? 'green' : band(value, 10, 10, { high: false }), { exceptions });
  if (rule === 'retention') return st(rule, value, band(value, 10, 20, { high: false }));
  if (rule === 'margin') return st(rule, value, band(value, 15, 0));
  throw new Error(`unknown rule ${rule}`);
}

/** One row per branch (and an explicit Unassigned row): people, delivery and money, each with a stated status. `moneyOnly` drops people and delivery (the finance role). */
export async function branchScorecard(orgId, { from, to, moneyOnly = false }) {
  const [branches, programmes] = await Promise.all([
    many('SELECT b.*, u.display_name AS manager_name FROM academy_branches b LEFT JOIN users u ON u.id=b.manager_id WHERE b.organisation_id=$1 AND b.archived_at IS NULL ORDER BY b.name, b.id', [orgId]),
    many('SELECT id, title, sport, capacity, branch_id FROM academy_programmes WHERE organisation_id=$1 ORDER BY title, id', [orgId]),
  ]);
  const groups = [...branches.map((b) => ({ branch: b, progs: programmes.filter((p) => p.branch_id === b.id) })), { branch: null, progs: programmes.filter((p) => !p.branch_id || !branches.some((b) => b.id === p.branch_id)) }];
  const money = await pnl(orgId, { from, to });
  let people = null, delivery = null, flagged = new Set(), exceptions = { exceptions: [], checked: 0 };
  if (!moneyOnly) {
    const enrol = await many("SELECT e.programme_id, e.user_id FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.organisation_id=$1 AND e.programme_id IS NOT NULL AND e.status IN ('enrolled','paused')", [orgId]);
    people = new Map(); for (const r of enrol) { if (!people.has(r.programme_id)) people.set(r.programme_id, new Set()); people.get(r.programme_id).add(r.user_id); }
    const sess = await many("SELECT programme_id, count(*) FILTER (WHERE status IN ('published','completed'))::int AS scheduled, count(*) FILTER (WHERE status='completed')::int AS completed, count(*) FILTER (WHERE status='cancelled')::int AS cancelled FROM academy_sessions WHERE organisation_id=$1 AND starts_at >= $2::date AND starts_at < $3::date + 1 GROUP BY 1", [orgId, from, to]);
    const att = await many("SELECT s.programme_id, count(*) FILTER (WHERE t.status IN ('present','late','left_early'))::int AS present, count(*) FILTER (WHERE t.status IN ('present','late','left_early','absent','excused'))::int AS marked FROM academy_attendance t JOIN academy_sessions s ON s.id=t.session_id WHERE s.organisation_id=$1 AND s.starts_at >= $2::date AND s.starts_at < $3::date + 1 GROUP BY 1", [orgId, from, to]);
    delivery = { sess: new Map(sess.map((r) => [r.programme_id, r])), att: new Map(att.map((r) => [r.programme_id, r])) };
    exceptions = await staffingExceptions(pool, orgId, from, to);
    flagged = new Set((await signals(orgId, { includeMoney: false })).map((x) => x.athlete_id));
  }
  const rows = groups.map(({ branch, progs }) => {
    const ids = new Set(progs.map((p) => p.id));
    const out = { branch_id: branch?.id ?? null, name: branch?.name ?? null, code: branch?.code ?? null, city: branch?.city ?? null, manager: branch?.manager_id ? { id: branch.manager_id, name: branch.manager_name } : null, opened_on: branch?.opened_on ?? null, athlete_target: branch?.athlete_target ?? null,
      programmes: progs.map((p) => ({ id: p.id, title: p.title, sport: p.sport })) };
    if (!moneyOnly) {
      const athletes = new Set(); for (const p of progs) for (const u of people.get(p.id) ?? []) athletes.add(u);
      const cap = progs.filter((p) => p.capacity != null).reduce((s, p) => s + p.capacity, 0), uncapped = progs.filter((p) => p.capacity == null).length;
      const sum = (f) => progs.reduce((s, p) => s + (delivery.sess.get(p.id)?.[f] ?? 0), 0);
      const sched = sum('scheduled'), canc = sum('cancelled'), comp = sum('completed');
      const present = progs.reduce((s, p) => s + (delivery.att.get(p.id)?.present ?? 0), 0), marked = progs.reduce((s, p) => s + (delivery.att.get(p.id)?.marked ?? 0), 0);
      const exc = exceptions.exceptions.filter((e) => ids.has(e.programme_id)).length, checkedSessions = sched;
      const util = cap ? pct(athletes.size, cap) : null, attPct = pct(present, marked), cancPct = pct(canc, sched + canc), excPct = pct(exc, checkedSessions);
      const flaggedN = [...athletes].filter((u) => flagged.has(u)).length, retPct = pct(flaggedN, athletes.size);
      out.people = { athletes: athletes.size, target: branch?.athlete_target ?? null, target_pct: branch?.athlete_target ? pct(athletes.size, branch.athlete_target) : null, capacity: cap || null, uncapped_programmes: uncapped,
        utilisation: st('utilisation', util, util == null ? 'unknown' : util > 100 ? 'red' : band(util, 60, 40)), retention: st('retention', retPct, band(retPct, 10, 20, { high: false }), { flagged: flaggedN }) };
      out.delivery = { scheduled: sched, completed: comp, cancelled: canc, attendance: st('attendance', attPct, band(attPct, 85, 70), { present, marked }), cancellation: st('cancellation', cancPct, band(cancPct, 5, 10, { high: false })),
        staffing: st('staffing', excPct, excPct == null ? 'unknown' : exc === 0 ? 'green' : band(excPct, 10, 10, { high: false }), { exceptions: exc }) };
    }
    out.finance = money.currencies.map((c) => {
      const b = (c.by_branch ?? []).find((x) => (x.branch_id ?? null) === (branch?.id ?? null));
      if (!b) return null;
      return { currency: c.currency, management_revenue_minor: b.management_revenue_minor, cash_collected_minor: b.cash_collected_minor, outstanding_minor: b.outstanding_minor, contribution_minor: b.contribution_minor, operating_result_minor: b.operating_result_minor, contribution_complete: b.contribution_complete, margin: st('margin', b.margin_pct, band(b.margin_pct, 15, 0)) };
    }).filter(Boolean);
    return out;
  });
  const empty = (r) => !r.branch_id && !r.programmes.length && !r.finance.length;
  return { period: { from, to }, rules: STATUS_RULES, branches: rows.filter((r) => !empty(r)), money_only: moneyOnly };
}

/** How complete the evidence behind the leadership figures is. A missing denominator is null, never 100% or 0%. */
export async function dataQuality(orgId, { from, to }) {
  const [sessions, booked, sheets, priced, progs] = await Promise.all([
    one("SELECT count(*)::int AS n FROM academy_sessions WHERE organisation_id=$1 AND status IN ('published','completed') AND starts_at >= $2::date AND starts_at < $3::date + 1", [orgId, from, to]),
    one(`SELECT count(*)::int AS n FROM academy_sessions s WHERE s.organisation_id=$1 AND s.status IN ('published','completed') AND s.starts_at >= $2::date AND s.starts_at < $3::date + 1
           AND EXISTS (SELECT 1 FROM session_venue_links l JOIN bookings b ON b.id=l.booking_id AND b.status='confirmed' WHERE l.session_type='academy_session' AND l.session_id=s.id AND l.released_at IS NULL)`, [orgId, from, to]),
    one("SELECT count(*)::int AS n FROM academy_timesheets WHERE organisation_id=$1 AND status='approved' AND work_date BETWEEN $2 AND $3", [orgId, from, to]),
    one("SELECT count(*)::int AS n FROM academy_timesheets t JOIN academy_payroll_runs r ON r.id=t.payroll_run_id AND r.status='approved' WHERE t.organisation_id=$1 AND t.status='approved' AND t.work_date BETWEEN $2 AND $3", [orgId, from, to]),
    one('SELECT count(*)::int AS n, count(branch_id)::int AS with_branch FROM academy_programmes WHERE organisation_id=$1', [orgId]),
  ]);
  return {
    venue_booked: { pct: pct(booked.n, sessions.n), of: sessions.n, label: 'Sessions with a confirmed venue booking' },
    payroll_covered: { pct: pct(priced.n, sheets.n), of: sheets.n, label: 'Approved timesheets inside an approved payroll run' },
    programmes_with_branch: { pct: pct(progs.with_branch, progs.n), of: progs.n, label: 'Programmes placed in a branch' },
  };
}
