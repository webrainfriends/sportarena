import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';

// ---- stand-ins for the Stripe and PayPal HTTP APIs (the real providers need real keys) ----
const fake = { stripeSessions: {}, stripeRefunds: [], paypalOrders: {}, paypalRefunds: [], n: 0, wrongAmount: false };
const provider = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const url = req.url;
  if (url === '/v1/checkout/sessions' && req.method === 'POST') {
    const f = new URLSearchParams(raw); const id = `cs_${++fake.n}`;
    fake.stripeSessions[id] = { id, amount_total: Number(f.get('line_items[0][price_data][unit_amount]')), currency: f.get('line_items[0][price_data][currency]'), payment_status: 'unpaid', payment_intent: `pi_${fake.n}`, success_url: f.get('success_url') };
    return send(200, { id, url: `https://checkout.stripe.test/${id}` });
  }
  if (url.startsWith('/v1/checkout/sessions/')) {
    const s = fake.stripeSessions[url.split('/').pop()];
    return s ? send(200, { ...s, amount_total: fake.wrongAmount ? s.amount_total + 1 : s.amount_total }) : send(404, { error: { message: 'no such session' } });
  }
  if (url === '/v1/refunds') { fake.stripeRefunds.push(new URLSearchParams(raw).get('payment_intent')); return send(200, { id: 're_1' }); }
  if (url === '/v1/oauth2/token') return send(200, { access_token: 'pp_token', expires_in: 3600 });
  if (url === '/v2/checkout/orders' && req.method === 'POST') {
    const b = JSON.parse(raw); const id = `ORD${++fake.n}`;
    fake.paypalOrders[id] = { id, approved: false, amount: b.purchase_units[0].amount };
    return send(200, { id, links: [{ rel: 'payer-action', href: `https://paypal.test/approve/${id}` }] });
  }
  const cap = url.match(/^\/v2\/checkout\/orders\/(\w+)\/capture$/);
  if (cap) {
    const o = fake.paypalOrders[cap[1]];
    if (!o?.approved) return send(422, { details: [{ issue: 'ORDER_NOT_APPROVED' }] });
    return send(201, { id: o.id, status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: `CAP_${o.id}`, status: 'COMPLETED', amount: o.amount }] } }] });
  }
  if (/^\/v2\/payments\/captures\/\w+\/refund$/.test(url)) { fake.paypalRefunds.push(url.split('/')[4]); return send(201, { status: 'COMPLETED' }); }
  if (url === '/v1/notifications/verify-webhook-signature') return send(200, { verification_status: JSON.parse(raw).transmission_id === 'good' ? 'SUCCESS' : 'FAILURE' });
  send(404, {});
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
const pbase = `http://127.0.0.1:${provider.address().port}`;
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp',
  STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_API_BASE: pbase,
  PAYPAL_CLIENT_ID: 'cid', PAYPAL_CLIENT_SECRET: 'sec', PAYPAL_WEBHOOK_ID: 'WH1', PAYPAL_API_BASE: pbase, APP_URL: 'http://app.test', CORS_ORIGINS: 'http://app.test',
});
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base, n = 0;
const api = async (method, path, { token, body, raw, headers } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { ...(raw ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  return { status: r.status, body: await r.json() };
};
const signup = async (roles) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `pay_${n}_${roles[0]}`, display_name: `Pay ${n}`, email: `pay${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const stripeSig = (payload, secret = 'whsec_test', t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
const future = (d, h = 9) => { const x = new Date(Date.now() + d * 864e5); x.setUTCHours(h, 0, 0, 0); return x.toISOString(); };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); provider.close(); await pool.end(); });

test('payment methods reflect configuration', async () => {
  const m = await api('GET', '/payments/methods');
  assert.deepEqual(m.body.providers, ['stripe', 'paypal']);
});

test('shop order: pay with Stripe (confirm + webhook), refund on cancel, no cross-user payment', async () => {
  const seller = await signup(['supplier']), buyer = await signup(['athlete']), other = await signup(['athlete']);
  const prod = (await api('POST', '/shop/products', { token: seller.token, body: { name: 'Ball', price_cents: 150000, stock: 5 } })).body;
  const order = (await api('POST', '/shop/orders', { token: buyer.token, body: { product_id: prod.id, quantity: 2, ship_to: '12 MG Road, Pune' } })).body;
  assert.equal(order.status, 'awaiting_payment');
  assert.equal((await api('PATCH', `/shop/orders/${order.id}`, { token: seller.token, body: { status: 'shipped' } })).status, 409, 'cannot ship unpaid');

  const pay = (u, extra = {}) => api('POST', '/payments', { token: u.token, body: { purpose_type: 'shop_order', purpose_id: order.id, provider: 'stripe', ...extra } });
  assert.equal((await pay(other)).status, 403, "someone else's order");
  assert.equal((await pay(buyer, { return_url: 'https://evil.example/x' })).status, 403, 'return_url must be an allowed origin');
  const p = await pay(buyer);
  assert.equal(p.status, 201, JSON.stringify(p.body));
  assert.equal(p.body.amount_cents, 300000, 'amount comes from the order');
  assert.match(p.body.checkout_url, /^https:\/\/checkout\.stripe\.test\/cs_/);
  assert.match(fake.stripeSessions[p.body.checkout_url.split('/').pop()].success_url, /^http:\/\/app\.test\/\?payment=.+&result=success$/);

  const confirm = () => api('POST', `/payments/${p.body.id}/confirm`, { token: buyer.token });
  assert.equal((await confirm()).body.status, 'pending', 'not paid at the provider yet');
  fake.stripeSessions[p.body.checkout_url.split('/').pop()].payment_status = 'paid';
  assert.equal((await confirm()).body.status, 'paid');
  assert.equal((await confirm()).body.status, 'paid', 'idempotent');
  assert.equal((await api('GET', '/shop/orders', { token: buyer.token })).body[0].status, 'placed');
  assert.equal((await api('POST', '/payments', { token: buyer.token, body: { purpose_type: 'shop_order', purpose_id: order.id, provider: 'stripe' } })).status, 409, 'cannot pay twice');

  // cancel a paid order -> stock back + Stripe refund
  assert.equal((await api('PATCH', `/shop/orders/${order.id}`, { token: buyer.token, body: { status: 'cancelled' } })).status, 200);
  assert.deepEqual(fake.stripeRefunds, [fake.stripeSessions[p.body.checkout_url.split('/').pop()].payment_intent]);
  assert.equal((await api('GET', '/payments', { token: buyer.token })).body[0].status, 'refunded');
  assert.equal((await api('GET', '/shop/products')).body.find((x) => x.id === prod.id).stock, 5);

  // webhook path
  const o2 = (await api('POST', '/shop/orders', { token: buyer.token, body: { product_id: prod.id, quantity: 1, ship_to: '12 MG Road, Pune' } })).body;
  const p2 = (await api('POST', '/payments', { token: buyer.token, body: { purpose_type: 'shop_order', purpose_id: o2.id, provider: 'stripe' } })).body;
  const sid = p2.checkout_url.split('/').pop();
  fake.stripeSessions[sid].payment_status = 'paid';
  const evt = JSON.stringify({ type: 'checkout.session.completed', data: { object: { ...fake.stripeSessions[sid] } } });
  const hook = (payload, sig) => fetch(`${base}/api/v1/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': sig, 'content-type': 'application/json' }, body: payload });
  assert.equal((await hook(evt, stripeSig(evt, 'wrong-secret'))).status, 400, 'bad signature rejected');
  assert.equal((await hook(evt, stripeSig(evt, 'whsec_test', 1000))).status, 400, 'stale timestamp rejected');
  assert.equal((await hook(evt, stripeSig(evt))).status, 200);
  assert.equal((await api('GET', '/shop/orders', { token: buyer.token })).body.find((x) => x.id === o2.id).status, 'placed');
  assert.equal((await api('PATCH', `/shop/orders/${o2.id}`, { token: seller.token, body: { status: 'shipped' } })).status, 200);
  assert.equal((await api('PATCH', `/shop/orders/${o2.id}`, { token: buyer.token, body: { status: 'cancelled' } })).status, 409, 'too late to cancel once shipped');

  // provider reporting a different amount never fulfils the order
  const o3 = (await api('POST', '/shop/orders', { token: buyer.token, body: { product_id: prod.id, quantity: 1, ship_to: '12 MG Road, Pune' } })).body;
  const p3 = (await api('POST', '/payments', { token: buyer.token, body: { purpose_type: 'shop_order', purpose_id: o3.id, provider: 'stripe' } })).body;
  fake.stripeSessions[p3.checkout_url.split('/').pop()].payment_status = 'paid'; fake.wrongAmount = true;
  assert.equal((await api('POST', `/payments/${p3.id}/confirm`, { token: buyer.token })).status, 409);
  fake.wrongAmount = false;
  assert.equal((await api('GET', '/shop/orders', { token: buyer.token })).body.find((x) => x.id === o3.id).status, 'awaiting_payment');
});

