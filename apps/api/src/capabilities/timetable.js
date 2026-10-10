// The owner's weekly timetable: price categories (Peak / Off-peak / Weekend …), bulk "open these courts on these days at these times under this category",
// bulk court creation, copying a court's timetable, and a setup checklist. Windows are the source of truth for when a court is open and what it costs;
// explicit price rules (special rates, seasons) still win over a category when one matches.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { cap, id, money } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { mustFind, sportBySlugOrId } from '../helpers.js';
import { mustManage } from '../booking/engine.js';
import { hhmm } from '../booking/time.js';
import { KINDS } from './venues.js';
import { needsPriceApproval, fileRequest } from '../pricing.js';
import { view, syncHours, enableTimetable, carve, insertWindow, dateKey, inheritTimetable } from '../booking/timetable.js';

const TAG = 'Timetable & categories';
const clock = z.string().regex(/^\d{1,2}:\d{2}$/, 'use HH:MM').refine((s) => !Number.isNaN(hhmm(s)), 'not a valid time');
const day = z.string().date();
const weekdays = z.array(z.number().int().min(0).max(6)).min(1).max(7).describe('0 = Sunday … 6 = Saturday');
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'use #rrggbb');
// ------------------------------------------------------------------ categories
cap({
  name: 'create_price_category', method: 'POST', path: '/venues/:id/categories', tag: TAG, status: 201,
  summary: 'Create a price category such as "Peak", "Off-peak", "Weekend" or "Coaching hours" with a default hourly rate (venue currency, minor units). Put it on the timetable with apply_timetable; override the rate for specific courts with set_category_rate. Changing a category rate re-prices every slot that uses it.',
  input: z.object({ id, name: z.string().min(1).max(40), color: color.optional(), hourly_rate_cents: money }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    if (await one('SELECT 1 AS x FROM price_categories WHERE venue_id=$1 AND active AND lower(name)=lower($2)', [i.id, i.name])) throw conflict('You already have a category with that name');
    if (await needsPriceApproval(pool, user, i.id)) return fileRequest(pool, user, i.id, 'category_create', null, { name: i.name, color: i.color, hourly_rate_cents: i.hourly_rate_cents }, null);
    return one('INSERT INTO price_categories(venue_id, name, color, hourly_rate_cents) VALUES ($1,$2,$3,$4) RETURNING *', [i.id, i.name, i.color ?? '#7c5cff', i.hourly_rate_cents]);
  },
});

cap({
  name: 'update_price_category', method: 'PATCH', path: '/categories/:id', tag: TAG,
  summary: 'Rename, recolour or re-rate a price category (new prices apply to future bookings only; existing bookings keep what they were charged), or retire it with active=false (its windows stay on the timetable at the court base rate until you change them).',
  input: z.object({ id, name: z.string().min(1).max(40).optional(), color: color.optional(), hourly_rate_cents: money.optional(), active: z.boolean().optional() }),
  async handler({ user }, i) {
    const cat = await mustFind('price_categories', i.id);
    await mustManage(user, cat.venue_id);
    if (i.hourly_rate_cents !== undefined && await needsPriceApproval(pool, user, cat.venue_id)) {
      const { id: _id, ...change } = i;
      return fileRequest(pool, user, cat.venue_id, 'category_update', cat.id, change, { name: cat.name, hourly_rate_cents: cat.hourly_rate_cents });
    }
    return one('UPDATE price_categories SET name=coalesce($2,name), color=coalesce($3,color), hourly_rate_cents=coalesce($4,hourly_rate_cents), active=coalesce($5,active) WHERE id=$1 RETURNING *',
      [i.id, i.name ?? null, i.color ?? null, i.hourly_rate_cents ?? null, i.active ?? null]);
  },
});

cap({
  name: 'set_category_rate', method: 'POST', path: '/categories/:id/rates', tag: TAG,
  summary: 'Give one court its own hourly rate inside a category (e.g. Peak is 1500 on badminton courts but 3000 on the cricket net). hourly_rate_cents null removes the override so the category default applies.',
  input: z.object({ id, resource_id: id, hourly_rate_cents: z.union([z.null(), money]) }),
  async handler({ user }, i) {
    const cat = await mustFind('price_categories', i.id);
    await mustManage(user, cat.venue_id);
    const r = await mustFind('resources', i.resource_id);
    if (r.venue_id !== cat.venue_id) throw badRequest('That court belongs to another venue');
    if (await needsPriceApproval(pool, user, cat.venue_id)) return fileRequest(pool, user, cat.venue_id, 'category_rate', cat.id, { resource_id: i.resource_id, hourly_rate_cents: i.hourly_rate_cents }, null);
    await one('INSERT INTO category_rates(category_id, resource_id, hourly_rate_cents) VALUES ($1,$2,$3) ON CONFLICT (category_id, resource_id) DO UPDATE SET hourly_rate_cents=EXCLUDED.hourly_rate_cents RETURNING 1 AS x', [i.id, i.resource_id, i.hourly_rate_cents]);
    return { ok: true };
  },
});

