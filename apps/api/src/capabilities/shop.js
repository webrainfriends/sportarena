import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../errors.js';
import { audit, isAdmin, sportBySlugOrId } from '../helpers.js';
import { decrypt, encrypt } from '../crypto.js';
import { paymentsEnabled, refundFor, refundPartial } from '../payments/service.js';

const cats = ['equipment', 'apparel', 'footwear', 'nutrition', 'medical', 'accessories', 'other'];
export const MAX_QTY = 50;
/** Product columns as the storefront needs them. $1 is always the viewing user's id (or null) so wishlist hearts come back with the list. */
export const PRODUCT = `p.id, p.name, p.category, p.description, p.price_cents, p.compare_at_cents, p.stock, p.emoji, p.brand, p.highlights, p.seller_id, p.sport_id, p.archived_at, p.created_at,
  CASE WHEN p.compare_at_cents > p.price_cents THEN round(100.0 * (p.compare_at_cents - p.price_cents) / p.compare_at_cents)::int END AS discount_pct,
  u.display_name AS seller_name, s.slug AS sport_slug, s.name AS sport, s.emoji AS sport_emoji,
  coalesce((SELECT json_agg(json_build_object('id', m.id, 'url', '/api/v1/market/media/' || m.id) ORDER BY m.position, m.created_at) FROM market_media m WHERE m.product_id = p.id AND m.removed_at IS NULL), '[]'::json) AS images,
  (SELECT round(avg(t.rating), 1)::float FROM testimonials t WHERE t.subject_type = 'product' AND t.subject_id = p.id) AS rating,
  (SELECT count(*)::int FROM testimonials t WHERE t.subject_type = 'product' AND t.subject_id = p.id) AS rating_count,
  coalesce((SELECT sum(o.quantity)::int FROM shop_orders o WHERE o.product_id = p.id AND o.status <> 'cancelled'), 0) AS sold,
  EXISTS (SELECT 1 FROM shop_wishlist w WHERE w.product_id = p.id AND w.user_id = $1 AND w.active) AS wishlisted`;
export const PRODUCT_FROM = 'FROM shop_products p JOIN users u ON u.id = p.seller_id LEFT JOIN sports s ON s.id = p.sport_id';
const SORTS = { newest: 'p.created_at DESC', popular: 'sold DESC, p.created_at DESC', price_asc: 'p.price_cents ASC, p.created_at DESC', price_desc: 'p.price_cents DESC, p.created_at DESC', rating: 'rating DESC NULLS LAST, rating_count DESC, p.created_at DESC', discount: 'discount_pct DESC NULLS LAST, p.created_at DESC' };

const productFields = {
  name: z.string().min(2).max(100), category: z.enum(cats), sport: z.string().optional(), description: z.string().max(1000).optional(),
  price_cents: money, compare_at_cents: money.optional().describe('the usual price, shown struck through to advertise an offer (must be above price_cents)'),
  stock: z.number().int().min(0).max(100000), emoji: z.string().max(8).optional(), brand: z.string().max(60).optional(),
  highlights: z.array(z.string().min(1).max(120)).max(8).optional().describe('short selling points shown as bullets'),
  media_ids: z.array(id).max(8).optional().describe('photo ids uploaded with PUT /market/media; they become the product gallery'),
};
const offerOk = (price, was) => { if (was != null && was <= price) throw badRequest('The usual price must be higher than the selling price'); };
async function attachPhotos(c, productId, userId, ids, from = 0) {
  for (const [pos, mid] of (ids ?? []).entries()) {
    const r = await c.query("UPDATE market_media SET product_id=$1, position=$2 WHERE id=$3 AND uploader_id=$4 AND kind='photo' AND post_id IS NULL AND product_id IS NULL AND purpose IS NULL AND removed_at IS NULL", [productId, from + pos, mid, userId]);
    if (!r.rowCount) throw badRequest('One of the photos is not yours, is not a photo or is already used');
  }
}

cap({
  name: 'create_product', method: 'POST', path: '/shop/products', tag: 'Shop', auth: ['supplier', 'sponsor'], status: 201,
  summary: 'List a sporting item for sale (suppliers and sponsor brands). Upload photos first with PUT /market/media and pass their ids as media_ids.',
  input: z.object({ ...productFields, category: productFields.category.default('equipment'), stock: productFields.stock.default(0) }),
  async handler({ user }, i) {
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    if (i.sport && !sport) throw notFound('Sport');
    offerOk(i.price_cents, i.compare_at_cents);
    return tx(async (c) => {
      const p = (await c.query("INSERT INTO shop_products(seller_id, sport_id, name, category, description, price_cents, compare_at_cents, stock, emoji, brand, highlights) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9,'🎽'),$10,$11) RETURNING id, name, category, price_cents, stock",
        [user.id, sport?.id ?? null, i.name, i.category, i.description, i.price_cents, i.compare_at_cents ?? null, i.stock, i.emoji, i.brand, i.highlights ?? []])).rows[0];
      await attachPhotos(c, p.id, user.id, i.media_ids);
      return p;
    });
  },
});

