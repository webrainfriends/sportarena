// Legal services phase 1 (issue #231): packs gate regulated workflows, credentials need a verified admission in the same jurisdiction,
// discovery is informational, intake and conflicts never leak other clients, quote -> sign -> confirm -> matter are separate steps.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { PACKS, PACK_CODES } = await import('../src/legal/packs.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `lg_${n}_${roles[0]}`, display_name: `Legal ${n}`, email: `lg${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const mkAdmin = async () => { const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('lg_root','lg_root','{admin}','x','x','lg_root') RETURNING id")).rows[0]; return { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) }; };
const verifyLawyer = (u, jurisdiction, days = 300) => pool.query("INSERT INTO verification_cases(type, subject_type, subject_id, requested_by, status, rules_version, decided_at, expires_at, jurisdiction) VALUES ('lawyer','user',$1,$1,'approved',1,now(), now() + ($3 || ' days')::interval, $2)", [u.id, jurisdiction, String(days)]);
const approve = (country, features = ['requests', 'responses', 'intake', 'quotes', 'engagement']) => api('POST', `/admin/legal/packs/${country}/approval`, { token: admin.token, body: { status: 'approved', features, reviewer_name: 'A. Reviewer', reviewer_firm: 'Example Chambers', reviewed_on: '2026-09-01' } });
const lawyer = async (jurisdiction = 'GB', { verified = true, areas = ['sports_contracts', 'sponsorship'], list = true } = {}) => {
  const u = await signup(['lawyer']);
  must(await api('POST', '/legal/me/credentials', { token: u.token, body: { jurisdiction, region: 'England & Wales', regulator: 'Solicitors Regulation Authority', register_ref: `SRA-${n}`, title: 'Solicitor', practice_areas: areas } }), 201);
  if (verified) await verifyLawyer(u, jurisdiction);
  if (list) must(await api('POST', '/legal/me/profile', { token: u.token, body: { headline: 'Sports law', languages: ['English'], fee_models: ['flat', 'hourly'], listed: true } }));
  return u;
};
const intake = (client, lw, extra = {}) => api('POST', '/legal/intakes', { token: client.token, body: { lawyer_id: lw.id, practice_area: 'sports_contracts', jurisdiction: 'GB', summary: 'Review of my club contract renewal', parties: [{ role: 'client', name: 'Rowan Athlete' }, { role: 'counterparty', name: 'Northside FC Ltd' }], ...extra } });
const inOneWeek = () => new Date(Date.now() + 7 * 864e5).toISOString();
const quote = (lw, id, extra = {}) => api('POST', `/legal/intakes/${id}/quotes`, { token: lw.token, body: { fee_model: 'flat', amount_cents: 150000, is_estimate: false, currency: 'GBP', tax_cents: 30000, scope: 'Review and mark-up of the renewal contract', expires_at: inOneWeek(), ...extra } });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  admin = await mkAdmin();
});
after(async () => { server.close(); await pool.end(); });

test('the eleven packs are public, sourced, honest about approval, and offer no unsupported flows', async () => {
  assert.deepEqual([...PACK_CODES].sort(), ['AE', 'AU', 'CA', 'CN', 'GB', 'IN', 'JP', 'MY', 'NZ', 'SG', 'US']);
  const r = must(await api('GET', '/legal/packs'));
  assert.equal(r.packs.length, 11);
  for (const p of r.packs) {
    assert.ok(p.instruments.length && p.regulators.length && p.sources.length && p.open_questions.length, p.code);
    assert.deepEqual(p.enabled, [], `${p.code} has no regulated workflow before qualified approval`);
    assert.equal(p.approval, null);
  }
  assert.equal(PACKS.IN.advertising, 'informational_only');
  assert.ok(r.not_supported.includes('trust_or_client_money') && r.not_supported.includes('referral_fees') && r.not_supported.includes('contingency_fees'));
  assert.equal(r.fee_models.contingency, undefined);
});

