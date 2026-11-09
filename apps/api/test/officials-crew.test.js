import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';

const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

const signup = async (roles = []) => {
  const email = `crew-test-${Math.random().toString(36).slice(2)}@example.com`;
  const r = await api('POST', '/api/v1/auth/register', { body: { email, password: 'Test1234!', name: 'Test User' } });
  assert.equal(r.status, 201, `register failed: ${JSON.stringify(r.body)}`);
  if (roles.length) {
    await pool.query(`UPDATE users SET roles=$1 WHERE id=$2`, [roles, r.body.user.id]);
  }
  return { token: r.body.token, id: r.body.user.id };
};

const createEventAndFixture = async (orgToken, orgId) => {
  // minimal event
  const ev = await api('POST', '/api/v1/events', { token: orgToken, body: { name: 'Crew Test Event', sport_slug: 'football', start_date: '2027-06-01', end_date: '2027-06-02', timezone: 'UTC', organizer_id: orgId } });
  const eventId = ev.body.id ?? ev.body.event?.id;
  if (!eventId) throw new Error(`event create failed: ${JSON.stringify(ev.body)}`);
  const fx = await api('POST', `/api/v1/events/${eventId}/fixtures`, { token: orgToken, body: { scheduled_at: '2027-06-01T10:00:00Z', duration_min: 90, sport_slug: 'football' } });
  const fixtureId = fx.body.id ?? fx.body.fixture?.id;
  if (!fixtureId) throw new Error(`fixture create failed: ${JSON.stringify(fx.body)}`);
  return { eventId, fixtureId };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});

after(async () => { server.close(); await pool.end(); });

test('set and get event crew requirements', async () => {
  const org = await signup(['organizer']);
  const { eventId } = await createEventAndFixture(org.token, org.id);

  const set = await api('POST', `/api/v1/events/${eventId}/crew-requirements`, {
    token: org.token,
    body: { requirements: [
      { role: 'referee', min_count: 1, max_count: 1, mandatory: true },
      { role: 'linesman', min_count: 2, max_count: 2, mandatory: true },
      { role: 'fourth_official', min_count: 1, max_count: 1, mandatory: false },
    ] },
  });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.requirements.length, 3);

  const get = await api('GET', `/api/v1/events/${eventId}/crew-requirements`, { token: org.token });
  assert.equal(get.status, 200);
  assert.equal(get.body.requirements.length, 3);
  assert.ok(get.body.requirements.some((r) => r.role === 'fourth_official'));
});

test('set crew requirements validates max_count >= min_count', async () => {
  const org = await signup(['organizer']);
  const { eventId } = await createEventAndFixture(org.token, org.id);

  const r = await api('POST', `/api/v1/events/${eventId}/crew-requirements`, {
    token: org.token,
    body: { requirements: [{ role: 'referee', min_count: 3, max_count: 1, mandatory: true }] },
  });
  assert.equal(r.status, 400, JSON.stringify(r.body));
});

test('crew hub returns accepted crew and completeness', async () => {
  const org = await signup(['organizer']);
  const official = await signup([]);
  // give official a sport profile so eligibility passes
  await pool.query(`INSERT INTO active_sport_profiles(user_id, role, sport_id) SELECT $1, 'referee', id FROM sports WHERE slug='football' LIMIT 1 ON CONFLICT DO NOTHING`, [official.id]);

  const { eventId, fixtureId } = await createEventAndFixture(org.token, org.id);
  // invite
  const inv = await api('POST', `/api/v1/fixtures/${fixtureId}/officials`, { token: org.token, body: { user_id: official.id, role: 'referee' } });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  const foId = inv.body.id;
  // accept
  const acc = await api('POST', `/api/v1/official-assignments/${foId}/respond`, { token: official.token, body: { response: 'accept' } });
  assert.equal(acc.status, 200, JSON.stringify(acc.body));

  const hub = await api('GET', `/api/v1/fixtures/${fixtureId}/crew-hub`, { token: org.token });
  assert.equal(hub.status, 200, JSON.stringify(hub.body));
  assert.ok(hub.body.assignments.some((a) => a.status === 'accepted'));
});

