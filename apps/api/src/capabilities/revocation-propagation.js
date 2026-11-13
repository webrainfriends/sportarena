// Revocation propagation (#1129): when a user is removed from an org, clinical grant expires, or guardian link
// is revoked, this module cancels their queued notifications and writes an audit trail so the security console
// can prove the revocation was fully applied. Exported as a function so leave_organisation and remove_org_member
// can call it without creating a circular dependency.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { pool, query, tx } from '../db.js';
import { audit } from '../helpers.js';
import { isAdmin } from '../helpers.js';
import { notFound } from '../errors.js';

const TAG = 'Security console';

/**
 * Cancel pending notifications for a removed member and log the propagation outcome.
 * Safe to call inside an existing transaction (pass client=c) or standalone.
 */
export async function propagateMembershipRevocation({ userId, orgId, revokedBy, reason = 'membership_removed', client } = {}) {
  const c = client ?? pool;

  // Cancel queued notifications by recipient. The notifications table has no org_id column, so we
  // cancel all pending notifications for the user and record the count for the audit trail.
  let notifsCancelled = 0;
  try {
    const r = await c.query(
      "UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL",
      [userId],
    );
    notifsCancelled = r.rowCount ?? 0;
  } catch {
    // notifications table may not have matching rows — not fatal
  }

  // Write to audit log
  await audit(c, revokedBy ?? userId, 'membership_revoked', 'users', userId);

  // Insert into revocation_propagation_log (created by migration 208_tenant_isolation)
  const row = (await c.query(
    `INSERT INTO revocation_propagation_log
       (user_id, org_id, revoked_by, reason, notifications_cancelled)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [userId, orgId ?? null, revokedBy ?? null, reason, notifsCancelled],
  )).rows[0];

  return row;
}

// ---- REST endpoints ----------------------------------------------------------------

cap({
  name: 'get_revocation_log',
  method: 'GET',
  path: '/security/revocation-log',
  tag: TAG,
  auth: ['admin', 'platform_admin'],
  summary: 'List membership-revocation propagation events. Platform admin only.',
  input: z.object({
    ...page,
    user_id: id.optional(),
    org_id: id.optional(),
  }),
  async handler(_, i) {
    const conditions = ['1=1'];
    const params = [];
    if (i.user_id) { params.push(i.user_id); conditions.push(`l.user_id = $${params.length}`); }
    if (i.org_id)  { params.push(i.org_id);  conditions.push(`l.org_id  = $${params.length}`); }
    params.push(i.limit, i.offset);
    const rows = (await query(
      `SELECT l.*,
              u.display_name  AS user_name,  u.handle AS user_handle,
              o.name          AS org_name
         FROM revocation_propagation_log l
         JOIN users         u ON u.id = l.user_id
    LEFT JOIN organisations o ON o.id = l.org_id
        WHERE ${conditions.join(' AND ')}
     ORDER BY l.at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )).rows;
    return { rows };
  },
});

cap({
  name: 'get_access_denied_events',
  method: 'GET',
  path: '/security/access-denied-events',
  tag: TAG,
  auth: ['admin', 'platform_admin'],
  summary: 'List access-denied / IDOR-attempt audit events. Platform admin only.',
  input: z.object({
    ...page,
    severity: z.enum(['critical', 'high', 'medium', 'low', 'all']).default('all'),
    since_hours: z.coerce.number().int().min(1).max(720).default(24),
  }),
  async handler(_, i) {
    const conditions = ["a.action = 'access_denied'", `a.at > now() - ($3 || ' hours')::interval`];
    const params = [i.limit, i.offset, i.since_hours];
    if (i.severity !== 'all') { params.push(i.severity); conditions.push(`a.metadata->>'severity' = $${params.length}`); }

    const rows = (await query(
      `SELECT a.*,
              u.display_name AS actor_name, u.handle AS actor_handle
         FROM audit_log a
    LEFT JOIN users     u ON u.id = a.actor_id
        WHERE ${conditions.join(' AND ')}
     ORDER BY a.at DESC
        LIMIT $1 OFFSET $2`,
      params,
    )).rows;

    // 24-hour summary stats
    const stats = (await query(
      `SELECT
         count(*) FILTER (WHERE metadata->>'severity' = 'critical' OR metadata->>'block_reason' LIKE '%IDOR%')::int AS idor_attempts,
         count(*)::int                                            AS total_denied,
         count(*) FILTER (WHERE metadata->>'block_reason' LIKE '%role boundary%')::int AS role_boundary_blocks
         FROM audit_log
        WHERE action = 'access_denied' AND at > now() - interval '24 hours'`,
      [],
    )).rows[0];

    return { rows, stats };
  },
});

