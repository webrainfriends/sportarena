# Unified athlete history (My Sports)

One sporting history per athlete: what they **logged themselves** (`player_matches`: manual / CSV import) and what SportArena **officially knows** (finished `games`, completed `fixtures`) are composed at read time by `apps/api/src/athlete-history.js`. Nothing is copied into `player_matches`; canonical tables stay authoritative, so a corrected result changes the athlete's history and totals immediately.

## Source of truth

| Data | Owner | In My Sports |
|---|---|---|
| Manual / imported match | `player_matches` (athlete) | `provenance` manual / imported, `verification` self_reported / imported; athlete can delete |
| Finished game (`games.status = post-event`) | `games`, `game_participants` | `official_game`, `verification` official; not deletable by the athlete |
| Completed fixture with no finished game | `fixtures` + `team_squads` | `official_fixture`; the game wins when both exist (`games.fixture_id`) |
| Private rating / notes on an official match | `player_match_notes` (athlete) | shown only to the athlete |
| "My log = that official match" | `player_match_links` | the logged row is replaced by the official one (counts once) |
| `performances` | `scores.js` | **not** summed into history — they feed public stats/leaderboards (#58) only |

Identity is always the immutable `user_id`; handles/display names are never used to link records.

## Who counts as having played

* Individual game: a `game_participants` row with their `user_id`.
* Team game: person-level evidence for the participating team — a **confirmed** `player`/`captain`/`vice_captain` squad slot for the game's fixture, or an **active** `player`/`captain` game association with `player_status` starter/unset while on that team's active roster.
* Fixture without a finished game: confirmed playing squad slot on its home/away team.

Never counted: roster members who were not selected, `selected`-only/declined/dropped slots, substitutes and bench (appearance unconfirmed — no minutes are invented), coach/manager/physio, referee/scorer. Tournament registration alone is not a match. Ranked/timed games are `kind: competition` with `rank` and no W-D-L.

Stats: individual → numeric `game_participants.stats`; team → numeric `attributes` of the player's own game association (the ontology's `association` fields). `game_actions` are never turned into stats without a governed mapping (#68).

## Reconciliation

A logged match and an official one are **never merged silently**. `GET /me/matches/:id/link-candidates` lists the athlete's own official matches in the same sport within a day; `POST /me/matches/:id/link` confirms (idempotent, transactional, one link per logged match and per official match, own participation verified server-side). While linked, the official score/result/stats count and the athlete keeps their note and rating. `POST /me/matches/:id/unlink` undoes it (soft: `removed_at`).

## API (all `cap(...)`, so REST + OpenAPI + MCP)

* `GET /me/matches` — unified, deterministic order (`played_at desc, activity_id`); filters `sport_profile_id`, `sport`, `source=all|self|official`, `verification`, `from`, `to`, `competition_id`, `limit`, `offset`. Old fields are unchanged; new: `activity_id`, `provenance`, `verification`, `source_type/id`, `game_id`, `fixture_id`, `event_id`, `kind`, `rank`, `linked_match_id`, `can_delete`.
* `GET /me/sport-profiles` — `summary` (everything, counted once), `official_summary`, `self_summary`, `metrics`, `official_metrics`.
* `GET /me/detected-sports` — official sports with no athlete profile yet (nothing invented; adding the sport attaches the history).
* `POST /me/matches/:id/link`, `/unlink`, `GET /me/matches/:id/link-candidates`, `POST /me/official-matches/:source_type/:source_id/note`.
* `DELETE /me/matches/:id` on an official id → 403.

## Schema and rollback (migration 038, additive)

`player_match_links`, `player_match_notes`, three supporting indexes. Rollback: drop the two tables and indexes — no existing data was changed; the old behaviour is `player_matches` alone. `player_match_links.player_match_id` has no FK so deleting a logged match or a sport card is never blocked and never cascades; links are soft-removed.

## Limits / deferred

Substitute appearance is unconfirmed (excluded). Approved-competition provenance (#58), versioned metrics (#68), and an official bulk import by handle are not built; the model keys everything on `user_id`, so they plug in as new source rows in the projection. Youth rules: the endpoints only ever return the signed-in athlete's own rows.
