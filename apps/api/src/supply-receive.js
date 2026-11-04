// Receiving a supply order into stock: the one place that adds the quantity and writes the stock ledger line, used by the owner's Supply screen
// and by the academy's kit replenishment (#798) so a received order can never be counted twice or leave the ledger behind the stock.
import { badRequest, conflict } from './errors.js';

/** The order row must be locked (`FOR UPDATE OF o`) by the caller. Serial-numbered kit is received with its serials (see academy-kit), never by count. */
export async function receiveSupplyOrder(c, o, actorId, { note = 'Supply order received' } = {}) {
  if (['received', 'cancelled'].includes(o.status)) throw conflict(`Order already ${o.status}`);
  const item = (await c.query('SELECT id, serialised FROM inventory_items WHERE id=$1 FOR UPDATE', [o.item_id])).rows[0];
  if (item.serialised) throw badRequest('This is serial-numbered kit: receive it with the serial number of each unit');
  await c.query('UPDATE inventory_items SET quantity = quantity + $2 WHERE id=$1', [o.item_id, o.quantity]);
  await c.query("INSERT INTO pos_stock_moves(venue_id, item_id, delta, reason, actor_id, note) SELECT venue_id, id, $2, 'adjust', $3, $4 FROM inventory_items WHERE id=$1 AND venue_id IS NOT NULL", [o.item_id, o.quantity, actorId, note]);
  return (await c.query("UPDATE supply_orders SET status='received', received_at=now() WHERE id=$1 RETURNING *", [o.id])).rows[0];
}
