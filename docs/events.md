# Events (SPOR-54 / SPOR-56 / SPOR-129)

One canonical event capability (`apps/api/src/capabilities/events.js`); SPOR-54 and SPOR-56 are the same epic and are tracked here together.

## Inventory (what already existed)
create_event, list_events, get_event, update_event, enter_event, list_entries, decide_entry, create_fixture (team/referee/court clash checks), generate_round_robin, reschedule_fixture, record_result, get_standings, complete_event (podium awards).

## Added in migration 016
| Gap | Now |
|---|---|
| Search | `GET /events/search` (`search_events`): `q` (name/description/city), `sport`, `kind`, `status`, `city`, `date_from`/`date_to` (overlap), `open_for_entry`, `free`, `max_fee_cents`, `seeking_sponsors`, `verified`, `organizer_id`, `sort` (`soonest`/`newest`/`fee_low`), `limit`/`offset`. Returns `{items,total,limit,offset}`; each card carries `link`, `entrants`, `spots_left`, `registration_open`, verified badges. `list_events` keeps its plain-array shape on the same filters. |
| Capacity / deadline | `events.capacity`, `events.registration_deadline`; `enter_event` locks the event row, refuses after the deadline, and puts entrants on a **waitlist** when pending+accepted ≥ capacity. |
| Accept past capacity | `decide_entry` refuses (409) when accepted ≥ capacity; entrant is notified. |
| Withdraw | `POST /entries/:id/withdraw` (entrant / team manager / admin); frees a spot and promotes the oldest waitlisted entry (notified). Withdrawn entrants can re-register. |
| Status guard | `open → ongoing/cancelled`, `ongoing → cancelled`; `completed`/`cancelled` are terminal. Cancelling notifies entrants. Capacity cannot drop below accepted entries. |
| Sponsor context | `events.seeking_sponsors`, `events.currency` (used by the sponsorship and ticketing slices). |

## Still open (separate slices)
Entry-fee collection and ticketing (payments purpose), volunteer/coach opportunities, sponsorship discovery, IPTC `spEventStatus` mapping for competitions.

## Fixture officials (issue #88, slice 1)
Capabilities: request_fixture_official, respond_fixture_official, release_fixture_official, withdraw_fixture_official, list_fixture_officials, list_my_official_assignments.

* Lifecycle: `invited -> accepted -> completed`, plus `declined`, `withdrawn`, `released`, `cancelled`. Only accepted officials are crew. Every transition is appended to `fixture_official_history` (actor, reason, time); nothing is overwritten or deleted.
* Roles: referee, umpire, linesman, scorer. Non-scorer roles need a `referee` sport profile for the event's sport.
* `create_fixture` / `reschedule_fixture` with `referee_id` now send an invitation; `fixtures.referee_id` is a projection set when the referee accepts and cleared when they leave.
* Fixtures store `duration_min`; clash checks use each fixture's own duration (no fixed 90 minutes). Accept, invite, create and reschedule share the same eligibility/clash rules (`src/officials.js`), serialised per official with an advisory lock.
* Re-timing a fixture re-validates every open official; confirmed officials get `needs_ack` and are notified, and re-accept to acknowledge. Cancelling closes all open assignments.
* Accepting mirrors an active `associations` row on the fixture's game (if one exists) so game-official permissions keep working.

Not yet built (follow-up slices): referee verification type, availability/calendar, Officials Home UI, idempotent match console, result sign-off, incident reports.

## Tournament management (migration 027)
One organiser console (`EventAdmin` screen, reached from **Organizer tools → Tournament console**) over these capabilities (REST + OpenAPI + MCP, tag *Tournament*, *Event staff*, *Event vendors*):

**Invitations, rules, seeding** (`event-invites.js`)
* `suggest_event_invitees` ranks teams (or individuals by performance points) of the event's sport from past results. Strength is computed, never stored: recency-weighted points + goal difference per game, shrunk toward the field average so small samples do not top the list (`src/tournament/ranking.js`).
* `set_event_rules` / `list_event_rules`: `invite_top_n`, `min_rating`, `min_games`, `city`, `exclude_team`, `seeding` (rating|standings), `note`. Replacing rules keeps the old ones as removed history.
* `invite_to_event` (bulk teams/individuals), `list_event_invitations`, `list_my_event_invitations`, `respond_event_invitation` (accepting registers the entrant as *accepted*, capacity respected, a seed hint becomes a pinned seed), `withdraw_event_invitation`.
* `compute_event_seeds`, `set_event_seed` (manual pin; others renumber around it), `list_event_seeds`.

**Schedule, holidays, brackets** (`event-schedule.js`)
* `preview_event_schedule` (dry run) / `generate_event_schedule` for `round_robin` or `knockout`. Games are fitted into the venue's free court slots (opening hours/timetable, venue blocks, existing bookings) in the venue's time zone, skipping event blackout days, the venue country/city public holidays and chosen weekdays off. No team, court or (already booked) official is double-booked, a team gets rest between games, at most N games per day. If everything does not fit nothing is written and the unplaced games are returned. Courts are booked atomically.
* Calendar: `add_event_calendar_days` / `list_event_calendar_days` / `remove_event_calendar_day`; public holidays: `add_holidays` / `list_holidays` / `remove_holiday` (entered by users, nothing shipped).
* Knockout: standard 1-v-N seeding, byes for the top seeds when the field is not a power of two (up to 32 teams), round of 32/16 → quarter → semi → final, optional third place. Later-round fixtures hold placeholders ("Winner Quarter-final 1") that fill in as `record_result` is called; a level knockout game needs `winner_team_id` (e.g. penalties); a result cannot change once the next round has started. `get_event_bracket` returns the rounds and champion. `complete_event` awards cup/silver/bronze from the final and third-place game. Group standings ignore knockout games.
* Individual (non-team) entrants can be invited and registered but are not scheduled; fixtures are team-based.

**Staff** (`event-staff.js`): `define_staff_role` (referee, umpire, linesman, scorer, doctor, physio, medic, volunteer, security, other; headcount + fee), `list_staff_roles`, `close_staff_role`, `search_staff_candidates`, `invite_staff`, `respond_staff_assignment`, `end_staff_assignment`, `list_event_staff`, `list_my_staff_assignments`. Referee roles need a referee sport profile for the sport; doctor/physio need a matching provider profile; provider time off and clashes with the person's other events on the same dates are refused. Every transition is appended to `event_staff_history`. Match-level officiating stays with the fixture-officials capabilities.

**Vendors, retail, sponsors** (`event-vendors.js`): `invite_event_vendor` (retail, catering, sponsor, other), `respond_event_vendor` (accepting a sponsor invitation records an active event sponsorship), `end_event_vendor`, `list_event_vendors`, `attach_event_product` / `detach_event_product` / `list_event_products` (shop products of confirmed retail vendors), `get_event_commercials` (entry fees, sponsorship, vendor fees, staff cost; recorded only, no payment collection).

All tables are additive and nothing is deleted: invitations, rules, seeds, calendar days, staff and vendor places end in a status or `removed_at`.
