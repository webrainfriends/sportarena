// Event venues: see which venues an event uses and its court bookings, check and book courts for the event's days,
// and release a booking. Court bookings made here, by the tournament scheduler or by a finalized venue request all live in `bookings`.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { pool, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { mustFind } from '../helpers.js';
import { eventForOrganizer } from './events.js';
import { reserve } from './venues.js';
import { skippedDates } from './event-schedule.js';
import { loadVenueCtx, lockResources, blockedBy, usedUnits, openIntervals, priceWindow, cancelBookings } from '../booking/engine.js';
import { fromLocal, addDays, hhmm, fmtMin } from '../booking/time.js';
import { eventWindow, bookedDays, windowFit, consentNeeded, analyzeEventFit } from '../event-fit.js';
import { audit } from '../helpers.js';

const TAG = 'Event venues';
const date = z.string().date();
const clock = z.string().regex(/^\d{1,2}:\d{2}$/, 'use HH:MM').refine((s) => !Number.isNaN(hhmm(s)), 'not a valid time');
const MAX_DAYS = 60;

const BOOK_INPUT = {
  id, venue_id: id, resource_ids: z.array(id).max(50).optional(), from_date: date, to_date: date.optional(),
  start_time: clock.default('09:00'), end_time: clock.default('18:00'), weekdays_off: z.array(z.number().int().min(0).max(6)).max(6).default([]), respect_holidays: z.boolean().default(true),
};

/** Day-by-day, court-by-court availability for the requested window (writes nothing). */
async function check(c, ev, i) {
  const ctx = await loadVenueCtx(c, i.venue_id), tz = ctx.venue.timezone;
  if (!ctx.venue.active) throw badRequest('That venue is not live yet (awaiting platform approval)');
  const resources = (await c.query(
    'SELECT * FROM resources WHERE venue_id=$1 AND active AND (sport_id IS NULL OR sport_id=$2 OR $4::boolean) AND ($3::uuid[] IS NULL OR id = ANY($3)) ORDER BY name, id',
    [i.venue_id, ev.sport_id, i.resource_ids ?? null, (await c.query('SELECT 1 FROM event_programmes WHERE event_id=$1', [ev.id])).rowCount > 0])).rows;
  if (!resources.length) throw badRequest('That venue has no courts or grounds you can book for this event');
  if (i.resource_ids && resources.length !== new Set(i.resource_ids).size) throw badRequest('resource_ids must be active courts of that venue');
  const from = i.from_date, to = i.to_date ?? i.from_date;
  if (to < from) throw badRequest('to_date is before from_date');
  if ((Date.parse(to) - Date.parse(from)) / 864e5 >= MAX_DAYS) throw badRequest(`Book at most ${MAX_DAYS} days at a time`);
  const startMin = hhmm(i.start_time), endMin = hhmm(i.end_time);
  if (endMin <= startMin) throw badRequest('end_time must be after start_time');
  const skip = await skippedDates(c, ev, ctx.venue, i, from, to);
  const rows = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    for (const r of resources) {
      const start = fromLocal(d, startMin, tz), end = fromLocal(d, endMin, tz);
      const base = { date: d, resource_id: r.id, resource_name: r.name, starts_at: start.toISOString(), ends_at: end.toISOString() };
      if (skip.has(d)) { rows.push({ ...base, status: 'skipped', reason: skip.get(d) }); continue; }
      const weekday = new Date(`${d}T00:00:00Z`).getUTCDay();
      if (!openIntervals(ctx, weekday, r, d).some(([o, e]) => startMin >= o && endMin <= e)) { rows.push({ ...base, status: 'closed', reason: 'Outside opening hours' }); continue; }
      const blk = await blockedBy(c, ctx.venue.id, r.id, start, end);
      if (blk) { rows.push({ ...base, status: 'blocked', reason: blk.reason || blk.kind }); continue; }
      if ((await usedUnits(c, r.id, start, end)) >= r.capacity) { rows.push({ ...base, status: 'booked', reason: 'Already booked' }); continue; }
      const mins = (end - start) / 60000;
      const price = mins % r.slot_minutes === 0 ? priceWindow(ctx, r, start, end).base_cents : Math.ceil(mins / 60 * r.hourly_rate_cents);
      rows.push({ ...base, status: 'free', price_cents: price });
    }
  }
  const free = rows.filter((r) => r.status === 'free');
  return {
    venue: { id: ctx.venue.id, name: ctx.venue.name, city: ctx.venue.city, timezone: tz, currency: ctx.venue.currency },
    window: { from, to, start_time: fmtMin(startMin), end_time: fmtMin(endMin) }, courts: resources.map((r) => ({ id: r.id, name: r.name })),
    rows, summary: { free: free.length, unavailable: rows.length - free.length, total_cents: free.reduce((s, r) => s + r.price_cents, 0) },
    skipped_dates: Object.fromEntries(skip),
    alignment: windowFit(await eventWindow(c, ev.id), free.map((r) => ({ date: r.date, cents: r.price_cents })), await bookedDays(c, ev.id), [...skip.keys()], ctx.venue.currency),
  };
}

