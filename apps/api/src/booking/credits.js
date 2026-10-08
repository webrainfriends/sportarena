// Wallet credit applied to invoices, and giving it back when the invoice shrinks, is voided, or is refunded.
import { walletCredit } from '../wallet.js';

/**
 * Give up to `amount` of wallet credit back to the wallet, newest application first.
 * `adjustInvoice`: the invoice is still open, so also lower its applied credit (amount due goes back up).
 * Returns how much went back.
 */
export async function returnCredits(c, invoiceIds, amount, { note, adjustInvoice = false } = {}) {
  let left = amount, returned = 0;
  const { rows } = await c.query(
    `SELECT ic.*, i.currency FROM invoice_credits ic JOIN invoices i ON i.id=ic.invoice_id
      WHERE ic.invoice_id = ANY($1::uuid[]) AND ic.returned_cents < ic.amount_cents ORDER BY ic.created_at DESC, ic.id FOR UPDATE OF ic`, [invoiceIds]);
  for (const r of rows) {
    if (left <= 0) break;
    const give = Math.min(left, r.amount_cents - r.returned_cents);
    await c.query('UPDATE invoice_credits SET returned_cents = returned_cents + $2 WHERE id=$1', [r.id, give]);
    if (adjustInvoice) await c.query('UPDATE invoices SET credits_cents = credits_cents - $2 WHERE id=$1', [r.invoice_id, give]);
    await walletCredit(c, r.user_id, r.currency, give, { kind: 'refund', refType: 'invoice', refId: r.invoice_id, note });
    left -= give; returned += give;
  }
  return returned;
}
