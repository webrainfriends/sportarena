# Venue operations & facility ERP (#585)

One workspace for a venue operator: **Venue console → Operations**, plus **All my venues** for several locations. Everything is a capability
(`apps/api/src/capabilities/venue-facility.js`, with plans, maintenance and staff extended in place), so REST, OpenAPI and MCP share it.

| Need | Where | Capabilities |
| --- | --- | --- |
| Recurring bookings | Operations → Series | `create_booking_series`, `list_booking_series`, `cancel_booking_series` (held through the booking engine, owner holds cost nothing; customers still use `book_recurring_venue`) |
| Memberships and entitlements | Passes, packages & memberships | `create_venue_plan` / `update_venue_plan` `entitlements` (days, daily window). Enforced by the access layer when a member checks in. |
| Check-in and access hooks | Doors & attendance (unchanged) | the existing `smart-access` capabilities and `access-layer.js`; there is no second check-in |
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
