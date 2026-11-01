// Venue Facility ERP (#585): what a multi-venue operator needs on top of bookings, stock, maintenance and the front desk.
//   booking series · asset register · preventive maintenance · incidents · staff duties + shifts
//   · readiness checks · income reconciliation · multi-venue command dashboard.
// Nothing here is a second ledger or inventory: assets are inventory_items, work orders are venue_maintenance, money is read from the
// POS / invoices / canonical finance tables, bookings are made by the booking engine. Floor staff (venue_staff.role 'staff') can work the
// day (check in, report, check readiness, run their own shifts and jobs); managers (owner, manager staff, organisation admin) run the rest.
import { z } from 'zod';
import { cap, capabilities, id, page, money } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit, mustFind, patchRow } from '../helpers.js';
import { encryptFields, decryptFields } from '../crypto.js';
import { notify, venueTeam } from '../notify.js';
import { mustManage, mustWork, canManage, createReservation, cancelBookings } from '../booking/engine.js';
import { expandDates, patternFields } from '../recurrence.js';
import { fromLocal, hhmm } from '../booking/time.js';
import { workOrderRefs } from './venue-operations.js';

const TAG = 'Venue facility';
const day = z.string().date();
const clock = z.string().regex(/^\d{1,2}:\d{2}$/, 'use HH:MM');
const when = z.string().datetime({ offset: true });
const DUTIES = ['general', 'reception', 'maintenance', 'lifeguard', 'groundskeeper', 'coach_liaison'];
const SEVERITY = ['minor', 'moderate', 'serious', 'critical'];

// ------------------------------------------------------------------ who may do what
cap({
  name: 'my_venue_permissions', method: 'GET', path: '/venues/:id/me', tag: TAG,
  summary: 'What the caller may do at this venue: their level (manager or floor staff), their duty, and the actions that level allows. The app uses it to show only what the person can use; the server enforces it regardless.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await mustWork(user, i.id);
    const manager = await canManage(user, i.id);
    const staff = await one('SELECT role, duty FROM venue_staff WHERE venue_id=$1 AND user_id=$2 AND removed_at IS NULL', [i.id, user.id]);
    return {
      level: manager ? 'manager' : 'staff', duty: staff?.duty ?? 'general',
      can: {
        report_incident: true, record_readiness: true, clock_own_shift: true, update_own_work_orders: true,
        manage_series: manager, manage_assets: manager, manage_maintenance: manager, manage_shifts: manager, manage_plans: manager,
        see_finance: manager, see_all_incidents: manager, see_network: manager,
      },
    };
  },
});

const roster = async (venueId, userId) => !!(await one('SELECT 1 FROM venues WHERE id=$1 AND owner_id=$2 UNION ALL SELECT 1 FROM venue_staff WHERE venue_id=$1 AND user_id=$2 AND removed_at IS NULL', [venueId, userId]));

// ------------------------------------------------------------------ recurring booking series
cap({
  name: 'create_booking_series', method: 'POST', path: '/venues/:id/booking-series', tag: TAG, status: 201,
  summary: 'Venue manager: hold one area on a repeating pattern (league nights, academy sessions, a standing class) as ONE series — weekly weekdays every N weeks until a date or a number of times, plus extra dates and dates to skip, at the same venue-local time. Uses the booking engine, so nothing is double-booked: dates that cannot be held are reported and skipped (or, with on_conflict "fail", nothing is held). Edit or end the whole series with cancel_booking_series. For customer-facing recurring bookings use book_recurring_venue.',
  input: z.object({ id, resource_id: id, title: z.string().trim().min(2).max(100), start: clock, end: clock, ...patternFields, on_conflict: z.enum(['skip', 'fail']).default('skip') }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    const res = await one('SELECT r.id, r.name, v.timezone FROM resources r JOIN venues v ON v.id=r.venue_id WHERE r.id=$1 AND r.venue_id=$2 AND r.active', [i.resource_id, i.id]);
    if (!res) throw notFound('Bookable area');
    const a = hhmm(i.start), b = hhmm(i.end);
    if (Number.isNaN(a) || Number.isNaN(b) || a >= b || a >= 1440) throw badRequest('Each booking needs a start before its end (HH:MM)');
    const dates = expandDates(i);
    const items = dates.map((d) => ({ resource_id: i.resource_id, starts_at: fromLocal(d, a, res.timezone).toISOString(), ends_at: fromLocal(d, b, res.timezone).toISOString(), quantity: 1 }));
    return tx(async (c) => {
      const made = await createReservation(c, { user, items, note: `Series: ${i.title}`, collect: true, staff: true, prices: items.map(() => 0) }); // the venue's own hold: nobody owes it
      const failed = new Set(made.problems.filter((p) => p.index != null).map((p) => p.index));
      const placedIdx = items.map((_, k) => k).filter((k) => !failed.has(k));
      const skipped = made.problems.map((p) => ({ date: p.index != null ? dates[p.index] : null, message: p.message, code: p.code }));
      if (!placedIdx.length || (i.on_conflict === 'fail' && made.problems.length)) throw conflict(placedIdx.length ? 'Some dates cannot be held, so nothing was held' : 'None of these dates can be held', { problems: skipped });
      const { start, end, resource_id, title, on_conflict, id: _id, ...pattern } = i;
      const s = (await c.query('INSERT INTO venue_booking_series(venue_id, resource_id, reservation_id, title, start_time, end_time, pattern, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
        [i.id, i.resource_id, made.reservationId, i.title, i.start, i.end, JSON.stringify(pattern), user.id])).rows[0];
      await c.query('UPDATE bookings SET series_id=$1 WHERE id = ANY($2::uuid[])', [s.id, made.lines.map((l) => l.id)]);
      await audit(c, user.id, 'create_booking_series', 'venue_booking_series', s.id);
      return { ...s, held: made.lines.length, skipped };
    });
  },
});

