# Athlete health & recovery (migration 039)

A private place for the athlete to log how they feel and see whether to push or rest. Capabilities (REST + OpenAPI + MCP, tag *Athlete health*) in `apps/api/src/capabilities/wellness.js`; maths in `apps/api/src/readiness.js`.

| Capability | What it does |
|---|---|
| `log_wellness` / `list_wellness` | One row per day: sleep hours and quality, soreness 0-10, mood 1-5, water, private note. Leaving a field out keeps its earlier value; `water_add_ml` adds to the day's total. |
| `log_body_pain` / `list_body_pain` / `resolve_body_pain` | Body-map readings (region, side, pain / tightness / fatigue, 1-10). Each reading is kept; the latest open one per region is the current state; resolving closes the open readings and keeps the history. |
| `log_session_load` / `list_session_loads` / `archive_session_load` | Minutes x RPE for training, matches and gym. Archiving hides a session from the numbers; the row stays. |
| `get_workload` | Acute:chronic workload ratio (7-day load vs. the 28-day weekly average), a band and eight weekly totals. |
| `get_readiness` | 0-100 readiness from sleep (40%), soreness (35%) and mood (25%); weights renormalise over what was logged. An open body-map entry stands in for soreness. A workload ratio above 1.3 takes 5 points off, above 1.5 takes 10 off. `null` until something is logged. |

ACWR bands: below 0.8 low, 0.8-1.3 optimal, 1.3-1.5 caution, above 1.5 high. The ratio shows as "building" until the first logged session is three weeks old. Loads come only from what the athlete logs; matches are included when they log them. Nothing is estimated or invented.

## Privacy
Everything is the athlete's alone. Notes (`note_enc`) are AES-256-GCM encrypted with their own context and every read that decrypts a note writes an `audit_log` row (`read_wellness`). Scores and charts use numbers only. Coaches, teams and providers cannot read any of it unless the athlete shares it (see below).

## Sharing with a support team (#330)
Wellness stays private until the athlete creates a **share** (`apps/api/src/capabilities/wellness-sharing.js`, tag *Athlete health*, clinical token scope). Nothing else changes: the tables above are untouched and notes are never shareable.

| Capability | REST | What it does |
|---|---|---|
| `list_wellness_share_recipients` | `GET /me/wellness-shares/recipients` | Who can be picked: coaches with a live coaching relationship (`RELATIONSHIP_SQL`), and physios/doctors with an active **full** medical grant and a verified credential. Team or sponsor membership alone never appears. |
| `create_wellness_share` | `POST /me/wellness-shares` | Recipient, purpose (`training_load`, `injury_prevention`, `return_to_play`, `performance_review`), fields (`sleep`, `soreness`, `mood`, `hydration`, `readiness`, `workload`, `body_map`), `history_days` (1-365), `expires_on` (at most a year ahead). Young athletes need the guardian's current `coaching` (coach) or `medical` (clinician) consent. Repeating the same request returns the existing share; a different one for the same person and purpose is a 409 `share_exists`. |
| `update_wellness_share` | `PATCH /me/wellness-shares/:id` | Change fields, days or end date. Needs the `version` last seen; otherwise 409 `stale_version`. |
| `revoke_wellness_share` | `POST /me/wellness-shares/:id/revoke` | Ends access on the recipient's next read; idempotent; a verified guardian may do it for a young athlete. |
| `list_wellness_shares` | `GET /me/wellness-shares` | The athlete's (or, with `athlete_id`, a guardian's child's) shares with state, whether each is live right now and why not, view counts and an activity log. |
| `list_wellness_shared_with_me` | `GET /wellness-shared` | The recipient's inbox, including why an ended or lapsed share shows nothing. |
| `get_shared_wellness` / `export_shared_wellness` | `GET /wellness-shared/:id` (`/export`) | Only the chosen fields inside the chosen window (requests for older days are clamped); the export is the same data as CSV. Both are audit-logged and written to the athlete's activity log. |

