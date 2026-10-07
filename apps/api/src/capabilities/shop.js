import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin, sportBySlugOrId } from '../helpers.js';
import { decrypt, encrypt } from '../crypto.js';
import { paymentsEnabled, refundFor } from '../payments/service.js';

const cats = ['equipment', 'apparel', 'footwear', 'nutrition', 'medical', 'accessories', 'other'];
const PRODUCT = `p.id, p.name, p.category, p.description, p.price_cents, p.stock, p.emoji, p.seller_id, u.display_name AS seller_name, s.slug AS sport_slug, s.name AS sport, s.emoji AS sport_emoji`;

cap({
  name: 'create_product', method: 'POST', path: '/shop/products', tag: 'Shop', auth: ['supplier', 'sponsor'], status: 201,
  summary: 'List a sporting item for sale (suppliers and sponsor brands).',
  input: z.object({ name: z.string().min(2).max(100), category: z.enum(cats).default('equipment'), sport: z.string().optional(), description: z.string().max(1000).optional(), price_cents: money, stock: z.number().int().min(0).max(100000).default(0), emoji: z.string().max(8).optional() }),
  async handler({ user }, i) {
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    if (i.sport && !sport) throw notFound('Sport');
    return one("INSERT INTO shop_products(seller_id, sport_id, name, category, description, price_cents, stock, emoji) VALUES ($1,$2,$3,$4,$5,$6,$7,coalesce($8,'🎽')) RETURNING id, name, category, price_cents, stock",
      [user.id, sport?.id ?? null, i.name, i.category, i.description, i.price_cents, i.stock, i.emoji]);
  },
});

cap({
  name: 'list_products', method: 'GET', path: '/shop/products', tag: 'Shop', auth: 'public', summary: 'Browse the sports shop; filter by sport, category or text.',
  input: z.object({ sport: z.string().optional(), category: z.enum(cats).optional(), q: z.string().optional(), in_stock: z.coerce.boolean().optional(), ...page }),
  async handler(_, i) {
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    return many(
      `SELECT ${PRODUCT} FROM shop_products p JOIN users u ON u.id=p.seller_id LEFT JOIN sports s ON s.id=p.sport_id
        WHERE ($1::uuid IS NULL OR p.sport_id=$1 OR p.sport_id IS NULL) AND ($2::text IS NULL OR p.category=$2) AND ($3::text IS NULL OR p.name ILIKE '%'||$3||'%')
          AND (coalesce($4,false) = false OR p.stock > 0) ORDER BY p.created_at DESC LIMIT $5 OFFSET $6`,
      [sport?.id ?? null, i.category ?? null, i.q ?? null, i.in_stock ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'buy_product', method: 'POST', path: '/shop/orders', tag: 'Shop', status: 201,
  summary: 'Order an item. Stock is reserved atomically (never oversold). The delivery address is encrypted. When a payment provider is enabled the order starts as awaiting_payment — pay it with create_payment.',
  input: z.object({ product_id: id, quantity: z.number().int().min(1).max(50).default(1), ship_to: z.string().min(5).max(300).describe('delivery address, encrypted at rest') }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { rows: [p] } = await c.query('UPDATE shop_products SET stock = stock - $2 WHERE id=$1 AND stock >= $2 RETURNING *', [i.product_id, i.quantity]);
      if (!p) {
        if (!(await c.query('SELECT 1 FROM shop_products WHERE id=$1', [i.product_id])).rowCount) throw notFound('Product');
        throw conflict('Not enough stock');
      }
      if (p.seller_id === user.id) throw badRequest('You cannot buy your own product');
      const { rows: [o] } = await c.query(
        'INSERT INTO shop_orders(buyer_id, seller_id, product_id, quantity, unit_price_cents, total_cents, status, ship_to_enc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, product_id, quantity, unit_price_cents, total_cents, status, created_at',
        [user.id, p.seller_id, p.id, i.quantity, p.price_cents, p.price_cents * i.quantity, paymentsEnabled() && p.price_cents > 0 ? 'awaiting_payment' : 'placed', encrypt(i.ship_to, 'shop_orders.ship_to')]);
      return o;
    });
  },
});

const ORDER = `o.id, o.quantity, o.unit_price_cents, o.total_cents, o.status, o.created_at, o.ship_to_enc, p.name AS product_name, p.emoji, bu.display_name AS buyer_name, se.display_name AS seller_name`;
const ORDER_FROM = 'FROM shop_orders o JOIN shop_products p ON p.id=o.product_id JOIN users bu ON bu.id=o.buyer_id JOIN users se ON se.id=o.seller_id';

cap({
  name: 'list_my_orders', method: 'GET', path: '/shop/orders', tag: 'Shop', summary: 'Your purchases (delivery address decrypted; audit-logged).', input: z.object({ ...page }),
  async handler({ user }, i) {
    const rows = await many(`SELECT ${ORDER} ${ORDER_FROM} WHERE o.buyer_id=$1 ORDER BY o.created_at DESC LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]);
    if (rows.length) await audit(null, user.id, 'read_pii', 'shop_orders', null);
    return rows.map(({ ship_to_enc, ...r }) => ({ ...r, ship_to: decrypt(ship_to_enc, 'shop_orders.ship_to') }));
  },
});

cap({
  name: 'list_my_sales', method: 'GET', path: '/shop/sales', tag: 'Shop', auth: ['supplier', 'sponsor'], summary: 'Orders for items you sell (delivery address decrypted; audit-logged).', input: z.object({ ...page }),
  async handler({ user }, i) {
    const rows = await many(`SELECT ${ORDER} ${ORDER_FROM} WHERE o.seller_id=$1 ORDER BY o.created_at DESC LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]);
    if (rows.length) await audit(null, user.id, 'read_pii', 'shop_orders', null);
    return rows.map(({ ship_to_enc, ...r }) => ({ ...r, ship_to: decrypt(ship_to_enc, 'shop_orders.ship_to') }));
  },
});

