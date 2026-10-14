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
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `tx_${n}_${roles[0]}`, display_name: `Appt ${n}`, email: `tx${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
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

test('tax profile + revenue report: configured rates only, inclusive maths, per currency, billed vs collected, rate changes not retroactive', async () => {
  const doc = await provider('physio', { consult_fee_cents: 0 });
  const ath = await signup();
  const svc = async (title, price, tax_class) => must(await api('POST', '/me/provider-services', { token: doc.token, body: { title, price_cents: price, currency: 'INR', tax_class } }));
  const taxable = await svc('Taxable visit', 11800, 'taxable'), exempt = await svc('Exempt visit', 5000, 'exempt'), plain = await svc('Unclassified', 3000, 'unspecified');
  const rep = (query = {}) => api('GET', '/me/practice-report', { token: doc.token, query: { from: day(0), to: day(30), ...query } });
  assert.equal((await api('GET', '/me/practice-report', { token: ath.token, query: { from: day(0), to: day(1) } })).status, 403);
  assert.equal((await api('POST', '/me/tax-profile', { token: doc.token, body: { legal_name: 'Dr X Physio', jurisdiction: 'IN', registration_status: 'registered' } })).status, 400, 'registered needs a number');
  // unpaid: payment is required before confirm, so settle the appointments directly (payment flow itself is covered elsewhere)
  const mk = async (s, d) => { const a = must(await book(ath, doc, d, { service_id: s.id }), 201); await pool.query("UPDATE appointments SET payment_status='paid', status='confirmed' WHERE id=$1", [a.id]); return a; };
  const a1 = await mk(taxable, 3), a2 = await mk(exempt, 4), a3 = await mk(plain, 5);

  // no profile / no rate: nothing is invented
  let r = must(await rep());
  assert.deepEqual(r.groups.map((g) => [g.tax_class, g.gross_cents, g.tax_cents]).sort(), [['exempt', 5000, 0], ['taxable', 11800, 0], ['unspecified', 3000, 0]]);
  assert.equal(r.groups.find((g) => g.tax_class === 'taxable').untaxed_taxable_lines, 1, 'flags taxable lines without a registration/rate');

  must(await api('POST', '/me/tax-profile', { token: doc.token, body: { legal_name: 'Dr X Physio', jurisdiction: 'IN', registration_status: 'registered', registration_id: 'TAX-12345', effective_from: new Date(Date.now() - 864e5).toISOString() } }));
  assert.equal((await api('POST', '/me/tax-rates', { token: doc.token, body: { rate_percent: 18, source: 'x' } })).status, 400, 'source is required');
  must(await api('POST', '/me/tax-rates', { token: doc.token, body: { rate_percent: 18, source: 'Notice 12/2026 (as read by my advisor)', effective_from: new Date(Date.now() - 864e5).toISOString() } }));
  const prof = must(await api('GET', '/me/tax-profile', { token: doc.token }));
  assert.deepEqual([prof.current.registration_id, prof.rates.length], ['TAX-12345', 1]);
  assert.ok(!(await pool.query('SELECT registration_id_enc FROM provider_tax_profiles')).rows[0].registration_id_enc.includes('12345'), 'registration number encrypted');

  r = must(await rep());
  const t = r.groups.find((g) => g.tax_class === 'taxable');
  assert.deepEqual([t.gross_cents, t.tax_cents, t.net_cents], [11800, 1800, 10000], '118.00 inclusive of 18% = 100.00 + 18.00');
  assert.equal(r.groups.find((g) => g.tax_class === 'exempt').tax_cents, 0);
  assert.equal(r.groups.length, 3);
  assert.ok(r.groups.every((g) => g.gross_cents === g.net_cents + g.tax_cents), 'net + tax = gross');

  // a later rate change does not rewrite earlier appointments (they were created before it)
  must(await api('POST', '/me/tax-rates', { token: doc.token, body: { rate_percent: 5, source: 'Notice 99/2027 (future)', effective_from: new Date(Date.now() + 864e5).toISOString() } }));
  assert.equal(must(await rep()).groups.find((g) => g.tax_class === 'taxable').tax_cents, 1800);

  // collected basis: only paid payments, net of refunds
  assert.equal(must(await rep({ basis: 'collected' })).groups.length, 0, 'nothing collected through the payment flow yet');
  const pid = (await pool.query("INSERT INTO payments(payer_id, provider, purpose_type, purpose_id, amount_cents, currency, status, paid_at, refunded_cents) VALUES ($1,'stripe','appointment',$2,11800,'INR','paid',now(),5900) RETURNING id", [ath.id, a1.id])).rows[0].id;
  const c = must(await rep({ basis: 'collected' })).groups[0];
  assert.deepEqual([c.gross_cents, c.refunded_cents, c.tax_cents, c.net_cents], [5900, 5900, 900, 5000], 'partial refund halves the tax');
  assert.equal((await rep({ from: day(30), to: day(0) })).status, 400);
  assert.ok(pid && a2 && a3);
});
