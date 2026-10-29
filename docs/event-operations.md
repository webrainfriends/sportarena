# Event Operations Centre (#586)

Prepare, run and close an event from the **Operations** tab of the Event console (the single home for running an event; nothing here is a second console).
Capabilities (REST + OpenAPI + MCP, tag **Event operations**) live in `apps/api/src/capabilities/event-ops.js`; migration `125_event_operations.sql` is additive.

## Readiness: derived, never re-entered
`add_standard_event_requirements` adds the standard set (repeat-safe). Each requirement is read **live** from the domain that owns the data: games, seeds and bracket (fixtures),
venue and court bookings, accepted entries, accepted officials, department crew, suppliers/vendors, accreditation badges, capacity, linked team travel, security / medical / media crew,
sponsors, budget lines, finalized insurance, overdue or blocked tasks and unresolved high/critical incidents. A derived requirement cannot be ticked by hand: fix the source, or waive it with a reason.
Manual requirements (`add_event_requirement`) cover what no other part tracks; their owner or the organiser ticks them. Waived and optional ones do not count. `get_event_readiness` returns the percentage, per-area counts and each item's state.
The Overview tab's old client-side "Get the event ready" list was merged into this (same checks, server-side); the Overview shows a readiness card that opens the Operations tab.

## Live board
`get_event_status_board`: games live / next up, open incidents by severity (plus open media and travel incidents, which stay in their own desks), gate check-ins and refusals (accreditation scans), blocked / overdue work, crew, readiness.

## Incidents
`report_event_incident` (any crew: department member or accepted staff; idempotent with `client_key`), `update_event_incident` (acknowledge, assign, escalate with a reason, note, resolve, reopen, close), `list_event_incidents`, `get_event_incident`.
High incidents alert the organiser; critical ones and every escalation also alert department leads. Descriptions and resolutions are encrypted (`*_enc`); reading them is audit-logged (`read_event_incident`); the log is append-only.

## Contacts, debrief, close, report
`add/update/list_event_contacts` (phone and email encrypted; `include_contact=true` is audit-logged). `save_event_debrief`, `add_debrief_item` (an improvement can create its follow-up **in the event task list**), `archive_debrief_item`.
`close_event_operations` needs the event ended, no active incident and a debrief summary; it finalizes the debrief and locks new incidents until `reopen_event_operations`.
`get_event_ops_report` / `export_event_ops_report` (CSV, formula-safe): facts only, no incident descriptions or phone numbers; organiser only; audit-logged.

## Access
Organiser (or org admin) manages everything; department leads manage incidents and contacts; crew read the board, report incidents and see contacts. Anyone else gets 404.

## Data safety and coverage
Nothing is deleted: requirements, contacts and debrief items are archived, incidents are closed. Operations are sport-agnostic, so every sport in the catalogue is covered the same way.
Known limits: tickets/attendance has no ticket-sales source yet (capacity check + manual requirements); procurement is manual; the report is CSV/JSON, not a branded PDF.
