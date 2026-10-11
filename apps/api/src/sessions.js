// Server-side sessions: a signed-in browser/device = one auth_sessions row + a chain of rotating refresh tokens.
import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { one, query, tx } from './db.js';
import { sha256 } from './crypto.js';
import { unauthorized } from './errors.js';
import { signToken } from './auth.js';

const newRefreshSecret = () => 'sr_' + randomBytes(32).toString('base64url');
const trim = (s, n) => (s ? String(s).slice(0, n) : null);

/** Open a session for a user and return the access JWT plus the first refresh token. */
export async function startSession(user, meta = {}, { mfa = false } = {}) {
  const refresh = newRefreshSecret();
  const session = await tx(async (c) => {
    const s = (await c.query(
      `INSERT INTO auth_sessions(user_id, expires_at, user_agent, ip, mfa_verified_at) VALUES ($1, now() + make_interval(days => $2), $3, $4, CASE WHEN $5 THEN now() END) RETURNING id, expires_at`,
      [user.id, config.refreshTtlDays, trim(meta.userAgent, 300), trim(meta.ip, 64), mfa])).rows[0];
    await c.query('INSERT INTO refresh_tokens(session_id, token_hash, expires_at) VALUES ($1,$2,$3)', [s.id, sha256(refresh), s.expires_at]);
    return s;
  });
  return { session_id: session.id, token: await signToken(user, session.id), refresh_token: refresh, expires_at: session.expires_at };
}

export async function revokeSession(sessionId, reason) {
  await query('UPDATE auth_sessions SET revoked_at = now(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL', [sessionId, reason]);
}

/** Revoke every active session of a user, optionally keeping one (e.g. the one that just changed the password). */
export async function revokeUserSessions(userId, reason, exceptSessionId = null) {
  const r = await query(
    `UPDATE auth_sessions SET revoked_at = now(), revoked_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL AND ($3::uuid IS NULL OR id <> $3)`,
    [userId, reason, exceptSessionId]);
  return r.rowCount;
}

/**
 * Exchange a refresh token for a new access token + a new refresh token (rotation).
 * Atomic: only one request can consume a given token. Presenting a token that was already rotated is treated as theft and
 * revokes the whole session (family), so both the attacker and the legitimate holder must sign in again.
 */
export async function rotateRefresh(secret) {
  const hash = sha256(secret);
  const next = newRefreshSecret();
  const out = await tx(async (c) => {
    const used = (await c.query(
      `UPDATE refresh_tokens r SET used_at = now() FROM auth_sessions s
        WHERE r.token_hash = $1 AND r.used_at IS NULL AND r.expires_at > now() AND s.id = r.session_id AND s.revoked_at IS NULL AND s.expires_at > now()
        RETURNING r.id, r.session_id, s.user_id`, [hash])).rows[0];
    if (!used) return null;
    const ins = (await c.query('INSERT INTO refresh_tokens(session_id, token_hash, expires_at) VALUES ($1,$2, now() + make_interval(days => $3)) RETURNING id, expires_at', [used.session_id, sha256(next), config.refreshTtlDays])).rows[0];
    await c.query('UPDATE refresh_tokens SET replaced_by = $2 WHERE id = $1', [used.id, ins.id]);
    await c.query('UPDATE auth_sessions SET last_seen_at = now(), expires_at = $2 WHERE id = $1', [used.session_id, ins.expires_at]);
    return used;
  });
  if (!out) {
    // Unknown, expired, or already used? A reused (already rotated) token means the family is compromised.
    const old = await one('SELECT session_id, used_at FROM refresh_tokens WHERE token_hash = $1', [hash]);
    if (old?.used_at) await revokeSession(old.session_id, 'refresh_reuse');
    throw unauthorized('Session expired. Please sign in again.');
  }
  const user = await one('SELECT id, handle, display_name, roles, avatar_emoji, avatar_color, avatar_url, avatar_cutout FROM users WHERE id = $1', [out.user_id]);
  return { user, session_id: out.session_id, token: await signToken(user, out.session_id), refresh_token: next };
}
