# Appointment and coaching lifecycle

Health appointments (`appointments`) and coaching hires (`coach_hires`) share one set of rules, implemented in
`apps/api/src/lifecycle.js` and used by the `update_appointment` and `update_hire` capabilities (REST, OpenAPI and MCP).

## States and permitted moves

| From | To | Who | Preconditions |
| --- | --- | --- | --- |
| requested | confirmed | provider (coach / doctor / physio) | not waiting for payment; start time still in the future |
| requested | cancelled | either party | none |
| requested | expired | system only (maintenance sweep) | start time passed without an answer |
| confirmed | completed | provider | payment settled or not required; start time has passed |
| confirmed | cancelled | either party | none |
| completed, cancelled, expired | nothing | nobody | final: no resurrection |

An admin may cancel but never confirm or complete. `expired` cannot be requested through the API (400).
Wrong actor is 403; a move the state or its prerequisites do not allow is 409 with a plain-language reason.

## Concurrency

Both capabilities run in one transaction: the row is read with `SELECT ... FOR UPDATE`, the move is validated against the
locked row, and the `UPDATE` is conditional on the status that was validated (`WHERE id=$1 AND status=$prev`). Two racing
requests therefore serialise: exactly one wins and the other gets 409 (or, for confirm vs cancel, cancel always ends up
the final state). A paid item that is cancelled is refunded through the canonical payment record before the status
changes; if the payment provider refuses, nothing is cancelled.

## Expiry

`maintenanceCycle()` (worker) calls `expireStaleRequests()`: each `requested` row whose `starts_at` is in the past is
locked (`SKIP LOCKED`), refunded if it was paid, set to `expired`, its follow-up / venue link released, and both parties
notified. A refund the provider rejects leaves the row `requested` to be retried on the next cycle.

## Migration and rollback

`042_expired_status.sql` only widens the two status CHECK constraints to include `expired`; no row is touched.
Rollback: no data uses `expired` until the sweep has run; to revert, move any `expired` rows to `cancelled` first, then
restore the old CHECK constraints.

## Limitations

* The append-only history, reason input, timeline capabilities and UI are delivered in follow-up changes
  (57-1b / 57-1c).
* Refund idempotency keys and moving the provider refund out of the database transaction are part of 57-1b; until then
  the refund is still issued under the row lock.