test('coach hire: pay with PayPal (capture on confirm), coach confirms after payment, cancel refunds', async () => {
  const coach = await signup(['coach']), hirer = await signup(['athlete']);
  await api('POST', '/me/sport-profiles', { token: coach.token, body: { sport: 'football', role: 'coach', hourly_rate_cents: 80000 } });
  const hire = (await api('POST', '/hires', { token: hirer.token, body: { coach_id: coach.id, sport: 'football', starts_at: future(3), duration_min: 60 } })).body;
  assert.equal(hire.payment_status, 'unpaid');
  assert.equal((await api('PATCH', `/hires/${hire.id}`, { token: coach.token, body: { status: 'confirmed' } })).status, 409, 'coach waits for payment');

  const p = (await api('POST', '/payments', { token: hirer.token, body: { purpose_type: 'coach_hire', purpose_id: hire.id, provider: 'paypal' } })).body;
  const orderId = p.checkout_url.split('/').pop();
  assert.equal(fake.paypalOrders[orderId].amount.value, '800.00');
  const confirm = () => api('POST', `/payments/${p.id}/confirm`, { token: hirer.token });
  assert.equal((await confirm()).body.status, 'pending', 'buyer has not approved yet');
  fake.paypalOrders[orderId].approved = true;
  assert.equal((await confirm()).body.status, 'paid');
  assert.equal((await api('PATCH', `/hires/${hire.id}`, { token: coach.token, body: { status: 'confirmed' } })).status, 200);
  assert.equal((await api('PATCH', `/hires/${hire.id}`, { token: hirer.token, body: { status: 'cancelled' } })).body.payment_status, 'refunded');
  assert.deepEqual(fake.paypalRefunds, [`CAP_${orderId}`]);
});

