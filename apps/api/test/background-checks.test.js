// Federation extras (#703) 2/3: the background-check vendor adapter, tested against a stub provider and a stubbed HTTPS transport.
// Consent first; only clear / not clear / pending and the provider's reference are kept (never a report); a vendor "clear" still needs a reviewer;
// every read is audited; self-declaration stays refused; webhooks are signed and replay-safe; the poll sweep catches up.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { stubControl, signBody, mapState, pollBackgroundChecks } = await import('../src/background-checks.js');
const { transport } = await import('../src/identity/safe-http.js');
const { runComplianceSweeps } = await import('../src/compliance-sweeps.js');
const { capabilities } = await import('../src/registry.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query, raw, headers } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(headers ?? {}) }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const text = await r.text(); let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: r.status, body: parsed };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const code = (r) => r.body.error?.details?.code ?? r.body.error?.code;
const q = async (sql, args = []) => (await pool.query(sql, args)).rows;
const person = async (roles = []) => { n++; const r = await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ($1,$2,$3,'x','x',$1) RETURNING id", [`bgc_${n}`, `Person ${n}`, roles]); return { id: r.rows[0].id, token: await signToken({ id: r.rows[0].id, roles }) }; };
const join = (org, u, role) => pool.query("INSERT INTO organisation_members(organisation_id, user_id, role, status, joined_at) VALUES ($1,$2,$3,'active',now())", [org, u.id, role]);
const SECRET = 'whsec_test_secret';

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0); base = `http://localhost:${server.address().port}`;
});
after(async () => { stubControl.clear(); server.close(); await pool.end(); });

