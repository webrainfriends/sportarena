// Procurement lifecycle depth (#591): demand for a competition, credential gates on bid and award, the filtered scorecard, and delivery disputes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `svc_${n}_${roles[0]}`, display_name: `Svc ${n}`, email: `svc${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); return { ...r.body.user, token: r.body.token }; };
const iso = (offsetDays, hour = 9) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offsetDays); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };
const ymd = (offsetDays) => iso(offsetDays).slice(0, 10);
const j = (x) => JSON.stringify(x);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const requirement = (b, token, over = {}) => api('POST', `/service-buyers/${b.id}/requirements`, { token, body: { category: 'ground_maintenance', title: 'Prepare main pitch', scope: { surface: 'natural_grass', area_sqm: 7000, tasks: ['mowing', 'line_marking'] }, quantity: 3, unit: 'visit', starts_at: iso(10), ends_at: iso(12), budget_minor: 900000, currency: b.currency, ...over } });
const world = async () => {
  const owner = await signup(['supplier']);
  const p = must(await api('POST', '/supplier-profiles', { token: owner.token, body: { supplier_type: 'sole_trader', legal_name: `Turf Co ${n}`, categories: ['ground_maintenance'], currencies: ['INR'], daily_capacity: 4 } }), 201);
  const u = await signup(['organizer']);
  const ev = must(await api('POST', '/events', { token: u.token, body: { name: `Cup ${n}`, sport: 'football', starts_on: ymd(10), ends_on: ymd(12) } }), 201);
  const comp = must(await api('POST', '/events', { token: u.token, body: { name: `League ${n}`, sport: 'football', starts_on: ymd(10), ends_on: ymd(40) } }), 201);
  const buyer = must(await api('POST', '/service-buyers', { token: u.token, body: { event_id: ev.id, currency: ev.currency ?? 'INR' } }), 201);
  return { s: { owner, p }, u, ev, comp, buyer };
};
const issue = async (w, req) => {
  const rfq = must(await api('POST', `/service-requirements/${req.id}/rfq`, { token: w.u.token, body: { rubric: [{ key: 'price', label: 'Price', weight: 60 }, { key: 'quality', label: 'Quality', weight: 40 }] } }), 201);
  must(await api('POST', `/rfqs/${rfq.id}/invites`, { token: w.u.token, body: { profile_ids: [w.s.p.id] } }), 201);
  must(await api('POST', `/rfqs/${rfq.id}/issue`, { token: w.u.token }));
  const inv = must(await api('GET', '/me/rfq-invitations', { token: w.s.owner.token, query: { profile_id: w.s.p.id } })).find((x) => x.rfq_id === rfq.id);
  must(await api('POST', `/rfq-invites/${inv.id}/respond`, { token: w.s.owner.token, body: { action: 'accept' } }));
  return { rfq, inv };
};
const quote = (w, inv) => api('POST', `/rfq-invites/${inv.id}/quote`, { token: w.s.owner.token, body: { currency: 'INR', valid_until: iso(5), lines: [{ line_type: 'service', description: 'Pitch preparation visit', quantity: 3, unit: 'visit', rate_minor: 100000 }] } });
const award = async (w, rfq, q) => {
  const fresh = must(await api('GET', `/rfqs/${rfq.id}`, { token: w.u.token }));
  return api('POST', `/rfqs/${rfq.id}/award`, { token: w.u.token, body: { row_version: fresh.row_version, awards: [{ quote_id: q.id }], justification: 'Only compliant bid' } });
};

