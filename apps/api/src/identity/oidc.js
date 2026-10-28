// OpenID Connect authorization-code flow with PKCE, built on `jose` for every signature / claim check (no hand-rolled JWT handling).
// Validates: signature against the IdP's published keys (refetched once on an unknown `kid`, so key rotation needs no change here),
// issuer, audience (+ azp), expiry / not-before with the connection's clock skew, nonce, single-use state, and jti replay.
import { createHash, randomBytes } from 'node:crypto';
import { createLocalJWKSet, errors, jwtVerify } from 'jose';
import { one, query } from '../db.js';
import { decrypt, encrypt, sha256 } from '../crypto.js';
import { assertPublicHttpsUrl, fetchJson, transport } from './safe-http.js';
import { unauthorized } from '../errors.js';

const ALGS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA']; // never HS* (shared secret) and never 'none'
const jwksCache = new Map(); // jwks_uri -> { keys, at }
/** How soon the keys may be refetched after an unknown `kid` (limits how often a bad token can make us call the IdP). */
export const jwksPolicy = { refetchAfterMs: 30_000 };

export const b64 = (buf) => Buffer.from(buf).toString('base64url');

/** Read the issuer's discovery document and return the public endpoints to store on the connection. */
export async function discover(issuer) {
  const base = assertPublicHttpsUrl(issuer, 'Issuer').href.replace(/\/$/, '');
  const doc = await fetchJson(`${base}/.well-known/openid-configuration`);
  if (String(doc.issuer ?? '').replace(/\/$/, '') !== base) throw new Error('issuer in the discovery document does not match');
  for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) assertPublicHttpsUrl(doc[k], k);
  return { issuer: doc.issuer, authorization_endpoint: doc.authorization_endpoint, token_endpoint: doc.token_endpoint, jwks_uri: doc.jwks_uri,
    id_token_signing_alg_values_supported: doc.id_token_signing_alg_values_supported ?? null };
}

export async function loadJwks(uri, { force = false } = {}) {
  const hit = jwksCache.get(uri);
  if (hit && !force) return hit.keys;
  if (hit && force && Date.now() - hit.at < jwksPolicy.refetchAfterMs) return hit.keys;
  const keys = await fetchJson(uri);
  if (!Array.isArray(keys?.keys)) throw new Error('JWKS has no keys');
  jwksCache.set(uri, { keys, at: Date.now() });
  return keys;
}
export const forgetJwks = (uri) => jwksCache.delete(uri);

/** Where to send the person, plus the single-use state row that the callback must present. */
export async function beginOidc(conn, redirectUri, linkUserId = null) {
  const cfg = conn.config;
  const state = b64(randomBytes(24)), nonce = b64(randomBytes(24)), verifier = b64(randomBytes(48));
  await query(
    'INSERT INTO sso_login_states(connection_id, state_hash, nonce_hash, verifier_enc, redirect_uri, link_user_id, expires_at) VALUES ($1,$2,$3,$4,$5,$6, now() + interval \'10 minutes\')',
    [conn.id, sha256(state), sha256(nonce), encrypt(verifier, 'sso_login_states.verifier'), redirectUri, linkUserId]);
  const u = new URL(cfg.authorization_endpoint);
  u.search = new URLSearchParams({ response_type: 'code', client_id: cfg.client_id, redirect_uri: redirectUri, scope: cfg.scopes ?? 'openid email profile',
    state, nonce, code_challenge: b64(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' }).toString();
  return { url: u.toString(), state };
}

/** Exchange the code and validate the ID token. Returns { claims, linkUserId } (claims are verified; throws 401 for anything that does not check out. */
export async function completeOidc(conn, { state, code }) {
  const row = await one(
    "UPDATE sso_login_states SET used_at = now() WHERE state_hash = $1 AND connection_id = $2 AND used_at IS NULL AND expires_at > now() RETURNING nonce_hash, verifier_enc, redirect_uri, link_user_id",
    [sha256(state), conn.id]);
  if (!row) throw unauthorized('This sign-in link has expired or was already used. Please start again.');
  const cfg = conn.config;
  const secret = conn.client_secret_enc ? decrypt(conn.client_secret_enc, 'org_sso_connections.client_secret') : null;
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: row.redirect_uri, client_id: cfg.client_id, code_verifier: decrypt(row.verifier_enc, 'sso_login_states.verifier') });
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (secret) { if (cfg.token_auth === 'basic') headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(cfg.client_id)}:${encodeURIComponent(secret)}`).toString('base64')}`; else form.set('client_secret', secret); }
  let tokens;
  try {
    const r = await transport.fetch({ url: cfg.token_endpoint, method: 'POST', headers, body: form.toString() });
    if (r.status !== 200) throw new Error(`token endpoint ${r.status}`);
    tokens = JSON.parse(r.text);
  } catch { throw unauthorized('The identity provider did not accept the sign-in. Please try again.'); }
  if (typeof tokens.id_token !== 'string') throw unauthorized('The identity provider did not return an identity token.');
  const claims = await verifyIdToken(conn, tokens.id_token);
  if (sha256(String(claims.nonce ?? '')) !== row.nonce_hash) throw unauthorized('Sign-in could not be verified (nonce).');
  return { claims, linkUserId: row.link_user_id };
}

