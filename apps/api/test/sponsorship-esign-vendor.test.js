import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp',
  MEDIA_DIR: mkdtempSync(join(tmpdir(), 'sa-esign-')),
});
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signDocusign } = await import('../src/signatures/providers.js');
const { checkLevel, ruleFor, POLICY } = await import('../src/signatures/policy.js');

const CONNECT_KEY = 'connect_key_test';
let server, base, vendor, vendorCalls, n = 0;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const type = r.headers.get('content-type') ?? '';
  return { status: r.status, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `ev_${n}_${roles[0]}`, display_name: `Vendor ${n}`, email: `ev${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const connect = (envelopeId, recipientId, event = 'recipient-completed') => {
  const raw = JSON.stringify({ event, data: { envelopeId, recipientId } });
  return fetch(`${base}/api/v1/webhooks/signatures/docusign`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-docusign-signature-1': signDocusign(CONNECT_KEY, raw) }, body: raw }).then(async (r) => ({ status: r.status, body: await r.json() }));
};
/** A draft with both sides named. */
const draft = async () => {
  const sponsor = await signup(['sponsor']), ath = await signup(['athlete']);
  const b = must(await api('POST', '/sponsors', { token: sponsor.token, body: { name: `Brand${n}` } }), 201);
  must(await api('POST', '/me/sponsorship-profile', { token: ath.token, body: { open_to_sponsors: true } }));
  const d = must(await api('POST', '/sponsorships', { token: sponsor.token, body: { sponsor_id: b.id, target_type: 'athlete', target_id: ath.id, deliverables: 'Wear the kit', starts_on: '2030-01-01', ends_on: '2030-06-30', lines: [{ kind: 'money', label: 'Support', currency: 'SGD', amount_cents: 50000, cadence: 'monthly', first_due_on: '2030-01-15', instalments: 6 }] } }), 201);
  const c = must(await api('POST', `/sponsorships/${d.id}/contracts`, { token: sponsor.token, body: {} }), 201);
  const named = must(await api('PATCH', `/sponsorship-contracts/${c.id}/signatories`, { token: sponsor.token, body: { row_version: c.row_version, signatories: [{ user_id: sponsor.id, side: 'sponsor' }, { user_id: ath.id, side: 'recipient' }] } }));
  return { sponsor, ath, c: named };
};
const send = (w, body = {}) => api('POST', `/sponsorship-contracts/${w.c.id}/request-signatures`, { token: w.sponsor.token, body: { row_version: w.c.row_version, ...body } });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  vendorCalls = [];
  vendor = createServer((req, res) => {
    let raw = ''; req.on('data', (d) => (raw += d)); req.on('end', () => {
      vendorCalls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: raw });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/oauth/token') return res.end(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
      if (req.method === 'POST' && req.url.endsWith('/envelopes')) return res.end(JSON.stringify({ envelopeId: `env-${vendorCalls.length}` }));
      res.end('{}');
    });
  }).listen(0);
  const vb = `http://localhost:${vendor.address().port}`;
  Object.assign(process.env, {
    DOCUSIGN_INTEGRATION_KEY: 'ik', DOCUSIGN_USER_ID: 'uid', DOCUSIGN_ACCOUNT_ID: 'acct', DOCUSIGN_CONNECT_KEY: CONNECT_KEY, DOCUSIGN_CALLBACK_URL: 'https://example.test/cb',
    DOCUSIGN_PRIVATE_KEY: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }), DOCUSIGN_BASE_URI: vb, DOCUSIGN_AUTH_URL: `${vb}/oauth/token`,
  });
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); vendor.close(); await pool.end(); });

test('policy: a provider below a country\'s minimum is refused, otherwise the recommendation is reported', () => {
  assert.equal(checkLevel('IN', 'simple').ok, true);
  assert.equal(checkLevel('IN', 'simple').meets_recommended, false);
  assert.equal(checkLevel('IN', 'advanced').meets_recommended, true);
  assert.equal(checkLevel('ZZ', 'simple').ok, true, 'an unrecorded country falls back to the default rule');
  const strict = { ...POLICY, XX: { law: 'Test law', note: 'qualified only', minimum: 'qualified', recommended: 'qualified' } };
  assert.equal(checkLevel('XX', 'advanced', strict).ok, false);
  assert.equal(ruleFor('in').law, POLICY.IN.law);
});

