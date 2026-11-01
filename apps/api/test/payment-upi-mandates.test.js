// Provider keys managed in the app (encrypted, write-only), UPI collect and intent, recurring UPI mandates and settlement reconciliation (#694),
// against a local stand-in for Razorpay. Every test creates its own people and data.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';

const fake = { orders: {}, payments: {}, subs: [], cancelled: [], auth: [], recon: [], n: 0 };
const provider = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  fake.auth.push(req.headers.authorization);
  const u = req.url;
  if (u === '/v1/orders' && req.method === 'POST') { const b = JSON.parse(raw); const id = `order_${++fake.n}`; fake.orders[id] = { id, amount: b.amount, currency: b.currency }; return send(200, fake.orders[id]); }
  if (u === '/v1/payments/create/upi') {
    const b = JSON.parse(raw); const id = `pay_${++fake.n}`;
    fake.payments[id] = { id, order_id: b.order_id, amount: b.amount, currency: b.currency, method: 'upi', status: 'created', body: b };
    return send(200, b.upi?.flow === 'intent' ? { razorpay_payment_id: id, next: [{ action: 'intent', url: `upi://pay?pa=merchant@bank&am=${b.amount / 100}&tr=${id}` }] } : { razorpay_payment_id: id, next: [{ action: 'poll' }] });
  }
  const op = u.match(/^\/v1\/orders\/(order_\d+)\/payments$/);
  if (op) return send(200, { items: Object.values(fake.payments).filter((p) => p.order_id === op[1]) });
  if (u === '/v1/plans') return send(200, { id: `plan_${++fake.n}` });
  if (u === '/v1/subscriptions' && req.method === 'POST') { const id = `sub_${++fake.n}`; fake.subs.push(id); return send(200, { id, short_url: `https://rzp.test/mandate/${id}` }); }
  const cn = u.match(/^\/v1\/subscriptions\/(sub_\d+)\/cancel$/);
  if (cn) { fake.cancelled.push(cn[1]); return send(200, { id: cn[1], status: 'cancelled' }); }
  if (u.startsWith('/v1/settlements/recon/combined')) return send(200, { items: fake.recon });
  send(404, { error: { description: 'not found' } });
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
Object.assign(process.env, {
  RAZORPAY_KEY_ID: 'rzp_env_key', RAZORPAY_KEY_SECRET: 'env_secret', RAZORPAY_WEBHOOK_SECRET: 'whsec_rzp', RAZORPAY_API_BASE: `http://127.0.0.1:${provider.address().port}`,
  APP_URL: 'http://app.test', CORS_ORIGINS: 'http://app.test', PLATFORM_ADMIN_EMAILS: 'rraja.edge@gmail.com,rrajas1978@icloud.com',
});
delete process.env.STRIPE_SECRET_KEY; delete process.env.PAYPAL_CLIENT_ID;
const { pool, start, stop, call, ok, signup } = await import('./tender-helpers.js');
const { refreshProviderConfig } = await import('../src/payments/provider-config.js');
const { refreshCountryMethods } = await import('../src/payments/countries.js');
const { syncCoachSubscriptions } = await import('../src/coach-subscriptions.js');

before(async () => { await start(); await pool.query("INSERT INTO payment_method_countries(country, method, enabled) VALUES ('IN','upi',true) ON CONFLICT (country, method) DO UPDATE SET enabled=true"); await refreshCountryMethods(); });
after(async () => { provider.close(); await stop(); });

let admin;
const boss = async () => {
  if (admin) return admin;
  const reg = ok(await call('POST', '/auth/register', { body: { handle: 'upi_boss', display_name: 'boss', email: 'rraja.edge@gmail.com', password: 'correct-horse-battery', roles: ['athlete'] } }), 201);
  await pool.query("UPDATE users SET roles = '{athlete,admin,platform_admin}' WHERE id = $1", [reg.user.id]);
  admin = ok(await call('POST', '/auth/login', { body: { email: 'rraja.edge@gmail.com', password: 'correct-horse-battery' } })).token;
  return admin;
};
const sign = (raw) => createHmac('sha256', 'whsec_rzp').update(raw).digest('hex');
let ev = 0;
const hook = (event) => { const raw = JSON.stringify(event); return call('POST', '/webhooks/razorpay', { raw, headers: { 'content-type': 'application/json', 'x-razorpay-signature': sign(raw), 'x-razorpay-event-id': `evt_${++ev}` } }); };
const topup = async (u) => ok(await call('POST', '/me/wallet/topups', { token: u.token, body: { currency: 'INR', amount_cents: 25000 } }), 201);
const payUpi = (u, id, upi, extra = {}) => call('POST', '/payments', { token: u.token, body: { purpose_type: 'wallet_topup', purpose_id: id, provider: 'razorpay', upi, return_url: 'http://app.test/', ...extra } });

