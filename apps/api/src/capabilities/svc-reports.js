// Supplier services (#458) — supplier and buyer dashboards, ageing, tax summary and safe CSV exports. Role- and entity-scoped; no supplier ever
// sees another supplier’s bids or another buyer’s finance.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { supplierAccess, buyerAccess } from '../svc/access.js';
import { supplierDashboard, buyerDashboard, exportRows } from '../svc/reports.js';
import { toCsv } from '../csv.js';
import { audit } from '../helpers.js';
import { badRequest } from '../errors.js';

const TAG = 'Service reports';
const day = z.string().date();
const cur = z.string().length(3).transform((s) => s.toUpperCase());
const range = { from: day.optional(), to: day.optional(), currency: cur.optional() };
const chk = (i) => { if (i.from && i.to && i.to < i.from) throw badRequest('to is before from'); };

cap({
  name: 'get_supplier_dashboard', method: 'GET', path: '/supplier-profiles/:id/dashboard', tag: TAG,
  summary: 'Supplier dashboard: enquiries and response time, quote conversion (definition stated), pipeline, orders by state / category / customer, utilisation, on-time / rework / no-show / cancellation rates, billed / collected / outstanding, ageing, tax summary and a prior-period comparison. Filters: dates, currency, category, customer. UTC; currencies never combined.',
  input: z.object({ id, ...range, category: z.string().optional(), buyer_id: id.optional(), date_basis: z.enum(['created', 'issued']).default('created') }),
  async handler({ user }, i) { chk(i); await supplierAccess(user, i.id, ['owner', 'finance', 'sales', 'scheduler']); return supplierDashboard(i.id, i); },
});
cap({
  name: 'get_buyer_dashboard', method: 'GET', path: '/service-buyers/:id/dashboard', tag: TAG,
  summary: 'Buyer dashboard: requirement coverage, suppliers invited / responded, award rationale, planned vs committed vs invoiced vs paid, savings against an explicit comparable baseline, invoice exceptions, upcoming / overdue work, supplier delivery performance and recurring maintenance cost. Filters: dates, event, category, supplier, currency.',
  input: z.object({ id, ...range, category: z.string().optional(), event_id: id.optional(), profile_id: id.optional() }),
  async handler({ user }, i) { chk(i); await buyerAccess(user, i.id, ['finance', 'purchaser', 'requester', 'approver', 'evaluator']); return buyerDashboard(i.id, i); },
});
cap({
  name: 'export_service_report', method: 'GET', path: '/service-reports/export', tag: TAG,
  summary: 'Export orders, invoices, payments or the tax summary as CSV (formula-safe, at most 5,000 rows — narrow the dates for more). Totals reconcile to the invoice and payment records. Audited.',
  input: z.object({ side: z.enum(['supplier', 'buyer']), scope_id: id.describe('the supplier profile or procurement context'), report: z.enum(['orders', 'invoices', 'payments', 'tax']), ...range }),
  async handler({ user }, i) {
    chk(i);
    if (i.side === 'supplier') await supplierAccess(user, i.scope_id, ['owner', 'finance']); else await buyerAccess(user, i.scope_id, ['finance', 'purchaser']);
    const rows = await exportRows(i.report, { side: i.side, id: i.scope_id }, i);
    await audit(null, user.id, 'export', 'svc_reports', i.scope_id);
    const cols = rows[0] ? Object.keys(rows[0]) : [];
    return { filename: `${i.side}-${i.report}-${i.from ?? 'all'}-${i.to ?? 'all'}.csv`, rows: rows.length, truncated: rows.length >= 5000, csv: toCsv(cols, rows) };
  },
});
