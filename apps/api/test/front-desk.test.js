import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// ---- stand-in for the Stripe HTTP API ----
const fake = { sessions: {}, refunds: [], n: 0 };
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
  if (req.url === '/v1/refunds') { const f = new URLSearchParams(raw); fake.refunds.push({ intent: f.get('payment_intent'), amount: Number(f.get('amount')), key: req.headers['idempotency-key'] }); return send(200, { id: 're_1' }); }
  send(404, {});
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp',
  STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_API_BASE: `http://127.0.0.1:${provider.address().port}`, APP_URL: 'http://app.test', CORS_ORIGINS: 'http://app.test',
});
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { fromLocal, addDays } = await import('../src/booking/time.js');
const { processRefunds } = await import('../src/booking/refunds.js');
const { markInvoicePaid } = await import('../src/booking/invoices.js');
const { allocate, discountCents, priceLine, shareOf } = await import('../src/pos/pricing.js');
const { expireStaleSales } = await import('../src/pos/sale.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `fd_${n}_${roles[0]}`, display_name: `FD ${n}`, email: `fd${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const today = new Date().toISOString().slice(0, 10);
const at = (d, h) => fromLocal(addDays(today, d), h * 60, 'UTC').toISOString();
const wait = async (fn, ms = 4000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)); } };
const q = async (sql, p = []) => (await pool.query(sql, p)).rows;

/** A venue with a team: owner (manager), a manager, a cashier — and stock that exercises every kind of line. */
async function desk(over = {}) {
  const mgr = await signup(['venue_manager']), cashier = await signup(), outsider = await signup();
  const v = must(await api('POST', '/venues', { token: mgr.token, body: { name: `Desk Arena ${Math.random().toString(36).slice(2, 6)}`, timezone: 'UTC', currency: 'INR', tax_name: 'GST', tax_rate_bp: 1800, tax_inclusive: true, legal_name: 'Desk Sports Pvt Ltd', tax_id: '27AAAAA0000A1Z5', ...over } }), 201);
  const court = must(await api('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'Court 1', hourly_rate_cents: 50000 } }), 201);
  must(await api('POST', `/venues/${v.id}/pos/cashiers`, { token: mgr.token, body: { handle: cashier.handle } }), 201);
  const item = async (body) => must(await api('POST', '/inventory', { token: mgr.token, body: { ...body, venue_id: v.id } }), 201);
  const tube = await item({ name: 'Shuttle tube', category: 'merch', quantity: 20, sell_price_cents: 30000, unit_cost_cents: 20000 });
  const drink = await item({ name: 'Sports drink', category: 'food_beverage', quantity: 50, sell_price_cents: 5000, unit_cost_cents: 2000 });
  const racket = await item({ name: 'Racket', category: 'equipment', stock_kind: 'rental', quantity: 5, rental_fee_cents: 10000, deposit_cents: 50000 });
  const plan = must(await api('POST', `/venues/${v.id}/plans`, { token: mgr.token, body: { kind: 'membership', name: 'Gold', price_cents: 100000, duration_days: 30, discount_bp: 1000 } }), 201);
  const sell = (u, body, status = 201) => api('POST', `/venues/${v.id}/pos/sales`, { token: u.token, body }).then((r) => (status ? must(r, status) : r));
  const stock = async (it) => (await q('SELECT quantity, damaged_qty FROM inventory_items WHERE id=$1', [it.id]))[0];
  return { mgr, cashier, outsider, v, court, tube, drink, racket, plan, sell, stock };
}

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); provider.close(); await pool.end(); });

test('money maths: allocation adds up to the cent, discounts cap, partial returns absorb rounding', () => {
  assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]);
  assert.equal(allocate(7, [5, 3, 2]).reduce((a, b) => a + b, 0), 7);
  assert.deepEqual(allocate(10, [0, 0]), [0, 0]);
  assert.equal(discountCents({ kind: 'percent', value: 12.5 }, 80000), 10000);
  assert.equal(discountCents({ kind: 'fixed', value: 999999 }, 5000), 5000, 'never more than the goods');
  assert.deepEqual(priceLine({ unit: 30000, qty: 2, discount: 6000, rateBp: 1800, inclusive: true }), { gross: 60000, discount: 6000, tax: 8237, total: 54000 });
  assert.deepEqual(priceLine({ unit: 10000, qty: 1, rateBp: 1800, inclusive: false }), { gross: 10000, discount: 0, tax: 1800, total: 11800 });
  assert.equal(priceLine({ unit: 50000, qty: 1, rateBp: 1800, inclusive: true, taxable: false }).tax, 0, 'deposits carry no tax');
  assert.equal([1, 1, 1].map((x, i) => shareOf(10000, 3, i, 1)).reduce((a, b) => a + b, 0), 10000, 'returning every unit gives back exactly the line');
});

