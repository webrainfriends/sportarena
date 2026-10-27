// Supplier services (#458) 5/5b — supplier invoices, credit notes, tax evidence, matching, manual and online payments, statements.
// Issued invoices are immutable snapshots on the canonical `invoices` table; corrections are linked credit notes. Gotmygame never claims a
// supplier payout happened unless someone recorded it, and never claims jurisdictional tax or e-invoicing compliance.
import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { supplierAccess, buyerAccess, log } from '../svc/access.js';
import { loadOrder, activeLines, q1 } from '../svc/orders.js';
import { serviceExponent } from '../svc/money.js';
import { priceInvoice, refreshOrderMoney, recomputeInvoice, addPayment, writeCanonical, docNumber } from '../svc/finance.js';
import { approvalNeeded, handlers } from '../svc/approvals.js';
import { unmirrorPayment } from '../svc/budget.js';
import { startCheckout, enabledProviders } from '../payments/service.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { buyerAudience } from './svc-rfq.js';

const TAG = 'Supplier invoicing';
const day = z.string().date();
const KINDS = ['deposit', 'progress', 'milestone', 'final', 'visit'];
const tell = async (c, users, msg, actor) => { for (const u of new Set(users)) if (u !== actor) await notify(c, u, msg); };
const SUPPLIER_FIN = ['owner', 'finance'];

/** Build the (unsaved) invoice from the order's own rates. Quantities are checked against accepted-and-not-yet-invoiced work. */
async function build(c, order, profile, i) {
  const lines = await activeLines(c, order.id);
  const items = []; let extra = [];
  if (i.kind === 'deposit') {
    const agreed = Number(order.terms?.deposit_bp ?? 0);
    if (!agreed) throw badRequest('No deposit was agreed in this order’s terms');
    const bp = i.deposit_bp ?? agreed;
    const prior = Number((await q1(c, "SELECT coalesce(sum(CASE WHEN doc_type='credit_note' THEN -net_minor ELSE net_minor END),0)::bigint AS s FROM svc_invoices WHERE order_id=$1 AND kind='deposit' AND status='issued'", [order.id])).s);
    const net = Math.round((Number(order.net_minor) * bp) / 10000);
    if (prior + net > Math.round((Number(order.net_minor) * agreed) / 10000)) throw conflict('That would bill more deposit than the order agreed');
    const taxed = lines.find((l) => l.tax_code) ?? lines[0];
    items.push({ line: { id: null, line_no: 0, description: `Deposit (${(bp / 100).toFixed(2)}%) — order ${order.number}`, unit: 'unit', rate_minor: net, tax_code: taxed?.tax_code ?? null, tax_bp: taxed?.tax_bp ?? 0, tax_treatment: taxed?.tax_treatment ?? 'standard', line_type: 'service' }, quantity: 1 });
  } else {
    if (!i.lines?.length) throw badRequest('Choose the order lines and quantities to bill');
    for (const r of i.lines) {
      const l = lines.find((x) => x.line_no === r.line_no);
      if (!l) throw notFound(`Order line ${r.line_no}`);
      if (i.kind === 'milestone' && l.milestone !== i.milestone) throw badRequest(`Line ${l.line_no} is not part of milestone “${i.milestone}”`);
      const left = Number(l.qty_accepted) - Number(l.qty_invoiced);
      if (r.quantity > left + 1e-9) throw conflict(`Line ${l.line_no}: only ${left} is accepted and not yet invoiced`);
      const disc = Math.round((Number(l.discount_minor) * r.quantity) / Math.max(Number(l.qty_ordered), 1e-9));
      items.push({ line: l, quantity: r.quantity, discount_minor: disc });
    }
    if (i.kind === 'final') {
      const dep = await q1(c, "SELECT coalesce(sum(CASE WHEN doc_type='credit_note' THEN -net_minor ELSE net_minor END),0)::bigint AS n, coalesce(sum(CASE WHEN doc_type='credit_note' THEN -tax_minor ELSE tax_minor END),0)::bigint AS t FROM svc_invoices WHERE order_id=$1 AND kind='deposit' AND status='issued'", [order.id]);
      const applied = await q1(c, "SELECT coalesce(sum(-(l->>'net_minor')::bigint),0)::bigint AS n FROM svc_invoices s, jsonb_array_elements(s.lines) l WHERE s.order_id=$1 AND s.status='issued' AND s.doc_type='invoice' AND (l->>'order_line_id') IS NULL AND (l->>'net_minor')::bigint < 0", [order.id]);
      const netLeft = Number(dep.n) - Number(applied.n);
      if (netLeft > 0) extra = [{ netLeft, taxRatio: Number(dep.n) ? Number(dep.t) / Number(dep.n) : 0 }];
    }
  }
  const t = await priceInvoice(c, order, profile, items);
  const out = t.lines.map((l, n) => ({ order_line_id: items[n].line.id, line_no: items[n].line.line_no, description: l.description, unit: l.unit, quantity: items[n].quantity, rate_minor: Number(l.rate_minor), discount_minor: items[n].discount_minor ?? 0, tax_code: l.tax_code, tax_bp: l.tax_bp, tax_treatment: l.tax_treatment, net_minor: l.net_minor, tax_minor: l.tax_minor, gross_minor: l.gross_minor, milestone: l.milestone ?? null }));
  let { net, tax, gross } = t;
  if (extra.length) {
    const cut = Math.min(extra[0].netLeft, net); const ctax = Math.round(cut * extra[0].taxRatio);
    out.push({ order_line_id: null, line_no: null, description: 'Less: deposit already invoiced', unit: 'unit', quantity: 1, rate_minor: -cut, discount_minor: 0, tax_code: null, tax_bp: 0, tax_treatment: 'standard', net_minor: -cut, tax_minor: -ctax, gross_minor: -(cut + ctax) });
    net -= cut; tax -= ctax; gross -= cut + ctax;
  }
  const hold = Math.min(t.withholding, net);
  return { lines: out, net, tax, gross, withholding: hold, payable: gross - hold, evidence: t.evidence };
}

