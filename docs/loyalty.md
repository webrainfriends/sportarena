# Loyalty points

Venue-funded rewards. A venue chooses a percentage of what a customer pays that comes back as points, redeemable only at that venue. **1 point = 1 minor unit of the venue's currency**, so points are always worth real money at the venue that issued them and are never mixed across venues or currencies.

## Venue settings (`update_venue`, Manage → Setup → Money)
* `loyalty_earn_bp` — basis points earned on a paid invoice (500 = 5%). `0` switches the programme off (default). Max 5000.
* `loyalty_expiry_months` — points expire this long after they are earned (default 12).
* `loyalty_max_redeem_bp` — the share of one invoice that points may pay (default 5000 = 50%).

## Lifecycle
* **Earn** — when an invoice is marked paid (card, wallet, or at the venue) it earns `floor((total − points paid with) × earn_bp / 10000)`, exactly once per invoice (unique index). Points paid with earn nothing.
* **Spend** — `apply_points_to_invoice` (`POST /invoices/:id/points`) pays an open invoice, or part of it. It takes the lock the wallet uses, so it can't race a card checkout; it is capped by the venue's redemption share. Points are taken **oldest expiry first**. The invoice shows them as credit (`invoice_credits.source = 'points'`); the card is asked only for what is still due.
* **Restore** — if the open invoice is voided or shrinks below the credit on it, the points come back as a fresh lot with a new expiry.
* **Claw back** — when a paid invoice is credited (cancellation or change) the points that money earned are removed, as far as they are still unspent. Points already spent are not chased into the negative.
* **Expire** — the worker (`maintenanceCycle`, reported as `points_expired`) zeroes lots past their expiry and records an `expire` event per person and venue.
* **Bonus** — `grant_loyalty_points` lets the venue team give goodwill points with a written note. Audit-logged; the recipient is notified.

## Reading it
* `get_loyalty` — your points per venue, how many expire within 30 days, next expiry. `loyalty_history` — the full statement. `get_venue` returns `my_points`.
* `venue_loyalty` — the team's view: issued / redeemed / restored / clawed back / expired in a date range and what is outstanding (members, points, money value).

## Data
Additive migration `012_loyalty_points.sql`: `loyalty_lots` (a lot per earn/restore/bonus, with `remaining` and `expires_at`) and `loyalty_events` (append-only statement). Nothing is deleted; expired lots stay at `remaining = 0`.

## Known limits
Points are the venue's own liability but, like wallet money, are not yet netted in any settlement to venues. Points can't be transferred or cashed out.
