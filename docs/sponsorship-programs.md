# Sponsorship programs and funding rounds (#284)

A **program** is a sponsor brand's funding container: objective, budget in one currency, sports, regions, eligibility, dates,
award caps, an owner and optional recurring rounds. Applicants apply to an **open round**; an **award** becomes an ordinary
`sponsorships` row (see [sponsorship-agreements.md](sponsorship-agreements.md)), so terms, obligations, payments and history stay
in their existing tables. There is no second ledger and no second identity system.

## Lifecycle
| Program | Allowed next |
|---|---|
| `draft` | `published` (needs at least one round), `archived` |
| `published` | `closed` |
| `closed` | `published`, `archived` |
| `archived` | final |

Closing or archiving a program closes all its rounds. A round is `scheduled` before `opens_on`, `open` through `closes_on`, and
`closed` after that date or once closed explicitly. Nothing is ever deleted; programs and rounds stay on record.

## Capabilities (REST + OpenAPI + MCP from one definition, `capabilities/sponsorship-programs.js`)
| Capability | Route | Who |
|---|---|---|
| `create_sponsorship_program` | `POST /sponsorship-programs` | brand manager, approver |
| `update_sponsorship_program` | `PATCH /sponsorship-programs/:id` (`version`) | manager, approver |
| `set_sponsorship_program_status` | `POST /sponsorship-programs/:id/status` (`version`) | manager, approver |
| `list_sponsorship_programs` / `get_sponsorship_program` | `GET /sponsorship-programs[/:id]` | any brand-wide sponsor role |
| `create_program_round` / `update_program_round` / `close_program_round` | `POST /sponsorship-programs/:id/rounds`, `PATCH /program-rounds/:id`, `POST /program-rounds/:id/close` | manager, approver |
| `schedule_program_rounds` | `POST /sponsorship-programs/:id/schedule-rounds` | manager, approver |
| `list_funding_opportunities` | `GET /funding-opportunities` | any signed-in user (published programs with an open round; no budget shown) |
| `apply_to_program_round` | `POST /program-rounds/:id/applications` | the owner of the athlete, team or event applied for |
| `withdraw_program_application` / `list_my_program_applications` | `POST /program-applications/:id/withdraw`, `GET /my/program-applications` | the applicant |
| `list_program_applications` | `GET /sponsorship-programs/:id/applications` | brand staff |
| `decide_program_application` | `PATCH /program-applications/:id` | manager, approver |
| `export_program_awards` | `GET /sponsorship-programs/:id/awards-export` | manager, finance, auditor (audit-logged) |

## Rules
* **Closing a round blocks submissions.** Submit and close both take the program and round `FOR UPDATE` locks in the same order, so a
  submission racing a close is either accepted before it or rejected after it. A round past its closing date rejects too.
* **Submitted terms never change.** An application stores `terms_snapshot` (program and round terms) and `round_terms_version`.
  Editing a round writes a new version into the append-only `sponsorship_round_terms`; only later applications use it.
* **Awards reference their program.** `sponsorships.program_id`, `round_id` and `application_id` are set; the award is a *proposed*
  sponsorship with one structured one-off money line (due on the program start, or the award day if it has begun), so the recipient
  accepts an exact version and the existing obligation and payment flow applies. No consent, payment or delivery is assumed.
* **Caps under lock.** Awarding needs the current `program_version` (409 if stale) and checks award size, `max_awards`, program and
  round budget remaining and currency equality. Concurrent awards cannot overshoot. A budget or count cannot be lowered below what is
  already awarded, and the currency is fixed once an award exists.
* **Stale versions.** Programs and rounds carry `row_version`; an edit with an old version is rejected with 409 and the latest
  version number.
* **Eligibility.** Target type, sport, verified-only, and region (checked where a region is on record). Staff of the sponsoring
  brand cannot apply to its own program. Athletes under the age of independence are rejected: a guardian-led process is not wired here.
* **Tenant isolation.** Staff access comes from live `organisation_members` roles (new action `program` in `sponsor-access.js`,
  `sponsorBrandSql` for lists); department-scoped members have no brand-wide program access. Applicants see only their own
  applications and published programs with an open round, never the budget or balance. Exports are scoped to the program's brand.

## Data (migration `088_sponsorship_programs.sql`, additive)
New tables `sponsorship_programs`, `sponsorship_rounds`, `sponsorship_round_terms`, `sponsorship_applications` (unique live
application per round and target; CHECK constraints on money, counts and dates) and nullable columns on `sponsorships`. Existing
agreements and financial history are untouched. No `ON DELETE CASCADE`.

## App
**More → Sponsors → Funding programs.** *Funding opportunities* (applicants: search, sport filter, apply, my applications, withdraw)
and *Run programs* (brand staff: list by status, program page with budget bar, rounds, applications, award/decline, CSV export).
Forms use pickers: currency, money, sports, regions, date range, steppers, switches and chips. Every screen has loading, empty,
denied, stale-version and retry states; awards show on the deal screen as "Awarded from the program …".

## Screens (web build against a local API; phone and desktop widths)
| | |
|---|---|
| Sponsors hub, Funding programs section | `docs/ux/sponsorship-programs-1-sponsors-hub.png` |
| Programs list and empty state | `…-2-programs-list.png`, `…-10-empty-state.png` |
| Program page: budget, rounds, applications | `…-3-program-detail.png`, `…-12-program-desktop.png` |
| Award sheet and result | `…-4-award-sheet.png`, `…-5-after-award.png` |
| Funding opportunities, apply, my applications | `…-6-funding-opportunities.png`, `…-7-apply-sheet.png`, `…-8-my-applications.png`, `…-9-funding-opportunities-desktop.png` |
| Stale-version message on save | `…-11-stale-version.png` |

## Dependency order and limits
* Builds on #283 (workspace roles) and #145 (agreement operations). #67 (opportunities/applications) is not on main; this ships its own
  program-scoped applications and should be reconciled with it when that lands. #71 (settlement) is untouched: payments still go
  through `report_sponsorship_payment`. #243 (email) and #249 (branded documents) are not wired; notifications are in-app only.
* Youth applicants and guardian consent are out of scope (rejected, see above).
* Recurring rounds are created on request by `schedule_program_rounds` (idempotent); there is no background job.

## Migration, rollback and recovery
Migration is additive; rollback = deploy the previous code (new tables and nullable columns stay unused). Never drop them. A mistaken
program is archived, not deleted. A mistaken award is handled by the recipient declining or either side ending the resulting agreement.
