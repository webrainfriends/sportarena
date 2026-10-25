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
One schedule, under the **Schedule** tab (Home shows the next 7 days as reminders and links here): today by default (a quiet "Rest day" when it is empty), with 7- and 30-day ranges, kind filters, a "needs your response" inbox and overlap warnings. Items are colour-coded on the left edge (match red, coaching blue, health green). The Player tab has no Today screen; it opens on **My sports**, next to **Insights**.
Related merges in the same pass: one add-sport sheet and one make-default helper (Home, My sports and Me share them); Favourite sports live only in My sports; physios and doctors are found and booked only under Health → Find a pro (with search, remote/verified filters and sorting), and Me no longer repeats the Hub shortcuts.

## Calendar, personal blocks and RSVP (migration 038)
* **Month view.** Home -> My schedule -> *Calendar* shows a dot per kind of commitment on each day; tap a day to list it.
* **Block time** (`create_athlete_block`, `list_athlete_blocks`, `archive_athlete_block`, tag *Athlete*): recovery, gym, rest or other personal time on your own calendar. Day and times come from the pickers; only a kind and an optional short label are stored (`athlete_blocks`). They appear as schedule kind `recovery` and are flagged if they overlap a match or training. Removing one archives it (`status`, `archived_at`); rows are never deleted.
* **In / Maybe / Out.** Team fixtures, squad selections and team event entries carry `rsvp: { team_id, fixture_id, event_id, value }` (`pending`, `going`, `maybe`, `no`). The buttons call the existing `set_event_rsvp`, so there is one attendance record per person and managers see it in the team schedule. Items that are not team commitments have `rsvp: null`.

## Calendar sync and availability (issue #331)

Extends the combined schedule; nothing is duplicated. `buildSchedule()` in `capabilities/athlete-schedule.js` is the one projection behind the schedule read, the ICS feed and the conflict check.

**Migration `112_calendar_sync.sql` (additive, nothing dropped or rewritten):** `athlete_blocks` gains `version`/`updated_at` and the `travel` kind; `youth_consents` accepts the `calendar_sharing` purpose; new tables `calendar_prefs` (home time zone + version), `availability_windows`, `travel_buffers`, `calendar_feeds`, `calendar_imports`, `calendar_import_events`. Removal is always soft (`revoked_at`, `removed_at`, `archived_at`).

| Capability | REST | Notes |
|---|---|---|
| `get_calendar_sync` | `GET /me/calendar-sync` | time zone, windows, buffers, feeds, imports, `version`; never returns secrets |
| `save_calendar_preferences` | `POST /me/calendar-preferences` | time zone / windows / buffers in one transaction; `version` guard (0 first time), 409 `stale_version`; replaced windows are archived |
| `create_calendar_feed` `update_calendar_feed` `revoke_calendar_feed` `preview_calendar_feed` | `/me/calendar-feeds…` | private ICS subscription; secret shown once, only its hash stored; busy-only by default, health always "Busy", imported calendars are never re-published |
| (public) | `GET /api/v1/calendar/feed/:token.ics` | `text/calendar`; wrong / revoked / consent-withdrawn = 404; fetches are counted and audited |
| `add_calendar_import` `sync_calendar_import` `remove_calendar_import` | `/me/calendar-imports…` | https/webcal ICS address, encrypted (`url_enc`), busy time only (no titles, places, attendees); SSRF-guarded (no private networks, https only, redirects re-checked, 2 MB, 10 s); repeat/concurrent syncs never duplicate; vanished events are marked removed |
| `get_schedule_conflicts` | `GET /me/schedule-conflicts` | overlaps, travel-buffer breaches, outside-availability; real durations (`duration_assumed` only when the source has none); each conflict lists resolutions as capability calls |
| `update_athlete_block` | `PATCH /me/blocks/:id` | version-guarded move/edit |

**Rules:** the schedule shows `kind: external` busy blocks. Team squad fixtures now use the fixture's recorded `duration_min` instead of the old 90-minute assumption. Canonical bookings, appointments and fixtures are never cancelled by sync or conflicts; the only mutations offered are on the person's own blocks and their own RSVP. A young person cannot arrange feeds or imports alone: a verified guardian passes `athlete_id` and needs a current `calendar_sharing` consent; withdrawing it switches the feed off (404) and hides imported busy time at once. Strangers get 404.

**Scope note:** subscription and import are provider-neutral ICS, which Google, Apple and Outlook all support. Direct Google/Microsoft OAuth (two-way write-back) is not implemented and needs provider credentials.

**App:** My schedule → `⚙ Sync` opens *Calendar & availability* (Subscribe / Import / Availability / Travel); the overlap warning has a `Fix →` button that opens the conflict list. A guardian reaches the same panel from Family & guardians → Calendar. Phone: bottom sheet; tablet: centred sheet; wide web (≥1000 px): side column.
