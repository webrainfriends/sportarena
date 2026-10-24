// Trials and athlete assessments (issue #315). A trial is an existing event (kind='trial'); a booking is an existing event_entries row, so
// capacity, deadline and the waitlist stay where they already live. Attendance, rubric assessments, the selection outcome and follow-up are
// separate facts keyed to that booking: attending a trial never selects anyone. Players and guardians see feedback only once staff release it,
// and a young person's feedback is hidden again the moment a guardian's coaching consent is revoked.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { notify } from '../notify.js';
import { guardianLink, guardiansOf, hasConsent, isYouth, requireConsent } from '../youth.js';
import { hasOrgGrant } from '../org-access.js';
import { STANDARD_RUBRICS } from '../standard-rubrics.js';

const TAG = 'Trials';
const text = (n) => z.string().trim().max(n);
const day = z.string().date();
const ATTENDANCE = ['present', 'late', 'left_early', 'absent', 'excused'];
const DECISIONS = ['selected', 'second_trial', 'waitlist', 'not_progressing'];
const FOLLOW_KINDS = ['book_session', 'send_resource', 'review', 'other'];
const SHARE = ['after_outcome', 'now', 'private'];
const rv = z.number().int().min(1).optional().describe('the row_version you last read; a different value means someone else changed it first (409)');

const stale = () => conflict('Someone else changed this first. Reload and try again.', { code: 'stale_version' });
const checkVersion = (row, version) => { if (version != null && row.row_version !== version) throw stale(); };

async function trialEvent(c, eventId, { lock = false } = {}) {
  const ev = (await c.query(`SELECT e.*, s.slug AS sport_slug, s.name AS sport_name FROM events e JOIN sports s ON s.id=e.sport_id WHERE e.id=$1${lock ? ' FOR UPDATE OF e' : ''}`, [eventId])).rows[0];
  if (!ev) throw notFound('Trial');
  if (ev.kind !== 'trial') throw badRequest('That event is not a trial');
  return ev;
}

/** 'organizer' (event owner / organisation admin) or 'assessor' (accepted assessor crew); null for everyone else. */
async function staffRole(user, ev, c) {
  if (isAdmin(user) || ev.organizer_id === user.id || (ev.organisation_id && await hasOrgGrant(user, ev.organisation_id, ['owner', 'admin'], c))) return 'organizer';
  const a = (await c.query("SELECT 1 FROM event_staff_assignments a JOIN event_staff_roles r ON r.id=a.role_id WHERE a.event_id=$1 AND a.user_id=$2 AND a.status='accepted' AND r.role='assessor'", [ev.id, user.id])).rows[0];
  return a ? 'assessor' : null;
}
async function needStaff(user, ev, c, { organizer = false } = {}) {
  const role = await staffRole(user, ev, c);
  if (!role || (organizer && role !== 'organizer')) throw forbidden(organizer ? 'Only the trial organiser can do this' : 'Only the organiser or an assigned assessor can do this');
  return role;
}

