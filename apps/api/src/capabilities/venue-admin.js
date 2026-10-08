// Venue management: profile, opening hours, contacts, staff, areas, pricing rules, discounts, bulk blocks,
// admin overrides, schedule, payments bookkeeping and reports. Everything here needs the venue team (owner, staff or platform admin).
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin, mustFind, patchRow, sportBySlugOrId } from '../helpers.js';
import { encryptFields, decryptFields } from '../crypto.js';
import { notify } from '../notify.js';
import { canManage, mustManage, lockResources, usedUnits, createReservation, reservationView, cancelBookings } from '../booking/engine.js';
import { hhmm, fmtMin, fromLocal, toLocal, addDays, dateRange } from '../booking/time.js';
import { venueProfile, VENUE_PROFILE_FIELDS, KINDS } from './venues.js';

const TAG = 'Venue management';
const dt = z.string().datetime({ offset: true });
const day = z.string().date();
const clock = z.string().regex(/^\d{1,2}:\d{2}$/, 'use HH:MM').refine((s) => !Number.isNaN(hhmm(s)), 'not a valid time');
const weekdays = z.array(z.number().int().min(0).max(6)).min(1).max(7).describe('0 = Sunday … 6 = Saturday');
const csv = (schema) => z.union([z.array(schema), z.string().transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))]);

// ------------------------------------------------------------------ sports
cap({
  name: 'create_sport', method: 'POST', path: '/sports', tag: TAG, auth: ['venue_manager', 'organizer'], status: 201,
  summary: 'Add a sport that is not in the catalogue yet so venues can offer it (a venue can host any sport). Returns the existing one if the name is already there.',
  input: z.object({ name: z.string().min(2).max(40), emoji: z.string().max(8).optional(), scoring: z.enum(['points', 'time', 'distance', 'goals', 'sets']).default('points') }),
  async handler(_, i) {
    const slug = i.name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (slug.length < 2) throw badRequest('Give the sport a name with letters or digits');
    return (await one('INSERT INTO sports(slug, name, emoji, scoring) VALUES ($1,$2,coalesce($3,\'🏅\'),$4) ON CONFLICT (slug) DO NOTHING RETURNING *', [slug, i.name, i.emoji ?? null, i.scoring]))
      ?? one('SELECT * FROM sports WHERE slug=$1', [slug]);
  },
});

// ------------------------------------------------------------------ profile
cap({
  name: 'update_venue', method: 'PATCH', path: '/venues/:id', tag: TAG,
  summary: 'Edit a venue you run: name, address, map coordinates, time zone, currency, public phone/email/website, amenities, booking window, cancellation policy, notification switch. `active: false` hides it from search and stops new bookings.',
  input: z.object({ id, name: z.string().min(2).max(80).optional(), city: z.string().max(80).optional(), address: z.string().max(200).optional(), emoji: z.string().max(8).optional(), active: z.boolean().optional(), ...venueProfile })
    .refine((i) => (i.latitude == null) === (i.longitude == null), 'latitude and longitude go together'),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    return patchRow('venues', i.id, i, ['name', 'city', 'address', 'emoji', 'active', ...VENUE_PROFILE_FIELDS]);
  },
});

cap({
  name: 'set_venue_hours', method: 'POST', path: '/venues/:id/hours', tag: TAG,
  summary: 'Replace the weekly opening hours (venue local time). Several intervals per weekday are allowed (split shifts); a weekday with none is closed. An empty list means open around the clock. Slots outside these hours are not bookable.',
  input: z.object({ id, hours: z.array(z.object({ weekday: z.number().int().min(0).max(6), opens: clock, closes: clock })).max(70) }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    const rows = i.hours.map((h) => ({ weekday: h.weekday, o: hhmm(h.opens), c: hhmm(h.closes) }));
    for (const r of rows) if (r.c <= r.o) throw badRequest('closes must be after opens');
    for (const a of rows) for (const b of rows) if (a !== b && a.weekday === b.weekday && a.o < b.c && b.o < a.c) throw badRequest('Opening intervals on the same day overlap');
    await tx(async (c) => {
      await c.query('UPDATE venue_hours SET removed_at=now() WHERE venue_id=$1 AND removed_at IS NULL', [i.id]);
      for (const r of rows) await c.query('INSERT INTO venue_hours(venue_id, weekday, opens_min, closes_min) VALUES ($1,$2,$3,$4)', [i.id, r.weekday, r.o, r.c]);
    });
    return { hours: await many('SELECT weekday, opens_min, closes_min FROM venue_hours WHERE venue_id=$1 AND removed_at IS NULL ORDER BY weekday, opens_min', [i.id]), open_around_the_clock: rows.length === 0 };
  },
});

cap({
  name: 'list_my_venues', method: 'GET', path: '/me/venues', tag: TAG, summary: 'Venues you own or help run, with your role.',
  handler: ({ user }) => many(
    `SELECT v.id, v.name, v.emoji, v.city, v.active, 'owner' AS role FROM venues v WHERE v.owner_id=$1
     UNION ALL SELECT v.id, v.name, v.emoji, v.city, v.active, s.role FROM venue_staff s JOIN venues v ON v.id=s.venue_id WHERE s.user_id=$1 AND s.removed_at IS NULL ORDER BY name`, [user.id]),
});

