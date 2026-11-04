// Photographs the Campuses screens (#781) from the real app at phone, tablet and desktop widths, light and dark.
//   E2E_DATABASE_URL=postgres://postgres@/sportarena_e2e?host=/tmp  EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir /tmp/e2e-dist
//   node scripts/e2e/campuses-ux.mjs   (UX_SHOTS=docs/ux for the output folder)
// All data is created through the public API in a throwaway database; nothing is hard-coded into the product.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH ?? 'playwright');
import pg from 'pg';

const API_DIR = new URL('../../apps/api/', import.meta.url).pathname;
const DB = process.env.E2E_DATABASE_URL ?? 'postgres://postgres@/sportarena_e2e?host=/tmp';
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
const db = new pg.Pool({ connectionString: DB });

const call = async (method, p, { token, body } = {}) => {
  const r = await fetch(`http://127.0.0.1:4000/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) { log(`  ! ${method} ${p} -> ${r.status} ${t.slice(0, 200)}`); return null; }
  return j;
};
const stamp = Date.now().toString(36);
const reg = async (h, name, roles = ['athlete']) => { const r = await call('POST', '/auth/register', { body: { handle: `${h}_${stamp}`, display_name: name, email: `${h}_${stamp}@example.com`, password: 'correct-horse-battery', roles } }); return { ...r.user, token: r.token, email: `${h}_${stamp}@example.com` }; };
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const wait = (p, ms = 1500) => p.waitForTimeout(ms);
const click = async (p, text, opts = {}) => { await p.getByText(text, { exact: true, ...opts }).first().click({ timeout: 8000 }); await wait(p, 1200); };
let failures = 0;
try {
  // ------------------------------------------------------------------ a real three-campus academy group, created through the API
  const owner = await reg('cp_owner', 'Meera Iyer', ['organizer', 'venue_manager']);
  const org = await call('POST', '/organisations', { token: owner.token, body: { name: 'Riverside Sports Academy', kind: 'academy', city: 'Pune' } });
  const people = {};
  for (const [h, name, role] of [['arjun', 'Arjun Menon', 'staff'], ['lakshmi', 'Lakshmi Rao', 'staff'], ['tomas', 'Tomás Ferrer', 'staff'], ['kavya', 'Kavya Nair', 'staff'], ['guardian', 'Anita Verma', 'staff'], ['coach1', 'Ravi Kulkarni', 'coach'], ['coach2', 'Sara Dsouza', 'coach'], ['coach3', 'Pablo Navarro', 'coach'], ['auditor', 'Neha Shah', 'staff']]) {
    const u = await reg(`cp_${h}`, name, role === 'coach' ? ['coach'] : ['athlete']);
    await call('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role } });
    await call('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } });
    people[h] = u;
  }
  const mkVenue = async (name, city) => { const v = await call('POST', '/venues', { token: owner.token, body: { name, city, timezone: 'UTC', currency: 'INR' } }); await call('POST', `/organisations/${org.id}/assets`, { token: owner.token, body: { kind: 'venue', asset_id: v.id } }); return v; };
  const venues = { pune: await mkVenue('Riverside Arena', 'Pune'), pune2: await mkVenue('Baner Tennis Centre', 'Pune'), goa: await mkVenue('Calangute Beach Courts', 'Goa'), val: await mkVenue('Camí Nou Training Ground', 'Valencia') };
  const camp = {};   // name -> { cohort, programme, athletes }
  const athletes = [];
  for (const [key, title, sport, coach, n, cap] of [['pune_fb', 'U14 Football Elite', 'football', people.coach1, 7, 24], ['pune_tn', 'Junior Tennis Performance', 'tennis', people.coach2, 5, 12], ['goa_fb', 'U12 Football Development', 'football', people.coach2, 4, 20], ['val_fb', 'U16 Football Academy', 'football', people.coach3, 6, 18]]) {
    const prog = await call('POST', `/organisations/${org.id}/academy/programmes`, { token: owner.token, body: { sport, title, format: 'squad_pathway', age_min: 10, age_max: 17, capacity: cap, coach_ids: [coach.id] } });
    await db.query("UPDATE academy_programmes SET status='published' WHERE id=$1", [prog.id]);
    const cohort = await call('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: title, coach_id: coach.id } });
    const kids = [];
    for (let i = 0; i < n; i++) kids.push(await reg(`cp_${key}_${i}`, `${title.split(' ')[0]} Athlete ${i + 1}`));
    await call('POST', `/cohorts/${cohort.id}/enrolments`, { token: owner.token, body: { csv: `handle,consent\n${kids.map((k) => `${k.handle},yes`).join('\n')}` } });
    await db.query('UPDATE org_enrolments SET programme_id=$1 WHERE cohort_id=$2', [prog.id, cohort.id]);
    camp[key] = { prog, cohort, kids }; athletes.push(...kids);
  }
  // fees: some paid, some overdue
  const enr = (await db.query('SELECT e.id, e.user_id, e.cohort_id FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.organisation_id=$1 ORDER BY e.id', [org.id])).rows;
  let seq = 0;
  for (const e of enr) { seq++; const overdue = seq % 3 === 0, paid = seq % 3 === 1; await db.query("INSERT INTO academy_charges(enrolment_id, organisation_id, payer_id, seq, kind, due_on, currency, gross_minor, amount_minor, status, paid_at) VALUES ($1,$2,$3,1,'tuition',$4,'INR',$5,$5,$6,$7)", [e.id, org.id, e.user_id, day(overdue ? -12 : 20), 1850000, paid ? 'paid' : 'awaiting_payment', paid ? new Date() : null]); }
  // sessions + attendance in the last 30 days
  for (const [key, k] of Object.entries(camp)) {
    for (let d = 1; d <= 6; d++) {
      const s = (await db.query("INSERT INTO academy_sessions(organisation_id, cohort_id, programme_id, sport, title, delivery_type, timezone, starts_at, ends_at, status) VALUES ($1,$2,$3,'x',$4,'training','UTC',$5,$6,'published') RETURNING id", [org.id, k.cohort.id, k.prog.id, k.prog.title, new Date(Date.now() - d * 4 * 864e5), new Date(Date.now() - d * 4 * 864e5 + 36e5)])).rows[0];
      for (const [i, kid] of k.kids.entries()) await db.query("INSERT INTO academy_attendance(session_id, user_id, enrolment_id, status) SELECT $1,$2,e.id,$3 FROM org_enrolments e WHERE e.cohort_id=$4 AND e.user_id=$2", [s.id, kid.id, (i + d) % (key === 'goa_fb' ? 3 : 7) === 0 ? 'absent' : 'present', k.cohort.id]);
    }
  }
  // the structure, built through the capabilities (Asia > Pune, Goa; Europe > Valencia; departments under each)
  const U = async (body) => call('POST', `/organisations/${org.id}/units`, { token: owner.token, body: { valid_from: day(-120), ...body } });
  const asia = await U({ kind: 'region', name: 'Asia', country: 'IN' }), europe = await U({ kind: 'region', name: 'Europe', country: 'ES' });
  const pune = await U({ kind: 'campus', name: 'Pune Campus', code: 'PNQ', parent_id: asia.id, city: 'Pune', timezone: 'Asia/Kolkata' });
  const goa = await U({ kind: 'campus', name: 'Goa Campus', code: 'GOI', parent_id: asia.id, city: 'Goa', timezone: 'Asia/Kolkata' });
  const val = await U({ kind: 'campus', name: 'Valencia Campus', code: 'VLC', parent_id: europe.id, city: 'Valencia', timezone: 'Europe/Madrid' });
  const dep = {};
  for (const [k, name, sport, parent] of [['pf', 'Football', 'football', pune], ['pt', 'Tennis', 'tennis', pune], ['gf', 'Football', 'football', goa], ['vf', 'Football', 'football', val]]) dep[k] = await U({ kind: 'department', name, sport, parent_id: parent.id });
  const mv = (to, object_type, ids, extra = {}) => call('POST', `/organisations/${org.id}/unit-moves`, { token: owner.token, body: { to_unit_id: to.id, items: [{ object_type, object_ids: ids }], effective_on: day(-100), ...extra } });
  await mv(pune, 'venue', [venues.pune.id, venues.pune2.id]); await mv(goa, 'venue', [venues.goa.id]); await mv(val, 'venue', [venues.val.id]);
  await mv(dep.pf, 'cohort', [camp.pune_fb.cohort.id]); await mv(dep.pt, 'cohort', [camp.pune_tn.cohort.id]); await mv(dep.gf, 'cohort', [camp.goa_fb.cohort.id]); await mv(dep.vf, 'cohort', [camp.val_fb.cohort.id]);
  await mv(dep.pf, 'programme', [camp.pune_fb.prog.id]); await mv(dep.pt, 'programme', [camp.pune_tn.prog.id]); await mv(dep.gf, 'programme', [camp.goa_fb.prog.id]); await mv(dep.vf, 'programme', [camp.val_fb.prog.id]);
  await mv(pune, 'staff', [people.coach1.id, people.coach2.id]); await mv(val, 'staff', [people.coach3.id]);
  await mv(goa, 'enrolment', [enr.find((e) => e.cohort_id === camp.goa_fb.cohort.id).id]);
  const role = (u, unit, r) => call('POST', `/organisations/${org.id}/units/${unit.id}/roles`, { token: owner.token, body: { person: u.handle, role: r } });
  await role(people.arjun, pune, 'director'); await role(people.lakshmi, goa, 'finance'); await role(people.tomas, val, 'director'); await role(people.auditor, asia, 'auditor');
  const pol = (unit, key, value) => call('POST', `/organisations/${org.id}/units/${unit.id}/policies`, { token: owner.token, body: { key, value } });
  await pol(asia, 'currency', 'INR'); await pol(asia, 'attendance_min_pct', 80); await pol(asia, 'refund_window_days', 14); await pol(pune, 'coach_athlete_ratio_max', 10); await pol(pune, 'refund_window_days', 7); await pol(europe, 'currency', 'EUR'); await pol(europe, 'youth_pickup_required', true);
  await role(people.kavya, goa, 'director');
  // the academy configures its transfer processes from the starter templates, then real transfers run through them
  const tpl = (await call('GET', `/organisations/${org.id}/transfer-flows`, { token: owner.token })).templates;
  for (const [type, name, notice] of [['enrolment', 'Athlete transfer', 3], ['staff', 'Coach and staff posting', 2], ['cohort', 'Squad transfer', 5]]) await call('POST', `/organisations/${org.id}/transfer-flows`, { token: owner.token, body: { object_type: type, name, steps: tpl[type], min_notice_days: notice } });
  const reqT = (u, body) => call('POST', `/organisations/${org.id}/transfers`, { token: u.token, body: { reason_code: 'pathway_progression', to_unit_id: goa.id, ...body } });
  const detailT = (u, tid) => call('GET', `/organisations/${org.id}/transfers/${tid}`, { token: u.token });
  const decide = async (u, tid, key, body) => { const d = await detailT(u, tid); const st = d.steps.find((x) => x.key === key); return call('POST', `/organisations/${org.id}/transfers/${tid}/steps/${st.id}`, { token: u.token, body }); };
  const ackAs = async (u, tid, decision = 'acknowledge') => { const mine = await call('GET', '/me/transfer-acknowledgements', { token: u.token }); const m = mine.find((x) => x.transfer_id === tid); return call('POST', `/me/transfer-acknowledgements/${m.step_id}`, { token: u.token, body: { decision } }); };
  // 1. a coach posting, completed end to end
  const t1 = await reqT(people.arjun, { object_type: 'staff', object_ids: [people.coach2.id], reason_code: 'relocation', note: 'Leads the new Goa football squad', effective_on: day(2) });
  await decide(people.arjun, t1.transfer_id, 'release', { decision: 'approve' }); await decide(people.kavya, t1.transfer_id, 'receive', { decision: 'approve' });
  await ackAs(people.coach2, t1.transfer_id);
  await decide(people.kavya, t1.transfer_id, 'handover', { decision: 'complete', items_done: [0, 1, 2] });
  await db.query('UPDATE org_transfers SET effective_on = current_date WHERE id=$1', [t1.transfer_id]);
  execFileSync('node', ['--input-type=module', '-e', "import('./src/campus-transfers.js').then((m) => m.runDueTransfers()).then((n) => { console.log('sweep applied', n); process.exit(0); })"], { cwd: API_DIR, env: { ...process.env, ...E }, stdio: 'inherit' });
  // 2. a minor moving up: both directors approved, finance and the guardian are open together
  const youth = camp.pune_fb.kids[0];
  await db.query('UPDATE users SET youth_until = current_date + 900 WHERE id=$1', [youth.id]);
  await db.query("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [people.guardian.id, youth.id]);
  const yEnr = enr.find((e) => e.user_id === youth.id);
  const t2 = await reqT(people.arjun, { object_type: 'enrolment', object_ids: [yEnr.id], note: 'Selected for the Goa performance squad after the January assessment', effective_on: day(4) });
  await decide(people.arjun, t2.transfer_id, 'release', { decision: 'approve' }); await decide(people.kavya, t2.transfer_id, 'receive', { decision: 'approve' });
  // 3. a squad transfer waiting for the receiving director
  const t3 = await reqT(owner, { object_type: 'cohort', object_ids: [camp.pune_tn.cohort.id], reason_code: 'capacity', effective_on: day(6) });
  await decide(people.arjun, t3.transfer_id, 'release', { decision: 'approve' });
  // 4. a venue transfer the receiving campus rejected
  const t4 = await reqT(people.arjun, { object_type: 'venue', object_ids: [venues.pune2.id], reason_code: 'reorganisation' });
  await decide(people.arjun, t4.transfer_id, 'release', { decision: 'approve' }); await decide(people.kavya, t4.transfer_id, 'receive', { decision: 'reject', note: 'No court time to spare at Goa this term' });

  // a second, single-campus academy that has not opted in (the setup flow)
  const hill = await call('POST', '/organisations', { token: owner.token, body: { name: 'Hillside Cricket Academy', kind: 'academy', city: 'Mysuru' } });
  const hv = await call('POST', '/venues', { token: owner.token, body: { name: 'Chamundi Oval', city: 'Mysuru', timezone: 'UTC', currency: 'INR' } }); await call('POST', `/organisations/${hill.id}/assets`, { token: owner.token, body: { kind: 'venue', asset_id: hv.id } });
  await call('POST', `/organisations/${hill.id}/cohorts`, { token: owner.token, body: { name: 'U15 Cricket Squad' } });

  // ------------------------------------------------------------------ the browser
  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? undefined, args: ['--no-sandbox'] });
  const open = async (viewport, who = owner, scheme = 'light') => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: scheme }); const page = await ctx.newPage();
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
  const inCampuses = async (p, orgId = org.id) => { await navTo(p, 'Org', { id: orgId, tab: 'campuses' }); };
  const SIZES = { phone: { width: 390, height: 2000 }, tablet: { width: 820, height: 1800 }, desktop: { width: 1280, height: 1500 } };
  const T = { timeout: 6000 };
  const wizardTo = async (p, stepNo) => {
    const at = async (name, fn) => { try { await fn(); } catch (e) { throw new Error(`${name}: ${e.message.split('\n')[0]}`); } };
    await at('open', async () => { await inCampuses(p); await click(p, 'Transfers'); await click(p, 'New transfer'); });
    await at('pick field', () => p.getByLabel(/Choose who or what is moving/).first().click(T));
    await wait(p, 1500);
    await at('pick option', () => p.getByRole('checkbox').first().click(T));
    await wait(p, 500);
    await at('close picker', () => p.getByText('Clear', { exact: true }).first().evaluate((el) => el.closest('[role=button]')?.parentElement?.lastElementChild?.click()).catch(() => {}));
    await at('close picker 2', async () => { const done = p.getByText(/^Done$/).first(); if (await done.count()) await done.click(T); });
    await wait(p, 600);
    await at('continue 1', () => p.getByText('Continue', { exact: true }).last().click({ force: true, ...T }));
    await wait(p, 1200);
    if (stepNo < 3) return;
    await at('dest field', () => p.getByLabel(/Moving to/).first().click(T));
    await wait(p, 800);
    await at('dest option', () => p.getByText('Goa Campus', { exact: true }).last().click(T));
    await wait(p, 600);
    await at('continue 2', () => p.getByText('Continue', { exact: true }).last().click({ force: true, ...T }));
    await wait(p, 1800);
  };
  const SCENES = {
    '1-overview': { run: async (p) => { await inCampuses(p); } },
    '2-structure': { run: async (p) => { await inCampuses(p); await click(p, 'Structure'); } },
    '3-unit-assets': { run: async (p) => { await inCampuses(p); await click(p, 'Structure'); await click(p, 'Pune Campus'); } },
    '4-unit-policies': { run: async (p) => { await inCampuses(p); await click(p, 'Structure'); await click(p, 'Pune Campus'); await click(p, 'Policies'); } },
    '5-unit-roles': { run: async (p) => { await inCampuses(p); await click(p, 'Structure'); await click(p, 'Pune Campus'); await click(p, 'People & roles'); } },
    '6-wizard-1': { run: async (p) => { await inCampuses(p); await click(p, 'Transfers'); await click(p, 'New transfer'); } },
    '6b-wizard-2': { run: async (p) => { await wizardTo(p, 2); } },
    '6c-wizard-3': { run: async (p) => { await wizardTo(p, 3); } },
    '7-transfers-hub': { run: async (p) => { await inCampuses(p); await click(p, 'Transfers'); } },
    '7b-transfers-me': { who: people.kavya, run: async (p) => { await inCampuses(p); await click(p, 'Transfers'); await p.getByText(/^Awaiting me/).first().click(); await wait(p, 1200); } },
    '7c-transfer-detail': { run: async (p) => { await inCampuses(p); await click(p, 'Transfers'); await p.getByLabel(/^Athletes:/).first().click(); await wait(p, 1500); } },
    '7d-transfer-detail-me': { who: people.kavya, run: async (p) => { await inCampuses(p); await click(p, 'Transfers'); await p.getByText(/^Awaiting me/).first().click(); await wait(p, 1000); await p.getByLabel(/^Squad|^Junior|Cohorts:/).first().click(); await wait(p, 1500); } },
    '7e-designer': { run: async (p) => { await inCampuses(p); await click(p, 'Transfers'); await click(p, 'Transfer process'); } },
    '7f-guardian-ack': { who: people.guardian, run: async (p) => { await navTo(p, 'Family'); } },
    '8-audit': { run: async (p) => { await inCampuses(p); await click(p, 'Audit trail'); } },
    '9-setup': { orgId: hill.id, run: async (p) => { await inCampuses(p, hill.id); } },
    '10-setup-preview': { orgId: hill.id, run: async (p) => { await inCampuses(p, hill.id); await click(p, 'Set up campuses'); await click(p, 'Preview'); } },
    '11-director-view': { who: people.arjun, run: async (p) => { await inCampuses(p); } },
    '12-finance-view': { who: people.lakshmi, run: async (p) => { await inCampuses(p); } },
  };
  const only = process.env.ONLY?.split(',');
  for (const [name, sc] of Object.entries(SCENES)) {
    if (only && !only.includes(name.split('-')[0])) continue;
    for (const [size, vp] of Object.entries(SIZES)) {
      for (const scheme of (size === 'tablet' ? ['light'] : ['light', 'dark'])) {
        if (scheme === 'dark' && !['1-overview', '3-unit-assets', '7-transfers-hub', '7e-designer'].includes(name)) continue;
        const page = await open(vp, sc.who ?? owner, scheme);
        try { await sc.run(page); await wait(page, 600); await page.screenshot({ path: path.join(OUT, `campus-${name}-${size}${scheme === 'dark' ? '-dark' : ''}.png`), fullPage: size !== 'phone' ? false : false }); log(`PASS  ${name} ${size} ${scheme}`); }
        catch (e) { failures++; log(`FAIL  ${name} ${size} ${scheme}: ${e.message.split('\n')[0]}`); await page.screenshot({ path: `/tmp/campus-fail-${name}-${size}.png` }).catch(() => {}); }
        await page.context().close();
      }
    }
  }
  await browser.close();
} finally { api.kill(); web.close(); await db.end(); }
if (failures) { log(`${failures} scene(s) failed`); process.exit(1); }
