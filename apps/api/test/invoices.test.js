import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// ---- stand-ins for the Stripe / PayPal HTTP APIs ----
const fake = { sessions: {}, refunds: [], paypalOrders: [], n: 0, failRefunds: 0 };
const provider = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.url === '/v1/checkout/sessions' && req.method === 'POST') {
    const f = new URLSearchParams(raw); const id = `cs_${++fake.n}`;
    fake.sessions[id] = { id, amount_total: Number(f.get('line_items[0][price_data][unit_amount]')), currency: f.get('line_items[0][price_data][currency]'), payment_status: 'unpaid', payment_intent: `pi_${fake.n}` };
    return send(200, { id, url: `https://checkout.stripe.test/${id}` });
  }
  if (req.url.startsWith('/v1/checkout/sessions/')) { const s = fake.sessions[req.url.split('/').pop()]; return s ? send(200, s) : send(404, { error: { message: 'no such session' } }); }
  if (req.url === '/v1/refunds') {
    if (fake.failRefunds > 0) { fake.failRefunds--; return send(500, { error: { message: 'provider down' } }); }
    const f = new URLSearchParams(raw); fake.refunds.push({ intent: f.get('payment_intent'), amount: Number(f.get('amount')), key: req.headers['idempotency-key'] });
    return send(200, { id: 're_1' });
  }
  if (req.url === '/v1/oauth2/token') return send(200, { access_token: 'pp', expires_in: 3600 });
  if (req.url === '/v2/checkout/orders') { const b = JSON.parse(raw); fake.paypalOrders.push(b.purchase_units[0].amount); return send(200, { id: `ORD${++fake.n}`, links: [{ rel: 'payer-action', href: 'https://paypal.test/x' }] }); }
  send(404, {});
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
const pbase = `http://127.0.0.1:${provider.address().port}`;
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp',
  STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_API_BASE: pbase,
  PAYPAL_CLIENT_ID: 'cid', PAYPAL_CLIENT_SECRET: 'sec', PAYPAL_WEBHOOK_ID: 'WH1', PAYPAL_API_BASE: pbase, APP_URL: 'http://app.test', CORS_ORIGINS: 'http://app.test',
});
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { fromLocal, addDays } = await import('../src/booking/time.js');
const { maintenanceCycle } = await import('../src/worker.js');
const { processRefunds } = await import('../src/booking/refunds.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `inv_${n}_${roles[0]}`, display_name: `Inv ${n}`, email: `inv${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const today = new Date().toISOString().slice(0, 10);
const at = (d, h, tz = 'UTC') => fromLocal(addDays(today, d), h * 60, tz).toISOString();
const wait = async (fn, ms = 4000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)); } };

