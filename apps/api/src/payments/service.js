import { one, many, tx, pool } from '../db.js';
import { config } from '../config.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { provider, paymentsEnabled, enabledProviders } from './providers.js';
import { markInvoicePaid } from '../booking/invoices.js';
import { completeTopup, activateGiftCard } from '../wallet.js';
import { activateUserPlan } from '../booking/plans.js';
import { activatePhysioPackage } from '../capabilities/provider-packages.js';
import { fulfilSponsorshipPayment } from '../sponsor-agreements.js';
import { fulfilChargePaid } from '../academy-invoices.js';
import { fulfilServiceInvoicePaid } from '../svc/finance.js';
import { fulfilMediaFeePaid } from '../media-fees.js';
import { raiseException, recordSale, syncRefunds } from '../settlement.js';
import { coachSessionDone } from '../rewards/activity.js';
import { saleDue, confirmOnlineSalePayment } from '../pos/due.js';

export { paymentsEnabled, enabledProviders };

/** What a payment is for, who may pay it, how much, and whether it can still be paid. Amounts always come from the DB. */
export async function describePurpose(c, type, id) {
  const q = async (sql) => (await c.query(sql, [id])).rows[0];
  if (type === 'shop_order') {
    const o = await q('SELECT o.id, o.buyer_id AS payer_id, o.total_cents AS amount, o.status, p.name FROM shop_orders o JOIN shop_products p ON p.id=o.product_id WHERE o.id=$1 FOR UPDATE OF o');
    return o && { payerId: o.payer_id, amount: Number(o.amount), name: o.name, payable: o.status === 'awaiting_payment' };
  }
  if (type === 'shop_checkout') {
    // everything bought together in one cart: pay what is still awaiting payment (lines cancelled meanwhile drop out)
    const o = (await c.query("SELECT min(buyer_id::text)::uuid AS payer_id, coalesce(sum(total_cents) FILTER (WHERE status='awaiting_payment'), 0) AS amount, count(*) FILTER (WHERE status='awaiting_payment')::int AS due FROM shop_orders WHERE checkout_id=$1", [id])).rows[0];
    return o?.payer_id && { payerId: o.payer_id, amount: Number(o.amount), name: `Gotmygame Shop order (${o.due} item${o.due === 1 ? '' : 's'})`, payable: o.due > 0 };
  }
  if (type === 'coach_hire') {
    const h = await q("SELECT h.hirer_id AS payer_id, h.total_cents - h.loyalty_credit_cents AS amount, h.status, h.payment_status, u.display_name FROM coach_hires h JOIN users u ON u.id=h.coach_id WHERE h.id=$1 FOR UPDATE OF h");
    return h && { payerId: h.payer_id, amount: Number(h.amount), name: `Coaching session with ${h.display_name}`, payable: h.payment_status === 'unpaid' && h.status !== 'cancelled' && Number(h.amount) > 0 };
  }
  if (type === 'appointment') {
    const a = await q("SELECT a.athlete_id AS payer_id, a.fee_cents AS amount, a.currency, a.status, a.payment_status, u.display_name FROM appointments a JOIN users u ON u.id=a.provider_id WHERE a.id=$1 FOR UPDATE OF a");
    return a && { payerId: a.payer_id, amount: Number(a.amount), currency: a.currency, name: `Appointment with ${a.display_name}`, payable: a.payment_status === 'unpaid' && ['requested', 'confirmed'].includes(a.status) };
  }
  if (type === 'physio_package') {
    const k = await q("SELECT k.patient_id AS payer_id, k.price_cents AS amount, k.currency, k.status, k.title, u.display_name FROM patient_packages k JOIN users u ON u.id=k.provider_id WHERE k.id=$1 FOR UPDATE OF k");
    return k && { payerId: k.payer_id, amount: Number(k.amount), currency: k.currency, name: `Session package with ${k.display_name}`, payable: k.status === 'awaiting_payment' && Number(k.amount) > 0 };
  }
  if (type === 'venue_invoice') {
    const i = await q("SELECT i.user_id AS payer_id, i.total_cents - i.credits_cents AS amount, i.currency, i.status, i.number, v.name, v.payment_mode, i.pos_sale_id FROM invoices i JOIN venues v ON v.id=i.venue_id WHERE i.id=$1 AND i.kind='invoice' FOR UPDATE OF i");
    // a front-desk invoice is only ever paid through its sale (so the drawer, the sale and the invoice cannot disagree)
    const inDesk = i && !i.pos_sale_id && (await c.query("SELECT 1 FROM pos_sale_invoices psi JOIN pos_sales s ON s.id=psi.sale_id WHERE psi.invoice_id=$1 AND s.status='awaiting_payment'", [id])).rowCount > 0;
    return i && { payerId: i.payer_id, amount: Number(i.amount), currency: i.currency, name: `Booking ${i.number} · ${i.name}`, payable: !i.pos_sale_id && !inDesk && i.status === 'open' && i.payment_mode !== 'pay_at_venue' && Number(i.amount) > 0 };
  }
  if (type === 'pos_sale') {
    const sale = await q("SELECT s.id, s.cashier_id AS payer_id, s.currency, s.status, v.name FROM pos_sales s JOIN venues v ON v.id=s.venue_id WHERE s.id=$1 FOR UPDATE OF s");
    if (!sale) return null;
    const due = await saleDue(c, sale.id);
    return { payerId: sale.payer_id, amount: due.total, currency: sale.currency, name: `Front desk sale · ${sale.name}`, payable: sale.status === 'awaiting_payment' && due.total > 0 };
  }
  if (type === 'wallet_topup') {
    const t = await q("SELECT user_id AS payer_id, amount_cents AS amount, currency, status FROM wallet_topups WHERE id=$1 FOR UPDATE");
    return t && { payerId: t.payer_id, amount: Number(t.amount), currency: t.currency, name: 'Wallet top-up', payable: t.status === 'awaiting_payment' };
  }
  if (type === 'gift_card') {
    const g = await q("SELECT purchaser_id AS payer_id, amount_cents AS amount, currency, status FROM gift_cards WHERE id=$1 FOR UPDATE");
    return g && { payerId: g.payer_id, amount: Number(g.amount), currency: g.currency, name: 'Gotmygame gift card', payable: g.status === 'awaiting_payment' };
  }
  if (type === 'venue_plan') {
    const u = await q("SELECT up.user_id AS payer_id, up.price_cents AS amount, up.currency, up.status, up.name, v.name AS venue FROM user_plans up JOIN venues v ON v.id=up.venue_id WHERE up.id=$1 FOR UPDATE OF up");
    return u && { payerId: u.payer_id, amount: Number(u.amount), currency: u.currency, name: `${u.name} · ${u.venue}`, payable: u.status === 'awaiting_payment' };
  }
  if (type === 'sponsorship_payment') {
    const x = await q("SELECT x.reported_by AS payer_id, x.amount_cents AS amount, x.currency, x.status AS pay_status, o.status AS due_status, s.status AS deal_status, sp.name FROM sponsorship_payments x JOIN sponsorship_obligations o ON o.id=x.obligation_id JOIN sponsorships s ON s.id=o.sponsorship_id JOIN sponsors sp ON sp.id=s.sponsor_id WHERE x.id=$1 FOR UPDATE OF x");
    return x && { payerId: x.payer_id, amount: Number(x.amount), currency: x.currency, name: `Sponsorship payment · ${x.name}`, payable: x.pay_status === 'awaiting_payment' && x.due_status === 'scheduled' && ['active', 'ended', 'term_expired'].includes(x.deal_status) };
  }
  if (type === 'academy_charge') {
    const x = await q("SELECT ch.payer_id, ch.amount_minor - coalesce((SELECT sum(i.credits_cents) FROM invoices i WHERE i.academy_charge_id=ch.id AND i.kind='invoice' AND i.status='open'),0) AS amount, ch.currency, ch.status, ch.kind, o.name, o.status AS org_status FROM academy_charges ch JOIN organisations o ON o.id=ch.organisation_id WHERE ch.id=$1 FOR UPDATE OF ch");
    // a fee that is part of a front-desk sale waiting for payment is settled there, not online
    const inDesk = x && (await c.query("SELECT 1 FROM pos_sale_lines l JOIN pos_sales s ON s.id=l.sale_id WHERE l.charge_id=$1 AND s.status='awaiting_payment'", [id])).rowCount > 0;
    return x && { payerId: x.payer_id, amount: Number(x.amount), currency: x.currency, name: `Academy ${x.kind} · ${x.name}`, payable: !inDesk && x.status === 'awaiting_payment' && Number(x.amount) > 0 };
  }
  if (type === 'media_rights_fee') {
    const x = await q("SELECT f.payer_id, f.amount_minor AS amount, f.currency, f.status, f.number, o.name FROM mr_fees f JOIN mr_licences l ON l.id=f.licence_id JOIN media_partners m ON m.id=l.partner_id JOIN organisations o ON o.id=m.organisation_id WHERE f.id=$1 FOR UPDATE OF f");
    return x && { payerId: x.payer_id, amount: Number(x.amount), currency: x.currency, name: `Rights fee ${x.number} · ${x.name}`, payable: x.status === 'awaiting_payment' };
  }
  if (type === 'service_invoice') {
    const x = await q("SELECT s.payer_id, s.payable_minor - s.credited_minor - s.paid_minor AS amount, s.currency, s.status, s.doc_type, s.match_status, s.supplier_number, coalesce(p.trading_name, p.legal_name) AS name FROM svc_invoices s JOIN svc_profiles p ON p.id=s.profile_id WHERE s.id=$1 FOR UPDATE OF s");
    return x && { payerId: x.payer_id, amount: Number(x.amount), currency: x.currency, name: `Invoice ${x.supplier_number} · ${x.name}`, payable: x.status === 'issued' && x.doc_type === 'invoice' && ['matched', 'exception_approved'].includes(x.match_status) && Number(x.amount) > 0 };
  }
  const p = await q('SELECT p.holder_id AS payer_id, p.amount_cents AS amount, p.status, pl.name FROM insurance_policies p JOIN insurance_plans pl ON pl.id=p.plan_id WHERE p.id=$1 FOR UPDATE OF p');
  return p && { payerId: p.payer_id, amount: Number(p.amount), name: p.name, payable: p.status === 'pending_payment' };
}

