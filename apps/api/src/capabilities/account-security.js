// Account security: email verification, password recovery, TOTP two-step verification (MFA) with recovery codes.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, query, tx } from '../db.js';
import { badRequest, notFound, unauthorized } from '../errors.js';
import { blindIndex, decrypt, encrypt, hashPassword, sha256, verifyPassword } from '../crypto.js';
import { audit } from '../helpers.js';
import { config } from '../config.js';
import { notifySecurity } from '../notify.js';
import { revokeUserSessions, startSession } from '../sessions.js';
import {
  consumeToken, hashRecovery, issueToken, matchStep, MFA_ROLES, newRecoveryCode, newTotpSecret, otpauthUri, recentTokens, tooMany,
} from '../account-security.js';

const TAG = 'Account security';
const link = (path, secret) => (config.appUrl ? `${config.appUrl.replace(/\/$/, '')}/${path}${secret}` : '');
const code6 = z.string().min(6).max(20).describe('6-digit authenticator code, or a recovery code');

// Wrong-code guesses per account are limited across every endpoint that checks a second factor.
const FAIL_LIMIT = 10;
async function assertNotLocked(userId) {
  const n = (await one("SELECT count(*)::int AS n FROM audit_log WHERE actor_id=$1 AND action='mfa_code_failed' AND at > now() - interval '15 minutes'", [userId])).n;
  if (n >= FAIL_LIMIT) throw tooMany('Too many wrong codes. Wait 15 minutes and try again.');
}
const liveFactor = (userId) => one('SELECT id, secret_enc, enabled_at FROM user_mfa WHERE user_id = $1 AND disabled_at IS NULL', [userId]);

/** Check a TOTP (single-use per time step) or a recovery code (single-use) for an enabled factor. */
async function checkSecondFactor(userId, code) {
  await assertNotLocked(userId);
  const f = await liveFactor(userId);
  if (!f?.enabled_at) throw badRequest('Two-step verification is not turned on');
  let ok = false;
  if (/^\s*\d{3}\s?\d{3}\s*$/.test(code)) {
    const step = matchStep(decrypt(f.secret_enc, 'user_mfa.secret'), code);
    ok = step != null && Boolean(await one('UPDATE user_mfa SET last_step = $2 WHERE id = $1 AND last_step < $2 RETURNING id', [f.id, step]));
  } else {
    ok = Boolean(await one('UPDATE mfa_recovery_codes SET used_at = now() WHERE mfa_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING id', [f.id, hashRecovery(code)]));
  }
  if (!ok) { await audit(null, userId, 'mfa_code_failed', 'users', userId); throw unauthorized('That code is not valid. Check the code and try again.'); }
  return f;
}

// ---- email verification ----
cap({
  name: 'request_email_verification', method: 'POST', path: '/me/email/verification', tag: TAG, auth: 'user',
  summary: 'Email yourself a single-use link/code (valid 24 hours) to confirm your address. At most 5 requests per hour.',
  async handler({ user }) {
    if (user.credential) throw badRequest('Not available to API tokens');
    if ((await one('SELECT email_verified_at FROM users WHERE id=$1', [user.id])).email_verified_at) return { ok: true, already_verified: true };
    if (await recentTokens(user.id, 'email_verify') >= 5) throw tooMany();
    const secret = await issueToken(user.id, 'email_verify', 24 * 60);
    await notifySecurity(user.id, { kind: 'security_email_verify', title: 'Confirm your SportArena email', body: `Confirm your email address with this code: {{secret}}\n${link('?verify_email=', '{{secret}}')}\nIt works once and expires in 24 hours. If you did not ask for this, ignore this email.`, secret });
    return { ok: true, already_verified: false };
  },
});
cap({
  name: 'verify_email', method: 'POST', path: '/auth/verify-email', tag: TAG, auth: 'public',
  summary: 'Confirm your email address with the single-use code from the verification email.',
  input: z.object({ token: z.string().min(10).max(200) }),
  async handler(_, i) {
    const t = await consumeToken(i.token, 'email_verify');
    if (!t) throw badRequest('This verification link has expired or was already used. Request a new one.');
    await query('UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1', [t.user_id]);
    return { ok: true };
  },
});

