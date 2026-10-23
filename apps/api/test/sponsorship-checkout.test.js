// Sponsorship checkout, payouts and reconciliation (#294): online payment of a due through the canonical payments flow, settled into the #71 ledger.
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

test('checkout success is not a payout: the due is covered only by the verified result, the recipient is credited once, and payout stays a separate step', async () => {
  const w = await world();
  const co = must(await checkout(w), 201);
  assert.equal(co.amount_cents, 100000);
  assert.equal(co.currency, 'INR');
  let due = await dueOf(w);
  assert.equal(due.confirmed_cents, 0, 'opening a checkout confirms nothing');
  assert.equal(due.checkout_in_progress_cents, 100000);
  assert.equal(due.status, 'scheduled');
  must(await api('POST', `/payments/${co.id}/confirm`, { token: w.sponsor.token }));   // not paid yet
  assert.equal((await dueOf(w)).confirmed_cents, 0, 'a redirect/confirm before the provider says paid changes nothing');

  paySession(co.checkout_url);
  const done = await Promise.all([1, 2, 3].map(() => api('POST', `/payments/${co.id}/confirm`, { token: w.sponsor.token })));   // retries racing each other
  for (const r of done) assert.equal(r.status, 200);
  const event = { id: 'evt_sc_1', type: 'checkout.session.completed', data: { object: { id: co.checkout_url.split('/').pop(), ...fake.sessions[co.checkout_url.split('/').pop()] } } };
  assert.equal((await hook(event)).status, 200);
  assert.equal((await hook(event)).status, 200, 'a replayed webhook is a no-op');
  due = await dueOf(w);
  assert.equal(due.confirmed_cents, 100000);
  assert.equal(due.status, 'fulfilled');
  assert.equal(due.payments.filter((p) => p.status === 'confirmed' && p.method === 'online').length, 1);
  const lines = await ledger(w.ath.id);
  assert.deepEqual(lines.map((l) => l.kind).sort(), ['commission', 'sale'], 'exactly one sale and one fee, however many retries');
  assert.equal(Number(lines.find((l) => l.kind === 'sale').amount_cents), 100000);
  const earn = must(await api('GET', '/me/earnings', { token: w.ath.token })).currencies.find((c) => c.currency === 'INR');
  assert.equal(earn.paid_out_cents, 0, 'collected is not paid out');
  assert.equal(earn.net_earned_cents, 90000);
  const r = (await recon(w.sponsor))[0];
  assert.equal(r.collected_online_cents, 100000);
  assert.equal(r.outstanding_cents, 0);
  assert.equal(r.reconciles, true);
  assert.equal(Number((await pool.query('SELECT count(*) FROM payments WHERE purpose_id=$1', [co.sponsorship_payment_id])).rows[0].count), 1);
});

test('the recipient must be able to be paid: no payout account means no online checkout, and the recipient is asked to add one', async () => {
  const w = await world({ onboarded: false });
  const r = await checkout(w);
  assert.equal(r.status, 409);
  assert.match(JSON.stringify(r.body), /recipient_not_onboarded/);
  assert.match(JSON.stringify(r.body), /payouts/);
  assert.equal(Number((await pool.query("SELECT count(*) FROM sponsorship_payments WHERE obligation_id=$1", [w.due.id])).rows[0].count), 0, 'nothing was reserved');
  const inbox = await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='sponsorship_payment'", [w.ath.id]);
  assert.equal(inbox.rowCount, 1);
});

test('partial payments: an instalment can be paid in parts but never beyond what is due, even concurrently', async () => {
  const w = await world();
  const first = must(await checkout(w, { amount_cents: 40000 }), 201);
  assert.equal((await checkout(w, { amount_cents: 70000 })).status, 409, 'the open checkout is reserved against the due');
  paySession(first.checkout_url);
  must(await api('POST', `/payments/${first.id}/confirm`, { token: w.sponsor.token }));
  let due = await dueOf(w);
  assert.equal(due.confirmed_cents, 40000);
  assert.equal(due.status, 'scheduled', 'part-paid is not fulfilled');
  const race = await Promise.all([checkout(w, { amount_cents: 60000 }), checkout(w, { amount_cents: 60000 }), checkout(w, { amount_cents: 60000 })]);
  assert.deepEqual(race.map((x) => x.status).sort(), [201, 409, 409], 'concurrent checkouts cannot over-reserve');
  const second = race.find((x) => x.status === 201).body;
  paySession(second.checkout_url);
  must(await api('POST', `/payments/${second.id}/confirm`, { token: w.sponsor.token }));
  due = await dueOf(w);
  assert.equal(due.confirmed_cents, 100000);
  assert.equal(due.status, 'fulfilled');
  assert.equal((await checkout(w)).status, 409, 'a covered due cannot be paid again');
  assert.equal((await ledger(w.ath.id)).filter((l) => l.kind === 'sale').length, 2);
});

