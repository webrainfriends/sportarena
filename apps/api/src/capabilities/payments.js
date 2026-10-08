import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { config } from '../config.js';
import { describePurpose, enabledProviders, safeReturnBase, settle } from '../payments/service.js';
import { provider } from '../payments/providers.js';

const purposes = ['shop_order', 'coach_hire', 'insurance_policy', 'venue_invoice', 'wallet_topup', 'gift_card'];

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
