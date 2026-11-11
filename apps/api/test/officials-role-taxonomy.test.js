// REF-R30: Official Role Taxonomy & Crew Templates (#1028).
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
  const email = `role-tax-${Math.random().toString(36).slice(2)}@example.com`;
  const r = await api('POST', '/api/v1/auth/register', { body: { email, password: 'Test1234!', name: 'Test User' } });
  assert.equal(r.status, 201, `register failed: ${JSON.stringify(r.body)}`);
  if (roles.length) {
    await pool.query('UPDATE users SET roles=$1 WHERE id=$2', [roles, r.body.user.id]);
  }
  return { token: r.body.token, id: r.body.user.id };
};

const createEventAndFixture = async (orgToken, orgId) => {
  const ev = await api('POST', '/api/v1/events', { token: orgToken, body: { name: 'Role Tax Event', sport_slug: 'football', start_date: '2027-07-01', end_date: '2027-07-02', timezone: 'UTC', organizer_id: orgId } });
  const eventId = ev.body.id ?? ev.body.event?.id;
  assert.ok(eventId, `event create failed: ${JSON.stringify(ev.body)}`);
  const fx = await api('POST', `/api/v1/events/${eventId}/fixtures`, { token: orgToken, body: { scheduled_at: '2027-07-01T10:00:00Z', duration_min: 90, sport_slug: 'football' } });
  const fixtureId = fx.body.id ?? fx.body.fixture?.id;
  assert.ok(fixtureId, `fixture create failed: ${JSON.stringify(fx.body)}`);
  return { eventId, fixtureId };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});

after(async () => { server.close(); await pool.end(); });

test('platform admin can seed official role taxonomy', async () => {
  const admin = await signup(['platform_admin']);
  const r = await api('POST', '/api/v1/official-roles/seed', {
    token: admin.token,
    body: { governing_body: 'FIFA', sport_code: 'football' },
  });
  assert.equal(r.status, 200, `seed failed: ${JSON.stringify(r.body)}`);
  assert.ok(Array.isArray(r.body.roles) || r.body.seeded >= 0, 'expected roles array or seeded count');
});

test('non-admin cannot seed official role taxonomy', async () => {
  const user = await signup([]);
  const r = await api('POST', '/api/v1/official-roles/seed', {
    token: user.token,
    body: { governing_body: 'FIFA', sport_code: 'football' },
  });
  assert.ok([401, 403].includes(r.status), `expected 401/403, got ${r.status}`);
});

test('list all official roles — authenticated', async () => {
  const user = await signup([]);
  const r = await api('GET', '/api/v1/official-roles', { token: user.token });
  assert.equal(r.status, 200, `list roles failed: ${JSON.stringify(r.body)}`);
  assert.ok(Array.isArray(r.body.roles), 'expected roles array');
});

test('list official roles — unauthenticated returns 401', async () => {
  const r = await api('GET', '/api/v1/official-roles');
  assert.equal(r.status, 401, `expected 401, got ${r.status}`);
});

test('upsert sport official role — platform admin', async () => {
  const admin = await signup(['platform_admin']);
  const r = await api('POST', '/api/v1/official-roles', {
    token: admin.token,
    body: {
      sport_code: 'tennis',
      role_key: 'chair_umpire',
      display_name: 'Chair Umpire',
      family: 'match_official',
      governing_body: 'ITF',
      min_count: 1,
      max_count: 1,
      mandatory: true,
      duties: ['Calls all points', 'Manages player conduct'],
      permissions: [{ key: 'award_code_violation', label: 'Award code violation', granted: true }],
    },
  });
  assert.ok([200, 201].includes(r.status), `upsert role failed: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.role?.role_key ?? r.body.role_key, 'chair_umpire');
});

test('get sport official role by id', async () => {
  const admin = await signup(['platform_admin']);
  // create a role first
  const cr = await api('POST', '/api/v1/official-roles', {
    token: admin.token,
    body: { sport_code: 'cricket', role_key: 'match_commissioner', display_name: 'Match Commissioner', family: 'administrative_official', governing_body: 'ICC', min_count: 1, max_count: 1, mandatory: true, duties: [], permissions: [] },
  });
  const id = cr.body.role?.id ?? cr.body.id;
  assert.ok(id, 'no id returned from upsert');

  const r = await api('GET', `/api/v1/official-roles/${id}`, { token: admin.token });
  assert.equal(r.status, 200, `get role failed: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.role?.role_key ?? r.body.role_key, 'match_commissioner');
});

