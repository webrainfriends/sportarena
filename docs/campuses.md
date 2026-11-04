# Multi-campus & academy hierarchy (issue #781)

An academy group can run many regions, campuses, branches and sport departments. This module adds one tree and one transfer workflow on top of the
existing organisation, team, venue, programme and staff records. **It points at them; it never copies them.** Everything is a capability
(`apps/api/src/capabilities/org-campuses.js`, `org-campus-transfers.js`), so REST, OpenAPI and MCP share one definition. Rules: `apps/api/src/campuses.js`,
`apps/api/src/campus-transfers.js`.

## Model
```
academy group (an organisation; child academies keep using organisations.parent_organisation_id)
  └ region / country ─ campus / branch ─ sport department          org_units  (one tree, immutable ids, valid_from / valid_to)
        └ venues, teams, cohorts, programmes, athletes (enrolments), coaches/staff, suppliers, child academies
                                                                    org_unit_links (effective-dated pointers; the objects stay where they are)
```
* Roles: `director`, `sports_lead`, `coach`, `operations`, `finance`, `auditor` per unit (`org_unit_roles`), optionally inherited by the units below. They
  add to an active organisation membership and are read live on every request.
* Policies: nine typed settings (currency, time zone, attendance minimum, athletes per coach, refund window, late-fee grace, guardian consent renewal,
  youth pick-up check, report cadence) set on a unit, inherited down the tree, overridden below (`org_unit_policies`; the nearest wins and each value
  says where it comes from).
* An athlete sits where their own link says, else their cohort's, else their programme's. Fees, attendance and counts follow that pointer, so a
  region is the sum of its campuses and nothing is counted twice.

## Who sees what
Owners and admins run the whole tree. A director runs their own subtree. Sports leads, coaches, operations, finance and auditors see their branch only;
units above it appear as names (context) with no figures; any other unit returns **404** (existence is not leaked). Finance sees fees, auditors see the
audit trail, and athlete / coach names are hidden from finance and auditor scopes. A plain member with no branch role has no campus view.

## Transfers are a workflow, not a form
Moving something that is already placed is a **transfer request** that runs the academy's own process (`org_transfer_flows`, one per kind of object,
versioned): stages of approvals (current campus director, receiving campus director, sports lead, finance, admin), handover checklists, and an
acknowledgement from the athlete (a minor's verified guardian answers) or the staff member; a notice period; optional back-dating. Steps in a stage run
together; the next stage opens when the one before is complete. The people who must act are notified as their stage opens; an owner or admin may
override a step with a recorded reason; a rejection, declined acknowledgement or cancellation moves nothing. When everything required is done and the
effective date has come (a worker sweep applies scheduled ones) the pointer moves: the old link ends, the new one starts. **Ids, history, sessions,
charges, agreements and staff engagements are untouched.** `request_org_transfer` has a `dry_run` that shows the process, who decides each step, due
dates, warnings and what stays attached. Placing objects that are not on any campus yet stays a simple owner/admin action (`move_org_unit_objects`).

## Existing single-campus academies
Nothing changes until the academy opts in. `adopt_single_campus` (with `dry_run`) creates one default campus and points every active venue, team,
cohort, programme, supplier and staff member at it in one change set, changing no record; `rollback_org_unit_change` restores the previous state exactly.

## Branches are campuses (what was merged)
`main` already had **academy branches** (a flat grouping of programmes and venues for the P&L). Running two structures would duplicate the feature,
so a branch is a campus: migration `154_campus_hierarchy_branches.sql` turns every existing branch (archived ones too) into a campus and points its
venues and programmes at it, makes the branch manager the campus director and records the move in the change log; branch rows are untouched. From then
on the two are kept in step: the branch endpoints (`create/list/update/archive_academy_branch`, `set_academy_programme_branch`) keep their contracts and
also maintain the campus, a campus created or renamed in the campus screens has its branch, and placing or transferring a programme sets
`academy_programmes.branch_id`, so the branch P&L and the executive home read exactly what they read before. Nothing is dropped, narrowed or deleted.

## Capabilities (REST + OpenAPI + MCP, tag `Campuses`)
Overview and structure: `get_campus_overview` (filters, `as_of`), `get_org_unit`, `create_org_unit`, `update_org_unit`, `adopt_single_campus`.
Placement and history: `move_org_unit_objects`, `list_org_unit_changes`, `rollback_org_unit_change`, `list_org_unit_candidates`.
Branch roles and policies: `grant_org_unit_role`, `end_org_unit_role`, `set_org_unit_policy`, `clear_org_unit_policy`, `list_org_unit_audit`.
Transfers: `list_org_transfer_flows`, `save_org_transfer_flow`, `list_org_transfer_destinations`, `request_org_transfer`, `list_org_transfers`,
`get_org_transfer`, `decide_org_transfer_step`, `cancel_org_transfer`, `list_my_transfer_acknowledgements`, `respond_to_transfer_acknowledgement`.

## Data, validation, rollback
Migration `154_campus_hierarchy.sql` (additive; no `DROP`, no cascade) and `154_campus_hierarchy_branches.sql` (idempotent backfill). Invalid parents (a
department outside a campus, a cycle), duplicate codes, objects outside the group, a suspended or archived destination, back-dating before a link began,
and a notice period not met return `400` / `409`; mutations take an `idempotency_key` or `row_version`. Rollback: `rollback_org_unit_change` undoes a
set-up, placement or transfer exactly (refused while a later change sits on top). Units are archived, never deleted.

## Limits
Real-device iOS, iPadOS and Android runs were not possible in this environment; the web build was exercised at phone, tablet and desktop widths in light
and dark, and the Expo iOS and Android bundles are exported as a compile check. The text is machine-translated into the 11 packs and marked unreviewed.