/** Flip the paid thing to its fulfilled state. Returns false if it can no longer be fulfilled (e.g. cancelled meanwhile). */
async function fulfil(c, type, id, payment) {
  const sql = {
    shop_order: "UPDATE shop_orders SET status='placed' WHERE id=$1 AND status='awaiting_payment'",
    shop_checkout: "UPDATE shop_orders SET status='placed' WHERE checkout_id=$1 AND status='awaiting_payment'",
    coach_hire: "UPDATE coach_hires SET payment_status='paid', status=CASE WHEN request_response_id IS NOT NULL AND status='requested' THEN 'confirmed' ELSE status END WHERE id=$1 AND payment_status='unpaid' AND status IN ('requested','confirmed')",
    insurance_policy: "UPDATE insurance_policies SET status='active' WHERE id=$1 AND status='pending_payment'",
    appointment: "UPDATE appointments SET payment_status='paid', updated_at=now() WHERE id=$1 AND payment_status='unpaid' AND status IN ('requested','confirmed')",
  }[type];
  if (type === 'venue_invoice') return markInvoicePaid(c, id, { method: 'online' });
  if (type === 'pos_sale') return confirmOnlineSalePayment(c, id, payment);
  if (type === 'wallet_topup') return completeTopup(c, id);
  if (type === 'gift_card') return activateGiftCard(c, id);
  if (type === 'venue_plan') return activateUserPlan(c, id);
  if (type === 'physio_package') return activatePhysioPackage(c, id);
  if (type === 'sponsorship_payment') return fulfilSponsorshipPayment(c, id);
  if (type === 'academy_charge') return fulfilChargePaid(c, id, { method: 'online' });
  if (type === 'service_invoice') return fulfilServiceInvoicePaid(c, id, payment);
  if (type === 'media_rights_fee') return fulfilMediaFeePaid(c, id);
  const done = (await c.query(sql, [id])).rowCount > 0;
  if (done && type === 'coach_hire') await coachSessionDone(c, id);   // a session completed before it was paid earns once the payment lands
  return done;
}

