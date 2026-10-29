// Event accreditation (#481): role badges, access zones, QR credentials, validity and revocation.
// The organiser defines zones and categories (who is eligible, which zones, when); people apply, are nominated by the authority that really
// manages them (team manager, department lead, organiser) and are approved; an approved person holds a credential whose QR carries no personal
// data. Gate staff scan it and the server answers valid / wrong zone / expired / revoked ... from live data, so a revocation or reissue is
// effective on the next scan on every surface. Eligibility is read from the canonical engagements (see src/accreditation.js); nothing is copied.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { pool, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, mustFind } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { revokeGrantsForSource } from '../access-grants.js';
import { YOUTH_SQL } from '../youth.js';
import { gate } from '../compliance/service.js';
import { canManageTeam } from './teams.js';
import { departmentScope } from './event-departments.js';
import {
  ENGAGEMENTS, ZONE_KINDS, OPEN_STATUSES, VENDOR_TO_ENGAGEMENT, WINDOW_SQL, blocker, categoryOf, eligibleFor, engagementsOf, effectiveStatus, gateView, isGateOperator, judge, newSerial, record, syncRosterFlag, tokenFor,
} from '../accreditation.js';

const TAG = 'Accreditation';
const ENG = Object.keys(ENGAGEMENTS), ZONES = Object.keys(ZONE_KINDS);
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use HH:MM');
const when = z.string().datetime({ offset: true });
const colour = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const zoneName = z.string().trim().min(2).max(80);
const NOTE = 'accreditations.note';
const tzOk = (tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };
const dup = (e, what) => { if (e.code === '23505') throw conflict(`${what} already exists`); throw e; };

const eventOf = (eventId, c) => mustFind('events', eventId, '*', c);
async function organiserOnly(user, ev, c) {
  const scope = await departmentScope(user, ev, c);
  if (!scope.organiser) throw forbidden('Only the organiser can do that');
  return scope;
}

/** Who the caller is for accreditation at this event: organiser, department lead, and the teams they manage. */
async function authority(user, ev, c = pool) {
  const scope = await departmentScope(user, ev, c);
  const teams = new Set();
  for (const t of (await c.query("SELECT DISTINCT t.* FROM event_entries en JOIN teams t ON t.id=en.team_id WHERE en.event_id=$1 AND en.status='accepted'", [ev.id])).rows) if (await canManageTeam(user, t)) teams.add(t.id);
  // accepted vendors and sponsors the caller runs: they nominate their own crew
  const vendors = new Map((await c.query("SELECT id, kind FROM event_vendors WHERE event_id=$1 AND vendor_user_id=$2 AND status='accepted'", [ev.id, user.id])).rows.map((v) => [v.id, v]));
  return { ...scope, teams, vendors };
}
const mayApprove = (auth, user, acc, cat) => auth.organiser || (cat.approval === 'department_lead' && acc.department_id && auth.led.has(acc.department_id) && acc.holder_id !== user.id);
const maySee = (auth, user, acc) => auth.organiser || acc.holder_id === user.id || acc.nominated_by === user.id || (acc.department_id && auth.led.has(acc.department_id)) || (acc.team_id && auth.teams.has(acc.team_id)) || (acc.vendor_id && auth.vendors.has(acc.vendor_id));

const ROW = `a.id, a.event_id, a.category_id, a.holder_id, a.origin, a.team_id, a.department_id, a.nominated_by, a.status, a.access, a.serial, a.credential_version, a.issued_at, a.reason, a.submitted_at, a.decided_at,
  ${WINDOW_SQL}, k.name AS category, k.colour, k.approval, k.escort_required, k.vehicle_access, k.equipment_access, k.requires_photo, e.name AS event, e.starts_on, e.ends_on,
  u.display_name, u.handle, u.avatar_emoji, u.avatar_color, CASE WHEN ${YOUTH_SQL} THEN NULL ELSE u.avatar_url END AS avatar_url, ${YOUTH_SQL} AS youth`;
const FROM = 'FROM accreditations a JOIN accreditation_categories k ON k.id=a.category_id JOIN events e ON e.id=a.event_id JOIN users u ON u.id=a.holder_id';

