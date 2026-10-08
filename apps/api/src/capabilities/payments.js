import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, pool, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { config } from '../config.js';
import { describePurpose, enabledProviders, refundPartial, safeReturnBase, settle } from '../payments/service.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { provider } from '../payments/providers.js';

const purposes = ['shop_order', 'coach_hire', 'insurance_policy', 'venue_invoice', 'wallet_topup', 'gift_card', 'venue_plan', 'appointment'];

cap({
  name: 'list_payment_methods', method: 'GET', path: '/payments/methods', tag: 'Payments', auth: 'public',
  summary: 'Which payment providers are switched on (Stripe, PayPal) and the default currency. Venue reservations are always charged in their own venue currency.',
  handler: () => ({ providers: enabledProviders(), currency: config.payments.currency }),
});

cap({
  name: 'create_payment', method: 'POST', path: '/payments', tag: 'Payments', status: 201,
  summary: 'Start a hosted checkout (Stripe or PayPal) for a shop order, coach hire, insurance policy or venue invoice you own. Venue invoices are charged in the invoice currency. The amount is read from the record, never from the client. Send the person to checkout_url; then call confirm_payment (or wait for the provider webhook).',
  input: z.object({ purpose_type: z.enum(purposes), purpose_id: id, provider: z.enum(['stripe', 'paypal']), return_url: z.string().url().optional().describe('where the provider sends the person back (must be an allowed origin)') }),
  async handler({ user }, i) {
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
  },
});

cap({
  name: 'confirm_payment', method: 'POST', path: '/payments/:id/confirm', tag: 'Payments',
  summary: 'Ask the provider whether this payment went through (captures an approved PayPal order) and fulfil the order/hire/policy. Safe to call repeatedly.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const p = await one('SELECT * FROM payments WHERE id=$1 AND payer_id=$2', [i.id, user.id]);
    if (!p) throw notFound('Payment');
    const about = { purpose_type: p.purpose_type, purpose_id: p.purpose_id };
    if (p.status !== 'pending') return { id: p.id, status: p.status, ...about };
    if (!p.provider_ref) return { id: p.id, status: 'pending', ...about };
    const prov = provider(p.provider);
    const result = p.provider === 'paypal' ? await prov.capture(p.provider_ref) : await prov.retrieve(p.provider_ref);
    return { id: p.id, ...about, ...(await settle(p.id, result)) };
  },
});

cap({
  name: 'list_my_payments', method: 'GET', path: '/payments', tag: 'Payments', summary: 'Your payments and their status.', input: z.object({ ...page }),
  handler: ({ user }, i) => many('SELECT id, provider, purpose_type, purpose_id, amount_cents, currency, status, created_at, paid_at, refunded_at FROM payments WHERE payer_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3', [user.id, i.limit, i.offset]),
});

cap({
  name: 'refund_payment', method: 'POST', path: '/admin/payments/:id/refund', tag: 'Payments', auth: ['admin'],
  summary: 'Platform team: refund all or part of a paid payment at the provider (idempotent per amount, so a retry cannot refund twice). Money only: it does not cancel the booking, order or hire it paid for, so use that capability first when the thing itself should be undone. Needs a reason; pass case_id to record it on the dispute timeline. You cannot refund a payment on your own case.',
  input: z.object({ id, amount_cents: z.coerce.number().int().min(1).optional().describe('defaults to everything not yet refunded'), reason: z.string().min(5).max(500), case_id: id.optional() }),
  async handler({ user }, i) {
    const p = await one('SELECT * FROM payments WHERE id=$1', [i.id]);
    if (!p) throw notFound('Payment');
    if (p.status !== 'paid') throw conflict(`Payment is ${p.status}; only a paid payment can be refunded`);
    const left = Number(p.amount_cents) - Number(p.refunded_cents);
    const give = i.amount_cents ?? left;
    if (give > left) throw conflict(`Only ${left} is left to refund on this payment`);
    if (i.case_id) {
      const cs = await one("SELECT c.id, c.requester_id, c.status FROM cases c JOIN case_links l ON l.case_id=c.id AND l.entity_type='payment' AND l.entity_id=$2 WHERE c.id=$1", [i.case_id, p.id]);
      if (!cs) throw badRequest('That case does not link this payment');
      if (cs.requester_id === user.id) throw forbidden('Another platform team member must handle your own case');
    }
    const refunded = await refundPartial(p, give, `admin-refund-${p.id}-${p.refunded_cents}-${give}`);
    await tx(async (c) => {
      await audit(c, user.id, 'refund_payment', 'payments', p.id);
      if (i.case_id) await c.query("INSERT INTO case_events(case_id, actor_id, action, reason, data) VALUES ($1,$2,'refund_payment',$3,$4)", [i.case_id, user.id, i.reason, JSON.stringify({ payment_id: p.id, amount_cents: refunded, currency: p.currency })]);
      await notify(c, p.payer_id, { kind: 'refund_issued', title: 'A refund was issued', body: 'Part or all of a payment you made has been refunded to your original payment method.', data: { payment_id: p.id } });
    });
    const after = await one('SELECT id, status, amount_cents, refunded_cents, currency FROM payments WHERE id=$1', [p.id]);
    return { ...after, refunded_now: refunded };
  },
});
