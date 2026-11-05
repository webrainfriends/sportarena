# Para classification in competition (PS-02, #832)

Integration only. The classification itself (definitions, classifiers, cases, panels, evidence, outcomes, appeals, external references) is owned by #488 (`apps/api/src/capabilities/para-*.js`). Eligibility and registration are owned by #477 (`src/registration.js`, `capabilities/registration*.js`). This module adds **no classification tables** and never lets a person or an AI assign a class.

## What it adds
| Requirement | Where |
|---|---|
| Per-category accepted classes, provisional switch | Policy rules `category_classes` (division id → class codes) and `allow_provisional` (`src/registration.js`, versioned with the policy) |
| Entry gate: definitive refusal blocks, missing/pending class is flagged | `bindEntryClass` called from `submit_registration` and `review_registration` |
| Frozen class at entry and registration | `para_entry_snapshots` (append-only); match lock keeps using `reg_snapshots` |
| Provisional participation (policy-approved, dated, reason encrypted, never over "not eligible") | `para_provisional`, `grant_para_provisional` / `revoke_para_provisional` |
| Athlete/guardian projection | `GET /me/para-entries` (`my_para_entries`) |
| Organiser category check and overview | `GET /events/:id/para/check`, `GET /events/:id/para/summary` |
| Officials/staff match summary (frozen at lock) | `GET /fixtures/:id/para` |
| Unverified references are never authoritative | A manual "classification clear" dependency now yields *pending (unverified)*; only a governed outcome or a second-officer-verified external reference passes |

All six are capabilities, so REST, OpenAPI and MCP share one definition. Projections carry only class, status, authority, rules version, decision reference and provisional end date; never case, panel, evidence or appeal grounds.

## Screens (one codebase: iOS, iPadOS, Android, web)
- Athlete / guardian: *My classification* → "Where my class applies" (`screens/para-competition.js` `ParaEntries`)
- Organiser: Event → Registration → **Classification** section (`ParaDesk`), and the Policy form (per-category classes, provisional switch)
- Officials/staff: match briefing → "Classification at match lock" (`FixtureParaSummary`)

## Data safety
Migration `160_para_competition_binding.sql` is additive (two new tables, no `DROP`, no cascade). Rollback = ignore the tables; nothing existing depends on them.
