// Venue capacity and seating map (#480 follow-up). Captured when a venue is onboarded: how many spectators it holds and its stands laid out as
// priced zones. Events held at the venue import them as ticket sections (see import_venue_seating in ticketing.js), so a venue describes its
// seating once and every event reuses it. Rules live here on the server; the app only calls these capabilities.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { pool, many, tx } from '../db.js';
import { conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { canManage, mustManage } from '../booking/engine.js';

const TAG = 'Venue seating';
export const PRICE_POINTS = ['premium', 'vip', 'standard', 'economy', 'family', 'accessible', 'custom'];
/** The colours a zone may carry: the app's own palette, so a venue map always matches the theme. */
export const ZONE_COLOURS = ['#8B5CF6', '#22D3EE', '#34D399', '#FBBF24', '#FB923C', '#F43F5E', '#9B72C6', '#A3E635'];
export const POINT_COLOUR = { premium: '#FBBF24', vip: '#9B72C6', standard: '#8B5CF6', economy: '#22D3EE', family: '#34D399', accessible: '#A3E635', custom: '#FB923C' };
const colour = z.string().regex(/^#[0-9A-Fa-f]{6}$/).refine((x) => ZONE_COLOURS.includes(x.toUpperCase()), 'use one of the app colours');
const zoneName = z.string().trim().min(1).max(60);

async function seatsOf(c, venueId, exceptZone = null) {
  return (await c.query('SELECT coalesce(sum(rows_count * seats_per_row),0)::int AS n FROM venue_seat_zones WHERE venue_id=$1 AND archived_at IS NULL AND ($2::uuid IS NULL OR id <> $2)', [venueId, exceptZone])).rows[0].n;
}
const withSeats = (z) => ({ ...z, seats: z.rows_count * z.seats_per_row, default_price_minor: Number(z.default_price_minor) });
/** The seats of every zone may not exceed the capacity the venue declared (standing room is capacity without seats). */
async function assertFits(c, venueId, seats, capacity) {
  if (capacity != null && seats > capacity) throw conflict(`The zones hold ${seats} seats but the venue capacity is ${capacity}. Raise the capacity or make a zone smaller.`, { code: 'zones_exceed_capacity', seats, capacity });
}
const soldFromZone = async (c, zoneId) => (await c.query("SELECT count(*)::int AS n FROM tickets t JOIN ticket_sections s ON s.id=t.section_id WHERE s.venue_zone_id=$1 AND t.status IN ('reserved','issued','refund_due')", [zoneId])).rows[0].n;

cap({
  name: 'get_venue_seating', method: 'GET', path: '/venues/:id/seating', tag: TAG, auth: 'public',
  summary: 'A venue\'s spectator capacity and seating map: its zones (rows by seats, price point, colour, default price) and the total seats. Public for live venues; the venue team can also see it while the venue is pending.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const v = (await pool.query('SELECT id, name, currency, spectator_capacity, approval_status, active FROM venues WHERE id=$1', [i.id])).rows[0];
    if (!v) throw notFound('Venue');
    if (!(v.approval_status === 'approved' && v.active) && !(user && (await canManage(user, v.id)))) throw notFound('Venue');
    const zones = (await many('SELECT * FROM venue_seat_zones WHERE venue_id=$1 AND archived_at IS NULL ORDER BY sort_order, name', [v.id])).map(withSeats);
    return { venue_id: v.id, name: v.name, currency: v.currency, spectator_capacity: v.spectator_capacity, total_seats: zones.reduce((n, z) => n + z.seats, 0), price_points: PRICE_POINTS, zones };
  },
});

cap({
  name: 'set_venue_capacity', method: 'PATCH', path: '/venues/:id/seating', tag: TAG,
  summary: 'Venue team: set how many spectators the venue holds (seated and standing). Events held here use it as their default spectator capacity. It cannot be lower than the seats already laid out in zones.',
  input: z.object({ id, spectator_capacity: z.number().int().min(0).max(1_000_000).nullable() }),
  handler: ({ user }, i) => tx(async (c) => {
    await mustManage(user, i.id, c);
    await assertFits(c, i.id, await seatsOf(c, i.id), i.spectator_capacity);
    await c.query('UPDATE venues SET spectator_capacity=$2 WHERE id=$1', [i.id, i.spectator_capacity]);
    await audit(c, user.id, 'venue.capacity.set', 'venues', i.id);
    return { venue_id: i.id, spectator_capacity: i.spectator_capacity };
  }),
});

cap({
  name: 'create_venue_seat_zone', method: 'POST', path: '/venues/:id/seat-zones', tag: TAG, status: 201,
  summary: 'Venue team: add a ticket zone to the seating map: a name, rows by seats per row, a price point (premium, VIP, standard, economy, family, accessible, custom), a colour from the app palette and a default price in the venue\'s currency. Events held here import it and can create a ticket for it.',
  input: z.object({ id, name: zoneName, price_point: z.enum(PRICE_POINTS).default('standard'), colour: colour.optional(), rows_count: z.number().int().min(1).max(100), seats_per_row: z.number().int().min(1).max(200), default_price_minor: z.coerce.number().int().min(0).max(100_000_000).default(0) }),
  handler: ({ user }, i) => tx(async (c) => {
    await mustManage(user, i.id, c);
    const v = (await c.query('SELECT spectator_capacity FROM venues WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    await assertFits(c, i.id, (await seatsOf(c, i.id)) + i.rows_count * i.seats_per_row, v.spectator_capacity);
    const order = (await c.query('SELECT coalesce(max(sort_order),0)+1 AS n FROM venue_seat_zones WHERE venue_id=$1', [i.id])).rows[0].n;
    try {
      return withSeats((await c.query(
        'INSERT INTO venue_seat_zones(venue_id, name, price_point, colour, rows_count, seats_per_row, default_price_minor, sort_order, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
        [i.id, i.name, i.price_point, (i.colour ?? POINT_COLOUR[i.price_point]).toUpperCase(), i.rows_count, i.seats_per_row, i.default_price_minor, order, user.id])).rows[0]);
    } catch (e) { if (e.code === '23505') throw conflict('A zone with that name already exists'); throw e; }
  }),
});

cap({
  name: 'update_venue_seat_zone', method: 'PATCH', path: '/seat-zones/:id', tag: TAG,
  summary: 'Venue team: change a zone\'s name, price point, colour or default price, or archive it (archived zones are kept; tickets already sold are untouched). The rows and seats of a zone cannot change once tickets have been sold from it.',
  input: z.object({ id, name: zoneName.optional(), price_point: z.enum(PRICE_POINTS).optional(), colour: colour.optional(), rows_count: z.number().int().min(1).max(100).optional(), seats_per_row: z.number().int().min(1).max(200).optional(),
    default_price_minor: z.coerce.number().int().min(0).max(100_000_000).optional(), archived: z.boolean().optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const z = (await c.query('SELECT * FROM venue_seat_zones WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!z) throw notFound('Zone');
    await mustManage(user, z.venue_id, c);
    const rows = i.rows_count ?? z.rows_count, per = i.seats_per_row ?? z.seats_per_row;
    if ((rows !== z.rows_count || per !== z.seats_per_row) && (await soldFromZone(c, z.id))) throw conflict('Tickets have been sold from this zone, so its rows and seats cannot change. Add a new zone instead.', { code: 'zone_in_use' });
    const v = (await c.query('SELECT spectator_capacity FROM venues WHERE id=$1', [z.venue_id])).rows[0];
    if (i.archived !== true) await assertFits(c, z.venue_id, (await seatsOf(c, z.venue_id, z.id)) + rows * per, v.spectator_capacity);
    try {
      return withSeats((await c.query(
        `UPDATE venue_seat_zones SET name=coalesce($2,name), price_point=coalesce($3,price_point), colour=coalesce($4,colour), rows_count=$5, seats_per_row=$6, default_price_minor=coalesce($7,default_price_minor),
                archived_at=CASE WHEN $8::boolean IS NULL THEN archived_at WHEN $8 THEN coalesce(archived_at, now()) ELSE NULL END WHERE id=$1 RETURNING *`,
        [z.id, i.name ?? null, i.price_point ?? null, i.colour?.toUpperCase() ?? null, rows, per, i.default_price_minor ?? null, i.archived ?? null])).rows[0]);
    } catch (e) { if (e.code === '23505') throw conflict('A zone with that name already exists'); throw e; }
  }),
});

