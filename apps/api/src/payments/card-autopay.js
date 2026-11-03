// Automatic card-on-file charging for coach subscriptions (#680). It is the Stripe adapter for the one mandate system (payment_mandates, #694) and
// plugs into the existing collections hook (registerMandateExecutor). It never bypasses the canonical flow: each charge is an ordinary `payments`
// row for the period that is waiting, recorded with recordCharge and fulfilled by settle() (so ledger, receipts and refunds work as usual).
// Raw card data never reaches us; we hold only Stripe's customer / payment-method ids (encrypted) and brand / last4 / expiry for display.
import { one, tx } from '../db.js';
import { encrypt, decrypt } from '../crypto.js';
import { audit } from '../helpers.js';
import { recordCharge } from '../finance.js';
import { notify } from '../notify.js';
import { guardianLink, guardianCan, hasConsent, isYouth, guardiansOf } from '../youth.js';
import { registerMandateExecutor } from '../collections.js';
import { stripe } from './providers.js';
import { settle } from './service.js';

const CTX_PM = 'payment_mandates.pm';
const CTX_CUSTOMER = 'payment_mandates.customer';
export const sealCustomer = (v) => encrypt(v, CTX_CUSTOMER);
export const sealMethod = (v) => encrypt(v, CTX_PM);

/**
 * May this payer let a card be charged for this athlete's subscription right now? A young person's guardian must be a live, verified guardian with
 * the pay scope, and current coaching consent must exist. Checked when the mandate is made and again before every charge (live revocation).
 * Returns null when allowed, else a short reason.
 */
export async function payerBlocked(c, { payerId, athleteId }) {
  if (!(await isYouth(athleteId, c))) return payerId === athleteId ? null : 'The subscriber is an adult, so only they can set up automatic payment';
  const link = await guardianLink(payerId, athleteId, c);
  if (!link) return 'Only a verified guardian can set up automatic payment for a young person';
  if (!(await guardianCan(link, 'pay', null, c))) return 'Your guardian link does not allow paying for this young person';
  if (!(await hasConsent(athleteId, 'coaching', c))) return 'Guardian consent for coaching is no longer current';
  return null;
}

/** Stop a mandate (it is kept, never deleted) and tell the people who need to act. Charging stops immediately because every charge reads the live status. */
async function stopMandate(c, m, { status = 'halted', reason, notifyUsers = [] }) {
  await c.query("UPDATE payment_mandates SET status=$2, revoked_reason=$3, cancelled_at=CASE WHEN $2='cancelled' THEN now() ELSE cancelled_at END, updated_at=now() WHERE id=$1 AND status IN ('created','authorised','active')", [m.id, status, reason]);
  await audit(c, null, `card_autopay_${status}`, 'payment_mandates', m.id);
  for (const u of new Set([m.payer_id, ...notifyUsers])) {
    await notify(c, u, { kind: 'autopay_stopped', title: 'Automatic card payment stopped', body: `${reason}. Pay the month yourself, or set automatic payment up again.`, data: { mandate_id: m.id, subscription_id: m.subject_id }, dedupe_key: `autopay_stopped:${m.id}:${status}` });
  }
}

/** The mandate completed its setup on the provider's page: keep the (encrypted) tokens and the display fields, and make it live. Idempotent. */
export async function activateCardMandate(m, setup) {
  if (!setup?.ok) return m;
  return tx(async (c) => {
    const cur = (await c.query('SELECT * FROM payment_mandates WHERE id=$1 FOR UPDATE', [m.id])).rows[0];
    if (!cur || !['created', 'authorised'].includes(cur.status)) return cur ?? m;
    const sub = (await c.query('SELECT athlete_id, payer_id FROM coach_subscriptions WHERE id=$1', [cur.subject_id])).rows[0];
    const why = sub ? await payerBlocked(c, { payerId: cur.payer_id, athleteId: sub.athlete_id }) : 'The subscription has ended';
    if (why) { await stopMandate(c, cur, { status: 'cancelled', reason: why }); if (setup.paymentMethod) await stripe.detachPaymentMethod(setup.paymentMethod).catch(() => {}); return (await c.query('SELECT * FROM payment_mandates WHERE id=$1', [m.id])).rows[0]; }
    const row = (await c.query(
      `UPDATE payment_mandates SET status='active', authorised_at=now(), customer_enc=$2, payment_method_enc=$3, card_brand=$4, card_last4=$5, card_exp=$6,
              consent_by = CASE WHEN $7::uuid <> $8::uuid THEN $7 END, consent_at = CASE WHEN $7::uuid <> $8::uuid THEN now() END, updated_at=now() WHERE id=$1 RETURNING *`,
      [cur.id, sealCustomer(setup.customer), sealMethod(setup.paymentMethod), setup.brand, setup.last4, setup.exp, cur.payer_id, sub.athlete_id])).rows[0];
    await audit(c, cur.payer_id, 'activate_card_autopay', 'payment_mandates', cur.id);
    return row;
  });
}

