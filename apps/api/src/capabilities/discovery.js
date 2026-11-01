// Map + list discovery of venues, open games and coach classes near you (#696), and saved searches with alerts.
// Extends venues.js, open-games.js and coach-classes.js (it calls them, never re-implements them); alerts reuse the notify route and the worker.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { discover, hhmm } from '../discovery.js';
import { bboxField } from '../geo.js';
import { sportBySlugOrId } from '../helpers.js';

const TAG = 'Discovery';
const dt = z.string().datetime({ offset: true });
const csv = (item) => z.preprocess((v) => (typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : v), z.array(item).max(40));
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time is HH:MM');
export const KINDS = ['venue', 'game', 'class'];

export const filtersShape = {
  kinds: csv(z.enum(KINDS)).optional().describe('venue, game, class (comma separated); all three when omitted'),
  sport: csv(z.string().min(1).max(60)).optional().describe('one or more sport slugs; every sport in the catalogue works'),
  from: dt.optional(), to: dt.optional(), time_from: time.optional(), time_to: time.optional(), tz: z.string().max(60).default('UTC'),
  max_price_cents: z.coerce.number().int().min(0).optional(), level: z.enum(['beginner', 'amateur', 'semi_pro', 'pro']).optional(),
  has_seats: z.coerce.boolean().optional(), seats_left: z.coerce.number().int().min(1).max(100).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(), lng: z.coerce.number().min(-180).max(180).optional(), radius_km: z.coerce.number().min(0.5).max(20000).optional(), bbox: bboxField,
  city: z.string().max(80).optional(), q: z.string().max(80).optional(),
  sort: z.enum(['soonest', 'distance', 'price']).default('soonest'),
};

cap({
  name: 'discover_nearby', method: 'GET', path: '/discover', tag: TAG, auth: 'public',
  summary: 'One discovery search for the map and the list: venues, open games and coach classes near a point (never stored) or inside a map viewport (bbox), filtered by sport (any in the catalogue), dates, time of day, price, level and seats left. Returns items and the pins for exactly those items, with live availability. Young people\'s listings are shown only to young people and their guardians; coordinates are venue/public-place pins rounded to ~100 m, never a home.',
  input: z.object({ ...filtersShape, limit: z.coerce.number().int().min(1).max(300).default(100), offset: z.coerce.number().int().min(0).default(0) })
    .refine((i) => (i.lat == null) === (i.lng == null), 'lat and lng go together'),
  async handler({ user }, i) {
    if (i.sort === 'distance' && i.lat == null) throw badRequest('sort=distance needs lat and lng');
    if ((i.time_from && i.time_to) && hhmm(i.time_from) > hhmm(i.time_to)) throw badRequest('time_from must be before time_to');
    return discover(user, i);
  },
});

// ---------------------------------------------------------------- saved searches + alerts

const SAVED = 20;
const view = (r) => ({ id: r.id, name: r.name, filters: r.filters, alerts_on: r.alerts_on, last_checked_at: r.last_checked_at, last_notified_at: r.last_notified_at, created_at: r.created_at });

cap({
  name: 'save_search', method: 'POST', path: '/me/saved-searches', tag: TAG, status: 201,
  summary: 'Save the current discovery filters under a name and (optionally) get told when something new matches. The centre point is rounded to ~1 km before it is stored; up to 20 saved searches. Alerts never include young people\'s listings unless you are a young person or a guardian.',
  input: z.object({ name: z.string().trim().min(1).max(80), alerts_on: z.boolean().default(true), ...filtersShape }).refine((i) => (i.lat == null) === (i.lng == null), 'lat and lng go together'),
  async handler({ user }, i) {
    const { name, alerts_on, ...f } = i;
    for (const s of f.sport ?? []) if (!(await sportBySlugOrId(s))) throw notFound('Sport');
    if ((await one('SELECT count(*)::int AS n FROM saved_searches WHERE user_id=$1 AND archived_at IS NULL', [user.id])).n >= SAVED) throw badRequest(`You can keep ${SAVED} saved searches; remove one first`);
    const round1 = (v) => (v == null ? undefined : Math.round(v * 100) / 100); // ~1 km: a saved search is an area, never a precise location
    const stored = Object.fromEntries(Object.entries({ ...f, lat: round1(f.lat), lng: round1(f.lng) }).filter(([, v]) => v !== undefined));
    return view(await one('INSERT INTO saved_searches(user_id, name, filters, alerts_on) VALUES ($1,$2,$3,$4) RETURNING *', [user.id, name, stored, alerts_on]));
  },
});

cap({
  name: 'list_saved_searches', method: 'GET', path: '/me/saved-searches', tag: TAG,
  summary: 'Your saved discovery searches.', input: z.object({ ...page }),
  async handler({ user }, i) {
    return (await many('SELECT * FROM saved_searches WHERE user_id=$1 AND archived_at IS NULL ORDER BY created_at DESC LIMIT $2 OFFSET $3', [user.id, i.limit, i.offset])).map(view);
  },
});

cap({
  name: 'update_saved_search', method: 'PATCH', path: '/me/saved-searches/:id', tag: TAG,
  summary: 'Rename a saved search or switch its alerts on or off.', input: z.object({ id, name: z.string().trim().min(1).max(80).optional(), alerts_on: z.boolean().optional() }),
  async handler({ user }, i) {
    const r = await one('UPDATE saved_searches SET name=coalesce($3,name), alerts_on=coalesce($4,alerts_on) WHERE id=$1 AND user_id=$2 AND archived_at IS NULL RETURNING *', [i.id, user.id, i.name ?? null, i.alerts_on ?? null]);
    if (!r) throw notFound('Saved search');
    return view(r);
  },
});

cap({
  name: 'delete_saved_search', method: 'DELETE', path: '/me/saved-searches/:id', tag: TAG,
  summary: 'Remove a saved search (it is archived, not erased).', input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one('UPDATE saved_searches SET archived_at=now(), alerts_on=false WHERE id=$1 AND user_id=$2 AND archived_at IS NULL RETURNING id', [i.id, user.id]);
    if (!r) throw notFound('Saved search');
    return { ok: true };
  },
});
