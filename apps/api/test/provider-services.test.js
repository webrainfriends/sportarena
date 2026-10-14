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
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `hs_${n}_${roles[0]}`, display_name: `Appt ${n}`, email: `hs${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
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


test('services catalogue: price versions, snapshot at booking, archive keeps history, ownership and mode checks', async () => {
  const doc = await provider('physio', { consult_fee_cents: 0, remote_ok: true });
  const ath = await signup(), other = await provider('physio');
  const svc = must(await api('POST', '/me/provider-services', { token: doc.token, body: { title: 'Initial assessment', duration_min: 45, price_cents: 90000, tax_class: 'exempt', delivery_modes: ['in_person'], cancellation_policy: '24h notice' } }));
  assert.deepEqual([svc.price_cents, svc.tax_class, svc.duration_min], [90000, 'exempt', 45]);
  assert.equal((await api('POST', '/me/provider-services', { token: ath.token, body: { title: 'x y', price_cents: 1 } })).status, 403, 'athletes cannot publish services');
  assert.equal(must(await api('GET', `/providers/${doc.id}/services`)).length, 1, 'public listing');

  const a = must(await book(ath, doc, 5, { service_id: svc.id }), 201);
  assert.deepEqual([a.fee_cents, a.duration_min, a.service_title, a.payment_status], [90000, 45, 'Initial assessment', 'unpaid']);
  assert.equal((await book(ath, doc, 6, { service_id: svc.id, mode: 'remote' })).status, 400, 'service is in person only');
  assert.equal((await book(ath, other, 6, { service_id: svc.id })).status, 400, "another provider's service");

  // a price change is a new version: the existing appointment keeps its fee
  const upd = must(await api('POST', '/me/provider-services', { token: doc.token, body: { id: svc.id, title: 'Initial assessment', duration_min: 45, price_cents: 120000, tax_class: 'exempt', delivery_modes: ['in_person'] } }));
  assert.equal(upd.price_cents, 120000);
  const mine = must(await api('GET', '/me/provider-services', { token: doc.token }));
  assert.equal(mine[0].price_history.length, 2);
  const row = (await pool.query('SELECT fee_cents, tax_class, cancellation_policy, service_price_id FROM appointments WHERE id=$1', [a.id])).rows[0];
  assert.deepEqual([Number(row.fee_cents), row.tax_class, row.cancellation_policy, row.service_price_id === svc.price_id], [90000, 'exempt', '24h notice', true]);
  assert.equal(must(await book(ath, doc, 7, { service_id: svc.id }), 201).fee_cents, 120000);

  // archive: no longer bookable or listed, history kept
  must(await api('POST', `/me/provider-services/${svc.id}/archive`, { token: doc.token }));
  assert.equal((await api('POST', `/me/provider-services/${svc.id}/archive`, { token: other.token })).status, 404);
  assert.equal(must(await api('GET', `/providers/${doc.id}/services`)).length, 0);
  assert.equal((await book(ath, doc, 8, { service_id: svc.id })).status, 400);
  assert.equal(Number((await pool.query('SELECT count(*) FROM provider_service_prices WHERE service_id=$1', [svc.id])).rows[0].count), 2);

  // legacy booking without a service still works from the consultation fee
  assert.equal(must(await book(ath, doc, 9), 201).service_id, null);
});
