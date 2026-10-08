import { one, many, tx } from '../db.js';
import { config } from '../config.js';
import { AppError, badRequest, conflict, forbidden } from '../errors.js';
import { provider, paymentsEnabled, enabledProviders } from './providers.js';
import { markInvoicePaid } from '../booking/invoices.js';
import { completeTopup, activateGiftCard } from '../wallet.js';
import { activateUserPlan } from '../booking/plans.js';

export { paymentsEnabled, enabledProviders };

/** What a payment is for, who may pay it, how much, and whether it can still be paid. Amounts always come from the DB. */
export async function describePurpose(c, type, id) {
  const q = async (sql) => (await c.query(sql, [id])).rows[0];
  if (type === 'shop_order') {
    const o = await q('SELECT o.id, o.buyer_id AS payer_id, o.total_cents AS amount, o.status, p.name FROM shop_orders o JOIN shop_products p ON p.id=o.product_id WHERE o.id=$1 FOR UPDATE OF o');
    return o && { payerId: o.payer_id, amount: Number(o.amount), name: o.name, payable: o.status === 'awaiting_payment' };
  }
  if (type === 'coach_hire') {
    const h = await q("SELECT h.hirer_id AS payer_id, h.total_cents AS amount, h.status, h.payment_status, u.display_name FROM coach_hires h JOIN users u ON u.id=h.coach_id WHERE h.id=$1 FOR UPDATE OF h");
    return h && { payerId: h.payer_id, amount: Number(h.amount), name: `Coaching session with ${h.display_name}`, payable: h.payment_status === 'unpaid' && h.status !== 'cancelled' };
  }
  if (type === 'appointment') {
    const a = await q("SELECT a.athlete_id AS payer_id, a.fee_cents AS amount, a.currency, a.status, a.payment_status, u.display_name FROM appointments a JOIN users u ON u.id=a.provider_id WHERE a.id=$1 FOR UPDATE OF a");
    return a && { payerId: a.payer_id, amount: Number(a.amount), currency: a.currency, name: `Appointment with ${a.display_name}`, payable: a.payment_status === 'unpaid' && ['requested', 'confirmed'].includes(a.status) };
  }
  if (type === 'venue_invoice') {
    const i = await q("SELECT i.user_id AS payer_id, i.total_cents - i.credits_cents AS amount, i.currency, i.status, i.number, v.name, v.payment_mode FROM invoices i JOIN venues v ON v.id=i.venue_id WHERE i.id=$1 AND i.kind='invoice' FOR UPDATE OF i");
    return i && { payerId: i.payer_id, amount: Number(i.amount), currency: i.currency, name: `Booking ${i.number} · ${i.name}`, payable: i.status === 'open' && i.payment_mode !== 'pay_at_venue' && Number(i.amount) > 0 };
  }
  if (type === 'wallet_topup') {
    const t = await q("SELECT user_id AS payer_id, amount_cents AS amount, currency, status FROM wallet_topups WHERE id=$1 FOR UPDATE");
    return t && { payerId: t.payer_id, amount: Number(t.amount), currency: t.currency, name: 'Wallet top-up', payable: t.status === 'awaiting_payment' };
  }
  if (type === 'gift_card') {
    const g = await q("SELECT purchaser_id AS payer_id, amount_cents AS amount, currency, status FROM gift_cards WHERE id=$1 FOR UPDATE");
    return g && { payerId: g.payer_id, amount: Number(g.amount), currency: g.currency, name: 'SportArena gift card', payable: g.status === 'awaiting_payment' };
  }
  if (type === 'venue_plan') {
    const u = await q("SELECT up.user_id AS payer_id, up.price_cents AS amount, up.currency, up.status, up.name, v.name AS venue FROM user_plans up JOIN venues v ON v.id=up.venue_id WHERE up.id=$1 FOR UPDATE OF up");
    return u && { payerId: u.payer_id, amount: Number(u.amount), currency: u.currency, name: `${u.name} · ${u.venue}`, payable: u.status === 'awaiting_payment' };
  }
  const p = await q('SELECT p.holder_id AS payer_id, p.amount_cents AS amount, p.status, pl.name FROM insurance_policies p JOIN insurance_plans pl ON pl.id=p.plan_id WHERE p.id=$1 FOR UPDATE OF p');
  return p && { payerId: p.payer_id, amount: Number(p.amount), name: p.name, payable: p.status === 'pending_payment' };
}

