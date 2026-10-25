// Supplier invoicing on the canonical `invoices` table: numbering, cumulative-billing guards, tax evidence, payments and roll-ups.
// Procurement, fulfilment, billing and settlement stay separate states; "completed" never implies "paid".
import { encrypt } from '../crypto.js';
import { conflict, badRequest } from '../errors.js';
import { priced, withholding } from './money.js';
import { nextNumber } from './access.js';
import { mirrorPayment } from './budget.js';
import { notify } from '../notify.js';

export const q1 = async (c, t, a) => (await c.query(t, a)).rows[0];
export const prefixOf = (p) => p.invoice_prefix ?? `S${p.id.replace(/-/g, '').slice(0, 5).toUpperCase()}`;

/** Price invoice lines from the order's own rates and tax snapshot, add configured withholding and the evidence for it. */
export async function priceInvoice(c, order, profile, items) {
  const t = priced(items.map((it) => ({ ...it.line, quantity: it.quantity, rate_minor: Number(it.line.rate_minor), discount_minor: it.discount_minor ?? 0 })), { inclusive: !!order.tax_snapshot?.inclusive, rounding: order.tax_snapshot?.rounding ?? 'per_line' });
  const rules = {}; let hold = 0;
  for (const l of t.lines) {
    if (!l.tax_code || rules[l.tax_code] !== undefined) continue;
    rules[l.tax_code] = await q1(c, 'SELECT code, name, jurisdiction, treatment, rate_bp, withholding_bp, evidence, effective_from FROM svc_tax_rules WHERE profile_id=$1 AND code=$2 AND effective_from <= current_date AND (effective_to IS NULL OR effective_to >= current_date) ORDER BY effective_from DESC LIMIT 1', [profile.id, l.tax_code]);
  }
  for (const l of t.lines) { const r = l.tax_code ? rules[l.tax_code] : null; if (r?.withholding_bp) hold += withholding(l.net_minor, r.withholding_bp); }
  return { ...t, withholding: hold, evidence: { rules, inclusive: !!order.tax_snapshot?.inclusive, rounding: order.tax_snapshot?.rounding ?? 'per_line', reverse_charge: t.lines.some((l) => l.tax_treatment === 'reverse_charge'), note: 'Tax treatment is the supplier’s own configuration; Gotmygame does not assert it is correct for any jurisdiction.' } };
}

/** Billing and settlement roll-up for an order, from issued invoices, credit notes and verified/recorded payments. Pure facts; never touches fulfilment. */
export async function refreshOrderMoney(c, orderId) {
  const o = await q1(c, 'SELECT * FROM svc_orders WHERE id=$1', [orderId]);
  const s = await q1(c, `SELECT coalesce(sum(CASE WHEN doc_type IN ('invoice','debit_note') THEN gross_minor WHEN doc_type='credit_note' THEN -gross_minor ELSE 0 END),0)::bigint AS billed,
                                coalesce(sum(CASE WHEN doc_type IN ('invoice','debit_note') THEN paid_minor ELSE 0 END),0)::bigint AS paid
                           FROM svc_invoices WHERE order_id=$1 AND status='issued'`, [orderId]);
  const billed = Number(s.billed), paid = Number(s.paid), gross = Number(o.gross_minor);
  const billing = billed <= 0 ? 'not_billed' : billed >= gross ? 'billed' : 'partially_billed';
  const settlement = paid <= 0 ? 'unpaid' : paid >= billed && billed > 0 ? 'paid' : 'partially_paid';
  return q1(c, 'UPDATE svc_orders SET billing=$2, settlement=$3, updated_at=now() WHERE id=$1 RETURNING *', [orderId, billing, settlement]);
}

/** Re-derive paid amount and status of one invoice from its non-void payments, then reflect on the canonical row and the order. */
export async function recomputeInvoice(c, invId) {
  const inv = await q1(c, 'SELECT * FROM svc_invoices WHERE id=$1 FOR UPDATE', [invId]);
  const paid = Number((await q1(c, "SELECT coalesce(sum(amount_minor),0)::bigint AS s FROM svc_payments WHERE svc_invoice_id=$1 AND status <> 'voided'", [invId])).s);
  const due = Number(inv.payable_minor) - Number(inv.credited_minor);
  const status = paid <= 0 ? 'unpaid' : paid >= due ? 'paid' : 'partially_paid';
  const row = await q1(c, 'UPDATE svc_invoices SET paid_minor=$2, pay_status=$3 WHERE id=$1 RETURNING *', [invId, paid, status]);
  if (inv.invoice_id) await c.query("UPDATE invoices SET status=CASE WHEN $2 THEN 'paid' ELSE 'open' END, paid_at=CASE WHEN $2 THEN coalesce(paid_at, now()) ELSE NULL END WHERE id=$1 AND status <> 'void'", [inv.invoice_id, status === 'paid']);
  await refreshOrderMoney(c, inv.order_id);
  return row;
}

