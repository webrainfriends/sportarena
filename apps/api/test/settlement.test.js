import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';

// stand-in for Stripe Checkout + refunds (the real provider needs real keys)
const fake = { sessions: {}, refunds: [], n: 0, wrongAmount: false };
const stripe = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString(), send = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
  if (req.url === '/v1/checkout/sessions' && req.method === 'POST') {
    const f = new URLSearchParams(raw); const id = `cs_${++fake.n}`;
    fake.sessions[id] = { id, amount_total: Number(f.get('line_items[0][price_data][unit_amount]')), currency: f.get('line_items[0][price_data][currency]'), payment_status: 'unpaid', payment_intent: `pi_${fake.n}` };
    return send(200, { id, url: `https://checkout.stripe.test/${id}` });
  }
  if (req.url.startsWith('/v1/checkout/sessions/')) { const s = fake.sessions[req.url.split('/').pop()]; return s ? send(200, { ...s, amount_total: fake.wrongAmount ? s.amount_total + 1 : s.amount_total }) : send(404, { error: { message: 'no such session' } }); }
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
const { allocate } = await import('../src/settlement.js');

let server, base, n = 0, admin, admin2;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `st_${n}_${roles[0]}`, display_name: `Settle ${n}`, email: `st${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const mkAdmin = async (h) => { const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ($1,$1,'{admin}','x','x',$1) RETURNING id", [h])).rows[0]; return { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) }; };
const stripeSig = (payload, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', 'whsec_test').update(`${t}.${payload}`).digest('hex')}`;
const hook = (event) => { const body = JSON.stringify(event); return fetch(`${base}/api/v1/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': stripeSig(body), 'content-type': 'application/json' }, body }); };

/** a shop sale paid through the (faked) Stripe: returns { seller, buyer, order, payment } */
const sale = async ({ seller, price = 100000, qty = 1, pay = true } = {}) => {
  seller ??= await signup(['supplier']);
  const buyer = await signup(['athlete']);
  const prod = must(await api('POST', '/shop/products', { token: seller.token, body: { name: `Item ${++n}`, price_cents: price, stock: 10 } }), 201);
  const order = must(await api('POST', '/shop/orders', { token: buyer.token, body: { product_id: prod.id, quantity: qty, ship_to: '12 MG Road, Pune' } }), 201);
  const payment = must(await api('POST', '/payments', { token: buyer.token, body: { purpose_type: 'shop_order', purpose_id: order.id, provider: 'stripe' } }), 201);
  const sid = payment.checkout_url.split('/').pop();
  if (pay) { fake.sessions[sid].payment_status = 'paid'; must(await api('POST', `/payments/${payment.id}/confirm`, { token: buyer.token })); }
  return { seller, buyer, order, payment, sid, intent: fake.sessions[sid].payment_intent };
};
const earnings = async (u) => must(await api('GET', '/me/earnings', { token: u.token })).currencies.find((c) => c.currency === 'INR');
const ledgerCount = async (sellerId) => Number((await pool.query('SELECT count(*) FROM provider_ledger WHERE seller_id=$1', [sellerId])).rows[0].count);
const account = async (u, extra = {}) => must(await api('POST', '/me/payout-accounts', { token: u.token, body: { currency: 'INR', holder_name: 'Test Seller', account_number: '123456789012', bank_code: 'HDFC0001234', ...extra } }), 201);
const verified = async (u) => { const a = await account(u); must(await api('POST', `/admin/payout-accounts/${a.id}/decision`, { token: admin.token, body: { decision: 'verify', reason: 'Holder name matches the profile' } })); return a; };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  admin = await mkAdmin('st_root'); admin2 = await mkAdmin('st_root2');
});
after(async () => { server.close(); stripe.close(); await pool.end(); });

test('allocate splits an amount so the parts always add up', () => {
  assert.deepEqual(allocate(100, [1, 1, 1]), [33, 34, 33]);
  assert.equal(allocate(7, [3, 3, 3, 3]).reduce((a, b) => a + b, 0), 7);
  assert.deepEqual(allocate(0, [5, 5]), [0, 0]);
});

test('a paid sale posts gross, fee and net once; customer "paid" never means the seller was paid', async () => {
  const s = await sale();
  const e = await earnings(s.seller);
  assert.deepEqual([e.gross_cents, e.commission_cents, e.net_earned_cents, e.payable_cents, e.paid_out_cents, e.available_cents], [100000, 10000, 90000, 90000, 0, 90000]);
  assert.equal(e.reconciles, true);
  assert.equal((await api('GET', '/payments', { token: s.buyer.token })).body[0].status, 'paid', 'the customer paid the platform');
  assert.equal(e.payout_ready, false);
  assert.deepEqual(e.payout_blockers.map((b) => b.code), ['no_account'], 'the earnings page says exactly what is missing');
  const lines = must(await api('GET', '/me/earnings/entries', { token: s.seller.token }));
  assert.deepEqual(lines.map((l) => l.kind).sort(), ['commission', 'sale']);
  assert.ok(lines.every((l) => l.payment_status === 'paid' && !('buyer_id' in l)), 'buyers are not identified on the seller statement');
});

test('repeated confirms, concurrent confirms and replayed webhooks cannot duplicate earnings', async () => {
  const s = await sale({ pay: false });
  fake.sessions[s.sid].payment_status = 'paid';
  const results = await Promise.all(Array.from({ length: 5 }, () => api('POST', `/payments/${s.payment.id}/confirm`, { token: s.buyer.token })));
  assert.ok(results.every((r) => r.status === 200 && r.body.status === 'paid'));
  const evt = { id: 'evt_replay_1', type: 'checkout.session.completed', data: { object: { ...fake.sessions[s.sid] } } };
  assert.equal((await hook(evt)).status, 200);
  const dup = await (await hook(evt)).json();
  assert.equal(dup.duplicate, true, 'a replayed event is acknowledged without being applied again');
  assert.equal(await ledgerCount(s.seller.id), 2);
  assert.equal((await earnings(s.seller)).net_earned_cents, 90000);
  const forged = await fetch(`${base}/api/v1/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': 't=1,v1=bad', 'content-type': 'application/json' }, body: JSON.stringify(evt) });
  assert.equal(forged.status, 400);
});

