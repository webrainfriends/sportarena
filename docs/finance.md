# Finance control plane (#564)

One canonical, append-only record of every money movement. Modules keep their own workflow; they do not own a financial truth.
Money reads (dashboards, exports, reconciliation) come only from `fin_transactions`.

## Model
`fin_transactions` — one row per movement: `kind` (charge, payment, refund, credit_note, chargeback, payout, payout_reversal, adjustment),
`status` (open, settled, failed, cancelled, disputed, reversed), source module / type / id, payer and payee (user and organisation),
currency, gross / tax / fee / discount / net (minor units, positive, the kind gives the direction), provider and provider reference,
links to `payments` / `provider_payouts`, `parent_id` (a refund or chargeback points at its payment) and a unique `idem_key`.
A trigger refuses deletes and any change to amounts or parties; only the lifecycle status may move. `fin_tx_events` is the audit trail.
`fin_recon_items` holds canonical-ledger drift; provider-settlement exceptions stay in `settlement_exceptions` and both show in one queue.

## Where it is posted (all idempotent, inside the transaction of the movement)
| Movement | Hook |
|---|---|
| Checkout started | `recordCharge` (open) in `startCheckout` |
| Provider confirmed payment | `recordPayment` in `settle`; settles the charge; tax and fee come from the provider ledger / invoice |
| Refund (admin, cancellation, credit note) | `recordRefund` in `refund`, `refundPartial`, `booking/refunds` |
| Customer dispute | `recordChargeback` (disputed) in `onProviderDispute`; lost / won in `resolve_settlement_exception` |
| Payout | `recordPayout` when created and when its result is recorded |
Anything that predates the control plane, or whose posting failed, is caught up by `reconcileFinance` (worker step `finance`, or
`POST /admin/finance/reconcile`). It is safe to run twice and beside live traffic.

## API / MCP (one capability each, REST + OpenAPI + MCP)
`get_finance_summary`, `list_finance_transactions`, `get_finance_transaction` (trace + history, audit-logged),
`export_finance_transactions` (CSV, audit-logged), `list_finance_reconciliation`, `run_finance_reconciliation` and
`resolve_finance_reconciliation_item` (platform admin only, `mustBePlatformAdmin`).
Organisation views need the owner / admin / finance role (404 for everyone else); without `organisation_id` the whole-platform view is platform-admin only.
Currencies are never added together. Tax figures are informational, not tax advice.

## App
`Finance` screen (More → Finance, Organisation → Money → Open Finance console, deep link `?open=finance:<orgId>`): overview, transactions with a
trace panel, receivables, payables, settlements and reconciliation. Same React Native screen on iOS, iPadOS, Android and web.

## Organisation control plane (#593)
Extends the plane above; there is no second ledger and no second console. Everything below reads `fin_transactions`.

**New dimensions** (migration `140`, additive): `season_id`, `event_id`, `team_id`, `workspace_id` (organisation department), `due_on`, `category`.
They are filled from the source record when a row is posted and caught up by `applyDimensions` during reconciliation; the append-only guard still refuses any
change to kind, amounts, currency, source type, idem key, payment or parties.

**Canonical views** (`category`): registration & membership, event & ticket income, venue & service income, sponsorship, supplier spend, event budget spend,
settlements & payouts, other. `commissions` = provider/platform fees taken from payments, `taxes` = tax contained in payments (informational).

**Sources put on the ledger by `src/finance-sync.js`** (worker step `finance` / `POST /admin/finance/reconcile`, idempotent, keyed):
| Source | Posted as | Key |
|---|---|---|
| Academy charges, team charges, registration instalments, supplier invoices, sponsorship money obligations | open `charge` with `due_on`; status follows the source (open, settled, cancelled) | `obl:<type>:<id>` |
| Receipts recorded by staff (cash, bank, UPI): academy, instalment, supplier, team charge entries, confirmed sponsorship payments | `payment` (provider `offline`) against the same source | `receipt:...` |
| Event budget payments | `payment` out of the event's organisation; a voided payment is `reversed` | `ebp:<id>` |
A checkout that was started for a source that already has an obligation is not posted as a second receivable; an earlier open checkout charge is cancelled when the obligation appears.
Outstanding on a charge = charge less the settled payments the ledger holds for the same source, so partial payments age correctly.

**API / MCP**: `get_finance_summary` (now also `by_category`, `commissions`, `taxes`, `level`; filters `season_ids`, `event_ids`, `team_ids`, `workspace_ids`, `categories`),
`list_finance_transactions`, `get_finance_filters`, `get_finance_ageing`, `list_finance_obligations` (upcoming cash, bucket drill-down), `list_finance_settlements`,
`list_finance_audit`, `list_finance_access`, `set_finance_access`, `resolve_organisation_finance_reconciliation_item`; `export_finance_transactions` now returns a manifest
(generated by/at, filters, row count, SHA-256 of the CSV) and keeps source module/type/id and the ledger key on every row.

**Finance levels** (read live on every call): viewer (read) < accountant (also export, close reconciliation items, read the audit history) < controller (also manage access).
Owner/admin = controller, the finance role = accountant (what it could always do), anyone else needs a grant (`fin_finance_access`, revoked by status, never deleted).
Outsiders get 404; a member without a finance level gets 403. Platform view stays platform-admin only.

**App**: the same `Finance` screen. Filters (organisation, period, currency, season, event, team, workspace, category, module) are dropdowns fed by `get_finance_filters`
(only values that exist in the books); Overview tiles drill into Transactions; Receivables/Payables show ageing buckets and the items behind them; Access & audit manages levels.
All text is translated through `t()` (`fin.*`); machine-drafted languages stay `reviewed: false`.

## Migration status (honest)
Covered now: every purpose that settles through `payments` (shop, coaching, doctor / physio, venue invoices and plans, POS online, wallet, gift cards,
sponsorship, academy and team charges / contributions, media rights fees, advertising funding, supplier invoices, insurance), plus refunds,
chargebacks and provider payouts; and, from #593, unpaid obligations and staff-recorded receipts for academy/team charges, registration instalments, supplier invoices and
sponsorship dues, and event budget payments.
Still module-local (tracked, not hidden): player-contract payouts, agent commissions, trip payments, officials pay, POS cash, rewards and wallet ledgers; credit notes and
amendments after an obligation was posted (the obligation keeps its original amount); partial online payments against a sponsorship due (the due settles when confirmed
payments cover it); payouts are attributed to an organisation through its owners/admins/finance staff; invoice / allocation / instalment / deposit objects as canonical
tables; tax models, rounding rules and provider configuration per entity.
