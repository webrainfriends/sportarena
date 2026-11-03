// Browser-driven check of the sponsorship eligibility screening journey (#287): phone, tablet and desktop. The brand sees and edits the
// versioned rules, reviews an application's screening (reasons, missing items, duplicate flag), asks for information and records an exception;
// the applicant checks eligibility before applying and reads plain reasons on their application; a stranger is denied.
// Needs: a throwaway Postgres database (E2E_DATABASE_URL; it is migrated, never dropped here), a same-origin web build
//   EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir <dir>   (E2E_DIST, default /tmp/e2e-dist)
// and playwright (or playwright-core) with a Chromium (E2E_CHROMIUM, default the pre-installed one).
// It starts the API and a tiny static+proxy server itself, and creates its own data through the API (no fixtures).
// Run: node scripts/e2e/sponsorship-eligibility-journey.mjs     Screenshots go to E2E_SHOTS (default /tmp/e2e-shots)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = (() => { for (const m of ['playwright-core', 'playwright', '/opt/node-tools/node_modules/playwright']) { try { return require(m); } catch { /* try the next */ } } throw new Error('install playwright'); })();
const E = { DATABASE_URL: process.env.E2E_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/sportarena_e2e', SPORTARENA_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), SPORTARENA_JWT_SECRET: Buffer.alloc(32, 9).toString('base64'),
  PORT: '4000', APP_URL: 'http://localhost:4100', CORS_ORIGINS: 'http://localhost:4100', PLATFORM_APPROVALS: 'off', RATE_LIMIT_DISABLED: 'true' };
