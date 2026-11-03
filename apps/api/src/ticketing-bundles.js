// Bundles and hospitality packages (#587): tickets and add-ons (parking, merchandise) sold together at one price.
// A bundle is not a second kind of ticket. It expands into ordinary order lines and add-on items inside the same order, hold, capacity check, payment and
// refund as everything else, and only adds (a) its own stock, (b) one price. The saving (what the parts cost on their own less the bundle price) is shared
// across the bundle's tickets and stored on each (tickets.discount_minor), so a refund of one ticket returns exactly what that ticket cost the buyer.
// A bundle never costs more than its parts: if the parts have since become cheaper than the bundle price, the buyer pays the parts.
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { allocate } from './ticketing-commerce.js';

export const BUNDLE_KINDS = ['bundle', 'hospitality'];
export const BUNDLE_LIVE = "(o.status='confirmed' OR (o.status='pending_payment' AND o.expires_at > now()))";

/** How many of a bundle are spoken for (paid, or held and not yet lapsed). */
export async function bundleTaken(c, bundleId) {
  return Number((await c.query(`SELECT coalesce(sum(b.qty),0)::int AS n FROM ticket_bundle_orders b JOIN ticket_orders o ON o.id=b.order_id WHERE b.bundle_id=$1 AND ${BUNDLE_LIVE}`, [bundleId])).rows[0].n);
}

/** The parts of a bundle, priced as they are today. */
export async function bundleParts(c, bundleId) {
  return (await c.query(
    `SELECT i.id, i.qty, i.product_id, i.addon_id, coalesce(p.name, a.name) AS name, coalesce(p.price_minor, a.price_minor) AS price_minor, coalesce(p.currency, a.currency) AS currency,
            coalesce(p.status, a.status) AS status, p.class, p.seating, a.kind AS addon_kind
       FROM ticket_bundle_items i LEFT JOIN ticket_products p ON p.id=i.product_id LEFT JOIN ticket_addons a ON a.id=i.addon_id WHERE i.bundle_id=$1 ORDER BY i.product_id NULLS LAST, name`, [bundleId])).rows;
}

/**
 * Validate the bundles asked for, take their stock and write one ticket_bundle_orders row each. Returns the ticket lines and add-on lines they expand
 * into (each tagged with its bundle order) for createOrder to process like any other. Call under the event lock, after the order row exists.
 */
export async function planBundles(c, ev, order, wanted, channel, now = new Date()) {
  const out = { lines: [], addons: [], orders: [] };
  const merged = new Map();
  for (const w of wanted ?? []) merged.set(w.bundle_id, (merged.get(w.bundle_id) ?? 0) + w.quantity);
  for (const [bundleId, qty] of merged) {
    const b = (await c.query('SELECT * FROM ticket_bundles WHERE id=$1 AND event_id=$2 FOR UPDATE', [bundleId, ev.id])).rows[0];
    if (!b) throw notFound('Bundle');
    if (b.status !== 'active') throw conflict(b.status === 'paused' ? 'This package is paused' : 'This package is not on sale', { code: 'not_on_sale' });
    if (!b.channels.includes(channel)) throw forbidden('This package is not sold through this channel');
    if (b.sale_starts_at && new Date(b.sale_starts_at) > now) throw conflict('Sales have not opened yet', { code: 'not_started' });
    if (b.sale_ends_at && new Date(b.sale_ends_at) < now) throw conflict('Sales for this package have closed', { code: 'sale_ended' });
    if (qty > b.per_order_limit) throw conflict(`At most ${b.per_order_limit} per order`, { code: 'order_limit' });
    if (b.stock != null) {
      const taken = await bundleTaken(c, b.id);
      if (taken + qty > b.stock) throw conflict(taken >= b.stock ? `${b.name} is sold out` : `Only ${b.stock - taken} of ${b.name} left`, { code: 'sold_out', remaining: Math.max(b.stock - taken, 0) });
    }
    const parts = await bundleParts(c, b.id);
    if (!parts.length) throw conflict('This package is empty', { code: 'not_on_sale' });
    if (parts.some((p) => p.status !== 'active')) throw conflict('Part of this package is not on sale right now', { code: 'not_on_sale' });
    if (parts.some((p) => p.currency !== b.currency)) throw badRequest('A package must be priced in the same currency as its contents');
    const bo = (await c.query(
      `INSERT INTO ticket_bundle_orders(event_id, bundle_id, order_id, qty, name, kind, currency, list_minor, charged_minor, discount_minor) VALUES ($1,$2,$3,$4,$5,$6,$7,0,0,0) RETURNING *`,
      [ev.id, b.id, order.id, qty, b.name, b.kind, b.currency])).rows[0];
    out.orders.push({ ...bo, price_minor: Number(b.price_minor) });
    for (const p of parts) {
      if (p.product_id) out.lines.push({ product_id: p.product_id, quantity: p.qty * qty, _bundle: bo.id, _auto_seats: p.seating === 'reserved' });
      else out.addons.push({ addon_id: p.addon_id, quantity: p.qty * qty, _bundle: bo.id });
    }
  }
  return out;
}

/**
 * After the tickets and add-ons are made: work out each bundle's list value, charge the bundle price (never more than the parts) and share the saving across
 * its tickets. `made` = the tickets just created ({ id, line_id, price, tax, bundle_order_id }); `addonValue` = Map(bundle order -> gross of its add-ons).
 * Returns what to take off the order total and off its tax.
 */
export async function applyBundlePrices(c, plan, made, addonValue) {
  const out = { total: 0, taxOff: 0 };
  const perLine = new Map();
  for (const bo of plan.orders) {
    const mine = made.filter((t) => t.bundle_order_id === bo.id);
    const ticketsGross = mine.reduce((n, t) => n + t.price, 0);
    const list = ticketsGross + (addonValue.get(bo.id) ?? 0);
    const charged = Math.min(list, bo.price_minor * bo.qty);
    const discount = Math.min(list - charged, ticketsGross);
    await c.query('UPDATE ticket_bundle_orders SET list_minor=$2, charged_minor=$3, discount_minor=$4 WHERE id=$1', [bo.id, list, list - discount, discount]);
    if (discount <= 0) continue;
    const shares = allocate(discount, mine.map((t) => t.price));
    for (const [k, t] of mine.entries()) {
      const d = shares[k];
      if (!d) continue;
      const taxOff = t.price > 0 ? Math.round((t.tax * d) / t.price) : 0;
      await c.query('UPDATE tickets SET discount_minor=$2, discount_tax_minor=$3 WHERE id=$1', [t.id, d, taxOff]);
      out.taxOff += taxOff;
      perLine.set(t.line_id, (perLine.get(t.line_id) ?? 0) + d);
    }
    out.total += discount;
  }
  for (const [lineId, d] of perLine) await c.query('UPDATE ticket_order_lines SET discount_minor = discount_minor + $2 WHERE id=$1', [lineId, d]);
  return out;
}

export const bundleOrderView = (r) => ({
  id: r.id, bundle_id: r.bundle_id, name: r.name, kind: r.kind, qty: r.qty, currency: r.currency,
  list_minor: Number(r.list_minor), charged_minor: Number(r.charged_minor), saving_minor: Number(r.discount_minor),
});
