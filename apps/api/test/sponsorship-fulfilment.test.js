import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { expandLine } = await import('../src/sponsor-schedule.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `fu_${n}_${roles[0]}`, display_name: `Fulfil ${n}`, email: `fu${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const world = async () => {
  const sponsor = await signup(['sponsor']), ath = await signup(['athlete']), b = must(await api('POST', '/sponsors', { token: sponsor.token, body: { name: `FBrand${n}` } }), 201);
  must(await api('POST', '/me/sponsorship-profile', { token: ath.token, body: { open_to_sponsors: true } }));
  return { sponsor, ath, b };
};
const period = { starts_on: '2030-01-01', ends_on: '2030-12-31' };
const deal = async (w, line) => {
  const d = must(await api('POST', '/sponsorships', { token: w.sponsor.token, body: { sponsor_id: w.b.id, target_type: 'athlete', target_id: w.ath.id, deliverables: 'Support', ...period, lines: [line] } }), 201);
  must(await api('PATCH', `/sponsorships/${d.id}`, { token: w.ath.token, body: { status: 'active', version: 1 } }));
  return d;
};
const goodsLine = { kind: 'goods', label: 'Kit', quantity: 10, unit: 'pcs', cadence: 'once', first_due_on: '2030-02-01', estimate_cents: 50000, currency: 'SGD' };
const svcLine = (service_type, quantity = 2) => ({ kind: 'service', service_type, label: `${service_type} support`, quantity, cadence: 'once', first_due_on: '2030-03-01', estimate_cents: 30000, currency: 'SGD' });
const due = async (w, d) => must(await api('GET', '/sponsorship-obligations', { token: w.ath.token, query: { sponsorship_id: d.id } })).obligations[0];
const view = async (token, d) => must(await api('GET', `/sponsorships/${d.id}`, { token }));
const send = (w, o, body) => api('POST', `/sponsorship-obligations/${o.id}/deliveries`, { token: w.sponsor.token, body });
const recv = (w, dl, body) => api('PATCH', `/sponsorship-deliveries/${dl.id}`, { token: w.ath.token, body: { status: 'received', ...body } });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('service lines: validated, split like goods, estimate stays out of cash', () => {
  const ok = expandLine(svcLine('coaching', 5), { starts_on: '2030-01-01', ends_on: '2030-12-31' });
  assert.equal(ok[0].kind, 'service'); assert.equal(ok[0].quantity, 5); assert.equal(ok[0].amount_cents, null);
  assert.throws(() => expandLine({ ...svcLine('coaching'), service_type: undefined }, period), /which service/);
  assert.throws(() => expandLine({ ...svcLine('coaching'), quantity: undefined }, period), /needs a quantity/);
  assert.throws(() => expandLine({ kind: 'goods', label: 'x', quantity: 1, service_type: 'venue', cadence: 'once', first_due_on: '2030-02-01' }, period), /only for service/);
  assert.throws(() => expandLine({ ...svcLine('medical'), amount_cents: 5 }, period), /only money lines/);
});

