# Find & Join Games (issue #508)

"Where can I play today, and who can I play with?" One capability set (`apps/api/src/capabilities/open-games.js`, tag *Find & Join Games*) exposed as REST, OpenAPI and MCP tools, and one set of screens (`FindGames`, `OpenGame`, host sheet) that run on iOS, iPadOS, Android and web.

## Reuse map: matching need → canonical source → safe data → gap → extension

| Need | Canonical source (reused) | Safe data used | Gap | Extension |
|---|---|---|---|---|
| The game itself | `games` (+ organizer `associations`) | sport, title, time, venue/resource/public place | no marketplace terms | `open_games` (1:1 with `games`): seats, level range, cost, approval, visibility, audience, cancellation rule |
| Venue / slot | `venues`, `resources`, `bookings`, `reservations` | venue name/city/coordinates, booking status and time | an open game must never hold a slot | `booking_id` links the host's **confirmed** booking; state is read live (`confirmed` / `unbooked` / `cancelled` / `no_venue`); a worker step follows moves and cancellations |
| Venue suggestions | `list_venues` (sport + availability window + distance) | public venue data | none | the host sheet calls `list_venues`; no second venue search was added |
| Booking | `create_reservation`, `BookFlow` | — | none | "Book this slot" opens the normal booking flow; "Link a booking" attaches it |
| Player level and sports | `sport_profiles.level` | sport, level the player declared | none | level range uses the same four levels |
| Availability | `availability_windows` | weekly windows (used only to rank, never returned) | none | `fits_availability` is computed in SQL and only ever explained as "Fits your weekly availability" |
| Seats / waitlist | new `open_game_members` | status only | none | one row per person per game, row kept for history; waitlist is FIFO by request time |
| Waitlist for sold-out *venue slots* | `waitlist_entries` (venues) | — | different thing | left untouched |
| Need players for a fixture / a team | `games`, `teams`, `canManageTeam` | team name | none | `team_id` and `fixture_game_id` on the open game; joining never touches `team_members` |
| "Players wanted" posts | Billboard `match_players` | — | overlapped Find & Join | **merged**: Billboard no longer offers to create a "Players for a match" post; it points to hosting a game. Existing posts, responses and the recruitment pipeline are untouched and still listed |
| Chat | team chat pattern | — | team chat is permanent | `open_game_messages`: host + confirmed players, closes 48 h after the game, rows kept |
| Notifications | `notify` | generic wording, dedupe keys | none | kinds `open_game_*`; a tapped notification opens the game |
| Youth / guardians | `youth.js` (`requireGuardian`, `requireConsent`, `hasConsent`) | counts only | none | see *Youth* |
| Verification | `badgesFor` | verified badge | none | shown on hosts and requesters |
| Sports history | `game_participants` | attended players | none | `complete_open_game` records attended players, exactly as a fixture does |
| Payments | `payments` | — | online collection of a player-to-player share needs a payout/ledger design | **gap, see below**: shares are tracked, not collected online |

## Journeys

