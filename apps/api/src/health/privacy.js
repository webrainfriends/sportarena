// Country health-privacy rules applied at the points where patient data moves (docs/health-compliance.md).
// Everything here is opt-in per patient: a person with no privacy profile behaves exactly as before.
import { one } from '../db.js';
import { config } from '../config.js';
import { badRequest, conflict } from '../errors.js';
import { REGIMES, regimeOf, hostingRegimes } from './regimes.js';

export const getPrivacyProfile = (userId, c) => (c ? c.query('SELECT * FROM health_privacy_profiles WHERE user_id=$1', [userId]).then((r) => r.rows[0] ?? null) : one('SELECT * FROM health_privacy_profiles WHERE user_id=$1', [userId]));

/** Countries this deployment stores health data in. */
export const hostedIn = () => {
  const set = config.clinical.hostingRegions.map(regimeOf).filter(Boolean);
  return set.length ? [...new Set(set)] : hostingRegimes({ kmsRegion: config.kmsRegion });
};

/** The country a doctor/physio practises under, from their current approved credential (null = not recorded / unsupported). */
export async function providerRegime(providerId, c) {
  const q = "SELECT jurisdiction FROM verification_cases WHERE subject_type='user' AND subject_id=$1 AND type IN ('doctor','physio') AND status='approved' AND expires_at > now() AND jurisdiction IS NOT NULL ORDER BY decided_at DESC NULLS LAST, submitted_at DESC";
  const row = c ? (await c.query(q, [providerId])).rows[0] : await one(q, [providerId]);
  return regimeOf(row?.jurisdiction);
}

/**
 * Sharing records with a provider. Returns { patient, provider, cross_border } to store on the grant, or throws.
 * - no profile: nothing changes (null/null/false)
 * - same country: fine
 * - different or unrecorded country: the patient must acknowledge it (`ack`); a keep-it-in-country regime (AE, CN) refuses it outright
 */
export async function checkGrantBorder(patientId, providerId, { ack = false, c } = {}) {
  const prof = await getPrivacyProfile(patientId, c);
  if (!prof) return { patient: null, provider: null, cross_border: false };
  const patient = prof.regime, provider = await providerRegime(providerId, c);
  if (provider === patient) return { patient, provider, cross_border: false };
  const r = REGIMES[patient];
  if (r.localisation === 'strict') {
    throw conflict(`Under ${r.name}'s rules your health data stays in ${r.name}, so it can only be shared with a provider whose verified registration is in ${r.name}${provider ? ` (this provider is registered in ${REGIMES[provider].name})` : ' (this provider has not recorded where they are registered)'}.`,
      { reason: 'cross_border_blocked', patient_regime: patient, provider_regime: provider });
  }
  if (!ack) {
    throw conflict(provider
      ? `This provider is registered in ${REGIMES[provider].name}, so your records would be shared across a border and handled under ${REGIMES[provider].name}'s rules as well as ${r.name}'s. Confirm to continue.`
      : `This provider has not recorded which country they are registered in, so we cannot confirm your records stay under ${r.name}'s rules. Confirm to continue.`,
    { reason: 'cross_border_ack_required', patient_regime: patient, provider_regime: provider });
  }
  return { patient, provider, cross_border: true };
}

/** A remote consultation must be with a provider registered where the patient lives (all eleven regimes require a local licence). */
export async function checkTelehealthBorder(patientId, providerId, c) {
  const prof = await getPrivacyProfile(patientId, c);
  if (!prof) return;
  const provider = await providerRegime(providerId, c), r = REGIMES[prof.regime];
  if (provider === prof.regime) return;
  if (provider || r.localisation === 'strict') {
    throw badRequest(`Remote consultations must be with a provider registered in ${r.name}: ${r.telehealth}${provider ? ` This provider is registered in ${REGIMES[provider].name}.` : ' This provider has not recorded where they are registered.'} Choose an in-person visit or another provider.`);
  }
}
