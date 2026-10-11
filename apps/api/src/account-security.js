// Account security helpers: one-time account tokens, TOTP (RFC 6238) and MFA policy.
import { createHmac, randomBytes } from 'node:crypto';
import { config } from './config.js';
import { one, query } from './db.js';
import { sha256 } from './crypto.js';
import { AppError } from './errors.js';

// ---- one-time tokens (email verification, password reset, MFA login challenge) ----
export const newSecret = (prefix) => `${prefix}_${randomBytes(32).toString('base64url')}`;

/** Create a token; the plaintext is returned once and only its hash is stored. */
export async function issueToken(userId, purpose, ttlMinutes, client) {
  const secret = newSecret({ email_verify: 'sv', password_reset: 'sp', mfa_login: 'sm' }[purpose]);
  await (client ?? { query }).query(
    `INSERT INTO account_tokens(user_id, purpose, token_hash, expires_at) VALUES ($1,$2,$3, now() + make_interval(mins => $4))`,
    [userId, purpose, sha256(secret), ttlMinutes]);
  return secret;
}

/** Atomically consume a valid token (single use, unexpired). Returns the row or null. */
export async function consumeToken(secret, purpose, client) {
  const r = await (client ?? { query }).query(
    `UPDATE account_tokens SET used_at = now() WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now() RETURNING id, user_id`,
    [sha256(String(secret)), purpose]);
  return r.rows[0] ?? null;
}

/** How many tokens of this kind the account requested in the last hour (per-account rate limit). */
export async function recentTokens(userId, purpose, minutes = 60) {
  return (await one(`SELECT count(*)::int AS n FROM account_tokens WHERE user_id=$1 AND purpose=$2 AND created_at > now() - make_interval(mins => $3)`, [userId, purpose, minutes])).n;
}
export const tooMany = (m = 'Too many requests for this account. Try again later.') => new AppError(429, 'rate_limited', m);

// ---- TOTP ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const base32 = (buf) => { let bits = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0'); return (bits.match(/.{1,5}/g) ?? []).map((c) => B32[parseInt(c.padEnd(5, '0'), 2)]).join(''); };
const unbase32 = (s) => { let bits = ''; for (const ch of s.replace(/=+$/, '')) bits += B32.indexOf(ch).toString(2).padStart(5, '0'); return Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2))); };
export const newTotpSecret = () => base32(randomBytes(20));
const STEP = 30;

export function totp(secretB32, step) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', unbase32(secretB32)).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
}
export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP);

/** The matching time step (within +/-1 step of clock drift) or null. */
export function matchStep(secretB32, code, now = Date.now()) {
  const c = String(code).replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const cur = currentStep(now);
  for (const s of [cur, cur - 1, cur + 1]) if (totp(secretB32, s) === c) return s;
  return null;
}
export const otpauthUri = (secret, label) => `otpauth://totp/SportArena:${encodeURIComponent(label)}?secret=${secret}&issuer=SportArena&algorithm=SHA1&digits=6&period=${STEP}`;

export const newRecoveryCode = () => { const r = base32(randomBytes(7)).toLowerCase().slice(0, 10); return `${r.slice(0, 5)}-${r.slice(5)}`; };
export const normalizeRecovery = (c) => String(c).toLowerCase().replace(/[^a-z2-7]/g, '');
export const hashRecovery = (c) => sha256(`recovery:${normalizeRecovery(c)}`);

// ---- policy ----
/** Roles that hold clinical or platform-wide power. MFA is enforced for their clinical/admin-class actions when MFA_ENFORCE=true. */
export const MFA_ROLES = ['doctor', 'physio', 'admin', 'platform_admin'];
// Capabilities that must stay reachable so a person can enrol, step up, sign out or recover.
export const MFA_EXEMPT = new Set([
  'logout', 'logout_all', 'list_login_sessions', 'revoke_login_session', 'change_my_password',
  'get_security_status', 'mfa_setup', 'mfa_enable', 'mfa_disable', 'verify_mfa', 'request_email_verification',
]);

/** Step-up policy for sensitive actions. `security` is attached to the user by authenticate(). */
export function enforceMfa(user, capability) {
  if (!config.mfaEnforce || !user || user.credential) return; // API tokens: their creation was itself an MFA-gated, admin-class action
  if (!['clinical', 'admin'].includes(capability.scope) || MFA_EXEMPT.has(capability.name)) return;
  if (!user.roles.some((r) => MFA_ROLES.includes(r))) return;
  const s = user.security ?? {};
  if (!s.mfa_enabled) throw new AppError(403, 'mfa_enrollment_required', 'Your role needs two-step verification for this action. Set it up under Account security first.');
  if (!s.mfa_verified) throw new AppError(403, 'mfa_required', 'Confirm your two-step verification code to continue (verify_mfa).');
}
