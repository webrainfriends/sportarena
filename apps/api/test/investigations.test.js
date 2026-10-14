// Issue #212 (slice 2b): investigations and results review - ownership, explicit review, amendments, idempotency, authorization.
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
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `inv_${n}_${roles[0]}`, display_name: `Inv ${n}`, email: `inv${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); const u = { ...r.body.user, token: r.body.token };
  if (roles[0] !== 'athlete') must(await api('POST', '/me/sport-profiles', { token: u.token, body: { sport: 'football', role: roles[0] } }), 201);
  return u; };
const verify = async (u, type) => (await pool.query(
  "INSERT INTO verification_cases(type, subject_type, subject_id, requested_by, status, rules_version, decided_at, expires_at) VALUES ($1,'user',$2,$2,'approved',1,now(), now() + interval '300 days') RETURNING id", [type, u.id])).rows[0].id;
const doctorFor = async (ath) => { const d = await signup(['doctor']); const caseId = await verify(d, 'doctor'); must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: d.id } }), 201); return { ...d, caseId }; };
const setup = async () => { const ath = await signup(); return { ath, doc: await doctorFor(ath) }; };
const res1 = { values: [{ name: 'Ferritin', value: '12', unit: 'ng/mL', reference_interval: '30-400' }], document_ref: 'reports/abc.pdf' };

before(async () => { await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); await migrate(); server = createApp().listen(0); base = `http://localhost:${server.address().port}`; });
after(async () => { server.close(); await pool.end(); });

test('receiving a result is not a review; only the responsible doctor reviews, informs and closes, in order', async () => {
  const { ath, doc } = await setup();
  const inv = must(await api('POST', '/medical/investigations', { token: doc.token, body: { athlete_id: ath.id, test: 'Ferritin', indication: 'Fatigue', priority: 'priority' } }), 201);
  assert.equal(inv.status, 'requested');
  assert.ok(!(await pool.query('SELECT test_enc FROM clinical_investigations WHERE id=$1', [inv.id])).rows[0].test_enc.includes('Ferritin'), 'encrypted');
  assert.equal((await api('POST', `/medical/investigations/${inv.id}/review`, { token: doc.token, body: { result_id: ath.id } })).status, 409, 'nothing to review yet');
  const up = must(await api('POST', `/medical/investigations/${inv.id}/results`, { token: ath.token, body: res1 }), 201);
  assert.equal(up.investigation.status, 'received'); assert.equal(up.result.source, 'patient'); assert.equal(up.result.doctor_reviewed, false);
  let mine = must(await api('GET', '/medical/investigations', { token: ath.token }));
  assert.equal(mine[0].status, 'received'); assert.equal(mine[0].results[0].values[0].value, '12', 'values stored as supplied');
  assert.equal((await api('POST', `/medical/investigations/${inv.id}/outcome`, { token: doc.token, body: { action: 'patient_informed' } })).status, 409, 'cannot inform before reviewing');
  assert.equal((await api('POST', `/medical/investigations/${inv.id}/review`, { token: ath.token, body: { result_id: up.result.id } })).status, 403, 'the patient cannot review');
  must(await api('POST', `/medical/investigations/${inv.id}/review`, { token: doc.token, body: { result_id: up.result.id, note: 'Low; start iron plan' } }));
  must(await api('POST', `/medical/investigations/${inv.id}/outcome`, { token: doc.token, body: { action: 'patient_informed', note: 'Phoned' } }));
  must(await api('POST', `/medical/investigations/${inv.id}/outcome`, { token: doc.token, body: { action: 'closed' } }));
  mine = must(await api('GET', '/medical/investigations', { token: ath.token }));
  assert.equal(mine[0].results[0].doctor_reviewed, true);
  const hist = must(await api('GET', `/medical/investigations/${inv.id}/history`, { token: ath.token }));
  assert.deepEqual(hist.events.map((e) => e.action), ['requested', 'result_received', 'reviewed', 'patient_informed', 'closed']);
  assert.ok(hist.events.every((e) => e.note === undefined), 'athlete does not see clinician notes');
  assert.equal(must(await api('GET', `/medical/investigations/${inv.id}/history`, { token: doc.token })).events[2].note, 'Low; start iron plan');
  assert.equal((await api('POST', `/medical/investigations/${inv.id}/results`, { token: ath.token, body: { values: [{ name: 'x', value: '1' }] } })).status, 409, 'closed');
  await assert.rejects(pool.query("UPDATE clinical_investigation_events SET action='closed'"), /append-only/);
});

