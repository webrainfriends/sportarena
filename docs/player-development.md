# Player development workspace (issue #324, review item 15/28)

One screen where a player sees what their coach has set and shared, and where a verified guardian sees the same for a young person, read-only. It **reads** existing records; it adds no tables and no migration, and it copies nothing.

## Baseline (main at `03f669c`) and what was missing
Already there: coaching goals, actions, notes, session summaries and branded reports (`/me/coaching-*`, `guardian_coaching_overview`), training plans, trial assessments (`my_trials`), academy assessments (`get_my_academy_progress`). The athlete's view was a screen called "From my coach" (notes, goals, actions, reports, summaries) with a button hidden on the plans screen; plans, plan feedback, assessments and a single "what do I do next" list were in separate places.

## What changed
- **`get_my_development`** (`GET /me/development`, REST + OpenAPI + MCP): `next_actions`, `goals`, `plans`, `feedback`, `assessments`, `reports`. Each section is `{items, has_more}`. Pass `section` with `limit` (1–50, default 10) and `offset` to page one section in a stable order.
- **Provenance on every row**: `provenance = {source, source_label, basis, by, at, record:{type,id}}`. `basis` is one of `coach_set`, `coach_observed`, `assessor_rated`, `staff_set`, `derived`; `record` names the owning table row, so nothing is a second source of truth.
- **Next actions** merge, in a fixed order (overdue, needs answer, due within 7 days, later, undated; then due time, kind, id): open shared coach actions, a plan or revision waiting for the athlete's answer, upcoming plan sessions (14 days), goal reviews due within 14 days, open trial follow-ups, the next academy review date.
- **Feedback** merges coach feedback on plan sessions, notes shared with the player/team and session summaries. **Assessments** merge released trial assessments and approved academy assessments.
- **App**: `MyDevelopment` screen (`screens/player-development.js`) in the Player tab ("Development"), the More menu, the plans screen and (read-only, `child_id`) the guardian's family card. It **replaces** the old `MyCoaching` screen, so there is one home for this; its content is now in Feedback, Goals, Next actions and Reports.
- **Fix (mutation + live revocation)**: `update_coaching_action` now refuses a non-author (the athlete) when a young person's guardian coaching consent is not current, matching what reads already did.

## Permissions
- Self: any signed-in user, own data only. Guardian: `athlete_id` of a child with an active, unexpired guardian link (403 otherwise; admins allowed); the read is audit-logged (`read_child_development`). The guardian gets guardian-audience reports; the child gets athlete-audience reports; mutation controls are not offered to guardians (`can_complete: false`).
- A young person needs a guardian's current `coaching` consent: without it the response is `consent:false`, a note, and no items (nothing is deleted; allowing it again restores everything at once).
- Never returned: private coach notes, coach-only goals (no athlete wording), criteria, staff-only academy comments, private trial assessments and notes, unapproved or unreleased items. Each source applies its own rule (the trial and academy handlers are called as-is).
- Reports open through the existing live-checked `get_coaching_report_version`.

## Mutations stay where they live
Finishing an action uses `PATCH /coaching/actions/:id` with `row_version` (stale version → 409, a retry cannot overwrite). Answering a plan uses `POST /training-plans/:id/respond`. The workspace does not duplicate either.

## States
Loading, per-section empty state with no invented content, error with retry, consent-off state, a toast on a stale or failed save, "Show more" paging with its own error and retry. Phone is one column; tablet is two columns.

## Tests
`apps/api/test/player-development.test.js` (PostgreSQL): composition and provenance, private material absent, plan answer and plan feedback, stale/retry action completion, paging order, guardian read-only view, consent withdrawal on reads and on the action mutation, revoked guardian link, stranger/coach/other-player 403, trial and academy assessments (shared vs private, approved vs draft, staff-only comment).

## Not in scope / limits
- Plan answers, goal edits and report downloads happen on their existing screens. The workspace opens them.
- A guardian cannot open a plan page (plans are the athlete's to answer), so plan rows are not links for guardians.
