# Sports Disciplinary & Sanctions (#479)

One governed discipline domain that turns the **canonical match record** (cards, official reports) into competition-level cases, suspensions and eligibility effects, without a second incident log and without ever editing a score or a referee record.

## What it is (and what it is not)

| Concern | Where it lives | Relationship |
|---|---|---|
| A card / send-off | `match_events` (kind `yellow_card`, `red_card`, …) | **referenced** by `disc_cases.match_event_id`, never copied |
| An official report | `official_reports` / `official_report_revisions` | **referenced** by `disc_cases.official_report_id` |
| Anti-doping / match-fixing | `int_*` (#489), strictly need-to-know | unchanged; its sporting sanction is still handed to eligibility |
| Event sanctioning by a governing body | `fed_sanctions` (#475) | unrelated (it sanctions an *event*, not a person) |
| Support / transactional disputes | `cases` | unrelated |
| Fines | `team_charges` (batch kind `fine`) | canonical team finance, separate from sporting state |
| Points deductions | `comp_adjustments` (+ `disc_sanction_id`) | the competition adjustment mechanism, append-only, reversed by a reversing row |
| Eligibility | `integrity.activeSportingSanction()` | **one** read: integrity decisions first, then `disc_*` |

Tables are `disc_*`: `disc_members`, `disc_policies`/`disc_policy_versions`, `disc_cases`, `disc_evidence`, `disc_events`, `disc_decisions`, `disc_sanctions`, `disc_appeals`, plus `disc_verification_requests`/`disc_attestations` (official verification). Decisions, events and policy versions are immutable by trigger. Migration `149_discipline.sql` is additive only.

## Policy (versioned, deterministic)

`save_disciplinary_policy` publishes an immutable version per competition (or per season). Parameters: caution points per card kind, accumulation thresholds, direct suspensions (e.g. red card), second-caution rule, carry-over, expiry window, scope (competition or sport), whether an abandoned match counts as served, repeat-offence escalation, fine / points-deduction authority and caps, appeal window, stay on appeal. `evaluateThresholds()` is pure: the same cards give the same triggers in any order. A case stores the version that governed it.

## Case lifecycle

`opened → under_review → decided → closed` (or `withdrawn`). Cases come from the worker/`sweep_disciplinary_cards` (policy thresholds, recorded as an automatic *policy* decision), from `open_disciplinary_case` (a match event, an official report, or a manual referral). One card feeds one case per person (unique index). `interim_status` (`pending_review`, `interim_suspension`) is separate from the final sanction and is never a finding.

## Serving suspensions

`serviceOf()` derives the count from `fixtures` every time (nothing is copied): completed/finished = served; abandoned = per policy; cancelled and postponed never count (a postponed match counts once played). Remaining matches block eligibility only for the matches they cover.

## Eligibility cannot be bypassed

`registration.evaluate` (rule `suspension`) and `set_match_lineup` both call `activeSportingSanction`, which reads `disc_*` live. Stale squad data cannot put a suspended player on the sheet.

## Corrections

Voiding or correcting a `match_events` row calls `flagForEvent()`: affected cases are flagged `reevaluation = flagged`, an event is logged, and the earlier decision stays on record until a panel re-decides.

## Privacy and public view

- Suspensions, cases and sanctions appear on **no** public surface: profile, search, roster, shared licence card, export packs (`disciplinary_record` is in `NEVER_INCLUDED`).
- Case reads shape by role: panel (everything), the person/guardian (allegation, decisions, appeal rights; no panel notes), team manager (category, status and outcome only). Anyone else gets `404`. Reads are audited; free text is `*_enc`.
- Notifications are neutral ("update on a competition matter").

## Official verification and the Official verifier role

An organiser, competition official or academy that holds the **`reports.official_verification`** entitlement (a platform-reports plan, resolved through the commercial engine) can request an official verification of a person's standing. It is closed until the platform publishes a plan that grants it. The answer is an **attestation** (`eligible` / `not_eligible` / `unable_to_verify`, `as_of`, `valid_until` = 30 days) and never the sanction, reason or evidence. A young person needs current guardian consent.

`official_verifier` is platform staff for these requests only: granted/revoked by the platform admin (`mustBePlatformAdmin`), never self-assignable, never shown publicly, MFA required, not stripped by the admin allow-list reconcile. Platform admins keep override access through the existing role check. A verifier cannot act on a request they made or that concerns themselves, and one verifier holds a request at a time.

## Sports coverage

`disciplineModelOf(sport)` derives each sport's model from its live scoring ruleset: **cards** (yellow/red/green/black card, 2-minute), **graded conduct** (warning, chukoku/keikoku, point deduction) or **foul limits**; every other sport uses a **labelled generic fallback** ("Generic misconduct referral"), never a silent default. Manual referral and every sanction type work for every sport. `test/discipline.test.js` walks the whole catalogue.

## API / MCP

All capabilities are defined once and exposed as REST, OpenAPI and MCP tools: `get_disciplinary_vocabulary`, `save_/get_disciplinary_policy`, `get_disciplinary_overview`, `add_/end_/list_disciplinary_panel…`, `open_/list_/get_/transition_disciplinary_case`, `sweep_disciplinary_cards`, `add_/get_disciplinary_evidence`, `decide_disciplinary_case`, `lift_disciplinary_sanction`, `lodge_/rule_on_disciplinary_appeal`, `list_my_disciplinary`, `list_team_disciplinary`, `get_event_disciplinary_scope`, and for verification `grant_/revoke_/list_official_verifier(s)`, `request_official_verification`, `list_my_official_verifications`, `withdraw_official_verification`, `list_verifier_queue`, `claim_verification_request`, `decide_verification_request`, `revoke_verification_attestation`.
