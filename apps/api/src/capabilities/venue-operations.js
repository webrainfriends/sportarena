// Venue operations: every court (including retired ones), lockers with per-booking PINs, maintenance work, the vendor register
// (maintenance contacts and suppliers), contracts, and one overview that also surfaces the venue's insurance. Venue team only.
// Courts, photos, rates, offers and plans stay where they are (venues.js, venue-admin.js, venue-media.js, plans.js): this adds what was missing.
import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit, mustFind, patchRow } from '../helpers.js';
import { encryptFields, decryptFields } from '../crypto.js';
import { notify } from '../notify.js';
import { mustManage, canManage } from '../booking/engine.js';
import { hhmm } from '../booking/time.js';
import { blockSlots } from './venue-admin.js';
import { assignLocker, releaseAssignment, renewPin, openPin } from '../booking/lockers.js';

const TAG = 'Venue operations';
const day = z.string().date();
const clock = z.string().regex(/^\d{1,2}:\d{2}$/, 'use HH:MM').refine((s) => !Number.isNaN(hhmm(s)), 'not a valid time');

// ------------------------------------------------------------------ courts (all of them, retired included)
cap({
  name: 'list_venue_courts', method: 'GET', path: '/venues/:id/courts', tag: TAG,
  summary: 'Venue team: every court/table/area of the venue, including retired ones (get_venue hides those), with upcoming bookings and open maintenance, so you can retire one safely or bring it back. Add and edit with add_resource / update_resource; `active: false` retires (bookings stay), `active: true` restores.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    return many(
      `SELECT r.*, s.name AS sport, s.slug AS sport_slug, s.emoji AS sport_emoji,
              (SELECT count(*)::int FROM bookings b WHERE b.resource_id=r.id AND b.status='confirmed' AND b.ends_at > now()) AS upcoming_bookings,
              (SELECT count(*)::int FROM venue_maintenance m WHERE m.resource_id=r.id AND m.status IN ('scheduled','in_progress')) AS open_maintenance
         FROM resources r LEFT JOIN sports s ON s.id=r.sport_id WHERE r.venue_id=$1 ORDER BY r.active DESC, r.kind, r.name`, [i.id]);
  },
});

// ------------------------------------------------------------------ lockers
const LABEL = z.string().trim().min(1).max(20);
cap({
  name: 'create_lockers', method: 'POST', path: '/venues/:id/lockers', tag: TAG, status: 201,
  summary: 'Venue team: add lockers — either a list of `labels`, or a `prefix` with a `count` (e.g. "A" × 20 → A1…A20) — with an optional zone (men\'s room, pool deck …) and size. Labels already in use are skipped. Retire with update_locker; lockers are never deleted.',
  input: z.object({
    id, labels: z.array(LABEL).min(1).max(200).optional(), prefix: z.string().trim().max(15).optional(), count: z.number().int().min(1).max(200).optional(), start_number: z.number().int().min(0).max(9999).default(1),
    zone: z.string().trim().max(40).optional(), size: z.enum(['small', 'medium', 'large']).default('medium'), notes: z.string().max(200).optional(),
  }).refine((i) => i.labels?.length || (i.prefix !== undefined && i.count), 'Give labels, or a prefix and a count'),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    const labels = [...new Set(i.labels ?? Array.from({ length: i.count }, (_, n) => `${i.prefix}${i.start_number + n}`))];
    if (labels.some((l) => !l || l.length > 20)) throw badRequest('Locker labels are 1–20 characters');
    return tx(async (c) => {
      const created = [];
      for (const label of labels) {
        const r = (await c.query('INSERT INTO venue_lockers(venue_id, label, zone, size, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (venue_id, label) DO NOTHING RETURNING *', [i.id, label, i.zone ?? null, i.size, i.notes ?? null, user.id])).rows[0];
        if (r) created.push(r);
      }
      return { created, skipped: labels.length - created.length };
    });
  },
});

