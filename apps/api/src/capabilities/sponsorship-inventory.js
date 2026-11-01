// Sponsor inventory (#519): the things a recipient can give a sponsor (title/associate partner, kit, public-page slots, overlays, social, hospitality, challenges,
// appearances), with conflict-aware bookings tied to a real, active agreement. A booking is refused when the unit is full or when an exclusive unit already has
// another sponsor of the same category in an overlapping period; the unit row is locked so two parallel bookings can never both win.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { tx, many, one } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin } from '../helpers.js';
import { dealContext, logHistory } from '../sponsor-agreements.js';
import { INVENTORY_KINDS, SLOT_OF, CATEGORIES, RUNNING, manageTarget, today } from '../sponsor-roi.js';
import { PLATFORMS } from '../media-rights.js';

const TAG = 'Sponsors';
const date = z.string().date();
const UNIT = 'id, target_type, target_id, kind, name, description, capacity, exclusive_category, placement_slot, available_from::text AS available_from, available_to::text AS available_to, territory_mode, countries, platforms, exclusivity_scope, asking_price_minor, asking_currency, status, row_version, created_at';
const country = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'use ISO 3166 two-letter country codes');
const rights = { territory_mode: z.enum(['worldwide', 'include', 'exclude']).default('worldwide'), countries: z.array(country).max(250).default([]), platforms: z.array(z.enum(PLATFORMS)).max(PLATFORMS.length).default([]),
  exclusivity_scope: z.string().trim().min(2).max(80).optional(), asking_price_minor: z.coerce.number().int().min(0).optional(), asking_currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional() };
const rightsOk = (x) => (x.territory_mode === 'worldwide' || (x.countries ?? []).length > 0) && ((x.asking_price_minor == null) === (x.asking_currency == null));
const RIGHTS_MSG = 'Choose at least one country for an include/exclude territory, and give an asking price together with its currency';
const overlap = '(b.starts_on <= $3::date AND b.ends_on >= $2::date)';

/** Peak number of simultaneous bookings of a unit within [from, to]: the capacity a new booking in that window competes for. */
const peak = async (c, unitId, from, to, ignore = null) => Number((await c.query(
  `SELECT coalesce(max(n),0) AS n FROM (SELECT d::date, count(b.id) AS n FROM generate_series($2::date, $3::date, '1 day') d
     LEFT JOIN sponsor_inventory_bookings b ON b.unit_id=$1 AND b.status='confirmed' AND b.starts_on <= d::date AND b.ends_on >= d::date AND ($4::uuid IS NULL OR b.id <> $4) GROUP BY d) x`, [unitId, from, to, ignore])).rows[0].n);

cap({
  name: 'create_sponsor_inventory_unit', method: 'POST', path: '/sponsor-inventory', tag: TAG, status: 201,
  summary: 'Offer a governed unit of sponsor inventory on an event, team or (adult) athlete you manage: title or associate partner, team/athlete association, kit placement, public event page, leaderboard, scorecard, livestream overlay, replay, social content, hospitality, sponsored challenge, agreed appearance or content. Set the capacity (how many sponsors at once) and whether the unit is category-exclusive. On an event, title partner, scorecard, leaderboard and event-page units sell the matching public-page slot; once an event defines a unit for a slot, only a sponsor with a booking can hold that placement.',
  input: z.object({ target_type: z.enum(['event', 'team', 'athlete']), target_id: id, kind: z.enum(Object.keys(INVENTORY_KINDS)), name: z.string().trim().min(2).max(120), description: z.string().trim().max(1000).optional(),
    capacity: z.coerce.number().int().min(1).max(100).default(1), exclusive_category: z.boolean().default(false), available_from: date.optional(), available_to: date.optional(), ...rights })
    .refine((x) => !x.available_from || !x.available_to || x.available_to >= x.available_from, 'available_to is before available_from').refine(rightsOk, RIGHTS_MSG),
  async handler({ user }, i) {
    return tx(async (c) => {
      await manageTarget(c, user, i.target_type, i.target_id);
      if (['team_association', 'kit_placement'].includes(i.kind) && i.target_type === 'event') throw badRequest('Team association and kit placement belong to a team');
      if (i.kind === 'athlete_association' && i.target_type !== 'athlete') throw badRequest('Athlete association belongs to an athlete');
      const slot = i.target_type === 'event' ? SLOT_OF[i.kind] ?? null : null;
      return (await c.query(
        `INSERT INTO sponsor_inventory_units(target_type, target_id, kind, name, description, capacity, exclusive_category, placement_slot, available_from, available_to, created_by, territory_mode, countries, platforms, exclusivity_scope, asking_price_minor, asking_currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING ${UNIT}`,
        [i.target_type, i.target_id, i.kind, i.name, i.description ?? null, i.capacity, i.exclusive_category, slot, i.available_from ?? null, i.available_to ?? null, user.id, i.territory_mode, [...new Set(i.countries)], [...new Set(i.platforms)], i.exclusivity_scope ?? null, i.asking_price_minor ?? null, i.asking_currency ?? null])).rows[0];
    });
  },
});

