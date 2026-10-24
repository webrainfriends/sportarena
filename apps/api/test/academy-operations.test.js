import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { addDays, fromLocal } = await import('../src/booking/time.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
let n = 0;
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `ao_${n}_${roles[0]}`, display_name: `Ao ${n}`, email: `ao${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const today = new Date().toISOString().slice(0, 10);
const dow = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
const key = () => `k-${Math.random().toString(36).slice(2)}-${Date.now()}`;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

/** An academy with a director, an admin, two coaches, a generic staff member, finance, a cohort and three enrolled athletes. */
async function academy({ athletes = 3 } = {}) {
  const owner = await signup(), admin = await signup(), coach = await signup(['coach']), coach2 = await signup(['coach']), staff = await signup(), finance = await signup();
  const org = ok(await api('POST', '/organisations', { token: owner.token, body: { name: `Riverside ${n}`, kind: 'academy' } }), 201);
  for (const [u, role] of [[admin, 'admin'], [coach, 'coach'], [coach2, 'coach'], [staff, 'staff'], [finance, 'finance']]) {
    ok(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role } }), 201);
    ok(await api('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } }));
  }
  const cohort = ok(await api('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: 'U12 Football', coach_id: coach.id } }), 201);
  const players = [];
  for (let k = 0; k < athletes; k++) players.push(await signup());
  ok(await api('POST', `/cohorts/${cohort.id}/enrolments`, { token: owner.token, body: { csv: `handle,consent\n${players.map((p) => `${p.handle},yes`).join('\n')}` } }), 201);
  return { owner, admin, coach, coach2, staff, finance, org, cohort, players };
}
const weekly = (a, extra = {}) => {
  const start = addDays(today, 3);
  return { starts_on: start, ends_on: addDays(start, 14), weekdays: [dow(start)], start_time: '17:00', duration_min: 60, timezone: 'UTC', ...extra };
};
const generate = async (a, body = {}, who = a.owner) => ok(await api('POST', `/cohorts/${a.cohort.id}/academy/timetable`, { token: who.token, body: { idempotency_key: key(), ...weekly(a), ...body } }), 201);

test('timetable preview writes nothing; generation is idempotent and never duplicates a date; closures and skips are honoured', async () => {
  const a = await academy();
  const body = weekly(a);
  const prev = ok(await api('POST', `/cohorts/${a.cohort.id}/academy/timetable/preview`, { token: a.owner.token, body: { ...body, lead_id: a.coach.id } }));
  assert.equal(prev.new_sessions, 3);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM academy_sessions')).rows[0].n, 0, 'preview wrote nothing');
  const k = key();
  const first = ok(await api('POST', `/cohorts/${a.cohort.id}/academy/timetable`, { token: a.owner.token, body: { ...body, idempotency_key: k, lead_id: a.coach.id } }), 201);
  assert.equal(first.created_count, 3);
  const replay = ok(await api('POST', `/cohorts/${a.cohort.id}/academy/timetable`, { token: a.owner.token, body: { ...body, idempotency_key: k, lead_id: a.coach.id } }), 201);
  assert.equal(replay.replayed, true);
  const again = ok(await api('POST', `/cohorts/${a.cohort.id}/academy/timetable`, { token: a.owner.token, body: { ...body, idempotency_key: key(), lead_id: a.coach.id } }), 201);
  assert.equal(again.created_count, 0, 'a new key over the same dates adds nothing');
  assert.equal(again.skipped.length, 3);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM academy_sessions')).rows[0].n, 3);
  // closures and skip dates
  const a2 = await academy();
  const b2 = weekly(a2);
  const r = await generate(a2, { ...b2, closures: [{ from: addDays(b2.starts_on, 6), to: addDays(b2.starts_on, 8) }], skip_dates: [b2.starts_on] });
  assert.equal(r.created_count, 1, 'two of three dates removed');
  // staff without schedule access cannot generate
  assert.equal((await api('POST', `/cohorts/${a2.cohort.id}/academy/timetable`, { token: a2.finance.token, body: { idempotency_key: key(), ...b2 } })).status, 403);
});

test('coach and staff conflicts are refused before publication; concurrent assignment lets exactly one win', async () => {
  const a = await academy();
  const other = ok(await api('POST', `/organisations/${a.org.id}/cohorts`, { token: a.owner.token, body: { name: 'U14 Football', coach_id: a.coach2.id } }), 201);
  const one = (await generate(a, { lead_id: a.coach.id })).created[0].id;
  const two = ok(await api('POST', `/cohorts/${other.id}/academy/sessions`, { token: a.owner.token, body: { starts_at: (await pool.query('SELECT starts_at FROM academy_sessions WHERE id=$1', [one])).rows[0].starts_at.toISOString(), duration_min: 60 } }), 201);
  assert.equal(two.unassigned.length, 0);
  // coach is already leading `one`; assigning them to the overlapping `two` is a double booking
  const clash = await api('POST', `/academy/sessions/${two.id}/staff`, { token: a.owner.token, body: { user_id: a.coach.id, role: 'lead' } });
  assert.equal(clash.status, 409);
  assert.ok(clash.body.error.details.conflicts.some((c) => c.code === 'staff_double_booked'));
  // concurrent: a free person offered to both at once -> exactly one assignment
  const results = await Promise.all([one, two.id].map((sid) => api('POST', `/academy/sessions/${sid}/staff`, { token: a.owner.token, body: { user_id: a.staff.id, role: 'assistant' } })));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM academy_session_staff WHERE user_id=$1 AND status='assigned'", [a.staff.id])).rows[0].n, 1);
  // a non-member and a plain athlete cannot be assigned
  assert.equal((await api('POST', `/academy/sessions/${one}/staff`, { token: a.owner.token, body: { user_id: a.players[0].id } })).status, 400);
});

test('approved leave and standing availability stop assignments; approval opens cover requests', async () => {
  const a = await academy();
  const ids = (await generate(a, { lead_id: a.coach.id })).created.map((c) => c.id);
  const dateOf = async (sid) => (await pool.query("SELECT to_char(starts_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS d FROM academy_sessions WHERE id=$1", [sid])).rows[0].d;
  const d1 = await dateOf(ids[0]);
  const req = ok(await api('POST', `/organisations/${a.org.id}/academy/time-off`, { token: a.staff.token, body: { on_date: d1, reason: 'family' } }), 201);
  assert.equal((await api('POST', `/academy/time-off/${req.id}/decision`, { token: a.staff.token, body: { approve: true } })).status, 403, 'cannot decide your own');
  ok(await api('POST', `/academy/sessions/${ids[0]}/staff`, { token: a.owner.token, body: { user_id: a.staff.id } }), 201);   // pending leave blocks nothing
  ok(await api('DELETE', `/academy/sessions/${ids[0]}/staff/${a.staff.id}`, { token: a.owner.token }));
  const dec = ok(await api('POST', `/academy/time-off/${req.id}/decision`, { token: a.owner.token, body: { approve: true } }));
  assert.equal(dec.status, 'approved');
  const blocked = await api('POST', `/academy/sessions/${ids[0]}/staff`, { token: a.owner.token, body: { user_id: a.staff.id } });
  assert.equal(blocked.status, 409);
  assert.ok(blocked.body.error.details.conflicts.some((c) => c.code === 'on_leave'));
  // the coach's own leave opens cover for sessions already assigned to them
  const reqC = ok(await api('POST', `/organisations/${a.org.id}/academy/time-off`, { token: a.coach.token, body: { on_date: d1 } }), 201);
  const decC = ok(await api('POST', `/academy/time-off/${reqC.id}/decision`, { token: a.owner.token, body: { approve: true } }));
  assert.equal(decC.sessions_needing_cover.length, 1);
  const cover = ok(await api('GET', `/organisations/${a.org.id}/academy/cover`, { token: a.owner.token }));
  assert.equal(cover.length, 1);
  // standing availability: only mornings -> an afternoon session is refused
  ok(await api('POST', `/organisations/${a.org.id}/academy/availability`, { token: a.staff.token, body: { replace_weekly: true, weekly: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_time: '08:00', end_time: '12:00' })) } }), 201);
  const out = await api('POST', `/academy/sessions/${ids[1]}/staff`, { token: a.owner.token, body: { user_id: a.staff.id } });
  assert.equal(out.status, 409);
  assert.ok(out.body.error.details.conflicts.some((c) => c.code === 'outside_availability'));
});

test('substitute flow: decline opens cover, replacement closes it, history is kept and people are told', async () => {
  const a = await academy();
  const sid = (await generate(a, { lead_id: a.coach.id })).created[0].id;
  ok(await api('POST', '/organisations/' + a.org.id + '/academy/sessions/publish', { token: a.owner.token, body: { session_ids: [sid], acknowledge_warnings: true } }));
  assert.equal((await api('POST', `/academy/sessions/${sid}/staff/respond`, { token: a.coach2.token, body: { accept: true } })).status, 404, 'not assigned');
  ok(await api('POST', `/academy/sessions/${sid}/staff/respond`, { token: a.coach.token, body: { accept: false, reason: 'ill' } }));
  assert.equal(ok(await api('GET', `/organisations/${a.org.id}/academy/cover`, { token: a.owner.token })).length, 1);
  const rec = ok(await api('GET', `/academy/sessions/${sid}/recommendations?role=lead`, { token: a.owner.token }));
  assert.ok(rec.candidates.length >= 1 && rec.candidates[0].reasons.length >= 1, 'ranked with reasons');
  ok(await api('POST', `/academy/sessions/${sid}/staff`, { token: a.owner.token, body: { user_id: a.coach2.id, role: 'lead', replaces: a.coach.id } }), 201);
  assert.equal(ok(await api('GET', `/organisations/${a.org.id}/academy/cover`, { token: a.owner.token })).length, 0, 'request closed by the replacement');
  const det = ok(await api('GET', `/academy/sessions/${sid}`, { token: a.owner.token }));
  assert.equal(det.staff.find((s) => s.role === 'lead' && s.status !== 'declined').user_id, a.coach2.id);
  assert.ok(det.changes.some((c) => c.kind === 'staff_replaced'));
  const told = await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='academy_assignment_removed'", [a.coach.id]);
  assert.equal(told.rowCount, 1);
});

test('staffing rules explain every warning; enforced rules block publishing; the lead credential comes from verification', async () => {
  const a = await academy({ athletes: 4 });
  ok(await api('PATCH', `/cohorts/${a.cohort.id}/academy/staffing`, { token: a.owner.token, body: { min_coaches: 2, max_ratio: 2, lead_credential_required: true } }));
  const sid = (await generate(a, { lead_id: a.coach.id })).created[0].id;
  const det = ok(await api('GET', `/academy/sessions/${sid}`, { token: a.owner.token }));
  assert.equal(det.compliance.level, 'warning');
  const msgs = det.compliance.checks.filter((c) => c.severity !== 'ok').map((c) => c.message).join(' | ');
  assert.match(msgs, /at least 2 are required/);
  assert.match(msgs, /exceeds the maximum ratio/);
  assert.match(msgs, /no verified coach credential/);
  const pub = (ack) => api('POST', `/organisations/${a.org.id}/academy/sessions/publish`, { token: a.owner.token, body: { session_ids: [sid], acknowledge_warnings: ack } });
  assert.equal(ok(await pub(false)).results[0].published, false, 'warnings need acknowledgement');
  // a verified coach badge makes the credential check pass
  await pool.query("INSERT INTO verification_cases(subject_type, subject_id, type, status, decided_at, expires_at, requested_by, rules_version) VALUES ('user', $1, 'coach', 'approved', now(), now() + interval '1 year', $1, 1)", [a.coach.id]);
  const det2 = ok(await api('GET', `/academy/sessions/${sid}`, { token: a.owner.token }));
  assert.ok(!det2.compliance.checks.some((c) => c.code === 'lead_credential' && !c.ok));
  // enforced: blocked and cannot be acknowledged away
  ok(await api('PATCH', `/cohorts/${a.cohort.id}/academy/staffing`, { token: a.owner.token, body: { enforce_staffing: true } }));
  const sid2 = (await generate(a, { lead_id: a.coach.id, starts_on: addDays(today, 40), ends_on: addDays(today, 40), weekdays: [], extra_dates: [addDays(today, 40)] })).created[0].id;
  const res = ok(await api('POST', `/organisations/${a.org.id}/academy/sessions/publish`, { token: a.owner.token, body: { session_ids: [sid2], acknowledge_warnings: true } }));
  assert.equal(res.results[0].published, false);
  assert.equal(res.results[0].reason, 'staffing rule not met');
});

test('attendance: roster from enrolments, idempotent scans, corrections need a reason and keep history, cancelled = not held', async () => {
  const a = await academy();
  const sid = (await generate(a, { lead_id: a.coach.id })).created[0].id;
  assert.equal((await api('POST', `/academy/sessions/${sid}/attendance`, { token: a.coach.token, body: { entries: [{ user_id: a.players[0].id, status: 'present' }] } })).status, 409, 'draft sessions cannot take attendance');
  ok(await api('POST', `/organisations/${a.org.id}/academy/sessions/publish`, { token: a.owner.token, body: { session_ids: [sid], acknowledge_warnings: true } }));
  const roster = ok(await api('GET', `/academy/sessions/${sid}/roster`, { token: a.coach.token }));
  assert.equal(roster.roster.length, 3);
  assert.equal(roster.roster.every((r) => !('email' in r)), true, 'no contact data in the roster');
  // absence ahead of time is a notice, not presence
  const p = a.players[0];
  const ab = ok(await api('POST', `/academy/sessions/${sid}/absence`, { token: p.token, body: { reason_code: 'illness', idempotency_key: key() } }));
  assert.equal(ab.status, 'excused');
  // presence cannot be recorded days before the session
  const early = await api('POST', `/academy/sessions/${sid}/attendance`, { token: a.coach.token, body: { entries: [{ user_id: a.players[1].id, status: 'present' }] } });
  assert.equal(early.status, 409);
  // move the session to now to exercise check-in
  await pool.query("UPDATE academy_sessions SET starts_at=now() - interval '2 minutes', ends_at=now() + interval '58 minutes' WHERE id=$1", [sid]);
  const scan = key();
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => api('POST', `/academy/sessions/${sid}/check-in`, { token: a.coach.token, body: { user_id: a.players[1].id, idempotency_key: scan } })));
  assert.ok(results.every((r) => r.status === 201 || r.status === 200), JSON.stringify(results.map((r) => r.body)));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM academy_attendance_log WHERE session_id=$1 AND user_id=$2 AND to_status='present'", [sid, a.players[1].id])).rows[0].n, 1, 'five scans, one record');
  // correcting an existing mark needs a reason and is logged
  const noReason = await api('POST', `/academy/sessions/${sid}/attendance`, { token: a.coach.token, body: { entries: [{ user_id: a.players[1].id, status: 'left_early' }] } });
  assert.equal(noReason.status, 400);
  ok(await api('POST', `/academy/sessions/${sid}/attendance`, { token: a.coach.token, body: { reason: 'left at half time', entries: [{ user_id: a.players[1].id, status: 'left_early' }] } }), 200);
  const hist = ok(await api('GET', `/academy/sessions/${sid}/attendance/history?user_id=${a.players[1].id}`, { token: a.coach.token }));
  assert.deepEqual(hist.map((h) => h.to_status), ['present', 'left_early']);
  // a stranger on the roster is rejected; another coach cannot mark; finance cannot read the roster
  const stranger = await signup();
  assert.equal((await api('POST', `/academy/sessions/${sid}/attendance`, { token: a.coach.token, body: { entries: [{ user_id: stranger.id, status: 'present' }] } })).status, 400);
  assert.equal((await api('POST', `/academy/sessions/${sid}/attendance`, { token: a.coach2.token, body: { entries: [{ user_id: p.id, status: 'absent' }] } })).status, 403);
  assert.equal((await api('GET', `/academy/sessions/${sid}/roster`, { token: a.finance.token })).status, 403);
  // legacy date-only attendance is untouched and clock-in does not mark anyone present
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM org_attendance")).rows[0].n, 0);
  // cancelling: attendance becomes not_held, athletes are told, the history is kept
  ok(await api('POST', `/academy/sessions/${sid}/cancel`, { token: a.owner.token, body: { reason: 'pitch flooded' } }));
  const after = (await pool.query("SELECT status FROM academy_attendance WHERE session_id=$1", [sid])).rows.map((r) => r.status);
  assert.ok(after.every((s) => s === 'not_held'));
  assert.equal((await api('POST', `/academy/sessions/${sid}/attendance`, { token: a.coach.token, body: { entries: [{ user_id: p.id, status: 'present' }] } })).status, 409);
});

test('revoking staff access is immediate and role/permission boundaries hold', async () => {
  const a = await academy();
  const sid = (await generate(a, { lead_id: a.coach.id })).created[0].id;
  ok(await api('POST', `/organisations/${a.org.id}/academy/sessions/publish`, { token: a.owner.token, body: { session_ids: [sid], acknowledge_warnings: true } }));
  // a generic staff member has nothing until given a scoped permission set
  assert.equal(ok(await api('GET', `/organisations/${a.org.id}/academy/today`, { token: a.staff.token })).sessions.length, 0, 'a staff member with no permissions sees no sessions');
  ok(await api('POST', `/organisations/${a.org.id}/academy/staff/${a.staff.id}`, { token: a.owner.token, body: { job_title: 'Registrar', template: 'registrar' } }));
  assert.equal((await api('GET', `/academy/sessions/${sid}/roster`, { token: a.staff.token })).status, 200);
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/sessions/publish`, { token: a.staff.token, body: { session_ids: [sid] } })).status, 403, 'registrar cannot schedule');
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/payroll`, { token: a.staff.token })).status, 403);
  // suspending the engagement or removing the member cuts access on the very next request
  ok(await api('POST', `/organisations/${a.org.id}/academy/staff/${a.staff.id}`, { token: a.owner.token, body: { job_title: 'Registrar', template: 'registrar', state: 'suspended' } }));
  assert.equal((await api('GET', `/academy/sessions/${sid}/roster`, { token: a.staff.token })).status, 403);
  ok(await api('DELETE', `/organisations/${a.org.id}/members/${a.coach.id}`, { token: a.owner.token }));
  assert.equal((await api('GET', `/academy/sessions/${sid}/roster`, { token: a.coach.token })).status, 404);
  // only owner/admin manage engagements; HR notes are encrypted and reading them is audited
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/staff/${a.staff.id}`, { token: a.finance.token, body: { job_title: 'x1' } })).status, 403);
  ok(await api('POST', `/organisations/${a.org.id}/academy/staff/${a.coach2.id}`, { token: a.owner.token, body: { job_title: 'Head coach', template: 'head_coach', notes: 'prefers mornings' } }));
  const raw = (await pool.query('SELECT notes_enc FROM org_staff_engagements WHERE user_id=$1', [a.coach2.id])).rows[0].notes_enc;
  assert.ok(raw && !raw.includes('mornings'));
  assert.equal(ok(await api('GET', `/organisations/${a.org.id}/academy/staff/${a.coach2.id}`, { token: a.owner.token })).notes, 'prefers mornings');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='read_academy_engagement_notes'")).rows[0].n, 1);
  const own = ok(await api('GET', `/organisations/${a.org.id}/academy/staff/${a.coach2.id}`, { token: a.coach2.token }));
  assert.equal('notes' in own, false);
});