cap({
  name: 'list_lockers', method: 'GET', path: '/venues/:id/lockers', tag: TAG,
  summary: 'Venue team: the venue\'s lockers with whether each is in use right now (and by which booking code) and how many upcoming bookings hold it. Retired lockers only with include_retired.',
  input: z.object({ id, include_retired: z.coerce.boolean().default(false) }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    return many(
      `SELECT l.*, cur.code AS in_use_by_code, cur.ends_at AS in_use_until, (cur.id IS NOT NULL) AS in_use_now,
              (SELECT count(*)::int FROM locker_assignments a WHERE a.locker_id=l.id AND a.status='active' AND a.ends_at > now()) AS upcoming
         FROM venue_lockers l
         LEFT JOIN LATERAL (SELECT a.id, a.ends_at, rs.code FROM locker_assignments a JOIN reservations rs ON rs.id=a.reservation_id
                             WHERE a.locker_id=l.id AND a.status='active' AND a.starts_at <= now() AND a.ends_at > now() LIMIT 1) cur ON true
        WHERE l.venue_id=$1 AND ($2 OR l.active) ORDER BY l.active DESC, l.zone NULLS LAST, length(l.label), l.label`, [i.id, i.include_retired]);
  },
});

cap({
  name: 'update_locker', method: 'PATCH', path: '/lockers/:id', tag: TAG,
  summary: 'Venue team: rename a locker, change its zone/size/notes, or take it out of service (`active: false` — refused while upcoming bookings hold it; reassign or release those first).',
  input: z.object({ id, label: LABEL.optional(), zone: z.string().trim().max(40).nullable().optional(), size: z.enum(['small', 'medium', 'large']).optional(), notes: z.string().max(200).nullable().optional(), active: z.boolean().optional() }),
  async handler({ user }, i) {
    const l = await mustFind('venue_lockers', i.id);
    await mustManage(user, l.venue_id);
    if (i.active === false && (await one("SELECT 1 FROM locker_assignments WHERE locker_id=$1 AND status='active' AND ends_at > now()", [i.id])))
      throw conflict('Upcoming bookings hold this locker — release or move them first');
    try { return await patchRow('venue_lockers', i.id, i, ['label', 'zone', 'size', 'notes', 'active']); }
    catch (e) { if (e.code === '23505') throw conflict('Another locker here already has that label'); throw e; }
  },
});

/** The reservation, the venue the caller runs that it touches, and a 404 for anyone else. */
async function reservationForTeam(user, reservationId, venueId) {
  const rs = await mustFind('reservations', reservationId);
  const venues = (await many('SELECT DISTINCT r.venue_id FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE b.reservation_id=$1', [reservationId])).map((v) => v.venue_id);
  const mine = [];
  for (const v of venues) if ((!venueId || v === venueId) && await canManage(user, v)) mine.push(v);
  if (!mine.length) throw notFound('Reservation');
  if (mine.length > 1) throw badRequest('This reservation spans several of your venues — say which one with venue_id');
  return { rs, venueId: mine[0] };
}

cap({
  name: 'assign_locker', method: 'POST', path: '/reservations/:id/locker', tag: TAG, status: 201,
  summary: 'Venue team: give a booking a locker and generate its PIN. Picks the first free locker for the booking\'s time (30 minutes either side), or a particular `locker_id`/`size`. The booker is told a locker is ready; the PIN appears in the booking details (get_reservation → lockers[]) for the booker and the team — never in notifications. 409 when none is free.',
  input: z.object({ id, venue_id: id.optional(), locker_id: id.optional(), size: z.enum(['small', 'medium', 'large']).optional(), digits: z.number().int().min(4).max(6).default(4) }),
  async handler({ user }, i) {
    const { venueId } = await reservationForTeam(user, i.id, i.venue_id);
    return tx(async (c) => {
      const a = await assignLocker(c, { reservationId: i.id, venueId, lockerId: i.locker_id, size: i.size, digits: i.digits, by: user.id });
      await audit(c, user.id, 'assign_locker', 'reservations', i.id);
      return { ...a, pin: openPin((await c.query('SELECT pin_enc FROM locker_assignments WHERE id=$1', [a.id])).rows[0].pin_enc) };
    });
  },
});

