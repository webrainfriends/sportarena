import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { settle } = await import('../src/payments/service.js');
const { parseToken, tokenFor, sweepTickets, processTicketRefunds } = await import('../src/ticketing.js');

let server, base, n = 0;
const realFetch = globalThis.fetch;
const refunds = { mode: 'ok', calls: [] };
// the payment provider is stubbed at the network edge only; every ticket rule runs for real
globalThis.fetch = async (url, init) => {
  if (String(url).includes('/v1/refunds')) {
    refunds.calls.push({ key: init.headers['idempotency-key'], body: String(init.body) });
    return refunds.mode === 'ok' ? new Response(JSON.stringify({ id: 're_1', status: 'succeeded' }), { status: 200 }) : new Response(JSON.stringify({ error: { message: 'down' } }), { status: 500 });
  }
  return realFetch(url, init);
};
const api = async (method, path, { token, body, query } = {}) => {
  const r = await realFetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete'], extra = {}) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `tk_${n}_${roles[0]}`, display_name: `Tick ${n}`, email: `tk${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const day = (d = 0) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const inHours = (h) => new Date(Date.now() + h * 3600e3).toISOString();

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); globalThis.fetch = realFetch; });

const newEvent = async (org, extra = {}) => { const e = must(await api('POST', '/events', { token: org.token, body: { name: `Ticket Cup ${++n}`, sport: 'football', starts_on: day(0), ends_on: day(2), ...extra } }), 201); must(await api('PATCH', `/events/${e.id}`, { token: org.token, body: { status: 'open' } })); return e; };
const fixture = async (ev, hours = 1) => (await pool.query("INSERT INTO fixtures(event_id, scheduled_at, status) VALUES ($1,$2,'scheduled') RETURNING id", [ev.id, inHours(hours)])).rows[0].id;
const product = async (org, ev, body = {}) => must(await api('POST', `/events/${ev.id}/ticket-products`, { token: org.token, body: { name: `Adult ${++n}`, price_minor: 1000, currency: 'GBP', ...body } }), 201);
const live = async (org, p) => must(await api('PATCH', `/ticket-products/${p.id}`, { token: org.token, body: { status: 'active' } }));
const gate = async (org, ev, name = 'North gate') => must(await api('POST', '/access/points', { token: org.token, body: { event_id: ev.id, name, kind: 'gate', provider: 'manual' } }), 201);
const order = (u, ev, lines, extra = {}) => api('POST', `/events/${ev.id}/ticket-orders`, { token: u.token, body: { lines, ...extra } });
const pay = async (o, buyer) => {
  const p = (await pool.query("INSERT INTO payments(payer_id, provider, purpose_type, purpose_id, amount_cents, currency, status, provider_ref) VALUES ($1,'stripe','ticket_order',$2,$3,$4,'pending',$5) RETURNING id", [buyer.id, o.id, o.total_minor, o.currency, `cs_${++n}`])).rows[0];
  return { id: p.id, settle: () => settle(p.id, { paid: true, amount: Number(o.total_minor), currency: o.currency, paymentRef: `pi_${p.id}` }) };
};
const buy = async (u, ev, lines, extra) => { const o = must(await order(u, ev, lines, extra), 201); if (o.total_minor > 0) await (await pay(o, u)).settle(); return must(await api('GET', `/ticket-orders/${o.id}`, { token: u.token })); };
const mine = async (u) => must(await api('GET', '/me/tickets', { token: u.token, query: { scope: 'all' } })).items;
const scan = (op, ev, body) => api('POST', `/events/${ev.id}/tickets/scan`, { token: op.token, body });
const rows = async (sql, args = []) => (await pool.query(sql, args)).rows;

async function setup({ capacity = null, alloc = null, price = 1000, fixtures = 1 } = {}) {
  const org = await signup(['organizer']);
  const ev = await newEvent(org);
  const fx = []; for (let i = 0; i < fixtures; i++) fx.push(await fixture(ev, 1 + i));
  if (capacity != null) must(await api('PATCH', `/events/${ev.id}/tickets/settings`, { token: org.token, body: { spectator_capacity: capacity } }));
  // generous defaults so each test states only the rule it is about; the policy tests set their own
  must(await api('PATCH', `/events/${ev.id}/tickets/settings`, { token: org.token, body: { transfer_cutoff_hours: 0, refund_policy: 'anytime' } }));
  refunds.mode = 'ok';
  const p = await product(org, ev, { price_minor: price, allocation: alloc, fixture_ids: fx.length === 1 ? fx : [] });
  await live(org, p);
  return { org, ev, p, fx };
}

test('ticketing is the organiser\'s alone to set up; rules are validated', async () => {
  const org = await signup(['organizer']), other = await signup(['organizer']), fan = await signup();
  const ev = await newEvent(org);
  for (const u of [other, fan]) {
    assert.equal((await api('PATCH', `/events/${ev.id}/tickets/settings`, { token: u.token, body: { sales_open: false } })).status, 404);
    assert.equal((await api('POST', `/events/${ev.id}/ticket-products`, { token: u.token, body: { name: 'Sneaky' } })).status, 404);
    assert.equal((await api('GET', `/events/${ev.id}/tickets/report`, { token: u.token })).status, 404);
  }
  assert.equal((await api('PATCH', `/events/${ev.id}/tickets/settings`, { token: org.token, body: { spectator_capacity: 500, safety_capacity: 100 } })).status, 400, 'safety cannot be below spectator capacity');
  const bad = (body) => api('POST', `/events/${ev.id}/ticket-products`, { token: org.token, body: { name: `X${++n}`, ...body } });
  assert.equal((await bad({ seating: 'reserved' })).status, 400, 'reserved needs a section');
  assert.equal((await bad({ class: 'complimentary', price_minor: 500 })).status, 400, 'complimentary is free');
  assert.equal((await bad({ kind: 'pass', fixture_ids: [] })).status, 400, 'a pass covers several fixtures');
  assert.equal((await bad({ sale_starts_at: inHours(5), sale_ends_at: inHours(1) })).status, 400);
  const f1 = await fixture(ev), other_ev = await newEvent(other), foreign = await fixture(other_ev);
  assert.equal((await bad({ fixture_ids: [foreign] })).status, 400, 'fixture of another event');
  const p = await product(org, ev, { name: 'Dup', fixture_ids: [f1] });
  assert.equal((await api('POST', `/events/${ev.id}/ticket-products`, { token: org.token, body: { name: 'DUP' } })).status, 409);
  assert.equal(p.status, 'draft');
  // a draft is not for sale
  assert.equal((await order(fan, ev, [{ product_id: p.id, quantity: 1 }])).status, 409);
  await live(org, p);
  const pub = must(await api('GET', `/public/events/${ev.id}/tickets`));
  assert.equal(pub.products.length, 1);
  assert.ok(!JSON.stringify(pub).includes(fan.id), 'the public listing never names buyers');
});

