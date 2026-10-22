// Who may act for a sponsor brand. Two models coexist and meet in `sponsorAccess`:
//  * #282 (sponsor identities): once a brand belongs to a sponsor entity (sponsors.entity_id), ONLY that entity's active representatives
//    (owner, admin, finance, portfolio_manager, viewer) act for it; owner_id is history. CAN / sponsorRole / sponsorTeamSql are that model.
//  * #283 (corporate workspace): a brand WITHOUT an entity is run by its owner (manager) and, when linked to an organisation
//    (sponsors.organisation_id), by that organisation's staff under the sponsor roles.
// Both are read live on every call, so removing a person removes their access at once. Entity wins when a brand has both.
import { pool } from './db.js';
import { conflict, forbidden } from './errors.js';
import { isAdmin } from './helpers.js';
import { notify } from './notify.js';

/** What each role may do. portfolio_manager only ever reaches brands in a portfolio assigned to them. */
export const CAN = {
  read: ['owner', 'admin', 'finance', 'portfolio_manager', 'viewer'],
  manage: ['owner', 'admin', 'portfolio_manager'], // propose, revise, withdraw, end, objectives, reviews
  money: ['owner', 'admin', 'finance', 'portfolio_manager'], // report payments, dispatch goods, endorsements
  identity: ['owner', 'admin'], // legal/billing identity, representatives, portfolios, verification requests
  owners: ['owner'], // appoint or change owners
};
export const ROLES = ['owner', 'admin', 'finance', 'portfolio_manager', 'viewer'];

const ASSIGNED = `EXISTS (SELECT 1 FROM sponsor_portfolio_assignments a JOIN sponsor_portfolio_brands b ON b.portfolio_id=a.portfolio_id AND b.removed_at IS NULL
                           JOIN sponsor_portfolios p ON p.id=a.portfolio_id AND p.archived_at IS NULL
                          WHERE a.representative_id=r.id AND a.ended_at IS NULL AND b.sponsor_id=`;

/** SQL predicate: the user (parameter `u`, e.g. '$1') can read the brand aliased `a` (default sp). */
export const sponsorTeamSql = (u, a = 'sp') => `((${a}.entity_id IS NULL AND ${a}.owner_id=${u}) OR EXISTS (
  SELECT 1 FROM sponsor_representatives r WHERE r.entity_id=${a}.entity_id AND r.user_id=${u} AND r.status='active'
     AND (r.role<>'portfolio_manager' OR ${ASSIGNED}${a}.id)))) `;

/** SQL predicate: the user can act on the brand with one of `roles` (a CAN list). */
export const sponsorCanSql = (u, roles, a = 'sp') => `((${a}.entity_id IS NULL AND ${a}.owner_id=${u} AND 'owner' = ANY('{${roles.join(',')}}'::text[])) OR EXISTS (
  SELECT 1 FROM sponsor_representatives r WHERE r.entity_id=${a}.entity_id AND r.user_id=${u} AND r.status='active' AND r.role = ANY('{${roles.join(',')}}'::text[])
     AND (r.role<>'portfolio_manager' OR ${ASSIGNED}${a}.id)))) `;

/** The user's role on a brand row (needs id, owner_id, entity_id), or null. Platform admins count as owner. */
export async function sponsorRole(c, user, sp, { asAdmin = true } = {}) {
  if (!user) return null;
  if (asAdmin && isAdmin(user)) return 'owner';
  if (!sp.entity_id) return sp.owner_id === user.id ? 'owner' : null;
  const r = await c.query(
    `SELECT r.role FROM sponsor_representatives r WHERE r.entity_id=$1 AND r.user_id=$2 AND r.status='active'
        AND (r.role<>'portfolio_manager' OR ${ASSIGNED}$3))`, [sp.entity_id, user.id, sp.id]);
  return r.rows[0]?.role ?? null;
}

/** For a request already known to come from the sponsor side of a deal: the member's role must allow the action. */
export function sponsorGate(ctx, need, what = 'do that') {
  if (ctx.role === 'sponsor' && !need.includes(ctx.sponsorRole)) throw forbidden(`Your role on this sponsor does not allow you to ${what}`);
}

/** Throws 403 unless the user's role on the brand is in `need` (a CAN list). Returns the role. */
export async function requireSponsor(c, user, sp, need, what = 'do that for this sponsor') {
  const role = await sponsorRole(c, user, sp);
  if (!role || !need.includes(role)) throw forbidden(`Your role does not allow you to ${what}`);
  return role;
}

/** The user's active role in an entity (not portfolio-scoped), or null. Platform admins count as owner. */
export async function entityRole(c, user, entityId) {
  if (!user || !entityId) return null;
  if (isAdmin(user)) return 'owner';
  const r = await c.query("SELECT role FROM sponsor_representatives WHERE entity_id=$1 AND user_id=$2 AND status='active'", [entityId, user.id]);
  return r.rows[0]?.role ?? null;
}