test('walk-in court, racket rental, shuttlecocks, a drink and cash — one workflow, every record canonical', async () => {
  const d = await desk();
  const shift = must(await api('POST', `/venues/${d.v.id}/pos/shifts`, { token: d.cashier.token, body: { opening_float_cents: 100000 } }), 201);
  assert.equal(shift.expected_cash_cents, 100000);
  const lines = [
    { kind: 'booking', resource_id: d.court.id, starts_at: at(1, 10), ends_at: at(1, 11) },
    { kind: 'rental', item_id: d.racket.id, qty: 1 }, { kind: 'item', item_id: d.tube.id, qty: 2 }, { kind: 'item', item_id: d.drink.id, qty: 1 },
  ];
  // the quote runs the real code and rolls it back
  const quote = must(await api('POST', `/venues/${d.v.id}/pos/quote`, { token: d.cashier.token, body: { lines, guest_name: 'Ravi' } }), 200);
  assert.equal(quote.quote, true);
  assert.equal(quote.total_cents, 175000);
  assert.deepEqual(await d.stock(d.tube), { quantity: 20, damaged_qty: 0 }, 'a quote reserves nothing');
  assert.equal((await q('SELECT count(*)::int AS n FROM pos_sales'))[0].n, 0);

  const sale = await d.sell(d.cashier, { lines, guest_name: 'Ravi', guest_phone: '+919800000000', payments: [{ method: 'cash', tendered_cents: 200000 }], client_ref: 'device-1-sale-1' });
  assert.equal(sale.status, 'paid');
  assert.equal(sale.total_cents, 175000);
  assert.equal(sale.amount_due_cents, 0);
  assert.equal(sale.guest, null, 'personal details are not echoed on every response');
  assert.equal(sale.has_guest, true);
  assert.equal(must(await api('GET', `/pos/sales/${sale.id}`, { token: d.cashier.token })).guest.name, 'Ravi', 'the team reads them from the sale itself (audit-logged)');
  assert.deepEqual(sale.lines.map((l) => l.category).sort(), ['court', 'deposit', 'food_beverage', 'merch', 'rental']);
  // POS owns no money: the court is a real reservation and both documents are numbered, paid invoices
  assert.ok(sale.reservation_id);
  assert.equal(sale.documents.length, 2);
  assert.ok(sale.documents.every((x) => x.status === 'paid' && x.payment_method === 'cash' && /^[A-Z0-9]+-\d{4}-\d{6}$/.test(x.number)));
  assert.equal((await q("SELECT payment_status FROM bookings WHERE reservation_id=$1", [sale.reservation_id]))[0].payment_status, 'paid');
  // stock drew down; the racket is rental kit, so it is out on loan rather than sold
  assert.deepEqual(await d.stock(d.tube), { quantity: 18, damaged_qty: 0 });
  assert.equal((await d.stock(d.drink)).quantity, 49);
  assert.equal((await d.stock(d.racket)).quantity, 4);
  assert.deepEqual(sale.rentals.map((r) => [r.status, r.deposit_status, Number(r.deposit_cents)]), [['issued', 'held', 50000]]);
  // receipt
  const rc = must(await api('GET', `/pos/sales/${sale.id}/receipt`, { token: d.cashier.token }));
  assert.equal(rc.seller.tax_id, '27AAAAA0000A1Z5');
  assert.equal(rc.totals.total_cents, 175000);
  assert.equal(rc.payments[0].change_cents, 25000);
  assert.equal(rc.payments[0].confirmed_by, 'staff (recorded by hand)');
  assert.match(rc.text, /Total INR 1750\.00/);
  assert.match(rc.notice, /#503/);
  assert.equal(must(await api('POST', `/pos/sales/${sale.id}/receipt`, { token: d.cashier.token, body: { channel: 'whatsapp' } })).whatsapp_url.startsWith('https://wa.me/919800000000?text='), true);
  // a guest's bill is billed to the cashier but is neither theirs to see nor to pay
  assert.equal(must(await api('GET', '/invoices', { token: d.cashier.token })).length, 0, 'walk-in invoices are not the cashier\'s own');
  const goods = sale.documents.find((x) => x.role === 'goods');
  assert.equal((await api('POST', `/invoices/${goods.id}/paid`, { token: d.mgr.token, body: {} })).status, 400, 'a desk invoice is only paid through its sale');
  // the drawer: float + the cash applied (change is not income)
  const sh = must(await api('GET', `/pos/shifts/${shift.id}`, { token: d.cashier.token }));
  assert.equal(sh.expected_cash_cents, 275000);
  // a replay of the same device key is the same sale, not a second one
  const again = await d.sell(d.cashier, { lines, client_ref: 'device-1-sale-1' });
  assert.equal(again.id, sale.id);
  assert.equal(again.replayed, true);
  assert.equal((await d.stock(d.tube)).quantity, 18);
  // venue-level audit trail of the guest read
  assert.ok((await q("SELECT 1 FROM audit_log WHERE action='read_pii' AND entity='pos_sales' AND entity_id=$1", [sale.id])).length);
});

test('the last units: parallel tills can never sell the same stock twice', async () => {
  const d = await desk();
  const grips = must(await api('POST', '/inventory', { token: d.mgr.token, body: { venue_id: d.v.id, name: 'Grips', category: 'other', quantity: 3, sell_price_cents: 1000 } }), 201);
  const rs = await Promise.all(Array.from({ length: 8 }, () => d.sell(d.cashier, { lines: [{ kind: 'item', item_id: grips.id, qty: 1 }], payments: [{ method: 'cash' }] }, null)));
  assert.equal(rs.filter((r) => r.status === 201).length, 3);
  assert.equal(rs.filter((r) => r.status === 409).length, 5);
  assert.equal((await d.stock(grips)).quantity, 0);
  assert.equal((await q("SELECT count(*)::int AS n FROM pos_sales s JOIN pos_sale_lines l ON l.sale_id=s.id WHERE l.item_id=$1", [grips.id]))[0].n, 3, 'a refused sale leaves nothing behind');
  const ledger = (await q('SELECT coalesce(sum(delta),0)::int AS n FROM pos_stock_moves WHERE item_id=$1', [grips.id]))[0].n;
  assert.equal(ledger, 0, 'opening +3, three sales −3: the ledger explains the quantity');
  assert.throws(() => { throw new Error('x'); });
  await assert.rejects(pool.query('UPDATE pos_stock_moves SET delta = 5 WHERE item_id=$1', [grips.id]), /append-only/);
});

test('online payments stay pending until the provider confirms; late and refunded money is handled', async () => {
  const d = await desk();
  const sale = await d.sell(d.cashier, { lines: [{ kind: 'item', item_id: d.tube.id, qty: 2 }] });
  assert.equal(sale.status, 'awaiting_payment');
  assert.equal(sale.amount_due_cents, 60000);
  assert.equal((await d.stock(d.tube)).quantity, 18, 'stock is held while the customer pays');
  // staff can never "record" an online payment
  assert.equal((await api('POST', `/pos/sales/${sale.id}/payments`, { token: d.cashier.token, body: { method: 'online', amount_cents: 60000 } })).status, 400);
  const co = must(await api('POST', `/pos/sales/${sale.id}/online-payment`, { token: d.cashier.token, body: { provider: 'stripe', return_url: 'http://app.test/' } }), 200);
  assert.match(co.checkout_url, /checkout\.stripe\.test/);
  assert.equal(co.amount_cents, 60000);
  const pending = must(await api('GET', `/pos/sales/${sale.id}`, { token: d.cashier.token }));
  assert.equal(pending.pending_online, true);
  assert.equal((await api('POST', `/pos/sales/${sale.id}/payments`, { token: d.cashier.token, body: { method: 'cash', amount_cents: 1000 } })).status, 409, 'no double tender while the checkout is open');
  assert.equal(must(await api('POST', `/pos/sales/${sale.id}/online-payment/confirm`, { token: d.cashier.token, body: {} })).status, 'awaiting_payment', 'the provider has not said yes');
  Object.values(fake.sessions).at(-1).payment_status = 'paid';
  const done = must(await api('POST', `/pos/sales/${sale.id}/online-payment/confirm`, { token: d.cashier.token, body: {} }));
  assert.equal(done.status, 'paid');
  assert.equal(done.payments.find((p) => p.method === 'online').status, 'confirmed');
  assert.equal(done.documents[0].payment_method, 'online');
  // refund to the original payment: a credit note, never an edit of the invoice
  const ref = must(await api('POST', `/pos/sales/${sale.id}/refund`, { token: d.mgr.token, body: { lines: [{ line_id: done.lines[0].id, qty: 1 }], method: 'original', reason: 'Wrong tube' } }));
  const cnRow = ref.credit_notes_issued[0];
  assert.equal(cnRow.refund_status, 'pending');
  await wait(async () => (await q('SELECT 1 FROM invoices WHERE id=$1 AND refund_status=\'done\'', [cnRow.id])).length) ;
  await processRefunds();
  assert.equal(fake.refunds.at(-1).amount, 30000);
  const inv = (await q("SELECT * FROM invoices WHERE id=$1", [done.documents[0].id]))[0];
  assert.equal(inv.status, 'paid');
  assert.equal(inv.total_cents, 60000, 'the issued invoice is untouched');
  const cn = (await q("SELECT * FROM invoices WHERE id=$1", [cnRow.id]))[0];
  assert.equal(cn.parent_id, inv.id);
  assert.equal(cn.refund_status, 'done');
  assert.equal((await d.stock(d.tube)).quantity, 19, 'the returned tube is back on the shelf');
  // court time paid online is refunded to that same payment through the booking engine's credit note
  const court = await d.sell(d.cashier, { lines: [{ kind: 'booking', resource_id: d.court.id, starts_at: at(8, 10), ends_at: at(8, 11) }, { kind: 'item', item_id: d.drink.id, qty: 1 }] });
  assert.equal(court.total_cents, 55000);
  must(await api('POST', `/pos/sales/${court.id}/online-payment`, { token: d.cashier.token, body: { provider: 'stripe', return_url: 'http://app.test/' } }));
  Object.values(fake.sessions).at(-1).payment_status = 'paid';
  const paidCourt = must(await api('POST', `/pos/sales/${court.id}/online-payment/confirm`, { token: d.cashier.token, body: {} }));
  assert.equal(paidCourt.status, 'paid');
  assert.ok(paidCourt.documents.every((x) => x.status === 'paid' && x.payment_method === 'online'));
  const refunded = fake.refunds.length;
  const bookingLine = paidCourt.lines.find((l) => l.kind === 'booking');
  const back = must(await api('POST', `/pos/sales/${court.id}/refund`, { token: d.mgr.token, body: { lines: [{ line_id: bookingLine.id }], method: 'original', reason: 'Rained off' } }));
  assert.equal(back.refunds[0].refund_status === 'pending' || back.refunds[0].refund_status === 'done', true, JSON.stringify(back.refunds));
  await wait(async () => fake.refunds.length > refunded);
  await processRefunds();
  assert.equal(fake.refunds.at(-1).amount, 50000, 'the card gets back exactly the court time');
  assert.equal(fake.refunds.at(-1).intent, Object.values(fake.sessions).at(-1).payment_intent, 'against the sale\'s own online payment');
  // a payment that lands after the sale was voided is refunded, not kept
  const late = await d.sell(d.cashier, { lines: [{ kind: 'item', item_id: d.drink.id, qty: 2 }] });
  must(await api('POST', `/pos/sales/${late.id}/online-payment`, { token: d.cashier.token, body: { provider: 'stripe', return_url: 'http://app.test/' } }));
  must(await api('POST', `/pos/sales/${late.id}/void`, { token: d.cashier.token, body: { reason: 'Customer left' } }));
  assert.equal((await d.stock(d.drink)).quantity, 49, 'void restores the stock (one drink went with the court sale)');
  const before = fake.refunds.length;
  Object.values(fake.sessions).at(-1).payment_status = 'paid';
  must(await api('POST', `/pos/sales/${late.id}/online-payment/confirm`, { token: d.cashier.token, body: {} }));
  assert.equal(fake.refunds.length, before + 1, 'money for a void sale goes straight back');
  assert.equal((await q("SELECT status FROM payments WHERE purpose_id=$1", [late.id]))[0].status, 'refunded');
  // an abandoned online sale is released by the worker
  const stale = await d.sell(d.cashier, { lines: [{ kind: 'item', item_id: d.drink.id, qty: 3 }] });
  must(await api('POST', `/pos/sales/${stale.id}/online-payment`, { token: d.cashier.token, body: { provider: 'stripe', return_url: 'http://app.test/' } }));
  await pool.query("UPDATE pos_sales SET created_at = now() - interval '3 hours' WHERE id=$1", [stale.id]);
  await pool.query("UPDATE pos_sale_payments SET created_at = now() - interval '3 hours' WHERE sale_id=$1", [stale.id]);
  assert.equal(await expireStaleSales(), 1);
  assert.equal((await d.stock(d.drink)).quantity, 49);
  // the clock is the last attempt, not the sale: a customer who is paying right now is never released
  const slow = await d.sell(d.cashier, { lines: [{ kind: 'item', item_id: d.drink.id, qty: 1 }] });
  await pool.query("UPDATE pos_sales SET created_at = now() - interval '3 hours' WHERE id=$1", [slow.id]);
  must(await api('POST', `/pos/sales/${slow.id}/online-payment`, { token: d.cashier.token, body: { provider: 'stripe', return_url: 'http://app.test/' } }));
  assert.equal(await expireStaleSales(), 0);
  assert.equal(must(await api('GET', `/pos/sales/${slow.id}`, { token: d.cashier.token })).status, 'awaiting_payment');
});

test('cash drawer: float, movements need reasons and approvals, immutable close, variance review', async () => {
  const d = await desk();
  const open = must(await api('POST', `/venues/${d.v.id}/pos/shifts`, { token: d.cashier.token, body: { opening_float_cents: 50000 } }), 201);
  assert.equal((await api('POST', `/venues/${d.v.id}/pos/shifts`, { token: d.mgr.token, body: { opening_float_cents: 1 } })).status, 409, 'one drawer open at a time');
  await d.sell(d.cashier, { lines: [{ kind: 'item', item_id: d.tube.id, qty: 1 }], payments: [{ method: 'cash' }] });
  const out = (body) => api('POST', `/pos/shifts/${open.id}/cash-moves`, { token: d.cashier.token, body });
  const refused = await out({ kind: 'paid_out', amount_cents: 5000, reason: 'Ice delivery' });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'approval_required');
  const ok = must(await api('POST', `/venues/${d.v.id}/pos/approvals`, { token: d.mgr.token, body: { kind: 'paid_out', max_amount_cents: 5000, reason: 'Ice for the bar' } }), 201);
  must(await out({ kind: 'paid_out', amount_cents: 5000, reason: 'Ice delivery', approval_id: ok.id }), 201);
  assert.equal((await out({ kind: 'paid_out', amount_cents: 1000, reason: 'Again', approval_id: ok.id })).status, 403, 'an approval is single-use');
  assert.equal((await out({ kind: 'float_added', amount_cents: 1000, reason: 'Top up' })).status, 403, 'only a manager adds to the float');
  assert.equal((await out({ kind: 'cash_drop', amount_cents: 9999999, reason: 'Too much' })).status, 409, 'cannot take out more than the drawer holds');
  must(await out({ kind: 'cash_drop', amount_cents: 10000, reason: 'To the safe' }), 201);
  const live = must(await api('GET', `/pos/shifts/${open.id}`, { token: d.cashier.token }));
  assert.equal(live.expected_cash_cents, 50000 + 30000 - 5000 - 10000);
  assert.equal(live.cash_moves.length, 2);
  // close: a difference needs a note, the variance is frozen, a manager reviews it
  const close = (body) => api('POST', `/pos/shifts/${open.id}/close`, { token: d.cashier.token, body });
  assert.equal((await close({ counted_cash_cents: 64000 })).status, 400);
  const closed = must(await close({ counted_cash_cents: 64000, note: 'A 10 note is missing' }));
  assert.equal(closed.status, 'closed');
  assert.equal(closed.expected_cash_cents, 65000);
  assert.equal(Number(closed.variance_cents), -1000);
  assert.equal(closed.review_status, 'pending');
  await assert.rejects(pool.query('UPDATE pos_shifts SET counted_cash_cents = 65000, variance_cents = 0 WHERE id=$1', [open.id]), /immutable/);
  await assert.rejects(pool.query('DELETE FROM pos_shifts WHERE id=$1', [open.id]), /never deleted/);
  assert.equal((await api('POST', `/pos/shifts/${open.id}/review`, { token: d.cashier.token, body: { decision: 'approve', note: 'fine by me' } })).status, 403);
  const rv = must(await api('POST', `/pos/shifts/${open.id}/review`, { token: d.mgr.token, body: { decision: 'dispute', note: 'Counted again: still short' } }));
  assert.equal(rv.review_status, 'disputed');
  assert.equal((await api('POST', `/pos/shifts/${open.id}/review`, { token: d.mgr.token, body: { decision: 'approve', note: 'changed my mind' } })).status, 409, 'the review is final');
  assert.equal((await api('POST', `/pos/shifts/${open.id}/cash-moves`, { token: d.mgr.token, body: { kind: 'cash_drop', amount_cents: 1, reason: 'late' } })).status, 409);
  // a venue can insist on a shift before cash is taken
  must(await api('PATCH', `/venues/${d.v.id}/pos/settings`, { token: d.mgr.token, body: { require_shift: true } }));
  assert.equal((await d.sell(d.cashier, { lines: [{ kind: 'item', item_id: d.tube.id }], payments: [{ method: 'cash' }] }, null)).status, 409);
});

