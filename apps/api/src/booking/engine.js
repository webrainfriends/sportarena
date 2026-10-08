// The booking engine: slot grid, opening hours, pricing rules, discounts, race-free placement and cancellation policy.
// Everything that touches capacity runs inside a caller-supplied transaction after taking the per-resource advisory lock,
// so no combination of concurrent requests can oversell an area.
import { randomBytes } from 'node:crypto';
import { pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { notify, notifyVenueTeam } from '../notify.js';
import { toLocal, fromLocal, addDays } from './time.js';
import { reconcileInvoices, encryptBilling } from './invoices.js';
import { paymentsEnabled } from '../payments/service.js';
import { config } from '../config.js';

const SLOT_MS = (r) => r.slot_minutes * 60_000;
const uniq = (a) => [...new Set(a)];

// ------------------------------------------------------------------ locking & capacity
/** Same key the legacy booking path uses, so old and new bookings serialise against each other. */
export const lockResource = (c, id) => c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [id]);
export async function lockResources(c, ids) {
  for (const id of uniq(ids).sort()) await lockResource(c, id);
}

/** Units of a resource already taken in [start, end). */
export async function usedUnits(c, resourceId, start, end, excludeBooking) {
  const r = await c.query(
    "SELECT coalesce(sum(quantity),0)::int AS used FROM bookings WHERE resource_id=$1 AND status IN ('confirmed','no_show') AND starts_at < $3 AND ends_at > $2 AND ($4::uuid IS NULL OR id <> $4)",
    [resourceId, start, end, excludeBooking ?? null]);
  return r.rows[0].used;
}

/** A block (maintenance, holiday, ...) overlapping the window on this area or on the whole venue. */
export async function blockedBy(c, venueId, resourceId, start, end) {
  return (await c.query(
    'SELECT * FROM venue_blocks WHERE released_at IS NULL AND venue_id=$1 AND (resource_id IS NULL OR resource_id=$2) AND starts_at < $4 AND ends_at > $3 ORDER BY starts_at LIMIT 1',
    [venueId, resourceId, start, end])).rows[0] ?? null;
}

// ------------------------------------------------------------------ venue context
export async function loadVenueCtx(c, venueId) {
  const venue = (await c.query('SELECT * FROM venues WHERE id=$1', [venueId])).rows[0];
  if (!venue) throw notFound('Venue');
  const [hours, rules] = await Promise.all([
    c.query('SELECT weekday, opens_min, closes_min FROM venue_hours WHERE venue_id=$1 AND removed_at IS NULL ORDER BY weekday, opens_min', [venueId]),
    c.query('SELECT * FROM price_rules WHERE venue_id=$1 AND active', [venueId]),
  ]);
  return { venue, hours: hours.rows, rules: rules.rows };
}

/** Opening intervals [opens, closes) in minutes for a local weekday; no hours configured = open 24h. */
export function openIntervals(ctx, weekday) {
  if (!ctx.hours.length) return [[0, 1440]];
  return ctx.hours.filter((h) => h.weekday === weekday).map((h) => [h.opens_min, h.closes_min]);
}

// ------------------------------------------------------------------ pricing
const inDateRange = (date, from, to) => (!from || date >= toDate(from)) && (!to || date <= toDate(to));
const toDate = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

/** Hourly rate for the slot starting at `start`: most specific matching rule, else the area's base rate. */
export function hourlyRate(ctx, resource, start) {
  const l = toLocal(start, ctx.venue.timezone);
  const hit = ctx.rules
    .filter((r) => (r.resource_id === null || r.resource_id === resource.id)
      && (!r.weekdays || r.weekdays.includes(l.weekday)) && l.minutes >= r.start_min && l.minutes < r.end_min && inDateRange(l.date, r.valid_from, r.valid_to))
    .sort((a, b) => (b.resource_id ? 1 : 0) - (a.resource_id ? 1 : 0) || b.priority - a.priority || b.created_at - a.created_at)[0];
  return { rate: hit ? hit.hourly_rate_cents : resource.hourly_rate_cents, rule: hit ?? null };
}