/** The person notified for a brand: an active owner of its entity (earliest first), else the legacy owner_id. */
export async function sponsorContactUser(c, sp) {
  if (!sp.entity_id) return sp.owner_id;
  const r = await c.query("SELECT user_id FROM sponsor_representatives WHERE entity_id=$1 AND role='owner' AND status='active' ORDER BY joined_at, id LIMIT 1", [sp.entity_id]);
  return r.rows[0]?.user_id ?? sp.owner_id;
}

/** Freeze who the sponsor was for one agreement version. First write wins, so history never changes afterwards. */
export async function snapshotIdentity(c, sponsorshipId, version, sponsorId, signedBy) {
  await c.query(
    `INSERT INTO sponsorship_identity_snapshots(sponsorship_id, version, sponsor_id, entity_id, display_name, legal_name, sponsor_type, signed_by)
     SELECT $1, $2, sp.id, sp.entity_id, sp.name, e.legal_name, e.sponsor_type, $4 FROM sponsors sp LEFT JOIN sponsor_entities e ON e.id=sp.entity_id WHERE sp.id=$3
     ON CONFLICT DO NOTHING`, [sponsorshipId, version, sponsorId, signedBy]);
}

/** A new sponsor entity with its creator as first (active) owner. Registration/billing details are added later through set_sponsor_identity. */
export async function createEntity(c, userId, { sponsor_type, legal_name }) {
  const e = (await c.query('INSERT INTO sponsor_entities(sponsor_type, legal_name, created_by) VALUES ($1,$2,$3) RETURNING id', [sponsor_type, legal_name ?? null, userId])).rows[0];
  await c.query("INSERT INTO sponsor_representatives(entity_id, user_id, role, status, invited_by, joined_at) VALUES ($1,$2,'owner','active',$2,now())", [e.id, userId]);
  return e.id;
}

// ------------------------------------------------------------------ #283: sponsor roles, one resolver for both models
export const SPONSOR_ROLES = ['manager', 'evaluator', 'finance', 'legal', 'approver', 'auditor'];
/** Sponsor-side permission per action. Evaluators can never pay or put the brand's name to terms. `viewer` (an entity representative) only reads. */
export const SPONSOR_ACTIONS = {
  read: [...SPONSOR_ROLES, 'viewer'],
  propose: ['manager', 'approver'],
  withdraw: ['manager', 'approver'],
  end: ['manager', 'approver'],
  revise: ['manager', 'legal', 'approver'], // terms the brand commits to
  pay: ['manager', 'finance'], // report a payment, dispatch goods
  evaluate: ['manager', 'evaluator'], // objectives, reviews, endorsement checks
  performance: ['manager', 'evaluator', 'auditor'], // read an athlete's shared results
  export: ['manager', 'finance', 'auditor'],
  contacts: ['manager'],
  manage: ['manager'], // link the brand to an organisation
  program: ['manager', 'approver'], // run sponsorship programs and rounds, decide awards (#284)
};
// organisation role -> sponsor role (a coach has no part in sponsorship)
const FROM_ORG = { owner: 'manager', admin: 'manager', manager: 'manager', finance: 'finance', evaluator: 'evaluator', legal: 'legal', approver: 'approver', auditor: 'auditor' };
// sponsor entity representative role -> sponsor role (a portfolio manager is limited to the brands of their portfolio, see ASSIGNED)
const FROM_ENTITY = { owner: 'manager', admin: 'manager', portfolio_manager: 'manager', finance: 'finance', viewer: 'viewer' };
const rolesFor = (map, action) => Object.entries(map).filter(([, s]) => SPONSOR_ACTIONS[action].includes(s)).map(([o]) => o);
const ORG_ROLES_FOR = (action) => rolesFor(FROM_ORG, action);
const ENTITY_ROLES_FOR = (action) => rolesFor(FROM_ENTITY, action);
const list = (xs) => xs.map((r) => `'${r}'`).join(',');

/** The actions a sponsor role may take, for clients that hide what a role cannot use (the server still enforces). */
export const actionsFor = (role) => Object.keys(SPONSOR_ACTIONS).filter((a) => SPONSOR_ACTIONS[a].includes(role));

/**
 * The caller's live authority over a brand row (needs id, owner_id, entity_id, organisation_id):
 * `{ role, departmentId, owner, archived, source }` or null. `role` is a sponsor role (SPONSOR_ACTIONS keys' values).
 * departmentId null means every department. A platform admin is not delegated authority (callers treat admins separately).
 */
