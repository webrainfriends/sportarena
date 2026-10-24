// Academy OS 3/3: the academy's management accounts. Read models over canonical charges and payments, plus audited management cost entries
// (which are not payments or invoices) and editable forecast scenarios that never change an actual. See docs/academy-outcomes.md for every definition.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { orgFor } from '../org-access.js';
import { STAFF_MONEY } from '../academy.js';
import { pnl, ageing, pnlLines, runScenario, scenarioBaseline } from '../academy-finance.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a calendar date (YYYY-MM-DD)');
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const cur = z.string().regex(/^[A-Z]{3}$/);

cap({
  name: 'get_academy_pnl', method: 'GET', path: '/organisations/:id/academy/pnl', tag: 'Academy',
  summary: 'Management profit & loss for the academy (owner/admin/finance), per currency and never summed across currencies: gross billed, discounts, scholarships/sponsor funding, net invoiced, refunds, management revenue (invoice basis by due date), cash collected (cash basis by payment date), outstanding, staff / venue / other direct cost, contribution, allocated overhead, operating result, margin and per-programme unit economics. Missing costs are null, not zero. Filter by programme or sport. This is a management view, not statutory accounts.',
  input: z.object({ id, from: day.optional(), to: day.optional(), programme_id: id.optional(), sport: z.string().max(40).optional() }),
  async handler({ user }, i) {
    await orgFor(user, i.id, STAFF_MONEY);
    return pnl(i.id, { from: i.from ?? daysAgo(90), to: i.to ?? today(), programmeId: i.programme_id ?? null, sport: i.sport ?? null });
  },
});

cap({
  name: 'list_academy_pnl_lines', method: 'GET', path: '/organisations/:id/academy/pnl/lines', tag: 'Academy',
  summary: 'Drill from a P&L figure to the records behind it (owner/admin/finance): every academy charge and every management cost entry for one programme and currency in the period, each with its source type and id.',
  input: z.object({ id, programme_id: id, currency: cur, from: day.optional(), to: day.optional() }),
  async handler({ user }, i) {
    await orgFor(user, i.id, STAFF_MONEY);
    return pnlLines(i.id, { from: i.from ?? daysAgo(90), to: i.to ?? today(), programmeId: i.programme_id, currency: i.currency });
  },
});

cap({
  name: 'get_academy_receivables', method: 'GET', path: '/organisations/:id/academy/receivables', tag: 'Academy',
  summary: 'Receivables ageing as of a date (owner/admin/finance): per currency, amounts awaiting payment in not-yet-due / 1-30 / 31-60 / 61-90 / 90+ days past due, with the charges behind them. It reconciles to the academy charges as they stood on that date.',
  input: z.object({ id, as_of: day.optional(), lines: z.coerce.number().int().min(0).max(200).default(50) }),
  async handler({ user }, i) {
    await orgFor(user, i.id, STAFF_MONEY);
    await audit(null, user.id, 'read_academy_receivables', 'organisations', i.id);
    return ageing(i.id, i.as_of ?? today(), { lines: i.lines });
  },
});

const allocation = z.discriminatedUnion('method', [
  z.object({ method: z.literal('direct') }), z.object({ method: z.literal('participants') }), z.object({ method: z.literal('revenue_share') }),
  z.object({ method: z.literal('split'), splits: z.array(z.object({ programme_id: id, pct: z.number().min(0.01).max(100) })).min(1).max(30) }),
]);

