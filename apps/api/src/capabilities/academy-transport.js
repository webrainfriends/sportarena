// Academy daily transport: school runs, training commutes and event shuttles.
// Routes → stops → vehicles → schedules → guardian bookings → boarding check-ins → operator invoices.
// Reuses academy-suppliers.js (transport kind) for operator identity; never duplicates trips-bookings.js.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { encryptFields, decryptFields } from '../crypto.js';
import { opsAccess } from '../academy-ops.js';
import { isSupportedCurrency } from '../currency.js';

const TAG = 'Academy transport';
const short = (n) => z.string().trim().min(1).max(n);
const KINDS = ['school_run', 'training_commute', 'event_shuttle', 'other'];
const DIRECTIONS = ['outbound', 'return', 'both'];
const EVENTS = ['boarded', 'alighted', 'no_show', 'refused'];

async function transportAccess(user, orgId, write, c) {
  const a = await opsAccess(user, orgId, { write, c });
  if (write && !a.has('suppliers')) throw forbidden('You need the suppliers permission to manage transport routes');
  if (!write && !(a.has('suppliers') || a.has('schedule') || a.has('attendance'))) throw forbidden('You need schedule, attendance or suppliers access to view transport');
  return a;
}

async function ownRoute(c, routeId, orgId) {
  const r = (await c.query('SELECT * FROM academy_transport_routes WHERE id=$1', [routeId])).rows[0];
  if (!r) throw notFound('Route');
  if (orgId && r.organisation_id !== orgId) throw notFound('Route');
  return r;
}

async function ownSchedule(c, scheduleId) {
  const s = (await c.query('SELECT s.*, r.organisation_id FROM academy_route_schedules s JOIN academy_transport_routes r ON r.id=s.route_id WHERE s.id=$1', [scheduleId])).rows[0];
  if (!s) throw notFound('Schedule');
  return s;
}

const decryptRoute = (r) => ({ ...r, notes: r.notes_enc ? decryptFields(r, 'academy_transport_routes', ['notes']).notes : null, notes_enc: undefined });
const decryptStop = (r) => ({ ...r, address: r.address_enc ? decryptFields(r, 'academy_transport_stops', ['address']).address : null, address_enc: undefined });
const decryptVehicle = (r) => {
  const d = decryptFields(r, 'academy_transport_vehicles', ['registration', 'driver_name', 'driver_phone']);
  return { ...r, registration: d.registration ?? null, driver_name: d.driver_name ?? null, driver_phone: d.driver_phone ?? null, registration_enc: undefined, driver_name_enc: undefined, driver_phone_enc: undefined };
};

