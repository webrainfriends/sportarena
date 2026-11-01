// Browser-driven check of map + list discovery, saved searches and city / venue leaderboards (#696): phone, tablet and desktop.
// Needs: a throwaway Postgres database (E2E_DATABASE_URL; migrated, never dropped here), a same-origin web build
//   EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir <dir>   (E2E_DIST, default /tmp/e2e-dist)
// and playwright (or playwright-core) with a Chromium (E2E_CHROMIUM). It creates its own data through the public API; nothing is seeded.
// Screens are saved as PNGs in E2E_SHOTS (default /tmp/e2e-shots). Run: node scripts/e2e/discovery-journey.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = (() => { for (const m of ['playwright-core', 'playwright', '/opt/node-tools/node_modules/playwright']) { try { return require(m); } catch { /* next */ } } throw new Error('playwright is not installed'); })();
const E = { DATABASE_URL: process.env.E2E_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/sportarena_e2e', SPORTARENA_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), SPORTARENA_JWT_SECRET: Buffer.alloc(32, 9).toString('base64'),
  PORT: '4000', APP_URL: 'http://localhost:4100', CORS_ORIGINS: 'http://localhost:4100', PLATFORM_APPROVALS: 'off', RATE_LIMIT_DISABLED: 'true' };
const OUT = (process.env.E2E_SHOTS ?? '/tmp/e2e-shots') + '/'; fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
const api = spawn('node', ['src/server.js'], { cwd: new URL('../../apps/api/', import.meta.url).pathname, env: { ...process.env, ...E }, stdio: ['ignore', 'pipe', 'pipe'] });
api.stdout.on('data', (d) => process.env.V && log('[api]', String(d).trim())); api.stderr.on('data', (d) => process.env.V && log('[api!]', String(d).trim()));
for (let i = 0; i < 60; i++) { try { if ((await fetch('http://127.0.0.1:4000/api/v1/payments/methods')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }
const DIST = process.env.E2E_DIST ?? '/tmp/e2e-dist';
const web = http.createServer((req, res) => {
  if (req.url.startsWith('/api') || req.url.startsWith('/mcp')) { const p = http.request({ host: '127.0.0.1', port: 4000, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }); req.pipe(p); return; }
  let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
  const ext = path.extname(f); res.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf' }[ext] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => web.listen(4100, r));
const B = 'http://localhost:4100/api/v1';
const call = async (method, p, { token, body, query } = {}) => { const r = await fetch(`http://127.0.0.1:4000/api/v1${p}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${p} ${r.status} ${JSON.stringify(j)}`); return j; };
const R = Math.random().toString(36).slice(2, 6);
const reg = async (h, roles = ['athlete']) => { const r = await call('POST', '/auth/register', { body: { handle: `${h}${R}`, display_name: h, email: `${h}${R}@example.com`, password: 'correct-horse-battery', roles } }); return { ...r.user, token: r.token, email: `${h}${R}@example.com` }; };
let failures = 0; const check = (ok, msg) => { log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const inH = (h) => new Date(Date.now() + h * 36e5).toISOString();
try {
  const mgr = await reg('discmgr', ['venue_manager']), coach = await reg('disccoach', ['coach']), host = await reg('dischost'), me = await reg('discplayer');
  const mkVenue = async (name, city, lat, lng, sport, rate) => {
    const v = await call('POST', '/venues', { token: mgr.token, body: { name, city, timezone: 'Asia/Kolkata', latitude: lat, longitude: lng } });
    await call('POST', `/venues/${v.id}/hours`, { token: mgr.token, body: { hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '06:00', closes: '22:00' })) } });
    await call('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'Court 1', sport, capacity: 1, hourly_rate_cents: rate } });
    return v;
  };
  const baner = await mkVenue('Baner Sports Arena', 'Pune', 18.559, 73.786, 'badminton', 40000);
  const koreg = await mkVenue('Koregaon Park Courts', 'Pune', 18.536, 73.894, 'football', 90000);
  await mkVenue('Wakad Tennis Club', 'Pune', 18.598, 73.762, 'tennis', 60000);
  await mkVenue('Bandra Turf', 'Mumbai', 19.06, 72.836, 'football', 120000);
  await call('POST', '/me/sport-profiles', { token: coach.token, body: { sport: 'badminton', role: 'coach', level: 'pro', hourly_rate_cents: 80000 } });
  const card = await call('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'Badminton clinic', sport: 'badminton', audience: 'group', unit: 'session', duration_min: 60, per_person: true, min_participants: 2, max_participants: 8, delivery: 'in_person', price_cents: 35000 } });
  await call('POST', '/coach/classes', { token: coach.token, body: { rate_card_id: card.id, starts_at: inH(30), venue_id: baner.id, skill_min: 'beginner', skill_max: 'amateur' } });
  await call('POST', '/open-games', { token: host.token, body: { sport: 'football', starts_at: inH(26), duration_minutes: 90, max_players: 10, approval_mode: 'auto', title: 'Sunday 5-a-side', location: 'Koregaon Park Courts', place_latitude: 18.536, place_longitude: 73.894, place_city: 'Pune', cost_mode: 'per_player', cost_cents: 15000, currency: 'INR' } });
  await call('POST', '/open-games', { token: host.token, body: { sport: 'cricket', starts_at: inH(52), duration_minutes: 120, max_players: 12, approval_mode: 'auto', title: 'Net session', location: 'Baner ground', place_latitude: 18.563, place_longitude: 73.79, place_city: 'Pune', cost_mode: 'free' } });
  await call('POST', '/me/saved-searches', { token: me.token, body: { name: 'Pune badminton', sport: 'badminton', lat: 18.55, lng: 73.84, radius_km: 25 } });
  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const wait = (p, ms = 1500) => p.waitForTimeout(ms);
  const open = async (viewport) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, geolocation: { latitude: 18.5204, longitude: 73.8567 }, permissions: ['geolocation'] }); const page = await ctx.newPage();
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: me.email, password: 'correct-horse-battery' } }); if (!r.ok()) throw new Error(`login ${r.status()}`);
    await page.goto('http://localhost:4100/?open=find-games'); await wait(page, 3000);
    return page;
  };
  for (const [name, vp] of [['phone', { width: 390, height: 844 }], ['tablet', { width: 820, height: 1180 }], ['desktop', { width: 1280, height: 900 }]]) {
    const p = await open(vp);
    await p.getByText('Map and list', { exact: true }).first().click(); await wait(p, 2500);
    const near = p.getByText('Near me', { exact: false }).first(); await near.click(); await wait(p, 3500);
    check(await p.getByText(/venues ·/).count() > 0, `${name}: result counts are shown`);
    check((await p.locator('.leaflet-marker-icon').count()) > 0, `${name}: pins are drawn on the map`);
    await p.screenshot({ path: `${OUT}disc-01-map-${name}.png` });
    if (name === 'phone') { await p.getByText('List', { exact: true }).first().click(); await wait(p, 1200); await p.screenshot({ path: `${OUT}disc-02-list-${name}.png` }); await p.getByText('Map', { exact: true }).first().click(); await wait(p, 800); }
    await p.getByText(/Dates/).first().click(); await wait(p, 1200); await p.screenshot({ path: `${OUT}disc-03-filters-${name}.png` });
    await p.getByText('Leaderboards', { exact: true }).first().click(); await wait(p, 2000); await p.screenshot({ path: `${OUT}disc-04-boards-${name}.png` });
    await p.context().close();
  }
  await browser.close();
} catch (e) { log('ERROR', e.message); failures++; }
api.kill(); web.close();
log(failures ? `${failures} FAILED` : 'ALL PASSED'); process.exit(failures ? 1 : 0);