test('coach request: an accepted answer is reserved until paid, then the payment itself confirms the session', async () => {
  const coach = await signup(['coach']), athlete = await signup(['athlete']);
  await api('POST', '/me/sport-profiles', { token: coach.token, body: { sport: 'football', role: 'coach', hourly_rate_cents: 50000 } });
  const req = (await api('POST', '/coach-requests', { token: athlete.token, body: { sport: 'football', title: 'Weekly sessions' } })).body;
  const ans = (await api('POST', `/coach-requests/${req.id}/respond`, { token: coach.token, body: { starts_at: future(3), duration_min: 90 } })).body;
  const done = (await api('POST', `/coach-responses/${ans.id}/decision`, { token: athlete.token, body: { decision: 'accept' } })).body;
  assert.equal(done.hire.status, 'requested'); assert.equal(done.hire.payment_status, 'unpaid'); assert.equal(done.hire.total_cents, 75000);
  const ov = (await api('GET', '/coaching/overview', { token: athlete.token })).body;
  assert.deepEqual(ov.athlete.awaiting_payment.map((h) => h.id), [done.hire.id]); assert.equal(ov.athlete.spend.due_cents, 75000);
  const p = (await api('POST', '/payments', { token: athlete.token, body: { purpose_type: 'coach_hire', purpose_id: done.hire.id, provider: 'paypal' } })).body;
  fake.paypalOrders[p.checkout_url.split('/').pop()].approved = true;
  assert.equal((await api('POST', `/payments/${p.id}/confirm`, { token: athlete.token })).body.status, 'paid');
  const mine = (await api('GET', '/hires', { token: coach.token })).body.find((h) => h.id === done.hire.id);
  assert.equal(mine.status, 'confirmed', 'no extra confirm step: the coach agreed when answering'); assert.equal(mine.payment_status, 'paid');
  const earn = (await api('GET', '/coaching/payments?as=coach', { token: coach.token })).body;
  assert.equal(earn[0].payment_status, 'paid'); assert.ok(earn[0].paid_at);
  assert.equal((await api('GET', '/coaching/overview', { token: coach.token })).body.coach.earnings.earned_cents, 75000);
});

test('insurance: policy is pending until paid; PayPal approval webhook captures and activates', async () => {
  const admin = await signup(['athlete']); await pool.query("UPDATE users SET roles='{admin}' WHERE id=$1", [admin.id]);
  const holder = await signup(['athlete']);
  const plan = (await api('POST', '/insurance/plans', { token: admin.token, body: { name: 'Shield', insurer: 'Acme', cover_for: 'individual', premium_cents: 50000, coverage_cents: 5000000 } })).body;
  const pol = (await api('POST', '/insurance/policies', { token: holder.token, body: { plan_id: plan.id, months: 3 } })).body;
  assert.equal(pol.status, 'pending_payment');
  assert.equal((await api('POST', `/insurance/policies/${pol.id}/claims`, { token: holder.token, body: { description: 'sprained ankle', amount_cents: 1000 } })).status, 409, 'no claims before payment');

  const p = (await api('POST', '/payments', { token: holder.token, body: { purpose_type: 'insurance_policy', purpose_id: pol.id, provider: 'paypal' } })).body;
  assert.equal(p.amount_cents, 150000, '3 months × premium');
  const orderId = p.checkout_url.split('/').pop();
  fake.paypalOrders[orderId].approved = true;
  const evt = JSON.stringify({ event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: orderId } });
  const hook = (id) => fetch(`${base}/api/v1/webhooks/paypal`, { method: 'POST', headers: { 'paypal-transmission-id': id, 'content-type': 'application/json' }, body: evt });
  assert.equal((await hook('forged')).status, 400, 'unverified PayPal webhook rejected');
  assert.equal((await hook('good')).status, 200);
  assert.equal((await api('GET', '/insurance/policies', { token: holder.token })).body[0].status, 'active');
  assert.equal((await api('POST', `/insurance/policies/${pol.id}/claims`, { token: holder.token, body: { description: 'sprained ankle', amount_cents: 1000 } })).status, 201);
});