test('dispatch is not receipt; a return frees quantity, a replacement reconciles, over-return and double-replacement are refused', async () => {
  const w = await world(), d = await deal(w, goodsLine), o = await due(w, d);
  const d1 = must(await send(w, o, { quantity: 6, reference: 'AWB1', evidence_url: 'https://x.example/dispatch.jpg' }), 201);
  assert.equal(d1.dispatch_evidence_url, 'https://x.example/dispatch.jpg');
  assert.equal((await send(w, o, { quantity: 6, evidence_url: 'http://x.example/a' })).status, 400, 'https evidence only');
  let row = await due(w, d);
  assert.equal(row.received_quantity, 0, 'dispatched is not received'); assert.equal(row.in_transit_quantity, 6);
  assert.equal((await api('POST', `/sponsorship-deliveries/${d1.id}/returns`, { token: w.ath.token, body: { quantity: 1, reason: 'damaged' } })).status, 409, 'cannot return what was never received');
  must(await recv(w, d1, { evidence_url: 'https://x.example/receipt.jpg', expected_version: 1 }));
  assert.equal((await recv(w, d1, {})).status, 409, 'already decided');

  const ret = (body, token = w.ath.token) => api('POST', `/sponsorship-deliveries/${d1.id}/returns`, { token, body });
  assert.equal((await ret({ quantity: 1, reason: 'damaged' }, w.sponsor.token)).status, 403, 'the sponsor does not report its own return');
  assert.equal((await ret({ quantity: 7, reason: 'damaged' })).status, 409, 'cannot return more than received');
  const key = 'retry-key-0001';
  const r1 = must(await ret({ quantity: 2, reason: 'damaged', evidence_url: 'https://x.example/dmg.jpg', idempotency_key: key }), 201);
  const r1b = must(await ret({ quantity: 2, reason: 'damaged', idempotency_key: key }), 201);
  assert.equal(r1b.id, r1.id, 'a retry returns the same request');
  assert.equal((await ret({ quantity: 5, reason: 'other' })).status, 409, '2 pending + 5 > 6 received');
  row = await due(w, d);
  assert.equal(row.returned_quantity, 0, 'nothing changes until the sponsor accepts'); assert.equal(row.return_pending_quantity, 2);

  const decide = (r, body, token = w.sponsor.token) => api('PATCH', `/sponsorship-delivery-returns/${r.id}`, { token, body });
  assert.equal((await decide(r1, { status: 'accepted' }, w.ath.token)).status, 403, 'the recipient cannot accept its own return');
  assert.equal((await decide(r1, { status: 'disputed' })).status, 400, 'a dispute needs a reason');
  assert.equal((await decide(r1, { status: 'accepted', expected_version: 9 })).status, 409, 'stale version refused');
  must(await decide(r1, { status: 'accepted', expected_version: 1 }));
  assert.equal((await decide(r1, { status: 'accepted' })).status, 409, 'decided once');
  row = await due(w, d);
  assert.equal(row.returned_quantity, 2);

  // reconcile: committed 10 = net received (6-2=4) + in transit 0 + credited 0 + remaining 6
  assert.equal((await send(w, o, { quantity: 7 })).status, 409, 'only 6 remain');
  assert.equal((await send(w, o, { quantity: 3, replaces_return_id: r1.id })).status, 400, 'replacement is at most the returned quantity');
  const rep = must(await send(w, o, { quantity: 2, replaces_return_id: r1.id }), 201);
  assert.equal((await send(w, o, { quantity: 1, replaces_return_id: r1.id })).status, 409, 'a return is replaced once');
  assert.equal((await send(w, o, { quantity: 1, replaces_return_id: '00000000-0000-4000-8000-000000000000' })).status, 404);
  must(await recv(w, rep, {}));
  const rest = must(await send(w, o, { quantity: 4 }), 201);
  must(await recv(w, rest, {}));
  row = await due(w, d);
  assert.equal(row.received_quantity, 12); assert.equal(row.returned_quantity, 2);
  assert.equal(row.status, 'fulfilled', '12 received - 2 returned = 10 committed');

  // returning from a fulfilled due re-opens it until a replacement is accepted
  const r2 = must(await ret({ quantity: 1, reason: 'wrong_item', resolution: 'replace' }), 201);
  assert.equal((await due(w, d)).status, 'fulfilled', 'a request alone changes nothing');
  must(await decide(r2, { status: 'accepted' }));
  assert.equal((await due(w, d)).status, 'scheduled', 'an accepted return uncovers the commitment');
  const rep2 = must(await send(w, o, { quantity: 1, replaces_return_id: r2.id }), 201);
  must(await recv(w, rep2, {}));
  assert.equal((await due(w, d)).status, 'fulfilled');

  const v = await view(w.ath.token, d);
  assert.equal(v.obligations[0].returns.length, 2);
  assert.ok(v.history.map((h) => h.action).includes('goods_replacement_dispatched'));
  assert.equal(v.estimated_not_cash ?? undefined, undefined);
  const list = must(await api('GET', '/sponsorship-obligations', { token: w.ath.token, query: { sponsorship_id: d.id } }));
  assert.ok(!list.totals.some((t) => t.committed_cents > 0), 'goods value never appears as cash');
});

