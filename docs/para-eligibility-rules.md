# Para rule packs, lineup validation and overrides (#834)

Incremental on **#477** (competition registration and eligibility) and **#488** (governed para classification). It adds no second registry for
players, classes or policies: a **rule pack** is data a competition's eligibility policy points at, and it is evaluated inside the same
preflight points the engine already has.

## What a rule pack is
`para_rule_packs` (migration `160_para_rule_packs.sql`): per competition, versioned, immutable once published (a trigger refuses UPDATE/DELETE).
Fields: publisher, source reference (rulebook section or link), and a declarative `definition`:

| Part | Meaning |
|---|---|
| `classes` | eligible class codes (picked from the governed catalogue of the sport, #488), optional `points` per class |
| `categories` | category groupings of classes |
| `status_required` | accepted classification statuses (`confirmed`, `temporary`) — `review_required`, `not_eligible` and a lapsed review never pass |
| `rules[]` | validators: `class_points_cap`, `class_quota`, `same_class_max`, `role_required`, `composition` (each with its own parameters, scope `court`/`all`) |

No rule is assumed for every sport: wheelchair basketball uses a class-points cap and a five-player lineup; boccia uses pair/team composition, a
class-balance limit and a role (sport assistant) required when a BC3 athlete plays. Both run on the same engine (`apps/api/src/para-rules.js`).
Declared tags (e.g. a mixed-category allowance) adjust points; **nothing is inferred** from media, results or staff opinion.

## Version lock
`reg_policies.rules.para_pack_id` locks a policy version to one pack version. Policies and packs are append-only, so the rules in force at any
past instant are recoverable. `para_lineup_snapshots` stores, at fixture lock and kick-off, the pack version, the **exact definition**, the
class code/status of each person and any override used — reproducible even after the pack, policy or classification later changes.

## Preflight points (all server-side)
* **Registration / roster submission / squad selection / lineup change** — `evaluate()` adds a `para_pack` check per person (class accepted by the pack).
* **Lock and kick-off** — `lockFixtureEligibility` also evaluates each team's lineup (`paraLineup`). A blocking policy refuses with
  `para_rules_blocked`, listing every failure with a reason and a remediation. Nothing is written on a refusal.
* **On demand** — `check_para_lineup` tries a saved or hypothetical lineup, audited.
Competitions whose policy has no `para_pack_id` are untouched.

## Overrides (competition-specific policy exceptions)
`request_para_override` (team manager or organiser) → `decide_para_override` (an organiser **other than the requester**; approval needs an end
time ≤ 1 year) → the check shows `waived`, named in the snapshot; revoke restores the block. Reasons are encrypted (`para_overrides.reason`) and never listed.
Per-person exceptions stay in #477's `reg_exceptions`; lineup rules are group-level, hence this small table.

## Privacy
Only the class code and administrative status leave the classification service. No evidence, case history, assessment note or diagnosis is read
or returned by any capability here (tested across API and MCP). Youth without current guardian consent appear as "Protected participant".
The projection is visible to the organiser (all), a team manager (their teams) and an athlete (themselves); everyone else gets 404.

## Capabilities (REST + OpenAPI + MCP from one definition, `apps/api/src/capabilities/para-rules.js`)
`publish_para_rule_pack`, `list_para_rule_packs`, `check_para_lineup`, `get_para_eligibility_projection`, `request_para_override`,
`decide_para_override`, `list_para_overrides`, `get_para_lineup_snapshots`.

## UI
Event → Registration → **Para rules** (organiser: rule packs, lineup check, overrides, entries); team managers and athletes see lineup check and
"Why am I eligible?" inside their own Registration view. `apps/app/src/screens/para-rules.js`, hosted in `event-registration.js`. All text is in
`pr.*` keys in the 12 language packs (machine-drafted, `reviewed: false`). Screens: `npm run` the script `scripts/e2e/para-rules-ux.mjs`.

## Migration / rollback
Additive (three new tables, one trigger). Rollback = stop referencing packs (`para_pack_id` absent in the next policy version); no data is removed.