test('discounts: cashier limit, single-use manager approval, audited; refunds reverse invoice, cash and stock', async () => {
  const d = await desk();
  must(await api('POST', `/venues/${d.v.id}/pos/shifts`, { token: d.cashier.token, body: { opening_float_cents: 0 } }), 201);
  const cart = (discount) => ({ lines: [{ kind: 'item', item_id: d.tube.id, qty: 3 }], discount, payments: [{ method: 'cash' }] });
  const small = await d.sell(d.cashier, cart({ kind: 'percent', value: 10, reason: 'Regular' }));
  assert.equal(small.discount_cents, 9000);
  assert.equal(small.total_cents, 81000);
  const big = await d.sell(d.cashier, cart({ kind: 'percent', value: 40, reason: 'Damaged box' }), null);
  assert.equal(big.status, 403);
  assert.equal(big.body.error.code, 'approval_required');
  // a quote prices the cart and says an approval will be needed — it neither refuses nor consumes anything
  const priced = must(await api('POST', `/venues/${d.v.id}/pos/quote`, { token: d.cashier.token, body: { lines: [{ kind: 'item', item_id: d.tube.id, qty: 3 }], discount: { kind: 'percent', value: 40, reason: 'Damaged box' } } }));
  assert.equal(priced.needs_approval, true);
  assert.equal(priced.discount_cents, 36000);
  assert.equal(priced.total_cents, 54000);
  const ap = must(await api('POST', `/venues/${d.v.id}/pos/approvals`, { token: d.mgr.token, body: { kind: 'discount', max_amount_cents: 20000, reason: 'Damaged box' } }), 201);
  assert.equal((await d.sell(d.cashier, cart({ kind: 'percent', value: 40, reason: 'Damaged box', approval_id: ap.id }), null)).status, 403, 'the approval covers up to 200, not 360');
  const ap2 = must(await api('POST', `/venues/${d.v.id}/pos/approvals`, { token: d.mgr.token, body: { kind: 'discount', max_amount_cents: 40000, reason: 'Damaged box' } }), 201);
  const approved = await d.sell(d.cashier, cart({ kind: 'percent', value: 40, reason: 'Damaged box', approval_id: ap2.code }));
  assert.match(ap2.code, /^\d{6}$/, 'a manager reads out a 6-digit code');
  assert.equal(approved.discount_reason, 'Damaged box');
  assert.ok(approved.discount_approved_by);
  assert.equal((await d.sell(d.cashier, cart({ kind: 'percent', value: 40, reason: 'Again', approval_id: ap2.id }), null)).status, 403, 'used');
  const mgrSale = await d.sell(d.mgr, cart({ kind: 'fixed', value: 50000, reason: 'Owner\'s call' }));
  assert.equal(mgrSale.discount_cents, 50000);
  assert.ok((await q("SELECT 1 FROM audit_log WHERE action='pos_discount' AND entity_id=$1", [approved.id])).length);
  // refund 2 of the 3 tubes from the 10%-off sale: the credit note is the discounted value, cash leaves the drawer, the tubes go back
  const line = small.lines[0];
  const refuse = await api('POST', `/pos/sales/${small.id}/refund`, { token: d.cashier.token, body: { lines: [{ line_id: line.id, qty: 2 }], method: 'cash', reason: 'Wrong brand' } });
  assert.equal(refuse.body.error.code, 'approval_required', 'refund limit unset: a cashier always needs approval');
  const rap = must(await api('POST', `/venues/${d.v.id}/pos/approvals`, { token: d.mgr.token, body: { kind: 'refund', max_amount_cents: 100000, reason: 'Wrong brand' } }), 201);
  const stockBefore = (await d.stock(d.tube)).quantity;
  const ref = must(await api('POST', `/pos/sales/${small.id}/refund`, { token: d.cashier.token, body: { lines: [{ line_id: line.id, qty: 2 }], method: 'cash', reason: 'Wrong brand', approval_id: rap.id } }));
  assert.equal(ref.credit_notes_issued[0].refund_status, 'done');
  assert.equal(ref.refunded_cents, 54000, '2/3 of 81 000');
  assert.equal((await d.stock(d.tube)).quantity, stockBefore + 2);
  assert.equal(ref.lines[0].returned_qty, 2);
  assert.equal((await api('POST', `/pos/sales/${small.id}/refund`, { token: d.mgr.token, body: { lines: [{ line_id: line.id, qty: 2 }], method: 'cash', reason: 'Too many' } })).status, 409, 'only one tube left to return');
  const orig = (await q('SELECT status, total_cents FROM invoices WHERE id=$1', [small.documents[0].id]))[0];
  assert.deepEqual([orig.status, Number(orig.total_cents)], ['paid', 81000]);
  const shift = must(await api('GET', `/venues/${d.v.id}/pos/shift`, { token: d.cashier.token }));
  assert.equal(shift.cash_refunded_cents, 54000);
  assert.equal(shift.expected_cash_cents, shift.cash_received_cents - 54000);
});

