import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { cap, id, page } from '../registry.js';
import { many, one, query } from '../db.js';
import { config } from '../config.js';
import { badRequest, notFound, unauthorized } from '../errors.js';
import { blindIndex, decryptFields, encrypt, hashPassword } from '../crypto.js';
import { revokeUserSessions, startSession } from '../sessions.js';
import { issueToken } from '../account-security.js';
import { audit } from '../helpers.js';
import { superAdminEmail } from '../access.js';

const USER_COLS = 'id, handle, display_name, roles, avatar_emoji, avatar_color, avatar_url, avatar_cutout, access_status';
const jwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

/** Check a Google ID token (signature, issuer, audience, expiry) and return its claims. Replaceable in tests. */
export const googleVerifier = {
  async verify(credential) {
    const { payload } = await jwtVerify(credential, jwks, { issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: config.googleClientId });
    return payload;
  },
};

/** A free public handle (3-24 chars of a-z, 0-9, _) derived from the email's local part. */
async function freeHandle(email) {
  const base = (email.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'player').slice(0, 18).padEnd(3, '0');
  for (let n = 0; n < 8; n++) {
    const h = n === 0 ? base : `${base}_${randomBytes(2).toString('hex')}`;
    if (!(await one('SELECT 1 FROM users WHERE handle = $1', [h]))) return h;
  }
  return `user_${randomBytes(6).toString('hex')}`;
}

cap({
  name: 'get_auth_config', method: 'GET', path: '/auth/config', tag: 'Identity', auth: 'public',
  summary: 'Which sign-in options this site offers. google_client_id is the public OAuth client id for the "Sign in with Google" button (null when Google sign-in is not set up).',
  handler: async () => ({ google_client_id: config.googleClientId ?? null }),
});

cap({
  name: 'login_google', method: 'POST', path: '/auth/google', tag: 'Identity', auth: 'public',
  summary: 'Sign in (or create an account) with a Google ID token from "Sign in with Google". Matches the account by Google id, then by verified email; a new Google user gets an athlete account with a generated handle (roles can be changed in Me). Returns the same session as login, or mfa_required + mfa_token when two-step verification is on.',
  input: z.object({ credential: z.string().min(20).max(4000).describe('the Google ID token (JWT)') }),
  async handler({ meta }, i) {
    if (!config.googleClientId) throw badRequest('Google sign-in is not set up on this site');
    let claims;
    try { claims = await googleVerifier.verify(i.credential); } catch { throw unauthorized('Google sign-in could not be verified. Please try again.'); }
    const email = String(claims.email ?? '').toLowerCase();
    if (!claims.sub || !email || claims.email_verified !== true) throw unauthorized('Your Google account has no verified email address.');

    const isSuper = email === superAdminEmail();
    let u = await one(`SELECT ${USER_COLS} FROM users WHERE google_sub = $1`, [claims.sub]);
    if (!u) {
      const byEmail = await one(`SELECT ${USER_COLS}, email_verified_at, google_sub FROM users WHERE email_idx = $1`, [blindIndex(email)]);
      if (byEmail?.google_sub) throw unauthorized('This email is linked to a different Google account.');
      if (byEmail) {
        // Google has verified this email, so linking is safe, but if the existing account's email was never verified someone else may have
        // registered it first: change its password to an unusable one and sign out its sessions (the real owner can reset by email).
        if (!byEmail.email_verified_at) {
          await query('UPDATE users SET password_hash = $2 WHERE id = $1', [byEmail.id, await hashPassword(randomBytes(24).toString('base64url'))]);
          await revokeUserSessions(byEmail.id, 'google_link');
        }
        await query('UPDATE users SET google_sub = $2, email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1', [byEmail.id, claims.sub]);
        await audit(null, byEmail.id, 'google_link', 'users', byEmail.id);
        u = Object.fromEntries(Object.entries(byEmail).filter(([k]) => !['email_verified_at', 'google_sub'].includes(k)));
      } else {
        const name = String(claims.name ?? '').trim().slice(0, 60) || email.split('@')[0].slice(0, 60);
        u = await one(
          `INSERT INTO users (handle, display_name, roles, password_hash, email_enc, email_idx, google_sub, email_verified_at, access_status)
           VALUES ($1,$2,$7,$3,$4,$5,$6, now(), $8) RETURNING ${USER_COLS}`,
          [await freeHandle(email), name, await hashPassword(randomBytes(24).toString('base64url')), encrypt(email, 'users.email'), blindIndex(email), claims.sub,
            isSuper ? ['athlete', 'admin', 'platform_admin'] : ['athlete'], isSuper ? 'approved' : 'pending']);
        await audit(null, u.id, 'google_register', 'users', u.id);
      }
    }
    // The super admin's Google email always holds the platform owner role and is approved (Google has verified the address).
    if (isSuper && (u.access_status !== 'approved' || !u.roles.includes('platform_admin'))) {
      u = await one(`UPDATE users SET access_status = 'approved', roles = (SELECT array_agg(DISTINCT r) FROM unnest(roles || '{admin,platform_admin}'::text[]) r) WHERE id = $1 RETURNING ${USER_COLS}`, [u.id]);
      await audit(null, u.id, 'super_admin_google', 'users', u.id);
    }
    if (u.access_status === 'rejected') {
      await revokeUserSessions(u.id, 'access_rejected');
      throw unauthorized('Your access request was declined by the administrator.');
    }
    if (await one('SELECT 1 FROM user_mfa WHERE user_id = $1 AND enabled_at IS NOT NULL AND disabled_at IS NULL', [u.id])) {
      return { mfa_required: true, mfa_token: await issueToken(u.id, 'mfa_login', 5) };
    }
    return { user: u, ...(await startSession(u, meta)) };
  },
});

