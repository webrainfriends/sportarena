import { SignJWT, jwtVerify } from 'jose';
import { config } from './config.js';
import { one, query } from './db.js';
import { sha256 } from './crypto.js';

const secret = () => new TextEncoder().encode(config.jwtSecret);

export const signToken = (user, sessionId) =>
  new SignJWT({ roles: user.roles }).setProtectedHeader({ alg: 'HS256' }).setSubject(user.id).setJti(sessionId ?? crypto.randomUUID()).setIssuedAt().setExpirationTime(config.tokenTtl).sign(secret());

const COLS = 'id, handle, display_name, roles, avatar_emoji, avatar_color, avatar_url, avatar_cutout';

/** Resolve a `Bearer` credential (JWT or `sa_` API token) to a user row, or null. */
export async function authenticate(authorization) {
  const m = /^Bearer\s+(.+)$/i.exec(authorization ?? '');
  if (!m) return null;
  const tok = m[1].trim();
  if (tok.startsWith('sa_')) {
    // Revoked or expired tokens match no row, so they fail on the very next request.
    const row = await one(
      `UPDATE api_tokens t SET last_used_at = now() FROM users u
        WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now()) AND u.id = t.user_id
        RETURNING u.id, u.handle, u.display_name, u.roles, u.avatar_emoji, u.avatar_color, u.avatar_url, u.avatar_cutout,
                  t.id AS _tid, t.scopes AS _scopes, t.resources AS _resources, t.expires_at AS _exp,
                  EXISTS (SELECT 1 FROM user_mfa m WHERE m.user_id = u.id AND m.enabled_at IS NOT NULL AND m.disabled_at IS NULL) AS _mfa`,
      [sha256(tok)],
    );
    if (!row) return null;
    const { _tid, _scopes, _resources, _exp, _mfa, ...user } = row;
    // Non-enumerable so it is never serialised into a response; invoke() reads it to enforce scope/resources.
    Object.defineProperty(user, 'credential', { value: { type: 'api_token', id: _tid, scopes: _scopes, resources: _resources, expires_at: _exp, owner_mfa_enabled: _mfa }, enumerable: false });
    return user;
  }
  try {
    const { payload } = await jwtVerify(tok, secret(), { algorithms: ['HS256'] });
    // Session-bound tokens (jti = auth_sessions.id) are valid only while the server session is active: logout, revoke and
    // password change take effect on the very next request. Tokens issued before sessions existed carry no session row and
    // live out their (short) TTL; set AUTH_REQUIRE_SESSION=true to refuse them immediately.
    const s = await one(`SELECT mfa_verified_at IS NOT NULL AS mfa_verified,
                           EXISTS (SELECT 1 FROM user_mfa m WHERE m.user_id = $2 AND m.enabled_at IS NOT NULL AND m.disabled_at IS NULL) AS mfa_enabled
                      FROM auth_sessions WHERE id::text = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now()`, [payload.jti ?? '', payload.sub]);
    if (!s && (payload.jti ? await one('SELECT 1 FROM auth_sessions WHERE id::text = $1', [payload.jti]) : config.requireSession)) return null;
    const user = await one(`SELECT ${COLS} FROM users WHERE id = $1`, [payload.sub]);
    if (!user) return null;
    if (s) {
      Object.defineProperty(user, 'session_id', { value: payload.jti, enumerable: false });
      Object.defineProperty(user, 'security', { value: { mfa_enabled: s.mfa_enabled, mfa_verified: s.mfa_verified }, enumerable: false });
      // cheap, throttled activity stamp for the sessions list
      query("UPDATE auth_sessions SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '1 minute'", [payload.jti]).catch(() => {});
    }
    return user;
  } catch {
    return null;
  }
}
