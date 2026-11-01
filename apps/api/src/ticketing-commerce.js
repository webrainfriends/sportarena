// Ticketing completion (#699): promo codes, parking and merchandise add-ons, the waitlist and the sales report.
// Everything here runs inside the transaction of an order (or of a release/refund) and under the same per-event advisory lock as the rest of
// ticketing, so a code limit, an add-on's stock and a waitlist promotion can never be raced. Reached only through src/capabilities/ticketing.js.
//   * Promo codes reuse the `discounts` / `discount_redemptions` framework. The discount is stored per ticket, so a refund returns what was charged.
//   * A waitlist offer IS a reservation: promoting someone creates a held order, which the normal capacity check counts. Oversell stays impossible.
//   * Add-ons ride in the same order and payment as the tickets, with their own stock; they never count towards spectator capacity.
import { randomBytes } from 'node:crypto';
import { pool } from './db.js';
import { badRequest, conflict, notFound } from './errors.js';
import { notify } from './notify.js';
import { isYouth } from './youth.js';
import { audit } from './helpers.js';
import { createOrder, lockEvent, priced, releaseOrder, remainingOf, rowName, seatsTaken, settingsOf, tokenFor } from './ticketing.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rnd = (n) => Array.from(randomBytes(n), (b) => ALPHABET[b & 31]).join('');
export const newAddonSerial = () => `ADD-${rnd(10)}`;
export const ADDON_KINDS = ['parking', 'merchandise', 'other'];
export const ADDON_LIVE = "(i.status IN ('issued','collected') OR (i.status='reserved' AND i.hold_expires_at > now()))";

/** Split `total` across weights so the parts add up exactly (largest remainder). */
export function allocate(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum || total <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  raw.map((r, i) => [r - Math.floor(r), i]).sort((x, y) => y[0] - x[0] || x[1] - y[1]).forEach(([, i]) => { if (left > 0) { out[i] += 1; left -= 1; } });
  return out;
}

// ---- promo codes -----------------------------------------------------------------------------------------------------------------------------------
const invalidCode = () => badRequest('That promo code is not valid for these tickets', { code: 'promo_invalid' });

/**
 * Apply the codes keyed in to the tickets just reserved for `order`. Each code is checked (window, product scope, currency, total and per-account
 * limits, whether it may be combined); percentages come off first, then fixed amounts, never more than the eligible price and never more than the code's cap.
 * The discount is shared across the tickets it applies to and stored on each, and one redemption per code is recorded against the order.
 * `made` = [{ id, product_id, line_id, price, tax }] (price is the gross price a buyer pays, tax the part of it that is tax).
 */
