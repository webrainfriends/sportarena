import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// stand-in for Stripe Checkout + refunds
const fake = { sessions: {}, refunds: [], n: 0 };
const stripe = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString(), send = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
  if (req.url === '/v1/checkout/sessions' && req.method === 'POST') {
    const f = new URLSearchParams(raw); const id = `cs_${++fake.n}`;
    fake.sessions[id] = { id, amount_total: Number(f.get('line_items[0][price_data][unit_amount]')), currency: f.get('line_items[0][price_data][currency]'), name: f.get('line_items[0][price_data][product_data][name]'), payment_status: 'unpaid', payment_intent: `pi_${fake.n}` };
    return send(200, { id, url: `https://checkout.stripe.test/${id}` });
  }
  if (req.url.startsWith('/v1/checkout/sessions/')) { const s = fake.sessions[req.url.split('/').pop()]; return s ? send(200, s) : send(404, { error: { message: 'no such session' } }); }
  if (req.url === '/v1/refunds') { fake.refunds.push(new URLSearchParams(raw).get('payment_intent')); return send(200, { id: 're_1' }); }
  send(404, {});
});
await new Promise((r) => stripe.listen(0, '127.0.0.1', r));
Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_API_BASE: `http://127.0.0.1:${stripe.address().port}`, APP_URL: 'http://app.test', CORS_ORIGINS: 'http://app.test' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { queueHealthReminders } = await import('../src/notify.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `hp_${n}_${roles[0]}`, display_name: `Appt ${n}`, email: `hp${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const provider = async (role = 'physio', profile = {}) => {
  const u = await signup([role]);
  must(await api('POST', '/me/sport-profiles', { token: u.token, body: { sport: 'football', role } }), 201);
  must(await api('POST', '/me/provider-profile', { token: u.token, body: { provider_type: role, ...profile } }));
  await pool.query("INSERT INTO verification_cases(type, subject_type, subject_id, requested_by, status, rules_version, decided_at, expires_at) VALUES ($1,'user',$2,$2,'approved',1,now(), now() + interval '300 days')", [role, u.id]);
  return u;
};
const at = (days, hour = 10) => { const d = new Date(Date.now() + days * 864e5); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };
const day = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const book = (ath, doc, days = 5, extra = {}) => api('POST', '/appointments', { token: ath.token, body: { provider_id: doc.id, starts_at: at(days), reason: 'private knee problem', ...extra } });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); stripe.close(); await pool.end(); });


test('packages: buy, pay, redeem atomically, expiry, cancel gives the session back', async () => {
  const doc = await provider('physio', { consult_fee_cents: 0 });
  const ath = await signup(), ath2 = await signup();
  const svc = must(await api('POST', '/me/provider-services', { token: doc.token, body: { title: 'Rehab session', price_cents: 50000, currency: 'INR' } }));
  const other = must(await api('POST', '/me/provider-services', { token: doc.token, body: { title: 'Assessment', price_cents: 80000, currency: 'INR' } }));
  assert.equal((await api('POST', '/me/provider-packages', { token: doc.token, body: { service_id: svc.id, title: 'x', sessions: 1, price_cents: 1 } })).status, 400, 'at least 2 sessions');
  const pkg = must(await api('POST', '/me/provider-packages', { token: doc.token, body: { service_id: svc.id, title: '3 rehab sessions', sessions: 3, price_cents: 120000, valid_days: 30, refund_terms: 'Unused sessions refundable within 7 days' } }));
  assert.equal(must(await api('GET', `/providers/${doc.id}/packages`)).length, 1);

  const mine = must(await api('POST', `/provider-packages/${pkg.id}/buy`, { token: ath.token }), 201);
  assert.equal(mine.status, 'awaiting_payment');
  assert.equal((await book(ath, doc, 5, { service_id: svc.id, patient_package_id: mine.id })).status, 409, 'unpaid package cannot be spent');
  const pay = must(await api('POST', '/payments', { token: ath.token, body: { purpose_type: 'physio_package', purpose_id: mine.id, provider: 'stripe' } }), 201);
  assert.equal(pay.amount_cents, 120000);
  assert.ok(!/rehab|knee/i.test(JSON.stringify(fake.sessions[pay.checkout_url.split('/').pop()]).replace(/Session package with[^"]*/, '')), 'no clinical detail at the payment provider');
  assert.equal((await api('POST', '/payments', { token: ath2.token, body: { purpose_type: 'physio_package', purpose_id: mine.id, provider: 'stripe' } })).status, 403, 'only the buyer pays');
  fake.sessions[pay.checkout_url.split('/').pop()].payment_status = 'paid';
  assert.equal(must(await api('POST', `/payments/${pay.id}/confirm`, { token: ath.token })).status, 'paid');
  let p = must(await api('GET', '/me/packages', { token: ath.token }))[0];
  assert.deepEqual([p.status, p.sessions_left, !!p.expires_at], ['active', 3, true]);

  assert.equal((await book(ath2, doc, 5, { service_id: svc.id, patient_package_id: mine.id })).status, 404, "someone else's package");
  assert.equal((await book(ath, doc, 5, { service_id: other.id, patient_package_id: mine.id })).status, 400, 'wrong service');
  const a1 = must(await book(ath, doc, 5, { service_id: svc.id, patient_package_id: mine.id }), 201);
  assert.deepEqual([a1.fee_cents, a1.payment_status, a1.patient_package_id], [0, 'not_required', mine.id]);
  // three concurrent redemptions with two sessions left: exactly two succeed
  const rs = await Promise.all([6, 7, 8].map((d) => book(ath, doc, d, { service_id: svc.id, patient_package_id: mine.id })));
  assert.equal(rs.filter((r) => r.status === 201).length, 2, JSON.stringify(rs.map((r) => r.status)));
  assert.equal(must(await api('GET', '/me/packages', { token: ath.token }))[0].sessions_left, 0);
  assert.equal((await book(ath, doc, 9, { service_id: svc.id, patient_package_id: mine.id })).status, 409, 'used up');
  // cancelling gives the session back
  must(await api('PATCH', `/appointments/${a1.id}`, { token: ath.token, body: { status: 'cancelled' } }));
  assert.equal(must(await api('GET', '/me/packages', { token: ath.token }))[0].sessions_left, 1);
  // expiry
  await pool.query("UPDATE patient_packages SET expires_at = now() - interval '1 day' WHERE id=$1", [mine.id]);
  assert.equal((await book(ath, doc, 9, { service_id: svc.id, patient_package_id: mine.id })).status, 409, 'expired');
  assert.equal(must(await api('GET', '/me/packages', { token: ath.token }))[0].sessions_left, 0);

  // unpaid purchases can be cancelled; archived packages are not sold but bought ones live on
  const again = must(await api('POST', `/provider-packages/${pkg.id}/buy`, { token: ath2.token }), 201);
  must(await api('POST', `/me/packages/${again.id}/cancel`, { token: ath2.token }));
  must(await api('POST', `/me/provider-packages/${pkg.id}/archive`, { token: doc.token }));
  assert.equal((await api('POST', `/provider-packages/${pkg.id}/buy`, { token: ath2.token })).status, 404);
  assert.equal(must(await api('GET', `/providers/${doc.id}/packages`)).length, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM patient_packages')).rows[0].n, 2, 'nothing deleted');
});
