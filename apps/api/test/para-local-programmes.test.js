// PS-29: Local para-sport programmes — government schemes and funding with source verification.
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
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `plp_${n}`, display_name: `Plp ${n}`, email: `plp${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const makeAdmin = async () => { const u = await signup(); await pool.query("UPDATE users SET roles = ARRAY['admin','platform_admin'] WHERE id=$1", [u.id]); return u; };

const KHELO = {
  country_iso: 'IN',
  name: 'Khelo India Para-Sport Programme',
  issuing_body: 'Ministry of Youth Affairs & Sports',
  eligibility_rules: 'IPC classified · Indian citizen · 14–35 yrs',
  grant_min_minor: 200000,
  grant_max_minor: 800000,
  currency: 'INR',
  source_url: 'https://kheloindia.gov.in/para-sports',
  disclaimer: 'Not an official partnership. Sourced Nov 2026.',
};

before(async () => { server = createApp().listen(0); base = `http://localhost:${server.address().port}`; });
after(async () => { server.close(); await pool.end(); });

test('list local programmes — empty initially, public access', async () => {
  const r = must(await api('GET', '/para/local-programmes'));
  assert.ok(Array.isArray(r.programmes));
});

test('upsert denied for non-platform-admin', async () => {
  const user = await signup(['organizer']);
  const r = await api('PUT', '/para/local-programmes', { token: user.token, body: KHELO });
  assert.equal(r.status, 403, 'non-admin must be denied');
});

test('upsert, list by country, review — platform admin only', async () => {
  const admin = await makeAdmin();

  // create
  const created = must(await api('PUT', '/para/local-programmes', { token: admin.token, body: KHELO }), 200);
  assert.equal(created.name, KHELO.name);
  assert.equal(created.country_iso, 'IN');
  assert.equal(created.verification_status, 'unverified');
  assert.equal(created.grant_min_minor, 200000);
  assert.equal(created.currency, 'INR');

  // public can see active programmes (even unverified)
  const listPublic = must(await api('GET', '/para/local-programmes', { query: { country_iso: 'IN' } }));
  assert.ok(listPublic.programmes.some((p) => p.name === KHELO.name));

  // review: mark sourced
  const sourced = must(await api('POST', `/para/local-programmes/${created.id}/review`, { token: admin.token, body: { verification_status: 'sourced' } }));
  assert.equal(sourced.verification_status, 'sourced');

  // review: mark verified
  const verified = must(await api('POST', `/para/local-programmes/${created.id}/review`, { token: admin.token, body: { verification_status: 'verified' } }));
  assert.equal(verified.verification_status, 'verified');
  assert.ok(verified.verified_at);
});

test('review denied for non-platform-admin', async () => {
  const user = await signup();
  const r = await api('POST', '/para/local-programmes/00000000-0000-0000-0000-000000000000/review', { token: user.token, body: { verification_status: 'verified' } });
  assert.equal(r.status, 403);
});

test('filter by country_iso and verification_status', async () => {
  const admin = await makeAdmin();
  await api('PUT', '/para/local-programmes', { token: admin.token, body: { ...KHELO, name: 'SG Enable Sports', country_iso: 'SG', issuing_body: 'SG Enable', source_url: 'https://sgenable.sg/sports', currency: 'SGD' } });

  const inOnly = must(await api('GET', '/para/local-programmes', { query: { country_iso: 'IN' } }));
  assert.ok(inOnly.programmes.every((p) => p.country_iso === 'IN'));

  const sgOnly = must(await api('GET', '/para/local-programmes', { query: { country_iso: 'SG' } }));
  assert.ok(sgOnly.programmes.every((p) => p.country_iso === 'SG'));

  const unverified = must(await api('GET', '/para/local-programmes', { query: { verification_status: 'unverified' } }));
  assert.ok(unverified.programmes.every((p) => p.verification_status === 'unverified'));
});

test('upsert is idempotent: second call updates same record', async () => {
  const admin = await makeAdmin();
  const r1 = must(await api('PUT', '/para/local-programmes', { token: admin.token, body: { ...KHELO, name: 'TOPS Para Athletes', country_iso: 'IN', issuing_body: 'SAI', source_url: 'https://sportsauthorityofindia.nic.in/tops' } }), 200);
  const r2 = must(await api('PUT', '/para/local-programmes', { token: admin.token, body: { ...KHELO, name: 'TOPS Para Athletes', country_iso: 'IN', issuing_body: 'SAI Updated', source_url: 'https://sportsauthorityofindia.nic.in/tops/v2' } }), 200);
  assert.equal(r1.id, r2.id, 'same record, not duplicated');
  assert.equal(r2.issuing_body, 'SAI Updated');
  assert.equal(r2.verification_status, 'unverified', 'upsert resets to unverified');
});