cap({
  name: 'create_service_invoice', method: 'POST', path: '/service-orders/:id/invoices', tag: TAG, status: 201,
  summary: 'Supplier finance: draft an invoice (or a clearly labelled pro forma) from a service order. Lines are priced from the order’s own rates and tax snapshot; quantities are capped at accepted-and-not-yet-invoiced work (deposit and milestone billing follow the agreed order terms). Configured withholding is evidenced and deducted from what is payable. Nothing is consumed until the invoice is issued.',
  input: z.object({ id, doc_type: z.enum(['proforma', 'invoice']).default('invoice'), kind: z.enum(KINDS).default('progress'), lines: z.array(z.object({ line_no: z.number().int().positive(), quantity: z.number().positive().max(1e9) })).max(100).optional(), milestone: z.string().max(80).optional(), deposit_bp: z.number().int().min(1).max(10000).optional(), service_period: z.object({ from: day, to: day }).optional(), due_on: day.optional(), po_reference: z.string().max(80).optional(), supplier_number: z.string().min(1).max(40).optional(), idempotency_key: z.string().min(1).max(64).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const o = await loadOrder(c, i.id, { lock: true });
      const { profile } = await supplierAccess(user, o.profile_id, SUPPLIER_FIN, c);
      if (i.idempotency_key) { const d = await q1(c, 'SELECT * FROM svc_invoices WHERE profile_id=$1 AND idempotency_key=$2', [profile.id, i.idempotency_key]); if (d) return { ...d, replayed: true }; }
      if (!['confirmed', 'in_progress', 'paused', 'completed', 'terminated'].includes(o.status)) throw conflict(`Order is ${o.status}; it cannot be billed`);
      if (i.service_period && i.service_period.to < i.service_period.from) throw badRequest('service_period ends before it starts');
      const buyer = await q1(c, 'SELECT * FROM svc_buyers WHERE id=$1', [o.buyer_id]);
      const b = await build(c, o, profile, i);
      return q1(c, `INSERT INTO svc_invoices(order_id, profile_id, buyer_id, doc_type, supplier_number, status, currency, lines, net_minor, tax_minor, gross_minor, withholding_minor, payable_minor, prices_include_tax, kind, milestone, service_period, po_reference, due_on, tax_evidence, idempotency_key, created_by)
                    VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
        [o.id, profile.id, buyer.id, i.doc_type, i.supplier_number ?? 'draft', o.currency, JSON.stringify(b.lines), b.net, b.tax, b.gross, b.withholding, b.payable, !!o.tax_snapshot?.inclusive, i.kind, i.milestone ?? null, i.service_period ? `[${i.service_period.from},${i.service_period.to}]` : null, i.po_reference ?? o.number, i.due_on ?? null, b.evidence, i.idempotency_key ?? null, user.id]);
    });
  },
});

cap({
  name: 'issue_service_invoice', method: 'POST', path: '/service-invoices/:id/issue', tag: TAG,
  summary: 'Supplier finance: issue a draft. Re-checks cumulative billing atomically (over-billing and duplicates are refused), numbers it gapless per issuer, writes the immutable canonical invoice and sets its match state: normal progress/final billing against accepted work is matched; deposits/prepayments are an exception that needs an authorised approver. A pro forma is numbered PF- and is not a tax invoice.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const inv = await q1(c, 'SELECT * FROM svc_invoices WHERE id=$1 FOR UPDATE', [i.id]);
      if (!inv) throw notFound('Invoice');
      const o = await loadOrder(c, inv.order_id, { lock: true });
      const { profile } = await supplierAccess(user, o.profile_id, SUPPLIER_FIN, c);
      if (inv.status !== 'draft') throw conflict(`Invoice is already ${inv.status}`);
      const buyer = await q1(c, 'SELECT * FROM svc_buyers WHERE id=$1', [inv.buyer_id]);
      const number = await docNumber(c, profile, inv.doc_type === 'proforma' ? 'proforma' : 'invoice');
      if (inv.doc_type === 'proforma') {
        const row = await q1(c, "UPDATE svc_invoices SET status='issued', supplier_number=$2, issued_at=now(), match_status='unchecked' WHERE id=$1 RETURNING *", [inv.id, number]);
        return { ...row, label: 'PRO FORMA — not a tax invoice' };
      }
      // re-validate against live acceptance under the order lock; the guarded UPDATE is the atomic over-billing stop
      if (inv.kind === 'deposit') {
        const agreed = Number(o.terms?.deposit_bp ?? 0);
        const prior = Number((await q1(c, "SELECT coalesce(sum(CASE WHEN doc_type='credit_note' THEN -net_minor ELSE net_minor END),0)::bigint AS s FROM svc_invoices WHERE order_id=$1 AND kind='deposit' AND status='issued'", [o.id])).s);
        if (!agreed || prior + Number(inv.net_minor) > Math.round((Number(o.net_minor) * agreed) / 10000)) throw conflict('That would bill more deposit than the order agreed');
      } else {
        for (const l of inv.lines) {
          if (!l.order_line_id) continue;
          const r = await q1(c, 'UPDATE svc_order_lines SET qty_invoiced = qty_invoiced + $2 WHERE id=$1 AND qty_invoiced + $2 <= qty_accepted RETURNING id', [l.order_line_id, l.quantity]);
          if (!r) throw conflict(`Line ${l.line_no}: that is more than has been accepted and not yet invoiced`);
        }
      }
      const needsMatchApproval = inv.kind === 'deposit' && (buyer.approval_policy?.require_invoice_match !== false);
      const canon = await writeCanonical(c, { inv: { ...inv, lines: inv.lines }, order: o, profile, buyer, kind: 'invoice', number });
      const row = await q1(c, "UPDATE svc_invoices SET status='issued', supplier_number=$2, invoice_id=$3, issued_at=now(), match_status=$4, match_detail=$5 WHERE id=$1 RETURNING *",
        [inv.id, number, canon.id, needsMatchApproval ? 'exception' : 'matched', needsMatchApproval ? { exception: 'prepayment', detail: 'Billed before service acceptance; needs an authorised approver before it can be paid.' } : { order: o.number, accepted_covers_invoiced: true }]);
      await refreshOrderMoney(c, o.id);
      await tell(c, await buyerAudience(c, buyer.id, ['finance']), { kind: 'svc_invoice_issued', title: 'You received an invoice', body: `Invoice ${number} was issued for order ${o.number}.`, data: { svc_invoice_id: inv.id }, dedupe_key: `svc:inv:${inv.id}` }, user.id);
      await log(c, 'invoice', inv.id, user.id, 'issued', { number });
      return row;
    });
  },
});

cap({
  name: 'discard_service_invoice', method: 'POST', path: '/service-invoices/:id/discard', tag: TAG,
  summary: 'Supplier finance: discard a draft invoice (kept as void). Issued invoices are corrected with a credit note, never discarded.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const inv = await q1(c, 'SELECT * FROM svc_invoices WHERE id=$1 FOR UPDATE', [i.id]);
      if (!inv) throw notFound('Invoice');
      await supplierAccess(user, inv.profile_id, SUPPLIER_FIN, c);
      if (inv.status !== 'draft') throw conflict('Only a draft can be discarded; issue a credit note for an issued invoice');
      return q1(c, "UPDATE svc_invoices SET status='void' WHERE id=$1 RETURNING *", [inv.id]);
    });
  },
});

cap({
  name: 'issue_service_credit_note', method: 'POST', path: '/service-invoices/:id/credit-note', tag: TAG, status: 201,
  summary: 'Supplier finance: credit part or all of an issued invoice (linked credit note, gapless CN- number). Optionally restore billed quantities so they can be re-invoiced (the credit + replacement workflow). Credits are capped at what remains uncredited; a credited paid invoice records a manual refund due — never a false “refunded”.',
  input: z.object({ id, amount_minor: money.refine((n) => n > 0, 'amount must be above 0'), reason: z.string().min(1).max(500), restore_quantities: z.array(z.object({ line_no: z.number().int().positive(), quantity: z.number().positive() })).max(50).optional(), idempotency_key: z.string().min(1).max(64).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p = await q1(c, 'SELECT * FROM svc_invoices WHERE id=$1 FOR UPDATE', [i.id]);
      if (!p || p.doc_type !== 'invoice') throw notFound('Invoice');
      const o = await loadOrder(c, p.order_id, { lock: true });
      const { profile } = await supplierAccess(user, p.profile_id, SUPPLIER_FIN, c);
      if (p.status !== 'issued') throw conflict(`Invoice is ${p.status}`);
      if (i.idempotency_key) { const d = await q1(c, 'SELECT * FROM svc_invoices WHERE profile_id=$1 AND idempotency_key=$2', [profile.id, i.idempotency_key]); if (d) return { ...d, replayed: true }; }
      const room = Number(p.gross_minor) - Number(p.credited_minor);
      if (i.amount_minor > room) throw conflict(`Only ${room} of this invoice can still be credited`);
      const ratio = Number(p.gross_minor) ? i.amount_minor / Number(p.gross_minor) : 0;
      const tax = Math.round(Number(p.tax_minor) * ratio); const net = i.amount_minor - tax;
      for (const r of i.restore_quantities ?? []) {
        const l = await q1(c, 'SELECT * FROM svc_order_lines WHERE order_id=$1 AND line_no=$2 FOR UPDATE', [o.id, r.line_no]);
        if (!l || l.qty_invoiced < r.quantity) throw conflict(`Line ${r.line_no}: cannot restore more than was invoiced`);
        await c.query('UPDATE svc_order_lines SET qty_invoiced = qty_invoiced - $2 WHERE id=$1', [l.id, r.quantity]);
      }
      const buyer = await q1(c, 'SELECT * FROM svc_buyers WHERE id=$1', [p.buyer_id]);
      const number = await docNumber(c, profile, 'credit_note');
      const lines = [{ order_line_id: null, line_no: null, description: `Credit against ${p.supplier_number}: ${i.reason}`, unit: 'unit', quantity: 1, rate_minor: net, discount_minor: 0, tax_code: null, tax_bp: 0, tax_treatment: 'standard', net_minor: net, tax_minor: tax, gross_minor: i.amount_minor }];
      const doc = { currency: p.currency, gross_minor: i.amount_minor, tax_minor: tax, prices_include_tax: p.prices_include_tax, lines };
      const canon = await writeCanonical(c, { inv: doc, order: o, profile, buyer, kind: 'credit_note', parentCanonicalId: p.invoice_id, number });
      const row = await q1(c, `INSERT INTO svc_invoices(invoice_id, order_id, profile_id, buyer_id, doc_type, parent_id, supplier_number, status, currency, lines, net_minor, tax_minor, gross_minor, payable_minor, prices_include_tax, kind, po_reference, match_status, idempotency_key, issued_at, created_by)
                              VALUES ($1,$2,$3,$4,'credit_note',$5,$6,'issued',$7,$8,$9,$10,$11,$11,$12,'adjustment',$13,'matched',$14,now(),$15) RETURNING *`,
        [canon.id, o.id, profile.id, buyer.id, p.id, number, p.currency, JSON.stringify(lines), net, tax, i.amount_minor, p.prices_include_tax, p.po_reference, i.idempotency_key ?? null, user.id]);
      await c.query('UPDATE svc_invoices SET credited_minor = credited_minor + $2 WHERE id=$1', [p.id, i.amount_minor]);
      await c.query("UPDATE invoices SET credits_cents = credits_cents + $2 WHERE id=$1", [p.invoice_id, i.amount_minor]);
      const parent = await recomputeInvoice(c, p.id);
      const refundDue = Math.max(0, Number(parent.paid_minor) - (Number(parent.payable_minor) - Number(parent.credited_minor)));
      if (refundDue > 0) await c.query("UPDATE invoices SET refund_status='manual' WHERE id=$1", [canon.id]);
      await tell(c, await buyerAudience(c, buyer.id, ['finance']), { kind: 'svc_credit_note', title: 'You received a credit note', body: `Credit note ${number} was issued.`, data: { svc_invoice_id: row.id }, dedupe_key: `svc:cn:${row.id}` }, user.id);
      await log(c, 'invoice', p.id, user.id, 'credited', { number, amount_minor: i.amount_minor, reason: i.reason });
      return { ...row, refund_due_minor: refundDue, refund_note: refundDue ? 'A refund is due and must be paid and recorded manually; nothing has been transferred.' : null };
    });
  },
});

// ---------------------------------------------------------------- reading
const invoiceView = async (c, user, row, { audit: doAudit = true } = {}) => {
  let sup = null, buy = null;
  try { sup = await supplierAccess(user, row.profile_id, ['owner', 'finance', 'sales'], c); } catch (e) { if (e.status === 403) throw e; }
  try { buy = await buyerAccess(user, row.buyer_id, ['finance', 'purchaser', 'approver', 'requester'], c); } catch (e) { if (e.status === 403) throw e; }
  if (!sup && !buy) throw notFound('Invoice');
  if (row.status === 'draft' && !sup) throw notFound('Invoice');
  if (doAudit) await audit(c, user.id, 'read_pii', 'svc_invoices', row.id);
  return { sup, buy };
};
cap({
  name: 'get_service_invoice', method: 'GET', path: '/service-invoices/:id', tag: TAG,
  summary: 'An invoice / credit note / pro forma with lines, tax evidence, match state and payments. Buyer finance and the supplier’s finance team only; drafts are the supplier’s alone. Reads are audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const row = await q1(c, 'SELECT * FROM svc_invoices WHERE id=$1', [i.id]);
      if (!row) throw notFound('Invoice');
      const { sup } = await invoiceView(c, user, row);
      const payments = (await c.query("SELECT id, source, amount_minor, paid_on, reference, status, payout_state, recorded_by, created_at, voided_at, void_reason FROM svc_payments WHERE svc_invoice_id=$1 ORDER BY created_at", [row.id])).rows;
      const o = await q1(c, 'SELECT number, event_id FROM svc_orders WHERE id=$1', [row.order_id]);
      const { idempotency_key, ...rest } = row;
      return { ...rest, label: row.doc_type === 'proforma' ? 'PRO FORMA — not a tax invoice' : null, order_number: o.number, outstanding_minor: row.doc_type === 'invoice' ? Number(row.payable_minor) - Number(row.credited_minor) - Number(row.paid_minor) : 0, payments, can_pay_online: enabledProviders().length > 0 && serviceExponent(row.currency) !== 3 && row.doc_type === 'invoice' && row.status === 'issued' && ['matched', 'exception_approved'].includes(row.match_status) && row.pay_status !== 'paid', side: sup ? 'supplier' : 'buyer' };
    });
  },
});
cap({
  name: 'list_service_invoices', method: 'GET', path: '/service-invoices', tag: TAG,
  summary: 'Invoices for a supplier profile (side=supplier) or a procurement context (side=buyer). Drafts are only listed to the supplier.',
  input: z.object({ side: z.enum(['buyer', 'supplier']), profile_id: id.optional(), buyer_id: id.optional(), order_id: id.optional(), status: z.string().optional(), doc_type: z.enum(['proforma', 'invoice', 'credit_note', 'debit_note']).optional(), pay_status: z.enum(['unpaid', 'partially_paid', 'paid', 'refunded']).optional(), ...page }),
  async handler({ user }, i) {
    if (i.side === 'supplier') { if (!i.profile_id) throw badRequest('profile_id is required'); await supplierAccess(user, i.profile_id, ['owner', 'finance', 'sales']); }
    else { if (!i.buyer_id) throw badRequest('buyer_id is required'); await buyerAccess(user, i.buyer_id, ['finance', 'purchaser', 'approver', 'requester']); }
    return many(`SELECT s.id, s.doc_type, s.kind, s.supplier_number, s.status, s.currency, s.net_minor, s.tax_minor, s.gross_minor, s.withholding_minor, s.payable_minor, s.paid_minor, s.credited_minor, s.pay_status, s.match_status, s.due_on, s.issued_at, s.order_id, o.number AS order_number
                   FROM svc_invoices s JOIN svc_orders o ON o.id=s.order_id
                  WHERE (($1='supplier' AND s.profile_id=$2) OR ($1='buyer' AND s.buyer_id=$3 AND s.status <> 'draft')) AND ($4::uuid IS NULL OR s.order_id=$4) AND ($5::text IS NULL OR s.status=$5) AND ($6::text IS NULL OR s.doc_type=$6) AND ($7::text IS NULL OR s.pay_status=$7)
                  ORDER BY coalesce(s.issued_at, s.created_at) DESC, s.id LIMIT $8 OFFSET $9`, [i.side, i.profile_id ?? null, i.buyer_id ?? null, i.order_id ?? null, i.status ?? null, i.doc_type ?? null, i.pay_status ?? null, i.limit, i.offset]);
  },
});
cap({
  name: 'get_service_payment_schedule', method: 'GET', path: '/service-orders/:id/payment-schedule', tag: TAG,
  summary: 'The order’s billing plan: agreed deposit, milestone amounts (by milestone label) and the remaining final amount, each with whether it is invoiced and paid.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const o = await loadOrder(c, i.id);
      let ok = false;
      try { await supplierAccess(user, o.profile_id, SUPPLIER_FIN, c); ok = true; } catch { /* maybe buyer */ }
      if (!ok) await buyerAccess(user, o.buyer_id, ['finance', 'purchaser'], c);
      const lines = await activeLines(c, o.id);
      const ms = new Map();
      for (const l of lines) if (l.milestone) ms.set(l.milestone, (ms.get(l.milestone) ?? 0) + Number(l.qty_ordered) * Number(l.rate_minor) / 1);
      const inv = (await c.query("SELECT kind, milestone, status, gross_minor, paid_minor, doc_type FROM svc_invoices WHERE order_id=$1 AND status='issued' AND doc_type='invoice'", [o.id])).rows;
      const dep = Number(o.terms?.deposit_bp ?? 0);
      const items = [];
      if (dep) items.push({ kind: 'deposit', label: `Deposit ${(dep / 100).toFixed(2)}%`, amount_minor: Math.round((Number(o.net_minor) * dep) / 10000), invoiced: inv.some((x) => x.kind === 'deposit'), paid: inv.filter((x) => x.kind === 'deposit').every((x) => Number(x.paid_minor) >= Number(x.gross_minor)) && inv.some((x) => x.kind === 'deposit') });
      for (const [label, amt] of ms) items.push({ kind: 'milestone', label, amount_minor: Math.round(amt), invoiced: inv.some((x) => x.milestone === label), paid: inv.filter((x) => x.milestone === label).length > 0 && inv.filter((x) => x.milestone === label).every((x) => Number(x.paid_minor) >= Number(x.gross_minor)) });
      return { order: o.number, currency: o.currency, order_gross_minor: Number(o.gross_minor), billing: o.billing, settlement: o.settlement, items };
    });
  },
});
cap({
  name: 'get_supplier_statement', method: 'GET', path: '/supplier-profiles/:id/statement', tag: TAG,
  summary: 'Supplier statement of account per currency: issued invoices, credit notes and payments with a running balance. Currencies are never added together.',
  input: z.object({ id, buyer_id: id.optional(), from: day.optional(), to: day.optional() }),
  async handler({ user }, i) {
    await supplierAccess(user, i.id, SUPPLIER_FIN);
    const rows = await many(`SELECT s.id, s.doc_type, s.supplier_number, s.currency, s.gross_minor, s.paid_minor, s.issued_at, s.buyer_id FROM svc_invoices s WHERE s.profile_id=$1 AND s.status='issued' AND s.doc_type IN ('invoice','credit_note','debit_note') AND ($2::uuid IS NULL OR s.buyer_id=$2) AND ($3::date IS NULL OR s.issued_at >= $3) AND ($4::date IS NULL OR s.issued_at < $4::date + 1) ORDER BY s.currency, s.issued_at, s.id`, [i.id, i.buyer_id ?? null, i.from ?? null, i.to ?? null]);
    const by = {};
    for (const r of rows) {
      const b = (by[r.currency] ??= { currency: r.currency, entries: [], invoiced_minor: 0, credited_minor: 0, paid_minor: 0, balance_minor: 0 });
      const sign = r.doc_type === 'credit_note' ? -1 : 1; const g = Number(r.gross_minor);
      b.balance_minor += sign * g - (sign === 1 ? Number(r.paid_minor) : 0);
      if (sign === 1) { b.invoiced_minor += g; b.paid_minor += Number(r.paid_minor); } else b.credited_minor += g;
      b.entries.push({ id: r.id, doc_type: r.doc_type, number: r.supplier_number, issued_at: r.issued_at, gross_minor: g, paid_minor: sign === 1 ? Number(r.paid_minor) : 0, running_balance_minor: b.balance_minor });
    }
    return { profile_id: i.id, currencies: Object.values(by) };
  },
});

// ---------------------------------------------------------------- matching exceptions
cap({
  name: 'request_invoice_exception_approval', method: 'POST', path: '/service-invoices/:id/exception', tag: TAG, status: 201,
  summary: 'Buyer finance: ask an authorised approver (not you) to approve paying an invoice that does not match order + acceptance — a prepayment/deposit, price/tax discrepancy or incomplete service. The reason is audited. Until approved the invoice cannot be paid by the buyer.',
  input: z.object({ id, reason: z.string().min(3).max(1000) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const inv = await q1(c, 'SELECT * FROM svc_invoices WHERE id=$1 FOR UPDATE', [i.id]);
      if (!inv || inv.status !== 'issued' || inv.doc_type !== 'invoice') throw notFound('Invoice');
      await buyerAccess(user, inv.buyer_id, ['finance'], c);
      if (inv.match_status !== 'exception') throw conflict(`This invoice is ${inv.match_status}; no exception is needed`);
      const ap = await q1(c, "INSERT INTO svc_approvals(buyer_id, subject_type, subject_id, amount_minor, currency, requested_by, exception_reason, payload) VALUES ($1,'invoice_exception',$2,$3,$4,$5,$6,$7) RETURNING *", [inv.buyer_id, inv.id, inv.payable_minor, inv.currency, user.id, i.reason, { match: inv.match_detail }]);
      await c.query('UPDATE svc_invoices SET approval_id=$2 WHERE id=$1', [inv.id, ap.id]);
      await tell(c, await buyerAudience(c, inv.buyer_id, ['approver']), { kind: 'svc_approval_requested', title: 'An invoice exception needs your approval', body: 'Open Gotmygame to review and decide.', data: { approval_id: ap.id }, dedupe_key: `svc:ap:${ap.id}` }, user.id);
      return ap;
    });
  },
});
handlers.set('invoice_exception', async (c, ap) => {
  await c.query("UPDATE svc_invoices SET match_status='exception_approved', match_detail = match_detail || $2::jsonb WHERE id=$1 AND match_status='exception'", [ap.subject_id, { approved_by: ap.decided_by, approved_at: new Date().toISOString(), reason: ap.exception_reason }]);
  return { match_status: 'exception_approved' };
});

// ---------------------------------------------------------------- payments
const SRC = z.enum(['manual_bank', 'manual_cash', 'manual_other']);
cap({
  name: 'record_service_payment', method: 'POST', path: '/service-invoices/:id/payments', tag: TAG, status: 201,
  summary: 'Record a manual bank / cash payment with evidence (a reference). Buyer finance records that it paid (blocked while a matching exception is unapproved); supplier finance records money received. Cumulative payments never exceed what is payable; a reference identifies exactly one transfer; the same key is idempotent. This is a ledger record — it does not move money, and it mirrors once onto the event budget.',
  input: z.object({ id, source: SRC, amount_minor: money.refine((n) => n > 0, 'amount must be above 0'), paid_on: day, reference: z.string().min(2).max(120), evidence: z.string().min(2).max(500), idempotency_key: z.string().min(1).max(64).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const inv = await q1(c, 'SELECT * FROM svc_invoices WHERE id=$1', [i.id]);
      if (!inv || inv.status !== 'issued') throw notFound('Invoice');
      let sup = null, buy = null;
      try { sup = await supplierAccess(user, inv.profile_id, SUPPLIER_FIN, c); } catch (e) { if (e.status === 403) throw e; }
      try { buy = await buyerAccess(user, inv.buyer_id, ['finance'], c); } catch (e) { if (e.status === 403) throw e; }
      if (!sup && !buy) throw notFound('Invoice');
      if (sup && buy) throw forbidden('You act for both sides of this invoice; another person must record the payment');
      if (buy && !['matched', 'exception_approved'].includes(inv.match_status)) throw conflict('This invoice does not match its order and acceptance yet; an authorised approver must approve the exception first');
      if (i.paid_on > new Date().toISOString().slice(0, 10)) throw badRequest('paid_on is in the future');
      const out = await addPayment(c, inv.id, i, user);
      await log(c, 'invoice', inv.id, user.id, 'payment_recorded', { amount_minor: i.amount_minor, side: sup ? 'supplier' : 'buyer' });
      return out;
    });
  },
});
cap({
  name: 'void_service_payment', method: 'POST', path: '/service-payments/:id/void', tag: TAG,
  summary: 'Correct a manual payment recorded in error: it is voided with a reason (kept on record), the invoice and the event budget entry follow. Provider payments are refunded through the payments module, never voided here. Only the side that recorded it, with finance authority.',
  input: z.object({ id, reason: z.string().min(3).max(500) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const pay = await q1(c, 'SELECT * FROM svc_payments WHERE id=$1 FOR UPDATE', [i.id]);
      if (!pay) throw notFound('Payment');
      const inv = await q1(c, 'SELECT * FROM svc_invoices WHERE id=$1 FOR UPDATE', [pay.svc_invoice_id]);
      let ok = false;
      for (const f of [() => supplierAccess(user, inv.profile_id, SUPPLIER_FIN, c), () => buyerAccess(user, inv.buyer_id, ['finance'], c)]) { try { await f(); ok = true; break; } catch (e) { if (e.status === 403) throw e; } }
      if (!ok) throw notFound('Payment');
      if (pay.source === 'provider') throw conflict('An online payment is refunded through the payments module, not voided');
      if (pay.status === 'voided') throw conflict('Already void');
      const owners = await q1(c, 'SELECT (SELECT owner_id FROM svc_profiles WHERE id=$1) AS s, (SELECT owner_id FROM svc_buyers WHERE id=$2) AS b', [inv.profile_id, inv.buyer_id]);
      if (pay.recorded_by !== user.id && ![owners.s, owners.b].includes(user.id)) throw forbidden('Only the person who recorded it, or an owner, can void it');
      const row = await q1(c, "UPDATE svc_payments SET status='voided', voided_by=$2, void_reason=$3, voided_at=now() WHERE id=$1 RETURNING *", [pay.id, user.id, i.reason]);
      await unmirrorPayment(c, pay.id, user, i.reason);
      await recomputeInvoice(c, inv.id);
      await log(c, 'invoice', inv.id, user.id, 'payment_voided', { reason: i.reason, payment: pay.id });
      return row;
    });
  },
});
cap({
  name: 'pay_service_invoice_online', method: 'POST', path: '/service-invoices/:id/pay', tag: TAG,
  summary: 'Buyer finance: pay an issued, matched invoice through a configured provider (hosted checkout). The amount is read from the invoice; the payment settles only through the signed provider callback, is idempotent, and is refunded automatically if the invoice can no longer take it. Paying the supplier out afterwards is a manual, audited record (record_supplier_payout) — Gotmygame never marks funds as transferred on its own.',
  input: z.object({ id, provider: z.enum(['stripe', 'paypal']), return_url: z.string().url().optional() }),
  async handler({ user }, i) {
    const inv = await tx(async (c) => {
      const row = await q1(c, 'SELECT * FROM svc_invoices WHERE id=$1 FOR UPDATE', [i.id]);
      if (!row || row.status !== 'issued' || row.doc_type !== 'invoice') throw notFound('Invoice');
      await buyerAccess(user, row.buyer_id, ['finance'], c);
      if (!['matched', 'exception_approved'].includes(row.match_status)) throw conflict('This invoice does not match its order and acceptance yet');
      if (serviceExponent(row.currency) === 3) throw conflict('Card providers do not take three-decimal currencies; record a bank or cash payment instead');
      return q1(c, 'UPDATE svc_invoices SET payer_id=$2 WHERE id=$1 RETURNING *', [row.id, user.id]);
    });
    return startCheckout(user, { purpose_type: 'service_invoice', purpose_id: inv.id, provider: i.provider, return_url: i.return_url });
  },
});
cap({
  name: 'record_supplier_payout', method: 'POST', path: '/service-payments/:id/payout', tag: TAG,
  summary: 'Platform admin or the supplier’s finance team: record that an online payment was paid out to the supplier by a manual transfer (with evidence). Until recorded the state stays manual_pending — payout rails are not integrated and are never implied.',
  input: z.object({ id, evidence: z.string().min(3).max(500) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const pay = await q1(c, 'SELECT * FROM svc_payments WHERE id=$1 FOR UPDATE', [i.id]);
      if (!pay || pay.source !== 'provider' || pay.status === 'voided') throw notFound('Payment');
      const inv = await q1(c, 'SELECT profile_id FROM svc_invoices WHERE id=$1', [pay.svc_invoice_id]);
      if (!user.roles?.includes('admin')) await supplierAccess(user, inv.profile_id, SUPPLIER_FIN, c);
      if (pay.payout_state === 'manual_recorded') throw conflict('The payout is already recorded');
      await log(c, 'payment', pay.id, user.id, 'payout_recorded', { evidence: i.evidence });
      return q1(c, "UPDATE svc_payments SET payout_state='manual_recorded' WHERE id=$1 RETURNING *", [pay.id]);
    });
  },
});
