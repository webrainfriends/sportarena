// Academy academics & school integration (#783): verified school links, consent-gated school timetable, exam / lesson clashes before publication, school attendance
// exceptions, restricted attainment snapshots, coordination tasks, bulk and partner submission. Happy and negative paths against real tables; no fixtures in the repo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { capabilities } = await import('../src/registry.js');

let server, base, admin, n = 0;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const must = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const code = (r) => r.body?.error?.details?.code ?? r.body?.details?.code ?? r.body?.code;
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const signup = async (roles = ['athlete'], dob = yearsAgo(30)) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `ax_${n}_${roles[0]}`, display_name: `Ax ${n}`, email: `ax${n}@example.com`, password: 'correct-horse-battery', roles, dob } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const key = () => `k-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const iso = (d, h = 10) => { const x = new Date(Date.now() + d * 86400e3); x.setUTCHours(h, 0, 0, 0); return x.toISOString(); };
const dayOf = (d) => iso(d).slice(0, 10);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('ax_root','ax_root','{admin}','x','x','ax_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const join = async (org, owner, u, role) => {
  must(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role } }), 201);
  must(await api('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } }));
};
/** An academy with owner, coach (attendance only) and an education coordinator (academics + academic_records), a programme and a cohort. */
async function academy() {
  const owner = await signup(['coach']), coach = await signup(['coach']), edu = await signup(['coach']), liaison = await signup(['coach']);
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Academics Academy ${++n}`, kind: 'academy' } }), 201);
  must(await api('PATCH', `/organisations/${org.id}/academy`, { token: owner.token, body: { row_version: 0, sports: ['football'], currency: 'GBP', listed: true } }));
  await join(org, owner, coach, 'coach'); await join(org, owner, edu, 'staff'); await join(org, owner, liaison, 'staff');
  must(await api('POST', `/organisations/${org.id}/academy/staff/${edu.id}`, { token: owner.token, body: { job_title: 'Education coordinator', template: 'education_coordinator' } }));
  must(await api('POST', `/organisations/${org.id}/academy/staff/${liaison.id}`, { token: owner.token, body: { job_title: 'School liaison', template: 'school_liaison' } }));
  const prog = must(await api('POST', `/organisations/${org.id}/academy/programmes`, { token: owner.token, body: { sport: 'football', title: `Dev ${n}`, capacity: 20, admission_mode: 'direct', public: true } }), 201);
  must(await api('POST', `/academy/programmes/${prog.id}/versions`, { token: owner.token, body: { row_version: prog.row_version, billing_model: 'free', currency: 'GBP', fee_minor: 0 } }), 201);
  const cohort = must(await api('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: `Group ${n}`, coach_id: coach.id } }), 201);
  await pool.query('UPDATE org_cohorts SET programme_id=$2 WHERE id=$1', [cohort.id, prog.id]);
  return { owner, coach, edu, liaison, org, programme: prog, cohort };
}
async function school(name = 'Hillcrest College', kind = 'school') {
  const head = await signup(['coach']);
  const org = must(await api('POST', '/organisations', { token: head.token, body: { name: `${name} ${++n}`, kind } }), 201);
  await pool.query("UPDATE organisations SET approval_status='approved' WHERE id=$1", [org.id]);
  return { head, org };
}
const enrol = async (a, u) => {
  const app = must(await api('POST', `/academy/programmes/${a.programme.id}/applications`, { token: u.token, body: {} }), 201);
  must(await api('POST', `/academy/applications/${app.id}/submit`, { token: u.token, body: { row_version: app.row_version, answers: {} } }));
  const e = (await pool.query("SELECT e.id FROM org_enrolments e WHERE e.user_id=$1 AND e.status='enrolled' LIMIT 1", [u.id])).rows[0];
  await pool.query('UPDATE org_enrolments SET cohort_id=$2 WHERE id=$1', [e.id, a.cohort.id]);
  return e.id;
};
const link = async (a, enrolmentId, s, extra = {}) => must(await api('POST', `/academy/enrolments/${enrolmentId}/school-links`, { token: a.owner.token, body: { school_org_id: s.org.id, year_group: 'Year 11', idempotency_key: key(), ...extra } }), 201);
const share = (u, a, level, enabled = true, athleteId) => api('POST', '/me/academy/academics/share', { token: u.token, body: { organisation_id: a.org.id, level, enabled, ...(athleteId ? { athlete_id: athleteId } : {}) } });
const session = async (a, { status = 'draft', startsAt = iso(3, 10), hours = 1 } = {}) => {
  const s = (await pool.query(
    `INSERT INTO academy_sessions(organisation_id, cohort_id, programme_id, title, starts_at, ends_at, status, created_by) VALUES ($1,$2,$3,'Training',$4,$4::timestamptz + make_interval(hours => $5),$6,$7) RETURNING *`,
    [a.org.id, a.cohort.id, a.programme.id, startsAt, hours, status, a.owner.id])).rows[0];
  await pool.query("INSERT INTO academy_session_staff(session_id, user_id, role, status, assigned_by) VALUES ($1,$2,'lead','confirmed',$3)", [s.id, a.coach.id, a.owner.id]);   // staffed, so only school findings can need acknowledgement
  return s;
};
const publish = (a, ids, ack = false) => api('POST', `/organisations/${a.org.id}/academy/sessions/publish`, { token: a.owner.token, body: { session_ids: ids, acknowledge_warnings: ack } });
const exam = (token, linkId, startsAt, mins = 120, extra = {}) => api('POST', `/academy/school-links/${linkId}/blocks`, { token, body: { kind: 'exam', recurrence: 'once', starts_at: startsAt, ends_at: new Date(new Date(startsAt).getTime() + mins * 60000).toISOString(), label: 'Mathematics paper 2', source_ref: 'Exam board timetable 2026', ...extra } });
const framework = async (a, key = 'a_level') => must(await api('POST', `/organisations/${a.org.id}/academy/academics/frameworks`, { token: a.edu.token, body: { key, name: 'A-level A*–E', kind: 'letter', scale: { grades: ['A*', 'A', 'B', 'C', 'D', 'E', 'U'] }, pass_mark: 'E' } }), 201);

test('a verified school links to an enrolment without duplicating the institution; unverified, wrong-kind and outsiders are refused', async () => {
  const a = await academy(); const s = await school();
  const ath = await signup(); const e = await enrol(a, ath);
  const found = must(await api('GET', `/organisations/${a.org.id}/academy/schools?q=Hillcrest`, { token: a.edu.token }));
  assert.ok(found.schools.some((x) => x.id === s.org.id));
  const l = await link(a, e, s, { student_ref: 'HC-2291', provision: 'partner_school' });
  assert.equal(l.school.id, s.org.id); assert.equal(l.school.name, s.org.name);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM organisations WHERE name=$1', [s.org.name])).rows[0].n, 1, 'no second institution identity');
  assert.ok(!(await pool.query('SELECT student_ref_enc FROM academy_school_links WHERE id=$1', [l.id])).rows[0].student_ref_enc.includes('HC-2291'), 'student reference is ciphertext');
  assert.equal((await api('POST', `/academy/enrolments/${e}/school-links`, { token: a.owner.token, body: { school_org_id: s.org.id, idempotency_key: key() } })).status, 409, 'one live link per school');
  const club = must(await api('POST', '/organisations', { token: a.owner.token, body: { name: `Some Club ${++n}`, kind: 'club' } }), 201);
  assert.equal((await api('POST', `/academy/enrolments/${e}/school-links`, { token: a.owner.token, body: { school_org_id: club.id, idempotency_key: key() } })).status, 404, 'only schools / colleges / universities');
  const raw = await school('Unverified School'); await pool.query("UPDATE organisations SET approval_status='pending' WHERE id=$1", [raw.org.id]);
  assert.equal((await api('POST', `/academy/enrolments/${e}/school-links`, { token: a.owner.token, body: { school_org_id: raw.org.id, idempotency_key: key() } })).status, 409, 'unverified school');
  const outsider = await signup(['coach']);
  assert.equal((await api('POST', `/academy/enrolments/${e}/school-links`, { token: outsider.token, body: { school_org_id: s.org.id, idempotency_key: key() } })).status, 404, 'outsiders learn nothing');
  assert.equal((await api('POST', `/academy/enrolments/${e}/school-links`, { token: a.coach.token, body: { school_org_id: raw.org.id, idempotency_key: key() } })).status, 403, 'a coach has no academics grant');
  const list = must(await api('GET', `/organisations/${a.org.id}/academy/school-links`, { token: a.edu.token }));
  assert.equal(list.links.length, 1); assert.deepEqual(list.links[0].shared, { schedule: false, progress: false, consent: true });
});

test('school information is held only after the athlete (or a verified guardian with academic consent) allows it, and withdrawing hides it at once', async () => {
  const a = await academy(); const s = await school();
  const ath = await signup(); const l = await link(a, await enrol(a, ath), s);
  const blocked = await exam(a.edu.token, l.id, iso(5, 9));
  assert.equal(blocked.status, 409); assert.equal(code(blocked), 'academic_share_required');
  must(await share(ath, a, 'schedule'));
  must(await exam(a.edu.token, l.id, iso(5, 9)), 201);
  assert.equal(must(await api('GET', `/organisations/${a.org.id}/academy/school-blocks?from=${dayOf(0)}&to=${dayOf(10)}`, { token: a.edu.token })).items.length, 1);
  must(await share(ath, a, 'schedule', false));
  assert.equal(must(await api('GET', `/organisations/${a.org.id}/academy/school-blocks?from=${dayOf(0)}&to=${dayOf(10)}`, { token: a.edu.token })).items.length, 0, 'withdrawn = hidden at once');
  assert.equal((await exam(a.edu.token, l.id, iso(6, 9))).status, 409);
  assert.equal((await share(await signup(), a, 'schedule', true, ath.id)).status, 403, 'a stranger cannot share for someone else');

  // a young person: the guardian must be verified and academic consent current
  const kid = await signup(['athlete'], yearsAgo(14));
  const parent = await signup();
  const gl = must(await api('POST', '/youth/guardian-links', { token: parent.token, body: { guardian_id: parent.id, child_id: kid.id, relationship: 'parent' } }), 201);
  must(await api('POST', `/youth/guardian-links/${gl.id}/respond`, { token: kid.token, body: { accept: true } }));
  must(await api('POST', `/youth/guardian-links/${gl.id}/evidence`, { token: parent.token, body: { evidence: { reference: 'https://example.com/birth-certificate-ref-123', label: 'Birth certificate' } } }), 201);
  must(await api('POST', `/youth/guardian-links/${gl.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Documents match' } }));
  must(await api('POST', `/youth/children/${kid.id}/consents`, { token: parent.token, body: { purpose: 'participation' } }), 201);
  const app = must(await api('POST', `/academy/programmes/${a.programme.id}/applications`, { token: parent.token, body: { athlete_id: kid.id } }), 201);
  must(await api('POST', `/academy/applications/${app.id}/submit`, { token: parent.token, body: { row_version: app.row_version, answers: {} } }));
  const kenrol = (await pool.query("SELECT id FROM org_enrolments WHERE user_id=$1 AND status='enrolled'", [kid.id])).rows[0].id;
  const kl = await link(a, kenrol, s);
  const noConsent = await share(parent, a, 'schedule', true, kid.id);
  assert.equal(noConsent.status, 409); assert.equal(code(noConsent), 'guardian_consent_required');
  assert.equal((await share(kid, a, 'schedule', true, kid.id)).status, 403, 'a young person cannot share for themselves');
  must(await api('POST', `/youth/children/${kid.id}/consents`, { token: parent.token, body: { purpose: 'academic' } }), 201);
  must(await share(parent, a, 'schedule', true, kid.id));
  must(await exam(a.edu.token, kl.id, iso(7, 9)), 201);
  must(await api('DELETE', `/youth/children/${kid.id}/consents/academic`, { token: parent.token }));
  assert.equal(must(await api('GET', `/organisations/${a.org.id}/academy/school-blocks?from=${dayOf(0)}&to=${dayOf(10)}&athlete_id=${kid.id}`, { token: a.edu.token })).items.length, 0, 'revoking the guardian consent hides it');
});

test('a school exam clash is flagged and refuses publication until the athlete is excused; lessons clash, study overlaps only warn', async () => {
  const a = await academy(); const s = await school();
  const ath = await signup(); const l = await link(a, await enrol(a, ath), s);
  must(await share(ath, a, 'schedule'));
  must(await exam(a.edu.token, l.id, iso(3, 10), 120), 201);                                   // 10:00–12:00 on day+3
  const clash = await session(a, { startsAt: iso(3, 11) });                                       // 11:00–12:00
  const near = await session(a, { startsAt: iso(3, 12) });                                        // 12:00: inside the 60 min rest buffer
  const free = await session(a, { startsAt: iso(3, 16) });
  const out = must(await publish(a, [clash.id]));
  assert.equal(out.results[0].published, false); assert.equal(out.results[0].reason, 'conflicts');
  assert.equal(out.results[0].conflicts[0].code, 'school_exam_clash'); assert.ok(out.results[0].conflicts[0].message.includes('school exam'));
  assert.ok(!JSON.stringify(out).includes('Mathematics'), 'subject is never shown to schedulers');
  const scan = must(await api('GET', `/organisations/${a.org.id}/academy/academics/clashes?from=${dayOf(0)}&to=${dayOf(10)}`, { token: a.owner.token }));
  assert.equal(scan.open_clashes, 1);
  assert.equal(must(await publish(a, [free.id])).results[0].published, true);
  // rest buffer only warns and needs acknowledgement
  const w = must(await publish(a, [near.id])).results[0];
  assert.equal(w.published, false); assert.match(w.reason, /acknowledg/);
  assert.equal(must(await publish(a, [near.id], true)).results[0].published, true);
  // resolve: excuse the athlete, then publish; the roster shows excused for school
  const blockId = out.results[0].conflicts[0].block_id;
  assert.equal((await api('POST', `/academy/sessions/${clash.id}/academic-clashes`, { token: a.coach.token, body: { athlete_id: ath.id, block_id: blockId } })).status, 403, 'only schedulers resolve');
  must(await api('POST', `/academy/sessions/${clash.id}/academic-clashes`, { token: a.owner.token, body: { athlete_id: ath.id, block_id: blockId, note: 'GCSE paper' } }));
  const done = must(await publish(a, [clash.id])).results[0];
  assert.equal(done.published, true); assert.equal(done.school_excused, 1);
  const att = (await pool.query('SELECT status, reason_code FROM academy_attendance WHERE session_id=$1 AND user_id=$2', [clash.id, ath.id])).rows[0];
  assert.deepEqual({ ...att }, { status: 'excused', reason_code: 'school' });
  // a weekly school day clashes by local weekday and time; a skipped holiday does not
  const wk = new Date(iso(9, 9)).getUTCDay();
  must(await api('POST', `/academy/school-links/${l.id}/blocks`, { token: a.edu.token, body: { kind: 'school_day', recurrence: 'weekly', weekday: wk, start_time: '08:30', end_time: '15:30', valid_from: dayOf(0), valid_to: dayOf(60), skip_dates: [dayOf(16)], timezone: 'UTC' } }), 201);
  const lesson = await session(a, { startsAt: iso(9, 10) }), holiday = await session(a, { startsAt: iso(16, 10) });
  assert.equal(must(await publish(a, [lesson.id])).results[0].conflicts[0].code, 'school_commitment_clash');
  assert.equal(must(await publish(a, [holiday.id])).results[0].published, true, 'skipped holiday date');
  // tutoring overlap only warns
  must(await api('POST', `/academy/school-links/${l.id}/blocks`, { token: a.edu.token, body: { kind: 'tutoring', recurrence: 'once', starts_at: iso(11, 17), ends_at: iso(11, 18), source_ref: 'Tutor Ms Rao' } }), 201);
  const tut = await session(a, { startsAt: iso(11, 17) });
  const tr = must(await publish(a, [tut.id])).results[0]; assert.equal(tr.published, false); assert.equal(tr.academic_warnings[0].code, 'school_study_overlap');
});

test('withdrawn permission or an ended link stops clashes being inferred; a new exam on a published session raises one task', async () => {
  const a = await academy(); const s = await school();
  const ath = await signup(); const l = await link(a, await enrol(a, ath), s);
  must(await share(ath, a, 'schedule'));
  const pub = await session(a, { status: 'published', startsAt: iso(4, 10) });
  const r = must(await exam(a.edu.token, l.id, iso(4, 10), 90), 201);
  assert.equal(r.clashes_with_published_sessions, 1);
  must(await exam(a.edu.token, l.id, iso(4, 10), 90), 201);
  const tasks = must(await api('GET', `/organisations/${a.org.id}/academy/academic-tasks`, { token: a.edu.token }));
  assert.equal(tasks.tasks.filter((t) => t.kind === 'exam_clash').length, 1, 'deduplicated per session, athlete and block');
  void pub;
  must(await share(ath, a, 'schedule', false));
  const after = must(await api('GET', `/organisations/${a.org.id}/academy/academics/clashes?from=${dayOf(0)}&to=${dayOf(10)}`, { token: a.owner.token }));
  assert.equal(after.open_clashes, 0, 'nothing is inferred once the permission is withdrawn');
});

test('school attendance exceptions raise one follow-up task and a correction withdraws it; only academics staff record it', async () => {
  const a = await academy(); const s = await school();
  const ath = await signup(); const l = await link(a, await enrol(a, ath), s);
  const body = { period_from: dayOf(-60), period_to: dayOf(-1), sessions_possible: 50, present: 40, authorised_absence: 5, unauthorised_absence: 5, source: 'school_confirmed', source_ref: 'Autumn registers' };
  assert.equal((await api('POST', `/academy/school-links/${l.id}/attendance`, { token: a.edu.token, body })).status, 409, 'not shared yet');
  must(await share(ath, a, 'schedule'));
  assert.equal((await api('POST', `/academy/school-links/${l.id}/attendance`, { token: a.coach.token, body })).status, 403);
  assert.equal((await api('POST', `/academy/school-links/${l.id}/attendance`, { token: a.edu.token, body: { ...body, present: 60 } })).status, 400, 'present beyond sessions possible');
  const r = must(await api('POST', `/academy/school-links/${l.id}/attendance`, { token: a.edu.token, body }), 201);
  assert.equal(r.percent, 80); assert.equal(r.exception.length, 2);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM academy_academic_tasks WHERE kind='attendance_exception' AND status='open'")).rows[0].n, 1);
  must(await api('POST', `/academy/school-links/${l.id}/attendance`, { token: a.edu.token, body }), 201);   // same period again: still one task
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM academy_academic_tasks WHERE kind='attendance_exception' AND status='open'")).rows[0].n, 1);
  const dash = must(await api('GET', `/organisations/${a.org.id}/academy/academics`, { token: a.edu.token }));
  assert.equal(dash.kpis.attendance_exceptions, 1); assert.equal(dash.exceptions[0].source_label, 'Confirmed by the school');
  must(await api('POST', `/academy/school-links/${l.id}/attendance`, { token: a.edu.token, body: { ...body, present: 47, unauthorised_absence: 1, authorised_absence: 2 } }), 201);   // correction
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM academy_academic_tasks WHERE kind='attendance_exception' AND status='open'")).rows[0].n, 0, 'cleared by the correction');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM academy_school_attendance WHERE link_id=$1', [l.id])).rows[0].n, 3, 'append-only history');
  await assert.rejects(pool.query('UPDATE academy_school_attendance SET present=1'), /append-only/);
  const cur = must(await api('GET', `/academy/school-links/${l.id}/attendance`, { token: a.edu.token }));
  assert.equal(cur.periods.length, 1); assert.equal(cur.periods[0].present, 47);
});

test('grades are encrypted, versioned, visible only to academic_records staff and the family; other staff, other academies and unlisted readers get nothing', async () => {
  const a = await academy(); const s = await school();
  const ath = await signup(); const l = await link(a, await enrol(a, ath), s);
  const fw = await framework(a);
  const snap = { term_label: 'Autumn 2026', period_from: dayOf(-90), period_to: dayOf(-1), framework_id: fw.id, entries: [{ subject: 'Mathematics', grade: 'A', target: 'A*', effort: 4 }, { subject: 'Physics', grade: 'B' }], comment: 'Strong progress in mechanics.', standing: 'on_track', source: 'school_report', source_ref: 'Autumn report, issued 12 Dec', source_date: dayOf(-5), idempotency_key: key() };
  assert.equal((await api('POST', `/academy/school-links/${l.id}/snapshots`, { token: a.edu.token, body: snap })).status, 409, 'progress not shared yet');
  must(await share(ath, a, 'progress'));
  assert.equal((await api('POST', `/academy/school-links/${l.id}/snapshots`, { token: a.liaison.token, body: snap })).status, 403, 'academics without academic_records');
  assert.equal((await api('POST', `/academy/school-links/${l.id}/snapshots`, { token: a.edu.token, body: { ...snap, entries: [{ subject: 'Maths', grade: 'Z' }], idempotency_key: key() } })).status, 400, 'grade must belong to the framework');
  const v1 = must(await api('POST', `/academy/school-links/${l.id}/snapshots`, { token: a.edu.token, body: snap }), 201);
  assert.equal(v1.version, 1);
  assert.equal(must(await api('POST', `/academy/school-links/${l.id}/snapshots`, { token: a.edu.token, body: snap }), 201).replayed, true, 'idempotent');
  const v2 = must(await api('POST', `/academy/school-links/${l.id}/snapshots`, { token: a.edu.token, body: { ...snap, entries: [{ subject: 'Mathematics', grade: 'A*' }], standing: 'on_track', visibility: 'education_staff', source_ref: 'Autumn report, corrected', idempotency_key: key() } }), 201);
  assert.equal(v2.version, 2);
  const raw = (await pool.query('SELECT entries_enc, comment_enc FROM academy_academic_snapshots WHERE id=$1', [v1.id])).rows[0];
  assert.ok(!raw.entries_enc.includes('Mathematics') && !raw.comment_enc.includes('mechanics'), 'ciphertext only');
  await assert.rejects(pool.query('DELETE FROM academy_academic_snapshots'), /append-only/);
  const full = must(await api('GET', `/academy/school-links/${l.id}/snapshots?all_versions=true`, { token: a.edu.token }));
  assert.equal(full.snapshots.length, 2); assert.equal(full.snapshots[0].entries[0].grade, 'A*'); assert.equal(full.snapshots[1].source_label, 'School report'); assert.ok(full.snapshots[1].framework.name);
  const restricted = must(await api('GET', `/academy/school-links/${l.id}/snapshots`, { token: a.liaison.token }));
  assert.equal(restricted.snapshots[0].restricted, true); assert.ok(!JSON.stringify(restricted).match(/"grade"|"entries"|Mathematics|mechanics|on_track|standing/));
  assert.equal((await api('GET', `/academy/school-links/${l.id}/snapshots`, { token: a.coach.token })).status, 403, 'an ordinary coach cannot read them');
  assert.equal((await api('GET', `/academy/school-links/${l.id}/snapshots`, { token: (await academy()).owner.token })).status, 404, 'another academy gets 404');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='read_pii' AND entity='academy_academic_snapshots'", [a.edu.id])).rowCount > 0, 'decrypting is audit-logged');
  // the family sees only the version marked visible to them (latest per term is v2: staff only -> nothing)
  const mine = must(await api('GET', '/me/academy/academics', { token: ath.token }));
  assert.equal(mine.links[0].snapshots.length, 0);
  assert.equal(mine.links[0].shared.progress, true);
  // the owner (admin of the academy) sees the grades; withdrawing hides them from staff at once
  assert.equal(must(await api('GET', `/academy/school-links/${l.id}/snapshots`, { token: a.owner.token })).can_read_grades, true);
  must(await share(ath, a, 'progress', false));
  assert.equal(must(await api('GET', `/academy/school-links/${l.id}/snapshots`, { token: a.owner.token })).snapshots.length, 0);
  // grades never surface through sponsor / recruitment / passport surfaces
  const spon = await signup(['sponsor']);
  const sweep = JSON.stringify(await Promise.all([api('GET', `/athletes/${ath.id}/passport`, { token: spon.token }), api('GET', `/users/${ath.handle}`, { token: spon.token })]));
  assert.ok(!sweep.match(/Mathematics|Autumn 2026|academy_academic/));
});

test('coordination tasks: assignee sees only their own, can progress but not reassign; notes are encrypted; no grades required', async () => {
  const a = await academy(); const s = await school();
  const ath = await signup(); const l = await link(a, await enrol(a, ath), s);
  const t = must(await api('POST', `/organisations/${a.org.id}/academy/academic-tasks`, { token: a.edu.token, body: { athlete_id: ath.id, link_id: l.id, kind: 'coach_school_liaison', audience: 'coach', title: 'Agree training load around mocks', note: 'Call the head of year first.', due_on: dayOf(-1), assignee_id: a.coach.id, idempotency_key: key() } }), 201);
  assert.equal(t.overdue, true);
  assert.ok(!(await pool.query('SELECT note_enc FROM academy_academic_tasks WHERE id=$1', [t.id])).rows[0].note_enc.includes('head of year'));
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/academic-tasks`, { token: a.coach.token, body: { athlete_id: ath.id, kind: 'other', audience: 'coach', title: 'Sneaky task', idempotency_key: key() } })).status, 403);
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/academic-tasks`, { token: a.edu.token, body: { athlete_id: ath.id, kind: 'other', audience: 'coach', title: 'Outside assignee', assignee_id: (await signup()).id, idempotency_key: key() } })).status, 400);
  const mine = must(await api('GET', `/organisations/${a.org.id}/academy/academic-tasks`, { token: a.coach.token }));
  assert.equal(mine.scope, 'assigned_to_me'); assert.equal(mine.tasks.length, 1); assert.equal(mine.tasks[0].note, 'Call the head of year first.');
  assert.equal((await api('PATCH', `/academy/academic-tasks/${t.id}`, { token: a.coach.token, body: { row_version: t.row_version, assignee_id: a.edu.id } })).status, 403);
  const done = must(await api('PATCH', `/academy/academic-tasks/${t.id}`, { token: a.coach.token, body: { row_version: t.row_version, status: 'done' } }));
  assert.equal(done.status, 'done');
  assert.equal((await api('PATCH', `/academy/academic-tasks/${t.id}`, { token: a.coach.token, body: { row_version: t.row_version, status: 'open' } })).status, 409, 'stale row_version');
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/academic-tasks?status=all`, { token: a.edu.token })).body.tasks.length, 1);
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/academic-tasks`, { token: (await signup()).token })).status, 404);
});

test('bulk entry previews without writing, commits atomically and idempotently; a school submits only for students the academy authorised', async () => {
  const a = await academy(); const s = await school(); const other = await school('Other School');
  const ath = await signup(), ath2 = await signup();
  const l = await link(a, await enrol(a, ath), s, { student_ref: 'S-100', import_authorised: true }), l2 = await link(a, await enrol(a, ath2), other, { student_ref: 'S-200' });
  must(await share(ath, a, 'schedule')); must(await share(ath2, a, 'schedule'));
  const row = (ref, extra = {}) => ({ type: 'block', link_id: ref, block: { kind: 'lesson', recurrence: 'once', starts_at: iso(2, 9), ends_at: iso(2, 10), source_ref: 'Term timetable', ...extra } });
  const good = { rows: [row(l.id), { type: 'attendance', link_id: l.id, attendance: { period_from: dayOf(-30), period_to: dayOf(-1), sessions_possible: 20, present: 19, source_ref: 'Registers' } }], idempotency_key: key() };
  const pre = must(await api('POST', `/organisations/${a.org.id}/academy/school-records/import`, { token: a.edu.token, body: { ...good, mode: 'preview' } }));
  assert.equal(pre.accepted, 2); assert.equal((await pool.query('SELECT count(*)::int AS n FROM academy_school_blocks WHERE organisation_id=$1', [a.org.id])).rows[0].n, 0, 'preview writes nothing');
  const bad = { ...good, rows: [...good.rows, row(l.id, { ends_at: iso(2, 8) })], idempotency_key: key(), mode: 'commit' };
  const rej = await api('POST', `/organisations/${a.org.id}/academy/school-records/import`, { token: a.edu.token, body: bad });
  assert.equal(rej.status, 409); assert.equal((await pool.query('SELECT count(*)::int AS n FROM academy_school_blocks WHERE organisation_id=$1', [a.org.id])).rows[0].n, 0, 'all or nothing');
  const ok = must(await api('POST', `/organisations/${a.org.id}/academy/school-records/import`, { token: a.edu.token, body: { ...good, mode: 'commit' } }));
  assert.equal(ok.accepted, 2);
  assert.equal(must(await api('POST', `/organisations/${a.org.id}/academy/school-records/import`, { token: a.edu.token, body: { ...good, mode: 'commit' } })).replayed, true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM academy_school_blocks WHERE organisation_id=$1', [a.org.id])).rows[0].n, 1);
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/school-records/import`, { token: a.coach.token, body: { ...good, idempotency_key: key() } })).status, 403);
  // partner submission
  const feed = { mode: 'commit', idempotency_key: key(), rows: [{ type: 'attendance', student_ref: 'S-100', attendance: { period_from: dayOf(-30), period_to: dayOf(-1), sessions_possible: 20, present: 12, unauthorised_absence: 6, source_ref: 'MIS export' } }] };
  const sub = must(await api('POST', `/organisations/${s.org.id}/school-records`, { token: s.head.token, body: feed }));
  assert.equal(sub.accepted, 1);
  assert.equal((await pool.query("SELECT source FROM academy_school_attendance WHERE link_id=$1 ORDER BY created_at DESC LIMIT 1", [l.id])).rows[0].source, 'partner_import');
  const notAuthorised = await api('POST', `/organisations/${other.org.id}/school-records`, { token: other.head.token, body: { ...feed, idempotency_key: key() } });
  assert.equal(notAuthorised.status, 409, 'the academy has not authorised this school');
  const cross = await api('POST', `/organisations/${s.org.id}/school-records`, { token: s.head.token, body: { ...feed, idempotency_key: key(), mode: 'preview', rows: [{ ...feed.rows[0], student_ref: 'S-200' }] } });
  assert.equal(must(cross).rejected, 1, 'a school cannot reach another school\'s student');
  assert.equal((await api('POST', `/organisations/${s.org.id}/school-records`, { token: (await signup()).token, body: feed })).status, 404);
  void l2;
});