/** A booking on a trial, locked, with its event. Only individual (player) bookings belong to a trial roster. */
async function bookingFor(c, entryId, { lock = true } = {}) {
  const e = (await c.query(`SELECT * FROM event_entries WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [entryId])).rows[0];
  if (!e || !e.user_id) throw notFound('Trial booking');
  const ev = await trialEvent(c, e.event_id);
  return { e, ev };
}
function needRunning(ev, entry) {
  if (['draft', 'cancelled'].includes(ev.status)) throw conflict(`This trial is ${ev.status}`);
  if (entry && entry.status !== 'accepted') throw conflict(`This booking is ${entry.status}, so it cannot be marked or assessed`);
}

/** Staff action on a young person's record needs a guardian's current consent for that purpose (live, so revocation takes effect at once). */
const needYouthConsent = async (c, athleteId, purpose, what) => { if (await isYouth(athleteId, c)) await requireConsent(athleteId, purpose, what, c); };

/** Who may act for an athlete: themselves, or a currently verified guardian of a young person. */
async function actingFor(user, athleteId, c) {
  if (!athleteId || athleteId === user.id) return user.id;
  if (isAdmin(user)) return athleteId;
  if (!(await guardianLink(user.id, athleteId, c))) throw forbidden('You are not a verified guardian of this young person');
  return athleteId;
}

async function tellAthlete(c, athleteId, msg) {
  for (const uid of new Set([athleteId, ...(await guardiansOf(athleteId, c))])) await notify(c, uid, msg);
}

// ------------------------------------------------------------------------------------------------ booking
const takenSql = "SELECT count(*)::int AS n FROM event_entries WHERE event_id=$1 AND status IN ('accepted','pending')";

cap({
  name: 'book_trial', method: 'POST', path: '/trials/:id/book', tag: TAG, status: 201,
  summary: 'Book a place at a trial for yourself, or for your child (athlete_id, verified guardians only). A booking takes a seat while any are left, otherwise it joins the waitlist. Repeating the call returns the same booking. A young person needs a guardian\'s current participation and coaching consent.',
  input: z.object({ id, athlete_id: id.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ev = await trialEvent(c, i.id, { lock: true });
      const athleteId = await actingFor(user, i.athlete_id, c);
      if (ev.status !== 'open') throw conflict('This trial is not open for booking');
      if (ev.registration_deadline && ev.registration_deadline < new Date()) throw conflict('Booking closed on ' + ev.registration_deadline.toISOString());
      if (await isYouth(athleteId, c)) { await requireConsent(athleteId, 'participation', 'a trial', c); await requireConsent(athleteId, 'coaching', 'sharing trial feedback', c); }
      const prior = (await c.query('SELECT * FROM event_entries WHERE event_id=$1 AND user_id=$2 AND team_id IS NULL', [ev.id, athleteId])).rows[0];
      if (prior && prior.status !== 'withdrawn' && prior.status !== 'rejected') return { ...prior, replay: true };
      if (prior?.status === 'rejected') throw conflict('The organiser declined this booking');
      const status = ev.capacity && (await c.query(takenSql, [ev.id])).rows[0].n >= ev.capacity ? 'waitlisted' : 'accepted';
      const row = prior
        ? (await c.query('UPDATE event_entries SET status=$2, withdrawn_at=NULL, updated_at=now(), created_at=now() WHERE id=$1 RETURNING *', [prior.id, status])).rows[0]
        : (await c.query('INSERT INTO event_entries(event_id, user_id, status) VALUES ($1,$2,$3) RETURNING *', [ev.id, athleteId, status])).rows[0];
      await notify(c, ev.organizer_id, { kind: 'trial_booking', title: status === 'accepted' ? 'Trial place booked' : 'Trial waitlist joined', body: `A player ${status === 'accepted' ? 'booked' : 'joined the waitlist for'} ${ev.name}.`, data: { event_id: ev.id, entry_id: row.id } });
      return row;
    });
  },
});

cap({
  name: 'cancel_trial_booking', method: 'POST', path: '/trial-bookings/:id/cancel', tag: TAG,
  summary: 'Cancel your (or your child\'s) trial booking. The oldest waitlisted player is moved up and told. The booking row is kept, never deleted.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { e, ev } = await bookingFor(c, i.id);
      await actingFor(user, e.user_id, c);
      if (['withdrawn', 'rejected'].includes(e.status)) return e;
      if ((await c.query('SELECT 1 FROM trial_attendance WHERE entry_id=$1', [e.id])).rowCount) throw conflict('Attendance has already been recorded for this booking');
      await c.query('SELECT 1 FROM events WHERE id=$1 FOR UPDATE', [ev.id]);
      const out = (await c.query("UPDATE event_entries SET status='withdrawn', withdrawn_at=now(), updated_at=now() WHERE id=$1 RETURNING *", [e.id])).rows[0];
      if (e.status === 'accepted' && ev.capacity) {
        const next = (await c.query("SELECT * FROM event_entries WHERE event_id=$1 AND status='waitlisted' AND user_id IS NOT NULL ORDER BY created_at, id LIMIT 1 FOR UPDATE", [ev.id])).rows[0];
        if (next && (await c.query(takenSql, [ev.id])).rows[0].n < ev.capacity) {
          await c.query("UPDATE event_entries SET status='accepted', updated_at=now() WHERE id=$1", [next.id]);
          await tellAthlete(c, next.user_id, { kind: 'trial_booking', title: 'A trial place opened up', body: `You now have a place at ${ev.name}.`, data: { event_id: ev.id, entry_id: next.id } });
        }
      }
      await notify(c, ev.organizer_id, { kind: 'trial_booking', title: 'Trial booking cancelled', body: `A booking for ${ev.name} was cancelled.`, data: { event_id: ev.id, entry_id: e.id } });
      return out;
    });
  },
});

// ------------------------------------------------------------------------------------------------ what the athlete / guardian sees
/** Feedback the athlete may see: staff chose to share it now, or share it after the released outcome; private is never shown. */
const SHARED_SQL = `(a.share='now' OR (a.share='after_outcome' AND o.released_at IS NOT NULL))`;

cap({
  name: 'my_trials', method: 'GET', path: '/trials/mine', tag: TAG,
  summary: 'Your trial bookings with attendance, and the feedback, outcome and follow-up staff have released to you. Pass athlete_id to see your child\'s (verified guardians only). A young person\'s feedback shows only while a guardian\'s coaching consent is current.',
  input: z.object({ athlete_id: id.optional() }),
  async handler({ user }, i) {
    const athleteId = await actingFor(user, i.athlete_id, null);
    const showFeedback = !(await isYouth(athleteId)) || await hasConsent(athleteId, 'coaching');
    const rows = await many(
      `SELECT e.id AS entry_id, e.status AS booking_status, e.created_at AS booked_at, ev.id AS event_id, ev.name, ev.starts_on, ev.ends_on, ev.status AS event_status, s.name AS sport, s.emoji AS sport_emoji,
              v.name AS venue_name, att.status AS attendance, o.decision, o.note AS outcome_note, o.released_at
         FROM event_entries e JOIN events ev ON ev.id=e.event_id AND ev.kind='trial' JOIN sports s ON s.id=ev.sport_id LEFT JOIN venues v ON v.id=ev.venue_id
         LEFT JOIN trial_attendance att ON att.entry_id=e.id LEFT JOIN trial_outcomes o ON o.entry_id=e.id
        WHERE e.user_id=$1 AND e.team_id IS NULL ORDER BY ev.starts_on DESC NULLS LAST, e.created_at DESC, e.id`, [athleteId]);
    const out = [];
    for (const r of rows) {
      const released = !!r.released_at && showFeedback;
      const item = { entry_id: r.entry_id, event_id: r.event_id, name: r.name, sport: r.sport, sport_emoji: r.sport_emoji, venue_name: r.venue_name, starts_on: r.starts_on, ends_on: r.ends_on, event_status: r.event_status, booking_status: r.booking_status, booked_at: r.booked_at, attendance: r.attendance ?? null, outcome: released ? { decision: r.decision, note: r.outcome_note, released_at: r.released_at } : null, feedback: [], follow_ups: [], feedback_hidden: !showFeedback };
      if (showFeedback) {
        item.feedback = await many(
          `SELECT a.id, a.rubric_name, a.dimensions, a.scores, a.feedback, a.assessed_at, u.display_name AS assessor_name
             FROM trial_assessments a JOIN users u ON u.id=a.assessor_id LEFT JOIN trial_outcomes o ON o.entry_id=a.entry_id
            WHERE a.entry_id=$1 AND ${SHARED_SQL} ORDER BY a.assessed_at, a.id`, [r.entry_id]);
        if (released) item.follow_ups = await many(
          `SELECT f.id, f.kind, f.title, f.detail, f.due_on, f.status, f.next_event_id, n.name AS next_event_name, n.starts_on AS next_event_starts_on, (n.status='open' AND (n.registration_deadline IS NULL OR n.registration_deadline > now())) AS next_event_open,
                  b.status AS next_booking_status
             FROM trial_follow_ups f LEFT JOIN events n ON n.id=f.next_event_id LEFT JOIN event_entries b ON b.event_id=f.next_event_id AND b.user_id=$2 AND b.team_id IS NULL
            WHERE f.entry_id=$1 AND f.status<>'cancelled' ORDER BY f.due_on NULLS LAST, f.created_at, f.id`, [r.entry_id, athleteId]);
      }
      out.push(item);
    }
    return { athlete_id: athleteId, items: out };
  },
});

// ------------------------------------------------------------------------------------------------ staff: roster and attendance
cap({
  name: 'get_trial_session', method: 'GET', path: '/trials/:id/session', tag: TAG,
  summary: 'Organiser / assessor: the trial roster with capacity, waitlist, each player\'s attendance, outcome and your assessment. A young person\'s assessments are withheld (restricted) while no guardian coaching consent is current. Reading assessments is audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ev = await trialEvent(pool, i.id);
    const role = await needStaff(user, ev, pool);
    const rows = await many(
      `SELECT e.id AS entry_id, e.status AS booking_status, e.created_at AS booked_at, u.id AS athlete_id, u.display_name, u.handle, u.avatar_emoji, u.avatar_color,
              (u.youth_until IS NOT NULL AND u.youth_until > current_date) AS is_youth, att.status AS attendance, att.reason AS attendance_reason, att.row_version AS attendance_version,
              o.decision, o.note AS outcome_note, o.released_at, o.row_version AS outcome_version
         FROM event_entries e JOIN users u ON u.id=e.user_id LEFT JOIN trial_attendance att ON att.entry_id=e.id LEFT JOIN trial_outcomes o ON o.entry_id=e.id
        WHERE e.event_id=$1 AND e.team_id IS NULL AND e.status IN ('accepted','pending','waitlisted') ORDER BY e.status='waitlisted', e.created_at, e.id`, [ev.id]);
    const roster = [];
    for (const r of rows) {
      const restricted = r.is_youth && !(await hasConsent(r.athlete_id, 'coaching'));
      const item = { ...r, restricted, assessments: [], follow_ups: [] };
      if (!restricted) {
        item.assessments = await many(
          `SELECT a.id, a.assessor_id, u.display_name AS assessor_name, a.rubric_ref, a.rubric_name, a.rubric_version, a.dimensions, a.scores, a.feedback, a.share, a.assessed_at, a.updated_at, a.row_version,
                  CASE WHEN a.assessor_id=$2 OR $3 THEN a.private_note END AS private_note
             FROM trial_assessments a JOIN users u ON u.id=a.assessor_id WHERE a.entry_id=$1 ORDER BY a.assessed_at, a.id`, [r.entry_id, user.id, role === 'organizer']);
        item.follow_ups = await many("SELECT * FROM trial_follow_ups WHERE entry_id=$1 ORDER BY created_at, id", [r.entry_id]);
      }
      roster.push(item);
    }
    await audit(null, user.id, 'trial.session.read', 'event', ev.id);
    const booked = roster.filter((r) => r.booking_status !== 'waitlisted');
    return { event: { id: ev.id, name: ev.name, status: ev.status, sport: ev.sport_name, sport_slug: ev.sport_slug, starts_on: ev.starts_on, capacity: ev.capacity, registration_deadline: ev.registration_deadline }, your_role: role, booked: booked.length, waitlisted: roster.length - booked.length, roster };
  },
});

cap({
  name: 'mark_trial_attendance', method: 'POST', path: '/trial-bookings/:id/attendance', tag: TAG,
  summary: 'Organiser / assessor: record present, late, left early, absent or excused for a booked player. Repeating the same mark changes nothing; correcting an earlier mark needs a reason and is logged. Marking attendance never selects a player. Young people need a guardian\'s current participation consent.',
  input: z.object({ id, status: z.enum(ATTENDANCE), reason: text(300).optional(), row_version: rv }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { e, ev } = await bookingFor(c, i.id);
      await needStaff(user, ev, c);
      needRunning(ev, e);
      if (!(await c.query('SELECT (starts_on IS NULL OR starts_on <= current_date) AS ok FROM events WHERE id=$1', [ev.id])).rows[0].ok) throw conflict('Attendance can be recorded from the day of the trial');
      await needYouthConsent(c, e.user_id, 'participation', 'trial attendance');
      const cur = (await c.query('SELECT * FROM trial_attendance WHERE entry_id=$1 FOR UPDATE', [e.id])).rows[0];
      if (cur) { checkVersion(cur, i.row_version); if (cur.status === i.status) return cur; if (!i.reason) throw badRequest('Say why you are correcting this mark'); }
      const row = cur
        ? (await c.query('UPDATE trial_attendance SET status=$2, reason=$3, marked_by=$4, marked_at=now(), row_version=row_version+1 WHERE entry_id=$1 RETURNING *', [e.id, i.status, i.reason ?? null, user.id])).rows[0]
        : (await c.query('INSERT INTO trial_attendance(entry_id, event_id, status, reason, marked_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [e.id, ev.id, i.status, i.reason ?? null, user.id])).rows[0];
      await c.query('INSERT INTO trial_attendance_log(entry_id, from_status, to_status, reason, actor_id) VALUES ($1,$2,$3,$4,$5)', [e.id, cur?.status ?? null, i.status, i.reason ?? null, user.id]);
      return row;
    });
  },
});

// ------------------------------------------------------------------------------------------------ rubric assessments
async function rubricsFor(c, user, ev) {
  const std = STANDARD_RUBRICS.filter((r) => r.sports.includes(ev.sport_slug)).map((r) => ({ ref: `standard:${r.key}`, name: r.name, source: r.source, version: null, dimensions: r.dimensions }));
  const own = (await c.query(
    `SELECT r.id, r.name, v.version, v.dimensions FROM coaching_rubrics r JOIN LATERAL (SELECT * FROM coaching_rubric_versions x WHERE x.rubric_id=r.id ORDER BY version DESC LIMIT 1) v ON true
      WHERE r.coach_id=$1 AND r.archived_at IS NULL AND r.standard_key IS NULL
        AND (NOT EXISTS (SELECT 1 FROM coaching_rubric_sports l WHERE l.rubric_id=r.id AND l.removed_at IS NULL) OR EXISTS (SELECT 1 FROM coaching_rubric_sports l WHERE l.rubric_id=r.id AND l.removed_at IS NULL AND l.sport_id=$2))
      ORDER BY r.name, r.id`, [user.id, ev.sport_id])).rows.map((r) => ({ ref: `coaching:${r.id}`, name: r.name, source: 'My rubric', version: r.version, dimensions: r.dimensions }));
  return [...std, ...own];
}

cap({
  name: 'list_trial_rubrics', method: 'GET', path: '/trials/:id/rubrics', tag: TAG,
  summary: 'Organiser / assessor: the sport-specific rubrics you can assess this trial with — the standard frameworks for the trial\'s sport plus your own coaching rubrics for it.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => { const ev = await trialEvent(c, i.id); await needStaff(user, ev, c); return { items: await rubricsFor(c, user, ev) }; });
  },
});

cap({
  name: 'save_trial_assessment', method: 'POST', path: '/trial-bookings/:id/assessment', tag: TAG, status: 201,
  summary: 'Organiser / assessor: score a booked player against a sport rubric and add dated feedback. One assessment per assessor and booking; saving again edits it (send row_version) and keeps every earlier revision. feedback is for the player; private_note stays staff-only. share: after_outcome (default), now, or private. A client_key makes retries safe.',
  input: z.object({
    id, rubric_ref: z.string().max(80), scores: z.record(z.string(), z.number()), feedback: text(2000).optional(), private_note: text(2000).optional(),
    share: z.enum(SHARE).default('after_outcome'), row_version: rv, client_key: z.string().min(8).max(80).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { e, ev } = await bookingFor(c, i.id);
      await needStaff(user, ev, c);
      needRunning(ev, e);
      await needYouthConsent(c, e.user_id, 'coaching', 'a trial assessment');
      const att = (await c.query('SELECT status FROM trial_attendance WHERE entry_id=$1', [e.id])).rows[0];
      if (!att) throw conflict('Record attendance before assessing');
      if (['absent', 'excused'].includes(att.status)) throw conflict(`This player was marked ${att.status}, so there is nothing to assess`);
      const rubric = (await rubricsFor(c, user, ev)).find((r) => r.ref === i.rubric_ref);
      if (!rubric) throw badRequest('That rubric is not available for this trial\'s sport');
      const dims = new Map(rubric.dimensions.map((d) => [d.key, d]));
      const keys = Object.keys(i.scores);
      if (!keys.length) throw badRequest('Score at least one dimension');
      for (const k of keys) {
        const d = dims.get(k);
        if (!d) throw badRequest(`Unknown dimension: ${k}`);
        if (i.scores[k] < d.scale_min || i.scores[k] > d.scale_max) throw badRequest(`${d.name} must be between ${d.scale_min} and ${d.scale_max}`);
      }
      const cur = (await c.query('SELECT * FROM trial_assessments WHERE entry_id=$1 AND assessor_id=$2 FOR UPDATE', [e.id, user.id])).rows[0];
      if (i.client_key) {
        const dup = (await c.query('SELECT * FROM trial_assessments WHERE assessor_id=$1 AND client_key=$2', [user.id, i.client_key])).rows[0];
        if (dup) return dup;
      }
      if (cur) {
        if (i.row_version == null) throw conflict('You already assessed this player. Reload it and send its row_version to edit.', { code: 'stale_version' });
        checkVersion(cur, i.row_version);
        const row = (await c.query(
          `UPDATE trial_assessments SET rubric_ref=$2, rubric_name=$3, rubric_version=$4, dimensions=$5, scores=$6, feedback=$7, private_note=$8, share=$9, updated_at=now(), row_version=row_version+1 WHERE id=$1 RETURNING *`,
          [cur.id, rubric.ref, rubric.name, rubric.version, JSON.stringify(rubric.dimensions), JSON.stringify(i.scores), i.feedback ?? null, i.private_note ?? null, i.share])).rows[0];
        await c.query('INSERT INTO trial_assessment_revisions(assessment_id, row_version, scores, feedback, share, actor_id) VALUES ($1,$2,$3,$4,$5,$6)', [row.id, row.row_version, row.scores, row.feedback, row.share, user.id]);
        return row;
      }
      const row = (await c.query(
        `INSERT INTO trial_assessments(event_id, entry_id, athlete_id, assessor_id, rubric_ref, rubric_name, rubric_version, dimensions, scores, feedback, private_note, share, client_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [ev.id, e.id, e.user_id, user.id, rubric.ref, rubric.name, rubric.version, JSON.stringify(rubric.dimensions), JSON.stringify(i.scores), i.feedback ?? null, i.private_note ?? null, i.share, i.client_key ?? null])).rows[0];
      await c.query('INSERT INTO trial_assessment_revisions(assessment_id, row_version, scores, feedback, share, actor_id) VALUES ($1,$2,$3,$4,$5,$6)', [row.id, row.row_version, row.scores, row.feedback, row.share, user.id]);
      if (i.share === 'now') await tellAthlete(c, e.user_id, { kind: 'trial_feedback', title: 'New trial feedback', body: `Feedback from ${ev.name} is ready to view.`, data: { event_id: ev.id, entry_id: e.id } });
      return row;
    });
  },
});

