// Browser-driven check of the recruitment passport (#312): phone, tablet and desktop; athlete, coach and a recipient.
// Needs: a throwaway Postgres database (E2E_DATABASE_URL; it is migrated, never dropped here), a same-origin web build
//   EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir <dir>   (E2E_DIST, default /tmp/e2e-dist)
// and playwright-core (`npm i --no-save playwright-core`) with a Chromium (E2E_CHROMIUM, default the pre-installed one).
// It starts the API and a tiny static+proxy server itself. Run: node scripts/e2e/passport-recruitment-journey.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
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
const stamp = Date.now().toString(36);
const reg = async (h, roles) => { const handle = `${h}${stamp}`; const r = await call('POST', '/auth/register', { body: { handle, display_name: h, email: `${handle}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); return { ...r.user, token: r.token, email: `${handle}@example.com` }; };
let failures = 0; const check = (ok, msg) => { log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const session = async (who, viewport) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 }); const page = await ctx.newPage();
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } }); if (!r.ok()) throw new Error(`login ${r.status()} ${await r.text()}`);
    await page.goto('http://localhost:4100/'); await page.waitForTimeout(2500);
    return { ctx, page };
  };
  const shot = (page, n, full = true) => page.screenshot({ path: `${OUT}${n}.png`, fullPage: full });
  const openPassport = async (page) => {
    await page.getByText('More', { exact: true }).first().click(); await page.waitForTimeout(1500); if (process.env.DBG) await page.screenshot({ path: OUT + 'dbg-more.png' });
    const vp = page.viewportSize(); await page.mouse.click(vp.width / 2, Math.round(vp.height * 0.72)); await page.waitForTimeout(2500);
  };

  const coach = await reg('coach', ['coach']), ath = await reg('athlete', ['athlete']), scout = await reg('scout', ['coach']);
  const team = await call('POST', '/teams', { token: coach.token, body: { name: `Journey FC ${stamp}`, sport: 'football' } });
  const pg = new (await import('pg')).default.Pool({ connectionString: E.DATABASE_URL });
  await pg.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'coach','active') ON CONFLICT (team_id, user_id) DO UPDATE SET role='coach', status='active'", [team.id, coach.id]);
  await pg.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [team.id, ath.id]);
  await call('POST', '/me/sport-profiles', { token: ath.token, body: { sport: 'football', role: 'athlete', level: 'amateur', position: 'Striker', club: 'Journey FC' } });

  // 1. athlete on a phone: empty states first
  const { page: p } = await session(ath, { width: 390, height: 844 });
  await openPassport(p); await shot(p, '01-athlete-empty');
  check(await p.getByText('Recruitment profile').first().isVisible(), 'the recruitment profile sits inside the existing Passport screen');
  check(await p.getByText('No videos yet').first().isVisible() && await p.getByText('Nothing added').first().isVisible(), 'empty states explain what to add');
  await p.context().close();

  // 2. athlete adds evidence through the API (the same calls the forms make), coach approves, athlete approves the reference
  await call('POST', '/me/passport-videos', { token: ath.token, body: { title: 'Match highlights', link_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', sport_slug: 'football' } });
  const v = (await call('GET', '/me/passport-videos', { token: ath.token }))[0];
  await call('POST', '/me/recruitment-preferences', { token: ath.token, body: { version: 0, sport_slugs: ['football'], levels: ['semi_pro'], regions: ['Mumbai'], open_to: ['scholarship', 'trial'], open_to_contact: true, notes: 'Open to relocate' } });
  await call('POST', '/me/recruitment-availability', { token: ath.token, body: { kind: 'trial', from_date: day(5), to_date: day(12), weekdays: [6, 0], from_time: '09:00', to_time: '12:00' } });
  await call('POST', '/me/academic-evidence', { token: ath.token, body: { kind: 'transcript', institution: 'City High School', summary: 'Top 5% in maths' } });
  await call('POST', `/athletes/${ath.id}/passport-references`, { token: coach.token, body: { body: 'Hard working striker with great attitude and leadership qualities.', sport_slug: 'football' } });

  // coach desk
  const { page: c } = await session(coach, { width: 390, height: 844 });
  await openPassport(c); await c.getByText('Recruitment', { exact: true }).first().click(); await c.waitForTimeout(2000); await shot(c, '02-coach-desk');
  check(await c.getByText('Match highlights').first().isVisible(), 'coach sees the pending clip of an athlete they coach');
  check(await c.locator('iframe[src*="youtube-nocookie.com/embed/dQw4w9WgXcQ"]').count() === 1, 'the coach reviews the linked video in an in-app player');
  await c.getByText('Approve', { exact: true }).first().click(); await c.waitForTimeout(1500);
  check((await pg.query("SELECT status FROM passport_videos WHERE id=$1", [v.id])).rows[0].status === 'approved', 'approving in the UI approves the clip');
  await c.context().close();

  // athlete: approve reference in the UI, see every block, create a recipient-scoped link
  const { page: a } = await session(ath, { width: 390, height: 844 });
  await openPassport(a); await a.mouse.wheel(0, 900); await a.waitForTimeout(400); await shot(a, '03-athlete-recruitment-profile');
  check(await a.getByText('Waiting for you').first().isVisible(), 'the reference waits for the athlete');
  await a.getByText('Approve', { exact: true }).first().click(); await a.waitForTimeout(1500);
  check((await pg.query("SELECT status FROM passport_references WHERE user_id=$1", [ath.id])).rows[0].status === 'approved', 'the athlete approves the reference');
  await a.getByText('+ New link').first().click(); await a.waitForTimeout(1200); await shot(a, '04-new-link-form', false);
  check(await a.getByText(/approved video/i).first().isVisible() && await a.getByText(/only this person/i).first().isVisible(), 'the link form offers the new sections and a recipient picker');
  await a.getByRole('button', { name: /Close|Cancel/i }).first().click().catch(() => {}); await a.context().close();

  // 3. a link addressed to the scout: anonymous refused, the scout sees it
  const link = await call('POST', '/me/passport-links', { token: ath.token, body: { label: 'Academy scout', recipient_id: scout.id, show_video: true, show_references: true, show_preferences: true, show_availability: true, show_academic: true } });
  const { page: anon } = await (async () => { const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); return { page: await ctx.newPage() }; })();
  await anon.goto(`http://localhost:4100/?passport=${encodeURIComponent(link.token)}`); await anon.waitForTimeout(2500); await shot(anon, '05-recipient-anonymous-refused');
  check(await anon.getByText('This link is not available').first().isVisible(), 'someone without the recipient account gets the generic refusal');
  for (const [n, vp] of [['phone', { width: 390, height: 844 }], ['tablet', { width: 820, height: 1100 }], ['desktop', { width: 1280, height: 900 }]]) {
    const { page: s } = await session(scout, vp);
    await s.goto(`http://localhost:4100/?passport=${encodeURIComponent(link.token)}`); await s.waitForTimeout(3000); await shot(s, `06-recipient-${n}`);
    check(await s.getByText('Coach references').first().isVisible() && await s.getByText('Looking for').first().isVisible() && await s.getByText('Academic evidence').first().isVisible(), `${n}: the scout sees video, reference, preferences, availability and academic evidence`);
    check(await s.getByText(/self-reported, not verified/).first().isVisible(), `${n}: academic items are labelled self-reported`);
    check(await s.locator('iframe[src*="youtube-nocookie.com"]').count() === 1, `${n}: the recipient plays the linked video inside the passport`);
    await s.context().close();
  }
  // 4. revoke from the athlete's screen: the same URL now fails for the scout
  await call('POST', `/me/passport-links/${link.id}/revoke`, { token: ath.token });
  const { page: s2 } = await session(scout, { width: 390, height: 844 });
  await s2.goto(`http://localhost:4100/?passport=${encodeURIComponent(link.token)}`); await s2.waitForTimeout(2500); await shot(s2, '07-recipient-after-revoke');
  check(await s2.getByText('This link is not available').first().isVisible(), 'after revoking, the recipient is refused on the next open');
  // 5. the athlete's link list shows status, recipient and sections
  const { page: a2 } = await session(ath, { width: 390, height: 844 });
  await openPassport(a2); await a2.mouse.wheel(0, 500); await a2.waitForTimeout(300); await shot(a2, '08-links-list');
} catch (e) { log('ERROR', e.stack); failures++; }
finally { await browser?.close(); api.kill(); web.close(); }
log(failures ? `${failures} FAILED` : 'ALL PASSED'); process.exit(failures ? 1 : 0);
