// Enterprise identity & provisioning (#521): an organisation's own IdP (OIDC / SAML) and directory (SCIM) manage who holds a role in
// that organisation. One canonical person (users); the organisation only ever adds, changes or ends its own membership row.
// Everything is one definition -> REST + OpenAPI + MCP. The SAML ACS POST and the SCIM endpoints are protocol routes (identity/sso-routes.js,
// identity/scim.js) that call the same functions; configuration, status, reports and the app's sign-in calls are all capabilities.
import { X509Certificate, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, query, tx } from '../db.js';
import { config } from '../config.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../errors.js';
import { encrypt, sha256 } from '../crypto.js';
import { audit } from '../helpers.js';
import { orgFor } from '../org-access.js';
import { revokeUserSessions } from '../sessions.js';
import { addClaim, checkClaim, TXT_HOST, TXT_VALUE } from '../identity/domains.js';
import { PROVISIONABLE, NEVER_PROVISIONED, rejectedCeilingRoles, clampCeiling, readGroups, mfaSignal } from '../identity/policy.js';
import { assertPublicHttpsUrl } from '../identity/safe-http.js';
import { beginOidc, completeOidc, discover, forgetJwks, testOidc } from '../identity/oidc.js';
import { beginSaml, normalisePem, parseIdpMetadata, trustedCerts } from '../identity/saml.js';
import { confirmLink, discoverByEmail, finishSso, loadConnection, logEvent } from '../identity/sso.js';

const TAG = 'Enterprise identity';
const OWNER = ['owner'];
const VIEW = ['owner', 'admin'];

export const acsUrl = (connId) => `${config.apiPublicUrl}/api/v1/auth/sso/${connId}/saml/acs`;
export const spEntityId = (connId) => `${config.apiPublicUrl}/api/v1/auth/sso/${connId}/saml/metadata`;
export const allowedRedirect = (uri) => config.ssoRedirectUris.includes(uri) || (!config.isProd && /^http:\/\/localhost(:\d+)?\/sso\/callback$/.test(uri));

/** What a connection looks like to the people who manage it: everything except secrets. */
export const publicConnection = (c) => c && ({
  id: c.id, organisation_id: c.organisation_id, name: c.name, protocol: c.protocol, status: c.status, allowed_roles: c.allowed_roles, default_role: c.default_role, group_claim: c.group_claim,
  jit_enabled: c.jit_enabled, require_mfa_signal: c.require_mfa_signal, session_hours: c.session_hours, local_login: c.local_login, break_glass_user_ids: c.break_glass_user_ids,
  clock_skew_seconds: c.clock_skew_seconds, tested_at: c.tested_at, test_ok: c.test_ok, test_detail: c.test_detail, created_at: c.created_at, updated_at: c.updated_at,
  client_secret_set: Boolean(c.client_secret_enc),
  config: Object.fromEntries(Object.entries(c.config).filter(([k]) => !/secret|private/i.test(k))),
  certificates: (c.idp_certs ?? []).map((x) => { try { const x5 = new X509Certificate(x.pem); return { fingerprint: x5.fingerprint256, valid_to: x5.validTo, retire_after: x.retire_after ?? null }; } catch { return { fingerprint: null, valid_to: null, retire_after: x.retire_after ?? null }; } }),
  service_provider: c.protocol === 'saml' ? { entity_id: spEntityId(c.id), acs_url: acsUrl(c.id), metadata_url: spEntityId(c.id) } : { redirect_uris: config.ssoRedirectUris },
});
const connOf = async (orgId) => one("SELECT * FROM org_sso_connections WHERE organisation_id = $1 AND status <> 'disabled'", [orgId]);

// ------------------------------------------------------------------ domain claim
const claimOut = (d) => ({ id: d.id, domain: d.domain, status: d.status, verified_at: d.verified_at, last_checked_at: d.last_checked_at, created_at: d.created_at,
  ...(d.status === 'pending' ? { dns_record: { type: 'TXT', host: TXT_HOST(d.domain), value: TXT_VALUE(d.token) } } : {}) });

