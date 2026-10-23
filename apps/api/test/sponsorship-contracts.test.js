import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp',
  MEDIA_DIR: mkdtempSync(join(tmpdir(), 'sa-contracts-')), SIGNATURE_WEBHOOK_SECRET: 'whsec_test_contracts',
});
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signCallback } = await import('../src/signatures/providers.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const type = r.headers.get('content-type') ?? '';
  return { status: r.status, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), type };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `sc_${n}_${roles[0]}`, display_name: `Contract ${n}`, email: `sc${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const world = async () => {
  const sponsor = await signup(['sponsor']), ath = await signup(['athlete']), outsider = await signup(['athlete']);
  const b = must(await api('POST', '/sponsors', { token: sponsor.token, body: { name: `Brand${n}` } }), 201);
  must(await api('POST', '/me/sponsorship-profile', { token: ath.token, body: { open_to_sponsors: true } }));
  return { sponsor, ath, outsider, b };
};
const money = { kind: 'money', label: 'Monthly support', currency: 'SGD', amount_cents: 50000, cadence: 'monthly', first_due_on: '2030-01-15', instalments: 6 };
const deal = async (w, extra = {}) => must(await api('POST', '/sponsorships', { token: w.sponsor.token, body: { sponsor_id: w.b.id, target_type: 'athlete', target_id: w.ath.id, deliverables: 'Wear the kit', starts_on: '2030-01-01', ends_on: '2030-06-30', lines: [money], ...extra } }), 201);
const sha = (b) => createHash('sha256').update(b).digest('hex');
/** A draft with both sides named and sent for signature. */
const sent = async (w, d, opts = {}) => {
  const c = must(await api('POST', `/sponsorships/${d.id}/contracts`, { token: w.sponsor.token, body: opts }), 201);
  const named = must(await api('PATCH', `/sponsorship-contracts/${c.id}/signatories`, { token: w.sponsor.token, body: { row_version: c.row_version, signatories: [{ user_id: w.sponsor.id, side: 'sponsor', capacity: 'Director' }, { user_id: w.ath.id, side: 'recipient' }] } }));
  return must(await api('POST', `/sponsorship-contracts/${c.id}/request-signatures`, { token: w.sponsor.token, body: { row_version: named.row_version } }));
};
const sign = (c, who, sha256 = c.snapshot_sha256) => api('POST', `/sponsorship-contracts/${c.id}/sign`, { token: who.token, body: { document_sha256: sha256, agree: true } });
const callback = (payload, secret = process.env.SIGNATURE_WEBHOOK_SECRET) => {
  const raw = JSON.stringify(payload);
  return fetch(`${base}/api/v1/webhooks/signatures/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': signCallback(secret, raw) }, body: raw }).then(async (r) => ({ status: r.status, body: await r.json() }));
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('draft versus signed: a draft is not binding, the signed PDF is sealed, and its hash and terms version never change', async () => {
  const w = await world();
  const d = await deal(w);
  const c0 = must(await api('POST', `/sponsorships/${d.id}/contracts`, { token: w.sponsor.token, body: {} }), 201);
  assert.equal(c0.status, 'draft');
  assert.equal(c0.signed_state, 'unsigned');
  assert.equal(c0.signed_url, null);
  assert.equal(c0.terms_version, 1);
  assert.equal(c0.current, true);
  const draftPdf = must(await api('GET', c0.draft_url.replace('/api/v1', ''), { token: w.ath.token }));
  assert.equal(draftPdf.subarray(0, 5).toString(), '%PDF-', 'the recipient can download the draft');

  // cannot be sent without a signatory on each side
  assert.equal((await api('POST', `/sponsorship-contracts/${c0.id}/request-signatures`, { token: w.sponsor.token, body: { row_version: c0.row_version } })).status, 400);
  const c = await sent(w, d);
  assert.equal(c.status, 'awaiting_signatures');
  assert.equal(c.signatories.length, 2);

  const first = must(await sign(c, w.sponsor));
  assert.equal(first.contract_status, 'awaiting_signatures');
  assert.equal(first.contract.signed_state, 'unsigned', 'one signature does not make a signed contract');
  const second = must(await sign(c, w.ath));
  assert.equal(second.contract_status, 'signed');
  const done = second.contract;
  assert.equal(done.signed_state, 'signed');
  assert.ok(done.signed_url && done.signed_sha256);
  assert.equal(done.accepted_terms_version, null, 'signing evidence never accepts the agreement by itself');

  const signedPdf = must(await api('GET', done.signed_url.replace('/api/v1', ''), { token: w.sponsor.token }));
  assert.equal(sha(signedPdf), done.signed_sha256, 'the stored hash is the hash of the signed bytes');
  assert.notEqual(done.signed_sha256, sha(draftPdf));
  const rows = (await pool.query('SELECT terms_version, document_sha256 FROM sponsorship_signatures WHERE contract_id=$1', [c.id])).rows;
  assert.equal(rows.length, 2);
  for (const r of rows) { assert.equal(r.terms_version, 1); assert.equal(r.document_sha256, c.snapshot_sha256); }

  // immutable: signatures, signed evidence, the text and a signed contract's status can never be rewritten or deleted
  await assert.rejects(pool.query("UPDATE sponsorship_signatures SET terms_version=9 WHERE contract_id=$1", [c.id]), /append-only/);
  await assert.rejects(pool.query('DELETE FROM sponsorship_signed_documents WHERE contract_id=$1', [c.id]), /append-only/);
  await assert.rejects(pool.query("UPDATE sponsorship_contracts SET snapshot='{}' WHERE id=$1", [c.id]), /cannot be edited/);
  await assert.rejects(pool.query("UPDATE sponsorship_contracts SET terms_version=2 WHERE id=$1", [c.id]), /cannot be edited/);
  await assert.rejects(pool.query("UPDATE sponsorship_contracts SET status='voided' WHERE id=$1", [c.id]), /cannot become/);
  await assert.rejects(pool.query('DELETE FROM sponsorship_contracts WHERE id=$1', [c.id]), /never deleted/);
  assert.equal((await api('POST', `/sponsorship-contracts/${c.id}/void`, { token: w.sponsor.token, body: { reason: 'oops' } })).status, 409, 'a signed contract cannot be voided');

  // existing acceptance is untouched and still exact-version
  must(await api('PATCH', `/sponsorships/${d.id}`, { token: w.ath.token, body: { status: 'active', version: 1 } }));
  const after = must(await api('GET', `/sponsorship-contracts/${c.id}`, { token: w.ath.token }));
  assert.equal(after.accepted_terms_version, 1);
  assert.equal(after.signed_sha256, done.signed_sha256);
  assert.equal(must(await api('GET', `/sponsorships/${d.id}/contracts`, { token: w.ath.token })).contracts.filter((x) => x.status !== 'voided').length, 1, 'the replaced draft is kept, voided');
});

