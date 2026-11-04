// Campus & academy hierarchy (#781): access, tree rules, link resolution, policy inheritance and the consolidated roll-up.
// Everything here only READS or POINTS at canonical objects (venues, teams, cohorts, programmes, enrolments, staff, suppliers, child academies).
// Nothing is copied, deleted or re-identified: a unit is a node, a link is an effective-dated pointer.
import { z } from 'zod';
import { pool } from './db.js';
import { isAdmin } from './helpers.js';
import { forbidden, notFound, badRequest, conflict } from './errors.js';
import { requireApproved } from './org-access.js';
import { isSupportedCurrency } from './currency.js';

export const UNIT_KINDS = ['region', 'campus', 'department'];
export const UNIT_ROLES = ['director', 'sports_lead', 'coach', 'operations', 'finance', 'auditor'];
export const OBJECT_TYPES = ['venue', 'team', 'cohort', 'programme', 'enrolment', 'staff', 'supplier', 'organisation'];
/** Which unit kinds an object type may be pointed at. Programmes/cohorts/people can sit in a campus and a department; assets only in a campus. */
export const LINKABLE = { venue: ['campus'], team: ['campus', 'department'], cohort: ['campus', 'department'], programme: ['campus', 'department'], enrolment: ['campus', 'department'], staff: ['campus', 'department'], supplier: ['campus'], organisation: ['region', 'campus'] };
const MAX_DEPTH = 6;

// ---------------------------------------------------------------------------- policy catalogue (one typed definition per key; nothing free-form)
export const POLICY_KEYS = {
  currency: z.string().length(3).transform((v) => v.toUpperCase()).refine(isSupportedCurrency, 'Unsupported currency'),
  timezone: z.string().trim().min(3).max(60),
  attendance_min_pct: z.number().int().min(0).max(100),
  coach_athlete_ratio_max: z.number().int().min(1).max(100),
  refund_window_days: z.number().int().min(0).max(365),
  late_fee_grace_days: z.number().int().min(0).max(60),
  guardian_consent_renewal_months: z.number().int().min(1).max(36),
  youth_pickup_required: z.boolean(),
  report_cadence: z.enum(['weekly', 'monthly', 'termly']),
};

// ---------------------------------------------------------------------------- units
/** pg returns DATE columns as local-midnight Date objects; this module compares and prints plain YYYY-MM-DD strings. */
export const ymd = (d) => (d == null ? null : typeof d === 'string' ? d.slice(0, 10) : new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10));
export const loadUnits = async (orgId, c = pool) => (await c.query("SELECT *, valid_from::text AS valid_from, valid_to::text AS valid_to FROM org_units WHERE organisation_id=$1 ORDER BY kind, lower(name), id", [orgId])).rows;
export const unitMap = (units) => new Map(units.map((u) => [u.id, u]));
/** The unit and every ancestor, nearest first. */
export function chain(map, id) { const out = []; for (let u = map.get(id), n = 0; u && n < MAX_DEPTH + 2; u = map.get(u.parent_id), n++) out.push(u); return out; }
export const descendants = (units, id) => { const kids = new Map(); for (const u of units) if (u.parent_id) (kids.get(u.parent_id) ?? kids.set(u.parent_id, []).get(u.parent_id)).push(u.id); const out = new Set([id]); const q = [id]; while (q.length) for (const k of kids.get(q.pop()) ?? []) if (!out.has(k)) { out.add(k); q.push(k); } return out; };

/** A unit's place in the tree must follow region -> campus -> department. Throws a 400/409 with a plain reason. */
export function checkParent(map, kind, parentId, selfId = null) {
  const parent = parentId ? map.get(parentId) : null;
  if (parentId && !parent) throw badRequest('That parent does not belong to this organisation');
  if (parent && parent.status === 'archived') throw conflict('The parent is archived');
  if (kind === 'region' && parent && parent.kind !== 'region') throw badRequest('A region sits at the top or inside another region');
  if (kind === 'campus' && parent && parent.kind !== 'region') throw badRequest('A campus sits at the top or inside a region');
  if (kind === 'department' && (!parent || parent.kind !== 'campus')) throw badRequest('A sport department belongs to a campus');
  if (selfId && parent && chain(map, parent.id).some((u) => u.id === selfId)) throw badRequest('A unit cannot move inside itself');
  if (parent && chain(map, parent.id).length >= MAX_DEPTH) throw badRequest('The hierarchy is too deep');
  return parent;
}

