import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { config } from './config.js';
import { migrate } from './migrate.js';
import { createApp } from './http.js';

await migrate();
const app = createApp();
const server = config.sslKeyFile && config.sslCertFile
  ? createServer({ key: readFileSync(config.sslKeyFile), cert: readFileSync(config.sslCertFile), minVersion: 'TLSv1.2' }, app)
  : app;
server.listen(config.port, () => console.log(`SportArena API on ${config.sslKeyFile ? 'https' : 'http'}://localhost:${config.port}  (REST /api/v1 · MCP /mcp)`));
