# Player recruitment pipeline (issue #314)

A staged recruitment flow on top of the Billboard application: **applied → shortlisted → trial → evaluated → offered → accepted / declined**, plus **withdrawn**. Offers are versioned with a deadline; the applicant's evidence link is kept with its source.

## What it reuses (nothing is duplicated)

| Existing | Used for |
|---|---|
| `billboard_posts` / `billboard_responses` (#67) | The application *is* the response. Same unique `(post, responder)`, same `respond_to_post`; the old `status` column stays in sync (`pending` while open, then `accepted` / `declined` / `withdrawn`). |
| `team_members`, `openRosterStint` (#311) | Accepting still joins the roster and opens a career stint (shared `acceptIntoTeam`). |
| `youth.js` | Guardian authority and the existing `recruitment_sharing` consent purpose. |
| `crypto.js`, `audit_log` | Evidence links and evaluation notes encrypted; every decrypt is audit-logged. |
| `notify` | Applicant, guardians and post staff notified with dedupe keys. |
| `academy_append_only()` trigger | History table is immutable. |

Merged: the team screen's own Accept/No list (`team-manage.js`) and the Billboard post's inline Accept/Decline now open the one pipeline screen instead of deciding in place (sponsorship posts keep the simple accept/decline).

## Schema (migration `104_recruitment_pipeline.sql`, additive)

* `billboard_responses`: `stage`, `row_version`, `stage_changed_at`, `source_kind`, `source_ref_enc` (encrypted https link), `applied_by` (guardian who applied), `idempotency_key`, `trial_at`, `trial_venue_id`, `trial_note`. The `status` CHECK is widened with `withdrawn` (never narrowed). Existing rows are back-filled (`accepted/declined` → same stage; everything else stays `applied`) and receive an `applied` event.
* `recruitment_events`: immutable history (kind, from/to stage, actor, note, idempotency key — unique per application, so a retry is answered from the first result).
* `recruitment_offers`: `version` (unique per application), role, rate + unit, `starts_on`, **`deadline_at` (required)**, status `open | accepted | declined | superseded | expired | withdrawn`. One open offer at a time; a new version supersedes the old one, older versions stay readable.
* `recruitment_evaluations`: rating 1–5, `notes_enc`, author.
* Rollback: stop using the new columns/tables; nothing is dropped and the legacy `status` keeps the old behaviour.

## Stages and who moves them

| Move | Capability | Who |
|---|---|---|
| apply (stage `applied`) | `respond_to_post` (`source_url` https, `source_kind`, `on_behalf_of`, `idempotency_key`) | applicant, or verified guardian for a young person |
| applied → shortlisted, any open → declined | `move_recruitment_stage` | post staff |
| → trial (or reschedule) | `schedule_recruitment_trial` (future time, venue picked from the platform) | post staff |
| trial → evaluated | `record_recruitment_evaluation` (only after the trial time) | post staff |
| → offered (v1, v2 …) | `send_recruitment_offer` (deadline required, future) | post staff |
| offered → accepted / declined | `respond_recruitment_offer` | applicant or verified guardian (a young person cannot accept alone) |
| any open → withdrawn | `withdraw_recruitment_application` | applicant or verified guardian |
| read | `get_recruitment_pipeline`, `get_recruitment_application`, `export_recruitment_pipeline`, `list_post_responses`, `list_my_responses` | staff / applicant / guardian |
| legacy | `decide_response` | post staff — same engine, records a `legacy_decision` event |

"Post staff" = the post author, anyone who can manage the post's team, or an admin.

## Rules

* **Stale versions / retries:** every mutation takes the `row_version` you saw (409 `stale_version` otherwise) and an `idempotency_key` (a replay returns the first result with `replayed: true`).
* **Invalid transitions** → 409 `invalid_transition`; finished applications → 409 `closed_application`.
* **Offers:** a lapsed offer (`deadline_at` passed) is marked `expired` on the next read or write, the application returns to the stage before the offer so staff can re-offer, and the applicant is told `offer_expired`. Accepting takes a row lock on the post, so two simultaneous accepts for the last position cannot both win (409 `positions_filled`). Accepting joins the team at the offered role and rate and fills the post when full.
* **Youth / guardian:** a young applicant needs a guardian's current `recruitment_sharing` consent to apply (409 `guardian_consent_required`). Consent is re-checked on **every** call: if it is withdrawn, staff see the applicant as `hidden` (no identity, message, evidence), cannot act, the export withholds them, and counts stay honest. The family can still read and withdraw. Offers for a young person are decided by a verified guardian.
* **Provenance and privacy:** the evidence link is stored encrypted with its kind; only staff can open it and each open is audit-logged (`read_recruitment_source`). Evaluation notes are staff-only and audit-logged on read. Staff-only event notes are not shown to the applicant. The CSV export never contains links, messages or notes, and is audit-logged.
* **Deterministic ordering:** pipelines are ordered by `created_at, id`.

## App screens

* **Recruiting** (`RecruitmentPipeline`): stage tabs with counts, candidate cards, shortlist / decline / open, CSV export. Loading, empty ("No one at this stage yet") and error-with-retry states. Opened from the Billboard post and the team's recruiting list.
* **Application** (`RecruitmentApplication`): history, offers (all versions), staff-only evaluations and evidence link; trial / evaluation / offer forms use date and time pickers, a venue picker, a stepper and a currency amount field.
* **My applications** (`MyApplications`, More ▸ Play; also under Family ▸ Applications for a guardian): stage, trial time, latest offer with deadline countdown, Accept / Decline / Withdraw.

## Operations

No new environment variables. Migration `104` runs automatically on deploy.
