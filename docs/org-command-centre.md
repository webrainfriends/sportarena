# Organisation Command Centre

One operational home for a club, academy, school, university or sports organisation (#573). It is the **Command centre** tab of the organisation screen (the old Overview), not a separate console. It composes records that already exist and keeps no copy of any module's data.

## What an owner or admin sees

* **Waiting on you** — every pending decision, oldest first, with a dropdown filter (Everything, Admissions, Registrations, Staff, Compliance, Procurement, Sponsors, Tasks). Each row has one action button; a second option (Waitlist, Reject…) opens a sheet, and where a reason or note is required the sheet asks for it. Tapping the row opens the record.
* **Across the organisation** — one line per area (teams, athletes, coaches & staff, registrations, competitions & events, venues, finance, sponsors, suppliers & procurement, compliance, documents, open tasks) with a status dot, a plain summary and a count. Areas that need attention come first; a tap opens the tab that owns the data. Money is shown per currency and never added across currencies.
* **Manage** (owner/admin) — season rollover, save the structure as a template, apply a template.

Finance sees money, sponsor payments and procurement only. A coach sees their own groups, teams and tasks. Sponsor-side roles keep their own tab. Outsiders get a 404.

## Capabilities (REST + OpenAPI + MCP)

| Capability | Path | Notes |
|---|---|---|
| `get_org_command_centre` | `GET /organisations/:id/command-centre` | tiles, alerts, how many decisions wait; audit-logged |
| `list_org_approvals` | `GET /organisations/:id/command-centre/approvals` | the decision queue; each action is `{cap, method, path, body, ask?}` |
| `list_org_open_tasks` | `GET /organisations/:id/command-centre/tasks` | team boards, event plans, sponsor deals |
| `rollover_org_season` | `POST /organisations/:id/seasons/:season_id/rollover` | `dry_run` previews; groups are copied once per season |
| `save_org_template` / `list_org_templates` / `apply_org_template` / `archive_org_template` | `/organisations/:id/templates…` | structure only |

### Approvals reuse the domain capabilities

The queue never decides anything itself. Each item carries the existing capability that resolves it, so the app and MCP agents call the same handler, with its own role check, separation of duties, stale-version check (409) and audit:

| Area | Source | Action capability |
|---|---|---|
| Admissions | `academy_applications` submitted / under review | `decide_academy_application` |
| Registrations | `reg_registrations` (organiser side), `event_entries` pending | `review_registration`, `decide_entry` |
| Staff | pending time off, submitted timesheets (never your own) | `decide_academy_time_off`, `decide_academy_timesheet` |
| Compliance | submitted agreements (owner only), accreditations | `decide_org_agreement`, `decide_accreditation` |
| Sponsors | payments reported by a sponsor | `decide_sponsorship_payment` |
| Procurement | supplier approvals, tender approvals (not your own requests) | `decide_service_approval`, `decide_approval` |
| Tasks | overdue team, event and sponsor tasks | open the record; update with the existing task capabilities |

Items a role may see but not decide (for example an entering club's own registration, or finance on a supplier approval) have no actions and are marked view only.

`decide_entry` now honours the organisation grant (owner/admin of the organising organisation), as every other event-organiser capability already did.

## Season rollover and templates

* Rollover copies the **structure** of a season: group names, capacities, programme links, and (when left on) coaches who are still active staff and team links that still belong to the organisation. Enrolments, attendance and charges stay with the old season. A dropped coach or team is reported per group. Nothing is deleted; the old season can optionally be archived.
* A group can be rolled into a season only once (`rolled_from_id` + unique index), and a season name is unique per organisation, so repeating the call cannot duplicate anything.
* Templates hold department names and group names/capacities only: no people, money or personal data. They are visible to people who own or administer the organisation they were saved from, and can be applied to any organisation they own or administer. Applying adds what is missing and never changes existing records.

## Data and migration

`124_org_command_centre.sql` is additive: `org_templates`, `rolled_from_id` on seasons and cohorts, and a cohort name that is unique per season instead of across the organisation (a relaxed rule; every existing row still satisfies it). Nothing is dropped or rewritten.

## Platforms

One React Native screen (`apps/app/src/screens/org-command-centre.js`) with a shared dropdown field (`menu-field.js`): one column on phones, two on tablets and desktop, 44pt+ targets, accessible labels, sheets instead of web-only popovers. Verified with `expo export` for web, iOS and Android, and the web build driven at phone, tablet and desktop widths against a real API. Not run on a physical iOS, iPadOS or Android device.