// ---------------------------------------------------------------------------- access
const today = () => new Date().toISOString().slice(0, 10);

/**
 * What the caller may see and do in the organisation's campus tree.
 *  - owner / admin / platform admin: everything.
 *  - anyone else needs an active membership AND a live unit role; they see that unit and (if inherited) everything below it, plus the
 *    names of the units above it for orientation (context only, no figures).
 *  - everyone else gets 404 (existence is not leaked).
 */
export async function campusAccess(user, orgId, { c = pool } = {}) {
  const org = (await c.query('SELECT * FROM organisations WHERE id=$1', [orgId])).rows[0];
  if (!org) throw notFound('Organisation');
  const member = isAdmin(user) ? { role: 'owner' } : (await c.query("SELECT role FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [orgId, user.id])).rows[0];
  if (!member) throw notFound('Organisation');
  const units = await loadUnits(orgId, c);
  const map = unitMap(units);
  if (member.role === 'owner' || member.role === 'admin') return { org, units, map, all: true, manage: true, member, roles: new Map(), visible: new Set(units.map((u) => u.id)), context: new Set(), can: () => true, canManage: () => true };
  const held = (await c.query(
    `SELECT r.unit_id, r.role, r.inherit FROM org_unit_roles r JOIN org_units u ON u.id=r.unit_id
      WHERE u.organisation_id=$1 AND r.user_id=$2 AND r.ended_at IS NULL AND r.valid_from <= $3 AND (r.valid_to IS NULL OR r.valid_to >= $3)`, [orgId, user.id, today()])).rows;
  if (!held.length && member.role !== 'finance') throw notFound('Organisation');   // a plain member with no campus role has no campus view (an organisation finance member can take part in transfers)
  const roles = new Map(), visible = new Set(), context = new Set();
  for (const h of held) {
    const reach = h.inherit ? descendants(units, h.unit_id) : new Set([h.unit_id]);
    for (const uid of reach) { visible.add(uid); (roles.get(uid) ?? roles.set(uid, new Set()).get(uid)).add(h.role); }
    for (const a of chain(map, h.unit_id)) if (!visible.has(a.id)) context.add(a.id);
  }
  for (const v of visible) context.delete(v);
  const has = (uid, ...want) => [...(roles.get(uid) ?? [])].some((r) => want.includes(r));
  return { org, units, map, all: false, manage: false, member, roles, visible, context, can: (uid, ...want) => has(uid, ...want), canManage: (uid) => has(uid, 'director') };
}

/** Require the unit to be in the caller's scope; otherwise 404 (not 403) so another branch's existence is not leaked. */
export function unitIn(a, unitId) {
  const u = a.map.get(unitId);
  if (!u || !(a.all || a.visible.has(unitId))) throw notFound('Unit');
  return u;
}
export function needManage(a, unitId) {
  const u = unitIn(a, unitId);
  if (!a.canManage(unitId)) throw forbidden('Only an owner, an admin or this unit\'s director can change it');
  return u;
}
export const needAdmin = (a) => { if (!a.manage) throw forbidden('Only owners and admins can change the campus structure'); };
export function writable(a, u) {
  if (a.org.status !== 'active') throw conflict('This organisation is archived and read-only');
  if (u && u.status === 'archived') throw conflict('This unit is archived and read-only');
}

// ---------------------------------------------------------------------------- objects an organisation tree may point at
/** The organisation itself and its child academies: the objects of any of them can be placed on this tree. */
export const treeOrgs = async (orgId, c = pool) => (await c.query('SELECT id FROM organisations WHERE id=$1 OR parent_organisation_id=$1', [orgId])).rows.map((r) => r.id);

const OBJECT_SQL = {
  venue: 'SELECT id, organisation_id AS org FROM venues WHERE id = ANY($1)',
  team: 'SELECT id, organisation_id AS org FROM teams WHERE id = ANY($1)',
  cohort: 'SELECT id, organisation_id AS org FROM org_cohorts WHERE id = ANY($1)',
  programme: 'SELECT id, organisation_id AS org FROM academy_programmes WHERE id = ANY($1)',
  enrolment: "SELECT e.id, k.organisation_id AS org FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE e.id = ANY($1)",
  staff: "SELECT DISTINCT m.user_id AS id, m.organisation_id AS org FROM organisation_members m WHERE m.user_id = ANY($1) AND m.status='active' AND m.organisation_id = ANY($2)",
  supplier: 'SELECT id, organisation_id AS org FROM academy_suppliers WHERE id = ANY($1)',
  organisation: 'SELECT id, parent_organisation_id AS org FROM organisations WHERE id = ANY($1)',
};
/** Every id must exist and belong to the tree's organisations (staff: be an active member). Throws 400 naming how many do not. */
export async function checkObjects(c, orgId, type, ids) {
  const orgs = await treeOrgs(orgId, c);
  const rows = (await c.query(OBJECT_SQL[type], type === 'staff' ? [ids, orgs] : [ids])).rows;
  const ok = new Set(rows.filter((r) => (type === 'organisation' ? r.org === orgId : orgs.includes(r.org))).map((r) => r.id));
  const bad = ids.filter((i) => !ok.has(i));
  if (bad.length) throw badRequest(`${bad.length} ${type}${bad.length === 1 ? '' : 's'} not found in this academy group`, { type, ids: bad });
}

// ---------------------------------------------------------------------------- links
export const openOn = (asOf) => '(l.effective_from <= $ASOF AND (l.effective_to IS NULL OR l.effective_to > $ASOF))'.replaceAll('$ASOF', asOf);

/** Open links of the tree at a date, as Map "type:id" -> [unit ids]. */
export async function linkIndex(c, orgId, asOf) {
  const rows = (await c.query(
    `SELECT l.object_type, l.object_id, l.unit_id FROM org_unit_links l JOIN org_units u ON u.id=l.unit_id
      WHERE u.organisation_id=$1 AND l.effective_from <= $2 AND (l.effective_to IS NULL OR l.effective_to > $2)`, [orgId, asOf])).rows;
  const idx = new Map();
  for (const r of rows) { const k = `${r.object_type}:${r.object_id}`; (idx.get(k) ?? idx.set(k, []).get(k)).push(r.unit_id); }
  return idx;
}

export const campusOf = (map, id) => chain(map, id).find((u) => u.kind === 'campus')?.id ?? null;

/**
 * Point an object at its new unit: its open link of the same kind ends, and so does any link into a different campus (a cohort leaving a
 * Pune department for Goa must not stay counted in Pune), then the new link starts on the effective date. History is kept, never rewritten.
 */
export async function moveObject(c, { unitsById, object_type, object_id, to, effective_on, changeId, by }) {
  const dest = unitsById.get(to), destCampus = campusOf(unitsById, to);
  const open = (await c.query('SELECT l.*, l.effective_from::text AS effective_from FROM org_unit_links l WHERE l.object_type=$1 AND l.object_id=$2 AND l.effective_to IS NULL FOR UPDATE', [object_type, object_id])).rows;
  if (open.some((l) => l.unit_id === to)) return { skipped: true, from: to };
  const leaving = open.filter((l) => l.unit_kind === dest.kind || campusOf(unitsById, l.unit_id) !== destCampus);
  for (const l of leaving) {
    if (l.effective_from > effective_on) throw conflict(`The ${object_type} was moved on ${l.effective_from}; pick a later effective date`);
    await c.query('UPDATE org_unit_links SET effective_to=$2, closed_by_change_id=$3 WHERE id=$1', [l.id, effective_on, changeId]);
  }
  const link = (await c.query('INSERT INTO org_unit_links(unit_id, unit_kind, object_type, object_id, effective_from, change_id, linked_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [to, dest.kind, object_type, object_id, effective_on, changeId, by])).rows[0];
  if (object_type === 'programme' && effective_on <= new Date().toISOString().slice(0, 10)) await syncProgrammeBranch(c, object_id, by);   // keeps the branch P&L grouping equal to the campus
  return { skipped: false, from: leaving[0]?.unit_id ?? null, link_id: link.id };
}

/** Where an object sits today, as the unit of the destination's kind: its own link; for an athlete, the cohort's or programme's; a department's campus when the destination is a campus. */
export async function homeOf(c, map, idx, type, oid, destKind) {
  let keys = [`${type}:${oid}`];
  if (type === 'enrolment') { const e = (await c.query('SELECT cohort_id, programme_id FROM org_enrolments WHERE id=$1', [oid])).rows[0]; keys = [`enrolment:${oid}`, `cohort:${e?.cohort_id}`, e?.programme_id && `programme:${e.programme_id}`]; }
  for (const k of keys) {
    const units = (idx.get(k) ?? []).map((u) => map.get(u)).filter(Boolean);
    if (!units.length) continue;
    const hit = units.find((u) => u.kind === destKind) ?? (destKind === 'campus' ? map.get(campusOf(map, units[0].id)) : null);
    if (hit) return hit;
  }
  return null;
}

export const event = (c, orgId, unitId, actor, action, detail = {}, changeId = null) =>
  c.query('INSERT INTO org_unit_events(organisation_id, unit_id, actor_id, action, detail, change_id) VALUES ($1,$2,$3,$4,$5,$6)', [orgId, unitId, actor, action, JSON.stringify(detail), changeId]);

// ---------------------------------------------------------------------------- policy inheritance
/** Effective policies of a unit: nearest ancestor wins; each carries where it comes from. */
export async function effectivePolicies(c, map, unitId) {
  const ids = chain(map, unitId).map((u) => u.id);
  const rows = (await c.query('SELECT unit_id, key, value FROM org_unit_policies WHERE unit_id = ANY($1) AND cleared_at IS NULL', [ids])).rows;
  const out = {};
  for (const key of Object.keys(POLICY_KEYS)) {
    for (const id of ids) {   // nearest first
      const r = rows.find((x) => x.unit_id === id && x.key === key);
      if (r) { out[key] = { value: r.value, from_unit_id: id, from_name: map.get(id).name, inherited: id !== unitId, overrides: false }; break; }
    }
  }
  for (const key of Object.keys(out)) if (!out[key].inherited && rows.some((x) => x.key === key && x.unit_id !== unitId && ids.includes(x.unit_id))) out[key].overrides = true;
  return out;
}

// ---------------------------------------------------------------------------- consolidated roll-up
const blankMetrics = () => ({ venues: 0, teams: 0, programmes: 0, cohorts: 0, staff: 0, coaches: 0, athletes: 0, capacity: 0, attendance_present: 0, attendance_total: 0, money: new Map() });

/**
 * Per-unit figures as of a date. An object counts for the unit it is pointed at and every unit above it, so a region's figures are the sum of
 * its campuses and nothing is double counted. Athlete -> unit follows enrolment link, then cohort link, then programme link (the most
 * specific pointer wins). Money is only computed when `withMoney` (finance-visible scopes).
 */
export async function rollup(c, orgId, units, asOf, { withMoney = false } = {}) {
  const map = unitMap(units), idx = await linkIndex(c, orgId, asOf);
  const orgs = await treeOrgs(orgId, c);
  const m = new Map(units.map((u) => [u.id, blankMetrics()]));
  const bump = (unitIds, fn) => { const seen = new Set(); for (const uid of unitIds) for (const a of chain(map, uid)) if (!seen.has(a.id)) { seen.add(a.id); fn(m.get(a.id)); } };
  const unitsOf = (...keys) => { for (const k of keys) { const v = idx.get(k); if (v?.length) return v; } return null; };

  const venueIds = [...idx.keys()].filter((k) => k.startsWith('venue:'));
  for (const k of venueIds) bump(idx.get(k), (x) => { x.venues++; });
  for (const k of idx.keys()) {
    const [type] = k.split(':');
    if (type === 'team') bump(idx.get(k), (x) => { x.teams++; });
    if (type === 'cohort') bump(idx.get(k), (x) => { x.cohorts++; });
    if (type === 'staff') bump(idx.get(k), (x) => { x.staff++; });
  }
  const progs = (await c.query("SELECT id, capacity FROM academy_programmes WHERE organisation_id = ANY($1) AND status IN ('published','closed')", [orgs])).rows;
  for (const p of progs) { const u = idx.get(`programme:${p.id}`); if (u) bump(u, (x) => { x.programmes++; x.capacity += p.capacity ?? 0; }); }
  const coaches = new Set((await c.query("SELECT user_id FROM organisation_members WHERE organisation_id = ANY($1) AND status='active' AND role='coach'", [orgs])).rows.map((r) => r.user_id));
  for (const k of idx.keys()) if (k.startsWith('staff:') && coaches.has(k.slice(6))) bump(idx.get(k), (x) => { x.coaches++; });

  const enrols = (await c.query(
    `SELECT e.id, e.cohort_id, e.programme_id FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE e.status='enrolled' AND k.organisation_id = ANY($1)`, [orgs])).rows;
  const where = (e) => unitsOf(`enrolment:${e.id}`, `cohort:${e.cohort_id}`, e.programme_id && `programme:${e.programme_id}`);
  const athleteUnit = new Map();
  for (const e of enrols) { const u = where(e); if (u) { athleteUnit.set(e.id, u); bump(u, (x) => { x.athletes++; }); } }

  const att = (await c.query(
    `SELECT a.enrolment_id, s.cohort_id, s.programme_id, a.status, count(*)::int AS n
       FROM academy_attendance a JOIN academy_sessions s ON s.id=a.session_id
      WHERE s.organisation_id = ANY($1) AND s.starts_at >= ($2::date - 30) AND s.starts_at < ($2::date + 1) AND a.status IN ('present','late','left_early','absent')
      GROUP BY 1,2,3,4`, [orgs, asOf])).rows;
  for (const r of att) {
    const u = (r.enrolment_id && athleteUnit.get(r.enrolment_id)) ?? unitsOf(`cohort:${r.cohort_id}`, r.programme_id && `programme:${r.programme_id}`);
    if (u) bump(u, (x) => { x.attendance_total += r.n; if (r.status !== 'absent') x.attendance_present += r.n; });
  }
  if (withMoney) {
    const ch = (await c.query(
      `SELECT ch.enrolment_id, e.cohort_id, e.programme_id, ch.currency,
              coalesce(sum(ch.amount_minor) FILTER (WHERE ch.status='awaiting_payment'),0)::bigint AS outstanding,
              coalesce(sum(ch.amount_minor) FILTER (WHERE ch.status='awaiting_payment' AND ch.due_on < $2::date),0)::bigint AS overdue,
              coalesce(sum(ch.amount_minor) FILTER (WHERE ch.status='paid'),0)::bigint AS paid
         FROM academy_charges ch JOIN org_enrolments e ON e.id=ch.enrolment_id
        WHERE ch.organisation_id = ANY($1) GROUP BY 1,2,3,4`, [orgs, asOf])).rows;
    for (const r of ch) {
      const u = athleteUnit.get(r.enrolment_id) ?? unitsOf(`cohort:${r.cohort_id}`, r.programme_id && `programme:${r.programme_id}`);
      if (u) bump(u, (x) => { const cur = x.money.get(r.currency) ?? { currency: r.currency, outstanding_minor: 0, overdue_minor: 0, paid_minor: 0 }; cur.outstanding_minor += Number(r.outstanding); cur.overdue_minor += Number(r.overdue); cur.paid_minor += Number(r.paid); x.money.set(r.currency, cur); });
    }
  }
  const unlinked = { athletes: enrols.length - athleteUnit.size };
  return { metrics: m, unlinked, idx };
}

export const shapeMetrics = (x, withMoney) => ({
  venues: x.venues, teams: x.teams, programmes: x.programmes, cohorts: x.cohorts, staff: x.staff, coaches: x.coaches, athletes: x.athletes, capacity: x.capacity,
  fill_pct: x.capacity ? Math.min(100, Math.round((x.athletes / x.capacity) * 100)) : null,
  attendance_pct: x.attendance_total ? Math.round((x.attendance_present / x.attendance_total) * 100) : null,
  athletes_per_coach: x.coaches ? Math.round((x.athletes / x.coaches) * 10) / 10 : null,
  ...(withMoney ? { money: [...x.money.values()] } : {}),
});

/** Writes need an active, platform-approved organisation (same rule as every other organisation write). */
export async function ensureOrgWrite(c, a) {
  if (a.org.status !== 'active') throw conflict('This organisation is archived and read-only');
  await requireApproved(a.org, c);
}

/** What stays attached, unchanged, when objects move: used by the placement preview and the transfer request. */
export async function carried(c, items) {
  const out = { athletes: 0, upcoming_sessions: 0, open_charges: 0, engagements: 0 };
  const ids = (t) => items.filter((x) => x.object_type === t).flatMap((x) => x.object_ids);
  const coh = ids('cohort'), prog = ids('programme'), enr = ids('enrolment'), stf = ids('staff');
  if (coh.length || prog.length) {
    out.athletes += (await c.query("SELECT count(*)::int AS n FROM org_enrolments WHERE status='enrolled' AND (cohort_id = ANY($1) OR programme_id = ANY($2))", [coh, prog])).rows[0].n;
    out.upcoming_sessions += (await c.query("SELECT count(*)::int AS n FROM academy_sessions WHERE starts_at > now() AND status IN ('draft','published') AND (cohort_id = ANY($1) OR programme_id = ANY($2))", [coh, prog])).rows[0].n;
    out.open_charges += (await c.query("SELECT count(*)::int AS n FROM academy_charges ch JOIN org_enrolments e ON e.id=ch.enrolment_id WHERE ch.status='awaiting_payment' AND (e.cohort_id = ANY($1) OR e.programme_id = ANY($2))", [coh, prog])).rows[0].n;
  }
  if (enr.length) {
    out.athletes += enr.length;
    out.open_charges += (await c.query("SELECT count(*)::int AS n FROM academy_charges WHERE status='awaiting_payment' AND enrolment_id = ANY($1)", [enr])).rows[0].n;
  }
  if (stf.length) {
    out.engagements += (await c.query('SELECT count(*)::int AS n FROM org_staff_engagements WHERE user_id = ANY($1)', [stf])).rows[0].n;
    out.upcoming_sessions += (await c.query("SELECT count(DISTINCT st.session_id)::int AS n FROM academy_session_staff st JOIN academy_sessions s ON s.id=st.session_id WHERE st.user_id = ANY($1) AND s.starts_at > now() AND st.status IN ('assigned','confirmed')", [stf])).rows[0].n;
  }
  return out;
}


// ---------------------------------------------------------------------------- display names for linked objects (no copies: read live)
export async function describe(c, type, ids, { people = true } = {}) {
  if (!ids.length) return new Map();
  const q = {
    venue: 'SELECT id, name AS label, city AS sub FROM venues WHERE id = ANY($1)',
    team: 'SELECT id, name AS label, sport AS sub FROM teams WHERE id = ANY($1)',
    cohort: 'SELECT id, name AS label, status AS sub FROM org_cohorts WHERE id = ANY($1)',
    programme: 'SELECT id, title AS label, sport AS sub FROM academy_programmes WHERE id = ANY($1)',
    supplier: 'SELECT id, name AS label, kind AS sub FROM academy_suppliers WHERE id = ANY($1)',
    organisation: 'SELECT id, name AS label, city AS sub FROM organisations WHERE id = ANY($1)',
    staff: "SELECT u.id, u.display_name AS label, u.handle AS sub FROM users u WHERE u.id = ANY($1)",
    enrolment: "SELECT e.id, u.display_name AS label, k.name AS sub FROM org_enrolments e JOIN users u ON u.id=e.user_id JOIN org_cohorts k ON k.id=e.cohort_id WHERE e.id = ANY($1)",
  }[type];
  const rows = (await c.query(q, [ids])).rows;
  // finance / auditor scopes see counts, not athlete names
  return new Map(rows.map((r) => [r.id, people || !['enrolment', 'staff'].includes(type) ? { label: r.label, sub: r.sub } : { label: 'Restricted', sub: null }]));
}


// ---------------------------------------------------------------------------- branches ARE campuses (kept in step with academy_branches)
/**
 * Main's academy_branches (a flat grouping of programmes and venues for the P&L) and the campus tree are one thing seen two ways. A campus always
 * has a branch row (created on demand) and a branch always has a campus (backfilled by the migration, created with the branch afterwards), so the
 * branch endpoints, the branch P&L and the campus screens always agree. Everything here is additive and idempotent.
 */
/** The branch row that mirrors a campus: created when the campus has none; kept in step (name, city, code, archived) when it has. */
export async function mirrorCampusToBranch(c, unit, actor) {
  if (unit.kind !== 'campus') return null;
  const cur = (await c.query('SELECT * FROM academy_branches WHERE unit_id=$1 OR id=$2 LIMIT 1', [unit.id, unit.legacy_branch_id ?? null])).rows[0];
  const code = unit.code && /^[A-Za-z0-9-]{2,12}$/.test(unit.code) ? unit.code : null;
  if (cur) {
    // a rename that would collide with another live branch keeps the branch's own name (the campus keeps its name; the two are distinguished by code)
    const clash = unit.status !== 'archived' && (await c.query('SELECT 1 FROM academy_branches WHERE organisation_id=$1 AND lower(name)=lower($2) AND archived_at IS NULL AND id<>$3', [unit.organisation_id, unit.name, cur.id])).rowCount;
    await c.query(
      `UPDATE academy_branches SET name=$2, city=$3, code=coalesce($4, code), unit_id=$1,
              archived_at=CASE WHEN $5::text='archived' THEN coalesce(archived_at, now()) ELSE NULL END, archived_by=CASE WHEN $5::text='archived' THEN coalesce(archived_by, $6::uuid) ELSE NULL END WHERE id=$7`,
      [unit.id, clash ? cur.name : unit.name, unit.city ?? null, code, unit.status, actor, cur.id]);
    await c.query('UPDATE org_units SET legacy_branch_id=$2 WHERE id=$1 AND legacy_branch_id IS NULL', [unit.id, cur.id]);
    return cur.id;
  }
  let name = unit.name;
  if ((await c.query('SELECT 1 FROM academy_branches WHERE organisation_id=$1 AND lower(name)=lower($2) AND archived_at IS NULL', [unit.organisation_id, name])).rowCount) name = `${name} (${code ?? 'campus'})`.slice(0, 80);
  const b = (await c.query(
    'INSERT INTO academy_branches(organisation_id, name, city, code, opened_on, created_by, unit_id, archived_at, archived_by) VALUES ($1,$2,$3,$4,$5,$6::uuid,$7,CASE WHEN $8::text=\'archived\' THEN now() END,CASE WHEN $8::text=\'archived\' THEN $6::uuid END) RETURNING id',
    [unit.organisation_id, name, unit.city ?? null, code, ymd(unit.valid_from), actor ?? unit.created_by, unit.id, unit.status])).rows[0];
  await c.query('UPDATE org_units SET legacy_branch_id=$2 WHERE id=$1', [unit.id, b.id]);
  return b.id;
}

/** The campus a programme is placed on today (nearest campus of its open link), or null. */
export async function programmeCampus(c, programmeId) {
  const r = (await c.query("SELECT u.id, u.kind, u.parent_id, u.organisation_id FROM org_unit_links l JOIN org_units u ON u.id=l.unit_id WHERE l.object_type='programme' AND l.object_id=$1 AND l.effective_to IS NULL AND l.effective_from <= CURRENT_DATE ORDER BY (u.kind='campus') DESC LIMIT 1", [programmeId])).rows[0];
  if (!r) return null;
  if (r.kind === 'campus') return r.id;
  const map = unitMap(await loadUnits(r.organisation_id, c));
  return campusOf(map, r.id);
}
/** Keep academy_programmes.branch_id (read by the branch P&L) equal to the branch of the programme's campus; a programme with no campus keeps whatever it had. */
export async function syncProgrammeBranch(c, programmeId, actor) {
  const campus = await programmeCampus(c, programmeId);
  if (!campus) return;
  const u = (await c.query('SELECT * FROM org_units WHERE id=$1', [campus])).rows[0];
  if (!u || u.status === 'archived') return;
  const branchId = u.legacy_branch_id ?? (await mirrorCampusToBranch(c, u, actor));
  if (branchId) await c.query('UPDATE academy_programmes SET branch_id=$2 WHERE id=$1 AND branch_id IS DISTINCT FROM $2', [programmeId, branchId]);
}
export async function syncAllProgrammes(c, orgId, actor) {
  const ids = (await c.query("SELECT DISTINCT l.object_id FROM org_unit_links l JOIN org_units u ON u.id=l.unit_id WHERE u.organisation_id=$1 AND l.object_type='programme' AND l.effective_to IS NULL", [orgId])).rows;
  for (const r of ids) await syncProgrammeBranch(c, r.object_id, actor);
}
/** A change set for work done through the branch endpoints, so it shows in the campus history too. */
export const legacyChange = async (c, orgId, actor, what) => (await c.query("INSERT INTO org_unit_changes(organisation_id, kind, reason, effective_on, summary, performed_by) VALUES ($1,'assign',$2,CURRENT_DATE,$3,$4) RETURNING id",
  [orgId, 'Done through the academy branch screens', JSON.stringify({ source: 'academy_branches', what }), actor])).rows[0].id;

/** The campus for a branch created through the branch endpoints: its dates, venues and manager come across; a duplicate code is left off. */
export async function createCampusForBranch(c, b, actor) {
  let unit = (await c.query('SELECT * FROM org_units WHERE legacy_branch_id=$1', [b.id])).rows[0];
  if (!unit) {
    const code = b.code && !(await c.query('SELECT 1 FROM org_units WHERE organisation_id=$1 AND lower(code)=lower($2) AND archived_at IS NULL', [b.organisation_id, b.code])).rowCount ? b.code : null;
    unit = (await c.query(
      "INSERT INTO org_units(organisation_id, kind, name, code, city, status, valid_from, created_by, archived_at, legacy_branch_id) VALUES ($1,'campus',$2,$3,$4,$5,coalesce($6::date, CURRENT_DATE),$7,CASE WHEN $5::text='archived' THEN now() END,$8) RETURNING *",
      [b.organisation_id, b.name, code, b.city ?? null, b.archived_at ? 'archived' : 'active', b.opened_on ?? null, actor ?? b.created_by, b.id])).rows[0];
  }
  await c.query('UPDATE academy_branches SET unit_id=$2 WHERE id=$1', [b.id, unit.id]);
  return unit;
}
/** Make the campus's venue pointers equal the branch's venue list: add the missing ones (a venue already on another campus stays there), end the removed ones. */
export async function syncBranchVenues(c, b, unit, actor) {
  const want = new Set(b.venue_ids ?? []);
  const open = (await c.query("SELECT id, object_id FROM org_unit_links WHERE unit_id=$1 AND object_type='venue' AND effective_to IS NULL", [unit.id])).rows;
  let changeId = null;
  const change = async () => (changeId ??= await legacyChange(c, unit.organisation_id, actor, 'venues'));
  for (const l of open) if (!want.has(l.object_id)) await c.query('UPDATE org_unit_links SET effective_to=greatest(effective_from, CURRENT_DATE), closed_by_change_id=$2 WHERE id=$1', [l.id, await change()]);
  for (const v of want) {
    if (open.some((l) => l.object_id === v)) continue;
    if ((await c.query("SELECT 1 FROM org_unit_links WHERE object_type='venue' AND object_id=$1 AND unit_kind='campus' AND effective_to IS NULL", [v])).rowCount) continue;
    await c.query("INSERT INTO org_unit_links(unit_id, unit_kind, object_type, object_id, effective_from, change_id, linked_by) VALUES ($1,'campus','venue',$2,greatest($3::date, CURRENT_DATE - 0),$4,$5)", [unit.id, v, ymd(unit.valid_from), await change(), actor]);
  }
}
/** The branch manager is the campus director (the same person, never a copy). */
export async function syncBranchManager(c, b, unit, actor) {
  await c.query("UPDATE org_unit_roles SET ended_at=now(), ended_by=$3 WHERE unit_id=$1 AND role='director' AND ended_at IS NULL AND ($2::uuid IS NULL OR user_id <> $2)", [unit.id, b.manager_id ?? null, actor]);
  if (!b.manager_id) return;
  const live = (await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [unit.organisation_id, b.manager_id])).rowCount;
  if (live) await c.query("INSERT INTO org_unit_roles(unit_id, user_id, role, inherit, valid_from, granted_by) SELECT $1,$2,'director',true,CURRENT_DATE,$3 WHERE NOT EXISTS (SELECT 1 FROM org_unit_roles WHERE unit_id=$1 AND user_id=$2 AND role='director' AND ended_at IS NULL)", [unit.id, b.manager_id, actor]);
}
/** Archiving a branch archives its campus: the campus's own links end (the branch keeps its programmes for past reports), nothing is deleted. */
export async function archiveBranchCampus(c, b, actor) {
  const unit = (await c.query('SELECT * FROM org_units WHERE legacy_branch_id=$1', [b.id])).rows[0];
  if (!unit || unit.status === 'archived') return;
  const changeId = await legacyChange(c, unit.organisation_id, actor, 'archive');
  await c.query('UPDATE org_unit_links SET effective_to=greatest(effective_from, CURRENT_DATE), closed_by_change_id=$2 WHERE unit_id=$1 AND effective_to IS NULL', [unit.id, changeId]);
  await c.query('UPDATE org_unit_roles SET ended_at=now(), ended_by=$2 WHERE unit_id=$1 AND ended_at IS NULL', [unit.id, actor]);
  await c.query("UPDATE org_units SET status='archived', archived_at=now(), row_version=row_version+1 WHERE id=$1", [unit.id]);
}
/** Place (or clear) a programme on a branch's campus: the branch endpoint's meaning, recorded as dated history. */
export async function placeProgrammeOnBranch(c, programmeId, branchId, orgId, actor) {
  const today = new Date().toISOString().slice(0, 10);
  if (!branchId) {
    await c.query("UPDATE org_unit_links SET effective_to=greatest(effective_from, CURRENT_DATE) WHERE object_type='programme' AND object_id=$1 AND effective_to IS NULL", [programmeId]);
    return;
  }
  const b = (await c.query('SELECT * FROM academy_branches WHERE id=$1', [branchId])).rows[0];
  const unit = b.unit_id ? { id: b.unit_id } : await createCampusForBranch(c, b, actor);
  const map = unitMap(await loadUnits(orgId, c));
  await moveObject(c, { unitsById: map, object_type: 'programme', object_id: programmeId, to: unit.id, effective_on: today, changeId: await legacyChange(c, orgId, actor, 'programme'), by: actor });
}
