# Timetable, price categories and the owner's setup

Built around how a venue owner thinks: *"My six courts are open 6–22 on weekdays and 8–20 at weekends; before 5pm is Off-peak, after is Peak, weekends are Peak; the cricket net costs more."*

## Price categories
`create_price_category` — a name, colour and a default hourly rate in the venue currency. `set_category_rate` gives one court its own rate inside a category. `update_price_category` re-rates or retires it. Changing a rate re-prices every slot using it from then on; existing bookings keep what they were charged. Names are unique per venue. Categories are retired (`active=false`), never deleted.

## The timetable (`schedule_windows`)
A window = court + weekdays + time range + category (or the court's base rate) + optional season dates. A court is bookable only inside its windows once the venue has turned the timetable on.

* `apply_timetable` — the bulk action: choose courts (`resource_ids` or `all_courts`), days, a time range and a category. `replace` (default) carves whatever was there in the same date scope; `replace=false` refuses to overlap; `closed=true` clears the range. Everything runs under one lock per venue, in one transaction.
* **Seasons**: `valid_from`/`valid_to` make a window that wins over the everyday window on those dates (prices and category). Opening times are the union of everyday and seasonal windows.
* `copy_timetable` copies one court's windows onto others. `bulk_add_resources` adds "Court 1 … Court N" at once; with a timetable on, new courts inherit a sibling's timetable (same type first) so they are bookable immediately. `bulk_update_resources` changes slot length, min/max slots, capacity, base rate or retires many courts.
* The first `apply_timetable` turns the timetable on. A venue that already had opening hours keeps them as windows on every court (nothing closes by surprise); one with none starts empty. Venue opening hours then follow the timetable (union of windows) so the venue page stays right. A venue that never uses the timetable behaves exactly as before.

## Which price applies (most specific first)
1. an explicit **special rate** (`create_price_rule`: holidays, one-off events, per-court promos),
2. the **timetable category** (dated season over everyday, then the court's own rate in the category, then the category default),
3. the court's **base rate**.
Discounts, member discounts and promo codes apply on top, as before.

## Launch checklist
`venue_setup_status` tells the owner what is left: courts, timetable (flags courts with no slots), pricing, invoice details, contact, photos, and optionally memberships. The console shows it at the top until the required steps are done.

## Data
Additive migration `014_timetable_categories.sql`: `price_categories`, `category_rates`, `schedule_windows` (soft-removed with `removed_at`), `venues.timetable_enabled`. Nothing is deleted.

## Forms and controls (venue console)
`FormSheet` picks the control that fits the answer instead of text boxes: steppers for counts and percentages, money fields typed in whole currency units (sent as minor units), switches for yes/no, chips for a few exclusive options, multi-select chips (facilities), weekday chips with Weekdays / Weekend / Every day shortcuts, date and time pickers, a sport picker (quick picks + search), currency and time-zone pickers, and a "use my location" button for the map position. Fields can show or hide based on other answers. Every court is created with a **sport**; the console flags courts without one and the launch checklist counts them (`bulk_update_resources` can set a sport on many courts at once). The timetable's bulk sheet has "All <sport>" shortcuts to select every court of a sport.
