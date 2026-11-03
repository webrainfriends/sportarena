# Federation, Competition & Governance Core (#563)

One operating model: **federation → competition → season → registration → transfer → discipline → archive**, on a single source of truth. It extends #475 (federation OS), #476 (competitions), #477 (registration & eligibility), #478 (transfers) and #479 (discipline); it adds no second federation, competition, registration, transfer or discipline store.

## Reuse → gap → extension

| Need | Existing source (reused) | Added |
|---|---|---|
| Hierarchy international → … → participant | `governing_bodies`, `governing_body_links`, `fed_affiliations`, `organisations.parent_organisation_id`, `teams.organisation_id` | `get_governance_lineage` (read-only resolver, no new store) |
| Rule versions kept per season | `comp_rule_versions`, `reg_policies`, `fed_policy_versions`, `local_rule_versions` | `gov_rule_packs` + `gov_season_rule_pins` (immutable; pack references the versions and freezes their resolved content and a hash; backfilled for existing seasons) |
| Eligibility engine | `src/registration.js evaluate()` | stable `code` on every check (`rule.status`, text unchanged); live feeds for federation licences, approved-but-incomplete transfers and disciplinary suspensions |
| Transfers, loans, releases, clearance | `reg_dependencies`, `comp_memberships`, `career_memberships` | `tr_transfers`, `tr_approvals`, `tr_events` (migration 150) |
| Discipline, appeals, protests, waivers | `comp_adjustments`, `reg_exceptions`, `match_events` | `gov_cases` (one case table for every kind), `disc_policies`, `disc_sanctions`, `gov_case_events`, `gov_case_links` (migration 151) |
| Governance calendar | `fed_dates`, `get_federation_calendar` | season registration and transfer windows read live from `comp_seasons` |
| Archive | season status, `comp_standing_snapshots` | `gov_season_archives`: hash-sealed bundle written on archive or `archive_season_pack` |

Not touched: the platform support queue (`cases`) and integrity matters (`int_*`); cases link to them by reference.

## Capabilities (REST + OpenAPI + MCP from one definition)

* Rule packs / archive / lineage: `publish_rule_pack`, `list_rule_packs`, `pin_season_rule_pack`, `get_season_rule_pack`, `archive_season_pack`, `get_season_archive`, `get_governance_lineage`.
* Transfers: `request_transfer`, `get_transfer`, `list_transfers`, `amend_transfer`, `submit_transfer`, `decide_transfer`, `set_transfer_clearance`, `set_transfer_fee_state`, `grant_transfer_window_exception`, `withdraw_transfer`, `complete_transfer`.
* Discipline: `publish_discipline_policy`, `get_discipline_policy`, `open_discipline_case`, `open_governance_case`, `decide_governance_case`, `file_appeal`, `decide_appeal`, `set_sanction_fine_state`, `clear_case_review_flag`, `get_governance_case`, `list_governance_cases`, `get_suspension_status`, `list_public_sanctions`.

## Rules the server enforces

* **History is never rewritten.** Rule packs, pins, archives, transfer approvals and events, case events, policy versions and sanctions are append-only or supersede-only (database triggers). Nothing is deleted.
* **Transfers.** Each required party (player, guardian for youth, current club, destination club, competition authority when in a season) approves the *current version*; amending bumps the version and voids earlier approvals (`stale_version` 409). Nobody signs for another party. Completion runs once (idempotent), moves team membership, withdraws/submits the competition registration, writes the career timeline and records a `transfer` dependency for eligibility. Windows come from the season; an authority exception needs a reason and is audited. Fees and external clearance are separate states and never complete a transfer.
* **Discipline.** Cautions accumulate under the policy version; reaching a threshold issues the suspension exactly once, even concurrently. A dismissal can set an *interim* measure (labelled interim, never a finding). Served matches are derived from completed fixtures; postponed and cancelled games do not count. Points deductions go through `comp_adjustments`; fines carry their own money state. Appeals respect the window; the policy may stay sanctions while an appeal is heard; a reduction supersedes the original, an overturn reverses the adjustment. Correcting a match event flags the cases raised from it for review (`needs_review`); nothing is deleted.
* **Eligibility.** Suspensions, licences and transfers are read live at selection and at match lock, so stale squad data cannot bypass them. Result values stay `eligible | ineligible | pending | unknown`; every check carries a stable `code`.
* **Privacy.** Outsiders get 404. Reasons, summaries and decisions are encrypted (`*_enc`); reads by someone other than the subject are audit-logged. Public sanction lists show only what the policy discloses, never fines, reasons or a young person.

## Sports coverage

Discipline vocabulary is native for goal games, cricket, racket/set sports and timed/measured events; every other sport uses a **labelled generic fallback** (`vocabulary.native=false`, shown in the app). The test walks the whole catalogue. Match-suspension service counts completed fixtures, which every fixture-based sport has; individual-event disciplines (heats, meets) use date suspensions until a native service model exists — a known gap.

## App

New tabs inside Competition Home (no second console): **Transfers**, **Discipline**, **Archive** (rule pack and season seal). iOS, iPadOS, Android and web share one codebase; strings are in `gov.*` in all 12 packs (machine-drafted, `reviewed: false`).