test('rental kit: issue, return, damage and loss keep their own state, stock and deposit — and are never sold', async () => {
  const d = await desk();
  must(await api('POST', `/venues/${d.v.id}/pos/shifts`, { token: d.cashier.token, body: { opening_float_cents: 0 } }), 201);
  assert.equal((await d.sell(d.cashier, { lines: [{ kind: 'item', item_id: d.racket.id }], payments: [{ method: 'cash' }] }, null)).status, 400, 'kit is rented, not sold');
  assert.equal((await d.sell(d.cashier, { lines: [{ kind: 'rental', item_id: d.tube.id }], payments: [{ method: 'cash' }] }, null)).status, 400, 'a consumable is not rental kit');
  const sale = await d.sell(d.cashier, { lines: [{ kind: 'rental', item_id: d.racket.id, qty: 3 }], payments: [{ method: 'cash' }] });
  assert.equal(sale.total_cents, 3 * 60000);
  assert.equal((await d.stock(d.racket)).quantity, 2);
  const [a, b, c] = sale.rentals;
  assert.ok(sale.rentals.every((r) => r.status === 'issued'));
  const back = must(await api('POST', `/pos/rentals/${a.id}/close`, { token: d.cashier.token, body: { outcome: 'returned' } }));
  assert.equal(back.status, 'returned');
  assert.equal(back.deposit_status, 'refunded');
  assert.equal(back.credit_note.cash_back_cents, 50000);
  assert.equal((await d.stock(d.racket)).quantity, 3);
  assert.equal((await api('POST', `/pos/rentals/${b.id}/close`, { token: d.cashier.token, body: { outcome: 'damaged' } })).status, 400, 'say what happened');
  const dmg = must(await api('POST', `/pos/rentals/${b.id}/close`, { token: d.cashier.token, body: { outcome: 'damaged', note: 'Frame cracked', forfeit_cents: 30000 } }));
  assert.equal(dmg.deposit_status, 'part_forfeited');
  assert.equal(dmg.credit_note.cash_back_cents, 20000);
  assert.deepEqual(await d.stock(d.racket), { quantity: 3, damaged_qty: 1 }, 'a broken racket is not rentable');
  const lost = must(await api('POST', `/pos/rentals/${c.id}/close`, { token: d.cashier.token, body: { outcome: 'lost', note: 'Not returned' } }));
  assert.equal(lost.deposit_status, 'forfeited');
  assert.equal(lost.credit_note, null);
  assert.equal((await d.stock(d.racket)).quantity, 3, 'lost kit never comes back');
  assert.equal((await api('POST', `/pos/rentals/${a.id}/close`, { token: d.cashier.token, body: { outcome: 'returned' } })).status, 409);
  const rentals = must(await api('GET', `/venues/${d.v.id}/pos/rentals`, { token: d.cashier.token, query: { status: 'lost' } }));
  assert.equal(rentals.length, 1);
  // rental kit handed out against an unpaid sale waits
  const unpaid = await d.sell(d.cashier, { lines: [{ kind: 'rental', item_id: d.racket.id }] });
  assert.equal(unpaid.rentals[0].status, 'reserved');
  assert.equal((await api('POST', `/pos/rentals/${unpaid.rentals[0].id}/issue`, { token: d.cashier.token, body: {} })).status, 409, 'nothing is handed over before it is paid');
  const paid = must(await api('POST', `/pos/sales/${unpaid.id}/payments`, { token: d.cashier.token, body: { method: 'cash' } }));
  assert.equal(paid.status, 'paid');
  assert.equal(paid.rentals[0].status, 'issued', 'handed over as soon as the payment covers it');
  assert.equal((await api('POST', `/pos/rentals/${unpaid.rentals[0].id}/issue`, { token: d.cashier.token, body: {} })).status, 409);
});

