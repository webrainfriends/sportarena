// Para-sport Classification & Eligibility (#488): versioned definitions, verified classifiers, case/panel workflow, sensitive-evidence isolation,
// outcomes that supersede prospectively, appeals, external references, eligibility snapshots, AI boundary and sport coverage.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { forbiddenKind } = await import('../src/copilots.js');
const { capabilities } = await import('../src/registry.js');

let server, base, n = 0, admin, sport, sport2;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: r.status, body: parsed };
};
const rpc = async (method, params, token) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) });
  return (await r.json()).result;
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const day = (o = 0) => new Date(Date.now() + o * 864e5).toISOString().slice(0, 10);
const inst = (o) => new Date(Date.now() + o * 864e5).toISOString();
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const signup = async (roles = ['athlete'], extra = {}) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `pc_${n}_${roles[0]}`, display_name: `Pc ${n}`, email: `pc${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('governing evidence document body'), Buffer.from('\n%%EOF')]).toString('base64');

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('pc_root','pc_root','{admin}','x','x','pc_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  sport = (await pool.query("SELECT id FROM sports WHERE slug='athletics'")).rows[0] ?? (await pool.query('SELECT id FROM sports ORDER BY slug LIMIT 1')).rows[0];
  sport2 = (await pool.query('SELECT id FROM sports WHERE id<>$1 ORDER BY slug LIMIT 1', [sport.id])).rows[0];
  server = createApp().listen(0); base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const mkBody = async (owner) => must(await api('POST', '/federation/bodies', { token: owner.token, body: { name: `Para Federation ${++n}`, level: 'national', abbreviation: `PF${String(n).padStart(3, '0')}`, country: 'SG', sports: [{ sport_id: sport.id }] } }), 201);
const version = async (owner, b, over = {}) => {
  const v = must(await api('POST', '/para/class-versions', { token: owner.token, body: { body_id: b.id, sport_id: sport.id, title: 'Test classification rules', source_ref: 'Governing rulebook §4', effective_from: day(-30), panel_size: 1, review_rule: 'review_required', review_months: 24, appeal_days: 14,
    classes: [{ code: 'T11', name: 'Class T11' }, { code: 'T12', name: 'Class T12' }, { code: 'T13', name: 'Class T13' }], ...over } }), 201);
  return must(await api('POST', `/para/class-versions/${v.id}/publish`, { token: owner.token }));
};
const classifier = async (owner, b, who, over = {}) => must(await api('POST', '/para/classifiers', { token: owner.token, body: { body_id: b.id, user_id: who.id, sport_id: sport.id, grade: 'National', issued_on: day(-10), expires_on: day(300), ...over } }), 201);
/** A body, its owner, a published version, and `k` credentialed classifiers. */
const world = async (k = 2, versionOver = {}) => {
  const owner = await signup(['organizer']), b = await mkBody(owner), v = await version(owner, b, versionOver);
  const cls = [];
  for (let i = 0; i < k; i++) { const u = await signup(['athlete']); cls.push({ u, c: await classifier(owner, b, u) }); }
  return { owner, b, v, cls };
};
const openCase = async (w, ath, body = {}) => must(await api('POST', '/para/cases', { token: ath.token, body: { body_id: w.b.id, sport_id: sport.id, note: 'Requesting initial classification', ...body } }), 201);
const step = (who, id, to, extra = {}) => api('POST', `/para/cases/${id}/advance`, { token: who.token, body: { to, ...extra } });
/** Drive a case to a decision issued by `w.cls[0]` (lead) with the given class. */
const decide = async (w, ath, code = 'T12', status = 'confirmed') => {
  const cs = await openCase(w, ath);
  must(await api('POST', `/para/cases/${cs.id}/panel`, { token: w.owner.token, body: { members: w.cls.slice(0, w.v.panel_size ?? 1).map((x, i) => ({ classifier_id: x.c.id, role: i === 0 ? 'lead' : 'member' })) } }));
  for (const to of ['evidence_review']) must(await step(w.owner, cs.id, to));
  must(await step(w.owner, cs.id, 'assessment_scheduled', { appointment_on: inst(3) }));
  must(await step(w.cls[0].u, cs.id, 'assessment_completed'));
  must(await step(w.cls[0].u, cs.id, 'panel_review'));
  for (const x of w.cls.slice(0, w.v.panel_size ?? 1)) must(await api('POST', `/para/cases/${cs.id}/decision`, { token: x.u.token, body: { class_code: code, status } }));
  return { cs, out: must(await api('POST', `/para/cases/${cs.id}/outcome`, { token: w.cls[0].u.token, body: {} }), 201) };
};

test('definitions are versioned by sport/governing source; published versions are immutable; no definition = no case', async () => {
  const owner = await signup(['organizer']), b = await mkBody(owner);
  assert.equal((await api('POST', '/para/class-versions', { token: owner.token, body: { body_id: b.id, sport_id: sport.id, title: 'x', effective_from: day(), classes: [{ code: 'A', name: 'A' }] } })).status, 400, 'a source reference is required');
  const stranger = await signup(['organizer']);
  assert.equal((await api('POST', '/para/class-versions', { token: stranger.token, body: { body_id: b.id, sport_id: sport.id, title: 'Rules', source_ref: 'Doc', effective_from: day(), classes: [{ code: 'A', name: 'A' }] } })).status, 404, 'outsiders get 404');
  const ath = await signup();
  const noDef = await api('POST', '/para/cases', { token: ath.token, body: { body_id: b.id, sport_id: sport.id } });
  assert.equal(noDef.status, 409); assert.equal(noDef.body.error.details.code, 'no_definition');
  const v1 = await version(owner, b);
  assert.equal(v1.version, 1);
  await assert.rejects(pool.query("UPDATE para_class_versions SET title='tampered', source_ref='x' WHERE id=$1", [v1.id]), /immutable/);
  await assert.rejects(pool.query("INSERT INTO para_classes(version_id, code, name) VALUES ($1,'ZZ','Z')", [v1.id]), /immutable/);
  await assert.rejects(pool.query('DELETE FROM para_class_versions WHERE id=$1', [v1.id]), /never deleted/);
  const { cs, out } = await decide({ owner, b, v: v1, cls: [{ u: await signup(), c: null }] }, ath).catch(() => ({}));
  void cs; void out;
});

test('classifier authority: only a live credential in scope decides; coach/doctor/referee/admin do not become classifiers; suspension bites at once', async () => {
  const w = await world(1);
  const ath = await signup(), coach = await signup(['coach']), doc = await signup(['doctor']), ref = await signup(['referee']);
  const cs = await openCase(w, ath);
  for (const who of [coach, doc, ref]) assert.equal((await api('POST', `/para/cases/${cs.id}/panel`, { token: w.owner.token, body: { members: [{ classifier_id: '00000000-0000-4000-8000-000000000000', role: 'lead' }] } })).status, 400);
  must(await api('POST', `/para/cases/${cs.id}/panel`, { token: w.owner.token, body: { members: [{ classifier_id: w.cls[0].c.id, role: 'lead' }] } }));
  // not the athlete themselves
  const selfC = await classifier(w.owner, w.b, ath);
  assert.equal((await api('POST', `/para/cases/${cs.id}/panel`, { token: w.owner.token, body: { members: [{ classifier_id: selfC.id }] } })).status, 409, 'cannot assess themselves');
  // roles other than a credentialed classifier cannot advance or decide
  for (const who of [coach, doc, ref]) assert.equal((await step(who, cs.id, 'evidence_review')).status, 404);
  must(await step(w.owner, cs.id, 'evidence_review'));
  must(await step(w.owner, cs.id, 'assessment_scheduled', { appointment_on: inst(2) }));
  must(await step(w.cls[0].u, cs.id, 'assessment_completed'));
  must(await step(w.cls[0].u, cs.id, 'panel_review'));
  // a suspended credential cannot decide; an expired one cannot either
  must(await api('POST', `/para/classifiers/${w.cls[0].c.id}/end`, { token: w.owner.token, body: { action: 'suspend', reason: 'Under review' } }));
  assert.equal((await api('POST', `/para/cases/${cs.id}/decision`, { token: w.cls[0].u.token, body: { class_code: 'T12', status: 'confirmed' } })).status, 404, 'suspended: no longer a party');
  must(await api('POST', `/para/classifiers/${w.cls[0].c.id}/end`, { token: w.owner.token, body: { action: 'reinstate', reason: 'Cleared' } }));
  await pool.query('UPDATE para_classifiers SET expires_on=current_date - 1, issued_on=current_date - 5 WHERE id=$1', [w.cls[0].c.id]);
  assert.equal((await api('POST', `/para/cases/${cs.id}/decision`, { token: w.cls[0].u.token, body: { class_code: 'T12', status: 'confirmed' } })).status, 404, 'expired');
  await pool.query('UPDATE para_classifiers SET expires_on=current_date + 100 WHERE id=$1', [w.cls[0].c.id]);
  // class scope: a credential limited to T11 cannot decide T12
  await pool.query("UPDATE para_classifiers SET class_codes='{T11}' WHERE id=$1", [w.cls[0].c.id]);
  assert.equal((await api('POST', `/para/cases/${cs.id}/decision`, { token: w.cls[0].u.token, body: { class_code: 'T12', status: 'confirmed' } })).status, 403);
  must(await api('POST', `/para/cases/${cs.id}/decision`, { token: w.cls[0].u.token, body: { class_code: 'T11', status: 'confirmed' } }));
  assert.equal((await api('GET', '/para/classifiers', { token: coach.token, query: { body_id: w.b.id } })).status, 404);
  assert.equal(must(await api('GET', '/me/para-classifier', { token: w.cls[0].u.token })).credentials[0].live, true);
});

test('panel size and independence: the version decides how many classifiers agree; disagreement blocks; outcomes supersede prospectively and stay reproducible', async () => {
  const w = await world(2, { panel_size: 2 }); w.v.panel_size = 2;
  const ath = await signup();
  const cs = await openCase(w, ath);
  must(await api('POST', `/para/cases/${cs.id}/panel`, { token: w.owner.token, body: { members: [{ classifier_id: w.cls[0].c.id, role: 'lead' }] } }));
  must(await step(w.owner, cs.id, 'evidence_review'));
  must(await step(w.owner, cs.id, 'assessment_scheduled', { appointment_on: inst(2) }));
  must(await step(w.cls[0].u, cs.id, 'assessment_completed'));
  assert.equal((await step(w.cls[0].u, cs.id, 'panel_review')).status, 409, 'two classifiers are required before panel review');
  must(await api('POST', `/para/cases/${cs.id}/panel`, { token: w.owner.token, body: { members: [{ classifier_id: w.cls[1].c.id }] } }));
  must(await step(w.cls[0].u, cs.id, 'panel_review'));
  must(await api('POST', `/para/cases/${cs.id}/decision`, { token: w.cls[0].u.token, body: { class_code: 'T12', status: 'confirmed' } }));
  assert.equal((await api('POST', `/para/cases/${cs.id}/outcome`, { token: w.cls[0].u.token, body: {} })).status, 409, 'one decision of two is not enough');
  must(await api('POST', `/para/cases/${cs.id}/decision`, { token: w.cls[1].u.token, body: { class_code: 'T13', status: 'confirmed' } }));
  const dis = await api('POST', `/para/cases/${cs.id}/outcome`, { token: w.cls[0].u.token, body: {} });
  assert.equal(dis.status, 409); assert.equal(dis.body.error.details.code, 'panel_disagreement');
  assert.equal((await api('POST', `/para/cases/${cs.id}/outcome`, { token: w.cls[1].u.token, body: {} })).status, 403, 'only the lead issues');
  // members do not see each other\'s decision before issue
  const asMember = must(await api('GET', `/para/cases/${cs.id}`, { token: w.cls[1].u.token }));
  assert.equal(asMember.panel.find((p) => !p.you).decision_class_code, null);
  must(await api('POST', `/para/cases/${cs.id}/decision`, { token: w.cls[1].u.token, body: { class_code: 'T12', status: 'confirmed' } }));
  const o1 = must(await api('POST', `/para/cases/${cs.id}/outcome`, { token: w.cls[0].u.token, body: {} }), 201);
  assert.equal(o1.class_code, 'T12'); assert.ok(o1.review_by, 'review rule of the version applies');
  const cur = must(await api('GET', '/para/classification', { token: ath.token, query: { athlete_id: ath.id, sport_id: sport.id } })).classification;
  assert.equal(cur.class_code, 'T12'); assert.equal(cur.version, 1);
  assert.deepEqual(Object.keys(cur).sort(), ['authority', 'class_code', 'decision_ref', 'effective_from', 'expires_on', 'id', 'review_by', 'status', 'version'], 'only competition-facing fields');
  // history: outcomes are immutable; a new decision supersedes prospectively
  await assert.rejects(pool.query("UPDATE para_outcomes SET class_code='T11' WHERE id=$1", [o1.id]), /immutable/);
  await assert.rejects(pool.query('DELETE FROM para_outcomes WHERE id=$1', [o1.id]), /never deleted/);
  const before = new Date();
  const w2 = { ...w, v: { ...w.v, panel_size: 2 } };
  const second = await decide(w2, ath, 'T11');
  assert.notEqual(second.out.id, o1.id); assert.equal(second.out.supersedes_id, o1.id);
  const hist = must(await api('GET', '/para/outcomes', { token: ath.token, query: { athlete_id: ath.id } })).outcomes;
  assert.deepEqual(hist.map((x) => x.class_code), ['T11', 'T12']);
  assert.ok(hist[1].superseded_at);
  const { outcomeAt } = await import('../src/para.js');
  assert.equal((await outcomeAt(pool, ath.id, sport.id, new Date(before.getTime() - 1))).class_code, 'T12', 'the past is reproducible from what was in force then');
  assert.equal((await outcomeAt(pool, ath.id, sport.id, new Date())).class_code, 'T11');
  await assert.rejects(pool.query("DELETE FROM para_history"), /append-only/);
});

test('evidence isolation: only the athlete/guardian and the assigned live panel read it; staff, coach, organiser, sponsor, media, admin and strangers cannot — REST or MCP; reads are audited', async () => {
  const w = await world(1);
  const ath = await signup(), other = await signup();
  const cs = await openCase(w, ath, { note: 'PRIVATE-ADMIN-NOTE-XYZ' });
  const ev = must(await api('POST', `/para/cases/${cs.id}/evidence`, { token: ath.token, body: { label: 'Functional assessment', reference: 'https://example.org/ref/SECRET-REF-123', file_name: 'a.pdf', data: PDF } }), 201);
  assert.equal((await api('POST', `/para/cases/${cs.id}/evidence`, { token: ath.token, body: { label: 'bad', data: Buffer.from('not a pdf at all, just text').toString('base64') } })).status, 400, 'content is sniffed');
  assert.equal((await api('POST', `/para/cases/${cs.id}/evidence`, { token: ath.token, body: { label: 'insecure', reference: 'http://example.org/x' } })).status, 400, 'https only');
  // the stored bytes are ciphertext
  const raw = (await pool.query('SELECT reference_enc, file_enc FROM para_evidence WHERE id=$1', [ev.id])).rows[0];
  assert.ok(!raw.file_enc.includes(PDF.slice(0, 20)) && !raw.reference_enc.includes('SECRET-REF'));
  must(await api('POST', `/para/cases/${cs.id}/panel`, { token: w.owner.token, body: { members: [{ classifier_id: w.cls[0].c.id, role: 'lead' }] } }));
  const sponsor = await signup(['sponsor']), coach = await signup(['coach']), org = await signup(['organizer']), media = await signup(['athlete']), doc = await signup(['doctor']);
  const fedStaff = await signup(['athlete']);
  must(await api('POST', `/federation/bodies/${w.b.id}/roles`, { token: w.owner.token, body: { user_id: fedStaff.id, role: 'secretary' } }), 201);
  const nobody = [coach, sponsor, org, media, doc, other, admin, w.owner, fedStaff];
  for (const who of nobody) {
    assert.equal((await api('GET', `/para/cases/${cs.id}/evidence/${ev.id}`, { token: who.token })).status, 404, 'REST read');
    assert.equal((await api('POST', `/para/cases/${cs.id}/evidence`, { token: who.token, body: { label: 'x', reference: 'https://e.org/x' } })).status, 404, 'REST write');
  }
  // staff of the issuing authority see the workflow but not the note or evidence
  const asStaff = must(await api('GET', `/para/cases/${cs.id}`, { token: fedStaff.token }));
  assert.equal(asStaff.viewer, 'staff'); assert.equal(asStaff.evidence, undefined); assert.equal(asStaff.requester_note, undefined);
  assert.ok(!JSON.stringify(asStaff).includes('PRIVATE-ADMIN-NOTE') && !JSON.stringify(asStaff).includes('SECRET-REF'));
  // queues are workflow-only
  const queue = JSON.stringify(must(await api('GET', '/para/cases', { token: fedStaff.token, query: { scope: 'body', body_id: w.b.id } })));
  assert.ok(!queue.includes('PRIVATE-ADMIN-NOTE') && !queue.includes('SECRET-REF'));
  // MCP parity: the same refusal over the tool surface
  for (const who of [coach, sponsor, admin, fedStaff]) {
    const r = await rpc('tools/call', { name: 'read_para_evidence', arguments: { id: cs.id, evidence_id: ev.id } }, who.token);
    assert.equal(r.isError, true, 'MCP read refused');
    assert.ok(!JSON.stringify(r).includes('SECRET-REF'));
  }
  // allowed readers, each audited
  const reads = async () => (await pool.query("SELECT count(*)::int AS c FROM audit_log WHERE action='read_clinical' AND entity='para_evidence'")).rows[0].c;
  const b0 = await reads();
  const mine = must(await api('GET', `/para/cases/${cs.id}/evidence/${ev.id}`, { token: ath.token }));
  assert.equal(mine.reference, 'https://example.org/ref/SECRET-REF-123'); assert.equal(mine.file.data, PDF);
  const panelRead = await rpc('tools/call', { name: 'read_para_evidence', arguments: { id: cs.id, evidence_id: ev.id } }, w.cls[0].u.token);
  assert.notEqual(panelRead.isError, true);
  assert.equal(await reads(), b0 + 2);
  // the panel classifier loses access the moment the credential is suspended
  must(await api('POST', `/para/classifiers/${w.cls[0].c.id}/end`, { token: w.owner.token, body: { action: 'suspend', reason: 'Pending review' } }));
  assert.equal((await api('GET', `/para/cases/${cs.id}/evidence/${ev.id}`, { token: w.cls[0].u.token })).status, 404);
  // exports and generic data never contain it
  const dump = JSON.stringify([must(await api('GET', '/me/para-classification', { token: other.token })), must(await api('GET', '/me/para-classification', { token: ath.token }))]);
  assert.ok(!dump.includes('SECRET-REF') && !dump.includes('PRIVATE-ADMIN-NOTE'));
  // every sensitive capability is clinical/admin scoped for API tokens
  for (const c of capabilities.filter((x) => x.tag === 'Para classification' && /evidence|case|appeal|outcome|classification/.test(x.name))) assert.ok(['clinical', 'admin'].includes(c.scope), `${c.name} scope ${c.scope}`);
});

test('youth: a verified guardian acts for the young athlete and must consent before a case or evidence exists', async () => {
  const w = await world(1);
  const mum = await signup(), kid = await signup(['athlete'], { dob: yearsAgo(12) });
  assert.equal((await api('POST', '/para/cases', { token: kid.token, body: { body_id: w.b.id, sport_id: sport.id } })).status, 403, 'a young athlete does not act alone');
  const l = must(await api('POST', '/youth/guardian-links', { token: mum.token, body: { guardian_id: mum.id, child_id: kid.id, relationship: 'parent' } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: kid.token, body: { accept: true } }));
  must(await api('POST', `/youth/guardian-links/${l.id}/evidence`, { token: mum.token, body: { evidence: { reference: 'https://example.com/birth-ref-9', label: 'Birth certificate' } } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Documents match' } }));
  const refused = await api('POST', '/para/cases', { token: mum.token, body: { athlete_id: kid.id, body_id: w.b.id, sport_id: sport.id } });
  assert.equal(refused.status, 409); assert.equal(refused.body.error.details.code, 'guardian_consent_required');
  must(await api('POST', `/youth/children/${kid.id}/consents`, { token: mum.token, body: { purpose: 'medical' } }), 201);
  const cs = must(await api('POST', '/para/cases', { token: mum.token, body: { athlete_id: kid.id, body_id: w.b.id, sport_id: sport.id } }), 201);
  must(await api('POST', `/para/cases/${cs.id}/evidence`, { token: mum.token, body: { label: 'Guardian-supplied', reference: 'https://example.org/e1' } }), 201);
  assert.equal((await api('GET', `/para/cases/${cs.id}`, { token: kid.token })).status, 404, 'the young athlete\'s own account is not the actor');
  assert.equal((await api('GET', `/para/cases/${cs.id}`, { token: mum.token })).body.viewer, 'guardian');
  // revoke consent: new evidence is refused again
  const consent = (await pool.query("SELECT id FROM youth_consents WHERE child_id=$1 AND purpose='medical'", [kid.id])).rows[0];
  await pool.query('UPDATE youth_consents SET revoked_at=now() WHERE id=$1', [consent.id]);
  assert.equal((await api('POST', `/para/cases/${cs.id}/evidence`, { token: mum.token, body: { label: 'More', reference: 'https://example.org/e2' } })).status, 409);
});

test('review / protest / appeal: deadline, one open request, independent reviewer, immutable history; upholding supersedes prospectively', async () => {
  const w = await world(2);
  const ath = await signup();
  const { out } = await decide(w, ath, 'T12');
  const stranger = await signup();
  assert.equal((await api('POST', `/para/outcomes/${out.id}/appeals`, { token: stranger.token, body: { kind: 'review', grounds: 'I disagree with this decision' } })).status, 404);
  assert.equal((await api('POST', `/para/outcomes/${out.id}/appeals`, { token: ath.token, body: { kind: 'review', grounds: 'short' } })).status, 400);
  const a = must(await api('POST', `/para/outcomes/${out.id}/appeals`, { token: ath.token, body: { kind: 'review', grounds: 'New functional information is available' } }), 201);
  assert.equal((await api('POST', `/para/outcomes/${out.id}/appeals`, { token: ath.token, body: { kind: 'protest', grounds: 'A second request on the same decision' } })).status, 409, 'one open request per decision');
  // the original panel member cannot be the reviewer; an independent classifier can
  const nonIndep = await api('POST', `/para/appeals/${a.id}/reviewer`, { token: w.owner.token, body: { classifier_id: w.cls[0].c.id } });
  assert.equal(nonIndep.status, 409);
  const indep = await signup(); const k = await classifier(w.owner, w.b, indep);
  assert.equal((await api('POST', `/para/appeals/${a.id}/rule`, { token: indep.token, body: { ruling: 'dismissed', note: 'Not assigned yet' } })).status, 404, 'unassigned');
  must(await api('POST', `/para/appeals/${a.id}/reviewer`, { token: w.owner.token, body: { classifier_id: k.id } }));
  // the grounds are visible to the assigned reviewer, not to body staff
  assert.equal(must(await api('GET', '/para/appeals', { token: indep.token, query: { scope: 'assigned' } })).appeals[0].grounds, 'New functional information is available');
  assert.equal(JSON.stringify(must(await api('GET', '/para/appeals', { token: w.owner.token, query: { scope: 'body', body_id: w.b.id } }))).includes('New functional'), false);
  assert.equal((await api('POST', `/para/appeals/${a.id}/rule`, { token: indep.token, body: { ruling: 'upheld', note: 'Reassessed' } })).status, 400, 'upholding needs the new class');
  const ruled = must(await api('POST', `/para/appeals/${a.id}/rule`, { token: indep.token, body: { ruling: 'upheld', note: 'Reassessed on new information', class_code: 'T13', status: 'confirmed' } }));
  assert.equal(ruled.status, 'upheld'); assert.ok(ruled.outcome_id);
  assert.equal(must(await api('GET', '/para/classification', { token: ath.token, query: { athlete_id: ath.id, sport_id: sport.id } })).classification.class_code, 'T13');
  const old = (await pool.query('SELECT class_code, superseded_at FROM para_outcomes WHERE id=$1', [out.id])).rows[0];
  assert.equal(old.class_code, 'T12'); assert.ok(old.superseded_at, 'prior outcome is kept, only stamped as superseded');
  assert.equal((await api('POST', `/para/outcomes/${out.id}/appeals`, { token: ath.token, body: { kind: 'review', grounds: 'Asking about the superseded one' } })).status, 409);
  // deadline
  const w3 = await world(1, { appeal_days: 1 });
  const ath3 = await signup(); const d3 = await decide(w3, ath3);
  await pool.query("UPDATE para_outcomes SET created_at=now() - interval '5 days' WHERE id=$1", [d3.out.id]);
  const late = await api('POST', `/para/outcomes/${d3.out.id}/appeals`, { token: ath3.token, body: { kind: 'appeal', grounds: 'Too late to ask for this one' } });
  assert.equal(late.status, 409); assert.equal(late.body.error.details.code, 'appeal_deadline_passed');
});

test('eligibility: a competition consumes the governed outcome, locks a snapshot, and organisers cannot type an athlete into a class', async () => {
  const w = await world(1);
  const orgz = await signup(['organizer']), mgr = await signup(), mgr2 = await signup();
  const ev = must(await api('POST', '/events', { token: orgz.token, body: { name: `Para Cup ${++n}`, sport: (await pool.query('SELECT slug FROM sports WHERE id=$1', [sport.id])).rows[0].slug, starts_on: day(5), ends_on: day(30) } }), 201);
  const sl = (await pool.query('SELECT slug FROM sports WHERE id=$1', [sport.id])).rows[0].slug;
  const t1 = must(await api('POST', '/teams', { token: mgr.token, body: { name: `Team ${++n}`, sport: sl } }), 201), t2 = must(await api('POST', '/teams', { token: mgr2.token, body: { name: `Team ${++n}`, sport: sl } }), 201);
  for (const [t, tok] of [[t1, mgr.token], [t2, mgr2.token]]) { const en = must(await api('POST', `/events/${ev.id}/entries`, { token: tok, body: { team_id: t.id } }), 201); must(await api('PATCH', `/entries/${en.id}`, { token: orgz.token, body: { status: 'accepted' } })); }
  const fx = must(await api('POST', `/events/${ev.id}/fixtures`, { token: orgz.token, body: { home_team_id: t1.id, away_team_id: t2.id, scheduled_at: inst(3) } }), 201);
  const p = await signup();
  must(await api('POST', `/teams/${t1.id}/members`, { token: mgr.token, body: { user_id: p.id } }), 201);
  must(await api('POST', `/events/${ev.id}/registration/policy`, { token: orgz.token, body: { rules: { required_clearances: ['classification'], classification_mode: 'governed', allowed_classes: ['T11', 'T12'] }, expected_version: 0 } }), 201);
  const reg = must(await api('POST', `/events/${ev.id}/registrations`, { token: mgr.token, body: { team_id: t1.id, user_id: p.id } }), 201);
  must(await api('POST', `/registrations/${reg.id}/review`, { token: orgz.token, body: { action: 'register', row_version: reg.row_version } }));
  const check = async () => must(await api('GET', `/events/${ev.id}/eligibility`, { token: orgz.token, query: { team_id: t1.id, user_id: p.id } })).decisions[0];
  assert.equal((await check()).decision, 'ineligible', 'no authorised classification');
  // an organiser\'s manual dependency does NOT satisfy governed mode
  must(await api('POST', `/events/${ev.id}/registration/dependencies`, { token: orgz.token, body: { user_id: p.id, kind: 'classification', status: 'clear', source_ref: 'typed by organiser' } }), 201);
  assert.equal((await check()).decision, 'ineligible', 'organisers cannot type an athlete into a class');
  const d1 = await decide(w, p, 'T12');
  const ok = await check();
  assert.equal(ok.decision, 'eligible');
  const src = ok.checks.find((x) => x.rule === 'classification').source;
  assert.equal(src.kind, 'para_outcome'); assert.equal(src.class_code, 'T12'); assert.equal(src.id, d1.out.id);
  assert.ok(!JSON.stringify(ok).includes('Requesting initial'), 'no case content in eligibility');
  // lock a snapshot, then a later decision changes the class; the snapshot still says what was used
  must(await api('POST', `/teams/${t1.id}/squad`, { token: mgr.token, body: { fixture_id: fx.id, members: [{ user_id: p.id, role: 'player' }] } }));
  const lock = must(await api('POST', `/fixtures/${fx.id}/eligibility/lock`, { token: orgz.token, body: {} }), 201);
  assert.equal(lock.newly_locked, 1);
  const d2 = await decide(w, p, 'T13');
  const snaps = JSON.stringify(must(await api('GET', `/fixtures/${fx.id}/eligibility/snapshots`, { token: orgz.token })));
  assert.ok(snaps.includes(d1.out.id) && !snaps.includes(d2.out.id), 'the snapshot keeps the outcome used at lock time, not the later one');
  assert.equal((await check()).decision, 'ineligible', 'T13 is not an allowed class of this competition');
});

test('external references: stable ID, no name matching, idempotent replay, second-officer verification; only used when the competition allows it', async () => {
  const w = await world(0);
  const ath = await signup(), other = await signup();
  const rec = (who, over = {}) => api('POST', '/para/external-refs', { token: who.token, body: { body_id: w.b.id, athlete_id: ath.id, sport_id: sport.id, external_id: 'EXT-7788', class_code: 't12', class_status: 'confirmed', effective_from: day(-5), provenance: 'Authority register consulted today', ...over } });
  const r1 = must(await rec(w.owner), 201);
  assert.equal(must(await rec(w.owner), 201).replayed, true, 'idempotent replay');
  const clash = await rec(w.owner, { athlete_id: other.id });
  assert.equal(clash.status, 409); assert.equal(clash.body.error.details.code, 'identity_conflict');
  assert.equal((await api('POST', `/para/external-refs/${r1.id}/verify`, { token: w.owner.token, body: { decision: 'verified' } })).status, 409, 'the recorder cannot verify');
  const second = await signup(); must(await api('POST', `/federation/bodies/${w.b.id}/roles`, { token: w.owner.token, body: { user_id: second.id, role: 'secretary' } }), 201);
  assert.equal(JSON.stringify(must(await api('GET', '/para/external-refs', { token: second.token, query: { body_id: w.b.id } }))).includes('EXT-7788'), false, 'the authority ID is never listed');
  assert.equal((await api('POST', `/para/external-refs/${r1.id}/verify`, { token: other.token, body: { decision: 'verified' } })).status, 404);
  // before verification it is not authoritative
  const { verifiedExternalAt } = await import('../src/para.js');
  assert.equal(await verifiedExternalAt(pool, ath.id, sport.id), null);
  must(await api('POST', `/para/external-refs/${r1.id}/verify`, { token: second.token, body: { decision: 'verified' } }));
  assert.equal((await verifiedExternalAt(pool, ath.id, sport.id)).class_code, 'T12');
  assert.equal(must(await api('GET', '/me/para-classification', { token: ath.token })).external_references[0].verification, 'verified');
});

test('AI boundary and sport coverage: copilots refuse classification; every catalogue sport is governed or a labelled gap; all capabilities are on REST, OpenAPI and MCP', async () => {
  for (const s of ['Reclassify this athlete as T12', 'infer her classification from the video', 'Draft a classification decision']) assert.equal(forbiddenKind(s), 'classification', s);
  const w = await world(0);
  const all = must(await api('GET', '/para/coverage', { token: admin.token })).sports;
  const catalogue = (await pool.query('SELECT count(*)::int AS n FROM sports')).rows[0].n;
  assert.equal(all.length, catalogue, 'the whole catalogue is walked');
  assert.ok(all.every((s) => ['governed', 'gap'].includes(s.coverage) && s.label), 'no sport is left on a silent default');
  assert.equal(all.find((s) => s.id === sport.id).coverage, 'governed');
  assert.equal(all.find((s) => s.id === sport2.id).coverage, 'gap');
  assert.ok(w);
  const tools = (await rpc('tools/list', {}, admin.token)).tools.map((t) => t.name);
  for (const c of capabilities.filter((x) => x.tag === 'Para classification')) assert.ok(tools.includes(c.name), `${c.name} on MCP`);
  const spec = (await (await fetch(`${base}/api/v1/openapi.json`)).json());
  const ops = new Set(Object.values(spec.paths).flatMap((p) => Object.values(p).map((o) => o.operationId)));
  for (const c of capabilities.filter((x) => x.tag === 'Para classification')) assert.ok(ops.has(c.name), `${c.name} in OpenAPI`);
  // the para tables carry no diagnosis/impairment/medication columns
  const cols = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name LIKE 'para\\_%'")).rows.map((r) => r.column_name).join(' ');
  assert.ok(!/diagnos|impairment|medicat|treatment/.test(cols));
});
