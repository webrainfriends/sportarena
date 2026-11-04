// Campus & academy hierarchy (#781). One tree per academy group (region -> campus -> sport department) whose nodes POINT at the canonical
// venues, teams, cohorts, programmes, enrolments, staff, suppliers and child academies with effective-dated links; nothing is copied.
// Owners/admins run the whole tree; a branch director runs their own subtree; sports leads, coaches, operations, finance and auditors see
// their branch only (404 for any other, so another campus's existence is not leaked). Every change is audit-logged per unit and every move
// is a change set that can be previewed (dry_run) and rolled back. Single-campus academies need no migration: until "set up campuses" they have no rows.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { blindIndex } from '../crypto.js';
import { lockOrg } from '../org-access.js';
import {
  UNIT_KINDS, UNIT_ROLES, OBJECT_TYPES, LINKABLE, POLICY_KEYS, loadUnits, unitMap, chain, descendants, checkParent, campusAccess, unitIn, needManage, needAdmin, writable,
  ymd, mirrorCampusToBranch, syncAllProgrammes, checkObjects, carried, describe, linkIndex, moveObject, event, effectivePolicies, rollup, shapeMetrics, treeOrgs, ensureOrgWrite,
} from '../campuses.js';

const TAG = 'Campuses';
const day = z.string().date();
const text = (n) => z.string().trim().max(n);
const today = () => new Date().toISOString().slice(0, 10);
const publicUnit = (u) => ({ id: u.id, organisation_id: u.organisation_id, parent_id: u.parent_id, kind: u.kind, name: u.name, code: u.code, country: u.country, city: u.city, timezone: u.timezone, sport: u.sport, status: u.status, valid_from: ymd(u.valid_from), valid_to: ymd(u.valid_to), is_default: u.is_default, row_version: u.row_version });
const UNIT_FIELDS = {
  name: text(80).min(2), code: z.union([z.literal(''), z.string().regex(/^[A-Za-z0-9_-]{2,16}$/, 'letters, digits, - and _ (2-16)')]).optional(),
  country: z.union([z.literal(''), z.string().regex(/^[A-Z]{2}$/, 'two-letter country code')]).optional(), city: text(80).optional(), timezone: text(60).optional(), sport: text(40).optional(),
};
const blank = (v) => (v === '' || v === undefined ? null : v);

const moneyOk = (a, unitId) => a.all || a.can(unitId, 'director', 'finance');
const peopleOk = (a, unitId) => a.all || a.can(unitId, 'director', 'sports_lead', 'coach', 'operations');

// ---------------------------------------------------------------------------- overview (consolidated + per-campus, source attributed)
cap({
  name: 'get_campus_overview', method: 'GET', path: '/organisations/:id/campuses', tag: TAG,
  summary: 'The academy group\'s campus tree with per-unit figures (venues, teams, programmes, cohorts, staff, coaches, athletes, fill, 30-day attendance and, for finance-visible scopes, fees outstanding/overdue by currency). Owners/admins see everything; other roles only their branch (units above it appear as names only). Totals are the sum of the top-level units you can see, so nothing is counted twice; `unassigned` shows what is not placed on any unit yet. Filter by kind, region, country or sport; `as_of` shows the tree as it stood on a date.',
  input: z.object({ id, as_of: day.optional(), kind: z.enum(UNIT_KINDS).optional(), region_id: id.optional(), country: z.string().regex(/^[A-Z]{2}$/).optional(), sport: z.string().max(40).optional(), include_archived: z.coerce.boolean().default(false) }),
  handler: async ({ user }, i) => {
    const a = await campusAccess(user, i.id);
    const asOf = i.as_of ?? today();
    const sub = i.region_id ? descendants(a.units, i.region_id) : null;
    if (i.region_id) unitIn(a, i.region_id);
    const withMoney = a.all || [...a.visible].some((u) => moneyOk(a, u));
    const r = await rollup(pool, i.id, a.units, asOf, { withMoney });
    const shown = a.units.filter((u) => (a.all || a.visible.has(u.id) || a.context.has(u.id)) && (i.include_archived || u.status !== 'archived' || u.valid_to) && (!sub || sub.has(u.id)));
    const units = shown.filter((u) => (!i.kind || u.kind === i.kind) && (!i.country || u.country === i.country) && (!i.sport || u.sport === i.sport || u.kind !== 'department')).map((u) => {
      const ctx = a.context.has(u.id) && !a.visible.has(u.id);
      return { ...publicUnit(u), context_only: ctx, my_roles: [...(a.roles.get(u.id) ?? [])], can_manage: a.canManage(u.id), metrics: ctx ? null : shapeMetrics(r.metrics.get(u.id), withMoney && moneyOk(a, u.id)) };
    });
    const tops = shown.filter((u) => !u.parent_id || !a.map.get(u.parent_id) || !(a.all || a.visible.has(u.parent_id))).filter((u) => a.all || a.visible.has(u.id));
    const total = { ...shapeMetrics(blankSum(tops.map((u) => r.metrics.get(u.id))), withMoney) };
    const regions = a.units.filter((u) => u.kind === 'region' && u.status !== 'archived' && (a.all || a.visible.has(u.id))).map((u) => ({ id: u.id, name: u.name }));
    return {
      organisation: { id: a.org.id, name: a.org.name, kind: a.org.kind }, as_of: asOf, setup_done: a.units.length > 0,
      scope: { all: a.all, partial: !a.all, roles: [...new Set([...a.roles.values()].flatMap((s) => [...s]))] },
      totals: total, unassigned: a.all ? r.unlinked : null, units, regions,
      countries: [...new Set(a.units.filter((u) => u.country && (a.all || a.visible.has(u.id))).map((u) => u.country))].sort(),
      sports: [...new Set(a.units.filter((u) => u.sport && (a.all || a.visible.has(u.id))).map((u) => u.sport))].sort(),
      source_note: 'Every figure is attributed to the unit an object is pointed at; a region adds up its campuses. Athletes follow their own link, else their cohort\'s, else their programme\'s.',
    };
  },
});