cap({
  name: 'list_org_domain_claims', method: 'GET', path: '/organisations/:id/identity/domains', tag: TAG,
  summary: 'Owners and admins: the email domains this organisation has claimed, with the DNS TXT record to publish for pending ones. A verified domain lets SSO and provisioning accept addresses on it; it never grants a role.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await orgFor(user, i.id, VIEW);
    return (await many("SELECT * FROM org_domain_claims WHERE organisation_id = $1 AND status <> 'revoked' ORDER BY created_at", [i.id])).map(claimOut);
  },
});
cap({
  name: 'claim_org_domain', method: 'POST', path: '/organisations/:id/identity/domains', tag: TAG, status: 201,
  summary: 'Owner: start proving control of an email domain (e.g. school.edu.in). Publish the returned DNS TXT record, then call verify_org_domain. Free mail providers cannot be claimed.',
  input: z.object({ id, domain: z.string().trim().min(4).max(120) }),
  async handler({ user }, i) {
    await orgFor(user, i.id, OWNER, { write: true });
    const d = await addClaim(i.id, i.domain, user.id);
    await logEvent(null, { orgId: i.id, actorId: user.id, event: 'domain_claimed', detail: { domain: d.domain } });
    return claimOut(d);
  },
});
cap({
  name: 'verify_org_domain', method: 'POST', path: '/organisations/:id/identity/domains/:claim_id/verify', tag: TAG,
  summary: 'Owner: check the DNS TXT record for a pending domain claim now. The first organisation to prove control of a domain holds it.',
  input: z.object({ id, claim_id: id }),
  async handler({ user }, i) {
    await orgFor(user, i.id, OWNER, { write: true });
    const claim = await one("SELECT * FROM org_domain_claims WHERE id = $1 AND organisation_id = $2 AND status <> 'revoked'", [i.claim_id, i.id]);
    if (!claim) throw notFound('Domain claim');
    const r = await checkClaim(claim);
    await logEvent(null, { orgId: i.id, actorId: user.id, event: 'domain_verify', outcome: r.status === 'verified' ? 'ok' : 'denied', reason: r.status === 'verified' ? null : 'txt_not_found', detail: { domain: claim.domain } });
    return claimOut(r);
  },
});
cap({
  name: 'revoke_org_domain', method: 'DELETE', path: '/organisations/:id/identity/domains/:claim_id', tag: TAG,
  summary: 'Owner: release a claimed domain (kept as history). SSO sign-ins for addresses on it stop being accepted; existing memberships are not changed.',
  input: z.object({ id, claim_id: id }),
  async handler({ user }, i) {
    await orgFor(user, i.id, OWNER, { write: true });
    const r = await one("UPDATE org_domain_claims SET status = 'revoked', revoked_at = now() WHERE id = $1 AND organisation_id = $2 AND status <> 'revoked' RETURNING domain", [i.claim_id, i.id]);
    if (!r) throw notFound('Domain claim');
    await logEvent(null, { orgId: i.id, actorId: user.id, event: 'domain_released', detail: { domain: r.domain } });
    return { ok: true };
  },
});

// ------------------------------------------------------------------ connection
const oidcIn = z.object({
  issuer: z.string().trim().max(300), client_id: z.string().trim().min(1).max(300),
  client_secret: z.string().min(1).max(500).optional().describe('write-only: stored encrypted, never returned'),
  scopes: z.string().trim().max(200).optional(), token_auth: z.enum(['post', 'basic']).optional(),
});
const samlIn = z.object({
  idp_metadata_xml: z.string().max(400_000).optional().describe('the IdP metadata XML; fills entity id, SSO URL and signing certificates'),
  idp_entity_id: z.string().trim().max(500).optional(), sso_url: z.string().trim().max(500).optional(),
  certificates: z.array(z.object({ pem: z.string().max(10_000), retire_after: z.string().datetime().optional().describe('keep trusting this certificate until then (rotation overlap)') })).max(6).optional()
    .describe('IdP signing certificates; list the old and the new one together while rotating'),
  require_signed: z.enum(['assertion', 'response']).optional().describe('which element the IdP signs (default: assertion)'),
  name_id_format: z.string().trim().max(200).optional(),
});

cap({
  name: 'get_org_sso', method: 'GET', path: '/organisations/:id/identity/sso', tag: TAG,
  summary: 'Owners and admins: the organisation\'s SSO connection (no secrets), group mappings, SCIM credentials (no secret values), verified domains and the role ceiling choices. The values the IdP needs (ACS URL, entity id, redirect URIs, SCIM base URL) are included.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await orgFor(user, i.id, VIEW);
    const conn = await connOf(i.id);
    return {
      connection: publicConnection(conn),
      provisionable_roles: PROVISIONABLE, never_provisioned_roles: NEVER_PROVISIONED,
      mappings: conn ? await many('SELECT id, group_value, effect, org_role, created_at FROM org_sso_group_mappings WHERE connection_id = $1 AND removed_at IS NULL ORDER BY group_value', [conn.id]) : [],
      scim: { base_url: `${config.apiPublicUrl}/api/v1/scim/v2`, tokens: conn ? await many('SELECT id, name, created_at, expires_at, last_used_at, revoked_at FROM scim_tokens WHERE connection_id = $1 ORDER BY created_at DESC', [conn.id]) : [] },
      domains: (await many("SELECT * FROM org_domain_claims WHERE organisation_id = $1 AND status <> 'revoked' ORDER BY created_at", [i.id])).map(claimOut),
    };
  },
});

