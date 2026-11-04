// Professional ticketing & fan entry (#587): bundles and hospitality packages, box office tills and tenders, scanner sessions and reconciliation, analytics, fans, seating hook.
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


const bundleOf = (org, ev, body) => api('POST', `/events/${ev.id}/ticket-bundles`, { token: org.token, body: { name: `Pack ${++n}`, currency: 'GBP', status: 'active', ...body } });
const tillOf = (u, ev, body = {}) => api('POST', `/events/${ev.id}/box-office/tills`, { token: u.token, body: { currency: 'GBP', opening_float_minor: 5000, ...body } });
const sell = (u, ev, body) => api('POST', `/events/${ev.id}/box-office/sales`, { token: u.token, body });

test('bundles: one price for tickets + parking, saving carried on the ticket so a refund is exact; price rules; stock cannot be oversold concurrently', async () => {
  const { org, ev, p } = await setup({ price: 2000 });
  const a = await addon(org, ev, { price_minor: 600 });
  assert.equal((await bundleOf(org, ev, { price_minor: 2700, items: [{ product_id: p.id }, { addon_id: a.id }] })).body.error.details.code, 'bundle_price_above_parts');
  assert.equal((await bundleOf(org, ev, { price_minor: 500, items: [{ product_id: p.id }, { addon_id: a.id }] })).body.error.details.code, 'bundle_price_below_addons');
  assert.equal((await bundleOf(org, ev, { price_minor: 100, items: [{ addon_id: a.id }] })).status, 400);
  const b = must(await bundleOf(org, ev, { price_minor: 2300, kind: 'hospitality', perks: ['Lounge', 'Catering'], stock: 3, per_order_limit: 3, items: [{ product_id: p.id }, { addon_id: a.id }] }), 201);
  assert.equal(b.list_minor, 2600); assert.equal(b.saving_minor, 300); assert.equal(b.left, 3);
  const buyer = await signup();
  const pub = must(await api('GET', `/public/events/${ev.id}/tickets/bundles`));
  assert.equal(pub.items[0].saving_minor, 300); assert.equal(pub.items[0].perks.length, 2);
  const q = must(await api('POST', `/events/${ev.id}/ticket-orders/quote`, { token: buyer.token, body: { bundles: [{ bundle_id: b.id, quantity: 1 }] } }));
  assert.equal(q.total_minor, 2300);
  const o = await buy(buyer, ev, [], { bundles: [{ bundle_id: b.id, quantity: 1 }] });
  assert.equal(o.status, 'confirmed'); assert.equal(o.total_minor, 2300); assert.equal(o.discount_minor, 300);
  assert.equal(o.tickets.length, 1); assert.equal(o.addons.length, 1); assert.equal(o.bundles[0].saving_minor, 300);
  assert.equal(await pool.query('SELECT bundle_order_id FROM tickets WHERE id=$1', [o.tickets[0].id]).then((r) => !!r.rows[0].bundle_order_id), true);
  // a refund returns what the ticket cost: 2000 less its 300 share of the saving
  const rf = must(await api('POST', `/tickets/${o.tickets[0].id}/refund`, { token: buyer.token, body: {} }));
  assert.equal(rf.amount_minor, 1700);
  // a promo code cannot be stacked on a bundle-only order
  const pr = must(await promo(org, ev, { code: 'TEN', kind: 'percent', value: 10 }), 201);
  assert.equal((await order(buyer, ev, [], { bundles: [{ bundle_id: b.id, quantity: 1 }], promo_codes: ['TEN'] })).status, 400); void pr;
  // stock: 3 total, one is gone; five buyers race for the remaining ones
  const racers = await Promise.all(Array.from({ length: 5 }, () => signup()));
  const res = await Promise.all(racers.map((u) => order(u, ev, [], { bundles: [{ bundle_id: b.id, quantity: 1 }] })));
  assert.equal(res.filter((r) => r.status === 201).length, 2, JSON.stringify(res.map((r) => r.status)));
  assert.equal(res.filter((r) => r.status === 409).length, 3);
  assert.equal((await rows('SELECT count(*)::int AS n FROM tickets WHERE event_id=$1 AND status IN (\'reserved\',\'issued\')', [ev.id]))[0].n, 2);
});

