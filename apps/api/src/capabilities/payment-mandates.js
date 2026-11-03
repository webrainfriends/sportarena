// Automatic payment mandates for recurring coaching subscriptions and memberships: UPI AutoPay (#694) and a saved card via Stripe (#680).
// One mandate system: ownership, guardian consent and the country switch are enforced here; the charges themselves flow through the canonical
// payments path (payments/mandates.js for UPI, payments/card-autopay.js for cards), so nothing about money is decided in the app.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { provider } from '../payments/providers.js';
import { safeReturnBase } from '../payments/service.js';
import { activateCardMandate, cancelCardMandate, payerBlocked, sealCustomer } from '../payments/card-autopay.js';
import { enabledMethods, resolveCountry } from '../payments/countries.js';

const TAG = 'Payments';
const shape = (m, last = null) => ({ id: m.id, method: m.method, provider: m.provider, card: m.method === 'card' && m.card_last4 ? { brand: m.card_brand, last4: m.card_last4, exp: m.card_exp } : null, last_charge: last ? { status: last.status, reason: last.reason, period_no: last.period_no, at: last.created_at } : null, revoked_reason: m.revoked_reason, subject_kind: m.subject_kind, subject_id: m.subject_id, amount_minor: Number(m.amount_minor), currency: m.currency, status: m.status, authorised_at: m.authorised_at, last_charged_at: m.last_charged_at, cancelled_at: m.cancelled_at, created_at: m.created_at });

/** The thing being renewed. For a coaching subscription the id may be the subscription or one of its billing periods (what a checkout screen has in hand). */
async function subjectFor(user, kind, subjectId) {
  if (kind === 'coach_subscription') {
    const s = await one("SELECT s.id, s.title, s.price_cents, s.currency, s.athlete_id FROM coach_subscriptions s WHERE s.payer_id=$2 AND s.status IN ('active','past_due') AND (s.id=$1 OR s.id=(SELECT subscription_id FROM user_plans WHERE id=$1))", [subjectId, user.id]);
    if (!s) throw notFound('Subscription');
    return { id: s.id, name: s.title, amount: Number(s.price_cents), currency: s.currency, athleteId: s.athlete_id };
  }
  const u = await one("SELECT id, name, price_cents, currency, auto_renew, status FROM user_plans WHERE id=$1 AND user_id=$2 AND kind='membership'", [subjectId, user.id]);
  if (!u) throw notFound('Membership');
  if (!u.auto_renew) throw conflict('This membership does not renew automatically, so there is nothing for AutoPay to charge');
  if (!['active', 'awaiting_payment'].includes(u.status)) throw conflict('This membership has ended');
  return { id: u.id, name: u.name, amount: Number(u.price_cents), currency: u.currency };
}

const lastCharges = async (ids) => {
  if (!ids.length) return new Map();
  const rows = await many('SELECT DISTINCT ON (mandate_id) mandate_id, status, reason, period_no, created_at FROM mandate_charges WHERE mandate_id = ANY($1) ORDER BY mandate_id, created_at DESC', [ids]);
  return new Map(rows.map((r) => [r.mandate_id, r]));
};