test('demand names a competition and the credentials a supplier must hold; both are enforced at bid and again at award', async () => {
  const w = await world();
  assert.equal((await requirement(w.buyer, w.u.token, { competition_id: '00000000-0000-4000-8000-000000000000' })).status, 404, 'an unknown competition is refused');
  assert.equal((await requirement(w.buyer, w.u.token, { compliance_kinds: ['not_a_kind'] })).status, 400);
  const req = must(await requirement(w.buyer, w.u.token, { competition_id: w.comp.id, compliance_kinds: ['insurance'] }), 201);
  assert.equal(req.competition_id, w.comp.id); assert.deepEqual(req.compliance_kinds, ['insurance']);
  assert.equal(must(await api('GET', `/service-buyers/${w.buyer.id}/requirements`, { token: w.u.token, query: { competition_id: w.comp.id } })).length, 1);
  assert.equal(must(await api('GET', `/service-buyers/${w.buyer.id}/requirements`, { token: w.u.token, query: { competition_id: w.ev.id } })).length, 0);

  const { rfq, inv } = await issue(w, req);
  assert.deepEqual(must(await api('GET', `/rfqs/${rfq.id}`, { token: w.u.token })).scope.compliance_kinds, ['insurance'], 'the requirement is frozen into the RFQ scope');
  // at bid: no current insurance credential → refused, and nothing is stored
  assert.equal((await quote(w, inv)).status, 409);
  const cred = must(await api('POST', `/supplier-profiles/${w.s.p.id}/credentials`, { token: w.s.owner.token, body: { kind: 'insurance', title: 'Public liability', valid_to: ymd(200) } }), 201);
  const q = must(await quote(w, inv), 201);
  assert.deepEqual(must(await api('GET', `/rfqs/${rfq.id}/comparison`, { token: w.u.token })).quotes[0].compliance_gaps, []);
  // at award: the credential lapsed after the bid → the award is blocked and the comparison says why
  await pool.query("UPDATE svc_credentials SET valid_to = current_date - 1 WHERE id=$1", [cred.id]);
  assert.equal((await award(w, rfq, q)).status, 409);
  assert.deepEqual(must(await api('GET', `/rfqs/${rfq.id}/comparison`, { token: w.u.token })).quotes[0].compliance_gaps, ['insurance']);
  await pool.query("UPDATE svc_credentials SET valid_to = current_date + 100 WHERE id=$1", [cred.id]);
  const aw = must(await award(w, rfq, q), 201);
  assert.equal(aw.status, 'awarded');
});

