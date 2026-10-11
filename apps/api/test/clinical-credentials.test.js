import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { config } = await import('../src/config.js');

let server, base, n = 0;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const rpc = async (name, args, token) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  return (await r.json()).result;
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `cc_${n}_${roles[0]}`, display_name: `Clin ${n}`, email: `cc${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const pro = async (role = 'doctor', sport = 'football') => { const u = await signup([role]); must(await api('POST', '/me/sport-profiles', { token: u.token, body: { sport, role } }), 201); return u; };
const athleteIn = async (sport = 'football') => { const a = await signup(['athlete']); must(await api('POST', '/me/sport-profiles', { token: a.token, body: { sport, role: 'athlete' } }), 201); return a; };
const verify = async (u, type, { sport = null, jurisdiction = null, days = 300 } = {}) => (await pool.query(
  "INSERT INTO verification_cases(type, subject_type, subject_id, sport_id, jurisdiction, requested_by, status, rules_version, decided_at, expires_at) VALUES ($1,'user',$2,(SELECT id FROM sports WHERE slug=$3),$4,$2,'approved',1,now(), now() + make_interval(days => $5::int)) RETURNING id", [type, u.id, sport, jurisdiction, days])).rows[0].id;
const rec = (a, extra = {}) => ({ athlete_id: a.id, kind: 'checkup', summary: 'Routine knee checkup', ...extra });
const futureAt = (d) => { const x = new Date(Date.now() + d * 864e5); x.setUTCHours(10, 0, 0, 0); return x.toISOString(); };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('self-declared doctor with consent is blocked; verified without consent is blocked; verified with consent passes', async () => {
  const ath = await athleteIn(), doc = await pro('doctor');
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: doc.id } }), 201);
  const blocked = await api('POST', '/medical/records', { token: doc.token, body: rec(ath) });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'credential_required');
  assert.equal(blocked.body.error.details.reason, 'not_verified');
  assert.equal(blocked.body.error.details.renewal.capability, 'submit_verification');
  assert.match(blocked.body.error.message, /verified doctor/);
  assert.equal((await api('GET', `/medical/records?athlete_id=${ath.id}`, { token: doc.token })).status, 403, 'reading also needs the credential');

  const other = await athleteIn();
  await verify(doc, 'doctor');
  const noConsent = await api('POST', '/medical/records', { token: doc.token, body: rec(other) });
  assert.equal(noConsent.status, 403); assert.equal(noConsent.body.error.code, 'forbidden', 'a valid credential alone grants no access');

  const ok = must(await api('POST', '/medical/records', { token: doc.token, body: rec(ath) }), 201);
  assert.ok(ok.id);
  assert.equal(must(await api('GET', `/medical/records?athlete_id=${ath.id}`, { token: doc.token })).length, 1);

  // credential checks are audited by action and athlete only: no clinical text anywhere in the audit log
  const rows = (await pool.query("SELECT action, entity FROM audit_log WHERE actor_id=$1 AND action LIKE 'credential_check%'", [doc.id])).rows;
  assert.ok(rows.some((r) => r.action === 'credential_check_denied' && r.entity === 'clinical:add_medical_record:not_verified'));
  assert.ok(rows.some((r) => r.action === 'credential_check_allowed' && r.entity === 'clinical:add_medical_record'));
  assert.ok(!JSON.stringify((await pool.query('SELECT * FROM audit_log')).rows).includes('knee'));
});

test('expiry and revocation take effect immediately on the same session, and renewal restores access', async () => {
  const ath = await athleteIn(), doc = await pro('physio');
  const caseId = await verify(doc, 'physio');
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: doc.id } }), 201);
  must(await api('POST', '/medical/records', { token: doc.token, body: rec(ath) }), 201);
  assert.equal(must(await api('GET', '/medical/credential', { token: doc.token })).state, 'verified');

  await pool.query("UPDATE verification_cases SET expires_at = now() - interval '1 minute' WHERE id=$1", [caseId]);   // same token, no new login
  const exp = await api('POST', '/medical/records', { token: doc.token, body: rec(ath) });
  assert.equal(exp.status, 403); assert.equal(exp.body.error.details.reason, 'expired');
  assert.equal(exp.body.error.details.renewal.previous_case_id, caseId);
  const st = must(await api('GET', '/medical/credential', { token: doc.token }));
  assert.equal(st.state, 'expired'); assert.equal(st.can_act, false); assert.equal(st.renewal.capability, 'submit_verification');

  const caseId2 = await verify(doc, 'physio');                                   // renewed
  must(await api('POST', '/medical/records', { token: doc.token, body: rec(ath) }), 201);
  await pool.query("UPDATE verification_cases SET status='revoked', decision_reason='licence suspended' WHERE id=$1", [caseId2]);
  const rev = await api('POST', '/medical/records', { token: doc.token, body: rec(ath) });
  assert.equal(rev.status, 403); assert.equal(rev.body.error.details.reason, 'revoked');
  assert.equal(must(await api('GET', '/medical/credential', { token: doc.token })).state, 'revoked');
  // the athlete can still read everything already written
  assert.equal(must(await api('GET', '/medical/records', { token: ath.token })).length, 2);
});

test('follow-ups, appointment confirm/complete, booking, clearance re-check the credential; grace is explicit and narrow', async () => {
  const ath = await athleteIn(), doc = await pro('doctor');
  const caseId = await verify(doc, 'doctor');
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: doc.id } }), 201);
  const appt = must(await api('POST', '/appointments', { token: ath.token, body: { provider_id: doc.id, starts_at: futureAt(5) } }), 201);
  must(await api('PATCH', `/appointments/${appt.id}`, { token: doc.token, body: { status: 'confirmed' } }));
  must(await api('POST', '/medical/records', { token: doc.token, body: rec(ath, { kind: 'clearance', clearance: 'cleared' }) }), 201);
  assert.equal(must(await api('GET', `/people/${ath.id}/clearance`, { token: doc.token })).status, 'cleared');

  await pool.query("UPDATE verification_cases SET expires_at = now() - interval '2 days' WHERE id=$1", [caseId]);
  const fu = { appointment_id: appt.id, due_on: futureAt(20).slice(0, 10), instruction_summary: 'Rest and ice' };
  assert.equal((await api('POST', '/followups', { token: doc.token, body: fu })).body.error.code, 'credential_required');
  assert.equal((await api('PATCH', `/appointments/${appt.id}`, { token: doc.token, body: { status: 'completed' } })).body.error.code, 'credential_required', 'no grace by default');
  assert.equal((await api('GET', `/people/${ath.id}/clearance`, { token: doc.token })).status, 403, 'consent alone no longer opens fit-to-play');
  const book = await api('POST', '/appointments', { token: ath.token, body: { provider_id: doc.id, starts_at: futureAt(6) } });
  assert.equal(book.status, 403); assert.equal(book.body.error.code, 'credential_required');
  assert.equal(book.body.error.details.renewal, undefined, 'the athlete is not shown the provider\'s renewal steps');

  // explicit grace policy: completing existing care only, expired (not revoked) only
  config.clinical.graceDays = 7;
  try {
    assert.equal((await api('POST', '/medical/records', { token: doc.token, body: rec(ath) })).body.error.details.reason, 'expired', 'grace never covers new records');
    assert.equal(must(await api('GET', '/medical/credential', { token: doc.token })).state, 'grace');
    must(await api('PATCH', `/appointments/${appt.id}`, { token: doc.token, body: { status: 'completed' } }));
    assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='credential_check_grace'", [doc.id])).rowCount >= 1);
    await pool.query("UPDATE verification_cases SET status='revoked' WHERE id=$1", [caseId]);
    assert.equal(must(await api('GET', '/medical/credential', { token: doc.token })).state, 'revoked', 'grace never applies after revocation');
  } finally { config.clinical.graceDays = 0; }
});

test('cancelling an appointment is never blocked by a lapsed credential', async () => {
  const ath = await athleteIn(), doc = await pro('physio');
  const caseId = await verify(doc, 'physio');
  const appt = must(await api('POST', '/appointments', { token: ath.token, body: { provider_id: doc.id, starts_at: futureAt(8) } }), 201);
  await pool.query("UPDATE verification_cases SET status='revoked' WHERE id=$1", [caseId]);
  assert.equal(must(await api('PATCH', `/appointments/${appt.id}`, { token: doc.token, body: { status: 'cancelled' } })).status, 'cancelled');
});

test('granting access to an unverified provider is allowed but warns the athlete', async () => {
  const ath = await athleteIn(), unverified = await pro('doctor'), good = await pro('physio');
  await verify(good, 'physio');
  const w = must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: unverified.id } }), 201);
  assert.equal(w.provider_verified, false); assert.equal(w.credential_reason, 'not_verified'); assert.match(w.warning, /not current/);
  const g = must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: good.id } }), 201);
  assert.equal(g.provider_verified, true); assert.equal(g.warning, undefined);
});

test('profession must match; sport scope and jurisdiction are enforced', async () => {
  const ath = await athleteIn('football');
  const doc = await pro('doctor');
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: doc.id } }), 201);
  await verify(doc, 'physio');                                     // a physio credential on a doctor-only account
  assert.equal((await api('POST', '/medical/records', { token: doc.token, body: rec(ath) })).body.error.details.reason, 'role_mismatch');
  await pool.query("UPDATE verification_cases SET status='revoked' WHERE subject_id=$1", [doc.id]);
  await verify(doc, 'doctor', { sport: 'tennis' });
  assert.equal((await api('POST', '/medical/records', { token: doc.token, body: rec(ath) })).body.error.details.reason, 'sport_scope', 'tennis credential, football athlete');
  const tennisId = (await pool.query("SELECT id FROM sports WHERE slug='tennis'")).rows[0].id;
  must(await api('POST', '/medical/records', { token: doc.token, body: rec(ath, { sport_id: tennisId }) }), 201);
  const tennisPlayer = await athleteIn('tennis');
  must(await api('POST', '/medical/grants', { token: tennisPlayer.token, body: { provider_id: doc.id } }), 201);
  must(await api('POST', '/medical/records', { token: doc.token, body: rec(tennisPlayer) }), 201);

  config.clinical.jurisdictions = ['IN'];
  try {
    assert.equal((await api('POST', '/medical/records', { token: doc.token, body: rec(tennisPlayer) })).body.error.details.reason, 'jurisdiction');
    await verify(doc, 'doctor', { jurisdiction: 'in' });
    must(await api('POST', '/medical/records', { token: doc.token, body: rec(tennisPlayer) }), 201);
  } finally { config.clinical.jurisdictions = []; }
});

test('MCP gives the same decision and machine code as REST', async () => {
  const ath = await athleteIn(), doc = await pro('physio');
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: doc.id } }), 201);
  const res = await rpc('add_medical_record', rec(ath), doc.token);
  assert.equal(res.isError, true);
  assert.match(JSON.stringify(res), /credential_required/);
  await verify(doc, 'physio');
  const ok = await rpc('add_medical_record', rec(ath), doc.token);
  assert.ok(!ok.isError, JSON.stringify(ok));
  const st = await rpc('get_my_clinical_status', {}, doc.token);
  assert.ok(!st.isError); assert.equal(JSON.parse(st.content[0].text).state, 'verified');
  assert.equal((await api('GET', '/medical/credential', { token: ath.token })).status, 403, 'athletes have no provider status');
});
