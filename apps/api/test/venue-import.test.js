import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp', PLATFORM_APPROVALS: 'on',
  PLATFORM_ADMIN_EMAIL: 'platform-owner@example.com', PLATFORM_ADMIN_EMAILS: 'platform-owner@example.com',
  PLATFORM_ADMIN_PASSWORD: 'owner-test-pass', PLATFORM_ADMIN_HANDLE: 'platformarena',
});
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { initKeys } = await import('../src/crypto.js');
const { bootstrapPlatformOwner } = await import('../src/platform.js');

let server, base, n = 0, platform, orgOwner, orgId;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `vi_${n}_${roles[0]}`, display_name: `VI Test ${n}`, email: `vi${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201);
  return { ...r.body.user, token: r.body.token };
};

// Minimal valid CSV for testing
const CSV_VALID = `name,city,country,sports,court_count,base_rate_minor,currency,hours_open,hours_close,timezone
Koramangala Indoor,Bangalore,India,basketball,3,80000,INR,06:00,22:00,Asia/Kolkata
HSR Badminton Arena,Bangalore,India,badminton,4,60000,INR,05:00,23:00,Asia/Kolkata
Whitefield Tennis Club,Bangalore,India,tennis,2,120000,INR,06:00,21:00,Asia/Kolkata`;

const CSV_WITH_ERRORS = `name,city,sports,court_count,base_rate_minor,currency
,Mumbai,cricket,2,50000,INR
Arena Two,,badminton,3,not_a_number,INR
Valid Arena,Pune,squash,1,40000,INR`;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  await initKeys();
  await bootstrapPlatformOwner({ log() {}, error() {} });
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  const l = must(await api('POST', '/auth/login', { body: { email: 'platform-owner@example.com', password: 'owner-test-pass' } }));
  platform = { ...l.user, token: l.token };
  orgOwner = await signup(['venue_manager']);
  // Create an organisation for the import
  const org = must(await api('POST', '/organisations', { token: orgOwner.token, body: { name: 'Test Sports Org', kind: 'club' } }), 201);
  orgId = org.id;
});
after(async () => { server.close(); await pool.end(); });

test('list_venue_import_sources returns venue domain and all source keys', async () => {
  const sources = must(await api('GET', '/venue-imports/sources', { token: orgOwner.token }));
  assert.ok(Array.isArray(sources.sources));
  assert.ok(sources.sources.some(s => s.key === 'playo'), 'Playo source listed');
  assert.ok(sources.sources.some(s => s.key === 'excel'), 'Excel source listed');
  assert.ok(Array.isArray(sources.fields));
  assert.ok(sources.fields.some(f => f.key === 'name'));
  assert.ok(sources.fields.some(f => f.key === 'base_rate_minor'));
});

test('CSV template download works for each source', async () => {
  const tpl = must(await api('GET', '/venue-imports/template', { token: orgOwner.token, query: { source: 'playo' } }));
  assert.ok(tpl.csv.includes('venue_name') || tpl.csv.includes('name'), 'template has venue name column');
  assert.ok(tpl.filename.includes('playo'));
});

let projectId;
test('create_venue_import uploads CSV and creates a project in uploaded status', async () => {
  const proj = must(await api('POST', '/venue-imports', {
    token: orgOwner.token,
    body: {
      organisation_id: orgId, source: 'excel', file_name: 'venues.csv',
      file: Buffer.from(CSV_VALID).toString('base64'),
      options: { currency: 'INR', default_timezone: 'Asia/Kolkata' },
    },
  }), 201);
  assert.equal(proj.status, 'uploaded');
  assert.equal(proj.domain, 'venue');
  assert.ok(proj.source_rows >= 3, 'rows detected');
  projectId = proj.id;
});

test('get_venue_import returns auto-proposed column mapping', async () => {
  const proj = must(await api('GET', `/venue-imports/${projectId}`, { token: orgOwner.token }));
  assert.ok(proj.analysis.mapping, 'mapping proposed');
  assert.equal(proj.analysis.mapping.name, 'name', 'name column auto-mapped');
  assert.equal(proj.analysis.mapping.city, 'city', 'city column auto-mapped');
  assert.equal(proj.analysis.mapping.base_rate_minor, 'base_rate_minor');
});

test('update mapping then run dry-run check', async () => {
  must(await api('PATCH', `/venue-imports/${projectId}/mapping`, {
    token: orgOwner.token,
    body: { mapping: { name: 'name', city: 'city', country: 'country', sports: 'sports', court_count: 'court_count', base_rate_minor: 'base_rate_minor', currency: 'currency', hours_open: 'hours_open', hours_close: 'hours_close', timezone: 'timezone' } },
  }));

  const summary = must(await api('POST', `/venue-imports/${projectId}/check`, { token: orgOwner.token }));
  assert.ok(summary.valid >= 3, `expected >=3 valid rows, got ${summary.valid}`);
  assert.equal(summary.rejected, 0, 'no rejected rows in valid CSV');
});

test('dry-run on CSV with errors correctly identifies errors and warnings', async () => {
  const proj2 = must(await api('POST', '/venue-imports', {
    token: orgOwner.token,
    body: {
      organisation_id: orgId, source: 'excel', file_name: 'bad.csv',
      file: Buffer.from(CSV_WITH_ERRORS).toString('base64'),
      options: { currency: 'INR' },
    },
  }), 201);

  must(await api('PATCH', `/venue-imports/${proj2.id}/mapping`, {
    token: orgOwner.token,
    body: { mapping: { name: 'name', city: 'city', sports: 'sports', court_count: 'court_count', base_rate_minor: 'base_rate_minor', currency: 'currency' } },
  }));

  const summary2 = must(await api('POST', `/venue-imports/${proj2.id}/check`, { token: orgOwner.token }));
  assert.ok(summary2.rejected >= 2, `expected at least 2 rejected rows (missing name/city, bad rate): got ${summary2.rejected}`);
  assert.ok(summary2.valid >= 1, 'one valid row (Valid Arena, Pune)');

  const rows = must(await api('GET', `/venue-imports/${proj2.id}/rows`, { token: orgOwner.token }));
  const errorRow = rows.items.find(r => r.check_status === 'rejected');
  assert.ok(errorRow, 'rejected row present');
  assert.ok(Array.isArray(errorRow.reasons) && errorRow.reasons.length > 0, 'reasons populated');
});

test('import is idempotent: running the same import twice does not duplicate venues', async () => {
  must(await api('POST', `/venue-imports/${projectId}/approve`, { token: orgOwner.token }));
  const report1 = must(await api('POST', `/venue-imports/${projectId}/run`, { token: orgOwner.token }));
  assert.ok(report1.created >= 3);

  // Create a second import with the same venues
  const proj3 = must(await api('POST', '/venue-imports', {
    token: orgOwner.token,
    body: { organisation_id: orgId, source: 'excel', file_name: 'venues_dup.csv', file: Buffer.from(CSV_VALID).toString('base64'), options: {} },
  }), 201);
  must(await api('PATCH', `/venue-imports/${proj3.id}/mapping`, { token: orgOwner.token, body: { mapping: { name: 'name', city: 'city', sports: 'sports', court_count: 'court_count', base_rate_minor: 'base_rate_minor', currency: 'currency' } } }));
  const summary3 = must(await api('POST', `/venue-imports/${proj3.id}/check`, { token: orgOwner.token }));
  assert.ok(summary3.conflicts >= 3, `expected conflicts for duplicate venues: got ${summary3.conflicts}`);
});

test('rollback sets created venues to paused (never deleted)', async () => {
  const before_count = (await pool.query("SELECT count(*)::int AS n FROM venues WHERE paused_by_partner=false")).rows[0].n;
  must(await api('POST', `/venue-imports/${projectId}/rollback`, { token: orgOwner.token }));
  const after_count = (await pool.query("SELECT count(*)::int AS n FROM venues WHERE paused_by_partner=false")).rows[0].n;
  // paused venues are not deleted — same total count
  const total = (await pool.query('SELECT count(*)::int AS n FROM venues')).rows[0].n;
  assert.ok(total >= before_count, 'no venues deleted on rollback');
  // Data is preserved
  const paused = (await pool.query("SELECT count(*)::int AS n FROM venues WHERE paused_by_partner=true")).rows[0].n;
  assert.ok(paused >= 3, 'rolled-back venues are paused, not deleted');
});

test('missing required fields fail gracefully with actionable error messages', async () => {
  const csv_no_city = `name,sports\nTest Arena,cricket`;
  const proj = must(await api('POST', '/venue-imports', {
    token: orgOwner.token,
    body: { organisation_id: orgId, source: 'csv', file_name: 'nocity.csv', file: Buffer.from(csv_no_city).toString('base64'), options: {} },
  }), 201);
  must(await api('PATCH', `/venue-imports/${proj.id}/mapping`, { token: orgOwner.token, body: { mapping: { name: 'name', sports: 'sports' } } }));
  const r = await api('POST', `/venue-imports/${proj.id}/check`, { token: orgOwner.token });
  // Should succeed (check returns a summary) but rows should be rejected
  const summary = must(r);
  assert.ok(summary.rejected >= 1, 'city-less rows rejected');
});

test('a non-owner cannot access another org\'s import', async () => {
  const other = await signup();
  const r = await api('GET', `/venue-imports/${projectId}`, { token: other.token });
  assert.equal(r.status, 404, 'outsider cannot access the import project');
});