function blankSum(list) {
  const t = { venues: 0, teams: 0, programmes: 0, cohorts: 0, staff: 0, coaches: 0, athletes: 0, capacity: 0, attendance_present: 0, attendance_total: 0, money: new Map() };
  for (const x of list) {
    for (const k of ['venues', 'teams', 'programmes', 'cohorts', 'staff', 'coaches', 'athletes', 'capacity', 'attendance_present', 'attendance_total']) t[k] += x[k];
    for (const [cur, v] of x.money) { const d = t.money.get(cur) ?? { currency: cur, outstanding_minor: 0, overdue_minor: 0, paid_minor: 0 }; d.outstanding_minor += v.outstanding_minor; d.overdue_minor += v.overdue_minor; d.paid_minor += v.paid_minor; t.money.set(cur, d); }
  }
  return t;
}

// ---------------------------------------------------------------------------- unit detail
cap({
  name: 'get_org_unit', method: 'GET', path: '/organisations/:id/units/:unit_id', tag: TAG,
  summary: 'One region / campus / department: its place in the tree, the objects currently pointed at it (venues, teams, programmes, cohorts, staff, athletes, suppliers, child academies) with their names read live, the people holding branch roles, and the effective policies with where each one is inherited from. Athlete and staff names are hidden from finance and auditor scopes.',
  input: z.object({ id, unit_id: id, as_of: day.optional() }),
  handler: async ({ user }, i) => {
    const a = await campusAccess(user, i.id), u = unitIn(a, i.unit_id), asOf = i.as_of ?? today();
    const people = peopleOk(a, u.id);
    const sub = descendants(a.units, u.id);
    const links = (await pool.query(
      `SELECT l.id, l.unit_id, l.object_type, l.object_id, l.effective_from::text AS effective_from FROM org_unit_links l
        WHERE l.unit_id = ANY($1) AND l.effective_from <= $2 AND (l.effective_to IS NULL OR l.effective_to > $2) ORDER BY l.object_type, l.effective_from DESC LIMIT 600`, [[...sub], asOf])).rows;
    const assets = {};
    for (const type of OBJECT_TYPES) {
      const mine = links.filter((l) => l.object_type === type);
      const names = await describe(pool, type, mine.map((l) => l.object_id), { people });
      assets[type] = mine.map((l) => ({ link_id: l.id, object_id: l.object_id, unit_id: l.unit_id, unit_name: a.map.get(l.unit_id)?.name, since: l.effective_from, ...(names.get(l.object_id) ?? { label: '(removed)', sub: null }) }));
    }
    const roles = (await pool.query(
      `SELECT r.id, r.user_id, r.role, r.inherit, r.valid_from::text AS valid_from, r.valid_to::text AS valid_to, r.unit_id, usr.display_name, usr.handle FROM org_unit_roles r JOIN users usr ON usr.id=r.user_id
        WHERE r.unit_id = ANY($1) AND r.ended_at IS NULL ORDER BY r.role, usr.display_name`, [chain(a.map, u.id).map((x) => x.id)])).rows
      .filter((r) => r.unit_id === u.id || r.inherit)
      .map((r) => ({ ...r, inherited_from: r.unit_id === u.id ? null : a.map.get(r.unit_id)?.name ?? null }));
    return {
      unit: publicUnit(u), path: chain(a.map, u.id).reverse().map((x) => ({ id: x.id, kind: x.kind, name: x.name })), can_manage: a.canManage(u.id), my_roles: [...(a.roles.get(u.id) ?? [])],
      children: a.units.filter((x) => x.parent_id === u.id && (a.all || a.visible.has(x.id))).map(publicUnit), assets, people_visible: people,
      roles: people || a.all ? roles : roles.map((r) => ({ ...r, display_name: 'Restricted', handle: null })), policies: await effectivePolicies(pool, a.map, u.id), as_of: asOf,
    };
  },
});

// ---------------------------------------------------------------------------- structure
cap({
  name: 'create_org_unit', method: 'POST', path: '/organisations/:id/units', tag: TAG, status: 201,
  summary: 'Add a region, campus or sport department to the academy group tree (owner/admin; a branch director may add departments under their campus). Regions sit at the top or inside a region, campuses at the top or inside a region, departments inside a campus. The id is immutable; valid_from sets when it starts.',
  input: z.object({ id, kind: z.enum(UNIT_KINDS), parent_id: id.optional(), ...UNIT_FIELDS, valid_from: day.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const org = (await c.query('SELECT * FROM organisations WHERE id=$1', [i.id])).rows[0];
    if (!org) throw notFound('Organisation');
    const a = await campusAccess(user, i.id, { c });
    await ensureOrgWrite(c, a);
    if (i.kind === 'department' && i.parent_id) needManage(a, i.parent_id); else needAdmin(a);
    await lockOrg(c, i.id);
    const map = unitMap(await loadUnits(i.id, c));
    const parent = checkParent(map, i.kind, i.parent_id ?? null);
    if (parent) writable(a, parent);
    if (i.kind === 'department' && !i.sport) throw badRequest('Choose the sport this department runs');
    const row = (await c.query(
      `INSERT INTO org_units(organisation_id, parent_id, kind, name, code, country, city, timezone, sport, valid_from, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10::date, CURRENT_DATE),$11) RETURNING *`,
      [i.id, i.parent_id ?? null, i.kind, i.name, blank(i.code), blank(i.country) ?? (parent?.country ?? null), blank(i.city), blank(i.timezone) ?? (parent?.timezone ?? null), i.kind === 'department' ? i.sport : null, i.valid_from ?? null, user.id])
      .catch((e) => { if (e.code === '23505') throw conflict('Another unit already uses that code'); throw e; })).rows[0];
    if (row.kind === 'campus') await mirrorCampusToBranch(c, row, user.id);   // a campus always has its branch row, so the branch P&L and endpoints see it
    await audit(c, user.id, 'create_org_unit', 'org_units', row.id);
    await event(c, i.id, row.id, user.id, 'unit_created', { kind: row.kind, name: row.name, parent_id: row.parent_id });
    return publicUnit(row);
  }),
});

