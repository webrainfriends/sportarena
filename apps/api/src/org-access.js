// Organisation workspaces: who may do what. Membership is read live on every call, so revoking or
// leaving removes delegated access immediately. Org roles are separate from the global users.roles.
import { pool } from './db.js';
import { isAdmin } from './helpers.js';
import { AppError, conflict, forbidden, notFound } from './errors.js';

/** Row-lock an organisation for the rest of the transaction, so membership changes and hand-overs on it run one at a time. */
export const lockOrg = (c, orgId) => c.query('SELECT id FROM organisations WHERE id=$1 FOR UPDATE', [orgId]);

/** Active membership role of the user in the organisation, or null. Platform admins act as owner. */
export async function orgRole(user, orgId, c = pool) {
  if (!user || !orgId) return null;
  if (isAdmin(user)) return 'owner';
  const r = await c.query("SELECT role FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [orgId, user.id]);
  return r.rows[0]?.role ?? null;
}

/** Delegated authority over a team/event/venue that belongs to an *active* organisation. */
export async function hasOrgGrant(user, orgId, roles, c = pool, { allowPending = false } = {}) {
  if (!user || !orgId) return false;
  const r = await c.query(
    "SELECT 1 FROM organisation_members m JOIN organisations o ON o.id=m.organisation_id WHERE m.organisation_id=$1 AND m.user_id=$2 AND m.status='active' AND o.status='active' AND ($4::boolean OR o.approval_status='approved') AND m.role = ANY($3)",
    [orgId, user.id, roles, allowPending],
  );
  return r.rowCount > 0;
}

/** Load an organisation the caller belongs to (404 for outsiders, so existence is not leaked) and check the role. */
export async function orgFor(user, orgId, roles, { write = false, allowPending = false, c = pool } = {}) {
  const org = (await c.query('SELECT * FROM organisations WHERE id=$1', [orgId])).rows[0];
  const role = org ? await orgRole(user, orgId, c) : null;
  if (!org || !role) throw notFound('Organisation');
  if (roles && !roles.includes(role)) throw forbidden('Your role in this organisation does not allow that');
  if (write && org.status !== 'active') throw conflict('This organisation is archived and read-only');
  if (write && !allowPending) await requireApproved(org, c);
  return { org, role };
}

/** Writes need the platform team's approval of the organisation (and of its umbrella organisation, for an academy). Reading and finishing the profile stay open. */
export async function requireApproved(org, c = pool) {
  let blocker = org;
  if (blocker.approval_status === 'approved' && org.parent_organisation_id) blocker = (await c.query('SELECT * FROM organisations WHERE id=$1', [org.parent_organisation_id])).rows[0] ?? org;
  if (blocker.approval_status === 'approved') return;
  const why = { pending: 'is waiting for platform review', rejected: 'was not approved by the platform team', suspended: 'is suspended by the platform team' }[blocker.approval_status];
  throw new AppError(409, 'pending_approval', `${blocker.id === org.id ? 'This organisation' : 'The umbrella organisation'} ${why}. You can finish its profile, but nothing else can change until it is approved.`, { approval_status: blocker.approval_status, organisation_id: blocker.id });
}
