import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');

let server, base, n = 0, admin, admin2;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `vf_${n}_${roles[0]}`, display_name: `Verify ${n}`, email: `vf${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const mkAdmin = async (h) => { const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ($1,$1,'{admin}','x','x',$1) RETURNING id", [h])).rows[0]; return { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) }; };
const PDF = Buffer.from('%PDF-1.4 fake evidence body').toString('base64');
const ID = { kind: 'id_document', label: 'Passport', data: PDF, file_name: 'passport.pdf' };
const submit = (u, body) => api('POST', '/verification/cases', { token: u.token, body });
const decide = (a, id, body) => api('POST', `/admin/verification/cases/${id}/decision`, { token: a.token, body });
const claim = async (a, id) => must(await api('POST', `/admin/verification/cases/${id}/claim`, { token: a.token }));
const allOk = async (type) => (await api('GET', '/verification/rules')).body.types.find((t) => t.type === type).checklist.map((x) => ({ key: x.key, ok: true }));

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  admin = await mkAdmin('vf_root'); admin2 = await mkAdmin('vf_root2');
});
after(async () => { server.close(); await pool.end(); });

test('rules are public and describe evidence + checklist per type', async () => {
  const r = must(await api('GET', '/verification/rules'));
  assert.deepEqual(r.types.map((t) => t.type).sort(), ['coach', 'doctor', 'event', 'gamer', 'physio', 'sponsor']);
  assert.ok(r.types.every((t) => t.checklist.length >= 3 && t.validity_months > 0));
});

test('gamer: submit -> claim -> approve shows a public badge; evidence stays private', async () => {
  const u = await signup(['athlete']), other = await signup(['athlete']);
  assert.deepEqual(must(await api('GET', `/people/${u.id}`)).verified, []);
  // self-declared role alone is not enough; evidence is required
  assert.equal((await submit(u, { type: 'gamer', evidence: [ID] })).status, 400); // needs a profile link / letter / record too
  assert.equal((await submit(other, { type: 'coach', evidence: [ID, { kind: 'coaching_certificate', reference: 'CERT-1' }] })).status, 400); // no coach role
  const c = must(await submit(u, { type: 'gamer', claim_note: 'Club striker', evidence: [ID, { kind: 'profile_link', reference: 'https://league.example/p/1' }] }), 201);
  assert.equal(c.status, 'submitted');
  assert.equal((await submit(u, { type: 'gamer', evidence: [ID, { kind: 'profile_link', reference: 'https://league.example/p/1' }] })).status, 409); // one open case
  assert.deepEqual(must(await api('GET', `/people/${u.id}`)).verified, []); // not public until approved

  // permissions: only the platform team works the queue; others cannot see the case
  assert.equal((await api('GET', '/admin/verification/cases', { token: u.token })).status, 403);
  assert.equal((await api('GET', `/verification/cases/${c.id}`, { token: other.token })).status, 404);
  assert.ok(must(await api('GET', '/admin/verification/cases', { token: admin.token })).some((x) => x.id === c.id));

  // decide needs a claim, full checklist
  assert.equal((await decide(admin, c.id, { decision: 'approve', checklist: await allOk('gamer') })).status, 409);
  await claim(admin, c.id);
  assert.equal((await api('POST', `/admin/verification/cases/${c.id}/claim`, { token: admin2.token })).status, 409);
  assert.equal((await decide(admin2, c.id, { decision: 'reject', reason: 'not mine to decide' })).status, 403);
  const partial = (await allOk('gamer')).map((x, i) => (i === 0 ? { ...x, ok: false } : x));
  assert.equal((await decide(admin, c.id, { decision: 'approve', checklist: partial })).status, 400);

  // evidence read is audit-logged and only for the team
  assert.equal((await api('GET', `/admin/verification/cases/${c.id}/evidence`, { token: u.token })).status, 403);
  const ev = must(await api('GET', `/admin/verification/cases/${c.id}/evidence`, { token: admin.token }));
  assert.ok(ev.find((e) => e.kind === 'profile_link').reference.startsWith('https://'));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='read_verification_evidence' AND entity_id=$1", [c.id])).rows[0].n, 1);
  const fileId = ev.find((e) => e.kind === 'id_document').id;
  assert.equal(must(await api('GET', `/admin/verification/cases/${c.id}/evidence`, { token: admin.token, query: { evidence_id: fileId } })).find((e) => e.id === fileId).data, PDF);

  const done = must(await decide(admin, c.id, { decision: 'approve', checklist: await allOk('gamer') }));
  assert.equal(done.status, 'approved');
  const badge = must(await api('GET', `/people/${u.id}`)).verified;
  assert.equal(badge[0].type, 'gamer');
  assert.ok(must(await api('GET', '/people', { query: { q: u.handle } })).find((p) => p.id === u.id).verified.length);
  assert.equal(must(await api('GET', '/verification/badge', { query: { subject_type: 'user', subject_id: u.id } })).verified, true);

  // nothing sensitive leaks to the public or to the requester's own case view
  const publicText = JSON.stringify([badge, must(await api('GET', `/people/${u.id}`))]);
  assert.ok(!publicText.includes('league.example') && !publicText.includes(PDF));
  const mine = must(await api('GET', `/verification/cases/${c.id}`, { token: u.token }));
  assert.ok(!JSON.stringify(mine).includes('league.example') && !JSON.stringify(mine).includes(PDF));
  assert.deepEqual(mine.history.map((h) => h.action), ['submit', 'claim', 'approve']);
  assert.equal((await submit(u, { type: 'gamer', evidence: [ID, { kind: 'profile_link', reference: 'https://league.example/p/1' }] })).status, 409); // already verified

  // revoke needs a reason, removes the badge, keeps history; owner can re-submit
  assert.equal((await api('POST', `/admin/verification/cases/${c.id}/revoke`, { token: admin.token, body: { reason: '' } })).status, 400);
  must(await api('POST', `/admin/verification/cases/${c.id}/revoke`, { token: admin.token, body: { reason: 'Account found to be shared' } }));
  assert.deepEqual(must(await api('GET', `/people/${u.id}`)).verified, []);
  must(await submit(u, { type: 'gamer', evidence: [ID, { kind: 'match_record', reference: 'https://league.example/m/9' }] }), 201);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM verification_cases WHERE subject_id=$1', [u.id])).rows[0].n, 2);
});

test('needs_info -> add evidence -> resubmit; reject needs reason; reviewer cannot review their own case; withdraw', async () => {
  const doc = await signup(['doctor']);
  assert.equal((await submit(doc, { type: 'doctor', evidence: [ID, { kind: 'medical_registration', reference: 'MCI-1' }, { kind: 'other', data: 'not a real file at all, sorry' }] })).status, 400); // unsupported file
  const c = must(await submit(doc, { type: 'doctor', evidence: [ID, { kind: 'medical_registration', reference: 'MCI-1' }] }), 201);
  await claim(admin, c.id);
  assert.equal((await decide(admin, c.id, { decision: 'needs_info' })).status, 400); // reason required
  must(await decide(admin, c.id, { decision: 'needs_info', reason: 'Registration photo is blurry, please re-upload' }));
  const seen = must(await api('GET', `/verification/cases/${c.id}`, { token: doc.token }));
  assert.equal(seen.status, 'needs_info'); assert.match(seen.decision_reason, /blurry/);
  must(await api('POST', `/verification/cases/${c.id}/evidence`, { token: doc.token, body: { evidence: [{ kind: 'medical_registration', data: PDF, file_name: 'reg.pdf' }] } }), 201);
  assert.equal(must(await api('POST', `/verification/cases/${c.id}/resubmit`, { token: doc.token, body: {} })).status, 'submitted');
  await claim(admin2, c.id);
  assert.equal(must(await decide(admin2, c.id, { decision: 'reject', reason: 'Registration not found on the council register' })).status, 'rejected');
  assert.deepEqual(must(await api('GET', `/people/${doc.id}`)).verified, []);

  // an admin who is also a requester cannot review their own request
  const ad = await mkAdmin('vf_self'); await pool.query("UPDATE users SET roles='{admin,coach}' WHERE id=$1", [ad.id]);
  const own = must(await submit(ad, { type: 'coach', evidence: [ID, { kind: 'coaching_certificate', reference: 'C-9' }] }), 201);
  assert.equal((await api('POST', `/admin/verification/cases/${own.id}/claim`, { token: ad.token })).status, 403);

  const w = await signup(['physio']);
  const wc = must(await submit(w, { type: 'physio', evidence: [ID, { kind: 'professional_licence', reference: 'P-1' }] }), 201);
  must(await api('POST', `/verification/cases/${wc.id}/withdraw`, { token: w.token }));
  assert.equal((await api('POST', `/verification/cases/${wc.id}/withdraw`, { token: w.token })).status, 409);
});

test('sponsor and event verification attach to the canonical rows, owner only; expiry removes the badge', async () => {
  const sp = await signup(['sponsor']), org = await signup(['organizer']), rival = await signup(['sponsor']);
  const sponsor = must(await api('POST', '/sponsors', { token: sp.token, body: { name: 'Acme Sports' } }), 201);
  const sport = (await pool.query('SELECT id FROM sports LIMIT 1')).rows[0];
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: 'Verified Cup', sport: sport.id } }), 201);
  const spEv = [{ kind: 'business_registration', reference: 'CIN-123' }, { kind: 'website_domain_proof', reference: 'https://acme.example/.well-known/sa' }];
  assert.deepEqual(must(await api('GET', '/sponsors', { token: sp.token, query: { mine: 'true' } })).map((x) => x.id), [sponsor.id]);
  assert.equal((await submit(rival, { type: 'sponsor', subject_id: sponsor.id, evidence: spEv })).status, 403);
  const sc = must(await submit(sp, { type: 'sponsor', subject_id: sponsor.id, evidence: spEv }), 201);
  assert.equal((await submit(sp, { type: 'event', subject_id: ev.id, evidence: [{ kind: 'public_listing', reference: 'https://x.example/e' }] })).status, 403);
  const ec = must(await submit(org, { type: 'event', subject_id: ev.id, evidence: [{ kind: 'sanction_letter', data: PDF }] }), 201);
  for (const [cs, type] of [[sc, 'sponsor'], [ec, 'event']]) { await claim(admin, cs.id); must(await decide(admin, cs.id, { decision: 'approve', checklist: await allOk(type) })); }
  assert.equal(must(await api('GET', `/sponsors/${sponsor.id}`)).verified[0].type, 'sponsor');
  assert.equal(must(await api('GET', `/events/${ev.id}`)).verified[0].type, 'event');
  assert.ok(must(await api('GET', '/events')).find((e) => e.id === ev.id).verified.length);
  assert.ok(must(await api('GET', '/sponsors')).find((s) => s.id === sponsor.id).verified.length);

  // expiry: badge disappears, state reads `expired`, renewal is allowed
  await pool.query("UPDATE verification_cases SET expires_at = now() - interval '1 day' WHERE id=$1", [sc.id]);
  assert.deepEqual(must(await api('GET', `/sponsors/${sponsor.id}`)).verified, []);
  assert.equal(must(await api('GET', `/verification/cases/${sc.id}`, { token: sp.token })).status, 'expired');
  assert.ok(must(await api('GET', '/admin/verification/cases', { token: admin.token, query: { status: 'expired' } })).some((x) => x.id === sc.id));
  const renew = must(await submit(sp, { type: 'sponsor', subject_id: sponsor.id, evidence: spEv }), 201);
  assert.equal((await pool.query('SELECT previous_case_id FROM verification_cases WHERE id=$1', [renew.id])).rows[0].previous_case_id, sc.id);
});

test('database dump holds no plaintext evidence', async () => {
  const dump = JSON.stringify((await pool.query('SELECT * FROM verification_evidence')).rows);
  assert.ok(!dump.includes('MCI-1') && !dump.includes('CIN-123') && !dump.includes('acme.example') && !dump.includes(PDF));
});
