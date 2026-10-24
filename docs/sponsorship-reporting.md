# Sponsorship portfolio reports (#305)

Five live dashboards over the canonical sponsorship tables — **ageing, award funnel, beneficiary outcomes, fulfilment, renewals** — with CSV / XLSX /
branded PDF export, saved filters and scheduled delivery. Nothing is a second ledger: every figure is read from agreements, obligations, payments,
awards, deliveries and performance records at request time, under the caller's **live** role and the athlete's **live** consent. Only saved filters,
schedules and a delivery log are stored. Extends the Sponsors area (one new **Reports** screen); it does not duplicate the beneficiary portfolio
(per-beneficiary view) — those are different groupings of the same sources and link to the same agreement screens.

## Rules
- **Reporting basis is explicit.** Every report returns `basis`: `as_of` (never in the future), `currency_basis` and `generated_at`. Cash counts payments confirmed on or before `as_of`; refunds and concessions are as recorded now (stated in `basis.notes`).
- **Cash and estimates stay separate.** Cash = confirmed payments net of refunds. Estimates (goods / endorsement values) are their own rows/columns, carry no days-past-due and no bucket, and are never added to cash. A reported-but-unconfirmed payment is its own column and is never settled money. Goods and endorsements are *fulfilled* only when the other side confirmed them.
- **Currencies never combine.** `native` keeps each currency apart. `reporting` converts only at the sourced budget FX rate already recorded on the agreement (`sponsorships.budget_fx_rate_id`); an item without one stays in its own currency, is flagged `converted=false`, and the `fx` source shows **missing**.
- **Exports reconcile by construction.** CSV, XLSX (Report / Totals / Basis sheets) and PDF are built from the same row set as the dashboard. Amounts are minor units (`*_cents`) with their currency. Ageing totals equal `list_sponsorship_obligations` and `get_sponsorship_reconciliation` (tested). `reconciles` is false if buckets do not add up to the outstanding total.
- **Live access and consent.** Sponsor view needs the `report` action (manager, finance, approver, auditor); export needs `export`; saving a schedule needs `report_schedule` (manager, finance). Outcomes are read only while the agreement is running **and** the athlete's sharing switch is on (`official` scope reads official evidence only); otherwise the row shows `not_shared` with no figures — in the screen and in every export. Youth athletes are masked. Recipient view returns only your own agreements.
- **Missing and stale sources are visible.** `sources[]` per report: `ok` / `stale` / `missing` with a plain-language detail (e.g. reported payments unconfirmed > 7 days, dispatched goods unconfirmed > 14 days, athletes not sharing results, undecided applications > 30 days after a round closed, no sourced FX rate).
- **Scheduled jobs dedupe.** `sponsor_report_runs` has a unique key `(schedule_id, period_on, recipient_id)`: a repeated sweep or several workers prepare each delivery once. A recipient who has lost their role gets a `skipped_no_access` row and no notice. The notice carries no figures and links to the run; opening it re-reads the data as of the run's date under the recipient's access at that moment (the file is not stored, so revoked access/consent cannot leak through an old file). A paused or archived schedule never runs; a long-paused one delivers once and resumes on its rhythm.
- **Stale edits.** Filters and schedules carry `row_version`; a stale update/archive returns **409** with `details.code = stale_version`.
- **Size.** A report with more than 20,000 rows returns 422 asking to narrow the filters.

## Capabilities (REST + OpenAPI + MCP)
| Capability | Path |
|---|---|
| `get_sponsorship_report` | `GET /sponsorship-reports/:kind` (`ageing\|funnel\|outcomes\|fulfilment\|renewals`) params: `view`, `as_of`, `currency_basis`, `currency`, `sponsor_ids`, `program_id`, `from`, `to`, `target_type`, `bucket`, `state`, `window_days`, `limit`, `offset` |
| `export_sponsorship_report` | `GET /sponsorship-reports/:kind/export` `format=csv\|xlsx\|pdf`, `kit_id` (brand kit for the PDF) → `{filename, content_type, encoding, content}`; audit-logged, CSV-injection safe |
| `list/save/update/archive_sponsorship_report_filter` | `/sponsorship-report-filters` (private to the owner) |
| `list/create/update_sponsorship_report_schedule` | `/sponsorship-report-schedules` (cadence weekly/monthly/quarterly, format, ≤20 recipients, pause/resume/archive) |
| `list_sponsorship_report_runs`, `get_sponsorship_report_run` | `/sponsorship-report-runs` (`download=true` returns the file in the schedule's format) |

## Schema (migration `100_sponsorship_reporting.sql`, additive)
`sponsor_report_filters`, `sponsor_report_schedules`, `sponsor_report_runs`. No existing table is altered, no seed data, nothing is deleted (archived_at).
**Rollback:** deploy the previous code; the three tables are simply unused. **Dependency order:** needs migrations ≤ 099 (agreements, budgets/FX, awards, performance, renewals). The worker step `sponsor_reports` (in `STEPS`, `apps/api/src/worker.js`) runs with the other maintenance steps and is isolated like them.
**Recovery:** a failed sweep rolls back and retries next cycle; a 4xx failure for one recipient is recorded on its run row.

## UI
`SponsorReports` in `apps/app/src/screens/sponsor-reports.js`, opened from **Sponsors → Funding programs → Reports**. Controls follow the app rules: report kind/age/state/cadence/format are chips, the reporting date and ranges use the calendar, brands/programs/people/brand kit use the search-and-pick control, the reporting currency the currency dropdown, "look ahead" a stepper. Filters fold into a one-line summary so the numbers come first on a phone. States: loading, empty, filtered-empty (clear filters), denied (403/404), stale/missing source banners, stale-version messages, recoverable error with retry. A person who runs no brand starts in the beneficiary view.
Browser journey: `scripts/e2e/sponsorship-reports-journey.mjs` (phone/tablet/desktop, downloads CSV/XLSX/PDF).

## Limits
Email delivery uses the existing notification outbox (needs `NOTIFY_WEBHOOK_URL`); notices carry no attachment, by design. Native iOS/Android builds were not exercised (web build only). Historical `as_of` does not reconstruct refunds, concessions, application or delivery status after that date. PDFs use the built-in Latin fonts unless `DOC_FONT_REGULAR` is set (same as other documents).
