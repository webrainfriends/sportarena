# Verified recruiter & scout workspace (issue #313)

Child of the player transformation (#310), review item 4/28.

## What exists

| Need | Implementation |
|---|---|
| Verified recruiter identity | New `recruiter` verification type in `verification.js` (needs the `recruiter` role; ID + one of club letter / federation licence / authorisation letter / public profile link; 12 months). Reuses the platform's case queue, badges, expiry and revocation. `recruiter_profiles` holds organisation (listed or typed), sports, regions, bio. |
| Scoped athlete-access requests | `recruiter_access_requests`: one athlete + one sport, scopes `profile`, `measurements`, `career`, `contact`, `messages`, a purpose, a window of at most 180 days. The athlete (or a young person's verified guardian) approves all or some scopes, possibly for a shorter time, or declines. |
| Saved lists | `recruiter_lists` + `recruiter_list_entries` (pipeline stages prospect → passed, stage history in `recruiter_entry_events`). An athlete can only be saved while a live grant exists. |
| Evaluations | `recruiter_evaluations` (+ revisions): per-criterion ratings, overall 1–5, **basis** (live viewing, video, match report, trial, profile only), date observed, encrypted private notes. |
| Recruitment contact | Direct details (`contact` scope, adults only, decrypted + audited on read) and an append-only `recruiter_contacts` log with follow-up dates. |
| Permission-controlled messaging | `recruiter_threads` / `recruiter_messages`, one thread per request, encrypted bodies, only while the `messages` scope is live; athlete can close the thread. For a young person a guardian answers. |

## Reused, not duplicated
Verification cases/badges, organisations, sport profiles + field scopes (`recruiter` tier now actually granted by a live grant in `viewerTiers`), `athlete_measurements`, `career_memberships` (`publicCareer`), `youth.js` guardians/consent, `audit_log`, `notifications`, `crypto.js`.

## Access rules (enforced on every call, nothing cached)
Access is *live* only while all hold: recruiter verification approved + unexpired; request `approved`, not revoked, inside its window; for a young person a guardian's current `recruitment` consent (new consent purpose) and, for messages, `contact` consent. Contact details are never available for a young person.

* Reads (`get_recruiter_athlete`, `get_recruiter_contact`, thread reads), mutations (evaluations, contact log, list adds, messages) and exports all re-check. A failed check returns 403 with `details.code = access_not_live` and a `reason` (`revoked`, `expired`, `recruiter_unverified`, `guardian_consent_withdrawn`, `scope_not_granted`).
* After revocation / expiry the recruiter keeps their own pipeline: stage, dates and scores stay, but the athlete's identity, data, and the recruiter's notes/contact summaries are withheld; the CSV export shows "access ended".
* Discovery is exact-handle only (`find_athlete_for_recruiter`); there is no search or browse of athletes, and a young person shows only a name.
* No share links are created by this feature (passport links remain the athlete's own).
* Sensitive reads are audit-logged: `recruiter_lookup`, `read_recruiter_dossier`, `decrypt_recruiter_contact`, `read_recruiter_thread`, `approve/decline/revoke_recruiter_access`, `export_recruiter_list`.

## Schema changes (migration `104_recruiter_workspace.sql`, additive)
New tables: `recruiter_profiles`, `recruiter_access_requests`, `recruiter_lists`, `recruiter_list_entries`, `recruiter_entry_events`, `recruiter_evaluations`, `recruiter_evaluation_revisions`, `recruiter_contacts`, `recruiter_threads`, `recruiter_messages`. Two CHECK lists widened (`verification_cases.type` += `recruiter`, `youth_consents.purpose` += `recruitment`). No drops, no cascades, no deletes; rows are archived/superseded.
Invariants: one open request per recruiter+athlete+sport (partial unique index), `idempotency_key` uniqueness on requests/evaluations/contacts/messages, `row_version` optimistic locking (409 `stale_version`).

## API (REST + OpenAPI + MCP, tag `Recruiter`)
Recruiter (`recruiter` role): `get_recruiter_profile` GET `/recruiter/profile`, `save_recruiter_profile` POST `/recruiter/profile`, `find_athlete_for_recruiter` GET `/recruiter/athletes/lookup`, `create_recruiter_request` POST `/recruiter/requests`, `list_recruiter_requests` GET, `withdraw_recruiter_request` POST `/recruiter/requests/:id/withdraw`, `get_recruiter_athlete` GET `/recruiter/requests/:id/athlete`, `get_recruiter_contact` GET `…/contact`, lists (`list/create/update_recruiter_list`, `list_recruiter_entries`, `add_recruiter_entry`, `update_recruiter_entry`, `get_recruiter_entry`), `save/update_recruiter_evaluation`, `log_recruiter_contact`, `export_recruiter_list`.
Athlete / guardian: `list_my_recruiter_requests` GET `/me/recruiter-requests` (`athlete_id` for a guardian), `decide_recruiter_request` POST `/me/recruiter-requests/:id/decision`, `revoke_recruiter_access` POST `…/revoke`, `set_recruiter_thread_closed` POST `…/thread`.
Both sides: `send_recruiter_message` / `list_recruiter_messages` on `/recruiter/requests/:id/messages`.
Other changes: `person` card (`GET /people/:id`) now shows `recruiter`-scoped fields/measurements to a recruiter holding a live grant; role `recruiter` added; `Family` consent purpose "Recruiters & scouts".

## UI
Recruiter workspace (More → Workspace): pipeline, requests, profile; saved athlete sheet with evaluations and contact log; profile view as allowed; messages. Athlete: Player → Recruiter access (approve / decline / end now / close chat); guardians: Family → Recruiters.

## Deployment / configuration
Only the migration (runs on start). A platform reviewer approves recruiter verification cases through the existing queue. No new secrets.

## Tests
`apps/api/test/recruiter.test.js` (11 scenarios: verification gate through the real queue, exact-handle discovery, request validation/idempotency/duplicates, scoped reads and audit, live revocation across read/contact/message/evaluation/export, expiry and verification lapse, lists, evaluations and contact log with revisions, messaging, youth/guardian consent and immediate withdrawal, REST/OpenAPI/MCP parity).