test('timesheets keep an immutable history; compensation is effective-dated; payroll runs are idempotent, per currency and frozen once approved', async () => {
  const a = await academy();
  const mk = ok(await api('POST', `/cohorts/${a.cohort.id}/academy/sessions`, { token: a.owner.token, body: { starts_at: new Date(Date.now() + 5 * 60000).toISOString(), duration_min: 60, lead_id: a.coach.id } }), 201);
  ok(await api('POST', `/organisations/${a.org.id}/academy/sessions/publish`, { token: a.owner.token, body: { session_ids: [mk.id], acknowledge_warnings: true } }));
  const ts = ok(await api('POST', `/academy/sessions/${mk.id}/clock-in`, { token: a.coach.token }), 201);
  assert.equal(ok(await api('POST', `/academy/sessions/${mk.id}/clock-in`, { token: a.coach.token }), 201).id, ts.id, 'one timesheet per session');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM academy_attendance WHERE session_id=$1', [mk.id])).rows[0].n, 0, 'clocking in marks nobody present');
  // make it a past session of exactly 60 scheduled minutes with 75 worked
  await pool.query("UPDATE academy_timesheets SET clock_in=now() - interval '90 minutes', scheduled_start=now() - interval '90 minutes', scheduled_end=now() - interval '30 minutes', work_date=current_date WHERE id=$1", [ts.id]);
  const out = ok(await api('POST', `/academy/timesheets/${ts.id}/clock-out`, { token: a.coach.token, body: { break_min: 0 } }));
  assert.equal(out.status, 'submitted');
  assert.ok(out.minutes >= 89 && out.minutes <= 91);
  assert.equal((await api('POST', `/academy/timesheets/${ts.id}/decision`, { token: a.coach.token, body: { action: 'approve' } })).status, 403, 'a coach cannot approve');
  const adj = ok(await api('POST', `/academy/timesheets/${ts.id}/adjust`, { token: a.coach.token, body: { row_version: out.row_version, reason: 'clocked out late', break_min: 15 } }));
  assert.equal(adj.minutes, out.minutes - 15);
  assert.equal((await api('POST', `/academy/timesheets/${ts.id}/adjust`, { token: a.coach.token, body: { row_version: out.row_version, reason: 'stale edit', break_min: 5 } })).status, 409);
  assert.equal((await api('POST', `/academy/timesheets/${ts.id}/decision`, { token: a.coach.token, body: { action: 'approve' } })).status, 403);
  ok(await api('POST', `/academy/timesheets/${ts.id}/decision`, { token: a.admin.token, body: { action: 'approve' } }));
  assert.equal((await api('POST', `/academy/timesheets/${ts.id}/adjust`, { token: a.coach.token, body: { row_version: adj.row_version + 1, reason: 'sneaky', break_min: 0 } })).status, 409, 'approved time is not silently editable');
  const hist = ok(await api('GET', `/academy/timesheets/${ts.id}`, { token: a.admin.token }));
  assert.deepEqual(hist.events.map((e) => e.action), ['created', 'clock_in', 'clock_out', 'adjusted', 'approved']);
  await assert.rejects(pool.query('UPDATE academy_timesheet_events SET reason=$1', ['x']), /append-only/);

  // compensation: hourly 60.00 INR from yesterday; a later rate change must not touch the earlier period
  const finance = a.finance;
  const rule = (body) => api('POST', `/organisations/${a.org.id}/academy/comp-rules`, { token: finance.token, body });
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/comp-rules`, { token: a.coach.token, body: { user_id: a.coach.id, model: 'hourly', rate_minor: 99999, currency: 'INR', effective_from: today } })).status, 403, 'coaches cannot set pay');
  ok(await rule({ user_id: a.coach.id, model: 'hourly', rate_minor: 6000, currency: 'INR', effective_from: addDays(today, -30) }), 201);
  ok(await rule({ user_id: a.coach.id, model: 'hourly', rate_minor: 9000, currency: 'INR', effective_from: addDays(today, 60) }), 201);
  assert.equal((await rule({ user_id: a.coach.id, model: 'hourly', rate_minor: 9000, currency: 'INR', effective_from: addDays(today, 60) })).status, 409, 'same version twice');
  const body = { currency: 'INR', period_start: addDays(today, -7), period_end: addDays(today, 7) };
  const prev = ok(await api('POST', `/organisations/${a.org.id}/academy/payroll`, { token: finance.token, body: { ...body, idempotency_key: key() } }), 201);
  assert.equal(prev.preview, true);
  const worked = (adj.minutes);
  assert.equal(prev.lines[0].base_minor, Math.floor((Math.min(worked, 60) * 6000 * 2 + 60) / 120) + Math.floor(((worked - 60) * 6000 * 10000 * 2 + 60 * 10000) / (120 * 10000)), 'hourly with the scheduled hour at base rate and the rest at overtime x1');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM academy_payroll_runs')).rows[0].n, 0, 'a preview writes nothing');
  const k = key();
  const run = ok(await api('POST', `/organisations/${a.org.id}/academy/payroll`, { token: finance.token, body: { ...body, idempotency_key: k, commit: true } }), 201);
  assert.equal(ok(await api('POST', `/organisations/${a.org.id}/academy/payroll`, { token: finance.token, body: { ...body, idempotency_key: k, commit: true } }), 201).replayed, true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM academy_payroll_runs')).rows[0].n, 1);
  assert.equal((await api('GET', `/academy/payroll/${run.id}/export`, { token: finance.token })).status, 409, 'draft cannot be exported');
  assert.equal((await api('POST', `/academy/payroll/${run.id}/approve`, { token: a.coach.token, body: { row_version: run.row_version } })).status, 403);
  const appr = ok(await api('POST', `/academy/payroll/${run.id}/approve`, { token: finance.token, body: { row_version: run.row_version } }));
  assert.equal(appr.status, 'approved');
  assert.equal(ok(await api('POST', `/academy/payroll/${run.id}/approve`, { token: finance.token, body: { row_version: run.row_version } })).status, 'approved', 'repeat approval is a no-op');
  // frozen: neither the run nor its timesheet can change, and terms cannot reach back into the period
  await assert.rejects(pool.query("UPDATE academy_payroll_runs SET total_minor=1 WHERE id=$1", [run.id]), /approved payroll run/);
  await assert.rejects(pool.query("UPDATE academy_timesheets SET minutes=1 WHERE id=$1", [ts.id]), /approved payroll run/);
  assert.equal((await rule({ user_id: a.coach.id, model: 'hourly', rate_minor: 1, currency: 'INR', effective_from: addDays(today, 1) })).status, 409);
  // export is CSV, audited, and shows only the numbers
  const exp = ok(await api('GET', `/academy/payroll/${run.id}/export`, { token: finance.token }));
  assert.match(exp.csv, /^name,staff_ref,engagement,scheduled_hours,worked_hours/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='export_academy_payroll'")).rows[0].n, 1);
  // statements: the coach sees only their own approved figures; another coach sees nothing
  const mine = ok(await api('GET', '/me/academy/statements', { token: a.coach.token }));
  assert.equal(mine.length, 1);
  assert.equal(ok(await api('GET', '/me/academy/statements', { token: a.coach2.token })).length, 0);
  assert.equal(ok(await api('GET', `/organisations/${a.org.id}/academy/comp-rules`, { token: a.coach2.token })).length, 0, 'coaches read only their own terms');
  assert.equal((await api('GET', `/academy/payroll/${run.id}`, { token: a.coach.token })).status, 403);
});

test('payroll never adds currencies: another currency is listed as unpriced; adjustments are per currency', async () => {
  const a = await academy();
  const mkTs = async (userId, day, currency, rate) => {
    await api('POST', `/organisations/${a.org.id}/academy/comp-rules`, { token: a.finance.token, body: { user_id: userId, model: 'hourly', rate_minor: rate, currency, effective_from: addDays(today, -60) } });
    const t = ok(await api('POST', `/organisations/${a.org.id}/academy/timesheets`, { token: a.admin.token, body: { idempotency_key: key(), user_id: userId, clock_in: `${day}T09:00:00Z`, clock_out: `${day}T11:00:00Z`, label: 'Front desk' } }), 201);
    ok(await api('POST', `/academy/timesheets/${t.id}/decision`, { token: a.owner.token, body: { action: 'approve' } }));
    return t;
  };
  const d = addDays(today, -2);
  await mkTs(a.coach.id, d, 'INR', 10000);
  await mkTs(a.coach2.id, d, 'USD', 2000);
  ok(await api('POST', `/organisations/${a.org.id}/academy/pay-adjustments`, { token: a.finance.token, body: { user_id: a.coach.id, amount_minor: 5000, currency: 'INR', reason: 'Kit allowance', on_date: d } }), 201);
  const body = { period_start: addDays(today, -7), period_end: today };
  const inr = ok(await api('POST', `/organisations/${a.org.id}/academy/payroll`, { token: a.finance.token, body: { ...body, currency: 'INR', idempotency_key: key() } }), 201);
  assert.equal(inr.total_minor, 20000 + 5000, '2 h at 100.00 plus the 50.00 adjustment');
  assert.equal(inr.lines.length, 1);
  assert.equal(inr.unpriced.length, 1);
  assert.match(inr.unpriced[0].reason, /paid in USD/);
  const usd = ok(await api('POST', `/organisations/${a.org.id}/academy/payroll`, { token: a.finance.token, body: { ...body, currency: 'USD', idempotency_key: key() } }), 201);
  assert.equal(usd.total_minor, 4000);
  // a draft run can be voided and its timesheets are released
  const run = ok(await api('POST', `/organisations/${a.org.id}/academy/payroll`, { token: a.finance.token, body: { ...body, currency: 'INR', idempotency_key: key(), commit: true } }), 201);
  assert.equal(ok(await api('POST', `/organisations/${a.org.id}/academy/payroll`, { token: a.finance.token, body: { ...body, currency: 'INR', idempotency_key: key() } }), 201).lines.length, 0, 'already reserved');
  ok(await api('POST', `/academy/payroll/${run.id}/void`, { token: a.finance.token }));
  assert.equal(ok(await api('POST', `/organisations/${a.org.id}/academy/payroll`, { token: a.finance.token, body: { ...body, currency: 'INR', idempotency_key: key() } }), 201).total_minor, 25000);
});

test('payroll/HR staff cannot read coaching or attendance data; coaches cannot read finance or HR data', async () => {
  const a = await academy();
  const sid = (await generate(a, { lead_id: a.coach.id })).created[0].id;
  ok(await api('POST', `/organisations/${a.org.id}/academy/sessions/publish`, { token: a.owner.token, body: { session_ids: [sid], acknowledge_warnings: true } }));
  for (const [m, p] of [['GET', `/academy/sessions/${sid}/roster`], ['GET', `/academy/sessions/${sid}/attendance/history`]]) assert.equal((await api(m, p, { token: a.finance.token })).status, 403, `${m} ${p}`);
  assert.equal(ok(await api('GET', `/organisations/${a.org.id}/academy/today`, { token: a.finance.token })).sessions.length, 0, 'finance has no timetable access');
  for (const [m, p] of [['GET', `/organisations/${a.org.id}/academy/payroll`], ['GET', `/organisations/${a.org.id}/academy/staff`]]) assert.equal((await api(m, p, { token: a.coach.token })).status, 403, `${m} ${p}`);
  // coaches can still run their own sessions
  assert.equal((await api('GET', `/academy/sessions/${sid}/roster`, { token: a.coach.token })).status, 200);
  assert.equal(ok(await api('GET', `/organisations/${a.org.id}/academy/analytics?from=${today}&to=${addDays(today, 30)}`, { token: a.owner.token })).compensation_by_programme.length, 0);
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/analytics?from=${today}&to=${addDays(today, 30)}`, { token: a.finance.token })).status, 403);
});

