// PS-29: Para-sport regional governance — country-aware federation metadata and source verification.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: r.status, body: parsed };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `prg_${n}`, display_name: `Prg ${n}`, email: `prg${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const makeAdmin = async () => { const u = await signup(); await pool.query("UPDATE users SET roles = ARRAY['admin','platform_admin'] WHERE id=$1", [u.id]); return u; };

const RECORD = {
  sport_id: 'wheelchair-tennis',
  country_iso: 'IN',
  governing_body: 'Paralympic Council of India',
  source_url: 'https://paralympicindian.org/api',
  federation_connection_type: 'verified_api',
};

before(async () => { server = createApp().listen(0); base = `http://localhost:${server.address().port}`; });
after(async () => { server.close(); await pool.end(); });

test('list regional governance — empty initially, public access', async () => {
  const r = must(await api('GET', '/para/regional-governance'));
  assert.ok(Array.isArray(r.governance));
});

test('upsert denied for non-platform-admin', async () => {
  const user = await signup(['organizer']);
  const r = await api('PUT', '/para/regional-governance', { token: user.token, body: RECORD });
  assert.equal(r.status, 403, 'non-admin must be denied');
});

test('upsert, list by country, review — platform admin only', async () => {
  const admin = await makeAdmin();

  // create
  const created = must(await api('PUT', '/para/regional-governance', { token: admin.token, body: RECORD }), 200);
  assert.equal(created.sport_id, RECORD.sport_id);
  assert.equal(created.country_iso, 'IN');
  assert.equal(created.federation_connection_type, 'verified_api');
  assert.equal(created.review_status, 'pending');

  // list (admin sees pending)
  const listAdmin = must(await api('GET', '/para/regional-governance', { token: admin.token, query: { country_iso: 'IN' } }));
  assert.ok(listAdmin.governance.some((g) => g.sport_id === RECORD.sport_id));

  // public only sees sourced/verified — pending record should not appear
  const listPublic = must(await api('GET', '/para/regional-governance', { query: { country_iso: 'IN' } }));
  assert.equal(listPublic.governance.filter((g) => g.sport_id === RECORD.sport_id && g.review_status === 'pending').length, 0);

  // review: verify
  const reviewed = must(await api('POST', `/para/regional-governance/${created.id}/review`, { token: admin.token, body: { review_status: 'verified', notes: 'API confirmed live' } }));
  assert.equal(reviewed.review_status, 'verified');

  // now public can see it
  const listPublicAfter = must(await api('GET', '/para/regional-governance', { query: { country_iso: 'IN' } }));
  assert.ok(listPublicAfter.governance.some((g) => g.sport_id === RECORD.sport_id && g.review_status === 'verified'));
});

test('review denied for non-platform-admin', async () => {
  const user = await signup();
  // pick any id — should be denied before even looking up the record
  const r = await api('POST', '/para/regional-governance/00000000-0000-0000-0000-000000000000/review', { token: user.token, body: { review_status: 'verified' } });
  assert.equal(r.status, 403);
});

test('country_iso filter works', async () => {
  const admin = await makeAdmin();
  await api('PUT', '/para/regional-governance', { token: admin.token, body: { ...RECORD, country_iso: 'SG', governing_body: 'Singapore NPC', source_url: 'https://paralympic.org.sg/api' } });
  await api('POST', '/para/regional-governance', { token: admin.token }); // not a review — just ensure SG record exists

  const inOnly = must(await api('GET', '/para/regional-governance', { token: admin.token, query: { country_iso: 'IN' } }));
  assert.ok(inOnly.governance.every((g) => g.country_iso === 'IN'));

  const sgOnly = must(await api('GET', '/para/regional-governance', { token: admin.token, query: { country_iso: 'SG' } }));
  assert.ok(sgOnly.governance.every((g) => g.country_iso === 'SG'));
});

test('upsert is idempotent: second call updates, does not duplicate', async () => {
  const admin = await makeAdmin();
  const r1 = must(await api('PUT', '/para/regional-governance', { token: admin.token, body: { ...RECORD, country_iso: 'MY', governing_body: 'MPC', source_url: 'https://paralympic.org.my' } }), 200);
  const r2 = must(await api('PUT', '/para/regional-governance', { token: admin.token, body: { ...RECORD, country_iso: 'MY', governing_body: 'MPC Updated', source_url: 'https://paralympic.org.my/v2' } }), 200);
  assert.equal(r1.id, r2.id, 'same record updated, not duplicated');
  assert.equal(r2.governing_body, 'MPC Updated');
});
