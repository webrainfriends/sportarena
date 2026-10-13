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