test('archive sport official role — platform admin only', async () => {
  const admin = await signup(['platform_admin']);
  const cr = await api('POST', '/api/v1/official-roles', {
    token: admin.token,
    body: { sport_code: 'athletics', role_key: 'starter', display_name: 'Starter', family: 'match_official', governing_body: 'World Athletics', min_count: 1, max_count: 2, mandatory: true, duties: [], permissions: [] },
  });
  const id = cr.body.role?.id ?? cr.body.id;
  assert.ok(id, 'no id from upsert');

  const r = await api('POST', `/api/v1/official-roles/${id}/archive`, { token: admin.token });
  assert.equal(r.status, 200, `archive failed: ${JSON.stringify(r.body)}`);
});

test('non-admin cannot archive official role', async () => {
  const admin = await signup(['platform_admin']);
  const user = await signup([]);
  const cr = await api('POST', '/api/v1/official-roles', {
    token: admin.token,
    body: { sport_code: 'basketball', role_key: 'shot_clock_operator', display_name: 'Shot Clock', family: 'technical_official', governing_body: 'FIBA', min_count: 1, max_count: 1, mandatory: false, duties: [], permissions: [] },
  });
  const id = cr.body.role?.id ?? cr.body.id;
  assert.ok(id, 'no id from upsert');

  const r = await api('POST', `/api/v1/official-roles/${id}/archive`, { token: user.token });
  assert.ok([401, 403].includes(r.status), `expected 401/403, got ${r.status}`);
});

test('create crew template — platform admin', async () => {
  const admin = await signup(['platform_admin']);
  const r = await api('POST', '/api/v1/crew-templates', {
    token: admin.token,
    body: {
      sport_code: 'football',
      match_format: '11v11',
      level: 'club',
      governing_body: 'FIFA',
      name: 'Club 11v11 Standard',
      description: 'Standard club crew template for 11v11 football.',
    },
  });
  assert.ok([200, 201].includes(r.status), `create template failed: ${JSON.stringify(r.body)}`);
  const id = r.body.template?.id ?? r.body.id;
  assert.ok(id, 'no id from create');
  return id;
});

test('update crew template slots — draft only', async () => {
  const admin = await signup(['platform_admin']);
  const cr = await api('POST', '/api/v1/crew-templates', {
    token: admin.token,
    body: { sport_code: 'football', match_format: '11v11', level: 'national', governing_body: 'FIFA', name: 'National 11v11' },
  });
  const id = cr.body.template?.id ?? cr.body.id;
  assert.ok(id, 'no id');

  const r = await api('PUT', `/api/v1/crew-templates/${id}/slots`, {
    token: admin.token,
    body: {
      slots: [
        { role_key: 'referee', display_name: 'Referee', family: 'match_official', min_count: 1, max_count: 1, mandatory: true, duties: ['Controls the match'], permissions: [], requires_credentials: [], position_order: 0 },
        { role_key: 'linesman', display_name: 'Assistant Referee', family: 'match_official', min_count: 2, max_count: 2, mandatory: true, duties: [], permissions: [], requires_credentials: [], position_order: 1 },
      ],
    },
  });
  assert.ok([200, 201].includes(r.status), `update slots failed: ${JSON.stringify(r.body)}`);
});

test('publish crew template — platform admin, sets content_hash', async () => {
  const admin = await signup(['platform_admin']);
  const cr = await api('POST', '/api/v1/crew-templates', {
    token: admin.token,
    body: { sport_code: 'tennis', match_format: 'singles', level: 'international', governing_body: 'ITF', name: 'ATP Grand Slam Singles' },
  });
  const id = cr.body.template?.id ?? cr.body.id;
  await api('PUT', `/api/v1/crew-templates/${id}/slots`, {
    token: admin.token,
    body: { slots: [{ role_key: 'chair_umpire', display_name: 'Chair Umpire', family: 'match_official', min_count: 1, max_count: 1, mandatory: true, duties: [], permissions: [], requires_credentials: [], position_order: 0 }] },
  });

  const r = await api('POST', `/api/v1/crew-templates/${id}/publish`, { token: admin.token, body: {} });
  assert.equal(r.status, 200, `publish failed: ${JSON.stringify(r.body)}`);
  assert.ok(r.body.template?.content_hash ?? r.body.content_hash, 'expected content_hash');
});