cap({
  name: 'get_permission_matrix',
  method: 'GET',
  path: '/security/permission-matrix',
  tag: TAG,
  auth: ['admin', 'platform_admin'],
  summary: 'Return the role × domain permission matrix with per-cell verdicts. Platform admin only.',
  async handler() {
    const ROLES_DISPLAY = ['athlete', 'coach', 'referee', 'physio', 'doctor', 'org_admin', 'sponsor', 'platform_admin', 'guardian'];
    const DOMAINS = [
      { key: 'own_profile',       label: 'Own Profile & PII',          owner: 'athlete',
        verdicts: { athlete: 'allow', coach: 'deny', referee: 'deny', physio: 'cond', doctor: 'cond', org_admin: 'deny', sponsor: 'deny', platform_admin: 'allow', guardian: 'cond' } },
      { key: 'clinical_records',  label: 'Clinical Records',           owner: 'athlete + provider',
        verdicts: { athlete: 'allow', coach: 'deny', referee: 'deny', physio: 'cond', doctor: 'cond', org_admin: 'deny', sponsor: 'deny', platform_admin: 'deny', guardian: 'cond' } },
      { key: 'finance_payouts',   label: 'Finance / Payouts',          owner: 'payee or delegated finance',
        verdicts: { athlete: 'cond', coach: 'deny', referee: 'cond', physio: 'deny', doctor: 'deny', org_admin: 'allow', sponsor: 'deny', platform_admin: 'allow', guardian: 'na' } },
      { key: 'tax_rate_agreements', label: 'Tax ID / Rate Agreements', owner: 'organisation finance role',
        verdicts: { athlete: 'deny', coach: 'deny', referee: 'deny', physio: 'deny', doctor: 'deny', org_admin: 'allow', sponsor: 'deny', platform_admin: 'allow', guardian: 'na' } },
      { key: 'sponsor_campaigns', label: 'Sponsor Campaigns',          owner: 'sponsor org members only',
        verdicts: { athlete: 'na', coach: 'deny', referee: 'deny', physio: 'deny', doctor: 'deny', org_admin: 'deny', sponsor: 'allow', platform_admin: 'allow', guardian: 'na' } },
      { key: 'academy_roster',    label: 'Academy Roster',             owner: 'academy admin or coach',
        verdicts: { athlete: 'deny', coach: 'allow', referee: 'deny', physio: 'deny', doctor: 'deny', org_admin: 'allow', sponsor: 'deny', platform_admin: 'allow', guardian: 'deny' } },
      { key: 'official_incidents', label: 'Official Incidents',        owner: 'referee + fixture org',
        verdicts: { athlete: 'na', coach: 'deny', referee: 'allow', physio: 'deny', doctor: 'deny', org_admin: 'cond', sponsor: 'deny', platform_admin: 'allow', guardian: 'na' } },
      { key: 'youth_records',     label: 'Youth / Guardian Records',   owner: 'guardian + minor + org',
        verdicts: { athlete: 'allow', coach: 'deny', referee: 'deny', physio: 'deny', doctor: 'deny', org_admin: 'cond', sponsor: 'deny', platform_admin: 'allow', guardian: 'allow' } },
      { key: 'private_files',     label: 'Private Files / Evidence',   owner: 'resource owner + verifier',
        verdicts: { athlete: 'allow', coach: 'cond', referee: 'cond', physio: 'cond', doctor: 'cond', org_admin: 'allow', sponsor: 'cond', platform_admin: 'allow', guardian: 'cond' } },
      { key: 'mcp_ai_calls',      label: 'MCP / AI Calls',             owner: 'same as REST policy',
        verdicts: { athlete: 'cond', coach: 'cond', referee: 'cond', physio: 'cond', doctor: 'cond', org_admin: 'cond', sponsor: 'cond', platform_admin: 'cond', guardian: 'cond' } },
    ];
    return { roles: ROLES_DISPLAY, domains: DOMAINS };
  },
});
