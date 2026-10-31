// Coach-published group classes (issue #656): the rules shared by every class capability and sweep.
// A class is a dated occurrence of a coach's `group` rate card; seats are `coach_class_seats`. Every seat change runs under a row lock on
// the class (the same pattern as open games), so capacity cannot be oversold and a retry replays instead of duplicating.
import { many, tx } from './db.js';
import { config } from './config.js';
import { conflict } from './errors.js';
import { notify } from './notify.js';
import { paymentsEnabled, refundFor } from './payments/service.js';
import { refundKey } from './lifecycle.js';
import { guardiansOf, hasConsent, isYouth } from './youth.js';
import { ageOfUser } from './open-games.js';
import { commitmentBusy } from './coach-commitments.js';
import { classBusy, lockCoachCalendar } from './coach-class-busy.js';

export { classBusy, lockCoachCalendar };

/** Statuses that take a seat, and every status that is still "in" the class. */
export const SEAT = ['held', 'confirmed'];
export const LIVE = ['guardian_pending', 'waitlisted', 'held', 'confirmed'];

/** How long a promoted or newly held seat waits for payment. */
export const payWindowMin = () => config.waitlistHoldMinutes;

export async function lockClass(c, id) {
  return (await c.query('SELECT k.*, s.name AS sport_name, s.slug AS sport_slug FROM coach_classes k JOIN sports s ON s.id=k.sport_id WHERE k.id=$1 FOR UPDATE OF k', [id])).rows[0] ?? null;
}

export const seatsTaken = async (c, classId) => Number((await c.query("SELECT count(*) AS n FROM coach_class_seats WHERE class_id=$1 AND status = ANY($2)", [classId, SEAT])).rows[0].n);
export const confirmedCount = async (c, classId) => Number((await c.query("SELECT count(*) AS n FROM coach_class_seats WHERE class_id=$1 AND status='confirmed'", [classId])).rows[0].n);

export const endOf = (k) => new Date(+new Date(k.starts_at) + k.duration_min * 60_000);

/** Why the coach cannot take this slot, or null when it is free: another class, a requested/confirmed hire, or a commitment. */
export async function clashReason(c, coachId, start, mins, { excludeId } = {}) {
  const end = new Date(+start + mins * 60_000);
  if ((await classBusy(coachId, start, end, { client: c, excludeId })).length) return 'You already run a class then';
  if ((await c.query("SELECT 1 FROM coach_hires WHERE coach_id=$1 AND status IN ('requested','confirmed') AND starts_at < $3 AND starts_at + make_interval(mins => duration_min) > $2", [coachId, start, end])).rowCount) return 'You have a coaching session booked then';
  if ((await commitmentBusy(coachId, start, end)).length) return 'You have another commitment then';
  return null;
}

/** Class-specific audience and age rules. Date of birth is read decrypted and audit-logged, only when an age band is set. */
export async function assertCanJoin(c, k, subjectId, actor) {
  const youth = await isYouth(subjectId, c);
  if (k.audience === 'adults' && youth) throw conflict('This class is for adults only', { code: 'adults_only' });
  if (k.audience === 'youth' && !youth) throw conflict('This class is for young people only', { code: 'youth_only' });
  if (k.min_age != null || k.max_age != null) {
    const age = await ageOfUser(subjectId, actor, c);
    if (age == null) throw conflict('Add your date of birth to join an age-restricted class', { code: 'age_required' });
    if ((k.min_age != null && age < k.min_age) || (k.max_age != null && age > k.max_age)) throw conflict(`This class is for ages ${k.min_age ?? 0}${k.max_age != null ? `–${k.max_age}` : '+'}`, { code: 'age_band' });
  }
  return { youth };
}

/** Tell a seat holder about something. A young person's guardians (and whoever applied) are told instead of them. Generic wording only. */
export async function notifySeat(c, seat, k, { kind, title, body, key }) {
  const data = { class_id: k.id, seat_id: seat.id };
  const to = (await isYouth(seat.user_id, c)) ? [...new Set([...(await guardiansOf(seat.user_id, c)), ...(seat.applied_by ? [seat.applied_by] : [])])] : [seat.user_id];
  for (const uid of to) await notify(c, uid, { kind, title, body, data, dedupe_key: key ? `${key}:${uid}` : undefined });
}

