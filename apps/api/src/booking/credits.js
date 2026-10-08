// Wallet credit applied to invoices, and giving it back when the invoice shrinks, is voided, or is refunded.
import { walletCredit } from '../wallet.js';
import { restorePoints } from './loyalty.js';
import { restoreSessions } from './plans.js';
import { conflict, forbidden, notFound } from '../errors.js';

/** Lock an open invoice that `user` may pay, with what is still due. Refuses while a card checkout for it is in progress (no double payment). */
export async function lockPayableInvoice(c, user, invoiceId) {
  const inv = (await c.query("SELECT * FROM invoices WHERE id=$1 AND kind='invoice' FOR UPDATE", [invoiceId])).rows[0];
  if (!inv) throw notFound('Invoice');
  if (inv.user_id !== user.id) throw forbidden('This is not your invoice');
  if (inv.status !== 'open') throw conflict('That invoice is not open');
  const due = inv.total_cents - inv.credits_cents;
  if (due <= 0) throw conflict('Nothing left to pay');
  if ((await c.query("SELECT 1 FROM payments WHERE purpose_type='venue_invoice' AND purpose_id=$1 AND status='pending' AND provider_ref IS NOT NULL AND created_at > now() - interval '30 minutes'", [invoiceId])).rowCount)
    throw conflict('A card checkout for this invoice is in progress — finish it, or try again in half an hour');
  return { inv, due };
}

/**
 * Give up to `amount` of wallet credit back to the wallet, newest application first.
 * `adjustInvoice`: the invoice is still open, so also lower its applied credit (amount due goes back up).
 * Returns how much went back.
 */
export async function returnCredits(c, invoiceIds, amount, { note, adjustInvoice = false } = {}) {
  let left = amount, returned = 0;
  const { rows } = await c.query(
    `SELECT ic.*, i.currency, i.venue_id FROM invoice_credits ic JOIN invoices i ON i.id=ic.invoice_id
      WHERE ic.invoice_id = ANY($1::uuid[]) AND ic.returned_cents < ic.amount_cents ORDER BY ic.created_at DESC, ic.id FOR UPDATE OF ic`, [invoiceIds]);
  for (const r of rows) {
    if (left <= 0) break;
    const give = Math.min(left, r.amount_cents - r.returned_cents);
    await c.query('UPDATE invoice_credits SET returned_cents = returned_cents + $2 WHERE id=$1', [r.id, give]);
    if (adjustInvoice) await c.query('UPDATE invoices SET credits_cents = credits_cents - $2 WHERE id=$1', [r.invoice_id, give]);
    if (r.source === 'points') await restorePoints(c, { userId: r.user_id, venueId: r.venue_id, invoiceId: r.invoice_id, points: give, note });
    else if (r.source === 'pass') await restoreSessions(c, r, give);
    else await walletCredit(c, r.user_id, r.currency, give, { kind: 'refund', refType: 'invoice', refId: r.invoice_id, note });
    left -= give; returned += give;
  }
  return returned;
}
