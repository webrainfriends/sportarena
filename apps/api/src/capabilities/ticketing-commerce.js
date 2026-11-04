// Ticketing completion (#699): promo codes, the waitlist, parking and merchandise add-ons, and the resale-policy history. Extends the spectator
// ticketing capabilities (src/capabilities/ticketing.js) rather than adding a second shop: the order, the payment, the ticket and the report stay
// the same ones, and every rule lives in src/ticketing.js / src/ticketing-commerce.js so REST, OpenAPI and MCP share it.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { pool, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { isYouth } from '../youth.js';
import { loadViewableEvent } from '../spectator.js';
import { isOrganiser } from './event-departments.js';
import { eventOf, operatorOf, organiserOf, orderView } from './ticketing.js';
import { confirmOrder, createOrder, lockEvent, releaseOrder, remainingOf, settingsOf } from '../ticketing.js';
import { ADDON_KINDS, ADDON_LIVE, addonRefundRule, addonTaken, addonView, collectAddon, promoteWaitlist, settleAddonRefund } from '../ticketing-commerce.js';

const TAG = 'Spectator ticketing';
const money = z.coerce.number().int().min(0).max(100_000_000);
const currency = z.string().regex(/^[A-Z]{3}$/, 'use a 3-letter currency code');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use a date as YYYY-MM-DD');
const reason = z.string().trim().min(3).max(300);

// ---- promo codes -----------------------------------------------------------------------------------------------------------------------------------
const promoFields = {
  name: z.string().trim().min(2).max(80), kind: z.enum(['percent', 'fixed']), value: z.number().int().min(1).max(100_000_000), currency,
  valid_from: day.nullable(), valid_to: day.nullable(), max_redemptions: z.number().int().min(1).max(1_000_000).nullable(), per_user_limit: z.number().int().min(1).max(1000).nullable(),
  max_discount_minor: z.number().int().min(1).max(100_000_000).nullable(), stackable: z.boolean(), product_ids: z.array(id).max(50),
};

async function productsOk(c, eventId, ids) {
  if (!ids?.length) return;
  const ok = (await c.query('SELECT count(*)::int AS n FROM ticket_products WHERE event_id=$1 AND id = ANY($2::uuid[])', [eventId, ids])).rows[0].n;
  if (ok !== new Set(ids).size) throw badRequest('A ticket product does not belong to this event');
}
const promoRows = (c, eventId, promoId = null) => c.query(
  `SELECT d.*, count(x.*) FILTER (WHERE x.reversed_at IS NULL AND o.status='confirmed')::int AS uses, count(x.*) FILTER (WHERE x.reversed_at IS NULL AND o.status='pending_payment')::int AS held,
          coalesce(sum(x.amount_cents) FILTER (WHERE x.reversed_at IS NULL AND o.status='confirmed'),0)::bigint AS given
     FROM discounts d LEFT JOIN discount_redemptions x ON x.discount_id=d.id LEFT JOIN ticket_orders o ON o.id=x.ticket_order_id
    WHERE d.event_id=$1 AND ($2::uuid IS NULL OR d.id=$2) GROUP BY d.id ORDER BY d.created_at`, [eventId, promoId]);
const promoView = (d) => ({
  id: d.id, event_id: d.event_id, name: d.name, code: d.code, kind: d.kind, value: d.value, currency: d.currency, valid_from: d.valid_from, valid_to: d.valid_to, max_redemptions: d.max_redemptions, per_user_limit: d.per_user_limit,
  max_discount_minor: d.max_discount_minor == null ? null : Number(d.max_discount_minor), stackable: d.stackable, product_ids: d.product_ids, active: d.active, uses: d.uses ?? 0, held: d.held ?? 0, discount_minor: Number(d.given ?? 0),
});

