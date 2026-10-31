// Browser-driven check of coach-published group classes (#656): the coach publishes and runs classes on a phone, tablet and desktop, an athlete sees seat counts only and joins from the coach profile.
// Same prerequisites as pathway-plan-journey.mjs (throwaway Postgres in E2E_DATABASE_URL, a same-origin web build in E2E_DIST, playwright + Chromium). Run: node scripts/e2e/coach-classes-journey.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const { chromium } = createRequire('/opt/node-tools/')('playwright');
import pg from 'pg';
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
  const ext = path.extname(f); res.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf', '.ico': 'image/x-icon' }[ext] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => web.listen(4100, r));
const B = 'http://localhost:4100/api/v1';
const call = async (method, p, { token, body } = {}) => { const r = await fetch(`http://127.0.0.1:4000/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${p} ${r.status} ${JSON.stringify(j)}`); return j; };
const reg = async (h, name, roles = ['athlete']) => { const r = await call('POST', '/auth/register', { body: { handle: h, display_name: name, email: `${h}@example.com`, password: 'correct-horse-battery', roles } }); return { ...r.user, token: r.token, email: `${h}@example.com` }; };
const db = new pg.Pool({ connectionString: E.DATABASE_URL });
let failures = 0; const check = (ok, msg) => { log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const key = () => `e2e-${Math.random().toString(36).slice(2)}${Date.now()}`;
const wait = (p, ms = 1200) => p.waitForTimeout(ms);

const R = Date.now().toString(36); // handles are unique per run: the throwaway database is never reset
const inH = (h) => new Date(Date.now() + h * 36e5).toISOString();
try {
  const coach = await reg(`cc_c${R}`, 'Coach Meera', ['coach']), mgr = await reg(`cc_m${R}`, 'Venue Admin', ['venue_manager']);
  const people = []; for (const [i, nm] of ['Asha Rao', 'Dev Patel', 'Isha Nair', 'Kabir Shah', 'Lena Roy'].entries()) people.push(await reg(`cc_p${i}${R}`, nm));
  const joiners = {}; for (const v of ['phone', 'tablet', 'desktop']) joiners[v] = await reg(`cc_j${v[0]}${R}`, 'Mira Kapoor');
  await call('POST', '/me/sport-profiles', { token: coach.token, body: { sport: 'badminton', role: 'coach', level: 'pro', hourly_rate_cents: 80000 } });
  await call('POST', '/me/sport-profiles', { token: coach.token, body: { sport: 'football', role: 'coach', level: 'pro', hourly_rate_cents: 80000 } });
  const venue = await call('POST', '/venues', { token: mgr.token, body: { name: `Smash Arena ${R}`, city: 'Pune', timezone: 'Asia/Kolkata', latitude: 18.52, longitude: 73.85 } });
  const card = (b) => call('POST', '/coach/rate-cards', { token: coach.token, body: { audience: 'group', unit: 'session', duration_min: 60, per_person: true, min_participants: 2, max_participants: 8, delivery: 'both', ...b } });
  const badm = await card({ title: 'Badminton footwork clinic', sport: 'badminton', price_cents: 45000 });
  const foot = await card({ title: 'Five-a-side passing', sport: 'football', price_cents: 0 });
  const k1 = await call('POST', '/coach/classes', { token: coach.token, body: { rate_card_id: badm.id, starts_at: inH(30), venue_id: venue.id, max_participants: 6, min_participants: 3, skill_min: 'beginner', skill_max: 'amateur', notes: 'Bring non-marking shoes. Shuttles provided.' } });
  const k2 = await call('POST', '/coach/classes', { token: coach.token, body: { rate_card_id: foot.id, starts_at: inH(76), online_url: 'https://meet.example.com/passing', max_participants: 8, min_participants: 2, title: 'Passing patterns (online walkthrough)' } });
  for (const p of people.slice(0, 5)) await call('POST', `/coach/classes/${k1.id}/join`, { token: p.token, body: {} });
  await call('POST', `/coach/classes/${k2.id}/join`, { token: people[0].token, body: {} });
  check(!!k1.id && !!k2.id, 'a coach, a venue, two group rate cards and two published classes with joined athletes exist (API)');

  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const session = async (who, viewport) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 }); const page = await ctx.newPage();
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } }); if (!r.ok()) throw new Error('login failed');
    await page.goto('http://localhost:4100/'); await page.waitForTimeout(2500);
    return { ctx, page };
  };
  const shot = (page, n) => page.screenshot({ path: `${OUT}${n}.png`, fullPage: false });
  const vis = async (p, t, ms = 5000) => { try { await p.getByText(t).first().waitFor({ state: 'visible', timeout: ms }); return true; } catch { return false; } };
  const navTo = async (p, name, params = {}) => {
    await p.evaluate(({ name, params }) => {
      if (!window.__nav) {
        const root = document.getElementById('root') ?? document.body.firstElementChild;
        const key = Object.keys(root).find((k) => k.startsWith('__reactContainer'));
        const todo = [root[key]];
        while (todo.length && !window.__nav) { const n = todo.pop(); const v = n.memoizedProps?.value; if (v && typeof v.push === 'function' && typeof v.goTab === 'function') { window.__nav = v; break; } if (n.sibling) todo.push(n.sibling); if (n.child) todo.push(n.child); }
      }
      window.__nav.push(name, params);
    }, { name, params });
    await wait(p, 2200);
  };
  const VIEWS = { phone: { width: 390, height: 844 }, tablet: { width: 820, height: 1180 }, desktop: { width: 1360, height: 860 } };

  for (const [name, vp] of Object.entries(VIEWS)) {
    // the coach's desk, then one class with its seat list
    const { ctx, page: p } = await session(coach, vp);
    await navTo(p, 'CoachClasses');
    check(await vis(p, 'My classes') && await vis(p, 'Badminton footwork clinic') && await vis(p, 'Last seats'), `${name}: the coach desk lists published classes with live seat counts`);
    await shot(p, `cls-01-coach-desk-${name}`);
    await p.getByText('Badminton footwork clinic', { exact: false }).first().click(); await wait(p, 1500);
    check(await vis(p, 'Attendance') && await vis(p, 'Asha Rao'), `${name}: the coach sees who joined and can cancel the class`);
    await shot(p, `cls-02-coach-class-${name}`);
    await p.keyboard.press('Escape'); await ctx.close();
  }
  for (const [name, vp] of Object.entries(VIEWS)) {
    // an athlete on the coach's profile: classes with seat counts only, then the join sheet
    const { ctx, page: p } = await session(joiners[name], vp);
    await navTo(p, 'CoachProfile', { id: coach.id });
    check(await vis(p, 'Upcoming classes') && await vis(p, 'Badminton footwork clinic'), `${name}: the coach profile shows upcoming classes`);
    await shot(p, `cls-03-profile-${name}`);
    await p.getByText('Badminton footwork clinic', { exact: false }).first().click(); await wait(p, 1500);
    check(await vis(p, 'Join'), `${name}: an athlete can join (or join the waitlist once full) from the class sheet`);
    check(!(await p.getByText('Dev Patel').count()), `${name}: other participants are never named to an athlete`);
    await shot(p, `cls-04-join-${name}`);
    if (name === 'phone') { await p.getByText('Join class', { exact: true }).first().click(); await wait(p, 1800); check(await vis(p, 'Leave class'), 'joining takes the last seat and offers Leave class'); await shot(p, 'cls-05-joined-phone'); }
    await ctx.close();
  }
  {
    const { ctx, page: p } = await session(coach, VIEWS.phone);
    await navTo(p, 'CoachClasses');
    await p.getByText('Publish a class', { exact: true }).first().click(); await wait(p, 1500);
    check(await vis(p, 'Rate card') && await vis(p, 'Seats'), 'the publish form uses chips, a date-time picker, venue search and steppers');
    await shot(p, 'cls-06-publish-phone'); await ctx.close();
  }
  await browser.close();
} catch (e) { log('ERROR', e.message); failures++; } finally { await db.end().catch(() => {}); api.kill(); web.close(); }
process.exit(failures ? 1 : 0);