* **Host** — `host_open_game`: sport, date/time/duration, a venue or a public place, seats (max / needed), level range, format, roles, audience and age band, cost mode (`free`, `per_player`, `split_total`) with currency, approval (`host` or `auto`), visibility (`public`, `team`, `link`), cancellation cut-off. Link a confirmed booking with `booking_id` (must be yours or your venue's, confirmed, covering the whole game, for a court of this sport, not backing another game). `update_open_game` notifies people of a time/place change; seats cannot drop below confirmed players, the price is locked once others hold a seat, raising seats promotes the waitlist. `cancel_open_game` tells everyone, waives unsettled shares and tells the host the booking is still active (it is **not** cancelled for them).
* **Find** — `find_open_games`: sport, `when` (now / today / tomorrow / weekend / week, in the caller's time zone) or dates, distance from a point the app sends for the request (never stored), level, format, cost, free seats, verified host, team. `sort=best_match` ranks by the caller's sport profiles, level fit and weekly availability and returns `reasons` for each game. `mine=true` lists games you host or hold a place in.
* **Join** — `join_open_game` → `requested` / `confirmed` / `waitlisted` / `guardian_pending`. Auto-approve only takes players who are not outside the stated level range; anyone else waits for the host. `leave_open_game`, `decide_open_game_request` (approve / decline / remove), `set_open_game_share` (due / settled / waived), `check_in_open_game`, `mark_open_game_attendance`, `complete_open_game`.
* **Need players** — `suggest_open_game_players` (opt-in, adult, plays the sport, not already in; ranked by level fit, a free weekly slot, verified identity; reasons returned; never by payment) and `invite_to_open_game`. The host's request list is ranked by the same visible criteria (`rank_criteria` is returned with it).
* **Chat** — `send_open_game_message` / `list_open_game_messages`.
* **Trust** — `get_open_game_facts` returns **counts** (played, no-shows, late cancellations, under review) to the person, their guardian, a host they asked, and the platform team. No score, no label. `raise_open_game_appeal` / `resolve_open_game_appeal`: the host can only *correct*; *upholding* is a platform decision.

## Privacy and safety rules (enforced on the server)

* Discovery shows the venue or a host-named public place, the host, counts and adult players only. No participant address, calendar, e-mail, phone or date of birth is ever returned. A test scans the public payload for those words.
* The caller's position is a query parameter, rounded by the app to ~100 m, never stored. A public place has no coordinates unless the API caller supplies them; the app only asks for a name and a city.
* Suggestions need an explicit opt-in (`open_game_prefs`, off by default); young people cannot opt in.
* Age bands use the encrypted date of birth; decryption is audit-logged (`open_game_age_check`).
* **Youth** — adult-only is the default audience. A young person can only join a game whose audience allows them. Asking for themselves puts the request in `guardian_pending` (no seat held) and notifies verified guardians; a guardian can approve (needs current *participation* consent) or join for the child with `on_behalf_of`. Young players are counted, never named, in public views; their guardians (not them) are notified, can check them in and use the game chat. Withdrawing consent stops promotion from the waitlist and stops new actions. A young person cannot host.
* Young players' games are hidden from adults who are not guardians in discovery, and adult-only games are hidden from young players.
* No pay-to-rank anywhere: ranking inputs are listed in the API response.

## Concurrency and idempotency

Every seat change runs under `SELECT … FOR UPDATE` on the `open_games` row, so capacity, promotion and retries are serialised. Joins are idempotent (unique `(open_game_id, user_id)`, plus an optional `idempotency_key`); leave, approve, decline, complete, cancel and share changes are safe to repeat. Tests fire eight simultaneous joins at a four-seat game and check exactly four seats, five waitlisted, and one promotion per freed seat.

## Sports coverage

The model is sport-neutral (seats, level, cost, format, roles); it has no scoring or rules of its own, so there is no per-sport family to model and **no sport uses a silent default**. A test hosts, finds and joins a game for **every sport in the catalogue**. Sport-specific result entry stays in the existing scoring capabilities for the game that is created.

## Gaps (stated honestly)

* **Online collection of a player's share** is not built. Collecting money from players for another person needs a payout and settlement design (who is the payee, fees, refunds, tax). Today the share is shown to everyone up front, players pay the host or the venue directly (the venue invoice for the linked booking is the canonical payment), and the host records `settled` / `waived` with an idempotent endpoint. Needs a maintainer decision.
* Nearby search on a phone needs the OS location permission (`expo-location`, added). It could not be exercised on a physical iOS/iPadOS/Android device from this environment; the web build was rendered at phone, tablet and desktop widths.

## Data safety

`120_open_games.sql` is additive (new tables only). Nothing is deleted: leaving, declining, removal and cancellation change `status`; messages are hidden, never removed; appeals keep their history.
