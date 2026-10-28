import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { config } from './config.js';
import { migrate } from './migrate.js';
import { createApp } from './http.js';
import { initKeys } from './crypto.js';
import { maintenanceCycle } from './worker.js';
import { createWorker, onShutdown, runsMaintenanceInProcess } from './worker-runtime.js';
import { pool } from './db.js';
import { startMetrics } from './metrics.js';
import { logger } from './logger.js';

startMetrics();
await initKeys();   // fail fast if the master key can't be loaded
await migrate();
const platformMod = await import('./platform.js');
await platformMod.reconcilePlatformRoles();   // only the platform-admin list may hold admin / platform_admin
await platformMod.bootstrapPlatformOwner();
if (config.isProd && config.allowInsecureHttp) console.warn('[security] ALLOW_INSECURE_HTTP=true: serving over plain HTTP. Personal data is NOT encrypted in transit. Enable TLS before real users sign up.');
const app = createApp();
const server = config.sslKeyFile && config.sslCertFile
  ? createServer({ key: readFileSync(config.sslKeyFile), cert: readFileSync(config.sslCertFile), minVersion: 'TLSv1.2' }, app)
  : app;
const listener = server.listen(config.port, () => console.log(`Gotmygame API on ${config.sslKeyFile ? 'https' : 'http'}://localhost:${config.port}  (REST /api/v1 · MCP /mcp)`));

// Booking reminders, queued emails, unpaid-hold release and refunds. Claims are atomic in SQL, so running this on several instances is safe.
// WORKER_MODE=external hands all of this to the separate worker process (npm run worker).
let worker = null;
if (runsMaintenanceInProcess(config)) {
  worker = createWorker({ mode: 'inprocess', intervalSeconds: config.notifyIntervalSeconds, cycle: maintenanceCycle });
  await worker.start();
} else if (config.workerMode === 'external') {
  logger.info('maintenance runs in the external worker (WORKER_MODE=external)');
}

// Graceful shutdown: stop accepting connections, let the maintenance cycle in flight finish, close the pool.
onShutdown(async () => {
  await worker?.stop();
  await new Promise((resolve) => { listener.close(() => resolve()); listener.closeIdleConnections?.(); });
  await pool.end();
});
