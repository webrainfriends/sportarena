import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { conflict, forbidden, notFound, badRequest } from '../errors.js';
import { isAdmin, mustFind, sportBySlugOrId } from '../helpers.js';
import { lockResource, usedUnits, blockedBy, cancelBookings, mustManage, canManage } from '../booking/engine.js';
import { validTimezone } from '../booking/time.js';
import { publicMedia } from '../media.js';
import { isSupportedCurrency, CURRENCIES } from '../currency.js';
import { canManageTeam } from './teams.js';

const dt = z.string().datetime({ offset: true });

/** Reserve a resource slot (legacy single-slot path, used by fixtures and /bookings). Serialised per resource with an
 *  advisory lock so concurrent requests can never oversell capacity (courts have capacity 1; equipment pools more). */
export async function reserve(c, { resource_id, user_id, team_id, event_id, starts_at, ends_at, quantity = 1, note }) {
  await lockResource(c, resource_id);
  const res = (await c.query('SELECT * FROM resources WHERE id=$1 AND active', [resource_id])).rows[0];
  if (!res) throw notFound('Resource');
  const blk = await blockedBy(c, res.venue_id, res.id, starts_at, ends_at);
  if (blk) throw conflict(`${res.name} is blocked then${blk.reason ? ` (${blk.reason})` : ''}`);
  const used = await usedUnits(c, resource_id, starts_at, ends_at);
  if (used + quantity > res.capacity) throw conflict(`${res.name} is not available for that slot (${res.capacity - used} of ${res.capacity} free)`);
  const hours = (new Date(ends_at) - new Date(starts_at)) / 3.6e6;
  const price = Math.ceil(hours * res.hourly_rate_cents * quantity);
  return (await c.query(
    `INSERT INTO bookings(resource_id, user_id, team_id, event_id, starts_at, ends_at, quantity, price_cents, base_cents, payable_cents, source, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$8,$9,$10) RETURNING *`,
    [resource_id, user_id, team_id ?? null, event_id ?? null, starts_at, ends_at, quantity, price, event_id ? 'fixture' : 'user', note ?? null])).rows[0];
}

export const KINDS = ['court', 'ground', 'pool', 'track', 'room', 'equipment', 'table', 'lane', 'rink', 'range', 'studio', 'other'];

/** Map deep links for a venue (works from coordinates, falls back to a name + address search). */
export function mapLinks(v) {
  const q = encodeURIComponent([v.name, v.address, v.city].filter(Boolean).join(', '));
  if (v.latitude == null || v.longitude == null) return v.name ? { google: `https://www.google.com/maps/search/?api=1&query=${q}`, apple: `https://maps.apple.com/?q=${q}`, directions: `https://www.google.com/maps/dir/?api=1&destination=${q}` } : null;
  const ll = `${v.latitude},${v.longitude}`;
  return {
    google: `https://www.google.com/maps/search/?api=1&query=${ll}`,
    apple: `https://maps.apple.com/?ll=${ll}&q=${encodeURIComponent(v.name)}`,
    osm: `https://www.openstreetmap.org/?mlat=${v.latitude}&mlon=${v.longitude}#map=17/${v.latitude}/${v.longitude}`,
    directions: `https://www.google.com/maps/dir/?api=1&destination=${ll}`,
  };
}

