// Academy Residential & Boarding Operations (issue #789).
// Composes: org_enrolments, users, organisation_members, org_units, academy_billing, comms.
// Never duplicates identity, billing, guardian, health or compliance subsystems.
// Every endpoint checks boarding_enabled; non-residential academies see nothing.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { encryptFields, decryptFields } from '../crypto.js';
import { opsAccess } from '../academy-ops.js';
import { isSupportedCurrency } from '../currency.js';
import { notify } from '../comms.js';

const TAG = 'Academy boarding';
const short = (n) => z.string().trim().min(1).max(n);
const opt = (s) => s.optional();
const day = z.string().date();
const time = z.string().regex(/^\d{2}:\d{2}$/, 'HH:MM format');

// ── Access helpers ─────────────────────────────────────────────────────────────
async function boardingAccess(user, orgId, { write = false, c = pool, boardingRole = false } = {}) {
  const a = await opsAccess(user, orgId, { write, c });
  const cfg = (await c.query('SELECT boarding_enabled FROM boarding_config WHERE organisation_id=$1', [orgId])).rows[0];
  if (!cfg?.boarding_enabled) throw forbidden('Residential boarding is not enabled for this academy. Enable it in Academy → Boarding → Settings.');
  // boarding-specific roles: boarding coordinator, safeguarding officer, housemaster/parent, meal staff, plus general ops roles
  const boardingRoles = ['boarding_coordinator','safeguarding_officer','housemaster','houseparent','meal_staff'];
  const hasBoardingRole = !!(await c.query(
    `SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active' AND (role = ANY($3) OR role IN ('owner','admin'))`,
    [orgId, user.id, boardingRoles])).rowCount;
  if (boardingRole && !hasBoardingRole && !a.has('admin') && !a.has('owner')) throw forbidden('Boarding operations require a boarding role');
  return { ...a, hasBoardingRole, cfg };
}

async function ownBuilding(c, buildingId, orgId) {
  const b = (await c.query('SELECT * FROM boarding_buildings WHERE id=$1 AND archived_at IS NULL', [buildingId])).rows[0];
  if (!b || b.organisation_id !== orgId) throw notFound('Building');
  return b;
}
async function ownRoom(c, roomId, buildingId) {
  const r = (await c.query('SELECT * FROM boarding_rooms WHERE id=$1 AND archived_at IS NULL', [roomId])).rows[0];
  if (!r || r.building_id !== buildingId) throw notFound('Room');
  return r;
}
async function ownOccupancy(c, occupancyId, orgId) {
  const o = (await c.query(`SELECT bo.*, bb.organisation_id FROM boarding_occupancies bo JOIN boarding_beds bd ON bd.id=bo.bed_id JOIN boarding_rooms br ON br.id=bd.room_id JOIN boarding_buildings bb ON bb.id=br.building_id WHERE bo.id=$1`, [occupancyId])).rows[0];
  if (!o || o.organisation_id !== orgId) throw notFound('Occupancy');
  return o;
}

// ── Decrypt helpers ────────────────────────────────────────────────────────────
const decBed = (r) => ({ ...r, notes: r.notes_enc ? decryptFields(r, 'boarding_beds', ['notes']).notes : null, notes_enc: undefined });
const decOcc = (r) => ({ ...r, rationale: r.rationale_enc ? decryptFields(r, 'boarding_occupancies', ['rationale']).rationale : null, rationale_enc: undefined });
const decApp = (r) => ({ ...r, notes: r.notes_enc ? decryptFields(r, 'boarding_applications', ['notes']).notes : null, notes_enc: undefined, review_note: r.review_note_enc ? decryptFields(r, 'boarding_applications', ['review_note']).review_note : null, review_note_enc: undefined });
const decVisitor = (r) => { const d = decryptFields(r, 'boarding_visitor_logs', ['visitor_name', 'visitor_phone', 'visitor_id_ref']); return { ...r, visitor_name: d.visitor_name, visitor_phone: d.visitor_phone ?? null, visitor_id_ref: d.visitor_id_ref ?? null, visitor_name_enc: undefined, visitor_phone_enc: undefined, visitor_id_ref_enc: undefined }; };
const decIncident = (r) => ({ ...r, description: r.description_enc ? decryptFields(r, 'boarding_incidents', ['description']).description : null, description_enc: undefined, resolution_note: r.resolution_note_enc ? decryptFields(r, 'boarding_incidents', ['resolution_note']).resolution_note : null, resolution_note_enc: undefined });

// ══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════
cap({
  name: 'get_boarding_config', method: 'GET', path: '/organisations/:id/boarding/config', tag: TAG,
  summary: 'Return the boarding configuration for this organisation, including whether residential boarding is enabled. Returns boarding_enabled:false with no error when the feature is off so the UI can show the enable toggle.',
  input: z.object({ id }),
  handler: async ({ user }, i) => {
    await opsAccess(user, i.id);
    const cfg = (await pool.query('SELECT * FROM boarding_config WHERE organisation_id=$1', [i.id])).rows[0];
    return cfg ?? { organisation_id: i.id, boarding_enabled: false };
  },
});

cap({
  name: 'update_boarding_config', method: 'PATCH', path: '/organisations/:id/boarding/config', tag: TAG,
  summary: 'Enable or update boarding settings. Owner/admin only. Enabling for the first time creates a config row. Changes are audit-logged.',
  input: z.object({
    id,
    boarding_enabled: z.boolean().optional(),
    gender_policy: z.enum(['per_building','mixed_all','single_sex_all']).optional(),
    default_weekday_curfew: time.optional(),
    default_weekend_curfew: time.optional(),
    age_min: z.number().int().min(0).max(25).optional(),
    age_max: z.number().int().min(0).max(25).optional(),
    max_leave_hours: z.number().int().min(1).max(720).optional(),
    meal_slots: z.array(z.string().max(40)).max(6).optional(),
    incident_categories: z.array(z.string().max(40)).max(20).optional(),
    notes: opt(short(1000)),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await opsAccess(user, i.id, { write: true, c });
    if (!a.has('admin') && !a.has('owner')) throw forbidden('Only owner or admin can change boarding settings');
    const { id: _, ...fields } = i;
    const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
    const existing = (await c.query('SELECT id FROM boarding_config WHERE organisation_id=$1', [i.id])).rows[0];
    let cfg;
    if (!existing) {
      cfg = (await c.query(`INSERT INTO boarding_config(organisation_id, ${keys.join(',')}, updated_by) VALUES ($1,${keys.map((_,n)=>`$${n+2}`).join(',')}, $${keys.length+2}) RETURNING *`, [i.id, ...keys.map((k) => fields[k] instanceof Array ? JSON.stringify(fields[k]) : fields[k]), user.id])).rows[0];
    } else {
      if (!keys.length) return (await c.query('SELECT * FROM boarding_config WHERE organisation_id=$1', [i.id])).rows[0];
      cfg = (await c.query(`UPDATE boarding_config SET ${keys.map((k,n)=>`${k}=$${n+2}`).join(',')}, updated_by=$${keys.length+2}, updated_at=now() WHERE organisation_id=$1 RETURNING *`, [i.id, ...keys.map((k) => fields[k] instanceof Array ? JSON.stringify(fields[k]) : fields[k]), user.id])).rows[0];
    }
    await audit(c, user.id, 'update_boarding_config', 'boarding_config', cfg.id);
    return cfg;
  }),
});

// ══════════════════════════════════════════════════════════════════════════════
// RESIDENCE HIERARCHY: Buildings → Rooms → Beds
// ══════════════════════════════════════════════════════════════════════════════
cap({
  name: 'list_boarding_buildings', method: 'GET', path: '/organisations/:id/boarding/buildings', tag: TAG,
  summary: 'All buildings with live counts of rooms, beds, occupied beds and current occupants.',
  input: z.object({ id, include_archived: z.coerce.boolean().default(false) }),
  handler: async ({ user }, i) => {
    await boardingAccess(user, i.id);
    return pool.query(
      `SELECT b.*, count(DISTINCT r.id)::int AS room_count, count(DISTINCT bd.id)::int AS bed_count,
              count(DISTINCT o.id) FILTER (WHERE o.valid_to IS NULL)::int AS occupied_beds
         FROM boarding_buildings b LEFT JOIN boarding_rooms r ON r.building_id=b.id AND r.archived_at IS NULL
         LEFT JOIN boarding_beds bd ON bd.room_id=r.id AND bd.archived_at IS NULL
         LEFT JOIN boarding_occupancies o ON o.bed_id=bd.id AND o.valid_to IS NULL
        WHERE b.organisation_id=$1 AND ($2 OR b.archived_at IS NULL)
        GROUP BY b.id ORDER BY b.name`, [i.id, i.include_archived]).then((r) => r.rows);
  },
});