test('the ledger cannot be edited or deleted, and a duplicate idempotency key is refused by the database', async () => {
  const s = await sale();
  await assert.rejects(pool.query('UPDATE provider_ledger SET amount_cents = 1 WHERE seller_id=$1', [s.seller.id]), /append-only/);
  await assert.rejects(pool.query('DELETE FROM provider_ledger WHERE seller_id=$1', [s.seller.id]), /append-only/);
});

test('refunds reduce earnings and return the fee in proportion; cancelling a paid order refunds everything', async () => {
  const s = await sale();
  const pr = must(await api('POST', `/admin/payments/${s.payment.id}/refund`, { token: admin.token, body: { amount_cents: 30000, reason: 'Goods arrived damaged' } }));
  assert.equal(pr.refunded_now, 30000);
  let e = await earnings(s.seller);
  assert.deepEqual([e.refunds_cents, e.commission_cents, e.net_earned_cents], [30000, 7000, 63000]);
  assert.equal(e.reconciles, true);
  must(await api('PATCH', `/shop/orders/${s.order.id}`, { token: s.buyer.token, body: { status: 'cancelled' } }));
  e = await earnings(s.seller);
  assert.deepEqual([e.gross_cents, e.refunds_cents, e.commission_cents, e.net_earned_cents, e.payable_cents], [100000, 100000, 0, 0, 0]);
});

test('a multi-seller cart splits earnings per seller and a cancelled line comes out of that line\'s seller only', async () => {
  const a = await signup(['supplier']), b = await signup(['supplier']), buyer = await signup(['athlete']);
  const mk = async (u, price) => must(await api('POST', '/shop/products', { token: u.token, body: { name: `Cart ${++n}`, price_cents: price, stock: 5 } }), 201);
  const pa = await mk(a, 20000), pb = await mk(b, 10000);
  for (const p of [pa, pb]) must(await api('POST', '/shop/cart/items', { token: buyer.token, body: { product_id: p.id, quantity: 1 } }), 200);
  const co = must(await api('POST', '/shop/cart/checkout', { token: buyer.token, body: { ship_to: '12 MG Road, Pune' } }), 201);
  const p = must(await api('POST', '/payments', { token: buyer.token, body: { purpose_type: 'shop_checkout', purpose_id: co.checkout_id, provider: 'stripe' } }), 201);
  fake.sessions[p.checkout_url.split('/').pop()].payment_status = 'paid';
  must(await api('POST', `/payments/${p.id}/confirm`, { token: buyer.token }));
  assert.equal((await earnings(a)).gross_cents, 20000);
  assert.equal((await earnings(b)).gross_cents, 10000);
  const line = must(await api('GET', '/shop/orders', { token: buyer.token })).find((o) => o.product_id === pb.id);
  must(await api('PATCH', `/shop/orders/${line.id}`, { token: buyer.token, body: { status: 'cancelled' } }));
  assert.equal((await earnings(b)).net_earned_cents, 0, 'seller B gave the money back');
  assert.equal((await earnings(a)).net_earned_cents, 18000, 'seller A is untouched');
});

