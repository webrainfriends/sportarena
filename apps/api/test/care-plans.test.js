// Issue #212 (slice 2d): versioned care plans - immutability, supersession, patient log separation, authorization.
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
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `cp_${n}_${roles[0]}`, display_name: `CP ${n}`, email: `cp${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); const u = { ...r.body.user, token: r.body.token };
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
const plan = { goals: [{ text: 'Walk without pain', baseline: 'Pain 6/10 on stairs' }], instructions: 'Rest, then gentle walking', review_interval_days: 14,
  actions: [{ title: 'Blood test', responsible: 'patient', due_date: '2020-01-01', completion_criteria: 'Sample given' }, { title: 'Review visit', responsible: 'doctor' }] };
const mkPublished = async (ath, doc) => {
  const p = must(await api('POST', '/medical/care-plans', { token: doc.token, body: { athlete_id: ath.id, title: 'Knee plan', body: plan } }), 201);
  must(await api('POST', `/medical/care-plans/${p.id}/publish`, { token: doc.token, body: { row_version: p.draft.row_version } }));
  return p.id;
};

before(async () => { await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); await migrate(); server = createApp().listen(0); base = `http://localhost:${server.address().port}`; });
after(async () => { server.close(); await pool.end(); });

test('draft is private until published; published versions are immutable and revisions supersede them', async () => {
  const { ath, doc } = await setup();
  const p = must(await api('POST', '/medical/care-plans', { token: doc.token, body: { athlete_id: ath.id, title: 'Knee plan', body: plan } }), 201);
  assert.equal(must(await api('GET', '/medical/care-plans', { token: ath.token })).length, 0);
  assert.equal((await api('GET', `/medical/care-plans/${p.id}`, { token: ath.token })).status, 404);
  assert.equal((await api('PATCH', `/medical/care-plans/${p.id}/draft`, { token: doc.token, body: { row_version: 99, body: plan } })).status, 409, 'stale draft');
  const upd = must(await api('PATCH', `/medical/care-plans/${p.id}/draft`, { token: doc.token, body: { row_version: p.draft.row_version, body: { ...plan, instructions: 'Rest, then walk' } } }));
  assert.equal((await api('POST', `/medical/care-plans/${p.id}/publish`, { token: doc.token, body: { row_version: p.draft.row_version } })).status, 409, 'publishing a stale view is refused');
  must(await api('POST', `/medical/care-plans/${p.id}/publish`, { token: doc.token, body: { row_version: upd.row_version } }));
  const mine = must(await api('GET', `/medical/care-plans/${p.id}`, { token: ath.token }));
  assert.equal(mine.status, 'active'); assert.equal(mine.versions.length, 1); assert.equal(mine.versions[0].body.instructions, 'Rest, then walk');
  assert.ok(!(await pool.query('SELECT body_enc FROM clinical_care_plan_versions WHERE plan_id=$1', [p.id])).rows[0].body_enc.includes('Knee'), 'encrypted');
  await assert.rejects(pool.query("UPDATE clinical_care_plan_versions SET body_enc='x' WHERE plan_id=$1", [p.id]), /immutable/);
  await assert.rejects(pool.query('DELETE FROM clinical_care_plan_versions WHERE plan_id=$1', [p.id]), /never deleted/);
  // revision: the patient keeps seeing v1 until v2 is published
  const rev = must(await api('POST', `/medical/care-plans/${p.id}/revise`, { token: doc.token, body: {} }), 201);
  assert.equal(rev.version_no, 2);
  assert.equal((await api('POST', `/medical/care-plans/${p.id}/revise`, { token: doc.token, body: {} })).status, 409, 'one draft at a time');
  const full = must(await api('GET', `/medical/care-plans/${p.id}`, { token: doc.token }));
  const keys = full.versions.find((v) => v.version_no === 2).body.actions.map((a) => a.key);
  assert.deepEqual(keys, full.versions[0].body.actions.map((a) => a.key), 'action keys carry over');
  assert.equal(must(await api('GET', `/medical/care-plans/${p.id}`, { token: ath.token })).versions.length, 1);
  must(await api('PATCH', `/medical/care-plans/${p.id}/draft`, { token: doc.token, body: { row_version: rev.row_version, body: { ...plan, actions: [{ ...full.versions[0].body.actions[0], title: 'Blood test (fasting)' }] } } }));
  must(await api('POST', `/medical/care-plans/${p.id}/publish`, { token: doc.token, body: { row_version: rev.row_version + 1 } }));
  const after = must(await api('GET', `/medical/care-plans/${p.id}`, { token: doc.token }));
  assert.deepEqual(after.versions.map((v) => v.status), ['superseded', 'published']);
  assert.equal(must(await api('GET', `/medical/care-plans/${p.id}`, { token: ath.token })).versions[0].body.actions[0].title, 'Blood test (fasting)');
});

