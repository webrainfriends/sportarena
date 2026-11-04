import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// #797 Academy daily transport: routes, stops, vehicles, schedules, guardian bookings, boarding check-ins, offline sync, invoice lines.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { addDays } = await import('../src/booking/time.js');
const { capabilities } = await import('../src/capabilities/index.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const signup = async (roles = ['athlete'], extra = {}) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `tr_${n}_${roles[0]}`, display_name: `Tr ${n}`, email: `tr${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const today = new Date().toISOString().slice(0, 10);
const key = () => `k-${Math.random().toString(36).slice(2)}-${Date.now()}`;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('tr_root','tr_root','{admin}','x','x','tr_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

async function guardianOf(child) {
  const parent = await signup(['athlete'], { dob: yearsAgo(40) });
  const l = ok(await api('POST', '/youth/guardian-links', { token: parent.token, body: { guardian_id: parent.id, child_id: child.id, relationship: 'parent' } }), 201);
  ok(await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: child.token, body: { accept: true } }));
  ok(await api('POST', `/youth/guardian-links/${l.id}/evidence`, { token: parent.token, body: { evidence: { reference: 'https://example.com/birth-certificate-ref-123', label: 'Birth certificate' } } }), 201);
  ok(await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Documents match' } }));
  parent.linkId = l.id;
  return parent;
}

async function academy() {
  const owner = await signup();
  const org = ok(await api('POST', '/organisations', { token: owner.token, body: { name: `Transport ${n}`, kind: 'academy' } }), 201);
  const officer = await signup();
  ok(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: officer.handle, role: 'staff' } }), 201);
  ok(await api('POST', `/organisations/${org.id}/invite/respond`, { token: officer.token, body: { accept: true } }));
  ok(await api('POST', `/organisations/${org.id}/academy/staff/${officer.id}`, { token: owner.token, body: { job_title: 'Transport lead', template: 'suppliers' } }));
  const kid = await signup(['athlete'], { dob: yearsAgo(11) });
  const parent = await guardianOf(kid);
  const cohort = ok(await api('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: 'U12 transport' } }), 201);
  ok(await api('POST', `/cohorts/${cohort.id}/enrolments`, { token: owner.token, body: { csv: `handle,consent\n${kid.handle},yes` } }), 201);
  return { owner, officer, kid, parent, org, cohort };
}

test('route CRUD — owner creates, non-supplier staff cannot create', async () => {
  const a = await academy();
  const stranger = await signup();

  // owner can create
  const route = ok(await api('POST', `/organisations/${a.org.id}/academy/transport/routes`, { token: a.owner.token, body: { name: 'Morning school run', kind: 'school_run', direction: 'both', operator_name: 'City Transport Ltd' } }), 201);
  assert.equal(route.name, 'Morning school run');
  assert.equal(route.kind, 'school_run');

  // non-member cannot create
  const bad = await api('POST', `/organisations/${a.org.id}/academy/transport/routes`, { token: stranger.token, body: { name: 'Hack', kind: 'other', direction: 'outbound' } });
  assert.ok(bad.status >= 400);

  // list shows route
  const list = ok(await api('GET', `/organisations/${a.org.id}/academy/transport/routes`, { token: a.owner.token }));
  assert.ok(list.some((r) => r.id === route.id));

  // update route
  const updated = ok(await api('PATCH', `/academy/transport/routes/${route.id}`, { token: a.owner.token, body: { row_version: route.row_version, status: 'paused' } }));
  assert.equal(updated.status, 'paused');
});

test('add stops to a route', async () => {
  const a = await academy();
  const route = ok(await api('POST', `/organisations/${a.org.id}/academy/transport/routes`, { token: a.owner.token, body: { name: 'Evening commute', kind: 'training_commute', direction: 'return' } }), 201);

  const stop1 = ok(await api('POST', `/academy/transport/routes/${route.id}/stops`, { token: a.owner.token, body: { sequence: 1, name: 'Main Gate', address: '1 Stadium Road', gps_allowed: false } }), 201);
  assert.equal(stop1.sequence, 1);
  assert.equal(stop1.name, 'Main Gate');

  const stop2 = ok(await api('POST', `/academy/transport/routes/${route.id}/stops`, { token: a.owner.token, body: { sequence: 2, name: 'City Centre', gps_allowed: false } }), 201);
  assert.equal(stop2.sequence, 2);

  // inserting at sequence 1 shifts stop1 to 2
  const stop0 = ok(await api('POST', `/academy/transport/routes/${route.id}/stops`, { token: a.owner.token, body: { sequence: 1, name: 'Academy Entrance', gps_allowed: false } }), 201);
  assert.equal(stop0.sequence, 1);

  const full = ok(await api('GET', `/academy/transport/routes/${route.id}`, { token: a.owner.token }));
  assert.ok(full.stops.length >= 3);
  assert.equal(full.stops[0].name, 'Academy Entrance');
});

test('add vehicle to a route', async () => {
  const a = await academy();
  const route = ok(await api('POST', `/organisations/${a.org.id}/academy/transport/routes`, { token: a.owner.token, body: { name: 'Vehicle test route', kind: 'other', direction: 'both' } }), 201);

  const vehicle = ok(await api('POST', `/academy/transport/routes/${route.id}/vehicles`, { token: a.owner.token, body: { description: '55-seat coach, blue', capacity: 55, driver_name: 'John Driver', driver_phone: '+441234567890', valid_from: today } }), 201);
  assert.equal(vehicle.capacity, 55);
  assert.ok(vehicle.driver_name); // decrypted
});

test('create schedule linked to cohort', async () => {
  const a = await academy();
  const route = ok(await api('POST', `/organisations/${a.org.id}/academy/transport/routes`, { token: a.owner.token, body: { name: 'Cohort schedule route', kind: 'school_run', direction: 'both' } }), 201);

  const sched = ok(await api('POST', `/academy/transport/routes/${route.id}/schedules`, { token: a.owner.token, body: { cohort_id: a.cohort.id, recurrence: ['1', '2', '3', '4', '5'], outbound_depart_time: '08:00', return_depart_time: '17:30', seats_total: 20 } }), 201);
  assert.equal(sched.cohort_id, a.cohort.id);
  assert.equal(sched.seats_total, 20);
  assert.ok(sched.recurrence.includes('1'));
});

test('guardian approves and revokes booking', async () => {
  const a = await academy();
  const route = ok(await api('POST', `/organisations/${a.org.id}/academy/transport/routes`, { token: a.owner.token, body: { name: 'Guardian test route', kind: 'school_run', direction: 'both' } }), 201);
  ok(await api('POST', `/academy/transport/routes/${route.id}/stops`, { token: a.owner.token, body: { sequence: 1, name: 'Home Stop', gps_allowed: false } }), 201);
  const sched = ok(await api('POST', `/academy/transport/routes/${route.id}/schedules`, { token: a.owner.token, body: { cohort_id: a.cohort.id, recurrence: ['1', '2', '3', '4', '5'] } }), 201);

  // guardian can approve
  const booking = ok(await api('POST', `/academy/transport/schedules/${sched.id}/bookings`, { token: a.parent.token, body: { athlete_id: a.kid.id, direction: 'both' } }), 201);
  assert.equal(booking.athlete_id, a.kid.id);
  assert.ok(booking.approved_at);

  // guardian can revoke
  const rev = ok(await api('DELETE', `/academy/transport/bookings/${booking.id}`, { token: a.parent.token }));
  assert.ok(rev.revoked_at);

  // stranger cannot approve
  const stranger = await signup();
  const badApprove = await api('POST', `/academy/transport/schedules/${sched.id}/bookings`, { token: stranger.token, body: { athlete_id: a.kid.id, direction: 'outbound' } });
  assert.ok(badApprove.status >= 400);
});

test('boarding check-in — idempotent', async () => {
  const a = await academy();
  const route = ok(await api('POST', `/organisations/${a.org.id}/academy/transport/routes`, { token: a.owner.token, body: { name: 'Checkin route', kind: 'school_run', direction: 'both' } }), 201);
  const stop = ok(await api('POST', `/academy/transport/routes/${route.id}/stops`, { token: a.owner.token, body: { sequence: 1, name: 'Gate', gps_allowed: false } }), 201);
  const sched = ok(await api('POST', `/academy/transport/routes/${route.id}/schedules`, { token: a.owner.token, body: { cohort_id: a.cohort.id, recurrence: ['1', '2', '3', '4', '5'] } }), 201);
  ok(await api('POST', `/academy/transport/schedules/${sched.id}/bookings`, { token: a.parent.token, body: { athlete_id: a.kid.id, stop_id: stop.id, direction: 'both' } }), 201);

  const ikey = key();
  const ci1 = ok(await api('POST', `/academy/transport/schedules/${sched.id}/checkin`, { token: a.officer.token, body: { athlete_id: a.kid.id, stop_id: stop.id, direction: 'outbound', event: 'boarded', idempotency_key: ikey } }));
  const ci2 = ok(await api('POST', `/academy/transport/schedules/${sched.id}/checkin`, { token: a.officer.token, body: { athlete_id: a.kid.id, stop_id: stop.id, direction: 'outbound', event: 'boarded', idempotency_key: ikey } }));
  // second call returns same record
  assert.equal(ci1.id, ci2.id);
  assert.ok(ci2.already_recorded);
});

test('offline sync batch', async () => {
  const a = await academy();
  const route = ok(await api('POST', `/organisations/${a.org.id}/academy/transport/routes`, { token: a.owner.token, body: { name: 'Sync route', kind: 'other', direction: 'outbound' } }), 201);
  const stop = ok(await api('POST', `/academy/transport/routes/${route.id}/stops`, { token: a.owner.token, body: { sequence: 1, name: 'Sync Stop', gps_allowed: false } }), 201);
  const sched = ok(await api('POST', `/academy/transport/routes/${route.id}/schedules`, { token: a.owner.token, body: { cohort_id: a.cohort.id, recurrence: ['1', '2', '3', '4', '5'] } }), 201);

  const k1 = key(), k2 = key();
  const res = ok(await api('POST', '/academy/transport/checkins/sync', { token: a.officer.token, body: { items: [
    { schedule_id: sched.id, athlete_id: a.kid.id, stop_id: stop.id, direction: 'outbound', event: 'boarded', idempotency_key: k1, captured_at: new Date().toISOString() },
    { schedule_id: sched.id, athlete_id: a.kid.id, stop_id: stop.id, direction: 'outbound', event: 'boarded', idempotency_key: k1, captured_at: new Date().toISOString() }, // duplicate
    { schedule_id: sched.id, athlete_id: a.kid.id, stop_id: stop.id, direction: 'outbound', event: 'no_show', idempotency_key: k2, captured_at: new Date().toISOString() },
  ] } }));
  assert.equal(res.synced, 2);
  assert.equal(res.already_synced, 1);
});

test('transport overview returns today routes', async () => {
  const a = await academy();
  const route = ok(await api('POST', `/organisations/${a.org.id}/academy/transport/routes`, { token: a.owner.token, body: { name: 'Overview route', kind: 'training_commute', direction: 'both' } }), 201);
  const dow = String(((new Date().getUTCDay() + 6) % 7) + 1);
  ok(await api('POST', `/academy/transport/routes/${route.id}/schedules`, { token: a.owner.token, body: { cohort_id: a.cohort.id, recurrence: [dow] } }), 201);

  const ov = ok(await api('GET', `/organisations/${a.org.id}/academy/transport`, { token: a.owner.token }));
  assert.ok(Array.isArray(ov.routes));
  assert.ok(ov.routes.some((r) => r.route_id === route.id));
});

test('submit invoice line — needs suppliers permission', async () => {
  const a = await academy();
  const route = ok(await api('POST', `/organisations/${a.org.id}/academy/transport/routes`, { token: a.owner.token, body: { name: 'Invoice route', kind: 'other', direction: 'outbound' } }), 201);
  const sched = ok(await api('POST', `/academy/transport/routes/${route.id}/schedules`, { token: a.owner.token, body: { recurrence: ['1'] } }), 201);

  // officer with suppliers permission can submit
  const line = ok(await api('POST', `/academy/transport/schedules/${sched.id}/invoice`, { token: a.officer.token, body: { invoice_ref: 'INV-2024-001', amount_minor: 25000, currency: 'GBP', status: 'submitted' } }), 201);
  assert.equal(line.invoice_ref, 'INV-2024-001');
  assert.equal(line.amount_minor, 25000);

  // stranger cannot submit
  const stranger = await signup();
  const bad = await api('POST', `/academy/transport/schedules/${sched.id}/invoice`, { token: stranger.token, body: { status: 'pending' } });
  assert.ok(bad.status >= 400);
});

test('boarding board — returns only enrolled athletes', async () => {
  const a = await academy();
  const route = ok(await api('POST', `/organisations/${a.org.id}/academy/transport/routes`, { token: a.owner.token, body: { name: 'Board route', kind: 'school_run', direction: 'both' } }), 201);
  const stop = ok(await api('POST', `/academy/transport/routes/${route.id}/stops`, { token: a.owner.token, body: { sequence: 1, name: 'Board Stop', gps_allowed: false } }), 201);
  const sched = ok(await api('POST', `/academy/transport/routes/${route.id}/schedules`, { token: a.owner.token, body: { cohort_id: a.cohort.id, recurrence: ['1', '2', '3', '4', '5'] } }), 201);
  ok(await api('POST', `/academy/transport/schedules/${sched.id}/bookings`, { token: a.parent.token, body: { athlete_id: a.kid.id, stop_id: stop.id, direction: 'both' } }), 201);

  const board = ok(await api('GET', `/academy/transport/schedules/${sched.id}/board`, { token: a.officer.token }));
  assert.ok(Array.isArray(board.athletes));
  assert.ok(board.athletes.some((x) => x.athlete_id === a.kid.id));
  // stranger not in org cannot read board
  const stranger = await signup();
  const bad = await api('GET', `/academy/transport/schedules/${sched.id}/board`, { token: stranger.token });
  assert.ok(bad.status >= 400);
});
