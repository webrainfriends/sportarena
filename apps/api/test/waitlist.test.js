import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { processWaitlist } = await import('../src/booking/waitlist.js');
const { fromLocal, addDays } = await import('../src/booking/time.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `wl_${n}_${roles[0]}`, display_name: `Wait ${n}`, email: `wl${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const today = new Date().toISOString().slice(0, 10);
const day = (d) => addDays(today, d);
const at = (d, h) => fromLocal(day(d), h * 60, 'UTC').toISOString();
const wait = async (fn, ms = 4000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 40)); } };
const inbox = async (u) => must(await api('GET', '/notifications', { token: u.token })).items;
const entry = async (id) => (await pool.query('SELECT * FROM waitlist_entries WHERE id=$1', [id])).rows[0];

async function venue(mgr, capacity = 1) {
  const v = must(await api('POST', '/venues', { token: mgr.token, body: { name: `Wait Arena ${Math.random().toString(36).slice(2, 6)}`, timezone: 'UTC' } }), 201);
  must(await api('POST', `/venues/${v.id}/hours`, { token: mgr.token, body: { hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '06:00', closes: '22:00' })) } }));
  const court = must(await api('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: capacity > 1 ? 'table' : 'court', name: 'Court 1', capacity, hourly_rate_cents: 50000 } }), 201);
  return { v, court };
}
const book = (u, court, d, h1, h2, extra = {}) => api('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: court.id, starts_at: at(d, h1), ends_at: at(d, h2), ...extra }] } });
const join = (u, court, d, h1, h2, quantity = 1) => api('POST', '/waitlist', { token: u.token, body: { resource_id: court.id, starts_at: at(d, h1), ends_at: at(d, h2), quantity } });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('waitlist: queue, FIFO offer on cancellation, the slot is held, claimed by booking, expiry passes it on', async () => {
  const mgr = await signup(['venue_manager']);
  const [owner, b, c, d, stranger] = [await signup(), await signup(), await signup(), await signup(), await signup()];
  const { v, court } = await venue(mgr);
  const held = must(await book(owner, court, 3, 10, 11), 201);

  // can't queue for something you could simply book; blocked time has nothing to wait for
  assert.equal((await join(b, court, 3, 12, 13)).status, 409);
  assert.equal((await api('POST', '/waitlist', { body: {} })).status, 401);
  must(await api('POST', `/venues/${v.id}/blocks`, { token: mgr.token, body: { from_date: day(4), to_date: day(4), kind: 'maintenance' } }), 201);
  assert.equal((await join(b, court, 4, 10, 11)).status, 409);
  assert.equal((await join(b, court, 3, 5, 6)).status, 400, 'same booking rules apply (closed hours)');

  const eb = must(await join(b, court, 3, 10, 11), 201);
  const ec = must(await join(c, court, 3, 10, 11), 201);
  must(await join(d, court, 3, 10, 11), 201);
  assert.equal(eb.position, 1);
  assert.equal(ec.position, 2);
  assert.equal((await join(b, court, 3, 10, 11)).status, 409, 'only once');
  assert.equal(must(await api('GET', '/me/waitlist', { token: c.token }))[0].position, 2);

  // team view: demand without names
  const demand = must(await api('GET', `/venues/${v.id}/waitlist`, { token: mgr.token }));
  assert.equal(demand[0].waiting, 3);
  assert.ok(!JSON.stringify(demand).includes(b.handle));
  assert.equal((await api('GET', `/venues/${v.id}/waitlist`, { token: b.token })).status, 403);

  // the booking is cancelled: first in line is offered the slot, and only they can book it
  must(await api('DELETE', `/bookings/${held.bookings[0].id}`, { token: owner.token }));
  await wait(async () => (await entry(eb.id)).status === 'offered');
  assert.equal((await entry(ec.id)).status, 'waiting');
  const offer = (await inbox(b)).find((x) => x.kind === 'waitlist_offer');
  assert.ok(offer);
  assert.equal(offer.data.waitlist_id, eb.id);
  assert.equal(offer.data.resource_id, court.id);
  assert.equal(must(await api('GET', '/me/waitlist', { token: b.token }))[0].status, 'offered');
  assert.equal((await book(stranger, court, 3, 10, 11)).status, 409, 'held for the person at the head of the queue');
  assert.equal((await api('POST', '/reservations/quote', { token: stranger.token, body: { items: [{ resource_id: court.id, starts_at: at(3, 10), ends_at: at(3, 11) }] } })).body.ok, false);
  const grid = (u) => api('GET', `/venues/${v.id}/availability`, { token: u?.token, query: { date: day(3), resource_id: court.id } }).then((r) => r.body.resources[0].slots.find((s) => s.starts_at === at(3, 10)));
  assert.equal((await grid(stranger)).status, 'booked');
  assert.equal((await grid(b)).status, 'free', 'the holder sees it as theirs to book');
  assert.equal(must(await api('GET', '/me/slot-alerts', { token: stranger.token })).length, 0);

  // B books it: done waiting; C and D stay queued (nothing left to offer)
  const mine = must(await book(b, court, 3, 10, 11), 201);
  const done = await entry(eb.id);
  assert.equal(done.status, 'booked');
  assert.equal(done.reservation_id, mine.id);
  await processWaitlist();
  assert.equal((await entry(ec.id)).status, 'waiting');

  // B cancels again: C is offered; C lets it lapse: D is offered; D gives it back: nobody left, the slot is simply free
  must(await api('DELETE', `/bookings/${mine.bookings[0].id}`, { token: b.token }));
  await wait(async () => (await entry(ec.id)).status === 'offered');
  await pool.query("UPDATE waitlist_entries SET offer_expires_at = now() - interval '1 minute' WHERE id=$1", [ec.id]);
  const r = await processWaitlist();
  assert.equal(r.expired, 1);
  assert.equal((await entry(ec.id)).status, 'expired');
  assert.ok((await inbox(c)).some((x) => x.kind === 'waitlist_expired'));
  const ed = (await pool.query("SELECT id FROM waitlist_entries WHERE user_id=$1", [d.id])).rows[0];
  assert.equal((await entry(ed.id)).status, 'offered');
  must(await api('DELETE', `/waitlist/${ed.id}`, { token: d.token }));
  assert.equal((await api('DELETE', `/waitlist/${ed.id}`, { token: d.token })).status, 404);
  must(await book(stranger, court, 3, 10, 11), 201);
});

test('waitlist: units, skipping a request that does not fit, staff overrides, past slots', async () => {
  const mgr = await signup(['venue_manager']);
  const [x, y, z, w] = [await signup(), await signup(), await signup(), await signup()];
  const { v, court: tables } = await venue(mgr, 3); // three tables
  must(await book(x, tables, 5, 10, 11, { quantity: 3 }), 201); // all sold out
  const big = must(await join(y, tables, 5, 10, 11, 2), 201);   // wants two
  const small = must(await join(z, tables, 5, 10, 11, 1), 201); // wants one
  assert.equal((await join(w, tables, 5, 10, 11, 4)).status, 400, 'more units than exist');

  // one table frees up (x cancels and rebooks two): y needs two so isn't offered; z (later) fits and is
  const bid = (await pool.query("SELECT id FROM bookings WHERE user_id=$1 AND status='confirmed'", [x.id])).rows[0].id;
  must(await api('PATCH', `/bookings/${bid}`, { token: x.token, body: { quantity: 2 } }));
  await processWaitlist();
  assert.equal((await entry(big.id)).status, 'waiting');
  assert.equal((await entry(small.id)).status, 'offered');

  // while z holds the offer, y's request still doesn't fit; a staff override ignores holds (the venue has the last word)
  const ov = await api('POST', `/venues/${v.id}/override-bookings`, { token: mgr.token, body: { items: [{ resource_id: tables.id, starts_at: at(5, 10), ends_at: at(5, 11), quantity: 1 }], reason: 'League night' } });
  assert.equal(ov.status, 201);
  assert.equal((await book(z, tables, 5, 10, 11)).status, 409, 'the held table was taken by the venue');

  // slots that have started can't be queued for and old waits expire
  await pool.query("UPDATE waitlist_entries SET starts_at = now() - interval '2 hours', ends_at = now() - interval '1 hour' WHERE id=$1", [big.id]);
  await processWaitlist();
  assert.equal((await entry(big.id)).status, 'expired');
});
