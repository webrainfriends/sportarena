// The shop cart and wishlist. The cart lives on the server so it follows the person from phone to laptop; lines are never deleted
// (removed_at), prices and stock are always read live, and one checkout turns the whole cart into orders paid with a single payment.
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { cap, id } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { encrypt } from '../crypto.js';
import { paymentsEnabled } from '../payments/service.js';
import { MAX_QTY } from './shop.js';

const LINE = `ci.product_id, ci.quantity, ci.saved_for_later, p.name, p.emoji, p.brand, p.price_cents, p.compare_at_cents, p.stock, p.seller_id, p.archived_at, u.display_name AS seller_name,
  (SELECT '/api/v1/market/media/' || m.id FROM market_media m WHERE m.product_id = p.id AND m.removed_at IS NULL ORDER BY m.position, m.created_at LIMIT 1) AS image`;

/** The cart as the screen shows it: live prices, what is still available, savings, and the lines parked for later. */
async function cartFor(userId) {
  const rows = await many(`SELECT ${LINE} FROM shop_cart_items ci JOIN shop_products p ON p.id = ci.product_id JOIN users u ON u.id = p.seller_id
                            WHERE ci.user_id = $1 AND ci.removed_at IS NULL ORDER BY ci.updated_at DESC`, [userId]);
  const shape = (r) => {
    const available = r.stock > 0 && !r.archived_at;
    const max_qty = Math.max(0, Math.min(MAX_QTY, r.stock));
    return { ...r, available, max_qty, quantity: available ? Math.min(r.quantity, max_qty) : r.quantity, price_cents: Number(r.price_cents), compare_at_cents: r.compare_at_cents == null ? null : Number(r.compare_at_cents) };
  };
  const all = rows.map(shape);
  const items = all.filter((r) => !r.saved_for_later);
  const buying = items.filter((r) => r.available);
  const subtotal = buying.reduce((t, r) => t + r.price_cents * r.quantity, 0);
  const savings = buying.reduce((t, r) => t + (r.compare_at_cents > r.price_cents ? (r.compare_at_cents - r.price_cents) * r.quantity : 0), 0);
  return {
    items, saved: all.filter((r) => r.saved_for_later),
    summary: { lines: buying.length, units: buying.reduce((t, r) => t + r.quantity, 0), subtotal_cents: subtotal, savings_cents: savings, total_cents: subtotal, unavailable: items.length - buying.length },
  };
}

cap({ name: 'get_cart', method: 'GET', path: '/shop/cart', tag: 'Shop', summary: 'Your shop cart with live prices and stock, what you save, and the items you saved for later.', handler: ({ user }) => cartFor(user.id) });

cap({
  name: 'set_cart_item', method: 'POST', path: '/shop/cart/items', tag: 'Shop',
  summary: 'Add a product to the cart, change its quantity (quantity 0 removes it) or move it to / from "saved for later". Quantity is capped by stock. Returns the updated cart.',
  input: z.object({ product_id: id, quantity: z.number().int().min(0).max(MAX_QTY).optional().describe('absolute quantity; omit to keep it (1 for a new line)'), saved_for_later: z.boolean().optional(), add: z.number().int().min(1).max(MAX_QTY).optional().describe('add this many to what is already in the cart') }),
  async handler({ user }, i) {
    const p = await one('SELECT id, seller_id, stock, archived_at FROM shop_products WHERE id=$1', [i.product_id]);
    if (!p || p.archived_at) throw notFound('Product');
    if (p.seller_id === user.id) throw badRequest('You cannot buy your own product');
    const cur = await one('SELECT quantity FROM shop_cart_items WHERE user_id=$1 AND product_id=$2 AND removed_at IS NULL', [user.id, p.id]);
    const qty = i.quantity ?? (i.add != null ? (cur?.quantity ?? 0) + i.add : cur?.quantity ?? 1);
    if (qty === 0) {
      await one('UPDATE shop_cart_items SET removed_at=now(), updated_at=now() WHERE user_id=$1 AND product_id=$2 AND removed_at IS NULL RETURNING 1', [user.id, p.id]);
    } else {
      if (i.saved_for_later !== true && qty > p.stock) throw conflict(p.stock > 0 ? `Only ${p.stock} left in stock` : 'Sold out');
      await one(
        `INSERT INTO shop_cart_items(user_id, product_id, quantity, saved_for_later) VALUES ($1,$2,$3,coalesce($4,false))
         ON CONFLICT (user_id, product_id) DO UPDATE SET quantity=$3, saved_for_later=coalesce($4, CASE WHEN shop_cart_items.removed_at IS NULL THEN shop_cart_items.saved_for_later ELSE false END), removed_at=NULL, updated_at=now() RETURNING 1`,
        [user.id, p.id, qty, i.saved_for_later ?? null]);
    }
    return cartFor(user.id);
  },
});

