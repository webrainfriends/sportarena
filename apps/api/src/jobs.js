// Durable jobs: a PostgreSQL-backed outbox / retry queue / dead-letter registry.
//
// Why PostgreSQL and not Redis/SQS/BullMQ: the data that decides what must happen (holds, refunds, deliveries) already
// lives in PostgreSQL, so a job row can be written in the SAME transaction as the business change (transactional outbox),
// claiming uses FOR UPDATE SKIP LOCKED (no double processing across instances), and one datastore keeps backup, restore
// and failure modes simple at pilot scale. A broker would add a second source of truth to reconcile. Revisit if sustained
// throughput exceeds a few hundred jobs/second (see docs/operations.md).
//
// Lifecycle: queued -> running (lease) -> succeeded | queued (backoff) | dead.
// A worker that crashes after claiming leaves status='running' with an expiring lease; the next claim picks it up.
import { randomUUID } from 'node:crypto';
import { pool } from './db.js';
import { logger, runWithContext } from './logger.js';
import { inc } from './metrics.js';

export const WORKER_ID = `${process.pid}-${randomUUID().slice(0, 8)}`;
export const DEFAULT_LEASE_SECONDS = 300;

/** Exponential backoff with jitter: base * 2^(attempt-1), capped, then 50-100% of that. */
export function backoffMs(attempt, { baseMs = 30_000, capMs = 3_600_000, random = Math.random } = {}) {
  const raw = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(raw * (0.5 + random() * 0.5));
}

const clip = (e) => String(e?.message ?? e).slice(0, 300);

/** Idempotent enqueue (pass the transaction client to make it part of the caller's transaction). Returns the row, or null if it already existed. */
export async function enqueue(db, { category, kind, payload = {}, dedupeKey = null, runAt = null, maxAttempts = 6 }) {
  const r = await (db ?? pool).query(
    `INSERT INTO jobs(category, kind, payload, dedupe_key, run_at, max_attempts) VALUES ($1,$2,$3,$4,coalesce($5, now()),$6)
     ON CONFLICT (kind, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING *`,
    [category, kind, payload, dedupeKey, runAt, maxAttempts]);
  return r.rows[0] ?? null;
}

/** Park something that exhausted its retries so an admin can see and requeue it. Re-failing the same item refreshes the same row. */
export async function recordDead(db, { category, kind, dedupeKey, payload = {}, error, attempts = 0 }) {
  const r = await (db ?? pool).query(
    `INSERT INTO jobs(category, kind, payload, dedupe_key, status, attempts, last_error, dead_at)
     VALUES ($1,$2,$3,$4,'dead',$5,$6,now())
     ON CONFLICT (kind, dedupe_key) WHERE dedupe_key IS NOT NULL
     DO UPDATE SET status='dead', attempts=EXCLUDED.attempts, last_error=EXCLUDED.last_error, dead_at=now(), updated_at=now(), finished_at=NULL
     RETURNING *`,
    [category, kind, payload, dedupeKey, attempts, clip(error)]);
  return r.rows[0];
}