/**
 * Record that the provider says this payment is paid. Idempotent and safe to call from webhook, return page and manual check.
 * `result` = { paid, amount, currency, paymentRef } as reported by the provider (never by the client).
 */
export async function settle(paymentId, result) {
  if (!result?.paid) return { status: 'pending' };
  const out = await tx(async (c) => {
    const p = (await c.query('SELECT * FROM payments WHERE id=$1 FOR UPDATE', [paymentId])).rows[0];
    if (!p) throw new AppError(404, 'not_found', 'Payment not found');
    if (p.status !== 'pending') return { payment: p, refund: false };
    if (Number(result.amount) !== Number(p.amount_cents) || String(result.currency).toUpperCase() !== p.currency) {
      await c.query("UPDATE payments SET status='failed' WHERE id=$1", [p.id]);
      await raiseException(c, { kind: 'amount_mismatch', dedupeKey: `amount_mismatch:${p.id}`, paymentId: p.id, currency: p.currency, amount: Number(p.amount_cents), detail: { expected_cents: Number(p.amount_cents), expected_currency: p.currency, provider_cents: Number(result.amount), provider_currency: String(result.currency).toUpperCase(), provider_ref: p.provider_ref } });
      return { payment: { ...p, status: 'failed' }, refund: false, mismatch: true };
    }
    const ok = await fulfil(c, p.purpose_type, p.purpose_id, p);
    const paid = (await c.query("UPDATE payments SET status='paid', paid_at=now(), provider_payment_ref=$2 WHERE id=$1 RETURNING *", [p.id, result.paymentRef ?? null])).rows[0];
    await recordSale(c, paid);   // what the seller is owed, in the same transaction as 'the customer paid'
    return { payment: paid, refund: !ok };
  });
  if (out.mismatch) throw new AppError(409, 'payment_mismatch', 'The amount paid does not match the order — contact support');
  // paid for something that was cancelled in the meantime: give the money back straight away
  if (out.refund) await refund(out.payment).catch((e) => console.error('[payments] auto-refund failed', out.payment.id, e.message));
  return { status: out.refund ? 'refunded' : out.payment.status };
}

