# Growth, participation & operator analytics (#73)

Operators can see why discovery does or does not become completed activity. Clubs, venues and providers see only the aggregates they are authorised to see.

**This extends the governed KPI layer ([`kpi-layer.md`](kpi-layer.md)); it does not replace or duplicate it.** New metrics are catalogue entries, read with the existing
`/analytics/metrics` capabilities, scope checks, drill-down, dashboards, exports and scheduled reports. What is new is only what the KPI layer did not have:
consent-aware telemetry, first-touch attribution, feature-flag experiments and data-quality indicators.

## Before-coding review: what existed, what was missing
| Existing (kept as is) | Gap closed here |
|---|---|
| Governed KPI catalogue, scope authority, drill-down that reconciles, dashboards, CSV/XLSX/PDF export, schedules (#596) | activation, first completed activity, repeat participation, vacancy fill, booking/payment failure, provider earnings; a **city** split |
| Referral codes, ring/duplicate guards and rewards (loyalty engine, #509) | referral and acquisition source as a **channel** split on activation; no second referral model |
| Open games, bookings, payments, invoices, coach hires, marketplace engagements | read as sources; nothing copied |
| — | consent-aware telemetry, replay protection, reconciliation, experiments with exposure records, data-quality indicators, retention |

## Canonical metrics (all in `src/kpi/catalogue.js`, version 1)
| Key | Definition | Scopes |
|---|---|---|
| `first_completed_activity` | people whose first ever completed activity falls in the period | platform, organisation, venue, event, team |
| `repeat_participants` | people who completed an activity on a later calendar day than their first | same |
| `activation_rate` | sign-ups in the period who completed an activity within 14 days (not filterable by sport) | platform |
| `vacancy_fill_rate` | confirmed places / places offered in open games starting in the period (cancelled games out) | platform, organisation, venue, event, team |
| `booking_failure_rate` | of bookings the customer did not cancel, the share that were no-shows or cancelled by the venue/system | platform, organisation, venue, event, team |
| `payment_failure_rate` | failed / decided payments (pending left out) | platform, organisation, venue, team |
| `provider_earnings` | paid, un-refunded coaching and marketplace payments, per currency, gross of platform fees | platform (no names), **provider** (your own only) |
| `venue_utilisation` | existing (#596) | unchanged |

**One definition of "completed activity"** (`src/kpi/activity.js`): a game that reached *completed*, a started/substitute match appearance, a *confirmed* booking that was
checked in, academy attendance marked present, a team check-in. Created, open, cancelled, postponed, forfeited and no-show items never count. The experiment
outcomes use the same fragment, so a result can never disagree with a KPI.

Splits: `city` (the venue's city, else the event's, trimmed and capitalised), `channel` (how a person arrived: invited by a member, a consented source, or direct;
for payments, the purpose), plus the existing sport, event, venue, team and month.

## Telemetry never moves a KPI
Governed KPIs read the canonical tables only. Telemetry is used for funnels, experiments' exposure and data-quality checks, so a replayed, forged or flooded event
cannot inflate activation, participation or revenue. (Proven by a test that sends 200 forged and repeated events and compares the figures before and after.)

* **Consent.** Nothing is recorded until a person switches *Help improve the app* on (Account sheet). Withdrawing de-identifies what was recorded and removes the person
  from attribution and experiment results at once. Young people are never recorded and cannot switch it on; the response for them does not reveal why.
* **Definitions** are versioned in `src/growth/events.js`. Unknown events, wrong versions, undeclared properties and non-listed entity types are dropped with a reason.
  Properties are closed enums: no free text. There is no event for health, clinical, insurance, legal, guardian or youth records, so none can be sent.
* **Deduplication.** `(event_key, dedupe_key)` is unique. A retry returns `duplicate` and raises a counter; another person replaying someone's key changes nothing.
* **Reconciliation.** A claim about a booking, reservation, game seat or payment is checked against the record on file (`matched`), and called `unmatched` only after a
  10-minute grace period. The worker runs this (`growth_analytics` step); data quality shows the counts.
* **Limits.** 50 events per request, events older than 7 days or more than 5 minutes in the future are refused, 5,000 events per person per 24 hours.

## Attribution
`record_attribution` stores a person's first-touch source (`search|social|partner|campaign|email|event|other`, plus a short campaign code), only with consent, never
overwritten. A person invited with a loyalty referral code is attributed to **referral** from the existing `loyalty_referrals` record (not blocked or void); nothing is duplicated.

## Experiments
Operator-only. An experiment needs a written hypothesis, two or more variants (first = control), one success measure and optional guardrails (outcomes in
`src/growth/outcomes.js`, each decided from bookings, games and payments on record). Lifecycle: draft → running ⇄ stopped → concluded (a conclusion is required); only a draft can be
redesigned; optimistic `row_version`; never deleted.
* `expose_experiment` is deterministic (hash of experiment key and person), so a person never changes variant. The exposure is stored once with a count; young people always
  get the control and are not recorded; without consent the variant is returned but nothing is stored.
* Results count only consenting people whose follow-up window has finished, show 95% Wilson intervals, say plainly when a variant has fewer than `min_sample` people,
  call a difference "clear" only when intervals do not overlap, and raise a guardrail warning when it is clearly worse than the control.
* `export_experiment_results` is a CSV of aggregates; every export is audit-logged.

## API (tag *Analytics*; REST + OpenAPI + MCP from one definition)
`get_analytics_consent`, `set_analytics_consent`, `record_attribution`, `list_analytics_event_definitions`, `record_analytics_events`, `expose_experiment`,
`list_experiment_outcomes`, `create_experiment`, `list_experiments`, `get_experiment`, `update_experiment`, `get_experiment_results`, `export_experiment_results`,
`get_growth_data_quality`, and the existing `get_kpi_value` / `list_kpi_records` / dashboards / exports for the new metrics.

## App
* Explore: the new metrics, the City split and the Provider scope appear automatically from the catalogue.
* Analytics → **Growth** (operators): data-quality panel and experiments (list, create, start/stop/resume/conclude, results, CSV).
* Account sheet: *Help improve the app* switch. `src/track.js` sends reservation-completed, game-joined and venue-viewed events, consent-first and fire-and-forget.
* iOS, iPadOS, Android and web share the code; no web-only API is used.

## Schema (migration `139_growth_analytics.sql`, additive)
`analytics_consents`, `analytics_attributions`, `analytics_events`, `experiments`, `experiment_exposures`. No existing table is altered; nothing is dropped, truncated or cascaded.
**Rollback:** stop the app writing (the API/app can be rolled back independently); the tables can stay empty and unused, or be exported and dropped, with no effect on anything that existed.

## Configuration
`ANALYTICS_RETENTION_DAYS` (default 395, minimum 30): telemetry older than this is **de-identified** (person link, entity and properties removed; the row and its counters stay).
Rows are never deleted, in line with the project's data-retention rule.

## Failure modes
* Telemetry stops arriving → data quality shows *Out of date* after 48 h; KPIs are unaffected.
* Many `unmatched` events → data quality warns above 5% (a client sending events for records that do not exist).
* A source table stops updating → the KPI's own freshness warnings (existing layer) show it.
* A client retried with a new dedupe key counts twice as telemetry (never as a KPI); clients keep the key across retries (`src/track.js`).

## Residual limitations
* `provider_earnings` covers coaching sessions and marketplace engagements only (not appointments, physio packages or service invoices) and is gross of platform fees.
* Payment failures can be attributed to a venue, organisation or team only for venue-invoice payments; other purposes appear at platform scope.
* `search_performed` is defined but not yet sent by the app (to avoid event floods on map panning); the other events are wired at reservation, game join and venue view.
* The existing Analytics screen's own labels are still English-only; the new Growth tab and the consent switch are fully translated (machine-drafted, `reviewed: false`).
* Native iOS/Android devices were not run in this environment; the web build was verified at phone, tablet and desktop widths.
