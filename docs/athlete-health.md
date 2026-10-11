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
Everything is the athlete's alone. Notes (`note_enc`) are AES-256-GCM encrypted with their own context and every read that decrypts a note writes an `audit_log` row (`read_wellness`). Scores and charts use numbers only. Coaches, teams and providers cannot read any of it; sharing with a coach or physio would go through the existing medical grants in a later change.

## App
* **Health -> Recovery** (first tab for athletes): readiness ring, tap-to-rate front/back body map, training-load gauge with a log-session form, and seven-day sleep and water bars.
* **Home**: today's readiness card and a floating quick-log button (water, mood, soreness, sleep, note).
