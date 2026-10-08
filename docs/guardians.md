# Youth accounts, guardians and consent (issue #70, PROD-07)

A guardian manages a young person's permissions and who may collect them; the young person keeps an account of their own.
**This is product behaviour and operator configuration, not a claim of legal compliance.** Operators must check the age
policy, consent lifetimes and retention against the rules of the places they operate in.

## Who counts as "youth"
`users.youth_until` (never returned by any API) is the date a person reaches the independence age of their policy. It is
derived from the encrypted date of birth when a DOB is saved (`register`, `update_me`), after policy changes, and by a
one-off backfill that runs after migrations for accounts that already have a DOB. Reading the DOB for this is audit-logged
(`derive_youth_status`). A person is youth while `youth_until` is in the future, so they become independent automatically on
that date: guardian authority, consents and delegations stop applying with no job needed. Accounts with no DOB are treated as
adults and keep working exactly as before. A young person must have a DOB to be linked to a guardian.

## Age policy (jurisdiction-configurable, versioned)
Built-in `default`: independence at 18, up to 2 verified guardians, links valid 730 days, consents at most 365 days, retention 365 days.
`set_age_policy` (platform team) publishes a new version per jurisdiction; links and consents record the version they were
made under. `set_user_jurisdiction` assigns a person to a jurisdiction (exceptional / manual review, with a reason).
`get_age_policy` and `get_my_youth_status` show what applies.

## Guardian relationship lifecycle
`invited → accepted → pending_review → active`, or `declined` / `rejected` / `revoked`.

1. `request_guardian_link`: the adult **or** the young person asks (by exact handle; young people are not searchable). The other person must `respond_guardian_link`. Only an adult can be a guardian and only a young person can be a child, so an adult cannot link themselves to another adult.
2. The guardian adds proof with `submit_guardian_evidence` (reference or PDF/JPEG/PNG/WebP, encrypted like case evidence).
3. If the child already has a verified guardian, an existing guardian must `approve_additional_guardian`, or the platform team records an exceptional review with a written reason.
4. The platform team opens the evidence (`get_guardian_evidence`, audit-logged) and runs `decide_guardian_link`. Verified links expire after `link_valid_days` and must be renewed.

Conflict policy: a guardian can end only their own link (`revoke_guardian_link`); a requester can withdraw an unverified request;
only the platform team can end someone else's link (for example after a dispute between guardians; guardians use the existing
Support & disputes flow). The maximum number of verified guardians is enforced under a per-child lock. All transitions are in the
append-only `guardian_link_events`.

## Consent
Per purpose: `participation`, `medical`, `media`, `contact`. A verified guardian grants (`grant_youth_consent`) with an expiry (capped
by policy); **any** verified guardian can withdraw (`revoke_youth_consent`): the most restrictive choice wins. A consent counts only
while it is unexpired, unrevoked **and** the guardian who gave it is still verified. History: `youth_consent_events` (append-only).

What each purpose gates (new actions only; existing records are untouched):

| Purpose | Gated actions |
|---|---|
| participation | add to a team roster, accept a team invitation, squad selection, associations with games/teams/events, check-in |
| medical | `grant_medical_access`, `book_appointment`, provider access via `hasGrant`, `get_clearance` for anyone but the child, guardians and platform team |
| contact | posting in team chat |
| media | recorded for features that publish photos/video of a person (none exist yet; call `hasConsent(child,'media')` when adding one) |

## Visibility
A young person has no public profile: they are excluded from `search_people`, `list_associations`, the leaderboard, home feed,
coach hire, sponsorship search and game rosters; `get_person` returns "not found" except to the person, their verified guardians
and managers of a team they play on (with participation consent), who get a minimal card (name and avatar, no bio, teams or
sports). `get_team` lists young members only to those same people and reports `members_restricted`. The same capabilities serve
REST, OpenAPI and MCP, so the rules are identical. No capability stores or returns a child's precise location: check-ins record
only the team; history is visible to the child, their guardians and that team's managers.

## Pickup and check-in
Guardians authorise adults to collect for up to 90 days (`add_pickup_delegate`: platform user, encrypted name, or both).
`check_in_child` records `drop_off` / `pickup` for a child on a team roster, by a guardian, a current delegate (pickup only) or
a team manager. A manager must release the child to a guardian or a current delegate. Retries are safe with `idempotency_key`,
check-ins alternate (no double drop-off), guardians are notified. `check_in` needs current participation consent.

## Data, migration and rollback
`migrations/022_youth_guardians.sql` is additive: new nullable columns on `users` and new tables; nothing is dropped, rewritten or
narrowed, and history tables are append-only by trigger. Existing rows survive; DOB-bearing accounts are evaluated by an
idempotent backfill. Rollback: deploy the previous code, which ignores the new columns/tables (leave them in place; there is no
destructive down-migration by design). Retention (`retention_days`) is recorded in the policy; purging is deliberately not
automated because the project never deletes data: operators handle retention requests manually.

## Operational failure modes and limits
* Policy change re-evaluates everyone in that jurisdiction (decrypts DOBs, audited); lowering the age makes people visible immediately.
* A DOB entered wrongly changes status at once; there is no lock on editing a DOB (a known limitation: the platform team can reassign jurisdiction or revoke links).
* Link expiry silently ends authority and all consents/delegations that depend on it; guardians must renew.
* Guardians cannot yet read a child's clinical records (only status/consents); the child controls provider access once medical consent exists.
* Evidence verification is a manual platform-team decision. Nothing here verifies identity automatically.
* Existing youth already on rosters stay there; only new actions are blocked.
