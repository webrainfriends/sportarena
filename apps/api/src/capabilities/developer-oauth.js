// Developer Platform (#569): OAuth 2.0 authorization server.
// Supports: authorization_code (PKCE for public clients, client_secret for confidential clients),
//           client_credentials (server-to-server, no user context).
// RFC 6749, RFC 7009 (revocation), RFC 7662 (introspection), RFC 7636 (PKCE).
// No refresh tokens in v1 — 1 hour access tokens, re-authorize when expired.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { newOpaqueToken, sha256, encrypt, decrypt } from '../crypto.js';
import { DEV_SECRET_CTX } from './developer-apps.js';

const TAG = 'Developer';
const TOKEN_TTL_SECONDS = 3600;
const CODE_CHALLENGE_METHOD = 'S256';

function verifyPkce(challenge, verifier) {
  if (!challenge || !verifier) return false;
  const hash = createHash('sha256').update(verifier).digest('base64url');
  return hash === challenge;
}

async function loadApp(clientId) {
  const app = await one("SELECT * FROM developer_apps WHERE client_id=$1 AND status='active'", [clientId]);
  if (!app) throw badRequest('client_not_found');
  return app;
}

function verifyClientSecret(app, clientSecret) {
  if (!app.client_secret_enc) return false;
  const stored = decrypt(app.client_secret_enc, DEV_SECRET_CTX);
  return stored === clientSecret;
}

const mintToken = (sandbox) => `${sandbox ? 'sk_test_' : 'sk_live_'}${newOpaqueToken().replace('sa_', '')}`;

cap({
  name: 'oauth_authorize',
  method: 'GET',
  path: '/oauth/authorize',
  tag: TAG,
  scope: 'read',
  summary: 'Validate an OAuth authorization request and return the app info + scopes needed to render the consent screen. Called by the OAuthConsent screen.',
  input: z.object({
    client_id: z.string(),
    redirect_uri: z.string().url(),
    response_type: z.literal('code'),
    scope: z.string().optional(),
    state: z.string().optional(),
    code_challenge: z.string().optional(),
    code_challenge_method: z.literal('S256').optional(),
  }),
  async handler(_, i) {
    const app = await loadApp(i.client_id);
    if (!app.redirect_uris.includes(i.redirect_uri)) throw badRequest('invalid_redirect_uri');
    const requested = i.scope ? i.scope.split(/\s+/).filter(Boolean) : ['read'];
    const allowed = requested.filter((s) => app.allowed_scopes.includes(s));
    if (!allowed.length) throw badRequest('invalid_scope');
    return {
      app: { name: app.name, website_url: app.website_url, logo_url: app.logo_url },
      scopes: allowed,
      client_id: app.client_id,
      sandbox_mode: app.sandbox_mode,
    };
  },
});

cap({
  name: 'oauth_consent',
  method: 'POST',
  path: '/oauth/authorize',
  tag: TAG,
  status: 200,
  summary: 'User approves an OAuth authorization request. Issues a short-lived authorization code, logs consent, and returns the redirect URL for the client.',
  input: z.object({
    client_id: z.string(),
    redirect_uri: z.string().url(),
    response_type: z.literal('code'),
    scope: z.string().optional(),
    state: z.string().optional(),
    code_challenge: z.string().optional(),
    code_challenge_method: z.literal('S256').optional(),
  }),
  async handler({ user, meta }, i) {
    const app = await loadApp(i.client_id);
    if (!app.redirect_uris.includes(i.redirect_uri)) throw badRequest('invalid_redirect_uri');
    const requested = i.scope ? i.scope.split(/\s+/).filter(Boolean) : ['read'];
    const scopes = requested.filter((s) => app.allowed_scopes.includes(s));
    if (!scopes.length) throw badRequest('invalid_scope');

    const plainCode = newOpaqueToken().replace('sa_', 'ac_');
    await tx(async (c) => {
      await c.query(
        'INSERT INTO oauth_codes(developer_app_id, user_id, code_hash, redirect_uri, scopes, code_challenge) VALUES ($1,$2,$3,$4,$5,$6)',
        [app.id, user.id, sha256(plainCode), i.redirect_uri, scopes, i.code_challenge ?? null],
      );
      await c.query('INSERT INTO oauth_consent_log(developer_app_id, user_id, action, scopes, ip) VALUES ($1,$2,$3,$4,$5)', [app.id, user.id, 'granted', scopes, meta?.ip ?? null]);
      await audit(c, user.id, 'oauth_consent_granted', 'developer_apps', app.id);
    });
    const params = new URLSearchParams({ code: plainCode });
    if (i.state) params.set('state', i.state);
    return { redirect_to: `${i.redirect_uri}?${params}` };
  },
});