test('regulated workflows are off until local counsel approves; approvals are append-only, admin only and need a named reviewer', async () => {
  const client = await signup(['athlete']);
  const off = await api('POST', '/legal/requests', { token: client.token, body: { practice_area: 'sponsorship', jurisdiction: 'SG', timeframe: 'flexible' } });
  assert.equal(off.status, 409); assert.equal(off.body.error.code, 'jurisdiction_not_enabled');
  assert.equal((await api('POST', '/admin/legal/packs/SG/approval', { token: client.token, body: { status: 'approved', features: ['requests'], reviewer_name: 'X Y Z', reviewer_firm: 'F', reviewed_on: '2026-09-01' } })).status, 403);
  assert.equal((await api('POST', '/admin/legal/packs/SG/approval', { token: admin.token, body: { status: 'approved', features: ['requests'], reviewer_name: 'X Y Z', reviewed_on: '2026-09-01' } })).status, 400, 'needs the reviewing firm');
  assert.equal((await api('POST', '/admin/legal/packs/SG/approval', { token: admin.token, body: { status: 'approved', features: ['responses'], reviewer_name: 'X Y Z', reviewer_firm: 'F', reviewed_on: '2026-09-01' } })).status, 400, 'responses need requests');
  must(await approve('SG', ['requests']), 201);
  must(await api('POST', '/legal/requests', { token: client.token, body: { practice_area: 'sponsorship', jurisdiction: 'SG', timeframe: 'flexible' } }), 201);
  const sg = must(await api('GET', '/legal/packs')).packs.find((p) => p.code === 'SG');
  assert.deepEqual(sg.enabled, ['requests']); assert.equal(sg.approval.reviewer, 'A. Reviewer'); assert.equal(sg.approval.reviewer_firm, 'Example Chambers');
  must(await api('POST', '/admin/legal/packs/SG/approval', { token: admin.token, body: { status: 'withdrawn', reviewer_name: 'X Y Z', reviewed_on: '2026-09-02' } }), 201);
  assert.equal((await api('POST', '/legal/requests', { token: client.token, body: { practice_area: 'sponsorship', jurisdiction: 'SG', timeframe: 'flexible' } })).status, 409, 'withdrawn switches it off again');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM legal_pack_approvals WHERE country=$1', ['SG'])).rows[0].n, 2, 'both decisions are kept');
  await assert.rejects(() => pool.query('UPDATE legal_pack_approvals SET status=$1', ['approved']), /append-only/);
});

test('a lawyer is listed only with a verified admission in that jurisdiction; foreign admission and lapsed verification do not count', async () => {
  const unverified = await signup(['lawyer']);
  must(await api('POST', '/legal/me/credentials', { token: unverified.token, body: { jurisdiction: 'GB', regulator: 'SRA', register_ref: 'SRA-1', title: 'Solicitor', practice_areas: ['sponsorship'] } }), 201);
  const noList = await api('POST', '/legal/me/profile', { token: unverified.token, body: { headline: 'x', listed: true } });
  assert.equal(noList.status, 409, 'cannot be listed before verification');
  const plain = await signup(['athlete']);
  assert.equal((await api('POST', '/legal/me/credentials', { token: plain.token, body: { jurisdiction: 'GB', regulator: 'SRA', register_ref: 'SRA-2', title: 'x', practice_areas: ['sponsorship'] } })).status, 403);

  const gb = await lawyer('GB');
  const mine = must(await api('GET', '/legal/me/credentials', { token: gb.token }));
  assert.equal(mine[0].verified, true); assert.match(mine[0].register_ref, /^SRA-/);
  assert.ok(!JSON.stringify((await pool.query('SELECT register_ref_enc FROM legal_credentials')).rows).includes('SRA-'), 'register reference is encrypted at rest');

  const found = must(await api('GET', '/legal/counsel', { query: { jurisdiction: 'GB', practice_area: 'sports_contracts' } }));
  assert.ok(found.some((c) => c.id === gb.id)); assert.ok(!found.some((c) => c.id === unverified.id));
  assert.equal(found.find((c) => c.id === gb.id).admissions[0].can_engage_online, false, 'GB not approved yet');
  assert.equal(must(await api('GET', '/legal/counsel', { query: { jurisdiction: 'AU' } })).some((c) => c.id === gb.id), false, 'GB admission is not Australian admission');
  assert.equal(must(await api('GET', '/legal/counsel', { query: { fee_model: 'capped' } })).some((c) => c.id === gb.id), false);
  assert.equal(must(await api('GET', `/legal/counsel/${gb.id}`)).solo, true);

  await pool.query("UPDATE verification_cases SET status='revoked' WHERE subject_id=$1", [gb.id]);
  assert.equal(must(await api('GET', '/legal/counsel', { query: { jurisdiction: 'GB' } })).some((c) => c.id === gb.id), false, 'revoked verification removes the listing');
  assert.equal((await api('GET', `/legal/counsel/${gb.id}`)).status, 404);
});