cap({
  name: 'update_product', method: 'PATCH', path: '/shop/products/:id', tag: 'Shop', auth: ['supplier', 'sponsor'],
  summary: 'Edit your own listing: price, offer price, stock, text, brand, highlights, add more photos, or archive it (hidden from the shop, kept with its orders). Existing orders keep the price they were placed at.',
  input: z.object({ id, ...Object.fromEntries(Object.entries(productFields).map(([k, v]) => [k, v.optional()])), compare_at_cents: money.nullable().optional(), archived: z.boolean().optional() }),
  async handler({ user }, i) {
    const cur = await one('SELECT * FROM shop_products WHERE id=$1', [i.id]);
    if (!cur) throw notFound('Product');
    if (cur.seller_id !== user.id && !isAdmin(user)) throw forbidden('Not your listing');
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    if (i.sport && !sport) throw notFound('Sport');
    const price = i.price_cents ?? Number(cur.price_cents);
    const was = i.compare_at_cents === undefined ? (cur.compare_at_cents == null ? null : Number(cur.compare_at_cents)) : i.compare_at_cents;
    offerOk(price, was);
    return tx(async (c) => {
      const p = (await c.query(
        `UPDATE shop_products SET name=coalesce($2,name), category=coalesce($3,category), sport_id=coalesce($4,sport_id), description=coalesce($5,description), price_cents=$6, compare_at_cents=$7,
           stock=coalesce($8,stock), emoji=coalesce($9,emoji), brand=coalesce($10,brand), highlights=coalesce($11,highlights),
           archived_at = CASE WHEN $12::boolean IS NULL THEN archived_at WHEN $12 THEN coalesce(archived_at, now()) ELSE NULL END
         WHERE id=$1 RETURNING id, name, price_cents, compare_at_cents, stock, archived_at`,
        [i.id, i.name, i.category, sport?.id ?? null, i.description, price, was, i.stock, i.emoji, i.brand, i.highlights, i.archived ?? null])).rows[0];
      if (i.media_ids?.length) {
        const n = (await c.query('SELECT count(*)::int AS n FROM market_media WHERE product_id=$1 AND removed_at IS NULL', [i.id])).rows[0].n;
        if (n + i.media_ids.length > 8) throw badRequest('A product can have up to 8 photos');
        await attachPhotos(c, i.id, user.id, i.media_ids, n);
      }
      return p;
    });
  },
});

