import { z } from 'zod';
import { cap, id } from '../registry.js';
import { many, one } from '../db.js';
import { badRequest, notFound, unauthorized } from '../errors.js';
import { hashPassword, verifyPassword } from '../crypto.js';
import { revokeSession, revokeUserSessions, rotateRefresh } from '../sessions.js';

const TAG = 'Identity';

cap({
  name: 'refresh_session', method: 'POST', path: '/auth/refresh', tag: TAG, auth: 'public',
  summary: 'Swap a refresh_token for a new access token and a NEW refresh_token (rotation). Each refresh token works once: presenting an already-used one is treated as theft and ends the whole session.',
  input: z.object({ refresh_token: z.string().min(20).max(200) }),
  handler: (_, i) => rotateRefresh(i.refresh_token),
});

cap({
  name: 'logout', method: 'POST', path: '/auth/logout', tag: TAG, auth: 'user',
  summary: 'Sign out this device: the server session ends immediately, so the access token and refresh token stop working.',
  async handler({ user }) {
    if (user.credential) throw badRequest('This is an API token; use revoke_api_token instead');
    if (user.session_id) await revokeSession(user.session_id, 'logout');
    return { ok: true, revoked: Boolean(user.session_id) };
  },
});

cap({
  name: 'logout_all', method: 'POST', path: '/auth/logout-all', tag: TAG, auth: 'user',
  summary: 'Sign out everywhere: every active session of your account ends immediately (API tokens are not affected; revoke those separately).',
  async handler({ user }) {
    if (user.credential) throw badRequest('Sign-out is not available to API tokens');
    return { ok: true, revoked: await revokeUserSessions(user.id, 'logout_all') };
  },
});

cap({
  name: 'list_login_sessions', method: 'GET', path: '/me/sessions', tag: TAG, auth: 'user',
  summary: 'Your signed-in devices/sessions (active only), newest first, with last activity and which one is this device.',
  async handler({ user }) {
    const rows = await many(
      `SELECT id, created_at, last_seen_at, expires_at, user_agent, ip FROM auth_sessions
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC, id`, [user.id]);
    return rows.map((r) => ({ ...r, current: r.id === user.session_id }));
  },
});

cap({
  name: 'revoke_login_session', method: 'DELETE', path: '/me/sessions/:id', tag: TAG, auth: 'user',
  summary: 'Sign out one of your other devices/sessions.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const s = await one('SELECT id FROM auth_sessions WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [i.id, user.id]);
    if (!s) throw notFound('Session');
    await revokeSession(i.id, 'revoked');
    return { ok: true };
  },
});

cap({
  name: 'change_my_password', method: 'POST', path: '/me/password', tag: TAG, auth: 'user',
  summary: 'Change your password. All your other devices are signed out; this one stays signed in.',
  input: z.object({ current_password: z.string().max(200), new_password: z.string().min(10).max(200) }),
  async handler({ user }, i) {
    if (user.credential) throw badRequest('Password changes are not available to API tokens');
    const row = await one('SELECT password_hash FROM users WHERE id = $1', [user.id]);
    if (!verifyPassword(i.current_password, row.password_hash)) throw unauthorized('Current password is incorrect');
    if (i.current_password === i.new_password) throw badRequest('Choose a different password');
    await one('UPDATE users SET password_hash = $2 WHERE id = $1 RETURNING id', [user.id, hashPassword(i.new_password)]);
    return { ok: true, signed_out_elsewhere: await revokeUserSessions(user.id, 'password_changed', user.session_id ?? null) };
  },
});