cap({
  name: 'save_org_sso', method: 'POST', path: '/organisations/:id/identity/sso', tag: TAG,
  summary: 'Owner: create or update the SSO connection (OIDC or SAML 2.0). The provider is read and validated when saved; a changed issuer, client or SSO URL returns the connection to draft until it is tested again, while adding a certificate or rotating a secret keeps it live. roles can only come from allowed_roles (never owner or legal); local_login=sso_required needs at least one break-glass owner/admin.',
  input: z.object({
    id, name: z.string().trim().min(2).max(80), protocol: z.enum(['oidc', 'saml']), oidc: oidcIn.optional(), saml: samlIn.optional(),
    allowed_roles: z.array(z.string()).max(10).default([]).describe('role ceiling: the only roles any mapping or the default may grant'),
    default_role: z.string().nullable().optional().describe('role for signed-in people who match no group; null = no access without a mapping'),
    group_claim: z.string().trim().min(1).max(100).default('groups'), jit_enabled: z.boolean().default(false),
    require_mfa_signal: z.boolean().default(false).describe('refuse sign-ins where the IdP did not assert multi-factor authentication (a signal, not device compliance)'),
    session_hours: z.number().int().min(1).max(720).nullable().optional().describe('hard session length for sign-ins through this connection'),
    local_login: z.enum(['allowed', 'sso_required']).default('allowed'), clock_skew_seconds: z.number().int().min(0).max(300).default(60),
    break_glass_user_ids: z.array(id).max(2).default([]),
  }),
  async handler({ user }, i) {
    await orgFor(user, i.id, OWNER, { write: true });
    const bad = rejectedCeilingRoles(i.allowed_roles);
    if (bad.length) throw badRequest(`These roles cannot be provisioned by a directory: ${bad.join(', ')}`);
    const allowed = clampCeiling(i.allowed_roles);
    if (i.default_role && !allowed.includes(i.default_role)) throw badRequest('default_role must be inside allowed_roles');
    if (i.local_login === 'sso_required' && !i.break_glass_user_ids.length) throw badRequest('Choose at least one break-glass owner or admin before requiring SSO');
    for (const u of i.break_glass_user_ids) {
      if (!(await one("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active' AND role IN ('owner','admin')", [i.id, u]))) throw badRequest('Break-glass people must be active owners or admins of this organisation');
    }
    const cur = await connOf(i.id);
    if (cur && cur.protocol !== i.protocol) throw conflict('Disable this connection before switching protocol');
    const connId = cur?.id ?? randomUUID();
    let config_ = { ...(cur?.config ?? {}) }; let certs = cur?.idp_certs ?? []; let secretEnc = cur?.client_secret_enc ?? null;
    if (i.protocol === 'oidc') {
      if (!i.oidc) throw badRequest('oidc settings are required');
      let d; try { d = await discover(i.oidc.issuer); } catch (e) { throw badRequest(`Could not read the provider's OpenID configuration: ${String(e.message).slice(0, 160)}`); }
      config_ = { ...config_, issuer: d.issuer, authorization_endpoint: d.authorization_endpoint, token_endpoint: d.token_endpoint, jwks_uri: d.jwks_uri, client_id: i.oidc.client_id, scopes: i.oidc.scopes ?? config_.scopes, token_auth: i.oidc.token_auth ?? config_.token_auth };
      if (i.oidc.client_secret) secretEnc = encrypt(i.oidc.client_secret, 'org_sso_connections.client_secret');
    } else {
      if (!i.saml) throw badRequest('saml settings are required');
      let fromMeta = {};
      if (i.saml.idp_metadata_xml) { try { fromMeta = parseIdpMetadata(i.saml.idp_metadata_xml); } catch (e) { throw badRequest(`Could not read the IdP metadata: ${e.message}`); } }
      const sso_url = i.saml.sso_url ?? fromMeta.sso_url ?? config_.sso_url;
      if (!sso_url) throw badRequest('The IdP sign-in URL is required');
      assertPublicHttpsUrl(sso_url, 'The IdP sign-in URL');
      const idp_entity_id = i.saml.idp_entity_id ?? fromMeta.idp_entity_id ?? config_.idp_entity_id;
      if (!idp_entity_id) throw badRequest('The IdP entity id is required');
      const incoming = i.saml.certificates ?? (fromMeta.certs ?? []).map((pem) => ({ pem }));
      if (incoming.length) {
        const next = [];
        for (const c of incoming) {
          let x; try { x = new X509Certificate(normalisePem(c.pem)); } catch { throw badRequest('A certificate could not be read (expected PEM / base64 X.509)'); }
          if (new Date(x.validTo).getTime() < Date.now() && !c.retire_after) throw badRequest('A certificate has already expired');
          next.push({ pem: normalisePem(c.pem), ...(c.retire_after ? { retire_after: c.retire_after } : {}) });
        }
        certs = next;
      }
      if (!certs.length) throw badRequest('At least one IdP signing certificate is required');
      config_ = { ...config_, sso_url, idp_entity_id, sp_entity_id: spEntityId(connId), require_signed: i.saml.require_signed ?? config_.require_signed ?? 'assertion', name_id_format: i.saml.name_id_format ?? config_.name_id_format };
    }
    // anything that changes who we trust sends a live connection back to draft; certificate / secret rotation does not
    const trustKeys = i.protocol === 'oidc' ? ['issuer', 'client_id'] : ['sso_url', 'idp_entity_id'];
    const trustChanged = !cur || trustKeys.some((k) => cur.config?.[k] !== config_[k]);
    const row = await tx(async (c) => {
      if (!cur) {
        return (await c.query(
          `INSERT INTO org_sso_connections(id, organisation_id, name, protocol, config, client_secret_enc, idp_certs, allowed_roles, default_role, group_claim, jit_enabled, require_mfa_signal, session_hours, local_login, clock_skew_seconds, break_glass_user_ids, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
          [connId, i.id, i.name, i.protocol, config_, secretEnc, JSON.stringify(certs), allowed, i.default_role ?? null, i.group_claim, i.jit_enabled, i.require_mfa_signal, i.session_hours ?? null, i.local_login, i.clock_skew_seconds, i.break_glass_user_ids, user.id])).rows[0];
      }
      return (await c.query(
        `UPDATE org_sso_connections SET name=$2, config=$3, client_secret_enc=$4, idp_certs=$5, allowed_roles=$6, default_role=$7, group_claim=$8, jit_enabled=$9, require_mfa_signal=$10, session_hours=$11, local_login=$12,
                clock_skew_seconds=$13, break_glass_user_ids=$14, updated_at=now(),
                status = CASE WHEN $15 AND status = 'active' THEN 'draft' ELSE status END, test_ok = CASE WHEN $15 THEN NULL ELSE test_ok END, tested_at = CASE WHEN $15 THEN NULL ELSE tested_at END
          WHERE id=$1 RETURNING *`,
        [cur.id, i.name, config_, secretEnc, JSON.stringify(certs), allowed, i.default_role ?? null, i.group_claim, i.jit_enabled, i.require_mfa_signal, i.session_hours ?? null, i.local_login, i.clock_skew_seconds, i.break_glass_user_ids, trustChanged])).rows[0];
    });
    // never log the secret or certificate bodies, only what kind of change this was
    await logEvent(null, { orgId: i.id, connId: row.id, actorId: user.id, event: cur ? 'connection_updated' : 'connection_created', detail: { protocol: i.protocol, trust_changed: trustChanged, secret_changed: Boolean(i.oidc?.client_secret), local_login: i.local_login, jit: i.jit_enabled } });
    forgetJwks(config_.jwks_uri);
    return publicConnection(row);
  },
});

cap({
  name: 'test_org_sso', method: 'POST', path: '/organisations/:id/identity/sso/test', tag: TAG,
  summary: 'Owner: check the connection without signing anyone in. OIDC: the discovery document still matches and the signing keys load (the stored endpoints are refreshed). SAML: the sign-in URL is public https and at least one trusted certificate is currently valid. Records the result; a connection can only go live after a passing test.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await orgFor(user, i.id, OWNER, { write: true });
    const conn = await connOf(i.id);
    if (!conn) throw notFound('SSO connection');
    let ok = true, detail;
    try {
      if (conn.protocol === 'oidc') {
        const d = await discover(conn.config.issuer);
        await query('UPDATE org_sso_connections SET config = config || $2::jsonb WHERE id = $1', [conn.id, JSON.stringify({ authorization_endpoint: d.authorization_endpoint, token_endpoint: d.token_endpoint, jwks_uri: d.jwks_uri })]);
        forgetJwks(conn.config.jwks_uri);
        detail = await testOidc({ ...conn, config: { ...conn.config, ...d } });
      } else {
        assertPublicHttpsUrl(conn.config.sso_url, 'The IdP sign-in URL');
        const live = trustedCerts(conn).filter((p) => new Date(new X509Certificate(p).validTo).getTime() > Date.now());
        if (!live.length) throw new Error('no trusted certificate is currently valid');
        detail = `${live.length} valid signing certificate(s); sign-in URL is public https.`;
      }
    } catch (e) { ok = false; detail = String(e.message).slice(0, 300); }
    await query('UPDATE org_sso_connections SET tested_at = now(), test_ok = $2, test_detail = $3 WHERE id = $1', [conn.id, ok, detail]);
    await logEvent(null, { orgId: i.id, connId: conn.id, actorId: user.id, event: 'connection_test', outcome: ok ? 'ok' : 'error', reason: ok ? null : detail });
    return { ok, detail };
  },
});

cap({
  name: 'set_org_sso_status', method: 'POST', path: '/organisations/:id/identity/sso/status', tag: TAG,
  summary: 'Owner: turn the connection on (needs a passing test and a verified domain) or off. Turning it off stops new SSO sign-ins; revoke_sessions also ends the sessions it opened. Memberships are kept; deprovisioning is a separate act.',
  input: z.object({ id, status: z.enum(['active', 'draft', 'disabled']), revoke_sessions: z.boolean().default(false) }),
  async handler({ user }, i) {
    await orgFor(user, i.id, OWNER, { write: true });
    const conn = await connOf(i.id);
    if (!conn) throw notFound('SSO connection');
    if (i.status === 'active') {
      if (!conn.test_ok) throw conflict('Run a passing connection test before turning SSO on');
      if (!(await one("SELECT 1 FROM org_domain_claims WHERE organisation_id = $1 AND status = 'verified'", [i.id]))) throw conflict('Verify an email domain before turning SSO on');
    }
    const row = await one('UPDATE org_sso_connections SET status = $2, updated_at = now(), disabled_at = CASE WHEN $2 = \'disabled\' THEN now() END WHERE id = $1 RETURNING *', [conn.id, i.status]);
    let revoked = 0;
    if (i.revoke_sessions && i.status !== 'active') {
      revoked = (await query("UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'sso_disabled' WHERE sso_connection_id = $1 AND revoked_at IS NULL", [conn.id])).rowCount;
    }
    await logEvent(null, { orgId: i.id, connId: conn.id, actorId: user.id, event: `connection_${i.status}`, detail: { sessions_revoked: revoked } });
    return { ...publicConnection(row), sessions_revoked: revoked };
  },
});

cap({
  name: 'set_org_sso_mapping', method: 'POST', path: '/organisations/:id/identity/sso/mappings', tag: TAG, status: 201,
  summary: 'Owner: map an IdP group / claim value (also the name of a SCIM group) to an organisation role, or deny it. A deny always wins; a role outside the connection\'s allowed_roles is refused. Mappings can never grant owner, legal, a platform role, or any guardian / youth-consent relationship.',
  input: z.object({ id, group_value: z.string().trim().min(1).max(200), effect: z.enum(['allow', 'deny']), org_role: z.string().optional() }),
  async handler({ user }, i) {
    await orgFor(user, i.id, OWNER, { write: true });
    const conn = await connOf(i.id);
    if (!conn) throw notFound('SSO connection');
    if (i.effect === 'allow') {
      if (!i.org_role) throw badRequest('org_role is required for an allow mapping');
      if (!conn.allowed_roles.includes(i.org_role)) throw badRequest(NEVER_PROVISIONED.includes(i.org_role) ? `${i.org_role} can never be granted by a directory` : 'That role is outside this connection\'s allowed roles');
    } else if (i.org_role) throw badRequest('A deny mapping has no role');
    const row = await tx(async (c) => {
      await c.query('UPDATE org_sso_group_mappings SET removed_at = now() WHERE connection_id = $1 AND lower(group_value) = lower($2) AND removed_at IS NULL', [conn.id, i.group_value]);
      return (await c.query('INSERT INTO org_sso_group_mappings(connection_id, group_value, effect, org_role, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, group_value, effect, org_role', [conn.id, i.group_value, i.effect, i.effect === 'allow' ? i.org_role : null, user.id])).rows[0];
    });
    await logEvent(null, { orgId: i.id, connId: conn.id, actorId: user.id, event: 'mapping_set', detail: { group: i.group_value, effect: i.effect, role: i.org_role ?? null } });
    return row;
  },
});
cap({
  name: 'remove_org_sso_mapping', method: 'DELETE', path: '/organisations/:id/identity/sso/mappings/:mapping_id', tag: TAG,
  summary: 'Owner: remove a group mapping (kept as history). People already provisioned keep their role until their next sign-in or directory change re-evaluates it.',
  input: z.object({ id, mapping_id: id }),
  async handler({ user }, i) {
    await orgFor(user, i.id, OWNER, { write: true });
    const r = await one('UPDATE org_sso_group_mappings m SET removed_at = now() FROM org_sso_connections c WHERE m.id = $1 AND c.id = m.connection_id AND c.organisation_id = $2 AND m.removed_at IS NULL RETURNING m.group_value', [i.mapping_id, i.id]);
    if (!r) throw notFound('Mapping');
    await logEvent(null, { orgId: i.id, actorId: user.id, event: 'mapping_removed', detail: { group: r.group_value } });
    return { ok: true };
  },
});

// ------------------------------------------------------------------ SCIM credentials (service identities)
cap({
  name: 'create_org_scim_token', method: 'POST', path: '/organisations/:id/identity/scim-tokens', tag: TAG, status: 201,
  summary: 'Owner: create a SCIM credential for the organisation\'s directory. It can only call this organisation\'s SCIM endpoints, is independent of any person\'s login or API token, and is shown once. Revoke it any time.',
  input: z.object({ id, name: z.string().trim().min(2).max(80), expires_in_days: z.number().int().min(1).max(730).optional() }),
  async handler({ user }, i) {
    await orgFor(user, i.id, OWNER, { write: true });
    const conn = await connOf(i.id);
    if (!conn) throw notFound('SSO connection');
    const secret = 'scim_' + randomBytes(32).toString('base64url');
    const row = await one('INSERT INTO scim_tokens(organisation_id, connection_id, name, token_hash, created_by, expires_at) VALUES ($1,$2,$3,$4,$5, CASE WHEN $6::int IS NULL THEN NULL ELSE now() + make_interval(days => $6) END) RETURNING id, name, created_at, expires_at',
      [i.id, conn.id, i.name, sha256(secret), user.id, i.expires_in_days ?? null]);
    await logEvent(null, { orgId: i.id, connId: conn.id, actorId: user.id, event: 'scim_token_created', detail: { token: row.id } });
    return { ...row, token: secret, base_url: `${config.apiPublicUrl}/api/v1/scim/v2`, note: 'Copy this token now; it cannot be shown again.' };
  },
});
cap({
  name: 'revoke_org_scim_token', method: 'DELETE', path: '/organisations/:id/identity/scim-tokens/:token_id', tag: TAG,
  summary: 'Owner: revoke a SCIM credential immediately. Nothing about people, sessions or memberships changes.',
  input: z.object({ id, token_id: id }),
  async handler({ user }, i) {
    await orgFor(user, i.id, OWNER, { write: true });
    const r = await one('UPDATE scim_tokens SET revoked_at = now() WHERE id = $1 AND organisation_id = $2 AND revoked_at IS NULL RETURNING id', [i.token_id, i.id]);
    if (!r) throw notFound('SCIM token');
    await logEvent(null, { orgId: i.id, actorId: user.id, event: 'scim_token_revoked', detail: { token: r.id } });
    return { ok: true };
  },
});

// ------------------------------------------------------------------ reports
export async function accessReview(orgId, { limit = 100, offset = 0 } = {}) {
  return many(
    `SELECT u.id AS user_id, u.handle, u.display_name, m.role, m.status, m.source, m.joined_at, m.left_at, m.deprovisioned_at,
            i.last_login_at AS last_sso_login_at, i.mfa_signal_at, s.last_seen_at,
            EXISTS (SELECT 1 FROM user_mfa f WHERE f.user_id = u.id AND f.enabled_at IS NOT NULL AND f.disabled_at IS NULL) AS local_mfa,
            su.active AS directory_active
       FROM organisation_members m JOIN users u ON u.id = m.user_id
       LEFT JOIN org_sso_connections c ON c.organisation_id = m.organisation_id AND c.status <> 'disabled'
       LEFT JOIN org_sso_identities i ON i.connection_id = c.id AND i.user_id = u.id AND i.status = 'active'
       LEFT JOIN scim_users su ON su.organisation_id = m.organisation_id AND su.user_id = u.id
       LEFT JOIN LATERAL (SELECT max(last_seen_at) AS last_seen_at FROM auth_sessions WHERE user_id = u.id) s ON true
      WHERE m.organisation_id = $1 AND m.status IN ('active','invited') ORDER BY m.role, u.display_name LIMIT $2 OFFSET $3`, [orgId, limit, offset]);
}
cap({
  name: 'get_org_access_review', method: 'GET', path: '/organisations/:id/identity/access-review', tag: TAG,
  summary: 'Owners and admins: who holds access to this organisation, how they got it (manual, SSO group mapping, SCIM), their role, last SSO sign-in, last activity, whether the directory still lists them as active, and any stale or orphaned access. Audit-logged; export the same view as CSV with export_org_data section access_review.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    await orgFor(user, i.id, VIEW);
    const rows = await accessReview(i.id, i);
    await audit(null, user.id, 'access_review', 'organisations', i.id);
    return rows.map((r) => ({ ...r, flags: [r.directory_active === false ? 'directory_inactive' : null, !r.last_seen_at || Date.parse(r.last_seen_at) < Date.now() - 90 * 864e5 ? 'inactive_90_days' : null].filter(Boolean) }));
  },
});
cap({
  name: 'list_org_identity_events', method: 'GET', path: '/organisations/:id/identity/events', tag: TAG,
  summary: 'Owners and admins: the identity decision log - connection changes, logins and their source, role mappings, provisioning / deprovisioning and refused sign-ins with the reason. Never contains assertions, tokens or secrets.',
  input: z.object({ id, outcome: z.enum(['ok', 'denied', 'error']).optional(), ...page }),
  async handler({ user }, i) {
    await orgFor(user, i.id, VIEW);
    return many(
      `SELECT e.id, e.event, e.outcome, e.reason, e.detail, e.at, e.user_id, u.display_name AS person, a.display_name AS actor
         FROM sso_events e LEFT JOIN users u ON u.id = e.user_id LEFT JOIN users a ON a.id = e.actor_id
        WHERE e.organisation_id = $1 AND ($2::text IS NULL OR e.outcome = $2) ORDER BY e.id DESC LIMIT $3 OFFSET $4`, [i.id, i.outcome ?? null, i.limit, i.offset]);
  },
});
// ------------------------------------------------------------------ sign-in (public)
cap({
  name: 'discover_sso', method: 'POST', path: '/auth/sso/discover', tag: TAG, auth: 'public',
  summary: 'Does this email belong to an organisation that offers single sign-on? Answers only for domains the organisation has verified; returns the connection to start, or sso=false.',
  input: z.object({ email: z.string().email() }),
  async handler(_, i) {
    const c = await discoverByEmail(i.email);
    return c ? { sso: true, connection_id: c.id, organisation_name: c.organisation_name, protocol: c.protocol, name: c.name } : { sso: false };
  },
});
cap({
  name: 'start_sso', method: 'POST', path: '/auth/sso/:connection_id/start', tag: TAG, auth: 'public',
  summary: 'Begin an organisation sign-in. Returns the IdP URL to open. After the IdP, the app calls complete_sso with the state and code (OIDC) or the ticket the SAML ACS handed back. redirect_uri must be one of the app\'s registered callback URLs.',
  input: z.object({ connection_id: id, redirect_uri: z.string().max(300) }),
  async handler(_, i) {
    const conn = await loadConnection(i.connection_id);
    if (!conn || conn.status !== 'active' || conn.org_status !== 'active') throw notFound('SSO connection');
    if (!allowedRedirect(i.redirect_uri)) throw badRequest('redirect_uri is not registered');
    return beginLogin(conn, i.redirect_uri, null);
  },
});
async function beginLogin(conn, redirectUri, linkUserId) {
  const out = conn.protocol === 'oidc' ? await beginOidc(conn, redirectUri, linkUserId) : await beginSaml(conn, acsUrl(conn.id), redirectUri, linkUserId);
  await logEvent(null, { orgId: conn.organisation_id, connId: conn.id, userId: linkUserId, event: linkUserId ? 'link_started' : 'login_started', detail: { protocol: conn.protocol } });
  return { url: out.url, state: out.state, protocol: conn.protocol };
}
cap({
  name: 'start_sso_link', method: 'POST', path: '/me/sso/:connection_id/start', tag: TAG,
  summary: 'Signed in: add another organisation\'s single sign-on to your own account (a person can belong to several organisations, each with its own IdP and address). Same as start_sso, but the result is linked to the account you are signed in with - it never creates or merges another account. Finish with complete_sso.',
  input: z.object({ connection_id: id, redirect_uri: z.string().max(300) }),
  async handler({ user }, i) {
    if (user.security?.mfa_enabled && !user.security.mfa_verified) throw forbidden('Finish two-step verification first.');
    const conn = await loadConnection(i.connection_id);
    if (!conn || conn.status !== 'active' || conn.org_status !== 'active') throw notFound('SSO connection');
    if (!allowedRedirect(i.redirect_uri)) throw badRequest('redirect_uri is not registered');
    return beginLogin(conn, i.redirect_uri, user.id);
  },
});

/** Turn a verified protocol result into the common identity finishSso understands. */
export function oidcIdentity(conn, claims) {
  const groups = readGroups(claims, conn.group_claim);
  return { subject: claims.sub, email: claims.email, emailVerified: claims.email_verified === true || claims.email_verified === 'true', name: claims.name, groups, mfa: mfaSignal({ amr: claims.amr, acr: claims.acr }) };
}
cap({
  name: 'complete_sso', method: 'POST', path: '/auth/sso/complete', tag: TAG, auth: 'public',
  summary: 'Finish an organisation sign-in. OIDC: send state and code from the callback. SAML: send the single-use ticket from the ACS redirect. Returns the same session as login (or mfa_required + mfa_token), or link_required + link_token when the email matches an existing account (confirm with confirm_sso_link while signed in to it). Nothing is ever merged automatically.',
  input: z.object({ state: z.string().max(200).optional(), code: z.string().max(2000).optional(), ticket: z.string().max(200).optional(), connection_id: id.optional() }),
  async handler({ meta }, i) {
    if (i.ticket) {
      const t = await one('UPDATE sso_tickets SET used_at = now() WHERE ticket_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING connection_id, claims', [sha256(i.ticket)]);
      if (!t) throw unauthorized('This sign-in has expired or was already used. Please start again.');
      return finishSso(await loadConnection(t.connection_id), t.claims, meta);
    }
    if (!i.state || !i.code || !i.connection_id) throw badRequest('state, code and connection_id are required');
    const conn = await loadConnection(i.connection_id);
    if (!conn || conn.protocol !== 'oidc') throw notFound('SSO connection');
    let done;
    try { done = await completeOidc(conn, { state: i.state, code: i.code }); }
    catch (e) { await logEvent(null, { orgId: conn.organisation_id, connId: conn.id, event: 'login', outcome: 'denied', reason: 'token_invalid' }); throw e; }
    return finishSso(conn, { ...oidcIdentity(conn, done.claims), linkUserId: done.linkUserId }, meta);
  },
});
cap({
  name: 'confirm_sso_link', method: 'POST', path: '/auth/sso/link', tag: TAG,
  summary: 'Signed in to your existing account: confirm linking it to the organisation sign-in that complete_sso reported as link_required. Only the account\'s own signed-in owner can do this (and must have finished two-step verification if it is on). You are notified and the link is audit-logged.',
  input: z.object({ link_token: z.string().min(20).max(300) }),
  async handler({ user, meta }, i) { return confirmLink(user, i.link_token, meta); },
});
cap({
  name: 'list_my_sso_identities', method: 'GET', path: '/me/sso', tag: TAG,
  summary: 'Signed in: the organisation sign-ins linked to your account (organisation, when linked, last used) and your current role in each. Use start_sso_link to add another organisation.',
  async handler({ user }) {
    return many(
      `SELECT i.id, o.id AS organisation_id, o.name AS organisation_name, c.protocol, i.linked_at, i.last_login_at, m.role AS my_role, m.status AS my_status, m.source AS my_source
         FROM org_sso_identities i JOIN org_sso_connections c ON c.id = i.connection_id JOIN organisations o ON o.id = c.organisation_id
         LEFT JOIN LATERAL (SELECT role, status, source FROM organisation_members WHERE organisation_id = o.id AND user_id = i.user_id ORDER BY invited_at DESC LIMIT 1) m ON true
        WHERE i.user_id = $1 AND i.status = 'active' ORDER BY i.linked_at DESC`, [user.id]);
  },
});
