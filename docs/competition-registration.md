# Competition registration & player eligibility (issue #477)

Decides whether a player is registered for a team in a competition season and, separately, whether they are eligible for a given fixture.
A competition season is the existing **event**. Everything is a capability (REST + OpenAPI + MCP); the app only calls it.
Migration `115` is additive: nothing is dropped or rewritten. Policy versions, registration history and eligibility snapshots are append-only (database trigger).

## Eligibility source-of-truth matrix

| Fact | Authoritative source (not copied) | Read by eligibility as |
|---|---|---|
| Player / team identity | `users`, `teams` | ids only |
| Team affiliation | `team_members` (active) | check `team_affiliation` |
| Date of birth | `users.dob_enc` (decrypted only when a division has a birth-date range; audit `read_dob_eligibility`) | check `division_age`; no DOB = `unknown` |
| Age category | `reg_divisions` (explicit birth-date bounds set by the organiser) | never inferred |
| Registration, roster list, number, origin class | `reg_registrations` (new) | checks `registration`, `roster_list` |
| Origin (local / homegrown / foreign) | declared by the registrar on review | quotas; never inferred from nationality, residency or profile |
| Windows | `reg_windows` (exact instants + authoring timezone) | enforced at submission |
| Policy / rules | `reg_policies` (versioned, append-only) | rule set for every evaluation |
| Licence, transfer, loan, suspension, classification | `reg_dependencies`: a reference (`source_ref`, `source_label`) to the record held elsewhere (federation, disciplinary panel, #323 history) with clear / pending / blocked and validity | checks `licence`, `transfer`, `loan`, `suspension`, `classification` |
| Player contract (#333) | `player_contracts` (active, role player) | check `contract`, only when the policy requires it |
| Youth / guardian consent (#70) | `youth_consents`, `guardian_links` | check `guardian_consent` (live revocation) |
| Exceptions / waivers | `reg_exceptions` (reason and evidence encrypted) | check shows `waived`, naming the exception |
| Squad | `team_squads` (match-level wins over event-level) | who is evaluated |
| Decision used at lock / kick-off | `reg_snapshots` (policy version, full rule set, per-check reasons) | immutable audit |

## Decision
Each rule yields `pass | fail | pending | unknown | waived`. **ineligible** = any failed (un-waived) check; else **unknown** = something that must be known cannot be established;
else **pending** = awaiting a person; else **eligible**. Reasons are plain language. Non-organisers never see source labels or notes.

## Capabilities
Set-up: `get_registration_setup`, `publish_registration_policy` (versioned, `expected_version` guards two editors), `add_registration_division`, `archive_registration_division`, `add_registration_window`, `retire_registration_window`.
Registrations: `submit_registration`, `list_registrations`, `list_my_registrations`, `review_registration` (start_review / register / reject / suspend / reinstate / expire), `change_registration_list`, `withdraw_registration`, `get_registration_history`, `get_roster_summary`.
Eligibility: `grant_eligibility_exception`, `revoke_eligibility_exception`, `list_eligibility_exceptions`, `record_eligibility_dependency`, `list_eligibility_dependencies`, `check_fixture_eligibility`, `check_player_eligibility`, `lock_fixture_eligibility`, `get_eligibility_snapshots`, `get_registration_report` (JSON or CSV, deterministic, audit-logged).

## Rules enforced on the server
* **Windows** (`regular`, `late`, `emergency`): authored as local date + time + IANA timezone, stored as exact instants. Late and emergency need a reason and are flagged. No windows = open. A `window` exception opens a closed window for one person.
* **One live registration per person per competition** (partial unique index), the team must be entered, the player must be an active team member, young people need participation consent.
* **Roster limits, list limits and quotas** are checked inside a transaction that locks the team's entry, so parallel decisions cannot exceed them; stale clients are refused with `row_version`. Only a `roster_limit` / `quota` exception the policy lists as waivable gets past a limit. **Roster freeze** (`freeze_at`) refuses new registrations and list moves unless a `window` exception is in force.
* **Exceptions** can only waive rules the policy lists in `waivable`, last at most a year, never edit the rule or registration, and are listed (reason and evidence decrypted, audit-logged) for organisers only.
* **Selection and kick-off**: `set_squad` refuses players the policy blocks (`enforcement=blocking`, `block_on`); `start_match` re-evaluates both squads and stores a `start` snapshot; `lock_fixture_eligibility` stores a `lock` snapshot. Events with no policy are unchanged.
* **Privacy**: organiser / org admin see all; team managers their own teams; players themselves; everyone else gets `404`. Young people without current consent show as "Protected participant" in lists, exports and exception lists.

## App
Event console → **Registration** (organiser: Queue · Rosters · Windows · Exceptions · Clearances · Policy · Reports, master-detail on tablet and desktop, sheets on phone). Team managers and players open it from the event page (**My registration**) to see their state, register players or themselves, move lists and withdraw.
