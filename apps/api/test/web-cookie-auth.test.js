import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { config } = await import('../src/config.js');

const APP = 'https://app.sportarena.test';
const EVIL = 'https://evil.example';
let server, base;

/** A tiny cookie-jar fetch, standing in for a browser. */
const browser = () => {
  const jar = {};
  const send = async (method, path, { body, origin = APP, csrf = 'auto', web = true, headers = {}, raw = false } = {}) => {
    const h = { 'content-type': 'application/json', ...headers };
    if (web) h['x-sa-client'] = 'web';
    if (origin) h.origin = origin;
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) h.cookie = cookie;
    if (csrf === 'auto' && jar.sa_csrf && method !== 'GET') h['x-csrf-token'] = jar.sa_csrf;
    else if (csrf && csrf !== 'auto') h['x-csrf-token'] = csrf;
    const r = await fetch(`${base}${path}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.getSetCookie();
    for (const line of set) {
      const [pair, ...attrs] = line.split('; ');
      const i = pair.indexOf('=');
      const expired = attrs.some((a) => /^Expires=Thu, 01 Jan 1970/i.test(a) || /^Max-Age=0$/i.test(a));
      if (expired || pair.slice(i + 1) === '') delete jar[pair.slice(0, i)]; else jar[pair.slice(0, i)] = pair.slice(i + 1);
    }
    return { status: r.status, body: raw ? null : await r.json().catch(() => null), set, headers: r.headers };
  };
  return { jar, send, api: (m, p, o) => send(m, `/api/v1${p}`, o) };
};
const PW = 'correct-horse-battery';
let n = 0;
const newUser = async () => {
  n++;
  const email = `web${n}@example.com`;
  const r = await fetch(`${base}/api/v1/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: `web_${n}`, display_name: `Web ${n}`, email, password: PW }) });
  return { email, ...(await r.json()) };
};
const signIn = async (b, email) => {
  const r = await b.api('POST', '/auth/login', { body: { email, password: PW } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r;
};

before(async () => {
  config.corsOrigins = [APP];
  config.cookieSecure = 'true';
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('web sign-in sets HttpOnly Secure SameSite cookies and puts no secret in the response body', async () => {
  const u = await newUser();
  const b = browser();
  const r = await signIn(b, u.email);
  const by = Object.fromEntries(r.set.map((l) => [l.split('=')[0], l]));
  assert.match(by.sa_session, /HttpOnly/i); assert.match(by.sa_session, /Secure/i); assert.match(by.sa_session, /SameSite=Lax/i);
  assert.match(by.sa_refresh, /HttpOnly/i); assert.match(by.sa_refresh, /Secure/i); assert.match(by.sa_refresh, /Path=\/api\/v1\/auth/);
  assert.doesNotMatch(by.sa_csrf, /HttpOnly/i, 'the CSRF token must be readable by the page');
  assert.equal(r.body.token, undefined); assert.equal(r.body.refresh_token, undefined);
  assert.equal(r.body.cookie_session, true); assert.equal(r.body.user.id, u.user.id);
  assert.equal((await b.api('GET', '/me')).body.id, u.user.id, 'cookie alone authenticates reads');
  // native/agents (no x-sa-client) still receive tokens in the body
  const native = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: u.email, password: PW }) });
  const nb = await native.json();
  assert.ok(nb.token && nb.refresh_token); assert.equal(native.headers.getSetCookie().length, 0);
});

