// Lockers handed out with bookings. A locker + PIN belongs to one reservation at one venue for the time its bookings cover
// (plus a little either side to change). The PIN is encrypted at rest; it is shown to the booker and the venue team only,
// inside the booking details, and never put in a notification (those can leave by email and push).
import { randomInt } from 'node:crypto';
import { encrypt, decrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { badRequest, conflict } from '../errors.js';
import { revokeGrantsForSource, revokeStaleBookingGrants } from '../access-grants.js';

export const LOCKER_PAD_MS = 30 * 60_000;
const CTX = 'locker_assignments.pin';
export const sealPin = (pin) => encrypt(pin, CTX);
export const openPin = (enc) => decrypt(enc, CTX);

/** A random numeric PIN that is not trivially guessable (no 0000 / 1111 / 1234 / 4321). */
export function newPin(digits = 4) {
  for (;;) {
    const pin = String(randomInt(0, 10 ** digits)).padStart(digits, '0');
    const ds = [...pin].map(Number);
    const same = ds.every((d) => d === ds[0]);
    const run = ds.every((d, i) => i === 0 || d - ds[i - 1] === 1) || ds.every((d, i) => i === 0 || ds[i - 1] - d === 1);
    if (!same && !run) return pin;
  }
}

const lockVenue = (c, venueId) => c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`lockers:${venueId}`]);

/** The time a reservation's confirmed bookings at one venue cover, padded. Null when none are left. */
async function windowOf(c, reservationId, venueId) {
  const w = (await c.query(
    `SELECT min(b.starts_at) AS s, max(b.ends_at) AS e FROM bookings b JOIN resources r ON r.id=b.resource_id
      WHERE b.reservation_id=$1 AND r.venue_id=$2 AND b.status='confirmed'`, [reservationId, venueId])).rows[0];
  return w?.s ? { starts: new Date(w.s.getTime() - LOCKER_PAD_MS), ends: new Date(w.e.getTime() + LOCKER_PAD_MS) } : null;
}

/** The first active locker with nothing assigned over [starts, ends). Natural order of zone then label. */
async function freeLocker(c, venueId, { starts, ends }, { lockerId = null, size = null, exceptAssignment = null, exceptLocker = null } = {}) {
  return (await c.query(
    `SELECT l.* FROM venue_lockers l
      WHERE l.venue_id=$1 AND l.active AND ($4::uuid IS NULL OR l.id=$4) AND ($5::text IS NULL OR l.size=$5) AND ($7::uuid IS NULL OR l.id<>$7)
        AND NOT EXISTS (SELECT 1 FROM locker_assignments a WHERE a.locker_id=l.id AND a.status='active' AND a.starts_at < $3 AND a.ends_at > $2 AND ($6::uuid IS NULL OR a.id<>$6))
      ORDER BY l.zone NULLS LAST, length(l.label), l.label LIMIT 1`,
    [venueId, starts, ends, lockerId, size, exceptAssignment, exceptLocker])).rows[0];
}

/**
 * Give a reservation a locker and PIN at one venue. `lockerId` picks a particular one, otherwise the first free (of `size`, if asked).
 * Throws 409 when there is none free for the time or the reservation already has one there.
 */
export async function assignLocker(c, { reservationId, venueId, lockerId = null, size = null, digits = 4, by = null, tell = true }) {
  await lockVenue(c, venueId);
  const rs = (await c.query("SELECT id, user_id, code, status FROM reservations WHERE id=$1 FOR UPDATE", [reservationId])).rows[0];
  if (!rs || rs.status === 'cancelled') throw badRequest('That reservation is not active');
  if ((await c.query("SELECT 1 FROM locker_assignments WHERE reservation_id=$1 AND venue_id=$2 AND status='active'", [reservationId, venueId])).rowCount)
    throw conflict('This booking already has a locker here — release it first, or give it a new PIN');
  const win = await windowOf(c, reservationId, venueId);
  if (!win) throw badRequest('This reservation has no confirmed booking at that venue');
  const locker = await freeLocker(c, venueId, win, { lockerId, size });
  if (!locker) throw conflict(lockerId ? 'That locker is taken or out of service for those times' : 'No locker is free for those times');
  const a = (await c.query(
    `INSERT INTO locker_assignments(locker_id, venue_id, reservation_id, user_id, pin_enc, starts_at, ends_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, locker_id, reservation_id, starts_at, ends_at, pin_version`,
    [locker.id, venueId, reservationId, rs.user_id, sealPin(newPin(digits)), win.starts, win.ends, by])).rows[0];
  if (tell) await notify(c, rs.user_id, { kind: 'locker_assigned', title: `Locker ${locker.label} is ready`, body: `A locker is held for your booking ${rs.code}. Open the booking to see your PIN.`, data: { reservation_id: reservationId, venue_id: venueId } });
  return { ...a, label: locker.label, zone: locker.zone };
}