/** Revoke a card mandate: the database says cancelled first (so the very next sweep makes no charge), then the saved card is detached at Stripe. */
export async function cancelCardMandate(m, { by = null, reason = 'Cancelled' } = {}) {
  const row = await tx(async (c) => {
    const cur = (await c.query('SELECT * FROM payment_mandates WHERE id=$1 FOR UPDATE', [m.id])).rows[0];
    if (!cur || ['cancelled', 'completed'].includes(cur.status)) return cur;
    const r = (await c.query("UPDATE payment_mandates SET status='cancelled', cancelled_at=now(), cancelled_by=$2, revoked_reason=$3, updated_at=now() WHERE id=$1 RETURNING *", [cur.id, by, reason])).rows[0];
    await audit(c, by, 'cancel_card_autopay', 'payment_mandates', cur.id);
    return r;
  });
  if (row?.payment_method_enc) {
    try { await stripe.detachPaymentMethod(decrypt(row.payment_method_enc, CTX_PM)); } catch (e) { console.error('[card-autopay] detach failed', m.id, e.message); }
  }
  return row;
}

/**
 * The collections executor for a coach subscription month. Runs inside the case's transaction (`client`), so it only reads the locked period and
 * writes the payment; settling happens after that transaction commits (the returned `after`), because settle() takes the same row lock.
 * Exactly once per period: an advisory lock per (subscription, period), the unique (subscription, period, attempt) key, a partial unique index
 * on a succeeded charge, and Stripe's own idempotency key all say the same thing.
 */
