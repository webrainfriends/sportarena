import http from 'node:http';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp', APP_URL: 'http://app.test', CORS_ORIGINS: 'http://app.test' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { fromLocal, addDays } = await import('../src/booking/time.js');
const { raisePreventiveWork } = await import('../src/booking/venue-ops.js');
const { READINESS } = await import('../src/capabilities/venue-facility.js');
const { syncMembershipGrants } = await import('../src/access-layer.js');
const { sweepAccessGrants } = await import('../src/access-grants.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `vf_${n}_${roles[0]}`, display_name: `Fac ${n}`, email: `vf${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const today = new Date().toISOString().slice(0, 10);
const iso = (offsetMin) => new Date(Date.now() + offsetMin * 60_000).toISOString();
async function venue(mgr, over = {}) {
  const v = must(await api('POST', '/venues', { token: mgr.token, body: { name: `Fac Arena ${Math.random().toString(36).slice(2, 6)}`, timezone: 'UTC', currency: 'INR', ...over } }), 201);
  const court = must(await api('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'Court 1', hourly_rate_cents: 100000 } }), 201);
  return { v, court };
}
const addStaff = async (mgr, v, who, role, duty = 'general') => must(await api('POST', `/venues/${v.id}/staff`, { token: mgr.token, body: { handle: who.handle, role, duty } }), 201);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('booking series: held through the engine, overlaps skipped, ended as one', async () => {
  const mgr = await signup(['venue_manager']), other = await signup();
  const { v, court } = await venue(mgr);
  const body = { resource_id: court.id, title: 'League night', start: '18:00', end: '19:00', starts_on: addDays(today, 2), count: 4, weekdays: [0, 1, 2, 3, 4, 5, 6] };
  assert.equal((await api('POST', `/venues/${v.id}/booking-series`, { token: other.token, body })).status, 403);
  const s = must(await api('POST', `/venues/${v.id}/booking-series`, { token: mgr.token, body }), 201);
  assert.equal(s.held, 4);
  assert.equal((await pool.query('SELECT coalesce(sum(payable_cents),0)::int AS n FROM bookings WHERE series_id=$1', [s.id])).rows[0].n, 0, 'the venue\'s own hold is not a receivable');
  const clash = await api('POST', `/venues/${v.id}/booking-series`, { token: mgr.token, body: { ...body, title: 'Clash', on_conflict: 'fail' } });
  assert.equal(clash.status, 409, 'the same slots cannot be held twice');
  const list = must(await api('GET', `/venues/${v.id}/booking-series`, { token: mgr.token }));
  assert.equal(list[0].upcoming, 4);
  const done = must(await api('POST', `/venue-booking-series/${s.id}/cancel`, { token: mgr.token, body: {} }));
  assert.equal(done.released, 4);
  assert.equal((await api('POST', `/venue-booking-series/${s.id}/cancel`, { token: mgr.token, body: {} })).status, 409);
  const left = (await pool.query("SELECT count(*)::int AS n, count(*) FILTER (WHERE status='cancelled')::int AS c FROM bookings WHERE series_id=$1", [s.id])).rows[0];
  assert.deepEqual(left, { n: 4, c: 4 }, 'rows kept, marked cancelled');
});

test('roles: floor staff work the day but cannot manage', async () => {
  const mgr = await signup(['venue_manager']), floor = await signup(), outsider = await signup();
  const { v, court } = await venue(mgr);
  await addStaff(mgr, v, floor, 'staff', 'reception');
  const me = must(await api('GET', `/venues/${v.id}/me`, { token: floor.token }));
  assert.equal(me.level, 'staff'); assert.equal(me.duty, 'reception'); assert.equal(me.can.manage_series, false);
  assert.equal((await api('GET', `/venues/${v.id}/me`, { token: outsider.token })).status, 403);
  assert.equal((await api('POST', `/venues/${v.id}/pm-templates`, { token: floor.token, body: { title: 'x1', every_days: 7, first_due_on: today } })).status, 403);
  assert.equal((await api('POST', `/venues/${v.id}/booking-series`, { token: floor.token, body: { resource_id: court.id, title: 'No', start: '10:00', end: '11:00', starts_on: addDays(today, 3), count: 1 } })).status, 403);
  assert.equal((await api('GET', `/venues/${v.id}/income`, { token: floor.token, query: { from: today, to: today } })).status, 403);
  assert.equal((await api('GET', `/venues/${v.id}/readiness`, { token: floor.token })).status, 200);
  const staff = must(await api('GET', `/venues/${v.id}/staff`, { token: mgr.token }));
  assert.equal(staff.find((s) => s.id === floor.id).duty, 'reception');
});

test('check-in is the existing access layer: plan entitlements decide who a member may enter', async () => {
  const mgr = await signup(['venue_manager']), member = await signup();
  const { v } = await venue(mgr);
  const dow = new Date().getUTCDay();
  const plan = must(await api('POST', `/venues/${v.id}/plans`, { token: mgr.token, body: { kind: 'membership', name: 'Weekday', price_cents: 100000, duration_days: 30, discount_bp: 1000, entitlements: { days: [dow] } } }), 201);
  assert.deepEqual(plan.entitlements.days, [dow]);
  assert.equal((await api('POST', `/venues/${v.id}/check-ins`, { token: mgr.token, body: { user_id: member.id } })).status, 404, 'no second check-in capability');
  const point = must(await api('POST', '/access/points', { token: mgr.token, body: { venue_id: v.id, name: 'Front door', kind: 'turnstile', provider: 'manual' } }), 201);
  await pool.query("INSERT INTO user_plans(plan_id, venue_id, user_id, kind, name, status, price_cents, currency, discount_bp, duration_days, starts_at, expires_at) SELECT id, venue_id, $2, kind, name, 'active', price_cents, 'INR', discount_bp, 30, now(), now() + interval '30 days' FROM venue_plans WHERE id=$1", [plan.id, member.id]);
  const enter = () => api('POST', '/access/captures', { token: mgr.token, body: { idempotency_key: `k${Math.random()}`, domain: 'venue_access', subject_ref: point.id, method: 'manual', user_id: member.id, reason_code: 'forgot_credential' } });
  assert.equal(must(await enter(), 201).capture.verdict, 'granted', 'today is covered');
  must(await api('PATCH', `/venue-plans/${plan.id}`, { token: mgr.token, body: { entitlements: { days: [(dow + 1) % 7] } } }));
  const denied = must(await enter(), 201).capture;
  assert.equal(denied.verdict, 'denied'); assert.equal(denied.reason_code, 'membership_not_covered');
  must(await api('PATCH', `/venue-plans/${plan.id}`, { token: mgr.token, body: { entitlements: { days: [] } } }));
  assert.equal(must(await enter(), 201).capture.verdict, 'granted', 'no restriction = every day, as before');
  const net = must(await api('GET', '/venue-network', { token: mgr.token }));
  assert.equal(net.venues[0].check_ins.today, 2); assert.equal(net.venues[0].check_ins.denied, 1);
});

test('assets, work orders and preventive maintenance', async () => {
  const mgr = await signup(['venue_manager']), tech = await signup();
  const { v, court } = await venue(mgr);
  await addStaff(mgr, v, tech, 'staff', 'maintenance');
  const a = must(await api('POST', `/venues/${v.id}/assets`, { token: mgr.token, body: { name: 'Floodlight A', asset_tag: 'FL-1', resource_id: court.id, condition: 'good', warranty_until: addDays(today, 30) } }), 201);
  assert.equal((await api('POST', `/venues/${v.id}/assets`, { token: mgr.token, body: { name: 'Dup', asset_tag: 'FL-1' } })).status, 409);
  let list = must(await api('GET', `/venues/${v.id}/assets`, { token: mgr.token }));
  assert.equal(list.length, 1); assert.equal(list[0].warranty_expiring, true);
  const stock = must(await api('GET', '/inventory', { token: mgr.token, query: { venue_id: v.id } }));
  assert.ok(JSON.stringify(stock).includes(a.id), 'one inventory, not two');
  const tpl = must(await api('POST', `/venues/${v.id}/pm-templates`, { token: mgr.token, body: { title: 'Light check', asset_id: a.id, every_days: 30, first_due_on: today, checklist: ['Test bulbs', 'Clean lenses'] } }), 201);
  assert.equal(await raisePreventiveWork(), 1);
  assert.equal(await raisePreventiveWork(), 0, 'one open job per template');
  assert.equal((await pool.query('SELECT next_due_on > current_date AS later FROM venue_pm_templates WHERE id=$1', [tpl.id])).rows[0].later, true);
  const job = must(await api('GET', `/venues/${v.id}/maintenance`, { token: mgr.token })).items[0];
  assert.equal(job.kind, 'preventive'); assert.equal(job.checklist.length, 2); assert.equal(job.asset_name, 'Floodlight A');
  assert.equal((await api('PATCH', `/maintenance/${job.id}`, { token: tech.token, body: { status: 'in_progress' } })).status, 403, 'not assigned to them');
  must(await api('PATCH', `/maintenance/${job.id}`, { token: mgr.token, body: { assignee_id: tech.id } }));
  must(await api('PATCH', `/maintenance/${job.id}`, { token: tech.token, body: { status: 'in_progress' } }));
  assert.equal((await api('PATCH', `/maintenance/${job.id}`, { token: tech.token, body: { priority: 'low' } })).status, 403);
  assert.equal((await api('PATCH', `/maintenance/${job.id}`, { token: tech.token, body: { status: 'done' } })).status, 409, 'open steps');
  const done = must(await api('PATCH', `/maintenance/${job.id}`, { token: tech.token, body: { checklist: job.checklist.map((x) => ({ ...x, done: true })), parts: [{ name: 'Bulb', quantity: 2, cost_cents: 5000 }], status: 'done' } }));
  assert.equal(done.signed_off_by, tech.id); assert.equal(done.status, 'done');
  assert.equal((await api('PATCH', `/venue-assets/${a.id}`, { token: tech.token, body: { condition: 'poor' } })).status, 403);
  must(await api('PATCH', `/venue-assets/${a.id}`, { token: mgr.token, body: { condition: 'out_of_service' } }));
});

test('incidents: private details are encrypted, audited and scoped', async () => {
  const mgr = await signup(['venue_manager']), floor = await signup(), other = await signup(), outsider = await signup();
  const { v, court } = await venue(mgr);
  await addStaff(mgr, v, floor, 'staff'); await addStaff(mgr, v, other, 'staff');
  const inc = must(await api('POST', `/venues/${v.id}/incidents`, { token: floor.token, body: { kind: 'injury', severity: 'serious', summary: 'Player fell on court', details: 'Sprained ankle, parent called Mrs Rao', resource_id: court.id, raise_work_order: true } }), 201);
  assert.ok(inc.maintenance_id); assert.equal(inc.has_details, true); assert.equal(inc.details, undefined);
  const raw = (await pool.query('SELECT details_enc FROM venue_incidents WHERE id=$1', [inc.id])).rows[0].details_enc;
  assert.ok(raw && !raw.includes('Sprained'), 'ciphertext only');
  assert.equal((await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='venue_incident'", [mgr.id])).rowCount, 1, 'managers told at once');
  assert.equal(must(await api('GET', `/venues/${v.id}/incidents`, { token: floor.token })).length, 1);
  assert.equal(must(await api('GET', `/venues/${v.id}/incidents`, { token: other.token })).length, 0, 'floor staff see only their own');
  assert.equal((await api('GET', `/venue-incidents/${inc.id}`, { token: other.token })).status, 404);
  assert.equal((await api('GET', `/venue-incidents/${inc.id}`, { token: outsider.token })).status, 404);
  const got = must(await api('GET', `/venue-incidents/${inc.id}`, { token: mgr.token }));
  assert.match(got.details, /Sprained ankle/);
  assert.equal((await pool.query("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='read_pii' AND entity='venue_incidents'", [mgr.id])).rowCount, 1);
  assert.equal((await api('PATCH', `/venue-incidents/${inc.id}`, { token: floor.token, body: { status: 'investigating' } })).status, 403);
  assert.equal((await api('PATCH', `/venue-incidents/${inc.id}`, { token: mgr.token, body: { status: 'resolved' } })).status, 400, 'needs a resolution');
  assert.equal(must(await api('PATCH', `/venue-incidents/${inc.id}`, { token: mgr.token, body: { status: 'resolved', resolution: 'First aid given, surface dried' } })).status, 'resolved');
});

test('shifts: rostered, no overlap, clock in and out, staff see their own', async () => {
  const mgr = await signup(['venue_manager']), a = await signup(), b = await signup();
  const { v } = await venue(mgr);
  await addStaff(mgr, v, a, 'staff', 'lifeguard'); await addStaff(mgr, v, b, 'staff');
  const s = must(await api('POST', `/venues/${v.id}/shifts`, { token: mgr.token, body: { user_id: a.id, starts_at: iso(-10), ends_at: iso(240) } }), 201);
  assert.equal(s.duty, 'lifeguard');
  assert.equal((await api('POST', `/venues/${v.id}/shifts`, { token: mgr.token, body: { user_id: a.id, starts_at: iso(60), ends_at: iso(120) } })).status, 409);
  must(await api('POST', `/venues/${v.id}/shifts`, { token: mgr.token, body: { user_id: b.id, starts_at: iso(60), ends_at: iso(120) } }), 201);
  assert.equal((await api('POST', `/venues/${v.id}/shifts`, { token: a.token, body: { user_id: a.id, starts_at: iso(500), ends_at: iso(560) } })).status, 403);
  assert.equal(must(await api('GET', `/venues/${v.id}/shifts`, { token: a.token })).length, 1);
  assert.equal(must(await api('GET', `/venues/${v.id}/shifts`, { token: mgr.token })).length, 2);
  assert.equal((await api('POST', `/venue-shifts/${s.id}/clock`, { token: b.token, body: { action: 'in' } })).status, 404);
  assert.equal((await api('POST', `/venue-shifts/${s.id}/clock`, { token: a.token, body: { action: 'out' } })).status, 409);
  assert.equal(must(await api('POST', `/venue-shifts/${s.id}/clock`, { token: a.token, body: { action: 'in' } })).status, 'clocked_in');
  assert.equal(must(await api('POST', `/venue-shifts/${s.id}/clock`, { token: a.token, body: { action: 'out' } })).status, 'completed');
  assert.equal((await api('POST', `/venue-shifts/${s.id}/cancel`, { token: mgr.token, body: {} })).status, 409, 'worked shifts stay');
});

test('readiness: every area kind has its own checklist; failures raise work orders', async () => {
  const mgr = await signup(['venue_manager']);
  const { v, court } = await venue(mgr);
  const kinds = ['court', 'ground', 'pool', 'track', 'room', 'equipment'];
  assert.deepEqual(Object.keys(READINESS).sort(), [...kinds].sort(), 'no kind on a silent default');
  for (const k of kinds.slice(1)) must(await api('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: k, name: `Area ${k}` } }), 201);
  let board = must(await api('GET', `/venues/${v.id}/readiness`, { token: mgr.token }));
  assert.equal(board.areas.length, 6); assert.equal(board.totals.unchecked, 6);
  const pool_ = board.areas.find((x) => x.kind === 'pool');
  assert.ok(pool_.template.some((t) => t.key === 'water_quality' && t.critical));
  const check = (area, failKey) => api('POST', `/resources/${area.resource_id}/readiness`, { token: mgr.token, body: { items: area.template.map((t) => ({ key: t.key, ok: t.key !== failKey })), raise_work_order: true } });
  assert.equal(must(await check(board.areas.find((x) => x.kind === 'court'), null), 201).status, 'ready');
  const bad = must(await check(pool_, 'water_quality'), 201);
  assert.equal(bad.status, 'not_ready'); assert.ok(bad.maintenance_id);
  assert.equal(must(await check(board.areas.find((x) => x.kind === 'track'), 'lane_markings'), 201).status, 'attention');
  assert.equal((await api('POST', `/resources/${court.id}/readiness`, { token: mgr.token, body: { items: [{ key: 'nonsense', ok: true }] } })).status, 400);
  assert.equal((await api('POST', `/resources/${court.id}/readiness`, { token: mgr.token, body: { items: [{ key: 'surface_clean', ok: true }] } })).status, 400, 'every item answered');
  board = must(await api('GET', `/venues/${v.id}/readiness`, { token: mgr.token }));
  assert.equal(board.totals.ready, 1); assert.equal(board.totals.not_ready, 1); assert.equal(board.totals.attention, 1);
  assert.equal(board.areas.find((x) => x.kind === 'pool').open_work_orders, 1);
});

test('income reconciliation and the multi-venue command dashboard', async () => {
  const op = await signup(['venue_manager']), stranger = await signup(['venue_manager']);
  const one = await venue(op), two = await venue(op, { currency: 'USD' });
  const rec = must(await api('GET', `/venues/${one.v.id}/income`, { token: op.token, query: { from: today, to: today } }));
  assert.equal(rec.currencies[0].currency, 'INR'); assert.equal(rec.till.closed, 0); assert.equal(rec.exceptions, 0);
  assert.equal((await api('GET', `/venues/${one.v.id}/income`, { token: stranger.token, query: { from: today, to: today } })).status, 403);
  assert.equal((await api('GET', `/venues/${one.v.id}/income`, { token: op.token, query: { from: '2020-01-01', to: today } })).status, 400);
  must(await api('POST', `/venues/${one.v.id}/incidents`, { token: op.token, body: { kind: 'safety', severity: 'critical', summary: 'Exposed wiring' } }), 201);
  const net = must(await api('GET', '/venue-network', { token: op.token }));
  assert.equal(net.venues.length, 2);
  assert.deepEqual(net.totals.map((t) => t.currency).sort(), ['INR', 'USD'], 'never summed across currencies');
  assert.equal(net.attention.serious_incidents, 1);
  assert.ok(net.venues.every((x) => 'utilisation' in x && 'maintenance' in x && 'readiness' in x));
  assert.equal(must(await api('GET', '/venue-network', { token: stranger.token })).venues.length, 0);
});

const nowBooking = async (venueId, courtId, user, startMin = -10, endMin = 50) => {
  const rs = (await pool.query("INSERT INTO reservations(code, user_id, currency, status) VALUES ($1,$2,'INR','confirmed') RETURNING id", [`VF${Math.random().toString(36).slice(2, 9)}`, user.id])).rows[0];
  return (await pool.query("INSERT INTO bookings(resource_id, user_id, reservation_id, starts_at, ends_at, status) VALUES ($1,$2,$3, now() + ($4 * interval '1 minute'), now() + ($5 * interval '1 minute'), 'confirmed') RETURNING id", [courtId, user.id, rs.id, startMin, endMin])).rows[0];
};

test('Today board: check in a booking through the access layer; floor staff can, outsiders cannot', async () => {
  const mgr = await signup(['venue_manager']), floor = await signup(), booker = await signup(), outsider = await signup();
  const { v, court } = await venue(mgr);
  await addStaff(mgr, v, floor, 'staff');
  const now = await nowBooking(v.id, court.id, booker), later = await nowBooking(v.id, court.id, booker, 60 * 30, 60 * 31);
  assert.equal((await api('POST', `/bookings/${now.id}/check-in`, { token: outsider.token, body: {} })).status, 404, 'no leaking');
  const early = must(await api('POST', `/bookings/${later.id}/check-in`, { token: mgr.token, body: {} }), 201);
  assert.equal(early.verdict, 'denied', 'exactly this booking is judged: it is not open yet, even though the person has another one running now');
  assert.equal(early.reason_code, 'booking_not_now');
  const ok = must(await api('POST', `/bookings/${now.id}/check-in`, { token: floor.token, body: {} }), 201);
  assert.equal(ok.verdict, 'granted'); assert.ok(ok.checked_in_at);
  assert.ok((await pool.query('SELECT checked_in_at FROM bookings WHERE id=$1', [now.id])).rows[0].checked_in_at);
  const sched = must(await api('GET', `/venues/${v.id}/schedule`, { token: mgr.token, query: { from: iso(-120), to: iso(120) } }));
  assert.ok(sched.bookings.find((b) => b.id === now.id).checked_in_at, 'the board shows the arrival');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM access_points WHERE venue_id=$1", [v.id])).rows[0].n, 1, 'one front-desk door, created on first use');
  const stranger = await signup();
  assert.equal(must(await api('POST', `/bookings/${(await nowBooking(v.id, court.id, stranger, 120, 180)).id}/check-in`, { token: mgr.token, body: {} }), 201).verdict, 'denied', 'not their time: recorded as denied with a reason');
  await pool.query("UPDATE bookings SET status='cancelled' WHERE id=$1", [now.id]);
  assert.equal((await api('POST', `/bookings/${now.id}/check-in`, { token: mgr.token, body: {} })).status, 409);
});

test('guest quota: the plan decides how many guests a member may bring', async () => {
  const mgr = await signup(['venue_manager']), member = await signup();
  const { v } = await venue(mgr);
  const plan = must(await api('POST', `/venues/${v.id}/plans`, { token: mgr.token, body: { kind: 'membership', name: 'Plus', price_cents: 100000, duration_days: 30, discount_bp: 1000, entitlements: { guest_quota: 1 } } }), 201);
  assert.equal(plan.entitlements.guest_quota, 1);
  const point = must(await api('POST', '/access/points', { token: mgr.token, body: { venue_id: v.id, name: 'Door', kind: 'door', provider: 'manual' } }), 201);
  await pool.query("INSERT INTO user_plans(plan_id, venue_id, user_id, kind, name, status, price_cents, currency, discount_bp, duration_days, starts_at, expires_at) SELECT id, venue_id, $2, kind, name, 'active', price_cents, 'INR', discount_bp, 30, now(), now() + interval '30 days' FROM venue_plans WHERE id=$1", [plan.id, member.id]);
  const enter = (guests) => api('POST', '/access/captures', { token: mgr.token, body: { idempotency_key: `g${Math.random()}`, domain: 'venue_access', subject_ref: point.id, method: 'manual', user_id: member.id, reason_code: 'roster_tap', guests } });
  assert.equal(must(await enter(1), 201).capture.verdict, 'granted');
  const over = must(await enter(2), 201).capture;
  assert.equal(over.verdict, 'denied'); assert.equal(over.reason_code, 'membership_guest_quota');
  assert.match(over.message, /guests/);
  assert.equal((await pool.query("SELECT guests FROM access_captures WHERE access_point_id=$1 AND verdict='granted'", [point.id])).rows[0].guests, 1, 'guests are recorded');
  assert.equal((await api('POST', '/access/captures', { token: mgr.token, body: { domain: 'venue_access', subject_ref: point.id, method: 'manual', user_id: member.id, reason_code: 'roster_tap', guests: 99 } })).status, 400);
});

test('membership access grants: issued by themselves, once, and revoked when the membership ends', async () => {
  const mgr = await signup(['venue_manager']), member = await signup();
  const { v } = await venue(mgr);
  const ctl = await new Promise((resolve) => { const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, ref: 'prov-1' })); }); }); srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/ctl` })); });
  after(() => ctl.srv.close());
  const point = must(await api('POST', '/access/points', { token: mgr.token, body: { venue_id: v.id, name: 'Turnstile', kind: 'turnstile', provider: 'webhook', endpoint_url: ctl.url } }), 201);
  const plan = must(await api('POST', `/venues/${v.id}/plans`, { token: mgr.token, body: { kind: 'membership', name: 'Gold', price_cents: 100000, duration_days: 30, discount_bp: 1000 } }), 201);
  assert.equal(await syncMembershipGrants(), 0, 'no members yet: nothing issued');
  const up = (await pool.query("INSERT INTO user_plans(plan_id, venue_id, user_id, kind, name, status, price_cents, currency, discount_bp, duration_days, starts_at, expires_at) SELECT id, venue_id, $2, kind, name, 'active', price_cents, 'INR', discount_bp, 30, now(), now() + interval '30 days' FROM venue_plans WHERE id=$1 RETURNING id", [plan.id, member.id])).rows[0];
  assert.equal(await syncMembershipGrants(), 1);
  assert.equal(await syncMembershipGrants(), 0, 'idempotent');
  const grants = must(await api('GET', `/access/points/${point.id}/grants`, { token: mgr.token }));
  assert.equal(grants.length, 1); assert.equal(grants[0].source_type, 'membership'); assert.equal(grants[0].status, 'active');
  await pool.query("UPDATE user_plans SET status='cancelled' WHERE id=$1", [up.id]);
  await sweepAccessGrants();
  assert.equal(must(await api('GET', `/access/points/${point.id}/grants`, { token: mgr.token }))[0].status, 'revoked', 'ended membership closes the door credential');
  assert.equal(await syncMembershipGrants(), 0, 'a cancelled membership gets nothing');
});

test('booking QR: every confirmed booking has its own code; the venue team confirms the arrival by scanning it', async () => {
  const mgr = await signup(['venue_manager']), floor = await signup(), booker = await signup(), other = await signup(), outsider = await signup();
  const { v, court } = await venue(mgr);
  await addStaff(mgr, v, floor, 'staff');
  const a = await nowBooking(v.id, court.id, booker), b = await nowBooking(v.id, court.id, booker, 60 * 5, 60 * 6), c3 = await nowBooking(v.id, court.id, other, 120, 180);
  const passA = must(await api('GET', `/bookings/${a.id}/pass`, { token: booker.token })), passB = must(await api('GET', `/bookings/${b.id}/pass`, { token: booker.token }));
  assert.match(passA.token, /^GQ1\.B\.v\./); assert.notEqual(passA.token, passB.token, 'one code per slot');
  assert.equal(must(await api('GET', `/bookings/${a.id}/pass`, { token: booker.token })).token, passA.token, 'stable, so it can be printed or sent');
  assert.equal(must(await api('GET', `/bookings/${a.id}/pass`, { token: floor.token })).token, passA.token, 'the venue team can show it too');
  assert.equal((await api('GET', `/bookings/${a.id}/pass`, { token: other.token })).status, 404);
  assert.equal((await api('GET', `/bookings/${a.id}/pass`, { token: outsider.token })).status, 404);
  const desk = must(await api('GET', `/venues/${v.id}/front-desk-access-point`, { token: floor.token }));
  assert.equal((await api('GET', `/venues/${v.id}/front-desk-access-point`, { token: outsider.token })).status, 403);
  const scan = (token, who = floor) => api('POST', '/access/captures', { token: who.token, body: { idempotency_key: `q${Math.random()}`, domain: 'venue_access', subject_ref: desk.id, method: 'qr', token } });
  assert.equal((await scan(passA.token, booker)).status, 403, 'the booker cannot confirm their own arrival');
  const forged = passA.token.slice(0, -4) + 'abcd';
  assert.equal(must(await scan(forged), 201).capture.reason_code, 'qr_invalid');
  const tooEarly = must(await scan(passB.token), 201).capture;
  assert.equal(tooEarly.verdict, 'denied'); assert.equal(tooEarly.reason_code, 'booking_not_now', 'only that slot\'s time');
  const ok = must(await scan(passA.token), 201).capture;
  assert.equal(ok.verdict, 'granted'); assert.equal(ok.person.user_id, booker.id); assert.equal(ok.booking.id, a.id); assert.equal(ok.booking.resource_name, 'Court 1');
  assert.ok((await pool.query('SELECT checked_in_at FROM bookings WHERE id=$1', [a.id])).rows[0].checked_in_at);
  assert.equal(must(await scan(passA.token), 201).capture.reason_code, 'already_recorded', 'works once');
  assert.equal(must(await api('GET', `/bookings/${a.id}/pass`, { token: booker.token })).checked_in_at != null, true);
  // another venue's door does not accept it
  const other2 = await venue(mgr); const desk2 = must(await api('GET', `/venues/${other2.v.id}/front-desk-access-point`, { token: mgr.token }));
  const cross = must(await api('POST', '/access/captures', { token: mgr.token, body: { idempotency_key: `x${Math.random()}`, domain: 'venue_access', subject_ref: desk2.id, method: 'qr', token: (await api('GET', `/bookings/${c3.id}/pass`, { token: other.token })).body.token } }), 201).capture;
  assert.equal(cross.reason_code, 'qr_wrong_subject');
  // cancelled: no code, and an old one stops working
  const old = (await api('GET', `/bookings/${c3.id}/pass`, { token: other.token })).body.token;
  await pool.query("UPDATE bookings SET status='cancelled' WHERE id=$1", [c3.id]);
  assert.equal(must(await api('GET', `/bookings/${c3.id}/pass`, { token: other.token })).token, null);
  assert.equal(must(await scan(old), 201).capture.reason_code, 'booking_cancelled');
});

test('income reconciliation with real money: front-desk tenders, a short till, and an online payment the ledger has not recorded', async () => {
  const mgr = await signup(['venue_manager']), cashier = await signup(), outsider = await signup();
  const { v } = await venue(mgr);
  must(await api('POST', `/venues/${v.id}/pos/cashiers`, { token: mgr.token, body: { handle: cashier.handle } }), 201);
  const tube = must(await api('POST', '/inventory', { token: mgr.token, body: { name: 'Shuttle tube', category: 'merch', quantity: 20, sell_price_cents: 30000, unit_cost_cents: 20000, venue_id: v.id } }), 201);
  const shift = must(await api('POST', `/venues/${v.id}/pos/shifts`, { token: cashier.token, body: { opening_float_cents: 100000 } }), 201);
  const sale = must(await api('POST', `/venues/${v.id}/pos/sales`, { token: cashier.token, body: { lines: [{ kind: 'item', item_id: tube.id, qty: 2 }], payments: [{ method: 'cash', tendered_cents: 60000 }] } }), 201);
  assert.equal(sale.status, 'paid'); assert.equal(sale.total_cents, 60000);
  const range = { from: today, to: today };
  const first = must(await api('GET', `/venues/${v.id}/income`, { token: mgr.token, query: range }));
  const inr = first.currencies.find((x) => x.currency === 'INR');
  assert.equal(inr.pos.taken_cents, 60000); assert.equal(inr.pos.net_cents, 60000); assert.equal(inr.pos.paid_sales, 1);
  assert.deepEqual(inr.pos.by_tender.map((t) => [t.method, t.taken_cents]), [['cash', 60000]]);
  assert.equal(inr.unposted_online.tenders, 0);
  assert.equal(first.till.closed, 0);
  // the till is closed 500 short: the variance is reported and the shift waits for a manager's review
  must(await api('POST', `/pos/shifts/${shift.id}/close`, { token: cashier.token, body: { counted_cash_cents: 159500, note: 'Gave wrong change' } }));
  const closed = must(await api('GET', `/venues/${v.id}/income`, { token: mgr.token, query: range }));
  assert.equal(closed.till.closed, 1); assert.equal(Number(closed.till.variance_cents), -500);
  assert.equal(Number(closed.till.expected_cents), 160000); assert.equal(Number(closed.till.counted_cents), 159500);
  assert.ok(closed.till.pending_review >= 1 || closed.exceptions >= 1, 'a short till is an exception to look at');
  // an online tender whose payment never reached the canonical ledger is called out
  const pay = (await pool.query("INSERT INTO payments(payer_id, provider, purpose_type, purpose_id, amount_cents, currency, status, provider_ref, paid_at) VALUES ($1,'stripe','pos_sale',$2,20000,'INR','paid',$3, now()) RETURNING id", [cashier.id, sale.id, `ref-${Math.random()}`])).rows[0];
  await pool.query("INSERT INTO pos_sale_payments(sale_id, shift_id, kind, method, status, amount_cents, payment_id, recorded_by, confirmed_at) VALUES ($1,$2,'payment','online','confirmed',20000,$3,$4, now())", [sale.id, shift.id, pay.id, cashier.id]);
  const after = must(await api('GET', `/venues/${v.id}/income`, { token: mgr.token, query: range }));
  const x = after.currencies.find((c) => c.currency === 'INR');
  assert.equal(x.unposted_online.tenders, 1); assert.equal(Number(x.unposted_online.cents), 20000);
  assert.equal(x.pos.taken_cents, 80000); assert.deepEqual(x.pos.by_tender.map((t) => t.method).sort(), ['cash', 'online']);
  assert.ok(after.exceptions > closed.exceptions - 0 && after.exceptions >= 2);
  // only the venue's managers read it; another venue's operator and the cashier do not
  assert.equal((await api('GET', `/venues/${v.id}/income`, { token: outsider.token, query: range })).status, 403);
  assert.equal((await api('GET', `/venues/${v.id}/income`, { token: cashier.token, query: range })).status, 403);
});
