# Multi-sport events (sports day, Olympics-style games)

One event, many sports. A school sports day, a club festival or a regional games runs as a **programme** inside a
normal event: several *disciplines* (sports), *houses* (or groups/classes/regions) that points roll up to, people who
can be nominated into more than one sport, qualifying rounds → finals, **one timetable in which nobody is in two places
at once**, hired officials and medical cover, a points ledger (individual, team, house), certificates, trophies and
announcements. Everything is a capability, so the same operations are REST routes, OpenAPI operations and MCP tools
(tag **Multi-sport events**). The app screen is `Event → Run the games programme`.

Create the event with sport `multi-sport`, then `PATCH /events/:id/programme` (`setup_multi_sport`).

## What it covers

| Need | How |
|---|---|
| Choose the sports | `create_discipline` — individual or team, gender / grade eligibility, team size, entries per house, points per place, officials needed |
| Houses / groups | `create_house` (kind house, group, class, region, club; optional **house master** who can nominate, build teams and message their own house) |
| People (with or without accounts) | `add_participant`, `import_participants` (roster up to 2000 rows, dry run, row errors, houses created on the fly). Link an account later with `update_participant` |
| One person, several sports | `nominate_participant` / `nominate_many`. Limits per person (`max_individual_entries`, `max_team_entries`), entries per house, gender/grade eligibility and medical holds are enforced under a per-person lock |
| Build teams | `create_discipline_team` (size, house membership, one team per house when limited) or `build_house_teams` (one team per house from the nominated pool; short houses are reported, extras stay reserves) |
| Qualifying rounds | `generate_heats` (balanced snake-draft by personal best, best seeds spread, centre lanes to the best; a field that fits one race goes straight to a final) → `advance_discipline` (top *k* per heat + wildcards → semi-final heats or the final) |
| Team fixtures | `generate_team_draw` (round robin or seeded knockout with byes) → `advance_discipline` (league → knockout of the top *N*; winners → next round; optional third-place game) |
| Conflict-free schedule | `auto_schedule` (days, hours, lunch breaks, parallel grounds; dry run first) and `update_session` (manual). A person may not be in two sessions that overlap **or** closer than `rest_gap_min`, whichever sport each belongs to (team members count through their team); a ground cannot be double-booked; a later round cannot start before an earlier round of the same discipline has ended; crew cannot be double-booked. `check_schedule_conflicts` audits everything |
| Results | `record_session_results` — organiser or the official assigned to that session. Ties share a place; knockouts must be decided; corrections re-rank (and flag `refinalize_required`) |
| Points | `finalize_discipline` writes placement + participation points to a ledger (people, teams, houses); safe to re-run after a correction (old rows are **voided**, never deleted). `award_points` for bonuses/penalties, `void_points`, `get_games_leaderboard` (house with gold/silver/bronze, individual, team, per discipline) |
| Certificates & trophies | `issue_certificates` (podium + optional participation, every member of a winning team, once only, each with a verification code), `issue_certificate`, public `get_certificate` (verify by code), `revoke_certificate`; `create_trophy` / `award_trophy` (auto-award to the leader; ties are never broken silently) with holder history |
| Referees, physios, doctors | `find_event_crew` → `invite_event_staff` (agreed rate; a doctor post needs the doctor role, physio the physio role, officiating posts the referee role and, optionally, a sport) → `respond_event_staff` → `assign_shift` (officiate a session, or medical cover/duty over a window) → `get_staffing_gaps` (sessions short of officials, sessions with no medical cover) → `record_staff_payment`, `release_event_staff` |
| On-site medical | `report_medical_incident` (event doctors/physios/first aiders only). Clinical text is **encrypted** and every read is audit-logged; the organiser sees severity, outcome and fitness only. "Not cleared" puts the participant on a **medical hold** (cannot be nominated, flagged on the timetable) until a later "cleared" |
| Communications | `send_announcement` to everyone, a house, a sport, one session or the crew — reaches participants with accounts, house masters, assigned crew and the **active guardians of young participants**. `list_announcements` shows each person only what is theirs |
| Participants' view | `get_my_games`, `list_my_certificates`, `list_my_event_duties`; their sessions also appear in the unified `get_my_sport_schedule` |
| Organiser control room | `get_games_dashboard` — counts, clashes, unscheduled sessions, staffing and medical-cover gaps and a "to do next" list |

## Privacy

Many participants are children. By default `public_names` is **off**: public endpoints (`get_multi_sport`,
`list_sessions`, `get_discipline_results`, `get_games_leaderboard`, `list_trophies`) show houses, counts and results
without names. Names are visible to the organiser, assigned crew, a house master (their own house) and the person
themself. Switch `public_names` on to publish a name board. Certificates can be verified by anyone holding the code.

## Data safety

Migration `028_multi_sport_events.sql` is additive (new tables plus one catalogue row, `multi-sport`). Nothing is
deleted: withdrawals, scratches, cancellations and corrections set a status or void a row; points, medical and
certificate history is kept. `complete_event` refuses to close a multi-sport event while a discipline is open
(`force` overrides).

## Limits (by design, for now)

* The timetable does not create venue `bookings`; grounds are free text or a linked `resource` used only for clash checks.
* Result entry is per session. There is no live scoring console or photo-finish import yet.
* Staff payments are recorded, not collected, on the platform.
