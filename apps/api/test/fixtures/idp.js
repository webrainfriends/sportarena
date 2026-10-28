// Local identity providers for the enterprise-identity tests: an OIDC IdP (real RS256 keys, discovery, JWKS, token endpoint) and a SAML IdP
// (self-signed certificate; responses signed with xml-crypto). Nothing here talks to the network: `transport.fetch` is pointed at the OIDC fixture.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { SignedXml } from 'xml-crypto';

export const b64u = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

export async function oidcIdp({ issuer = 'https://idp.acme-school.example', clientId = 'gotmygame-client', secret = 'client-secret-value' } = {}) {
  const keys = new Map();
  const addKey = async (kid) => { const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true }); keys.set(kid, { privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' } }); };
  await addKey('k1');
  const idp = {
    issuer, clientId, secret, keys, addKey, nonce: null, claims: {}, tokenCalls: 0, signWith: 'k1', mutate: null,
    jwksDoc: () => ({ keys: [...keys.values()].map((k) => k.jwk) }),
    removeKey: (kid) => keys.delete(kid),
    async idToken(extra = {}, { kid = idp.signWith } = {}) {
      const now = Math.floor(Date.now() / 1000);
      const claims = { sub: 'idp-sub-1', email: 'teacher@acme-school.example', email_verified: true, name: 'Asha Teacher', nonce: idp.nonce, ...idp.claims, ...extra };
      return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid }).setIssuer(claims.iss ?? issuer).setAudience(claims.aud ?? clientId).setIssuedAt(claims.iat ?? now).setExpirationTime(claims.exp ?? now + 300).sign(keys.get(kid).privateKey);
    },
    /** point transport.fetch here */
    async fetch({ url, method = 'GET' }) {
      if (url === `${issuer}/.well-known/openid-configuration`) return ok({ issuer: idp.discoveryIssuer ?? issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
      if (url === `${issuer}/jwks`) return ok(idp.jwksDoc());
      if (url === `${issuer}/token` && method === 'POST') { idp.tokenCalls++; return ok({ access_token: 'x', token_type: 'Bearer', id_token: idp.mutate ? await idp.mutate() : await idp.idToken() }); }
      return { status: 404, headers: {}, text: 'no' };
    },
  };
  return idp;
}
const ok = (o) => ({ status: 200, headers: {}, text: JSON.stringify(o) });

export function selfSigned(cn = 'idp.test') {
  const dir = mkdtempSync(join(tmpdir(), 'saml-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-subj', `/CN=${cn}`, '-days', '30'], { stdio: 'ignore' });
  return { key: readFileSync(join(dir, 'k.pem'), 'utf8'), cert: readFileSync(join(dir, 'c.pem'), 'utf8') };
}

const iso = (ms) => new Date(ms).toISOString();
/** Read the AuthnRequest id out of the redirect URL start_sso returned. */
export function requestIdOf(url) {
  const xml = inflateRawSync(Buffer.from(new URL(url).searchParams.get('SAMLRequest'), 'base64')).toString();
  return /ID="([^"]+)"/.exec(xml)[1];
}
export const relayOf = (url) => new URL(url).searchParams.get('RelayState');

/** A SAML Response whose assertion is signed with `signer.key`. Options let a test break exactly one thing. */
export function samlResponse({ signer, acs, sp, idpEntity = 'https://idp.acme-school.example/saml', inResponseTo, subject = 'saml-subj-1', email = 'teacher@acme-school.example', groups = [], audience = sp,
  notBefore = Date.now() - 60_000, notOnOrAfter = Date.now() + 300_000, assertionId = `_a${Math.random().toString(16).slice(2)}`, sign = true, authnContext = 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport' }) {
  const attrs = `<saml:Attribute Name="email"><saml:AttributeValue>${email}</saml:AttributeValue></saml:Attribute>${groups.length ? `<saml:Attribute Name="groups">${groups.map((g) => `<saml:AttributeValue>${g}</saml:AttributeValue>`).join('')}</saml:Attribute>` : ''}`;
  let xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${Math.random().toString(16).slice(2)}" Version="2.0" IssueInstant="${iso(Date.now())}" Destination="${acs}" InResponseTo="${inResponseTo}">`
    + `<saml:Issuer>${idpEntity}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>`
    + `<saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${iso(Date.now())}"><saml:Issuer>${idpEntity}</saml:Issuer>`
    + `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">${subject}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${iso(notOnOrAfter)}" Recipient="${acs}" InResponseTo="${inResponseTo}"/></saml:SubjectConfirmation></saml:Subject>`
    + `<saml:Conditions NotBefore="${iso(notBefore)}" NotOnOrAfter="${iso(notOnOrAfter)}"><saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>`
    + `<saml:AuthnStatement AuthnInstant="${iso(Date.now())}" SessionIndex="_s1"><saml:AuthnContext><saml:AuthnContextClassRef>${authnContext}</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>`
    + `<saml:AttributeStatement>${attrs}</saml:AttributeStatement></saml:Assertion></samlp:Response>`;
  if (sign) {
    const sig = new SignedXml({ privateKey: signer.key, publicCert: signer.cert, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' });
    sig.addReference({ xpath: "//*[local-name(.)='Assertion']", digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256', transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'] });
    sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after' } });
    xml = sig.getSignedXml();
  }
  return Buffer.from(xml).toString('base64');
}