test('members, collected invoices, manual tenders, split payment and the invoice hook', async () => {
  const d = await desk();
  const cust = await signup();
  // a membership belongs to a person
  assert.equal((await d.sell(d.cashier, { lines: [{ kind: 'plan', plan_id: d.plan.id }], payments: [{ method: 'cash' }] }, null)).status, 400);
  const m = await d.sell(d.cashier, { lines: [{ kind: 'plan', plan_id: d.plan.id }], customer_handle: cust.handle, payments: [{ method: 'cash' }] });
  assert.equal(m.status, 'paid');
  assert.equal(m.customer.id, cust.id);
  const plans = must(await api('GET', '/me/plans', { token: cust.token }));
  assert.equal(plans[0].status, 'active');
  assert.equal(must(await api('GET', '/invoices', { token: cust.token })).length, 1, 'an identified customer sees their invoice');
  // only enabled tenders; non-cash needs its reference
  const cart = { lines: [{ kind: 'item', item_id: d.tube.id, qty: 2 }] };
  assert.equal((await d.sell(d.cashier, { ...cart, payments: [{ method: 'card_terminal', reference: 'TXN1' }] }, null)).status, 400, 'card is not switched on');
  assert.equal((await api('PATCH', `/venues/${d.v.id}/pos/settings`, { token: d.cashier.token, body: { manual_methods: ['cash', 'card_terminal'] } })).status, 403, 'a cashier cannot switch tenders on');
  must(await api('PATCH', `/venues/${d.v.id}/pos/settings`, { token: d.mgr.token, body: { manual_methods: ['cash', 'card_terminal'] } }));
  assert.equal((await d.sell(d.cashier, { ...cart, payments: [{ method: 'card_terminal' }] }, null)).status, 400, 'a reference is required');
  const split = await d.sell(d.cashier, { ...cart, payments: [{ method: 'cash', amount_cents: 20000 }, { method: 'card_terminal', reference: 'TXN-77' }] });
  assert.equal(split.status, 'paid');
  assert.equal(split.documents[0].payment_method, 'mixed');
  assert.deepEqual(split.payments.map((p) => [p.method, Number(p.amount_cents)]), [['cash', 20000], ['card_terminal', 40000]]);
  // part payment now, the rest later
  const part = await d.sell(d.cashier, { ...cart, payments: [{ method: 'cash', amount_cents: 10000 }] });
  assert.equal(part.status, 'awaiting_payment');
  assert.equal(part.amount_due_cents, 50000);
  assert.equal((await d.sell(d.cashier, { ...cart }, 201)).status, 'awaiting_payment');
  // voiding a part-paid sale hands the cash back
  const voided = must(await api('POST', `/pos/sales/${part.id}/void`, { token: d.cashier.token, body: { reason: 'Changed mind' } }));
  assert.equal(voided.status, 'void');
  assert.deepEqual(voided.payments.map((p) => [p.kind, Number(p.amount_cents)]), [['payment', 10000], ['refund', 10000]]);
  assert.equal((await api('POST', `/pos/sales/${part.id}/void`, { token: d.cashier.token, body: { reason: 'again' } })).status, 409);
  // voiding an unpaid sale that held court time releases the slots and voids the invoice
  const held = await d.sell(d.cashier, { lines: [{ kind: 'booking', resource_id: d.court.id, starts_at: at(7, 10), ends_at: at(7, 11) }, { kind: 'item', item_id: d.drink.id, qty: 2 }] });
  assert.equal(held.status, 'awaiting_payment');
  const rid = held.reservation_id;
  must(await api('POST', `/pos/sales/${held.id}/void`, { token: d.cashier.token, body: { reason: 'They went home' } }));
  assert.equal((await q("SELECT status FROM bookings WHERE reservation_id=$1", [rid]))[0].status, 'cancelled');
  assert.ok((await q("SELECT status FROM invoices WHERE reservation_id=$1 AND kind='invoice'", [rid])).every((r) => r.status === 'void'));
  assert.equal((await q("SELECT quantity FROM inventory_items WHERE id=$1", [d.drink.id]))[0].quantity, 50);
  // offline capture: only cash, only where the venue allows it, and never twice
  const off = await d.sell(d.cashier, { lines: [{ kind: 'item', item_id: d.drink.id }], payments: [{ method: 'cash' }], captured_offline_at: new Date(Date.now() - 600000).toISOString(), client_ref: 'offline-0001' });
  assert.equal(off.status, 'paid');
  assert.ok(off.captured_offline_at);
  assert.equal((await d.sell(d.cashier, { lines: [{ kind: 'item', item_id: d.drink.id }], payments: [{ method: 'card_terminal', reference: 'T1' }], captured_offline_at: new Date().toISOString() }, null)).status, 400, 'a card cannot be taken offline');
  must(await api('PATCH', `/venues/${d.v.id}/pos/settings`, { token: d.mgr.token, body: { offline_cash_allowed: false } }));
  assert.equal((await d.sell(d.cashier, { lines: [{ kind: 'item', item_id: d.drink.id }], payments: [{ method: 'cash' }], captured_offline_at: new Date().toISOString() }, null)).status, 400);
  // a sale whose last open record is a booking invoice is finished by whatever pays that invoice
  const hold = await d.sell(d.cashier, { lines: [{ kind: 'booking', resource_id: d.court.id, starts_at: at(9, 10), ends_at: at(9, 11) }], customer_handle: cust.handle });
  assert.equal(hold.status, 'awaiting_payment');
  const hc = await pool.connect();
  try { await hc.query('BEGIN'); assert.equal(await markInvoicePaid(hc, hold.documents[0].id, { method: 'points', by: cust.id }), true); await hc.query('COMMIT'); } finally { hc.release(); }
  assert.equal(must(await api('GET', `/pos/sales/${hold.id}`, { token: d.mgr.token })).status, 'paid', 'the sale does not stay stuck when the booking invoice is paid elsewhere');
  // credit cannot be stacked on an invoice whose sale already has money on it
  const half = await d.sell(d.cashier, { lines: [{ kind: 'item', item_id: d.tube.id, qty: 2 }], customer_handle: cust.handle, payments: [{ method: 'cash', amount_cents: 10000 }] });
  assert.equal((await api('POST', `/invoices/${half.documents[0].id}/pass`, { token: cust.token, body: {} })).status, 409, 'money already taken at the desk: finish it there');
  const goodsOnly = await d.sell(d.cashier, { lines: [{ kind: 'item', item_id: d.tube.id }], customer_handle: cust.handle });
  assert.equal((await api('POST', `/invoices/${goodsOnly.documents[0].id}/pass`, { token: cust.token, body: {} })).status, 400, 'a pass is for court time, not goods');
  // collecting an invoice that already exists (a booking a customer made online, paid at the venue)
  const b = must(await api('POST', '/reservations', { token: cust.token, body: { items: [{ resource_id: d.court.id, starts_at: at(3, 10), ends_at: at(3, 11) }] } }), 201);
  const coll = await d.sell(d.cashier, { lines: [{ kind: 'invoice', invoice_id: b.invoices[0].id }], customer_handle: cust.handle, payments: [{ method: 'cash' }] });
  assert.equal(coll.status, 'paid');
  assert.equal((await q('SELECT status, payment_method FROM invoices WHERE id=$1', [b.invoices[0].id]))[0].payment_method, 'cash');
  assert.equal((await q('SELECT payment_status FROM bookings WHERE reservation_id=$1', [b.id]))[0].payment_status, 'paid');
  // an invoice already waiting in an unpaid sale cannot be taken twice
  const b2 = must(await api('POST', '/reservations', { token: cust.token, body: { items: [{ resource_id: d.court.id, starts_at: at(4, 10), ends_at: at(4, 11) }] } }), 201);
  await d.sell(d.cashier, { lines: [{ kind: 'invoice', invoice_id: b2.invoices[0].id }] });
  assert.equal((await d.sell(d.cashier, { lines: [{ kind: 'invoice', invoice_id: b2.invoices[0].id }] }, null)).status, 409);
  assert.equal((await api('POST', `/invoices/${b2.invoices[0].id}/paid`, { token: d.mgr.token, body: {} })).status, 400, 'settle it on the sale');
  // the customer covering the desk invoice through the canonical invoice flow finishes the sale (the paid hook)
  const pending = await d.sell(d.cashier, { lines: [{ kind: 'plan', plan_id: d.plan.id }], customer_handle: (await signup()).handle });
  assert.equal(pending.status, 'awaiting_payment');
  const c = await pool.connect();
  try { await c.query('BEGIN'); assert.equal(await markInvoicePaid(c, pending.documents[0].id, { method: 'points', by: pending.cashier_id }), true); await c.query('COMMIT'); } finally { c.release(); }
  const fin = must(await api('GET', `/pos/sales/${pending.id}`, { token: d.mgr.token }));
  assert.equal(fin.status, 'paid');
  assert.equal((await q("SELECT status FROM user_plans WHERE id=$1", [fin.lines[0].user_plan_id]))[0].status, 'active');
});

