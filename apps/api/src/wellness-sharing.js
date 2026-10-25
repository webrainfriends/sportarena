// Permissioned sharing of an athlete's wellness with their support team (#330). Access is never cached: every read re-derives it from
// the share itself, the recipient's live relationship (coach) or medical grant + verified clinical credential (provider), and, for a
// young person, a guardian's current consent. Team or sponsor membership alone confers nothing.
import { RELATIONSHIP_SQL } from './coaching.js';
import { clinicalCredential } from './clinical-access.js';
import { hasConsent } from './youth.js';

export const FIELDS = ['sleep', 'soreness', 'mood', 'hydration', 'readiness', 'workload', 'body_map'];
export const PURPOSES = ['training_load', 'injury_prevention', 'return_to_play', 'performance_review'];
export const KINDS = { coach: 'coaching', provider: 'medical' }; // recipient kind -> guardian consent purpose

const REASONS = {
  expired: 'This share has ended.',
  revoked: 'The athlete stopped sharing.',
  no_relationship: 'You no longer coach this athlete.',
  no_medical_grant: 'The athlete has not given you medical access.',
  not_verified: 'Your professional verification is not current.',
  guardian_consent: 'A guardian has not given current consent.',
};
export const reasonText = (r) => REASONS[r] ?? 'No access.';

/** Why `recipient` of kind `kind` cannot currently see `athleteId`'s wellness, or null when allowed. `c` = a client (inside a tx) or the pool-backed query. */
export async function accessBlock(c, athleteId, recipientId, kind) {
  if (!(await hasConsent(athleteId, KINDS[kind], c))) return 'guardian_consent';
  if (kind === 'coach') {
    const r = await c.query(`SELECT 1 FROM (${RELATIONSHIP_SQL}) r WHERE r.coach_id=$1 AND r.athlete_id=$2 LIMIT 1`, [recipientId, athleteId]);
    return r.rows.length ? null : 'no_relationship';
  }
  const g = await c.query("SELECT 1 FROM medical_grants WHERE athlete_id=$1 AND provider_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND scope='full'", [athleteId, recipientId]);
  if (!g.rows.length) return 'no_medical_grant';
  return (await clinicalCredential(recipientId, { athleteId })).ok ? null : 'not_verified';
}

/** Full live check for an existing share row. */
export async function shareBlock(c, s) {
  if (s.revoked_at) return 'revoked';
  if (new Date(s.expires_at) <= new Date()) return 'expired';
  return accessBlock(c, s.athlete_id, s.recipient_id, s.recipient_kind);
}

export const shareState = (s) => (s.revoked_at ? 'revoked' : new Date(s.expires_at) <= new Date() ? 'expired' : 'active');