Schema (migration `110_wellness_sharing.sql`, additive): `wellness_shares` (athlete, recipient, kind, purpose, fields, history_days, expires_at, version, revoked_at; one live share per athlete + recipient + purpose by partial unique index) and `wellness_share_events` (append-only: granted, updated, revoked, expired, viewed, exported). Nothing is deleted; revoking and expiry only close a share.

Access is re-derived on **every** read inside one transaction, with the share row locked `FOR SHARE` so a revoke waits for an in-flight read: the share is live, and the coach still coaches the athlete (or the clinician still holds the medical grant and a current verified credential), and for a young athlete the guardian's consent stands. A non-owner learns nothing (404). There are no shared links; the export is the only way data leaves, and it takes the same path.

App: athlete **Health -> Recovery -> Share with my support team** (guardians: Family -> Wellness sharing); coaches **Coach home -> Shared wellness** and **My athletes**; clinicians **Doctor workspace -> Shared wellness**. Phone shows list then detail; tablet and desktop show both.

## Transparent readiness and workload (#329)
Readiness and the workload ratio are **heuristics**, not validated injury prediction or medical clearance. This layer explains them and lets a qualified person adjust them, without changing the maths for anyone who has not been adjusted. Capabilities in `apps/api/src/capabilities/readiness-insight.js` (tag *Athlete health*, clinical token scope); maths in `readiness.js` (formula `readiness` v1.0, `explain()`, `history()`); settings resolution in `readiness-config.js`.

| Capability | REST | What it does |
|---|---|---|
| `explain_readiness` | `GET /me/readiness/explanation` | Per input: weight, source (daily log / body map / not logged), raw value, points added. Coverage (inputs logged, share of the formula, days logged), a confidence label, what is missing and how to add it, the workload basis (ratio, sessions, days of history vs. needed, whether it counted), the formula version, the settings in force and who set them, what stays fixed, and the limits. |
| `get_readiness_history` | `GET /me/readiness/history` | Day-by-day score for up to 90 days from the same logs and current settings. Days with no log have a null score; body-map entries count only on the days they were open. |
| `get_readiness_config` | `GET /me/readiness/config` | Standard values, allowed ranges, settings in force (standard / custom / paused) and the version history with who and why (reasons decrypted, audit-logged). A verified guardian can read it for a young athlete (`athlete_id`). |
| `reset_readiness_config` | `POST /me/readiness/config/reset` | Back to standard as a new version. Needs the `version` last seen (stale = 409); repeating is harmless. Guardians may do it for a young athlete. |
| `get_shared_readiness` | `GET /wellness-shared/:id/readiness` | Coach / clinician: the explanation through a live share that includes `readiness`. Raw values only for shared fields (sleep, soreness, mood, workload); a trend of scores; the settings and allowed ranges. Logged to the athlete's activity. |
| `set_shared_readiness_config` | `POST /wellness-shared/:id/readiness-config` | Coach / clinician: weights (each 10-70%, sum 100%), score bands, workload thresholds and penalties, within fixed ranges, with a written reason (10-500 chars, encrypted). Needs the current `version` (409 `stale_version`); an identical retry returns the same version; concurrent writers cannot fork versions. The athlete is notified. |

Schema (migration `113_readiness_config.sql`, additive): `readiness_configs` (append-only, numbered per athlete, `source` staff/reset, `config` jsonb, `rationale_enc`, `set_by`, `share_id`). Nothing is deleted. A staff version applies **only while its share is live** (relationship, medical grant + credential and guardian consent re-checked on every read); otherwise the standard applies and the athlete sees why ("paused"). `get_readiness`, `get_workload` and the shared view all use the settings in force, so every screen shows the same score.

Not adjustable by design: the sleep sub-score (70% hours against 8 h, 30% quality), the 7-day acute / 28-day chronic windows, and the soreness / mood scales.

App: **Health -> Recovery -> How this score is built** (athlete) and **Shared wellness -> athlete -> How this score is built -> Adjust settings** (coach / clinician). Phone, tablet and desktop share one component.

## App
* **Health -> Recovery** (first tab for athletes): readiness ring, tap-to-rate front/back body map, training-load gauge with a log-session form, and seven-day sleep and water bars.
* **Home**: today's readiness card and a floating quick-log button (water, mood, soreness, sleep, note).