cap({
  name: 'checkout_cart', method: 'POST', path: '/shop/cart/checkout', tag: 'Shop', status: 201,
  summary: 'Turn everything in the cart (not the saved-for-later items) into orders, one per product, reserving stock atomically — if any item is gone nothing is ordered. The delivery address is encrypted. When a payment provider is on, the orders wait for payment: pay them all at once with create_payment (purpose_type shop_checkout, purpose_id = checkout_id).',
  input: z.object({ ship_to: z.string().min(5).max(300).describe('delivery address, encrypted at rest') }),
  async handler({ user }, i) {
    const out = await tx(async (c) => {
      const { rows: lines } = await c.query(
        `SELECT ci.product_id, ci.quantity FROM shop_cart_items ci WHERE ci.user_id=$1 AND ci.removed_at IS NULL AND NOT ci.saved_for_later ORDER BY ci.product_id FOR UPDATE`, [user.id]);
      if (!lines.length) throw badRequest('Your cart is empty');
      const checkoutId = randomUUID();
      const shipTo = encrypt(i.ship_to, 'shop_orders.ship_to');
      const orders = [];
      for (const l of lines) {
        const { rows: [p] } = await c.query('UPDATE shop_products SET stock = stock - $2 WHERE id=$1 AND stock >= $2 AND archived_at IS NULL RETURNING id, name, seller_id, price_cents', [l.product_id, l.quantity]);
        if (!p) {
          const n = (await c.query('SELECT name FROM shop_products WHERE id=$1', [l.product_id])).rows[0]?.name ?? 'An item';
          throw conflict(`${n} is no longer available in that quantity — update your cart`);
        }
        if (p.seller_id === user.id) throw badRequest('You cannot buy your own product');
        const status = paymentsEnabled() && Number(p.price_cents) > 0 ? 'awaiting_payment' : 'placed';
        const { rows: [o] } = await c.query(
          'INSERT INTO shop_orders(buyer_id, seller_id, product_id, quantity, unit_price_cents, total_cents, status, ship_to_enc, checkout_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, product_id, quantity, unit_price_cents, total_cents, status',
          [user.id, p.seller_id, p.id, l.quantity, p.price_cents, Number(p.price_cents) * l.quantity, status, shipTo, checkoutId]);
        orders.push({ ...o, name: p.name });
      }
      await c.query('UPDATE shop_cart_items SET removed_at=now(), updated_at=now() WHERE user_id=$1 AND removed_at IS NULL AND NOT saved_for_later', [user.id]);
      return { checkout_id: checkoutId, orders };
    });
    const total = out.orders.reduce((t, o) => t + Number(o.total_cents), 0);
    const owing = out.orders.filter((o) => o.status === 'awaiting_payment').reduce((t, o) => t + Number(o.total_cents), 0);
    return { ...out, total_cents: total, amount_due_cents: owing, status: owing > 0 ? 'awaiting_payment' : 'placed' };
  },
});

cap({
  name: 'toggle_wishlist', method: 'POST', path: '/shop/wishlist/:product_id', tag: 'Shop',
  summary: 'Heart / un-heart a product (toggle). Hearted products are listed with list_products?wishlist=true.',
  input: z.object({ product_id: id }),
  async handler({ user }, i) {
    if (!(await one('SELECT 1 FROM shop_products WHERE id=$1', [i.product_id]))) throw notFound('Product');
    const r = await one(
      `INSERT INTO shop_wishlist(user_id, product_id) VALUES ($1,$2) ON CONFLICT (user_id, product_id) DO UPDATE SET active = NOT shop_wishlist.active RETURNING active`, [user.id, i.product_id]);
    return { product_id: i.product_id, wishlisted: r.active };
  },
});
