// Venue loyalty points. Earned when an invoice is paid (a percentage of what was paid in cash/wallet/card, never of points),
// spent against later invoices at the same venue, restored if that invoice is voided or refunded, clawed back when what earned them
// is refunded, and expired after the venue's expiry period. 1 point = 1 minor unit of the venue's currency.
import { query } from '../db.js';
import { notify } from '../notify.js';
import { toMajor } from '../currency.js';

export const availablePoints = async (c, userId, venueId) => Number((await c.query('SELECT coalesce(sum(remaining),0) AS n FROM loyalty_lots WHERE user_id=$1 AND venue_id=$2 AND remaining > 0 AND expires_at > now()', [userId, venueId])).rows[0].n);

const addLot = (c, { userId, venueId, invoiceId, kind, points, months }) => c.query(
  `INSERT INTO loyalty_lots(user_id, venue_id, invoice_id, kind, points, remaining, expires_at) VALUES ($1,$2,$3,$4,$5,$5, now() + make_interval(months => $6)) RETURNING id`, [userId, venueId, invoiceId ?? null, kind, points, months]);
const event = (c, userId, venueId, delta, kind, invoiceId, note) => c.query('INSERT INTO loyalty_events(user_id, venue_id, delta, kind, invoice_id, note) VALUES ($1,$2,$3,$4,$5,$6)', [userId, venueId, delta, kind, invoiceId ?? null, note ?? null]);

/** A paid invoice earns points (once). Points paid with don't earn points. */
export async function earnForInvoice(c, inv) {
  const venue = (await c.query('SELECT id, name, currency, loyalty_earn_bp, loyalty_expiry_months FROM venues WHERE id=$1', [inv.venue_id])).rows[0];
  if (!venue?.loyalty_earn_bp) return 0;
  const paidWithPoints = Number((await c.query("SELECT coalesce(sum(amount_cents - returned_cents),0) AS n FROM invoice_credits WHERE invoice_id=$1 AND source='points'", [inv.id])).rows[0].n);
  const points = Math.floor(((inv.total_cents - paidWithPoints) * venue.loyalty_earn_bp) / 10000);
  if (points <= 0) return 0;
  const made = await c.query(`INSERT INTO loyalty_lots(user_id, venue_id, invoice_id, kind, points, remaining, expires_at) VALUES ($1,$2,$3,'earn',$4,$4, now() + make_interval(months => $5)) ON CONFLICT DO NOTHING RETURNING id`, [inv.user_id, inv.venue_id, inv.id, points, venue.loyalty_expiry_months]);
  if (!made.rowCount) return 0;
  await event(c, inv.user_id, inv.venue_id, points, 'earn', inv.id, `Invoice ${inv.number}`);
  await notify(c, inv.user_id, { kind: 'loyalty_earned', title: `You earned ${points} points at ${venue.name}`, body: `Worth ${venue.currency} ${toMajor(points, venue.currency)} off your next booking there.`, data: { venue_id: venue.id } });
  return points;
}

/** Spend points oldest-expiry first. Throws nothing: returns how many were actually taken (the caller checked availability under the invoice lock). */
export async function spendPoints(c, userId, venueId, points, invoiceId, note) {
  let left = points;
  const { rows } = await c.query('SELECT id, remaining FROM loyalty_lots WHERE user_id=$1 AND venue_id=$2 AND remaining > 0 AND expires_at > now() ORDER BY expires_at, earned_at, id FOR UPDATE', [userId, venueId]);
  for (const l of rows) {
    if (left <= 0) break;
    const take = Math.min(left, l.remaining);
    await c.query('UPDATE loyalty_lots SET remaining = remaining - $2 WHERE id=$1', [l.id, take]);
    left -= take;
  }
  const taken = points - left;
  if (taken > 0) await event(c, userId, venueId, -taken, 'redeem', invoiceId, note);
  return taken;
}

/** Points that were paid onto an invoice come back (invoice voided / shrunk / refunded). They get a fresh expiry. */
export async function restorePoints(c, { userId, venueId, invoiceId, points, note }) {
  if (points <= 0) return;
  const months = (await c.query('SELECT loyalty_expiry_months AS m FROM venues WHERE id=$1', [venueId])).rows[0].m;
  await addLot(c, { userId, venueId, invoiceId: null, kind: 'restore', points, months });
  await event(c, userId, venueId, points, 'restore', invoiceId, note);
}

/** What the invoices that earned points are refunded by `credit` (minor units): take back the matching points, as far as they are still there. */
export async function clawBackPoints(c, invoiceIds, credit) {
  if (!invoiceIds.length) return 0;
  const inv = (await c.query('SELECT venue_id, user_id FROM invoices WHERE id = ANY($1::uuid[]) LIMIT 1', [invoiceIds])).rows[0];
  const bp = (await c.query('SELECT loyalty_earn_bp AS bp FROM venues WHERE id=$1', [inv.venue_id])).rows[0].bp;
  let want = Math.floor((credit * bp) / 10000), taken = 0;
  if (want <= 0) return 0;
  const { rows } = await c.query("SELECT id, remaining FROM loyalty_lots WHERE invoice_id = ANY($1::uuid[]) AND kind='earn' AND remaining > 0 ORDER BY earned_at DESC FOR UPDATE", [invoiceIds]);
  for (const l of rows) {
    if (want <= 0) break;
    const t = Math.min(want, l.remaining);
    await c.query('UPDATE loyalty_lots SET remaining = remaining - $2 WHERE id=$1', [l.id, t]);
    want -= t; taken += t;
  }
  if (taken > 0) await event(c, inv.user_id, inv.venue_id, -taken, 'clawback', invoiceIds[0], 'Refunded booking');
  return taken;
}

/** Zero out lots past their expiry and record it per person and venue. Returns the points expired. */
export async function expireLoyalty() {
  const { rows } = await query(
    `WITH gone AS (
       UPDATE loyalty_lots l SET remaining = 0 FROM (SELECT id, remaining AS old FROM loyalty_lots WHERE remaining > 0 AND expires_at <= now() FOR UPDATE) o
        WHERE l.id = o.id RETURNING l.user_id, l.venue_id, o.old)
     INSERT INTO loyalty_events(user_id, venue_id, delta, kind, note) SELECT user_id, venue_id, -sum(old)::int, 'expire', 'Points expired' FROM gone GROUP BY user_id, venue_id RETURNING delta`);
  return rows.reduce((s, r) => s - r.delta, 0);
}
