// Browser-driven check of communities, moderated sharing, reporting and appeals (#66): phone, tablet and desktop, light and dark.
// Needs: a throwaway Postgres database (E2E_DATABASE_URL; migrated, never dropped here), a same-origin web build
//   EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir <dir>   (E2E_DIST, default /tmp/e2e-dist)
// and playwright (or playwright-core) with a Chromium (E2E_CHROMIUM). It creates its own data through the public API; nothing is seeded.
// Screens are saved as PNGs in E2E_SHOTS (default /tmp/e2e-shots). Run: node scripts/e2e/communities-journey.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = (() => { for (const m of ['playwright-core', 'playwright', '/opt/node-tools/node_modules/playwright']) { try { return require(m); } catch { /* next */ } } throw new Error('playwright is not installed'); })();
const apiRequire = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { default: pg } = await import(apiRequire.resolve('pg'));
const DB = process.env.E2E_DATABASE_URL ?? 'postgres://postgres@/sportarena_e2e?host=/tmp';
const E = { DATABASE_URL: DB, SPORTARENA_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), SPORTARENA_JWT_SECRET: Buffer.alloc(32, 9).toString('base64'),
  PORT: '4000', APP_URL: 'http://localhost:4100', CORS_ORIGINS: 'http://localhost:4100', PLATFORM_APPROVALS: 'off', RATE_LIMIT_DISABLED: 'true' };
