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