export const venueProfile = {
  description: z.string().max(2000).optional(), country: z.string().max(60).optional(), postal_code: z.string().max(20).optional(),
  latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional(),
  timezone: z.string().refine(validTimezone, 'Unknown IANA time zone, e.g. Asia/Kolkata').optional(),
  currency: z.string().length(3).transform((x) => x.toUpperCase()).refine(isSupportedCurrency, `Supported currencies: ${Object.keys(CURRENCIES).join(', ')}`).optional(),
  legal_name: z.string().max(120).optional(), tax_id: z.string().max(40).optional(), billing_address: z.string().max(300).optional(),
  tax_name: z.string().min(1).max(20).optional(), tax_rate_bp: z.number().int().min(0).max(10000).describe('basis points: 1800 = 18%').optional(), tax_inclusive: z.boolean().optional(),
  loyalty_earn_bp: z.number().int().min(0).max(5000).optional().describe('percent of what customers pay returned as loyalty points, in basis points (500 = 5%); 0 switches the programme off'),
  loyalty_expiry_months: z.number().int().min(1).max(60).optional(), loyalty_max_redeem_bp: z.number().int().min(100).max(10000).optional().describe('largest share of one invoice that points may pay'),
  invoice_prefix: z.string().regex(/^[A-Z0-9]{2,8}$/, '2–8 capital letters or digits').optional(),
  payment_mode: z.enum(['pay_at_venue', 'online_optional', 'online_required']).optional().describe('online modes need Stripe/PayPal switched on; online_required releases unpaid slots after a few minutes'),
  phone: z.string().max(30).optional(), email: z.string().email().optional(), website: z.string().url().optional(),
  amenities: z.array(z.string().min(1).max(40)).max(40).optional(),
  min_notice_minutes: z.number().int().min(0).max(10080).optional(), max_advance_days: z.number().int().min(1).max(730).optional(),
  cancel_free_hours: z.number().int().min(0).max(720).optional(), late_cancel_refund_percent: z.number().int().min(0).max(100).optional(),
  notify_owner: z.boolean().optional(),
};
export const VENUE_PROFILE_FIELDS = Object.keys(venueProfile);
const coordsTogether = (i) => (i.latitude == null) === (i.longitude == null);

cap({
  name: 'create_venue', method: 'POST', path: '/venues', tag: 'Venues & Booking', auth: ['venue_manager', 'organizer'], status: 201,
  summary: 'Register a venue (stadium, sports complex, club) with its location, time zone, currency, contact line, amenities and booking/cancellation policy. Add courts/tables with add_resource and opening hours with set_venue_hours.',
  input: z.object({ name: z.string().min(2).max(80), city: z.string().max(80).optional(), address: z.string().max(200).optional(), emoji: z.string().max(8).optional(), ...venueProfile })
    .refine(coordsTogether, 'latitude and longitude go together'),
  async handler({ user }, i) {
    const f = VENUE_PROFILE_FIELDS.filter((k) => i[k] !== undefined);
    const cols = ['name', 'city', 'address', 'owner_id', 'emoji', ...f];
    const vals = [i.name, i.city, i.address, user.id, i.emoji ?? '🏟️', ...f.map((k) => i[k])];
    return one(`INSERT INTO venues(${cols.join(',')}) VALUES (${vals.map((_, n) => `$${n + 1}`).join(',')}) RETURNING *`, vals);
  },
});

