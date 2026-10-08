# Venue management & reservations

One module for venue owners (set up, price, block, override, report) and customers (search, compare, book, change, cancel).
Everything is a capability (`apps/api/src/capabilities/venues.js`, `venue-admin.js`, `reservations.js`) so it is available over REST,
OpenAPI and MCP, and the app uses nothing else. Engine code: `apps/api/src/booking/`.

## Model

| Concept | Notes |
|---|---|
| **Venue** | Any sport. Address, `latitude`/`longitude` (map links for Google, Apple, OSM + directions are generated), IANA `timezone`, `currency`, public phone/email/website, amenities, booking window (`min_notice_minutes`, `max_advance_days`) and cancellation policy (`cancel_free_hours`, `late_cancel_refund_percent`). |
| **Opening hours** | Weekly intervals in venue local time (split shifts allowed). No intervals = open around the clock. |
| **Area** (`resources`) | Court, table, ground, pool, lane, rink, range, room, studio, equipment pool … Each has its own `capacity` (bookings at once, or units of kit), `max_players` per unit, `slot_minutes` (15–120), `min_slots`/`max_slots` per booking, base `hourly_rate_cents`. |
| **Contacts / staff** | Named contacts are encrypted (`*_enc`) and audit-logged on read; `is_public` shows them to signed-in customers. Staff (added by the owner) can run everything except staff management. |
| **Price rules** | Time band + weekdays + date range, venue-wide or per area. Most specific wins (area, then priority, then newest); otherwise the area's base rate. Priced **slot by slot**, so a booking can straddle peak and off-peak. |
| **Discounts** | Percent or fixed; automatic or behind a promo code; limits by area, weekdays, dates, minimum slots, total uses and uses per customer. The **best single discount per venue** applies (no stacking). Discount is spread over lines pro rata, to the cent. |
| **Reservation** | A basket of lines (`bookings`): any number of slots on any number of areas **and venues** (same currency), all-or-nothing. Short code (e.g. `TBFBBMX`) for the front desk. |
| **Blocks** | Maintenance, holidays, private hire, events: per area or whole venue, over a date range, optional weekdays and daily time band. One bulk request = one `batch_id`, released together. |

## Guarantees

* **No overselling.** Every area touched by a request is locked (`pg_advisory_xact_lock`, sorted order → no deadlocks) before capacity is checked inside one transaction. The legacy `POST /bookings` and fixture bookings use the same lock and respect blocks.
* **Rules checked on every booking:** slot grid, opening hours (in venue time), notice and advance window, min/max slots, players per unit, blocks, live capacity.
* **`quote_reservation` = `create_reservation`.** The quote runs the real booking code and rolls it back, so the numbers cannot drift.
* **Modify** (`modify_booking`): move, switch area within the venue, change quantity/players; re-checked (the booking doesn't compete with itself) and repriced. Customers until the free-cancellation cut-off, staff any time.
* **Cancel** (`cancel_booking` for a line, `cancel_reservation` for all): booker gets the policy refund (full if early, else `late_cancel_refund_percent`); venue-initiated cancellations always refund in full and notify the customer. Remaining lines are repriced (e.g. a "3+ slots" discount drops away when it no longer applies).
* **Override** (`override_booking`): staff can book outside hours/blocks, comp a price, record a walk-in (name/phone encrypted), or `displace_conflicts` (conflicting bookings are cancelled with full refund and notified). A reason is mandatory and the action is audit-logged.
* **Reports** (`venue_report`): revenue (gross, discounts, net, cancellation fees, refunds, paid vs outstanding), bookings, unit-hours, utilisation per area (blocked time excluded from capacity), time series (day/week/month), busiest hours/weekdays, discount performance, customers (new/returning/top), channels.

## Compare and book several venues

`GET /venue-comparison?ids=a,b,c&sport=…&from=…&to=…&lat=…&lng=…` returns each venue side by side (distance, rating, areas, capacity, players, rate range, hours, amenities, policy, automatic offers, which areas are bookable in the window with a price estimate, next free slot) plus highlights (cheapest, nearest, top rated, most available, earliest free). Then `POST /reservations` with lines from one venue, several, or all of them.

## Notifications

In-app inbox (`/notifications`) is instant. Per-user preferences: channels (in-app, email), booking reminder lead time, muted kinds. Triggers: reservation confirmed, new booking (to the venue team), modified, cancelled (either side), displaced by an override, booking reminder, added as staff.

Email is **queued** (`notification_deliveries`) and delivered by POSTing JSON to `NOTIFY_WEBHOOK_URL` (bearer `NOTIFY_WEBHOOK_SECRET`) — bridge it to SES/SendGrid/n8n. Without the URL mail stays queued. The server runs reminders + dispatch every `NOTIFY_INTERVAL_SECONDS` (default 60, `0` disables); admins can trigger a cycle with `POST /admin/notifications/dispatch`. Push notifications need device tokens the app doesn't collect yet, so they aren't offered.

## Known limits

* Payment is **at the venue**: staff record it with `set_booking_payment`; refunds are tracked as `refund_cents` / `refund_due`, not pushed to a card. Online checkout for reservations (the Stripe/PayPal flow used by shop orders) is the natural next step.
* A booking can't cross midnight, and slot grids on a day with a clock change are not adjusted for the missing/extra hour.
* A reservation spans venues only if they share a currency.
