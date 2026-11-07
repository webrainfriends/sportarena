// Photographs the promotion, squad transfer & graduation screens (#800) from the real app at phone, tablet and desktop widths, light and dark,
// with real data created through the public API (its own throwaway database; nothing is seeded into the product).
//   EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir /tmp/e2e-dist
//   E2E_DATABASE_URL=postgres://postgres@127.0.0.1:5432/sportarena_e2e UX_SHOTS=docs/ux node scripts/e2e/academy-promotion-ux.mjs
// desktop, and records which screen files they came from (apps/api/assets/guides/academy/manifest.json). Run after any change to an
// organisation / academy / venue / coach / tax screen:   npm run guide:shots
// Needs a throwaway Postgres (E2E_DATABASE_URL, migrated here, never dropped), a same-origin web build
//   EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir /tmp/e2e-dist     (E2E_DIST)
// and playwright-core with a Chromium (E2E_CHROMIUM, default the pre-installed one). All data is created through the public API.
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
const addDays = (d, k) => new Date(Date.parse(`${d}T00:00:00Z`) + k * 864e5).toISOString().slice(0, 10);
const today = new Date().toISOString().slice(0, 10);
let failures = 0;
try {
  const db = new pg.Pool({ connectionString: DB });
  const owner = await reg('cap_owner', 'Priya Nair', ['organizer', 'venue_manager']), coach = await reg('cap_coach', 'Alex Lee', ['coach']), coach2 = await reg('cap_coach2', 'Marta Ruiz', ['coach']), finance = await reg('cap_fin', 'Sam Okoye', ['organizer']);
  const org = await call('POST', '/organisations', { token: owner.token, body: { name: 'Riverside Academy', kind: 'academy', city: 'Pune' } });
  for (const [u, role] of [[coach, 'coach'], [finance, 'finance']]) { await call('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role } }); await call('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } }); }
  await call('PATCH', `/organisations/${org.id}/academy`, { token: owner.token, body: { row_version: 0, sports: ['football'], currency: 'INR', listed: true } });
  const prog = await call('POST', `/organisations/${org.id}/academy/programmes`, { token: owner.token, body: { sport: 'football', title: 'Football Development', format: 'term_course', age_min: 9, age_max: 16, capacity: 30, admission_mode: 'direct', public: true } });
  const pub = await call('POST', `/academy/programmes/${prog.id}/versions`, { token: owner.token, body: { row_version: prog.row_version, billing_model: 'monthly', currency: 'INR', fee_minor: 450000 } });
  const mk = async (name, capacity) => { const k = await call('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name, coach_id: coach.id } }); await db.query('UPDATE org_cohorts SET programme_id=$2, capacity=$3 WHERE id=$1', [k.id, pub.programme.id, capacity]); return k; };
  const u12 = await mk('U12 Football', 20), u14 = await mk('U14 Football', 12), u14full = await mk('U14 Elite (full)', 1);
  const names = ['Aarav M.', 'Kabir S.', 'Noah P.', 'Ishaan R.', 'Leo T.', 'Mateo G.'];
  const kids = []; for (let k = 0; k < names.length; k++) kids.push(await reg(`pr_kid${k}`, names[k], ['athlete']));
  await call('POST', `/cohorts/${u12.id}/enrolments`, { token: owner.token, body: { csv: `handle,consent\n${kids.map((p) => `${p.handle},yes`).join('\n')}` } });
  await db.query('UPDATE org_enrolments SET programme_id=$1 WHERE cohort_id=$2', [pub.programme.id, u12.id]);
  const filler = await reg('pr_filler', 'Filler F.', ['athlete']);
  await call('POST', `/cohorts/${u14full.id}/enrolments`, { token: owner.token, body: { csv: `handle,consent\n${filler.handle},yes` } });
  await db.query('UPDATE org_enrolments SET programme_id=$1 WHERE cohort_id=$2', [pub.programme.id, u14full.id]);
  const pw = await call('POST', `/organisations/${org.id}/academy/pathways`, { token: owner.token, body: { title: 'Football pathway', sport: 'football' } });
  await call('POST', `/academy/pathways/${pw.id}/versions`, { token: owner.token, body: { row_version: 1, levels: [{ key: 'u12', title: 'U12', position: 1 }, { key: 'u14', title: 'U14', position: 2 }] } });
  await db.query("UPDATE academy_pathways SET status='active' WHERE id=$1", [pw.id]);
  const ver = (await db.query('SELECT id FROM academy_pathway_versions WHERE pathway_id=$1', [pw.id])).rows[0].id;
  const decide = async (k, decision) => (await db.query("INSERT INTO academy_progression_decisions(organisation_id, athlete_id, pathway_id, version_id, decision, from_level, to_level, reason, decided_by, criteria_snapshot) VALUES ($1,$2,$3,$4,$5,'u12',$6,'Meets the pathway criteria after the spring assessment',$7,'{\"outcome\":\"criteria_met\"}') RETURNING *", [org.id, k.id, pw.id, ver, decision, decision === 'graduate' ? null : 'u14', owner.id])).rows[0];
  const enrolOf = async (k) => (await db.query('SELECT id FROM org_enrolments WHERE user_id=$1 AND cohort_id=$2', [k.id, u12.id])).rows[0].id;
  const squad = await call('POST', '/teams', { token: owner.token, body: { name: 'Riverside U14 Squad', sport: 'football' } });
  const foreign = await reg('pr_foreign', 'Other Manager', ['organizer']);
  const foreignTeam = await call('POST', '/teams', { token: foreign.token, body: { name: 'Another Club U14', sport: 'football' } });
  const plan = async (k, decision, body) => { const d = await decide(k, decision); return call('POST', `/academy/decisions/${d.id}/promotion`, { token: owner.token, body: { enrolment_id: await enrolOf(k), ...body } }); };
  const approve = (r, stage = 'plan') => call('POST', `/academy/promotions/${r.id}/approve`, { token: owner.token, body: { stage, row_version: r.row_version } });
  // Aarav: group move + squad, approved, the squad answer is outstanding
  const a = await plan(kids[0], 'promote', { to_cohort_id: u14.id, team_id: squad.id, note: 'Technical director signed off at the spring review' }); await approve(a);
  // Kabir: planned, every check passes, waiting for a person to approve
  await plan(kids[1], 'promote', { to_cohort_id: u14.id });
  // Noah: the destination group is full, so the plan cannot be approved
  await plan(kids[2], 'move_programme', { to_cohort_id: u14full.id });
  // Ishaan: graduation, every earlier step done, waiting for the final approval
  const g = await plan(kids[3], 'graduate', { cert_title: 'Riverside U12 Graduate' }); await approve(g);
  // Leo: the squad belongs to another club, so the invitation fails and the run needs attention
  const l = await plan(kids[4], 'promote', { to_cohort_id: u14.id, team_id: foreignTeam.id }); await approve(l);
  // Mateo: completed end to end
  const m = await plan(kids[5], 'promote', { to_cohort_id: u14.id }); await approve(m);

  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const open = async (viewport, who = owner, dark = false) => {
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
    await wait(p, 2200);
  };
  const SIZES = { phone: { width: 390, height: 844 }, tablet: { width: 820, height: 1180 }, desktop: { width: 1280, height: 900 } };
  const board = async (p) => { await navTo(p, 'Org', { id: org.id }); await click(p, 'Academy'); await click(p, 'Progress'); await click(p, 'Promotions'); };
  const detail = (who, filter) => async (p) => { await board(p); if (filter) await click(p, filter); await p.getByText(who, { exact: false }).first().click(); await wait(p, 2200); };
  const shot = async (name, size, fn, { who = owner, dark = false, full = true, tall = false } = {}) => {
    if (process.env.ONLY && !process.env.ONLY.split(',').some((x) => name.startsWith(x))) return;
    const page = await open(tall ? { ...SIZES[size], height: size === 'phone' ? 3200 : 2400 } : SIZES[size], who, dark);
    try { await fn(page); await page.screenshot({ path: path.join(OUT, `promotion-${name}-${size}${dark ? '-dark' : ''}.png`), fullPage: full }); log(`PASS  ${name} ${size}${dark ? ' dark' : ''}`); }
    catch (e) { failures++; log(`FAIL  ${name} ${size}: ${e.message.split('\n')[0]}`); await page.screenshot({ path: `/tmp/promotion-fail-${name}-${size}.png` }); }
    await page.context().close();
  };
  for (const size of ['phone', 'tablet', 'desktop']) {
    await shot('0-baseline-progress', size, async (p) => { await navTo(p, 'Org', { id: org.id }); await click(p, 'Academy'); await click(p, 'Progress'); }, { tall: true });
    await shot('1-board', size, board, { tall: true });
    await shot('2-awaiting-answer', size, detail('Aarav'), { tall: true });
    await shot('3-awaiting-approval', size, detail('Kabir'), { tall: true });
    await shot('4-blocked-capacity', size, detail('Noah'), { tall: true });
    await shot('5-final-approval', size, detail('Ishaan'), { tall: true });
    await shot('6-needs-attention', size, detail('Leo'), { tall: true });
    await shot('7-completed', size, detail('Mateo', 'Completed'), { tall: true });
  }
  await shot('1-board', 'tablet', board, { dark: true, tall: true });
  await shot('4-blocked-capacity', 'phone', detail('Noah'), { dark: true, tall: true });
  await shot('8-coach-view', 'phone', board, { who: coach, tall: true });
  await shot('9-denied-outsider', 'phone', async (p) => { await navTo(p, 'Org', { id: org.id }); await wait(p, 1500); }, { who: kids[0], full: false });
  for (const size of ['phone', 'tablet']) await shot('10-athlete-view', size, async (p) => { await navTo(p, 'AcademyFamily'); await click(p, 'Progress'); await wait(p, 2000); }, { who: kids[0], tall: true });
  await browser.close();
} catch (e) { failures++; log('ERROR', e); }
api.kill(); web.close();
log(failures ? `${failures} failure(s)` : 'all promotion screens photographed');
process.exit(failures ? 1 : 0);
