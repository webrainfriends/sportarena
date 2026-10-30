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

## Migration status (honest)
Covered now: every purpose that settles through `payments` (shop, coaching, doctor / physio, venue invoices and plans, POS online, wallet, gift cards,
sponsorship, academy and team charges / contributions, media rights fees, advertising funding, supplier invoices, insurance), plus refunds,
chargebacks and provider payouts.
Not yet on the control plane (still module-local, tracked in the issue): offline / manual receipts (cash, bank), academy and team charges before they are paid,
sponsorship obligations, player-contract payouts, agent commissions, trip payments, event budget payments, officials pay, POS cash, rewards and wallet ledgers,
and the invoice / credit-note / allocation / instalment / deposit objects as canonical tables. Tax models, rounding rules and provider configuration per entity
are likewise still to do.
