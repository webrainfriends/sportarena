# Memberships and multi-session passes

Venues sell two kinds of plan (`venue_plans`), priced in the venue's currency and bought through the same hosted checkout as everything else (`create_payment`, `purpose_type: venue_plan`).

## Membership
`kind: membership` — `duration_days` and `discount_bp` (1000 = 10% off). While active, the member's discount is a candidate in `repriceReservation`: it competes with the venue's offers and promo codes and **the best single discount wins** (they don't stack). It applies to bookings made or changed while the membership is active.

* One membership at a time per venue. A renewal is allowed in the last 30 days and **starts when the current one ends**, so no time is lost.
* The terms are copied to `user_plans` at purchase; later edits to the plan never change what someone paid for.

## Pass
`kind: pass` — `sessions`, `valid_days`, `session_value_cents` (default price ÷ sessions). `apply_pass_to_invoice` (`POST /invoices/:id/pass`) pays an open invoice at that venue: it uses as many sessions as the amount needs (`ceil(due / session_value)`, up to what's left), soonest-expiring pass first, each paying up to its value. A booking worth more than one session's value takes several sessions; a pass that can't cover everything pays part and the rest is still due (card or at the venue). Pass credit takes the same invoice lock as the wallet and points, so it cannot race a card checkout.

* Sessions come back when the invoice is voided or shrinks, and when a paid invoice is refunded — sessions are returned instead of money (nothing goes to the card for the pass-funded part). A returned session on an expired pass gives a week of grace.
* Pass-paid amounts earn **no loyalty points**.
* `used_up` passes revive if sessions come back before they expire.

## Lifecycle and reading
`awaiting_payment → active → used_up | expired`, or `cancelled` (only an unpaid purchase can be dropped: `cancel_unpaid_plan`). The worker expires plans (`plans_expired`). `my_plans` lists what you hold; `get_venue` returns the venue's `plans` plus `my_member_discount_bp`, `my_membership_until`, `my_pass_sessions`; `venue_plan_report` shows sold / active / sessions outstanding / revenue per plan.

## Data
Additive migration `013_memberships_passes.sql`: `venue_plans`, `user_plans`, `invoice_credits.user_plan_id/units` (`source` now allows `pass`), `venue_plan` payment purpose. Nothing is deleted; plans are switched off (`active=false`), never removed.

## Known limits
* No self-service refund of a paid plan, and no auto-renewal; ask the venue (support adjustments can be done by admins).
* The member discount is applied when the booking is priced, so a basket preview before booking shows list prices.
* Plan money is collected by the platform like other online payments — **settlement to venues isn't built**.