cap({
  name: 'create_ticket_promo', method: 'POST', path: '/events/:id/ticket-promos', tag: TAG, status: 201,
  summary: 'Organiser: create a promo code for the event\'s tickets: a percentage or a fixed amount off, an optional cap on what one order can take off, a date window, a total-use limit, a per-account limit, the ticket products it applies to (none = all), and whether it can be combined with another code. Applied to tickets only, never to add-ons.',
  input: z.object({
    id, code: z.string().trim().min(3).max(24).regex(/^[A-Za-z0-9_-]+$/, 'letters, numbers, - and _ only'), name: promoFields.name.optional(), kind: promoFields.kind, value: promoFields.value, currency: promoFields.currency.optional(),
    valid_from: promoFields.valid_from.optional(), valid_to: promoFields.valid_to.optional(), max_redemptions: promoFields.max_redemptions.optional(), per_user_limit: promoFields.per_user_limit.optional(),
    max_discount_minor: promoFields.max_discount_minor.optional(), stackable: promoFields.stackable.default(false), product_ids: promoFields.product_ids.default([]),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const ev = await organiserOf(user, i.id, c);
    if (i.kind === 'percent' && i.value > 100) throw badRequest('A percentage cannot be more than 100');
    if (i.kind === 'fixed' && !i.currency) throw badRequest('A fixed amount needs a currency');
    if (i.valid_from && i.valid_to && i.valid_to < i.valid_from) throw badRequest('The code cannot end before it starts');
    await productsOk(c, ev.id, i.product_ids);
    let row;
    try {
      row = (await c.query(
        `INSERT INTO discounts(event_id, name, code, kind, value, currency, valid_from, valid_to, max_redemptions, per_user_limit, max_discount_minor, stackable, product_ids, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [ev.id, i.name ?? i.code, i.code.toUpperCase(), i.kind, i.value, i.kind === 'fixed' ? i.currency : null, i.valid_from ?? null, i.valid_to ?? null, i.max_redemptions ?? null, i.per_user_limit ?? null, i.max_discount_minor ?? null, i.stackable, i.product_ids, user.id])).rows[0];
    } catch (e) { if (e.code === '23505') throw conflict('That promo code already exists for this event'); throw e; }
    await audit(c, user.id, 'ticket.promo.create', 'discounts', row.id);
    return promoView((await promoRows(c, ev.id, row.id)).rows[0]);
  }),
});

cap({
  name: 'list_ticket_promos', method: 'GET', path: '/events/:id/ticket-promos', tag: TAG,
  summary: 'Organiser: the promo codes of the event with how many orders used each, how many are held by unpaid orders, and the discount actually given (confirmed orders only).',
  input: z.object({ id }),
  async handler({ user }, i) { const ev = await organiserOf(user, i.id); return (await promoRows(pool, ev.id)).rows.map(promoView); },
});

cap({
  name: 'update_ticket_promo', method: 'PATCH', path: '/ticket-promos/:id', tag: TAG,
  summary: 'Organiser: switch a promo code off or on, move its window, change its limits, cap, scope or stacking rule. A code that has been used keeps its kind and value (orders already took it); switch it off and create a new one instead. Nothing is deleted.',
  input: z.object({
    id, active: z.boolean().optional(), name: promoFields.name.optional(), value: promoFields.value.optional(), valid_from: promoFields.valid_from.optional(), valid_to: promoFields.valid_to.optional(),
    max_redemptions: promoFields.max_redemptions.optional(), per_user_limit: promoFields.per_user_limit.optional(), max_discount_minor: promoFields.max_discount_minor.optional(), stackable: promoFields.stackable.optional(), product_ids: promoFields.product_ids.optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const d0 = (await c.query('SELECT * FROM discounts WHERE id=$1 AND event_id IS NOT NULL', [i.id])).rows[0];
    if (!d0) throw notFound('Promo code');
    const ev = await organiserOf(user, d0.event_id, c);
    await lockEvent(c, ev.id);   // limits are checked under this lock when an order is made, so changing them waits for those
    const cur = (await promoRows(c, ev.id, d0.id)).rows[0];
    const used = cur.uses + cur.held;
    const next = { ...d0, ...Object.fromEntries(Object.entries(i).filter(([k, v]) => k !== 'id' && v !== undefined)) };
    if (i.value !== undefined && i.value !== d0.value && used) throw conflict('This code has been used; switch it off and create a new one for a different value');
    if (d0.kind === 'percent' && next.value > 100) throw badRequest('A percentage cannot be more than 100');
    if (next.valid_from && next.valid_to && String(next.valid_to).slice(0, 10) < String(next.valid_from).slice(0, 10)) throw badRequest('The code cannot end before it starts');
    if (next.max_redemptions != null && next.max_redemptions < used) throw conflict(`${used} orders already use this code; the total cannot be lower`);
    await productsOk(c, ev.id, next.product_ids);
    await c.query(
      `UPDATE discounts SET active=$2, name=$3, value=$4, valid_from=$5, valid_to=$6, max_redemptions=$7, per_user_limit=$8, max_discount_minor=$9, stackable=$10, product_ids=$11 WHERE id=$1`,
      [d0.id, next.active, next.name, next.value, next.valid_from, next.valid_to, next.max_redemptions, next.per_user_limit, next.max_discount_minor, next.stackable, next.product_ids]);
    await audit(c, user.id, 'ticket.promo.update', 'discounts', d0.id);
    return promoView((await promoRows(c, ev.id, d0.id)).rows[0]);
  }),
});

class QuoteDone extends Error {}
cap({
  name: 'quote_ticket_order', method: 'POST', path: '/events/:id/ticket-orders/quote', tag: TAG,
  summary: 'Price an order without reserving anything: the same maths as create_ticket_order (promo codes, add-ons, tax) run and rolled back, so the quote is exactly what the order would charge. Use it to show a total, or to check that a promo code is valid, before buying.',
  input: z.object({
    id, lines: z.array(z.object({ product_id: id, quantity: z.number().int().min(1).max(100), seats: z.array(z.string().trim().min(2).max(6)).max(100).optional() })).max(10).default([]),
    bundles: z.array(z.object({ bundle_id: id, quantity: z.number().int().min(1).max(100) })).max(5).optional(),
    promo_codes: z.array(z.string().trim().min(2).max(40)).max(5).optional(), addons: z.array(z.object({ addon_id: id, quantity: z.number().int().min(1).max(100) })).max(10).optional(),
  }).refine((v) => v.lines.length + (v.bundles?.length ?? 0) > 0, 'Choose at least one ticket or package'),
  async handler({ user }, i) {
    let out = null;
    try {
      await tx(async (c) => {
        const ev = await eventOf(i.id, c);
        await loadViewableEvent(user, ev.id);
        if (await isYouth(user.id, c)) throw forbidden('A parent or guardian needs to buy tickets for a young person');
        const r = await createOrder(c, user, ev, i, { channel: 'online', quote: true });
        const v = await orderView(c, r.order_id);
        out = { quote: true, currency: v.currency, subtotal_minor: v.subtotal_minor, tax_minor: v.tax_minor, discount_minor: v.discount_minor, addons_minor: v.addons_minor, total_minor: v.total_minor,
          lines: v.lines, promos: v.promos, addons: Object.values(v.addons.reduce((m, a) => { (m[a.addon_id] ??= { addon_id: a.addon_id, name: a.name, quantity: 0, price_minor: a.price_minor }).quantity++; return m; }, {})) };
        throw new QuoteDone();   // nothing is kept: the hold, the redemption and the add-ons all roll back
      });
    } catch (e) { if (!(e instanceof QuoteDone)) throw e; }
    return out;
  },
});

// ---- add-ons: parking and merchandise --------------------------------------------------------------------------------------------------------------
const addonFields = {
  kind: z.enum(ADDON_KINDS), name: z.string().trim().min(2).max(80), description: z.string().trim().max(300).nullable(), collect_note: z.string().trim().max(160).nullable(),
  price_minor: money, currency, tax_bp: z.number().int().min(0).max(10000), tax_inclusive: z.boolean(), stock: z.number().int().min(0).max(1_000_000).nullable(), per_order_limit: z.number().int().min(1).max(100),
  status: z.enum(['draft', 'active', 'paused', 'archived']),
};
const addonRow = async (c, a) => {
  const n = (await c.query(
    `SELECT count(*) FILTER (WHERE ${ADDON_LIVE.replace(/i\./g, '')} )::int AS taken, count(*) FILTER (WHERE status IN ('issued','collected'))::int AS sold, count(*) FILTER (WHERE status='collected')::int AS collected,
            count(*) FILTER (WHERE status IN ('refund_due','refunded'))::int AS refunded FROM ticket_addon_items WHERE addon_id=$1`, [a.id])).rows[0];
  return { ...a, price_minor: Number(a.price_minor), ...n, left: a.stock == null ? null : Math.max(a.stock - n.taken, 0) };
};

cap({
  name: 'create_ticket_addon', method: 'POST', path: '/events/:id/ticket-addons', tag: TAG, status: 201,
  summary: 'Organiser: create a parking or merchandise add-on for the event: a price with tax and currency, its own stock (blank = unlimited), a per-order limit and where to collect it. It is bought in the same order and payment as the tickets, never counts towards spectator capacity, and is handed over at the gate or desk. Starts as a draft.',
  input: z.object({ id, kind: addonFields.kind, name: addonFields.name, description: addonFields.description.optional(), collect_note: addonFields.collect_note.optional(), price_minor: addonFields.price_minor, currency: addonFields.currency,
    tax_bp: addonFields.tax_bp.default(0), tax_inclusive: addonFields.tax_inclusive.default(true), stock: addonFields.stock.optional(), per_order_limit: addonFields.per_order_limit.default(4), status: addonFields.status.default('draft') }),
  handler: ({ user }, i) => tx(async (c) => {
    const ev = await organiserOf(user, i.id, c);
    let row;
    try {
      row = (await c.query(
        `INSERT INTO ticket_addons(event_id, kind, name, description, collect_note, price_minor, currency, tax_bp, tax_inclusive, stock, per_order_limit, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [ev.id, i.kind, i.name, i.description ?? null, i.collect_note ?? null, i.price_minor, i.currency, i.tax_bp, i.tax_inclusive, i.stock ?? null, i.per_order_limit, i.status, user.id])).rows[0];
    } catch (e) { if (e.code === '23505') throw conflict('An add-on with that name already exists'); throw e; }
    await audit(c, user.id, 'ticket.addon.create', 'ticket_addons', row.id);
    return addonRow(c, row);
  }),
});

cap({
  name: 'list_ticket_addons', method: 'GET', path: '/events/:id/ticket-addons', tag: TAG,
  summary: 'Organiser: the add-ons of the event with stock, how many are sold, collected and refunded, and how many are left.',
  input: z.object({ id, archived: z.coerce.boolean().default(false) }),
  async handler({ user }, i) {
    const ev = await organiserOf(user, i.id);
    const out = [];
    for (const a of await many("SELECT * FROM ticket_addons WHERE event_id=$1 AND ($2::boolean OR status <> 'archived') ORDER BY kind, created_at", [ev.id, i.archived])) out.push(await addonRow(pool, a));
    return out;
  },
});

cap({
  name: 'update_ticket_addon', method: 'PATCH', path: '/ticket-addons/:id', tag: TAG,
  summary: 'Organiser: change an add-on or move it between draft, active, paused and archived (archived add-ons stay for history). Price and tax changes apply to future orders only; stock cannot go below what is sold or held.',
  input: z.object({ id, ...Object.fromEntries(Object.entries(addonFields).filter(([k]) => k !== 'currency' && k !== 'kind').map(([k, v]) => [k, v.optional()])) }),
  handler: ({ user }, i) => tx(async (c) => {
    const cur = (await c.query('SELECT * FROM ticket_addons WHERE id=$1', [i.id])).rows[0];
    if (!cur) throw notFound('Add-on');
    const ev = await organiserOf(user, cur.event_id, c);
    await lockEvent(c, ev.id);
    const next = { ...cur, ...Object.fromEntries(Object.entries(i).filter(([k, v]) => k !== 'id' && v !== undefined)) };
    if (next.stock != null && next.stock < await addonTaken(c, cur.id)) throw conflict('More than that are already sold or held; the stock cannot be lower');
    let row;
    try {
      row = (await c.query('UPDATE ticket_addons SET name=$2, description=$3, collect_note=$4, price_minor=$5, tax_bp=$6, tax_inclusive=$7, stock=$8, per_order_limit=$9, status=$10 WHERE id=$1 RETURNING *',
        [cur.id, next.name, next.description, next.collect_note, next.price_minor, next.tax_bp, next.tax_inclusive, next.stock, next.per_order_limit, next.status])).rows[0];
    } catch (e) { if (e.code === '23505') throw conflict('An add-on with that name already exists'); throw e; }
    await audit(c, user.id, 'ticket.addon.update', 'ticket_addons', cur.id);
    return addonRow(c, row);
  }),
});

cap({
  name: 'list_my_ticket_addons', method: 'GET', path: '/me/ticket-addons', tag: TAG,
  summary: 'The parking and merchandise I bought, with the QR token for each one still to collect, where to collect it, and whether it was collected or refunded.',
  input: z.object({ event_id: id.optional() }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT i.*, e.name AS event_name, e.starts_on FROM ticket_addon_items i JOIN events e ON e.id=i.event_id WHERE i.holder_id=$1 AND i.status IN ('issued','collected','refund_due','refunded') AND ($2::uuid IS NULL OR i.event_id=$2) ORDER BY e.starts_on, i.name, i.created_at`, [user.id, i.event_id ?? null]);
    return { items: rows.map((r) => ({ ...addonView(r, { holder: true }), event: { id: r.event_id, name: r.event_name, starts_on: r.starts_on } })) };
  },
});

cap({
  name: 'collect_ticket_addon', method: 'POST', path: '/events/:id/ticket-addons/collect', tag: TAG,
  summary: 'Gate or desk: hand over a parking pass or merchandise by its QR token or the short code typed by hand. Answers collected, already_collected, not_issued, refunded, wrong_event or invalid. One atomic update, so two desks can never both hand over the same item; the operator and time are audit-logged. No name or price is shown.',
  input: z.object({ id, token: z.string().trim().max(120).optional(), code: z.string().trim().max(40).optional() }).refine((i) => !!i.token !== !!i.code, 'Give either token or code'),
  handler: ({ user }, i) => tx(async (c) => { const ev = await operatorOf(user, i.id, c); return collectAddon(c, ev, user, i); }),
});

cap({
  name: 'refund_ticket_addon', method: 'POST', path: '/ticket-addon-items/:id/refund', tag: TAG,
  summary: 'Refund one parking or merchandise item through the original payment. The buyer can while the organiser\'s refund policy allows it and the item has not been collected; the organiser always can (with a reason). It becomes refunded only after the payment has actually been refunded; until then it shows as waiting for refund.',
  input: z.object({ id, reason: reason.optional() }),
  async handler({ user }, i) {
    const itemId = await tx(async (c) => {
      const i0 = (await c.query('SELECT * FROM ticket_addon_items WHERE id=$1', [i.id])).rows[0];
      if (!i0) throw notFound('Add-on');
      const ev = await eventOf(i0.event_id, c);
      const organiser = await isOrganiser(user, ev, c);
      if (i0.holder_id !== user.id && !organiser) throw notFound('Add-on');
      if (organiser && i0.holder_id !== user.id && !i.reason) throw badRequest('Give a reason');
      await lockEvent(c, ev.id);
      const item = (await c.query('SELECT * FROM ticket_addon_items WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      const rule = await addonRefundRule(c, item, { organiser });
      if (!rule.ok) throw conflict(rule.reason, { code: 'not_refundable' });
      await c.query("UPDATE ticket_addon_items SET status='refund_due', ended_at=now(), end_reason=$2 WHERE id=$1", [item.id, i.reason ?? 'Refund requested by the buyer']);
      await audit(c, user.id, 'ticket.addon.refund', 'ticket_addon_items', item.id);
      return item.id;
    });
    return { ...(await settleAddonRefund(itemId)), item_id: itemId };
  },
});

// ---- waitlist ---------------------------------------------------------------------------------------------------------------------------------------
const waitView = async (c, w) => {
  const pos = w.status === 'waiting' ? (await c.query("SELECT count(*)::int + 1 AS n FROM ticket_waitlist WHERE product_id=$1 AND status='waiting' AND seq < $2", [w.product_id, w.seq])).rows[0].n : null;
  return { id: w.id, event_id: w.event_id, product_id: w.product_id, quantity: w.quantity, status: w.status, position: pos, offer_expires_at: w.offer_expires_at, order_id: w.order_id, created_at: w.created_at };
};

cap({
  name: 'join_ticket_waitlist', method: 'POST', path: '/ticket-products/:id/waitlist', tag: TAG, status: 201,
  summary: 'Join the waitlist of a sold-out ticket. When places free up (a hold lapses, a ticket is refunded or voided, capacity is raised) the first in line whose party fits is offered them: the tickets are held for a few minutes as a normal reservation, so nobody else can take them, and the next person is offered them if the time runs out. Refused while tickets are still available, and for a young person (a guardian joins instead).',
  input: z.object({ id, quantity: z.number().int().min(1).max(100).default(1) }),
  handler: ({ user }, i) => tx(async (c) => {
    const p = (await c.query("SELECT * FROM ticket_products WHERE id=$1 AND status='active' AND 'online' = ANY(channels)", [i.id])).rows[0];
    if (!p) throw notFound('Ticket product');
    const ev = await eventOf(p.event_id, c);
    await loadViewableEvent(user, ev.id);
    if (['cancelled', 'completed'].includes(ev.status)) throw conflict(`The event is ${ev.status}`);
    if (await isYouth(user.id, c)) throw forbidden('A parent or guardian needs to join the waitlist for a young person');
    await lockEvent(c, ev.id);
    const settings = await settingsOf(c, ev.id);
    if (!settings.waitlist_enabled) throw conflict('This event has no waitlist', { code: 'waitlist_off' });
    const now = new Date();
    if ((p.sale_starts_at && new Date(p.sale_starts_at) > now) || (p.sale_ends_at && new Date(p.sale_ends_at) < now)) throw conflict('This ticket is not on sale', { code: 'not_on_sale' });
    if (i.quantity > p.per_order_limit) throw conflict(`At most ${p.per_order_limit} per order`, { code: 'order_limit' });
    const have = (await c.query("SELECT count(*)::int AS n FROM tickets t JOIN ticket_orders o ON o.id=t.order_id WHERE o.buyer_id=$1 AND t.product_id=$2 AND (t.status='issued' OR (t.status='reserved' AND t.hold_expires_at > now()))", [user.id, p.id])).rows[0].n;
    if (have + i.quantity > p.per_account_limit) throw conflict(`At most ${p.per_account_limit} per account`, { code: 'account_limit' });
    const room = await remainingOf(c, ev, p);
    if (room === null || room >= i.quantity) throw conflict('Tickets are available now; buy them instead', { code: 'tickets_available' });
    let w;
    try { w = (await c.query('INSERT INTO ticket_waitlist(event_id, product_id, user_id, quantity) VALUES ($1,$2,$3,$4) RETURNING *', [ev.id, p.id, user.id, i.quantity])).rows[0]; }
    catch (e) { if (e.code === '23505') throw conflict('You are already on this waitlist', { code: 'already_waiting' }); throw e; }
    return waitView(c, w);
  }),
});

cap({
  name: 'list_my_ticket_waitlist', method: 'GET', path: '/me/ticket-waitlist', tag: TAG,
  summary: 'My places on ticket waitlists: where I am in line, and for an offer the held order to pay and when it runs out. Past entries (bought, lapsed, left) are kept.',
  input: z.object({ event_id: id.optional() }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT w.*, p.name AS product_name, p.currency, e.name AS event_name FROM ticket_waitlist w JOIN ticket_products p ON p.id=w.product_id JOIN events e ON e.id=w.event_id
        WHERE w.user_id=$1 AND ($2::uuid IS NULL OR w.event_id=$2) ORDER BY (w.status IN ('waiting','offered')) DESC, w.created_at DESC LIMIT 50`, [user.id, i.event_id ?? null]);
    const items = [];
    for (const w of rows) {
      const v = await waitView(pool, w);
      items.push({ ...v, product_name: w.product_name, event_name: w.event_name, currency: w.currency, order: w.status === 'offered' && w.order_id ? await orderView(pool, w.order_id) : null });
    }
    return { items };
  },
});