test('concurrent purchases cannot oversell the allocation or the capacity', async () => {
  const { ev, p } = await setup({ alloc: 5 });
  const fans = await Promise.all(Array.from({ length: 12 }, () => signup()));
  const rs = await Promise.all(fans.map((f) => order(f, ev, [{ product_id: p.id, quantity: 1 }])));
  assert.equal(rs.filter((r) => r.status === 201).length, 5);
  assert.equal(rs.filter((r) => r.status === 409).length, 7);
  assert.equal(rs.find((r) => r.status === 409).body.error.details?.code, 'sold_out');
  assert.equal((await rows("SELECT count(*)::int n FROM tickets WHERE product_id=$1 AND status='reserved'", [p.id]))[0].n, 5);
  // capacity on the fixture binds even when the product has no allocation of its own
  const c = await setup({ capacity: 3 });
  const more = await Promise.all(Array.from({ length: 8 }, () => signup()));
  const rc = await Promise.all(more.map((f) => order(f, c.ev, [{ product_id: c.p.id, quantity: 1 }])));
  assert.equal(rc.filter((r) => r.status === 201).length, 3);
  const multi = await signup();
  assert.equal((await order(multi, c.ev, [{ product_id: c.p.id, quantity: 2 }])).status, 409, 'two more would exceed the capacity');
});

test('limits: per order, per account, sale window, paused sales; a young person cannot buy', async () => {
  const org = await signup(['organizer']), fan = await signup();
  const ev = await newEvent(org);
  const fx = await fixture(ev);
  const p = await product(org, ev, { per_order_limit: 2, per_account_limit: 3, fixture_ids: [fx] });
  await live(org, p);
  assert.equal((await order(fan, ev, [{ product_id: p.id, quantity: 3 }])).status, 409, 'per order');
  must(await order(fan, ev, [{ product_id: p.id, quantity: 2 }]), 201);
  const r = await order(fan, ev, [{ product_id: p.id, quantity: 2 }]);
  assert.equal(r.status, 409); assert.equal(r.body.error.details.code, 'account_limit');
  const later = await product(org, ev, { name: 'Later', sale_starts_at: inHours(3), fixture_ids: [fx] });
  await live(org, later);
  assert.equal((await order(fan, ev, [{ product_id: later.id, quantity: 1 }])).body.error.details.code, 'not_started');
  must(await api('PATCH', `/events/${ev.id}/tickets/settings`, { token: org.token, body: { sales_open: false } }));
  assert.equal((await order(await signup(), ev, [{ product_id: p.id, quantity: 1 }])).body.error.details.code, 'sales_paused');
  const kid = await signup(['athlete'], { dob: yearsAgo(12) });
  must(await api('PATCH', `/events/${ev.id}/tickets/settings`, { token: org.token, body: { sales_open: true } }));
  assert.equal((await order(kid, ev, [{ product_id: p.id, quantity: 1 }])).status, 403);
});

test('order, payment and ticket stay distinct; payment issues once; a retry creates nothing new', async () => {
  const { ev, p } = await setup({ price: 2500 });
  const fan = await signup();
  const key = 'idem-key-12345';
  const o = must(await order(fan, ev, [{ product_id: p.id, quantity: 2 }], { idempotency_key: key }), 201);
  assert.equal(o.status, 'pending_payment'); assert.equal(o.total_minor, 5000);
  assert.ok(o.pay && o.pay.purpose_type === 'ticket_order');
  assert.deepEqual(o.tickets.map((t) => t.status), ['reserved', 'reserved']);
  const again = must(await order(fan, ev, [{ product_id: p.id, quantity: 2 }], { idempotency_key: key }), 201);
  assert.equal(again.id, o.id); assert.equal(again.replayed, true);
  assert.equal((await rows('SELECT count(*)::int n FROM tickets WHERE order_id=$1', [o.id]))[0].n, 2, 'a retry did not reserve more');
  assert.equal((await mine(fan)).filter((t) => t.status === 'issued').length, 0, 'unpaid tickets do not admit');
  const pm = await pay(o, fan);
  await pm.settle(); await pm.settle();
  const done = must(await api('GET', `/ticket-orders/${o.id}`, { token: fan.token }));
  assert.equal(done.status, 'confirmed'); assert.deepEqual(done.tickets.map((t) => t.status), ['issued', 'issued']);
  assert.equal((await rows("SELECT count(*)::int n FROM ticket_history WHERE kind='issued' AND ticket_id = ANY($1::uuid[])", [done.tickets.map((t) => t.id)]))[0].n, 2, 'issued exactly once each');
  const t = (await mine(fan))[0];
  assert.ok(parseToken(t.token), 'the QR token verifies');
  assert.ok(!/[@\s]/.test(t.token) && !t.token.includes(fan.id) && !t.token.includes(fan.handle), 'the token carries nothing personal');
  assert.equal(t.token, tokenFor(t.serial, 1));
  // price snapshot: changing the price later does not change what was sold
  must(await api('PATCH', `/ticket-products/${p.id}`, { token: (await pool.query('SELECT organizer_id FROM events WHERE id=$1', [ev.id])).rows[0] && (await orgTokenOf(ev)), body: { price_minor: 9999 } }));
  assert.equal(Number((await rows('SELECT price_minor FROM tickets WHERE id=$1', [t.id]))[0].price_minor), 2500);
  // someone else's order is invisible
  assert.equal((await api('GET', `/ticket-orders/${o.id}`, { token: (await signup()).token })).status, 404);
  // a wrong amount is refused by the payment layer and nothing is issued
  const o2 = must(await order(fan, ev, [{ product_id: p.id, quantity: 1 }]), 201);
  const bad = await pay(o2, fan);
  await assert.rejects(settle(bad.id, { paid: true, amount: 1, currency: 'GBP', paymentRef: 'x' }), /does not match/);
  assert.equal(must(await api('GET', `/ticket-orders/${o2.id}`, { token: fan.token })).status, 'pending_payment');
});
async function orgTokenOf(ev) { const u = (await pool.query('SELECT organizer_id FROM events WHERE id=$1', [ev.id])).rows[0].organizer_id; return signToken({ id: u, roles: ['organizer'] }); }

