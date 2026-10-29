// Pays credit notes back. Online payments are refunded through the provider (partial refunds, idempotent per credit note);
// anything paid at the venue is returned by the venue and marked done by staff.
//
// Crash safety (never move money twice):
//   1. the credit note is claimed with a lease (a crashed run is retried once the lease runs out);
//   2. before calling the provider, a refund_intents row records the exact amount and idempotency key;
//   3. the provider call uses that same key, so repeating it is a no-op at Stripe/PayPal;
//   4. the intent is flipped to 'recorded' and payments.refunded_cents increased in ONE transaction.
// A retry after any crash reuses the stored amount and key, so the customer is refunded exactly once.
import { recordRefund } from '../finance.js';
import { query, many, one, tx } from '../db.js';
import { provider } from '../payments/providers.js';
import { AppError } from '../errors.js';
import { notify } from '../notify.js';
import { toMajor } from '../currency.js';
import { backoffMs, recordDead, requeueHooks } from '../jobs.js';

const MAX_ATTEMPTS = 6;

/** Refund up to `wanted` of one payment for a credit note. Returns the amount that is (now) refunded for this pair. */
export async function refundWithIntent(cn, p, wanted) {
  let intent = await one('SELECT * FROM refund_intents WHERE invoice_id=$1 AND payment_id=$2', [cn.id, p.id]);
  if (intent?.status === 'recorded') return Number(intent.amount_cents);
  if (!intent) {
    const give = Math.min(wanted, Number(p.amount_cents) - Number(p.refunded_cents ?? 0));
    if (give <= 0) return 0;
    if (!p.provider_payment_ref) throw new AppError(409, 'refund_unavailable', 'No provider reference to refund');
    await query('INSERT INTO refund_intents(invoice_id, payment_id, amount_cents, idempotency_key) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [cn.id, p.id, give, `cn-${cn.id}-${p.id}`]);
    intent = await one('SELECT * FROM refund_intents WHERE invoice_id=$1 AND payment_id=$2', [cn.id, p.id]);
  }
  const amount = Number(intent.amount_cents);
  await provider(p.provider).refund(p.provider_payment_ref, p.id, { amount, currency: p.currency, key: intent.idempotency_key });
  await tx(async (c) => {
    const rec = await c.query("UPDATE refund_intents SET status='recorded', recorded_at=now() WHERE invoice_id=$1 AND payment_id=$2 AND status='intent' RETURNING amount_cents", [cn.id, p.id]);
    if (!rec.rowCount) return; // another run already recorded it
    await c.query("UPDATE payments SET refunded_cents = refunded_cents + $2, status = CASE WHEN refunded_cents + $2 >= amount_cents THEN 'refunded' ELSE status END, refunded_at = CASE WHEN refunded_cents + $2 >= amount_cents THEN now() ELSE refunded_at END WHERE id=$1", [p.id, amount]);
    await recordRefund(c, (await c.query('SELECT * FROM payments WHERE id=$1', [p.id])).rows[0]);
  });
  return amount;
}

/** Try every pending credit-note refund. Safe to call often and from several instances. */
export async function processRefunds({ limit = 20 } = {}) {
  // a run that crashed on its last attempt leaves the credit note pending with no attempts left: dead-letter it for an admin
  const stuck = await many("UPDATE invoices SET refund_status='failed', refund_error=coalesce(refund_error,'attempts exhausted after a crash'), refund_claimed_at=NULL WHERE kind='credit_note' AND refund_status='pending' AND refund_attempts >= $1 AND (refund_claimed_at IS NULL OR refund_claimed_at < now() - interval '5 minutes') RETURNING id, refund_error, refund_attempts", [MAX_ATTEMPTS]);
  for (const s of stuck) await recordDead(null, { category: 'refunds', kind: 'refund.credit_note', dedupeKey: s.id, payload: { invoice_id: s.id }, error: s.refund_error, attempts: s.refund_attempts });
  const todo = await many("SELECT * FROM invoices WHERE kind='credit_note' AND refund_status='pending' AND refund_attempts < $2 AND (refund_next_attempt_at IS NULL OR refund_next_attempt_at <= now()) ORDER BY issued_at LIMIT $1", [limit, MAX_ATTEMPTS]);
  const out = { done: 0, failed: 0, manual: 0 };
  for (const cn of todo) {
    // exclusive lease: a second caller sees the claim and skips (a crashed run is retried after the lease runs out)
    const claimed = await one("UPDATE invoices SET refund_attempts=refund_attempts+1, refund_claimed_at=now() WHERE id=$1 AND refund_status='pending' AND (refund_claimed_at IS NULL OR refund_claimed_at < now() - interval '5 minutes') RETURNING id, refund_attempts", [cn.id]);
    if (!claimed) continue;
    try {
      // the card payments that funded this credit note's invoice: the booking's own invoice payments, or - for a front-desk sale - the sale's online payment
      const pays = cn.pos_sale_id && !cn.reservation_id
        ? await many("SELECT p.* FROM payments p WHERE p.purpose_type='pos_sale' AND p.purpose_id=$1 AND p.status IN ('paid','refunded') ORDER BY p.paid_at DESC", [cn.pos_sale_id])
        : await many(
          `SELECT p.* FROM payments p JOIN invoices i ON i.id=p.purpose_id AND p.purpose_type='venue_invoice'
            WHERE i.reservation_id=$1 AND i.venue_id=$2 AND i.kind='invoice' AND p.status IN ('paid','refunded')
          UNION ALL
          SELECT p.* FROM payments p JOIN pos_sale_invoices psi ON psi.sale_id=p.purpose_id AND p.purpose_type='pos_sale' JOIN invoices i ON i.id=psi.invoice_id
            WHERE i.reservation_id=$1 AND i.venue_id=$2 AND i.kind='invoice' AND p.status IN ('paid','refunded')
          ORDER BY paid_at DESC`, [cn.reservation_id, cn.venue_id]);
      let left = cn.total_cents - cn.refund_to_credits_cents; // the wallet-funded part was already returned
      for (const p of pays) { if (left <= 0) break; left -= await refundWithIntent(cn, p, left); }
      // anything the card could not take back (cash part of a mixed payment) is returned by the venue
      const status = left > 0 ? 'manual' : 'done';
      await tx(async (c) => {
        // only a refund that is still ours may be finished: never overwrite 'done'
        const fin = await c.query("UPDATE invoices SET refund_status=$2, refunded_at=CASE WHEN $2='done' THEN now() END, refund_error=$3, refund_claimed_at=NULL, refund_next_attempt_at=NULL WHERE id=$1 AND refund_status='pending' RETURNING id", [cn.id, status, left > 0 ? `${toMajor(left, cn.currency)} ${cn.currency} to be returned by the venue` : null]);
        if (!fin.rowCount) return;
        if (status === 'done') await c.query("UPDATE bookings b SET payment_status='refunded' FROM resources r WHERE r.id=b.resource_id AND r.venue_id=$2 AND b.reservation_id=$1 AND b.payment_status='refund_due'", [cn.reservation_id, cn.venue_id]);
        // a notification problem is isolated by notify() (savepoint + retry job): it can never undo the refund bookkeeping
        await notify(c, cn.user_id, { kind: 'refund_issued', title: `Refund ${status === 'done' ? 'sent' : 'approved'} · ${cn.number}`, body: `${cn.currency} ${toMajor(cn.total_cents - Math.max(0, left), cn.currency)} is on its way back to you${left > 0 ? `; the venue will return the other ${toMajor(left, cn.currency)}` : ''}.`, data: { invoice_id: cn.id, reservation_id: cn.reservation_id } });
      });
      out[status === 'done' ? 'done' : 'manual']++;
    } catch (e) {
      out.failed++;
      const msg = String(e.message).slice(0, 300);
      const upd = await query(
        "UPDATE invoices SET refund_error=$2, refund_status=CASE WHEN refund_attempts >= $3 THEN 'failed' ELSE 'pending' END, refund_claimed_at=NULL, refund_next_attempt_at=now() + make_interval(secs => $4::float8) WHERE id=$1 AND refund_status='pending' RETURNING refund_status, refund_attempts",
        [cn.id, msg, MAX_ATTEMPTS, backoffMs(claimed.refund_attempts, { baseMs: 30_000, capMs: 3_600_000 }) / 1000]).catch(() => null);
      if (upd?.rows[0]?.refund_status === 'failed') await recordDead(null, { category: 'refunds', kind: 'refund.credit_note', dedupeKey: cn.id, payload: { invoice_id: cn.id }, error: msg, attempts: upd.rows[0].refund_attempts }).catch(() => {});
    }
  }
  return out;
}

// Admin requeue of a dead-lettered refund: back to 'pending' with a fresh budget. Recorded intents are kept, so money already
// moved is never repeated; an unrecorded intent is replayed with its original amount and idempotency key.
requeueHooks['refund.credit_note'] = async ({ invoice_id }) => {
  await query("UPDATE invoices SET refund_status='pending', refund_attempts=0, refund_claimed_at=NULL, refund_next_attempt_at=NULL WHERE id=$1 AND refund_status='failed'", [invoice_id]);
};

/** Fire-and-forget right after a cancellation commits, so customers see their refund without waiting for the worker. */
export const kickRefunds = () => { setImmediate(() => processRefunds().catch((e) => console.error('[refunds]', e.message))); };
