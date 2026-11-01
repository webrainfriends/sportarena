// UPI AutoPay mandates for recurring coaching subscriptions and memberships (#694). Ownership and the country switch are enforced here;
// the charges themselves flow through the canonical payments path (payments/mandates.js), so nothing about money is decided in the app.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { provider } from '../payments/providers.js';
import { enabledMethods, resolveCountry } from '../payments/countries.js';

const TAG = 'Payments';
const shape = (m) => ({ id: m.id, subject_kind: m.subject_kind, subject_id: m.subject_id, amount_minor: Number(m.amount_minor), currency: m.currency, status: m.status, authorised_at: m.authorised_at, last_charged_at: m.last_charged_at, cancelled_at: m.cancelled_at, created_at: m.created_at });

/** The thing being renewed. For a coaching subscription the id may be the subscription or one of its billing periods (what a checkout screen has in hand). */
async function subjectFor(user, kind, subjectId) {
  if (kind === 'coach_subscription') {
    const s = await one("SELECT s.id, s.title, s.price_cents, s.currency FROM coach_subscriptions s WHERE s.payer_id=$2 AND s.status IN ('active','past_due') AND (s.id=$1 OR s.id=(SELECT subscription_id FROM user_plans WHERE id=$1))", [subjectId, user.id]);
    if (!s) throw notFound('Subscription');
    return { id: s.id, name: s.title, amount: Number(s.price_cents), currency: s.currency };
  }
  const u = await one("SELECT id, name, price_cents, currency, auto_renew, status FROM user_plans WHERE id=$1 AND user_id=$2 AND kind='membership'", [subjectId, user.id]);
  if (!u) throw notFound('Membership');
  if (!u.auto_renew) throw conflict('This membership does not renew automatically, so there is nothing for AutoPay to charge');
  if (!['active', 'awaiting_payment'].includes(u.status)) throw conflict('This membership has ended');
  return { id: u.id, name: u.name, amount: Number(u.price_cents), currency: u.currency };
}

cap({
  name: 'create_payment_mandate', method: 'POST', path: '/payments/mandates', tag: TAG, status: 201, scope: 'payment',
  summary: 'Set up UPI AutoPay so a recurring coaching subscription or auto-renewing membership you pay for is charged each period without you tapping pay. INR only, and only where the platform admin has switched UPI on for your country. Returns authorisation_url: open it and approve the mandate in your UPI app. Each charge is an ordinary payment for the period that is waiting, so refunds and receipts work as usual. You can cancel any time with cancel_payment_mandate.',
  input: z.object({ subject_kind: z.enum(['coach_subscription', 'membership']), subject_id: id }),
  async handler({ user }, i) {
    const subject = await subjectFor(user, i.subject_kind, i.subject_id);
    if (subject.currency !== 'INR') throw conflict('UPI AutoPay works for rupee (INR) payments only');
    const offered = await enabledMethods(await resolveCountry({ userId: user.id, currency: subject.currency }));
    if (!offered.methods.includes('upi') || !offered.providers.includes('razorpay')) throw conflict('UPI AutoPay is not switched on for your country');
    const m = await tx(async (c) => {
      const live = (await c.query("SELECT * FROM payment_mandates WHERE subject_kind=$1 AND subject_id=$2 AND status IN ('created','authorised','active')", [i.subject_kind, subject.id])).rows[0];
      if (live) throw conflict('There is already an AutoPay mandate for this', { code: 'mandate_exists' });
      return (await c.query("INSERT INTO payment_mandates(payer_id, provider, subject_kind, subject_id, amount_minor, currency) VALUES ($1,'razorpay',$2,$3,$4,$5) RETURNING *", [user.id, i.subject_kind, subject.id, subject.amount, subject.currency])).rows[0];
    });
    try {
      const out = await provider('razorpay').createMandate({ name: subject.name, amount: subject.amount, currency: subject.currency, notes: { mandate_id: m.id } });
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
  name: 'list_my_payment_mandates', method: 'GET', path: '/payments/mandates', tag: TAG, scope: 'payment', summary: 'Your UPI AutoPay mandates and their state.', input: z.object({ ...page }),
  async handler({ user }, i) { return (await many('SELECT * FROM payment_mandates WHERE payer_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3', [user.id, i.limit, i.offset])).map(shape); },
});

cap({
  name: 'cancel_payment_mandate', method: 'POST', path: '/payments/mandates/:id/cancel', tag: TAG, scope: 'payment',
  summary: 'Stop UPI AutoPay. No further charges are made; payments already made are not changed and the subscription or membership itself is not cancelled by this.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const m = await one('SELECT * FROM payment_mandates WHERE id=$1 AND payer_id=$2', [i.id, user.id]);
    if (!m) throw notFound('Mandate');
    if (['cancelled', 'completed'].includes(m.status)) return shape(m);
    if (m.provider_ref) await provider(m.provider).cancelMandate(m.provider_ref);
    const row = await tx(async (c) => {
      const r = (await c.query("UPDATE payment_mandates SET status='cancelled', cancelled_at=now(), cancelled_by=$2, updated_at=now() WHERE id=$1 RETURNING *", [m.id, user.id])).rows[0];
      await audit(c, user.id, 'cancel_payment_mandate', 'payment_mandates', m.id);
      return r;
    });
    return shape(row);
  },
});
