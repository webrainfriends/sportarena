import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');

let server, base;
const api = async (method, path, { token, body, ua } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(ua ? { 'user-agent': ua } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const PW = 'correct-horse-battery';
let n = 0;
const register = async () => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `sess_${n}`, display_name: `Sess ${n}`, email: `sess${n}@example.com`, password: PW } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body, email: `sess${n}@example.com` };
};
const login = async (email, ua = 'TestAgent/1') => {
  const r = await api('POST', '/auth/login', { body: { email, password: PW }, ua });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('login creates a server session bound to the JWT; logout invalidates it immediately', async () => {
  const r = await register();
  assert.ok(r.session_id && r.refresh_token.startsWith('sr_'));
  assert.equal((await api('GET', '/me', { token: r.token })).status, 200);
  const row = (await pool.query('SELECT * FROM auth_sessions WHERE id=$1', [r.session_id])).rows[0];
  assert.equal(row.user_id, r.user.id);
  assert.ok(!JSON.stringify(row).includes(r.refresh_token));
  assert.ok(!(await pool.query('SELECT token_hash FROM refresh_tokens WHERE session_id=$1', [r.session_id])).rows.some((x) => x.token_hash === r.refresh_token), 'refresh token stored hashed');

  assert.equal((await api('POST', '/auth/logout', { token: r.token })).status, 200);
  assert.equal((await api('GET', '/me', { token: r.token })).status, 401, 'logged-out access token fails immediately');
  assert.equal((await api('POST', '/auth/refresh', { body: { refresh_token: r.refresh_token } })).status, 401, 'and its refresh token is dead');
  assert.equal((await pool.query('SELECT revoked_reason FROM auth_sessions WHERE id=$1', [r.session_id])).rows[0].revoked_reason, 'logout');
});

test('refresh rotates the token; reusing an old one revokes the whole session', async () => {
  const r = await register();
  const a = await api('POST', '/auth/refresh', { body: { refresh_token: r.refresh_token } });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.notEqual(a.body.refresh_token, r.refresh_token);
  assert.equal(a.body.session_id, r.session_id);
  assert.equal((await api('GET', '/me', { token: a.body.token })).status, 200);

  const b = await api('POST', '/auth/refresh', { body: { refresh_token: a.body.refresh_token } });
  assert.equal(b.status, 200);
  // attacker (or stale client) replays the first, already-rotated token
  assert.equal((await api('POST', '/auth/refresh', { body: { refresh_token: r.refresh_token } })).status, 401);
  // ...which ends the family: even the newest legitimate token and access tokens are dead
  assert.equal((await api('POST', '/auth/refresh', { body: { refresh_token: b.body.refresh_token } })).status, 401);
  assert.equal((await api('GET', '/me', { token: b.body.token })).status, 401);
  assert.equal((await pool.query('SELECT revoked_reason FROM auth_sessions WHERE id=$1', [r.session_id])).rows[0].revoked_reason, 'refresh_reuse');
  assert.equal((await api('POST', '/auth/refresh', { body: { refresh_token: 'sr_' + 'x'.repeat(40) } })).status, 401, 'unknown token');
});

test('concurrent refreshes with one token: exactly one wins', async () => {
  const r = await register();
  const res = await Promise.all([1, 2, 3].map(() => api('POST', '/auth/refresh', { body: { refresh_token: r.refresh_token } })));
  assert.equal(res.filter((x) => x.status === 200).length, 1, JSON.stringify(res.map((x) => x.status)));
});

test('expired sessions and refresh tokens are refused', async () => {
  const r = await register();
  await pool.query("UPDATE auth_sessions SET expires_at = now() - interval '1 minute' WHERE id=$1", [r.session_id]);
  assert.equal((await api('GET', '/me', { token: r.token })).status, 401);
  assert.equal((await api('POST', '/auth/refresh', { body: { refresh_token: r.refresh_token } })).status, 401);
});

test('list_login_sessions shows devices; revoke one device; logout-all ends all; sessions are private', async () => {
  const r = await register();
  const phone = await login(r.email, 'Phone/2');
  const laptop = await login(r.email, 'Laptop/3');
  const list = await api('GET', '/me/sessions', { token: phone.token });
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 3);
  const cur = list.body.filter((s) => s.current);
  assert.equal(cur.length, 1);
  assert.equal(cur[0].id, phone.session_id);
  assert.ok(list.body.some((s) => s.user_agent === 'Laptop/3'));
  assert.ok(!JSON.stringify(list.body).includes('token'));

  const other = await register();
  assert.equal((await api('DELETE', `/me/sessions/${laptop.session_id}`, { token: other.token })).status, 404, "cannot revoke someone else's session");
  assert.equal((await api('DELETE', `/me/sessions/${laptop.session_id}`, { token: phone.token })).status, 200);
  assert.equal((await api('GET', '/me', { token: laptop.token })).status, 401);
  assert.equal((await api('GET', '/me/sessions', { token: phone.token })).body.length, 2);

  const all = await api('POST', '/auth/logout-all', { token: phone.token });
  assert.equal(all.body.revoked, 2);
  for (const t of [r.token, phone.token]) assert.equal((await api('GET', '/me', { token: t })).status, 401);
  assert.equal((await api('GET', '/me', { token: other.token })).status, 200, 'other accounts untouched');
});

test('changing the password signs out other devices but keeps this one; wrong current password is refused', async () => {
  const r = await register();
  const other = await login(r.email);
  assert.equal((await api('POST', '/me/password', { token: r.token, body: { current_password: 'wrong-wrong-wrong', new_password: 'another-long-password' } })).status, 401);
  const ok = await api('POST', '/me/password', { token: r.token, body: { current_password: PW, new_password: 'another-long-password' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.signed_out_elsewhere, 1);
  assert.equal((await api('GET', '/me', { token: other.token })).status, 401);
  assert.equal((await api('POST', '/auth/refresh', { body: { refresh_token: other.refresh_token } })).status, 401);
  assert.equal((await api('GET', '/me', { token: r.token })).status, 200);
  assert.equal((await api('POST', '/auth/login', { body: { email: r.email, password: PW } })).status, 401, 'old password no longer works');
  assert.equal((await api('POST', '/auth/login', { body: { email: r.email, password: 'another-long-password' } })).status, 200);
});

test('API tokens cannot use session management; pre-session JWTs still work unless AUTH_REQUIRE_SESSION', async () => {
  const r = await register();
  const tok = (await api('POST', '/me/tokens', { token: r.token, body: { name: 'agent', scopes: ['write'] } })).body.token;
  assert.equal((await api('GET', '/me/sessions', { token: tok })).status, 403);
  assert.equal((await api('POST', '/auth/logout', { token: tok })).status, 403);
  // a JWT minted before sessions existed (no matching session row) keeps working for its TTL
  const legacy = await signToken({ id: r.user.id, roles: ['athlete'] });
  assert.equal((await api('GET', '/me', { token: legacy })).status, 200);
  assert.equal((await api('POST', '/auth/logout', { token: legacy })).body.revoked, false);
});
