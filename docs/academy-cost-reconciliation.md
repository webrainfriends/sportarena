# Academy cost & revenue reconciliation (#787)

Extends Academy OS 3/3 (#395) and the shared Finance control plane (#564 / #593). It adds **no** invoice, payment, settlement or payroll ledger and no second console:
it reads the canonical records, reports where they do not line up, and lets a person decide, with an audit trail, how the P&L should read them.

## Requested feature → source of truth → gap → extension
| Requested | Source of truth | Gap found | Extension |
|---|---|---|---|
| Staff cost from approved payroll obligations | `academy_payroll_runs/lines` (approved), `academy_timesheets` | Manual entries were set aside silently | Each set-aside manual entry is a queue item (`double_count_risk`); unpriced timesheets are `payroll_unpriced` items |
| Venue cost | confirmed `bookings` via `session_venue_links` | Unbooked sessions only counted | `venue_unbooked` items |
| Supplier orders / invoices | `academy_supplier_requests` (final cost, invoice ref, delivered_at) | Not in the P&L | `supplierCost` source (category `supplier`), attributed to venue / branch, never invented onto a programme |
| Payment fees | `fin_transactions.fee_minor` (Finance ledger) | Not in the P&L | `paymentFeeCost` source (category `payment_fee`), follows its charge to programme and cohort |
| Provenance, currency, basis, cut-off, allocation version | — | Not reported | `provenance` block on `get_academy_pnl`; `cost_allocation_version` = number of attribution decisions |
| Branch / cohort profitability only where attributable | `academy_programmes.branch_id`, `academy_branches.venue_ids`, enrolment/session cohort | No cohort view | `by_cohort`; the remainder is its own row; a missing figure is `null` ("unknown"), never 0; venue-level supplier cost is shown per branch |
| Reconciliation work queue | `fin_recon_items` (shared queue) | Payment drift only | Widened with academy kinds, a `disputed` state, source columns and a history; the Finance console lists the same rows |
| Human correction with audit | — | None | `academy_cost_attributions` (append-only; newest decision wins) |

## Data model (migration `156_academy_cost_reconciliation.sql`, additive)
- `fin_recon_items`: kind/status CHECKs widened; new columns `domain`, `source_type`, `source_id`, `branch_id`, `history`, `updated_at`; unique index for `disputed` dedupe keys.
- `academy_cost_attributions`: `source_type` (`academy_payroll_line` | `academy_supplier_request` | `academy_cost_entry` | `academy_charge`), `decision` (`programme` | `overhead` | `keep_canonical` | `keep_manual`), optional programme / cohort / overhead method, `reason`, per-organisation `version`. A trigger rejects UPDATE and DELETE.
- `academy_supplier_requests`: `delivered_at` (backfilled from `updated_at` for delivered/done rows), `invoice_ref`.

**Rollback:** stop calling the new capabilities. Nothing is dropped or rewritten, the widened CHECKs accept every old value, and the old P&L keys are unchanged (new keys are additive). Reverting the code leaves the new tables and columns unused and harmless.

## API (REST + OpenAPI + MCP from one definition each; owner / admin / finance only, other organisations get 404)
| Capability | Route |
|---|---|
| `get_academy_cost_reconciliation` | `GET /organisations/:id/academy/reconciliation` |
| `run_academy_reconciliation` | `POST /organisations/:id/academy/reconciliation/run` (idempotent) |
| `list_academy_recon_items` | `GET /organisations/:id/academy/reconciliation/items` |
| `get_academy_recon_item` | `GET /academy/reconciliation/items/:id` (trace, decisions, history; read is audit-logged) |
| `act_on_academy_recon_item` | `POST /academy/reconciliation/items/:id/act` (attribute, overhead, keep_canonical, keep_manual, record_cost, dispute, resolve, note; reason required; 409 once resolved) |
| `get_academy_pnl` (extended) | adds `supplier_cost_minor`, `payment_fee_minor`, `by_cohort`, branch `venue_level_cost_minor`, `provenance` |
| `update_academy_supplier_request` (extended) | accepts `invoice_ref`; sets `delivered_at` |

## Rules
- Money in different currencies is never summed: every figure and queue amount is per currency.
- A manual `other_direct` entry that repeats a delivered supplier request (same currency and amount, within 45 days) is held out; a manual entry covered by payroll or a booking is held out as before. Either way a queue item lets a person keep the canonical record or the manual one.
- A decision is applied when the P&L is read; the canonical payroll line, supplier request, charge or cost entry is never edited. `record_cost` writes the final cost to the supplier request through the same fields `update_academy_supplier_request` owns.
- The check closes items whose records agree again; resolved or disputed items are never reopened or duplicated.
