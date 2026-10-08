import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { checkSlotAlerts } = await import('../src/booking/alerts.js');
const { fromLocal, addDays } = await import('../src/booking/time.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `fa_${n}_${roles[0]}`, display_name: `Fav ${n}`, email: `fa${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const today = new Date().toISOString().slice(0, 10);
const day = (d) => addDays(today, d);
const at = (d, h) => fromLocal(day(d), h * 60, 'UTC').toISOString();
const wait = async (fn, ms = 4000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 40)); } };
const inbox = async (u) => must(await api('GET', '/notifications', { token: u.token })).items;

async function venue(mgr) {
  const v = must(await api('POST', '/venues', { token: mgr.token, body: { name: `Fav Arena ${Math.random().toString(36).slice(2, 6)}`, timezone: 'UTC' } }), 201);
  must(await api('POST', `/venues/${v.id}/hours`, { token: mgr.token, body: { hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '06:00', closes: '22:00' })) } }));
  const court = must(await api('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'Court 1', hourly_rate_cents: 50000 } }), 201);
  return { v, court };
}
const book = (u, court, d, h1, h2) => api('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: court.id, starts_at: at(d, h1), ends_at: at(d, h2) }] } });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('favourites: save, list, flags on venue and search, soft un-save, new-offer news to fans', async () => {
  const mgr = await signup(['venue_manager']), fan = await signup(), quiet = await signup(), other = await signup();
  const { v } = await venue(mgr);
  assert.equal((await api('POST', `/venues/${v.id}/favourite`, { body: {} })).status, 401);
  must(await api('POST', `/venues/${v.id}/favourite`, { token: fan.token, body: {} }), 201);
  must(await api('POST', `/venues/${v.id}/favourite`, { token: quiet.token, body: { notify_offers: false } }), 201);
  assert.equal((await api('POST', '/venues/00000000-0000-0000-0000-000000000000/favourite', { token: fan.token, body: {} })).status, 404);

  const got = must(await api('GET', `/venues/${v.id}`, { token: fan.token }));
  assert.equal(got.is_favourite, true);
  assert.equal(got.favourites, 2);
  assert.equal(must(await api('GET', `/venues/${v.id}`, { token: other.token })).is_favourite, false);
  assert.equal(must(await api('GET', `/venues/${v.id}`)).is_favourite, false);
  assert.equal(must(await api('GET', '/venues', { token: fan.token, query: { q: v.name } }))[0].is_favourite, true);
  const mine = must(await api('GET', '/me/favourites', { token: fan.token }));
  assert.deepEqual(mine.map((x) => x.id), [v.id]);
  assert.equal(mine[0].min_hourly_rate_cents, 50000);

  // news: an open offer reaches fans who asked, a promo code does not
  must(await api('POST', `/venues/${v.id}/discounts`, { token: mgr.token, body: { name: 'Weekday mornings 20% off', kind: 'percent', value: 20 } }), 201);
  must(await api('POST', `/venues/${v.id}/discounts`, { token: mgr.token, body: { name: 'Secret', code: 'SECRET10', kind: 'percent', value: 10 } }), 201);
  assert.equal((await inbox(fan)).filter((x) => x.kind === 'new_offer').length, 1);
  assert.match((await inbox(fan)).find((x) => x.kind === 'new_offer').body, /Weekday mornings/);
  assert.equal((await inbox(quiet)).filter((x) => x.kind === 'new_offer').length, 0, 'opted out of offers');
  assert.equal((await inbox(other)).filter((x) => x.kind === 'new_offer').length, 0);

  // un-saving is soft and can be undone
  must(await api('DELETE', `/venues/${v.id}/favourite`, { token: fan.token }));
  assert.equal(must(await api('GET', '/me/favourites', { token: fan.token })).length, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM favourite_venues WHERE user_id=$1', [fan.id])).rows[0].n, 1, 'row kept');
  must(await api('POST', `/venues/${v.id}/favourite`, { token: fan.token, body: {} }), 201);
  assert.equal(must(await api('GET', '/me/favourites', { token: fan.token })).length, 1);
});

test('slot alerts: only when nothing matches now; fire on a cancellation inside the window; one-shot', async () => {
  const mgr = await signup(['venue_manager']), blocker = await signup(), watcher = await signup(), bystander = await signup();
  const { v, court } = await venue(mgr);
  // day +3 is completely sold out by `blocker` (16 hourly slots as two 8-slot bookings)
  const morning = must(await book(blocker, court, 3, 6, 14), 201);
  const evening = must(await book(blocker, court, 3, 14, 22), 201);
  const alert = (u, extra = {}) => api('POST', '/slot-alerts', { token: u.token, body: { venue_id: v.id, date_from: day(3), date_to: day(3), ...extra } });

  // validation
  assert.equal((await alert(watcher, { date_to: day(2) })).status, 400);
  assert.equal((await alert(watcher, { date_from: day(-3), date_to: day(-2) })).status, 400, 'past');
  assert.equal((await alert(watcher, { date_to: day(80) })).status, 400, 'more than 60 days');
  assert.equal((await alert(watcher, { from_time: '20:00', to_time: '18:00' })).status, 400);
  assert.equal((await alert(watcher, { resource_id: '00000000-0000-0000-0000-000000000000' })).status, 404);

  // free right now => no alert, you get the slot
  const now = must(await api('POST', '/slot-alerts', { token: watcher.token, body: { venue_id: v.id, date_from: day(4), date_to: day(4) } }), 201);
  assert.equal(now.created, false);
  assert.equal(now.available_now.date, day(4));

  // an evening-only alert and an any-time alert on the sold-out day
  const eve = must(await alert(watcher, { from_time: '18:00', to_time: '21:00', slots: 2 }), 201);
  assert.equal(eve.created, true);
  const any = must(await alert(bystander), 201);
  assert.equal(must(await api('GET', '/me/slot-alerts', { token: watcher.token })).length, 1);

  // a morning cancellation: the any-time alert fires, the evening-window one does not
  const m = morning.bookings[0];
  must(await api('DELETE', `/bookings/${m.id}`, { token: blocker.token }));
  await wait(async () => (await inbox(bystander)).some((x) => x.kind === 'slot_available'));
  const note = (await inbox(bystander)).find((x) => x.kind === 'slot_available');
  assert.equal(note.data.venue_id, v.id);
  assert.equal(note.data.date, day(3));
  assert.equal(note.data.resource_id, court.id);
  assert.equal((await inbox(watcher)).filter((x) => x.kind === 'slot_available').length, 0, 'wrong time of day');
  assert.equal((await pool.query('SELECT status FROM slot_alerts WHERE id=$1', [any.alert.id])).rows[0].status, 'fulfilled');
  assert.equal(must(await api('GET', '/me/slot-alerts', { token: bystander.token })).length, 0, 'done alerts are hidden by default');
  assert.equal(must(await api('GET', '/me/slot-alerts', { token: bystander.token, query: { include_done: 'true' } })).length, 1);

  // one-shot: another morning cancellation (none left) doesn't notify twice; the evening cancellation fires the evening alert
  must(await api('DELETE', `/bookings/${evening.bookings[0].id}`, { token: blocker.token }));
  await wait(async () => (await inbox(watcher)).some((x) => x.kind === 'slot_available'));
  const found = (await inbox(watcher)).find((x) => x.kind === 'slot_available');
  assert.equal(new Date(found.data.starts_at).getUTCHours(), 18, 'the earliest two-hour run inside 18:00–21:00');
  assert.equal((await inbox(bystander)).filter((x) => x.kind === 'slot_available').length, 1);
});

test('slot alerts: released blocks, weekday filter, cancel, expiry, limits, sweep by the worker', async () => {
  const mgr = await signup(['venue_manager']), u = await signup();
  const { v, court } = await venue(mgr);
  // the whole venue is blocked on day +5
  const blk = must(await api('POST', `/venues/${v.id}/blocks`, { token: mgr.token, body: { from_date: day(5), to_date: day(5), kind: 'maintenance' } }), 201);
  must(await api('POST', '/slot-alerts', { token: u.token, body: { venue_id: v.id, date_from: day(5), date_to: day(5) } }), 201);
  must(await api('DELETE', `/venues/${v.id}/blocks`, { token: mgr.token, query: { batch_id: blk.batch_id } }));
  await wait(async () => (await inbox(u)).some((x) => x.kind === 'slot_available'));

  // weekday filter: watch only a weekday that is not in the range
  const wd = new Date(`${day(7)}T00:00:00Z`).getUTCDay();
  const blk2 = must(await api('POST', `/venues/${v.id}/blocks`, { token: mgr.token, body: { from_date: day(7), to_date: day(8), kind: 'event' } }), 201);
  const other = (wd + 1) % 7;
  const w = must(await api('POST', '/slot-alerts', { token: u.token, body: { venue_id: v.id, date_from: day(7), date_to: day(8), weekdays: [wd] } }), 201);
  assert.deepEqual(w.alert.weekdays, [wd]);
  await pool.query('UPDATE venue_blocks SET released_at=now() WHERE batch_id=$1 AND starts_at::date=$2', [blk2.batch_id, day(8)]); // day 8 frees up but is the wrong weekday
  assert.equal(await checkSlotAlerts(), 0);
  void other;
  await pool.query('UPDATE venue_blocks SET released_at=now() WHERE batch_id=$1', [blk2.batch_id]);
  assert.equal(await checkSlotAlerts(), 1, 'the worker sweep also catches it');

  // cancel, expire, limit
  const blk3 = must(await api('POST', `/venues/${v.id}/blocks`, { token: mgr.token, body: { from_date: day(10), to_date: day(10), kind: 'other' } }), 201);
  const c = must(await api('POST', '/slot-alerts', { token: u.token, body: { venue_id: v.id, date_from: day(10), date_to: day(10) } }), 201);
  must(await api('DELETE', `/slot-alerts/${c.alert.id}`, { token: u.token }));
  assert.equal((await api('DELETE', `/slot-alerts/${c.alert.id}`, { token: u.token })).status, 404);
  assert.equal((await api('DELETE', `/slot-alerts/${c.alert.id}`, { token: (await signup()).token })).status, 404);
  await pool.query('UPDATE venue_blocks SET released_at=now() WHERE batch_id=$1', [blk3.batch_id]);
  assert.equal(await checkSlotAlerts(), 0, 'cancelled alerts never fire');
  must(await api('POST', `/venues/${v.id}/blocks`, { token: mgr.token, body: { from_date: day(12), to_date: day(40), kind: 'other' } }), 201);
  for (let i = 0; i < 20; i++) must(await api('POST', '/slot-alerts', { token: u.token, body: { venue_id: v.id, date_from: day(12 + (i % 20)), date_to: day(12 + (i % 20)) } }), 201);
  assert.equal((await api('POST', '/slot-alerts', { token: u.token, body: { venue_id: v.id, date_from: day(33), date_to: day(33) } })).status, 409, 'at most 20 active alerts');
  await pool.query("UPDATE slot_alerts SET date_from = date_from - 40, date_to = date_to - 40 WHERE user_id=$1 AND status='active'", [u.id]);
  await checkSlotAlerts();
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM slot_alerts WHERE user_id=$1 AND status='expired'", [u.id])).rows[0].n, 20, 'alerts for dates gone by expire');
  void court;
});
