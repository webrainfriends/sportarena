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
