// Runs the maintenance cycle on a timer, publishes a heartbeat, and shuts down gracefully.
// Used by the standalone worker (worker-main.js) and, by default, by the API process (WORKER_MODE=inprocess).
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { pool } from './db.js';
import { WORKER_ID } from './jobs.js';
import { logger, runWithContext } from './logger.js';
import { inc, snapshot } from './metrics.js';

/** Should this API process run maintenance itself? (`external` = a separate worker does.) */
export const runsMaintenanceInProcess = (cfg) => cfg.workerMode !== 'external' && cfg.notifyIntervalSeconds > 0;

export function createWorker({ mode = 'inprocess', intervalSeconds, cycle, workerId = WORKER_ID, runImmediately = false }) {
  let timer = null, inflight = null, stopping = false, cycles = 0, failed = 0, lastError = null, lastCycleAt = null, lastCycleMs = null;

  async function beat(status = 'running') {
    try {
      const stats = JSON.stringify({ steps: snapshot().steps, counters: snapshot().counters, event_loop_delay_ms: snapshot().event_loop_delay_ms, memory_mb: snapshot().memory_mb });
      await pool.query(
        `INSERT INTO worker_heartbeats(worker_id, mode, host, status, interval_seconds, last_beat_at, last_cycle_at, last_cycle_ms, cycles, failed_cycles, last_error, stats)
         VALUES ($1,$2,$3,$4,$5,now(),$6,$7,$8,$9,$10,$11)
         ON CONFLICT (worker_id) DO UPDATE SET status=$4, last_beat_at=now(), last_cycle_at=$6, last_cycle_ms=$7, cycles=$8, failed_cycles=$9, last_error=$10, stats=$11`,
        [workerId, mode, hostname(), status, intervalSeconds, lastCycleAt, lastCycleMs, cycles, failed, lastError, stats]);
    } catch (e) { logger.warn('heartbeat failed', { error: String(e.message).slice(0, 200) }); }
  }

  async function runCycle() {
    const cycle_id = randomUUID().slice(0, 8);
    await runWithContext({ worker_id: workerId, cycle_id }, async () => {
      const t0 = performance.now();
      try {
        const result = await cycle();
        const errs = result?.errors ? Object.keys(result.errors) : [];
        lastError = errs.length ? `failing: ${errs.join(', ')}` : null;
        if (errs.length) failed++;
        inc('cycles_total');
        logger.info('cycle complete', { ms: Math.round(performance.now() - t0), failing_categories: errs });
      } catch (e) {
        failed++; lastError = String(e.message).slice(0, 300); inc('cycles_failed_total');
        logger.error('cycle failed', { error: lastError });
      } finally {
        cycles++; lastCycleAt = new Date(); lastCycleMs = Math.round(performance.now() - t0);
      }
    });
  }

  /** One tick; overlapping ticks and ticks after stop() are skipped. */
  async function tick() {
    if (stopping) return;
    if (inflight) { await beat(); return; }
    inflight = runCycle();
    try { await inflight; } finally { inflight = null; }
    await beat(stopping ? 'stopping' : 'running');
  }

  return {
    workerId,
    async start() {
      await beat();
      timer = setInterval(() => { tick().catch((e) => logger.error('tick failed', { error: String(e.message) })); }, intervalSeconds * 1000);
      if (mode === 'inprocess') timer.unref();
      if (runImmediately) await tick();
    },
    tick,
    /** Stop claiming new work, wait for the cycle in flight, record the stop. */
    async stop() {
      if (stopping) return;
      stopping = true;
      clearInterval(timer);
      await beat('stopping');
      if (inflight) await inflight.catch(() => {});
      await beat('stopped');
      logger.info('worker stopped', { cycles });
    },
    get inflight() { return !!inflight; },
  };
}

/** Register SIGTERM/SIGINT once; `shutdown` runs, then the process exits (non-zero if it throws or takes too long). */
export function onShutdown(shutdown, { timeoutMs = 25_000 } = {}) {
  let called = false;
  const handler = (signal) => {
    if (called) return;
    called = true;
    logger.info('shutdown requested', { signal });
    const force = setTimeout(() => { logger.error('shutdown timed out, exiting'); process.exit(1); }, timeoutMs);
    force.unref();
    Promise.resolve().then(shutdown).then(() => process.exit(0), (e) => { logger.error('shutdown failed', { error: String(e.message) }); process.exit(1); });
  };
  process.on('SIGTERM', handler); process.on('SIGINT', handler);
}