test('sessions appear in the coach calendar and the athlete schedule as source-linked projections, never as copies', async () => {
  const a = await academy();
  const ids = (await generate(a, { lead_id: a.coach.id })).created.map((c) => c.id);
  ok(await api('POST', `/organisations/${a.org.id}/academy/sessions/publish`, { token: a.owner.token, body: { session_ids: ids, acknowledge_warnings: true } }));
  const cal = ok(await api('GET', `/coach/calendar?from=${today}&to=${addDays(today, 30)}`, { token: a.coach.token }));
  const mine = cal.items.filter((i) => i.source_type === 'academy_session');
  assert.equal(mine.length, 3);
  assert.deepEqual(mine.map((i) => i.source_id).sort(), [...ids].sort());
  const sched = ok(await api('GET', `/me/sport-schedule?from=${today}&to=${addDays(today, 30)}`, { token: a.players[0].token }));
  assert.equal(sched.items.filter((i) => i.source_type === 'academy_session').length, 3);
  const staffView = ok(await api('GET', `/me/academy/agenda?from=${today}&to=${addDays(today, 30)}`, { token: a.coach.token }));
  assert.equal(staffView.sessions.length, 3);
  const nonMember = await signup();
  assert.equal(ok(await api('GET', `/me/sport-schedule?from=${today}&to=${addDays(today, 30)}`, { token: nonMember.token })).items.filter((i) => i.source_type === 'academy_session').length, 0);
  // drafts and cancelled-for-staff are not projected into the coach calendar
  const one = ids[0];
  ok(await api('POST', `/academy/sessions/${one}/cancel`, { token: a.owner.token, body: { reason: 'holiday' } }));
  const cal2 = ok(await api('GET', `/coach/calendar?from=${today}&to=${addDays(today, 30)}`, { token: a.coach.token }));
  assert.equal(cal2.items.filter((i) => i.source_type === 'academy_session').length, 2);
  // the athlete sees the cancellation, with its reason, in the academy view (and a make-up option once one is published)
  const my = ok(await api('GET', `/me/academy/sessions?from=${today}&to=${addDays(today, 30)}`, { token: a.players[0].token }));
  assert.equal(my.sessions.find((s) => s.id === one).status, 'cancelled');
  assert.equal(my.sessions.find((s) => s.id === one).cancel_reason, 'holiday');
  // an outsider cannot read another athlete's academy sessions
  assert.equal((await api('GET', `/me/academy/sessions?athlete_id=${a.players[0].id}`, { token: a.players[1].token })).status, 403);
});