/** Auto-assign for a freshly made booking, never failing the booking: no free locker simply means none is given. */
export async function autoAssignLockers(c, reservationId, venueIds) {
  const out = [];
  for (const venueId of venueIds) {
    if (!(await c.query('SELECT 1 FROM venues WHERE id=$1 AND locker_auto_assign', [venueId])).rowCount) continue;
    await c.query('SAVEPOINT locker_auto');
    try { out.push(await assignLocker(c, { reservationId, venueId })); await c.query('RELEASE SAVEPOINT locker_auto'); }
    catch { await c.query('ROLLBACK TO SAVEPOINT locker_auto'); }
  }
  return out;
}

/** A new PIN for an existing assignment (the old one stops being shown). */
export async function renewPin(c, assignmentId, { digits = 4 } = {}) {
  return (await c.query("UPDATE locker_assignments SET pin_enc=$2, pin_version=pin_version+1, shared_at=NULL WHERE id=$1 AND status='active' RETURNING id, reservation_id, user_id, pin_version", [assignmentId, sealPin(newPin(digits))])).rows[0];
}

export async function releaseAssignment(c, assignmentId, by, why) {
  const a = (await c.query("UPDATE locker_assignments SET status='released', released_at=now(), released_by=$2 WHERE id=$1 AND status='active' RETURNING *", [assignmentId, by])).rows[0];
  if (a) await revokeGrantsForSource(c, 'locker_assignment', a.id, 'locker_released');
  if (a && why) await notify(c, a.user_id, { kind: 'locker_released', title: 'Your locker was released', body: why, data: { reservation_id: a.reservation_id, venue_id: a.venue_id } });
  return a;
}

/**
 * After a booking is moved, extended or cancelled: lockers follow the booking. The same locker keeps its PIN when it is still
 * free for the new time; otherwise the booking gets another free locker with a new PIN, or — with nothing free, or nothing
 * left of the booking — the locker is released and the person told.
 */
export async function refitLockers(c, reservationId) {
  await revokeStaleBookingGrants(c, reservationId);   // gate / smart-lock grants follow the booking, not a copied list
  const { rows } = await c.query("SELECT * FROM locker_assignments WHERE reservation_id=$1 AND status='active' FOR UPDATE", [reservationId]);
  for (const a of rows) {
    await lockVenue(c, a.venue_id);
    const win = await windowOf(c, reservationId, a.venue_id);
    if (!win) { await releaseAssignment(c, a.id, null, 'The booking it was held for no longer has any time, so the locker was released.'); continue; }
    if (+win.starts === +a.starts_at && +win.ends === +a.ends_at) continue;
    const same = await freeLocker(c, a.venue_id, win, { lockerId: a.locker_id, exceptAssignment: a.id });
    if (same) { await c.query('UPDATE locker_assignments SET starts_at=$2, ends_at=$3 WHERE id=$1', [a.id, win.starts, win.ends]); continue; }
    const other = await freeLocker(c, a.venue_id, win, { exceptAssignment: a.id, exceptLocker: a.locker_id });
    if (other) {
      await c.query('UPDATE locker_assignments SET locker_id=$2, starts_at=$3, ends_at=$4, pin_enc=$5, pin_version=pin_version+1, shared_at=NULL WHERE id=$1', [a.id, other.id, win.starts, win.ends, sealPin(newPin(openPin(a.pin_enc).length))]);
      await notify(c, a.user_id, { kind: 'locker_changed', title: `Your locker is now ${other.label}`, body: 'Your booking changed, so your locker and PIN changed too. Open the booking to see the new PIN.', data: { reservation_id: reservationId, venue_id: a.venue_id } });
    } else await releaseAssignment(c, a.id, null, 'Your booking changed and no locker is free for the new time. Ask the venue for one.');
  }
}

/** The lockers of a reservation for the booking details. PINs only when `reveal` (booker or venue team). */
export async function lockersForReservation(c, reservationId, { reveal = false } = {}) {
  const { rows } = await c.query(
    `SELECT a.id, a.venue_id, a.starts_at, a.ends_at, a.pin_enc, a.pin_version, a.shared_at, l.label, l.zone, l.size, v.name AS venue_name
       FROM locker_assignments a JOIN venue_lockers l ON l.id=a.locker_id JOIN venues v ON v.id=a.venue_id
      WHERE a.reservation_id=$1 AND a.status='active' ORDER BY a.starts_at, l.label`, [reservationId]);
  return rows.map(({ pin_enc, ...a }) => ({ ...a, has_pin: true, pin: reveal ? openPin(pin_enc) : null }));
}