cap({
  name: 'update_org_unit', method: 'PATCH', path: '/organisations/:id/units/:unit_id', tag: TAG,
  summary: 'Rename or re-parent a unit, change its details, or move it through its lifecycle: suspend (kept visible, nothing new can be placed on it), reactivate, or archive (only when no objects, no active sub-units and no live roles remain; history is kept). Optimistic concurrency via row_version. Re-parenting moves the whole branch and keeps every link, role and policy.',
  input: z.object({ id, unit_id: id, name: UNIT_FIELDS.name.optional(), code: UNIT_FIELDS.code, country: UNIT_FIELDS.country, city: UNIT_FIELDS.city, timezone: UNIT_FIELDS.timezone, sport: UNIT_FIELDS.sport, parent_id: id.nullable().optional(),
    status: z.enum(['active', 'suspended', 'archived']).optional(), valid_to: day.nullable().optional(), reason: text(500).optional(), row_version: z.number().int().optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await campusAccess(user, i.id, { c });
    await ensureOrgWrite(c, a);
    const u = needManage(a, i.unit_id);
    await lockOrg(c, i.id);
    const cur = (await c.query('SELECT * FROM org_units WHERE id=$1 FOR UPDATE', [u.id])).rows[0];
    if (i.row_version !== undefined && cur.row_version !== i.row_version) throw conflict('This unit was changed by someone else. Reload and try again.', { row_version: cur.row_version });
    if (cur.status === 'archived' && i.status !== 'active') throw conflict('This unit is archived and read-only');
    const reparent = i.parent_id !== undefined && i.parent_id !== cur.parent_id;
    if (reparent) { needAdmin(a); checkParent(a.map, cur.kind, i.parent_id, cur.id); }
    if (i.status === 'archived') {
      const open = (await c.query('SELECT count(*)::int AS n FROM org_unit_links WHERE unit_id=$1 AND effective_to IS NULL', [cur.id])).rows[0].n;
      const kids = a.units.filter((x) => x.parent_id === cur.id && x.status !== 'archived').length;
      const roles = (await c.query('SELECT count(*)::int AS n FROM org_unit_roles WHERE unit_id=$1 AND ended_at IS NULL', [cur.id])).rows[0].n;
      if (open || kids || roles) throw conflict(`Move ${open} object${open === 1 ? '' : 's'}, end ${roles} role${roles === 1 ? '' : 's'} and archive ${kids} sub-unit${kids === 1 ? '' : 's'} first (nothing is deleted; history stays)`, { objects: open, sub_units: kids, roles });
    }
    const set = {
      name: i.name, code: i.code === undefined ? undefined : blank(i.code), country: i.country === undefined ? undefined : blank(i.country), city: i.city === undefined ? undefined : blank(i.city),
      timezone: i.timezone === undefined ? undefined : blank(i.timezone), sport: cur.kind === 'department' ? i.sport : undefined, parent_id: reparent ? i.parent_id : undefined, status: i.status, valid_to: i.valid_to,
    };
    const keys = Object.keys(set).filter((k) => set[k] !== undefined);
    if (!keys.length) return publicUnit(cur);
    const row = (await c.query(
      `UPDATE org_units SET ${keys.map((k, n) => `${k}=$${n + 2}`).join(', ')}, archived_at = CASE WHEN $${keys.length + 2}::text = 'archived' THEN now() WHEN $${keys.length + 2}::text IS NOT NULL THEN NULL ELSE archived_at END, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`,
      [cur.id, ...keys.map((k) => set[k]), i.status ?? null]).catch((e) => { if (e.code === '23505') throw conflict('Another unit already uses that code'); throw e; })).rows[0];
    if (row.kind === 'campus') await mirrorCampusToBranch(c, row, user.id);
    await audit(c, user.id, 'update_org_unit', 'org_units', cur.id);
    await event(c, i.id, cur.id, user.id, i.status && i.status !== cur.status ? `unit_${i.status === 'active' ? 'reactivated' : i.status}` : reparent ? 'unit_reparented' : 'unit_updated',
      { changed: keys, from_status: cur.status, to_status: row.status, from_parent: cur.parent_id, to_parent: row.parent_id, reason: i.reason ?? null });
    return publicUnit(row);
  }),
});

// ---------------------------------------------------------------------------- moves (assign / transfer) with preview and rollback
const ITEM = z.object({ object_type: z.enum(OBJECT_TYPES), object_ids: z.array(id).min(1).max(200) });

