// Browser-driven check of Tools > Scoring & Game Tracking (#416): the Tools tile, starting and tracking a sheet on a phone, reading an
// uploaded sheet, linking to a game, and the referee's review of the proposal. Data is created through the public API.
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

try {
  // ---------------------------------------------------------------- data, created through the public API
  const org = await reg('ts_org', 'Priya Nair', ['organizer']), ref = await reg('ts_ref', 'Sam Carter', ['referee']), m1 = await reg('ts_m1', 'Alex Lee', ['coach']), m2 = await reg('ts_m2', 'Omar Haddad', ['coach']), maya = await reg('ts_maya', 'Maya Rao');
  const ev = await call('POST', '/events', { token: org.token, body: { name: 'Pune Summer Cup', sport: 'football' } });
  await db.query("UPDATE events SET status='open' WHERE id=$1", [ev.id]);
  const home = await call('POST', '/teams', { token: m1.token, body: { name: 'Riverside FC', sport: 'football' } }), away = await call('POST', '/teams', { token: m2.token, body: { name: 'Hillside United', sport: 'football' } });
  const fx = (await db.query('INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at) VALUES ($1,$2,$3, now()) RETURNING id', [ev.id, home.id, away.id])).rows[0].id;
  await db.query("INSERT INTO fixture_officials(fixture_id, user_id, role, status) VALUES ($1,$2,'referee','accepted')", [fx, ref.id]);
  await db.query("INSERT INTO event_entries(event_id, team_id, status) VALUES ($1,$2,'accepted'),($1,$3,'accepted')", [ev.id, home.id, away.id]);
  const add = (token, id, e) => call('PATCH', `/tracking/sheets/${id}`, { token, body: { add_entry: e } });
  // Maya: a completed football sheet proposed for the game, a badminton set in progress, a football sheet in progress
  const fb = await call('POST', '/tracking/sheets', { token: maya.token, body: { sport: 'football', title: 'Riverside v Hillside', labels: { home: 'Riverside FC', away: 'Hillside United' } } });
  for (const side of ['home', 'away', 'home']) await add(maya.token, fb.id, { kind: 'goal', side, period: 1 });
  await call('POST', `/tracking/sheets/${fb.id}/complete`, { token: maya.token, body: {} });
  const prop = await call('POST', `/tracking/sheets/${fb.id}/proposals`, { token: maya.token, body: { fixture_id: fx } });
  const bd = await call('POST', '/tracking/sheets', { token: maya.token, body: { sport: 'badminton', variant: 'Singles', best_of: 3, title: 'Club night: Maya v Ben', labels: { home: 'Maya', away: 'Ben' } } });
  for (let i = 0; i < 21; i++) await add(maya.token, bd.id, { kind: 'point', side: i % 3 === 0 ? 'away' : 'home' });
  for (let i = 0; i < 25; i++) await add(maya.token, bd.id, { kind: 'point', side: i % 2 ? 'away' : 'home' }).catch(() => {});
  const fl = await call('POST', '/tracking/sheets', { token: maya.token, body: { sport: 'football', title: 'U12 practice game', labels: { home: 'Bibs', away: 'No bibs' } } });
  for (const [k, s] of [['goal', 'home'], ['foul', 'away'], ['goal', 'away'], ['yellow_card', 'home'], ['goal', 'home']]) await add(maya.token, fl.id, { kind: k, side: s, period: 1 });
  const fresh = await call('POST', '/tracking/sheets', { token: maya.token, body: { sport: 'football', title: 'Sunday kickabout' } });
  await add(maya.token, fresh.id, { kind: 'goal', side: 'home', period: 1 }); await call('POST', `/tracking/sheets/${fresh.id}/complete`, { token: maya.token, body: {} });
  // an uploaded sheet waiting for review (the reader's output is written straight to the row: this server has no AI key)
  const up = await fetch(`http://127.0.0.1:4000/api/v1/tracking/imports?sport=badminton`, { method: 'POST', headers: { authorization: `Bearer ${maya.token}` }, body: Buffer.from(`%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF ${Date.now()}`) }).then((r) => r.json());
  await db.query("UPDATE tracking_sheet_imports SET state='extracted', provider='ai', extracted=$2, confidence=$3, warnings=$4 WHERE id=$1", [up.id,
    JSON.stringify({ home: 2, away: 0, home_label: 'Maya', away_label: 'Ben', sets: [{ home: 21, away: 15 }, { home: 21, away: 22 }] }), JSON.stringify({ home: 0.96, away: 0.41, sets: 0.62 }),
    JSON.stringify([{ code: 'low_confidence', severity: 'warn', field: 'away', message: '"away" was hard to read (41% sure). Check it against the sheet.' }, { code: 'illegal_set_score', severity: 'error', field: 'totals', message: 'A set score is not a legal finish under the Badminton rules' }])]);

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
  // ---------------------------------------------------------------- Maya on a phone
  {
    const { ctx, page: p } = await session(maya, { width: 390, height: 844 });
    await p.getByLabel('More', { exact: true }).first().click(); await wait(p, 1500);
    for (let i = 0; i < 12 && !(await vis(p, 'Scoring sheets & documents', 700)); i++) { await p.keyboard.press('ArrowRight'); await wait(p, 350); }
    await wait(p, 600); await shot(p, '01-more-wheel-tools-tile');
    check(await vis(p, 'Scoring sheets & documents', 1500), 'the More swivel offers a Tools tile');
    await p.keyboard.press('Escape'); await wait(p, 600);
    await navTo(p, 'ToolsHome'); await shot(p, '02-tools-home-phone');
    check(await vis(p, 'Document Designer') && await vis(p, 'Scoring & Game Tracking'), 'Tools lists the Document Designer and Scoring & Game Tracking');
    await p.getByText('Scoring & Game Tracking').first().click(); await wait(p, 1800); await shot(p, '03-scoring-home-phone');
    check(await vis(p, 'Start new sheet') && await vis(p, 'Upload completed sheet') && await vis(p, 'Awaiting my review'), 'the scoring home offers start, upload and review');
    await p.getByText('Start new sheet').first().click(); await wait(p, 1500);
    await p.getByText('Choose a sport').first().click().catch(() => {}); await wait(p, 800);
    await p.getByPlaceholder(/Search/).first().fill('Badminton'); await wait(p, 800); await p.getByText(/Badminton/).last().click().catch((e) => log('[pick]', e.message.slice(0, 80))); await wait(p, 2500); await shot(p, '04-start-flow-phone');
    check(await vis(p, 'Just for me') && await vis(p, 'Link to a game'), 'the start flow asks standalone or linked');
    await navTo(p, 'ScoringTool', { sheetId: bd.id }); await shot(p, '05-live-tracker-badminton-phone');
    check(await vis(p, 'Unofficial / standalone'), 'a standalone sheet is labelled unofficial');
    await navTo(p, 'ScoringTool', { sheetId: fl.id }); await shot(p, '06-live-tracker-football-phone');
    await navTo(p, 'ScoringTool', { importId: up.id }); await shot(p, '07-upload-review-phone');
    check(await vis(p, 'hard to read'), 'low-confidence values are flagged for review');
    await navTo(p, 'ScoringTool', { sheetId: fresh.id });
    await p.getByText('Link to a match').first().click(); await wait(p, 2000); await shot(p, '08-link-to-game-phone');
    check(await vis(p, 'Riverside FC vs Hillside United'), 'the link flow lists the matching game');
    await ctx.close();
  }
  // ---------------------------------------------------------------- the referee reviews on a tablet
  {
    const { ctx, page: p } = await session(ref, { width: 1180, height: 1000 });
    await navTo(p, 'ScoringTool', { tab: 'awaiting' }); await shot(p, '09-awaiting-review-tablet');
    check(await vis(p, 'needs your review'), 'the referee has a proposal waiting');
    await navTo(p, 'ScoringTool', { proposalId: prop.id }); await shot(p, '10-proposal-review-tablet');
    check(await vis(p, 'Who must approve') && await vis(p, 'Approve'), 'the referee can review and approve');
    await ctx.close();
  }
  // ---------------------------------------------------------------- the organiser's event rules
  {
    const { ctx, page: p } = await session(org, { width: 1180, height: 1000 });
    await navTo(p, 'ScoringTool', { tab: 'rules', eventId: ev.id }); await shot(p, '11-event-scoring-rules-tablet');
    check(await vis(p, 'Who approves a proposed result'), 'the organiser sees the event approval policy next to the scoring rules');
    await ctx.close();
  }
  await browser.close();
} catch (e) { log('ERROR', e.message); failures++; } finally { await db.end().catch(() => {}); api.kill(); web.close(); }
process.exit(failures ? 1 : 0);