cap({
  name: 'list_venues', method: 'GET', path: '/venues', tag: 'Venues & Booking', auth: 'public',
  summary: 'Browse and search venues: by name/city/sport, near a point (lat, lng, radius_km), by price, by amenity, and — with available_from/available_to — only venues with a free area in that window. Sort by name, distance, rating or price.',
  input: z.object({
    city: z.string().optional(), q: z.string().optional(), sport: z.string().optional(),
    lat: z.coerce.number().min(-90).max(90).optional(), lng: z.coerce.number().min(-180).max(180).optional(), radius_km: z.coerce.number().min(0.1).max(20000).optional(),
    max_hourly_rate_cents: z.coerce.number().int().min(0).optional(), amenity: z.string().optional(),
    available_from: dt.optional(), available_to: dt.optional(),
    sort: z.enum(['name', 'distance', 'rating', 'price']).default('name'), ...page,
  }).refine((i) => (i.lat == null) === (i.lng == null), 'lat and lng go together').refine((i) => (i.available_from == null) === (i.available_to == null), 'available_from and available_to go together'),
  async handler({ user }, i) {
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    if (i.sport && !sport) throw notFound('Sport');
    if (i.sort === 'distance' && i.lat == null) throw badRequest('sort=distance needs lat and lng');
    const rows = await many(
      `WITH base AS (
         SELECT v.*,
           CASE WHEN $5::float8 IS NULL OR v.latitude IS NULL THEN NULL ELSE round((6371 * 2 * asin(sqrt(
             power(sin(radians(v.latitude - $5) / 2), 2) + cos(radians($5)) * cos(radians(v.latitude)) * power(sin(radians(v.longitude - $6) / 2), 2))))::numeric, 2) END AS distance_km,
           (SELECT count(*)::int FROM resources r WHERE r.venue_id=v.id AND r.active) AS resources,
           (SELECT round(avg(rating),2) FROM testimonials t WHERE t.subject_type='venue' AND t.subject_id=v.id) AS rating,
           (SELECT count(*)::int FROM testimonials t WHERE t.subject_type='venue' AND t.subject_id=v.id) AS reviews,
           (SELECT min(x) FROM (SELECT min(r.hourly_rate_cents) AS x FROM resources r WHERE r.venue_id=v.id AND r.active AND r.kind <> 'equipment' AND ($3::uuid IS NULL OR r.sport_id=$3)
                                UNION ALL SELECT min(p.hourly_rate_cents) FROM price_rules p WHERE p.venue_id=v.id AND p.active AND (p.resource_id IS NULL OR $3::uuid IS NULL OR EXISTS (SELECT 1 FROM resources r2 WHERE r2.id=p.resource_id AND r2.sport_id=$3))) m) AS min_hourly_rate_cents,
           (SELECT coalesce(array_agg(DISTINCT s.slug), '{}') FROM resources r JOIN sports s ON s.id=r.sport_id WHERE r.venue_id=v.id AND r.active) AS sports,
           (SELECT count(*)::int FROM discounts d WHERE d.venue_id=v.id AND d.active AND d.code IS NULL AND (d.valid_to IS NULL OR d.valid_to >= current_date)) AS offers,
           EXISTS (SELECT 1 FROM favourite_venues f WHERE f.venue_id=v.id AND f.user_id=$14::uuid AND f.removed_at IS NULL) AS is_favourite,
           (SELECT '/api/v1/media/' || m.id FROM venue_media m WHERE m.venue_id=v.id AND m.removed_at IS NULL AND m.kind='photo' ORDER BY m.is_cover DESC, m.position, m.created_at LIMIT 1) AS cover_url
         FROM venues v
         WHERE v.active AND ($1::text IS NULL OR v.city ILIKE $1) AND ($2::text IS NULL OR v.name ILIKE '%'||$2||'%')
           AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM resources r WHERE r.venue_id=v.id AND r.active AND r.sport_id=$3))
           AND ($4::text IS NULL OR $4 = ANY(v.amenities))
           AND ($9::timestamptz IS NULL OR EXISTS (
                 SELECT 1 FROM resources r WHERE r.venue_id=v.id AND r.active AND r.kind <> 'equipment' AND ($3::uuid IS NULL OR r.sport_id=$3)
                   AND NOT EXISTS (SELECT 1 FROM venue_blocks k WHERE k.released_at IS NULL AND k.venue_id=v.id AND (k.resource_id IS NULL OR k.resource_id=r.id) AND k.starts_at < $10 AND k.ends_at > $9)
                   AND r.capacity > coalesce((SELECT sum(b.quantity) FROM bookings b WHERE b.resource_id=r.id AND b.status IN ('confirmed','no_show') AND b.starts_at < $10 AND b.ends_at > $9), 0)))
       )
       SELECT * FROM base WHERE ($7::float8 IS NULL OR min_hourly_rate_cents IS NULL OR min_hourly_rate_cents <= $7)
         AND ($8::float8 IS NULL OR (distance_km IS NOT NULL AND distance_km <= $8))
       ORDER BY CASE WHEN $11 = 'distance' THEN distance_km END ASC NULLS LAST, CASE WHEN $11 = 'rating' THEN rating END DESC NULLS LAST,
                CASE WHEN $11 = 'price' THEN min_hourly_rate_cents END ASC NULLS LAST, name
       LIMIT $12 OFFSET $13`,
      [i.city ?? null, i.q ?? null, sport?.id ?? null, i.amenity ?? null, i.lat ?? null, i.lng ?? null, i.max_hourly_rate_cents ?? null, i.radius_km ?? null, i.available_from ?? null, i.available_to ?? null, i.sort, i.limit, i.offset, user?.id ?? null]);
    return rows.map((v) => ({ ...v, map_links: mapLinks(v) }));
  },
});

