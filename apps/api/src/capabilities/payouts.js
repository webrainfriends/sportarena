// One payout path for officials fees, venue settlements and coach/provider earnings (#701). The money rules live in ../payouts.js.
import express from 'express';
import rateLimit from 'express-rate-limit';
import PDFDocument from 'pdfkit';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one } from '../db.js';
import { audit } from '../helpers.js';
import { notFound, unauthorized } from '../errors.js';
import { authenticate } from '../auth.js';
import { config } from '../config.js';
import { toErrorBody } from '../invoke.js';
import { toMajor } from '../currency.js';
import { docHeaders } from '../doc-store.js';
import { eventForOrganizer } from './events.js';
import { SOURCES, approveBatch, batchView, eventOfficialPayouts, cancelBatch, createBatch, exportBatch, executeBatch, listObligations, reconcilePayouts, recordItemResult, retryItem } from '../payouts.js';

const TAG = 'Payouts';
const cur = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/);
const source = z.enum(SOURCES);
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : /^[=+\-@]/.test(s) ? `'${s}` : s; };

cap({
  name: 'list_payable_obligations', method: 'GET', path: '/admin/payouts/obligations', tag: TAG, auth: ['admin'],
  summary: 'Platform team: everything that can be paid now, from all three sources — officials fees the organiser marked due, approved venue settlements, and available coach/provider earnings — with the one thing in the way of each (no or unverified payout account). Items already in a live batch are not listed.',
  input: z.object({ currency: cur.optional(), source: source.optional(), ...page }),
  handler: (_ctx, i) => listObligations(i),
});

cap({
  name: 'create_payout_batch', method: 'POST', path: '/admin/payout-batches', tag: TAG, auth: ['admin'], status: 201, scope: 'payment',
  summary: 'Platform team: group obligations in one currency into a payout batch. Each item is checked against its source and can never exceed it (a seller\'s reconciled available balance, an official\'s due fee, an approved settlement); withholding and fees come from the currency\'s payout settings. A second platform team member approves the batch. `client_key` makes a retry return the same batch.',
  input: z.object({
    currency: cur, rail: z.enum(['bank_file', 'stripe']).default('bank_file'), client_key: z.string().trim().min(8).max(80),
    items: z.array(z.object({ source_type: source, source_id: id.optional(), payee_id: id.optional() })
      .refine((x) => (x.source_type === 'provider_balance' ? !!x.payee_id : !!x.source_id), 'Give the seller for a balance, or the fee/settlement to pay')).min(1).max(200),
  }),
  handler: ({ user }, i) => createBatch(user, i),
});

cap({
  name: 'list_payout_batches', method: 'GET', path: '/admin/payout-batches', tag: TAG, auth: ['admin'],
  summary: 'Platform team: payout batches, newest first, with totals (gross, withheld, fees, net) and status.',
  input: z.object({ status: z.enum(['pending_approval', 'approved', 'exported', 'executing', 'closed', 'cancelled']).optional(), currency: cur.optional(), ...page }),
  handler: (_ctx, i) => many(
    `SELECT b.*, (SELECT count(*)::int FROM payout_items x WHERE x.batch_id=b.id) AS items, (SELECT count(*)::int FROM payout_items x WHERE x.batch_id=b.id AND x.status='pending') AS pending_items,
            (SELECT count(*)::int FROM payout_items x WHERE x.batch_id=b.id AND x.status='failed') AS failed_items
       FROM payout_batches b WHERE ($1::text IS NULL OR b.status=$1) AND ($2::text IS NULL OR b.currency=$2) ORDER BY b.created_at DESC, b.id DESC LIMIT $3 OFFSET $4`,
    [i.status ?? null, i.currency ?? null, i.limit, i.offset]),
});

