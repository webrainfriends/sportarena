// Provider webhooks. They carry no user session, so authenticity comes from the provider's signature — never from the body alone.
import express from 'express';
import { one, tx } from '../db.js';
import { settle } from './service.js';
import { onProviderDispute, onProviderRefund } from '../settlement.js';
import { stripe, paypal, razorpay } from './providers.js';
import { onMandateEvent } from './mandates.js';

const byRef = (provider, ref) => (ref ? one('SELECT id FROM payments WHERE provider=$1 AND provider_ref=$2', [provider, ref]) : null);
const byPaymentRef = (provider, ref) => (ref ? one('SELECT * FROM payments WHERE provider=$1 AND provider_payment_ref=$2', [provider, ref]) : null);

// A verified event is applied once. Applying is idempotent anyway; the table makes a replay a cheap, visible no-op.
const seen = async (provider, id) => !!id && !!(await one('SELECT 1 FROM provider_events WHERE provider=$1 AND event_id=$2', [provider, id]));
const markSeen = (provider, id, kind) => (id ? one('INSERT INTO provider_events(provider, event_id, kind) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [provider, id, kind]) : null);

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
    if (await seen('stripe', event.id)) return res.json({ received: true, duplicate: true });
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const p = await byRef('stripe', event.data.object.id);
      if (p) await settle(p.id, stripe.fromSession(event.data.object));
    } else if (event.type === 'charge.refunded') {
      const p = await byPaymentRef('stripe', event.data.object.payment_intent);
      if (p) await tx((c) => onProviderRefund(c, p, event.data.object.amount_refunded));
    } else if (event.type === 'charge.dispute.created') {
      const p = await byPaymentRef('stripe', event.data.object.payment_intent);
      if (p) await tx((c) => onProviderDispute(c, p, { disputeId: event.data.object.id, amountCents: event.data.object.amount }));
    }
    await markSeen('stripe', event.id, event.type);
    res.json({ received: true });
  }));

  r.post('/paypal', raw, safe(async (req, res) => {
    const body = req.body.toString('utf8');
    const event = JSON.parse(body);
    if (!(await paypal.verifyWebhook(req.headers, event))) return res.status(400).json({ error: 'bad_signature' });
    if (await seen('paypal', event.id)) return res.json({ received: true, duplicate: true });
    if (event.event_type === 'CHECKOUT.ORDER.APPROVED') {
      const p = await byRef('paypal', event.resource?.id);
      if (p) await settle(p.id, await paypal.capture(event.resource.id));
    } else if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
      const orderId = event.resource?.supplementary_data?.related_ids?.order_id;
      const p = await byRef('paypal', orderId);
      if (p) await settle(p.id, await paypal.retrieve(orderId));
    } else if (event.event_type === 'CUSTOMER.DISPUTE.CREATED') {
      const capture = event.resource?.disputed_transactions?.[0]?.seller_transaction_id;
      const p = await byPaymentRef('paypal', capture);
      if (p) await tx((c) => onProviderDispute(c, p, { disputeId: event.resource.dispute_id ?? event.id, amountCents: null })); // amount unknown in minor units: hold the whole unrefunded payment
    }
    await markSeen('paypal', event.id, event.event_type);
    res.json({ received: true });
  }));
  // Razorpay: X-Razorpay-Signature is an HMAC of the raw body; X-Razorpay-Event-Id makes a replay a visible no-op.
  r.post('/razorpay', raw, safe(async (req, res) => {
    const body = req.body.toString('utf8');
    if (!razorpay.verifyWebhook(body, req.headers['x-razorpay-signature'])) return res.status(400).json({ error: 'bad_signature' });
    const event = JSON.parse(body);
    const eventId = req.headers['x-razorpay-event-id'] ?? null;
    if (await seen('razorpay', eventId)) return res.json({ received: true, duplicate: true });
    if (event.event === 'payment_link.paid') {
      const link = event.payload?.payment_link?.entity;
      const p = await byRef('razorpay', link?.id);
      if (p) {
        const result = razorpay.fromLink(link);
        if (result.method) await one("UPDATE payments SET method=$2 WHERE id=$1 AND status='pending'", [p.id, result.method]);
        await settle(p.id, result);
      }
    } else if (event.event === 'payment.captured') {   // a UPI collect / intent payment: matched by the order we created for it
      const pay = event.payload?.payment?.entity;
      const p = await byRef('razorpay', pay?.order_id);
      if (p) await settle(p.id, razorpay.fromOrderPayments([{ ...pay, status: 'captured' }]));
    } else if (String(event.event).startsWith('subscription.')) {   // UPI AutoPay mandate lifecycle and its recurring charges
      await onMandateEvent(event);
    } else if (event.event === 'refund.processed') {
      const rf = event.payload?.refund?.entity;
      const p = await byPaymentRef('razorpay', rf?.payment_id);
      if (p) await tx((c) => onProviderRefund(c, p, rf.amount));
    } else if (event.event === 'payment.dispute.created') {
      const d = event.payload?.dispute?.entity;
      const p = await byPaymentRef('razorpay', d?.payment_id);
      if (p) await tx((c) => onProviderDispute(c, p, { disputeId: d.id, amountCents: d.amount }));
    }
    await markSeen('razorpay', eventId, event.event);
    res.json({ received: true });
  }));

  return r;
}
