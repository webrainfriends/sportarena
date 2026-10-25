import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `ad_${n}_${roles[0]}`, display_name: `Addr ${n}`, email: `ad${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('a person keeps several addresses, one default, street lines encrypted and audited, archive instead of delete', async () => {
  const u = await signup(), other = await signup();
  assert.equal((await api('GET', '/addresses')).status, 401);
  assert.equal((await api('POST', '/addresses', { token: u.token, body: { kind: 'home' } })).status, 400, 'something to locate is required');

  const home = must(await api('POST', '/addresses', { token: u.token, body: { kind: 'home', locality: 'Chennai', line1: '12 Beach Road', postal_code: '600001', country: 'IN' } }), 201);
  assert.equal(home.is_default, true, 'the first address is the default');
  assert.equal(home.line1, '12 Beach Road');
  const raw = (await pool.query('SELECT line1, postal_code, pii_enc FROM addresses WHERE id=$1', [home.id])).rows[0];
  assert.equal(raw.line1, null);
  assert.equal(raw.postal_code, null);
  assert.match(raw.pii_enc, /^v1\./, 'street lines are stored encrypted');

  const play = must(await api('POST', '/addresses', { token: u.token, body: { kind: 'training', locality: 'Tirunelveli', area: 'Palayamkottai' } }), 201);
  assert.equal(play.is_default, false);
  must(await api('POST', `/addresses/${play.id}/default`, { token: u.token, body: {} }));
  let list = must(await api('GET', '/addresses', { token: u.token }));
  assert.deepEqual(list.map((a) => a.locality), ['Tirunelveli', 'Chennai']);
  assert.equal(list.filter((a) => a.is_default).length, 1);
  assert.equal(list[1].line1, '12 Beach Road');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE actor_id=$1 AND entity='addresses'", [u.id])).rowCount > 0, 'decrypting is audit-logged');

  const edited = must(await api('PATCH', `/addresses/${home.id}`, { token: u.token, body: { line2: 'Flat 4' } }));
  assert.equal(edited.line1, '12 Beach Road');
  assert.equal(edited.line2, 'Flat 4');

  assert.equal((await api('PATCH', `/addresses/${home.id}`, { token: other.token, body: { label: 'mine' } })).status, 403, 'not yours');
  assert.equal((await api('GET', '/addresses', { token: other.token, query: { owner_kind: 'user', owner_id: u.id } })).status, 403);

  must(await api('DELETE', `/addresses/${play.id}`, { token: u.token }));
  list = must(await api('GET', '/addresses', { token: u.token }));
  assert.equal(list.length, 1);
  assert.equal(list[0].is_default, true, 'default passes to the remaining address');
  assert.equal((await pool.query('SELECT count(*)::int n FROM addresses WHERE id=$1 AND archived_at IS NOT NULL', [play.id])).rows[0].n, 1, 'archived, not deleted');
});

test('organisation addresses: staff manage, members read, outsiders cannot; context link; place lookup', async () => {
  const owner = await signup(['organizer']), coach = await signup(['coach']), outsider = await signup();
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: 'Sportstars Academy', kind: 'academy' } }), 201);
  must(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: coach.handle, role: 'coach' } }), 201);
  must(await api('POST', `/organisations/${org.id}/invite/respond`, { token: coach.token, body: { accept: true } }));

  const a = must(await api('POST', '/addresses', { token: owner.token, body: { owner_kind: 'organisation', owner_id: org.id, kind: 'billing', line1: '1 Main St', locality: 'Bristol', country: 'GB', context_kind: 'organisation', context_id: org.id } }), 201);
  assert.equal(a.line1, '1 Main St');
  assert.equal((await pool.query('SELECT line1, pii_enc FROM addresses WHERE id=$1', [a.id])).rows[0].pii_enc, null, 'organisation addresses are not personal data');
  assert.equal((await api('POST', '/addresses', { token: owner.token, body: { owner_kind: 'organisation', locality: 'X' } })).status, 400);
  assert.equal((await api('POST', '/addresses', { token: owner.token, body: { owner_kind: 'organisation', owner_id: org.id, locality: 'X', context_kind: 'event' } })).status, 400, 'context_id needed');
  assert.equal((await api('POST', '/addresses', { token: coach.token, body: { owner_kind: 'organisation', owner_id: org.id, locality: 'Leeds' } })).status, 403, 'coaches cannot edit');
  assert.equal(must(await api('GET', '/addresses', { token: coach.token, query: { owner_kind: 'organisation', owner_id: org.id } })).length, 1);
  assert.equal((await api('GET', '/addresses', { token: outsider.token, query: { owner_kind: 'organisation', owner_id: org.id } })).status, 404);

  const regions = must(await api('GET', '/regions', { token: owner.token, query: { q: 'bris' } }));
  assert.ok(regions.includes('Bristol'), 'city lookups include addresses');
});

test('migration copies existing cities/regions once, keeps old columns, and is idempotent', async () => {
  const u = await signup(), t = await signup(['coach']);
  const sport = (await pool.query("SELECT id FROM sports WHERE slug='football'")).rows[0].id;
  const sp = (await pool.query("INSERT INTO sport_profiles(user_id, sport_id, role, region) VALUES ($1,$2,'athlete','Madurai') RETURNING id", [u.id, sport])).rows[0].id;
  const team = (await pool.query("INSERT INTO teams(name, sport_id, owner_id, city) VALUES ('Old FC',$1,$2,'Salem') RETURNING id", [sport, t.id])).rows[0].id;
  const sql = await readFile(new URL('../migrations/107_addresses.sql', import.meta.url), 'utf8');
  await pool.query(sql);
  await pool.query(sql);
  const rows = (await pool.query("SELECT owner_kind, locality, is_default, sport_id FROM addresses WHERE source_ref IN ($1,$2)", [`sport_profiles:${sp}`, `teams:${team}`])).rows;
  assert.equal(rows.length, 2, 'copied exactly once');
  assert.ok(rows.find((r) => r.owner_kind === 'user' && r.locality === 'Madurai' && r.sport_id === sport));
  assert.equal((await pool.query('SELECT region FROM sport_profiles WHERE id=$1', [sp])).rows[0].region, 'Madurai', 'old column untouched');
});