cap({
  name: 'list_locker_assignments', method: 'GET', path: '/venues/:id/locker-assignments', tag: TAG,
  summary: 'Venue team: who holds which locker, with booking code, name, window and PIN (for the front desk). Default: active assignments that have not ended. Reading PINs is audit-logged.',
  input: z.object({ id, from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(), ...page }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    const rows = await many(
      `SELECT a.id, a.reservation_id, rs.code, u.display_name AS holder, l.id AS locker_id, l.label, l.zone, a.starts_at, a.ends_at, a.pin_enc, a.pin_version, a.shared_at
         FROM locker_assignments a JOIN venue_lockers l ON l.id=a.locker_id JOIN reservations rs ON rs.id=a.reservation_id JOIN users u ON u.id=a.user_id
        WHERE a.venue_id=$1 AND a.status='active' AND a.ends_at > coalesce($2::timestamptz, now()) AND ($3::timestamptz IS NULL OR a.starts_at < $3)
        ORDER BY a.starts_at, l.label LIMIT $4 OFFSET $5`, [i.id, i.from ?? null, i.to ?? null, i.limit, i.offset]);
    if (rows.length) await audit(null, user.id, 'read_locker_pin', 'venues', i.id);
    return rows.map(({ pin_enc, ...a }) => ({ ...a, pin: openPin(pin_enc) }));
  },
});

async function assignmentFor(user, assignmentId, { team = true } = {}) {
  const a = await one("SELECT a.*, l.label, l.zone, v.name AS venue_name, v.timezone FROM locker_assignments a JOIN venue_lockers l ON l.id=a.locker_id JOIN venues v ON v.id=a.venue_id WHERE a.id=$1 AND a.status='active'", [assignmentId]);
  if (!a) throw notFound('Locker assignment');
  const staff = await canManage(user, a.venue_id);
  if (!staff && (team || a.user_id !== user.id)) throw notFound('Locker assignment');
  return { a, staff };
}

cap({
  name: 'regenerate_locker_pin', method: 'POST', path: '/locker-assignments/:id/pin', tag: TAG,
  summary: 'Venue team: replace a booking\'s locker PIN with a new random one (e.g. it was shared by mistake). The booker is told to check the booking for the new PIN; the old one stops being shown.',
  input: z.object({ id, digits: z.number().int().min(4).max(6).default(4) }),
  async handler({ user }, i) {
    const { a } = await assignmentFor(user, i.id);
    return tx(async (c) => {
      const n = await renewPin(c, i.id, { digits: i.digits });
      if (!n) throw conflict('That locker assignment is no longer active');
      await notify(c, a.user_id, { kind: 'locker_pin_changed', title: `New PIN for locker ${a.label}`, body: 'The venue set a new PIN for your locker. Open the booking to see it.', data: { reservation_id: a.reservation_id, venue_id: a.venue_id } });
      await audit(c, user.id, 'regenerate_locker_pin', 'locker_assignments', i.id);
      return { id: i.id, pin_version: n.pin_version, pin: openPin((await c.query('SELECT pin_enc FROM locker_assignments WHERE id=$1', [i.id])).rows[0].pin_enc) };
    });
  },
});

cap({
  name: 'release_locker_assignment', method: 'DELETE', path: '/locker-assignments/:id', tag: TAG,
  summary: 'Venue team: take the locker back from a booking (the record stays). The booker is told.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { a } = await assignmentFor(user, i.id);
    return tx(async (c) => {
      await releaseAssignment(c, i.id, user.id, `Locker ${a.label} at ${a.venue_name} was released by the venue.`);
      return { ok: true };
    });
  },
});

cap({
  name: 'share_locker_pin', method: 'POST', path: '/locker-assignments/:id/share', tag: TAG,
  summary: 'The booker or the venue team: get a ready-to-send message with the locker, its PIN and when it is valid (to pass to a friend or paste into the appointment). When the venue team shares, the booker is also pointed to the booking details (the PIN itself never goes in a notification). Marks the PIN as shared.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { a, staff } = await assignmentFor(user, i.id, { team: false });
    const fmt = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: a.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(d);
    return tx(async (c) => {
      await c.query('UPDATE locker_assignments SET shared_at=now() WHERE id=$1', [i.id]);
      if (staff && a.user_id !== user.id) await notify(c, a.user_id, { kind: 'locker_shared', title: `Locker ${a.label} details`, body: `Your locker details at ${a.venue_name} are in your booking — open it to see the PIN.`, data: { reservation_id: a.reservation_id, venue_id: a.venue_id } });
      if (staff) await audit(c, user.id, 'read_locker_pin', 'locker_assignments', i.id);
      return { message: `Locker ${a.label}${a.zone ? ` (${a.zone})` : ''} at ${a.venue_name} — PIN ${openPin(a.pin_enc)}. Valid ${fmt(a.starts_at)} to ${fmt(a.ends_at)}.`, shared_at: new Date() };
    });
  },
});