test('a credited return closes its quantity without counting as received; disputes and cancellations change nothing', async () => {
  const w = await world(), d = await deal(w, { ...goodsLine, quantity: 4 }), o = await due(w, d);
  const d1 = must(await send(w, o, { quantity: 4 }), 201);
  must(await recv(w, d1, {}));
  assert.equal((await due(w, d)).status, 'fulfilled');
  const r = must(await api('POST', `/sponsorship-deliveries/${d1.id}/returns`, { token: w.ath.token, body: { quantity: 1, reason: 'not_as_described' } }), 201);
  must(await api('PATCH', `/sponsorship-delivery-returns/${r.id}`, { token: w.sponsor.token, body: { status: 'disputed', note: 'Matches the spec' } }));
  assert.equal((await due(w, d)).returned_quantity, 0);
  const r2 = must(await api('POST', `/sponsorship-deliveries/${d1.id}/returns`, { token: w.ath.token, body: { quantity: 1, reason: 'damaged' } }), 201);
  must(await api('PATCH', `/sponsorship-delivery-returns/${r2.id}`, { token: w.ath.token, body: { status: 'cancelled' } }));
  const r3 = must(await api('POST', `/sponsorship-deliveries/${d1.id}/returns`, { token: w.ath.token, body: { quantity: 1, reason: 'damaged' } }), 201);
  must(await api('PATCH', `/sponsorship-delivery-returns/${r3.id}`, { token: w.sponsor.token, body: { status: 'accepted', resolution: 'credit' } }));
  const row = await due(w, d);
  assert.equal(row.returned_quantity, 1); assert.equal(row.credited_quantity, 1);
  assert.equal(row.status, 'fulfilled', 'net 3 + credited 1 settles the commitment');
  assert.equal((await send(w, o, { quantity: 1 })).status, 409, 'a credited unit is not re-dispatched');
  assert.equal((await send(w, o, { quantity: 1, replaces_return_id: r3.id })).status, 409, 'a credited return has no replacement');
  assert.ok(row.received_quantity === 4, 'received stays what was physically received');
});

test('concurrent returns and dispatches cannot over-return or over-dispatch', async () => {
  const w = await world(), d = await deal(w, { ...goodsLine, quantity: 5 }), o = await due(w, d);
  const d1 = must(await send(w, o, { quantity: 5 }), 201);
  must(await recv(w, d1, {}));
  const rs = await Promise.all([1, 2, 3, 4].map(() => api('POST', `/sponsorship-deliveries/${d1.id}/returns`, { token: w.ath.token, body: { quantity: 2, reason: 'damaged' } })));
  assert.equal(rs.filter((r) => r.status === 201).length, 2, '5 received: exactly two returns of 2 fit');
  const { rows } = await pool.query("SELECT coalesce(sum(quantity),0)::int AS s FROM sponsorship_delivery_returns WHERE delivery_id=$1", [d1.id]);
  assert.ok(rows[0].s <= 5);
});

test('tenant isolation: unrelated users cannot read or act on returns, deliveries or vouchers', async () => {
  const w = await world(), d = await deal(w, goodsLine), o = await due(w, d);
  const d1 = must(await send(w, o, { quantity: 2 }), 201);
  must(await recv(w, d1, {}));
  const r = must(await api('POST', `/sponsorship-deliveries/${d1.id}/returns`, { token: w.ath.token, body: { quantity: 1, reason: 'damaged' } }), 201);
  const other = await signup(['sponsor']), other2 = await signup(['athlete']);
  for (const t of [other.token, other2.token]) {
    assert.equal((await api('GET', `/sponsorships/${d.id}`, { token: t })).status, 403);
    assert.equal((await api('PATCH', `/sponsorship-delivery-returns/${r.id}`, { token: t, body: { status: 'accepted' } })).status, 403);
    assert.equal((await api('POST', `/sponsorship-deliveries/${d1.id}/returns`, { token: t, body: { quantity: 1, reason: 'damaged' } })).status, 403);
    assert.equal((await api('POST', `/sponsorship-obligations/${o.id}/deliveries`, { token: t, body: { quantity: 1 } })).status, 403);
  }
  assert.equal((await api('PATCH', `/sponsorship-delivery-returns/${r.id}`, { token: w.sponsor.token, body: { status: 'accepted' } })).status, 200);
  assert.deepEqual(must(await api('GET', '/sponsorship-obligations', { token: other.token })).obligations, []);
});