test('bundles: capacity still binds - a bundle cannot push the event past its spectator capacity', async () => {
  const { org, ev, p } = await setup({ price: 1000, capacity: 2 });
  const b = must(await bundleOf(org, ev, { price_minor: 1800, per_order_limit: 5, items: [{ product_id: p.id, qty: 2 }] }), 201);
  const u = await signup();
  assert.equal((await order(u, ev, [], { bundles: [{ bundle_id: b.id, quantity: 2 }] })).status, 409);
  must(await order(u, ev, [], { bundles: [{ bundle_id: b.id, quantity: 1 }] }), 201);
  assert.equal((await order(await signup(), ev, [{ product_id: p.id, quantity: 1 }])).status, 409);
});

test('box office: till, mixed tenders with change, ledger receipts, refund at the desk, cash-up with variance; nothing is kept on failure', async () => {
  const { org, ev, p } = await setup({ price: 2000, capacity: 3 });
  must(await api('PATCH', `/ticket-products/${p.id}`, { token: org.token, body: { channels: ['online', 'box_office'] } }));
  assert.equal((await sell(org, ev, { lines: [{ product_id: p.id, quantity: 1 }], tenders: [{ method: 'cash', amount_minor: 2000 }] })).body.error.details.code, 'till_closed');
  const till = must(await tillOf(org, ev), 201);
  assert.equal((await tillOf(org, ev)).status, 409);
  const lines = [{ product_id: p.id, quantity: 2 }];
  assert.equal((await sell(org, ev, { lines, tenders: [{ method: 'cash', amount_minor: 3000 }] })).body.error.details.code, 'tender_mismatch');
  assert.equal((await sell(org, ev, { lines, tenders: [{ method: 'card_terminal', amount_minor: 4000 }] })).body.error.details.code, 'reference_required');
  assert.equal((await rows('SELECT count(*)::int AS n FROM ticket_tenders'))[0].n, 0);
  // capacity binds at the desk and a failed sale leaves nothing behind
  const over = await sell(org, ev, { lines: [{ product_id: p.id, quantity: 4 }], tenders: [{ method: 'cash', amount_minor: 8000 }] });
  assert.equal(over.status, 409);
  assert.equal((await rows('SELECT count(*)::int AS n FROM tickets WHERE event_id=$1 AND status <> \'void\'', [ev.id]))[0].n, 0);
  const s1 = must(await sell(org, ev, { idempotency_key: 'desk-sale-0001', lines, buyer: { name: 'Walk Up', email: 'walkup@example.com', marketing_opt_in: true }, tenders: [{ method: 'cash', amount_minor: 2500, tendered_minor: 3000 }, { method: 'card_terminal', amount_minor: 1500, reference: 'SLIP-77' }] }), 201);
  assert.equal(s1.total_minor, 4000); assert.equal(s1.change_minor, 500); assert.equal(s1.tickets.length, 2);
  assert.ok(s1.tickets.every((t) => t.token.startsWith('GT1.') && t.claim_code));
  const replay = must(await sell(org, ev, { idempotency_key: 'desk-sale-0001', lines, tenders: [{ method: 'cash', amount_minor: 4000 }] }), 201);
  assert.equal(replay.replayed, true);
  assert.equal((await rows('SELECT count(*)::int AS n FROM ticket_tenders'))[0].n, 2);
  const led = await rows("SELECT kind, gross_minor::int AS gross, provider, event_id FROM fin_transactions WHERE source_type='ticket_order' AND source_id=$1 ORDER BY gross_minor", [s1.order_id]);
  assert.deepEqual(led.map((r) => [r.kind, r.gross, r.provider]), [['payment', 1500, 'card_terminal'], ['payment', 2500, 'cash']]);
  assert.equal(led[0].event_id, ev.id);
  assert.equal((await rows('SELECT count(*)::int AS n FROM tickets WHERE order_id=$1 AND status=\'issued\' AND marketing_opt_in', [s1.order_id]))[0].n, 2);
  // refund one ticket in cash at the desk: 2000 back, the ticket stops admitting and the place is free again
  const rf = must(await api('POST', `/events/${ev.id}/box-office/refunds`, { token: org.token, body: { code: s1.tickets[0].serial, method: 'cash', reason: 'Changed their mind' } }));
  assert.equal(rf.refunded_minor, 2000); assert.equal(rf.status, 'refunded');
  assert.equal((await api('POST', `/events/${ev.id}/box-office/refunds`, { token: org.token, body: { code: s1.tickets[0].serial, reason: 'again please' } })).status, 409);
  const my = must(await api('GET', `/events/${ev.id}/box-office/tills/mine`, { token: org.token })).till;
  assert.equal(my.totals.cash_expected_minor, 5000 + 2500 - 2000);
  // cash-up: a variance needs a note
  const miss = await api('POST', `/ticket-tills/${till.id}/close`, { token: org.token, body: { counted_cash_minor: 5400 } });
  assert.equal(miss.body.error.details.code, 'variance_note');
  const closed = must(await api('POST', `/ticket-tills/${till.id}/close`, { token: org.token, body: { counted_cash_minor: 5400, note: 'Counted twice, 1 pound coin jar' } }));
  assert.equal(closed.status, 'closed'); assert.equal(closed.variance_minor, -100);
  assert.equal((await api('POST', `/ticket-tills/${till.id}/close`, { token: org.token, body: { counted_cash_minor: 5400, note: 'again' } })).status, 409);
  const all = must(await api('GET', `/events/${ev.id}/box-office/tills`, { token: org.token }));
  assert.equal(all.items[0].variance_minor, -100);
  // a stranger sees nothing
  const stranger = await signup();
  assert.equal((await tillOf(stranger, ev)).status, 404);
  assert.equal((await api('GET', `/events/${ev.id}/box-office/tills`, { token: stranger.token })).status, 404);
});

