// Supplier services (#458) — supplier and buyer dashboards, ageing, tax summary and safe CSV exports. Role- and entity-scoped; no supplier ever
// sees another supplier’s bids or another buyer’s finance.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { supplierAccess, buyerAccess } from '../svc/access.js';
import { supplierDashboard, buyerDashboard, exportRows, flattenReport, EXPORT_LIMIT } from '../svc/reports.js';
import { supplierReportDoc, buyerReportDoc, tableReportDoc } from '../svc/documents.js';
import { renderServiceDocument } from '../documents/service-render.js';
import { toCsv } from '../csv.js';
import { xlsx } from '../tender/xlsx.js';
import { enqueue, runJobs } from '../jobs.js';
import { saveEncrypted, loadEncrypted } from '../doc-store.js';
import { audit } from '../helpers.js';
import { badRequest, notFound } from '../errors.js';

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

// ---------------------------------------------------------------- durable exports (CSV / XLSX / PDF), built by the worker
const authorise = (user, side, scopeId) => (side === 'supplier' ? supplierAccess(user, scopeId, ['owner', 'finance']) : buyerAccess(user, scopeId, ['finance', 'purchaser']));
const MIME = { csv: 'text/csv; charset=utf-8', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pdf: 'application/pdf' };

cap({
  name: 'request_service_export', method: 'POST', path: '/service-reports/exports', tag: TAG, status: 202,
  summary: `Start a background export of a report (orders, invoices, payments, tax, or the whole dashboard) as CSV, XLSX or PDF. The worker builds it (up to ${EXPORT_LIMIT.toLocaleString()} rows), stores it encrypted and you download it with get_service_export. Same authority as the synchronous CSV; the file is yours alone and is re-checked against your access when you download it.`,
  input: z.object({ side: z.enum(['supplier', 'buyer']), scope_id: id, report: z.enum(['orders', 'invoices', 'payments', 'tax', 'dashboard']), format: z.enum(['csv', 'xlsx', 'pdf']), ...range }),
  async handler({ user }, i) {
    chk(i);
    await authorise(user, i.side, i.scope_id);
    const { side, scope_id, report, format, ...params } = i;
    return tx(async (c) => {
      const row = (await c.query('INSERT INTO svc_exports(user_id, side, scope_id, report, format, params) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, status, report, format, created_at', [user.id, side, scope_id, report, format, JSON.stringify(params)])).rows[0];
      await enqueue(c, { category: 'svc', kind: 'svc.export', payload: { export_id: row.id }, dedupeKey: `svc.export:${row.id}` });
      return row;
    });
  },
});
cap({
  name: 'list_service_exports', method: 'GET', path: '/service-reports/exports', tag: TAG, summary: 'Your background report exports, newest first, with their status.', input: z.object({ ...page }),
  handler: ({ user }, i) => many('SELECT id, side, scope_id, report, format, status, name, size_bytes, row_count, truncated, error, created_at, completed_at FROM svc_exports WHERE user_id=$1 ORDER BY created_at DESC, id LIMIT $2 OFFSET $3', [user.id, i.limit, i.offset]),
});
cap({
  name: 'get_service_export', method: 'GET', path: '/service-reports/exports/:id', tag: TAG,
  summary: 'Status of a background export and, once ready, the file (text for CSV, base64 for XLSX and PDF) with its sha256. Only the person who requested it, and only while they still hold the finance / purchasing authority it needs. Audited.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const x = await one('SELECT * FROM svc_exports WHERE id=$1 AND user_id=$2', [i.id, user.id]);
    if (!x) throw notFound('Export');
    if (x.status !== 'ready') return { id: x.id, status: x.status, error: x.error };
    await authorise(user, x.side, x.scope_id);
    const buf = await loadEncrypted('svc', 'svc_exports.stored', x.stored);
    await audit(null, user.id, 'export', 'svc_exports', x.id);
    return { id: x.id, status: 'ready', filename: x.name, content_type: x.mime, encoding: x.format === 'csv' ? 'utf8' : 'base64', data: x.format === 'csv' ? buf.toString('utf8') : buf.toString('base64'), rows: x.row_count, truncated: x.truncated, sha256: x.sha256, size_bytes: x.size_bytes };
  },
});

const handlers = {
  'svc.export': async ({ export_id }) => {
    const x = await one('SELECT * FROM svc_exports WHERE id=$1', [export_id]);
    if (!x || x.status !== 'queued') return;
    try {
      const user = await one('SELECT id, roles, display_name FROM users WHERE id=$1', [x.user_id]);
      await authorise(user, x.side, x.scope_id);          // access may have been revoked since the request
      const scope = { side: x.side, id: x.scope_id };
      let buf, rows = 0, truncated = false;
      if (x.report === 'dashboard') {
        if (x.format === 'pdf') { const doc = x.side === 'supplier' ? await supplierReportDoc(x.scope_id, x.params) : await buyerReportDoc(x.scope_id, x.params); buf = (await renderServiceDocument({ doc })).buffer; rows = doc.sections.reduce((n, sec) => n + (sec.rows?.length ?? 0), 0); }
        else { const flat = flattenReport(x.side === 'supplier' ? await supplierDashboard(x.scope_id, x.params) : await buyerDashboard(x.scope_id, x.params)); rows = flat.length; truncated = flat.length >= EXPORT_LIMIT; buf = x.format === 'xlsx' ? xlsx([['metric', 'value'], ...flat.map((r) => [r.metric, typeof r.value === 'number' ? r.value : String(r.value)])], 'Dashboard') : Buffer.from(toCsv(['metric', 'value'], flat)); }
      } else {
        const data = await exportRows(x.report, scope, x.params, EXPORT_LIMIT);
        rows = data.length; truncated = data.length >= EXPORT_LIMIT;
        const cols = data[0] ? Object.keys(data[0]) : [];
        if (x.format === 'pdf') buf = (await renderServiceDocument({ doc: await tableReportDoc(x.report, scope, data) })).buffer;
        else if (x.format === 'xlsx') buf = xlsx([cols, ...data.map((r) => cols.map((c) => (typeof r[c] === 'number' ? r[c] : r[c] == null ? '' : r[c] instanceof Date ? r[c].toISOString().slice(0, 10) : String(r[c]))))], x.report);
        else buf = Buffer.from(toCsv(cols, data));
      }
      const { file } = await saveEncrypted('svc', 'svc_exports.stored', buf);
      await pool.query("UPDATE svc_exports SET status='ready', stored=$2, name=$3, mime=$4, size_bytes=$5, sha256=$6, row_count=$7, truncated=$8, completed_at=now() WHERE id=$1",
        [x.id, file, `${x.side}-${x.report}.${x.format}`, MIME[x.format], buf.length, createHash('sha256').update(buf).digest('hex'), rows, truncated]);
    } catch (e) {
      await pool.query("UPDATE svc_exports SET status='failed', error=$2, completed_at=now() WHERE id=$1", [x.id, String(e.message).slice(0, 300)]);
    }
  },
};
export const runServiceJobs = () => runJobs('svc', handlers);
