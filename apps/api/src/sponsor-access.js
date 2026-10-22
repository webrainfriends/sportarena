// Who may act for a sponsor brand (#282). A brand without a confirmed identity (legacy) is controlled by its owner_id alone.
// Once a brand belongs to a sponsor entity, ONLY that entity's active representatives (and platform admins) have access:
// owner_id is then just history, so removing a representative really removes their access. Read live on every call.
import { forbidden } from './errors.js';
import { isAdmin } from './helpers.js';

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
