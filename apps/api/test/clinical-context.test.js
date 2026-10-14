// Issue #212 (slice 2a): problems / allergies / medications with provenance, reconciliation, explicit unknown vs none.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base, n = 0;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `ctx_${n}_${roles[0]}`, display_name: `Ctx ${n}`, email: `ctx${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); const u = { ...r.body.user, token: r.body.token };
  if (roles[0] !== 'athlete') must(await api('POST', '/me/sport-profiles', { token: u.token, body: { sport: 'football', role: roles[0] } }), 201);
  return u; };
const verify = async (u, type) => (await pool.query(
  "INSERT INTO verification_cases(type, subject_type, subject_id, requested_by, status, rules_version, decided_at, expires_at) VALUES ($1,'user',$2,$2,'approved',1,now(), now() + interval '300 days') RETURNING id", [type, u.id])).rows[0].id;
const setup = async () => {
  const ath = await signup(), doc = await signup(['doctor']);
  const caseId = await verify(doc, 'doctor');
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: doc.id } }), 201);
  return { ath, doc, caseId };
};
const penicillin = { kind: 'allergy', name: 'Penicillin', reaction: 'Rash' };

before(async () => { await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); await migrate(); server = createApp().listen(0); base = `http://localhost:${server.address().port}`; });
after(async () => { server.close(); await pool.end(); });

test('missing data is unknown, never "none"; none_reported is explicit and blocked while entries exist', async () => {
  const { ath } = await setup();
  assert.deepEqual(must(await api('GET', '/medical/context', { token: ath.token })).state, { problem: 'unknown', allergy: 'unknown', medication: 'unknown' });
  must(await api('POST', '/medical/context/declarations', { token: ath.token, body: { kind: 'allergy', state: 'none_reported' } }), 201);
  let ctx = must(await api('GET', '/medical/context', { token: ath.token }));
  assert.equal(ctx.state.allergy, 'none_reported'); assert.equal(ctx.state.medication, 'unknown');
  must(await api('POST', '/medical/context', { token: ath.token, body: { entry: penicillin } }), 201);
  assert.equal(must(await api('GET', '/medical/context', { token: ath.token })).state.allergy, 'entries');
  assert.equal((await api('POST', '/medical/context/declarations', { token: ath.token, body: { kind: 'allergy', state: 'none_reported' } })).status, 409);
});

test('patient entries are unverified; doctor confirms, disputes and corrects with history kept; content encrypted', async () => {
  const { ath, doc } = await setup();
  const e = must(await api('POST', '/medical/context', { token: ath.token, body: { entry: { kind: 'medication', name: 'Ibuprofen', strength: '400 mg', frequency: 'twice daily' } } }), 201);
  assert.equal(e.source, 'patient_reported'); assert.equal(e.verification, 'unverified');
  assert.ok(!(await pool.query('SELECT label_enc FROM clinical_context_entries WHERE id=$1', [e.id])).rows[0].label_enc.includes('Ibuprofen'));
  assert.equal((await api('POST', `/medical/context/${e.id}/reconcile`, { token: ath.token, body: { action: 'confirm' } })).status, 403, 'patients cannot self-confirm');
  const c = must(await api('POST', `/medical/context/${e.id}/reconcile`, { token: doc.token, body: { action: 'correct', entry: { kind: 'medication', name: 'Ibuprofen', strength: '200 mg', frequency: 'as needed' } } }), 201);
  assert.equal(c.supersedes_id, e.id); assert.equal(c.verification, 'confirmed'); assert.equal(c.source, 'clinician_recorded'); assert.equal(c.detail.strength, '200 mg');
  assert.equal((await api('POST', `/medical/context/${e.id}/reconcile`, { token: doc.token, body: { action: 'confirm' } })).status, 409, 'already superseded');
  const cur = must(await api('GET', `/medical/context?athlete_id=${ath.id}`, { token: doc.token }));
  assert.deepEqual(cur.entries.map((x) => x.id), [c.id]);
  assert.equal(must(await api('GET', '/medical/context?include_history=true', { token: ath.token })).entries.length, 2);
  const d = must(await api('POST', '/medical/context', { token: ath.token, body: { entry: { kind: 'problem', name: 'Knee pain' } } }), 201);
  assert.equal(must(await api('POST', `/medical/context/${d.id}/reconcile`, { token: doc.token, body: { action: 'dispute' } }), 201).verification, 'disputed');
  await assert.rejects(pool.query("UPDATE clinical_context_entries SET status='resolved' WHERE id=$1", [d.id]), /immutable/);
  await assert.rejects(pool.query('DELETE FROM clinical_context_entries WHERE id=$1', [d.id]), /never deleted/);
});

