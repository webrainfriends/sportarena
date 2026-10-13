# Authentication, sessions and API tokens (issue #60)

Everything in issue #60 in one place: scoped API tokens, revocable sessions, cookie sessions for the web, account security (email
verification, password recovery, two-step verification) and the screens that use them.

## Summary and rollout checklist

| Area | Migration | Switch / config | Default |
|---|---|---|---|
| Token scopes, expiry, resources | `052_api_token_scopes.sql` | none | existing tokens keep `full`; new tokens default to `read` |
| Server sessions, refresh rotation | `053_auth_sessions.sql` | `TOKEN_TTL`, `REFRESH_TTL_DAYS`, `AUTH_REQUIRE_SESSION` | pre-session JWTs work until they expire |
| Web cookies, CSRF, origins | none | `CORS_ORIGINS`, `COOKIE_SECURE`, `COOKIE_SAMESITE` | web clients that send `X-SA-Client: web` get cookies |
| Account security | `054_account_security.sql` | `MFA_ENFORCE`, `NOTIFY_WEBHOOK_URL`, `APP_URL` | enforcement **on in production** (`MFA_ENFORCE=false` is the opt-out); off in dev/test |

Suggested order: deploy; check `CORS_ORIGINS` and HTTPS; make sure `NOTIFY_WEBHOOK_URL` works (recovery depends on it); have doctors, physios and
admins turn on two-step verification in **Me > Account security**; MFA enforcement is already on in production, so do the enrolment first: set the repo variable `MFA_ENFORCE=false` for the first deploy of this change, enrol, then remove the variable (the deploy workflow passes it to `.env`; note a deploy only writes it when set, so set it back to `true` explicitly to re-enable); later set `AUTH_REQUIRE_SESSION=true` and shorten
`TOKEN_TTL`. Rollback of any step is described in its section; no step deletes data, and migrations only add columns and tables.

## Sign in with Google and access approval

- **Log in / Create account** show a "Continue with Google" button when `GOOGLE_CLIENT_ID` is set (repository variable, passed to `.env` by the deploy;
  create a Web OAuth client in Google Cloud Console and add the site origin as an authorised JavaScript origin). The page gets the ID token from Google and
  sends it to `POST /auth/google` (`login_google`), which verifies signature, issuer, audience, expiry and `email_verified`. `GET /auth/config` tells the page
  the client id. Migration `059_google_login.sql` adds `users.google_sub`.
- **Sign in with Apple** (migration `062_apple_login.sql`, `users.apple_sub`): same rules as Google (shared in `social-login.js`: link by email, new accounts `pending`).
  Apple configuration: primary App ID `dev.gotmygame.app` (team `8DTG43KWPH`, config `APPLE_APP_ID`), domain `gotmygame.com`, return URL
  `https://gotmygame.com/api/v1/auth/apple/callback`. The web button needs a **Services ID** configured with that domain and return URL: set its identifier as the
  repository variable (or secret) `APPLE_CLIENT_ID`; unset = the Apple button is disabled. Flow: the button opens `/api/v1/auth/apple/start` (sets a signed-in-browser
  state cookie, redirects to Apple); Apple POSTs the id token to the callback, which checks state + nonce, verifies signature/issuer/audience/expiry against Apple's keys,
  sets the HttpOnly session cookies and returns to the app (two-step users continue at the code screen). `POST /auth/apple` (`login_apple`) accepts an identity token directly
  for native apps (audience = the app id). Apple only gives the name on first sign-in and may hide the email (private relay); an existing Apple account is found by its id.
- An existing account with the same email is linked. If that account's email was never verified, its password is replaced by an unusable one and its sessions
  are signed out (protects against someone pre-registering your address); reset the password by email to use it again.
- **Approval** (migration `060_access_approval.sql`, `users.access_status`): a brand-new Google account is `pending`. Existing accounts and password sign-ups stay
  `approved`. A non-approved account can use every screen read-only: `invoke()` refuses any non-GET capability (and the upload routes) with `approval_pending`,
  except sign-out, token refresh, password change, email verification and two-step verification. A banner explains this.