// ------------------------------------------------------------------ vendors (maintenance contacts + suppliers)
const VENDOR_KINDS = ['maintenance', 'supplier', 'cleaning', 'security', 'technology', 'other'];
const CONTACT = ['contact_name', 'phone', 'email'];
const vendorFields = {
  kind: z.enum(VENDOR_KINDS), name: z.string().trim().min(2).max(100), categories: z.array(z.string().trim().min(1).max(30)).max(20).default([]).describe('what they do or supply: surface, lighting, nets, drinks …'),
  contact_name: z.string().trim().max(80).optional(), phone: z.string().trim().max(30).optional(), email: z.string().email().optional(),
  address: z.string().max(200).optional(), website: z.string().url().max(300).optional(), emergency_24x7: z.boolean().default(false),
  lead_time_days: z.number().int().min(0).max(365).optional(), payment_terms: z.string().max(100).optional(), rating: z.number().int().min(1).max(5).optional(), notes: z.string().max(1000).optional(),
};
const vendorOut = (r) => { const { contact_name_enc, phone_enc, email_enc, ...rest } = r; return { ...rest, ...decryptFields(r, 'venue_vendors', CONTACT) }; };

cap({
  name: 'create_vendor', method: 'POST', path: '/venues/:id/vendors', tag: TAG, status: 201,
  summary: 'Venue team: add a vendor — a maintenance contractor (surface, lighting, plumbing …) or a supplier of consumables and kit — with what they do, a 24×7 emergency flag, lead time and payment terms. Contact name, phone and email are encrypted at rest.',
  input: z.object({ id, ...vendorFields }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    const e = encryptFields(i, 'venue_vendors', CONTACT);
    const r = await one(
      `INSERT INTO venue_vendors(venue_id, kind, name, categories, contact_name_enc, phone_enc, email_enc, address, website, emergency_24x7, lead_time_days, payment_terms, rating, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [i.id, i.kind, i.name, i.categories, e.contact_name_enc ?? null, e.phone_enc ?? null, e.email_enc ?? null, i.address ?? null, i.website ?? null, i.emergency_24x7, i.lead_time_days ?? null, i.payment_terms ?? null, i.rating ?? null, i.notes ?? null, user.id]);
    return vendorOut(r);
  },
});

cap({
  name: 'list_vendors', method: 'GET', path: '/venues/:id/vendors', tag: TAG,
  summary: 'Venue team: the vendor register with decrypted contacts (audit-logged), open maintenance jobs and live contracts per vendor. Filter by kind; archived ones only with include_archived.',
  input: z.object({ id, kind: z.enum(VENDOR_KINDS).optional(), include_archived: z.coerce.boolean().default(false) }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    const rows = await many(
      `SELECT v.*, (SELECT count(*)::int FROM venue_maintenance m WHERE m.vendor_id=v.id AND m.status IN ('scheduled','in_progress')) AS open_jobs,
              (SELECT count(*)::int FROM venue_contracts k WHERE k.vendor_id=v.id AND k.status='active') AS live_contracts
         FROM venue_vendors v WHERE v.venue_id=$1 AND ($2::text IS NULL OR v.kind=$2) AND ($3 OR v.status <> 'archived') ORDER BY (v.status='archived'), v.kind, v.name`, [i.id, i.kind ?? null, i.include_archived]);
    if (rows.length) await audit(null, user.id, 'read_pii', 'venue_vendors', i.id);
    return rows.map(vendorOut);
  },
});

cap({
  name: 'update_vendor', method: 'PATCH', path: '/vendors/:id', tag: TAG,
  summary: 'Venue team: edit a vendor, pause it or archive it (`status`) — vendors are never deleted, their jobs and contracts keep pointing at them.',
  input: z.object({ id, ...Object.fromEntries(Object.entries(vendorFields).map(([k, v]) => [k, v.optional()])), status: z.enum(['active', 'paused', 'archived']).optional() }),
  async handler({ user }, i) {
    const v = await mustFind('venue_vendors', i.id, 'id, venue_id');
    await mustManage(user, v.venue_id);
    const e = encryptFields(i, 'venue_vendors', CONTACT);
    const r = await patchRow('venue_vendors', i.id, { ...i, ...e, updated_at: new Date() },
      ['kind', 'name', 'categories', 'contact_name_enc', 'phone_enc', 'email_enc', 'address', 'website', 'emergency_24x7', 'lead_time_days', 'payment_terms', 'rating', 'notes', 'status', 'updated_at']);
    return vendorOut(r);
  },
});

const vendorOfVenue = async (venueId, vendorId) => {
  if (vendorId && !(await one('SELECT 1 FROM venue_vendors WHERE id=$1 AND venue_id=$2', [vendorId, venueId]))) throw badRequest('That vendor belongs to another venue');
};

// ------------------------------------------------------------------ maintenance
const CATEGORIES = ['general', 'surface', 'lighting', 'equipment', 'plumbing', 'electrical', 'cleaning', 'safety', 'inspection', 'other'];
const maintenanceFields = {
  title: z.string().trim().min(2).max(120), category: z.enum(CATEGORIES).default('general'), priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  resource_id: id.optional().describe('the court it is about; omit for the whole venue'), due_on: day.optional(), vendor_id: id.optional(),
  estimated_cost_cents: money.optional(), repeat_every_days: z.number().int().min(1).max(3650).optional().describe('when finished, the next job is raised this many days later'), notes: z.string().max(1000).optional(),
};
const sameVenue = async (venueId, resourceId) => {
  if (resourceId && !(await one('SELECT 1 FROM resources WHERE id=$1 AND venue_id=$2', [resourceId, venueId]))) throw badRequest('That court belongs to another venue');
};

cap({
  name: 'create_maintenance', method: 'POST', path: '/venues/:id/maintenance', tag: TAG, status: 201,
  summary: 'Venue team: log maintenance work on a court or the whole venue — what, how urgent, when due, which vendor, estimated cost, and an optional repeat. With `close` it also blocks the court(s) over a date range so nobody can book them (same rules as block_slots: 409 lists bookings in the way unless cancel_conflicting).',
  input: z.object({
    id, ...maintenanceFields,
    close: z.object({ from_date: day, to_date: day, start_time: clock.default('00:00'), end_time: clock.default('24:00'), cancel_conflicting: z.boolean().default(false) }).optional(),
  }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    await sameVenue(i.id, i.resource_id);
    await vendorOfVenue(i.id, i.vendor_id);
    let batch = null;
    if (i.close) {
      const b = await blockSlots(user, { id: i.id, resource_ids: i.resource_id ? [i.resource_id] : [], ...i.close, kind: 'maintenance', reason: i.title, dry_run: false });
      batch = b.batch_id;
    }
    try {
      return await one(
        `INSERT INTO venue_maintenance(venue_id, resource_id, title, category, priority, due_on, vendor_id, estimated_cost_cents, repeat_every_days, block_batch_id, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [i.id, i.resource_id ?? null, i.title, i.category, i.priority, i.due_on ?? null, i.vendor_id ?? null, i.estimated_cost_cents ?? null, i.repeat_every_days ?? null, batch, i.notes ?? null, user.id]);
    } catch (e) {
      if (batch) await pool.query('UPDATE venue_blocks SET released_at=now() WHERE batch_id=$1 AND released_at IS NULL', [batch]);
      throw e;
    }
  },
});