cap({
  name: 'get_venue', method: 'GET', path: '/venues/:id', tag: 'Venues & Booking', auth: 'public', summary: 'Venue profile: location + map links, opening hours, policy, amenities, its courts/tables/grounds/equipment (each with capacity, players, slot length), and automatic discounts. Contacts: list_venue_contacts.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const v = await mustFind('venues', i.id);
    const [resources, hours, offers, media, rating, fav, pts] = await Promise.all([
      many('SELECT r.*, s.name AS sport, s.slug AS sport_slug, s.emoji AS sport_emoji FROM resources r LEFT JOIN sports s ON s.id=r.sport_id WHERE r.venue_id=$1 AND r.active ORDER BY r.kind, r.name', [i.id]),
      many('SELECT weekday, opens_min, closes_min FROM venue_hours WHERE venue_id=$1 AND removed_at IS NULL ORDER BY weekday, opens_min', [i.id]),
      many("SELECT id, name, kind, value, min_slots, weekdays, valid_from, valid_to, resource_id FROM discounts WHERE venue_id=$1 AND active AND code IS NULL AND (valid_to IS NULL OR valid_to >= current_date) ORDER BY name", [i.id]),
      many('SELECT * FROM venue_media WHERE venue_id=$1 AND removed_at IS NULL ORDER BY is_cover DESC, position, created_at LIMIT 40', [i.id]),
      one("SELECT round(avg(rating),2) AS rating, count(*)::int AS reviews FROM testimonials WHERE subject_type='venue' AND subject_id=$1", [i.id]),
      one('SELECT count(*)::int AS favourites, coalesce(bool_or(user_id = $2::uuid), false) AS is_favourite FROM favourite_venues WHERE venue_id=$1 AND removed_at IS NULL', [i.id, user?.id ?? null]),
      user ? one('SELECT coalesce(sum(remaining),0)::int AS my_points FROM loyalty_lots WHERE user_id=$1 AND venue_id=$2 AND remaining > 0 AND expires_at > now()', [user.id, i.id]) : { my_points: 0 },
    ]);
    return { ...v, map_links: mapLinks(v), resources, hours, open_around_the_clock: hours.length === 0, offers, media: media.map(publicMedia), ...rating, ...fav, ...pts };
  },
});