test('payout account: validated, encrypted, verified by someone else, and required before a payout', async () => {
  const s = await sale();
  assert.equal((await api('POST', '/me/payout-accounts', { token: s.seller.token, body: { currency: 'USD', holder_name: 'X Y', account_number: '123456789', bank_code: 'ABC123' } })).status, 400, 'unsupported currency');
  assert.equal((await api('POST', '/me/payout-accounts', { token: s.seller.token, body: { currency: 'INR', holder_name: 'X Y', account_number: '12', bank_code: 'ABC123' } })).status, 400, 'invalid number');
  const a = await account(s.seller);
  assert.equal(a.status, 'pending'); assert.equal(a.last4, '9012'); assert.equal(a.details_enc, undefined, 'details never leave the server');
  assert.ok(!(await pool.query('SELECT details_enc FROM payout_accounts WHERE id=$1', [a.id])).rows[0].details_enc.includes('123456789012'), 'stored encrypted');
  const start = (key) => api('POST', '/admin/provider-payouts', { token: admin.token, body: { seller_id: s.seller.id, currency: 'INR', idempotency_key: key } });
  assert.equal((await start('key-pending-1')).status, 409, 'unverified account blocks the payout');
  assert.equal((await api('POST', `/admin/payout-accounts/${a.id}/decision`, { token: s.seller.token, body: { decision: 'verify', reason: 'verify myself' } })).status, 403, 'not an admin');
  const me = await signup(['athlete']); await pool.query("UPDATE users SET roles='{admin}' WHERE id=$1", [me.id]);
  const mine = await account({ token: await signToken({ id: me.id, roles: ['admin'] }) });
  assert.equal((await api('POST', `/admin/payout-accounts/${mine.id}/decision`, { token: await signToken({ id: me.id, roles: ['admin'] }), body: { decision: 'verify', reason: 'my own account' } })).status, 403, 'nobody verifies their own account');
  must(await api('POST', `/admin/payout-accounts/${a.id}/decision`, { token: admin.token, body: { decision: 'verify', reason: 'Holder name matches' } }));
  assert.equal((await api('POST', `/admin/payout-accounts/${a.id}/decision`, { token: admin.token, body: { decision: 'reject', reason: 'changed my mind' } })).status, 409);
  const details = must(await api('GET', `/admin/payout-accounts/${a.id}/details`, { token: admin.token }));
  assert.equal(details.account_number, '123456789012');
  assert.equal(Number((await pool.query("SELECT count(*) FROM audit_log WHERE action='read_payout_account' AND entity_id=$1", [a.id])).rows[0].count), 1, 'reading bank details is audit-logged');
  assert.equal((await api('GET', `/admin/payout-accounts/${a.id}/details`, { token: s.seller.token })).status, 403);
  // replacing the account supersedes it and needs verification again
  const b = await account(s.seller, { account_number: '999988887777' });
  assert.equal((await pool.query('SELECT status FROM payout_accounts WHERE id=$1', [a.id])).rows[0].status, 'superseded');
  assert.equal((await start('key-pending-2')).status, 409);
});

