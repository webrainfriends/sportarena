import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
let n = 0;
const signup = async (roles) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `as_${n}_${roles[0]}`, display_name: `As ${n}`, email: `as${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('a plain athlete can create an event; others still cannot edit it', async () => {
  const a = await signup(['athlete']), other = await signup(['athlete']);
  const ev = await api('POST', '/events', { token: a.token, body: { name: 'Friendly Cup', sport: 'cricket', kind: 'friendly', starts_on: day(3), ends_on: day(3) } });
  assert.equal(ev.status, 201, JSON.stringify(ev.body));
  assert.equal(ev.body.organizer_id, a.id);
  assert.equal((await api('PATCH', `/events/${ev.body.id}`, { token: other.token, body: { name: 'Hijack' } })).status, 403);
  assert.equal((await api('POST', '/events', { body: { name: 'Anon Cup', sport: 'cricket' } })).status, 401);
});

test('schedule merges sources, flags overlaps, and stays private', async () => {
  const a = await signup(['athlete']), coach = await signup(['coach']), other = await signup(['athlete']);
  const ev = (await api('POST', '/events', { token: a.token, body: { name: 'My Camp', sport: 'cricket', kind: 'camp', starts_on: day(2), ends_on: day(4) } })).body;
  const t0 = new Date(Date.now() + 3 * 864e5);
  const hire = await pool.query(
    `INSERT INTO coach_hires(hirer_id, coach_id, starts_at, duration_min, status) VALUES ($1,$2,$3,60,'confirmed') RETURNING id`, [a.id, coach.id, t0]);
  const appt = await pool.query(
    `INSERT INTO appointments(athlete_id, provider_id, starts_at, duration_min, status) VALUES ($1,$2,$3,30,'confirmed') RETURNING id`, [a.id, coach.id, new Date(t0.getTime() + 30 * 60000)]);
  const solo = await pool.query(
    `INSERT INTO coach_hires(hirer_id, coach_id, starts_at, duration_min, status) VALUES ($1,$2,$3,60,'confirmed') RETURNING id`, [a.id, coach.id, new Date(t0.getTime() + 5 * 3600000)]);

  const r = await api('GET', '/me/sport-schedule', { token: a.token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const by = (id) => r.body.items.find((x) => x.source_id === id);
  assert.equal(by(ev.id).kind, 'event');
  assert.equal(by(hire.rows[0].id).kind, 'training');
  assert.equal(by(appt.rows[0].id).kind, 'health');
  assert.equal(by(appt.rows[0].id).title, 'Appointment');
  assert.equal(by(hire.rows[0].id).conflict, true);
  assert.equal(by(appt.rows[0].id).conflict, true);
  assert.equal(by(solo.rows[0].id).conflict, false);
  assert.equal(r.body.conflicts, 2);
  assert.ok(!JSON.stringify(r.body).includes('reason'));

  const f = await api('GET', '/me/sport-schedule?kinds=health', { token: a.token });
  assert.deepEqual([...new Set(f.body.items.map((x) => x.kind))], ['health']);
  assert.equal((await api('GET', '/me/sport-schedule?kinds=bogus', { token: a.token })).status, 400);

  assert.equal((await api('GET', '/me/sport-schedule', { token: other.token })).body.items.length, 0); // isolation
  const c = await api('GET', '/me/sport-schedule', { token: coach.token }); // coach sees the hire, not the clinical row
  assert.ok(c.body.items.some((x) => x.source_id === hire.rows[0].id && x.kind === 'training'));
  assert.equal((await api('GET', '/me/sport-schedule')).status, 401);
});
