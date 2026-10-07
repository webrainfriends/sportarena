// Provider webhooks. They carry no user session, so authenticity comes from the provider's signature — never from the body alone.
import express from 'express';
import { one } from '../db.js';
import { settle } from './service.js';
import { stripe, paypal } from './providers.js';

const byRef = (provider, ref) => (ref ? one('SELECT id FROM payments WHERE provider=$1 AND provider_ref=$2', [provider, ref]) : null);

export function webhookRouter() {
  const r = express.Router();
  const raw = express.raw({ type: '*/*', limit: '256kb' });
  const safe = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) { console.error('[webhook]', e.message); res.status(500).json({ error: 'processing_failed' }); } // non-2xx => the provider retries
  };

  r.post('/stripe', raw, safe(async (req, res) => {
    const body = req.body.toString('utf8');
    if (!stripe.verifyWebhook(body, req.headers['stripe-signature'])) return res.status(400).json({ error: 'bad_signature' });
    const event = JSON.parse(body);
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const p = await byRef('stripe', event.data.object.id);
      if (p) await settle(p.id, stripe.fromSession(event.data.object));
    }
    res.json({ received: true });
  }));

  r.post('/paypal', raw, safe(async (req, res) => {
    const body = req.body.toString('utf8');
    const event = JSON.parse(body);
    if (!(await paypal.verifyWebhook(req.headers, event))) return res.status(400).json({ error: 'bad_signature' });
    if (event.event_type === 'CHECKOUT.ORDER.APPROVED') {
      const p = await byRef('paypal', event.resource?.id);
      if (p) await settle(p.id, await paypal.capture(event.resource.id));
    } else if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
      const orderId = event.resource?.supplementary_data?.related_ids?.order_id;
      const p = await byRef('paypal', orderId);
      if (p) await settle(p.id, await paypal.retrieve(orderId));
    }
    res.json({ received: true });
  }));
  return r;
}