/** Price of `quantity` units for [start, end), slot by slot (so a booking can straddle peak and off-peak). */
export function priceWindow(ctx, resource, start, end, quantity = 1) {
  const slots = Math.round((end - start) / SLOT_MS(resource));
  let base = 0;
  for (let k = 0; k < slots; k++) base += Math.round(hourlyRate(ctx, resource, new Date(start.getTime() + k * SLOT_MS(resource))).rate * resource.slot_minutes / 60) * quantity;
  return { slots, base_cents: base };
}

// ------------------------------------------------------------------ window validation
/** Checks a booking window against the venue's rules. Staff overrides skip the "customer" rules. */
export function checkWindow(ctx, resource, start, end, { staff = false, now = new Date() } = {}) {
  const { venue } = ctx;
  if (!(end > start)) throw badRequest('ends_at must be after starts_at');
  const dur = (end - start) / 60_000;
  if (!Number.isInteger(dur / resource.slot_minutes)) throw badRequest(`${resource.name} is booked in ${resource.slot_minutes}-minute slots`);
  const slots = dur / resource.slot_minutes;
  const l = toLocal(start, venue.timezone);
  if (l.minutes % resource.slot_minutes !== 0) throw badRequest(`Slots on ${resource.name} start on the ${resource.slot_minutes}-minute grid`);
  if (staff) return { slots };
  if (start < now) throw badRequest('Cannot book in the past');
  if (start < new Date(now.getTime() + venue.min_notice_minutes * 60_000)) throw badRequest(`${venue.name} needs at least ${venue.min_notice_minutes} minutes' notice`);
  if (start > new Date(now.getTime() + venue.max_advance_days * 864e5)) throw badRequest(`${venue.name} takes bookings up to ${venue.max_advance_days} days ahead`);
  if (slots < resource.min_slots) throw badRequest(`${resource.name} needs at least ${resource.min_slots} slot(s) per booking`);
  if (slots > resource.max_slots) throw badRequest(`${resource.name} allows at most ${resource.max_slots} slots per booking`);
  const endMin = l.minutes + dur;
  if (endMin > 1440) throw badRequest('A booking cannot run past midnight — book the next day separately');
  if (!openIntervals(ctx, l.weekday).some(([o, c]) => l.minutes >= o && endMin <= c)) throw badRequest(`${venue.name} is closed at that time`);
  return { slots };
}

// ------------------------------------------------------------------ discounts
function discountAmount(d, items) {
  const base = items.reduce((s, i) => s + i.base_cents, 0);
  return d.kind === 'percent' ? Math.floor(base * d.value / 100) : Math.min(d.value, base);
}

function eligibleItems(d, items, tz) {
  return items.filter((i) => {
    if (d.resource_id && d.resource_id !== i.resource_id) return false;
    const l = toLocal(i.starts_at, tz);
    return (!d.weekdays || d.weekdays.includes(l.weekday)) && inDateRange(l.date, d.valid_from, d.valid_to);
  });
}

/**
 * Re-evaluate discounts for every active line of a reservation and refresh totals. The best single discount per venue wins
 * (automatic ones plus any promo code the customer entered for that venue). Cancelled lines keep what they were charged.
 */