cap({
  name: 'update_sponsor_inventory_unit', method: 'PATCH', path: '/sponsor-inventory/:id', tag: TAG,
  summary: 'Change a unit (name, description, capacity, exclusivity, availability) or archive it. Capacity cannot drop below what is already booked, exclusivity cannot be switched on while two sponsors of one category overlap, and a unit with live bookings cannot be archived until they are released. `row_version` refuses a stale edit. Nothing is deleted.',
  input: z.object({ id, row_version: z.coerce.number().int().min(1), name: z.string().trim().min(2).max(120).optional(), description: z.string().trim().max(1000).nullable().optional(), capacity: z.coerce.number().int().min(1).max(100).optional(),
    exclusive_category: z.boolean().optional(), available_from: date.nullable().optional(), available_to: date.nullable().optional(), status: z.enum(['active', 'archived']).optional(),
    territory_mode: rights.territory_mode.optional(), countries: rights.countries.optional(), platforms: rights.platforms.optional(), exclusivity_scope: rights.exclusivity_scope.nullable().optional(), asking_price_minor: rights.asking_price_minor.nullable().optional(), asking_currency: rights.asking_currency.nullable().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const u = (await c.query('SELECT *, available_from::text AS af, available_to::text AS at FROM sponsor_inventory_units WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!u) throw notFound('Inventory unit');
      await manageTarget(c, user, u.target_type, u.target_id);
      if (u.row_version !== i.row_version) throw conflict('This changed while you were looking; reload it and try again', { code: 'stale_version' });
      const next = { ...u, available_from: u.af, available_to: u.at, ...Object.fromEntries(Object.entries(i).filter(([k, v]) => v !== undefined && !['id', 'row_version'].includes(k))) };
      if (next.available_from && next.available_to && next.available_to < next.available_from) throw badRequest('available_to is before available_from');
      if (!rightsOk(next)) throw badRequest(RIGHTS_MSG);
      const live = (await c.query("SELECT count(*)::int AS n, to_char(min(starts_on),'YYYY-MM-DD') AS f, to_char(max(ends_on),'YYYY-MM-DD') AS t FROM sponsor_inventory_bookings WHERE unit_id=$1 AND status='confirmed' AND ends_on >= current_date", [u.id])).rows[0];
      if (next.status === 'archived' && live.n) throw conflict(`${live.n} live booking(s) must be released before this unit is archived`);
      if (next.capacity < u.capacity && live.n && (await peak(c, u.id, live.f, live.t)) > next.capacity) throw conflict('Capacity cannot drop below what is already booked');
      if (next.exclusive_category && !u.exclusive_category) {
        const clash = (await c.query(`SELECT 1 FROM sponsor_inventory_bookings a JOIN sponsor_inventory_bookings b ON b.unit_id=a.unit_id AND b.id > a.id AND b.status='confirmed' AND b.category=a.category AND b.starts_on <= a.ends_on AND b.ends_on >= a.starts_on
          JOIN sponsorships sa ON sa.id=a.sponsorship_id JOIN sponsorships sb ON sb.id=b.sponsorship_id WHERE a.unit_id=$1 AND a.status='confirmed' AND a.category <> 'other' AND sa.sponsor_id <> sb.sponsor_id LIMIT 1`, [u.id])).rowCount;
        if (clash) throw conflict('Two sponsors of the same category already overlap on this unit; release one first');
      }
      return (await c.query(`UPDATE sponsor_inventory_units SET name=$2, description=$3, capacity=$4, exclusive_category=$5, available_from=$6, available_to=$7, status=$8, archived_at=CASE WHEN $8='archived' THEN now() ELSE NULL END, territory_mode=$9, countries=$10, platforms=$11, exclusivity_scope=$12, asking_price_minor=$13, asking_currency=$14, row_version=row_version+1 WHERE id=$1 RETURNING ${UNIT}`,
        [u.id, next.name, next.description, next.capacity, next.exclusive_category, next.available_from, next.available_to, next.status, next.territory_mode, [...new Set(next.countries)], [...new Set(next.platforms)], next.exclusivity_scope ?? null, next.asking_price_minor ?? null, next.asking_currency ?? null])).rows[0];
    });
  },
});

cap({
  name: 'list_sponsor_inventory', method: 'GET', path: '/sponsor-inventory', tag: TAG,
  summary: 'The inventory of an event, team or athlete. The owner sees every unit with its bookings (sponsor, category, period). A sponsor or anyone else sees the active units with how many places are free and which categories are blocked in a window (`from`/`to`, default today onward) — never who holds them. An athlete\'s units are shown only while they are open to sponsors. Availability is computed from live bookings.',
  input: z.object({ target_type: z.enum(['event', 'team', 'athlete']), target_id: id, from: date.optional(), to: date.optional(), include_archived: z.coerce.boolean().default(false) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      let mine = false;
      try { await manageTarget(c, user, i.target_type, i.target_id); mine = true; } catch { mine = isAdmin(user); }
      if (i.target_type === 'athlete' && !mine && !(await c.query('SELECT 1 FROM sponsorship_profiles WHERE user_id=$1 AND open_to_sponsors', [i.target_id])).rowCount) throw notFound('Inventory');
      const from = i.from ?? today(), to = i.to ?? `${Number(from.slice(0, 4)) + 1}${from.slice(4)}`;
      const units = (await c.query(`SELECT ${UNIT} FROM sponsor_inventory_units WHERE target_type=$1 AND target_id=$2 AND ($3 OR status='active') ORDER BY created_at, id`, [i.target_type, i.target_id, mine && i.include_archived])).rows;
      for (const u of units) {
        const p = await peak(c, u.id, from, to);
        const bk = (await c.query(`SELECT b.id, b.category, b.starts_on::text AS starts_on, b.ends_on::text AS ends_on, b.status, b.sponsorship_id, sp.name AS sponsor_name
          FROM sponsor_inventory_bookings b JOIN sponsorships ss ON ss.id=b.sponsorship_id JOIN sponsors sp ON sp.id=ss.sponsor_id WHERE b.unit_id=$1 AND ${mine ? "b.ends_on >= current_date - 365" : "b.status='confirmed'"} AND ${overlap} ORDER BY b.starts_on, b.id`, [u.id, from, to])).rows;
        u.window = { from, to, booked_peak: p, free: Math.max(0, u.capacity - p), full: p >= u.capacity };
        u.blocked_categories = u.exclusive_category ? [...new Set(bk.filter((b) => b.status === 'confirmed' && b.category !== 'other').map((b) => b.category))] : [];
        u.kind_label = INVENTORY_KINDS[u.kind];
        u.bookings = mine ? bk : undefined;
      }
      return { owner: mine, categories: CATEGORIES, units };
    });
  },
});

