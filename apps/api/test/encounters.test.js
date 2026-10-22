// Issue #212 (slice 1): structured, signed clinical encounters - authorization, concurrency, immutability, amendments, parity.
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
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `enc_${n}_${roles[0]}`, display_name: `Enc ${n}`, email: `enc${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); const u = { ...r.body.user, token: r.body.token };
  if (roles[0] !== 'athlete') must(await api('POST', '/me/sport-profiles', { token: u.token, body: { sport: 'football', role: roles[0] } }), 201);
  return u; };
const verify = async (u, type) => (await pool.query(
  "INSERT INTO verification_cases(type, subject_type, subject_id, requested_by, status, rules_version, decided_at, expires_at) VALUES ($1,'user',$2,$2,'approved',1,now(), now() + interval '300 days') RETURNING id", [type, u.id])).rows[0].id;
const setup = async () => {
  const ath = await signup(['athlete']), doc = await signup(['doctor']);
  const caseId = await verify(doc, 'doctor');
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: doc.id } }), 201);
  return { ath, doc, caseId };
};
const draft = (ath, extra = {}) => ({ athlete_id: ath.id, content: { history: 'Left knee pain after a tackle', assessment: 'Suspected meniscal irritation', observations: [{ type: 'heart_rate', value: 62, unit: 'bpm', measured_at: new Date().toISOString() }] }, visit_summary: { problem: 'Knee strain', plan: 'Rest and review in two weeks' }, ...extra });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('draft -> ready -> signed; athlete sees the summary only after signing and never the working notes', async () => {
  const { ath, doc } = await setup();
  const e = must(await api('POST', '/medical/encounters', { token: doc.token, body: draft(ath) }), 201);
  assert.equal(e.status, 'draft');
  let mine = must(await api('GET', '/medical/encounters', { token: ath.token }));
  assert.equal(mine.length, 0, 'unsigned encounters are not visible to the athlete');
  const ready = must(await api('PATCH', `/medical/encounters/${e.id}`, { token: doc.token, body: { version: e.version, status: 'ready' } }));
  const signed = must(await api('POST', `/medical/encounters/${e.id}/sign`, { token: doc.token, body: { version: ready.version } }));
  assert.equal(signed.status, 'signed');
  mine = must(await api('GET', '/medical/encounters', { token: ath.token }));
  assert.equal(mine.length, 1);
  assert.equal(mine[0].visit_summary.plan, 'Rest and review in two weeks');
  assert.equal(mine[0].content, undefined, 'working notes are clinician-only');
  const stored = (await pool.query('SELECT content_enc FROM clinical_encounters WHERE id=$1', [e.id])).rows[0].content_enc;
  assert.ok(!stored.includes('meniscal'), 'content is encrypted at rest');
  const ack = must(await api('POST', `/medical/encounters/${e.id}/acknowledge`, { token: ath.token }));
  assert.ok(ack.patient_ack_at);
  assert.equal(must(await api('POST', `/medical/encounters/${e.id}/acknowledge`, { token: ath.token })).patient_ack_at, ack.patient_ack_at, 'repeat keeps the first time');
});

test('signed encounters are immutable (API and database); stale versions are refused', async () => {
  const { ath, doc } = await setup();
  const e = must(await api('POST', '/medical/encounters', { token: doc.token, body: draft(ath) }), 201);
  const u1 = must(await api('PATCH', `/medical/encounters/${e.id}`, { token: doc.token, body: { version: e.version, content: { plan: 'Updated' } } }));
  assert.equal((await api('PATCH', `/medical/encounters/${e.id}`, { token: doc.token, body: { version: e.version, content: { plan: 'Stale' } } })).status, 409);
  assert.equal((await api('POST', `/medical/encounters/${e.id}/sign`, { token: doc.token, body: { version: e.version } })).status, 409, 'stale sign refused');
  must(await api('POST', `/medical/encounters/${e.id}/sign`, { token: doc.token, body: { version: u1.version } }));
  assert.equal((await api('PATCH', `/medical/encounters/${e.id}`, { token: doc.token, body: { version: u1.version + 1, content: { plan: 'Tamper' } } })).status, 409);
  await assert.rejects(pool.query("UPDATE clinical_encounters SET content_enc='x' WHERE id=$1", [e.id]), /immutable/);
  await assert.rejects(pool.query("UPDATE clinical_encounters SET status='draft' WHERE id=$1", [e.id]), /cannot return to draft/);
});

test('amendment keeps the original and links to it; void needs a reason and hides content from others', async () => {
  const { ath, doc } = await setup();
  const e = must(await api('POST', '/medical/encounters', { token: doc.token, body: draft(ath) }), 201);
  assert.equal((await api('POST', `/medical/encounters/${e.id}/amend`, { token: doc.token, body: { reason: 'typo', content: { plan: 'x' } } })).status, 409, 'only signed encounters are amended');
  const s = must(await api('POST', `/medical/encounters/${e.id}/sign`, { token: doc.token, body: { version: e.version } }));
  const a = must(await api('POST', `/medical/encounters/${e.id}/amend`, { token: doc.token, body: { reason: 'Corrected side', content: { assessment: 'Right knee, not left' } } }), 201);
  assert.equal(a.amends_id, e.id);
  must(await api('POST', `/medical/encounters/${a.id}/sign`, { token: doc.token, body: { version: a.version } }));
  const full = must(await api('GET', `/medical/encounters/${e.id}`, { token: doc.token }));
  assert.equal(full.content.assessment, 'Suspected meniscal irritation', 'original untouched');
  assert.equal(full.amendments.length, 1);
  assert.equal(full.amendments[0].content.amendment_reason, 'Corrected side');
  assert.equal((await api('POST', `/medical/encounters/${e.id}/void`, { token: doc.token, body: {} })).status, 400);
  const v = must(await api('POST', `/medical/encounters/${e.id}/void`, { token: doc.token, body: { reason: 'Wrong patient' } }));
  assert.equal(v.status, 'voided');
  assert.equal(must(await api('GET', '/medical/encounters', { token: ath.token })).find((x) => x.id === e.id).visit_summary, null);
  assert.equal((await api('POST', `/medical/encounters/${e.id}/sign`, { token: doc.token, body: { version: v.version } })).status, 409);
  assert.equal(s.status, 'signed');
});

test('authorization: consent, doctor role, author and credential are all required; other doctors see only signed notes', async () => {
  const { ath, doc } = await setup();
  const noGrant = await signup(['athlete']);
  assert.equal((await api('POST', '/medical/encounters', { token: doc.token, body: draft(noGrant) })).status, 403, 'no consent');
  const physio = await signup(['physio']);
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: physio.id } }), 201);
  assert.equal((await api('POST', '/medical/encounters', { token: physio.token, body: draft(ath) })).body.error.code, 'credential_required', 'a physio without a verified physio credential is refused');
  const lone = await signup(['athlete']);
  assert.equal((await api('POST', '/medical/encounters', { token: lone.token, body: draft(ath) })).status, 403, 'only clinicians write encounters');
  const unverified = await signup(['doctor']);
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: unverified.id } }), 201);
  assert.equal((await api('POST', '/medical/encounters', { token: unverified.token, body: draft(ath) })).body.error.code, 'credential_required');
  const e = must(await api('POST', '/medical/encounters', { token: doc.token, body: draft(ath) }), 201);
  const other = await signup(['doctor']); await verify(other, 'doctor');
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: other.id, history: 'all' } }), 201);
  assert.equal((await api('GET', `/medical/encounters/${e.id}`, { token: other.token })).status, 404, 'unsigned notes stay with the author');
  assert.equal((await api('PATCH', `/medical/encounters/${e.id}`, { token: other.token, body: { version: 1, status: 'ready' } })).status, 404);
  must(await api('POST', `/medical/encounters/${e.id}/sign`, { token: doc.token, body: { version: e.version } }));
  assert.equal(must(await api('GET', `/medical/encounters/${e.id}`, { token: other.token })).content.assessment, 'Suspected meniscal irritation');
  const stranger = await signup(['athlete']);
  assert.equal((await api('GET', `/medical/encounters?athlete_id=${ath.id}`, { token: stranger.token })).status, 403);
  assert.equal((await api('GET', `/medical/encounters/${e.id}`, { token: stranger.token })).status, 403);
});

test('revoked consent or credential blocks signing; revocation first leaves nothing signed', async () => {
  const { ath, doc, caseId } = await setup();
  const e = must(await api('POST', '/medical/encounters', { token: doc.token, body: draft(ath) }), 201);
  must(await api('DELETE', `/medical/grants/${doc.id}`, { token: ath.token }));
  assert.equal((await api('POST', `/medical/encounters/${e.id}/sign`, { token: doc.token, body: { version: e.version } })).status, 403);
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: doc.id } }), 201);
  await pool.query("UPDATE verification_cases SET status='revoked' WHERE id=$1", [caseId]);
  assert.equal((await api('POST', `/medical/encounters/${e.id}/sign`, { token: doc.token, body: { version: e.version } })).body.error.code, 'credential_required');
  assert.equal((await pool.query('SELECT status FROM clinical_encounters WHERE id=$1', [e.id])).rows[0].status, 'draft');
});

test('one live encounter per appointment, links must belong to the pair, copied-forward text needs review, empty notes cannot be signed', async () => {
  const { ath, doc } = await setup();
  const appt = (await pool.query("INSERT INTO appointments(athlete_id, provider_id, starts_at, duration_min, status) VALUES ($1,$2, now() + interval '1 day', 30, 'confirmed') RETURNING id", [ath.id, doc.id])).rows[0].id;
  const first = must(await api('POST', '/medical/encounters', { token: doc.token, body: draft(ath, { appointment_id: appt }) }), 201);
  assert.equal((await api('POST', '/medical/encounters', { token: doc.token, body: draft(ath, { appointment_id: appt }) })).status, 409, 'retry/duplicate is refused');
  const foreign = (await pool.query("INSERT INTO appointments(athlete_id, provider_id, starts_at, duration_min, status) VALUES ($1,$2, now() + interval '2 day', 30, 'confirmed') RETURNING id", [ath.id, (await signup(['doctor'])).id])).rows[0].id;
  assert.equal((await api('POST', '/medical/encounters', { token: doc.token, body: draft(ath, { appointment_id: foreign }) })).status, 404);
  must(await api('POST', `/medical/encounters/${first.id}/void`, { token: doc.token, body: { reason: 'Created in error' } }));
  const cf = must(await api('POST', '/medical/encounters', { token: doc.token, body: draft(ath, { appointment_id: appt, content: { plan: 'Same as last time', copied_forward: { fields: ['plan'] } } }) }), 201);
  assert.equal((await api('POST', `/medical/encounters/${cf.id}/sign`, { token: doc.token, body: { version: cf.version } })).status, 400);
  const empty = must(await api('POST', '/medical/encounters', { token: doc.token, body: { athlete_id: ath.id } }), 201);
  assert.equal((await api('POST', `/medical/encounters/${empty.id}/sign`, { token: doc.token, body: { version: empty.version } })).status, 400);
  assert.equal((await api('POST', '/medical/encounters', { token: doc.token, body: draft(ath, { content: { plan: 'x', observations: [{ type: 'bp', value: 120, unit: '', measured_at: new Date().toISOString() }] } }) })).status, 400, 'a value needs its unit');
});

test('capabilities appear in OpenAPI with the clinical scope', async () => {
  const { buildOpenApi } = await import('../src/openapi.js');
  const ops = Object.values(buildOpenApi().paths).flatMap((p) => Object.values(p));
  for (const name of ['create_encounter', 'update_encounter', 'sign_encounter', 'amend_encounter', 'void_encounter', 'list_encounters', 'get_encounter', 'acknowledge_visit_summary']) {
    assert.equal(ops.find((o) => o.operationId === name)?.['x-required-scope'], 'clinical', name);
  }
});

test('a verified physio writes and signs session notes with the same gates as a doctor', async () => {
  const ath = await signup(['athlete']), physio = await signup(['physio']);
  await verify(physio, 'physio');
  assert.equal((await api('POST', '/medical/encounters', { token: physio.token, body: draft(ath) })).status, 403, 'no consent yet');
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: physio.id } }), 201);
  const e = must(await api('POST', '/medical/encounters', { token: physio.token, body: draft(ath) }), 201);
  const signed = must(await api('POST', `/medical/encounters/${e.id}/sign`, { token: physio.token, body: { version: e.version } }));
  assert.equal(signed.status, 'signed');
  assert.equal(must(await api('GET', '/medical/encounters', { token: ath.token })).length, 1, 'the patient reads the visit summary');
});