cap({
  name: 'preview_event_venue_booking', method: 'POST', path: '/events/:id/venue-bookings/preview', tag: TAG,
  summary: 'Check which courts of a venue are free for the event’s days and times (opening hours, blocks, existing bookings, event blackout days, public holidays) and what they cost. `alignment` compares the days with the event’s start and end dates and says what would be wasted if they differ. Writes nothing.',
  input: z.object(BOOK_INPUT),
  async handler({ user }, i) { return tx(async (c) => check(c, await eventForOrganizer(user, i.id, c), i)); },
});

cap({
  name: 'book_event_venue', method: 'POST', path: '/events/:id/venue-bookings', tag: TAG, status: 201,
  summary: 'Book the courts for the event’s days. By default every slot must be free (409 lists what is not); skip_unavailable books only the free ones. When the days do not match the event’s start/end dates the booking is refused (409 consent_required, with the wasted spend and a trimmed alternative) until the organiser repeats it with accept_mismatch=true. Adds a planned venue line to the event budget and sets the event venue when it has none.',
  input: z.object({ ...BOOK_INPUT, skip_unavailable: z.boolean().default(false), accept_mismatch: z.boolean().default(false).describe('consent to book days that do not line up with the event’s start/end dates') }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ev = (await c.query('SELECT * FROM events WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!ev) throw notFound('Event');
      await eventForOrganizer(user, i.id, c);
      if (['completed', 'cancelled'].includes(ev.status)) throw conflict(`Event is ${ev.status}`);
      await lockResources(c, (await c.query('SELECT id FROM resources WHERE venue_id=$1', [i.venue_id])).rows.map((r) => r.id));
      const plan = await check(c, ev, i);
      const bad = plan.rows.filter((r) => r.status !== 'free' && r.status !== 'skipped');
      if (bad.length && !i.skip_unavailable) throw conflict(`${bad.length} slot(s) are not available`, { unavailable: bad });
      const free = plan.rows.filter((r) => r.status === 'free');
      if (!free.length) throw conflict('Nothing is available in that window', { unavailable: plan.rows });
      if (plan.alignment.consent_required && !i.accept_mismatch) throw conflict(plan.alignment.verdict, consentNeeded(plan.alignment));
      const bookings = [];
      for (const r of free) bookings.push(await reserve(c, { resource_id: r.resource_id, user_id: user.id, event_id: ev.id, starts_at: r.starts_at, ends_at: r.ends_at, note: `Event: ${ev.name}` }));
      const total = bookings.reduce((s, b) => s + Number(b.price_cents), 0);
      if (!ev.venue_id) await c.query('UPDATE events SET venue_id=$2 WHERE id=$1', [ev.id, i.venue_id]);
      let line = null;
      if (total > 0) line = (await c.query("INSERT INTO event_budget_lines(event_id, direction, category, name, planned_cents, created_by, notes) VALUES ($1,'expense','venue',$2,$3,$4,$5) RETURNING id", [ev.id, `Courts at ${plan.venue.name}`, total, user.id, `${bookings.length} court booking(s), ${plan.window.from} – ${plan.window.to}${plan.alignment.consent_required ? ' · booked outside the event dates with the organiser’s consent' : ''}`])).rows[0];
      if (plan.alignment.consent_required) await audit(c, user.id, 'accept_event_booking_mismatch', 'events', ev.id);
      return { venue: plan.venue, alignment: plan.alignment, booked: bookings.length, total_cents: total, budget_line_id: line?.id ?? null, skipped: plan.rows.length - free.length, bookings: bookings.map((b) => ({ id: b.id, resource_id: b.resource_id, starts_at: b.starts_at, ends_at: b.ends_at, price_cents: Number(b.price_cents) })) };
    });
  },
});

