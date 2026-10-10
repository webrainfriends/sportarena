// Numbered invoices and credit notes, one set per venue per reservation, always in the venue's currency.
// `reconcileInvoices` is the single place that decides what a customer owes a venue: it compares what the bookings
// should cost now with what has already been paid, then keeps one open invoice for any shortfall or issues a credit
// note for any excess. Called after every change to a reservation, inside the same transaction.
import { encrypt, decrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { toMajor } from '../currency.js';
import { returnCredits } from './credits.js';
import { earnForInvoice, clawBackPoints } from './loyalty.js';

const ACTIVE = new Set(['confirmed', 'no_show']);
const taxIn = (total, rate) => Math.round((total * rate) / (10000 + rate)); // payable always contains its tax

async function nextNumber(c, venue, kind) {
  let prefix = venue.invoice_prefix;
  if (!prefix) {
    // 3 letters of the name + a slice of the venue id; the prefix is unique, so on a clash take a longer slice of the id
    const base = venue.name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3).padEnd(3, 'X');
    const hex = venue.id.replace(/-/g, '').toUpperCase();
    for (let len = 3; len <= 5; len++) {
      await c.query('SAVEPOINT invoice_prefix');
      try {
        await c.query('UPDATE venues SET invoice_prefix=$2 WHERE id=$1 AND invoice_prefix IS NULL', [venue.id, `${base}${hex.slice(0, len)}`]);
        await c.query('RELEASE SAVEPOINT invoice_prefix');
        break;
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT invoice_prefix');
        if (e.code !== '23505' || len === 5) throw e;
      }
    }
    prefix = (await c.query('SELECT invoice_prefix FROM venues WHERE id=$1', [venue.id])).rows[0].invoice_prefix;
  }
  const { seq } = (await c.query(
    `INSERT INTO invoice_counters(venue_id, kind, seq) VALUES ($1,$2,1) ON CONFLICT (venue_id, kind) DO UPDATE SET seq = invoice_counters.seq + 1 RETURNING seq`, [venue.id, kind])).rows[0];
  const year = new Date().getUTCFullYear();
  return `${kind === 'credit_note' ? 'CN-' : ''}${prefix}-${year}-${String(seq).padStart(6, '0')}`;
}

const seller = (v) => ({ name: v.legal_name ?? v.name, tax_id: v.tax_id ?? null, address: v.billing_address ?? [v.address, v.city, v.postal_code, v.country].filter(Boolean).join(', '), phone: v.phone ?? null, email: v.email ?? null });

async function buyerBlob(c, rs) {
  const u = (await c.query('SELECT display_name FROM users WHERE id=$1', [rs.user_id])).rows[0];
  let b = {};
  if (rs.billing_enc) { try { b = JSON.parse(decrypt(rs.billing_enc, 'reservations.billing')); } catch { b = {}; } }
  return encrypt(JSON.stringify({ name: b.name ?? u.display_name, address: b.address ?? null, tax_id: b.tax_id ?? null }), 'invoices.buyer');
}

/** What a customer owes for one booking line right now: the payable amount, or just the retained fee once cancelled. */
export function chargeOf(b) {
  if (ACTIVE.has(b.status)) return { amount: b.payable_cents, tax: b.tax_cents, kind: 'booking' };
  if (b.status === 'cancelled') {
    const fee = Math.max(0, b.payable_cents - b.refund_cents);
    return { amount: fee, tax: b.payable_cents ? Math.round((b.tax_cents * fee) / b.payable_cents) : 0, kind: 'fee' };
  }
  return { amount: 0, tax: 0, kind: 'none' };
}

