// PS-02 (#832): para classification in competition. Integration over #488 (classification) and #477 (eligibility): per-category classes, entry snapshots, provisional participation,
// role-partitioned projections, frozen match records, and the refusal of unverified or AI-derived classes. No classification tables are added here.
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

const slug = async () => (await pool.query('SELECT slug FROM sports WHERE id=$1', [sport.id])).rows[0].slug;
/** A competition with two teams, a fixture, a category, and a registered-able player. */
const comp = async (rules = {}) => {
  const orgz = await signup(['organizer']), mgr = await signup(), mgr2 = await signup(), sl = await slug();
  const ev = must(await api('POST', '/events', { token: orgz.token, body: { name: `Para Open ${++n}`, sport: sl, starts_on: day(5), ends_on: day(30) } }), 201);
  const t1 = must(await api('POST', '/teams', { token: mgr.token, body: { name: `T ${++n}`, sport: sl } }), 201), t2 = must(await api('POST', '/teams', { token: mgr2.token, body: { name: `T ${++n}`, sport: sl } }), 201);
  for (const [t, tok] of [[t1, mgr.token], [t2, mgr2.token]]) { const en = must(await api('POST', `/events/${ev.id}/entries`, { token: tok, body: { team_id: t.id } }), 201); must(await api('PATCH', `/entries/${en.id}`, { token: orgz.token, body: { status: 'accepted' } })); }
  const fx = must(await api('POST', `/events/${ev.id}/fixtures`, { token: orgz.token, body: { home_team_id: t1.id, away_team_id: t2.id, scheduled_at: inst(3) } }), 201);
  const cat = must(await api('POST', `/events/${ev.id}/registration/divisions`, { token: orgz.token, body: { name: 'Quad Singles' } }), 201);
  const cat2 = must(await api('POST', `/events/${ev.id}/registration/divisions`, { token: orgz.token, body: { name: 'Open Singles' } }), 201);
  must(await api('POST', `/events/${ev.id}/registration/policy`, { token: orgz.token, body: { rules: { required_clearances: ['classification'], classification_mode: 'governed', category_classes: { [cat.id]: ['T11', 'T12'], [cat2.id]: ['T13'] }, ...rules }, expected_version: 0 } }), 201);
  const player = async (team = t1, tok = mgr.token) => { const p = await signup(); must(await api('POST', `/teams/${team.id}/members`, { token: tok, body: { user_id: p.id } }), 201); return p; };
  return { orgz, mgr, mgr2, ev, t1, t2, fx, cat, cat2, player };
};
const enter = (s, p, division_id) => api('POST', `/events/${s.ev.id}/registrations`, { token: s.mgr.token, body: { team_id: s.t1.id, user_id: p.id, division_id } });

test('per-category classes: entry is flagged when no class is on record, blocked when the class is outside the category, and never guessed', async () => {
  const w = await world(1), s = await comp();
  const p = await s.player();
  const r1 = must(await enter(s, p, s.cat.id), 201);
  const snap = (await pool.query("SELECT * FROM para_entry_snapshots WHERE registration_id=$1 AND stage='submitted'", [r1.id])).rows[0];
  assert.equal(snap.decision, 'ineligible'); assert.match(snap.reason, /on record/i); // flagged, not blocked, and no class invented
  await decide(w, p, 'T13'); // T13 is not a class of Quad Singles
  const p2 = await s.player(); await decide(w, p2, 'T13');
  assert.equal((await enter(s, p2, s.cat.id)).status, 409, 'a class outside the category blocks the entry');
  assert.equal((await enter(s, p2, s.cat2.id)).status, 201, 'the same class fits the other category');
  const chk = must(await api('GET', `/events/${s.ev.id}/para/check`, { token: s.orgz.token, query: { user_id: p.id, division_id: s.cat.id } }));
  assert.equal(chk.result.decision, 'ineligible'); assert.deepEqual(chk.accepted_classes, ['T11', 'T12']);
  assert.equal((await api('GET', `/events/${s.ev.id}/para/check`, { token: p.token, query: { user_id: p.id } })).status, 403, 'only the organiser runs the category check');
});

test('manual / unverified classification references are never authoritative', async () => {
  const s = await comp({ classification_mode: 'external_reference' });
  const p = await s.player();
  must(await api('POST', `/events/${s.ev.id}/registration/dependencies`, { token: s.orgz.token, body: { user_id: p.id, kind: 'classification', status: 'clear', source_ref: 'uploaded certificate' } }), 201);
  const chk = must(await api('GET', `/events/${s.ev.id}/para/check`, { token: s.orgz.token, query: { user_id: p.id, division_id: s.cat.id } }));
  assert.equal(chk.result.status, 'pending'); assert.match(chk.result.reason, /unverified/i);
  const el = must(await api('GET', `/events/${s.ev.id}/eligibility`, { token: s.orgz.token, query: { team_id: s.t1.id, user_id: p.id } })).decisions[0];
  assert.notEqual(el.decision, 'eligible');
});

