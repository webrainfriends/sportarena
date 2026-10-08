// Thin clients for Stripe Checkout and PayPal Orders v2 (plain fetch — no SDK, no card data on our servers).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { toMajor, fromMajor } from '../currency.js';

const cfg = () => config.payments;
export const stripeEnabled = () => !!cfg().stripe.secretKey;
export const paypalEnabled = () => !!(cfg().paypal.clientId && cfg().paypal.secret);
export const enabledProviders = () => [stripeEnabled() && 'stripe', paypalEnabled() && 'paypal'].filter(Boolean);
export const paymentsEnabled = () => enabledProviders().length > 0;

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

export const provider = (name) => (name === 'stripe' ? stripe : paypal);