test('Performance Studio runs an academy session from the same roster and attendance, without a second attendance record', async () => {
  const a = await academy();
  const sid = (await generate(a, { lead_id: a.coach.id })).created[0].id;
  ok(await api('POST', `/organisations/${a.org.id}/academy/sessions/publish`, { token: a.owner.token, body: { session_ids: [sid], acknowledge_warnings: true } }));
  await pool.query("UPDATE academy_sessions SET starts_at=now() - interval '1 minute', ends_at=now() + interval '59 minutes' WHERE id=$1", [sid]);
  const rec = await api('POST', '/coaching/sessions', { token: a.coach.token, body: { source_type: 'academy_session', source_id: sid } });
  assert.ok([200, 201].includes(rec.status), JSON.stringify(rec.body));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM coaching_session_participants WHERE session_record_id=$1', [rec.body.id])).rows[0].n, 3, 'participants reference the cohort roster');
  assert.equal((await api('POST', '/coaching/sessions', { token: a.coach2.token, body: { source_type: 'academy_session', source_id: sid } })).status, 404, 'only assigned coaches');
  ok(await api('POST', `/academy/sessions/${sid}/attendance`, { token: a.coach.token, body: { entries: [{ user_id: a.players[0].id, status: 'present' }] } }));
  assert.equal((await pool.query('SELECT attendance FROM coaching_session_participants WHERE session_record_id=$1 AND athlete_id=$2', [rec.body.id, a.players[0].id])).rows[0].attendance, 'present', 'the academy mark shows in the Studio');
  assert.equal((await api('POST', `/coaching/sessions/${rec.body.id}/attendance`, { token: a.coach.token, body: { entries: [{ athlete_id: a.players[0].id, attendance: 'absent' }] } })).status, 409);
});

