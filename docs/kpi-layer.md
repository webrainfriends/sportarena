# Unified Sports Analytics & Semantic Metrics Layer (#596)

One governed definition of each shared KPI, computed live from the canonical tables. Nothing is copied: the layer stores only the version history of
definitions, saved dashboards (recipes) and report schedules. Migration `127_kpi_layer.sql` is additive.

## How it works
`src/kpi/catalogue.js` defines every metric once: key, **version**, formula text, owner, audience, scope types, dimensions, data sources, data-quality flags and
**one `facts` query**. `src/kpi/engine.js` runs it. The value, group-by, drill-down, freshness and warnings are all derived from that one query, so a KPI and the
records behind it always reconcile. A changed definition without a higher `version` is refused (`syncCatalogue`); versions are append-only in `kpi_definition_versions`.

Other modules obtain a figure with `computeKpi` / `kpiValue` (same live access checks). A test fails if any module outside `src/kpi` produces a governed metric name.

## Metrics
| Key | Definition (short) | Scopes |
|---|---|---|
| `active_athletes` | distinct athletes with a live/completed game entry or a started/substitute match appearance in the period | platform, organisation, venue, event, team |
| `registered_participants` | distinct people with a `registered` registration in effect in the period | same |
| `matches_played` | distinct games with status `post-event` that started in the period (every sport) | same |
| `attendees` | distinct (person, day) check-ins: venue bookings, academy attendance, team check-ins | same |
| `revenue` | paid invoices net of tax minus credit notes, per currency | platform, organisation, venue, team |
| `receivable` | open invoices + academy charges + team dues still owed, per currency | same |
| `sponsor_value` | confirmed sponsorship cash net of refunds, per currency | + event, brand |
| `sponsor_fulfilment` | accepted / due deliverables (cancelled and excepted removed) | + event, brand |
| `venue_utilisation` | confirmed booked minutes / opening-hour minutes (venue time zone) | platform, organisation, venue |
| `athlete_availability` | share of active squad players whose status is `available` now; groups under 5 hidden outside a team you manage; no clinical data read | platform, organisation, team |

A record belongs to a scope when its event, venue, team, organisation or brand is in that scope. Money is never summed across currencies.

## API (tag *Analytics*; REST + OpenAPI + MCP from one definition)
`list_kpi_catalogue`, `get_kpi_definition`, `list_kpi_scopes`, `get_kpi_value`, `list_kpi_records`, `create/list/get/update/archive_kpi_dashboard`,
`export_kpi_report` (CSV / XLSX / branded PDF, reusing the sponsorship exporter), `create/list/update_kpi_report_schedule`, `list_kpi_report_runs`, `get_kpi_report_run`.

## Rules enforced on the server
* Scope access is read live: outsiders get 404, a role too narrow for the metric gets 403 with the reason, the platform scope is admin-only.
* A dashboard stores a recipe; every viewer sees only what their own role allows (locked tiles are explained gaps, never zeros). Sharing to `admin`/`platform_admin` is refused; you may only share to roles you hold.
* Scheduled runs are one row per (schedule, period, recipient), built under the recipient's access at that moment; the notification carries no figures.
* Drill-down and export are audit-logged. Dashboards and schedules are archived, never deleted.

## Inventory of existing reporting (what overlaps)
| Existing | Relationship |
|---|---|
| Sponsorship reports (#305) | domain-specific views stay; exporter and schedule pattern reused here; `sponsor_value`/`sponsor_fulfilment` are the shared figures |
| Partner finance (`revenue_report`, `platform_dashboard`) | commission/settlement views stay; **not yet rewired** to `revenue` |
| Academy receivables / executive | academy charges are a source of `receivable`; the executive field `active_athletes` was renamed `enrolled_athletes` (it counts programme enrolments) |
| Commercial engine `active_athletes` gauge | billing meter key stored in plan data; left as is (allow-listed) |
| Org / event command centres | operational queues; not KPIs |
| `metric-governance.js` (#320) | per-sport scoring rules; unrelated |

## Known gaps
Legacy dashboards are not yet rewired to call the layer (only the guard test prevents new conflicting definitions); venue utilisation ignores maintenance
closures; department-scoped sponsor members cannot use brand-wide analytics; native iOS/Android devices were not run (web build verified at phone, tablet and desktop widths).