test('provider keys: admin-only, encrypted, write-only; the app value overrides the environment and clearing restores it', async () => {
  const token = await boss(); const u = await signup('plain');
  assert.equal((await call('GET', '/admin/payments/providers', { token: u.token })).status, 403);
  assert.equal((await call('POST', '/admin/payments/providers/razorpay/keys/key_id', { token: u.token, body: { value: 'rzp_hack_1234' } })).status, 403);
  let list = ok(await call('GET', '/admin/payments/providers', { token })).providers.find((p) => p.provider === 'razorpay');
  assert.equal(list.fields.find((f) => f.key === 'key_id').source, 'environment');
  ok(await call('POST', '/admin/payments/providers/razorpay/keys/key_id', { token, body: { value: 'rzp_app_key_ABCD' } }));
  const after = await call('GET', '/admin/payments/providers', { token });
  list = after.body.providers.find((p) => p.provider === 'razorpay');
  const f = list.fields.find((x) => x.key === 'key_id');
  assert.deepEqual([f.source, f.last4], ['app', 'ABCD']);
  assert.ok(!JSON.stringify(after.body).includes('rzp_app_key_ABCD'), 'the stored value is never returned');
  const row = (await pool.query("SELECT value_enc FROM payment_provider_config WHERE provider='razorpay' AND key='key_id'")).rows[0];
  assert.ok(row.value_enc && !row.value_enc.includes('rzp_app_key'), 'encrypted at rest');
  // the very next provider call uses the app key
  const t = await topup(u); fake.auth.length = 0;
  ok(await payUpi(u, t.id, { flow: 'intent', contact: '9876543210' }), 201);
  assert.ok(fake.auth.some((a) => Buffer.from(a.replace('Basic ', ''), 'base64').toString().startsWith('rzp_app_key_ABCD:')));
  assert.equal((await call('POST', '/admin/payments/providers/razorpay/keys/nope', { token, body: { value: 'whatever1' } })).status, 400);
  ok(await call('POST', '/admin/payments/providers/razorpay/keys/key_id', { token, body: { value: null } }));
  list = ok(await call('GET', '/admin/payments/providers', { token })).providers.find((p) => p.provider === 'razorpay');
  assert.equal(list.fields.find((x) => x.key === 'key_id').source, 'environment');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'payment_provider_key_%'")).rows[0].n, 2);
  await refreshProviderConfig();
});

test('UPI collect sends a request to the UPI ID and confirms from the provider; intent returns a upi:// link; the payment.captured webhook settles once', async () => {
  const u = await signup('upi_user'); const t = await topup(u);
  assert.equal((await payUpi(u, t.id, { flow: 'collect', contact: '9876543210' })).status, 400, 'collect needs a UPI ID');
  assert.equal((await payUpi(u, t.id, { flow: 'collect', vpa: 'not a vpa', contact: '9876543210' })).status, 400);
  assert.equal((await payUpi(u, t.id, { flow: 'collect', vpa: 'ravi@okbank' })).status, 400, 'a mobile number is needed');
  const c = ok(await payUpi(u, t.id, { flow: 'collect', vpa: 'ravi@okbank', contact: '9876543210' }), 201);
  assert.equal(c.method, 'upi'); assert.equal(c.upi_flow, 'collect'); assert.equal(c.checkout_url, null);
  const pay = Object.values(fake.payments).find((p) => p.body.vpa === 'ravi@okbank');
  assert.equal(pay.body.upi.flow, 'collect'); assert.equal(pay.amount, 25000);
  assert.equal(ok(await call('POST', `/payments/${c.id}/confirm`, { token: u.token, body: {} })).status, 'pending');
  pay.status = 'captured';
  assert.equal(ok(await call('POST', `/payments/${c.id}/confirm`, { token: u.token, body: {} })).status, 'paid');
  // intent on a second top-up, settled by the webhook instead of the client
  const t2 = await topup(u);
  const i = ok(await payUpi(u, t2.id, { flow: 'intent', contact: '9876543210' }), 201);
  assert.match(i.upi_intent_url, /^upi:\/\/pay\?/);
  const ip = Object.values(fake.payments).find((p) => p.order_id === (fake.lastOrder = Object.keys(fake.orders).at(-1)));
  const body = { event: 'payment.captured', payload: { payment: { entity: { id: ip.id, order_id: ip.order_id, amount: ip.amount, currency: 'INR', method: 'upi', status: 'captured' } } } };
  assert.equal((await hook(body)).status, 200); assert.equal((await hook(body)).status, 200);
  const bal = (await pool.query("SELECT balance_cents FROM wallet_accounts WHERE user_id=$1 AND currency='INR'", [u.id])).rows[0];
  assert.equal(Number(bal.balance_cents), 50000, 'both top-ups credited exactly once');
  // UPI is refused where the admin has not switched it on
  await pool.query("UPDATE payment_method_countries SET enabled=false WHERE country='IN' AND method='upi'"); await refreshCountryMethods();
  const t3 = await topup(u);
  assert.equal((await payUpi(u, t3.id, { flow: 'intent', contact: '9876543210' })).status, 409);
  await pool.query("UPDATE payment_method_countries SET enabled=true WHERE country='IN' AND method='upi'"); await refreshCountryMethods();
});