test('venue: an academy session reserves a court through the canonical engine, never overbooks it and keeps the booking terms', async () => {
  const a = await academy();
  const mgr = await signup(['venue_manager']);
  const v = ok(await api('POST', '/venues', { token: mgr.token, body: { name: 'Academy Arena', city: 'Pune', timezone: 'UTC', currency: 'INR' } }), 201);
  ok(await api('POST', `/venues/${v.id}/hours`, { token: mgr.token, body: { hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '06:00', closes: '22:00' })) } }));
  const court = ok(await api('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'Court A', sport: 'football', hourly_rate_cents: 50000, max_players: 10 } }), 201);
  const ids = (await generate(a, { lead_id: a.coach.id })).created.map((c) => c.id);
  const other = ok(await api('POST', `/organisations/${a.org.id}/cohorts`, { token: a.owner.token, body: { name: 'U16' } }), 201);
  const same = ok(await api('POST', `/cohorts/${other.id}/academy/sessions`, { token: a.owner.token, body: { starts_at: (await pool.query('SELECT starts_at FROM academy_sessions WHERE id=$1', [ids[0]])).rows[0].starts_at.toISOString(), duration_min: 60 } }), 201);
  const booked = ok(await api('POST', `/academy/sessions/${ids[0]}/venue`, { token: a.owner.token, body: { resource_id: court.id } }), 201);
  assert.ok(booked.venue && booked.venue.resource_name === 'Court A');
  assert.ok(booked.reservation.totals.length === 1 && booked.reservation.totals[0].currency === 'INR', 'the booking keeps its own price and currency');
  const clash = await api('POST', `/academy/sessions/${same.id}/venue`, { token: a.owner.token, body: { resource_id: court.id, quantity: 1 } });
  assert.equal(clash.status, 409, 'the court is already taken by the first session');
  assert.equal((await api('POST', `/academy/sessions/${ids[0]}/venue`, { token: a.owner.token, body: { resource_id: court.id } })).status, 409, 'one venue hold per session');
  // rescheduling does not touch the booking but tells the director to move it
  const det = ok(await api('GET', `/academy/sessions/${ids[0]}`, { token: a.owner.token }));
  const moved = ok(await api('PATCH', `/academy/sessions/${ids[0]}`, { token: a.owner.token, body: { row_version: det.row_version, starts_at: new Date(+new Date(det.starts_at) + 3600000).toISOString(), reason: 'coach delayed' } }));
  assert.equal(moved.venue_needs_review, true);
  const after = ok(await api('GET', `/academy/sessions/${ids[0]}`, { token: a.owner.token }));
  assert.ok(after.conflicts.some((c) => c.code === 'venue_window_mismatch'), 'publish check flags the mismatched booking');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM academy_session_changes WHERE session_id=$1 AND kind='rescheduled'", [ids[0]])).rows[0].n, 1);
  const rel = ok(await api('DELETE', `/academy/sessions/${ids[0]}/venue`, { token: a.owner.token, body: {} }));
  assert.ok(rel.released_booking.booking_id);
  assert.equal((await pool.query("SELECT status FROM bookings WHERE id=$1", [rel.released_booking.booking_id])).rows[0].status, 'confirmed', 'the paid booking is never cancelled silently');
});

