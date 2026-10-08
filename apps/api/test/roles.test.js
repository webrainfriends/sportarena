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
