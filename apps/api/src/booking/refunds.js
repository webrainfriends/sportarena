// Pays credit notes back. Online payments are refunded through the provider (partial refunds, idempotent per credit note);
// anything paid at the venue is returned by the venue and marked done by staff.
import { query, many, one, tx } from '../db.js';
import { refundPartial } from '../payments/service.js';
import { notify } from '../notify.js';
import { toMajor } from '../currency.js';

const MAX_ATTEMPTS = 6;

/** Try every pending credit-note refund. Safe to call often and from several instances. */
export async function processRefunds({ limit = 20 } = {}) {
  const todo = await many("SELECT * FROM invoices WHERE kind='credit_note' AND refund_status='pending' AND refund_attempts < $2 ORDER BY issued_at LIMIT $1", [limit, MAX_ATTEMPTS]);
  const out = { done: 0, failed: 0, manual: 0 };
  for (const cn of todo) {
    const claimed = await one("UPDATE invoices SET refund_attempts=refund_attempts+1 WHERE id=$1 AND refund_status='pending' AND refund_attempts=$2 RETURNING id", [cn.id, cn.refund_attempts]);
    if (!claimed) continue;
    try {
      const pays = await many(
        `SELECT p.* FROM payments p JOIN invoices i ON i.id=p.purpose_id AND p.purpose_type='venue_invoice'
          WHERE i.reservation_id=$1 AND i.venue_id=$2 AND i.kind='invoice' AND p.status IN ('paid','refunded') ORDER BY p.paid_at DESC`, [cn.reservation_id, cn.venue_id]);
      let left = cn.total_cents;
      for (const p of pays) { if (left <= 0) break; left -= await refundPartial(p, left, `cn-${cn.id}-${p.id}`); }
      // anything the card could not take back (cash part of a mixed payment) is returned by the venue
      const status = left > 0 ? 'manual' : 'done';
      await tx(async (c) => {
        await c.query("UPDATE invoices SET refund_status=$2, refunded_at=CASE WHEN $2='done' THEN now() END, refund_error=$3 WHERE id=$1", [cn.id, status, left > 0 ? `${toMajor(left, cn.currency)} ${cn.currency} to be returned by the venue` : null]);
        if (status === 'done') await c.query("UPDATE bookings b SET payment_status='refunded' FROM resources r WHERE r.id=b.resource_id AND r.venue_id=$2 AND b.reservation_id=$1 AND b.payment_status='refund_due'", [cn.reservation_id, cn.venue_id]);
        await notify(c, cn.user_id, { kind: 'refund_issued', title: `Refund ${status === 'done' ? 'sent' : 'approved'} · ${cn.number}`, body: `${cn.currency} ${toMajor(cn.total_cents - Math.max(0, left), cn.currency)} is on its way back to you${left > 0 ? `; the venue will return the other ${toMajor(left, cn.currency)}` : ''}.`, data: { invoice_id: cn.id, reservation_id: cn.reservation_id } });
      });
      out[status === 'done' ? 'done' : 'manual']++;
    } catch (e) {
      out.failed++;
      await query("UPDATE invoices SET refund_error=$2, refund_status=CASE WHEN refund_attempts >= $3 THEN 'failed' ELSE 'pending' END WHERE id=$1", [cn.id, String(e.message).slice(0, 300), MAX_ATTEMPTS]);
    }
  }
  return out;
}

/** Fire-and-forget right after a cancellation commits, so customers see their refund without waiting for the worker. */
export const kickRefunds = () => { setImmediate(() => processRefunds().catch((e) => console.error('[refunds]', e.message))); };
