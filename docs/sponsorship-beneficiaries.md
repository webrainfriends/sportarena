# Sponsorship beneficiaries, representatives, payees and allocations (#291)

A sponsorship can now be aimed at a canonical **organisation** or a **durable group** (an organisation cohort — its members come and go), in addition to event, team and athlete. Everything hangs off the existing `sponsorships` row, obligations and payments; there is no second ledger and no new identity system.

## Roles

| Role | Who | Can |
|---|---|---|
| Beneficiary | the organisation / group (and, on an organisation deal, its groups and teams) | is named on the allocation |
| Representative | a **live** `owner`/`admin` of the organisation | accept/decline the offer, set allocations, confirm payments, receive goods, review endorsements |
| Payee | a **live** `owner`/`admin`/`finance` member named on an active allocation | read the deal, confirm/reject/reverse payments (never accept or allocate) |
| Sponsor | the brand side (existing sponsor roles) | read names, shares and payee names; never rosters |

Membership is read live on every call: removing someone ends their access at once.

## Schema (migration `094_sponsorship_beneficiaries.sql`, additive)
- `sponsorships.target_type` CHECK widened to add `organisation`, `group` (all existing values stay valid); `sponsorships.allocation_rev` (optimistic-concurrency token).
- `organisations.open_to_sponsors boolean DEFAULT false` — organisations are private until an owner/admin opts in (`update_organisation`).
- `sponsorship_allocations` — beneficiary (type/id/name snapshot), `share_bp` (basis points of every money line), payee (`payee_user_id` + frozen `payee_name`), `terms_version`, `status` active/released. Unique **active** `(sponsorship, beneficiary)`. Rows are never edited or deleted: a change releases the row and inserts a new one.
- `sponsorship_payments.payee_snapshot jsonb` — the payees and per-beneficiary amounts frozen when a payment is **confirmed** (existing payments stay `NULL`).

## API (capabilities, so REST + OpenAPI + MCP)
- `search_sponsorship_beneficiaries` `GET /sponsorship-beneficiaries` (sponsors): opted-in organisations/groups, name/kind/city only.
- `propose_sponsorship` accepts `target_type: organisation | group` (organisation must be open and active; a brand cannot sponsor its own organisation).
- `get_sponsorship_allocations` `GET /sponsorships/:id/allocations`; `set_sponsorship_allocations` `POST /sponsorships/:id/allocations` `{ rev, allocations[] }` — replace-all in **one transaction under a row lock**. Fails with nothing changed on: total > 100%, a duplicate beneficiary, a beneficiary outside the organisation (or other than the group on a group deal), a payee who is not a live owner/admin/finance member, a non-representative caller (403), a stale `rev` (409 with the current `rev`), or a deal that is not proposed/active.
- Unallocated share (< 100%) stays with the organisation; rounding remainders are reported as `unallocated_cents` on the payment snapshot, never invented.

## Permissions and privacy
- Tenant isolation is server-side in `dealContext`, `list_sponsorships`, `list_sponsorship_obligations`, `get_sponsorship_summary` (`beneficiaryScopeSql`). Another organisation's staff get 403 / empty lists.
- Sponsors see beneficiary names, shares and payee display names only — no roster, enrolment, attendance or member counts. The edit candidates (groups, teams, staff payees) are returned only to the representative.
- `export_org_data` gains `section=sponsorship_allocations` (owner/admin/finance of that organisation only; audit-logged like every export): brand, agreement, beneficiary, share, payee and allocation status including released rows. No contact details or member data. Existing sections are unchanged.
- `list_sponsorships` gains `organisation_id` (still limited to what the caller may see) so organisation staff see offers aimed at their organisation and groups.

## UX
Sponsor deal screen → **Beneficiaries & payees** section (loading, empty, denied, retry, stale-version states; edit sheet with switch + percent stepper + payee per beneficiary). Sponsor home → **New offer** → Organisation / Group (search-and-pick, then the shared offer builder: see [sponsorship-offer-builder.md](sponsorship-offer-builder.md)). Organisation → Edit details → **Open to sponsors** switch; organisation overview → **Sponsorship offers & agreements** (owner/admin/finance) with a way into each deal; export button for allocations. Shares are chosen in 5% steps in the app (the API accepts any basis-point value). Verified in Chromium at phone width for the representative, payee and sponsor, including the over-allocation error and save.

## Dependency order, migration, rollback, recovery
Run migration 094 then deploy the API, then the app. Rollback = deploy the previous code; new tables/columns are ignored and the widened CHECK is harmless (rows with `organisation`/`group` targets remain). No data is rewritten or removed. A payee who leaves: their access ends immediately; a representative replaces them (the old row is released and kept).

## Limits
Payments remain tracked-not-collected (see #71 for shared settlement). Team allocations apply to teams linked to the organisation (`teams.organisation_id`). Notifications go to the organisation's oldest active owner and sponsor staff; no email/branded-document work (#243/#249).