cap({
  name: 'move_org_unit_objects', method: 'POST', path: '/organisations/:id/unit-moves', tag: TAG, status: 201,
  summary: 'Place objects that are not on any unit yet (owner/admin): venues, teams, cohorts, programmes, athletes (enrolments), coaches/staff, suppliers or child academies. Nothing is copied: a dated pointer is added and the objects keep their ids and history. Objects already placed cannot be moved here: that is a transfer (request_org_transfer), which runs the academy\'s own process. `dry_run` previews; a real placement returns a change id that `rollback_org_unit_change` can undo. Idempotent on idempotency_key.',
  input: z.object({ id, to_unit_id: id, items: z.array(ITEM).min(1).max(8), effective_on: day.optional(), reason: text(500).optional(), dry_run: z.boolean().default(false), idempotency_key: z.string().min(8).max(80).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await campusAccess(user, i.id, { c });
    await ensureOrgWrite(c, a);
    await lockOrg(c, i.id);
    const dest = needManage(a, i.to_unit_id);
    writable(a, dest);
    if (dest.status === 'suspended') throw conflict('This unit is suspended: nothing new can be placed on it');
    const eff = i.effective_on ?? today();
    if (eff < ymd(dest.valid_from)) throw badRequest(`${dest.name} starts on ${ymd(dest.valid_from)}; choose that day or later`);
    if (i.idempotency_key && !i.dry_run) {
      const prior = (await c.query('SELECT * FROM org_unit_changes WHERE organisation_id=$1 AND idempotency_key=$2', [i.id, i.idempotency_key])).rows[0];
      if (prior) return { change_id: prior.id, replayed: true, ...prior.summary };
    }
    for (const it of i.items) {
      if (!LINKABLE[it.object_type].includes(dest.kind)) throw badRequest(`A ${it.object_type} cannot be placed on a ${dest.kind}; use ${LINKABLE[it.object_type].join(' or ')}`);
      await checkObjects(c, i.id, it.object_type, it.object_ids);
    }
    const idx = await linkIndex(c, i.id, eff);
    const plan = [];
    for (const it of i.items) for (const oid of it.object_ids) {
      const cur = (idx.get(`${it.object_type}:${oid}`) ?? []).map((u) => a.map.get(u)).find((u) => u?.kind === dest.kind) ?? null;
      if (cur?.id === dest.id) { plan.push({ object_type: it.object_type, object_id: oid, from_unit_id: cur.id, from_name: cur.name, skip: 'already_there' }); continue; }
      if (cur && !a.all && !a.visible.has(cur.id)) throw notFound('Unit');   // never reveal where something sits in a branch the caller cannot see
      if (cur) throw conflict('That object is already placed on a campus. Moving it is a transfer: use request_org_transfer, which runs your academy\'s transfer process.', { object_id: oid });
      if (!a.manage) throw forbidden('Only an owner or admin can place objects that are not on any unit yet');
      plan.push({ object_type: it.object_type, object_id: oid, from_unit_id: cur?.id ?? null, from_name: cur?.name ?? null });
    }
    const moving = plan.filter((p) => !p.skip);
    const names = {};
    for (const t of OBJECT_TYPES) { const ids = plan.filter((p) => p.object_type === t).map((p) => p.object_id); if (ids.length) names[t] = await describe(c, t, ids, { people: true }); }
    const lines = plan.map((p) => ({ ...p, label: names[p.object_type]?.get(p.object_id)?.label ?? null, to_unit_id: dest.id, to_name: dest.name }));
    const kind = 'assign';
    const preview = { kind, to: { id: dest.id, name: dest.name, kind: dest.kind }, effective_on: eff, moving: moving.length, already_there: plan.length - moving.length, lines, stays_attached: await carried(c, i.items.map((it) => ({ ...it, object_ids: moving.filter((p) => p.object_type === it.object_type).map((p) => p.object_id) }))),
      preserved: 'Ids, history, sessions, charges, agreements and staff engagements are not touched: only the campus pointer changes, effective on the date above.' };
    if (i.dry_run || !moving.length) return { dry_run: true, ...preview };
    const change = (await c.query("INSERT INTO org_unit_changes(organisation_id, kind, reason, effective_on, performed_by, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id", [i.id, kind, i.reason ?? null, eff, user.id, i.idempotency_key ?? null])).rows[0];
    for (const p of moving) await moveObject(c, { unitsById: a.map, object_type: p.object_type, object_id: p.object_id, to: dest.id, effective_on: eff, changeId: change.id, by: user.id });
    const summary = { kind, to_unit_id: dest.id, to_name: dest.name, effective_on: eff, moved: moving.length, lines: lines.map(({ label, ...r }) => r) };
    await c.query('UPDATE org_unit_changes SET summary=$2 WHERE id=$1', [change.id, JSON.stringify(summary)]);
    await audit(c, user.id, `org_unit_${kind}`, 'org_unit_changes', change.id);
    for (const u of new Set([dest.id, ...moving.map((p) => p.from_unit_id).filter(Boolean)])) await event(c, i.id, u, user.id, `objects_${kind === 'assign' || u === dest.id ? 'received' : 'released'}`, { change_id: change.id, count: moving.length, to: dest.name, reason: i.reason ?? null }, change.id);
    return { change_id: change.id, dry_run: false, ...preview };
  }),
});