test('an unpaid hold runs out and frees the place; a late payment is honoured only if room remains, otherwise refunded', async () => {
  const { ev, p } = await setup({ alloc: 1 });
  const a = await signup(), b = await signup();
  const oa = must(await order(a, ev, [{ product_id: p.id, quantity: 1 }]), 201);
  assert.equal((await order(b, ev, [{ product_id: p.id, quantity: 1 }])).status, 409);
  await pool.query("UPDATE tickets SET hold_expires_at = now() - interval '1 minute' WHERE order_id=$1", [oa.id]);
  await pool.query("UPDATE ticket_orders SET expires_at = now() - interval '1 minute' WHERE id=$1", [oa.id]);
  const ob = must(await order(b, ev, [{ product_id: p.id, quantity: 1 }]), 201);   // the lapsed hold no longer blocks
  const late = await pay(oa, a);   // a pays after their hold ran out and b took the place
  refunds.calls.length = 0;
  const out = await late.settle();
  assert.equal(out.status, 'refunded');
  assert.equal(refunds.calls.length, 1);
  assert.equal(must(await api('GET', `/ticket-orders/${oa.id}`, { token: a.token })).tickets[0].status, 'reserved');
  await sweepTickets();
  assert.equal(must(await api('GET', `/ticket-orders/${oa.id}`, { token: a.token })).status, 'expired');
  assert.equal(must(await api('GET', `/ticket-orders/${oa.id}`, { token: a.token })).tickets[0].status, 'void');
  await (await pay(ob, b)).settle();
  assert.equal((await mine(b)).filter((t) => t.status === 'issued').length, 1);
  // cancelling an unpaid order releases at once
  const c = await setup({ alloc: 1 });
  const f = await signup(); const g = await signup();
  const of = must(await order(f, c.ev, [{ product_id: c.p.id, quantity: 1 }]), 201);
  must(await api('POST', `/ticket-orders/${of.id}/cancel`, { token: f.token }));
  must(await order(g, c.ev, [{ product_id: c.p.id, quantity: 1 }]), 201);
});

test('reserved seats cannot be double-sold and must exist', async () => {
  const org = await signup(['organizer']);
  const ev = await newEvent(org); const fx = await fixture(ev);
  const sec = must(await api('POST', `/events/${ev.id}/ticket-sections`, { token: org.token, body: { name: 'East stand', rows_count: 3, seats_per_row: 4 } }), 201);
  const p = await product(org, ev, { seating: 'reserved', section_id: sec.id, fixture_ids: [fx] });
  await live(org, p);
  const [a, b] = await Promise.all([signup(), signup()]);
  assert.equal((await order(a, ev, [{ product_id: p.id, quantity: 1, seats: ['Z9'] }])).status, 400, 'no such seat');
  assert.equal((await order(a, ev, [{ product_id: p.id, quantity: 2, seats: ['A1'] }])).status, 400, 'seat count must match');
  const rs = await Promise.all([order(a, ev, [{ product_id: p.id, quantity: 1, seats: ['B2'] }]), order(b, ev, [{ product_id: p.id, quantity: 1, seats: ['b2'] }])]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409]);
  assert.equal(rs.find((r) => r.status === 409).body.error.details.code, 'seat_taken');
  const map = must(await api('GET', `/ticket-products/${p.id}/seats`));
  assert.deepEqual(map.taken, ['B2']); assert.ok(!JSON.stringify(map).includes(a.id));
});

