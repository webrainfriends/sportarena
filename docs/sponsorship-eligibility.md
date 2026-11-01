# Sponsorship eligibility screening and application validation (#287)

Extends the sponsorship program stack (#284 programs, #286 forms, #288 evaluation, #289 awards). It adds no parallel workflow: rules are
versions of the program's own eligibility, missing-information requests reuse the application-form correction flow, and the award gate
reads the screening.

## Model (migration `139_sponsorship_eligibility.sql`, additive)
| Table / column | Purpose |
|---|---|
| `sponsorship_eligibility_versions` | Immutable, numbered rule sets per program (`target_types, sports, regions, verified_only, max_award_cents, duplicate_check, required_documents`) with a sha256. Version 1 is back-filled from each program's current rules. |
| `sponsorship_programs.eligibility_version` | The version in force. The older program columns stay and are kept in step (so discovery and `assertCanApply` are unchanged). |
| `sponsorship_screenings` | One append-only row per screening run: rules version + hash, outcome, plain reasons, missing items, duplicate flags, trigger. |
| `sponsorship_applications.screening_id / screening_outcome / screening_version` | Latest run, its outcome, and an optimistic-lock counter for screening writes. Existing applications are **not** given an invented screening (`screened:false`). |
| `sponsorship_screening_exceptions` | A manual exception: who, authority role, reason (encrypted, `reason_enc`), optional expiry, soft revoke. One live exception per application. |
| `sponsorship_screening_events` | Append-only trail (`screened`, `info_requested`, `exception_granted`, `exception_revoked`). |

Rollback: deploy the previous code; the new tables and nullable columns are simply unused. Nothing is dropped, rewritten or deleted.

## Outcomes
`eligible` · `needs_info` (a fact is unknown or a document is missing - never guessed) · `ineligible` (a rule is unmet) · `review`
(eligible but a possible duplicate was flagged; a flag never rejects).

## Capabilities (REST + OpenAPI + MCP, one definition each)
| Capability | Who | Notes |
|---|---|---|
| `publish_eligibility_rules` `POST /sponsorship-programs/:id/eligibility` | brand manager/approver | needs program `version` (409 if stale); identical rules add no version |
| `list_eligibility_versions` `GET /sponsorship-programs/:id/eligibility` | brand staff with `evaluation` | paginated, newest first |
| `preview_eligibility` `POST /program-rounds/:id/eligibility-check` | the target's owner | read-only, files nothing; others get 404 |
| `get_application_screening` `GET /program-applications/:id/screening` | applicant or brand staff | applicant never sees other applications or the exception reason; blind rounds show aliases |
| `screen_application` `POST /program-applications/:id/screen` | manager/approver | adds a run; earlier runs stay; needs screening `version` |
| `request_missing_information` `POST /program-applications/:id/request-information` | manager/approver | form fields → controlled correction (#286); others → notification |
| `grant_screening_exception` / `revoke_screening_exception` | manager/approver (`screening_exception`) | reason ≥ 20 chars, encrypted, audited, notifies the applicant |

`update_sponsorship_program` also appends a rule version when eligibility-relevant fields change. Screening runs automatically on
`apply_to_program_round`, `submit_application` and `submit_application_correction`. `decide_program_application` refuses an **award** while
the outcome is `needs_info`/`ineligible` unless a live exception exists (declining is never blocked). `export_program_applications` adds
`screening_outcome` and `eligibility_version`.

## Security
Authorization is server-side (`programFor`/`SPONSOR_ACTIONS`); strangers get 404 on every read and write; exception reasons are sealed with
`crypto.js` and every staff read is audit-logged (`read_pii`); grants/revokes/screens/publishes are audit-logged.

## Dependency order and recovery
Migration 139 → API → app. If a screening is wrong, re-screen (adds a run) or publish corrected rules; a wrong exception is revoked, not deleted.

## Limits
Reason sentences are produced by the API in English (the screen chrome is translated in all packs). Sports/regions are checked against the
platform's own records; an athlete with no sport profile is reported as missing, not rejected. Provider email delivery follows #243.