// ---- password recovery ----
cap({
  name: 'request_password_reset', method: 'POST', path: '/auth/password-reset', tag: TAG, auth: 'public',
  summary: 'Email a single-use password reset link/code (valid 30 minutes). Always answers the same way, so it never reveals whether an address has an account. Limited per account (3/hour) and per IP.',
  input: z.object({ email: z.string().email() }),
  async handler(_, i) {
    const u = await one('SELECT id FROM users WHERE email_idx = $1', [blindIndex(i.email)]);
    if (u && await recentTokens(u.id, 'password_reset') < 3) {
      const secret = await issueToken(u.id, 'password_reset', 30);
      await notifySecurity(u.id, { kind: 'security_password_reset', title: 'Reset your SportArena password', body: `Use this code to choose a new password: {{secret}}\n${link('?reset_password=', '{{secret}}')}\nIt works once and expires in 30 minutes. If you did not ask for this, ignore this email; your password has not changed.`, secret });
    }
    return { ok: true, message: 'If that email has an account, a reset link is on its way.' };
  },
});
cap({
  name: 'reset_password', method: 'POST', path: '/auth/password-reset/confirm', tag: TAG, auth: 'public',
  summary: 'Set a new password with the single-use reset code. Signs the account out everywhere (sessions are revoked), voids other outstanding reset codes and emails a notice. Two-step verification, if on, is still required at the next sign-in.',
  input: z.object({ token: z.string().min(10).max(200), new_password: z.string().min(10).max(200) }),
  async handler(_, i) {
    const t = await tx(async (c) => {
      const row = await consumeToken(i.token, 'password_reset', c);
      if (!row) return null;
      await c.query('UPDATE users SET password_hash = $2 WHERE id = $1', [row.user_id, await hashPassword(i.new_password)]);
      await c.query("UPDATE account_tokens SET used_at = now() WHERE user_id = $1 AND purpose = 'password_reset' AND used_at IS NULL", [row.user_id]);
      await audit(c, row.user_id, 'password_reset', 'users', row.user_id);
      return row;
    });
    if (!t) throw badRequest('This reset link has expired or was already used. Request a new one.');
    const signedOut = await revokeUserSessions(t.user_id, 'password_reset');
    await notifySecurity(t.user_id, { kind: 'security_password_changed', title: 'Your SportArena password was changed', body: 'Your password was reset and you were signed out everywhere. If this was not you, reset it again now and contact support.' });
    return { ok: true, signed_out_sessions: signedOut };
  },
});

