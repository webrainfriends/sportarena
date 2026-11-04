// Professional ticketing & fan entry (#587): bundles and hospitality packages, the box office (tills, walk-up sales, tenders, cash-up, refunds at the desk),
// scanner sessions with offline reconciliation, a seating-chart sync hook and fan segments. It extends spectator ticketing (#480, #699) and reuses its
// products, orders, capacity lock, payments ledger, refunds and gate scanning; nothing here is a parallel system. Rules live in src/ticketing-ops.js and
// src/ticketing-bundles.js, shared by REST, OpenAPI and MCP.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { pool, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { lockEvent } from '../ticketing.js';
import { eventOf, operatorOf, organiserOf } from './ticketing.js';
import { BUNDLE_KINDS, bundleParts, bundleTaken } from '../ticketing-bundles.js';
import { TENDER_METHODS, boxOfficeSale, closeTill, fans, openTillOf, reconciliation, refundAtDesk, sessionFor, tillView, SEGMENTS } from '../ticketing-ops.js';
import { priced } from '../ticketing.js';
import { PRICE_POINTS, POINT_COLOUR } from './venue-seating.js';

const TAG = 'Spectator ticketing';
const when = z.string().datetime({ offset: true });
const money = z.coerce.number().int().min(0).max(100_000_000);
const currency = z.string().regex(/^[A-Z]{3}$/, 'use a 3-letter currency code');
const n = (x) => Number(x ?? 0);

// ---- bundles and hospitality packages ----------------------------------------------------------------------------------------------------------------
const bundleItem = z.object({ product_id: id.optional(), addon_id: id.optional(), qty: z.number().int().min(1).max(50).default(1) }).refine((x) => !!x.product_id !== !!x.addon_id, 'Give a ticket or an add-on');
const bundleFields = {
  kind: z.enum(BUNDLE_KINDS), name: z.string().trim().min(2).max(80), description: z.string().trim().max(400).nullable(), perks: z.array(z.string().trim().min(2).max(60)).max(12),
  price_minor: money, currency, sale_starts_at: when.nullable(), sale_ends_at: when.nullable(), stock: z.number().int().min(0).max(1_000_000).nullable(), per_order_limit: z.number().int().min(1).max(100),
  channels: z.array(z.enum(['online', 'box_office', 'partner'])).min(1).max(3), status: z.enum(['draft', 'active', 'paused', 'archived']),
};

/** The parts must belong to the event, share the bundle's currency, and the price must cover the add-ons (the saving is carried on the tickets) and not exceed the parts. */
async function checkItems(c, ev, items, cur, priceMinor) {
  if (!items.length) throw badRequest('Add at least one ticket');
  if (!items.some((x) => x.product_id)) throw badRequest('A package needs at least one ticket');
  let list = 0, addons = 0;
  const seen = new Set();
  for (const it of items) {
    const key = it.product_id ?? it.addon_id;
    if (seen.has(key)) throw badRequest('List each ticket or add-on once and use the quantity');
    seen.add(key);
    if (it.product_id) {
      const p = (await c.query('SELECT * FROM ticket_products WHERE id=$1 AND event_id=$2', [it.product_id, ev.id])).rows[0];
      if (!p || p.status === 'archived') throw notFound('Ticket');
      if (p.class === 'complimentary') throw badRequest('A complimentary ticket cannot be part of a paid package');
      if (p.currency !== cur) throw badRequest('Everything in a package must be in the package currency');
      list += priced(p).gross * it.qty;
    } else {
      const a = (await c.query('SELECT * FROM ticket_addons WHERE id=$1 AND event_id=$2', [it.addon_id, ev.id])).rows[0];
      if (!a || a.status === 'archived') throw notFound('Add-on');
      if (a.currency !== cur) throw badRequest('Everything in a package must be in the package currency');
      const g = priced(a).gross * it.qty;
      list += g; addons += g;
    }
  }
  if (priceMinor > list) throw badRequest(`A package cannot cost more than its parts (${list})`, { code: 'bundle_price_above_parts', list_minor: list });
  if (priceMinor < addons) throw badRequest(`The price must at least cover the add-ons inside it (${addons})`, { code: 'bundle_price_below_addons', addons_minor: addons });
  return list;
}

