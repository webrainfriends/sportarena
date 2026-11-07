// Academy OS P2 / Gap 27 (#807): governed report packs. Draft -> review -> approve -> issue -> revoke on the shared document stack, with
// four-eyes, immutability, gaps, guardian-safe delivery, schedules that only draft, live access checks and negative cases for every role.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { draftDueReports } = await import('../src/academy-report-schedules.js');
const { capabilities } = await import('../src/registry.js');

let server, base, n = 0;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const must = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const key = () => `k-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const today = new Date().toISOString().slice(0, 10);
const dob = new Date(Date.now() - 30 * 365.25 * 864e5).toISOString().slice(0, 10);
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `rp_${n}_${roles[0]}`, display_name: `Rp ${n}`, email: `rp${n}@example.com`, password: 'correct-horse-battery', roles, dob } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
before(async () => { await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); await migrate(); server = createApp().listen(0); base = `http://localhost:${server.address().port}`; });
after(async () => { server.close(); await pool.end(); });

async function academy() {
  const owner = await signup(), admin = await signup(), finance = await signup(), coach = await signup(['coach']);
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Packs ${++n}`, kind: 'academy' } }), 201);
  must(await api('PATCH', `/organisations/${org.id}/academy`, { token: owner.token, body: { row_version: 0, sports: ['football'], currency: 'INR', listed: true } }));
  for (const [u, role] of [[admin, 'admin'], [finance, 'finance'], [coach, 'coach']]) {
    must(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role } }), 201);
    must(await api('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } }));
  }
  const prog = must(await api('POST', `/organisations/${org.id}/academy/programmes`, { token: owner.token, body: { sport: 'football', title: 'U12 Football', capacity: 20, admission_mode: 'direct', public: true } }), 201);
  const cohort = must(await api('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: 'U12 cohort', coach_id: coach.id } }), 201);
  await pool.query('UPDATE org_cohorts SET programme_id=$2 WHERE id=$1', [cohort.id, prog.id]);
  return { owner, admin, finance, coach, org, programme: prog, cohort };
}
async function athleteWithProgress(a, { youth = false } = {}) {
  const ath = await signup();
  await pool.query("INSERT INTO org_enrolments(cohort_id, user_id, status, programme_id, consent_at, enrolled_by) VALUES ($1,$2,'enrolled',$3,now(),$4)", [a.cohort.id, ath.id, a.programme.id, a.owner.id]);
  const pw = (await pool.query("INSERT INTO academy_pathways(organisation_id, sport, title, status, current_version, created_by) VALUES ($1,'football','Pathway','active',1,$2) RETURNING id", [a.org.id, a.owner.id])).rows[0];
  const v = (await pool.query("INSERT INTO academy_pathway_versions(pathway_id, version, levels, created_by) VALUES ($1,1,'[]',$2) RETURNING id", [pw.id, a.owner.id])).rows[0];
  await pool.query("INSERT INTO academy_progression_decisions(organisation_id, athlete_id, pathway_id, version_id, decision, from_level, to_level, reason, decided_by, idempotency_key) VALUES ($1,$2,$3,$4,'promote','a','a','because',$5,$6)", [a.org.id, ath.id, pw.id, v.id, a.owner.id, key()]);
  await pool.query("INSERT INTO org_attendance(cohort_id, user_id, session_date, status, recorded_by) VALUES ($1,$2,current_date,'present',$3)", [a.cohort.id, ath.id, a.coach.id]);
  let guardian = null;
  if (youth) {
    guardian = await signup();
    await pool.query("UPDATE users SET youth_until=current_date + 365 WHERE id=$1", [ath.id]);
    await pool.query("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [guardian.id, ath.id]);
    await pool.query("UPDATE users SET youth_until=current_date + 365 WHERE id=$1", [ath.id]);
  }
  return { ath, guardian };
}
const P = (a) => `/organisations/${a.org.id}/academy/report-packs`;
const file = async (who, docId) => { const r = await fetch(`${base}/api/v1/branded-documents/${docId}/file`, { headers: { authorization: `Bearer ${who.token}` } }); return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()) }; };

test('lifecycle: draft by the coach, four-eyes review, issue as the shared PDF, revoke; every step is in the append-only history', async () => {
  const a = await academy(); const { ath } = await athleteWithProgress(a);
  const d = must(await api('POST', P(a), { token: a.coach.token, body: { kind: 'term', subject_id: ath.id } }), 201);
  assert.equal(d.status, 'draft'); assert.equal(d.version, 1); assert.deepEqual(Object.keys(d.audience).sort(), ['never', 'readers']);
  assert.ok(d.evidence.length >= 3 && d.basis.period.from, 'basis and evidence versions are recorded');
  assert.equal(must(await api('POST', P(a), { token: a.coach.token, body: { kind: 'term', subject_id: ath.id } }), 201).duplicate, true, 'a retry is the same open draft');
  assert.equal((await api('POST', `${P(a)}/${d.id}/issue`, { token: a.owner.token })).status, 409, 'a draft cannot be issued');
  must(await api('POST', `${P(a)}/${d.id}/submit`, { token: a.coach.token }));
  assert.equal((await api('POST', `${P(a)}/${d.id}/review`, { token: a.coach.token, body: { decision: 'approve', acknowledge_gaps: true } })).status, 403, 'a coach cannot approve');
  const sent = must(await api('POST', `${P(a)}/${d.id}/review`, { token: a.owner.token, body: { decision: 'request_changes', note: 'Add the studies band' } }));
  assert.equal(sent.status, 'draft'); assert.equal(sent.review_note, 'Add the studies band');
  must(await api('POST', `${P(a)}/${d.id}/submit`, { token: a.coach.token }));
  assert.equal((await api('POST', `${P(a)}/${d.id}/review`, { token: a.owner.token, body: { decision: 'approve' } })).status, 400, 'gaps must be acknowledged');
  const ok = must(await api('POST', `${P(a)}/${d.id}/review`, { token: a.owner.token, body: { decision: 'approve', acknowledge_gaps: true } }));
  assert.equal(ok.status, 'approved'); assert.equal(ok.gaps_acknowledged, true);
  const iss = must(await api('POST', `${P(a)}/${d.id}/issue`, { token: a.admin.token }), 201);
  assert.equal(iss.status, 'issued'); assert.ok(iss.document_id);
  assert.equal((await api('POST', `${P(a)}/${d.id}/issue`, { token: a.admin.token })).status, 409, 'issued once');
  const doc = (await pool.query('SELECT family, sha256 FROM generated_documents WHERE id=$1', [iss.document_id])).rows[0];
  assert.equal(doc.family, 'academy_term_report');
  const pdf = await file(ath, iss.document_id); assert.equal(pdf.status, 200); assert.equal(pdf.bytes.subarray(0, 4).toString(), '%PDF');
  await assert.rejects(pool.query("UPDATE academy_report_packs SET snapshot='{}' WHERE id=$1", [d.id]), /immutable/);
  await assert.rejects(pool.query("DELETE FROM academy_report_packs WHERE id=$1", [d.id]), /never deleted/);
  must(await api('POST', `${P(a)}/${d.id}/revoke`, { token: a.owner.token, body: { reason: 'Wrong term' } }));
  assert.equal((await file(ath, iss.document_id)).status, 404, 'the athlete loses the file at once');
  assert.equal((await file(a.owner, iss.document_id)).status, 200, 'owner/admin keep it for the record');
  assert.equal((await api('POST', `${P(a)}/${d.id}/revoke`, { token: a.owner.token, body: { reason: 'Again please' } })).status, 409);
  const full = must(await api('GET', `${P(a)}/${d.id}`, { token: a.owner.token }));
  assert.deepEqual(full.events.map((e) => e.action), ['drafted', 'submitted', 'changes_requested', 'submitted', 'approved', 'issued', 'delivered', 'revoked']);
  await assert.rejects(pool.query('DELETE FROM academy_report_pack_events'), /append-only/);
});

test('four-eyes: the person who drafted a report cannot approve it, even as owner; a new version supersedes without touching the old content', async () => {
  const a = await academy(); const { ath } = await athleteWithProgress(a);
  const d = must(await api('POST', P(a), { token: a.owner.token, body: { kind: 'progress', subject_id: ath.id } }), 201);
  must(await api('POST', `${P(a)}/${d.id}/submit`, { token: a.owner.token }));
  assert.equal((await api('POST', `${P(a)}/${d.id}/review`, { token: a.owner.token, body: { decision: 'approve', acknowledge_gaps: true } })).status, 403);
  await pool.query("INSERT INTO org_attendance(cohort_id, user_id, session_date, status, recorded_by) VALUES ($1,$2,current_date - 1,'absent',$3)", [a.cohort.id, ath.id, a.coach.id]);
  const v2 = must(await api('POST', `${P(a)}/${d.id}/new-version`, { token: a.admin.token }), 201);
  assert.equal(v2.version, 2); assert.equal(v2.supersedes_id, d.id);
  const old = must(await api('GET', `${P(a)}/${d.id}`, { token: a.owner.token }));
  assert.equal(old.status, 'superseded'); assert.equal(old.snapshot_sha, d.snapshot_sha);
  assert.equal((await api('POST', `${P(a)}/${d.id}/submit`, { token: a.owner.token })).status, 409);
});

test('guardian-safe: a verified guardian gets a notice with no figures and only the issued athlete report; finance, management and drafts never reach them', async () => {
  const a = await academy(); const { ath, guardian } = await athleteWithProgress(a, { youth: true });
  const d = must(await api('POST', P(a), { token: a.owner.token, body: { kind: 'progress', subject_id: ath.id } }), 201);
  assert.equal((await api('GET', `${P(a)}/${d.id}`, { token: guardian.token })).status, 404, 'a draft is invisible to the family');
  assert.deepEqual(must(await api('GET', `/academy/reports?athlete_id=${ath.id}`, { token: guardian.token })), []);
  must(await api('POST', `${P(a)}/${d.id}/submit`, { token: a.owner.token }));
  must(await api('POST', `${P(a)}/${d.id}/review`, { token: a.admin.token, body: { decision: 'approve', acknowledge_gaps: true } }));
  const iss = must(await api('POST', `${P(a)}/${d.id}/issue`, { token: a.admin.token }), 201);
  const notes = (await pool.query("SELECT user_id, title, body FROM notifications WHERE kind='academy_report'")).rows.filter((r) => r.user_id === guardian.id);
  assert.equal(notes.length, 1, 'the guardian is told once');
  assert.ok(!/\d{2,}%|INR|attendance/i.test(notes[0].title + notes[0].body), 'no figures in the message');
  assert.equal((await pool.query('SELECT 1 FROM notifications WHERE user_id=$1 AND kind=$2', [ath.id, 'academy_report'])).rowCount, 0, 'the young athlete is not the recipient');
  const mine = must(await api('GET', `/academy/reports?athlete_id=${ath.id}`, { token: guardian.token }));
  assert.equal(mine.length, 1); assert.equal(mine[0].status, 'issued'); assert.ok(mine[0].url); assert.equal(mine[0].snapshot, undefined); assert.equal(mine[0].gaps, undefined);
  assert.equal((await file(guardian, iss.document_id)).status, 200);
  assert.equal((await api('GET', `${P(a)}/${d.id}`, { token: guardian.token })).body.status, 'issued');
  assert.equal((await api('GET', P(a), { token: guardian.token })).status, 404, 'a guardian is not a member: no list');
  const stranger = await signup();
  assert.equal((await api('GET', `/academy/reports?athlete_id=${ath.id}`, { token: stranger.token })).status, 404);
  assert.equal((await file(stranger, iss.document_id)).status, 404);
  must(await api('POST', `${P(a)}/${d.id}/revoke`, { token: a.owner.token, body: { reason: 'Issued in error' } }));
  assert.equal((await file(guardian, iss.document_id)).status, 404);
  assert.equal(must(await api('GET', `/academy/reports?athlete_id=${ath.id}`, { token: guardian.token }))[0].url, null, 'withdrawn reports show as withdrawn with no link');
  const text = JSON.stringify((await pool.query('SELECT snapshot FROM academy_report_packs WHERE id=$1', [d.id])).rows[0].snapshot);
  assert.ok(!/INR |PRIVATE-|invoice number/i.test(text), 'no money or private notes in a guardian-safe report');
});

test('role matrix: coach drafts athlete reports for their own group only; finance only the finance pack; strangers and other academies get 404', async () => {
  const a = await academy(); const { ath } = await athleteWithProgress(a); const other = await academy(); const stranger = await signup();
  assert.equal((await api('POST', P(a), { token: a.coach.token, body: { kind: 'management' } })).status, 403);
  assert.equal((await api('POST', P(a), { token: a.coach.token, body: { kind: 'finance' } })).status, 403);
  assert.equal((await api('POST', P(a), { token: a.finance.token, body: { kind: 'management' } })).status, 403);
  assert.equal((await api('POST', P(a), { token: a.finance.token, body: { kind: 'term', subject_id: ath.id } })).status, 404);
  assert.equal((await api('POST', P(a), { token: other.owner.token, body: { kind: 'term', subject_id: ath.id } })).status, 404);
  assert.equal((await api('POST', P(a), { token: stranger.token, body: { kind: 'management' } })).status, 404);
  const fin = must(await api('POST', P(a), { token: a.finance.token, body: { kind: 'finance', from: `${today.slice(0, 4)}-01-01`, to: today } }), 201);
  assert.equal(fin.family ?? 'ok', 'ok'); assert.ok(fin.basis.basis.includes('Not statutory'));
  assert.equal((await api('GET', `${P(a)}/${fin.id}`, { token: a.coach.token })).status, 404, 'a coach cannot read the finance pack');
  assert.equal((await api('GET', `${P(a)}/${fin.id}`, { token: other.owner.token })).status, 404);
  assert.equal(must(await api('GET', P(a), { token: a.finance.token })).every((r) => r.kind === 'finance'), true);
  assert.equal(must(await api('GET', P(a), { token: a.coach.token })).length, 0);
  // after the coach leaves the group they can no longer draft or read that athlete
  const d = must(await api('POST', P(a), { token: a.coach.token, body: { kind: 'term', subject_id: ath.id } }), 201);
  await pool.query('UPDATE org_cohorts SET coach_id=NULL WHERE id=$1', [a.cohort.id]);
  assert.equal((await api('GET', `${P(a)}/${d.id}`, { token: a.coach.token })).status, 404);
  assert.equal((await api('POST', P(a), { token: a.coach.token, body: { kind: 'term', subject_id: ath.id } })).status, 404);
});

test('management, finance and campus packs: campus needs a real branch, small groups are suppressed, gaps are listed and the draft PDF is stamped', async () => {
  const a = await academy(); await athleteWithProgress(a);
  assert.equal((await api('POST', P(a), { token: a.owner.token, body: { kind: 'campus', subject_id: '00000000-0000-0000-0000-000000000000' } })).status, 404);
  const br = must(await api('POST', `/organisations/${a.org.id}/academy/branches`, { token: a.owner.token, body: { name: 'Manacor', city: 'Manacor', idempotency_key: key() } }), 201);
  const camp = must(await api('POST', P(a), { token: a.owner.token, body: { kind: 'campus', subject_id: br.id } }), 201);
  assert.ok(camp.gaps.some((g) => /No programme/.test(g.why)), 'an empty campus states the gap');
  await pool.query('UPDATE academy_programmes SET branch_id=$2 WHERE id=$1', [a.programme.id, br.id]);
  const camp2 = must(await api('POST', P(a), { token: a.owner.token, body: { kind: 'campus', subject_id: br.id } }), 201);
  const snap = JSON.stringify((await pool.query('SELECT snapshot FROM academy_report_packs WHERE id=$1', [camp2.id])).rows[0].snapshot);
  assert.ok(snap.includes('fewer than 3'), 'one athlete is never printed as a number');
  const m = must(await api('POST', P(a), { token: a.admin.token, body: { kind: 'management' } }), 201);
  assert.equal(m.audience.readers.includes('academy finance'), false);
  const r = await fetch(`${base}/api/v1/branded-documents/academy-pack/${m.id}/draft`, { headers: { authorization: `Bearer ${a.owner.token}` } });
  assert.equal(r.status, 200); assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
  const r2 = await fetch(`${base}/api/v1/branded-documents/academy-pack/${m.id}/draft`, { headers: { authorization: `Bearer ${a.coach.token}` } });
  assert.equal(r2.status, 404);
  assert.equal((await api('POST', P(a), { token: a.owner.token, body: { kind: 'management', from: today, to: '2000-01-01' } })).status, 400);
});

test('schedules only draft: the sweep is idempotent, runs under the creator\'s live authority and pauses when they lose it; nothing is issued', async () => {
  const a = await academy(); await athleteWithProgress(a); await athleteWithProgress(a);
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/report-schedules`, { token: a.coach.token, body: { kind: 'management', cadence: 'monthly' } })).status, 403);
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/report-schedules`, { token: a.owner.token, body: { kind: 'term', cadence: 'quarterly', scope: {} } })).status, 400, 'a group is required');
  const s = must(await api('POST', `/organisations/${a.org.id}/academy/report-schedules`, { token: a.owner.token, body: { kind: 'term', cadence: 'quarterly', scope: { cohort_id: a.cohort.id } } }), 201);
  assert.equal(await draftDueReports(), 2, 'one draft per enrolled athlete');
  assert.equal(await draftDueReports(), 0, 'safe to repeat');
  const packs = (await pool.query("SELECT status, schedule_id FROM academy_report_packs WHERE organisation_id=$1", [a.org.id])).rows;
  assert.equal(packs.length, 2); assert.ok(packs.every((p) => p.status === 'draft' && p.schedule_id === s.id));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM generated_documents WHERE source_type LIKE 'academy_%:'||$1", [a.org.id])).rows[0].n, 0, 'the scheduler never issues');
  assert.ok((await pool.query("SELECT 1 FROM notifications WHERE kind='academy_report' AND title LIKE 'Scheduled%'")).rowCount >= 1);
  const row = (await pool.query('SELECT next_run_on > current_date AS later FROM academy_report_schedules WHERE id=$1', [s.id])).rows[0];
  assert.equal(row.later, true);
  const upd = must(await api('PATCH', `/organisations/${a.org.id}/academy/report-schedules/${s.id}`, { token: a.owner.token, body: { row_version: (await pool.query('SELECT row_version FROM academy_report_schedules WHERE id=$1', [s.id])).rows[0].row_version, paused: true } }));
  assert.ok(upd.paused_at);
  assert.equal((await api('PATCH', `/organisations/${a.org.id}/academy/report-schedules/${s.id}`, { token: a.owner.token, body: { row_version: 1, paused: false } })).status, 409, 'stale edits are refused');
  // creator loses their role: the next due run pauses the schedule and makes nothing
  const s2 = must(await api('POST', `/organisations/${a.org.id}/academy/report-schedules`, { token: a.admin.token, body: { kind: 'management', cadence: 'monthly' } }), 201);
  await pool.query("UPDATE organisation_members SET status='left' WHERE organisation_id=$1 AND user_id=$2", [a.org.id, a.admin.id]);
  assert.equal(await draftDueReports(), 0);
  assert.ok((await pool.query('SELECT paused_at FROM academy_report_schedules WHERE id=$1', [s2.id])).rows[0].paused_at);
});

test('hub and parity: the hub is role-shaped, every capability exists once for REST and MCP, and the legacy direct PDF endpoints still work', async () => {
  const a = await academy();
  const own = must(await api('GET', `/organisations/${a.org.id}/academy/report-hub`, { token: a.owner.token }));
  assert.equal(own.kinds.length, 5); assert.ok(own.kinds.every((k) => k.can_draft)); assert.equal(own.can_review, true);
  const co = must(await api('GET', `/organisations/${a.org.id}/academy/report-hub`, { token: a.coach.token }));
  assert.deepEqual(co.kinds.filter((k) => k.can_draft).map((k) => k.kind), ['progress', 'term']); assert.equal(co.can_review, false);
  const fi = must(await api('GET', `/organisations/${a.org.id}/academy/report-hub`, { token: a.finance.token }));
  assert.deepEqual(fi.kinds.filter((k) => k.can_draft).map((k) => k.kind), ['finance']);
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/report-hub`, { token: (await signup()).token })).status, 404);
  const names = ['create_academy_report_pack', 'new_academy_report_pack_version', 'list_academy_report_packs', 'get_academy_report_pack', 'submit_academy_report_pack', 'review_academy_report_pack', 'issue_academy_report_pack', 'revoke_academy_report_pack', 'list_my_academy_reports', 'create_academy_report_schedule', 'list_academy_report_schedules', 'update_academy_report_schedule', 'get_academy_report_hub'];
  for (const nme of names) assert.equal(capabilities.filter((c) => c.name === nme).length, 1, nme);
  const spec = await (await fetch(`${base}/api/v1/openapi.json`)).text();
  for (const p of ['/report-packs', '/report-hub', '/report-schedules']) assert.ok(spec.includes(p), `OpenAPI lists ${p}`);
  const direct = must(await api('POST', `/organisations/${a.org.id}/academy/management-review`, { token: a.owner.token, body: {} }), 201);
  assert.equal(direct.family, 'academy_management_review', 'the existing one-step PDF still works');
  assert.deepEqual(must(await api('GET', `/organisations/${a.org.id}/academy/documents?kind=term&athlete_id=${(await signup()).id}`, { token: a.owner.token }).then((r) => (r.status === 404 ? { status: 200, body: [] } : r))), []);
});

test('subject search: staff see their academy\'s athletes, groups and campuses; a coach only their own group; strangers 404', async () => {
  const a = await academy(); const { ath } = await athleteWithProgress(a); const other = await academy(); await athleteWithProgress(other);
  const all = must(await api('GET', `/organisations/${a.org.id}/academy/report-subjects?what=athlete`, { token: a.owner.token }));
  assert.deepEqual(all.map((r) => r.value), [ath.id]);
  assert.equal(must(await api('GET', `/organisations/${a.org.id}/academy/report-subjects?what=athlete&q=zzzz`, { token: a.owner.token })).length, 0);
  assert.equal(must(await api('GET', `/organisations/${a.org.id}/academy/report-subjects?what=cohort`, { token: a.coach.token })).length, 1);
  await pool.query('UPDATE org_cohorts SET coach_id=NULL WHERE id=$1', [a.cohort.id]);
  assert.equal(must(await api('GET', `/organisations/${a.org.id}/academy/report-subjects?what=athlete`, { token: a.coach.token })).length, 0, 'a coach with no group sees no athletes');
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/report-subjects?what=athlete`, { token: a.finance.token })).status, 403);
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/report-subjects?what=athlete`, { token: other.owner.token })).status, 404);
});
