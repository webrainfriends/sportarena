// Recurring UPI mandates (#694). A mandate is a payer's standing authorisation (Razorpay subscription / UPI AutoPay) for a recurring coaching
// subscription or a membership. It never bypasses the canonical flow: each charge the provider makes becomes a normal `payments` row for the
// period that was waiting for payment, and is fulfilled through settle() exactly like a one-off payment (same ledger, same refunds, same audit).
import { one, many, tx } from '../db.js';
import { recordCharge } from '../finance.js';
import { raiseException } from '../settlement.js';
import { notify } from '../notify.js';
import { settle } from './service.js';

/** The recurring period that is waiting for payment under this mandate, with the purpose type it is paid under. */
export async function awaitingPeriod(c, m) {
  if (m.subject_kind === 'coach_subscription') {
    const r = (await c.query("SELECT id, price_cents, currency FROM user_plans WHERE subscription_id=$1 AND status='awaiting_payment' ORDER BY period_no LIMIT 1", [m.subject_id])).rows[0];
    return r && { purposeType: 'coach_subscription_period', purposeId: r.id, amount: Number(r.price_cents), currency: r.currency };
  }
  const base = (await c.query("SELECT user_id, venue_id, enrolment_id FROM user_plans WHERE id=$1 AND kind='membership'", [m.subject_id])).rows[0];
  if (!base) return null;
  const r = (await c.query(
    `SELECT id, price_cents, currency FROM user_plans WHERE kind='membership' AND status='awaiting_payment' AND user_id=$1
        AND (($2::uuid IS NOT NULL AND venue_id=$2) OR ($3::uuid IS NOT NULL AND enrolment_id=$3)) ORDER BY created_at LIMIT 1`, [base.user_id, base.venue_id, base.enrolment_id])).rows[0];
  return r && { purposeType: 'venue_plan', purposeId: r.id, amount: Number(r.price_cents), currency: r.currency };
}

/** A charge the provider made under a mandate: record it as a payment for the waiting period and settle it. Idempotent per provider payment id. */
export async function onMandateCharge(m, pay) {
  const made = await tx(async (c) => {
    const exists = (await c.query("SELECT id FROM payments WHERE provider='razorpay' AND provider_ref=$1", [pay.id])).rows[0];
    if (exists) return { paymentId: exists.id, fresh: false };
    const period = await awaitingPeriod(c, m);
    if (!period) {
      await raiseException(c, { kind: 'mandate_charge_unmatched', dedupeKey: `mandate_charge:${pay.id}`, currency: String(pay.currency).toUpperCase(), amount: Number(pay.amount), detail: { mandate_id: m.id, provider_payment: pay.id, reason: 'no period was waiting for payment' } });
      return null;
    }
    const row = (await c.query(
      `INSERT INTO payments(payer_id, provider, purpose_type, purpose_id, amount_cents, currency, method, provider_ref) VALUES ($1,'razorpay',$2,$3,$4,$5,'upi',$6) RETURNING id`,
      [m.payer_id, period.purposeType, period.purposeId, period.amount, period.currency, pay.id])).rows[0];
    await recordCharge(c, { id: row.id, payer_id: m.payer_id, purpose_type: period.purposeType, purpose_id: period.purposeId, amount_cents: period.amount, currency: period.currency, provider: 'razorpay' });
    await c.query('UPDATE payment_mandates SET last_charged_at=now(), updated_at=now() WHERE id=$1', [m.id]);
    return { paymentId: row.id, fresh: true };
  });
  if (!made) return { status: 'unmatched' };
  return settle(made.paymentId, { paid: true, amount: Number(pay.amount), currency: String(pay.currency).toUpperCase(), paymentRef: pay.id, method: 'upi' });
}

const STATUS = { 'subscription.authenticated': 'authorised', 'subscription.activated': 'active', 'subscription.halted': 'halted', 'subscription.cancelled': 'cancelled', 'subscription.completed': 'completed' };
/** Apply a verified subscription.* webhook event to the mandate it belongs to. */
export async function onMandateEvent(event) {
  const sub = event.payload?.subscription?.entity;
  const m = sub?.id ? await one("SELECT * FROM payment_mandates WHERE provider='razorpay' AND provider_ref=$1", [sub.id]) : null;
  if (!m) return { handled: false };
  if (event.event === 'subscription.charged') return { handled: true, result: await onMandateCharge(m, event.payload.payment.entity) };
  const next = STATUS[event.event];
  if (!next) return { handled: false };
  await tx(async (c) => {
    await c.query("UPDATE payment_mandates SET status=$2, updated_at=now(), authorised_at = CASE WHEN $2 IN ('authorised','active') AND authorised_at IS NULL THEN now() ELSE authorised_at END, cancelled_at = CASE WHEN $2='cancelled' THEN now() ELSE cancelled_at END WHERE id=$1", [m.id, next]);
    if (next === 'halted') await notify(c, m.payer_id, { kind: 'mandate_halted', title: 'Your UPI AutoPay stopped', body: 'A recurring payment could not be collected, so AutoPay was paused. Pay the waiting period yourself or set AutoPay up again.', data: { mandate_id: m.id }, dedupe_key: `mandate_halted:${m.id}` });
  });
  return { handled: true };
}

/**
 * Housekeeping: a mandate whose subject has ended (subscription cancelled or lapsed, membership no longer renewing) is cancelled at the provider
 * so the customer is never charged for something they no longer have. Idempotent; a provider error leaves the mandate for the next run.
 */
export async function sweepMandates() {
  const { provider } = await import('./providers.js');
  const rows = await many(
    `SELECT m.* FROM payment_mandates m WHERE m.status IN ('created','authorised','active') AND m.provider_ref IS NOT NULL AND (
        (m.subject_kind='coach_subscription' AND EXISTS (SELECT 1 FROM coach_subscriptions s WHERE s.id=m.subject_id AND s.status IN ('lapsed','cancelled')))
     OR (m.subject_kind='membership' AND NOT EXISTS (SELECT 1 FROM user_plans u WHERE u.user_id=m.payer_id AND u.kind='membership' AND u.auto_renew AND u.status IN ('active','awaiting_payment')
                                                      AND ((u.venue_id IS NOT NULL AND u.venue_id=(SELECT venue_id FROM user_plans WHERE id=m.subject_id)) OR (u.enrolment_id IS NOT NULL AND u.enrolment_id=(SELECT enrolment_id FROM user_plans WHERE id=m.subject_id))))))`);
  let cancelled = 0;
  for (const m of rows) {
    try { await provider(m.provider).cancelMandate(m.provider_ref); await one("UPDATE payment_mandates SET status='cancelled', cancelled_at=now(), updated_at=now() WHERE id=$1", [m.id]); cancelled++; } catch (e) { console.error('[mandates] cancel failed', m.id, e.message); }
  }
  return { cancelled };
}