test('public requests carry no free text, lawyers only see requests they can answer, and a response is not an engagement', async () => {
  await approve('GB');
  const gb = await lawyer('GB'), au = await lawyer('GB', { areas: ['employment'] });
  const client = await signup(['athlete']);
  const bad = await api('POST', '/legal/requests', { token: client.token, body: { practice_area: 'sponsorship', jurisdiction: 'GB', timeframe: 'urgent', details: 'my opponent is Bob and I have a torn ACL' } });
  assert.equal(bad.status, 201); assert.equal(bad.body.details, undefined, 'unknown free text is dropped, never stored');
  assert.deepEqual(Object.keys((await pool.query('SELECT * FROM legal_requests WHERE id=$1', [bad.body.id])).rows[0]).filter((k) => /detail|body|text|note/.test(k)), []);
  const req = bad.body;
  assert.ok(must(await api('GET', '/legal/requests', { token: gb.token })).some((r) => r.id === req.id));
  assert.equal(must(await api('GET', '/legal/requests', { token: au.token })).some((r) => r.id === req.id), false, 'practice area not held');
  assert.equal(must(await api('GET', '/legal/requests', { token: gb.token })).find((r) => r.id === req.id).author_id, undefined, 'no requester identity');
  assert.equal((await api('POST', `/legal/requests/${req.id}/respond`, { token: au.token })).status, 403);
  must(await api('POST', `/legal/requests/${req.id}/respond`, { token: gb.token }), 201);
  assert.equal((await api('POST', `/legal/requests/${req.id}/respond`, { token: gb.token })).status, 409);
  assert.equal(must(await api('GET', '/legal/requests/mine', { token: client.token }))[0].responses, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM legal_intakes')).rows[0].n, 0, 'responding creates no intake or engagement');
  must(await api('POST', `/legal/requests/${req.id}/close`, { token: client.token }));
});

test('India stays informational until local review approves responses; the lawyer sees no solicitations', async () => {
  const lw = await lawyer('IN', { areas: ['sponsorship'] });
  const client = await signup(['athlete']);
  assert.equal((await api('POST', '/legal/requests', { token: client.token, body: { practice_area: 'sponsorship', jurisdiction: 'IN', timeframe: 'flexible' } })).status, 409);
  must(await approve('IN', ['requests']), 201);
  must(await api('POST', '/legal/requests', { token: client.token, body: { practice_area: 'sponsorship', jurisdiction: 'IN', timeframe: 'flexible' } }), 201);
  assert.deepEqual(must(await api('GET', '/legal/requests', { token: lw.token })), [], 'requests on, responses off: nothing is shown to lawyers');
  assert.equal(must(await api('GET', '/legal/counsel', { query: { jurisdiction: 'IN' } })).some((c) => c.id === lw.id), true, 'informational listing remains');
});

test('intake: needs approval + a verified lawyer, authority for a team, and blocks minors', async () => {
  const gb = await lawyer('GB'), client = await signup(['athlete']);
  const other = await signup(['athlete']);
  assert.equal((await intake(client, gb, { jurisdiction: 'US' })).status, 409, 'US pack not approved');
  const nobody = await signup(['lawyer']);
  assert.equal((await intake(client, nobody)).status, 403, 'lawyer without a verified credential');
  assert.equal((await intake(client, gb, { practice_area: 'employment' })).status, 403, 'practice area outside the credential');
  const t = must(await api('POST', '/teams', { token: client.token, body: { name: 'Legal FC', sport: 'football' } }), 201);
  assert.equal((await intake(other, gb, { acting_as: 'team', acting_for_id: t.id })).status, 403, 'no authority over that team');
  const ok = must(await intake(client, gb, { acting_as: 'team', acting_for_id: t.id, payer: 'third_party' }), 201);
  assert.equal(ok.status, 'conflict_review');
  assert.equal((await api('GET', `/legal/intakes/${ok.id}`, { token: other.token })).status, 404);
  assert.equal((await api('GET', `/legal/intakes/${ok.id}`, { token: admin.token })).status, 404, 'platform admin cannot read private legal intake');
  const kid = await signup(['athlete']);
  await pool.query("UPDATE users SET youth_until = current_date + 365 WHERE id=$1", [kid.id]);
  assert.equal((await intake(kid, gb)).status, 403, 'a minor cannot instruct counsel; a guardian must');
});

test('conflicts: a repeated name flags review without revealing the other client; blocked stops everything; waiver needs a reason', async () => {
  const gb = await lawyer('GB'), a = await signup(['athlete']), b = await signup(['athlete']);
  const first = must(await intake(a, gb, { parties: [{ role: 'client', name: 'Alice One' }, { role: 'counterparty', name: 'Acme Sports Ltd' }] }), 201);
  must(await api('POST', `/legal/intakes/${first.id}/conflict`, { token: gb.token, body: { outcome: 'clear', reason: 'No other matter involves these parties' } }));
  const second = must(await intake(b, gb, { parties: [{ role: 'client', name: 'Bea Two' }, { role: 'counterparty', name: '  ACME  sports ltd. ' }] }), 201);
  const lawyerView = must(await api('GET', `/legal/intakes/${second.id}`, { token: gb.token }));
  assert.equal(lawyerView.conflict.match_count, 1);
  assert.ok(!JSON.stringify(lawyerView).includes('Alice'), 'other client identity is never shown');
  assert.ok(!JSON.stringify(must(await api('GET', `/legal/intakes/${second.id}`, { token: b.token }))).includes('Alice'));
  assert.equal(must(await api('GET', `/legal/intakes/${second.id}`, { token: b.token })).conflict.match_count, undefined, 'client does not see match counts');
  assert.ok(!JSON.stringify((await pool.query('SELECT name_enc FROM legal_intake_parties')).rows).includes('Acme'), 'names are encrypted at rest');
  assert.equal((await quote(gb, second.id)).status, 409, 'no quote before the conflict is cleared');
  assert.equal((await api('POST', `/legal/intakes/${second.id}/conflict`, { token: gb.token, body: { outcome: 'waived', reason: 'ok fine' } })).status, 400);
  assert.equal((await api('POST', `/legal/intakes/${second.id}/conflict`, { token: b.token, body: { outcome: 'clear', reason: 'self clear' } })).status, 403, 'a client cannot clear their own conflict');
  const blocked = must(await api('POST', `/legal/intakes/${second.id}/conflict`, { token: gb.token, body: { outcome: 'blocked', reason: 'Acting for the counterparty already' } }));
  assert.equal(blocked.status, 'conflict_blocked');
  assert.equal((await quote(gb, second.id)).status, 409);
  assert.equal((await api('POST', `/legal/intakes/${second.id}/matter`, { token: gb.token, body: { title: 'Nope matter' } })).status, 409);
  assert.equal(must(await api('GET', `/legal/intakes/${second.id}`, { token: gb.token })).conflict.history.length, 2);
  // a material party change re-opens review
  must(await api('POST', `/legal/intakes/${first.id}/parties`, { token: a.token, body: { party: { role: 'counterparty', name: 'Zed Holdings' } } }));
  assert.equal(must(await api('GET', `/legal/intakes/${first.id}`, { token: a.token })).status, 'conflict_review');
  await assert.rejects(() => pool.query('DELETE FROM legal_conflict_checks'), /append-only/);
});

test('quote -> accept -> sign -> confirm -> matter: each step separate, exact versions, credential re-checked', async () => {
  const gb = await lawyer('GB'), client = await signup(['athlete']);
  const it = must(await intake(client, gb), 201);
  must(await api('POST', `/legal/intakes/${it.id}/conflict`, { token: gb.token, body: { outcome: 'clear', reason: 'No conflicting matters found' } }));
  assert.equal((await api('POST', `/legal/intakes/${it.id}/engagement`, { token: client.token, body: { quote_version: 1, capacity: 'client', accept_terms: true } })).status, 409, 'cannot sign without an accepted quote');
  const q1 = must(await quote(gb, it.id), 201);
  assert.equal(q1.total_cents, 180000); assert.equal(q1.version, 1);
  assert.equal((await quote(gb, it.id, { fee_model: 'contingency' })).status, 400, 'contingency is not offered');
  assert.equal((await quote(gb, it.id, { expires_at: new Date(Date.now() - 1000).toISOString() })).status, 400);
  const q2 = must(await quote(gb, it.id, { amount_cents: 120000 }), 201);
  assert.equal(q2.version, 2);
  assert.equal((await api('POST', `/legal/quotes/${q1.id}/accept`, { token: client.token, body: { version: 1 } })).status, 409, 'superseded version');
  assert.equal((await api('POST', `/legal/quotes/${q2.id}/accept`, { token: client.token, body: { version: 1 } })).status, 409, 'must name the exact version read');
  assert.equal((await api('POST', `/legal/quotes/${q2.id}/accept`, { token: gb.token, body: { version: 2 } })).status, 404, 'the lawyer cannot accept for the client');
  must(await api('POST', `/legal/quotes/${q2.id}/accept`, { token: client.token, body: { version: 2 } }));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM legal_matters')).rows[0].n, 0, 'accepting a quote creates no matter');
  assert.equal((await api('POST', `/legal/intakes/${it.id}/matter`, { token: gb.token, body: { title: 'Contract renewal' } })).status, 409, 'not signed yet');
  assert.equal((await api('POST', `/legal/intakes/${it.id}/engagement`, { token: client.token, body: { quote_version: 1, capacity: 'client', accept_terms: true } })).status, 409, 'wrong version');
  assert.equal((await api('POST', `/legal/intakes/${it.id}/engagement`, { token: client.token, body: { quote_version: 2, capacity: 'guardian', accept_terms: true } })).status, 400, 'guardian capacity makes no sense for yourself');
  const eng = must(await api('POST', `/legal/intakes/${it.id}/engagement`, { token: client.token, body: { quote_version: 2, capacity: 'client', accept_terms: true } }), 201);
  assert.equal(eng.quote_version, 2); assert.equal(eng.terms_version, 'GB-v1'); assert.equal(eng.lawyer_confirmed_at, null);
  assert.equal((await api('POST', `/legal/intakes/${it.id}/matter`, { token: gb.token, body: { title: 'Contract renewal' } })).status, 409, 'lawyer has not confirmed');
  // a lapsed credential stops activation
  await pool.query("UPDATE verification_cases SET expires_at = now() - interval '1 day' WHERE subject_id=$1", [gb.id]);
  assert.equal((await api('POST', `/legal/intakes/${it.id}/engagement/confirm`, { token: gb.token })).status, 403);
  await pool.query("UPDATE verification_cases SET expires_at = now() + interval '100 days' WHERE subject_id=$1", [gb.id]);
  must(await api('POST', `/legal/intakes/${it.id}/engagement/confirm`, { token: gb.token }));
  // withdrawing approval switches the regulated step off even though everything else is in place
  must(await api('POST', '/admin/legal/packs/GB/approval', { token: admin.token, body: { status: 'withdrawn', reviewer_name: 'A. Reviewer', reviewed_on: '2026-09-02' } }), 201);
  assert.equal((await api('POST', `/legal/intakes/${it.id}/matter`, { token: gb.token, body: { title: 'Contract renewal' } })).status, 409);
  must(await approve('GB'), 201);
  const m = must(await api('POST', `/legal/intakes/${it.id}/matter`, { token: gb.token, body: { title: 'Contract renewal' } }), 201);
  assert.equal(m.status, 'active');
  assert.equal(must(await api('GET', `/legal/intakes/${it.id}`, { token: client.token })).status, 'engaged');
  assert.equal((await api('POST', `/legal/intakes/${it.id}/matter`, { token: gb.token, body: { title: 'Again' } })).status, 409);
  const detail = must(await api('GET', `/legal/matters/${m.id}`, { token: client.token }));
  assert.equal(detail.quote.version, 2); assert.equal(detail.engagement.signer_capacity, 'client');
  assert.equal(must(await api('GET', '/legal/matters', { token: client.token })).length, 1);
  assert.equal(must(await api('GET', '/legal/matters', { token: gb.token, query: { as: 'lawyer' } })).length, 1);
  assert.equal((await api('GET', `/legal/matters/${m.id}`, { token: admin.token })).status, 404, 'admin has no back door into a matter');
  assert.equal((await api('POST', `/legal/intakes/${it.id}/parties`, { token: client.token, body: { party: { role: 'other', name: 'Late Addition' } } })).status, 409);
  await assert.rejects(() => pool.query('DELETE FROM legal_matters'), /never deleted/);
});

test('a lawyer verification must name the country admitted in', async () => {
  const u = await signup(['lawyer']);
  const base = { type: 'lawyer', evidence: [{ kind: 'id_document', reference: 'ID-1' }, { kind: 'bar_admission', reference: 'SRA-9' }] };
  assert.equal((await api('POST', '/verification/cases', { token: u.token, body: base })).status, 400);
  assert.equal((await api('POST', '/verification/cases', { token: u.token, body: { ...base, jurisdiction: 'Atlantis' } })).status, 400);
  const ok = must(await api('POST', '/verification/cases', { token: u.token, body: { ...base, jurisdiction: 'gb' } }), 201);
  assert.equal(ok.type, 'lawyer');
  assert.equal((await pool.query('SELECT jurisdiction FROM verification_cases WHERE id=$1', [ok.id])).rows[0].jurisdiction, 'GB');
});

test('intake reads are audit-logged and every capability is reachable over REST, OpenAPI and MCP with the same name', async () => {
  const { buildOpenApi } = await import('../src/openapi.js');
  const { capabilities } = await import('../src/capabilities/index.js');
  const legal = capabilities.filter((c) => c.tag === 'Legal');
  assert.ok(legal.length >= 25);
  const ops = Object.values(buildOpenApi().paths).flatMap((p) => Object.values(p)).map((o) => o.operationId);
  for (const c of legal) assert.ok(ops.includes(c.name), c.name);
  assert.ok((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='read_legal_intake'")).rows[0].n > 0);
});