// ------------------------------------------------------------------------------------------------ outcome, release, follow-up
cap({
  name: 'set_trial_outcome', method: 'POST', path: '/trial-bookings/:id/outcome', tag: TAG,
  summary: 'Organiser: record the selection decision (selected, second trial, waitlist, not progressing). It is separate from attendance and stays private until released. Changing it is logged; after release the change is re-shown on the next release.',
  input: z.object({ id, decision: z.enum(DECISIONS), note: text(1000).optional(), row_version: rv }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { e, ev } = await bookingFor(c, i.id);
      await needStaff(user, ev, c, { organizer: true });
      needRunning(ev, e);
      await needYouthConsent(c, e.user_id, 'coaching', 'a trial outcome');
      const att = (await c.query('SELECT status FROM trial_attendance WHERE entry_id=$1', [e.id])).rows[0];
      if (!att || ['absent', 'excused'].includes(att.status)) throw conflict('Only a player who attended can be given an outcome');
      const cur = (await c.query('SELECT * FROM trial_outcomes WHERE entry_id=$1 FOR UPDATE', [e.id])).rows[0];
      if (cur) { checkVersion(cur, i.row_version); if (cur.decision === i.decision && (i.note ?? null) === cur.note) return cur; }
      const row = cur
        ? (await c.query('UPDATE trial_outcomes SET decision=$2, note=$3, decided_by=$4, decided_at=now(), released_at=NULL, released_by=NULL, row_version=row_version+1 WHERE entry_id=$1 RETURNING *', [e.id, i.decision, i.note ?? null, user.id])).rows[0]
        : (await c.query('INSERT INTO trial_outcomes(entry_id, event_id, decision, note, decided_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [e.id, ev.id, i.decision, i.note ?? null, user.id])).rows[0];
      await c.query('INSERT INTO trial_outcome_log(entry_id, from_decision, to_decision, note, actor_id) VALUES ($1,$2,$3,$4,$5)', [e.id, cur?.decision ?? null, i.decision, i.note ?? null, user.id]);
      return row;
    });
  },
});