test('make-up and transfer: capacity-checked, idempotent, no financial records created', async () => {
  const a = await academy();
  const ids = (await generate(a, { lead_id: a.coach.id })).created.map((c) => c.id);
  ok(await api('POST', `/organisations/${a.org.id}/academy/sessions/publish`, { token: a.owner.token, body: { session_ids: ids, acknowledge_warnings: true } }));
  const other = ok(await api('POST', `/organisations/${a.org.id}/cohorts`, { token: a.owner.token, body: { name: 'U12 B' } }), 201);
  const target = ok(await api('POST', `/cohorts/${other.id}/academy/sessions`, { token: a.owner.token, body: { starts_at: new Date(Date.now() + 9 * 86400000).toISOString(), duration_min: 60, capacity: 1 } }), 201);
  ok(await api('POST', `/organisations/${a.org.id}/academy/sessions/publish`, { token: a.owner.token, body: { session_ids: [target.id], acknowledge_warnings: true } }));
  const charges = (await pool.query('SELECT count(*)::int AS n FROM academy_charges')).rows[0].n;
  const t1 = ok(await api('POST', `/academy/sessions/${ids[0]}/transfer`, { token: a.owner.token, body: { user_id: a.players[0].id, to_session_id: target.id } }), 201);
  assert.equal(t1.to_session_id, target.id);
  ok(await api('POST', `/academy/sessions/${ids[0]}/transfer`, { token: a.owner.token, body: { user_id: a.players[0].id, to_session_id: target.id } }), 201);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM academy_attendance WHERE session_id=$1 AND guest", [target.id])).rows[0].n, 1, 'idempotent');
  assert.equal((await api('POST', `/academy/sessions/${ids[0]}/transfer`, { token: a.owner.token, body: { user_id: a.players[1].id, to_session_id: target.id } })).status, 409, 'target is full');
  assert.equal((await pool.query("SELECT status FROM academy_attendance WHERE session_id=$1 AND user_id=$2", [ids[0], a.players[0].id])).rows[0].status, 'excused');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM academy_charges')).rows[0].n, charges, 'no fees, credits or refunds are created by attendance');
});