/** Atomically claim due jobs (and jobs whose lease expired). Safe from many workers at once. */
export async function claimJobs(category, { limit = 10, workerId = WORKER_ID, leaseSeconds = DEFAULT_LEASE_SECONDS, db } = {}) {
  const r = await (db ?? pool).query(
    `UPDATE jobs SET status='running', attempts=attempts+1, claimed_by=$2, leased_until=now() + make_interval(secs => $3), updated_at=now()
      WHERE id IN (SELECT id FROM jobs WHERE category=$1
                      AND ((status='queued' AND run_at <= now()) OR (status='running' AND leased_until < now()))
                    ORDER BY run_at, id LIMIT $4 FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [category, workerId, leaseSeconds, limit]);
  return r.rows;
}

/** Only the current lease holder may finish a job; a stale worker is ignored. */
export async function completeJob(job, db) {
  const r = await (db ?? pool).query("UPDATE jobs SET status='succeeded', finished_at=now(), leased_until=NULL, last_error=NULL, updated_at=now() WHERE id=$1 AND status='running' AND claimed_by=$2 RETURNING id", [job.id, job.claimed_by]);
  return r.rowCount > 0;
}

/** Retry later with backoff, or dead-letter once attempts are used up. Returns 'retry' | 'dead' | 'stale'. */
export async function failJob(job, error, { db, backoff = backoffMs } = {}) {
  const d = db ?? pool;
  if (job.attempts >= job.max_attempts) {
    const r = await d.query("UPDATE jobs SET status='dead', dead_at=now(), leased_until=NULL, last_error=$3, updated_at=now() WHERE id=$1 AND status='running' AND claimed_by=$2 RETURNING id", [job.id, job.claimed_by, clip(error)]);
    return r.rowCount ? 'dead' : 'stale';
  }
  const r = await d.query(
    "UPDATE jobs SET status='queued', run_at=now() + make_interval(secs => $4), leased_until=NULL, last_error=$3, updated_at=now() WHERE id=$1 AND status='running' AND claimed_by=$2 RETURNING id",
    [job.id, job.claimed_by, clip(error), backoff(job.attempts) / 1000]);
  return r.rowCount ? 'retry' : 'stale';
}

/**
 * Claim and run jobs of one category. `handlers[kind](payload, job)` must be idempotent (a job can run again after a crash).
 * One failing job never stops the others.
 */
export async function runJobs(category, handlers, opts = {}) {
  const out = { claimed: 0, succeeded: 0, retried: 0, dead: 0 };
  for (const job of await claimJobs(category, opts)) {
    out.claimed++; inc('jobs_claimed_total'); inc('job_attempts_total');
    const handler = handlers[job.kind];
    await runWithContext({ job_id: job.id }, async () => {
      try {
        if (!handler) throw new Error(`no handler for ${job.kind}`);
        await handler(job.payload, job);
        if (await completeJob(job)) { out.succeeded++; inc('jobs_succeeded_total'); }
      } catch (e) {
        const res = await failJob(job, e, opts).catch(() => 'stale');
        if (res === 'retry') { out.retried++; inc('jobs_retried_total'); } else if (res === 'dead') { out.dead++; inc('jobs_dead_total'); }
        logger.warn('job failed', { category, kind: job.kind, attempt: job.attempts, outcome: res, error: clip(e) });
      }
    });
  }
  return out;
}

// ---- admin: list + requeue --------------------------------------------------------------------
/** Kinds whose source of truth lives elsewhere: requeue resets that record and marks the job 'requeued'. */
export const requeueHooks = {};

export async function listJobs({ status, category, limit = 25, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, category, kind, status, attempts, max_attempts, run_at, last_error, created_at, updated_at, dead_at, finished_at,
            coalesce(payload->>'invoice_id', payload->>'delivery_id', payload->>'user_id') AS subject_id
       FROM jobs WHERE ($1::text IS NULL OR status=$1) AND ($2::text IS NULL OR category=$2)
      ORDER BY coalesce(dead_at, updated_at) DESC, id LIMIT $3 OFFSET $4`, [status ?? null, category ?? null, limit, offset]);
  return rows;
}

export async function requeueJob(id) {
  const job = (await pool.query("SELECT * FROM jobs WHERE id=$1", [id])).rows[0];
  if (!job) return { error: 'not_found' };
  if (job.status !== 'dead') return { error: 'not_dead' };
  const hook = requeueHooks[job.kind];
  if (hook) {
    await hook(job.payload);
    return { job: (await pool.query("UPDATE jobs SET status='requeued', updated_at=now() WHERE id=$1 RETURNING *", [id])).rows[0] };
  }
  return { job: (await pool.query("UPDATE jobs SET status='queued', attempts=0, run_at=now(), dead_at=NULL, leased_until=NULL, claimed_by=NULL, updated_at=now() WHERE id=$1 AND status='dead' RETURNING *", [id])).rows[0] };
}

/** Queue health numbers (used by metrics/health in the operations slice). */
export async function jobStats() {
  const { rows } = await pool.query(
    `SELECT category, status, count(*)::int AS n, coalesce(max(extract(epoch FROM now() - run_at)) FILTER (WHERE status='queued' AND run_at <= now()), 0)::int AS oldest_due_seconds
       FROM jobs GROUP BY category, status ORDER BY category, status`);
  return rows;
}
