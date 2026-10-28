// Offboarding: ending an organisation membership that came from a directory. Prospective only: the membership row is closed (history kept),
// the sessions that this organisation's IdP opened are ended, and tokens that were restricted to this organisation alone are revoked.
// The canonical person, career history, contracts and retention records are never touched.
import { query } from '../db.js';
import { logEvent } from './sso.js';

/** End what depends on a membership: the sessions this organisation's IdP opened, and API tokens limited to this organisation alone. */
export async function endDependentAccess(c, { orgId, userId }) {
  const q = c ? c.query.bind(c) : query;
  const sessions = await q("UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'deprovisioned' WHERE user_id = $1 AND revoked_at IS NULL AND sso_connection_id IN (SELECT id FROM org_sso_connections WHERE organisation_id = $2)", [userId, orgId]);
  // a token whose every resource restriction is this organisation depends on this membership; unrestricted or multi-resource tokens are the person's own
  const tokens = await q(
    `UPDATE api_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND jsonb_array_length(resources) > 0
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(resources) r WHERE NOT (r->>'type' = 'organisation' AND r->>'id' = $2))`, [userId, orgId]);
  return { sessions_revoked: sessions.rowCount, tokens_revoked: tokens.rowCount };
}

export async function deprovisionMember(c, { orgId, userId, connectionId, actorId = null, reason }) {
  const q = c ? c.query.bind(c) : query;
  // Every non-owner membership ends, whoever added it: an offboarded employee keeps no access. An owner is never removed by a directory
  // (the last owner could lock the organisation out), so that stays a manual hand-over.
  const m = await q("UPDATE organisation_members SET status='left', left_at=now(), deprovisioned_at=now() WHERE organisation_id=$1 AND user_id=$2 AND status IN ('invited','active') AND role <> 'owner' RETURNING id, role", [orgId, userId]);
  const out = await endDependentAccess(c, { orgId, userId });
  await logEvent(c, { orgId, connId: connectionId, userId, actorId, event: 'deprovisioned', reason, detail: { membership_ended: m.rowCount, ...out } });
  return { membership_ended: m.rowCount, ...out };
}