test('permissions: outsiders see nothing, cashiers cannot configure or read the money report', async () => {
  const d = await desk();
  const cart = { lines: [{ kind: 'item', item_id: d.tube.id }], payments: [{ method: 'cash' }] };
  assert.equal((await api('GET', `/venues/${d.v.id}/front-desk`, { token: d.outsider.token })).status, 404, 'no hint that the venue exists');
  assert.equal((await api('POST', `/venues/${d.v.id}/pos/sales`, { token: d.outsider.token, body: cart })).status, 404);
  assert.equal((await api('GET', `/venues/${d.v.id}/front-desk`)).status, 401);
  // a cashier works the desk and nothing else at the venue
  for (const [m, p, body] of [['GET', `/venues/${d.v.id}/operations`], ['GET', `/venues/${d.v.id}/staff`], ['POST', `/venues/${d.v.id}/staff`, { handle: d.outsider.handle }], ['POST', `/venues/${d.v.id}/plans`, { kind: 'pass', name: 'Free', price_cents: 1, sessions: 1, valid_days: 1 }], ['GET', '/invoices', undefined]]) {
    const r = await api(m, p, { token: d.cashier.token, body, query: p === '/invoices' ? { venue_id: d.v.id } : undefined });
    assert.equal(r.status, 403, `${m} ${p} stays closed to a cashier`);
  }
  assert.deepEqual((await api('GET', '/me/front-desks', { token: d.cashier.token })).body.map((x) => [x.id, x.role]), [[d.v.id, 'cashier']]);
  assert.deepEqual(must(await api('GET', '/me/front-desks', { token: d.mgr.token })).map((x) => [x.id, x.role]), [[d.v.id, 'manager']]);
  assert.equal(must(await api('GET', `/venues/${d.v.id}/pos/cashiers`, { token: d.mgr.token })).length, 1);
  assert.equal((await api('GET', `/venues/${d.v.id}/pos/cashiers`, { token: d.cashier.token })).status, 403);
  const desk1 = must(await api('GET', `/venues/${d.v.id}/front-desk`, { token: d.cashier.token }));
  assert.ok(desk1.items.every((x) => !('unit_cost_cents' in x)), 'what stock costs the venue is the manager\'s figure');
  assert.ok(must(await api('GET', `/venues/${d.v.id}/front-desk`, { token: d.mgr.token })).items.every((x) => 'unit_cost_cents' in x));
  assert.equal(desk1.role, 'cashier');
  assert.deepEqual(desk1.offers, []);
  assert.equal(desk1.items.length, 2);
  assert.equal(desk1.rental_items.length, 1);
  assert.equal(desk1.plans.length, 1);
  assert.deepEqual(desk1.tenders.manual, ['cash']);
  assert.equal(must(await api('GET', `/venues/${d.v.id}/front-desk`, { token: d.mgr.token })).role, 'manager');
  for (const [m, p, body] of [['PATCH', `/venues/${d.v.id}/pos/settings`, { require_shift: true }], ['POST', `/venues/${d.v.id}/pos/approvals`, { kind: 'refund', max_amount_cents: 1, reason: 'self' }],
    ['GET', `/venues/${d.v.id}/pos/report`], ['GET', `/inventory?venue_id=${d.v.id}`], ['POST', '/inventory', { venue_id: d.v.id, name: 'Sneaky', category: 'other', quantity: 1, sell_price_cents: 1 }], ['POST', `/inventory/${d.tube.id}/adjust`, { delta: 5, reason: 'sneak' }]]) {
    const r = await api(m, p, { token: d.cashier.token, body });
    assert.equal(r.status, 403, `${m} ${p}`);
  }
  // an item that belongs to another venue cannot be sold here
  const other = await desk();
  assert.equal((await api('POST', `/venues/${d.v.id}/pos/sales`, { token: d.cashier.token, body: { lines: [{ kind: 'item', item_id: other.tube.id }], payments: [{ method: 'cash' }] } })).status, 404);
  // rental terms are validated
  assert.equal((await api('PATCH', `/inventory/${d.racket.id}`, { token: d.mgr.token, body: { sell_price_cents: 100 } })).status, 400);
  assert.equal((await api('PATCH', `/inventory/${d.tube.id}`, { token: d.mgr.token, body: { deposit_cents: 100 } })).status, 400);
  // archived items leave the desk, their history stays
  must(await api('PATCH', `/inventory/${d.drink.id}`, { token: d.mgr.token, body: { archived: true } }));
  assert.equal(must(await api('GET', `/venues/${d.v.id}/front-desk`, { token: d.cashier.token })).items.length, 1);
  assert.equal(must(await api('GET', `/inventory/${d.tube.id}/history`, { token: d.mgr.token })).length, 1);
});

