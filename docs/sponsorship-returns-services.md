# Sponsored goods returns, replacements and service vouchers (#300)

Extends the goods flow of [sponsorship-agreements.md](sponsorship-agreements.md). Everything hangs off the canonical `sponsorship_obligations`; there is no second ledger and no new screen: it all lives in the **Commitments** card of the deal screen.

## Rules
* **Dispatch is not receipt.** A dispatch counts only after the recipient confirms receipt (`decide_sponsorship_delivery`). Proof is an https link on both sides (`dispatch_evidence_url`, `receipt_evidence_url`); a rejection carries a reason (damaged / wrong item / not as described / other).
* **Returns** (`request_sponsorship_delivery_return`) apply to *received* goods only. The recipient asks for a replacement or a credit; the sponsor accepts (choosing replace or credit) or disputes (reason required); the recipient may cancel an open request. Nothing changes the received count until the sponsor accepts.
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
`request_sponsorship_delivery_return` POST `/sponsorship-deliveries/:id/returns` · `decide_sponsorship_delivery_return` PATCH `/sponsorship-delivery-returns/:id` · `issue_sponsorship_vouchers` POST `/sponsorship-obligations/:id/vouchers` · `void_sponsorship_voucher` PATCH `/sponsorship-vouchers/:id` · `redeem_sponsorship_voucher` POST `/sponsorship-vouchers/:id/redeem`. Extended: `dispatch_sponsorship_goods` (evidence, replacement), `decide_sponsorship_delivery` (evidence, reason, version), `get_sponsorship` / `list_sponsorship_obligations` (returns, vouchers, returned/credited/net quantities), `get_sponsorship_summary` (`services_outstanding`).

## Order, rollback, recovery
Deploy order: migration 099, then API, then app (an old app still works: it just does not show returns or vouchers). Rollback: stop using `service` lines and the new endpoints; nothing is dropped, and the widened check and new columns are harmless to old code. Recovery: the position functions are derived from rows, so re-running a decision is safe; a stuck due is re-evaluated by the next decision, and `rebuild_sponsorship_schedule` is unchanged.

## Follow-ups (#389, migration `109_sponsorship_fulfilment_followups.sql`, additive)
* **Disputed returns open a case.** Disputing a return opens a goods dispute in the existing sponsorship dispute system (`sponsorship_disputes.return_id`, one per return) with the return's note, link and files as case evidence. Both sides see the case number and status on the return; quantities change only by an accepted return. The live-dispute index on a delivery now ignores return disputes, so two returns from one delivery can each be disputed (an index was rebuilt; no row changed).
* **Evidence files.** `request_sponsorship_delivery_return` takes up to 3 `files` (PDF, JPEG, PNG, WebP, 5 MB) with `consent: true`; `add_sponsorship_return_files` POST `/sponsorship-delivery-returns/:id/files` adds more to an open or disputed return (10 per return); `get_sponsorship_return_file` GET `.../files/:file_id` returns one file (audit-logged, sponsor and recipient sides only). Files are encrypted (`sponsorship_return_files`), record who and when, and are copied to the return's case. A young person's guardian acts for them.
* **Coaching vouchers** may name one of the redeemer's own confirmed or completed coaching sessions (`hire_id`, from `GET /hires`); one voucher per session. Travel stays a short reference (there is no travel order flow to link); medical still takes no detail and grants no clinical access. The sponsor only learns that a voucher was used.
* **Export.** `export_sponsorship_fulfilment` GET `/sponsorships/:id/fulfilment/export`: CSV of deliveries, returns and vouchers for the sponsor side (export permission) and the recipient. No evidence, notes, references or detail; cells are formula-safe (`csv.js`).
* **Agreement builder.** Service lines are composed in the existing offer builder (#309); no second builder was added.
* **App.** One shared evidence picker and file/CSV helper (`apps/app/src/evidence.js`) gives the same flow on iOS, iPadOS, Android (camera, photo library, files) and web (file chooser). `docs/sponsorship-fulfilment-ui-verification.md` records the live UI run.

## Limits
Evidence can be a https link or an uploaded file. Voucher redemption does not create a booking itself: venue vouchers link a booking and coaching vouchers a coaching session made through the existing flows; travel and medical record the funded use only.
