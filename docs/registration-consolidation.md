# Registration consolidation and data backfill plan (#575 follow-up)

Goal: one registration engine (`rx_*`, see `registration-engine.md`) for every participant registration, without losing or rewriting any existing data.
Delivery is staged so each step is reversible and verifiable.

## Scope, and what is deliberately left out
| Flow | Tables | Decision |
|---|---|---|
| Competition roster registration (#477) | `reg_registrations`, `reg_history`, windows, exceptions, snapshots | Mirrored (stage A), single home later (stage B) |
| Academy admissions | `academy_applications`, `academy_application_events` | Mirrored (stage A), single home later (stage B) |
| Sponsorship applications | `sponsorship_applications` and related | **Not moved.** They are applications for money *from* a sponsor (awards, budgets, committees, payouts), not a participant registering. They already share the one question model; moving rows would mix money directions. Revisit only if the maintainer wants it. |

## Stage A (this change): additive mirror, legacy stays the writer
1. Migration `130_registration_mirror.sql` adds `legacy_type`/`legacy_id` to `rx_programmes`, `rx_entries`, `rx_history`, widens the entry status check (`suspended`, `expired`), and replaces two index definitions so mirror rows cannot collide with native ones. No table is dropped, truncated or rewritten; the legacy tables are only read.
2. **Backfill** runs inside the migration with the same SQL functions the live triggers use (`rx_mirror_roster`, `rx_mirror_academy`, `rx_mirror_history`). It is idempotent (upserts keyed on the legacy id), so re-running it repairs gaps and never duplicates.
3. **Live sync**: `AFTER INSERT/UPDATE` triggers on the legacy tables mirror each change in the same transaction. A mirror failure is a warning, never a failed legacy write.
4. **Mapping**
   - Roster: `registered`→`approved`; `submitted`, `under_review`, `rejected`, `withdrawn`, `suspended`, `expired` keep their names. Team, player, registration number, decision time and history are carried.
   - Academy: `enquiry`/`trial_*`/`application_draft`→`draft`; `submitted`→`submitted`; `under_review`/`offered`→`under_review`; `waitlisted`→`waitlisted`; `offer_accepted`/`enrolled`→`approved`; `declined`→`rejected`; `withdrawn`/`cancelled`→`withdrawn`; `expired`→`expired`. The exact stage stays in the legacy table.
   - Not copied: free-text answers and notes (they are encrypted with the legacy module's own keys), and money (academy charges stay in `academy_charges`, paid through `academy_charge`).
5. Mirror programmes are closed and mirror entries are read-only in the engine (`409 managed_elsewhere`); screens show "Managed in the event console / academy admissions" with a link.
6. **Verification**: `GET /admin/registration-mirror` (platform admin) reports legacy rows, mirrored rows, missing rows, status mismatches and unmirrored history. Sign-off for stage B needs `in_parity: true` on production.

## Stage B (needs maintainer approval, separate PRs)
1. Run the parity report on production; fix any gaps by re-running the backfill functions.
2. Per flow: make the engine the writer (capabilities call the engine; the legacy tables are kept and updated by the engine's write path), move its screens onto the engine screens, keep every old REST route as a thin alias for one release.
3. Retire duplicate screens and routes only after a full release with parity, still without deleting data.

## Rollback
Stage A: drop the four triggers; mirror rows are derived data and are ignored. Nothing else depends on them.
