# Authentication, sessions and API tokens (issue #60)

This page grows with each slice of #60. Sections below describe what is implemented today.

## API token scopes

An API token (`sa_...`, for scripts and MCP agents) is limited by **scopes**, an optional **expiry** and optional **resource restrictions**.
The effective permission is always the **intersection** of the token and the user: the token's scopes must allow the capability *and* the
user's roles/ownership rules must allow it. A token can never do more than its owner, nor more than the token that created it.

Every capability is classified once (`apps/api/src/scopes.js`, stored as `scope` on the capability) and enforced in `invoke()`, the single
path used by REST and MCP:

| Scope | Allows |
|---|---|
| `read` | capabilities classified `read` (all other GETs) |
| `write` | `read` + ordinary mutations (bookings, teams, events, profiles...) |
| `payment` | money movement: payments, wallet, invoices paid/refunded, plans/policies bought, payouts, settlements |
| `clinical` | health data, **reads and writes**: medical records and grants, appointments, follow-ups, wellness, body pain, loads, readiness, clearance |
| `admin` | `/admin/*` and admin-only capabilities, plus credential/role management (token create/list/revoke, role changes) |

`write` implies `read`; `payment`, `clinical` and `admin` are never implied. A capability can pin its class with `scope:` in `cap({...})`;
otherwise it is derived (`classify`). Credential management is `admin`-class so a narrow token cannot mint a wider one.

`POST /me/tokens` (`create_api_token`): `{ name, scopes?: string[] (default ["read"]), expires_at?: ISO datetime, resources?: [{type, id}] }`.
`resources` types: `venue`, `team`, `event`, `organisation`. A resource-restricted token may only call capabilities that name one of its
resources (`venue_id`/`team_id`/`event_id`/`org(anisation)_id` fields, or `:id` of `/venues|teams|events|organisations/:id`) and every named
resource must be allowed; capabilities that name no resource are refused. This is a conservative rule: capabilities that reference a
resource indirectly (e.g. a booking id whose venue is not in the input) are not matched and are therefore refused for restricted tokens.

Expired or revoked tokens match no row at authentication, so they fail with `401` on the next request. `last_used_at` is updated on use.
`GET /me/tokens` returns scopes, expiry, resources, last use, `expired` and `legacy_full`; secrets and hashes are never returned.

### Migration `052_api_token_scopes.sql` (additive)
- Adds `scopes text[]`, `expires_at`, `resources jsonb`, a CHECK on known scope names and an index.
- **Existing tokens are deliberately migrated to the documented legacy scope `full`**: they keep working exactly as before (all the owner can
  do), are shown with `legacy_full: true`, and are never widened or changed in place. `full` cannot be requested for new tokens. To narrow a
  legacy token, create a scoped one and revoke the old one.
- New tokens created without `scopes` get `["read"]`. This is a behaviour change for clients that created name-only tokens expecting full access.
- Rollback: the code ignores the columns if reverted; no data is dropped. Do not re-widen tokens by editing `scopes` by hand.

### Failure modes and limits
- `403 forbidden` names the missing scope; `401 unauthorized` for unknown/expired/revoked tokens (indistinguishable by design).
- Session JWTs (web/native sign-in) carry no scope limits; scopes apply to API tokens only.
- Scope checks run before input validation so a narrow token cannot probe the shape of capabilities it may not use.

## Server sessions and refresh tokens

Every sign-in (`register`, `login`) opens a **server session** (`auth_sessions`) and returns
`{ user, token, refresh_token, session_id, expires_at }`. The access JWT carries the session id as `jti`; `authenticate()` checks on **every
request** that the session exists, is not revoked and has not expired, so logout and revocation take effect immediately.

| Capability | Route | Purpose |
|---|---|---|
| `refresh_session` | `POST /auth/refresh` (public) | rotate: one-time refresh token in, new access token + new refresh token out |
| `logout` | `POST /auth/logout` | end this session |
| `logout_all` | `POST /auth/logout-all` | end every session of the account |
| `list_login_sessions` | `GET /me/sessions` | active devices: created, last seen, user agent, IP, `current` |
| `revoke_login_session` | `DELETE /me/sessions/:id` | sign out one device |
| `change_my_password` | `POST /me/password` | change password; every *other* session is revoked, this one stays |

(`list_sessions` already exists for multi-sport play sessions, hence the `_login_` names.) Session-management capabilities are `admin`-class
for API tokens: a token cannot list, end or create sessions.