/** Flip the paid thing to its fulfilled state. Returns false if it can no longer be fulfilled (e.g. cancelled meanwhile). */
async function fulfil(c, type, id) {
  const sql = {
    shop_order: "UPDATE shop_orders SET status='placed' WHERE id=$1 AND status='awaiting_payment'",
    coach_hire: "UPDATE coach_hires SET payment_status='paid' WHERE id=$1 AND payment_status='unpaid' AND status<>'cancelled'",
    insurance_policy: "UPDATE insurance_policies SET status='active' WHERE id=$1 AND status='pending_payment'",
    appointment: "UPDATE appointments SET payment_status='paid', updated_at=now() WHERE id=$1 AND payment_status='unpaid' AND status IN ('requested','confirmed')",
  }[type];
  if (type === 'venue_invoice') return markInvoicePaid(c, id, { method: 'online' });
  if (type === 'wallet_topup') return completeTopup(c, id);
  if (type === 'gift_card') return activateGiftCard(c, id);
  if (type === 'venue_plan') return activateUserPlan(c, id);
  return (await c.query(sql, [id])).rowCount > 0;
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
      return { payment: { ...p, status: 'failed' }, refund: false, mismatch: true };
    }
    const ok = await fulfil(c, p.purpose_type, p.purpose_id);
    await c.query("UPDATE payments SET status='paid', paid_at=now(), provider_payment_ref=$2 WHERE id=$1", [p.id, result.paymentRef ?? null]);
    return { payment: { ...p, status: 'paid', provider_payment_ref: result.paymentRef ?? null }, refund: !ok };
  });
  if (out.mismatch) throw new AppError(409, 'payment_mismatch', 'The amount paid does not match the order — contact support');
  // paid for something that was cancelled in the meantime: give the money back straight away
  if (out.refund) await refund(out.payment).catch((e) => console.error('[payments] auto-refund failed', out.payment.id, e.message));
  return { status: out.refund ? 'refunded' : out.payment.status };
}

/** Refund a paid payment at the provider and mark it refunded. Throws if the provider refuses. */
export async function refund(payment) {
  if (payment.status !== 'paid') return;
  if (!payment.provider_payment_ref) throw new AppError(409, 'refund_unavailable', 'No provider reference to refund');
  await provider(payment.provider).refund(payment.provider_payment_ref, payment.id);
  await one("UPDATE payments SET status='refunded', refunded_at=now(), refunded_cents=amount_cents WHERE id=$1", [payment.id]);
}

/** Give back part of a paid payment (a credit note). `key` makes the provider call idempotent so a retry can't refund twice. Returns the amount refunded. */
export async function refundPartial(payment, amount, key) {
  const left = Number(payment.amount_cents) - Number(payment.refunded_cents ?? 0);
  const give = Math.min(amount, left);
  if (give <= 0) return 0;
  if (!payment.provider_payment_ref) throw new AppError(409, 'refund_unavailable', 'No provider reference to refund');
  await provider(payment.provider).refund(payment.provider_payment_ref, payment.id, { amount: give, currency: payment.currency, key });
  await one("UPDATE payments SET refunded_cents = refunded_cents + $2, status = CASE WHEN refunded_cents + $2 >= amount_cents THEN 'refunded' ELSE status END, refunded_at = CASE WHEN refunded_cents + $2 >= amount_cents THEN now() ELSE refunded_at END WHERE id=$1", [payment.id, give]);
  return give;
}

/** Refund whatever was paid for this purpose (called when the buyer cancels). */
export async function refundFor(type, id) {
  const paid = await many("SELECT * FROM payments WHERE purpose_type=$1 AND purpose_id=$2 AND status='paid'", [type, id]);
  for (const p of paid) await refund(p);
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
