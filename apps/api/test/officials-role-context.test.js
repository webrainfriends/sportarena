// REF-R10: Tests for roleContext() — RBAC per fixture role.
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
    body: { handle: `rctx${n}`, display_name: `User ${n}`, email: `rctx${n}@example.com`, password: 'correct-horse-battery', roles },
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

async function makeFixtureWithRole(role) {
  const org = await signup(['organizer']);
  const official = await signup([]);
  const ev = (await api('POST', '/events', { token: org.token, body: { name: `RCtxEv${n}`, sport: 'football' } })).body;
  const fx = (await api('POST', `/events/${ev.id}/fixtures`, { token: org.token, body: { home_name: 'A', away_name: 'B', scheduled_at: at(1) } })).body;
  await api('POST', `/fixtures/${fx.id}/officials`, { token: org.token, body: { user_id: official.id, role } });
  // Accept the invitation
  const invite = (await api('GET', `/fixtures/${fx.id}/officials`, { token: official.token })).body;
  if (invite[0]?.id) {
    await api('POST', `/fixture-officials/${invite[0].id}/respond`, { token: official.token, body: { status: 'accepted' } });
  }
  return { org, official, fxId: fx.id };
}

test('referee can file and submit reports', async () => {
  const { official, fxId } = await makeFixtureWithRole('referee');
  const r = await api('GET', `/fixtures/${fxId}/permissions`, { token: official.token });
  assert.equal(r.status, 200);
  assert.equal(r.body.canFileReport, true);
  assert.equal(r.body.canSubmitReport, true);
  assert.equal(r.body.isChief, true);
});

test('scorer can score but not submit reports', async () => {
  const { official, fxId } = await makeFixtureWithRole('scorer');
  const r = await api('GET', `/fixtures/${fxId}/permissions`, { token: official.token });
  assert.equal(r.status, 200);
  assert.equal(r.body.canScore, true);
  assert.equal(r.body.canSubmitReport, false);
  assert.equal(r.body.isScorer, true);
});

test('fourth_official is observer only', async () => {
  const { official, fxId } = await makeFixtureWithRole('fourth_official');
  const r = await api('GET', `/fixtures/${fxId}/permissions`, { token: official.token });
  assert.equal(r.status, 200);
  assert.equal(r.body.canObserve, true);
  assert.equal(r.body.isObserver, true);
  assert.equal(r.body.canScore, false);
});

test('organiser can do everything', async () => {
  const org = await signup(['organizer']);
  const ev = (await api('POST', '/events', { token: org.token, body: { name: `RCtxOrgEv${n}`, sport: 'football' } })).body;
  const fx = (await api('POST', `/events/${ev.id}/fixtures`, { token: org.token, body: { home_name: 'A', away_name: 'B', scheduled_at: at(1) } })).body;
  const r = await api('GET', `/fixtures/${fx.id}/permissions`, { token: org.token });
  assert.equal(r.status, 200);
  assert.equal(r.body.organiser, true);
  assert.equal(r.body.canFileReport, true);
  assert.equal(r.body.canReadAllReports, true);
});

test('stranger is blocked from fixture', async () => {
  const org = await signup(['organizer']);
  const stranger = await signup([]);
  const ev = (await api('POST', '/events', { token: org.token, body: { name: `RCtxStrEv${n}`, sport: 'football' } })).body;
  const fx = (await api('POST', `/events/${ev.id}/fixtures`, { token: org.token, body: { home_name: 'A', away_name: 'B', scheduled_at: at(1) } })).body;
  const r = await api('GET', `/fixtures/${fx.id}/permissions`, { token: stranger.token });
  // Returns permission object — stranger gets all false flags (not an error; visibility of fixture is public via event)
  assert.equal(r.body.canScore, false);
  assert.equal(r.body.official, false);
  assert.equal(r.body.organiser, false);
});
