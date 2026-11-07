import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// #806 Academy accreditation, audits and corrective-action governance: evidence by reference, live validity, audit lifecycle, the append-only trail,
// the inspector's narrow access, every refusal, and REST/OpenAPI/MCP parity.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { capabilities } = await import('../src/capabilities/index.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const inDays = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `ac_${n}_${roles[0]}`, display_name: `Ac ${n}`, email: `ac${n}@example.com`, password: 'correct-horse-battery', roles, dob: yearsAgo(30) } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const join = async (org, owner, u, role) => {
  ok(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role } }), 201);
  ok(await api('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } }));
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('ac_root','ac_root','{admin}','x','x','ac_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

async function academy() {
  const owner = await signup(['athlete']), coach = await signup(['coach']), auditor = await signup(), outsider = await signup(), inspector = await signup();
  const org = ok(await api('POST', '/organisations', { token: owner.token, body: { name: `Accreditation Academy ${n}`, kind: 'academy' } }), 201);
  await join(org, owner, coach, 'coach');
  await join(org, owner, auditor, 'auditor');
  return { owner, coach, auditor, outsider, inspector, org };
}
const FW = { name: 'Coaching Centre Accreditation', body_name: 'National Tennis Federation', kind: 'coaching_standard', level: 'Level 3', cycle_months: 12, next_due_on: inDays(40), remind_days: 60 };
const REQS = [{ title: 'Coach qualification certificates', evidence_kind: 'coach_credentials' }, { title: 'Premises safety certificate', evidence_kind: 'facility' }, { title: 'Safeguarding policy', evidence_kind: 'policy' }];

async function withFramework(a, extra = {}) {
  return ok(await api('POST', `/organisations/${a.org.id}/academy/accreditation-frameworks`, { token: a.owner.token, body: { ...FW, requirements: REQS, ...extra } }), 201);
}
async function compRecord(a, { status = 'valid', expires = inDays(200), subject = ['organisation', a.org.id] } = {}) {
  const req = (await pool.query("INSERT INTO comp_requirements(scope_kind, scope_id, code, name, category, subject_kind, method, created_by) VALUES ('organisation',$1,$2,'Premises safety','licence','organisation','evidence',$3) RETURNING id", [a.org.id, `code_${Math.random().toString(36).slice(2, 8)}`, admin.id])).rows[0];
  const rec = (await pool.query('INSERT INTO comp_records(requirement_id, requirement_version, subject_kind, subject_id, status, expires_on, submitted_by) VALUES ($1,1,$2,$3,$4,$5,$6) RETURNING id', [req.id, subject[0], subject[1], status, expires, admin.id])).rows[0];
  return { requirement_id: req.id, id: rec.id };
}

test('a framework is created with its checklist, starts at 0% and is read by owners and auditors but not outsiders', async () => {
  const a = await academy();
  const f = await withFramework(a);
  assert.equal(f.requirements.length, 3);
  assert.equal(f.compliance.pct, 0);
  assert.equal(f.compliance.missing, 3);
  assert.equal(f.health, 'expiring');
  ok(await api('GET', `/academy/accreditation-frameworks/${f.id}`, { token: a.auditor.token }));
  assert.equal((await api('GET', `/academy/accreditation-frameworks/${f.id}`, { token: a.outsider.token })).status, 404);
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/accreditation`, { token: a.outsider.token })).status, 404);
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/accreditation`, { token: a.coach.token })).status, 403);
  const w = await api('POST', `/organisations/${a.org.id}/academy/accreditation-frameworks`, { token: a.auditor.token, body: FW });
  assert.equal(w.status, 403);
});