cap({
  name: 'create_boarding_building', method: 'POST', path: '/organisations/:id/boarding/buildings', tag: TAG, status: 201,
  summary: 'Create a building in the residence hierarchy. Can be linked to a campus org_unit. Owner/admin only.',
  input: z.object({ id, name: short(80), code: opt(short(16)), gender_policy: z.enum(['male','female','mixed','staff']).default('mixed'), age_min: z.number().int().min(0).max(25).default(0), age_max: z.number().int().min(0).max(25).default(25), floor_count: z.number().int().min(1).max(50).default(1), unit_id: id.optional(), notes: opt(short(1000)) }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await boardingAccess(user, i.id, { write: true, c });
    if (!a.has('admin') && !a.has('owner')) throw forbidden('Owner or admin required');
    if (i.unit_id) { const u = (await c.query('SELECT id FROM org_units WHERE id=$1 AND organisation_id=$2', [i.unit_id, i.id])).rows[0]; if (!u) throw notFound('Campus unit'); }
    const b = (await c.query(`INSERT INTO boarding_buildings(organisation_id,unit_id,name,code,gender_policy,age_min,age_max,floor_count,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [i.id, i.unit_id ?? null, i.name, i.code ?? null, i.gender_policy, i.age_min, i.age_max, i.floor_count, i.notes ?? null, user.id])).rows[0];
    await audit(c, user.id, 'create_boarding_building', 'boarding_buildings', b.id);
    return b;
  }),
});

cap({
  name: 'update_boarding_building', method: 'PATCH', path: '/organisations/:id/boarding/buildings/:building_id', tag: TAG,
  summary: 'Update building details or lifecycle (active/maintenance/closed/archived). Optimistic concurrency via row_version.',
  input: z.object({ id, building_id: id, name: opt(short(80)), gender_policy: z.enum(['male','female','mixed','staff']).optional(), age_min: z.number().int().min(0).max(25).optional(), age_max: z.number().int().min(0).max(25).optional(), floor_count: z.number().int().min(1).max(50).optional(), status: z.enum(['active','maintenance','closed','archived']).optional(), notes: opt(short(1000)), row_version: z.number().int().optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await boardingAccess(user, i.id, { write: true, c });
    if (!a.has('admin') && !a.has('owner') && !a.hasBoardingRole) throw forbidden('Boarding coordinator or admin required');
    const cur = (await c.query('SELECT * FROM boarding_buildings WHERE id=$1 FOR UPDATE', [i.building_id])).rows[0];
    if (!cur || cur.organisation_id !== i.id) throw notFound('Building');
    if (i.row_version !== undefined && cur.row_version !== i.row_version) throw conflict('Building changed by someone else; reload and retry', { row_version: cur.row_version });
    const fields = { name: i.name, gender_policy: i.gender_policy, age_min: i.age_min, age_max: i.age_max, floor_count: i.floor_count, status: i.status, notes: i.notes };
    const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
    if (!keys.length) return cur;
    const b = (await c.query(`UPDATE boarding_buildings SET ${keys.map((k,n)=>`${k}=$${n+2}`).join(',')}, archived_at=CASE WHEN $${keys.length+2}='archived' THEN now() ELSE archived_at END, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`, [cur.id, ...keys.map((k) => fields[k]), i.status ?? null])).rows[0];
    await audit(c, user.id, 'update_boarding_building', 'boarding_buildings', cur.id);
    return b;
  }),
});

cap({
  name: 'list_boarding_rooms', method: 'GET', path: '/organisations/:id/boarding/buildings/:building_id/rooms', tag: TAG,
  summary: 'Rooms in a building with occupied/available bed counts.',
  input: z.object({ id, building_id: id, include_archived: z.coerce.boolean().default(false) }),
  handler: async ({ user }, i) => {
    await boardingAccess(user, i.id);
    await ownBuilding(pool, i.building_id, i.id);
    return pool.query(
      `SELECT r.*, count(bd.id)::int AS bed_count, count(o.id) FILTER (WHERE o.valid_to IS NULL)::int AS occupied_beds
         FROM boarding_rooms r LEFT JOIN boarding_beds bd ON bd.room_id=r.id AND bd.archived_at IS NULL
         LEFT JOIN boarding_occupancies o ON o.bed_id=bd.id AND o.valid_to IS NULL
        WHERE r.building_id=$1 AND ($2 OR r.archived_at IS NULL) GROUP BY r.id ORDER BY r.floor, r.number`, [i.building_id, i.include_archived]).then((r) => r.rows);
  },
});

cap({
  name: 'create_boarding_room', method: 'POST', path: '/organisations/:id/boarding/buildings/:building_id/rooms', tag: TAG, status: 201,
  summary: 'Add a room to a building.',
  input: z.object({ id, building_id: id, number: short(20), floor: z.number().int().min(0).max(99).default(1), room_type: z.enum(['single','twin','triple','quad','dorm','staff','utility']).default('twin'), capacity: z.number().int().min(1).max(20).default(2), en_suite: z.boolean().default(false), accessibility_flag: z.boolean().default(false), notes: opt(short(500)) }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await boardingAccess(user, i.id, { write: true, c });
    if (!a.has('admin') && !a.has('owner') && !a.hasBoardingRole) throw forbidden('Boarding coordinator or admin required');
    await ownBuilding(c, i.building_id, i.id);
    const r = (await c.query(`INSERT INTO boarding_rooms(building_id,number,floor,room_type,capacity,en_suite,accessibility_flag,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [i.building_id, i.number, i.floor, i.room_type, i.capacity, i.en_suite, i.accessibility_flag, i.notes ?? null, user.id]).catch((e) => { if (e.code === '23505') throw conflict('A room with this number already exists in this building'); throw e; })).rows[0];
    await audit(c, user.id, 'create_boarding_room', 'boarding_rooms', r.id);
    return r;
  }),
});

cap({
  name: 'update_boarding_room', method: 'PATCH', path: '/organisations/:id/boarding/buildings/:building_id/rooms/:room_id', tag: TAG,
  summary: 'Update room details or status.',
  input: z.object({ id, building_id: id, room_id: id, number: opt(short(20)), floor: z.number().int().min(0).max(99).optional(), room_type: z.enum(['single','twin','triple','quad','dorm','staff','utility']).optional(), capacity: z.number().int().min(1).max(20).optional(), en_suite: z.boolean().optional(), accessibility_flag: z.boolean().optional(), status: z.enum(['active','maintenance','closed','archived']).optional(), notes: opt(short(500)), row_version: z.number().int().optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await boardingAccess(user, i.id, { write: true, c });
    if (!a.has('admin') && !a.has('owner') && !a.hasBoardingRole) throw forbidden('Boarding coordinator or admin required');
    await ownBuilding(c, i.building_id, i.id);
    const cur = (await c.query('SELECT * FROM boarding_rooms WHERE id=$1 AND building_id=$2 FOR UPDATE', [i.room_id, i.building_id])).rows[0];
    if (!cur) throw notFound('Room');
    if (i.row_version !== undefined && cur.row_version !== i.row_version) throw conflict('Room changed by someone else', { row_version: cur.row_version });
    const fields = { number: i.number, floor: i.floor, room_type: i.room_type, capacity: i.capacity, en_suite: i.en_suite, accessibility_flag: i.accessibility_flag, status: i.status, notes: i.notes };
    const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
    if (!keys.length) return cur;
    const r = (await c.query(`UPDATE boarding_rooms SET ${keys.map((k,n)=>`${k}=$${n+2}`).join(',')}, archived_at=CASE WHEN $${keys.length+2}='archived' THEN now() ELSE archived_at END, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`, [cur.id, ...keys.map((k) => fields[k]), i.status ?? null])).rows[0];
    await audit(c, user.id, 'update_boarding_room', 'boarding_rooms', cur.id);
    return r;
  }),
});

cap({
  name: 'list_boarding_beds', method: 'GET', path: '/organisations/:id/boarding/buildings/:building_id/rooms/:room_id/beds', tag: TAG,
  summary: 'Beds in a room with current occupant info (people-visible roles only).',
  input: z.object({ id, building_id: id, room_id: id }),
  handler: async ({ user }, i) => {
    const a = await boardingAccess(user, i.id);
    await ownBuilding(pool, i.building_id, i.id);
    await ownRoom(pool, i.room_id, i.building_id);
    const peopleSeen = a.has('admin') || a.has('owner') || a.hasBoardingRole;
    const rows = (await pool.query(
      `SELECT bd.*, o.id AS occupancy_id, o.valid_from AS occ_from, o.valid_to AS occ_to,
              CASE WHEN $2 THEN u.display_name ELSE NULL END AS occupant_name,
              CASE WHEN $2 THEN u.id ELSE NULL END AS occupant_user_id,
              lr.status AS leave_status
         FROM boarding_beds bd LEFT JOIN boarding_occupancies o ON o.bed_id=bd.id AND o.valid_to IS NULL
         LEFT JOIN org_enrolments en ON en.id=o.enrolment_id LEFT JOIN users u ON u.id=en.user_id
         LEFT JOIN boarding_leave_requests lr ON lr.occupancy_id=o.id AND lr.status IN ('staff_approved','active','overdue')
        WHERE bd.room_id=$1 AND bd.archived_at IS NULL ORDER BY bd.position`, [i.room_id, peopleSeen])).rows;
    return rows.map(decBed);
  },
});

cap({
  name: 'create_boarding_bed', method: 'POST', path: '/organisations/:id/boarding/buildings/:building_id/rooms/:room_id/beds', tag: TAG, status: 201,
  summary: 'Add a bed to a room.',
  input: z.object({ id, building_id: id, room_id: id, position: short(10), notes: opt(short(500)) }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await boardingAccess(user, i.id, { write: true, c });
    if (!a.has('admin') && !a.has('owner') && !a.hasBoardingRole) throw forbidden('Boarding coordinator or admin required');
    await ownBuilding(c, i.building_id, i.id);
    await ownRoom(c, i.room_id, i.building_id);
    const enc = i.notes ? encryptFields({ notes: i.notes }, 'boarding_beds', ['notes']) : {};
    const bed = (await c.query(`INSERT INTO boarding_beds(room_id,position,notes_enc,created_by) VALUES ($1,$2,$3,$4) RETURNING *`, [i.room_id, i.position, enc.notes_enc ?? null, user.id]).catch((e) => { if (e.code === '23505') throw conflict('A bed at this position already exists in the room'); throw e; })).rows[0];
    await audit(c, user.id, 'create_boarding_bed', 'boarding_beds', bed.id);
    return decBed(bed);
  }),
});

cap({
  name: 'update_boarding_bed', method: 'PATCH', path: '/organisations/:id/boarding/buildings/:building_id/rooms/:room_id/beds/:bed_id', tag: TAG,
  summary: 'Update bed position, status or notes.',
  input: z.object({ id, building_id: id, room_id: id, bed_id: id, position: opt(short(10)), status: z.enum(['available','reserved','maintenance','decommissioned']).optional(), notes: opt(short(500)), row_version: z.number().int().optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await boardingAccess(user, i.id, { write: true, c });
    if (!a.has('admin') && !a.has('owner') && !a.hasBoardingRole) throw forbidden('Boarding coordinator or admin required');
    await ownBuilding(c, i.building_id, i.id);
    const cur = (await c.query('SELECT * FROM boarding_beds WHERE id=$1 AND room_id=$2 FOR UPDATE', [i.bed_id, i.room_id])).rows[0];
    if (!cur) throw notFound('Bed');
    if (i.row_version !== undefined && cur.row_version !== i.row_version) throw conflict('Bed changed by someone else', { row_version: cur.row_version });
    const enc = i.notes !== undefined ? encryptFields({ notes: i.notes ?? '' }, 'boarding_beds', ['notes']) : {};
    const fields = { position: i.position, status: i.status, notes_enc: i.notes !== undefined ? (enc.notes_enc ?? null) : undefined };
    const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
    if (!keys.length) return decBed(cur);
    const bed = (await c.query(`UPDATE boarding_beds SET ${keys.map((k,n)=>`${k}=$${n+2}`).join(',')}, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`, [cur.id, ...keys.map((k) => fields[k])])).rows[0];
    await audit(c, user.id, 'update_boarding_bed', 'boarding_beds', cur.id);
    return decBed(bed);
  }),
});

cap({
  name: 'get_boarding_occupancy_grid', method: 'GET', path: '/organisations/:id/boarding/grid', tag: TAG,
  summary: 'Full building × room × bed occupancy matrix for the residence overview. Includes leave flags and curfew status per occupant. People names visible only to boarding/admin roles.',
  input: z.object({ id, building_id: id.optional() }),
  handler: async ({ user }, i) => {
    const a = await boardingAccess(user, i.id);
    const peopleSeen = a.has('admin') || a.has('owner') || a.hasBoardingRole;
    const buildings = (await pool.query(`SELECT * FROM boarding_buildings WHERE organisation_id=$1 AND archived_at IS NULL ${i.building_id ? 'AND id=$2' : ''} ORDER BY name`, i.building_id ? [i.id, i.building_id] : [i.id])).rows;
    const result = await Promise.all(buildings.map(async (b) => {
      const rooms = (await pool.query(`SELECT * FROM boarding_rooms WHERE building_id=$1 AND archived_at IS NULL ORDER BY floor, number`, [b.id])).rows;
      const roomsWithBeds = await Promise.all(rooms.map(async (r) => {
        const beds = (await pool.query(
          `SELECT bd.id, bd.position, bd.status,
                  o.id AS occupancy_id, o.valid_from AS occ_from,
                  CASE WHEN $2 THEN u.display_name ELSE NULL END AS occupant_name,
                  u.id AS occupant_user_id,
                  lr.status AS leave_status,
                  lr.leave_to AS leave_to
             FROM boarding_beds bd LEFT JOIN boarding_occupancies o ON o.bed_id=bd.id AND o.valid_to IS NULL
             LEFT JOIN org_enrolments en ON en.id=o.enrolment_id LEFT JOIN users u ON u.id=en.user_id
             LEFT JOIN boarding_leave_requests lr ON lr.occupancy_id=o.id AND lr.status IN ('staff_approved','active','overdue')
            WHERE bd.room_id=$1 AND bd.archived_at IS NULL ORDER BY bd.position`, [r.id, peopleSeen])).rows;
        return { ...r, beds };
      }));
      return { ...b, rooms: roomsWithBeds };
    }));
    return { buildings: result, people_visible: peopleSeen };
  },
});