cap({
  name: 'list_booking_series', method: 'GET', path: '/venues/:id/booking-series', tag: TAG,
  summary: 'Venue manager: the venue\'s booking series with how many dates are still ahead, the next date and the area. Ended series only with include_cancelled.',
  input: z.object({ id, include_cancelled: z.coerce.boolean().default(false) }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    return many(
      `SELECT s.*, r.name AS resource_name,
              (SELECT count(*)::int FROM bookings b WHERE b.series_id=s.id AND b.status='confirmed' AND b.starts_at > now()) AS upcoming,
              (SELECT min(b.starts_at) FROM bookings b WHERE b.series_id=s.id AND b.status='confirmed' AND b.starts_at > now()) AS next_at
         FROM venue_booking_series s JOIN resources r ON r.id=s.resource_id WHERE s.venue_id=$1 AND ($2 OR s.status='active') ORDER BY (s.status='cancelled'), next_at NULLS LAST, s.created_at DESC`, [i.id, i.include_cancelled]);
  },
});

cap({
  name: 'cancel_booking_series', method: 'POST', path: '/venue-booking-series/:id/cancel', tag: TAG,
  summary: 'Venue manager: end a series. Every date still ahead is released (the booking rows stay, marked cancelled); dates already played are untouched. Nothing is deleted.',
  input: z.object({ id, reason: z.string().trim().max(200).optional() }),
  async handler({ user }, i) {
    const s = await mustFind('venue_booking_series', i.id);
    await mustManage(user, s.venue_id);
    return tx(async (c) => {
      const locked = (await c.query('SELECT status FROM venue_booking_series WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (locked.status === 'cancelled') throw conflict('That series has already ended');
      const ids = (await c.query("SELECT id FROM bookings WHERE series_id=$1 AND status='confirmed' AND starts_at > now()", [i.id])).rows.map((r) => r.id);
      await cancelBookings(c, ids, { actor: user, byVenue: true, reason: i.reason ?? `Series "${s.title}" ended`, waive: true, silent: true });
      await c.query("UPDATE venue_booking_series SET status='cancelled', cancelled_at=now(), cancelled_by=$2 WHERE id=$1", [i.id, user.id]);
      await audit(c, user.id, 'cancel_booking_series', 'venue_booking_series', i.id);
      return { id: i.id, status: 'cancelled', released: ids.length };
    });
  },
});

// ------------------------------------------------------------------ asset register (on the venue's stock rows)
const CONDITIONS = ['new', 'good', 'fair', 'poor', 'out_of_service'];
const ASSET_CATS = ['equipment', 'apparel', 'nutrition', 'medical', 'merch', 'other'];
const assetFields = {
  name: z.string().trim().min(1).max(80), category: z.enum(ASSET_CATS).default('equipment'), asset_tag: z.string().trim().min(1).max(40).optional(),
  resource_id: id.optional().describe('the area it belongs to'), location: z.string().trim().max(80).optional(), condition: z.enum(CONDITIONS).default('good'),
  serial_no: z.string().trim().max(60).optional(), warranty_until: day.optional(), purchased_on: day.optional(), unit_cost_cents: money.default(0),
};
const assetResource = async (venueId, resourceId) => {
  if (resourceId && !(await one('SELECT 1 FROM resources WHERE id=$1 AND venue_id=$2', [resourceId, venueId]))) throw badRequest('That area belongs to another venue');
};

cap({
  name: 'register_venue_asset', method: 'POST', path: '/venues/:id/assets', tag: TAG, status: 201,
  summary: 'Venue manager: put a piece of equipment on the venue\'s asset register — tag, area, location, condition, serial, warranty, cost. It is a stock row (the same inventory list the front desk uses, list_inventory), not a second inventory; link work orders to it with create_maintenance asset_id. Tags are unique per venue.',
  input: z.object({ id, ...assetFields, quantity: z.number().int().min(1).max(100000).default(1) }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    await assetResource(i.id, i.resource_id);
    try {
      return await one(
        `INSERT INTO inventory_items(owner_id, venue_id, name, category, quantity, unit_cost_cents, resource_id, asset_tag, location, condition, serial_no, warranty_until, purchased_on)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [user.id, i.id, i.name, i.category, i.quantity, i.unit_cost_cents, i.resource_id ?? null, i.asset_tag ?? null, i.location ?? null, i.condition, i.serial_no ?? null, i.warranty_until ?? null, i.purchased_on ?? null]);
    } catch (e) { if (e.code === '23505') throw conflict('Another asset here already has that tag'); throw e; }
  },
});

cap({
  name: 'list_venue_assets', method: 'GET', path: '/venues/:id/assets', tag: TAG,
  summary: 'Venue team: the asset register with area, condition, warranty (`warranty_expiring` within 60 days) and open work orders per asset. Filter by area, condition or text.',
  input: z.object({ id, resource_id: id.optional(), condition: z.enum(CONDITIONS).optional(), q: z.string().max(80).optional(), ...page }),
  async handler({ user }, i) {
    await mustWork(user, i.id);
    return many(
      `SELECT a.*, r.name AS resource_name, (a.warranty_until IS NOT NULL AND a.warranty_until BETWEEN current_date AND current_date + 60) AS warranty_expiring,
              (SELECT count(*)::int FROM venue_maintenance m WHERE m.asset_id=a.id AND m.status IN ('scheduled','in_progress')) AS open_work_orders
         FROM inventory_items a LEFT JOIN resources r ON r.id=a.resource_id
        WHERE a.venue_id=$1 AND a.condition IS NOT NULL AND ($2::uuid IS NULL OR a.resource_id=$2) AND ($3::text IS NULL OR a.condition=$3)
          AND ($4::text IS NULL OR a.name ILIKE '%'||$4||'%' OR a.asset_tag ILIKE '%'||$4||'%' OR a.serial_no ILIKE '%'||$4||'%')
        ORDER BY (a.condition='out_of_service'), a.name LIMIT $5 OFFSET $6`, [i.id, i.resource_id ?? null, i.condition ?? null, i.q ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'update_venue_asset', method: 'PATCH', path: '/venue-assets/:id', tag: TAG,
  summary: 'Venue manager: change an asset\'s details, area, location or condition. Retire it with condition "out_of_service" — assets are never deleted, their work orders keep pointing at them.',
  input: z.object({ id, ...Object.fromEntries(Object.entries(assetFields).filter(([k]) => k !== 'unit_cost_cents').map(([k, v]) => [k, v.optional()])), resource_id: id.nullable().optional(), location: z.string().trim().max(80).nullable().optional() }),
  async handler({ user }, i) {
    const a = await mustFind('inventory_items', i.id, 'id, venue_id, condition');
    if (!a.venue_id || a.condition === null) throw notFound('Asset');
    await mustManage(user, a.venue_id);
    await assetResource(a.venue_id, i.resource_id);
    try { return await patchRow('inventory_items', i.id, i, ['name', 'category', 'asset_tag', 'resource_id', 'location', 'condition', 'serial_no', 'warranty_until', 'purchased_on']); }
    catch (e) { if (e.code === '23505') throw conflict('Another asset here already has that tag'); throw e; }
  },
});

// ------------------------------------------------------------------ preventive maintenance templates
const stepsIn = z.array(z.string().trim().min(1).max(120)).max(40).default([]);
const pmFields = {
  title: z.string().trim().min(2).max(120), resource_id: id.optional(), asset_id: id.optional(), category: z.enum(['general', 'surface', 'lighting', 'equipment', 'plumbing', 'electrical', 'cleaning', 'safety', 'inspection', 'other']).default('inspection'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'), every_days: z.number().int().min(1).max(3650), checklist: stepsIn.describe('steps every job from this template carries'),
};

cap({
  name: 'create_pm_template', method: 'POST', path: '/venues/:id/pm-templates', tag: TAG, status: 201,
  summary: 'Venue manager: schedule preventive maintenance — a recurring inspection or service of an area or asset every N days with a checklist. A work order (kind "preventive", with the checklist) is raised automatically a few days before each due date, once at a time.',
  input: z.object({ id, ...pmFields, first_due_on: day }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    await workOrderRefs(i.id, i);
    await assetResource(i.id, i.resource_id);
    return one('INSERT INTO venue_pm_templates(venue_id, title, resource_id, asset_id, category, priority, every_days, checklist, next_due_on, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [i.id, i.title, i.resource_id ?? null, i.asset_id ?? null, i.category, i.priority, i.every_days, JSON.stringify(i.checklist.map((label) => ({ label, done: false }))), i.first_due_on, user.id]);
  },
});

cap({
  name: 'list_pm_templates', method: 'GET', path: '/venues/:id/pm-templates', tag: TAG,
  summary: 'Venue team: the preventive-maintenance schedule with area/asset names and the next due date. Paused ones only with include_paused.',
  input: z.object({ id, include_paused: z.coerce.boolean().default(false) }),
  async handler({ user }, i) {
    await mustWork(user, i.id);
    return many(
      `SELECT t.*, r.name AS resource_name, a.name AS asset_name FROM venue_pm_templates t LEFT JOIN resources r ON r.id=t.resource_id LEFT JOIN inventory_items a ON a.id=t.asset_id
        WHERE t.venue_id=$1 AND ($2 OR t.active) ORDER BY (NOT t.active), t.next_due_on`, [i.id, i.include_paused]);
  },
});

cap({
  name: 'update_pm_template', method: 'PATCH', path: '/venue-pm-templates/:id', tag: TAG,
  summary: 'Venue manager: change a preventive schedule, move its next due date or pause it (`active: false`). Templates are never deleted; jobs already raised stay.',
  input: z.object({ id, ...Object.fromEntries(Object.entries(pmFields).map(([k, v]) => [k, v.optional()])), next_due_on: day.optional(), active: z.boolean().optional() }),
  async handler({ user }, i) {
    const t = await mustFind('venue_pm_templates', i.id);
    await mustManage(user, t.venue_id);
    await workOrderRefs(t.venue_id, i);
    await assetResource(t.venue_id, i.resource_id);
    const patch = { ...i, ...(i.checklist ? { checklist: JSON.stringify(i.checklist.map((label) => ({ label, done: false }))) } : {}) };
    return patchRow('venue_pm_templates', i.id, patch, ['title', 'resource_id', 'asset_id', 'category', 'priority', 'every_days', 'checklist', 'next_due_on', 'active']);
  },
});

// ------------------------------------------------------------------ incidents
const incOut = (r, { withDetails = false } = {}) => { const { details_enc, ...rest } = r; return withDetails ? { ...rest, details: decryptFields(r, 'venue_incidents', ['details']).details } : { ...rest, has_details: !!details_enc }; };

cap({
  name: 'report_venue_incident', method: 'POST', path: '/venues/:id/incidents', tag: TAG, status: 201,
  summary: 'Venue team (incl. floor staff): log an incident — injury, safety, damage, security — with severity, the area, a short summary and private details (names, injuries) that are encrypted at rest and audit-logged when read. Serious or critical incidents notify the venue managers at once. `raise_work_order` also opens an urgent/high work order for it (damage, safety).',
  input: z.object({
    id, kind: z.enum(['injury', 'safety', 'damage', 'security', 'other']), severity: z.enum(SEVERITY).default('minor'), summary: z.string().trim().min(3).max(200), details: z.string().trim().max(4000).optional(),
    resource_id: id.optional(), occurred_at: when.optional(), involved_user_id: id.optional(), raise_work_order: z.boolean().default(false),
  }),
  async handler({ user }, i) {
    await mustWork(user, i.id);
    await assetResource(i.id, i.resource_id);
    return tx(async (c) => {
      const e = encryptFields(i, 'venue_incidents', ['details']);
      let inc = (await c.query(
        'INSERT INTO venue_incidents(venue_id, resource_id, kind, severity, occurred_at, summary, details_enc, involved_user_id, reported_by) VALUES ($1,$2,$3,$4,coalesce($5::timestamptz, now()),$6,$7,$8,$9) RETURNING *',
        [i.id, i.resource_id ?? null, i.kind, i.severity, i.occurred_at ?? null, i.summary, e.details_enc ?? null, i.involved_user_id ?? null, user.id])).rows[0];
      if (i.raise_work_order) {
        const prio = ['serious', 'critical'].includes(i.severity) ? 'urgent' : i.severity === 'moderate' ? 'high' : 'normal';
        const m = (await c.query("INSERT INTO venue_maintenance(venue_id, resource_id, title, category, priority, created_by, incident_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
          [i.id, i.resource_id ?? null, `Incident: ${i.summary}`.slice(0, 120), i.kind === 'damage' ? 'equipment' : 'safety', prio, user.id, inc.id])).rows[0];
        inc = (await c.query('UPDATE venue_incidents SET maintenance_id=$2 WHERE id=$1 RETURNING *', [inc.id, m.id])).rows[0];
      }
      if (['serious', 'critical'].includes(i.severity)) {
        const v = (await c.query('SELECT name FROM venues WHERE id=$1', [i.id])).rows[0];
        for (const u of await venueTeam(c, i.id)) if (u !== user.id) await notify(c, u, { kind: 'venue_incident', title: `${i.severity} incident at ${v.name}`, body: i.summary, data: { venue_id: i.id, incident_id: inc.id } });
      }
      await audit(c, user.id, 'report_incident', 'venue_incidents', inc.id);
      return incOut(inc);
    });
  },
});

cap({
  name: 'list_venue_incidents', method: 'GET', path: '/venues/:id/incidents', tag: TAG,
  summary: 'Venue managers: every incident (summary, severity, status, area, linked work order). Floor staff see only the ones they reported. Private details are not in the list — open one with get_incident.',
  input: z.object({ id, status: z.enum(['open', 'investigating', 'resolved', 'all']).default('open'), severity: z.enum(SEVERITY).optional(), ...page }),
  async handler({ user }, i) {
    await mustWork(user, i.id);
    const manager = await canManage(user, i.id);
    const rows = await many(
      `SELECT n.*, r.name AS resource_name, u.display_name AS reported_by_name FROM venue_incidents n LEFT JOIN resources r ON r.id=n.resource_id JOIN users u ON u.id=n.reported_by
        WHERE n.venue_id=$1 AND ($2='all' OR ($2='open' AND n.status IN ('open','investigating')) OR n.status=$2) AND ($3::text IS NULL OR n.severity=$3) AND ($4 OR n.reported_by=$5)
        ORDER BY (n.status='resolved'), array_position(ARRAY['critical','serious','moderate','minor'], n.severity), n.occurred_at DESC LIMIT $6 OFFSET $7`,
      [i.id, i.status, i.severity ?? null, manager, user.id, i.limit, i.offset]);
    return rows.map((r) => incOut(r));
  },
});

cap({
  name: 'get_venue_incident', method: 'GET', path: '/venue-incidents/:id', tag: TAG,
  summary: 'One incident with its private details decrypted. Venue managers, or the person who reported it. Reading the details is audit-logged; anyone else gets a 404.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const n = await one('SELECT n.*, r.name AS resource_name FROM venue_incidents n LEFT JOIN resources r ON r.id=n.resource_id WHERE n.id=$1', [i.id]);
    if (!n || !(n.reported_by === user.id || (await canManage(user, n.venue_id)))) throw notFound('Incident');
    if (n.details_enc) await audit(null, user.id, 'read_pii', 'venue_incidents', n.id);
    return incOut(n, { withDetails: true });
  },
});

cap({
  name: 'update_venue_incident', method: 'PATCH', path: '/venue-incidents/:id', tag: TAG,
  summary: 'Venue manager: assign an incident, change its severity, move it to investigating, or resolve it (a resolution note is required). Incidents are never deleted.',
  input: z.object({ id, severity: z.enum(SEVERITY).optional(), status: z.enum(['open', 'investigating', 'resolved']).optional(), assignee_id: id.nullable().optional(), resolution: z.string().trim().min(3).max(1000).optional() }),
  async handler({ user }, i) {
    const n = await mustFind('venue_incidents', i.id);
    await mustManage(user, n.venue_id);
    if (i.assignee_id && !(await roster(n.venue_id, i.assignee_id))) throw badRequest('The assignee is not on this venue\'s team');
    if (n.status === 'resolved' && i.status && i.status !== 'resolved') throw conflict('A resolved incident stays resolved; log a new one if it happens again');
    if (i.status === 'resolved' && !(i.resolution ?? n.resolution)) throw badRequest('Say how it was resolved');
    const resolving = i.status === 'resolved' && n.status !== 'resolved';
    return incOut(await patchRow('venue_incidents', i.id, { ...i, ...(resolving ? { resolved_at: new Date(), resolved_by: user.id } : {}) }, ['severity', 'status', 'assignee_id', 'resolution', 'resolved_at', 'resolved_by']));
  },
});

// ------------------------------------------------------------------ shifts
cap({
  name: 'create_venue_shift', method: 'POST', path: '/venues/:id/shifts', tag: TAG, status: 201,
  summary: 'Venue manager: roster a team member (owner or staff) on a shift with a duty (defaults to theirs). A person cannot hold two overlapping shifts (409). They are told. Cancel with cancel_shift.',
  input: z.object({ id, user_id: id, starts_at: when, ends_at: when, duty: z.enum(DUTIES).optional(), notes: z.string().trim().max(300).optional() }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    if (!(await roster(i.id, i.user_id))) throw badRequest('That person is not on this venue\'s team');
    if (new Date(i.ends_at) <= new Date(i.starts_at)) throw badRequest('The shift must end after it starts');
    if (new Date(i.ends_at) - new Date(i.starts_at) > 24 * 3600_000) throw badRequest('A shift is at most 24 hours');
    return tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`shift:${i.user_id}`]);
      if ((await c.query("SELECT 1 FROM venue_shifts WHERE user_id=$1 AND status IN ('scheduled','clocked_in') AND starts_at < $3 AND ends_at > $2", [i.user_id, i.starts_at, i.ends_at])).rowCount) throw conflict('That person already has a shift at that time');
      const duty = i.duty ?? (await c.query('SELECT duty FROM venue_staff WHERE venue_id=$1 AND user_id=$2 AND removed_at IS NULL', [i.id, i.user_id])).rows[0]?.duty ?? 'general';
      const s = (await c.query('INSERT INTO venue_shifts(venue_id, user_id, duty, starts_at, ends_at, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [i.id, i.user_id, duty, i.starts_at, i.ends_at, i.notes ?? null, user.id])).rows[0];
      if (i.user_id !== user.id) await notify(c, i.user_id, { kind: 'venue_shift', title: 'You have a new shift', body: `${duty} · ${i.starts_at.slice(0, 16).replace('T', ' ')} UTC`, data: { venue_id: i.id, shift_id: s.id } });
      return s;
    });
  },
});

cap({
  name: 'list_venue_shifts', method: 'GET', path: '/venues/:id/shifts', tag: TAG,
  summary: 'The roster. Managers see everyone (filter by person or duty); floor staff see only their own shifts. Includes hours worked for clocked-out shifts. Defaults to now and the next 14 days.',
  input: z.object({ id, from: when.optional(), to: when.optional(), user_id: id.optional(), duty: z.enum(DUTIES).optional(), ...page }),
  async handler({ user }, i) {
    await mustWork(user, i.id);
    const manager = await canManage(user, i.id);
    return many(
      `SELECT s.*, u.display_name, u.handle, CASE WHEN s.clock_out_at IS NOT NULL THEN round(extract(epoch FROM s.clock_out_at - s.clock_in_at)/3600, 2)::float8 END AS hours_worked
         FROM venue_shifts s JOIN users u ON u.id=s.user_id
        WHERE s.venue_id=$1 AND s.ends_at > coalesce($2::timestamptz, now() - interval '1 day') AND s.starts_at < coalesce($3::timestamptz, now() + interval '14 days')
          AND ($4::uuid IS NULL OR s.user_id=$4) AND ($5::text IS NULL OR s.duty=$5) AND ($6 OR s.user_id=$7) ORDER BY s.starts_at, u.display_name LIMIT $8 OFFSET $9`,
      [i.id, i.from ?? null, i.to ?? null, i.user_id ?? null, i.duty ?? null, manager, user.id, i.limit, i.offset]);
  },
});

cap({
  name: 'clock_venue_shift', method: 'POST', path: '/venue-shifts/:id/clock', tag: TAG,
  summary: 'The rostered person clocks in (from 30 minutes before the start, until the shift ends) or out (only after clocking in). Gives the timesheet its real hours.',
  input: z.object({ id, action: z.enum(['in', 'out']) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s = (await c.query('SELECT * FROM venue_shifts WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!s || s.user_id !== user.id) throw notFound('Shift');
      await mustWork(user, s.venue_id, c);
      const now = Date.now();
      if (i.action === 'in') {
        if (s.status !== 'scheduled') throw conflict(`The shift is ${s.status.replace('_', ' ')}`);
        if (now < s.starts_at.getTime() - 30 * 60_000) throw conflict('Too early: clock in opens 30 minutes before the shift');
        if (now >= s.ends_at.getTime()) throw conflict('The shift has ended');
        return (await c.query("UPDATE venue_shifts SET status='clocked_in', clock_in_at=now() WHERE id=$1 RETURNING *", [i.id])).rows[0];
      }
      if (s.status !== 'clocked_in') throw conflict('Clock in first');
      return (await c.query("UPDATE venue_shifts SET status='completed', clock_out_at=now() WHERE id=$1 RETURNING *", [i.id])).rows[0];
    });
  },
});

cap({
  name: 'cancel_venue_shift', method: 'POST', path: '/venue-shifts/:id/cancel', tag: TAG,
  summary: 'Venue manager: cancel a shift that has not been worked (the record stays). The person is told.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const s = await mustFind('venue_shifts', i.id);
    await mustManage(user, s.venue_id);
    if (s.status !== 'scheduled') throw conflict('Only a shift that has not started can be cancelled');
    return tx(async (c) => {
      const r = (await c.query("UPDATE venue_shifts SET status='cancelled' WHERE id=$1 RETURNING *", [i.id])).rows[0];
      if (s.user_id !== user.id) await notify(c, s.user_id, { kind: 'venue_shift', title: 'A shift was cancelled', body: s.starts_at.toISOString().slice(0, 16).replace('T', ' ') + ' UTC', data: { venue_id: s.venue_id, shift_id: s.id } });
      return r;
    });
  },
});

// ------------------------------------------------------------------ readiness checks (per area kind)
/** Checklists per area kind. `critical` items stop the area being "ready". Every kind the catalogue lists has its own native list. */
export const READINESS = {
  court: [['surface_clean', 1], ['lines_visible', 0], ['net_posts_ok', 1], ['lighting_ok', 0], ['no_hazards', 1]],
  ground: [['pitch_surface', 1], ['markings_visible', 0], ['goalposts_safe', 1], ['lighting_ok', 0], ['no_hazards', 1]],
  pool: [['water_quality', 1], ['chemical_levels', 1], ['lifeguard_on_duty', 1], ['rescue_equipment', 1], ['deck_clear', 0], ['lane_ropes', 0]],
  track: [['surface_condition', 1], ['lane_markings', 0], ['lighting_ok', 0], ['no_hazards', 1]],
  room: [['clean_tidy', 0], ['equipment_in_place', 0], ['climate_ok', 0], ['exits_clear', 1]],
  equipment: [['working_order', 1], ['safety_check', 1], ['clean', 0], ['stock_complete', 0]],
};
const template = (kind) => (READINESS[kind] ?? READINESS.room).map(([key, critical]) => ({ key, critical: !!critical, label: key.replace(/_/g, ' ') }));
const RANK = { ready: 0, attention: 1, not_ready: 2 };

/** Area-by-area readiness: the latest check, worsened by open urgent/high work orders and serious incidents on that area. */
export async function readinessBoard(venueId) {
  const rows = await many(
    `SELECT r.id AS resource_id, r.name, r.kind, lc.id AS check_id, lc.status AS check_status, lc.items, lc.checked_at, u.display_name AS checked_by_name,
            (SELECT count(*)::int FROM venue_maintenance m WHERE m.resource_id=r.id AND m.status IN ('scheduled','in_progress')) AS open_work_orders,
            (SELECT count(*)::int FROM venue_maintenance m WHERE m.resource_id=r.id AND m.status IN ('scheduled','in_progress') AND m.priority IN ('urgent','high')) AS blocking_work_orders,
            (SELECT count(*)::int FROM venue_incidents n WHERE n.resource_id=r.id AND n.status <> 'resolved' AND n.severity IN ('serious','critical')) AS blocking_incidents
       FROM resources r
       LEFT JOIN LATERAL (SELECT * FROM venue_readiness_checks k WHERE k.resource_id=r.id ORDER BY k.checked_at DESC LIMIT 1) lc ON true
       LEFT JOIN users u ON u.id=lc.checked_by
      WHERE r.venue_id=$1 AND r.active ORDER BY r.kind, r.name`, [venueId]);
  return rows.map((r) => {
    const stale = !r.checked_at || Date.now() - r.checked_at.getTime() > 24 * 3600_000;
    let status = r.check_status ?? 'unchecked';
    if (r.blocking_incidents) status = 'not_ready';
    else if (r.blocking_work_orders && (RANK[status] ?? -1) < RANK.attention) status = 'attention';
    return { ...r, status, stale, failing: (r.items ?? []).filter((x) => !x.ok).map((x) => x.key), template: template(r.kind) };
  });
}

cap({
  name: 'venue_readiness_board', method: 'GET', path: '/venues/:id/readiness', tag: TAG,
  summary: 'Venue team: is each pitch, court, pool, track, room and equipment area ready to use? Per area: the latest check (who, when, what failed), whether it is stale (older than 24 h or never done), open work orders and serious open incidents that worsen it, and the checklist for its kind. `status`: ready, attention, not_ready or unchecked.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await mustWork(user, i.id);
    const areas = await readinessBoard(i.id);
    const count = (s) => areas.filter((a) => a.status === s).length;
    return { totals: { ready: count('ready'), attention: count('attention'), not_ready: count('not_ready'), unchecked: count('unchecked'), stale: areas.filter((a) => a.stale).length }, areas };
  },
});

cap({
  name: 'record_readiness_check', method: 'POST', path: '/resources/:id/readiness', tag: TAG, status: 201,
  summary: 'Venue team (incl. floor staff): record a readiness check of an area against the checklist for its kind (call venue_readiness_board for the items). Result: ready (all ok), attention (only non-critical items failed) or not_ready (a critical item failed). A failed item may carry a note. `raise_work_order` opens a work order for the failures (urgent when not ready).',
  input: z.object({ id, items: z.array(z.object({ key: z.string().max(40), ok: z.boolean(), note: z.string().trim().max(200).optional() })).min(1).max(30), notes: z.string().trim().max(500).optional(), raise_work_order: z.boolean().default(false) }),
  async handler({ user }, i) {
    const r = await mustFind('resources', i.id, 'id, venue_id, kind, name');
    await mustWork(user, r.venue_id);
    const tpl = new Map(template(r.kind).map((t) => [t.key, t]));
    const seen = new Set(i.items.map((x) => x.key));
    if (i.items.some((x) => !tpl.has(x.key))) throw badRequest(`Unknown checklist item for a ${r.kind}`);
    if ([...tpl.keys()].some((k) => !seen.has(k))) throw badRequest('Answer every checklist item');
    const items = i.items.map((x) => ({ ...x, label: tpl.get(x.key).label, critical: tpl.get(x.key).critical }));
    const failed = items.filter((x) => !x.ok);
    const status = failed.some((x) => x.critical) ? 'not_ready' : failed.length ? 'attention' : 'ready';
    return tx(async (c) => {
      let mid = null;
      if (i.raise_work_order && failed.length) {
        mid = (await c.query("INSERT INTO venue_maintenance(venue_id, resource_id, title, category, priority, created_by, checklist, notes) VALUES ($1,$2,$3,'inspection',$4,$5,$6,$7) RETURNING id",
          [r.venue_id, r.id, `Readiness: ${r.name} — ${failed.map((x) => x.label).join(', ')}`.slice(0, 120), status === 'not_ready' ? 'urgent' : 'normal', user.id, JSON.stringify(failed.map((x) => ({ label: `Fix: ${x.label}`, done: false }))), i.notes ?? null])).rows[0].id;
      }
      const row = (await c.query('INSERT INTO venue_readiness_checks(venue_id, resource_id, status, items, notes, checked_by, maintenance_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [r.venue_id, r.id, status, JSON.stringify(items), i.notes ?? null, user.id, mid])).rows[0];
      return row;
    });
  },
});

// ------------------------------------------------------------------ income reconciliation (reads POS, till and the canonical ledger)
cap({
  name: 'venue_income_reconciliation', method: 'GET', path: '/venues/:id/income', tag: TAG,
  summary: 'Venue manager: reconcile what the venue took, per currency (never summed across currencies), for a date range in venue time (up to 93 days): front-desk (POS) sales and refunds by tender, booking income paid, online tenders that the canonical finance ledger has NOT recorded (`unposted_online`), cash-drawer shifts closed with their variance, and shifts still waiting for a variance review. Read-only over the POS, invoice and finance records — it is not a second ledger.',
  input: z.object({ id, from: day, to: day }).refine((i) => i.to >= i.from, 'to is before from'),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    const v = await mustFind('venues', i.id, 'id, name, timezone, currency');
    const days = (new Date(i.to) - new Date(i.from)) / 86400_000 + 1;
    if (days > 93) throw badRequest('At most 93 days at a time');
    const P = [i.id, fromLocal(i.from, 0, v.timezone), fromLocal(new Date(new Date(i.to).getTime() + 86400_000).toISOString().slice(0, 10), 0, v.timezone)];
    const [tenders, sales, unposted, shifts, bookings, review] = await Promise.all([
      many(`SELECT s.currency, p.method, sum(p.amount_cents) FILTER (WHERE p.kind='payment')::bigint AS taken_cents, coalesce(sum(p.amount_cents) FILTER (WHERE p.kind='refund'),0)::bigint AS refunded_cents
              FROM pos_sale_payments p JOIN pos_sales s ON s.id=p.sale_id WHERE s.venue_id=$1 AND p.status='confirmed' AND p.created_at >= $2 AND p.created_at < $3 GROUP BY 1,2 ORDER BY 1,2`, P),
      many(`SELECT currency, count(*) FILTER (WHERE status='paid')::int AS paid_sales, count(*) FILTER (WHERE status='void')::int AS voided, coalesce(sum(total_cents) FILTER (WHERE status='paid'),0)::bigint AS sales_cents
              FROM pos_sales WHERE venue_id=$1 AND created_at >= $2 AND created_at < $3 GROUP BY 1 ORDER BY 1`, P),
      many(`SELECT s.currency, count(*)::int AS tenders, coalesce(sum(p.amount_cents),0)::bigint AS cents
              FROM pos_sale_payments p JOIN pos_sales s ON s.id=p.sale_id
             WHERE s.venue_id=$1 AND p.kind='payment' AND p.method='online' AND p.status='confirmed' AND p.created_at >= $2 AND p.created_at < $3
               AND NOT EXISTS (SELECT 1 FROM fin_transactions f WHERE f.payment_id=p.payment_id AND f.kind='payment') GROUP BY 1 ORDER BY 1`, P),
      many(`SELECT count(*)::int AS closed, coalesce(sum(variance_cents),0)::bigint AS variance_cents, coalesce(sum(expected_cash_cents),0)::bigint AS expected_cents, coalesce(sum(counted_cash_cents),0)::bigint AS counted_cents
              FROM pos_shifts WHERE venue_id=$1 AND status='closed' AND closed_at >= $2 AND closed_at < $3`, P),
      many(`SELECT v.currency, coalesce(sum(b.payable_cents) FILTER (WHERE b.payment_status='paid'),0)::bigint AS paid_cents, coalesce(sum(b.payable_cents) FILTER (WHERE b.payment_status='unpaid' AND b.status IN ('confirmed','no_show')),0)::bigint AS outstanding_cents
              FROM bookings b JOIN resources r ON r.id=b.resource_id JOIN venues v ON v.id=r.venue_id WHERE r.venue_id=$1 AND b.starts_at >= $2 AND b.starts_at < $3 GROUP BY 1`, P),
      one("SELECT count(*)::int AS n FROM pos_shifts WHERE venue_id=$1 AND status='closed' AND review_status='pending'", [i.id]),
    ]);
    const cur = new Set([v.currency, ...tenders.map((t) => t.currency), ...sales.map((s) => s.currency), ...bookings.map((b) => b.currency)]);
    const by = (rows, c) => rows.find((r) => r.currency === c);
    const currencies = [...cur].sort().map((c) => {
      const t = tenders.filter((x) => x.currency === c);
      const taken = t.reduce((s, x) => s + Number(x.taken_cents ?? 0), 0), refunded = t.reduce((s, x) => s + Number(x.refunded_cents), 0);
      return {
        currency: c, pos: { ...(by(sales, c) ?? { paid_sales: 0, voided: 0, sales_cents: 0 }), taken_cents: taken, refunded_cents: refunded, net_cents: taken - refunded, by_tender: t.map(({ method, taken_cents, refunded_cents }) => ({ method, taken_cents: Number(taken_cents ?? 0), refunded_cents: Number(refunded_cents) })) },
        bookings: by(bookings, c) ?? { paid_cents: 0, outstanding_cents: 0 }, unposted_online: by(unposted, c) ?? { tenders: 0, cents: 0 },
      };
    });
    const exceptions = unposted.reduce((s, x) => s + x.tenders, 0) + review.n + (Number(shifts[0].variance_cents) !== 0 ? 1 : 0);
    return { venue_id: i.id, from: i.from, to: i.to, timezone: v.timezone, currencies, till: { ...shifts[0], pending_review: review.n }, exceptions };
  },
});

// ------------------------------------------------------------------ multi-venue command dashboard
const MANAGED = `SELECT v.id FROM venues v WHERE v.owner_id=$1
  UNION SELECT venue_id FROM venue_staff WHERE user_id=$1 AND removed_at IS NULL AND role='manager'
  UNION SELECT v.id FROM venues v JOIN organisations o ON o.id=v.organisation_id AND o.status='active' JOIN organisation_members m ON m.organisation_id=o.id AND m.status='active' AND m.role IN ('owner','admin') WHERE m.user_id=$1`;

cap({
  name: 'venue_network', method: 'GET', path: '/venue-network', tag: TAG,
  summary: 'Multi-location command dashboard for an operator: every venue you manage (owner, manager staff, organisation admin) with utilisation and revenue for the range (default last 30 days, from venue_report — the same numbers), open and overdue maintenance, open incidents, areas not ready, today\'s check-ins, people on shift now and POS exceptions. Totals are per currency, never mixed.',
  input: z.object({ from: day.optional(), to: day.optional(), limit: z.coerce.number().int().min(1).max(50).default(30) }),
  async handler({ user }, i) {
    const to = i.to ?? new Date().toISOString().slice(0, 10);
    const from = i.from ?? new Date(new Date(to).getTime() - 29 * 86400_000).toISOString().slice(0, 10);
    if (to < from) throw badRequest('to is before from');
    const ids = (await many(`SELECT x.id FROM (${MANAGED}) x JOIN venues v ON v.id=x.id ORDER BY v.name LIMIT $2`, [user.id, i.limit])).map((r) => r.id);
    const report = capabilities.find((c) => c.name === 'venue_report').handler;
    const venues = [];
    for (const vid of ids) {
      const [v, m, inc, ck, shift, pos, board, rep] = await Promise.all([
        one('SELECT id, name, city, currency, timezone FROM venues WHERE id=$1', [vid]),
        one("SELECT count(*) FILTER (WHERE status IN ('scheduled','in_progress'))::int AS open, count(*) FILTER (WHERE status IN ('scheduled','in_progress') AND due_on < current_date)::int AS overdue, count(*) FILTER (WHERE status IN ('scheduled','in_progress') AND priority='urgent')::int AS urgent FROM venue_maintenance WHERE venue_id=$1", [vid]),
        one("SELECT count(*) FILTER (WHERE status <> 'resolved')::int AS open, count(*) FILTER (WHERE status <> 'resolved' AND severity IN ('serious','critical'))::int AS serious FROM venue_incidents WHERE venue_id=$1", [vid]),
        one("SELECT count(*) FILTER (WHERE verdict IN ('granted','recorded'))::int AS today, count(*) FILTER (WHERE verdict='denied')::int AS denied FROM access_captures k JOIN venues v ON v.id=k.venue_id WHERE k.venue_id=$1 AND k.domain='venue_access' AND k.direction='in' AND k.received_at >= date_trunc('day', now() AT TIME ZONE v.timezone) AT TIME ZONE v.timezone", [vid]),
        one("SELECT count(*)::int AS on_shift FROM venue_shifts WHERE venue_id=$1 AND status='clocked_in'", [vid]),
        one("SELECT (SELECT count(*)::int FROM pos_shifts WHERE venue_id=$1 AND status='closed' AND review_status='pending') AS pending_review", [vid]),
        readinessBoard(vid),
        report({ user }, { id: vid, from, to, group_by: 'month' }),
      ]);
      venues.push({
        ...v, utilisation: rep.summary.utilisation, bookings: rep.summary.bookings, revenue_cents: rep.summary.revenue_cents, outstanding_cents: rep.summary.outstanding_cents,
        maintenance: m, incidents: inc, check_ins: ck, on_shift: shift.on_shift, pos_pending_review: pos.pending_review,
        readiness: { not_ready: board.filter((a) => a.status === 'not_ready').length, attention: board.filter((a) => a.status === 'attention').length, unchecked: board.filter((a) => a.status === 'unchecked').length, areas: board.length },
      });
    }
    const totals = {};
    for (const v of venues) {
      const t = (totals[v.currency] ??= { currency: v.currency, venues: 0, revenue_cents: 0, outstanding_cents: 0, bookings: 0 });
      t.venues++; t.revenue_cents += v.revenue_cents; t.outstanding_cents += v.outstanding_cents; t.bookings += v.bookings;
    }
    const sum = (f) => venues.reduce((s, v) => s + f(v), 0);
    return {
      from, to, venues, totals: Object.values(totals),
      attention: { maintenance_overdue: sum((v) => v.maintenance.overdue), urgent_work_orders: sum((v) => v.maintenance.urgent), serious_incidents: sum((v) => v.incidents.serious), areas_not_ready: sum((v) => v.readiness.not_ready), pos_pending_review: sum((v) => v.pos_pending_review) },
    };
  },
});