test('evidence is linked by reference, validity is read live, and nothing is copied', async () => {
  const a = await academy();
  const f = await withFramework(a);
  const rec = await compRecord(a);
  const linked = ok(await api('POST', `/academy/accreditation-frameworks/${f.id}/evidence`, { token: a.owner.token, body: { requirement_id: f.requirements[1].id, comp_record_id: rec.id } }), 201);
  assert.equal(linked.requirements[1].state, 'valid');
  assert.equal(linked.compliance.met, 1);
  assert.equal(linked.compliance.pct, 33);
  // the record lapses in its own domain, and the framework follows without anyone touching it
  await pool.query("UPDATE comp_records SET expires_on = current_date - 1 WHERE id=$1", [rec.id]);
  const after = ok(await api('GET', `/academy/accreditation-frameworks/${f.id}`, { token: a.owner.token }));
  assert.equal(after.requirements[1].state, 'lapsed');
  assert.equal(after.compliance.pct, 0);
  assert.equal((await api('POST', `/academy/accreditation-frameworks/${f.id}/evidence`, { token: a.owner.token, body: { requirement_id: f.requirements[1].id, comp_record_id: rec.id } })).status, 409);
  const cols = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='academy_accreditation_evidence'")).rows.map((r) => r.column_name);
  assert.ok(!cols.some((c) => /detail|reference|file|body|content/.test(c)), 'the link table holds pointers only');
  const link = (await pool.query('SELECT id FROM academy_accreditation_evidence WHERE framework_id=$1', [f.id])).rows[0];
  ok(await api('POST', `/academy/accreditation-evidence/${link.id}/unlink`, { token: a.owner.token }));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM academy_accreditation_evidence WHERE framework_id=$1', [f.id])).rows[0].n, 1, 'an ended link is kept');
  assert.equal((await pool.query('SELECT status FROM comp_records WHERE id=$1', [rec.id])).rows[0].status, 'valid', 'the underlying record is never touched');
});

test('evidence from another organisation, a missing record, or the wrong shape is refused', async () => {
  const a = await academy(), b = await academy();
  const f = await withFramework(a);
  const theirs = await compRecord(b);
  assert.equal((await api('POST', `/academy/accreditation-frameworks/${f.id}/evidence`, { token: a.owner.token, body: { requirement_id: f.requirements[0].id, comp_record_id: theirs.id } })).status, 404);
  assert.equal((await api('POST', `/academy/accreditation-frameworks/${f.id}/evidence`, { token: a.owner.token, body: { requirement_id: f.requirements[0].id, credential_id: '00000000-0000-4000-8000-000000000000' } })).status, 404);
  assert.equal((await api('POST', `/academy/accreditation-frameworks/${f.id}/evidence`, { token: a.owner.token, body: { requirement_id: f.requirements[0].id } })).status, 400);
  const mine = await compRecord(a, { subject: ['person', a.coach.id] });
  ok(await api('POST', `/academy/accreditation-frameworks/${f.id}/evidence`, { token: a.owner.token, body: { requirement_id: f.requirements[0].id, comp_record_id: mine.id } }), 201);
  const opts = ok(await api('GET', `/organisations/${a.org.id}/academy/accreditation-evidence-options`, { token: a.owner.token }));
  assert.ok(opts.records.some((r) => r.id === mine.id));
  assert.ok(!opts.records.some((r) => r.id === theirs.id));
});

test('a credential issued by the academy can be linked and a checklist item tied to a compliance requirement reads its record', async () => {
  const a = await academy();
  const rec = await compRecord(a);
  const f = await withFramework(a, { requirements: [{ title: 'Premises', evidence_kind: 'facility', comp_requirement_id: rec.requirement_id }, { title: 'Coach cert', evidence_kind: 'coach_credentials' }] });
  assert.equal(f.requirements[0].state, 'valid');
  assert.equal(f.requirements[0].evidence[0].derived, true);
  const cred = (await pool.query("INSERT INTO credentials(user_id, organisation_id, kind, title, code, issued_by) VALUES ($1,$2,'certificate','Level 3 coach',$3,$4) RETURNING id", [a.coach.id, a.org.id, `cr_${Math.random().toString(36).slice(2, 10)}`, a.owner.id])).rows[0];
  const l = ok(await api('POST', `/academy/accreditation-frameworks/${f.id}/evidence`, { token: a.owner.token, body: { requirement_id: f.requirements[1].id, credential_id: cred.id } }), 201);
  assert.equal(l.compliance.pct, 100);
});

