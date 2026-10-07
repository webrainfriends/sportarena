import { one, many, tx } from '../db.js';
import { config } from '../config.js';
import { AppError, badRequest, conflict, forbidden } from '../errors.js';
import { provider, paymentsEnabled, enabledProviders } from './providers.js';

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
  const p = await q('SELECT p.holder_id AS payer_id, p.amount_cents AS amount, p.status, pl.name FROM insurance_policies p JOIN insurance_plans pl ON pl.id=p.plan_id WHERE p.id=$1 FOR UPDATE OF p');
  return p && { payerId: p.payer_id, amount: Number(p.amount), name: p.name, payable: p.status === 'pending_payment' };
}

/** Flip the paid thing to its fulfilled state. Returns false if it can no longer be fulfilled (e.g. cancelled meanwhile). */
async function fulfil(c, type, id) {
  const sql = {
    shop_order: "UPDATE shop_orders SET status='placed' WHERE id=$1 AND status='awaiting_payment'",
    coach_hire: "UPDATE coach_hires SET payment_status='paid' WHERE id=$1 AND payment_status='unpaid' AND status<>'cancelled'",
    insurance_policy: "UPDATE insurance_policies SET status='active' WHERE id=$1 AND status='pending_payment'",
  }[type];
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
  await one("UPDATE payments SET status='refunded', refunded_at=now() WHERE id=$1", [payment.id]);
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
