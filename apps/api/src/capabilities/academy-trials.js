// Academy OS 1/3 follow-up: trial booking on the academy timetable (Academy OS 2/3). Families and staff pick a published `trial` session; the seat
// is a guest attendance row taken under the session lock (the same lock the make-up transfer uses), so concurrent bookings never exceed capacity.
// What happens at the trial is recorded where attendance already is recorded; the application follows it.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { orgFor } from '../org-access.js';
import { guardianLink } from '../youth.js';
import { STAFF, actFor, moveStage } from '../academy.js';
import { expectedCount, heldVenue } from '../academy-ops.js';
import { markAttendance } from './academy-attendance.js';
import { LIVE, labelOf, localView, tellTrial, releaseApplicationSeat } from '../academy-trials.js';

const TAG = 'Academy';
const stale = () => conflict('This application was changed by someone else. Reload and try again.');

/**
 * Staff of the academy, or the applicant / athlete / verified guardian: 404 for everyone else. Lock order is always session(s) -> application, the
 * same as attendance marking and session cancellation, so concurrent requests cannot deadlock: the sessions involved are locked first (in id order).
 */
async function trialAppFor(user, appId, c, { sessionId = null } = {}) {
  const peek = (await c.query('SELECT id FROM academy_applications WHERE id=$1', [appId])).rows[0];
  if (!peek) throw notFound('Application');
  const ids = new Set(sessionId ? [sessionId] : []);
  for (const r of (await c.query('SELECT session_id FROM academy_attendance WHERE application_id=$1 AND status = ANY($2)', [appId, LIVE])).rows) ids.add(r.session_id);
  for (const sid of [...ids].sort()) await c.query('SELECT id FROM academy_sessions WHERE id=$1 FOR UPDATE', [sid]);
  const a = (await c.query('SELECT * FROM academy_applications WHERE id=$1 FOR UPDATE', [appId])).rows[0];
  if (await orgFor(user, a.organisation_id, STAFF, { write: true, c }).then(() => true, () => false)) return { a, source: 'staff', staff: true };
  if (a.applicant_id === user.id || a.athlete_id === user.id) { await actFor(user, a.athlete_id, c); return { a, source: a.athlete_id === user.id ? 'self' : 'guardian', staff: false }; }
  if (await guardianLink(user.id, a.athlete_id, c)) return { a, source: 'guardian', staff: false };
  throw notFound('Application');
}
const seatOf = async (c, appId) => (await c.query(`SELECT t.*, s.starts_at, s.ends_at, s.timezone, s.status AS session_status FROM academy_attendance t JOIN academy_sessions s ON s.id=t.session_id WHERE t.application_id=$1 AND t.status = ANY($2) ORDER BY t.id DESC LIMIT 1`, [appId, LIVE])).rows[0];

cap({
  name: 'list_academy_trial_slots', method: 'GET', path: '/academy/programmes/:id/trial-slots', tag: TAG,
  summary: 'Upcoming published trial sessions of a programme with free seats (any signed-in athlete or verified guardian, and the academy\'s own staff). Public-safe: no names or counts of other people. Staff add trial sessions in the academy timetable (type "Trial").',
  input: z.object({ id, athlete_id: id.optional() }),
  async handler({ user }, i) {
    const p = await one("SELECT * FROM academy_programmes WHERE id=$1 AND status='published' AND trial_enabled", [i.id]);
    if (!p) throw notFound('Programme');
    if (!(await orgFor(user, p.organisation_id, STAFF).then(() => true, () => false))) await actFor(user, i.athlete_id ?? user.id);
    const pool = { query: async (s, a) => ({ rows: await many(s, a) }) };
    const rows = await many("SELECT * FROM academy_sessions WHERE programme_id=$1 AND delivery_type='trial' AND status='published' AND starts_at > now() ORDER BY starts_at, id LIMIT 40", [p.id]);
    const slots = [];
    for (const s of rows) {
      const taken = await expectedCount(pool, s);
      const free = s.capacity ? s.capacity - taken : null;
      if (free !== null && free <= 0) continue;
      const v = await heldVenue(pool, s.id);
      slots.push({ id: s.id, title: s.title, starts_at: s.starts_at, ends_at: s.ends_at, timezone: s.timezone, ...localView(s), seats_free: free, venue: v?.venue_name ?? v?.name ?? null });
    }
    return { slots };
  },
});