cap({
  name: 'create_academy_transport_route', method: 'POST', path: '/organisations/:id/academy/transport/routes', tag: TAG, status: 201,
  summary: 'Create a named daily transport route (school run, training commute, event shuttle) for an academy. Link to an existing transport supplier or enter an operator name. Needs the suppliers permission.',
  input: z.object({ id, name: short(120), kind: z.enum(KINDS), direction: z.enum(DIRECTIONS).default('both'), supplier_id: id.optional(), operator_name: z.string().trim().max(120).optional(), notes: z.string().trim().max(2000).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    await transportAccess(user, i.id, true, c);
    if (i.supplier_id) {
      const s = (await c.query('SELECT kind FROM academy_suppliers WHERE id=$1 AND organisation_id=$2', [i.supplier_id, i.id])).rows[0];
      if (!s) throw notFound('Supplier');
      if (s.kind !== 'transport') throw badRequest('Supplier must be of kind transport');
    }
    const e = i.notes ? encryptFields({ notes: i.notes }, 'academy_transport_routes', ['notes']) : {};
    const r = (await c.query(
      `INSERT INTO academy_transport_routes(organisation_id, name, kind, direction, supplier_id, operator_name, notes_enc, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [i.id, i.name, i.kind, i.direction, i.supplier_id ?? null, i.operator_name ?? null, e.notes_enc ?? null, user.id]
    )).rows[0];
    await audit(c, user.id, 'create_academy_transport_route', 'academy_transport_routes', r.id);
    return decryptRoute(r);
  }),
});

cap({
  name: 'list_academy_transport_routes', method: 'GET', path: '/organisations/:id/academy/transport/routes', tag: TAG,
  summary: 'List transport routes for an academy with stop count, active schedule count and operator. Filter by status or kind.',
  input: z.object({ id, status: z.enum(['active', 'paused', 'archived']).optional(), kind: z.enum(KINDS).optional() }),
  handler: async ({ user }, i) => {
    await transportAccess(user, i.id, false);
    return many(
      `SELECT r.id, r.name, r.kind, r.direction, r.operator_name, r.status, r.row_version, r.created_at, r.updated_at,
              s.name AS supplier_name,
              (SELECT count(*)::int FROM academy_transport_stops WHERE route_id=r.id) AS stop_count,
              (SELECT count(*)::int FROM academy_route_schedules WHERE route_id=r.id AND status='active') AS active_schedules
         FROM academy_transport_routes r LEFT JOIN academy_suppliers s ON s.id=r.supplier_id
        WHERE r.organisation_id=$1
          AND ($2::text IS NULL OR r.kind=$2)
          AND ($3::text IS NOT NULL OR r.status <> 'archived')
          AND ($3::text IS NULL OR r.status=$3)
        ORDER BY r.name LIMIT 200`,
      [i.id, i.kind ?? null, i.status ?? null]
    );
  },
});

cap({
  name: 'get_academy_transport_route', method: 'GET', path: '/academy/transport/routes/:id', tag: TAG,
  summary: 'Full route with stops (addresses decrypted for suppliers permission), vehicles and upcoming schedules (next 14 days).',
  input: z.object({ id }),
  handler: async ({ user }, i) => {
    const c = pool;
    const route = (await c.query('SELECT r.*, s.name AS supplier_name FROM academy_transport_routes r LEFT JOIN academy_suppliers s ON s.id=r.supplier_id WHERE r.id=$1', [i.id])).rows[0];
    if (!route) throw notFound('Route');
    const a = await transportAccess(user, route.organisation_id, false);
    const stops = (await c.query('SELECT * FROM academy_transport_stops WHERE route_id=$1 ORDER BY sequence', [i.id])).rows;
    const vehicles = (await c.query('SELECT * FROM academy_transport_vehicles WHERE route_id=$1 ORDER BY valid_from DESC', [i.id])).rows;
    const schedules = (await c.query(
      `SELECT s.*, v.capacity, v.description AS vehicle_description
         FROM academy_route_schedules s LEFT JOIN academy_transport_vehicles v ON v.id=s.vehicle_id
        WHERE s.route_id=$1 AND s.status='active'
          AND (s.schedule_date IS NULL OR s.schedule_date >= CURRENT_DATE)
        ORDER BY s.schedule_date NULLS LAST LIMIT 30`, [i.id]
    )).rows;
    if (a.has('suppliers')) await audit(c, user.id, 'read_academy_transport_route', 'academy_transport_routes', i.id);
    return {
      ...decryptRoute(route),
      stops: stops.map(a.has('suppliers') ? decryptStop : (r) => ({ ...r, address_enc: undefined, address: null })),
      vehicles: vehicles.map(a.has('suppliers') ? decryptVehicle : (r) => ({ ...r, registration_enc: undefined, driver_name_enc: undefined, driver_phone_enc: undefined })),
      schedules,
    };
  },
});

cap({
  name: 'update_academy_transport_route', method: 'PATCH', path: '/academy/transport/routes/:id', tag: TAG,
  summary: 'Edit a transport route name, kind, direction, supplier link, operator name or status. Send row_version; a stale one is a 409.',
  input: z.object({ id, row_version: z.number().int(), name: short(120).optional(), kind: z.enum(KINDS).optional(), direction: z.enum(DIRECTIONS).optional(), supplier_id: id.nullable().optional(), operator_name: z.string().trim().max(120).nullable().optional(), notes: z.string().trim().max(2000).nullable().optional(), status: z.enum(['active', 'paused', 'archived']).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const cur = (await c.query('SELECT * FROM academy_transport_routes WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!cur) throw notFound('Route');
    await transportAccess(user, cur.organisation_id, true, c);
    if (cur.row_version !== i.row_version) throw conflict('Route was changed by someone else. Reload and try again.', { row_version: cur.row_version });
    if (i.supplier_id) {
      const s = (await c.query('SELECT kind FROM academy_suppliers WHERE id=$1 AND organisation_id=$2', [i.supplier_id, cur.organisation_id])).rows[0];
      if (!s) throw notFound('Supplier');
      if (s.kind !== 'transport') throw badRequest('Supplier must be of kind transport');
    }
    const e = i.notes !== undefined ? encryptFields({ notes: i.notes ?? '' }, 'academy_transport_routes', ['notes']) : {};
    const pick = (k) => (i[k] === undefined ? cur[k] : i[k]);
    const r = (await c.query(
      `UPDATE academy_transport_routes SET name=$2, kind=$3, direction=$4, supplier_id=$5, operator_name=$6, notes_enc=$7, status=$8, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`,
      [cur.id, pick('name'), pick('kind'), pick('direction'), i.supplier_id !== undefined ? (i.supplier_id ?? null) : cur.supplier_id, i.operator_name !== undefined ? (i.operator_name ?? null) : cur.operator_name, i.notes !== undefined ? (e.notes_enc ?? null) : cur.notes_enc, pick('status')]
    )).rows[0];
    await audit(c, user.id, 'update_academy_transport_route', 'academy_transport_routes', r.id);
    return decryptRoute(r);
  }),
});

cap({
  name: 'add_transport_stop', method: 'POST', path: '/academy/transport/routes/:id/stops', tag: TAG, status: 201,
  summary: 'Add a stop to a transport route at a given sequence position. Existing stops at or above that sequence shift up. Address is encrypted at rest. GPS sharing requires explicit opt-in.',
  input: z.object({ id, sequence: z.number().int().min(1).max(100), name: short(120), address: z.string().trim().max(300).optional(), gps_allowed: z.boolean().default(false), lat: z.number().optional(), lng: z.number().optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const route = await ownRoute(c, i.id, null);
    await transportAccess(user, route.organisation_id, true, c);
    await c.query('UPDATE academy_transport_stops SET sequence=sequence+1 WHERE route_id=$1 AND sequence>=$2', [i.id, i.sequence]);
    const e = i.address ? encryptFields({ address: i.address }, 'academy_transport_stops', ['address']) : {};
    const lat = i.gps_allowed ? (i.lat ?? null) : null;
    const lng = i.gps_allowed ? (i.lng ?? null) : null;
    const r = (await c.query(
      `INSERT INTO academy_transport_stops(route_id, sequence, name, address_enc, gps_allowed, lat, lng) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [i.id, i.sequence, i.name, e.address_enc ?? null, i.gps_allowed, lat, lng]
    )).rows[0];
    await audit(c, user.id, 'add_transport_stop', 'academy_transport_stops', r.id);
    return decryptStop(r);
  }),
});