export async function sponsorAccess(user, sponsor, c = pool) {
  if (!user || !sponsor) return null;
  if (sponsor.entity_id) { // #282: only the entity's active representatives
    const r = await sponsorRole(c, user, sponsor, { asAdmin: false });
    const role = r && FROM_ENTITY[r];
    return role ? { role, departmentId: null, owner: r === 'owner', archived: false, source: 'entity', entityRole: r } : null;
  }
  if (user.id === sponsor.owner_id) return { role: 'manager', departmentId: null, owner: true, archived: false, source: 'owner', entityRole: 'owner' };
  if (!sponsor.organisation_id) return null;
  const r = (await c.query(
    `SELECT m.role, m.department_id, o.status FROM organisation_members m JOIN organisations o ON o.id=m.organisation_id
      WHERE m.organisation_id=$1 AND m.user_id=$2 AND m.status='active'`, [sponsor.organisation_id, user.id])).rows[0];
  const role = r && FROM_ORG[r.role];
  return role ? { role, departmentId: r.department_id, owner: false, archived: r.status !== 'active', source: 'organisation' } : null;
}

/** Throws unless the access may do the action (and, for a department-scoped member, only on that department). */
export function assertSponsorCan(access, action, { departmentId = null, what = 'do that for this brand' } = {}) {
  if (!access) throw forbidden(`You are not part of this brand`);
  if (!SPONSOR_ACTIONS[action].includes(access.role)) throw forbidden(`Your role (${access.entityRole ?? access.role}) cannot ${what}`);
  if (access.departmentId && access.departmentId !== departmentId) throw forbidden('That belongs to another department');
  if (action !== 'read' && access.archived && !access.owner) throw conflict('This brand\'s organisation is archived and read-only');
  return access;
}

/** Everyone who should hear about something that needs the given sponsor action: the contact owner plus live staff with that role/scope. */
export async function sponsorRecipients(c, sponsor, action = 'read', departmentId = null) {
  const ids = new Set([await sponsorContactUser(c, sponsor)]);
  if (sponsor.entity_id) {
    const { rows } = await c.query(
      `SELECT r.user_id FROM sponsor_representatives r WHERE r.entity_id=$1 AND r.status='active' AND r.role = ANY($2)
          AND (r.role<>'portfolio_manager' OR ${ASSIGNED}$3))`, [sponsor.entity_id, ENTITY_ROLES_FOR(action), sponsor.id]);
    for (const x of rows) ids.add(x.user_id);
  } else if (sponsor.organisation_id) {
    const { rows } = await c.query(
      `SELECT m.user_id FROM organisation_members m JOIN organisations o ON o.id=m.organisation_id
        WHERE m.organisation_id=$1 AND m.status='active' AND o.status='active' AND m.role = ANY($2) AND (m.department_id IS NULL OR m.department_id IS NOT DISTINCT FROM $3)`,
      [sponsor.organisation_id, ORG_ROLES_FOR(action), departmentId]);
    for (const x of rows) ids.add(x.user_id);
  }
  return [...ids];
}

export async function notifySponsor(c, sponsor, action, msg, departmentId = null, except = null) {
  for (const uid of await sponsorRecipients(c, sponsor, action, departmentId)) if (uid !== except) await notify(c, uid, msg);
}

/** Entity half of the SQL predicates below: an active representative whose role allows `action` (portfolio managers: assigned brands only). */
const entitySql = (n, action, a) => `(${a}.entity_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM sponsor_representatives r WHERE r.entity_id=${a}.entity_id AND r.user_id=$${n} AND r.status='active' AND r.role = ANY(ARRAY[${list(ENTITY_ROLES_FOR(action))}])
     AND (r.role<>'portfolio_manager' OR ${ASSIGNED}${a}.id))))`;

/**
 * SQL for "deals of brands this user runs", with department scope; $n is the user id, `sp` = sponsors (alias `a`), `ss` = sponsorships (alias `d`; null = brand level, any department).
 * Entity brands: active representatives only. Other brands: the owner, and organisation staff whose role allows `action`.
 */
export const sponsorStaffSql = (n, action = 'read', a = 'sp', d = 'ss') => `(${entitySql(n, action, a)} OR (${a}.entity_id IS NULL AND (${a}.owner_id=$${n} OR EXISTS (
  SELECT 1 FROM organisation_members sm JOIN organisations so ON so.id=sm.organisation_id
   WHERE sm.organisation_id=${a}.organisation_id AND sm.user_id=$${n} AND sm.status='active' AND sm.role = ANY(ARRAY[${list(ORG_ROLES_FOR(action))}])
     ${d ? `AND (sm.department_id IS NULL OR sm.department_id IS NOT DISTINCT FROM ${d}.department_id)` : ''}))))`;

/** SQL for "brands this user runs for brand-wide work" (programs): `sp` = sponsors, $n the user id. Department-scoped members are excluded. */
export const sponsorBrandSql = (n, action = 'read', a = 'sp') => `(${entitySql(n, action, a)} OR (${a}.entity_id IS NULL AND (${a}.owner_id=$${n} OR EXISTS (
  SELECT 1 FROM organisation_members sm JOIN organisations so ON so.id=sm.organisation_id
   WHERE sm.organisation_id=${a}.organisation_id AND sm.user_id=$${n} AND sm.status='active' AND sm.department_id IS NULL
     AND sm.role = ANY(ARRAY[${list(ORG_ROLES_FOR(action))}])))))`;
