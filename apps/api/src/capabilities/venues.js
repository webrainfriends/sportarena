import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { conflict, forbidden, notFound, badRequest } from '../errors.js';
import { hasRole, isAdmin, mustFind, mustOwn, sportBySlugOrId } from '../helpers.js';
import { canManageTeam } from './teams.js';

const dt = z.string().datetime({ offset: true });

/** Units of a resource already taken in [start, end). */
async function usedUnits(c, resourceId, start, end, excludeBooking) {
  const r = await c.query(
    "SELECT coalesce(sum(quantity),0)::int AS used FROM bookings WHERE resource_id=$1 AND status='confirmed' AND starts_at < $3 AND ends_at > $2 AND ($4::uuid IS NULL OR id <> $4)",
    [resourceId, start, end, excludeBooking ?? null],
  );
  return r.rows[0].used;
}

/** Reserve a resource slot. Serialised per resource with an advisory lock so concurrent
 *  requests can never oversell capacity (courts have capacity 1; equipment pools more). */
export async function reserve(c, { resource_id, user_id, team_id, event_id, starts_at, ends_at, quantity = 1, note }) {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [resource_id]);
  const res = (await c.query('SELECT * FROM resources WHERE id=$1 AND active', [resource_id])).rows[0];
  if (!res) throw notFound('Resource');
  const used = await usedUnits(c, resource_id, starts_at, ends_at);
  if (used + quantity > res.capacity) throw conflict(`${res.name} is not available for that slot (${res.capacity - used} of ${res.capacity} free)`);
  const hours = (new Date(ends_at) - new Date(starts_at)) / 3.6e6;
  const price = Math.ceil(hours * res.hourly_rate_cents * quantity);
  return (await c.query(
    `INSERT INTO bookings(resource_id, user_id, team_id, event_id, starts_at, ends_at, quantity, price_cents, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [resource_id, user_id, team_id ?? null, event_id ?? null, starts_at, ends_at, quantity, price, note ?? null],
  )).rows[0];
}

cap({
  name: 'create_venue', method: 'POST', path: '/venues', tag: 'Venues & Booking', auth: ['venue_manager', 'organizer'], status: 201,
  summary: 'Register a venue (stadium, sports complex, club).',
  input: z.object({ name: z.string().min(2).max(80), city: z.string().max(80).optional(), address: z.string().max(200).optional(), emoji: z.string().max(8).optional() }),
  handler: ({ user }, i) => one("INSERT INTO venues(name, city, address, owner_id, emoji) VALUES ($1,$2,$3,$4,coalesce($5,'🏟️')) RETURNING *", [i.name, i.city, i.address, user.id, i.emoji]),
});

cap({
  name: 'list_venues', method: 'GET', path: '/venues', tag: 'Venues & Booking', auth: 'public', summary: 'Browse venues.',
  input: z.object({ city: z.string().optional(), q: z.string().optional(), ...page }),
  handler: (_, i) => many(
    `SELECT v.*, (SELECT count(*)::int FROM resources r WHERE r.venue_id=v.id AND r.active) AS resources,
            (SELECT round(avg(rating),2) FROM testimonials t WHERE t.subject_type='venue' AND t.subject_id=v.id) AS rating
       FROM venues v WHERE ($1::text IS NULL OR v.city ILIKE $1) AND ($2::text IS NULL OR v.name ILIKE '%'||$2||'%')
      ORDER BY v.name LIMIT $3 OFFSET $4`, [i.city ?? null, i.q ?? null, i.limit, i.offset]),
});

cap({
  name: 'get_venue', method: 'GET', path: '/venues/:id', tag: 'Venues & Booking', auth: 'public', summary: 'Venue with its courts, grounds and equipment.',
  input: z.object({ id }),
  async handler(_, i) {
    const v = await mustFind('venues', i.id);
    const resources = await many('SELECT r.*, s.name AS sport, s.emoji AS sport_emoji FROM resources r LEFT JOIN sports s ON s.id=r.sport_id WHERE r.venue_id=$1 AND r.active ORDER BY r.kind, r.name', [i.id]);
    return { ...v, resources };
  },
});

cap({
  name: 'add_resource', method: 'POST', path: '/venues/:id/resources', tag: 'Venues & Booking', status: 201,
  summary: 'Add a bookable court/ground/pool/track/room/equipment pool to a venue you own. capacity = concurrent bookings (or units of equipment).',
  input: z.object({ id, kind: z.enum(['court', 'ground', 'pool', 'track', 'room', 'equipment']), name: z.string().min(1).max(80), sport: z.string().optional(), capacity: z.number().int().min(1).max(1000).default(1), hourly_rate_cents: money.default(0) }),
  async handler({ user }, i) {
    const v = await mustFind('venues', i.id);
    mustOwn(user, v.owner_id, 'venue');
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    if (i.sport && !sport) throw notFound('Sport');
    return one('INSERT INTO resources(venue_id, kind, name, sport_id, capacity, hourly_rate_cents) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [i.id, i.kind, i.name, sport?.id ?? null, i.capacity, i.hourly_rate_cents]);
  },
});

cap({
  name: 'check_availability', method: 'GET', path: '/resources/:id/availability', tag: 'Venues & Booking', auth: 'public',
  summary: 'How many units of a resource are free in a time window.', input: z.object({ id, from: dt, to: dt }),
  async handler(_, i) {
    const r = await mustFind('resources', i.id);
    const used = await usedUnits(pool, i.id, i.from, i.to);
    return { resource_id: r.id, capacity: r.capacity, used, free: Math.max(0, r.capacity - used), available: used < r.capacity };
  },
});

cap({
  name: 'create_booking', method: 'POST', path: '/bookings', tag: 'Venues & Booking', status: 201,
  summary: 'Book a court/ground/equipment slot. Fails with 409 if the slot is taken.',
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
  summary: 'Your bookings; venue owners can pass resource_id to see the schedule of a resource they own.',
  input: z.object({ resource_id: id.optional(), upcoming: z.coerce.boolean().default(true), ...page }),
  async handler({ user }, i) {
    if (i.resource_id) {
      const r = await one('SELECT v.owner_id FROM resources r JOIN venues v ON v.id=r.venue_id WHERE r.id=$1', [i.resource_id]);
      if (!r) throw notFound('Resource');
      if (!isAdmin(user) && r.owner_id !== user.id) throw forbidden();
    }
    return many(
      `SELECT b.*, r.name AS resource_name, r.kind, v.name AS venue_name FROM bookings b JOIN resources r ON r.id=b.resource_id JOIN venues v ON v.id=r.venue_id
        WHERE ($1::uuid IS NULL AND b.user_id=$2 OR b.resource_id=$1) AND ($3 = false OR b.ends_at > now()) AND b.status='confirmed'
        ORDER BY b.starts_at LIMIT $4 OFFSET $5`, [i.resource_id ?? null, user.id, i.upcoming, i.limit, i.offset]);
  },
});

cap({
  name: 'cancel_booking', method: 'DELETE', path: '/bookings/:id', tag: 'Venues & Booking', summary: 'Cancel a booking (the booker or the venue owner).', input: z.object({ id }),
  async handler({ user }, i) {
    const b = await one('SELECT b.*, v.owner_id AS venue_owner FROM bookings b JOIN resources r ON r.id=b.resource_id JOIN venues v ON v.id=r.venue_id WHERE b.id=$1', [i.id]);
    if (!b) throw notFound('Booking');
    if (!isAdmin(user) && ![b.user_id, b.venue_owner].includes(user.id)) throw forbidden();
    await one("UPDATE bookings SET status='cancelled' WHERE id=$1 RETURNING id", [i.id]);
    return { ok: true };
  },
});