test('scanner sessions: offline replay is tagged, delta manifest lists revocations, a duplicate on a second device is flagged, a gap blocks sign-off', async () => {
  const { org, ev, p, fx } = await setup({ price: 0 });
  await pool.query("UPDATE fixtures SET scheduled_at = now() + interval '1 hour' WHERE id=$1", [fx]);
  const holder = await signup();
  const o = await buy(holder, ev, [{ product_id: p.id, quantity: 2 }]);
  const tk = o.tickets;
  const full = await api('GET', `/tickets/${tk[0].id}`, { token: holder.token });
  const tokenOf = async (t) => must(await api('GET', `/tickets/${t.id}`, { token: holder.token })).token;
  void full;
  const dev1 = must(await api('POST', `/events/${ev.id}/tickets/scan-sessions`, { token: org.token, body: { device_label: 'North gate A', fixture_id: fx } }), 201);
  const dev2 = must(await api('POST', `/events/${ev.id}/tickets/scan-sessions`, { token: org.token, body: { device_label: 'North gate B', fixture_id: fx } }), 201);
  const m1 = must(await api('GET', `/events/${ev.id}/tickets/gate-manifest`, { token: org.token, query: { session_id: dev1.id } }));
  assert.equal(m1.total, 2);
  await new Promise((r) => setTimeout(r, 20));
  const since = new Date().toISOString();
  must(await api('POST', `/tickets/${tk[1].id}/void`, { token: org.token, body: { reason: 'Fraud check' } }));
  const delta = must(await api('GET', `/events/${ev.id}/tickets/gate-manifest`, { token: org.token, query: { since } }));
  assert.equal(delta.total, 0); assert.equal(delta.revoked.length, 1);
  assert.equal((await rows('SELECT manifest_count FROM ticket_scan_sessions WHERE id=$1', [dev1.id]))[0].manifest_count, 2);
  const tok = await tokenOf(tk[0]);
  const at = new Date(Date.now() - 60000).toISOString();
  const a = must(await api('POST', `/events/${ev.id}/tickets/scan-batch`, { token: org.token, body: { scans: [{ token: tok, fixture_id: fx, session_id: dev1.id, client_ref: 'dev1-scan-0001', scanned_at: at }] } }));
  assert.equal(a.admitted, 1);
  const b = must(await api('POST', `/events/${ev.id}/tickets/scan-batch`, { token: org.token, body: { scans: [{ token: tok, fixture_id: fx, session_id: dev2.id, client_ref: 'dev2-scan-0001', scanned_at: at }] } }));
  assert.equal(b.duplicates, 1);
  assert.equal((await api('POST', `/events/${ev.id}/tickets/scan`, { token: org.token, body: { token: tok, fixture_id: fx, session_id: dev1.id.replace(/^./, '0') } })).status, 400);
  must(await api('POST', `/ticket-scan-sessions/${dev1.id}/close`, { token: org.token, body: { reported_scans: 3, reported_admitted: 2 } }));
  let rec = must(await api('GET', `/events/${ev.id}/tickets/reconciliation`, { token: org.token }));
  assert.equal(rec.totals.missing_scans, 2); assert.equal(rec.totals.open_sessions, 1); assert.equal(rec.ready_to_sign, false);
  assert.equal(rec.conflicts.length, 1); assert.equal(rec.conflicts[0].devices, 2);
  assert.equal((await api('POST', `/events/${ev.id}/tickets/reconciliation`, { token: org.token, body: {} })).body.error.details.code, 'not_ready');
  must(await api('POST', `/ticket-scan-sessions/${dev2.id}/close`, { token: org.token, body: { reported_scans: 1 } }));
  must(await api('POST', `/events/${ev.id}/tickets/reconciliation`, { token: org.token, body: { accept_gaps: true, note: 'Device A lost, two scans lost' } }), 201);
  rec = must(await api('GET', `/events/${ev.id}/tickets/reconciliation`, { token: org.token }));
  assert.equal(rec.signed.length, 1); assert.equal(rec.totals.attended, 1);
  // only the operator's own session is usable; a stranger cannot open one
  assert.equal((await api('POST', `/events/${ev.id}/tickets/scan-sessions`, { token: holder.token, body: { device_label: 'Mine' } })).status, 404);
});

