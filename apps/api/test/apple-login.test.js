import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
process.env.APPLE_CLIENT_ID = 'dev.gotmygame.web';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { appleVerifier } = await import('../src/capabilities/apple-login.js');

let server, base;
const api = async (method, path, body, token) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
// The verifier is replaced: the "credential" is a JSON claims object, so no network or Apple keys are needed.
appleVerifier.verify = async (cred) => { const c = JSON.parse(cred); if (c.bad) throw new Error('bad token'); return c; };
const apple = (claims, extra = {}) => api('POST', '/auth/apple', { credential: JSON.stringify({ email_verified: 'true', ...claims, pad: 'x'.repeat(20) }), ...extra });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('auth config exposes the Apple client id', async () => {
  assert.equal((await api('GET', '/auth/config')).body.apple_client_id, 'dev.gotmygame.web');
});

test('a new Apple user is created pending; later sign-ins work without an email', async () => {
  const a = await apple({ sub: 'a1', email: 'Kim.Roe@icloud.com' }, { name: 'Kim Roe' });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.user.display_name, 'Kim Roe');
  assert.equal(a.body.user.access_status, 'pending');
  const b = await apple({ sub: 'a1' });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(b.body.user.id, a.body.user.id);
});

test('an existing account is linked by email; bad tokens, unverified or missing email and wrong nonce are refused', async () => {
  const r = await api('POST', '/auth/register', { handle: 'lee_p', display_name: 'Lee', email: 'lee@icloud.com', password: 'correct-horse-battery' });
  assert.equal((await apple({ sub: 'a2', email: 'lee@icloud.com' })).body.user.id, r.body.user.id);
  assert.equal((await apple({ sub: 'a3', email: 'x@icloud.com', email_verified: 'false' })).status, 401);
  assert.equal((await apple({ sub: 'a4' })).status, 401);
  assert.equal((await apple({ bad: true })).status, 401);
  assert.equal((await apple({ sub: 'a9', email: 'lee@icloud.com' })).status, 401);
  assert.equal((await apple({ sub: 'a2', nonce: 'rightnonce1' }, { nonce: 'wrongnonce1' })).status, 401);
});

test('the web callback refuses a missing or mismatched state and redirects back with a message', async () => {
  const post = (cookie, body) => fetch(`${base}/api/v1/auth/apple/callback`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(body) });
  const r = await post(null, { id_token: 'x'.repeat(30), state: 's' });
  assert.equal(r.status, 303);
  assert.match(r.headers.get('location'), /apple_error=/);
  const ok = await post('sa_apple_state=st.nonce1234', { id_token: JSON.stringify({ sub: 'a50', email: 'web@icloud.com', email_verified: true, nonce: 'nonce1234' }), state: 'st', user: JSON.stringify({ name: { firstName: 'Web', lastName: 'User' } }) });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/?apple_role=1', 'a new Apple user is sent to choose a role first');
  assert.doesNotMatch(ok.headers.getSetCookie().join(';'), /sa_session=/, 'no session and no account until the role is chosen');
  assert.match(ok.headers.getSetCookie().join(';'), /sa_apple_pending=/);
  const bad = await post('sa_apple_state=st.nonce1234', { id_token: JSON.stringify({ sub: 'a51' }), state: 'other' });
  assert.match(bad.headers.get('location'), /apple_error=/);
  const start = await fetch(`${base}/api/v1/auth/apple/start`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  assert.match(start.headers.get('location'), /^https:\/\/appleid\.apple\.com\/auth\/authorize\?.*response_mode=form_post/);
});

test('a new Apple user on the web chooses a role, then the account is created with it', async () => {
  const post = (cookie, body) => fetch(`${base}/api/v1/auth/apple/callback`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(body) });
  const complete = (cookie, body) => fetch(`${base}/api/v1/auth/apple/complete`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const cb = await post('sa_apple_state=st.nonce1234', { id_token: JSON.stringify({ sub: 'a60', email: 'role@icloud.com', email_verified: true, nonce: 'nonce1234', pad: 'x'.repeat(20) }), state: 'st' });
  const pending = cb.headers.getSetCookie().find((c) => c.startsWith('sa_apple_pending=')).split(';')[0];
  assert.equal((await pool.query(`SELECT 1 FROM users WHERE apple_sub='a60'`)).rowCount, 0, 'nothing created yet');
  assert.equal((await complete(null, { roles: ['coach'] })).status, 401, 'no pending sign-in, no account');
  assert.equal((await complete(pending, { roles: ['admin'] })).status, 400, 'platform roles cannot be chosen');
  const done = await complete(pending, { roles: ['coach', 'physio'] });
  const body = await done.json();
  assert.equal(done.status, 200, JSON.stringify(body));
  assert.deepEqual(body.user.roles, ['coach', 'physio']);
  assert.match(done.headers.getSetCookie().join(';'), /sa_session=/);
  const again = await post('sa_apple_state=st.nonce1234', { id_token: JSON.stringify({ sub: 'a60', email: 'role@icloud.com', email_verified: true, nonce: 'nonce1234', pad: 'x'.repeat(20) }), state: 'st' });
  assert.equal(again.headers.get('location'), '/', 'an existing Apple user signs straight in');
});

test('the native Apple call can ask for the role step and then create the account with the chosen roles', async () => {
  const ask = await apple({ sub: 'a61', email: 'n@icloud.com' }, { require_role: true });
  assert.equal(ask.status, 200);
  assert.equal(ask.body.needs_role, true);
  assert.equal(ask.body.token, undefined);
  assert.equal((await pool.query(`SELECT 1 FROM users WHERE apple_sub='a61'`)).rowCount, 0);
  const made = await apple({ sub: 'a61', email: 'n@icloud.com' }, { roles: ['referee'] });
  assert.deepEqual(made.body.user.roles, ['referee']);
  assert.equal((await apple({ sub: 'a62', email: 'n2@icloud.com' }, { roles: ['platform_admin'] })).status, 400);
});