test('unauthorized signers fail: outsiders, unnamed parties and people without authority to bind', async () => {
  const w = await world();
  const d = await deal(w);
  const c = must(await api('POST', `/sponsorships/${d.id}/contracts`, { token: w.sponsor.token, body: {} }), 201);
  const body = (list) => ({ row_version: c.row_version, signatories: list });
  assert.equal((await api('PATCH', `/sponsorship-contracts/${c.id}/signatories`, { token: w.sponsor.token, body: body([{ user_id: w.outsider.id, side: 'sponsor' }, { user_id: w.ath.id, side: 'recipient' }]) })).status, 403, 'a stranger cannot be named for the brand');
  assert.equal((await api('PATCH', `/sponsorship-contracts/${c.id}/signatories`, { token: w.sponsor.token, body: body([{ user_id: w.sponsor.id, side: 'recipient' }]) })).status, 403, 'nor on the wrong side');
  assert.equal((await api('PATCH', `/sponsorship-contracts/${c.id}/signatories`, { token: w.outsider.token, body: body([{ user_id: w.sponsor.id, side: 'sponsor' }]) })).status, 404, 'a non-party cannot manage it');
  const signers = must(await api('GET', `/sponsorships/${d.id}/contract-signers`, { token: w.sponsor.token }));
  assert.deepEqual(signers.sponsor.map((x) => x.user_id), [w.sponsor.id]);
  assert.deepEqual(signers.recipient.map((x) => x.user_id), [w.ath.id]);

  const live = await sent(w, d);
  assert.equal((await sign(live, w.outsider)).status, 404, 'an outsider cannot even see it');
  // a party who is not a named signatory (a second athlete-side user is impossible here, so take the sponsor off and try them)
  await pool.query("UPDATE sponsorship_signatories SET status='removed' WHERE contract_id=$1 AND user_id=$2", [live.id, w.sponsor.id]);
  assert.equal((await sign(live, w.sponsor)).status, 403, 'not a named signatory');
  await pool.query("UPDATE sponsorship_signatories SET status='pending' WHERE contract_id=$1 AND user_id=$2", [live.id, w.sponsor.id]);
  // authority is live: a signatory who lost the authority to bind the brand cannot sign
  await pool.query('UPDATE sponsors SET owner_id=$2 WHERE id=$1', [w.b.id, w.outsider.id]);
  assert.equal((await sign(live, w.sponsor)).status, 404, 'former owner no longer even sees the agreement');
  await pool.query('UPDATE sponsors SET owner_id=$2 WHERE id=$1', [w.b.id, w.sponsor.id]);
  assert.equal((await sign(live, w.sponsor, 'f'.repeat(64))).status, 409, 'wrong text fingerprint');
  assert.equal((await sign(live, w.sponsor)).status, 200);
});