cap({
  name: 'list_org_unit_changes', method: 'GET', path: '/organisations/:id/unit-changes', tag: TAG,
  summary: 'The history of campus set-ups, assignments and transfers (newest first) with who made them, the effective date, what moved and whether it was rolled back. Owners/admins see all; a branch director or auditor sees changes that touched their branch.',
  input: z.object({ id, ...page }),
  handler: async ({ user }, i) => {
    const a = await campusAccess(user, i.id);
    if (!a.all && ![...a.visible].some((u) => a.can(u, 'director', 'auditor'))) throw notFound('Organisation');
    const rows = (await pool.query(
      `SELECT ch.id, ch.kind, ch.reason, ch.effective_on::text AS effective_on, ch.summary, ch.created_at, ch.rolled_back_at, usr.display_name AS by_name,
              coalesce((SELECT array_agg(DISTINCT x.unit_id) FROM org_unit_links x WHERE x.change_id=ch.id OR x.closed_by_change_id=ch.id), '{}') AS unit_ids
         FROM org_unit_changes ch JOIN users usr ON usr.id=ch.performed_by WHERE ch.organisation_id=$1 ORDER BY ch.created_at DESC LIMIT 500`, [i.id])).rows;
    const mine = rows.filter((r) => a.all || r.unit_ids.some((u) => a.visible.has(u)));
    return mine.slice(i.offset, i.offset + i.limit).map(({ unit_ids, ...r }) => r);
  },
});

cap({
  name: 'rollback_org_unit_change', method: 'POST', path: '/organisations/:id/unit-changes/:change_id/rollback', tag: TAG,
  summary: 'Undo one set-up, assignment or transfer exactly: links it opened are ended the day they began, links it closed are reopened, and nothing else is touched. Refused while a later change has moved the same objects (undo that one first). Owners/admins only; the rollback itself is audit-logged.',
  input: z.object({ id, change_id: id, reason: text(500).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await campusAccess(user, i.id, { c });
    await ensureOrgWrite(c, a);
    needAdmin(a);
    await lockOrg(c, i.id);
    const ch = (await c.query('SELECT * FROM org_unit_changes WHERE id=$1 AND organisation_id=$2 FOR UPDATE', [i.change_id, i.id])).rows[0];
    if (!ch) throw notFound('Change');
    if (ch.rolled_back_at) throw conflict('This change was already rolled back');
    const opened = (await c.query('SELECT *, effective_from::text AS effective_from, effective_to::text AS effective_to FROM org_unit_links WHERE change_id=$1 FOR UPDATE', [ch.id])).rows;
    const stale = opened.filter((l) => l.effective_to !== null && !(l.effective_to === l.effective_from));
    if (stale.length) throw conflict(`A later change has moved ${stale.length} of these objects. Roll that back first.`, { objects: stale.length });
    const closed = (await c.query('SELECT * FROM org_unit_links WHERE closed_by_change_id=$1 FOR UPDATE', [ch.id])).rows;
    for (const l of opened) await c.query('UPDATE org_unit_links SET effective_to=effective_from WHERE id=$1', [l.id]);   // zero-length: never effective, kept as history
    for (const l of closed) await c.query('UPDATE org_unit_links SET effective_to=NULL, closed_by_change_id=NULL WHERE id=$1', [l.id]);
    // an adoption also retires the default campus it created, when nothing else was placed on it since
    let retired = null;
    if (ch.kind === 'adopt') {
      const def = (await c.query('SELECT id FROM org_units WHERE organisation_id=$1 AND is_default AND archived_at IS NULL', [i.id])).rows[0];
      if (def && !(await c.query('SELECT 1 FROM org_unit_links WHERE unit_id=$1 AND effective_to IS NULL LIMIT 1', [def.id])).rowCount) {
        await c.query("UPDATE org_units SET status='archived', archived_at=now(), row_version=row_version+1 WHERE id=$1", [def.id]); retired = def.id;
        // the adoption pointed every programme at the main campus's branch; undoing it puts the grouping back exactly as it was (an academy with branches is never adopted)
        const br = (await c.query('SELECT id FROM academy_branches WHERE unit_id=$1', [def.id])).rows[0];
        if (br) { await c.query('UPDATE academy_programmes SET branch_id=NULL WHERE branch_id=$1 AND organisation_id=$2', [br.id, i.id]); await c.query('UPDATE academy_branches SET archived_at=now(), archived_by=$2 WHERE id=$1 AND archived_at IS NULL', [br.id, user.id]); }
      }
    }
    await c.query('UPDATE org_unit_changes SET rolled_back_at=now(), rolled_back_by=$2 WHERE id=$1', [ch.id, user.id]);
    await syncAllProgrammes(c, i.id, user.id);
    await audit(c, user.id, 'rollback_org_unit_change', 'org_unit_changes', ch.id);
    const units = new Set([...opened, ...closed].map((l) => l.unit_id));
    for (const u of units) await event(c, i.id, u, user.id, 'change_rolled_back', { change_id: ch.id, kind: ch.kind, reason: i.reason ?? null }, ch.id);
    return { change_id: ch.id, rolled_back: true, reopened: closed.length, ended: opened.length, retired_default_campus: retired };
  }),
});

