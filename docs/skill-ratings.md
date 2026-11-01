# Skill ratings (issue #633)

"What level am I, and can I trust that number?" A verified level **1.0–7.0** with a **reliability** bar per person and sport, projected from verified results only. One capability set (`apps/api/src/capabilities/skill-ratings.js`, tag *Skill ratings*) exposed as REST, OpenAPI and MCP tools, one pure engine (`apps/api/src/ratings/engine.js`), and one component (`apps/app/src/skill-level.js`) used on iOS, iPadOS, Android and web.

## Reuse map

| Need | Canonical source (reused) | Gap | Extension |
|---|---|---|---|
| Which results are official | published `score_sheets` (fixtures) and completed `event_sessions` | none | read-only: a rating never creates or changes a result |
| Who played | verified `match_appearances`; a racket team of one or two with none is a singles or doubles pair | none | team sports credit only players with a verified appearance |
| Kinds of sport | `rankings/families.js` (`familyOf`) | no rating model per family | `ratings/models.js` maps the same families to a rating model; there is one notion of "what kind of sport" |
| Youth and approval | `NOT_YOUTH_SQL`, `access_status = 'approved'` | none | youth accounts are never rated; a youth id is a `404` |
| Result corrections | `onResultsChanged`, score-sheet publish | ratings were not re-run | publish and the hourly worker step re-run ratings; the evidence hash makes an unchanged run a no-op |
| Player level for matching | `sport_profiles.level` (declared) | self-declared, easy to inflate | `levelFor` / `best_match` use the computed level once it is **reliable**, else the declared one. No second level system |
| Team strength for seeding | `tournament/ranking.js` | different subject (teams) and use (seeding) | **left untouched** |
| Aggregate stat rankings | `rankings/*` | a ranking aggregates stats; it does not rate head-to-head | **left untouched**; a rating is not a leaderboard |

## What counts

Only verified results: games with a **published** score sheet, and **completed** event sessions, in **tournaments and leagues**. Practice, imported and self-reported results, friendlies, camps, trials, open-game results, games between two teams of one owner, and results that are drafted, approved-but-unpublished, rejected, disputed or superseded never count. Youth accounts and accounts that are not approved are never rated (their games are dropped from the sides; the other players are still rated).

## Models (every sport in the catalogue)

| Family | Model | Native |
|---|---|---|
| Racket and set sports | singles and doubles: sets won, blended with the points inside them, against the opposing side's average | yes |
| Goal games | team result and goal margin, credited to verified appearances | yes |
| Cricket | match result and run margin, credited to verified appearances | yes |
| Timed and measured events | finishing place against everyone else in the same heat or final | yes |
| Everything else | who won, no margin | **no: labelled "Win/loss only (fallback)"** |

`GET /ratings/models` lists every sport with its family and whether it is native, so a client (or an agent) never has to guess. A test walks the whole catalogue.

## The maths, in one place

Glicko-2 (Glickman) underneath; the test suite reproduces its published worked example. Each game is a rating period for each player: against the opposing side's average rating (doubles and teams), or against everyone else in the field (heats). 80% of a game's score is who won, 20% how it went (a smoothed share of the sets, points, goals or runs). Deviation grows with inactivity (30-day periods) up to a brand-new player's. The level shown is `1 + 6 / (1 + e^(-(rating-1500)/300))`: 4.0 is the middle of the field and the scale cannot run off either end. Reliability is `(350 - RD) / 300` as a percentage; a level is **reliable** at RD ≤ 130 (about seven evenly matched games against established players, more against newcomers or lopsided results).

Replay is **deterministic**: games are ordered by time then id, so the same evidence gives the same ratings in any arrival order.

## Data

Additive migration `129_skill_ratings.sql`: `skill_rating_runs` (one per changed evidence hash), `skill_ratings` (current, `void` instead of a delete) and `skill_rating_changes` (the per-game ledger, kept for every run). A correction adds a run; earlier runs and their ledgers stay. Nothing is deleted.

## Capabilities

| Capability | Who | What |
|---|---|---|
| `list_rating_models` | public | how it works, the model per sport, native or fallback |
| `get_skill_ratings` | public | a player's level per sport with reliability, record, peak and what it matches as in open games |
| `get_skill_rating_history` | public | level after each game; the player (and an admin) also see the evidence behind each move |
| `explain_skill_rating_change` | the player (admin audited) | why one verified game moved the level, in plain words; anyone else gets a `404` |
| `recompute_skill_ratings` | admin | force a re-run; audit-logged |

## Rankings and open games

Rankings: a ranking version may use `formula_kind = 'rating'` (migration `133_rating_ranking_formula.sql`, additive). It ranks reliable levels only, players only, from approved competition results; youth and unapproved accounts never appear. There is no separate leaderboard.

Open games: a card carries `my_level` (the viewer's own reliable level in that sport, never anyone else's) and the app shows it as a "Your level" chip; matching uses the computed level when reliable, else the stated level.

## Privacy and security

Enforced on the server. A level is derived from public competition results (the same evidence the public rankings use) and is shown on a passport only when the athlete shares approved results. The per-game ledger (result, opposing level, event) is visible only to the player and admins; others see the level over time. A youth or unknown account is a `404`, so existence is not leaked. No ranking boost or penalty for paid plans.

## Not covered yet (honest gaps)

- Open-game and practice results do not rate anyone (they are unverified); a verified-result path for open games would be a separate change.
- Team entries in multi-sport sessions (`team_id` entries) are not rated; individual entries are.
- Doubles partners share one result; there is no separate doubles rating beside singles.
- A leaderboard of levels is not built: rankings stay the single home for leaderboards.
- No native device was available. The shared React Native code was verified through the web build (phone, tablet and desktop widths) and `expo export` bundles for iOS and Android; on-device behaviour is not yet tested.