const bundleView = async (c, b) => {
  const parts = await bundleParts(c, b.id);
  const list = parts.reduce((s, p) => s + n(p.price_minor) * p.qty, 0);
  const taken = await bundleTaken(c, b.id);
  const sold = n((await c.query("SELECT coalesce(sum(bo.qty),0)::int AS n FROM ticket_bundle_orders bo JOIN ticket_orders o ON o.id=bo.order_id WHERE bo.bundle_id=$1 AND o.status='confirmed'", [b.id])).rows[0].n);
  return {
    id: b.id, event_id: b.event_id, kind: b.kind, name: b.name, description: b.description, perks: b.perks, price_minor: n(b.price_minor), currency: b.currency, list_minor: list, saving_minor: Math.max(list - n(b.price_minor), 0),
    sale_starts_at: b.sale_starts_at, sale_ends_at: b.sale_ends_at, stock: b.stock, per_order_limit: b.per_order_limit, channels: b.channels, status: b.status, created_at: b.created_at,
    items: parts.map((p) => ({ product_id: p.product_id, addon_id: p.addon_id, name: p.name, qty: p.qty, price_minor: n(p.price_minor), type: p.product_id ? 'ticket' : 'addon', class: p.class ?? null, addon_kind: p.addon_kind ?? null, status: p.status })),
    sold, taken, left: b.stock == null ? null : Math.max(b.stock - taken, 0),
  };
};