export async function applyPromos(c, ev, who, order, codes, made, currency) {
  const out = { total: 0, taxOff: 0, applied: [] };
  const wanted = [...new Set((codes ?? []).map((x) => String(x).trim().toUpperCase()).filter(Boolean))];
  if (!wanted.length) return out;
  const rows = (await c.query(
    `SELECT d.*, (SELECT count(*)::int FROM discount_redemptions x WHERE x.discount_id=d.id AND x.reversed_at IS NULL) AS used,
            (SELECT count(*)::int FROM discount_redemptions x WHERE x.discount_id=d.id AND x.user_id=$3 AND x.reversed_at IS NULL) AS mine
       FROM discounts d WHERE d.event_id=$1 AND d.active AND upper(d.code) = ANY($2::text[])
        AND (d.valid_from IS NULL OR d.valid_from <= current_date) AND (d.valid_to IS NULL OR d.valid_to >= current_date) ORDER BY d.created_at, d.id FOR UPDATE OF d`,
    [ev.id, wanted, who.id])).rows;
  if (rows.length !== wanted.length) throw invalidCode();   // unknown, switched off or out of its window: the same answer, so codes cannot be probed
  if (rows.length > 1) {
    const solo = rows.find((d) => !d.stackable);
    if (solo) throw conflict(`${solo.code} cannot be combined with another code`, { code: 'promo_not_stackable' });
  }
  const left = new Map(made.map((t) => [t.id, t.price]));   // what each ticket still costs after the codes applied so far
  const off = new Map(made.map((t) => [t.id, 0]));
  for (const d of [...rows].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'percent' ? -1 : 1))) {
    if (d.kind === 'fixed' && d.currency !== currency) throw invalidCode();
    const eligible = made.filter((t) => t.price > 0 && (!d.product_ids?.length || d.product_ids.includes(t.product_id)));
    if (!eligible.length) throw invalidCode();
    if (d.max_redemptions != null && d.used >= d.max_redemptions) throw conflict('That promo code has been fully used', { code: 'promo_used_up' });
    if (d.per_user_limit != null && d.mine >= d.per_user_limit) throw conflict('You have already used that promo code', { code: 'promo_limit' });
    const remaining = eligible.reduce((n, t) => n + left.get(t.id), 0);
    let amount = d.kind === 'percent' ? Math.round((remaining * d.value) / 100) : Math.min(Number(d.value), remaining);
    if (d.max_discount_minor != null) amount = Math.min(amount, Number(d.max_discount_minor));
    amount = Math.min(amount, remaining);
    if (amount <= 0) continue;
    const shares = allocate(amount, eligible.map((t) => left.get(t.id)));
    eligible.forEach((t, k) => { left.set(t.id, left.get(t.id) - shares[k]); off.set(t.id, off.get(t.id) + shares[k]); });
    await c.query('INSERT INTO discount_redemptions(discount_id, ticket_order_id, user_id, amount_cents) VALUES ($1,$2,$3,$4)', [d.id, order.id, who.id, amount]);
    out.applied.push({ code: d.code, kind: d.kind, value: d.value, amount_minor: amount });
    out.total += amount;
  }
  const perLine = new Map();
  for (const t of made) {
    const disc = off.get(t.id);
    if (!disc) continue;
    const taxOff = t.price > 0 ? Math.round((t.tax * disc) / t.price) : 0;
    await c.query('UPDATE tickets SET discount_minor=$2, discount_tax_minor=$3 WHERE id=$1', [t.id, disc, taxOff]);
    out.taxOff += taxOff;
    perLine.set(t.line_id, (perLine.get(t.line_id) ?? 0) + disc);
  }
  for (const [lineId, disc] of perLine) await c.query('UPDATE ticket_order_lines SET discount_minor=$2 WHERE id=$1', [lineId, disc]);
  return out;
}

/** Give a redemption back when its order never completed (lapsed, cancelled). The row stays, marked reversed, so history is kept. */
export const reverseRedemptions = (c, orderId) => c.query('UPDATE discount_redemptions SET reversed_at=now() WHERE ticket_order_id=$1 AND reversed_at IS NULL', [orderId]);

// ---- add-ons ---------------------------------------------------------------------------------------------------------------------------------------
export async function addonTaken(c, addonId) {
  return (await c.query(`SELECT count(*)::int AS n FROM ticket_addon_items i WHERE i.addon_id=$1 AND ${ADDON_LIVE}`, [addonId])).rows[0].n;
}