test('scorecard: new dimensions, event / venue / competition / category / period filters, searchable options and strict scope', async () => {
  const w = await world();
  const req = must(await requirement(w.buyer, w.u.token, { competition_id: w.comp.id }), 201);
  const { rfq, inv } = await issue(w, req);
  const q = must(await quote(w, inv), 201);
  const aw = must(await award(w, rfq, q), 201);
  const order = must(await api('POST', `/service-orders/${aw.orders[0].id}/respond`, { token: w.s.owner.token, body: { action: 'confirm' } }));
  const get = (token, query = {}) => api('GET', `/supplier-profiles/${w.s.p.id}/performance`, { token, query });
  const dims = (b) => Object.fromEntries(b.dimensions.map((d) => [d.key, d]));

  const all = must(await get(w.s.owner.token));
  for (const k of ['safety_compliance', 'commercial', 'event_feedback', 'on_time_delivery', 'buyer_rating']) assert.ok(dims(all)[k], k);
  assert.equal(all.orders.total, 1);
  assert.equal(dims(all).safety_compliance.n, 0, 'no required credentials yet is “no evidence”, not a perfect score');
  assert.equal(dims(all).event_feedback.value, null);

  // filters narrow; an unrelated event, venue, category or period removes the order
  assert.equal(must(await get(w.s.owner.token, { event_ids: w.ev.id })).orders.total, 1, 'the buyer context’s event');
  assert.equal(must(await get(w.s.owner.token, { competition_ids: w.comp.id })).orders.total, 1, 'the competition the demand was raised for');
  assert.equal(must(await get(w.s.owner.token, { event_ids: `${w.comp.id}` })).orders.total, 0);
  assert.equal(must(await get(w.s.owner.token, { categories: 'ground_maintenance' })).orders.total, 1);
  assert.equal(must(await get(w.s.owner.token, { categories: 'pool_maintenance' })).orders.total, 0);
  assert.equal(must(await get(w.s.owner.token, { from: new Date(Date.now() + 864e5).toISOString() })).orders.total, 0);
  assert.equal((await get(w.s.owner.token, { event_ids: 'nope' })).status, 400);

  // a variation moves the commercial dimension; currencies are never mixed
  await pool.query("INSERT INTO svc_variations(order_id, version, kind, reason, delta_net_minor, proposed_by, proposed_side, counterparty_status, status) VALUES ($1,1,'cost','extra turf',30000,$2,'buyer','accepted','applied')", [order.id, w.u.id]);
  await pool.query('UPDATE svc_orders SET net_minor = net_minor + 30000 WHERE id=$1', [order.id]);
  const drift = dims(must(await get(w.s.owner.token))).commercial;
  assert.equal(drift.n, 1); assert.equal(drift.value, 0.1, '30 000 on an awarded 300 000'); assert.equal(drift.reliable, false);

  // a rated order tied to an event feeds event feedback
  await pool.query("UPDATE svc_order_lines SET qty_accepted = qty_ordered WHERE order_id=$1", [order.id]);
  must(await api('POST', `/service-orders/${order.id}/rating`, { token: w.u.token, body: { stars: 4 } }), 201);
  assert.equal(dims(must(await get(w.s.owner.token))).event_feedback.value, 4);

  // searchable options come only from orders the caller may read
  const evs = must(await api('GET', `/supplier-profiles/${w.s.p.id}/performance/filters`, { token: w.s.owner.token, query: { kind: 'event', q: 'cup' } }));
  assert.deepEqual(evs.map((e) => e.id), [w.ev.id]);
  assert.deepEqual(must(await api('GET', `/supplier-profiles/${w.s.p.id}/performance/filters`, { token: w.s.owner.token, query: { kind: 'competition' } })).map((e) => e.id), [w.comp.id]);
  assert.deepEqual(must(await api('GET', `/supplier-profiles/${w.s.p.id}/performance/filters`, { token: w.s.owner.token, query: { kind: 'category' } })).map((e) => e.id), ['ground_maintenance']);
  assert.equal(must(await api('GET', `/supplier-profiles/${w.s.p.id}/performance/filters`, { token: w.s.owner.token, query: { kind: 'event', q: 'zzz' } })).length, 0);

  // the buyer sees its own orders only; an outsider and another buyer get nothing
  assert.equal(must(await get(w.u.token, { buyer_id: w.buyer.id })).orders.total, 1);
  const stranger = await signup(['organizer']);
  assert.ok([403, 404].includes((await get(stranger.token)).status));
  const other = await world();
  const otherSeen = await api('GET', `/supplier-profiles/${w.s.p.id}/performance`, { token: other.u.token, query: { buyer_id: other.buyer.id } });
  assert.equal(otherSeen.status, 404, 'another buyer cannot read this supplier’s record');
  assert.ok([403, 404].includes((await api('GET', `/supplier-profiles/${w.s.p.id}/performance/filters`, { token: stranger.token, query: { kind: 'event' } })).status));
});

test('delivery dispute: either side of the order can open one through the case desk; outsiders get 404 and nothing is stored', async () => {
  const w = await world();
  const req = must(await requirement(w.buyer, w.u.token), 201);
  const { rfq, inv } = await issue(w, req);
  const q = must(await quote(w, inv), 201);
  const aw = must(await award(w, rfq, q), 201);
  const order = aw.orders[0];
  const open = (token, links) => api('POST', '/cases', { token, body: { kind: 'dispute', category: 'service_delivery', subject: 'Pitch not ready', description: 'The pitch was not ready for the match', links } });
  const byBuyer = must(await open(w.u.token, [{ type: 'service_order', id: order.id }]), 201);
  assert.ok(byBuyer.case_no);
  must(await open(w.s.owner.token, [{ type: 'service_order', id: order.id }]), 201);
  const stranger = await signup(['organizer']);
  assert.equal((await open(stranger.token, [{ type: 'service_order', id: order.id }])).status, 404);
  assert.equal((await open(w.u.token, [])).status, 400, 'a delivery dispute must link its order');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM case_links WHERE entity_type='service_order' AND entity_id=$1", [order.id])).rows[0].n, 2);
});