test('manual reports stay unverified until the recipient confirms; online payments cannot be confirmed or reversed by hand', async () => {
  const w = await world();
  must(await api('POST', `/sponsorship-obligations/${w.due.id}/payments`, { token: w.sponsor.token, body: { amount_cents: 30000, currency: 'INR', method: 'bank_transfer', reference: 'TRX-1', paid_on: '2030-01-10' } }), 201);
  let due = await dueOf(w);
  assert.equal(due.confirmed_cents, 0);
  assert.equal(due.reported_unverified_cents, 30000);
  assert.equal((await checkout(w, { amount_cents: 80000 })).status, 409, 'reported money also counts against what can be paid online');
  const co = must(await checkout(w, { amount_cents: 70000 }), 201);
  paySession(co.checkout_url);
  must(await api('POST', `/payments/${co.id}/confirm`, { token: w.sponsor.token }));
  due = await dueOf(w);
  assert.equal(due.confirmed_cents, 70000);
  assert.equal(due.reported_unverified_cents, 30000);
  assert.equal(due.status, 'scheduled', 'unverified money never fulfils a due');
  const online = due.payments.find((p) => p.method === 'online');
  const hand = await api('PATCH', `/sponsorship-payments/${online.id}`, { token: w.ath.token, body: { status: 'reversed', note: 'nope' } });
  assert.equal(hand.status, 409);
  const sponsorConfirm = await api('PATCH', `/sponsorship-payments/${due.payments.find((p) => p.method === 'bank_transfer').id}`, { token: w.sponsor.token, body: { status: 'confirmed' } });
  assert.equal(sponsorConfirm.status, 403, 'the sponsor can never confirm its own payment');
  const r = (await recon(w.ath))[0];
  assert.equal(r.reported_unverified_cents, 30000);
  assert.equal(r.confirmed_manual_cents, 0);
});

test('refunds reopen the due, stay per currency in the ledger, and the books still reconcile', async () => {
  const w = await world();
  const co = must(await checkout(w), 201);
  paySession(co.checkout_url);
  must(await api('POST', `/payments/${co.id}/confirm`, { token: w.sponsor.token }));
  const part = must(await api('POST', `/admin/payments/${co.id}/refund`, { token: admin.token, body: { amount_cents: 25000, reason: 'Sponsor overpaid by agreement' } }));
  assert.equal(part.refunded_now, 25000);
  let due = await dueOf(w);
  assert.equal(due.confirmed_cents, 75000, 'confirmed money is net of the refund');
  assert.equal(due.refunded_cents, 25000);
  assert.equal(due.status, 'scheduled', 'a refund that uncovers the due reopens it');
  let r = (await recon(w.sponsor))[0];
  assert.equal(r.refunded_cents, 25000);
  assert.equal(r.outstanding_cents, 25000);
  assert.equal(r.ledger.refund_cents, 25000);
  assert.equal(r.reconciles, true);
  const rest = must(await api('POST', `/admin/payments/${co.id}/refund`, { token: admin.token, body: { reason: 'Agreement cancelled by both sides' } }));
  assert.equal(rest.refunded_now, 75000);
  due = await dueOf(w);
  assert.equal(due.payments.find((p) => p.method === 'online').status, 'reversed');
  r = (await recon(w.sponsor))[0];
  assert.equal(r.confirmed_cents, 0);
  assert.equal(r.reconciles, true);
  const again = must(await checkout(w), 201);   // the due can be paid again after a full refund
  assert.equal(again.amount_cents, 100000);
});

test('an abandoned or cancelled checkout frees the due, and a late provider confirmation is refunded rather than kept', async () => {
  const w = await world();
  const co = must(await checkout(w), 201);
  const x = (await dueOf(w)).payments[0];
  must(await api('POST', `/sponsorship-payments/${x.id}/cancel-checkout`, { token: w.sponsor.token }));
  assert.equal((await dueOf(w)).checkout_in_progress_cents, 0);
  assert.equal((await api('POST', `/sponsorship-payments/${x.id}/cancel-checkout`, { token: w.sponsor.token })).status, 409, 'cancelling twice is refused');
  const refundsBefore = fake.refunds.length;
  paySession(co.checkout_url);   // the sponsor completes the cancelled checkout anyway
  must(await api('POST', `/payments/${co.id}/confirm`, { token: w.sponsor.token }));
  assert.equal(fake.refunds.length, refundsBefore + 1, 'the money is handed straight back');
  const due = await dueOf(w);
  assert.equal(due.confirmed_cents, 0, 'a cancelled checkout never counts');
  assert.equal(due.status, 'scheduled');
  assert.equal((await recon(w.sponsor))[0].reconciles, true);
  // a checkout left open for hours stops reserving the due
  const open = must(await checkout(w), 201);
  await pool.query("UPDATE sponsorship_payments SET created_at = now() - interval '3 hours' WHERE obligation_id=$1 AND status='awaiting_payment'", [w.due.id]);
  const next = must(await checkout(w), 201);
  assert.notEqual(next.id, open.id);
});

test('authorization and tenant isolation: only the sponsor side pays, outsiders see nothing, wrong currencies and amounts are refused', async () => {
  const w = await world();
  assert.equal((await checkout(w, {}, w.ath)).status, 403, 'the recipient cannot pay its own due');
  const stranger = await signup(['athlete']);
  assert.equal((await checkout(w, {}, stranger)).status, 403);
  assert.equal((await checkout(w, { amount_cents: 100001 })).status, 409, 'more than is due is refused');
  assert.equal((await checkout(w, { amount_cents: 0 })).status, 400);
  assert.equal((await api('POST', `/sponsorship-obligations/${w.due.id}/checkout`, { body: { provider: 'stripe' } })).status, 401);
  must(await checkout(w), 201);
  const x = (await dueOf(w)).payments[0];
  assert.equal((await api('POST', `/sponsorship-payments/${x.id}/cancel-checkout`, { token: stranger.token })).status, 403);
  assert.equal((await api('POST', `/sponsorship-payments/${x.id}/cancel-checkout`, { token: w.ath.token })).status, 403, 'the recipient cannot cancel the sponsor\'s checkout');
  assert.deepEqual(await recon(stranger), [], 'another tenant sees no sponsorship money');
  assert.equal((await recon(w.ath, { sponsorship_id: w.deal.id })).length, 1);
  assert.equal((await api('POST', `/payments`, { token: w.sponsor.token, body: { purpose_type: 'sponsorship_payment', purpose_id: x.id, provider: 'stripe' } })).status, 400, 'the generic payment route does not expose sponsorship money');
});
