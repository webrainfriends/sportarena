import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { expireStaleRequests, NEXT } = await import('../src/lifecycle.js');

let server, base, n = 0;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const signup = async (roles) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `lc_${n}_${roles[0]}`, display_name: `Lc ${n}`, email: `lc${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const inFuture = (days, hour = 9) => { const d = new Date(Date.now() + days * 864e5); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };
const patch = (path, user, status) => api('PATCH', path, { token: user.token, body: { status } });

const coachOf = async () => {
  const coach = await signup(['coach']);
  ok(await api('POST', '/me/sport-profiles', { token: coach.token, body: { sport: 'football', role: 'coach', level: 'pro', hourly_rate_cents: 5000 } }), 201);
  return coach;
};
const doctor = async () => {
  const u = await signup(['doctor']);
  ok(await api('POST', '/me/sport-profiles', { token: u.token, body: { sport: 'football', role: 'doctor' } }), 201);
  ok(await api('POST', '/me/provider-profile', { token: u.token, body: { provider_type: 'doctor' } }));
  await pool.query("INSERT INTO verification_cases(type, subject_type, subject_id, requested_by, status, rules_version, decided_at, expires_at) VALUES ('doctor','user',$1,$1,'approved',1,now(), now() + interval '300 days')", [u.id]);   // current credential, as clinical actions now require
  return u;
};
let slot = 0;
const hire = async (athlete, coach) => ok(await api('POST', '/hires', { token: athlete.token, body: { coach_id: coach.id, sport: 'football', starts_at: inFuture(20 + slot++, 9), duration_min: 60 } }), 201);
const appt = async (athlete, doc) => ok(await api('POST', '/appointments', { token: athlete.token, body: { provider_id: doc.id, starts_at: inFuture(20 + slot++, 10) } }), 201);
const started = (table, id) => pool.query(`UPDATE ${table} SET starts_at = now() - interval '2 hours' WHERE id=$1`, [id]);
const row = async (table, id) => (await pool.query(`SELECT status, payment_status FROM ${table} WHERE id=$1`, [id])).rows[0];

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('transition map: finals are terminal and expired is system-only', () => {
  assert.deepEqual(NEXT.requested, ['confirmed', 'cancelled', 'expired']);
  assert.deepEqual(NEXT.confirmed, ['completed', 'cancelled']);
  for (const s of ['completed', 'cancelled', 'expired']) assert.deepEqual(NEXT[s], []);
});

test('coaching hire: requested cannot jump to completed, cancelled cannot be resurrected, completion needs the start time to have passed', async () => {
  const athlete = await signup(['athlete']), coach = await coachOf(), stranger = await signup(['athlete']);
  const h = await hire(athlete, coach), path = `/hires/${h.id}`;
  assert.equal((await patch(path, coach, 'completed')).status, 409, 'requested -> completed is refused');
  assert.equal((await patch(path, athlete, 'confirmed')).status, 403, 'hirer cannot confirm');
  assert.equal((await patch(path, stranger, 'cancelled')).status, 403, 'strangers cannot touch it');
  assert.equal((await api('PATCH', path, { token: coach.token, body: { status: 'expired' } })).status, 400, 'expired cannot be requested');
  ok(await patch(path, coach, 'confirmed'));
  assert.equal((await patch(path, coach, 'confirmed')).status, 409, 'confirmed -> confirmed is refused');
  assert.equal((await patch(path, coach, 'completed')).status, 409, 'not started yet');
  await started('coach_hires', h.id);
  assert.equal(ok(await patch(path, coach, 'completed')).status, 'completed');
  assert.equal((await patch(path, athlete, 'cancelled')).status, 409, 'completed is final');
  assert.equal((await patch(path, coach, 'confirmed')).status, 409);

  const c = await hire(athlete, coach);
  ok(await patch(`/hires/${c.id}`, athlete, 'cancelled'));
  assert.equal((await patch(`/hires/${c.id}`, coach, 'confirmed')).status, 409, 'cancelled -> confirmed is refused');
  assert.equal((await patch(`/hires/${c.id}`, athlete, 'cancelled')).status, 409, 'cancel twice is refused');
  assert.equal((await row('coach_hires', c.id)).status, 'cancelled');
  assert.equal((await api('PATCH', '/hires/00000000-0000-4000-8000-000000000000', { token: coach.token, body: { status: 'confirmed' } })).status, 404);
});

test('appointment: same rules, and a past-due request cannot be confirmed', async () => {
  const athlete = await signup(['athlete']), doc = await doctor();
  const a = await appt(athlete, doc), path = `/appointments/${a.id}`;
  assert.equal((await patch(path, doc, 'completed')).status, 409);
  ok(await patch(path, doc, 'confirmed'));
  assert.equal((await patch(path, doc, 'completed')).status, 409, 'not started yet');
  await started('appointments', a.id);
  ok(await patch(path, doc, 'completed'));
  assert.equal((await patch(path, athlete, 'cancelled')).status, 409);

  const late = await appt(athlete, doc);
  await started('appointments', late.id);
  assert.equal((await patch(`/appointments/${late.id}`, doc, 'confirmed')).status, 409, 'start time already passed');
});

test('concurrent confirm/confirm and confirm/cancel resolve into one consistent state', async () => {
  const athlete = await signup(['athlete']), coach = await coachOf(), doc = await doctor();
  for (const [table, base_, mk, provider] of [['coach_hires', '/hires', () => hire(athlete, coach), coach], ['appointments', '/appointments', () => appt(athlete, doc), doc]]) {
    const x = await mk();
    const twice = await Promise.all([patch(`${base_}/${x.id}`, provider, 'confirmed'), patch(`${base_}/${x.id}`, provider, 'confirmed')]);
    assert.deepEqual(twice.map((r) => r.status).sort(), [200, 409], `${table}: exactly one confirm wins`);
    const y = await mk();
    const race = await Promise.all([patch(`${base_}/${y.id}`, provider, 'confirmed'), patch(`${base_}/${y.id}`, athlete, 'cancelled')]);
    assert.ok(race.every((r) => [200, 409].includes(r.status)) && race.some((r) => r.status === 200), JSON.stringify(race.map((r) => r.status)));
    const final = (await row(table, y.id)).status;
    assert.equal(final, 'cancelled', 'cancel always ends up winning: confirm-then-cancel and cancel-then-(refused confirm) are the only outcomes');
    const z = await mk();
    const two = await Promise.all([patch(`${base_}/${z.id}`, athlete, 'cancelled'), patch(`${base_}/${z.id}`, provider, 'cancelled')]);
    assert.deepEqual(two.map((r) => r.status).sort(), [200, 409], `${table}: exactly one cancel wins`);
  }
});

test('requests that were never answered expire when their start time passes; answered ones do not', async () => {
  const athlete = await signup(['athlete']), coach = await coachOf(), doc = await doctor();
  const hStale = await hire(athlete, coach), hOk = await hire(athlete, coach);
  const aStale = await appt(athlete, doc), aOk = await appt(athlete, doc);
  ok(await patch(`/hires/${hOk.id}`, coach, 'confirmed'));
  ok(await patch(`/appointments/${aOk.id}`, doc, 'confirmed'));
  for (const [t, id] of [['coach_hires', hStale.id], ['coach_hires', hOk.id], ['appointments', aStale.id], ['appointments', aOk.id]]) await started(t, id);
  const out = await expireStaleRequests();
  assert.ok(out.hires >= 1 && out.appointments >= 1, JSON.stringify(out));
  assert.equal((await row('coach_hires', hStale.id)).status, 'expired');
  assert.equal((await row('appointments', aStale.id)).status, 'expired');
  assert.equal((await row('coach_hires', hOk.id)).status, 'confirmed', 'confirmed sessions are left alone');
  assert.equal((await row('appointments', aOk.id)).status, 'confirmed');
  assert.equal((await patch(`/hires/${hStale.id}`, coach, 'confirmed')).status, 409, 'expired -> confirmed is refused');
  assert.equal((await patch(`/appointments/${aStale.id}`, athlete, 'cancelled')).status, 409, 'expired is final');
  assert.equal((await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='coach_hire_expired'", [athlete.id])).rowCount >= 1, true, 'both sides are told');
  assert.deepEqual(await expireStaleRequests(), { appointments: 0, hires: 0 }, 'second run finds nothing');
});
