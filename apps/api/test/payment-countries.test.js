// Country-wise payment switch (#694): only the platform admin can turn a payment method on or off per country, a country with no switch
// has everything off, and every checkout is offered (and enforced) only for methods that are on. Also: Razorpay (UPI) end to end against a
// local stand-in, its signature-verified webhook (replay-safe), and the India GST split. Every test creates its own people and data.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';

const fake = { links: {}, refunds: [], n: 0 };
const provider = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.url === '/v1/payment_links' && req.method === 'POST') {
    const b = JSON.parse(raw); const id = `plink_${++fake.n}`;
    fake.links[id] = { id, amount: b.amount, currency: b.currency, amount_paid: 0, status: 'created', short_url: `https://rzp.test/${id}`, reference_id: b.reference_id, payments: [] };
    return send(200, fake.links[id]);
  }
  if (req.url.startsWith('/v1/payment_links/')) { const l = fake.links[req.url.split('/').pop()]; return l ? send(200, l) : send(404, { error: { description: 'no such link' } }); }
  const rf = req.url.match(/^\/v1\/payments\/(\w+)\/refund$/);
  if (rf) { fake.refunds.push({ payment: rf[1], ...JSON.parse(raw) }); return send(200, { id: 'rfnd_1' }); }
  send(404, {});
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
Object.assign(process.env, {
  RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 'secret', RAZORPAY_WEBHOOK_SECRET: 'whsec_rzp', RAZORPAY_API_BASE: `http://127.0.0.1:${provider.address().port}`,
  APP_URL: 'http://app.test', CORS_ORIGINS: 'http://app.test', PLATFORM_ADMIN_EMAILS: 'rraja.edge@gmail.com,rrajas1978@icloud.com',
});
delete process.env.STRIPE_SECRET_KEY; delete process.env.PAYPAL_CLIENT_ID;
const { pool, start, stop, call, ok, signup } = await import('./tender-helpers.js');
const { gstBreakup, validGstin, gstinCheckDigit } = await import('../src/gst.js');
const { refreshCountryMethods } = await import('../src/payments/countries.js');

before(start);
after(async () => { provider.close(); await stop(); });

let admin;
const adminToken = async () => {
  if (admin) return admin;
  const reg = ok(await call('POST', '/auth/register', { body: { handle: 'pay_boss', display_name: 'boss', email: 'rraja.edge@gmail.com', password: 'correct-horse-battery', roles: ['athlete'] } }), 201);
  await pool.query("UPDATE users SET roles = '{athlete,admin,platform_admin}' WHERE id = $1", [reg.user.id]);
  admin = ok(await call('POST', '/auth/login', { body: { email: 'rraja.edge@gmail.com', password: 'correct-horse-battery' } })).token;
  return admin;
};
const topup = async (u, currency = 'INR') => ok(await call('POST', '/me/wallet/topups', { token: u.token, body: { currency, amount_cents: 50000 } }), 201);
const pay = (u, topupId, body = {}) => call('POST', '/payments', { token: u.token, body: { purpose_type: 'wallet_topup', purpose_id: topupId, provider: 'razorpay', return_url: 'http://app.test/', ...body } });
const sign = (raw) => createHmac('sha256', 'whsec_rzp').update(raw).digest('hex');

test('only the platform admin can read or change the switches (others get 403, not a hint)', async () => {
  const boss = await adminToken();
  const u = await signup('plain');
  assert.equal((await call('GET', '/admin/payments/countries', { token: u.token })).status, 403);
  assert.equal((await call('PATCH', '/admin/payments/countries/IN/methods/upi', { token: u.token, body: { enabled: true } })).status, 403);
  assert.equal((await call('GET', '/admin/payments/countries')).status, 401);
  const r = ok(await call('GET', '/admin/payments/countries?country=IN', { token: boss }));
  assert.equal(r.countries[0].methods.length, 5);
});

test('a country with no switch has every method off; the admin turns UPI on and it is offered, then off again', async () => {
  const boss = await adminToken();
  const u = await signup('payer');
  const t = await topup(u);
  // India starts with card and PayPal on (kept from before), UPI off
  let m = ok(await call('GET', '/payments/methods?country=IN', { token: u.token }));
  assert.ok(!m.methods.includes('upi'));
  const denied = await pay(u, t.id, { method: 'upi' });
  assert.equal(denied.status, 409, JSON.stringify(denied.body));
  ok(await call('PATCH', '/admin/payments/countries/IN/methods/upi', { token: boss, body: { enabled: true } }));
  m = ok(await call('GET', '/payments/methods?country=IN', { token: u.token }));
  assert.ok(m.methods.includes('upi') && m.providers.includes('razorpay'));
  // an untouched country offers nothing at all
  const none = ok(await call('GET', '/payments/methods?country=NZ', { token: u.token }));
  assert.deepEqual(none.methods, []);
  assert.deepEqual(none.providers, []);
  assert.equal((await pay(u, t.id, { country: 'NZ', method: 'upi' })).status, 409);
  const audit = await pool.query("SELECT 1 FROM audit_log WHERE action = 'payment_method_enable:IN:upi'");
  assert.equal(audit.rowCount, 1);
});