cap({
  name: 'release_trial_feedback', method: 'POST', path: '/trial-bookings/:id/release', tag: TAG,
  summary: 'Organiser: release the outcome, shared assessments and follow-ups to the player and their verified guardians (all are notified). Repeating it does nothing. A young person\'s guardian can still withdraw coaching consent, which hides it again immediately.',
  input: z.object({ id, row_version: rv }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { e, ev } = await bookingFor(c, i.id);
      await needStaff(user, ev, c, { organizer: true });
      await needYouthConsent(c, e.user_id, 'coaching', 'releasing trial feedback');
      const o = (await c.query('SELECT * FROM trial_outcomes WHERE entry_id=$1 FOR UPDATE', [e.id])).rows[0];
      if (!o) throw conflict('Record an outcome before releasing feedback');
      checkVersion(o, i.row_version);
      if (o.released_at) return o;
      const row = (await c.query('UPDATE trial_outcomes SET released_at=now(), released_by=$2, row_version=row_version+1 WHERE entry_id=$1 RETURNING *', [e.id, user.id])).rows[0];
      await tellAthlete(c, e.user_id, { kind: 'trial_outcome', title: 'Your trial result is ready', body: `The outcome and feedback for ${ev.name} are ready to view.`, data: { event_id: ev.id, entry_id: e.id } });
      return row;
    });
  },
});

