import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { LANGUAGE_CODES } = await import('../src/comms-catalogue.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('a person can save any language pack as their language, clear it, and unknown codes are rejected', async () => {
  const r = await api('POST', '/auth/register', { body: { handle: 'lang_user', display_name: 'Lang User', email: 'lang@example.com', password: 'correct-horse-battery', roles: ['athlete'] } });
  assert.equal(r.status, 201);
  const token = r.body.token;
  assert.equal((await api('GET', '/me', { token })).body.language, null);
  for (const code of LANGUAGE_CODES) {
    assert.equal((await api('PATCH', '/me', { token, body: { language: code } })).status, 200, code);
    assert.equal((await api('GET', '/me', { token })).body.language, code);
  }
  assert.equal((await api('PATCH', '/me', { token, body: { language: null } })).status, 200);
  assert.equal((await api('GET', '/me', { token })).body.language, null);
  assert.equal((await api('PATCH', '/me', { token, body: { language: 'xx' } })).status, 400);
});