// ---------------------------------------------------------------------------- non-destructive onboarding of an existing single-campus academy
cap({
  name: 'adopt_single_campus', method: 'POST', path: '/organisations/:id/campuses/adopt', tag: TAG, status: 201,
  summary: 'Turn an existing academy into a campus-ready one without changing a single record: creates one default campus and points every active venue, team, cohort, programme, supplier and staff member at it (their ids, history and contracts are untouched). `dry_run` shows the counts first. One change set, so `rollback_org_unit_change` restores the previous state exactly. Refused when campuses already exist (use move_org_unit_objects).',
  input: z.object({ id, name: text(80).min(2).default('Main campus'), code: UNIT_FIELDS.code, country: UNIT_FIELDS.country, city: UNIT_FIELDS.city, timezone: UNIT_FIELDS.timezone, effective_on: day.optional(), dry_run: z.boolean().default(false), idempotency_key: z.string().min(8).max(80).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await campusAccess(user, i.id, { c });
    await ensureOrgWrite(c, a);
    needAdmin(a);
    await lockOrg(c, i.id);
    if (i.idempotency_key && !i.dry_run) {
      const prior = (await c.query('SELECT * FROM org_unit_changes WHERE organisation_id=$1 AND idempotency_key=$2', [i.id, i.idempotency_key])).rows[0];
      if (prior) return { change_id: prior.id, replayed: true, ...prior.summary };
    }
    if ((await c.query("SELECT 1 FROM org_units WHERE organisation_id=$1 AND archived_at IS NULL LIMIT 1", [i.id])).rowCount) throw conflict('This academy already has campuses. Use move_org_unit_objects to place anything new.');
    const orgs = await treeOrgs(i.id, c), eff = i.effective_on ?? today();
    const pick = {
      venue: "SELECT id FROM venues WHERE organisation_id = ANY($1)", team: "SELECT id FROM teams WHERE organisation_id = ANY($1)",
      cohort: "SELECT id FROM org_cohorts WHERE organisation_id = ANY($1) AND status='active'", programme: "SELECT id FROM academy_programmes WHERE organisation_id = ANY($1) AND status <> 'archived'",
      supplier: "SELECT id FROM academy_suppliers WHERE organisation_id = ANY($1) AND status <> 'archived'", staff: "SELECT DISTINCT user_id AS id FROM organisation_members WHERE organisation_id = ANY($1) AND status='active'",
    };
    const found = {};
    for (const [t, q] of Object.entries(pick)) found[t] = (await c.query(q, [orgs])).rows.map((r) => r.id);
    found.organisation = (await c.query("SELECT id FROM organisations WHERE parent_organisation_id=$1 AND status='active'", [i.id])).rows.map((r) => r.id);
    const counts = Object.fromEntries(Object.entries(found).map(([k, v]) => [k, v.length]));
    const athletes = (await c.query("SELECT count(*)::int AS n FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE e.status='enrolled' AND k.organisation_id = ANY($1)", [orgs])).rows[0].n;
    const preview = { campus: { name: i.name, country: blank(i.country), city: blank(i.city) ?? a.org.city ?? null }, will_point: counts, athletes_following: athletes, effective_on: eff, changes_to_records: 0, rollback: 'rollback_org_unit_change' };
    if (i.dry_run) return { dry_run: true, ...preview };
    const unit = (await c.query(
      `INSERT INTO org_units(organisation_id, kind, name, code, country, city, timezone, valid_from, is_default, created_by) VALUES ($1,'campus',$2,$3,$4,$5,$6,$7,true,$8) RETURNING *`,
      [i.id, i.name, blank(i.code), blank(i.country), blank(i.city) ?? a.org.city ?? null, blank(i.timezone), eff, user.id])).rows[0];
    const change = (await c.query("INSERT INTO org_unit_changes(organisation_id, kind, reason, effective_on, performed_by, summary, idempotency_key) VALUES ($1,'adopt','Set up campuses',$2,$3,$4,$5) RETURNING id", [i.id, eff, user.id, JSON.stringify({ kind: 'adopt', ...preview }), i.idempotency_key ?? null])).rows[0];
    for (const [t, ids] of Object.entries(found)) if (ids.length) await c.query(
      `INSERT INTO org_unit_links(unit_id, unit_kind, object_type, object_id, effective_from, change_id, linked_by) SELECT $1,'campus',$2,x,$3,$4,$5 FROM unnest($6::uuid[]) x`, [unit.id, t, eff, change.id, user.id, ids]);
    await mirrorCampusToBranch(c, unit, user.id);
    await syncAllProgrammes(c, i.id, user.id);   // every programme now reads as belonging to the main campus in the branch P&L
    await audit(c, user.id, 'adopt_single_campus', 'org_units', unit.id);
    await event(c, i.id, unit.id, user.id, 'campus_set_up', { change_id: change.id, pointed: counts }, change.id);
    return { change_id: change.id, dry_run: false, unit: publicUnit(unit), ...preview };
  }),
});

// ---------------------------------------------------------------------------- branch roles
const personRef = async (ref) => {
  const r = String(ref).trim();
  return r.includes('@') ? one('SELECT id, handle, display_name FROM users WHERE email_idx=$1', [blindIndex(r)]) : one('SELECT id, handle, display_name FROM users WHERE lower(handle)=lower($1)', [r.replace(/^@/, '')]);
};

cap({
  name: 'grant_org_unit_role', method: 'POST', path: '/organisations/:id/units/:unit_id/roles', tag: TAG, status: 201,
  summary: 'Give an active organisation member a role on one unit: director, sports lead, coach, operations, finance or auditor. With inherit the role also covers the units below. Owners/admins grant any role; a branch director grants everything except director inside their branch. Roles can be dated; ending one removes access on the next request. Access is read live on every call.',
  input: z.object({ id, unit_id: id, person: z.string().min(2).max(200).describe('handle or email of an existing active member'), role: z.enum(UNIT_ROLES), inherit: z.boolean().default(true), valid_from: day.optional(), valid_to: day.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await campusAccess(user, i.id, { c });
    await ensureOrgWrite(c, a);
    const u = needManage(a, i.unit_id);
    if (!a.manage && i.role === 'director') throw forbidden('Only an owner or admin appoints a director');
    writable(a, u);
    if (i.valid_to && i.valid_from && i.valid_to < i.valid_from) throw badRequest('The end date is before the start date');
    const p = await personRef(i.person);
    if (!p || !(await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [i.id, p.id])).rowCount) throw badRequest('That person must first be an active member of the organisation (invite them under People)');
    const row = (await c.query("INSERT INTO org_unit_roles(unit_id, user_id, role, inherit, valid_from, valid_to, granted_by) VALUES ($1,$2,$3,$4,coalesce($5::date, CURRENT_DATE),$6,$7) ON CONFLICT DO NOTHING RETURNING *", [u.id, p.id, i.role, i.inherit, i.valid_from ?? null, i.valid_to ?? null, user.id])).rows[0];
    if (!row) throw conflict('That person already holds this role on this unit');
    await audit(c, user.id, 'grant_org_unit_role', 'org_unit_roles', row.id);
    await event(c, i.id, u.id, user.id, 'role_granted', { role: i.role, user_id: p.id, inherit: i.inherit, valid_to: i.valid_to ?? null });
    return { ...row, display_name: p.display_name, handle: p.handle };
  }),
});