cap({
  name: 'update_transport_stop', method: 'PATCH', path: '/academy/transport/stops/:id', tag: TAG,
  summary: 'Edit a stop name, address, sequence or GPS setting. Turning GPS off clears stored coordinates.',
  input: z.object({ id, sequence: z.number().int().min(1).max(100).optional(), name: short(120).optional(), address: z.string().trim().max(300).nullable().optional(), gps_allowed: z.boolean().optional(), lat: z.number().nullable().optional(), lng: z.number().nullable().optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const cur = (await c.query('SELECT s.*, r.organisation_id FROM academy_transport_stops s JOIN academy_transport_routes r ON r.id=s.route_id WHERE s.id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!cur) throw notFound('Stop');
    await transportAccess(user, cur.organisation_id, true, c);
    const gpsAllowed = i.gps_allowed !== undefined ? i.gps_allowed : cur.gps_allowed;
    const lat = gpsAllowed ? (i.lat !== undefined ? i.lat : cur.lat) : null;
    const lng = gpsAllowed ? (i.lng !== undefined ? i.lng : cur.lng) : null;
    const e = i.address !== undefined ? encryptFields({ address: i.address ?? '' }, 'academy_transport_stops', ['address']) : {};
    const r = (await c.query(
      `UPDATE academy_transport_stops SET sequence=$2, name=$3, address_enc=$4, gps_allowed=$5, lat=$6, lng=$7 WHERE id=$1 RETURNING *`,
      [cur.id, i.sequence ?? cur.sequence, i.name ?? cur.name, i.address !== undefined ? (e.address_enc ?? null) : cur.address_enc, gpsAllowed, lat, lng]
    )).rows[0];
    await audit(c, user.id, 'update_transport_stop', 'academy_transport_stops', r.id);
    return decryptStop(r);
  }),
});

cap({
  name: 'add_transport_vehicle', method: 'POST', path: '/academy/transport/routes/:id/vehicles', tag: TAG, status: 201,
  summary: 'Assign a vehicle to a route with driver, escort and capacity. Registration and driver details are encrypted at rest.',
  input: z.object({
    id, registration: z.string().trim().max(20).optional(), description: z.string().trim().max(200).optional(),
    capacity: z.number().int().min(1).max(500), driver_id: id.optional(), driver_name: z.string().trim().max(120).optional(),
    driver_phone: z.string().trim().max(40).optional(), escort_id: id.optional(),
    valid_from: z.string().date().default(() => new Date().toISOString().slice(0, 10)),
    valid_until: z.string().date().optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const route = await ownRoute(c, i.id, null);
    await transportAccess(user, route.organisation_id, true, c);
    const e = encryptFields({ registration: i.registration, driver_name: i.driver_name, driver_phone: i.driver_phone }, 'academy_transport_vehicles', ['registration', 'driver_name', 'driver_phone']);
    const r = (await c.query(
      `INSERT INTO academy_transport_vehicles(route_id, registration_enc, description, capacity, driver_id, driver_name_enc, driver_phone_enc, escort_id, valid_from, valid_until)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [i.id, e.registration_enc ?? null, i.description ?? null, i.capacity, i.driver_id ?? null, e.driver_name_enc ?? null, e.driver_phone_enc ?? null, i.escort_id ?? null, i.valid_from, i.valid_until ?? null]
    )).rows[0];
    await audit(c, user.id, 'add_transport_vehicle', 'academy_transport_vehicles', r.id);
    return decryptVehicle(r);
  }),
});

cap({
  name: 'create_route_schedule', method: 'POST', path: '/academy/transport/routes/:id/schedules', tag: TAG, status: 201,
  summary: 'Attach a route to a session, cohort or recurring timetable. Set outbound and return departure times and optional seat limit. Needs schedule permission.',
  input: z.object({
    id, session_id: id.optional(), cohort_id: id.optional(),
    recurrence: z.array(z.string().regex(/^[1-7]$/)).max(7).default([]),
    outbound_depart_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    return_depart_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    schedule_date: z.string().date().optional(),
    vehicle_id: id.optional(), seats_total: z.number().int().min(1).max(500).optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const route = await ownRoute(c, i.id, null);
    const a = await opsAccess(user, route.organisation_id, { write: true, c });
    if (!a.has('schedule') && !a.has('suppliers')) throw forbidden('You need the schedule or suppliers permission to create transport schedules');
    if (i.vehicle_id) {
      const v = (await c.query('SELECT id FROM academy_transport_vehicles WHERE id=$1 AND route_id=$2', [i.vehicle_id, i.id])).rows[0];
      if (!v) throw notFound('Vehicle');
    }
    const r = (await c.query(
      `INSERT INTO academy_route_schedules(route_id, session_id, cohort_id, recurrence, outbound_depart_time, return_depart_time, schedule_date, vehicle_id, seats_total, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [i.id, i.session_id ?? null, i.cohort_id ?? null, i.recurrence, i.outbound_depart_time ?? null, i.return_depart_time ?? null, i.schedule_date ?? null, i.vehicle_id ?? null, i.seats_total ?? null, user.id]
    )).rows[0];
    await audit(c, user.id, 'create_route_schedule', 'academy_route_schedules', r.id);
    return r;
  }),
});

cap({
  name: 'get_route_boarding_board', method: 'GET', path: '/academy/transport/schedules/:id/board', tag: TAG,
  summary: 'Mobile boarding manifest for a schedule: athletes expected at each stop with approval status and latest check-in event. Used by drivers and escorts.',
  input: z.object({ id }),
  handler: async ({ user }, i) => {
    const sched = await ownSchedule(pool, i.id);
    await transportAccess(user, sched.organisation_id, false);
    const route = (await pool.query('SELECT * FROM academy_transport_routes WHERE id=$1', [sched.route_id])).rows[0];
    const stops = (await pool.query('SELECT id, sequence, name, gps_allowed FROM academy_transport_stops WHERE route_id=$1 ORDER BY sequence', [sched.route_id])).rows;
    const athletes = (await pool.query(
      `SELECT b.id AS booking_id, b.athlete_id, b.stop_id, b.direction, b.approved_at,
              u.display_name,
              ci.event AS latest_check_in_event, ci.recorded_at AS latest_check_in_recorded_at
         FROM academy_transport_bookings b
         JOIN users u ON u.id=b.athlete_id
         LEFT JOIN LATERAL (
           SELECT event, recorded_at FROM academy_transport_check_ins
            WHERE schedule_id=$1 AND athlete_id=b.athlete_id ORDER BY recorded_at DESC LIMIT 1
         ) ci ON true
        WHERE b.schedule_id=$1 AND b.revoked_at IS NULL
        ORDER BY u.display_name`,
      [i.id]
    )).rows;
    const stopMap = Object.fromEntries(stops.map((s) => [s.id, s.name]));
    await audit(pool, user.id, 'read_transport_boarding_board', 'academy_route_schedules', i.id);
    return {
      schedule: sched,
      route: { id: route.id, name: route.name, kind: route.kind, direction: route.direction },
      stops,
      athletes: athletes.map((a) => ({ ...a, stop_name: a.stop_id ? (stopMap[a.stop_id] ?? null) : null })),
    };
  },
});

cap({
  name: 'approve_transport_booking', method: 'POST', path: '/academy/transport/schedules/:id/bookings', tag: TAG, status: 201,
  summary: 'Guardian (or staff with schedule/safeguarding permission) approves an athlete for a transport schedule at a stop and direction. Idempotent: re-approving a revoked booking reinstates it.',
  input: z.object({ id, athlete_id: id, stop_id: id.optional(), direction: z.enum(DIRECTIONS).default('both'), notes: z.string().trim().max(500).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const sched = await ownSchedule(c, i.id);
    const a = await opsAccess(user, sched.organisation_id, { write: false, c });
    const isAdmin = a.admin || a.role === 'owner';
    const hasStaffPerm = a.has('schedule') || a.has('safeguarding') || a.has('suppliers');
    if (!isAdmin && !hasStaffPerm) {
      const link = (await c.query(
        `SELECT id FROM guardian_links WHERE guardian_id=$1 AND child_id=$2 AND decision='approved' AND revoked_at IS NULL LIMIT 1`,
        [user.id, i.athlete_id]
      )).rows[0];
      if (!link && user.id !== i.athlete_id) throw forbidden('You must be a verified guardian of this athlete to approve transport');
    }
    const e = i.notes ? encryptFields({ notes: i.notes }, 'academy_transport_bookings', ['notes']) : {};
    const r = (await c.query(
      `INSERT INTO academy_transport_bookings(schedule_id, athlete_id, stop_id, direction, approved_by, approved_at, notes_enc)
       VALUES ($1,$2,$3,$4,$5,now(),$6)
       ON CONFLICT (schedule_id, athlete_id, direction) DO UPDATE
         SET revoked_at=NULL, revoked_by=NULL, approved_by=$5, approved_at=now(), notes_enc=$6
       RETURNING *`,
      [i.id, i.athlete_id, i.stop_id ?? null, i.direction, user.id, e.notes_enc ?? null]
    )).rows[0];
    await audit(c, user.id, 'approve_transport_booking', 'academy_transport_bookings', r.id);
    return r;
  }),
});

cap({
  name: 'revoke_transport_booking', method: 'DELETE', path: '/academy/transport/bookings/:id', tag: TAG,
  summary: 'Guardian or staff revokes transport approval for an athlete. The booking row is kept (soft delete).',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const b = (await c.query('SELECT b.*, s.route_id FROM academy_transport_bookings b JOIN academy_route_schedules s ON s.id=b.schedule_id WHERE b.id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!b) throw notFound('Booking');
    const route = (await c.query('SELECT organisation_id FROM academy_transport_routes WHERE id=$1', [b.route_id])).rows[0];
    const a = await opsAccess(user, route.organisation_id, { write: false, c });
    const isAdmin = a.admin || a.role === 'owner';
    const hasStaffPerm = a.has('schedule') || a.has('safeguarding') || a.has('suppliers');
    if (!isAdmin && !hasStaffPerm) {
      const link = (await c.query(
        `SELECT id FROM guardian_links WHERE guardian_id=$1 AND child_id=$2 AND decision='approved' AND revoked_at IS NULL LIMIT 1`,
        [user.id, b.athlete_id]
      )).rows[0];
      if (!link && user.id !== b.athlete_id) throw forbidden('You must be a verified guardian of this athlete to revoke transport');
    }
    if (b.revoked_at) return { id: b.id, already_revoked: true };
    const r = (await c.query('UPDATE academy_transport_bookings SET revoked_at=now(), revoked_by=$2 WHERE id=$1 RETURNING *', [i.id, user.id])).rows[0];
    await audit(c, user.id, 'revoke_transport_booking', 'academy_transport_bookings', r.id);
    return r;
  }),
});

cap({
  name: 'record_transport_check_in', method: 'POST', path: '/academy/transport/schedules/:id/checkin', tag: TAG,
  summary: 'Record a boarding, alighting, no-show or refused check-in for an athlete at a stop. Idempotent by idempotency_key; safe for offline replay.',
  input: z.object({
    id, athlete_id: id, stop_id: id, direction: z.enum(['outbound', 'return']), event: z.enum(EVENTS),
    idempotency_key: z.string().max(80), offline: z.boolean().default(false),
    captured_at: z.string().datetime().optional(), notes: z.string().trim().max(500).optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const sched = await ownSchedule(c, i.id);
    const a = await opsAccess(user, sched.organisation_id, { write: false, c });
    if (!a.has('schedule') && !a.has('attendance') && !a.admin && a.role !== 'owner') throw forbidden('You need schedule or attendance permission to record check-ins');
    const e = i.notes ? encryptFields({ notes: i.notes }, 'academy_transport_check_ins', ['notes']) : {};
    const existing = (await c.query('SELECT * FROM academy_transport_check_ins WHERE idempotency_key=$1', [i.idempotency_key])).rows[0];
    if (existing) return { ...existing, already_recorded: true };
    const r = (await c.query(
      `INSERT INTO academy_transport_check_ins(schedule_id, athlete_id, stop_id, direction, event, recorded_by, offline, captured_at, idempotency_key, notes_enc)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [i.id, i.athlete_id, i.stop_id, i.direction, i.event, user.id, i.offline, i.captured_at ?? null, i.idempotency_key, e.notes_enc ?? null]
    )).rows[0];
    return r;
  }),
});

cap({
  name: 'sync_transport_check_ins', method: 'POST', path: '/academy/transport/checkins/sync', tag: TAG,
  summary: 'Batch-sync up to 50 offline boarding check-ins. Each item is inserted idempotently; already-synced items are counted separately. Used by drivers after connectivity is restored.',
  input: z.object({
    items: z.array(z.object({
      schedule_id: id, athlete_id: id, stop_id: id,
      direction: z.enum(['outbound', 'return']), event: z.enum(EVENTS),
      idempotency_key: z.string().max(80), captured_at: z.string().datetime(),
      notes: z.string().trim().max(500).optional(),
    })).max(50),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    let synced = 0, already_synced = 0;
    const rejected = [];
    for (const item of i.items) {
      try {
        const sched = (await c.query(
          'SELECT s.id, r.organisation_id FROM academy_route_schedules s JOIN academy_transport_routes r ON r.id=s.route_id WHERE s.id=$1',
          [item.schedule_id]
        )).rows[0];
        if (!sched) { rejected.push({ idempotency_key: item.idempotency_key, reason: 'schedule_not_found' }); continue; }
        const a = await opsAccess(user, sched.organisation_id, { write: false, c });
        if (!a.has('schedule') && !a.has('attendance') && !a.admin && a.role !== 'owner') {
          rejected.push({ idempotency_key: item.idempotency_key, reason: 'forbidden' }); continue;
        }
        const existing = (await c.query('SELECT id FROM academy_transport_check_ins WHERE idempotency_key=$1', [item.idempotency_key])).rows[0];
        if (existing) { already_synced++; continue; }
        const e = item.notes ? encryptFields({ notes: item.notes }, 'academy_transport_check_ins', ['notes']) : {};
        await c.query(
          `INSERT INTO academy_transport_check_ins(schedule_id, athlete_id, stop_id, direction, event, recorded_by, offline, captured_at, idempotency_key, notes_enc)
           VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,$9)`,
          [item.schedule_id, item.athlete_id, item.stop_id, item.direction, item.event, user.id, item.captured_at, item.idempotency_key, e.notes_enc ?? null]
        );
        synced++;
      } catch (err) {
        rejected.push({ idempotency_key: item.idempotency_key, reason: err.message ?? 'error' });
      }
    }
    return { synced, already_synced, rejected };
  }),
});

cap({
  name: 'get_transport_overview', method: 'GET', path: '/organisations/:id/academy/transport', tag: TAG,
  summary: "Today's transport summary: routes with schedules running today, boarded/total/no-shows and unapproved athletes.",
  input: z.object({ id, date: z.string().date().optional() }),
  handler: async ({ user }, i) => {
    await transportAccess(user, i.id, false);
    const date = i.date ?? new Date().toISOString().slice(0, 10);
    const dow = String(((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7) + 1);
    const rows = await pool.query(
      `SELECT r.id AS route_id, r.name, r.kind,
              s.id AS schedule_id, s.outbound_depart_time, s.return_depart_time,
              (SELECT count(*)::int FROM academy_transport_bookings WHERE schedule_id=s.id AND revoked_at IS NULL) AS total,
              (SELECT count(*)::int FROM academy_transport_check_ins WHERE schedule_id=s.id AND event='boarded') AS boarded,
              (SELECT count(*)::int FROM academy_transport_check_ins WHERE schedule_id=s.id AND event='no_show') AS no_shows,
              (SELECT count(*)::int FROM academy_transport_bookings WHERE schedule_id=s.id AND revoked_at IS NULL AND approved_at IS NULL) AS unapproved
         FROM academy_transport_routes r
         JOIN academy_route_schedules s ON s.route_id=r.id
        WHERE r.organisation_id=$1 AND s.status='active'
          AND ($2 = ANY(s.recurrence) OR s.schedule_date=$3)
        ORDER BY r.name, s.outbound_depart_time NULLS LAST`,
      [i.id, dow, date]
    );
    const routeMap = new Map();
    for (const row of rows.rows) {
      if (!routeMap.has(row.route_id)) routeMap.set(row.route_id, { route_id: row.route_id, name: row.name, kind: row.kind, schedules: [] });
      routeMap.get(row.route_id).schedules.push({ schedule_id: row.schedule_id, outbound_depart_time: row.outbound_depart_time, return_depart_time: row.return_depart_time, boarded: row.boarded, total: row.total, no_shows: row.no_shows, unapproved: row.unapproved });
    }
    await audit(pool, user.id, 'read_transport_overview', 'organisations', i.id);
    return { date, routes: [...routeMap.values()] };
  },
});

cap({
  name: 'submit_transport_invoice_line', method: 'POST', path: '/academy/transport/schedules/:id/invoice', tag: TAG, status: 201,
  summary: 'Record an operator invoice line for a transport schedule. The line routes into the academy finance view. Needs the suppliers permission.',
  input: z.object({
    id, invoice_ref: z.string().trim().max(80).optional(),
    amount_minor: z.number().int().min(0).optional(), currency: z.string().trim().length(3).toUpperCase().optional(),
    status: z.enum(['pending', 'submitted', 'paid', 'disputed']).default('pending'),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const sched = await ownSchedule(c, i.id);
    await transportAccess(user, sched.organisation_id, true, c);
    if (i.currency && !isSupportedCurrency(i.currency)) throw badRequest('Unsupported currency');
    if (i.amount_minor != null && !i.currency) throw badRequest('Choose a currency for the amount');
    const r = (await c.query(
      `INSERT INTO academy_transport_invoice_lines(schedule_id, invoice_ref, amount_minor, currency, status, submitted_by, submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $5 IN ('submitted','paid') THEN now() ELSE NULL END) RETURNING *`,
      [i.id, i.invoice_ref ?? null, i.amount_minor ?? null, i.currency ?? null, i.status, user.id]
    )).rows[0];
    await audit(c, user.id, 'submit_transport_invoice_line', 'academy_transport_invoice_lines', r.id);
    return r;
  }),
});
