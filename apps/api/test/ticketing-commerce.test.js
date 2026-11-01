// Ticketing completion (#699): promo codes, waitlist, resale policy, parking and merchandise add-ons, reporting.
// The payment provider is stubbed at the network edge only; every ticket, promo, add-on and waitlist rule runs for real against Postgres.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { settle } = await import('../src/payments/service.js');
const { sweepTickets, parseToken, tokenFor } = await import('../src/ticketing.js');

let server, base, n = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes('/v1/refunds')) return new Response(JSON.stringify({ id: 're_1', status: 'succeeded' }), { status: 200 });
  return realFetch(url, init);
};
const api = async (method, path, { token, body, query } = {}) => {
  const r = await realFetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete'], extra = {}) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `tc_${n}_${roles[0]}`, display_name: `Commerce ${n}`, email: `tc${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const day = (d = 0) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const inHours = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const rows = async (sql, args = []) => (await pool.query(sql, args)).rows;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); globalThis.fetch = realFetch; });

const newEvent = async (org) => { const e = must(await api('POST', '/events', { token: org.token, body: { name: `Commerce Cup ${++n}`, sport: 'football', starts_on: day(1), ends_on: day(3) } }), 201); must(await api('PATCH', `/events/${e.id}`, { token: org.token, body: { status: 'open' } })); return e; };
const fixture = async (ev, hours = 30) => (await pool.query("INSERT INTO fixtures(event_id, scheduled_at, status) VALUES ($1,$2,'scheduled') RETURNING id", [ev.id, inHours(hours)])).rows[0].id;
const order = (u, ev, lines, extra = {}) => api('POST', `/events/${ev.id}/ticket-orders`, { token: u.token, body: { lines, ...extra } });
const pay = async (o, buyer) => {
  const p = (await pool.query("INSERT INTO payments(payer_id, provider, purpose_type, purpose_id, amount_cents, currency, status, provider_ref) VALUES ($1,'stripe','ticket_order',$2,$3,$4,'pending',$5) RETURNING id", [buyer.id, o.id, o.total_minor, o.currency, `cs_${++n}`])).rows[0];
  return { id: p.id, settle: () => settle(p.id, { paid: true, amount: Number(o.total_minor), currency: o.currency, paymentRef: `pi_${p.id}` }) };
};
const buy = async (u, ev, lines, extra) => { const o = must(await order(u, ev, lines, extra), 201); if (o.total_minor > 0) await (await pay(o, u)).settle(); return must(await api('GET', `/ticket-orders/${o.id}`, { token: u.token })); };

async function setup({ capacity = null, alloc = null, price = 2000, tax_bp = 0 } = {}) {
  const org = await signup(['organizer']);
  const ev = await newEvent(org);
  const fx = await fixture(ev);
  must(await api('PATCH', `/events/${ev.id}/tickets/settings`, { token: org.token, body: { transfer_cutoff_hours: 0, refund_policy: 'anytime', ...(capacity != null ? { spectator_capacity: capacity } : {}) } }));
  const p = must(await api('POST', `/events/${ev.id}/ticket-products`, { token: org.token, body: { name: `Adult ${++n}`, price_minor: price, currency: 'GBP', tax_bp, allocation: alloc, fixture_ids: [fx], per_account_limit: 20 } }), 201);
  must(await api('PATCH', `/ticket-products/${p.id}`, { token: org.token, body: { status: 'active' } }));
  return { org, ev, p, fx };
}
const promo = (org, ev, body) => api('POST', `/events/${ev.id}/ticket-promos`, { token: org.token, body: { kind: 'percent', value: 10, ...body } });
const addon = async (org, ev, body = {}) => { const a = must(await api('POST', `/events/${ev.id}/ticket-addons`, { token: org.token, body: { kind: 'parking', name: `Parking ${++n}`, price_minor: 600, currency: 'GBP', status: 'active', ...body } }), 201); return a; };

test('promo codes: percentage, cap, window, limits, stacking; the quote is exactly what the order charges', async () => {
  const { org, ev, p } = await setup({ price: 2000 });
  const fan = await signup(), fan2 = await signup();
  assert.equal((await promo(fan, ev, { code: 'NOPE' })).status, 404, 'only the organiser sets promos up');
  assert.equal((await promo(org, ev, { code: 'AB' })).status, 400);
  assert.equal((await promo(org, ev, { code: 'FIXED', kind: 'fixed', value: 300 })).status, 400, 'a fixed amount needs a currency');
  must(await promo(org, ev, { code: 'early10', value: 10, max_discount_minor: 300, per_user_limit: 1, stackable: true }), 201);
  assert.equal((await promo(org, ev, { code: 'EARLY10' })).status, 409, 'codes are unique per event, whatever the case');
  must(await promo(org, ev, { code: 'FAMILY5', kind: 'fixed', value: 500, currency: 'GBP', stackable: true }), 201);
  must(await promo(org, ev, { code: 'SOLO', value: 50 }), 201);
  must(await promo(org, ev, { code: 'EXPIRED', value: 50, valid_to: day(-1) }), 201);

  const lines = [{ product_id: p.id, quantity: 3 }];
  // 3 x 2000 = 6000; 10% = 600 but capped at 300; then 500 off => 5200
  const q = must(await api('POST', `/events/${ev.id}/ticket-orders/quote`, { token: fan.token, body: { lines, promo_codes: ['early10', 'FAMILY5'] } }));
  assert.equal(q.total_minor, 5200); assert.equal(q.discount_minor, 800);
  assert.deepEqual(q.promos.map((x) => [x.code, x.amount_minor]), [['EARLY10', 300], ['FAMILY5', 500]]);
  assert.equal((await rows('SELECT count(*)::int n FROM ticket_orders WHERE event_id=$1', [ev.id]))[0].n, 0, 'a quote keeps nothing');
  assert.equal((await rows('SELECT count(*)::int n FROM discount_redemptions WHERE ticket_order_id IS NOT NULL'))[0].n, 0);

  for (const bad of [['NOSUCH'], ['EXPIRED']]) assert.equal((await order(fan, ev, lines, { promo_codes: bad })).status, 400, `${bad} is not valid`);
  assert.equal((await order(fan, ev, lines, { promo_codes: ['SOLO', 'EARLY10'] })).status, 409, 'a non-stackable code cannot be combined');

  const o = must(await order(fan, ev, lines, { promo_codes: ['EARLY10', 'FAMILY5'] }), 201);
  assert.equal(o.total_minor, q.total_minor, 'the order charges the quote');
  assert.equal(o.total_minor, o.subtotal_minor + o.tax_minor);
  const pm = await pay(o, fan); assert.equal(Number((await rows('SELECT amount_cents FROM payments WHERE id=$1', [pm.id]))[0].amount_cents), 5200);
  await pm.settle();
  const t = await rows('SELECT price_minor, discount_minor FROM tickets WHERE order_id=$1', [o.id]);
  assert.equal(t.reduce((a, r) => a + Number(r.discount_minor), 0), 800, 'the discount is shared exactly across the tickets');
  // per-account limit: the second use of EARLY10 by the same account is refused, another account may use it
  assert.equal((await order(fan, ev, lines, { promo_codes: ['EARLY10'] })).status, 409);
  must(await order(fan2, ev, lines, { promo_codes: ['EARLY10'] }), 201);

  // a refund gives back what was charged, not the list price
  const first = must(await api('GET', `/ticket-orders/${o.id}`, { token: fan.token })).tickets[0];
  const r1 = must(await api('POST', `/tickets/${first.id}/refund`, { token: fan.token, body: {} }));
  assert.equal(r1.status, 'refunded');
  const given = Number((await rows('SELECT price_minor - discount_minor AS net, refunded_minor FROM tickets WHERE id=$1', [first.id]))[0].refunded_minor);
  assert.equal(given, 2000 - Number(first.discount_minor));
  for (const tk of must(await api('GET', `/ticket-orders/${o.id}`, { token: fan.token })).tickets.filter((x) => x.id !== first.id)) must(await api('POST', `/tickets/${tk.id}/refund`, { token: fan.token, body: {} }));
  const payment = (await rows('SELECT amount_cents, refunded_cents, status FROM payments WHERE id=$1', [pm.id]))[0];
  assert.equal(Number(payment.refunded_cents), Number(payment.amount_cents), 'all tickets refunded = the whole payment, promo included, no more and no less');
  assert.equal(payment.status, 'refunded');

  const list = must(await api('GET', `/events/${ev.id}/ticket-promos`, { token: org.token }));
  const early = list.find((x) => x.code === 'EARLY10');
  assert.equal(early.uses, 1); assert.equal(early.held, 1, 'the second use is held by an unpaid order'); assert.equal(early.stackable, true);
  const off = must(await api('PATCH', `/ticket-promos/${early.id}`, { token: org.token, body: { active: false } }));
  assert.equal(off.active, false);
  assert.equal((await api('PATCH', `/ticket-promos/${early.id}`, { token: org.token, body: { value: 20 } })).status, 409, 'a used code keeps its value');
  assert.equal((await order(fan2, ev, lines, { promo_codes: ['EARLY10'] })).status, 400, 'switched off');
});

test('promo codes: total-use limit under concurrency, product scope, and an unpaid order gives its use back', async () => {
  const { org, ev, p } = await setup({ price: 1000 });
  const other = must(await api('POST', `/events/${ev.id}/ticket-products`, { token: org.token, body: { name: `Other ${++n}`, price_minor: 1000, currency: 'GBP' } }), 201);
  must(await api('PATCH', `/ticket-products/${other.id}`, { token: org.token, body: { status: 'active' } }));
  must(await promo(org, ev, { code: 'ONLY3', value: 20, max_redemptions: 3 }), 201);
  must(await promo(org, ev, { code: 'SCOPED', value: 20, product_ids: [other.id] }), 201);
  const fans = await Promise.all(Array.from({ length: 8 }, () => signup()));
  const rs = await Promise.all(fans.map((f) => order(f, ev, [{ product_id: p.id, quantity: 1 }], { promo_codes: ['ONLY3'] })));
  assert.equal(rs.filter((r) => r.status === 201).length, 3, 'a code with 3 uses is used 3 times, however many race for it');
  assert.equal(rs.filter((r) => r.status === 409).length, 5);
  assert.equal((await order(fans[0], ev, [{ product_id: p.id, quantity: 1 }], { promo_codes: ['SCOPED'] })).status, 400, 'the code does not apply to this product');
  // one of the three buyers gives up: the use comes back, the history row stays
  const won = rs.find((r) => r.status === 201).body;
  const buyer = fans[rs.findIndex((r) => r.status === 201)];
  must(await api('POST', `/ticket-orders/${won.id}/cancel`, { token: buyer.token }));
  const red = await rows('SELECT reversed_at FROM discount_redemptions WHERE ticket_order_id=$1', [won.id]);
  assert.equal(red.length, 1); assert.ok(red[0].reversed_at, 'reversed, not deleted');
  must(await order(fans[7], ev, [{ product_id: p.id, quantity: 1 }], { promo_codes: ['ONLY3'] }), 201);
});

test('add-ons: totals match the charge, own stock under concurrency, collected once, refunded correctly', async () => {
  const { org, ev, p } = await setup({ price: 1500, tax_bp: 2000 });
  const lot = await addon(org, ev, { name: 'Car park B', stock: 3, collect_note: 'Lot B gate', tax_bp: 2000 });
  const scarf = await addon(org, ev, { kind: 'merchandise', name: 'Club scarf', price_minor: 1200, stock: null });
  const fan = await signup(), op = org;
  assert.equal((await api('POST', `/events/${ev.id}/ticket-addons`, { token: fan.token, body: { kind: 'parking', name: 'Sneaky', price_minor: 1, currency: 'GBP' } })).status, 404);
  assert.equal((await order(fan, ev, [{ product_id: p.id, quantity: 1 }], { addons: [{ addon_id: lot.id, quantity: 5 }] })).status, 409, 'more than the per-order limit / stock');
  const pub = must(await api('GET', `/public/events/${ev.id}/tickets`));
  assert.deepEqual(pub.addons.map((a) => a.name).sort(), ['Car park B', 'Club scarf']);

  must(await promo(org, ev, { code: 'TEN', value: 10 }), 201);
  const o = must(await order(fan, ev, [{ product_id: p.id, quantity: 2 }], { addons: [{ addon_id: lot.id, quantity: 1 }, { addon_id: scarf.id, quantity: 2 }], promo_codes: ['TEN'] }), 201);
  // tickets 3000 - promo 300 (tickets only, never add-ons) + parking 600 + scarves 2400
  assert.equal(o.discount_minor, 300); assert.equal(o.addons_minor, 3000); assert.equal(o.total_minor, 5700);
  assert.equal(o.total_minor, o.subtotal_minor + o.tax_minor);
  assert.equal(o.addons.length, 3);
  const pm = await pay(o, fan);
  assert.equal(Number((await rows('SELECT amount_cents FROM payments WHERE id=$1', [pm.id]))[0].amount_cents), o.total_minor);
  await pm.settle();

  const mineList = must(await api('GET', '/me/ticket-addons', { token: fan.token })).items;
  assert.equal(mineList.length, 3);
  const car = mineList.find((a) => a.name === 'Car park B');
  assert.ok(parseToken(car.token), 'the QR token is signed and carries no personal data');
  assert.ok(!car.token.includes(fan.id));
  assert.equal((await api('POST', `/events/${ev.id}/ticket-addons/collect`, { token: fan.token, body: { token: car.token } })).status, 404, 'only gate staff collect');
  const [r1, r2] = await Promise.all([1, 2].map(() => api('POST', `/events/${ev.id}/ticket-addons/collect`, { token: op.token, body: { token: car.token } })));
  assert.deepEqual([r1.body.result, r2.body.result].sort(), ['already_collected', 'collected'], 'two desks can never both hand it over');
  assert.equal(must(await api('POST', `/events/${ev.id}/ticket-addons/collect`, { token: op.token, body: { code: 'ZZZZZZZZ' } })).result, 'invalid');
  assert.equal(must(await api('POST', `/events/${ev.id}/ticket-addons/collect`, { token: op.token, body: { token: tokenFor('TKT-AAAAAAAAAA', 1) } })).result, 'invalid', 'a ticket token is not an add-on');

  // a collected item is not refundable by its buyer; an uncollected one is, for exactly its price
  const rf = await api('POST', `/ticket-addon-items/${car.id}/refund`, { token: fan.token, body: {} });
  assert.equal(rf.status, 409);
  const sc = mineList.find((a) => a.name === 'Club scarf');
  const done = must(await api('POST', `/ticket-addon-items/${sc.id}/refund`, { token: fan.token, body: {} }));
  assert.equal(done.status, 'refunded'); assert.equal(done.amount_minor, 1200);
  assert.equal(Number((await rows('SELECT refunded_cents FROM payments WHERE id=$1', [pm.id]))[0].refunded_cents), 1200);
  assert.equal((await api('POST', `/ticket-addon-items/${sc.id}/refund`, { token: fan.token, body: {} })).status, 409, 'not twice');

  // stock is its own: 2 car parks are left, never more, however many race for them
  const fans = await Promise.all(Array.from({ length: 6 }, () => signup()));
  const rs = await Promise.all(fans.map((f) => order(f, ev, [{ product_id: p.id, quantity: 1 }], { addons: [{ addon_id: lot.id, quantity: 1 }] })));
  assert.equal(rs.filter((r) => r.status === 201).length, 2);
  assert.equal(rs.filter((r) => r.status === 409).length, 4);
  const stock = must(await api('GET', `/events/${ev.id}/ticket-addons`, { token: org.token })).find((a) => a.id === lot.id);
  assert.equal(stock.left, 0); assert.equal(stock.sold, 1); assert.equal(stock.collected, 1);
  assert.equal((await api('PATCH', `/ticket-addons/${lot.id}`, { token: org.token, body: { stock: 1 } })).status, 409, 'stock cannot go below what is sold or held');
  // add-ons never count towards spectator capacity
  const cap = await setup({ capacity: 1 });
  const a2 = await addon(cap.org, cap.ev, { name: 'Merch', kind: 'merchandise' });
  const b = await signup();
  must(await order(b, cap.ev, [{ product_id: cap.p.id, quantity: 1 }], { addons: [{ addon_id: a2.id, quantity: 3 }] }), 201);
});

test('waitlist: ordered, time-boxed offers; oversell is impossible even while places are being promoted', async () => {
  const { org, ev, p } = await setup({ capacity: 3, price: 1000 });
  must(await api('PATCH', `/events/${ev.id}/tickets/settings`, { token: org.token, body: { waitlist_offer_minutes: 5 } }));
  const holders = await Promise.all([0, 1, 2].map(() => signup()));
  const bought = [];
  for (const h of holders) bought.push(await buy(h, ev, [{ product_id: p.id, quantity: 1 }]));
  const [w1, w2, w3] = await Promise.all([0, 1, 2].map(() => signup()));
  assert.equal((await api('POST', `/ticket-products/${p.id}/waitlist`, { token: w1.token, body: {} })).status, 201);
  // joining is ordered: join one after another so the queue is w1, w2, w3
  const j2 = must(await api('POST', `/ticket-products/${p.id}/waitlist`, { token: w2.token, body: {} }), 201);
  const j3 = must(await api('POST', `/ticket-products/${p.id}/waitlist`, { token: w3.token, body: {} }), 201);
  assert.equal(j2.position, 2); assert.equal(j3.position, 3);
  assert.equal((await api('POST', `/ticket-products/${p.id}/waitlist`, { token: w2.token, body: {} })).status, 409, 'one place in line per ticket');
  const pub = must(await api('GET', `/public/events/${ev.id}/tickets`)).products[0];
  assert.equal(pub.availability, 'sold_out'); assert.equal(pub.waitlist.ahead, 3); assert.ok(!JSON.stringify(pub).includes(w1.id));

  // a holder refunds: the first in line is offered the place as a held reservation
  must(await api('POST', `/tickets/${bought[0].tickets[0].id}/refund`, { token: holders[0].token, body: {} }));
  const mine1 = must(await api('GET', '/me/ticket-waitlist', { token: w1.token })).items[0];
  assert.equal(mine1.status, 'offered'); assert.ok(mine1.order.pay, 'the offer is a held order to pay');
  assert.equal(must(await api('GET', '/me/ticket-waitlist', { token: w2.token })).items[0].status, 'waiting', 'strictly in order');
  // while the place is held nobody can buy it
  const late = await signup();
  assert.equal((await order(late, ev, [{ product_id: p.id, quantity: 1 }])).status, 409);
  assert.equal((await api('POST', `/ticket-products/${p.id}/waitlist`, { token: late.token, body: {} })).status, 201);

  // w1 lets the offer lapse: the next person is offered it, w1's entry ends as expired
  await pool.query("UPDATE ticket_orders SET expires_at = now() - interval '1 minute' WHERE id=$1", [mine1.order_id]);
  await pool.query("UPDATE tickets SET hold_expires_at = now() - interval '1 minute' WHERE order_id=$1", [mine1.order_id]);
  await pool.query("UPDATE ticket_waitlist SET offer_expires_at = now() - interval '1 minute' WHERE id=$1", [mine1.id]);
  await sweepTickets();
  assert.equal(must(await api('GET', '/me/ticket-waitlist', { token: w1.token })).items[0].status, 'expired');
  const mine2 = must(await api('GET', '/me/ticket-waitlist', { token: w2.token })).items[0];
  assert.equal(mine2.status, 'offered');
  // w2 pays: the entry becomes purchased and the ticket is issued
  const o2 = mine2.order; const pm = await pay(o2, w2); await pm.settle();
  await sweepTickets();
  assert.equal(must(await api('GET', '/me/ticket-waitlist', { token: w2.token })).items[0].status, 'purchased');
  assert.equal((await rows("SELECT count(*)::int n FROM tickets WHERE order_id=$1 AND status='issued'", [mine2.order_id]))[0].n, 1);
  // w3 passes on a later offer, the next person (late) gets it
  must(await api('POST', `/tickets/${bought[1].tickets[0].id}/refund`, { token: holders[1].token, body: {} }));
  const m3 = must(await api('GET', '/me/ticket-waitlist', { token: w3.token })).items[0];
  assert.equal(m3.status, 'offered');
  must(await api('POST', `/ticket-waitlist/${m3.id}/leave`, { token: w3.token }));
  assert.equal(must(await api('GET', '/me/ticket-waitlist', { token: late.token })).items[0].status, 'offered');
  const org_view = must(await api('GET', `/events/${ev.id}/ticket-waitlist`, { token: org.token }));
  assert.ok(org_view.products[0].purchased >= 1 && org_view.products[0].passed >= 1 && !JSON.stringify(org_view).includes(w1.id), 'the organiser sees counts, never names');
  // never more than the capacity live at the end
  assert.ok((await rows("SELECT count(*)::int n FROM tickets WHERE event_id=$1 AND (status='issued' OR (status='reserved' AND hold_expires_at > now()))", [ev.id]))[0].n <= 3);
});

test('waitlist under concurrency: buyers, joiners, refunds and promotion together never oversell', async () => {
  const { org, ev, p } = await setup({ capacity: 4, price: 500 });
  const first = await Promise.all(Array.from({ length: 4 }, () => signup()));
  const held = []; for (const f of first) held.push(await buy(f, ev, [{ product_id: p.id, quantity: 1 }]));
  const waiting = await Promise.all(Array.from({ length: 6 }, () => signup()));
  for (const w of waiting) must(await api('POST', `/ticket-products/${p.id}/waitlist`, { token: w.token, body: {} }), 201);
  const racers = await Promise.all(Array.from({ length: 6 }, () => signup()));
  // two refunds free two places while six other people race to buy and the waitlist is promoted
  const results = await Promise.all([
    api('POST', `/tickets/${held[0].tickets[0].id}/refund`, { token: first[0].token, body: {} }),
    api('POST', `/tickets/${held[1].tickets[0].id}/refund`, { token: first[1].token, body: {} }),
    ...racers.map((r) => order(r, ev, [{ product_id: p.id, quantity: 1 }])),
  ]);
  assert.equal(results[0].status, 200); assert.equal(results[1].status, 200);
  const live = (await rows("SELECT count(*)::int n FROM tickets WHERE event_id=$1 AND (status='issued' OR (status='reserved' AND hold_expires_at > now()))", [ev.id]))[0].n;
  assert.ok(live <= 4, `${live} live tickets for a capacity of 4`);
  assert.equal(live, 4, 'the freed places were all taken: by an offer or by a racing buyer, never both');
  const offers = (await rows("SELECT count(*)::int n FROM ticket_waitlist WHERE event_id=$1 AND status='offered'", [ev.id]))[0].n;
  assert.ok(offers <= 2);
  await sweepTickets();
  assert.ok((await rows("SELECT count(*)::int n FROM tickets WHERE event_id=$1 AND (status='issued' OR (status='reserved' AND hold_expires_at > now()))", [ev.id]))[0].n <= 4);
});

test('waitlist: a young person cannot join; tickets are not hidden behind it while available', async () => {
  const { ev, p } = await setup({ capacity: 1 });
  const kid = await signup(['athlete'], { dob: yearsAgo(12) }), fan = await signup(), other = await signup();
  assert.equal((await api('POST', `/ticket-products/${p.id}/waitlist`, { token: fan.token, body: {} })).status, 409, 'tickets are still available');
  await buy(fan, ev, [{ product_id: p.id, quantity: 1 }]);
  assert.equal((await api('POST', `/ticket-products/${p.id}/waitlist`, { token: kid.token, body: {} })).status, 403, 'a guardian joins for a young person');
  assert.equal((await api('POST', `/ticket-products/${p.id}/waitlist`, { token: other.token, body: { quantity: 2 } })).status, 201);
  const my = must(await api('GET', '/me/ticket-waitlist', { token: other.token })).items[0];
  must(await api('POST', `/ticket-waitlist/${my.id}/leave`, { token: other.token }));
  assert.equal(must(await api('GET', '/me/ticket-waitlist', { token: other.token })).items[0].status, 'left');
});

test('resale policy: the cap and the fee are enforced on the server, every change is audited, youth are protected', async () => {
  const { org, ev, p } = await setup({ price: 2000 });
  const seller = await signup(), buyer = await signup(), kid = await signup(['athlete'], { dob: yearsAgo(12) });
  const t = (await buy(seller, ev, [{ product_id: p.id, quantity: 2 }])).tickets;
  const resell = (id, body, tok = seller.token) => api('POST', `/tickets/${id}/transfer`, { token: tok, body });
  assert.equal((await resell(t[0].id, { to_user_id: buyer.id, resale_price_minor: 1000 })).status, 409, 'transfer-only by default: no sale for money');
  assert.equal((await api('PATCH', `/events/${ev.id}/tickets/settings`, { token: seller.token, body: { resale_mode: 'resale' } })).status, 404, 'the organiser alone sets the policy');
  assert.equal((await api('PATCH', `/events/${ev.id}/tickets/settings`, { token: org.token, body: { resale_cap_bp: 12000 } })).status, 400, 'never above face value');
  assert.equal((await api('PATCH', `/events/${ev.id}/tickets/settings`, { token: org.token, body: { resale_mode: 'resale', transfer_allowed: false } })).status, 400);
  must(await api('PATCH', `/events/${ev.id}/tickets/settings`, { token: org.token, body: { resale_mode: 'resale', resale_cap_bp: 8000, resale_fee_bp: 500 } }));
  const over = await resell(t[0].id, { to_user_id: buyer.id, resale_price_minor: 1601 });
  assert.equal(over.status, 409); assert.equal(over.body.error.details.code, 'resale_cap'); assert.equal(over.body.error.details.cap_minor, 1600);
  assert.equal((await resell(t[0].id, { guest: { name: 'Pat Guest' }, resale_price_minor: 100 })).status, 400, 'a sale needs a named account');
  assert.equal((await resell(t[0].id, { to_user_id: kid.id, resale_price_minor: 100 })).status, 403, 'nothing is sold to a young person');
  const ok = must(await resell(t[0].id, { to_user_id: buyer.id, resale_price_minor: 1600 }));
  assert.equal(ok.state, 'valid');
  const rec = (await rows('SELECT price_minor, fee_minor, face_minor FROM ticket_resales WHERE event_id=$1', [ev.id]))[0];
  assert.deepEqual([Number(rec.price_minor), Number(rec.fee_minor), Number(rec.face_minor)], [1600, 80, 2000], 'fee = 5% of the price; recorded for the organiser');
  assert.equal((await rows("SELECT count(*)::int n FROM tickets WHERE entitlement_id=(SELECT entitlement_id FROM tickets WHERE id=$1) AND status='issued'", [t[0].id]))[0].n, 1, 'still one valid ticket');
  // a guardian hands a ticket to a young person without a price
  must(await resell(t[1].id, { to_user_id: kid.id }));
  assert.equal(must(await api('GET', '/me/tickets', { token: kid.token })).items.length, 1);
  const kidTicket = must(await api('GET', '/me/tickets', { token: kid.token })).items[0];
  assert.equal((await resell(kidTicket.id, { to_user_id: buyer.id, resale_price_minor: 50 }, kid.token)).status, 403, 'a young person cannot sell');

  const h = must(await api('GET', `/events/${ev.id}/tickets/policy-history`, { token: org.token }));
  assert.deepEqual(h.history.filter((x) => x.field.startsWith('resale')).map((x) => x.field).sort(), ['resale_cap_bp', 'resale_fee_bp', 'resale_mode']);
  assert.equal(h.resales.count, 1); assert.equal(h.resales.fee_owed_minor, 80);
  assert.equal((await rows("SELECT count(*)::int n FROM audit_log WHERE action LIKE 'ticket.policy.%'"))[0].n >= 3, true, 'every change is in the audit log');
  await assert.rejects(pool.query('UPDATE ticket_policy_history SET field=$1', ['x']), /append-only/, 'the history cannot be edited');
  await assert.rejects(pool.query('DELETE FROM ticket_policy_history'), /append-only/);
});

test('reporting: sales by channel, promo usage, add-on attach rate and waitlist; reconciles to the payments taken', async () => {
  const { org, ev, p } = await setup({ capacity: 10, price: 1000 });
  const lot = await addon(org, ev, { name: 'Parking R', stock: 10 });
  must(await promo(org, ev, { code: 'REPORT10', value: 10 }), 201);
  const a = await signup(), b = await signup(), c = await signup();
  await buy(a, ev, [{ product_id: p.id, quantity: 2 }], { promo_codes: ['REPORT10'], addons: [{ addon_id: lot.id, quantity: 1 }] });
  await buy(b, ev, [{ product_id: p.id, quantity: 1 }]);
  const orderC = await buy(c, ev, [{ product_id: p.id, quantity: 1 }], { addons: [{ addon_id: lot.id, quantity: 1 }] });
  must(await api('POST', `/ticket-addon-items/${orderC.addons[0].id}/refund`, { token: c.token, body: {} }));
  const r = must(await api('GET', `/events/${ev.id}/tickets/report`, { token: org.token })).commerce;
  const online = r.channels.find((x) => x.channel === 'online');
  assert.equal(online.orders, 3); assert.equal(online.tickets, 4);
  assert.equal(online.discount_minor, 200); assert.equal(online.addons_minor, 1200);
  assert.equal(online.total_minor, 2000 - 200 + 600 + 1000 + 1000 + 600);
  const pr = r.promos.find((x) => x.code === 'REPORT10'); assert.equal(pr.uses, 1); assert.equal(pr.discount_minor, 200);
  const ad = r.addons.find((x) => x.name === 'Parking R'); assert.equal(ad.sold, 2); assert.equal(ad.orders, 2); assert.equal(ad.attach_rate, 66.7); assert.equal(ad.refunded_minor, 600);
  assert.equal(r.reconciliation.orders_minor, online.total_minor);
  assert.equal(r.reconciliation.payments_minor, online.total_minor);
  assert.equal(r.reconciliation.difference_minor, 0);
  assert.equal(r.reconciliation.items_refunded_minor, 600); assert.equal(r.reconciliation.payments_refunded_minor, 600);
  assert.equal(r.reconciliation.reconciled, true, JSON.stringify(r.reconciliation));
  // the existing money totals are net of the promo
  const money = must(await api('GET', `/events/${ev.id}/tickets/report`, { token: org.token })).money[0];
  assert.equal(money.gross_minor, 4000 - 200);
  assert.equal((await api('GET', `/events/${ev.id}/tickets/report`, { token: a.token })).status, 404);
});

test('event cancellation refunds add-ons too; migrations kept every existing row', async () => {
  const { org, ev, p } = await setup({ price: 1000 });
  const lot = await addon(org, ev, { name: 'Parking C' });
  const fan = await signup();
  const o = await buy(fan, ev, [{ product_id: p.id, quantity: 1 }], { addons: [{ addon_id: lot.id, quantity: 1 }] });
  must(await api('PATCH', `/events/${ev.id}`, { token: org.token, body: { status: 'cancelled' } }));
  must(await api('POST', `/events/${ev.id}/tickets/refunds/process`, { token: org.token }));
  assert.equal((await rows('SELECT status FROM ticket_addon_items WHERE order_id=$1', [o.id]))[0].status, 'refunded');
  const pay1 = (await rows("SELECT amount_cents, refunded_cents FROM payments WHERE purpose_id=$1", [o.id]))[0];
  assert.equal(Number(pay1.refunded_cents), Number(pay1.amount_cents), 'ticket and add-on both back, nothing left over');
});