export async function chargeCoachPeriod({ client: c, mandate, period, attempt }) {
  const sub = (await c.query('SELECT * FROM coach_subscriptions WHERE id=$1', [period.subscription_id])).rows[0];
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`cardcharge:${period.subscription_id}:${period.period_no}`]);
  const m = (await c.query('SELECT * FROM payment_mandates WHERE id=$1 FOR UPDATE', [mandate.id])).rows[0];
  if (!m || m.status !== 'active' || m.provider !== 'stripe' || !m.payment_method_enc || !m.customer_enc) return { ok: false, reason: 'Automatic payment is not active', skip: true };
  if (!sub || !['active', 'past_due'].includes(sub.status) || sub.payer_id !== m.payer_id) { await stopMandate(c, m, { status: 'cancelled', reason: 'The subscription has ended or the payer changed' }); return { ok: false, reason: 'The subscription has ended', skip: true }; }
  const price = Number(period.price_cents);
  if (period.currency !== m.currency || price > Number(m.amount_minor)) {
    await stopMandate(c, m, { reason: 'The price changed since you allowed automatic payment' });
    return { ok: false, reason: 'The price changed since the mandate was made', skip: true };
  }
  const why = await payerBlocked(c, { payerId: m.payer_id, athleteId: sub.athlete_id });
  if (why) { await stopMandate(c, m, { status: 'cancelled', reason: why, notifyUsers: await guardiansOf(sub.athlete_id, c) }); return { ok: false, reason: why, skip: true }; }

  const done = (await c.query("SELECT * FROM mandate_charges WHERE subscription_id=$1 AND period_no=$2 AND status IN ('processing','succeeded')", [sub.id, period.period_no])).rows[0];
  if (done) return { ok: true, ref: done.provider_ref, already: true };
  const row = (await c.query(
    `INSERT INTO mandate_charges(mandate_id, subscription_id, period_no, attempt, amount_minor, currency) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (subscription_id, period_no, attempt) DO UPDATE SET updated_at=now() RETURNING *`, [m.id, sub.id, period.period_no, attempt, price, period.currency])).rows[0];

  await audit(c, null, 'decrypt_payment_method', 'payment_mandates', m.id);
  const key = `coachsub:${sub.id}:${period.period_no}:${attempt}`;
  const res = await stripe.chargeOffSession({ customer: decrypt(m.customer_enc, CTX_CUSTOMER), paymentMethod: decrypt(m.payment_method_enc, CTX_PM), amount: price, currency: period.currency, key,
    metadata: { subscription_id: sub.id, period_no: period.period_no, mandate_id: m.id, period_id: period.id } });
  if (!res.ok && !res.processing) {
    await c.query("UPDATE mandate_charges SET status='failed', reason=$2, provider_ref=$3, updated_at=now() WHERE id=$1", [row.id, res.reason, res.ref]);
    await notify(c, m.payer_id, { kind: 'autopay_declined', title: 'Automatic payment did not go through', body: `${sub.title}: ${res.reason}. Update your card or pay the month yourself.`, data: { mandate_id: m.id, subscription_id: sub.id }, dedupe_key: `autopay_declined:${sub.id}:${period.period_no}:${attempt}` });
    if (res.invalid) await stopMandate(c, m, { reason: 'The saved card can no longer be charged' });
    return { ok: false, reason: res.reason, mandateInvalid: !!res.invalid };
  }
  // money is on its way (or in): one canonical payment for the period, matched to the provider's payment intent
  const pay = (await c.query(
    `INSERT INTO payments(payer_id, provider, purpose_type, purpose_id, amount_cents, currency, method, provider_ref) VALUES ($1,'stripe','coach_subscription_period',$2,$3,$4,'card',$5)
     ON CONFLICT (provider, provider_ref) DO UPDATE SET provider_ref=EXCLUDED.provider_ref RETURNING id`, [m.payer_id, period.id, price, period.currency, res.ref])).rows[0];
  await recordCharge(c, { id: pay.id, payer_id: m.payer_id, purpose_type: 'coach_subscription_period', purpose_id: period.id, amount_cents: price, currency: period.currency, provider: 'stripe' });
  await c.query("UPDATE mandate_charges SET status=$2, payment_id=$3, provider_ref=$4, updated_at=now() WHERE id=$1", [row.id, res.ok ? 'succeeded' : 'processing', pay.id, res.ref]);
  await c.query('UPDATE payment_mandates SET last_charged_at=now(), updated_at=now() WHERE id=$1', [m.id]);
  return { ok: true, ref: res.ref, after: res.ok ? () => settle(pay.id, { paid: true, amount: res.amount ?? price, currency: res.currency, paymentRef: res.ref, method: 'card' }) : null };
}

/** The collections hook. A coach month supplies { client, mandate, period, attempt }; anything else is not ours. */
registerMandateExecutor('stripe-coach', async (req) => (req.coachPeriod ? chargeCoachPeriod(req.coachPeriod) : { ok: false, reason: 'unsupported' }));

// ---- webhooks -------------------------------------------------------------------------------------------------------------------------
/** checkout.session.completed in setup mode: the customer saved a card. */
export async function onCardSetupCompleted(session) {
  const m = await one("SELECT * FROM payment_mandates WHERE provider='stripe' AND provider_ref=$1", [session.id]);
  if (!m) return { handled: false };
  return { handled: true, mandate: await activateCardMandate(m, await stripe.retrieveSetup(session.id)) };
}

/** payment_intent.succeeded / payment_failed for a charge we made off-session. Idempotent: the payment is only settled or failed once. */
export async function onCardIntent(intent, ok) {
  const p = await one("SELECT id, status FROM payments WHERE provider='stripe' AND provider_ref=$1", [intent.id]);
  if (!p) return { handled: false };
  if (ok) await settle(p.id, { paid: true, amount: intent.amount_received || intent.amount, currency: String(intent.currency).toUpperCase(), paymentRef: intent.id, method: 'card' });
  else await tx(async (c) => {
    await c.query("UPDATE payments SET status='failed' WHERE id=$1 AND status='pending'", [p.id]);
    await c.query("UPDATE mandate_charges SET status='failed', reason=$2, updated_at=now() WHERE payment_id=$1 AND status IN ('started','processing')", [p.id, String(intent.last_payment_error?.message ?? 'declined').slice(0, 160)]);
  });
  return { handled: true };
}
