import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden } from '../errors.js';
import { isAdmin, mustFind, mustOwn } from '../helpers.js';
import { createItem, listItems, adjustStock, updateItem, stockHistory } from '../pos/catalogue.js';

const cats = ['equipment', 'apparel', 'nutrition', 'medical', 'merch', 'other', 'food_beverage'];
// what the venue's front desk may sell or rent (docs/front-desk.md): the same stock rows, with sale terms
const terms = {
  sellable: z.boolean().optional().describe('offer it at the venue front desk'), stock_kind: z.enum(['consumable', 'rental']).default('consumable').describe('rental kit comes back; consumables do not'),
  sell_price_cents: money.nullable().optional(), rental_fee_cents: money.nullable().optional(), deposit_cents: money.optional(),
};

cap({
  name: 'create_inventory_item', method: 'POST', path: '/inventory', tag: 'Supply Chain', status: 201,
  summary: 'Track a stock item (balls, kits, bibs, first-aid, merch, food & drink…). Optionally tied to a venue; for a venue\'s item (created by its owner or a venue manager) you can also set what the front desk sells it for, or its rental fee and deposit. Opening stock is written to the stock ledger.',
  input: z.object({ name: z.string().min(1).max(80), category: z.enum(cats).default('equipment'), sku: z.string().max(40).optional(), quantity: z.number().int().min(0).default(0), reorder_level: z.number().int().min(0).default(0), unit_cost_cents: money.default(0), venue_id: id.optional(), ...terms }),
  async handler({ user }, i) {
    if (i.venue_id) return createItem(user, i);
    if (i.sellable || i.sell_price_cents != null || i.rental_fee_cents != null || i.deposit_cents || i.stock_kind === 'rental') throw badRequest('Sale and rental terms are for a venue\'s items — give the item a venue_id');
    return one('INSERT INTO inventory_items(owner_id, venue_id, name, category, sku, quantity, reorder_level, unit_cost_cents) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [user.id, null, i.name, i.category, i.sku, i.quantity, i.reorder_level, i.unit_cost_cents]);
  },
});

cap({
  name: 'list_inventory', method: 'GET', path: '/inventory', tag: 'Supply Chain', summary: 'Your stock, with low-stock flags. With venue_id (venue managers): that venue\'s stock with its front-desk sale terms, including items not offered at the desk.',
  input: z.object({ low_stock: z.coerce.boolean().optional(), category: z.enum(cats).optional(), venue_id: id.optional(), q: z.string().max(80).optional(), include_archived: z.coerce.boolean().optional(), ...page }),
  handler: ({ user }, i) => (i.venue_id ? listItems(user, i) : many(
    `SELECT *, (quantity <= reorder_level) AS low_stock FROM inventory_items WHERE owner_id=$1 AND ($2::text IS NULL OR category=$2) AND (coalesce($3,false) = false OR quantity <= reorder_level) ORDER BY name LIMIT $4 OFFSET $5`,
    [user.id, i.category ?? null, i.low_stock ?? null, i.limit, i.offset])),
});

cap({
  name: 'update_inventory_item', method: 'PATCH', path: '/inventory/:id', tag: 'Supply Chain',
  summary: 'Change an item\'s name, cost, front-desk price, rental terms, or archive it (hidden from the desk, history kept). Rental kit has a fee and deposit and is never sold; consumables have a price and are never rented.',
  input: z.object({ id, name: z.string().min(1).max(80).optional(), category: z.enum(cats).optional(), sku: z.string().max(40).optional(), reorder_level: z.number().int().min(0).optional(), unit_cost_cents: money.optional(),
    sellable: z.boolean().optional(), stock_kind: z.enum(['consumable', 'rental']).optional(), sell_price_cents: money.nullable().optional(), rental_fee_cents: money.nullable().optional(), deposit_cents: money.optional(), archived: z.boolean().optional() }),
  handler: ({ user }, { id: itemId, ...rest }) => updateItem(user, itemId, rest),
});

cap({
  name: 'adjust_stock', method: 'POST', path: '/inventory/:id/adjust', tag: 'Supply Chain', summary: 'Add or remove units (negative delta) with an optional reason. Stock can never go below zero. A venue\'s item may be adjusted by its venue managers, and every change is written to its stock ledger.',
  input: z.object({ id, delta: z.number().int().refine((n) => n !== 0), reason: z.string().trim().min(3).max(200).optional() }),
  handler: ({ user }, i) => adjustStock(user, i.id, { delta: i.delta, reason: i.reason }),
});

cap({
  name: 'list_stock_history', method: 'GET', path: '/inventory/:id/history', tag: 'Supply Chain',
  summary: 'The append-only ledger for a venue\'s item: sales, returns, rentals out and back, receiving and corrections, with who and when.',
  input: z.object({ id, ...page }),
  handler: ({ user }, i) => stockHistory(user, i.id, { limit: i.limit, offset: i.offset }),
});

cap({
  name: 'create_supply_order', method: 'POST', path: '/supply-orders', tag: 'Supply Chain', status: 201,
  summary: 'Order replenishment from a supplier for an inventory item.',
  input: z.object({ item_id: id, supplier: z.string().min(1).max(80), quantity: z.number().int().min(1), expected_on: z.string().date().optional() }),
  async handler({ user }, i) {
    mustOwn(user, (await mustFind('inventory_items', i.item_id)).owner_id, 'item');
    return one('INSERT INTO supply_orders(item_id, supplier, quantity, expected_on, ordered_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [i.item_id, i.supplier, i.quantity, i.expected_on, user.id]);
  },
});

cap({
  name: 'list_supply_orders', method: 'GET', path: '/supply-orders', tag: 'Supply Chain', summary: 'Your supply orders.',
  input: z.object({ status: z.enum(['ordered', 'shipped', 'received', 'cancelled']).optional(), ...page }),
  handler: ({ user }, i) => many(
    `SELECT o.*, it.name AS item_name FROM supply_orders o JOIN inventory_items it ON it.id=o.item_id WHERE it.owner_id=$1 AND ($2::text IS NULL OR o.status=$2) ORDER BY o.created_at DESC LIMIT $3 OFFSET $4`,
    [user.id, i.status ?? null, i.limit, i.offset]),
});

cap({
  name: 'update_supply_order', method: 'PATCH', path: '/supply-orders/:id', tag: 'Supply Chain',
  summary: 'Move an order along: shipped → received (adds the quantity to stock) or cancelled.',
  input: z.object({ id, status: z.enum(['shipped', 'received', 'cancelled']) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const o = (await c.query('SELECT o.*, it.owner_id FROM supply_orders o JOIN inventory_items it ON it.id=o.item_id WHERE o.id=$1 FOR UPDATE OF o', [i.id])).rows[0];
      if (!o) throw badRequest('Order not found');
      mustOwn(user, o.owner_id, 'order');
      if (['received', 'cancelled'].includes(o.status)) throw conflict(`Order already ${o.status}`);
      if (i.status === 'received') {
        await c.query('UPDATE inventory_items SET quantity = quantity + $2 WHERE id=$1', [o.item_id, o.quantity]);
        await c.query("INSERT INTO pos_stock_moves(venue_id, item_id, delta, reason, actor_id, note) SELECT venue_id, id, $2, 'adjust', $3, 'Supply order received' FROM inventory_items WHERE id=$1 AND venue_id IS NOT NULL", [o.item_id, o.quantity, user.id]);
        return (await c.query('UPDATE supply_orders SET status=$2, received_at=now() WHERE id=$1 RETURNING *', [i.id, i.status])).rows[0];
      }
      return (await c.query('UPDATE supply_orders SET status=$2 WHERE id=$1 RETURNING *', [i.id, i.status])).rows[0];
    });
  },
});