test('patient entries are a separate log; done is not confirmed; overdue is not adherence; history survives revisions', async () => {
  const { ath, doc } = await setup();
  const id = await mkPublished(ath, doc);
  let v = must(await api('GET', `/medical/care-plans/${id}`, { token: ath.token })).versions[0].body;
  const [blood, review] = v.actions;
  assert.equal(blood.state, 'open'); assert.equal(blood.overdue, true); assert.equal(review.overdue, false);
  assert.equal((await api('POST', `/medical/care-plans/${id}/entries`, { token: ath.token, body: { kind: 'completed' } })).status, 400, 'needs an action');
  assert.equal((await api('POST', `/medical/care-plans/${id}/entries`, { token: ath.token, body: { kind: 'completed', action_key: '00000000-0000-4000-8000-000000000000' } })).status, 404);
  must(await api('POST', `/medical/care-plans/${id}/entries`, { token: ath.token, body: { kind: 'unable', action_key: blood.key, note: 'No transport' } }));
  must(await api('POST', `/medical/care-plans/${id}/entries`, { token: ath.token, body: { kind: 'completed', action_key: blood.key } }));
  must(await api('POST', `/medical/care-plans/${id}/entries`, { token: ath.token, body: { kind: 'symptom', note: 'More swelling' } }));
  assert.equal((await api('POST', `/medical/care-plans/${id}/entries`, { token: ath.token, body: { kind: 'clinician_confirmed', action_key: blood.key } })).status, 403, 'patients cannot confirm');
  assert.equal((await api('POST', `/medical/care-plans/${id}/entries`, { token: doc.token, body: { kind: 'completed', action_key: blood.key } })).status, 403, 'doctor cannot log patient progress');
  v = must(await api('GET', `/medical/care-plans/${id}`, { token: doc.token }));
  assert.equal(v.versions[0].body.actions[0].state, 'done_reported'); assert.equal(v.versions[0].body.actions[0].overdue, false);
  assert.equal(v.entries.length, 3); assert.equal(v.entries[0].note, 'No transport');
  must(await api('POST', `/medical/care-plans/${id}/entries`, { token: doc.token, body: { kind: 'clinician_confirmed', action_key: blood.key } }));
  // revise and publish: the confirmed history carries over via the action key
  const rev = must(await api('POST', `/medical/care-plans/${id}/revise`, { token: doc.token, body: {} }), 201);
  must(await api('POST', `/medical/care-plans/${id}/publish`, { token: doc.token, body: { row_version: rev.row_version } }));
  const now = must(await api('GET', `/medical/care-plans/${id}`, { token: ath.token }));
  assert.equal(now.versions[0].version_no, 2); assert.equal(now.versions[0].body.actions[0].state, 'confirmed');
  await assert.rejects(pool.query("UPDATE clinical_care_plan_entries SET kind='completed'"), /append-only/);
});

test('pause blocks entries; completion is the doctor\'s decision and final; only the owning doctor with consent can touch a plan', async () => {
  const { ath, doc, caseId } = await setup();
  const id = await mkPublished(ath, doc);
  const key = must(await api('GET', `/medical/care-plans/${id}`, { token: ath.token })).versions[0].body.actions[0].key;
  must(await api('POST', `/medical/care-plans/${id}/state`, { token: doc.token, body: { state: 'paused' } }));
  assert.equal((await api('POST', `/medical/care-plans/${id}/entries`, { token: ath.token, body: { kind: 'completed', action_key: key } })).status, 409);
  must(await api('POST', `/medical/care-plans/${id}/state`, { token: doc.token, body: { state: 'active' } }));
  const other = await signup(['doctor']); await verify(other, 'doctor');
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: other.id } }), 201);
  assert.equal((await api('GET', `/medical/care-plans/${id}`, { token: other.token })).status, 404, 'another consented doctor does not own it');
  assert.equal((await api('POST', `/medical/care-plans/${id}/state`, { token: other.token, body: { state: 'completed' } })).status, 404);
  const stranger = await signup();
  assert.equal((await api('GET', `/medical/care-plans/${id}`, { token: stranger.token })).status, 404);
  assert.equal((await api('GET', `/medical/care-plans?athlete_id=${ath.id}`, { token: stranger.token })).status, 403);
  must(await api('DELETE', `/medical/grants/${doc.id}`, { token: ath.token }));
  assert.equal((await api('POST', `/medical/care-plans/${id}/revise`, { token: doc.token, body: {} })).status, 403);
  assert.equal((await api('POST', '/medical/care-plans', { token: doc.token, body: { athlete_id: ath.id, title: 'x' } })).status, 403);
  assert.equal(must(await api('GET', `/medical/care-plans/${id}`, { token: ath.token })).status, 'active', 'patient keeps access');
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: doc.id } }), 201);
  must(await api('POST', `/medical/care-plans/${id}/state`, { token: doc.token, body: { state: 'completed' } }));
  assert.equal((await api('POST', `/medical/care-plans/${id}/state`, { token: doc.token, body: { state: 'active' } })).status, 409);
  await pool.query("UPDATE verification_cases SET status='revoked' WHERE id=$1", [caseId]);
  assert.equal((await api('GET', `/medical/care-plans/${id}`, { token: doc.token })).body.error.code, 'credential_required');
});

test('an empty draft cannot be published; capabilities appear in OpenAPI with the clinical scope', async () => {
  const { ath, doc } = await setup();
  const p = must(await api('POST', '/medical/care-plans', { token: doc.token, body: { athlete_id: ath.id, title: 'Empty' } }), 201);
  assert.equal((await api('POST', `/medical/care-plans/${p.id}/publish`, { token: doc.token, body: { row_version: p.draft.row_version } })).status, 400);
  const { buildOpenApi } = await import('../src/openapi.js');
  const ops = Object.values(buildOpenApi().paths).flatMap((x) => Object.values(x));
  for (const name of ['create_care_plan', 'update_care_plan_draft', 'publish_care_plan', 'revise_care_plan', 'set_care_plan_state', 'log_care_plan_entry', 'list_care_plans', 'get_care_plan']) assert.equal(ops.find((o) => o.operationId === name)?.['x-required-scope'], 'clinical', name);
});
