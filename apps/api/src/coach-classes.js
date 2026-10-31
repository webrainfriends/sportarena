// Coach-published group classes (issue #656): the rules shared by every class capability and the maintenance sweep. A class is a dated
// occurrence of a coach's `group` rate card; seats are `coach_class_seats`. Seat changes always run under a row lock on the class so
// capacity, waitlist promotion and retries stay consistent. A held seat (awaiting payment) counts against capacity, so seats are never oversold.
// Shape follows open-games.js on purpose: same statuses, same youth/guardian handling, same generic wording to guardians.
import { badRequest, conflict } from './errors.js';
import { notify } from './notify.js';
import { hasConsent, isYouth } from './youth.js';
import { ageOfUser, LEVELS } from './open-games.js';
import { paymentsEnabled, refundFor } from './payments/service.js';
import { refundKey } from './lifecycle.js';
import { commitmentBusy } from './coach-commitments.js';

export { LEVELS };
/** Statuses that take a seat (a held seat is reserved until its payment window ends). */
export const TAKES_SEAT = ['held', 'confirmed'];
export const LIVE = ['guardian_pending', 'waitlisted', 'held', 'confirmed'];

export const endOf = (k) => new Date(+new Date(k.starts_at) + k.duration_min * 6e4);

export async function lockClass(c, classId) {
  return (await c.query('SELECT k.*, s.name AS sport_name, s.slug AS sport_slug FROM coach_classes k JOIN sports s ON s.id=k.sport_id WHERE k.id=$1 FOR UPDATE OF k', [classId])).rows[0] ?? null;
}

export const seatsTaken = async (c, classId) => Number((await c.query("SELECT count(*) AS n FROM coach_class_seats WHERE class_id=$1 AND status IN ('held','confirmed')", [classId])).rows[0].n);

/** Seat price for a rate card: per-person cards charge their price per seat; a flat group price is split across the maximum seats (rounded up so the coach is never short). */
export function seatPrice(card, minutes, maxSeats) {
  const base = Number(card.price_cents);
  const total = card.unit === 'hour' ? Math.round((base * minutes) / 60) : base;
  return card.per_person ? total : Math.ceil(total / maxSeats);
}

/** Can this person take a seat at all? Audience, age band; the caller adds guardian consent for a young person. Returns { youth }. */
export async function assertCanAttend(c, k, subjectId, actor) {
  const youth = await isYouth(subjectId, c);
  if (k.audience === 'adults' && youth) throw conflict('This class is for adults only', { code: 'adults_only' });
  if (k.audience === 'youth' && !youth) throw conflict('This class is for young players only', { code: 'youth_only' });
  if (k.min_age != null || k.max_age != null) {
    const age = await ageOfUser(subjectId, actor, c);
    if (age == null) throw conflict('Add your date of birth to join an age-restricted class', { code: 'age_required' });
    if ((k.min_age != null && age < k.min_age) || (k.max_age != null && age > k.max_age)) throw conflict(`This class is for ages ${k.min_age ?? 0}${k.max_age != null ? `–${k.max_age}` : '+'}`, { code: 'age_band' });
  }
  return { youth };
}

const guardianIds = async (c, childId) => (await c.query("SELECT guardian_id FROM guardian_links WHERE child_id=$1 AND status='active' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())", [childId])).rows.map((r) => r.guardian_id);

/** Tell a seat holder (for a young person, their guardians instead) about something. Generic wording only. */
export async function notifySeat(c, seat, { kind, title, body, key }, k) {
  const data = { class_id: k.id, seat_id: seat.id };
  const to = (await isYouth(seat.user_id, c)) ? [...new Set([...(await guardianIds(c, seat.user_id)), ...(seat.applied_by ? [seat.applied_by] : [])])] : [seat.user_id];
  for (const uid of to) await notify(c, uid, { kind, title, body, data, dedupe_key: key ? `${key}:${uid}` : undefined });
}

/** A seat is due when the class costs money and payments are on. Free classes (or payments off) confirm straight away. */
export const needsPayment = (k) => Number(k.price_cents) > 0 && paymentsEnabled();

/** Give a freed seat to this person: held until paid for a paid class, confirmed for a free one. */
export async function grantSeat(c, k, seat) {
  const pay = needsPayment(k);
  const row = (await c.query(
    `UPDATE coach_class_seats SET status=$2, payment_status=$3, amount_cents=$4,
        hold_expires_at=CASE WHEN $2='held' THEN now() + make_interval(mins => $5::int) ELSE NULL END, updated_at=now() WHERE id=$1 RETURNING *`,
    [seat.id, pay ? 'held' : 'confirmed', pay ? 'unpaid' : 'none', pay ? k.price_cents : 0, k.payment_window_min])).rows[0];
  return row;
}

