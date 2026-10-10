import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { config } from './config.js';
import { migrate } from './migrate.js';
import { createApp } from './http.js';
import { initKeys } from './crypto.js';
import { maintenanceCycle } from './worker.js';

await initKeys();   // fail fast if the master key can't be loaded
await migrate();
await (await import('./platform.js')).bootstrapPlatformOwner();
if (config.isProd && config.allowInsecureHttp) console.warn('[security] ALLOW_INSECURE_HTTP=true: serving over plain HTTP. Personal data is NOT encrypted in transit. Enable TLS before real users sign up.');
const app = createApp();
const server = config.sslKeyFile && config.sslCertFile
  ? createServer({ key: readFileSync(config.sslKeyFile), cert: readFileSync(config.sslCertFile), minVersion: 'TLSv1.2' }, app)
  : app;
server.listen(config.port, () => console.log(`SportArena API on ${config.sslKeyFile ? 'https' : 'http'}://localhost:${config.port}  (REST /api/v1 · MCP /mcp)`));

// Booking reminders, queued emails, unpaid-hold release and refunds. Claims are atomic in SQL, so running this on several instances is safe.
if (config.notifyIntervalSeconds > 0) {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try { await maintenanceCycle(); } catch (e) { console.error('[notify] cycle failed', e.message); } finally { running = false; }
  }, config.notifyIntervalSeconds * 1000).unref();
}