test('analytics, fans and the seating hook: sell-through and velocity, fan segments without contact data, repeatable chart sync', async () => {
  const { org, ev, p, fx } = await setup({ price: 1000, capacity: 10, alloc: 8 });
  const fan = await signup();
  await buy(fan, ev, [{ product_id: p.id, quantity: 2 }]);
  const rep = must(await api('GET', `/events/${ev.id}/tickets/report`, { token: org.token }));
  assert.equal(rep.analytics.sell_through.fixtures[0].sold, 2);
  assert.equal(rep.analytics.sell_through.fixtures[0].pct, 20);
  assert.equal(rep.analytics.sell_through.products.find((x) => x.id === p.id).pct, 25);
  assert.equal(rep.analytics.velocity.reduce((s, v) => s + v.tickets, 0), 2);
  assert.equal(rep.analytics.online_conversion.confirmed, 1);
  void fx;
  const f = must(await api('GET', `/events/${ev.id}/tickets/fans`, { token: org.token }));
  assert.equal(f.items.length, 1); assert.equal(f.items[0].tickets, 2); assert.equal(f.segments.new, 1); assert.equal(f.segments.no_show, 0, 'not a no-show before the match is played');
  assert.equal(JSON.stringify(f).includes('@example.com'), false);
  assert.equal((await api('GET', `/events/${ev.id}/tickets/fans`, { token: fan.token })).status, 404);
  const chart = { provider: 'seatsio', sections: [{ external_ref: 'A', name: 'Stand A', rows_count: 4, seats_per_row: 10, price_point: 'premium' }, { external_ref: 'B', name: 'Stand B', rows_count: 2, seats_per_row: 5 }] };
  const s1 = must(await api('POST', `/events/${ev.id}/ticket-sections/sync`, { token: org.token, body: chart }));
  assert.equal(s1.created.length, 2);
  const s2 = must(await api('POST', `/events/${ev.id}/ticket-sections/sync`, { token: org.token, body: { ...chart, sections: [{ ...chart.sections[0], rows_count: 6 }] } }));
  assert.equal(s2.created.length, 0); assert.equal(s2.updated.length, 1); assert.equal(s2.not_in_payload.length, 1);
  assert.equal((await rows('SELECT rows_count FROM ticket_sections WHERE id=$1', [s1.created[0].id]))[0].rows_count, 6);
});
