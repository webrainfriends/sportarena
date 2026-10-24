# Trials and athlete assessments (issue #315)

Migration `104_trial_assessments.sql` is additive: new tables, plus the `event_staff_roles.role` check widened to allow `assessor` (every old value stays valid). Nothing is dropped or rewritten.

## Reuse (no second source of truth)
- A trial is an `events` row with `kind='trial'`; discovery is `search_events?kind=trial`; capacity, deadline and the waitlist live on `events` / `event_entries`.
- A booking is an individual `event_entries` row (`user_id` set). Team entries are not part of a trial roster.
- Assessors are hired through the event console's crew flow (People → Hiring, role **Trial assessor**); an accepted assignment grants assessor rights on that event. The organiser (or organisation owner/admin, or platform admin) is the other staff role.
- Rubrics are the standard sport frameworks (`standard-rubrics.js`) for the trial's sport plus the assessor's own coaching rubrics. The dimensions are snapshotted into the assessment, so a score keeps the scale it was given under.
- Academy admissions keep their own `trial_*` stages; they are untouched.

## Tables
`trial_attendance` (+ `trial_attendance_log`), `trial_assessments` (+ `trial_assessment_revisions`), `trial_outcomes` (+ `trial_outcome_log`), `trial_follow_ups`. Nothing is deleted; corrections are new rows or versions. `row_version` gives optimistic concurrency, `client_key` makes retries idempotent.

## Capabilities (REST + OpenAPI + MCP)
| capability | who |
|---|---|
| `book_trial` `POST /trials/:id/book` | player, or a verified guardian for a child (`athlete_id`) |
| `cancel_trial_booking` `POST /trial-bookings/:id/cancel` | player / guardian; promotes the oldest waitlisted player |
| `my_trials` `GET /trials/mine` | player / guardian (`athlete_id`) |
| `get_trial_session` `GET /trials/:id/session` | organiser, assessor |
| `mark_trial_attendance` `POST /trial-bookings/:id/attendance` | organiser, assessor |
| `list_trial_rubrics` `GET /trials/:id/rubrics`, `save_trial_assessment` `POST /trial-bookings/:id/assessment` | organiser, assessor |
| `set_trial_outcome`, `release_trial_feedback` | organiser only |
| `add_trial_follow_up`, `update_trial_follow_up` | organiser, assessor |
| `export_trial_results` `GET /trials/:id/export` | organiser only, audit-logged |

## Rules
- **Attendance is not selection.** Outcome is its own record, only for players who attended, and stays private until released.
- **Release goes to the player and every verified guardian** (notified). Feedback marked `share=now` is visible immediately; `after_outcome` (default) after release; `private` never. `private_note` is never returned to players, guardians or in exports.
- **Youth:** booking needs a guardian's current `participation` and `coaching` consent; staff mutations need current consent for the purpose; if coaching consent is revoked, the player's and guardian's feedback/outcome disappear at once (live check on every read), staff see the entry as `restricted` and the export leaves the young person out and counts them. Guardian access ends with the guardian link.
- **Failures:** stale `row_version` → 409 `stale_version`; a second save of your own assessment without `row_version` → 409; correcting an attendance mark needs a reason; unknown rubric/dimension or out-of-range score → 400; permission denial → 403.
- **Concurrency:** bookings lock the event row (no overbooking); every mutation locks its booking row.
