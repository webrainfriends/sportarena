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

const TAG = 'Sponsors';
const date = z.string().date();
const UNIT = 'id, target_type, target_id, kind, name, description, capacity, exclusive_category, placement_slot, available_from::text AS available_from, available_to::text AS available_to, status, row_version, created_at';
const overlap = '(b.starts_on <= $3::date AND b.ends_on >= $2::date)';

/** Peak number of simultaneous bookings of a unit within [from, to]: the capacity a new booking in that window competes for. */
const peak = async (c, unitId, from, to, ignore = null) => Number((await c.query(
  `SELECT coalesce(max(n),0) AS n FROM (SELECT d::date, count(b.id) AS n FROM generate_series($2::date, $3::date, '1 day') d
     LEFT JOIN sponsor_inventory_bookings b ON b.unit_id=$1 AND b.status='confirmed' AND b.starts_on <= d::date AND b.ends_on >= d::date AND ($4::uuid IS NULL OR b.id <> $4) GROUP BY d) x`, [unitId, from, to, ignore])).rows[0].n);

cap({
  name: 'create_sponsor_inventory_unit', method: 'POST', path: '/sponsor-inventory', tag: TAG, status: 201,
  summary: 'Offer a governed unit of sponsor inventory on an event, team or (adult) athlete you manage: title or associate partner, team/athlete association, kit placement, public event page, leaderboard, scorecard, livestream overlay, replay, social content, hospitality, sponsored challenge, agreed appearance or content. Set the capacity (how many sponsors at once) and whether the unit is category-exclusive. On an event, title partner, scorecard, leaderboard and event-page units sell the matching public-page slot; once an event defines a unit for a slot, only a sponsor with a booking can hold that placement.',
  input: z.object({ target_type: z.enum(['event', 'team', 'athlete']), target_id: id, kind: z.enum(Object.keys(INVENTORY_KINDS)), name: z.string().trim().min(2).max(120), description: z.string().trim().max(1000).optional(),
    capacity: z.coerce.number().int().min(1).max(100).default(1), exclusive_category: z.boolean().default(false), available_from: date.optional(), available_to: date.optional() })
    .refine((x) => !x.available_from || !x.available_to || x.available_to >= x.available_from, 'available_to is before available_from'),
  async handler({ user }, i) {
    return tx(async (c) => {
      await manageTarget(c, user, i.target_type, i.target_id);
      if (['team_association', 'kit_placement'].includes(i.kind) && i.target_type === 'event') throw badRequest('Team association and kit placement belong to a team');
      if (i.kind === 'athlete_association' && i.target_type !== 'athlete') throw badRequest('Athlete association belongs to an athlete');
      const slot = i.target_type === 'event' ? SLOT_OF[i.kind] ?? null : null;
      return (await c.query(
        `INSERT INTO sponsor_inventory_units(target_type, target_id, kind, name, description, capacity, exclusive_category, placement_slot, available_from, available_to, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${UNIT}`,
        [i.target_type, i.target_id, i.kind, i.name, i.description ?? null, i.capacity, i.exclusive_category, slot, i.available_from ?? null, i.available_to ?? null, user.id])).rows[0];
    });
  },
});

