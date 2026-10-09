# Athlete Command Center — schedule (issue #86, phase 1)

`GET /me/sport-schedule` (`get_my_sport_schedule`, also OpenAPI + MCP) is a read-only projection. Nothing is copied or stored, and there is no migration.

| Kind | Canonical source |
|---|---|
| team | `team_squads` (selected/confirmed) on `fixtures` |
| match | `game_participants` / `games` |
| event | `event_entries` (yours) and `events` you organise |
| venue | `bookings` |
| training | `coach_hires` (as hirer or coach) |
| health | `appointments`, `appointment_followups` |

Notes:
- Params: `from`, `to` (default today + 14 days, max 92), `kinds` (comma list), `sport`.
- Each item has `kind, source_type, source_id, sport, title, starts_at, ends_at, timezone, status, action_required, conflict, link, actions`.
- Fixtures have no end time, so 90 minutes is assumed. Events and follow-ups are all-day items and never count as conflicts.
- `conflict` only flags overlapping timed items. Nothing is cancelled or rescheduled.
- Health items are generic ("Appointment"). The reason, notes and instructions are never returned.
- `create_event` now needs only a signed-in user. Owner checks on every other event action are unchanged.

Not in this PR: training plans, medication/adherence, Learn a Sport (depends on #68/#72).