/** Add one payment under the invoice lock. Cumulative payments can never exceed what is payable (gross − withholding − credits). */
export async function addPayment(c, svcInvoiceId, p, actor) {
  const inv = await q1(c, 'SELECT * FROM svc_invoices WHERE id=$1 FOR UPDATE', [svcInvoiceId]);
  if (!inv || inv.status !== 'issued' || inv.doc_type !== 'invoice' && inv.doc_type !== 'debit_note') throw conflict('Only an issued invoice can be paid');
  if (p.idempotency_key) { const d = await q1(c, 'SELECT * FROM svc_payments WHERE svc_invoice_id=$1 AND idempotency_key=$2', [inv.id, p.idempotency_key]); if (d) return { payment: d, invoice: inv, replayed: true }; }
  const due = Number(inv.payable_minor) - Number(inv.credited_minor) - Number(inv.paid_minor);
  if (p.amount_minor > due) throw conflict(`Only ${due} is still payable on this invoice`);
  let pay;
  try {
    pay = await q1(c, 'INSERT INTO svc_payments(svc_invoice_id, source, amount_minor, currency, paid_on, reference, evidence, payment_id, status, recorded_by, payout_state, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
      [inv.id, p.source, p.amount_minor, inv.currency, p.paid_on, p.reference ?? null, p.evidence ?? null, p.payment_id ?? null, p.source === 'provider' ? 'verified' : 'recorded', actor.id, p.source === 'provider' ? 'manual_pending' : 'not_applicable', p.idempotency_key ?? null]);
  } catch (e) { if (e.code === '23505') throw conflict('That payment (reference or provider payment) is already recorded'); throw e; }
  const row = await recomputeInvoice(c, inv.id);
  const order = await q1(c, 'SELECT * FROM svc_orders WHERE id=$1', [inv.order_id]);
  await mirrorPayment(c, order, pay, actor);
  return { payment: pay, invoice: row };
}

/** A provider payment settled for a service invoice (called from the payments module). false = it can no longer be applied, so the payment is refunded. */
export async function fulfilServiceInvoicePaid(c, invoiceId, payment) {
  const inv = await q1(c, 'SELECT * FROM svc_invoices WHERE id=$1 FOR UPDATE', [invoiceId]);
  if (!inv || inv.status !== 'issued') return false;
  if (await q1(c, 'SELECT 1 FROM svc_payments WHERE payment_id=$1', [payment.id])) return true;            // provider retry: already applied
  const due = Number(inv.payable_minor) - Number(inv.credited_minor) - Number(inv.paid_minor);
  if (Number(payment.amount_cents) > due) return false;
  const actor = { id: payment.payer_id };
  await addPayment(c, inv.id, { source: 'provider', amount_minor: Number(payment.amount_cents), paid_on: new Date().toISOString().slice(0, 10), reference: payment.provider_ref ?? `provider:${payment.id}`, payment_id: payment.id }, actor);
  const o = await q1(c, 'SELECT profile_id FROM svc_orders WHERE id=$1', [inv.order_id]);
  for (const u of (await c.query("SELECT owner_id AS u FROM svc_profiles WHERE id=$1 UNION SELECT user_id FROM svc_staff WHERE profile_id=$1 AND status='active' AND role IN ('owner','finance')", [o.profile_id])).rows.map((r) => r.u)) {
    await notify(c, u, { kind: 'svc_payment_received', title: 'An invoice was paid online', body: 'Open Gotmygame to see the payment. Paying the supplier out is recorded manually.', data: { svc_invoice_id: inv.id }, dedupe_key: `svc:pay:${payment.id}:${u}` });
  }
  return true;
}

/** The canonical invoices row for an issued supplier invoice / credit note (immutable snapshot of lines and totals). */
export async function writeCanonical(c, { inv, order, profile, buyer, kind, parentCanonicalId = null, number }) {
  const seller = { name: profile.legal_name, trading_name: profile.trading_name, tax_id: profile.tax_registration, address: profile.billing_address, phone: null, email: null };
  const billTo = { name: buyer.name, address: null, tax_id: null };
  return q1(c, `INSERT INTO invoices(kind, number, svc_order_id, svc_profile_id, user_id, parent_id, currency, status, total_cents, tax_cents, tax_name, tax_rate_bp, tax_inclusive, seller, buyer_enc, lines)
                VALUES ($1,$2,$3,$4,$5,$6,$7,'open',$8,$9,'Tax',0,$10,$11,$12,$13) RETURNING *`,
    [kind, number, order.id, profile.id, buyer.owner_id, parentCanonicalId, inv.currency, inv.gross_minor, inv.tax_minor, inv.prices_include_tax, seller, encrypt(JSON.stringify(billTo), 'invoices.buyer'), JSON.stringify(inv.lines)]);
}
export const docNumber = async (c, profile, kind) => nextNumber(c, profile.id, kind, `${kind === 'credit_note' ? 'CN-' : kind === 'proforma' ? 'PF-' : kind === 'debit_note' ? 'DN-' : ''}${prefixOf(profile)}`);
export { badRequest };
