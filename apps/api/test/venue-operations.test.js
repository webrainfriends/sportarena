import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp', APP_URL: 'http://app.test', CORS_ORIGINS: 'http://app.test' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { fromLocal, addDays } = await import('../src/booking/time.js');
const { raiseSubscriptionRenewals } = await import('../src/booking/plans.js');
const { venueOpsReminders } = await import('../src/booking/venue-ops.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `vo_${n}_${roles[0]}`, display_name: `Ops ${n}`, email: `vo${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const today = new Date().toISOString().slice(0, 10);
const at = (d, h) => fromLocal(addDays(today, d), h * 60, 'UTC').toISOString();
async function venue(mgr, courts = 1, over = {}) {
  const v = must(await api('POST', '/venues', { token: mgr.token, body: { name: `Ops Arena ${Math.random().toString(36).slice(2, 6)}`, timezone: 'UTC', currency: 'INR', ...over } }), 201);
  const cs = [];
  for (let k = 1; k <= courts; k++) cs.push(must(await api('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: 'court', name: `Court ${k}`, hourly_rate_cents: 100000 } }), 201));
  return { v, court: cs[0], cs };
}
const book = (u, court, d, h, len = 1) => api('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: court.id, starts_at: at(d, h), ends_at: at(d, h + len) }] } });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('map identifiers: place id and share link feed the map links', async () => {
  const mgr = await signup(['venue_manager']);
  const { v } = await venue(mgr, 1, { latitude: 12.97, longitude: 77.59 });
  assert.equal((await api('PATCH', `/venues/${v.id}`, { token: mgr.token, body: { map_url: 'http://insecure.example/x' } })).status, 400, 'https only');
  assert.equal((await api('PATCH', `/venues/${v.id}`, { token: mgr.token, body: { place_id: 'bad id!' } })).status, 400);
  must(await api('PATCH', `/venues/${v.id}`, { token: mgr.token, body: { place_id: 'ChIJabc-123_x', map_url: 'https://maps.app.goo.gl/abc', amenities: ['Parking', 'Lockers'], amenity_details: { Parking: { note: '40 bays, rear gate', fee_cents: 5000 }, Lockers: { note: 'Bring a padlock' } } } }));
  const got = must(await api('GET', `/venues/${v.id}`));
  assert.match(got.map_links.google, /query_place_id=ChIJabc-123_x/);
  assert.match(got.map_links.directions, /destination_place_id=ChIJabc-123_x/);
  assert.equal(got.map_links.shared, 'https://maps.app.goo.gl/abc');
  assert.equal(got.amenity_details.Parking.fee_cents, 5000);
});

test('courts: retire, see retired ones, bring them back', async () => {
  const mgr = await signup(['venue_manager']), other = await signup(['venue_manager']);
  const { v, cs } = await venue(mgr, 2);
  must(await api('PATCH', `/resources/${cs[1].id}`, { token: mgr.token, body: { active: false } }));
  assert.equal(must(await api('GET', `/venues/${v.id}`)).resources.length, 1, 'customers no longer see it');
  assert.equal((await api('GET', `/venues/${v.id}/courts`, { token: other.token })).status, 403);
  const all = must(await api('GET', `/venues/${v.id}/courts`, { token: mgr.token }));
  assert.equal(all.length, 2);
  assert.equal(all.find((c) => c.id === cs[1].id).active, false);
  must(await api('PATCH', `/resources/${cs[1].id}`, { token: mgr.token, body: { active: true } }));
  assert.equal(must(await api('GET', `/venues/${v.id}`)).resources.length, 2);
});

test('lockers: create, assign with a PIN the booker sees, never in notifications, regenerate, share, release', async () => {
  const mgr = await signup(['venue_manager']), rando = await signup(['venue_manager']), u = await signup(), stranger = await signup();
  const { v, court, cs } = await venue(mgr, 3);
  assert.equal((await api('POST', `/venues/${v.id}/lockers`, { token: rando.token, body: { prefix: 'A', count: 3 } })).status, 403);
  assert.equal((await api('POST', `/venues/${v.id}/lockers`, { token: mgr.token, body: {} })).status, 400);
  const made = must(await api('POST', `/venues/${v.id}/lockers`, { token: mgr.token, body: { prefix: 'A', count: 2, zone: 'Pool deck', size: 'small' } }), 201);
  assert.deepEqual(made.created.map((l) => l.label), ['A1', 'A2']);
  const again = must(await api('POST', `/venues/${v.id}/lockers`, { token: mgr.token, body: { labels: ['A2', 'B1'] } }), 201);
  assert.equal(again.skipped, 1);

  const r = must(await book(u, court, 3, 10), 201);
  assert.deepEqual(r.lockers, [], 'no locker until one is assigned');
  assert.equal((await api('POST', `/reservations/${r.id}/locker`, { token: u.token, body: {} })).status, 404, 'the booker cannot hand out lockers');
  const a = must(await api('POST', `/reservations/${r.id}/locker`, { token: mgr.token, body: { size: 'small', digits: 6 } }), 201);
  assert.equal(a.label, 'A1');
  assert.match(a.pin, /^\d{6}$/);
  assert.notEqual(a.pin, '123456');
  assert.equal((await api('POST', `/reservations/${r.id}/locker`, { token: mgr.token, body: {} })).status, 409, 'one locker per booking per venue');

  // the appointment details carry the PIN for the booker and the team, nobody else
  const seen = must(await api('GET', `/reservations/${r.id}`, { token: u.token }));
  assert.equal(seen.lockers[0].pin, a.pin);
  assert.equal(seen.lockers[0].label, 'A1');
  assert.equal(must(await api('GET', `/reservations/${r.id}`, { token: mgr.token })).lockers[0].pin, a.pin);
  assert.equal((await api('GET', `/reservations/${r.id}`, { token: stranger.token })).status, 403);
  assert.equal((await pool.query("SELECT 1 FROM audit_log WHERE action='read_locker_pin'")).rowCount > 0, true, 'staff reads of a PIN are audit-logged');
  assert.equal((await pool.query('SELECT pin_enc FROM locker_assignments WHERE id=$1', [a.id])).rows[0].pin_enc.includes(a.pin), false, 'encrypted at rest');
  // notifications point at the booking, they never contain the PIN
  const inbox = must(await api('GET', '/notifications', { token: u.token }));
  const note = (inbox.items ?? inbox.notifications ?? inbox).find((x) => x.kind === 'locker_assigned');
  assert.ok(note, 'booker was told a locker is ready');
  assert.equal(JSON.stringify(note).includes(a.pin), false);

  // front desk list, share text, new PIN
  const desk = must(await api('GET', `/venues/${v.id}/locker-assignments`, { token: mgr.token }));
  assert.equal(desk[0].pin, a.pin);
  assert.equal(desk[0].code, r.code);
  assert.equal((await api('GET', `/venues/${v.id}/locker-assignments`, { token: u.token })).status, 403);
  const shared = must(await api('POST', `/locker-assignments/${a.id}/share`, { token: u.token, body: {} }));
  assert.match(shared.message, new RegExp(`PIN ${a.pin}`));
  assert.equal((await api('POST', `/locker-assignments/${a.id}/share`, { token: stranger.token, body: {} })).status, 404);
  const fresh = must(await api('POST', `/locker-assignments/${a.id}/pin`, { token: mgr.token, body: {} }));
  assert.equal(fresh.pin_version, 2);
  assert.equal((await api('POST', `/locker-assignments/${a.id}/pin`, { token: u.token, body: {} })).status, 404);
  assert.equal(must(await api('GET', `/reservations/${r.id}`, { token: u.token })).lockers[0].pin, fresh.pin);

  // the locker is busy for that time, retire is refused while held
  const lockers = must(await api('GET', `/venues/${v.id}/lockers`, { token: mgr.token }));
  assert.equal(lockers.find((l) => l.label === 'A1').upcoming, 1);
  assert.equal((await api('PATCH', `/lockers/${a.locker_id}`, { token: mgr.token, body: { active: false } })).status, 409);
  const r2 = must(await book(stranger, cs[1], 3, 10), 201);
  assert.equal(must(await api('POST', `/reservations/${r2.id}/locker`, { token: mgr.token, body: {} }), 201).label, 'A2', 'next free locker, never the one in use');
  const r3 = must(await book(await signup(), cs[2], 3, 10), 201);
  assert.equal((await api('POST', `/reservations/${r3.id}/locker`, { token: mgr.token, body: { size: 'small' } })).status, 409, 'none free');

  must(await api('DELETE', `/locker-assignments/${a.id}`, { token: mgr.token }));
  assert.deepEqual(must(await api('GET', `/reservations/${r.id}`, { token: u.token })).lockers, []);
  must(await api('PATCH', `/lockers/${a.locker_id}`, { token: mgr.token, body: { active: false } }));
  assert.equal(must(await api('GET', `/venues/${v.id}/lockers`, { token: mgr.token })).length, 2, 'retired are hidden');
  assert.equal(must(await api('GET', `/venues/${v.id}/lockers`, { token: mgr.token, query: { include_retired: 'true' } })).length, 3);
});

test('lockers follow the booking: auto-assign, move, cancel', async () => {
  const mgr = await signup(['venue_manager']), u = await signup();
  const { v, court } = await venue(mgr, 1, { locker_auto_assign: true });
  must(await api('POST', `/venues/${v.id}/lockers`, { token: mgr.token, body: { prefix: 'L', count: 1 } }), 201);
  const r = must(await book(u, court, 4, 10, 2), 201);
  assert.equal(r.lockers.length, 1, 'given automatically at booking');
  assert.ok(/^\d{4}$/.test(r.lockers[0].pin));
  // moving the booking moves the locker window; same PIN while the locker is free
  const lineId = r.bookings[0].id;
  must(await api('PATCH', `/bookings/${lineId}`, { token: u.token, body: { starts_at: at(4, 14), ends_at: at(4, 15) } }));
  const moved = must(await api('GET', `/reservations/${r.id}`, { token: u.token })).lockers[0];
  assert.equal(moved.pin, r.lockers[0].pin);
  assert.equal(new Date(moved.starts_at).toISOString(), new Date(new Date(at(4, 14)).getTime() - 30 * 60_000).toISOString());
  // cancelling frees it
  must(await api('DELETE', `/reservations/${r.id}`, { token: u.token }));
  assert.deepEqual(must(await api('GET', `/reservations/${r.id}`, { token: u.token })).lockers, []);
  const u2 = await signup();
  assert.equal(must(await book(u2, court, 4, 14), 201).lockers.length, 1, 'the freed locker is available again');
});

test('maintenance: close a court, conflicts, finish reopens it and raises the repeat', async () => {
  const mgr = await signup(['venue_manager']), rando = await signup(['venue_manager']), u = await signup();
  const { v, court } = await venue(mgr);
  const vendor = must(await api('POST', `/venues/${v.id}/vendors`, { token: mgr.token, body: { kind: 'maintenance', name: 'Turf Care Co', categories: ['surface'], contact_name: 'Asha', phone: '+91 98000 00000', email: 'asha@turf.example', emergency_24x7: true } }), 201);
  assert.equal((await api('POST', `/venues/${v.id}/maintenance`, { token: rando.token, body: { title: 'Resurface' } })).status, 403);
  assert.equal((await api('POST', `/venues/${v.id}/maintenance`, { token: mgr.token, body: { title: 'Resurface', vendor_id: '00000000-0000-4000-8000-000000000000' } })).status, 400);
  const booked = must(await book(u, court, 6, 10), 201);
  const close = { from_date: addDays(today, 6), to_date: addDays(today, 7) };
  const blocked = await api('POST', `/venues/${v.id}/maintenance`, { token: mgr.token, body: { title: 'Resurface', resource_id: court.id, category: 'surface', priority: 'high', due_on: addDays(today, 6), vendor_id: vendor.id, estimated_cost_cents: 500000, repeat_every_days: 180, close } });
  assert.equal(blocked.status, 409, 'a booking is in the way');
  assert.equal((await pool.query('SELECT 1 FROM venue_maintenance')).rowCount, 0, 'nothing logged when the court could not be closed');
  const m = must(await api('POST', `/venues/${v.id}/maintenance`, { token: mgr.token, body: { title: 'Resurface', resource_id: court.id, category: 'surface', priority: 'high', due_on: addDays(today, 6), vendor_id: vendor.id, estimated_cost_cents: 500000, repeat_every_days: 180, close: { ...close, cancel_conflicting: true } } }), 201);
  assert.ok(m.block_batch_id);
  assert.equal(must(await api('GET', `/reservations/${booked.id}`, { token: u.token })).bookings[0].status, 'cancelled');
  assert.equal((await book(u, court, 6, 12)).status, 409, 'the court is closed');
  const list = must(await api('GET', `/venues/${v.id}/maintenance`, { token: mgr.token }));
  assert.equal(list.totals.open, 1);
  assert.equal(list.items[0].court, 'Court 1');
  assert.equal(list.items[0].vendor_name, 'Turf Care Co');
  must(await api('PATCH', `/maintenance/${m.id}`, { token: mgr.token, body: { status: 'in_progress' } }));
  const done = must(await api('PATCH', `/maintenance/${m.id}`, { token: mgr.token, body: { status: 'done', actual_cost_cents: 450000 } }));
  assert.ok(done.completed_at);
  assert.ok(done.next_job, 'the repeat was raised');
  assert.equal(must(await book(u, court, 6, 12), 201).bookings.length, 1, 'finishing reopened the court');
  assert.equal((await api('PATCH', `/maintenance/${m.id}`, { token: mgr.token, body: { status: 'scheduled' } })).status, 409, 'finished jobs stay finished');
  const after = must(await api('GET', `/venues/${v.id}/maintenance`, { token: mgr.token, query: { status: 'all' } }));
  assert.equal(after.totals.open, 1);
  assert.equal(Number(after.totals.cost_this_year_cents), 450000);
});

test('vendors: contacts are encrypted, listing is audit-logged, archive instead of delete', async () => {
  const mgr = await signup(['venue_manager']), rando = await signup(['venue_manager']);
  const { v } = await venue(mgr);
  const s = must(await api('POST', `/venues/${v.id}/vendors`, { token: mgr.token, body: { kind: 'supplier', name: 'Shuttle World', categories: ['shuttlecocks', 'nets'], contact_name: 'Ravi', phone: '+91 91234 56789', lead_time_days: 5, payment_terms: 'Net 30' } }), 201);
  assert.equal(s.contact_name, 'Ravi');
  const raw = (await pool.query('SELECT contact_name_enc, phone_enc FROM venue_vendors WHERE id=$1', [s.id])).rows[0];
  assert.ok(raw.phone_enc && !raw.phone_enc.includes('91234'), 'phone is encrypted');
  assert.equal((await api('GET', `/venues/${v.id}/vendors`, { token: rando.token })).status, 403);
  const list = must(await api('GET', `/venues/${v.id}/vendors`, { token: mgr.token }));
  assert.equal(list[0].phone, '+91 91234 56789');
  assert.equal((await pool.query("SELECT 1 FROM audit_log WHERE action='read_pii' AND entity='venue_vendors'")).rowCount > 0, true);
  must(await api('PATCH', `/vendors/${s.id}`, { token: mgr.token, body: { phone: '+91 90000 00000', rating: 4 } }));
  assert.equal(must(await api('GET', `/venues/${v.id}/vendors`, { token: mgr.token }))[0].phone, '+91 90000 00000');
  must(await api('PATCH', `/vendors/${s.id}`, { token: mgr.token, body: { status: 'archived' } }));
  assert.equal(must(await api('GET', `/venues/${v.id}/vendors`, { token: mgr.token })).length, 0);
  assert.equal(must(await api('GET', `/venues/${v.id}/vendors`, { token: mgr.token, query: { include_archived: 'true' } })).length, 1);
  assert.equal((await pool.query('SELECT 1 FROM venue_vendors WHERE id=$1', [s.id])).rowCount, 1, 'never deleted');
});

test('contracts: term, document link from this venue only, ending reminder once, lapse', async () => {
  const mgr = await signup(['venue_manager']), rando = await signup(['venue_manager']);
  const { v } = await venue(mgr), { v: other } = await venue(rando);
  const vendor = must(await api('POST', `/venues/${v.id}/vendors`, { token: mgr.token, body: { kind: 'maintenance', name: 'Floodlight Fixers' } }), 201);
  const doc = (await pool.query("INSERT INTO subject_documents(subject_type, subject_id, kind, title, file_name, uploaded_by) VALUES ('venue',$1,'contract','Signed AMC','f.pdf',$2) RETURNING id", [v.id, mgr.id])).rows[0];
  const foreign = (await pool.query("INSERT INTO subject_documents(subject_type, subject_id, kind, title, file_name, uploaded_by) VALUES ('venue',$1,'contract','Theirs','f.pdf',$2) RETURNING id", [other.id, rando.id])).rows[0];
  const body = { kind: 'maintenance', title: 'Floodlight AMC', vendor_id: vendor.id, starts_on: addDays(today, -300), ends_on: addDays(today, 20), notice_days: 30, value_cents: 12000000, document_id: doc.id };
  assert.equal((await api('POST', `/venues/${v.id}/contracts`, { token: rando.token, body })).status, 403);
  assert.equal((await api('POST', `/venues/${v.id}/contracts`, { token: mgr.token, body: { ...body, document_id: foreign.id } })).status, 400, 'a file from another venue');
  assert.equal((await api('POST', `/venues/${v.id}/contracts`, { token: mgr.token, body: { ...body, ends_on: addDays(today, -400) } })).status, 400, 'ends before it starts');
  const k = must(await api('POST', `/venues/${v.id}/contracts`, { token: mgr.token, body }), 201);
  const listed = must(await api('GET', `/venues/${v.id}/contracts`, { token: mgr.token }));
  assert.equal(listed[0].vendor_name, 'Floodlight Fixers');
  assert.equal(listed[0].document_title, 'Signed AMC');
  assert.equal(listed[0].ending_soon, true);
  assert.equal(await venueOpsReminders(), 1);
  assert.equal(await venueOpsReminders(), 0, 'reminded once');
  const note = (await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='contract_ending'", [mgr.id])).rowCount;
  assert.equal(note, 1);
  // extending re-arms the reminder
  must(await api('PATCH', `/contracts/${k.id}`, { token: mgr.token, body: { ends_on: addDays(today, 25) } }));
  assert.equal((await pool.query('SELECT reminded_at FROM venue_contracts WHERE id=$1', [k.id])).rows[0].reminded_at, null);
  await pool.query("UPDATE venue_contracts SET ends_on = current_date - 1 WHERE id=$1", [k.id]);
  await venueOpsReminders();
  assert.equal((await pool.query('SELECT status FROM venue_contracts WHERE id=$1', [k.id])).rows[0].status, 'ended');
});

test('overview: counts what needs a decision and surfaces venue insurance', async () => {
  const mgr = await signup(['venue_manager']), rando = await signup(['venue_manager']);
  const { v } = await venue(mgr);
  assert.equal((await api('GET', `/venues/${v.id}/operations`, { token: rando.token })).status, 403);
  let o = must(await api('GET', `/venues/${v.id}/operations`, { token: mgr.token }));
  assert.ok(o.attention.some((a) => a.key === 'no_insurance'));
  must(await api('POST', `/venues/${v.id}/maintenance`, { token: mgr.token, body: { title: 'Fix net', priority: 'urgent', due_on: addDays(today, -2) } }), 201);
  const c = await pool.connect(); // the policy's plan lives in the insurer's catalogue; this test only needs the venue's row
  try {
    await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'");
    await c.query("INSERT INTO insurance_policies(plan_id, holder_id, subject_type, subject_id, policy_no_enc, status, starts_on, ends_on) VALUES (gen_random_uuid(), $2, 'venue', $1, 'x', 'active', current_date - 300, current_date + 20)", [v.id, mgr.id]);
    await c.query('COMMIT');
  } finally { c.release(); }
  o = must(await api('GET', `/venues/${v.id}/operations`, { token: mgr.token }));
  assert.equal(o.maintenance.overdue, 1);
  assert.equal(o.maintenance.urgent, 1);
  assert.equal(o.courts.live, 1);
  assert.ok(o.attention.some((a) => a.key === 'maintenance_overdue'));
  assert.ok(o.attention.some((a) => a.key === 'insurance_expiring'));
  assert.equal(o.attention.some((a) => a.key === 'no_insurance'), false);
  assert.equal(o.insurance.policies.length, 1);
});

test('packages: a pass limited to chosen courts; subscriptions renew', async () => {
  const mgr = await signup(['venue_manager']), u = await signup();
  const { v, cs } = await venue(mgr, 2);
  const mk = (body) => api('POST', `/venues/${v.id}/plans`, { token: mgr.token, body });
  assert.equal((await mk({ kind: 'membership', name: 'Gold', price_cents: 1000, duration_days: 30, discount_bp: 1000, resource_ids: [cs[0].id] })).status, 400, 'only passes can be limited to courts');
  assert.equal((await mk({ kind: 'pass', name: 'Bad', price_cents: 1000, sessions: 2, valid_days: 30, auto_renew: true })).status, 400, 'only memberships renew');
  const { v: foreignV, cs: foreign } = await venue(await signup(['venue_manager']), 1);
  assert.equal((await mk({ kind: 'pass', name: 'Foreign', price_cents: 1000, sessions: 2, valid_days: 30, resource_ids: [foreign[0].id] })).status, 400, 'courts of another venue');
  const pkg = must(await mk({ kind: 'pass', name: 'Court 1 pack', price_cents: 200000, sessions: 2, valid_days: 30, resource_ids: [cs[0].id], includes: ['Locker', 'Towel'] }), 201);
  assert.deepEqual(pkg.includes, ['Locker', 'Towel']);
  const up = must(await api('POST', `/venue-plans/${pkg.id}/buy`, { token: u.token }), 201);
  await pool.query("UPDATE user_plans SET status='active', starts_at=now(), expires_at=now()+interval '30 days' WHERE id=$1", [up.id]);
  assert.deepEqual((await api('GET', '/me/plans', { token: u.token })).body[0].resource_ids, [cs[0].id]);
  const wrong = must(await book(u, cs[1], 8, 10), 201);
  assert.equal((await api('POST', `/invoices/${wrong.invoices[0].id}/pass`, { token: u.token, body: {} })).status, 409, 'not valid on Court 2');
  const right = must(await book(u, cs[0], 8, 12), 201);
  const used = must(await api('POST', `/invoices/${right.invoices[0].id}/pass`, { token: u.token, body: {} }));
  assert.equal(used.sessions_used, 1);

  // subscription: renewal is raised once, a week before the end, waiting for payment
  const sub = must(await mk({ kind: 'membership', name: 'Monthly', price_cents: 50000, duration_days: 30, discount_bp: 1000, auto_renew: true }), 201);
  assert.equal(sub.auto_renew, true);
  const s1 = must(await api('POST', `/venue-plans/${sub.id}/buy`, { token: u.token }), 201);
  await pool.query("UPDATE user_plans SET status='active', starts_at=now()-interval '25 days', expires_at=now()+interval '5 days' WHERE id=$1", [s1.id]);
  assert.equal(await raiseSubscriptionRenewals(), 1);
  assert.equal(await raiseSubscriptionRenewals(), 0, 'only once');
  const next = (await pool.query("SELECT status, renews_id, auto_renew FROM user_plans WHERE renews_id=$1", [s1.id])).rows[0];
  assert.deepEqual(next, { status: 'awaiting_payment', renews_id: s1.id, auto_renew: true });
  assert.equal((await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='plan_renewal'", [u.id])).rowCount, 1);
  // a plan the venue stopped selling is not renewed
  must(await api('PATCH', `/venue-plans/${sub.id}`, { token: mgr.token, body: { auto_renew: false, active: false } }));
  assert.equal(must(await api('GET', `/venues/${v.id}/plans`, { token: mgr.token })).some((p) => p.id === sub.id), false);
  void foreignV;
});
