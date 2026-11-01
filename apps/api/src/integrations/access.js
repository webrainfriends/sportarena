// The gate for external integrations (#597). An organisation cannot connect a third-party system on its own: it requests access (for the whole
// organisation, or for one event or tournament), the platform admin team prices and enables it, and only then can an owner/admin connect it.
// Platform admins (allow-listed accounts only) may connect on an organisation's behalf. Revoking pauses the connections; nothing is deleted.
import { one } from '../db.js';
import { AppError } from '../errors.js';
import { mustBePlatformAdmin } from '../platform.js';

export const entitlementKey = (providerKey) => `integration.${providerKey}`;

export async function isPlatformAdminNow(user) {
  try { await mustBePlatformAdmin(user); return true; } catch { return false; }
}

/** The approved request that lets this organisation connect this provider (organisation-wide, or for the given event), or null. */
export async function approvedAccess(orgId, providerKey, eventId = null) {
  return one(
    `SELECT r.* FROM integration_access_requests r JOIN commercial_overrides o ON o.id = r.override_id AND o.status = 'active' AND o.enabled
      WHERE r.organisation_id=$1 AND r.provider_key=$2 AND r.status='enabled' AND (r.event_id IS NULL OR r.event_id = $3)
        AND (o.ends_on IS NULL OR o.ends_on >= current_date) ORDER BY r.event_id NULLS FIRST LIMIT 1`, [orgId, providerKey, eventId]);
}

/** Throws 403 `integration_not_enabled` unless the platform team has enabled this provider for the organisation (or event). Returns the request, or null for a platform admin. */
export async function requireIntegrationAccess(user, orgId, providerKey, eventId = null) {
  if (await isPlatformAdminNow(user)) return null;
  const a = await approvedAccess(orgId, providerKey, eventId);
  if (!a) throw new AppError(403, 'integration_not_enabled', 'This integration is enabled by the platform team. Request access and it will be priced and enabled for you.', { provider_key: providerKey, request: 'request_integration_access' });
  return a;
}