test('settings are owner/admin only; the desk reports coverage and never grades; every capability is exposed over MCP and OpenAPI', async () => {
  const a = await academy(); const s = await school();
  const ath = await signup(); await link(a, await enrol(a, ath), s);
  assert.equal((await api('PATCH', `/organisations/${a.org.id}/academy/academics/settings`, { token: a.edu.token, body: { attendance_threshold_pct: 95 } })).status, 403);
  assert.equal(must(await api('PATCH', `/organisations/${a.org.id}/academy/academics/settings`, { token: a.owner.token, body: { attendance_threshold_pct: 95, exam_buffer_min: 90 } })).attendance_threshold_pct, 95);
  const d = must(await api('GET', `/organisations/${a.org.id}/academy/academics`, { token: a.liaison.token }));
  assert.equal(d.kpis.linked, 1); assert.equal(d.kpis.consent_pending, 1); assert.equal(d.kpis.snapshots_due, null, 'grades-related figures are hidden without academic_records');
  assert.equal(d.my_access.academic_records, false);
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/academics`, { token: a.coach.token })).status, 403);
  const names = capabilities.filter((c) => /academic|school/.test(c.name) && c.tag === 'Academy academics').map((c) => c.name);
  assert.ok(names.length >= 20, `expected the full academics surface, found ${names.length}`);
  const spec = must(await api('GET', '/openapi.json'));
  const ops = new Set(Object.values(spec.paths).flatMap((p) => Object.values(p).map((o) => o.operationId)));
  for (const nme of names) assert.ok(ops.has(nme), `${nme} missing from OpenAPI`);
});
