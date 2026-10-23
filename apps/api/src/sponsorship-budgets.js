// Sponsorship budget controls (#293). A budget is an authorization (annual / program / department / event) for what a brand may
// reserve and commit. There is no second ledger: planned, reserved, committed, paid, refunded and available are derived live from
// the tables that already hold the truth -- award reservations, agreement obligations and the recipient-confirmed / reversed payments.
//   authorized   what was approved for this budget
//   allocated    carved out for child budgets (a child's authorization can never exceed the parent's unallocated amount)
//   planned      offers sent but not accepted; NEVER counts against available and is never income for the recipient
//   reserved     budget held for awards not yet accepted
//   committed    the money dues of accepted agreements (cancelled dues are released)
//   paid         recipient-confirmed payments;  refunded: confirmed payments the recipient later reversed;  reported: unverified claims
//   available    authorized - allocated - reserved - committed
// Every commitment first locks the budget row, then checks `available`, so concurrent awards serialise and cannot overspend.
// Lock order everywhere: program -> round -> application -> award -> budget (a parent budget before its child).
import { buildSchedule } from './sponsor-schedule.js';
import { exponent } from './currency.js';
import { loadLines } from './sponsor-agreements.js';
import { conflict, notFound, unprocessable } from './errors.js';
import { isAdmin } from './helpers.js';
import { assertSponsorCan, sponsorAccess } from './sponsor-access.js';

export const KINDS = ['annual', 'program', 'department', 'event'];
const n = (x) => Number(x ?? 0);

/** Converts minor units of `from` into minor units of `to` at a sourced rate (budget-currency major units per 1 major unit of `from`). */
export function convert(cents, from, to, rate) {
  if (from === to) return n(cents);
  return Math.round((n(cents) / 10 ** exponent(from)) * Number(rate) * 10 ** exponent(to));
}

export const budgetEvent = (c, budgetId, kind, actorId, detail = {}) =>
  c.query('INSERT INTO sponsorship_budget_events(budget_id, kind, actor_id, detail) VALUES ($1,$2,$3,$4)', [budgetId, kind, actorId ?? null, detail]);

