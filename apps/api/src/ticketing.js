// Spectator ticketing engine (#480). Pure rules + the transactional steps the capabilities share; nothing here is reachable except through
// src/capabilities/ticketing.js (REST + OpenAPI + MCP) and the payment / event hooks at the bottom.
//
// The model, in one paragraph: an organiser publishes ticket products for an event (optionally scoped to fixtures, or a pass over several);
// a buyer creates an order, which RESERVES tickets for a short hold under a per-event advisory lock (so allocation and capacity can never be
// oversold); the canonical payment (purpose 'ticket_order') confirms the order and ISSUES the tickets; gate staff scan the QR (a derived,
// PII-free token); admission is recorded once per entitlement and fixture. Transfers, reissues and replacements all keep one entitlement_id and
// end the previous ticket row in the same transaction, so two valid tickets can never exist for one entitlement.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pool } from './db.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { blindIndex, encrypt } from './crypto.js';
import { notify } from './notify.js';
import { isYouth } from './youth.js';

export const CLASSES = ['adult', 'youth', 'concession', 'vip', 'complimentary', 'other'];
export const CHANNELS = ['online', 'box_office', 'partner', 'complimentary'];
export const RESULTS = ['valid', 're_entry', 'exit', 'duplicate', 'invalid', 'wrong_event', 'wrong_fixture', 'wrong_date', 'wrong_gate', 'void', 'refunded', 'replaced', 'transferred', 'not_issued', 'fixture_cancelled', 'no_reentry', 'not_inside', 'stale'];
export const ADMITTED = new Set(['valid', 're_entry']);
/** Gates admit from this long before kick-off until this long after the fixture is due to end. */
export const ENTRY_BEFORE_MIN = 120, ENTRY_AFTER_MIN = 120;
/** An offline scan can be replayed for this long; after that the server refuses it rather than record an admission it cannot vouch for. */
export const OFFLINE_MAX_AGE_H = 72;
const DONE_FIXTURE = ['completed', 'cancelled', 'abandoned'];
const LIVE = "(t.status='issued' OR (t.status='reserved' AND t.hold_expires_at > now()))";

// ---- identifiers and the QR token ---------------------------------------------------------------------------------------------------------------
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rnd = (n) => Array.from(randomBytes(n), (b) => ALPHABET[b & 31]).join('');
export const newSerial = () => `TKT-${rnd(10)}`;
export const newShortCode = () => rnd(8);
export const newClaimCode = () => rnd(12);
// GT1.<serial>.<version>.<mac>: no name, no id, nothing personal. The mac proves the server issued it; the version invalidates old copies.
const mac = (serial, version) => blindIndex(`ticket:${serial}:${version}`).slice(0, 20);
export const tokenFor = (serial, version) => `GT1.${serial}.${version}.${mac(serial, version)}`;
export function parseToken(raw) {
  const m = /^GT1\.(TKT-[A-Z0-9]{10})\.(\d{1,6})\.([0-9a-f]{20})$/.exec(String(raw ?? '').trim());
  if (!m) return null;
  const want = Buffer.from(mac(m[1], m[2])), got = Buffer.from(m[3]);
  return want.length === got.length && timingSafeEqual(want, got) ? { serial: m[1], version: Number(m[2]) } : null;
}
export const claimHash = (code) => blindIndex(`ticket-claim:${String(code).trim().toUpperCase()}`);

// ---- seats ----------------------------------------------------------------------------------------------------------------------------------------
export const rowName = (i) => { let s = '', n = i; do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0); return s; };
const rowIndex = (letters) => [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
/** 'C12' is row C, seat 12; null when the label is not a seat of this section. */
export function seatOf(section, label) {
  const m = /^([A-Z]{1,2})(\d{1,3})$/.exec(String(label ?? '').trim().toUpperCase());
  if (!m) return null;
  const row = rowIndex(m[1]), seat = Number(m[2]);
  return row >= 0 && row < section.rows_count && seat >= 1 && seat <= section.seats_per_row ? `${m[1]}${seat}` : null;
}
export const sectionSeats = (s) => s.rows_count * s.seats_per_row;

// ---- money ----------------------------------------------------------------------------------------------------------------------------------------
/** Gross (what the buyer pays) and tax for one ticket, from the product's price and tax rule. */
export function priced(p) {
  const price = Number(p.price_minor), bp = p.tax_bp;
  if (p.tax_inclusive) return { gross: price, tax: Math.round((price * bp) / (10000 + bp)) };
  const tax = Math.round((price * bp) / 10000);
  return { gross: price + tax, tax };
}

// ---- locks, fixtures, capacity -------------------------------------------------------------------------------------------------------------------
/** Everything that sells or issues for one event serialises on this lock, which is what makes oversell impossible. */
export const lockEvent = (c, eventId) => c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`tickets:${eventId}`]);
const lockEntitlement = (c, entId) => c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`ticket-ent:${entId}`]);

export const settingsOf = async (c, eventId) => (await c.query('SELECT * FROM ticket_settings WHERE event_id=$1', [eventId])).rows[0] ?? {
  event_id: eventId, spectator_capacity: null, safety_capacity: null, count_participants: false, count_accreditations: false, sales_open: true, hold_minutes: 15,
  transfer_allowed: true, transfer_cutoff_hours: 2, refund_policy: 'until_cutoff', refund_cutoff_hours: 24,
};

/** Fixtures a product admits to (its own links, else every fixture of the event). `null` stands for "the event as a whole" when it has no fixtures. */
export async function coveredFixtures(c, eventId, productId, { all = false } = {}) {
  const linked = (await c.query('SELECT fixture_id FROM ticket_product_fixtures WHERE product_id=$1', [productId])).rows.map((r) => r.fixture_id);
  const rows = (await c.query(
    `SELECT id, scheduled_at, duration_min, status FROM fixtures WHERE event_id=$1 AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[])) ${all ? '' : "AND status <> ALL($3::text[])"} ORDER BY scheduled_at`,
    all ? [eventId, linked.length ? linked : null] : [eventId, linked.length ? linked : null, DONE_FIXTURE])).rows;
  return { linked, fixtures: rows, wholeEvent: !linked.length && !rows.length };
}

