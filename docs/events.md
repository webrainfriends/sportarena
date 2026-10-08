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
Entry-fee collection and ticketing (payments purpose), volunteer/coach opportunities, sponsorship discovery, reschedule clash re-check, IPTC `spEventStatus` mapping for competitions.
