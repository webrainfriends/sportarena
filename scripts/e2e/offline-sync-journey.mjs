// Browser-driven check of offline player capture and sync (#336): a match log saved with no connection is encrypted on the device,
// shown in the queue, uploaded exactly once when the connection returns, a conflicting edit is settled in the UI on phone and tablet,
// and the device list is reachable from Security. All data is created through the public API.
// Needs: a throwaway Postgres database (E2E_DATABASE_URL; migrated, never dropped here), a same-origin web build
//   EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir <dir>   (E2E_DIST, default /tmp/e2e-dist)
// and playwright with a Chromium (E2E_CHROMIUM, default the pre-installed one). Run: node scripts/e2e/offline-sync-journey.mjs
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
const sync = (u, ops, id = 'e2e-other-device') => call('POST', '/me/sync', { token: u.token, body: { device: { id, label: 'Other tablet', platform: 'ipados' }, ops } });
try {
  const a = await reg(`os_a${R}`, 'Asha Rao');
  const prof = await call('POST', '/me/sport-profiles', { token: a.token, body: { sport: 'football', role: 'athlete', level: 'amateur' } });
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
      if (name === '@tab') window.__nav.goTab(params.tab); else window.__nav.push(name, params);
    }, { name, params });
    await wait(p, 2200);
  };
  const rawDrafts = (p) => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('sa_offline'); r.onsuccess = () => { const t = r.result.transaction('drafts', 'readonly').objectStore('drafts').getAll(); t.onsuccess = () => res(JSON.stringify(t.result)); }; r.onerror = () => res('ERR'); }));
  const matchId = async () => (await db.query('SELECT id FROM player_matches WHERE user_id=$1', [a.id])).rows[0].id;

  // ---------------------------------------------------------------- phone: log a match with no connection
  {
    const { ctx, page: p } = await session(a, { width: 390, height: 844 });
    await navTo(p, 'SportProfile', { id: prof.id });
    await ctx.setOffline(true); await wait(p, 600);
    await p.getByText(/\+ Log/).first().click(); await wait(p, 1200);
    check(await vis(p, 'No connection. This saves as an encrypted draft'), 'the form says it will save a draft on this device');
    check(await vis(p, 'Save draft on this device'), 'the button says what will happen');
    await p.getByLabel('Opponent', { exact: true }).first().fill('Zebra Rovers'); await wait(p, 300);
    await shot(p, '01-log-match-offline-phone');
    await p.getByText('Save draft on this device').last().click(); await wait(p, 1800);
    check(await vis(p, 'Saved on this device'), 'saving offline confirms it is kept on the device');
    const raw = await rawDrafts(p);
    check(raw.length > 20 && !raw.includes('Zebra') && !raw.includes('football'), 'the draft in browser storage is encrypted (no readable text)');
    check((await db.query('SELECT count(*)::int AS n FROM player_matches WHERE user_id=$1', [a.id])).rows[0].n === 0, 'nothing reached the server while offline');
    await navTo(p, 'OfflineSync');
    check(await vis(p, 'Waiting', 3000), 'the queue lists the draft as waiting'); check(await vis(p, 'No connection', 3000), 'the queue says there is no connection');
    await shot(p, '02-queue-offline-phone');
    await ctx.setOffline(false);
    check(await vis(p, 'Everything is uploaded', 25000), 'it uploads by itself when the connection returns');
    const rows = (await db.query('SELECT client_key, opponent, row_version FROM player_matches WHERE user_id=$1', [a.id])).rows;
    check(rows.length === 1 && rows[0].opponent === 'Zebra Rovers' && !!rows[0].client_key, 'exactly one match was created, with its idempotency key');
    check((await rawDrafts(p)) === '[]', 'the draft was removed from the device after upload');
    await shot(p, '03-queue-uploaded-phone');
    // another device edits first, then the phone's out-of-date edit arrives
    const mid = await matchId();
    await sync(a, [{ kind: 'match_update', client_key: key(), target_id: mid, base_version: 1, changes: { minutes: 74 } }]);
    const c1 = (await sync(a, [{ kind: 'match_update', client_key: key(), target_id: mid, base_version: 1, changes: { minutes: 85, notes: 'Played on the wing' } }])).results[0];
    check(c1.status === 'conflict', 'an edit from an out-of-date copy is held as a conflict (API)');
    await p.reload(); await wait(p, 2500); await navTo(p, 'OfflineSync');
    check(await vis(p, 'changed on another device'), 'the conflict is listed under Needs a decision');
    await p.getByText('Review').first().click(); await wait(p, 1200);
    check((await vis(p, 'This draft')) && (await vis(p, 'On the server')), 'both versions are shown side by side');
    await shot(p, '04-conflict-phone');
    await p.getByText(/Using my minutes played/i).first().click(); await wait(p, 300); // take the server's minutes, keep my notes
    await p.getByText('Apply my field choices').first().click(); await wait(p, 1800);
    const m1 = (await db.query('SELECT minutes, notes, row_version FROM player_matches WHERE id=$1', [mid])).rows[0];
    check(m1.minutes === 74 && m1.notes === 'Played on the wing', 'choosing fields applied only the chosen ones');
    check((await db.query('SELECT count(*)::int AS n FROM player_match_revisions WHERE match_id=$1', [mid])).rows[0].n >= 2, 'every replaced version is kept in the history');
    await ctx.close();
  }
  // ---------------------------------------------------------------- tablet: queue and conflict side by side, then devices in Security
  {
    const mid = await matchId();
    const v = (await db.query('SELECT row_version FROM player_matches WHERE id=$1', [mid])).rows[0].row_version;
    await sync(a, [{ kind: 'match_update', client_key: key(), target_id: mid, base_version: v - 1, changes: { minutes: 60 } }]);
    const { ctx, page: p } = await session(a, { width: 820, height: 1180 });
    await navTo(p, 'OfflineSync');
    check(await vis(p, 'Choose an item that needs a decision'), 'tablet shows the queue and a detail pane together');
    await p.getByText('Review').first().click(); await wait(p, 1000);
    check(await vis(p, 'This draft'), 'tablet shows the comparison in the side pane');
    await shot(p, '05-conflict-tablet');
    await p.getByText('Keep server version').first().click(); await wait(p, 1500);
    check((await db.query("SELECT count(*)::int AS n FROM sync_operations WHERE user_id=$1 AND status='resolved' AND resolution='keep_server'", [a.id])).rows[0].n === 1, 'keeping the server version closes the conflict and keeps the draft');
    await navTo(p, '@tab', { tab: 'Me' });
    check(await vis(p, 'Offline sync devices'), 'devices are listed in Security');
    await p.getByText('Offline sync devices').first().scrollIntoViewIfNeeded(); await wait(p, 500); await shot(p, '06-devices-tablet');
    await ctx.close();
  }
  await browser.close();
} catch (e) { log('ERROR', e.message); failures++; } finally { await db.end().catch(() => {}); api.kill(); web.close(); }
process.exit(failures ? 1 : 0);
