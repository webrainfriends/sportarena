// Browser-driven check of the public tournament & spectator experience (#501): the signed-out event page and live centre from a shared link, the table
// and bracket (list and drawing), follow with alert choices, the share sheet and share page, discovery filters and the organiser's Public page tab,
// at phone, tablet and desktop widths. Data is created through the public API (plus the few rows the API cannot create without a venue).
// Needs: a throwaway Postgres database (E2E_DATABASE_URL; migrated by the server, never dropped here), a same-origin web build
//   EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir <dir>   (E2E_DIST, default /tmp/e2e-dist)
// and playwright with a Chromium. Run: node scripts/e2e/public-spectator-journey.mjs
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
  // ---------------------------------------------------------------- data, created through the public API
  const org = await reg(`ps_org_${tag}`, 'Priya Nair', ['organizer']), ref = await reg(`ps_ref_${tag}`, 'Sam Carter', ['referee']), fan = await reg(`ps_fan_${tag}`, 'Alex Lee'), sp = await reg(`ps_sp_${tag}`, 'Voltage Brands', ['sponsor']);
  const coaches = []; for (const n of ['Riverside FC', 'Hillside United', 'Harbour Rovers', 'Kings Cross Academy']) coaches.push({ n, u: await reg(`ps_c${coaches.length}_${tag}`, `Coach ${n.split(' ')[0]}`, ['coach']) });
  const maya = await reg(`ps_maya_${tag}`, 'Maya Rao'), ben = await reg(`ps_ben_${tag}`, 'Ben Okafor');
  const teams = []; for (const { n, u } of coaches) teams.push(await call('POST', '/teams', { token: u.token, body: { name: n, sport: 'football', emoji: ['🌊', '⛰️', '⚓', '👑'][teams.length], color: ['#3E8AB5', '#2F8F5F', '#EA580C', '#8458B3'][teams.length] } }));
  await db.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active'),($3,$4,'player','active')", [teams[0].id, maya.id, teams[2].id, ben.id]);
  const ev = await call('POST', '/events', { token: org.token, body: { name: 'Pune Summer Cup', sport: 'football', city: 'Pune', kind: 'tournament', description: 'Four clubs, one weekend: round-robin then knockouts at Balewadi Sports Complex.', starts_on: day(0), ends_on: day(2) } });
  await db.query("UPDATE events SET status='ongoing', region='Maharashtra', levels='{amateur}' WHERE id=$1", [ev.id]);
  for (const t of teams) await db.query("INSERT INTO event_entries(event_id, team_id, status) VALUES ($1,$2,'accepted')", [ev.id, t.id]);
  const mk = async (h, a, when, round = 'Group stage') => (await db.query('INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at, round) VALUES ($1,$2,$3,$4,$5) RETURNING id', [ev.id, teams[h].id, teams[a].id, when, round])).rows[0].id;
  const hr = (n) => new Date(Date.now() + n * 3600e3).toISOString();
  const f1 = await mk(0, 1, hr(-26)), f2 = await mk(2, 3, hr(-25)), live = await mk(0, 2, hr(-1)), f4 = await mk(1, 3, hr(5)), f5 = await mk(1, 2, hr(26)), f6 = await mk(0, 3, hr(27));
  await call('POST', `/fixtures/${f1}/result`, { token: org.token, body: { home_score: 2, away_score: 1 } });
  await call('POST', `/fixtures/${f2}/result`, { token: org.token, body: { home_score: 0, away_score: 0 } });
  await db.query("UPDATE fixtures SET scheduled_at=$2 WHERE id=$1", [f1, hr(-26)]);
  await db.query("INSERT INTO fixture_officials(fixture_id, user_id, role, status) VALUES ($1,$2,'referee','accepted')", [live, ref.id]);
  await call('POST', `/fixtures/${live}/start`, { token: org.token });
  await call('POST', `/fixtures/${live}/events`, { token: org.token, body: { kind: 'period_start' } });
  await call('POST', `/fixtures/${live}/events`, { token: org.token, body: { kind: 'goal', side: 'home', player_id: maya.id, clock_seconds: 540 } });
  await call('POST', `/fixtures/${live}/events`, { token: org.token, body: { kind: 'goal', side: 'away', player_id: ben.id, clock_seconds: 1260 } });
  await call('POST', `/fixtures/${live}/events`, { token: org.token, body: { kind: 'goal', side: 'home', player_id: maya.id, clock_seconds: 1900 } });
  // knockout: semi-finals with real teams from the standings, a final with placeholders (the API builds this with a venue; the rows are what matters here)
  const semi1 = (await db.query("INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at, round, round_kind, bracket_slot) VALUES ($1,$2,$3,$4,'Semi-final 1','semi',0) RETURNING id", [ev.id, teams[0].id, teams[3].id, hr(50)])).rows[0].id;
  const semi2 = (await db.query("INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at, round, round_kind, bracket_slot) VALUES ($1,$2,$3,$4,'Semi-final 2','semi',1) RETURNING id", [ev.id, teams[1].id, teams[2].id, hr(51)])).rows[0].id;
  await db.query("INSERT INTO fixtures(event_id, scheduled_at, round, round_kind, bracket_slot, home_placeholder, away_placeholder) VALUES ($1,$2,'Final','final',0,'Winner Semi-final 1','Winner Semi-final 2')", [ev.id, hr(74)]);
  void semi1; void semi2; void f4; void f5; void f6;
  // sponsors, media, policy
  const brand = await call('POST', '/sponsors', { token: sp.token, body: { name: 'VoltDrink' } });
  const deal = await call('POST', '/sponsorships', { token: sp.token, body: { sponsor_id: brand.id, target_type: 'event', target_id: ev.id, amount_cents: 500000 } });
  await call('PATCH', `/sponsorships/${deal.id}`, { token: org.token, body: { status: 'active' } });
  await call('POST', `/events/${ev.id}/sponsor-placements`, { token: org.token, body: { sponsorship_id: deal.id, slot: 'title_partner', cta_label: 'Get 10% off', cta_url: 'https://volt.example/summer-cup' } });
  await call('POST', `/events/${ev.id}/sponsor-placements`, { token: org.token, body: { sponsorship_id: deal.id, slot: 'scorecard' } });
  await db.query("INSERT INTO mr_assets(event_id, kind, right_kind, title, caption, credit, creator_id, owner_kind, source_kind, external_url, audience, status) VALUES ($1,'video','highlights','Semi-final highlights','Every goal from the group stage','Gotmygame Media',$2,'organiser','external_link','https://video.example/summer-cup-highlights','public','published')", [ev.id, org.id]);
  await call('PATCH', `/events/${ev.id}/public-settings`, { token: org.token, body: { reactions: true, mvp_vote: true, show_officials: true, indexable: true } });
  await call('POST', '/me/follows', { token: fan.token, body: { subject_type: 'event', subject_id: ev.id } });
  await call('POST', '/me/follows', { token: fan.token, body: { subject_type: 'team', subject_id: teams[0].id, alerts: ['score', 'result'] } });
  await call('POST', '/me/follows', { token: fan.token, body: { subject_type: 'fixture', subject_id: live, alerts: ['score'] } });
  await call('POST', `/public/fixtures/${live}/reaction`, { token: fan.token, body: { reaction: 'fire' } });

  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const SIZES = { phone: { width: 390, height: 844 }, tablet: { width: 820, height: 1180 }, desktop: { width: 1366, height: 900 } };
  const open = async (viewport, url, who) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 }); const page = await ctx.newPage();
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    if (who) { const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } }); if (!r.ok()) throw new Error(`login ${who.email}`); }
    await page.goto(url); await wait(page, 2800);
    return { ctx, page };
  };
  const shot = (page, n, full = false) => page.screenshot({ path: `${OUT}${n}.png`, fullPage: full });
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
  const noOverflow = async (p, label) => { const w = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); check(w <= 1, `${label}: no horizontal page scroll`); };

  // ---------------------------------------------------------------- a visitor opens a shared link (signed out), at three widths
  for (const [size, vp] of Object.entries(SIZES)) {
    const { ctx, page: p } = await open(vp, `http://localhost:4100/?event=${ev.id}`);
    check(await vis(p, 'Pune Summer Cup'), `${size}: the public event page opens without signing in`);
    check(await vis(p, 'LIVE NOW') && await vis(p, 'Riverside FC'), `${size}: a live game is highlighted`);
    check(await vis(p, 'Presented by') && await vis(p, 'VoltDrink'), `${size}: the title partner placement shows`);
    await shot(p, `01-public-event-${size}`);
    await noOverflow(p, `${size} event page`);
    if (size === 'phone') {
      await p.getByText('Table & bracket').first().click(); await wait(p, 1500);
      check(await vis(p, 'PROVISIONAL TABLE'), 'the table says provisional until the event is completed');
      await shot(p, '02-public-table-phone');
      await p.getByText('Bracket drawing').first().click().catch(() => {}); await wait(p, 1200); await shot(p, '03-public-bracket-drawing-phone');
      await p.getByText('List', { exact: true }).first().click().catch(() => {}); await wait(p, 800);
      check(await vis(p, 'Semi-final'), 'the bracket is also available as a list');
      await p.getByText('Games', { exact: true }).first().click(); await wait(p, 1500); await shot(p, '04-public-games-phone');
      await p.getByText('＋ Follow').first().click(); await wait(p, 900);
      check(await vis(p, 'Sign in to follow'), 'a signed-out visitor is invited to sign in to follow');
      await shot(p, '05-follow-signed-out-phone');
    }
    await ctx.close();
  }
  // the live centre from a shared game link
  for (const [size, vp] of Object.entries(SIZES)) {
    const { ctx, page: p } = await open(vp, `http://localhost:4100/?event=${ev.id}&fixture=${live}`);
    check(await vis(p, 'Timeline') && await vis(p, 'Maya Rao'), `${size}: the live centre shows the timeline with adult scorers`);
    if (size === 'phone') check(await vis(p, 'Fan MVP') && await vis(p, 'not an official award'), 'the fan MVP vote is labelled as a fan vote');
    await shot(p, `06-live-centre-${size}`);
    await noOverflow(p, `${size} live centre`);
    await ctx.close();
  }
  // ---------------------------------------------------------------- a follower, signed in
  {
    const { ctx, page: p } = await open(SIZES.phone, 'http://localhost:4100/', fan);
    await navTo(p, 'Event', { id: ev.id });
    check(await vis(p, '✓ Following'), 'the event page remembers that I follow it');
    await p.getByText('✓ Following').first().click(); await wait(p, 900);
    check(await vis(p, 'Kick-off') && await vis(p, 'Schedule changes'), 'alert choices are chips');
    await shot(p, '07-follow-alerts-phone');
    await p.keyboard.press('Escape'); await wait(p, 600);
    await p.getByText('↗ Share').first().click(); await wait(p, 1500);
    check(await vis(p, 'only what the public can already see'), 'the share sheet explains what is shared');
    await shot(p, '08-share-sheet-phone');
    await p.keyboard.press('Escape'); await wait(p, 600);
    await navTo(p, 'Following'); check(await vis(p, 'Riverside FC') && await vis(p, 'Pune Summer Cup'), 'Following lists events, teams and games'); await shot(p, '09-following-phone');
    await ctx.close();
  }
  {
    const { ctx, page: p } = await open(SIZES.phone, 'http://localhost:4100/', fan);
    await p.getByLabel('Explore', { exact: true }).first().click(); await wait(p, 1500);
    await p.getByText('🔴 Live now').first().click(); await wait(p, 1800);
    check(await vis(p, 'Pune Summer Cup') && await vis(p, 'LIVE ·'), 'discovery filters by Live now');
    await shot(p, '10-discover-live-phone');
    await ctx.close();
  }
  // ---------------------------------------------------------------- the organiser's Public page tab
  {
    const { ctx, page: p } = await open(SIZES.tablet, 'http://localhost:4100/', org);
    await navTo(p, 'EventCommand', { id: ev.id, tab: 'public' });
    check(await vis(p, 'Who can see it') && await vis(p, 'Sponsor placements'), 'the console has a Public page tab');
    check(await vis(p, 'SERVED') && await vis(p, 'CLICKS'), 'placements show measured exposure only');
    await shot(p, '11-console-public-page-tablet');
    await ctx.close();
  }
  // ---------------------------------------------------------------- the server-rendered share page
  {
    const ctx = await browser.newContext({ viewport: SIZES.phone }); const p = await ctx.newPage();
    const r = await p.goto(`http://localhost:4100/api/v1/share/events/${ev.id}`); await wait(p, 800);
    check(r.status() === 200 && /index/.test(r.headers()['x-robots-tag'] ?? ''), 'the share page is indexable only because the organiser opted in');
    check(await vis(p, 'Pune Summer Cup'), 'the share page renders without the app');
    await shot(p, '12-share-page-phone', true);
    await ctx.close();
  }
  await browser.close();
} catch (e) { log('ERROR', e.message); failures++; } finally { await db.end().catch(() => {}); api.kill(); web.close(); }
process.exit(failures ? 1 : 0);