export async function repriceReservation(c, reservationId) {
  const rs = (await c.query('SELECT * FROM reservations WHERE id=$1 FOR UPDATE', [reservationId])).rows[0];
  const items = (await c.query(
    `SELECT b.id, b.resource_id, b.starts_at, b.slots, b.base_cents, r.venue_id, v.timezone, v.tax_rate_bp, v.tax_inclusive
       FROM bookings b JOIN resources r ON r.id=b.resource_id JOIN venues v ON v.id=r.venue_id
      WHERE b.reservation_id=$1 AND b.status IN ('confirmed','no_show') ORDER BY b.created_at, b.id`, [reservationId])).rows;
  const codes = rs.promo_codes.map((x) => x.toUpperCase());
  await c.query('DELETE FROM discount_redemptions WHERE reservation_id=$1', [reservationId]);

  const applied = new Map(); // booking id -> discount cents
  const usedCodes = new Set();
  for (const venueId of uniq(items.map((i) => i.venue_id))) {
    const group = items.filter((i) => i.venue_id === venueId);
    const tz = group[0].timezone;
    // lock discounts that have limits so concurrent redemptions can't overshoot them
    await c.query('SELECT id FROM discounts WHERE venue_id=$1 AND (max_redemptions IS NOT NULL OR per_user_limit IS NOT NULL) ORDER BY id FOR UPDATE', [venueId]);
    const { rows: ds } = await c.query(
      `SELECT d.*, (SELECT count(*)::int FROM discount_redemptions x WHERE x.discount_id=d.id) AS used,
              (SELECT count(*)::int FROM discount_redemptions x WHERE x.discount_id=d.id AND x.user_id=$2) AS used_by_user
         FROM discounts d WHERE d.venue_id=$1 AND d.active`, [venueId, rs.user_id]);
    let best = null;
    for (const d of ds) {
      if (d.code && !codes.includes(d.code.toUpperCase())) continue;
      if ((d.max_redemptions && d.used >= d.max_redemptions) || (d.per_user_limit && d.used_by_user >= d.per_user_limit)) continue;
      const el = eligibleItems(d, group, tz);
      if (el.reduce((s, i) => s + i.slots, 0) < d.min_slots) continue;
      const amount = discountAmount(d, el);
      if (amount > 0 && (!best || amount > best.amount)) best = { d, amount, el };
    }
    if (!best) continue;
    if (best.d.code) usedCodes.add(best.d.code.toUpperCase());
    // spread over the eligible lines pro rata, remainder to the biggest lines so cents always add up
    const base = best.el.reduce((s, i) => s + i.base_cents, 0);
    const shares = best.el.map((i) => ({ i, cents: Math.floor(best.amount * i.base_cents / base) }));
    let rest = best.amount - shares.reduce((s, x) => s + x.cents, 0);
    for (const s of [...shares].sort((a, b) => b.i.base_cents - a.i.base_cents)) { if (rest <= 0) break; s.cents++; rest--; }
    for (const s of shares) applied.set(s.i.id, s.cents);
    await c.query('INSERT INTO discount_redemptions(discount_id, reservation_id, user_id, amount_cents) VALUES ($1,$2,$3,$4)', [best.d.id, reservationId, rs.user_id, best.amount]);
  }
  for (const i of items) {
    const disc = applied.get(i.id) ?? 0;
    const price = i.base_cents - disc;
    const tax = i.tax_inclusive ? Math.round((price * i.tax_rate_bp) / (10000 + i.tax_rate_bp)) : Math.round((price * i.tax_rate_bp) / 10000);
    await c.query('UPDATE bookings SET discount_cents=$2, price_cents=$3, tax_cents=$4, payable_cents=$5 WHERE id=$1', [i.id, disc, price, tax, price + (i.tax_inclusive ? 0 : tax)]);
  }
  // totals: one set of figures per currency (a basket can span venues that price in different currencies)
  const per = (await c.query(
    `SELECT v.currency, coalesce(sum(b.base_cents),0)::int AS sub, coalesce(sum(b.discount_cents),0)::int AS disc, coalesce(sum(b.tax_cents),0)::int AS tax, coalesce(sum(b.payable_cents),0)::int AS payable, count(*)::int AS n
       FROM bookings b JOIN resources r ON r.id=b.resource_id JOIN venues v ON v.id=r.venue_id
      WHERE b.reservation_id=$1 AND b.status IN ('confirmed','no_show') GROUP BY v.currency`, [reservationId])).rows;
  const single = per.length === 1 ? per[0] : null;
  await c.query('UPDATE reservations SET currency=$7, subtotal_cents=$2, discount_cents=$3, total_cents=$2::int-$3::int, tax_cents=$4, payable_cents=$5, status=$6, updated_at=now() WHERE id=$1',
    [reservationId, single?.sub ?? 0, single?.disc ?? 0, single?.tax ?? 0, single?.payable ?? 0, per.length ? 'confirmed' : 'cancelled', per.length > 1 ? 'MULTI' : single?.currency ?? rs.currency]);
  await reconcileInvoices(c, reservationId);
  return { unused_codes: rs.promo_codes.filter((x) => !usedCodes.has(x.toUpperCase())) };
}

