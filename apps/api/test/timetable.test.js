import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// ---- stand-in for Stripe ----
const fake = { sessions: {}, refunds: [], n: 0 };
const provider = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.url === '/v1/checkout/sessions' && req.method === 'POST') {
    const f = new URLSearchParams(raw); const id = `cs_${++fake.n}`;
    fake.sessions[id] = { id, amount_total: Number(f.get('line_items[0][price_data][unit_amount]')), currency: f.get('line_items[0][price_data][currency]'), payment_status: 'unpaid', payment_intent: `pi_${fake.n}` };
    return send(200, { id, url: `https://checkout.stripe.test/${id}` });
  }
  if (req.url.startsWith('/v1/checkout/sessions/')) { const s = fake.sessions[req.url.split('/').pop()]; return s ? send(200, s) : send(404, { error: { message: 'no such session' } }); }
  if (req.url === '/v1/refunds') { const f = new URLSearchParams(raw); fake.refunds.push({ intent: f.get('payment_intent'), amount: Number(f.get('amount')) }); return send(200, { id: 're_1' }); }
  send(404, {});
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp',
  STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_API_BASE: `http://127.0.0.1:${provider.address().port}`, APP_URL: 'http://app.test', CORS_ORIGINS: 'http://app.test',
});
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { fromLocal, addDays } = await import('../src/booking/time.js');
const { processRefunds } = await import('../src/booking/refunds.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `tt_${n}_${roles[0]}`, display_name: `Owner ${n}`, email: `tt${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const today = new Date().toISOString().slice(0, 10);
const at = (d, h) => fromLocal(addDays(today, d), h * 60, 'UTC').toISOString();
const wait = async (fn, ms = 4000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 40)); } };

