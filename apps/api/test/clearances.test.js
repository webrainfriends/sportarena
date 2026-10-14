// Issue #212 (slice 3a): clearance decision lifecycle - supersession, expiry, withdrawal, minimum-necessary projection, legacy compatibility.
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
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `clr_${n}_${roles[0]}`, display_name: `Clr ${n}`, email: `clr${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); const u = { ...r.body.user, token: r.body.token };
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
const iso = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const cleared = (ath, extra = {}) => ({ athlete_id: ath.id, status: 'cleared', assessed_on: iso(0), valid_until: iso(90), ...extra });
const status = async (viewer, ath, q = '') => must(await api('GET', `/people/${ath.id}/clearance${q}`, { token: viewer.token }));

before(async () => { await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); await migrate(); server = createApp().listen(0); base = `http://localhost:${server.address().port}`; });
after(async () => { server.close(); await pool.end(); });

test('issue, supersede and withdraw; projection never leaks notes; validity is required', async () => {
  const { ath, doc } = await setup();
  assert.equal((await status(ath, ath)).status, 'unknown');
  assert.equal((await api('POST', '/medical/clearances', { token: doc.token, body: { athlete_id: ath.id, status: 'cleared', assessed_on: iso(0) } })).status, 400, 'needs valid_until');
  assert.equal((await api('POST', '/medical/clearances', { token: doc.token, body: { athlete_id: ath.id, status: 'restricted', assessed_on: iso(0), valid_until: iso(10) } })).status, 400, 'restricted needs restrictions');
  assert.equal((await api('POST', '/medical/clearances', { token: doc.token, body: cleared(ath, { assessed_on: iso(3) }) })).status, 400, 'no future assessment');
  const a = must(await api('POST', '/medical/clearances', { token: doc.token, body: cleared(ath, { internal_note: 'Mild ACL laxity' }) }), 201);
  assert.equal((await status(ath, ath)).status, 'cleared');
  const b = must(await api('POST', '/medical/clearances', { token: doc.token, body: { athlete_id: ath.id, status: 'restricted', assessed_on: iso(0), valid_until: iso(30), restrictions: [{ activity: 'Contact training', limit: 'No tackling for 4 weeks' }], internal_note: 'Post-op' } }), 201);
  assert.equal(b.supersedes_id, a.id);
  const s = await status(ath, ath);
  assert.equal(s.status, 'restricted'); assert.equal(s.restrictions[0].limit, 'No tackling for 4 weeks');
  assert.ok(!JSON.stringify(s).includes('Post-op') && !JSON.stringify(s).includes('ACL'), 'no private notes in the projection');
  const list = must(await api('GET', '/medical/clearances', { token: ath.token }));
  assert.deepEqual(list.map((x) => x.state), ['current', 'superseded']);
  assert.equal(list[0].internal_note, 'Post-op');
  assert.equal((await api('POST', `/medical/clearances/${a.id}/withdraw`, { token: doc.token, body: { reason: 'x' } })).status, 409, 'superseded');
  await assert.rejects(pool.query("UPDATE clinical_clearances SET status='cleared' WHERE id=$1", [b.id]), /immutable/);
  await assert.rejects(pool.query('DELETE FROM clinical_clearances'), /never deleted/);
  assert.equal((await api('POST', `/medical/clearances/${b.id}/withdraw`, { token: doc.token, body: {} })).status, 400);
  must(await api('POST', `/medical/clearances/${b.id}/withdraw`, { token: doc.token, body: { reason: 'New information' } }));
  assert.equal((await status(ath, ath)).status, 'unknown', 'withdrawn is not current');
  assert.equal(must(await api('GET', '/medical/clearances', { token: ath.token }))[0].withdrawn_reason, 'New information');
});

test('an expired clearance reads as expired, never as cleared', async () => {
  const { ath, doc } = await setup();
  const a = must(await api('POST', '/medical/clearances', { token: doc.token, body: cleared(ath, { review_by: iso(10) }) }), 201);
  assert.equal((await status(ath, ath)).review_due, false);
  // direct edits are blocked by the immutability trigger, so age the row the way time would: disable it for the test only
  await pool.query('ALTER TABLE clinical_clearances DISABLE TRIGGER clinical_clearances_guard');
  await pool.query("UPDATE clinical_clearances SET assessed_on = current_date - 100, valid_until = current_date - 1, review_by = current_date - 5 WHERE id=$1", [a.id]);
  await pool.query('ALTER TABLE clinical_clearances ENABLE TRIGGER clinical_clearances_guard');
  const s = await status(ath, ath);
  assert.equal(s.status, 'expired'); assert.equal(s.review_due, true);
  assert.equal(must(await api('GET', '/medical/clearances', { token: ath.token }))[0].state, 'expired');
});

