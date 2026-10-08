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

* A booking can't cross midnight, and slot grids on a day with a clock change are not adjusted for the missing/extra hour.

## Photos, videos and reviews on the venue page

* **Upload** (venue team): `PUT /api/v1/venues/:id/media` with the raw file as the body streams it to disk — photos up to 10 MB, videos up to 150 MB (MP4, MOV, WebM; JPEG, PNG, WebP, GIF). The `add_venue_media` capability does the same for files up to 8 MB sent base64-encoded (for agents). `add_venue_video_link` adds a YouTube or Vimeo video by link. A venue holds up to 100 items / 3 GB.
* **Safety:** the file type is decided from the file's bytes (never from the client); SVG and anything else is refused; names are server-generated; media is served with `nosniff`, immutable caching and range support.
* **Storage:** `MEDIA_DIR` (deployed as `/var/lib/sportarena/media`, outside the checkout and web root, so deploys never touch it). Removing a photo hides it; the file and row stay.
* **Gallery order and cover:** `update_venue_media` (caption, cover), `reorder_venue_media`, `remove_venue_media`; `get_venue` returns the media, `list_venues` a `cover_url`.
* **Reviews:** `venue_reviews` gives average, count, 1–5 distribution, a "played here" mark for reviewers with a finished booking, sorting and star filter. Guests review with `write_testimonial` (the venue team can't review its own venue). `reply_to_review` lets the team answer publicly; both directions notify.

## Currencies, tax, invoices and payment

* **Each venue prices in its own currency** (`list_currencies`; amounts are integers in minor units — paise, cents, whole yen). The currency is chosen in the venue settings and locked once the venue has bookings. Rates, discounts, reports and invoices are all in it. A single basket may mix venues of different currencies: you get one invoice per venue in that venue's currency, and totals are shown **per currency** (currencies are never added together; `owner_summary` and compare handle mixed currencies the same way).
* **Tax:** `tax_name`, `tax_rate_bp` (1800 = 18%), `tax_inclusive`. Inclusive venues extract the tax from the listed price; exclusive venues add it at checkout. Quotes, invoices and reports show it.
* **Invoices:** one numbered invoice per venue per reservation (`<PREFIX>-<year>-<6 digits>`, gapless per venue; credit notes `CN-…`), with a snapshot of the seller (legal name, tax id, address) and bill-to details (encrypted; the customer can add a company name/tax id when booking). `reconcileInvoices` runs after every change: it keeps one open invoice for what is still owed and never rewrites a paid one — a longer booking adds a supplementary invoice, a shorter or cancelled one issues a **credit note** (cancellation fees stay on the invoice).
* **Paying:** a venue's `payment_mode` is `pay_at_venue` (staff record it with `mark_invoice_paid`), `online_optional`, or `online_required`. Online payment is Stripe/PayPal hosted checkout (`create_payment` with `purpose_type: venue_invoice`) in the **invoice's currency** (zero-decimal currencies like JPY are sent as whole units). With `online_required` the slots are held for `PAYMENT_HOLD_MINUTES` (default 15) and released, nothing charged, if the invoice is still unpaid; a payment that arrives after release is refunded automatically. Online modes fall back to pay-at-venue while no provider is configured.
* **Refunds:** a credit note for an online payment is refunded through the provider — partial, idempotent per credit note, retried by the worker; cash/at-venue refunds are marked done by staff (`mark_credit_note_refunded`).
* Venue team views: the Payments tab (invoices to collect, record payment, refunds to hand back) and `owner_summary` across all venues grouped by currency.

## Booking experience (app)

* **Discover:** venue cards with cover photo, rating, offers and price-from, filtered by sport, facilities, "available on this day and hour", and sorted by rating, price or distance; compare tray.
* **Venue page:** photo hero with open-now status, Overview / Courts / Reviews tabs, a month calendar showing availability and the cheapest price per day (`venue_calendar`), opening hours with today highlighted, policy and tax, map (OpenStreetMap embed on web), and a pinned **Book now** bar.
* **Booking wizard:** Court(s) → Date (availability calendar) → Time (slots grouped Morning / Afternoon / Evening / Night, multi-select, "slots per tap" for longer sessions, unit counters) → Review → basket checkout. Courts, dates and venues can be combined in one booking.
* **Ticket:** booking code up front, **Add to calendar** (.ics on the web, share sheet on phones), invoices and payment below.
* **Calendar and time pickers everywhere:** admin forms (blocks, overrides, rate rules, discounts, report period) use the same date and time pickers; the schedule has a day picker.