cap({
  name: 'book_sponsor_inventory', method: 'POST', path: '/sponsor-inventory/:id/bookings', tag: TAG, status: 201,
  summary: 'Book a unit for an ACTIVE agreement with the same event, team or athlete. Refused (409) when the unit is full for any day of the period, when an exclusive unit already has another sponsor of the same category in an overlapping period, when the sponsor already holds the unit then, or when the period falls outside the unit\'s availability or the agreement\'s term. A booking must stay inside the unit\'s territory and platforms (409 `outside_rights`), and category exclusivity only collides where two bookings share a territory and a platform. Only the unit\'s owner books it. Nothing can be double-sold: the unit is locked while the check and the booking run.',
  input: z.object({ id, sponsorship_id: id, category: z.enum(CATEGORIES), starts_on: date, ends_on: date, note: z.string().trim().max(500).optional(),
    countries: z.array(country).max(250).default([]).describe('the countries the sponsor is granted inside the unit\'s territory; empty = the unit\'s whole territory'), platforms: z.array(z.enum(PLATFORMS)).default([]).describe('the platforms granted; empty = all the unit offers') }).refine((x) => x.ends_on >= x.starts_on, 'ends_on is before starts_on'),
  async handler({ user }, i) {
    return tx(async (c) => {
      const u = (await c.query('SELECT *, available_from::text AS af, available_to::text AS at FROM sponsor_inventory_units WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!u) throw notFound('Inventory unit');
      await manageTarget(c, user, u.target_type, u.target_id);
      if (u.status !== 'active') throw conflict('This unit is archived');
      const ctx = await dealContext(c, i.sponsorship_id, user, { lock: true });
      const d = ctx.d;
      if (ctx.role !== 'recipient' && ctx.role !== 'admin') throw forbidden('The unit\'s owner books it');
      if (d.target_type !== u.target_type || d.target_id !== u.target_id) throw badRequest('That agreement is not with the owner of this unit');
      if (d.status !== 'active' || d.accepted_version == null) throw conflict('Only an accepted, active agreement can hold inventory');
      if ((u.af && i.starts_on < u.af) || (u.at && i.ends_on > u.at)) throw conflict('That period is outside the unit\'s availability');
      if ((d.starts && i.starts_on < d.starts) || (d.ends && i.ends_on > d.ends)) throw conflict('That period is outside the agreement\'s term');
      const same = (await c.query("SELECT 1 FROM sponsor_inventory_bookings b WHERE b.unit_id=$1 AND b.sponsorship_id=$4 AND b.status='confirmed' AND b.starts_on <= $3::date AND b.ends_on >= $2::date", [u.id, i.starts_on, i.ends_on, d.id])).rowCount;
      if (same) throw conflict('This agreement already holds the unit in that period', { code: 'already_booked' });
      const cs = [...new Set(i.countries)], ps = [...new Set(i.platforms)];
      if (cs.length && ((u.territory_mode === 'include' && cs.some((x) => !u.countries.includes(x))) || (u.territory_mode === 'exclude' && cs.some((x) => u.countries.includes(x)))))
        throw conflict('That territory is outside what this unit sells', { code: 'outside_rights', field: 'countries' });
      if (ps.length && u.platforms.length && ps.some((x) => !u.platforms.includes(x))) throw conflict('That platform is not part of what this unit sells', { code: 'outside_rights', field: 'platforms' });
      if (u.exclusive_category && i.category !== 'other') {
        const rival = (await c.query(`SELECT sp.name, b.starts_on::text AS starts_on, b.ends_on::text AS ends_on FROM sponsor_inventory_bookings b JOIN sponsorships ss ON ss.id=b.sponsorship_id JOIN sponsors sp ON sp.id=ss.sponsor_id
          WHERE b.unit_id=$1 AND b.status='confirmed' AND b.category=$4 AND ss.sponsor_id <> $5 AND ${overlap} AND ($6::text[] = '{}' OR b.countries = '{}' OR b.countries && $6::text[]) AND ($7::text[] = '{}' OR b.platforms = '{}' OR b.platforms && $7::text[]) LIMIT 1`, [u.id, i.starts_on, i.ends_on, i.category, d.sponsor_id, cs, ps])).rows[0];
        if (rival) throw conflict(`This unit is exclusive to one ${i.category.replace(/_/g, ' ')} sponsor in a period; it is held ${rival.starts_on} → ${rival.ends_on}`, { code: 'category_exclusive', category: i.category, held_from: rival.starts_on, held_to: rival.ends_on });
      }
      const p = await peak(c, u.id, i.starts_on, i.ends_on);
      if (p >= u.capacity) throw conflict(`This unit is full for part of that period (${p} of ${u.capacity} booked)`, { code: 'inventory_full', capacity: u.capacity, booked_peak: p });
      const row = (await c.query(`INSERT INTO sponsor_inventory_bookings(unit_id, sponsorship_id, category, starts_on, ends_on, note, booked_by, countries, platforms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING id, unit_id, sponsorship_id, category, starts_on::text AS starts_on, ends_on::text AS ends_on, status, note, countries, platforms, created_at`, [u.id, d.id, i.category, i.starts_on, i.ends_on, i.note ?? null, user.id, cs, ps])).rows[0];
      await logHistory(c, d.id, d.terms_version, user.id, 'inventory_booked', u.name);
      return row;
    });
  },
});

cap({
  name: 'release_sponsor_inventory_booking', method: 'POST', path: '/sponsor-inventory-bookings/:id/release', tag: TAG,
  summary: 'The unit\'s owner releases a booking (kept as history). Any public placement backed by it ends at once; deliverables and recorded exposure stay. The reason is required and shown to the sponsor.',
  input: z.object({ id, reason: z.string().trim().min(3).max(500) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const b = (await c.query('SELECT b.*, u.target_type, u.target_id, u.name FROM sponsor_inventory_bookings b JOIN sponsor_inventory_units u ON u.id=b.unit_id WHERE b.id=$1 FOR UPDATE OF b', [i.id])).rows[0];
      if (!b) throw notFound('Booking');
      await manageTarget(c, user, b.target_type, b.target_id);
      if (b.status === 'released') return { ok: true, status: 'released' };
      await c.query("UPDATE sponsor_inventory_bookings SET status='released', released_by=$2, released_at=now(), release_reason=$3 WHERE id=$1", [b.id, user.id, i.reason]);
      const ended = (await c.query("UPDATE event_sponsor_placements SET status='ended', ended_at=now(), ended_by=$2 WHERE booking_id=$1 AND status='active' RETURNING id", [b.id, user.id])).rowCount;
      await logHistory(c, b.sponsorship_id, (await c.query('SELECT terms_version FROM sponsorships WHERE id=$1', [b.sponsorship_id])).rows[0].terms_version, user.id, 'inventory_released', i.reason);
      return { ok: true, status: 'released', placements_ended: ended };
    });
  },
});

cap({
  name: 'list_sponsorship_inventory_bookings', method: 'GET', path: '/sponsorships/:id/inventory', tag: TAG,
  summary: 'The inventory an agreement holds (both sides): unit, kind, category, period, status, the public placements it backs and the deliverables attached to it. Sponsor-side members need the roi permission.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await dealContext(c, i.id, user);
      if (ctx.role === 'sponsor') ctx.need('roi', 'read inventory and exposure');
      if (!RUNNING.includes(ctx.d.status) && ctx.d.status !== 'proposed') throw notFound('Inventory');
      const rows = (await c.query(`SELECT b.id, b.category, b.starts_on::text AS starts_on, b.ends_on::text AS ends_on, b.status, b.note, b.release_reason, u.id AS unit_id, u.kind, u.name AS unit_name, u.placement_slot,
          (SELECT count(*)::int FROM event_sponsor_placements p WHERE p.booking_id=b.id AND p.status='active') AS active_placements,
          (SELECT count(*)::int FROM sponsorship_deliverables x WHERE x.booking_id=b.id) AS deliverables
        FROM sponsor_inventory_bookings b JOIN sponsor_inventory_units u ON u.id=b.unit_id WHERE b.sponsorship_id=$1 ORDER BY b.starts_on, b.id`, [ctx.d.id])).rows;
      return rows.map((r) => ({ ...r, kind_label: INVENTORY_KINDS[r.kind] }));
    });
  },
});