// ---- MFA ----
cap({
  name: 'get_security_status', method: 'GET', path: '/me/security', tag: TAG, auth: 'user',
  summary: 'Your account-security state: email verified, two-step verification on/off, recovery codes left, and whether your role requires two-step verification.',
  async handler({ user }) {
    const u = await one('SELECT email_verified_at FROM users WHERE id=$1', [user.id]);
    const f = await liveFactor(user.id);
    const left = f?.enabled_at ? (await one('SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE mfa_id=$1 AND used_at IS NULL', [f.id])).n : 0;
    return {
      email_verified: Boolean(u.email_verified_at), email_verified_at: u.email_verified_at,
      mfa_enabled: Boolean(f?.enabled_at), mfa_setup_pending: Boolean(f && !f.enabled_at), recovery_codes_left: left,
      mfa_required_for_role: user.roles.some((r) => MFA_ROLES.includes(r)), mfa_enforced: config.mfaEnforce,
      session_mfa_verified: Boolean(user.security?.mfa_verified),
    };
  },
});
cap({
  name: 'mfa_setup', method: 'POST', path: '/me/mfa/setup', tag: TAG, auth: 'user', status: 201,
  summary: 'Start two-step verification: returns an authenticator secret and otpauth:// URI. It is not active until mfa_enable confirms a code. Needs your password. Starting again replaces an unconfirmed set-up.',
  input: z.object({ password: z.string().max(200) }),
  async handler({ user }, i) {
    if (user.credential) throw badRequest('Not available to API tokens');
    const row = await one('SELECT password_hash FROM users WHERE id=$1', [user.id]);
    if (!(await verifyPassword(i.password, row.password_hash))) throw unauthorized('Password is incorrect');
    const secret = newTotpSecret();
    await tx(async (c) => {
      const live = (await c.query('SELECT id, enabled_at FROM user_mfa WHERE user_id=$1 AND disabled_at IS NULL FOR UPDATE', [user.id])).rows[0];
      if (live?.enabled_at) throw badRequest('Two-step verification is already on. Turn it off first to set up a new device.');
      if (live) await c.query("UPDATE user_mfa SET disabled_at = now(), disabled_reason = 'superseded' WHERE id=$1", [live.id]);
      await c.query('INSERT INTO user_mfa(user_id, secret_enc) VALUES ($1,$2)', [user.id, encrypt(secret, 'user_mfa.secret')]);
    });
    return { secret, otpauth_uri: otpauthUri(secret, `${user.handle}`) };
  },
});
cap({
  name: 'mfa_enable', method: 'POST', path: '/me/mfa/enable', tag: TAG, auth: 'user',
  summary: 'Confirm set-up with a code from your authenticator app. Returns 10 single-use recovery codes, shown once (stored hashed). This session counts as verified.',
  input: z.object({ code: z.string().regex(/^\s*\d{3}\s?\d{3}\s*$/, 'Enter the 6-digit code') }),
  async handler({ user }, i) {
    if (user.credential) throw badRequest('Not available to API tokens');
    await assertNotLocked(user.id);
    const codes = Array.from({ length: 10 }, newRecoveryCode);
    const ok = await tx(async (c) => {
      const f = (await c.query('SELECT id, secret_enc FROM user_mfa WHERE user_id=$1 AND disabled_at IS NULL AND enabled_at IS NULL FOR UPDATE', [user.id])).rows[0];
      if (!f) throw badRequest('Start set-up first (mfa_setup)');
      const step = matchStep(decrypt(f.secret_enc, 'user_mfa.secret'), i.code);
      if (step == null) return false;
      await c.query('UPDATE user_mfa SET enabled_at = now(), last_step = $2 WHERE id=$1', [f.id, step]);
      for (const code of codes) await c.query('INSERT INTO mfa_recovery_codes(mfa_id, user_id, code_hash) VALUES ($1,$2,$3)', [f.id, user.id, hashRecovery(code)]);
      if (user.session_id) await c.query('UPDATE auth_sessions SET mfa_verified_at = now() WHERE id=$1', [user.session_id]);
      await audit(c, user.id, 'mfa_enabled', 'users', user.id);
      return true;
    });
    if (!ok) { await audit(null, user.id, 'mfa_code_failed', 'users', user.id); throw unauthorized('That code is not valid. Check the code and try again.'); }
    await notifySecurity(user.id, { kind: 'security_mfa_enabled', title: 'Two-step verification is on', body: 'Two-step verification was turned on for your SportArena account. If this was not you, reset your password and contact support.' });
    return { ok: true, recovery_codes: codes };
  },
});
cap({
  name: 'verify_mfa', method: 'POST', path: '/me/mfa/verify', tag: TAG, auth: 'user',
  summary: 'Step-up: confirm a code (or recovery code) to mark this session as verified for sensitive actions.',
  input: z.object({ code: code6 }),
  async handler({ user }, i) {
    if (user.credential || !user.session_id) throw badRequest('Sign in with your password to use this');
    await checkSecondFactor(user.id, i.code);
    await query('UPDATE auth_sessions SET mfa_verified_at = now() WHERE id=$1', [user.session_id]);
    return { ok: true };
  },
});
cap({
  name: 'mfa_disable', method: 'POST', path: '/me/mfa/disable', tag: TAG, auth: 'user',
  summary: 'Turn two-step verification off (needs your password and a current code or recovery code). Other devices are signed out. The old factor is kept, marked disabled.',
  input: z.object({ password: z.string().max(200), code: code6 }),
  async handler({ user }, i) {
    if (user.credential) throw badRequest('Not available to API tokens');
    const row = await one('SELECT password_hash FROM users WHERE id=$1', [user.id]);
    if (!(await verifyPassword(i.password, row.password_hash))) throw unauthorized('Password is incorrect');
    const f = await checkSecondFactor(user.id, i.code);
    await query("UPDATE user_mfa SET disabled_at = now(), disabled_reason = 'user' WHERE id=$1", [f.id]);
    await audit(null, user.id, 'mfa_disabled', 'users', user.id);
    const out = await revokeUserSessions(user.id, 'mfa_disabled', user.session_id ?? null);
    await notifySecurity(user.id, { kind: 'security_mfa_disabled', title: 'Two-step verification was turned off', body: 'Two-step verification was turned off for your SportArena account. If this was not you, reset your password now.' });
    return { ok: true, signed_out_elsewhere: out };
  },
});
cap({
  name: 'login_mfa', method: 'POST', path: '/auth/login/mfa', tag: TAG, auth: 'public',
  summary: 'Finish a sign-in that returned mfa_required: send the mfa_token with a 6-digit authenticator code or a recovery code. The challenge lasts 5 minutes and allows 5 wrong tries.',
  input: z.object({ mfa_token: z.string().min(10).max(200), code: code6 }),
  async handler({ meta }, i) {
    const ch = await one("SELECT id, user_id, attempts FROM account_tokens WHERE token_hash=$1 AND purpose='mfa_login' AND used_at IS NULL AND expires_at > now()", [sha256(i.mfa_token)]);
    if (!ch) throw unauthorized('This sign-in expired. Please sign in again.');
    if (ch.attempts >= 5) { await query('UPDATE account_tokens SET used_at = now() WHERE id=$1', [ch.id]); throw unauthorized('Too many wrong codes. Please sign in again.'); }
    try { await checkSecondFactor(ch.user_id, i.code); }
    catch (e) { await query('UPDATE account_tokens SET attempts = attempts + 1 WHERE id=$1', [ch.id]); throw e; }
    if (!(await one('UPDATE account_tokens SET used_at = now() WHERE id=$1 AND used_at IS NULL RETURNING id', [ch.id]))) throw unauthorized('This sign-in was already completed.');
    const u = await one('SELECT id, handle, display_name, roles, avatar_emoji, avatar_color, avatar_url, avatar_cutout FROM users WHERE id=$1', [ch.user_id]);
    return { user: u, ...(await startSession(u, meta, { mfa: true })) };
  },
});
cap({
  name: 'admin_reset_mfa', method: 'POST', path: '/admin/users/:user_id/mfa-reset', tag: TAG, auth: ['admin'],
  summary: 'Admin recovery for someone who lost both their authenticator and recovery codes: disables their two-step verification (kept, marked admin_reset), signs them out everywhere and emails them. Audit-logged.',
  input: z.object({ user_id: id }),
  async handler({ user }, i) {
    const f = await liveFactor(i.user_id);
    if (!f) throw notFound('Two-step verification for this user');
    await query("UPDATE user_mfa SET disabled_at = now(), disabled_reason = 'admin_reset' WHERE id=$1", [f.id]);
    await audit(null, user.id, 'mfa_admin_reset', 'users', i.user_id);
    const out = await revokeUserSessions(i.user_id, 'mfa_reset');
    await notifySecurity(i.user_id, { kind: 'security_mfa_reset', title: 'Two-step verification was reset by support', body: 'Support turned off two-step verification on your account and signed you out everywhere. Sign in and set it up again.' });
    return { ok: true, signed_out_sessions: out };
  },
});