test('CSRF: state-changing cookie requests need the token header and an allowed Origin', async () => {
  const u = await newUser();
  const b = browser();
  await signIn(b, u.email);
  const patch = { body: { bio: 'hello' } };
  assert.equal((await b.api('PATCH', '/me', { ...patch, csrf: null })).body.error.code, 'csrf_token', 'no token');
  assert.equal((await b.api('PATCH', '/me', { ...patch, csrf: 'forged-token-value' })).status, 403, 'wrong token');
  assert.equal((await b.api('PATCH', '/me', { ...patch, origin: EVIL })).body.error.code, 'csrf_origin', 'valid token but foreign origin');
  assert.equal((await b.api('PATCH', '/me', { ...patch, origin: null })).body.error.code, 'csrf_origin', 'no Origin/Referer');
  assert.equal((await b.api('PATCH', '/me', { ...patch, origin: null, headers: { referer: `${APP}/screen` } })).status, 200, 'Referer from an allowed origin is accepted when Origin is absent');
  assert.equal((await b.api('PATCH', '/me', patch)).status, 200);
  assert.equal((await b.api('GET', '/me')).body.bio, 'hello');
  // nothing was changed by the rejected attempts
  await b.api('PATCH', '/me', { body: { bio: 'second' } });
  assert.equal((await b.api('PATCH', '/me', { body: { bio: 'evil' }, origin: EVIL })).status, 403);
  assert.equal((await b.api('GET', '/me')).body.bio, 'second');
  // another user's CSRF token is useless
  const other = browser(); const u2 = await newUser(); await signIn(other, u2.email);
  assert.equal((await b.api('PATCH', '/me', { body: { bio: 'x' }, csrf: other.jar.sa_csrf })).status, 403);
});

test('login CSRF: a web sign-in from a foreign origin is refused', async () => {
  const u = await newUser();
  const b = browser();
  const r = await b.api('POST', '/auth/login', { body: { email: u.email, password: PW }, origin: EVIL });
  assert.equal(r.status, 403); assert.equal(r.set.length, 0);
});

test('bearer tokens are unaffected by CSRF rules and win over cookies', async () => {
  const u = await newUser();
  const b = browser();
  await signIn(b, u.email);
  const bearer = u.token;
  const r = await fetch(`${base}/api/v1/me`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}`, cookie: `sa_session=${b.jar.sa_session}` }, body: JSON.stringify({ bio: 'via bearer' }) });
  assert.equal(r.status, 200, 'an explicit Authorization header needs no CSRF token (browsers never add it themselves)');
  // MCP is bearer-only: the cookie alone does not authenticate it
  const mcp = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', cookie: `sa_session=${b.jar.sa_session}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_me', arguments: {} } }) });
  assert.equal(mcp.status, 403, 'a cookie-carrying POST to /mcp is refused (no Origin/CSRF) - MCP is bearer-only');
  const mcp2 = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', origin: APP, 'x-csrf-token': b.jar.sa_csrf, cookie: `sa_session=${b.jar.sa_session}; sa_csrf=${b.jar.sa_csrf}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_me', arguments: {} } }) });
  assert.equal(JSON.parse((await mcp2.json()).result.content[0].text).code, 'unauthorized', 'even with valid CSRF the cookie never authenticates MCP');
});

test('cookie refresh rotates; replaying a stolen refresh cookie ends the session; logout clears cookies', async () => {
  const u = await newUser();
  const b = browser();
  await signIn(b, u.email);
  const stolen = b.jar.sa_refresh;
  const noCsrf = await b.api('POST', '/auth/refresh', { csrf: null });
  assert.equal(noCsrf.status, 403, 'refresh by cookie is CSRF-protected');
  const ok = await b.api('POST', '/auth/refresh');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.notEqual(b.jar.sa_refresh, stolen); assert.equal(ok.body.token, undefined);
  assert.equal((await b.api('GET', '/me')).status, 200);

  const attacker = browser();
  Object.assign(attacker.jar, { sa_refresh: stolen, sa_csrf: 'attacker-csrf' });
  assert.equal((await attacker.api('POST', '/auth/refresh', { csrf: 'attacker-csrf' })).status, 401);
  assert.equal((await b.api('GET', '/me')).status, 401, 'reuse killed the legitimate session too');

  await signIn(b, u.email);
  const out = await b.api('POST', '/auth/logout');
  assert.equal(out.status, 200);
  assert.equal(Object.keys(b.jar).length, 0, 'all three cookies cleared');
  assert.equal((await b.api('GET', '/me')).status, 401);
});

