// Enterprise identity policy: which organisation roles an IdP or SCIM client may ever grant, and how group claims resolve to one role.
// Pure functions, no I/O, so the ceilings are testable on their own.

/** Roles an enterprise directory may hand out. 'owner' (full control, hand-over) and 'legal' (changes contract terms) are never provisioned. */
export const NEVER_PROVISIONED = ['owner', 'legal'];
export const PROVISIONABLE = ['admin', 'coach', 'finance', 'staff', 'manager', 'evaluator', 'approver', 'auditor'];
/** Highest first: when several allowed groups match, the person gets the most capable role the ceiling allows. */
const PRECEDENCE = ['admin', 'manager', 'finance', 'coach', 'approver', 'evaluator', 'auditor', 'staff'];

/** Free mailbox providers cannot be claimed as an organisation's domain. */
export const PUBLIC_MAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'yahoo.in', 'ymail.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'zoho.com', 'gmx.com', 'mail.com', 'rediffmail.com', 'yandex.com']);

export const emailDomain = (email) => String(email ?? '').trim().toLowerCase().split('@')[1] ?? '';

/** Keep only roles that can be provisioned at all; the ceiling can only ever narrow this list. */
export const clampCeiling = (roles) => [...new Set((roles ?? []).filter((r) => PROVISIONABLE.includes(r)))];
export const rejectedCeilingRoles = (roles) => [...new Set((roles ?? []).filter((r) => !PROVISIONABLE.includes(r)))];

/**
 * Resolve a person's groups to one organisation role.
 *   mappings: [{ group_value, effect, org_role }]   ceiling: connection.allowed_roles   fallback: connection.default_role
 * Returns { role|null, denied, reason, ignored[] }. A deny mapping always wins; a mapping above the ceiling is ignored (and reported),
 * never clamped to something else; with no allowed match the default role applies (if it is inside the ceiling).
 */
export function resolveRole({ groups, mappings, ceiling, fallback }) {
  const have = new Set((groups ?? []).map((g) => String(g).trim().toLowerCase()).filter(Boolean));
  const hit = (mappings ?? []).filter((m) => have.has(String(m.group_value).trim().toLowerCase()));
  if (hit.some((m) => m.effect === 'deny')) return { role: null, denied: true, reason: 'group_denied', ignored: [] };
  const allowed = clampCeiling(ceiling);
  const ignored = [];
  const granted = [];
  for (const m of hit) {
    if (m.effect !== 'allow') continue;
    if (allowed.includes(m.org_role)) granted.push(m.org_role); else ignored.push(m.org_role);
  }
  const best = PRECEDENCE.find((r) => granted.includes(r));
  if (best) return { role: best, denied: false, reason: 'mapped', ignored };
  if (fallback && allowed.includes(fallback)) return { role: fallback, denied: false, reason: 'default_role', ignored };
  return { role: null, denied: false, reason: ignored.length ? 'mapping_exceeds_ceiling' : 'no_role', ignored };
}

/** Pull group names out of whatever shape the IdP sent them in (array, comma/space string, or a single value). */
export function readGroups(claims, claimName = 'groups') {
  const raw = claims?.[claimName];
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,;]/) : [];
  return [...new Set(list.map((g) => String(g).trim()).filter(Boolean))].slice(0, 500);
}

/** Did the IdP assert multi-factor authentication? OIDC amr / acr, or a SAML AuthnContext class. A signal, never device compliance. */
export function mfaSignal({ amr, acr, authnContext }) {
  const MFA_AMR = ['mfa', 'otp', 'hwk', 'swk', 'fpt', 'face', 'iris', 'pin', 'sc', 'tel', 'sms'];
  if (Array.isArray(amr) && amr.some((a) => MFA_AMR.includes(String(a).toLowerCase())) && (amr.length > 1 || amr.map((a) => String(a).toLowerCase()).includes('mfa'))) return true;
  if (typeof acr === 'string' && /(^|[:/])(mfa|multifactor|multi-factor|phr|phrh)([:/]|$)|c2pa\.mfa/i.test(acr)) return true;
  if (typeof authnContext === 'string' && /(MultiFactor|mfa|TimeSyncToken|SmartcardPKI|MobileTwoFactor)/i.test(authnContext)) return true;
  return false;
}