// ---- sellable rights packages (#589): a named bundle of units with a price and validity -------------------------------------------------------
const PKG = 'id, target_type, target_id, name, description, price_minor, currency, valid_from::text AS valid_from, valid_to::text AS valid_to, status, row_version, created_at';

cap({
  name: 'save_sponsor_rights_package', method: 'POST', path: '/sponsor-rights-packages', tag: TAG, status: 201,
  summary: 'Owner of an event, team or athlete: create or change (send `package_id` and `row_version`) a sellable bundle of its own inventory units with an optional price and validity window. A package only groups units; booking still goes unit by unit through `book_sponsor_inventory`, so availability, exclusivity and territory rules are never bypassed. Statuses: draft, open (visible to sponsors), archived. Nothing is deleted. Not the broadcast `mr_packages` (media rights licensed to broadcasters).',
  input: z.object({ package_id: id.optional(), row_version: z.coerce.number().int().min(1).optional(), target_type: z.enum(['event', 'team', 'athlete']), target_id: id, name: z.string().trim().min(2).max(120), description: z.string().trim().max(1000).optional(),
    unit_ids: z.array(id).min(1).max(50), price_minor: z.coerce.number().int().min(0).optional(), currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(), valid_from: date.optional(), valid_to: date.optional(), status: z.enum(['draft', 'open', 'archived']).default('draft') })
    .refine((x) => (x.price_minor == null) === (x.currency == null), 'Give the price together with its currency').refine((x) => !x.valid_from || !x.valid_to || x.valid_to >= x.valid_from, 'valid_to is before valid_from'),
  async handler({ user }, i) {
    return tx(async (c) => {
      await manageTarget(c, user, i.target_type, i.target_id);
      const ids = [...new Set(i.unit_ids)];
      const ok = (await c.query("SELECT count(*)::int AS n FROM sponsor_inventory_units WHERE id = ANY($1::uuid[]) AND target_type=$2 AND target_id=$3 AND status='active'", [ids, i.target_type, i.target_id])).rows[0].n;
      if (ok !== ids.length) throw badRequest('Every unit must be an active unit of this event, team or athlete');
      let row;
      if (i.package_id) {
        const p = (await c.query('SELECT * FROM sponsor_rights_packages WHERE id=$1 FOR UPDATE', [i.package_id])).rows[0];
        if (!p || p.target_type !== i.target_type || p.target_id !== i.target_id) throw notFound('Rights package');
        if (p.row_version !== i.row_version) throw conflict('This changed while you were looking; reload it and try again', { code: 'stale_version' });
        row = (await c.query(`UPDATE sponsor_rights_packages SET name=$2, description=$3, price_minor=$4, currency=$5, valid_from=$6, valid_to=$7, status=$8, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING ${PKG}`,
          [p.id, i.name, i.description ?? null, i.price_minor ?? null, i.currency ?? null, i.valid_from ?? null, i.valid_to ?? null, i.status])).rows[0];
        await c.query('UPDATE sponsor_rights_package_units SET removed_at=now() WHERE package_id=$1 AND removed_at IS NULL AND NOT (unit_id = ANY($2::uuid[]))', [p.id, ids]);   // taken out of the bundle, kept as history
      } else {
        row = (await c.query(`INSERT INTO sponsor_rights_packages(target_type, target_id, name, description, price_minor, currency, valid_from, valid_to, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${PKG}`,
          [i.target_type, i.target_id, i.name, i.description ?? null, i.price_minor ?? null, i.currency ?? null, i.valid_from ?? null, i.valid_to ?? null, i.status, user.id])).rows[0];
      }
      for (const u of ids) await c.query('INSERT INTO sponsor_rights_package_units(package_id, unit_id) VALUES ($1,$2) ON CONFLICT (package_id, unit_id) DO UPDATE SET removed_at=NULL', [row.id, u]);
      return { ...row, unit_ids: ids };
    });
  },
});