test('UPI AutoPay: mandate for a coaching subscription, authorised and charged by the provider, replay-safe, cancellable; stray charges become exceptions', async () => {
  const coach = await signup('coach_m', ['coach']); const athlete = await signup('athlete_m');
  ok(await call('POST', '/me/sport-profiles', { token: coach.token, body: { sport: 'football', role: 'coach', level: 'pro', hourly_rate_cents: 70000 } }), 201);
  const card = ok(await call('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'Monthly mentoring', sport: 'football', audience: 'individual', unit: 'month', price_cents: 400000, sessions_included: 4, rollover_max: 2, grace_days: 3 } }), 201);
  const sub = ok(await call('POST', '/coach-subscriptions', { token: athlete.token, body: { rate_card_id: card.id } }), 201);
  const subscriptionId = sub.subscription.id;
  assert.equal((await call('POST', '/payments/mandates', { token: coach.token, body: { subject_kind: 'coach_subscription', subject_id: subscriptionId } })).status, 404, "someone else's subscription");
  const m = ok(await call('POST', '/payments/mandates', { token: athlete.token, body: { subject_kind: 'coach_subscription', subject_id: subscriptionId } }), 201);
  assert.match(m.authorisation_url, /^https:\/\/rzp\.test\/mandate\/sub_/);
  assert.equal((await call('POST', '/payments/mandates', { token: athlete.token, body: { subject_kind: 'coach_subscription', subject_id: subscriptionId } })).status, 409, 'one live mandate per subscription');
  const ref = (await pool.query('SELECT provider_ref FROM payment_mandates WHERE id=$1', [m.id])).rows[0].provider_ref;
  await hook({ event: 'subscription.activated', payload: { subscription: { entity: { id: ref } } } });
  assert.equal(ok(await call('GET', '/payments/mandates', { token: athlete.token }))[0].status, 'active');
  // the provider charges period 1 (waiting for payment)
  const charge = (id) => ({ event: 'subscription.charged', payload: { subscription: { entity: { id: ref } }, payment: { entity: { id, amount: 400000, currency: 'INR', method: 'upi', status: 'captured' } } } });
  assert.equal((await hook(charge('pay_auto_1'))).status, 200);
  const periods = (await pool.query('SELECT period_no, status FROM user_plans WHERE subscription_id=$1 ORDER BY period_no', [subscriptionId])).rows;
  assert.equal(periods[0].status, 'active', 'the charge paid the waiting period through the canonical flow');
  const row = (await pool.query("SELECT status, method, purpose_type FROM payments WHERE provider_ref='pay_auto_1'")).rows[0];
  assert.deepEqual({ ...row }, { status: 'paid', method: 'upi', purpose_type: 'coach_subscription_period' });
  await hook(charge('pay_auto_1'));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM payments WHERE provider_ref='pay_auto_1'")).rows[0].n, 1, 'a replayed charge never pays twice');
  // a charge with no period waiting is an exception for the platform team, not a guess
  await hook(charge('pay_auto_stray'));
  const ex = await pool.query("SELECT kind FROM settlement_exceptions WHERE dedupe_key='mandate_charge:pay_auto_stray'");
  assert.equal(ex.rows[0]?.kind, 'mandate_charge_unmatched');
  const cancelled = ok(await call('POST', `/payments/mandates/${m.id}/cancel`, { token: athlete.token, body: {} }));
  assert.equal(cancelled.status, 'cancelled'); assert.ok(fake.cancelled.includes(ref));
  await syncCoachSubscriptions();
});

test('settlement reconciliation: matches payments and refunds, flags unknown, mismatched and unrecorded lines, admin only, safe to rerun', async () => {
  const token = await boss(); const u = await signup('recon_payer');
  const t = await topup(u);
  const c = ok(await payUpi(u, t.id, { flow: 'collect', vpa: 'sita@okbank', contact: '9876543210' }), 201);
  const pay = Object.values(fake.payments).find((p) => p.body.vpa === 'sita@okbank'); pay.status = 'captured';
  ok(await call('POST', `/payments/${c.id}/confirm`, { token: u.token, body: {} }));
  const day = new Date().toISOString().slice(0, 10);
  const at = Math.floor(Date.now() / 1000);
  fake.recon = [
    { entity_id: pay.id, type: 'payment', amount: 25000, currency: 'INR', fee: 590, tax: 90, credit: 24320, debit: 0, settlement_id: 'setl_1', settlement_utr: 'UTR1', settled_at: at, created_at: at },
    { entity_id: 'pay_ghost', type: 'payment', amount: 9900, currency: 'INR', fee: 200, tax: 30, credit: 9670, debit: 0, settlement_id: 'setl_1', settled_at: at, created_at: at },
    { entity_id: 'rfnd_x', type: 'refund', payment_id: pay.id, amount: 5000, currency: 'INR', fee: 0, tax: 0, credit: 0, debit: 5000, settlement_id: 'setl_1', settled_at: at, created_at: at },
    { entity_id: 'adj_1', type: 'adjustment', amount: 100, currency: 'INR', fee: 0, tax: 0, credit: 100, debit: 0, settlement_id: 'setl_1', settled_at: at, created_at: at },
  ];
  const u2 = await signup('plain2');
  assert.equal((await call('POST', '/admin/payments/reconcile', { token: u2.token, body: { from: day, to: day } })).status, 403);
  assert.equal((await call('POST', '/admin/payments/reconcile', { token, body: { from: day, to: '2099-01-01' } })).status, 400);
  const out = ok(await call('POST', '/admin/payments/reconcile', { token, body: { from: day, to: day } }));
  assert.deepEqual(out, { days: 1, settlements: 1, items: 4, flagged: 2 });   // ghost payment + refund we never recorded
  const kinds = (await pool.query("SELECT kind FROM settlement_exceptions WHERE dedupe_key LIKE 'settle_%' ORDER BY kind")).rows.map((r) => r.kind);
  assert.deepEqual(kinds, ['settlement_refund_unrecorded', 'settlement_unknown_payment']);
  const list = ok(await call('GET', '/admin/payments/settlements', { token }));
  assert.equal(list[0].provider_ref, 'setl_1'); assert.equal(Number(list[0].fees_minor), 790); assert.equal(Number(list[0].items_flagged), 2);
  const one = ok(await call('GET', `/admin/payments/settlements/${list[0].id}`, { token }));
  assert.deepEqual(one.items.map((i) => i.match).sort(), ['info', 'matched', 'refund_unrecorded', 'unknown_payment']);
  ok(await call('POST', '/admin/payments/reconcile', { token, body: { from: day, to: day } }));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM provider_settlement_items")).rows[0].n, 4, 'a rerun adds nothing');
  // an amount that differs is flagged
  fake.recon = [{ entity_id: pay.id, type: 'payment', amount: 24000, currency: 'INR', fee: 0, tax: 0, credit: 24000, debit: 0, settlement_id: 'setl_2', settled_at: at, created_at: at }];
  assert.equal(ok(await call('POST', '/admin/payments/reconcile', { token, body: { from: day, to: day } })).flagged, 1);
  assert.ok((await pool.query("SELECT 1 FROM settlement_exceptions WHERE kind='settlement_amount_mismatch'")).rowCount === 1);
});
