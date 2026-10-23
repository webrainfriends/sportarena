# Beneficiary portfolio (#292)

One read model over the canonical sponsorship tables, grouped by **beneficiary** (athlete, team or event). It answers: who do we support
(or, as a recipient, who supports us), how much was requested vs awarded vs offered, what is committed, received and outstanding, and what
needs attention. It is **read-only**: acting stays in the agreement and program screens, so there is no second workflow or ledger.

## Rules
- **Reconciles with the source.** Money is read live from applications, awards, obligations and confirmed/reported payments. `outstanding = committed - confirmed`, the same definition as `list_sponsorship_obligations`.
- **Requested vs awarded.** `requested` = live applications; `awarded` = accepted awards; `offered` = issued/approved/pending awards not yet accepted; `gap = requested - awarded - offered` per application.
- **Currencies never combine.** Every figure is per currency. Legacy agreements without structured terms (no currency) are labelled and excluded from totals.
- **A reported payment is never received.** It is shown as `reported_unconfirmed` until the recipient confirms it.
- **Scoped visibility.** Sponsor view = brands you run (department-scoped members see their department's agreements only; program data needs brand-wide access). Recipient view = events, teams and your athlete profile you own. Another sponsor's terms, amounts, ids and names are never returned; only a count of *other sponsors' public active deals* is shown.
- **Roles.** Reviews need the `performance` action, export needs `export` (manager, finance, auditor). Next actions are filtered to what the caller's role may do.
- **Youth.** A youth athlete is masked ("Youth athlete") for sponsors, cannot be found by real name, and their review notes are not read from here.
- **Tenant isolation.** 403 when you have no relationship (does not reveal whether the beneficiary exists). Export is audit-logged and CSV-injection safe.
- **Deterministic paging.** Order is (sort key, lower(name), type, id); `total` counts every match; `totals` cover all matches, not just the page.

## Capabilities (REST + OpenAPI + MCP)
| Capability | Path |
|---|---|
| `list_beneficiary_portfolio` | `GET /beneficiary-portfolio` filters: `view`, `sponsor_id`, `program_id`, `target_type`, `q`, `stage`, `has_gap`, `risk`, `currency`, `sort`, `limit`, `offset` |
| `get_beneficiary_portfolio_entry` | `GET /beneficiary-portfolio/:target_type/:target_id` agreements, applications, history, milestones, documents, reviews, risks, next actions, `snapshot` |
| `export_beneficiary_portfolio` | `GET /beneficiary-portfolio-export` CSV, one row per beneficiary and currency |

`snapshot` changes whenever the entry's data changes; the app polls it and shows a refresh banner so a stale screen is visible. Writes made from the linked
agreement screens keep their own version checks (409 on a stale version).

## UI
`SponsorPortfolio` (list) and `PortfolioEntry` (detail) in `apps/app/src/screens/sponsor-portfolio.js`, opened from the Sponsors screen. States: loading,
empty, filtered-empty, denied/revoked (403/404), recoverable error with retry, stale banner. Verified in a browser (Chromium) at phone, tablet and desktop widths for both the sponsor and recipient views; native iOS/Android builds were not exercised.

## Migration and rollback
`094_beneficiary_portfolio.sql` only adds indexes (`IF NOT EXISTS`). No data is created, changed or removed. Rollback = deploy the previous code; the indexes can stay.
Dependencies: reads tables from #145, #284-#289; no dependency on #243/#249 (notifications and branded documents are not emitted from here).

## Limits
Documents list award letters and payment/endorsement evidence links; they are not stored here. Application files stay under the evaluation roles.