cap({
  name: 'add_resource', method: 'POST', path: '/venues/:id/resources', tag: 'Venues & Booking', status: 201,
  summary: 'Add a bookable court/table/ground/pool/lane/rink/room/equipment pool to a venue you manage. Each area has its own `capacity` (concurrent bookings, or units of kit), `max_players` per unit, slot length (15–120 min), min/max slots per booking, and base hourly rate. Rate rules (peak/off-peak) come from create_price_rule.',
  input: z.object({
    id, kind: z.enum(KINDS), name: z.string().min(1).max(80), sport: z.string().optional(),
    capacity: z.number().int().min(1).max(1000).default(1), hourly_rate_cents: money.default(0),
    max_players: z.number().int().min(1).max(1000).optional(), description: z.string().max(500).optional(), surface: z.string().max(60).optional(), indoor: z.boolean().optional(),
    slot_minutes: z.union([z.literal(15), z.literal(20), z.literal(30), z.literal(45), z.literal(60), z.literal(90), z.literal(120)]).default(60),
    min_slots: z.number().int().min(1).max(48).default(1), max_slots: z.number().int().min(1).max(48).default(8),
  }).refine((i) => i.max_slots >= i.min_slots, 'max_slots must be at least min_slots'),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    if (i.sport && !sport) throw notFound('Sport');
    return one(
      `INSERT INTO resources(venue_id, kind, name, sport_id, capacity, hourly_rate_cents, max_players, description, surface, indoor, slot_minutes, min_slots, max_slots)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [i.id, i.kind, i.name, sport?.id ?? null, i.capacity, i.hourly_rate_cents, i.max_players ?? null, i.description ?? null, i.surface ?? null, i.indoor ?? null, i.slot_minutes, i.min_slots, i.max_slots]);
  },
});

cap({
  name: 'check_availability', method: 'GET', path: '/resources/:id/availability', tag: 'Venues & Booking', auth: 'public',
  summary: 'How many units of a resource are free in a time window (accounts for bookings and venue blocks). For a slot-by-slot day grid use venue_availability.', input: z.object({ id, from: dt, to: dt }),
  async handler(_, i) {
    const r = await mustFind('resources', i.id);
    const used = await usedUnits(pool, i.id, i.from, i.to);
    const blocked = !!(await blockedBy(pool, r.venue_id, r.id, i.from, i.to));
    const free = blocked ? 0 : Math.max(0, r.capacity - used);
    return { resource_id: r.id, capacity: r.capacity, used, blocked, free, available: free > 0 };
  },
});

cap({
  name: 'create_booking', method: 'POST', path: '/bookings', tag: 'Venues & Booking', status: 201,
  summary: 'Quick single-slot booking of an area at its base rate (no hours/slot-grid rules). Fails with 409 if the slot is taken or blocked. Prefer create_reservation for real customer bookings: it applies opening hours, slot grid, price rules, discounts and multi-slot / multi-area baskets.',
  input: z.object({ resource_id: id, starts_at: dt, ends_at: dt, quantity: z.number().int().min(1).default(1), team_id: id.optional(), event_id: id.optional(), note: z.string().max(300).optional() }),
  async handler({ user }, i) {
    if (new Date(i.ends_at) <= new Date(i.starts_at)) throw badRequest('ends_at must be after starts_at');
    if (new Date(i.starts_at) < new Date()) throw badRequest('Cannot book in the past');
    return tx(async (c) => {
      if (i.team_id) {
        const t = await mustFind('teams', i.team_id, '*', c);
        if (!(await canManageTeam(user, t))) throw forbidden('You do not manage that team');
      }
      return reserve(c, { ...i, user_id: user.id });
    });
  },
});

cap({
  name: 'list_bookings', method: 'GET', path: '/bookings', tag: 'Venues & Booking',
  summary: 'Your bookings; the venue team can pass resource_id to see the schedule of an area they run (venue_schedule gives the whole venue).',
  input: z.object({ resource_id: id.optional(), upcoming: z.coerce.boolean().default(true), ...page }),
  async handler({ user }, i) {
    if (i.resource_id) {
      const r = await one('SELECT venue_id FROM resources WHERE id=$1', [i.resource_id]);
      if (!r) throw notFound('Resource');
      if (!(await canManage(user, r.venue_id))) throw forbidden();
    }
    return many(
      `SELECT b.*, r.name AS resource_name, r.kind, v.name AS venue_name FROM bookings b JOIN resources r ON r.id=b.resource_id JOIN venues v ON v.id=r.venue_id
        WHERE ($1::uuid IS NULL AND b.user_id=$2 OR b.resource_id=$1) AND ($3 = false OR b.ends_at > now()) AND b.status='confirmed'
        ORDER BY b.starts_at LIMIT $4 OFFSET $5`, [i.resource_id ?? null, user.id, i.upcoming, i.limit, i.offset]);
  },
});

cap({
  name: 'cancel_booking', method: 'DELETE', path: '/bookings/:id', tag: 'Venues & Booking',
  summary: "Cancel one booking line. The booker gets the venue's cancellation-policy refund (full if cancelled early enough, else the late-cancel percentage); the venue team can cancel any time with a full refund and an optional reason. The rest of a multi-slot reservation stays; its totals and discounts are recomputed.",
  input: z.object({ id, reason: z.string().max(300).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const b = (await c.query('SELECT b.user_id, r.venue_id FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE b.id=$1', [i.id])).rows[0];
      if (!b) throw notFound('Booking');
      const staff = await canManage(user, b.venue_id, c);
      if (!staff && b.user_id !== user.id) throw forbidden();
      const [done] = await cancelBookings(c, [i.id], { actor: user, byVenue: staff && b.user_id !== user.id, reason: i.reason });
      if (!done) throw conflict('That booking is not active');
      return { ok: true, ...done };
    });
  },
});
