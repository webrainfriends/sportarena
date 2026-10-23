# Sponsorship budget controls (#293)

A brand authorizes **annual, program, department and event budgets**, links programs and agreements to them, and reads
planned / reserved / committed / paid / refunded / available balances. There is **no second ledger**: balances are derived live from the
tables that already hold the truth (award reservations, agreement obligations, confirmed and reversed payments).

| Balance | Meaning |
|---|---|
| authorized | what was approved for this budget |
| allocated | carved out for child budgets (same currency); a child can never exceed the parent's unallocated amount |
| planned | offers sent but not accepted. **Never** reduces available and is never income |
| reserved | held for awards not yet accepted |
| committed | money dues of accepted agreements (cancelled dues are released) |
| paid / refunded / reported | recipient-confirmed payments / confirmed payments later reversed / unverified claims (never counted as paid) |
| available | authorized − allocated − reserved − committed |

## Invariants
* Every reservation and acceptance first **locks the budget row**, then checks `available`, so concurrent awards cannot overspend.
  Lock order: program → round → application → award → budget (a parent budget before its child).
* Currencies stay separate: a budget counts only its own currency unless `fx_policy='explicit'` and a **sourced rate** (source required,
  optional https reference, as-of date) exists. Rates are immutable; a new rate supersedes the old for **future** commitments, and anything
  already reserved or committed keeps the `budget_fx_rate_id` it was made at, so balances reconcile.
* `approval_over_cents`: an offer above it waits (`budget_approval='pending'`) for a second approver (`budget_approve`); the recipient is not
  told, cannot read or accept it until approved; rejection withdraws it. A program award above it gets an extra approver sign-off.
* Releases (decline, expiry, withdrawal, ending an agreement's future dues) and payment reversals flow straight into the balances.
* Event budgets fund one event only; department budgets only that department's offers. The organiser's event budget already shows the same
  agreements as sponsorship (kept apart from income lines), so nothing is duplicated.

## Migration `094_sponsorship_budgets.sql` (additive)
New tables `sponsorship_budgets`, `sponsorship_budget_fx_rates`, `sponsorship_budget_events`; nullable `budget_id` on `sponsorship_programs`,
`sponsorship_award_reservations`, `sponsorships` (+ `budget_fx_rate_id`, `budget_approval*`). Existing rows keep `budget_id NULL` and behave
exactly as before. Nothing is dropped or rewritten; budgets are archived, never deleted.
Rollback: deploy the previous code; the new columns/tables are unused. Dependency order: programs (#284) → awards (#289) → this.

## Planning: guidance, rationale, references and files (migration `096_budget_planning.sql`, additive)
Authorizing a budget is a five-step flow (scope → amount → controls → support → review) instead of one long form.
* **Guidance** (`get_budget_guidance`, `GET /budget-guidance`): the brand's earlier comparable budgets (archived ones included) with what was authorized
  against what was really used (committed + reserved, children included), the unspent or overspent difference, the average utilisation, a suggested
  figure (the latest comparable's actual use, same currency only) and a warning when an active budget for the same scope exists. Nothing is converted
  or added across currencies. A budget built on a suggestion keeps `basis_budget_id`.
* **Currency** is a searchable dropdown (shared by every form) that starts on the currency of the person's locale region and can be changed; a child
  budget is locked to its parent's currency.
* **Rationale** (`notes`) and **references** (`add_budget_reference` / `remove_budget_reference`: approval memo, board minutes, forecast, purchase order,
  contract, policy; an https link and/or a reference number). `create_sponsorship_budget` accepts up to 10 references at creation.
* **Files** use the shared documents folder (`PUT /documents`, `subject_type=budget`): encrypted, PDF or photo up to 10 MB, managers and finance add
  and hide, approvers and auditors read, every download is audit-logged. Removing a reference or file only hides it.
New objects: `sponsorship_budgets.notes` / `basis_budget_id`, table `sponsorship_budget_references`, and the `subject_documents` subject/kind CHECKs widened
(`budget`; `approval`, `forecast`, `invoice`, `report`). No existing row is touched.

## Capabilities (REST + OpenAPI + MCP)
`create_sponsorship_budget`, `update_sponsorship_budget` (needs `version`; 409 if stale), `list_sponsorship_budgets` (deterministic order, roll-up per
currency tree), `get_sponsorship_budget`, `list_budget_commitments` (paged), `set_budget_fx_rate`, `link_program_budget`, `decide_budget_approval`,
`export_sponsorship_budget` (CSV, audit-logged), `get_budget_guidance`, `add_budget_reference`, `remove_budget_reference`; `propose_sponsorship` takes `budget_id`.
Permissions (new sponsor actions): `budget_read` (manager, finance, approver, auditor), `budget` (manager, finance), `budget_approve`
(manager, approver, finance), export (manager, finance, auditor). Another brand gets 404; department-scoped staff reach only their department's
budget. The recipient never sees budget fields.

## App journey
More → Workspace → Budgets (or Programs → Budgets): list → budget detail (balances, what draws on it, children, programs, FX rates, history,
approve/reject, edit, archive, export); program page → **Budget** section; athlete offer form → "Draw on a budget". Loading, empty, denied,
stale-version and recoverable-error states are covered.

## Tests
`apps/api/test/budget-planning.test.js` (guidance, references, budget documents) and `apps/api/test/sponsorship-budgets.test.js` (PostgreSQL): nesting and stale edits, concurrent awards, proposals-are-planned, payments and
reversals, ending an agreement, FX policy and rate pinning, approval threshold and recipient hiding, isolation/roles/export audit, event and
department rules, additive repeatable migration.
