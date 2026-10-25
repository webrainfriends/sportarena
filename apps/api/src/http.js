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
import { signatureCallbackRouter } from './capabilities/sponsorship-contracts.js';
import { mediaRouter } from './media.js';
import { marketMediaRouter } from './market-media.js';
import { matchFileRouter } from './capabilities/player.js';
import { insuranceDocsRouter } from './capabilities/insurance-docs.js';
import { brandedDocumentsRouter } from './capabilities/branded-documents.js';
import { trackingFilesRouter } from './capabilities/tracking-files.js';
import { rulebookRouter } from './capabilities/rulebook.js';
import { coachingEvidenceRouter } from './capabilities/coaching-evidence.js';
import { passportFilesRouter } from './capabilities/passport-recruitment.js';
import { applicationFilesRouter } from './capabilities/sponsorship-application-forms.js';
import { subjectDocsRouter } from './capabilities/subject-docs.js';
import { contractReceiptsRouter } from './capabilities/player-contract-money.js';
import { staffDocsRouter } from './capabilities/event-openings.js';
import { liveRouter } from './live.js';
import { appleWebRouter } from './apple-web.js';
import { randomUUID } from 'node:crypto';
import { logger, runWithContext } from './logger.js';
import { recordRequest } from './metrics.js';
import { clearWebCookies, cookieAuth, credentialedOrigins, REFRESH_COOKIE, setWebCookies, usesWebCookies } from './web-session.js';

export function createApp() {
  const app = express();
  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // Correlation id: accept a sane incoming x-request-id (so a proxy/client can trace a call end to end), else generate one.
  // It is echoed on the response and attached to every log line written while the request runs. Path only (no query string/body) is logged.
  app.use((req, res, next) => {
    const incoming = req.get('x-request-id');
    const request_id = incoming && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    req.id = request_id;
    res.set('X-Request-Id', request_id);
    const t0 = performance.now();
    res.on('finish', () => {
      const ms = performance.now() - t0;
      recordRequest(res.statusCode, ms);
      if (config.accessLog && req.path !== '/health') runWithContext({ request_id }, () => logger.info('request', { method: req.method, path: req.path, status: res.statusCode, ms: Math.round(ms) }));
    });
    runWithContext({ request_id }, next);
  });
  // Encryption in transit: in production plain HTTP is refused; HSTS pins browsers to HTTPS.
  app.use(helmet({ hsts: config.allowInsecureHttp ? false : { maxAge: 63072000, includeSubDomains: true, preload: true } }));
  app.use((req, res, next) => {
    if (config.isProd && !config.allowInsecureHttp && !req.secure) return res.status(426).json({ error: { code: 'https_required', message: 'Use HTTPS' } });
    next();
  });
  // CORS: credentials (cookies) are only ever allowed for explicitly listed origins, never with a wildcard.
  app.use(cors((req, cb) => {
    const origin = req.headers.origin;
    if (origin && credentialedOrigins().includes(origin)) return cb(null, { origin: true, credentials: true });
    cb(null, { origin: config.corsOrigins.includes('*'), credentials: false });
  }));
  app.use(cookieAuth);
  app.use('/api/v1/webhooks', webhookRouter());
  app.use('/api/v1/webhooks/signatures', signatureCallbackRouter());
  // Media: streaming upload + file serving (binary, so outside the JSON capability router); base64 uploads get a larger JSON limit on their own path.
  app.use('/api/v1/venues/:id/media', express.json({ limit: '12mb' }));
  app.use('/api/v1', mediaRouter());
  app.use('/api/v1', marketMediaRouter());
  app.use('/api/v1', insuranceDocsRouter());
  app.use('/api/v1', brandedDocumentsRouter());
  app.use('/api/v1', trackingFilesRouter());
  app.use('/api/v1', rulebookRouter());
  app.use('/api/v1', coachingEvidenceRouter());
  app.use('/api/v1', passportFilesRouter());
  app.use('/api/v1', applicationFilesRouter());
  app.use('/api/v1', matchFileRouter());
  app.use('/api/v1', subjectDocsRouter());
  app.use('/api/v1', contractReceiptsRouter());
  app.use('/api/v1', staffDocsRouter());
  app.use(express.json({ limit: '100kb' }));
  app.use(rateLimit({ windowMs: 60_000, limit: config.isProd ? 300 : 5000, standardHeaders: true, legacyHeaders: false }));
  // Responses can carry personal data: never let proxies/browsers cache them.
  app.use((_, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: config.isProd ? 20 : 1000, standardHeaders: true, legacyHeaders: false });
  app.use(['/api/v1/auth/login', '/api/v1/auth/register', '/api/v1/auth/google', '/api/v1/auth/apple', '/api/v1/auth/refresh', '/api/v1/auth/password-reset', '/api/v1/auth/verify-email'], authLimiter);

  app.get('/', (_, res) => res.json({ name: 'Gotmygame', api: '/api/v1', openapi: '/api/v1/openapi.json', mcp: '/mcp', tools: capabilities.length }));
  app.get('/health', async (_, res) => { await pool.query('select 1'); res.json({ ok: true }); });
  // Unauthenticated probe for uptime monitors: is a background worker alive? 503 when none has beaten recently.
  app.get('/health/worker', async (_, res) => {
    const r = (await pool.query("SELECT extract(epoch FROM now() - max(last_beat_at))::int AS age FROM worker_heartbeats WHERE status = 'running'")).rows[0];
    const ok = r.age !== null && r.age <= config.workerStaleSeconds;
    res.status(ok ? 200 : 503).json({ ok, last_beat_age_seconds: r.age });
  });

  app.use('/api/v1', appleWebRouter());
  app.use('/api/v1', liveRouter());

  const v1 = express.Router();
  v1.get('/openapi.json', (_, res) => res.json(buildOpenApi()));
  for (const c of capabilities) {
    v1[c.method.toLowerCase()](c.path, async (req, res) => {
      try {
        const user = await authenticate(req.headers.authorization);
        const body = ['POST', 'PATCH'].includes(c.method) ? { ...(req.body ?? {}) } : {};
        const web = usesWebCookies(c, req);
        if (web && c.name === 'refresh_session' && !body.refresh_token && req.cookies?.[REFRESH_COOKIE]) body.refresh_token = req.cookies[REFRESH_COOKIE];
        let result = await invoke(c, user, { ...req.query, ...body, ...req.params }, { ip: req.ip, userAgent: req.headers['user-agent'] });
        if (web && result.token) {
          // Web clients never see the secrets: they go into HttpOnly cookies; the body only says who is signed in.
          const { token, refresh_token, ...rest } = result;
          setWebCookies(req, res, { token, refresh_token });
          result = { ...rest, cookie_session: true };
        } else if (['logout', 'logout_all'].includes(c.name) && req.cookies?.sa_session) clearWebCookies(req, res);
        res.status(c.status ?? 200).json(result);
      } catch (e) {
        const { status, code, message, details } = toErrorBody(e);
        if (status === 503 && details?.retry_after_seconds) res.set('Retry-After', String(details.retry_after_seconds));
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