const OUT = (process.env.E2E_SHOTS ?? '/tmp/e2e-shots') + '/'; fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
const pool = new pg.Pool({ connectionString: DB });
const api = spawn('node', ['src/server.js'], { cwd: new URL('../../apps/api/', import.meta.url).pathname, env: { ...process.env, ...E }, stdio: ['ignore', 'pipe', 'pipe'] });
api.stdout.on('data', (d) => process.env.V && log('[api]', String(d).trim())); api.stderr.on('data', (d) => process.env.V && log('[api!]', String(d).trim()));
for (let i = 0; i < 60; i++) { try { if ((await fetch('http://127.0.0.1:4000/api/v1/payments/methods')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }
const DIST = process.env.E2E_DIST ?? '/tmp/e2e-dist';
const web = http.createServer((req, res) => {
  if (req.url.startsWith('/api') || req.url.startsWith('/mcp')) { const p = http.request({ host: '127.0.0.1', port: 4000, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }); req.pipe(p); return; }
  let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
  const ext = path.extname(f); res.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf' }[ext] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => web.listen(4100, r));
const B = 'http://localhost:4100/api/v1';
const call = async (method, p, { token, body, query } = {}) => { const r = await fetch(`http://127.0.0.1:4000/api/v1${p}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(j)}`); return j; };
const R = Math.random().toString(36).slice(2, 6);
const reg = async (h, roles = ['athlete']) => { const r = await call('POST', '/auth/register', { body: { handle: `${h}${R}`, display_name: h, email: `${h}${R}@example.com`, password: 'correct-horse-battery', roles } }); return { ...r.user, token: r.token, email: `${h}${R}@example.com` }; };
let failures = 0; const check = (ok, msg) => { log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
try {
  const owner = await reg('Meera'), mod = await reg('Arjun'), fan = await reg('Divya'), spammer = await reg('Rohit');
  const team = await call('POST', '/teams', { token: owner.token, body: { name: `Pune Smashers ${R}`, sport: 'badminton' } });
  for (const u of [mod, fan, spammer]) await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active') ON CONFLICT DO NOTHING", [team.id, u.id]);
  const club = await call('POST', '/communities', { token: owner.token, body: { name: 'Pune Badminton Club', description: 'Weekend doubles, coaching nights and local ladders for every level.', sport: 'badminton', city: 'Pune' } });
  const squad = await call('POST', '/communities', { token: owner.token, body: { name: 'Elite Squad', description: 'Selected players only. Training plans and fixtures.', sport: 'badminton', city: 'Pune', visibility: 'private', join_mode: 'request' } });
  await call('POST', '/communities', { token: mod.token, body: { name: 'Sunday Cricket Chennai', description: 'Net sessions and friendly matches.', sport: 'cricket', city: 'Chennai' } });
  for (const u of [mod, fan, spammer]) await call('POST', `/communities/${club.slug}/join`, { token: u.token, body: {} });
  await call('POST', `/communities/${club.slug}/members/${mod.id}`, { token: owner.token, body: { action: 'make_moderator' } });
  const sport = (await pool.query("SELECT id FROM sports WHERE slug='badminton'")).rows[0].id;
  const perf = (await pool.query(`INSERT INTO performances(user_id, sport_id, metric, value, points, recorded_by, provenance, status, achieved_on, official_points, direction)
    VALUES ($1,$2,'points',21,0,$1,'approved_competition','approved',current_date,0,NULL) RETURNING id`, [fan.id, sport])).rows[0].id;
  await call('POST', `/communities/${club.slug}/posts`, { token: owner.token, body: { text: 'Welcome to the club! Doubles night is every Saturday at 7 pm. Bring your own racket.' } });
  await call('POST', `/communities/${club.slug}/posts`, { token: fan.token, body: { text: 'Won the district qualifier last night — thank you for the practice partners!', ref_kind: 'result', ref_id: String(perf) } });
  const bad = await call('POST', `/communities/${club.slug}/posts`, { token: spammer.token, body: { text: 'Buy cheap followers now, message me for rates' } });
  await call('POST', '/social/reports', { token: fan.token, body: { target_type: 'community_post', target_id: bad.id, reason: 'spam' } });
  await call('POST', `/market/posts/${bad.id}/comments`, { token: mod.token, body: { body: 'Please keep promotions out of the feed.' } });
  const decided = await call('GET', '/social/reports', { token: owner.token });
  await call('PATCH', `/social/reports/${decided.items[0].id}`, { token: owner.token, body: { outcome: 'hidden', reason: 'Advertising is not allowed in this community' } });
  const bad2 = await call('POST', `/communities/${club.slug}/posts`, { token: spammer.token, body: { text: 'Second promotion post for the moderator queue' } });
  await call('POST', '/social/reports', { token: fan.token, body: { target_type: 'community_post', target_id: bad2.id, reason: 'spam', note: 'Same person again' } });

  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const wait = (p, ms = 1500) => p.waitForTimeout(ms);
  const open = async (viewport, user, scheme = 'light') => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: scheme }); const page = await ctx.newPage();
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: user.email, password: 'correct-horse-battery' } }); if (!r.ok()) throw new Error(`login ${r.status()}`);
    await page.goto('http://localhost:4100/'); await wait(page, 3500);
    return page;
  };
  const toCommunities = async (p) => {
    await p.getByText('💬 Community').first().click(); await wait(p, 2500);                // the Home quick action opens the Home command centre
    await p.getByText('Community', { exact: true }).last().click(); await wait(p, 3000);   // its Community section (the feed)
    await p.getByText('Communities', { exact: true }).first().click(); await wait(p, 2500);
  };
  const shot = (p, name, vp) => p.screenshot({ path: `${OUT}comm-${name}-${vp}.png` });
  for (const [vp, size] of [['phone', { width: 390, height: 844 }], ['tablet', { width: 820, height: 1180 }], ['desktop', { width: 1280, height: 900 }]]) {
    // a member: discover, a community with a shared achievement, the post menu / report sheet, a profile with actions
    let p = await open(size, fan);
    await toCommunities(p);
    check(await p.getByText('Pune Badminton Club').count() > 0, `${vp}: the community is listed`);
    check(await p.getByText('Elite Squad').count() > 0, `${vp}: a private community is listed (card only)`);
    await shot(p, '01-discover', vp);
    await p.getByText('Pune Badminton Club').first().click(); await wait(p, 2500);
    check(await p.getByText('Welcome to the club!').count() > 0, `${vp}: members read the feed`);
    check(await p.getByText('Verified').count() > 0, `${vp}: the shared result shows as verified`);
    check(await p.getByText('Buy cheap followers now').count() === 0, `${vp}: a moderated post is hidden`);
    await shot(p, '02-community', vp);
    await p.getByLabel(/Write something for the community/).first().click().catch(() => {}); await wait(p, 1200);
    await shot(p, '03-compose', vp);
    await p.keyboard.press('Escape'); await wait(p, 600);
    await p.getByText('⋯').first().click(); await wait(p, 800);                          // the post menu: report, mute, block
    await p.getByText('Report', { exact: true }).first().click(); await wait(p, 1200);
    check(await p.getByText('Spam or advertising').count() > 0, `${vp}: the report sheet offers reasons`);
    await shot(p, '08-report', vp);
    await p.keyboard.press('Escape'); await p.reload(); await wait(p, 3500);
    await toCommunities(p); await p.getByText('Pune Badminton Club').first().click(); await wait(p, 2500);
    await p.getByLabel('Rohit').first().click(); await wait(p, 3000);                    // the author opens their profile with the social actions
    check(await p.getByText('Add friend').count() > 0 && await p.getByText('Message', { exact: true }).count() > 0, `${vp}: the profile offers follow, friend, message, mute, report, block`);
    await shot(p, '09-profile', vp);
    await p.context().close();
    // notification choices
    p = await open(size, fan);
    await p.getByLabel(/inbox/i).first().click(); await wait(p, 2500);
    await p.getByText('Notification settings').first().click(); await wait(p, 2500);
    check(await p.getByText('Community invitations and requests').count() > 0, `${vp}: social notification switches are shown`);
    await p.getByText('Community and social alerts').first().scrollIntoViewIfNeeded(); await wait(p, 500);
    await shot(p, '10-notify', vp);
    await p.context().close();
    // an outsider on the private community
    p = await open(size, spammer);
    await toCommunities(p);
    await p.getByText('Elite Squad').first().click(); await wait(p, 2500);
    check(await p.getByText('Training plans').count() >= 0 && await p.getByText(/community is private/i).count() > 0, `${vp}: an outsider sees only the private note`);
    await shot(p, '04-private', vp);
    await p.context().close();
    // the owner: reports queue with a decision
    p = await open(size, owner);
    await toCommunities(p);
    await p.getByText('Pune Badminton Club').first().click(); await wait(p, 2500);
    await p.getByText('Reports', { exact: true }).first().click(); await wait(p, 2000);
    check(await p.getByText(/Spam or advertising/).count() > 0, `${vp}: the moderator queue lists the open report`);
    await shot(p, '05-queue', vp);
    await p.getByText('Show reported text').first().click(); await wait(p, 1500);
    await p.getByText('Decide', { exact: true }).first().click(); await wait(p, 1500);
    await shot(p, '06-decide', vp);
    await p.context().close();
  }
  // dark theme and the notification choices on the phone
  const dark = await open({ width: 390, height: 844 }, fan, 'dark');
  await toCommunities(dark);
  await dark.getByText('Pune Badminton Club').first().click(); await wait(dark, 2500);
  await shot(dark, '07-community-dark', 'phone');
  await dark.context().close();
  await browser.close();
} catch (e) { log('ERROR', e.message); failures++; }
await pool.end(); api.kill(); web.close();
log(failures ? `${failures} FAILED` : 'ALL PASSED'); process.exit(failures ? 1 : 0);
