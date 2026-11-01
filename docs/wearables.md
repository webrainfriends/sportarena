# Athlete Performance Integration Hub (issue #583)

Athletes connect their own wearable or performance account; readings are normalised into canonical daily metrics; the athlete sees their own trends and coaches see only what the athlete chose to share. Capabilities live in `apps/api/src/capabilities/wearables.js` (tag *Athlete health*, REST + OpenAPI + MCP). Migration `139_wearable_hub.sql` is additive.

## What it builds on (nothing duplicated)
- **Integration Hub (#597):** the providers are entries in `src/integrations/registry.js` (category `wearables`, flagged `athlete_scoped`). The organisation is authorised through the existing access request and quote flow (`requireIntegrationAccess` rules, `approvedAccess`). Installing them from the organisation Integration Hub is refused with a pointer to the athlete screen. Scheduled sync runs in the same worker step (`integrationSweep` calls `wearableSweep`).
- **Wellness sharing (#330):** coaches reach wearable data only through a live wellness share that includes the new `wearables` field, re-checked on every read (`shareBlock`, coaching relationship, guardian consent). Views are logged to `wellness_share_events` and visible to the athlete.
- **Health privacy:** the country notice (`requireHealthNotice`) and, for young athletes, guardian `medical` consent are required to connect.
- The issue's "10 items -6" and "10 items -9" references have no counterpart in the repo (as with `docs/org-command-centre.md`); the existing hub, wellness and sharing modules above were extended instead.

## Capabilities
| Capability | REST | Purpose |
|---|---|---|
| `list_wearable_providers` | `GET /me/wearables/providers` | Providers per organisation (enabled or not) and the canonical metrics with units. |
| `connect_wearable` | `POST /me/wearables` | Connect your own account: organisation, provider, metrics allowed, accepted scopes, access token (encrypted, never returned). |
| `list_wearable_connections` | `GET /me/wearables` | Status, last sync, last error, next sync, what was allowed. |
| `update_wearable_consent` | `PATCH /me/wearables/:id` | Narrow metrics, pause or resume, change frequency (versioned; stale copy is a 409). |
| `disconnect_wearable` | `POST /me/wearables/:id/disconnect` | Stops sync, erases the token, keeps imported history. |
| `sync_wearable` | `POST /me/wearables/:id/sync` | Sync now / retry after an error. |
| `push_wearable_readings` | `POST /me/wearables/:id/readings` | Device-app push (Apple Health, Health Connect). |
| `get_wearable_trend` | `GET /me/wearables/trend` | Daily series with provider and the vendor's original value and unit. |
| `get_wearable_quality` | `GET /me/wearables/quality` | Missing days, out-of-range readings, overdue sync. |
| `get_my_wearable_dashboard` | `GET /me/wearables/dashboard` | Latest, 7-day change and recent alerts; own data only. |
| `create/list/update_wearable_alert_rule` | `/me/wearables/alert-rules` | The athlete's own thresholds, in plain words; archived, not deleted. |
| `get_team_wearable_overview` | `GET /wearables/team` | Coach view over live shares that include `wearables`. |

## Normalisation and provenance
`src/wearables/normalise.js` holds the canonical metrics (resting heart rate, HRV RMSSD, sleep duration, training load, distance, active energy, steps), their units and plausible ranges, and per-provider mappings. Each stored row keeps the vendor metric, value and unit, the provider and the mapping version. A reading outside the plausible range is flagged `out_of_range`, never silently changed. A unit that is not understood is skipped and counted, never guessed. Missing days are reported, never filled.

## Alerts and the no-medical-inference rule
An alert is the athlete's own rule ("tell me when my 3-day average resting heart rate is above 60 bpm"). The message quotes the rule and the numbers and says it is not a medical finding. Nothing in the hub scores injury risk, illness or fitness to play, and every dashboard carries the same "not a diagnosis, medical advice or clearance" statement as readiness (`LIMITATIONS`).

## Security
Tokens are AES-256-GCM encrypted (`athlete_connections.token`), stripped from logs (`scrub`), and erased on disconnect. Connection ids of other people return 404. Connecting, consent changes, disconnects and every coach view are audit-logged. The organisation authorisation is re-checked on every sync; if it ends, the connection pauses and data is kept.

## Not covered / limits
- Live vendor calls need developer-app credentials from the platform owner; adapters are proven with stubbed vendor responses and their response shapes are not yet checked against live APIs.
- The connect form takes the access token the provider returns; an in-app OAuth redirect is not built.
- Apple Health and Health Connect are pushed from the device app (no server pull).
- Sport coverage: metrics are sport-neutral daily summaries. There is no sport-specific scoring model, so no sport is natively modelled and none is left on a silent default.
- Native iOS/Android were not run in this environment; the web build and its phone, tablet and desktop layouts were.
- Non-English text is machine-drafted and stays `reviewed: false` until a native speaker signs it off.