// ------------------------------------------------------------------ placing bookings
const newCode = () => randomBytes(5).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 7).toUpperCase().padEnd(7, 'X');

/** Core insert for one line. Caller holds the resource locks. Throws on any rule violation. */
async function placeLine(c, ctx, resource, line, { reservationId, userId, teamId, staff, source, ignoreBlocks, price, guest, note }) {
  const start = new Date(line.starts_at), end = new Date(line.ends_at);
  const qty = line.quantity ?? 1;
  const { slots } = checkWindow(ctx, resource, start, end, { staff });
  if (line.players && resource.max_players && line.players > resource.max_players * qty) throw badRequest(`${resource.name} fits ${resource.max_players * qty} players`);
  if (qty > resource.capacity) throw badRequest(`${resource.name} has ${resource.capacity} unit(s)`);
  if (!ignoreBlocks) {
    const blk = await blockedBy(c, resource.venue_id, resource.id, start, end);
    if (blk) throw conflict(`${resource.name} is blocked then${blk.reason ? ` (${blk.reason})` : ''}`);
  }
  const used = await usedUnits(c, resource.id, start, end);
  if (used + qty > resource.capacity) throw conflict(`${resource.name} is not available for that slot (${Math.max(0, resource.capacity - used)} of ${resource.capacity} free)`);
  const priced = priceWindow(ctx, resource, start, end, qty);
  const base = price ?? priced.base_cents;
  return (await c.query(
    `INSERT INTO bookings(resource_id, user_id, team_id, reservation_id, starts_at, ends_at, quantity, slots, players, base_cents, price_cents, source, note, guest_name_enc, guest_phone_enc)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,$13,$14) RETURNING *`,
    [resource.id, userId, teamId ?? null, reservationId, start, end, qty, slots, line.players ?? null, base, source, note ?? line.note ?? null, guest?.name ?? null, guest?.phone ?? null])).rows[0];
}

export async function loadResources(c, ids) {
  const { rows } = await c.query(
    `SELECT r.*, v.owner_id AS venue_owner FROM resources r JOIN venues v ON v.id=r.venue_id WHERE r.id = ANY($1::uuid[]) AND r.active AND v.active`, [uniq(ids)]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of ids) if (!byId.has(id)) throw notFound('Bookable area');
  return byId;
}

/**
 * Create a reservation: one or many lines across one or many areas / venues, all-or-nothing.
 * `collect` (used by quotes) records per-line problems instead of throwing so the caller can show every issue at once.
 */
