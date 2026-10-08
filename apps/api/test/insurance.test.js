import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');

let server, base, n = 0, admin, admin2;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `in_${n}_${roles[0]}`, display_name: `Insure ${n}`, email: `in${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const mkAdmin = async (h) => { const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ($1,$1,'{admin}','x','x',$1) RETURNING id", [h])).rows[0]; return { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) }; };
const plan = (body) => api('POST', '/insurance/plans', { token: admin.token, body: { name: 'Plan', cover_for: 'individual', premium_cents: 50000, coverage_cents: 500000, ...body } });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  admin = await mkAdmin('in_root'); admin2 = await mkAdmin('in_root2');
});
after(async () => { server.close(); await pool.end(); });

test('insurers: admin-managed, licence encrypted, verification needs a licence, listing is public', async () => {
  const u = await signup();
  assert.equal((await api('POST', '/insurance/insurers', { token: u.token, body: { name: 'Nope Ltd' } })).status, 403);
  const a = must(await api('POST', '/insurance/insurers', { token: admin.token, body: { name: 'SafeSport', licence_no: 'LIC-998877' } }), 201);
  assert.equal((await api('POST', '/insurance/insurers', { token: admin.token, body: { name: 'safesport' } })).status, 409, 'names are unique ignoring case');
  assert.ok(!JSON.stringify((await pool.query('SELECT * FROM insurers WHERE id=$1', [a.id])).rows[0]).includes('LIC-998877'));
  const b = must(await api('POST', '/insurance/insurers', { token: admin.token, body: { name: 'NoLicence Co' } }), 201);
  assert.equal((await api('POST', `/insurance/insurers/${b.id}/verify`, { token: admin.token, body: {} })).status, 400);
  assert.ok(must(await api('POST', `/insurance/insurers/${a.id}/verify`, { token: admin.token, body: {} })).verified_at);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='read_pii' AND entity='insurers'")).rows[0].n, 1);
  const list = must(await api('GET', '/insurance/insurers'));
  assert.deepEqual(list.map((x) => [x.name, x.verified]), [['NoLicence Co', false], ['SafeSport', true]]);
  assert.deepEqual(must(await api('GET', '/insurance/insurers', { query: { verified: 'true' } })).map((x) => x.name), ['SafeSport']);
});

test('plan search: filters, sorting, pagination and the same normalised terms on every card', async () => {
  const safe = (await pool.query("SELECT id FROM insurers WHERE name='SafeSport'")).rows[0].id;
  must(await plan({ name: 'Basic Shield', insurer_id: safe, premium_cents: 30000, coverage_cents: 300000, sports: ['football'], min_age: 16, max_age: 40, term_months_min: 3, term_months_max: 12, deductible_cents: 5000, waiting_period_days: 7, exclusions: 'Pre-existing injuries; professional contests', conditions: 'Claims within 30 days' }), 201);
  must(await plan({ name: 'Elite Shield', insurer: 'NewInsure', premium_cents: 90000, coverage_cents: 2000000, term_months_max: 36, exclusions: 'War; self-inflicted injury' }), 201);
  must(await plan({ name: 'Club Squad', cover_for: 'team', insurer_id: safe, premium_cents: 150000, coverage_cents: 5000000 }), 201);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM insurers WHERE name='NewInsure'")).rows[0].n, 1, 'insurer created on first use');

  const all = must(await api('GET', '/insurance/plans'));
  assert.deepEqual(all.map((p) => p.name), ['Basic Shield', 'Elite Shield', 'Club Squad']);
  const basic = all[0];
  assert.deepEqual(basic.term_months, { min: 3, max: 12 }); assert.deepEqual(basic.eligibility, { min_age: 16, max_age: 40, sports: ['football'] });
  assert.equal(basic.insurer, 'SafeSport'); assert.equal(basic.insurer_verified, true); assert.equal(basic.currency, 'INR');
  assert.ok(all.every((p) => 'exclusions' in p && 'conditions' in p && 'deductible_cents' in p), 'terms are on every card');
  const q = (query) => api('GET', '/insurance/plans', { query }).then((r) => r.body.map((p) => p.name));
  assert.deepEqual(await q({ cover_for: 'team' }), ['Club Squad']);
  assert.deepEqual(await q({ sort: 'coverage' }), ['Club Squad', 'Elite Shield', 'Basic Shield']);
  assert.deepEqual(await q({ verified_insurer: 'true' }), ['Basic Shield', 'Club Squad']);
  assert.deepEqual(await q({ max_premium_cents: 50000 }), ['Basic Shield']);
  assert.deepEqual(await q({ min_coverage_cents: 1000000, cover_for: 'individual' }), ['Elite Shield']);
  assert.deepEqual(await q({ sport: 'football', cover_for: 'individual' }), ['Basic Shield', 'Elite Shield'], 'all-sport plans also match');
  assert.deepEqual(await q({ sport: 'tennis', cover_for: 'individual' }), ['Elite Shield']);
  assert.deepEqual(await q({ age: 50, cover_for: 'individual' }), ['Elite Shield']);
  assert.deepEqual(await q({ term_months: 24, cover_for: 'individual' }), ['Elite Shield']);
  assert.deepEqual(await q({ q: 'newinsure' }), ['Elite Shield']);
  assert.deepEqual(await q({ q: 'zzz-nothing' }), [], 'empty result is an empty list');
  assert.deepEqual(await q({ limit: '1', offset: '1' }), ['Elite Shield']);
  assert.equal((await api('GET', '/insurance/plans', { query: { sort: 'popularity' } })).status, 400, 'no hidden ranking: only explicit sorts');
  assert.ok(!JSON.stringify(all).includes('policy_no'), 'discovery never touches private policies');

  const [a, b, c] = all;
  const cmp = must(await api('GET', '/insurance/plan-comparison', { query: { ids: `${a.id},${b.id}` } }));
  assert.deepEqual(cmp.plans.map((p) => p.name), ['Basic Shield', 'Elite Shield']);
  assert.ok(cmp.differences.includes('exclusions') && cmp.differences.includes('premium_cents'));
  assert.deepEqual([cmp.highlights.lowest_premium, cmp.highlights.highest_coverage], [[a.id], [b.id]]);
  assert.equal(cmp.plans[0].exclusions, 'Pre-existing injuries; professional contests', 'exclusions shown in full');
  assert.equal((await api('GET', '/insurance/plan-comparison', { query: { ids: a.id } })).status, 400);
  assert.equal((await api('GET', '/insurance/plan-comparison', { query: { ids: `${a.id},${crypto.randomUUID()}` } })).status, 404);
  assert.equal(c.cover_for, 'team');
});

test('buying checks the plan state, term, age, sport; terms are snapshotted so plan edits never change sold cover', async () => {
  const [basic, elite] = (await api('GET', '/insurance/plans', { query: { cover_for: 'individual' } })).body;
  const u = await signup();
  assert.equal((await api('POST', '/insurance/policies', { token: u.token, body: { plan_id: basic.id, months: 24 } })).status, 400, 'term above the plan maximum');
  assert.equal((await api('POST', '/insurance/policies', { token: u.token, body: { plan_id: basic.id, months: 6 } })).status, 400, 'age limit needs a date of birth');
  await api('PATCH', '/me', { token: u.token, body: { dob: '1990-05-01' } });
  assert.equal((await api('POST', '/insurance/policies', { token: u.token, body: { plan_id: basic.id, months: 6 } })).status, 400, 'football is not on the profile');
  await api('POST', '/me/sport-profiles', { token: u.token, body: { sport: 'football', role: 'athlete' } });
  const pol = must(await api('POST', '/insurance/policies', { token: u.token, body: { plan_id: basic.id, months: 6, beneficiary: 'Partner' } }), 201);
  assert.equal(pol.terms.coverage_cents, 300000); assert.equal(pol.terms.exclusions, 'Pre-existing injuries; professional contests');
  const young = await signup(); await api('PATCH', '/me', { token: young.token, body: { dob: '2015-01-01' } });
  assert.equal((await api('POST', '/insurance/policies', { token: young.token, body: { plan_id: basic.id, months: 6 } })).status, 400, 'under the minimum age');

  // the admin raises the price, cuts the cover and later retires the plan: the sold policy keeps its terms
  must(await api('PATCH', `/insurance/plans/${basic.id}`, { token: admin.token, body: { premium_cents: 99000, coverage_cents: 100000 } }));
  assert.equal((await api('PATCH', `/insurance/plans/${basic.id}`, { token: u.token, body: { premium_cents: 1 } })).status, 403);
  assert.equal((await api('PATCH', `/insurance/plans/${basic.id}`, { token: admin.token, body: { min_age: 50, max_age: 20 } })).status, 400);
  const claim = must(await api('POST', `/insurance/policies/${pol.id}/claims`, { token: u.token, body: { description: 'Sprained ankle in training', amount_cents: 250000 } }), 201);
  assert.equal(Number(claim.amount_cents), 250000, 'cover is the 300000 the policy was bought with, not the 100000 now on the plan');
  must(await api('PATCH', `/insurance/plans/${basic.id}`, { token: admin.token, body: { status: 'retired' } }));
  assert.equal((await api('POST', '/insurance/policies', { token: u.token, body: { plan_id: basic.id, months: 6 } })).status, 409, 'retired plans are not sold');
  assert.ok(!(await api('GET', '/insurance/plans')).body.some((p) => p.id === basic.id));
  assert.ok((await api('GET', '/insurance/plans', { query: { status: 'retired' } })).body.some((p) => p.id === basic.id));
  assert.equal(elite.name, 'Elite Shield');
});

test('claims: cumulative cover, waiting period, ordered review, reasons, history, notification, self-review blocked', async () => {
  const [elite] = (await api('GET', '/insurance/plans', { query: { cover_for: 'individual', q: 'Elite' } })).body;
  const u = await signup();
  const pol = must(await api('POST', '/insurance/policies', { token: u.token, body: { plan_id: elite.id, months: 12 } }), 201);
  const file = (body) => api('POST', `/insurance/policies/${pol.id}/claims`, { token: u.token, body: { description: 'Torn ligament during a match', ...body } });
  assert.equal((await file({ amount_cents: 2500000 })).status, 400, 'above the cover');
  assert.equal((await file({ amount_cents: 1000, incident_on: '2999-01-01' })).status, 400, 'future incident');
  assert.equal((await file({ amount_cents: 1000, incident_on: '2001-01-01' })).status, 400, 'before the policy');
  const c1 = must(await file({ amount_cents: 1500000, incident_on: new Date().toISOString().slice(0, 10) }), 201);
  assert.equal((await file({ amount_cents: 600000 })).status, 409, 'only 500000 of the cover is left');
  const c2 = must(await file({ amount_cents: 400000 }), 201);

  assert.equal((await api('PATCH', `/insurance/claims/${c1.id}`, { token: u.token, body: { status: 'approved' } })).status, 403);
  assert.equal((await api('PATCH', `/insurance/claims/${c1.id}`, { token: admin.token, body: { status: 'paid' } })).status, 409, 'cannot skip approval');
  assert.equal((await api('PATCH', `/insurance/claims/${c1.id}`, { token: admin.token, body: { status: 'rejected' } })).status, 400, 'a rejection needs a reason');
  must(await api('PATCH', `/insurance/claims/${c1.id}`, { token: admin.token, body: { status: 'under_review' } }));
  must(await api('PATCH', `/insurance/claims/${c1.id}`, { token: admin2.token, body: { status: 'approved' } }));
  assert.equal((await api('PATCH', `/insurance/claims/${c1.id}`, { token: admin.token, body: { status: 'under_review' } })).status, 409, 'decided claims do not go back');
  must(await api('PATCH', `/insurance/claims/${c1.id}`, { token: admin.token, body: { status: 'paid' } }));
  assert.equal((await api('PATCH', `/insurance/claims/${c1.id}`, { token: admin.token, body: { status: 'rejected', reason: 'changed my mind' } })).status, 409);
  must(await api('PATCH', `/insurance/claims/${c2.id}`, { token: admin.token, body: { status: 'rejected', reason: 'Not covered: pre-existing condition' } }));

  const got = must(await api('GET', `/insurance/claims/${c2.id}`, { token: u.token }));
  assert.equal(got.status, 'rejected'); assert.equal(got.decision_reason, 'Not covered: pre-existing condition'); assert.equal(got.description, 'Torn ligament during a match');
  assert.deepEqual(got.history.map((h) => h.action), ['file', 'rejected']);
  assert.equal((await api('GET', `/insurance/claims/${c2.id}`, { token: (await signup()).token })).status, 404);
  assert.ok(!JSON.stringify((await pool.query('SELECT * FROM insurance_claims WHERE id=$1', [c2.id])).rows[0]).includes('ligament'));
  assert.ok((await pool.query("SELECT body FROM notifications WHERE user_id=$1 AND kind='claim_update'", [u.id])).rows.every((r) => !/ligament|pre-existing/i.test(r.body)), 'notifications carry no claim detail');
  assert.ok((await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='claim_update'", [u.id])).rowCount >= 3);
  await assert.rejects(pool.query('DELETE FROM insurance_claim_events'), /append-only/);
  // a rejected claim frees its share of the cover
  must(await file({ amount_cents: 400000 }), 201);
  const mine = must(await api('GET', '/insurance/claims', { token: u.token, query: { status: 'paid' } }));
  assert.deepEqual(mine.map((c) => c.id), [c1.id]);

  // an admin who files a claim cannot review it
  const ap = must(await api('POST', '/insurance/policies', { token: admin.token, body: { plan_id: elite.id, months: 3 } }), 201);
  const own = must(await api('POST', `/insurance/policies/${ap.id}/claims`, { token: admin.token, body: { description: 'My own claim here', amount_cents: 1000 } }), 201);
  assert.equal((await api('PATCH', `/insurance/claims/${own.id}`, { token: admin.token, body: { status: 'approved' } })).status, 403);
});

test('waiting period blocks early incidents', async () => {
  const wp = must(await plan({ name: 'Waiting', insurer: 'SafeSport', waiting_period_days: 30 }), 201);
  const u = await signup();
  const pol = must(await api('POST', '/insurance/policies', { token: u.token, body: { plan_id: wp.id } }), 201);
  const r = await api('POST', `/insurance/policies/${pol.id}/claims`, { token: u.token, body: { description: 'Early incident here', amount_cents: 1000, incident_on: new Date().toISOString().slice(0, 10) } });
  assert.equal(r.status, 409); assert.match(r.body.error.message, /30-day waiting period/);
});

test('migration keeps existing plans, policies and claims and backfills the insurer link and the policy terms', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../migrations/', import.meta.url);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE TABLE schema_migrations (name text PRIMARY KEY, at timestamptz DEFAULT now())');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql') && x < '017_insurance_catalogue.sql').sort()) { await pool.query(readFileSync(new URL(f, dir), 'utf8')); await pool.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]); }
  const u = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('old','Old','{athlete}','x','x','oldidx') RETURNING id")).rows[0].id;
  const [p1] = (await pool.query("INSERT INTO insurance_plans(name, insurer, cover_for, premium_cents, coverage_cents) VALUES ('A','SafeSport','individual',1000,50000),('B','safesport','team',2000,90000) RETURNING id")).rows.map((r) => r.id);
  const pol = (await pool.query("INSERT INTO insurance_policies(plan_id, holder_id, subject_type, subject_id, policy_no_enc, ends_on) VALUES ($1,$2,'individual',$2,'enc', current_date + 30) RETURNING id", [p1, u])).rows[0].id;
  await pool.query("INSERT INTO insurance_claims(policy_id, claimant_id, description_enc, amount_cents) VALUES ($1,$2,'enc',100)", [pol, u]);
  await migrate();
  const plans = (await pool.query('SELECT p.id, p.insurer, p.insurer_id, p.status, i.name FROM insurance_plans p JOIN insurers i ON i.id=p.insurer_id ORDER BY p.name')).rows;
  assert.equal(plans.length, 2); assert.equal(plans[0].insurer_id, plans[1].insurer_id, 'same insurer ignoring case');
  assert.deepEqual(plans.map((p) => [p.insurer, p.status]), [['SafeSport', 'active'], ['safesport', 'active']], 'the old text and the plans themselves are untouched');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM insurers')).rows[0].n, 1);
  const terms = (await pool.query('SELECT terms FROM insurance_policies WHERE id=$1', [pol])).rows[0].terms;
  assert.equal(terms.coverage_cents, 50000); assert.equal(terms.premium_cents, 1000);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM insurance_claims')).rows[0].n, 1);
});
