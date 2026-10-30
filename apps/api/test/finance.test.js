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
  PROVIDER_COMMISSION_BP: '1000', PLATFORM_ADMIN_EMAILS: 'rraja.edge@gmail.com,rrajas1978@icloud.com', SETTLEMENT_PAYOUTS: 'on', SETTLEMENT_CURRENCIES: 'INR', PAYMENT_CURRENCY: 'INR',
});
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const fin = await import('../src/finance.js');

let server, base, n = 0, boss, outsider;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `st_${n}_${roles[0]}`, display_name: `Settle ${n}`, email: `st${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };

const stripeSig = (payload, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', 'whsec_test').update(`${t}.${payload}`).digest('hex')}`;
const hook = (event) => { const b = JSON.stringify(event); return fetch(`${base}/api/v1/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': stripeSig(b), 'content-type': 'application/json' }, body: b }); };

/** a shop sale paid through the (faked) Stripe */
const sale = async ({ price = 100000, pay = true } = {}) => {
  const seller = await signup(['supplier']), buyer = await signup(['athlete']);
  const prod = must(await api('POST', '/shop/products', { token: seller.token, body: { name: `Item ${++n}`, price_cents: price, stock: 10 } }), 201);
  const order = must(await api('POST', '/shop/orders', { token: buyer.token, body: { product_id: prod.id, quantity: 1, ship_to: '12 MG Road, Pune' } }), 201);
  const payment = must(await api('POST', '/payments', { token: buyer.token, body: { purpose_type: 'shop_order', purpose_id: order.id, provider: 'stripe' } }), 201);
  const sid = payment.checkout_url.split('/').pop();
  if (pay) { fake.sessions[sid].payment_status = 'paid'; must(await api('POST', `/payments/${payment.id}/confirm`, { token: buyer.token })); }
  return { seller, buyer, order, payment, sid };
};
const txs = async (paymentId) => (await pool.query('SELECT * FROM fin_transactions WHERE payment_id=$1 ORDER BY occurred_at, kind', [paymentId])).rows;
const mkOrg = async (owner) => must(await api('POST', '/organisations', { token: owner.token, body: { name: `Finance Org ${++n}`, kind: 'academy' } }), 201);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  boss = await signup(['athlete']);
  await pool.query("UPDATE users SET roles='{athlete,admin,platform_admin}', email_idx=$2 WHERE id=$1", [boss.id, (await import('../src/crypto.js')).blindIndex('rraja.edge@gmail.com')]);
  outsider = await signup(['athlete']);
});
after(async () => { server.close(); stripe.close(); await pool.end(); });

test('a checkout posts an open charge and a payment settles it with tax/fee/net and the seller as payee, once', async () => {
  const s = await sale({ pay: false });
  let rows = await txs(s.payment.id);
  assert.deepEqual(rows.map((r) => [r.kind, r.status]), [['charge', 'open']]);
  assert.equal(rows[0].source_module, 'shop');
  fake.sessions[s.sid].payment_status = 'paid';
  // five concurrent confirms plus a replayed webhook must still post exactly one payment
  await Promise.all(Array.from({ length: 5 }, () => api('POST', `/payments/${s.payment.id}/confirm`, { token: s.buyer.token })));
  const evt = { id: `evt_fin_${s.payment.id}`, type: 'checkout.session.completed', data: { object: { ...fake.sessions[s.sid] } } };
  assert.equal((await hook(evt)).status, 200); assert.equal((await hook(evt)).status, 200);
  rows = await txs(s.payment.id);
  assert.deepEqual(rows.map((r) => [r.kind, r.status]).sort(), [['charge', 'settled'], ['payment', 'settled']]);
  const pay = rows.find((r) => r.kind === 'payment');
  assert.deepEqual([pay.gross_minor, pay.fee_minor, pay.net_minor, pay.currency, pay.payee_id, pay.payer_id], [100000, 10000, 90000, 'INR', s.seller.id, s.buyer.id]);
  assert.equal(pay.provider, 'stripe'); assert.ok(pay.provider_ref);
});

test('refunds post once per amount, point at the payment, and net revenue follows', async () => {
  const s = await sale();
  const before = must(await api('GET', '/finance/summary', { token: boss.token })).currencies.find((c) => c.currency === 'INR');
  must(await api('POST', `/admin/payments/${s.payment.id}/refund`, { token: boss.token, body: { amount_cents: 30000, reason: 'Goods arrived damaged' } }));
  let rows = await txs(s.payment.id);
  const refund = rows.filter((r) => r.kind === 'refund');
  assert.equal(refund.length, 1);
  assert.deepEqual([refund[0].gross_minor, refund[0].tax_minor, refund[0].fee_minor], [30000, 0, 3000]);
  assert.equal(refund[0].parent_id, rows.find((r) => r.kind === 'payment').id);
  must(await api('PATCH', `/shop/orders/${s.order.id}`, { token: s.buyer.token, body: { status: 'cancelled' } }));   // refunds the rest
  rows = await txs(s.payment.id);
  assert.equal(rows.filter((r) => r.kind === 'refund').reduce((a, r) => a + Number(r.gross_minor), 0), 100000);
  const after = must(await api('GET', '/finance/summary', { token: boss.token })).currencies.find((c) => c.currency === 'INR');
  assert.equal(after.refunds - before.refunds, 100000);
  assert.equal(after.net - before.net, -90000, 'the refund takes back the whole 90000 this sale had added to net revenue');
});

test('the canonical ledger is append-only: money and parties cannot change, only lifecycle status', async () => {
  const s = await sale();
  await assert.rejects(pool.query("UPDATE fin_transactions SET gross_minor = 1 WHERE payment_id=$1 AND kind='payment'", [s.payment.id]), /cannot be edited/);
  await assert.rejects(pool.query('DELETE FROM fin_transactions WHERE payment_id=$1', [s.payment.id]), /append-only/);
  await assert.rejects(pool.query('DELETE FROM fin_tx_events'), /append-only/);
  await pool.query("UPDATE fin_transactions SET status='reversed' WHERE payment_id=$1 AND kind='payment'", [s.payment.id]);   // status may move
  await pool.query("UPDATE fin_transactions SET status='settled' WHERE payment_id=$1 AND kind='payment'", [s.payment.id]);
});

test('reconcile backfills payments made before the control plane, is idempotent, and repairs refund drift', async () => {
  const s = await sale();
  await pool.query('ALTER TABLE fin_transactions DISABLE TRIGGER fin_transactions_guard');
  await pool.query('DELETE FROM fin_tx_events WHERE tx_id IN (SELECT id FROM fin_transactions WHERE payment_id=$1)', [s.payment.id]).catch(() => {});
  await pool.query('ALTER TABLE fin_transactions ENABLE TRIGGER fin_transactions_guard');
  // simulate a legacy payment: paid row with no canonical record
  const legacy = (await pool.query("INSERT INTO payments(payer_id, provider, purpose_type, purpose_id, amount_cents, currency, status, provider_ref, provider_payment_ref, paid_at, refunded_cents) VALUES ($1,'stripe','insurance_policy',gen_random_uuid(),50000,'INR','paid','cs_legacy','pi_legacy',now(),20000) RETURNING id", [s.buyer.id])).rows[0];
  assert.equal((await api('POST', '/admin/finance/reconcile', { token: outsider.token, body: {} })).status, 403);
  const first = must(await api('POST', '/admin/finance/reconcile', { token: boss.token, body: {} }));
  assert.ok(first.backfilled >= 1);
  const rows = await txs(legacy.id);
  assert.deepEqual(rows.map((r) => [r.kind, r.gross_minor]).sort(), [['payment', 50000], ['refund', 20000]]);
  const again = must(await api('POST', '/admin/finance/reconcile', { token: boss.token, body: {} }));
  assert.equal(again.backfilled, 0);
  assert.equal((await txs(legacy.id)).length, 2, 'running it twice posts nothing twice');
  // drift: more refunded at the provider record than the canonical ledger knows
  await pool.query('UPDATE payments SET refunded_cents = 30000 WHERE id=$1', [legacy.id]);
  const fixed = must(await api('POST', '/admin/finance/reconcile', { token: boss.token, body: {} }));
  assert.ok(fixed.refunds_repaired >= 1);
  assert.equal((await txs(legacy.id)).filter((r) => r.kind === 'refund').reduce((a, r) => a + Number(r.gross_minor), 0), 30000);
});

test('an amount that disagrees opens a reconciliation item, which a platform admin can close with a reason', async () => {
  const s = await sale();
  await pool.query('UPDATE payments SET amount_cents = amount_cents + 5 WHERE id=$1', [s.payment.id]);
  const r = must(await api('POST', '/admin/finance/reconcile', { token: boss.token, body: {} }));
  assert.ok(r.open_items >= 1);
  const q = must(await api('GET', '/finance/reconciliation', { token: boss.token }));
  const item = q.find((x) => x.payment_id === s.payment.id);
  assert.equal(item?.kind, 'amount_drift');
  assert.equal((await api('POST', `/admin/finance/reconciliation/${item.id}/resolve`, { token: outsider.token, body: { reason: 'looked fine to me' } })).status, 403);
  const done = must(await api('POST', `/admin/finance/reconciliation/${item.id}/resolve`, { token: boss.token, body: { reason: 'Provider statement confirms the original amount' } }));
  assert.equal(done.status, 'resolved');
  assert.equal(must(await api('POST', `/admin/finance/reconciliation/${item.id}/resolve`, { token: boss.token, body: { reason: 'Provider statement confirms the original amount' } })).replayed, true);
  await pool.query('UPDATE payments SET amount_cents = amount_cents - 5 WHERE id=$1', [s.payment.id]);
});

test('a dispute is held, then final when lost or cancelled when won', async () => {
  const s = await sale();
  const p = (await pool.query('SELECT * FROM payments WHERE id=$1', [s.payment.id])).rows[0];
  await pool.query('BEGIN');
  try {
    await fin.recordChargeback(pool, p, { key: 'stripe:dp_test_1', amount: 100000, status: 'disputed' });
    assert.equal((await txs(p.id)).find((r) => r.kind === 'chargeback').status, 'disputed');
    await fin.resolveDispute(pool, { payment_id: p.id, amount_cents: 100000, detail: { provider: 'stripe', dispute_id: 'dp_test_1' } }, 'reverse');
    assert.equal((await txs(p.id)).find((r) => r.kind === 'chargeback').status, 'settled');
  } finally { await pool.query('COMMIT'); }
  const w = await sale();
  const wp = (await pool.query('SELECT * FROM payments WHERE id=$1', [w.payment.id])).rows[0];
  await fin.recordChargeback(pool, wp, { key: 'stripe:dp_test_2', amount: 100000, status: 'disputed' });
  await fin.resolveDispute(pool, { payment_id: wp.id, amount_cents: 100000, detail: { provider: 'stripe', dispute_id: 'dp_test_2' } }, 'release');
  assert.equal((await txs(wp.id)).find((r) => r.kind === 'chargeback').status, 'cancelled');
});

test('organisation books: finance roles only, outsiders get 404, currencies stay apart, the platform view is admin-only', async () => {
  const owner = await signup(['organizer']), member = await signup(['athlete']);
  const org = await mkOrg(owner);
  const s = await sale();
  // post a movement that belongs to the organisation (the real flows set payee_org_id from the paid-for record)
  await pool.query("UPDATE fin_transactions SET payee_org_id=$2 WHERE payment_id=$1 AND kind IN ('payment','charge')", [s.payment.id, org.id]);
  await pool.query(`INSERT INTO fin_transactions(kind, status, source_module, source_type, payee_org_id, currency, gross_minor, net_minor, idem_key) VALUES ('payment','settled','venue','venue_invoice',$1,'EUR',5000,5000,$2)`, [org.id, `test:eur:${org.id}`]);
  const sum = must(await api('GET', '/finance/summary', { token: owner.token, query: { organisation_id: org.id } }));
  assert.equal(sum.scope, 'organisation');
  assert.deepEqual(sum.currencies.map((c) => c.currency), ['EUR', 'INR']);
  const inr = sum.currencies.find((c) => c.currency === 'INR');
  assert.deepEqual([inr.gross, inr.fee, inr.net], [100000, 10000, 90000]);
  assert.equal(sum.currencies.find((c) => c.currency === 'EUR').by_module[0].module, 'venue');
  const list = must(await api('GET', '/finance/transactions', { token: owner.token, query: { organisation_id: org.id, module: 'venue' } }));
  assert.equal(list.length, 1); assert.equal(list[0].direction, 'in');
  assert.equal((await api('GET', '/finance/summary', { token: outsider.token, query: { organisation_id: org.id } })).status, 404, 'existence is not leaked');
  assert.equal((await api('GET', '/finance/summary', { token: member.token })).status, 403, 'platform view is admin only');
  assert.equal((await api('GET', '/finance/summary', { token: owner.token })).status, 403);
  const detail = must(await api('GET', `/finance/transactions/${(await pool.query("SELECT id FROM fin_transactions WHERE payment_id=$1 AND kind='payment'", [s.payment.id])).rows[0].id}`, { token: owner.token, query: { organisation_id: org.id } }));
  assert.deepEqual(detail.steps.map((x) => x.key), ['source', 'charge', 'payment', 'allocation', 'settlement', 'reconciliation']);
  assert.ok(detail.history.some((h) => h.action === 'posted'));
  assert.equal((await api('GET', `/finance/transactions/${detail.id}`, { token: outsider.token, query: { organisation_id: org.id } })).status, 404);
  const other = await mkOrg(await signup(['organizer']));
  assert.equal((await api('GET', `/finance/transactions/${detail.id}`, { token: owner.token, query: { organisation_id: other.id } })).status, 404, 'another organisation cannot open it');
  const exp = must(await api('GET', '/finance/transactions/export', { token: owner.token, query: { organisation_id: org.id } }));
  assert.ok(exp.csv.split('\n')[0].startsWith('id,occurred_at,kind') && exp.rows >= 2);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='export_finance_transactions' AND entity_id=$1", [org.id])).rowCount >= 1, 'exports are audit-logged');
});

test('every canonical module has a label and the worker reconciles the ledger', async () => {
  for (const type of Object.keys(fin.MODULE_OF)) assert.ok(fin.MODULE_LABEL[fin.moduleOf(type)], `${type} has a module label`);
  assert.equal(fin.moduleOf('something_new'), 'other');
  const { STEPS } = await import('../src/worker.js');
  assert.ok(STEPS.some(([name, , fn]) => name === 'finance' && fn === fin.reconcileFinance));
});
