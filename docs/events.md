# Events (SPOR-54 / SPOR-56 / SPOR-129)

> Running an event end to end (pause/resume, departments, boards, live scoring, score-sheet approval, AI help): see [event-command-centre.md](event-command-centre.md).

One canonical event capability (`apps/api/src/capabilities/events.js`); SPOR-54 and SPOR-56 are the same epic and are tracked here together.

## Inventory (what already existed)
create_event, list_events, get_event, update_event, enter_event, list_entries, decide_entry, create_fixture (team/referee/court clash checks), generate_round_robin, reschedule_fixture, record_result, get_standings, complete_event (podium awards).

## Added in migration 016
| Gap | Now |
|---|---|
| Search | `GET /events/search` (`search_events`): `q` (name/description/city), `sport`, `kind`, `status`, `city`, `date_from`/`date_to` (overlap), `open_for_entry`, `free`, `max_fee_cents`, `seeking_sponsors`, `verified`, `organizer_id`, `sort` (`soonest`/`newest`/`fee_low`), `limit`/`offset`. Returns `{items,total,limit,offset}`; each card carries `link`, `entrants`, `spots_left`, `registration_open`, verified badges. `list_events` keeps its plain-array shape on the same filters. |
| Capacity / deadline | `events.capacity`, `events.registration_deadline`; `enter_event` locks the event row, refuses after the deadline, and puts entrants on a **waitlist** when pending+accepted ≥ capacity. |
| Accept past capacity | `decide_entry` refuses (409) when accepted ≥ capacity; entrant is notified. |
| Sub-teams | A team entering an event may enter its master team or a sub-team created for that event (see [teams.md](teams.md#master-team-and-sub-teams)); RSVP/attendance works for either. |
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

## Tournament management (migration 029)
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

**Staff** (`event-staff.js`): `define_staff_role` (referee, umpire, linesman, scorer, doctor, physio, medic, volunteer, security, other; headcount + fee), `list_staff_roles`, `close_staff_role`, `search_staff_candidates`, `invite_staff`, `respond_staff_assignment`, `end_staff_assignment`, `list_tournament_staff` (`GET /events/:id/staff-assignments`), `list_my_staff_assignments`. Referee roles need a referee sport profile for the sport; doctor/physio need a matching provider profile; provider time off and clashes with the person's other events on the same dates are refused. Every transition is appended to `event_staff_history`. Match-level officiating stays with the fixture-officials capabilities. Events run as multi-sport programmes (`docs/multi-sport-events.md`) use that module's own crew capabilities (`invite_event_staff`, shifts) instead.

**Vendors, retail, sponsors** (`event-vendors.js`): `invite_event_vendor` (retail, catering, sponsor, other), `respond_event_vendor` (accepting a sponsor invitation records an active event sponsorship), `end_event_vendor`, `list_event_vendors`, `attach_event_product` / `detach_event_product` / `list_event_products` (shop products of confirmed retail vendors), `get_event_commercials` (entry fees, sponsorship, vendor fees, staff cost; recorded only, no payment collection).

All tables are additive and nothing is deleted: invitations, rules, seeds, calendar days, staff and vendor places end in a status or `removed_at`.

## Event venues and court bookings (`event-venues.js`)
* `find_event_partners` (kind `venue`) and `find_venues_for_sports` now list **live** venues that have courts for the event's sport **or all-purpose courts** (a court with no sport set suits every sport). A multi-sport event with no sports chosen yet sees every venue that has courts. Venues still awaiting platform approval are hidden.
* `get_event_venues` — every venue the event uses (chosen venue, open/finalized venue requests, court bookings including those made by the tournament scheduler) with its bookings, courts, slots and cost so far.
* `preview_event_venue_booking` / `book_event_venue` — pick a venue, the event days and a daily time window; shows each court-day as free / booked / blocked / closed / skipped (opening hours, venue blocks, existing bookings, event blackout days and public holidays) with the price. Booking is all-or-nothing unless `skip_unavailable`; it adds a planned *venue* line to the event budget and sets the event venue if it has none.
* `release_event_booking` — release one booking (the venue's cancellation policy decides any refund).
* **Dates must match the event.** The preview returns `alignment`: the requested days vs the event's start/end dates (days booked before it starts or after it ends, an opening/closing day with no court, the spend that would be wasted and a trimmed alternative). If they differ, `book_event_venue` answers `409` with `details.consent_required` until the organiser repeats it with `accept_mismatch=true` (the consent is audit-logged and noted on the budget line). The same consent applies to `generate_event_schedule` / `preview_event_schedule` (games outside the event dates) and to `create_fixture` with a court. The app pre-fills the event's own dates and asks for an explicit "book anyway" tick.
* `get_event_fit` (`GET /events/:id/fit`) — the efficiency check across the event: compares every court booking with the games and programme sessions actually scheduled there, and with venue/vendor/staff requests dated outside the event. Each booking is `used`, `underused`, `unused`, `wasted_before` (booked before the first game at that venue or before the event starts), `idle_after` (after the last game or after the event ends) or `unplanned` (no games scheduled yet), with the wasted spend, findings ranked by severity and a keep-vs-release comparison listing the future idle slots that can be released. It is a deterministic comparison (no model is called), exposed as REST and as an MCP tool so agents and the app get the same answer. App: the *Schedule & budget fit* card on **Venue & courts**.
* Venue side: `venue_schedule` bookings carry `event_id`, `event_name` and the event dates; the **Today** board labels them 🏆 and a *Next 30 days* list (with an events filter) shows everything booked, including tournament court bookings.
* App: **Plan & budget → Venue & courts** (find a venue, pick days with the calendar, times with the time picker, courts as chips, see availability, book).

## Tournament console and plan screens (app)
* **Tournament console** (Event → Organizer tools): dark hero with live numbers (teams, games played, court bookings, crew), a *set up your tournament* stepper that jumps to the next missing step, and tabs for Teams (ranked recommendations with strength bars, seeds, invitations, rules as steppers/chips), Schedule (game-day strip, match cards, plan forms with calendar range, steppers and switches), Bracket (a real tree with connectors, byes and a champion banner), Venue (photo cards, courts, release), Crew (positions with fill bars, search-and-invite) and Business (money tiles, sponsor/vendor invites picked from a search list).
* Game times are shown in the **venue's time zone** (`list_fixtures` and `get_event_bracket` return `venue_timezone`).
* **Plan & budget** uses the same hero/tabs and shows the event's venue bookings on the Overview.
* Tests guard the wiring that merges kept breaking: `app-routes.test.js` (every `push('Screen')` target is in `PAGES`), `app-jsx-names.test.js` (every JSX component is imported or declared) and `capability-registry.test.js` (every capability file is registered).

## Open positions, applications and contracts

Positions an organiser opens in the tournament console (**Crew → Open a position**) are a public job board, shown on the landing page, in the member feed and in **More → Open positions**. Crew roles (referee, umpire, linesman, scorer, doctor, physio, medic, volunteer, security, other) and vendor places (`retail`, `catering`, `vendor` — here the *vendor* pays the organiser a stall fee) work the same way. A position can be hidden from the board with `is_public: false`.

| Step | Capability | Who |
|---|---|---|
| Browse | `list_open_positions`, `get_open_position` (public; filter by group, role, sport, city, text) | anyone |
| Apply | `apply_to_position` — needs a login; visitors are sent through sign-in and brought back to the form | any signed-in user (not the organiser) |
| Exchange documents | `PUT /staff-assignments/{id}/documents` (PDF/photo, encrypted), `list_staff_documents`, `GET /staff-documents/{id}/file`, `remove_staff_document` | applicant and organiser |
| Accept → contract | `decide_application` (`accept` generates a contract with the agreed fee and extra terms; `reject` closes it) | organiser |
| Sign | `respond_event_contract` — accepting confirms the place (and makes a vendor a vendor of the event); declining reopens it | the applicant |

Status flow of an application: `applied → contract_sent → accepted` (or `rejected`, `declined`, `withdrawn`, `released`). Nothing is deleted: contracts are voided, documents hidden, every transition is in `event_staff_history`. Credentials are not required to apply (the organiser judges); calendar clashes and time off are checked when the contract is signed. Vendor fees count as income, not crew cost, in `get_event_commercials`.
