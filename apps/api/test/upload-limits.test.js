import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
process.env.PLATFORM_ADMIN_EMAILS = 'rraja.edge@gmail.com,rrajas1978@icloud.com';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { DOC_LIMITS } = await import('../src/doc-store.js');
const { loadPlatformSettings } = await import('../src/platform-settings.js');
const { uploadPathPatterns } = await import('../src/upload-routes.js');

let server, base, admin, plain;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const reg = async (handle, email) => {
  const r = await api('POST', '/auth/register', { body: { handle, display_name: handle, email, password: 'correct-horse-battery', roles: ['athlete'] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { token: r.body.token, id: r.body.user?.id ?? (await pool.query('SELECT id FROM users WHERE handle=$1', [handle])).rows[0].id };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate(); await loadPlatformSettings();
  server = createApp().listen(0); base = `http://localhost:${server.address().port}`;
  admin = await reg('limit_boss', 'rraja.edge@gmail.com');
  await pool.query("UPDATE users SET roles = '{athlete,admin,platform_admin}' WHERE id = $1", [admin.id]);
  plain = await reg('limit_plain', 'plain-limit@example.com');
});
after(async () => { server.close(); await pool.end(); });

test('the default is 10 MB, anyone signed in can read it, and DOC_LIMITS follows it', async () => {
  const r = await api('GET', '/upload-limits', { token: plain.token });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.document_max_mb, r.body.min_mb, r.body.max_mb], [10, 1, 50]);
  assert.equal(DOC_LIMITS.bytes, 10 * 2 ** 20);
});

test('only the platform admin can change it, between 1 and 50 MB, and every upload route follows at once', async () => {
  assert.equal((await api('PATCH', '/admin/upload-limits', { token: plain.token, body: { document_max_mb: 50 } })).status, 403);
  assert.equal((await api('PATCH', '/admin/upload-limits', { token: admin.token, body: { document_max_mb: 51 } })).status, 400);
  assert.equal((await api('PATCH', '/admin/upload-limits', { token: admin.token, body: { document_max_mb: 0 } })).status, 400);
  const big = { type: 'coach', evidence: [{ kind: 'coaching_certificate', data: 'A'.repeat(20 * 2 ** 20) }] };
  assert.equal((await api('POST', '/verification/cases', { token: plain.token, body: big })).status, 413, 'a 20 MB body is over the 10 MB default');
  const set = await api('PATCH', '/admin/upload-limits', { token: admin.token, body: { document_max_mb: 50 } });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal((await api('GET', '/upload-limits', { token: plain.token })).body.document_max_mb, 50);
  assert.equal(DOC_LIMITS.bytes, 50 * 2 ** 20);
  assert.notEqual((await api('POST', '/verification/cases', { token: plain.token, body: big })).status, 413, 'the same body now gets past the size gate');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='set_upload_limits'")).rows[0].n >= 1, true);
});

test('every capability that takes a base64 file is covered by the dynamic body limit', () => {
  const hit = (p) => uploadPathPatterns().some((re) => re.test(p));
  for (const p of ['/api/v1/verification/cases', '/api/v1/verification/cases/00000000-0000-0000-0000-000000000000/evidence', '/api/v1/cases', '/api/v1/youth/guardian-links/x/evidence']) assert.ok(hit(p), p);
  assert.ok(!hit('/api/v1/teams'));
});
