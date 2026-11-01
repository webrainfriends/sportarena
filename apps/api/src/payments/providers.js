// Thin clients for Stripe Checkout and PayPal Orders v2 (plain fetch — no SDK, no card data on our servers).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { toMajor, fromMajor } from '../currency.js';

import { valueOf } from './provider-config.js';

// Keys come from the app's encrypted provider settings first, then the environment (see provider-config.js). Base URLs stay environment-only.
const cfg = () => {
  const p = config.payments;
  return {
    currency: p.currency,
    stripe: { secretKey: valueOf('stripe', 'secret_key'), webhookSecret: valueOf('stripe', 'webhook_secret'), base: p.stripe.base },
    paypal: { clientId: valueOf('paypal', 'client_id'), secret: valueOf('paypal', 'secret'), webhookId: valueOf('paypal', 'webhook_id'), base: p.paypal.base },
    razorpay: { keyId: valueOf('razorpay', 'key_id'), keySecret: valueOf('razorpay', 'key_secret'), webhookSecret: valueOf('razorpay', 'webhook_secret'), base: p.razorpay.base },
  };
};
export const stripeEnabled = () => !!cfg().stripe.secretKey;
export const paypalEnabled = () => !!(cfg().paypal.clientId && cfg().paypal.secret);
export const razorpayEnabled = () => !!(cfg().razorpay.keyId && cfg().razorpay.keySecret);
/** Providers with keys on this server. Which of them a person is offered also depends on the country (payments/countries.js). */
export const configuredProviders = () => [stripeEnabled() && 'stripe', paypalEnabled() && 'paypal', razorpayEnabled() && 'razorpay'].filter(Boolean);

const fail = (provider, status, detail) => new AppError(502, 'payment_provider_error', `${provider} rejected the request${detail ? `: ${detail}` : ` (${status})`}`);
async function call(provider, url, init) {
  let res;
  try { res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }); }
  catch { throw new AppError(502, 'payment_provider_unreachable', `Could not reach ${provider}`); }
  const body = await res.json().catch(() => null);
  return { res, body };
}
const dec = (amount, currency) => toMajor(amount, currency);

// ---------------- Stripe ----------------
const stripeAuth = () => ({ authorization: `Bearer ${cfg().stripe.secretKey}` });
function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v !== null && typeof v === 'object') form(v, key, out); else if (v !== undefined) out.append(key, String(v));
  }
  return out;
}

