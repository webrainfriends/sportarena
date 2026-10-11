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
  const r = await api('POST', '/auth/register', { body: { handle: `ab_${n}_${roles[0]}`, display_name: `Ab ${n}`, email: `ab${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const at = (offsetDays, hour, min = 0) => { const d = new Date(Date.now() + offsetDays * 864e5); d.setUTCHours(hour, min, 0, 0); return d.toISOString(); };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('personal blocks: validated, on the schedule, overlap-flagged, archived not deleted, private', async () => {
  const a = await signup(['athlete']), other = await signup(['athlete']), coach = await signup(['coach']);
  const body = { kind: 'recovery', starts_at: at(3, 10), ends_at: at(3, 11) };

  assert.equal((await api('POST', '/me/blocks', { body })).status, 401);
  assert.equal((await api('POST', '/me/blocks', { token: a.token, body: { ...body, ends_at: body.starts_at } })).status, 400, 'must end after it starts');
  assert.equal((await api('POST', '/me/blocks', { token: a.token, body: { ...body, kind: 'party' } })).status, 400);
  assert.equal((await api('POST', '/me/blocks', { token: a.token, body: { ...body, timezone: 'Mars/Base' } })).status, 400);
  assert.equal((await api('POST', '/me/blocks', { token: a.token, body: { ...body, ends_at: at(30, 11) } })).status, 400, 'at most 14 days');

  const made = await api('POST', '/me/blocks', { token: a.token, body: { ...body, timezone: 'Asia/Kolkata' } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const gym = (await api('POST', '/me/blocks', { token: a.token, body: { kind: 'gym', title: 'Leg day', starts_at: at(4, 6), ends_at: at(4, 7) } })).body;

  // overlaps a confirmed coaching session
  await pool.query(`INSERT INTO coach_hires(hirer_id, coach_id, starts_at, duration_min, status) VALUES ($1,$2,$3,60,'confirmed')`, [a.id, coach.id, at(3, 10, 30)]);

  const sched = (await api('GET', '/me/sport-schedule?kinds=recovery,training', { token: a.token })).body.items;
  const rec = sched.find((x) => x.source_id === made.body.id), g = sched.find((x) => x.source_id === gym.id);
  assert.equal(rec.kind, 'recovery'); assert.equal(rec.title, 'Recovery'); assert.equal(rec.timezone, 'Asia/Kolkata');
  assert.equal(g.title, 'Leg day'); assert.equal(g.context, 'Gym');
  assert.equal(rec.conflict, true, 'overlaps the coaching session');
  assert.equal(g.conflict, false);
  assert.equal((await api('GET', '/me/blocks', { token: a.token })).body.length, 2);
  assert.equal((await api('GET', '/me/sport-schedule?kinds=bogus', { token: a.token })).status, 400);

  // private: nobody else sees it or can remove it
  assert.equal((await api('GET', '/me/sport-schedule?kinds=recovery', { token: other.token })).body.items.length, 0);
  assert.equal((await api('GET', '/me/blocks', { token: other.token })).body.length, 0);
  assert.equal((await api('POST', `/me/blocks/${made.body.id}/archive`, { token: other.token })).status, 404);

  // archive hides it but keeps the row
  assert.equal((await api('POST', `/me/blocks/${made.body.id}/archive`, { token: a.token })).status, 200);
  assert.equal((await api('POST', `/me/blocks/${made.body.id}/archive`, { token: a.token })).status, 404, 'already archived');
  assert.ok(!(await api('GET', '/me/sport-schedule?kinds=recovery', { token: a.token })).body.items.some((x) => x.source_id === made.body.id));
  const row = (await pool.query('SELECT status, archived_at FROM athlete_blocks WHERE id=$1', [made.body.id])).rows[0];
  assert.equal(row.status, 'archived'); assert.ok(row.archived_at);
});

test('team items carry your RSVP (pending, then in / maybe / out) from the existing team attendance', async () => {
  const org = await signup(['organizer']), p = await signup(['athlete']), outsider = await signup(['athlete']);
  const ev = (await api('POST', '/events', { token: org.token, body: { name: 'RSVP Cup', sport: 'football', kind: 'tournament', starts_on: at(2, 0).slice(0, 10), ends_on: at(2, 0).slice(0, 10) } })).body;
  const mk = async (name) => (await api('POST', '/teams', { token: org.token, body: { name: `${name} ${Math.random().toString(36).slice(2, 6)}`, sport: 'football' } })).body.id;
  const [home, away] = [await mk('Home'), await mk('Away')];
  const fx = (await pool.query(`INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at, status) VALUES ($1,$2,$3,$4,'scheduled') RETURNING id`, [ev.id, home, away, at(2, 15)])).rows[0].id;
  await pool.query('INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,$3,$4)', [home, p.id, 'player', 'active']);

  const mine = async () => (await api('GET', '/me/sport-schedule?kinds=match', { token: p.token })).body.items.find((x) => x.source_id === `${fx}`);
  let item = await mine();
  assert.deepEqual(item.rsvp, { team_id: home, fixture_id: fx, event_id: null, value: 'pending' });

  for (const [rsvp] of [['going'], ['maybe'], ['no']]) {
    assert.equal((await api('POST', `/teams/${home}/attendance`, { token: p.token, body: { fixture_id: item.rsvp.fixture_id, rsvp } })).status, 200);
    assert.equal((await mine()).rsvp.value, rsvp);
  }
  // one answer per person: it did not create a second row
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM team_attendance WHERE team_id=$1 AND user_id=$2', [home, p.id])).rows[0].n, 1);
  // non-members still cannot answer, and see no team items
  assert.equal((await api('POST', `/teams/${home}/attendance`, { token: outsider.token, body: { fixture_id: fx, rsvp: 'going' } })).status, 403);
  assert.equal((await api('GET', '/me/sport-schedule?kinds=match', { token: outsider.token })).body.items.length, 0);
  // items that are not team commitments have no RSVP
  const own = (await api('POST', '/me/blocks', { token: p.token, body: { kind: 'rest', starts_at: at(5, 10), ends_at: at(5, 11) } })).body;
  assert.equal((await api('GET', '/me/sport-schedule?kinds=recovery', { token: p.token })).body.items.find((x) => x.source_id === own.id).rsvp, null);
});