// ------------------------------------------------------------------ contacts (personal data: encrypted, audit-logged)
const CONTACT = ['name', 'phone', 'email'];
cap({
  name: 'add_venue_contact', method: 'POST', path: '/venues/:id/contacts', tag: TAG, status: 201,
  summary: 'Add a named contact person (manager, reception, emergency, billing). Name, phone and email are encrypted at rest. `is_public` shows it to every signed-in user; otherwise only the venue team sees it.',
  input: z.object({ id, role: z.string().min(2).max(30).default('general'), name: z.string().min(1).max(80).optional(), phone: z.string().max(30).optional(), email: z.string().email().optional(), is_public: z.boolean().default(false) })
    .refine((i) => i.name || i.phone || i.email, 'Give at least a name, phone or email'),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    const e = encryptFields(i, 'venue_contacts', CONTACT);
    const r = await one('INSERT INTO venue_contacts(venue_id, role, name_enc, phone_enc, email_enc, is_public) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, role, is_public',
      [i.id, i.role, e.name_enc ?? null, e.phone_enc ?? null, e.email_enc ?? null, i.is_public]);
    return r;
  },
});

cap({
  name: 'list_venue_contacts', method: 'GET', path: '/venues/:id/contacts', tag: TAG,
  summary: 'Contact people of a venue. The venue team sees all; everyone else (signed in) sees the public ones. Reads of the decrypted details are audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await mustFind('venues', i.id);
    const staff = await canManage(user, i.id);
    const rows = await many('SELECT * FROM venue_contacts WHERE venue_id=$1 AND removed_at IS NULL AND ($2 OR is_public) ORDER BY created_at', [i.id, staff]);
    if (rows.length) await audit(null, user.id, 'read_pii', 'venue_contacts', i.id);
    return rows.map((r) => ({ id: r.id, role: r.role, is_public: r.is_public, ...decryptFields(r, 'venue_contacts', CONTACT) }));
  },
});

cap({
  name: 'delete_venue_contact', method: 'DELETE', path: '/venues/:id/contacts/:contact_id', tag: TAG, summary: 'Remove a contact person.',
  input: z.object({ id, contact_id: id }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    if (!(await one('UPDATE venue_contacts SET removed_at=now() WHERE id=$1 AND venue_id=$2 AND removed_at IS NULL RETURNING id', [i.contact_id, i.id]))) throw notFound('Contact');
    return { ok: true };
  },
});

// ------------------------------------------------------------------ staff
const ownerOnly = async (user, venueId) => {
  const v = await mustFind('venues', venueId, 'owner_id');
  if (!isAdmin(user) && v.owner_id !== user.id) throw forbidden('Only the venue owner can manage staff');
};
cap({
  name: 'add_venue_staff', method: 'POST', path: '/venues/:id/staff', tag: TAG, status: 201,
  summary: 'Give another user (by handle) access to run this venue: bookings, blocks, pricing, discounts, reports. Owner only.',
  input: z.object({ id, handle: z.string().min(3).max(24) }),
  async handler({ user }, i) {
    await ownerOnly(user, i.id);
    const u = await one('SELECT id, handle, display_name FROM users WHERE handle=$1', [i.handle.toLowerCase()]);
    if (!u) throw notFound('User');
    await one("INSERT INTO venue_staff(venue_id, user_id, role) VALUES ($1,$2,'manager') ON CONFLICT (venue_id, user_id) DO UPDATE SET removed_at=NULL RETURNING user_id", [i.id, u.id]);
    await notify(null, u.id, { kind: 'venue_staff_added', title: 'You can now manage a venue', body: `${user.display_name} added you to the team.`, data: { venue_id: i.id } });
    return { ...u, role: 'manager' };
  },
});
cap({
  name: 'list_venue_staff', method: 'GET', path: '/venues/:id/staff', tag: TAG, summary: 'Owner and staff of a venue (team only).', input: z.object({ id }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    return many(`SELECT u.id, u.handle, u.display_name, 'owner' AS role FROM venues v JOIN users u ON u.id=v.owner_id WHERE v.id=$1
                 UNION ALL SELECT u.id, u.handle, u.display_name, s.role FROM venue_staff s JOIN users u ON u.id=s.user_id WHERE s.venue_id=$1 AND s.removed_at IS NULL`, [i.id]);
  },
});
cap({
  name: 'remove_venue_staff', method: 'DELETE', path: '/venues/:id/staff/:user_id', tag: TAG, summary: 'Remove a staff member. Owner only.', input: z.object({ id, user_id: id }),
  async handler({ user }, i) {
    await ownerOnly(user, i.id);
    await one('UPDATE venue_staff SET removed_at=now() WHERE venue_id=$1 AND user_id=$2 AND removed_at IS NULL RETURNING user_id', [i.id, i.user_id]);
    return { ok: true };
  },
});

