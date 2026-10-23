// Termination refunds of ONLINE sponsorship money (#298): refunded at the provider once, only after the recipient approves.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';

// stand-in for Stripe Checkout + refunds (the real provider needs real keys)
const fake = { sessions: {}, refunds: [], n: 0 };
const stripe = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString(), send = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
  if (req.url === '/v1/checkout/sessions' && req.method === 'POST') {
    const f = new URLSearchParams(raw); const id = `cs_${++fake.n}`;
    fake.sessions[id] = { id, amount_total: Number(f.get('line_items[0][price_data][unit_amount]')), currency: f.get('line_items[0][price_data][currency]'), payment_status: 'unpaid', payment_intent: `pi_${fake.n}` };
    return send(200, { id, url: `https://checkout.stripe.test/${id}` });
  }
  if (req.url.startsWith('/v1/checkout/sessions/')) { const s = fake.sessions[req.url.split('/').pop()]; return s ? send(200, s) : send(404, { error: { message: 'no such session' } }); }
  if (req.url === '/v1/refunds') { fake.refunds.push(new URLSearchParams(raw).get('payment_intent')); return send(200, { id: 're_1' }); }
  send(404, {});
});
await new Promise((r) => stripe.listen(0, '127.0.0.1', r));
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test',
  STRIPE_API_BASE: `http://127.0.0.1:${stripe.address().port}`, APP_URL: 'http://app.test', CORS_ORIGINS: 'http://app.test',
  PROVIDER_COMMISSION_BP: '1000', SETTLEMENT_PAYOUTS: 'on', SETTLEMENT_CURRENCIES: 'INR', PAYMENT_CURRENCY: 'INR',
});
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `sc_${n}_${roles[0]}`, display_name: `Checkout ${n}`, email: `sc${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const mkAdmin = async (h) => { const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ($1,$1,'{admin}','x','x',$1) RETURNING id", [h])).rows[0]; return { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) }; };
const stripeSig = (payload, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', 'whsec_test').update(`${t}.${payload}`).digest('hex')}`;
const hook = (event) => { const body = JSON.stringify(event); return fetch(`${base}/api/v1/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': stripeSig(body), 'content-type': 'application/json' }, body }); };
const payoutAccount = async (u) => { const a = must(await api('POST', '/me/payout-accounts', { token: u.token, body: { currency: 'INR', holder_name: 'Test Recipient', account_number: '123456789012', bank_code: 'HDFC0001234' } }), 201); must(await api('POST', `/admin/payout-accounts/${a.id}/decision`, { token: admin.token, body: { decision: 'verify', reason: 'Holder name matches the profile' } })); };
const period = { starts_on: '2030-01-01', ends_on: '2030-06-30' };

/** an accepted agreement with one INR due of 1000.00; `onboarded` = the recipient has a verified payout account */
const world = async ({ onboarded = true } = {}) => {
  const sponsor = await signup(['sponsor']), ath = await signup(['athlete']);
  const b = must(await api('POST', '/sponsors', { token: sponsor.token, body: { name: `CoBrand${n}` } }), 201);
  must(await api('POST', '/me/sponsorship-profile', { token: ath.token, body: { open_to_sponsors: true } }));
  const line = { kind: 'money', label: 'Season support', currency: 'INR', amount_cents: 100000, cadence: 'once', first_due_on: '2030-01-15' };
  const deal = must(await api('POST', '/sponsorships', { token: sponsor.token, body: { sponsor_id: b.id, target_type: 'athlete', target_id: ath.id, deliverables: 'Wear the kit', ...period, lines: [line] } }), 201);
  must(await api('PATCH', `/sponsorships/${deal.id}`, { token: ath.token, body: { status: 'active', version: deal.terms_version } }));
  const due = must(await api('GET', '/sponsorship-obligations', { token: ath.token, query: { sponsorship_id: deal.id } })).obligations[0];
  if (onboarded) await payoutAccount(ath);
  return { sponsor, ath, deal, due };
};
const checkout = (w, body = {}, who = w.sponsor) => api('POST', `/sponsorship-obligations/${w.due.id}/checkout`, { token: who.token, body: { provider: 'stripe', ...body } });
const paySession = (url) => { const sid = url.split('/').pop(); fake.sessions[sid].payment_status = 'paid'; return sid; };
const dueOf = async (w) => must(await api('GET', `/sponsorships/${w.deal.id}`, { token: w.sponsor.token })).obligations[0];
const recon = async (u, q = {}) => must(await api('GET', '/sponsorship-reconciliation', { token: u.token, query: q }));
const ledger = async (sellerId) => (await pool.query("SELECT kind, amount_cents, gross_cents FROM provider_ledger WHERE seller_id=$1 AND purpose_type='sponsorship_payment' ORDER BY id", [sellerId])).rows;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  admin = await mkAdmin('sc_root');
});
after(async () => { server.close(); stripe.close(); await pool.end(); });

test('an online payment is refunded at the provider once, only after approval; the due stays settled and the books reconcile', async () => {
  const w = await world();
  const co = must(await checkout(w), 201);
  paySession(co.checkout_url);
  must(await api('POST', `/payments/${co.id}/confirm`, { token: w.sponsor.token }));
  const sp = (await dueOf(w)).payments[0];
  const nt = must(await api('POST', `/sponsorships/${w.deal.id}/termination`, { token: w.sponsor.token, body: { reason_code: 'mutual', effective_on: new Date().toISOString().slice(0, 10), expected_version: 1 } }), 201).termination;
  const r = must(await api('POST', `/sponsorship-terminations/${nt.id}/refunds`, { token: w.sponsor.token, body: { sponsorship_payment_id: sp.id, amount_cents: 40000 } }), 201);
  const before = fake.refunds.length;
  const ok = must(await api('PATCH', `/sponsorship-refunds/${r.id}`, { token: w.ath.token, body: { status: 'approved' } }));
  assert.equal(ok.status, 'refunded', JSON.stringify(ok));
  assert.equal(fake.refunds.length, before + 1, 'one provider refund, made only after approval');
  const due = await dueOf(w);
  assert.equal(due.refunded_cents, 40000); assert.equal(due.confirmed_cents, 60000);
  assert.equal(due.status, 'fulfilled', 'conceded: the refund does not re-open the due');
  assert.equal((await api('PATCH', `/sponsorship-refunds/${r.id}`, { token: w.sponsor.token, body: { status: 'refunded' } })).status, 409, 'retrying a finished refund changes nothing');
  assert.equal(fake.refunds.length, before + 1, 'still one provider refund');
  const rec = must(await api('GET', '/sponsorship-reconciliation', { token: w.sponsor.token, query: { sponsorship_id: w.deal.id } }));
  assert.equal(rec[0].refunded_cents, 40000); assert.equal(rec[0].ledger.refund_cents, 40000); assert.equal(rec[0].reconciles, true);
});
