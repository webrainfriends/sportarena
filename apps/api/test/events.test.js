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
  const r = await api('POST', '/auth/register', { body: { handle: `ev_${n}_${roles[0]}`, display_name: `Ev ${n}`, email: `ev${n}@example.com`, password: 'correct-horse-battery', roles } });
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

test('search_events filters, sorts and pages server-side with a total', async () => {
  const org = await signup(['organizer']);
  const mk = (b) => api('POST', '/events', { token: org.token, body: b });
  await mk({ name: 'Mumbai Cup', sport: 'football', city: 'Mumbai', starts_on: day(5), ends_on: day(6), entry_fee_cents: 0 });
  await mk({ name: 'Pune Open', sport: 'badminton', kind: 'league', city: 'Pune', starts_on: day(40), ends_on: day(41), entry_fee_cents: 50000, seeking_sponsors: true });
  await mk({ name: 'Past Camp', sport: 'football', kind: 'camp', city: 'Mumbai', starts_on: day(-9), ends_on: day(-8), entry_fee_cents: 10000 });

  const all = await api('GET', '/events/search');
  assert.equal(all.status, 200);
  assert.equal(all.body.total, 3);
  assert.equal(all.body.items[0].link, `/events/${all.body.items[0].id}`);
  assert.ok('registration_open' in all.body.items[0] && 'spots_left' in all.body.items[0]);

  const q = (s) => api('GET', `/events/search?${s}`).then((r) => r.body);
  assert.deepEqual((await q('city=mumbai')).items.map((e) => e.name).sort(), ['Mumbai Cup', 'Past Camp']);
  assert.deepEqual((await q('sport=badminton')).items.map((e) => e.name), ['Pune Open']);
  assert.deepEqual((await q(`date_from=${day(30)}`)).items.map((e) => e.name), ['Pune Open']);
  assert.deepEqual((await q(`date_to=${day(10)}&date_from=${day(0)}`)).items.map((e) => e.name), ['Mumbai Cup']);
  assert.deepEqual((await q('free=true')).items.map((e) => e.name), ['Mumbai Cup']);
  assert.deepEqual((await q('seeking_sponsors=true')).items.map((e) => e.name), ['Pune Open']);
  assert.deepEqual((await q('kind=camp')).items.map((e) => e.name), ['Past Camp']);
  assert.deepEqual((await q('max_fee_cents=20000&sort=fee_low')).items.map((e) => e.name), ['Mumbai Cup', 'Past Camp']);
  const p1 = await q('limit=2&offset=0');
  const p2 = await q('limit=2&offset=2');
  assert.equal(p1.items.length, 2); assert.equal(p2.items.length, 1); assert.equal(p1.total, 3);
  assert.equal((await q('sport=nonexistent')).total, 0);
  assert.equal((await q('verified=true')).total, 0);
  assert.ok(Array.isArray((await api('GET', '/events')).body), 'list_events keeps its plain array shape');
});

test('capacity, deadline, waitlist promotion and withdraw', async () => {
  const org = await signup(['organizer']);
  const [a, b, c] = await Promise.all([signup(['athlete']), signup(['athlete']), signup(['athlete'])]);
  const ev = (await api('POST', '/events', { token: org.token, body: { name: 'Tiny Open', sport: 'tennis', capacity: 2 } })).body;
  assert.equal(ev.capacity, 2);
  const ea = (await api('POST', `/events/${ev.id}/entries`, { token: a.token })).body;
  const eb = (await api('POST', `/events/${ev.id}/entries`, { token: b.token })).body;
  const ec = await api('POST', `/events/${ev.id}/entries`, { token: c.token });
  assert.equal(ec.status, 201);
  assert.equal(ec.body.status, 'waitlisted');
  assert.equal((await api('GET', `/events/search?q=Tiny`)).body.items[0].spots_left, 0);

  assert.equal((await api('PATCH', `/entries/${ea.id}`, { token: org.token, body: { status: 'accepted' } })).status, 200);
  assert.equal((await api('POST', `/entries/${ea.id}/withdraw`, { token: b.token })).status, 403, 'not your entry');
  assert.equal((await api('POST', `/entries/${eb.id}/withdraw`, { token: b.token })).status, 200);
  const mine = await api('GET', `/events/${ev.id}/entries`, { token: org.token });
  assert.equal(mine.body.find((e) => e.id === ec.body.id).status, 'pending', 'waitlisted entry promoted');
  assert.equal((await api('POST', `/entries/${eb.id}/withdraw`, { token: b.token })).status, 409, 'already withdrawn');
  // withdrawn entrant can re-register (joins the waitlist behind a full event)
  const again = await api('POST', `/events/${ev.id}/entries`, { token: b.token });
  assert.equal(again.status, 201); assert.equal(again.body.status, 'waitlisted');
  // accepting beyond capacity is refused
  assert.equal((await api('PATCH', `/entries/${ec.body.id}`, { token: org.token, body: { status: 'accepted' } })).status, 200);
  assert.equal((await api('PATCH', `/entries/${again.body.id}`, { token: org.token, body: { status: 'accepted' } })).status, 409);
  assert.equal((await api('PATCH', `/events/${ev.id}`, { token: org.token, body: { capacity: 1 } })).status, 409, 'cannot shrink below accepted');

  const closed = (await api('POST', '/events', { token: org.token, body: { name: 'Closed', sport: 'tennis', registration_deadline: new Date(Date.now() + 1500).toISOString() } })).body;
  await new Promise((r) => setTimeout(r, 1700));
  assert.equal((await api('POST', `/events/${closed.id}/entries`, { token: a.token })).status, 409);
  assert.equal((await api('GET', `/events/search?open_for_entry=true&q=Closed`)).body.total, 0);
});

test('status transitions are guarded and cancelling notifies entrants', async () => {
  const org = await signup(['organizer']);
  const p = await signup(['athlete']);
  const ev = (await api('POST', '/events', { token: org.token, body: { name: 'Guarded', sport: 'football' } })).body;
  await api('POST', `/events/${ev.id}/entries`, { token: p.token });
  assert.equal((await api('PATCH', `/events/${ev.id}`, { token: p.token, body: { name: 'Hijack' } })).status, 403);
  assert.equal((await api('PATCH', `/events/${ev.id}`, { token: org.token, body: { starts_on: day(5), ends_on: day(2) } })).status, 400);
  assert.equal((await api('PATCH', `/events/${ev.id}`, { token: org.token, body: { status: 'cancelled' } })).status, 200);
  assert.equal((await api('PATCH', `/events/${ev.id}`, { token: org.token, body: { status: 'ongoing' } })).status, 409, 'cancelled is terminal');
  const inbox = await pool.query("SELECT kind FROM notifications WHERE user_id=$1", [p.id]);
  assert.ok(inbox.rows.some((r) => r.kind === 'event_cancelled'));
  assert.equal((await api('POST', `/events/${ev.id}/entries`, { token: (await signup(['athlete'])).token })).status, 409);
});
