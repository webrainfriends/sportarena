// Browser-driven check of Discipline & Sanctions (#479): the Event console's Discipline tab (overview with the caution watchlist, cases, a decided case with served matches, policy,
// official verification), a player's My discipline and the Official verifier desk, on a phone, a tablet and a desktop. Data is created through the public API (plus the cards and fixtures the live
// scorers would record). Writes PNGs to E2E_SHOTS. Needs a throwaway Postgres (E2E_DATABASE_URL), a same-origin web build in E2E_DIST and playwright with a Chromium.
// Run: node scripts/e2e/discipline-journey.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const { chromium } = createRequire('/opt/node-tools/')('playwright');
import pg from 'pg';
const E = {
  DATABASE_URL: process.env.E2E_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/sportarena_e2e', SPORTARENA_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), SPORTARENA_JWT_SECRET: Buffer.alloc(32, 9).toString('base64'),
  PORT: '4000', APP_URL: 'http://localhost:4100', CORS_ORIGINS: 'http://localhost:4100', PLATFORM_APPROVALS: 'off', PLATFORM_ADMIN_EMAILS: 'rraja.edge@gmail.com,rrajas1978@icloud.com',
};
const OUT = (process.env.E2E_SHOTS ?? '/tmp/e2e-shots') + '/'; fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
const api = spawn('node', ['src/server.js'], { cwd: new URL('../../apps/api/', import.meta.url).pathname, env: { ...process.env, ...E }, stdio: ['ignore', 'pipe', 'pipe'] });
api.stdout.on('data', (d) => process.env.V && log('[api]', String(d).trim())); api.stderr.on('data', (d) => process.env.V && log('[api!]', String(d).trim()));
for (let i = 0; i < 90; i++) { try { if ((await fetch('http://127.0.0.1:4000/api/v1/payments/methods')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }
const DIST = process.env.E2E_DIST ?? '/tmp/e2e-dist';
const web = http.createServer((req, res) => {
  if (req.url.startsWith('/api') || req.url.startsWith('/mcp')) { const p = http.request({ host: '127.0.0.1', port: 4000, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }); req.pipe(p); return; }
  let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
  const ext = path.extname(f); res.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf' }[ext] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => web.listen(4100, r));
const B = 'http://localhost:4100/api/v1';
const call = async (method, p, { token, body } = {}) => { const r = await fetch(`http://127.0.0.1:4000/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(j).slice(0, 300)}`); return j; };
const reg = async (h, name, roles = ['athlete'], email) => { const r = await call('POST', '/auth/register', { body: { handle: h, display_name: name, email: email ?? `${h}@example.com`, password: 'correct-horse-battery', roles } }); return { ...r.user, token: r.token, email: email ?? `${h}@example.com` }; };
const db = new pg.Pool({ connectionString: E.DATABASE_URL });
let failures = 0; const check = (ok, msg) => { log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const wait = (p, ms = 1200) => p.waitForTimeout(ms);
const tag = Math.random().toString(36).slice(2, 7);


try {
  const org = await reg(`dj_org_${tag}`, 'Sunita Rao', ['organizer']);
  const mgrA = await reg(`dj_ma_${tag}`, 'Vikram Shah'); const mgrB = await reg(`dj_mb_${tag}`, 'Anil Nair');
  const player = await reg(`dj_p1_${tag}`, 'Rohan Iyer'); const p2 = await reg(`dj_p2_${tag}`, 'Imran Qureshi'); const p3 = await reg(`dj_p3_${tag}`, 'Kabir Das');
  const admin = await reg(`dj_admin_${tag}`, 'Platform Owner', ['athlete'], 'rraja.edge@gmail.com');
  await db.query("UPDATE users SET roles='{athlete,admin,platform_admin}' WHERE id=$1", [admin.id]);
  const verifier = await reg(`dj_ver_${tag}`, 'Meena Pillai');
  const panel = await reg(`dj_panel_${tag}`, 'Justice Rekha Menon');
  const adm = (await call('POST', '/auth/login', { body: { email: 'rraja.edge@gmail.com', password: 'correct-horse-battery' } })).token ?? admin.token;
  await call('POST', '/admin/official-verifiers', { token: adm, body: { user_id: verifier.id } });
  const comp = await call('POST', '/competitions', { token: org.token, body: { name: 'Mumbai Premier League', sport: 'football', country: 'IN', level: 'semi_pro', is_public: true } });
  const season = await call('POST', `/competitions/${comp.id}/seasons`, { token: org.token, body: { label: '2026/27', starts_on: day(1), ends_on: day(200), registration_opens_on: day(-1), registration_closes_on: day(30) } });
  const div = await call('POST', `/seasons/${season.id}/divisions`, { token: org.token, body: { name: 'Premier', tier: 1, capacity: 8 } });
  const teams = [];
  for (const [m, n] of [[mgrA, 'Bandra Strikers'], [mgrB, 'Colaba United']]) teams.push(await call('POST', '/teams', { token: m.token, body: { name: n, sport: 'football' } }));
  await call('POST', `/seasons/${season.id}/status`, { token: org.token, body: { status: 'open' } });
  for (const [i, t] of teams.entries()) { const mm = await call('POST', `/seasons/${season.id}/memberships`, { token: [mgrA, mgrB][i].token, body: { team_id: t.id, division_id: div.id } }); await call('POST', `/memberships/${mm.id}/decision`, { token: org.token, body: { action: 'accept' } }); }
  for (const [u, t] of [[player, teams[0]], [p2, teams[0]], [p3, teams[1]]]) await db.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [t.id, u.id]);
  const ev = (await db.query('SELECT event_id FROM comp_seasons WHERE id=$1', [season.id])).rows[0].event_id;
  const fx = async (days, status = 'scheduled') => (await db.query("INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at, status) VALUES ($1,$2,$3, now() + ($4 || ' days')::interval, $5) RETURNING id", [ev, teams[0].id, teams[1].id, String(days), status])).rows[0].id;
  let seq = 0; const card = (f, kind, who, team) => db.query('INSERT INTO match_events(fixture_id, event_id, seq, kind, team_id, player_id, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [f, ev, ++seq, kind, team.id, who.id, org.id]);
  const f1 = await fx(-9, 'completed'), f2 = await fx(-5, 'completed'), f3 = await fx(-2, 'completed'); const n1 = await fx(3), n2 = await fx(10), n3 = await fx(17);
  await card(f1, 'yellow_card', p2, teams[0]); await card(f2, 'yellow_card', p2, teams[0]); await card(f2, 'yellow_card', p3, teams[1]); await card(f3, 'red_card', player, teams[0]);
  await call('POST', `/competitions/${comp.id}/discipline/panel`, { token: org.token, body: { user_id: panel.id, role: 'panel' } });
  await call('POST', `/competitions/${comp.id}/discipline/policy`, { token: org.token, body: { params: { card_points: { yellow_card: 1 }, accumulation: [{ points: 3, matches: 1 }], direct: [{ kind: 'red_card', matches: 2 }], second_caution: { kind: 'yellow_card', matches: 1 }, authority: { fines: true, points_deduction: true, fine_cap_minor: 500000, points_cap: 6 }, appeal_window_days: 7, stay_on_appeal: true } } });
  const sw = await call('POST', `/competitions/${comp.id}/discipline/sweep`, { token: org.token, body: { season_id: season.id } });
  check(sw.opened === 1, 'the red card opened one case with the automatic suspension');
  const kase = await call('POST', `/competitions/${comp.id}/discipline/cases`, { token: org.token, body: { season_id: season.id, source: 'manual_referral', subject_kind: 'player', subject_user_id: p3.id, team_id: teams[1].id, category: 'abusive_language', summary: 'Alleged abusive language towards the match referee after the final whistle.' } });
  const dec = await call('POST', `/discipline/cases/${kase.id}/decision`, { token: panel.token, body: { outcome: 'upheld', reason: 'Language directed at a match official, confirmed by the referee report.', sanctions: [{ kind: 'warning', label: 'Formal reprimand' }, { kind: 'fine', amount_minor: 200000 }, { kind: 'points_deduction', points: 3 }] } });
  check(!!dec.decision_id, 'a panel decision with a fine and a points deduction was recorded');
  await db.query("INSERT INTO commercial_overrides(scope, subject_type, subject_id, key, reason, created_by) VALUES ('contract','user',$1,'reports.official_verification','Platform reports subscription',$2)", [org.id, admin.id]);
  const sportId = (await db.query('SELECT sport_id FROM events WHERE id=$1', [ev])).rows[0].sport_id;
  await call('POST', '/official-verifications', { token: org.token, body: { subject_user_id: p2.id, sport_id: sportId, purpose: 'tournament_selection', competition_id: comp.id } });
  const done = await call('POST', '/official-verifications', { token: org.token, body: { subject_user_id: player.id, sport_id: sportId, purpose: 'event_entry', competition_id: comp.id } });
  await call('POST', `/verifier/requests/${done.id}/claim`, { token: verifier.token }); await call('POST', `/verifier/requests/${done.id}/decision`, { token: verifier.token, body: {} });
  await db.query("UPDATE fixtures SET status='completed' WHERE id=$1", [n1]);

  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const SIZES = { phone: { width: 390, height: 844 }, tablet: { width: 820, height: 1180 }, desktop: { width: 1366, height: 900 } };
  const open = async (viewport, url, who) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: process.env.E2E_SCHEME ?? 'dark' }); const page = await ctx.newPage();
    page.on('pageerror', (e) => log('[pageerror]', e.message)); page.on('console', (m) => { if (['error','warning'].includes(m.type())) log('[console]', m.text().slice(0, 200)); });
    if (who) await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } });
    await page.goto(url); await wait(page, 2800);
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
      window.__nav.push(name, params);
      window.__navinfo = Object.keys(window.__nav).join(',') + ' stack=' + JSON.stringify(window.__nav.stack ?? null).slice(0, 200);
    }, { name, params });
    if (process.env.DBGNAV) log('NAV', await p.evaluate(() => window.__navinfo));
    await wait(p, 6000);
  };
  const evName = (await db.query('SELECT name FROM events WHERE id=$1', [ev])).rows[0].name;
  const openConsole = async (p, tab = 'Discipline') => {
    await p.getByText('Event console', { exact: true }).first().click(); await wait(p, 2500);
    await p.getByText(evName).first().click(); await wait(p, 4000);
    if (tab) { await p.getByText(new RegExp(`${tab}$`)).first().click(); await wait(p, 2500); }
  };
  const openMore = async (p, title) => {
    await p.getByText('More', { exact: true }).first().click(); await wait(p, 1500);
    const vp = p.viewportSize(); const y = Math.round(vp.height * 0.735);
    for (let i = 0; i < 90; i++) {
      const dir = i < 45 ? -1 : 1;
      const tile = p.getByLabel(title, { exact: false }).first();
      if (await tile.isVisible().catch(() => false)) {
        await tile.click(); await wait(p, 1200);
        if (title === 'Workspaces') { await p.getByText('Official verifier desk', { exact: true }).first().click(); await wait(p, 3500); return true; }
        const box = await tile.boundingBox().catch(() => null); if (await tile.isVisible().catch(() => false)) { await tile.click({ force: true }).catch(() => {}); if (box) await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2); }
        await wait(p, 3500); return true;
      }
      await p.mouse.move(vp.width / 2, y); await p.mouse.down(); await p.mouse.move(vp.width / 2 + dir * 70, y, { steps: 6 }); await p.mouse.up(); await wait(p, 250);
    }
    return false;
  };
  const noOverflow = async (p, label) => { const w = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); check(w <= 1, `${label}: no horizontal page scroll`); };

  for (const [size, vp] of Object.entries(SIZES)) {
    const { ctx, page: p } = await open(vp, 'http://localhost:4100/', org);
    await openConsole(p);
    if (!(await vis(p, 'Caution watchlist', 3000))) { await shot(p, `debug-${size}`); log('BODYEND', JSON.stringify((await p.evaluate(() => document.body.innerText)).slice(-700))); }
    check(await vis(p, 'Caution watchlist'), `${size}: Discipline overview with the caution watchlist`);
    check(await vis(p, 'Imran Qureshi'), `${size}: the player nearest a suspension is listed`);
    await shot(p, `01-discipline-overview-${size}`); await noOverflow(p, `${size} overview`);
    await p.getByText('Cases', { exact: true }).first().click(); await wait(p, 1800);
    check(await vis(p, 'Rohan Iyer'), `${size}: the red-card case is listed`);
    await shot(p, `02-discipline-cases-${size}`);
    await p.getByText('Rohan Iyer').first().click(); await wait(p, 2200);
    check(await vis(p, 'Automatic under policy'), `${size}: the automatic policy decision is shown`);
    check(await vis(p, 'matches served'), `${size}: served matches are shown`);
    await shot(p, `03-discipline-case-${size}`);
    await ctx.close();
  }
  { const { ctx, page: p } = await open(SIZES.desktop, 'http://localhost:4100/', org);
    await openConsole(p);
    await p.getByText('Cases', { exact: true }).first().click(); await wait(p, 1500);
    await p.getByText('Kabir Das').first().click(); await wait(p, 2200);
    check(await vis(p, 'Points deduction'), 'desktop: the panel decision shows the fine and the points deduction');
    await shot(p, '04-discipline-case-panel-decision-desktop'); await ctx.close(); }
  for (const size of ['phone', 'desktop']) {
    const { ctx, page: p } = await open(SIZES[size], 'http://localhost:4100/', org);
    await openConsole(p);
    await p.getByText('Policy', { exact: true }).first().click(); await wait(p, 1600);
    check(await vis(p, 'Policy version 1'), `${size}: policy version shown`); await shot(p, `05-discipline-policy-${size}`);
    await p.getByText('Verification', { exact: true }).first().click(); await wait(p, 1800);
    check(await vis(p, 'Official verification'), `${size}: official verification panel`); check(await vis(p, 'Eligible') || await vis(p, 'Not eligible'), `${size}: an issued attestation shows only the result`);
    await shot(p, `06-verification-requester-${size}`); await ctx.close();
  }
  for (const size of ['phone', 'tablet']) {
    const { ctx, page: p } = await open(size === 'phone' ? SIZES.tablet : SIZES[size], 'http://localhost:4100/', player);
    await openMore(p, 'My discipline'); if (size === 'phone') { await p.setViewportSize(SIZES.phone); await wait(p, 1500); } check(await vis(p, 'My discipline'), `${size}: My discipline opens`); check(await vis(p, 'matches served'), `${size}: remaining matches are shown to the player`);
    await shot(p, `07-my-discipline-${size}`); await noOverflow(p, `${size} my discipline`); await ctx.close();
  }
  { const { ctx, page: p } = await open(SIZES.desktop, 'http://localhost:4100/', verifier);
    await openMore(p, 'Workspaces'); check(await vis(p, 'Official verifier desk'), 'desktop: the verifier desk opens'); check(await vis(p, 'Imran Qureshi'), 'desktop: the waiting request is listed');
    check(!(await p.getByText(/red card|suspended|match suspension/i).count()), 'desktop: the desk never shows a sanction');
    await shot(p, '08-verifier-desk-desktop'); await ctx.close(); }
  { const { ctx, page: p } = await open(SIZES.tablet, 'http://localhost:4100/', verifier);
    await openMore(p, 'Workspaces'); await p.setViewportSize(SIZES.phone); await wait(p, 1500); await shot(p, '08-verifier-desk-phone'); await ctx.close(); }
  // the public surfaces carry no discipline at all
  const pub = JSON.stringify(await (await fetch(`http://127.0.0.1:4000/api/v1/people/${player.id}`)).json()) + JSON.stringify(await (await fetch(`http://127.0.0.1:4000/api/v1/teams/${teams[0].id}`)).json());
  check(!/suspen|disciplin|sanction|red_card/i.test(pub), 'the public profile and roster carry no discipline');
  await browser.close();
} catch (e) { log('ERROR', e); failures++; }
log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
api.kill(); web.close(); await db.end();
process.exit(failures ? 1 : 0);
