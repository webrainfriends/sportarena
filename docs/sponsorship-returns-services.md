# Sponsored goods returns, replacements and service vouchers (#300)

Extends the goods flow of [sponsorship-agreements.md](sponsorship-agreements.md). Everything hangs off the canonical `sponsorship_obligations`; there is no second ledger and no new screen: it all lives in the **Commitments** card of the deal screen.

## Rules
* **Dispatch is not receipt.** A dispatch counts only after the recipient confirms receipt (`decide_sponsorship_delivery`). Proof is an https link on both sides (`dispatch_evidence_url`, `receipt_evidence_url`); a rejection carries a reason (damaged / wrong item / not as described / other).
* **Returns** (`request_sponsorship_return`) apply to *received* goods only. The recipient asks for a replacement or a credit; the sponsor accepts (choosing replace or credit) or disputes (reason required); the recipient may cancel an open request. Nothing changes the received count until the sponsor accepts.
* **Reconciliation** (one function, `goodsPosition` in `sponsor-agreements.js`): `net = received − accepted returns`; `credited = accepted returns closed by credit`; `remaining = committed − (net + in transit + credited)` is what the sponsor may still dispatch; the due is **fulfilled when `net + credited ≥ committed`** and **re-opens** if an accepted return uncovers it. A credited unit is never counted as received and is never re-dispatched.
* **Replacements** are ordinary dispatches that name an accepted `replace` return (`replaces_return_id`), at most its quantity, once per return (partial unique index).
* **Service vouchers**: a new line kind `service` (`service_type` = coaching | venue | travel | medical, `quantity` = funded units; split across dues exactly like goods). The sponsor issues vouchers (`issue_sponsorship_vouchers`) up to the funded units; void or expired vouchers free their unit. The recipient redeems (`redeem_sponsorship_voucher`); the due is fulfilled when every unit is redeemed.
* **Redemption is exactly-once**: `UNIQUE(voucher_id)` on `sponsorship_voucher_redemptions` plus a row lock. A retry with the same `idempotency_key` by the same person returns the original (`replayed: true`); any other attempt gets 409. A venue voucher may name one of the person's own confirmed `bookings` (each booking funds one voucher); coaching/travel take a short reference.
* **Medical vouchers grant no clinical access**: they accept no booking or reference, create no `medical_grants` or any other access, and the sponsor only ever sees that a voucher was used and when (the redemption detail is never returned to the sponsor for any service type).
* **Estimated goods value stays separate from cash**: `estimate_cents` is never added to committed/confirmed money; returns and credits move quantities only.
* **Authorization**: all writes go through `obligationContext`: sponsor staff need the `pay` permission, only the recipient reports a return / confirms receipt / redeems, unrelated users get 403 on reads and writes. Every decision endpoint takes an optional `expected_version`; a stale one is refused with 409 `stale_version`.

## Schema (migration `099_sponsorship_returns_services.sql`, additive)
* `sponsorship_lines` / `sponsorship_obligations`: `kind` check widened to include `service`; `sponsorship_lines.service_type`.
* `sponsorship_deliveries`: `version`, `dispatch_evidence_url`, `receipt_evidence_url`, `rejection_reason`, `replaces_return_id`. Existing rows keep working (all defaults).
* New: `sponsorship_delivery_returns`, `sponsorship_vouchers`, `sponsorship_voucher_redemptions`. No `DELETE`, no cascade; a voided voucher or cancelled return stays as a row.

## API (REST + OpenAPI + MCP via `cap(...)`)
`request_sponsorship_return` POST `/sponsorship-deliveries/:id/returns` · `decide_sponsorship_return` PATCH `/sponsorship-returns/:id` · `issue_sponsorship_vouchers` POST `/sponsorship-obligations/:id/vouchers` · `void_sponsorship_voucher` PATCH `/sponsorship-vouchers/:id` · `redeem_sponsorship_voucher` POST `/sponsorship-vouchers/:id/redeem`. Extended: `dispatch_sponsorship_goods` (evidence, replacement), `decide_sponsorship_delivery` (evidence, reason, version), `get_sponsorship` / `list_sponsorship_obligations` (returns, vouchers, returned/credited/net quantities), `get_sponsorship_summary` (`services_outstanding`).

## Order, rollback, recovery
Deploy order: migration 099, then API, then app (an old app still works: it just does not show returns or vouchers). Rollback: stop using `service` lines and the new endpoints; nothing is dropped, and the widened check and new columns are harmless to old code. Recovery: the position functions are derived from rows, so re-running a decision is safe; a stuck due is re-evaluated by the next decision, and `rebuild_sponsorship_schedule` is unchanged.

## Limits
Evidence is an https link (no file upload). Disputed returns are recorded and visible to both sides; escalation to the cases system is not wired. Voucher redemption does not create a booking itself: venue vouchers link a booking made through the existing booking flow, and coaching/travel/medical vouchers record the funded use only.