cap({
  name: 'list_maintenance', method: 'GET', path: '/venues/:id/maintenance', tag: TAG,
  summary: 'Venue team: maintenance work with court and vendor names, an `overdue` flag, and totals (open, overdue, urgent, cost this year). Filter by status ("open" = scheduled + in progress), court or vendor.',
  input: z.object({ id, status: z.enum(['open', 'scheduled', 'in_progress', 'done', 'cancelled', 'all']).default('open'), resource_id: id.optional(), vendor_id: id.optional(), ...page }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    const items = await many(
      `SELECT m.*, r.name AS court, vd.name AS vendor_name, (m.status IN ('scheduled','in_progress') AND m.due_on < current_date) AS overdue
         FROM venue_maintenance m LEFT JOIN resources r ON r.id=m.resource_id LEFT JOIN venue_vendors vd ON vd.id=m.vendor_id
        WHERE m.venue_id=$1 AND ($2='all' OR ($2='open' AND m.status IN ('scheduled','in_progress')) OR m.status=$2) AND ($3::uuid IS NULL OR m.resource_id=$3) AND ($4::uuid IS NULL OR m.vendor_id=$4)
        ORDER BY (m.status IN ('done','cancelled')), CASE m.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, m.due_on NULLS LAST, m.created_at DESC LIMIT $5 OFFSET $6`,
      [i.id, i.status, i.resource_id ?? null, i.vendor_id ?? null, i.limit, i.offset]);
    const totals = await one(
      `SELECT count(*) FILTER (WHERE status IN ('scheduled','in_progress'))::int AS open, count(*) FILTER (WHERE status IN ('scheduled','in_progress') AND due_on < current_date)::int AS overdue,
              count(*) FILTER (WHERE status IN ('scheduled','in_progress') AND priority='urgent')::int AS urgent,
              coalesce(sum(actual_cost_cents) FILTER (WHERE status='done' AND completed_at >= date_trunc('year', now())),0)::bigint AS cost_this_year_cents
         FROM venue_maintenance WHERE venue_id=$1`, [i.id]);
    return { totals, items };
  },
});