/** Refund a paid payment at the provider and mark it refunded. Throws if the provider refuses. */
export async function refund(payment, { key } = {}) {
  if (payment.status !== 'paid') return;
  if (!payment.provider_payment_ref) throw new AppError(409, 'refund_unavailable', 'No provider reference to refund');
  await provider(payment.provider).refund(payment.provider_payment_ref, payment.id, key ? { key } : undefined);
  // the payment row and the sellers' ledger move together; the provider call above is idempotent, so a failure here is safe to retry
  await tx(async (c) => {
    await c.query("UPDATE payments SET status='refunded', refunded_at=now(), refunded_cents=amount_cents WHERE id=$1 AND status='paid'", [payment.id]);
    await syncRefunds(c, payment.id);
  });
}

/** Give back part of a paid payment (a credit note). `key` makes the provider call idempotent so a retry can't refund twice. Returns the amount refunded. */
export async function refundPartial(payment, amount, key, { sellerId } = {}) {
  const left = Number(payment.amount_cents) - Number(payment.refunded_cents ?? 0);
  const give = Math.min(amount, left);
  if (give <= 0) return 0;
  if (!payment.provider_payment_ref) throw new AppError(409, 'refund_unavailable', 'No provider reference to refund');
  await provider(payment.provider).refund(payment.provider_payment_ref, payment.id, { amount: give, currency: payment.currency, key });
  await tx(async (c) => {
    await c.query("UPDATE payments SET refunded_cents = refunded_cents + $2, status = CASE WHEN refunded_cents + $2 >= amount_cents THEN 'refunded' ELSE status END, refunded_at = CASE WHEN refunded_cents + $2 >= amount_cents THEN now() ELSE refunded_at END WHERE id=$1", [payment.id, give]);
    await syncRefunds(c, payment.id, { sellerId });   // a refunded shop line comes out of that line's seller, anything else pro rata
  });
  return give;
}

