// Issue #212 (slice 2c): referrals - selected-data sharing, per-referral consent, recipient lifecycle, external honesty.
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
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `ref_${n}_${roles[0]}`, display_name: `Ref ${n}`, email: `ref${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); const u = { ...r.body.user, token: r.body.token };
  if (roles[0] !== 'athlete') must(await api('POST', '/me/sport-profiles', { token: u.token, body: { sport: 'football', role: roles[0] } }), 201);
  return u; };
const verify = async (u, type) => (await pool.query(
  "INSERT INTO verification_cases(type, subject_type, subject_id, requested_by, status, rules_version, decided_at, expires_at) VALUES ($1,'user',$2,$2,'approved',1,now(), now() + interval '300 days') RETURNING id", [type, u.id])).rows[0].id;
const setup = async () => {
  const ath = await signup(), doc = await signup(['doctor']), physio = await signup(['physio']);
  await verify(doc, 'doctor'); await verify(physio, 'physio');
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: doc.id } }), 201);
  return { ath, doc, physio };
};
const body = (ath, to, extra = {}) => ({ athlete_id: ath.id, to_provider_id: to.id, reason: 'Persistent knee instability', requested_action: 'Rehab assessment', shared: [{ label: 'Summary', text: 'ACL laxity suspected' }], ...extra });
const act = (u, id, action, extra = {}) => api('POST', `/medical/referrals/${id}/action`, { token: u.token, body: { action, ...extra } });

before(async () => { await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); await migrate(); server = createApp().listen(0); base = `http://localhost:${server.address().port}`; });
after(async () => { server.close(); await pool.end(); });

test('full platform flow: draft -> send -> athlete consent -> acknowledge -> accept -> book -> complete -> close', async () => {
  const { ath, doc, physio } = await setup();
  const ref = must(await api('POST', '/medical/referrals', { token: doc.token, body: body(ath, physio) }), 201);
  assert.equal(ref.status, 'draft');
  assert.equal(must(await api('GET', '/medical/referrals', { token: ath.token })).length, 0, 'drafts are invisible to the patient');
  must(await act(doc, ref.id, 'send'));
  assert.equal(must(await api('GET', '/medical/referrals?box=received', { token: physio.token })).length, 0, 'recipient sees nothing before consent');
  assert.equal((await act(physio, ref.id, 'acknowledge')).status, 409, 'cannot act before consent');
  const mine = must(await api('GET', '/medical/referrals', { token: ath.token }));
  assert.equal(mine[0].shared[0].text, 'ACL laxity suspected');
  must(await api('POST', `/medical/referrals/${ref.id}/consent`, { token: ath.token, body: { decision: 'grant' } }));
  const got = must(await api('GET', '/medical/referrals?box=received', { token: physio.token }));
  assert.equal(got[0].content_available, true); assert.deepEqual(got[0].shared, [{ label: 'Summary', text: 'ACL laxity suspected' }]);
  assert.equal((await act(doc, ref.id, 'accept')).status, 403, 'referrer cannot act as recipient');
  assert.equal((await act(physio, ref.id, 'accept')).status, 200);
  assert.equal((await act(physio, ref.id, 'book')).status, 400, 'booking needs the appointment');
  const appt = (await pool.query("INSERT INTO appointments(athlete_id, provider_id, starts_at, duration_min, status) VALUES ($1,$2, now() + interval '2 day', 30, 'confirmed') RETURNING id", [ath.id, physio.id])).rows[0].id;
  assert.equal(must(await act(physio, ref.id, 'book', { appointment_id: appt })).status, 'booked');
  must(await act(physio, ref.id, 'complete', { return_summary: 'Plan agreed; 6 week rehab' }));
  assert.equal(must(await api('GET', '/medical/referrals?box=sent', { token: doc.token }))[0].return_summary, 'Plan agreed; 6 week rehab');
  assert.equal(must(await act(doc, ref.id, 'close')).status, 'closed');
  const hist = must(await api('GET', `/medical/referrals/${ref.id}/history`, { token: ath.token }));
  assert.deepEqual(hist.events.map((e) => e.action), ['created', 'send', 'consent_granted', 'accept', 'book', 'complete', 'close']);
  assert.ok(!(await pool.query('SELECT shared_enc FROM clinical_referrals WHERE id=$1', [ref.id])).rows[0].shared_enc.includes('ACL'), 'encrypted');
});

test('athlete decline or later withdrawal removes recipient access immediately', async () => {
  const { ath, doc, physio } = await setup();
  const a = must(await api('POST', '/medical/referrals', { token: doc.token, body: body(ath, physio) }), 201);
  must(await act(doc, a.id, 'send'));
  must(await api('POST', `/medical/referrals/${a.id}/consent`, { token: ath.token, body: { decision: 'grant' } }));
  assert.equal(must(await api('GET', '/medical/referrals?box=received', { token: physio.token })).length, 1);
  must(await api('POST', `/medical/referrals/${a.id}/consent`, { token: ath.token, body: { decision: 'decline' } }));
  assert.equal(must(await api('GET', '/medical/referrals?box=received', { token: physio.token })).length, 0);
  assert.equal((await api('GET', `/medical/referrals/${a.id}/history`, { token: physio.token })).status, 404);
  assert.equal((await act(physio, a.id, 'accept')).status, 409);
  assert.equal(must(await api('GET', '/medical/referrals?box=sent', { token: doc.token }))[0].status, 'withdrawn');
});

