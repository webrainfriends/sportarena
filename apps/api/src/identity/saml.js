// SAML 2.0 Web-Browser SSO (SP-initiated, HTTP-POST ACS) on the maintained `@node-saml/node-saml` library, which does the XML signature,
// audience, conditions, status and InResponseTo checks. This file only wires it to our database (single-use request ids, replay store)
// and reads the verified result. Unsolicited (IdP-initiated) responses are refused: every response must answer a request we made.
import { randomBytes } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import { SAML, ValidateInResponseTo } from '@node-saml/node-saml';
import { one, query } from '../db.js';
import { sha256 } from '../crypto.js';
import { unauthorized } from '../errors.js';
import { readGroups } from './policy.js';

const EMAIL_ATTRS = ['email', 'mail', 'emailAddress', 'urn:oid:0.9.2342.19200300.100.1.3', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'];

const pemOf = (b64) => `-----BEGIN CERTIFICATE-----\n${String(b64).replace(/\s+/g, '').match(/.{1,64}/g)?.join('\n')}\n-----END CERTIFICATE-----`;
export const normalisePem = (s) => (/BEGIN CERTIFICATE/.test(s) ? String(s).trim() : pemOf(s));

/** Certificates the connection trusts right now: all that have not passed their retire date (so old and new overlap during rotation). */
export const trustedCerts = (conn, now = Date.now()) =>
  (conn.idp_certs ?? []).filter((c) => !c.retire_after || Date.parse(c.retire_after) > now).map((c) => normalisePem(c.pem));

/** Request ids live in sso_login_states; assertion ids in sso_replay. Both are atomic single-use. */
const cacheFor = (connectionId, state) => {
  // Every lookup is scoped to this connection and (when validating) to the RelayState the browser came back with, so a request id issued
  // for another connection, or for another browser's login, can never answer this response.
  const h = state == null ? null : sha256(state);
  const where = 'saml_request_id = $1 AND connection_id = $2 AND ($3::text IS NULL OR state_hash = $3)';
  return {
    // the library saves the AuthnRequest id when it builds the request; bind it to the login state we just created
    async saveAsync(key, value) { await query('UPDATE sso_login_states SET saml_request_id = $1 WHERE state_hash = $3 AND connection_id = $2', [key, connectionId, h ?? '']); return { value, createdAt: Date.now() }; },
    // the library reads the saved value back as the request's creation time (an ISO string)
    async getAsync(key) { const r = await one(`SELECT created_at FROM sso_login_states WHERE ${where} AND used_at IS NULL AND expires_at > now()`, [key, connectionId, h]); return r ? r.created_at.toISOString() : null; },
    async removeAsync(key) { await query(`UPDATE sso_login_states SET used_at = coalesce(used_at, now()) WHERE ${where}`, [key, connectionId, h]); return key; },
    async consumeAsync(key) { const r = await one(`UPDATE sso_login_states SET used_at = now() WHERE ${where} AND used_at IS NULL AND expires_at > now() RETURNING created_at`, [key, connectionId, h]); return r ? r.created_at.toISOString() : null; },
    async saveIfAbsentAsync(key, _value, expiresAtMs) {
      const r = await query('INSERT INTO sso_replay(connection_id, value_hash, expires_at) VALUES ($1,$2, to_timestamp($3)) ON CONFLICT DO NOTHING', [connectionId, sha256(`saml:${key}`), Math.max(expiresAtMs, Date.now() + 300_000) / 1000]);
      return r.rowCount === 1;
    },
  };
};

export function samlFor(conn, acsUrl, state = null) {
  const cfg = conn.config;
  const cache = cacheFor(conn.id, state);
  const responseSigned = cfg.require_signed === 'response';
  return new SAML({
    callbackUrl: acsUrl, entryPoint: cfg.sso_url, issuer: cfg.sp_entity_id, idpIssuer: cfg.idp_entity_id, audience: cfg.sp_entity_id,
    idpCert: trustedCerts(conn), wantAssertionsSigned: !responseSigned, wantAuthnResponseSigned: responseSigned,
    acceptedClockSkewMs: (conn.clock_skew_seconds ?? 60) * 1000, maxAssertionAgeMs: (cfg.max_assertion_age_seconds ?? 600) * 1000,
    validateInResponseTo: ValidateInResponseTo.always, cacheProvider: cache, rejectReplayedAssertions: true,
    disableRequestedAuthnContext: true, identifierFormat: cfg.name_id_format ?? null, signatureAlgorithm: 'sha256', digestAlgorithm: 'sha256',
  });
}

export async function beginSaml(conn, acsUrl, appRedirect, linkUserId = null) {
  const state = randomBytes(24).toString('base64url');
  await query("INSERT INTO sso_login_states(connection_id, state_hash, redirect_uri, link_user_id, expires_at) VALUES ($1,$2,$3,$4, now() + interval '10 minutes')", [conn.id, sha256(state), appRedirect, linkUserId]);
  const saml = samlFor(conn, acsUrl, state);
  const url = await saml.getAuthorizeUrlAsync(state, undefined, {});
  return { url, state };
}

const first = (v) => (Array.isArray(v) ? v[0] : v);
function attr(profile, names) { for (const n of names) { const v = first(profile[n]); if (typeof v === 'string' && v) return v; } return null; }

/** Validate the posted SAMLResponse and return { subject, email, groups, authnContext, assertionId, redirect }. Throws 401 on anything doubtful. */
export async function completeSaml(conn, acsUrl, { SAMLResponse, RelayState }) {
  const st = await one('SELECT redirect_uri, link_user_id, used_at, expires_at > now() AS live FROM sso_login_states WHERE state_hash = $1 AND connection_id = $2', [sha256(String(RelayState ?? '')), conn.id]);
  if (!st || st.used_at || !st.live) throw unauthorized('This sign-in link has expired or was already used. Please start again.');
  let profile;
  try { ({ profile } = await samlFor(conn, acsUrl, String(RelayState)).validatePostResponseAsync({ SAMLResponse, RelayState })); } catch (e) { throw Object.assign(unauthorized('Sign-in could not be verified.'), { cause: e }); }
  if (!profile?.nameID) throw unauthorized('Sign-in could not be verified.');
  const assertion = profile.getAssertion?.() ?? {};
  const ctx = assertion?.Assertion?.AuthnStatement?.[0]?.AuthnContext?.[0]?.AuthnContextClassRef?.[0];
  const authnContext = typeof ctx === 'string' ? ctx : ctx?._ ?? null;
  const claimName = conn.group_claim;
  const groups = readGroups({ [claimName]: profile[claimName] ?? profile[`http://schemas.xmlsoap.org/claims/${claimName}`] }, claimName);
  return { subject: profile.nameID, email: (attr(profile, EMAIL_ATTRS) ?? (/@/.test(profile.nameID) ? profile.nameID : null))?.toLowerCase() ?? null,
    name: attr(profile, ['displayName', 'name', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name']), groups, authnContext, assertionId: profile.ID ?? null, redirect: st.redirect_uri, linkUserId: st.link_user_id };
}

export const spMetadata = (conn, acsUrl) => samlFor(conn, acsUrl).generateServiceProviderMetadata(null, null);

/** Read an IdP's metadata XML: entityID, the HTTP-Redirect (else POST) SSO URL, and its signing certificates. No DTDs / external entities. */
export function parseIdpMetadata(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('metadata may not contain a DTD');
  const errors = [];
  const doc = new DOMParser({ onError: (_l, m) => errors.push(m) }).parseFromString(xml, 'text/xml');
  if (errors.length) throw new Error('metadata is not well-formed XML');
  const all = (el, name) => Array.from(el.getElementsByTagNameNS('*', name));
  const ed = all(doc, 'EntityDescriptor')[0];
  const idp = ed && all(ed, 'IDPSSODescriptor')[0];
  if (!idp) throw new Error('metadata has no IDPSSODescriptor');
  const svc = all(idp, 'SingleSignOnService');
  const pick = svc.find((s) => /HTTP-Redirect$/.test(s.getAttribute('Binding'))) ?? svc.find((s) => /HTTP-POST$/.test(s.getAttribute('Binding')));
  if (!pick) throw new Error('metadata lists no usable SingleSignOnService');
  const certs = all(idp, 'KeyDescriptor').filter((k) => !k.getAttribute('use') || k.getAttribute('use') === 'signing')
    .flatMap((k) => all(k, 'X509Certificate').map((c) => c.textContent.replace(/\s+/g, ''))).filter(Boolean);
  if (!certs.length) throw new Error('metadata lists no signing certificate');
  return { idp_entity_id: ed.getAttribute('entityID'), sso_url: pick.getAttribute('Location'), certs: [...new Set(certs)].map(pemOf) };
}
