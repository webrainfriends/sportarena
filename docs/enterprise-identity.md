# Enterprise identity & provisioning (#521)

One canonical Gotmygame person (`users`) may hold a role in several organisations. An organisation's identity provider (OIDC or SAML 2.0)
and directory (SCIM 2.0) only ever add, change or end **that organisation's own `organisation_members` row**. They never write
`users.roles`, never touch another organisation, and never delete the person or their history.

| Requirement | Canonical source | Extension |
|---|---|---|
| Who is the person | `users` (+ `email_enc` / `email_idx`) | `org_sso_identities` links (connection, IdP subject) to a user |
| Organisation access | `organisation_members` (read live on every call) | `source` (manual / sso / scim), `deprovisioned_at` |
| Sessions | `auth_sessions`, rotating refresh tokens | `sso_connection_id`, `hard_expires_at` (session length) |
| Service credentials | `api_tokens` (scoped) | `scim_tokens`, org-scoped, independent of any session |
| Audit | `audit_log` | `sso_events` (decision, reason, no secrets) |

## Capabilities (REST + OpenAPI + MCP, tag *Enterprise identity*)
Domain claim, connection (save / test / on-off), group mappings, SCIM credentials, access review (also CSV via `export_org_data`),
identity log, `discover_sso`, `start_sso`, `start_sso_link`, `complete_sso`, `confirm_sso_link`, `list_my_sso_identities`.
Protocol routes that cannot be JSON capabilities: SAML ACS POST + SP metadata (`/auth/sso/:id/saml/*`) and SCIM (`/scim/v2`).
Offboarding reuses `remove_org_member` (it now also ends the organisation's SSO sessions and org-only tokens).

## Rules enforced on the server
* Email must be on a domain the organisation **verified by DNS TXT**; free mail domains cannot be claimed; domain ownership grants no role.
* A matching existing account is **never merged** on a claim: the account's own signed-in owner confirms (`confirm_sso_link`), or adds another
  organisation from a signed-in session (`start_sso_link`). Names never match. An unverified, never-confirmed registration of an organisation
  address is reclaimed (password made unusable, sessions ended).
* Roles come from explicit group mappings inside the connection's **role ceiling** (`allowed_roles`); deny wins; `owner` and `legal` are never
  provisioned; platform roles are never granted and platform-admin emails cannot use SSO; no guardian/youth relationship is created or changed,
  and minors are refused staff roles.
* OIDC: `jose` verifies signature (RS/PS/ES/EdDSA only), issuer, audience/azp, expiry with configurable skew, freshness, nonce, PKCE, single-use
  state, `jti` replay; JWKS refetched once on unknown `kid` (rotation). SAML: `@node-saml/node-saml` verifies signatures against all currently
  trusted certificates (overlap + `retire_after` for rotation), audience, conditions, recipient and InResponseTo (scoped to connection + RelayState);
  assertion ids are replay-protected; IdP-initiated responses are refused. Metadata import rejects DTDs.
* Outbound IdP fetches are https-only and connect only to public addresses (checked in the socket lookup).
* IdP secrets are encrypted at rest (`encrypt`) and never returned; SCIM tokens are stored hashed and shown once.
* SCIM: Users/Groups, filters (`eq`), paging, weak ETag + `If-Match`, PATCH, idempotent POST (the same userName/externalId returns the existing
  resource with 200 so retries are safe; a clash with a different externalId is 409). `active=false` / DELETE deprovisions: membership closed
  (never an owner), this connection's sessions and org-only API tokens revoked, history kept; reactivation grants access again at next sign-in.
* Policy: hard session length, "require MFA signal" (OIDC `amr`/`acr`, SAML AuthnContext; not device compliance), password login can be closed
  for provisioned people with up to two audited break-glass owners/admins. Defaults keep existing password/Google/Apple login unchanged.

## Configuration
`API_PUBLIC_URL` (SAML ACS/metadata URLs; defaults to the origin of `APPLE_REDIRECT_URI`), `SSO_REDIRECT_URIS` (app callbacks an IdP may return
to; defaults `https://gotmygame.com/sso/callback`, `sportarena://sso/callback`; localhost allowed outside production). The web host must serve the
app at `/sso/callback`.

## Not covered / not exercised
Encrypted SAML assertions, SAML single logout, SCIM Bulk/sort, and automatic metadata-URL refresh are not implemented. Providers are tested
against local OIDC/SAML fixtures (real keys and certificates), not against a live Entra/Okta/Google Workspace tenant; native iOS/Android behaviour
was verified by `expo export` bundles, not on devices.