- **Super admin**: `SUPER_ADMIN_EMAIL`, set in `deploy.yml` (repository variable `SUPER_ADMIN_EMAIL` overrides it; no email is hard-coded in the app code; unset = nobody gets the role). When that Google account signs in it is approved and holds `admin` + `platform_admin`.
  It approves or rejects others in **Partner management > Access requests** (`list_access_requests`, `decide_access`). Rejecting signs the person out and blocks
  Google sign-in; deciding again re-approves. Nothing is deleted and every decision is audit-logged.
- Every screen shows a beta banner: the site is under beta testing and not for public or commercial use.

## Screens (Me, and the log-in screen)

- **Me > Account security**: email confirmation state (send/confirm), two-step verification (turn on with QR code or key, confirm a code, save the
  one-time recovery codes; turn off with password + code), change password, and **Where you are signed in** (devices with last activity, sign out
  one device, sign out everywhere). Loading, empty and error states are shown; all buttons are standard touch-size controls with accessible roles.
- **Me > Agents & API**: create a token with a name, permission chips (read, write, payments, health data, admin for admins), an expiry chosen on
  the calendar picker and an optional search-and-pick of the venues, teams, events or organisations it is limited to. The list shows permissions,
  expiry, last use and limits; tokens created before permissions existed are flagged **Full access** with a hint to replace them. The secret is shown once.
- **Log in**: "Forgot your password?" (request a code, then choose a new password; links from the email open the app with the code filled in),
  the two-step code screen after the password, and confirmation of the email link (`?verify_email=`).

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

**Parity.** The OpenAPI document (`/api/v1/openapi.json`) states each operation's required scope as `x-required-scope` (and in its description); public operations carry none.
MCP tools enforce the same class through the same `invoke()` path. Tests: `capability-registry.test.js` (OpenAPI), `token-scopes.test.js` (REST and MCP: write token, resource-restricted token, expired/revoked token), `web-cookie-auth.test.js` (the web `storage.js` never writes credential keys).
The decision that email verification is informational is recorded under Account security (PR #176).

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

## Account security: email verification, password recovery, two-step verification (MFA)

| Capability | Route | Notes |
|---|---|---|
| `request_email_verification` | `POST /me/email/verification` | emails a single-use code/link, valid 24 h; max 5 per account per hour (`429`) |
| `verify_email` | `POST /auth/verify-email` (public) | sets `users.email_verified_at` |
| `request_password_reset` | `POST /auth/password-reset` (public) | always answers identically (no account enumeration); max 3 tokens per account per hour; per-IP limiter |
| `reset_password` | `POST /auth/password-reset/confirm` (public) | single-use, 30 min; sets the password, **revokes every session**, voids other outstanding reset tokens, emails a notice |
| `get_security_status` | `GET /me/security` | email verified, MFA on/pending, recovery codes left, role requirement |
| `mfa_setup` | `POST /me/mfa/setup` | needs the password; returns secret + `otpauth://` URI; inactive until confirmed |
| `mfa_enable` | `POST /me/mfa/enable` | confirm a code; returns 10 recovery codes **once** |
| `login_mfa` | `POST /auth/login/mfa` (public) | finishes a sign-in that returned `mfa_required` + `mfa_token` |
| `verify_mfa` | `POST /me/mfa/verify` | step-up: mark this session verified (code or recovery code) |
| `mfa_disable` | `POST /me/mfa/disable` | password + code; other sessions revoked |
| `admin_reset_mfa` | `POST /admin/users/:user_id/mfa-reset` | admin recovery for lost factor + codes; target signed out everywhere; audit-logged |

**Tokens.** Verification, reset and login-challenge secrets are random 256-bit values stored only as SHA-256 hashes (`account_tokens`), consumed
by one atomic `UPDATE ... WHERE used_at IS NULL AND expires_at > now()` (single use, concurrency safe).

**Email delivery** reuses the existing notification outbox (`notify.js`, sent by the dispatcher to `NOTIFY_WEBHOOK_URL`) via `notifySecurity()`:
security mail ignores mute/channel preferences, is created already-read, keeps the one-time secret **encrypted** (`data.secret_enc`), substitutes it
into the text only at send time, then erases it from the row. Without a webhook the mail stays queued (encrypted) as for every other email.
Links use `APP_URL` (`?verify_email=<code>`, `?reset_password=<code>`); the plain code is always included too.

**TOTP.** RFC 6238 (SHA-1, 6 digits, 30 s, +/-1 step drift). The secret is field-encrypted (`user_mfa.secret_enc`); each accepted time step is
recorded so a code cannot be replayed. Recovery codes (`xxxxx-xxxxx`) are stored hashed and work once. With MFA on, `login` returns
`{ mfa_required: true, mfa_token }` (no session, no cookies); `login_mfa` completes it (challenge: 5 minutes, 5 wrong tries, single use).
A session that completed MFA has `mfa_verified_at`. Wrong codes are limited per account across all MFA endpoints (10 in 15 minutes, then `429`).

**Who needs MFA (decision).** Roles `doctor`, `physio`, `admin`, `platform_admin` hold clinical or platform-wide power. Enforcement is **on by default in
production** (`NODE_ENV=production` and `MFA_ENFORCE` not `false`); in development and tests it is off unless `MFA_ENFORCE=true`. `MFA_ENFORCE=false` in production is the
explicit opt-out, meant only for a rollout window. When enforced, those roles must have MFA enabled **and** a verified session to use `clinical`- or `admin`-class
capabilities (including creating admin/clinical API tokens): `403 mfa_enrollment_required` or `403 mfa_required` (step up with `verify_mfa`). Enrolment, step-up,
sign-out, session and password management stay reachable. The app turns either error into a banner "Set up two-step verification to continue" with a button to
**Me > Account security**. Organisers' payments are **not** MFA-gated (payments are protected by the token `payment` scope, provider checks and audit); anyone may enable MFA voluntarily.

**API tokens and MFA.** A token has no MFA session. Tokens created since scopes existed were minted through the MFA-gated, admin-class `create_api_token`, but legacy
`full` tokens never were. So, when enforcement applies, a token with scope `full`, `clinical` or `admin` used by a sensitive-role owner for a clinical/admin-class
capability is refused with `403 mfa_enrollment_required` unless the owner has an enrolled MFA factor. Narrow (`read`/`write`/`payment`) tokens are not affected.

**Rollout (enrol first).** 1) Before deploying this default to production, set the repo variable `MFA_ENFORCE=false` (or accept that doctors/physios/admins are asked to enrol on first use).
2) Tell them to enrol under **Me > Account security**. 3) Remove the variable / set `MFA_ENFORCE=true`. Rollback is the same variable; no data is touched.