test('duplicate uploads are idempotent; an amended result reopens review and the old version cannot be reviewed', async () => {
  const { ath, doc } = await setup();
  const inv = must(await api('POST', '/medical/investigations', { token: doc.token, body: { athlete_id: ath.id, test: 'Ferritin' } }), 201);
  const a = must(await api('POST', `/medical/investigations/${inv.id}/results`, { token: ath.token, body: res1 }), 201);
  const again = must(await api('POST', `/medical/investigations/${inv.id}/results`, { token: ath.token, body: res1 }), 201);
  assert.equal(again.duplicate, true); assert.equal(again.result.id, a.result.id);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM clinical_results WHERE investigation_id=$1', [inv.id])).rows[0].n, 1);
  must(await api('POST', `/medical/investigations/${inv.id}/review`, { token: doc.token, body: { result_id: a.result.id } }));
  const b = must(await api('POST', `/medical/investigations/${inv.id}/results`, { token: doc.token, body: { values: [{ name: 'Ferritin', value: '21', unit: 'ng/mL' }], source: 'external', extraction: 'unverified_extraction' } }), 201);
  assert.equal(b.investigation.status, 'received'); assert.equal(b.result.version_no, 2); assert.match(b.result.note, /unverified/);
  assert.equal((await api('POST', `/medical/investigations/${inv.id}/review`, { token: doc.token, body: { result_id: a.result.id } })).status, 409, 'stale version');
  must(await api('POST', `/medical/investigations/${inv.id}/review`, { token: doc.token, body: { result_id: b.result.id } }));
  const hist = must(await api('GET', `/medical/investigations/${inv.id}/history`, { token: doc.token }));
  assert.deepEqual(hist.events.map((e) => e.action), ['requested', 'result_received', 'reviewed', 'reopened', 'reviewed']);
  assert.equal(must(await api('GET', '/medical/investigations', { token: ath.token }))[0].results.length, 2, 'earlier version kept');
  await assert.rejects(pool.query('DELETE FROM clinical_results'), /append-only/);
});

test('review queue: owned work only, urgent first; reassignment needs a verified, consented cover doctor', async () => {
  const { ath, doc } = await setup();
  const mk = (extra) => api('POST', '/medical/investigations', { token: doc.token, body: { athlete_id: ath.id, test: 'T', ...extra } }).then((r) => must(r, 201));
  await mk({ priority: 'routine' }); const u = await mk({ priority: 'urgent', review_due: '2020-01-01' });
  const q = must(await api('GET', '/medical/investigations?open_only=true', { token: doc.token }));
  assert.equal(q[0].id, u.id); assert.equal(q[0].overdue, true);
  const cover = await signup(['doctor']); await verify(cover, 'doctor');
  assert.equal((await api('POST', `/medical/investigations/${u.id}/reassign`, { token: doc.token, body: { to_doctor_id: cover.id, reason: 'Leave' } })).status, 403, 'no consent for the cover doctor');
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: cover.id } }), 201);
  must(await api('POST', `/medical/investigations/${u.id}/reassign`, { token: doc.token, body: { to_doctor_id: cover.id, reason: 'Leave' } }));
  assert.equal(must(await api('GET', '/medical/investigations', { token: cover.token }))[0].id, u.id);
  const up = must(await api('POST', `/medical/investigations/${u.id}/results`, { token: ath.token, body: res1 }), 201);
  assert.equal((await api('POST', `/medical/investigations/${u.id}/review`, { token: doc.token, body: { result_id: up.result.id } })).status, 403, 'previous owner no longer reviews');
  must(await api('POST', `/medical/investigations/${u.id}/review`, { token: cover.token, body: { result_id: up.result.id } }));
});

test('authorization: strangers, other athletes, physios and revoked consent/credential are refused', async () => {
  const { ath, doc } = await setup();
  const inv = must(await api('POST', '/medical/investigations', { token: doc.token, body: { athlete_id: ath.id, test: 'T' } }), 201);
  const other = await signup();
  assert.equal((await api('POST', `/medical/investigations/${inv.id}/results`, { token: other.token, body: res1 })).status, 404);
  assert.equal((await api('GET', `/medical/investigations/${inv.id}/history`, { token: other.token })).status, 404);
  const stranger = await signup(['doctor']); await verify(stranger, 'doctor');
  assert.equal((await api('GET', `/medical/investigations?athlete_id=${ath.id}`, { token: stranger.token })).status, 403);
  assert.equal((await api('POST', '/medical/investigations', { token: stranger.token, body: { athlete_id: ath.id, test: 'T' } })).status, 403);
  const physio = await signup(['physio']); await verify(physio, 'physio');
  assert.equal((await api('POST', '/medical/investigations', { token: physio.token, body: { athlete_id: ath.id, test: 'T' } })).status, 403);
  const up = must(await api('POST', `/medical/investigations/${inv.id}/results`, { token: ath.token, body: res1 }), 201);
  must(await api('DELETE', `/medical/grants/${doc.id}`, { token: ath.token }));
  assert.equal((await api('POST', `/medical/investigations/${inv.id}/review`, { token: doc.token, body: { result_id: up.result.id } })).status, 403);
  assert.equal(must(await api('GET', '/medical/investigations', { token: doc.token })).length, 0, 'queue hides patients who withdrew consent');
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: doc.id } }), 201);
  await pool.query("UPDATE verification_cases SET status='revoked' WHERE id=$1", [doc.caseId]);
  assert.equal((await api('POST', `/medical/investigations/${inv.id}/review`, { token: doc.token, body: { result_id: up.result.id } })).body.error.code, 'credential_required');
  assert.equal(must(await api('GET', '/medical/investigations', { token: ath.token }))[0].status, 'received', 'patient keeps access to their own results');
});

test('capabilities appear in OpenAPI with the clinical scope', async () => {
  const { buildOpenApi } = await import('../src/openapi.js');
  const ops = Object.values(buildOpenApi().paths).flatMap((p) => Object.values(p));
  for (const name of ['request_investigation', 'upload_investigation_result', 'review_investigation_result', 'update_investigation_outcome', 'reassign_investigation', 'list_investigations', 'get_investigation_history']) assert.equal(ops.find((o) => o.operationId === name)?.['x-required-scope'], 'clinical', name);
});
