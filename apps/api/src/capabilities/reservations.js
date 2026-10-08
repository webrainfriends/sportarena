// Customer side of venue booking: slot availability, venue comparison, multi-slot / multi-area / multi-venue reservations,
// quotes, modification, cancellation — plus the notification inbox.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { mustFind, sportBySlugOrId, isAdmin } from '../helpers.js';
import { notify, notifyVenueTeam, dispatchPending, queueReminders, inbox, DEFAULT_PREFS } from '../notify.js';
import {
  loadVenueCtx, loadBusy, daySlots, nextFreeSlot, priceWindow, checkWindow, openIntervals, usedUnits, blockedBy,
  createReservation, addLines, reservationView, repriceReservation, cancelBookings, lockResources, canManage, loadResources,
} from '../booking/engine.js';
import { fromLocal, toLocal, addDays } from '../booking/time.js';
import { mapLinks } from './venues.js';
import { canManageTeam } from './teams.js';

const TAG = 'Venues & Booking';
const dt = z.string().datetime({ offset: true });
const csv = (schema) => z.union([z.array(schema), z.string().transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))]);

const item = z.object({
  resource_id: id, starts_at: dt, ends_at: dt, quantity: z.number().int().min(1).max(1000).default(1).describe('units: tables in a hall, kit in a pool'),
  players: z.number().int().min(1).max(1000).optional(), note: z.string().max(300).optional(),
});
const basket = {
  items: z.array(item).min(1).max(20).describe('Any number of slots, on any number of areas or venues (same currency). All succeed or none does.'),
  promo_codes: z.array(z.string().min(1).max(30)).max(5).default([]), note: z.string().max(300).optional(), team_id: id.optional(),
};

// ------------------------------------------------------------------ availability
cap({
  name: 'venue_availability', method: 'GET', path: '/venues/:id/availability', tag: TAG, auth: 'public',
  summary: 'Slot grid for one day (venue local date): every area with each slot\'s status (free | booked | blocked | past | too_soon | too_far), free units and price in that slot. This is what a booking screen renders. Filter by sport or a single area.',
  input: z.object({ id, date: z.string().date(), sport: z.string().optional(), resource_id: id.optional() }),
  async handler(_, i) {
    const ctx = await loadVenueCtx(pool, i.id);
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    if (i.sport && !sport) throw notFound('Sport');
    const resources = await many(
      `SELECT r.*, s.name AS sport, s.slug AS sport_slug, s.emoji AS sport_emoji FROM resources r LEFT JOIN sports s ON s.id=r.sport_id
        WHERE r.venue_id=$1 AND r.active AND ($2::uuid IS NULL OR r.sport_id=$2) AND ($3::uuid IS NULL OR r.id=$3) ORDER BY r.kind, r.name`, [i.id, sport?.id ?? null, i.resource_id ?? null]);
    const { venue } = ctx;
    const busy = await loadBusy(pool, i.id, fromLocal(i.date, 0, venue.timezone), fromLocal(addDays(i.date, 1), 0, venue.timezone));
    const wd = toLocal(fromLocal(i.date, 720, venue.timezone), venue.timezone).weekday;
    return {
      venue: { id: venue.id, name: venue.name, timezone: venue.timezone, currency: venue.currency, active: venue.active },
      date: i.date, hours: openIntervals(ctx, wd).map(([o, c]) => ({ opens_min: o, closes_min: c })),
      resources: resources.map((r) => ({
        id: r.id, name: r.name, kind: r.kind, sport: r.sport, sport_slug: r.sport_slug, sport_emoji: r.sport_emoji, capacity: r.capacity, max_players: r.max_players,
        slot_minutes: r.slot_minutes, min_slots: r.min_slots, max_slots: r.max_slots, surface: r.surface, indoor: r.indoor,
        slots: venue.active ? daySlots(ctx, r, i.date, busy) : [],
      })),
    };
  },
});