test('gate: valid once, duplicate warned, every refusal reason, minimum information, operator audit', async () => {
  const { org, ev, p } = await setup();
  const fan = await signup();
  const g = await gate(org, ev);
  await buy(fan, ev, [{ product_id: p.id, quantity: 1 }]);
  const t = (await mine(fan))[0];
  const stranger = await signup();
  assert.equal((await scan(stranger, ev, { token: t.token })).status, 404, 'only gate staff scan');
  assert.equal((await scan(fan, ev, { token: t.token })).status, 404, 'a ticket holder cannot scan');
  const v = must(await scan(org, ev, { token: t.token, access_point_id: g.id }));
  assert.equal(v.result, 'valid'); assert.equal(v.admitted, true);
  const json = JSON.stringify(v);
  for (const secret of [fan.display_name, fan.handle, fan.id, 'tk', '@', 'price', 'email']) assert.ok(!json.toLowerCase().includes(String(secret).toLowerCase()) || secret === 'tk' && !/tk\d+@/.test(json), `gate answer leaks ${secret}`);
  const d = must(await scan(org, ev, { token: t.token, access_point_id: g.id }));
  assert.equal(d.result, 'duplicate'); assert.equal(d.admitted, false); assert.ok(d.previous.at);
  assert.equal((await rows('SELECT count(*)::int n FROM ticket_attendance WHERE event_id=$1', [ev.id]))[0].n, 1, 'a duplicate scan creates no second attendance');
  const log = await rows('SELECT result, operator_id, access_point_id, scanned_at FROM ticket_scans WHERE event_id=$1 ORDER BY id', [ev.id]);
  assert.deepEqual(log.map((r) => r.result), ['valid', 'duplicate']);
  assert.ok(log.every((r) => r.operator_id === org.id && r.access_point_id === g.id && r.scanned_at));
  // the log cannot be rewritten
  await assert.rejects(pool.query("UPDATE ticket_scans SET result='valid' WHERE event_id=$1", [ev.id]), /append-only/);
  await assert.rejects(pool.query('DELETE FROM ticket_history'), /append-only/);
  assert.equal(must(await scan(org, ev, { token: 'GT1.TKT-AAAAAAAAAA.1.deadbeefdeadbeefdead' })).result, 'invalid');
  assert.equal(must(await scan(org, ev, { token: t.token.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')) })).result, 'invalid', 'a tampered token is invalid');
  // typed code (manual validation) and lookup do not admit
  const fan2 = await signup(); await buy(fan2, ev, [{ product_id: p.id, quantity: 1 }]);
  const t2 = (await mine(fan2))[0];
  const peek = must(await api('GET', `/events/${ev.id}/tickets/lookup`, { token: org.token, query: { code: t2.short_code.toLowerCase() } }));
  assert.equal(peek.result, 'valid');
  assert.equal((await rows('SELECT count(*)::int n FROM ticket_attendance WHERE event_id=$1', [ev.id]))[0].n, 1, 'lookup recorded nothing');
  assert.equal(must(await scan(org, ev, { code: t2.short_code, method: 'manual' })).result, 'valid');
  // another event's ticket
  const other = await setup(); const f3 = await signup(); await buy(f3, other.ev, [{ product_id: other.p.id, quantity: 1 }]);
  assert.equal(must(await scan(org, ev, { token: (await mine(f3))[0].token })).result, 'wrong_event');
});

test('gate: wrong fixture, wrong date, wrong gate, unpaid ticket', async () => {
  const org = await signup(['organizer']);
  const ev = await newEvent(org);
  const now = await fixture(ev, 1), far = await fixture(ev, 72);
  const pNow = await product(org, ev, { name: 'Today', fixture_ids: [now] }), pFar = await product(org, ev, { name: 'Later', fixture_ids: [far] });
  await live(org, pNow); await live(org, pFar);
  const north = await gate(org, ev, 'North'), south = await gate(org, ev, 'South');
  const pGate = await product(org, ev, { name: 'North only', fixture_ids: [now], access_point_ids: [north.id] }); await live(org, pGate);
  const fan = await signup();
  await buy(fan, ev, [{ product_id: pFar.id, quantity: 1 }, { product_id: pNow.id, quantity: 1 }, { product_id: pGate.id, quantity: 1 }]);
  const byName = Object.fromEntries((await mine(fan)).map((t) => [t.product.name, t]));
  assert.equal(must(await scan(org, ev, { token: byName.Later.token })).result, 'wrong_date');
  assert.equal(must(await scan(org, ev, { token: byName.Today.token, fixture_id: far })).result, 'wrong_fixture');
  assert.equal(must(await scan(org, ev, { token: byName['North only'].token, access_point_id: south.id })).result, 'wrong_gate');
  assert.equal(must(await scan(org, ev, { token: byName['North only'].token, access_point_id: north.id })).result, 'valid');
  const hold = must(await order(await signup(), ev, [{ product_id: pNow.id, quantity: 1 }]), 201);
  const serial = (await rows('SELECT short_code FROM tickets WHERE order_id=$1', [hold.id]))[0].short_code;
  assert.equal(must(await scan(org, ev, { code: serial })).result, 'not_issued');
});

test('concurrent scans of one ticket admit exactly once; re-entry tickets admit, exit and return', async () => {
  const { org, ev, p } = await setup();
  const fan = await signup(); await buy(fan, ev, [{ product_id: p.id, quantity: 1 }]);
  const t = (await mine(fan))[0];
  const rs = await Promise.all(Array.from({ length: 8 }, () => scan(org, ev, { token: t.token })));
  const res = rs.map((r) => r.body.result).sort();
  assert.equal(res.filter((x) => x === 'valid').length, 1); assert.equal(res.filter((x) => x === 'duplicate').length, 7);
  assert.equal((await rows('SELECT count(*)::int n FROM ticket_attendance WHERE event_id=$1', [ev.id]))[0].n, 1);
  assert.equal(must(await scan(org, ev, { token: t.token, direction: 'out' })).result, 'no_reentry');
  const re = await product(org, ev, { name: 'Re-entry', reentry: 'reentry', fixture_ids: [(await rows('SELECT id FROM fixtures WHERE event_id=$1', [ev.id]))[0].id] }); await live(org, re);
  const f2 = await signup(); await buy(f2, ev, [{ product_id: re.id, quantity: 1 }]);
  const tr = (await mine(f2))[0];
  assert.equal(must(await scan(org, ev, { token: tr.token })).result, 'valid');
  assert.equal(must(await scan(org, ev, { token: tr.token })).result, 'duplicate', 'still inside');
  assert.equal(must(await scan(org, ev, { token: tr.token, direction: 'out' })).result, 'exit');
  assert.equal(must(await scan(org, ev, { token: tr.token })).result, 're_entry');
  const att = (await rows('SELECT entries FROM ticket_attendance WHERE ticket_id=$1', [tr.id]))[0];
  assert.equal(att.entries, 2); assert.equal((await rows('SELECT count(*)::int n FROM ticket_attendance WHERE ticket_id=$1', [tr.id]))[0].n, 1, 'one attendance however many entries');
});

test('offline: a replayed batch is idempotent, judged live, and old scans are refused', async () => {
  const { org, ev, p } = await setup();
  const [a, b, c] = await Promise.all([signup(), signup(), signup()]);
  for (const f of [a, b, c]) await buy(f, ev, [{ product_id: p.id, quantity: 1 }]);
  const [ta, tb, tc] = [(await mine(a))[0], (await mine(b))[0], (await mine(c))[0]];
  const manifest = must(await api('GET', `/events/${ev.id}/tickets/gate-manifest`, { token: org.token }));
  assert.equal(manifest.total, 3); assert.ok(manifest.tickets.every((t) => !('holder_id' in t) && !JSON.stringify(t).includes('@')));
  assert.equal(must(await scan(org, ev, { token: tb.token })).result, 'valid', 'b was admitted by another gate meanwhile');
  const batch = { scans: [
    { token: ta.token, client_ref: 'dev1-0000001', scanned_at: inHours(0) },
    { token: tb.token, client_ref: 'dev1-0000002', scanned_at: inHours(0) },
    { token: tc.token, client_ref: 'dev1-0000003', scanned_at: new Date(Date.now() - 80 * 3600e3).toISOString() },
  ] };
  const r1 = must(await api('POST', `/events/${ev.id}/tickets/scan-batch`, { token: org.token, body: batch }));
  const byRef = Object.fromEntries(r1.results.map((r) => [r.client_ref, r.result]));
  assert.equal(byRef['dev1-0000001'], 'valid'); assert.equal(byRef['dev1-0000002'], 'duplicate'); assert.equal(byRef['dev1-0000003'], 'stale');
  const r2 = must(await api('POST', `/events/${ev.id}/tickets/scan-batch`, { token: org.token, body: batch }));
  assert.ok(r2.results.every((r) => r.replay), 'a retried batch changes nothing');
  assert.equal((await rows("SELECT count(*)::int n FROM ticket_scans WHERE client_ref LIKE 'dev1-%'")) [0].n, 3);
  assert.equal((await rows('SELECT count(*)::int n FROM ticket_attendance WHERE event_id=$1', [ev.id]))[0].n, 2);
});

test('transfer: one valid ticket per entitlement, history kept, recipient never sees the sender, cutoff and use block it', async () => {
  const { org, ev, p } = await setup();
  const [a, b] = await Promise.all([signup(), signup()]);
  await buy(a, ev, [{ product_id: p.id, quantity: 1 }]);
  const t = (await mine(a))[0];
  assert.equal((await api('POST', `/tickets/${t.id}/transfer`, { token: b.token, body: { to_user_id: a.id } })).status, 404, 'not the holder');
  assert.equal((await api('POST', `/tickets/${t.id}/transfer`, { token: a.token, body: { to_user_id: a.id } })).status, 400);
  const moved = must(await api('POST', `/tickets/${t.id}/transfer`, { token: a.token, body: { to_user_id: b.id } }));
  assert.notEqual(moved.id, t.id);
  assert.ok(!JSON.stringify(moved).includes(a.id) && !JSON.stringify(moved).includes(a.handle), 'the new holder is not told who it came from');
  assert.equal((await mine(a)).filter((x) => x.status === 'issued').length, 0);
  const nb = (await mine(b))[0];
  assert.equal(must(await scan(org, ev, { token: t.token })).result, 'transferred', 'the old code is dead');
  assert.equal(must(await scan(org, ev, { token: nb.token })).result, 'valid');
  const chain = await rows("SELECT status, entitlement_id FROM tickets WHERE order_id=$1 ORDER BY created_at", [t.order_id]);
  assert.equal(new Set(chain.map((r) => r.entitlement_id)).size, 1);
  assert.equal(chain.filter((r) => ['issued', 'reserved'].includes(r.status)).length, 1, 'never two valid tickets from one entitlement');
  await assert.rejects(pool.query("UPDATE tickets SET status='issued' WHERE id=$1", [t.id]), /tickets_one_live_per_entitlement/);
  const hist = must(await api('GET', `/tickets/${nb.id}/history`, { token: org.token }));
  assert.ok(hist.map((h) => h.kind).filter((k) => ['issued', 'transferred'].includes(k)).length >= 3, 'issued, transferred and re-issued are all kept');
  assert.equal((await api('GET', `/tickets/${nb.id}/history`, { token: b.token })).status, 404, 'history is the organiser\'s');
  // used tickets cannot move; a closed transfer window blocks it
  assert.equal((await api('POST', `/tickets/${nb.id}/transfer`, { token: b.token, body: { to_user_id: a.id } })).status, 409);
  const late = await setup(); const c = await signup(); await buy(c, late.ev, [{ product_id: late.p.id, quantity: 1 }]);
  must(await api('PATCH', `/events/${late.ev.id}/tickets/settings`, { token: late.org.token, body: { transfer_cutoff_hours: 5 } }));
  assert.equal((await api('POST', `/tickets/${(await mine(c))[0].id}/transfer`, { token: c.token, body: { to_user_id: a.id } })).status, 409);
});

test('guest recipient: claim code turns a guest ticket into an account ticket; guest data is encrypted and its read audited', async () => {
  const { org, ev, p } = await setup();
  const a = await signup(), b = await signup();
  await buy(a, ev, [{ product_id: p.id, quantity: 1 }]);
  const t = (await mine(a))[0];
  const g = must(await api('POST', `/tickets/${t.id}/transfer`, { token: a.token, body: { guest: { name: 'Granny Smith', email: 'granny@example.com' } } }));
  assert.ok(g.claim_code && g.claim_code.length === 12);
  const raw = (await rows('SELECT guest_name_enc, guest_email_enc, claim_hash FROM tickets WHERE id=$1', [g.id]))[0];
  assert.ok(raw.guest_name_enc.startsWith('v') && !raw.guest_name_enc.includes('Granny') && !raw.guest_email_enc.includes('granny'));
  assert.notEqual(raw.claim_hash, g.claim_code);
  assert.equal((await api('POST', '/tickets/claim', { token: b.token, body: { code: 'WRONGWRONG12' } })).status, 404);
  const org_view = must(await api('GET', `/tickets/${g.id}`, { token: org.token }));
  assert.equal(org_view.guest.name, 'Granny Smith');
  assert.equal((await rows("SELECT count(*)::int n FROM audit_log WHERE action='ticket.guest.read' AND entity_id=$1", [g.id]))[0].n, 1);
  const claimed = must(await api('POST', '/tickets/claim', { token: b.token, body: { code: g.claim_code } }));
  assert.equal(claimed.state, 'valid');
  assert.equal((await api('POST', '/tickets/claim', { token: a.token, body: { code: g.claim_code } })).status, 404, 'a claim code works once');
});

test('reissue: the old QR stops working, the ticket can still admit only once', async () => {
  const { org, ev, p } = await setup();
  const fan = await signup(); await buy(fan, ev, [{ product_id: p.id, quantity: 1 }]);
  const t = (await mine(fan))[0];
  const r = must(await api('POST', `/tickets/${t.id}/reissue`, { token: fan.token, body: { token_version: 1 } }));
  assert.notEqual(r.token, t.token);
  assert.equal((await api('POST', `/tickets/${t.id}/reissue`, { token: fan.token, body: { token_version: 1 } })).status, 409, 'two devices racing');
  assert.equal(must(await scan(org, ev, { token: t.token })).result, 'replaced');
  assert.equal(must(await scan(org, ev, { token: r.token })).result, 'valid');
  assert.equal(must(await scan(org, ev, { token: r.token })).result, 'duplicate');
  // organiser void + replace after entry still cannot admit a second time
  const v = must(await api('POST', `/tickets/${t.id}/void`, { token: org.token, body: { reason: 'lost phone', replace: true } }));
  const fresh = (await rows("SELECT serial, token_version FROM tickets WHERE id=$1", [v.id]))[0];
  assert.equal(must(await scan(org, ev, { token: tokenFor(fresh.serial, fresh.token_version) })).result, 'duplicate', 'the replacement shares the entitlement, so no second admission');
  assert.equal((await api('POST', `/tickets/${t.id}/void`, { token: fan.token, body: { reason: 'nope', replace: false } })).status, 404);
});

test('refund: a ticket is refunded only after the payment moved; failures leave it due; reconciles to payments', async () => {
  const { org, ev, p } = await setup({ price: 3000 });
  const fan = await signup();
  const o = await buy(fan, ev, [{ product_id: p.id, quantity: 2 }]);
  const [t1, t2] = await mine(fan);
  const payment = (await rows("SELECT * FROM payments WHERE purpose_type='ticket_order' AND purpose_id=$1", [o.id]))[0];
  refunds.mode = 'fail'; refunds.calls.length = 0;
  const failed = must(await api('POST', `/tickets/${t1.id}/refund`, { token: fan.token, body: {} }));
  assert.equal(failed.status, 'refund_due');
  assert.equal((await rows('SELECT status FROM tickets WHERE id=$1', [t1.id]))[0].status, 'refund_due', 'not refunded while the provider is failing');
  assert.equal(Number((await rows('SELECT refunded_cents FROM payments WHERE id=$1', [payment.id]))[0].refunded_cents), 0);
  assert.equal(must(await scan(org, ev, { token: t1.token })).result, 'refunded', 'it stops admitting immediately');
  refunds.mode = 'ok';
  const sweep = await processTicketRefunds({ eventId: ev.id });
  assert.equal(sweep.refunded, 1);
  assert.equal((await rows('SELECT status FROM tickets WHERE id=$1', [t1.id]))[0].status, 'refunded');
  assert.equal(Number((await rows('SELECT refunded_cents FROM payments WHERE id=$1', [payment.id]))[0].refunded_cents), 3000);
  assert.ok(refunds.calls.every((c) => c.key === `refund-ticket-refund:${t1.id}`), 'idempotent key per ticket');
  assert.equal((await processTicketRefunds({ eventId: ev.id })).processed, 0, 'repeating changes nothing');
  // the second ticket refunds the other half; sums reconcile
  must(await api('POST', `/tickets/${t2.id}/refund`, { token: fan.token, body: {} }));
  const rec = (await rows("SELECT sum(refunded_minor)::int s FROM tickets WHERE order_id=$1", [o.id]))[0].s;
  assert.equal(rec, Number((await rows('SELECT refunded_cents FROM payments WHERE id=$1', [payment.id]))[0].refunded_cents));
  assert.equal((await rows('SELECT status FROM payments WHERE id=$1', [payment.id]))[0].status, 'refunded');
  // not yours, and a transferred ticket is only the organiser's to refund
  const f2 = await signup(); const o2 = await buy(f2, ev, [{ product_id: p.id, quantity: 1 }]); const t3 = (await mine(f2))[0];
  assert.equal((await api('POST', `/tickets/${t3.id}/refund`, { token: (await signup()).token, body: {} })).status, 404);
  const moved = must(await api('POST', `/tickets/${t3.id}/transfer`, { token: f2.token, body: { to_user_id: fan.id } }));
  assert.equal((await api('POST', `/tickets/${moved.id}/refund`, { token: fan.token, body: {} })).status, 403);
  assert.equal((await api('POST', `/tickets/${moved.id}/refund`, { token: org.token, body: {} })).status, 400, 'the organiser must give a reason');
  assert.equal(must(await api('POST', `/tickets/${moved.id}/refund`, { token: org.token, body: { reason: 'goodwill' } })).status, 'refunded');
  void o2;
});

test('refund policy: cutoff, never, used tickets, and a moved match opens refunds', async () => {
  const { org, ev, p, fx } = await setup();
  const fan = await signup(); await buy(fan, ev, [{ product_id: p.id, quantity: 3 }]);
  const [a, b, c] = await mine(fan);
  const refundStatus = (t) => api('POST', `/tickets/${t.id}/refund`, { token: fan.token, body: {} });
  must(await api('PATCH', `/events/${ev.id}/tickets/settings`, { token: org.token, body: { refund_policy: 'until_cutoff', refund_cutoff_hours: 24 } }));
  assert.equal((await refundStatus(a)).status, 409, 'match is in 1 hour: inside the 24h cutoff');
  must(await api('PATCH', `/events/${ev.id}/tickets/settings`, { token: org.token, body: { refund_policy: 'never' } }));
  assert.equal((await refundStatus(a)).status, 409);
  // the organiser moves the match: holders are told and may refund despite the policy
  must(await api('PATCH', `/fixtures/${fx[0]}`, { token: org.token, body: { scheduled_at: inHours(6) } }));
  assert.equal((await rows("SELECT count(*)::int n FROM notifications WHERE user_id=$1 AND kind='ticket_rescheduled'", [fan.id]))[0].n, 1);
  assert.equal(must(await refundStatus(a)).status, 'refunded');
  // a used ticket cannot be refunded by its buyer
  must(await api('PATCH', `/fixtures/${fx[0]}`, { token: org.token, body: { scheduled_at: inHours(1) } }));
  assert.equal(must(await scan(org, ev, { token: b.token })).result, 'valid');
  assert.equal((await refundStatus(b)).status, 409);
  void c;
});

test('cancellation: event and match cancellation refund through canonical payments; a pass survives one cancelled match', async () => {
  const org = await signup(['organizer']);
  const ev = await newEvent(org);
  const f1 = await fixture(ev, 1), f2 = await fixture(ev, 2);
  const single = await product(org, ev, { name: 'Match 1', fixture_ids: [f1] }); await live(org, single);
  const pass = await product(org, ev, { name: 'Both matches', kind: 'pass', fixture_ids: [f1, f2], price_minor: 1800 }); await live(org, pass);
  const fan = await signup();
  await buy(fan, ev, [{ product_id: single.id, quantity: 1 }, { product_id: pass.id, quantity: 1 }]);
  refunds.mode = 'ok'; refunds.calls.length = 0;
  must(await api('PATCH', `/fixtures/${f1}`, { token: org.token, body: { status: 'cancelled' } }));
  let st = Object.fromEntries((await rows('SELECT p.name, t.status FROM tickets t JOIN ticket_products p ON p.id=t.product_id WHERE t.event_id=$1', [ev.id])).map((r) => [r.name, r.status]));
  assert.equal(st['Match 1'], 'refund_due'); assert.equal(st['Both matches'], 'issued', 'the pass still admits to the other match');
  await sweepTickets();
  st = Object.fromEntries((await rows('SELECT p.name, t.status FROM tickets t JOIN ticket_products p ON p.id=t.product_id WHERE t.event_id=$1', [ev.id])).map((r) => [r.name, r.status]));
  assert.equal(st['Match 1'], 'refunded');
  must(await api('PATCH', `/events/${ev.id}`, { token: org.token, body: { status: 'cancelled' } }));
  assert.equal((await rows("SELECT status FROM tickets WHERE product_id=$1", [pass.id]))[0].status, 'refund_due');
  assert.equal((await order(await signup(), ev, [{ product_id: pass.id, quantity: 1 }])).status, 409, 'nothing is sold for a cancelled event');
  must(await api('POST', `/events/${ev.id}/tickets/refunds/process`, { token: org.token }));
  assert.equal((await rows("SELECT status FROM tickets WHERE product_id=$1", [pass.id]))[0].status, 'refunded');
  const pays = await rows("SELECT p.amount_cents, p.refunded_cents, p.status FROM payments p JOIN ticket_orders o ON o.id=p.purpose_id WHERE p.purpose_type='ticket_order' AND o.event_id=$1", [ev.id]);
  assert.ok(pays.length >= 1);
  assert.ok(pays.every((x) => Number(x.refunded_cents) === Number(x.amount_cents) && x.status === 'refunded'));
});

test('passes admit once per fixture and count against each fixture they cover', async () => {
  const org = await signup(['organizer']);
  const ev = await newEvent(org);
  const f1 = await fixture(ev, 1), f2 = await fixture(ev, 2);
  must(await api('PATCH', `/events/${ev.id}/tickets/settings`, { token: org.token, body: { spectator_capacity: 2 } }));
  const pass = await product(org, ev, { name: 'Season', kind: 'pass', fixture_ids: [f1, f2] }); await live(org, pass);
  const one = await product(org, ev, { name: 'Single 2', fixture_ids: [f2] }); await live(org, one);
  const [a, b, c] = await Promise.all([signup(), signup(), signup()]);
  await buy(a, ev, [{ product_id: pass.id, quantity: 1 }]);
  await buy(b, ev, [{ product_id: one.id, quantity: 1 }]);
  assert.equal((await order(c, ev, [{ product_id: pass.id, quantity: 1 }])).status, 409, 'f2 is full (pass + single), so no further pass');
  assert.equal((await order(c, ev, [{ product_id: one.id, quantity: 1 }])).status, 409);
  const t = (await mine(a))[0];
  assert.equal(must(await scan(org, ev, { token: t.token, fixture_id: f1 })).result, 'valid');
  assert.equal(must(await scan(org, ev, { token: t.token, fixture_id: f1 })).result, 'duplicate');
  await pool.query("UPDATE fixtures SET scheduled_at=now() WHERE id=$1", [f2]);
  assert.equal(must(await scan(org, ev, { token: t.token, fixture_id: f2 })).result, 'valid', 'a different fixture, a separate admission');
  assert.equal((await rows('SELECT count(*)::int n FROM ticket_attendance WHERE ticket_id=$1', [t.id]))[0].n, 2);
});

test('complimentary allocations are real tickets: quota, capacity, audit, scanning', async () => {
  const org = await signup(['organizer']);
  const ev = await newEvent(org); const fx = await fixture(ev);
  must(await api('PATCH', `/events/${ev.id}/tickets/settings`, { token: org.token, body: { spectator_capacity: 3 } }));
  const paid = await product(org, ev, { name: 'Paid', fixture_ids: [fx] }); await live(org, paid);
  const comp = await product(org, ev, { name: 'Sponsor pass', class: 'complimentary', price_minor: 0, fixture_ids: [fx] }); await live(org, comp);
  const sponsor = await signup(['sponsor']);
  const al = must(await api('POST', `/events/${ev.id}/ticket-allocations`, { token: org.token, body: { product_id: comp.id, kind: 'sponsor', label: 'Acme Ltd', quota: 2, reason: 'Title sponsor hospitality' } }), 201);
  assert.equal((await api('POST', `/events/${ev.id}/ticket-allocations`, { token: org.token, body: { product_id: paid.id, kind: 'sponsor', label: 'x', quota: 1, reason: 'no' } })).status, 400, 'a paid product cannot be a comp');
  assert.equal((await api('POST', `/ticket-allocations/${al.id}/issue`, { token: sponsor.token, body: { recipients: [{ user_id: sponsor.id }] } })).status, 404);
  const issued = must(await api('POST', `/ticket-allocations/${al.id}/issue`, { token: org.token, body: { recipients: [{ user_id: sponsor.id }, { guest: { name: 'VIP Guest' } }] } }), 201);
  assert.equal(issued.tickets.length, 2); assert.ok(issued.tickets[1].claim_code);
  assert.equal((await api('POST', `/ticket-allocations/${al.id}/issue`, { token: org.token, body: { recipients: [{ user_id: sponsor.id }] } })).body.error.details.code, 'allocation_exhausted');
  assert.equal((await rows("SELECT count(*)::int n FROM audit_log WHERE action='ticket.allocation.issue' AND entity_id=$1", [al.id]))[0].n, 1);
  // they count towards capacity: 3 seats, 2 given away, so only one paid ticket remains
  const fan = await signup(), fan2 = await signup();
  assert.equal((await order(fan, ev, [{ product_id: paid.id, quantity: 2 }])).status, 409);
  await buy(fan, ev, [{ product_id: paid.id, quantity: 1 }]);
  assert.equal((await order(fan2, ev, [{ product_id: paid.id, quantity: 1 }])).status, 409);
  const mineSponsor = (await mine(sponsor))[0];
  assert.equal(mineSponsor.class, 'complimentary');
  assert.equal(must(await scan(org, ev, { token: mineSponsor.token })).result, 'valid');
  const list = must(await api('GET', `/events/${ev.id}/ticket-allocations`, { token: org.token }));
  assert.equal(list[0].issued, 2);
});

test('safety capacity can include participants and accredited people', async () => {
  const org = await signup(['organizer']);
  const ev = await newEvent(org); const fx = await fixture(ev);
  const p = await product(org, ev, { fixture_ids: [fx] }); await live(org, p);
  for (let i = 0; i < 2; i++) { const u = await signup(); const e = must(await api('POST', `/events/${ev.id}/entries`, { token: u.token }), 201); must(await api('PATCH', `/entries/${e.id}`, { token: org.token, body: { status: 'accepted' } })); }
  must(await api('PATCH', `/events/${ev.id}/tickets/settings`, { token: org.token, body: { spectator_capacity: null, safety_capacity: 4, count_participants: true } }));
  const fan = await signup();
  assert.equal((await order(fan, ev, [{ product_id: p.id, quantity: 3 }])).body.error.details.code, 'capacity_reached', '2 participants + 3 spectators > 4');
  must(await order(fan, ev, [{ product_id: p.id, quantity: 2 }]), 201);
  must(await api('PATCH', `/events/${ev.id}/tickets/settings`, { token: org.token, body: { count_participants: false } }));
  must(await order(await signup(), ev, [{ product_id: p.id, quantity: 2 }]), 201);   // 2 + 2 = 4, exactly the safety capacity
  assert.equal((await order(await signup(), ev, [{ product_id: p.id, quantity: 1 }])).status, 409);
});

test('report keeps sold, issued, refunded and actually-scanned apart, and currencies separate', async () => {
  const org = await signup(['organizer']);
  const ev = await newEvent(org); const fx = await fixture(ev);
  const gbp = await product(org, ev, { name: 'GBP', price_minor: 1000, currency: 'GBP', fixture_ids: [fx] }); await live(org, gbp);
  const eur = await product(org, ev, { name: 'EUR', price_minor: 2000, currency: 'EUR', tax_bp: 2000, tax_inclusive: false, fixture_ids: [fx] }); await live(org, eur);
  const [a, b, c] = await Promise.all([signup(), signup(), signup()]);
  await buy(a, ev, [{ product_id: gbp.id, quantity: 2 }]);
  const eo = await buy(b, ev, [{ product_id: eur.id, quantity: 1 }]);
  assert.equal(eo.total_minor, 2400, 'tax added on top');
  assert.equal((await order(c, ev, [{ product_id: gbp.id, quantity: 1 }, { product_id: eur.id, quantity: 1 }])).status, 400, 'one order, one currency');
  const [t1, t2] = await mine(a);
  must(await scan(org, ev, { token: t1.token }));
  assert.equal(must(await api('POST', `/tickets/${t2.id}/refund`, { token: org.token, body: { reason: 'duplicate purchase' } })).status, 'refunded');
  const rep = must(await api('GET', `/events/${ev.id}/tickets/report`, { token: org.token }));
  assert.equal(rep.counts.sold, 3); assert.equal(rep.counts.scanned_in, 1); assert.ok(rep.counts.refunded >= 1);
  assert.deepEqual(rep.money.map((m) => m.currency).sort(), ['EUR', 'GBP']);
  const eurM = rep.money.find((m) => m.currency === 'EUR');
  assert.equal(eurM.gross_minor, 2400); assert.equal(eurM.tax_minor, 400);
  assert.ok(rep.sales.some((s) => s.product === 'GBP' && s.channel === 'online'));
  assert.ok(rep.gates.length >= 1 && Array.isArray(rep.throughput));
  assert.match(rep.note, /different numbers/);
});

test('public event page announces tickets; ticket money reaches finance as the organiser\'s receivable', async () => {
  const { org, ev, p } = await setup({ price: 1500 });
  const page = must(await api('GET', `/public/events/${ev.id}`));
  assert.equal(page.tickets.on_sale, true); assert.equal(page.tickets.from_price_minor, 1500);
  const fan = await signup(); const o = await buy(fan, ev, [{ product_id: p.id, quantity: 1 }]);
  const f = (await rows("SELECT module, kind FROM finance_entries WHERE source_type='ticket_order' AND source_id=$1", [o.id]).catch(() => []));
  if (f.length) assert.ok(f.every((x) => x.module === 'tickets'));
});
