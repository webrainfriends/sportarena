# Canonical Sports Graph & 360° views (#561)

A real-world entity exists once and is reused everywhere. The graph is a **read layer over the canonical tables**; it never copies a person, team,
event, contract, payment or health record. PostgreSQL stays the source of truth; migration `124_sports_graph.sql` is additive.

## Reuse vs new
| Need | Reused (canonical) | New (graph-owned) |
|---|---|---|
| Person / athlete / coach / official / doctor / physio | `users`, `sport_profiles`, role list | – (agent = `represents` edge) |
| Organisation, club, academy, school, federation, association | `organisations`, `governing_bodies` (an organisation), `governing_body_links` | `part_of` / `member_of` / `affiliated_with` edges for hierarchy that no table holds |
| Team, competition, venue, season | `teams`, `events`, `venues`, `org_seasons` | `competes_in`, `based_at` edges |
| Career, transfers | `career_memberships`; a move is **derived** (consecutive stints ≤ 62 days apart), never stored | – |
| Matches, results, achievements | `match_appearances`, `fixtures`, `games`/`game_participants` (every sport), `awards` | – |
| Contracts | `player_contracts` (+versions): terms only, never money | – |
| Health | `clinical_clearances` through `currentClearance` and the athlete's own `academy_clearance_shares`: status and validity only | – |
| Relationships (effective-dated, provenance, source authority, verification, external ref, history) | – | `graph_edges`, `graph_edge_revisions` |
| Aliases, verified external ids | – | `graph_aliases`, `graph_external_ids` (value encrypted, blind-indexed) |

Existing `get_academy_athlete_360` stays as the academy-scoped lens (coach/finance role split, academy share). The universal 360 does not
repeat its academy sections; it reuses `sharedClearance` for the organisation-shared health availability.

## API (REST + OpenAPI + MCP from one definition, tag *Sports Graph*)
`get_graph_schema`, `graph_search`, `get_graph_entity`, `graph_neighbours`, `create_graph_edge`, `update_graph_edge`, `end_graph_edge`,
`verify_graph_edge`, `get_graph_edge_history`, `add_graph_alias`, `archive_graph_alias`, `add_graph_external_id`, `verify_graph_external_id`,
`archive_graph_external_id`, `get_athlete_360`, `get_organisation_360`, `get_graph_timeline`.

## Rules enforced on the server
* A name never merges identities. Search returns separate *candidates*; only a **verified** external id resolves an identity, and one id can belong to one record.
* Edges are dated (`valid_from`/`valid_to`), overlap- and cycle-checked, versioned (`row_version`), corrected with a revision, ended or withdrawn, never deleted. Verification comes from the other side, never the recorder.
* Visibility: young people the caller may not see are 404 everywhere (search, 360, timeline). Person-linked edges are private to the person, guardian and the other end's managers; agent representation is never public. Organisation people lists are staff-only.
* Sections the caller may not see are returned as `forbidden`; timeline lists them in `hidden_domains`.
* Health is availability only, shown to the athlete/guardian or an organisation the athlete shared with (live revocation); every health read, external-id read and edge change is audit-logged.

## Sport coverage
Results use the ontology's sport-neutral model (`outcome`, `rank`, `score`, `score_units`), so each family keeps its own units and no sport falls back to a silent default; a test walks the whole sports catalogue. Every entity in the issue is on the graph except **Ticket**, for which the platform has no ticketing store to link (event budgets only plan ticket revenue); `get_graph_schema` reports it as `gap`. Modules that own their data are read at request time by `graph-sources.js` and appear on the timeline with a link back to the source record:

| Domain | Source | Audience |
|---|---|---|
| registration (with division) | `reg_registrations`, `reg_divisions` | person, guardian, registering team managers; org staff |
| accreditation | `accreditations` | person, guardian; org staff (their events) |
| travel | `trips`, `trip_participants` | person, guardian; org staff |
| payment | `payments` | payer only |
| invoice | `invoices` | bill-to; organisation staff (their venues) |
| sponsorship | `sponsorships` | person, guardian, the sponsor's owner; public for a team or event |
| assessment | `academy_assessments` (approved) | person, guardian; org owners and admins |
| media | `mr_assets` | published public assets for everyone; staff also see unpublished |
| training | `training_sessions` | person, guardian, their coach |
| opportunity | `billboard_responses` | person, guardian |
| supplier | `svc_orders`, `svc_profiles` | organisation staff |

## Migration plan
`124_sports_graph.sql` only adds four tables and indexes. No existing row is touched, nothing is backfilled or dropped.

## App (iOS, iPadOS, Android, web)
`SportsGraph` (search), `Athlete360`, `Organisation360` use the shared Expo components and theme tokens (`ui.js`, `FormSheet`, `EntityPicker` extended with an `organisation` kind), 44pt targets, accessibility labels, and the phone/tablet/desktop layout hook.

## Athlete 360 journey (#571)
The career-and-development view is the **same** Athlete 360 and timeline, extended; there is no second athlete store, timeline domain or portfolio.

| Need | Where it lives |
|---|---|
| Longitudinal timeline | `get_graph_timeline` (person). New domains `statistics` (approved `performances`), `development` (athlete's `player_goals` / `player_plans`, titles and status only) and `media` (coach-approved `passport_videos`); the last two are for the athlete and guardian only |
| Verified / user-entered / external | every timeline row and 360 row has `origin`. `verified` = confirmed by a club, coach, organiser, doctor or the platform's own record; `user_entered` = entered by the athlete or staff and not yet confirmed; `external` = imported (`performances.provenance='imported'`, imported graph edges). Defined once in `src/athlete-journey.js` |
| Career / season filters | `sport`, `from`/`to`, `season_id` (an `org_seasons` row) and `membership_id` (one career stint: its dates and sport) on `get_athlete_360` and `get_graph_timeline`; `origin` on the timeline. With a sport filter only rows that belong to a sport are listed (money, contracts and relationships have none) |
| Comparison between development periods | `compare_athlete_periods` (`GET /graph/athletes/:id/compare`): two periods (dates, season or stint), 12 figures, change and % change, and the origin mix behind each period. Figures from a domain the caller may not see are omitted and listed in `hidden_domains`; health is never part of it |
| Evidence / provenance links | every row carries `source: {table, id}` back to its canonical record |
| Downloadable / shareable portfolio with privacy controls | the **player passport** (#312). Two new switches, `show_journey` and `show_development`, both off by default; the journey is read live through the same builder, without internal ids, and goal reasons are never shared. Revocation, expiry, recipient and youth-consent rules are the passport's. Download = `export_passport` (a link) or `GET /me/passport` (the athlete's own full copy). Existing season/career CSV and PDF reports stay in *Season & career reports* |

Permissions: a young person's journey is 404 for anyone who may not see them, and never goes on a link. Contracts, health, payments, travel, assessments and opportunities are never on a shared portfolio. Reads of comparison are audit-logged (`read_graph_compare`).

Migration `130_athlete_journey.sql` adds two boolean columns (default false) to `passport_links`; no row is changed.

App: `Athlete360` gains *Timeline* filters (sport, season/stint pickers, a date-range picker, origin chips), *Compare*, *Development* and *Portfolio* tabs (`screens/journey-ui.js`); the passport sheet gains the two switches. Sport coverage: filters and comparison use the ontology's sport-neutral rows, so every sport in the catalogue works (a test walks the catalogue); football-style appearances carry minutes, individual sports carry outcome and rank.