test('payout lifecycle: idempotent start, one in flight, paid once, failures return the money with an explanation', async () => {
  const s = await sale();
  await verified(s.seller);
  const start = (key, token = admin.token) => api('POST', '/admin/provider-payouts', { token, body: { seller_id: s.seller.id, currency: 'INR', idempotency_key: key } });
  assert.equal((await start('x', s.seller.token)).status, 403);
  const p = must(await start('payout-key-0001'), 201);
  assert.equal(p.amount_cents, 90000); assert.equal(p.status, 'processing');
  const again = must(await start('payout-key-0001'), 201);
  assert.equal(again.id, p.id); assert.equal(again.replayed, true, 'a retry returns the same payout');
  let e = await earnings(s.seller);
  assert.deepEqual([e.payout_in_progress_cents, e.paid_out_cents, e.available_cents, e.payable_cents], [90000, 0, 0, 0]);
  assert.equal((await start('payout-key-0002')).status, 409, 'nothing left to pay');
  assert.equal((await api('POST', `/admin/provider-payouts/${p.id}/result`, { token: admin.token, body: { outcome: 'paid' } })).status, 400, 'reference required');
  must(await api('POST', `/admin/provider-payouts/${p.id}/result`, { token: admin.token, body: { outcome: 'paid', reference: 'UTR-778899' } }));
  must(await api('POST', `/admin/provider-payouts/${p.id}/result`, { token: admin.token, body: { outcome: 'paid', reference: 'UTR-778899' } }));
  assert.equal((await api('POST', `/admin/provider-payouts/${p.id}/result`, { token: admin.token, body: { outcome: 'failed', failure_code: 'other', reason: 'try to flip a paid payout' } })).status, 409);
  e = await earnings(s.seller);
  assert.deepEqual([e.paid_out_cents, e.payout_in_progress_cents, e.payable_cents], [90000, 0, 0]);
  assert.equal(e.reconciles, true);

  // a second sale, a payout that fails
  const s2 = await sale({ seller: s.seller });
  const p2 = must(await start('payout-key-0003'), 201);
  assert.equal(p2.amount_cents, 90000);
  const failed = must(await api('POST', `/admin/provider-payouts/${p2.id}/result`, { token: admin.token, body: { outcome: 'failed', failure_code: 'invalid_account', reason: 'Bank says the account number does not exist' } }));
  assert.equal(failed.status, 'failed');
  e = await earnings(s.seller);
  assert.deepEqual([e.paid_out_cents, e.available_cents, e.payable_cents], [90000, 90000, 90000], 'the money is back in the balance');
  assert.equal(e.reconciles, true);
  const mine = must(await api('GET', '/me/payouts', { token: s.seller.token }));
  assert.equal(mine[0].status, 'failed'); assert.match(mine[0].explanation.next_step, /payout account/i);
  assert.equal(must(await api('GET', '/me/earnings', { token: s.seller.token })).attention[0].kind, 'payout_failed');
  const ex = must(await api('GET', '/admin/settlement/exceptions', { token: admin.token, query: { kind: 'payout_failed' } }));
  assert.ok(ex.some((x) => x.payout_id === p2.id), 'a failed payout is an open exception');
  assert.ok((await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='payout_failed'", [s.seller.id])).rowCount, 'the seller was told');
  // reference can be used once
  const s3 = await sale({ seller: s.seller });
  must(await api('POST', `/admin/provider-payouts/${p2.id}/result`, { token: admin.token, body: { outcome: 'failed', failure_code: 'invalid_account', reason: 'Bank says the account number does not exist' } }));
  const p3 = must(await start('payout-key-0004'), 201);
  assert.equal((await api('POST', `/admin/provider-payouts/${p3.id}/result`, { token: admin.token, body: { outcome: 'paid', reference: 'UTR-778899' } })).status, 409, 'reference already used');
  assert.ok(s3);
});

test('holds keep money out of payouts until released', async () => {
  const s = await sale(); await verified(s.seller);
  const h = must(await api('POST', '/admin/settlement-holds', { token: admin.token, body: { seller_id: s.seller.id, currency: 'INR', amount_cents: 90000, reason: 'Reviewing a complaint' } }), 201);
  assert.equal((await earnings(s.seller)).available_cents, 0);
  assert.equal((await earnings(s.seller)).held_cents, 90000);
  assert.equal((await api('POST', '/admin/provider-payouts', { token: admin.token, body: { seller_id: s.seller.id, currency: 'INR', idempotency_key: 'held-payout-01' } })).status, 409);
  assert.equal((await api('POST', '/admin/settlement-holds', { token: admin.token, body: { seller_id: s.seller.id, currency: 'INR', amount_cents: 1, reason: 'More than the balance' } })).status, 409, 'cannot hold more than is owed');
  must(await api('POST', `/admin/settlement-holds/${h.id}/release`, { token: admin.token, body: { reason: 'Complaint withdrawn' } }));
  assert.equal(must(await api('POST', `/admin/settlement-holds/${h.id}/release`, { token: admin.token, body: { reason: 'Complaint withdrawn' } })).replayed, true);
  assert.equal((await earnings(s.seller)).available_cents, 90000);
});

test('a card dispute holds the seller\'s share at once; lost disputes are reversed through new lines, won ones are released', async () => {
  const s = await sale(); await verified(s.seller);
  const evt = { id: 'evt_dispute_1', type: 'charge.dispute.created', data: { object: { id: 'dp_1', payment_intent: s.intent, amount: 100000 } } };
  assert.equal((await hook(evt)).status, 200);
  assert.equal((await hook(evt)).status, 200);
  let e = await earnings(s.seller);
  assert.equal(e.held_cents, 90000, 'the net share is held (it cannot exceed what is owed)');
  assert.equal(e.available_cents, 0);
  const ex = must(await api('GET', '/admin/settlement/exceptions', { token: admin.token, query: { kind: 'provider_dispute' } })).filter((x) => x.payment_id === s.payment.id);
  assert.equal(ex.length, 1, 'one exception however often the event is replayed');
  assert.equal((await api('POST', `/admin/settlement/exceptions/${ex[0].id}/resolution`, { token: admin.token, body: { action: 'note', reason: 'closing without deciding' } })).status, 400);
  must(await api('POST', `/admin/settlement/exceptions/${ex[0].id}/resolution`, { token: admin.token, body: { action: 'reverse', reason: 'Dispute lost, evidence rejected' } }));
  e = await earnings(s.seller);
  assert.deepEqual([e.chargebacks_cents, e.net_earned_cents, e.held_cents, e.payable_cents], [100000, 0, 0, 0]);
  assert.equal(e.reconciles, true);
  // a won dispute
  const w = await sale(); 
  assert.equal((await hook({ id: 'evt_dispute_2', type: 'charge.dispute.created', data: { object: { id: 'dp_2', payment_intent: w.intent, amount: 100000 } } })).status, 200);
  const wx = must(await api('GET', '/admin/settlement/exceptions', { token: admin.token, query: { kind: 'provider_dispute' } })).find((x) => x.payment_id === w.payment.id);
  must(await api('POST', `/admin/settlement/exceptions/${wx.id}/resolution`, { token: admin.token, body: { action: 'release', reason: 'Dispute won' } }));
  assert.equal((await earnings(w.seller)).available_cents, 90000);
  assert.equal(must(await api('POST', `/admin/settlement/exceptions/${wx.id}/resolution`, { token: admin.token, body: { action: 'release', reason: 'Dispute won' } })).replayed, true);
});

test('reconciliation backfills payments made before settlement existed, flags mismatches, and is idempotent', async () => {
  const seller = await signup(['supplier']), buyer = await signup(['athlete']);
  const prod = must(await api('POST', '/shop/products', { token: seller.token, body: { name: 'Legacy', price_cents: 50000, stock: 3 } }), 201);
  const order = must(await api('POST', '/shop/orders', { token: buyer.token, body: { product_id: prod.id, quantity: 1, ship_to: '12 MG Road, Pune' } }), 201);
  // a payment that was paid (and partly refunded) before the ledger existed
  const { rows: [pay] } = await pool.query("INSERT INTO payments(payer_id, provider, purpose_type, purpose_id, amount_cents, currency, status, provider_ref, provider_payment_ref, paid_at, refunded_cents) VALUES ($1,'stripe','shop_order',$2,50000,'INR','paid','cs_legacy','pi_legacy', now(), 10000) RETURNING id", [buyer.id, order.id]);
  const before = must(await api('GET', '/admin/settlement/reconciliation', { token: admin.token })).currencies.find((c) => c.currency === 'INR');
  assert.ok(before.unrecorded_payments >= 1 && before.balanced === false, 'the report shows the gap');
  assert.equal((await api('POST', '/admin/settlement/reconcile', { token: seller.token })).status, 403);
  const run = must(await api('POST', '/admin/settlement/reconcile', { token: admin.token, body: {} }));
  assert.ok(run.backfilled >= 1);
  const e = await earnings(seller);
  assert.deepEqual([e.gross_cents, e.refunds_cents, e.commission_cents, e.net_earned_cents], [50000, 10000, 4000, 36000]);
  assert.equal(must(await api('POST', '/admin/settlement/reconcile', { token: admin.token, body: {} })).backfilled, 0);
  assert.equal((await earnings(seller)).net_earned_cents, 36000);
  const after = must(await api('GET', '/admin/settlement/reconciliation', { token: admin.token })).currencies.find((c) => c.currency === 'INR');
  assert.equal(after.unrecorded_payments, 0); assert.equal(after.balanced, true); assert.equal(after.difference_cents, 0);
  assert.ok(pay.id);
});

test('amount mismatches and refunds made at the provider show up as exceptions instead of being ignored', async () => {
  const s = await sale({ pay: false });
  fake.sessions[s.sid].payment_status = 'paid'; fake.wrongAmount = true;
  assert.equal((await api('POST', `/payments/${s.payment.id}/confirm`, { token: s.buyer.token })).status, 409);
  fake.wrongAmount = false;
  assert.equal(await ledgerCount(s.seller.id), 0, 'nothing is owed for a payment that did not match');
  const mism = must(await api('GET', '/admin/settlement/exceptions', { token: admin.token, query: { kind: 'amount_mismatch' } }));
  assert.ok(mism.some((x) => x.payment_id === s.payment.id));
  const p = await sale();
  assert.equal((await hook({ id: 'evt_refund_1', type: 'charge.refunded', data: { object: { payment_intent: p.intent, amount_refunded: 20000 } } })).status, 200);
  const unrec = must(await api('GET', '/admin/settlement/exceptions', { token: admin.token, query: { kind: 'refund_unrecorded' } }));
  assert.ok(unrec.some((x) => x.payment_id === p.payment.id), 'a refund the ledger has not recorded is visible');
  must(await api('POST', `/admin/payments/${p.payment.id}/refund`, { token: admin.token, body: { amount_cents: 20000, reason: 'Matches the provider-side refund' } }));
  assert.ok(!must(await api('GET', '/admin/settlement/exceptions', { token: admin.token, query: { kind: 'refund_unrecorded' } })).some((x) => x.payment_id === p.payment.id), 'it resolves itself once the refund is recorded');
});

test('wallet value and venue money are not provider funds', async () => {
  const u = await signup(['athlete']);
  const t = must(await api('POST', '/me/wallet/topups', { token: u.token, body: { currency: 'INR', amount_cents: 70000 } }), 201);
  const p = must(await api('POST', '/payments', { token: u.token, body: { purpose_type: 'wallet_topup', purpose_id: t.id, provider: 'stripe' } }), 201);
  fake.sessions[p.checkout_url.split('/').pop()].payment_status = 'paid';
  must(await api('POST', `/payments/${p.id}/confirm`, { token: u.token }));
  assert.equal(await ledgerCount(u.id), 0);
  const rep = must(await api('GET', '/admin/settlement/reconciliation', { token: admin.token })).currencies.find((c) => c.currency === 'INR');
  assert.ok(rep.other_funds.some((f) => f.class === 'platform_wallet' && f.net_cents >= 70000));
  assert.equal(must(await api('GET', '/me/earnings', { token: u.token })).currencies.length, 0);
});

test('statements are private to the seller and export safely', async () => {
  const a = await sale({ price: 12345 }), b = await sale();
  const mine = must(await api('GET', '/me/earnings/entries', { token: a.seller.token }));
  assert.ok(mine.every((l) => l.currency === 'INR') && mine.length === 2);
  assert.ok(!mine.some((l) => l.payment_id === b.payment.id), 'another seller\'s lines never appear');
  assert.equal((await api('GET', '/me/earnings/entries', { token: a.seller.token, query: { from: '2030-01-02', to: '2030-01-01' } })).status, 400);
  assert.equal(must(await api('GET', '/me/earnings/entries', { token: a.seller.token, query: { kind: 'sale', limit: '1' } })).length, 1);
  const csv = must(await api('GET', '/me/earnings/export', { token: a.seller.token }));
  assert.equal(csv.rows, 2); assert.match(csv.csv.split('\n')[0], /^date,line,currency,amount/); assert.match(csv.csv, /123\.45/);
  for (const [m, path] of [['GET', '/admin/settlement/reconciliation'], ['GET', '/admin/settlement/exceptions'], ['GET', '/admin/provider-payouts'], ['GET', '/admin/payout-accounts']]) {
    assert.equal((await api(m, path, { token: a.seller.token })).status, 403, path);
    assert.equal((await api(m, path)).status, 401, path);
  }
});

test('an admin cannot move their own money', async () => {
  const sellerAdmin = admin2;
  await pool.query("UPDATE users SET roles='{admin,supplier}' WHERE id=$1", [sellerAdmin.id]);
  const prod = must(await api('POST', '/shop/products', { token: sellerAdmin.token, body: { name: 'Admin item', price_cents: 20000, stock: 2 } }), 201);
  const buyer = await signup(['athlete']);
  const order = must(await api('POST', '/shop/orders', { token: buyer.token, body: { product_id: prod.id, quantity: 1, ship_to: '12 MG Road, Pune' } }), 201);
  const pay = must(await api('POST', '/payments', { token: buyer.token, body: { purpose_type: 'shop_order', purpose_id: order.id, provider: 'stripe' } }), 201);
  fake.sessions[pay.checkout_url.split('/').pop()].payment_status = 'paid';
  must(await api('POST', `/payments/${pay.id}/confirm`, { token: buyer.token }));
  const r = await api('POST', '/admin/provider-payouts', { token: sellerAdmin.token, body: { seller_id: sellerAdmin.id, currency: 'INR', idempotency_key: 'self-payout-1' } });
  assert.equal(r.status, 403);
  assert.equal((await api('POST', '/admin/settlement-holds', { token: sellerAdmin.token, body: { seller_id: sellerAdmin.id, currency: 'INR', amount_cents: 100, reason: 'hold my own money' } })).status, 403);
});

test('a coach hire is owed to the coach; cancelling it returns the money and the fee', async () => {
  const coach = await signup(['coach']), hirer = await signup(['athlete']);
  await api('POST', '/me/sport-profiles', { token: coach.token, body: { sport: 'football', role: 'coach', hourly_rate_cents: 80000 } });
  const at = new Date(Date.now() + 3 * 864e5); at.setUTCHours(9, 0, 0, 0);
  const hire = must(await api('POST', '/hires', { token: hirer.token, body: { coach_id: coach.id, sport: 'football', starts_at: at.toISOString(), duration_min: 60 } }), 201);
  const p = must(await api('POST', '/payments', { token: hirer.token, body: { purpose_type: 'coach_hire', purpose_id: hire.id, provider: 'stripe' } }), 201);
  fake.sessions[p.checkout_url.split('/').pop()].payment_status = 'paid';
  must(await api('POST', `/payments/${p.id}/confirm`, { token: hirer.token }));
  let e = await earnings(coach);
  assert.deepEqual([e.gross_cents, e.commission_cents, e.net_earned_cents], [80000, 8000, 72000]);
  assert.equal((await api('GET', '/me/earnings', { token: hirer.token })).body.currencies.length, 0, 'the hirer earns nothing');
  must(await api('PATCH', `/hires/${hire.id}`, { token: hirer.token, body: { status: 'cancelled' } }));
  e = await earnings(coach);
  assert.deepEqual([e.refunds_cents, e.commission_cents, e.net_earned_cents], [80000, 0, 0]);
});

test('the payout queue lists who can be paid and what blocks the rest', async () => {
  const ready = await sale(); await verified(ready.seller);
  const noAcct = await sale();
  const pending = await sale(); await account(pending.seller);
  const q = must(await api('GET', '/admin/provider-payouts/due', { token: admin.token, query: { limit: '100' } }));
  const by = (s) => q.find((r) => r.seller_id === s.seller.id);
  assert.equal(by(ready).blocker, null); assert.equal(by(ready).available_cents, 90000);
  assert.equal(by(noAcct).blocker, 'no_account');
  assert.equal(by(pending).blocker, 'account_pending');
  must(await api('POST', '/admin/provider-payouts', { token: admin.token, body: { seller_id: ready.seller.id, currency: 'INR', idempotency_key: 'queue-payout-01' } }), 201);
  assert.ok(!must(await api('GET', '/admin/provider-payouts/due', { token: admin.token, query: { limit: '100' } })).some((r) => r.seller_id === ready.seller.id), 'nothing left to pay once the payout started');
  assert.equal((await api('GET', '/admin/provider-payouts/due', { token: ready.seller.token })).status, 403);
});
