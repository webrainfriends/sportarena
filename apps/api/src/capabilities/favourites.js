// Saved favourite venues and "tell me when a slot opens" alerts.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { mustFind, sportBySlugOrId } from '../helpers.js';
import { loadVenueCtx, loadBusy } from '../booking/engine.js';
import { matchAlert, alertResources } from '../booking/alerts.js';
import { toLocal, fromLocal, addDays, hhmm } from '../booking/time.js';
import { pool } from '../db.js';

const TAG = 'Favourites & alerts';
const day = z.string().date();
const clock = z.string().regex(/^\d{1,2}:\d{2}$/, 'use HH:MM').refine((s) => !Number.isNaN(hhmm(s)), 'not a valid time');

cap({
  name: 'favourite_venue', method: 'POST', path: '/venues/:id/favourite', tag: TAG, status: 201,
  summary: 'Save a venue to your favourites. With notify_offers (default) you are told when it adds a new offer.',
  input: z.object({ id, notify_offers: z.boolean().default(true) }),
  async handler({ user }, i) {
    await mustFind('venues', i.id, 'id');
    return one(
      `INSERT INTO favourite_venues(user_id, venue_id, notify_offers) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, venue_id) DO UPDATE SET removed_at=NULL, notify_offers=$3 RETURNING venue_id, notify_offers, created_at`, [user.id, i.id, i.notify_offers]);
  },
});

cap({
  name: 'unfavourite_venue', method: 'DELETE', path: '/venues/:id/favourite', tag: TAG, summary: 'Remove a venue from your favourites.', input: z.object({ id }),
  async handler({ user }, i) {
    await one('UPDATE favourite_venues SET removed_at=now() WHERE user_id=$1 AND venue_id=$2 AND removed_at IS NULL RETURNING venue_id', [user.id, i.id]);
    return { ok: true };
  },
});

cap({
  name: 'list_favourite_venues', method: 'GET', path: '/me/favourites', tag: TAG, summary: 'Your saved venues with rating, cover photo, price-from and offers (most recently saved first).',
  handler: ({ user }) => many(
    `SELECT v.id, v.name, v.emoji, v.city, v.currency, v.timezone, f.notify_offers, f.created_at AS saved_at,
            (SELECT round(avg(rating),2) FROM testimonials t WHERE t.subject_type='venue' AND t.subject_id=v.id) AS rating,
            (SELECT count(*)::int FROM testimonials t WHERE t.subject_type='venue' AND t.subject_id=v.id) AS reviews,
            (SELECT min(r.hourly_rate_cents) FROM resources r WHERE r.venue_id=v.id AND r.active AND r.kind <> 'equipment') AS min_hourly_rate_cents,
            (SELECT count(*)::int FROM discounts d WHERE d.venue_id=v.id AND d.active AND d.code IS NULL AND (d.valid_to IS NULL OR d.valid_to >= current_date)) AS offers,
            (SELECT '/api/v1/media/' || m.id FROM venue_media m WHERE m.venue_id=v.id AND m.removed_at IS NULL AND m.kind='photo' ORDER BY m.is_cover DESC, m.position LIMIT 1) AS cover_url
       FROM favourite_venues f JOIN venues v ON v.id=f.venue_id WHERE f.user_id=$1 AND f.removed_at IS NULL AND v.active ORDER BY f.created_at DESC`, [user.id]),
});

cap({
  name: 'create_slot_alert', method: 'POST', path: '/slot-alerts', tag: TAG, status: 201,
  summary: 'Ask to be told the moment a slot opens at a venue: pick dates (up to 60 days), optionally weekdays, a time window, one court or a sport, and how many slots in a row. If something matching is free right now you get it back as `available_now` and no alert is created. Notifies you once (in-app, push, email per your preferences), then the alert is done.',
  input: z.object({
    venue_id: id, resource_id: id.optional(), sport: z.string().optional(), date_from: day, date_to: day, weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
    from_time: clock.optional(), to_time: clock.optional(), slots: z.number().int().min(1).max(12).default(1),
  }).refine((i) => i.date_to >= i.date_from, 'date_to is before date_from').refine((i) => (i.from_time == null || i.to_time == null) || hhmm(i.to_time) > hhmm(i.from_time), 'to_time must be after from_time'),
  async handler({ user }, i) {
    const ctx = await loadVenueCtx(pool, i.venue_id);
    if (!ctx.venue.active) throw conflict('That venue is not taking bookings');
    const today = toLocal(new Date(), ctx.venue.timezone).date;
    if (i.date_to < today) throw badRequest('Those dates are in the past');
    if ((Date.parse(i.date_to) - Date.parse(i.date_from)) / 864e5 > 60) throw badRequest('Watch at most 60 days at a time');
    if (i.resource_id && (await mustFind('resources', i.resource_id)).venue_id !== i.venue_id) throw badRequest('That court belongs to another venue');
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    if (i.sport && !sport) throw notFound('Sport');
    const active = (await one("SELECT count(*)::int AS n FROM slot_alerts WHERE user_id=$1 AND status='active'", [user.id])).n;
    if (active >= 20) throw conflict('You already have 20 active alerts — cancel one first');
    const a = { venue_id: i.venue_id, resource_id: i.resource_id ?? null, sport_id: sport?.id ?? null, date_from: i.date_from, date_to: i.date_to, weekdays: i.weekdays ?? null, from_min: i.from_time ? hhmm(i.from_time) : null, to_min: i.to_time ? hhmm(i.to_time) : null, slots: i.slots };
    const resources = await alertResources(pool, a);
    if (!resources.length) throw badRequest('No bookable courts match that');
    const lo = fromLocal(i.date_from < today ? today : i.date_from, 0, ctx.venue.timezone), hi = fromLocal(addDays(i.date_to, 1), 0, ctx.venue.timezone);
    const found = matchAlert(ctx, resources, await loadBusy(pool, i.venue_id, lo, hi), a);
    if (found) return { created: false, available_now: found };
    const row = await one(
      `INSERT INTO slot_alerts(user_id, venue_id, resource_id, sport_id, date_from, date_to, weekdays, from_min, to_min, slots) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [user.id, a.venue_id, a.resource_id, a.sport_id, a.date_from, a.date_to, a.weekdays, a.from_min, a.to_min, a.slots]);
    return { created: true, alert: row };
  },
});

cap({
  name: 'list_slot_alerts', method: 'GET', path: '/me/slot-alerts', tag: TAG, summary: 'Your slot alerts (active first), with the venue and what was found for fulfilled ones.', input: z.object({ include_done: z.coerce.boolean().default(false) }),
  handler: ({ user }, i) => many(
    `SELECT a.*, v.name AS venue_name, v.timezone, r.name AS resource_name, fr.name AS found_resource_name FROM slot_alerts a JOIN venues v ON v.id=a.venue_id
       LEFT JOIN resources r ON r.id=a.resource_id LEFT JOIN resources fr ON fr.id=a.found_resource_id
      WHERE a.user_id=$1 AND ($2 OR a.status='active') ORDER BY (a.status='active') DESC, a.created_at DESC LIMIT 100`, [user.id, i.include_done]),
});

cap({
  name: 'cancel_slot_alert', method: 'DELETE', path: '/slot-alerts/:id', tag: TAG, summary: 'Stop watching (the alert is kept as cancelled).', input: z.object({ id }),
  async handler({ user }, i) {
    if (!(await one("UPDATE slot_alerts SET status='cancelled' WHERE id=$1 AND user_id=$2 AND status='active' RETURNING id", [i.id, user.id]))) throw notFound('Active alert');
    return { ok: true };
  },
});
