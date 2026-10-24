// Academy OS 2/3: session-level athlete attendance. One row per session and athlete (never one per coach), every change is logged,
// retries are idempotent, and Performance Studio reads this same fact instead of keeping its own. Attendance answers "did this enrolled
// athlete attend this academy session?"; arrival at a facility (venue check-in, #90) is a different fact and is only referenced.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { notify } from '../notify.js';
import { requireGuardian, hasConsent } from '../youth.js';
import { isAdmin } from '../helpers.js';
import { sessionFor, expectedCount } from '../academy-ops.js';
import { syncTrialFromAttendance } from '../academy-trials.js';

const TAG = 'Academy operations';
const day = z.string().date();
const STATUS = ['expected', 'present', 'late', 'left_early', 'absent', 'excused', 'not_held'];
const REASONS = ['illness', 'family', 'travel', 'school', 'injury_non_clinical', 'other'];
const LATE_AFTER_MIN = 10;      // arriving more than this long after the start is recorded as late
const EARLY_OPEN_MIN = 60;      // presence can be recorded from this long before the start
const PRESENT = ['present', 'late', 'left_early'];

/** Athletes who may be marked: enrolled in the cohort, or a guest added by a transfer / make-up. */
async function eligible(c, s, userId) {
  const e = (await c.query("SELECT id FROM org_enrolments WHERE cohort_id=$1 AND user_id=$2 AND status='enrolled'", [s.cohort_id, userId])).rows[0];
  if (e) return { enrolment_id: e.id, guest: false };
  if ((await c.query('SELECT 1 FROM academy_attendance WHERE session_id=$1 AND user_id=$2 AND guest', [s.id, userId])).rowCount) return { enrolment_id: null, guest: true };
  return null;
}

/**
 * The single write path for attendance. Returns { changed, row }. A repeated idempotency key (scan retry, double tap) changes nothing;
 * changing an already-marked status needs a reason and is logged; presence cannot be recorded long before the session starts.
 */