cap({
  name: 'oauth_token',
  method: 'POST',
  path: '/oauth/token',
  tag: TAG,
  auth: 'public',
  status: 200,
  summary: 'Exchange an authorization code or client_credentials for a bearer access token (RFC 6749). Supports PKCE for public clients.',
  input: z.object({
    grant_type: z.enum(['authorization_code', 'client_credentials']),
    client_id: z.string(),
    client_secret: z.string().optional(),
    code: z.string().optional(),
    redirect_uri: z.string().url().optional(),
    code_verifier: z.string().optional(),
    scope: z.string().optional(),
  }),
  async handler(_, i) {
    const app = await loadApp(i.client_id);

    if (i.grant_type === 'authorization_code') {
      if (!i.code) throw badRequest('missing_code');
      if (!i.redirect_uri) throw badRequest('missing_redirect_uri');
      const row = await one(
        "SELECT * FROM oauth_codes WHERE code_hash=$1 AND developer_app_id=$2 AND used_at IS NULL AND expires_at > now()",
        [sha256(i.code), app.id],
      );
      if (!row) throw badRequest('invalid_code');
      if (row.redirect_uri !== i.redirect_uri) throw badRequest('redirect_uri_mismatch');

      // Verify auth: PKCE (public clients) or client_secret (confidential clients)
      if (row.code_challenge) {
        if (!verifyPkce(row.code_challenge, i.code_verifier)) throw badRequest('invalid_code_verifier');
      } else if (!verifyClientSecret(app, i.client_secret)) {
        throw forbidden('invalid_client');
      }

      const token = mintToken(app.sandbox_mode);
      await tx(async (c) => {
        await c.query('UPDATE oauth_codes SET used_at=now() WHERE id=$1', [row.id]);
        await c.query(
          'INSERT INTO oauth_tokens(developer_app_id, user_id, token_hash, scopes, sandbox_mode, expires_at) VALUES ($1,$2,$3,$4,$5, now() + make_interval(secs => $6))',
          [app.id, row.user_id, sha256(token), row.scopes, app.sandbox_mode, TOKEN_TTL_SECONDS],
        );
      });
      return { access_token: token, token_type: 'Bearer', expires_in: TOKEN_TTL_SECONDS, scope: row.scopes.join(' ') };
    }

    if (i.grant_type === 'client_credentials') {
      if (!verifyClientSecret(app, i.client_secret)) throw forbidden('invalid_client');
      const requested = i.scope ? i.scope.split(/\s+/).filter(Boolean) : app.allowed_scopes;
      const scopes = requested.filter((s) => app.allowed_scopes.includes(s));
      if (!scopes.length) throw badRequest('invalid_scope');
      const token = mintToken(app.sandbox_mode);
      await one(
        'INSERT INTO oauth_tokens(developer_app_id, user_id, token_hash, scopes, sandbox_mode, expires_at) VALUES ($1,NULL,$2,$3,$4, now() + make_interval(secs => $5)) RETURNING id',
        [app.id, sha256(token), scopes, app.sandbox_mode, TOKEN_TTL_SECONDS],
      );
      return { access_token: token, token_type: 'Bearer', expires_in: TOKEN_TTL_SECONDS, scope: scopes.join(' ') };
    }
  },
});

cap({
  name: 'oauth_revoke_token',
  method: 'POST',
  path: '/oauth/revoke',
  tag: TAG,
  auth: 'public',
  summary: 'RFC 7009: revoke an OAuth bearer token. Succeeds even if already revoked or unknown.',
  input: z.object({ token: z.string(), client_id: z.string().optional() }),
  async handler(_, i) {
    await one('UPDATE oauth_tokens SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL RETURNING id', [sha256(i.token)]);
    return {};
  },
});

cap({
  name: 'list_my_oauth_grants',
  method: 'GET',
  path: '/me/oauth-grants',
  tag: TAG,
  scope: 'read',
  summary: 'Apps the signed-in user has authorised via OAuth, with scopes and last activity.',
  input: z.object({}),
  async handler({ user }) {
    const rows = await many(
      `SELECT DISTINCT ON (t.developer_app_id) a.id, a.name, a.website_url, a.logo_url, a.client_id,
              t.scopes, t.created_at, t.last_used_at
         FROM oauth_tokens t JOIN developer_apps a ON a.id = t.developer_app_id
        WHERE t.user_id=$1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())
        ORDER BY t.developer_app_id, t.created_at DESC`,
      [user.id],
    );
    return { items: rows };
  },
});

cap({
  name: 'revoke_my_oauth_grant',
  method: 'POST',
  path: '/me/oauth-grants/:app_id/revoke',
  tag: TAG,
  summary: 'Revoke all tokens a user has granted to a specific developer app.',
  input: z.object({ app_id: id }),
  async handler({ user, meta }, i) {
    await tx(async (c) => {
      await c.query('UPDATE oauth_tokens SET revoked_at=now() WHERE developer_app_id=$1 AND user_id=$2 AND revoked_at IS NULL', [i.app_id, user.id]);
      await c.query('INSERT INTO oauth_consent_log(developer_app_id, user_id, action, ip) VALUES ($1,$2,$3,$4)', [i.app_id, user.id, 'revoked', meta?.ip ?? null]);
      await audit(c, user.id, 'revoke_oauth_grant', 'developer_apps', i.app_id);
    });
    return { revoked: true };
  },
});