// ------------------------------------------------------------------ compare
cap({
  name: 'compare_venues', method: 'GET', path: '/venue-comparison', tag: TAG, auth: 'public',
  summary: 'Compare 2–5 venues side by side: location and distance from you, rating, areas (count, capacity, players), rate range, opening hours, amenities, cancellation policy, automatic offers and — if you pass from/to — which areas are bookable then with a price estimate, plus the next free slot. Highlights name the cheapest, nearest, best-rated and most-available venue. Book from several of them at once with create_reservation.',
  input: z.object({
    ids: csv(id).refine((a) => a.length >= 2 && a.length <= 5, 'Compare between 2 and 5 venues'), sport: z.string().optional(),
    from: dt.optional(), to: dt.optional(), slots: z.coerce.number().int().min(1).max(12).default(1).describe('how many consecutive slots you need, for "next free"'),
    lat: z.coerce.number().min(-90).max(90).optional(), lng: z.coerce.number().min(-180).max(180).optional(),
  }).refine((i) => (i.from == null) === (i.to == null), 'from and to go together').refine((i) => (i.lat == null) === (i.lng == null), 'lat and lng go together'),
  async handler(_, i) {
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    if (i.sport && !sport) throw notFound('Sport');
    if (i.from && new Date(i.to) <= new Date(i.from)) throw badRequest('to must be after from');
    const out = [];
    for (const vid of [...new Set(i.ids)]) {
      const ctx = await loadVenueCtx(pool, vid);
      const v = ctx.venue;
      const resources = await many(
        `SELECT r.*, s.name AS sport, s.slug AS sport_slug FROM resources r LEFT JOIN sports s ON s.id=r.sport_id WHERE r.venue_id=$1 AND r.active AND ($2::uuid IS NULL OR r.sport_id=$2) ORDER BY r.kind, r.name`, [vid, sport?.id ?? null]);
      const [rating, offers] = await Promise.all([
        one("SELECT round(avg(rating),2) AS rating, count(*)::int AS reviews FROM testimonials WHERE subject_type='venue' AND subject_id=$1", [vid]),
        many("SELECT id, name, kind, value, min_slots, weekdays, valid_to, resource_id FROM discounts WHERE venue_id=$1 AND active AND code IS NULL AND (valid_to IS NULL OR valid_to >= current_date)", [vid]),
      ]);
      const areas = resources.filter((r) => r.kind !== 'equipment');
      const rateRange = (r) => {
        const rates = [r.hourly_rate_cents, ...ctx.rules.filter((x) => x.resource_id === null || x.resource_id === r.id).map((x) => x.hourly_rate_cents)];
        return { min_hourly_cents: Math.min(...rates), max_hourly_cents: Math.max(...rates) };
      };
      const view = areas.map((r) => ({
        id: r.id, name: r.name, kind: r.kind, sport: r.sport, capacity: r.capacity, max_players: r.max_players, slot_minutes: r.slot_minutes, surface: r.surface, indoor: r.indoor, ...rateRange(r),
      }));
      let window = null;
      if (i.from) {
        const [s, e] = [new Date(i.from), new Date(i.to)];
        window = { from: i.from, to: i.to, areas: [] };
        for (const r of areas) {
          let bookable = true, reason = null;
          try { checkWindow(ctx, r, s, e); } catch (err) { bookable = false; reason = err.message; }
          const used = await usedUnits(pool, r.id, s, e);
          const blocked = !!(await blockedBy(pool, vid, r.id, s, e));
          const free = blocked ? 0 : Math.max(0, r.capacity - used);
          if (bookable && free === 0) { bookable = false; reason = blocked ? 'blocked' : 'fully booked'; }
          window.areas.push({ resource_id: r.id, name: r.name, bookable, reason, free_units: free, estimated_price_cents: priceWindow(ctx, r, s, e).base_cents });
        }
        window.bookable_areas = window.areas.filter((a) => a.bookable).length;
        const prices = window.areas.filter((a) => a.bookable).map((a) => a.estimated_price_cents);
        window.cheapest_price_cents = prices.length ? Math.min(...prices) : null;
      }
      const hasGeo = i.lat != null && v.latitude != null;
      const rad = (d) => (d * Math.PI) / 180;
      const distance = hasGeo ? Math.round(6371 * 2 * Math.asin(Math.sqrt(Math.sin(rad(v.latitude - i.lat) / 2) ** 2 + Math.cos(rad(i.lat)) * Math.cos(rad(v.latitude)) * Math.sin(rad(v.longitude - i.lng) / 2) ** 2)) * 100) / 100 : null;
      out.push({
        venue: { id: v.id, name: v.name, emoji: v.emoji, city: v.city, address: v.address, latitude: v.latitude, longitude: v.longitude, map_links: mapLinks(v), phone: v.phone, website: v.website, amenities: v.amenities, currency: v.currency, timezone: v.timezone, active: v.active },
        distance_km: distance, rating: rating.rating, reviews: rating.reviews,
        policy: { min_notice_minutes: v.min_notice_minutes, max_advance_days: v.max_advance_days, cancel_free_hours: v.cancel_free_hours, late_cancel_refund_percent: v.late_cancel_refund_percent },
        hours: ctx.hours, open_around_the_clock: ctx.hours.length === 0,
        areas: view,
        totals: { areas: view.length, concurrent_capacity: view.reduce((s, a) => s + a.capacity, 0), players: view.reduce((s, a) => s + a.capacity * (a.max_players ?? 0), 0) },
        pricing: view.length ? { from_hourly_cents: Math.min(...view.map((a) => a.min_hourly_cents)), to_hourly_cents: Math.max(...view.map((a) => a.max_hourly_cents)) } : null,
        offers, window,
        next_free: v.active ? await nextFreeSlot(pool, ctx, areas, { slots: i.slots }) : null,
      });
    }
    const best = (arr, key, dir = 1) => arr.filter((x) => key(x) != null).sort((a, b) => dir * (key(a) - key(b)))[0]?.venue.id ?? null;
    return {
      venues: out,
      highlights: {
        cheapest_venue_id: best(out, (x) => (i.from ? x.window?.cheapest_price_cents : x.pricing?.from_hourly_cents)),
        nearest_venue_id: best(out, (x) => x.distance_km),
        top_rated_venue_id: best(out, (x) => x.rating, -1),
        most_available_venue_id: i.from ? best(out, (x) => x.window?.bookable_areas, -1) : null,
        earliest_free_venue_id: best(out.filter((x) => x.next_free), (x) => +x.next_free.starts_at),
      },
    };
  },
});

