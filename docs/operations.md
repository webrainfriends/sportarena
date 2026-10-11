# Operations

Runbook and capacity notes. Sections are added by the durable-processing work (#61): this slice covers
password hashing and pilot-load targets; job processing, worker health and metrics are added by the later slices.

## Password hashing (non-blocking)

* Algorithm and stored format are unchanged: `scrypt$<salt>$<hash>` (N=16384, r=8, p=1, 64-byte key). Every
  existing hash verifies; new hashes are byte-compatible with the old `scryptSync` output.
* `hashPassword` / `verifyPassword` (`apps/api/src/crypto.js`) are **async** and run scrypt on the libuv thread
  pool, so the event loop keeps serving other requests during a login burst.
* A semaphore bounds concurrent derivations (each holds ~16 MiB and a pool thread). When more than
  `HASH_MAX_QUEUE` callers are already waiting, the request fails fast with **503 `busy`** and a `Retry-After`
  header rather than queueing without limit.
* Unknown emails still pay one full verification (a lazily created decoy hash) so timing does not reveal accounts.

| Variable | Default | Meaning |
|---|---|---|
| `HASH_CONCURRENCY` | `2` | Max scrypt derivations running at once. Set to roughly the number of spare CPU cores (keep `UV_THREADPOOL_SIZE` >= this + 2 for DNS/fs). |
| `HASH_MAX_QUEUE` | `64` | Max logins waiting for a free slot before 503. |

## Pilot-load targets

| Target | Value |
|---|---|
| Sustained logins | >= 20 /s per API process on 4 vCPU |
| Burst | 50 simultaneous logins complete in < 1.5 s p95 with `HASH_CONCURRENCY=2`, no 503 |
| Event-loop stall during a login burst | < 50 ms (max) |
| Other API requests during a burst | unaffected (no stall) |

### Measured (`node scripts/measure-login.mjs 50 <concurrency>`, 4 vCPU sandbox, Node in-process, no DB/HTTP)

| Mode | Concurrency | Wall | Throughput | Login p50 / p95 | Max event-loop stall |
|---|---|---|---|---|---|
| Old `scryptSync` | n/a | 2.2 s | 22.7 /s | 1152 / 2073 ms | **2193 ms** (loop frozen for the burst) |
| Async, bounded | 2 | 1.18 s | 42.4 /s | 621 / 1131 ms | 4 ms |
| Async, bounded | 4 | 0.79 s | 63.5 /s | 406 / 763 ms | 4 ms |

Burst-of-50 p95 at concurrency 2 (1131 ms) meets the target; the loop stall dropped from ~2.2 s to ~4 ms.
Numbers are from a shared sandbox; re-run the script on the production host before relying on them. It measures
the CPU-bound hashing path only, not network or database time.

## Durable background processing

### Why PostgreSQL and no external queue
The facts that decide what must happen (unpaid holds, credit notes to refund, queued deliveries) already live in PostgreSQL.
A job row can therefore be written in the **same transaction** as the business change (transactional outbox), claimed with
`FOR UPDATE SKIP LOCKED` (no double processing across API/worker instances), and backed up and restored with everything else.
Redis/SQS/BullMQ would add a second source of truth to reconcile and another thing to run and monitor. Revisit if sustained
throughput passes a few hundred jobs per second or work needs sub-second latency.

### Pieces
| Piece | Where | Behaviour |
|---|---|---|
| `jobs` table | migration `057_durable_jobs.sql`, `src/jobs.js` | `queued` -> `running` (lease) -> `succeeded` / back to `queued` with backoff / `dead`. Unique `(kind, dedupe_key)` makes enqueue idempotent. |
| Claiming | `claimJobs` | `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`; sets lease (`leased_until`, default 5 min) and increments `attempts`. Only the lease holder may complete/fail a job. |
| Crash recovery | lease expiry | A worker that dies after claiming leaves `running` with an expiring lease; the next claim re-runs it. Handlers must be idempotent. |
| Backoff | `backoffMs` | `base * 2^(attempt-1)`, capped, then 50-100% jitter. Used by jobs, email/push deliveries and refunds. |
| Dead letters | `status='dead'` | Jobs, email/push deliveries and credit-note refunds that exhaust their attempts are recorded as dead jobs (`refund.credit_note`, `email.delivery`, `push.delivery`, `notify.retry`). |
| Admin | `GET /admin/jobs`, `POST /admin/jobs/:id/requeue` (MCP: `list_jobs`, `requeue_job`) | Admin only. Payloads are never returned; each row shows the id of the record it concerns. Requeue resets the source record (invoice / delivery) with a fresh attempt budget, or re-queues the job. Audit-logged. |

### Category isolation
`maintenanceCycle` runs holds, refunds, waitlist, loyalty, plans, alerts, quotes, renewals and then notifications (reminders,
notification retries, push, email), each in its own try/catch. A failing step is logged and returned under `errors.<category>`;
the rest still run. Holds are additionally isolated per reservation.

### Notifications can no longer undo money movement
`notify()` called inside a caller's transaction writes in a `SAVEPOINT`. If the notification cannot be stored, only that is rolled
back, the hold release / refund bookkeeping commits, and a durable `notify.retry` job is written to try again with backoff.
Reminders (bookings, appointments, follow-ups) set their sent-marker in the same transaction as the notification (rows locked with
`SKIP LOCKED`), so a crash can no longer mark a reminder sent without sending it.

### Refunds: no double money movement
Before the provider is called, a `refund_intents` row stores the exact amount and idempotency key. A retry after any crash reuses
both (the provider treats the repeated key as a no-op); the intent is flipped to `recorded` and `payments.refunded_cents` increased
in one transaction. A failed refund backs off (`invoices.refund_next_attempt_at`); after 6 attempts it becomes `failed` and a dead
job appears for admins. Credit notes stuck at the attempt limit after a crash are dead-lettered too.

### Email and push deliveries
Claimed with `SKIP LOCKED` plus a 5-minute lease, exponential backoff (`next_attempt_at`), 5 attempts, then `failed` + dead job.
An email bridge outage never blocks holds or refunds (separate step, reported as `failed` counts).

### Residual limitations
* Holds, waitlist, loyalty, plans, alerts and quotes remain state-driven sweeps over their own tables (their rows already are the
  durable queue, with atomic SQL claims); only retries, outbox and dead letters use the `jobs` table.
* Maintenance still runs inside the API process by default. A separate worker process, graceful shutdown, worker health and
  metrics are delivered in the follow-up operations slice.
* Job lag figures are available via `jobStats()`; they are not yet exposed through an endpoint.
