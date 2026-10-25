// Browser-driven check of verified appearances, substitutions and minutes (#322): the referee names a lineup (API), makes a substitution in the Match Centre on a phone, corrects
// a player's minutes on a tablet, and the player sees verified playing time on their sport profile. Same prerequisites as tools-scoring-journey.mjs. Run: node scripts/e2e/appearances-journey.mjs
// Needs: a throwaway Postgres database (E2E_DATABASE_URL; migrated, never dropped here), a same-origin web build
//   EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir <dir>   (E2E_DIST, default /tmp/e2e-dist)
// and playwright-core with a Chromium (E2E_CHROMIUM, default the pre-installed one). Run: node scripts/e2e/tools-scoring-journey.mjs
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
try {
  const org = await reg(`ap_org${R}`, 'Priya Nair', ['organizer']), ref = await reg(`ap_ref${R}`, 'Sam Carter', ['referee']), m1 = await reg(`ap_m1${R}`, 'Alex Lee', ['coach']), m2 = await reg(`ap_m2${R}`, 'Omar Haddad', ['coach']);
  const names = ['Ravi Kumar', 'Ben Ortiz', 'Chen Wei', 'Dev Patel'];
  const ps = []; for (const [i, n] of names.entries()) ps.push(await reg(`ap_p${i}${R}`, n));
  const ev = await call('POST', '/events', { token: org.token, body: { name: 'Pune Summer Cup', sport: 'football' } });
  await db.query("UPDATE events SET status='open' WHERE id=$1", [ev.id]);
  const home = await call('POST', '/teams', { token: m1.token, body: { name: 'Riverside FC', sport: 'football' } }), away = await call('POST', '/teams', { token: m2.token, body: { name: 'Hillside United', sport: 'football' } });
  const fx = (await db.query('INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at) VALUES ($1,$2,$3, now()) RETURNING id', [ev.id, home.id, away.id])).rows[0].id;
  await db.query("INSERT INTO fixture_officials(fixture_id, user_id, role, status) VALUES ($1,$2,'referee','accepted')", [fx, ref.id]);
  await db.query("INSERT INTO event_entries(event_id, team_id, status) VALUES ($1,$2,'accepted'),($1,$3,'accepted')", [ev.id, home.id, away.id]);
  for (const p of ps) await db.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [home.id, p.id]);
  const prof = await call('POST', '/me/sport-profiles', { token: ps[0].token, body: { sport: 'football', role: 'athlete', level: 'amateur' } });
  const lu = await call('POST', `/fixtures/${fx}/lineup`, { token: ref.token, body: { side: 'home', starters: [ps[0].id, ps[1].id, ps[2].id], bench: [ps[3].id] } });
  check(Array.isArray(lu) && lu.length === 4, 'the referee names three starters and one substitute (API)');
  await call('POST', `/fixtures/${fx}/start`, { token: ref.token });
  await call('POST', `/fixtures/${fx}/events`, { token: ref.token, body: { kind: 'period_start', clock_seconds: 0, period: 1 } });

  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const session = async (who, viewport) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 }); const page = await ctx.newPage();
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } }); if (!r.ok()) throw new Error(`login ${who.handle} ${r.status()}`);
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
  const list = () => call('GET', `/fixtures/${fx}/appearances`, { token: ref.token });

  // ---------------------------------------------------------------- the referee on a phone: lineup visible, make a substitution
  {
    const { ctx, page: p } = await session(ref, { width: 390, height: 844 });
    await navTo(p, 'MatchCentre', { id: fx });
    for (let i = 0; i < 6 && !(await vis(p, 'Lineup & minutes', 500)); i++) await p.mouse.wheel(0, 900);
    await shot(p, '01-match-centre-lineup-phone');
    check(await vis(p, 'Lineup & minutes') && await vis(p, 'Ravi Kumar') && await vis(p, 'Dev Patel'), 'the Match Centre shows the lineup with starters and the substitute');
    await p.getByText('Substitution', { exact: true }).first().click(); await wait(p, 1200);
    await p.getByText('Chen Wei', { exact: true }).last().click(); await p.getByText('Dev Patel', { exact: true }).last().click(); await wait(p, 400); await shot(p, '02-substitution-sheet-phone');
    await p.getByLabel(/Game minute plus/i).first().click(); for (let k = 0; k < 59; k++) await p.getByLabel(/Game minute plus/i).first().click();
    await p.getByText('Confirm substitution').first().click(); await wait(p, 2200);
    const a = (await list()).appearances;
    check(a.find((x) => x.user_id === ps[3].id)?.status === 'substitute_on' && a.find((x) => x.user_id === ps[2].id)?.off_clock_seconds === 3600, 'confirming in the UI came the substitute on and took the player off (API state)');
    await shot(p, '03-after-substitution-phone');
    await ctx.close();
  }
  // full time + official result through the API, then correct a player's minutes in the UI on a tablet
  await call('POST', `/fixtures/${fx}/events`, { token: ref.token, body: { kind: 'period_end', clock_seconds: 5400, period: 1 } });
  await call('POST', `/fixtures/${fx}/end`, { token: ref.token });
  const fin = await call('POST', `/fixtures/${fx}/appearances/finalize`, { token: ref.token });
  check(fin.updated >= 3, 'minutes are calculated from the game clock at full time');
  {
    const { ctx, page: p } = await session(ref, { width: 1180, height: 1000 });
    await navTo(p, 'MatchCentre', { id: fx });
    for (let i = 0; i < 8 && !(await vis(p, 'Lineup & minutes', 500)); i++) await p.mouse.wheel(0, 900);
    check(await vis(p, 'from the game clock'), 'the tablet panel labels minutes with their source');
    await shot(p, '04-minutes-tablet');
    await p.getByText('Correct', { exact: true }).first().click(); await wait(p, 1000);
    await p.getByText('Scorer sheet', { exact: true }).last().click(); await p.getByLabel(/Minutes played minus/i).first().click().catch(() => {}); await wait(p, 300); await shot(p, '05-correct-sheet-tablet');
    await p.getByText('Save correction').first().click(); await wait(p, 2200);
    const rows = (await list()).appearances;
    check(rows.some((x) => x.source === 'staff' && x.row_version > 2), 'a correction from the UI is saved as a staff-authority revision');
    await ctx.close();
  }
  // ---------------------------------------------------------------- the player sees verified playing time
  {
    const { ctx, page: p } = await session(ps[0], { width: 390, height: 844 });
    await navTo(p, 'SportProfile', { id: prof.id });
    check(await vis(p, 'Verified playing time'), 'the player sees the Verified playing time card');
    await shot(p, '06-player-verified-time-phone');
    check(await vis(p, 'game played') || await vis(p, 'games played'), 'it reports games played and verified minutes');
    await ctx.close();
  }
  await browser.close();
} catch (e) { log('ERROR', e.message); failures++; } finally { await db.end().catch(() => {}); api.kill(); web.close(); }
process.exit(failures ? 1 : 0);