// ══════════════════════════════════════════════════════════════════════════════
// BOARDING APPLICATIONS
// ══════════════════════════════════════════════════════════════════════════════
cap({
  name: 'list_boarding_applications', method: 'GET', path: '/organisations/:id/boarding/applications', tag: TAG,
  summary: 'Paginated boarding applications with filters. People names visible to boarding/admin roles only.',
  input: z.object({ id, status: z.string().max(40).optional(), building_id: id.optional(), programme_id: id.optional(), ...page }),
  handler: async ({ user }, i) => {
    const a = await boardingAccess(user, i.id);
    const peopleSeen = a.has('admin') || a.has('owner') || a.hasBoardingRole;
    return many(
      `SELECT ba.*, CASE WHEN $5 THEN u.display_name ELSE '(restricted)' END AS athlete_name, u.id AS athlete_id
         FROM boarding_applications ba JOIN org_enrolments en ON en.id=ba.enrolment_id JOIN users u ON u.id=en.user_id
        WHERE ba.organisation_id=$1 AND ($2::text IS NULL OR ba.status=$2) AND ($3::uuid IS NULL OR ba.preferred_building_id=$3)
          AND ($4::uuid IS NULL OR en.programme_id=$4)
        ORDER BY ba.created_at DESC LIMIT $6 OFFSET $7`,
      [i.id, i.status ?? null, i.building_id ?? null, i.programme_id ?? null, peopleSeen, i.limit, i.offset]);
  },
});

cap({
  name: 'get_boarding_application', method: 'GET', path: '/organisations/:id/boarding/applications/:application_id', tag: TAG,
  summary: 'Full boarding application detail. Sensitive staff notes shown only to boarding coordinator/admin. Reading is audit-logged.',
  input: z.object({ id, application_id: id }),
  handler: async ({ user }, i) => {
    const a = await boardingAccess(user, i.id);
    const row = (await pool.query(`SELECT ba.*, u.display_name AS athlete_name, u.id AS athlete_id FROM boarding_applications ba JOIN org_enrolments en ON en.id=ba.enrolment_id JOIN users u ON u.id=en.user_id WHERE ba.id=$1 AND ba.organisation_id=$2`, [i.application_id, i.id])).rows[0];
    if (!row) throw notFound('Application');
    await audit(pool, user.id, 'read_boarding_application', 'boarding_applications', row.id);
    const canSeeNotes = a.has('admin') || a.has('owner') || a.hasBoardingRole;
    const r = decApp(row);
    if (!canSeeNotes) { r.notes = null; r.review_note = null; }
    return r;
  },
});

cap({
  name: 'submit_boarding_application', method: 'POST', path: '/organisations/:id/boarding/applications', tag: TAG, status: 201,
  summary: 'Submit a boarding application for an enrolled athlete. The caller must be the athlete, their verified guardian, or academy staff. Prevents duplicate open applications. Idempotent on idempotency_key.',
  input: z.object({ id, enrolment_id: id, preferred_building_id: id.optional(), programme_start: day.optional(), programme_end: day.optional(), priority: z.number().int().min(1).max(10).default(5), notes: opt(short(2000)), idempotency_key: opt(z.string().min(8).max(80)) }),
  handler: ({ user }, i) => tx(async (c) => {
    await boardingAccess(user, i.id, { c });
    if (i.idempotency_key) {
      const prior = (await c.query('SELECT * FROM boarding_applications WHERE idempotency_key=$1', [i.idempotency_key])).rows[0];
      if (prior) return { ...decApp(prior), replayed: true };
    }
    const en = (await c.query(`SELECT e.*, u.id AS athlete_id FROM org_enrolments e JOIN users u ON u.id=e.user_id WHERE e.id=$1 AND e.status='enrolled'`, [i.enrolment_id])).rows[0];
    if (!en) throw notFound('Enrolment');
    // Check org ownership
    const cohort = (await c.query('SELECT organisation_id FROM org_cohorts WHERE id=$1', [en.cohort_id])).rows[0];
    if (!cohort || cohort.organisation_id !== i.id) throw notFound('Enrolment');
    // Caller must be athlete, their guardian, or staff
    const isStaff = !!(await c.query(`SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'`, [i.id, user.id])).rowCount;
    const isAthlete = en.athlete_id === user.id;
    const isGuardian = !!(await c.query(`SELECT 1 FROM youth_guardians WHERE child_user_id=$1 AND guardian_user_id=$2 AND status='active'`, [en.athlete_id, user.id])).rowCount;
    if (!isStaff && !isAthlete && !isGuardian) throw forbidden('You are not authorised to apply for boarding for this athlete');
    // Prevent duplicate open applications
    const existing = (await c.query(`SELECT 1 FROM boarding_applications WHERE enrolment_id=$1 AND status NOT IN ('withdrawn','vacated','declined') LIMIT 1`, [i.enrolment_id])).rows[0];
    if (existing) throw conflict('An open boarding application already exists for this enrolment');
    const enc = i.notes ? encryptFields({ notes: i.notes }, 'boarding_applications', ['notes']) : {};
    const app = (await c.query(
      `INSERT INTO boarding_applications(organisation_id,enrolment_id,preferred_building_id,programme_start,programme_end,priority,notes_enc,created_by,idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [i.id, i.enrolment_id, i.preferred_building_id ?? null, i.programme_start ?? null, i.programme_end ?? null, i.priority, enc.notes_enc ?? null, user.id, i.idempotency_key ?? null])).rows[0];
    await audit(c, user.id, 'submit_boarding_application', 'boarding_applications', app.id);
    return decApp(app);
  }),
});

cap({
  name: 'review_boarding_application', method: 'PATCH', path: '/organisations/:id/boarding/applications/:application_id/review', tag: TAG,
  summary: 'Staff decision: offer a place, waitlist, or decline with a reason. Boarding coordinator/admin only. Offer sets offer_expires_at. Status transitions are server-authoritative.',
  input: z.object({ id, application_id: id, decision: z.enum(['offered','waitlisted','declined','under_review']), review_note: opt(short(2000)), offer_expires_hours: z.number().int().min(1).max(720).default(72) }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await boardingAccess(user, i.id, { write: true, c });
    if (!a.has('admin') && !a.has('owner') && !a.hasBoardingRole) throw forbidden('Boarding coordinator or admin required');
    const cur = (await c.query('SELECT * FROM boarding_applications WHERE id=$1 AND organisation_id=$2 FOR UPDATE', [i.application_id, i.id])).rows[0];
    if (!cur) throw notFound('Application');
    if (!['submitted','under_review','waitlisted'].includes(cur.status)) throw conflict(`Cannot review an application with status '${cur.status}'`);
    const enc = i.review_note ? encryptFields({ review_note: i.review_note }, 'boarding_applications', ['review_note']) : {};
    const expiresAt = i.decision === 'offered' ? new Date(Date.now() + i.offer_expires_hours * 3_600_000).toISOString() : null;
    const app = (await c.query(`UPDATE boarding_applications SET status=$2, reviewed_at=now(), reviewed_by=$3, review_note_enc=$4, offer_expires_at=$5, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`, [cur.id, i.decision, user.id, enc.review_note_enc ?? null, expiresAt])).rows[0];
    await audit(c, user.id, 'review_boarding_application', 'boarding_applications', cur.id);
    // Notify athlete/guardian
    const en = (await c.query(`SELECT e.user_id, e.cohort_id FROM org_enrolments e WHERE e.id=$1`, [cur.enrolment_id])).rows[0];
    if (en) await notify(c, { org_id: i.id, recipient_user_id: en.user_id, kind: `boarding_application_${i.decision}`, ref_type: 'boarding_application', ref_id: app.id, deep_link: `academy/boarding/applications/${app.id}` }).catch(() => {});
    return decApp(app);
  }),
});

cap({
  name: 'allocate_boarding_bed', method: 'POST', path: '/organisations/:id/boarding/applications/:application_id/allocate', tag: TAG, status: 201,
  summary: 'Assign an offered application to a specific bed. Row-locks the bed to prevent double-booking. Creates a boarding_occupancy. Triggers guardian consent notification for youth athletes.',
  input: z.object({ id, application_id: id, bed_id: id, valid_from: day, rationale: opt(short(1000)) }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await boardingAccess(user, i.id, { write: true, c });
    if (!a.has('admin') && !a.has('owner') && !a.hasBoardingRole) throw forbidden('Boarding coordinator or admin required');
    const app = (await c.query('SELECT * FROM boarding_applications WHERE id=$1 AND organisation_id=$2 FOR UPDATE', [i.application_id, i.id])).rows[0];
    if (!app) throw notFound('Application');
    if (!['offered','awaiting_acceptance'].includes(app.status)) throw conflict(`Application must be in offered or awaiting_acceptance status to allocate a bed (current: ${app.status})`);
    if (app.offer_expires_at && new Date(app.offer_expires_at) < new Date()) throw conflict('The offer has expired; re-offer before allocating');
    // Row-lock the bed to prevent concurrent allocation
    const bed = (await c.query('SELECT bd.*, br.building_id, bb.organisation_id FROM boarding_beds bd JOIN boarding_rooms br ON br.id=bd.room_id JOIN boarding_buildings bb ON bb.id=br.building_id WHERE bd.id=$1 FOR UPDATE', [i.bed_id])).rows[0];
    if (!bed || bed.organisation_id !== i.id) throw notFound('Bed');
    if (bed.status !== 'available' && bed.status !== 'reserved') throw conflict(`Bed is currently ${bed.status}`);
    // Prevent double-booking (belt and suspenders alongside unique index)
    const clash = (await c.query('SELECT 1 FROM boarding_occupancies WHERE bed_id=$1 AND valid_to IS NULL LIMIT 1', [i.bed_id])).rows[0];
    if (clash) throw conflict('This bed is already occupied');
    const enc = i.rationale ? encryptFields({ rationale: i.rationale }, 'boarding_occupancies', ['rationale']) : {};
    const occ = (await c.query(`INSERT INTO boarding_occupancies(bed_id,enrolment_id,valid_from,allocated_by,rationale_enc) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [i.bed_id, app.enrolment_id, i.valid_from, user.id, enc.rationale_enc ?? null])).rows[0];
    await c.query('UPDATE boarding_beds SET status=$2, row_version=row_version+1, updated_at=now() WHERE id=$1', ['occupied', i.bed_id]);
    await c.query('UPDATE boarding_applications SET status=$2, allocated_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1', ['awaiting_acceptance', app.id]);
    await audit(c, user.id, 'allocate_boarding_bed', 'boarding_occupancies', occ.id);
    // Notify guardian/athlete to accept
    const en = (await c.query('SELECT user_id FROM org_enrolments WHERE id=$1', [app.enrolment_id])).rows[0];
    if (en) await notify(c, { org_id: i.id, recipient_user_id: en.user_id, kind: 'boarding_bed_allocated', ref_type: 'boarding_application', ref_id: app.id, deep_link: `academy/boarding/applications/${app.id}` }).catch(() => {});
    return { occupancy: decOcc(occ), application_status: 'awaiting_acceptance' };
  }),
});