// ------------------------------------------------------------------ timetable
cap({
  name: 'get_timetable', method: 'GET', path: '/venues/:id/timetable', tag: TAG, auth: 'public',
  summary: 'The weekly timetable: price categories (with per-court rate overrides), each court with its windows (days, times, category, optional season dates), and which courts have no timetable yet.',
  input: z.object({ id }),
  async handler(_, i) {
    const v = await mustFind('venues', i.id, 'id, timetable_enabled, currency, timezone');
    const [cats, rates, courts, wins] = await Promise.all([
      many('SELECT id, name, color, hourly_rate_cents, active FROM price_categories WHERE venue_id=$1 ORDER BY active DESC, hourly_rate_cents, name', [i.id]),
      many('SELECT cr.category_id, cr.resource_id, cr.hourly_rate_cents FROM category_rates cr JOIN price_categories pc ON pc.id=cr.category_id WHERE pc.venue_id=$1 AND cr.hourly_rate_cents IS NOT NULL', [i.id]),
      many('SELECT r.id, r.name, r.kind, r.slot_minutes, r.hourly_rate_cents, r.capacity, s.slug AS sport_slug, s.name AS sport, s.emoji AS sport_emoji FROM resources r LEFT JOIN sports s ON s.id=r.sport_id WHERE r.venue_id=$1 AND r.active ORDER BY r.kind, r.name', [i.id]),
      many('SELECT * FROM schedule_windows WHERE venue_id=$1 AND removed_at IS NULL ORDER BY start_min', [i.id]),
    ]);
    return {
      enabled: v.timetable_enabled, currency: v.currency,
      categories: cats.map((c) => ({ ...c, rates: Object.fromEntries(rates.filter((r) => r.category_id === c.id).map((r) => [r.resource_id, r.hourly_rate_cents])) })),
      courts: courts.map((r) => ({ ...r, windows: wins.filter((w) => w.resource_id === r.id).map(view) })),
      courts_without_timetable: v.timetable_enabled ? courts.filter((r) => !wins.some((w) => w.resource_id === r.id)).map((r) => r.id) : [],
    };
  },
});

cap({
  name: 'apply_timetable', method: 'POST', path: '/venues/:id/timetable', tag: TAG,
  summary: 'Bulk-open (or close) slots: pick courts (resource_ids, or all_courts), weekdays and a time range, and a price category (omit for the court base rate). Existing slots in that range are replaced (replace=true, default) or the call is refused if they overlap (replace=false). closed=true clears the range instead (courts closed then). Optional valid_from/valid_to make it a season that takes priority over everyday windows. The first call turns the timetable on: a venue that had opening hours keeps them as windows on every court (so nothing closes by surprise); a venue that had none starts from an empty timetable, so courts are open only where you open them.',
  input: z.object({
    id, resource_ids: z.array(id).min(1).max(100).optional(), all_courts: z.boolean().optional(), weekdays, start: clock, end: clock,
    category_id: id.optional(), closed: z.boolean().default(false), replace: z.boolean().default(true), valid_from: day.optional(), valid_to: day.optional(),
  }).refine((i) => i.resource_ids?.length || i.all_courts, 'choose courts (resource_ids) or all_courts')
    .refine((i) => hhmm(i.end) > hhmm(i.start), 'end must be after start')
    .refine((i) => !i.valid_from || !i.valid_to || i.valid_to >= i.valid_from, 'valid_to is before valid_from')
    ,
  async handler({ user }, i) {
    await mustManage(user, i.id);
    return tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`timetable:${i.id}`]);
      if (i.category_id) { const cat = await mustFind('price_categories', i.category_id, '*', c); if (cat.venue_id !== i.id || !cat.active) throw badRequest('That category is not available for this venue'); }
      const courts = (await c.query('SELECT id FROM resources WHERE venue_id=$1 AND active', [i.id])).rows.map((r) => r.id);
      const targets = i.all_courts ? courts : i.resource_ids;
      for (const t of targets) if (!courts.includes(t)) throw badRequest('One of those courts is not part of this venue');
      await enableTimetable(c, i.id);
      const batch = randomUUID();
      let replaced = 0;
      for (const t of targets) replaced += await carve(c, i.id, t, { days: i.weekdays, start: hhmm(i.start), end: hhmm(i.end), categoryId: i.category_id ?? null, closed: i.closed, valid_from: i.valid_from ?? null, valid_to: i.valid_to ?? null, replace: i.replace, batch });
      await syncHours(c, i.id);
      return { courts: targets.length, windows_replaced: replaced, closed: i.closed };
    });
  },
});

