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
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(40, 7)]).toString('base64');
const admin = async () => { const u = await signup(['athlete']); await pool.query("UPDATE users SET roles = roles || '{admin}' WHERE id=$1", [u.id]); return u; };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('physio onboarding: timeline, missing documents, owner/share-only access, audit', async () => {
  const phy = await signup(['physio']), insider = await signup(['insurer']), stranger = await signup(['athlete']), rev = await admin();
  const o = must(await api('GET', '/me/onboarding', { token: phy.token }));
  assert.equal(o.length, 1); assert.equal(o[0].type, 'physio'); assert.equal(o[0].status, 'not_started'); assert.equal(o[0].docs_total, 2);

  const sub = must(await api('POST', '/verification/cases', { token: phy.token, body: { type: 'physio', evidence: [{ kind: 'id_document', data: png, file_name: 'id.png' }, { kind: 'professional_licence', reference: 'PH-12345' }] } }), 201);
  const tl = must(await api('GET', `/verification/cases/${sub.id}/timeline`, { token: phy.token }));
  assert.equal(tl.stages.find((s) => s.state === 'current').key, 'queue');
  assert.equal(tl.next_step.actor, 'platform'); assert.deepEqual(tl.missing, []);
  assert.ok(tl.documents.every((d) => d.provided));
  assert.equal((await api('GET', `/verification/cases/${sub.id}/timeline`, { token: stranger.token })).status, 404);

  const evId = tl.documents.find((d) => d.kind === 'id_document').items[0].id;
  // owner reads own; stranger and an unshared user cannot
  assert.equal(must(await api('GET', `/verification/cases/${sub.id}/documents/${evId}`, { token: phy.token })).data, png);
  assert.equal((await api('GET', `/verification/cases/${sub.id}/documents/${evId}`, { token: stranger.token })).status, 404);
  // the raw bytes are not in the database in clear
  const raw = (await pool.query('SELECT file_enc, reference_enc FROM verification_evidence WHERE case_id=$1', [sub.id])).rows;
  assert.ok(raw.every((r) => !JSON.stringify(r).includes(png) && !JSON.stringify(r).includes('PH-12345')));

  // share one document with the insurer; reference doc stays private
  const sh = must(await api('POST', `/verification/cases/${sub.id}/shares`, { token: phy.token, body: { user_id: insider.id, evidence_ids: [evId], days: 7, purpose: 'Panel onboarding' } }), 201);
  assert.equal(must(await api('GET', `/verification/cases/${sub.id}/documents/${evId}`, { token: insider.token })).data, png);
  const licId = tl.documents.find((d) => d.kind === 'professional_licence').items[0].id;
  assert.equal((await api('GET', `/verification/cases/${sub.id}/documents/${licId}`, { token: insider.token })).status, 404);
  assert.equal(must(await api('GET', '/me/verification-shared', { token: insider.token })).length, 1);
  assert.equal((await api('POST', `/verification/shares/${sh.shares[0].id}/revoke`, { token: insider.token })).status, 404, 'only the owner can revoke');
  must(await api('POST', `/verification/shares/${sh.shares[0].id}/revoke`, { token: phy.token }));
  assert.equal((await api('GET', `/verification/cases/${sub.id}/documents/${evId}`, { token: insider.token })).status, 404);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='read_shared_verification_document'")).rowCount >= 1);

  // reviewer asks for more info -> next step is on the user
  must(await api('POST', `/admin/verification/cases/${sub.id}/claim`, { token: rev.token }));
  assert.equal(must(await api('GET', `/verification/cases/${sub.id}/timeline`, { token: phy.token })).stages.find((s) => s.state === 'current').key, 'review');
  must(await api('POST', `/admin/verification/cases/${sub.id}/decision`, { token: rev.token, body: { decision: 'needs_info', reason: 'Licence photo is blurry' } }));
  const t2 = must(await api('GET', `/verification/cases/${sub.id}/timeline`, { token: phy.token }));
  assert.equal(t2.next_step.actor, 'you'); assert.match(t2.next_step.detail, /blurry/);
});

test('insurer onboarding: approval marks the insurer profile verified, revocation clears it', async () => {
  const ins = await signup(['insurer']), rev = await admin();
  must(await api('POST', '/insurance/my-insurer', { token: ins.token, body: { name: `Shield ${n}` } }), 201);
  assert.equal(must(await api('GET', '/me/onboarding', { token: ins.token }))[0].type, 'insurer');
  const bad = await api('POST', '/verification/cases', { token: ins.token, body: { type: 'insurer', evidence: [{ kind: 'business_registration', reference: 'REG-1' }] } });
  assert.equal(bad.status, 400);
  const sub = must(await api('POST', '/verification/cases', { token: ins.token, body: { type: 'insurer', evidence: [{ kind: 'insurer_licence', reference: 'IRDAI-77' }, { kind: 'business_registration', reference: 'REG-1' }] } }), 201);
  must(await api('POST', `/admin/verification/cases/${sub.id}/claim`, { token: rev.token }));
  must(await api('POST', `/admin/verification/cases/${sub.id}/decision`, { token: rev.token, body: { decision: 'approve', checklist: [{ key: 'licence_valid', ok: true }, { key: 'name_matches', ok: true }, { key: 'requester_authorised', ok: true }] } }));
  assert.ok((await pool.query('SELECT verified_at FROM insurers WHERE owner_id=$1', [ins.id])).rows[0].verified_at);
  assert.equal(must(await api('GET', `/verification/cases/${sub.id}/timeline`, { token: ins.token })).stages.at(-1).state, 'done');
  must(await api('POST', `/admin/verification/cases/${sub.id}/revoke`, { token: rev.token, body: { reason: 'Licence lapsed' } }));
  assert.equal((await pool.query('SELECT verified_at FROM insurers WHERE owner_id=$1', [ins.id])).rows[0].verified_at, null);
});