cap({
  name: 'book_academy_trial', method: 'POST', path: '/academy/applications/:id/trial/book', tag: TAG,
  summary: 'Book (or change) the trial on a published trial session. The applicant, the verified guardian or academy staff can do it. The seat is taken under the session lock, so concurrent bookings never exceed capacity. Booking waits for a trial fee to be paid or waived.',
  input: z.object({ id, row_version: z.number().int().min(1), session_id: id }),
  handler: ({ user }, i) => tx(async (c) => {
    const { a, source } = await trialAppFor(user, i.id, c, { sessionId: i.session_id });
    if (a.row_version !== i.row_version) throw stale();
    if (!['trial_requested', 'trial_booked'].includes(a.stage)) throw conflict('Ask for a trial first');
    if ((await c.query("SELECT 1 FROM academy_charges WHERE application_id=$1 AND kind='trial' AND status='awaiting_payment'", [a.id])).rows.length) throw conflict('The trial fee has not been paid yet');
    const s = (await c.query('SELECT * FROM academy_sessions WHERE id=$1', [i.session_id])).rows[0];
    if (!s || s.programme_id !== a.programme_id || s.delivery_type !== 'trial') throw notFound('Trial session');
    if (s.status !== 'published') throw conflict('This trial session is not available');
    if (new Date(s.starts_at).getTime() <= Date.now()) throw conflict('This trial session has already started');
    const prev = await seatOf(c, a.id);
    if (prev?.session_id === s.id) throw conflict('You already have a seat on this session');
    const had = (await c.query('SELECT id, status FROM academy_attendance WHERE session_id=$1 AND user_id=$2', [s.id, a.athlete_id])).rows[0];
    if (had && had.status !== 'excused') throw conflict('This athlete is already on that session');
    if ((await c.query("SELECT 1 FROM org_enrolments WHERE cohort_id=$1 AND user_id=$2 AND status='enrolled'", [s.cohort_id, a.athlete_id])).rowCount) throw conflict('This athlete is already in that group');
    if (s.capacity && (await expectedCount(c, s)) >= s.capacity) throw conflict('This trial session is full. Pick another time.');
    if (prev) await releaseApplicationSeat(c, a.id, user.id, 'Changed to another trial time');
    if (had) await c.query("UPDATE academy_attendance SET status='expected', reason_code=NULL, source=$2, application_id=$3, guest=true, marked_by=$4, marked_at=now(), reminded_at=NULL, row_version=row_version+1 WHERE id=$1", [had.id, source, a.id, user.id]); // a seat released earlier on this session is taken again
    else await c.query("INSERT INTO academy_attendance(session_id, user_id, status, source, guest, application_id, marked_by, marked_at) VALUES ($1,$2,'expected',$3,true,$4,$5,now())", [s.id, a.athlete_id, source, a.id, user.id]);
    await c.query("INSERT INTO academy_attendance_log(session_id, user_id, to_status, source, actor_id, reason) VALUES ($1,$2,'expected',$3,$4,'trial booked')", [s.id, a.athlete_id, source, user.id]);
    const row = a.stage === 'trial_requested'
      ? await moveStage(c, a, 'trial_booked', { actor: user.id, reason: `Booked ${labelOf(s)}` })
      : (await c.query('UPDATE academy_applications SET row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *', [a.id])).rows[0];
    await tellTrial(c, row, s, prev ? 'rebooked' : 'booked', prev ? 'Your trial time has changed' : 'Your trial is booked', row.row_version);
    await audit(c, user.id, 'book_academy_trial', 'academy_applications', a.id);
    return { application_id: row.id, row_version: row.row_version, stage: row.stage, session: { id: s.id, starts_at: s.starts_at, ends_at: s.ends_at, timezone: s.timezone, ...localView(s) } };
  }),
});

cap({
  name: 'cancel_academy_trial_booking', method: 'POST', path: '/academy/applications/:id/trial/cancel', tag: TAG,
  summary: 'Give up the booked trial seat so another time can be chosen (applicant, verified guardian or academy staff). The seat is recorded as excused and the application returns to "trial requested"; nothing is deleted.',
  input: z.object({ id, row_version: z.number().int().min(1), reason: z.string().trim().max(300).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { a } = await trialAppFor(user, i.id, c);
    if (a.row_version !== i.row_version) throw stale();
    if (a.stage !== 'trial_booked') throw conflict('There is no booked trial to cancel');
    const seat = await seatOf(c, a.id);
    if (!seat) throw conflict('There is no booked trial to cancel');
    if (seat.status !== 'expected') throw conflict('This trial has already been recorded');
    await releaseApplicationSeat(c, a.id, user.id, i.reason ?? 'Trial seat released');
    const row = await moveStage(c, a, 'trial_requested', { actor: user.id, reason: i.reason ?? 'Trial seat released' });
    return { application_id: row.id, row_version: row.row_version, stage: row.stage };
  }),
});

cap({
  name: 'record_academy_trial_outcome', method: 'POST', path: '/academy/applications/:id/trial/outcome', tag: TAG,
  summary: 'Staff: record what happened at the trial. This is the same attendance mark taken on the session roster: "attended" completes the trial (the athlete can now apply), "no_show" returns the application to "trial requested". Records who and why.',
  input: z.object({ id, row_version: z.number().int().min(1), outcome: z.enum(['attended', 'no_show']), note: z.string().trim().max(300).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { a, staff } = await trialAppFor(user, i.id, c);
    if (!staff) throw notFound('Application');
    if (a.row_version !== i.row_version) throw stale();
    if (a.stage !== 'trial_booked') throw conflict('This trial is not booked');
    const seat = await seatOf(c, a.id);
    if (!seat) throw conflict('This trial has no booked session');
    const s = (await c.query('SELECT * FROM academy_sessions WHERE id=$1', [seat.session_id])).rows[0];
    if (new Date(s.starts_at).getTime() - 3600e3 > Date.now()) throw conflict('The trial has not started yet');
    await markAttendance(c, s, a.athlete_id, i.outcome === 'attended' ? 'present' : 'absent', { source: 'staff', actor: user.id, reason: i.note ?? 'Recorded from the application', reason_code: i.outcome === 'no_show' ? 'other' : undefined });
    const row = (await c.query('SELECT id, stage, row_version FROM academy_applications WHERE id=$1', [a.id])).rows[0];
    return { application_id: row.id, row_version: row.row_version, stage: row.stage };
  }),
});