/** Loads a budget (optionally locked) and checks the caller may do the action for its brand. Department-scoped staff only reach their own department's budget. */
export async function budgetFor(user, budgetId, action, c, lock = false) {
  const b = (await c.query(`SELECT * FROM sponsorship_budgets WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [budgetId])).rows[0];
  if (!b) throw notFound('Budget');
  const sp = (await c.query('SELECT * FROM sponsors WHERE id=$1', [b.sponsor_id])).rows[0];
  if (!isAdmin(user)) {
    const access = await sponsorAccess(user, sp, c);
    if (!access) throw notFound('Budget'); // never reveal that another brand's budget exists
    assertSponsorCan(access, action, { departmentId: action === 'budget' ? null : b.department_id, what: action === 'budget_read' ? 'see this budget' : action === 'export' ? 'export budget data' : 'change budgets' });
  }
  return { b, sp };
}

/** The rate to convert `currency` into the budget's currency, or why it cannot be: currencies stay separate unless a sourced rate is explicit. */
export async function rateFor(c, b, currency) {
  if (currency === b.currency) return { id: null, rate: 1 };
  if (b.fx_policy !== 'explicit') throw unprocessable(`The budget "${b.name}" is in ${b.currency} and has no FX policy, so ${currency} cannot be counted against it`);
  const r = (await c.query('SELECT id, rate FROM sponsorship_budget_fx_rates WHERE budget_id=$1 AND currency=$2 AND superseded_at IS NULL', [b.id, currency])).rows[0];
  if (!r) throw unprocessable(`The budget "${b.name}" has no sourced ${currency} -> ${b.currency} rate; set one before committing ${currency}`);
  return { id: r.id, rate: Number(r.rate) };
}

/** Live balances of one budget in its own currency, derived from reservations, obligations and payments. */
export async function usageOf(c, b) {
  const byCurrency = {};
  const slot = (cur, rate) => (byCurrency[cur] ??= { currency: cur, rate: rate == null ? null : Number(rate), reserved: 0, committed: 0, paid: 0, refunded: 0, reported: 0 });
  let reserved = 0, committed = 0, paid = 0, refunded = 0, reported = 0, planned = 0;
  const conv = (cents, cur, rate) => convert(cents, cur, b.currency, rate ?? 1);

  for (const r of (await c.query(
    `SELECT r.amount_cents, r.currency, fx.rate FROM sponsorship_award_reservations r LEFT JOIN sponsorship_budget_fx_rates fx ON fx.id=r.budget_fx_rate_id
      WHERE r.budget_id=$1 AND r.status='held'`, [b.id])).rows) {
    const v = conv(r.amount_cents, r.currency, r.rate);
    reserved += v; slot(r.currency, r.rate).reserved += n(r.amount_cents);
  }
  for (const d of (await c.query(
    `SELECT ss.id, o.currency, fx.rate,
            coalesce(sum(o.amount_cents) FILTER (WHERE o.status <> 'cancelled'),0)::bigint AS committed,
            coalesce(sum((SELECT sum(p.amount_cents) FROM sponsorship_payments p WHERE p.obligation_id=o.id AND p.status='confirmed')),0)::bigint AS paid,
            coalesce(sum((SELECT sum(p.amount_cents) FROM sponsorship_payments p WHERE p.obligation_id=o.id AND p.status='reversed')),0)::bigint AS refunded,
            coalesce(sum((SELECT sum(p.amount_cents) FROM sponsorship_payments p WHERE p.obligation_id=o.id AND p.status='reported')),0)::bigint AS reported
       FROM sponsorships ss JOIN sponsorship_obligations o ON o.sponsorship_id=ss.id AND o.kind='money'
       LEFT JOIN sponsorship_budget_fx_rates fx ON fx.id=ss.budget_fx_rate_id
      WHERE ss.budget_id=$1 GROUP BY ss.id, o.currency, fx.id`, [b.id])).rows) {
    const s = slot(d.currency, d.rate);
    committed += conv(d.committed, d.currency, d.rate); s.committed += n(d.committed);
    paid += conv(d.paid, d.currency, d.rate); s.paid += n(d.paid);
    refunded += conv(d.refunded, d.currency, d.rate); s.refunded += n(d.refunded);
    reported += conv(d.reported, d.currency, d.rate);
  }
  for (const d of (await c.query(
    `SELECT ss.id, ss.terms_version, ss.starts_on::text, ss.ends_on::text, fx.rate FROM sponsorships ss LEFT JOIN sponsorship_budget_fx_rates fx ON fx.id=ss.budget_fx_rate_id
      WHERE ss.budget_id=$1 AND ss.status='proposed' AND ss.accepted_version IS NULL AND coalesce(ss.budget_approval,'') <> 'rejected'`, [b.id])).rows) {
    for (const [cur, cents] of Object.entries(proposedMoney(await loadLines(c, d.id, d.terms_version), d))) planned += conv(cents, cur, d.rate);
  }
  const allocated = n((await c.query("SELECT coalesce(sum(authorized_cents),0)::bigint AS s FROM sponsorship_budgets WHERE parent_id=$1 AND status='active'", [b.id])).rows[0].s);
  const authorized = n(b.authorized_cents);
  return {
    currency: b.currency, authorized_cents: authorized, allocated_cents: allocated, planned_cents: planned, reserved_cents: reserved, committed_cents: committed,
    paid_cents: paid, refunded_cents: refunded, reported_unverified_cents: reported, outstanding_cents: committed - paid,
    available_cents: authorized - allocated - reserved - committed, over_committed: authorized - allocated - reserved - committed < 0,
    by_currency: Object.values(byCurrency),
  };
}

/** Cash a set of unanswered contribution lines would commit, per currency. Goods and endorsement estimates are never cash. */
function proposedMoney(lines, d) {
  try { return buildSchedule(lines, { starts_on: d.starts_on, ends_on: d.ends_on }).committed; } catch { return {}; }
}

/** What an amount in `currency` costs the budget, with the rate it is committed at. */
export async function costOf(c, b, currency, cents) {
  const r = await rateFor(c, b, currency);
  return { cents: convert(cents, currency, b.currency, r.rate), rateId: r.id };
}

/**
 * Locks the budget and refuses when `cost` does not fit its available balance. `releaseCents` is what the caller already holds
 * on it (e.g. an award's own reservation being resized). Returns the budget row; the lock is held until the transaction ends.
 */
export async function assertFits(c, budgetId, cost, { releaseCents = 0, what = 'This' } = {}) {
  const b = (await c.query('SELECT * FROM sponsorship_budgets WHERE id=$1 FOR UPDATE', [budgetId])).rows[0];
  if (!b) throw notFound('Budget');
  if (b.status !== 'active') throw conflict(`The budget "${b.name}" is archived`);
  const u = await usageOf(c, b);
  const free = u.available_cents + releaseCents;
  if (cost > free) throw conflict(`${what} would exceed the authorized budget "${b.name}" (${free} ${b.currency} minor units available)`, { budget_id: b.id, available_cents: free, currency: b.currency });
  return b;
}

export const storedRate = async (c, id) => (id ? Number((await c.query('SELECT rate FROM sponsorship_budget_fx_rates WHERE id=$1', [id])).rows[0].rate) : 1);

/** The program's budget and the rate a NEW award is costed at: the budget's current sourced rate for the program's currency (what is already reserved keeps its own). */
export async function programBudget(c, p, lock = false) {
  if (!p.budget_id) return null;
  const b = (await c.query(`SELECT * FROM sponsorship_budgets WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [p.budget_id])).rows[0];
  return { b, rate: await rateFor(c, b, p.currency) };
}