/** Put a seat in the right place: a free class takes it straight away, a paid one holds it for the payment window, a full class queues it. */
export async function placeSeat(c, k, seat) {
  const taken = await seatsTaken(c, k.id);
  if (taken >= k.max_participants) return (await c.query("UPDATE coach_class_seats SET status='waitlisted', payment_status='not_required', pay_by=NULL, price_cents=$2, updated_at=now() WHERE id=$1 RETURNING *", [seat.id, k.price_cents])).rows[0];
  return takeSeat(c, k, seat);
}

/** Give a seat to this person: confirmed at once when nothing is owed, otherwise held until `pay_by`. */
async function takeSeat(c, k, seat) {
  const owed = Number(k.price_cents) > 0 && paymentsEnabled();
  const row = (await c.query(
    `UPDATE coach_class_seats SET status=$2, payment_status=$3, price_cents=$4,
            pay_by=CASE WHEN $2='held' THEN least(now() + make_interval(mins => $5::int), $6::timestamptz) END, updated_at=now()
      WHERE id=$1 RETURNING *`,
    [seat.id, owed ? 'held' : 'confirmed', owed ? 'unpaid' : 'not_required', k.price_cents, payWindowMin(), k.starts_at])).rows[0];
  await nudgeCoach(c, k);
  return row;
}

/** Tell the coach when the class is nearly full / full (once per level). */
async function nudgeCoach(c, k) {
  const left = k.max_participants - (await seatsTaken(c, k.id));
  if (left > 1) return;
  await notify(c, k.coach_id, {
    kind: left === 0 ? 'coach_class_full' : 'coach_class_nearly_full', title: left === 0 ? 'Your class is full' : 'Your class is nearly full',
    body: left === 0 ? `"${k.title}" has every seat taken. New people join the waitlist.` : `Only one seat left in "${k.title}".`,
    data: { class_id: k.id }, dedupe_key: `cc_fill:${k.id}:${left}:${k.row_version}`,
  });
}

/** Move the oldest waitlisted people into freed seats, in order. A young person whose guardian withdrew consent is never promoted. */
export async function promoteWaitlist(c, k) {
  const promoted = [];
  for (;;) {
    if ((await seatsTaken(c, k.id)) >= k.max_participants) break;
    const next = (await c.query("SELECT * FROM coach_class_seats WHERE class_id=$1 AND status='waitlisted' ORDER BY queued_at, id LIMIT 1 FOR UPDATE", [k.id])).rows[0];
    if (!next) break;
    if (!(await hasConsent(next.user_id, 'participation', c))) {
      await c.query("UPDATE coach_class_seats SET status='cancelled', cancelled_at=now(), updated_at=now() WHERE id=$1", [next.id]);
      continue;
    }
    const seat = await takeSeat(c, k, next);
    promoted.push(seat);
    await notifySeat(c, seat, k, {
      kind: 'coach_class_promoted', title: seat.status === 'held' ? 'A seat opened up — pay to keep it' : 'You are in!',
      body: seat.status === 'held' ? `A seat opened in "${k.title}". It is yours if you pay within ${payWindowMin()} minutes.` : `A seat opened in "${k.title}" and it is yours.`,
      key: `cc_promoted:${seat.id}:${new Date(seat.updated_at).getTime()}`,
    });
  }
  return promoted;
}

/** Refund every seat marked refund_due. Idempotent: the provider call carries a per-seat key and a seat is only marked refunded afterwards. */
export async function processRefunds(classId) {
  const due = await many("SELECT id FROM coach_class_seats WHERE payment_status='refund_due' AND ($1::uuid IS NULL OR class_id=$1) ORDER BY updated_at, id LIMIT 200", [classId ?? null]);
  let done = 0;
  for (const { id } of due) {
    try {
      await refundFor('coach_class_seat', id, { key: refundKey('coach_class_seat', id) });
      await tx((c) => c.query("UPDATE coach_class_seats SET payment_status='refunded', updated_at=now() WHERE id=$1 AND payment_status='refund_due'", [id]));
      done++;
    } catch (e) { console.error('[coach-classes] refund will be retried', id, String(e.message).slice(0, 200)); }
  }
  return done;
}

