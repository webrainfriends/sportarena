# Organisation workspaces

Clubs, academies and schools get a workspace where staff hold scoped roles and run cohorts, seasons, teams, events and venues. Everything is a capability (`apps/api/src/capabilities/organisations.js`), so REST, OpenAPI and MCP share one definition. Organisations **delegate to** existing identities, teams, events and venues; nothing is duplicated.

## Who can do what

| | owner | admin | coach | finance |
|---|:-:|:-:|:-:|:-:|
| Edit organisation, invite/change/remove staff | ✅ | ✅ (not owners) | – | – |
| Invite or change owners, transfer ownership, archive/restore | ✅ | – | – | – |
| Link/unlink teams, events, venues | ✅ | ✅ | – | – |
| Manage linked teams | ✅ | ✅ | ✅ | – |
| Manage linked events and venues | ✅ | ✅ | – | – |
| Create seasons and cohorts | ✅ | ✅ | – | – |
| Enrol people, mark attendance | ✅ | ✅ | own cohorts only | – |
| Team money (payouts) of linked teams | ✅ | ✅ | – | ✅ |
| Dashboard | people, structure, money | people, structure | own cohorts | money only |
| CSV export | staff, enrolments, attendance, finance | staff, enrolments, attendance | – | finance |

The sponsor roles (manager, evaluator, legal, approver, auditor) and their permissions are in the next section.

Org roles are separate from the global `users.roles`. Membership is read live on every request, so removing someone ends their access immediately. Organisation staff never get clinical data: it stays behind the athlete's own `medical_grants` consent. Exports contain handles and display names only, never email, phone or other encrypted fields, and each export is audit-logged.

## Corporate sponsor workspace

A sponsor brand (`sponsors`) can be linked to an organisation (`sponsors.organisation_id`) with `link_org_asset` (`kind: sponsor`; the caller must own the brand and be owner/admin of the organisation; the Teams, events, venues & brands tab and `unlink_org_asset` reverse it). Its staff then work the brand's deals through the same membership table, with these roles. The brand **owner is always a manager**, so an individual sponsor with no organisation works exactly as before.

| Sponsor action | owner / admin | manager | evaluator | finance | legal | approver | auditor |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Read deals, dues, summary, history | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Propose an offer, withdraw an unanswered one, end a deal | ✅ | ✅ | – | – | – | ✅ | – |
| Revise terms (a new version the recipient must accept) | ✅ | ✅ | – | – | ✅ | ✅ | – |
| Report a payment, dispatch goods (**payment-scope** for API tokens) | ✅ | ✅ | – | ✅ | – | – | – |
| Objectives, reviews, endorsement checks | ✅ | ✅ | ✅ | – | – | – | – |
| Read an athlete's shared results (athlete's consent still applies) | ✅ | ✅ | ✅ | – | – | – | ✅ |
| CSV export `sponsor_deals`, `sponsor_obligations` | ✅ | ✅ | – | ✅ | – | – | ✅ |
| Read brand contacts (audited as `read_pii`) | ✅ | ✅ | – | – | – | – | – |
| Invite, change, revoke staff; departments; transfer ownership | owner/admin only (existing organisation rules) |

Evaluators can never report payments or put the brand's name to terms. "Sign" here means the sponsor-side commitments that exist in the product: proposing, revising and ending an agreement; there is no separate e-signature step (see #295). Sponsor roles give no access to cohorts, rosters, admissions or any non-sponsor export, and the organisation dashboard shows them nothing but the organisation's name.