export async function reconcileInvoices(c, reservationId) {
  const rs = (await c.query('SELECT * FROM reservations WHERE id=$1', [reservationId])).rows[0];
  const { rows: bookings } = await c.query(
    `SELECT b.*, r.name AS resource_name, r.venue_id FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE b.reservation_id=$1 ORDER BY b.starts_at, b.id`, [reservationId]);
  for (const venueId of [...new Set(bookings.map((b) => b.venue_id))]) {
    const venue = (await c.query('SELECT * FROM venues WHERE id=$1 FOR UPDATE', [venueId])).rows[0];
    const mine = bookings.filter((b) => b.venue_id === venueId);
    const lines = mine.map((b) => ({ b, ...chargeOf(b) })).filter((l) => l.amount > 0);
    const target = lines.reduce((s, l) => s + l.amount, 0);
    const docs = (await c.query('SELECT * FROM invoices WHERE reservation_id=$1 AND venue_id=$2 ORDER BY issued_at, number', [reservationId, venueId])).rows;
    const paid = docs.filter((d) => d.kind === 'invoice' && d.status === 'paid');
    const credits = docs.filter((d) => d.kind === 'credit_note' && d.status !== 'void');
    const open = docs.find((d) => d.kind === 'invoice' && d.status === 'open');
    const netPaid = paid.reduce((s, d) => s + d.total_cents, 0) - credits.reduce((s, d) => s + d.total_cents, 0);
    const delta = target - netPaid;
    const money = { currency: venue.currency, tax_name: venue.tax_name, tax_rate_bp: venue.tax_rate_bp, tax_inclusive: venue.tax_inclusive };

    if (delta > 0) {
      let docLines, tax;
      if (!paid.length) {
        docLines = lines.map(({ b, amount, tax: t, kind }) => ({ description: `${kind === 'fee' ? 'Cancellation fee · ' : ''}${b.resource_name}${b.quantity > 1 ? ` × ${b.quantity}` : ''}`, starts_at: b.starts_at, ends_at: b.ends_at, slots: b.slots, amount_cents: amount, tax_cents: t, discount_cents: kind === 'fee' ? 0 : b.discount_cents, booking_id: b.id }));
        tax = lines.reduce((s, l) => s + l.tax, 0);
      } else {
        docLines = [{ description: `Changes to booking ${rs.code}`, amount_cents: delta, tax_cents: taxIn(delta, venue.tax_rate_bp) }];
        tax = taxIn(delta, venue.tax_rate_bp);
      }
      if (open) {
        const changed = open.total_cents !== delta || open.lines.length !== docLines.length;
        // the invoice got smaller than the wallet credit already put on it: give the excess back
        if (open.credits_cents > delta) await returnCredits(c, [open.id], open.credits_cents - delta, { adjustInvoice: true, note: `Booking ${rs.code} changed` });
        await c.query(`UPDATE invoices SET lines=$2, total_cents=$3, tax_cents=$4, revision=revision+$9, tax_name=$5, tax_rate_bp=$6, tax_inclusive=$7, seller=$8 WHERE id=$1`,
          [open.id, JSON.stringify(docLines), delta, tax, money.tax_name, money.tax_rate_bp, money.tax_inclusive, seller(venue), changed ? 1 : 0]);
        // wallet credit now covers all of it: it is paid
        if ((await c.query('SELECT credits_cents FROM invoices WHERE id=$1', [open.id])).rows[0].credits_cents >= delta) await markInvoicePaid(c, open.id, { method: 'wallet', by: rs.user_id });
      } else {
        await c.query(
          `INSERT INTO invoices(kind, number, venue_id, reservation_id, user_id, currency, total_cents, tax_cents, tax_name, tax_rate_bp, tax_inclusive, seller, buyer_enc, lines)
           VALUES ('invoice',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [await nextNumber(c, venue, 'invoice'), venueId, reservationId, rs.user_id, money.currency, delta, tax, money.tax_name, money.tax_rate_bp, money.tax_inclusive, seller(venue), await buyerBlob(c, rs), JSON.stringify(docLines)]);
      }
      await c.query("UPDATE bookings b SET payment_status='unpaid' FROM resources r WHERE r.id=b.resource_id AND r.venue_id=$2 AND b.reservation_id=$1 AND b.status IN ('confirmed','no_show') AND b.payment_status IN ('paid','unpaid')", [reservationId, venueId]);
      continue;
    }
    if (open) {
      if (open.credits_cents > 0) await returnCredits(c, [open.id], open.credits_cents, { adjustInvoice: true, note: `Booking ${rs.code} cancelled` });
      await c.query("UPDATE invoices SET status='void', voided_at=now() WHERE id=$1", [open.id]);
    }
    if (delta < 0) {
      const credit = -delta;
      await clawBackPoints(c, paid.map((d) => d.id), credit); // the points that money earned go back too
      // wallet-funded money goes straight back to the wallet; only the rest needs the card provider or the venue
      const toWallet = await returnCredits(c, paid.map((d) => d.id), credit, { note: `Refund for booking ${rs.code}` });
      const rest = credit - toWallet;
      const online = rest > 0 && (await c.query("SELECT 1 FROM payments WHERE purpose_type='venue_invoice' AND purpose_id = ANY($1::uuid[]) AND status IN ('paid','refunded')", [paid.map((d) => d.id)])).rowCount > 0;
      await c.query(
        `INSERT INTO invoices(kind, number, venue_id, reservation_id, user_id, parent_id, currency, status, total_cents, tax_cents, tax_name, tax_rate_bp, tax_inclusive, seller, buyer_enc, lines, paid_at, refund_status, refund_to_credits_cents, refunded_at)
         VALUES ('credit_note',$1,$2,$3,$4,$5,$6,'paid',$7,$8,$9,$10,$11,$12,$13,$14, now(), $15, $16, CASE WHEN $15 = 'done' THEN now() END)`,
        [await nextNumber(c, venue, 'credit_note'), venueId, reservationId, rs.user_id, paid[paid.length - 1]?.id ?? null, money.currency, credit, taxIn(credit, venue.tax_rate_bp), money.tax_name, money.tax_rate_bp, money.tax_inclusive,
          seller(venue), await buyerBlob(c, rs), JSON.stringify([{ description: `Credit for changed or cancelled bookings (${rs.code})`, amount_cents: credit, tax_cents: taxIn(credit, venue.tax_rate_bp) }]), rest === 0 ? 'done' : online ? 'pending' : 'manual', toWallet]);
      if (online) c.afterCommit?.(() => import('./refunds.js').then((m) => m.kickRefunds()));
      await c.query("UPDATE bookings b SET payment_status=$3 FROM resources r WHERE r.id=b.resource_id AND r.venue_id=$2 AND b.reservation_id=$1 AND b.status='cancelled' AND b.refund_cents > 0 AND b.payment_status IN ('paid','unpaid')", [reservationId, venueId, rest === 0 ? 'refunded' : 'refund_due']);
    }
    if (paid.length && target > 0) await c.query("UPDATE bookings b SET payment_status='paid' FROM resources r WHERE r.id=b.resource_id AND r.venue_id=$2 AND b.reservation_id=$1 AND b.status IN ('confirmed','no_show')", [reservationId, venueId]);
  }
  const unpaidOpen = (await c.query("SELECT 1 FROM invoices WHERE reservation_id=$1 AND kind='invoice' AND status='open'", [reservationId])).rowCount;
  if (!unpaidOpen) await c.query('UPDATE reservations SET payment_deadline=NULL WHERE id=$1 AND payment_deadline IS NOT NULL', [reservationId]);
}

/** Record that an open invoice has been paid (online by a provider, or at the venue). Idempotent: returns false if it can't be paid any more. */
export async function markInvoicePaid(c, invoiceId, { method, by } = {}) {
  const inv = (await c.query("SELECT * FROM invoices WHERE id=$1 AND kind='invoice' FOR UPDATE", [invoiceId])).rows[0];
  if (!inv || inv.status !== 'open') return false;
  await c.query("UPDATE invoices SET status='paid', paid_at=now(), payment_method=$2 WHERE id=$1", [invoiceId, method ?? 'other']);
  await c.query("UPDATE bookings b SET payment_status='paid' FROM resources r WHERE r.id=b.resource_id AND r.venue_id=$2 AND b.reservation_id=$1 AND b.status IN ('confirmed','no_show')", [inv.reservation_id, inv.venue_id]);
  const stillOpen = (await c.query("SELECT 1 FROM invoices WHERE reservation_id=$1 AND kind='invoice' AND status='open'", [inv.reservation_id])).rowCount;
  if (!stillOpen) await c.query('UPDATE reservations SET payment_deadline=NULL WHERE id=$1', [inv.reservation_id]);
  await earnForInvoice(c, inv);
  await notify(c, inv.user_id, { kind: 'invoice_paid', title: `Payment received · ${inv.number}`, body: `${inv.currency} ${toMajor(inv.total_cents, inv.currency)} paid${by ? ` (${method ?? 'at the venue'})` : ' online'}. Your receipt is in the booking.`, data: { invoice_id: inv.id, reservation_id: inv.reservation_id, venue_id: inv.venue_id } });
  return true;
}

export const buyerOf = (inv) => { try { return JSON.parse(decrypt(inv.buyer_enc, 'invoices.buyer')); } catch { return null; } };
export const encryptBilling = (b) => encrypt(JSON.stringify(b), 'reservations.billing');