cap({
  name: 'add_academy_cost_entry', method: 'POST', path: '/organisations/:id/academy/cost-entries', tag: 'Academy', status: 201,
  summary: 'Add a management cost line (owner/admin/finance): staff, venue or other direct cost for a programme, or overhead spread by participants, revenue share or an explicit percentage split. It is a management-accounting entry, not a payment or invoice, and is append-only (correct it by voiding and re-adding). A retry with the same idempotency key returns the same entry.',
  input: z.object({ id, category: z.enum(['staff', 'venue', 'other_direct', 'overhead']), programme_id: id.optional(), currency: cur, amount_minor: z.number().int().min(1), incurred_on: day, allocation: allocation.default({ method: 'direct' }),
    description: z.string().min(3).max(300), source_ref: z.string().max(120).optional(), idempotency_key: z.string().min(8).max(80) }),
  handler: ({ user }, i) => tx(async (c) => {
    await orgFor(user, i.id, STAFF_MONEY, { write: true, c });
    const prior = (await c.query('SELECT * FROM academy_cost_entries WHERE created_by=$1 AND idempotency_key=$2', [user.id, i.idempotency_key])).rows[0];
    if (prior) return prior;
    if (i.category === 'overhead') {
      if (i.allocation.method === 'direct') throw badRequest('Overhead must be spread: choose participants, revenue share or a percentage split');
      if (i.allocation.method === 'split' && Math.abs(i.allocation.splits.reduce((s, x) => s + x.pct, 0) - 100) > 0.01) throw badRequest('The split must add up to 100%');
    } else {
      if (!i.programme_id) throw badRequest('Choose the programme this cost belongs to');
      if (i.allocation.method !== 'direct') throw badRequest('A direct cost is attached to one programme');
    }
    const pids = [i.programme_id, ...(i.allocation.method === 'split' ? i.allocation.splits.map((s) => s.programme_id) : [])].filter(Boolean);
    for (const pid of pids) if (!(await c.query('SELECT 1 FROM academy_programmes WHERE id=$1 AND organisation_id=$2', [pid, i.id])).rows.length) throw badRequest('That programme is not in this academy');
    const r = (await c.query(
      `INSERT INTO academy_cost_entries(organisation_id, category, programme_id, currency, amount_minor, incurred_on, allocation, description, source_ref, created_by, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [i.id, i.category, i.programme_id ?? null, i.currency, i.amount_minor, i.incurred_on, JSON.stringify(i.allocation), i.description, i.source_ref ?? null, user.id, i.idempotency_key])).rows[0];
    await audit(c, user.id, 'add_academy_cost_entry', 'academy_cost_entries', r.id);
    return r;
  }),
});

cap({
  name: 'void_academy_cost_entry', method: 'POST', path: '/academy/cost-entries/:id/void', tag: 'Academy',
  summary: 'Void a management cost entry with a reason (owner/admin/finance). The entry stays on record and is left out of the P&L from then on.',
  input: z.object({ id, reason: z.string().min(3).max(300) }),
  async handler({ user }, i) {
    const e = await one('SELECT * FROM academy_cost_entries WHERE id=$1', [i.id]);
    if (!e) throw notFound('Cost entry');
    await orgFor(user, e.organisation_id, STAFF_MONEY, { write: true });
    if (e.voided_at) throw conflict('This entry is already voided');
    const r = await one('UPDATE academy_cost_entries SET voided_at=now(), voided_by=$2, void_reason=$3 WHERE id=$1 AND voided_at IS NULL RETURNING *', [e.id, user.id, i.reason]);
    await audit(null, user.id, 'void_academy_cost_entry', 'academy_cost_entries', e.id);
    return r;
  },
});

cap({
  name: 'list_academy_cost_entries', method: 'GET', path: '/organisations/:id/academy/cost-entries', tag: 'Academy',
  summary: 'Management cost entries (owner/admin/finance), newest first, voided ones included and marked.',
  input: z.object({ id, programme_id: id.optional(), from: day.optional(), to: day.optional(), ...page }),
  async handler({ user }, i) {
    await orgFor(user, i.id, STAFF_MONEY);
    return many(
      `SELECT c.*, p.title AS programme FROM academy_cost_entries c LEFT JOIN academy_programmes p ON p.id=c.programme_id
        WHERE c.organisation_id=$1 AND ($2::uuid IS NULL OR c.programme_id=$2) AND ($3::date IS NULL OR c.incurred_on >= $3) AND ($4::date IS NULL OR c.incurred_on <= $4)
        ORDER BY c.incurred_on DESC, c.id LIMIT $5 OFFSET $6`, [i.id, i.programme_id ?? null, i.from ?? null, i.to ?? null, i.limit, i.offset]);
  },
});

const assumptions = z.object({
  renewal_pct: z.number().min(0).max(100).default(100), new_athletes: z.number().int().min(0).max(5000).default(0), price_change_pct: z.number().min(-100).max(300).default(0), discount_pct: z.number().min(0).max(100).default(0),
  extra_cohorts: z.number().int().min(0).max(20).default(0), extra_cohort_size: z.number().int().min(1).max(500).default(12), extra_cohort_cost_minor: z.number().int().min(0).default(0),
  scholarship_funding_minor: z.number().int().min(0).default(0), billing_periods: z.number().int().min(1).max(36).default(1),
  staff_cost_minor: z.number().int().min(0).optional(), venue_cost_minor: z.number().int().min(0).optional(),
});

cap({
  name: 'create_academy_scenario', method: 'POST', path: '/organisations/:id/academy/scenarios', tag: 'Academy', status: 201,
  summary: 'Create a forecast scenario for one programme (owner/admin/finance): renewal, new athletes, price change, extra cohorts, scholarship / sponsor funding and cost assumptions applied to the actual baseline (current enrolment, latest price, last 90 days of cost entries, confirmed future invoices). The result is stored apart from actuals and changes no price, payroll or booking. Same idempotency key returns the same scenario.',
  input: z.object({ id, programme_id: id, name: z.string().min(2).max(120), assumptions, idempotency_key: z.string().min(8).max(80) }),
  handler: ({ user }, i) => tx(async (c) => {
    await orgFor(user, i.id, STAFF_MONEY, { write: true, c });
    const prior = (await c.query('SELECT * FROM academy_scenarios WHERE created_by=$1 AND idempotency_key=$2', [user.id, i.idempotency_key])).rows[0];
    if (prior) return prior;
    const base = await scenarioBaseline(i.id, i.programme_id);
    if (!base) throw notFound('Programme');
    if (!base.currency) throw conflict('Publish a priced version of this programme before forecasting it');
    const result = runScenario(base, i.assumptions);
    const r = (await c.query('INSERT INTO academy_scenarios(organisation_id, programme_id, name, currency, assumptions, baseline, result, created_by, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [i.id, i.programme_id, i.name, base.currency, JSON.stringify(i.assumptions), JSON.stringify(base), JSON.stringify(result), user.id, i.idempotency_key])).rows[0];
    await audit(c, user.id, 'create_academy_scenario', 'academy_scenarios', r.id);
    return r;
  }),
});

cap({
  name: 'list_academy_scenarios', method: 'GET', path: '/organisations/:id/academy/scenarios', tag: 'Academy',
  summary: 'Saved forecast scenarios (owner/admin/finance). They are projections only; nothing in them is an actual.',
  input: z.object({ id, programme_id: id.optional(), ...page }),
  async handler({ user }, i) {
    await orgFor(user, i.id, STAFF_MONEY);
    return many('SELECT s.*, p.title AS programme FROM academy_scenarios s JOIN academy_programmes p ON p.id=s.programme_id WHERE s.organisation_id=$1 AND s.archived_at IS NULL AND ($2::uuid IS NULL OR s.programme_id=$2) ORDER BY s.created_at DESC, s.id LIMIT $3 OFFSET $4', [i.id, i.programme_id ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'archive_academy_scenario', method: 'POST', path: '/academy/scenarios/:id/archive', tag: 'Academy',
  summary: 'Archive a scenario (owner/admin/finance). It is hidden from the list, never deleted.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const s = await one('SELECT * FROM academy_scenarios WHERE id=$1', [i.id]);
    if (!s) throw notFound('Scenario');
    await orgFor(user, s.organisation_id, STAFF_MONEY, { write: true });
    return one('UPDATE academy_scenarios SET archived_at=coalesce(archived_at, now()) WHERE id=$1 RETURNING id, archived_at', [s.id]);
  },
});

const cell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) || /^[=+@-]/.test(s) ? `"${(/^[=+@-]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s; };

cap({
  name: 'export_academy_pnl', method: 'GET', path: '/organisations/:id/academy/pnl/export', tag: 'Academy',
  summary: 'Export the P&L as CSV, one row per programme and currency (owner/admin/finance). Audit-logged. Missing figures are left blank, not zero.',
  input: z.object({ id, from: day.optional(), to: day.optional() }),
  async handler({ user }, i) {
    await orgFor(user, i.id, STAFF_MONEY);
    const from = i.from ?? daysAgo(90), to = i.to ?? today();
    const r = await pnl(i.id, { from, to });
    await audit(null, user.id, 'export_academy_pnl', 'organisations', i.id);
    const head = ['currency', 'programme', 'programme_id', 'gross_billed_minor', 'discounts_minor', 'net_invoiced_minor', 'tax_minor', 'refunds_minor', 'management_revenue_minor', 'cash_collected_minor', 'outstanding_minor', 'staff_cost_minor', 'venue_cost_minor', 'other_direct_cost_minor', 'contribution_minor', 'contribution_complete', 'allocated_overhead_minor', 'operating_result_minor', 'margin_pct'];
    const rows = r.currencies.flatMap((c) => c.programmes.map((p) => head.map((h) => (h === 'currency' ? c.currency : h === 'programme' ? p.title : p[h]))));
    return { filename: `academy-pnl-${from}-${to}.csv`, basis: r.basis, csv: [head, ...rows].map((row) => row.map(cell).join(',')).join('\n') };
  },
});
