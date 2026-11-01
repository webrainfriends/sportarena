// Applying a booking change or cancellation to the trip (#704), whether a person asked for it or the partner did. Nothing is deleted: the booking,
// its linked leg / stay and the trip history keep the previous values, and only the people on the booking (and their guardians) are told.
import { many, tx, one } from '../db.js';
import { audienceOf, localText, record } from '../trips.js';

const SEG_LIVE = "status NOT IN ('completed')";

/** Apply one change inside a transaction. patch: { starts_at?, ends_at?, price_minor?, note? }. */
export async function applyChange(c, trip, booking, { actor = 'partner', actorId = null, action, patch = {}, note = null }) {
  if (booking.status === 'cancelled') return booking;                         // already final: a late or repeated callback changes nothing
  const next = { starts_at: patch.starts_at ?? booking.starts_at, ends_at: patch.ends_at ?? booking.ends_at, price_minor: patch.price_minor ?? Number(booking.price_minor) };
  if (action === 'changed' && (Date.parse(next.ends_at) <= Date.parse(next.starts_at))) return booking;
  const status = action === 'cancelled' ? 'cancelled' : 'changed';
  const b = (await c.query('UPDATE travel_bookings SET status=$2, starts_at=$3, ends_at=$4, price_minor=$5, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *', [booking.id, status, next.starts_at, next.ends_at, next.price_minor])).rows[0];
  await c.query('INSERT INTO travel_booking_events(booking_id, actor, actor_id, action, detail) VALUES ($1,$2,$3,$4,$5)',
    [booking.id, actor, actorId, action, { before: { starts_at: booking.starts_at, ends_at: booking.ends_at, price_minor: Number(booking.price_minor), status: booking.status }, after: { starts_at: b.starts_at, ends_at: b.ends_at, price_minor: Number(b.price_minor), status: b.status }, note }]);
  if (b.segment_id) {
    if (action === 'cancelled') await c.query(`UPDATE trip_segments SET status='cancelled', row_version=row_version+1, updated_at=now() WHERE id=$1 AND ${SEG_LIVE}`, [b.segment_id]);
    else await c.query(`UPDATE trip_segments SET depart_at=$2, arrive_at=$3, status=CASE WHEN status='cancelled' THEN status ELSE 'delayed' END, row_version=row_version+1, updated_at=now() WHERE id=$1 AND ${SEG_LIVE}`, [b.segment_id, b.starts_at, b.ends_at]);
  }
  if (b.stay_id) {
    if (action === 'cancelled') await c.query("UPDATE trip_stays SET status='cancelled', row_version=row_version+1, updated_at=now() WHERE id=$1 AND status<>'completed'", [b.stay_id]);
    else await c.query("UPDATE trip_stays SET check_in_at=$2, check_out_at=$3, status='changed', row_version=row_version+1, updated_at=now() WHERE id=$1 AND status NOT IN ('completed','cancelled')", [b.stay_id, b.starts_at, b.ends_at]);
  }
  const pax = (await c.query('SELECT participant_id FROM travel_booking_travellers WHERE booking_id=$1', [b.id])).rows.map((r) => r.participant_id);
  await record(c, trip, actorId, { entity: 'travel_booking', entityId: b.id, action, version: b.row_version,
    snapshot: { kind: b.kind, summary: b.summary, starts_at: b.starts_at, ends_at: b.ends_at, price_minor: Number(b.price_minor), currency: b.currency, status: b.status, by: actor }, note,
    affected: await audienceOf(c, trip, pax), title: action === 'cancelled' ? 'A booking was cancelled' : 'A booking changed',
    body: `${trip.name}: ${b.summary}${action === 'changed' ? `, now ${localText(b.starts_at, b.tz)}` : ''}${note ? `. ${note}` : ''}` });
  return b;
}

/** A signed partner callback (booking.changed / booking.cancelled). Unknown bookings are ignored; repeats are harmless. */
export async function applyPartnerEvent(conn, ev) {
  const d = ev.data ?? {};
  await tx(async (c) => {
    const b = (await c.query(`SELECT * FROM travel_bookings WHERE ${conn.channel ? 'channel_partner_id' : 'install_id'}=$1 AND partner_ref=$2 FOR UPDATE`, [conn.id, d.partner_ref])).rows[0];
    if (!b) return;
    const trip = (await c.query('SELECT * FROM trips WHERE id=$1 FOR UPDATE', [b.trip_id])).rows[0];
    const ok = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : undefined);
    await applyChange(c, trip, b, { actor: 'partner', action: ev.kind === 'booking.cancelled' ? 'cancelled' : 'changed',
      patch: { starts_at: ok(d.starts_at), ends_at: ok(d.ends_at), price_minor: Number.isInteger(d.price_minor) && d.price_minor >= 0 ? d.price_minor : undefined }, note: d.note ?? 'Updated by the travel partner' });
  });
}

export const bookingEvents = (id) => many('SELECT actor, action, detail, created_at FROM travel_booking_events WHERE booking_id=$1 ORDER BY created_at', [id]);
export const bookingOne = (id) => one('SELECT * FROM travel_bookings WHERE id=$1', [id]);
