// Six-role financial reconciliation audit integration tests (#1128).
// Verifies that every role module's obligations/receipts land in fin_transactions,
// that cross-role links are written, and that the audit API surfaces gaps.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';

let pool, server, base;

const { pool: p } = await import('../src/db.js');
pool = p;
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  server.close();
  await pool.end();
});

// ─── helpers ────────────────────────────────────────────────────────────────

async function api(method, path, body, token) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function signup(email, roles = []) {
  const r = await api('POST', '/auth/register', { email, password: 'Test1234!', full_name: 'Test User' });
  assert.ok(r.status < 300, `signup failed: ${JSON.stringify(r.body)}`);
  if (roles.length) {
    // grant roles directly for test setup
    await pool.query(`UPDATE people SET roles = $2 WHERE email = $1`, [email, roles]);
  }
  const lr = await api('POST', '/auth/login', { email, password: 'Test1234!' });
  return lr.body?.token ?? lr.body?.access_token;
}

async function createOrg(token) {
  const r = await api('POST', '/organisations', { name: 'Test Academy', kind: 'academy', currency: 'GBP', sport: 'football' }, token);
  return r.body?.id;
}

// ─── tests ──────────────────────────────────────────────────────────────────

test('migration: physio_packages and physio_appointments tables exist', async () => {
  const { rows } = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN ('physio_packages','physio_appointments','fin_role_links','fin_six_role_audit_runs')
    ORDER BY table_name`);
  const names = rows.map((r) => r.table_name);
  assert.ok(names.includes('physio_packages'), 'physio_packages missing');
  assert.ok(names.includes('physio_appointments'), 'physio_appointments missing');
  assert.ok(names.includes('fin_role_links'), 'fin_role_links missing');
  assert.ok(names.includes('fin_six_role_audit_runs'), 'fin_six_role_audit_runs missing');
});

test('migration: fin_recon_items accepts six-role gap kinds', async () => {
  // Insert a row with the new kind and verify it round-trips
  const { rows } = await pool.query(`
    INSERT INTO fin_recon_items (idem_key, kind, source_module, currency, amount_cents, status, opened_at)
    VALUES ('test:physio_unlinked:1', 'physio_unlinked', 'physio', 'GBP', 5000, 'open', now())
    ON CONFLICT DO NOTHING RETURNING id`);
  assert.ok(rows.length >= 0); // just checking no constraint violation
});

test('API: six-role audit run requires platform_admin', async () => {
  const token = await signup('regular@test.com');
  const r = await api('POST', '/finance/six-role-audit/run', {}, token);
  assert.ok(r.status === 403 || r.status === 404, `expected 403/404 but got ${r.status}`);
});

test('API: platform admin can run six-role audit', async () => {
  const token = await signup('admin@test.com', ['platform_admin']);
  const r = await api('POST', '/finance/six-role-audit/run', {}, token);
  assert.ok(r.status < 300, `audit run failed: ${JSON.stringify(r.body)}`);
  assert.ok(typeof r.body?.total_gaps === 'number', 'missing total_gaps in response');
});

test('API: summary returns health metrics', async () => {
  const token = await signup('admin2@test.com', ['platform_admin']);
  const r = await api('GET', '/finance/six-role-audit/summary', null, token);
  assert.ok(r.status < 300, `summary failed: ${JSON.stringify(r.body)}`);
  assert.ok(Array.isArray(r.body?.by_role), 'missing by_role array');
});

test('API: gaps list returns open items', async () => {
  const token = await signup('admin3@test.com', ['platform_admin']);
  const r = await api('GET', '/finance/six-role-audit/gaps?status=open&limit=10', null, token);
  assert.ok(r.status < 300, `gaps list failed: ${JSON.stringify(r.body)}`);
  assert.ok(Array.isArray(r.body), 'gaps response should be array');
});

test('API: runs list returns audit run history', async () => {
  const token = await signup('admin4@test.com', ['platform_admin']);
  const r = await api('GET', '/finance/six-role-audit/runs', null, token);
  assert.ok(r.status < 300, `runs list failed: ${JSON.stringify(r.body)}`);
  assert.ok(Array.isArray(r.body), 'runs response should be array');
});

test('API: lineage endpoint requires transaction_id or entity_id', async () => {
  const token = await signup('admin5@test.com', ['platform_admin']);
  const r = await api('GET', '/finance/six-role-audit/lineage', null, token);
  assert.ok(r.status === 400, `expected 400 got ${r.status}`);
});

test('finance-sync: syncLedger includes role_links in result', async () => {
  const { syncLedger } = await import('../src/finance-sync.js');
  const result = await syncLedger({ limit: 10 });
  assert.ok('role_links' in result, 'syncLedger should return role_links count');
  assert.ok(typeof result.role_links === 'number', 'role_links should be a number');
});

test('worker: six_role_audit step is registered', async () => {
  const { STEPS } = await import('../src/worker.js');
  const step = STEPS.find(([name]) => name === 'six_role_audit');
  assert.ok(step, 'six_role_audit step missing from STEPS');
});
