// Venues that require online payment hold a customer's slots for a few minutes. If the invoice is still unpaid when
// the deadline passes, the slots are released (cancelled, nothing charged) and the customer is told.
import { many, tx } from '../db.js';
import { notify } from '../notify.js';
import { cancelBookings, effectivePaymentMode } from './engine.js';

export async function expireUnpaidHolds() {
  const due = await many("SELECT id, user_id, code FROM reservations WHERE status='confirmed' AND payment_deadline IS NOT NULL AND payment_deadline < now() ORDER BY payment_deadline LIMIT 50");
  let released = 0;
  for (const r of due) {
    await tx(async (c) => {
      const rs = (await c.query('SELECT * FROM reservations WHERE id=$1 FOR UPDATE', [r.id])).rows[0];
      if (!rs || rs.status !== 'confirmed' || !rs.payment_deadline || rs.payment_deadline > new Date()) return;
      // venues whose invoice is open and has never been paid, and that still require online payment
      const { rows: stale } = await c.query(
        `SELECT i.venue_id FROM invoices i WHERE i.reservation_id=$1 AND i.kind='invoice' AND i.status='open'
            AND NOT EXISTS (SELECT 1 FROM invoices p WHERE p.reservation_id=i.reservation_id AND p.venue_id=i.venue_id AND p.kind='invoice' AND p.status='paid')`, [r.id]);
      for (const { venue_id } of stale) {
        const v = (await c.query('SELECT * FROM venues WHERE id=$1', [venue_id])).rows[0];
        if (effectivePaymentMode(v) !== 'online_required') continue;
        const ids = (await c.query("SELECT b.id FROM bookings b JOIN resources x ON x.id=b.resource_id WHERE b.reservation_id=$1 AND x.venue_id=$2 AND b.status='confirmed'", [r.id, venue_id])).rows.map((x) => x.id);
        if (!ids.length) continue;
        await cancelBookings(c, ids, { actor: { id: rs.user_id }, byVenue: false, waive: true, silent: true, reason: 'Payment was not completed in time' });
        await notify(c, rs.user_id, { kind: 'booking_expired', title: `Booking ${rs.code} released`, body: `${v.name} needs payment up front and it wasn't completed in time, so those slots were released. Nothing was charged.`, data: { reservation_id: rs.id, venue_id } });
        released += ids.length;
      }
      await c.query('UPDATE reservations SET payment_deadline=NULL WHERE id=$1', [r.id]);
    });
  }
  return released;
}