cap({
  name: 'update_maintenance', method: 'PATCH', path: '/maintenance/:id', tag: TAG,
  summary: 'Venue team: edit a job, move it to in_progress, or finish it (`status: "done"` with the actual cost) or cancel it. Finishing or cancelling reopens any court that was blocked for it; a job with a repeat interval raises its next job automatically.',
  input: z.object({
    id, title: maintenanceFields.title.optional(), category: z.enum(CATEGORIES).optional(), priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(), due_on: day.nullable().optional(),
    resource_id: id.nullable().optional(), vendor_id: id.nullable().optional(), estimated_cost_cents: money.nullable().optional(), actual_cost_cents: money.nullable().optional(),
    repeat_every_days: z.number().int().min(1).max(3650).nullable().optional(), notes: z.string().max(1000).nullable().optional(), status: z.enum(['scheduled', 'in_progress', 'done', 'cancelled']).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const m = (await c.query('SELECT * FROM venue_maintenance WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!m) throw notFound('Maintenance job');
      await mustManage(user, m.venue_id, c);
      const closed = ['done', 'cancelled'].includes(m.status);
      if (closed && i.status && i.status !== m.status) throw conflict(`That job is already ${m.status}`);
      if (closed && Object.keys(i).some((k) => k !== 'id' && k !== 'notes' && k !== 'actual_cost_cents')) throw conflict(`A ${m.status} job can only have its notes and cost changed`);
      if (i.resource_id) await sameVenue(m.venue_id, i.resource_id);
      if (i.vendor_id) await vendorOfVenue(m.venue_id, i.vendor_id);
      const finishing = !closed && (i.status === 'done' || i.status === 'cancelled');
      const patch = { ...i, updated_at: new Date(), ...(finishing ? { completed_at: new Date(), completed_by: user.id } : {}) };
      const row = await patchRow('venue_maintenance', i.id, patch,
        ['title', 'category', 'priority', 'due_on', 'resource_id', 'vendor_id', 'estimated_cost_cents', 'actual_cost_cents', 'repeat_every_days', 'notes', 'status', 'completed_at', 'completed_by', 'updated_at'], c);
      let next = null;
      if (finishing) {
        if (m.block_batch_id) {
          const r = await c.query('UPDATE venue_blocks SET released_at=now() WHERE batch_id=$1 AND released_at IS NULL', [m.block_batch_id]);
          if (r.rowCount) c.afterCommit?.(() => import('../booking/freed.js').then((x) => x.kickFreed(m.venue_id)));
        }
        const every = row.repeat_every_days;
        if (i.status === 'done' && every) {
          next = (await c.query(
            `INSERT INTO venue_maintenance(venue_id, resource_id, title, category, priority, due_on, vendor_id, estimated_cost_cents, repeat_every_days, notes, created_by)
             VALUES ($1,$2,$3,$4,$5,current_date + $6::int,$7,$8,$9,$10,$11) RETURNING id, due_on`,
            [m.venue_id, row.resource_id, row.title, row.category, row.priority, every, row.vendor_id, row.estimated_cost_cents, every, row.notes, user.id])).rows[0];
          await c.query('UPDATE venue_maintenance SET next_id=$2 WHERE id=$1', [i.id, next.id]);
        }
      }
      return { ...row, next_job: next };
    });
  },
});

// ------------------------------------------------------------------ contracts
const CONTRACT_KINDS = ['maintenance', 'supply', 'service', 'lease', 'sponsorship', 'other'];
const contractFields = {
  kind: z.enum(CONTRACT_KINDS), title: z.string().trim().min(2).max(120), vendor_id: id.optional(), reference: z.string().max(60).optional(),
  starts_on: day.optional(), ends_on: day.optional(), auto_renews: z.boolean().default(false), notice_days: z.number().int().min(0).max(365).default(30).describe('the team is reminded this many days before it ends'),
  value_cents: money.optional().describe('contract value in the venue currency'), payment_terms: z.string().max(100).optional(), document_id: id.optional().describe('the signed file, from the venue documents folder (kind "contract")'), notes: z.string().max(1000).optional(),
};
async function documentOfVenue(venueId, documentId) {
  if (documentId && !(await one("SELECT 1 FROM subject_documents WHERE id=$1 AND subject_type='venue' AND subject_id=$2 AND removed_at IS NULL", [documentId, venueId])))
    throw badRequest('That document is not in this venue\'s documents folder');
}
const datesOk = (i) => !i.starts_on || !i.ends_on || i.ends_on >= i.starts_on;

cap({
  name: 'create_venue_contract', method: 'POST', path: '/venues/:id/contracts', tag: TAG, status: 201,
  summary: 'Venue team: record a contract (maintenance, supply, service, lease …) with its vendor, term, value, notice period, whether it renews itself, and the signed file from the venue documents folder. The team is reminded before it ends.',
  input: z.object({ id, ...contractFields }).refine(datesOk, 'ends_on is before starts_on'),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    await vendorOfVenue(i.id, i.vendor_id);
    await documentOfVenue(i.id, i.document_id);
    return one(
      `INSERT INTO venue_contracts(venue_id, vendor_id, kind, title, reference, starts_on, ends_on, auto_renews, notice_days, value_cents, payment_terms, document_id, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [i.id, i.vendor_id ?? null, i.kind, i.title, i.reference ?? null, i.starts_on ?? null, i.ends_on ?? null, i.auto_renews, i.notice_days, i.value_cents ?? null, i.payment_terms ?? null, i.document_id ?? null, i.notes ?? null, user.id]);
  },
});

cap({
  name: 'list_venue_contracts', method: 'GET', path: '/venues/:id/contracts', tag: TAG,
  summary: 'Venue team: the venue\'s contracts with vendor and document names, days left and an `ending_soon` flag (within its notice period). Filter by status or vendor.',
  input: z.object({ id, status: z.enum(['draft', 'active', 'ended', 'terminated', 'all']).default('all'), vendor_id: id.optional() }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    return many(
      `SELECT k.*, vd.name AS vendor_name, d.title AS document_title, (k.ends_on - current_date) AS days_left,
              (k.status='active' AND k.ends_on IS NOT NULL AND k.ends_on <= current_date + k.notice_days) AS ending_soon
         FROM venue_contracts k LEFT JOIN venue_vendors vd ON vd.id=k.vendor_id LEFT JOIN subject_documents d ON d.id=k.document_id
        WHERE k.venue_id=$1 AND ($2='all' OR k.status=$2) AND ($3::uuid IS NULL OR k.vendor_id=$3) ORDER BY (k.status IN ('ended','terminated')), k.ends_on NULLS LAST, k.title`, [i.id, i.status, i.vendor_id ?? null]);
  },
});

cap({
  name: 'update_venue_contract', method: 'PATCH', path: '/contracts/:id', tag: TAG,
  summary: 'Venue team: edit a contract, attach the signed file, extend its term (re-arms the ending reminder) or mark it ended/terminated. Contracts are never deleted.',
  input: z.object({
    id, ...Object.fromEntries(Object.entries(contractFields).map(([k, v]) => [k, v.optional()])), vendor_id: id.nullable().optional(), status: z.enum(['draft', 'active', 'ended', 'terminated']).optional(),
  }),
  async handler({ user }, i) {
    const k = await mustFind('venue_contracts', i.id);
    await mustManage(user, k.venue_id);
    await vendorOfVenue(k.venue_id, i.vendor_id);
    await documentOfVenue(k.venue_id, i.document_id);
    const starts = i.starts_on ?? k.starts_on?.toISOString().slice(0, 10), ends = i.ends_on ?? k.ends_on?.toISOString().slice(0, 10);
    if (starts && ends && ends < starts) throw badRequest('ends_on is before starts_on');
    const rearm = i.ends_on !== undefined || i.notice_days !== undefined || (i.status === 'active' && k.status !== 'active');
    return patchRow('venue_contracts', i.id, { ...i, updated_at: new Date(), ...(rearm ? { reminded_at: null } : {}) },
      ['kind', 'title', 'vendor_id', 'reference', 'starts_on', 'ends_on', 'auto_renews', 'notice_days', 'value_cents', 'payment_terms', 'document_id', 'notes', 'status', 'reminded_at', 'updated_at']);
  },
});

// ------------------------------------------------------------------ overview
cap({
  name: 'venue_operations_overview', method: 'GET', path: '/venues/:id/operations', tag: TAG,
  summary: 'Venue team: one look at how the venue is run — courts (live/retired), open and overdue maintenance, lockers in use, vendors, contracts ending soon, and the venue\'s insurance policies with expiry (insurance itself is bought and kept under Insurance / venue documents). Includes `attention`: the things that need a decision.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    const [courts, maint, lockers, vendors, contracts, policies] = await Promise.all([
      one('SELECT count(*) FILTER (WHERE active)::int AS live, count(*) FILTER (WHERE NOT active)::int AS retired FROM resources WHERE venue_id=$1', [i.id]),
      one("SELECT count(*) FILTER (WHERE status IN ('scheduled','in_progress'))::int AS open, count(*) FILTER (WHERE status IN ('scheduled','in_progress') AND due_on < current_date)::int AS overdue, count(*) FILTER (WHERE status IN ('scheduled','in_progress') AND priority='urgent')::int AS urgent FROM venue_maintenance WHERE venue_id=$1", [i.id]),
      one("SELECT (SELECT count(*)::int FROM venue_lockers WHERE venue_id=$1 AND active) AS total, (SELECT count(DISTINCT locker_id)::int FROM locker_assignments WHERE venue_id=$1 AND status='active' AND starts_at <= now() AND ends_at > now()) AS in_use_now", [i.id]),
      one("SELECT count(*) FILTER (WHERE status='active')::int AS active, count(*) FILTER (WHERE status='active' AND kind='maintenance')::int AS maintenance, count(*) FILTER (WHERE status='active' AND kind='supplier')::int AS suppliers FROM venue_vendors WHERE venue_id=$1", [i.id]),
      one("SELECT count(*) FILTER (WHERE status='active')::int AS active, count(*) FILTER (WHERE status='active' AND ends_on IS NOT NULL AND ends_on <= current_date + notice_days)::int AS ending_soon, count(*) FILTER (WHERE status='active' AND ends_on < current_date)::int AS lapsed FROM venue_contracts WHERE venue_id=$1", [i.id]),
      many("SELECT id, status, ends_on, (ends_on - current_date) AS days_left FROM insurance_policies WHERE subject_type='venue' AND subject_id=$1 AND status IN ('active','pending_payment') ORDER BY ends_on", [i.id]),
    ]);
    const lapsing = policies.filter((p) => p.status === 'active' && p.days_left <= 45);
    const attention = [
      ...(maint.overdue ? [{ key: 'maintenance_overdue', text: `${maint.overdue} maintenance job${maint.overdue === 1 ? ' is' : 's are'} overdue` }] : []),
      ...(maint.urgent ? [{ key: 'maintenance_urgent', text: `${maint.urgent} urgent job${maint.urgent === 1 ? '' : 's'} open` }] : []),
      ...(contracts.ending_soon ? [{ key: 'contracts_ending', text: `${contracts.ending_soon} contract${contracts.ending_soon === 1 ? '' : 's'} ending soon` }] : []),
      ...(lapsing.length ? [{ key: 'insurance_expiring', text: `${lapsing.length} insurance polic${lapsing.length === 1 ? 'y' : 'ies'} expiring within 45 days` }] : []),
      ...(!policies.length ? [{ key: 'no_insurance', text: 'No insurance policy on record for this venue' }] : []),
    ];
    return { courts, maintenance: maint, lockers, vendors, contracts, insurance: { policies, expiring_soon: lapsing.length }, attention };
  },
});