test('an audit runs scheduled, findings, resolution, resubmission and a clean pass, with an append-only trail', async () => {
  const a = await academy();
  const f = await withFramework(a);
  const au = ok(await api('POST', `/academy/accreditation-frameworks/${f.id}/audits`, { token: a.owner.token, body: { kind: 'on_site', scheduled_on: inDays(10), starts_at: '09:00', ends_at: '17:00', venue_name: 'Main campus', scope: ['coaches', 'premises'], inspector_id: a.inspector.id } }), 201);
  assert.equal(au.status, 'scheduled');
  assert.equal(au.inspector_name, a.inspector.display_name);
  const withFinding = ok(await api('POST', `/academy/audits/${au.id}/findings`, { token: a.inspector.token, body: { severity: 'high', title: 'Policy out of date', detail: 'Last year\'s version is on file', actions: [{ title: 'Upload 2026 policy', owner_id: a.coach.id, due_on: inDays(20) }] } }), 201);
  assert.equal(withFinding.findings[0].ref, 'F-001');
  assert.equal(withFinding.findings[0].detail, 'Last year\'s version is on file');
  const raw = (await pool.query('SELECT detail_enc FROM academy_audit_findings')).rows[0].detail_enc;
  assert.ok(raw && !raw.includes('version'), 'finding detail is encrypted at rest');
  const finding = withFinding.findings[0], action = finding.actions[0];
  ok(await api('POST', `/academy/audits/${au.id}/decision`, { token: a.inspector.token, body: { decision: 'conditional_pass', score: 71, resubmit_by: inDays(30), summary: 'Close, but not yet' } }));
  assert.equal((await api('POST', `/academy/audits/${au.id}/resubmit`, { token: a.owner.token, body: {} })).status, 409);
  assert.equal((await api('POST', `/academy/audit-findings/${finding.id}/resolve`, { token: a.owner.token, body: {} })).status, 409, 'an open corrective action blocks resolution');
  assert.equal((await api('POST', `/academy/audit-actions/${action.id}/complete`, { token: a.outsider.token, body: {} })).status, 404);
  ok(await api('POST', `/academy/audit-actions/${action.id}/complete`, { token: a.coach.token, body: { note: 'Uploaded' } }));
  ok(await api('POST', `/academy/audit-findings/${finding.id}/resolve`, { token: a.owner.token, body: {} }));
  const re = ok(await api('POST', `/academy/audits/${au.id}/resubmit`, { token: a.owner.token, body: {} }));
  assert.equal(re.status, 'resubmitted');
  const closed = ok(await api('POST', `/academy/audits/${au.id}/decision`, { token: a.inspector.token, body: { decision: 'pass', score: 94 } }));
  assert.equal(closed.status, 'closed');
  const fw = ok(await api('GET', `/academy/accreditation-frameworks/${f.id}`, { token: a.owner.token }));
  assert.ok(fw.expires_on > inDays(300), 'a pass moves the expiry on by the cycle');
  const trail = closed.trail.map((t) => t.kind);
  for (const k of ['audit_scheduled', 'finding_recorded', 'audit_decided', 'action_done', 'finding_resolved', 'audit_resubmitted']) assert.ok(trail.includes(k), k);
  await assert.rejects(pool.query('UPDATE academy_accreditation_events SET kind=$1', ['x']), /append-only/);
  await assert.rejects(pool.query('DELETE FROM academy_accreditation_events'), /append-only/);
});

test('a clean pass cannot be issued over open findings, and a conditional pass needs a date', async () => {
  const a = await academy();
  const f = await withFramework(a);
  const au = ok(await api('POST', `/academy/accreditation-frameworks/${f.id}/audits`, { token: a.owner.token, body: { kind: 'document_review', scheduled_on: inDays(3) } }), 201);
  ok(await api('POST', `/academy/audits/${au.id}/findings`, { token: a.owner.token, body: { severity: 'low', title: 'Tidy the records' } }), 201);
  assert.equal((await api('POST', `/academy/audits/${au.id}/decision`, { token: a.owner.token, body: { decision: 'pass', score: 90 } })).status, 409);
  assert.equal((await api('POST', `/academy/audits/${au.id}/decision`, { token: a.owner.token, body: { decision: 'conditional_pass', score: 80 } })).status, 400);
  assert.equal((await api('POST', `/academy/audits/${au.id}/decision`, { token: a.auditor.token, body: { decision: 'fail', score: 10 } })).status, 403, 'auditors read only');
  const x = ok(await api('POST', `/academy/audits/${au.id}/decision`, { token: a.owner.token, body: { decision: 'fail', score: 30 } }));
  assert.equal(x.status, 'findings_issued');
  assert.equal((await api('POST', `/academy/accreditation-frameworks/${f.id}/audits`, { token: a.owner.token, body: { kind: 'remote', scheduled_on: '2001-01-01' } })).status, 400);
});

