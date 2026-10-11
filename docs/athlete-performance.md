# Personal records & trends

Derived read models over the athlete's own `performances`; nothing is stored (capabilities in `apps/api/src/capabilities/athlete-performance.js`, tag *Performance*). They sit beside, not in place of, the existing pieces: match stats and "best" per stat stay in **Career numbers**, results are logged, submitted and disputed under **Leaderboard -> my results**, and `get_athlete_stats` stays the public view.

| Capability | What it does |
|---|---|
| `list_personal_records` (`GET /me/records?sport=`) | Best result per sport, metric and kind of evidence, in the metric's stored direction (lowest time, highest count). Returns the date, number of results, the previous best, how much it improved (`improved_by`) and `recent` (set in the last 30 days, shown as NEW PR). |
| `get_performance_trend` (`GET /me/trends?sport=&metric=&evidence=&from=&to=`) | Results for one metric, oldest first, each flagged `is_pr` when it set a new best at the time, for a chart. |

Rules: approved competition results (`status = approved`) and the athlete's own practice / imported figures (`status = recorded`) are never mixed. A practice best is labelled "Practice", an official one "Official". Submitted, disputed, rejected and superseded results do not count. Direction comes from the rule stored with each result, so a corrected rule never re-scores history.

## Archive instead of delete (migration 040)
`delete_match` no longer erases a logged match: it sets `player_matches.archived_at`. Archived matches are left out of the unified history, totals, link candidates and the CSV duplicate check; the row and its data stay. (Removing a whole sport profile is unchanged and still removes the logged matches under it.)

## App
* **My sports -> a sport -> Personal records**: a card per metric with the best value, date, improvement ("faster / more than before"), evidence label and a NEW PR badge. Tap a card for the trend chart (gold dots are new bests; for times the axis is flipped so improving looks like climbing).
* The match log gains season chips (by year) when matches span more than one year.