test('athlete may correct only their own unreviewed entry; concurrent corrections give one winner', async () => {
  const { ath, doc } = await setup();
  const e = must(await api('POST', '/medical/context', { token: ath.token, body: { entry: penicillin } }), 201);
  const attempts = await Promise.all([1, 2, 3].map((k) => api('POST', `/medical/context/${e.id}/reconcile`, { token: ath.token, body: { action: 'correct', entry: { ...penicillin, reaction: `Hives ${k}` } } })));
  assert.equal(attempts.filter((r) => r.status === 201).length, 1);
  assert.ok(attempts.filter((r) => r.status !== 201).every((r) => r.status === 409));
  const cur = must(await api('GET', '/medical/context', { token: ath.token })).entries[0];
  must(await api('POST', `/medical/context/${cur.id}/reconcile`, { token: doc.token, body: { action: 'confirm' } }), 201);
  assert.equal((await api('POST', `/medical/context/${cur.id}/reconcile`, { token: ath.token, body: { action: 'correct', entry: penicillin } })).status, 403, 'reviewed entries are the doctor\'s to correct');
  assert.equal((await api('POST', `/medical/context/${cur.id}/reconcile`, { token: doc.token, body: { action: 'correct', entry: { kind: 'problem', name: 'x' } } })).status, 400, 'same kind only');
});

test('doctor access needs credential + consent; physio cannot write; strangers see nothing; revocation blocks', async () => {
  const { ath, doc, caseId } = await setup();
  const stranger = await signup(['doctor']); await verify(stranger, 'doctor');
  assert.equal((await api('GET', `/medical/context?athlete_id=${ath.id}`, { token: stranger.token })).status, 403);
  assert.equal((await api('POST', '/medical/context', { token: stranger.token, body: { athlete_id: ath.id, entry: penicillin } })).status, 403);
  const physio = await signup(['physio']); await verify(physio, 'physio');
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: physio.id } }), 201);
  assert.equal((await api('POST', '/medical/context', { token: physio.token, body: { athlete_id: ath.id, entry: penicillin } })).status, 403, 'doctors record; physios read');
  must(await api('POST', '/medical/context', { token: doc.token, body: { athlete_id: ath.id, entry: penicillin, review_date: '2027-01-01' } }), 201);
  assert.equal(must(await api('GET', `/medical/context?athlete_id=${ath.id}`, { token: physio.token })).entries.length, 1);
  must(await api('DELETE', `/medical/grants/${doc.id}`, { token: ath.token }));
  assert.equal((await api('POST', '/medical/context', { token: doc.token, body: { athlete_id: ath.id, entry: penicillin } })).status, 403);
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: doc.id } }), 201);
  await pool.query("UPDATE verification_cases SET status='revoked' WHERE id=$1", [caseId]);
  assert.equal((await api('GET', `/medical/context?athlete_id=${ath.id}`, { token: doc.token })).body.error.code, 'credential_required');
  assert.equal((await api('POST', '/medical/context', { token: ath.token, body: { entry: penicillin, review_date: '2027-01-01' } })).status, 400, 'patients do not set review dates');
});

test('capabilities appear in OpenAPI with the clinical scope', async () => {
  const { buildOpenApi } = await import('../src/openapi.js');
  const ops = Object.values(buildOpenApi().paths).flatMap((p) => Object.values(p));
  for (const name of ['add_context_entry', 'reconcile_context_entry', 'set_context_declaration', 'list_context']) assert.equal(ops.find((o) => o.operationId === name)?.['x-required-scope'], 'clinical', name);
});
