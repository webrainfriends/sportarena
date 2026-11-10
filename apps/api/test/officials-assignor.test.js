// REF-R10: Tests for assignor delegation capability.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
};

let n = 0;
const signup = async (roles = []) => {
  n++;
  const r = await api('POST', '/auth/register', {
    body: { handle: `asgn${n}`, display_name: `User ${n}`, email: `asgn${n}@example.com`, password: 'correct-horse-battery', roles },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const at = (d) => new Date(Date.now() + d * 864e5).toISOString();

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('organiser can grant assignor access', async () => {
  const org = await signup(['organizer']);
  const assignor = await signup([]);
  const ev = (await api('POST', '/events', { token: org.token, body: { name: `AsgnEv${n}`, sport: 'football' } })).body;
  const r = await api('POST', '/official-assignor/grant', { token: org.token, body: { event_id: ev.id, assignor_user_id: assignor.id } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.id, 'grant created');
});

test('assignor can invite official for a fixture in their event', async () => {
  const org = await signup(['organizer']);
  const assignor = await signup([]);
  const official = await signup([]);
  const ev = (await api('POST', '/events', { token: org.token, body: { name: `AsgnInvEv${n}`, sport: 'football' } })).body;
  const fx = (await api('POST', `/events/${ev.id}/fixtures`, { token: org.token, body: { home_name: 'A', away_name: 'B', scheduled_at: at(1) } })).body;
  await api('POST', '/official-assignor/grant', { token: org.token, body: { event_id: ev.id, assignor_user_id: assignor.id } });
  const r = await api('POST', '/official-assignor/invite', { token: assignor.token, body: { fixture_id: fx.id, user_id: official.id, role: 'referee' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.invited, true);
});

test('assignor hub returns no fee or PII columns', async () => {
  const org = await signup(['organizer']);
  const assignor = await signup([]);
  const ev = (await api('POST', '/events', { token: org.token, body: { name: `AsgnHubEv${n}`, sport: 'football' } })).body;
  await api('POST', '/official-assignor/grant', { token: org.token, body: { event_id: ev.id, assignor_user_id: assignor.id } });
  const r = await api('GET', '/official-assignor/hub', { token: assignor.token, body: undefined });
  // Hub endpoint takes event_id as query param — test via GET with params
  const r2 = await fetch(`${base}/api/v1/official-assignor/hub?event_id=${ev.id}`, {
    headers: { authorization: `Bearer ${assignor.token}` },
  });
  const body = await r2.json();
  // Verify no fee/PII fields
  const fixtures = body.fixtures ?? [];
  for (const fx of fixtures) {
    assert.ok(!('fee_minor' in fx), 'fee_minor must not be in fixture for assignor');
    assert.ok(!('bank_account' in fx), 'bank_account must not be in fixture');
  }
});

test('revoked assignor cannot invite officials', async () => {
  const org = await signup(['organizer']);
  const assignor = await signup([]);
  const official = await signup([]);
  const ev = (await api('POST', '/events', { token: org.token, body: { name: `AsgnRevEv${n}`, sport: 'football' } })).body;
  const fx = (await api('POST', `/events/${ev.id}/fixtures`, { token: org.token, body: { home_name: 'A', away_name: 'B', scheduled_at: at(1) } })).body;
  await api('POST', '/official-assignor/grant', { token: org.token, body: { event_id: ev.id, assignor_user_id: assignor.id } });
  await api('POST', '/official-assignor/revoke', { token: org.token, body: { event_id: ev.id, assignor_user_id: assignor.id } });
  const r = await api('POST', '/official-assignor/invite', { token: assignor.token, body: { fixture_id: fx.id, user_id: official.id, role: 'referee' } });
  assert.equal(r.status, 403, 'revoked assignor must be forbidden');
});
