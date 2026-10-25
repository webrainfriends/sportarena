// Browser-driven check of pathway planning (#335): an athlete reviews targets, goals, deadlines, scholarships and offers on a phone, decides an offer in the UI, shares the plan with a coach,
// the coach reads exactly the shared parts on a tablet, and the athlete stops sharing so the coach loses access at once. Same prerequisites as appearances-journey.mjs.
// Needs: a throwaway Postgres database (E2E_DATABASE_URL; migrated, never dropped here), a same-origin web build
//   EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir <dir>   (E2E_DIST, default /tmp/e2e-dist)
// and playwright with a Chromium (E2E_CHROMIUM, default the pre-installed one). Run: node scripts/e2e/pathway-plan-journey.mjs
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
  const coach = await reg(`pw_c${R}`, 'Coach Meera', ['coach']), a = await reg(`pw_a${R}`, 'Asha Rao'), owner = await reg(`pw_o${R}`, 'Hilltop Admissions');
  const team = await call('POST', '/teams', { token: coach.token, body: { name: 'Riverside FC', sport: 'football' } });
  await db.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'coach','active') ON CONFLICT (team_id, user_id) DO UPDATE SET role='coach', status='active'", [team.id, coach.id]);
  await db.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [team.id, a.id]);
  const org1 = await call('POST', '/organisations', { token: owner.token, body: { name: `Hilltop College ${R}`, kind: 'college', city: 'Pune' } });
  await call('PATCH', `/organisations/${org1.id}/institution`, { token: owner.token, body: { about: 'Sports degrees', website: 'https://hilltop.example', country: 'India', contact_email: 'admissions@hilltop.example', contact_phone: '+91 20 5550 0000', listed: true } });
  const org2 = await call('POST', '/organisations', { token: owner.token, body: { name: `Lakeside University ${R}`, kind: 'university', city: 'Austin' } });
  await call('PATCH', `/organisations/${org2.id}/institution`, { token: owner.token, body: { about: 'Athletics', website: 'https://lakeside.example', country: 'USA', contact_email: 'admissions@lakeside.example', contact_phone: '+1 512 555 0100', listed: true } });
  const b1 = await call('POST', '/me/bucket', { token: a.token, body: { target_type: 'institution', target_id: org1.id, status: 'applied', target_date: day(9) } });
  const b2 = await call('POST', '/me/bucket', { token: a.token, body: { target_type: 'institution', target_id: org2.id, status: 'applying' } });
  await call('POST', '/me/bucket', { token: a.token, body: { target_type: 'team', target_id: team.id, status: 'shortlisted' } });
  await call('POST', '/me/pathway/goals', { token: a.token, body: { kind: 'academic', academic_measure: 'percentage', baseline: 60, current: 72, target: 80, target_date: day(120) } });
  await call('POST', '/me/sport-profiles', { token: a.token, body: { sport: 'athletics', role: 'athlete', level: 'amateur' } });
  const ath = (await db.query("SELECT id FROM sports WHERE slug='athletics'")).rows[0].id;
  const def = (await db.query("INSERT INTO metric_definitions(sport_id, key, label, current_version) VALUES ($1,$2,'100 m time',1) RETURNING id", [ath, `sprint_${R}`.slice(0, 40)])).rows[0].id;
  await db.query("INSERT INTO metric_definition_versions(definition_id, version, unit, direction, aggregation, value_kind, min_value, max_value, points_mode, points_value, hash) VALUES ($1,1,'s','lower','best','decimal',8,30,'flat',0,'h')", [def]);
  await db.query("INSERT INTO performances(user_id, sport_id, metric, value, points, recorded_by, provenance, status, unit, direction, achieved_on) VALUES ($1,$2,$3,12.0,0,$1,'approved_competition','approved','s','lower', current_date - 3)", [a.id, ath, `sprint_${R}`.slice(0, 40)]);
  await call('POST', '/me/pathway/deadlines', { token: a.token, body: { kind: 'documents', bucket_id: b1.id, due_on: day(3) } });
  const sc = await call('POST', '/me/pathway/scholarships', { token: a.token, body: { bucket_id: b1.id, name: 'Sports bursary', amount_minor: 1200000, currency: 'INR', requirements: ['Latest transcript', 'Coach reference'] } });
  const ev = (await db.query("INSERT INTO academic_evidence(user_id, kind, institution) VALUES ($1,'transcript','Hill School') RETURNING id", [a.id])).rows[0].id;
  await call('POST', `/me/pathway/scholarship-items/${sc.items[0].id}/evidence`, { token: a.token, body: { source_type: 'academic_evidence', source_id: ev } });
  const o1 = await call('POST', '/me/pathway/offers', { token: a.token, body: { bucket_id: b1.id, title: 'BSc place', tuition_minor: 2000000, other_minor: 300000, scholarship_minor: 1200000, currency: 'INR', reply_by: day(20), conditions: 'GPA 3.2' } });
  await call('POST', '/me/pathway/offers', { token: a.token, body: { bucket_id: b2.id, title: 'Track scholarship', tuition_minor: 3000000, scholarship_minor: 1000000, currency: 'USD', reply_by: day(30) } });
  check(!!o1?.id, 'targets, goal, deadline, scholarship with evidence and two offers exist (API)');

  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const session = async (who, viewport) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 }); const page = await ctx.newPage();
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } }); if (!r.ok()) throw new Error('login failed');
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
  const tab = async (p, t) => { await p.getByText(t, { exact: true }).first().click(); await wait(p, 1500); };

  // ---------------------------------------------------------------- the athlete on a phone
  let shareId;
  {
    const { ctx, page: p } = await session(a, { width: 390, height: 844 });
    await navTo(p, 'Pathways');
    await tab(p, /^My plan/.test('My plan') ? 'My plan (3)' : 'My plan');
    check(await vis(p, 'Targets (3)') && await vis(p, 'Riverside FC'), 'My plan lists institution and team targets together');
    await shot(p, '01-targets-phone');
    await tab(p, 'Goals'); check(await vis(p, 'Grade (%)') && await vis(p, '72 → 80'), 'goals show current against target'); await shot(p, '02-goals-phone');
    await p.getByText('Add goal').first().click(); await wait(p, 1000);
    check(await vis(p, 'Athletics'), 'the goal wizard offers my sports, nothing to type');
    await p.getByText('Athletics', { exact: false }).first().click(); await wait(p, 1500);
    check(await vis(p, '100 m time') && await vis(p, 'Approved competition result') && await vis(p, 'Lower is better'), 'my sport metric shows my real approved figure and its direction');
    await p.getByText('100 m time').first().click(); await wait(p, 800);
    check(await vis(p, 'Beat my best by 1%'), 'suggested targets go in the good direction');
    await p.getByText(/Beat my best by 2%/).first().click(); await p.getByText('In 3 months').first().click(); await wait(p, 500);
    await shot(p, '03-goal-wizard-phone');
    await p.getByLabel('Add goal').last().click(); await wait(p, 2200);
    const goals = await call('GET', '/me/pathway/goals', { token: a.token });
    const sprint = goals.find((g) => g.metric_key?.startsWith('sprint_'));
    check(sprint && sprint.current === 12 && sprint.target === 11.76 && sprint.current_source === 'live', 'the goal is saved from picks only and follows my results by itself (API state)');
    check(await vis(p, '100 m time') && await vis(p, 'follows your results'), 'the new goal appears with live tracking');
    await tab(p, 'Deadlines'); check(await vis(p, 'Offer reply') && await vis(p, 'Application date') , 'deadlines gather own dates, application dates and offer replies'); await shot(p, '04-deadlines-phone');
    await tab(p, 'Scholarships'); check(await vis(p, '1 of 2 requirements met') && await vis(p, 'Self-reported'), 'scholarship shows evidence met and its honest provenance'); await shot(p, '05-scholarships-phone');
    await tab(p, 'Offers'); await p.getByText('Compare side by side').first().click(); await wait(p, 1500);
    check(await vis(p, 'Lowest net cost') === false && await vis(p, 'never converted'), 'offers in different currencies are shown separately and never converted'); await shot(p, '06-offers-compare-phone');
    await p.getByText('List', { exact: true }).first().click(); await wait(p, 800);
    await p.getByText('Decide').first().click(); await wait(p, 800); await p.getByText('Accept', { exact: true }).last().click(); await shot(p, '07-decision-sheet-phone');
    await p.getByText('Record decision').first().click(); await wait(p, 2000);
    const offers = await call('GET', '/me/pathway/offers', { token: a.token });
    check(offers.some((o) => o.status === 'accepted'), 'accepting in the UI is saved (API state)');
    await tab(p, 'Outcomes'); check(await vis(p, 'ACCEPTED 1') && await vis(p, 'offer accepted'), 'outcomes show the accepted stage and the decision in the history'); await shot(p, '08-outcomes-phone');
    shareId = (await call('POST', '/me/pathway/shares', { token: a.token, body: { recipient_id: coach.id, scopes: ['goals', 'deadlines', 'offers'] } })).id;
    await tab(p, 'Sharing'); check(await vis(p, 'Coach Meera') && await vis(p, 'Stop sharing'), 'sharing lists the coach and what they can see'); await shot(p, '09-sharing-phone');
    await ctx.close();
  }
  // ---------------------------------------------------------------- the coach on a tablet reads only what was shared
  {
    const { ctx, page: p } = await session(coach, { width: 1180, height: 1000 });
    await navTo(p, 'SharedPathway', { athlete_id: a.id });
    check(await vis(p, 'Asha Rao') && await vis(p, 'Grade (%)') && await vis(p, 'Offers'), 'the coach sees goals, deadlines and offers');
    check(!(await vis(p, 'Sports bursary', 800)) && !(await vis(p, 'Targets', 800)), 'unshared parts (scholarships, targets) are not shown');
    await shot(p, '10-coach-shared-plan-tablet');
    await ctx.close();
  }
  // ---------------------------------------------------------------- the athlete stops sharing; the coach loses access at once
  {
    const { ctx, page: p } = await session(a, { width: 390, height: 844 });
    await navTo(p, 'Pathways'); await tab(p, 'My plan (3)'); await tab(p, 'Sharing');
    await p.getByText('Stop sharing', { exact: true }).first().click(); await wait(p, 2000);
    check(await vis(p, 'Not shared with anyone'), 'stopping sharing shows the empty state'); await shot(p, '11-sharing-stopped-phone');
    await ctx.close();
  }
  {
    const { ctx, page: p } = await session(coach, { width: 390, height: 844 });
    await navTo(p, 'SharedPathway', { athlete_id: a.id });
    check(await vis(p, 'Not available'), 'the coach is told it is no longer available'); await shot(p, '12-coach-revoked-phone');
    await ctx.close();
  }
  await browser.close();
} catch (e) { log('ERROR', e.message); failures++; } finally { await db.end().catch(() => {}); api.kill(); web.close(); }
process.exit(failures ? 1 : 0);
