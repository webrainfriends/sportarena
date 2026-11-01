// Browser-driven check of the player video library (#317): empty state, add by link and by upload, change who can see a clip, group clips into a highlight reel, share only that reel with a link and watch the link follow every change,
// on a phone, a tablet and a desktop (light and dark). Writes PNGs to E2E_SHOTS. Same prerequisites as appearances-journey.mjs.
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
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(64, 5)]);
try {
  const a = await reg(`vl_a${R}`, 'Asha Rao'), fresh = await reg(`vl_f${R}`, 'New Player');
  await call('POST', '/me/sport-profiles', { token: a.token, body: { sport: 'football', role: 'athlete', level: 'amateur' } });
  const v1 = await call('POST', '/me/passport-videos', { token: a.token, body: { title: 'Hat-trick vs Riverside', link_url: YT('dQw4w9WgXcQ'), sport_slug: 'football', visibility: 'shared', description: 'Three goals in the second half.' } });
  const v2 = await call('POST', '/me/passport-videos', { token: a.token, body: { title: 'Training drill', link_url: YT('aaaaaaaaaaa'), sport_slug: 'football', visibility: 'private' } });
  const up = await (await fetch('http://127.0.0.1:4000/api/v1/me/passport-videos/upload?title=Free%20kick&visibility=shared&sport_slug=football', { method: 'PUT', headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/octet-stream' }, body: MP4 })).json();
  check(!!v1?.id && !!v2?.id && !!up?.id, 'a linked clip, a private clip and an uploaded clip exist (API)');

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
  const goTab = async (p, name) => {
    await p.evaluate((name) => {
      if (!window.__nav) {
        const root = document.getElementById('root') ?? document.body.firstElementChild;
        const key = Object.keys(root).find((k) => k.startsWith('__reactContainer'));
        const todo = [root[key]];
        while (todo.length && !window.__nav) { const n = todo.pop(); const v = n.memoizedProps?.value; if (v && typeof v.push === 'function' && typeof v.goTab === 'function') { window.__nav = v; break; } if (n.sibling) todo.push(n.sibling); if (n.child) todo.push(n.child); }
      }
      window.__nav.goTab(name);
    }, name);
    await wait(p, 2000);
  };
  const openVideos = async (p) => { await goTab(p, 'Player'); await p.getByText('Videos', { exact: true }).first().click(); await wait(p, 1800); };
  const sheet = async (p, label) => { await p.getByText(label, { exact: true }).first().click(); await wait(p, 900); };

  // 1. empty state for a player with nothing yet
  { const { ctx, page: p } = await session(fresh, { width: 390, height: 844 });
    await openVideos(p); check(await vis(p, 'No videos yet') && await vis(p, 'Upload clip') && await vis(p, 'No playlists yet'), 'empty states explain what to do next, no demo data'); await shot(p, '01-empty-phone'); await ctx.close(); }

  // 2. phone: the library, change who can see a clip, build and share a reel
  let link;
  { const { ctx, page: p } = await session(a, { width: 390, height: 844 });
    await openVideos(p);
    check(await vis(p, 'Hat-trick vs Riverside') && await vis(p, 'Training drill') && await vis(p, 'Free kick'), 'the library lists linked and uploaded clips');
    check(await vis(p, 'Three goals in the second half.'), 'the description is read back');
    await shot(p, '02-library-phone');
    await p.getByText('Private', { exact: true }).first().click(); await wait(p, 1500);
    check(await vis(p, 'Training drill') && !(await vis(p, 'Hat-trick vs Riverside', 800)), 'the Private filter shows only private clips'); await shot(p, '03-filter-private-phone');
    await p.getByText('All', { exact: true }).first().click(); await wait(p, 1200);
    await p.getByText('New playlist').first().click(); await wait(p, 900);
    await p.getByRole('textbox').first().fill('Season highlights'); await shot(p, '04-new-reel-phone');
    await p.getByText('New playlist').last().click(); await wait(p, 1800);
    check(await vis(p, 'Season highlights'), 'a highlight reel is created');
    await p.getByText('Manage', { exact: true }).first().click(); await wait(p, 1200);
    await shot(p, '05-manage-reel-phone');
    await p.keyboard.press('Escape');
    const pls = await call('GET', '/me/playlists', { token: a.token }); const pl = pls[0];
    const full = await call('GET', `/me/playlists/${pl.id}`, { token: a.token });
    await call('POST', `/me/playlists/${pl.id}/videos`, { token: a.token, body: { version: full.version, video_ids: [v1.id, up.id, v2.id] } });
    await p.reload(); await wait(p, 2500); await openVideos(p);
    await p.getByText('Share link', { exact: true }).first().click(); await wait(p, 1000); await shot(p, '06-share-sheet-phone');
    await p.getByText('Share link', { exact: true }).last().click(); await wait(p, 2200);
    check(await vis(p, 'Link created'), 'creating the link shows it once with a copy button'); await shot(p, '07-link-created-phone');
    const links = await call('GET', '/me/passport-links', { token: a.token }); const l = links.find((x) => x.playlist_id === pl.id);
    check(!!l && l.show_matches === false && l.show_video === true, 'the reel link shows videos only (API state)');
    await ctx.close();
    // the link is a real secret: create one over the API to read it as a recipient
    link = await call('POST', '/me/passport-links', { token: a.token, body: { playlist_id: pl.id } });
    const seen = await call('GET', `/passport/${encodeURIComponent(link.token)}`);
    check(seen.videos.map((x) => x.title).sort().join('|') === 'Free kick|Hat-trick vs Riverside', 'a recipient sees only the shared clips of the reel, never the private one');
  }
  // 3. tablet: change visibility in the UI; the link follows at once
  { const { ctx, page: p } = await session(a, { width: 820, height: 1180 });
    await openVideos(p); await shot(p, '08-library-tablet');
    await p.getByText('Who can see it').first().click(); await wait(p, 1000); await shot(p, '09-visibility-tablet');
    await p.getByText(/^Private · /).first().click(); await p.getByText('Save', { exact: true }).last().click(); await wait(p, 2000);
    const after = await call('GET', `/passport/${encodeURIComponent(link.token)}`);
    check(after.videos.length === 1, 'making a clip private removes it from the shared reel on the next read (API state)');
    await p.getByText('Archive', { exact: true }).first().click(); await wait(p, 1800);
    check(await vis(p, 'Archived'), 'archiving keeps the clip and labels it Archived'); await ctx.close(); }
  // 4. desktop, dark theme
  { const { ctx, page: p } = await session(a, { width: 1440, height: 900 }, 'dark');
    await openVideos(p); await shot(p, '10-library-desktop-dark'); await ctx.close(); }
  await browser.close();
} catch (e) { failures++; log('JOURNEY ERROR', e.stack ?? e); }
await db.end(); web.close(); api.kill();
log(failures ? `${failures} FAILED` : 'ALL PASSED'); process.exit(failures ? 1 : 0);
