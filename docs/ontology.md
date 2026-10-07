# Sport ontology & game module

The app's shared language is modelled on the [IPTC Sport Schema](https://github.com/iptc/sport-schema)
(CC-BY 4.0, © IPTC). The ontology is **code** (`apps/api/src/ontology/iptc.js`), not data: classes, properties and
controlled vocabularies are fixed and versioned with the app; instances live in Postgres.
`GET /api/v1/ontology` (MCP tool `get_ontology`) serves it — agents should read it first.

## Classes → storage

| IPTC class | Stored in | Notes |
|---|---|---|
| `Individual` → `Athlete` / `Official` / `Associate` | `users` | the class is decided by the **role** a person holds, not by the person |
| `Team` | `teams` | roster in `team_members` |
| `Competition` | `events` | league / tournament / camp / trial |
| `Event` (a game) | `games` | any sport; optional `competition_id`, venue/court |
| `CompetitorParticipation` | `game_participants` | a team or athlete competing, with side, outcome, score, rank, stats |
| `Membership` / `IndividualParticipation` | `associations` (+ `team_members`) | a person's **role** towards a game, event or venue; view `person_associations` unions the team rosters |
| `Action` | `game_actions` | goals, substitutions, cards, timeouts… |
| `Site` | `venues` / `resources` | |

## Associating people (player, coach, referee …)

`POST /associations` — `{ user_id?, role, target_type: game|team|event|venue, target_id }`.

* Roles (`get_ontology → roles`) map to IPTC classes: `player`/`captain` → Athlete, `referee`/`umpire`/`linesman`/`scorer` → Official, `coach`/`manager`/`physio`/`doctor`/`sponsor`/`organizer`/… → Associate.
* A role may require a profile (`coach` needs a coach profile, `referee` a referee profile …).
* Managers of the target (game organizer, team owner/captain/manager, competition organizer, venue owner) add people → the person gets an **invitation** and accepts. People can **request** to join non-team targets; a manager approves. Team rosters are added directly (as before) and are mirrored in the read model.
* `list_associations` answers both "who is on this game/team?" and "what does this person play/coach/officiate?".

## Game fields per sport

`GET /sports/:sport/game-fields` returns, for three scopes, the fields a game can carry:

* `game` → `games.attributes` (attendance, periods, surface, overs per innings …)
* `participant` → `game_participants.stats` (shots, possession, runs, sets won …)
* `association` → `associations.attributes` (goals, assists, rebounds, runs, aces … per player in this game)

Fields = **core** + **sport template** (football, basketball, cricket, tennis, badminton, volleyball, hockey, kabaddi, rugby, baseball, athletics, swimming, esports, skateboarding — derived from the IPTC statistics ontologies) + **custom** fields added by organizers/admins (`create_field_definition`, per sport or for every sport, optionally required). Values are validated on write; unknown keys are rejected.

## Linked data

`GET /games/:id/jsonld` emits the game as a JSON-LD graph (`sport:Event`, `sport:CompetitorParticipation`, `sport:Athlete`, `sport:Official`, `sport:Action` …). Only public identity (handle, display name) is exported — never personal identification data.