test('tenant isolation: only the parties can read, list or download contracts', async () => {
  const w = await world();
  const d = await deal(w);
  const c = await sent(w, d);
  for (const p of [`/sponsorship-contracts/${c.id}`, c.draft_url.replace('/api/v1', '')]) assert.equal((await api('GET', p, { token: w.outsider.token })).status, 404);
  assert.equal((await api('GET', `/sponsorships/${d.id}/contracts`, { token: w.outsider.token })).status, 403);
  assert.equal((await api('GET', `/sponsorship-contracts/${c.id}`)).status, 401);
  assert.equal((await api('POST', `/sponsorships/${d.id}/contracts`, { token: w.outsider.token, body: {} })).status, 403);
  assert.equal((await api('POST', `/sponsorship-contracts/${c.id}/void`, { token: w.outsider.token, body: { reason: 'x' } })).status, 404);
  assert.equal((await api('GET', `/sponsorship-contracts/${c.id}`, { token: w.ath.token })).status, 200);
});

test('stale versions: a revised agreement cannot be signed or sent on an old contract', async () => {
  const w = await world();
  const d = await deal(w);
  const draft = must(await api('POST', `/sponsorships/${d.id}/contracts`, { token: w.sponsor.token, body: {} }), 201);
  must(await api('POST', `/sponsorships/${d.id}/revise`, { token: w.sponsor.token, body: { lines: [{ ...money, amount_cents: 60000 }], starts_on: '2030-01-01', ends_on: '2030-06-30' } }));
  const stale = must(await api('GET', `/sponsorship-contracts/${draft.id}`, { token: w.sponsor.token }));
  assert.equal(stale.stale, true);
  assert.equal(stale.current, false);
  const r = await api('POST', `/sponsorship-contracts/${draft.id}/request-signatures`, { token: w.sponsor.token, body: { row_version: draft.row_version } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.details.code, 'stale_version');
  assert.equal((await api('POST', `/sponsorships/${d.id}/contracts`, { token: w.sponsor.token, body: { version: 1 } })).status, 409, 'issuing from a stale screen is refused');
  const v2 = must(await api('POST', `/sponsorships/${d.id}/contracts`, { token: w.sponsor.token, body: { version: 2 } }), 201);
  assert.equal(v2.terms_version, 2);
  // an issued contract awaiting signature goes stale the moment its agreement is revised
  const w2 = await world();
  const d2 = await deal(w2);
  const live = await sent(w2, d2);
  must(await api('POST', `/sponsorships/${d2.id}/revise`, { token: w2.sponsor.token, body: { lines: [{ ...money, amount_cents: 70000 }], starts_on: '2030-01-01', ends_on: '2030-06-30' } }));
  const refused = await sign(live, w2.sponsor);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.details.code, 'stale_version');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sponsorship_signatures WHERE contract_id=$1', [live.id])).rows[0].n, 0);
});