test('UPI via Razorpay end to end: signed webhook settles once, a replay is a no-op, a bad signature is refused, refund reaches the provider', async () => {
  const boss = await adminToken();
  ok(await call('PATCH', '/admin/payments/countries/IN/methods/upi', { token: boss, body: { enabled: true } }));
  const u = await signup('upi_payer');
  const t = await topup(u);
  const p = ok(await pay(u, t.id, { method: 'upi' }), 201);
  assert.equal(p.provider, 'razorpay'); assert.equal(p.method, 'upi'); assert.equal(p.country, 'IN');
  const link = fake.links[p.checkout_url.split('/').pop()];
  assert.equal(link.currency, 'INR'); assert.equal(link.amount, 50000);
  // provider says paid
  Object.assign(link, { status: 'paid', amount_paid: 50000, payments: [{ payment_id: 'pay_1', status: 'captured', method: 'upi' }] });
  const raw = JSON.stringify({ event: 'payment_link.paid', payload: { payment_link: { entity: link } } });
  const hook = (body, sig, id = 'evt_1') => call('POST', '/webhooks/razorpay', { raw: body, headers: { 'content-type': 'application/json', 'x-razorpay-signature': sig, 'x-razorpay-event-id': id } });
  assert.equal((await hook(raw, 'deadbeef')).status, 400);
  assert.equal((await hook(raw, sign(raw))).status, 200);
  const row = (await pool.query('SELECT status, provider_payment_ref, method FROM payments WHERE id=$1', [p.id])).rows[0];
  assert.deepEqual({ ...row }, { status: 'paid', provider_payment_ref: 'pay_1', method: 'upi' });
  const again = await hook(raw, sign(raw));
  assert.equal(again.body.duplicate, true);
  const bal = (await pool.query("SELECT balance_cents FROM wallet_accounts WHERE user_id=$1 AND currency='INR'", [u.id])).rows[0];
  assert.equal(Number(bal.balance_cents), 50000);   // credited once, not twice
  const { refundPartial } = await import('../src/payments/service.js');
  const payment = (await pool.query('SELECT * FROM payments WHERE id=$1', [p.id])).rows[0];
  assert.equal(await refundPartial(payment, 20000, 'k1'), 20000);
  assert.equal(fake.refunds.at(-1).payment, 'pay_1'); assert.equal(fake.refunds.at(-1).amount, 20000);
  assert.equal(Number((await pool.query('SELECT refunded_cents FROM payments WHERE id=$1', [p.id])).rows[0].refunded_cents), 20000);
});

test('switching a method off stops new checkouts without touching existing payments', async () => {
  const boss = await adminToken();
  ok(await call('PATCH', '/admin/payments/countries/IN/methods/upi', { token: boss, body: { enabled: false } }));
  const u = await signup('late_payer');
  const t = await topup(u);
  assert.equal((await pay(u, t.id, { method: 'upi' })).status, 409);
  const kept = await pool.query("SELECT count(*)::int AS n FROM payments WHERE status='paid'");
  assert.ok(kept.rows[0].n >= 1);
  await refreshCountryMethods();
});

test('GST: intra-state splits CGST/SGST, inter-state charges IGST, parts always add up', () => {
  const intra = gstBreakup({ amount_cents: 11800, rate_bp: 1800, inclusive: true, supplier_state: '27', place_of_supply: '27' });
  assert.deepEqual([intra.taxable_cents, intra.cgst_cents, intra.sgst_cents, intra.igst_cents, intra.total_cents], [10000, 900, 900, 0, 11800]);
  const inter = gstBreakup({ amount_cents: 10000, rate_bp: 1800, inclusive: false, supplier_state: '27', place_of_supply: '29' });
  assert.deepEqual([inter.taxable_cents, inter.cgst_cents, inter.sgst_cents, inter.igst_cents, inter.total_cents], [10000, 0, 0, 1800, 11800]);
  const odd = gstBreakup({ amount_cents: 10001, rate_bp: 500, inclusive: false, supplier_state: '07', place_of_supply: '07' });
  assert.equal(odd.cgst_cents + odd.sgst_cents, odd.tax_cents);
  const base = '27AAPFU0939F1Z';
  assert.ok(validGstin(base + gstinCheckDigit(base)));
  assert.ok(!validGstin('27AAPFU0939F1Z0') || gstinCheckDigit(base) === '0');
});
