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

## In the app (mobile and web)

* **Health > Appointments** (`screens/hub.js`) and **My coaching / Coach desk** (`screens/coaching.js`) show a
  **History** button on every appointment and session. It opens `TimelineSheet` (`src/Timeline.js`), which reads
  `get_appointment_timeline` / `get_hire_timeline` and shows who did what and when, the reason, and a refund note.
  States: loading, empty ("Nothing recorded yet"), error with Try again. Both parties see the same entries.
* **Cancel / decline** asks for an optional reason in the shared `Confirm` sheet (`askReason`); it is sent as `reason`.
  The confirm text says whether the payment is refunded. A refused move (409) shows the server's plain-language message.
* **Complete** on an appointment is only offered once the start time has passed (the server enforces it too).
* Accessibility: `Btn` now exposes `accessibilityRole="button"`, a label (default: its title) and busy/disabled state;
  `Field` labels its input; timeline entries are single labelled items. Touch targets keep the existing 40 px minimum.
* Verified: `expo export --platform web` bundles (484 modules); the app JSX-name and route tests pass. Not verified:
  a native device run or a browser walk-through (no device or browser in this environment).

## Migration and rollback

`043_engagement_status_history.sql` adds one table, triggers and a backfill; rollback: drop the two status triggers (the table can stay, it holds history).
`042_expired_status.sql` only widens the two status CHECK constraints to include `expired`; no row is touched.
Rollback: no data uses `expired` until the sweep has run; to revert, move any `expired` rows to `cancelled` first, then
restore the old CHECK constraints.

## Payment after the engagement is final

`payments/service.js` only fulfils a hire or appointment that is still `requested` or `confirmed`. A checkout opened
earlier and paid after the engagement expired, completed or was cancelled is therefore not applied: `settle` records the
payment as paid, sees `fulfil` return false and refunds it straight away (once; a repeat confirm or webhook finds the
payment already settled). The engagement keeps its final status and `payment_status`. A webhook racing a cancel ends the
same way whichever wins: the cancel refunds a payment that landed first, or the settle refunds one that lands after.

## External bookings

`reconcile_external_booking` brings a provider-reported status into the matching appointment through the same
`assertTransition` rules as `update_appointment` (state map, payment, start time, judged against the reported start
time) and `setTransitionContext`, so the timeline shows the provider as the actor with the reason
"Reported by the provider's booking system". A refused move changes nothing, records no history and marks the appointment
`external_sync_status='error'`.

## Limitations

* The provider refund still runs inside the database transaction, under the engagement row lock, so a slow provider holds
  that one row (only that row; nothing else waits on it except a competing change to the same engagement). It was left
  there deliberately: moving it out would need a persisted "refund pending" state to stay safe when the process dies
  between the refund and the status change. What protects the money today: the provider call carries a deterministic
  idempotency key (`<purpose>-<id>-cancel-<payment id>`), a refused refund rolls the whole transaction back (no status
  change, no history row, no notification; tested), and if the transaction fails after the provider accepted the refund,
  the retry reuses the key so the customer is never refunded twice and the engagement then cancels.
* Status changes made by `update_followup` (appointments) are recorded with no actor.
