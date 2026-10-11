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

## History (append-only)

`engagement_status_history` (migration 043) is one shared table for appointments (`kind='appointment'`) and hires
(`kind='hire'`). Triggers on `appointments` and `coach_hires` write a row on every insert and every status change, so no
code path can skip it, and the row is in the same transaction as the change (a rolled-back or refused move leaves
nothing). `update_appointment` / `update_hire` call `setTransitionContext` so the trigger records the actor and the
optional `reason` (max 500 characters). The reason is encrypted (`status_history.reason`) because it can mention health
details. Creation is attributed to the booking person; the expiry sweep records no actor (`by_system`). Rows cannot be
updated, deleted or truncated (trigger). Existing rows got one backfilled entry (`backfilled=true`) carrying their
current status; the backfill is idempotent.

Timelines: `get_appointment_timeline` (`GET /appointments/:id/timeline`) and `get_hire_timeline`
(`GET /hires/:id/timeline`), paginated (`limit`, `offset`), ordered by time then sequence. Only the two parties can read
them (403 otherwise); decrypting reasons is audit-logged (`read_clinical`).

## Refunds

A cancel of a paid item refunds through the canonical `payments` record with a deterministic idempotency key
(`<purpose>-<id>-cancel-<payment id>`, sent to Stripe / PayPal), while the engagement row is locked. Concurrent cancels
serialise on the lock: one wins, the others get 409, and the provider is called once; if the provider refuses, nothing is
cancelled. A repeated refund attempt also finds no remaining `paid` payment. Notifications are inserted inside the same
transaction (so they exist only for committed transitions) and push delivery is dispatched after commit.

## Migration and rollback

`043_engagement_status_history.sql` adds one table, triggers and a backfill; rollback: drop the two status triggers (the table can stay, it holds history).
`042_expired_status.sql` only widens the two status CHECK constraints to include `expired`; no row is touched.
Rollback: no data uses `expired` until the sweep has run; to revert, move any `expired` rows to `cancelled` first, then
restore the old CHECK constraints.

## Limitations

* The provider refund still runs inside the database transaction (under the row lock). If the transaction fails after
  the provider accepted the refund, the payment record already says `refunded`, a retry finds nothing left to refund and
  the key prevents a double refund; the engagement is then cancelled on retry. The UI for the timeline is delivered in
  57-1c.
* Status changes made by `update_followup` (appointments) are recorded with no actor.
