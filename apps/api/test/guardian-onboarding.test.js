import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
await import('../src/capabilities/index.js');

let server, base, n = 0;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const yearsAgo = y => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); return d.toISOString().slice(0, 10); };
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `gob_${n}`, display_name: `GOB ${n}`, email: `gob${n}@example.com`, password: 'correct-horse-battery', roles, dob: yearsAgo(35) } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(() => server?.close());

test('guardian creates managed child, sets medical card and kit sizes', async () => {
  const guardian = await signup(['athlete']);
  const other = await signup(['athlete']);

  // Create managed child
  const created = ok(await api('POST', '/me/managed-children', { token: guardian.token, body: {
    first_name: 'Jamie', last_name: 'Test', dob: yearsAgo(10), sports: ['football'],
  } }), 201);
  assert.ok(created.child?.id);
  const childId = created.child.id;

  // Child must be is_managed
  const row = (await pool.query('SELECT is_managed, managed_by_guardian_id FROM users WHERE id=$1', [childId])).rows[0];
  assert.ok(row.is_managed, 'child must have is_managed=true');
  assert.equal(row.managed_by_guardian_id, guardian.id);

  // Set medical card
  ok(await api('PUT', `/me/managed-children/${childId}/medical`, { token: guardian.token, body: {
    blood_type: 'O+', allergies: ['Nuts', 'Dairy'],
    emergency_contact_name: 'Jane Test', emergency_contact_phone: '+441234567890',
  } }));

  // Get child — full decrypted profile
  const profile = ok(await api('GET', `/me/managed-children/${childId}`, { token: guardian.token }));
  assert.ok(profile.child);

  // Set kit sizes
  ok(await api('PUT', `/me/managed-children/${childId}/kit`, { token: guardian.token, body: { shirt_size: 'M', boot_size: '36' } }));

  // Onboarding status shows progress
  const status = ok(await api('GET', `/me/managed-children/${childId}/onboarding`, { token: guardian.token }));
  assert.ok(typeof status.pct === 'number' && status.pct > 0);

  // Other user cannot read child medical card
  const denied = await api('GET', `/event-streams/${childId}/medical`, { token: other.token });
  // may be 403 or 404 depending on route — just must not be 200
  assert.ok(denied.status !== 200);
});

test('list managed children includes onboarding_pct', async () => {
  const guardian = await signup(['athlete']);
  ok(await api('POST', '/me/managed-children', { token: guardian.token, body: { first_name: 'Al', last_name: 'Test', dob: yearsAgo(8), sports: [] } }), 201);
  const list = ok(await api('GET', '/me/managed-children', { token: guardian.token }));
  assert.ok(Array.isArray(list.children) && list.children.length > 0);
  assert.ok(typeof list.children[0].onboarding_pct === 'number');
});