cap({
  name: 'update_shop_order', method: 'PATCH', path: '/shop/orders/:id', tag: 'Shop',
  summary: 'Seller marks a paid order shipped/delivered. Buyer (or seller) can cancel before it ships: stock is restocked and any payment is refunded.',
  input: z.object({ id, status: z.enum(['shipped', 'delivered', 'cancelled']) }),
  async handler({ user }, i) {
    const o = await one('SELECT * FROM shop_orders WHERE id=$1', [i.id]);
    if (!o) throw notFound('Order');
    const isSeller = o.seller_id === user.id, isBuyer = o.buyer_id === user.id;
    if (!isSeller && !isBuyer && !isAdmin(user)) throw forbidden();
    if (i.status !== 'cancelled' && !isSeller && !isAdmin(user)) throw forbidden('Only the seller can ship or deliver');
    const ok = i.status === 'cancelled' ? ['awaiting_payment', 'placed'].includes(o.status) : i.status === 'shipped' ? o.status === 'placed' : o.status === 'shipped';
    if (!ok) throw conflict(o.status === 'awaiting_payment' && i.status === 'shipped' ? 'Waiting for the buyer to pay' : `Cannot move an order from ${o.status} to ${i.status}`);
    // refund first: if the provider refuses, the order stays as it is
    if (i.status === 'cancelled') await refundFor('shop_order', o.id);
    return tx(async (c) => {
      const cur = (await c.query('SELECT status FROM shop_orders WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (cur.status !== o.status) throw conflict('The order just changed — refresh and try again');
      if (i.status === 'cancelled') await c.query('UPDATE shop_products SET stock = stock + $2 WHERE id=$1', [o.product_id, o.quantity]);
      return (await c.query('UPDATE shop_orders SET status=$2 WHERE id=$1 RETURNING id, status', [i.id, i.status])).rows[0];
    });
  },
});