export async function createReservation(c, { user, userId = user.id, items, promo_codes = [], note, billing, ...rest }) {
  const resources = await loadResources(c, items.map((i) => i.resource_id));
  const currencies = await currenciesOf(c, [...resources.values()]);
  const rs = (await c.query('INSERT INTO reservations(code, user_id, currency, promo_codes, note, billing_enc) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [newCode(), userId, currencies.length > 1 ? 'MULTI' : currencies[0], promo_codes, note ?? null, billing ? encryptBilling(billing) : null])).rows[0];
  const out = await addLines(c, rs, { userId, items, note, ...rest });
  const deadline = rest.staff ? null : await applyPaymentDeadline(c, rs.id, out.venueIds);
  return { reservationId: rs.id, ...out, payment_deadline: deadline };
}

/** How a venue is really paid: online modes need a payment provider to be switched on, otherwise it is pay-at-venue. */
export const effectivePaymentMode = (venue) => (venue.payment_mode !== 'pay_at_venue' && paymentsEnabled() ? venue.payment_mode : 'pay_at_venue');

/** Venues that insist on online payment give the customer a few minutes to pay before the slots are released. */
export async function applyPaymentDeadline(c, reservationId, venueIds) {
  const { rows } = await c.query('SELECT * FROM venues WHERE id = ANY($1::uuid[])', [venueIds]);
  if (!rows.some((v) => effectivePaymentMode(v) === 'online_required')) return null;
  return (await c.query("UPDATE reservations SET payment_deadline = now() + make_interval(mins => $2) WHERE id=$1 RETURNING payment_deadline", [reservationId, config.holdMinutes])).rows[0].payment_deadline;
}

/** Place lines on an existing reservation (also used to add slots later). Locks every area first, in a stable order. */
export async function addLines(c, rs, { userId, items, team_id, staff = false, source = 'user', ignoreBlocks = false, prices, guest, note, collect = false }) {
  const resources = await loadResources(c, items.map((i) => i.resource_id));
  await lockResources(c, items.map((i) => i.resource_id));
  const ctxs = new Map();
  const lines = [], problems = [];
  for (const [idx, line] of items.entries()) {
    const res = resources.get(line.resource_id);
    if (!ctxs.has(res.venue_id)) ctxs.set(res.venue_id, await loadVenueCtx(c, res.venue_id));
    try {
      lines.push(await placeLine(c, ctxs.get(res.venue_id), res, line, { reservationId: rs.id, userId, teamId: team_id, staff, source, ignoreBlocks, price: prices?.[idx], guest, note }));
    } catch (e) {
      if (!collect || !e.status) throw e;
      problems.push({ index: idx, resource_id: res.id, code: e.code, message: e.message });
    }
  }
  const { unused_codes } = await repriceReservation(c, rs.id);
  if (unused_codes.length) {
    // a code that exists but lost to a better discount (or isn't eligible yet) is reported back; one that exists nowhere is an error
    const known = (await c.query('SELECT DISTINCT upper(code) AS code FROM discounts WHERE active AND upper(code) = ANY($1::text[]) AND venue_id = ANY($2::uuid[])',
      [unused_codes.map((x) => x.toUpperCase()), [...ctxs.keys()]])).rows.map((r) => r.code);
    const unknown = unused_codes.filter((x) => !known.includes(x.toUpperCase()));
    if (unknown.length && !collect) throw badRequest(`Discount code ${unknown.map((x) => `"${x}"`).join(', ')} is not valid for these venues`);
    problems.push(...unknown.map((x) => ({ code: 'invalid_code', message: `Discount code "${x}" is not valid for these venues` })));
  }
  return { lines, problems, unused_codes, venueIds: [...ctxs.keys()] };
}

async function currenciesOf(c, resourceRows) {
  const { rows } = await c.query('SELECT DISTINCT currency FROM venues WHERE id = ANY($1::uuid[])', [uniq(resourceRows.map((r) => r.venue_id))]);
  return rows.map((r) => r.currency);
}

/** Full view of a reservation with its lines. */
export async function reservationView(c, id) {
  const rs = (await c.query('SELECT * FROM reservations WHERE id=$1', [id])).rows[0];
  if (!rs) throw notFound('Reservation');
  const { rows: bookings } = await c.query(
    `SELECT b.id, b.resource_id, b.starts_at, b.ends_at, b.quantity, b.slots, b.players, b.status, b.base_cents, b.discount_cents, b.price_cents, b.refund_cents,
            b.payment_status, b.source, b.team_id, b.note, b.cancel_reason, b.cancelled_at, b.tax_cents, b.payable_cents,
            r.name AS resource_name, r.kind, v.id AS venue_id, v.name AS venue_name, v.timezone, v.currency
       FROM bookings b JOIN resources r ON r.id=b.resource_id JOIN venues v ON v.id=r.venue_id
      WHERE b.reservation_id=$1 ORDER BY b.starts_at, b.id`, [id]);
  const { rows: invoices } = await c.query(
    `SELECT i.id, i.number, i.kind, i.status, i.venue_id, v.name AS venue_name, i.currency, i.total_cents, i.tax_cents, i.tax_inclusive, i.refund_status, i.issued_at, i.paid_at, v.payment_mode
       FROM invoices i JOIN venues v ON v.id=i.venue_id WHERE i.reservation_id=$1 ORDER BY i.issued_at, i.number`, [id]);
  const totals = new Map();
  for (const b of bookings.filter((x) => x.status === 'confirmed' || x.status === 'no_show')) {
    const t = totals.get(b.currency) ?? { currency: b.currency, subtotal_cents: 0, discount_cents: 0, total_cents: 0, tax_cents: 0, payable_cents: 0 };
    t.subtotal_cents += b.base_cents; t.discount_cents += b.discount_cents; t.total_cents += b.price_cents; t.tax_cents += b.tax_cents; t.payable_cents += b.payable_cents;
    totals.set(b.currency, t);
  }
  return { ...rs, billing_enc: undefined, bookings, invoices: invoices.map((i) => ({ ...i, payment_mode: effectivePaymentMode(i) })), totals: [...totals.values()], awaiting_payment: !!rs.payment_deadline && rs.status === 'confirmed' };
}

// ------------------------------------------------------------------ cancellation
/** What a customer gets back for cancelling now. Venue-side cancellations are always refunded in full. */
export function refundFor(venue, booking, { byVenue = false, now = new Date() } = {}) {
  if (byVenue) return booking.payable_cents;
  const cutoff = new Date(booking.starts_at.getTime() - venue.cancel_free_hours * 3_600_000);
  return now <= cutoff ? booking.payable_cents : Math.floor(booking.payable_cents * venue.late_cancel_refund_percent / 100);
}

/**
 * Cancel confirmed bookings (already authorised by the caller), update reservation totals and notify.
 * `byVenue` = initiated by the venue team: full refund, and the customer is told.
 */
export async function cancelBookings(c, bookingIds, { actor, byVenue, reason, waive = false, silent = false }) {
  const out = [];
  const touched = new Set();
  for (const id of bookingIds) {
    const b = (await c.query(
      `SELECT b.*, r.name AS resource_name, r.venue_id FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE b.id=$1 FOR UPDATE OF b`, [id])).rows[0];
    if (!b || b.status !== 'confirmed') continue;
    const venue = (await c.query('SELECT * FROM venues WHERE id=$1', [b.venue_id])).rows[0];
    if (!byVenue && b.starts_at <= new Date()) throw badRequest('That booking has already started');
    const refund = waive ? b.payable_cents : refundFor(venue, b, { byVenue });
    const pay = b.payment_status === 'paid' && refund > 0 ? 'refund_due' : b.payment_status;
    await c.query("UPDATE bookings SET status='cancelled', refund_cents=$2, cancelled_at=now(), cancelled_by=$3, cancel_reason=$4, payment_status=$5, updated_at=now() WHERE id=$1",
      [id, refund, actor.id, reason ?? null, pay]);
    if (b.reservation_id) touched.add(b.reservation_id);
    c.afterCommit?.(() => import('./alerts.js').then((m) => m.kickAlerts(venue.id))); // someone may be waiting for exactly this slot
    const what = `${b.resource_name} at ${venue.name}, ${b.starts_at.toISOString()}`;
    const data = { booking_id: id, reservation_id: b.reservation_id, venue_id: venue.id, refund_cents: refund };
    if (silent) { /* the caller sends its own message */ } else if (byVenue && b.user_id !== actor.id) {
      await notify(c, b.user_id, { kind: 'booking_cancelled', title: 'Your booking was cancelled by the venue', body: `${what}.${reason ? ` Reason: ${reason}.` : ''} You're refunded in full.`, data });
    } else {
      await notify(c, b.user_id, { kind: 'booking_cancelled', title: 'Booking cancelled', body: `${what}. Refund due: ${refund} (minor units).`, data });
      await notifyVenueTeam(c, venue, actor.id, { kind: 'booking_cancelled', title: 'A booking was cancelled', body: what, data });
    }
    out.push({ id, refund_cents: refund, fee_cents: b.payable_cents - refund });
  }
  for (const rid of touched) await repriceReservation(c, rid);
  return out;
}

// ------------------------------------------------------------------ availability grid
/**
 * Slot-by-slot availability for one local date. Each slot: free units, price and a status
 * (free | booked | blocked | past | too_soon | too_far). `bookings` and `blocks` are the venue's rows overlapping that day.
 */
export function daySlots(ctx, resource, date, { bookings, blocks, now = new Date() }) {
  const { venue } = ctx;
  const weekday = toLocal(fromLocal(date, 12 * 60, venue.timezone), venue.timezone).weekday;
  const out = [];
  for (const [open, close] of openIntervals(ctx, weekday)) {
    for (let m = Math.ceil(open / resource.slot_minutes) * resource.slot_minutes; m + resource.slot_minutes <= close; m += resource.slot_minutes) {
      const start = fromLocal(date, m, venue.timezone);
      const end = new Date(start.getTime() + SLOT_MS(resource));
      const used = bookings.filter((b) => b.resource_id === resource.id && b.starts_at < end && b.ends_at > start).reduce((s, b) => s + b.quantity, 0);
      const blocked = blocks.some((b) => (b.resource_id === null || b.resource_id === resource.id) && b.starts_at < end && b.ends_at > start);
      const free = blocked ? 0 : Math.max(0, resource.capacity - used);
      let status = blocked ? 'blocked' : free > 0 ? 'free' : 'booked';
      if (status === 'free') {
        if (start < now) status = 'past';
        else if (start < new Date(now.getTime() + venue.min_notice_minutes * 60_000)) status = 'too_soon';
        else if (start > new Date(now.getTime() + venue.max_advance_days * 864e5)) status = 'too_far';
      }
      out.push({ starts_at: start, ends_at: end, free_units: free, status, price_cents: Math.round(hourlyRate(ctx, resource, start).rate * resource.slot_minutes / 60) });
    }
  }
  return out;
}

/** Bookings and blocks of a venue overlapping [from, to). */
export async function loadBusy(c, venueId, from, to) {
  const [b, k] = await Promise.all([
    c.query(`SELECT b.resource_id, b.starts_at, b.ends_at, b.quantity FROM bookings b JOIN resources r ON r.id=b.resource_id
              WHERE r.venue_id=$1 AND b.status IN ('confirmed','no_show') AND b.starts_at < $3 AND b.ends_at > $2`, [venueId, from, to]),
    c.query('SELECT resource_id, starts_at, ends_at FROM venue_blocks WHERE released_at IS NULL AND venue_id=$1 AND starts_at < $3 AND ends_at > $2', [venueId, from, to]),
  ]);
  return { bookings: b.rows, blocks: k.rows };
}

/** First bookable slot (optionally `slots` long) in the next `days` local days, for a set of areas. */
export async function nextFreeSlot(c, ctx, resources, { from = new Date(), days = 14, slots = 1 } = {}) {
  const startDate = toLocal(from, ctx.venue.timezone).date;
  const last = addDays(startDate, days);
  const busy = await loadBusy(c, ctx.venue.id, from, fromLocal(last, 0, ctx.venue.timezone));
  let best = null;
  for (let d = startDate; d <= last; d = addDays(d, 1)) {
    for (const r of resources) {
      const grid = daySlots(ctx, r, d, { ...busy, now: from });
      for (let i = 0; i + slots <= grid.length; i++) {
        const run = grid.slice(i, i + slots);
        const contiguous = run.every((s, k) => s.status === 'free' && (k === 0 || +run[k - 1].ends_at === +s.starts_at));
        if (contiguous && (!best || run[0].starts_at < best.starts_at)) { best = { resource_id: r.id, resource_name: r.name, starts_at: run[0].starts_at, ends_at: run[slots - 1].ends_at, price_cents: run.reduce((s, x) => s + x.price_cents, 0) }; break; }
      }
    }
    if (best) return best;
  }
  return best;
}

export const canManage = async (user, venueId, c = pool) => {
  if (!user) return false;
  if (user.roles?.includes('admin')) return true;
  const r = await c.query('SELECT 1 FROM venues WHERE id=$1 AND owner_id=$2 UNION ALL SELECT 1 FROM venue_staff WHERE venue_id=$1 AND user_id=$2 AND removed_at IS NULL', [venueId, user.id]);
  return r.rowCount > 0;
};

export async function mustManage(user, venueId, c = pool) {
  const exists = (await c.query('SELECT 1 FROM venues WHERE id=$1', [venueId])).rowCount;
  if (!exists) throw notFound('Venue');
  if (!(await canManage(user, venueId, c))) throw forbidden('Only the venue team can do that');
}