* **Revocation** is immediate: `remove_org_member` sets `status='left'`; the next read, write or export by that person is refused (403 on the deal, 404 on the organisation). Payments, reviews and history they created stay. Re-inviting restores access under the new role.
* **Departments** (`create_org_department`, `list_org_departments`, `archive_org_department`) are generic to the organisation. A member invited with a `department_id` only sees, proposes and exports deals of that department (`sponsorships.department_id`); no department means all departments and brand-wide deals. Archiving a department keeps its deals and people.
* **Stale changes**: `set_org_member_role` takes `expected_role`; if the role changed meanwhile it returns 409 and the app reloads. Role/revoke operations serialise on the organisation row.
* **Archived organisation**: its staff keep read access to the brand but writes return 409; the brand owner is unaffected.
* **Notifications** about a deal (payment decisions, delivery, endorsement, performance sharing, answers to offers) go to the owner and to the staff whose role concerns that action, never to evaluators for payments. Bodies carry no amounts.
* **Ownership transfer**: the organisation is handed over with `transfer_org_ownership`. The brand's `owner_id` stays the original creator (an implicit manager); a brand with an organisation is run by the organisation's owners/admins/managers. Moving `owner_id` itself is not offered.
* **Migration `087_sponsor_workspace.sql`** is additive: nullable `sponsors.organisation_id`, nullable `organisation_members.department_id` and `sponsorships.department_id`, the new `org_departments` table, and a widened (never narrowed) role and kind CHECK (`manager, evaluator, legal, approver, auditor`; `company`). Existing agreements, payments and history are untouched. Rollback: deploy the previous API build, which ignores the new columns; staff holding a new role would simply have no meaning to it. Nothing is dropped.
* **Dependency order**: this slice needs organisations (022) and sponsorship agreements (042/075). #282 (brand identity), #288 (committee scoring, builds on the evaluator role), #293 (department budgets), #295 (signatures), #305 (portfolio exports) and #306 (collaboration) extend it.
* **Limitations**: other modules that look at `sponsors.owner_id` (insurance, event planning, event vendors, education enquiries, sponsor verification) remain owner-only. An individual brand with no organisation has no CSV export (exports live on the organisation). Invitations need an existing account.

## Lifecycle

* **Invite**: `invite_org_member` (handle or email of a registered person), then the person accepts or declines with `respond_org_invite`. One live membership per person per organisation.
* **Departure**: `remove_org_member` sets `status='left'`; the row, and everything the person recorded, stays. The last owner cannot leave or be demoted: use `transfer_org_ownership` (the previous owner becomes admin).
* **Linking**: `link_org_asset` needs both an owner/admin role in the organisation and ownership of the team/event/venue. An asset belongs to at most one organisation. The asset's owner keeps working as before; organisation roles are an additional grant. `unlink_org_asset` ends the delegation.
* **Archive**: `archive_organisation` makes the workspace read-only (writes return 409) and pauses delegated access to linked assets. History stays readable; `restore_organisation` reverses it. Nothing is deleted.
* **People and consent**: enrolments need an explicit consent attestation per person (`consent=yes` in the CSV). People can withdraw themselves (`withdraw_org_enrolment`), keep read access to their own attendance after leaving (`get_cohort_attendance`, `list_my_enrolments`), and one identity can belong to many organisations.

## Bulk enrolment

`preview_bulk_enrolment` takes CSV text with columns `handle` (or `email`) and `consent` and returns a per-row report (`ok`, `duplicate`, `invalid`, with the reason and line number) without writing. `commit_bulk_enrolment` re-validates in one transaction (cohort row locked) and enrols nobody if any row has a problem, unless `allow_partial` is true. Repeating a commit never double-enrols; concurrent identical commits produce one set of rows. Up to 500 rows per call.

## Schema and rollback

`apps/api/migrations/022_organisations.sql` is additive: new tables `organisations`, `organisation_members`, `org_seasons`, `org_cohorts`, `org_enrolments`, `org_attendance`, plus nullable `organisation_id` on `teams`, `events` and `venues`. No `DROP`, no data rewrite, no `ON DELETE CASCADE`. Existing rows are untouched (`organisation_id` is `NULL`). Rollback: deploy the previous API build, which ignores the new tables and columns. Dropping them is intentionally not scripted; if ever needed it is a manual maintainer decision.

## Operations and limitations

* Failure modes: 404 for organisations/cohorts you do not belong to (existence is not leaked), 403 for a role that cannot do the action, 409 for archived organisations/cohorts, last-owner and duplicate-membership conflicts.
* Invitations require an existing Gotmygame account; there are no email invitations to unregistered people yet.
* Consent is an attestation by the enrolling staff member; there is no separate guardian-consent flow.
* Finance figures come from the team settlement ledger (`team_payouts`) of linked teams; event/venue revenue is not aggregated yet.
* Cohorts and seasons can be archived but not renamed, and there is no per-session schedule: attendance is recorded by date.