export const stripe = {
  async createCheckout({ paymentId, amount, currency, name, successUrl, cancelUrl }) {
    const body = form({
      mode: 'payment', success_url: successUrl, cancel_url: cancelUrl, client_reference_id: paymentId, metadata: { payment_id: paymentId },
      line_items: { 0: { quantity: 1, price_data: { currency: currency.toLowerCase(), unit_amount: amount, product_data: { name } } } },
    });
    const { res, body: b } = await call('Stripe', `${cfg().stripe.base}/v1/checkout/sessions`, { method: 'POST', headers: { ...stripeAuth(), 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': `checkout-${paymentId}` }, body });
    if (!res.ok || !b?.url) throw fail('Stripe', res.status, b?.error?.message);
    return { ref: b.id, url: b.url };
  },
  async retrieve(ref) {
    const { res, body: b } = await call('Stripe', `${cfg().stripe.base}/v1/checkout/sessions/${encodeURIComponent(ref)}`, { headers: stripeAuth() });
    if (!res.ok) throw fail('Stripe', res.status, b?.error?.message);
    return stripe.fromSession(b);
  },
  fromSession: (s) => ({ paid: s.payment_status === 'paid', amount: s.amount_total, currency: String(s.currency ?? '').toUpperCase(), paymentRef: typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent?.id ?? null }),
  /** Refund all of a payment, or `amount` minor units of it (`key` makes a partial refund idempotent). */
  async refund(paymentRef, paymentId, { amount, key } = {}) {
    const { res, body: b } = await call('Stripe', `${cfg().stripe.base}/v1/refunds`, { method: 'POST', headers: { ...stripeAuth(), 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': `refund-${key ?? paymentId}` }, body: form({ payment_intent: paymentRef, amount }) });
    if (!res.ok) throw fail('Stripe', res.status, b?.error?.message);
  },
  /** Pay out to a connected account (Stripe Connect). `key` makes a retry return the same transfer instead of moving money twice. */
  async transfer({ amount, currency, destination, key, itemId }) {
    const { res, body: b } = await call('Stripe', `${cfg().stripe.base}/v1/transfers`, { method: 'POST', headers: { ...stripeAuth(), 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': `transfer-${key}` }, body: form({ amount, currency: currency.toLowerCase(), destination, metadata: { payout_item_id: itemId } }) });
    if (!res.ok || !b?.id) throw fail('Stripe', res.status, b?.error?.message);
    return { ref: b.id };
  },
  /** Verify a Stripe-Signature header against the raw request body (HMAC-SHA256, 5 minute tolerance). */
  verifyWebhook(raw, header, secret = cfg().stripe.webhookSecret, now = Date.now()) {
    if (!secret || !header) return false;
    const parts = Object.fromEntries(String(header).split(',').map((p) => p.split('=')).filter((p) => p.length === 2));
    const t = Number(parts.t);
    if (!t || Math.abs(now / 1000 - t) > 300) return false;
    const want = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
    return String(header).split(',').filter((p) => p.startsWith('v1=')).some((p) => {
      const got = p.slice(3);
      return got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
    });
  },
};

// ---------------- PayPal ----------------
let tokenCache = { value: null, exp: 0, base: null };
async function paypalToken() {
  const { base, clientId, secret } = cfg().paypal;
  if (tokenCache.value && tokenCache.base === base && Date.now() < tokenCache.exp - 30_000) return tokenCache.value;
  const { res, body: b } = await call('PayPal', `${base}/v1/oauth2/token`, { method: 'POST', headers: { authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  if (!res.ok || !b?.access_token) throw fail('PayPal', res.status, b?.error_description);
  tokenCache = { value: b.access_token, exp: Date.now() + (b.expires_in ?? 300) * 1000, base };
  return tokenCache.value;
}
const ppJson = async (path, method = 'GET', data, extra = {}) => {
  const token = await paypalToken();
  return call('PayPal', `${cfg().paypal.base}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra }, body: data ? JSON.stringify(data) : undefined });
};
const fromOrder = (o) => {
  const cap = o?.purchase_units?.[0]?.payments?.captures?.[0];
  return { paid: o?.status === 'COMPLETED' && cap?.status === 'COMPLETED', amount: cap ? fromMajor(cap.amount.value, cap.amount.currency_code) : null, currency: cap?.amount?.currency_code ?? null, paymentRef: cap?.id ?? null };
};

export const paypal = {
  async createCheckout({ paymentId, amount, currency, name, successUrl, cancelUrl }) {
    const { res, body: b } = await ppJson('/v2/checkout/orders', 'POST', {
      intent: 'CAPTURE',
      purchase_units: [{ reference_id: paymentId, custom_id: paymentId, description: name.slice(0, 120), amount: { currency_code: currency, value: dec(amount, currency) } }],
      payment_source: { paypal: { experience_context: { return_url: successUrl, cancel_url: cancelUrl, user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING' } } },
    }, { 'paypal-request-id': `order-${paymentId}` });
    const url = b?.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
    if (!res.ok || !url) throw fail('PayPal', res.status, b?.message);
    return { ref: b.id, url };
  },
  /** Capture an approved order (idempotent: an already-captured order is read back instead). */
  async capture(ref) {
    const r = await ppJson(`/v2/checkout/orders/${encodeURIComponent(ref)}/capture`, 'POST', undefined, { 'paypal-request-id': `capture-${ref}` });
    if (r.res.ok) return fromOrder(r.body);
    if (r.body?.details?.some((d) => d.issue === 'ORDER_ALREADY_CAPTURED')) return paypal.retrieve(ref);
    if (r.body?.details?.some((d) => d.issue === 'ORDER_NOT_APPROVED')) return { paid: false };
    throw fail('PayPal', r.res.status, r.body?.message);
  },
  async retrieve(ref) {
    const { res, body: b } = await ppJson(`/v2/checkout/orders/${encodeURIComponent(ref)}`);
    if (!res.ok) throw fail('PayPal', res.status, b?.message);
    return fromOrder(b);
  },
  async refund(captureRef, paymentId, { amount, currency, key } = {}) {
    const { res, body: b } = await ppJson(`/v2/payments/captures/${encodeURIComponent(captureRef)}/refund`, 'POST', amount ? { amount: { value: dec(amount, currency), currency_code: currency } } : {}, { 'paypal-request-id': `refund-${key ?? paymentId}` });
    if (!res.ok) throw fail('PayPal', res.status, b?.message);
  },
  async verifyWebhook(headers, event) {
    const { webhookId } = cfg().paypal;
    if (!webhookId) return false;
    const h = (n) => headers[n];
    const { res, body: b } = await ppJson('/v1/notifications/verify-webhook-signature', 'POST', {
      auth_algo: h('paypal-auth-algo'), cert_url: h('paypal-cert-url'), transmission_id: h('paypal-transmission-id'), transmission_sig: h('paypal-transmission-sig'),
      transmission_time: h('paypal-transmission-time'), webhook_id: webhookId, webhook_event: event,
    });
    return res.ok && b?.verification_status === 'SUCCESS';
  },
};

// ---------------- Razorpay (India: UPI, cards, netbanking, wallets) ----------------
// Hosted Payment Links, so no card or UPI data touches our servers. Amounts are paise; the link's `reference_id` is our payment id.
const rzpAuth = () => ({ authorization: `Basic ${Buffer.from(`${cfg().razorpay.keyId}:${cfg().razorpay.keySecret}`).toString('base64')}`, 'content-type': 'application/json' });
const rzpMsg = (b) => b?.error?.description;

export const razorpay = {
  async createCheckout({ paymentId, amount, currency, name, successUrl }) {
    const { res, body: b } = await call('Razorpay', `${cfg().razorpay.base}/v1/payment_links`, { method: 'POST', headers: rzpAuth(), body: JSON.stringify({
      amount, currency, reference_id: paymentId, description: name.slice(0, 120), callback_url: successUrl, callback_method: 'get', notes: { payment_id: paymentId },
    }) });
    if (!res.ok || !b?.short_url) throw fail('Razorpay', res.status, rzpMsg(b));
    return { ref: b.id, url: b.short_url };
  },
  /**
   * UPI collect (a request lands in the customer's UPI app for their VPA) or intent (a upi:// link / QR the customer opens in any UPI app).
   * Both are an order plus a UPI payment against it; the order id is the payment reference and the money is confirmed by the provider, never by the client.
   */
  async createUpi({ paymentId, amount, currency, name, upi, payer }) {
    const o = await call('Razorpay', `${cfg().razorpay.base}/v1/orders`, { method: 'POST', headers: rzpAuth(), body: JSON.stringify({ amount, currency, receipt: String(paymentId).slice(0, 40), notes: { payment_id: paymentId } }) });
    if (!o.res.ok || !o.body?.id) throw fail('Razorpay', o.res.status, rzpMsg(o.body));
    const body = { amount, currency, order_id: o.body.id, email: payer.email, contact: payer.contact, method: 'upi', description: String(name).slice(0, 120), notes: { payment_id: paymentId },
      ...(upi.flow === 'collect' ? { vpa: upi.vpa, upi: { flow: 'collect', vpa: upi.vpa } } : { upi: { flow: 'intent' } }) };
    const { res, body: b } = await call('Razorpay', `${cfg().razorpay.base}/v1/payments/create/upi`, { method: 'POST', headers: rzpAuth(), body: JSON.stringify(body) });
    if (!res.ok) throw fail('Razorpay', res.status, rzpMsg(b));
    const intent = (b?.next ?? []).find((n) => n.action === 'intent')?.url ?? b?.link ?? null;
    if (upi.flow === 'intent' && !intent) throw fail('Razorpay', res.status, 'no UPI intent link returned');
    return { ref: o.body.id, url: null, intent_url: intent, flow: upi.flow };
  },
  fromOrderPayments(items = []) {
    const pay = items.find((x) => x.status === 'captured');
    return pay ? { paid: true, amount: pay.amount, currency: String(pay.currency).toUpperCase(), paymentRef: pay.id, method: pay.method ?? 'upi' } : { paid: false };
  },
  async retrieve(ref) {
    if (String(ref).startsWith('order_')) {   // a UPI collect / intent payment: read what was paid against the order
      const r = await call('Razorpay', `${cfg().razorpay.base}/v1/orders/${encodeURIComponent(ref)}/payments`, { headers: rzpAuth() });
      if (!r.res.ok) throw fail('Razorpay', r.res.status, rzpMsg(r.body));
      return razorpay.fromOrderPayments(r.body?.items);
    }
    const { res, body: b } = await call('Razorpay', `${cfg().razorpay.base}/v1/payment_links/${encodeURIComponent(ref)}`, { headers: rzpAuth() });
    if (!res.ok) throw fail('Razorpay', res.status, rzpMsg(b));
    return razorpay.fromLink(b);
  },
  /** `method` is what the customer actually used (upi, card, netbanking, wallet) so it can be checked against the country switches. */
  fromLink(l) {
    const pay = l?.payments?.find((x) => x.status === 'captured') ?? l?.payments?.[0];
    return { paid: l?.status === 'paid', amount: l?.amount_paid ?? null, currency: String(l?.currency ?? '').toUpperCase(), paymentRef: pay?.payment_id ?? null, method: pay?.method ?? null };
  },
  async refund(paymentRef, paymentId, { amount, key } = {}) {
    const { res, body: b } = await call('Razorpay', `${cfg().razorpay.base}/v1/payments/${encodeURIComponent(paymentRef)}/refund`, { method: 'POST', headers: { ...rzpAuth(), 'x-refund-idempotency': `refund-${key ?? paymentId}` }, body: JSON.stringify({ ...(amount ? { amount } : {}), receipt: `refund-${key ?? paymentId}`.slice(0, 40), notes: { payment_id: paymentId } }) });
    if (!res.ok) throw fail('Razorpay', res.status, rzpMsg(b));
  },
  /** UPI AutoPay mandate: a monthly plan plus a subscription; the returned link is where the customer authorises the mandate in their UPI app. */
  async createMandate({ name, amount, currency, notes }) {
    const pl = await call('Razorpay', `${cfg().razorpay.base}/v1/plans`, { method: 'POST', headers: rzpAuth(), body: JSON.stringify({ period: 'monthly', interval: 1, item: { name: String(name).slice(0, 100), amount, currency } }) });
    if (!pl.res.ok || !pl.body?.id) throw fail('Razorpay', pl.res.status, rzpMsg(pl.body));
    const sub = await call('Razorpay', `${cfg().razorpay.base}/v1/subscriptions`, { method: 'POST', headers: rzpAuth(), body: JSON.stringify({ plan_id: pl.body.id, total_count: 120, customer_notify: 1, notes }) });
    if (!sub.res.ok || !sub.body?.id) throw fail('Razorpay', sub.res.status, rzpMsg(sub.body));
    return { ref: sub.body.id, url: sub.body.short_url ?? null };
  },
  async cancelMandate(ref, { atCycleEnd = false } = {}) {
    const { res, body: b } = await call('Razorpay', `${cfg().razorpay.base}/v1/subscriptions/${encodeURIComponent(ref)}/cancel`, { method: 'POST', headers: rzpAuth(), body: JSON.stringify({ cancel_at_cycle_end: atCycleEnd ? 1 : 0 }) });
    // already cancelled / completed at the provider is the state we wanted
    if (!res.ok && !/already|cancelled|completed/i.test(rzpMsg(b) ?? '')) throw fail('Razorpay', res.status, rzpMsg(b));
  },
  /** One day of settlement reconciliation lines (every payment, refund and adjustment settled that day), all pages. */
  async reconciliation({ year, month, day }) {
    const out = [];
    for (let skip = 0; skip < 5000; skip += 100) {
      const { res, body: b } = await call('Razorpay', `${cfg().razorpay.base}/v1/settlements/recon/combined?year=${year}&month=${month}&day=${day}&count=100&skip=${skip}`, { headers: rzpAuth() });
      if (!res.ok) throw fail('Razorpay', res.status, rzpMsg(b));
      out.push(...(b?.items ?? []));
      if ((b?.items ?? []).length < 100) break;
    }
    return out;
  },
  /** X-Razorpay-Signature = hex HMAC-SHA256 of the raw body with the webhook secret. */
  verifyWebhook(raw, header, secret = cfg().razorpay.webhookSecret) {
    if (!secret || !header) return false;
    const want = createHmac('sha256', secret).update(raw).digest('hex');
    const got = String(header);
    return got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
  },
};

export const provider = (name) => (name === 'stripe' ? stripe : name === 'razorpay' ? razorpay : paypal);