cap({
  name: 'list_sponsor_rights_packages', method: 'GET', path: '/sponsor-rights-packages', tag: TAG,
  summary: 'Rights packages of an event, team or athlete with their units, each unit\'s kind, territory, platforms and whether it is currently free. The owner sees drafts and archived packages; everyone else sees only open ones (an athlete\'s only while open to sponsors) and never who holds a unit.',
  input: z.object({ target_type: z.enum(['event', 'team', 'athlete']), target_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      let mine = false;
      try { await manageTarget(c, user, i.target_type, i.target_id); mine = true; } catch { mine = isAdmin(user); }
      if (i.target_type === 'athlete' && !mine && !(await c.query('SELECT 1 FROM sponsorship_profiles WHERE user_id=$1 AND open_to_sponsors', [i.target_id])).rowCount) throw notFound('Rights packages');
      const pk = (await c.query(`SELECT ${PKG} FROM sponsor_rights_packages WHERE target_type=$1 AND target_id=$2 AND ($3 OR status='open') ORDER BY created_at, id`, [i.target_type, i.target_id, mine])).rows;
      const from = today();
      for (const p of pk) {
        p.units = (await c.query(`SELECT u.id, u.kind, u.name, u.capacity, u.territory_mode, u.countries, u.platforms, u.exclusivity_scope, u.status FROM sponsor_rights_package_units m JOIN sponsor_inventory_units u ON u.id=m.unit_id WHERE m.package_id=$1 AND m.removed_at IS NULL ORDER BY u.name, u.id`, [p.id])).rows;
        for (const u of p.units) { u.kind_label = INVENTORY_KINDS[u.kind]; u.free_today = u.status === 'active' && (await peak(c, u.id, from, from)) < u.capacity; }
      }
      return { owner: mine, packages: pk };
    });
  },
});