cap({
  name: 'end_org_unit_role', method: 'DELETE', path: '/organisations/:id/units/:unit_id/roles/:role_id', tag: TAG,
  summary: 'End a branch role (kept as history). Access ends on the person\'s next request. A branch director cannot end a director role.',
  input: z.object({ id, unit_id: id, role_id: id }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await campusAccess(user, i.id, { c });
    await ensureOrgWrite(c, a);
    const u = needManage(a, i.unit_id);
    const r = (await c.query('SELECT * FROM org_unit_roles WHERE id=$1 AND unit_id=$2 AND ended_at IS NULL FOR UPDATE', [i.role_id, u.id])).rows[0];
    if (!r) throw notFound('Role');
    if (!a.manage && r.role === 'director') throw forbidden('Only an owner or admin ends a director role');
    await c.query('UPDATE org_unit_roles SET ended_at=now(), ended_by=$2 WHERE id=$1', [r.id, user.id]);
    await audit(c, user.id, 'end_org_unit_role', 'org_unit_roles', r.id);
    await event(c, i.id, u.id, user.id, 'role_ended', { role: r.role, user_id: r.user_id });
    return { ended: true };
  }),
});

// ---------------------------------------------------------------------------- policy inheritance
cap({
  name: 'set_org_unit_policy', method: 'POST', path: '/organisations/:id/units/:unit_id/policies', tag: TAG,
  summary: `Set a policy on a unit; every unit below inherits it unless it sets its own (override). Keys: ${Object.keys(POLICY_KEYS).join(', ')}. Each key has a typed value (a currency code, a percentage, a number of days...), never free text. Owners/admins and the unit's director.`,
  input: z.object({ id, unit_id: id, key: z.enum(Object.keys(POLICY_KEYS)), value: z.any() }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await campusAccess(user, i.id, { c });
    await ensureOrgWrite(c, a);
    const u = needManage(a, i.unit_id);
    writable(a, u);
    const parsed = POLICY_KEYS[i.key].safeParse(i.value);
    if (!parsed.success) throw badRequest(`Invalid value for ${i.key}: ${parsed.error.issues[0]?.message ?? 'wrong type'}`);
    await lockOrg(c, i.id);
    const prev = (await c.query('SELECT id, value FROM org_unit_policies WHERE unit_id=$1 AND key=$2 AND cleared_at IS NULL FOR UPDATE', [u.id, i.key])).rows[0];
    if (prev) await c.query('UPDATE org_unit_policies SET cleared_at=now(), cleared_by=$2 WHERE id=$1', [prev.id, user.id]);
    await c.query('INSERT INTO org_unit_policies(unit_id, key, value, set_by) VALUES ($1,$2,$3,$4)', [u.id, i.key, JSON.stringify(parsed.data), user.id]);
    await audit(c, user.id, 'set_org_unit_policy', 'org_units', u.id);
    await event(c, i.id, u.id, user.id, 'policy_set', { key: i.key, from: prev?.value ?? null, to: parsed.data });
    return { policies: await effectivePolicies(c, unitMap(await loadUnits(i.id, c)), u.id) };
  }),
});

cap({
  name: 'clear_org_unit_policy', method: 'DELETE', path: '/organisations/:id/units/:unit_id/policies/:key', tag: TAG,
  summary: 'Remove a unit\'s own setting so it inherits from the unit above again (the old value stays in the audit trail).',
  input: z.object({ id, unit_id: id, key: z.enum(Object.keys(POLICY_KEYS)) }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await campusAccess(user, i.id, { c });
    await ensureOrgWrite(c, a);
    const u = needManage(a, i.unit_id);
    const prev = (await c.query('SELECT id, value FROM org_unit_policies WHERE unit_id=$1 AND key=$2 AND cleared_at IS NULL FOR UPDATE', [u.id, i.key])).rows[0];
    if (!prev) throw notFound('Policy');
    await c.query('UPDATE org_unit_policies SET cleared_at=now(), cleared_by=$2 WHERE id=$1', [prev.id, user.id]);
    await audit(c, user.id, 'clear_org_unit_policy', 'org_units', u.id);
    await event(c, i.id, u.id, user.id, 'policy_cleared', { key: i.key, was: prev.value });
    return { policies: await effectivePolicies(c, unitMap(await loadUnits(i.id, c)), u.id) };
  }),
});

