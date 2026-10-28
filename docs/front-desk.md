# Sports Front Desk & POS (#512)

One front desk for venues, academies and clubs: a walk-in court, a racket rental, a tube of shuttlecocks, a drink, a membership renewal and a payment — one cart,
one receipt — while **every downstream record stays canonical**. The desk *orchestrates*; it owns no revenue. Everything is a capability
(`apps/api/src/capabilities/front-desk.js`, `front-desk-ops.js`; engine in `apps/api/src/pos/`) so REST, OpenAPI and MCP behave identically, and the app
(`apps/app/src/screens/front-desk*.js`, tab **Front desk** in the venue console) calls nothing else.

## Reuse matrix — POS need → canonical source → existing capability → verified gap → extension

| POS need | Canonical source (reused) | Existing capability | Verified gap | Extension (smallest) |
|---|---|---|---|---|
| Walk-in court / resource time | `reservations` + `bookings`, booking engine (`createReservation`, price rules, offers, member rates, blocks, locks) | `override_booking`, `create_reservation`, `quote_reservation` | Staff had no way to put court time, goods and payment in **one** workflow | `create_pos_sale` calls `createReservation` (staff, `source: admin`); refunds/voids go through `cancelBookings`. No second booking path |
| Merchandise, F&B | `inventory_items` (the venue's own stock, also shown in Supply chain) | `create_inventory_item`, `list_inventory`, `adjust_stock` (owner only, no sale terms, no ledger) | Stock had no selling price, no venue-manager access, no ledger | **Extended in place, no parallel stock capability**: additive columns (`sellable`, `sell_price_cents`, …), the same capabilities now accept the terms and a `venue_id` for venue managers, and write the append-only `pos_stock_moves` ledger; new `update_inventory_item`, `list_stock_history`. `shop_products` (supplier marketplace, buyer = account) is deliberately **not** reused: it has no venue stock, no walk-in buyer |
| Equipment rental | `inventory_items` (`stock_kind = rental`) | none | No issue / return / damage / loss / deposit | `pos_rentals` (one row per unit), deposit held / refunded / forfeited; rental stock moves are `rental_out` / `rental_back`, never "sold" |
| Invoice, tax, numbering | `invoices` (gapless per venue, immutable, credit notes) | `reconcileInvoices`, `markInvoicePaid`, `list/get_invoice` | Invoices had 3 sources; no retail source | A 4th source `pos_sale_id` (same pattern academy and suppliers used). Same numbering (`nextNumber`), same seller snapshot, same tax fields |
| Payment: cash / manual | `invoices.payment_method` | `mark_invoice_paid` | No drawer, no split tender, no reference | `pos_sale_payments` (manual tenders carry their reference; manual methods are enabled per venue). `mark_invoice_paid` is refused on a desk invoice so the drawer cannot disagree |
| Payment: online | `payments` (Stripe/PayPal), `settle`, webhooks, refunds | `create_payment`, `confirm_payment` | No payer = staff; no sale purpose | Purpose `pos_sale` in `describePurpose` / `fulfil`; only the provider's confirmation settles it |
| Memberships / passes | `venue_plans`, `user_plans`, `activateUserPlan` | `buy_plan` | Logic was inline in one capability | Extracted `startUserPlan` (used by `buy_plan` **and** the desk) |
| Collect an existing fee | open venue `invoices`; `academy_charges` + `fulfilChargePaid` | `mark_invoice_paid`, `record_academy_payment` | Two places, no shared till | `invoice` / `academy_charge` cart lines settle those canonical records |
| Discounts / promos | venue `discounts` + member rate (booking engine); loyalty engine (#509) | offers, `redeem_points` | Cart-level discount with approval | Offer codes → booking engine as before; cart discount on goods with a cashier limit and one-time manager approval. Points earned on paid desk invoices (identified customers) and restored/clawed back on refunds through the existing engine; a customer can pay a desk invoice with points/wallet/pass through the existing invoice flows |
| Refunds / returns | credit notes (`parent_id`), `refund_intents`, `processRefunds` | `cancel_booking`, `mark_credit_note_refunded` | No goods returns, no cash-out on a shift | `refund_pos_sale` issues a linked credit note (invoice untouched), returns credit to wallet/points/pass, refunds the original provider payment idempotently or pays cash from the drawer |
| Shifts / cash drawer | none | none | Entire capability | `pos_shifts` (immutable once closed — DB trigger), `pos_cash_moves`, variance review |
| Receipts | invoice documents, `notify`, WhatsApp link | `get_invoice` | One receipt for a mixed cart | `get_pos_receipt` / `send_pos_receipt` |
| Reporting | invoices, payments, stock, shifts | `venue_report` (bookings only) | Retail / rental / cash view that reconciles | `pos_report` reads lines of paid sales and **proves them against the invoices, payments and applied credit**; no separate till total |

## What a sale is

```
pos_sales ──< pos_sale_lines (item · rental · deposit · plan · booking · invoice · academy_charge)
   │  └──< pos_sale_invoices ──> invoices (goods · booking · collected)       numbered, immutable, credit notes link back
   ├──< pos_sale_payments  (cash · card_terminal · upi_manual · bank_manual · other_manual · online → payments)
   └──< pos_rentals        (reserved → issued → returned | damaged | lost)
```

* **Status is derived from the records it points at**: a sale is `paid` only when every invoice / academy charge it holds is paid
  (`pos/due.js: finishIfSettled`), whichever way that happened (desk tender, provider confirmation, or the customer paying the invoice with points). The same
  invoice cannot be paid twice: online checkout, `mark_invoice_paid`, `record_academy_payment` and credit (points / wallet / pass) are refused for a record that is
  inside an unpaid sale that already has money on it.
* **Stock** is drawn down with a row lock inside the sale's transaction, so two tills can never sell the same last unit; every change is a ledger row.
  A void, return or cancelled rental puts it back. Nothing is oversold, and a refused sale leaves nothing behind.
* **Online payments stay pending until the provider confirms** — staff cannot record one (the API refuses `method: online`), cannot mark one paid, and a
  payment that arrives after the sale was voided or already covered is refunded automatically. An abandoned online sale is released by the worker.
* **Manual tenders are labelled as such** on the sale, the receipt and the report ("recorded by hand"), and non-cash ones need the terminal / UPI / bank reference.
* **Idempotent**: the device sends a `client_ref`; sending the same sale again (or uploading it after being offline) returns the same sale.

## Roles and approvals (server-enforced, REST = OpenAPI = MCP)

A **cashier** is added with `add_pos_cashier` and works the desk *and nothing else*: cashiers are deliberately not rows of `venue_staff` (every other venue guard —
bookings, pricing, reports, tenders, insurance, events — treats a `venue_staff` row as a full team member). Managers (owner, platform admin, `venue_staff`,
organisation owner/admin) run the desk with full authority.

| | Cashier | Manager |
|---|---|---|
| Sell, take payment, issue/return rentals, open/close the drawer, drawer movements | yes, within limits | yes |
| Court time for a walk-in | in the running slot, under every booking rule except the notice period; not past the booking window, not into a closed or blocked slot, not a slot offered to someone on the waitlist | the venue's override powers (as `override_booking`) |
| Discount | up to the venue's cashier limit (default 10 %), else approval | any, with a reason |
| Refund / paid-out | only with a manager approval unless the venue sets a limit | yes |
| Void someone else's unpaid sale | approval | yes |
| See what stock costs the venue | no (`unit_cost_cents` is removed from their catalogue) | yes |
| Add to the float, review a variance, desk rules, stock & prices, report, approvals, cashiers | no (403) | yes |

Anyone else gets **404** for the venue (existence is not leaked). A manager approval is a one-time, short-lived 6-digit code for a venue, a kind and a maximum
amount; five wrong codes lock the person out for 15 minutes. Every discount, refund, paid-out, close, review, price change and guest-detail read is audit-logged.
Guest name and phone are encrypted (`pos_sales.guest_*_enc`) and only returned by `get_pos_sale` (audit-logged), never echoed on every response; money-moving
capabilities require the `payment` token scope.

## Cash shifts

`open (float) → sales / refunds → paid-outs · drops · float top-ups (reason mandatory) → close on a count → variance review`.
Expected cash = float + cash received − cash refunded − paid-outs − drops + float top-ups, recomputed from the sale payments, so it cannot drift. A close takes the
shift row exclusively while tenders take it shared, so every accepted cash tender is in the count. Closing freezes expected / counted / variance (a database trigger
refuses edits and deletes); a variance beyond the venue's tolerance needs a manager's accept / dispute, which is itself final.

## Offline

The server accepts cash/manual sales that carry `captured_offline_at` when the venue allows offline cash; the app never offers online payment while offline and
queues a cash sale in its in-memory outbox (same `client_ref`, so it can't be recorded twice). **The queue is not persisted to disk** (by design, like the coaching
outbox): the app must stay open until it uploads.

## Tax and GST

Receipts and invoices carry the venue's configured tax name, rate, inclusive/exclusive mode and tax ID, rounded the same way as booking invoices.
**India GST fields (HSN/SAC, CGST/SGST/IGST split, place of supply) depend on #503 (shared GST billing) and Razorpay/UPI collection depends on #498 — neither
is merged**, so the desk does not claim them. The desk reads the shared invoice fields, so when #503 extends the canonical invoice they appear on desk invoices
without desk code. UPI is supported today as a *hand-recorded* tender with its reference (or through whichever provider is enabled), never as an automatic success.
Retained rental deposits are recorded as forfeited; their tax treatment is for the venue's accountant and the #503 profile.

## Platforms

One Expo / React Native codebase (iOS, iPadOS, Android, web): the till shows the catalogue and the cart side by side from tablet width and stacks them on a phone;
all controls use the shared 44 pt controls, calendar / time pickers, search-and-pick customer, chips, steppers, money fields. Sharing a receipt uses the native
share sheet, or the web share / clipboard. Payment QR reuses the shared QR component.

## Every sport

The desk is sport-agnostic: court time is any bookable area (court, pitch, pool lane, rink, range, table…), stock and rentals are items, plans are venue plans.
No scoring, rules or athlete data is touched, so no sport uses a fallback and none is a gap.

## Known limits (honest)

* Razorpay / UPI-collect, GST fields, AutoPay: blocked on #498 / #503 (see above).
* A retained rental deposit is not yet re-classified as income by a tax rule; refunds of **plans** and **rental fees** are not done at the desk (cancel the plan / refund through the existing flows).
* The offline cash queue is in memory only.
* Verified on web at phone, tablet and desktop widths; not run on a physical iOS / Android device from this environment.
