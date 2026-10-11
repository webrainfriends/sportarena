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