// ------------------------------------------------------------------ areas
cap({
  name: 'update_resource', method: 'PATCH', path: '/resources/:id', tag: TAG,
  summary: 'Edit a court/table/area: name, kind, sport, capacity (concurrent bookings / units), max_players, slot length, min/max slots, base rate, surface, indoor. `active: false` retires it (existing bookings stay).',
  input: z.object({
    id, kind: z.enum(KINDS).optional(), name: z.string().min(1).max(80).optional(), sport: z.string().optional(), capacity: z.number().int().min(1).max(1000).optional(),
    hourly_rate_cents: money.optional(), max_players: z.number().int().min(1).max(1000).optional(), description: z.string().max(500).optional(), surface: z.string().max(60).optional(), indoor: z.boolean().optional(),
    slot_minutes: z.union([z.literal(15), z.literal(20), z.literal(30), z.literal(45), z.literal(60), z.literal(90), z.literal(120)]).optional(),
    min_slots: z.number().int().min(1).max(48).optional(), max_slots: z.number().int().min(1).max(48).optional(), active: z.boolean().optional(),
  }),
  async handler({ user }, i) {
    const r = await mustFind('resources', i.id);
    await mustManage(user, r.venue_id);
    const patch = { ...i };
    if (i.sport) { const s = await sportBySlugOrId(i.sport); if (!s) throw notFound('Sport'); patch.sport_id = s.id; }
    if ((patch.max_slots ?? r.max_slots) < (patch.min_slots ?? r.min_slots)) throw badRequest('max_slots must be at least min_slots');
    return patchRow('resources', i.id, patch, ['kind', 'name', 'sport_id', 'capacity', 'hourly_rate_cents', 'max_players', 'description', 'surface', 'indoor', 'slot_minutes', 'min_slots', 'max_slots', 'active']);
  },
});

// ------------------------------------------------------------------ pricing rules
const ruleFields = {
  name: z.string().min(1).max(60), resource_id: id.optional().describe('omit = every area of the venue'), weekdays: weekdays.optional().describe('omit = every day'),
  start: clock.default('00:00'), end: clock.default('24:00'), hourly_rate_cents: money,
  valid_from: day.optional(), valid_to: day.optional(), priority: z.number().int().min(-100).max(100).default(0),
};
cap({
  name: 'create_price_rule', method: 'POST', path: '/venues/:id/price-rules', tag: TAG, status: 201,
  summary: 'Add a rate for a time band, e.g. "Weekday evenings 18:00–22:00 = 1200/h", "Weekend", "Summer season". The most specific rule wins (area-specific, then higher priority, then newest); with no matching rule the area\'s base rate applies. Prices are evaluated slot by slot in venue local time.',
  input: z.object({ id, ...ruleFields }).refine((i) => hhmm(i.end) > hhmm(i.start), 'end must be after start').refine((i) => !i.valid_from || !i.valid_to || i.valid_to >= i.valid_from, 'valid_to is before valid_from'),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    if (i.resource_id) { const r = await mustFind('resources', i.resource_id); if (r.venue_id !== i.id) throw badRequest('That area belongs to another venue'); }
    return one(`INSERT INTO price_rules(venue_id, resource_id, name, weekdays, start_min, end_min, hourly_rate_cents, valid_from, valid_to, priority)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [i.id, i.resource_id ?? null, i.name, i.weekdays ?? null, hhmm(i.start), hhmm(i.end), i.hourly_rate_cents, i.valid_from ?? null, i.valid_to ?? null, i.priority]);
  },
});
cap({
  name: 'list_price_rules', method: 'GET', path: '/venues/:id/price-rules', tag: TAG, auth: 'public', summary: 'The venue\'s published rate card (price rules + each area\'s base rate).', input: z.object({ id }),
  async handler(_, i) {
    await mustFind('venues', i.id);
    const [rules, base] = await Promise.all([
      many('SELECT * FROM price_rules WHERE venue_id=$1 AND active ORDER BY priority DESC, created_at DESC', [i.id]),
      many('SELECT id AS resource_id, name, kind, hourly_rate_cents, slot_minutes FROM resources WHERE venue_id=$1 AND active ORDER BY name', [i.id]),
    ]);
    return { rules: rules.map((r) => ({ ...r, start: fmtMin(r.start_min), end: fmtMin(r.end_min) })), base_rates: base };
  },
});
cap({
  name: 'update_price_rule', method: 'PATCH', path: '/price-rules/:id', tag: TAG, summary: 'Change a price rule (or `active: false` to retire it).',
  input: z.object({ id, name: ruleFields.name.optional(), weekdays: ruleFields.weekdays, start: clock.optional(), end: clock.optional(), hourly_rate_cents: money.optional(), valid_from: day.optional(), valid_to: day.optional(), priority: ruleFields.priority.optional(), active: z.boolean().optional() }),
  async handler({ user }, i) {
    const r = await mustFind('price_rules', i.id);
    await mustManage(user, r.venue_id);
    const p = { ...i, start_min: i.start ? hhmm(i.start) : undefined, end_min: i.end ? hhmm(i.end) : undefined };
    if ((p.end_min ?? r.end_min) <= (p.start_min ?? r.start_min)) throw badRequest('end must be after start');
    return patchRow('price_rules', i.id, p, ['name', 'weekdays', 'start_min', 'end_min', 'hourly_rate_cents', 'valid_from', 'valid_to', 'priority', 'active']);
  },
});
cap({
  name: 'delete_price_rule', method: 'DELETE', path: '/price-rules/:id', tag: TAG, summary: 'Delete a price rule. Existing bookings keep the price they were made at.', input: z.object({ id }),
  async handler({ user }, i) {
    const r = await mustFind('price_rules', i.id);
    await mustManage(user, r.venue_id);
    await one('UPDATE price_rules SET active=false WHERE id=$1 RETURNING id', [i.id]);
    return { ok: true };
  },
});

// ------------------------------------------------------------------ discounts
const discountFields = {
  name: z.string().min(1).max(60), code: z.string().regex(/^[A-Za-z0-9_-]{3,24}$/, '3–24 letters, digits, - or _').optional().describe('omit = applies automatically'),
  kind: z.enum(['percent', 'fixed']), value: z.number().int().min(1), resource_id: id.optional(), min_slots: z.number().int().min(1).max(100).default(1),
  weekdays: weekdays.optional(), valid_from: day.optional(), valid_to: day.optional(),
  max_redemptions: z.number().int().min(1).optional(), per_user_limit: z.number().int().min(1).optional(),
};
cap({
  name: 'create_discount', method: 'POST', path: '/venues/:id/discounts', tag: TAG, status: 201,
  summary: 'Create a discount: percent or fixed amount; automatic (e.g. "3+ slots = 10% off", "weekday mornings") or behind a promo code; optionally limited to an area, weekdays, dates, total redemptions and per-user uses. The customer gets the single best discount per venue.',
  input: z.object({ id, ...discountFields }).refine((i) => i.kind !== 'percent' || i.value <= 100, 'percent is at most 100'),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    if (i.resource_id && (await mustFind('resources', i.resource_id)).venue_id !== i.id) throw badRequest('That area belongs to another venue');
    return one(`INSERT INTO discounts(venue_id, resource_id, name, code, kind, value, min_slots, weekdays, valid_from, valid_to, max_redemptions, per_user_limit, created_by)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [i.id, i.resource_id ?? null, i.name, i.code ?? null, i.kind, i.value, i.min_slots, i.weekdays ?? null, i.valid_from ?? null, i.valid_to ?? null, i.max_redemptions ?? null, i.per_user_limit ?? null, user.id]);
  },
});
cap({
  name: 'list_discounts', method: 'GET', path: '/venues/:id/discounts', tag: TAG, summary: 'All discounts of a venue with how often each was used (team only: promo codes are not public).', input: z.object({ id, include_inactive: z.coerce.boolean().default(false) }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    return many(`SELECT d.*, (SELECT count(*)::int FROM discount_redemptions x WHERE x.discount_id=d.id) AS redemptions,
                        (SELECT coalesce(sum(amount_cents),0)::int FROM discount_redemptions x WHERE x.discount_id=d.id) AS given_cents
                   FROM discounts d WHERE d.venue_id=$1 AND ($2 OR d.active) ORDER BY d.active DESC, d.created_at DESC`, [i.id, i.include_inactive]);
  },
});
cap({
  name: 'update_discount', method: 'PATCH', path: '/discounts/:id', tag: TAG, summary: 'Edit a discount, or `active: false` to stop it. Reservations already made keep what they got until they are modified.',
  input: z.object({ id, name: discountFields.name.optional(), value: z.number().int().min(1).optional(), min_slots: discountFields.min_slots.optional(), weekdays: weekdays.optional(), valid_from: day.optional(), valid_to: day.optional(), max_redemptions: discountFields.max_redemptions, per_user_limit: discountFields.per_user_limit, active: z.boolean().optional() }),
  async handler({ user }, i) {
    const d = await mustFind('discounts', i.id);
    await mustManage(user, d.venue_id);
    if (d.kind === 'percent' && (i.value ?? 0) > 100) throw badRequest('percent is at most 100');
    return patchRow('discounts', i.id, i, ['name', 'value', 'min_slots', 'weekdays', 'valid_from', 'valid_to', 'max_redemptions', 'per_user_limit', 'active']);
  },
});

