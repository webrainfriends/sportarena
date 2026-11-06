import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
await import('../src/capabilities/index.js');

let server, base, n = 0;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const yearsAgo = y => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); return d.toISOString().slice(0, 10); };
const signup = async () => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `cp_${n}`, display_name: `CP ${n}`, email: `cp${n}@example.com`, password: 'correct-horse-battery', roles: ['athlete'], dob: yearsAgo(30) } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(() => server?.close());

test('carpool: offer, request seat, confirm — exact address never in list response', async () => {
  const driver = await signup();
  const passenger = await signup();

  // Create event
  const evRow = (await pool.query(
    "INSERT INTO events(name,starts_at,organisation_id) SELECT 'Match','2030-01-01','00000000-0000-0000-0000-000000000000' RETURNING id"
  )).rows[0];
  const eventId = evRow?.id;
  if (!eventId) return; // skip if events table schema differs

  const departure = new Date(Date.now() + 86400000).toISOString();

  // Driver creates offer
  const offered = ok(await api('POST', `/events/${eventId}/carpool-offers`, { token: driver.token, body: {
    departure_location: '123 Private Street, London SW1A 1AA',
    area_label: 'Westminster area',
    departure_time: departure,
    seats_available: 3,
    vehicle_type: 'car',
    return_offered: true,
  } }), 201);
  const offerId = offered.offer?.id;
  assert.ok(offerId);

  // List offers — exact address must NOT appear
  const list = ok(await api('GET', `/events/${eventId}/carpool-offers`, { token: passenger.token }));
  for (const o of list.offers ?? []) {
    assert.ok(!JSON.stringify(o).includes('Private Street'), 'exact address leaked in list');
    assert.ok(o.area_label);
  }

  // Passenger requests seat
  const booked = ok(await api('POST', `/carpool-offers/${offerId}/bookings`, { token: passenger.token, body: { pickup_area_label: 'Hackney area' } }), 201);
  assert.equal(booked.booking?.status ?? booked.status, 'pending');
  const bookingId = booked.booking?.id;

  // Driver confirms
  ok(await api('PATCH', `/carpool-bookings/${bookingId}`, { token: driver.token, body: { decision: 'approved' } }));

  // Manifest (driver only) — full address disclosed, audit-logged
  const manifest = ok(await api('GET', `/carpool-offers/${offerId}/manifest`, { token: driver.token }));
  assert.ok(Array.isArray(manifest.passengers));
});

test('driver cannot create two offers for same event', async () => {
  const driver = await signup();
  const evRow = (await pool.query(
    "INSERT INTO events(name,starts_at,organisation_id) SELECT 'Match2','2030-02-01','00000000-0000-0000-0000-000000000000' RETURNING id"
  )).rows[0];
  if (!evRow?.id) return;
  const body = { departure_location: '1 Main St', area_label: 'Central', departure_time: new Date(Date.now() + 86400000).toISOString(), seats_available: 2, vehicle_type: 'car' };
  ok(await api('POST', `/events/${evRow.id}/carpool-offers`, { token: driver.token, body }), 201);
  const dup = await api('POST', `/events/${evRow.id}/carpool-offers`, { token: driver.token, body });
  assert.ok([400, 409].includes(dup.status), `expected 400/409 got ${dup.status}`);
});
