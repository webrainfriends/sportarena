# Academy OS P0: coaching philosophy, curriculum & methodology governance (#782)

This layer lets an academy write down **how it coaches**, turn that into **versioned, Technical-Director-approved curricula** for a season / age band / stage /
campus, **plan** those objectives onto real sessions, and **prove** they were delivered through the coach's own coaching tools. It is configuration and
evidence only: there is **no second planner, session, calendar or scoring engine**.

## Requested feature → source of truth → gap → smallest extension

| Requested | Canonical source (reused) | Verified gap | Minimal additive extension |
|---|---|---|---|
| Sport-specific methodology library: values, competencies, outcomes, approved drills | `sports`, `coaching_rubrics` (measurement), coach drill/templates (private to a coach) | an academy-level, versioned library | `academy_methodologies`, `academy_methodology_versions` (append-only; philosophy, how-we-coach principles, game model by phase, stage ladder, competencies with proficiency per stage, outcomes by stage/age/level/position, approved drills, session standards) |
| Version & publish curriculum by season, academy, age band, level, campus with inheritance and effective dates | `org_seasons`, `venues.organisation_id` (campus), `academy_pathways` (level), `org_cohorts` | a controlled teaching plan | `academy_curricula` (`parent_id` inheritance), `academy_curriculum_versions` (draft → submitted → approved → published/superseded; frozen after submit), periodisation phases |
| Map objectives to Coach Performance Studio plans and Academy sessions without duplicating | `academy_sessions`, `coaching_session_records`, `coaching_session_plan_versions` (blocks), `block_log`, `coaching_rubrics` | the link and the evidence | `academy_session_objectives` (frozen snapshot per session). The coach's plan blocks are tagged `obj:<key>`; completion is read back from `block_log`. Nothing is copied into a second plan |
| TD approval, coach assignment, coverage dashboards, deviation reasons, reviews | `organisation_members`, `org_staff_engagements` (permission set), `notify` | governance workflow | permission `curriculum` (Technical Director = owner/admin or engagement with it), `academy_curriculum_assignments`, `academy_curriculum_reviews`, deviation reasons on outcomes, coach acknowledgement and feedback loop |
| Preserve historical versions; guardian-facing summaries | `academy_pathways` pattern, `youth.js` (`requireGuardian`) | summary for families | snapshots + DB triggers; `get_my_academy_curriculum` (plain-language lines, no other athlete, no coach-private data) |

## Data model (migration `153_academy_curriculum.sql`, additive only)
`academy_methodologies`, `academy_methodology_versions`, `academy_curricula`, `academy_curriculum_versions`, `academy_curriculum_assignments`, `academy_session_objectives`,
`academy_curriculum_reviews`, `academy_curriculum_acks`, `academy_curriculum_feedback`. Two triggers make history evidence: a submitted version's objectives/phases cannot be edited,
and a session objective's snapshot / version / key can never change (only the delivery outcome columns).
Nothing is deleted: versions are superseded, assignments are ended, objectives are `removed` only before an outcome exists.
**Rollback:** stop using the capabilities (the tables only hold governance records and are never read by other domains). No existing table was altered; the new `curriculum`
engagement permission is an additive enum value (`PERMS`). Restoring a database backup from before the migration is the only destructive path and is a maintainer decision.

## Capabilities (REST + OpenAPI + MCP from one definition, `apps/api/src/capabilities/academy-curriculum.js`)
Library: `create_academy_methodology`, `publish_academy_methodology_version`, `list_academy_methodologies`, `get_academy_methodology`.
Curricula: `create_academy_curriculum`, `save_academy_curriculum_draft`, `get_academy_curriculum_readiness`, `submit_academy_curriculum_version`, `decide_academy_curriculum_version`,
`publish_academy_curriculum_version`, `list_academy_curricula`, `get_academy_curriculum`, `rollover_academy_curriculum`, `assign_academy_curriculum`, `end_academy_curriculum_assignment`,
`record_academy_curriculum_review`, `acknowledge_academy_curriculum_version`, `submit_/list_/resolve_academy_curriculum_feedback`.
Sessions: `get_academy_session_objectives`, `map_academy_session_objectives`, `load_academy_session_objectives_into_plan`, `record_academy_session_objective`,
`get_academy_objective_plan` / `apply_academy_objective_plan` (forward planner), `get_academy_curriculum_coverage`, `export_academy_curriculum_coverage`, `get_my_academy_curriculum`.

Rules enforced on the server:
- Governance writes need `curriculum` access (owner/admin or an active engagement holding it, read live). Coaches read the library and the curricula assigned to their groups only. Outsiders get 404.
- A version cannot be submitted with blockers (no objectives, an objective without success criteria, overlapping or unknown phases). Warnings travel with the request. The submitter cannot approve their own version unless an owner/admin (then recorded `self_approved`).
- A version cannot take effect in the past, and must start after the version it replaces. Sessions already planned keep the wording they were planned with.
- "Delivered" needs a completed block tagged to the objective in the coach's record, or a written attestation (flagged `attested`). Partly / not delivered need a deviation reason.
- Guardian access to a young athlete's groups needs a verified guardian link and is audited. Feedback, exports, reviews and every write are audited.

## Sports coverage
The library is sport-agnostic structure (pillars, stages, game-model phases, drills) that each academy fills in for **every sport it teaches**. A test walks the whole `sports` catalogue and
creates and publishes a methodology for each one. No sport has a silent default and nothing here is a scoring model; measurement stays in Coach Performance Studio rubrics (a competency or objective may point at a rubric dimension).
Native: all catalogue sports (as configuration). Labelled fallback: none. Gap: sport-specific starter templates are intentionally not shipped (no seed data).

## UX and platforms
Academy → **Curriculum** (Coverage board, Planner, Curricula, Methodology), an academy-session **Curriculum** tab, and a family block on the Progress tab. One React Native codebase; layouts adapt phone → tablet → desktop;
touch targets ≥ 44pt; accessible labels. Verified with the web build at phone, tablet and desktop widths. **Not run on a physical iOS/iPadOS/Android device** from this environment.

## Languages
All new text uses `t()` with `cur.*` keys in `en.js` and the 11 packs (ta, te, ml, mr, kn, bn, or, hi, si, ur, id). Packs other than English are machine-drafted and stay `reviewed: false` until a native speaker signs them off.