/** Why an award of `amount` (in the program's currency) does not fit the program's linked budget, or null. Takes the budget lock. `excludeAwardId` is an award being resized: its own held reservation does not count against itself. */
export async function budgetBlockerFor(c, p, amount, excludeAwardId = null) {
  if (!p.budget_id) return null;
  const { b, rate } = await programBudget(c, p, true);
  if (b.status !== 'active') return 'The program\'s budget is no longer active';
  const held = excludeAwardId ? (await c.query("SELECT r.amount_cents, r.currency, fx.rate FROM sponsorship_award_reservations r LEFT JOIN sponsorship_budget_fx_rates fx ON fx.id=r.budget_fx_rate_id WHERE r.award_id=$1 AND r.status='held' AND r.budget_id=$2", [excludeAwardId, b.id])).rows[0] : null;
  const own = held ? convert(held.amount_cents, held.currency, b.currency, held.rate ?? 1) : 0;
  const cost = convert(amount, p.currency, b.currency, held ? held.rate ?? 1 : rate.rate); // a resized award keeps the rate its reservation was made at
  const u = await usageOf(c, b);
  if (cost > u.available_cents + own) return `This award would exceed the authorized budget "${b.name}" (${u.available_cents + own} ${b.currency} minor units available)`;
  return null;
}

/** An extra approver step when an award is larger than the linked budget's approval threshold. */
export async function budgetSteps(c, p, amount) {
  if (!p.budget_id) return [];
  const b = (await c.query('SELECT currency, approval_over_cents FROM sponsorship_budgets WHERE id=$1', [p.budget_id])).rows[0];
  if (!b || b.approval_over_cents == null) return [];
  return convert(amount, p.currency, b.currency, (await rateFor(c, b, p.currency)).rate) > n(b.approval_over_cents) ? ['approver'] : [];
}

/** Budgets that may carry a direct (non-program) agreement, and the rules that tie them to it. */
export function assertDealFitsBudget(b, { departmentId, targetType, targetId }) {
  if (b.status !== 'active') throw conflict(`The budget "${b.name}" is archived`);
  if (b.kind === 'program') throw unprocessable('A program budget funds a sponsorship program; link the program to it instead');
  if (b.kind === 'department' && b.department_id !== (departmentId ?? null)) throw unprocessable(`The budget "${b.name}" belongs to another department`);
  if (b.kind === 'event' && !(targetType === 'event' && targetId === b.event_id)) throw unprocessable(`The budget "${b.name}" funds a specific event only`);
}

/** Sums a subtree of budgets (a budget and its descendants), each in the shared currency. */
export function rollup(budgets) {
  const byId = new Map(budgets.map((x) => [x.id, { ...x, rollup: null }]));
  const totals = (x) => {
    const own = ['authorized_cents', 'planned_cents', 'reserved_cents', 'committed_cents', 'paid_cents', 'refunded_cents'].reduce((a, k) => ({ ...a, [k]: x[k] }), {});
    for (const ch of budgets.filter((y) => y.parent_id === x.id && y.status === 'active')) {
      const t = totals(byId.get(ch.id));
      for (const k of ['planned_cents', 'reserved_cents', 'committed_cents', 'paid_cents', 'refunded_cents']) own[k] += t[k];
    }
    return own;
  };
  return budgets.map((x) => ({ ...x, rollup: totals(byId.get(x.id)) }));
}