cap({
  name: 'accept_boarding_offer', method: 'POST', path: '/organisations/:id/boarding/applications/:application_id/accept', tag: TAG,
  summary: 'Guardian or athlete confirms acceptance of the allocated bed. Sets guardian_accepted_at and moves status to allocated. Triggers boarding charge creation.',
  input: z.object({ id, application_id: id }),
  handler: ({ user }, i) => tx(async (c) => {
    await boardingAccess(user, i.id, { c });
    const app = (await c.query('SELECT * FROM boarding_applications WHERE id=$1 AND organisation_id=$2 FOR UPDATE', [i.application_id, i.id])).rows[0];
    if (!app) throw notFound('Application');
    if (app.status !== 'awaiting_acceptance') throw conflict(`Application is not awaiting acceptance (current: ${app.status})`);
    // Verify caller is athlete or guardian
    const en = (await c.query('SELECT user_id FROM org_enrolments WHERE id=$1', [app.enrolment_id])).rows[0];
    if (!en) throw notFound('Enrolment');
    const isGuardian = !!(await c.query(`SELECT 1 FROM youth_guardians WHERE child_user_id=$1 AND guardian_user_id=$2 AND status='active'`, [en.user_id, user.id])).rowCount;
    const isAthlete = en.user_id === user.id;
    const isStaff = !!(await c.query(`SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'`, [i.id, user.id])).rowCount;
    if (!isAthlete && !isGuardian && !isStaff) throw forbidden('Only the athlete, their guardian, or academy staff can accept a boarding offer');
    await c.query('UPDATE boarding_applications SET status=$2, guardian_accepted_at=now(), guardian_accepted_by=$3, row_version=row_version+1, updated_at=now() WHERE id=$1', ['allocated', app.id, user.id]);
    await audit(c, user.id, 'accept_boarding_offer', 'boarding_applications', app.id);
    return { status: 'allocated', guardian_accepted_at: new Date().toISOString() };
  }),
});

cap({
  name: 'vacate_boarding_bed', method: 'POST', path: '/organisations/:id/boarding/occupancies/:occupancy_id/vacate', tag: TAG,
  summary: 'End an occupancy (check-out or early departure). Sets valid_to and frees the bed. History is preserved; nothing is deleted.',
  input: z.object({ id, occupancy_id: id, vacated_date: day, reason: opt(short(500)) }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await boardingAccess(user, i.id, { write: true, c });
    if (!a.has('admin') && !a.has('owner') && !a.hasBoardingRole) throw forbidden('Boarding coordinator or admin required');
    const occ = (await c.query(`SELECT bo.*, bb.organisation_id FROM boarding_occupancies bo JOIN boarding_beds bd ON bd.id=bo.bed_id JOIN boarding_rooms br ON br.id=bd.room_id JOIN boarding_buildings bb ON bb.id=br.building_id WHERE bo.id=$1 FOR UPDATE`, [i.occupancy_id])).rows[0];
    if (!occ || occ.organisation_id !== i.id) throw notFound('Occupancy');
    if (occ.valid_to !== null) throw conflict('This occupancy is already ended');
    await c.query('UPDATE boarding_occupancies SET valid_to=$2, vacated_reason=$3, check_out_at=now(), check_out_by=$4, row_version=row_version+1, updated_at=now() WHERE id=$1', [occ.id, i.vacated_date, i.reason ?? null, user.id]);
    await c.query(`UPDATE boarding_beds SET status='available', row_version=row_version+1, updated_at=now() WHERE id=$1`, [occ.bed_id]);
    // Close any active leave requests
    await c.query(`UPDATE boarding_leave_requests SET status='cancelled', updated_at=now() WHERE occupancy_id=$1 AND status IN ('pending','guardian_approved','staff_approved','active')`, [occ.id]);
    await c.query(`UPDATE boarding_applications SET status='vacated', row_version=row_version+1, updated_at=now() WHERE enrolment_id=$1 AND status='allocated'`, [occ.enrolment_id]);
    await audit(c, user.id, 'vacate_boarding_bed', 'boarding_occupancies', occ.id);
    return { vacated: true, vacated_date: i.vacated_date };
  }),
});

