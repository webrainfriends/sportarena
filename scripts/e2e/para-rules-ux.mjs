// Photographs the para rules screens (#834) from the real app at phone, tablet and desktop widths with real data created through the API.
//   EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir /tmp/e2e-dist
//   E2E_DATABASE_URL=postgres://root@/sportarena_e2e?host=/var/run/postgresql UX_SHOTS=docs/ux node scripts/e2e/para-rules-ux.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const { chromium } = (() => { for (const n of [process.env.PLAYWRIGHT_PATH, 'playwright-core', 'playwright']) { if (!n) continue; try { return req(n); } catch {} } throw new Error('playwright is not installed'); })();
import pg from 'pg';



const API_DIR = new URL('../../apps/api/', import.meta.url).pathname;
const DB = process.env.E2E_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/sportarena_e2e';
const E = { DATABASE_URL: DB, SPORTARENA_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), SPORTARENA_JWT_SECRET: Buffer.alloc(32, 9).toString('base64'), PORT: '4000', APP_URL: 'http://localhost:4100', CORS_ORIGINS: 'http://localhost:4100', PLATFORM_APPROVALS: 'off', RATE_LIMIT_DISABLED: 'true' };
const OUT = process.env.UX_SHOTS ?? 'docs/ux'; fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
execFileSync('node', ['src/migrate.js'], { cwd: API_DIR, env: { ...process.env, ...E }, stdio: 'inherit' });
const api = spawn('node', ['src/server.js'], { cwd: API_DIR, env: { ...process.env, ...E }, stdio: ['ignore', 'pipe', 'pipe'] });
api.stderr.on('data', (d) => process.env.V && log('[api!]', String(d).trim()));
for (let i = 0; i < 60; i++) { try { if ((await fetch('http://127.0.0.1:4000/api/v1/payments/methods')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }
const DIST = process.env.E2E_DIST ?? '/tmp/e2e-dist';
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf', '.webmanifest': 'application/json' };
const web = http.createServer((req, res) => {
  if (req.url.startsWith('/api') || req.url.startsWith('/mcp')) {
    const p = http.request({ host: '127.0.0.1', port: 4000, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    p.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(p); return;
  }
  let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => web.listen(4100, r));

const call = async (method, p, { token, body } = {}) => {
  const r = await fetch(`http://127.0.0.1:4000/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) { log(`  ! ${method} ${p} -> ${r.status} ${t.slice(0, 200)}`); return null; }
  return j;
};
const stamp = Date.now().toString(36);
const reg = async (h, name, roles) => { const r = await call('POST', '/auth/register', { body: { handle: `${h}_${stamp}`, display_name: name, email: `${h}_${stamp}@example.com`, password: 'correct-horse-battery', roles } }); return { ...r.user, token: r.token, email: `${h}_${stamp}@example.com`, handle: `${h}_${stamp}` }; };
const wait = (p, ms = 1500) => p.waitForTimeout(ms);
const click = async (p, text, opts = {}) => { await p.getByText(text, { exact: true, ...opts }).first().click({ timeout: 8000 }); await wait(p, 1500); };
const db = new pg.Pool({ connectionString: DB });
let failures = 0;
try {
  // a wheelchair-basketball competition, two teams, classified athletes (governed outcomes inserted as the authority would issue them), a pack and an invalid lineup
  const org = await reg('para_org', 'Marta Ortega', ['organizer']), mgr = await reg('para_mgr', 'Luis Prieto', ['athlete']), mgr2 = await reg('para_mgr2', 'Ana Vidal', ['athlete']);
  const team = await call('POST', '/teams', { token: mgr.token, body: { name: 'Madrid Rollers', sport: 'wheelchair-basketball' } });
  const rival = await call('POST', '/teams', { token: mgr2.token, body: { name: 'Barcelona Chairs', sport: 'wheelchair-basketball' } });
  const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const ev = await call('POST', '/events', { token: org.token, body: { name: 'Spring Para Cup', sport: 'wheelchair-basketball', starts_on: day(5), ends_on: day(30) } });
  for (const [t, tok] of [[team, mgr.token], [rival, mgr2.token]]) { const en = await call('POST', `/events/${ev.id}/entries`, { token: tok, body: { team_id: t.id } }); await call('PATCH', `/entries/${en.id}`, { token: org.token, body: { status: 'accepted' } }); }
  const fx = await call('POST', `/events/${ev.id}/fixtures`, { token: org.token, body: { home_team_id: team.id, away_team_id: rival.id, scheduled_at: new Date(Date.now() + 3 * 864e5).toISOString() } });
  const sportId = (await db.query("SELECT id FROM sports WHERE slug='wheelchair-basketball'")).rows[0].id;
  const o = (await db.query("INSERT INTO organisations(name, created_by) VALUES ('International Wheelchair Basketball Federation',$1) RETURNING id", [org.id])).rows[0];
  const gb = (await db.query("INSERT INTO governing_bodies(organisation_id, level, abbreviation, created_by) VALUES ($1,'international',$3,$2) RETURNING id", [o.id, org.id, `W${stamp.toUpperCase().slice(-6)}`])).rows[0];
  const ver = (await db.query("INSERT INTO para_class_versions(body_id, sport_id, version, title, source_ref, effective_from, status, created_by) VALUES ($1,$2,1,'IWBF classification','IWBF handbook','2020-01-01','draft',$3) RETURNING id", [gb.id, sportId, org.id])).rows[0];
  for (const c of ['1', '1.5', '2', '2.5', '3', '3.5', '4', '4.5']) await db.query("INSERT INTO para_classes(version_id, code, name) VALUES ($1,$2,$3)", [ver.id, c, `Class ${c}`]);
  await db.query("UPDATE para_class_versions SET status='published', published_by=$2, published_at=now() WHERE id=$1", [ver.id, org.id]);
  const players = [];
  for (const [name, code, t, tok] of [['Alejandro Ruiz', '4.5', team, mgr], ['Lucia Moreno', '4', team, mgr], ['Jordi Pons', '3', team, mgr], ['David Soler', '2', team, mgr], ['Marc Vidal', '1.5', team, mgr], ['Sergio Gil', '3.5', rival, mgr2], ['Irene Mora', '3', rival, mgr2], ['Pau Ferrer', '2.5', rival, mgr2], ['Nuria Vega', '2', rival, mgr2], ['Hugo Rey', '1', rival, mgr2]]) {
    const p = await reg(name.split(' ')[1].toLowerCase(), name, ['athlete']);
    await call('POST', `/teams/${t.id}/members`, { token: tok.token, body: { user_id: p.id } });
    await db.query("INSERT INTO para_outcomes(athlete_id, sport_id, version_id, class_code, status, effective_from, authority_id, decision_ref, issued_by, review_by) VALUES ($1,$2,$3,$4,'confirmed','2020-01-01',$5,$6,$7,$8)", [p.id, sportId, ver.id, code, gb.id, `IWBF-${code}-${players.length}`, org.id, code === '4' ? day(27) : null]);
    const r = await call('POST', `/events/${ev.id}/registrations`, { token: tok.token, body: { team_id: t.id, user_id: p.id } });
    await call('POST', `/registrations/${r.id}/review`, { token: org.token, body: { action: 'register', row_version: r.row_version } });
    players.push({ ...p, team: t });
  }
  const pack = await call('POST', `/events/${ev.id}/para/rule-packs`, { token: org.token, body: { title: 'IWBF Official Rules', publisher: 'IWBF', source_ref: 'IWBF handbook §C.3', expected_version: 0,
    definition: { classes: ['1', '1.5', '2', '2.5', '3', '3.5', '4', '4.5'].map((code) => ({ code, points: Number(code) })), rules: [{ id: 'cap', type: 'class_points_cap', max: 14, label: 'On-court class points' }, { id: 'five', type: 'composition', min: 5, max: 5, label: 'Players on court' }] } } });
  await call('POST', `/events/${ev.id}/registration/policy`, { token: org.token, body: { expected_version: 0, rules: { para_pack_id: pack.id, require_guardian_consent: false, require_compliance: false } } });
  const squad = (t, tok, ps) => call('POST', `/teams/${t.id}/squad`, { token: tok.token, body: { fixture_id: fx.id, members: ps.map((p) => ({ user_id: p.id, role: 'player' })) } });
  await squad(team, mgr, players.filter((p) => p.team === team).map((p, i) => p)); await squad(rival, mgr2, players.filter((p) => p.team === rival));
  await call('POST', `/events/${ev.id}/para/overrides`, { token: mgr.token, body: { team_id: team.id, rule_id: 'cap', fixture_id: fx.id, reason: 'Class review pending' } });

  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const open = async (viewport, who, dark = false) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 }); const page = await ctx.newPage();
    if (dark) await ctx.addInitScript(() => { try { localStorage.setItem('theme', 'dark'); } catch {} });
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    const r = await ctx.request.post('http://localhost:4100/api/v1/auth/login', { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } });
    if (!r.ok()) throw new Error(`login ${r.status()}`);
    await page.goto('http://localhost:4100/'); await wait(page, 2500);
    return page;
  };
  const navTo = async (p, name, params = {}) => {
    await p.evaluate(({ name, params }) => {
      if (!window.__nav) {
        const root = document.getElementById('root') ?? document.body.firstElementChild, key = Object.keys(root).find((k) => k.startsWith('__reactContainer')), todo = [root[key]];
        while (todo.length && !window.__nav) { const n = todo.pop(); const v = n.memoizedProps?.value; if (v && typeof v.push === 'function' && typeof v.goTab === 'function' && v.tab === undefined) { window.__nav = v; break; } if (n.sibling) todo.push(n.sibling); if (n.child) todo.push(n.child); }
      }
      window.__nav.push(name, params);
    }, { name, params });
    await wait(p, 2500);
  };
  const SIZES = { phone: { width: 390, height: 844 }, tablet: { width: 820, height: 1180 }, desktop: { width: 1280, height: 900 } };
  const shot = async (name, size, fn, { who = org, dark = false, full = false } = {}) => {
    const page = await open(SIZES[size], who, dark);
    try { await fn(page); await page.screenshot({ path: path.join(OUT, `para-${name}-${size}${dark ? '-dark' : ''}.png`), fullPage: full }); log(`PASS  ${name} ${size}${dark ? ' dark' : ''}`); }
    catch (e) { failures++; log(`FAIL  ${name} ${size}: ${e.message.split('\n')[0]}`); await page.screenshot({ path: `/tmp/para-fail-${name}-${size}.png` }); }
    await page.context().close();
  };
  const registration = async (p, who) => { await navTo(p, 'EventCommand', { id: ev.id }); await click(p, 'Registration'); };
  const paraTab = async (p, tab) => { await registration(p); await click(p, 'Para rules'); if (tab) await click(p, tab); };
  for (const size of ['phone', 'tablet', 'desktop']) {
    await shot('1-rules', size, (p) => paraTab(p), { full: size === 'phone' });
    await shot('2-lineup', size, async (p) => { await paraTab(p, 'Lineup check'); await click(p, 'Match'); await p.getByText('Madrid Rollers', { exact: false }).first().click(); await wait(p); await click(p, 'Team'); await p.getByText('Madrid Rollers', { exact: true }).last().click(); await wait(p, 2500); }, { who: mgr, full: true });
    await shot('3-overrides', size, (p) => paraTab(p, 'Overrides'));
    await shot('4-entries', size, (p) => paraTab(p, 'Entries'), { full: size === 'phone' });
  }
  await browser.close();
} catch (e) { failures++; log('ERROR', e.stack); }
api.kill(); web.close(); await db.end();
log(failures ? `${failures} failure(s)` : 'all screens photographed');
process.exit(failures ? 1 : 0);