cap({
  name: 'set_weekly_timetable', method: 'POST', path: '/venues/:id/timetable/weekly', tag: TAG,
  summary: "Save the whole everyday weekly timetable of the chosen courts in one go (what the painted grid sends): rows of weekdays + time range + category (omit for the court base rate). It replaces those courts' everyday windows; seasons (dated windows) are left alone. Rows must not overlap on a day.",
  input: z.object({
    id, resource_ids: z.array(id).min(1).max(100).optional(), all_courts: z.boolean().optional(),
    rows: z.array(z.object({ weekdays, start: clock, end: clock, category_id: id.optional() })).max(300),
  }).refine((i) => i.resource_ids?.length || i.all_courts, 'choose courts (resource_ids) or all_courts'),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    const rows = i.rows.map((r) => ({ days: r.weekdays, start: hhmm(r.start), end: hhmm(r.end), category_id: r.category_id ?? null }));
    for (const r of rows) if (r.end <= r.start) throw badRequest('Each range must end after it starts');
    for (const a of rows) for (const b of rows) if (a !== b && a.days.some((d) => b.days.includes(d)) && a.start < b.end && b.start < a.end) throw badRequest('Two ranges overlap on the same day');
    return tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`timetable:${i.id}`]);
      const cats = new Set((await c.query('SELECT id FROM price_categories WHERE venue_id=$1 AND active', [i.id])).rows.map((x) => x.id));
      for (const r of rows) if (r.category_id && !cats.has(r.category_id)) throw badRequest('That category is not available for this venue');
      const courts = (await c.query('SELECT id FROM resources WHERE venue_id=$1 AND active', [i.id])).rows.map((r) => r.id);
      const targets = i.all_courts ? courts : i.resource_ids;
      for (const t of targets) if (!courts.includes(t)) throw badRequest('One of those courts is not part of this venue');
      await enableTimetable(c, i.id);
      const batch = randomUUID();
      for (const t of targets) {
        await c.query('UPDATE schedule_windows SET removed_at=now() WHERE resource_id=$1 AND removed_at IS NULL AND valid_from IS NULL AND valid_to IS NULL', [t]);
        for (const r of rows) await insertWindow(c, i.id, { resource_id: t, category_id: r.category_id, weekdays: r.days, start_min: r.start, end_min: r.end, batch_id: batch });
      }
      await syncHours(c, i.id);
      return { courts: targets.length, windows: rows.length };
    });
  },
});

cap({
  name: 'copy_timetable', method: 'POST', path: '/venues/:id/timetable/copy', tag: TAG,
  summary: "Give other courts the same timetable as one court (replaces theirs). Handy after adding courts.",
  input: z.object({ id, from_resource_id: id, to_resource_ids: z.array(id).min(1).max(100) }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    return tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`timetable:${i.id}`]);
      const ids = (await c.query('SELECT id FROM resources WHERE venue_id=$1 AND active', [i.id])).rows.map((r) => r.id);
      for (const t of [i.from_resource_id, ...i.to_resource_ids]) if (!ids.includes(t)) throw badRequest('Those courts must all belong to this venue');
      const src = (await c.query('SELECT * FROM schedule_windows WHERE resource_id=$1 AND removed_at IS NULL', [i.from_resource_id])).rows;
      if (!src.length) throw conflict('That court has no timetable to copy');
      for (const t of i.to_resource_ids.filter((x) => x !== i.from_resource_id)) {
        await c.query('UPDATE schedule_windows SET removed_at=now() WHERE resource_id=$1 AND removed_at IS NULL', [t]);
        for (const w of src) await insertWindow(c, i.id, { ...w, resource_id: t, valid_from: dateKey(w.valid_from), valid_to: dateKey(w.valid_to) });
      }
      await syncHours(c, i.id);
      return { copied_to: i.to_resource_ids.length, windows: src.length };
    });
  },
});

