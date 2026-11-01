# Ticketing completion: promo codes, waitlist, resale policy, add-ons, reporting (#699)

Extends spectator ticketing (#480, `134_spectator_ticketing.sql`) and the venue seating map (`135_venue_seating.sql`). There is still **one** shop, **one** order, **one** payment (`purpose_type: ticket_order`), **one** ticket lifecycle and **one** report. Migration: `137_ticketing_completion.sql` (additive; two CHECK constraints widened to a superset; no row changes meaning).

## Reuse map

| Need | Reused | Added |
|---|---|---|
| Promo codes | `discounts` + `discount_redemptions` (venue and academy codes already live there) | `discounts.event_id`, `max_discount_minor`, `stackable`, `product_ids`; `discount_redemptions.ticket_order_id`, `reversed_at`; per-ticket `tickets.discount_minor` |
| Waitlist | the offer-and-expire idea of the booking waitlist, `lockEvent`, the sweep in `sweepTickets` | `ticket_waitlist`; an offer **is** a held order, so the normal capacity check counts it |
| Resale policy | `ticket_settings`, `transfer_ticket`, `transferRule`, the audit log | `resale_mode / cap / fee`, append-only `ticket_policy_history`, `ticket_resales` |
| Parking and merchandise | the order, the payment, the QR token format, the gate screen, the refund path | `ticket_addons`, `ticket_addon_items` (own stock, collected state) |
| Reporting | `ticket_report` | a `commerce` section: channels, promos, add-ons, waitlist, reconciliation |

Not duplicated: no second discount engine, no second waitlist engine, no second console. The organiser screens are sub-tabs of the event console's Tickets tab (Promo codes, Add-ons, Waitlist; resale rules join the existing Rules tab; the report joins the Overview).

## Rules (all server-side, in `src/ticketing.js`, `src/ticketing-commerce.js`)

* **Oversell.** Everything that sells, holds, refunds or promotes serialises on the per-event advisory lock. Releasing an order, refunding or voiding a ticket, raising capacity or reopening sales promotes the waitlist inside the same transaction. Lock order is always event first, then order (release and cancel were changed to match confirm, so they cannot deadlock with a payment confirming).
* **Promo codes.** Percent or fixed; optional cap per order; date window; total and per-account limits (counted under the lock); product scope; `stackable` or exclusive. Percentages come off first, then fixed amounts; never more than the eligible price. Unknown, switched-off, out-of-window and non-applicable codes all answer the same way, so codes cannot be probed. The discount is shared exactly across tickets (largest remainder) and stored per ticket. Add-ons are never discounted.
* **Totals.** `total = tickets - promos + add-ons` and is what `POST /payments` charges. `quote_ticket_order` runs the same function and rolls it back, so the price shown is the price charged.
* **Refunds.** A ticket refunds `price - discount`; an add-on refunds its price; both through the original payment, idempotent per item. Refunding every item returns exactly the payment. An event cancellation refunds add-ons too.
* **Waitlist.** FIFO per ticket; the first whose party fits is offered a held order for `waitlist_offer_minutes`; an unpaid offer lapses and the next is offered. Refused while tickets are available, for a young person, and when the waitlist is switched off.
* **Resale.** `transfer_only` (default) or `resale`: a priced hand-over to a **named account**, at most `resale_cap_bp` of the price actually paid (never above 100%), recorded in `ticket_resales` with the organiser fee. A young person can neither sell nor be sold to for money; a guardian can still transfer a ticket for free. Every change to a policy field is appended to `ticket_policy_history` and the audit log.
* **Add-ons.** Own stock (held while an order is unpaid), per-order limit, signed QR token (`GT1.ADD-…`, no personal data), collected exactly once (one atomic update; the operator and time are audit-logged).

## Capabilities (REST + OpenAPI + MCP)

Promos: `create_ticket_promo`, `list_ticket_promos`, `update_ticket_promo`. Add-ons: `create_ticket_addon`, `list_ticket_addons`, `update_ticket_addon`, `list_my_ticket_addons`, `collect_ticket_addon`, `refund_ticket_addon`. Waitlist: `join_ticket_waitlist`, `list_my_ticket_waitlist`, `leave_ticket_waitlist`, `accept_ticket_waitlist_offer`, `list_ticket_waitlist`. Policy: `list_ticket_policy_history`, plus new fields on `update_ticket_settings` and `transfer_ticket`. Orders: `create_ticket_order` and the new `quote_ticket_order` take `promo_codes` and `addons`. `ticket_report` gains `commerce`.

## Known limits

* A priced resale records the agreed price and the organiser's fee; the platform does not move the money between the two people (there is no peer payout rail). The fee owed is reported to the organiser.
* The report's reconciliation compares order totals with `ticket_order` payments; box-office orders settled outside the platform show as a difference. An event selling in several currencies reports `mixed_currencies`.
* Gate scanning of add-ons needs a connection (stock and collected state live on the server); ticket scanning keeps its offline mode.