cap({
  name: 'create_ticket_bundle', method: 'POST', path: '/events/:id/ticket-bundles', tag: TAG, status: 201,
  summary: 'Organiser: create a bundle or hospitality package: tickets (and add-ons such as parking) sold together at one price, with its own stock, sale window and channels. It is not a new kind of ticket: buying one issues ordinary tickets under the same capacity, seats, hold, payment and refund rules, and the saving is shared across its tickets so a refund returns exactly what each cost. A package cannot cost more than its parts. Hospitality packages carry perks (lounge, catering, host).',
  input: z.object({ id, ...Object.fromEntries(Object.entries(bundleFields).map(([k, v]) => [k, ['description', 'perks', 'sale_starts_at', 'sale_ends_at', 'stock'].includes(k) ? v.optional() : k === 'kind' ? v.default('bundle') : k === 'status' ? v.default('draft') : k === 'per_order_limit' ? v.default(4) : k === 'channels' ? v.default(['online']) : v])), items: z.array(bundleItem).min(1).max(12) }),
  handler: ({ user }, i) => tx(async (c) => {
    const ev = await organiserOf(user, i.id, c);
    await lockEvent(c, ev.id);
    await checkItems(c, ev, i.items, i.currency, i.price_minor);
    let b;
    try {
      b = (await c.query(
        `INSERT INTO ticket_bundles(event_id, kind, name, description, perks, price_minor, currency, sale_starts_at, sale_ends_at, stock, per_order_limit, channels, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [ev.id, i.kind, i.name, i.description ?? null, i.perks ?? [], i.price_minor, i.currency, i.sale_starts_at ?? null, i.sale_ends_at ?? null, i.stock ?? null, i.per_order_limit, i.channels, i.status, user.id])).rows[0];
    } catch (e) { if (e.code === '23505') throw conflict('A package with that name already exists'); throw e; }
    for (const it of i.items) await c.query('INSERT INTO ticket_bundle_items(bundle_id, product_id, addon_id, qty) VALUES ($1,$2,$3,$4)', [b.id, it.product_id ?? null, it.addon_id ?? null, it.qty]);
    await audit(c, user.id, 'ticket.bundle.create', 'ticket_bundles', b.id);
    return bundleView(c, b);
  }),
});

cap({
  name: 'update_ticket_bundle', method: 'PATCH', path: '/ticket-bundles/:id', tag: TAG,
  summary: 'Organiser: change a bundle (price, window, stock, channels, perks, status, or its contents). The contents can only be changed while nothing has been sold; sold bundles keep the price and parts they were sold at. Stock cannot go below what is already taken.',
  input: z.object({ id, ...Object.fromEntries(Object.entries(bundleFields).filter(([k]) => k !== 'kind' && k !== 'currency').map(([k, v]) => [k, v.optional()])), items: z.array(bundleItem).min(1).max(12).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const b0 = (await c.query('SELECT * FROM ticket_bundles WHERE id=$1', [i.id])).rows[0];
    if (!b0) throw notFound('Bundle');
    const ev = await organiserOf(user, b0.event_id, c);
    await lockEvent(c, ev.id);
    const b = (await c.query('SELECT * FROM ticket_bundles WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    const sold = n((await c.query('SELECT count(*)::int AS n FROM ticket_bundle_orders WHERE bundle_id=$1', [b.id])).rows[0].n);
    if (i.items && sold) throw conflict('This package has been sold: change its price or status, or create a new package', { code: 'bundle_sold' });
    if (i.stock != null && i.stock < (await bundleTaken(c, b.id))) throw conflict('Stock cannot go below what is already taken', { code: 'stock_below_taken' });
    const price = i.price_minor ?? n(b.price_minor);
    const items = i.items ?? (await bundleParts(c, b.id)).map((p) => ({ product_id: p.product_id, addon_id: p.addon_id, qty: p.qty }));
    await checkItems(c, ev, items, b.currency, price);
    const set = ['name', 'description', 'perks', 'price_minor', 'sale_starts_at', 'sale_ends_at', 'stock', 'per_order_limit', 'channels', 'status'].filter((k) => i[k] !== undefined);
    if (set.length) {
      try { await c.query(`UPDATE ticket_bundles SET ${set.map((k, x) => `${k}=$${x + 2}`).join(', ')} WHERE id=$1`, [b.id, ...set.map((k) => i[k])]); }
      catch (e) { if (e.code === '23505') throw conflict('A package with that name already exists'); throw e; }
    }
    if (i.items) {
      await c.query('DELETE FROM ticket_bundle_items WHERE bundle_id=$1', [b.id]);   // composition of an unsold draft package, not user data
      for (const it of i.items) await c.query('INSERT INTO ticket_bundle_items(bundle_id, product_id, addon_id, qty) VALUES ($1,$2,$3,$4)', [b.id, it.product_id ?? null, it.addon_id ?? null, it.qty]);
    }
    await audit(c, user.id, 'ticket.bundle.update', 'ticket_bundles', b.id);
    return bundleView(c, (await c.query('SELECT * FROM ticket_bundles WHERE id=$1', [b.id])).rows[0]);
  }),
});

cap({
  name: 'list_ticket_bundles', method: 'GET', path: '/events/:id/ticket-bundles', tag: TAG,
  summary: 'Organiser: the bundles and hospitality packages of the event with their contents, list value, saving, sold and stock left.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ev = await organiserOf(user, i.id);
    const rows = await many("SELECT * FROM ticket_bundles WHERE event_id=$1 AND status <> 'archived' ORDER BY created_at", [ev.id]);
    return { items: await Promise.all(rows.map((b) => bundleView(pool, b))) };
  },
});

cap({
  name: 'list_public_ticket_bundles', method: 'GET', path: '/public/events/:id/tickets/bundles', tag: TAG, auth: 'public',
  summary: 'The packages on sale for a public event: what is inside, the price against buying the parts separately, and a coarse availability. No counts of who bought.',
  input: z.object({ id }),
  async handler(_ctx, i) {
    const ev = await eventOf(i.id);
    if (!['published', 'open', 'live', 'in_progress', 'upcoming', 'registration_open', 'scheduled'].includes(ev.status) && ev.visibility !== 'public') throw notFound('Event');
    const now = new Date();
    const rows = await many("SELECT * FROM ticket_bundles WHERE event_id=$1 AND status IN ('active','paused') AND 'online' = ANY(channels) ORDER BY price_minor", [ev.id]);
    const out = [];
    for (const b of rows) {
      const v = await bundleView(pool, b);
      let availability = 'available';
      if (b.status === 'paused') availability = 'paused';
      else if (b.sale_starts_at && new Date(b.sale_starts_at) > now) availability = 'not_started';
      else if (b.sale_ends_at && new Date(b.sale_ends_at) < now) availability = 'ended';
      else if (v.left === 0) availability = 'sold_out';
      else if (v.left != null && v.left <= 10) availability = 'low';
      out.push({ id: v.id, kind: v.kind, name: v.name, description: v.description, perks: v.perks, price_minor: v.price_minor, currency: v.currency, list_minor: v.list_minor, saving_minor: v.saving_minor,
        per_order_limit: v.per_order_limit, items: v.items.map((x) => ({ name: x.name, qty: x.qty, type: x.type })), availability });
    }
    return { items: out };
  },
});

// ---- box office: tills and walk-up sales ---------------------------------------------------------------------------------------------------------------
cap({
  name: 'open_ticket_till', method: 'POST', path: '/events/:id/box-office/tills', tag: TAG, status: 201,
  summary: 'Box office: open your till for the event (one open till per operator). Record the opening float; every walk-up sale and desk refund is then recorded against it, and the cash-up at the end compares counted cash with what the till should hold.',
  input: z.object({ id, currency, opening_float_minor: money.default(0), label: z.string().trim().min(2).max(60).optional(), access_point_id: id.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const ev = await operatorOf(user, i.id, c);
    if (i.access_point_id && !(await c.query("SELECT 1 FROM access_points WHERE id=$1 AND event_id=$2 AND status='active'", [i.access_point_id, ev.id])).rowCount) throw badRequest('That gate does not belong to this event');
    if (await openTillOf(c, ev.id, user.id)) throw conflict('You already have a till open for this event', { code: 'till_open' });
    const t = (await c.query('INSERT INTO ticket_tills(event_id, operator_id, access_point_id, label, currency, opening_float_minor) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [ev.id, user.id, i.access_point_id ?? null, i.label ?? null, i.currency, i.opening_float_minor])).rows[0];
    await audit(c, user.id, 'ticket.till.open', 'ticket_tills', t.id);
    return tillView(c, t);
  }),
});

cap({
  name: 'get_my_ticket_till', method: 'GET', path: '/events/:id/box-office/tills/mine', tag: TAG,
  summary: 'Box office: your open till for the event with its running totals by tender method and the cash it should hold (null when you have none open).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ev = await operatorOf(user, i.id);
    const t = await openTillOf(pool, ev.id, user.id);
    return { till: t ? await tillView(pool, t) : null };
  },
});

cap({
  name: 'close_ticket_till', method: 'POST', path: '/ticket-tills/:id/close', tag: TAG,
  summary: 'Box office: cash up and close your till. Give the cash counted; the server compares it with the float plus cash sales less cash refunds and records the variance (over or short). A note is required when it does not match. A closed till is never edited.',
  input: z.object({ id, counted_cash_minor: money, note: z.string().trim().min(3).max(300).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const t0 = (await c.query('SELECT * FROM ticket_tills WHERE id=$1', [i.id])).rows[0];
    if (!t0) throw notFound('Till');
    const ev = await operatorOf(user, t0.event_id, c);
    await lockEvent(c, ev.id);
    const t = (await c.query('SELECT * FROM ticket_tills WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    const isOrg = (await organiserOf(user, ev.id, c).then(() => true, () => false));
    if (t.operator_id !== user.id && !isOrg) throw notFound('Till');
    const closed = await closeTill(c, user, t, i);
    await audit(c, user.id, 'ticket.till.close', 'ticket_tills', t.id);
    return tillView(c, closed);
  }),
});

cap({
  name: 'list_ticket_tills', method: 'GET', path: '/events/:id/box-office/tills', tag: TAG,
  summary: 'Organiser: every till of the event, open and closed, with totals by tender method, expected and counted cash and the variance.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const ev = await organiserOf(user, i.id);
    const rows = await many('SELECT t.*, u.display_name AS operator FROM ticket_tills t JOIN users u ON u.id=t.operator_id WHERE t.event_id=$1 ORDER BY t.opened_at DESC LIMIT $2 OFFSET $3', [ev.id, i.limit, i.offset]);
    const total = n((await pool.query('SELECT count(*)::int AS n FROM ticket_tills WHERE event_id=$1', [ev.id])).rows[0].n);
    return { items: await Promise.all(rows.map(async (t) => ({ ...(await tillView(pool, t)), operator: t.operator }))), total, limit: i.limit, offset: i.offset };
  },
});

const tender = z.object({ method: z.enum(TENDER_METHODS), amount_minor: z.number().int().min(1).max(100_000_000), tendered_minor: z.number().int().min(1).max(100_000_000).optional().describe('cash handed over; the change is amount less this'), reference: z.string().trim().min(2).max(60).optional() });
cap({
  name: 'box_office_sale', method: 'POST', path: '/events/:id/box-office/sales', tag: TAG, status: 201,
  summary: 'Box office: sell tickets, bundles and add-ons to a walk-up buyer and take payment at the desk. An ordinary order on the box_office channel (same stock, seats, capacity, promo and bundle rules as online), paid by tenders that must add up to the total exactly: cash (with change), card terminal, UPI or voucher (a slip / reference is required). Issued and posted to the finance ledger as receipts in one step; nothing is kept if any part fails. A free sale needs no tender. The buyer may leave a name (and email) to receive the tickets later by claim code, and may agree to be contacted. Needs an open till.',
  input: z.object({
    id, idempotency_key: z.string().trim().min(8).max(80).optional(),
    lines: z.array(z.object({ product_id: id, quantity: z.number().int().min(1).max(100), seats: z.array(z.string().trim().min(2).max(6)).max(100).optional() })).max(10).default([]),
    bundles: z.array(z.object({ bundle_id: id, quantity: z.number().int().min(1).max(100) })).max(5).optional(),
    addons: z.array(z.object({ addon_id: id, quantity: z.number().int().min(1).max(100) })).max(10).optional(),
    promo_codes: z.array(z.string().trim().min(2).max(40)).max(5).optional(),
    buyer: z.object({ name: z.string().trim().min(2).max(80), email: z.string().trim().email().max(160).optional(), marketing_opt_in: z.boolean().default(false) }).optional(),
    tenders: z.array(tender).max(4).default([]),
  }).refine((v) => v.lines.length + (v.bundles?.length ?? 0) > 0, 'Choose at least one ticket or package'),
  handler: ({ user }, i) => tx(async (c) => {
    const ev = await operatorOf(user, i.id, c);
    const till = await openTillOf(c, ev.id, user.id);
    if (!till) throw conflict('Open your till first', { code: 'till_closed' });
    const out = await boxOfficeSale(c, user, ev, till, i);
    if (!out.replayed) await audit(c, user.id, 'ticket.boxoffice.sale', 'ticket_orders', out.order_id);
    return out;
  }),
});

cap({
  name: 'box_office_refund', method: 'POST', path: '/events/:id/box-office/refunds', tag: TAG,
  summary: 'Box office: pay a walk-up buyer back at the desk for a ticket sold at the box office, found by its serial or short code (also completes a refund left waiting after an event or match cancellation). The refund is what that ticket actually cost (promo and bundle savings never come back), is recorded as a refund tender against your till (cash needs an open till) and on the finance ledger, and only then does the ticket become refunded. A ticket that has been used cannot be refunded.',
  input: z.object({ id, code: z.string().trim().min(4).max(40), method: z.enum(TENDER_METHODS).optional(), reason: z.string().trim().min(3).max(300) }),
  handler: ({ user }, i) => tx(async (c) => {
    const ev = await operatorOf(user, i.id, c);
    const code = i.code.toUpperCase();
    const t = (await c.query("SELECT id FROM tickets WHERE event_id=$1 AND (serial=$2 OR short_code=$2) ORDER BY (status IN ('issued','refund_due')) DESC, created_at DESC LIMIT 1", [ev.id, code])).rows[0];
    if (!t) throw notFound('Ticket');
    const out = await refundAtDesk(c, user, ev, t.id, i);
    await audit(c, user.id, 'ticket.boxoffice.refund', 'tickets', t.id);
    return out;
  }),
});

// ---- scanner sessions and reconciliation ---------------------------------------------------------------------------------------------------------------
cap({
  name: 'open_scan_session', method: 'POST', path: '/events/:id/tickets/scan-sessions', tag: TAG, status: 201,
  summary: 'Gate: start a scanner session (one device shift at a gate). Send its id with every scan and every offline replay so the organiser can reconcile what the device scanned against what the server received. Download the offline manifest with this session_id so the manifest time is recorded.',
  input: z.object({ id, device_label: z.string().trim().min(2).max(60), access_point_id: id.optional(), fixture_id: id.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const ev = await operatorOf(user, i.id, c);
    if (i.access_point_id && !(await c.query("SELECT 1 FROM access_points WHERE id=$1 AND event_id=$2 AND status='active'", [i.access_point_id, ev.id])).rowCount) throw badRequest('That gate does not belong to this event');
    if (i.fixture_id && !(await c.query('SELECT 1 FROM fixtures WHERE id=$1 AND event_id=$2', [i.fixture_id, ev.id])).rowCount) throw badRequest('That fixture does not belong to this event');
    const s = (await c.query('INSERT INTO ticket_scan_sessions(event_id, operator_id, device_label, access_point_id, fixture_id) VALUES ($1,$2,$3,$4,$5) RETURNING *', [ev.id, user.id, i.device_label, i.access_point_id ?? null, i.fixture_id ?? null])).rows[0];
    return s;
  }),
});

cap({
  name: 'close_scan_session', method: 'POST', path: '/ticket-scan-sessions/:id/close', tag: TAG,
  summary: 'Gate: end a scanner session and report how many scans the device made (reported_scans, including any still queued offline) and how many it admitted. Scans can still be replayed after closing; any gap between what the device reported and what reached the server is shown in the reconciliation until it is synced.',
  input: z.object({ id, reported_scans: z.number().int().min(0).max(1_000_000), reported_admitted: z.number().int().min(0).max(1_000_000).optional(), note: z.string().trim().max(300).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const s0 = (await c.query('SELECT event_id FROM ticket_scan_sessions WHERE id=$1', [i.id])).rows[0];
    if (!s0) throw notFound('Scan session');
    const ev = await operatorOf(user, s0.event_id, c);
    const s = await sessionFor(c, ev, user, i.id);
    if (s.status === 'closed') return s;
    return (await c.query("UPDATE ticket_scan_sessions SET status='closed', ended_at=now(), reported_scans=$2, reported_admitted=$3, close_note=$4 WHERE id=$1 RETURNING *", [s.id, i.reported_scans, i.reported_admitted ?? null, i.note ?? null])).rows[0];
  }),
});

cap({
  name: 'ticket_reconciliation', method: 'GET', path: '/events/:id/tickets/reconciliation', tag: TAG,
  summary: 'Organiser: reconcile the gates. Per scanner session: scans received, admitted, duplicates, refused, offline replays, and the gap against what the device reported; tickets flagged by more than one device; and the totals issued, attended and no-show. It says whether the event is ready to sign off and what blocks it.',
  input: z.object({ id, fixture_id: id.optional() }),
  async handler({ user }, i) { const ev = await organiserOf(user, i.id); return reconciliation(pool, ev, i.fixture_id); },
});

cap({
  name: 'sign_ticket_reconciliation', method: 'POST', path: '/events/:id/tickets/reconciliation', tag: TAG, status: 201,
  summary: 'Organiser: sign off the reconciliation. Stores an immutable snapshot of sold, issued, attended, no-show and the gate sessions as they stand. Refused while a scanner session is open or scans reported by a device are missing, unless accept_gaps is set with a note.',
  input: z.object({ id, fixture_id: id.optional(), note: z.string().trim().min(3).max(300).optional(), accept_gaps: z.boolean().default(false) }),
  handler: ({ user }, i) => tx(async (c) => {
    const ev = await organiserOf(user, i.id, c);
    await lockEvent(c, ev.id);
    const r = await reconciliation(c, ev, i.fixture_id);
    if (!r.ready_to_sign && !(i.accept_gaps && i.note)) throw conflict(`Not ready to sign: ${r.blockers.join('; ')}. Sync the devices, or accept the gaps with a note.`, { code: 'not_ready', blockers: r.blockers });
    const { signed, ...snapshot } = r;
    const row = (await c.query('INSERT INTO ticket_reconciliations(event_id, fixture_id, signed_by, note, snapshot) VALUES ($1,$2,$3,$4,$5) RETURNING id, signed_at', [ev.id, i.fixture_id ?? null, user.id, i.note ?? null, JSON.stringify({ ...snapshot, accepted_gaps: !r.ready_to_sign })])).rows[0];
    await audit(c, user.id, 'ticket.reconciliation.sign', 'ticket_reconciliations', row.id);
    return { id: row.id, signed_at: row.signed_at, totals: r.totals, accepted_gaps: !r.ready_to_sign };
  }),
});

// ---- seating-chart hook ------------------------------------------------------------------------------------------------------------------------------
cap({
  name: 'sync_seating_chart', method: 'POST', path: '/events/:id/ticket-sections/sync', tag: TAG,
  summary: 'Organiser: the hook for an external seating-chart designer. Send the chart as sections (external_ref, name, rows, seats per row, optional price point and colour); sections are created or updated by (provider, external_ref), so the call can be repeated safely. A section that already has tickets keeps its size (only name, price point and colour change). Nothing is deleted; sections missing from the payload are reported, not removed. Seat availability for the provider is the public seat map.',
  input: z.object({ id, provider: z.string().trim().min(2).max(40), sections: z.array(z.object({
    external_ref: z.string().trim().min(1).max(120), name: z.string().trim().min(1).max(60), rows_count: z.number().int().min(1).max(100), seats_per_row: z.number().int().min(1).max(200),
    price_point: z.enum(PRICE_POINTS).optional(), colour: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional() })).min(1).max(200) }),
  handler: ({ user }, i) => tx(async (c) => {
    const ev = await organiserOf(user, i.id, c);
    await lockEvent(c, ev.id);
    const created = [], updated = [], locked = [];
    for (const s of i.sections) {
      const have = (await c.query('SELECT * FROM ticket_sections WHERE event_id=$1 AND external_provider=$2 AND external_ref=$3 AND archived_at IS NULL', [ev.id, i.provider, s.external_ref])).rows[0];
      const colour = s.colour?.toUpperCase() ?? (s.price_point ? POINT_COLOUR[s.price_point] : null);
      try {
        if (!have) {
          const row = (await c.query('INSERT INTO ticket_sections(event_id, name, rows_count, seats_per_row, price_point, colour, external_provider, external_ref, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id', [ev.id, s.name, s.rows_count, s.seats_per_row, s.price_point ?? null, colour, i.provider, s.external_ref, user.id])).rows[0];
          created.push({ external_ref: s.external_ref, id: row.id });
        } else {
          const sold = n((await c.query("SELECT count(*)::int AS n FROM tickets WHERE section_id=$1 AND status IN ('reserved','issued','refund_due')", [have.id])).rows[0].n);
          const resize = !sold && (have.rows_count !== s.rows_count || have.seats_per_row !== s.seats_per_row);
          if (sold && (have.rows_count !== s.rows_count || have.seats_per_row !== s.seats_per_row)) locked.push({ external_ref: s.external_ref, id: have.id, reason: 'size not changed: tickets exist' });
          await c.query('UPDATE ticket_sections SET name=$2, price_point=coalesce($3, price_point), colour=coalesce($4, colour), rows_count=CASE WHEN $5 THEN $6 ELSE rows_count END, seats_per_row=CASE WHEN $5 THEN $7 ELSE seats_per_row END WHERE id=$1',
            [have.id, s.name, s.price_point ?? null, colour, resize, s.rows_count, s.seats_per_row]);
          updated.push({ external_ref: s.external_ref, id: have.id });
        }
      } catch (e) { if (e.code === '23505') throw conflict(`A section named ${s.name} already exists`); throw e; }
    }
    const sent = new Set(i.sections.map((s) => s.external_ref));
    const missing = (await c.query("SELECT id, name, external_ref FROM ticket_sections WHERE event_id=$1 AND external_provider=$2 AND archived_at IS NULL", [ev.id, i.provider])).rows.filter((r) => !sent.has(r.external_ref));
    await audit(c, user.id, 'ticket.seating.sync', 'events', ev.id);
    return { provider: i.provider, created, updated, size_locked: locked, not_in_payload: missing };
  }),
});

// ---- fan segments --------------------------------------------------------------------------------------------------------------------------------------
cap({
  name: 'list_ticket_fans', method: 'GET', path: '/events/:id/tickets/fans', tag: TAG,
  summary: 'Organiser: the fans behind the tickets of the event (CRM view): tickets held, attended and not attended, spend per currency, whether new or returning to this organiser, pass / VIP holders, no-shows, and whether they have agreed to be contacted. Segments: new, returning, pass_holder, vip, no_show; guests are counted, not listed. No email, phone or date of birth is returned (contact goes through communications, which honours consent) and young people are never listed. Reads are audit-logged.',
  input: z.object({ id, segment: z.enum(SEGMENTS).optional(), q: z.string().trim().max(60).optional(), ...page }),
  handler: ({ user }, i) => tx(async (c) => {
    const ev = await organiserOf(user, i.id, c);
    await audit(c, user.id, 'ticket.fans.read', 'events', ev.id);
    return fans(c, ev, { segment: i.segment, q: i.q, limit: i.limit, offset: i.offset });
  }),
});

// ---- box office catalogue ------------------------------------------------------------------------------------------------------------------------------
cap({
  name: 'box_office_catalogue', method: 'GET', path: '/events/:id/box-office/catalogue', tag: TAG,
  summary: 'Box office: what the desk can sell right now: tickets, packages and add-ons on the box_office channel with price, tax and how many are left. For gate staff who are not organisers (the organiser list is not open to them).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ev = await operatorOf(user, i.id);
    const { remainingOf } = await import('../ticketing.js');
    const products = [];
    for (const p of await many("SELECT * FROM ticket_products WHERE event_id=$1 AND status='active' AND 'box_office' = ANY(channels) ORDER BY price_minor, name", [ev.id])) {
      const price = priced(p);
      products.push({ id: p.id, name: p.name, class: p.class, class_label: p.class_label, kind: p.kind, seating: p.seating, price_minor: price.gross, currency: p.currency, left: await remainingOf(pool, ev, p) });
    }
    const bundles = (await many("SELECT * FROM ticket_bundles WHERE event_id=$1 AND status='active' AND 'box_office' = ANY(channels) ORDER BY price_minor", [ev.id]));
    const addons = (await many("SELECT * FROM ticket_addons WHERE event_id=$1 AND status='active' ORDER BY name", [ev.id])).map((a) => ({ id: a.id, name: a.name, kind: a.kind, price_minor: priced(a).gross, currency: a.currency }));
    return { currency: products[0]?.currency ?? bundles[0]?.currency ?? addons[0]?.currency ?? null, products, bundles: await Promise.all(bundles.map((b) => bundleView(pool, b))), addons };
  },
});