cap({
  name: 'leave_ticket_waitlist', method: 'POST', path: '/ticket-waitlist/:id/leave', tag: TAG,
  summary: 'Leave a waitlist, or pass on an offer: the held tickets are released at once and the next person in line is offered them.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const w0 = (await c.query('SELECT * FROM ticket_waitlist WHERE id=$1 AND user_id=$2', [i.id, user.id])).rows[0];
    if (!w0) throw notFound('Waitlist entry');
    await lockEvent(c, w0.event_id);
    const w = (await c.query('SELECT * FROM ticket_waitlist WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (w.status === 'waiting') await c.query("UPDATE ticket_waitlist SET status='left', updated_at=now() WHERE id=$1", [w.id]);
    else if (w.status === 'offered') {
      await releaseOrder(c, w.order_id, user.id, 'cancelled', 'Passed on from the waitlist', { promote: false });
      await c.query("UPDATE ticket_waitlist SET status='passed', updated_at=now() WHERE id=$1", [w.id]);
      await promoteWaitlist(c, w.event_id);
    } else throw conflict(`This entry is ${w.status}`);
    return waitView(c, (await c.query('SELECT * FROM ticket_waitlist WHERE id=$1', [w.id])).rows[0]);
  }),
});

cap({
  name: 'accept_ticket_waitlist_offer', method: 'POST', path: '/ticket-waitlist/:id/accept', tag: TAG,
  summary: 'Take a waitlist offer: a free offer is issued at once; otherwise the response carries the held order and what to pay (POST /payments, purpose_type ticket_order) before the offer runs out.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const w0 = (await c.query('SELECT * FROM ticket_waitlist WHERE id=$1 AND user_id=$2', [i.id, user.id])).rows[0];
    if (!w0) throw notFound('Waitlist entry');
    await lockEvent(c, w0.event_id);
    const w = (await c.query('SELECT * FROM ticket_waitlist WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (w.status !== 'offered') throw conflict(w.status === 'purchased' ? 'You already bought these tickets' : 'There is no offer to take', { code: 'no_offer' });
    const o = (await c.query('SELECT * FROM ticket_orders WHERE id=$1 FOR UPDATE', [w.order_id])).rows[0];
    if (o.status !== 'pending_payment' || new Date(o.expires_at) <= new Date()) throw conflict('This offer has run out', { code: 'offer_expired' });
    if (Number(o.total_minor) === 0) {
      await confirmOrder(c, o.id, user.id, { locked: true });
      await c.query("UPDATE ticket_waitlist SET status='purchased', updated_at=now() WHERE id=$1", [w.id]);
    }
    return orderView(c, o.id);
  }),
});