cap({
  name: 'add_trial_follow_up', method: 'POST', path: '/trial-bookings/:id/follow-ups', tag: TAG, status: 201,
  summary: 'Organiser / assessor: add a follow-up for a booked player (book a session, send a resource, review later). The due date is a calendar date; the owner defaults to you. The player sees it once the outcome is released.',
  input: z.object({ id, kind: z.enum(FOLLOW_KINDS), title: text(160).min(2), detail: text(1000).optional(), due_on: day.optional(), owner_id: id.optional(), next_event_id: id.optional().describe('another trial (e.g. the second round) the player can book from their card; for kind book_session'), client_key: z.string().min(8).max(80).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { e, ev } = await bookingFor(c, i.id);
      await needStaff(user, ev, c);
      needRunning(ev, e);
      await needYouthConsent(c, e.user_id, 'coaching', 'a trial follow-up');
      if (i.next_event_id) {
        if (i.kind !== 'book_session') throw badRequest('Only a book_session follow-up can point at a trial');
        const nx = await trialEvent(c, i.next_event_id);
        if (nx.id === ev.id) throw badRequest('Pick a different trial');
        if (nx.sport_id !== ev.sport_id) throw badRequest('The next trial is for a different sport');
      }
      if (i.client_key) { const dup = (await c.query('SELECT * FROM trial_follow_ups WHERE created_by=$1 AND client_key=$2', [user.id, i.client_key])).rows[0]; if (dup) return dup; }
      if (i.owner_id && i.owner_id !== user.id && !(await c.query('SELECT 1 FROM users WHERE id=$1', [i.owner_id])).rowCount) throw badRequest('Unknown owner');
      return (await c.query(
        'INSERT INTO trial_follow_ups(event_id, entry_id, athlete_id, kind, title, detail, due_on, owner_id, created_by, client_key, next_event_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
        [ev.id, e.id, e.user_id, i.kind, i.title, i.detail ?? null, i.due_on ?? null, i.owner_id ?? user.id, user.id, i.client_key ?? null, i.next_event_id ?? null])).rows[0];
    });
  },
});

