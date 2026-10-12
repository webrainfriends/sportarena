// Standalone background worker: `npm run worker` (pm2 process `sportarena-worker`).
// Run it with WORKER_MODE=external set on BOTH this process and the API, so the API stops running maintenance itself.
// Claims are atomic in SQL (SKIP LOCKED + leases), so running more than one worker is safe.
import { config } from './config.js';
import { initKeys } from './crypto.js';
import { pool } from './db.js';
import { maintenanceCycle } from './worker.js';
import { createWorker, onShutdown } from './worker-runtime.js';
import { startMetrics } from './metrics.js';
import { logger } from './logger.js';

await initKeys(); // email addresses are decrypted when delivering mail, so the worker needs the same keys as the API
startMetrics();
const interval = Math.max(1, config.notifyIntervalSeconds || 60);
const worker = createWorker({ mode: 'external', intervalSeconds: interval, cycle: maintenanceCycle, runImmediately: false });
await worker.start();
logger.info('worker started', { worker_id: worker.workerId, interval_seconds: interval });
// Keep the process alive between ticks and run the first cycle right away.
worker.tick().catch((e) => logger.error('first tick failed', { error: String(e.message) }));

onShutdown(async () => {
  await worker.stop();   // stop claiming, wait for the cycle in flight
  await pool.end();      // close the database pool
});
