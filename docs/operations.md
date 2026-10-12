# Operations

Runbook and capacity notes for password hashing, durable background processing, the worker, health and metrics (#61).

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
* In production maintenance runs in the separate worker by default (the deploy sets `WORKER_MODE=external`); the code default for dev/tests is in-process. See "Running the worker" below to move it out.

## Running the worker

Maintenance (holds, refunds, waitlist, loyalty, reminders, retries, email, push) can run in two ways:

| `WORKER_MODE` | Behaviour |
|---|---|
| unset / `inprocess` (code default; dev and tests; production opt-out) | The API process runs the cycle on a timer (every `NOTIFY_INTERVAL_SECONDS`, 0 disables). Fully backwards compatible. |
| `external` | The API does **no** maintenance; run `npm run worker` (`apps/api/src/worker-main.js`, pm2 process `sportarena-worker`). Set it on both processes. |

Claims are atomic in SQL, so a second worker (or an API still running in-process during a rollout) never double-processes.
**Production deploys run the separate worker by default.** `.github/workflows/deploy.yml` forwards `vars.WORKER_MODE || 'external'`,
and `scripts/deploy-remote.sh` writes the effective value to `.env` on every deploy (so API and worker always agree), starts the pm2
process `sportarena-worker` (30 s kill timeout) after the API, and waits up to 20 s for `/health/worker` to answer (a warning, not a
failure, if it does not). Explicit opt-out: set the repository variable `WORKER_MODE=inprocess`; the next deploy writes it, removes
the worker process and the API runs maintenance itself again. Any other value is treated as `external` with a warning. The secret
names are unchanged. This path has been syntax-checked (`bash -n`, YAML parse) but not run against the real host; the first
deploy's "Server report" (`== worker health`, `pm2 ls`) is the evidence to read.

### Graceful shutdown
`SIGTERM` / `SIGINT` (pm2 stop/restart, deploys): the process stops starting new cycles, waits for the cycle in flight (the API also
stops accepting connections and drains), marks its heartbeat `stopped`, closes the database pool and exits 0. A hard timeout (25 s)
forces exit 1. Work interrupted by a crash (SIGKILL, power loss) is recovered by lease expiry, see above.

### Health
* `GET /health/worker` (no auth, for uptime monitors): 200 while a worker has beaten within `WORKER_STALE_SECONDS` (default 180), else 503.
* `get_worker_health` (`GET /admin/worker-health`, admin; also MCP): every worker with last beat, last cycle (duration, errors), cycles /
  failed cycles, per-category last run, runs and failures; job queue depth by category and status; oldest due job (lag); dead letters.
  `healthy=false` when no live worker exists or work is overdue by more than max(`WORKER_STALE_SECONDS`, 300 s).
* Heartbeats live in `worker_heartbeats` (migration 058); rows are kept after a worker stops.

### Logs and correlation ids
All logging goes through `src/logger.js`: one JSON object per line with `ts`, `level`, `msg` plus context.
* HTTP: every response carries `X-Request-Id` (a valid incoming one, 8-64 chars of `A-Za-z0-9._-`, is kept; otherwise generated).
  `ACCESS_LOG=true` (default in production) logs `method`, `path` (no query string), `status`, `ms`, `request_id`.
* Worker: `worker_id` and `cycle_id` on every line of a cycle; `job_id` on every line while a job runs.
* Never logged: request bodies, tokens, passwords, emails, notification text, job payloads. Keys that look sensitive are dropped by the logger.

### Metrics
`get_metrics` (`GET /admin/metrics`, admin; also MCP) returns, for the API process: uptime, memory, event-loop delay (mean, p50, p99, max,
via `monitorEventLoopDelay`), HTTP request/error counts and mean latency, and the password-hashing queue (active, queued, rejected).
It also returns job gauges: depth by category and status, oldest-due lag, open attempts and dead letters. The worker's own counters
(`jobs_claimed_total`, `jobs_succeeded_total`, `jobs_retried_total`, `jobs_dead_total`, `job_attempts_total`, per-category steps with
runs / failures / mean ms) are stored in its heartbeat and shown by `get_worker_health`. Counters are per process and reset on restart.

### Runbook
| Symptom | Check | Action |
|---|---|---|
| `/health/worker` 503 | `pm2 ls`, `pm2 logs sportarena-worker`; the deploy "Server report" prints both | Restart via a deploy (workflow dispatch). If `WORKER_MODE=external` (the production default) but no worker runs, nothing is processed. |
| Reminders / email late | `get_worker_health`: `oldest_due_seconds`, category `failures` | Fix the cause (e.g. `NOTIFY_WEBHOOK_URL`); deliveries retry with backoff by themselves. |
| Dead letters growing | `list_jobs` (status `dead`) | Fix the cause, then `requeue_job` for each; refunds keep their intent so no double refund. |
| Login 503 `busy` | `get_metrics`: `hashing.rejected`, `event_loop_delay_ms` | Raise `HASH_CONCURRENCY` (up to spare cores) or add an API instance. |
| Event-loop delay p99 > 100 ms | `get_metrics` | Look for slow handlers in the access log (`ms`), check CPU. |
