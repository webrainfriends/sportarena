// Browser-driven check and screenshots of official availability and scheduling preferences (#994): the Availability and Calendar tabs of
// Officials home at phone, tablet and desktop widths, in the light and the dark theme. Data is created through the public API by the
// people in the story (organisers request, the official answers and sets availability); only the things no API creates for a test
// (matches already played, an open event) are written to the throwaway database. Needs the same things as offline-referee-journey.mjs:
//   EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir /tmp/e2e-dist   (in apps/app)
//   E2E_DATABASE_URL (a throwaway Postgres, migrated), E2E_SHOTS (output folder)
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
const call = async (method, p, { token, body, ok = true } = {}) => {
  const r = await fetch(`http://127.0.0.1:4000/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (ok && !r.ok) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return ok ? j : { status: r.status, body: j };
};
const stamp = Date.now().toString(36);
let n = 0;
const reg = async (h, name, roles = ['athlete']) => { n++; const handle = `${h}_${stamp}${n}`; const email = `${handle}@example.com`; const r = await call('POST', '/auth/register', { body: { handle, display_name: name, email, password: 'correct-horse-battery', roles } }); return { ...r.user, token: r.token, email, handle }; };
const db = new pg.Pool({ connectionString: E.DATABASE_URL });
let failures = 0; const check = (ok, msg) => { log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const SIZES = { phone: { width: 390, height: 844 }, tablet: { width: 820, height: 1180 }, desktop: { width: 1280, height: 900 } };
const TZ = 'Europe/Madrid';
const DAY = 864e5;
/** An instant from a number of days ahead and a wall-clock time in the official's zone. */
const at = (days, hhmm) => {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(Date.now() + days * DAY));
  const [h, m] = hhmm.split(':').map(Number); const guess = Date.parse(`${d}T00:00:00Z`) + (h * 60 + m) * 60000;
  const off = (ms) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, +x.value])); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms; };
  return new Date(guess - off(guess - off(guess))).toISOString();
};
const localDay = (days) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(Date.now() + days * DAY));

try {
  // ---------------------------------------------------------------- the people and their competitions
  const ref = await reg('oa_ref', 'Elena Marín', ['referee']);
  for (const sport of ['football', 'futsal']) await call('POST', '/me/sport-profiles', { token: ref.token, body: { sport, role: 'referee' } });
  const sports = (await db.query("SELECT id, slug FROM sports WHERE slug IN ('football','futsal')")).rows;
  const orgA = await reg('oa_orga', 'Mallorca Academy League', ['organizer']), orgB = await reg('oa_orgb', 'Balearic Youth Cup', ['organizer']);
  const mk = async (org, name, sport, teamNames) => {
    const ev = await call('POST', '/events', { token: org.token, body: { name, sport } });
    await db.query("UPDATE events SET status='open' WHERE id=$1", [ev.id]);
    const teams = [];
    for (const tn of teamNames) { const cap = await reg('oa_cap', `${tn} manager`, ['coach']); const tm = await call('POST', '/teams', { token: cap.token, body: { name: tn, sport } }); const e = await call('POST', `/events/${ev.id}/entries`, { token: cap.token, body: { team_id: tm.id } }); await call('PATCH', `/entries/${e.id}`, { token: org.token, body: { status: 'accepted' } }); teams.push(tm); }
    const fx = (when, a, b, duration_min = 90) => call('POST', `/events/${ev.id}/fixtures`, { token: org.token, body: { home_team_id: teams[a].id, away_team_id: teams[b].id, scheduled_at: when, duration_min } });
    return { ev, teams, fx, org };
  };
  const league = await mk(orgA, 'Mallorca Academy League U18', 'football', ['Manacor U18', 'Palma Blau U18', 'Sóller U18', 'Inca U18']);
  const cup = await mk(orgB, 'Balearic Youth Cup', 'football', ['Ibiza Nord', 'Menorca Sud', 'Calvià', 'Alcúdia']);
  const futsal = await mk(orgB, 'Winter Futsal Series', 'futsal', ['Pollença FS', 'Llucmajor FS']);
  const invite = (c, fixture, role = 'referee') => call('POST', `/fixtures/${fixture.id}/officials`, { token: c.org.token, body: { user_id: ref.id, role } });
  const mine = () => call('GET', '/me/official-assignments', { token: ref.token });
  const accept = async (fixture) => { const a = (await mine()).find((x) => x.fixture_id === fixture.id && x.status === 'invited'); await call('POST', `/official-assignments/${a.id}/respond`, { token: ref.token, body: { response: 'accept' } }); };

  // matches already played (history for the load chart): the API will not schedule into the past, so these are written directly
  for (const [daysAgo, c] of [[38, league], [31, league], [30, cup], [24, league], [17, cup], [16, league], [10, league], [9, futsal], [3, cup]]) {
    const f = (await db.query("INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at, duration_min, status, home_score, away_score) VALUES ($1,$2,$3,$4,90,'completed',2,1) RETURNING id", [c.ev.id, c.teams[0].id, c.teams[1].id, at(-daysAgo, '18:00')])).rows[0];
    await db.query("INSERT INTO fixture_officials(fixture_id, user_id, role, status, requested_by, responded_at) VALUES ($1,$2,'referee','accepted',$3, now())", [f.id, ref.id, c.org.id]);
  }

  // ---------------------------------------------------------------- the official sets up availability through the API the app uses
  await call('POST', '/me/officials/availability/prefs', { token: ref.token, body: {
    timezone: TZ, buffer_min: 90, buffer_same_venue_min: 20, min_notice_hours: 24, max_per_day: 2, max_per_week: 5, max_consecutive_days: 4, travel_km: 80, region: 'Palma de Mallorca', country: 'ES',
    sport_ids: sports.map((s) => s.id), levels: ['regional', 'national'], roles: ['referee', 'fourth_official'], age_bands: ['u16', 'u18', 'senior'], expected_version: 0 } });
  await call('POST', '/me/officials/availability/weekly', { token: ref.token, body: { windows: [
    ...[2, 3, 4].map((d) => ({ weekday: d, start_minute: 17 * 60, end_minute: 22 * 60 })), { weekday: 5, start_minute: 16 * 60, end_minute: 23 * 60 },
    { weekday: 6, start_minute: 8 * 60, end_minute: 22 * 60 }, { weekday: 0, start_minute: 8 * 60, end_minute: 20 * 60 }] } });
  // upcoming requests and confirmations
  const f1 = await league.fx(at(1, '18:30'), 0, 1); await invite(league, f1); await accept(f1);
  const f2 = await league.fx(at(3, '19:00'), 2, 3); await invite(league, f2); await accept(f2);
  const f3 = await cup.fx(at(4, '10:00'), 0, 1); await invite(cup, f3);                       // tentative
  const f4 = await futsal.fx(at(4, '10:30'), 0, 1, 60); await invite(futsal, f4);              // a rival tentative request for the same morning
  const f5 = await league.fx(at(5, '11:00'), 0, 2); await invite(league, f5); await accept(f5);
  const f6 = await cup.fx(at(9, '12:00'), 2, 3); await invite(cup, f6, 'fourth_official');     // will sit on time off
  const f7 = await league.fx(at(12, '18:00'), 1, 3); await invite(league, f7); await accept(f7);
  const f8 = await cup.fx(at(18, '17:30'), 0, 3); await invite(cup, f8);
  // time off: a repeating Monday evening block, a few days away, and public holidays from the shared holiday calendar
  const mon = (() => { for (let k = 0; k < 7; k++) if (new Date(`${localDay(k)}T00:00:00Z`).getUTCDay() === 1) return localDay(k); })();
  await call('POST', '/me/officials/availability/time-off', { token: ref.token, body: { recurrence: { starts_on: mon, ends_on: localDay(120), weekdays: [1], every_n_weeks: 2, start_minute: 18 * 60, end_minute: 22 * 60 }, category: 'study', note: 'UEFA B refresher course' } });
  await call('POST', '/me/officials/availability/time-off', { token: ref.token, body: { starts_at: at(8, '00:00'), ends_at: at(11, '00:00'), all_day: true, category: 'family', note: 'Family visit in Valencia' } });
  await call('POST', '/holidays', { token: orgA.token, body: { country: 'ES', days: [{ on_date: localDay(26), label: 'Dia de la Constitución' }, { on_date: localDay(28), label: 'Inmaculada Concepción' }, { on_date: localDay(45), label: 'Navidad' }] } });
  const hol = await call('GET', `/holidays?country=ES&from=${localDay(20)}&to=${localDay(30)}`);   // entering a date twice is a no-op, so read them back: the script can be run again
  await call('POST', '/me/officials/availability/holidays', { token: ref.token, body: { holiday_ids: hol.slice(0, 2).map((h) => h.id) } });
  await call('POST', '/me/officials/availability/open', { token: ref.token, body: { starts_at: at(15, '09:00'), ends_at: at(15, '16:00') } });
  const state = await call('GET', '/me/officials/availability', { token: ref.token });
  check(state.summary.tentative_holds === 4 && state.summary.confirmed_upcoming === 4, `the summary counts 4 tentative and 4 confirmed (got ${state.summary.tentative_holds} / ${state.summary.confirmed_upcoming})`);
  check(state.summary.conflicts === 1, `one request sits on time off (got ${state.summary.conflicts})`);
  check(state.summary.load.reduce((x, w) => x + w.confirmed, 0) >= 12, 'the load chart has real matches behind it');

  // ---------------------------------------------------------------- the browser
  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const session = async (who, viewport, theme, lang) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: theme, timezoneId: TZ, locale: 'en-GB' }); const page = await ctx.newPage();
    await ctx.addInitScript(([th, lg]) => { try { localStorage.setItem('theme', th); if (lg) localStorage.setItem('locale', lg); } catch {} }, [theme, lang]);
    page.on('pageerror', (e) => { log('[pageerror]', e.message); failures++; });
    if (process.env.V) page.on('console', (m) => ['error'].includes(m.type()) && log('[console]', m.text().slice(0, 220)));
    const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } }); if (!r.ok()) throw new Error(`login ${who.handle} ${r.status()}`);
    await page.goto('http://localhost:4100/'); await page.waitForTimeout(3000);
    return { ctx, page };
  };
  const navTo = async (p, name, params = {}) => {
    await p.evaluate(({ name, params }) => {
      if (!window.__nav) {
        const root = document.getElementById('root') ?? document.body.firstElementChild;
        const key = Object.keys(root).find((k) => k.startsWith('__reactContainer'));
        const todo = [root[key]];
        while (todo.length && !window.__nav) { const x = todo.pop(); const v = x.memoizedProps?.value; if (v && typeof v.push === 'function' && typeof v.goTab === 'function' && v.tab === undefined) { window.__nav = v; break; } if (x.sibling) todo.push(x.sibling); if (x.child) todo.push(x.child); }
      }
      window.__nav.push(name, params);
    }, { name, params });
    await p.waitForTimeout(2600);
  };
  const vis = async (p, t, ms = 5000) => { try { await p.getByText(t, { exact: false }).first().waitFor({ state: 'visible', timeout: ms }); return true; } catch { return false; } };
  const tap = async (p, t) => { await p.getByText(t, { exact: true }).last().click(); await p.waitForTimeout(900); };
  const shot = (p, name) => p.screenshot({ path: `${OUT}${name}.png` });
  /** The whole scrolling screen in one image: the viewport is made as tall as the content, then put back. */
  const longShot = async (p, name, size) => {
    const h = await p.evaluate(() => Math.max(...[...document.querySelectorAll('*')].map((e) => e.scrollHeight)));
    await p.setViewportSize({ width: size.width, height: Math.min(Math.max(h + 40, size.height), 7000) }); await p.waitForTimeout(900);
    await shot(p, name);
    await p.setViewportSize(size); await p.waitForTimeout(500);
  };

  const only = process.env.ONLY?.split(',');
  for (const theme of ['light', 'dark']) for (const [dev, size] of Object.entries(SIZES)) {
    if (only && !only.includes(`${dev}-${theme}`)) continue;
    const { ctx, page } = await session(ref, size, theme);
    const tag = `${dev}-${theme}`;
    await navTo(page, 'OfficialsHome', { tab: 'availability' });
    check(await vis(page, 'My officiating week'), `${tag}: the Availability tab opens on the week planner`);
    check(await vis(page, 'Tentative holds') && await vis(page, 'Match load'), `${tag}: key metrics and the load chart are shown`);
    check(await vis(page, 'need a decision'), `${tag}: the request that sits on time off is raised`);
    check(await vis(page, 'What organisers can see'), `${tag}: the privacy statement is shown`);
    check(!(await page.content()).match(/>(oav|ocal)\.[a-z_.]+</), `${tag}: no untranslated key on the Availability tab`);
    await shot(page, `01-availability-${tag}`);
    await longShot(page, `02-availability-full-${tag}`, size);

    if (theme === 'light' || dev === 'phone') {
      await tap(page, 'Repeating block');
      check(await vis(page, 'Repeating time off') && await vis(page, 'Kind of time off'), `${tag}: the repeating time-off form opens with pickers, not text boxes`);
      await shot(page, `03-repeating-form-${tag}`);
      await page.keyboard.press('Escape'); await page.waitForTimeout(400);
      await navTo(page, 'OfficialsHome', { tab: 'availability' });
      await page.getByText(/^Edit\s+›$/).last().click(); await page.waitForTimeout(1100);
      check(await vis(page, 'Use a shorter gap at the same venue'), `${tag}: scheduling preferences open as one ordered form`);
      await shot(page, `04-preferences-form-${tag}`);
      await page.keyboard.press('Escape'); await page.waitForTimeout(400);
    }

    await navTo(page, 'OfficialsHome', { tab: 'calendar' });
    check(await vis(page, 'Confirmed, slot reserved') && await vis(page, 'Tentative requests'), `${tag}: the calendar opens with reserved and tentative totals`);
    check(await vis(page, 'other request(s) for this time'), `${tag}: rival tentative requests are flagged`);
    check(!(await page.content()).match(/>(oav|ocal)\.[a-z_.]+</), `${tag}: no untranslated key on the Calendar tab`);
    await shot(page, `05-calendar-week-${tag}`);
    await longShot(page, `06-calendar-week-full-${tag}`, size);
    await tap(page, 'Month');
    await page.waitForTimeout(1500);
    await shot(page, `07-calendar-month-${tag}`);
    await ctx.close();
  }

  // right to left: the same tab in Urdu on a phone
  if (!only || only.includes('rtl')) {
    const { ctx, page } = await session(ref, SIZES.phone, 'light', 'ur-PK');
    await navTo(page, 'OfficialsHome', { tab: 'availability' });
    check(await page.evaluate(() => document.documentElement.dir === 'rtl' || getComputedStyle(document.body).direction === 'rtl'), 'Urdu lays the screen out right to left');
    await shot(page, '08-availability-phone-urdu');
    await ctx.close();
  }
  // GUIDE_SHOTS=1: retake this step's Process-card screenshots (the sizes and file names the guide uses) and record the hash of the screens they show
  if (process.env.GUIDE_SHOTS) {
    const g = await import('../../apps/api/src/guides/academy-process.js');
    const step = g.ACADEMY_STEPS.find((x) => x.id === 'officials_availability');
    for (const [size, viewport] of Object.entries(g.SHOT_SIZES)) {
      const { ctx, page } = await session(ref, viewport, 'light');
      await navTo(page, 'OfficialsHome', { tab: 'availability' });
      await page.screenshot({ path: path.join(path.dirname(g.MANIFEST_FILE), g.shotFile(step.id, size)) });
      await ctx.close();
    }
    const manifest = JSON.parse(fs.readFileSync(g.MANIFEST_FILE, 'utf8'));
    manifest.steps[step.id] = g.sourcesHash(step);
    fs.writeFileSync(g.MANIFEST_FILE, JSON.stringify(manifest, null, 2) + '\n');
    log(`guide screenshots retaken for ${step.id}`);
  }
  await browser.close();
} catch (e) { log('ERROR', e.stack ?? e); failures++; }
finally { api.kill(); web.close(); await db.end(); }
log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