async function venue(mgr, over = {}) {
  const v = must(await api('POST', '/venues', { token: mgr.token, body: { name: `Pay Arena ${Math.random().toString(36).slice(2, 6)}`, timezone: 'UTC', currency: 'INR', ...over } }), 201);
  const court = must(await api('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'Court 1', hourly_rate_cents: over.rate ?? 100000 } }), 201);
  return { v, court };
}
const book = (u, court, d, h, len = 1, extra = {}) => api('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: court.id, starts_at: at(d, h), ends_at: at(d, h + len) }], ...extra } });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); provider.close(); await pool.end(); });

test('currencies: catalogue, validation, whole-unit currencies, locked once there are bookings', async () => {
  const list = must(await api('GET', '/currencies'));
  assert.ok(list.find((c) => c.code === 'INR' && c.exponent === 2));
  assert.equal(list.find((c) => c.code === 'JPY').exponent, 0);
  assert.ok(!list.some((c) => c.code === 'KWD'), 'three-decimal currencies are not offered');
  const mgr = await signup(['venue_manager']);
  assert.equal((await api('POST', '/venues', { token: mgr.token, body: { name: 'Nowhere', currency: 'XXX' } })).status, 400);
  const { v, court } = await venue(mgr);
  must(await api('PATCH', `/venues/${v.id}`, { token: mgr.token, body: { currency: 'USD' } }));
  const u = await signup();
  must(await book(u, court, 3, 10), 201);
  const locked = await api('PATCH', `/venues/${v.id}`, { token: mgr.token, body: { currency: 'EUR' } });
  assert.equal(locked.status, 409);
  assert.match(locked.body.error.message, /already has bookings in USD/);
  must(await api('PATCH', `/venues/${v.id}`, { token: mgr.token, body: { currency: 'USD', tax_name: 'Sales tax' } }));
});

test('tax: inclusive and exclusive pricing, numbered invoices, buyer details encrypted', async () => {
  const mgr = await signup(['venue_manager']);
  const incl = await venue(mgr, { currency: 'INR', tax_name: 'GST', tax_rate_bp: 1800, tax_inclusive: true, legal_name: 'Incl Sports Pvt Ltd', tax_id: '27AAAAA0000A1Z5', invoice_prefix: 'INCL' });
  const excl = await venue(mgr, { currency: 'INR', tax_name: 'GST', tax_rate_bp: 1800, tax_inclusive: false });
  const u = await signup();

  const a = must(await book(u, incl.court, 3, 10, 1, { billing: { name: 'Priya Sharma Pvt Ltd', address: '12 MG Road, Pune', tax_id: '27BBBBB1111B1Z2' } }), 201);
  assert.equal(a.bookings[0].price_cents, 100000);
  assert.equal(a.bookings[0].tax_cents, 15254, 'tax extracted from an inclusive price');
  assert.equal(a.bookings[0].payable_cents, 100000);
  assert.equal(a.payable_cents, 100000);
  const b = must(await book(u, excl.court, 3, 10), 201);
  assert.equal(b.bookings[0].price_cents, 100000);
  assert.equal(b.bookings[0].tax_cents, 18000, 'tax added on top');
  assert.equal(b.payable_cents, 118000);

  // invoices: one per venue, gapless numbers, seller snapshot
  assert.equal(a.invoices.length, 1);
  assert.match(a.invoices[0].number, /^INCL-\d{4}-000001$/);
  const a2 = must(await book(u, incl.court, 4, 10), 201);
  assert.match(a2.invoices[0].number, /^INCL-\d{4}-000002$/);
  assert.match(b.invoices[0].number, /^[A-Z0-9]{6}-\d{4}-000001$/, 'generated prefix');
  const doc = must(await api('GET', `/invoices/${a.invoices[0].id}`, { token: u.token }));
  assert.equal(doc.total_cents, 100000);
  assert.equal(doc.tax_cents, 15254);
  assert.equal(doc.seller.name, 'Incl Sports Pvt Ltd');
  assert.equal(doc.seller.tax_id, '27AAAAA0000A1Z5');
  assert.equal(doc.buyer.name, 'Priya Sharma Pvt Ltd');
  assert.equal(doc.buyer.tax_id, '27BBBBB1111B1Z2');
  assert.equal(doc.lines.length, 1);
  assert.equal(doc.status, 'open');
  assert.equal(doc.can_pay_online, false, 'pay-at-venue venue');
  const raw = JSON.stringify((await pool.query('SELECT buyer_enc FROM invoices WHERE id=$1', [doc.id])).rows).concat(JSON.stringify((await pool.query('SELECT billing_enc FROM reservations WHERE id=$1', [a.id])).rows));
  for (const s of ['Priya', 'MG Road', '27BBBBB']) assert.ok(!raw.includes(s), `${s} stored in plaintext`);
  assert.ok((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE entity='invoices' AND action='read_pii'")).rows[0].n >= 1);
  // access: buyer and venue team only
  assert.equal((await api('GET', `/invoices/${doc.id}`, { token: (await signup()).token })).status, 403);
  assert.equal((await api('GET', `/invoices/${doc.id}`, { token: mgr.token })).status, 200);
  assert.equal(must(await api('GET', '/invoices', { token: u.token })).length, 3);
  assert.equal(must(await api('GET', '/invoices', { token: mgr.token, query: { venue_id: incl.v.id } })).length, 2);
  assert.equal((await api('GET', '/invoices', { token: u.token, query: { venue_id: incl.v.id } })).status, 403);

  // quotes show the same tax and invoices without saving anything
  const before = (await pool.query('SELECT count(*)::int AS n FROM invoices')).rows[0].n;
  const q = must(await api('POST', '/reservations/quote', { token: u.token, body: { items: [{ resource_id: excl.court.id, starts_at: at(6, 10), ends_at: at(6, 11) }] } }));
  assert.equal(q.payable_cents, 118000);
  assert.equal(q.tax_cents, 18000);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM invoices')).rows[0].n, before, 'a quote leaves no invoice (and burns no number)');
  assert.match(must(await book(u, excl.court, 7, 10), 201).invoices[0].number, /-000002$/);
});

test('multi-currency basket: one invoice per venue in its own currency; owner summary never mixes currencies', async () => {
  const mgr = await signup(['venue_manager']);
  const inr = await venue(mgr, { currency: 'INR', rate: 120000 });
  const jpy = await venue(mgr, { currency: 'JPY', rate: 5000 });
  const usd = await venue(mgr, { currency: 'USD', rate: 2500 });
  const u = await signup();
  const r = must(await api('POST', '/reservations', { token: u.token, body: { items: [
    { resource_id: inr.court.id, starts_at: at(3, 10), ends_at: at(3, 11) }, { resource_id: jpy.court.id, starts_at: at(3, 10), ends_at: at(3, 12) }, { resource_id: usd.court.id, starts_at: at(3, 10), ends_at: at(3, 11) }] } }), 201);
  assert.equal(r.currency, 'MULTI');
  const by = Object.fromEntries(r.totals.map((t) => [t.currency, t.payable_cents]));
  assert.deepEqual(by, { INR: 120000, JPY: 10000, USD: 2500 }, 'whole yen: 5000 an hour for two hours');
  assert.deepEqual(r.invoices.map((i) => i.currency).sort(), ['INR', 'JPY', 'USD']);
  assert.equal(r.invoices.find((i) => i.currency === 'JPY').total_cents, 10000);
  assert.equal(must(await api('GET', `/reservations/${r.id}`, { token: u.token })).payable_cents, 0, 'no meaningless cross-currency total');

  const sum = must(await api('GET', '/me/venue-summary', { token: mgr.token, query: { from: addDays(today, 0), to: addDays(today, 10) } }));
  assert.equal(sum.venues.length, 3);
  const cur = Object.fromEntries(sum.by_currency.map((c) => [c.currency, c]));
  assert.equal(cur.JPY.revenue_cents, 10000);
  assert.equal(cur.INR.outstanding_cents, 120000);
  assert.equal(sum.by_currency.length, 3);
  // compare: no "cheapest" across currencies
  const cmp = must(await api('GET', '/venue-comparison', { query: { ids: `${inr.v.id},${jpy.v.id}` } }));
  assert.equal(cmp.mixed_currencies, true);
  assert.equal(cmp.highlights.cheapest_venue_id, null);
});

test('paying at the venue, then changes: supplementary invoice, credit note, cash refund', async () => {
  const mgr = await signup(['venue_manager']);
  const { v, court } = await venue(mgr, { currency: 'INR', cancel_free_hours: 24, late_cancel_refund_percent: 50 });
  const u = await signup();
  const r = must(await book(u, court, 4, 10, 2), 201);
  const inv = r.invoices[0];
  assert.equal(inv.total_cents, 200000);
  assert.equal((await api('POST', `/invoices/${inv.id}/paid`, { token: u.token, body: {} })).status, 403);
  must(await api('POST', `/invoices/${inv.id}/paid`, { token: mgr.token, body: { method: 'upi' } }));
  assert.equal((await api('POST', `/invoices/${inv.id}/paid`, { token: mgr.token, body: {} })).status, 409);
  let view = must(await api('GET', `/reservations/${r.id}`, { token: u.token }));
  assert.equal(view.bookings[0].payment_status, 'paid');
  assert.ok(must(await api('GET', '/notifications', { token: u.token })).items.some((x) => x.kind === 'invoice_paid'));
  assert.equal(must(await api('GET', `/invoices/${inv.id}`, { token: u.token })).payment_method, 'upi');

  // longer booking: the extra hour is a new invoice (the paid one is never rewritten)
  const bid = view.bookings[0].id;
  must(await api('PATCH', `/bookings/${bid}`, { token: u.token, body: { ends_at: at(4, 13) } }));
  view = must(await api('GET', `/reservations/${r.id}`, { token: u.token }));
  const open = view.invoices.filter((i) => i.status === 'open');
  assert.equal(open.length, 1);
  assert.equal(open[0].total_cents, 100000);
  assert.equal(view.invoices.find((i) => i.id === inv.id).total_cents, 200000);
  assert.equal(view.bookings[0].payment_status, 'unpaid', 'the booking is only settled when everything is paid');
  must(await api('POST', `/invoices/${open[0].id}/paid`, { token: mgr.token, body: { method: 'cash' } }));

  // shorter again: a credit note, returned in cash by the venue
  must(await api('PATCH', `/bookings/${bid}`, { token: u.token, body: { ends_at: at(4, 11) } }));
  view = must(await api('GET', `/reservations/${r.id}`, { token: u.token }));
  const cn = view.invoices.find((i) => i.kind === 'credit_note');
  assert.ok(cn);
  assert.equal(cn.total_cents, 200000);
  assert.equal(cn.refund_status, 'manual');
  assert.match(cn.number, /^CN-/);
  assert.equal((await api('POST', `/invoices/${cn.id}/refunded`, { token: u.token })).status, 403);
  must(await api('POST', `/invoices/${cn.id}/refunded`, { token: mgr.token }));
  assert.equal((await api('POST', `/invoices/${cn.id}/refunded`, { token: mgr.token })).status, 409);

  // late cancellation (inside the free window): 50% credited, 50% kept as a fee, and the fee stays owed/paid
  const soon = new Date(Date.now() + 5 * 3600e3); soon.setUTCMinutes(0, 0, 0);
  const s = must(await api('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: court.id, starts_at: soon.toISOString(), ends_at: new Date(+soon + 3600e3).toISOString() }] } }), 201);
  must(await api('POST', `/invoices/${s.invoices[0].id}/paid`, { token: mgr.token, body: { method: 'cash' } }));
  const c = must(await api('DELETE', `/bookings/${s.bookings[0].id}`, { token: u.token }));
  assert.equal(c.refund_cents, 50000);
  const after = must(await api('GET', `/reservations/${s.id}`, { token: u.token }));
  assert.deepEqual(after.invoices.map((i) => [i.kind, i.total_cents, i.status]).sort(), [['credit_note', 50000, 'paid'], ['invoice', 100000, 'paid']]);
  // numbering stayed gapless per kind
  const nums = (await pool.query("SELECT number FROM invoices WHERE venue_id=$1 AND kind='invoice' ORDER BY number", [v.id])).rows.map((x) => Number(x.number.split('-').pop()));
  assert.deepEqual(nums, nums.map((_, i) => i + 1));
});

test('online payment in the venue currency: Stripe checkout, confirm, partial refund on cancel, retries', async () => {
  const mgr = await signup(['venue_manager']);
  const jpy = await venue(mgr, { currency: 'JPY', rate: 5000, payment_mode: 'online_optional', cancel_free_hours: 24, late_cancel_refund_percent: 50 });
  const u = await signup();
  const r = must(await book(u, jpy.court, 5, 10, 2), 201);
  assert.equal(r.invoices[0].total_cents, 10000);
  assert.equal(r.payment_deadline, null, 'optional online payment holds nothing');
  const invId = r.invoices[0].id;

  // someone else can't pay it; pay-at-venue venues refuse online payment
  assert.equal((await api('POST', '/payments', { token: (await signup()).token, body: { purpose_type: 'venue_invoice', purpose_id: invId, provider: 'stripe' } })).status, 403);
  const p = must(await api('POST', '/payments', { token: u.token, body: { purpose_type: 'venue_invoice', purpose_id: invId, provider: 'stripe', return_url: 'http://app.test/' } }), 201);
  assert.equal(p.currency, 'JPY');
  assert.equal(p.amount_cents, 10000);
  const session = Object.values(fake.sessions).at(-1);
  assert.equal(session.currency, 'jpy');
  assert.equal(session.amount_total, 10000, 'zero-decimal currency: whole yen, no x100');
  session.payment_status = 'paid';
  const done = must(await api('POST', `/payments/${p.id}/confirm`, { token: u.token, body: {} }));
  assert.equal(done.status, 'paid');
  assert.equal(done.purpose_type, 'venue_invoice');
  assert.equal(must(await api('GET', `/invoices/${invId}`, { token: u.token })).payment_method, 'online');
  assert.equal(must(await api('GET', `/reservations/${r.id}`, { token: u.token })).bookings[0].payment_status, 'paid');

  // PayPal formats amounts for the currency too (no decimals for yen)
  const r2 = must(await book(u, jpy.court, 6, 10, 1), 201);
  must(await api('POST', '/payments', { token: u.token, body: { purpose_type: 'venue_invoice', purpose_id: r2.invoices[0].id, provider: 'paypal', return_url: 'http://app.test/' } }), 201);
  assert.deepEqual(fake.paypalOrders.at(-1), { currency_code: 'JPY', value: '5000' });

  // a refund that the provider rejects stays pending, then goes through; it is partial and idempotent
  const soon = new Date(Date.now() + 5 * 3600e3); soon.setUTCMinutes(0, 0, 0);
  const s = must(await api('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: jpy.court.id, starts_at: soon.toISOString(), ends_at: new Date(+soon + 7200e3).toISOString() }] } }), 201);
  const sp = must(await api('POST', '/payments', { token: u.token, body: { purpose_type: 'venue_invoice', purpose_id: s.invoices[0].id, provider: 'stripe', return_url: 'http://app.test/' } }), 201);
  Object.values(fake.sessions).at(-1).payment_status = 'paid';
  must(await api('POST', `/payments/${sp.id}/confirm`, { token: u.token, body: {} }));
  fake.failRefunds = 1;
  const cancelled = must(await api('DELETE', `/bookings/${s.bookings[0].id}`, { token: u.token }));
  assert.equal(cancelled.refund_cents, 5000, 'late: half of 10000 yen');
  const cn = (await pool.query("SELECT * FROM invoices WHERE kind='credit_note' AND reservation_id=$1", [s.id])).rows[0];
  assert.equal(cn.total_cents, 5000);
  await wait(async () => (await pool.query("SELECT refund_attempts FROM invoices WHERE id=$1", [cn.id])).rows[0].refund_attempts >= 1);
  await wait(async () => (await pool.query('SELECT refund_status, refund_claimed_at FROM invoices WHERE id=$1', [cn.id])).rows.map((r) => r.refund_status === 'pending' && r.refund_claimed_at === null)[0]);
  const worker = await processRefunds();
  assert.equal(worker.done, 1);
  const row = (await pool.query('SELECT * FROM invoices WHERE id=$1', [cn.id])).rows[0];
  assert.equal(row.refund_status, 'done');
  assert.equal(fake.refunds.at(-1).amount, 5000);
  assert.equal(fake.refunds.at(-1).intent, Object.values(fake.sessions).at(-1).payment_intent, 'refunded against the right payment');
  assert.match(fake.refunds.at(-1).key, /^refund-cn-/);
  const pay = (await pool.query('SELECT * FROM payments WHERE id=$1', [sp.id])).rows[0];
  assert.equal(pay.refunded_cents, 5000);
  assert.equal(pay.status, 'paid', 'only partly refunded');
  assert.equal(await processRefunds().then((x) => x.done), 0, 'nothing is refunded twice');
  assert.ok(must(await api('GET', '/notifications', { token: u.token })).items.some((x) => x.kind === 'refund_issued'));
});

test('online-required venues hold slots for a few minutes, release them unpaid, and keep paid ones', async () => {
  const mgr = await signup(['venue_manager']);
  const { v, court } = await venue(mgr, { currency: 'INR', payment_mode: 'online_required' });
  const u = await signup(), w = await signup();
  const r = must(await book(u, court, 8, 10), 201);
  assert.ok(r.payment_deadline);
  assert.ok(r.awaiting_payment);
  assert.equal((await book(w, court, 8, 10)).status, 409, 'the slot is held meanwhile');

  // not paid in time: released, customer told, slot free again
  await pool.query("UPDATE reservations SET payment_deadline = now() - interval '1 minute' WHERE id=$1", [r.id]);
  const cycle = await maintenanceCycle();
  assert.equal(cycle.holds_released, 1);
  const view = must(await api('GET', `/reservations/${r.id}`, { token: u.token }));
  assert.equal(view.status, 'cancelled');
  assert.equal(view.bookings[0].status, 'cancelled');
  assert.equal(view.invoices[0].status, 'void');
  assert.equal(view.bookings[0].refund_cents, view.bookings[0].payable_cents, 'nothing charged');
  assert.ok(must(await api('GET', '/notifications', { token: u.token })).items.some((x) => x.kind === 'booking_expired'));
  must(await book(w, court, 8, 10), 201);

  // paid in time: the deadline goes away and nothing is released
  const r2 = must(await book(u, court, 9, 10), 201);
  const p = must(await api('POST', '/payments', { token: u.token, body: { purpose_type: 'venue_invoice', purpose_id: r2.invoices[0].id, provider: 'stripe', return_url: 'http://app.test/' } }), 201);
  Object.values(fake.sessions).at(-1).payment_status = 'paid';
  must(await api('POST', `/payments/${p.id}/confirm`, { token: u.token, body: {} }));
  assert.equal((await pool.query('SELECT payment_deadline FROM reservations WHERE id=$1', [r2.id])).rows[0].payment_deadline, null);
  assert.equal((await maintenanceCycle()).holds_released, 0);

  // a payment that lands after the slots were released is refunded automatically, not kept
  const r3 = must(await book(u, court, 10, 10), 201);
  const late = must(await api('POST', '/payments', { token: u.token, body: { purpose_type: 'venue_invoice', purpose_id: r3.invoices[0].id, provider: 'stripe', return_url: 'http://app.test/' } }), 201);
  await pool.query("UPDATE reservations SET payment_deadline = now() - interval '1 minute' WHERE id=$1", [r3.id]);
  await maintenanceCycle();
  Object.values(fake.sessions).at(-1).payment_status = 'paid';
  const refundsBefore = fake.refunds.length;
  assert.equal(must(await api('POST', `/payments/${late.id}/confirm`, { token: u.token, body: {} })).status, 'refunded');
  assert.equal(fake.refunds.length, refundsBefore + 1);
  void v;
});
