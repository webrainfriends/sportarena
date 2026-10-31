import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp', CORS_ORIGINS: 'http://app.test' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { fromLocal, addDays } = await import('../src/booking/time.js');
const cur = await import('../src/currency.js');

let server, base, n = 0;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `cp_${n}_${roles[0]}`, display_name: `Cur ${n}`, email: `cp${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const today = new Date().toISOString().slice(0, 10);
const at = (d, h) => fromLocal(addDays(today, d), h * 60, 'UTC').toISOString();

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('minor units: zero, two and three decimal currencies are exact and never silently rounded', () => {
  assert.equal(cur.toMajor(1234, 'INR'), '12.34');
  assert.equal(cur.toMajor(1250, 'SGD'), '12.50');
  assert.equal(cur.toMajor(5000, 'JPY'), '5000');
  assert.equal(cur.toMajor(12345, 'KWD'), '12.345');
  assert.equal(cur.toMajor(5, 'KWD'), '0.005');
  assert.equal(cur.toMajor(-1250, 'SGD'), '-12.50');
  assert.equal(cur.toMajor(9007199254740, 'KWD'), '9007199254.740', 'large amounts stay exact');
  assert.equal(cur.fromMajor('12.345', 'KWD'), 12345);
  assert.equal(cur.fromMajor('12.50', 'SGD'), 1250);
  assert.equal(cur.fromMajor('1200', 'JPY'), 1200);
  assert.equal(cur.fromMajor('0.29', 'USD'), 29, 'no floating point drift (0.29 * 100 = 28.999…)');
  assert.equal(cur.parseMajor('12.345', 'USD'), null, 'too many decimals is invalid, not rounded');
  assert.equal(cur.parseMajor('12.5', 'JPY'), null);
  assert.equal(cur.parseMajor('abc', 'USD'), null);
  assert.equal(cur.parseMajor('99999999999999999', 'USD'), null, 'beyond safe integers is refused');
  assert.throws(() => cur.fromMajor('abc', 'USD'), /Not an amount/);
  assert.equal(cur.exponent('KWD'), 3, 'three-decimal currencies are known to the amount helpers');
  assert.equal(cur.isSupportedCurrency('KWD'), false, 'but are not on the platform list (no online card payment)');
  assert.equal(cur.formatMinor(12345, 'KWD'), 'KWD 12.345');
});

test('catalogue: platform list has zero and two decimal currencies; three-decimal ones are served by /service-currencies only', async () => {
  const list = must(await api('GET', '/currencies'));
  for (const code of ['SGD', 'INR', 'JPY']) assert.ok(list.find((c) => c.code === code), code);
  assert.deepEqual(['SGD', 'JPY'].map((c) => list.find((x) => x.code === c).exponent), [2, 0]);
  assert.ok(!list.some((c) => c.code === 'KWD'));
  const sc = must(await api('GET', '/service-currencies'));
  assert.equal(sc.find((c) => c.code === 'KWD').exponent, 3);
  assert.equal(sc.find((c) => c.code === 'KWD').online_payments, false);
});

const product = (token, over = {}) => api('POST', '/shop/products', { token, body: { name: `Racket ${Math.random().toString(36).slice(2, 6)}`, description: 'A test racket', price_cents: 25000, stock: 10, ...over } });

test('shop: a product has an immutable currency that flows to its orders; a cart holds one currency', async () => {
  const seller = await signup(['supplier']);
  const inr = must(await product(seller.token), 201);
  assert.equal(inr.currency, 'INR', 'defaults to the platform settlement currency');
  const sgd = must(await product(seller.token, { currency: 'sgd', price_cents: 4590 }), 201);
  const jpy = must(await product(seller.token, { currency: 'JPY', price_cents: 12345 }), 201);
  assert.equal((await product(seller.token, { currency: 'KWD', price_cents: 12345 })).status, 400, 'three-decimal currencies cannot be sold online');
  assert.equal(sgd.currency, 'SGD');
  assert.equal((await product(seller.token, { currency: 'XXX' })).status, 400, 'unsupported currency is refused');

  // the listing's currency cannot change; the same currency is fine
  const edit = await api('PATCH', `/shop/products/${sgd.id}`, { token: seller.token, body: { currency: 'USD' } });
  assert.equal(edit.status, 409);
  assert.match(edit.body.error.message, /priced in SGD/);
  must(await api('PATCH', `/shop/products/${sgd.id}`, { token: seller.token, body: { currency: 'SGD', price_cents: 4990 } }));

  // price range: only within one currency, never across
  const sr = await signup();
  const dflt = must(await api('GET', '/shop/products?min_price_cents=1000&limit=50'));
  assert.ok(dflt.every((p) => p.currency === 'INR'), 'a range without a currency compares the settlement currency only');
  const inRange = must(await api('GET', '/shop/products?min_price_cents=4000&max_price_cents=5000&currency=SGD&limit=50'));
  assert.ok(inRange.length >= 1 && inRange.every((p) => p.currency === 'SGD' && Number(p.price_cents) >= 4000 && Number(p.price_cents) <= 5000), 'only SGD products, the INR 25000 racket is not compared');
  assert.ok(must(await api('GET', '/shop/products?currency=JPY&limit=50')).every((p) => p.currency === 'JPY'));

  // single order carries the product's currency and cannot be re-denominated
  const buyer = await signup();
  const order = must(await api('POST', '/shop/orders', { token: buyer.token, body: { product_id: jpy.id, quantity: 2, ship_to: '1 Test Street, Tokyo' } }), 201);
  assert.equal(order.currency, 'JPY');
  assert.equal(order.total_cents, 24690, 'whole yen: no minor unit');
  await assert.rejects(pool.query("UPDATE shop_orders SET currency='USD' WHERE id=$1", [order.id]), /currency of a shop_orders record cannot be changed/);
  assert.equal((await pool.query('SELECT currency FROM shop_orders WHERE id=$1', [order.id])).rows[0].currency, 'JPY');

  // cart: first line sets the currency, a different currency is refused with a stated reason, saving for later is allowed
  const b2 = await signup();
  const c1 = must(await api('POST', '/shop/cart/items', { token: b2.token, body: { product_id: sgd.id, quantity: 1 } }));
  assert.equal(c1.currency, 'SGD');
  assert.equal(c1.summary.currency, 'SGD');
  const clash = await api('POST', '/shop/cart/items', { token: b2.token, body: { product_id: inr.id, quantity: 1 } });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error.details?.code, 'currency_mismatch');
  assert.match(clash.body.error.message, /cart is in SGD/);
  const later = must(await api('POST', '/shop/cart/items', { token: b2.token, body: { product_id: inr.id, quantity: 1, saved_for_later: true } }));
  assert.equal(later.saved.length, 1);
  assert.equal(later.summary.total_cents, 4990, 'saved-for-later items in another currency are not added to the total');
  const out = must(await api('POST', '/shop/cart/checkout', { token: b2.token, body: { ship_to: '5 Orchard Road, Singapore' } }), 201);
  assert.equal(out.currency, 'SGD');
  assert.equal(out.orders[0].currency, 'SGD');
  // data created before this change keeps meaning: the column default backfills INR
  assert.equal((await pool.query("SELECT column_default FROM information_schema.columns WHERE table_name='shop_orders' AND column_name='currency'")).rows[0].column_default, "'INR'::text");
});

async function venue(mgr, currency) {
  const v = must(await api('POST', '/venues', { token: mgr.token, body: { name: `Cur Arena ${currency} ${Math.random().toString(36).slice(2, 6)}`, timezone: 'UTC', currency } }), 201);
  const court = must(await api('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'Court 1', hourly_rate_cents: currency === 'JPY' ? 5000 : 4000 } }), 201);
  return { v, court };
}
const slot = (court, d = 3, h = 10) => ({ resource_id: court.id, starts_at: at(d, h), ends_at: at(d, h + 1) });

test('booking: SGD, JPY and INR totals and invoices are exact; mixed currencies need an explicit acknowledgement', async () => {
  const mgr = await signup(['venue_manager']);
  const sg = await venue(mgr, 'SGD'); const jp = await venue(mgr, 'JPY'); const inr = await venue(mgr, 'INR');
  const u = await signup();

  const one = must(await api('POST', '/reservations', { token: u.token, body: { items: [slot(inr.court)] } }), 201);
  assert.equal(one.currency, 'INR');
  assert.equal(one.total_cents, 4000);
  assert.equal(one.invoices[0].currency, 'INR');
  const jpy = must(await api('POST', '/reservations', { token: u.token, body: { items: [slot(jp.court, 4)] } }), 201);
  assert.equal(jpy.total_cents, 5000);
  assert.equal(jpy.invoices[0].currency, 'JPY');

  // mixed basket: quote flags it, create refuses without the acknowledgement, nothing is booked
  const items = [slot(sg.court, 5), slot(jp.court, 5)];
  const q = must(await api('POST', '/reservations/quote', { token: u.token, body: { items } }));
  assert.equal(q.mixed_currency, true);
  assert.deepEqual(q.currencies, ['JPY', 'SGD']);
  assert.equal(q.ok, false);
  assert.ok(q.problems.some((p) => p.code === 'mixed_currency'));
  const refused = await api('POST', '/reservations', { token: u.token, body: { items } });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.details.code, 'mixed_currency');
  assert.deepEqual(refused.body.error.details.currencies, ['JPY', 'SGD']);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE r.id = ANY($1) AND b.starts_at=$2", [[sg.court.id, jp.court.id], at(5, 10)])).rows[0].n, 0, 'nothing booked');

  const okQuote = must(await api('POST', '/reservations/quote', { token: u.token, body: { items, accept_mixed_currencies: true } }));
  assert.equal(okQuote.ok, true);
  assert.equal(okQuote.totals.length, 2, 'one total per currency, never summed');
  const made = must(await api('POST', '/reservations', { token: u.token, body: { items, accept_mixed_currencies: true } }), 201);
  assert.deepEqual(made.invoices.map((i) => i.currency).sort(), ['JPY', 'SGD']);
  assert.equal(made.totals.find((t) => t.currency === 'SGD').total_cents, 4000);
  assert.equal(made.totals.find((t) => t.currency === 'JPY').total_cents, 5000);

  // a same-currency basket never needs the flag
  must(await api('POST', '/reservations', { token: u.token, body: { items: [slot(sg.court, 6)] } }), 201);
});

test('invoice currency is fixed: a later change (venue setting, direct update) cannot re-denominate it', async () => {
  const mgr = await signup(['venue_manager']);
  const { v, court } = await venue(mgr, 'SGD');
  const u = await signup();
  const r = must(await api('POST', '/reservations', { token: u.token, body: { items: [slot(court, 7)] } }), 201);
  const inv = r.invoices[0];
  assert.equal(inv.currency, 'SGD');
  assert.equal((await api('PATCH', `/venues/${v.id}`, { token: mgr.token, body: { currency: 'EUR' } })).status, 409, 'venue cannot switch currency once it has bookings');
  await assert.rejects(pool.query("UPDATE invoices SET currency='EUR' WHERE id=$1", [inv.id]), /currency of a invoices record cannot be changed/);
  await assert.rejects(pool.query("UPDATE payments SET currency='EUR' WHERE false RETURNING 1").then(() => { throw new Error('noop'); }), /noop/);
  const doc = must(await api('GET', `/invoices/${inv.id}`, { token: u.token }));
  assert.equal(doc.currency, 'SGD');
  assert.equal(doc.total_cents, 4000);
  // another user cannot read it
  const other = await signup();
  assert.ok([403, 404].includes((await api('GET', `/invoices/${inv.id}`, { token: other.token })).status), 'a stranger cannot read it');
});
