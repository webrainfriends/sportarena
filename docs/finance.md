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

**Further sources** (same sync, same idempotency, each with its own tests in `test/finance-sources-*.test.js`):
| Source | Posted as | Key |
|---|---|---|
| Agent commission statements (athlete pays agent) | open `charge` per issued statement, module `agents`, category `commissions`; confirmed (`payment_settled`) payments allocated oldest statement first; refund entries post a `refund` | `obl:representation_statement:<id>`, `receipt:representation_commission_entry:<entry>:<stmt>` |
| Player payout lines (club pays player) | open `charge` once the run is approved (payer org = team or event organisation), cumulative receipt when paid, `tax_minor` = withheld | `obl:player_payout_line:<id>` |
| Official fees marked due by the organiser | open `charge` (payer org = event organisation); a fee paid directly adds a receipt, one paid through a payout batch settles with none (the payout row already exists) | `obl:official_fee:<id>` |
| Trip claims and payments | approved claim = open payable; payments recorded outside the event budget post as spend and are reversed when voided (event-budget payments already post as event spend) | `obl:trip_claim:<id>`, `receipt:trip_payment:<id>` |
| Front-desk (POS) cash, card-terminal, UPI and bank tenders and their refunds | `payment` / `refund`, provider = method, tax pro-rated from the sale (online tenders are already posted through payments) | `receipt:pos_sale_payment:<id>`, `refund:pos_sale_payment:<id>` |
| Wallet-paid venue invoices | `payment` (provider `wallet`) and refund of what was returned; loyalty points and passes are not money and are not posted | `receipt:invoice_credit:<id>` |
| Supplier credit notes | `credit_note` against the invoice it adjusts; outstanding nets it | `crn:service_invoice:<id>` |
| Sponsorship | online payments now carry sponsor and recipient organisations and net the due through `sponsorship_payments.obligation_id`; offline refunds post the delta and reopen the due | `refund:sponsorship_payment:<id>:<refunded>` |
Organisations of payout rows for officials fees paid through a batch are filled from the event. Outstanding on a charge = charge less settled payments and credit notes for the same source (plus refunds for sponsorship dues).

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
Covered: every purpose that settles through `payments`, refunds, chargebacks, provider payouts, and (from #593) the obligations, staff-recorded receipts, spend and credits listed above for registration and team charges, instalments, suppliers, sponsorship, event budget, agent commissions, player payouts, official fees, trips, front-desk tenders and wallet tenders.
Still outside the ledger, by design or not yet built:
- Drawer movements (cash drops, paid-outs, float) are cash handling, not income, and stay in the shift record.
- Loyalty points and pass credits have no currency value and are not posted.
- A credit note on a venue invoice reduces money only through the refund that pays it back; a credit note on a still-unpaid venue invoice does not change a receivable (venue invoices are not obligations here).
- Player-contract credit notes and expense reimbursements are covered only through the payout line that pays them.
- A supplier invoice keeps the amount it was first posted with; later credit is a separate `credit_note` row.
- Tax: figures are those the source module computed (supplier tax, GST on venue invoices, POS tax, provider ledger tax, payout withholding). A per-entity tax engine with its own rounding rules and provider configuration is not part of this plane.