test('provisional participation: only where the policy allows it, never over "not eligible", with an end date', async () => {
  const w = await world(1), off = await comp(), on = await comp({ allow_provisional: true });
  const p = await off.player();
  assert.equal((await api('POST', `/events/${off.ev.id}/para/provisional`, { token: off.orgz.token, body: { user_id: p.id, reason: 'Pending panel', valid_until: day(20) } })).status, 409, 'policy does not allow it');
  const q = await on.player();
  assert.equal((await api('POST', `/events/${on.ev.id}/para/provisional`, { token: on.orgz.token, body: { user_id: q.id, reason: 'Pending', valid_until: day(500) } })).status, 400, 'at most 12 months');
  const g = must(await api('POST', `/events/${on.ev.id}/para/provisional`, { token: on.orgz.token, body: { user_id: q.id, reason: 'Panel meets next week', valid_until: day(20) } }), 201);
  const chk = must(await api('GET', `/events/${on.ev.id}/para/check`, { token: on.orgz.token, query: { user_id: q.id, division_id: on.cat.id } }));
  assert.equal(chk.result.status, 'waived'); assert.equal(chk.result.decision, 'eligible'); assert.equal(chk.result.source.kind, 'para_provisional');
  assert.ok(!JSON.stringify(chk).includes('Panel meets'), 'the reason stays encrypted');
  must(await api('POST', `/para/provisional/${g.id}/revoke`, { token: on.orgz.token, body: {} }));
  assert.equal(must(await api('GET', `/events/${on.ev.id}/para/check`, { token: on.orgz.token, query: { user_id: q.id, division_id: on.cat.id } })).result.decision, 'ineligible');
  const n2 = await on.player(); await decide(w, n2, 'T11', 'not_eligible');
  assert.equal((await api('POST', `/events/${on.ev.id}/para/provisional`, { token: on.orgz.token, body: { user_id: n2.id, reason: 'Try anyway', valid_until: day(20) } })).status, 409, 'not eligible cannot be overridden');
  const summary = must(await api('GET', `/events/${on.ev.id}/para/summary`, { token: on.orgz.token }));
  assert.ok(summary.counts.entries === 0 && Array.isArray(summary.attention));
});

test('frozen class: a reclassification never rewrites an entry or a locked match; role-partitioned projections hide everything clinical', async () => {
  const w = await world(1), s = await comp();
  const p = await s.player(); const d1 = await decide(w, p, 'T12');
  const reg = must(await enter(s, p, s.cat.id), 201);
  must(await api('POST', `/registrations/${reg.id}/review`, { token: s.orgz.token, body: { action: 'register', row_version: reg.row_version } }));
  must(await api('POST', `/teams/${s.t1.id}/squad`, { token: s.mgr.token, body: { fixture_id: s.fx.id, members: [{ user_id: p.id, role: 'player' }] } }));
  must(await api('POST', `/fixtures/${s.fx.id}/eligibility/lock`, { token: s.orgz.token, body: {} }), 201);
  await decide(w, p, 'T11'); // later decision
  const snaps = (await pool.query('SELECT stage, source FROM para_entry_snapshots WHERE registration_id=$1 ORDER BY stage DESC', [reg.id])).rows;
  assert.deepEqual(snaps.map((x) => x.stage).sort(), ['registered', 'submitted']);
  assert.ok(snaps.every((x) => x.source.id === d1.out.id), 'entry snapshots keep the class used at the time');
  assert.equal((await pool.query("UPDATE para_entry_snapshots SET reason='x' WHERE registration_id=$1", [reg.id]).catch((e) => e)).code, '55000', 'append-only');
  const fxs = must(await api('GET', `/fixtures/${s.fx.id}/para`, { token: s.orgz.token }));
  assert.equal(fxs.players[0].source.class_code, 'T12'); assert.equal(fxs.players[0].source.decision_ref, d1.out.decision_ref);
  const mine = must(await api('GET', '/me/para-entries', { token: p.token }));
  assert.equal(mine.entries[0].live.source.class_code, 'T11'); assert.equal(mine.entries[0].frozen[0].source.class_code, 'T12');
  const stranger = await signup();
  assert.equal(must(await api('GET', '/me/para-entries', { token: stranger.token })).entries.length, 0);
  assert.ok([403, 404].includes((await api('GET', '/me/para-entries', { token: stranger.token, query: { athlete_id: p.id } })).status), 'a stranger cannot read another athlete\'s entries');
  assert.ok([403, 404].includes((await api('GET', `/fixtures/${s.fx.id}/para`, { token: stranger.token })).status));
  const all = JSON.stringify([mine, fxs, must(await api('GET', `/events/${s.ev.id}/para/summary`, { token: s.orgz.token }))]);
  for (const bad of ['Requesting initial', 'evidence', 'panel_', 'grounds', 'file_enc']) assert.ok(!all.includes(bad), `no ${bad} in competition projections`);
  const tools = (await rpc('tools/list', {}, admin.token)).tools.map((t) => t.name);
  for (const nm of ['my_para_entries', 'check_para_category', 'para_event_summary', 'grant_para_provisional', 'revoke_para_provisional', 'get_fixture_para_summary']) {
    assert.ok(tools.includes(nm), `${nm} on MCP`); assert.ok(capabilities.some((c) => c.name === nm), nm);
  }
  assert.equal(forbiddenKind('Classify this athlete from her match video'), 'classification');
  const { readFileSync } = await import('node:fs');
  const created = [...readFileSync(new URL('../migrations/160_para_competition_binding.sql', import.meta.url), 'utf8').matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(created, ['para_entry_snapshots', 'para_provisional'], 'no classification case/record tables are cloned by this issue');
});
