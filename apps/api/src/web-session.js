// Web cookie sessions: the access token and refresh token live in HttpOnly cookies the page's JavaScript can never read,
// protected by SameSite, an Origin allowlist and a double-submit CSRF token. Native apps and API tokens keep using the
// `Authorization: Bearer` header, which is not sent automatically by browsers and therefore needs no CSRF protection.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

export const SESSION_COOKIE = 'sa_session';
export const REFRESH_COOKIE = 'sa_refresh';
export const CSRF_COOKIE = 'sa_csrf';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const COOKIE_CAPS = new Set(['login', 'login_mfa', 'login_google', 'register', 'refresh_session']);

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed cookie */ }
  }
  return out;
}

/** The page announces itself as a cookie-session client; everything else (native, agents) gets tokens in the JSON body. */
export const isWebClient = (req) => req.headers['x-sa-client'] === 'web';
export const usesWebCookies = (c, req) => COOKIE_CAPS.has(c.name) && isWebClient(req);

/** Origins allowed to make credentialed (cookie) requests: the explicit CORS_ORIGINS list, never '*'. */
export const credentialedOrigins = () => config.corsOrigins.map((o) => o.trim()).filter((o) => o && o !== '*');

/**
 * Is this request's Origin acceptable for a credentialed, state-changing call?
 * Explicit allowlist first. With no explicit list configured (local development) only same-origin is accepted.
 */
export function originAllowed(req) {
  const origin = req.headers.origin ?? (req.headers.referer ? safeOrigin(req.headers.referer) : null);
  if (!origin) return false;
  const list = credentialedOrigins();
  if (list.length) return list.includes(origin);
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
const safeOrigin = (u) => { try { return new URL(u).origin; } catch { return null; } };

export function csrfValid(req, cookies) {
  const sent = req.headers['x-csrf-token'];
  const want = cookies[CSRF_COOKIE];
  if (typeof sent !== 'string' || !want || sent.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(sent), Buffer.from(want));
}

const secure = (req) => (config.cookieSecure === 'auto' ? Boolean(req.secure) : config.cookieSecure === 'true');
const base = (req) => ({ secure: secure(req), sameSite: config.cookieSameSite, maxAge: config.refreshTtlDays * 864e5 });

export function setWebCookies(req, res, { token, refresh_token }) {
  const csrf = randomBytes(24).toString('base64url');
  res.cookie(SESSION_COOKIE, token, { ...base(req), httpOnly: true, path: '/' });
  res.cookie(REFRESH_COOKIE, refresh_token, { ...base(req), httpOnly: true, path: '/api/v1/auth' });
  res.cookie(CSRF_COOKIE, csrf, { ...base(req), httpOnly: false, path: '/' }); // readable on purpose: echoed in X-CSRF-Token
  return csrf;
}

export function clearWebCookies(req, res) {
  const o = { secure: secure(req), sameSite: config.cookieSameSite };
  res.clearCookie(SESSION_COOKIE, { ...o, httpOnly: true, path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...o, httpOnly: true, path: '/api/v1/auth' });
  res.clearCookie(CSRF_COOKIE, { ...o, path: '/' });
}

/**
 * Express middleware (runs before every router). For a request that authenticates with the session cookie and no Authorization
 * header: state-changing methods must come from an allowed Origin and carry the CSRF header; then the cookie is presented to the
 * existing bearer-based code as `Authorization`, so REST, uploads and every other router share one auth path.
 */
export function cookieAuth(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  req.cookies = cookies;
  const hasSession = Boolean(cookies[SESSION_COOKIE]);
  if (req.headers.authorization) return next(); // explicit bearer wins; browsers never add it by themselves
  const unsafe = !SAFE.has(req.method);
  const credentialed = hasSession || Boolean(cookies[REFRESH_COOKIE]);
  const loginLike = /^\/api\/v1\/auth\/(login|login\/mfa|register|password-reset|password-reset\/confirm|verify-email)$/.test(req.path);
  if (unsafe && (credentialed || (isWebClient(req) && req.headers.origin))) {
    if (!originAllowed(req)) return res.status(403).json({ error: { code: 'csrf_origin', message: 'This request came from an origin that is not allowed' } });
    if (credentialed && !loginLike && !csrfValid(req, cookies)) return res.status(403).json({ error: { code: 'csrf_token', message: 'Missing or invalid CSRF token. Reload the page and try again.' } });
  }
  if (hasSession && req.path !== '/mcp') req.headers.authorization = `Bearer ${cookies[SESSION_COOKIE]}`;
  next();
}