test('Operations Today and analytics: actionable status, deep links, and nothing stored twice', async () => {
  const a = await academy();
  const sid = (await generate(a, { lead_id: a.coach.id })).created[0].id;
  ok(await api('POST', `/organisations/${a.org.id}/academy/sessions/publish`, { token: a.owner.token, body: { session_ids: [sid], acknowledge_warnings: true } }));
  const d = (await pool.query("SELECT to_char(starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d FROM academy_sessions WHERE id=$1", [sid])).rows[0].d;
  const board = ok(await api('GET', `/organisations/${a.org.id}/academy/today?date=${d}`, { token: a.owner.token }));
  assert.equal(board.sessions.length, 1);
  const s = board.sessions[0];
  assert.equal(s.expected, 3);
  assert.ok(s.actions.find((x) => x.key === 'attendance' && x.screen === 'AcademySession'));
  assert.ok(s.actions.find((x) => x.key === 'studio' && x.enabled === false), 'the owner is not a coach on this session');
  assert.equal(typeof board.inbox.understaffed, 'number');
  const mineOnly = ok(await api('GET', `/organisations/${a.org.id}/academy/today?date=${d}`, { token: a.coach.token }));
  assert.equal(mineOnly.sessions.length, 1);
  assert.equal(ok(await api('GET', `/organisations/${a.org.id}/academy/today?date=${d}`, { token: a.coach2.token })).sessions.length, 0, 'a coach sees only their own sessions');
  const an = ok(await api('GET', `/organisations/${a.org.id}/academy/analytics?from=${today}&to=${addDays(today, 30)}`, { token: a.owner.token }));
  assert.equal(an.sessions.planned, 1);
  assert.ok(Array.isArray(an.coach_utilisation));
  const msg = ok(await api('POST', `/academy/sessions/${sid}/notify`, { token: a.owner.token, body: { title: 'Bring water', body: 'Hot day: please bring a bottle.' } }), 200);
  assert.equal(msg.recipients, 3);
  assert.equal(ok(await api('POST', `/academy/sessions/${sid}/notify`, { token: a.owner.token, body: { title: 'Bring water', body: 'Hot day: please bring a bottle.' } }), 200).recipients, 3);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE kind='academy_session_message'")).rows[0].n, 3, 'the same message is delivered once');
});