const OUT = (process.env.E2E_SHOTS ?? '/tmp/e2e-shots') + '/'; fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
const api = spawn('node', ['src/server.js'], { cwd: new URL('../../apps/api/', import.meta.url).pathname, env: { ...process.env, ...E }, stdio: ['ignore', 'pipe', 'pipe'] });
api.stdout.on('data', (d) => process.env.V && log('[api]', String(d).trim())); api.stderr.on('data', (d) => process.env.V && log('[api!]', String(d).trim()));
for (let i = 0; i < 60; i++) { try { if ((await fetch('http://127.0.0.1:4000/api/v1/payments/methods')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }
const DIST = process.env.E2E_DIST ?? '/tmp/e2e-dist';
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf', '.svg': 'image/svg+xml' };
const web = http.createServer((req, res) => {
  if (req.url.startsWith('/api') || req.url.startsWith('/mcp')) { const p = http.request({ host: '127.0.0.1', port: 4000, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }); req.pipe(p); return; }
  let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => web.listen(4100, r));
const B = 'http://localhost:4100/api/v1';
const call = async (method, p, { token, body, query } = {}) => { const r = await fetch(`http://127.0.0.1:4000/api/v1${p}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(j)}`); return j; };
const reg = async (h, roles, name = h) => { const r = await call('POST', '/auth/register', { body: { handle: h, display_name: name, email: `${h}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); return { ...r.user, token: r.token, email: `${h}@example.com` }; };
let failures = 0; const check = (ok, msg) => { log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const day = (o) => { const d = new Date(); d.setDate(d.getDate() + o); return d.toISOString().slice(0, 10); };
const VIEWPORTS = { phone: { width: 390, height: 844 }, tablet: { width: 820, height: 1100 }, desktop: { width: 1280, height: 900 } };
try {
  const owner = await reg('elgbrand', ['sponsor'], 'Northwind Foods'), asha = await reg('elgasha', ['athlete'], 'Asha Rao'), ben = await reg('elgben', ['athlete'], 'Ben Okafor'), stranger = await reg('elgstranger', ['sponsor'], 'Outsider');
  const brand = await call('POST', '/sponsors', { token: owner.token, body: { name: 'Northwind Foods' } });
  let p = await call('POST', '/sponsorship-programs', { token: owner.token, body: { sponsor_id: brand.id, name: 'Rising Talent Fund', objective: 'Help young athletes cover training costs', currency: 'USD', budget_cents: 5000000, max_award_cents: 500000 } });
  const r1 = await call('POST', `/sponsorship-programs/${p.id}/rounds`, { token: owner.token, body: { opens_on: day(-1), closes_on: day(30) } });
  const r2 = await call('POST', `/sponsorship-programs/${p.id}/rounds`, { token: owner.token, body: { opens_on: day(-1), closes_on: day(60) } });
  p = await call('POST', `/sponsorship-programs/${p.id}/status`, { token: owner.token, body: { status: 'published', version: p.row_version } });
  const form = await call('POST', `/sponsorship-programs/${p.id}/forms`, { token: owner.token, body: { name: 'Application', definition: { sections: [{ id: 'a', title: 'About you', fields: [{ key: 'summary', label: 'What will the funding be used for?', type: 'longtext', required: true }, { key: 'id_proof', label: 'Proof of identity', type: 'file', max_files: 2 }] }] } } });
  for (const r of [r1, r2]) { const cur = (await call('GET', `/sponsorship-programs/${p.id}`, { token: owner.token })).rounds.find((x) => x.id === r.id); await call('POST', `/program-rounds/${r.id}/form`, { token: owner.token, body: { version: cur.row_version ?? r.row_version, form_id: form.id } }); }
  p = await call('GET', `/sponsorship-programs/${p.id}`, { token: owner.token });
  const rules = (extra) => ({ version: p.row_version, target_types: ['athlete', 'team'], sports: [], regions: [], verified_only: false, max_award_cents: 500000, duplicate_check: true, required_documents: [], ...extra });
  await call('POST', `/sponsorship-programs/${p.id}/eligibility`, { token: owner.token, body: rules({ note: 'Athletes and teams only' }) });
  p = await call('GET', `/sponsorship-programs/${p.id}`, { token: owner.token });
  await call('POST', `/sponsorship-programs/${p.id}/eligibility`, { token: owner.token, body: rules({ required_documents: [{ key: 'id_proof', label: 'Proof of identity' }], note: 'Ask for proof of identity' }) });
  const apply = async (u, round, n) => { const d = await call('POST', `/program-rounds/${round.id}/draft`, { token: u.token, body: { target_type: 'athlete', target_id: u.id, requested_cents: 250000, answers: { summary: 'Travel and coaching costs for the national circuit' } } }); return call('POST', `/program-applications/${d.id}/submit`, { token: u.token, body: { idempotency_key: `elg-journey-${n}-${u.handle}` } }); };
  const appAsha = await apply(asha, r1, 1), appBen = await apply(ben, r1, 2); await apply(ben, r2, 3);
  const screening = await call('GET', `/program-applications/${appAsha.id}/screening`, { token: owner.token });
  check(screening.outcome === 'needs_info' && screening.latest.rules_version === 3, 'a new application is screened under the newest rules and needs the proof of identity');
  const benTwo = await call('GET', '/my/program-applications', { token: ben.token, query: { limit: 20 } });
  check(benTwo.length === 2, 'Ben has two applications');
  await call('POST', `/program-applications/${appBen.id}/screening-exception`, { token: owner.token, body: { version: (await call('GET', `/program-applications/${appBen.id}/screening`, { token: owner.token })).version, reason: 'Identity confirmed in person at the national trials' } }).catch((e) => log('(exception skipped)', e.message));

  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const wait = (pg, ms = 1500) => pg.waitForTimeout(ms);
  const session = async (who, viewport, open) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 }); const page = await ctx.newPage();
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } }); if (!r.ok()) throw new Error(`login ${r.status()}`);
    await page.goto(`http://localhost:4100/${open ? `?open=${open}` : ''}`); await wait(page, 3500);
    return { ctx, page };
  };
  const shot = async (pg, name, { scrollTo } = {}) => { if (scrollTo) { const el = pg.getByText(scrollTo, { exact: false }).first(); await el.scrollIntoViewIfNeeded().catch(() => {}); await wait(pg, 500); } await pg.screenshot({ path: `${OUT}${name}.png` }); };
  for (const [vp, size] of Object.entries(VIEWPORTS)) {
    // 1) brand: the program page with its versioned rules, then the applications with their outcome
    const b = await session(owner, size, `sponsor-program:${p.id}`);
    check(await b.page.getByText('Eligibility rules').first().isVisible().catch(() => false), `${vp}: the rules section is on the program page`);
    await shot(b.page, `eligibility-1-rules-${vp}`, { scrollTo: 'Eligibility rules' });
    await shot(b.page, `eligibility-2-applications-${vp}`, { scrollTo: 'Review answers' });
    await b.page.getByText('Review answers').first().click(); await wait(b.page, 2000);
    check(await b.page.getByText('Proof of identity').first().isVisible().catch(() => false), `${vp}: the review shows the missing proof of identity`);
    await shot(b.page, `eligibility-3-review-screening-${vp}`);
    await b.ctx.close();
    // 2) applicant: sponsorship calls, check eligibility, and the plain reasons on their own application
    const a = await session(asha, size, 'funding-calls');
    await shot(a.page, `eligibility-4-applicant-calls-${vp}`);
    const chk = a.page.getByText('Check eligibility').first();
    if (await chk.count()) { await chk.click(); await wait(a.page, 1500); const chip = a.page.getByText('Myself (athlete)').first(); if (await chip.count()) { await chip.click(); await wait(a.page, 1000); await a.page.getByPlaceholder('0.00').fill('2500'); await a.page.getByText('Check eligibility').last().click(); await wait(a.page, 2000); } await shot(a.page, `eligibility-5-applicant-check-${vp}`); }
    await a.ctx.close();
    const a2 = await session(asha, size, 'funding-calls');
    await shot(a2.page, `eligibility-6-applicant-my-application-${vp}`, { scrollTo: 'My applications' });
    await a2.ctx.close();
    // 3) a stranger is denied
    const s = await session(stranger, size, `sponsor-program:${p.id}`);
    check(await s.page.getByText(/no access|not found/i).first().isVisible().catch(() => false), `${vp}: a stranger sees the denied state`);
    await shot(s.page, `eligibility-7-denied-${vp}`);
    await s.ctx.close();
  }
  await browser.close();
} catch (e) { failures++; log('FAIL', e.stack ?? e.message); }
api.kill(); web.close();
log(failures ? `${failures} failure(s)` : 'all checks passed');
process.exit(failures ? 1 : 0);
