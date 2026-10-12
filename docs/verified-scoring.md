# Verified competition scoring and leaderboards

Issue: [#58](https://github.com/webrainfriends/sportarena/issues/58) (ENG-03, under #43).

## What was there, what was missing
Before this change an athlete could record a performance for themselves with any `points` value, and `/leaderboard`, the home feed and event-invite ratings summed those points. Self-assigned points therefore decided "official" rankings, and there was no approval, dispute or correction path. Score sheets (fixtures) and the multi-sport games leaderboard (house points) are separate systems and are unchanged.

## Provenance
Every row in `performances` now has a `provenance`:

| provenance | label shown | who creates it | counts in rankings |
|---|---|---|---|
| `self_reported` | Self-reported practice | the athlete, for themselves, no event/fixture | never — private to the athlete |
| `imported` | Imported evidence | the athlete (`imported: true`, `evidence_ref` required) | never — labelled, private to the athlete |
| `approved_competition` | Approved competition result | event organiser, accepted event officials (referee, umpire, judge, starter, timekeeper, scorer), fixture referee or admin | only when `status = approved` |

Points an athlete types on practice are stored in the legacy `points` column as a claim and never read by rankings. **Official points are derived on the server** from `src/scoring/performance-rules.js` (`official_points`); the request cannot set them.

## Rules (versioned)
`RULES_VERSION = 1`. Each result stores `unit`, `direction` and `rule_version`, so a later rule change does not re-score old results.

* Time metrics (sport scoring `time`, or metric named `*_time_s` / `*_s`): seconds, **lower is better**, 0.01–86400, flat 5 official points per approved result.
* Distance metrics (`*_m`, `distance`, `throw`, `jump`): metres, higher is better, flat 5 points per approved result.
* Everything else is a whole-number count 0–1000, higher is better, points = count × weight (goals 3, wickets 3, others 1).
* `GET /scoring-rules?sport=&metric=` returns the rule (and, without `metric`, the metrics that have approved results).

## Lifecycle
`submitted → approved | rejected`, `approved → disputed → approved | rejected`, `approved | disputed → (correction submitted) → approved supersedes the original`.

* Submit (`POST /performances` with `event_id`/`fixture_id`): validates the athlete is entered in the event (individual entry, team entry or multi-sport roster) and plays for one of the fixture's teams, that the fixture belongs to the event, that the sport matches the event (or one of its disciplines), the unit/range/whole-number rule and a non-future `achieved_on`. One live result per athlete + fixture + metric (409 otherwise). Event-only results (no game) may have several attempts per athlete and metric (the metric leaderboard keeps the best one, `entries` counts them all), but an identical athlete + event + metric + value + date is a double entry and is refused with `409`.
* Approve / reject (`POST /performances/:id/approve|reject`): the approver (and the rejecter) must be an official as above, **not the submitter and not the athlete** (separation of duties applies equally to approve and reject). A different official or admin is needed if the organiser submitted.
* Dispute (`POST /performances/:id/dispute`): the athlete or an official, with a reason (5+ characters). The result is removed from standings until decided, and the event organiser, the fixture referee and accepted officiating crew get a `result_disputed` notification (disputed results also show in the officials queue, `GET /performances?event_id=&status=disputed`). Abuse guard: a result can only be in one open dispute at a time (a second call is `409`), and an **athlete gets one dispute per result** - once an official has re-approved it, a further athlete dispute is `409` and the athlete is pointed to the organiser's correction path. Officials may still flag a result again.
* Correct (`POST /performances/:id/correct`): creates a new `submitted` row pointing at the original (`supersedes_id`). The original keeps counting until a different official approves the correction, which marks it `superseded`. The correction copies the original's `evidence_ref`, gets its own `submitted` history entry (with the reason and the id it supersedes), and when it is approved the original's history records `superseded` from its real previous status (`approved` or `disputed`). Nothing is deleted; `GET /performances/:id/history` shows every step with actor and reason (table `performance_log`).
* Idempotency: send `client_key` on `POST /performances`; a retry returns the original row. A per-athlete/fixture/metric advisory lock makes concurrent duplicate submissions resolve to one `201` and `409`s.

## Rankings
`GET /leaderboard` uses approved competition results only, excludes youth profiles as before, and supports `sport`, `event_id`, `metric`, `category` (sport category) and `season` (the calendar year of `achieved_on`, e.g. a result achieved on 31 Dec 2025 belongs to season 2025 and one on 1 Jan 2026 to 2026).

* No metric: official points, higher first. Ties: more approved results, then earliest approval.
* With a metric: best approved value in the metric's direction (lowest time wins). Ties: the earlier `achieved_on` **of the best result itself** (`best_on`; slower or older results never influence it), then the official points of that best result only (not a sum across the athlete's other results).
* Athletes equal on every tie-break share a rank (`rank()`); paging is deterministic (`rank`, tie-break keys, then user id) and ranks are correct across pages. A metric with different directions in different sports requires `sport` (400).

`GET /people/:id/stats` shows approved results publicly; the athlete (or an admin) also sees labelled practice/imported figures, never added to `total_points`. `GET /feed` top athletes and event-invite ratings use official points only. The dashboard returns `points` (official), `practice_entries` and `pending_results`.

## App
Leaderboard screen (Ecosystem > Leaderboard):
* **Rankings**: sport, sport category, season and metric filters, "Show more" paging, unit-aware values (seconds, metres or plain counts from the scoring rule), evidence label, and a plain-language tie-break explanation.
* **My results**: log practice, or switch on "Imported from another app or device" and give an evidence reference to log imported evidence (both labelled, neither ever ranked); evidence/status tags, a **History** button (calls `GET /performances/:id/history`) and "Something's wrong" to dispute.
* **Officials** (organisers, referees, admins): **Submit a result** (event picker, optional game picker, sport, athlete search-and-pick, metric chips or a custom metric, numeric value with the unit and direction from the rule, date picker, optional evidence reference; retries are idempotent through `client_key`), the decision queue (disputed results first, then submitted; approve, reject with a reason, or **Correct** with a reason), and a per-event list of every result with History and Correct.
* Person profile stats and the home dashboard show the evidence label. The dashboard Points tile reads "Official pts" with "Approved results", the count of practice entries (not ranked) and the count awaiting approval.

Limits: the event picker lists events you organise, events with games you referee, or all events for admins; accepted officiating-crew members who are neither organiser nor referee can still submit through the API but their events are not listed in the picker. Athletes are searched by name; entry in the event is validated by the server and refused with a reason if not met.

## Migration and rollback
`038_verified_scoring.sql` is additive: new columns on `performances`, new `performance_log` table, partial indexes. Backfill: rows an organiser/referee recorded for an event or fixture (`recorded_by <> user_id`) become `approved_competition`/`approved` with `official_points = points` (so existing official standings are preserved); the athlete's own rows become `self_reported` and drop out of rankings (their `points` are kept untouched). To roll back, deploy the previous app build — the old code ignores the new columns and still reads `points`. No data is dropped.

## Operations and limits
* Failure modes: 403 when the actor is not an official or tries to approve their own/submitted result; 409 on duplicates, repeated decisions or a second pending correction; 422 for validation (not entered, wrong sport/event, out of range, future date).
* Rules are code-defined (not editable per event) and flat per metric; event-specific scoring tables and placement-based points are not implemented. Seeded demo data (`seed.js`) creates competition results that stay `submitted` until approved.
* Result evidence is a reference string; file attachments are not stored.