test('service vouchers: issue within the commitment, void frees a unit, redeem once, retry is idempotent, no double redemption under a race', async () => {
  const w = await world(), d = await deal(w, svcLine('coaching', 2)), o = await due(w, d);
  assert.equal(o.kind, 'service');
  const issue = (body, token = w.sponsor.token) => api('POST', `/sponsorship-obligations/${o.id}/vouchers`, { token, body });
  assert.equal((await issue({ count: 1 }, w.ath.token)).status, 403, 'the recipient cannot issue');
  assert.equal((await issue({ count: 3 })).status, 409, 'cannot issue more than funded');
  assert.equal((await issue({ count: 1, valid_until: '2000-01-01' })).status, 400);
  const [a, b] = must(await issue({ count: 2, valid_until: '2031-01-01' }), 201).vouchers;
  assert.equal((await issue({ count: 1 })).status, 409);
  const red = (v, body, token = w.ath.token) => api('POST', `/sponsorship-vouchers/${v.id}/redeem`, { token, body });
  assert.equal((await red(a, { idempotency_key: 'k-aaaaaaaa' }, w.sponsor.token)).status, 403, 'the sponsor cannot redeem its own voucher');
  assert.equal((await red(a, { idempotency_key: 'short' })).status, 400);
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => red(a, { idempotency_key: 'k-aaaaaaaa', reference: 'Session 1' })));
  assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.body)));
  assert.equal(results.filter((r) => !r.body.replayed).length, 1, 'exactly one real redemption, the rest are replays');
  assert.equal((await red(a, { idempotency_key: 'k-bbbbbbbb' })).status, 409, 'a different key cannot redeem it again');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sponsorship_voucher_redemptions WHERE voucher_id=$1', [a.id])).rows[0].n, 1);
  assert.equal((await api('PATCH', `/sponsorship-vouchers/${a.id}`, { token: w.sponsor.token, body: { reason: 'oops' } })).status, 409, 'a redeemed voucher cannot be voided');
  assert.equal((await due(w, d)).status, 'scheduled');
  must(await api('PATCH', `/sponsorship-vouchers/${b.id}`, { token: w.sponsor.token, body: { reason: 'wrong person', expected_version: 1 } }));
  assert.equal((await red(b, { idempotency_key: 'k-cccccccc' })).status, 409, 'a void voucher cannot be redeemed');
  const [c] = must(await issue({ count: 1 }), 201).vouchers; // the freed unit
  must(await red(c, { idempotency_key: 'k-dddddddd' }));
  assert.equal((await due(w, d)).status, 'fulfilled', 'all funded units redeemed');
  const sv = await view(w.sponsor.token, d), rv = await view(w.ath.token, d);
  assert.equal(sv.obligations[0].vouchers.find((x) => x.id === a.id).reference, null, 'the sponsor sees that it was used, not the detail');
  assert.equal(rv.obligations[0].vouchers.find((x) => x.id === a.id).reference, 'Session 1');
  assert.ok(sv.history.map((h) => h.action).includes('voucher_redeemed'));
});

test('expired vouchers cannot be redeemed and free their unit', async () => {
  const w = await world(), d = await deal(w, svcLine('travel', 1)), o = await due(w, d);
  const [v] = must(await api('POST', `/sponsorship-obligations/${o.id}/vouchers`, { token: w.sponsor.token, body: { count: 1, valid_until: '2031-01-01' } }), 201).vouchers;
  await pool.query("UPDATE sponsorship_vouchers SET valid_until = current_date - 1 WHERE id=$1", [v.id]);
  assert.equal((await api('POST', `/sponsorship-vouchers/${v.id}/redeem`, { token: w.ath.token, body: { idempotency_key: 'k-eeeeeeee' } })).status, 409);
  assert.equal((await view(w.ath.token, d)).obligations[0].vouchers[0].status, 'expired');
  must(await api('POST', `/sponsorship-obligations/${o.id}/vouchers`, { token: w.sponsor.token, body: { count: 1 } }), 201);
});