export async function markAttendance(c, s, userId, status, { source = 'staff', actor, key = null, reason = null, reason_code = null } = {}) {
  if (!STATUS.includes(status)) throw badRequest('Unknown attendance status');
  if (s.status === 'cancelled') throw conflict('This session was cancelled, so attendance is "not held"');
  if (s.status === 'draft') throw conflict('Publish the session before taking attendance');
  const who = await eligible(c, s, userId);
  if (!who) throw badRequest('That person is not on this session\'s roster', { user_id: userId });
  if (PRESENT.includes(status) && Date.now() < new Date(s.starts_at).getTime() - EARLY_OPEN_MIN * 60000) throw conflict('Attendance can be taken from one hour before the session starts');
  if (key) {
    const seen = (await c.query('SELECT 1 FROM academy_attendance_log WHERE session_id=$1 AND user_id=$2 AND idempotency_key=$3', [s.id, userId, key])).rowCount;
    if (seen) return { changed: false, replay: true, row: (await c.query('SELECT * FROM academy_attendance WHERE session_id=$1 AND user_id=$2', [s.id, userId])).rows[0] };
  }
  const cur = (await c.query('SELECT * FROM academy_attendance WHERE session_id=$1 AND user_id=$2 FOR UPDATE', [s.id, userId])).rows[0];
  if (cur && cur.status === status && (reason_code ?? cur.reason_code) === cur.reason_code) return { changed: false, row: cur };
  if (cur && cur.status !== 'expected' && !reason && source !== 'system') throw badRequest('Say why you are correcting this mark');
  const now = new Date();
  const row = (await c.query(
    `INSERT INTO academy_attendance(session_id, user_id, enrolment_id, status, reason_code, source, guest, marked_by, marked_at, arrived_at, left_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (session_id, user_id) DO UPDATE SET status=EXCLUDED.status, reason_code=EXCLUDED.reason_code, source=EXCLUDED.source, marked_by=EXCLUDED.marked_by, marked_at=EXCLUDED.marked_at,
       arrived_at=CASE WHEN EXCLUDED.status IN ('present','late','left_early') THEN coalesce(academy_attendance.arrived_at, EXCLUDED.arrived_at) ELSE NULL END,
       left_at=CASE WHEN EXCLUDED.status='left_early' THEN coalesce(academy_attendance.left_at, EXCLUDED.left_at) ELSE NULL END, row_version=academy_attendance.row_version+1
     RETURNING *`,
    [s.id, userId, who.enrolment_id, status, reason_code, source, who.guest, actor ?? null, now, PRESENT.includes(status) ? now : null, status === 'left_early' ? now : null])).rows[0];
  const logged = await c.query(
    `INSERT INTO academy_attendance_log(session_id, user_id, from_status, to_status, source, idempotency_key, actor_id, reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
    [s.id, userId, cur?.status ?? null, status, source, key, actor ?? null, reason]);
  if (!logged.rowCount) return { changed: false, replay: true, row };
  // Performance Studio shows the same fact: update its participant row when a coach already opened this session there
  if (status !== 'not_held') {
    await c.query(
      `UPDATE coaching_session_participants p SET attendance=$3, updated_at=now(), arrived_at=CASE WHEN $3 IN ('present','late','left_early') THEN coalesce(p.arrived_at, now()) ELSE NULL END, left_at=CASE WHEN $3='left_early' THEN coalesce(p.left_at, now()) ELSE NULL END
         FROM coaching_session_records r WHERE r.id=p.session_record_id AND r.source_type='academy_session' AND r.source_id=$1 AND p.athlete_id=$2`, [s.id, userId, status]);
  }
  await syncTrialFromAttendance(c, row, status, actor);   // a trial seat: the application follows what attendance says
  return { changed: true, row };
}

const rosterOf = (c, s) => c.query(
  `SELECT u.id AS user_id, u.display_name, u.handle, u.avatar_emoji, u.avatar_color, coalesce(a.status, 'expected') AS status, a.reason_code, a.source, a.marked_at, a.arrived_at, a.left_at, coalesce(a.guest, false) AS guest, a.row_version,
          (u.youth_until IS NOT NULL AND u.youth_until > current_date) AS is_youth
     FROM (SELECT e.user_id FROM org_enrolments e WHERE e.cohort_id=$2 AND e.status='enrolled' UNION SELECT user_id FROM academy_attendance WHERE session_id=$1 AND guest) r
     JOIN users u ON u.id=r.user_id LEFT JOIN academy_attendance a ON a.session_id=$1 AND a.user_id=r.user_id
    ORDER BY u.display_name, u.id`, [s.id, s.cohort_id]).then((r) => r.rows);

cap({
  name: 'get_academy_session_roster', method: 'GET', path: '/academy/sessions/:id/roster', tag: TAG,
  summary: 'The session roster for taking attendance: derived live from the cohort enrolments plus guests, with each athlete\'s current mark. Names only (no contact or medical data). Staff assigned to the session, the cohort coach and roster/attendance staff may read it.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { s } = await sessionFor(user, i.id, 'roster');
    const roster = await rosterOf(pool, s);
    const counts = Object.fromEntries(STATUS.map((k) => [k, roster.filter((r) => r.status === k).length]));
    return { session: { id: s.id, title: s.title, starts_at: s.starts_at, ends_at: s.ends_at, status: s.status, capacity: s.capacity, self_checkin: s.self_checkin, cohort_name: s.cohort_name }, roster, counts, expected: await expectedCount(pool, s), venue_checkin: 'Facility arrival is recorded by the venue; this list records attendance at the session.' };
  },
});

cap({
  name: 'mark_academy_attendance', method: 'POST', path: '/academy/sessions/:id/attendance', tag: TAG,
  summary: 'Mark one or many athletes (tap, bulk). Idempotent: the same idempotency_key never applies twice and re-sending the same status changes nothing. Changing a mark that was already set needs a reason and is kept in the history. Only people on the roster can be marked; presence can be recorded from an hour before the start.',
  input: z.object({ id, idempotency_key: z.string().min(8).max(80).optional(), reason: z.string().trim().min(3).max(200).optional(), bulk: z.boolean().default(false),
    entries: z.array(z.object({ user_id: id, status: z.enum(STATUS.filter((x) => x !== 'not_held')), reason_code: z.enum(REASONS).optional() })).min(1).max(300) }),
  handler: ({ user }, i) => tx(async (c) => {
    const { s } = await sessionFor(user, i.id, 'attendance', { write: true, c });
    const out = [];
    for (const e of [...new Map(i.entries.map((x) => [x.user_id, x])).values()].sort((x, y) => x.user_id.localeCompare(y.user_id))) {
      const r = await markAttendance(c, s, e.user_id, e.status, { source: i.bulk ? 'bulk' : 'staff', actor: user.id, key: i.idempotency_key ? `${i.idempotency_key}:${e.user_id}` : null, reason: i.reason, reason_code: e.reason_code });
      out.push({ user_id: e.user_id, status: r.row.status, changed: r.changed });
    }
    return { session_id: s.id, results: out, changed: out.filter((x) => x.changed).length };
  }),
});

cap({
  name: 'check_in_academy_athlete', method: 'POST', path: '/academy/sessions/:id/check-in', tag: TAG,
  summary: 'Staff check-in from a roster tap, a search result or an athlete/guardian QR pass (the pass holds only the athlete id). Records present, or late after 10 minutes. A repeated scan with the same idempotency_key, or an athlete already present, changes nothing. Not a venue check-in.',
  input: z.object({ id, user_id: id, idempotency_key: z.string().min(8).max(80), source: z.enum(['staff', 'qr']).default('qr') }),
  handler: ({ user }, i) => tx(async (c) => {
    const { s } = await sessionFor(user, i.id, 'attendance', { write: true, c });
    const cur = (await c.query('SELECT status FROM academy_attendance WHERE session_id=$1 AND user_id=$2', [s.id, i.user_id])).rows[0];
    const status = Date.now() > new Date(s.starts_at).getTime() + LATE_AFTER_MIN * 60000 ? 'late' : 'present';
    if (cur && PRESENT.includes(cur.status)) return { user_id: i.user_id, status: cur.status, changed: false };
    const r = await markAttendance(c, s, i.user_id, status, { source: i.source, actor: user.id, key: i.idempotency_key, reason: 'check-in', reason_code: null });
    return { user_id: i.user_id, status: r.row.status, changed: r.changed };
  }),
});

cap({
  name: 'self_check_in_academy_session', method: 'POST', path: '/academy/sessions/:id/self-check-in', tag: TAG,
  summary: 'An enrolled athlete (or their verified guardian, with athlete_id) checks in themselves, only when the session allows self check-in and only from an hour before the start until it ends.',
  input: z.object({ id, athlete_id: id.optional(), idempotency_key: z.string().min(8).max(80) }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = (await c.query('SELECT * FROM academy_sessions WHERE id=$1', [i.id])).rows[0];
    if (!s) throw notFound('Session');
    const who = i.athlete_id ?? user.id;
    if (who !== user.id) await requireGuardian(user, who, c);
    if (!s.self_checkin) throw forbidden('Self check-in is not switched on for this session');
    if (!(await eligible(c, s, who))) throw notFound('Session');
    if (Date.now() > new Date(s.ends_at).getTime()) throw conflict('This session has ended');
    const cur = (await c.query('SELECT status FROM academy_attendance WHERE session_id=$1 AND user_id=$2', [s.id, who])).rows[0];
    if (cur && PRESENT.includes(cur.status)) return { status: cur.status, changed: false };
    const r = await markAttendance(c, s, who, Date.now() > new Date(s.starts_at).getTime() + LATE_AFTER_MIN * 60000 ? 'late' : 'present', { source: 'self', actor: user.id, key: i.idempotency_key, reason: 'self check-in' });
    return { status: r.row.status, changed: r.changed };
  }),
});

cap({
  name: 'get_academy_attendance_history', method: 'GET', path: '/academy/sessions/:id/attendance/history', tag: TAG,
  summary: 'Every change made to a session\'s attendance (who, when, from/to, source, reason). Append-only; for staff with attendance access.',
  input: z.object({ id, user_id: id.optional(), ...page, limit: z.coerce.number().int().min(1).max(200).default(100) }),
  async handler({ user }, i) {
    const { s } = await sessionFor(user, i.id, 'attendance');
    return many(
      `SELECT l.user_id, ua.display_name AS athlete, l.from_status, l.to_status, l.source, l.reason, l.created_at, ub.display_name AS by
         FROM academy_attendance_log l JOIN users ua ON ua.id=l.user_id LEFT JOIN users ub ON ub.id=l.actor_id
        WHERE l.session_id=$1 AND ($2::uuid IS NULL OR l.user_id=$2) ORDER BY l.created_at, l.id LIMIT $3 OFFSET $4`, [s.id, i.user_id ?? null, i.limit, i.offset]);
  },
});

// ------------------------------------------------------------------ athlete / guardian side
async function subject(user, athleteId, c = pool) {
  const who = athleteId ?? user.id;
  if (who !== user.id) { await requireGuardian(user, who, c); if (!isAdmin(user) && !(await hasConsent(who, 'participation', c))) throw forbidden('A guardian consent for participation is needed to see this'); }
  return who;
}

cap({
  name: 'list_my_academy_sessions', method: 'GET', path: '/me/academy/sessions', tag: TAG,
  summary: 'Academy sessions an athlete (or a verified guardian\'s child via athlete_id) is enrolled for, with the venue, cancellation / reschedule history and the attendance mark, past and upcoming. This is a read of the academy sessions; the same sessions also appear in the personal schedule as source-linked items. Includes make-up options (same programme, free places) for missed sessions.',
  input: z.object({ athlete_id: id.optional(), from: day.optional(), to: day.optional() }),
  async handler({ user }, i) {
    const who = await subject(user, i.athlete_id);
    const from = i.from ?? new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const to = i.to ?? new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
    if (to < from || Date.parse(to) - Date.parse(from) > 186 * 86400000) throw badRequest('Choose a range of at most six months');
    const rows = await many(
      `SELECT s.id, s.organisation_id, o.name AS organisation, s.cohort_id, k.name AS cohort, s.title, s.starts_at, s.ends_at, s.timezone, s.status, s.cancel_reason, s.self_checkin, s.programme_id, s.sport, coalesce(a.status, 'expected') AS attendance, a.reason_code, coalesce(a.guest, false) AS guest,
              (SELECT v.name || ' · ' || r.name FROM session_venue_links l JOIN bookings b ON b.id=l.booking_id AND b.status='confirmed' JOIN resources r ON r.id=b.resource_id JOIN venues v ON v.id=r.venue_id WHERE l.session_type='academy_session' AND l.session_id=s.id AND l.released_at IS NULL LIMIT 1) AS venue,
              (SELECT max(ch.created_at) FROM academy_session_changes ch WHERE ch.session_id=s.id AND ch.kind='rescheduled') AS rescheduled_at
         FROM academy_sessions s JOIN org_cohorts k ON k.id=s.cohort_id JOIN organisations o ON o.id=s.organisation_id LEFT JOIN academy_attendance a ON a.session_id=s.id AND a.user_id=$1
        WHERE s.status IN ('published','cancelled','completed') AND s.starts_at >= $2::date AND s.starts_at < $3::date + 1
          AND (EXISTS (SELECT 1 FROM org_enrolments e WHERE e.cohort_id=s.cohort_id AND e.user_id=$1 AND e.status='enrolled') OR coalesce(a.guest, false))
        ORDER BY s.starts_at, s.id`, [who, from, to]);
    const missed = rows.filter((r) => r.programme_id && ['absent', 'excused', 'not_held'].includes(r.attendance) || (r.status === 'cancelled' && r.programme_id));
    const progs = [...new Set(missed.map((r) => r.programme_id))];
    const options = progs.length ? await many(
      `SELECT s.id, s.programme_id, s.title, s.starts_at, s.ends_at, s.capacity, k.name AS cohort FROM academy_sessions s JOIN org_cohorts k ON k.id=s.cohort_id
        WHERE s.programme_id = ANY($1) AND s.status='published' AND s.starts_at > now() AND s.starts_at < now() + interval '60 days'
          AND NOT EXISTS (SELECT 1 FROM academy_attendance a WHERE a.session_id=s.id AND a.user_id=$2)
          AND (s.capacity IS NULL OR s.capacity > (SELECT count(*) FROM org_enrolments e WHERE e.cohort_id=s.cohort_id AND e.status='enrolled') + (SELECT count(*) FROM academy_attendance g WHERE g.session_id=s.id AND g.guest))
        ORDER BY s.starts_at, s.id LIMIT 20`, [progs, who]) : [];
    const summary = { held: rows.filter((r) => r.status !== 'cancelled' && new Date(r.ends_at) < new Date()).length, present: rows.filter((r) => PRESENT.includes(r.attendance)).length, absent: rows.filter((r) => ['absent', 'excused'].includes(r.attendance)).length };
    return { athlete_id: who, sessions: rows.map((r) => ({ ...r, source_type: 'academy_session', source_id: r.id })), makeup_options: options, summary };
  },
});

cap({
  name: 'report_academy_absence', method: 'POST', path: '/academy/sessions/:id/absence', tag: TAG,
  summary: 'Tell the academy an athlete cannot attend (an adult athlete for themselves, or a verified guardian for their child). Advance notice records the session as excused with a safe reason code (no clinical detail); staff can change it. The assigned coaches are told.',
  input: z.object({ id, athlete_id: id.optional(), reason_code: z.enum(REASONS).default('other'), idempotency_key: z.string().min(8).max(80).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = (await c.query('SELECT * FROM academy_sessions WHERE id=$1', [i.id])).rows[0];
    if (!s) throw notFound('Session');
    const who = await subject(user, i.athlete_id, c);
    if (!(await eligible(c, s, who))) throw notFound('Session');
    if (s.status === 'cancelled') throw conflict('This session was cancelled');
    if (s.status === 'draft' || new Date(s.ends_at) < new Date()) throw conflict('Absence can only be reported for an upcoming published session');
    const cur = (await c.query('SELECT status FROM academy_attendance WHERE session_id=$1 AND user_id=$2', [s.id, who])).rows[0];
    if (cur && PRESENT.includes(cur.status)) throw conflict('This athlete is already marked present');
    const r = await markAttendance(c, { ...s, status: 'published' }, who, new Date(s.starts_at) > new Date() ? 'excused' : 'absent', { source: who === user.id ? 'self' : 'guardian', actor: user.id, key: i.idempotency_key ? `${i.idempotency_key}:${who}` : null, reason: 'absence notified', reason_code: i.reason_code });
    if (r.changed) for (const st of (await c.query("SELECT user_id FROM academy_session_staff WHERE session_id=$1 AND role='lead' AND status IN ('assigned','confirmed')", [s.id])).rows) {
      await notify(c, st.user_id, { kind: 'academy_absence', title: 'An absence was reported', body: 'Open the session roster for details.', data: { session_id: s.id }, dedupe_key: `academy-absence:${s.id}:${who}:${st.user_id}` });
    }
    return { status: r.row.status, changed: r.changed };
  }),
});

cap({
  name: 'transfer_academy_attendance', method: 'POST', path: '/academy/sessions/:id/transfer', tag: TAG, status: 201,
  summary: 'Move an athlete to another session of the same programme (make-up or transfer): checks the target is upcoming and has a free place, records the original as excused and adds the athlete as a guest on the target. Idempotent. Fees, credits or refunds are never created here; any financial consequence goes through the academy billing rules.',
  input: z.object({ id, user_id: id, to_session_id: id }),
  handler: ({ user }, i) => tx(async (c) => {
    const { s } = await sessionFor(user, i.id, 'schedule', { write: true, c });
    const t = (await c.query('SELECT * FROM academy_sessions WHERE id=$1 AND organisation_id=$2 FOR UPDATE', [i.to_session_id, s.organisation_id])).rows[0];
    if (!t) throw notFound('Target session');
    if (t.id === s.id) throw badRequest('Choose a different session');
    if (t.status !== 'published' || new Date(t.starts_at) < new Date()) throw conflict('The target must be an upcoming published session');
    if (s.programme_id && t.programme_id !== s.programme_id) throw badRequest('A transfer must stay within the same programme');
    if (!(await eligible(c, s, i.user_id))) throw badRequest('That person is not on the original session\'s roster');
    if (!(await c.query('SELECT 1 FROM academy_attendance WHERE session_id=$1 AND user_id=$2', [t.id, i.user_id])).rowCount) {
      if (t.capacity && (await expectedCount(c, t)) >= t.capacity) throw conflict('The target session is full');
      if (!(await c.query("SELECT 1 FROM org_enrolments WHERE cohort_id=$1 AND user_id=$2 AND status='enrolled'", [t.cohort_id, i.user_id])).rowCount) {
        await c.query("INSERT INTO academy_attendance(session_id, user_id, status, source, guest, marked_by, marked_at) VALUES ($1,$2,'expected','system',true,$3,now())", [t.id, i.user_id, user.id]);
        await c.query("INSERT INTO academy_attendance_log(session_id, user_id, to_status, source, actor_id, reason) VALUES ($1,$2,'expected','system',$3,'make-up / transfer in')", [t.id, i.user_id, user.id]);
      }
    }
    const cur = (await c.query('SELECT status FROM academy_attendance WHERE session_id=$1 AND user_id=$2', [s.id, i.user_id])).rows[0];
    if (!cur || !PRESENT.includes(cur.status)) await markAttendance(c, { ...s, status: 'published' }, i.user_id, 'excused', { source: 'system', actor: user.id, reason: 'transferred to another session' });
    return { from_session_id: s.id, to_session_id: t.id, user_id: i.user_id };
  }),
});

cap({
  name: 'request_academy_makeup', method: 'POST', path: '/academy/sessions/:id/makeup-request', tag: TAG, status: 201,
  summary: 'An athlete or verified guardian asks the academy for a make-up place in a specific upcoming session. The scheduling staff are notified; they decide with transfer_academy_attendance (commercial entitlement stays with the academy\'s billing rules).',
  input: z.object({ id, athlete_id: id.optional(), to_session_id: id }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = (await c.query('SELECT * FROM academy_sessions WHERE id=$1', [i.id])).rows[0];
    if (!s) throw notFound('Session');
    const who = await subject(user, i.athlete_id, c);
    if (!(await eligible(c, s, who))) throw notFound('Session');
    const t = (await c.query("SELECT id FROM academy_sessions WHERE id=$1 AND organisation_id=$2 AND status='published' AND starts_at > now()", [i.to_session_id, s.organisation_id])).rows[0];
    if (!t) throw notFound('Target session');
    for (const m of (await c.query("SELECT m.user_id FROM organisation_members m WHERE m.organisation_id=$1 AND m.status='active' AND m.role IN ('owner','admin')", [s.organisation_id])).rows) {
      await notify(c, m.user_id, { kind: 'academy_makeup_request', title: 'A make-up was requested', body: 'Open Academy Operations to review.', data: { session_id: s.id, to_session_id: t.id, organisation_id: s.organisation_id }, dedupe_key: `academy-makeup:${s.id}:${who}:${t.id}:${m.user_id}` });
    }
    return { ok: true };
  }),
});
