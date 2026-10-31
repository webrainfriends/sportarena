// Spectator ticketing and gate management (#480): ticket products and inventory, orders and issuance through canonical payments, QR admission,
// capacity, transfer, refund, complimentary allocations, passes and reporting. Separate from participant registration (event_entries) and venue
// booking; all rules live in src/ticketing.js and are shared by REST, OpenAPI and MCP. The UI only calls these capabilities.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { pool, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { encrypt, decrypt } from '../crypto.js';
import { isYouth } from '../youth.js';
import { isOrganiser } from './event-departments.js';
import { isGateOperator } from '../accreditation.js';
import { loadViewableEvent } from '../spectator.js';
import {
  CLASSES, CHANNELS, ENTRY_BEFORE_MIN, ENTRY_AFTER_MIN, OFFLINE_MAX_AGE_H,
  claimHash, createOrder, fixturesFor, loadTicket, lockEvent, newClaimCode, processTicketRefunds, record, refundDueFor, refundRule, releaseOrder, remainingOf, scanOne, sectionSeats,
  settingsOf, settleRefund, succeed, ticketView, transferRule, priced,
} from '../ticketing.js';

const TAG = 'Spectator ticketing';
const when = z.string().datetime({ offset: true });
const money = z.coerce.number().int().min(0).max(100_000_000);
const currency = z.string().regex(/^[A-Z]{3}$/, 'use a 3-letter currency code');
const reason = z.string().trim().min(3).max(300);
const guest = z.object({ name: z.string().trim().min(2).max(80), email: z.string().trim().email().max(160).optional() });

const eventOf = async (eventId, c = pool) => {
  const ev = (await c.query('SELECT * FROM events WHERE id=$1', [eventId])).rows[0];
  if (!ev) throw notFound('Event');
  return ev;
};
/** The organiser of the event, or 404 (nothing about the event's ticketing is revealed to anyone else). */
async function organiserOf(user, eventId, c = pool) {
  const ev = await eventOf(eventId, c);
  if (!(await isOrganiser(user, ev, c))) throw notFound('Event');
  return ev;
}
async function operatorOf(user, eventId, c = pool) {
  const ev = await eventOf(eventId, c);
  if (!(await isGateOperator(user, ev, c))) throw notFound('Event');
  return ev;
}
const accessPointsOf = async (c, eventId, ids) => {
  if (!ids?.length) return;
  const ok = (await c.query("SELECT count(*)::int AS n FROM access_points WHERE event_id=$1 AND status='active' AND id = ANY($2::uuid[])", [eventId, ids])).rows[0].n;
  if (ok !== new Set(ids).size) throw badRequest('A gate does not belong to this event');
};
const fixturesOk = async (c, eventId, ids) => {
  if (!ids?.length) return;
  const ok = (await c.query('SELECT count(*)::int AS n FROM fixtures WHERE event_id=$1 AND id = ANY($2::uuid[])', [eventId, ids])).rows[0].n;
  if (ok !== new Set(ids).size) throw badRequest('A fixture does not belong to this event');
};

/** What a visitor may know about a product: what it is, the price, when it is on sale and a coarse availability. Never counts of who bought. */
async function publicProduct(c, ev, p, now = new Date()) {
  const remaining = await remainingOf(c, ev, p);
  let availability = 'available';
  if (p.status === 'paused') availability = 'paused';
  else if (p.sale_starts_at && new Date(p.sale_starts_at) > now) availability = 'not_started';
  else if (p.sale_ends_at && new Date(p.sale_ends_at) < now) availability = 'ended';
  else if (remaining === 0) availability = 'sold_out';
  else if (remaining != null && remaining <= 20) availability = 'low';
  const price = priced(p);
  return {
    id: p.id, kind: p.kind, name: p.name, description: p.description, class: p.class, class_label: p.class_label, seating: p.seating, section_id: p.section_id,
    price_minor: price.gross, tax_minor: price.tax, tax_inclusive: p.tax_inclusive, currency: p.currency, sale_starts_at: p.sale_starts_at, sale_ends_at: p.sale_ends_at,
    per_order_limit: p.per_order_limit, transferable: p.transferable, reentry: p.reentry, availability, remaining: availability === 'low' ? remaining : null,
    fixtures: await fixturesFor(c, ev.id, p.id),
  };
}
const SELLABLE = "p.status IN ('active','paused') AND 'online' = ANY(p.channels)";

// ---- settings, sections, limits -------------------------------------------------------------------------------------------------------------------

cap({
  name: 'get_ticket_settings', method: 'GET', path: '/events/:id/tickets/settings', tag: TAG,
  summary: 'Organiser: the spectator ticketing rules of an event: spectator and safety capacity, whether participants and accredited people count towards safety capacity, hold time, transfer and refund policy.',
  input: z.object({ id }),
  async handler({ user }, i) { const ev = await organiserOf(user, i.id); return { ...(await settingsOf(pool, ev.id)), fixture_limits: await many('SELECT fixture_id, spectator_capacity, safety_capacity FROM ticket_fixture_limits WHERE event_id=$1', [ev.id]) }; },
});

cap({
  name: 'update_ticket_settings', method: 'PATCH', path: '/events/:id/tickets/settings', tag: TAG,
  summary: 'Organiser: set capacity (per fixture, or for the event when it has none), safety capacity and what counts towards it, pause or open sales, hold minutes, transfer and refund policy. A fixture can have its own limits.',
  input: z.object({
    id, spectator_capacity: z.number().int().min(0).max(1_000_000).nullable().optional(), safety_capacity: z.number().int().min(0).max(1_000_000).nullable().optional(),
    count_participants: z.boolean().optional(), count_accreditations: z.boolean().optional(), sales_open: z.boolean().optional(), hold_minutes: z.number().int().min(5).max(120).optional(),
    transfer_allowed: z.boolean().optional(), transfer_cutoff_hours: z.number().int().min(0).max(720).optional(),
    refund_policy: z.enum(['anytime', 'until_cutoff', 'never']).optional(), refund_cutoff_hours: z.number().int().min(0).max(720).optional(),
    fixture_limits: z.array(z.object({ fixture_id: id, spectator_capacity: z.number().int().min(0).max(1_000_000).nullable(), safety_capacity: z.number().int().min(0).max(1_000_000).nullable() })).max(500).optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const ev = await organiserOf(user, i.id, c);
    await lockEvent(c, ev.id);
    const cur = await settingsOf(c, ev.id);
    const next = { ...cur, ...Object.fromEntries(Object.entries(i).filter(([k, v]) => k !== 'id' && k !== 'fixture_limits' && v !== undefined)) };
    if (next.safety_capacity != null && next.spectator_capacity != null && next.safety_capacity < next.spectator_capacity) throw badRequest('Safety capacity cannot be lower than spectator capacity');
    await c.query(
      `INSERT INTO ticket_settings(event_id, spectator_capacity, safety_capacity, count_participants, count_accreditations, sales_open, hold_minutes, transfer_allowed, transfer_cutoff_hours, refund_policy, refund_cutoff_hours, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
       ON CONFLICT (event_id) DO UPDATE SET spectator_capacity=$2, safety_capacity=$3, count_participants=$4, count_accreditations=$5, sales_open=$6, hold_minutes=$7, transfer_allowed=$8, transfer_cutoff_hours=$9, refund_policy=$10, refund_cutoff_hours=$11, updated_by=$12, updated_at=now()`,
      [ev.id, next.spectator_capacity, next.safety_capacity, next.count_participants, next.count_accreditations, next.sales_open, next.hold_minutes, next.transfer_allowed, next.transfer_cutoff_hours, next.refund_policy, next.refund_cutoff_hours, user.id]);
    if (i.fixture_limits) {
      await fixturesOk(c, ev.id, i.fixture_limits.map((f) => f.fixture_id));
      for (const f of i.fixture_limits) {
        await c.query(`INSERT INTO ticket_fixture_limits(fixture_id, event_id, spectator_capacity, safety_capacity) VALUES ($1,$2,$3,$4) ON CONFLICT (fixture_id) DO UPDATE SET spectator_capacity=$3, safety_capacity=$4`, [f.fixture_id, ev.id, f.spectator_capacity, f.safety_capacity]);
      }
    }
    return { ...(await settingsOf(c, ev.id)), fixture_limits: (await c.query('SELECT fixture_id, spectator_capacity, safety_capacity FROM ticket_fixture_limits WHERE event_id=$1', [ev.id])).rows };
  }),
});

