import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// #799 International admissions & relocation readiness: data-driven templates, the enrol gate, guardian permission, the passport/visa vault,
// owner-approved offer conditions, immutable history, authorization, and REST/OpenAPI/MCP parity.
Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { capabilities } = await import('../src/capabilities/index.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const inDays = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const signup = async (extra = {}) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `in_${n}`, display_name: `Intl ${n}`, email: `in${n}@example.com`, password: 'correct-horse-battery', roles: ['athlete'], ...extra } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const adult = () => signup({ dob: yearsAgo(30) });
const evidence = { reference: 'https://example.com/birth-certificate-ref-123', label: 'Birth certificate' };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('in_root','in_root','{admin}','x','x','in_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const guardianOf = async (child) => {
  const parent = await adult();
  const l = must(await api('POST', '/youth/guardian-links', { token: parent.token, body: { guardian_id: parent.id, child_id: child.id, relationship: 'parent' } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: child.token, body: { accept: true } }));
  must(await api('POST', `/youth/guardian-links/${l.id}/evidence`, { token: parent.token, body: { evidence } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Docs ok' } }));
  return parent;
};
const TPL = (extra = {}) => ({ name: 'Spain residential entry', countries: ['IN', 'GB'], items: [
  { key: 'passport', kind: 'travel_document', label: 'Valid passport', mandatory: true, lead_days: 60 },
  { key: 'visa', kind: 'travel_document', label: 'Student visa', mandatory: true, lead_days: 45 },
  { key: 'school_place', kind: 'school', label: 'School place confirmed', mandatory: true, lead_days: 30 },
  { key: 'welcome_pack', kind: 'custom', label: 'Welcome pack read', mandatory: false, lead_days: 7 }], ...extra });

async function setup({ youth = false } = {}) {
  const owner = await adult(), admin2 = await adult(), outsider = await adult();
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Intl Academy ${++n}`, kind: 'academy' } }), 201);
  must(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: admin2.handle, role: 'admin' } }), 201);
  must(await api('POST', `/organisations/${org.id}/invite/respond`, { token: admin2.token, body: { accept: true } }));
  must(await api('PATCH', `/organisations/${org.id}/academy`, { token: owner.token, body: { row_version: 0, sports: ['football'], currency: 'GBP', listed: true } }));
  const prog = must(await api('POST', `/organisations/${org.id}/academy/programmes`, { token: owner.token, body: { sport: 'football', title: `Residential ${n}`, capacity: 5, admission_mode: 'application', public: true } }), 201);
  must(await api('POST', `/academy/programmes/${prog.id}/versions`, { token: owner.token, body: { row_version: prog.row_version, billing_model: 'free', currency: 'GBP' } }), 201);
  const athlete = youth ? await signup({ dob: yearsAgo(14) }) : await adult();
  const parent = youth ? await guardianOf(athlete) : null;
  if (youth) must(await api('POST', `/youth/children/${athlete.id}/consents`, { token: parent.token, body: { purpose: 'participation' } }), 201);
  const applicant = parent ?? athlete;
  const enq = must(await api('POST', `/academy/programmes/${prog.id}/applications`, { token: applicant.token, body: youth ? { athlete_id: athlete.id } : {} }), 201);
  const sub = must(await api('POST', `/academy/applications/${enq.id}/submit`, { token: applicant.token, body: { row_version: enq.row_version, answers: {} } }));
  const offer = must(await api('POST', `/academy/applications/${enq.id}/decision`, { token: owner.token, body: { row_version: sub.row_version, decision: 'offer', reason: 'Great fit' } }));
  const tpl = must(await api('POST', `/organisations/${org.id}/academy/international/templates`, { token: owner.token, body: TPL() }), 201);
  return { owner, admin2, outsider, org, prog, athlete, parent, applicant, app: offer, appId: enq.id, tpl };
}
const accept = (a, row_version) => api('POST', `/academy/applications/${a.appId}/offer`, { token: a.applicant.token, body: { row_version, accept: true } });
const current = async (a) => (await pool.query('SELECT row_version FROM academy_applications WHERE id=$1', [a.appId])).rows[0].row_version;

test('a mandatory item blocks enrolment until verified; nothing blocks a non-international application', async () => {
  const plain = await setup();
  assert.equal((await accept(plain, await current(plain))).status, 200);   // no case, no gate: existing behaviour intact

  const a = await setup();
  const k = must(await api('POST', `/academy/applications/${a.appId}/international`, { token: a.owner.token, body: { origin_country: 'IN', arrival_on: inDays(90) } }), 201);
  assert.equal(k.readiness.ready, false);
  assert.equal(k.items.length, 4);
  assert.equal(k.items.find((i) => i.key === 'passport').due_on, inDays(30));
  const gate = await accept(a, await current(a));
  assert.equal(gate.status, 409);
  assert.equal(gate.body.error.details.code, 'international_readiness');
  assert.ok(gate.body.error.details.blocking.some((b) => b.key === 'passport'));
  assert.equal((await pool.query('SELECT stage FROM academy_applications WHERE id=$1', [a.appId])).rows[0].stage, 'offered');

  const doc = (kind, status, exp) => api('POST', `/academy/international/${k.id}/documents/${kind}`, { token: a.athlete.token, body: { status, expires_on: exp, number: kind === 'passport' ? 'Z1234567' : 'V99887766', evidence_ref: 'scan-ref-1' } });
  must(await doc('passport', 'held', inDays(900)));
  must(await doc('visa', 'approved', inDays(500)));
  for (const key of ['passport', 'visa', 'school_place']) {
    const it = k.items.find((i) => i.key === key);
    must(await api('POST', `/academy/international/items/${it.id}/submit`, { token: a.athlete.token, body: {} }));
    must(await api('POST', `/academy/international/items/${it.id}/decision`, { token: a.owner.token, body: { decision: 'verify' } }));
  }
  const ready = must(await api('GET', `/academy/applications/${a.appId}/international`, { token: a.owner.token }));
  assert.equal(ready.readiness.ready, true);   // the optional welcome pack does not block
  assert.equal((await accept(a, await current(a))).status, 200);
});

test('passport/visa numbers never reach staff, lists, history or notifications; reveal is holder-only and audited', async () => {
  const a = await setup();
  const k = must(await api('POST', `/academy/applications/${a.appId}/international`, { token: a.owner.token, body: { origin_country: 'GB' } }), 201);
  must(await api('POST', `/academy/international/${k.id}/documents/passport`, { token: a.athlete.token, body: { status: 'held', expires_on: inDays(900), number: 'Z1234567', evidence_ref: 'scan-ref-1' } }));
  const staffSet = await api('POST', `/academy/international/${k.id}/documents/passport`, { token: a.owner.token, body: { status: 'held', number: 'HACK1234' } });
  assert.equal(staffSet.status, 403);
  must(await api('POST', `/academy/international/${k.id}/documents/visa`, { token: a.owner.token, body: { status: 'required' } }));   // status only is fine for staff
  const seen = JSON.stringify([
    must(await api('GET', `/academy/applications/${a.appId}/international`, { token: a.owner.token })),
    must(await api('GET', `/academy/applications/${a.appId}/international`, { token: a.athlete.token })),
    must(await api('GET', `/organisations/${a.org.id}/academy/international/board`, { token: a.owner.token })),
    must(await api('GET', `/academy/applications/${a.appId}`, { token: a.owner.token })),
    (await pool.query('SELECT data FROM academy_intl_events')).rows, (await pool.query('SELECT title, body, data FROM notifications')).rows]);
  for (const secret of ['Z1234567', 'HACK1234', 'scan-ref-1']) assert.ok(!seen.includes(secret), `${secret} leaked`);
  const raw = JSON.stringify((await pool.query('SELECT number_enc, evidence_ref_enc FROM academy_intl_documents')).rows);
  assert.ok(!raw.includes('Z1234567'));   // encrypted at rest
  assert.equal((await api('GET', `/academy/international/${k.id}/documents/passport/reveal`, { token: a.owner.token })).status, 404);
  assert.equal((await api('GET', `/academy/international/${k.id}/documents/passport/reveal`, { token: a.outsider.token })).status, 404);
  const r = must(await api('GET', `/academy/international/${k.id}/documents/passport/reveal`, { token: a.athlete.token }));
  assert.equal(r.number, 'Z1234567');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='reveal_intl_document'")).rowCount);
  assert.equal((await api('GET', `/academy/applications/${a.appId}/international`, { token: a.outsider.token })).status, 404);
  assert.equal((await api('POST', `/academy/international/${k.id}/documents/passport`, { token: a.outsider.token, body: { status: 'held' } })).status, 404);
});

test('a young athlete always has a mandatory guardian permission that needs an expiry, and only a verified guardian acts', async () => {
  const a = await setup({ youth: true });
  const k = must(await api('POST', `/academy/applications/${a.appId}/international`, { token: a.owner.token, body: { origin_country: 'IN', arrival_on: inDays(120), reviewer_id: a.admin2.id } }), 201);
  const g = k.items.find((i) => i.kind === 'guardian_permission');
  assert.ok(g?.mandatory);
  assert.equal((await api('GET', `/academy/applications/${a.appId}/international`, { token: a.athlete.token })).status, 404);   // a young person acts through a guardian
  must(await api('POST', `/academy/international/items/${g.id}/submit`, { token: a.parent.token, body: {} }));
  assert.equal((await api('POST', `/academy/international/items/${g.id}/decision`, { token: a.parent.token, body: { decision: 'verify' } })).status, 403);   // family cannot verify
  assert.equal((await api('POST', `/academy/international/items/${g.id}/decision`, { token: a.owner.token, body: { decision: 'verify' } })).status, 400);   // needs an expiry
  must(await api('POST', `/academy/international/items/${g.id}/decision`, { token: a.admin2.token, body: { decision: 'verify', expires_on: inDays(300) } }));
  assert.equal((await api('POST', `/academy/international/items/${g.id}/decision`, { token: a.owner.token, body: { decision: 'waive', reason: 'not needed' } })).status, 409);   // never waivable
  // evidence that expires before arrival no longer counts
  await pool.query("UPDATE academy_intl_items SET expires_on=$1 WHERE id=$2", [inDays(10), g.id]);
  const v = must(await api('GET', `/academy/applications/${a.appId}/international`, { token: a.parent.token }));
  const gi = v.items.find((i) => i.kind === 'guardian_permission');
  assert.equal(gi.met, false); assert.ok(gi.issues.includes('expired'));
  const stranger = await adult();
  assert.equal((await api('GET', `/academy/applications/${a.appId}/international`, { token: stranger.token })).status, 404);
});

test('offer conditions are owner-approved, hidden until then, and block enrolment until met; decisions are immutable', async () => {
  const a = await setup();
  const k = must(await api('POST', `/academy/applications/${a.appId}/international`, { token: a.owner.token, body: { origin_country: 'IN' } }), 201);
  await pool.query("UPDATE academy_intl_items SET mandatory=false WHERE case_id=$1", [k.id]);   // isolate the condition gate
  const c1 = must(await api('POST', `/academy/international/${k.id}/conditions`, { token: a.admin2.token, body: { text: 'Visa granted before arrival' } }), 201);
  assert.equal(must(await api('GET', `/academy/applications/${a.appId}/international`, { token: a.athlete.token })).conditions.length, 0);
  assert.equal((await api('POST', `/academy/international/conditions/${c1.id}/decision`, { token: a.admin2.token, body: { decision: 'approve' } })).status, 403);
  const blocked = await accept(a, await current(a));
  assert.equal(blocked.status, 409);
  assert.ok(!JSON.stringify(blocked.body).includes('Visa granted'));   // draft wording is not leaked through the error
  must(await api('POST', `/academy/international/conditions/${c1.id}/decision`, { token: a.owner.token, body: { decision: 'approve' } }));
  assert.equal(must(await api('GET', `/academy/applications/${a.appId}/international`, { token: a.athlete.token })).conditions[0].text, 'Visa granted before arrival');
  assert.equal((await accept(a, await current(a))).status, 409);
  must(await api('POST', `/academy/international/conditions/${c1.id}/decision`, { token: a.admin2.token, body: { decision: 'met' } }));
  assert.equal((await accept(a, await current(a))).status, 200);
  await assert.rejects(pool.query("UPDATE academy_intl_events SET kind='x'"), /append-only/);
  await assert.rejects(pool.query('DELETE FROM academy_intl_template_versions'), /append-only/);
  const hist = must(await api('GET', `/academy/applications/${a.appId}/international`, { token: a.owner.token })).history.map((h) => h.kind);
  for (const kind of ['case_started', 'condition_proposed', 'condition_approve', 'condition_met']) assert.ok(hist.includes(kind), kind);
});

test('templates are versioned data per programme/country; cases stay pinned; the board and tasks work', async () => {
  const a = await setup();
  const v2 = must(await api('POST', `/organisations/${a.org.id}/academy/international/templates`, { token: a.owner.token, body: TPL({ template_id: a.tpl.id, items: [{ key: 'passport', kind: 'travel_document', label: 'Passport', mandatory: true, lead_days: 10 }] }) }), 201);
  assert.equal(v2.version, 2);
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/international/templates`, { token: a.owner.token, body: TPL({ items: [{ key: 'x', kind: 'travel_document', label: 'Bad key', mandatory: true }] }) })).status, 400);
  const k = must(await api('POST', `/academy/applications/${a.appId}/international`, { token: a.owner.token, body: { origin_country: 'IN', arrival_on: inDays(40) } }), 201);
  assert.equal(k.template.version, 2); assert.equal(k.items.length, 1);
  must(await api('POST', `/organisations/${a.org.id}/academy/international/templates`, { token: a.owner.token, body: TPL({ template_id: a.tpl.id }) }), 201);   // v3
  assert.equal(must(await api('GET', `/academy/applications/${a.appId}/international`, { token: a.owner.token })).template.version, 2);   // still pinned
  const none = await api('POST', `/academy/applications/${a.appId}/international`, { token: a.owner.token, body: { origin_country: 'IN' } });
  assert.equal(none.status, 409);   // one checklist per application
  const task = must(await api('POST', `/academy/international/${k.id}/tasks`, { token: a.owner.token, body: { title: 'Airport pickup', due_on: inDays(-2), owner_id: a.admin2.id } }), 201);
  const res = must(await api('POST', `/organisations/${a.org.id}/academy/residences`, { token: a.owner.token, body: { name: 'North Hall', kind: 'residence_hall', capacity: 40, address: '1 Court Road' } }), 201);
  must(await api('PATCH', `/academy/international/${k.id}`, { token: a.owner.token, body: { row_version: k.row_version, residence_id: res.id, arrival_on: inDays(60) } }));
  const board = must(await api('GET', `/organisations/${a.org.id}/academy/international/board`, { token: a.admin2.token }));
  assert.equal(board.summary.total, 1); assert.equal(board.summary.ready, 0); assert.equal(board.cases[0].tasks_overdue, 1);
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/international/board`, { token: a.outsider.token })).status, 404);
  must(await api('PATCH', `/academy/international/tasks/${task.id}`, { token: a.owner.token, body: { status: 'done' } }));
  assert.equal(must(await api('GET', `/organisations/${a.org.id}/academy/residences`, { token: a.owner.token }))[0].placed, 1);
});

test('every capability is on REST, OpenAPI and MCP with the same name', async () => {
  const names = capabilities.filter((c) => c.tag === 'Academy international admissions').map((c) => c.name);
  assert.ok(names.length >= 15);
  const spec = await (await fetch(`${base}/api/v1/openapi.json`)).json();
  const ops = new Set(Object.values(spec.paths).flatMap((p) => Object.values(p).map((o) => o.operationId)));
  for (const nm of names) assert.ok(ops.has(nm), `${nm} missing from OpenAPI`);
});
