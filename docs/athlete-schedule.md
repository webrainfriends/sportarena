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

## App
One schedule, on **Home**: today by default (a quiet "Rest day" when it is empty), with 7- and 30-day ranges, kind filters, a "needs your response" inbox and overlap warnings. Items are colour-coded on the left edge (match red, coaching blue, health green). The Player tab no longer has a separate Today screen; it opens on **My sports**.
Related merges in the same pass: one add-sport sheet and one make-default helper (Home, My sports and Me share them); Favourite sports live only in My sports; physios and doctors are found and booked only under Health → Find a pro (with search, remote/verified filters and sorting), and Me no longer repeats the Hub shortcuts.

## Calendar, personal blocks and RSVP (migration 038)
* **Month view.** Home -> My schedule -> *Calendar* shows a dot per kind of commitment on each day; tap a day to list it.
* **Block time** (`create_athlete_block`, `list_athlete_blocks`, `archive_athlete_block`, tag *Athlete*): recovery, gym, rest or other personal time on your own calendar. Day and times come from the pickers; only a kind and an optional short label are stored (`athlete_blocks`). They appear as schedule kind `recovery` and are flagged if they overlap a match or training. Removing one archives it (`status`, `archived_at`); rows are never deleted.
* **In / Maybe / Out.** Team fixtures, squad selections and team event entries carry `rsvp: { team_id, fixture_id, event_id, value }` (`pending`, `going`, `maybe`, `no`). The buttons call the existing `set_event_rsvp`, so there is one attendance record per person and managers see it in the team schedule. Items that are not team commitments have `rsvp: null`.