/** Refund whatever was paid for this purpose (called when the buyer cancels). */
export async function refundFor(type, id, { key } = {}) {
  const paid = await many("SELECT * FROM payments WHERE purpose_type=$1 AND purpose_id=$2 AND status='paid' ORDER BY created_at, id", [type, id]);
  for (const p of paid) await refund(p, key ? { key: `${key}-${p.id}` } : undefined);
  return paid.length > 0;
}

/** Return URLs must stay on an origin we serve (no open redirect through the checkout). */
export function safeReturnBase(requested) {
  const allowed = new Set([config.appUrl, ...config.corsOrigins].filter((x) => x && x !== '*').map((x) => { try { return new URL(x).origin; } catch { return null; } }).filter(Boolean));
  if (requested) {
    let u; try { u = new URL(requested); } catch { throw badRequest('return_url is not a valid URL'); }
    if (allowed.has(u.origin) || (!config.isProd && config.corsOrigins.includes('*'))) return `${u.origin}${u.pathname}`.replace(/\/$/, '');
    throw forbidden('return_url is not an allowed origin');
  }
  const first = [...allowed][0];
  if (!first) throw badRequest('APP_URL is not configured on the server; pass return_url');
  return first;
}

/** Start a hosted checkout for something `user` owes. The amount and currency are read from the record, never from the client. */
export async function startCheckout(user, i) {
  if (!enabledProviders().includes(i.provider)) throw badRequest(`${i.provider} is not enabled on this server`);
  const client = await pool.connect();
  let paymentId, d, currency;
  try {
    await client.query('BEGIN');
    d = await describePurpose(client, i.purpose_type, i.purpose_id);
    if (!d) throw notFound('Item to pay for');
    if (d.payerId !== user.id) throw forbidden('This is not yours to pay');
    if (!d.payable) throw conflict('Nothing to pay: it is already paid, cancelled or free');
    if (d.amount <= 0) throw conflict('Nothing to pay');
    currency = d.currency ?? config.payments.currency;
    const row = (await client.query('INSERT INTO payments(payer_id, provider, purpose_type, purpose_id, amount_cents, currency) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [user.id, i.provider, i.purpose_type, i.purpose_id, d.amount, currency])).rows[0];
    paymentId = row.id;
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }

  const base = safeReturnBase(i.return_url);
  const mk = (r) => `${base}/?payment=${paymentId}&result=${r}`;
  try {
    const out = await provider(i.provider).createCheckout({ paymentId, amount: d.amount, currency, name: d.name, successUrl: mk('success'), cancelUrl: mk('cancel') });
    await one('UPDATE payments SET provider_ref=$2 WHERE id=$1', [paymentId, out.ref]);
    return { id: paymentId, provider: i.provider, amount_cents: d.amount, currency, checkout_url: out.url };
  } catch (e) {
    await one("UPDATE payments SET status='failed' WHERE id=$1", [paymentId]);
    throw e;
  }
}