async function limitsOf(c, eventId, fixtureId) {
  const s = await settingsOf(c, eventId);
  const f = fixtureId ? (await c.query('SELECT * FROM ticket_fixture_limits WHERE fixture_id=$1', [fixtureId])).rows[0] : null;
  return { capacity: f?.spectator_capacity ?? s.spectator_capacity ?? null, safety: f?.safety_capacity ?? s.safety_capacity ?? null, participants: s.count_participants, accreditations: s.count_accreditations };
}

/** Live tickets that admit to this fixture (null = the event as a whole): its own, event-wide ones, and passes that include it. */
async function loadOf(c, eventId, fixtureId) {
  return (await c.query(
    `SELECT count(*)::int AS n FROM tickets t WHERE t.event_id=$1 AND ${LIVE}
       AND ($2::uuid IS NULL OR NOT EXISTS (SELECT 1 FROM ticket_product_fixtures x WHERE x.product_id=t.product_id)
            OR EXISTS (SELECT 1 FROM ticket_product_fixtures x WHERE x.product_id=t.product_id AND x.fixture_id=$2))`, [eventId, fixtureId])).rows[0].n;
}

async function otherPeople(c, eventId, lim) {
  let n = 0;
  if (lim.participants) n += (await c.query("SELECT coalesce(sum(CASE WHEN e.team_id IS NULL THEN 1 ELSE (SELECT count(*) FROM team_members m WHERE m.team_id=e.team_id AND m.status='active') END),0)::int AS n FROM event_entries e WHERE e.event_id=$1 AND e.status='accepted'", [eventId])).rows[0].n;
  if (lim.accreditations) n += (await c.query("SELECT count(*)::int AS n FROM accreditations WHERE event_id=$1 AND status='approved' AND access='active'", [eventId])).rows[0].n;
  return n;
}

/** Throws a 409 when `qty` more tickets of this product would break its allocation, a fixture's capacity or the safety capacity. Call under lockEvent. */
export async function assertRoom(c, ev, product, qty) {
  if (product.allocation != null) {
    const n = (await c.query(`SELECT count(*)::int AS n FROM tickets t WHERE t.product_id=$1 AND ${LIVE}`, [product.id])).rows[0].n;
    if (n + qty > product.allocation) throw conflict(n >= product.allocation ? 'Sold out' : `Only ${product.allocation - n} left`, { code: 'sold_out', remaining: Math.max(product.allocation - n, 0) });
  }
  const { fixtures, wholeEvent } = await coveredFixtures(c, ev.id, product.id);
  if (!fixtures.length && !wholeEvent) throw conflict('Every fixture this ticket admits to has already been played or cancelled', { code: 'nothing_to_attend' });
  for (const f of wholeEvent ? [{ id: null }] : fixtures) {
    const lim = await limitsOf(c, ev.id, f.id);
    if (lim.capacity == null && lim.safety == null) continue;
    const load = await loadOf(c, ev.id, f.id);
    if (lim.capacity != null && load + qty > lim.capacity) throw conflict(load >= lim.capacity ? 'Sold out' : `Only ${lim.capacity - load} left`, { code: 'sold_out', remaining: Math.max(lim.capacity - load, 0), fixture_id: f.id });
    if (lim.safety != null && load + qty + (await otherPeople(c, ev.id, lim)) > lim.safety) throw conflict('The safety capacity for this event has been reached', { code: 'capacity_reached', fixture_id: f.id });
  }
}

/** How many more can be sold right now (null = unlimited). Read-only; the lock-protected assertRoom is what actually decides. */
export async function remainingOf(c, ev, product) {
  const out = [];
  if (product.allocation != null) out.push(product.allocation - (await c.query(`SELECT count(*)::int AS n FROM tickets t WHERE t.product_id=$1 AND ${LIVE}`, [product.id])).rows[0].n);
  const { fixtures, wholeEvent } = await coveredFixtures(c, ev.id, product.id);
  if (!fixtures.length && !wholeEvent) return 0;
  for (const f of wholeEvent ? [{ id: null }] : fixtures) {
    const lim = await limitsOf(c, ev.id, f.id);
    if (lim.capacity == null && lim.safety == null) continue;
    const load = await loadOf(c, ev.id, f.id);
    if (lim.capacity != null) out.push(lim.capacity - load);
    if (lim.safety != null) out.push(lim.safety - load - await otherPeople(c, ev.id, lim));
  }
  return out.length ? Math.max(Math.min(...out), 0) : null;
}

/** Seats of `section` that overlap in time with this product and are already held by a live ticket. */
async function seatsTaken(c, eventId, product, labels) {
  const linked = (await c.query('SELECT fixture_id FROM ticket_product_fixtures WHERE product_id=$1', [product.id])).rows.map((r) => r.fixture_id);
  return (await c.query(
    `SELECT DISTINCT t.seat_label FROM tickets t WHERE t.event_id=$1 AND t.section_id=$2 AND t.seat_label = ANY($3::text[]) AND ${LIVE}
       AND ($4::boolean OR NOT EXISTS (SELECT 1 FROM ticket_product_fixtures x WHERE x.product_id=t.product_id)
            OR EXISTS (SELECT 1 FROM ticket_product_fixtures x WHERE x.product_id=t.product_id AND x.fixture_id = ANY($5::uuid[])))`,
    [eventId, product.section_id, labels, !linked.length, linked])).rows.map((r) => r.seat_label);
}