// ------------------------------------------------------------------ blocks (bulk)
const conflictRows = (c, venueId, resourceIds, starts, ends) => c.query(
  `SELECT DISTINCT b.id, b.starts_at, b.ends_at, b.user_id, r.name AS resource_name, r.id AS resource_id
     FROM bookings b JOIN resources r ON r.id=b.resource_id
     JOIN unnest($2::timestamptz[], $3::timestamptz[]) AS t(s, e) ON b.starts_at < t.e AND b.ends_at > t.s
    WHERE r.venue_id=$1 AND b.status='confirmed' AND (cardinality($4::uuid[]) = 0 OR b.resource_id = ANY($4::uuid[])) ORDER BY b.starts_at`,
  [venueId, starts, ends, resourceIds]).then((r) => r.rows);

cap({
  name: 'block_slots', method: 'POST', path: '/venues/:id/blocks', tag: TAG, status: 201,
  summary: 'Block time in bulk — for maintenance, holidays, private hire, league nights. Pick areas (omit = the whole venue), a date range, optional weekdays and a daily time band (default all day, venue local time). Blocked time cannot be booked by customers. If confirmed bookings fall in it you get 409 with the list unless `cancel_conflicting: true` (they are cancelled with a full refund and the customers notified). `dry_run: true` previews without changing anything.',
  input: z.object({
    id, resource_ids: z.array(id).max(100).default([]), from_date: day, to_date: day, weekdays: weekdays.optional(),
    start_time: clock.default('00:00'), end_time: clock.default('24:00'), kind: z.enum(['maintenance', 'holiday', 'event', 'private', 'other']).default('other'), reason: z.string().max(200).optional(),
    cancel_conflicting: z.boolean().default(false), dry_run: z.boolean().default(false),
  }).refine((i) => i.to_date >= i.from_date, 'to_date is before from_date').refine((i) => hhmm(i.end_time) > hhmm(i.start_time), 'end_time must be after start_time'),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    const venue = await mustFind('venues', i.id);
    const dates = dateRange(i.from_date, i.to_date);
    if (dates.length > 366) throw badRequest('Block at most a year at a time');
    const own = (await many('SELECT id FROM resources WHERE venue_id=$1', [i.id])).map((r) => r.id);
    for (const r of i.resource_ids) if (!own.includes(r)) throw badRequest('One of those areas belongs to another venue');
    const [s, e] = [hhmm(i.start_time), hhmm(i.end_time)];
    const days = dates.filter((d) => !i.weekdays || i.weekdays.includes(toLocal(fromLocal(d, 720, venue.timezone), venue.timezone).weekday));
    const targets = i.resource_ids.length ? i.resource_ids : [null];
    if (days.length * targets.length > 3000) throw badRequest('That would create more than 3000 blocks — narrow the dates or areas');
    const starts = days.map((d) => fromLocal(d, s, venue.timezone));
    const ends = days.map((d) => fromLocal(d, e, venue.timezone));
    return tx(async (c) => {
      await lockResources(c, i.resource_ids.length ? i.resource_ids : own);
      const hits = await conflictRows(c, i.id, i.resource_ids, starts, ends);
      const summary = { blocks: days.length * targets.length, conflicts: hits.length };
      if (i.dry_run) return { dry_run: true, would_create: summary.blocks, conflicting_bookings: hits.slice(0, 50), conflicts: hits.length };
      if (hits.length && !i.cancel_conflicting) {
        throw new AppError(409, 'conflict', `${hits.length} confirmed booking(s) fall inside that time. Re-send with cancel_conflicting: true to cancel and refund them, or pick other times.`, { conflicting_bookings: hits.slice(0, 50), conflicts: hits.length });
      }
      const cancelled = hits.length ? await cancelBookings(c, hits.map((h) => h.id), { actor: user, byVenue: true, reason: `${venue.name} is closed${i.reason ? `: ${i.reason}` : ''}` }) : [];
      const batch = randomUUID();
      const rows = [];
      for (let k = 0; k < days.length; k++) for (const t of targets) rows.push([t, starts[k], ends[k]]);
      await c.query(
        `INSERT INTO venue_blocks(venue_id, resource_id, starts_at, ends_at, kind, reason, batch_id, created_by)
         SELECT $1, t.r, t.s, t.e, $5, $6, $7, $8 FROM unnest($2::uuid[], $3::timestamptz[], $4::timestamptz[]) AS t(r, s, e)`,
        [i.id, rows.map((x) => x[0]), rows.map((x) => x[1]), rows.map((x) => x[2]), i.kind, i.reason ?? null, batch, user.id]);
      await audit(c, user.id, 'block_slots', 'venues', i.id);
      return { batch_id: batch, blocks: rows.length, cancelled_bookings: cancelled.length };
    });
  },
});