cap({
  name: 'get_payout_batch', method: 'GET', path: '/admin/payout-batches/:id', tag: TAG, auth: ['admin'],
  summary: 'Platform team: one payout batch with every item, its status, reference or failure, and the full event trail. Bank details are never shown here.',
  input: z.object({ id }),
  handler: (_ctx, i) => batchView(i.id),
});

cap({
  name: 'approve_payout_batch', method: 'POST', path: '/admin/payout-batches/:id/approve', tag: TAG, auth: ['admin'], scope: 'payment',
  summary: 'Platform team: approve a batch. Maker-checker: someone other than the creator approves, unless the batch is at or below the currency\'s approval threshold, or the platform has a single admin (recorded as the approval basis). You cannot approve a batch that pays you. Approving again is harmless.',
  input: z.object({ id, row_version: z.number().int().optional() }),
  handler: ({ user }, i) => approveBatch(user, i),
});

cap({
  name: 'export_payout_batch', method: 'POST', path: '/admin/payout-batches/:id/export', tag: TAG, auth: ['admin'], scope: 'payment',
  summary: 'Platform team: the bank file for an approved batch (CSV with the verified account details of every pending item). Every decrypt of bank details is audit-logged. Returns { filename, rows, csv }; exporting again is harmless.',
  input: z.object({ id }),
  handler: ({ user }, i) => exportBatch(user, i.id),
});

cap({
  name: 'execute_payout_batch', method: 'POST', path: '/admin/payout-batches/:id/execute', tag: TAG, auth: ['admin'], scope: 'payment',
  summary: 'Platform team: send an approved Stripe-rail batch as Stripe Connect transfers. Each transfer uses the item\'s own idempotency key, so running this again after an interruption never pays twice. A provider rejection fails only that item.',
  input: z.object({ id }),
  handler: ({ user }, i) => executeBatch(user, i.id),
});

cap({
  name: 'record_payout_item_result', method: 'POST', path: '/admin/payout-items/:id/result', tag: TAG, auth: ['admin'], scope: 'payment',
  summary: 'Platform team: record what the bank did with one item. `paid` needs the transfer reference (each reference once) and settles the source — the officials pay log, the venue settlement or the seller ledger — and posts to the finance ledger. `failed` needs a code and an explanation the payee sees; the money returns to its source and an exception opens. Repeating the same result is harmless.',
  input: z.object({ id, outcome: z.enum(['paid', 'failed']), reference: z.string().trim().min(4).max(80).optional(),
    failure_code: z.enum(['invalid_account', 'account_closed', 'bank_rejected', 'name_mismatch', 'other']).optional(), reason: z.string().trim().min(5).max(500).optional() }),
  handler: ({ user }, i) => recordItemResult(user, { item_id: i.id, outcome: i.outcome, reference: i.reference, failure_code: i.failure_code, reason: i.reason }),
});

cap({
  name: 'retry_payout_item', method: 'POST', path: '/admin/payout-items/:id/retry', tag: TAG, auth: ['admin'], scope: 'payment',
  summary: 'Platform team: try a failed item again as a new attempt with a new idempotency key. The failed attempt stays in the history; the source is re-checked, so a payout can never be paid twice or above what is owed. Retrying a pending item is harmless.',
  input: z.object({ id }),
  handler: ({ user }, i) => retryItem(user, { item_id: i.id }),
});

cap({
  name: 'cancel_payout_batch', method: 'POST', path: '/admin/payout-batches/:id/cancel', tag: TAG, auth: ['admin'], scope: 'payment',
  summary: 'Platform team: cancel a batch that has not been exported or executed. Seller balances are returned; officials fees and settlements become payable again. Nothing is deleted.',
  input: z.object({ id, reason: z.string().trim().min(5).max(300) }),
  handler: ({ user }, i) => cancelBatch(user, i),
});

cap({
  name: 'reconcile_payouts', method: 'POST', path: '/admin/payouts/reconcile', tag: TAG, auth: ['admin'],
  summary: 'Platform team: check paid payout items against their source, the seller ledger and the finance ledger. Findings are added to the settlement exceptions queue (list_settlement_exceptions); nothing is changed.',
  handler: () => reconcilePayouts(),
});