test('report: sales by category, method, cashier and shift reconcile to the invoices, payments and stock', async () => {
  const d = await desk();
  must(await api('POST', `/venues/${d.v.id}/pos/shifts`, { token: d.cashier.token, body: { opening_float_cents: 0 } }), 201);
  await d.sell(d.cashier, { lines: [{ kind: 'item', item_id: d.tube.id, qty: 2 }, { kind: 'item', item_id: d.drink.id, qty: 4 }, { kind: 'booking', resource_id: d.court.id, starts_at: at(5, 9), ends_at: at(5, 10) }], payments: [{ method: 'cash' }] });
  const online = await d.sell(d.cashier, { lines: [{ kind: 'rental', item_id: d.racket.id }] });
  must(await api('POST', `/pos/sales/${online.id}/online-payment`, { token: d.cashier.token, body: { provider: 'stripe', return_url: 'http://app.test/' } }));
  Object.values(fake.sessions).at(-1).payment_status = 'paid';
  must(await api('POST', `/pos/sales/${online.id}/online-payment/confirm`, { token: d.cashier.token, body: {} }));
  const open = await d.sell(d.cashier, { lines: [{ kind: 'item', item_id: d.drink.id }] });
  const rep = must(await api('GET', `/venues/${d.v.id}/pos/report`, { token: d.mgr.token }));
  assert.equal(rep.totals.sales, 2);
  assert.equal(rep.totals.awaiting, 1);
  const cat = Object.fromEntries(rep.by_category.map((c) => [c.category, c]));
  assert.equal(cat.merch.total_cents, 60000);
  assert.equal(cat.food_beverage.total_cents, 20000);
  assert.equal(cat.court.total_cents, 50000);
  assert.equal(cat.deposit.total_cents, 50000);
  assert.equal(cat.merch.margin_cents, 60000 - 9153 - 40000, 'margin = revenue net of tax − cost');
  assert.deepEqual(rep.by_method.map((m) => m.method).sort(), ['cash', 'online']);
  assert.equal(rep.by_staff[0].cashier, d.cashier.display_name);
  assert.equal(rep.reconciliation.reconciled, true, JSON.stringify(rep.reconciliation));
  assert.equal(rep.reconciliation.difference_cents, 0);
  assert.equal(rep.reconciliation.invoice_difference_cents, 0);
  assert.equal(rep.by_shift.length, 1);
  // a refund lowers net, never the gross
  const first = (await q("SELECT id FROM pos_sales WHERE status='paid' AND venue_id=$1 ORDER BY created_at LIMIT 1", [d.v.id]))[0].id;
  const lineId = (await q("SELECT id FROM pos_sale_lines WHERE sale_id=$1 AND kind='item' AND item_id=$2", [first, d.drink.id]))[0].id;
  must(await api('POST', `/pos/sales/${first}/refund`, { token: d.mgr.token, body: { lines: [{ line_id: lineId, qty: 1, restock: false }], method: 'cash', reason: 'Spilt' } }));
  const after = must(await api('GET', `/venues/${d.v.id}/pos/report`, { token: d.mgr.token }));
  assert.equal(after.refunds.refunded_cents, 5000);
  assert.equal(after.net_cents, rep.totals.sales_cents - 5000);
  assert.equal(after.reconciliation.reconciled, true);
  assert.equal(open.status, 'awaiting_payment');
});

