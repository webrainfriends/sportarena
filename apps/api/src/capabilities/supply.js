import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden } from '../errors.js';
import { isAdmin, mustFind, mustOwn } from '../helpers.js';

const cats = ['equipment', 'apparel', 'nutrition', 'medical', 'merch', 'other'];

cap({
  name: 'create_inventory_item', method: 'POST', path: '/inventory', tag: 'Supply Chain', status: 201,
  summary: 'Track a stock item (balls, kits, bibs, first-aid, merch…). Optionally tied to a venue.',
  input: z.object({ name: z.string().min(1).max(80), category: z.enum(cats).default('equipment'), sku: z.string().max(40).optional(), quantity: z.number().int().min(0).default(0), reorder_level: z.number().int().min(0).default(0), unit_cost_cents: money.default(0), venue_id: id.optional() }),
  async handler({ user }, i) {
    if (i.venue_id) mustOwn(user, (await mustFind('venues', i.venue_id)).owner_id, 'venue');
    return one('INSERT INTO inventory_items(owner_id, venue_id, name, category, sku, quantity, reorder_level, unit_cost_cents) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [user.id, i.venue_id ?? null, i.name, i.category, i.sku, i.quantity, i.reorder_level, i.unit_cost_cents]);
  },
});

cap({
  name: 'list_inventory', method: 'GET', path: '/inventory', tag: 'Supply Chain', summary: 'Your stock, with low-stock flags.',
  input: z.object({ low_stock: z.coerce.boolean().optional(), category: z.enum(cats).optional(), ...page }),
  handler: ({ user }, i) => many(
    `SELECT *, (quantity <= reorder_level) AS low_stock FROM inventory_items WHERE owner_id=$1 AND ($2::text IS NULL OR category=$2) AND (coalesce($3,false) = false OR quantity <= reorder_level) ORDER BY name LIMIT $4 OFFSET $5`,
    [user.id, i.category ?? null, i.low_stock ?? null, i.limit, i.offset]),
});

cap({
  name: 'adjust_stock', method: 'POST', path: '/inventory/:id/adjust', tag: 'Supply Chain', summary: 'Add or remove units (negative delta). Stock can never go below zero.',
  input: z.object({ id, delta: z.number().int().refine((n) => n !== 0) }),
  async handler({ user }, i) {
    const it = await mustFind('inventory_items', i.id);
    mustOwn(user, it.owner_id, 'item');
    const r = await one('UPDATE inventory_items SET quantity = quantity + $2 WHERE id=$1 AND quantity + $2 >= 0 RETURNING *', [i.id, i.delta]);
    if (!r) throw conflict('Not enough stock');
    return r;
  },
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
        return (await c.query('UPDATE supply_orders SET status=$2, received_at=now() WHERE id=$1 RETURNING *', [i.id, i.status])).rows[0];
      }
      return (await c.query('UPDATE supply_orders SET status=$2 WHERE id=$1 RETURNING *', [i.id, i.status])).rows[0];
    });
  },
});