test('update official duties', async () => {
  const org = await signup(['organizer']);
  const official = await signup([]);
  await pool.query(`INSERT INTO active_sport_profiles(user_id, role, sport_id) SELECT $1, 'referee', id FROM sports WHERE slug='football' LIMIT 1 ON CONFLICT DO NOTHING`, [official.id]);

  const { fixtureId } = await createEventAndFixture(org.token, org.id);
  const inv = await api('POST', `/api/v1/fixtures/${fixtureId}/officials`, { token: org.token, body: { user_id: official.id, role: 'linesman' } });
  const foId = inv.body.id;
  await api('POST', `/api/v1/official-assignments/${foId}/respond`, { token: official.token, body: { response: 'accept' } });

  const r = await api('PATCH', `/api/v1/official-assignments/${foId}/duties`, { token: org.token, body: { duties: ['Goal north', 'Corner flag east'] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.duties, ['Goal north', 'Corner flag east']);
});

test('emergency substitute official', async () => {
  const org = await signup(['organizer']);
  const original = await signup([]);
  const replacement = await signup([]);
  await pool.query(`INSERT INTO active_sport_profiles(user_id, role, sport_id) SELECT $1, 'referee', id FROM sports WHERE slug='football' LIMIT 1 ON CONFLICT DO NOTHING`, [original.id]);
  await pool.query(`INSERT INTO active_sport_profiles(user_id, role, sport_id) SELECT $1, 'referee', id FROM sports WHERE slug='football' LIMIT 1 ON CONFLICT DO NOTHING`, [replacement.id]);

  const { fixtureId } = await createEventAndFixture(org.token, org.id);
  const inv = await api('POST', `/api/v1/fixtures/${fixtureId}/officials`, { token: org.token, body: { user_id: original.id, role: 'referee' } });
  const foId = inv.body.id;
  await api('POST', `/api/v1/official-assignments/${foId}/respond`, { token: original.token, body: { response: 'accept' } });

  const sub = await api('POST', `/api/v1/official-assignments/${foId}/substitute`, {
    token: org.token, body: { replacement_user_id: replacement.id, reason: 'Injury during warm-up' },
  });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  assert.equal(sub.body.original.status, 'substituted');
  assert.equal(sub.body.replacement.status, 'accepted');
  assert.equal(sub.body.replacement.emergency_accept, true);
  assert.equal(sub.body.replacement.substitution_of, foId);
});

test('cannot substitute a non-accepted official', async () => {
  const org = await signup(['organizer']);
  const official = await signup([]);
  await pool.query(`INSERT INTO active_sport_profiles(user_id, role, sport_id) SELECT $1, 'referee', id FROM sports WHERE slug='football' LIMIT 1 ON CONFLICT DO NOTHING`, [official.id]);

  const { fixtureId } = await createEventAndFixture(org.token, org.id);
  const inv = await api('POST', `/api/v1/fixtures/${fixtureId}/officials`, { token: org.token, body: { user_id: official.id, role: 'referee' } });
  // foId is still in 'invited' state — not accepted
  const foId = inv.body.id;

  const sub = await api('POST', `/api/v1/official-assignments/${foId}/substitute`, {
    token: org.token, body: { replacement_user_id: official.id, reason: 'Test' },
  });
  assert.equal(sub.status, 409, JSON.stringify(sub.body));
});

test('crew broadcast: post and retrieve message', async () => {
  const org = await signup(['organizer']);
  const official = await signup([]);
  await pool.query(`INSERT INTO active_sport_profiles(user_id, role, sport_id) SELECT $1, 'referee', id FROM sports WHERE slug='football' LIMIT 1 ON CONFLICT DO NOTHING`, [official.id]);

  const { fixtureId } = await createEventAndFixture(org.token, org.id);
  const inv = await api('POST', `/api/v1/fixtures/${fixtureId}/officials`, { token: org.token, body: { user_id: official.id, role: 'referee' } });
  await api('POST', `/api/v1/official-assignments/${inv.body.id}/respond`, { token: official.token, body: { response: 'accept' } });

  const msg = await api('POST', `/api/v1/fixtures/${fixtureId}/crew-broadcast`, {
    token: org.token, body: { body: 'Meeting at tunnel 13:30', pinned: true },
  });
  assert.equal(msg.status, 201, JSON.stringify(msg.body));
  assert.equal(msg.body.pinned, true);

  const hub = await api('GET', `/api/v1/fixtures/${fixtureId}/crew-hub`, { token: org.token });
  assert.ok(hub.body.broadcast.some((m) => m.pinned && m.body.includes('13:30')));
});