// ---------------------------------------------------------------------------- audit trail
cap({
  name: 'list_org_unit_audit', method: 'GET', path: '/organisations/:id/campus-audit', tag: TAG,
  summary: 'Audit trail of the campus structure: units created/changed/suspended/archived, objects received and released, roles granted and ended, policies set and cleared, changes rolled back, with who did it and when. Whole group for owners/admins and auditors; one branch for its director or auditor (pass unit_id). Reading it is itself audit-logged.',
  input: z.object({ id, unit_id: id.optional(), action: z.string().max(40).optional(), ...page }),
  handler: async ({ user }, i) => {
    const a = await campusAccess(user, i.id);
    let ids = null;
    if (i.unit_id) { const u = unitIn(a, i.unit_id); if (!(a.all || a.can(u.id, 'director', 'auditor'))) throw forbidden('The audit trail is for owners, admins, directors and auditors'); ids = [...descendants(a.units, u.id)]; }
    else if (!a.all) { ids = [...a.visible].filter((u) => a.can(u, 'director', 'auditor')); if (!ids.length) throw forbidden('The audit trail is for owners, admins, directors and auditors'); }
    await audit(pool, user.id, 'read_campus_audit', 'organisations', i.id);
    return many(
      `SELECT ev.id, ev.unit_id, un.name AS unit_name, ev.action, ev.detail, ev.change_id, ev.at, usr.display_name AS actor_name
         FROM org_unit_events ev LEFT JOIN org_units un ON un.id=ev.unit_id LEFT JOIN users usr ON usr.id=ev.actor_id
        WHERE ev.organisation_id=$1 AND ($2::uuid[] IS NULL OR ev.unit_id = ANY($2)) AND ($3::text IS NULL OR ev.action=$3) ORDER BY ev.at DESC, ev.id DESC LIMIT $4 OFFSET $5`, [i.id, ids, i.action ?? null, i.limit, i.offset]);
  },
});

// ---------------------------------------------------------------------------- pickers: what can be placed / moved
cap({
  name: 'list_org_unit_candidates', method: 'GET', path: '/organisations/:id/campus-candidates', tag: TAG,
  summary: 'Search the academy group\'s venues, teams, cohorts, programmes, athletes (enrolments), staff, suppliers or child academies for the placement and transfer pickers, each with the unit it is on today. Owners/admins search everything; a branch director only objects currently on their branch. Athlete and staff names need a people-visible role.',
  input: z.object({ id, object_type: z.enum(OBJECT_TYPES), q: z.string().trim().max(80).optional(), unplaced_only: z.coerce.boolean().default(false), unit_id: id.optional(), ...page }),
  handler: async ({ user }, i) => {
    const a = await campusAccess(user, i.id);
    if (!a.all && !a.visible.size) throw notFound('Organisation');
    const orgs = await treeOrgs(i.id);
    const sql = {
      venue: 'SELECT id, name AS label, city AS sub FROM venues WHERE organisation_id = ANY($1)',
      team: 'SELECT id, name AS label, sport AS sub FROM teams WHERE organisation_id = ANY($1)',
      cohort: "SELECT id, name AS label, status AS sub FROM org_cohorts WHERE organisation_id = ANY($1) AND status='active'",
      programme: "SELECT id, title AS label, sport AS sub FROM academy_programmes WHERE organisation_id = ANY($1) AND status <> 'archived'",
      supplier: "SELECT id, name AS label, kind AS sub FROM academy_suppliers WHERE organisation_id = ANY($1) AND status <> 'archived'",
      organisation: "SELECT id, name AS label, city AS sub FROM organisations WHERE parent_organisation_id = $1 AND status='active'",
      staff: "SELECT DISTINCT u.id, u.display_name AS label, m.role AS sub FROM organisation_members m JOIN users u ON u.id=m.user_id WHERE m.organisation_id = ANY($1) AND m.status='active'",
      enrolment: "SELECT e.id, e.cohort_id, e.programme_id, u.display_name AS label, k.name AS sub FROM org_enrolments e JOIN users u ON u.id=e.user_id JOIN org_cohorts k ON k.id=e.cohort_id WHERE e.status='enrolled' AND k.organisation_id = ANY($1)",
    }[i.object_type];
    const rows = (await pool.query(sql, [i.object_type === 'organisation' ? i.id : orgs])).rows;
    const idx = await linkIndex(pool, i.id, today());
    const q = i.q?.toLowerCase();
    const scope = i.unit_id ? descendants(a.units, unitIn(a, i.unit_id).id) : null;
    const peopleSeen = a.all || [...a.visible].some((u) => peopleOk(a, u));
    const out = rows.map((r) => {
      // an athlete sits where their own link says, else their cohort's, else their programme's (the same rule the roll-up uses)
      const keys = i.object_type === 'enrolment' ? [`enrolment:${r.id}`, `cohort:${r.cohort_id}`, r.programme_id && `programme:${r.programme_id}`] : [`${i.object_type}:${r.id}`];
      const at = (keys.map((k) => idx.get(k)).find((v) => v?.length) ?? []).map((u) => a.map.get(u)).filter(Boolean);
      return { id: r.id, label: ['enrolment', 'staff'].includes(i.object_type) && !peopleSeen ? 'Restricted' : r.label, sub: r.sub, on: at.map((u) => ({ id: u.id, name: u.name, kind: u.kind })) };
    }).filter((r) => (!q || `${r.label} ${r.sub ?? ''}`.toLowerCase().includes(q))
      && (!i.unplaced_only || !r.on.length)
      && (a.all || r.on.some((u) => a.visible.has(u.id)))
      && (!scope || r.on.some((u) => scope.has(u.id))));
    out.sort((x, y) => String(x.label).localeCompare(String(y.label)));
    return { total: out.length, items: out.slice(i.offset, i.offset + i.limit) };
  },
});
