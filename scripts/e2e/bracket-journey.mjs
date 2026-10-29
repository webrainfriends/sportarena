// Browser-driven check of the advanced tournament experience (#577): plan any stage with a preview, seeds & draw, double elimination, Swiss rounds,
// pools → knockout, series, corrections that need a decision, and what spectators see, on phone, tablet and desktop. All data is created through the
// public API. Needs: a throwaway Postgres database (E2E_DATABASE_URL; migrated, never dropped here), a same-origin web build
//   EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir <dir>   (E2E_DIST, default /tmp/e2e-dist)
// and playwright-core with a Chromium (E2E_CHROMIUM, default the pre-installed one). Run: node scripts/e2e/bracket-journey.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import pg from 'pg';
const need = createRequire(import.meta.url);
const { chromium } = (() => { try { return need('playwright-core'); } catch { return need('playwright'); } })();   // playwright-core, or the full package when that is what the machine has
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
const call = async (method, p, { token, body, allow } = {}) => { const r = await fetch(`http://127.0.0.1:4000/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => ({})); if (!r.ok && !allow) throw new Error(`${method} ${p} ${r.status} ${JSON.stringify(j)}`); return allow ? { status: r.status, body: j } : j; };
const reg = async (h, name, roles = ['athlete']) => { const r = await call('POST', '/auth/register', { body: { handle: h, display_name: name, email: `${h}@example.com`, password: 'correct-horse-battery', roles } }); return { ...r.user, token: r.token, email: `${h}@example.com` }; };
const db = new pg.Pool({ connectionString: E.DATABASE_URL });
let failures = 0; const check = (ok, msg) => { log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const wait = (p, ms = 1200) => p.waitForTimeout(ms);
const NAMES = ['Mumbai Mavericks', 'Pune Panthers', 'Delhi Dynamos', 'Chennai Chargers', 'Kolkata Knights', 'Goa Gliders', 'Jaipur Jets', 'Hyderabad Hawks'];
try {
  // ---------------------------------------------------------------- data, created through the public API
  const org = await reg('bj_org', 'Priya Nair', ['organizer']);
  const venue = await call('POST', '/venues', { token: org.token, body: { name: 'Riverside Arena', city: 'Pune', country: 'IN', timezone: 'UTC' } });
  await call('POST', `/venues/${venue.id}/hours`, { token: org.token, body: { hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '06:00', closes: '23:00' })) } });
  for (const name of ['Court A', 'Court B', 'Court C']) await call('POST', `/venues/${venue.id}/resources`, { token: org.token, body: { kind: 'court', name, sport: 'basketball' } });
  const caps = [], teams = [];
  for (let i = 0; i < 8; i++) {
    caps.push(await reg(`bj_cap${i}`, `Captain ${i + 1}`));
    teams.push(await call('POST', '/teams', { token: caps[i].token, body: { name: NAMES[i], sport: 'basketball', city: i % 2 ? 'Pune' : 'Mumbai' } }));
  }
  const ids = teams.map((t) => t.id), idx = (id) => ids.indexOf(id);
  const WINDOW = { from_date: day(1), to_date: day(40), match_duration_min: 60, rest_min: 30, max_per_team_per_day: 3 };
  const newEvent = async (name, n = 8) => {
    const ev = await call('POST', '/events', { token: org.token, body: { name, sport: 'basketball', venue_id: venue.id, starts_on: day(1), ends_on: day(40) } });
    const inv = await call('POST', `/events/${ev.id}/invitations`, { token: org.token, body: { invitees: teams.slice(0, n).map((t) => ({ team_id: t.id })) } });
    for (const [k, c] of caps.slice(0, n).entries()) await call('POST', `/event-invitations/${inv.invitations[k].id}/respond`, { token: c.token, body: { accept: true } });
    await call('PATCH', `/events/${ev.id}/public-settings`, { token: org.token, body: { visibility: 'public' } });
    return ev;
  };
  const stronger = (f) => (idx(f.home_team_id) < idx(f.away_team_id) ? 'home' : 'away');
  const next = async (ev) => (await db.query("SELECT * FROM fixtures WHERE event_id=$1 AND status='scheduled' AND home_team_id IS NOT NULL AND away_team_id IS NOT NULL ORDER BY scheduled_at, bracket_slot, id LIMIT 1", [ev.id])).rows[0];
  const play = async (ev, { stop = () => false, pick = stronger } = {}) => { for (let g = 0; g < 300; g++) { const f = await next(ev); if (!f || stop(f)) return f; await call('POST', `/fixtures/${f.id}/result`, { token: org.token, body: pick(f) === 'home' ? { home_score: 82, away_score: 71 } : { home_score: 68, away_score: 77 } }); } };

  // 1. double elimination with a reset game, partly played
  const dbl = await newEvent('Riverside Double Elimination');
  const g1 = await call('POST', `/events/${dbl.id}/schedule`, { token: org.token, body: { ...WINDOW, format: 'double_elimination', team_ids: ids, format_config: { reset: true } } });
  let n = 0; await play(dbl, { stop: () => n++ >= 9 });
  // 2. Swiss, two rounds played, the third not yet paired
  const sw = await newEvent('Riverside Swiss Open');
  const g2 = await call('POST', `/events/${sw.id}/schedule`, { token: org.token, body: { ...WINDOW, format: 'swiss', team_ids: ids, format_config: { swiss: { rounds: 4, first_round: 'seeded' } } } });
  await play(sw); await call('POST', `/events/${sw.id}/stages/${g2.stage.id}/next-round`, { token: org.token }); await play(sw);
  // 3. pools then knockout
  const pl = await newEvent('Riverside Pools Cup');
  const g3 = await call('POST', `/events/${pl.id}/schedule`, { token: org.token, body: { ...WINDOW, format: 'pools', team_ids: ids, format_config: { pools: { pool_count: 2, advance_per_pool: 2, draw: 'snake' } } } });
  await play(pl); await call('POST', `/events/${pl.id}/stages/${g3.stage.id}/advance`, { token: org.token, body: { third_place: true } });
  // 4. series with a correction that reaches a played game
  const se = await newEvent('Riverside Series Cup', 4);
  const g4 = await call('POST', `/events/${se.id}/schedule`, { token: org.token, body: { ...WINDOW, format: 'knockout', team_ids: ids.slice(0, 4), format_config: { tie: { mode: 'best_of', best_of: 3, apply_to: 'except_final' } } } });
  await play(se);
  const semi = (await db.query("SELECT * FROM fixtures WHERE event_id=$1 AND round_kind='semi' AND leg_no=1 ORDER BY bracket_slot", [se.id])).rows[0];
  await call('POST', `/fixtures/${semi.id}/result`, { token: org.token, body: { home_score: 60, away_score: 90, accept_downstream_conflicts: true }, allow: true });
  // 5. a draft to edit
  const dr = await newEvent('Riverside Draft Cup');
  const g5 = await call('POST', `/events/${dr.id}/schedule`, { token: org.token, body: { ...WINDOW, format: 'knockout', team_ids: ids, publish: false, format_config: { placement_up_to: 8 } } });

  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const session = async (who, viewport) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 }); const page = await ctx.newPage();
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } }); if (!r.ok()) throw new Error(`login ${r.status()} ${await r.text()}`);
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
    await wait(p, 2200);
  };
  const focus = async (p, text) => { await p.getByText(text).first().scrollIntoViewIfNeeded().catch(() => {}); await wait(p, 600); };
  const bracketTab = async (p, ev) => { await navTo(p, 'EventCommand', { id: ev.id, tab: 'games' }); await p.getByText('🏆 Bracket').first().click(); await wait(p, 2200); };
  const VIEWPORTS = { phone: { width: 390, height: 844 }, tablet: { width: 820, height: 1180 }, desktop: { width: 1440, height: 900 } };

  for (const [vp, size] of Object.entries(VIEWPORTS)) {
    const { ctx, page: p } = await session(org, size);
    // double elimination
    await bracketTab(p, dbl);
    check(await vis(p, 'Double elimination'), `${vp}: the stage is named`);
    check(await vis(p, 'PUBLISHED') || await vis(p, 'IN PROGRESS'), `${vp}: its state is shown in words`);
    await focus(p, 'Double elimination'); await shot(p, `${vp}-01-double-elimination`);
    await p.getByText('Drawing', { exact: true }).first().click(); await wait(p, 800); await focus(p, 'LOSERS BRACKET'); await shot(p, `${vp}-02-double-elimination-drawing`);
    // swiss
    await bracketTab(p, sw);
    check(await vis(p, 'STANDINGS'), `${vp}: Swiss shows standings`);
    check(await vis(p, 'Pair round 3'), `${vp}: the organiser can pair the next round`);
    await focus(p, 'Swiss rounds paired').catch(() => {}); await focus(p, 'STANDINGS'); await shot(p, `${vp}-03-swiss`);
    // pools + knockout
    await bracketTab(p, pl);
    check(await vis(p, 'Pool A'), `${vp}: pools show their tables`);
    await focus(p, 'Pool A'); await shot(p, `${vp}-04-pools`);
    // series + conflict
    await bracketTab(p, se);
    check(await vis(p, 'need your decision') || await vis(p, 'needs your decision'), `${vp}: a corrected result that reaches a played game waits for a decision`);
    await focus(p, 'need your decision'); await shot(p, `${vp}-05-series-conflict`);
    // draft with seeds & draw
    await bracketTab(p, dr);
    check(await vis(p, 'DRAFT'), `${vp}: a draft says it is a draft`);
    await p.getByText('Seeds & draw', { exact: true }).first().click(); await wait(p, 1500);
    check(await vis(p, 'Best seed first'), `${vp}: the seed editor opens`);
    await shot(p, `${vp}-06-seeds-sheet`);
    await p.keyboard.press('Escape'); await wait(p, 400);
    await ctx.close();
  }
  // planner: choose Swiss and preview (tablet)
  {
    const { ctx, page: p } = await session(org, VIEWPORTS.tablet);
    await navTo(p, 'EventCommand', { id: (await call('POST', '/events', { token: org.token, body: { name: 'Planner Cup', sport: 'basketball', venue_id: venue.id } })).id, tab: 'games' });
    await ctx.close();
  }
  // spectator on a phone
  {
    const fan = await reg('bj_fan', 'Fan');
    const { ctx, page: p } = await session(fan, VIEWPORTS.phone);
    await p.goto(`http://localhost:4100/?event=${dbl.id}`); await wait(p, 3000);
    await p.getByText('Table & bracket').first().click().catch(() => {}); await wait(p, 2000);
    check(await vis(p, 'Bracket & rounds'), 'spectators read the published stages');
    await shot(p, 'spectator-phone-bracket');
    await ctx.close();
  }
  await browser.close();
} catch (e) { log('ERROR', e.stack); failures++; }
api.kill(); web.close(); await db.end();
log(failures ? `${failures} FAILED` : 'ALL PASSED', `— screenshots in ${OUT}`);
process.exit(failures ? 1 : 0);
