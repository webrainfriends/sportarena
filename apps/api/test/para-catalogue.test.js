// PS-01 (#831) Governed para-sport catalogue: one catalogue, governed versions with source evidence, approval/rollback/deprecation, event pins with frozen snapshots,
// recreational/mixed-ability without classification, permissions, REST/MCP parity and regression of the standard sports.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { capabilities } = await import('../src/registry.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: r.status, body: parsed };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const day = (o = 0) => new Date(Date.now() + o * 864e5).toISOString().slice(0, 10);
const signup = async (roles = ['organizer']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `ps_${n}_${roles[0]}`, display_name: `Ps ${n}`, email: `ps${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const sport = async (slug) => (await pool.query('SELECT id, slug FROM sports WHERE slug=$1', [slug])).rows[0];

before(async () => { await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); await migrate(); server = createApp().listen(0); base = `http://localhost:${server.address().port}`; });
after(async () => { server.close(); await pool.end(); });

const GOV = { source_url: 'https://example.org/rules.pdf', publisher: 'Test International Federation', scope_countries: ['sg', 'in'], event_categories: ['Men 100m', 'Women 100m'], adaptations: ['Guide runner'], permitted_roles: ['guide'], classification_required: true };
const body = async (owner, sl) => must(await api('POST', '/federation/bodies', { token: owner.token, body: { name: `Para Fed ${++n}`, level: 'international', abbreviation: `PG${String(n).padStart(3, '0')}`, sports: [{ sport_id: sl.id }] } }), 201);
const draft = async (owner, b, sl, over = {}) => must(await api('POST', '/para/class-versions', { token: owner.token, body: { body_id: b.id, sport_id: sl.id, title: 'Para rules', source_ref: 'Rulebook §1', effective_from: day(-5), classes: [{ code: 'T11', name: 'T11' }, { code: 'T12', name: 'T12' }], ...GOV, ...over } }), 201);
const approve = async (owner, v) => { must(await api('POST', `/para/class-versions/${v.id}/submit`, { token: owner.token })); return must(await api('POST', `/para/class-versions/${v.id}/publish`, { token: owner.token })); };

test('one catalogue: 34 para sports imported once, flagged, filterable; legacy sports unaffected', async () => {
  const all = must(await api('GET', '/sports'));
  const para = must(await api('GET', '/sports', { query: { para: 'true' } }));
  assert.equal(para.length, 34); assert.ok(para.every((s) => s.is_para));
  for (const slug of ['para-athletics', 'para-swimming', 'para-badminton', 'wheelchair-basketball', 'boccia', 'goalball', 'blind-football', 'sitting-volleyball']) assert.ok(para.some((s) => s.slug === slug), slug);
  assert.equal(must(await api('GET', '/sports', { query: { para: 'false' } })).length, all.length - 34);
  assert.ok(all.some((s) => s.slug === 'athletics' && !s.is_para), 'standard athletics untouched');
  assert.equal(must(await api('GET', '/sports', { query: { programme: 'paralympic_winter' } })).length, 6);
  assert.equal((await pool.query("SELECT count(*)::int n FROM sports WHERE slug IN ('boccia','sitting-volleyball','wheelchair-basketball')")).rows[0].n, 3, 'pre-existing rows flagged, not duplicated');
  const viewer = await signup(['athlete']);
  const cov = must(await api('GET', '/para/coverage', { token: viewer.token, query: { para: 'true' } }));
  assert.equal(cov.summary.para_sports, 34); assert.equal(cov.summary.gap, 34);
  assert.ok(cov.sports.every((s) => s.state === 'gap' && /No governing definition/.test(s.label)), 'no rules invented by the import');
  assert.equal((await pool.query('SELECT count(*)::int n FROM para_class_versions')).rows[0].n, 0);
});

test('governed version: evidence, submit → publish, immutability, rejection, rollback and deprecation keep history', async () => {
  const owner = await signup(), sl = await sport('para-athletics'), b = await body(owner, sl);
  assert.equal((await api('POST', '/para/class-versions', { token: owner.token, body: { body_id: b.id, sport_id: sl.id, title: 'x', source_ref: 'r', effective_from: day(), source_url: 'ftp://nope', classes: [{ code: 'A', name: 'A' }] } })).status, 400, 'https source only');
  const v1 = await draft(owner, b, sl);
  assert.equal((await api('POST', `/para/class-versions/${v1.id}/publish`, { token: owner.token })).status, 409, 'a sourced version is approved first');
  const stranger = await signup();
  assert.equal((await api('POST', `/para/class-versions/${v1.id}/submit`, { token: stranger.token })).status, 404);
  const noSrc = await draft(owner, b, sl, { source_url: undefined, publisher: undefined });
  assert.equal((await api('POST', `/para/class-versions/${noSrc.id}/submit`, { token: owner.token })).status, 400, 'source + publisher required to submit');
  await approve(owner, v1);
  const sportView = must(await api('GET', '/para/sports/para-athletics'));
  assert.equal(sportView.sport.state, 'governed');
  const pv = sportView.versions[0];
  assert.equal(pv.source_url, GOV.source_url); assert.equal(pv.publisher, GOV.publisher); assert.deepEqual(pv.scope_countries, ['SG', 'IN']); assert.deepEqual(pv.permitted_roles, ['guide']);
  assert.ok(pv.rule_ref.hash && pv.history.map((h) => h.action).includes('submitted'));
  assert.equal(JSON.stringify(sportView).includes(owner.id), false, 'no actor identities in discovery');
  await assert.rejects(pool.query("UPDATE para_class_versions SET source_url='https://evil.example' WHERE id=$1", [v1.id]), /immutable/);
  // rejection path
  const v2 = await draft(owner, b, sl, { title: 'Para rules v2' });
  must(await api('POST', `/para/class-versions/${v2.id}/submit`, { token: owner.token }));
  must(await api('POST', `/para/class-versions/${v2.id}/reject`, { token: owner.token, body: { reason: 'Wrong edition' } }));
  assert.equal((await api('POST', `/para/class-versions/${v2.id}/publish`, { token: owner.token })).status, 409);
  // publish v3, then roll back to v1 (a new version), then deprecate
  const v3 = await draft(owner, b, sl, { title: 'Para rules v3' }); await approve(owner, v3);
  assert.equal((await pool.query('SELECT status FROM para_class_versions WHERE id=$1', [v1.id])).rows[0].status, 'retired');
  const rb = must(await api('POST', `/para/class-versions/${v1.id}/rollback`, { token: owner.token, body: { reason: 'v3 withdrawn', effective_from: day(0) } }), 201);
  assert.equal(rb.status, 'draft'); assert.equal(rb.restores, v1.id); assert.ok(rb.version > 3);
  assert.equal((await api('POST', `/para/class-versions/${v3.id}/rollback`, { token: owner.token, body: { reason: 'nope', effective_from: day() } })).status, 409, 'only retired versions are restored');
  const copied = (await pool.query('SELECT count(*)::int n FROM para_classes WHERE version_id=$1', [rb.id])).rows[0].n; assert.equal(copied, 2);
  must(await api('POST', `/para/class-versions/${v3.id}/deprecate`, { token: owner.token, body: { reason: 'Superseded by federation notice' } }));
  assert.equal(must(await api('GET', '/para/sports/para-athletics')).sport.state, 'awaiting');
  assert.equal((await pool.query("SELECT count(*)::int n FROM para_history WHERE subject_id=$1", [v3.id])).rows[0].n >= 3, true);
  await assert.rejects(pool.query('DELETE FROM para_class_versions WHERE id=$1', [v1.id]), /never deleted/);
});

test('events: sanctioned pins an approved version with a frozen snapshot; changes need a reason; recreational/mixed need no classification', async () => {
  const owner = await signup(), sl = await sport('para-swimming'), b = await body(owner, sl);
  const v1 = await draft(owner, b, sl, { event_categories: ['S1', 'S2'] });
  const org = await signup();
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: 'Para Meet', sport: 'multi-sport', kind: 'tournament', starts_on: day(5), ends_on: day(5) } }), 201);
  must(await api('PATCH', `/events/${ev.id}/programme`, { token: org.token, body: {} }));
  const mk = (over) => api('POST', `/events/${ev.id}/disciplines`, { token: org.token, body: { sport: 'para-swimming', name: `D${++n}`, ...over } });
  assert.equal((await mk({ participation_context: 'sanctioned' })).status, 400, 'a version is mandatory');
  assert.equal((await mk({ participation_context: 'sanctioned', para_version_id: v1.id })).status, 409, 'an unapproved version cannot be pinned');
  await approve(owner, v1);
  assert.equal((await mk({ participation_context: 'sanctioned', para_version_id: v1.id, para_categories: ['S9'] })).status, 400, 'categories come from the version');
  const d = must(await mk({ participation_context: 'sanctioned', para_version_id: v1.id, para_categories: ['S1'] }), 201);
  assert.equal(d.participation_context, 'sanctioned'); assert.equal(d.para_snapshot.version_id, v1.id); assert.ok(d.para_snapshot_hash);
  assert.equal(d.para_snapshot.classification_required, true);
  // standard sport cannot carry a para context
  const std = await api('POST', `/events/${ev.id}/disciplines`, { token: org.token, body: { sport: 'athletics', name: 'Std', participation_context: 'sanctioned', para_version_id: v1.id } });
  assert.equal(std.status, 400);
  // a newer version does not rewrite the pinned event
  const v2 = await draft(owner, b, sl, { title: 'Para rules v2', event_categories: ['S1'] }); await approve(owner, v2);
  const after2 = (await pool.query('SELECT para_snapshot, para_snapshot_hash, para_version_id FROM event_disciplines WHERE id=$1', [d.id])).rows[0];
  assert.equal(after2.para_version_id, v1.id); assert.equal(after2.para_snapshot_hash, d.para_snapshot_hash);
  // no silent override
  assert.equal((await api('PATCH', `/disciplines/${d.id}`, { token: org.token, body: { para_version_id: v2.id } })).status, 400, 'reason required');
  assert.equal((await api('PATCH', `/disciplines/${d.id}`, { token: org.token, body: { para_version_id: v2.id, para_change_reason: 'Federation moved to the new edition' } })).status, 200);
  assert.ok((await pool.query("SELECT count(*)::int n FROM para_history WHERE subject_type='event_discipline' AND subject_id=$1", [d.id])).rows[0].n >= 2);
  const stranger = await signup();
  assert.equal((await api('PATCH', `/disciplines/${d.id}`, { token: stranger.token, body: { participation_context: 'recreational', para_change_reason: 'hijack' } })).status, 403);
  await pool.query("UPDATE event_disciplines SET status='ongoing' WHERE id=$1", [d.id]);
  assert.equal((await api('PATCH', `/disciplines/${d.id}`, { token: org.token, body: { para_version_id: v1.id, para_change_reason: 'too late' } })).status, 409, 'a running discipline keeps its rules');
  // recreational + mixed ability: no version, no classification
  for (const ctx of ['recreational', 'mixed_ability']) { const r = must(await mk({ participation_context: ctx }), 201); assert.equal(r.para_version_id, null); assert.equal(r.para_snapshot, null); }
  assert.equal((await mk({ participation_context: 'recreational', para_version_id: '00000000-0000-4000-8000-000000000000' })).status, 400);
  // standard disciplines (legacy) unchanged
  const legacy = must(await api('POST', `/events/${ev.id}/disciplines`, { token: org.token, body: { sport: 'athletics', name: 'Legacy 100m' } }), 201);
  assert.equal(legacy.participation_context, 'standard');
  assert.equal(must(await api('GET', `/events/${ev.id}/disciplines`)).find((x) => x.id === d.id).participation_context, 'sanctioned');
});