test('non-admin cannot publish crew template', async () => {
  const admin = await signup(['platform_admin']);
  const user = await signup([]);
  const cr = await api('POST', '/api/v1/crew-templates', {
    token: admin.token,
    body: { sport_code: 'cricket', match_format: 'T20', level: 'domestic', governing_body: 'ICC', name: 'T20 Club' },
  });
  const id = cr.body.template?.id ?? cr.body.id;

  const r = await api('POST', `/api/v1/crew-templates/${id}/publish`, { token: user.token, body: {} });
  assert.ok([401, 403].includes(r.status), `expected 401/403, got ${r.status}`);
});

test('apply crew template to event — event organiser', async () => {
  const admin = await signup(['platform_admin']);
  const org = await signup(['organizer']);
  const { eventId } = await createEventAndFixture(org.token, org.id);

  // create and publish a template
  const cr = await api('POST', '/api/v1/crew-templates', {
    token: admin.token,
    body: { sport_code: 'football', match_format: '11v11', level: 'club', governing_body: 'FIFA', name: 'Apply Test Template' },
  });
  const tid = cr.body.template?.id ?? cr.body.id;
  await api('PUT', `/api/v1/crew-templates/${tid}/slots`, {
    token: admin.token,
    body: { slots: [{ role_key: 'referee', display_name: 'Referee', family: 'match_official', min_count: 1, max_count: 1, mandatory: true, duties: [], permissions: [], requires_credentials: [], position_order: 0 }] },
  });
  await api('POST', `/api/v1/crew-templates/${tid}/publish`, { token: admin.token, body: {} });

  const r = await api('POST', `/api/v1/events/${eventId}/apply-crew-template`, {
    token: org.token,
    body: { template_id: tid },
  });
  assert.equal(r.status, 200, `apply template failed: ${JSON.stringify(r.body)}`);
});

test('non-organiser cannot apply crew template to event', async () => {
  const admin = await signup(['platform_admin']);
  const org = await signup(['organizer']);
  const other = await signup([]);
  const { eventId } = await createEventAndFixture(org.token, org.id);

  const cr = await api('POST', '/api/v1/crew-templates', {
    token: admin.token,
    body: { sport_code: 'football', match_format: '11v11', level: 'club', governing_body: 'FIFA', name: 'NoApply Template' },
  });
  const tid = cr.body.template?.id ?? cr.body.id;
  await api('POST', `/api/v1/crew-templates/${tid}/publish`, { token: admin.token, body: {} });

  const r = await api('POST', `/api/v1/events/${eventId}/apply-crew-template`, {
    token: other.token,
    body: { template_id: tid },
  });
  assert.ok([401, 403, 404].includes(r.status), `expected 401/403/404, got ${r.status}`);
});

test('list crew templates — sport filter', async () => {
  const user = await signup([]);
  const r = await api('GET', '/api/v1/crew-templates?sport_code=football&status=published', { token: user.token });
  assert.equal(r.status, 200, `list templates failed: ${JSON.stringify(r.body)}`);
  assert.ok(Array.isArray(r.body.templates), 'expected templates array');
});

test('archive crew template — platform admin', async () => {
  const admin = await signup(['platform_admin']);
  const cr = await api('POST', '/api/v1/crew-templates', {
    token: admin.token,
    body: { sport_code: 'basketball', match_format: '5v5', level: 'club', governing_body: 'FIBA', name: 'Archive Test Template' },
  });
  const id = cr.body.template?.id ?? cr.body.id;
  assert.ok(id, 'no id');

  const r = await api('POST', `/api/v1/crew-templates/${id}/archive`, { token: admin.token, body: {} });
  assert.equal(r.status, 200, `archive failed: ${JSON.stringify(r.body)}`);
});
