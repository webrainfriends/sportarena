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
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `ho_${n}_${roles[0]}`, display_name: `Appt ${n}`, email: `ho${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
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


test('offers: quote = charge, best single offer, codes, limits, validity, archive keeps booked discount', async () => {
  const doc = await provider('physio', { consult_fee_cents: 0 });
  const ath = await signup(), ath2 = await signup();
  const svc = must(await api('POST', '/me/provider-services', { token: doc.token, body: { title: 'Follow-up', price_cents: 100000, currency: 'INR' } }));
  const offer = (body) => api('POST', '/me/provider-offers', { token: doc.token, body });
  const q = (token, extra = {}) => api('GET', `/providers/${doc.id}/quote`, { token, query: { service_id: svc.id, ...extra } });

  assert.equal((await api('POST', '/me/provider-offers', { token: ath.token, body: { title: 'abc', kind: 'percent', percent: 10 } })).status, 403);
  assert.equal((await offer({ title: 'bad', kind: 'fixed', amount_cents: 5 })).status, 400, 'fixed needs a currency');
  assert.equal(must(await q(ath.token)).total_cents, 100000, 'no offer yet');

  const auto = must(await offer({ title: 'Launch 10%', kind: 'percent', percent: 10 }));
  const code = must(await offer({ title: 'Code 150', code: 'save150', kind: 'fixed', amount_cents: 15000, currency: 'INR', per_user_limit: 1, max_redemptions: 2 }));
  assert.equal((await offer({ title: 'dup', code: 'SAVE150', kind: 'percent', percent: 5 })).status, 400, 'codes are unique per provider');
  assert.deepEqual([must(await q(ath.token)).discount_cents, must(await q(ath.token)).offer.title], [10000, 'Launch 10%']);
  const withCode = must(await q(ath.token, { offer_code: 'SAVE150' }));
  assert.deepEqual([withCode.discount_cents, withCode.total_cents, withCode.offer.title], [15000, 85000, 'Code 150'], 'best single offer wins, no stacking');
  assert.equal((await q(ath.token, { offer_code: 'NOPE' })).status, 400, 'a wrong code is an error, not ignored');

  const a = must(await book(ath, doc, 5, { service_id: svc.id, offer_code: 'save150' }), 201);
  assert.deepEqual([a.fee_cents, a.list_price_cents, a.discount_cents, a.offer_title], [85000, 100000, 15000, 'Code 150']);
  assert.equal((await q(ath.token, { offer_code: 'SAVE150' })).status, 400, 'per-user limit');
  // concurrent bookings by two other people against the last redemption: only one gets it
  const ath3 = await signup();
  const rs = await Promise.all([book(ath2, doc, 6, { service_id: svc.id, offer_code: 'SAVE150' }), book(ath3, doc, 7, { service_id: svc.id, offer_code: 'SAVE150' }), book(await signup(), doc, 8, { service_id: svc.id, offer_code: 'SAVE150' })]);
  assert.equal(rs.filter((r) => r.status === 201).length, 1, JSON.stringify(rs.map((r) => r.status)));
  // cancelling frees the redemption
  must(await api('PATCH', `/appointments/${a.id}`, { token: ath.token, body: { status: 'cancelled' } }));
  assert.equal(must(await api('GET', '/me/provider-offers', { token: doc.token })).find((o) => o.id === code.id).used, 1);

  // archive: no longer applies, booked discount stays
  must(await api('POST', `/me/provider-offers/${auto.id}/archive`, { token: doc.token }));
  assert.equal(must(await q(ath3.token)).discount_cents, 0);
  assert.equal((await pool.query('SELECT amount_cents FROM provider_offer_redemptions WHERE appointment_id=$1', [a.id])).rows[0].amount_cents, 15000);
  // expired offers do not apply
  must(await offer({ title: 'Old', kind: 'percent', percent: 50, valid_from: new Date(Date.now() - 2 * 864e5).toISOString(), valid_to: new Date(Date.now() - 864e5).toISOString() }));
  assert.equal(must(await q(ath3.token)).discount_cents, 0);
  assert.equal((await book(ath3, doc, 9, { offer_code: 'SAVE150' })).status, 400, 'codes need a service');
});
