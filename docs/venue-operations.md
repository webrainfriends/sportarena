# Venue operations & facility ERP (#585)

One workspace for a venue operator: **Venue console → Operations**, plus **All my venues** for several locations. Everything is a capability
(`apps/api/src/capabilities/venue-facility.js`, with plans, maintenance and staff extended in place), so REST, OpenAPI and MCP share it.

| Need | Where | Capabilities |
| --- | --- | --- |
| Recurring bookings | Operations → Series | `create_booking_series`, `list_booking_series`, `cancel_booking_series` (held through the booking engine, owner holds cost nothing; customers still use `book_recurring_venue`) |
| Memberships and entitlements | Passes, packages & memberships | `create_venue_plan` / `update_venue_plan` `entitlements` (days, daily window, `guest_quota`). Enforced by the access layer when a member checks in; the guest count is stored on the capture. |
| Check-in and access hooks | Doors & attendance → **Confirm check-ins**; Today board → Check in | the existing `smart-access` capabilities and `access-layer.js`; there is no second check-in. See *Booking QR and check-in* below. |
| Equipment inventory | Operations → Assets | `register_venue_asset`, `list_venue_assets`, `update_venue_asset` — stock rows (`inventory_items`), the same list as the front desk |
| Preventive maintenance, work orders | Operations → Preventive, Maintenance tab | `create_pm_template`, `list_pm_templates`, `update_pm_template`; `create_maintenance` / `update_maintenance` now carry asset, assignee, checklist, parts and sign-off. The worker `venue_pm` raises due jobs. |
| Incidents | Operations → Incidents | `report_venue_incident`, `list_venue_incidents`, `get_venue_incident`, `update_venue_incident` (private details encrypted, reads audit-logged) |
| Staff shifts and roles | Operations → Shifts, Settings → team | `create_venue_shift`, `list_venue_shifts`, `clock_venue_shift`, `cancel_venue_shift`; `add_venue_staff` takes `role` (manager / staff) and `duty` |
| Readiness | Operations → Readiness | `venue_readiness_board`, `record_readiness_check` — a native checklist for each area kind (court, ground, pool, track, room, equipment) |
| Income reconciliation | Operations → Income | `venue_income_reconciliation` — read-only over POS, till, invoices and the finance ledger |
| Multi-location dashboard | All my venues | `venue_network` — per venue utilisation and revenue (from `venue_report`), maintenance backlog, incidents, readiness, check-ins, shifts |

## Roles
Managers (owner, manager staff, organisation admin) run everything. Floor staff (`venue_staff.role = 'staff'`) can check readiness, report incidents,
see assets, run their own shifts and update the work orders assigned to them; the server enforces it (`mustWork` / `mustManage` in `booking/engine.js`).
`my_venue_permissions` tells the app what to show.

## Data
Migration `136_venue_facility_erp.sql` is additive: new tables and columns only, nothing dropped or rewritten. Assets, incidents, shifts, templates and series are
never deleted (status / `cancelled_at` instead).

## Booking QR and check-in
- **`get_booking_pass`** (`GET /bookings/:id/pass`): the unique QR of one confirmed booking, for its booker or the venue team (anyone else: 404). The code names the booking and its booker, never rotates (it can be printed or sent), works once, and only from `early_min` before the slot until 30 minutes after it ends. It stops working the moment the booking is cancelled (`token` is null). It is token type `B` in `access-layer.js`.
- **Confirm check-ins**: the venue team (managers and floor staff) scan a booking QR, a pass, a card or a tag under Doors & attendance, through `record_access_capture` at the venue's front-desk door (`get_front_desk_access_point`, created on first use as a manual door). The booker cannot confirm their own code, and a code is only accepted at doors of its own venue.
- **`check_in_booking`** (`POST /bookings/:id/check-in`): the Today-board button. It checks in exactly that booking through the same access layer, with a `guests` count. A walk-in guest booking has no account, so it is marked arrived directly and audit-logged.
- **Guest quota**: `entitlements.guest_quota` is the number of guests a member may bring on one visit; more is denied as `membership_guest_quota` and recorded.
- **Membership door grants**: an active membership gets a credential at each active hardware access point of its venue (`source_type = 'membership'`), issued on payment confirmation and by the `membership_grants` worker job (`syncMembershipGrants`, idempotent). Revocation is the existing sweep when the membership ends. A plan's days and hours are judged by the server when the door event arrives, not inside the controller.

## Income reconciliation
`venue_income_reconciliation` is read-only: front-desk takings and refunds per tender, bookings paid and outstanding, closed cash-drawer shifts with their variance and shifts awaiting a variance review, and online tenders the canonical finance ledger has not recorded (`unposted_online`). Per currency, never summed across currencies. It reads the POS and invoice tables and `fin_transactions`; it does not post anything.