cap({
  name: 'get_event_venues', method: 'GET', path: '/events/:id/venues', tag: TAG,
  summary: 'Every venue the event uses (chosen venue, finalized venue requests, court bookings — including those made by the tournament scheduler) with its bookings, cost so far and the request status.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ev = await eventForOrganizer(user, i.id);
    const venues = await many(
      `SELECT v.id, v.name, v.emoji, v.city, v.country, v.address, v.currency, v.timezone, (SELECT '/api/v1/media/' || m.id FROM venue_media m WHERE m.venue_id=v.id AND m.removed_at IS NULL AND m.kind='photo' ORDER BY m.is_cover DESC, m.position, m.created_at LIMIT 1) AS cover_url FROM venues v
        WHERE v.id = $2 OR v.id IN (SELECT venue_id FROM event_requests WHERE event_id=$1 AND kind='venue' AND venue_id IS NOT NULL AND status IN ('sent','quoted','accepted','finalized'))
           OR v.id IN (SELECT r.venue_id FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE b.event_id=$1 AND b.status='confirmed') ORDER BY v.name`, [ev.id, ev.venue_id]);
    const bookings = await many(
      `SELECT b.id, b.resource_id, r.name AS resource_name, r.venue_id, b.starts_at, b.ends_at, b.price_cents, b.status, b.payment_status, b.source, b.note
         FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE b.event_id=$1 AND b.status IN ('confirmed','cancelled') ORDER BY b.starts_at`, [ev.id]);
    const requests = await many("SELECT id, venue_id, status, quote_cents, offer_cents, title FROM event_requests WHERE event_id=$1 AND kind='venue' AND status <> 'cancelled' ORDER BY created_at", [ev.id]);
    return venues.map((v) => {
      const mine = bookings.filter((b) => b.venue_id === v.id), live = mine.filter((b) => b.status === 'confirmed');
      return {
        ...v, chosen: v.id === ev.venue_id, requests: requests.filter((r) => r.venue_id === v.id),
        bookings: mine.map((b) => ({ ...b, price_cents: Number(b.price_cents) })),
        summary: { courts: new Set(live.map((b) => b.resource_id)).size, slots: live.length, from: live[0]?.starts_at ?? null, to: live.length ? live[live.length - 1].ends_at : null, total_cents: live.reduce((s, b) => s + Number(b.price_cents), 0) },
      };
    });
  },
});

cap({
  name: 'get_event_fit', method: 'GET', path: '/events/:id/fit', tag: TAG,
  summary: 'Efficiency check of the event’s bookings: compares every court booking, game, programme session and venue/vendor request with the event’s dates and with each other. Highlights booked time wasted before the first game or idle after the last one (or after the event ends), shows what it costs, and compares keeping everything with releasing the idle slots. Read-only; the same answer for the app and for agents.',
  input: z.object({ id }),
  async handler({ user }, i) { return analyzeEventFit(pool, await eventForOrganizer(user, i.id)); },
});

cap({
  name: 'release_event_booking', method: 'POST', path: '/event-bookings/:id/release', tag: TAG,
  summary: 'Release one of the event’s court bookings (organiser). The venue’s cancellation policy decides any refund; the slot becomes free again. It has to be in the future.',
  input: z.object({ id, reason: z.string().max(300).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const b = await mustFind('bookings', i.id, '*', c);
      if (!b.event_id) throw badRequest('That booking does not belong to an event');
      await eventForOrganizer(user, b.event_id, c);
      const out = await cancelBookings(c, [i.id], { actor: user, byVenue: false, reason: i.reason ?? 'Released by the event organiser' });
      if (!out.length) throw conflict('That booking is not active');
      return out[0];
    });
  },
});

export { pool };