cap({
  name: 'update_sponsor_inventory_unit', method: 'PATCH', path: '/sponsor-inventory/:id', tag: TAG,
  summary: 'Change a unit (name, description, capacity, exclusivity, availability) or archive it. Capacity cannot drop below what is already booked, exclusivity cannot be switched on while two sponsors of one category overlap, and a unit with live bookings cannot be archived until they are released. `row_version` refuses a stale edit. Nothing is deleted.',
  input: z.object({ id, row_version: z.coerce.number().int().min(1), name: z.string().trim().min(2).max(120).optional(), description: z.string().trim().max(1000).nullable().optional(), capacity: z.coerce.number().int().min(1).max(100).optional(),
    exclusive_category: z.boolean().optional(), available_from: date.nullable().optional(), available_to: date.nullable().optional(), status: z.enum(['active', 'archived']).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const u = (await c.query('SELECT *, available_from::text AS af, available_to::text AS at FROM sponsor_inventory_units WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!u) throw notFound('Inventory unit');
      await manageTarget(c, user, u.target_type, u.target_id);
      if (u.row_version !== i.row_version) throw conflict('This changed while you were looking; reload it and try again', { code: 'stale_version' });
      const next = { ...u, available_from: u.af, available_to: u.at, ...Object.fromEntries(Object.entries(i).filter(([k, v]) => v !== undefined && !['id', 'row_version'].includes(k))) };
      if (next.available_from && next.available_to && next.available_to < next.available_from) throw badRequest('available_to is before available_from');
      const live = (await c.query("SELECT count(*)::int AS n, to_char(min(starts_on),'YYYY-MM-DD') AS f, to_char(max(ends_on),'YYYY-MM-DD') AS t FROM sponsor_inventory_bookings WHERE unit_id=$1 AND status='confirmed' AND ends_on >= current_date", [u.id])).rows[0];
      if (next.status === 'archived' && live.n) throw conflict(`${live.n} live booking(s) must be released before this unit is archived`);
      if (next.capacity < u.capacity && live.n && (await peak(c, u.id, live.f, live.t)) > next.capacity) throw conflict('Capacity cannot drop below what is already booked');
      if (next.exclusive_category && !u.exclusive_category) {
        const clash = (await c.query(`SELECT 1 FROM sponsor_inventory_bookings a JOIN sponsor_inventory_bookings b ON b.unit_id=a.unit_id AND b.id > a.id AND b.status='confirmed' AND b.category=a.category AND b.starts_on <= a.ends_on AND b.ends_on >= a.starts_on
          JOIN sponsorships sa ON sa.id=a.sponsorship_id JOIN sponsorships sb ON sb.id=b.sponsorship_id WHERE a.unit_id=$1 AND a.status='confirmed' AND a.category <> 'other' AND sa.sponsor_id <> sb.sponsor_id LIMIT 1`, [u.id])).rowCount;
        if (clash) throw conflict('Two sponsors of the same category already overlap on this unit; release one first');
      }
      return (await c.query(`UPDATE sponsor_inventory_units SET name=$2, description=$3, capacity=$4, exclusive_category=$5, available_from=$6, available_to=$7, status=$8, archived_at=CASE WHEN $8='archived' THEN now() ELSE NULL END, row_version=row_version+1 WHERE id=$1 RETURNING ${UNIT}`,
        [u.id, next.name, next.description, next.capacity, next.exclusive_category, next.available_from, next.available_to, next.status])).rows[0];
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
  summary: 'Book a unit for an ACTIVE agreement with the same event, team or athlete. Refused (409) when the unit is full for any day of the period, when an exclusive unit already has another sponsor of the same category in an overlapping period, when the sponsor already holds the unit then, or when the period falls outside the unit\'s availability or the agreement\'s term. Only the unit\'s owner books it. Nothing can be double-sold: the unit is locked while the check and the booking run.',
  input: z.object({ id, sponsorship_id: id, category: z.enum(CATEGORIES), starts_on: date, ends_on: date, note: z.string().trim().max(500).optional() }).refine((x) => x.ends_on >= x.starts_on, 'ends_on is before starts_on'),
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
      if (u.exclusive_category && i.category !== 'other') {
        const rival = (await c.query(`SELECT sp.name, b.starts_on::text AS starts_on, b.ends_on::text AS ends_on FROM sponsor_inventory_bookings b JOIN sponsorships ss ON ss.id=b.sponsorship_id JOIN sponsors sp ON sp.id=ss.sponsor_id
          WHERE b.unit_id=$1 AND b.status='confirmed' AND b.category=$4 AND ss.sponsor_id <> $5 AND ${overlap} LIMIT 1`, [u.id, i.starts_on, i.ends_on, i.category, d.sponsor_id])).rows[0];
        if (rival) throw conflict(`This unit is exclusive to one ${i.category.replace(/_/g, ' ')} sponsor in a period; it is held ${rival.starts_on} → ${rival.ends_on}`, { code: 'category_exclusive', category: i.category, held_from: rival.starts_on, held_to: rival.ends_on });
      }
      const p = await peak(c, u.id, i.starts_on, i.ends_on);
      if (p >= u.capacity) throw conflict(`This unit is full for part of that period (${p} of ${u.capacity} booked)`, { code: 'inventory_full', capacity: u.capacity, booked_peak: p });
      const row = (await c.query(`INSERT INTO sponsor_inventory_bookings(unit_id, sponsorship_id, category, starts_on, ends_on, note, booked_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
        RETURNING id, unit_id, sponsorship_id, category, starts_on::text AS starts_on, ends_on::text AS ends_on, status, note, created_at`, [u.id, d.id, i.category, i.starts_on, i.ends_on, i.note ?? null, user.id])).rows[0];
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