**Refresh rotation and reuse detection.** Refresh tokens (`sr_...`) are stored only as SHA-256 hashes and work exactly once; consuming one is a
single atomic `UPDATE ... WHERE used_at IS NULL`, so of several concurrent refreshes exactly one wins. Presenting an already-rotated token is
treated as theft: the whole session (family) is revoked with reason `refresh_reuse`, forcing a fresh sign-in. Trade-off: a legitimate client that
refreshes twice in parallel with the same token (two tabs) will be signed out; clients must serialise refreshes.

### Configuration
- `TOKEN_TTL` (default `12h`): access-token lifetime. Lower it (e.g. `15m`) once clients refresh automatically.
- `REFRESH_TTL_DAYS` (default `30`): sliding session lifetime; each rotation extends it.
- `AUTH_REQUIRE_SESSION=true`: refuse JWTs without a session id. By default, JWTs issued before this release (no `jti` session row) keep working until
  their TTL (<= 12h) so the rollout signs nobody out; set the flag after one TTL has passed.

### Migration `053_auth_sessions.sql` (additive)
Two new tables, no cascades, nothing dropped. Rollback: reverting the code leaves the tables unused; old code accepts the new JWTs (the extra `jti`
claim is ignored). Revocation then no longer applies, which is the only loss.

### Failure modes and limits
- Invalid/expired/revoked/reused refresh token: `401 Session expired. Please sign in again.` (indistinguishable by design).
- `/auth/refresh` shares the per-IP auth rate limiter with login and register.
- Per-account lockout and email-based recovery arrive with the account-security slice.
- Revoking a session does not revoke API tokens; revoke those separately (`revoke_api_token`).

## Web cookie sessions, CSRF and origin policy

The web app authenticates with cookies; native apps, scripts and agents keep using `Authorization: Bearer`.

| Cookie | HttpOnly | Path | Holds |
|---|---|---|---|
| `sa_session` | yes | `/` | the access JWT (session-bound, see above) |
| `sa_refresh` | yes | `/api/v1/auth` | the one-time refresh token |
| `sa_csrf` | no | `/` | random CSRF token, echoed by the page in `X-CSRF-Token` |

All are `Secure` (when the request arrived over HTTPS; see `COOKIE_SECURE`) and `SameSite=Lax` (`COOKIE_SAMESITE`). A client opts into cookie mode by
sending `X-SA-Client: web` to `login`, `register` or `refresh_session`; those responses then set the cookies and **omit `token` and `refresh_token`
from the body** (`cookie_session: true`). Without the header (native, agents) tokens are returned in the body exactly as before.

**CSRF protection** applies to every state-changing request (POST/PATCH/PUT/DELETE) that authenticates by cookie (no `Authorization` header):
1. `Origin` (or, if absent, `Referer`) must be in the allowlist, otherwise `403 csrf_origin`.
2. `X-CSRF-Token` must equal the `sa_csrf` cookie (double-submit, constant-time compare), otherwise `403 csrf_token`.
`login`/`register` in web mode check the Origin only (there is no session to forge yet), which blocks login-CSRF. Cookie refresh and logout require
both. An explicit `Authorization` header skips CSRF (browsers never add it themselves) and wins over cookies. **MCP (`/mcp`) never accepts cookies.**
Safe methods (GET/HEAD/OPTIONS) are not checked; responses are readable only by allowed origins.

**Origin policy / CORS.** `CORS_ORIGINS` is a comma-separated allowlist (the deploy script sets it to the public web origin). Listed origins get
`Access-Control-Allow-Credentials: true`; `*` still allows other origins to call the API with bearer tokens but **never** with credentials. If the
list holds no explicit origin (local development) only same-origin cookie writes are accepted (Origin host equals the request `Host`). Behind
nginx, `Host` has no port, so production must set `CORS_ORIGINS` explicitly (it does).

### Web app behaviour
- The web build writes no credential to `localStorage` (the storage layer refuses the keys) and on load deletes any `token` left by earlier builds.
- Migration: people with an old localStorage bearer sign in once more; their previous token is not converted into a cookie. Pre-session JWTs elsewhere are unaffected.
- On `401` the client refreshes once (serialised, so rotation never double-spends a token) and retries; if that fails the user is signed out.
- Native keeps the access and refresh tokens in SecureStore (Keychain/Keystore).

### Configuration and limits
- `COOKIE_SECURE` (`auto` | `true` | `false`, default `auto` = request is HTTPS), `COOKIE_SAMESITE` (default `lax`), `CORS_ORIGINS`.
- Plain-HTTP interim deployments (`ALLOW_INSECURE_HTTP`) cannot set `Secure` cookies; enable HTTPS before relying on cookie sessions there.
- Cross-site embedding (different registrable domain between app and API) would need `COOKIE_SAMESITE=none` plus HTTPS; not supported by default.
- Rollback: reverting the web build restores bearer-in-body behaviour (the body-token path for non-`X-SA-Client` callers is unchanged).
