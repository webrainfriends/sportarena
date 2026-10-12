import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
process.env.SUPER_ADMIN_EMAIL = 'rraja.edge@gmail.com';
process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { googleVerifier } = await import('../src/capabilities/google-login.js');

let server, base;
const api = async (method, path, body, token) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
// The verifier is replaced: the "credential" is a JSON claims object, so no network or Google keys are needed.
googleVerifier.verify = async (cred) => { const c = JSON.parse(cred); if (c.bad) throw new Error('bad token'); return c; };
const google = (claims) => api('POST', '/auth/google', { credential: JSON.stringify({ email_verified: true, ...claims, pad: 'x'.repeat(20) }) });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('auth config exposes the public client id', async () => {
  assert.equal((await api('GET', '/auth/config')).body.google_client_id, process.env.GOOGLE_CLIENT_ID);
});

test('a new Google user gets an account, and signing in again reuses it', async () => {
  const a = await google({ sub: 'g1', email: 'Pat.Lee@gmail.com', name: 'Pat Lee' });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.user.display_name, 'Pat Lee');
  assert.match(a.body.user.handle, /^[a-z0-9_]{3,24}$/);
  const me = await api('GET', '/me', null, a.body.token);
  assert.equal(me.body.email, 'pat.lee@gmail.com');
  const b = await google({ sub: 'g1', email: 'pat.lee@gmail.com', name: 'Pat Lee' });
  assert.equal(b.body.user.id, a.body.user.id);
});

test('an existing password account is linked by email', async () => {
  const r = await api('POST', '/auth/register', { handle: 'sam_k', display_name: 'Sam', email: 'sam@gmail.com', password: 'correct-horse-battery' });
  const g = await google({ sub: 'g2', email: 'sam@gmail.com', name: 'Sam K' });
  assert.equal(g.body.user.id, r.body.user.id);
  // the email was never verified by Sam, so the password set at registration stopped working and old sessions were revoked
  assert.equal((await api('POST', '/auth/login', { email: 'sam@gmail.com', password: 'correct-horse-battery' })).status, 401);
  assert.equal((await api('GET', '/me', null, r.body.token)).status, 401);
  assert.equal((await api('GET', '/me', null, g.body.token)).status, 200);
});

test('unverified emails, bad tokens and another Google account are refused', async () => {
  assert.equal((await google({ sub: 'g3', email: 'x@gmail.com', email_verified: false })).status, 401);
  assert.equal((await google({ bad: true })).status, 401);
  assert.equal((await google({ sub: 'g9', email: 'sam@gmail.com' })).status, 401);
});

test('new Google users are pending and read-only until the super admin approves; rejection signs them out', async () => {
  const p = await google({ sub: 'g20', email: 'newbie@gmail.com', name: 'Newbie' });
  assert.equal(p.body.user.access_status, 'pending');
  assert.equal((await api('GET', '/me', null, p.body.token)).body.access_status, 'pending');
  assert.equal((await api('GET', '/sports', null, p.body.token)).status, 200);
  const blocked = await api('PATCH', '/me', { bio: 'hello' }, p.body.token);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error?.code ?? blocked.body.code, 'approval_pending');
  const upload = await fetch(`${base}/api/v1/me/avatar`, { method: 'PUT', headers: { authorization: `Bearer ${p.body.token}`, 'content-type': 'image/png' }, body: Buffer.from('x') });
  assert.equal(upload.status, 403);

  // only the super admin can decide
  assert.equal((await api('GET', '/admin/access-requests', null, p.body.token)).status, 403);
  const boss = await google({ sub: 'gboss', email: 'rraja.edge@gmail.com', name: 'Raja' });
  assert.equal(boss.body.user.access_status, 'approved');
  assert.ok(boss.body.user.roles.includes('platform_admin'));
  const list = await api('GET', '/admin/access-requests', null, boss.body.token);
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const row = list.body.find((r) => r.id === p.body.user.id);
  assert.equal(row.email, 'newbie@gmail.com');

  const ok = await api('POST', `/admin/access-requests/${p.body.user.id}`, { decision: 'approved' }, boss.body.token);
  assert.equal(ok.body.access_status, 'approved', JSON.stringify(ok.body));
  assert.equal((await api('PATCH', '/me', { bio: 'hello' }, p.body.token)).status, 200);

  await api('POST', `/admin/access-requests/${p.body.user.id}`, { decision: 'rejected' }, boss.body.token);
  assert.equal((await api('GET', '/me', null, p.body.token)).status, 401);
  assert.equal((await google({ sub: 'g20', email: 'newbie@gmail.com' })).status, 401);
  assert.equal((await api('POST', `/admin/access-requests/${p.body.user.id}`, { decision: 'approved' }, boss.body.token)).status, 200);
  assert.equal((await google({ sub: 'g20', email: 'newbie@gmail.com' })).status, 200);
});
