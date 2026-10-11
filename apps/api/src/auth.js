import { SignJWT, jwtVerify } from 'jose';
import { config } from './config.js';
import { one, query } from './db.js';
import { sha256 } from './crypto.js';

const secret = () => new TextEncoder().encode(config.jwtSecret);

export const signToken = (user) =>
  new SignJWT({ roles: user.roles }).setProtectedHeader({ alg: 'HS256' }).setSubject(user.id).setIssuedAt().setExpirationTime(config.tokenTtl).sign(secret());

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
                  t.id AS _tid, t.scopes AS _scopes, t.resources AS _resources, t.expires_at AS _exp`,
      [sha256(tok)],
    );
    if (!row) return null;
    const { _tid, _scopes, _resources, _exp, ...user } = row;
    // Non-enumerable so it is never serialised into a response; invoke() reads it to enforce scope/resources.
    Object.defineProperty(user, 'credential', { value: { type: 'api_token', id: _tid, scopes: _scopes, resources: _resources, expires_at: _exp }, enumerable: false });
    return user;
  }
  try {
    const { payload } = await jwtVerify(tok, secret(), { algorithms: ['HS256'] });
    return await one(`SELECT ${COLS} FROM users WHERE id = $1`, [payload.sub]);
  } catch {
    return null;
  }
}