cap({
  name: 'update_trial_follow_up', method: 'PATCH', path: '/trial-follow-ups/:id', tag: TAG,
  summary: 'Organiser / assessor: mark a follow-up done or cancelled, or change its title, detail or due date. Follow-ups are kept, never deleted.',
  input: z.object({ id, status: z.enum(['open', 'done', 'cancelled']).optional(), title: text(160).min(2).optional(), detail: text(1000).optional(), due_on: day.optional(), row_version: rv }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const f = (await c.query('SELECT * FROM trial_follow_ups WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!f) throw notFound('Follow-up');
      await needStaff(user, await trialEvent(c, f.event_id), c);
      checkVersion(f, i.row_version);
      return (await c.query(
        'UPDATE trial_follow_ups SET status=coalesce($2,status), title=coalesce($3,title), detail=coalesce($4,detail), due_on=coalesce($5::date,due_on), updated_at=now(), row_version=row_version+1 WHERE id=$1 RETURNING *',
        [f.id, i.status ?? null, i.title ?? null, i.detail ?? null, i.due_on ?? null])).rows[0];
    });
  },
});

// ------------------------------------------------------------------------------------------------ export
const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s; };

cap({
  name: 'export_trial_results', method: 'GET', path: '/trials/:id/export', tag: TAG,
  summary: 'Organiser: CSV of every booked player with attendance, outcome and each assessment\'s scores and feedback (never private notes). Young people without a current guardian coaching consent are left out and counted. The export is audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ev = await trialEvent(pool, i.id);
    await needStaff(user, ev, pool, { organizer: true });
    const rows = await many(
      `SELECT e.id AS entry_id, e.status AS booking_status, u.id AS athlete_id, u.display_name, (u.youth_until IS NOT NULL AND u.youth_until > current_date) AS is_youth,
              att.status AS attendance, o.decision, o.released_at
         FROM event_entries e JOIN users u ON u.id=e.user_id LEFT JOIN trial_attendance att ON att.entry_id=e.id LEFT JOIN trial_outcomes o ON o.entry_id=e.id
        WHERE e.event_id=$1 AND e.team_id IS NULL AND e.status IN ('accepted','waitlisted') ORDER BY e.created_at, e.id`, [ev.id]);
    const lines = [['player', 'booking', 'attendance', 'outcome', 'released', 'assessor', 'assessed_at', 'rubric', 'scores', 'feedback']];
    let withheld = 0;
    for (const r of rows) {
      if (r.is_youth && !(await hasConsent(r.athlete_id, 'coaching'))) { withheld++; continue; }
      const a = await many('SELECT a.*, u.display_name AS assessor FROM trial_assessments a JOIN users u ON u.id=a.assessor_id WHERE a.entry_id=$1 ORDER BY a.assessed_at, a.id', [r.entry_id]);
      const base = [r.display_name, r.booking_status, r.attendance ?? '', r.decision ?? '', r.released_at ? 'yes' : 'no'];
      if (!a.length) lines.push([...base, '', '', '', '', '']);
      for (const x of a) lines.push([...base, x.assessor, x.assessed_at.toISOString(), x.rubric_name, Object.entries(x.scores).map(([k, v]) => `${k}=${v}`).join('; '), x.feedback ?? '']);
    }
    await audit(null, user.id, 'trial.export', 'event', ev.id);
    return { filename: `trial-${ev.id}.csv`, content_type: 'text/csv', csv: lines.map((l) => l.map(csvCell).join(',')).join('\n'), rows: lines.length - 1, withheld_young_people: withheld };
  },
});