cap({
  name: 'create_ticket_section', method: 'POST', path: '/events/:id/ticket-sections', tag: TAG, status: 201,
  summary: 'Organiser: define a seating section (rows by seats per row, seats are A1, A2 ... B1 ...). Products with reserved seating sell seats from one section.',
  input: z.object({ id, name: z.string().trim().min(1).max(60), rows_count: z.number().int().min(1).max(100), seats_per_row: z.number().int().min(1).max(200) }),
  handler: ({ user }, i) => tx(async (c) => {
    const ev = await organiserOf(user, i.id, c);
    try { return (await c.query('INSERT INTO ticket_sections(event_id, name, rows_count, seats_per_row, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [ev.id, i.name, i.rows_count, i.seats_per_row, user.id])).rows[0]; }
    catch (e) { if (e.code === '23505') throw conflict('A section with that name already exists'); throw e; }
  }),
});

cap({
  name: 'list_ticket_sections', method: 'GET', path: '/events/:id/ticket-sections', tag: TAG,
  summary: 'Organiser: the seating sections of the event and how many seats each has.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ev = await organiserOf(user, i.id);
    return (await many('SELECT * FROM ticket_sections WHERE event_id=$1 AND archived_at IS NULL ORDER BY name', [ev.id])).map((s) => ({ ...s, seats: sectionSeats(s) }));
  },
});

// ---- products -----------------------------------------------------------------------------------------------------------------------------------------

const productFields = {
  name: z.string().trim().min(2).max(80), description: z.string().trim().max(400).nullable(), class: z.enum(CLASSES), class_label: z.string().trim().max(40).nullable(),
  seating: z.enum(['general', 'reserved']), section_id: id.nullable(), price_minor: money, currency, tax_bp: z.number().int().min(0).max(10000), tax_inclusive: z.boolean(),
  sale_starts_at: when.nullable(), sale_ends_at: when.nullable(), allocation: z.number().int().min(0).max(1_000_000).nullable(),
  per_order_limit: z.number().int().min(1).max(100), per_account_limit: z.number().int().min(1).max(1000), channels: z.array(z.enum(CHANNELS)).min(1).max(CHANNELS.length),
  transferable: z.boolean(), reentry: z.enum(['single', 'reentry']), access_point_ids: z.array(id).max(50), fixture_ids: z.array(id).max(500),
};
async function checkProduct(c, ev, p, { fixtureIds }) {
  if (p.seating === 'reserved') {
    if (!p.section_id) throw badRequest('Reserved seating needs a section');
    const s = (await c.query('SELECT 1 FROM ticket_sections WHERE id=$1 AND event_id=$2 AND archived_at IS NULL', [p.section_id, ev.id])).rowCount;
    if (!s) throw badRequest('That section does not belong to this event');
  }
  if (p.class === 'complimentary' && (Number(p.price_minor) !== 0 || p.channels.some((x) => x !== 'complimentary'))) throw badRequest('A complimentary ticket is free and is only issued by the organiser');
  if (p.channels.includes('complimentary') && Number(p.price_minor) !== 0) throw badRequest('Only free tickets can be issued as complimentary');
  if (p.kind === 'pass' && p.seating === 'reserved') throw badRequest('A pass admits to several fixtures and cannot reserve one seat');
  if (p.kind === 'pass' && (fixtureIds ?? []).length < 2) throw badRequest('A pass covers at least two fixtures');
  await accessPointsOf(c, ev.id, p.access_point_ids);
  await fixturesOk(c, ev.id, fixtureIds);
}
const setFixtures = async (c, productId, ids) => {
  await c.query('DELETE FROM ticket_product_fixtures WHERE product_id=$1', [productId]);   // a link table of a product definition, not user data
  for (const f of new Set(ids)) await c.query('INSERT INTO ticket_product_fixtures(product_id, fixture_id) VALUES ($1,$2)', [productId, f]);
};

cap({
  name: 'create_ticket_product', method: 'POST', path: '/events/:id/ticket-products', tag: TAG, status: 201,
  summary: 'Organiser: create a ticket product for the event: a class (adult, youth, concession, VIP, complimentary, other), general or reserved seating, price with tax rule and currency, sale window, allocation, per-order and per-account limits, sales channels, transferability, re-entry policy and gates. Link fixtures to scope it to a match; link several and set kind "pass" for a season-style pass. Starts as a draft.',
  input: z.object({
    id, kind: z.enum(['single', 'pass']).default('single'), name: productFields.name, description: productFields.description.optional(), class: productFields.class.default('adult'), class_label: productFields.class_label.optional(),
    seating: productFields.seating.default('general'), section_id: productFields.section_id.optional(), price_minor: productFields.price_minor.default(0), currency: productFields.currency.default('GBP'),
    tax_bp: productFields.tax_bp.default(0), tax_inclusive: productFields.tax_inclusive.default(true), sale_starts_at: productFields.sale_starts_at.optional(), sale_ends_at: productFields.sale_ends_at.optional(),
    allocation: productFields.allocation.optional(), per_order_limit: productFields.per_order_limit.default(10), per_account_limit: productFields.per_account_limit.default(10),
    channels: productFields.channels.optional(), transferable: productFields.transferable.default(true), reentry: productFields.reentry.default('single'),
    access_point_ids: productFields.access_point_ids.default([]), fixture_ids: productFields.fixture_ids.default([]),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const ev = await organiserOf(user, i.id, c);
    const channels = i.channels ?? (i.class === 'complimentary' ? ['complimentary'] : ['online']);
    const p = { ...i, channels };
    await checkProduct(c, ev, p, { fixtureIds: i.fixture_ids });
    let row;
    try {
      row = (await c.query(
        `INSERT INTO ticket_products(event_id, kind, name, description, class, class_label, seating, section_id, price_minor, currency, tax_bp, tax_inclusive, sale_starts_at, sale_ends_at, allocation, per_order_limit, per_account_limit, channels, transferable, reentry, access_point_ids, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
        [ev.id, i.kind, i.name, i.description ?? null, i.class, i.class_label ?? null, i.seating, i.section_id ?? null, i.price_minor, i.currency, i.tax_bp, i.tax_inclusive, i.sale_starts_at ?? null, i.sale_ends_at ?? null, i.allocation ?? null,
          i.per_order_limit, i.per_account_limit, channels, i.transferable, i.reentry, i.access_point_ids, user.id])).rows[0];
    } catch (e) { if (e.code === '23505') throw conflict('A ticket product with that name already exists'); if (e.code === '23514') throw badRequest('Check the sale window and limits'); throw e; }
    await setFixtures(c, row.id, i.fixture_ids);
    return { ...row, fixture_ids: i.fixture_ids };
  }),
});

cap({
  name: 'update_ticket_product', method: 'PATCH', path: '/ticket-products/:id', tag: TAG,
  summary: 'Organiser: change a product, or move it between draft, active, paused and archived (archived products stay for history). Price, tax and name changes apply to future orders only: every order keeps the price it was sold at.',
  input: z.object({ id, ...Object.fromEntries(Object.entries(productFields).map(([k, v]) => [k, v.optional()])), status: z.enum(['draft', 'active', 'paused', 'archived']).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const cur = (await c.query('SELECT * FROM ticket_products WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!cur) throw notFound('Ticket product');
    const ev = await organiserOf(user, cur.event_id, c);
    await lockEvent(c, ev.id);
    const { id: _id, fixture_ids, ...patch } = i;
    const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
    const sold = (await c.query("SELECT count(*)::int AS n FROM tickets WHERE product_id=$1 AND status <> 'void'", [cur.id])).rows[0].n;
    if (sold && (i.seating && i.seating !== cur.seating || i.section_id && i.section_id !== cur.section_id || fixture_ids || (i.kind && i.kind !== cur.kind))) throw conflict('Seating, section, kind and fixtures cannot change once tickets have been sold');
    if (next.allocation != null && i.allocation !== undefined) {
      const live = (await c.query("SELECT count(*)::int AS n FROM tickets t WHERE t.product_id=$1 AND (t.status='issued' OR (t.status='reserved' AND t.hold_expires_at > now()))", [cur.id])).rows[0].n;
      if (next.allocation < live) throw conflict(`${live} tickets are already sold or held; the allocation cannot be lower`);
    }
    const fx = fixture_ids ?? (await c.query('SELECT fixture_id FROM ticket_product_fixtures WHERE product_id=$1', [cur.id])).rows.map((r) => r.fixture_id);
    await checkProduct(c, ev, next, { fixtureIds: fx });
    if (next.status === 'active' && cur.status !== 'active' && !next.channels.length) throw badRequest('Choose at least one sales channel');
    let row;
    try {
      row = (await c.query(
        `UPDATE ticket_products SET name=$2, description=$3, class=$4, class_label=$5, seating=$6, section_id=$7, price_minor=$8, currency=$9, tax_bp=$10, tax_inclusive=$11, sale_starts_at=$12, sale_ends_at=$13, allocation=$14,
                per_order_limit=$15, per_account_limit=$16, channels=$17, transferable=$18, reentry=$19, access_point_ids=$20, status=$21, kind=$22 WHERE id=$1 RETURNING *`,
        [cur.id, next.name, next.description, next.class, next.class_label, next.seating, next.section_id, next.price_minor, next.currency, next.tax_bp, next.tax_inclusive, next.sale_starts_at, next.sale_ends_at, next.allocation,
          next.per_order_limit, next.per_account_limit, next.channels, next.transferable, next.reentry, next.access_point_ids, next.status, next.kind])).rows[0];
    } catch (e) { if (e.code === '23505') throw conflict('A ticket product with that name already exists'); if (e.code === '23514') throw badRequest('Check the sale window and limits'); throw e; }
    if (fixture_ids) await setFixtures(c, cur.id, fixture_ids);
    return { ...row, fixture_ids: fx };
  }),
});

cap({
  name: 'list_ticket_products', method: 'GET', path: '/events/:id/ticket-products', tag: TAG,
  summary: 'Organiser: every ticket product of the event with what is sold, held, refunded and still available (kept apart: sold is not attended).',
  input: z.object({ id, archived: z.coerce.boolean().default(false) }),
  async handler({ user }, i) {
    const ev = await organiserOf(user, i.id);
    const rows = await many('SELECT * FROM ticket_products WHERE event_id=$1 AND ($2::boolean OR status <> \'archived\') ORDER BY created_at', [ev.id, i.archived]);
    const out = [];
    for (const p of rows) {
      const n = (await pool.query(
        `SELECT count(*) FILTER (WHERE status='issued')::int AS issued, count(*) FILTER (WHERE status='reserved' AND hold_expires_at > now())::int AS held,
                count(*) FILTER (WHERE status IN ('refund_due','refunded'))::int AS refunded FROM tickets WHERE product_id=$1`, [p.id])).rows[0];
      const fx = (await pool.query('SELECT fixture_id FROM ticket_product_fixtures WHERE product_id=$1', [p.id])).rows.map((r) => r.fixture_id);
      out.push({ ...p, fixture_ids: fx, ...n, remaining: await remainingOf(pool, ev, p) });
    }
    return out;
  },
});

cap({
  name: 'list_public_ticket_products', method: 'GET', path: '/public/events/:id/tickets', tag: TAG, auth: 'public',
  summary: 'What a visitor can buy for an event: the products on sale with price, tax, sale window, the fixtures they admit to and a coarse availability (available, low, sold out, not started, ended, paused). Never who bought.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { ev } = await loadViewableEvent(user, i.id);
    if (['cancelled'].includes(ev.status)) return { event_id: ev.id, on_sale: false, products: [] };
    const settings = await settingsOf(pool, ev.id);
    const rows = await many(`SELECT p.* FROM ticket_products p WHERE p.event_id=$1 AND ${SELLABLE} ORDER BY p.price_minor, p.created_at`, [ev.id]);
    const products = [];
    for (const p of rows) products.push(await publicProduct(pool, ev, p));
    return { event_id: ev.id, on_sale: settings.sales_open && products.some((p) => ['available', 'low'].includes(p.availability)), products };
  },
});

cap({
  name: 'get_ticket_seat_map', method: 'GET', path: '/ticket-products/:id/seats', tag: TAG, auth: 'public',
  summary: 'The seats of a reserved-seating product: the section grid and which seats are already taken. Seat labels only, never who holds them.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const p = (await pool.query(`SELECT p.* FROM ticket_products p WHERE p.id=$1 AND ${SELLABLE} AND p.seating='reserved'`, [i.id])).rows[0];
    if (!p) throw notFound('Ticket product');
    await loadViewableEvent(user, p.event_id);
    const s = (await pool.query('SELECT * FROM ticket_sections WHERE id=$1', [p.section_id])).rows[0];
    const linked = (await pool.query('SELECT fixture_id FROM ticket_product_fixtures WHERE product_id=$1', [p.id])).rows.map((r) => r.fixture_id);
    const taken = (await pool.query(
      `SELECT DISTINCT t.seat_label FROM tickets t WHERE t.section_id=$1 AND (t.status='issued' OR (t.status='reserved' AND t.hold_expires_at > now()))
         AND ($2::boolean OR NOT EXISTS (SELECT 1 FROM ticket_product_fixtures x WHERE x.product_id=t.product_id) OR EXISTS (SELECT 1 FROM ticket_product_fixtures x WHERE x.product_id=t.product_id AND x.fixture_id = ANY($3::uuid[])))`,
      [s.id, !linked.length, linked])).rows.map((r) => r.seat_label);
    return { section: { id: s.id, name: s.name, rows_count: s.rows_count, seats_per_row: s.seats_per_row }, taken };
  },
});

// ---- orders -------------------------------------------------------------------------------------------------------------------------------------------

const orderView = async (c, orderId) => {
  const o = (await c.query('SELECT o.*, e.name AS event FROM ticket_orders o JOIN events e ON e.id=o.event_id WHERE o.id=$1', [orderId])).rows[0];
  const lines = (await c.query('SELECT product_id, name, class, qty, unit_minor, unit_tax_minor, currency FROM ticket_order_lines WHERE order_id=$1 ORDER BY name', [orderId])).rows;
  const tickets = (await c.query('SELECT id, serial, status, seat_label, class FROM tickets WHERE order_id=$1 AND supersedes_id IS NULL ORDER BY created_at, id', [orderId])).rows;
  return { ...o, subtotal_minor: Number(o.subtotal_minor), tax_minor: Number(o.tax_minor), total_minor: Number(o.total_minor), lines, tickets, pay: o.status === 'pending_payment' && Number(o.total_minor) > 0 ? { purpose_type: 'ticket_order', purpose_id: o.id, amount_minor: Number(o.total_minor), currency: o.currency } : null };
};

cap({
  name: 'create_ticket_order', method: 'POST', path: '/events/:id/ticket-orders', tag: TAG, status: 201,
  summary: 'Buy tickets: choose products and quantities (and seats for reserved seating). The tickets are reserved for a short hold under a per-event lock so allocation and capacity can never be oversold; pay with POST /payments (purpose_type ticket_order) to issue them. Free orders are issued immediately. Send an idempotency_key to make a retry safe. Box-office and partner staff sell through the other channels.',
  input: z.object({
    id, channel: z.enum(['online', 'box_office', 'partner']).default('online'), idempotency_key: z.string().trim().min(8).max(80).optional(),
    lines: z.array(z.object({ product_id: id, quantity: z.number().int().min(1).max(100), seats: z.array(z.string().trim().min(2).max(6)).max(100).optional() })).min(1).max(10),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const ev = await eventOf(i.id, c);
    if (i.channel === 'online') {
      // a young person's tickets are bought by a guardian (who can then transfer them); the platform never takes a minor's payment
      if (await isYouth(user.id, c)) throw forbidden('A parent or guardian needs to buy tickets for a young person');
    } else if (i.channel === 'box_office' ? !(await isGateOperator(user, ev, c)) : !(await isOrganiser(user, ev, c))) throw notFound('Event');
    const r = await createOrder(c, user, ev, i, { channel: i.channel });
    return { ...(await orderView(c, r.order_id)), replayed: r.replayed };
  }),
});

cap({
  name: 'get_ticket_order', method: 'GET', path: '/ticket-orders/:id', tag: TAG,
  summary: 'An order: its lines at the price they were sold for, its state (pending payment, confirmed, cancelled, expired) and what to pay. Only the buyer and the organiser can see it.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const o = (await pool.query('SELECT * FROM ticket_orders WHERE id=$1', [i.id])).rows[0];
    if (!o) throw notFound('Order');
    if (o.buyer_id !== user.id && !(await isOrganiser(user, await eventOf(o.event_id), pool))) throw notFound('Order');
    return orderView(pool, o.id);
  },
});

cap({
  name: 'cancel_ticket_order', method: 'POST', path: '/ticket-orders/:id/cancel', tag: TAG,
  summary: 'Give up an order that is not paid yet; its reserved tickets are released at once. A paid order is refunded ticket by ticket (refund_ticket), never cancelled here.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const o = (await c.query('SELECT * FROM ticket_orders WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!o || o.buyer_id !== user.id) throw notFound('Order');
    if (o.status !== 'pending_payment') throw conflict(`This order is ${o.status}`);
    await releaseOrder(c, o.id, user.id, 'cancelled', 'Cancelled by the buyer');
    return orderView(c, o.id);
  }),
});

// ---- my tickets, transfer, reissue, refund ------------------------------------------------------------------------------------------------------

async function myTicket(user, ticketId, c = pool) {
  const t = (await c.query('SELECT t.*, o.buyer_id FROM tickets t JOIN ticket_orders o ON o.id=t.order_id WHERE t.id=$1', [ticketId])).rows[0];
  if (!t) throw notFound('Ticket');
  const organiser = await isOrganiser(user, await eventOf(t.event_id, c), c);
  if (t.holder_id !== user.id && t.buyer_id !== user.id && !organiser) throw notFound('Ticket');
  return { t, organiser, holder: t.holder_id === user.id };
}

cap({
  name: 'list_my_tickets', method: 'GET', path: '/me/tickets', tag: TAG,
  summary: 'The tickets I hold, with the QR token for each valid one, where to sit, what they admit to, whether I may transfer or refund, and whether they have been used. Past tickets are kept.',
  input: z.object({ scope: z.enum(['upcoming', 'past', 'all']).default('upcoming'), event_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT t.* FROM tickets t JOIN events e ON e.id=t.event_id WHERE t.holder_id=$1 AND t.status IN ('issued','reserved','refund_due','refunded') AND ($2::uuid IS NULL OR t.event_id=$2)
         AND ($3='all' OR ($3='upcoming') = (coalesce(e.ends_on, e.starts_on) >= current_date))
       ORDER BY e.starts_on, t.created_at LIMIT $4 OFFSET $5`, [user.id, i.event_id ?? null, i.scope, i.limit, i.offset]);
    const items = [];
    for (const t of rows) items.push(await ticketView(pool, t, { holder: true }));
    return { items, limit: i.limit, offset: i.offset };
  },
});

cap({
  name: 'get_ticket', method: 'GET', path: '/tickets/:id', tag: TAG,
  summary: 'One ticket. The holder gets the QR token; the buyer sees the state; the organiser sees the holder reference and, for a guest ticket, the guest\'s name (that read is audit-logged).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { t, organiser, holder } = await myTicket(user, i.id);
    const out = await ticketView(pool, t, { holder, organiser });
    if (organiser && t.guest_name_enc) {
      await audit(pool, user.id, 'ticket.guest.read', 'tickets', t.id);
      out.guest = { name: decrypt(t.guest_name_enc, 'tickets.guest_name'), email: t.guest_email_enc ? decrypt(t.guest_email_enc, 'tickets.guest_email') : null };
    }
    return out;
  },
});

cap({
  name: 'get_ticket_history', method: 'GET', path: '/tickets/:id/history', tag: TAG,
  summary: 'Organiser: the immutable lifecycle of a ticket and of its entitlement: issued, transferred, reissued, voided, refunded, with who and when. Nothing here can be edited.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const t = await loadTicket(pool, i.id);
    await organiserOf(user, t.event_id);
    return many(
      `SELECT h.id, h.ticket_id, tk.serial, h.kind, h.from_status, h.to_status, h.detail, h.at, h.actor_id FROM ticket_history h JOIN tickets tk ON tk.id=h.ticket_id
        WHERE tk.entitlement_id=$1 ORDER BY h.id`, [t.entitlement_id]);
  },
});

cap({
  name: 'transfer_ticket', method: 'POST', path: '/tickets/:id/transfer', tag: TAG,
  summary: 'Give a ticket to another account (to_user_id) or to a guest by name (the response then carries a one-time claim code to hand over). Allowed until the organiser\'s cutoff, and only if the ticket is transferable. The old ticket stops working at once; the new holder sees only the ticket, never the previous holder.',
  input: z.object({ id, to_user_id: id.optional(), guest: guest.optional() }).refine((i) => !!i.to_user_id !== !!i.guest, 'Give either to_user_id or guest'),
  handler: ({ user }, i) => tx(async (c) => {
    const t0 = await loadTicket(c, i.id);
    await lockEvent(c, t0.event_id);
    const t = await loadTicket(c, i.id, { lock: true });
    if (t.holder_id !== user.id) throw notFound('Ticket');
    const rule = await transferRule(c, t);
    if (!rule.ok) throw conflict(rule.reason, { code: 'not_transferable' });
    if (i.to_user_id) {
      if (i.to_user_id === user.id) throw badRequest('That ticket is already yours');
      if (!(await c.query('SELECT 1 FROM users WHERE id=$1', [i.to_user_id])).rowCount) throw notFound('Recipient');
    }
    const next = await succeed(c, t, user.id, { holder_id: i.to_user_id ?? null, guest: i.guest ?? null, status: 'transferred', kind: 'transferred' });
    if (i.to_user_id) {
      const ev = await eventOf(t.event_id, c);
      await notify(c, i.to_user_id, { kind: 'ticket_received', title: 'You were given a ticket', body: `A ticket for ${ev.name} is now in My tickets.`, data: { ticket: true, event_id: ev.id, ticket_id: next.ticket.id } });
    }
    return { ...(await ticketView(c, next.ticket, { holder: false })), claim_code: next.claim_code };
  }),
});

cap({
  name: 'claim_ticket', method: 'POST', path: '/tickets/claim', tag: TAG,
  summary: 'Take a ticket that was given to a guest into my account, using the claim code. The guest ticket stops working and a new ticket under my name replaces it.',
  input: z.object({ code: z.string().trim().min(8).max(24) }),
  handler: ({ user }, i) => tx(async (c) => {
    const found = (await c.query("SELECT * FROM tickets WHERE claim_hash=$1 AND status='issued'", [claimHash(i.code)])).rows[0];
    if (!found) throw notFound('Ticket');
    await lockEvent(c, found.event_id);
    const t = await loadTicket(c, found.id, { lock: true });
    if (t.status !== 'issued') throw notFound('Ticket');
    const next = await succeed(c, t, user.id, { holder_id: user.id, status: 'transferred', kind: 'claimed' });
    return ticketView(c, next.ticket, { holder: true });
  }),
});

cap({
  name: 'reissue_ticket', method: 'POST', path: '/tickets/:id/reissue', tag: TAG,
  summary: 'Get a new QR code for a ticket (a lost or shared phone). The old code stops working on the next scan; it is still one ticket, so it can only ever admit once.',
  input: z.object({ id, token_version: z.number().int().min(1).optional().describe('the version being replaced; guards against two devices reissuing at once') }),
  handler: ({ user }, i) => tx(async (c) => {
    const { t: t0, organiser, holder } = await myTicket(user, i.id, c);
    if (!holder && !organiser) throw forbidden('Only the holder can reissue this ticket');
    const t = await loadTicket(c, t0.id, { lock: true });
    if (t.status !== 'issued') throw conflict('This ticket is not active');
    if (i.token_version && i.token_version !== t.token_version) throw conflict('This ticket was already reissued', { code: 'stale_version' });
    const row = (await c.query('UPDATE tickets SET token_version=token_version+1 WHERE id=$1 RETURNING *', [t.id])).rows[0];
    await record(c, t.id, user.id, 'reissued', 'issued', 'issued', { token_version: row.token_version });
    return ticketView(c, row, { holder: holder, organiser });
  }),
});

cap({
  name: 'refund_ticket', method: 'POST', path: '/tickets/:id/refund', tag: TAG,
  summary: 'Refund a ticket through the original payment. The buyer can while the organiser\'s refund policy allows it (or when the match was moved or cancelled); the organiser always can. The ticket stops admitting at once and becomes refunded only after the payment has actually been refunded; until then it shows as waiting for refund.',
  input: z.object({ id, reason: reason.optional() }),
  async handler({ user }, i) {
    const out = await tx(async (c) => {
      const { t: t0, organiser } = await myTicket(user, i.id, c);
      await lockEvent(c, t0.event_id);
      const t = await loadTicket(c, t0.id, { lock: true });
      if (!organiser && !(t.holder_id === user.id && t0.buyer_id === user.id)) throw forbidden('Only the person who bought this ticket can refund it');
      if (organiser && !i.reason) throw badRequest('Give a reason');
      const rule = await refundRule(c, t, { organiser });
      if (!rule.ok) throw conflict(rule.reason, { code: 'not_refundable' });
      await refundDueFor(c, 't.id=$1', [t.id], i.reason ?? 'Refund requested by the buyer', user.id, 'refund_requested');
      return t.id;
    });
    return { ...(await settleRefund(out)), ticket_id: out };
  },
});

cap({
  name: 'void_ticket', method: 'POST', path: '/tickets/:id/void', tag: TAG,
  summary: 'Organiser: void a ticket (fraud, wrong person), optionally replacing it with a fresh one for the same entitlement. A replacement keeps the same entitlement, so even a ticket that was already used cannot admit a second time. Voiding does not refund; use refund_ticket for that.',
  input: z.object({ id, reason, replace: z.boolean().default(false) }),
  handler: ({ user }, i) => tx(async (c) => {
    const t0 = await loadTicket(c, i.id);
    const ev = await organiserOf(user, t0.event_id, c);
    await lockEvent(c, ev.id);
    const t = await loadTicket(c, i.id, { lock: true });
    if (t.status !== 'issued') throw conflict('This ticket is not active');
    if (i.replace) {
      const next = await succeed(c, t, user.id, { holder_id: t.holder_id, status: 'void', reason: i.reason, kind: 'replaced' });
      return ticketView(c, next.ticket, { organiser: true });
    }
    await c.query("UPDATE tickets SET status='void', ended_at=now(), end_reason=$2 WHERE id=$1", [t.id, i.reason]);
    await record(c, t.id, user.id, 'voided', 'issued', 'void', { reason: i.reason });
    return ticketView(c, { ...t, status: 'void' }, { organiser: true });
  }),
});

cap({
  name: 'process_ticket_refunds', method: 'POST', path: '/events/:id/tickets/refunds/process', tag: TAG,
  summary: 'Organiser: retry every refund still waiting for its payment refund (after an event or match cancellation, or a provider hiccup). Safe to repeat: each refund is idempotent at the provider.',
  input: z.object({ id }),
  async handler({ user }, i) { const ev = await organiserOf(user, i.id); return processTicketRefunds({ eventId: ev.id }); },
});

// ---- complimentary and sponsor allocations ----------------------------------------------------------------------------------------------------

cap({
  name: 'create_ticket_allocation', method: 'POST', path: '/events/:id/ticket-allocations', tag: TAG, status: 201,
  summary: 'Organiser: set aside a number of free tickets of a complimentary-enabled product for a sponsor, team, VIPs, media or a partner, with a reason. Issuing from it creates real tickets that count towards capacity and are scanned like any other.',
  input: z.object({ id, product_id: id, kind: z.enum(['sponsor', 'team', 'vip', 'partner', 'media', 'other']), label: z.string().trim().min(2).max(80), team_id: id.optional(), quota: z.number().int().min(1).max(100000), reason }),
  handler: ({ user }, i) => tx(async (c) => {
    const ev = await organiserOf(user, i.id, c);
    const p = (await c.query('SELECT * FROM ticket_products WHERE id=$1 AND event_id=$2', [i.product_id, ev.id])).rows[0];
    if (!p) throw notFound('Ticket product');
    if (!p.channels.includes('complimentary') || Number(p.price_minor) !== 0) throw badRequest('Choose a free product that is enabled for complimentary issue');
    if (i.team_id && !(await c.query('SELECT 1 FROM teams WHERE id=$1', [i.team_id])).rowCount) throw notFound('Team');
    return (await c.query('INSERT INTO ticket_allocations(event_id, product_id, kind, label, team_id, quota, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [ev.id, p.id, i.kind, i.label, i.team_id ?? null, i.quota, i.reason, user.id])).rows[0];
  }),
});

cap({
  name: 'list_ticket_allocations', method: 'GET', path: '/events/:id/ticket-allocations', tag: TAG,
  summary: 'Organiser: complimentary allocations with the quota, how many were issued and how many are left.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ev = await organiserOf(user, i.id);
    return many(
      `SELECT a.*, p.name AS product, (SELECT count(*)::int FROM tickets t WHERE t.allocation_id=a.id AND t.supersedes_id IS NULL AND t.status <> 'void') AS issued FROM ticket_allocations a JOIN ticket_products p ON p.id=a.product_id WHERE a.event_id=$1 ORDER BY a.created_at`, [ev.id]);
  },
});

cap({
  name: 'update_ticket_allocation', method: 'PATCH', path: '/ticket-allocations/:id', tag: TAG,
  summary: 'Organiser: close an allocation (nothing more can be issued from it; issued tickets stay valid) or raise its quota.',
  input: z.object({ id, status: z.enum(['active', 'closed']).optional(), quota: z.number().int().min(1).max(100000).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = (await c.query('SELECT * FROM ticket_allocations WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!a) throw notFound('Allocation');
    await organiserOf(user, a.event_id, c);
    const used = (await c.query("SELECT count(*)::int AS n FROM tickets WHERE allocation_id=$1 AND supersedes_id IS NULL AND status <> 'void'", [a.id])).rows[0].n;
    if (i.quota != null && i.quota < used) throw conflict(`${used} tickets were already issued from this allocation`);
    return (await c.query('UPDATE ticket_allocations SET status=coalesce($2,status), quota=coalesce($3,quota) WHERE id=$1 RETURNING *', [a.id, i.status ?? null, i.quota ?? null])).rows[0];
  }),
});

cap({
  name: 'issue_complimentary_tickets', method: 'POST', path: '/ticket-allocations/:id/issue', tag: TAG, status: 201,
  summary: 'Organiser: issue tickets from an allocation to people (accounts) or guests (by name; a one-time claim code is returned for each). Respects the allocation quota, the product allocation and the event capacity, is recorded in the audit log, and is idempotent on idempotency_key.',
  input: z.object({ id, idempotency_key: z.string().trim().min(8).max(80).optional(), recipients: z.array(z.union([z.object({ user_id: id }), z.object({ guest })])).min(1).max(200) }),
  handler: ({ user }, i) => tx(async (c) => {
    const a0 = (await c.query('SELECT * FROM ticket_allocations WHERE id=$1', [i.id])).rows[0];
    if (!a0) throw notFound('Allocation');
    const ev = await organiserOf(user, a0.event_id, c);
    await lockEvent(c, ev.id);
    const a = (await c.query('SELECT * FROM ticket_allocations WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (a.status !== 'active') throw conflict('This allocation is closed');
    const used = (await c.query("SELECT count(*)::int AS n FROM tickets WHERE allocation_id=$1 AND supersedes_id IS NULL AND status <> 'void'", [a.id])).rows[0].n;
    if (used + i.recipients.length > a.quota) throw conflict(`Only ${a.quota - used} left in this allocation`, { code: 'allocation_exhausted' });
    const ids = i.recipients.filter((r) => r.user_id).map((r) => r.user_id);
    if (ids.length && (await c.query('SELECT count(*)::int AS n FROM users WHERE id = ANY($1::uuid[])', [ids])).rows[0].n !== new Set(ids).size) throw notFound('Recipient');
    const codeOf = new Map();   // claim_hash -> the code, which only this response ever shows
    const recipients = i.recipients.map((r) => {
      if (r.user_id) return { user_id: r.user_id };
      const code = newClaimCode();
      codeOf.set(claimHash(code), code);
      return { guest_name_enc: encrypt(r.guest.name, 'tickets.guest_name'), guest_email_enc: r.guest.email ? encrypt(r.guest.email, 'tickets.guest_email') : null, claim_hash: claimHash(code) };
    });
    const r = await createOrder(c, user, ev, { idempotency_key: i.idempotency_key, lines: [{ product_id: a.product_id, quantity: i.recipients.length }] }, { channel: 'complimentary', allocation: a, recipients });
    if (r.replayed) return { order_id: r.order_id, replayed: true, tickets: [] };
    await audit(c, user.id, 'ticket.allocation.issue', 'ticket_allocations', a.id);
    const tickets = (await c.query('SELECT id, serial, holder_id, claim_hash FROM tickets WHERE order_id=$1', [r.order_id])).rows;
    return { order_id: r.order_id, replayed: false, tickets: tickets.map((t) => ({ id: t.id, serial: t.serial, holder_id: t.holder_id, claim_code: codeOf.get(t.claim_hash) ?? null })) };
  }),
});

// ---- gate: scan, lookup, offline manifest ----------------------------------------------------------------------------------------------------

const scanInput = z.object({
  token: z.string().trim().max(120).optional(), code: z.string().trim().max(40).optional(), fixture_id: id.optional(), access_point_id: id.optional(), direction: z.enum(['in', 'out']).default('in'),
  method: z.enum(['camera', 'manual', 'search', 'offline']).default('camera'), client_ref: z.string().trim().min(8).max(80).optional(), scanned_at: when.optional(),
});
async function checkGate(c, ev, i) {
  if (i.access_point_id && !(await c.query("SELECT 1 FROM access_points WHERE id=$1 AND event_id=$2 AND status='active'", [i.access_point_id, ev.id])).rowCount) throw badRequest('That gate does not belong to this event');
  if (i.fixture_id && !(await c.query('SELECT 1 FROM fixtures WHERE id=$1 AND event_id=$2', [i.fixture_id, ev.id])).rowCount) throw badRequest('That fixture does not belong to this event');
}

cap({
  name: 'scan_ticket', method: 'POST', path: '/events/:id/tickets/scan', tag: TAG,
  summary: `Gate: admit a ticket by QR token (token) or by the short code or serial typed by hand (code). The server checks event, fixture, date (entry from ${ENTRY_BEFORE_MIN} minutes before to ${ENTRY_AFTER_MIN} minutes after the match), gate, state and the one-time or re-entry policy, and answers valid, re_entry, exit, duplicate, void, refunded, replaced, transferred, wrong_event, wrong_fixture, wrong_date, wrong_gate, not_issued, no_reentry, not_inside, invalid. Admission is recorded once per ticket entitlement and fixture; a repeat is a duplicate warning, never a second attendance. client_ref makes a retry safe. The operator, gate and time are recorded. The answer carries only the class, section, seat and previous use: no name, no price.`,
  input: scanInput.extend({ id }).refine((i) => !!i.token !== !!i.code, 'Give either token or code'),
  handler: ({ user }, i) => tx(async (c) => {
    const ev = await operatorOf(user, i.id, c);
    await checkGate(c, ev, i);
    return scanOne(c, ev, user, i);
  }),
});

cap({
  name: 'scan_tickets_batch', method: 'POST', path: '/events/:id/tickets/scan-batch', tag: TAG,
  summary: `Gate: replay scans recorded while offline, oldest first, each with its own client_ref so a retried batch changes nothing. Every scan is judged against the live ticket at replay time: a ticket used on another device in the meantime is reported as a duplicate, and a scan older than ${OFFLINE_MAX_AGE_H} hours is refused ("stale"). Offline cover is therefore a convenience, not a guarantee: two gates that are both offline can admit the same ticket once each, and the second is flagged when it syncs.`,
  input: z.object({ id, scans: z.array(scanInput.extend({ client_ref: z.string().trim().min(8).max(80), scanned_at: when }).refine((s) => !!s.token !== !!s.code, 'Give either token or code')).min(1).max(200) }),
  handler: ({ user }, i) => tx(async (c) => {
    const ev = await operatorOf(user, i.id, c);
    const out = [];
    for (const s of [...i.scans].sort((a, b) => +new Date(a.scanned_at) - +new Date(b.scanned_at))) {
      await checkGate(c, ev, s);
      out.push({ client_ref: s.client_ref, ...(await scanOne(c, ev, user, { ...s, method: 'offline' })) });
    }
    return { results: out, admitted: out.filter((r) => r.admitted).length, duplicates: out.filter((r) => r.result === 'duplicate').length };
  }),
});

cap({
  name: 'lookup_ticket', method: 'GET', path: '/events/:id/tickets/lookup', tag: TAG,
  summary: 'Gate: look a ticket up by its short code or serial without admitting it (the search and manual-validation path). Same minimal answer as a scan.',
  input: z.object({ id, code: z.string().trim().min(4).max(40), fixture_id: id.optional(), access_point_id: id.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const ev = await operatorOf(user, i.id, c);
    await checkGate(c, ev, i);
    return scanOne(c, ev, user, { code: i.code, fixture_id: i.fixture_id, access_point_id: i.access_point_id, check_only: true, method: 'search' });
  }),
});

cap({
  name: 'ticket_gate_manifest', method: 'GET', path: '/events/:id/tickets/gate-manifest', tag: TAG,
  summary: `Gate: the list of currently valid tickets for offline checking (serial, token version, class, seat; no names or contact details), with the generated time. A scanner caches it, checks tokens against it while offline and replays the scans with scan_tickets_batch. Limits: it is a snapshot, so tickets issued, voided or reissued after it was generated are not known to the scanner; offline scans older than ${OFFLINE_MAX_AGE_H} hours are refused on replay.`,
  input: z.object({ id, limit: z.coerce.number().int().min(1).max(5000).default(2000), offset: z.coerce.number().int().min(0).default(0) }),
  async handler({ user }, i) {
    const ev = await operatorOf(user, i.id);
    const rows = await many(
      `SELECT t.serial, t.token_version, t.short_code, t.class, t.class_label, t.seat_label, s.name AS section, t.product_id,
              (SELECT coalesce(array_agg(x.fixture_id), '{}') FROM ticket_product_fixtures x WHERE x.product_id=t.product_id) AS fixture_ids,
              EXISTS (SELECT 1 FROM ticket_attendance a WHERE a.entitlement_id=t.entitlement_id AND a.inside) AS inside, p.reentry
         FROM tickets t JOIN ticket_products p ON p.id=t.product_id LEFT JOIN ticket_sections s ON s.id=t.section_id
        WHERE t.event_id=$1 AND t.status='issued' ORDER BY t.id LIMIT $2 OFFSET $3`, [ev.id, i.limit, i.offset]);
    const total = (await pool.query("SELECT count(*)::int AS n FROM tickets WHERE event_id=$1 AND status='issued'", [ev.id])).rows[0].n;
    return { generated_at: new Date().toISOString(), event_id: ev.id, total, limit: i.limit, offset: i.offset, offline_max_age_hours: OFFLINE_MAX_AGE_H, entry_window: { before_min: ENTRY_BEFORE_MIN, after_min: ENTRY_AFTER_MIN }, tickets: rows };
  },
});

// ---- organiser: find tickets, reports ------------------------------------------------------------------------------------------------------------

cap({
  name: 'list_event_tickets', method: 'GET', path: '/events/:id/tickets', tag: TAG,
  summary: 'Organiser: find tickets of the event by status, product, class or a serial / short-code fragment. Holder names are not listed; open one ticket for that.',
  input: z.object({ id, status: z.enum(['reserved', 'issued', 'void', 'refund_due', 'refunded', 'transferred']).optional(), product_id: id.optional(), q: z.string().trim().max(40).optional(), ...page }),
  async handler({ user }, i) {
    const ev = await organiserOf(user, i.id);
    const where = ['t.event_id=$1', '($2::text IS NULL OR t.status=$2)', '($3::uuid IS NULL OR t.product_id=$3)', "($4::text IS NULL OR t.serial ILIKE '%' || $4 || '%' OR t.short_code ILIKE '%' || $4 || '%')"];
    const args = [ev.id, i.status ?? null, i.product_id ?? null, i.q ?? null];
    const rows = await many(
      `SELECT t.id, t.serial, t.short_code, t.status, t.class, t.seat_label, p.name AS product, t.price_minor, t.currency, t.holder_id, (t.guest_name_enc IS NOT NULL) AS guest, t.issued_at,
              EXISTS (SELECT 1 FROM ticket_attendance a WHERE a.entitlement_id=t.entitlement_id) AS used
         FROM tickets t JOIN ticket_products p ON p.id=t.product_id WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC, t.id LIMIT $5 OFFSET $6`, [...args, i.limit, i.offset]);
    const total = (await pool.query(`SELECT count(*)::int AS n FROM tickets t WHERE ${where.join(' AND ')}`, args)).rows[0].n;
    return { items: rows.map((r) => ({ ...r, price_minor: Number(r.price_minor) })), total, limit: i.limit, offset: i.offset };
  },
});

cap({
  name: 'ticket_report', method: 'GET', path: '/events/:id/tickets/report', tag: TAG,
  summary: 'Organiser: ticketing report. Sold, issued, refunded, voided, scanned (actual attendance) and no-show are kept apart; money is per currency, gross of tax with tax shown, net of refunds; sales by product, class and channel; per fixture capacity, sold and attended; gate throughput by hour.',
  input: z.object({ id, fixture_id: id.optional() }),
  async handler({ user }, i) {
    const ev = await organiserOf(user, i.id);
    const f = i.fixture_id ?? null;
    const cover = `($2::uuid IS NULL OR NOT EXISTS (SELECT 1 FROM ticket_product_fixtures x WHERE x.product_id=o.product_id) OR EXISTS (SELECT 1 FROM ticket_product_fixtures x WHERE x.product_id=o.product_id AND x.fixture_id=$2))`;
    // one row per entitlement: the original sale (o) and where the entitlement stands now (cur), so a transfer is not counted as a second sale
    const base = `WITH o AS (SELECT t.*, od.channel FROM tickets t JOIN ticket_orders od ON od.id=t.order_id WHERE t.event_id=$1 AND t.supersedes_id IS NULL AND t.issued_at IS NOT NULL),
                       cur AS (SELECT DISTINCT ON (entitlement_id) entitlement_id, status FROM tickets WHERE event_id=$1 ORDER BY entitlement_id, created_at DESC, id DESC)`;
    const sales = await many(
      `${base} SELECT o.currency, p.name AS product, o.class, o.channel, count(*)::int AS sold, count(*) FILTER (WHERE cur.status='issued')::int AS issued,
              count(*) FILTER (WHERE cur.status IN ('refund_due','refunded'))::int AS refunded, count(*) FILTER (WHERE cur.status='void')::int AS voided,
              sum(o.price_minor)::bigint AS gross_minor, sum(o.tax_minor)::bigint AS tax_minor, sum(o.refunded_minor)::bigint AS refunded_minor
         FROM o JOIN cur USING (entitlement_id) JOIN ticket_products p ON p.id=o.product_id WHERE ${cover} GROUP BY o.currency, p.name, o.class, o.channel ORDER BY o.currency, p.name`, [ev.id, f]);
    const refundsByEnt = await many('SELECT currency, coalesce(sum(refunded_minor),0)::bigint AS refunded_minor FROM tickets WHERE event_id=$1 GROUP BY currency', [ev.id]);
    const totals = {};
    for (const s of sales) {
      const t = totals[s.currency] ??= { currency: s.currency, gross_minor: 0, tax_minor: 0, refunded_minor: 0, net_minor: 0 };
      t.gross_minor += Number(s.gross_minor); t.tax_minor += Number(s.tax_minor);
    }
    for (const r of refundsByEnt) if (totals[r.currency]) totals[r.currency].refunded_minor = Number(r.refunded_minor);
    for (const t of Object.values(totals)) t.net_minor = t.gross_minor - t.refunded_minor;
    const fixtures = await many(
      `${base} SELECT fx.id AS fixture_id, fx.scheduled_at, fx.status, h.name AS home, a.name AS away,
              (SELECT count(*)::int FROM o JOIN cur USING (entitlement_id) WHERE cur.status='issued' AND (NOT EXISTS (SELECT 1 FROM ticket_product_fixtures x WHERE x.product_id=o.product_id) OR EXISTS (SELECT 1 FROM ticket_product_fixtures x WHERE x.product_id=o.product_id AND x.fixture_id=fx.id))) AS issued,
              (SELECT count(*)::int FROM ticket_attendance at WHERE at.fixture_id=fx.id) AS attended
         FROM fixtures fx LEFT JOIN teams h ON h.id=fx.home_team_id LEFT JOIN teams a ON a.id=fx.away_team_id WHERE fx.event_id=$1 AND ($2::uuid IS NULL OR fx.id=$2) ORDER BY fx.scheduled_at`, [ev.id, f]);
    for (const x of fixtures) {
      const lim = (await pool.query('SELECT spectator_capacity FROM ticket_fixture_limits WHERE fixture_id=$1', [x.fixture_id])).rows[0]?.spectator_capacity ?? (await settingsOf(pool, ev.id)).spectator_capacity;
      x.capacity = lim ?? null;
      x.no_show = new Date(x.scheduled_at) < new Date() && ['completed', 'finished'].includes(x.status) ? Math.max(x.issued - x.attended, 0) : null;
    }
    const gates = await many(
      `SELECT coalesce(ap.name, 'No gate selected') AS gate, count(*) FILTER (WHERE s.result IN ('valid','re_entry'))::int AS admitted, count(*) FILTER (WHERE s.result = 'duplicate')::int AS duplicates,
              count(*) FILTER (WHERE s.result NOT IN ('valid','re_entry','exit','duplicate'))::int AS refused, min(s.scanned_at) AS first_scan, max(s.scanned_at) AS last_scan
         FROM ticket_scans s LEFT JOIN access_points ap ON ap.id=s.access_point_id WHERE s.event_id=$1 AND ($2::uuid IS NULL OR s.fixture_id=$2) GROUP BY ap.name ORDER BY 1`, [ev.id, f]);
    const perHour = await many(
      `SELECT date_trunc('hour', s.scanned_at) AS hour, count(*)::int AS admitted FROM ticket_scans s WHERE s.event_id=$1 AND ($2::uuid IS NULL OR s.fixture_id=$2) AND s.result IN ('valid','re_entry') GROUP BY 1 ORDER BY 1`, [ev.id, f]);
    const sum = (k) => sales.reduce((n, s) => n + s[k], 0);
    const attendedTotal = (await pool.query('SELECT count(*)::int AS n FROM ticket_attendance WHERE event_id=$1 AND ($2::uuid IS NULL OR fixture_id=$2)', [ev.id, f])).rows[0].n;
    return {
      event_id: ev.id, counts: { sold: sum('sold'), issued: sum('issued'), refunded: sum('refunded'), voided: sum('voided'), scanned_in: attendedTotal },
      money: Object.values(totals), sales: sales.map((s) => ({ ...s, gross_minor: Number(s.gross_minor), tax_minor: Number(s.tax_minor), refunded_minor: Number(s.refunded_minor) })), fixtures, gates, throughput: perHour,
      note: 'Sold is the number of tickets sold; scanned_in is how many actually came through a gate. They are different numbers.',
    };
  },
});