test('MCP/REST parity and OpenAPI for the new capabilities', async () => {
  const names = ['submit_para_class_version', 'reject_para_class_version', 'rollback_para_class_version', 'deprecate_para_class_version', 'get_para_sport', 'para_sport_coverage'];
  for (const nm of names) assert.ok(capabilities.some((c) => c.name === nm), nm);
  const spec = must(await api('GET', '/openapi.json'));
  assert.ok(spec.paths['/para/sports/{sport}'] && spec.paths['/para/class-versions/{id}/rollback']);
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  const tools = (await r.json()).result.tools.map((t) => t.name);
  for (const nm of names) assert.ok(tools.includes(nm), `${nm} exposed over MCP`);
  assert.equal((await api('GET', '/para/sports/athletics')).status, 404, 'a standard sport is not a para sport');
  assert.equal((await api('POST', '/para/class-versions/00000000-0000-4000-8000-000000000000/submit')).status, 401);
});

test('nomination: a sanctioned discipline whose pinned rule requires classification admits only a governed class; other contexts are never asked', async () => {
  const owner = await signup(), sl = await sport('para-swimming'), b = await body(owner, sl);
  const v1 = await draft(owner, b, sl, { event_categories: ['S1'], classes: [{ code: 'S1', name: 'S1' }, { code: 'S2', name: 'S2' }] }); await approve(owner, v1);
  const vNo = await draft(owner, b, sl, { title: 'Rules without classification', discipline: 'Open water', classification_required: false }); await approve(owner, vNo);
  const org = await signup();
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: 'Para Nominations', sport: 'multi-sport', kind: 'tournament', starts_on: day(5), ends_on: day(5) } }), 201);
  must(await api('PATCH', `/events/${ev.id}/programme`, { token: org.token, body: {} }));
  const disc = async (over) => must(await api('POST', `/events/${ev.id}/disciplines`, { token: org.token, body: { sport: 'para-swimming', name: `N${++n}`, ...over } }), 201);
  const person = async (account) => must(await api('POST', `/events/${ev.id}/participants`, { token: org.token, body: { full_name: `P${++n}`, grade: '7', gender: 'male', roll_no: `R${n}`, ...(account ? { user_id: account.id } : {}) } }), 201);
  const nom = (d, p) => api('POST', `/disciplines/${d.id}/nominations`, { token: org.token, body: { participant_id: p.id } });
  const sanctioned = await disc({ participation_context: 'sanctioned', para_version_id: v1.id });
  const noClass = await disc({ participation_context: 'sanctioned', para_version_id: vNo.id });
  const rec = await disc({ participation_context: 'recreational' }), mixed = await disc({ participation_context: 'mixed_ability' }), std = await disc({});
  const athlete = await signup(['athlete']);
  const linked = await person(athlete), unlinked = await person(null);
  // no governed class on record: blocked with a stable code; unlinked participant cannot be checked
  let r = await nom(sanctioned, linked); assert.equal(r.status, 409); assert.equal(r.body.error.details.code, 'classification_required'); assert.match(r.body.error.message, /No authorised classification/);
  r = await nom(sanctioned, unlinked); assert.equal(r.status, 409); assert.equal(r.body.error.details.check, 'classification.no_account');
  // the rule that does not require classification, recreational, mixed-ability and standard disciplines never ask
  for (const d of [noClass, rec, mixed, std]) assert.equal((await nom(d, await person(null))).status, 201, `${d.participation_context} admits without classification`);
  // a governed class outside the version is refused; a class of the version is admitted
  const ids = (await pool.query('SELECT id, body_id FROM para_class_versions WHERE id=$1', [v1.id])).rows[0];
  const outcome = (code, status = 'confirmed', extra = {}) => pool.query(
    `INSERT INTO para_outcomes(athlete_id, sport_id, version_id, class_code, status, effective_from, authority_id, decision_ref, issued_by, review_by) VALUES ($1,$2,$3,$4,$5,$6,$7,'REF-1',$8,$9)`,
    [athlete.id, sl.id, v1.id, code, status, day(-3), ids.body_id, owner.id, extra.review_by ?? null]);
  await outcome('S9'); r = await nom(sanctioned, linked); assert.equal(r.status, 409); assert.equal(r.body.error.details.check, 'classification.class_outside');
  await pool.query('UPDATE para_outcomes SET superseded_at=now() WHERE athlete_id=$1', [athlete.id]); await outcome('S1');
  assert.equal((await nom(sanctioned, linked)).status, 201);
  // not eligible is a definitive refusal
  const other = await signup(['athlete']), p2 = await person(other);
  await pool.query(`INSERT INTO para_outcomes(athlete_id, sport_id, version_id, status, effective_from, authority_id, decision_ref, issued_by) VALUES ($1,$2,$3,'not_eligible',$4,$5,'REF-2',$6)`, [other.id, sl.id, v1.id, day(-3), ids.body_id, owner.id]);
  r = await nom(sanctioned, p2); assert.equal(r.status, 409); assert.equal(r.body.error.details.check, 'classification.not_eligible');
  // a live provisional approval already granted for the event is honoured; a revoked one is not
  const third = await signup(['athlete']), p3 = await person(third);
  const prov = (await pool.query('INSERT INTO para_provisional(event_id, user_id, reason_enc, valid_until, approved_by) VALUES ($1,$2,$3,$4,$5) RETURNING id', [ev.id, third.id, 'x', day(30), org.id])).rows[0];
  await pool.query('UPDATE para_provisional SET revoked_at=now(), revoked_by=$2 WHERE id=$1', [prov.id, org.id]);
  assert.equal((await nom(sanctioned, p3)).status, 409, 'revoked provisional does not count');
  await pool.query('INSERT INTO para_provisional(event_id, user_id, reason_enc, valid_until, approved_by) VALUES ($1,$2,$3,$4,$5)', [ev.id, third.id, 'x', day(30), org.id]);
  assert.equal((await nom(sanctioned, p3)).status, 201, 'live provisional approval admits');
});