test('template edits never alter an issued contract; the contract stays pinned to the version it was issued with', async () => {
  const w = await world();
  const d = await deal(w);
  const tpl = must(await api('POST', '/document-templates', { token: w.sponsor.token, body: { family: 'sponsorship_agreement', name: 'Contract' } }), 200);
  const withClause = (t) => ({ style: 'classic', paper: 'A4', orientation: 'portrait', margin_mm: 18, blocks: [{ type: 'header' }, { type: 'title' }, { type: 'parties' }, { type: 'lines' }, { type: 'text', text: t }, { type: 'footer' }] });
  const e1 = must(await api('PATCH', `/document-templates/${tpl.id}`, { token: w.sponsor.token, body: { row_version: tpl.row_version, layout: withClause('Clause A: payment within 30 days.') } }));
  must(await api('POST', `/document-templates/${tpl.id}/publish`, { token: w.sponsor.token, body: { row_version: e1.row_version } }), 200);
  const c = must(await api('POST', `/sponsorships/${d.id}/contracts`, { token: w.sponsor.token, body: { template_id: tpl.id } }), 201);
  assert.ok(c.template_version_id);
  const before = must(await api('GET', c.draft_url.replace('/api/v1', ''), { token: w.sponsor.token }));
  const t2 = must(await api('GET', '/document-templates', { token: w.sponsor.token, query: { family: 'sponsorship_agreement' } }))[0];
  const e2 = must(await api('PATCH', `/document-templates/${tpl.id}`, { token: w.sponsor.token, body: { row_version: t2.row_version, layout: withClause('Clause B: completely different.') } }));
  must(await api('POST', `/document-templates/${tpl.id}/publish`, { token: w.sponsor.token, body: { row_version: e2.row_version } }), 200);
  const again = must(await api('GET', c.draft_url.replace('/api/v1', ''), { token: w.sponsor.token }));
  assert.equal(sha(again), sha(before), 'the issued draft bytes are unchanged');
  const same = must(await api('GET', `/sponsorship-contracts/${c.id}`, { token: w.sponsor.token }));
  assert.equal(same.template_version_id, c.template_version_id);
  assert.equal(same.snapshot_sha256, c.snapshot_sha256);
  // also a changed agreement display name does not change the frozen text
  await pool.query("UPDATE sponsors SET name='Renamed Brand' WHERE id=$1", [w.b.id]);
  assert.equal((await pool.query('SELECT snapshot_sha256 FROM sponsorship_contracts WHERE id=$1', [c.id])).rows[0].snapshot_sha256, c.snapshot_sha256);
  // a retired template can no longer issue, but regenerating the draft replaces the unsent one with the new version
  const c2 = must(await api('POST', `/sponsorships/${d.id}/contracts`, { token: w.sponsor.token, body: { template_id: tpl.id } }), 201);
  assert.notEqual(c2.template_version_id, c.template_version_id);
  assert.equal(must(await api('GET', `/sponsorship-contracts/${c.id}`, { token: w.sponsor.token })).status, 'voided', 'the replaced draft is voided, never deleted');
  assert.equal((await api('POST', `/sponsorships/${d.id}/contracts`, { token: w.sponsor.token, body: { template_id: w.outsider.id } })).status, 400);
});

test('callbacks are authenticated and idempotent, including concurrent retries', async () => {
  const w = await world();
  const d = await deal(w);
  const c = await sent(w, d);
  const ev = (event_id, user_id = w.sponsor.id, extra = {}) => ({ event_id, contract_id: c.id, user_id, document_sha256: c.snapshot_sha256, provider_ref: `prov-${event_id}`, status: 'signed', ...extra });
  assert.equal((await callback(ev('e0'), 'wrong-secret')).status, 400, 'bad signature');
  assert.equal((await callback(ev('e1', w.outsider.id))).status, 403, 'an unnamed signer is refused even with a valid signature');
  assert.equal((await callback(ev('e2', w.sponsor.id, { document_sha256: 'a'.repeat(64) }))).status, 409, 'wrong text');
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => callback(ev(i < 3 ? 'same-event' : `retry-${i}`))));
  for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(results.filter((r) => !r.body.duplicate).length, 1, 'exactly one callback applied');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sponsorship_signatures WHERE contract_id=$1', [c.id])).rows[0].n, 1);
  const replay = await callback(ev('same-event'));
  assert.equal(replay.body.duplicate, true);
  // the in-app route is idempotent too
  const again = must(await sign(c, w.sponsor));
  assert.equal(again.duplicate, true);
  // the last signature through the callback seals the contract
  const last = await callback(ev('final', w.ath.id));
  assert.equal(last.body.contract_status, 'signed');
  const sealed = must(await api('GET', `/sponsorship-contracts/${c.id}`, { token: w.ath.token }));
  assert.equal(sealed.signed_state, 'signed');
  assert.deepEqual((await pool.query('SELECT provider FROM sponsorship_signatures WHERE contract_id=$1 ORDER BY provider', [c.id])).rows.map((r) => r.provider), ['webhook', 'webhook']);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM sponsorship_signed_documents WHERE contract_id=$1", [c.id])).rows[0].n, 1, 'sealed once');
});