test('per-sport decisions: worst current wins, sport filter, one live decision per sport', async () => {
  const { ath, doc } = await setup();
  const sports = (await pool.query('SELECT id FROM sports ORDER BY slug LIMIT 2')).rows;
  must(await api('POST', '/medical/clearances', { token: doc.token, body: cleared(ath, { sport_id: sports[0].id }) }), 201);
  must(await api('POST', '/medical/clearances', { token: doc.token, body: { athlete_id: ath.id, sport_id: sports[1].id, status: 'not_cleared', assessed_on: iso(0) } }), 201);
  assert.equal((await status(ath, ath)).status, 'not_cleared');
  assert.equal((await status(ath, ath, `?sport_id=${sports[0].id}`)).status, 'cleared');
  assert.equal((await status(ath, ath, `?sport_id=${sports[1].id}`)).status, 'not_cleared');
  must(await api('POST', '/medical/clearances', { token: doc.token, body: cleared(ath, { sport_id: sports[1].id }) }), 201);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM clinical_clearances WHERE athlete_id=$1 AND superseded_at IS NULL AND withdrawn_at IS NULL', [ath.id])).rows[0].n, 2);
  assert.equal((await status(ath, ath)).status, 'cleared');
});

test('legacy records stay in play: a newer legacy not_cleared beats an older decision, and vice versa', async () => {
  const { ath, doc } = await setup();
  must(await api('POST', '/medical/records', { token: doc.token, body: { athlete_id: ath.id, kind: 'clearance', clearance: 'cleared', summary: 'screening' } }), 201);
  assert.equal((await status(ath, ath)).status, 'cleared');
  must(await api('POST', '/medical/clearances', { token: doc.token, body: { athlete_id: ath.id, status: 'not_cleared', assessed_on: iso(0) } }), 201);
  assert.equal((await status(ath, ath)).status, 'not_cleared', 'newer decision wins over the old record');
  must(await api('POST', '/medical/records', { token: doc.token, body: { athlete_id: ath.id, kind: 'clearance', clearance: 'restricted', summary: 'follow up' } }), 201);
  assert.equal((await status(ath, ath)).status, 'restricted', 'newer legacy record wins over the old decision');
  assert.equal(must(await api('GET', '/dashboard', { token: ath.token })).fit_to_play, 'restricted');
});

test('authorization: doctor-only decisions with credential and consent; coaches see only the projection; revocation blocks', async () => {
  const { ath, doc, caseId } = await setup();
  const physio = await signup(['physio']); await verify(physio, 'physio');
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: physio.id } }), 201);
  assert.equal((await api('POST', '/medical/clearances', { token: physio.token, body: cleared(ath) })).status, 403, 'doctors decide');
  const stranger = await signup(['doctor']); await verify(stranger, 'doctor');
  assert.equal((await api('POST', '/medical/clearances', { token: stranger.token, body: cleared(ath) })).status, 403, 'no consent');
  assert.equal((await api('GET', `/medical/clearances?athlete_id=${ath.id}`, { token: stranger.token })).status, 403);
  const c = must(await api('POST', '/medical/clearances', { token: doc.token, body: { ...cleared(ath), restrictions: [{ activity: 'Sprints', limit: 'Max 80%' }], internal_note: 'private' } }), 201);
  const coach = await signup(['coach']);
  const team = must(await api('POST', '/teams', { token: coach.token, body: { name: 'Clr FC', sport: 'football' } }), 201);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [team.id, ath.id]);
  const proj = await api('GET', `/people/${ath.id}/clearance`, { token: coach.token });
  assert.equal(proj.status, 200, JSON.stringify(proj.body)); assert.equal(proj.body.status, 'cleared'); assert.equal(proj.body.restrictions[0].limit, 'Max 80%'); assert.ok(!JSON.stringify(proj.body).includes('private'));
  assert.equal((await api('GET', '/medical/clearances', { token: coach.token })).body.length, 0, 'a coach has no decisions of their own');
  const mineOther = must(await api('GET', `/medical/clearances?athlete_id=${ath.id}`, { token: doc.token }));
  assert.equal(mineOther[0].internal_note, 'private');
  must(await api('DELETE', `/medical/grants/${doc.id}`, { token: ath.token }));
  assert.equal((await api('POST', '/medical/clearances', { token: doc.token, body: cleared(ath) })).status, 403);
  await pool.query("UPDATE verification_cases SET status='revoked' WHERE id=$1", [caseId]);
  assert.equal((await api('POST', `/medical/clearances/${c.id}/withdraw`, { token: doc.token, body: { reason: 'x' } })).body.error.code, 'credential_required');
});

test('capabilities appear in OpenAPI with the clinical scope', async () => {
  const { buildOpenApi } = await import('../src/openapi.js');
  const ops = Object.values(buildOpenApi().paths).flatMap((p) => Object.values(p));
  for (const name of ['issue_clearance', 'withdraw_clearance', 'list_clearances']) assert.equal(ops.find((o) => o.operationId === name)?.['x-required-scope'], 'clinical', name);
});