/** Call a class off (caller holds the class lock): every live seat is ended, paid seats are marked for refund, everyone is told. Refunds run after commit. */
export async function cancelClassTx(c, k, { by, reason }) {
  await c.query("UPDATE session_venue_links SET released_at=now(), release_reason='class cancelled' WHERE session_type='coach_class' AND session_id=$1 AND released_at IS NULL", [k.id]);   // the booking itself stays; the coach decides whether to keep the court
  await c.query("UPDATE coach_classes SET status='cancelled', cancelled_by=$2, cancelled_reason=$3, row_version=row_version+1, updated_at=now() WHERE id=$1", [k.id, by, reason ?? null]);
  const seats = (await c.query(
    `UPDATE coach_class_seats SET status='cancelled', cancelled_at=now(), updated_at=now(), pay_by=NULL,
            payment_status=CASE WHEN payment_status='paid' THEN 'refund_due' ELSE payment_status END
      WHERE class_id=$1 AND status = ANY($2) RETURNING *`, [k.id, LIVE])).rows;
  const why = by === 'min_not_met' ? 'It did not reach the minimum number of people.' : reason ? `Reason: ${reason}` : '';
  for (const s of seats) {
    const refund = s.payment_status === 'refund_due' ? ' You will be refunded in full.' : '';
    await notifySeat(c, s, k, { kind: 'coach_class_cancelled', title: 'Class cancelled', body: `"${k.title}" was cancelled. ${why}${refund}`.replace(/\s+/g, ' ').trim(), key: `cc_cancelled:${k.id}:${s.id}` });
  }
  return seats;
}

/** One attendance fact per seat, mirrored into the coach's Performance Studio record for the class (when one is open) so evidence never disagrees. */
export async function mirrorClassAttendance(c, classId) {
  await c.query(
    `UPDATE coaching_session_participants p SET attendance = CASE s.attendance WHEN 'attended' THEN 'present' WHEN 'no_show' THEN 'absent' ELSE p.attendance END,
            arrived_at = CASE WHEN s.attendance='attended' THEN coalesce(p.arrived_at, now()) ELSE p.arrived_at END, updated_at=now()
       FROM coaching_session_records r, coach_class_seats s
      WHERE r.source_type='coach_class' AND r.source_id=$2::text AND p.session_record_id=r.id AND s.class_id=$1::uuid AND s.user_id=p.athlete_id AND s.attendance IS NOT NULL AND s.status='confirmed'`, [classId, String(classId)]);
}


/** A court is now held for the class: the class names that venue, and the people booked in are told if the place changed. Caller holds the transaction. */
export async function onClassVenueHeld(c, classId, bookingId) {
  const venue = (await c.query('SELECT r.venue_id, v.name FROM bookings b JOIN resources r ON r.id=b.resource_id JOIN venues v ON v.id=r.venue_id WHERE b.id=$1', [bookingId])).rows[0];
  const k = (await c.query('SELECT * FROM coach_classes WHERE id=$1 FOR UPDATE', [classId])).rows[0];
  if (!venue || !k || k.venue_id === venue.venue_id) return;
  await c.query('UPDATE coach_classes SET venue_id=$2, row_version=row_version+1, updated_at=now() WHERE id=$1', [classId, venue.venue_id]);
  const seats = (await c.query("SELECT * FROM coach_class_seats WHERE class_id=$1 AND status = ANY($2)", [classId, LIVE])).rows;
  for (const s of seats) await notifySeat(c, s, k, { kind: 'coach_class_changed', title: 'Class venue confirmed', body: `"${k.title}" will be held at ${venue.name}. Open the app for the details.`, key: `cc_venue:${classId}:${venue.venue_id}:${s.id}` });
}