async function chooseSeats(c, ev, product, wanted, qty) {
  const section = (await c.query('SELECT * FROM ticket_sections WHERE id=$1 AND archived_at IS NULL', [product.section_id])).rows[0];
  if (!section) throw conflict('This section is no longer available');
  const labels = (wanted ?? []).map((s) => seatOf(section, s));
  if (labels.length !== qty || labels.some((s) => !s)) throw badRequest(`Choose ${qty} seat${qty === 1 ? '' : 's'} from ${section.name} (for example A1)`);
  if (new Set(labels).size !== labels.length) throw badRequest('The same seat was chosen twice');
  const taken = await seatsTaken(c, ev.id, product, labels);
  if (taken.length) throw conflict(`Seat ${taken[0]} was just taken`, { code: 'seat_taken', seats: taken });
  return { section, labels };
}

// ---- ticket rows and history -----------------------------------------------------------------------------------------------------------------------
export const record = (c, ticketId, actor, kind, from, to, detail = {}) =>
  c.query('INSERT INTO ticket_history(ticket_id, actor_id, kind, from_status, to_status, detail) VALUES ($1,$2,$3,$4,$5,$6)', [ticketId, actor ?? null, kind, from ?? null, to ?? null, detail]);

async function insertTicket(c, t) {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await c.query(
        `INSERT INTO tickets(serial, short_code, entitlement_id, supersedes_id, event_id, product_id, order_id, line_id, allocation_id, holder_id, guest_name_enc, guest_email_enc, claim_hash, class, class_label,
                             section_id, seat_label, price_minor, tax_minor, currency, status, hold_expires_at, issued_at)
         VALUES ($1,$2,coalesce($3, gen_random_uuid()),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING *`,
        [newSerial(), newShortCode(), t.entitlement_id ?? null, t.supersedes_id ?? null, t.event_id, t.product_id, t.order_id, t.line_id ?? null, t.allocation_id ?? null, t.holder_id ?? null, t.guest_name_enc ?? null, t.guest_email_enc ?? null,
          t.claim_hash ?? null, t.class, t.class_label ?? null, t.section_id ?? null, t.seat_label ?? null, t.price_minor, t.tax_minor, t.currency, t.status, t.hold_expires_at ?? null, t.issued_at ?? null])).rows[0];
    } catch (e) { if (e.code !== '23505' || attempt > 5 || !/serial|short_code/.test(e.constraint ?? '')) throw e; }
  }
}

const eventOf = async (c, eventId) => { const ev = (await c.query('SELECT * FROM events WHERE id=$1', [eventId])).rows[0]; if (!ev) throw notFound('Event'); return ev; };