// ------------------------------------------------------------------ courts in bulk
const slotMinutes = z.union([z.literal(15), z.literal(20), z.literal(30), z.literal(45), z.literal(60), z.literal(90), z.literal(120)]);
cap({
  name: 'bulk_add_resources', method: 'POST', path: '/venues/:id/resources/bulk', tag: TAG, status: 201,
  summary: 'Add several identical courts/tables/lanes in one go: a name prefix and a count make "Court 1 … Court 6". With a timetable on, new courts copy the timetable of a sibling (same kind first) so they are bookable immediately.',
  input: z.object({
    id, kind: z.enum(KINDS), name_prefix: z.string().min(1).max(60), count: z.number().int().min(1).max(50), start_number: z.number().int().min(1).max(999).optional(), sport: z.string().optional(),
    capacity: z.number().int().min(1).max(1000).default(1), hourly_rate_cents: money.default(0), max_players: z.number().int().min(1).max(1000).optional(), surface: z.string().max(60).optional(), indoor: z.boolean().optional(),
    slot_minutes: slotMinutes.default(60), min_slots: z.number().int().min(1).max(48).default(1), max_slots: z.number().int().min(1).max(48).default(8),
  }).refine((i) => i.max_slots >= i.min_slots, 'max_slots must be at least min_slots'),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    if (i.sport && !sport) throw notFound('Sport');
    return tx(async (c) => {
      const routed = i.hourly_rate_cents > 0 && await needsPriceApproval(c, user, i.id); // live venue: courts stay hidden until the platform approves their rate
      const start = i.start_number ?? 1;
      const made = [];
      for (let n = 0; n < i.count; n++) {
        const name = `${i.name_prefix} ${start + n}`;
        if ((await c.query('SELECT 1 FROM resources WHERE venue_id=$1 AND active AND lower(name)=lower($2)', [i.id, name])).rowCount) throw conflict(`"${name}" already exists — change the prefix or the starting number`);
        const r = (await c.query(
          `INSERT INTO resources(venue_id, kind, name, sport_id, capacity, hourly_rate_cents, max_players, surface, indoor, slot_minutes, min_slots, max_slots, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id, name, kind`,
          [i.id, i.kind, name, sport?.id ?? null, i.capacity, routed ? 0 : i.hourly_rate_cents, i.max_players ?? null, i.surface ?? null, i.indoor ?? null, i.slot_minutes, i.min_slots, i.max_slots, !routed])).rows[0];
        await inheritTimetable(c, i.id, r.id);
        if (routed) await fileRequest(c, user, i.id, 'base_rate', r.id, { hourly_rate_cents: i.hourly_rate_cents, activate: true }, null);
        made.push(r);
      }
      await syncHours(c, i.id).catch(() => {});
      return { created: made, pending_platform_approval: routed };
    });
  },
});

cap({
  name: 'bulk_update_resources', method: 'PATCH', path: '/venues/:id/resources', tag: TAG,
  summary: 'Change settings on many courts at once: slot length, min/max slots per booking, capacity, base rate, or retire them (active=false). Only the fields you send change.',
  input: z.object({
    id, resource_ids: z.array(id).min(1).max(100), slot_minutes: slotMinutes.optional(), min_slots: z.number().int().min(1).max(48).optional(), max_slots: z.number().int().min(1).max(48).optional(),
    capacity: z.number().int().min(1).max(1000).optional(), hourly_rate_cents: money.optional(), active: z.boolean().optional(), sport: z.string().optional().describe('sport slug or id: associates every chosen court with that sport'),
  }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    if (i.sport && !sport) throw notFound('Sport');
    let rate = i.hourly_rate_cents ?? null, routed = 0;
    if (rate !== null && await needsPriceApproval(pool, user, i.id)) { // the rate goes to the platform; the other settings apply now
      for (const rid of new Set(i.resource_ids)) { await fileRequest(pool, user, i.id, 'base_rate', rid, { hourly_rate_cents: rate }, null); routed++; }
      rate = null;
    }
    const { rows } = await pool.query(
      `UPDATE resources SET slot_minutes=coalesce($3,slot_minutes), min_slots=coalesce($4,min_slots), max_slots=coalesce($5,max_slots), capacity=coalesce($6,capacity), hourly_rate_cents=coalesce($7,hourly_rate_cents), active=coalesce($8,active), sport_id=coalesce($9,sport_id)
        WHERE venue_id=$1 AND id = ANY($2::uuid[]) AND coalesce($5,max_slots) >= coalesce($4,min_slots) RETURNING id`,
      [i.id, i.resource_ids, i.slot_minutes ?? null, i.min_slots ?? null, i.max_slots ?? null, i.capacity ?? null, rate, i.active ?? null, sport?.id ?? null]);
    if (rows.length !== new Set(i.resource_ids).size) throw badRequest('Some courts were not updated — check they belong to this venue and that max slots is at least min slots');
    return { updated: rows.length, rate_changes_sent_to_platform: routed };
  },
});