// ------------------------------------------------------------------ reservations
/** Shared by quote and create so the numbers can never differ. */
async function placeBasket(c, user, i, { collect }) {
  if (i.team_id) {
    const t = await mustFind('teams', i.team_id, '*', c);
    if (!(await canManageTeam(user, t))) throw forbidden('You do not manage that team');
  }
  const made = await createReservation(c, { user, items: i.items, promo_codes: i.promo_codes, note: i.note, team_id: i.team_id, collect });
  return made;
}

class Rollback extends Error {}

cap({
  name: 'quote_reservation', method: 'POST', path: '/reservations/quote', tag: TAG,
  summary: 'Price a basket without booking it: per-line availability / rule problems, base price, discounts applied, total. Runs the exact booking logic and rolls it back, so a quote that is clean means create_reservation with the same body will succeed (barring someone booking first).',
  input: z.object(basket),
  async handler({ user }, i) {
    try {
      await tx(async (c) => {
        const made = await placeBasket(c, user, i, { collect: true });
        throw Object.assign(new Rollback(), { view: await reservationView(c, made.reservationId), made });
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
      const { bookings, ...head } = e.view;
      return {
        ok: e.made.problems.length === 0, problems: e.made.problems, currency: head.currency, subtotal_cents: head.subtotal_cents, discount_cents: head.discount_cents, total_cents: head.total_cents,
        unapplied_codes: e.made.unused_codes, lines: bookings.map(({ id: _id, status: _s, payment_status: _p, refund_cents: _r, cancel_reason: _c, cancelled_at: _a, source: _o, ...l }) => l),
      };
    }
    throw new Error('unreachable');
  },
});

cap({
  name: 'create_reservation', method: 'POST', path: '/reservations', tag: TAG, status: 201,
  summary: 'Book one or many slots in one go — several slots on one court, several courts/tables, or courts at different venues (same currency). Atomic: every line is checked against opening hours, the slot grid, notice window, blocks and live capacity under per-area locks; if any fails (409/400) nothing is booked. Price rules and the best discount (automatic or your promo code) are applied. Pay at the venue; the venue team is notified.',
  input: z.object(basket),
  async handler({ user }, i) {
    return tx(async (c) => {
      const made = await placeBasket(c, user, i, { collect: false });
      const view = await reservationView(c, made.reservationId);
      const summary = view.bookings.map((b) => `${b.resource_name} (${b.venue_name}) ${b.starts_at.toISOString()}`).join('; ');
      await notify(c, user.id, { kind: 'reservation_confirmed', title: `Booked: ${view.code}`, body: `${view.bookings.length} slot(s): ${summary}. Total ${view.total_cents} (minor units), pay at the venue.`, data: { reservation_id: view.id, code: view.code } });
      for (const vid of made.venueIds) {
        const v = (await c.query('SELECT * FROM venues WHERE id=$1', [vid])).rows[0];
        await notifyVenueTeam(c, v, user.id, { kind: 'new_booking', title: `New booking ${view.code}`, body: `${user.display_name} booked ${view.bookings.filter((b) => b.venue_id === vid).length} slot(s).`, data: { reservation_id: view.id, venue_id: vid } });
      }
      return { ...view, unapplied_codes: made.unused_codes };
    });
  },
});

async function mayView(user, rs, c = pool) {
  if (rs.user_id === user.id || isAdmin(user)) return true;
  const { rows } = await c.query('SELECT DISTINCT r.venue_id FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE b.reservation_id=$1', [rs.id]);
  for (const r of rows) if (await canManage(user, r.venue_id, c)) return true;
  return false;
}

cap({
  name: 'list_reservations', method: 'GET', path: '/reservations', tag: TAG,
  summary: 'Your reservations (each with its slot lines), newest first. `upcoming: true` (default) hides ones that are over.',
  input: z.object({ upcoming: z.coerce.boolean().default(true), status: z.enum(['confirmed', 'cancelled']).optional(), ...page }),
  async handler({ user }, i) {
    const ids = await many(
      `SELECT rs.id FROM reservations rs WHERE rs.user_id=$1 AND ($2::text IS NULL OR rs.status=$2)
          AND ($3 = false OR EXISTS (SELECT 1 FROM bookings b WHERE b.reservation_id=rs.id AND b.status='confirmed' AND b.ends_at > now()))
        ORDER BY (SELECT min(starts_at) FROM bookings b WHERE b.reservation_id=rs.id AND b.status='confirmed' AND b.ends_at > now()) NULLS LAST, rs.created_at DESC LIMIT $4 OFFSET $5`,
      [user.id, i.status ?? null, i.upcoming, i.limit, i.offset]);
    return Promise.all(ids.map((r) => reservationView(pool, r.id)));
  },
});

cap({
  name: 'get_reservation', method: 'GET', path: '/reservations/:id', tag: TAG, summary: 'One reservation with all its lines (the booker or the team of a venue in it).', input: z.object({ id }),
  async handler({ user }, i) {
    const rs = await mustFind('reservations', i.id);
    if (!(await mayView(user, rs))) throw forbidden();
    return reservationView(pool, i.id);
  },
});

cap({
  name: 'add_reservation_items', method: 'POST', path: '/reservations/:id/items', tag: TAG, status: 201,
  summary: 'Add more slots to a reservation you already hold (same currency). Same checks as create_reservation; totals and discounts are recomputed.',
  input: z.object({ id, items: basket.items, team_id: id.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const rs = (await c.query('SELECT * FROM reservations WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!rs) throw notFound('Reservation');
      if (rs.user_id !== user.id) throw forbidden();
      if (rs.status !== 'confirmed') throw conflict('That reservation is cancelled — make a new one');
      const res = await loadResources(c, i.items.map((x) => x.resource_id));
      const cur = (await c.query('SELECT DISTINCT currency FROM venues WHERE id = ANY($1::uuid[])', [[...res.values()].map((r) => r.venue_id)])).rows.map((r) => r.currency);
      if (cur.some((x) => x !== rs.currency)) throw badRequest(`This reservation is in ${rs.currency}`);
      const made = await addLines(c, rs, { userId: user.id, items: i.items, team_id: i.team_id });
      const view = await reservationView(c, i.id);
      for (const vid of made.venueIds) {
        const v = (await c.query('SELECT * FROM venues WHERE id=$1', [vid])).rows[0];
        await notifyVenueTeam(c, v, user.id, { kind: 'booking_modified', title: `Booking ${view.code} grew`, body: `${user.display_name} added slot(s).`, data: { reservation_id: view.id, venue_id: vid } });
      }
      return view;
    });
  },
});

cap({
  name: 'modify_booking', method: 'PATCH', path: '/bookings/:id', tag: TAG,
  summary: 'Change one booking line: new time, a different area of the same venue, quantity or players. Atomic re-check of hours, slot grid, blocks and capacity (the booking itself does not count against it), then repriced at current rates. Customers can modify until the venue\'s free-cancellation cut-off; the venue team any time. The other side is notified.',
  input: z.object({ id, starts_at: dt.optional(), ends_at: dt.optional(), resource_id: id.optional(), quantity: z.number().int().min(1).max(1000).optional(), players: z.number().int().min(1).max(1000).optional() }),
  async handler({ user }, i) {
    if (!i.starts_at && !i.ends_at && !i.resource_id && !i.quantity && !i.players) throw badRequest('Nothing to change');
    return tx(async (c) => {
      const b0 = (await c.query('SELECT b.user_id, b.resource_id, r.venue_id FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE b.id=$1', [i.id])).rows[0];
      if (!b0) throw notFound('Booking');
      const staff = await canManage(user, b0.venue_id, c);
      if (!staff && b0.user_id !== user.id) throw forbidden();
      const target = i.resource_id ? (await loadResources(c, [i.resource_id])).get(i.resource_id) : null;
      if (target && target.venue_id !== b0.venue_id) throw badRequest('A booking can only move between areas of the same venue — cancel and rebook for another venue');
      await lockResources(c, [b0.resource_id, ...(i.resource_id ? [i.resource_id] : [])]);
      const b = (await c.query('SELECT * FROM bookings WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (b.status !== 'confirmed') throw conflict('Only a confirmed booking can be changed');
      const ctx = await loadVenueCtx(c, b0.venue_id);
      if (!staff) {
        if (new Date() > new Date(b.starts_at.getTime() - ctx.venue.cancel_free_hours * 3_600_000)) throw conflict(`Bookings can be changed up to ${ctx.venue.cancel_free_hours} hours before they start — contact the venue`);
      }
      const res = (await c.query('SELECT * FROM resources WHERE id=$1 AND active', [i.resource_id ?? b.resource_id])).rows[0];
      if (!res) throw notFound('Bookable area');
      const start = new Date(i.starts_at ?? b.starts_at), end = new Date(i.ends_at ?? (i.starts_at ? new Date(start.getTime() + (b.ends_at - b.starts_at)) : b.ends_at));
      const qty = i.quantity ?? b.quantity;
      const players = i.players ?? b.players;
      const { slots } = checkWindow(ctx, res, start, end, { staff });
      if (qty > res.capacity) throw badRequest(`${res.name} has ${res.capacity} unit(s)`);
      if (players && res.max_players && players > res.max_players * qty) throw badRequest(`${res.name} fits ${res.max_players * qty} players`);
      if (!staff) {
        const blk = await blockedBy(c, res.venue_id, res.id, start, end);
        if (blk) throw conflict(`${res.name} is blocked then${blk.reason ? ` (${blk.reason})` : ''}`);
      }
      const used = await usedUnits(c, res.id, start, end, b.id);
      if (used + qty > res.capacity) throw conflict(`${res.name} is not available for that slot (${Math.max(0, res.capacity - used)} of ${res.capacity} free)`);
      const base = b.source === 'admin' && b.base_cents === 0 ? 0 : priceWindow(ctx, res, start, end, qty).base_cents; // staff comps stay comps
      await c.query('UPDATE bookings SET resource_id=$2, starts_at=$3, ends_at=$4, quantity=$5, slots=$6, players=$7, base_cents=$8, price_cents=$8-discount_cents, reminded_at=NULL, updated_at=now() WHERE id=$1',
        [b.id, res.id, start, end, qty, slots, players ?? null, base]);
      if (b.reservation_id) await repriceReservation(c, b.reservation_id);
      else await c.query('UPDATE bookings SET discount_cents=0, price_cents=base_cents WHERE id=$1', [b.id]);
      const what = `${res.name} at ${ctx.venue.name}, ${start.toISOString()}`;
      const data = { booking_id: b.id, reservation_id: b.reservation_id, venue_id: ctx.venue.id };
      if (staff && b.user_id !== user.id) await notify(c, b.user_id, { kind: 'booking_modified', title: 'The venue changed your booking', body: `Now: ${what}.`, data });
      else {
        await notify(c, b.user_id, { kind: 'booking_modified', title: 'Booking updated', body: `Now: ${what}.`, data });
        await notifyVenueTeam(c, ctx.venue, user.id, { kind: 'booking_modified', title: 'A booking was changed', body: what, data });
      }
      const row = (await c.query('SELECT * FROM bookings WHERE id=$1', [b.id])).rows[0];
      return { booking: row, price_change_cents: row.price_cents - b.price_cents, reservation: b.reservation_id ? await reservationView(c, b.reservation_id) : null };
    });
  },
});

cap({
  name: 'cancel_reservation', method: 'DELETE', path: '/reservations/:id', tag: TAG,
  summary: 'Cancel every active line of a reservation. Each line is refunded per its venue\'s cancellation policy (full refund if early enough). Use cancel_booking to drop a single line.',
  input: z.object({ id, reason: z.string().max(300).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const rs = (await c.query('SELECT * FROM reservations WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!rs) throw notFound('Reservation');
      if (rs.user_id !== user.id && !isAdmin(user)) {
        // venue team may cancel only their own venue's lines — use cancel_booking for that
        throw forbidden('Only the person who booked can cancel the whole reservation');
      }
      const ids = (await c.query("SELECT id FROM bookings WHERE reservation_id=$1 AND status='confirmed' ORDER BY starts_at", [i.id])).rows.map((r) => r.id);
      if (!ids.length) throw conflict('Nothing left to cancel');
      const done = await cancelBookings(c, ids, { actor: user, byVenue: false, reason: i.reason });
      return { reservation: await reservationView(c, i.id), cancelled: done.length, refund_cents: done.reduce((s, d) => s + d.refund_cents, 0), fee_cents: done.reduce((s, d) => s + d.fee_cents, 0) };
    });
  },
});

// ------------------------------------------------------------------ notifications
cap({
  name: 'list_notifications', method: 'GET', path: '/notifications', tag: 'Notifications', summary: 'Your notification inbox (booking confirmations, changes, cancellations, reminders) with the unread count.',
  input: z.object({ unread: z.coerce.boolean().default(false), ...page }),
  async handler({ user }, i) {
    const [items, c] = await Promise.all([inbox(user.id, i), one('SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL', [user.id])]);
    return { unread: c.n, items };
  },
});
cap({
  name: 'mark_notifications_read', method: 'POST', path: '/notifications/read', tag: 'Notifications', summary: 'Mark some notifications (or all, when `ids` is omitted) as read.',
  input: z.object({ ids: z.array(id).max(200).optional() }),
  async handler({ user }, i) {
    const r = await pool.query('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))', [user.id, i.ids ?? null]);
    return { marked: r.rowCount };
  },
});
cap({
  name: 'get_notification_preferences', method: 'GET', path: '/me/notification-preferences', tag: 'Notifications', summary: 'Which channels you get notifications on (in-app, email), how far ahead booking reminders arrive, and muted kinds.',
  handler: async ({ user }) => (await one('SELECT in_app, email, reminder_hours, muted_kinds FROM notification_prefs WHERE user_id=$1', [user.id])) ?? DEFAULT_PREFS,
});
cap({
  name: 'update_notification_preferences', method: 'PATCH', path: '/me/notification-preferences', tag: 'Notifications',
  summary: 'Turn notification channels on/off (in_app, email), set the booking reminder lead time in hours, and mute kinds (e.g. new_booking).',
  input: z.object({ in_app: z.boolean().optional(), email: z.boolean().optional(), reminder_hours: z.number().int().min(1).max(168).optional(), muted_kinds: z.array(z.string().max(40)).max(30).optional() }),
  async handler({ user }, i) {
    const cur = (await one('SELECT * FROM notification_prefs WHERE user_id=$1', [user.id])) ?? DEFAULT_PREFS;
    const n = { ...cur, ...Object.fromEntries(Object.entries(i).filter(([, v]) => v !== undefined)) };
    return one(`INSERT INTO notification_prefs(user_id, in_app, email, reminder_hours, muted_kinds) VALUES ($1,$2,$3,$4,$5)
                ON CONFLICT (user_id) DO UPDATE SET in_app=$2, email=$3, reminder_hours=$4, muted_kinds=$5 RETURNING in_app, email, reminder_hours, muted_kinds`,
      [user.id, n.in_app, n.email, n.reminder_hours, n.muted_kinds]);
  },
});
cap({
  name: 'dispatch_notifications', method: 'POST', path: '/admin/notifications/dispatch', tag: 'Notifications', auth: ['admin'],
  summary: 'Run one notification cycle now: queue due booking reminders and send queued emails through NOTIFY_WEBHOOK_URL (when configured). The server also does this on a timer.',
  async handler() {
    const reminders = await queueReminders();
    return { reminders, ...(await dispatchPending()) };
  },
});