async function checkout(u, type, id) {
  const p = must(await api('POST', '/payments', { token: u.token, body: { purpose_type: type, purpose_id: id, provider: 'stripe', return_url: 'http://app.test/' } }), 201);
  Object.values(fake.sessions).at(-1).payment_status = 'paid';
  return { p, done: must(await api('POST', `/payments/${p.id}/confirm`, { token: u.token, body: {} })) };
}
async function venue(mgr, over = {}) {
  const v = must(await api('POST', '/venues', { token: mgr.token, body: { name: `Timetable Arena ${Math.random().toString(36).slice(2, 6)}`, timezone: 'UTC', currency: 'INR', payment_mode: 'online_optional', ...over } }), 201);
  const court = must(await api('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'Court 1', hourly_rate_cents: 100000 } }), 201);
  return { v, court };
}
const book = (u, court, d, h, len = 1) => api('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: court.id, starts_at: at(d, h), ends_at: at(d, h + len) }] } });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('tt_root','Root','{admin}','x','x','tt_adminidx') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
});
after(async () => { server.close(); provider.close(); await pool.end(); });



// a future date that falls on `weekday` (0 = Sunday), at least 3 days out
const onWeekday = (weekday) => { for (let d = 3; d < 12; d++) { const x = addDays(today, d); if (new Date(`${x}T12:00:00Z`).getUTCDay() === weekday) return x; } };
const avail = async (v, date, court) => must(await api('GET', `/venues/${v.id}/availability`, { query: { date, resource_id: court.id } })).resources[0].slots;
const hr = (s) => new Date(s.starts_at).getUTCHours();
const apply = (mgr, v, body) => api('POST', `/venues/${v.id}/timetable`, { token: mgr.token, body });
const court = async (mgr, v, name, rate = 100000) => must(await api('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: 'court', name, hourly_rate_cents: rate } }), 201);
const cat = async (mgr, v, name, rate) => must(await api('POST', `/venues/${v.id}/categories`, { token: mgr.token, body: { name, hourly_rate_cents: rate } }), 201);
const newVenue = async (mgr) => must(await api('POST', '/venues', { token: mgr.token, body: { name: `Timetable Arena ${Math.random().toString(36).slice(2, 6)}`, timezone: 'UTC', currency: 'INR', payment_mode: 'pay_at_venue' } }), 201);

test('timetable: bulk open courts under price categories, per-court rates, closed ranges, seasons', async () => {
  const mgr = await signup(['venue_manager']), rando = await signup(['venue_manager']);
  const v = await newVenue(mgr);
  const a = await court(mgr, v, 'Court A'), b = await court(mgr, v, 'Court B');
  const peak = await cat(mgr, v, 'Peak', 150000), off = await cat(mgr, v, 'Off-peak', 80000);
  assert.equal((await api('POST', `/venues/${v.id}/categories`, { token: mgr.token, body: { name: 'peak', hourly_rate_cents: 1 } })).status, 409, 'names are unique');
  assert.equal((await api('POST', `/venues/${v.id}/categories`, { token: rando.token, body: { name: 'X', hourly_rate_cents: 1 } })).status, 403);
  assert.equal((await apply(rando, v, { all_courts: true, weekdays: [1], start: '06:00', end: '10:00' })).status, 403);
  assert.equal((await apply(mgr, v, { weekdays: [1], start: '06:00', end: '10:00' })).status, 400, 'courts required');
  assert.equal((await apply(mgr, v, { all_courts: true, weekdays: [1], start: '10:00', end: '06:00' })).status, 400);

  // weekdays: off-peak until 17:00, peak 17-22; weekend all peak 08-20
  must(await apply(mgr, v, { all_courts: true, weekdays: [1, 2, 3, 4, 5], start: '06:00', end: '17:00', category_id: off.id }));
  must(await apply(mgr, v, { all_courts: true, weekdays: [1, 2, 3, 4, 5], start: '17:00', end: '22:00', category_id: peak.id }));
  must(await apply(mgr, v, { all_courts: true, weekdays: [0, 6], start: '08:00', end: '20:00', category_id: peak.id }));
  const mon = onWeekday(1), sat = onWeekday(6), sun = onWeekday(0);
  const m = await avail(v, mon, a);
  assert.deepEqual([hr(m[0]), hr(m.at(-1)), m.length], [6, 21, 16]);
  assert.equal(m.find((s) => hr(s) === 9).price_cents, 80000);
  assert.equal(m.find((s) => hr(s) === 9).category.name, 'Off-peak');
  assert.equal(m.find((s) => hr(s) === 18).price_cents, 150000);
  assert.deepEqual([(await avail(v, sat, a)).length, hr((await avail(v, sat, a))[0])], [12, 8]);
  const hours = must(await api('GET', `/venues/${v.id}`, { token: mgr.token })).hours;
  assert.deepEqual(hours.filter((h) => h.weekday === 1).map((h) => [h.opens_min, h.closes_min]), [[360, 1320]], "the venue's opening hours follow the timetable");

  // closed outside the timetable: booking 23:00 is refused, inside works at the category price
  const u = await signup();
  assert.equal((await api('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: a.id, starts_at: fromLocal(mon, 23 * 60, 'UTC').toISOString(), ends_at: fromLocal(mon, 24 * 60, 'UTC').toISOString() }] } })).status, 400);
  const ok = must(await api('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: a.id, starts_at: fromLocal(mon, 18 * 60, 'UTC').toISOString(), ends_at: fromLocal(mon, 19 * 60, 'UTC').toISOString() }] } }), 201);
  assert.equal(ok.payable_cents, 150000);

  // a court-specific rate inside a category; changing the category rate re-prices
  must(await api('POST', `/categories/${peak.id}/rates`, { token: mgr.token, body: { resource_id: b.id, hourly_rate_cents: 200000 } }));
  assert.equal((await avail(v, mon, b)).find((s) => hr(s) === 18).price_cents, 200000);
  assert.equal((await avail(v, mon, a)).find((s) => hr(s) === 18).price_cents, 150000);
  must(await api('POST', `/categories/${peak.id}/rates`, { token: mgr.token, body: { resource_id: b.id, hourly_rate_cents: null } }));
  must(await api('PATCH', `/categories/${off.id}`, { token: mgr.token, body: { hourly_rate_cents: 90000 } }));
  assert.equal((await avail(v, mon, b)).find((s) => hr(s) === 9).price_cents, 90000);
  assert.equal((await avail(v, mon, b)).find((s) => hr(s) === 18).price_cents, 150000);

  // closing a range carves the window; replace=false refuses to overlap
  must(await apply(mgr, v, { resource_ids: [a.id], weekdays: [1], start: '12:00', end: '14:00', closed: true }));
  const carved = await avail(v, mon, a);
  assert.equal(carved.some((s) => [12, 13].includes(hr(s))), false);
  assert.equal(carved.length, 14);
  assert.equal((await avail(v, mon, b)).length, 16, 'the other court is untouched');
  assert.equal((await apply(mgr, v, { resource_ids: [a.id], weekdays: [1], start: '09:00', end: '10:00', category_id: peak.id, replace: false })).status, 409);
  must(await apply(mgr, v, { resource_ids: [a.id], weekdays: [1], start: '09:00', end: '10:00', category_id: peak.id }));
  assert.equal((await avail(v, mon, a)).find((s) => hr(s) === 9).price_cents, 150000);
  assert.equal((await avail(v, mon, a)).find((s) => hr(s) === 10).price_cents, 90000 > 0 ? 90000 : 0, 'neighbours keep their category');

  // a season beats the everyday window, and an explicit special rate beats a category
  must(await apply(mgr, v, { resource_ids: [b.id], weekdays: [0, 1, 2, 3, 4, 5, 6], start: '06:00', end: '22:00', category_id: off.id, valid_from: sun, valid_to: sun }));
  assert.equal((await avail(v, sun, b)).find((s) => hr(s) === 9).price_cents, 90000, 'season price on that day only');
  assert.equal((await avail(v, sat, b)).find((s) => hr(s) === 9).price_cents, 150000);
  must(await api('POST', `/venues/${v.id}/price-rules`, { token: mgr.token, body: { name: 'Flash', resource_id: b.id, start: '18:00', end: '19:00', hourly_rate_cents: 5000 } }), 201);
  assert.equal((await avail(v, mon, b)).find((s) => hr(s) === 18).price_cents, 5000);

  const tt = must(await api('GET', `/venues/${v.id}/timetable`));
  assert.equal(tt.enabled, true);
  assert.equal(tt.courts.length, 2);
  assert.ok(tt.courts[0].windows.length > 2);
});

test('timetable: existing opening hours carry over; new courts inherit; bulk create/update/copy; setup checklist', async () => {
  const mgr = await signup(['venue_manager']);
  const v = await newVenue(mgr);
  const a = await court(mgr, v, 'Hall A');
  must(await api('POST', `/venues/${v.id}/hours`, { token: mgr.token, body: { hours: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, opens: '09:00', closes: '18:00' })) } }));
  const before = must(await api('GET', `/venues/${v.id}/setup`, { token: mgr.token }));
  assert.equal(before.ready, false);
  assert.equal(before.steps.find((s) => s.key === 'courts').done, true);
  assert.equal(before.steps.find((s) => s.key === 'timetable').done, false);
  const mon = onWeekday(1), sun = onWeekday(0);
  assert.equal((await avail(v, mon, a)).length, 9);

  // first use of the timetable keeps the old hours on every court; only the targeted court changes
  const b = await court(mgr, v, 'Hall B');
  const peak = await cat(mgr, v, 'Peak', 150000);
  assert.equal((await avail(v, mon, b)).length, 9, 'a court added before the timetable follows the venue hours');
  must(await apply(mgr, v, { resource_ids: [a.id], weekdays: [0], start: '10:00', end: '14:00', category_id: peak.id }));
  assert.equal((await avail(v, mon, a)).length, 9, 'weekday hours kept');
  assert.equal((await avail(v, mon, b)).length, 9);
  assert.equal((await avail(v, sun, a)).length, 4, 'Sunday opened on Hall A');
  assert.equal((await avail(v, sun, b)).length, 0, 'but not on Hall B');

  // bulk create: numbered names, inherited timetable, duplicates refused
  const made = must(await api('POST', `/venues/${v.id}/resources/bulk`, { token: mgr.token, body: { kind: 'court', name_prefix: 'Net', count: 3, hourly_rate_cents: 100000, slot_minutes: 30 } }), 201).created;
  assert.deepEqual(made.map((x) => x.name), ['Net 1', 'Net 2', 'Net 3']);
  assert.equal((await avail(v, mon, made[0])).length, 18, 'inherited a sibling timetable, in 30-minute slots');
  assert.equal((await api('POST', `/venues/${v.id}/resources/bulk`, { token: mgr.token, body: { kind: 'court', name_prefix: 'Net', count: 2 } })).status, 409);
  const rando = await signup(['venue_manager']);
  assert.equal((await api('POST', `/venues/${v.id}/resources/bulk`, { token: rando.token, body: { kind: 'court', name_prefix: 'Z', count: 1 } })).status, 403);

  // bulk update
  must(await api('PATCH', `/venues/${v.id}/resources`, { token: mgr.token, body: { resource_ids: made.map((x) => x.id), slot_minutes: 60, max_slots: 4 } }));
  assert.equal((await avail(v, mon, made[1])).length, 9);
  assert.equal((await api('PATCH', `/venues/${v.id}/resources`, { token: mgr.token, body: { resource_ids: [a.id], min_slots: 6, max_slots: 2 } })).status, 400);

  // copy
  assert.equal((await api('POST', `/venues/${v.id}/timetable/copy`, { token: mgr.token, body: { from_resource_id: b.id, to_resource_ids: [a.id] } })).status, 200);
  assert.equal((await avail(v, sun, a)).length, 0, 'Hall A now has exactly what Hall B had');

  // checklist
  const s = must(await api('GET', `/venues/${v.id}/setup`, { token: mgr.token }));
  assert.equal(s.steps.find((x) => x.key === 'timetable').done, true);
  assert.equal(s.steps.find((x) => x.key === 'pricing').done, true);
  assert.equal(s.ready, false, 'still needs invoice details and a contact');
  assert.equal((await api('GET', `/venues/${v.id}/setup`, { token: rando.token })).status, 403);
});