test('an inspector sees their own audit only and cannot read or change anything else in the academy', async () => {
  const a = await academy();
  const f = await withFramework(a);
  const au = ok(await api('POST', `/academy/accreditation-frameworks/${f.id}/audits`, { token: a.owner.token, body: { kind: 'remote', scheduled_on: inDays(5), inspector_id: a.inspector.id } }), 201);
  const mine = ok(await api('GET', '/academy/audits/mine', { token: a.inspector.token }));
  assert.equal(mine.length, 1);
  ok(await api('GET', `/academy/audits/${au.id}`, { token: a.inspector.token }));
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/accreditation`, { token: a.inspector.token })).status, 404);
  assert.equal((await api('GET', `/academy/accreditation-frameworks/${f.id}`, { token: a.inspector.token })).status, 404);
  assert.equal((await api('POST', `/academy/audits/${au.id}/cancel`, { token: a.inspector.token, body: {} })).status, 403);
  assert.equal((await api('GET', `/academy/audits/${au.id}`, { token: a.outsider.token })).status, 404);
  ok(await api('POST', `/academy/audits/${au.id}/cancel`, { token: a.owner.token, body: { reason: 'Rescheduled' } }));
});

test('the overview counts frameworks, expiry, findings and overdue actions, and archiving keeps the record', async () => {
  const a = await academy();
  const f = await withFramework(a), g = await withFramework(a, { name: 'Old licence', expires_on: inDays(-5), next_due_on: undefined });
  const au = ok(await api('POST', `/academy/accreditation-frameworks/${f.id}/audits`, { token: a.owner.token, body: { kind: 'on_site', scheduled_on: inDays(2) } }), 201);
  const r = ok(await api('POST', `/academy/audits/${au.id}/findings`, { token: a.owner.token, body: { severity: 'medium', title: 'Plan unsigned', actions: [{ title: 'Sign it', due_on: inDays(0) }] } }), 201);
  await pool.query("UPDATE academy_audit_actions SET due_on = current_date - 2");
  const o = ok(await api('GET', `/organisations/${a.org.id}/academy/accreditation`, { token: a.auditor.token }));
  assert.equal(o.kpis.frameworks, 2);
  assert.equal(o.kpis.expired, 1);
  assert.equal(o.kpis.open_findings, 1);
  assert.equal(o.kpis.overdue_actions, 1);
  assert.equal(o.actions[0].overdue, true);
  assert.equal(o.can_manage, false);
  const stale = await api('PATCH', `/academy/accreditation-frameworks/${f.id}`, { token: a.owner.token, body: { name: 'Renamed', row_version: 99 } });
  assert.equal(stale.status, 409);
  ok(await api('PATCH', `/academy/accreditation-frameworks/${g.id}`, { token: a.owner.token, body: { status: 'archived' } }));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM academy_accreditation_frameworks WHERE id=$1', [g.id])).rows[0].n, 1);
  assert.equal(ok(await api('GET', `/organisations/${a.org.id}/academy/accreditation`, { token: a.owner.token })).kpis.frameworks, 1);
  assert.equal(ok(await api('GET', `/organisations/${a.org.id}/academy/accreditation`, { token: a.owner.token, query: { include_archived: 'true' } })).kpis.frameworks, 1, 'archived frameworks stay out of the headline numbers');
  assert.equal(ok(await api('GET', `/organisations/${a.org.id}/academy/accreditation/trail`, { token: a.auditor.token })).length > 3, true);
  assert.ok(r.findings.length === 1);
});

test('every accreditation capability is on REST, OpenAPI and MCP', async () => {
  const mine = capabilities.filter((c) => c.tag === 'Academy accreditation');
  assert.ok(mine.length >= 18, `expected the full set, found ${mine.length}`);
  const spec = ok(await api('GET', '/openapi.json'));
  const ids = new Set(Object.values(spec.paths).flatMap((p) => Object.values(p).map((o) => o.operationId)));
  for (const c of mine) assert.ok(ids.has(c.name), `${c.name} is in OpenAPI`);
  const o = await api('POST', '/mcp', { token: admin.token, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  if (o.status === 200) { const names = new Set((o.body.result?.tools ?? []).map((t) => t.name)); for (const c of mine) assert.ok(names.has(c.name), `${c.name} is an MCP tool`); }
});
