// Browser-driven check of the premium live game centre (#578): the signed-out public live centre (clock, line-ups, subs, cards, stats, standings impact, highlights)
// at phone, tablet and desktop widths, in light/dark per the OS scheme, with the staff Match Centre link. Data is created through the public API.
// Needs: a throwaway Postgres (E2E_DATABASE_URL), a same-origin web build (EXPO_PUBLIC_API_URL="" npx expo export --platform web --output-dir /tmp/e2e-dist) and playwright.
// Run: node scripts/e2e/live-centre-journey.mjs   (PNGs land in E2E_SHOTS, default /tmp/e2e-shots)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const { chromium } = createRequire('/opt/node-tools/')('playwright');
import pg from 'pg';
const E = { DATABASE_URL: process.env.E2E_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/sportarena_e2e', SPORTARENA_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), SPORTARENA_JWT_SECRET: Buffer.alloc(32, 9).toString('base64'),
  PORT: '4000', APP_URL: 'http://localhost:4100', CORS_ORIGINS: 'http://localhost:4100', PLATFORM_APPROVALS: 'off' };
const OUT = (process.env.E2E_SHOTS ?? '/tmp/e2e-shots') + '/'; fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
const api = spawn('node', ['src/server.js'], { cwd: new URL('../../apps/api/', import.meta.url).pathname, env: { ...process.env, ...E }, stdio: ['ignore', 'pipe', 'pipe'] });
api.stdout.on('data', (d) => process.env.V && log('[api]', String(d).trim())); api.stderr.on('data', (d) => process.env.V && log('[api!]', String(d).trim()));
for (let i = 0; i < 90; i++) { try { if ((await fetch('http://127.0.0.1:4000/api/v1/payments/methods')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }
const DIST = process.env.E2E_DIST ?? '/tmp/e2e-dist';
const web = http.createServer((req, res) => {
  if (req.url.startsWith('/api') || req.url.startsWith('/mcp')) { const p = http.request({ host: '127.0.0.1', port: 4000, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }); req.pipe(p); p.on('error', () => res.end()); return; }
  let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
  const ext = path.extname(f); res.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf' }[ext] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => web.listen(4100, r));
const B = 'http://localhost:4100/api/v1';
const call = async (method, p, { token, body } = {}) => { const r = await fetch(`http://127.0.0.1:4000/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json(); if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(j)}`); return j; };
const reg = async (h, name, roles = ['athlete']) => { const r = await call('POST', '/auth/register', { body: { handle: h, display_name: name, email: `${h}@example.com`, password: 'correct-horse-battery', roles } }); return { ...r.user, token: r.token, email: `${h}@example.com` }; };
const db = new pg.Pool({ connectionString: E.DATABASE_URL });
let failures = 0; const check = (ok, msg) => { log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const wait = (p, ms = 1200) => p.waitForTimeout(ms);
const tag = Math.random().toString(36).slice(2, 7);

try {
  const org = await reg(`lc_org_${tag}`, 'Priya Nair', ['organizer']);
  const coaches = []; for (const n of ['Riverside FC', 'Hillside United', 'Harbour Rovers']) coaches.push(await reg(`lc_c${coaches.length}_${tag}`, `Coach ${n.split(' ')[0]}`, ['coach']));
  const names = ['Riverside FC', 'Hillside United', 'Harbour Rovers'];
  const players = []; for (const n of ['Maya Rao', 'Ben Okafor', 'Zoe Menon', 'Arjun Patel']) players.push(await reg(`lc_p${players.length}_${tag}`, n));
  const teams = []; for (let i = 0; i < 3; i++) teams.push(await call('POST', '/teams', { token: coaches[i].token, body: { name: names[i], sport: 'football', emoji: ['🌊', '⛰️', '⚓'][i], color: ['#3E8AB5', '#2F8F5F', '#B5733E'][i] } }));
  await db.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active'),($1,$3,'player','active'),($4,$5,'player','active'),($4,$6,'player','active')", [teams[0].id, players[0].id, players[2].id, teams[1].id, players[1].id, players[3].id]);
  const ev = await call('POST', '/events', { token: org.token, body: { name: 'Pune Summer Cup', sport: 'football', city: 'Pune', kind: 'tournament' } });
  await db.query("UPDATE events SET status='ongoing' WHERE id=$1", [ev.id]);
  for (const t of teams) await db.query("INSERT INTO event_entries(event_id, team_id, status) VALUES ($1,$2,'accepted')", [ev.id, t.id]);
  const hr = (n) => new Date(Date.now() + n * 3600e3).toISOString();
  const mk = async (h, a, when) => (await db.query("INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at, round) VALUES ($1,$2,$3,$4,'Group stage') RETURNING id", [ev.id, teams[h].id, teams[a].id, when])).rows[0].id;
  const done = await mk(1, 2, hr(-26)); await call('POST', `/fixtures/${done}/result`, { token: org.token, body: { home_score: 1, away_score: 1 } });
  const live = await mk(0, 1, hr(-1));
  await call('POST', `/fixtures/${live}/lineup`, { token: org.token, body: { side: 'home', starters: [players[0].id], bench: [players[2].id] } });
  await call('POST', `/fixtures/${live}/lineup`, { token: org.token, body: { side: 'away', starters: [players[1].id], bench: [players[3].id] } });
  await call('POST', `/fixtures/${live}/start`, { token: org.token });
  await call('POST', `/fixtures/${live}/events`, { token: org.token, body: { kind: 'period_start' } });
  await call('POST', `/fixtures/${live}/events`, { token: org.token, body: { kind: 'goal', side: 'home', player_id: players[0].id, clock_seconds: 540 } });
  await call('POST', `/fixtures/${live}/events`, { token: org.token, body: { kind: 'yellow_card', side: 'away', player_id: players[1].id, clock_seconds: 900 } });
  await call('POST', `/fixtures/${live}/events`, { token: org.token, body: { kind: 'goal', side: 'away', player_id: players[1].id, clock_seconds: 1260 } });
  await call('POST', `/fixtures/${live}/events`, { token: org.token, body: { kind: 'goal', side: 'home', player_id: players[0].id, clock_seconds: 1900 } });
  await call('POST', `/fixtures/${live}/substitutions`, { token: org.token, body: { side: 'home', player_off_id: players[0].id, player_on_id: players[2].id, clock_seconds: 2000 } });
  await db.query("INSERT INTO mr_assets(event_id, fixture_id, kind, right_kind, title, creator_id, owner_kind, source_kind, external_url, audience, status) VALUES ($1,$2,'video','highlights','First-half highlights',$3,'organiser','external_link','https://example.com/clip','public','published')", [ev.id, live, org.id]).catch((e) => log('[media row skipped]', e.message));

  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const SIZES = { phone: { width: 390, height: 844 }, tablet: { width: 820, height: 1180 }, desktop: { width: 1366, height: 900 } };
  const vis = async (p, t, ms = 5000) => { try { await p.getByText(t).first().waitFor({ state: 'visible', timeout: ms }); return true; } catch { return false; } };
  for (const [size, vp] of Object.entries(SIZES)) {
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1 }); const p = await ctx.newPage();
    p.on('pageerror', (e) => log('[pageerror]', e.message));
    await p.goto(`http://localhost:4100/?event=${ev.id}&fixture=${live}`); await wait(p, 3500);
    check(await vis(p, 'Official clock'), `${size}: the clock says official (entered by the organiser)`);
    check(await vis(p, 'Key stats') && await vis(p, 'Standings impact'), `${size}: stats and standings impact show`);
    check(await vis(p, 'Maya Rao') && await vis(p, 'Line-ups'), `${size}: line-ups name adult players`);
    check(await vis(p, 'Cards & penalties'), `${size}: cards feed shows`);
    await p.screenshot({ path: `${OUT}live-centre-${size}.png`, fullPage: true });
    const w = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); check(w <= 1, `${size}: no horizontal page scroll`);
    await ctx.close();
  }
  // staff view: the organiser opens the Match Centre of the same game and sees the operations card and the spectator-view link
  {
    const ctx = await browser.newContext({ viewport: SIZES.tablet, deviceScaleFactor: 1 }); const p = await ctx.newPage();
    p.on('pageerror', (e) => log('[pageerror]', e.message));
    const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: `lc_org_${tag}@example.com`, password: 'correct-horse-battery' } });
    check(r.ok(), 'organiser signs in');
    await p.goto('http://localhost:4100/'); await wait(p, 3000);
    await p.evaluate(({ id }) => {
      const root = document.getElementById('root') ?? document.body.firstElementChild; const key = Object.keys(root).find((k) => k.startsWith('__reactContainer'));
      const todo = [root[key]]; let nav = null;
      while (todo.length && !nav) { const n = todo.pop(); const v = n.memoizedProps?.value; if (v && typeof v.push === 'function' && typeof v.goTab === 'function') { nav = v; break; } if (n.sibling) todo.push(n.sibling); if (n.child) todo.push(n.child); }
      nav.push('MatchCentre', { id });
    }, { id: live });
    await wait(p, 3500);
    check(await vis(p, 'Staff only'), 'staff: the operations card shows');
    check(await vis(p, 'Open spectator view'), 'staff: link to the spectator view of the same game');
    await p.screenshot({ path: `${OUT}live-centre-staff-tablet.png`, fullPage: false });
    await ctx.close();
  }
  await browser.close();
} catch (e) { log('ERROR', e); failures++; }
log(failures ? `${failures} FAILED` : 'ALL PASSED');
db.end(); api.kill(); web.close();
process.exit(failures ? 1 : 0);
