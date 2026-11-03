// Browser-driven check of AI highlights & smart clips (#505): the organiser's Highlights tab on a phone, tablet and desktop (queue, review, line-up form,
// reel builder), a player accepting a clip offer for the passport, and the shareable public clip page before and after a takedown. Data is created through the
// public API; the clip jobs are run by a child process. Needs the same throwaway database and web build as the other journeys (E2E_DATABASE_URL, E2E_DIST).
// Run: node scripts/e2e/smart-clips-journey.mjs   Screenshots land in E2E_SHOTS (default /tmp/e2e-shots).
// and playwright-core with a Chromium (E2E_CHROMIUM, default the pre-installed one). Run: node scripts/e2e/live-scoring-journey.mjs
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
let n = 0;
const reg = async (h, name, roles = ['athlete']) => { n++; const handle = `${h}${n}`; const r = await call('POST', '/auth/register', { body: { handle, display_name: name, email: `${handle}@example.com`, password: 'correct-horse-battery', roles } }); return { ...r.user, token: r.token, email: `${handle}@example.com` }; };
const db = new pg.Pool({ connectionString: E.DATABASE_URL });
let failures = 0; const check = (ok, msg) => { log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const wait = (p, ms = 1200) => p.waitForTimeout(ms);
const phone = { width: 390, height: 844 }, tablet = { width: 820, height: 1180 }, desktop = { width: 1280, height: 900 };

try {
  // ---------------------------------------------------------------- data, created through the public API (SQL only for fixtures and the scoring log)
  const apiDir = new URL('../../apps/api/', import.meta.url).pathname;
  const runJobs = () => new Promise((res) => { const c = spawn('node', ['--input-type=module', '-e', "const m = await import('./src/smart-clips.js'); await m.runClipJobs(); process.exit(0)"], { cwd: apiDir, env: { ...process.env, ...E }, stdio: 'ignore' }); c.on('exit', res); });
  const org = await reg('cl_org', 'Priya Nair', ['organizer']), m1 = await reg('cl_m1', 'Alex Lee', ['coach']), m2 = await reg('cl_m2', 'Omar Haddad', ['coach']);
  const star = await reg('cl_star', 'Aarav Shah'), mate = await reg('cl_mate', 'Kabir Mehta');
  const ev = await call('POST', '/events', { token: org.token, body: { name: 'Pune Cup', sport: 'football' } });
  await db.query("UPDATE events SET status='open' WHERE id=$1", [ev.id]);
  const home = await call('POST', '/teams', { token: m1.token, body: { name: 'Pune Reds', sport: 'football' } }), away = await call('POST', '/teams', { token: m2.token, body: { name: 'Pune Blues', sport: 'football' } });
  const fx = (await db.query("INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at, status, home_score, away_score, round) VALUES ($1,$2,$3, now(), 'completed', 2, 1, 'Final') RETURNING id", [ev.id, home.id, away.id])).rows[0].id;
  const T0 = Date.now() - 3600_000;
  let seq = 0;
  for (const [kind, side, who, sec, clock] of [['goal', 'home', star, 600, 600], ['goal', 'away', mate, 1500, 1500], ['goal', 'home', star, 2400, 2400]]) {
    await db.query("INSERT INTO match_events(fixture_id, event_id, seq, kind, side, player_id, period, clock_seconds, payload, recorded_by, recorded_at) VALUES ($1,$2,$3,$4,$5,$6,1,$7,'{}',$8,$9)", [fx, ev.id, ++seq, kind, side, who.id, clock, org.id, new Date(T0 + sec * 1000)]);
  }
  const src = await call('POST', `/events/${ev.id}/media/assets`, { token: org.token, body: { kind: 'video', right_kind: 'archive', title: 'Full match · Pune Reds v Pune Blues', owner_kind: 'organiser', external_url: 'https://video.example.com/pune-final.mp4', fixture_id: fx } });
  await call('POST', `/media/assets/${src.id}/clip-alignment`, { token: org.token, body: { fixture_id: fx, method: 'wall_clock', anchor_media_s: 60, anchor_at: new Date(T0).toISOString(), lag_s: 4 } });
  const gen = await call('POST', `/media/assets/${src.id}/clip-candidates`, { token: org.token, body: {} });
  check(gen.created.length === 3 && gen.created.every((c) => c.cites.id), 'three goals became three candidates, each citing its scoring event');
  const [c1, c2, c3] = gen.created.sort((a, b) => a.media.start_s - b.media.start_s);
  for (const c of [c1, c2]) await call('POST', `/clips/${c.id}/process`, { token: org.token });
  await runJobs();
  let first = await call('GET', `/clips/${c1.id}`, { token: org.token });
  const approved = await call('POST', `/clips/${c1.id}/review`, { token: org.token, body: { decision: 'approve', row_version: first.row_version } });
  await call('POST', `/clips/${c1.id}/publish`, { token: org.token, body: { audience: 'public' } });
  await call('POST', `/clips/${c1.id}/player-links`, { token: org.token, body: { user_id: star.id } });
  check(approved.status === 'approved', 'a clip was approved by a person and then published');

  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const session = async (who, viewport) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 }); const page = await ctx.newPage();
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    if (process.env.V) { page.on('console', (m) => ['error', 'warning'].includes(m.type()) && log('[console]', m.text().slice(0, 220))); }
    if (who) { const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } }); if (!r.ok()) throw new Error(`login ${who.handle} ${r.status()}`); }
    await page.goto('http://localhost:4100/'); await page.waitForTimeout(2500);
    return { ctx, page };
  };
  const shot = (page, name) => page.screenshot({ path: `${OUT}${name}.png`, fullPage: false });
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
  const tap = async (p, text, opts = {}) => { await p.getByText(text, opts).first().click(); await wait(p, 900); };
  const scrollTo = async (p, y) => { await p.evaluate((y) => { for (const el of document.querySelectorAll('*')) if (el.scrollHeight > el.clientHeight + 40 && getComputedStyle(el).overflowY !== 'visible') el.scrollTop = y; }, y); await wait(p, 500); };
  const toPanel = (p, y = 560) => scrollTo(p, y);
  const closeSheet = async (p) => { await p.locator('text=/^[×✕]$/').first().click().catch(() => {}); await wait(p, 700); };
  const scrollTop = async (p) => { await p.evaluate(() => { for (const el of document.querySelectorAll('*')) if (el.scrollHeight > el.clientHeight + 40 && getComputedStyle(el).overflowY !== 'visible') el.scrollTop = 0; }); await wait(p, 300); };

  // ---------------------------------------------------------------- the organiser's Highlights tab on phone, tablet and desktop
  for (const [label, vp] of [['phone', phone], ['tablet', tablet], ['desktop', desktop]]) {
    const { ctx, page: p } = await session(org, vp);
    await navTo(p, 'EventCommand', { id: ev.id, tab: 'broadcast' });
    await p.getByText(/Highlights/).first().click(); await wait(p, 1800);
    check(await vis(p, 'Lined up with the game'), `${label}: the single recording is pre-selected and shown as lined up`);
    check(await vis(p, 'Goal'), `${label}: moments from the scoring record are listed`);
    await toPanel(p, label === 'phone' ? 640 : 520); await shot(p, `01-highlights-queue-${label}`);
    await toPanel(p, label === 'phone' ? 1250 : 1000); await shot(p, `01b-highlights-clips-${label}`);
    if (label === 'phone') {
      await p.getByText(/Goal 25'/).first().click(); await wait(p, 1500);
      check(await vis(p, 'Facts from the record'), 'a clip opens with its facts kept apart from any prose');
      await shot(p, '02-clip-review-phone');
      check(await vis(p, 'Approve'), 'a clip in review offers Approve, not Publish');
      await closeSheet(p); await toPanel(p, 640);
      await tap(p, 'Line up with the game'); await shot(p, '03-align-form-phone');
      await closeSheet(p);
      await tap(p, /New reel/); await shot(p, '04-new-reel-phone');
    }
    if (label === 'tablet') { await p.getByText(/Goal 25'/).first().click(); await wait(p, 1500); await shot(p, '02-clip-review-tablet'); }
    await ctx.close();
  }

  // ---------------------------------------------------------------- the player: a clip offered for the passport, then in the gallery
  {
    const { ctx, page: p } = await session(star, phone);
    await navTo(p, 'Person', { id: star.id });
    check(await vis(p, 'Waiting for your answer'), 'the player sees the clip offer waiting for their answer');
    await shot(p, '05-player-gallery-offer-phone');
    await tap(p, 'Add to my passport');
    check(await vis(p, 'Watch'), 'after accepting, the clip can be watched from the passport');
    await shot(p, '06-player-gallery-accepted-phone');
    await ctx.close();
  }
  {
    const { ctx, page: p } = await session(star, tablet);
    await navTo(p, 'Person', { id: star.id });
    await shot(p, '05-player-gallery-tablet');
    await ctx.close();
  }

  // ---------------------------------------------------------------- the shareable public page (signed out)
  for (const [label, vp] of [['phone', phone], ['desktop', desktop]]) {
    const { ctx, page: p } = await session(null, vp);
    await p.goto(`http://localhost:4100/?clip=${c1.id}`); await wait(p, 3000);
    check(await vis(p, 'Share link'), `${label}: a signed-out visitor can open the shared clip page`);
    await shot(p, `07-public-clip-${label}`);
    await ctx.close();
  }
  // takedown removes it from the very next view
  const asset = await call('GET', `/clips/${c1.id}`, { token: org.token });
  await call('POST', `/media/assets/${asset.asset_id}/status`, { token: org.token, body: { action: 'take_down', reason: 'rights holder request', row_version: asset.rights.row_version } });
  {
    const { ctx, page: p } = await session(null, phone);
    await p.goto(`http://localhost:4100/?clip=${c1.id}`); await wait(p, 3000);
    check(await vis(p, 'This clip is not available.'), 'after a takedown the shared link says the clip is not available');
    await shot(p, '08-public-clip-taken-down-phone');
    await ctx.close();
  }
  await browser.close();
} catch (e) { log('FAIL  journey crashed:', e.stack ?? e.message); failures++; }
finally { api.kill(); web.close(); await db.end(); }
log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