/** Move the oldest waitlisted people into freed seats. Ordered (created_at, id) and idempotent: it only fills seats that are really free. */
export async function promoteWaitlist(c, k) {
  const promoted = [];
  if (k.status !== 'open' || new Date(k.starts_at) <= new Date()) return promoted;
  for (;;) {
    if ((await seatsTaken(c, k.id)) >= k.max_participants) break;
    const next = (await c.query("SELECT * FROM coach_class_seats WHERE class_id=$1 AND status='waitlisted' ORDER BY created_at, id LIMIT 1 FOR UPDATE", [k.id])).rows[0];
    if (!next) break;
    if (!(await hasConsent(next.user_id, 'participation', c))) { // a young person whose guardian withdrew consent is never promoted
      await c.query("UPDATE coach_class_seats SET status='cancelled', cancelled_at=now(), cancelled_by='system', updated_at=now() WHERE id=$1", [next.id]);
      continue;
    }
    const seat = await grantSeat(c, k, next);
    promoted.push(seat);
    await notifySeat(c, seat, seat.status === 'held'
      ? { kind: 'coach_class_seat_offered', title: 'A seat opened up', body: `A seat in "${k.title}" is yours for ${k.payment_window_min} minutes. Pay to keep it.`, key: `cc_offer:${seat.id}:${seat.hold_expires_at.getTime()}` }
      : { kind: 'coach_class_promoted', title: 'You are in!', body: `A seat opened up in "${k.title}" and it is yours.`, key: `cc_promoted:${seat.id}` }, k);
  }
  return promoted;
}

/** Refund whatever a seat paid, at the provider, then mark it. Throws if the provider refuses, so nothing is marked refunded that was not. */
export async function refundSeat(c, seat) {
  if (seat.payment_status !== 'paid') return seat.payment_status;
  await refundFor('coach_class_seat', seat.id, { key: refundKey('coach_class_seat', seat.id) });
  await c.query("UPDATE coach_class_seats SET payment_status='refunded', updated_at=now() WHERE id=$1", [seat.id]);
  return 'refunded';
}

/**
 * Cancel a whole class: every live seat is released, paid seats are refunded, everyone is told. Used by the coach and by the minimum-not-met sweep.
 * Refunds run inside the transaction through the provider; if one is refused the class is not cancelled and the error reaches the caller.
 */
export async function cancelClass(c, k, { reason, by }) {
  await c.query("UPDATE coach_classes SET status='cancelled', cancelled_reason=$2, cancelled_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1 AND status='open'", [k.id, reason]);
  const seats = (await c.query("SELECT * FROM coach_class_seats WHERE class_id=$1 AND status = ANY($2) ORDER BY created_at, id FOR UPDATE", [k.id, LIVE])).rows;
  for (const s of seats) {
    const refunded = await refundSeat(c, s);
    const row = (await c.query("UPDATE coach_class_seats SET status='cancelled', cancelled_at=now(), cancelled_by=$2, hold_expires_at=NULL, payment_status=CASE WHEN payment_status='unpaid' THEN 'none' ELSE payment_status END, updated_at=now() WHERE id=$1 RETURNING *", [s.id, by])).rows[0];
    await notifySeat(c, row, { kind: 'coach_class_cancelled', title: 'Class cancelled', body: `"${k.title}" was cancelled${reason ? `: ${reason}` : ''}.${refunded === 'refunded' ? ' Your payment is being refunded.' : ''}`, key: `cc_cancel:${s.id}` }, k);
  }
  return seats.length;
}

/** The coach must be free: no overlapping hire, commitment or other open class. Throws a conflict naming the kind of clash, never another person. */
export async function assertCoachFree(c, coachId, startsAt, durationMin, exceptClassId = null) {
  const from = new Date(startsAt), to = new Date(+from + durationMin * 6e4);
  if (await c.query("SELECT 1 FROM coach_hires WHERE coach_id=$1 AND status IN ('requested','confirmed') AND starts_at < $3 AND starts_at + make_interval(mins => duration_min) > $2 LIMIT 1", [coachId, from, to]).then((r) => r.rows[0])) throw conflict('You already have a coaching session at that time', { code: 'coach_busy', with: 'hire' });
  if (await c.query("SELECT 1 FROM coach_classes WHERE coach_id=$1 AND status='open' AND id IS DISTINCT FROM $4 AND starts_at < $3 AND starts_at + make_interval(mins => duration_min) > $2 LIMIT 1", [coachId, from, to, exceptClassId]).then((r) => r.rows[0])) throw conflict('You already have a class at that time', { code: 'coach_busy', with: 'class' });
  if ((await commitmentBusy(coachId, from, to)).length) throw conflict('That time is taken by one of your commitments', { code: 'coach_busy', with: 'commitment' });
}

export function checkTerms(i) {
  if (i.min_participants > i.max_participants) throw badRequest('min_participants is above max_participants');
  if (i.skill_min && i.skill_max && LEVELS.indexOf(i.skill_min) > LEVELS.indexOf(i.skill_max)) throw badRequest('skill_min is above skill_max');
  if (i.min_age != null && i.max_age != null && i.min_age > i.max_age) throw badRequest('min_age is above max_age');
}
