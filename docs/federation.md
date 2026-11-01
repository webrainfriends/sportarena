# Federation & Governing Body OS (#475, #574)

A governing layer over the canonical SportArena entities: **international / national federation → regional or state association → league organiser →
club, academy or school → teams and participants.** A governing body is an ordinary organisation plus one `governing_bodies` row (level, jurisdiction,
abbreviation); clubs, teams, events, people, rule packs, payments and cases are **referenced, never copied**.

## Reuse and gap matrix
| Requested capability | Existing source (reused) | Verified gap | Smallest compatible extension |
|---|---|---|---|
| Body identity, legal/registration ids, public contact, owners | `organisations` (legal_name, registration_no, website, contact_*), `organisation_members` | level, jurisdiction, recognised parent, scoped federation roles | `governing_bodies` (1:1 with an organisation), `governing_body_sports`, `governing_body_links`, `governing_body_roles`; `organisations.kind` also allows `federation` |
| Affiliation of clubs / academies / schools / leagues | `organisations`, `teams.organisation_id`, `organisation_members` | applications, requirements, number, season, renewal chain, fee state | `fed_affiliations` + `fed_affiliation_categories`; **never touches** org owners, members or teams |
| Licences for athletes, coaches, officials | `users` (identity + roles), `guardian_links`/`youth_consents`, `verification_cases` (verified coach/physio/doctor), club membership via `team_members`/`organisation_members` | licence type/grade, standing, issue/expiry, renewal | `fed_licence_types`, `fed_licences` (public check code; a young person's name is never public) |
| Sanctioning an event | `events` (dates, venue, sport), `event_staff_assignments`, `event_entries`, `insurance_policies`, `ruleset_versions` (#68) | request/decision workflow, number, conditions, drift | `fed_sanctions` references the event; **no events row is created or changed** |
| Governance calendar | `events`, `fed_sanctions`, affiliations, licences | the federation's own windows/congress/deadlines | `fed_dates`; everything else is read live from its source |
| Versioned governing requirements | #68 keeps playing/scoring rules | administrative requirements by sport/category/season/date | `fed_policies` + immutable `fed_policy_versions`; inherited down the hierarchy |
| Federation Home, reports, exports | canonical tables above | dashboards, as-of reports, hashed export log | `get_federation_home`, `get_federation_report`, `fed_exports` (append-only) |
| Certificates, licences, sanction letters | #249 branded documents (templates, kits, encrypted PDFs) | a family | `federation_document` family; same `generated_documents` and live download check |
| Disciplinary / appeal links | `cases` + `case_links` | link types | `federation_licence` / `_affiliation` / `_sanction` link types; the holder, club admin or organiser raises the case |
| Audit, notifications, jobs | `audit_log`, `notify`, worker steps | immutable decision history | `fed_events` (append-only), sweep `federation` in the worker |

## Rules
- **Hierarchy.** One recognised parent at a time, answered by the other side (an admin of both sides recognises at once), serialised with an advisory lock and
  backed by a database trigger so it can never loop. Ending a recognition keeps the row and dates.
- **Least privilege.** Owners/admins of the body's organisation do everything; scoped roles (`registrar`, `licensing`, `sanctioner`, `secretary`,
  `compliance`, `auditor`) each do one job, optionally for one sport, read live (revoking is immediate). Staff of a body *above* another get read-only
  roll-ups of it, never decisions. No federation capability reads a club's members, finance, coaching notes or medical data; outsiders get 404.
- **Decisions.** Every transition runs inside a row-locked transaction with an optional `version` (stale → 409), is validated against a transition table and lands
  in the append-only `fed_events` with who, why and the **policy version used**. Approval runs the published requirements; a failed requirement needs an
  `override_reason`, stored as a **compliance exception** and shown on Federation Home.
- **Policies.** `publish_policy_version` adds an immutable, dated version (later than the previous). `policyAt` picks the most specific policy
  (sport > category > season) of the nearest body up the hierarchy, then the latest version in force on the date. `affiliation`, `licence` and `sanction`
  policies are **enforced** at decision time; the others (eligibility, roster, entry, grades, registration, transfer, discipline, para-classification) are
  published governing references.
- **Standing is live.** An approved affiliation or active licence past its end date reads as expired immediately; the worker sweep persists it (with history),
  lifts timed suspensions and sends renewal reminders at 30 and 7 days.
- **Evidence** (documents, numbers, links) is encrypted at rest; lists show metadata only; every read by a reviewer is audit-logged.
- **Fees** are recorded (due → paid with date/reference, or waived with a reason). No money moves through this module.
- **Young people.** A verified guardian applies; current participation consent is required to apply and to issue; the public check hides a young person's name.
- **Reports** read the same status rules as the lists, so Federation Home, the lists and the reports reconcile; exports are spreadsheet-safe, capped at
  5,000 rows, logged in `fed_exports` with a hash of the file.

## Capabilities (REST + OpenAPI + MCP, tag `Federation`)
Bodies and hierarchy: `create_governing_body`, `list_governing_bodies`, `my_governing_bodies`, `get_governing_body`, `update_governing_body`, `set_governing_body_status`,
`propose_body_link`, `respond_body_link`, `end_body_link`, `list_body_links`, `grant_federation_role`, `revoke_federation_role`, `list_federation_roles`,
`list_federation_history`, `list_policy_kinds`. Affiliation: `save_affiliation_category`, `list_affiliation_categories`, `apply_affiliation`, `submit_affiliation`,
`decide_affiliation`, `record_affiliation_fee`, `withdraw_affiliation`, `renew_affiliation`, `list_affiliations`, `get_affiliation`, `*_affiliation_evidence`,
`list_affiliated_organisations`. Licences: `save_licence_type`, `list_licence_types`, `apply_licence`, `submit_licence`, `decide_licence`, `record_licence_fee`,
`withdraw_licence`, `renew_licence`, `list_licences`, `get_licence`, `*_licence_evidence`, `verify_licence`. Sanctions: `check_sanction_readiness`, `request_sanction`,
`amend_sanction`, `withdraw_sanction`, `decide_sanction`, `list_sanctions`, `get_sanction`, `*_sanction_evidence`, `get_event_sanctions`, `list_jurisdiction_events`.
Governance: `save_federation_policy`, `publish_policy_version`, `retire_federation_policy`, `list_federation_policies`, `get_federation_policy`,
`resolve_federation_policy`, `save_federation_date`, `cancel_federation_date`, `get_federation_calendar`. Workspace: `get_federation_home`, `get_federation_report`,
`list_federation_exports`, `generate_federation_document`, `list_federation_documents`.

## UI
`Federations` (hub: my bodies, my licences, club affiliations, check a licence, directory, set up a federation), `FederationHome` (Overview, Affiliations, Licences,
Sanctions, Calendar, Policies, Reports, Setup), `FederationRecord` (one detail screen for an affiliation, licence or sanction), `VerifyLicence`, `OrgAffiliations`
(from the organisation screen), `MyLicences` (More wheel) and a sanction section inside the existing event console. One codebase for iOS, iPadOS, Android and web.

## Governance depth (#574)
Issue #574 asked to close the governing-body administration gap by completing #475. Inspecting `main` first: affiliation categories and lifecycle, licence
types and lifecycle (issue, renew, suspend, expire, evidence), sanctioning, versioned policy with effective dates, Federation Home, reports and the
30/7-day reminders already existed, so none of them was rebuilt. Three gaps remained, each added **inside** the existing module:

| #574 scope | Was | Now (one place) |
|---|---|---|
| Delegated administration by jurisdiction/region | roles limited by sport only | `fed_jurisdictions` (regions, states, districts per body); records carry an optional `jurisdiction_id` (apply forms offer a picker); a role can be limited to some jurisdictions (`governing_body_roles.jurisdiction_ids`) |
| Renewal campaigns and notifications | fixed reminders at 30/7 days | `fed_campaigns` + `fed_campaign_recipients`: choose affiliations or licences, categories/types, jurisdictions, sport, the window the records end in, and the reminder schedule; launch, track, close. The automatic 30/7 reminders skip records inside a running campaign so nobody is told twice |
| Compliance status and exceptions | overrides were only listed on Home | `fed_exceptions` register: opened automatically by an override, due for review in 90 days, reviewed as remedied / extended / accepted with a required note; standing (`get_federation_compliance`) |

Rules:
- **Jurisdiction limits fail closed.** A limited role covers only records filed under its jurisdictions: lists, queues, the dashboard queues, the compliance
  register and campaign progress are filtered; a record outside them (or with no jurisdiction) is a `404`, and decisions on it are refused. Body-wide actions
  (reports, exports, policies, categories, the calendar) are closed to limited roles. Staff of a body above stay read-only; owners/admins and unlimited roles
  see everything. Dashboard totals are body-level counts with no names.
- **Campaigns never copy state.** The covered records are fixed at launch; whether each was renewed is read live from the renewal chain (`previous_id`), so
  progress always agrees with the affiliation or licence itself. Contacts are a club's owners/admins, or a licence's holder and applicant. A campaign closes
  itself when everything is renewed, or 60 days after its window.
- **Exceptions are history.** Reviews are rows in the append-only `fed_events`; the decision on the record is never rewritten. The `compliance` role now
  reviews exceptions (within its jurisdictions); it still decides no applications.
- **Migration `130`** only adds tables and nullable columns, widens one CHECK (`fed_events.subject_type`), and turns decisions already approved over a failed
  requirement into open exceptions due 90 days after the decision. Nothing is deleted or rewritten.

New capabilities (REST + OpenAPI + MCP, tag `Federation`): `save_federation_jurisdiction`, `archive_federation_jurisdiction`, `list_federation_jurisdictions`,
`list_federation_exceptions`, `review_federation_exception`, `get_federation_compliance`, `preview_renewal_campaign`, `save_renewal_campaign`,
`launch_renewal_campaign`, `close_renewal_campaign`, `list_renewal_campaigns`, `get_renewal_campaign`; `grant_federation_role` takes `jurisdiction_ids`, and
`apply_affiliation`, `apply_licence` and `request_sanction` take `jurisdiction_id`.

UI: Federation Home gains **Campaigns** and **Compliance** tabs; Setup gains **Regions, states and districts** and a places picker on *Give a role*. Pickers
are searchable dropdowns (multi-select where several apply), dates use the calendar range picker. One codebase for iOS, iPadOS, Android and web.

## Migration and rollback
`115_federation_os.sql` only adds tables and widens two CHECK constraints (`organisations.kind`, `case_links.entity_type`); every existing value stays valid. No
data is deleted, rewritten or cascaded. Rollback = deploy the previous code; the tables stay, unused.

## Limits
Playing and scoring rules stay in the governed rulebook (#68). Transfers, rosters and discipline policies are published references (there is no transfer ledger
yet). Fee collection through the payments gateway is not part of this change; the module records what was paid.

## Governance at scale (#525)
Extends the same hierarchy, roles, policies and history; nothing is copied. Migration `130_federation_scale.sql` is additive.
- **Delegation** (`grant_federation_delegation`, `revoke_federation_delegation`, `list_federation_delegations`, `my_federation_delegations`): one role on a body and the bodies beneath it to `max_depth` levels, optional sport and expiry. Resolved in `authority()` with one recursive query; never reaches siblings or ancestors, cannot be re-delegated.
- **Maker-checker** (`set_federation_approval_rule`, `get_federation_approval_rules`, `request_federation_approval`, `decide_federation_approval`, `cancel_federation_approval`, `list_federation_approvals`, `get_federation_approval`): rules cover affiliation approve/suspend, eligibility override, credential exception, sanction approve, policy publish and file export. A rule on a body binds everything beneath it. An approval is bound to its requester and to a hash of the exact terms, used once, expires after 7 days, and is immutable (database trigger).
- **Policy inheritance**: `local_override: locked` on a requirement stops bodies beneath from publishing their own; `get_policy_inheritance` shows source, version and why.
- **Dashboard and reports**: `get_federation_rollup`, `list_federation_rollup_records`, `list_federation_metric_definitions`, `get_federation_aggregate`. Person-level cells under 5 are hidden (with complementary suppression); youth are never shown separately; file exports need a purpose and name no youth holder.
- **Access review**: `get_federation_access_review`, `record_federation_access_review`, `list_federation_access_reviews`.
- UI: the Governance tab of Federation Home (no separate console).

Limits: data-exchange profiles depend on #483, which is not built yet; finance/settlement approval is not applicable (fees are only recorded); delegation covers governing-body levels, clubs stay leaf organisations.