const decorate = (r) => ({ ...r, effective_status: effectiveStatus(r) });
async function load(c, accId, lock = false) {
  const a = (await c.query(`SELECT * FROM accreditations WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [accId])).rows[0];
  if (!a) throw notFound('Accreditation');
  return a;
}
const rowOf = async (c, accId) => decorate((await c.query(`SELECT ${ROW} ${FROM} WHERE a.id=$1`, [accId])).rows[0]);
const ping = (c, userId, ev, title, body, accId) => notify(c, userId, { kind: 'accreditation', title, body, data: { event_id: ev.id, accreditation_id: accId } });

/** Approve and issue: capacity, prerequisites and consent are re-checked here so every path (decision, auto, invitation) obeys the same rules. */
async function approveRow(c, ev, cat, acc, actor, why) {
  if (cat.capacity) {
    const n = (await c.query("SELECT count(*)::int AS n FROM accreditations WHERE category_id=$1 AND status='approved' AND id <> $2", [cat.id, acc.id])).rows[0].n;
    if (n >= cat.capacity) throw conflict('This category is full', { code: 'category_full' });
  }
  const block = await blocker(c, ev, cat, acc.holder_id, { invited: acc.origin === 'invitation' });
  if (block) throw conflict(block, { code: 'not_approvable' });
  // the compliance engine (#568): permits, training, background checks and consent that the rules in force require before a badge is issued
  await gate(c, { actor: { id: actor }, domain: 'accreditation', subject_type: 'person', subject_id: acc.holder_id, context: { event_id: ev.id, category_roles: cat.eligible }, trigger: 'accreditation_approve' });
  const version = acc.credential_version + 1;
  const r = (await c.query(
    `UPDATE accreditations SET status='approved', access='active', serial=coalesce(serial, $2), credential_version=$3, issued_at=now(), issued_by=$4, decided_by=$4, decided_at=now(), reason=NULL WHERE id=$1 RETURNING *`,
    [acc.id, newSerial(), version, actor])).rows[0];
  await record(c, acc.id, actor, 'approved', acc.status, 'approved', null, why);
  await record(c, acc.id, actor, 'issued', 'approved', 'approved', version, null);
  await syncRosterFlag(c, r);
  await ping(c, acc.holder_id, ev, 'Your accreditation is ready', `${cat.name} for ${ev.name}. Open it to show the QR code at the gate.`, acc.id);
  return r;
}

/** An automatic approval that the compliance rules stop is not an error: the application simply stays submitted until someone decides it. */
async function approveOrHold(c, ev, cat, row, actor, why) {
  try { return await approveRow(c, ev, cat, row, actor, why); } catch (e) { if (e.details?.code === 'compliance_blocked') return row; throw e; }
}

async function create(c, ev, cat, holderId, { origin, nominatedBy = null, teamId = null, departmentId = null, vendorId = null, actor, draft = false }) {
  const existing = (await c.query(`SELECT * FROM accreditations WHERE category_id=$1 AND holder_id=$2 AND status IN ('draft','submitted','under_review','approved')`, [cat.id, holderId])).rows[0];
  if (existing) return { row: existing, created: false };
  if (!departmentId) departmentId = (await c.query("SELECT department_id FROM event_department_members WHERE event_id=$1 AND user_id=$2 AND status='active' ORDER BY joined_at LIMIT 1", [ev.id, holderId])).rows[0]?.department_id ?? null;
  let row = (await c.query(
    `INSERT INTO accreditations(event_id, category_id, holder_id, origin, nominated_by, team_id, department_id, vendor_id, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [ev.id, cat.id, holderId, origin, nominatedBy, teamId, departmentId, vendorId, draft ? 'draft' : 'submitted'])).rows[0];
  await record(c, row.id, actor, draft ? 'drafted' : 'submitted', null, row.status, null, origin);
  await syncRosterFlag(c, row);
  if (!draft && (origin === 'invitation' || cat.approval === 'auto')) row = await approveOrHold(c, ev, cat, row, origin === 'invitation' ? actor : null, origin === 'invitation' ? 'invited by the organiser' : 'auto-approved');
  else if (origin !== 'self') await ping(c, holderId, ev, 'You were nominated for accreditation', `${cat.name} for ${ev.name}.`, row.id);
  return { row, created: true };
}

// ---- scheme: zones and categories -------------------------------------------------------------------------------------------------------------------

cap({
  name: 'list_accreditation_kinds', method: 'GET', path: '/accreditation-kinds', tag: TAG, auth: 'public',
  summary: 'The vocabulary of accreditation: zone kinds and the canonical engagements (athlete, team staff, official, medical, media, vendor ...) that make a person eligible for a category.',
  input: z.object({}),
  handler: async () => ({ zone_kinds: Object.entries(ZONE_KINDS).map(([key, label]) => ({ key, label })), engagements: Object.entries(ENGAGEMENTS).map(([key, e]) => ({ key, ...e })) }),
});

cap({
  name: 'create_accreditation_zone', method: 'POST', path: '/events/:id/accreditation/zones', tag: TAG, status: 201,
  summary: 'Organiser: define an access zone of the event (field of play, athlete area, locker room, officials room, media centre, mixed zone, hospitality, operations, loading/service area or a custom one), optionally tied to one of the event\'s venues.',
  input: z.object({ id, name: zoneName, kind: z.enum(ZONES).default('custom'), venue_id: id.optional(), description: z.string().trim().max(300).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const ev = await eventOf(i.id, c);
    await organiserOnly(user, ev, c);
    if (i.venue_id) await mustFind('venues', i.venue_id, 'id', c);
    try { return (await c.query('INSERT INTO accreditation_zones(event_id, name, kind, venue_id, description, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [ev.id, i.name, i.kind, i.venue_id ?? null, i.description ?? null, user.id])).rows[0]; } catch (e) { dup(e, 'A zone with that name'); }
  }),
});

cap({
  name: 'update_accreditation_zone', method: 'PATCH', path: '/accreditation/zones/:id', tag: TAG,
  summary: 'Organiser: rename a zone or archive it (kept for history; archived zones stop admitting anyone on the next scan).',
  input: z.object({ id, name: zoneName.optional(), kind: z.enum(ZONES).optional(), venue_id: id.nullable().optional(), description: z.string().trim().max(300).nullable().optional(), archived: z.boolean().optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const z = await mustFind('accreditation_zones', i.id, '*', c);
    await organiserOnly(user, await eventOf(z.event_id, c), c);
    if (i.venue_id) await mustFind('venues', i.venue_id, 'id', c);
    try {
      return (await c.query(
        `UPDATE accreditation_zones SET name=coalesce($2,name), kind=coalesce($3,kind), venue_id=CASE WHEN $4::boolean THEN $5 ELSE venue_id END, description=CASE WHEN $6::boolean THEN $7 ELSE description END,
                archived_at=CASE WHEN $8::boolean IS NULL THEN archived_at WHEN $8 THEN coalesce(archived_at, now()) ELSE NULL END WHERE id=$1 RETURNING *`,
        [i.id, i.name ?? null, i.kind ?? null, i.venue_id !== undefined, i.venue_id ?? null, i.description !== undefined, i.description ?? null, i.archived ?? null])).rows[0];
    } catch (e) { dup(e, 'A zone with that name'); }
  }),
});

cap({
  name: 'list_accreditation_zones', method: 'GET', path: '/events/:id/accreditation/zones', tag: TAG,
  summary: 'Zones of the event (organiser, department leads and gate staff).',
  input: z.object({ id, archived: z.coerce.boolean().default(false) }),
  async handler({ user }, i) {
    const ev = await eventOf(i.id);
    const scope = await departmentScope(user, ev);
    if (!scope.organiser && !scope.led.size && !(await isGateOperator(user, ev))) throw forbidden('Only event accreditation staff can see the zones');
    return many(
      `SELECT z.*, v.name AS venue FROM accreditation_zones z LEFT JOIN venues v ON v.id=z.venue_id WHERE z.event_id=$1 AND ($2::boolean OR z.archived_at IS NULL) ORDER BY z.archived_at NULLS FIRST, z.name`, [ev.id, i.archived]);
  },
});

const categoryFields = {
  name: z.string().trim().min(2).max(80),
  eligible: z.array(z.enum(ENG)).min(1).max(ENG.length).describe('canonical engagements that make a person eligible; "guest" lets the organiser invite people with no other role'),
  zone_ids: z.array(id).max(50).describe('zones this credential opens'),
  colour: colour,
  venue_id: id.nullable().describe('restrict to one site of a multi-venue event'),
  valid_from: when.nullable().describe('default: the first event day'), valid_to: when.nullable().describe('default: the last event day'),
  daily_from: clock.nullable(), daily_to: clock.nullable(),
  timezone: z.string().max(60).refine(tzOk, 'unknown time zone'),
  escort_required: z.boolean(), vehicle_access: z.boolean(), equipment_access: z.boolean(),
  requires_verification: z.enum(['gamer', 'coach', 'physio', 'doctor']).nullable().describe('a current platform verification the person must hold'),
  requires_photo: z.boolean().describe('show the profile photo at the gate (never for young people)'),
  approval: z.enum(['organiser', 'department_lead', 'auto']),
  self_apply: z.boolean().describe('eligible people may apply themselves'),
  capacity: z.number().int().min(1).max(100000).nullable(),
};
async function checkScheme(c, ev, i) {
  if (i.zone_ids?.length) {
    const ok = (await c.query('SELECT id FROM accreditation_zones WHERE event_id=$1 AND archived_at IS NULL AND id = ANY($2::uuid[])', [ev.id, i.zone_ids])).rowCount;
    if (ok !== new Set(i.zone_ids).size) throw badRequest('A zone does not belong to this event');
  }
  if (i.venue_id) await mustFind('venues', i.venue_id, 'id', c);
  if (i.valid_from && i.valid_to && i.valid_to <= i.valid_from) throw badRequest('valid_to must be after valid_from');
}
const setZones = async (c, catId, zoneIds) => {
  const keep = [...new Set(zoneIds)];
  await c.query('UPDATE accreditation_category_zones SET removed_at=now() WHERE category_id=$1 AND removed_at IS NULL AND NOT (zone_id = ANY($2::uuid[]))', [catId, keep]);
  for (const z of keep) await c.query('INSERT INTO accreditation_category_zones(category_id, zone_id) VALUES ($1,$2) ON CONFLICT (category_id, zone_id) DO UPDATE SET removed_at=NULL', [catId, z]);
};

cap({
  name: 'create_accreditation_category', method: 'POST', path: '/events/:id/accreditation/categories', tag: TAG, status: 201,
  summary: 'Organiser: define an accreditation rule: who is eligible (canonical roles at the event), which zones, the validity window (dates and optional daily hours), site restriction, escort, vehicle/equipment privileges, a required verification, the approval authority and whether people may apply themselves.',
  input: z.object({ id, ...categoryFields, colour: categoryFields.colour.default('#7C3AED'), zone_ids: categoryFields.zone_ids.default([]), venue_id: categoryFields.venue_id.optional(), valid_from: categoryFields.valid_from.optional(), valid_to: categoryFields.valid_to.optional(),
    daily_from: categoryFields.daily_from.optional(), daily_to: categoryFields.daily_to.optional(), timezone: categoryFields.timezone.default('UTC'), escort_required: z.boolean().default(false), vehicle_access: z.boolean().default(false), equipment_access: z.boolean().default(false),
    requires_verification: categoryFields.requires_verification.optional(), requires_photo: z.boolean().default(false), approval: categoryFields.approval.default('organiser'), self_apply: z.boolean().default(false), capacity: categoryFields.capacity.optional() })
    .refine((i) => !!i.daily_from === !!i.daily_to, 'Give both daily_from and daily_to'),
  handler: ({ user }, i) => tx(async (c) => {
    const ev = await eventOf(i.id, c);
    await organiserOnly(user, ev, c);
    await checkScheme(c, ev, i);
    if (i.self_apply && i.eligible.every((e) => e === 'guest')) throw badRequest('Guests are invited by the organiser; they cannot apply themselves');
    let cat;
    try {
      cat = (await c.query(
        `INSERT INTO accreditation_categories(event_id, name, eligible, colour, venue_id, valid_from, valid_to, daily_from, daily_to, timezone, escort_required, vehicle_access, equipment_access, requires_verification, requires_photo, approval, self_apply, capacity, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
        [ev.id, i.name, [...new Set(i.eligible)], i.colour, i.venue_id ?? null, i.valid_from ?? null, i.valid_to ?? null, i.daily_from ?? null, i.daily_to ?? null, i.timezone, i.escort_required, i.vehicle_access, i.equipment_access,
          i.requires_verification ?? null, i.requires_photo, i.approval, i.self_apply, i.capacity ?? null, user.id])).rows[0];
    } catch (e) { dup(e, 'A category with that name'); }
    await setZones(c, cat.id, i.zone_ids);
    return { ...cat, zone_ids: [...new Set(i.zone_ids)] };
  }),
});

cap({
  name: 'update_accreditation_category', method: 'PATCH', path: '/accreditation/categories/:id', tag: TAG,
  summary: 'Organiser: change a category or archive it. Changes apply to the next scan of every credential in it (zones, hours and the window are read live); archived categories take no new applications and issued credentials stay valid until revoked.',
  input: z.object({ id }).extend(Object.fromEntries(Object.entries(categoryFields).map(([k, v]) => [k, v.optional()]))).extend({ archived: z.boolean().optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const cat = await mustFind('accreditation_categories', i.id, '*', c);
    const ev = await eventOf(cat.event_id, c);
    await organiserOnly(user, ev, c);
    await checkScheme(c, ev, i);
    const merged = { ...cat, ...Object.fromEntries(Object.entries(i).filter(([, v]) => v !== undefined)) };
    if (!!merged.daily_from !== !!merged.daily_to) throw badRequest('Give both daily_from and daily_to');
    if (merged.valid_from && merged.valid_to && new Date(merged.valid_to) <= new Date(merged.valid_from)) throw badRequest('valid_to must be after valid_from');
    let r;
    try {
      r = (await c.query(
        `UPDATE accreditation_categories SET name=$2, eligible=$3, colour=$4, venue_id=$5, valid_from=$6, valid_to=$7, daily_from=$8, daily_to=$9, timezone=$10, escort_required=$11, vehicle_access=$12, equipment_access=$13,
                requires_verification=$14, requires_photo=$15, approval=$16, self_apply=$17, capacity=$18, status=$19 WHERE id=$1 RETURNING *`,
        [cat.id, merged.name, [...new Set(merged.eligible)], merged.colour, merged.venue_id, merged.valid_from, merged.valid_to, merged.daily_from, merged.daily_to, merged.timezone, merged.escort_required, merged.vehicle_access, merged.equipment_access,
          merged.requires_verification, merged.requires_photo, merged.approval, merged.self_apply, merged.capacity, i.archived === undefined ? cat.status : i.archived ? 'archived' : 'active'])).rows[0];
    } catch (e) { dup(e, 'A category with that name'); }
    if (i.zone_ids) await setZones(c, cat.id, i.zone_ids);
    return { ...r, zone_ids: (await categoryOf(c, cat.id)).zone_ids };
  }),
});

cap({
  name: 'list_accreditation_categories', method: 'GET', path: '/events/:id/accreditation/categories', tag: TAG,
  summary: 'The accreditation scheme of an event. The organiser sees every category with its counts; anyone else sees the open categories with whether they can apply and, if not, why.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ev = await eventOf(i.id);
    const auth = await authority(user, ev);
    const cats = await many(
      `SELECT k.*, coalesce((SELECT array_agg(cz.zone_id) FROM accreditation_category_zones cz WHERE cz.category_id=k.id AND cz.removed_at IS NULL), '{}') AS zone_ids,
              (SELECT count(*)::int FROM accreditations a WHERE a.category_id=k.id AND a.status='approved') AS issued,
              (SELECT count(*)::int FROM accreditations a WHERE a.category_id=k.id AND a.status IN ('submitted','under_review')) AS waiting
         FROM accreditation_categories k WHERE k.event_id=$1 AND ($2::boolean OR k.status='active') ORDER BY k.status, k.name`, [ev.id, auth.organiser]);
    const zones = new Map((await many('SELECT id, name, kind FROM accreditation_zones WHERE event_id=$1', [ev.id])).map((z) => [z.id, z]));
    const mine = new Map((await many("SELECT category_id, id, status FROM accreditations WHERE event_id=$1 AND holder_id=$2 AND status IN ('draft','submitted','under_review','approved')", [ev.id, user.id])).map((r) => [r.category_id, r]));
    const engaged = await engagementsOf(pool, ev, user.id);
    return cats.map(({ ...k }) => {
      const my = mine.get(k.id) ?? null;
      const can = k.status === 'active' && k.self_apply && !my && eligibleFor(k, engaged);
      return {
        ...k, zones: k.zone_ids.map((z) => zones.get(z)).filter(Boolean),
        ...(auth.organiser ? {} : { issued: undefined, waiting: undefined }),
        my_accreditation: my, can_apply: can, apply_blocked: can || my || k.status !== 'active' ? null : !k.self_apply ? 'By nomination or invitation only' : 'You do not hold a matching role at this event',
      };
    }).filter((k) => auth.organiser || auth.led.size || auth.teams.size || auth.vendors.size || k.can_apply || k.my_accreditation || k.self_apply);
  },
});

// ---- applications, nominations, decisions -------------------------------------------------------------------------------------------------------------

cap({
  name: 'apply_for_accreditation', method: 'POST', path: '/accreditation/categories/:id/apply', tag: TAG, status: 201,
  summary: 'Apply for accreditation yourself (the category must allow it and you must hold a matching role at the event, plus any required verification and, for a young person, current guardian consent). Applying twice returns the same application.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const cat = await categoryOf(c, i.id);
    if (!cat) throw notFound('Category');
    const ev = await eventOf(cat.event_id, c);
    if (!cat.self_apply) throw forbidden('This category is by nomination or invitation only');
    const existing = (await c.query(`SELECT id FROM accreditations WHERE category_id=$1 AND holder_id=$2 AND status IN ('draft','submitted','under_review','approved')`, [cat.id, user.id])).rows[0];
    if (!existing) { const b = await blocker(c, ev, cat, user.id); if (b) throw conflict(b, { code: 'not_eligible' }); }
    const { row } = await create(c, ev, cat, user.id, { origin: 'self', actor: user.id });
    return rowOf(c, row.id);
  }),
});

cap({
  name: 'nominate_for_accreditation', method: 'POST', path: '/events/:id/accreditation/nominations', tag: TAG, status: 201,
  summary: 'Nominate people for a category, in bulk (up to 200). The organiser may nominate anyone eligible and the invitation is approved at once; a team manager nominates players and staff of their accepted team (team_id); a department lead nominates members of their department (department_id); an accepted vendor or sponsor nominates its own crew (vendor_id): anyone on the platform, who then joins that vendor\'s crew. Each person is checked separately; the result lists who was added and who was skipped and why. As a draft nothing is submitted yet.',
  input: z.object({ id, category_id: id, user_ids: z.array(id).min(1).max(200), team_id: id.optional(), department_id: id.optional(), vendor_id: id.optional(), draft: z.boolean().default(false) }),
  handler: ({ user }, i) => tx(async (c) => {
    const ev = await eventOf(i.id, c);
    const cat = await categoryOf(c, i.category_id);
    if (!cat || cat.event_id !== ev.id) throw notFound('Category');
    const auth = await authority(user, ev, c);
    if (!auth.organiser) {
      if (i.team_id && !auth.teams.has(i.team_id)) throw forbidden('You do not manage that team at this event');
      if (i.department_id && !auth.led.has(i.department_id)) throw forbidden('You do not lead that department');
      if (i.vendor_id && !auth.vendors.has(i.vendor_id)) throw forbidden('You are not an accepted vendor or sponsor of this event');
      if (!i.team_id && !i.department_id && !i.vendor_id) throw forbidden('Name the team, department or vendor you nominate from');
    }
    const vendor = i.vendor_id && !auth.organiser ? auth.vendors.get(i.vendor_id) : null;
    const added = [], skipped = [], existing = [];
    for (const uid of [...new Set(i.user_ids)]) {
      const skip = (reason) => skipped.push({ user_id: uid, reason });
      if (!(await c.query('SELECT 1 FROM users WHERE id=$1', [uid])).rowCount) { skip('Unknown person'); continue; }
      if (uid === user.id && !auth.organiser) { skip('Apply for yourself instead'); continue; }
      let origin = 'invitation';
      if (!auth.organiser || i.team_id || i.department_id || vendor) {
        if (vendor) { /* any person may join a vendor's crew; the category decides whether the vendor engagement is enough */ }
        else if (i.team_id) {
          if (!(await c.query("SELECT 1 FROM team_members m WHERE m.team_id=$1 AND m.user_id=$2 AND m.status='active'", [i.team_id, uid])).rowCount) { skip('Not on that team'); continue; }
        } else if (!(await c.query("SELECT 1 FROM event_department_members WHERE department_id=$1 AND user_id=$2 AND status='active'", [i.department_id, uid])).rowCount) { skip('Not in that department'); continue; }
        origin = auth.organiser ? 'invitation' : 'nomination';
      }
      const b = await blocker(c, ev, cat, uid, { invited: origin === 'invitation', also: vendor ? [VENDOR_TO_ENGAGEMENT[vendor.kind]] : [] });
      if (b) { skip(b); continue; }
      if (vendor) await c.query('INSERT INTO event_vendor_crew(vendor_id, event_id, user_id, added_by) VALUES ($1,$2,$3,$4) ON CONFLICT (vendor_id, user_id) WHERE removed_at IS NULL DO NOTHING', [vendor.id, ev.id, uid, user.id]);
      const r = await create(c, ev, cat, uid, { origin, nominatedBy: user.id, teamId: i.team_id ?? null, departmentId: i.department_id ?? null, vendorId: vendor?.id ?? null, actor: user.id, draft: i.draft });
      (r.created ? added : existing).push({ user_id: uid, accreditation_id: r.row.id, status: r.row.status });
    }
    return { added, existing, skipped };
  }),
});

cap({
  name: 'submit_accreditation', method: 'POST', path: '/accreditations/:id/submit', tag: TAG,
  summary: 'Submit a nomination that was saved as a draft (the person who nominated, or the organiser).',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await load(c, i.id, true);
    const ev = await eventOf(a.event_id, c);
    const auth = await authority(user, ev, c);
    if (!auth.organiser && a.nominated_by !== user.id) throw notFound('Accreditation');
    if (a.status !== 'draft') return rowOf(c, a.id);
    const cat = await categoryOf(c, a.category_id);
    const b = await blocker(c, ev, cat, a.holder_id, { invited: a.origin === 'invitation' });
    if (b) throw conflict(b);
    await c.query("UPDATE accreditations SET status='submitted', submitted_at=now() WHERE id=$1", [a.id]);
    await record(c, a.id, user.id, 'submitted', 'draft', 'submitted');
    const next = { ...a, status: 'submitted' };
    await syncRosterFlag(c, next);
    if (cat.approval === 'auto' || a.origin === 'invitation') await approveOrHold(c, ev, cat, next, a.origin === 'invitation' ? user.id : null, a.origin === 'invitation' ? 'invited by the organiser' : 'auto-approved');
    else await ping(c, a.holder_id, ev, 'You were nominated for accreditation', `${cat.name} for ${ev.name}.`, a.id);
    return rowOf(c, a.id);
  }),
});

cap({
  name: 'decide_accreditation', method: 'POST', path: '/accreditations/:id/decision', tag: TAG,
  summary: 'Move an application on: start the review, approve (issues the credential) or reject (a reason is required). Allowed for the organiser, and for a department lead on categories whose approval authority is the department lead; nobody approves their own. Approving re-checks capacity, the required verification, guardian consent and the person\'s role. Repeating a decision is harmless.',
  input: z.object({ id, decision: z.enum(['review', 'approve', 'reject']), reason: z.string().trim().max(60).optional(), note: z.string().trim().max(500).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await load(c, i.id, true);
    const ev = await eventOf(a.event_id, c);
    const cat = await categoryOf(c, a.category_id);
    if (!mayApprove(await authority(user, ev, c), user, a, cat)) throw forbidden('You cannot decide this application');
    const target = { review: 'under_review', approve: 'approved', reject: 'rejected' }[i.decision];
    if (a.status === target) return rowOf(c, a.id);
    if (i.decision === 'reject' && !i.reason) throw badRequest('Say why it is rejected');
    if (!['submitted', 'under_review'].includes(a.status) || (i.decision === 'review' && a.status !== 'submitted')) throw conflict(`This application is ${a.status}`);
    if (i.decision === 'approve') await approveRow(c, ev, cat, a, user.id, i.note ? 'with note' : null);
    else {
      await c.query('UPDATE accreditations SET status=$2, decided_by=$3, decided_at=now(), reason=$4, note_enc=$5 WHERE id=$1', [a.id, target, user.id, i.reason ?? null, i.note ? encrypt(i.note, NOTE) : null]);
      await record(c, a.id, user.id, i.decision === 'review' ? 'review_started' : 'rejected', a.status, target, null, i.reason);
      await syncRosterFlag(c, { ...a, status: target });
      if (i.decision === 'reject') await ping(c, a.holder_id, ev, 'Accreditation not approved', `${cat.name} for ${ev.name}: ${i.reason}.`, a.id);
    }
    await audit(c, user.id, `accreditation_${i.decision}`, 'accreditations', a.id);
    return rowOf(c, a.id);
  }),
});

cap({
  name: 'withdraw_accreditation', method: 'POST', path: '/accreditations/:id/withdraw', tag: TAG,
  summary: 'Withdraw an application or nomination, or hand a credential back (the holder, whoever nominated, or the organiser). An approved credential stops working at once. The record is kept.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await load(c, i.id, true);
    const ev = await eventOf(a.event_id, c);
    const auth = await authority(user, ev, c);
    if (!(auth.organiser || a.holder_id === user.id || a.nominated_by === user.id)) throw notFound('Accreditation');
    if (a.status === 'withdrawn') return rowOf(c, a.id);
    if (!OPEN_STATUSES.includes(a.status)) throw conflict(`This accreditation is ${a.status}`);
    await c.query("UPDATE accreditations SET status='withdrawn', decided_at=now(), decided_by=$2 WHERE id=$1", [a.id, user.id]);
    await record(c, a.id, user.id, 'withdrawn', a.status, 'withdrawn', a.credential_version || null);
    await syncRosterFlag(c, { ...a, status: 'withdrawn' });
    await revokeGrantsForSource(c, 'accreditation', a.id, 'accreditation_withdrawn');
    return rowOf(c, a.id);
  }),
});

const REASONS = ['lost', 'stolen', 'damaged', 'details_changed', 'security', 'other'];
cap({
  name: 'change_accreditation_access', method: 'POST', path: '/accreditations/:id/access', tag: TAG,
  summary: 'Immediately suspend a credential, restore a suspended one, or revoke it for good (organiser, or the department lead where they approve). Takes effect on the next scan at every gate; the holder is told. Repeating the same action is harmless.',
  input: z.object({ id, action: z.enum(['suspend', 'restore', 'revoke']), reason: z.string().trim().min(2).max(60).optional(), note: z.string().trim().max(500).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await load(c, i.id, true);
    const ev = await eventOf(a.event_id, c);
    const cat = await categoryOf(c, a.category_id);
    if (!mayApprove(await authority(user, ev, c), user, a, cat)) throw forbidden('You cannot change this credential');
    if (i.action !== 'restore' && !i.reason) throw badRequest('Say why');
    if (i.action === 'revoke') {
      if (a.status === 'revoked') return rowOf(c, a.id);
      if (a.status !== 'approved') throw conflict(`This accreditation is ${a.status}; withdraw or reject it instead`);
      await c.query("UPDATE accreditations SET status='revoked', decided_by=$2, decided_at=now(), reason=$3, note_enc=$4 WHERE id=$1", [a.id, user.id, i.reason, i.note ? encrypt(i.note, NOTE) : null]);
      await record(c, a.id, user.id, 'revoked', 'approved', 'revoked', a.credential_version, i.reason);
      await syncRosterFlag(c, { ...a, status: 'revoked' });
      await revokeGrantsForSource(c, 'accreditation', a.id, 'accreditation_revoked');
      await ping(c, a.holder_id, ev, 'Accreditation revoked', `${cat.name} for ${ev.name} no longer admits you.`, a.id);
    } else {
      if (a.status !== 'approved') throw conflict(`This accreditation is ${a.status}`);
      const to = i.action === 'suspend' ? 'suspended' : 'active';
      if (a.access === to) return rowOf(c, a.id);
      await c.query('UPDATE accreditations SET access=$2, reason=$3 WHERE id=$1', [a.id, to, i.action === 'suspend' ? i.reason : null]);
      await record(c, a.id, user.id, i.action === 'suspend' ? 'suspended' : 'restored', 'approved', 'approved', a.credential_version, i.reason);
      if (i.action === 'suspend') await revokeGrantsForSource(c, 'accreditation', a.id, 'accreditation_suspended');
      await ping(c, a.holder_id, ev, i.action === 'suspend' ? 'Accreditation suspended' : 'Accreditation restored', `${cat.name} for ${ev.name}.`, a.id);
    }
    await audit(c, user.id, `accreditation_${i.action}`, 'accreditations', a.id);
    return rowOf(c, a.id);
  }),
});

cap({
  name: 'reissue_accreditation', method: 'POST', path: '/accreditations/:id/reissue', tag: TAG,
  summary: 'Replace a credential (lost, stolen, damaged, details changed): the QR code changes and every earlier code stops working at once. The holder or the organiser. Send the credential_version you hold: if it is already out of date the call changes nothing and returns the current credential, so a retry never issues twice.',
  input: z.object({ id, credential_version: z.number().int().min(1), reason: z.enum(REASONS) }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await load(c, i.id, true);
    const ev = await eventOf(a.event_id, c);
    const auth = await authority(user, ev, c);
    if (!(auth.organiser || a.holder_id === user.id)) throw notFound('Accreditation');
    if (a.status !== 'approved') throw conflict(`This accreditation is ${a.status}`);
    if (a.credential_version !== i.credential_version) return rowOf(c, a.id);
    if (a.holder_id === user.id && !auth.organiser && !['lost', 'stolen', 'damaged'].includes(i.reason)) throw forbidden('Ask the organiser to reissue it for that reason');
    const version = a.credential_version + 1;
    await c.query('UPDATE accreditations SET credential_version=$2, issued_at=now(), issued_by=$3 WHERE id=$1', [a.id, version, user.id]);
    await record(c, a.id, user.id, 'reissued', 'approved', 'approved', version, i.reason);
    await audit(c, user.id, 'accreditation_reissue', 'accreditations', a.id);
    if (a.holder_id !== user.id) await ping(c, a.holder_id, ev, 'Your accreditation was reissued', 'Your old QR code no longer works. Open the new one.', a.id);
    return rowOf(c, a.id);
  }),
});

// ---- reading ---------------------------------------------------------------------------------------------------------------------------------------------

/** The holder's own view carries the QR token; it is derived on demand and never stored. */
const withToken = (r) => ({ ...r, credential: r.serial && r.status === 'approved' ? { credential_id: r.serial, version: r.credential_version, token: tokenFor(r.serial, r.credential_version), active: r.effective_status === 'approved' } : null });

cap({
  name: 'list_my_accreditations', method: 'GET', path: '/me/accreditations', tag: TAG,
  summary: 'My accreditations across events: status, category, zones, validity and, once approved, the credential with its QR token. The token contains no personal data and changes when the credential is reissued.',
  input: z.object({ active: z.coerce.boolean().default(false).describe('only upcoming or running events'), ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT ${ROW}, coalesce((SELECT jsonb_agg(jsonb_build_object('id', z.id, 'name', z.name, 'kind', z.kind) ORDER BY z.name) FROM accreditation_category_zones cz JOIN accreditation_zones z ON z.id=cz.zone_id WHERE cz.category_id=k.id AND cz.removed_at IS NULL AND z.archived_at IS NULL), '[]') AS zones
         ${FROM} WHERE a.holder_id=$1 AND a.status <> 'draft' AND (NOT $2::boolean OR coalesce(e.ends_on, e.starts_on, current_date) >= current_date)
        ORDER BY coalesce(e.starts_on, current_date) DESC, a.created_at DESC LIMIT $3 OFFSET $4`, [user.id, i.active, i.limit, i.offset]);
    return rows.map((r) => withToken(decorate(r)));
  },
});

cap({
  name: 'list_event_accreditations', method: 'GET', path: '/events/:id/accreditations', tag: TAG,
  summary: 'Accreditations of an event. The organiser sees all of them; a department lead sees their department; a team manager sees their team\'s nominations; a vendor sees its crew\'s; a nominator sees theirs. Filter by status, category or name.',
  input: z.object({ id, status: z.enum(['draft', 'submitted', 'under_review', 'approved', 'rejected', 'withdrawn', 'revoked', 'suspended', 'expired']).optional(), category_id: id.optional(), q: z.string().trim().max(80).optional(), ...page }),
  async handler({ user }, i) {
    const ev = await eventOf(i.id);
    const auth = await authority(user, ev);
    if (!auth.organiser && !auth.led.size && !auth.teams.size && !auth.vendors.size && !(await pool.query('SELECT 1 FROM accreditations WHERE event_id=$1 AND nominated_by=$2 LIMIT 1', [ev.id, user.id])).rowCount) throw forbidden('You have no accreditation role at this event');
    const rows = await many(
      `SELECT * FROM (SELECT ${ROW} ${FROM} WHERE a.event_id=$1 AND ($2::uuid IS NULL OR a.category_id=$2) AND ($3::text IS NULL OR u.display_name ILIKE $3 OR u.handle ILIKE $3)
          AND ($4::boolean OR a.nominated_by=$5 OR a.department_id = ANY($6::uuid[]) OR a.team_id = ANY($7::uuid[]) OR a.vendor_id = ANY($11::uuid[]))) x
        WHERE ($8::text IS NULL OR (CASE WHEN $8 IN ('suspended','expired') THEN
              (CASE WHEN x.status='approved' AND x.access='suspended' THEN 'suspended' WHEN x.status='approved' AND x.valid_to < now() THEN 'expired' ELSE x.status END) = $8 ELSE x.status = $8 END))
        ORDER BY CASE x.status WHEN 'submitted' THEN 0 WHEN 'under_review' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END, x.submitted_at DESC LIMIT $9 OFFSET $10`,
      [ev.id, i.category_id ?? null, i.q ? `%${i.q}%` : null, auth.organiser, user.id, [...auth.led], [...auth.teams], i.status ?? null, i.limit, i.offset, [...auth.vendors.keys()]]);
    return rows.map((r) => ({ ...decorate(r), can_decide: !!mayApprove(auth, user, r, r) }));
  },
});

cap({
  name: 'list_accreditation_candidates', method: 'GET', path: '/events/:id/accreditation/candidates', tag: TAG,
  summary: 'Who the caller may nominate into a category, grouped by the authority they act through: every accepted team the organiser runs or the caller manages, and every department the organiser runs or the caller leads. Each person shows whether they are eligible now (and if not, why) or already have an application. Use the group\'s team_id or department_id with nominate_for_accreditation.',
  input: z.object({ id, category_id: id }),
  async handler({ user }, i) {
    const ev = await eventOf(i.id);
    const cat = await categoryOf(pool, i.category_id);
    if (!cat || cat.event_id !== ev.id) throw notFound('Category');
    const auth = await authority(user, ev);
    const open = new Set((await many("SELECT holder_id FROM accreditations WHERE category_id=$1 AND status IN ('draft','submitted','under_review','approved')", [cat.id])).map((r) => r.holder_id));
    const judgeAll = async (rows) => {
      const out = [];
      for (const r of rows) {
        const why = open.has(r.user_id) ? null : await blocker(pool, ev, cat, r.user_id, { invited: auth.organiser });
        out.push({ ...r, has_application: open.has(r.user_id), eligible: !open.has(r.user_id) && !why, reason: why });
      }
      return out;
    };
    const groups = [];
    const teams = await many("SELECT DISTINCT t.id, t.name, t.emoji FROM event_entries en JOIN teams t ON t.id=en.team_id WHERE en.event_id=$1 AND en.status='accepted' ORDER BY t.name", [ev.id]);
    for (const t of teams) {
      if (!auth.organiser && !auth.teams.has(t.id)) continue;
      const people = await many("SELECT u.id AS user_id, u.display_name, u.handle, m.role FROM team_members m JOIN users u ON u.id=m.user_id WHERE m.team_id=$1 AND m.status='active' ORDER BY u.display_name LIMIT 200", [t.id]);
      groups.push({ kind: 'team', team_id: t.id, name: t.name, emoji: t.emoji, people: await judgeAll(people) });
    }
    const depts = await many("SELECT id, name, colour FROM event_departments WHERE event_id=$1 AND status='active' ORDER BY name", [ev.id]);
    for (const d of depts) {
      if (!auth.organiser && !auth.led.has(d.id)) continue;
      const people = await many("SELECT u.id AS user_id, u.display_name, u.handle, m.role FROM event_department_members m JOIN users u ON u.id=m.user_id WHERE m.department_id=$1 AND m.status='active' ORDER BY u.display_name LIMIT 200", [d.id]);
      groups.push({ kind: 'department', department_id: d.id, name: d.name, colour: d.colour, people: await judgeAll(people) });
    }
    for (const v of auth.vendors.values()) {
      const meta = (await pool.query('SELECT v.id, v.kind, u.display_name FROM event_vendors v JOIN users u ON u.id=v.vendor_user_id WHERE v.id=$1', [v.id])).rows[0];
      const people = await many("SELECT u.id AS user_id, u.display_name, u.handle, 'crew' AS role, cr.id AS crew_id FROM event_vendor_crew cr JOIN users u ON u.id=cr.user_id WHERE cr.vendor_id=$1 AND cr.removed_at IS NULL ORDER BY u.display_name LIMIT 200", [v.id]);
      groups.push({ kind: 'vendor', vendor_id: v.id, name: `${meta.display_name} (${meta.kind})`, can_add_people: true, people: await judgeAll(people) });
    }
    return { category_id: cat.id, organiser: auth.organiser, groups };
  },
});

cap({
  name: 'remove_vendor_crew', method: 'POST', path: '/vendor-crew/:id/remove', tag: TAG,
  summary: 'Take a person off a vendor\'s crew (the vendor or the organiser). Their open accreditations nominated through that vendor are withdrawn; the crew record is kept. Repeating it is harmless.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const m = (await c.query('SELECT cr.*, v.vendor_user_id FROM event_vendor_crew cr JOIN event_vendors v ON v.id=cr.vendor_id WHERE cr.id=$1 FOR UPDATE OF cr', [i.id])).rows[0];
    if (!m) throw notFound('Crew member');
    const ev = await eventOf(m.event_id, c);
    if (m.vendor_user_id !== user.id && !(await departmentScope(user, ev, c)).organiser) throw notFound('Crew member');
    if (m.removed_at) return { id: m.id, removed: true, withdrawn: 0 };
    await c.query('UPDATE event_vendor_crew SET removed_at=now() WHERE id=$1', [m.id]);
    const open = (await c.query("SELECT * FROM accreditations WHERE vendor_id=$1 AND holder_id=$2 AND status IN ('draft','submitted','under_review','approved') FOR UPDATE", [m.vendor_id, m.user_id])).rows;
    for (const a of open) {
      await c.query("UPDATE accreditations SET status='withdrawn', decided_at=now(), decided_by=$2 WHERE id=$1", [a.id, user.id]);
      await record(c, a.id, user.id, 'withdrawn', a.status, 'withdrawn', a.credential_version || null, 'left the vendor crew');
      await syncRosterFlag(c, { ...a, status: 'withdrawn' });
    }
    await audit(c, user.id, 'accreditation_vendor_crew_remove', 'event_vendor_crew', m.id);
    return { id: m.id, removed: true, withdrawn: open.length };
  }),
});

cap({
  name: 'get_accreditation', method: 'GET', path: '/accreditations/:id', tag: TAG,
  summary: 'One accreditation with its history (issue, reissue, suspension, revocation). The credential token is shown to the holder and the organiser only; the organiser\'s decision note is decrypted for them and the read is audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const a = await load(pool, i.id);
    const ev = await eventOf(a.event_id);
    const auth = await authority(user, ev);
    if (!maySee(auth, user, a)) throw notFound('Accreditation');
    const r = decorate((await pool.query(`SELECT ${ROW}, a.note_enc ${FROM} WHERE a.id=$1`, [a.id])).rows[0]);
    const { note_enc, ...row } = r;
    const history = await many('SELECT h.kind, h.from_status, h.to_status, h.credential_version, h.reason, h.at, u.display_name AS actor FROM accreditation_history h LEFT JOIN users u ON u.id=h.actor_id WHERE h.accreditation_id=$1 ORDER BY h.at, h.id', [a.id]);
    let note = null;
    if (auth.organiser && note_enc) { note = decrypt(note_enc, NOTE); await audit(null, user.id, 'read_accreditation_note', 'accreditations', a.id); }
    return { ...(auth.organiser || a.holder_id === user.id ? withToken(row) : row), note, history };
  },
});

// ---- gate: scan, revocation feed, report ----------------------------------------------------------------------------------------------------------------

cap({
  name: 'scan_accreditation', method: 'POST', path: '/events/:id/accreditation/scan', tag: TAG,
  summary: 'Gate staff: scan a credential at the event or at one zone. Always answers with a verdict (valid, invalid, expired, not_yet_valid, revoked, suspended, replaced, wrong_event, wrong_zone, outside_hours, not_eligible) judged from live data, plus the minimum a guard needs (name, category, zones, escort, vehicle/equipment, photo only where the category allows it). Every scan is recorded with operator, zone and time. A repeat with the same idempotency_key returns the first verdict without recording again.',
  input: z.object({ id, token: z.string().trim().min(8).max(200), zone_id: id.optional(), direction: z.enum(['in', 'out']).default('in'), idempotency_key: z.string().min(8).max(80).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const ev = await eventOf(i.id, c);
    if (!(await isGateOperator(user, ev, c))) throw forbidden('Only the organiser and accreditation or security staff can scan credentials');
    if (i.zone_id && !(await c.query('SELECT 1 FROM accreditation_zones WHERE id=$1 AND event_id=$2 AND archived_at IS NULL', [i.zone_id, ev.id])).rowCount) throw notFound('Zone');
    if (i.idempotency_key) {
      const prior = (await c.query('SELECT id, result, serial, at FROM accreditation_scans WHERE operator_id=$1 AND idempotency_key=$2', [user.id, i.idempotency_key])).rows[0];
      if (prior) return { result: prior.result, credential_id: prior.serial, scan_id: prior.id, at: prior.at, replayed: true };
    }
    const verdict = await judge(c, ev, i.token, i.zone_id);
    const a = verdict.accreditation;
    const scan = (await c.query(
      'INSERT INTO accreditation_scans(event_id, accreditation_id, serial, zone_id, operator_id, direction, result, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, at',
      [ev.id, a?.id ?? null, a?.serial ?? null, i.zone_id ?? null, user.id, i.direction, verdict.result, i.idempotency_key ?? null])).rows[0];
    return { ...(await gateView(verdict)), direction: i.direction, zone_id: i.zone_id ?? null, scan_id: scan.id, at: scan.at };
  }),
});

cap({
  name: 'list_accreditation_scans', method: 'GET', path: '/events/:id/accreditation/scans', tag: TAG,
  summary: 'The scan log of the event (organiser): who was scanned where, by whom, with the verdict. Filter by zone, verdict or credential.',
  input: z.object({ id, zone_id: id.optional(), result: z.string().max(20).optional(), accreditation_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const ev = await eventOf(i.id);
    await organiserOnly(user, ev, pool);
    return many(
      `SELECT s.id, s.at, s.direction, s.result, s.serial, s.zone_id, z.name AS zone, op.display_name AS operator, h.display_name AS holder, k.name AS category
         FROM accreditation_scans s LEFT JOIN accreditation_zones z ON z.id=s.zone_id JOIN users op ON op.id=s.operator_id
         LEFT JOIN accreditations a ON a.id=s.accreditation_id LEFT JOIN users h ON h.id=a.holder_id LEFT JOIN accreditation_categories k ON k.id=a.category_id
        WHERE s.event_id=$1 AND ($2::uuid IS NULL OR s.zone_id=$2) AND ($3::text IS NULL OR s.result=$3) AND ($4::uuid IS NULL OR s.accreditation_id=$4) ORDER BY s.at DESC, s.id DESC LIMIT $5 OFFSET $6`,
      [ev.id, i.zone_id ?? null, i.result ?? null, i.accreditation_id ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'list_accreditation_revocations', method: 'GET', path: '/events/:id/accreditation/revocations', tag: TAG,
  summary: 'For gate devices that cache credentials: every credential whose standing changed since a moment (revoked, suspended, restored, reissued, withdrawn), with its current version. Poll with the previous response time to stay current.',
  input: z.object({ id, since: when.optional() }),
  async handler({ user }, i) {
    const ev = await eventOf(i.id);
    if (!(await isGateOperator(user, ev))) throw forbidden('Only the organiser and accreditation or security staff can do that');
    const rows = await many(
      `SELECT DISTINCT ON (a.id) a.serial, a.status, a.access, a.credential_version, h.at
         FROM accreditation_history h JOIN accreditations a ON a.id=h.accreditation_id
        WHERE a.event_id=$1 AND a.serial IS NOT NULL AND h.kind IN ('revoked','suspended','restored','reissued','withdrawn','issued') AND ($2::timestamptz IS NULL OR h.at > $2) ORDER BY a.id, h.at DESC`, [ev.id, i.since ?? null]);
    return { as_of: new Date().toISOString(), credentials: rows };
  },
});

cap({
  name: 'accreditation_report', method: 'GET', path: '/events/:id/accreditation/report', tag: TAG,
  summary: 'Accreditation numbers for the organiser and gate staff: per category the waiting, approved, live (issued and not suspended or expired), revoked, expired and actually checked-in credentials; per zone the permitted holders, admitted scans, refusals and who is inside now; and event totals including approvals still outstanding.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ev = await eventOf(i.id);
    if (!(await isGateOperator(user, ev))) throw forbidden('Only the organiser and accreditation or security staff can see the report');
    const categories = await many(
      `WITH x AS (SELECT a.*, ${WINDOW_SQL} ${FROM} WHERE a.event_id=$1),
            used AS (SELECT DISTINCT accreditation_id FROM accreditation_scans WHERE event_id=$1 AND result='valid' AND direction='in' AND accreditation_id IS NOT NULL)
       SELECT k.id AS category_id, k.name, k.colour, k.capacity, k.status,
              count(*) FILTER (WHERE x.status IN ('submitted','under_review'))::int AS waiting,
              count(*) FILTER (WHERE x.status='approved')::int AS approved,
              count(*) FILTER (WHERE x.status='approved' AND x.access='active' AND (x.valid_to IS NULL OR x.valid_to >= now()))::int AS live,
              count(*) FILTER (WHERE x.status='approved' AND x.access='suspended')::int AS suspended,
              count(*) FILTER (WHERE x.status='approved' AND x.valid_to < now())::int AS expired,
              count(*) FILTER (WHERE x.status='revoked')::int AS revoked,
              count(*) FILTER (WHERE x.status='rejected')::int AS rejected,
              count(*) FILTER (WHERE x.status IN ('approved','revoked') AND x.id IN (SELECT accreditation_id FROM used))::int AS checked_in
         FROM accreditation_categories k LEFT JOIN x ON x.category_id=k.id WHERE k.event_id=$1 GROUP BY k.id ORDER BY k.status, k.name`, [ev.id]);
    const zones = await many(
      `SELECT z.id AS zone_id, z.name, z.kind, z.archived_at IS NOT NULL AS archived,
              (SELECT count(*)::int FROM accreditation_category_zones cz JOIN accreditations a ON a.category_id=cz.category_id WHERE cz.zone_id=z.id AND cz.removed_at IS NULL AND a.status='approved' AND a.access='active') AS permitted,
              (SELECT count(*)::int FROM accreditation_scans s WHERE s.zone_id=z.id AND s.result='valid' AND s.direction='in') AS admitted,
              (SELECT count(*)::int FROM accreditation_scans s WHERE s.zone_id=z.id AND s.result <> 'valid') AS refused,
              (SELECT count(*)::int FROM (SELECT DISTINCT ON (accreditation_id) direction FROM accreditation_scans s WHERE s.zone_id=z.id AND s.result='valid' ORDER BY accreditation_id, at DESC, id DESC) l WHERE l.direction='in') AS inside
         FROM accreditation_zones z WHERE z.event_id=$1 ORDER BY z.archived_at NULLS FIRST, z.name`, [ev.id]);
    const site = (await pool.query(
      `SELECT (SELECT count(*)::int FROM (SELECT DISTINCT ON (accreditation_id) direction FROM accreditation_scans WHERE event_id=$1 AND zone_id IS NULL AND result='valid' ORDER BY accreditation_id, at DESC, id DESC) l WHERE l.direction='in') AS inside,
              (SELECT count(*)::int FROM accreditation_scans WHERE event_id=$1 AND zone_id IS NULL AND result='valid' AND direction='in') AS admitted,
              (SELECT count(*)::int FROM accreditation_scans WHERE event_id=$1 AND zone_id IS NULL AND result <> 'valid') AS refused`, [ev.id])).rows[0];
    const sum = (k) => categories.reduce((n, r) => n + r[k], 0);
    return {
      totals: { outstanding_approvals: sum('waiting'), approved: sum('approved'), live: sum('live'), suspended: sum('suspended'), expired: sum('expired'), revoked: sum('revoked'), checked_in: sum('checked_in'), never_used: Math.max(sum('live') - sum('checked_in'), 0),
        refused_last_24h: (await pool.query("SELECT count(*)::int AS n FROM accreditation_scans WHERE event_id=$1 AND result <> 'valid' AND at > now() - interval '24 hours'", [ev.id])).rows[0].n },
      categories, zones, site,
    };
  },
});

