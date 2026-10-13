import { randomBytes } from 'node:crypto';
import { many, one, query } from './db.js';
import { badRequest, unauthorized } from './errors.js';
import { blindIndex, encrypt, hashPassword } from './crypto.js';
import { revokeUserSessions, startSession } from './sessions.js';
import { issueToken } from './account-security.js';
import { audit } from './helpers.js';
import { superAdminEmail } from './access.js';

const USER_COLS = 'id, handle, display_name, roles, avatar_emoji, avatar_color, avatar_url, avatar_cutout, access_status';
/** Identity-provider columns on users (fixed list: the column name is interpolated into SQL). */
const SUB_COL = { google: 'google_sub', apple: 'apple_sub' };

/** A free public handle (3-24 chars of a-z, 0-9, _) derived from the email's local part. */
async function freeHandle(email) {
  const base = (email.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'player').slice(0, 18).padEnd(3, '0');
  for (let n = 0; n < 8; n++) {
    const h = n === 0 ? base : `${base}_${randomBytes(2).toString('hex')}`;
    if (!(await one('SELECT 1 FROM users WHERE handle = $1', [h]))) return h;
  }
  return `user_${randomBytes(6).toString('hex')}`;
}

/**
 * Sign in (or create an account) for a person whose email was verified by an identity provider ('google' | 'apple').
 * Matches the account by provider id, then by verified email; a new user gets an athlete account that waits for approval.
 * Returns the same session as password login, or mfa_required + mfa_token when two-step verification is on.
 */
export async function socialSignIn({ provider, sub, email, verified = true, name, meta }) {
  const col = SUB_COL[provider];
  if (!col) throw badRequest('Unknown sign-in provider');
  if (!sub) throw unauthorized('Sign-in could not be verified.');
  const isSuper = Boolean(email) && verified && email === superAdminEmail();
  let u = await one(`SELECT ${USER_COLS} FROM users WHERE ${col} = $1`, [sub]);
  if (!u) {
    if (!email || !verified) throw unauthorized(`Your ${provider === 'apple' ? 'Apple' : 'Google'} account has no verified email address.`);
    const byEmail = await one(`SELECT ${USER_COLS}, email_verified_at, ${col} AS linked_sub FROM users WHERE email_idx = $1`, [blindIndex(email)]);
    if (byEmail?.linked_sub) throw unauthorized(`This email is linked to a different ${provider === 'apple' ? 'Apple' : 'Google'} account.`);
    if (byEmail) {
      // The provider has verified this email, so linking is safe, but if the existing account's email was never verified someone else may have
      // registered it first: change its password to an unusable one and sign out its sessions (the real owner can reset by email).
      if (!byEmail.email_verified_at) {
        await query('UPDATE users SET password_hash = $2 WHERE id = $1', [byEmail.id, await hashPassword(randomBytes(24).toString('base64url'))]);
        await revokeUserSessions(byEmail.id, `${provider}_link`);
      }
      await query(`UPDATE users SET ${col} = $2, email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1`, [byEmail.id, sub]);
      await audit(null, byEmail.id, `${provider}_link`, 'users', byEmail.id);
      u = Object.fromEntries(Object.entries(byEmail).filter(([k]) => !['email_verified_at', 'linked_sub'].includes(k)));
    } else {
      const display = String(name ?? '').trim().slice(0, 60) || email.split('@')[0].slice(0, 60);
      u = await one(
        `INSERT INTO users (handle, display_name, roles, password_hash, email_enc, email_idx, ${col}, email_verified_at, access_status)
         VALUES ($1,$2,$7,$3,$4,$5,$6, now(), $8) RETURNING ${USER_COLS}`,
        [await freeHandle(email), display, await hashPassword(randomBytes(24).toString('base64url')), encrypt(email, 'users.email'), blindIndex(email), sub,
          isSuper ? ['athlete', 'admin', 'platform_admin'] : ['athlete'], isSuper ? 'approved' : 'pending']);
      await audit(null, u.id, `${provider}_register`, 'users', u.id);
    }
  }
  // The super admin's email always holds the platform owner role and is approved (the provider has verified the address).
  if (isSuper && (u.access_status !== 'approved' || !u.roles.includes('platform_admin'))) {
    u = await one(`UPDATE users SET access_status = 'approved', roles = (SELECT array_agg(DISTINCT r) FROM unnest(roles || '{admin,platform_admin}'::text[]) r) WHERE id = $1 RETURNING ${USER_COLS}`, [u.id]);
    await audit(null, u.id, `super_admin_${provider}`, 'users', u.id);
  }
  if (u.access_status === 'rejected') {
    await revokeUserSessions(u.id, 'access_rejected');
    throw unauthorized('Your access request was declined by the administrator.');
  }
  if (await one('SELECT 1 FROM user_mfa WHERE user_id = $1 AND enabled_at IS NOT NULL AND disabled_at IS NULL', [u.id])) {
    return { mfa_required: true, mfa_token: await issueToken(u.id, 'mfa_login', 5) };
  }
  return { user: u, ...(await startSession(u, meta)) };
}
