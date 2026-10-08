import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { config } = await import('../src/config.js');
const { fromLocal, addDays } = await import('../src/booking/time.js');
const { notificationCycle } = await import('../src/notify.js');

let server, base;
const api = async (method, path, { token, body, query } = {}) => {
  const qs = query ? `?${new URLSearchParams(query)}` : '';
  const r = await fetch(`${base}/api/v1${path}${qs}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
let n = 0;
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `vr_${n}_${roles[0]}`, display_name: `VR ${n}`, email: `vr${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};

const TZ = 'Asia/Kolkata';
const today = new Date().toISOString().slice(0, 10);
const dayPlus = (d) => addDays(today, d);
/** ISO instant for `hour:minute` venue-local on today + d. */
const at = (d, hour, min = 0, tz = TZ) => fromLocal(dayPlus(d), hour * 60 + min, tz).toISOString();
const weekdayOf = (d) => new Date(`${dayPlus(d)}T00:00:00Z`).getUTCDay();

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

/** A Pune venue: 06:00–22:00 daily, Court A (cap 1, 10/h), Court B (cap 1), Table hall (3 tables, 4 players each), evening rate. */
async function makeVenue(mgr, over = {}) {
  const v = must(await api('POST', '/venues', {
    token: mgr.token, status: 201,
    body: { name: `Arena ${Math.random().toString(36).slice(2, 7)}`, city: 'Pune', address: '1 MG Road', latitude: 18.5204, longitude: 73.8567, timezone: TZ, currency: 'INR', phone: '+91 20 5550 0000', amenities: ['parking', 'showers'], ...over },
  }), 201);
  must(await api('POST', `/venues/${v.id}/hours`, { token: mgr.token, body: { hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '06:00', closes: '22:00' })) } }));
  const mk = async (b) => must(await api('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: b }), 201);
  const a = await mk({ kind: 'court', name: 'Court A', sport: 'basketball', hourly_rate_cents: 100000, max_players: 10 });
  const b = await mk({ kind: 'court', name: 'Court B', sport: 'basketball', hourly_rate_cents: 80000, max_players: 10 });
  const t = await mk({ kind: 'table', name: 'TT hall', sport: 'table-tennis', capacity: 3, max_players: 4, hourly_rate_cents: 20000, slot_minutes: 30 });
  return { v, a, b, t };
}

test('venue profile: geo, map links, contacts (encrypted), staff, search by distance/sport', async () => {
  const mgr = await signup(['venue_manager']);
  const { v, a } = await makeVenue(mgr, { name: 'Deccan Hoops' });
  const far = must(await api('POST', '/venues', { token: mgr.token, body: { name: 'Mumbai Sports Club', city: 'Mumbai', latitude: 19.076, longitude: 72.8777, timezone: TZ } }), 201);
  await api('POST', `/venues/${far.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'Squash 1', sport: 'squash' } });

  // validation
  assert.equal((await api('POST', '/venues', { token: mgr.token, body: { name: 'Nowhere', latitude: 10 } })).status, 400, 'lat without lng');
  assert.equal((await api('POST', '/venues', { token: mgr.token, body: { name: 'Nowhere', timezone: 'Mars/Phobos' } })).status, 400);

  const got = must(await api('GET', `/venues/${v.id}`));
  assert.match(got.map_links.google, /query=18\.5204,73\.8567/);
  assert.match(got.map_links.directions, /destination=18\.5204,73\.8567/);
  assert.equal(got.resources.length, 3);
  assert.equal(got.hours.length, 7);
  assert.equal(got.resources.find((r) => r.name === 'TT hall').capacity, 3);

  // contacts: PII encrypted at rest, public vs team visibility, audited
  const c1 = must(await api('POST', `/venues/${v.id}/contacts`, { token: mgr.token, body: { role: 'manager', name: 'Asha Kulkarni', phone: '+91 98220 11111', email: 'asha@deccanhoops.example' } }), 201);
  must(await api('POST', `/venues/${v.id}/contacts`, { token: mgr.token, body: { role: 'reception', name: 'Front desk', phone: '+91 20 5550 0001', is_public: true } }), 201);
  const raw = JSON.stringify((await pool.query('SELECT * FROM venue_contacts WHERE venue_id=$1', [v.id])).rows);
  for (const s of ['Asha', '98220', 'deccanhoops', 'Front desk', '5550 0001']) assert.ok(!raw.includes(s), `${s} leaked`);
  const guest = await signup();
  assert.equal((await api('GET', `/venues/${v.id}/contacts`)).status, 401);
  const asGuest = must(await api('GET', `/venues/${v.id}/contacts`, { token: guest.token }));
  assert.deepEqual(asGuest.map((c) => c.name), ['Front desk'], 'customers only see public contacts');
  assert.equal(must(await api('GET', `/venues/${v.id}/contacts`, { token: mgr.token })).length, 2);
  assert.ok((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='read_pii' AND entity='venue_contacts'")).rows[0].n >= 2);
  assert.equal((await api('DELETE', `/venues/${v.id}/contacts/${c1.id}`, { token: guest.token })).status, 403);

  // staff
  const helper = await signup();
  assert.equal((await api('PATCH', `/venues/${v.id}`, { token: helper.token, body: { phone: '1' } })).status, 403);
  must(await api('POST', `/venues/${v.id}/staff`, { token: mgr.token, body: { handle: helper.handle } }), 201);
  assert.equal(must(await api('PATCH', `/venues/${v.id}`, { token: helper.token, body: { cancel_free_hours: 12, amenities: ['parking', 'wifi'] } })).cancel_free_hours, 12);
  assert.equal((await api('POST', `/venues/${v.id}/staff`, { token: helper.token, body: { handle: guest.handle } })).status, 403, 'staff cannot add staff');
  must(await api('PATCH', `/venues/${v.id}`, { token: mgr.token, body: { cancel_free_hours: 24 } }));

  // search: near Pune, sorted by distance, sport filter, amenity
  const near = must(await api('GET', '/venues', { query: { lat: 18.53, lng: 73.85, radius_km: 50, sport: 'basketball' } }));
  assert.ok(near.some((x) => x.id === v.id) && !near.some((x) => x.id === far.id));
  assert.ok(near.find((x) => x.id === v.id).distance_km < 5);
  const byDist = must(await api('GET', '/venues', { query: { lat: 18.5204, lng: 73.8567, sort: 'distance' } }));
  assert.ok(byDist.findIndex((x) => x.id === v.id) < byDist.findIndex((x) => x.id === far.id));
  assert.equal(must(await api('GET', '/venues', { query: { amenity: 'wifi', q: 'Deccan' } })).length, 1);
  assert.equal((await api('GET', '/venues', { query: { sort: 'distance' } })).status, 400);
  assert.ok(must(await api('GET', '/venues', { query: { sport: 'basketball', max_hourly_rate_cents: '50000' } })).every((x) => x.id !== v.id), 'price filter');
  void a;
});

test('slot grid honours opening hours, grid, notice window; closed days are empty', async () => {
  const mgr = await signup(['venue_manager']);
  const { v, a } = await makeVenue(mgr);
  const grid = must(await api('GET', `/venues/${v.id}/availability`, { query: { date: dayPlus(3), resource_id: a.id } }));
  const slots = grid.resources[0].slots;
  assert.equal(slots.length, 16, '06:00–22:00 hourly');
  assert.equal(slots[0].starts_at, at(3, 6));
  assert.ok(slots.every((s) => s.status === 'free' && s.price_cents === 100000));

  const user = await signup();
  const book = (items, extra = {}) => api('POST', '/reservations', { token: user.token, body: { items, ...extra } });
  assert.equal((await book([{ resource_id: a.id, starts_at: at(3, 5), ends_at: at(3, 6) }])).status, 400, 'before opening');
  assert.equal((await book([{ resource_id: a.id, starts_at: at(3, 21), ends_at: at(3, 23) }])).status, 400, 'past closing');
  assert.equal((await book([{ resource_id: a.id, starts_at: at(3, 10, 30), ends_at: at(3, 11, 30) }])).status, 400, 'off the slot grid');
  assert.equal((await book([{ resource_id: a.id, starts_at: at(-1, 10), ends_at: at(-1, 11) }])).status, 400, 'past');
  assert.equal((await book([{ resource_id: a.id, starts_at: at(3, 6), ends_at: at(3, 16) }])).status, 400, 'more than max_slots (8)');
  assert.equal((await book([{ resource_id: a.id, starts_at: at(200, 10), ends_at: at(200, 11) }])).status, 400, 'beyond the booking window');

  // closed on a weekday => no slots and no booking
  const wd = weekdayOf(3);
  must(await api('POST', `/venues/${v.id}/hours`, { token: mgr.token, body: { hours: [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== wd).map((weekday) => ({ weekday, opens: '06:00', closes: '22:00' })) } }));
  assert.equal(must(await api('GET', `/venues/${v.id}/availability`, { query: { date: dayPlus(3), resource_id: a.id } })).resources[0].slots.length, 0);
  assert.equal((await book([{ resource_id: a.id, starts_at: at(3, 10), ends_at: at(3, 11) }])).status, 400);
  assert.equal((await api('POST', `/venues/${v.id}/hours`, { token: mgr.token, body: { hours: [{ weekday: 1, opens: '10:00', closes: '12:00' }, { weekday: 1, opens: '11:00', closes: '14:00' }] } })).status, 400, 'overlapping intervals rejected');
});

test('pricing rules and discounts: slot-by-slot rates, best single discount, promo limits, quote = booking', async () => {
  const mgr = await signup(['venue_manager']);
  const { v, a, b } = await makeVenue(mgr);
  const user = await signup();
  const rule = must(await api('POST', `/venues/${v.id}/price-rules`, { token: mgr.token, body: { name: 'Evening peak', start: '18:00', end: '22:00', hourly_rate_cents: 150000 } }), 201);
  must(await api('POST', `/venues/${v.id}/price-rules`, { token: mgr.token, body: { name: 'Court B evening promo', resource_id: b.id, start: '18:00', end: '22:00', hourly_rate_cents: 120000, priority: 1 } }), 201);
  const card = must(await api('GET', `/venues/${v.id}/price-rules`));
  assert.equal(card.rules.length, 2);
  assert.equal(card.rules.find((r) => r.name === 'Evening peak').start, '18:00');

  const quote = (items, extra = {}) => api('POST', '/reservations/quote', { token: user.token, body: { items, ...extra } });
  // 17:00-19:00 straddles base and peak: 100000 + 150000
  let q = must(await quote([{ resource_id: a.id, starts_at: at(3, 17), ends_at: at(3, 19) }]));
  assert.equal(q.total_cents, 250000);
  assert.equal(q.ok, true);
  // area-specific rule beats the venue-wide one
  q = must(await quote([{ resource_id: b.id, starts_at: at(3, 19), ends_at: at(3, 20) }]));
  assert.equal(q.total_cents, 120000);

  // automatic multi-slot discount: 3+ slots = 10%
  const bulk = must(await api('POST', `/venues/${v.id}/discounts`, { token: mgr.token, body: { name: '3+ slots', kind: 'percent', value: 10, min_slots: 3 } }), 201);
  q = must(await quote([{ resource_id: a.id, starts_at: at(3, 8), ends_at: at(3, 10) }]));
  assert.equal(q.discount_cents, 0, '2 slots: no discount');
  q = must(await quote([{ resource_id: a.id, starts_at: at(3, 8), ends_at: at(3, 11) }]));
  assert.equal(q.subtotal_cents, 300000);
  assert.equal(q.discount_cents, 30000);
  assert.equal(q.total_cents, 270000);
  // slots add up across lines/areas for the discount
  q = must(await quote([{ resource_id: a.id, starts_at: at(3, 8), ends_at: at(3, 9) }, { resource_id: b.id, starts_at: at(3, 8), ends_at: at(3, 10) }]));
  assert.equal(q.discount_cents, Math.floor((100000 + 160000) * 0.1));
  assert.equal(q.lines.reduce((s, l) => s + l.price_cents, 0), q.total_cents, 'line prices add up to the total');
  assert.equal(q.lines.reduce((s, l) => s + l.discount_cents, 0), q.discount_cents);

  // promo code: best single discount wins (no stacking); per-user limit 1
  const promo = must(await api('POST', `/venues/${v.id}/discounts`, { token: mgr.token, body: { name: 'Welcome', code: 'welcome50', kind: 'fixed', value: 50000, per_user_limit: 1 } }), 201);
  q = must(await quote([{ resource_id: a.id, starts_at: at(3, 8), ends_at: at(3, 9) }], { promo_codes: ['WELCOME50'] }));
  assert.equal(q.discount_cents, 50000);
  q = must(await quote([{ resource_id: a.id, starts_at: at(3, 8), ends_at: at(3, 11) }], { promo_codes: ['welcome50'] }));
  assert.equal(q.discount_cents, 50000 > 30000 ? 50000 : 30000, 'the better of the two, not both');
  assert.equal((await quote([{ resource_id: a.id, starts_at: at(3, 8), ends_at: at(3, 9) }], { promo_codes: ['NOPE'] })).body.ok, false, 'unknown code is reported in the quote');
  assert.equal((await api('POST', '/reservations', { token: user.token, body: { items: [{ resource_id: a.id, starts_at: at(3, 8), ends_at: at(3, 9) }], promo_codes: ['NOPE'] } })).status, 400);
  const first = must(await api('POST', '/reservations', { token: user.token, body: { items: [{ resource_id: a.id, starts_at: at(3, 8), ends_at: at(3, 9) }], promo_codes: ['WELCOME50'] } }), 201);
  assert.equal(first.total_cents, 50000);
  q = must(await quote([{ resource_id: a.id, starts_at: at(3, 12), ends_at: at(3, 13) }], { promo_codes: ['WELCOME50'] }));
  assert.equal(q.discount_cents, 0, 'per-user limit reached');
  assert.deepEqual(q.unapplied_codes, ['WELCOME50']);
  const stats = must(await api('GET', `/venues/${v.id}/discounts`, { token: mgr.token }));
  assert.equal(stats.find((d) => d.id === promo.id).redemptions, 1);
  assert.equal((await api('GET', `/venues/${v.id}/discounts`, { token: user.token })).status, 403, 'codes are not public');
  must(await api('PATCH', `/discounts/${bulk.id}`, { token: mgr.token, body: { active: false } }));
  assert.equal(must(await quote([{ resource_id: a.id, starts_at: at(3, 13), ends_at: at(3, 16) }])).discount_cents, 0, 'deactivated');
  must(await api('DELETE', `/price-rules/${rule.id}`, { token: mgr.token }));
  assert.equal(must(await quote([{ resource_id: a.id, starts_at: at(3, 18), ends_at: at(3, 19) }])).total_cents, 100000, 'rule gone, base rate');
  // the quote never persists anything
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM reservations WHERE user_id=$1', [user.id])).rows[0].n, 1);
});

test('multi-slot, multi-area and multi-venue baskets are atomic; both venues can be booked at once', async () => {
  const m1 = await signup(['venue_manager']), m2 = await signup(['venue_manager']);
  const one = await makeVenue(m1), two = await makeVenue(m2);
  const user = await signup();
  const L = (r, d, h1, h2, extra = {}) => ({ resource_id: r.id, starts_at: at(d, h1), ends_at: at(d, h2), ...extra });

  // several slots, several areas, two venues, one reservation
  const res = must(await api('POST', '/reservations', { token: user.token, body: { items: [L(one.a, 4, 9, 11), L(one.a, 4, 15, 16), L(one.b, 4, 9, 10), L(two.a, 4, 9, 10), L(one.t, 4, 9, 10, { quantity: 2, players: 8 })] } }), 201);
  assert.equal(res.bookings.length, 5);
  assert.match(res.code, /^[A-Z0-9]{7}$/);
  assert.equal(res.total_cents, 200000 + 100000 + 80000 + 100000 + 2 * 2 * 10000);
  assert.deepEqual([...new Set(res.bookings.map((b) => b.venue_id))].sort(), [one.v.id, two.v.id].sort());
  assert.equal(res.bookings.find((b) => b.slots === 2).slots, 2);
  assert.equal(must(await api('GET', '/reservations', { token: user.token })).length, 1);
  assert.equal((await api('GET', `/reservations/${res.id}`, { token: (await signup()).token })).status, 403);
  assert.equal((await api('GET', `/reservations/${res.id}`, { token: m2.token })).status, 200, 'venue team can open reservations that touch their venue');

  // capacity checks: 3 tables; 2 taken, so 2 more is too many, 1 is fine
  const other = await signup();
  const tt = (q) => api('POST', '/reservations', { token: other.token, body: { items: [L(one.t, 4, 9, 10, { quantity: q })] } });
  assert.equal((await tt(2)).status, 409);
  assert.equal((await tt(1)).status, 201);
  assert.equal((await tt(4)).status, 400, 'more units than exist');
  assert.equal((await api('POST', '/reservations', { token: other.token, body: { items: [L(one.t, 4, 11, 12, { quantity: 1, players: 5 })] } })).status, 400, 'more players than fit');

  // atomic: one bad line (Court A 09:00 is taken) => the free line must not be booked either
  const before = (await pool.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n;
  const bad = await api('POST', '/reservations', { token: other.token, body: { items: [L(one.b, 4, 12, 13), L(one.a, 4, 9, 10)] } });
  assert.equal(bad.status, 409);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n, before);
  // the quote shows every problem at once instead
  const q = must(await api('POST', '/reservations/quote', { token: other.token, body: { items: [L(one.a, 4, 9, 10), L(one.b, 4, 12, 13), L(one.a, 4, 4, 5)] } }));
  assert.equal(q.ok, false);
  assert.deepEqual(q.problems.map((p) => p.index).sort(), [0, 2]);

  // a line overlapping an earlier line of the same basket is caught too
  assert.equal((await api('POST', '/reservations', { token: other.token, body: { items: [L(one.b, 5, 9, 11), L(one.b, 5, 10, 12)] } })).status, 409);

  // a basket can span currencies: each venue prices (and later invoices) in its own
  const usd = await makeVenue(m1, { currency: 'USD' });
  const mixed = must(await api('POST', '/reservations', { token: other.token, body: { items: [L(one.b, 6, 9, 10), L(usd.a, 6, 9, 10)] } }), 201);
  assert.equal(mixed.currency, 'MULTI');
  assert.deepEqual(mixed.totals.map((t) => t.currency).sort(), ['INR', 'USD']);

  // add slots later
  const more = must(await api('POST', `/reservations/${res.id}/items`, { token: user.token, body: { items: [L(two.b, 4, 9, 10)] } }), 201);
  assert.equal(more.bookings.length, 6);
  assert.equal(more.total_cents, res.total_cents + 80000);
  assert.equal((await api('POST', `/reservations/${res.id}/items`, { token: other.token, body: { items: [L(two.b, 4, 12, 13)] } })).status, 403);
});

test('concurrent reservations for the same slot: exactly one wins, no oversell', async () => {
  const mgr = await signup(['venue_manager']);
  const { a, t } = await makeVenue(mgr);
  const users = await Promise.all(Array.from({ length: 8 }, () => signup()));
  const court = await Promise.all(users.map((u) => api('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: a.id, starts_at: at(7, 10), ends_at: at(7, 11) }] } })));
  assert.equal(court.filter((r) => r.status === 201).length, 1);
  assert.equal(court.filter((r) => r.status === 409).length, 7);
  // 3 tables, 8 people each asking for 1 => 3 succeed
  const tables = await Promise.all(users.map((u) => api('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: t.id, starts_at: at(7, 10), ends_at: at(7, 10, 30) }] } })));
  assert.equal(tables.filter((r) => r.status === 201).length, 3);
  // two people each want both courts in opposite order: no deadlock, at most one wins each
  const { b } = await makeVenue(mgr);
  const x = await Promise.all([
    api('POST', '/reservations', { token: users[0].token, body: { items: [{ resource_id: a.id, starts_at: at(8, 10), ends_at: at(8, 11) }, { resource_id: b.id, starts_at: at(8, 10), ends_at: at(8, 11) }] } }),
    api('POST', '/reservations', { token: users[1].token, body: { items: [{ resource_id: b.id, starts_at: at(8, 10), ends_at: at(8, 11) }, { resource_id: a.id, starts_at: at(8, 10), ends_at: at(8, 11) }] } }),
  ]);
  assert.deepEqual(x.map((r) => r.status).sort(), [201, 409]);
});

test('modification: move, change area, capacity re-check, repricing, cut-off, staff override of the cut-off', async () => {
  const mgr = await signup(['venue_manager']);
  const { v, a, b } = await makeVenue(mgr);
  must(await api('POST', `/venues/${v.id}/price-rules`, { token: mgr.token, body: { name: 'Evening', start: '18:00', end: '22:00', hourly_rate_cents: 150000 } }), 201);
  const u = await signup(), w = await signup();
  const r = must(await api('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: a.id, starts_at: at(5, 10), ends_at: at(5, 11) }] } }), 201);
  const bid = r.bookings[0].id;
  await api('POST', '/reservations', { token: w.token, body: { items: [{ resource_id: a.id, starts_at: at(5, 12), ends_at: at(5, 13) }] } });

  // move into someone else's slot => 409; to a free one => ok, repriced into the evening rate
  assert.equal((await api('PATCH', `/bookings/${bid}`, { token: u.token, body: { starts_at: at(5, 12), ends_at: at(5, 13) } })).status, 409);
  const moved = must(await api('PATCH', `/bookings/${bid}`, { token: u.token, body: { starts_at: at(5, 18), ends_at: at(5, 19) } }));
  assert.equal(moved.booking.price_cents, 150000);
  assert.equal(moved.price_change_cents, 50000);
  assert.equal(moved.reservation.total_cents, 150000);
  // overlap with itself is fine (extend by one slot); other area; but not another user's booking
  const ext = must(await api('PATCH', `/bookings/${bid}`, { token: u.token, body: { ends_at: at(5, 20) } }));
  assert.equal(ext.booking.slots, 2);
  assert.equal(ext.reservation.total_cents, 300000);
  const sw = must(await api('PATCH', `/bookings/${bid}`, { token: u.token, body: { resource_id: b.id } }));
  assert.equal(sw.booking.resource_id, b.id);
  assert.equal((await api('PATCH', `/bookings/${bid}`, { token: w.token, body: { players: 2 } })).status, 403);
  assert.equal((await api('PATCH', `/bookings/${bid}`, { token: u.token, body: {} })).status, 400);
  const other = await makeVenue(await signup(['venue_manager']));
  assert.equal((await api('PATCH', `/bookings/${bid}`, { token: u.token, body: { resource_id: other.a.id } })).status, 400, 'cross-venue moves are cancel + rebook');

  // inside the free-change window customers are refused, the venue team is not
  const soon = new Date(Date.now() + 3 * 3600e3); soon.setUTCMinutes(0, 0, 0);
  const v24 = await makeVenue(mgr, { timezone: 'UTC' });
  must(await api('POST', `/venues/${v24.v.id}/hours`, { token: mgr.token, body: { hours: [] } }));
  const s1 = must(await api('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: v24.a.id, starts_at: soon.toISOString(), ends_at: new Date(+soon + 3600e3).toISOString() }] } }), 201);
  assert.equal((await api('PATCH', `/bookings/${s1.bookings[0].id}`, { token: u.token, body: { players: 2 } })).status, 409);
  assert.equal((await api('PATCH', `/bookings/${s1.bookings[0].id}`, { token: mgr.token, body: { players: 2 } })).status, 200);
  const notes = must(await api('GET', '/notifications', { token: u.token }));
  assert.ok(notes.items.some((x) => x.kind === 'booking_modified' && /venue changed/i.test(x.title)), 'customer told when the venue changes their booking');
});

test('cancellation policy: free early, partial late, full when the venue cancels; partial cancel reprices the rest', async () => {
  const mgr = await signup(['venue_manager']);
  const v = must(await api('POST', '/venues', { token: mgr.token, body: { name: 'Round-the-clock', timezone: 'UTC', cancel_free_hours: 24, late_cancel_refund_percent: 50 } }), 201);
  const c = must(await api('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'Court 1', hourly_rate_cents: 40000 } }), 201);
  must(await api('POST', `/venues/${v.id}/discounts`, { token: mgr.token, body: { name: '3 slots 25% off', kind: 'percent', value: 25, min_slots: 3 } }), 201);
  const u = await signup();
  const soon = new Date(Date.now() + 4 * 3600e3); soon.setUTCMinutes(0, 0, 0);
  const iso = (d) => d.toISOString();
  const h = (d, k) => new Date(+d + k * 3600e3);

  // late (starts in ~4h): 50% back
  const late = must(await api('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: c.id, starts_at: iso(soon), ends_at: iso(h(soon, 1)) }] } }), 201);
  const lc = must(await api('DELETE', `/bookings/${late.bookings[0].id}`, { token: u.token }));
  assert.deepEqual([lc.refund_cents, lc.fee_cents], [20000, 20000]);
  assert.equal((await api('DELETE', `/bookings/${late.bookings[0].id}`, { token: u.token })).status, 409, 'already cancelled');
  // slot is free again
  assert.equal((await api('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: c.id, starts_at: iso(soon), ends_at: iso(h(soon, 1)) }] } })).status, 201);

  // early (3 days out), 3 lines => 25% off; cancel one line => other two lose the discount (min 3 slots)
  const d3 = new Date(Date.now() + 72 * 3600e3); d3.setUTCMinutes(0, 0, 0);
  const rs = must(await api('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: c.id, starts_at: iso(d3), ends_at: iso(h(d3, 2)) }, { resource_id: c.id, starts_at: iso(h(d3, 3)), ends_at: iso(h(d3, 4)) }] } }), 201);
  assert.equal(rs.discount_cents, 30000);
  assert.equal(rs.total_cents, 90000);
  const gone = must(await api('DELETE', `/bookings/${rs.bookings.find((b) => b.slots === 1).id}`, { token: u.token }));
  assert.equal(gone.refund_cents, rs.bookings.find((b) => b.slots === 1).price_cents, 'early cancel = full refund of what was charged');
  const after = must(await api('GET', `/reservations/${rs.id}`, { token: u.token }));
  assert.equal(after.discount_cents, 0, 'only 2 slots left: discount no longer applies');
  assert.equal(after.total_cents, 80000);
  assert.equal(after.status, 'confirmed');
  const all = must(await api('DELETE', `/reservations/${rs.id}`, { token: u.token }));
  assert.equal(all.cancelled, 1);
  assert.equal(all.refund_cents, 80000);
  assert.equal(all.reservation.status, 'cancelled');
  assert.equal(all.reservation.total_cents, 0);
  assert.equal((await api('DELETE', `/reservations/${rs.id}`, { token: u.token })).status, 409);

  // venue cancels at short notice => full refund + customer notified
  const sh = new Date(soon.getTime() + 6 * 3600e3);
  const mine = must(await api('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: c.id, starts_at: iso(sh), ends_at: iso(h(sh, 1)) }] } }), 201);
  const vc = must(await api('DELETE', `/bookings/${mine.bookings[0].id}`, { token: mgr.token, body: undefined, query: { reason: 'Floodlights broken' } }));
  assert.equal(vc.refund_cents, 40000);
  const inbox = must(await api('GET', '/notifications', { token: u.token }));
  assert.ok(inbox.items.some((x) => x.kind === 'booking_cancelled' && /Floodlights/.test(x.body)));
  assert.equal((await api('DELETE', `/bookings/${mine.bookings[0].id}`, { token: (await signup()).token })).status, 403);
});

test('bulk blocks: dry run, conflicts, cancel + refund, customers locked out, release by batch', async () => {
  const mgr = await signup(['venue_manager']);
  const { v, a, b } = await makeVenue(mgr);
  const u = await signup();
  const booked = must(await api('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: a.id, starts_at: at(10, 10), ends_at: at(10, 12) }] } }), 201);
  const free = (id, d, h) => api('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: id, starts_at: at(d, h), ends_at: at(d, h + 1) }] } });

  const spec = { from_date: dayPlus(9), to_date: dayPlus(12), start_time: '08:00', end_time: '14:00', kind: 'maintenance', reason: 'Resurfacing' };
  assert.equal((await api('POST', `/venues/${v.id}/blocks`, { token: u.token, body: { ...spec } })).status, 403);
  assert.equal((await api('POST', `/venues/${v.id}/blocks`, { token: mgr.token, body: { ...spec, resource_ids: [(await makeVenue(mgr)).a.id] } })).status, 400, 'area of another venue');
  const dry = must(await api('POST', `/venues/${v.id}/blocks`, { token: mgr.token, body: { ...spec, resource_ids: [a.id, b.id], dry_run: true } }), 201);
  assert.equal(dry.would_create, 8);
  assert.equal(dry.conflicts, 1);
  const refused = await api('POST', `/venues/${v.id}/blocks`, { token: mgr.token, body: { ...spec, resource_ids: [a.id, b.id] } });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.details.conflicts, 1);
  assert.equal(must(await api('GET', `/venues/${v.id}/blocks`, { token: mgr.token })).length, 0, 'nothing changed on refusal');

  const done = must(await api('POST', `/venues/${v.id}/blocks`, { token: mgr.token, body: { ...spec, resource_ids: [a.id, b.id], cancel_conflicting: true } }), 201);
  assert.equal(done.blocks, 8);
  assert.equal(done.cancelled_bookings, 1);
  const rs = must(await api('GET', `/reservations/${booked.id}`, { token: u.token }));
  assert.equal(rs.bookings[0].status, 'cancelled');
  assert.equal(rs.bookings[0].refund_cents, 200000, 'venue-initiated cancellation refunds in full');
  assert.ok(must(await api('GET', '/notifications', { token: u.token })).items.some((x) => /cancelled by the venue/i.test(x.title)));

  assert.equal((await free(a.id, 10, 9)).status, 409, 'blocked');
  assert.equal((await free(b.id, 10, 13)).status, 409);
  assert.equal((await free(a.id, 10, 14)).status, 201, 'outside the blocked band');
  const grid = must(await api('GET', `/venues/${v.id}/availability`, { query: { date: dayPlus(10), resource_id: a.id } })).resources[0].slots;
  assert.equal(grid.find((s) => s.starts_at === at(10, 9)).status, 'blocked');
  assert.equal(must(await api('GET', `/resources/${a.id}/availability`, { query: { from: at(10, 9), to: at(10, 10) } })).available, false);
  const cmp = must(await api('GET', '/venues', { query: { available_from: at(10, 9), available_to: at(10, 10), q: v.name } }));
  assert.equal(cmp.length, 1, 'court C/table still free so the venue is listed');

  // whole-venue block with weekday filter
  const wd = weekdayOf(20);
  const holiday = must(await api('POST', `/venues/${v.id}/blocks`, { token: mgr.token, body: { from_date: dayPlus(20), to_date: dayPlus(34), weekdays: [wd], kind: 'holiday', reason: 'Festival' } }), 201);
  assert.equal(holiday.blocks, 3, 'three of that weekday in 15 days');
  assert.equal((await free(b.id, 20, 10)).status, 409);
  assert.equal((await free(b.id, 21, 10)).status, 201);
  assert.equal(must(await api('DELETE', `/venues/${v.id}/blocks`, { token: mgr.token, query: { batch_id: holiday.batch_id } })).released, 3);
  assert.equal((await free(b.id, 27, 10)).status, 201);
  assert.equal((await api('DELETE', `/venues/${v.id}/blocks`, { token: mgr.token })).status, 400);
  must(await api('DELETE', `/venues/${v.id}/blocks`, { token: mgr.token, query: { batch_id: done.batch_id } }));
  assert.equal((await free(a.id, 11, 9)).status, 201);
  // the legacy quick-book path respects blocks as well
  const blk = must(await api('POST', `/venues/${v.id}/blocks`, { token: mgr.token, body: { from_date: dayPlus(40), to_date: dayPlus(40), resource_ids: [b.id] } }), 201);
  assert.equal((await api('POST', '/bookings', { token: u.token, body: { resource_id: b.id, starts_at: at(40, 10), ends_at: at(40, 11) } })).status, 409);
  void blk;
});

test('admin override: bypass hours/blocks, comps, walk-in guests (encrypted), displace conflicts; staff-only', async () => {
  const mgr = await signup(['venue_manager']);
  const { v, a, b } = await makeVenue(mgr);
  const u = await signup(), cust = await signup();
  const victim = must(await api('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: a.id, starts_at: at(6, 10), ends_at: at(6, 11) }] } }), 201);
  const ov = (body, token = mgr.token) => api('POST', `/venues/${v.id}/override-bookings`, { token, body });
  const slot = (r, d, h1, h2, x = {}) => ({ resource_id: r.id, starts_at: at(d, h1), ends_at: at(d, h2), ...x });

  assert.equal((await ov({ items: [slot(a, 6, 10, 11)], reason: 'abc' }, u.token)).status, 403);
  assert.equal((await ov({ items: [slot(a, 6, 10, 11)] })).status, 400, 'a reason is mandatory');
  assert.equal((await ov({ items: [slot(a, 6, 10, 11)], reason: 'League night' })).status, 409, 'capacity still counts unless displacing');

  // after-hours, in a block, comped (price 0), walk-in guest
  must(await api('POST', `/venues/${v.id}/blocks`, { token: mgr.token, body: { from_date: dayPlus(6), to_date: dayPlus(6), start_time: '22:00', end_time: '24:00', resource_ids: [b.id] } }), 201);
  const late = must(await ov({ items: [slot(b, 6, 22, 23, { price_cents: 0 })], reason: 'Staff party', guest_name: 'Ravi Patil', guest_phone: '+91 90000 12345' }), 201);
  assert.equal(late.total_cents, 0);
  assert.equal(late.bookings[0].source, 'admin');
  const raw = JSON.stringify((await pool.query('SELECT guest_name_enc, guest_phone_enc FROM bookings WHERE reservation_id=$1', [late.id])).rows);
  assert.ok(!raw.includes('Ravi') && !raw.includes('90000'), 'guest details encrypted at rest');

  // displace the customer: cancelled with full refund + notified, override placed
  const disp = must(await ov({ items: [slot(a, 6, 10, 11)], reason: 'Tournament final', displace_conflicts: true, user_handle: cust.handle }), 201);
  assert.equal(disp.displaced_bookings, 1);
  assert.equal(must(await api('GET', `/reservations/${victim.id}`, { token: u.token })).bookings[0].status, 'cancelled');
  assert.ok(must(await api('GET', '/notifications', { token: u.token })).items.some((x) => /cancelled by the venue/i.test(x.title) && /Tournament final/.test(x.body)));
  assert.ok(must(await api('GET', '/notifications', { token: cust.token })).items.some((x) => x.kind === 'reservation_confirmed'));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='override_booking'")).rows[0].n, 2);

  // schedule shows guests to the team (audited) and blocks
  const sch = must(await api('GET', `/venues/${v.id}/schedule`, { token: mgr.token, query: { from: at(6, 0), to: at(7, 0) } }));
  assert.equal(sch.bookings.find((x) => x.reservation_id === late.id).guest.name, 'Ravi Patil');
  assert.equal(sch.blocks.length, 1);
  assert.equal((await api('GET', `/venues/${v.id}/schedule`, { token: u.token, query: { from: at(6, 0), to: at(7, 0) } })).status, 403);

  // payment bookkeeping + no-show
  const bid = disp.bookings[0].id;
  assert.equal((await api('POST', `/bookings/${bid}/payment`, { token: mgr.token, body: { status: 'paid' } })).status, 400, 'invoiced bookings are settled through their invoice');
  assert.equal((await api('POST', `/invoices/${disp.invoices[0].id}/paid`, { token: u.token, body: { method: 'cash' } })).status, 403);
  assert.equal(must(await api('POST', `/invoices/${disp.invoices[0].id}/paid`, { token: mgr.token, body: { method: 'cash' } })).status, 'paid');
  assert.equal((await api('POST', `/bookings/${bid}/no-show`, { token: mgr.token })).status, 400, 'has not started yet');
  await pool.query("UPDATE bookings SET starts_at = now() - interval '2 hours', ends_at = now() - interval '1 hour' WHERE id=$1", [bid]);
  assert.equal(must(await api('POST', `/bookings/${bid}/no-show`, { token: mgr.token })).status, 'no_show');
});

test('reports: revenue, discounts, cancellations, utilisation, peaks, customers', async () => {
  const mgr = await signup(['venue_manager']);
  const { v, a } = await makeVenue(mgr);
  const u1 = await signup(), u2 = await signup();
  must(await api('POST', `/venues/${v.id}/discounts`, { token: mgr.token, body: { name: 'Ten off', code: 'TEN', kind: 'fixed', value: 10000 } }), 201);
  const book = (u, d, h1, h2, extra = {}) => api('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: a.id, starts_at: at(d, h1), ends_at: at(d, h2) }], ...extra } });
  must(await book(u1, 2, 10, 12), 201); // 200000
  must(await book(u1, 3, 18, 19, { promo_codes: ['TEN'] }), 201); // 90000
  const gone = must(await book(u2, 4, 9, 10), 201);
  must(await api('DELETE', `/bookings/${gone.bookings[0].id}`, { token: u2.token })); // early: refunded in full
  must(await book(u2, 4, 11, 12), 201); // 100000
  must(await api('POST', `/venues/${v.id}/blocks`, { token: mgr.token, body: { from_date: dayPlus(5), to_date: dayPlus(5), resource_ids: [a.id] } }), 201);

  const rep = must(await api('GET', `/venues/${v.id}/reports`, { token: mgr.token, query: { from: dayPlus(0), to: dayPlus(6) } }));
  const s = rep.summary;
  assert.equal(s.bookings, 3);
  assert.equal(s.gross_cents, 400000);
  assert.equal(s.discount_cents, 10000);
  assert.equal(s.net_cents, 390000);
  assert.equal(s.cancellations, 1);
  assert.equal(s.cancellation_fee_cents, 0);
  assert.equal(s.refunded_cents, 0, 'nothing had been paid, so nothing is refunded');
  assert.equal(s.unit_hours, 4);
  assert.equal(s.outstanding_cents, 390000);
  assert.equal(s.average_booking_cents, 130000);
  assert.equal(s.cancellation_rate, 0.25);
  assert.equal(rep.series.length, 3, 'one row per day with bookings');
  assert.equal(rep.series.find((r) => r.period === dayPlus(2)).net_cents, 200000);
  const ca = rep.by_resource.find((r) => r.resource_id === a.id);
  // Court A: 7 days x 16h open minus one fully blocked day = 6 x 16 = 96h; 4h booked
  assert.equal(ca.available_unit_hours, 96);
  assert.equal(ca.utilisation, Math.round((4 / 96) * 1000) / 1000);
  assert.equal(rep.discounts[0].code, 'TEN');
  assert.equal(rep.discounts[0].given_cents, 10000);
  assert.equal(rep.customers.unique, 2);
  assert.equal(rep.customers.top[0].handle, u1.handle);
  assert.ok(rep.peak_hours.length >= 1 && rep.by_weekday.length >= 1);
  assert.equal(rep.channels[0].source, 'user');
  const month = must(await api('GET', `/venues/${v.id}/reports`, { token: mgr.token, query: { from: dayPlus(0), to: dayPlus(6), group_by: 'month' } }));
  assert.ok(month.series.length <= 2);
  assert.equal((await api('GET', `/venues/${v.id}/reports`, { token: u1.token, query: { from: dayPlus(0), to: dayPlus(6) } })).status, 403);
  assert.equal((await api('GET', `/venues/${v.id}/reports`, { token: mgr.token, query: { from: dayPlus(6), to: dayPlus(0) } })).status, 400);
});

test('compare venues side by side and book from both in one go', async () => {
  const m1 = await signup(['venue_manager']), m2 = await signup(['venue_manager']);
  const cheap = await makeVenue(m1, { name: 'Budget Hoops', latitude: 18.6, longitude: 73.9 });
  const posh = await makeVenue(m2, { name: 'Posh Courts', latitude: 18.52, longitude: 73.85 });
  must(await api('PATCH', `/resources/${posh.a.id}`, { token: m2.token, body: { hourly_rate_cents: 250000, surface: 'maple', indoor: true } }));
  must(await api('PATCH', `/resources/${posh.b.id}`, { token: m2.token, body: { hourly_rate_cents: 250000 } }));
  must(await api('POST', `/venues/${posh.v.id}/discounts`, { token: m2.token, body: { name: 'Weekday off-peak', kind: 'percent', value: 15 } }), 201);
  const u = await signup();
  const rev = await signup();
  must(await api('POST', '/testimonials', { token: rev.token, body: { subject_type: 'venue', subject_id: posh.v.id, rating: 5, body: 'Lovely floors' } }), 201);
  // someone already holds Budget's courts at 10:00 tomorrow+2
  for (const r of [cheap.a, cheap.b]) must(await api('POST', '/reservations', { token: (await signup()).token, body: { items: [{ resource_id: r.id, starts_at: at(2, 10), ends_at: at(2, 11) }] } }), 201);

  assert.equal((await api('GET', '/venue-comparison', { query: { ids: cheap.v.id } })).status, 400);
  const cmp = must(await api('GET', '/venue-comparison', { query: { ids: `${cheap.v.id},${posh.v.id}`, sport: 'basketball', from: at(2, 10), to: at(2, 11), lat: 18.5204, lng: 73.8567 } }));
  assert.equal(cmp.venues.length, 2);
  const [c, p] = cmp.venues;
  assert.equal(c.areas.length, 2);
  assert.equal(c.totals.concurrent_capacity, 2);
  assert.equal(c.totals.players, 20);
  assert.equal(p.pricing.from_hourly_cents, 250000);
  assert.equal(p.areas.find((x) => x.id === posh.a.id).indoor, true);
  assert.equal(p.rating, 5);
  assert.equal(p.offers.length, 1);
  assert.ok(p.distance_km < c.distance_km);
  assert.equal(c.window.bookable_areas, 0, 'Budget is full at 10:00');
  assert.equal(c.window.areas[0].reason, 'fully booked');
  assert.equal(p.window.bookable_areas, 2);
  assert.equal(p.window.cheapest_price_cents, 250000);
  assert.ok(new Date(c.next_free.starts_at) > new Date());
  assert.equal(cmp.highlights.nearest_venue_id, posh.v.id);
  assert.equal(cmp.highlights.top_rated_venue_id, posh.v.id);
  assert.equal(cmp.highlights.most_available_venue_id, posh.v.id);
  assert.equal(cmp.highlights.cheapest_venue_id, posh.v.id, 'cheapest *bookable* in that window');

  // "book both or either": one court at each venue, then just one
  const both = must(await api('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: posh.a.id, starts_at: at(2, 10), ends_at: at(2, 11) }, { resource_id: cheap.a.id, starts_at: at(2, 11), ends_at: at(2, 12) }] } }), 201);
  assert.deepEqual([...new Set(both.bookings.map((b) => b.venue_name))].length, 2);
  assert.equal(both.discount_cents, 37500, '15% off only on the venue that offers it');
  const aside = must(await api('GET', '/notifications', { token: m2.token }));
  assert.ok(aside.items.some((x) => x.kind === 'new_booking'), 'each venue team is told about its part');
});

test('notifications: inbox, preferences, muted kinds, email queue + webhook dispatch, reminders', async () => {
  const mgr = await signup(['venue_manager']);
  const { v, a } = await makeVenue(mgr);
  const u = await signup();
  const book = (h) => api('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: a.id, starts_at: at(2, h), ends_at: at(2, h + 1) }] } });
  must(await book(9), 201);
  let inbox = must(await api('GET', '/notifications', { token: u.token }));
  assert.equal(inbox.unread, 1);
  assert.equal(inbox.items[0].kind, 'reservation_confirmed');
  assert.equal(must(await api('GET', '/notifications', { token: mgr.token })).items[0].kind, 'new_booking', 'venue team hears about it');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notification_deliveries WHERE status='pending'")).rows[0].n >= 2, true, 'emails queued');

  assert.equal(must(await api('POST', '/notifications/read', { token: u.token, body: {} })).marked, 1);
  assert.equal(must(await api('GET', '/notifications', { token: u.token })).unread, 0);
  assert.deepEqual(must(await api('GET', '/me/notification-preferences', { token: u.token })), { in_app: true, email: true, reminder_hours: 24, muted_kinds: [] });

  // switch email off and mute new_booking for the manager
  must(await api('PATCH', '/me/notification-preferences', { token: u.token, body: { email: false } }));
  const pendingBefore = (await pool.query("SELECT count(*)::int AS n FROM notification_deliveries")).rows[0].n;
  must(await book(11), 201);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notification_deliveries")).rows[0].n, pendingBefore + 1, 'only the manager\'s email (user opted out)');
  must(await api('PATCH', '/me/notification-preferences', { token: mgr.token, body: { muted_kinds: ['new_booking'] } }));
  const mgrBefore = must(await api('GET', '/notifications', { token: mgr.token })).items.length;
  must(await book(13), 201);
  assert.equal(must(await api('GET', '/notifications', { token: mgr.token })).items.length, mgrBefore, 'muted');
  assert.equal((await api('PATCH', '/me/notification-preferences', { token: u.token, body: { reminder_hours: 0 } })).status, 400);

  // dispatch through a webhook (a local stub standing in for SES / n8n)
  const hits = [];
  const stub = createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { hits.push({ auth: req.headers.authorization, body: JSON.parse(b) }); res.writeHead(hits.length === 1 ? 500 : 200).end('{}'); }); });
  await new Promise((r) => stub.listen(0, r));
  stub.unref();
  assert.equal((await api('POST', '/admin/notifications/dispatch', { token: mgr.token })).status, 403, 'admin only');
  const { signToken } = await import('../src/auth.js');
  const adminRow = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('vr_root','Root','{admin}','x','x','vr_adminidx') RETURNING id")).rows[0];
  const admin = { token: await signToken({ id: adminRow.id, roles: ['admin'] }) };
  let out = must(await api('POST', '/admin/notifications/dispatch', { token: admin.token, body: {} }));
  assert.equal(out.configured, false, 'without a webhook mail stays queued');
  config.notifyWebhook.url = `http://localhost:${stub.address().port}/mail`;
  config.notifyWebhook.secret = 's3cret';
  try {
    out = must(await api('POST', '/admin/notifications/dispatch', { token: admin.token, body: {} }));
    assert.equal(out.configured, true);
    assert.equal(out.failed, 1, 'first call hits a 500 and is retried later');
    assert.ok(out.sent >= 1);
    assert.equal(hits[0].auth, 'Bearer s3cret');
    assert.match(hits[0].body.to, /@example\.com$/);
    assert.equal(hits[0].body.channel, 'email');
    out = must(await api('POST', '/admin/notifications/dispatch', { token: admin.token, body: {} }));
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM notification_deliveries WHERE status='pending'")).rows[0].n, 0, 'everything delivered on retry');
  } finally {
    config.notifyWebhook.url = undefined;
    stub.closeAllConnections();
    stub.close();
  }

  // reminders: a booking inside the reminder window is announced once
  const soon = new Date(Date.now() + 3 * 3600e3); soon.setUTCMinutes(0, 0, 0);
  const v24 = await makeVenue(mgr, { timezone: 'UTC' });
  must(await api('POST', `/venues/${v24.v.id}/hours`, { token: mgr.token, body: { hours: [] } }));
  must(await api('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: v24.a.id, starts_at: soon.toISOString(), ends_at: new Date(+soon + 3600e3).toISOString() }] } }), 201);
  const r1 = await notificationCycle();
  assert.ok(r1.reminders >= 1);
  assert.equal((await notificationCycle()).reminders, 0, 'only once');
  assert.ok(must(await api('GET', '/notifications', { token: u.token })).items.some((x) => x.kind === 'booking_reminder'));
  void v;
});

test('month calendar: per-day availability, price-from, closed days, past and out-of-window days', async () => {
  const mgr = await signup(['venue_manager']);
  const { v, a } = await makeVenue(mgr);
  const u = await signup();
  const month = dayPlus(5).slice(0, 7);
  const cal = (q = {}) => api('GET', `/venues/${v.id}/calendar`, { query: { month, resource_id: a.id, ...q } });
  const day = (c, d) => c.days.find((x) => x.date === d);

  // fill Court A completely on day +5 (16 hourly slots = two 8-slot bookings) and mostly on day +6
  const fill = (d, from, to) => api('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: a.id, starts_at: at(d, from), ends_at: at(d, to) }] } });
  must(await fill(5, 6, 14), 201); must(await fill(5, 14, 22), 201);
  must(await fill(6, 6, 14), 201); must(await fill(6, 14, 18), 201);
  // closed on one weekday
  const closedDay = dayPlus(8), wd = new Date(`${closedDay}T00:00:00Z`).getUTCDay();
  must(await api('POST', `/venues/${v.id}/hours`, { token: mgr.token, body: { hours: [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== wd).map((weekday) => ({ weekday, opens: '06:00', closes: '22:00' })) } }));

  const c = must(await cal());
  assert.equal(c.currency, 'INR');
  assert.equal(day(c, dayPlus(5)).status, 'full');
  assert.equal(day(c, dayPlus(5)).free_slots, 0);
  assert.equal(day(c, dayPlus(6)).status, 'limited');
  assert.equal(day(c, dayPlus(6)).free_slots, 4);
  assert.equal(day(c, dayPlus(6)).total_slots, 16);
  assert.equal(day(c, closedDay).status, 'closed');
  assert.equal(day(c, dayPlus(7)).status, 'available');
  assert.equal(day(c, dayPlus(7)).from_price_cents, 100000);
  assert.equal(c.days.length, new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate());
  assert.equal(c.days.filter((x) => x.date < c.today).every((x) => x.status === 'past'), true);

  // a rate rule shows up as the cheapest price; other areas widen the picture; the window limit applies
  must(await api('POST', `/venues/${v.id}/price-rules`, { token: mgr.token, body: { name: 'Early bird', start: '06:00', end: '09:00', hourly_rate_cents: 60000, resource_id: a.id } }), 201);
  assert.equal(day(must(await cal()), dayPlus(7)).from_price_cents, 60000);
  const all = must(await api('GET', `/venues/${v.id}/calendar`, { query: { month } }));
  assert.equal(day(all, dayPlus(5)).status, 'available', 'other courts are still free');
  must(await api('PATCH', `/venues/${v.id}`, { token: mgr.token, body: { max_advance_days: 7 } }));
  assert.equal(day(must(await cal()), dayPlus(9)).status, 'too_far');
  assert.equal((await api('GET', `/venues/${v.id}/calendar`, { query: { month: '2026-13' } })).status, 400);
});

test('online payment modes fall back to pay-at-venue while no payment provider is configured', async () => {
  const mgr = await signup(['venue_manager']);
  const { v, a } = await makeVenue(mgr, { payment_mode: 'online_required' });
  const u = await signup();
  const r = must(await api('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: a.id, starts_at: at(3, 10), ends_at: at(3, 11) }] } }), 201);
  assert.equal(r.payment_deadline, null, 'no deadline when the venue cannot actually take payment');
  assert.equal(r.awaiting_payment, false);
  assert.equal(r.invoices[0].payment_mode, 'pay_at_venue');
  assert.equal((await api('POST', '/payments', { token: u.token, body: { purpose_type: 'venue_invoice', purpose_id: r.invoices[0].id, provider: 'stripe' } })).status, 400);
  void v;
});

test('module is exposed through REST, OpenAPI and MCP from one definition', async () => {
  const { capabilities } = await import('../src/capabilities/index.js');
  const names = capabilities.map((c) => c.name);
  for (const nme of ['venue_availability', 'compare_venues', 'quote_reservation', 'create_reservation', 'modify_booking', 'cancel_reservation', 'block_slots', 'override_booking', 'venue_report', 'create_price_rule', 'create_discount', 'set_venue_hours', 'update_notification_preferences']) {
    assert.ok(names.includes(nme), nme);
  }
  const openapi = await (await fetch(`${base}/api/v1/openapi.json`)).json();
  assert.ok(openapi.paths['/venue-comparison'] ?? Object.keys(openapi.paths).some((p) => p.includes('venue-comparison')));
  assert.equal((await api('POST', '/reservations', { body: { items: [] } })).status, 401);
});