cap({
  name: 'list_products', method: 'GET', path: '/shop/products', tag: 'Shop', auth: 'public',
  summary: 'Browse the sports shop. Filter by sport, category, text, price range, offers, stock, your wishlist or your own listings; sort by newest, popular, price, rating or discount. Each product carries photos, rating, discount and whether you hearted it.',
  input: z.object({
    sport: z.string().optional(), category: z.enum(cats).optional(), q: z.string().max(100).optional(), in_stock: z.coerce.boolean().optional(),
    on_offer: z.coerce.boolean().optional(), min_price_cents: money.optional(), max_price_cents: money.optional(), min_rating: z.coerce.number().min(1).max(5).optional(),
    wishlist: z.coerce.boolean().optional().describe('only products you hearted'), mine: z.coerce.boolean().optional().describe('only your own listings, archived ones included'),
    sort: z.enum(['newest', 'popular', 'price_asc', 'price_desc', 'rating', 'discount']).default('newest'), ...page,
  }),
  async handler({ user }, i) {
    if ((i.wishlist || i.mine) && !user) throw unauthorized();
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    return many(
      `SELECT * FROM (SELECT ${PRODUCT} ${PRODUCT_FROM}
        WHERE ($2::uuid IS NULL OR p.sport_id=$2 OR p.sport_id IS NULL) AND ($3::text IS NULL OR p.category=$3)
          AND ($4::text IS NULL OR p.name ILIKE '%'||$4||'%' OR p.brand ILIKE '%'||$4||'%' OR p.description ILIKE '%'||$4||'%')
          AND (coalesce($5,false) = false OR p.stock > 0) AND (coalesce($6,false) = false OR p.compare_at_cents > p.price_cents)
          AND ($7::bigint IS NULL OR p.price_cents >= $7) AND ($8::bigint IS NULL OR p.price_cents <= $8)
          AND (NOT coalesce($9,false) OR EXISTS (SELECT 1 FROM shop_wishlist w WHERE w.product_id=p.id AND w.user_id=$1 AND w.active))
          AND (CASE WHEN coalesce($10,false) THEN p.seller_id=$1 ELSE p.archived_at IS NULL END)) p
        WHERE ($11::float IS NULL OR p.rating >= $11)
        ORDER BY ${SORTS[i.sort]} LIMIT $12 OFFSET $13`,
      [user?.id ?? null, sport?.id ?? null, i.category ?? null, i.q ?? null, i.in_stock ?? null, i.on_offer ?? null, i.min_price_cents ?? null, i.max_price_cents ?? null, i.wishlist ?? null, i.mine ?? null, i.min_rating ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'get_product', method: 'GET', path: '/shop/products/:id', tag: 'Shop', auth: 'public',
  summary: 'One product with photos, rating, highlights and more from the same sport or category. `can_review` is true when you bought it and have not reviewed it yet (reviews are testimonials with subject_type=product).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const p = await one(`SELECT ${PRODUCT} ${PRODUCT_FROM} WHERE p.id=$2`, [user?.id ?? null, i.id]);
    if (!p || (p.archived_at && p.seller_id !== user?.id)) throw notFound('Product');
    const related = await many(
      `SELECT ${PRODUCT} ${PRODUCT_FROM} WHERE p.id <> $2 AND p.archived_at IS NULL AND (p.category=$3 OR ($4::uuid IS NOT NULL AND p.sport_id=$4))
        ORDER BY (p.category=$3)::int + (p.sport_id IS NOT DISTINCT FROM $4)::int DESC, p.created_at DESC LIMIT 8`,
      [user?.id ?? null, p.id, p.category, p.sport_id]);
    const can_review = user ? Boolean(await one("SELECT 1 FROM shop_orders o WHERE o.buyer_id=$1 AND o.product_id=$2 AND o.status IN ('placed','shipped','delivered') AND NOT EXISTS (SELECT 1 FROM testimonials t WHERE t.author_id=$1 AND t.subject_type='product' AND t.subject_id=$2)", [user.id, p.id])) : false;
    return { ...p, related, can_review };
  },
});

cap({
  name: 'buy_product', method: 'POST', path: '/shop/orders', tag: 'Shop', status: 201,
  summary: 'Order an item. Stock is reserved atomically (never oversold). The delivery address is encrypted. When a payment provider is enabled the order starts as awaiting_payment — pay it with create_payment.',
  input: z.object({ product_id: id, quantity: z.number().int().min(1).max(50).default(1), ship_to: z.string().min(5).max(300).describe('delivery address, encrypted at rest') }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { rows: [p] } = await c.query('UPDATE shop_products SET stock = stock - $2 WHERE id=$1 AND stock >= $2 AND archived_at IS NULL RETURNING *', [i.product_id, i.quantity]);
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

const ORDER = `o.id, o.quantity, o.unit_price_cents, o.total_cents, o.status, o.created_at, o.ship_to_enc, o.checkout_id, p.id AS product_id, p.name AS product_name, p.emoji, (SELECT '/api/v1/market/media/' || m.id FROM market_media m WHERE m.product_id = p.id AND m.removed_at IS NULL ORDER BY m.position, m.created_at LIMIT 1) AS image, bu.display_name AS buyer_name, se.display_name AS seller_name`;
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
    if (i.status === 'cancelled' && !(await refundFor('shop_order', o.id)) && o.checkout_id) {
      // bought in a cart: the money was one payment for the whole checkout, so give back just this line (idempotent per order)
      const pay = await one("SELECT * FROM payments WHERE purpose_type='shop_checkout' AND purpose_id=$1 AND status='paid'", [o.checkout_id]);
      if (pay) await refundPartial(pay, Number(o.total_cents), `shop-order-${o.id}`);
    }
    return tx(async (c) => {
      const cur = (await c.query('SELECT status FROM shop_orders WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (cur.status !== o.status) throw conflict('The order just changed — refresh and try again');
      if (i.status === 'cancelled') await c.query('UPDATE shop_products SET stock = stock + $2 WHERE id=$1', [o.product_id, o.quantity]);
      return (await c.query('UPDATE shop_orders SET status=$2 WHERE id=$1 RETURNING id, status', [i.id, i.status])).rows[0];
    });
  },
});