// ------------------------------------------------------------------ setup checklist
cap({
  name: 'venue_setup_status', method: 'GET', path: '/venues/:id/setup', tag: TAG,
  summary: "The owner's launch checklist for a venue: profile, courts, timetable, price categories, payments, contacts, photos, plans. Each step says whether it is done and what is missing, so an owner knows what to do next.",
  input: z.object({ id }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    const v = await mustFind('venues', i.id);
    const [n, uncovered] = await Promise.all([
      one(`SELECT (SELECT count(*) FROM resources WHERE venue_id=$1 AND active)::int AS courts, (SELECT count(*) FROM price_categories WHERE venue_id=$1 AND active)::int AS categories,
                  (SELECT count(*) FROM venue_contacts WHERE venue_id=$1 AND removed_at IS NULL)::int AS contacts, (SELECT count(*) FROM venue_media WHERE venue_id=$1 AND removed_at IS NULL)::int AS photos,
                  (SELECT count(*) FROM venue_plans WHERE venue_id=$1 AND active)::int AS plans, (SELECT count(*) FROM resources WHERE venue_id=$1 AND active AND hourly_rate_cents > 0)::int AS priced_courts, (SELECT count(*) FROM resources WHERE venue_id=$1 AND active AND sport_id IS NULL)::int AS no_sport`, [i.id]),
      many('SELECT r.id, r.name FROM resources r WHERE r.venue_id=$1 AND r.active AND NOT EXISTS (SELECT 1 FROM schedule_windows w WHERE w.resource_id=r.id AND w.removed_at IS NULL)', [i.id]),
    ]);
    const hasPricing = n.categories > 0 || n.priced_courts > 0;
    const steps = [
      { key: 'courts', title: 'Add your courts and their sport', done: n.courts > 0 && n.no_sport === 0, detail: !n.courts ? 'Add the courts, tables or lanes people can book — add many at once.' : n.no_sport ? `${n.no_sport} court(s) have no sport yet — so people can find them by sport` : `${n.courts} court(s)` },
      { key: 'timetable', title: 'Set the weekly timetable', done: v.timetable_enabled && n.courts > 0 && uncovered.length === 0, detail: !v.timetable_enabled ? 'Choose when each court is open, in bulk.' : uncovered.length ? `${uncovered.map((u) => u.name).join(', ')} have no slots yet` : 'Every court has slots' },
      { key: 'pricing', title: 'Price your slots', done: hasPricing, detail: hasPricing ? `${n.categories} categories` : 'Create categories like Peak and Off-peak, or give each court a rate.' },
      { key: 'payments', title: 'Money, tax & invoices', done: !!v.legal_name, detail: v.legal_name ? `${v.currency} · invoices as ${v.legal_name}` : 'Add the legal name and tax number that go on invoices.' },
      { key: 'contacts', title: 'Add a contact', done: n.contacts > 0, detail: n.contacts ? `${n.contacts} contact(s)` : 'So customers can reach you.' },
      { key: 'photos', title: 'Add photos', done: n.photos > 0, detail: n.photos ? `${n.photos} photo(s)` : 'Venues with photos get more bookings.' },
      { key: 'plans', title: 'Offer memberships or passes', done: n.plans > 0, optional: true, detail: n.plans ? `${n.plans} plan(s)` : 'Optional — recurring revenue and loyal regulars.' },
    ];
    const required = steps.filter((s) => !s.optional);
    return { ready: required.every((s) => s.done), done: required.filter((s) => s.done).length, total: required.length, steps, courts_without_timetable: uncovered };
  },
});
