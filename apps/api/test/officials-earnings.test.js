// Tests for officials-earnings capability (#1019)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');

let server, baseUrl;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://localhost:${server.address().port}/api/v1`;
});

after(() => { server?.close(); pool.end(); });

async function signup(roles = ['referee']) {
  const email = `official+${Date.now()}+${Math.random().toString(36).slice(2)}@test.local`;
  await pool.query(
    "INSERT INTO users(id, email, display_name, roles) VALUES (gen_random_uuid(), $1, 'Test Official', $2) ON CONFLICT DO NOTHING",
    [email, roles],
  );
  const { rows } = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
  const user = rows[0];
  return { ...user, token: signToken({ id: user.id, roles }) };
}

async function api(method, path, { token, query } = {}) {
  const url = new URL(baseUrl + path);
  if (query) Object.entries(query).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

function must(r, status = 200) {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
}

// Seed a fixture_official with fee for testing
async function seedAssignment(userId, payStatus = 'paid', feeMinor = 15000, currency = 'GBP') {
  const orgId = (await pool.query("INSERT INTO organisations(id, name, kind) VALUES (gen_random_uuid(), 'Test Org', 'club') RETURNING id")).rows[0].id;
  const sportId = (await pool.query("INSERT INTO sports(id, name, slug, emoji) VALUES (gen_random_uuid(), 'Football', 'football', '⚽') ON CONFLICT (slug) DO UPDATE SET slug=sports.slug RETURNING id")).rows[0].id;
  const eventId = (await pool.query('INSERT INTO events(id, org_id, name, status, sport_id) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id', [orgId, 'Test Event', 'active', sportId])).rows[0].id;
  const fixtureId = (await pool.query("INSERT INTO fixtures(id, event_id, name, status) VALUES (gen_random_uuid(), $1, 'Test Match', 'completed') RETURNING id", [eventId])).rows[0].id;
  const foId = (await pool.query(
    'INSERT INTO fixture_officials(id, fixture_id, user_id, sport_id, role, status, fee_minor, fee_currency, pay_status, scheduled_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, now() - interval \'7 days\') RETURNING id',
    [fixtureId, userId, sportId, 'referee', 'accepted', feeMinor, currency, payStatus],
  )).rows[0].id;
  return { orgId, sportId, eventId, fixtureId, foId };
}

test('earnings summary — returns per-currency aggregate', async () => {
  const user = await signup();
  await seedAssignment(user.id, 'paid', 10000, 'GBP');
  await seedAssignment(user.id, 'due', 5000, 'GBP');
  await seedAssignment(user.id, 'paid', 8000, 'EUR');

  const r = must(await api('GET', '/me/officials/earnings', { token: user.token }));
  assert.ok(Array.isArray(r.summary));
  const gbp = r.summary.find((s) => s.currency === 'GBP');
  assert.ok(gbp, 'GBP row expected');
  assert.equal(gbp.paid.minor, 10000);
  assert.equal(gbp.due.minor, 5000);
  const eur = r.summary.find((s) => s.currency === 'EUR');
  assert.ok(eur, 'EUR row expected');
});

test('earnings summary — empty for new official', async () => {
  const user = await signup();
  const r = must(await api('GET', '/me/officials/earnings', { token: user.token }));
  assert.deepEqual(r.summary, []);
});

test('earnings entries — paginated list', async () => {
  const user = await signup();
  for (let i = 0; i < 3; i++) await seedAssignment(user.id, 'paid', 12000, 'GBP');

  const r = must(await api('GET', '/me/officials/earnings/entries', { token: user.token, query: { limit: 2 } }));
  assert.ok(r.total >= 3);
  assert.equal(r.entries.length, 2);
  assert.ok(r.entries[0].fixture_name, 'fixture_name present');
  assert.ok(r.entries[0].event_name, 'event_name present');
});

test('earnings entries — filter by pay_status', async () => {
  const user = await signup();
  await seedAssignment(user.id, 'paid', 10000, 'GBP');
  await seedAssignment(user.id, 'due', 5000, 'GBP');

  const r = must(await api('GET', '/me/officials/earnings/entries', { token: user.token, query: { pay_status: 'due' } }));
  assert.ok(r.entries.every((e) => e.pay_status === 'due'));
});

test('earnings aggregated — group by sport', async () => {
  const user = await signup();
  await seedAssignment(user.id, 'paid', 20000, 'GBP');

  const r = must(await api('GET', '/me/officials/earnings/summary-by', { token: user.token, query: { group_by: 'sport' } }));
  assert.ok(Array.isArray(r.rows));
  assert.equal(r.group_by, 'sport');
  assert.ok(r.rows.length > 0);
});

test('earnings aggregated — group by month', async () => {
  const user = await signup();
  await seedAssignment(user.id, 'paid', 15000, 'GBP');

  const r = must(await api('GET', '/me/officials/earnings/summary-by', { token: user.token, query: { group_by: 'month' } }));
  assert.ok(Array.isArray(r.rows));
  assert.equal(r.group_by, 'month');
});

test('earnings CSV export — returns csv content', async () => {
  const user = await signup();
  await seedAssignment(user.id, 'paid', 25000, 'GBP');

  const r = must(await api('GET', '/me/officials/earnings/export', { token: user.token }));
  assert.equal(r.content_type, 'text/csv');
  assert.ok(r.content.includes('Date'), 'CSV headers present');
  assert.ok(r.content.includes('GBP'), 'currency in CSV');
  assert.ok(r.filename.endsWith('.csv'));
});

test('earnings trend — returns monthly data', async () => {
  const user = await signup();
  await seedAssignment(user.id, 'paid', 10000, 'GBP');

  const r = must(await api('GET', '/me/officials/earnings/trend', { token: user.token, query: { months: 12 } }));
  assert.ok(Array.isArray(r.trend));
  assert.equal(r.months, 12);
});

test('top events — returns ranked event earnings', async () => {
  const user = await signup();
  await seedAssignment(user.id, 'paid', 50000, 'GBP');

  const r = must(await api('GET', '/me/officials/earnings/top-events', { token: user.token }));
  assert.ok(Array.isArray(r.events));
  assert.ok(r.events[0].event_name);
});

test('earnings — unauthorized without token', async () => {
  const r = await api('GET', '/me/officials/earnings');
  must(r, 401);
});