test('non-session shifts: clash-checked, acknowledged by the person, timesheet-linked and shown in their agenda', async () => {
  const a = await academy();
  const start = new Date(Date.now() - 3 * 3600000), end = new Date(Date.now() - 1 * 3600000);
  const body = { user_id: a.staff.id, title: 'Registration desk', duty_label: 'registration', starts_at: start.toISOString(), ends_at: end.toISOString() };
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/shifts`, { token: a.coach.token, body })).status, 403, 'coaches cannot roster');
  const sh = ok(await api('POST', `/organisations/${a.org.id}/academy/shifts`, { token: a.admin.token, body }), 201);
  const clash = await api('POST', `/organisations/${a.org.id}/academy/shifts`, { token: a.admin.token, body: { ...body, title: 'Overlap' } });
  assert.equal(clash.status, 409);
  assert.ok(clash.body.error.details.conflicts.some((c) => c.code === 'shift_clash'));
  const ag = ok(await api('GET', `/me/academy/agenda?from=${addDays(today, -1)}&to=${addDays(today, 1)}`, { token: a.staff.token }));
  assert.equal(ag.shifts.length, 1);
  assert.equal(ag.shifts[0].needs_response, true);
  ok(await api('POST', `/academy/shifts/${sh.id}/respond`, { token: a.staff.token, body: { accept: true } }));
  assert.equal((await api('POST', `/academy/shifts/${sh.id}/respond`, { token: a.coach.token, body: { accept: true } })).status, 404, 'only the rostered person responds');
  const t = ok(await api('POST', `/organisations/${a.org.id}/academy/timesheets`, { token: a.staff.token, body: { idempotency_key: key(), shift_id: sh.id, clock_in: start.toISOString(), clock_out: end.toISOString() } }), 201);
  assert.equal(t.kind, 'shift');
  assert.equal(t.minutes, 120);
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/timesheets`, { token: a.staff.token, body: { idempotency_key: key(), shift_id: sh.id, clock_in: start.toISOString(), clock_out: end.toISOString() } })).status, 409, 'one timesheet per shift');
  ok(await api('DELETE', `/academy/shifts/${sh.id}`, { token: a.admin.token }));
  assert.equal(ok(await api('GET', `/me/academy/agenda?from=${addDays(today, -1)}&to=${addDays(today, 1)}`, { token: a.staff.token })).shifts.length, 0);
});
