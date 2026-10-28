// Equipment rental: kit goes out, comes back, comes back broken or does not come back. Deposits are held, refunded or forfeited per unit.
// This is deliberately not the consumable path: a rental never "sells" the item, and its stock moves are rental_out / rental_back.
import { many, one, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { posRole } from './access.js';
import { issueCreditNote, restoreStock, saleView } from './sale.js';

export async function issueRental(user, rentalId, { due_at }) {
  const r = await one('SELECT venue_id FROM pos_rentals WHERE id=$1', [rentalId]);
  if (!r) throw notFound('Rental');
  await posRole(user, r.venue_id);
  return tx(async (c) => {
    const rental = (await c.query('SELECT r.*, s.status AS sale_status FROM pos_rentals r JOIN pos_sales s ON s.id=r.sale_id WHERE r.id=$1 FOR UPDATE OF r', [rentalId])).rows[0];
    if (rental.sale_status !== 'paid') throw conflict('The sale is not paid yet — kit is handed over once the rental fee and deposit are paid');
    if (rental.status !== 'reserved') throw conflict(`This rental is already ${rental.status}`);
    await c.query(`UPDATE pos_rentals SET status='issued', issued_at=now(), issued_by=$2, due_at=coalesce($3, now() + interval '1 day'), deposit_status=CASE WHEN deposit_cents > 0 THEN 'held' ELSE 'none' END WHERE id=$1`, [rentalId, user.id, due_at ?? null]);
    await audit(c, user.id, 'pos_rental_issue', 'pos_rentals', rentalId);
    return rentalView(c, rentalId);
  });
}

/**
 * outcome returned -> back on the shelf, whole deposit refunded
 * outcome damaged  -> not rentable until repaired (counted as damaged), deposit forfeited by `forfeit_cents` (default: all of it)
 * outcome lost     -> gone from stock for good, deposit forfeited by `forfeit_cents` (default: all of it)
 */
export async function closeRental(user, rentalId, { outcome, forfeit_cents, note, method }) {
  const r = await one('SELECT venue_id FROM pos_rentals WHERE id=$1', [rentalId]);
  if (!r) throw notFound('Rental');
  await posRole(user, r.venue_id);
  return tx(async (c) => {
    const rental = (await c.query('SELECT * FROM pos_rentals WHERE id=$1 FOR UPDATE', [rentalId])).rows[0];
    if (rental.status !== 'issued') throw conflict(rental.status === 'reserved' ? 'This kit was never handed over' : `This rental is already ${rental.status}`);
    const deposit = Number(rental.deposit_cents);
    const forfeit = outcome === 'returned' ? 0 : Math.min(deposit, forfeit_cents ?? deposit);
    if (outcome === 'returned' && forfeit_cents) throw badRequest('A kit that came back fine keeps no part of the deposit');
    if (outcome !== 'returned' && !note) throw badRequest('Say what happened to the kit');
    const sale = (await c.query('SELECT * FROM pos_sales WHERE id=$1', [rental.sale_id])).rows[0];
    if (outcome === 'returned') await restoreStock(c, rental.venue_id, rental.item_id, 1, { saleId: rental.sale_id, rentalId, reason: 'rental_back', actor: user });
    else if (outcome === 'damaged') await c.query('UPDATE inventory_items SET damaged_qty = damaged_qty + 1 WHERE id=$1', [rental.item_id]);
    const refund = deposit - forfeit;
    let credit = null;
    if (refund > 0) {
      const inv = (await c.query("SELECT i.id FROM pos_sale_invoices psi JOIN invoices i ON i.id=psi.invoice_id WHERE psi.sale_id=$1 AND psi.role='goods'", [rental.sale_id])).rows[0];
      const item = (await c.query('SELECT name FROM inventory_items WHERE id=$1', [rental.item_id])).rows[0];
      credit = await issueCreditNote(c, { sale, user, invoiceId: inv.id, amount: refund, tax: 0, method: method ?? 'cash', reason: `Rental ${outcome}`,
        lines: [{ description: `Deposit refund · ${item.name}`, qty: 1, amount_cents: refund, tax_cents: 0, category: 'deposit' }] });
    }
    await c.query(
      `UPDATE pos_rentals SET status=$2, closed_at=now(), closed_by=$3, condition_note=$4, forfeited_cents=$5,
              deposit_status=CASE WHEN $6::bigint = 0 THEN 'none' WHEN $5::bigint = 0 THEN 'refunded' WHEN $5::bigint >= $6::bigint THEN 'forfeited' ELSE 'part_forfeited' END WHERE id=$1`,
      [rentalId, outcome, user.id, note ?? null, forfeit, deposit]);
    await audit(c, user.id, `pos_rental_${outcome}`, 'pos_rentals', rentalId);
    return { ...(await rentalView(c, rentalId)), credit_note: credit };
  });
}

export const rentalView = async (c, id) => (await c.query(
  `SELECT r.id, r.sale_id, r.status, r.deposit_cents, r.deposit_status, r.forfeited_cents, r.issued_at, r.due_at, r.closed_at, r.condition_note, it.id AS item_id, it.name AS item_name,
          (r.status = 'issued' AND r.due_at < now()) AS overdue FROM pos_rentals r JOIN inventory_items it ON it.id=r.item_id WHERE r.id=$1`, [id])).rows[0];

export async function listRentals(user, i) {
  await posRole(user, i.venue_id);
  return many(
    `SELECT r.id, r.sale_id, r.status, r.deposit_cents, r.deposit_status, r.forfeited_cents, r.issued_at, r.due_at, r.closed_at, r.condition_note, it.id AS item_id, it.name AS item_name,
            (r.status = 'issued' AND r.due_at < now()) AS overdue, coalesce(cu.display_name, 'Walk-in') AS customer
       FROM pos_rentals r JOIN inventory_items it ON it.id=r.item_id JOIN pos_sales s ON s.id=r.sale_id LEFT JOIN users cu ON cu.id=s.customer_id
      WHERE r.venue_id=$1 AND ($2::text IS NULL OR r.status=$2) AND (NOT coalesce($3, false) OR (r.status='issued' AND r.due_at < now()))
      ORDER BY (r.status='issued') DESC, r.due_at NULLS LAST, r.created_at DESC LIMIT $4 OFFSET $5`,
    [i.venue_id, i.status ?? null, i.overdue ?? null, i.limit, i.offset]);
}

export { saleView };