cap({
  name: 'set_payout_settings', method: 'POST', path: '/admin/payout-settings/:currency', tag: TAG, auth: ['admin'], scope: 'payment',
  summary: 'Platform team: the payout rules for one currency — tax withheld from officials fees and venue settlements (basis points), payout fee (basis points + flat), and the amount at or below which the batch maker may approve alone (empty = a second person always approves).',
  input: z.object({ currency: cur, withholding_bp: z.number().int().min(0).max(10000).default(0), fee_bp: z.number().int().min(0).max(10000).default(0),
    fee_flat_minor: z.number().int().min(0).default(0), approval_threshold_minor: z.number().int().min(0).nullable().default(null) }),
  async handler({ user }, i) {
    const r = await one(
      `INSERT INTO payout_settings(currency, withholding_bp, fee_bp, fee_flat_minor, approval_threshold_minor, updated_by) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (currency) DO UPDATE SET withholding_bp=$2, fee_bp=$3, fee_flat_minor=$4, approval_threshold_minor=$5, updated_by=$6, updated_at=now() RETURNING *`,
      [i.currency, i.withholding_bp, i.fee_bp, i.fee_flat_minor, i.approval_threshold_minor, user.id]);
    await audit(null, user.id, 'set_payout_settings', 'payout_settings', null);
    return r;
  },
});

cap({
  name: 'list_payout_settings', method: 'GET', path: '/admin/payout-settings', tag: TAG, auth: ['admin'],
  summary: 'Platform team: the payout rules per currency.',
  handler: () => many('SELECT * FROM payout_settings ORDER BY currency'),
});