const decision = z.enum(['pending', 'approved', 'rejected']);
cap({
  name: 'list_access_requests', method: 'GET', path: '/admin/access-requests', tag: 'Identity', auth: ['admin', 'platform_admin'],
  summary: 'Platform team: people who signed in with Google, newest first. Filter by status (default pending). Shows handle, display name, decrypted email (audit-logged) and the decision so far.',
  input: z.object({ status: decision.default('pending'), ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT u.id, u.handle, u.display_name, u.email_enc, u.access_status, u.access_decided_at, u.created_at, d.handle AS decided_by_handle
         FROM users u LEFT JOIN users d ON d.id = u.access_decided_by
        WHERE u.google_sub IS NOT NULL AND u.access_status = $1 ORDER BY u.created_at DESC, u.id LIMIT $2 OFFSET $3`, [i.status, i.limit, i.offset]);
    await audit(null, user.id, 'read_pii', 'users', null);
    return rows.map(({ email_enc, ...r }) => ({ ...r, email: decryptFields({ email_enc }, 'users', ['email']).email }));
  },
});

cap({
  name: 'decide_access', method: 'POST', path: '/admin/access-requests/:user_id', tag: 'Identity', auth: ['admin', 'platform_admin'],
  summary: 'Platform team: approve or reject a person\'s access. Approved = they can add and change things; rejected = they are signed out and cannot sign in with Google (reversible: decide again). Nothing is deleted. Audit-logged.',
  input: z.object({ user_id: id, decision: z.enum(['approved', 'rejected']) }),
  async handler({ user }, i) {
    if (i.user_id === user.id) throw badRequest('You cannot change your own access');
    const r = await one(
      `UPDATE users SET access_status = $2, access_decided_by = $3, access_decided_at = now() WHERE id = $1 AND google_sub IS NOT NULL RETURNING id, handle, display_name, access_status`,
      [i.user_id, i.decision, user.id]);
    if (!r) throw notFound('Google sign-in request');
    if (i.decision === 'rejected') await revokeUserSessions(i.user_id, 'access_rejected');
    await audit(null, user.id, `access_${i.decision}`, 'users', i.user_id);
    return r;
  },
});
