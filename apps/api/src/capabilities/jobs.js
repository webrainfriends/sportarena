// Admin view of the durable job queue / dead-letter registry. Payloads are never returned (they can contain message text);
// each row carries the id of the record it concerns (credit note, delivery or user) instead.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { config } from '../config.js';
import { pool } from '../db.js';
import { hashingStats } from '../crypto.js';
import { snapshot } from '../metrics.js';
import { jobStats, listJobs, requeueJob } from '../jobs.js';

const TAG = 'Operations';

cap({
  name: 'list_jobs', method: 'GET', path: '/admin/jobs', tag: TAG, auth: ['admin'],
  summary: 'Platform team: background jobs and dead letters (refunds, email/push deliveries and notifications that exhausted their retries). Filter by status (default `dead`) and category. Newest first.',
  input: z.object({ status: z.enum(['queued', 'running', 'succeeded', 'dead', 'requeued']).default('dead'), category: z.string().max(40).optional(), ...page }),
  async handler(_, i) { return listJobs(i); },
});

cap({
  name: 'requeue_job', method: 'POST', path: '/admin/jobs/:id/requeue', tag: TAG, auth: ['admin'],
  summary: 'Platform team: send a dead-lettered job back for processing with a fresh retry budget. Refunds keep any money-movement intent already recorded, so a requeue can never refund twice.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await requeueJob(i.id);
    if (r.error === 'not_found') throw notFound('Job');
    if (r.error === 'not_dead') throw conflict('Only dead-lettered jobs can be requeued');
    await audit(null, user.id, 'requeue_job', 'jobs', i.id);
    const { payload, ...job } = r.job;
    return job;
  },
});

cap({
  name: 'get_worker_health', method: 'GET', path: '/admin/worker-health', tag: TAG, auth: ['admin'],
  summary: 'Platform team: background worker health. Each worker process with its last heartbeat, last maintenance cycle, per-category last run / attempts / failures, plus job queue depth, oldest due job (lag) and dead letters. `healthy` is true when a worker has beaten within the stale window and nothing is long overdue.',
  async handler() {
    const { rows: workers } = await pool.query(
      `SELECT worker_id, mode, host, status, interval_seconds, started_at, last_beat_at, last_cycle_at, last_cycle_ms, cycles, failed_cycles, last_error, stats,
              extract(epoch FROM now() - last_beat_at)::int AS seconds_since_beat
         FROM worker_heartbeats ORDER BY (status = 'running') DESC, last_beat_at DESC LIMIT 20`);
    const live = workers.filter((w) => w.status === 'running' && w.seconds_since_beat <= config.workerStaleSeconds);
    const queue = await jobStats();
    const lag = Math.max(0, ...queue.map((q) => q.oldest_due_seconds));
    const dead = queue.filter((q) => q.status === 'dead').reduce((a, q) => a + q.n, 0);
    return {
      healthy: live.length > 0 && lag <= Math.max(config.workerStaleSeconds, 300),
      stale_after_seconds: config.workerStaleSeconds,
      workers: workers.map((w) => ({ ...w, alive: live.includes(w) })),
      jobs: { queue, oldest_due_seconds: lag, dead },
    };
  },
});

cap({
  name: 'get_metrics', method: 'GET', path: '/admin/metrics', tag: TAG, auth: ['admin'],
  summary: 'Platform team: operational metrics for the API process (event-loop delay, memory, HTTP counts/latency, password-hashing queue, job counters) and the job queue (depth, lag, attempts, failures, dead letters). Counters never include payloads or personal data. Worker-process figures are in get_worker_health.',
  async handler() {
    const queue = await jobStats();
    const { rows: [att] } = await pool.query("SELECT coalesce(sum(attempts),0)::int AS attempts, count(*) FILTER (WHERE last_error IS NOT NULL)::int AS with_errors FROM jobs WHERE status IN ('queued','running','dead')");
    return { process: snapshot(), hashing: hashingStats(), jobs: { queue, open_attempts: att.attempts, open_with_errors: att.with_errors } };
  },
});
