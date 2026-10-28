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
Results use the ontology's sport-neutral model (`outcome`, `rank`, `score`, `score_units`), so each family keeps its own units and no sport falls back to a silent default; a test walks the whole sports catalogue. Entities listed in the issue that live in their own module (payments, invoices, tickets, trips, media rights, assessments …) are *projected*: reachable through their source record, not yet rows on the graph timeline. `get_graph_schema` reports each entity as `native` or `projected`.

## Migration plan
`124_sports_graph.sql` only adds four tables and indexes. No existing row is touched, nothing is backfilled or dropped.

## App (iOS, iPadOS, Android, web)
`SportsGraph` (search), `Athlete360`, `Organisation360` use the shared Expo components and theme tokens (`ui.js`, `FormSheet`, `EntityPicker` extended with an `organisation` kind), 44pt targets, accessibility labels, and the phone/tablet/desktop layout hook.
