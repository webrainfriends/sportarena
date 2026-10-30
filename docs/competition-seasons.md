# Competition seasons, divisions & leagues (#476)

Persistent **Competition → Season → Division → Round/Fixture → Standings**. One definition per action in `apps/api/src/capabilities/competitions.js` (REST + OpenAPI + MCP); the UI (`apps/app/src/screens/competition-home.js`, route `Competitions`, deep link `competition[:id]`) only calls the API.

## Overlap / reuse mapping
| Need | Reused (canonical, not copied) | Added |
|---|---|---|
| Season | `events` row (kind `league`), created by `create_season` | `comp_seasons` (dates, windows, status, champion) |
| Team in a season | `teams`, `event_entries` (created on accept, once) | `comp_memberships` + append-only `comp_membership_events`, eligibility snapshot |
| Games and results | `fixtures`, `record_result` | `comp_fixture_links` (division/round, forfeit and postponement decisions) |
| Standings | fixtures/results | pure engine `competition-standings.js`, versioned `comp_rule_versions`, append-only `comp_adjustments`, frozen `comp_standing_snapshots` |
| Player eligibility, registration programmes | #477 `reg_*`, #575 `rx_*` stay the writers | none: this layer registers **teams** into divisions only |
| Federation / organisation | `organisations` (governing body), org grants | none |

No second match, team or score table; no existing table or row is changed. Event console stays the home for running games; Competition Home is the home for the league structure.

## Guarantees
- Rule versions, membership history, adjustments and snapshots are immutable by trigger; completed/archived seasons close their memberships, divisions, rounds and links.
- Adjustments never edit a result; a mistake is a reversing row. Forfeits are reasoned decisions beside the fixture.
- Movements (promote/relegate/playoff/qualify/champion/stay) are proposals; a person confirms each into a next-season division, which creates an *invitation*; the team accepts.
- Outsiders get 404; drafts are staff-only; no hard deletes, no cascades.

## Sports
Scores are labelled per scoring type (goals, points, sets, time, distance); unlisted types show a labelled generic "Score". Native per-family models (cricket innings, tennis games, heats) and playoff fixture generation are **not yet built**.
