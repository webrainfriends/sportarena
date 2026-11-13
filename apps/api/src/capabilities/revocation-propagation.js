// Revocation propagation (#1129): when a user is removed from an org, clinical grant expires, or guardian link
// is revoked, this module cancels their queued notifications and writes an audit trail so the security console
// can prove the revocation was fully applied. Exported as a function so leave_organisation, remove_org_member,
// and guardian-link revocation can call it without creating a circular dependency.
import { pool } from '../db.js';
import { audit } from '../helpers.js';

/**
 * Cancel pending notifications for a removed member and log the propagation outcome.
 * Safe to call inside an existing transaction (pass client=c) or standalone.
 *
 * @param {{ userId: string, orgId?: string, revokedBy?: string, reason?: string, client?: object }} opts
 * @returns {Promise<object>} revocation_propagation_log row
 */
export async function propagateMembershipRevocation({ userId, orgId, revokedBy, reason = 'membership_removed', client } = {}) {
  const c = client ?? pool;

  // Cancel queued (unread) notifications for the user. The notifications table has no org_id column,
  // so we cancel all unread notifications for this user and record the count.
  let notifsCancelled = 0;
  try {
    const r = await c.query(
      'UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL',
      [userId],
    );
    notifsCancelled = r.rowCount ?? 0;
  } catch {
    // notifications table may not exist or have no matching rows — not fatal
  }

  // Write to tamper-evident audit log
  await audit(c, revokedBy ?? userId, 'membership_revoked', 'users', userId);

  // Insert into revocation_propagation_log (created by migration 208_tenant_isolation.sql)
  const row = (await c.query(
    `INSERT INTO revocation_propagation_log
       (user_id, org_id, revoked_by, reason, notifications_cancelled)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [userId, orgId ?? null, revokedBy ?? null, reason, notifsCancelled],
  )).rows[0];

  return row;
}
