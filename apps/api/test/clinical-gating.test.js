// Issue #59 (59-2a): atomic credential check on clinical writes, external-booking and follow-up gating, MCP/OpenAPI parity, migration survival.
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
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `cg_${n}_${roles[0]}`, display_name: `Gate ${n}`, email: `cg${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const pro = async (role = 'doctor', sport = 'football') => { const u = await signup([role]); must(await api('POST', '/me/sport-profiles', { token: u.token, body: { sport, role } }), 201); return u; };
const athleteIn = async (sport = 'football') => { const a = await signup(['athlete']); must(await api('POST', '/me/sport-profiles', { token: a.token, body: { sport, role: 'athlete' } }), 201); return a; };
const verify = async (u, type, { days = 300 } = {}) => (await pool.query(
  "INSERT INTO verification_cases(type, subject_type, subject_id, requested_by, status, rules_version, decided_at, expires_at) VALUES ($1,'user',$2,$2,'approved',1,now(), now() + make_interval(days => $3::int)) RETURNING id", [type, u.id, days])).rows[0].id;
const rec = (a, extra = {}) => ({ athlete_id: a.id, kind: 'checkup', summary: 'Routine knee checkup', ...extra });
const futureAt = (d) => { const x = new Date(Date.now() + d * 864e5); x.setUTCHours(10, 0, 0, 0); return x.toISOString(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const setup = async (role = 'doctor') => {
  const ath = await athleteIn(), doc = await pro(role);
  const caseId = await verify(doc, role);
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: doc.id } }), 201);
  return { ath, doc, caseId };
};
const credErr = (r) => { assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.error.code, 'credential_required'); return r.body.error.details; };

test('atomic: a revocation held open blocks the write until it commits, then nothing is written', async () => {
  const { ath, doc, caseId } = await setup();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("UPDATE verification_cases SET status='revoked' WHERE id=$1", [caseId]);   // revocation in flight, not yet committed
    const post = api('POST', '/medical/records', { token: doc.token, body: rec(ath) });      // passes the early check (still approved), then waits on the row lock
    await sleep(400);
    await c.query('COMMIT');
    assert.equal(credErr(await post).reason, 'revoked');
  } finally { c.release(); }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM medical_records WHERE athlete_id=$1', [ath.id])).rows[0].n, 0);
});

test('atomic: a write already holding the credential lock finishes before a revocation can commit', async () => {
  const { caseId } = await setup();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT 1 FROM verification_cases WHERE id=$1 FOR SHARE', [caseId]);       // what the write holds until it commits
    let revoked = false;
    const rev = pool.query("UPDATE verification_cases SET status='revoked' WHERE id=$1", [caseId]).then(() => { revoked = true; });
    await sleep(300);
    assert.equal(revoked, false, 'revocation waits for the in-flight write');
    await c.query('COMMIT');
    await rev;
    assert.equal(revoked, true);
  } finally { c.release(); }
});

test('concurrency: revoking while parallel POST /medical/records run - nothing is written once the revocation is committed', async () => {
  const { ath, doc, caseId } = await setup('physio');
  const posts = [];
  for (let k = 0; k < 24; k++) { posts.push(api('POST', '/medical/records', { token: doc.token, body: rec(ath, { summary: `parallel ${k}` }) })); if (k % 4 === 3) await sleep(15); }
  await pool.query("UPDATE verification_cases SET status='revoked', decision_reason='licence suspended' WHERE id=$1", [caseId]);   // resolves once committed
  const atRevoke = (await pool.query('SELECT count(*)::int AS n FROM medical_records WHERE athlete_id=$1', [ath.id])).rows[0].n;
  const late = [];
  for (let k = 0; k < 6; k++) late.push(api('POST', '/medical/records', { token: doc.token, body: rec(ath, { summary: `late ${k}` }) }));
  const lateRes = await Promise.all(late);
  const res = [...(await Promise.all(posts)), ...lateRes];
  for (const r of res) assert.ok(r.status === 201 || (r.status === 403 && r.body.error.code === 'credential_required'), JSON.stringify(r.body));
  for (const r of lateRes) assert.equal(r.status, 403, 'requests sent after the revocation are refused');
  const total = (await pool.query('SELECT count(*)::int AS n FROM medical_records WHERE athlete_id=$1', [ath.id])).rows[0].n;
  assert.equal(total, atRevoke, 'no record appeared after the revocation committed');
  assert.equal(total, res.filter((r) => r.status === 201).length, 'every 201 is exactly one stored record');
});

test('MCP: create_followup, update_appointment, link_external_booking give the same credential_required as REST', async () => {
  const { ath, doc, caseId } = await setup();
  const appt = must(await api('POST', '/appointments', { token: ath.token, body: { provider_id: doc.id, starts_at: futureAt(5) } }), 201);
  must(await api('PATCH', `/appointments/${appt.id}`, { token: doc.token, body: { status: 'confirmed' } }));
  must(await api('POST', '/me/provider-profile', { token: doc.token, body: { provider_type: 'doctor', external_booking: { provider: 'calendly', url: 'https://calendly.com/dr-x/30min' } } }));
  await pool.query("UPDATE verification_cases SET status='revoked' WHERE id=$1", [caseId]);
  const calls = [
    ['create_followup', { appointment_id: appt.id, due_on: futureAt(20).slice(0, 10), instruction_summary: 'Rest and ice' }, 'POST', '/followups', null],
    ['update_appointment', { id: appt.id, status: 'completed' }, 'PATCH', `/appointments/${appt.id}`, { status: 'completed' }],
    ['link_external_booking', { athlete_id: ath.id, external_reference: 'MCP-EXT-1', starts_at: futureAt(9) }, 'POST', '/appointments/external', null],
  ];
  for (const [name, args, method, path, restBody] of calls) {
    const viaRest = credErr(await api(method, path, { token: doc.token, body: restBody ?? args }));
    const mcp = await rpc(name, args, doc.token);
    assert.equal(mcp.isError, true, name);
    const txt = JSON.stringify(mcp);
    assert.match(txt, /credential_required/, name);
    assert.match(txt, new RegExp(viaRest.reason), name);
  }
});

test('external booking: a provider registering or confirming for a patient needs a current credential; cancel and athlete self-booking do not', async () => {
  const { ath, doc, caseId } = await setup('physio');
  must(await api('POST', '/me/provider-profile', { token: doc.token, body: { provider_type: 'physio', external_booking: { provider: 'calendly', url: 'https://calendly.com/dr-y/30min' } } }));
  const link = (ref, extra = {}) => api('POST', '/appointments/external', { token: doc.token, body: { athlete_id: ath.id, external_reference: ref, starts_at: futureAt(9), ...extra } });
  must(await link('EXT-OK-1', { status: 'confirmed' }), 201);
  must(await api('POST', '/appointments/external', { token: ath.token, body: { provider_id: doc.id, external_reference: 'EXT-OK-2', starts_at: futureAt(11) } }), 201);   // athlete side: no provider credential involved
  await pool.query("UPDATE verification_cases SET expires_at = now() - interval '1 day' WHERE id=$1", [caseId]);
  assert.equal(credErr(await link('EXT-NEW-1')).reason, 'expired');
  const recon = (ref, status) => api('POST', '/appointments/external/reconcile', { token: doc.token, body: { external_reference: ref, status } });
  assert.equal(credErr(await recon('EXT-OK-1', 'completed')).reason, 'expired', 'completed is a clinical step');
  assert.equal(credErr(await recon('EXT-OK-2', 'confirmed')).reason, 'expired');
  assert.equal((await pool.query("SELECT status FROM appointments WHERE external_reference='EXT-OK-1'")).rows[0].status, 'confirmed', 'nothing moved');
  config.clinical.graceDays = 7;
  try {
    await pool.query("UPDATE appointments SET starts_at = now() - interval '2 hours' WHERE external_reference='EXT-OK-1'");
    assert.equal(must(await recon('EXT-OK-1', 'completed')).status, 'completed', 'grace covers completing existing care');
    assert.equal(credErr(await recon('EXT-OK-2', 'confirmed')).reason, 'expired', 'grace does not cover a new confirmation');
  } finally { config.clinical.graceDays = 0; }
  await pool.query("UPDATE verification_cases SET status='revoked' WHERE id=$1", [caseId]);
  assert.equal(must(await recon('EXT-OK-2', 'cancelled')).status, 'cancelled', 'cancelling is never blocked');
});

test('update_followup: provider done / reschedule need the credential (done may use grace); cancel never; the athlete is unaffected', async () => {
  const { ath, doc, caseId } = await setup();
  const appt = must(await api('POST', '/appointments', { token: ath.token, body: { provider_id: doc.id, starts_at: futureAt(5) } }), 201);
  must(await api('PATCH', `/appointments/${appt.id}`, { token: doc.token, body: { status: 'confirmed' } }));
  const mk = async (d) => must(await api('POST', '/followups', { token: doc.token, body: { appointment_id: appt.id, due_on: futureAt(d).slice(0, 10), instruction_summary: `Check ${d}` } }), 201);
  const [f1, f2, f3, f4] = [await mk(20), await mk(21), await mk(22), await mk(23)];
  await pool.query("UPDATE verification_cases SET expires_at = now() - interval '1 day' WHERE id=$1", [caseId]);
  assert.equal(credErr(await api('PATCH', `/followups/${f1.id}`, { token: doc.token, body: { status: 'done' } })).reason, 'expired');
  assert.equal(credErr(await api('PATCH', `/followups/${f1.id}`, { token: doc.token, body: { due_on: futureAt(30).slice(0, 10) } })).reason, 'expired');
  config.clinical.graceDays = 7;
  try { must(await api('PATCH', `/followups/${f1.id}`, { token: doc.token, body: { status: 'done' } })); } finally { config.clinical.graceDays = 0; }
  must(await api('PATCH', `/followups/${f2.id}`, { token: doc.token, body: { status: 'cancelled' } }));
  must(await api('PATCH', `/followups/${f3.id}`, { token: ath.token, body: { status: 'done' } }));
  must(await api('PATCH', `/followups/${f4.id}`, { token: ath.token, body: { due_on: futureAt(40).slice(0, 10) } }));
});

test('OpenAPI lists GET /medical/credential and the credential_required 403 on clinical operations', async () => {
  const doc = await (await fetch(`${base}/api/v1/openapi.json`)).json();
  assert.equal(doc.paths['/medical/credential'].get.operationId, 'get_my_clinical_status');
  const err = doc.components.responses.CredentialRequired.content['application/json'].schema.properties.error.properties;
  assert.ok(err.code.enum.includes('credential_required'));
  assert.ok(err.details.properties.reason.enum.includes('revoked'));
  for (const [p, m] of [['/medical/records', 'post'], ['/medical/records', 'get'], ['/followups', 'post'], ['/followups/{id}', 'patch'], ['/appointments/{id}', 'patch'], ['/appointments/external', 'post'], ['/appointments/external/reconcile', 'post']]) {
    assert.equal(doc.paths[p][m].responses[403].$ref, '#/components/responses/CredentialRequired', `${m} ${p}`);
  }
  assert.equal(doc.paths['/medical/credential'].get.responses[403].$ref, '#/components/responses/Error', 'other operations keep the plain error');
});

test('migrations 049/050 on data written before them: grants become history_scope=all and records stay readable', async () => {
  const ath = await athleteIn(), doc = await pro('doctor');
  await verify(doc, 'doctor');
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: doc.id } }), 201);
  must(await api('POST', '/medical/records', { token: doc.token, body: rec(ath, { summary: 'written before the migration' }) }), 201);
  // put the schema back into its pre-049 shape (throwaway test database only), keeping every row
  await pool.query(`ALTER TABLE medical_grants DROP COLUMN history_scope;
    ALTER TABLE verification_cases DROP COLUMN jurisdiction;
    ALTER TABLE event_medical_incidents DROP COLUMN credential_override, DROP COLUMN credential_override_enc;
    DELETE FROM schema_migrations WHERE name IN ('049_clinical_credentials.sql','050_medical_history_scope.sql')`);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM medical_grants WHERE athlete_id=$1', [ath.id])).rows[0].n, 1);
  await migrate();
  const g = (await pool.query('SELECT history_scope FROM medical_grants WHERE athlete_id=$1 AND provider_id=$2', [ath.id, doc.id])).rows[0];
  assert.equal(g.history_scope, 'all', 'a grant that existed before 050 keeps showing the full history');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM medical_records WHERE athlete_id=$1', [ath.id])).rows[0].n, 1, 'records survive');
  assert.equal(must(await api('GET', '/medical/records', { token: ath.token }))[0].summary, 'written before the migration');
  assert.equal(must(await api('GET', `/medical/records?athlete_id=${ath.id}`, { token: doc.token }))[0].summary, 'written before the migration');
  const ath2 = await athleteIn();
  must(await api('POST', '/medical/grants', { token: ath2.token, body: { provider_id: doc.id } }), 201);
  assert.equal((await pool.query('SELECT history_scope FROM medical_grants WHERE athlete_id=$1 AND provider_id=$2', [ath2.id, doc.id])).rows[0].history_scope, 'since_grant', 'new grants default to the narrow scope');
});