test('venue vouchers link one own confirmed booking, once; medical vouchers carry no detail and grant no clinical access', async () => {
  const w = await world();
  const dv = await deal(w, svcLine('venue', 2)), ov = await due(w, dv);
  const { rows: [venue] } = await pool.query("INSERT INTO venues(name, owner_id) VALUES ('Court', $1) RETURNING id", [w.sponsor.id]);
  const { rows: [res] } = await pool.query("INSERT INTO resources(venue_id, kind, name) VALUES ($1,'court','C1') RETURNING id", [venue.id]);
  const book = async (user) => (await pool.query("INSERT INTO bookings(resource_id, user_id, starts_at, ends_at) VALUES ($1,$2,'2030-04-01 10:00+00','2030-04-01 11:00+00') RETURNING id", [res.id, user])).rows[0].id;
  const mine = await book(w.ath.id), notMine = await book(w.sponsor.id);
  const vs = must(await api('POST', `/sponsorship-obligations/${ov.id}/vouchers`, { token: w.sponsor.token, body: { count: 2 } }), 201).vouchers;
  const red = (v, body) => api('POST', `/sponsorship-vouchers/${v.id}/redeem`, { token: w.ath.token, body });
  assert.equal((await red(vs[0], { idempotency_key: 'k-ffffffff', booking_id: notMine })).status, 400, "someone else's booking");
  must(await red(vs[0], { idempotency_key: 'k-ffffffff', booking_id: mine }));
  assert.equal((await red(vs[1], { idempotency_key: 'k-gggggggg', booking_id: mine })).status, 409, 'one booking funds one voucher');

  const grants = (await pool.query('SELECT count(*)::int AS n FROM medical_grants')).rows[0].n;
  const w2 = await world(), dm = await deal(w2, svcLine('medical', 1)), om = await due(w2, dm);
  const [mv] = must(await api('POST', `/sponsorship-obligations/${om.id}/vouchers`, { token: w2.sponsor.token, body: { count: 1 } }), 201).vouchers;
  const rm = (body) => api('POST', `/sponsorship-vouchers/${mv.id}/redeem`, { token: w2.ath.token, body });
  assert.equal((await rm({ idempotency_key: 'k-hhhhhhhh', reference: 'knee MRI' })).status, 400, 'no clinical detail is accepted');
  must(await rm({ idempotency_key: 'k-hhhhhhhh' }));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM medical_grants')).rows[0].n, grants, 'funding grants nobody access');
  assert.equal((await pool.query('SELECT reference, booking_id FROM sponsorship_voucher_redemptions WHERE voucher_id=$1', [mv.id])).rows[0].reference, null);
  assert.equal((await api('GET', `/athletes/${w2.ath.id}/medical`, { token: w2.sponsor.token })).status >= 400, true, 'the sponsor has no route to health data');
  const sponsorView = await view(w2.sponsor.token, dm);
  assert.equal(JSON.stringify(sponsorView).includes('knee'), false);
});

test('migration is additive: existing deliveries keep working with the new columns defaulted', async () => {
  const w = await world(), d = await deal(w, goodsLine), o = await due(w, d);
  const dl = must(await send(w, o, { quantity: 1 }), 201);
  assert.equal(dl.version, 1); assert.equal(dl.replaces_return_id, null); assert.equal(dl.receipt_evidence_url, null);
  const sum = must(await api('GET', '/sponsorship-summary', { token: w.sponsor.token }));
  assert.equal(sum.goods_outstanding, 1); assert.equal(sum.services_outstanding, 0);
});

test('a service line is described as a service (not an endorsement) in the agreement document', async () => {
  const { describeLine } = await import('../src/documents/render.js');
  const t = describeLine({ kind: 'service', service_type: 'medical', quantity: 3, estimate_cents: 9000, currency: 'SGD', cadence: 'once', first_due_on: '2030-03-01' });
  assert.match(t, /medical service, 3 vouchers/); assert.match(t, /not cash/); assert.doesNotMatch(t, /endorsement/);
});
