// Browser-driven check of the coach's Shared clips view (#317): a coach opens the journal of an athlete they coach and sees only clips the athlete shared; private clips, an athlete with nothing shared and an athlete the coach does not coach are handled,
// on a phone, a tablet and a desktop (dark). Writes PNGs to E2E_SHOTS. Same prerequisites as appearances-journey.mjs.
// Needs: a throwaway Postgres database (E2E_DATABASE_URL; migrated, never dropped here), a same-origin web build
//   EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir <dir>   (E2E_DIST, default /tmp/e2e-dist)
// and playwright with a Chromium (E2E_CHROMIUM, default the pre-installed one). Run: node scripts/e2e/pathway-plan-journey.mjs
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


const R = Date.now().toString(36);
const YT = (s) => `https://www.youtube.com/watch?v=${s}`;
try {
  const coach = await reg(`vs_c${R}`, 'Coach Meera', ['coach']), a = await reg(`vs_a${R}`, 'Asha Rao'), b = await reg(`vs_b${R}`, 'Ben Quiet'), stranger = await reg(`vs_s${R}`, 'Sam Elsewhere');
  const team = await call('POST', '/teams', { token: coach.token, body: { name: 'Riverside FC', sport: 'football' } });
  await db.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'coach','active') ON CONFLICT (team_id, user_id) DO UPDATE SET role='coach', status='active'", [team.id, coach.id]);
  for (const p of [a, b]) await db.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [team.id, p.id]);
  await call('POST', '/me/passport-videos', { token: a.token, body: { title: 'Hat-trick vs Riverside', link_url: YT('dQw4w9WgXcQ'), sport_slug: 'football', visibility: 'shared', description: 'Three goals in the second half.' } });
  await call('POST', '/me/passport-videos', { token: a.token, body: { title: 'Private training drill', link_url: YT('aaaaaaaaaaa'), sport_slug: 'football', visibility: 'private' } });
  await call('POST', '/me/passport-videos', { token: stranger.token, body: { title: 'Elsewhere clip', link_url: YT('bbbbbbbbbbb'), visibility: 'shared' } });
  const api0 = await call('GET', `/athletes/${a.id}/videos`, { token: coach.token });
  check(api0.length === 1 && api0[0].title === 'Hat-trick vs Riverside', 'the API gives the coach only the shared clip (API)');

  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const session = async (who, viewport, colorScheme = 'light') => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme }); const page = await ctx.newPage();
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } }); if (!r.ok()) throw new Error('login failed');
    await page.goto('http://localhost:4100/'); await page.waitForTimeout(2500);
    return { ctx, page };
  };
  const shot = (page, n) => page.screenshot({ path: `${OUT}${n}.png`, fullPage: false });
  const vis = async (p, t, ms = 4000) => { try { await p.getByText(t).first().waitFor({ state: 'visible', timeout: ms }); return true; } catch { return false; } };
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
    await wait(p, 2500);
  };
  const down = async (p, px) => { await p.mouse.move(200, 500); await p.mouse.wheel(0, px); await wait(p, 900); };
  // phone: the coach opens the athlete's journal
  { const { ctx, page: p } = await session(coach, { width: 390, height: 844 });
    await navTo(p, 'CoachJournal', { athlete_id: a.id, name: 'Asha Rao' });
    check(await vis(p, 'Shared clips') && await vis(p, 'Hat-trick vs Riverside'), 'the coach sees the shared clip in the athlete journal');
    check(!(await vis(p, 'Private training drill', 800)), 'the private clip never shows');
    check(await vis(p, 'Read only; each view is logged.'), 'the screen says it is read only and logged');
    await down(p, 1100); await shot(p, '11-coach-shared-clips-phone');
    await navTo(p, 'CoachJournal', { athlete_id: b.id, name: 'Ben Quiet' });
    check(await vis(p, 'No shared clips yet'), 'an athlete with nothing shared shows the empty state'); await down(p, 1100); await shot(p, '12-coach-no-clips-phone');
    await navTo(p, 'CoachJournal', { athlete_id: stranger.id, name: 'Sam Elsewhere' });
    check(await vis(p, 'Not available') && !(await vis(p, 'Elsewhere clip', 800)), 'an athlete the coach does not coach is Not available, with no clips leaked'); await down(p, 1100); await shot(p, '13-coach-not-available-phone');
    await ctx.close(); }
  { const { ctx, page: p } = await session(coach, { width: 820, height: 1100 });
    await navTo(p, 'CoachJournal', { athlete_id: a.id, name: 'Asha Rao' }); await down(p, 1500); await shot(p, '14-coach-shared-clips-tablet'); await ctx.close(); }
  { const { ctx, page: p } = await session(coach, { width: 1440, height: 900 }, 'dark');
    await navTo(p, 'CoachJournal', { athlete_id: a.id, name: 'Asha Rao' }); await down(p, 1500); await shot(p, '15-coach-shared-clips-desktop-dark'); await ctx.close(); }
  const aud = await db.query("SELECT count(*)::int AS n FROM audit_log WHERE actor_id=$1 AND action='read_athlete_videos'", [coach.id]);
  check(aud.rows[0].n >= 1, 'the coach\'s reads are audit-logged');
  // the athlete takes the clip back: the coach loses it at once
  await call('POST', `/me/videos/${(await call('GET', '/me/videos', { token: a.token })).find((v) => v.visibility === 'shared').id}/visibility`, { token: a.token, body: { id: (await call('GET', '/me/videos', { token: a.token })).find((v) => v.visibility === 'shared').id, version: 1, visibility: 'private' } });
  check((await call('GET', `/athletes/${a.id}/videos`, { token: coach.token })).length === 0, 'when the athlete makes the clip private the coach loses it at once (API)');
  await browser.close();
} catch (e) { failures++; log('JOURNEY ERROR', e.stack ?? e); }
await db.end(); web.close(); api.kill();
log(failures ? `${failures} FAILED` : 'ALL PASSED'); process.exit(failures ? 1 : 0);