async function setup() {
  const owner = await person(), coach = await person(), reviewer = await person();
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Check Club ${++n}`, kind: 'club' } }), 201);
  await join(org.id, coach, 'coach'); await join(org.id, reviewer, 'admin');
  const req = must(await api('POST', '/compliance/requirements', { token: owner.token, body: { scope_kind: 'organisation', scope_id: org.id, name: 'Background check', category: 'background_check', method: 'evidence', validity_days: 1095 } }), 201);
  must(await api('POST', `/compliance/requirements/${req.id}/obligations`, { token: owner.token, body: { roles: ['coach'] } }), 201);
  const linked = must(await api('POST', '/compliance/background-providers', { token: owner.token, body: { provider: 'stub', organisation_id: org.id, config: { webhook_secret: SECRET } } }), 201);
  return { owner, coach, reviewer, org, req, linked };
}
const webhook = (credId, payload, { secret = SECRET, headers } = {}) => {
  const raw = JSON.stringify(payload);
  return api('POST', `/webhooks/background-checks/${credId}`, { raw, headers: { 'x-signature': signBody(secret, raw), ...(headers ?? {}) } });
};

test('consent first: no consent, no check; withdrawing it blocks new orders; a young person\'s guardian consents', async () => {
  const { coach, req } = await setup();
  const opts = must(await api('GET', '/compliance/background-checks/options', { token: coach.token, query: { requirement_id: req.id } }));
  assert.deepEqual(opts.providers.map((p) => p.provider), ['stub']); assert.equal(opts.consent, null); assert.equal(opts.record_id, null);
  assert.equal((await api('GET', '/compliance/background-checks/options', { token: (await person()).token, query: { requirement_id: req.id, subject_id: coach.id } })).status, 404);
  const none = await api('POST', '/compliance/background-checks', { token: coach.token, body: { requirement_id: req.id } });
  assert.equal(none.status, 409); assert.equal(code(none), 'consent_required');
  assert.equal((await api('POST', '/compliance/background-checks/consent', { token: coach.token, body: { requirement_id: req.id } })).status, 400, 'confirm must be true');
  const c1 = must(await api('POST', '/compliance/background-checks/consent', { token: coach.token, body: { requirement_id: req.id, confirm: true } }), 201);
  assert.equal(c1.given_by, 'self');
  must(await api('POST', '/compliance/background-checks/consent/withdraw', { token: coach.token, body: { requirement_id: req.id } }));
  assert.equal(code(await api('POST', '/compliance/background-checks', { token: coach.token, body: { requirement_id: req.id, provider: 'stub' } })), 'consent_required');
  // a young person cannot consent alone; their guardian can (scope `consent`)
  const kid = await person(), guardian = await person();
  await q('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);
  await q("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [guardian.id, kid.id]);
  assert.equal((await api('POST', '/compliance/background-checks/consent', { token: kid.token, body: { requirement_id: req.id, confirm: true } })).status, 403);
  assert.equal(must(await api('POST', '/compliance/background-checks/consent', { token: guardian.token, body: { requirement_id: req.id, subject_id: kid.id, confirm: true } }), 201).given_by, 'guardian');
  await q("UPDATE guardian_links SET scopes='{pay}' WHERE guardian_id=$1", [guardian.id]);
  const noScope = await api('POST', '/compliance/background-checks/consent', { token: guardian.token, body: { requirement_id: req.id, subject_id: kid.id, confirm: true } });
  assert.equal(noScope.status, 403); assert.equal(code(noScope), 'guardian_scope_required');
  assert.equal((await api('POST', '/compliance/background-checks/consent', { token: (await person()).token, body: { requirement_id: req.id, subject_id: kid.id, confirm: true } })).status, 404);
});

test('the full path: order, pending, vendor clear, reviewer confirms; no raw report is stored; reads are audited', async () => {
  const { owner, coach, reviewer, req, linked } = await setup();
  must(await api('POST', '/compliance/background-checks/consent', { token: coach.token, body: { requirement_id: req.id, confirm: true } }), 201);
  assert.equal((await api('POST', '/compliance/background-checks', { token: coach.token, body: { requirement_id: req.id, provider: 'nope' } })).status, 409, 'unknown provider');
  const ordered = must(await api('POST', '/compliance/background-checks', { token: coach.token, body: { requirement_id: req.id } }), 201);
  assert.equal(ordered.state, 'pending'); assert.equal(ordered.provider, 'stub', 'the linked provider is used when none is named');
  assert.equal(must(await api('GET', '/compliance/background-checks/options', { token: coach.token, query: { requirement_id: req.id } })).record_id, ordered.record_id);
  assert.equal(code(await api('POST', '/compliance/background-checks', { token: coach.token, body: { requirement_id: req.id, provider: 'stub' } })), 'already_submitted');
  const v = (await q('SELECT * FROM comp_check_vendor WHERE record_id=$1', [ordered.record_id]))[0];
  assert.equal(v.state, 'pending'); assert.ok(v.consent_id);
  // nothing readable is stored: the reference is encrypted, and no column holds a report
  assert.ok(!/stub_/.test(JSON.stringify(v)), 'the provider reference is encrypted');
  const cols = (await q("SELECT column_name FROM information_schema.columns WHERE table_name='comp_check_vendor'")).map((r) => r.column_name);
  assert.ok(!cols.some((c) => /report|result_json|payload|raw/.test(c)), cols.join());
  const ref = (await q("SELECT 1 FROM comp_records WHERE id=$1 AND reference_enc NOT LIKE '%stub_%'", [ordered.record_id])).length;
  assert.equal(ref, 1);
  // the reviewer cannot approve while the provider has not said clear
  const early = await api('POST', `/compliance/records/${ordered.record_id}/decision`, { token: reviewer.token, body: { decision: 'approve' } });
  assert.equal(early.status, 409); assert.equal(code(early), 'vendor_not_clear');
  // a webhook with a bad signature is refused; a forged secret too
  assert.equal((await webhook(linked.id, { event_id: 'e0', ref: 'x', result: 'clear' }, { secret: 'wrong' })).status, 401);
  assert.equal((await api('POST', `/webhooks/background-checks/${linked.id}`, { raw: '{}' })).status, 401);
  // the provider reports clear
  const ref0 = (await import('../src/crypto.js')).decrypt(v.provider_ref_enc, 'comp_check_vendor.provider_ref');
  const hit = must(await webhook(linked.id, { event_id: 'evt-1', ref: ref0, result: 'clear', report: { name: 'SECRET DETAIL', convictions: ['x'] } }));
  assert.equal(hit.applied, 1);
  assert.equal(must(await webhook(linked.id, { event_id: 'evt-1', ref: ref0, result: 'clear' })).replays, 1, 'a replay is ignored');
  assert.ok(!JSON.stringify(await q('SELECT * FROM comp_events WHERE record_id=$1', [ordered.record_id])).includes('SECRET DETAIL'), 'the body is never stored');
  assert.ok(!JSON.stringify(await q('SELECT * FROM comp_vendor_events')).includes('SECRET DETAIL'));
  // still pending for the record until a reviewer confirms
  const mid = must(await api('GET', `/compliance/records/${ordered.record_id}/background-check`, { token: reviewer.token }));
  assert.equal(mid.state, 'clear'); assert.equal(mid.outcome, 'pending'); assert.equal(mid.awaiting_review, true); assert.equal(mid.confirmed, false);
  assert.equal((await api('POST', `/compliance/records/${ordered.record_id}/decision`, { token: coach.token, body: { decision: 'approve' } })).status, 404, 'not their own');
  const done = must(await api('POST', `/compliance/records/${ordered.record_id}/decision`, { token: reviewer.token, body: { decision: 'approve' } }));
  assert.equal(done.status, 'valid'); assert.equal(done.outcome, 'clear');
  const after = must(await api('GET', `/compliance/records/${ordered.record_id}/background-check`, { token: coach.token }));
  assert.equal(after.confirmed, true);
  assert.equal((await q('SELECT confirmed_by FROM comp_check_vendor WHERE record_id=$1', [ordered.record_id]))[0].confirmed_by, reviewer.id, 'the reviewer who confirmed is kept');
  // a late provider flip after confirmation never rewrites the decision
  await webhook(linked.id, { event_id: 'evt-2', ref: ref0, result: 'not_clear' });
  assert.equal((await q('SELECT state FROM comp_check_vendor WHERE record_id=$1', [ordered.record_id]))[0].state, 'clear');
  // every read is audited and put in the record history
  const reads = (await q("SELECT count(*)::int AS n FROM audit_log WHERE action='read_background_check' AND entity_id=$1", [ordered.record_id]))[0].n;
  assert.equal(reads, 2);
  assert.equal((await q("SELECT count(*)::int AS n FROM comp_events WHERE record_id=$1 AND action='background_check_read'", [ordered.record_id]))[0].n, 2);
  // outsiders learn nothing
  assert.equal((await api('GET', `/compliance/records/${ordered.record_id}/background-check`, { token: (await person()).token })).status, 404);
  assert.equal((await api('GET', `/compliance/records/${ordered.record_id}/background-check`)).status, 401);
  assert.ok(owner);
});

test('not clear, outages and fail-closed mapping: only exact results move a check; a reviewer can always reject', async () => {
  assert.equal(mapState('clear'), 'clear'); assert.equal(mapState('not_clear'), 'not_clear');
  for (const odd of ['CLEAR', 'passed', '', null, undefined, 1, { a: 1 }]) assert.equal(mapState(odd), 'pending');
  const { coach, reviewer, req, linked } = await setup();
  must(await api('POST', '/compliance/background-checks/consent', { token: coach.token, body: { requirement_id: req.id, confirm: true } }), 201);
  const o = must(await api('POST', '/compliance/background-checks', { token: coach.token, body: { requirement_id: req.id, provider: 'stub' } }), 201);
  const v = (await q('SELECT * FROM comp_check_vendor WHERE record_id=$1', [o.record_id]))[0];
  const ref0 = (await import('../src/crypto.js')).decrypt(v.provider_ref_enc, 'comp_check_vendor.provider_ref');
  must(await webhook(linked.id, { event_id: 'n1', ref: ref0, result: 'consider' }));       // not an exact result: stays pending
  assert.equal((await q('SELECT state FROM comp_check_vendor WHERE record_id=$1', [o.record_id]))[0].state, 'pending');
  must(await webhook(linked.id, { event_id: 'n2', ref: ref0, result: 'not_clear' }));
  assert.equal(code(await api('POST', `/compliance/records/${o.record_id}/decision`, { token: reviewer.token, body: { decision: 'approve' } })), 'vendor_not_clear');
  const rej = must(await api('POST', `/compliance/records/${o.record_id}/decision`, { token: reviewer.token, body: { decision: 'reject' } }));
  assert.equal(rej.outcome, 'not_clear'); assert.equal(rej.status, 'rejected');
  assert.equal((await q('SELECT decision_reason FROM comp_records WHERE id=$1', [o.record_id]))[0].decision_reason, null, 'a not-clear check shares no reason');
});

test('poll sweep: a result that never arrived by webhook is picked up; an outage leaves it pending with only an error code', async () => {
  const { coach, req } = await setup();
  must(await api('POST', '/compliance/background-checks/consent', { token: coach.token, body: { requirement_id: req.id, confirm: true } }), 201);
  const o = must(await api('POST', '/compliance/background-checks', { token: coach.token, body: { requirement_id: req.id, provider: 'stub' } }), 201);
  const v = (await q('SELECT * FROM comp_check_vendor WHERE record_id=$1', [o.record_id]))[0];
  const ref0 = (await import('../src/crypto.js')).decrypt(v.provider_ref_enc, 'comp_check_vendor.provider_ref');
  await pollBackgroundChecks();
  assert.equal((await q('SELECT state FROM comp_check_vendor WHERE record_id=$1', [o.record_id]))[0].state, 'pending');
  stubControl.set(ref0, 'clear');
  await q("UPDATE comp_check_vendor SET last_polled_at = now() - interval '1 hour' WHERE record_id=$1", [o.record_id]);
  const swept = await runComplianceSweeps();
  assert.ok(swept.background_checks >= 1);
  assert.equal((await q('SELECT state FROM comp_check_vendor WHERE record_id=$1', [o.record_id]))[0].state, 'clear');
});

test('generic JSON provider: https only, signed webhooks, outage => 502 and nothing ordered; credentials are encrypted', async () => {
  const { owner, coach, req, org } = await setup();
  const bad = await api('POST', '/compliance/background-providers', { token: owner.token, body: { provider: 'generic_json', organisation_id: org.id, config: { base_url: 'http://insecure.example', api_key: 'k', webhook_secret: 's' } } });
  assert.equal(bad.status, 400);
  assert.equal((await api('POST', '/compliance/background-providers', { token: owner.token, body: { provider: 'generic_json', organisation_id: org.id, config: { base_url: 'https://vendor.example' } } })).status, 400, 'incomplete settings');
  assert.equal((await api('POST', '/compliance/background-providers', { token: coach.token, body: { provider: 'stub', organisation_id: org.id, config: { webhook_secret: 's' } } })).status, 404, 'only the organisation\'s owner/admin links a provider');
  assert.equal((await api('POST', '/compliance/background-providers', { token: owner.token, body: { provider: 'stub', config: { webhook_secret: 's' } } })).status, 403, 'a platform-wide provider is the platform team\'s');
  const link = must(await api('POST', '/compliance/background-providers', { token: owner.token, body: { provider: 'generic_json', organisation_id: org.id, config: { base_url: 'https://vendor.example/api', api_key: 'sk_live_VERYSECRET', webhook_secret: 'wh1' } } }), 201);
  assert.ok(!JSON.stringify(await q('SELECT * FROM comp_vendor_credentials WHERE id=$1', [link.id])).includes('VERYSECRET'), 'credentials are encrypted');
  assert.ok(!JSON.stringify(must(await api('GET', '/compliance/background-providers', { token: owner.token, query: { organisation_id: org.id } }))).includes('VERYSECRET'));
  must(await api('POST', '/compliance/background-checks/consent', { token: coach.token, body: { requirement_id: req.id, confirm: true } }), 201);
  const real = transport.fetch;
  try {
    transport.fetch = async () => { throw new Error('connect ECONNREFUSED'); };
    const down = await api('POST', '/compliance/background-checks', { token: coach.token, body: { requirement_id: req.id, provider: 'generic_json' } });
    assert.equal(down.status, 502);
    assert.equal((await q("SELECT count(*)::int AS n FROM comp_records WHERE requirement_id=$1 AND status='submitted'", [req.id]))[0].n, 0, 'nothing was ordered');
    const seen = [];
    transport.fetch = async (o) => { seen.push(o); return o.method === 'POST' ? { status: 201, text: JSON.stringify({ id: 'vendor-77', report_url: 'https://x', findings: ['SECRET'] }) } : { status: 200, text: JSON.stringify({ result: 'clear', findings: ['SECRET'] }) }; };
    const ok = must(await api('POST', '/compliance/background-checks', { token: coach.token, body: { requirement_id: req.id, provider: 'generic_json' } }), 201);
    assert.equal(seen[0].url, 'https://vendor.example/api/checks'); assert.match(seen[0].headers.authorization, /^Bearer /);
    const sent = JSON.parse(seen[0].body); assert.deepEqual(Object.keys(sent).sort(), ['name', 'reference'], 'only our reference and the name are sent');
    await pool.query("UPDATE comp_check_vendor SET last_polled_at = now() - interval '1 hour' WHERE record_id=$1", [ok.record_id]);
    await pollBackgroundChecks();
    assert.equal((await q('SELECT state FROM comp_check_vendor WHERE record_id=$1', [ok.record_id]))[0].state, 'clear');
    assert.ok(!JSON.stringify(await q('SELECT * FROM comp_events')).includes('SECRET'), 'findings are never stored');
  } finally { transport.fetch = real; }
});

test('self-declaration stays refused, and the capabilities are in REST, OpenAPI and MCP', async () => {
  const { owner, org } = await setup();
  const bad = await api('POST', '/compliance/requirements', { token: owner.token, body: { scope_kind: 'organisation', scope_id: org.id, name: 'Self check', category: 'background_check', method: 'declaration', statement: 'I am fine' } });
  assert.equal(bad.status, 400);
  const names = ['get_background_check_options', 'record_background_check_consent', 'withdraw_background_check_consent', 'start_background_check', 'get_background_check', 'link_background_check_provider', 'list_background_check_providers'];
  for (const nme of names) assert.ok(capabilities.find((c) => c.name === nme), nme);
  const spec = await (await fetch(`${base}/api/v1/openapi.json`)).json();
  const ops = new Set(Object.values(spec.paths).flatMap((p) => Object.values(p).map((o) => o.operationId)));
  for (const nme of names) assert.ok(ops.has(nme), `openapi ${nme}`);
});