cap({
  name: 'list_ticket_waitlist', method: 'GET', path: '/events/:id/ticket-waitlist', tag: TAG,
  summary: 'Organiser: how many people are waiting for each sold-out ticket, how many offers are out, and how the waitlist has ended (bought, lapsed, passed, left). Counts only: no names.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ev = await organiserOf(user, i.id);
    const rows = await many(
      `SELECT p.id AS product_id, p.name, count(w.*) FILTER (WHERE w.status='waiting')::int AS waiting, coalesce(sum(w.quantity) FILTER (WHERE w.status='waiting'),0)::int AS places_wanted,
              count(w.*) FILTER (WHERE w.status='offered')::int AS offered, count(w.*) FILTER (WHERE w.status='purchased')::int AS purchased, count(w.*) FILTER (WHERE w.status='expired')::int AS expired,
              count(w.*) FILTER (WHERE w.status='passed')::int AS passed, count(w.*) FILTER (WHERE w.status='left')::int AS left_queue
         FROM ticket_products p LEFT JOIN ticket_waitlist w ON w.product_id=p.id WHERE p.event_id=$1 AND p.status <> 'archived' GROUP BY p.id ORDER BY p.created_at`, [ev.id]);
    return { event_id: ev.id, enabled: (await settingsOf(pool, ev.id)).waitlist_enabled, products: rows };
  },
});

// ---- resale policy history --------------------------------------------------------------------------------------------------------------------------
cap({
  name: 'list_ticket_policy_history', method: 'GET', path: '/events/:id/tickets/policy-history', tag: TAG,
  summary: 'Organiser: every change to the event\'s transfer, resale, refund and waitlist rules, with who changed it and when (append-only), and a summary of priced resales (count, amount, organiser fee owed). No buyer or seller names.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ev = await organiserOf(user, i.id);
    const history = await many('SELECT h.id, h.field, h.old_value, h.new_value, h.at, h.actor_id, u.display_name AS actor FROM ticket_policy_history h LEFT JOIN users u ON u.id=h.actor_id WHERE h.event_id=$1 ORDER BY h.id DESC LIMIT 200', [ev.id]);
    const r = (await pool.query('SELECT count(*)::int AS n, coalesce(sum(price_minor),0) AS price, coalesce(sum(fee_minor),0) AS fee, min(currency) AS currency FROM ticket_resales WHERE event_id=$1', [ev.id])).rows[0];
    return { event_id: ev.id, history, resales: { count: r.n, price_minor: Number(r.price), fee_owed_minor: Number(r.fee), currency: r.currency } };
  },
});
