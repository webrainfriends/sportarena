// Trials on the academy timetable. A trial seat is a guest `academy_attendance` row on a published `trial` session, linked to the application that
// asked for it; attendance stays the one fact. The application's stage follows what attendance says: present -> trial completed, absent or a
// cancelled session -> back to "trial requested" so another time can be chosen. Nothing is deleted.
import { moveStage, recipients } from './academy.js';
import { notify } from './notify.js';
import { toLocal } from './booking/time.js';

export const LIVE = ['expected', 'present', 'late', 'left_early'];
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
/** The session as people read it: the academy's own wall-clock date and times. */
export const localView = (s) => {
  const a = toLocal(s.starts_at, s.timezone), b = toLocal(s.ends_at, s.timezone);
  return { local_date: a.date, local_start: hm(a.minutes), local_end: hm(b.minutes) };
};
export const labelOf = (s) => { const v = localView(s); return `${v.local_date} ${v.local_start}-${v.local_end}`; };

/** Told about a trial change: the people who may hear about this athlete (the guardian for a young person). Generic wording, deep link to the source. */
export async function tellTrial(c, app, session, kind, title, stamp = '') {
  for (const uid of await recipients(c, app)) {
    await notify(c, uid, { kind: `academy_trial_${kind}`, title, body: 'Open Gotmygame to see the details.', data: { organisation_id: app.organisation_id, application_id: app.id, programme_id: app.programme_id, session_id: session.id }, dedupe_key: `academy:trial:${kind}:${app.id}:${session.id}:${stamp}:${uid}` });
  }
}

/**
 * Attendance was marked on a trial seat: the application follows, including a correction of the first mark (absent <-> present). Only the
 * application's current seat counts: a mark on a seat it already left (moved to another time) never changes the application.
 */
export async function syncTrialFromAttendance(c, row, status, actor) {
  if (!row?.application_id || !['present', 'late', 'left_early', 'absent'].includes(status)) return;
  const a = (await c.query('SELECT * FROM academy_applications WHERE id=$1 FOR UPDATE', [row.application_id])).rows[0];
  if (!a) return;
  if ((await c.query("SELECT 1 FROM academy_attendance WHERE application_id=$1 AND id <> $2 AND status='expected'", [a.id, row.id])).rowCount) return; // booked elsewhere now
  const done = status !== 'absent';
  const from = done ? ['trial_booked', 'trial_requested'] : ['trial_booked', 'trial_completed'];
  if (!from.includes(a.stage)) return;
  const s = (await c.query('SELECT * FROM academy_sessions WHERE id=$1', [row.session_id])).rows[0];
  const next = await moveStage(c, a, done ? 'trial_completed' : 'trial_requested', { actor, reason: done ? 'Attended the trial' : 'Did not attend the trial' });
  await tellTrial(c, next, s, done ? 'completed' : 'missed', done ? 'Trial completed' : 'We missed you at your trial', row.row_version);
}

/** A trial session was cancelled: every application holding a live seat on it goes back to "trial requested" and the family is told. Call before the session's attendance is set to not-held. */
export async function releaseTrialBookings(c, sessionId, actor, reason) {
  const s = (await c.query('SELECT * FROM academy_sessions WHERE id=$1', [sessionId])).rows[0];
  const held = (await c.query('SELECT DISTINCT application_id FROM academy_attendance WHERE session_id=$1 AND application_id IS NOT NULL AND status = ANY($2)', [sessionId, LIVE])).rows;
  for (const { application_id } of held) {
    const a = (await c.query('SELECT * FROM academy_applications WHERE id=$1 FOR UPDATE', [application_id])).rows[0];
    if (a?.stage !== 'trial_booked') continue;
    const next = await moveStage(c, a, 'trial_requested', { actor, reason: `Trial session cancelled: ${reason}` });
    await tellTrial(c, next, s, 'cancelled', 'Your trial was cancelled', 'x');
  }
}

/** The day before: one reminder per seat. */
export async function remindAcademyTrials(c) {
  const due = (await c.query(
    `SELECT t.id AS attendance_id, t.session_id, a.* FROM academy_attendance t JOIN academy_sessions s ON s.id=t.session_id JOIN academy_applications a ON a.id=t.application_id
      WHERE t.status='expected' AND t.reminded_at IS NULL AND s.status='published' AND s.starts_at > now() AND s.starts_at <= now() + interval '24 hours' AND a.stage='trial_booked'
      ORDER BY s.starts_at, t.id LIMIT 200`)).rows;
  let n = 0;
  for (const d of due) {
    const m = (await c.query('UPDATE academy_attendance SET reminded_at=now() WHERE id=$1 AND reminded_at IS NULL RETURNING id', [d.attendance_id])).rows[0];
    if (!m) continue;
    const s = (await c.query('SELECT * FROM academy_sessions WHERE id=$1', [d.session_id])).rows[0];
    await tellTrial(c, d, s, 'reminder', 'Your trial is tomorrow', 'r');
    n++;
  }
  return n;
}

/** The application ended (withdrawn): free its live trial seat in the same transaction so it stops using capacity and leaves the roster. */
export async function releaseApplicationSeat(c, applicationId, actor, reason) {
  const seat = (await c.query("SELECT t.* FROM academy_attendance t WHERE t.application_id=$1 AND t.status='expected' FOR UPDATE", [applicationId])).rows[0];
  if (!seat) return;
  await c.query("UPDATE academy_attendance SET status='excused', reason_code='other', marked_by=$2, marked_at=now(), row_version=row_version+1 WHERE id=$1", [seat.id, actor]);
  await c.query("INSERT INTO academy_attendance_log(session_id, user_id, from_status, to_status, source, actor_id, reason) VALUES ($1,$2,'expected','excused','system',$3,$4)", [seat.session_id, seat.user_id, actor, reason]);
}
