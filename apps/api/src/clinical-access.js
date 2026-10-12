// Current professional verification for clinical actions (issue #59).
// A doctor/physio may act clinically only while the canonical verification model (verification_cases) holds an APPROVED, unrevoked,
// unexpired case of the matching profession. It is resolved from the database on every call, so expiry or revocation applies at once
// (no new login needed). This is separate from, and in addition to, the athlete's consent (medical_grants) - both are required.
//
// Grace policy: config.clinical.graceDays (default 0). After EXPIRY (never after revocation) a provider may, for 'grace' actions only
// (completing an already-confirmed appointment), keep winding down existing care for that many days. New records are never covered.
// Emergency exception: only report_medical_incident, only for serious/emergency severity, only with a stated reason; the use is audited
// and stored with the incident. Nothing is bypassed silently.
import { one, many } from './db.js';
import { config } from './config.js';
import { AppError } from './errors.js';
import { audit } from './helpers.js';

export const CLINICAL_TYPES = ['doctor', 'physio'];

const MESSAGES = {
  not_verified: 'You need a verified {p} credential before you can do this. Submit your registration for review.',
  pending: 'Your {p} verification is still being reviewed. You can do this once it is approved.',
  expired: 'Your {p} verification has expired. Renew it to continue with clinical actions.',
  revoked: 'Your {p} verification was revoked by the platform team, so clinical actions are paused. Submit a new verification to restore access.',
  role_mismatch: 'Your verified credential does not match a doctor or physio role on your account.',
  sport_scope: 'Your verified credential does not cover this athlete\'s sport. Submit a verification for that sport.',
  jurisdiction: 'Your verified credential is not valid in a jurisdiction this platform currently accepts.',
};

/** Resolve a user's clinical credential state from the DB. Pure read; returns { ok, reason, type, case_id, expires_at, grace, renewal }. */
export async function clinicalCredential(userId, { types = CLINICAL_TYPES, sportId = null, athleteId = null, allowGrace = false } = {}) {
  const u = await one('SELECT roles FROM users WHERE id=$1', [userId]);
  const roles = (u?.roles ?? []).filter((r) => types.includes(r));
  const cases = await many(
    `SELECT id, type, status, sport_id, jurisdiction, expires_at, (status='approved' AND expires_at > now()) AS live,
            (status='approved' AND expires_at <= now() AND expires_at + make_interval(days => $3::int) > now()) AS in_grace
       FROM verification_cases WHERE subject_type='user' AND subject_id=$1 AND type = ANY($2::text[]) ORDER BY submitted_at DESC`, [userId, types, config.clinical.graceDays]);
  let athleteSports = null;
  const sportOk = async (c) => {
    if (!c.sport_id) return true;
    if (sportId) return c.sport_id === sportId;
    if (!athleteId) return true;
    athleteSports ??= new Set((await many('SELECT sport_id FROM sport_profiles WHERE user_id=$1', [athleteId])).map((r) => r.sport_id));
    return athleteSports.has(c.sport_id);
  };
  const jurOk = (c) => !config.clinical.jurisdictions.length || (c.jurisdiction && config.clinical.jurisdictions.includes(c.jurisdiction.toUpperCase()));
  let blocked = null;
  for (const grace of allowGrace ? [false, true] : [false]) {
    for (const c of cases) {
      if (!(grace ? c.in_grace : c.live)) continue;
      if (!roles.includes(c.type)) { blocked ??= 'role_mismatch'; continue; }
      if (!(await sportOk(c))) { blocked ??= 'sport_scope'; continue; }
      if (!jurOk(c)) { blocked ??= 'jurisdiction'; continue; }
      return { ok: true, grace, type: c.type, case_id: c.id, expires_at: c.expires_at };
    }
  }
  const latest = cases.find((c) => roles.includes(c.type)) ?? cases[0] ?? null;
  const reason = blocked ?? (!latest ? 'not_verified' : latest.status === 'revoked' ? 'revoked' : latest.status === 'approved' ? 'expired' : ['submitted', 'in_review', 'needs_info'].includes(latest.status) ? 'pending' : 'not_verified');
  const type = latest?.type ?? roles[0] ?? types[0];
  const prev = cases.find((c) => c.type === type);
  return { ok: false, reason, type, case_id: latest?.id ?? null, expires_at: latest?.expires_at ?? null, grace: false,
    renewal: { capability: 'submit_verification', method: 'POST', path: '/verification/cases', type, previous_case_id: prev?.id ?? null } };
}

/**
 * Throw 403 `credential_required` unless `providerId` holds a current verified doctor/physio credential.
 * Audits every check (allowed / denied) against the action name and athlete id - never any clinical content.
 * opts: { action, athleteId, sportId, types, allowGrace, emergencyReason, forOther }. With `emergencyReason` a lapsed credential is let through
 * and the override is audited; the caller stores `override: true`. Returns the credential result.
 */
export async function requireVerifiedProvider(providerId, { action, athleteId = null, emergencyReason = null, forOther = false, ...opts }) {
  const cred = await clinicalCredential(providerId, { athleteId, ...opts });
  const entity = `clinical:${action}`;
  if (cred.ok) {
    await audit(null, providerId, cred.grace ? 'credential_check_grace' : 'credential_check_allowed', entity, athleteId);
    return cred;
  }
  if (emergencyReason) {
    await audit(null, providerId, 'credential_emergency_override', entity, athleteId);
    return { ...cred, override: true };
  }
  await audit(null, providerId, 'credential_check_denied', `${entity}:${cred.reason}`, athleteId);
  // forOther: the caller is a third party (e.g. the athlete booking), so explain the provider's state without the provider's renewal steps
  if (forOther) throw new AppError(403, 'credential_required', `This ${cred.type}'s professional verification is not current, so they cannot take clinical appointments right now.`, { reason: cred.reason, profession: cred.type });
  throw new AppError(403, 'credential_required', MESSAGES[cred.reason].replace('{p}', cred.type), { reason: cred.reason, profession: cred.type, expires_at: cred.expires_at, renewal: cred.renewal });
}

/**
 * Atomic re-check for a clinical WRITE (59-2a). Call inside the write's transaction with the credential returned by requireVerifiedProvider.
 * It takes a shared row lock on the verification case (`FOR SHARE`) and re-reads it under that lock: a revocation (an UPDATE of that row)
 * waits until the write commits, and a revocation that already committed is seen here, so nothing is written after the revocation
 * is committed. An emergency override has no case to lock and is skipped (it is audited instead).
 */
export async function lockCredential(c, cred) {
  if (cred.override || !cred.case_id) return;
  const v = (await c.query("SELECT type, status, expires_at, (status='approved' AND expires_at > now()) AS live FROM verification_cases WHERE id=$1 FOR SHARE", [cred.case_id])).rows[0];
  if (v && v.status === 'approved' && (v.live || cred.grace)) return;
  const reason = !v ? 'not_verified' : v.status === 'revoked' ? 'revoked' : v.status === 'approved' ? 'expired' : 'not_verified';
  throw new AppError(403, 'credential_required', MESSAGES[reason].replace('{p}', cred.type), { reason, profession: cred.type, expires_at: v?.expires_at ?? null });
}
