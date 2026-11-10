// REF-R10: Tests for AI crew requirements capability.
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
const signup = async (roles = [], email) => {
  n++;
  const r = await api('POST', '/auth/register', {
    body: { handle: `cai${n}`, display_name: `User ${n}`, email: email ?? `cai${n}@example.com`, password: 'correct-horse-battery', roles },
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

test('platform admin can seed crew catalog', async () => {
  const admin = await signup(['admin', 'platform_admin'], 'rraja.edge@gmail.com');
  const r = await api('POST', '/crew-ai/catalog/seed', {
    token: admin.token,
    body: {
      entries: [
        { sport: 'football', governing_body: 'FIFA', crew_role: 'referee', min_required: 1, recommended: 1 },
        { sport: 'football', governing_body: 'FIFA', crew_role: 'assistant_referee', min_required: 2, recommended: 2 },
        { sport: 'football', governing_body: 'FIFA', crew_role: 'fourth_official', min_required: 1, recommended: 1 },
      ],
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.upserted, 3);
});

test('suggest_crew_requirements returns suggestions based on catalog', async () => {
  const admin = await signup(['admin', 'platform_admin'], 'rrajas1978@icloud.com');
  // Seed catalog
  await api('POST', '/crew-ai/catalog/seed', {
    token: admin.token,
    body: { entries: [{ sport: 'football', governing_body: 'FIFA', crew_role: 'referee', min_required: 1, recommended: 1 }] },
  });
  const org = await signup(['organizer']);
  const ev = (await api('POST', '/events', { token: org.token, body: { name: `CAIEv${n}`, sport: 'football' } })).body;
  const fx = (await api('POST', `/events/${ev.id}/fixtures`, { token: org.token, body: { home_name: 'A', away_name: 'B', scheduled_at: at(1) } })).body;
  const r = await api('POST', '/crew-ai/suggest', { token: org.token, body: { fixture_id: fx.id } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(Array.isArray(r.body.suggestions), 'suggestions array expected');
  assert.ok(r.body.suggestions.length > 0, 'at least one suggestion from catalog');
});

test('deficit triggers alert creation', async () => {
  const admin = await signup(['admin', 'platform_admin'], 'rraja.edge@gmail.com');
  await api('POST', '/crew-ai/catalog/seed', {
    token: admin.token,
    body: { entries: [{ sport: 'football', governing_body: 'FIFA', crew_role: 'referee', min_required: 1, recommended: 1 }] },
  });
  const org = await signup(['organizer']);
  const ev = (await api('POST', '/events', { token: org.token, body: { name: `CAIAlertEv${n}`, sport: 'football' } })).body;
  const fx = (await api('POST', `/events/${ev.id}/fixtures`, { token: org.token, body: { home_name: 'A', away_name: 'B', scheduled_at: at(1) } })).body;
  const r = await api('POST', '/crew-ai/suggest', { token: org.token, body: { fixture_id: fx.id } });
  assert.equal(r.body.deficit_exists, true);
  // Alerts should exist for organiser
  const alerts = await api('GET', '/crew-ai/alerts', { token: org.token });
  assert.equal(alerts.status, 200);
  const myAlerts = alerts.body.filter((a) => a.fixture_id === fx.id);
  assert.ok(myAlerts.length > 0, 'deficit alert created for organiser');
});

test('platform admin can configure crew penalty', async () => {
  const admin = await signup(['admin', 'platform_admin'], 'rraja.edge@gmail.com');
  const org = await signup(['organizer']);
  const ev = (await api('POST', '/events', { token: org.token, body: { name: `CAIPenEv${n}`, sport: 'football' } })).body;
  const r = await api('POST', '/crew-ai/penalty-config', {
    token: admin.token,
    body: { event_id: ev.id, penalty_type: 'points_deduction', penalty_value: 3, applies_after: 2 },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.penalty_type, 'points_deduction');
});

test('non-platform-admin cannot configure penalty', async () => {
  const org = await signup(['organizer']);
  const ev = (await api('POST', '/events', { token: org.token, body: { name: `CAIPenDenyEv${n}`, sport: 'football' } })).body;
  const r = await api('POST', '/crew-ai/penalty-config', {
    token: org.token,
    body: { event_id: ev.id, penalty_type: 'warning_only', penalty_value: 0, applies_after: 1 },
  });
  assert.equal(r.status, 403);
});
