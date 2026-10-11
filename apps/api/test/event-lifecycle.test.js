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
  const r = await api('POST', '/auth/register', { body: { handle: `lc_${n}_${roles[0]}`, display_name: `Lc ${n}`, email: `lc${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const newEvent = async (org) => {
  const e = await api('POST', '/events', { token: org.token, body: { name: `Lifecycle Cup ${++n}`, sport: 'football' } });
  assert.equal(e.status, 201, JSON.stringify(e.body));
  return e.body;
};
const fixture = (eventId, status) => pool.query("INSERT INTO fixtures(event_id, scheduled_at, status) VALUES ($1, now(), $2) RETURNING id", [eventId, status]).then((r) => r.rows[0].id);
const fstatus = (fid) => pool.query('SELECT status, paused_by_event FROM fixtures WHERE id=$1', [fid]).then((r) => r.rows[0]);

test('only a running event can be paused, and only its organiser can do it', async () => {
  const org = await signup(['organizer']), other = await signup(['organizer']);
  const ev = await newEvent(org);
  assert.equal((await api('POST', `/events/${ev.id}/pause`, { token: org.token, body: { reason: 'Rain delay' } })).status, 409, 'open event cannot pause');
  assert.equal((await api('PATCH', `/events/${ev.id}`, { token: org.token, body: { status: 'ongoing' } })).status, 200);
  assert.equal((await api('POST', `/events/${ev.id}/pause`, { token: other.token, body: { reason: 'Rain delay' } })).status, 403);
  const p = await api('POST', `/events/${ev.id}/pause`, { token: org.token, body: { reason: 'Rain delay' } });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.status, 'paused');
  assert.equal(p.body.pause_reason, 'Rain delay');
  assert.equal((await api('POST', `/events/${ev.id}/pause`, { token: org.token, body: { reason: 'again' } })).status, 409, 'already paused');
});

test('pause freezes live games, resume restores only those', async () => {
  const org = await signup(['organizer']);
  const ev = await newEvent(org);
  await api('PATCH', `/events/${ev.id}`, { token: org.token, body: { status: 'ongoing' } });
  const live = await fixture(ev.id, 'live'), sched = await fixture(ev.id, 'scheduled'), manual = await fixture(ev.id, 'paused');
  const p = await api('POST', `/events/${ev.id}/pause`, { token: org.token, body: { reason: 'Lightning' } });
  assert.equal(p.body.frozen_fixtures, 1);
  assert.equal((await fstatus(live)).status, 'paused');
  assert.equal((await fstatus(sched)).status, 'scheduled');
  const r = await api('POST', `/events/${ev.id}/resume`, { token: org.token, body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'ongoing');
  assert.equal(r.body.pause_reason, null);
  assert.equal(r.body.resumed_fixtures, 1);
  assert.deepEqual(await fstatus(live), { status: 'live', paused_by_event: false });
  assert.equal((await fstatus(manual)).status, 'paused', 'a game paused on its own stays paused');
  assert.equal((await api('POST', `/events/${ev.id}/resume`, { token: org.token, body: {} })).status, 409, 'not paused any more');
});

test('ending refuses while games run unless forced with a reason; history records every step', async () => {
  const org = await signup(['organizer']);
  const ev = await newEvent(org);
  await api('PATCH', `/events/${ev.id}`, { token: org.token, body: { status: 'ongoing' } });
  const live = await fixture(ev.id, 'live');
  assert.equal((await api('POST', `/events/${ev.id}/end`, { token: org.token, body: {} })).status, 409);
  assert.equal((await api('POST', `/events/${ev.id}/end`, { token: org.token, body: { force: true } })).status, 409, 'force needs a reason');
  await api('POST', `/events/${ev.id}/pause`, { token: org.token, body: { reason: 'Power cut' } });
  await api('POST', `/events/${ev.id}/resume`, { token: org.token, body: { note: 'Power back' } });
  const e = await api('POST', `/events/${ev.id}/end`, { token: org.token, body: { force: true, reason: 'Venue closing' } });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  assert.equal(e.body.status, 'completed');
  assert.equal((await fstatus(live)).status, 'abandoned');
  const row = (await pool.query('SELECT ended_at, ended_by FROM events WHERE id=$1', [ev.id])).rows[0];
  assert.ok(row.ended_at); assert.equal(row.ended_by, org.id);

  const h = await api('GET', `/events/${ev.id}/status-history`, { token: org.token });
  assert.equal(h.status, 200);
  const steps = h.body.map((x) => `${x.from_status}>${x.to_status}`);
  assert.deepEqual(steps, ['open>ongoing', 'ongoing>paused', 'paused>ongoing', 'ongoing>completed']);
  assert.equal(h.body[1].reason, 'Power cut');
  assert.equal(h.body[1].actor_id, org.id);
  assert.equal(h.body[3].reason, 'Venue closing');
  const outsider = await signup(['organizer']);
  assert.equal((await api('GET', `/events/${ev.id}/status-history`, { token: outsider.token })).status, 403);
});

test('a paused event stays discoverable and cannot take new entries', async () => {
  const org = await signup(['organizer']), pl = await signup(['athlete']);
  const ev = await newEvent(org);
  await api('PATCH', `/events/${ev.id}`, { token: org.token, body: { status: 'ongoing' } });
  await api('POST', `/events/${ev.id}/pause`, { token: org.token, body: { reason: 'Break' } });
  const s = await api('GET', '/events/search');
  assert.ok(s.body.items.some((x) => x.id === ev.id && x.status === 'paused'));
  assert.equal((await api('POST', `/events/${ev.id}/entries`, { token: pl.token, body: {} })).status, 409);
});