**Email verification (decision).** Verification is **informational**: `email_verified` is shown and used for trust signals, but no action is gated on it. The issue's
protection for sensitive actions is MFA (a second factor is stronger than an unverified mailbox), password recovery already goes only to the address on file, and
gating would lock out existing accounts, none of which were verified when `email_verified_at` was introduced.

**Compromise handling.** Password reset, password change, MFA disable and admin MFA reset all revoke sessions (reasons `password_reset`,
`password_changed`, `mfa_disabled`, `mfa_reset`) and send the owner a notice email.

### Migration `054_account_security.sql` (additive)
`users.email_verified_at` (existing accounts stay unverified; login does not require verification), `account_tokens`, `user_mfa`, `mfa_recovery_codes`,
`auth_sessions.mfa_verified_at`. Disabled/replaced MFA factors are kept (`disabled_at`, `disabled_reason`), never overwritten or deleted. The only
removal is the intentional erasure of a one-time secret from a sent email row. Rollback: revert the code; the tables stay unused. Anyone with MFA on
would then sign in with a password only, so do not roll back without telling those users.

### Failure modes and limits
- No webhook configured: emails (including reset links) stay queued; recovery is impossible until `NOTIFY_WEBHOOK_URL` is set. Admin MFA reset is the fallback for MFA, not for passwords.
- Per-IP limits on login/refresh/reset/verify share the existing auth limiter (20 per 15 minutes in production).
- Lost authenticator and recovery codes: an admin resets MFA (`admin_reset_mfa`); there is no self-service bypass by design.
- Email verification is informational today (it gates nothing); it is exposed so features can require it.
- Not implemented: recovery-code regeneration without disabling MFA, WebAuthn/passkeys, SMS codes.
