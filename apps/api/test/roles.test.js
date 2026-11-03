import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

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

test('one account can add and drop roles; created data is kept', async () => {
  const r = await api('POST', '/auth/register', { body: { handle: 'multi_role', display_name: 'Multi', email: 'multi@example.com', password: 'correct-horse-battery', roles: ['athlete'] } });
  const token = r.body.token;
  assert.equal((await api('POST', '/venues', { token, body: { name: 'Nope Arena' } })).status, 403, 'athlete cannot register a venue yet');

  const added = await api('PATCH', '/me/roles', { token, body: { add: ['venue_manager'] } });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.deepEqual(added.body.roles.sort(), ['athlete', 'venue_manager']);
  const venue = await api('POST', '/venues', { token, body: { name: 'Multi Arena' } });
  assert.equal(venue.status, 201, JSON.stringify(venue.body));
  assert.deepEqual((await api('GET', '/me', { token })).body.roles.sort(), ['athlete', 'venue_manager']);

  const dropped = await api('PATCH', '/me/roles', { token, body: { remove: ['venue_manager'] } });
  assert.deepEqual(dropped.body.roles, ['athlete']);
  assert.equal((await api('POST', '/venues', { token, body: { name: 'Second' } })).status, 403);
  assert.equal((await pool.query('SELECT 1 FROM venues WHERE id=$1', [venue.body.id])).rowCount, 1, 'dropping a role keeps the venue');

  assert.equal((await api('PATCH', '/me/roles', { token, body: { add: ['admin'] } })).status, 400, 'admin cannot be self-assigned');
  assert.equal((await api('PATCH', '/me/roles', { token, body: { remove: ['athlete'] } })).status, 400, 'at least one role stays');
  assert.equal((await api('PATCH', '/me/roles', { token, body: {} })).status, 400);
});

test('default role: athlete unless you chose another; admin is never a default', async () => {
  const r = await api('POST', '/auth/register', { body: { handle: 'dflt_role', display_name: 'Dflt', email: 'dflt@example.com', password: 'correct-horse-battery', roles: ['coach', 'athlete'] } });
  const token = r.body.token;
  assert.equal((await api('GET', '/me', { token })).body.default_role, 'athlete', 'athlete wins when held');
  assert.equal((await api('GET', '/me/role-workspace', { token })).body.role, 'athlete');

  assert.equal((await api('PATCH', '/me/default-role', { token, body: { role: 'coach' } })).status, 200);
  assert.equal((await api('GET', '/me', { token })).body.default_role, 'coach', 'an explicit choice is respected');
  assert.equal((await api('GET', '/me/role-workspace', { token })).body.role, 'coach');

  assert.equal((await api('PATCH', '/me/default-role', { token, body: { role: 'referee' } })).status, 400, 'must hold the role');
  assert.equal((await api('PATCH', '/me/default-role', { token, body: { role: 'admin' } })).status, 400, 'admin is not selectable');

  await api('PATCH', '/me/roles', { token, body: { remove: ['coach'] } });
  assert.equal((await api('GET', '/me', { token })).body.default_role, 'athlete', 'dropping the default falls back to athlete');
  assert.equal((await pool.query(`SELECT default_role FROM users WHERE handle='dflt_role'`)).rows[0].default_role, null, 'stale choice cleared');

  const only = await api('POST', '/auth/register', { body: { handle: 'dflt_two', display_name: 'Two', email: 'dflt2@example.com', password: 'correct-horse-battery', roles: ['physio', 'coach'] } });
  assert.equal((await api('GET', '/me', { token: only.body.token })).body.default_role, 'physio', 'no athlete: first role');
  assert.equal((await api('PATCH', '/me/default-role', { token: only.body.token, body: { role: null } })).status, 200, 'null resets to automatic');
});
