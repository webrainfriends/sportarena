# Official availability and scheduling preferences (#994, REF-R03)

One record of an official's own time, enforced by the server on every request, shown to organisers as free / busy only.

## What existed and what was the gap

Availability first shipped with the Officials Command Center (#88). This work extends that code; it does not add a second module.

| Scope item | Before | Now |
|---|---|---|
| Weekly hours | Stored, only flagged in the calendar | Checked at invite; optional season (`valid_from` / `valid_to`); the official chooses warn or refuse |
| Time off | One-off blocks | One-off, repeating (weekdays, every n weeks, skipped dates), public holidays; editable; category; encrypted private note |
| Holiday windows | None | Picked from the shared `holiday_calendar_days` catalogue (`list_holidays`) |
| Tentative offers | Listed as requests | A tentative hold in the calendar and in organiser free / busy; rivals flagged; other organisers told on accept; optional one-per-slot |
| Accepted fixtures | Advisory lock and clash check | Unchanged lock; plus daily / weekly / consecutive-day caps; cancel releases the slot and says so |
| Buffers | One gap | Travel gap plus an optional shorter same-venue gap; minimum notice |
| Preferred sports / levels | Columns with no screen | Screen, validation against catalogues, roles and age groups, used in suggestions |
| Travel area | Stored, unused; pool leaked coordinates | Distance band and coarse region only; stated range honoured in suggestions |
| Time zones | One zone, UTC bucketing in the pool | Wall-clock rules expanded per zone; venue time shown beside the official's |
| Update conflict | Blind overwrite | Versioned; `409` with `details.code = "stale_version"` |
| History | None | Append-only `official_availability_history` |

## Model

`official_availability` holds every kind of row; `official_prefs` holds one row of preferences per official. Migration `198_official_availability_r03.sql` is additive.

| `kind` | Meaning | Anchored in |
|---|---|---|
| `weekly` | Hours open to officiate (minutes from local midnight) | the official's zone |
| `blackout` | One-off time off between two instants | instants |
| `recurring` | Repeating time off | the zone saved on the row |
| `holiday` | A public holiday, one whole local day | the zone saved on the row |
| `available` | A one-off extra open window | instants |

Nothing is deleted: rows are archived (`archived_at`), and each change is written to the history without the note.

## Rules (`apps/api/src/official-availability.js`)

`assess()` is the only place an official's time is evaluated. It is called by invite, accept, reschedule, emergency cover, bulk invite, suggestions, the organiser pool and the organiser free / busy view.

- **Always enforced:** time off of every kind; no overlap with confirmed work, including the gap.
- **Enforced on a new request only:** refused hours (when the official chose that), minimum notice, daily / weekly / consecutive-day caps, one tentative request per slot.
- The official's own acceptance and an organiser re-timing an agreed match are held to the first group only.

Refusals are `409` with a `details.code` (`time_off`, `clash`, `buffer`, `outside_hours`, `short_notice`, `day_cap`, `week_cap`, `consecutive_days`, `tentative_overlap`). The message never carries a reason, a note or a place.

## Privacy

- Organisers get free / busy spans with a state only, a coarse region the official chose, and a distance band. Never notes, categories, coordinates, an exact distance, or details of other matches.
- `list_event_official_pool` no longer returns `base_lat` / `base_lng`; `suggest_fixture_officials` returns `dist_band`, not kilometres.
- `get_fixture_official_availability` answers `404` to anyone who does not run the event, and each look is written to `audit_log`.
- The private note is stored in `note_enc` (field-level encryption).

## Capabilities (REST, OpenAPI and MCP from one definition)

| Capability | Route |
|---|---|
| `get_my_official_availability` | `GET /me/officials/availability` |
| `save_my_official_prefs` | `POST /me/officials/availability/prefs` |
| `set_my_weekly_availability` | `POST /me/officials/availability/weekly` |
| `add_my_time_off` | `POST /me/officials/availability/time-off` |
| `update_my_time_off` | `PATCH /me/officials/availability/:id` |
| `remove_my_time_off` | `POST /me/officials/availability/:id/remove` |
| `add_my_holiday_windows` | `POST /me/officials/availability/holidays` |
| `add_my_extra_availability` | `POST /me/officials/availability/open` |
| `preview_my_availability_change` | `POST /me/officials/availability/preview` |
| `list_my_availability_history` | `GET /me/officials/availability/history` |
| `get_fixture_official_availability` | `GET /fixtures/:id/officials/:user_id/availability` |
| `get_official_calendar` | `GET /me/officials/calendar` |

## App

The Availability and Calendar tabs of Officials home (`apps/app/src/screens/officials-availability.js`, `officials-calendar.js`). Organisers open the free / busy view (`official-availability-sheet.js`) from the Availability button on each official in the assignment board's suggestions and in bulk invite; it calls `get_fixture_official_availability`. The time-zone field in every form is a searchable dropdown of all IANA zones (`ZonePicker` in `apps/app/src/FormSheet.js`). The profile wizard's availability step now shows what is saved there instead of keeping its own form.

## Sports

Availability is sport-neutral: every sport in the catalogue is covered natively, and `test/officials-availability.test.js` walks the whole catalogue. Match length always comes from `fixtures.duration_min`.

## Tests and screenshots

- `apps/api/test/officials-availability.test.js`
- `node scripts/e2e/officials-availability-journey.mjs` (phone, tablet, desktop; light and dark; Urdu right to left)