test('vendor flow: send creates one envelope, callbacks sign each person, replays are harmless and the contract seals', async () => {
  const w = await draft();
  const policy = must(await api('GET', '/signature-policy?country=IN', { token: w.sponsor.token }));
  assert.equal(policy.providers.find((p) => p.id === 'docusign').enabled, true);
  const s = must(await send(w, { provider: 'docusign', jurisdiction: 'IN' }));
  assert.equal(s.status, 'awaiting_signatures');
  assert.equal(s.signature_request.provider, 'docusign');
  assert.equal(s.signature_request.level, 'advanced');
  assert.equal(s.can.sign, false, 'in-app signing is closed while the vendor owns the signing');
  const env = vendorCalls.find((c) => c.url.endsWith('/envelopes'));
  assert.equal(env.auth, 'Bearer tok');
  const sent = JSON.parse(env.body);
  assert.equal(sent.recipients.signers.length, 2);
  assert.ok(sent.documents[0].documentBase64.startsWith('JVBER'), 'the draft PDF was sent');
  assert.deepEqual(sent.recipients.signers.map((x) => x.email).sort(), [`ev${n - 1}@example.com`, `ev${n}@example.com`].sort());

  assert.equal((await api('POST', `/sponsorship-contracts/${w.c.id}/sign`, { token: w.sponsor.token, body: { document_sha256: w.c.snapshot_sha256, agree: true } })).status, 409);
  const envelopeId = (await pool.query('SELECT external_ref FROM sponsorship_signature_requests WHERE contract_id=$1', [w.c.id])).rows[0].external_ref;

  assert.equal((await fetch(`${base}/api/v1/webhooks/signatures/docusign`, { method: 'POST', body: '{}', headers: { 'x-docusign-signature-1': 'bad' } })).status, 400, 'unsigned callbacks are refused');
  assert.equal((await connect(envelopeId, '9')).status, 400, 'an unknown recipient is refused');
  const a = await connect(envelopeId, '1');
  assert.equal(a.status, 200); assert.equal(a.body.contract_status, 'awaiting_signatures');
  assert.equal((await connect(envelopeId, '1')).body.duplicate, true, 'a replayed callback changes nothing');
  const b = await connect(envelopeId, '2');
  assert.equal(b.body.contract_status, 'signed');
  const done = must(await api('GET', `/sponsorship-contracts/${w.c.id}`, { token: w.ath.token }));
  assert.equal(done.status, 'signed');
  assert.equal(done.signature_request.status, 'completed');
  assert.deepEqual((await pool.query('SELECT DISTINCT provider FROM sponsorship_signatures WHERE contract_id=$1', [w.c.id])).rows, [{ provider: 'docusign' }]);
});

test('a withdrawn contract voids the envelope and a late callback signs nothing', async () => {
  const w = await draft();
  const s = must(await send(w, { provider: 'docusign' }));
  const envelopeId = (await pool.query('SELECT external_ref FROM sponsorship_signature_requests WHERE contract_id=$1', [w.c.id])).rows[0].external_ref;
  must(await api('POST', `/sponsorship-contracts/${w.c.id}/void`, { token: w.sponsor.token, body: { reason: 'Changed our mind' } }));
  assert.ok(vendorCalls.some((c) => c.method === 'PUT' && c.url.endsWith(`/envelopes/${envelopeId}`) && JSON.parse(c.body).status === 'voided'));
  const late = await connect(envelopeId, '1');
  assert.equal(late.body.ignored, 'voided');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sponsorship_signatures WHERE contract_id=$1', [w.c.id])).rows[0].n, 0);
});

test('a vendor that is not configured, or a vendor failure, leaves the contract a draft', async () => {
  const w = await draft();
  const keep = process.env.DOCUSIGN_ACCOUNT_ID;
  delete process.env.DOCUSIGN_ACCOUNT_ID;
  assert.equal((await send(w, { provider: 'docusign' })).status, 409);
  process.env.DOCUSIGN_ACCOUNT_ID = keep;
  const badBase = process.env.DOCUSIGN_BASE_URI;
  process.env.DOCUSIGN_BASE_URI = 'http://localhost:1';
  const r = await send(w, { provider: 'docusign' });
  process.env.DOCUSIGN_BASE_URI = badBase;
  assert.ok(r.status >= 500 || r.status === 502, JSON.stringify(r.body));
  assert.equal(must(await api('GET', `/sponsorship-contracts/${w.c.id}`, { token: w.sponsor.token })).status, 'draft');
  // the in-app path still works, and records a simple signature
  assert.equal(must(await send(w)).signature_request, null);
});