test('expired referrals hide content; recipient can decline; only sender withdraws; athlete cannot self-serve doctor steps', async () => {
  const { ath, doc, physio } = await setup();
  const r = must(await api('POST', '/medical/referrals', { token: doc.token, body: body(ath, physio, { expires_at: new Date(Date.now() + 5000).toISOString() }) }), 201);
  must(await act(doc, r.id, 'send')); must(await api('POST', `/medical/referrals/${r.id}/consent`, { token: ath.token, body: { decision: 'grant' } }));
  await pool.query("UPDATE clinical_referrals SET expires_at = now() - interval '1 minute' WHERE id=$1", [r.id]);
  const got = must(await api('GET', '/medical/referrals?box=received', { token: physio.token }));
  assert.equal(got[0].content_available, false); assert.equal(got[0].shared, undefined);
  assert.equal((await act(physio, r.id, 'accept')).status, 409);
  const r2 = must(await api('POST', '/medical/referrals', { token: doc.token, body: body(ath, physio) }), 201);
  must(await act(doc, r2.id, 'send')); must(await api('POST', `/medical/referrals/${r2.id}/consent`, { token: ath.token, body: { decision: 'grant' } }));
  assert.equal((await act(physio, r2.id, 'withdraw')).status, 403);
  must(await act(physio, r2.id, 'decline'));
  assert.equal(must(await act(doc, r2.id, 'close')).status, 'closed');
  assert.equal((await act(ath, r2.id, 'accept')).status, 403, 'athletes use the consent endpoint, not doctor actions');
});

test('external referrals: letter only after consent, status never inferred, recipient-only actions refused', async () => {
  const { ath, doc } = await setup();
  const e = must(await api('POST', '/medical/referrals', { token: doc.token, body: { athlete_id: ath.id, external_recipient: 'City Orthopaedics', reason: 'Surgical opinion', shared: [{ label: 'MRI', text: 'Report summary' }] } }), 201);
  assert.equal(e.external.status_known, false); assert.equal(e.external.letter, null);
  must(await act(doc, e.id, 'send'));
  assert.equal(must(await api('GET', '/medical/referrals?box=sent', { token: doc.token }))[0].external.letter, null, 'no letter before consent');
  must(await api('POST', `/medical/referrals/${e.id}/consent`, { token: ath.token, body: { decision: 'grant' } }));
  assert.equal(must(await api('GET', '/medical/referrals?box=sent', { token: doc.token }))[0].external.letter.shared[0].label, 'MRI');
  assert.equal((await act(doc, e.id, 'accept')).status, 403);
  assert.equal(must(await act(doc, e.id, 'close')).status, 'closed');
  assert.equal((await api('POST', '/medical/referrals', { token: doc.token, body: { athlete_id: ath.id, external_recipient: 'X', to_provider_id: doc.id, reason: 'r', shared: [{ label: 'a', text: 'b' }] } })).status, 400, 'one recipient kind');
});

test('authorization: consent, credential and role are required; strangers see nothing', async () => {
  const { ath, doc, physio } = await setup();
  const noGrant = await signup(['doctor']); await verify(noGrant, 'doctor');
  assert.equal((await api('POST', '/medical/referrals', { token: noGrant.token, body: body(ath, physio) })).status, 403);
  assert.equal((await api('POST', '/medical/referrals', { token: physio.token, body: body(ath, doc) })).status, 403, 'doctors refer');
  const plain = await signup();
  assert.equal((await api('POST', '/medical/referrals', { token: doc.token, body: body(ath, plain) })).status, 400, 'recipient must be a doctor/physio');
  const r = must(await api('POST', '/medical/referrals', { token: doc.token, body: body(ath, physio) }), 201);
  assert.equal((await api('POST', `/medical/referrals/${r.id}/consent`, { token: ath.token, body: { decision: 'grant' } })).status, 404, 'a draft cannot be consented to');
  must(await act(doc, r.id, 'send'));
  const other = await signup();
  assert.equal((await api('POST', `/medical/referrals/${r.id}/consent`, { token: other.token, body: { decision: 'grant' } })).status, 404);
  assert.equal((await api('GET', `/medical/referrals/${r.id}/history`, { token: other.token })).status, 404);
  must(await api('DELETE', `/medical/grants/${doc.id}`, { token: ath.token }));
  const r2 = await api('POST', '/medical/referrals', { token: doc.token, body: body(ath, physio) });
  assert.equal(r2.status, 403);
  await assert.rejects(pool.query('DELETE FROM clinical_referral_events'), /append-only/);
});

test('capabilities appear in OpenAPI with the clinical scope', async () => {
  const { buildOpenApi } = await import('../src/openapi.js');
  const ops = Object.values(buildOpenApi().paths).flatMap((p) => Object.values(p));
  for (const name of ['create_referral', 'update_referral', 'respond_referral_consent', 'list_referrals', 'get_referral_history']) assert.equal(ops.find((o) => o.operationId === name)?.['x-required-scope'], 'clinical', name);
});
