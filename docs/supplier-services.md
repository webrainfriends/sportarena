# Supplier services & procurement (#458)

Suppliers sell services as well as goods; organisers, schools/academies and venues plan, quote, award, receive, invoice and pay. Goods commerce (`shop.js`), internal stock (`supply.js`), event requests/budgets and venue/academy invoices are unchanged.

## Existing → gap → what was built
| Existing | Gap | Built (additive) |
|---|---|---|
| `shop.js` goods, stock, shipping | no labour/time/recurrence | `svc_offerings` (service / goods / mixed, structured unit + rate; a mixed offering may link a shop product, stock stays in the shop) |
| `supply.js` free-text supplier | no linked supplier, scope, bids | untouched; procurement is `svc_*` |
| event requests / quotes (`event-planning.js`) | single price, no versions, lines, approvals | RFQ may link `event_request_id`; confirming the order finalises that request once and reuses its one budget line |
| event budget | commitment ≠ delivery | order → one `event_budget_lines` row (`svc_order_id`); each payment mirrors once (`event_budget_payments.svc_payment_id`) |
| `invoices` (venue/academy) | no supplier issuer | `invoices` gains `svc_order_id`/`svc_profile_id` (third allowed source); supplier detail in `svc_invoices` |
| branded documents (#249) | no supplier families | `generate_service_document` + generic renderer; canonical invoice PDF now serves supplier invoices |

New entities and why: profiles/staff/credentials (identity, roles, expiry), offerings, tax rules (effective-dated, supplier-configured), buyers + roles (delegated authority, approval limits), lots/requirements, RFQ + versions + invites + clarifications, quotes + lines (frozen once submitted), evaluations, approvals (approver ≠ requester, also a DB CHECK), orders + lines + variations, allocations/blackouts (capacity), visits/attendance/acceptances/incidents, supplier invoices/payments, activity trail. Nothing is deleted: statuses and reasons only.

## States (kept separate)
- RFQ: draft → issued → quoting → evaluation → approval_pending → awarded / partially_awarded → closed; declined / withdrawn / cancelled / expired.
- Quote: draft → submitted → shortlisted → awarded / partially_awarded; withdrawn, superseded (new version or scope), expired, rejected.
- Order (procurement): pending_supplier → confirmed → in_progress → completed; changes_proposed, paused, cancelled, terminated, rejected.
- Fulfilment: planned → scheduled → in_progress → submitted_for_acceptance → partially_accepted / accepted; rework, cancelled. Billing: not_billed / partially_billed / billed. Settlement: unpaid / partially_paid / paid. “Completed” never implies “paid”.

## Rules worth knowing
- Competing bids are private: suppliers see only their own invitation, quotes and clarifications shared by the buyer. Comparison is buyer-side only; different currencies are never added (an FX snapshot is comparison-only and labelled).
- Award binds the exact quote version and scope version; expired/stale quotes, over-awards and duplicate orders fail atomically (RFQ row lock, partial unique index). Above the buyer's threshold or the purchaser's limit an approval opens instead; the approver must differ from the requester.
- Capacity: placing an order takes an **expiring hold** (72 hours) on the days it needs, best effort — if the days are full or blacked out the order is still placed and the supplier decides. Confirmation converts the hold to a reservation under a lock on the supplier profile (blackout days and daily capacity; live holds of other orders count, lapsed ones do not). The worker releases lapsed holds and tells the buyer once; a rejected or cancelled order frees its hold at once.
- Visits have deterministic occurrence keys; regenerating or retrying never duplicates. Site and crew clashes (with travel buffer) are refused. Under-18 crew need the requirement to allow minors and an active guardian participation consent; buyers see headcount and initials only.
- The supplier cannot accept its own work; acceptance caps billing (`qty_invoiced <= qty_accepted`, guarded update at issue).
- Invoices: numbers are gapless per issuer; issued invoices are immutable (DB trigger); correction = linked credit note (and optional restore of quantities to re-bill). Deposits/prepayments are a matching exception needing an approver.
- Money: integer minor units + ISO currency (platform currencies plus three-decimal KWD, BHD, OMR, JOD and TND for procurement only — card payment is refused for them, record a bank or cash payment), tax in basis points, half-away-from-zero rounding per line or per document. Tax rules are the supplier's own, effective-dated, with evidence; **Gotmygame asserts no jurisdiction's tax is correct and does not file e-invoices.** Withholding is deducted from what is payable, evidenced on the invoice.
- Payments: manual bank/cash needs a reference + evidence (one reference = one transfer); provider payments settle only through the existing signed callbacks and are refunded automatically if the invoice can no longer take them. **Payout to the supplier is never implied**: `payout_state` stays `manual_pending` until someone records a transfer with evidence.
- Travel/accommodation orders record a *supplier booking confirmation* or a third-party reference — never live airline/hotel availability.
- Agreements are recorded acknowledgements by signed-in users, not qualified e-signatures.

## Recovery / operations
Reconcile with `export_service_report` (orders, invoices, payments, tax) against dashboards; every figure derives from orders, issued invoices and non-void payments. A voided manual payment unmirrors from the event budget. Background sweeps (`svc/sweeps.js`, in the worker cycle) expire quotes and send visit and overdue reminders, idempotently (dedupe keys).

## Reports and exports
Dashboards are available as JSON, as printable PDFs (`generate_service_document` types `supplier_report` and `buyer_report`, with an optional period) and as background exports. `request_service_export` (CSV, XLSX or PDF of orders, invoices, payments, tax or the whole dashboard) is queued as a durable job, built by the worker (up to 100,000 rows), stored encrypted with its sha256, and readable only by the requester while they still hold the supplier-finance or buyer finance/purchasing authority (checked again at build and at download). The synchronous CSV export stays for small reports (5,000 rows).

## Known limits
- Verified service reviews (#215) are not implemented in the repository, so no review hook exists yet.
- Native iOS/Android devices were not run; web, iOS and Android bundles export successfully and the web build was checked at phone, tablet and desktop widths.
- Dates and times in reports are UTC.
