// Organisation workspaces: who may do what. Membership is read live on every call, so revoking or
// leaving removes delegated access immediately. Org roles are separate from the global users.roles.
import { pool } from './db.js';
import { isAdmin } from './helpers.js';
import { conflict, forbidden, notFound } from './errors.js';

/** Active membership role of the user in the organisation, or null. Platform admins act as owner. */
export async function orgRole(user, orgId, c = pool) {
  if (!user || !orgId) return null;
  if (isAdmin(user)) return 'owner';
  const r = await c.query("SELECT role FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [orgId, user.id]);
  return r.rows[0]?.role ?? null;
}

/** Delegated authority over a team/event/venue that belongs to an *active* organisation. */
export async function hasOrgGrant(user, orgId, roles, c = pool) {
  if (!user || !orgId) return false;
  const r = await c.query(
    "SELECT 1 FROM organisation_members m JOIN organisations o ON o.id=m.organisation_id WHERE m.organisation_id=$1 AND m.user_id=$2 AND m.status='active' AND o.status='active' AND m.role = ANY($3)",
    [orgId, user.id, roles],
  );
  return r.rowCount > 0;
}

/** Load an organisation the caller belongs to (404 for outsiders, so existence is not leaked) and check the role. */
export async function orgFor(user, orgId, roles, { write = false, c = pool } = {}) {
  const org = (await c.query('SELECT * FROM organisations WHERE id=$1', [orgId])).rows[0];
  const role = org ? await orgRole(user, orgId, c) : null;
  if (!org || !role) throw notFound('Organisation');
  if (roles && !roles.includes(role)) throw forbidden('Your role in this organisation does not allow that');
  if (write && org.status !== 'active') throw conflict('This organisation is archived and read-only');
  return { org, role };
}
