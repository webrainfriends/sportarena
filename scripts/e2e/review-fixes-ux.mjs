// Photographs the screens touched by the review-fixes change from the real app (data residency, the More swivel for an athlete, the referee
// workbench and set-up, rate cards in the profile wizard, the open-position application and its documents, the rulebook) at phone, tablet and
// desktop widths, light and dark. All data is created through the public API; nothing is seeded.
//   EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir /tmp/e2e-dist
//   E2E_DATABASE_URL=postgres://postgres:pw@localhost:5432/sportarena_ux UX_SHOTS=/tmp/shots node scripts/e2e/review-fixes-ux.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const { chromium } = (() => { for (const n of [process.env.PLAYWRIGHT_PATH, 'playwright-core', 'playwright']) { if (!n) continue; try { return req(n); } catch {} } throw new Error('playwright is not installed'); })();

const API_DIR = new URL('../../apps/api/', import.meta.url).pathname;
const DB = process.env.E2E_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/sportarena_e2e';
const E = { DATABASE_URL: DB, SPORTARENA_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), SPORTARENA_JWT_SECRET: Buffer.alloc(32, 9).toString('base64'), PORT: '4000', APP_URL: 'http://localhost:4100', CORS_ORIGINS: 'http://localhost:4100', PLATFORM_APPROVALS: 'off', RATE_LIMIT_DISABLED: 'true' };
const OUT = process.env.UX_SHOTS ?? 'docs/ux'; fs.mkdirSync(OUT, { recursive: true });
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const log = (...a) => console.log(...a);
execFileSync('node', ['src/migrate.js'], { cwd: API_DIR, env: { ...process.env, ...E }, stdio: 'ignore' });
const api = spawn('node', ['src/server.js'], { cwd: API_DIR, env: { ...process.env, ...E }, stdio: ['ignore', 'pipe', 'pipe'] });
api.stderr.on('data', (d) => process.env.V && log('[api!]', String(d).trim()));
for (let i = 0; i < 60; i++) { try { if ((await fetch('http://127.0.0.1:4000/api/v1/payments/methods')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }
const DIST = process.env.E2E_DIST ?? '/tmp/e2e-dist';
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf', '.webmanifest': 'application/json' };
const web = http.createServer((rq, res) => {
  if (rq.url.startsWith('/api') || rq.url.startsWith('/mcp')) {
    const p = http.request({ host: '127.0.0.1', port: 4000, path: rq.url, method: rq.method, headers: rq.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    p.on('error', () => { res.writeHead(502); res.end(); }); rq.pipe(p); return;
  }
  let f = path.join(DIST, decodeURIComponent(rq.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => web.listen(4100, r));

const call = async (method, p, { token, body, raw, type } = {}) => {
  const r = await fetch(`http://127.0.0.1:4000/api/v1${p}`, { method, headers: { 'content-type': type ?? 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) { log(`  ! ${method} ${p} -> ${r.status} ${t.slice(0, 200)}`); return null; }
  return j;
};
const stamp = Date.now().toString(36);
const reg = async (h, name, roles) => { const email = `${h}_${stamp}@example.com`; const r = await call('POST', '/auth/register', { body: { handle: `${h}_${stamp}`, display_name: name, email, password: 'correct-horse-battery', roles } }); return { ...r.user, token: r.token, email }; };
const wait = (p, ms = 1500) => p.waitForTimeout(ms);
const day = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
let failures = 0;
try {
  const organiser = await reg('rf_org', 'Priya Nair', ['organizer']);
  const referee = await reg('rf_ref', 'Rohan Mehta', ['referee']);
  const athlete = await reg('rf_ath', 'Aarav Shah', ['athlete']);       // no home country yet: the banner and the country step
  const settled = await reg('rf_set', 'Meera Iyer', ['athlete']);       // country saved and storage agreed

  // an athlete whose country has no in-country storage agrees to the fallback, through the same capability the screen calls
  await call('PATCH', '/me/home-country', { token: settled.token, body: { home_country: 'US' } });
  const pol = await call('GET', '/data-residency/preview?country=US', { token: settled.token });
  await call('POST', '/data-residency/consent/singapore', { token: settled.token, body: { source_country: 'US', policy_version: pol.policy_version, policy_text_hash: pol.policy_text_hash, data_categories: ['profile_identity', 'sport_records', 'device_session', 'payment_references'], purposes: ['platform_access', 'event_management'] } });

  // the referee: profile part-way, two rate cards, a payout account waiting for checks
  await call('POST', '/me/official-profile', { token: referee.token, body: { display_name_pref: 'Rohan Mehta', bio: 'National panel referee, fifteen seasons.', nationality: 'IN', step_reached: 7 } });
  const opts = await call('GET', '/me/official-profile/options', { token: referee.token });
  const football = opts.sports.find((s) => s.name === 'Football') ?? opts.sports[0];
  await call('PUT', '/me/official-profile/sports', { token: referee.token, body: { sports: [{ sport_id: football.id, role: 'referee', primary_sport: true }] } });
  await call('POST', '/me/sport-profiles', { token: referee.token, body: { sport: 'football', role: 'referee', level: 'pro', experience_years: 15 } });
  await call('POST', '/me/official-profile/rate-cards', { token: referee.token, body: { name: 'League match', sport_id: football.id, role: 'referee', fixture_type: 'league', fee_minor: 250000, fee_currency: 'INR', service_type: 'match', weekend_sat_pct: 25, weekend_sun_pct: 25, status: 'active' } });
  await call('POST', '/me/official-profile/rate-cards', { token: referee.token, body: { name: 'Tournament day', sport_id: football.id, role: 'referee', fixture_type: 'tournament', fee_minor: 600000, fee_currency: 'INR', service_type: 'day' } });

  // an open referee position, applied for with the full form and two supporting documents
  const ev = await call('POST', '/events', { token: organiser.token, body: { name: 'Pune Champions Cup', sport: 'football', starts_on: day(20), ends_on: day(22), city: 'Pune' } });
  const role = await call('POST', `/events/${ev.id}/staff-roles`, { token: organiser.token, body: { role: 'referee', needed: 4, fee_cents: 250000, requirements: 'State panel or above. Fitness test within the last 12 months.' } });
  const app = await call('POST', `/staff-roles/${role.id}/apply`, { token: referee.token, body: { message: 'Fifteen seasons on the national panel, including two state finals. Available for all three days and happy to mentor the assistant referees.', fee_cents: 300000,
    application_data: { strengths: ['Game management', 'Fitness', 'Mentoring'], experience_level: 'expert', years_active: 15, has_qualification: true, qualification_body: 'All India Football Federation', qualification_level: 'Category 1', qualification_ref: 'AIFF-REF-20411', qualification_expires: day(400), confirms_dates: true, transport: 'own_vehicle', accommodation_needed: false, additional: 'Kit size L. Vegetarian meals.' } } });
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
  for (const title of ['Licence · AIFF Category 1', 'Insurance · Public liability 2026']) await call('PUT', `/staff-assignments/${app.id}/documents?title=${encodeURIComponent(title)}`, { token: referee.token, raw: pdf, type: 'application/pdf' });

  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const open = async (viewport, who, dark, locale) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: locale ?? 'en-IN' }); const page = await ctx.newPage();
    if (dark) await ctx.addInitScript(() => { try { localStorage.setItem('theme', 'dark'); } catch {} });
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    const r = await ctx.request.post('http://localhost:4100/api/v1/auth/login', { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } });
    if (!r.ok()) throw new Error(`login ${r.status()}`);
    await page.goto('http://localhost:4100/'); await wait(page, 2800);
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
    await wait(p, 2400);
  };
  const SIZES = { phone: { width: 390, height: 844 }, tablet: { width: 820, height: 1180 }, desktop: { width: 1280, height: 900 } };
  const shot = async (name, size, who, fn, { dark = false, full = false, locale } = {}) => {
    if (ONLY && !ONLY.some((o) => name.startsWith(o))) return;
    const page = await open(SIZES[size], who, dark, locale);
    try { await fn(page); await page.screenshot({ path: path.join(OUT, `${name}-${size}${dark ? '-dark' : ''}.png`), fullPage: full }); log(`PASS  ${name} ${size}${dark ? ' dark' : ''}`); }
    catch (e) { failures++; log(`FAIL  ${name} ${size}: ${e.message.split('\n')[0]}`); await page.screenshot({ path: path.join(OUT, `FAIL-${name}-${size}.png`) }).catch(() => {}); }
    await page.context().close();
  };
  const tap = async (p, text, n = 0) => { await p.getByText(text, { exact: true }).nth(n).click({ timeout: 8000 }); await wait(p, 1600); };

  for (const size of ['phone', 'tablet', 'desktop']) {
    const full = size === 'phone';
    // 1. data residency: the device says United States, which has no in-country storage
    await shot('01-residency-country', size, athlete, (p) => navTo(p, 'DataResidency'), { locale: 'en-US' });
    await shot('02-residency-consent', size, athlete, (p) => navTo(p, 'DataResidencyConsent', { country: 'US' }), { locale: 'en-US', full });
    await shot('03-residency-home', size, settled, (p) => navTo(p, 'DataResidency'), { full });
    await shot('04-home-after-consent', size, settled, async () => {});
    await shot('05-home-before-country', size, athlete, async () => {});
    // 2. the More swivel for an athlete-only account
    await shot('06-swivel-athlete', size, athlete, (p) => tap(p, 'More'));
    // 3. the referee workbench and set-up
    await shot('07-referee-workbench', size, referee, (p) => navTo(p, 'OfficialsHome'), { full: true });
    await shot('08-referee-wizard-rates', size, referee, async (p) => { await navTo(p, 'OfficialsHome'); await tap(p, '1. Official profile'); await wait(p, 1500); });
    await shot('09-rate-cards', size, referee, (p) => navTo(p, 'RateCardCatalog'), { full });
    // 4. open positions: my application in full, and its documents
    await shot('10-my-applications', size, referee, async (p) => { await navTo(p, 'Openings'); await tap(p, 'My applications'); });
    await shot('11-application-view', size, referee, async (p) => { await navTo(p, 'Openings'); await tap(p, 'My applications'); await tap(p, 'View application'); await wait(p, 1500); });
    await shot('12-application-documents', size, referee, async (p) => { await navTo(p, 'Openings'); await tap(p, 'My applications'); await p.getByText(/^Documents/).first().click(); await wait(p, 1800); });
    // 5. the rulebook with officials' decision points
    await shot('13-rulebook-football', size, referee, (p) => navTo(p, 'SportRules', { sport: 'football' }), { full });
  }
  await shot('07-referee-workbench', 'desktop', referee, (p) => navTo(p, 'OfficialsHome'), { dark: true, full: true });
  await shot('07-referee-workbench', 'phone', referee, (p) => navTo(p, 'OfficialsHome'), { dark: true, full: true });
  await shot('11-application-view', 'phone', referee, async (p) => { await navTo(p, 'Openings'); await tap(p, 'My applications'); await tap(p, 'View application'); await wait(p, 1500); }, { dark: true });
  await shot('03-residency-home', 'phone', settled, (p) => navTo(p, 'DataResidency'), { dark: true, full: true });
  await shot('06-swivel-athlete', 'phone', athlete, (p) => tap(p, 'More'), { dark: true });

  // the two documents, as files
  for (const [name, p] of [['application', `/staff-assignments/${app.id}/application.pdf`], ['football-rulebook', '/rulebook/football/pdf']]) {
    const r = await fetch(`http://127.0.0.1:4000/api/v1${p}`, { headers: { authorization: `Bearer ${referee.token}` } });
    if (r.ok) fs.writeFileSync(path.join(OUT, `${name}.pdf`), Buffer.from(await r.arrayBuffer())); else { failures++; log(`FAIL  ${name}.pdf ${r.status}`); }
  }
  await browser.close();
} catch (e) { failures++; log('ERROR', e.stack ?? e); }
web.close(); api.kill();
log(failures ? `${failures} failed` : 'all screenshots taken');
process.exit(failures ? 1 : 0);
