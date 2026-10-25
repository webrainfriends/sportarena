# Player insights

Player → **Insights** reads a player's matches against other players.

* **Basis.** Matches players logged or imported (`player_matches`), for the player and for the cohort alike, so a comparison is
  always like with like. Official game results keep showing on the sport cards under **My sports**.
* **Cohorts.** Same sport and the same *region* (a self-declared city or area on the sport profile, `sport_profiles.region`,
  picked from venue cities and areas other players use), same level, and the whole sport. A player needs 3 logged matches to
  be compared or to count in a cohort.
* **Privacy.** Only aggregates leave the API (win rate, average rating, matches, per-match averages of the sport's stats,
  as percentiles and medians). A cohort smaller than 5 other players is never shown, so nobody can be singled out.
* **Read-out.** When AI is switched on (`ANTHROPIC_API_KEY`) the model words the headline, 1–5 findings and a next step from
  those numbers only (no names, no ids). Without AI, or if it fails, built-in rules write the same shape. Answers are cached
  per profile and set of numbers (`ai_outputs`, kind `player_insights`) and the call is audit-logged.
* **API.** `GET /me/insights?sport_profile_id=` (capability `get_my_insights`), `GET /regions?q=` (`list_regions`),
  and `region` on `add_sport_profile` / `update_sport_profile`. Migration `062` only adds a nullable column and an index.

## Benchmarks (issue #321)

* **Direction.** Every metric has a direction (`src/benchmarks.js`): errors, fouls, turnovers, conceded and times are *lower is
  better*; goals, points, distance are *higher*; stored `performances.direction` wins. A percentile always means "ahead of this
  share of the cohort in the good direction". A stat whose direction is not defined is shown with its median but not ranked.
* **Denominators and coverage.** A stat is averaged over the matches that recorded it, never over every match, and each row
  returns `coverage {recorded, total}`. Fewer than 3 recorded matches gives `insufficient_data`; a cohort under 5 players gives
  `cohort_too_small`.
* **Evidence tracks.** `evidence=self_reported` (matches logged or imported) and `evidence=official` (approved competition
  results only) are computed separately and never blended. Match format applies to self-logged matches only.
* **Cohorts.** Sport, level, region, plus optional `position` (any listed position, case-insensitive) and `match_type`. The 5-player
  floor applies after every filter. Archived cards are excluded.
* **Self-rating trend.** `self_rating_trend` is the player's own match ratings (last 5 vs the 5 before), labelled as not peer or coach ratings.
* **Youth and consent.** A young person is counted in a cohort, and sees benchmarks, only while a verified guardian's current
  `coaching` consent stands (`CONSENT_OK`); withdrawing it takes effect on the next read.
* **Staff and guardians.** `GET /athletes/:athlete_id/benchmarks` (`get_athlete_benchmarks`): a coach with an active coaching
  relationship, a verified guardian, or the athlete. Consent for a young person is re-checked on every read; each read is audit-logged
  (`view_player_benchmarks`). Aggregates only, no AI read-out.
* **Schema.** Migration `107` adds indexes only. No data is changed. No export or shared-link surface includes insights.
