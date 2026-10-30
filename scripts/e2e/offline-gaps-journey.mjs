// Browser-driven check of the offline scoring gaps (#637): a heat / final / field flight scored with no signal from the saved pack, undo and
// correct of an already-sent moment made offline and sent once on reconnect, and the "while you were away" view when another official scored.
// Phone, tablet and desktop PNGs in the app's own theme. Data is created through the public API. Same prerequisites as offline-referee-journey.mjs.
// (live-scoring-journey.mjs lists them.)
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


  const see = async (p, text) => { await p.getByText(text).first().scrollIntoViewIfNeeded().catch(() => {}); await p.evaluate(() => { for (const el of document.querySelectorAll('*')) if (el.scrollHeight > el.clientHeight + 40 && getComputedStyle(el).overflowY !== 'visible') el.scrollTop += 140; }); await wait(p, 500); };
  const offline = (p) => p.context().route('**/api/**', (r) => r.abort('internetdisconnected')).then(() => p.context().route('**/live/**', (r) => r.abort('internetdisconnected')));
  const online = (p) => p.context().unroute('**/api/**').then(() => p.context().unroute('**/live/**'));

  // ---------------------------------------------------------------- data, created through the public API
  const org = await reg('og_org', 'Priya Nair', ['organizer']), ref = await reg('og_ref', 'Sam Carter', ['referee']), ref2 = await reg('og_ref', 'Jo Alvarez', ['referee']);
  const m1 = await reg('og_m1', 'Alex Lee', ['coach']), m2 = await reg('og_m2', 'Omar Haddad', ['coach']);
  const ev = await call('POST', '/events', { token: org.token, body: { name: 'Pune Cup', sport: 'football' } });
  await db.query("UPDATE events SET status='open' WHERE id=$1", [ev.id]);
  const home = await call('POST', '/teams', { token: m1.token, body: { name: 'Pune Reds', sport: 'football' } }), away = await call('POST', '/teams', { token: m2.token, body: { name: 'Pune Blues', sport: 'football' } });
  const fx = (await db.query("INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at) VALUES ($1,$2,$3, now()) RETURNING id", [ev.id, home.id, away.id])).rows[0].id;
  for (const u of [ref, ref2]) await db.query("INSERT INTO fixture_officials(fixture_id, user_id, role, status) VALUES ($1,$2,'referee','accepted')", [fx, u.id]);
  await db.query("INSERT INTO event_entries(event_id, team_id, status) VALUES ($1,$2,'accepted'),($1,$3,'accepted')", [ev.id, home.id, away.id]);
  await call('POST', `/fixtures/${fx}/start`, { token: ref.token, body: {} });
  await call('POST', `/fixtures/${fx}/events`, { token: ref.token, body: { kind: 'period_start' } });
  await call('POST', `/fixtures/${fx}/events`, { token: ref.token, body: { kind: 'goal', side: 'home' } });
  await call('POST', `/fixtures/${fx}/events`, { token: ref.token, body: { kind: 'goal', side: 'away' } });
  // a 100 m heat the referee is assigned to
  const tev = await call('POST', '/events', { token: org.token, body: { name: 'Track Day', sport: 'multi-sport', kind: 'tournament' } });
  await call('PATCH', `/events/${tev.id}/programme`, { token: org.token, body: { public_names: true } });
  const house = await call('POST', `/events/${tev.id}/houses`, { token: org.token, body: { name: 'Red', color: '#e11' } });
  const runners = [];
  for (const nm of ['Aarav Shah', 'Kabir Mehta', 'Ishaan Rao']) runners.push(await call('POST', `/events/${tev.id}/participants`, { token: org.token, body: { full_name: nm, house_id: house.id, gender: 'male', grade: '7', roll_no: `R${runners.length}` } }));
  const disc = await call('POST', `/events/${tev.id}/disciplines`, { token: org.token, body: { sport: 'athletics', name: '100m', officials_required: 0, result_type: 'time' } });
  for (const [k, p] of runners.entries()) await call('POST', `/disciplines/${disc.id}/nominations`, { token: org.token, body: { participant_id: p.id, seed: 12 + k } });
  await call('POST', `/disciplines/${disc.id}/heats`, { token: org.token, body: { lanes: 4 } });
  const sess = (await call('GET', `/events/${tev.id}/sessions?discipline_id=${disc.id}`, { token: org.token }))[0];
  await call('PATCH', `/sessions/${sess.id}`, { token: org.token, body: { scheduled_at: new Date(Date.now() + 20 * 3600e3).toISOString(), location: 'Track' } });
  await call('POST', '/me/sport-profiles', { token: ref.token, body: { sport: 'athletics', role: 'referee' } });
  const staff = await call('POST', `/events/${tev.id}/staff`, { token: org.token, body: { user_id: ref.id, role: 'referee', sport: 'athletics' } });
  await call('POST', `/event-staff/${staff.id}/respond`, { token: ref.token, body: { response: 'accept' } });
  await call('POST', `/event-staff/${staff.id}/shifts`, { token: org.token, body: { session_id: sess.id } });

  // ---------------------------------------------------------------- 1. the pack now holds the heat too (phone, tablet, desktop)
  const { ctx, page: p } = await session(ref, phone);
  await navTo(p, 'OfficialsHome');
  await tap(p, 'Save my games for offline');
  check(await vis(p, /100m · /), 'the saved heat is listed beside the saved game');
  check(await vis(p, /Pune Reds v Pune Blues/), 'the game is listed');
  await p.getByText('Match-day pack').first().scrollIntoViewIfNeeded(); await wait(p, 800); await shot(p, '01-pack-with-heat-phone');
  await p.setViewportSize(tablet); await wait(p, 900); await p.getByText('Match-day pack').first().scrollIntoViewIfNeeded(); await shot(p, '01-pack-with-heat-tablet');
  await p.setViewportSize(desktop); await wait(p, 900); await p.getByText('Match-day pack').first().scrollIntoViewIfNeeded(); await shot(p, '01-pack-with-heat-desktop');
  await p.setViewportSize(phone); await wait(p, 600);

  // ---------------------------------------------------------------- 2. the heat, with no signal
  await offline(p);
  await p.getByText(/100m · /).first().click(); await wait(p, 1500); await p.getByText(/Offline · scoring from the copy saved/).first().scrollIntoViewIfNeeded();
  check(await vis(p, /Offline · scoring from the copy saved/), 'the heat opens from the saved copy with no signal');
  await shot(p, '02-heat-offline-phone');
  const finish = async (name, secs) => {
    await p.getByText('Finish').first().click(); await wait(p, 500);
    for (let k = 0; k < secs; k++) await p.getByRole('button', { name: 'Seconds more' }).click();
    await p.getByRole('button', { name: 'Record', exact: true }).last().click({ force: true }); await wait(p, 700);
  };
  await finish('first', 12); await finish('second', 11);
  check(await vis(p, /\d+ not sent yet/), 'the entries wait on the device and the screen says so');
  await shot(p, '03-heat-provisional-phone');
  await p.setViewportSize(tablet); await wait(p, 900); await see(p, /Aarav Shah/); await shot(p, '03-heat-provisional-tablet');
  await p.setViewportSize(desktop); await wait(p, 900); await see(p, /Aarav Shah/); await shot(p, '03-heat-provisional-desktop');
  await p.setViewportSize(phone); await wait(p, 1200);
  await see(p, 'Undo last entry'); await p.getByText('Undo last entry').first().click({ force: true }); await wait(p, 800);
  await see(p, /Aarav Shah/); await shot(p, '04-heat-undo-offline-phone');
  const before = (await db.query('SELECT count(*)::int AS n FROM session_events WHERE session_id=$1', [sess.id])).rows[0].n;
  check(before === 0, 'nothing reached the server while offline');

  // ---------------------------------------------------------------- 3. undo of an already-sent goal, offline, and a conflict
  await navTo(p, 'MatchCentre', { id: fx });
  check(await vis(p, /Offline · scoring from the copy saved/), 'the game opens from the saved copy');
  await p.getByText('Undo last').first().click(); await wait(p, 600);
  await p.getByText('Wrong team').first().click(); await wait(p, 300);
  await p.getByText('Void it').first().click(); await wait(p, 900);
  check(await vis(p, /Waiting to be sent/), 'the undo of a moment that was already sent shows at once and waits');
  await shot(p, '05-undo-sent-offline-phone');
  await p.setViewportSize(tablet); await wait(p, 900); await shot(p, '05-undo-sent-offline-tablet');
  await p.setViewportSize(desktop); await wait(p, 900); await shot(p, '05-undo-sent-offline-desktop');
  await p.setViewportSize(phone); await wait(p, 600);
  // back online: the undo is sent once, in order
  await online(p);
  await p.getByText('Retry sending').first().click().catch(() => {});
  for (let k = 0; k < 20; k++) { if ((await db.query("SELECT count(*)::int AS n FROM match_event_revisions WHERE fixture_id=$1 AND action='void'", [fx])).rows[0].n === 1) break; await wait(p, 1000); }
  check((await db.query("SELECT count(*)::int AS n FROM match_event_revisions WHERE fixture_id=$1 AND action='void'", [fx])).rows[0].n === 1, 'the undo was sent once, in order, when the signal returned');

  // the heat's entry waits on its own queue and is sent once the heat is opened again online
  await navTo(p, 'OfficialsHome'); await wait(p, 800);
  await p.getByText(/100m · /).first().click(); await wait(p, 3500);
  const fin = (await db.query("SELECT count(*)::int AS n FROM session_events WHERE session_id=$1 AND kind='finish' AND voided_at IS NULL", [sess.id])).rows[0].n;
  check(fin === 1, 'the heat entry that was not undone reached the server once');

  // a tap made offline while another official scores: nothing is added blindly
  await navTo(p, 'MatchCentre', { id: fx }); await wait(p, 1500);
  await offline(p); await wait(p, 600);
  await p.getByText(/Goal \+1/).first().click(); await wait(p, 600);
  await call('POST', `/fixtures/${fx}/events`, { token: ref2.token, body: { kind: 'goal', side: 'home' } });
  await call('POST', `/fixtures/${fx}/events`, { token: ref2.token, body: { kind: 'yellow_card', side: 'away' } });
  await online(p);
  await p.getByText('Retry sending').first().click().catch(() => {});
  check(await vis(p, 'The game moved on', 20000), 'the held tap asks what to do');
  check(await vis(p, 'While you were away'), 'and lists what the other official scored');
  await wait(p, 1000); await shot(p, '06-conflict-while-away-phone');
  await p.setViewportSize(tablet); await wait(p, 900); await shot(p, '06-conflict-while-away-tablet');
  await p.setViewportSize(desktop); await wait(p, 900); await shot(p, '06-conflict-while-away-desktop');
  await ctx.close();

  await browser.close();
} catch (e) { failures++; log('FAIL  journey crashed:', e.stack ?? e.message); }
log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
await db.end(); web.close(); api.kill();
process.exit(failures ? 1 : 0);
