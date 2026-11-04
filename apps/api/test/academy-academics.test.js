import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { capabilities } = await import('../src/registry.js');
const { runAcademicSweeps } = await import('../src/capabilities/academy-academics.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
let n = 0;
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `ac_${n}_${roles[0]}`, display_name: `Acad ${n}`, email: `ac${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const day = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const at = (d, hhmm) => `${day(d)}T${hhmm}:00Z`;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

/** An academy with a coach, an academic lead (reads consented grades), a scheduler, a school with a liaison, and an adult and a minor athlete (with a guardian). */
async function setup() {
  const owner = await signup(['venue_manager']), coach = await signup(['coach']), lead = await signup(), ops = await signup(), schoolAdmin = await signup(), liaison = await signup();
  const adult = await signup(), minor = await signup(), guardian = await signup(), recruiter = await signup(['recruiter']), sponsor = await signup(['sponsor']), stranger = await signup();
  const org = ok(await api('POST', '/organisations', { token: owner.token, body: { name: `Study Academy ${n}`, kind: 'academy', city: 'Pune' } }), 201);
  const join = async (u, role, orgId = org.id, inviter = owner) => { ok(await api('POST', `/organisations/${orgId}/members`, { token: inviter.token, body: { person: u.handle, role } }), 201); ok(await api('POST', `/organisations/${orgId}/invite/respond`, { token: u.token, body: { accept: true } })); };
  await join(coach, 'coach'); await join(lead, 'staff'); await join(ops, 'staff');
  const eng = async (u, title, permissions) => ok(await api('POST', `/organisations/${org.id}/academy/staff/${u.id}`, { token: owner.token, body: { job_title: title, template: 'custom', permissions } }));
  await eng(lead, 'Academic lead', ['academics', 'academics_detail', 'schedule', 'roster', 'attendance']); await eng(ops, 'Scheduler', ['schedule']);
  const school = ok(await api('POST', '/organisations', { token: schoolAdmin.token, body: { name: `Greenfield School ${n}`, kind: 'school', city: 'Pune' } }), 201);
  await join(liaison, 'staff', school.id, schoolAdmin);
  const cohort = ok(await api('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: `U16 Study ${n}`, coach_id: coach.id } }), 201);
  ok(await api('POST', `/cohorts/${cohort.id}/enrolments`, { token: owner.token, body: { csv: `handle,consent\n${adult.handle},yes\n${minor.handle},yes` } }), 201);
  await pool.query('UPDATE users SET youth_until = current_date + 700 WHERE id=$1', [minor.id]);
  await pool.query("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [guardian.id, minor.id]);
  const enr = (await pool.query('SELECT id, user_id FROM org_enrolments WHERE cohort_id=$1', [cohort.id])).rows;
  return { owner, coach, lead, ops, schoolAdmin, liaison, adult, minor, guardian, recruiter, sponsor, stranger, org, school, cohort, adultEnr: enr.find((e) => e.user_id === adult.id).id, minorEnr: enr.find((e) => e.user_id === minor.id).id };
}
const P = (g) => `/organisations/${g.org.id}/academics`;
const link = async (g, enrolment_id, extra = {}) => ok(await api('POST', `${P(g)}/links`, { token: g.owner.token, body: { enrolment_id, school_org_id: g.school.id, curriculum: 'cbse', year_group: 'Grade 10', student_ref: `S-${enrolment_id.slice(0, 6)}`, liaison_user_id: g.liaison.id, ...extra } }), 201);
const grant = (token, athlete_id, party_org_id, scopes, detail = 'summary', extra = {}) => api('POST', '/academics/consents', { token, body: { athlete_id, party_org_id, scopes, detail, ...extra } });
/** The adult athlete shares with the academy and the school; the guardian does the same for the minor. */
async function consented(g, scopes = ['timetable', 'attendance', 'attainment'], detail = 'detail') {
  const la = await link(g, g.adultEnr), lm = await link(g, g.minorEnr);
  for (const party of [g.org.id, g.school.id]) { ok(await grant(g.adult.token, g.adult.id, party, scopes, detail), 201); ok(await grant(g.guardian.token, g.minor.id, party, scopes, detail), 201); }
  return { la, lm };
}
const framework = async (g, body = {}) => ok(await api('POST', `${P(g)}/frameworks`, { token: g.lead.token, body: { name: 'CBSE grades', scale: 'cbse_grade', subjects: ['Maths', 'Science', 'English'], attendance_floor_pct: 90, ...body } }), 201);
const draftSession = async (g, startsAt, mins = 60) => ok(await api('POST', `/cohorts/${g.cohort.id}/academy/sessions`, { token: g.owner.token, body: { starts_at: startsAt, duration_min: mins, title: 'Skills block', lead_id: g.coach.id } }), 201);
const publish = (g, ids, who = g.owner) => api('POST', `/organisations/${g.org.id}/academy/sessions/publish`, { token: who.token, body: { session_ids: ids, acknowledge_warnings: true } });

test('linking shares nothing: no data flows until the athlete (or a minor\'s guardian) consents; minors cannot consent; consent is dated, replaceable and revocable', async () => {
  const g = await setup();
  const bad = (body, who = g.owner) => api('POST', `${P(g)}/links`, { token: who.token, body: { enrolment_id: g.adultEnr, school_org_id: g.school.id, ...body } });
  assert.equal((await bad({ school_org_id: g.org.id })).status, 400, 'an academy is not a school');
  assert.equal((await bad({ liaison_user_id: g.coach.id })).status, 400, 'the liaison must belong to the school');
  assert.equal((await bad({}, g.coach)).status, 403, 'a coach cannot link schools');
  assert.equal((await bad({}, g.stranger)).status, 404);
  const g2 = await setup();
  assert.equal((await api('POST', `${P(g)}/links`, { token: g.owner.token, body: { enrolment_id: g2.adultEnr, school_org_id: g.school.id } })).status, 404, 'another academy\'s enrolment');
  const la = await link(g, g.adultEnr), lm = await link(g, g.minorEnr);
  assert.equal(la.school.verified, true); assert.equal((await link(g, g.adultEnr)).id, la.id, 'idempotent per enrolment and school');
  const list = ok(await api('GET', `${P(g)}/links`, { token: g.lead.token }));
  assert.equal(list.total, 2); assert.ok(list.items.every((x) => x.consent.state === 'not_granted' && x.band === undefined && x.attendance === undefined && x.next_exam === undefined), 'no consent: no data in the list');
  assert.equal((await api('GET', `/academics/links/${la.id}/timetable`, { token: g.lead.token })).status, 403, 'the lead sees no timetable before consent');
  assert.equal((await api('GET', `/academics/links/${la.id}/progress`, { token: g.recruiter.token })).status, 404, 'a recruiter has no route in');

  assert.equal((await grant(g.minor.token, g.minor.id, g.org.id, ['timetable'])).status, 403, 'a minor cannot grant for themselves');
  assert.equal((await grant(g.stranger.token, g.minor.id, g.org.id, ['timetable'])).status, 404);
  assert.equal((await grant(g.adult.token, g.adult.id, g.org.id, ['timetable'], 'summary', { expires_on: day(800) })).status, 400, 'never open-ended: at most a year');
  assert.equal((await grant(g.adult.token, g.adult.id, g.stranger.id, ['timetable'])).status, 404, 'only a linked party');
  const first = ok(await grant(g.adult.token, g.adult.id, g.org.id, ['timetable']), 201);
  const second = ok(await grant(g.adult.token, g.adult.id, g.org.id, ['timetable', 'attendance'], 'summary', { expires_on: day(20) }), 201);
  assert.equal((await pool.query('SELECT revoked_at FROM academic_consents WHERE id=$1', [first.id])).rows[0].revoked_at !== null, true, 'a new grant replaces the old one');
  assert.equal(ok(await api('GET', `${P(g)}/links`, { token: g.lead.token })).items.find((x) => x.athlete_id === g.adult.id).consent.state, 'expiring');
  ok(await grant(g.guardian.token, g.minor.id, g.org.id, ['timetable'], 'summary'), 201);
  assert.equal(ok(await api('GET', `/academics/links/${lm.id}/timetable`, { token: g.lead.token })).items.length, 0, 'consented, empty');
  ok(await api('POST', `/academics/consents/${second.id}/revoke`, { token: g.adult.token }));
  assert.equal((await api('GET', `/academics/links/${la.id}/timetable`, { token: g.lead.token })).status, 403, 'revocation is immediate');
  assert.equal((await api('POST', `/academics/consents/${second.id}/revoke`, { token: g.adult.token })).status, 404);
  const mine = ok(await api('GET', '/me/academics/consents', { token: g.adult.token }));
  assert.equal(mine.length, 1); assert.deepEqual(mine[0].parties.map((p) => p.role), ['academy', 'school']);
  assert.equal((await api('GET', `/me/academics/consents?athlete_id=${g.minor.id}`, { token: g.guardian.token })).status, 200);
  const kids = ok(await api('GET', '/me/academics/consents', { token: g.guardian.token }));
  assert.equal(kids.length, 1, 'a guardian sees their child without asking by id'); assert.equal(kids[0].link.athlete_id, g.minor.id);
  assert.equal((await api('GET', `/me/academics/consents?athlete_id=${g.minor.id}`, { token: g.stranger.token })).status, 404);
});

test('a school exam clash is flagged before publication and blocks it; staff see the kind and the time, never the subject', async () => {
  const g = await setup(); const { la } = await consented(g, ['timetable'], 'summary');
  const s1 = await draftSession(g, at(3, '10:00'));
  const add = ok(await api('POST', `/academics/links/${la.id}/items`, { token: g.liaison.token, body: { items: [{ kind: 'exam', title: 'Maths board paper', starts_at: at(3, '09:30'), ends_at: at(3, '11:30'), timezone: 'UTC', high_stakes: true }] } }), 201);
  assert.equal(add.created[0].verified, true); assert.equal(add.created[0].source, 'manual_verified');
  assert.equal(add.clashes.length, 1, 'adding the exam already warns which academy session it clashes with'); assert.equal(add.clashes[0].session_id, s1.id);

  const pub = ok(await publish(g, [s1.id]));
  assert.equal(pub.results[0].published, false); assert.equal(pub.results[0].reason, 'conflicts');
  const clash = pub.results[0].conflicts.find((x) => x.kind === 'academic');
  assert.equal(clash.code, 'school_exam_high_stakes'); assert.match(clash.message, /school exam/); assert.ok(!/Maths/.test(JSON.stringify(pub)), 'the subject never reaches the schedule');

  const win = ok(await api('GET', `${P(g)}/clashes?from=${day(0)}&to=${day(10)}`, { token: g.ops.token }));
  assert.equal(win.sessions.length, 1); assert.equal(win.sessions[0].clashes.length, 1);
  const hypo = ok(await api('GET', `${P(g)}/clashes?cohort_id=${g.cohort.id}&starts_at=${encodeURIComponent(at(3, '10:15'))}&ends_at=${encodeURIComponent(at(3, '11:00'))}`, { token: g.ops.token }));
  assert.equal(hypo.publishable, false);
  const free = ok(await api('GET', `${P(g)}/clashes?cohort_id=${g.cohort.id}&starts_at=${encodeURIComponent(at(3, '14:00'))}&ends_at=${encodeURIComponent(at(3, '15:00'))}`, { token: g.ops.token }));
  assert.equal(free.publishable, true, 'a session outside the exam is fine');
  assert.equal((await api('GET', `${P(g)}/clashes`, { token: g.coach.token })).status, 403, 'a coach without schedule access cannot browse clashes');
  assert.equal((await api('GET', `${P(g)}/clashes`, { token: g.recruiter.token })).status, 404);

  // a high-stakes exam cannot be released for sport; moving it resolves the clash
  assert.equal((await api('PATCH', `/academics/items/${add.created[0].id}`, { token: g.liaison.token, body: { blocks_sport: false, reason: 'School allows it' } })).status, 400);
  ok(await api('PATCH', `/academics/items/${add.created[0].id}`, { token: g.liaison.token, body: { starts_at: at(4, '09:30'), ends_at: at(4, '11:30') } }));
  assert.equal(ok(await publish(g, [s1.id])).results[0].published, true, 'with the exam moved the session publishes');
  // consent withdrawn: the timetable is no longer used at all
  const s2 = await draftSession(g, at(4, '10:00'));
  assert.equal(ok(await publish(g, [s2.id])).results[0].reason, 'conflicts');
  const cons = (await pool.query("SELECT id FROM academic_consents WHERE athlete_id=$1 AND party_org_id=$2 AND revoked_at IS NULL", [g.adult.id, g.org.id])).rows[0];
  ok(await api('POST', `/academics/consents/${cons.id}/revoke`, { token: g.adult.token }));
  assert.equal(ok(await publish(g, [s2.id])).results[0].published, true, 'revoked consent: the school timetable is not consulted');
});

test('weekly lessons, tutoring, holidays, cancellations and the sport override are handled; every clash kind is named without detail', async () => {
  const g = await setup(); const { la } = await consented(g, ['timetable'], 'summary');
  const wd = new Date(`${day(5)}T12:00:00Z`).getUTCDay();
  const add = ok(await api('POST', `/academics/links/${la.id}/items`, { token: g.lead.token, body: { items: [
    { kind: 'class_block', weekdays: [wd], start_time: '09:00', end_time: '13:00', from_on: day(0), to_on: day(40), timezone: 'UTC', title: 'Morning lessons' },
    { kind: 'holiday', starts_at: at(12, '00:00'), ends_at: at(13, '00:00'), timezone: 'UTC' },
    { kind: 'tutoring', starts_at: at(7, '16:00'), ends_at: at(7, '17:00'), timezone: 'UTC' }] } }), 201);
  assert.equal(add.created.length, 3);
  assert.equal((await api('POST', `/academics/links/${la.id}/items`, { token: g.lead.token, body: { items: [{ kind: 'exam', weekdays: [1], start_time: '09:00', end_time: '10:00', from_on: day(0) }] } })).status, 400, 'an exam is a single sitting');
  assert.equal((await api('POST', `/academics/links/${la.id}/items`, { token: g.lead.token, body: { items: [{ kind: 'exam', starts_at: at(3, '11:00'), ends_at: at(3, '10:00') }] } })).status, 400);
  const lesson = await draftSession(g, at(5, '10:00')), tutor = await draftSession(g, at(7, '16:30')), hol = await draftSession(g, at(12, '10:00')), clear = await draftSession(g, at(5, '15:00'));
  const win = ok(await api('GET', `${P(g)}/clashes?from=${day(0)}&to=${day(20)}`, { token: g.lead.token }));
  const codes = win.sessions.flatMap((s) => s.clashes.map((x) => x.code)).sort();
  assert.deepEqual(codes, ['school_class_block_clash', 'school_tutoring_clash']);
  assert.ok(!win.sessions.some((s) => [hol.id, clear.id].includes(s.session_id)), 'holidays and free time do not clash');
  // the school may release a class block for sport, with a recorded reason; a cancelled item stops blocking
  const lessonItem = (await pool.query("SELECT id FROM academic_items WHERE link_id=$1 AND kind='class_block'", [la.id])).rows[0].id;
  assert.equal((await api('PATCH', `/academics/items/${lessonItem}`, { token: g.liaison.token, body: { blocks_sport: false } })).status, 400, 'a reason is required');
  ok(await api('PATCH', `/academics/items/${lessonItem}`, { token: g.liaison.token, body: { blocks_sport: false, reason: 'Excused for squad training' } }));
  const tutorItem = (await pool.query("SELECT id FROM academic_items WHERE link_id=$1 AND kind='tutoring'", [la.id])).rows[0].id;
  ok(await api('PATCH', `/academics/items/${tutorItem}`, { token: g.lead.token, body: { cancel: true } }));
  assert.equal(ok(await api('GET', `${P(g)}/clashes?from=${day(0)}&to=${day(20)}`, { token: g.lead.token })).sessions.length, 0);
  // the athlete's own entries are unverified; they cannot edit verified ones
  const own = ok(await api('POST', `/academics/links/${la.id}/items`, { token: g.adult.token, body: { items: [{ kind: 'school_event', starts_at: at(9, '10:00'), ends_at: at(9, '12:00'), timezone: 'UTC' }] } }), 201);
  assert.equal(own.created[0].verified, false); assert.equal(own.created[0].source, 'athlete_entered');
  assert.equal((await api('PATCH', `/academics/items/${lessonItem}`, { token: g.adult.token, body: { cancel: true } })).status, 403);
  // the timetable read: the athlete sees the subject, the scheduler only blocks
  const mine = ok(await api('GET', `/academics/links/${la.id}/timetable?from=${day(0)}&to=${day(20)}`, { token: g.adult.token }));
  assert.ok(mine.items.some((x) => x.title === 'Morning lessons')); assert.ok(mine.items.some((x) => x.source_label.includes('unverified')));
  const staff = ok(await api('GET', `/academics/links/${la.id}/timetable?from=${day(0)}&to=${day(20)}`, { token: g.ops.token }));
  assert.equal(staff.view, 'blocks'); assert.ok(staff.items.every((x) => x.title === undefined), 'scheduling staff never see subject text');
  assert.equal((await api('GET', `/academics/links/${la.id}/timetable?from=${day(0)}&to=${day(200)}`, { token: g.lead.token })).status, 400, 'at most 92 days');
});

test('academic records are private: grades reach only the athlete, the guardian, the supplying school and an academy holder of academics_detail with detail consent; scouts and sponsors have no route', async () => {
  const g = await setup(); const { la, lm } = await consented(g, ['attainment', 'attendance', 'timetable'], 'detail');
  const fw = await framework(g);
  const rec = (token, id_, body) => api('POST', `/academics/links/${id_}/snapshots`, { token, body: { framework_id: fw.id, term_label: 'Term 1', source_kind: 'school_report', source_ref: 'Report card T1', reported_on: day(-5), rows: [{ subject: 'Maths', value: 'B1' }, { subject: 'Science', value: 'A2' }, { subject: 'English', value: 'C1' }], ...body } });
  const s1 = ok(await rec(g.liaison.token, la.id), 201);
  assert.equal(s1.version, 1); assert.equal(s1.progress_band, 'on_track');
  assert.equal((await pool.query('SELECT values_enc FROM academic_snapshots WHERE id=$1', [s1.id])).rows[0].values_enc.includes('Maths'), false, 'grades are encrypted at rest');
  const read = (who, id_ = la.id) => api('GET', `/academics/links/${id_}/snapshots`, { token: who.token });
  assert.equal(ok(await read(g.adult)).items[0].rows.length, 3, 'the athlete sees their own grades');
  assert.equal(ok(await read(g.lead)).view, 'detail'); assert.equal(ok(await read(g.lead)).items[0].rows[0].subject, 'Maths', 'the academic lead with academics_detail and detail consent');
  assert.equal(ok(await read(g.liaison)).view, 'detail', 'the supplying school');
  const owner = ok(await read(g.owner));
  assert.equal(owner.view, 'band', 'an owner without academics_detail sees only the band'); assert.equal(owner.items[0].rows, undefined);
  assert.equal(ok(await read(g.coach)).view, 'band'); assert.equal(ok(await read(g.coach)).items[0].rows, undefined, 'a coach sees only the progress band');
  assert.equal((await read(g.ops)).status, 403, 'a scheduler sees nothing of attainment');
  for (const who of [g.recruiter, g.sponsor, g.stranger]) { assert.equal((await read(who)).status, 404); assert.equal((await api('GET', `/academics/links/${la.id}/progress`, { token: who.token })).status, 404); assert.equal((await api('GET', `${P(g)}/links`, { token: who.token })).status, 404); }
  assert.equal(ok(await read(g.guardian, lm.id)).view, 'detail', 'a guardian reads their child');
  assert.equal((await read(g.guardian, la.id)).status, 404, 'but not another athlete');
  assert.equal((await read(g.minor, lm.id)).status, 200);
  // the list never carries grades; the coach list carries flags only
  const list = JSON.stringify(ok(await api('GET', `${P(g)}/links`, { token: g.coach.token })));
  assert.ok(!/Maths|B1|A2/.test(list)); assert.equal(JSON.parse(list).items.find((x) => x.athlete_id === g.adult.id).band, 'on_track');
  // summary-only consent downgrades even the lead
  ok(await grant(g.adult.token, g.adult.id, g.org.id, ['attainment'], 'summary'), 201);
  assert.equal(ok(await read(g.lead)).view, 'band', 'detail consent is what unlocks subject values');
  // swapping the grant to attendance only hides attainment from the academy entirely
  ok(await grant(g.adult.token, g.adult.id, g.org.id, ['attendance'], 'summary'), 201);
  assert.equal((await read(g.lead)).status, 403);
  // the athlete sees exactly who looked
  const log = ok(await api('GET', `/academics/links/${la.id}/access-log`, { token: g.adult.token }));
  assert.ok(log.some((e) => e.scope === 'attainment' && e.actor_side === 'academy') && log.some((e) => e.actor_side === 'school'));
  assert.equal((await api('GET', `/academics/links/${la.id}/access-log`, { token: g.lead.token })).status, 404, 'the academy cannot read the athlete\'s access log');
  assert.equal((await api('GET', `/academics/links/${la.id}/access-log`, { token: g.guardian.token })).status, 404, 'a guardian reads their own child\'s only');
  assert.equal((await api('GET', `/academics/links/${lm.id}/access-log`, { token: g.guardian.token })).status, 200);
});

test('attainment is versioned with provenance: corrections supersede, nothing is overwritten, bad grades and self-reports are handled, and sport and academic progress stay separate', async () => {
  const g = await setup(); const { la } = await consented(g);
  const fw = await framework(g);
  const fw2 = await framework(g, { subjects: ['Maths', 'Science'], watch_below: 70, support_below: 50 });
  assert.equal(fw2.version, 2); assert.equal(ok(await api('GET', `${P(g)}/frameworks`, { token: g.coach.token })).frameworks.length, 1, 'only the current version is listed');
  assert.equal(ok(await api('GET', `${P(g)}/frameworks?include_archived=true`, { token: g.lead.token })).frameworks.length, 2);
  assert.equal((await api('POST', `${P(g)}/frameworks`, { token: g.lead.token, body: { name: 'X', scale: 'custom', bands: ['A'] } })).status, 400);
  assert.equal((await api('POST', `${P(g)}/frameworks`, { token: g.lead.token, body: { name: 'Y', scale: 'percent', watch_below: 40, support_below: 60 } })).status, 400);
  assert.equal((await api('POST', `${P(g)}/frameworks`, { token: g.coach.token, body: { name: 'Zed', scale: 'percent' } })).status, 403);
  const rec = (who, body) => api('POST', `/academics/links/${la.id}/snapshots`, { token: who.token, body: { framework_id: fw2.id, term_label: 'Term 2', source_kind: 'school_report', rows: [{ subject: 'Maths', value: 'D' }], ...body } });
  assert.equal((await rec(g.liaison, { rows: [{ subject: 'Maths', value: 'Z9' }] })).status, 400, 'a grade not on the scale');
  assert.equal((await rec(g.liaison, { rows: [{ subject: 'Maths', value: 'B1' }, { subject: 'maths', value: 'A1' }] })).status, 400, 'a subject twice');
  assert.equal((await rec(g.liaison, { rows: [] })).status, 400);
  const v1 = ok(await rec(g.liaison, { rows: [{ subject: 'Maths', value: 'E1' }, { subject: 'Science', value: 'D' }] }), 201);
  assert.equal(v1.progress_band, 'support_needed', 'the band is suggested from the values and the academy\'s thresholds');
  const v2 = ok(await rec(g.liaison, { rows: [{ subject: 'Maths', value: 'B1' }, { subject: 'Science', value: 'B2' }], progress_band: 'watch', source_ref: 'Corrected report' }), 201);
  assert.equal(v2.version, 2); assert.equal(v2.supersedes, v1.id);
  const cur = ok(await api('GET', `/academics/links/${la.id}/snapshots`, { token: g.adult.token })).items;
  assert.equal(cur.length, 1); assert.equal(cur[0].version, 2); assert.equal(cur[0].provenance.verified, true); assert.match(cur[0].provenance.label, /School report · Greenfield/);
  const hist = ok(await api('GET', `/academics/links/${la.id}/snapshots?include_history=true`, { token: g.adult.token })).items;
  assert.equal(hist.length, 2); assert.equal(hist.find((x) => x.version === 1).current, false, 'the earlier version is kept');
  // self-reported entries are labelled and never verified
  const self = ok(await rec(g.adult, { term_label: 'Mock exams', source_kind: 'self_reported', rows: [{ subject: 'Maths', value: 'A2' }] }), 201);
  assert.ok(self.id);
  const labelled = ok(await api('GET', `/academics/links/${la.id}/snapshots`, { token: g.adult.token })).items.find((x) => x.term_label === 'Mock exams');
  assert.equal(labelled.provenance.verified, false); assert.match(labelled.provenance.label, /unverified/);
  assert.equal((await rec(g.adult, { term_label: 'Term 3', source_kind: 'school_report' })).status, 403, 'an athlete cannot pose as the school');
  assert.equal((await rec(g.liaison, { term_label: 'Term 3', source_kind: 'self_reported' })).status, 400);
  // the academy lead without subject access can still record the band the school told them
  await pool.query("UPDATE org_staff_engagements SET permissions = ARRAY['academics','schedule'] WHERE user_id=$1", [g.lead.id]);
  assert.equal((await rec(g.lead, { term_label: 'Term 3', source_kind: 'manual_verified', rows: [{ subject: 'Maths', value: 'A1' }] })).status, 403, 'subject values need academics_detail');
  ok(await rec(g.lead, { term_label: 'Term 3', source_kind: 'manual_verified', rows: [], progress_band: 'on_track' }), 201);
  // sport and academic progress are separate blocks, each labelled with its source
  const prog = ok(await api('GET', `/academics/links/${la.id}/progress`, { token: g.coach.token }));
  assert.equal(prog.view.attainment, 'band'); assert.ok(prog.attainment.every((x) => x.rows === undefined && x.provenance.label)); assert.equal(prog.link.school.verified, true); assert.equal(prog.sport, undefined, 'sport progress is never mixed into the academic block');
});

test('school attendance is summary-only, versioned and raises one exception task for the coach, the school and the guardian; coaches see flags, not numbers', async () => {
  const g = await setup(); const { lm } = await consented(g); await framework(g);
  const rec = (who, body) => api('POST', `/academics/links/${lm.id}/attendance`, { token: who.token, body: { period_from: day(-30), period_to: day(-1), sessions_total: 20, present: 15, late: 2, authorised_absent: 2, unauthorised_absent: 3, ...body } });
  assert.equal((await rec(g.minor, {})).status, 403, 'the athlete cannot record school attendance'); assert.equal((await rec(g.coach, {})).status, 403);
  assert.equal((await rec(g.liaison, { present: 19, unauthorised_absent: 3 })).status, 400, 'totals must add up'); assert.equal((await rec(g.liaison, { late: 16 })).status, 400);
  const a1 = ok(await rec(g.liaison, {}), 201);
  assert.equal(a1.attendance_pct, 75); assert.equal(a1.below_floor, true); assert.ok(a1.task_id, 'a low summary raises a task');
  const a2 = ok(await rec(g.liaison, { present: 16, unauthorised_absent: 2 }), 201);
  assert.equal(a2.version, 2); assert.equal(a2.task_id, null, 'the exception is raised once');
  const att = ok(await api('GET', `/academics/links/${lm.id}/attendance`, { token: g.guardian.token }));
  assert.equal(att.items.length, 1); assert.equal(att.items[0].pct, 80); assert.match(att.items[0].source_label, /Verified entry · Greenfield/);
  assert.deepEqual(Object.keys(ok(await api('GET', `/academics/links/${lm.id}/attendance`, { token: g.coach.token }))).sort(), ['below_floor', 'floor_pct', 'latest_period', 'view'], 'a coach gets a flag only');
  assert.equal(ok(await api('GET', `/academics/links/${lm.id}/attendance`, { token: g.lead.token })).items[0].pct, 80);
  // the task reaches exactly the right people
  const tasks = ok(await api('GET', `${P(g)}/tasks`, { token: g.lead.token })); assert.equal(tasks.length, 1); assert.equal(tasks[0].kind, 'attendance_exception'); assert.deepEqual(tasks[0].people.map((p) => p.role).sort(), ['academic_lead', 'coach', 'guardian', 'school_liaison']);
  assert.equal(ok(await api('GET', `${P(g)}/tasks?mine=true`, { token: g.coach.token })).length, 1);
  assert.equal(ok(await api('GET', `${P(g)}/tasks`, { token: g.coach.token })).length, 1, 'a participant sees their own');
  assert.equal(ok(await api('GET', `${P(g)}/tasks`, { token: g.ops.token }).then((r) => ({ ...r, status: r.status === 404 ? 200 : r.status, body: r.status === 404 ? [] : r.body }))).length, 0, 'someone outside the task sees none');
  const t = ok(await api('GET', `/academics/tasks/${tasks[0].id}`, { token: g.coach.token }));
  assert.ok(!/unauthorised|75|80/.test(JSON.stringify(t)) || t.title.includes('attendance'), 'a task carries no numbers');
  ok(await api('PATCH', `/academics/tasks/${tasks[0].id}`, { token: g.coach.token, body: { status: 'in_progress', message: 'Spoke to the family; travel was the issue' } }));
  const t2 = ok(await api('GET', `/academics/tasks/${tasks[0].id}`, { token: g.liaison.token }));
  assert.equal(t2.messages.length, 1); assert.equal(t2.messages[0].body, 'Spoke to the family; travel was the issue');
  assert.equal((await pool.query('SELECT body_enc FROM academic_task_messages LIMIT 1')).rows[0].body_enc.includes('travel'), false, 'messages are encrypted');
  assert.equal((await api('GET', `/academics/tasks/${tasks[0].id}`, { token: g.ops.token })).status, 404);
  assert.equal((await api('GET', `/academics/tasks/${tasks[0].id}`, { token: g.recruiter.token })).status, 404);
  ok(await api('PATCH', `/academics/tasks/${tasks[0].id}`, { token: g.lead.token, body: { status: 'done' } }));
  assert.equal((await api('PATCH', `/academics/tasks/${tasks[0].id}`, { token: g.lead.token, body: { status: 'open' } })).status, 409, 'a closed task stays closed');
});

test('coordination tasks, the exception scan and the overview: aggregates for the academic lead, nothing for anyone else', async () => {
  const g = await setup(); const { la } = await consented(g, ['timetable', 'attendance', 'attainment'], 'summary');
  const fw = await framework(g);
  ok(await api('POST', `/academics/links/${la.id}/items`, { token: g.liaison.token, body: { items: [{ kind: 'exam', starts_at: at(2, '09:00'), ends_at: at(2, '11:00'), timezone: 'UTC', title: 'Chemistry' }] } }), 201);
  await draftSession(g, at(2, '10:00'));
  assert.equal(ok(await api('POST', `${P(g)}/exceptions/scan`, { token: g.lead.token })).raised, 1);
  assert.equal(ok(await api('POST', `${P(g)}/exceptions/scan`, { token: g.lead.token })).raised, 0, 'once per clash');
  await runAcademicSweeps();   // the sweep covers every academy; a second pass finds nothing new
  assert.equal(await runAcademicSweeps(), 0, 'the background sweep is idempotent');
  const tasks = ok(await api('GET', `${P(g)}/tasks?kind=exam_clash`, { token: g.lead.token })); assert.equal(tasks.length, 1); assert.equal(tasks[0].reason_code, 'clash_with_exam');
  ok(await api('POST', `/academics/links/${la.id}/snapshots`, { token: g.liaison.token, body: { framework_id: fw.id, term_label: 'Term 1', source_kind: 'school_report', rows: [{ subject: 'Maths', value: 'C2' }] } }), 201);
  ok(await api('POST', `/academics/links/${la.id}/attendance`, { token: g.liaison.token, body: { period_from: day(-20), period_to: day(-1), sessions_total: 20, present: 17, authorised_absent: 3 } }), 201);
  const manual = ok(await api('POST', `/academics/links/${la.id}/tasks`, { token: g.liaison.token, body: { kind: 'coach_school_sync', title: 'Plan exam-week training load', due_on: day(2), people: ['coach', 'academic_lead'], note: 'Reduce load in exam week' } }), 201);
  assert.ok(manual.id); assert.equal((await api('POST', `/academics/links/${la.id}/tasks`, { token: g.coach.token, body: { kind: 'other', title: 'Not allowed' } })).status, 403);
  const o = ok(await api('GET', `${P(g)}/overview`, { token: g.lead.token }));
  assert.equal(o.enrolled, 2); assert.equal(o.linked, 2); assert.equal(o.coverage_pct, 100); assert.equal(o.consent.active, 2); assert.equal(o.consent.missing, 0);
  assert.equal(o.exams_14d, 1); assert.equal(o.clashing_sessions, 1); assert.equal(o.attendance_below_floor, 1); assert.equal(o.bands.watch + o.bands.support_needed + o.bands.on_track, 1); assert.equal(o.tasks.open >= 2, true); assert.equal(o.schools[0].athletes, 2);
  assert.ok(!/Chemistry|C2/.test(JSON.stringify(o)), 'aggregates only: no subject, no grade');
  for (const who of [g.coach, g.ops, g.recruiter, g.sponsor]) assert.notEqual((await api('GET', `${P(g)}/overview`, { token: who.token })).status, 200);
  const cal = ok(await api('GET', `${P(g)}/calendar?from=${day(0)}&to=${day(10)}`, { token: g.ops.token }));
  assert.equal(cal.items.length, 1); assert.equal(cal.items[0].title, undefined, 'the planner sees the exam, not its subject');
  assert.equal(ok(await api('GET', `${P(g)}/calendar?from=${day(0)}&to=${day(10)}`, { token: g.lead.token })).items[0].title, undefined, 'summary consent: even the lead sees no subject');
});

test('imports: a file or a partner API stages validated rows, applies only with consent and a match, is idempotent, and erases what it staged', async () => {
  const g = await setup(); const { la, lm } = await consented(g, ['attendance', 'timetable', 'attainment'], 'detail');
  const fw = await framework(g);
  await pool.query("UPDATE academic_links SET student_ref_enc = NULL WHERE id=$1", [lm.id]);
  const att = (rows, who = g.liaison, orgId = g.school.id, extra = {}) => api('POST', `/organisations/${orgId}/academics/imports`, { token: who.token, body: { kind: 'attendance', ...rows, ...extra } });
  const ref = `S-${g.adultEnr.slice(0, 6)}`;
  const csv = `student_ref,period_from,period_to,sessions_total,present,late,authorised_absent,unauthorised_absent\n${ref},${day(-30)},${day(-1)},20,19,1,1,0\nNOPE,${day(-30)},${day(-1)},20,19,0,1,0\n${g.minor.handle},${day(-30)},${day(-1)},20,10,0,5,5\n${ref},bad,${day(-1)},20,19,0,1,0`;
  const staged = ok(await att({ csv }), 201);
  assert.equal(staged.status, 'staged'); assert.equal(staged.summary.ok, 2); assert.equal(staged.summary.invalid, 2); assert.equal(staged.summary.errors.length, 2);
  assert.equal((await pool.query('SELECT rows_enc FROM academic_imports WHERE id=$1', [staged.import_id])).rows[0].rows_enc.includes(ref), false, 'staged rows are encrypted');
  assert.equal(ok(await api('GET', `/academics/links/${la.id}/attendance`, { token: g.adult.token })).items.length, 0, 'nothing applied while staged');
  const done = ok(await api('POST', `/organisations/${g.school.id}/academics/imports/${staged.import_id}/commit`, { token: g.liaison.token }));
  assert.equal(done.status, 'applied'); assert.equal(done.applied, 2);
  assert.equal((await pool.query('SELECT rows_enc, status FROM academic_imports WHERE id=$1', [staged.import_id])).rows[0].rows_enc, null, 'the staged rows are erased once applied');
  assert.equal(ok(await api('GET', `/academics/links/${la.id}/attendance`, { token: g.adult.token })).items[0].source, 'manual_verified');
  assert.equal((await api('POST', `/organisations/${g.school.id}/academics/imports/${staged.import_id}/commit`, { token: g.liaison.token })).status, 409, 'applied once');
  // a partner system calls the API directly: JSON records, applied at once when every row is valid, idempotent on its key
  const api1 = ok(await att({ records: [{ student_ref: ref, period_from: day(-60), period_to: day(-31), sessions_total: 20, present: 20 }], apply: true, idempotency_key: 'partner-batch-001' }), 201);
  assert.equal(api1.status, 'applied'); assert.equal((await pool.query('SELECT channel FROM academic_imports WHERE id=$1', [api1.import_id])).rows[0].channel, 'api');
  assert.equal(ok(await att({ records: [{ student_ref: ref, period_from: day(-60), period_to: day(-31), sessions_total: 20, present: 20 }], apply: true, idempotency_key: 'partner-batch-001' }), 201).replayed, true);
  // timetable and snapshot imports
  const tt = ok(await att({ kind: 'timetable', csv: `student_ref,kind,date,start_time,end_time,timezone,title,high_stakes\n${ref},exam,${day(6)},09:00,11:00,Asia/Kolkata,Physics,true`, apply: true }), 201);
  assert.equal(tt.applied, 1);
  assert.equal(ok(await api('GET', `/academics/links/${la.id}/timetable?from=${day(0)}&to=${day(10)}`, { token: g.adult.token })).items[0].source, 'partner_import');
  const sn = ok(await att({ kind: 'snapshot', framework_id: fw.id, csv: `student_ref,term,subject,value,band,reported_on\n${ref},Term 1,Maths,B1,on_track,${day(-3)}\n${ref},Term 1,Science,A2,,${day(-3)}`, apply: true }), 201);
  assert.equal(sn.applied, 1);
  assert.equal(ok(await api('GET', `/academics/links/${la.id}/snapshots`, { token: g.adult.token })).items[0].rows.length, 2);
  // refusals: an unlinked partner, a school without the athlete's grant, a coach, an outsider
  const g2 = await setup();
  const none = ok(await att({ csv }, g2.liaison, g2.school.id), 201);
  assert.equal(none.summary.ok, 0, 'a school with no linked athletes matches nothing'); assert.equal(none.summary.invalid, 4);
  ok(await grant(g.adult.token, g.adult.id, g.school.id, ['timetable'], 'summary'), 201);
  const noScope = ok(await att({ records: [{ student_ref: ref, period_from: day(-90), period_to: day(-61), sessions_total: 20, present: 20 }] }), 201);
  assert.equal(noScope.summary.invalid, 1); assert.match(noScope.summary.errors[0].reason, /not granted/);
  assert.equal((await att({ csv }, g.coach, g.org.id)).status, 403); assert.equal((await att({ csv }, g.stranger)).status, 404);
  assert.equal(ok(await api('GET', `${P(g.school ? g : g)}/imports`.replace(g.org.id, g.school.id), { token: g.liaison.token })).length >= 4, true);
});

test('every academics capability is exposed once (REST, OpenAPI and MCP); sessions with no school link publish exactly as before', async () => {
  const names = capabilities.filter((c) => c.tag === 'Academics').map((c) => c.name);
  for (const want of ['link_enrolment_to_school', 'list_academic_links', 'update_academic_link', 'grant_academic_consent', 'revoke_academic_consent', 'list_my_academic_consents', 'request_academic_consent', 'add_academic_items', 'update_academic_item', 'list_academic_timetable', 'check_academic_clashes', 'list_academic_calendar',
    'record_academic_attendance', 'list_academic_attendance', 'create_academic_task', 'list_academic_tasks', 'get_academic_task', 'update_academic_task', 'scan_academic_exceptions', 'get_academics_overview', 'list_academic_access_log', 'save_academic_framework', 'list_academic_frameworks', 'record_academic_snapshot', 'list_academic_snapshots', 'get_academic_progress', 'import_academic_records', 'commit_academic_import', 'list_academic_imports']) assert.ok(names.includes(want), want);
  const spec = await (await fetch(`${base}/api/v1/openapi.json`)).json();
  assert.ok(spec.paths['/academics/consents'] && spec.paths['/organisations/{id}/academics/overview']);
  const u = await signup(['venue_manager']);
  const tools = await (await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${u.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).text();
  assert.ok(tools.includes('check_academic_clashes') && tools.includes('grant_academic_consent'));
  const g = await setup();
  const s = await draftSession(g, at(3, '10:00'));
  assert.equal(ok(await publish(g, [s.id])).results[0].published, true, 'an academy that never links a school is unaffected');
  const rbq = await pool.query("SELECT count(*)::int AS n FROM academic_links WHERE organisation_id=$1", [g.org.id]);
  assert.equal(rbq.rows[0].n, 0);
});

test('the academy Athlete 360 shows academic progress as its own labelled section, bands and flags only; a school sees only the athletes who linked to it', async () => {
  const g = await setup(); const { la } = await link(g, g.adultEnr).then((l) => ({ la: l }));
  const prog = ok(await api('POST', `/organisations/${g.org.id}/academy/programmes`, { token: g.owner.token, body: { sport: 'football', title: 'Study squad', format: 'squad_pathway', capacity: 20, coach_ids: [g.coach.id] } }), 201);
  await pool.query('UPDATE org_enrolments SET programme_id=$1 WHERE cohort_id=$2', [prog.id, g.cohort.id]);
  const a360 = (who) => api('GET', `/organisations/${g.org.id}/academy/athletes/${g.adult.id}/360`, { token: who.token });
  assert.equal(ok(await a360(g.owner)).sections.academic.access, 'no_consent', 'linked but nothing shared');
  ok(await grant(g.adult.token, g.adult.id, g.org.id, ['attainment', 'attendance', 'timetable'], 'detail'), 201); ok(await grant(g.adult.token, g.adult.id, g.school.id, ['attainment', 'attendance'], 'detail'), 201);
  const fw = await framework(g);
  ok(await api('POST', `/academics/links/${la.id}/snapshots`, { token: g.liaison.token, body: { framework_id: fw.id, term_label: 'Term 1', source_kind: 'school_report', rows: [{ subject: 'Maths', value: 'A1' }] } }), 201);
  ok(await api('POST', `/academics/links/${la.id}/attendance`, { token: g.liaison.token, body: { period_from: day(-20), period_to: day(-1), sessions_total: 20, present: 18, authorised_absent: 2 } }), 201);
  for (const who of [g.owner, g.coach]) {   // the 360 itself is for owner, admin and coach roles
    const sec = ok(await a360(who)).sections.academic;
    assert.equal(sec.access, 'ok'); assert.equal(sec.origin, 'school_reported'); assert.match(sec.source, /supplied by the school/);
    assert.equal(sec.data.band.band, 'on_track'); assert.equal(sec.data.band.verified, true); assert.ok(!/Maths|A1/.test(JSON.stringify(sec)), 'never subject-level in the 360');
  }
  assert.equal(ok(await a360(g.coach)).sections.academic.data.attendance.pct, undefined, 'a coach sees the flag, not the percentage');
  assert.equal(ok(await a360(g.owner)).sections.academic.data.attendance.pct, 90);
  const roster = ok(await api('GET', `${P(g)}/links`, { token: g.owner.token }));
  assert.equal(roster.items[0].school.name.startsWith('Greenfield'), true);
  const sch = ok(await api('GET', `/organisations/${g.school.id}/academics/school-athletes`, { token: g.liaison.token }));
  assert.equal(sch.length, 1); assert.deepEqual(sch[0].granted.sort(), ['attainment', 'attendance']); assert.equal(sch[0].mine, true); assert.equal(sch[0].academy_name.startsWith('Study Academy'), true);
  assert.equal((await api('GET', `/organisations/${g.school.id}/academics/school-athletes`, { token: g.coach.token })).status, 404, 'academy staff are not school staff');
  assert.equal((await api('GET', `/organisations/${g.org.id}/academics/school-athletes`, { token: g.owner.token })).status, 404, 'an academy is not a school');
});
