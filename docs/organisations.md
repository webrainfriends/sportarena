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

Org roles are separate from the global `users.roles`. Membership is read live on every request, so removing someone ends their access immediately. Organisation staff never get clinical data: it stays behind the athlete's own `medical_grants` consent. Exports contain handles and display names only, never email, phone or other encrypted fields, and each export is audit-logged.

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
* Invitations require an existing SportArena account; there are no email invitations to unregistered people yet.
* Consent is an attestation by the enrolling staff member; there is no separate guardian-consent flow.
* Finance figures come from the team settlement ledger (`team_payouts`) of linked teams; event/venue revenue is not aggregated yet.
* Cohorts and seasons can be archived but not renamed, and there is no per-session schedule: attendance is recorded by date.
