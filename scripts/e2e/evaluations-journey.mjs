// Browser-driven check of evaluations: the coach's evaluation sheet, scoring an athlete with anchors, targets, evidence and written feedback, sharing it,
// the athlete's self-assessment and response, on phone, tablet and desktop. All data is created through the public API; nothing is seeded.
// Needs: a throwaway Postgres database (E2E_DATABASE_URL, migrated, never dropped here), a same-origin web build
//   EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir <dir>   (E2E_DIST, default /tmp/e2e-dist)
// and playwright with a Chromium (E2E_CHROMIUM). Run: node scripts/e2e/evaluations-journey.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import pg from 'pg';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.E2E_PLAYWRIGHT ?? 'playwright');
const E = { DATABASE_URL: process.env.E2E_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/sportarena_e2e', SPORTARENA_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), SPORTARENA_JWT_SECRET: Buffer.alloc(32, 9).toString('base64'),
  PORT: '4000', APP_URL: 'http://localhost:4100', CORS_ORIGINS: 'http://localhost:4100', PLATFORM_APPROVALS: 'off', PLATFORM_ADMIN_EMAILS: 'rraja.edge@gmail.com,rrajas1978@icloud.com', RATE_LIMIT_DISABLED: 'true' };
const OUT = (process.env.E2E_SHOTS ?? '/tmp/e2e-shots') + '/'; fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
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
const call = async (method, p, { token, body, expect } = {}) => { const r = await fetch(`http://127.0.0.1:4000/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => ({})); if (expect ? r.status !== expect : r.status >= 300) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(j)}`); return { status: r.status, ...j }; };
const reg = async (h, name, email = `${h}@example.com`) => { const r = await call('POST', '/auth/register', { body: { handle: h, display_name: name, email, password: 'correct-horse-battery', roles: ['organizer'] } }); return { token: r.token, id: r.user.id, handle: h, email }; };
const db = new pg.Pool({ connectionString: E.DATABASE_URL });
let failures = 0; const check = (ok, msg) => { log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const wait = (p, ms = 1200) => p.waitForTimeout(ms);
const R = Math.random().toString(36).slice(2, 7);
const reg2 = async (h, name, roles) => { const r = await call('POST', '/auth/register', { body: { handle: `${h}${R}`, display_name: name, email: `${h}${R}@example.com`, password: 'correct-horse-battery', roles } }); return { token: r.token, id: r.user.id, handle: `${h}${R}`, email: `${h}${R}@example.com` }; };
const at10 = (days) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + days); d.setUTCHours(10, 0, 0, 0); return d.toISOString(); };
try {
  const coach = await reg2('ev_coach', 'Coach Meera', ['coach']);
  const asha = await reg2('ev_asha', 'Asha Rao', ['athlete']);
  await call('POST', '/me/sport-profiles', { token: coach.token, body: { sport: 'football', role: 'coach', level: 'pro', hourly_rate_cents: 70000 } });
  const card = await call('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'Midfield clinic', sport: 'football', audience: 'group', delivery: 'both', unit: 'session', duration_min: 60, price_cents: 0, per_person: true, min_participants: 1, max_participants: 10 } });
  const k = await call('POST', '/coach/classes', { token: coach.token, body: { rate_card_id: card.id, starts_at: at10(2), online_url: 'https://meet.example.com/mid', title: 'Midfield clinic', max_participants: 8 } });
  await call('POST', `/coach/classes/${k.id}/join`, { token: asha.token, body: {} });
  const D = (key, name, pillar, weight, extra = {}) => ({ key, name, pillar, weight, scale_min: 1, scale_max: 5, ...extra });
  const sheet = await call('POST', '/coaching/rubrics', { token: coach.token, body: { name: 'Central midfield profile', sport: 'football', dimensions: [
    D('first_touch', 'First touch', 'technical', 2, { description: 'Control and next action under pressure', target: 5, labels: { 1: 'Developing', 3: 'Competent', 5: 'Elite' }, anchors: { 1: 'Loses the ball on receipt', 3: 'Controls cleanly, plays safe', 5: 'Controls and plays forward in one movement under pressure' }, evidence_hint: 'Count touches under pressure in the 3v2' }),
    D('passing_range', 'Passing range', 'technical', 1, { labels: { 3: 'Competent' }, anchors: { 3: 'Short and medium passes reliably, long with mixed accuracy' } }),
    D('scanning', 'Scanning', 'tactical', 2, { description: 'Information gathered before receiving', target: 4, anchors: { 1: 'Rarely looks before the ball arrives', 4: 'Scans twice before receiving and adjusts the first touch' } }),
    D('positioning', 'Positioning between lines', 'game_intelligence', 1, { pillar_label: 'Game intelligence' }),
    { key: 'sprint', name: '30 m sprint', pillar: 'physical', weight: 1, scale_min: 3, scale_max: 6, direction: 'lower_is_better', unit: 's', input: 'number', step: 0.1, target: 4 },
    D('repeat_sprint', 'Repeat sprint ability', 'physical', 1),
    D('composure', 'Composure under pressure', 'mental', 1, { anchors: { 2: 'Rushes decisions when pressed', 4: 'Stays calm, takes the extra second' } }),
    D('coachability', 'Response to coaching', 'behaviour', 1),
    D('recovery_habits', 'Recovery habits', 'lifestyle', 0.5)] } });
  const rid = sheet.rubric_id ?? sheet.id;
  const ev = (athleteId, body) => call('POST', '/coaching/evaluations', { token: coach.token, body: { athlete_id: athleteId, rubric_id: rid, ...body } });
  const patch = async (id, body) => { const cur = await call('GET', `/coaching/evaluations/${id}`, { token: coach.token }); return call('PATCH', `/coaching/evaluations/${id}`, { token: coach.token, body: { row_version: cur.row_version, ...body } }); };
  // last term's evaluation, already shared: the baseline the new one is compared with
  const old = await ev(asha.id, { title: 'Autumn term review', context_type: 'period', period_from: '2026-09-01', period_to: '2026-10-15' });
  await patch(old.id, { scores: { first_touch: { score: 2 }, passing_range: { score: 3 }, scanning: { score: 2 }, positioning: { score: 3 }, sprint: { score: 4.8 }, repeat_sprint: { score: 3 }, composure: { score: 3 }, coachability: { score: 4 }, recovery_habits: { score: 3 } }, narrative: { strengths: 'Tidy on the ball' } });
  await call('POST', `/coaching/evaluations/${old.id}/share`, { token: coach.token, body: {} });
  await new Promise((r) => setTimeout(r, 30));
  // the new one: the athlete rated herself first, the coach scored with evidence and wrote feedback, then shared
  const cur = await ev(asha.id, { title: 'Winter review: central midfield', context_type: 'period', period_from: '2026-10-16', period_to: '2026-11-30', request_self_assessment: true });
  await call('POST', `/me/coaching-evaluations/${cur.id}/self`, { token: asha.token, body: { scores: { first_touch: { score: 4, comment: 'I feel much more comfortable receiving on the half-turn.' }, passing_range: { score: 4 }, scanning: { score: 4, comment: 'I always look before I receive.' }, positioning: { score: 3 }, sprint: { score: 4.4 }, repeat_sprint: { score: 3 }, composure: { score: 4 }, coachability: { score: 5 }, recovery_habits: { score: 3 } } } });
  await patch(cur.id, { scores: {
    first_touch: { score: 3, comment: 'Clean in space; still loses it when pressed from behind.', evidence: [{ type: 'clip', text: 'Turn under pressure, missed first touch', url: 'https://clips.example.com/asha-3v2', at: '12:40' }, { type: 'note', text: '7 of 11 touches under pressure retained in the 3v2' }] },
    passing_range: { score: 4 }, scanning: { score: 2, comment: 'Head down on the ball: she looks after receiving, not before.', evidence: [{ type: 'note', text: 'Scanned before receiving on 3 of 12 occasions' }] },
    positioning: { score: 3 }, sprint: { score: 4.5 }, repeat_sprint: { score: 3 }, composure: { score: 3 }, coachability: { score: 5, comment: 'Applies every cue within the session.' }, recovery_habits: { score: 4 } },
    narrative: { strengths: 'Receives in space cleanly. Applies coaching immediately. Reliable short and medium passing.', development: '1. Scan twice before the ball arrives. 2. First touch away from pressure. 3. Repeat sprint ability late in sessions.', cues: 'Shoulder check, open body, first touch into the free space.', next_steps: 'Three weeks of 3v2 receiving drills with video review. Re-test the 30 m sprint in four weeks.', private: 'Consider for the regional trial squad if scanning improves.' } });
  await call('POST', `/coaching/evaluations/${cur.id}/share`, { token: coach.token, body: { note: 'Read it through, then tell me where you disagree. Friday works for a talk.' } });
  await call('POST', `/me/coaching-evaluations/${cur.id}/respond`, { token: asha.token, body: { reactions: { first_touch: 'agree', scanning: 'disagree', composure: 'discuss' }, comment: 'I accept the first touch point. I want to see the clip on scanning, I think I do look first.', questions: 'Can we review the 3v2 footage together?' } });
  const sheetsList = await call('GET', '/coaching/rubrics', { token: coach.token });
  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const session = async (who, viewport) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 }); const page = await ctx.newPage();
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } }); if (!r.ok()) throw new Error(`login ${r.status()} ${await r.text()}`);
    await page.goto('http://localhost:4100/'); await page.waitForTimeout(5000);
    return { ctx, page };
  };
  const shot = (page, n) => page.screenshot({ path: `${OUT}${n}.png`, fullPage: false });
  const vis = async (p, t, ms = 4000) => { try { await p.getByText(t).last().waitFor({ state: 'visible', timeout: ms }); return true; } catch { return false; } };
  const navTo = async (p, name, params = {}) => {
    await p.evaluate(({ name, params }) => {
      if (!window.__nav) {
        const root = document.getElementById('root') ?? document.body.firstElementChild;
        const key = Object.keys(root).find((k) => k.startsWith('__reactContainer'));
        const todo = [root[key]];
        while (todo.length && !window.__nav) { const n = todo.pop(); const v = n.memoizedProps?.value; if (v && typeof v.push === 'function' && typeof v.goTab === 'function' && v.tab === undefined) { window.__nav = v; break; } if (n.sibling) todo.push(n.sibling); if (n.child) todo.push(n.child); }
      }
      if (!window.__nav) throw new Error('navigator not found');
      window.__nav.push(name, params);
    }, { name, params });
    await wait(p, 2400);
  };
  const VIEWS = [['phone', { width: 390, height: 844 }], ['tablet', { width: 820, height: 1180 }], ['desktop', { width: 1366, height: 900 }]];
  for (const [name, viewport] of VIEWS) {
    const c1 = await session(coach, viewport);
    await navTo(c1.page, 'Evaluation', { id: cur.id });
    check(await vis(c1.page, 'First touch'), `${name}: the coach sees the criteria`);
    check(await vis(c1.page, 'since last time'), `${name}: the change since the previous evaluation is shown`);
    check(await vis(c1.page, 'Self gap'), `${name}: the gap to the athlete's own view is shown`);
    await shot(c1.page, `01-evaluation-${name}`);
    await c1.page.getByText('Written feedback').first().scrollIntoViewIfNeeded().catch(() => {}); await wait(c1.page, 600); await shot(c1.page, `02-evaluation-feedback-${name}`);
    await c1.page.getByText('Share or export', { exact: true }).last().evaluate((el) => el.scrollIntoView({ block: 'center' })); await c1.page.getByText('Share or export', { exact: true }).last().click({ force: true }); await wait(c1.page, 1200);
    check(await vis(c1.page, 'Share on WhatsApp or other apps'), `${name}: the export sheet offers WhatsApp and other apps`);
    check(await vis(c1.page, 'Send to Asha Rao in the app'), `${name}: the export sheet offers sending to the athlete in the app`);
    await shot(c1.page, `06-export-${name}`);
    await c1.page.keyboard.press('Escape'); await wait(c1.page, 500);
    await navTo(c1.page, 'CoachRubrics');
    check(await vis(c1.page, 'Evaluation sheets'), `${name}: the sheet list is the evaluation sheets screen`);
    const editBtn = c1.page.getByRole('button', { name: 'Edit: Central midfield profile' }).last(); await editBtn.evaluate((el) => el.scrollIntoView({ block: 'center' })); await editBtn.click({ force: true }); await wait(c1.page, 1200);
    await c1.page.getByText('First touch').last().click(); await wait(c1.page, 700);
    check(await vis(c1.page, 'Balance of the sheet'), `${name}: the sheet builder shows the balance of pillars`);
    await shot(c1.page, `03-sheet-builder-${name}`);
    await navTo(c1.page, 'Evaluations');
    check(await vis(c1.page, 'Winter review: central midfield'), `${name}: the desk lists the evaluation`);
    await shot(c1.page, `04-desk-${name}`);
    await c1.ctx.close();
    const a1 = await session(asha, viewport);
    await navTo(a1.page, 'MyEvaluation', { id: cur.id });
    check(await vis(a1.page, 'A note from your coach'), `${name}: the athlete sees the coach's note`);
    check(await vis(a1.page, 'My view'), `${name}: the athlete's own view sits beside each criterion`);
    await shot(a1.page, `05-my-evaluation-${name}`);
    await a1.ctx.close();
  }
  await browser.close();
} catch (e) { failures++; log('FAIL ', e.stack ?? e); }
api.kill(); web.close(); await db.end();
log(failures ? `${failures} FAILED` : 'ALL PASSED'); process.exit(failures ? 1 : 0);