test('CORS: credentials only for listed origins, never with a wildcard', async () => {
  const get = (origin) => fetch(`${base}/api/v1/sports`, { headers: { origin } });
  const ok = await get(APP);
  assert.equal(ok.headers.get('access-control-allow-origin'), APP);
  assert.equal(ok.headers.get('access-control-allow-credentials'), 'true');
  const bad = await get(EVIL);
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
  assert.equal(bad.headers.get('access-control-allow-credentials'), null);
  const pre = await fetch(`${base}/api/v1/me`, { method: 'OPTIONS', headers: { origin: APP, 'access-control-request-method': 'PATCH', 'access-control-request-headers': 'x-csrf-token,x-sa-client,content-type' } });
  assert.match(pre.headers.get('access-control-allow-headers'), /x-csrf-token/i);

  config.corsOrigins = ['*'];
  try {
    const any = await get(EVIL);
    assert.equal(any.headers.get('access-control-allow-origin'), EVIL, 'wildcard mode still serves bearer clients');
    assert.equal(any.headers.get('access-control-allow-credentials'), null, 'but never with credentials');
    // and a cross-origin cookie write is refused when no explicit origin list exists
    const u = await newUser(); const b = browser(); await signIn(b, u.email).catch(() => {});
    assert.equal((await b.api('PATCH', '/me', { body: { bio: 'x' }, origin: EVIL })).status, 403);
  } finally { config.corsOrigins = [APP]; }
});

test('the web app never writes credentials to web storage and removes any left by earlier builds', async () => {
  const { readFileSync } = await import('node:fs');
  const src = (f) => readFileSync(new URL(`../../app/src/${f}`, import.meta.url), 'utf8');
  // Behavioural: load the real apps/app/src/storage.js with Platform.OS='web', a stub localStorage and a stub SecureStore.
  const mod = src('storage.js').replace(/^import .*$/gm, '').replace('export const storage', 'const storage') + '\nreturn storage;';
  const load = (os) => {
    const ls = new Map(); const secure = new Map();
    globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => { ls.set(k, String(v)); }, removeItem: (k) => { ls.delete(k); } };
    const SecureStore = { getItemAsync: async (k) => secure.get(k) ?? null, setItemAsync: async (k, v) => { secure.set(k, v); }, deleteItemAsync: async (k) => { secure.delete(k); } };
    return { storage: new Function('Platform', 'SecureStore', mod)({ OS: os }, SecureStore), ls, secure };
  };
  try {
    const web = load('web');
    await web.storage.set('token', 'eyJ.secret.jwt'); await web.storage.set('refresh', 'rt_secret');
    assert.deepEqual([...web.ls.keys()], [], 'credential keys are never written to localStorage');
    assert.equal(await web.storage.get('token'), null);
    await web.storage.set('role', 'coach');
    assert.equal(web.ls.get('role'), 'coach', 'harmless preferences still persist');
    web.ls.set('token', 'legacy-bearer'); web.ls.set('refresh', 'legacy-refresh'); // left by an earlier build
    assert.equal(await web.storage.get('token'), null, 'a legacy token is not even readable');
    await web.storage.del('token'); await web.storage.del('refresh');
    assert.equal(web.ls.has('token') || web.ls.has('refresh'), false, 'del clears legacy tokens');
    // native keeps using the secure store
    const native = load('ios');
    await native.storage.set('token', 'abc');
    assert.equal(native.secure.get('token'), 'abc'); assert.equal(native.ls.size, 0);
  } finally { delete globalThis.localStorage; }
  // session.js cannot be executed without React Native; its web start-up path is checked structurally.
  const session = src('session.js');
  assert.match(session, /Platform\.OS === 'web'[\s\S]{0,400}storage\.del\('token'\)/, 'legacy localStorage token is removed on load');
  assert.doesNotMatch(src('api.js'), /localStorage/, 'the API client keeps no credentials in web storage');
});
