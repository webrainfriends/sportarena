import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.js';
import { capabilities } from './capabilities/index.js';
import { authenticate } from './auth.js';
import { invoke, toErrorBody } from './invoke.js';
import { buildOpenApi } from './openapi.js';
import { createMcpServer } from './mcp.js';
import { pool } from './db.js';
import { webhookRouter } from './payments/webhooks.js';
import { mediaRouter } from './media.js';
import { marketMediaRouter } from './market-media.js';

export function createApp() {
  const app = express();
  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // Encryption in transit: in production plain HTTP is refused; HSTS pins browsers to HTTPS.
  app.use(helmet({ hsts: config.allowInsecureHttp ? false : { maxAge: 63072000, includeSubDomains: true, preload: true } }));
  app.use((req, res, next) => {
    if (config.isProd && !config.allowInsecureHttp && !req.secure) return res.status(426).json({ error: { code: 'https_required', message: 'Use HTTPS' } });
    next();
  });
  app.use(cors({ origin: config.corsOrigins.includes('*') ? true : config.corsOrigins }));
  app.use('/api/v1/webhooks', webhookRouter());
  // Media: streaming upload + file serving (binary, so outside the JSON capability router); base64 uploads get a larger JSON limit on their own path.
  app.use('/api/v1/venues/:id/media', express.json({ limit: '12mb' }));
  app.use('/api/v1', mediaRouter());
  app.use('/api/v1', marketMediaRouter());
  app.use(express.json({ limit: '100kb' }));
  app.use(rateLimit({ windowMs: 60_000, limit: config.isProd ? 300 : 5000, standardHeaders: true, legacyHeaders: false }));
  // Responses can carry personal data: never let proxies/browsers cache them.
  app.use((_, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: config.isProd ? 20 : 1000, standardHeaders: true, legacyHeaders: false });
  app.use(['/api/v1/auth/login', '/api/v1/auth/register'], authLimiter);

  app.get('/', (_, res) => res.json({ name: 'SportArena', api: '/api/v1', openapi: '/api/v1/openapi.json', mcp: '/mcp', tools: capabilities.length }));
  app.get('/health', async (_, res) => { await pool.query('select 1'); res.json({ ok: true }); });

  const v1 = express.Router();
  v1.get('/openapi.json', (_, res) => res.json(buildOpenApi()));
  for (const c of capabilities) {
    v1[c.method.toLowerCase()](c.path, async (req, res) => {
      try {
        const user = await authenticate(req.headers.authorization);
        const body = ['POST', 'PATCH'].includes(c.method) ? (req.body ?? {}) : {};
        const result = await invoke(c, user, { ...req.query, ...body, ...req.params });
        res.status(c.status ?? 200).json(result);
      } catch (e) {
        const { status, code, message, details } = toErrorBody(e);
        res.status(status).json({ error: { code, message, details } });
      }
    });
  }
  app.use('/api/v1', v1);

  // MCP over Streamable HTTP — stateless: a fresh server per request, authenticated by bearer token.
  app.post('/mcp', async (req, res) => {
    const user = await authenticate(req.headers.authorization);
    const server = createMcpServer(async () => user);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.all('/mcp', (_, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. POST JSON-RPC to /mcp.' }, id: null }));

  app.use((_, res) => res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } }));
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'bad_request', message: 'Invalid JSON' } });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: { code: 'too_large', message: 'Body too large' } });
    console.error('[unhandled]', err);
    res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong' } });
  });
  return app;
}