async function insertAddonItem(c, row) {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await c.query(
        `INSERT INTO ticket_addon_items(serial, short_code, event_id, addon_id, order_id, holder_id, kind, name, collect_note, price_minor, tax_minor, currency, status, hold_expires_at, issued_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [newAddonSerial(), rnd(8), row.event_id, row.addon_id, row.order_id, row.holder_id, row.kind, row.name, row.collect_note ?? null, row.price_minor, row.tax_minor, row.currency, row.status, row.hold_expires_at ?? null, row.issued_at ?? null])).rows[0];
    } catch (e) { if (e.code !== '23505' || attempt > 5 || !/serial|short_code/.test(e.constraint ?? '')) throw e; }
  }
}

/** Reserve the add-ons asked for on an order (same hold as the tickets). Returns what they add to the total. Call under the event lock. */
export async function reserveAddons(c, ev, who, order, wanted, currency) {
  const out = { total: 0, tax: 0, count: 0 };
  const byId = new Map();
  for (const w of wanted ?? []) byId.set(w.addon_id, (byId.get(w.addon_id) ?? 0) + w.quantity);
  for (const [addonId, qty] of byId) {
    const a = (await c.query('SELECT * FROM ticket_addons WHERE id=$1 AND event_id=$2', [addonId, ev.id])).rows[0];
    if (!a) throw notFound('Add-on');
    if (a.status !== 'active') throw conflict(a.status === 'paused' ? 'This add-on is paused' : 'This add-on is not on sale', { code: 'not_on_sale' });
    if (a.currency !== currency) throw badRequest('Add-ons must be in the same currency as the tickets');
    if (qty > a.per_order_limit) throw conflict(`At most ${a.per_order_limit} of ${a.name} per order`, { code: 'order_limit' });
    if (a.stock != null) {
      const taken = await addonTaken(c, a.id);
      if (taken + qty > a.stock) throw conflict(taken >= a.stock ? `${a.name} is sold out` : `Only ${a.stock - taken} of ${a.name} left`, { code: 'sold_out', remaining: Math.max(a.stock - taken, 0) });
    }
    const { gross, tax } = priced(a);
    for (let n = 0; n < qty; n++) {
      await insertAddonItem(c, { event_id: ev.id, addon_id: a.id, order_id: order.id, holder_id: who.id, kind: a.kind, name: a.name, collect_note: a.collect_note, price_minor: gross, tax_minor: tax, currency: a.currency, status: 'reserved', hold_expires_at: order.expires_at });
    }
    out.total += gross * qty; out.tax += tax * qty; out.count += qty;
  }
  if (out.count) await c.query('UPDATE ticket_orders SET addons_minor=$2 WHERE id=$1', [order.id, out.total]);
  return out;
}

/** Payment landed: issue the add-ons. A hold that lapsed has to win its stock back first; false = it cannot be honoured, so the whole payment is refunded. */
export async function confirmAddons(c, orderId) {
  const held = (await c.query("SELECT * FROM ticket_addon_items WHERE order_id=$1 AND status='reserved'", [orderId])).rows;
  if (!held.length) return true;
  const lapsed = held.filter((i) => new Date(i.hold_expires_at) <= new Date());
  const byAddon = new Map();
  for (const i of lapsed) byAddon.set(i.addon_id, (byAddon.get(i.addon_id) ?? 0) + 1);
  for (const [addonId, n] of byAddon) {
    const a = (await c.query('SELECT stock FROM ticket_addons WHERE id=$1', [addonId])).rows[0];
    if (a.stock != null && (await addonTaken(c, addonId)) + n > a.stock) return false;
  }
  await c.query("UPDATE ticket_addon_items SET status='issued', hold_expires_at=NULL, issued_at=now() WHERE order_id=$1 AND status='reserved'", [orderId]);
  return true;
}

export const releaseAddons = (c, orderId, reason) =>
  c.query("UPDATE ticket_addon_items SET status='void', ended_at=now(), end_reason=$2 WHERE order_id=$1 AND status='reserved'", [orderId, reason]);

/** What the holder sees of an add-on: the QR token only while it can still be collected. */
export const addonView = (i, { holder = false } = {}) => ({
  id: i.id, serial: i.serial, short_code: i.short_code, order_id: i.order_id, addon_id: i.addon_id, kind: i.kind, name: i.name, collect_note: i.collect_note,
  price_minor: Number(i.price_minor), currency: i.currency, status: i.status, collected_at: i.collected_at, refunded_minor: Number(i.refunded_minor),
  ...(holder ? { token: i.status === 'issued' ? tokenFor(i.serial, 1) : null } : {}),
});

/** Is this add-on refundable by its buyer? The organiser's refund policy decides, as it does for tickets; a collected item never is. */
export async function addonRefundRule(c, item, { organiser = false } = {}) {
  if (!['issued', 'collected'].includes(item.status)) return { ok: false, reason: 'This add-on is not active' };
  if (organiser) return { ok: true };
  if (item.status === 'collected') return { ok: false, reason: 'This add-on has already been collected' };
  const s = await settingsOf(c, item.event_id);
  if (s.refund_policy === 'never') return { ok: false, reason: 'Add-ons for this event are not refundable' };
  if (s.refund_policy === 'anytime') return { ok: true };
  const ev = (await c.query('SELECT starts_on FROM events WHERE id=$1', [item.event_id])).rows[0];
  const start = new Date(`${new Date(ev.starts_on).toISOString().slice(0, 10)}T00:00:00Z`);
  return Date.now() < +start - s.refund_cutoff_hours * 3600e3 ? { ok: true } : { ok: false, reason: `Refunds close ${s.refund_cutoff_hours} hours before the start` };
}

/** Pay back one add-on that is 'refund_due' through the original payment; it becomes refunded only after payments.refunded_cents moved. */
export async function settleAddonRefund(itemId) {
  const first = (await pool.query('SELECT order_id FROM ticket_addon_items WHERE id=$1', [itemId])).rows[0];
  if (!first) return { status: 'missing' };
  const lock = await pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [`ticket-refund:${first.order_id}`]);   // the same lock tickets use, so refunded_cents is never raced
    const i = (await pool.query('SELECT * FROM ticket_addon_items WHERE id=$1', [itemId])).rows[0];
    if (!i || i.status !== 'refund_due') return { status: i?.status ?? 'missing' };
    const amount = Number(i.price_minor) - Number(i.refunded_minor);
    const pay = amount > 0 ? (await pool.query("SELECT * FROM payments WHERE purpose_type='ticket_order' AND purpose_id=$1 AND status IN ('paid','refunded') ORDER BY created_at LIMIT 1", [i.order_id])).rows[0] : null;
    if (amount > 0 && !pay) return { status: 'refund_due', blocked: 'no_payment' };
    let give = 0;
    if (amount > 0) {
      const { refundPartial } = await import('./payments/service.js');
      try { give = await refundPartial(pay, amount, `addon-refund:${i.id}`); } catch (e) { return { status: 'refund_due', error: e.message }; }
      if (give < amount) { await pool.query('UPDATE ticket_addon_items SET refunded_minor = refunded_minor + $2 WHERE id=$1', [i.id, give]); return { status: 'refund_due', partial: give }; }
    }
    await pool.query("UPDATE ticket_addon_items SET status = CASE WHEN price_minor = 0 THEN 'void' ELSE 'refunded' END, refunded_minor = refunded_minor + $2 WHERE id=$1 AND status='refund_due'", [i.id, give]);
    return { status: amount > 0 ? 'refunded' : 'void', amount_minor: give };
  } finally { await lock.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`ticket-refund:${first.order_id}`]).catch(() => {}); lock.release(); }
}

export async function processAddonRefunds({ eventId = null, limit = 200 } = {}) {
  const due = (await pool.query("SELECT id FROM ticket_addon_items WHERE status='refund_due' AND ($1::uuid IS NULL OR event_id=$1) ORDER BY ended_at LIMIT $2", [eventId, limit])).rows;
  let refunded = 0, failed = 0;
  for (const r of due) { const out = await settleAddonRefund(r.id); if (out.status === 'refunded' || out.status === 'void') refunded++; else failed++; }
  return { processed: due.length, refunded, failed };
}

/** The event was cancelled: every add-on still to be collected becomes refund_due. */
export const addonsRefundDueForEvent = (c, eventId) =>
  c.query("UPDATE ticket_addon_items SET status='refund_due', ended_at=now(), end_reason='Event cancelled' WHERE event_id=$1 AND status='issued'", [eventId]);

/** Gate / desk: hand over an add-on. One atomic update, so two desks can never both collect the same item. */
export async function collectAddon(c, ev, op, { token, code }) {
  let item;
  if (token) {
    const m = /^GT1\.(ADD-[A-Z0-9]{10})\.(\d{1,6})\.([0-9a-f]{20})$/.exec(String(token).trim());
    if (!m || tokenFor(m[1], Number(m[2])) !== String(token).trim()) return { result: 'invalid' };
    item = (await c.query('SELECT * FROM ticket_addon_items WHERE serial=$1', [m[1]])).rows[0];
  } else {
    const k = String(code ?? '').trim().toUpperCase().replace(/\s+/g, '');
    item = (await c.query('SELECT * FROM ticket_addon_items WHERE short_code=$1 OR serial=$1', [k])).rows[0];
  }
  if (!item) return { result: 'invalid' };
  if (item.event_id !== ev.id) return { result: 'wrong_event' };
  const view = { name: item.name, kind: item.kind, collect_note: item.collect_note };
  if (item.status === 'collected') return { result: 'already_collected', collected_at: item.collected_at, ...view };
  if (item.status === 'reserved') return { result: 'not_issued', ...view };
  if (item.status !== 'issued') return { result: 'refunded', ...view };
  const got = (await c.query("UPDATE ticket_addon_items SET status='collected', collected_at=now(), collected_by=$2 WHERE id=$1 AND status='issued' RETURNING collected_at", [item.id, op.id])).rows[0];
  if (!got) return { result: 'already_collected', ...view };
  await audit(c, op.id, 'ticket.addon.collect', 'ticket_addon_items', item.id);
  return { result: 'collected', collected_at: got.collected_at, ...view };
}

// ---- waitlist --------------------------------------------------------------------------------------------------------------------------------------
const paymentInFlight = async (c, orderId) =>
  (await c.query("SELECT 1 FROM payments WHERE purpose_type='ticket_order' AND purpose_id=$1 AND status='pending' AND created_at > now() - interval '60 minutes' LIMIT 1", [orderId])).rowCount > 0;

/** The first free seats of a section, in row order (a waitlist offer cannot ask the person to choose). */
async function firstFreeSeats(c, ev, product, qty) {
  const s = (await c.query('SELECT * FROM ticket_sections WHERE id=$1 AND archived_at IS NULL', [product.section_id])).rows[0];
  if (!s) return null;
  const found = [];
  for (let r = 0; r < s.rows_count && found.length < qty; r++) {
    const labels = Array.from({ length: s.seats_per_row }, (_, k) => `${rowName(r)}${k + 1}`);
    const taken = new Set(await seatsTaken(c, ev.id, product, labels));
    for (const l of labels) if (!taken.has(l) && found.length < qty) found.push(l);
  }
  return found.length === qty ? found : null;
}

/**
 * Offer freed places to the people waiting, in order. Call after anything that can free inventory (an order released, a ticket refunded or voided,
 * capacity raised) and from the sweep. Each offer is a held order for `waitlist_offer_minutes`: it is counted as taken by everyone else, and if the
 * person does not pay in time it is released and the next in line is offered. Runs under the event lock.
 */
export async function promoteWaitlist(c, eventId) {
  await lockEvent(c, eventId);
  const ev = (await c.query('SELECT * FROM events WHERE id=$1', [eventId])).rows[0];
  if (!ev) return 0;
  for (const w of (await c.query("SELECT w.*, o.status AS order_status FROM ticket_waitlist w LEFT JOIN ticket_orders o ON o.id=w.order_id WHERE w.event_id=$1 AND w.status='offered' ORDER BY w.seq FOR UPDATE OF w", [eventId])).rows) {
    if (w.order_status === 'confirmed') { await c.query("UPDATE ticket_waitlist SET status='purchased', updated_at=now() WHERE id=$1", [w.id]); continue; }
    if (w.order_status === 'pending_payment') {
      if (new Date(w.offer_expires_at) > new Date() || await paymentInFlight(c, w.order_id)) continue;
      await releaseOrder(c, w.order_id, null, 'expired', 'The waitlist offer ran out', { promote: false });
    }
    await c.query("UPDATE ticket_waitlist SET status='expired', updated_at=now() WHERE id=$1", [w.id]);
    await notify(c, w.user_id, { kind: 'ticket_waitlist_expired', title: 'Your waitlist offer ran out', body: `The place held for you at ${ev.name} went to the next person.`, data: { ticket: true, event_id: ev.id } });
  }
  const settings = await settingsOf(c, eventId);
  if (!settings.waitlist_enabled || !settings.sales_open || ['cancelled', 'completed'].includes(ev.status)) return 0;
  const queue = (await c.query(
    `SELECT w.*, p.name AS product_name FROM ticket_waitlist w JOIN ticket_products p ON p.id=w.product_id
      WHERE w.event_id=$1 AND w.status='waiting' AND p.status='active' ORDER BY w.seq FOR UPDATE OF w`, [eventId])).rows;
  let offered = 0;
  for (const w of queue) {
    const product = (await c.query('SELECT * FROM ticket_products WHERE id=$1', [w.product_id])).rows[0];
    const room = await remainingOf(c, ev, product);
    if (room !== null && room < w.quantity) continue;   // does not fit yet; someone further back whose party is smaller still may
    if (await isYouth(w.user_id, c)) { await c.query("UPDATE ticket_waitlist SET status='expired', updated_at=now() WHERE id=$1", [w.id]); continue; }
    await c.query('SAVEPOINT waitlist_offer');
    try {
      const made = await createOrder(c, { id: w.user_id }, ev, { lines: [{ product_id: w.product_id, quantity: w.quantity }] },
        { channel: 'online', hold: true, offerMinutes: settings.waitlist_offer_minutes, autoSeats: true });
      const order = (await c.query('SELECT expires_at, total_minor FROM ticket_orders WHERE id=$1', [made.order_id])).rows[0];
      await c.query("UPDATE ticket_waitlist SET status='offered', order_id=$2, offered_at=now(), offer_expires_at=$3, updated_at=now() WHERE id=$1", [w.id, made.order_id, order.expires_at]);
      await c.query('RELEASE SAVEPOINT waitlist_offer');
      offered++;
      await notify(c, w.user_id, { kind: 'ticket_waitlist_offer', title: 'A place opened up', body: `${w.quantity} × ${w.product_name} for ${ev.name} is held for you for ${settings.waitlist_offer_minutes} minutes. Open My tickets to buy it.`, data: { ticket: true, event_id: ev.id, order_id: made.order_id, waitlist_id: w.id } });
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT waitlist_offer');
      if (![400, 403, 409].includes(e.status)) throw e;   // a rule that no longer allows this person (limits, window) ends their wait; anything else is a bug
      await c.query("UPDATE ticket_waitlist SET status='expired', updated_at=now() WHERE id=$1", [w.id]);
    }
  }
  return offered;
}

/** Sweep: promote on every event that has someone waiting or holding an offer. */
export async function sweepWaitlists() {
  const events = (await pool.query("SELECT DISTINCT event_id FROM ticket_waitlist WHERE status IN ('waiting','offered')")).rows;
  let n = 0;
  for (const { event_id } of events) {
    const c = await pool.connect();
    try { await c.query('BEGIN'); n += await promoteWaitlist(c, event_id); await c.query('COMMIT'); }
    catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('[tickets] waitlist promotion failed', e.message); }
    finally { c.release(); }
  }
  return n;
}

export { firstFreeSeats };

// ---- reporting -------------------------------------------------------------------------------------------------------------------------------------
/** Sales by channel, promo use, add-on attach rate, waitlist outcome, and whether the order totals reconcile to the payments that were taken. */
export async function salesReport(c, eventId) {
  const n = (v) => Number(v ?? 0);
  const channels = (await c.query(
    `SELECT o.channel, count(*)::int AS orders, coalesce(sum(o.total_minor),0) AS total, coalesce(sum(o.discount_minor),0) AS discount, coalesce(sum(o.addons_minor),0) AS addons, coalesce(sum(o.tax_minor),0) AS tax,
            (SELECT count(*)::int FROM tickets t WHERE t.order_id = ANY(array_agg(o.id)) AND t.supersedes_id IS NULL) AS tickets,
            (SELECT coalesce(sum(t.price_minor),0) FROM tickets t WHERE t.order_id = ANY(array_agg(o.id)) AND t.supersedes_id IS NULL) AS tickets_gross
       FROM ticket_orders o WHERE o.event_id=$1 AND o.status='confirmed' GROUP BY o.channel ORDER BY o.channel`, [eventId])).rows
    .map((r) => ({ channel: r.channel, orders: r.orders, tickets: r.tickets, tickets_gross_minor: n(r.tickets_gross), discount_minor: n(r.discount), addons_minor: n(r.addons), tax_minor: n(r.tax), total_minor: n(r.total) }));
  const confirmed = channels.reduce((a, r) => a + r.orders, 0);
  const promos = (await c.query(
    `SELECT d.id, d.code, d.kind, d.value, d.active, d.max_redemptions,
            count(x.*) FILTER (WHERE x.reversed_at IS NULL AND o.status='confirmed')::int AS uses, coalesce(sum(x.amount_cents) FILTER (WHERE x.reversed_at IS NULL AND o.status='confirmed'),0) AS given,
            count(x.*) FILTER (WHERE x.reversed_at IS NULL AND o.status='pending_payment')::int AS held
       FROM discounts d LEFT JOIN discount_redemptions x ON x.discount_id=d.id LEFT JOIN ticket_orders o ON o.id=x.ticket_order_id
      WHERE d.event_id=$1 GROUP BY d.id ORDER BY d.created_at`, [eventId])).rows
    .map((r) => ({ id: r.id, code: r.code, kind: r.kind, value: r.value, active: r.active, max_redemptions: r.max_redemptions, uses: r.uses, held: r.held, discount_minor: n(r.given) }));
  const addons = (await c.query(
    `SELECT a.id, a.name, a.kind, a.stock, a.currency,
            count(i.*) FILTER (WHERE i.status IN ('issued','collected','refund_due','refunded'))::int AS sold, count(i.*) FILTER (WHERE i.status='collected')::int AS collected,
            count(DISTINCT i.order_id) FILTER (WHERE i.status IN ('issued','collected','refund_due','refunded'))::int AS orders,
            coalesce(sum(i.price_minor) FILTER (WHERE i.status IN ('issued','collected','refund_due','refunded')),0) AS gross, coalesce(sum(i.refunded_minor),0) AS refunded,
            count(i.*) FILTER (WHERE ${ADDON_LIVE})::int AS taken
       FROM ticket_addons a LEFT JOIN ticket_addon_items i ON i.addon_id=a.id WHERE a.event_id=$1 GROUP BY a.id ORDER BY a.created_at`, [eventId])).rows
    .map((r) => ({ id: r.id, name: r.name, kind: r.kind, sold: r.sold, collected: r.collected, orders: r.orders, attach_rate: confirmed ? Math.round((r.orders / confirmed) * 1000) / 10 : 0, gross_minor: n(r.gross), refunded_minor: n(r.refunded), left: r.stock == null ? null : Math.max(r.stock - r.taken, 0) }));
  const waitlist = Object.fromEntries((await c.query("SELECT status, count(*)::int AS n FROM ticket_waitlist WHERE event_id=$1 GROUP BY status", [eventId])).rows.map((r) => [r.status, r.n]));
  const refunded = n((await c.query('SELECT coalesce(sum(refunded_minor),0) AS n FROM tickets WHERE event_id=$1', [eventId])).rows[0].n) + n((await c.query('SELECT coalesce(sum(refunded_minor),0) AS n FROM ticket_addon_items WHERE event_id=$1', [eventId])).rows[0].n);
  const pay = (await c.query(
    `SELECT coalesce(sum(p.amount_cents),0) AS taken, coalesce(sum(p.refunded_cents),0) AS back FROM payments p JOIN ticket_orders o ON o.id=p.purpose_id
      WHERE p.purpose_type='ticket_order' AND o.event_id=$1 AND p.status IN ('paid','refunded')`, [eventId])).rows[0];
  const paidOrders = (await c.query(
    `SELECT coalesce(sum(o.total_minor),0) AS total FROM ticket_orders o WHERE o.event_id=$1 AND o.status='confirmed' AND o.total_minor > 0`, [eventId])).rows[0];
  const promoOrders = n((await c.query("SELECT coalesce(sum(discount_minor),0) AS n FROM ticket_orders WHERE event_id=$1 AND status='confirmed'", [eventId])).rows[0].n);
  const promoRedemptions = promos.reduce((a, p) => a + p.discount_minor, 0);
  const itemsTotal = n((await c.query(
    `SELECT (SELECT coalesce(sum(t.price_minor - t.discount_minor),0) FROM tickets t JOIN ticket_orders o ON o.id=t.order_id WHERE o.event_id=$1 AND o.status='confirmed' AND t.supersedes_id IS NULL)
          + (SELECT coalesce(sum(i.price_minor),0) FROM ticket_addon_items i JOIN ticket_orders o ON o.id=i.order_id WHERE o.event_id=$1 AND o.status='confirmed') AS n`, [eventId])).rows[0].n);
  const orderTotal = n(paidOrders.total);
  const totals = channels.reduce((a, r) => ({ gross: a.gross + r.tickets_gross_minor, discount: a.discount + r.discount_minor, addons: a.addons + r.addons_minor, total: a.total + r.total_minor }), { gross: 0, discount: 0, addons: 0, total: 0 });
  return {
    event_id: eventId, currency: (await c.query("SELECT currency FROM ticket_orders WHERE event_id=$1 AND status='confirmed' ORDER BY confirmed_at LIMIT 1", [eventId])).rows[0]?.currency ?? null,
    mixed_currencies: (await c.query("SELECT count(DISTINCT currency)::int AS n FROM ticket_orders WHERE event_id=$1 AND status='confirmed'", [eventId])).rows[0].n > 1,
    channels, totals: { orders: confirmed, ...totals, refunded_minor: refunded }, promos, addons, waitlist,
    reconciliation: {
      orders_minor: orderTotal, payments_minor: n(pay.taken), difference_minor: orderTotal - n(pay.taken), payments_refunded_minor: n(pay.back), items_refunded_minor: refunded,
      lines_minor: itemsTotal, order_total_equals_lines: itemsTotal === totals.total, promo_equals_redemptions: promoOrders === promoRedemptions,
      reconciled: orderTotal === n(pay.taken) && n(pay.back) === refunded && itemsTotal === totals.total && promoOrders === promoRedemptions,
    },
  };
}