/** Create an order and reserve its tickets. A zero total is confirmed and issued straight away. `who` is the buyer, `channel` how it was sold. */
export async function createOrder(c, who, ev, i, { channel = 'online', allocation = null, recipients = null } = {}) {
  if (['cancelled', 'completed'].includes(ev.status)) throw conflict(`The event is ${ev.status}`);
  await lockEvent(c, ev.id);
  if (i.idempotency_key) {
    const prior = (await c.query('SELECT id FROM ticket_orders WHERE buyer_id=$1 AND idempotency_key=$2', [who.id, i.idempotency_key])).rows[0];
    if (prior) return { order_id: prior.id, replayed: true };
  }
  const settings = await settingsOf(c, ev.id);
  if (channel !== 'complimentary' && !settings.sales_open) throw conflict('Ticket sales are paused for this event', { code: 'sales_paused' });
  const now = new Date();
  const orderCurrency = [];
  // the currency is only known once the first product is read, so the order starts with the neutral 'XXX' and is updated below
  const order = (await c.query(
    "INSERT INTO ticket_orders(event_id, buyer_id, channel, status, currency, idempotency_key, expires_at) VALUES ($1,$2,$3,'pending_payment','XXX',$4, now() + make_interval(mins => $5)) RETURNING *",
    [ev.id, who.id, channel, i.idempotency_key ?? null, settings.hold_minutes])).rows[0];
  let subtotal = 0, tax = 0, ticketCount = 0;
  const wanted = new Map();
  for (const l of i.lines) wanted.set(l.product_id, (wanted.get(l.product_id) ?? 0) + l.quantity);
  for (const line of i.lines) {
    const p = (await c.query('SELECT * FROM ticket_products WHERE id=$1 AND event_id=$2', [line.product_id, ev.id])).rows[0];
    if (!p) throw notFound('Ticket product');
    if (p.status !== 'active') throw conflict(p.status === 'paused' ? 'Sales of this ticket are paused' : 'This ticket is not on sale', { code: 'not_on_sale' });
    if (!p.channels.includes(channel)) throw forbidden('This ticket is not sold through this channel');
    if (p.sale_starts_at && new Date(p.sale_starts_at) > now) throw conflict('Sales have not opened yet', { code: 'not_started' });
    if (p.sale_ends_at && new Date(p.sale_ends_at) < now) throw conflict('Sales for this ticket have closed', { code: 'sale_ended' });
    if (orderCurrency.length && orderCurrency[0] !== p.currency) throw badRequest('One order can only hold tickets in one currency');
    orderCurrency[0] = p.currency;
    if (['online', 'partner'].includes(channel) && line.quantity > p.per_order_limit) throw conflict(`At most ${p.per_order_limit} per order`, { code: 'order_limit' });
    if (channel === 'online' || channel === 'partner') {
      const have = (await c.query(`SELECT count(*)::int AS n FROM tickets t JOIN ticket_orders o ON o.id=t.order_id WHERE o.buyer_id=$1 AND t.product_id=$2 AND ${LIVE}`, [who.id, p.id])).rows[0].n;
      if (have + wanted.get(p.id) > p.per_account_limit) throw conflict(`At most ${p.per_account_limit} per account`, { code: 'account_limit', already_held: have });
    }
    if (channel === 'complimentary' && Number(p.price_minor) !== 0) throw badRequest('A complimentary ticket must be free');
    await assertRoom(c, ev, p, line.quantity);
    const seats = p.seating === 'reserved' ? await chooseSeats(c, ev, p, line.seats, line.quantity) : null;
    const { gross, tax: unitTax } = priced(p);
    const ol = (await c.query('INSERT INTO ticket_order_lines(order_id, product_id, qty, name, class, unit_minor, unit_tax_minor, currency) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [order.id, p.id, line.quantity, p.name, p.class, gross, unitTax, p.currency])).rows[0];
    for (let n = 0; n < line.quantity; n++) {
      const holder = recipients?.[ticketCount] ?? {};
      const t = await insertTicket(c, {
        event_id: ev.id, product_id: p.id, order_id: order.id, line_id: ol.id, allocation_id: allocation?.id ?? null, holder_id: holder.guest_name_enc ? null : (holder.user_id ?? who.id), guest_name_enc: holder.guest_name_enc, guest_email_enc: holder.guest_email_enc, claim_hash: holder.claim_hash,
        class: p.class, class_label: p.class_label, section_id: seats?.section.id, seat_label: seats?.labels[n], price_minor: gross, tax_minor: unitTax, currency: p.currency, status: 'reserved', hold_expires_at: order.expires_at,
      });
      await record(c, t.id, who.id, 'reserved', null, 'reserved', { order_id: order.id, channel });
      ticketCount++;
    }
    subtotal += (gross - unitTax) * line.quantity; tax += unitTax * line.quantity;
  }
  const total = subtotal + tax;
  await c.query('UPDATE ticket_orders SET currency=$2, subtotal_minor=$3, tax_minor=$4, total_minor=$5 WHERE id=$1', [order.id, orderCurrency[0], subtotal, tax, total]);
  if (total === 0) await confirmOrder(c, order.id, who.id, { locked: true });
  return { order_id: order.id, replayed: false };
}

/** Payment landed (or the order is free): turn the reserved tickets into issued ones. Returns false when it can no longer be honoured, so the payment is refunded. */
export async function confirmOrder(c, orderId, actor, { locked = false } = {}) {
  const o0 = (await c.query('SELECT event_id FROM ticket_orders WHERE id=$1', [orderId])).rows[0];
  if (!o0) return false;
  if (!locked) await lockEvent(c, o0.event_id);
  const o = (await c.query('SELECT * FROM ticket_orders WHERE id=$1 FOR UPDATE', [orderId])).rows[0];
  if (o.status === 'confirmed') return true;
  if (o.status !== 'pending_payment') return false;
  const ev = await eventOf(c, o.event_id);
  const held = (await c.query("SELECT * FROM tickets WHERE order_id=$1 AND status='reserved' ORDER BY created_at, id", [orderId])).rows;
  if (!held.length) return false;
  // a hold that ran out is no longer counted as taken, so it has to win its place back before it is issued
  const lapsed = held.filter((t) => new Date(t.hold_expires_at) <= new Date());
  try {
    if (['cancelled', 'completed'].includes(ev.status)) throw conflict('The event is no longer on sale');
    const byProduct = new Map();
    for (const t of lapsed) byProduct.set(t.product_id, [...(byProduct.get(t.product_id) ?? []), t]);
    for (const [pid, ts] of byProduct) {
      const p = (await c.query('SELECT * FROM ticket_products WHERE id=$1', [pid])).rows[0];
      await assertRoom(c, ev, p, ts.length);
      const seated = ts.filter((t) => t.seat_label);
      if (seated.length && (await seatsTaken(c, ev.id, p, seated.map((t) => t.seat_label))).length) throw conflict('A seat was taken while the payment was in progress', { code: 'seat_taken' });
    }
  } catch (e) { if (e.status === 409) return false; throw e; }
  await c.query("UPDATE tickets SET status='issued', hold_expires_at=NULL, issued_at=now() WHERE order_id=$1 AND status='reserved'", [orderId]);
  await c.query("UPDATE ticket_orders SET status='confirmed', confirmed_at=now() WHERE id=$1", [orderId]);
  for (const t of held) await record(c, t.id, actor, 'issued', 'reserved', 'issued', { order_id: orderId });
  await notify(c, o.buyer_id, { kind: 'ticket_issued', title: 'Your tickets are ready', body: `${held.length} ticket${held.length === 1 ? '' : 's'} for ${ev.name}. Open My tickets to show the QR code at the gate.`, data: { ticket: true, event_id: ev.id, order_id: orderId } });
  return true;
}

/** Give up an unpaid order (the buyer, or the hold ran out): the reserved tickets are voided and the place is free again. */
export async function releaseOrder(c, orderId, actor, status, reason) {
  const o = (await c.query('SELECT * FROM ticket_orders WHERE id=$1 FOR UPDATE', [orderId])).rows[0];
  if (!o || o.status !== 'pending_payment') return false;
  const ts = (await c.query("UPDATE tickets SET status='void', ended_at=now(), end_reason=$2 WHERE order_id=$1 AND status='reserved' RETURNING id", [orderId, reason])).rows;
  for (const t of ts) await record(c, t.id, actor, 'voided', 'reserved', 'void', { reason });
  await c.query('UPDATE ticket_orders SET status=$2 WHERE id=$1', [orderId, status]);
  return true;
}

// ---- the holder's view ---------------------------------------------------------------------------------------------------------------------------
export const fixtureLabel = (f) => (f.home || f.away ? `${f.home ?? 'TBC'} v ${f.away ?? 'TBC'}` : f.round ?? 'Fixture');
export async function fixturesFor(c, eventId, productId) {
  const { fixtures } = await coveredFixtures(c, eventId, productId, { all: true });
  if (!fixtures.length) return [];
  return (await c.query(
    `SELECT f.id, f.scheduled_at, f.duration_min, f.status, f.round, h.name AS home, a.name AS away FROM fixtures f LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id WHERE f.id = ANY($1::uuid[]) ORDER BY f.scheduled_at`,
    [fixtures.map((f) => f.id)])).rows.map((f) => ({ id: f.id, label: fixtureLabel(f), scheduled_at: f.scheduled_at, status: f.status }));
}

/** First moment the ticket admits (for cutoffs): the earliest remaining fixture, else the event's first day. */
async function firstStart(c, t) {
  const { fixtures } = await coveredFixtures(c, t.event_id, t.product_id);
  if (fixtures.length) return new Date(fixtures[0].scheduled_at);
  const ev = await eventOf(c, t.event_id);
  return new Date(`${new Date(ev.starts_on).toISOString().slice(0, 10)}T00:00:00Z`);
}

async function scheduleChangedSince(c, t) {
  const linked = (await c.query('SELECT fixture_id FROM ticket_product_fixtures WHERE product_id=$1', [t.product_id])).rows.map((r) => r.fixture_id);
  return (await c.query(
    `SELECT 1 FROM ticket_schedule_changes WHERE event_id=$1 AND at > $2 AND (fixture_id IS NULL OR $3::uuid[] = '{}' OR fixture_id = ANY($3::uuid[])) LIMIT 1`, [t.event_id, t.issued_at, linked])).rowCount > 0;
}
const attended = async (c, entitlementId) => (await c.query('SELECT 1 FROM ticket_attendance WHERE entitlement_id=$1 LIMIT 1', [entitlementId])).rowCount > 0;

/** May the holder get their money back, and if not, why. The organiser is always allowed (with a reason). */
export async function refundRule(c, t, { organiser = false, now = new Date() } = {}) {
  if (t.status !== 'issued') return { ok: false, reason: 'This ticket is not active' };
  if (organiser) return { ok: true };
  if (t.supersedes_id) return { ok: false, reason: 'A ticket that was transferred can only be refunded by the organiser' };
  const settings = await settingsOf(c, t.event_id);
  if (await attended(c, t.entitlement_id)) return { ok: false, reason: 'This ticket has already been used' };
  if (await scheduleChangedSince(c, t)) return { ok: true };
  if (settings.refund_policy === 'never') return { ok: false, reason: 'Tickets for this event are not refundable' };
  if (settings.refund_policy === 'anytime') return { ok: true };
  const start = await firstStart(c, t);
  return +now < +start - settings.refund_cutoff_hours * 3600e3 ? { ok: true } : { ok: false, reason: `Refunds close ${settings.refund_cutoff_hours} hours before the start` };
}

export async function transferRule(c, t, now = new Date()) {
  if (t.status !== 'issued') return { ok: false, reason: 'This ticket is not active' };
  const p = (await c.query('SELECT transferable FROM ticket_products WHERE id=$1', [t.product_id])).rows[0];
  const s = await settingsOf(c, t.event_id);
  if (!p?.transferable || !s.transfer_allowed) return { ok: false, reason: 'Tickets for this event cannot be transferred' };
  if (await attended(c, t.entitlement_id)) return { ok: false, reason: 'This ticket has already been used' };
  const start = await firstStart(c, t);
  return +now < +start - s.transfer_cutoff_hours * 3600e3 ? { ok: true } : { ok: false, reason: `Transfers close ${s.transfer_cutoff_hours} hours before the start` };
}

const STATE = { reserved: 'reserved', issued: 'valid', void: 'void', refund_due: 'refund_due', refunded: 'refunded', transferred: 'transferred' };
/** What the holder sees. The token is included only when the ticket is valid and the caller is the holder. */
export async function ticketView(c, t, { holder = false, organiser = false } = {}) {
  const [ev, product, section, fixtures, inside, refund, transfer] = await Promise.all([
    eventOf(c, t.event_id),
    c.query('SELECT name, kind, reentry FROM ticket_products WHERE id=$1', [t.product_id]).then((r) => r.rows[0]),
    t.section_id ? c.query('SELECT name FROM ticket_sections WHERE id=$1', [t.section_id]).then((r) => r.rows[0]) : null,
    fixturesFor(c, t.event_id, t.product_id),
    c.query('SELECT fixture_id, inside, first_in_at, entries FROM ticket_attendance WHERE entitlement_id=$1 ORDER BY first_in_at', [t.entitlement_id]).then((r) => r.rows),
    holder || organiser ? refundRule(c, t, { organiser }) : null,
    holder ? transferRule(c, t) : null,
  ]);
  return {
    id: t.id, serial: t.serial, short_code: t.short_code, status: t.status, state: STATE[t.status] ?? t.status,
    event: { id: ev.id, name: ev.name, starts_on: ev.starts_on, ends_on: ev.ends_on, status: ev.status },
    product: { id: t.product_id, name: product?.name, kind: product?.kind, reentry: product?.reentry }, class: t.class, class_label: t.class_label,
    section: section?.name ?? null, seat: t.seat_label, fixtures, price_minor: Number(t.price_minor), tax_minor: Number(t.tax_minor), currency: t.currency, refunded_minor: Number(t.refunded_minor),
    used: inside.length > 0, inside: inside.some((a) => a.inside), attendance: inside.map((a) => ({ fixture_id: a.fixture_id, first_in_at: a.first_in_at, entries: a.entries })),
    order_id: t.order_id, hold_expires_at: t.hold_expires_at, issued_at: t.issued_at,
    ...(holder ? { token: t.status === 'issued' ? tokenFor(t.serial, t.token_version) : null, can_transfer: transfer.ok, transfer_blocked: transfer.ok ? null : transfer.reason, can_refund: refund.ok, refund_blocked: refund.ok ? null : refund.reason } : {}),
    ...(organiser ? { holder_id: t.holder_id, guest: !!t.guest_name_enc, allocation_id: t.allocation_id } : {}),
  };
}

// ---- transfer, reissue, void, claim ------------------------------------------------------------------------------------------------------------
/** End `old` and create its successor under the same entitlement, in one transaction. `status` is how the old row ends. */
export async function succeed(c, old, actor, { holder_id = null, guest = null, status = 'transferred', reason, kind }) {
  await c.query('UPDATE tickets SET status=$2, ended_at=now(), end_reason=$3 WHERE id=$1', [old.id, status, reason ?? status]);
  const claim = guest ? newClaimCode() : null;
  const next = await insertTicket(c, {
    entitlement_id: old.entitlement_id, supersedes_id: old.id, event_id: old.event_id, product_id: old.product_id, order_id: old.order_id, line_id: old.line_id, allocation_id: old.allocation_id,
    holder_id, guest_name_enc: guest ? encrypt(guest.name, 'tickets.guest_name') : null, guest_email_enc: guest?.email ? encrypt(guest.email, 'tickets.guest_email') : null, claim_hash: claim ? claimHash(claim) : null,
    class: old.class, class_label: old.class_label, section_id: old.section_id, seat_label: old.seat_label, price_minor: old.price_minor, tax_minor: old.tax_minor, currency: old.currency, status: 'issued', issued_at: new Date(),
  });
  await record(c, old.id, actor, kind ?? status, old.status, status, { to_ticket: next.id });
  await record(c, next.id, actor, 'issued', null, 'issued', { from_ticket: old.id, via: kind ?? status });
  return { ticket: next, claim_code: claim };
}

export async function loadTicket(c, ticketId, { lock = false } = {}) {
  const t = (await c.query(`SELECT * FROM tickets WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [ticketId])).rows[0];
  if (!t) throw notFound('Ticket');
  return t;
}

export async function refundDueFor(c, where, params, reason, actor, kind) {
  const ts = (await c.query(`UPDATE tickets t SET status='refund_due', ended_at=now(), end_reason=$${params.length + 1} WHERE t.status='issued' AND ${where} RETURNING t.*`, [...params, reason])).rows;
  for (const t of ts) {
    await record(c, t.id, actor, kind ?? 'refund_due', 'issued', 'refund_due', { reason });
    if (t.holder_id) await notify(c, t.holder_id, { kind: 'ticket_refund', title: 'Your ticket will be refunded', body: reason, data: { ticket: true, event_id: t.event_id, ticket_id: t.id } });
  }
  return ts;
}

// ---- refunds through canonical payments ------------------------------------------------------------------------------------------------------
/** Pay back one ticket that is 'refund_due'. The ticket becomes 'refunded' only after payments.refunded_cents has moved; a provider failure leaves it due for the sweep to retry. */
export async function settleRefund(ticketId) {
  const first = (await pool.query('SELECT order_id FROM tickets WHERE id=$1', [ticketId])).rows[0];
  if (!first) return { status: 'missing' };
  const lock = await pool.connect();   // refunds of one order run one at a time, so refunded_cents is never raced
  try {
    await lock.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [`ticket-refund:${first.order_id}`]);
    return await settleRefundLocked(ticketId);
  } finally { await lock.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`ticket-refund:${first.order_id}`]).catch(() => {}); lock.release(); }
}
async function settleRefundLocked(ticketId) {
  const t = (await pool.query('SELECT * FROM tickets WHERE id=$1', [ticketId])).rows[0];
  if (!t || t.status !== 'refund_due') return { status: t?.status ?? 'missing' };
  const amount = Number(t.price_minor) - Number(t.refunded_minor);
  const pay = amount > 0 ? (await pool.query("SELECT * FROM payments WHERE purpose_type='ticket_order' AND purpose_id=$1 AND status IN ('paid','refunded') ORDER BY created_at LIMIT 1", [t.order_id])).rows[0] : null;
  if (amount > 0 && !pay) {
    await pool.query('INSERT INTO ticket_history(ticket_id, kind, detail) VALUES ($1,$2,$3)', [t.id, 'refund_blocked', { reason: 'no paid payment found for this order' }]);
    return { status: 'refund_due', blocked: 'no_payment' };
  }
  let give = 0;
  if (amount > 0) {
    const { refundPartial } = await import('./payments/service.js');
    try { give = await refundPartial(pay, amount, `ticket-refund:${t.id}`); }
    catch (e) {
      await pool.query('INSERT INTO ticket_history(ticket_id, kind, detail) VALUES ($1,$2,$3)', [t.id, 'refund_failed', { error: String(e.message).slice(0, 200) }]);
      return { status: 'refund_due', error: e.message };
    }
    if (give < amount) { await pool.query('UPDATE tickets SET refunded_minor = refunded_minor + $2 WHERE id=$1', [t.id, give]); return { status: 'refund_due', partial: give }; }
  }
  await pool.query("UPDATE tickets SET status = CASE WHEN price_minor = 0 THEN 'void' ELSE 'refunded' END, refunded_minor = refunded_minor + $2 WHERE id=$1 AND status='refund_due'", [t.id, give]);
  await pool.query('INSERT INTO ticket_history(ticket_id, kind, from_status, to_status, detail) VALUES ($1,$2,$3,$4,$5)', [t.id, 'refunded', 'refund_due', amount > 0 ? 'refunded' : 'void', { amount_minor: give, currency: t.currency, key: `ticket-refund:${t.id}` }]);
  return { status: amount > 0 ? 'refunded' : 'void', amount_minor: give };
}

/** Work through tickets waiting for their refund (event or fixture cancelled, holder or organiser asked). Safe to run any number of times. */
export async function processTicketRefunds({ eventId = null, limit = 200 } = {}) {
  const due = (await pool.query("SELECT id FROM tickets WHERE status='refund_due' AND ($1::uuid IS NULL OR event_id=$1) ORDER BY ended_at LIMIT $2", [eventId, limit])).rows;
  let refunded = 0, failed = 0;
  for (const r of due) { const out = await settleRefund(r.id); if (out.status === 'refunded' || out.status === 'void') refunded++; else failed++; }
  return { processed: due.length, refunded, failed };
}

/** Hold sweep: unpaid orders whose hold ran out (and have no payment in flight) are released; then waiting refunds are retried. */
export async function sweepTickets() {
  const stale = (await pool.query(
    `SELECT o.id FROM ticket_orders o WHERE o.status='pending_payment' AND o.expires_at < now()
        AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.purpose_type='ticket_order' AND p.purpose_id=o.id AND p.status='pending' AND p.created_at > now() - interval '60 minutes') LIMIT 500`)).rows;
  let released = 0;
  for (const o of stale) { const c = await pool.connect(); try { await c.query('BEGIN'); if (await releaseOrder(c, o.id, null, 'expired', 'The reservation ran out')) released++; await c.query('COMMIT'); } catch (e) { await c.query('ROLLBACK'); } finally { c.release(); } }
  const refunds = await processTicketRefunds();
  return released + refunds.refunded;
}

// ---- event hooks ------------------------------------------------------------------------------------------------------------------------------------
/** The event was cancelled: every live ticket becomes refund_due and its holder is told. Call inside the cancelling transaction. */
export async function onEventCancelled(c, ev, actor) {
  await c.query("INSERT INTO ticket_schedule_changes(event_id, kind, actor_id) VALUES ($1,'event_cancelled',$2)", [ev.id, actor?.id ?? null]);
  await c.query("UPDATE ticket_orders SET status='cancelled' WHERE event_id=$1 AND status='pending_payment'", [ev.id]);
  await c.query("UPDATE tickets SET status='void', ended_at=now(), end_reason='Event cancelled' WHERE event_id=$1 AND status='reserved'", [ev.id]);
  await c.query("UPDATE ticket_products SET status='paused' WHERE event_id=$1 AND status='active'", [ev.id]);
  return (await refundDueFor(c, 't.event_id=$1', [ev.id], `${ev.name} was cancelled. You will be refunded in full.`, actor?.id, 'event_cancelled')).length;
}

/** A fixture was cancelled or retimed. Cancelled: tickets that only admit to it are refunded. Retimed: holders are told and may refund past the usual cutoff. */
export async function onFixtureChanged(c, ev, fixture, { kind, oldAt, newAt }, actor) {
  await c.query('INSERT INTO ticket_schedule_changes(event_id, fixture_id, kind, old_at, new_at, actor_id) VALUES ($1,$2,$3,$4,$5,$6)', [ev.id, fixture.id, kind, oldAt ?? null, newAt ?? null, actor?.id ?? null]);
  if (kind === 'cancelled') {
    return (await refundDueFor(c,
      `t.event_id=$1 AND EXISTS (SELECT 1 FROM ticket_product_fixtures x WHERE x.product_id=t.product_id AND x.fixture_id=$2) AND (SELECT count(*) FROM ticket_product_fixtures x JOIN fixtures f ON f.id=x.fixture_id WHERE x.product_id=t.product_id AND f.status <> ALL($3::text[]) AND f.id <> $2) = 0`,
      [ev.id, fixture.id, DONE_FIXTURE], 'The match was cancelled. You will be refunded in full.', actor?.id, 'fixture_cancelled')).length;
  }
  const holders = (await c.query(
    `SELECT DISTINCT t.holder_id FROM tickets t WHERE t.event_id=$1 AND t.status='issued' AND t.holder_id IS NOT NULL
       AND (NOT EXISTS (SELECT 1 FROM ticket_product_fixtures x WHERE x.product_id=t.product_id) OR EXISTS (SELECT 1 FROM ticket_product_fixtures x WHERE x.product_id=t.product_id AND x.fixture_id=$2))`, [ev.id, fixture.id])).rows;
  for (const h of holders) await notify(c, h.holder_id, { kind: 'ticket_rescheduled', title: 'Match time changed', body: `${ev.name} now starts ${new Date(newAt).toISOString()}. If it no longer suits you, you can refund your ticket.`, data: { ticket: true, event_id: ev.id, fixture_id: fixture.id } });
  return holders.length;
}

// ---- scanning -------------------------------------------------------------------------------------------------------------------------------------------
/** Find the ticket a scan or typed code refers to. A QR token also checks the version, so a reissued ticket's old code is "replaced". */
async function findTicket(c, i) {
  if (i.token) {
    const t = parseToken(i.token);
    if (!t) return { invalid: true };
    const row = (await c.query('SELECT * FROM tickets WHERE serial=$1', [t.serial])).rows[0];
    return row ? { row, stale: row.token_version !== t.version } : { invalid: true };
  }
  const code = String(i.code ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (!code) return { invalid: true };
  const row = (await c.query('SELECT * FROM tickets WHERE short_code=$1 OR serial=$1 ORDER BY created_at DESC LIMIT 1', [code])).rows[0];
  return row ? { row, stale: false } : { invalid: true };
}

/** The fixture a ticket is being used for right now: the one named by the gate, else the one whose entry window contains `at`. */
async function fixtureInPlay(c, t, wanted, at) {
  const { fixtures, wholeEvent } = await coveredFixtures(c, t.event_id, t.product_id, { all: true });
  if (wholeEvent) {
    const ev = await eventOf(c, t.event_id);
    const day = at.toISOString().slice(0, 10), from = new Date(ev.starts_on).toISOString().slice(0, 10), to = new Date(ev.ends_on ?? ev.starts_on).toISOString().slice(0, 10);
    return day >= from && day <= to ? { fixture: null, scope: `d:${day}` } : { result: 'wrong_date' };
  }
  if (wanted) {
    const f = fixtures.find((x) => x.id === wanted);
    if (!f) return { result: 'wrong_fixture' };
    if (f.status === 'cancelled') return { result: 'fixture_cancelled' };
    return inWindow(f, at) ? { fixture: f, scope: f.id } : { result: 'wrong_date' };
  }
  const open = fixtures.filter((f) => f.status !== 'cancelled' && inWindow(f, at));
  if (open.length) return { fixture: open[0], scope: open[0].id };
  return { result: fixtures.some((f) => f.status !== 'cancelled') ? 'wrong_date' : 'fixture_cancelled' };
}
const inWindow = (f, at) => {
  const start = +new Date(f.scheduled_at);
  return +at >= start - ENTRY_BEFORE_MIN * 60e3 && +at <= start + (Number(f.duration_min) + ENTRY_AFTER_MIN) * 60e3;
};

/** The minimum a steward needs: the verdict, the class, where to sit and what was used before. No name, no email, no price. */
async function gateView(c, result, t, extra = {}) {
  if (!t) return { result, admitted: false };
  const [sec, product, first] = await Promise.all([
    t.section_id ? c.query('SELECT name FROM ticket_sections WHERE id=$1', [t.section_id]).then((r) => r.rows[0]) : null,
    c.query('SELECT name, reentry FROM ticket_products WHERE id=$1', [t.product_id]).then((r) => r.rows[0]),
    c.query('SELECT a.first_in_at, a.entries, a.inside, p.name AS gate FROM ticket_attendance a LEFT JOIN access_points p ON p.id=a.access_point_id WHERE a.entitlement_id=$1 ORDER BY a.first_in_at DESC LIMIT 1', [t.entitlement_id]).then((r) => r.rows[0]),
  ]);
  return {
    result, admitted: ADMITTED.has(result), ticket_id: t.serial, short_code: t.short_code, class: t.class, class_label: t.class_label, product: product?.name, section: sec?.name ?? null, seat: t.seat_label, reentry: product?.reentry === 'reentry',
    ...(first && ['duplicate', 'no_reentry', 're_entry', 'exit'].includes(result) ? { previous: { at: first.first_in_at, gate: first.gate ?? null, entries: first.entries, inside: first.inside } } : {}),
    ...extra,
  };
}

/**
 * Judge and record one scan. Deterministic, idempotent on `client_ref`, and atomic per entitlement: two stewards scanning the same ticket at once
 * produce exactly one admission and one 'duplicate'. `check_only` answers without recording (the lookup / search path).
 */
export async function scanOne(c, ev, op, i) {
  const at = i.scanned_at ? new Date(Math.min(+new Date(i.scanned_at), Date.now())) : new Date();
  if (i.client_ref) {
    const prior = (await c.query('SELECT s.*, t.serial FROM ticket_scans s LEFT JOIN tickets t ON t.id=s.ticket_id WHERE s.event_id=$1 AND s.client_ref=$2', [ev.id, i.client_ref])).rows[0];
    if (prior) return { ...(await gateView(c, prior.result, prior.ticket_id ? await loadTicket(c, prior.ticket_id) : null)), replay: true };
  }
  const found = await findTicket(c, i);
  const t = found.row ?? null;
  let result = 'invalid', fixtureId = null, scope = null, product = null;
  const direction = i.direction ?? 'in';
  if (t) {
    await lockEntitlement(c, t.entitlement_id);
    const fresh = (await c.query('SELECT * FROM tickets WHERE id=$1', [t.id])).rows[0];
    product = (await c.query('SELECT * FROM ticket_products WHERE id=$1', [t.product_id])).rows[0];
    if (t.event_id !== ev.id) result = 'wrong_event';
    else if (i.method === 'offline' && Date.now() - +at > OFFLINE_MAX_AGE_H * 3600e3) result = 'stale';
    else if (found.stale) result = 'replaced';
    else if (fresh.status === 'transferred') result = 'transferred';
    else if (fresh.status === 'reserved') result = 'not_issued';
    else if (fresh.status === 'void') result = 'void';
    else if (['refund_due', 'refunded'].includes(fresh.status)) result = 'refunded';
    else if (product.access_point_ids.length && !product.access_point_ids.includes(i.access_point_id ?? '')) result = 'wrong_gate';
    else {
      const play = await fixtureInPlay(c, fresh, i.fixture_id, at);
      if (play.result) result = play.result;
      else {
        fixtureId = play.fixture?.id ?? null; scope = play.scope;
        const existing = (await c.query('SELECT * FROM ticket_attendance WHERE entitlement_id=$1 AND scope_key=$2', [fresh.entitlement_id, scope])).rows[0];
        const reentry = product.reentry === 'reentry';
        if (direction === 'out') result = !reentry ? 'no_reentry' : existing?.inside ? 'exit' : 'not_inside';
        else if (!existing) result = 'valid';
        else if (existing.inside || !reentry) result = 'duplicate';
        else result = 're_entry';
        if (!i.check_only) {
          if (result === 'valid') {
            const ins = (await c.query(
              `INSERT INTO ticket_attendance(ticket_id, entitlement_id, event_id, fixture_id, scope_key, access_point_id, operator_id, first_in_at, last_scan_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
               ON CONFLICT (entitlement_id, scope_key) DO NOTHING RETURNING id`, [fresh.id, fresh.entitlement_id, ev.id, fixtureId, scope, i.access_point_id ?? null, op.id, at])).rows[0];
            if (!ins) result = 'duplicate';
          } else if (result === 're_entry') await c.query('UPDATE ticket_attendance SET inside=true, entries=entries+1, last_scan_at=$2 WHERE id=$1', [existing.id, at]);
          else if (result === 'exit') await c.query('UPDATE ticket_attendance SET inside=false, last_scan_at=$2 WHERE id=$1', [existing.id, at]);
        }
      }
    }
  }
  if (!i.check_only) {
    const ins = await c.query(
      `INSERT INTO ticket_scans(event_id, ticket_id, fixture_id, access_point_id, operator_id, direction, method, result, client_ref, scanned_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (event_id, client_ref) WHERE client_ref IS NOT NULL DO NOTHING`,
      [ev.id, t?.event_id === ev.id ? t.id : null, fixtureId, i.access_point_id ?? null, op.id, direction, i.method ?? 'camera', result, i.client_ref ?? null, at]);
    if (!ins.rowCount && i.client_ref) return { ...(await gateView(c, result, t)), replay: true };
  }
  return gateView(c, result, t && t.event_id === ev.id ? t : null);
}