cap({
  name: 'create_payment_mandate', method: 'POST', path: '/payments/mandates', tag: TAG, status: 201, scope: 'payment',
  summary: 'Set up automatic payment so a recurring coaching subscription (or, with UPI, an auto-renewing membership) you pay for is charged each period without you tapping pay. method "upi": UPI AutoPay, INR only. method "card" (coaching subscriptions only): save a card on the provider\'s hosted page (card details never reach us) and each month is charged to it on the due date. Only where the platform admin has switched the method on for your country. A young person\'s subscription can only be set up by a verified guardian with the pay scope and current coaching consent, which is checked again before every charge. Returns authorisation_url: open it and approve; for a card call confirm_payment_mandate afterwards. Each charge is an ordinary payment for the period that is waiting, so refunds and receipts work as usual. A declined charge falls back to the normal grace, reminder and lapse flow. Cancel any time with cancel_payment_mandate.',
  input: z.object({ subject_kind: z.enum(['coach_subscription', 'membership']), subject_id: id, method: z.enum(['upi', 'card']).default('upi'),
    return_url: z.string().url().optional().describe('card: where the hosted page sends the person back to (must be an allowed origin)'), client: z.enum(['app']).optional() }),
  async handler({ user }, i) {
    const subject = await subjectFor(user, i.subject_kind, i.subject_id);
    const card = i.method === 'card';
    if (card && i.subject_kind !== 'coach_subscription') throw conflict('Automatic card payment is for coaching subscriptions');
    if (!card && subject.currency !== 'INR') throw conflict('UPI AutoPay works for rupee (INR) payments only');
    if (subject.athleteId) {
      const why = await payerBlocked(null, { payerId: user.id, athleteId: subject.athleteId });
      if (why) throw conflict(why, { code: 'guardian_consent_required' });
    }
    const offered = await enabledMethods(await resolveCountry({ userId: user.id, currency: subject.currency }));
    if (card ? !offered.methods.includes('card') || !offered.providers.includes('stripe') : !offered.methods.includes('upi') || !offered.providers.includes('razorpay')) throw conflict(card ? 'Automatic card payment is not switched on for your country' : 'UPI AutoPay is not switched on for your country');
    const prov = card ? 'stripe' : 'razorpay';
    const m = await tx(async (c) => {
      const live = (await c.query("SELECT * FROM payment_mandates WHERE subject_kind=$1 AND subject_id=$2 AND status IN ('created','authorised','active')", [i.subject_kind, subject.id])).rows[0];
      if (live) throw conflict('There is already an automatic payment for this', { code: 'mandate_exists' });
      return (await c.query("INSERT INTO payment_mandates(payer_id, provider, method, subject_kind, subject_id, amount_minor, currency) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *", [user.id, prov, i.method, i.subject_kind, subject.id, subject.amount, subject.currency])).rows[0];
    });
    try {
      let out;
      if (card) {
        const base = i.client === 'app' ? `${safeReturnBase(undefined)}/api/v1/pay/return?payment=${m.id}&result=` : `${safeReturnBase(i.return_url)}/?mandate=${m.id}&result=`;
        const cust = await provider('stripe').createCustomer({ key: m.id, name: user.display_name ?? 'Subscriber', metadata: { mandate_id: m.id } });
        await one('UPDATE payment_mandates SET customer_enc=$2 WHERE id=$1', [m.id, sealCustomer(cust.ref)]);
        out = await provider('stripe').createSetup({ mandateId: m.id, customer: cust.ref, successUrl: `${base}success`, cancelUrl: `${base}cancel` });
      } else out = await provider('razorpay').createMandate({ name: subject.name, amount: subject.amount, currency: subject.currency, notes: { mandate_id: m.id } });
      await one('UPDATE payment_mandates SET provider_ref=$2, updated_at=now() WHERE id=$1', [m.id, out.ref]);
      await audit(null, user.id, 'create_payment_mandate', 'payment_mandates', m.id);
      return { ...shape(m), authorisation_url: out.url };
    } catch (e) {
      await one("UPDATE payment_mandates SET status='cancelled', cancelled_at=now(), updated_at=now() WHERE id=$1", [m.id]);
      throw e;
    }
  },
});

cap({
  name: 'confirm_payment_mandate', method: 'POST', path: '/payments/mandates/:id/confirm', tag: TAG, scope: 'payment',
  summary: 'After the person returns from the card setup page: ask the provider whether the card was saved and, if so, turn automatic payment on. The provider is the source of truth, not the client. Safe to call repeatedly.',
  input: z.object({ id }),
  async handler({ user }, i) {
    let m = await one('SELECT * FROM payment_mandates WHERE id=$1 AND payer_id=$2', [i.id, user.id]);
    if (!m) throw notFound('Mandate');
    if (m.method === 'card' && ['created', 'authorised'].includes(m.status) && m.provider_ref) m = await activateCardMandate(m, await provider('stripe').retrieveSetup(m.provider_ref));
    return shape(m, (await lastCharges([m.id])).get(m.id));
  },
});

cap({
  name: 'list_my_payment_mandates', method: 'GET', path: '/payments/mandates', tag: TAG, scope: 'payment', summary: 'Your automatic payments (UPI AutoPay and saved cards): state, card brand / last four / expiry, and the result of the latest charge.', input: z.object({ ...page }),
  async handler({ user }, i) {
    const rows = await many('SELECT * FROM payment_mandates WHERE payer_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3', [user.id, i.limit, i.offset]);
    const last = await lastCharges(rows.map((r) => r.id));
    return rows.map((r) => shape(r, last.get(r.id)));
  },
});

cap({
  name: 'cancel_payment_mandate', method: 'POST', path: '/payments/mandates/:id/cancel', tag: TAG, scope: 'payment',
  summary: 'Stop automatic payment. Charging stops immediately and a saved card is detached at the provider; payments already made are not changed and the subscription or membership itself is not cancelled by this. Nothing is deleted.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const m = await one('SELECT * FROM payment_mandates WHERE id=$1 AND payer_id=$2', [i.id, user.id]);
    if (!m) throw notFound('Mandate');
    if (['cancelled', 'completed'].includes(m.status)) return shape(m);
    if (m.provider === 'stripe') return shape(await cancelCardMandate(m, { by: user.id, reason: 'Turned off by the payer' }));
    if (m.provider_ref) await provider(m.provider).cancelMandate(m.provider_ref);
    const row = await tx(async (c) => {
      const r = (await c.query("UPDATE payment_mandates SET status='cancelled', cancelled_at=now(), cancelled_by=$2, updated_at=now() WHERE id=$1 RETURNING *", [m.id, user.id])).rows[0];
      await audit(c, user.id, 'cancel_payment_mandate', 'payment_mandates', m.id);
      return r;
    });
    return shape(row);
  },
});
