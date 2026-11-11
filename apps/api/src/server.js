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
logger.info('[startup] 1/6 initializing keys');
await initKeys();   // fail fast if the master key can't be loaded
logger.info('[startup] 2/6 running migrations');
await migrate();
logger.info('[startup] 3/6 loading platform settings');
const settingsMod = await import('./platform-settings.js');
await settingsMod.loadPlatformSettings();   // the platform admin's document size limit
settingsMod.startSettingsRefresh();
logger.info('[startup] 4/6 reconciling platform roles');
const platformMod = await import('./platform.js');
await platformMod.reconcilePlatformRoles();   // only the platform-admin list may hold admin / platform_admin
await platformMod.bootstrapPlatformOwner();
logger.info('[startup] 5/6 loading payment config');
// payment provider keys set in the app, and the per-country payment switches, are cached in memory; reload them now and every 30s so every instance follows an admin's change
const providerConfig = await import('./payments/provider-config.js');
const countryMethods = await import('./payments/countries.js');
const reloadPayments = () => Promise.all([providerConfig.refreshProviderConfig(), countryMethods.refreshCountryMethods()]).catch((e) => console.error('[payments] config reload failed', e.message));
await reloadPayments();
logger.info('[startup] 6/6 starting HTTP server');
setInterval(reloadPayments, 30_000).unref();
if (config.isProd && config.allowInsecureHttp) console.warn('[security] ALLOW_INSECURE_HTTP=true: serving over plain HTTP. Personal data is NOT encrypted in transit. Enable TLS before real users sign up.');
const app = createApp();
const server = config.sslKeyFile && config.sslCertFile
  ? createServer({ key: readFileSync(config.sslKeyFile), cert: readFileSync(config.sslCertFile), minVersion: 'TLSv1.2' }, app)
  : app;
const listener = server.listen(config.port, () => console.log(`GotMyGame API on ${config.sslKeyFile ? 'https' : 'http'}://localhost:${config.port}  (REST /api/v1 · MCP /mcp)`));

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