cap({
  name: 'list_blocks', method: 'GET', path: '/venues/:id/blocks', tag: TAG, summary: 'Blocked time of a venue (team only), optionally within a date range.',
  input: z.object({ id, from: dt.optional(), to: dt.optional(), ...page }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    return many(`SELECT k.*, r.name AS resource_name FROM venue_blocks k LEFT JOIN resources r ON r.id=k.resource_id
                  WHERE k.released_at IS NULL AND k.venue_id=$1 AND ($2::timestamptz IS NULL OR k.ends_at > $2) AND ($3::timestamptz IS NULL OR k.starts_at < $3) ORDER BY k.starts_at LIMIT $4 OFFSET $5`,
      [i.id, i.from ?? null, i.to ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'release_blocks', method: 'DELETE', path: '/venues/:id/blocks', tag: TAG, summary: 'Lift blocks in bulk: a whole `batch_id` (what block_slots returned) or specific `ids`.',
  input: z.object({ id, batch_id: id.optional(), ids: csv(id).optional() }).refine((i) => i.batch_id || i.ids?.length, 'Give batch_id or ids'),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    const r = await pool.query('UPDATE venue_blocks SET released_at=now() WHERE released_at IS NULL AND venue_id=$1 AND (batch_id = $2 OR id = ANY($3::uuid[]))', [i.id, i.batch_id ?? null, i.ids ?? []]);
    return { released: r.rowCount };
  },
});

// ------------------------------------------------------------------ admin override
cap({
  name: 'override_booking', method: 'POST', path: '/venues/:id/override-bookings', tag: TAG, status: 201,
  summary: 'Venue-team override: put one or more bookings on the calendar regardless of customer rules (opening hours, notice, blocks, slot limits). Use it for walk-ins, phone bookings, league nights, comps (`price_cents` per line, 0 = free). With `displace_conflicts: true` bookings that are in the way are cancelled with a full refund and their owners notified; without it the area must have free capacity. Attach it to a user account (`user_handle`) or record a walk-in guest (name/phone encrypted). Audit-logged with a mandatory reason.',
  input: z.object({
    id, items: z.array(z.object({ resource_id: id, starts_at: dt, ends_at: dt, quantity: z.number().int().min(1).default(1), players: z.number().int().min(1).optional(), price_cents: money.optional() })).min(1).max(50),
    reason: z.string().min(3).max(300), user_handle: z.string().optional(), guest_name: z.string().max(80).optional(), guest_phone: z.string().max(30).optional(),
    displace_conflicts: z.boolean().default(false), ignore_blocks: z.boolean().default(true), note: z.string().max(300).optional(),
  }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    const owners = await many('SELECT id FROM resources WHERE venue_id=$1', [i.id]);
    if (i.items.some((x) => !owners.some((o) => o.id === x.resource_id))) throw badRequest('Every area must belong to this venue');
    let target = user;
    if (i.user_handle) { target = await one('SELECT id, display_name FROM users WHERE handle=$1', [i.user_handle.toLowerCase()]); if (!target) throw notFound('User'); }
    const guest = (i.guest_name || i.guest_phone) ? (({ guest_name_enc, guest_phone_enc }) => ({ name: guest_name_enc, phone: guest_phone_enc }))(encryptFields({ guest_name: i.guest_name, guest_phone: i.guest_phone }, 'bookings', ['guest_name', 'guest_phone'])) : undefined;
    return tx(async (c) => {
      await lockResources(c, i.items.map((x) => x.resource_id));
      let displaced = 0;
      if (i.displace_conflicts) {
        for (const it of i.items) {
          const room = (await c.query('SELECT capacity FROM resources WHERE id=$1', [it.resource_id])).rows[0].capacity;
          let used = await usedUnits(c, it.resource_id, it.starts_at, it.ends_at);
          if (used + (it.quantity ?? 1) <= room) continue;
          const { rows: inWay } = await c.query("SELECT id, quantity FROM bookings WHERE resource_id=$1 AND status='confirmed' AND starts_at < $3 AND ends_at > $2 ORDER BY created_at DESC", [it.resource_id, it.starts_at, it.ends_at]);
          const out = [];
          for (const b of inWay) { if (used + (it.quantity ?? 1) <= room) break; out.push(b.id); used -= b.quantity; }
          displaced += (await cancelBookings(c, out, { actor: user, byVenue: true, reason: `Venue override: ${i.reason}` })).length;
        }
      }
      const made = await createReservation(c, {
        user, userId: target.id, items: i.items, note: i.note, staff: true, source: 'admin', ignoreBlocks: i.ignore_blocks, guest,
        prices: i.items.map((x) => x.price_cents),
      });
      await audit(c, user.id, 'override_booking', 'reservations', made.reservationId);
      if (target.id !== user.id) {
        await notify(c, target.id, { kind: 'reservation_confirmed', title: 'A venue booked you in', body: `${user.display_name} reserved ${i.items.length} slot(s) for you.`, data: { reservation_id: made.reservationId, venue_id: i.id } });
      }
      return { ...(await reservationView(c, made.reservationId)), displaced_bookings: displaced };
    });
  },
});

// ------------------------------------------------------------------ schedule & bookkeeping
cap({
  name: 'venue_schedule', method: 'GET', path: '/venues/:id/schedule', tag: TAG,
  summary: 'The venue team\'s calendar: every booking (with customer name or walk-in guest) and block between two instants, optionally for one area. Reading guest details is audit-logged.',
  input: z.object({ id, from: dt, to: dt, resource_id: id.optional(), include_cancelled: z.coerce.boolean().default(false) }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    const rows = await many(
      `SELECT b.id, b.reservation_id, b.resource_id, r.name AS resource_name, b.starts_at, b.ends_at, b.quantity, b.slots, b.players, b.status, b.source, b.price_cents, b.discount_cents, b.payment_status, b.note, b.cancel_reason,
              u.id AS customer_id, u.display_name AS customer, b.guest_name_enc, b.guest_phone_enc, rs.code AS reservation_code
         FROM bookings b JOIN resources r ON r.id=b.resource_id JOIN users u ON u.id=b.user_id LEFT JOIN reservations rs ON rs.id=b.reservation_id
        WHERE r.venue_id=$1 AND b.starts_at < $3 AND b.ends_at > $2 AND ($4::uuid IS NULL OR b.resource_id=$4) AND ($5 OR b.status <> 'cancelled') ORDER BY b.starts_at, r.name`,
      [i.id, i.from, i.to, i.resource_id ?? null, i.include_cancelled]);
    if (rows.some((r) => r.guest_name_enc || r.guest_phone_enc)) await audit(null, user.id, 'read_pii', 'bookings', i.id);
    const blocks = await many('SELECT id, resource_id, starts_at, ends_at, kind, reason, batch_id FROM venue_blocks WHERE released_at IS NULL AND venue_id=$1 AND starts_at < $3 AND ends_at > $2 AND ($4::uuid IS NULL OR resource_id IS NULL OR resource_id=$4) ORDER BY starts_at', [i.id, i.from, i.to, i.resource_id ?? null]);
    return {
      bookings: rows.map(({ guest_name_enc, guest_phone_enc, ...b }) => ({ ...b, ...(guest_name_enc || guest_phone_enc ? { guest: { name: guest_name_enc ? decryptFields({ guest_name_enc }, 'bookings', ['guest_name']).guest_name : null, phone: guest_phone_enc ? decryptFields({ guest_phone_enc }, 'bookings', ['guest_phone']).guest_phone : null } } : {}) })),
      blocks,
    };
  },
});

async function staffBooking(user, bookingId) {
  const b = await one('SELECT b.*, r.venue_id FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE b.id=$1', [bookingId]);
  if (!b) throw notFound('Booking');
  await mustManage(user, b.venue_id);
  return b;
}
cap({
  name: 'set_booking_payment', method: 'POST', path: '/bookings/:id/payment', tag: TAG,
  summary: 'Record how a booking was settled at the venue: paid, unpaid, refunded (after a refund was handed back) or waived. Online card checkout for bookings is not wired in yet.',
  input: z.object({ id, status: z.enum(['unpaid', 'paid', 'refunded', 'waived']) }),
  async handler({ user }, i) {
    const b = await staffBooking(user, i.id);
    if (b.status === 'cancelled' && i.status === 'paid') throw badRequest('That booking is cancelled');
    return one('UPDATE bookings SET payment_status=$2, updated_at=now() WHERE id=$1 RETURNING id, status, price_cents, refund_cents, payment_status', [i.id, i.status]);
  },
});
cap({
  name: 'mark_no_show', method: 'POST', path: '/bookings/:id/no-show', tag: TAG, summary: 'Mark a booking whose customer did not turn up (after it started). The money stays due; it shows up in reports.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const b = await staffBooking(user, i.id);
    if (b.status !== 'confirmed') throw conflict('Only a confirmed booking can be a no-show');
    if (b.starts_at > new Date()) throw badRequest("It hasn't started yet");
    return one("UPDATE bookings SET status='no_show', updated_at=now() WHERE id=$1 RETURNING id, status", [i.id]);
  },
});

// ------------------------------------------------------------------ reports
/** Open minutes of a resource across `dates`, minus the union of blocks that apply to it. */
function availableMinutes(hours, venue, resourceId, dates, blocks) {
  let total = 0;
  const mine = blocks.filter((k) => k.resource_id === null || k.resource_id === resourceId).sort((a, b) => a.starts_at - b.starts_at);
  for (const d of dates) {
    const wd = toLocal(fromLocal(d, 720, venue.timezone), venue.timezone).weekday;
    const ivs = hours.length ? hours.filter((h) => h.weekday === wd).map((h) => [h.opens_min, h.closes_min]) : [[0, 1440]];
    for (const [o, c] of ivs) {
      const [a, b] = [fromLocal(d, o, venue.timezone).getTime(), fromLocal(d, c, venue.timezone).getTime()];
      let blocked = 0, cursor = a;
      for (const k of mine) {
        const s = Math.max(k.starts_at.getTime(), cursor), e = Math.min(k.ends_at.getTime(), b);
        if (e > s) { blocked += e - s; cursor = e; }
      }
      total += (b - a - blocked) / 60_000;
    }
  }
  return total;
}

cap({
  name: 'venue_report', method: 'GET', path: '/venues/:id/reports', tag: TAG,
  summary: 'Management report for a date range (venue local dates, up to a year): revenue (gross, discounts, net, cancellation fees, refunds, paid vs outstanding), bookings, unit-hours, no-shows and cancellations, a revenue/bookings time series (day/week/month), utilisation per area (booked ÷ open, blocked time excluded), busiest weekdays and hours, discount performance, customers (new vs repeat, top spenders), and booking channels.',
  input: z.object({ id, from: day, to: day, group_by: z.enum(['day', 'week', 'month']).default('day') }).refine((i) => i.to >= i.from, 'to is before from'),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    const venue = await mustFind('venues', i.id);
    const dates = dateRange(i.from, i.to);
    if (dates.length > 366) throw badRequest('Report at most a year at a time');
    const [from, to] = [fromLocal(i.from, 0, venue.timezone), fromLocal(addDays(i.to, 1), 0, venue.timezone)];
    const P = [i.id, from, to, venue.timezone];
    const ACTIVE = "b.status IN ('confirmed','no_show')";
    const base = `FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE r.venue_id=$1 AND b.starts_at >= $2 AND b.starts_at < $3`;
    const sums = `count(*) FILTER (WHERE ${ACTIVE})::int AS bookings,
      coalesce(sum(extract(epoch FROM b.ends_at - b.starts_at) / 3600 * b.quantity) FILTER (WHERE ${ACTIVE}), 0)::float8 AS unit_hours,
      coalesce(sum(b.base_cents) FILTER (WHERE ${ACTIVE}), 0)::int AS gross_cents,
      coalesce(sum(b.discount_cents) FILTER (WHERE ${ACTIVE}), 0)::int AS discount_cents,
      coalesce(sum(b.price_cents) FILTER (WHERE ${ACTIVE}), 0)::int AS net_cents,
      count(*) FILTER (WHERE b.status='cancelled')::int AS cancellations,
      coalesce(sum(b.price_cents - b.refund_cents) FILTER (WHERE b.status='cancelled'), 0)::int AS cancellation_fee_cents,
      coalesce(sum(b.refund_cents) FILTER (WHERE b.status='cancelled'), 0)::int AS refunded_cents,
      count(*) FILTER (WHERE b.status='no_show')::int AS no_shows`;
    const [tot, series, byRes, byDow, byHour, disc, cust, channels, hoursRows, blocks, payments] = await Promise.all([
      one(`SELECT ${sums} ${base}`, P.slice(0, 3)),
      many(`SELECT to_char(date_trunc($5, b.starts_at AT TIME ZONE $4), 'YYYY-MM-DD') AS period, ${sums} ${base} GROUP BY 1 ORDER BY 1`, [...P, i.group_by]),
      many(`SELECT r.id AS resource_id, r.name, r.kind, r.capacity, ${sums} ${base} GROUP BY r.id ORDER BY net_cents DESC, r.name`, P.slice(0, 3)),
      many(`SELECT extract(dow FROM b.starts_at AT TIME ZONE $4)::int AS weekday, count(*)::int AS bookings, coalesce(sum(b.price_cents),0)::int AS net_cents ${base} AND ${ACTIVE} GROUP BY 1 ORDER BY 1`, P),
      many(`SELECT extract(hour FROM b.starts_at AT TIME ZONE $4)::int AS hour, count(*)::int AS bookings, coalesce(sum(b.price_cents),0)::int AS net_cents ${base} AND ${ACTIVE} GROUP BY 1 ORDER BY 1`, P),
      many(`SELECT d.id AS discount_id, d.name, d.code, count(*)::int AS uses, coalesce(sum(x.amount_cents),0)::int AS given_cents
              FROM discount_redemptions x JOIN discounts d ON d.id=x.discount_id JOIN reservations rs ON rs.id=x.reservation_id
             WHERE d.venue_id=$1 AND EXISTS (SELECT 1 FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE b.reservation_id=rs.id AND r.venue_id=$1 AND ${ACTIVE} AND b.starts_at >= $2 AND b.starts_at < $3)
             GROUP BY d.id ORDER BY given_cents DESC`, P.slice(0, 3)),
      many(`SELECT u.id, u.handle, u.display_name, count(*)::int AS bookings, sum(b.price_cents)::int AS spent_cents,
                   (SELECT count(*) FROM bookings p JOIN resources pr ON pr.id=p.resource_id WHERE pr.venue_id=$1 AND p.user_id=u.id AND p.status IN ('confirmed','no_show') AND p.starts_at < $2)::int AS earlier_bookings
              FROM bookings b JOIN resources r ON r.id=b.resource_id JOIN users u ON u.id=b.user_id
             WHERE r.venue_id=$1 AND b.starts_at >= $2 AND b.starts_at < $3 AND ${ACTIVE} GROUP BY u.id ORDER BY spent_cents DESC`, P.slice(0, 3)),
      many(`SELECT b.source, count(*)::int AS bookings, coalesce(sum(b.price_cents),0)::int AS net_cents ${base} AND ${ACTIVE} GROUP BY 1 ORDER BY 2 DESC`, P.slice(0, 3)),
      many('SELECT weekday, opens_min, closes_min FROM venue_hours WHERE venue_id=$1 AND removed_at IS NULL', [i.id]),
      many('SELECT resource_id, starts_at, ends_at FROM venue_blocks WHERE released_at IS NULL AND venue_id=$1 AND starts_at < $3 AND ends_at > $2', P.slice(0, 3)),
      one(`SELECT coalesce(sum(b.price_cents) FILTER (WHERE b.payment_status='paid'),0)::int AS paid_cents,
                  coalesce(sum(b.price_cents) FILTER (WHERE b.payment_status='unpaid' AND ${ACTIVE}),0)::int + coalesce(sum(b.price_cents - b.refund_cents) FILTER (WHERE b.payment_status='unpaid' AND b.status='cancelled'),0)::int AS outstanding_cents,
                  coalesce(sum(b.refund_cents) FILTER (WHERE b.payment_status='refund_due'),0)::int AS refunds_owed_cents ${base} AND (${ACTIVE} OR b.status='cancelled')`, P.slice(0, 3)),
    ]);
    const resources = byRes.map((r) => {
      const avail = (availableMinutes(hoursRows, venue, r.resource_id, dates, blocks) / 60) * r.capacity;
      return { ...r, available_unit_hours: Math.round(avail * 100) / 100, unit_hours: Math.round(r.unit_hours * 100) / 100, utilisation: avail > 0 ? Math.round((r.unit_hours / avail) * 1000) / 1000 : null };
    });
    const availTotal = resources.reduce((s, r) => s + r.available_unit_hours, 0);
    const round = (x) => Math.round(x * 100) / 100;
    return {
      venue_id: i.id, currency: venue.currency, timezone: venue.timezone, from: i.from, to: i.to,
      summary: {
        ...tot, unit_hours: round(tot.unit_hours), revenue_cents: tot.net_cents + tot.cancellation_fee_cents, ...payments,
        utilisation: availTotal > 0 ? Math.round((tot.unit_hours / availTotal) * 1000) / 1000 : null,
        cancellation_rate: tot.bookings + tot.cancellations ? Math.round((tot.cancellations / (tot.bookings + tot.cancellations)) * 1000) / 1000 : 0,
        average_booking_cents: tot.bookings ? Math.round(tot.net_cents / tot.bookings) : 0,
      },
      series: series.map((s) => ({ ...s, unit_hours: round(s.unit_hours) })),
      by_resource: resources,
      by_weekday: byDow,
      by_hour: byHour,
      peak_hours: [...byHour].sort((a, b) => b.bookings - a.bookings).slice(0, 5),
      discounts: disc,
      customers: { unique: cust.length, repeat: cust.filter((c) => c.bookings > 1 || c.earlier_bookings > 0).length, new: cust.filter((c) => c.earlier_bookings === 0).length, top: cust.slice(0, 5).map(({ id: cid, handle, display_name, bookings, spent_cents }) => ({ id: cid, handle, display_name, bookings, spent_cents })) },
      channels,
    };
  },
});
