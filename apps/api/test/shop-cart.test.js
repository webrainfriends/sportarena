import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
let n = 0;
const signup = async (roles) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `shopper_${n}`, display_name: `Shopper ${n}`, email: `shop${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('offers, search, sort and the wishlist', async () => {
  const seller = await signup(['supplier']); const buyer = await signup(['athlete']);
  const mk = (b) => api('POST', '/shop/products', { token: seller.token, body: b });
  assert.equal((await mk({ name: 'Bad offer', price_cents: 5000, compare_at_cents: 4000, stock: 1 })).status, 400, 'usual price must be above the selling price');
  const racket = (await mk({ name: 'Pro racket', brand: 'Yonex', price_cents: 8000, compare_at_cents: 10000, stock: 5, highlights: ['Graphite frame'] })).body;
  const shoes = (await mk({ name: 'Court shoes', price_cents: 3000, stock: 2 })).body;
  const list = (await api('GET', '/shop/products?sort=discount')).body;
  assert.equal(list[0].id, racket.id);
  assert.equal(list[0].discount_pct, 20);
  assert.deepEqual(list[0].images, []);
  assert.equal((await api('GET', '/shop/products?q=yonex')).body.length, 1, 'brand is searchable');
  assert.equal((await api('GET', '/shop/products?on_offer=true')).body.length, 1);
  assert.equal((await api('GET', '/shop/products?sort=price_asc')).body[0].id, shoes.id);
  assert.equal((await api('GET', '/shop/products?max_price_cents=3500')).body.length, 1);
  assert.equal((await api('GET', '/shop/products?wishlist=true')).status, 401);
  assert.equal((await api('POST', `/shop/wishlist/${racket.id}`, { token: buyer.token })).body.wishlisted, true);
  assert.equal((await api('GET', '/shop/products?wishlist=true', { token: buyer.token })).body.map((p) => p.id).join(), racket.id);
  assert.equal((await api('GET', '/shop/products', { token: buyer.token })).body.find((p) => p.id === racket.id).wishlisted, true);
  assert.equal((await api('POST', `/shop/wishlist/${racket.id}`, { token: buyer.token })).body.wishlisted, false);
  const one = (await api('GET', `/shop/products/${racket.id}`)).body;
  assert.equal(one.related.length, 1);
  assert.equal(one.can_review, false);
});

test('the cart: live totals, stock caps, save for later, one checkout for many items', async () => {
  const seller = await signup(['supplier']); const buyer = await signup(['athlete']);
  const mk = async (b) => (await api('POST', '/shop/products', { token: seller.token, body: b })).body;
  const a = await mk({ name: 'Cart ball', price_cents: 1000, compare_at_cents: 1500, stock: 3 });
  const b = await mk({ name: 'Cart bottle', price_cents: 500, stock: 10 });
  const t = { token: buyer.token };
  assert.equal((await api('POST', '/shop/cart/items', { token: seller.token, body: { product_id: a.id } })).status, 400, 'not your own product');
  assert.equal((await api('POST', '/shop/cart/items', { ...t, body: { product_id: a.id, quantity: 4 } })).status, 409, 'capped by stock');
  await api('POST', '/shop/cart/items', { ...t, body: { product_id: a.id, add: 2 } });
  let cart = (await api('POST', '/shop/cart/items', { ...t, body: { product_id: b.id, quantity: 2 } })).body;
  assert.equal(cart.summary.units, 4);
  assert.equal(cart.summary.subtotal_cents, 2 * 1000 + 2 * 500);
  assert.equal(cart.summary.savings_cents, 2 * 500);
  cart = (await api('POST', '/shop/cart/items', { ...t, body: { product_id: b.id, saved_for_later: true } })).body;
  assert.equal(cart.saved.length, 1);
  assert.equal(cart.summary.subtotal_cents, 2000, 'saved-for-later items are not in the total');
  await api('POST', '/shop/cart/items', { ...t, body: { product_id: b.id, saved_for_later: false } });
  assert.equal((await api('POST', '/shop/cart/checkout', { ...t, body: { ship_to: '1' } })).status, 400, 'address too short');
  const out = await api('POST', '/shop/cart/checkout', { ...t, body: { ship_to: '12 MG Road, Pune' } });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  assert.equal(out.body.orders.length, 2);
  assert.equal(out.body.total_cents, 3000);
  assert.equal(out.body.status, 'placed', 'no payment provider in tests');
  assert.equal((await api('GET', '/shop/cart', t)).body.items.length, 0, 'cart is emptied (rows are kept, not deleted)');
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM shop_cart_items WHERE user_id=$1', [buyer.id]);
  assert.equal(rows[0].n, 2);
  assert.equal((await api('GET', '/shop/products', t)).body.find((p) => p.id === a.id).stock, 1, 'stock reserved');
  assert.equal((await api('GET', '/shop/orders', t)).body.filter((o) => o.checkout_id === out.body.checkout_id).length, 2);
  // an item that sold out meanwhile fails the whole checkout and orders nothing
  await api('POST', '/shop/cart/items', { ...t, body: { product_id: a.id, quantity: 1 } });
  await pool.query('UPDATE shop_products SET stock = 0 WHERE id=$1', [a.id]);
  await api('POST', '/shop/cart/items', { ...t, body: { product_id: b.id, quantity: 1 } });
  assert.equal((await api('POST', '/shop/cart/checkout', { ...t, body: { ship_to: '12 MG Road, Pune' } })).status, 409);
  assert.equal((await api('GET', '/shop/orders', t)).body.length, 2, 'nothing ordered');
  assert.equal((await api('GET', '/shop/cart', t)).body.summary.unavailable, 1);
});

test('reviews: only buyers, one each, and the rating shows on the product', async () => {
  const seller = await signup(['supplier']); const buyer = await signup(['athlete']); const other = await signup(['athlete']);
  const p = (await api('POST', '/shop/products', { token: seller.token, body: { name: 'Review me', price_cents: 900, stock: 5 } })).body;
  const review = (u, rating) => api('POST', '/testimonials', { token: u.token, body: { subject_type: 'product', subject_id: p.id, rating, body: 'Solid kit, arrived fast' } });
  assert.equal((await review(buyer, 5)).status, 400, 'has not bought it yet');
  await api('POST', '/shop/cart/items', { token: buyer.token, body: { product_id: p.id } });
  await api('POST', '/shop/cart/checkout', { token: buyer.token, body: { ship_to: '12 MG Road, Pune' } });
  assert.equal((await api('GET', `/shop/products/${p.id}`, { token: buyer.token })).body.can_review, true);
  assert.equal((await review(buyer, 4)).status, 201);
  assert.equal((await review(other, 1)).status, 400);
  assert.equal((await review(seller, 5)).status, 400, 'not your own product');
  const shown = (await api('GET', `/shop/products/${p.id}`)).body;
  assert.equal(shown.rating, 4);
  assert.equal(shown.rating_count, 1);
});

test('editing and archiving a listing keeps its orders; a buyer cancel restocks', async () => {
  const seller = await signup(['supplier']); const buyer = await signup(['athlete']);
  const p = (await api('POST', '/shop/products', { token: seller.token, body: { name: 'Edit me', price_cents: 900, stock: 5 } })).body;
  assert.equal((await api('PATCH', `/shop/products/${p.id}`, { token: buyer.token, body: { price_cents: 1 } })).status, 403);
  assert.equal((await api('PATCH', `/shop/products/${p.id}`, { token: seller.token, body: { price_cents: 700, compare_at_cents: 900 } })).status, 200);
  await api('POST', '/shop/cart/items', { token: buyer.token, body: { product_id: p.id, quantity: 2 } });
  const co = (await api('POST', '/shop/cart/checkout', { token: buyer.token, body: { ship_to: '12 MG Road, Pune' } })).body;
  assert.equal(co.total_cents, 1400);
  assert.equal((await api('PATCH', `/shop/products/${p.id}`, { token: seller.token, body: { archived: true } })).body.archived_at !== null, true);
  assert.equal((await api('GET', '/shop/products?q=Edit%20me')).body.length, 0, 'archived products leave the shop');
  assert.equal((await api('GET', '/shop/products?mine=true&q=Edit%20me', { token: seller.token })).body.length, 1, 'but stay in my listings');
  assert.equal((await api('POST', '/shop/cart/items', { token: buyer.token, body: { product_id: p.id } })).status, 404);
  assert.equal((await api('PATCH', `/shop/orders/${co.orders[0].id}`, { token: buyer.token, body: { status: 'cancelled' } })).status, 200);
  const { rows } = await pool.query('SELECT stock FROM shop_products WHERE id=$1', [p.id]);
  assert.equal(rows[0].stock, 5, 'cancel restocks');
});
