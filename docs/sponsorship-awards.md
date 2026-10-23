# Award approvals and conditional sponsorship offers (#289)

An award is now a **governed stage** between "the brand decided to fund an application" and "the recipient accepted exact terms".
It reserves budget, collects the sign-offs the program requires, is issued as a letter with an expiry, and only the recipient's
acceptance of one exact offer version creates the **single canonical agreement** (an ordinary `sponsorships` row, with its
obligations). No payment, consent or completed delivery is inferred from an award, an acceptance or a condition.

Flow: `decide_program_application(award)` -> award `pending_approval` (or `waitlisted`) with a **held reservation** -> sign-offs
(`approver` / `finance` / `legal`) -> `approved` -> `issue_program_award` -> `issued` (letter + expiry) -> recipient
`respond_to_program_award(accept, offer_version)` -> `accepted` + one agreement. With no sign-off required the offer is issued at once.
`declined`, `expired`, `withdrawn` and `rejected` release the reservation and offer the freed budget to the waitlist.

## What changed (migration `092_sponsorship_awards.sql`, additive)
| Table / column | Purpose |
|---|---|
| `sponsorship_programs.award_approval_cents`, `finance_signoff_cents`, `legal_signoff_required`, `offer_validity_days`, `waitlist_enabled` | the approval rules. Defaults (no thresholds, 14 days, no waitlist) keep today's behaviour. |
| `sponsorship_awards` | one **live** award per application (partial unique index); `offer_version`, `row_version`, `expires_at`, `letter`, `issue_key`, `waitlist_rank`, `sponsorship_id` (unique: one agreement per award). |
| `sponsorship_award_approvals` | sign-offs per `(award, offer_version, step)`; changing the offer starts a new version and needs fresh sign-offs. |
| `sponsorship_award_conditions` | conditions with an optional due date and "must be met before payment"; editing retires rows (`removed_at`), never deletes. |
| `sponsorship_award_reservations` | the only reservation ledger; `UNIQUE(award_id)` so a retry cannot reserve twice; `held` -> `released` / `converted`. |
| `sponsorship_award_events` | append-only history. |
| unique index `sponsorships_one_per_application` | the database itself refuses a second agreement for one application. |

Budget used = accepted awards (`sponsorship_applications.status='awarded'`) **plus** `held` reservations, per program and per round, so
existing awards keep counting exactly as before. Existing awards already have their agreement and are not rewritten; there is no
backfill into `sponsorship_awards`. **Behaviour change:** awarding an application no longer creates a `proposed` agreement; the agreement
is created by the recipient's acceptance. The application stays `submitted` until then.

Rollback: deploy the previous code. New columns have defaults and the new tables are unused by it. An award still pending at rollback never
created an agreement; its application is still `submitted` and can be decided again. Nothing was dropped, rewritten or deleted.

## Capabilities (REST + OpenAPI + MCP from one definition)
| Capability | Who | Notes |
|---|---|---|
| `decide_program_application` (`PATCH /program-applications/:id`) | brand manager/approver | `award` now starts an award: checks size, program/round budget and counts under lock, reserves, or waitlists when the program has a waitlist (otherwise 409 as before). A second decision on an application with a live award -> 409. |
| `update_sponsorship_program` | brand manager/approver | the approval rules above. |
| `get_program_award_summary` (`GET /sponsorship-programs/:id/award-summary`) | any brand role | total / accepted / reserved / free, waitlist count, rules in force. |
| `list_program_awards` (`GET /sponsorship-programs/:id/awards`) | any brand role | filter `round_id`, `status`; `ORDER BY created_at DESC, id`. |
| `get_program_award` (`GET /program-awards/:id`) | brand staff; the recipient | staff see sign-offs, reservation, history; the recipient sees the issued offer, conditions and letter only. Anyone else 404. |
| `update_program_award` (`PATCH`) | manager/approver | amount and/or conditions; needs `row_version` (409); bumps `offer_version`, voids sign-offs, takes back an issued offer. |
| `decide_award_approval` (`POST /program-awards/:id/approvals`) | role per step: `award_approve` (manager, approver), `award_finance` (finance), `award_legal` (legal) | needs `offer_version`; the proposer can never sign; a rejection closes the award and releases the budget. |
| `issue_program_award` (`POST .../issue`) | manager/approver | `idempotency_key` required; 422 while a sign-off is missing or the budget is not held; same key = same result, no double reserve or notification. |
| `withdraw_program_award` | manager/approver | before acceptance only; the application returns to the undecided pile. |
| `respond_to_program_award` (`POST .../respond`) | the applicant or owner of the funded target | `accept` names the exact `offer_version` (409 if revised) and is refused after expiry; creates the one agreement, converts the reservation. `decline` releases the budget and withdraws the application. |
| `meet_award_condition` | manager/approver | only the brand marks a condition met, after acceptance. |
| `list_my_program_awards` (`GET /my/program-awards`) | recipient | issued, accepted, waitlisted, declined, expired only; internal stages are hidden. |
| `export_program_awards` | manager/finance/auditor | now includes award status and offer version for every award, audit-logged. |

Expiry: the worker step `sponsor_awards` (`expireAwards`, in `apps/api/src/sponsorship-awards.js`) closes issued offers past `expires_at`;
reads and acceptance also expire a stale offer first, so an expired offer can never be accepted. Releasing is a conditional update
(`WHERE status='held'`), so repeats and parallel workers are harmless. The freed budget is offered to the waitlist in rank order (first that fits).

Concurrency: locks are always taken program -> round -> application -> award, so concurrent decisions on one budget serialise.

## Authorization and tenant isolation
Every brand capability loads the program and checks `sponsorAccess` for **that** brand and the sponsor action for the step; another brand gets
403/404 on reads, writes, exports and sign-offs. Finance cannot edit; legal cannot approve as finance. The recipient only ever reaches their own offers.

## Dependency order
Programs (#284) -> calls (#285) -> forms (#286) -> evaluation (#288) -> this. Agreement operations (#145) and payments (#71) consume the
resulting agreement unchanged. Not delivered here: branded award-letter documents (#249; the letter is a plain-text snapshot stored per
issued version) and e-mail delivery of notices (#243; in-app notifications are used).

## App journey
Brand: Program -> **Awards** (budget bar, filters, sign-off progress; open an award to approve/reject, edit amount and conditions, issue, withdraw).
Recipient: Sponsorship calls -> **Funding offers** (review the letter and conditions, accept the shown version, or decline). States covered:
loading, empty, denied/recoverable error with retry, stale version banner, expired and waitlisted offers.

## Tests
`apps/api/test/sponsorship-awards.test.js` (PostgreSQL): thresholds and sign-off roles, over-budget refusal, rejection releases budget,
retried and concurrent issue, exact-version acceptance and double accept, expiry + waitlist promotion + repeat-safe worker, decline/withdraw,
tenant isolation and deterministic paging, additive repeatable migration.
