// Venue loyalty now runs on the shared rewards engine (src/rewards). This file keeps the booking module's three touch points:
// a paid invoice earns, a refunded one claws back, and a returned credit restores — each one a thin call into the engine.
import { tx } from '../db.js';
import { venueInvoicePaid } from '../rewards/activity.js';
import { reverseActivity } from '../rewards/activity.js';
import { restoreRedemption } from '../rewards/redeem.js';
import { expireDue, openLot } from '../rewards/ledger.js';

/** A paid invoice earns points under every live programme whose rules match (the venue's own, the organisation's, the platform's). Once per invoice. */
export const earnForInvoice = (c, inv) => venueInvoicePaid(c, inv);

/** What the invoices that earned points are refunded by `credit` (minor units): take back the matching share, as far as it is still unspent. */
export async function clawBackPoints(c, invoiceIds, credit) {
  let left = credit, total = 0;
  const { rows } = await c.query('SELECT id, total_cents FROM invoices WHERE id = ANY($1::uuid[]) ORDER BY issued_at DESC', [invoiceIds]);
  for (const inv of rows) {
    if (left <= 0) break;
    const part = Math.min(left, inv.total_cents);
    total += await reverseActivity(c, { sourceType: 'venue_invoice', sourceId: inv.id, refundedMinor: part, totalMinor: inv.total_cents, reason: 'Refunded booking' });
    left -= part;
  }
  return total;
}

/** A points credit on an invoice was given back (invoice voided / shrunk / refunded): the redemption restores under its programme's policy. */
export async function restoreCredit(c, credit, give) {
  if (credit.redemption_id) return restoreRedemption(c, credit.redemption_id, { upTo: Number(credit.returned_cents) + give, reason: 'Booking changed or cancelled' });
  // a credit applied before the engine existed: it belonged to the venue's carried-over programme
  const p = (await c.query("SELECT p.id, p.funding_owner FROM loyalty_programmes p JOIN invoices i ON p.owner_kind='venue' AND p.owner_id=i.venue_id AND p.slug='main' WHERE i.id=$1", [credit.invoice_id])).rows[0];
  if (!p) return 0;
  const exp = new Date(); exp.setUTCMonth(exp.getUTCMonth() + 12);
  await openLot(c, { programmeId: p.id, userId: credit.user_id, kind: 'restore', points: give, expiresAt: exp, sourceType: 'venue_invoice', sourceId: credit.invoice_id, key: `restore:legacy:${credit.id}:${Number(credit.returned_cents) + give}`, reason: 'Booking changed or cancelled', fundingOwner: p.funding_owner });
  return give;
}

/** Zero out lots past their expiry (worker). Returns the points expired. */
export const expireLoyalty = () => tx((c) => expireDue(c));
