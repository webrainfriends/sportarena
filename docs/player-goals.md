# Player-owned goals and self-directed training (issue #325, review item 16/28)

Child of the Player transformation (#310). A player sets goals and plans their own training; a coach sees only what the player shares and can assess or adopt it. The player's claims and the coach's view are stored and shown separately.

## Baseline reused, gaps closed
- Existing: coach-led `coaching_goals` / `training_plans` (a coach authors, the athlete only sees what is shared or answers a proposal), `/me/development` as the player's one home, `requireRelationship` (current coaching relationships), `CONSENT_OK` / `requireCoachingConsent` (guardian consent for young people), guardian read path.
- Added: player-authored goals (`player_goals`) and plans (`player_plans`) with progress, review dates, optional per-coach sharing, coach assessments and coach adoption. Nothing existing is rewritten; adoption creates the coach's **own** `coaching_goals` row or draft `training_plans` row.
- Small baseline fix: `list_training_plans` no longer lists a coach's *draft* plan to the athlete (the filter `p.athlete_id=$1 OR ...` made the draft guard a no-op; `get_training_plan` already hid draft revisions).

## Schema (migration `108_player_goals.sql`, additive only)
| Table | Purpose |
|---|---|
| `player_goals` | the athlete's goal: title, category, why, measure, target + unit, review/cadence dates, `status` (active/paused/achieved/dropped = the athlete's **claim**), `row_version`, `client_key` (idempotent create) |
| `player_goal_events` | status history (append-only) |
| `player_goal_progress` | self-reported progress (value in the goal's unit and/or note), append-only, idempotent by `client_key` |
| `player_plans`, `player_plan_sessions` | self-directed plan and its sessions (kinds shared with coach plans); recorded outcomes are final |
| `player_shares` | live/revoked share of one goal or plan with one coach (`revoked_at`, never deleted) |
| `player_assessments` | a coach's rating + note on a shared item, append-only, apart from the athlete's claim |
| `player_adoptions` | links an item to the coach's own `coaching_goals` / `training_plans` row; one per (item, coach) |

No `DROP`/`DELETE`/`CASCADE`; soft states only.

## Endpoints (each is one `cap(...)`: REST + OpenAPI + MCP)
Player: `POST /me/goals`, `PATCH /me/goals/:id` (needs `row_version`), `GET /me/goals`, `GET /me/goals/:id`, `POST /me/goals/:id/progress`, `POST /me/personal-plans`, `PATCH /me/personal-plans/:id`, `GET /me/personal-plans`, `GET /me/personal-plans/:id`, `POST /me/personal-plans/:id/sessions`, `PATCH /me/personal-plan-sessions/:id`, `GET /me/coaches`, `POST /me/shares`, `DELETE /me/shares/:id`, `GET /me/goals-export` (CSV).
Coach (role `coach`): `GET /coaching/player-shared?kind=goal|plan`, `GET /coaching/player-shared/:kind/:id` (audited), `POST /coaching/player-shared/:kind/:id/assessments`, `POST /coaching/player-shared/:kind/:id/adopt`.
Workspace: `GET /me/development` gains sections `my_goals` and `my_training`, and next actions for personal goal reviews and upcoming personal sessions.

## Rules
- **Ownership**: only the owner edits; a guardian of a young person can read (and export) but not change, audited as `read_child_player_goals`.
- **Claim vs assessment**: a goal's status is always the athlete's claim; a coach assessment never changes it. API rows carry `basis` (`athlete_reported` / `coach_assessment` / `athlete_set`) and the screens label both lines.
- **Sharing**: only with a coach who currently coaches the athlete (hire, shared team, cohort, accepted plan). Young people need a guardian's current `coaching` consent to share. The coach sees only that item, never who else it was shared with.
- **Live revocation**: every coach read and write re-checks the live share, the current relationship and (young people) current consent in the same request, so revoking, ending the relationship or withdrawing consent hides it at once. Past assessments stay with the athlete.
- **Adoption**: goal -> a `planned` coaching goal (athlete wording = their title); plan -> a coach-authored **draft** training plan with the future sessions, which the athlete still accepts through the normal propose/respond flow. Adopting twice returns the first adoption.
- **Failure behaviour**: stale `row_version` -> 409; recorded session outcomes are final (repeating the same outcome is accepted without overwriting); idempotency keys make create/progress/session/assessment retries safe; shares and adoptions are race-safe through partial unique indexes and row locks.
- **Export**: one CSV of goals, progress, plans, session outcomes and received assessments with a `basis` column.

## App
`screens/player-goals.js`: `MyGoalsBlock` and `MyTrainingBlock` inside `MyDevelopment` (Player > Development) and `SharedByPlayers` inside the existing coach *Goals & actions* screen. Controls follow the app rules: sport picker, kind/unit/cadence chips, calendar for dates, time picker, steppers for effort and minutes. Loading, empty, success (toast) and error (retry) states throughout.

## Tests
`apps/api/test/player-goals.test.js` (PostgreSQL): validation, idempotent create/progress/session/assessment, stale versions, final outcomes, sharing eligibility, coach scope and revocation (including relationship end), adoption of goal and plan, guardian read-only and audit, consent withdrawal and restore, development sections and CSV export.