test('court refunds go through the booking engine; the module registry exposes the desk over REST, OpenAPI and MCP alike', async () => {
  const d = await desk();
  must(await api('POST', `/venues/${d.v.id}/pos/shifts`, { token: d.cashier.token, body: { opening_float_cents: 0 } }), 201);
  const sale = await d.sell(d.cashier, { lines: [{ kind: 'booking', resource_id: d.court.id, starts_at: at(6, 10), ends_at: at(6, 12) }], payments: [{ method: 'cash' }] });
  assert.equal(sale.total_cents, 100000);
  const b = sale.lines[0];
  const ref = must(await api('POST', `/pos/sales/${sale.id}/refund`, { token: d.mgr.token, body: { lines: [{ line_id: b.id }], method: 'cash', reason: 'Rained off' } }));
  assert.equal((await q("SELECT status FROM bookings WHERE id=$1", [b.booking_id]))[0].status, 'cancelled');
  assert.equal(ref.refunds.length, 1);
  assert.equal(Number(ref.refunds[0].total_cents), 100000);
  assert.equal(ref.refunds[0].refund_status, 'done');
  const shift = must(await api('GET', `/venues/${d.v.id}/pos/shift`, { token: d.mgr.token }));
  assert.equal(shift.cash_refunded_cents, 100000);
  assert.ok((await q('SELECT walk_in FROM invoices WHERE reservation_id=$1', [sale.reservation_id])).every((r) => r.walk_in), 'the credit note of a walk-in booking is a walk-in document too');
  assert.equal(must(await api('GET', '/invoices', { token: d.cashier.token })).length, 0);
  // court time paid by hand and refunded "to how it was paid": the desk hands the money back and the cash lands on the shift
  const paidByHand = await d.sell(d.cashier, { lines: [{ kind: 'booking', resource_id: d.court.id, starts_at: at(10, 10), ends_at: at(10, 11) }], payments: [{ method: 'cash' }] });
  const before = must(await api('GET', `/venues/${d.v.id}/pos/shift`, { token: d.mgr.token })).cash_refunded_cents;
  const manual = must(await api('POST', `/pos/sales/${paidByHand.id}/refund`, { token: d.mgr.token, body: { lines: [{ line_id: paidByHand.lines[0].id }], method: 'original', reason: 'Rained off' } }));
  assert.equal(manual.refunds[0].refund_status, 'manual');
  assert.equal((await api('POST', `/invoices/${manual.refunds[0].id}/refunded`, { token: d.mgr.token, body: {} })).status, 400, 'the generic route would skip the drawer');
  assert.equal(must(await api('GET', `/venues/${d.v.id}/pos/report`, { token: d.mgr.token })).open_items.refunds_for_desk, 1);
  must(await api('POST', `/pos/credit-notes/${manual.refunds[0].id}/paid-back`, { token: d.cashier.token, body: { method: 'cash' } }));
  assert.equal(must(await api('GET', `/venues/${d.v.id}/pos/shift`, { token: d.mgr.token })).cash_refunded_cents, before + 50000);
  assert.equal(must(await api('GET', `/venues/${d.v.id}/pos/report`, { token: d.mgr.token })).open_items.refunds_for_desk, 0);
  // the same capabilities exist in OpenAPI and MCP
  const spec = await (await fetch(`${base}/api/v1/openapi.json`)).json();
  const ids = Object.values(spec.paths).flatMap((p) => Object.values(p)).map((o) => o.operationId);
  const { capabilities } = await import('../src/capabilities/index.js');
  const desks = capabilities.filter((c) => c.tag === 'Front desk');
  assert.ok(desks.length >= 30);
  for (const c of desks) assert.ok(ids.includes(c.name), `${c.name} in OpenAPI`);
  const mcp = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${d.mgr.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  const text = await mcp.text();
  assert.match(text, /create_pos_sale/);
  assert.match(text, /close_pos_shift/);
  // money-moving capabilities need the payment scope on a narrow API token
  for (const name of ['create_pos_sale', 'add_pos_payment', 'refund_pos_sale', 'close_pos_shift', 'record_pos_cash_move', 'start_pos_online_payment', 'close_pos_rental']) assert.equal(capabilities.find((c) => c.name === name).scope, 'payment', name);
});

test('loyalty (#509): a customer earns on a paid desk invoice, can pay part with points, and gives them back on a refund; a walk-in earns nothing', async () => {
  const d = await desk();
  const cust = await signup();
  const prog = must(await api('POST', '/loyalty/programmes', { token: d.mgr.token, body: { name: 'Desk rewards', owner_kind: 'venue', owner_id: d.v.id } }), 201);
  must(await api('POST', `/loyalty/programmes/${prog.id}/publish`, { token: d.mgr.token, body: { rules: { earn: [{ key: 'booking', event: 'venue_booking_paid', mode: 'percent', percent_bp: 1000 }], redeem: { max_redeem_bp: 5000, min_points: 1, purposes: ['venue_invoice'] }, expiry_months: 12 } } }));
  const points = async (u) => Number((must(await api('GET', '/me/loyalty', { token: u.token })).find((p) => p.id === prog.id)?.points ?? 0));
  const bought = await d.sell(d.cashier, { lines: [{ kind: 'item', item_id: d.tube.id, qty: 2 }], customer_handle: cust.handle, payments: [{ method: 'cash' }] });
  assert.equal(await points(cust), 6000, '10% of the 600 paid');
  must(await api('POST', `/pos/sales/${bought.id}/refund`, { token: d.mgr.token, body: { lines: [{ line_id: bought.lines[0].id, qty: 1 }], method: 'cash', reason: 'Wrong brand' } }));
  assert.equal(await points(cust), 3000, 'the points that the refunded money earned go back');
  // a walk-in's bill is the cashier's stand-in: nobody earns on it
  await d.sell(d.cashier, { lines: [{ kind: 'item', item_id: d.tube.id }], payments: [{ method: 'cash' }] });
  assert.equal(await points(d.cashier), 0);
  // paying part of a desk invoice with points: the desk takes only what is left
  const open = await d.sell(d.cashier, { lines: [{ kind: 'item', item_id: d.tube.id, qty: 2 }], customer_handle: cust.handle });
  const redeemed = must(await api('POST', '/loyalty/redeem', { token: cust.token, body: { programme_id: prog.id, purpose_type: 'venue_invoice', purpose_id: open.documents[0].id, points: 1000 } }));
  assert.equal(redeemed.paid, false);
  const now = must(await api('GET', `/pos/sales/${open.id}`, { token: d.cashier.token }));
  assert.equal(now.amount_due_cents, 59000);
  const finished = must(await api('POST', `/pos/sales/${open.id}/payments`, { token: d.cashier.token, body: { method: 'cash' } }));
  assert.equal(finished.status, 'paid');
  assert.equal(finished.payments[0].amount_cents, 59000, 'the desk took only what points had not covered');
  assert.equal(await points(cust), 3000 - 1000 + 5900, 'points spent, then earned on the 590 paid in cash');
});

test('court time at the desk: a cashier books a walk-in in the running slot but not beyond the booking window; a manager has the override', async () => {
  const d = await desk();
  must(await api('PATCH', `/venues/${d.v.id}`, { token: d.mgr.token, body: { min_notice_minutes: 180, max_advance_days: 7 } }));
  const now = new Date(Math.floor(Date.now() / 3600e3) * 3600e3).toISOString();
  const later = (days) => new Date(Math.floor(Date.now() / 3600e3) * 3600e3 + days * 864e5).toISOString();
  const book = (u, starts) => d.sell(u, { lines: [{ kind: 'booking', resource_id: d.court.id, starts_at: starts, ends_at: new Date(+new Date(starts) + 3600e3).toISOString() }], payments: [{ method: 'cash' }] }, null);
  const walkIn = await book(d.cashier, now);
  assert.equal(walkIn.status, 201, 'the court that is free right now can be sold right now, whatever the notice rule says');
  assert.equal((await q('SELECT payment_deadline FROM reservations WHERE id=$1', [walkIn.body.reservation_id]))[0].payment_deadline, null);
  assert.equal((await book(d.cashier, later(30))).status, 400, 'a cashier cannot book past the venue\'s booking window');
  assert.equal((await book(d.cashier, now)).status, 409, 'and not on top of a court that is taken');
  assert.equal((await book(d.mgr, later(30))).status, 201, 'a manager has the venue\'s override powers');
  // a slot offered to someone on the waitlist is theirs, not the cashier's
  const waiter = await signup();
  const slot = later(2);
  await pool.query("INSERT INTO waitlist_entries(user_id, venue_id, resource_id, starts_at, ends_at, quantity, status, offered_at, offer_expires_at) VALUES ($1,$2,$3,$4,$5,1,'offered', now(), now() + interval '10 minutes')", [waiter.id, d.v.id, d.court.id, slot, new Date(+new Date(slot) + 3600e3).toISOString()]);
  assert.equal((await book(d.cashier, slot)).status, 409, 'a slot offered to someone on the waitlist is theirs, not the cashier\'s');
});

test('manager approvals: the 6 digits cannot be guessed', async () => {
  const d = await desk();
  const cart = (code) => ({ lines: [{ kind: 'item', item_id: d.tube.id, qty: 3 }], discount: { kind: 'percent', value: 40, reason: 'Guess', approval_id: code }, payments: [{ method: 'cash' }] });
  const real = must(await api('POST', `/venues/${d.v.id}/pos/approvals`, { token: d.mgr.token, body: { kind: 'discount', max_amount_cents: 100000, reason: 'Real one' } }), 201);
  const tries = [];
  for (let k = 0; k < 7; k++) tries.push((await d.sell(d.cashier, cart(real.code === String(100000 + k) ? '999999' : String(100000 + k)), null)).status);
  assert.equal(tries[0], 403);
  assert.equal(tries.at(-1), 429, 'after five wrong codes the desk stops listening for a while');
  assert.equal((await d.sell(d.cashier, cart(real.code), null)).status, 429, 'even the right code waits out the lock');
  assert.equal((await d.sell(d.mgr, cart(undefined))).status, 'paid', 'a manager is never held up');
});
