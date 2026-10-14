import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base;
const api = async (method, path, body, token) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const reg = (handle, email) => api('POST', '/auth/register', { handle, display_name: handle, email, password: 'correct-horse-battery' });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('handles are unique at sign-up (case-insensitive) and can be changed without clashing', async () => {
  const a = await reg('first_one', 'a@example.com');
  assert.equal(a.status, 201);
  const dup = await reg('First_One', 'b@example.com');
  assert.equal(dup.status, 409);
  assert.match(dup.body.error?.message ?? dup.body.message ?? JSON.stringify(dup.body), /handle/i);
  const b = await reg('second_one', 'b@example.com');
  assert.equal(b.status, 201);
  const tok = b.body.access_token ?? b.body.token;

  assert.equal((await api('GET', '/auth/handle-available?handle=FIRST_ONE')).body.available, false);
  assert.equal((await api('GET', '/auth/handle-available?handle=free_one')).body.available, true);
  assert.equal((await api('GET', '/auth/handle-available?handle=ab')).body.reason, 'invalid');

  assert.equal((await api('PATCH', '/me', { handle: 'first_one' }, tok)).status, 409);
  assert.equal((await api('PATCH', '/me', { handle: 'Free_One' }, tok)).status, 200);
  assert.equal((await api('GET', '/me', null, tok)).body.handle, 'free_one');
  assert.equal((await api('PATCH', '/me', { handle: 'free_one' }, tok)).status, 200); // keeping your own is fine
});