test('existing agreements survive: no contract is invented, and issuing needs lines and an open agreement', async () => {
  const w = await world();
  const d = await deal(w);
  assert.equal(must(await api('GET', `/sponsorships/${d.id}/contracts`, { token: w.sponsor.token })).contracts.length, 0, 'empty state, nothing seeded');
  must(await api('PATCH', `/sponsorships/${d.id}`, { token: w.ath.token, body: { status: 'declined', version: 1 } }));
  assert.equal((await api('POST', `/sponsorships/${d.id}/contracts`, { token: w.sponsor.token, body: {} })).status, 409, 'a declined agreement takes no contract');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM sponsorship_obligations WHERE sponsorship_id=$1", [d.id])).rows[0].n, 0);
  const legacy = await pool.query("SELECT to_regclass('sponsorship_contracts') AS t");
  assert.ok(legacy.rows[0].t);
});

test('organisation recipient: only owners and admins bind it; a payee on the deal can read but not issue or sign', async () => {
  const owner = await signup(['coach']), sponsor = await signup(['sponsor']);
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Riverside ${++n}` } }), 201);
  must(await api('PATCH', `/organisations/${org.id}`, { token: owner.token, body: { open_to_sponsors: true } }));
  const join = async (role) => { const u = await signup(['coach']); must(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role } }), 201); must(await api('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } })); return u; };
  const admin = await join('admin'), fin = await join('finance');
  const brand = must(await api('POST', '/sponsors', { token: sponsor.token, body: { name: `Brand${n}` } }), 201);
  const d = must(await api('POST', '/sponsorships', { token: sponsor.token, body: { sponsor_id: brand.id, target_type: 'organisation', target_id: org.id, starts_on: '2030-01-01', ends_on: '2030-06-30', lines: [money] } }), 201);
  must(await api('PATCH', `/sponsorships/${d.id}`, { token: owner.token, body: { status: 'active', version: d.terms_version } }));
  must(await api('POST', `/sponsorships/${d.id}/allocations`, { token: owner.token, body: { rev: 1, allocations: [{ beneficiary_type: 'organisation', beneficiary_id: org.id, share_bp: 10000, payee_user_id: fin.id }] } }));
  assert.equal(must(await api('GET', `/sponsorships/${d.id}/allocations`, { token: fin.token })).my_role, 'payee');
  assert.equal((await api('POST', `/sponsorships/${d.id}/contracts`, { token: fin.token, body: {} })).status, 403, 'a payee cannot issue a contract for the organisation');
  const c = must(await api('POST', `/sponsorships/${d.id}/contracts`, { token: admin.token, body: {} }), 201);
  const named = (list) => api('PATCH', `/sponsorship-contracts/${c.id}/signatories`, { token: admin.token, body: { row_version: c.row_version, signatories: list } });
  assert.equal((await named([{ user_id: sponsor.id, side: 'sponsor' }, { user_id: fin.id, side: 'recipient' }])).status, 403, 'a payee cannot be named to sign for the organisation');
  const ok = must(await named([{ user_id: sponsor.id, side: 'sponsor' }, { user_id: admin.id, side: 'recipient' }, { user_id: owner.id, side: 'recipient' }]));
  const signers = must(await api('GET', `/sponsorships/${d.id}/contract-signers`, { token: admin.token }));
  assert.deepEqual(signers.recipient.map((x) => x.user_id).sort(), [admin.id, owner.id].sort());
  assert.equal(must(await api('GET', `/sponsorship-contracts/${c.id}`, { token: fin.token })).can.manage, false, 'the payee can read it');
  assert.equal(ok.signatories.length, 3);
});