cap({
  name: 'list_my_payout_items', method: 'GET', path: '/me/payout-items', tag: TAG,
  summary: 'Your payout statement: every payment made (or being made) to you through a payout batch, with gross, tax withheld, fees, what reached your bank, the reference, and what it settled. Returns CSV too with `format=csv` as { filename, rows, csv }.',
  input: z.object({ format: z.enum(['json', 'csv']).default('json'), currency: cur.optional(), ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT i.id, i.source_type, i.source_id, i.currency, i.gross_minor, i.tax_minor, i.fee_minor, i.net_minor, i.status, i.reference, i.failure_code, i.failure_reason, i.created_at, i.decided_at, b.batch_no
         FROM payout_items i JOIN payout_batches b ON b.id=i.batch_id WHERE i.payee_id=$1 AND ($2::text IS NULL OR i.currency=$2) ORDER BY i.created_at DESC, i.id DESC LIMIT $3 OFFSET $4`,
      [user.id, i.currency ?? null, i.format === 'csv' ? 5000 : i.limit, i.format === 'csv' ? 0 : i.offset]);
    await audit(null, user.id, 'read_payout_statement', 'payout_items', null);
    if (i.format === 'json') return rows;
    const head = ['date', 'batch', 'for', 'currency', 'gross', 'tax_withheld', 'fee', 'paid_to_bank', 'status', 'reference'];
    const lines = rows.map((r) => [r.created_at.toISOString(), r.batch_no, r.source_type, r.currency, (r.gross_minor / 100).toFixed(2), (r.tax_minor / 100).toFixed(2), (r.fee_minor / 100).toFixed(2), (r.net_minor / 100).toFixed(2), r.status, r.reference ?? '']);
    return { filename: 'payout-statement.csv', rows: lines.length, csv: [head, ...lines].map((r) => r.map(csvCell).join(',')).join('\n') };
  },
});

cap({
  name: 'get_payout_item', method: 'GET', path: '/payout-items/:id', tag: TAG,
  summary: 'One payout item you are paid by (404 for anyone else): amounts, status, reference, and the failure explanation if it failed.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one('SELECT i.id, i.source_type, i.currency, i.gross_minor, i.tax_minor, i.fee_minor, i.net_minor, i.status, i.attempt, i.reference, i.failure_code, i.failure_reason, i.created_at, i.decided_at FROM payout_items i WHERE i.id=$1 AND i.payee_id=$2', [i.id, user.id]);
    if (!r) throw notFound('Payout item');
    return r;
  },
});

cap({
  name: 'list_event_official_payouts', method: 'GET', path: '/events/:id/official-payouts', tag: TAG,
  summary: 'Event organiser: every officials fee on the event with where its payout stands — due, in a payout batch, paid (with the transfer reference) or failed. Read only: the platform team pays the fees; mark a fee `due` (set_official_fee) to make it payable.',
  input: z.object({ id }),
  async handler({ user }, i) { await eventForOrganizer(user, i.id); return eventOfficialPayouts(i.id); },
});

const LABEL = { official_fee: 'Officials fee', venue_settlement: 'Venue settlement', provider_balance: 'Earnings payout' };
/** Binary route: the payee's own statement for one payout item, as a PDF. 404 for anyone else. Every read is audit-logged. */
export function payoutStatementRouter() {
  const r = express.Router();
  const limiter = rateLimit({ windowMs: 60_000, limit: config.isProd ? 30 : 1000, standardHeaders: true, legacyHeaders: false });
  r.get('/payout-items/:id/statement.pdf', limiter, async (req, res) => {
    try {
      const user = await authenticate(req.headers.authorization); if (!user) throw unauthorized();
      const iid = String(req.params.id); if (!/^[0-9a-f-]{36}$/.test(iid)) throw notFound('Payout item');
      const it = await one("SELECT i.*, u.display_name AS payee, b.batch_no FROM payout_items i JOIN users u ON u.id=i.payee_id JOIN payout_batches b ON b.id=i.batch_id WHERE i.id=$1 AND i.payee_id=$2 AND i.status='paid'", [iid, user.id]);
      if (!it) throw notFound('Payout item');
      const doc = new PDFDocument({ size: 'A4', margin: 56, info: { Title: `Payout statement ${it.batch_no}`, Producer: 'Sportarena' } });
      const chunks = []; doc.on('data', (c) => chunks.push(c));
      const done = new Promise((ok, bad) => { doc.on('end', ok); doc.on('error', bad); });
      const m = (v) => `${it.currency} ${toMajor(Number(v), it.currency)}`;
      doc.font('Helvetica-Bold').fontSize(18).text('Payout statement');
      doc.font('Helvetica').fontSize(10).fillColor('#555').text(`Batch ${it.batch_no} - ${new Date(it.decided_at).toISOString().slice(0, 10)}`).moveDown(1.2).fillColor('#000');
      doc.fontSize(11).text(`Payee: ${it.payee}`).text(`For: ${LABEL[it.source_type] ?? it.source_type}`).text(`Transfer reference: ${it.reference}`).moveDown();
      for (const [k, v, bold] of [['Gross', m(it.gross_minor)], ['Tax withheld', `- ${m(it.tax_minor)}`], ['Fees', `- ${m(it.fee_minor)}`], ['Paid to your bank', m(it.net_minor), true]]) {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').text(`${k}: ${v}`);
      }
      doc.moveDown().font('Helvetica').fontSize(9).fillColor('#555').text('Tax withheld is shown for your records and is not tax advice. Keep this statement with your accounts.');
      doc.end(); await done;
      await audit(null, user.id, 'read_payout_statement', 'payout_items', it.id);
      const buffer = Buffer.concat(chunks);
      res.set(docHeaders('application/pdf', buffer)).set('Content-Disposition', `inline; filename="payout-statement-${it.batch_no}.pdf"`);
      res.end(buffer);
    } catch (e) { const { status, code, message, details } = toErrorBody(e); res.status(status).json({ error: { code, message, details } }); }
  });
  return r;
}