/** Signature + claim validation, separated so conformance tests can drive it with fixture tokens. */
export async function verifyIdToken(conn, idToken) {
  const cfg = conn.config;
  const opts = { issuer: cfg.issuer, audience: cfg.client_id, algorithms: ALGS, clockTolerance: conn.clock_skew_seconds ?? 60, requiredClaims: ['sub', 'exp', 'iat'] };
  const attempt = async (force) => jwtVerify(idToken, createLocalJWKSet(await loadJwks(cfg.jwks_uri, { force })), opts);
  let payload;
  try {
    try { ({ payload } = await attempt(false)); } catch (e) { if (e instanceof errors.JWKSNoMatchingKey) ({ payload } = await attempt(true)); else throw e; }
  } catch { throw unauthorized('Sign-in could not be verified.'); }
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== cfg.client_id) throw unauthorized('Sign-in could not be verified (azp).');
  if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255) throw unauthorized('Sign-in could not be verified.');
  const maxAge = cfg.max_token_age_seconds ?? 600; // an id_token must be fresh: it cannot be hoarded and presented later
  if (Math.floor(Date.now() / 1000) - payload.iat > maxAge + (conn.clock_skew_seconds ?? 60)) throw unauthorized('Sign-in could not be verified (stale).');
  if (payload.jti && !(await claimOnce(conn.id, `oidc:${payload.jti}`, payload.exp))) throw unauthorized('This sign-in was already used.');
  return payload;
}

/** Record an id once; false when it was seen before (replay). `expEpoch` keeps the row only as long as it could matter. */
export async function claimOnce(connectionId, value, expEpoch) {
  await query('DELETE FROM sso_replay WHERE expires_at < now()');
  const keep = Math.max(Number(expEpoch) || 0, Math.floor(Date.now() / 1000) + 300);
  const r = await query('INSERT INTO sso_replay(connection_id, value_hash, expires_at) VALUES ($1,$2, to_timestamp($3)) ON CONFLICT DO NOTHING', [connectionId, sha256(value), keep]);
  return r.rowCount === 1;
}

/** Connection test: discovery still matches, the keys load, and they contain a usable signing key. */
export async function testOidc(conn) {
  const cfg = conn.config;
  const d = await discover(cfg.issuer);
  const jwks = await loadJwks(d.jwks_uri, { force: true });
  if (!jwks.keys.length) throw new Error('the identity provider publishes no signing keys');
  return `Discovery and ${jwks.keys.length} signing key(s) look good.`;
}