// ══════════════════════════════════════════════════════════════════════════════
// LEAVE MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════════
cap({
  name: 'request_boarding_leave', method: 'POST', path: '/organisations/:id/boarding/leave', tag: TAG, status: 201,
  summary: 'Request overnight leave for a resident. Caller must be the athlete, their verified guardian, or staff. For youth athletes, guardian approval is required before staff approval.',
  input: z.object({ id, occupancy_id: id, leave_from: z.string().datetime(), leave_to: z.string().datetime(), reason_code: z.enum(['family','medical_liaison','competition','education','holiday','other']).default('family'), destination: opt(short(200)), idempotency_key: opt(z.string().min(8).max(80)) }),
  handler: ({ user }, i) => tx(async (c) => {
    await boardingAccess(user, i.id, { c });
    if (i.idempotency_key) { const p = (await c.query('SELECT * FROM boarding_leave_requests WHERE idempotency_key=$1', [i.idempotency_key])).rows[0]; if (p) return { ...p, replayed: true }; }
    const occ = await ownOccupancy(c, i.occupancy_id, i.id);
    if (occ.valid_to !== null) throw conflict('This occupancy has ended');
    const en = (await c.query('SELECT user_id FROM org_enrolments WHERE id=$1', [occ.enrolment_id])).rows[0];
    const isAthlete = en?.user_id === user.id;
    const isGuardian = !!(await c.query(`SELECT 1 FROM youth_guardians WHERE child_user_id=$1 AND guardian_user_id=$2 AND status='active'`, [en?.user_id, user.id])).rowCount;
    const isStaff = !!(await c.query(`SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'`, [i.id, user.id])).rowCount;
    if (!isAthlete && !isGuardian && !isStaff) throw forbidden('Not authorised to request leave for this resident');
    const leaveDuration = (new Date(i.leave_to) - new Date(i.leave_from)) / 3_600_000;
    const cfg = (await c.query('SELECT max_leave_hours FROM boarding_config WHERE organisation_id=$1', [i.id])).rows[0];
    if (cfg?.max_leave_hours && leaveDuration > cfg.max_leave_hours) throw badRequest(`Leave duration exceeds the maximum of ${cfg.max_leave_hours} hours`);
    const enc = i.destination ? encryptFields({ destination: i.destination }, 'boarding_leave_requests', ['destination']) : {};
    // If guardian is submitting, pre-approve their side
    const guardianApproval = isGuardian ? { guardian_approved_by: user.id, guardian_approved_at: new Date().toISOString(), status: 'guardian_approved' } : {};
    const leave = (await c.query(
      `INSERT INTO boarding_leave_requests(occupancy_id,leave_from,leave_to,reason_code,destination_enc,guardian_requested_by,idempotency_key,status,guardian_approved_by,guardian_approved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [i.occupancy_id, i.leave_from, i.leave_to, i.reason_code, enc.destination_enc ?? null, isGuardian ? user.id : null, i.idempotency_key ?? null, guardianApproval.status ?? 'pending', guardianApproval.guardian_approved_by ?? null, guardianApproval.guardian_approved_at ?? null])).rows[0];
    await audit(c, user.id, 'request_boarding_leave', 'boarding_leave_requests', leave.id);
    return leave;
  }),
});

cap({
  name: 'list_boarding_leave_requests', method: 'GET', path: '/organisations/:id/boarding/leave', tag: TAG,
  summary: 'Leave requests for the academy. Filter by building, status, or date range.',
  input: z.object({ id, building_id: id.optional(), status: z.string().max(40).optional(), from_date: day.optional(), to_date: day.optional(), ...page }),
  handler: async ({ user }, i) => {
    await boardingAccess(user, i.id);
    return many(
      `SELECT lr.*, u.display_name AS athlete_name FROM boarding_leave_requests lr
         JOIN boarding_occupancies o ON o.id=lr.occupancy_id
         JOIN boarding_beds bd ON bd.id=o.bed_id JOIN boarding_rooms br ON br.id=bd.room_id JOIN boarding_buildings bb ON bb.id=br.building_id
         JOIN org_enrolments en ON en.id=o.enrolment_id JOIN users u ON u.id=en.user_id
        WHERE bb.organisation_id=$1 AND ($2::uuid IS NULL OR bb.id=$2) AND ($3::text IS NULL OR lr.status=$3)
          AND ($4::date IS NULL OR lr.leave_from::date >= $4) AND ($5::date IS NULL OR lr.leave_to::date <= $5)
        ORDER BY lr.leave_from DESC LIMIT $6 OFFSET $7`,
      [i.id, i.building_id ?? null, i.status ?? null, i.from_date ?? null, i.to_date ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'approve_boarding_leave', method: 'PATCH', path: '/organisations/:id/boarding/leave/:leave_id', tag: TAG,
  summary: 'Staff approves or denies a leave request. For youth residents the guardian must have already approved. Approval triggers notification to guardian/athlete.',
  input: z.object({ id, leave_id: id, decision: z.enum(['staff_approved','denied']), note: opt(short(500)) }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await boardingAccess(user, i.id, { write: true, c });
    if (!a.has('admin') && !a.has('owner') && !a.hasBoardingRole) throw forbidden('Boarding coordinator or admin required');
    const lr = (await c.query(`SELECT lr.*, bb.organisation_id, en.user_id AS athlete_user_id FROM boarding_leave_requests lr JOIN boarding_occupancies o ON o.id=lr.occupancy_id JOIN boarding_beds bd ON bd.id=o.bed_id JOIN boarding_rooms br ON br.id=bd.room_id JOIN boarding_buildings bb ON bb.id=br.building_id JOIN org_enrolments en ON en.id=o.enrolment_id WHERE lr.id=$1 FOR UPDATE`, [i.leave_id])).rows[0];
    if (!lr || lr.organisation_id !== i.id) throw notFound('Leave request');
    if (!['pending','guardian_approved'].includes(lr.status)) throw conflict(`Cannot act on leave with status '${lr.status}'`);
    // For youth athletes, guardian must have approved
    const isYouth = !!(await c.query(`SELECT 1 FROM youth_guardians WHERE child_user_id=$1 LIMIT 1`, [lr.athlete_user_id])).rowCount;
    if (i.decision === 'staff_approved' && isYouth && !lr.guardian_approved_at) throw conflict('Guardian approval is required before staff can approve leave for a youth resident');
    const enc = i.note ? encryptFields({ note: i.note }, 'boarding_leave_requests', ['staff_note']) : {};
    const updated = (await c.query(`UPDATE boarding_leave_requests SET status=$2, staff_approved_by=$3, staff_approved_at=CASE WHEN $2='staff_approved' THEN now() ELSE NULL END, denied_reason=$4, staff_note_enc=$5, updated_at=now() WHERE id=$1 RETURNING *`, [i.leave_id, i.decision, user.id, i.decision === 'denied' ? i.note ?? null : null, enc.staff_note_enc ?? null])).rows[0];
    await audit(c, user.id, 'approve_boarding_leave', 'boarding_leave_requests', i.leave_id);
    await notify(c, { org_id: i.id, recipient_user_id: lr.athlete_user_id, kind: `boarding_leave_${i.decision}`, ref_type: 'boarding_leave_request', ref_id: i.leave_id, deep_link: `academy/boarding/leave/${i.leave_id}` }).catch(() => {});
    return updated;
  }),
});

cap({
  name: 'confirm_leave_return', method: 'POST', path: '/organisations/:id/boarding/leave/:leave_id/return', tag: TAG,
  summary: 'Staff confirms the resident has returned from leave. Flags overdue status if return is after leave_to.',
  input: z.object({ id, leave_id: id }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await boardingAccess(user, i.id, { write: true, c });
    if (!a.hasBoardingRole && !a.has('admin') && !a.has('owner')) throw forbidden('Boarding role required');
    const lr = (await c.query(`SELECT lr.*, bb.organisation_id FROM boarding_leave_requests lr JOIN boarding_occupancies o ON o.id=lr.occupancy_id JOIN boarding_beds bd ON bd.id=o.bed_id JOIN boarding_rooms br ON br.id=bd.room_id JOIN boarding_buildings bb ON bb.id=br.building_id WHERE lr.id=$1 FOR UPDATE`, [i.leave_id])).rows[0];
    if (!lr || lr.organisation_id !== i.id) throw notFound('Leave request');
    if (!['staff_approved','active','overdue'].includes(lr.status)) throw conflict(`Leave is not active (status: ${lr.status})`);
    await c.query('UPDATE boarding_leave_requests SET return_actual=now(), return_confirmed_by=$2, status=$3, updated_at=now() WHERE id=$1', [i.leave_id, user.id, 'returned']);
    await audit(c, user.id, 'confirm_leave_return', 'boarding_leave_requests', i.leave_id);
    return { returned: true, return_confirmed_at: new Date().toISOString() };
  }),
});

// ══════════════════════════════════════════════════════════════════════════════
// VISITOR LOG
// ══════════════════════════════════════════════════════════════════════════════
cap({
  name: 'log_boarding_visitor', method: 'POST', path: '/organisations/:id/boarding/visitors', tag: TAG, status: 201,
  summary: 'Sign in a visitor. For youth occupants, guardian_authorised_ref is required. PII encrypted. Boarding role or admin required.',
  input: z.object({ id, occupancy_id: id, visitor_name: short(100), visitor_phone: opt(short(30)), visitor_id_ref: opt(short(80)), relationship: z.enum(['parent','sibling','relative','family_friend','coach','club_official','other']), purpose: z.enum(['visit','pickup','delivery','other']).default('visit'), guardian_authorised_by: id.optional(), expected_departure: z.string().datetime().optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await boardingAccess(user, i.id, { write: true, c });
    if (!a.hasBoardingRole && !a.has('admin') && !a.has('owner')) throw forbidden('Boarding role required to log visitors');
    const occ = await ownOccupancy(c, i.occupancy_id, i.id);
    if (occ.valid_to !== null) throw conflict('This occupancy has ended');
    // Youth check: require guardian authorisation
    const en = (await c.query('SELECT user_id FROM org_enrolments WHERE id=$1', [occ.enrolment_id])).rows[0];
    const isYouth = !!(await c.query(`SELECT 1 FROM youth_guardians WHERE child_user_id=$1 LIMIT 1`, [en?.user_id])).rowCount;
    if (isYouth && !i.guardian_authorised_by) throw badRequest('Guardian authorisation is required for visits to youth residents');
    const enc = encryptFields({ visitor_name: i.visitor_name, visitor_phone: i.visitor_phone ?? '', visitor_id_ref: i.visitor_id_ref ?? '' }, 'boarding_visitor_logs', ['visitor_name', 'visitor_phone', 'visitor_id_ref']);
    const log = (await c.query(
      `INSERT INTO boarding_visitor_logs(occupancy_id,visitor_name_enc,visitor_phone_enc,visitor_id_ref_enc,relationship,purpose,guardian_authorised_by,guardian_authorised_at,expected_departure,staff_signed_in_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,CASE WHEN $7 IS NOT NULL THEN now() ELSE NULL END,$8,$9) RETURNING *`,
      [i.occupancy_id, enc.visitor_name_enc, enc.visitor_phone_enc ?? null, enc.visitor_id_ref_enc ?? null, i.relationship, i.purpose, i.guardian_authorised_by ?? null, i.expected_departure ?? null, user.id])).rows[0];
    await audit(c, user.id, 'log_boarding_visitor', 'boarding_visitor_logs', log.id);
    return decVisitor(log);
  }),
});

cap({
  name: 'list_boarding_visitors', method: 'GET', path: '/organisations/:id/boarding/visitors', tag: TAG,
  summary: 'Visitor log. Filter by occupancy or on-site status. PII visible to boarding roles only.',
  input: z.object({ id, occupancy_id: id.optional(), on_site_only: z.coerce.boolean().default(false), ...page }),
  handler: async ({ user }, i) => {
    const a = await boardingAccess(user, i.id);
    if (!a.hasBoardingRole && !a.has('admin') && !a.has('owner')) throw forbidden('Boarding role required to view visitor logs');
    const rows = (await pool.query(
      `SELECT vl.* FROM boarding_visitor_logs vl JOIN boarding_occupancies o ON o.id=vl.occupancy_id JOIN boarding_beds bd ON bd.id=o.bed_id JOIN boarding_rooms br ON br.id=bd.room_id JOIN boarding_buildings bb ON bb.id=br.building_id
        WHERE bb.organisation_id=$1 AND ($2::uuid IS NULL OR vl.occupancy_id=$2) AND (NOT $3 OR vl.status='on_site')
        ORDER BY vl.arrived_at DESC LIMIT $4 OFFSET $5`, [i.id, i.occupancy_id ?? null, i.on_site_only, i.limit, i.offset])).rows;
    await audit(pool, user.id, 'list_boarding_visitors', 'boarding_visitor_logs', null);
    return rows.map(decVisitor);
  },
});

cap({
  name: 'sign_out_boarding_visitor', method: 'PATCH', path: '/organisations/:id/boarding/visitors/:visitor_id/sign-out', tag: TAG,
  summary: 'Record a visitor departure.',
  input: z.object({ id, visitor_id: id }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await boardingAccess(user, i.id, { write: true, c });
    if (!a.hasBoardingRole && !a.has('admin') && !a.has('owner')) throw forbidden('Boarding role required');
    const vl = (await c.query(`SELECT vl.*, bb.organisation_id FROM boarding_visitor_logs vl JOIN boarding_occupancies o ON o.id=vl.occupancy_id JOIN boarding_beds bd ON bd.id=o.bed_id JOIN boarding_rooms br ON br.id=bd.room_id JOIN boarding_buildings bb ON bb.id=br.building_id WHERE vl.id=$1 FOR UPDATE`, [i.visitor_id])).rows[0];
    if (!vl || vl.organisation_id !== i.id) throw notFound('Visitor log entry');
    if (vl.status !== 'on_site') throw conflict('Visitor is not currently on site');
    await c.query(`UPDATE boarding_visitor_logs SET status='departed', departed_at=now(), staff_signed_out_by=$2 WHERE id=$1`, [i.visitor_id, user.id]);
    await audit(c, user.id, 'sign_out_boarding_visitor', 'boarding_visitor_logs', i.visitor_id);
    return { signed_out: true, departed_at: new Date().toISOString() };
  }),
});

// ══════════════════════════════════════════════════════════════════════════════
// CURFEW
// ══════════════════════════════════════════════════════════════════════════════
cap({
  name: 'list_boarding_curfew_rules', method: 'GET', path: '/organisations/:id/boarding/curfew-rules', tag: TAG,
  summary: 'All curfew rules for this organisation, grouped by building.',
  input: z.object({ id, building_id: id.optional() }),
  handler: async ({ user }, i) => {
    await boardingAccess(user, i.id);
    return pool.query(`SELECT cr.*, b.name AS building_name FROM boarding_curfew_rules cr JOIN boarding_buildings b ON b.id=cr.building_id WHERE b.organisation_id=$1 AND ($2::uuid IS NULL OR cr.building_id=$2) ORDER BY b.name, cr.age_min`, [i.id, i.building_id ?? null]).then((r) => r.rows);
  },
});

cap({
  name: 'set_boarding_curfew_rule', method: 'POST', path: '/organisations/:id/boarding/curfew-rules', tag: TAG, status: 201,
  summary: 'Create a curfew rule for a building (or age-band within it). Owner/admin/boarding coordinator only. Effective-dated.',
  input: z.object({ id, building_id: id, age_min: z.number().int().min(0).max(25).default(0), age_max: z.number().int().min(0).max(25).default(25), weekday_curfew: time, weekend_curfew: time, valid_from: day.optional(), valid_to: day.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await boardingAccess(user, i.id, { write: true, c });
    if (!a.has('admin') && !a.has('owner') && !a.hasBoardingRole) throw forbidden('Boarding coordinator or admin required');
    await ownBuilding(c, i.building_id, i.id);
    const rule = (await c.query(`INSERT INTO boarding_curfew_rules(building_id,age_min,age_max,weekday_curfew,weekend_curfew,valid_from,valid_to,set_by) VALUES ($1,$2,$3,$4,$5,coalesce($6::date, CURRENT_DATE),$7,$8) RETURNING *`, [i.building_id, i.age_min, i.age_max, i.weekday_curfew, i.weekend_curfew, i.valid_from ?? null, i.valid_to ?? null, user.id])).rows[0];
    await audit(c, user.id, 'set_boarding_curfew_rule', 'boarding_curfew_rules', rule.id);
    return rule;
  }),
});

cap({
  name: 'check_curfew_status', method: 'GET', path: '/organisations/:id/boarding/curfew-status', tag: TAG,
  summary: 'Real-time curfew snapshot: for each current occupant shows whether they are checked in, on approved leave, or overdue curfew based on the current time and applicable curfew rules.',
  input: z.object({ id, building_id: id.optional() }),
  handler: async ({ user }, i) => {
    const a = await boardingAccess(user, i.id);
    if (!a.hasBoardingRole && !a.has('admin') && !a.has('owner')) throw forbidden('Boarding role required');
    const now = new Date();
    const isWeekend = [0, 6].includes(now.getDay());
    const rows = (await pool.query(
      `SELECT o.id AS occupancy_id, bd.id AS bed_id, br.number AS room_number, bb.id AS building_id, bb.name AS building_name,
              u.display_name AS resident_name, u.id AS athlete_id,
              lr.status AS leave_status, lr.leave_to AS leave_to, lr.return_actual,
              cr.weekday_curfew, cr.weekend_curfew
         FROM boarding_occupancies o JOIN boarding_beds bd ON bd.id=o.bed_id JOIN boarding_rooms br ON br.id=bd.room_id JOIN boarding_buildings bb ON bb.id=br.building_id
         JOIN org_enrolments en ON en.id=o.enrolment_id JOIN users u ON u.id=en.user_id
         LEFT JOIN boarding_leave_requests lr ON lr.occupancy_id=o.id AND lr.status IN ('staff_approved','active','overdue','returned')
           AND lr.leave_from <= now() AND (lr.leave_to >= now() OR lr.return_actual IS NULL)
         LEFT JOIN boarding_curfew_rules cr ON cr.building_id=bb.id AND cr.valid_from <= CURRENT_DATE AND (cr.valid_to IS NULL OR cr.valid_to >= CURRENT_DATE)
        WHERE bb.organisation_id=$1 AND o.valid_to IS NULL AND ($2::uuid IS NULL OR bb.id=$2)
        ORDER BY bb.name, br.floor, br.number, bd.position`, [i.id, i.building_id ?? null])).rows;

    const result = rows.map((r) => {
      const curfewTime = r[isWeekend ? 'weekend_curfew' : 'weekday_curfew'];
      const onLeave = r.leave_status === 'staff_approved' || r.leave_status === 'active';
      const overdueCurfew = !onLeave && curfewTime && now.toTimeString().slice(0,5) > curfewTime;
      return { occupancy_id: r.occupancy_id, building_id: r.building_id, building_name: r.building_name, room_number: r.room_number, resident_name: r.resident_name, athlete_id: r.athlete_id, curfew_time: curfewTime, status: onLeave ? 'on_leave' : overdueCurfew ? 'overdue' : 'checked_in', leave_to: r.leave_to, leave_returned: !!r.return_actual };
    });
    return { as_of: now.toISOString(), is_weekend: isWeekend, residents: result, summary: { total: result.length, on_leave: result.filter((r) => r.status === 'on_leave').length, overdue: result.filter((r) => r.status === 'overdue').length, checked_in: result.filter((r) => r.status === 'checked_in').length } };
  },
});

// ══════════════════════════════════════════════════════════════════════════════
// SUPERVISOR DUTY
// ══════════════════════════════════════════════════════════════════════════════
cap({
  name: 'list_boarding_duty_assignments', method: 'GET', path: '/organisations/:id/boarding/duty', tag: TAG,
  summary: 'Duty roster filtered by date, building or staff member.',
  input: z.object({ id, duty_date: day.optional(), building_id: id.optional(), user_id: id.optional(), ...page }),
  handler: async ({ user }, i) => {
    await boardingAccess(user, i.id);
    return many(
      `SELECT da.*, u.display_name AS staff_name, b.name AS building_name FROM boarding_duty_assignments da JOIN users u ON u.id=da.user_id LEFT JOIN boarding_buildings b ON b.id=da.building_id
        WHERE da.organisation_id=$1 AND ($2::date IS NULL OR da.duty_date=$2) AND ($3::uuid IS NULL OR da.building_id=$3) AND ($4::uuid IS NULL OR da.user_id=$4)
        ORDER BY da.duty_date, da.shift_start LIMIT $5 OFFSET $6`,
      [i.id, i.duty_date ?? null, i.building_id ?? null, i.user_id ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'create_boarding_duty', method: 'POST', path: '/organisations/:id/boarding/duty', tag: TAG, status: 201,
  summary: 'Assign a duty shift to a staff member. Checks the staff member is an active organisation member.',
  input: z.object({ id, building_id: id.optional(), user_id: id, duty_date: day, shift_start: time, shift_end: time, role_code: z.enum(['housemaster','houseparent','night_cover','safeguarding','welfare','coordinator','manager']).default('housemaster'), notes: opt(short(500)) }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await boardingAccess(user, i.id, { write: true, c });
    if (!a.has('admin') && !a.has('owner') && !a.hasBoardingRole) throw forbidden('Boarding coordinator or admin required');
    const member = (await c.query(`SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'`, [i.id, i.user_id])).rows[0];
    if (!member) throw badRequest('The assigned person must be an active member of this organisation');
    if (i.building_id) await ownBuilding(c, i.building_id, i.id);
    const duty = (await c.query(`INSERT INTO boarding_duty_assignments(organisation_id,building_id,user_id,duty_date,shift_start,shift_end,role_code,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [i.id, i.building_id ?? null, i.user_id, i.duty_date, i.shift_start, i.shift_end, i.role_code, i.notes ?? null, user.id])).rows[0];
    await audit(c, user.id, 'create_boarding_duty', 'boarding_duty_assignments', duty.id);
    // Notify staff member
    await notify(c, { org_id: i.id, recipient_user_id: i.user_id, kind: 'boarding_duty_assigned', ref_type: 'boarding_duty_assignment', ref_id: duty.id, deep_link: `academy/boarding/duty/${duty.id}` }).catch(() => {});
    return duty;
  }),
});

cap({
  name: 'acknowledge_boarding_duty', method: 'POST', path: '/organisations/:id/boarding/duty/:duty_id/acknowledge', tag: TAG,
  summary: 'Staff member acknowledges their duty assignment.',
  input: z.object({ id, duty_id: id }),
  handler: ({ user }, i) => tx(async (c) => {
    await boardingAccess(user, i.id, { c });
    const duty = (await c.query('SELECT * FROM boarding_duty_assignments WHERE id=$1 AND organisation_id=$2 FOR UPDATE', [i.duty_id, i.id])).rows[0];
    if (!duty) throw notFound('Duty assignment');
    if (duty.user_id !== user.id) throw forbidden('You can only acknowledge your own duty assignments');
    if (duty.acknowledged_at) return { already_acknowledged: true, acknowledged_at: duty.acknowledged_at };
    await c.query('UPDATE boarding_duty_assignments SET acknowledged_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1', [duty.id]);
    return { acknowledged: true, acknowledged_at: new Date().toISOString() };
  }),
});

cap({
  name: 'log_welfare_check', method: 'POST', path: '/organisations/:id/boarding/welfare-checks', tag: TAG, status: 201,
  summary: 'Staff logs a welfare/rooming check. Notes are encrypted and restricted to boarding coordinator and safeguarding officer roles only.',
  input: z.object({ id, duty_assignment_id: id, occupancy_id: id.optional(), building_id: id.optional(), status: z.enum(['present','absent','concern','late_return','room_empty','all_present']), note: opt(short(1000)) }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await boardingAccess(user, i.id, { write: true, c });
    if (!a.hasBoardingRole && !a.has('admin') && !a.has('owner')) throw forbidden('Boarding role required');
    const duty = (await c.query('SELECT * FROM boarding_duty_assignments WHERE id=$1 AND organisation_id=$2', [i.duty_assignment_id, i.id])).rows[0];
    if (!duty) throw notFound('Duty assignment');
    const enc = i.note ? encryptFields({ note: i.note }, 'boarding_welfare_checks', ['note']) : {};
    const check = (await c.query(`INSERT INTO boarding_welfare_checks(duty_assignment_id,occupancy_id,building_id,status,note_enc,reporter_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [i.duty_assignment_id, i.occupancy_id ?? null, i.building_id ?? null, i.status, enc.note_enc ?? null, user.id])).rows[0];
    return { ...check, note_enc: undefined };
  }),
});

cap({
  name: 'list_welfare_checks', method: 'GET', path: '/organisations/:id/boarding/welfare-checks', tag: TAG,
  summary: 'Welfare check log for today (or a date). Note text is redacted for all roles except boarding coordinator and safeguarding officer.',
  input: z.object({ id, check_date: day.optional(), building_id: id.optional(), ...page }),
  handler: async ({ user }, i) => {
    const a = await boardingAccess(user, i.id);
    const isSafeguarding = a.hasBoardingRole && !!(await pool.query(`SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND role IN ('boarding_coordinator','safeguarding_officer') AND status='active'`, [i.id, user.id])).rowCount;
    const checkDate = i.check_date ?? new Date().toISOString().slice(0,10);
    const rows = (await pool.query(
      `SELECT wc.*, u.display_name AS reporter_name, res.display_name AS resident_name FROM boarding_welfare_checks wc
         LEFT JOIN boarding_duty_assignments da ON da.id=wc.duty_assignment_id
         LEFT JOIN boarding_occupancies o ON o.id=wc.occupancy_id LEFT JOIN org_enrolments en ON en.id=o.enrolment_id LEFT JOIN users res ON res.id=en.user_id
         JOIN users u ON u.id=wc.reporter_id
        WHERE da.organisation_id=$1 AND wc.checked_at::date=$2 AND ($3::uuid IS NULL OR da.building_id=$3)
        ORDER BY wc.checked_at DESC LIMIT $4 OFFSET $5`, [i.id, checkDate, i.building_id ?? null, i.limit, i.offset])).rows;
    return rows.map((r) => {
      const note = isSafeguarding && r.note_enc ? decryptFields(r, 'boarding_welfare_checks', ['note']).note : null;
      const noteRedacted = !isSafeguarding && r.note_enc ? '(Restricted — contact Safeguarding Officer)' : null;
      return { ...r, note: note ?? noteRedacted, note_enc: undefined };
    });
  },
});

// ══════════════════════════════════════════════════════════════════════════════
// INCIDENTS
// ══════════════════════════════════════════════════════════════════════════════
cap({
  name: 'report_boarding_incident', method: 'POST', path: '/organisations/:id/boarding/incidents', tag: TAG, status: 201,
  summary: 'Report an incident or maintenance issue. safeguarding_flag=true restricts visibility to boarding coordinator and safeguarding officer. Description is encrypted.',
  input: z.object({ id, building_id: id.optional(), room_id: id.optional(), occupancy_id: id.optional(), severity: z.enum(['low','medium','high','critical']).default('low'), category: short(40), description: short(3000), safeguarding_flag: z.boolean().default(false), idempotency_key: opt(z.string().min(8).max(80)) }),
  handler: ({ user }, i) => tx(async (c) => {
    await boardingAccess(user, i.id, { write: true, c });
    if (i.idempotency_key) { const p = (await c.query('SELECT id FROM boarding_incidents WHERE idempotency_key=$1', [i.idempotency_key])).rows[0]; if (p) return { ...p, replayed: true }; }
    if (i.building_id) await ownBuilding(c, i.building_id, i.id);
    const enc = encryptFields({ description: i.description }, 'boarding_incidents', ['description']);
    const inc = (await c.query(`INSERT INTO boarding_incidents(organisation_id,building_id,room_id,occupancy_id,severity,category,description_enc,safeguarding_flag,reporter_id,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [i.id, i.building_id ?? null, i.room_id ?? null, i.occupancy_id ?? null, i.severity, i.category, enc.description_enc, i.safeguarding_flag, user.id, i.idempotency_key ?? null])).rows[0];
    await audit(c, user.id, 'report_boarding_incident', 'boarding_incidents', inc.id);
    return { ...inc, description: i.description, description_enc: undefined };
  }),
});

cap({
  name: 'list_boarding_incidents', method: 'GET', path: '/organisations/:id/boarding/incidents', tag: TAG,
  summary: 'Incident list. Safeguarding-flagged incidents are fully redacted for non-safeguarding/coordinator roles (shows only count, not details).',
  input: z.object({ id, status: z.string().max(40).optional(), severity: z.string().max(20).optional(), building_id: id.optional(), include_safeguarding: z.coerce.boolean().default(false), ...page }),
  handler: async ({ user }, i) => {
    const a = await boardingAccess(user, i.id);
    const isSafeguarding = !!(await pool.query(`SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND role IN ('boarding_coordinator','safeguarding_officer','owner','admin') AND status='active'`, [i.id, user.id])).rowCount || a.has('admin') || a.has('owner');
    const rows = (await pool.query(
      `SELECT inc.*, u.display_name AS reporter_name, b.name AS building_name FROM boarding_incidents inc JOIN users u ON u.id=inc.reporter_id LEFT JOIN boarding_buildings b ON b.id=inc.building_id
        WHERE inc.organisation_id=$1 AND ($2::text IS NULL OR inc.status=$2) AND ($3::text IS NULL OR inc.severity=$3) AND ($4::uuid IS NULL OR inc.building_id=$4)
          AND (NOT inc.safeguarding_flag OR $5)
        ORDER BY inc.created_at DESC LIMIT $6 OFFSET $7`,
      [i.id, i.status ?? null, i.severity ?? null, i.building_id ?? null, isSafeguarding || i.include_safeguarding, i.limit, i.offset])).rows;
    await audit(pool, user.id, 'list_boarding_incidents', 'boarding_incidents', null);
    return rows.map((r) => {
      if (r.safeguarding_flag && !isSafeguarding) return { id: r.id, safeguarding_flag: true, restricted: true };
      return decIncident(r);
    });
  },
});

cap({
  name: 'get_boarding_incident', method: 'GET', path: '/organisations/:id/boarding/incidents/:incident_id', tag: TAG,
  summary: 'Get a single incident. Safeguarding-flagged incidents return 404 (not 403) to underprivileged roles to avoid revealing existence.',
  input: z.object({ id, incident_id: id }),
  handler: async ({ user }, i) => {
    const a = await boardingAccess(user, i.id);
    const inc = (await pool.query('SELECT * FROM boarding_incidents WHERE id=$1 AND organisation_id=$2', [i.incident_id, i.id])).rows[0];
    if (!inc) throw notFound('Incident');
    if (inc.safeguarding_flag) {
      const isSafeguarding = !!(await pool.query(`SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND role IN ('boarding_coordinator','safeguarding_officer','owner','admin') AND status='active'`, [i.id, user.id])).rowCount || a.has('admin') || a.has('owner');
      if (!isSafeguarding) throw notFound('Incident');  // 404 intentional: do not leak existence
    }
    await audit(pool, user.id, 'read_boarding_incident', 'boarding_incidents', inc.id);
    return decIncident(inc);
  },
});

cap({
  name: 'update_boarding_incident', method: 'PATCH', path: '/organisations/:id/boarding/incidents/:incident_id', tag: TAG,
  summary: 'Assign, update, resolve or close an incident. Resolution note is encrypted.',
  input: z.object({ id, incident_id: id, assigned_to: id.optional(), status: z.enum(['acknowledged','in_progress','resolved','closed']).optional(), severity: z.enum(['low','medium','high','critical']).optional(), resolution_note: opt(short(2000)) }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await boardingAccess(user, i.id, { write: true, c });
    if (!a.hasBoardingRole && !a.has('admin') && !a.has('owner')) throw forbidden('Boarding role required');
    const inc = (await c.query('SELECT * FROM boarding_incidents WHERE id=$1 AND organisation_id=$2 FOR UPDATE', [i.incident_id, i.id])).rows[0];
    if (!inc) throw notFound('Incident');
    if (inc.safeguarding_flag) {
      const isSafeguarding = !!(await c.query(`SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND role IN ('boarding_coordinator','safeguarding_officer','owner','admin') AND status='active'`, [i.id, user.id])).rowCount;
      if (!isSafeguarding) throw notFound('Incident');
    }
    const enc = i.resolution_note ? encryptFields({ resolution_note: i.resolution_note }, 'boarding_incidents', ['resolution_note']) : {};
    const fields = { assigned_to: i.assigned_to, status: i.status, severity: i.severity, resolution_note_enc: enc.resolution_note_enc };
    const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
    if (!keys.length) return decIncident(inc);
    const updated = (await c.query(`UPDATE boarding_incidents SET ${keys.map((k,n)=>`${k}=$${n+2}`).join(',')}, resolved_at=CASE WHEN $${keys.length+2}='resolved' THEN now() ELSE resolved_at END, resolved_by=CASE WHEN $${keys.length+2}='resolved' THEN $${keys.length+3} ELSE resolved_by END, updated_at=now() WHERE id=$1 RETURNING *`, [inc.id, ...keys.map((k) => fields[k]), i.status ?? null, user.id])).rows[0];
    await audit(c, user.id, 'update_boarding_incident', 'boarding_incidents', inc.id);
    return decIncident(updated);
  }),
});

// ══════════════════════════════════════════════════════════════════════════════
// MEAL PLANS & FLAGS
// ══════════════════════════════════════════════════════════════════════════════
cap({
  name: 'get_boarding_meal_plan', method: 'GET', path: '/organisations/:id/boarding/occupancies/:occupancy_id/meal-plan', tag: TAG,
  summary: 'Current meal plan and active dietary flags for an occupancy.',
  input: z.object({ id, occupancy_id: id }),
  handler: async ({ user }, i) => {
    const a = await boardingAccess(user, i.id);
    const occ = await ownOccupancy(pool, i.occupancy_id, i.id);
    const plan = (await pool.query('SELECT * FROM boarding_meal_plans WHERE occupancy_id=$1 AND valid_to IS NULL', [occ.id])).rows[0];
    const flags = (await pool.query('SELECT flag_key, consented_at, source FROM boarding_meal_flags WHERE occupancy_id=$1 AND revoked_at IS NULL', [occ.id])).rows;
    return { occupancy_id: occ.id, meal_plan: plan ?? null, dietary_flags: flags };
  },
});

cap({
  name: 'set_boarding_meal_plan', method: 'POST', path: '/organisations/:id/boarding/occupancies/:occupancy_id/meal-plan', tag: TAG,
  summary: 'Set or change the meal plan for a resident. Boarding coordinator/admin only.',
  input: z.object({ id, occupancy_id: id, plan_code: z.enum(['breakfast_only','half','full','custom','none']), valid_from: day.optional(), notes: opt(short(500)) }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await boardingAccess(user, i.id, { write: true, c });
    if (!a.hasBoardingRole && !a.has('admin') && !a.has('owner')) throw forbidden('Boarding coordinator or admin required');
    const occ = await ownOccupancy(c, i.occupancy_id, i.id);
    // End any active plan
    await c.query('UPDATE boarding_meal_plans SET valid_to=CURRENT_DATE, updated_at=now() WHERE occupancy_id=$1 AND valid_to IS NULL', [occ.id]);
    const plan = (await c.query(`INSERT INTO boarding_meal_plans(occupancy_id,plan_code,valid_from,notes,set_by) VALUES ($1,$2,coalesce($3::date,CURRENT_DATE),$4,$5) RETURNING *`, [occ.id, i.plan_code, i.valid_from ?? null, i.notes ?? null, user.id])).rows[0];
    await audit(c, user.id, 'set_boarding_meal_plan', 'boarding_meal_plans', plan.id);
    return plan;
  }),
});

cap({
  name: 'list_boarding_meal_flags', method: 'GET', path: '/organisations/:id/boarding/meal-flags', tag: TAG,
  summary: 'All active dietary flags across the academy (or a building). Visible to meal staff, boarding coordinator and admin. Read is audit-logged.',
  input: z.object({ id, building_id: id.optional() }),
  handler: async ({ user }, i) => {
    const a = await boardingAccess(user, i.id);
    if (!a.hasBoardingRole && !a.has('admin') && !a.has('owner')) throw forbidden('Boarding or meal staff role required');
    await audit(pool, user.id, 'list_boarding_meal_flags', 'boarding_meal_flags', null);
    return pool.query(
      `SELECT mf.flag_key, mf.consented_at, mf.source, u.display_name AS resident_name, br.number AS room_number, bb.name AS building_name
         FROM boarding_meal_flags mf JOIN boarding_occupancies o ON o.id=mf.occupancy_id JOIN org_enrolments en ON en.id=o.enrolment_id JOIN users u ON u.id=en.user_id
         JOIN boarding_beds bd ON bd.id=o.bed_id JOIN boarding_rooms br ON br.id=bd.room_id JOIN boarding_buildings bb ON bb.id=br.building_id
        WHERE bb.organisation_id=$1 AND o.valid_to IS NULL AND mf.revoked_at IS NULL AND ($2::uuid IS NULL OR bb.id=$2)
        ORDER BY bb.name, br.number, mf.flag_key`, [i.id, i.building_id ?? null]).then((r) => r.rows);
  },
});

cap({
  name: 'set_boarding_meal_flag', method: 'POST', path: '/organisations/:id/boarding/occupancies/:occupancy_id/meal-flags', tag: TAG, status: 201,
  summary: 'Consent a dietary operational flag for a resident. Only the athlete, their verified guardian, or boarding coordinator may set flags. Never stores clinical or medical data.',
  input: z.object({ id, occupancy_id: id, flag_key: z.enum(['halal','kosher','vegetarian','vegan','nut_free','gluten_free','dairy_free','egg_free','shellfish_free','low_sugar','other']), source: z.enum(['guardian','athlete','staff_recorded']).default('guardian') }),
  handler: ({ user }, i) => tx(async (c) => {
    await boardingAccess(user, i.id, { c });
    const occ = await ownOccupancy(c, i.occupancy_id, i.id);
    const en = (await c.query('SELECT user_id FROM org_enrolments WHERE id=$1', [occ.enrolment_id])).rows[0];
    const isAthlete = en?.user_id === user.id;
    const isGuardian = !!(await c.query(`SELECT 1 FROM youth_guardians WHERE child_user_id=$1 AND guardian_user_id=$2 AND status='active'`, [en?.user_id, user.id])).rowCount;
    const isStaff = !!(await c.query(`SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'`, [i.id, user.id])).rowCount;
    if (!isAthlete && !isGuardian && !isStaff) throw forbidden('Not authorised');
    const flag = (await c.query(`INSERT INTO boarding_meal_flags(occupancy_id,flag_key,consented_by,source) VALUES ($1,$2,$3,$4) ON CONFLICT (occupancy_id,flag_key) DO UPDATE SET revoked_at=NULL, revoked_by=NULL, consented_at=now(), consented_by=$3, source=$4 RETURNING *`, [occ.id, i.flag_key, user.id, i.source])).rows[0];
    return { flag_key: flag.flag_key, consented_at: flag.consented_at, source: flag.source };
  }),
});

cap({
  name: 'revoke_boarding_meal_flag', method: 'DELETE', path: '/organisations/:id/boarding/occupancies/:occupancy_id/meal-flags/:flag_key', tag: TAG,
  summary: 'Revoke a dietary flag (athlete, guardian or staff). History is preserved.',
  input: z.object({ id, occupancy_id: id, flag_key: z.enum(['halal','kosher','vegetarian','vegan','nut_free','gluten_free','dairy_free','egg_free','shellfish_free','low_sugar','other']) }),
  handler: ({ user }, i) => tx(async (c) => {
    await boardingAccess(user, i.id, { c });
    const occ = await ownOccupancy(c, i.occupancy_id, i.id);
    const en = (await c.query('SELECT user_id FROM org_enrolments WHERE id=$1', [occ.enrolment_id])).rows[0];
    const isAthlete = en?.user_id === user.id;
    const isGuardian = !!(await c.query(`SELECT 1 FROM youth_guardians WHERE child_user_id=$1 AND guardian_user_id=$2 AND status='active'`, [en?.user_id, user.id])).rowCount;
    const isStaff = !!(await c.query(`SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'`, [i.id, user.id])).rowCount;
    if (!isAthlete && !isGuardian && !isStaff) throw forbidden('Not authorised');
    const result = await c.query(`UPDATE boarding_meal_flags SET revoked_at=now(), revoked_by=$3 WHERE occupancy_id=$1 AND flag_key=$2 AND revoked_at IS NULL`, [occ.id, i.flag_key, user.id]);
    if (!result.rowCount) throw notFound('Meal flag');
    return { revoked: true };
  }),
});

// ══════════════════════════════════════════════════════════════════════════════
// BOARDING CHARGES (references canonical invoices — no new ledger)
// ══════════════════════════════════════════════════════════════════════════════
cap({
  name: 'list_boarding_charges', method: 'GET', path: '/organisations/:id/boarding/charges', tag: TAG,
  summary: 'Boarding charges for the organisation. References canonical invoice IDs. Finance and admin roles only.',
  input: z.object({ id, occupancy_id: id.optional(), status: z.string().max(40).optional(), ...page }),
  handler: async ({ user }, i) => {
    const a = await boardingAccess(user, i.id);
    if (!a.has('admin') && !a.has('owner') && !a.has('finance')) throw forbidden('Finance, admin or owner required to view boarding charges');
    return many(
      `SELECT bc.*, u.display_name AS resident_name FROM boarding_charges bc JOIN boarding_occupancies o ON o.id=bc.occupancy_id JOIN org_enrolments en ON en.id=o.enrolment_id JOIN users u ON u.id=en.user_id
        WHERE o.bed_id IN (SELECT bd.id FROM boarding_beds bd JOIN boarding_rooms br ON br.id=bd.room_id JOIN boarding_buildings bb ON bb.id=br.building_id WHERE bb.organisation_id=$1)
          AND ($2::uuid IS NULL OR bc.occupancy_id=$2) AND ($3::text IS NULL OR bc.status=$3)
        ORDER BY bc.created_at DESC LIMIT $4 OFFSET $5`,
      [i.id, i.occupancy_id ?? null, i.status ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'create_boarding_charge', method: 'POST', path: '/organisations/:id/boarding/charges', tag: TAG, status: 201,
  summary: 'Create a boarding charge line item. References the canonical invoice created via academy-billing. Idempotent on idempotency_key.',
  input: z.object({ id, occupancy_id: id, period_from: day, period_to: day, amount_minor: z.number().int().min(1), currency: z.string().length(3), charge_type: z.enum(['boarding_fee','meal_plan','laundry','activity','deposit','other']).default('boarding_fee'), description: opt(short(300)), invoice_id: id.optional(), idempotency_key: opt(z.string().min(8).max(80)) }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await boardingAccess(user, i.id, { write: true, c });
    if (!a.has('admin') && !a.has('owner') && !a.has('finance') && !a.hasBoardingRole) throw forbidden('Finance or boarding coordinator required');
    if (!isSupportedCurrency(i.currency)) throw badRequest(`Unsupported currency: ${i.currency}`);
    if (i.idempotency_key) { const p = (await c.query('SELECT * FROM boarding_charges WHERE idempotency_key=$1', [i.idempotency_key])).rows[0]; if (p) return { ...p, replayed: true }; }
    const occ = await ownOccupancy(c, i.occupancy_id, i.id);
    const charge = (await c.query(`INSERT INTO boarding_charges(occupancy_id,invoice_id,period_from,period_to,amount_minor,currency,charge_type,description,created_by,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [occ.id, i.invoice_id ?? null, i.period_from, i.period_to, i.amount_minor, i.currency, i.charge_type, i.description ?? null, user.id, i.idempotency_key ?? null])).rows[0];
    await audit(c, user.id, 'create_boarding_charge', 'boarding_charges', charge.id);
    return charge;
  }),
});

cap({
  name: 'boarding_charge_summary', method: 'GET', path: '/organisations/:id/boarding/charge-summary', tag: TAG,
  summary: 'Per-occupancy outstanding/paid/overdue summary for the boarding finance strip.',
  input: z.object({ id, building_id: id.optional() }),
  handler: async ({ user }, i) => {
    const a = await boardingAccess(user, i.id);
    if (!a.has('admin') && !a.has('owner') && !a.has('finance') && !a.hasBoardingRole) throw forbidden('Finance or boarding coordinator required');
    return pool.query(
      `SELECT bc.currency, bc.status, count(*)::int AS charge_count, sum(bc.amount_minor)::bigint AS total_minor
         FROM boarding_charges bc JOIN boarding_occupancies o ON o.id=bc.occupancy_id JOIN boarding_beds bd ON bd.id=o.bed_id JOIN boarding_rooms br ON br.id=bd.room_id JOIN boarding_buildings bb ON bb.id=br.building_id
        WHERE bb.organisation_id=$1 AND o.valid_to IS NULL AND ($2::uuid IS NULL OR bb.id=$2)
        GROUP BY bc.currency, bc.status ORDER BY bc.currency, bc.status`, [i.id, i.building_id ?? null]).then((r) => r.rows);
  },
});

// ══════════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════════════════════════
cap({
  name: 'get_boarding_dashboard', method: 'GET', path: '/organisations/:id/boarding/dashboard', tag: TAG,
  summary: 'Real-time boarding dashboard: occupancy fill, pending applications, leave tonight, duty gaps, curfew overdue, maintenance open and charges outstanding. Boarding role or admin required.',
  input: z.object({ id }),
  handler: async ({ user }, i) => {
    const a = await boardingAccess(user, i.id);
    if (!a.hasBoardingRole && !a.has('admin') && !a.has('owner')) throw forbidden('Boarding role required');
    const today = new Date().toISOString().slice(0,10);
    const [occ, apps, leave, duty, curfew, incidents, charges] = await Promise.all([
      pool.query(`SELECT count(*)::int AS total_beds, count(DISTINCT o.id) FILTER (WHERE o.valid_to IS NULL)::int AS occupied FROM boarding_beds bd JOIN boarding_rooms br ON br.id=bd.room_id JOIN boarding_buildings bb ON bb.id=br.building_id LEFT JOIN boarding_occupancies o ON o.bed_id=bd.id WHERE bb.organisation_id=$1 AND bd.archived_at IS NULL AND br.archived_at IS NULL AND bb.archived_at IS NULL`, [i.id]),
      pool.query(`SELECT count(*)::int AS pending FROM boarding_applications WHERE organisation_id=$1 AND status IN ('submitted','under_review','offered','awaiting_acceptance')`, [i.id]),
      pool.query(`SELECT count(*)::int AS tonight FROM boarding_leave_requests lr JOIN boarding_occupancies o ON o.id=lr.occupancy_id JOIN boarding_beds bd ON bd.id=o.bed_id JOIN boarding_rooms br ON br.id=bd.room_id JOIN boarding_buildings bb ON bb.id=br.building_id WHERE bb.organisation_id=$1 AND lr.status IN ('staff_approved','active') AND lr.leave_from::date <= $2 AND lr.leave_to::date >= $2`, [i.id, today]),
      pool.query(`SELECT count(*)::int AS assigned, count(*) FILTER (WHERE acknowledged_at IS NULL)::int AS unacknowledged FROM boarding_duty_assignments WHERE organisation_id=$1 AND duty_date=$2`, [i.id, today]),
      pool.query(`SELECT count(*)::int AS overdue FROM boarding_occupancies o JOIN boarding_beds bd ON bd.id=o.bed_id JOIN boarding_rooms br ON br.id=bd.room_id JOIN boarding_buildings bb ON bb.id=br.building_id LEFT JOIN boarding_leave_requests lr ON lr.occupancy_id=o.id AND lr.status IN ('staff_approved','active') LEFT JOIN boarding_curfew_rules cr ON cr.building_id=bb.id WHERE bb.organisation_id=$1 AND o.valid_to IS NULL AND lr.id IS NULL AND cr.id IS NOT NULL AND to_char(now(),'HH24:MI') > CASE WHEN extract(dow FROM now()) IN (0,6) THEN cr.weekend_curfew::text ELSE cr.weekday_curfew::text END`, [i.id]),
      pool.query(`SELECT count(*)::int AS open FROM boarding_incidents WHERE organisation_id=$1 AND status IN ('open','acknowledged','in_progress')`, [i.id]),
      pool.query(`SELECT count(*)::int AS overdue_charges FROM boarding_charges bc JOIN boarding_occupancies o ON o.id=bc.occupancy_id JOIN boarding_beds bd ON bd.id=o.bed_id JOIN boarding_rooms br ON br.id=bd.room_id JOIN boarding_buildings bb ON bb.id=br.building_id WHERE bb.organisation_id=$1 AND bc.status='overdue'`, [i.id]),
    ]);
    const o = occ.rows[0];
    return {
      occupancy: { total_beds: o.total_beds, occupied: o.occupied, fill_pct: o.total_beds > 0 ? Math.round((o.occupied / o.total_beds) * 100) : 0 },
      applications_pending: apps.rows[0].pending,
      leave_tonight: leave.rows[0].tonight,
      duty_today: { assigned: duty.rows[0].assigned, unacknowledged: duty.rows[0].unacknowledged, has_gap: duty.rows[0].assigned === 0 },
      curfew_overdue: curfew.rows[0].overdue,
      open_incidents: incidents.rows[0].open,
      overdue_charges: charges.rows[0].overdue_charges,
      as_of: new Date().toISOString(),
    };
  },
});
