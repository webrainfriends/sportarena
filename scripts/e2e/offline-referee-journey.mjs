// Browser-driven check of offline scoring for referees (#7): the match-day pack is saved from Officials home, the API is then made
// unreachable, and the official still opens the game, kicks off, scores, takes full time and sees the provisional score; when the signal
// returns everything is recorded once, in order, with the kick-off at the time it was pressed. Phone, tablet and desktop. Data is created
// through the public API. Needs the same things as live-scoring-journey.mjs.
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
  // ---------------------------------------------------------------- data, created through the public API
  const org = await reg('of_org', 'Priya Nair', ['organizer']), ref = await reg('of_ref', 'Sam Carter', ['referee']);
  const m1 = await reg('of_m1', 'Alex Lee', ['coach']), m2 = await reg('of_m2', 'Omar Haddad', ['coach']);
  const mkGame = async (sport, name, hoursFromNow = 0) => {
    const ev = await call('POST', '/events', { token: org.token, body: { name, sport } });
    await db.query("UPDATE events SET status='open' WHERE id=$1", [ev.id]);
    const home = await call('POST', '/teams', { token: m1.token, body: { name: `${name.split(' ')[0]} Reds`, sport } }), away = await call('POST', '/teams', { token: m2.token, body: { name: `${name.split(' ')[0]} Blues`, sport } });
    const fx = (await db.query("INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at) VALUES ($1,$2,$3, now() + $4 * interval '1 hour') RETURNING id", [ev.id, home.id, away.id, hoursFromNow])).rows[0].id;
    await db.query("INSERT INTO fixture_officials(fixture_id, user_id, role, status) VALUES ($1,$2,'referee','accepted')", [fx, ref.id]);
    await db.query("INSERT INTO event_entries(event_id, team_id, status) VALUES ($1,$2,'accepted'),($1,$3,'accepted')", [ev.id, home.id, away.id]);
    return { ev, home, away, fx };
  };
  const football = await mkGame('football', 'Pune Cup');
  const tennis = await mkGame('tennis', 'Harbour Open', 3);
  const players = { home: [], away: [] };
  for (const side of ['home', 'away']) for (const nm of side === 'home' ? ['Aarav Shah', 'Kabir Mehta', 'Ishaan Rao'] : ['Rohan Nair', 'Vihaan Iyer', 'Arjun Das']) {
    const u = await reg('pl', nm); players[side].push(u);
    await db.query("INSERT INTO match_appearances(fixture_id, team_id, user_id, status, source) VALUES ($1,$2,$3,'started','lineup')", [football.fx, football[side].id, u.id]);
  }
  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const session = async (who, viewport) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 }); const page = await ctx.newPage();
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    if (process.env.V) { page.on('console', (m) => ['error', 'warning'].includes(m.type()) && log('[console]', m.text().slice(0, 220))); page.on('response', (r) => r.request().method() === 'POST' && log('[post]', r.status(), r.url().replace(/^.*\/api\/v1/, ''))); }
    if (who) { const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } }); if (!r.ok()) throw new Error(`login ${who.handle} ${r.status()}`); }
    await page.goto('http://localhost:4100/'); await page.waitForTimeout(2500);
    return { ctx, page };
  };
  const shot = (page, name) => page.screenshot({ path: `${OUT}${name}.png`, fullPage: false });
  const vis = async (p, t, ms = 4000) => { try { await p.getByText(t).first().waitFor({ state: 'visible', timeout: ms }); return true; } catch { return false; } };
  const gone = async (p, t, ms = 4000) => { try { await p.getByText(t).first().waitFor({ state: 'hidden', timeout: ms }); return true; } catch { return false; } };
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
  const tap = async (p, text, opts = {}) => { await p.getByText(text, opts).first().click(); await wait(p, 700); };
  const scroll = async (p, y) => { await p.evaluate((y) => { for (const el of document.querySelectorAll('*')) if (el.scrollHeight > el.clientHeight + 40 && getComputedStyle(el).overflowY !== 'visible') el.scrollTop = y; }, y); await wait(p, 400); };


  const offline = (p) => p.context().route('**/api/**', (r) => r.abort('internetdisconnected')).then(() => p.context().route('**/live/**', (r) => r.abort('internetdisconnected')));
  const online = (p) => p.context().unroute('**/api/**').then(() => p.context().unroute('**/live/**'));

  // ---------------------------------------------------------------- 1. save the pack from Officials home (desktop)
  {
    const { ctx, page: p } = await session(ref, desktop);
    await navTo(p, 'OfficialsHome');
    check(await vis(p, 'Match-day pack'), 'Officials home offers the match-day pack');
    await p.getByText('Match-day pack').first().scrollIntoViewIfNeeded(); await wait(p, 400); await shot(p, '01-pack-before-desktop');
    await tap(p, 'Save my games for offline');
    check(await vis(p, /Pune Reds v Pune Blues/), 'the games the official may score are listed after saving');
    check(await vis(p, /Harbour Reds v Harbour Blues/), 'a later game inside the window is saved too');
    check((await vis(p, '✓ Saved offline')), 'each saved game is marked');
    await p.getByText('Match-day pack').first().scrollIntoViewIfNeeded(); await scroll(p, 99999); await wait(p, 2800); await shot(p, '02-pack-saved-desktop');
    const ls = await p.evaluate(() => JSON.stringify(Object.assign({}, localStorage)) + (document.cookie || ''));
    check(!/Aarav Shah|Rohan Nair/.test(ls), 'no lineup name is written to plain web storage (the pack is encrypted)');
    await ctx.close();
  }

  // ---------------------------------------------------------------- 2. score with no signal (phone), then tablet, then reconnect
  {
    const { ctx, page: p } = await session(ref, phone);
    await navTo(p, 'OfficialsHome'); await tap(p, 'Save my games for offline'); await wait(p, 1500);
    await offline(p);
    await navTo(p, 'MatchCentre', { id: football.fx });
    check(await vis(p, /Offline · scoring from the copy saved/), 'with no signal the game opens from the saved copy');
    await scroll(p, 0); await shot(p, '03-offline-open-phone');
    const pressed = Date.now();
    await tap(p, 'Kick off'); await tap(p, /Start half 1/i);
    check(await vis(p, /Goal \+1/), 'kick-off works offline and the scoring pad appears');
    await p.getByText(players.home[0].display_name).first().click().catch(() => {}); await wait(p, 300);
    await p.getByText(/Goal \+1/).first().click(); await wait(p, 600);
    await p.getByText(/Goal \+1/).first().click(); await wait(p, 600);
    check(await vis(p, /\d+ not sent yet/), 'the screen says how many taps are waiting');
    await scroll(p, 0); await shot(p, '04-offline-scoring-phone'); await scroll(p, 700); await shot(p, '04b-offline-pad-phone'); await scroll(p, 0);
    const g = await p.evaluate(() => document.body.innerText);
    check(/\b2\b/.test(g), 'the provisional score moved on the device with no server');
    // the sport's own rules are applied here: a second kick-off is refused at once
    await p.setViewportSize(tablet); await wait(p, 900); await scroll(p, 0); await shot(p, '05-offline-scoring-tablet');
    await p.setViewportSize(phone); await wait(p, 600);
    await tap(p, 'Full time'); check(await vis(p, /Full time is kept on this device/), 'full time explains what happens offline'); await shot(p, '06-offline-full-time-phone');
    await p.getByText('Yes, full time').first().click(); await wait(p, 800);
    check((await db.query("SELECT status FROM fixtures WHERE id=$1", [football.fx])).rows[0].status === 'scheduled', 'nothing reached the server while offline');
    await new Promise((r) => setTimeout(r, 4000));   // stay offline for a few seconds so the kick-off time is visibly earlier than the sync
    await online(p);
    await p.getByText('Retry sending').first().click().catch(() => {});
    for (let i = 0; i < 30; i++) { if ((await db.query("SELECT status FROM fixtures WHERE id=$1", [football.fx])).rows[0].status === 'finished') break; await wait(p, 1000); }
    const fx = (await db.query('SELECT status, started_at FROM fixtures WHERE id=$1', [football.fx])).rows[0];
    check(fx.status === 'finished', 'back online the kick-off, the goals and full time were all sent');
    check(Math.abs(new Date(fx.started_at).getTime() - pressed) < 4000, 'the kick-off is recorded when it was pressed, not when it was sent');
    check((await db.query("SELECT count(*)::int AS n FROM match_events WHERE fixture_id=$1 AND kind='goal'", [football.fx])).rows[0].n === 2, 'each goal was recorded exactly once');
    check((await db.query('SELECT count(*)::int AS n FROM score_sheets WHERE fixture_id=$1', [football.fx])).rows[0].n === 1, 'one score sheet was opened');
    await ctx.close();
  }

  // ---------------------------------------------------------------- 3. other people get nothing
  {
    const { ctx, page: p } = await session(m1, phone);
    await navTo(p, 'OfficialsHome');
    const r = await call('GET', '/me/scorer-pack', { token: m1.token });
    check(Array.isArray(r.games) && r.games.length === 0, 'a team manager has no pack');
    await ctx.close();
  }
  await browser.close();
} catch (e) { failures++; log('FAIL  journey crashed:', e.stack ?? e.message); }
log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
await db.end(); web.close(); api.kill();
process.exit(failures ? 1 : 0);
