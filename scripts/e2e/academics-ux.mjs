// Photographs the Academics screens (#783) from the real app at phone, tablet and desktop widths, light and dark.
//   E2E_DATABASE_URL=postgres://postgres@/sportarena_e2e?host=/tmp  EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir /tmp/e2e-dist
//   node scripts/e2e/academics-ux.mjs   (UX_SHOTS=docs/ux for the output folder)
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
  // ------------------------------------------------------------------ a real sport-plus-study academy, created through the API
  const owner = await reg('ac_owner', 'Meera Iyer', ['organizer', 'venue_manager']);
  const org = await call('POST', '/organisations', { token: owner.token, body: { name: 'Riverside Sports Academy', kind: 'academy', city: 'Pune' } });
  const mk = async (h, name, role, roles = ['athlete']) => { const u = await reg(`ac_${h}`, name, roles); if (role) { await call('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role } }); await call('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } }); } return u; };
  const lead = await mk('lead', 'Anjali Rao', 'staff'), coach = await mk('coach', 'Ravi Kulkarni', 'coach', ['coach']), ops = await mk('ops', 'Dev Malhotra', 'staff');
  const eng = (u, title, permissions) => call('POST', `/organisations/${org.id}/academy/staff/${u.id}`, { token: owner.token, body: { job_title: title, template: 'custom', permissions } });
  await eng(lead, 'Academic lead', ['academics', 'academics_detail', 'schedule', 'roster', 'attendance']); await eng(ops, 'Scheduler', ['schedule']);
  const schoolAdmin = await reg('ac_sadmin', 'Fatima Sheikh'), liaison = await reg('ac_liaison', 'Nikhil Joshi');
  const school = await call('POST', '/organisations', { token: schoolAdmin.token, body: { name: 'Greenfield International School', kind: 'school', city: 'Pune' } });
  const school2 = await call('POST', '/organisations', { token: schoolAdmin.token, body: { name: 'Riverdale Junior College', kind: 'college', city: 'Pune' } });
  await call('POST', `/organisations/${school.id}/members`, { token: schoolAdmin.token, body: { person: liaison.handle, role: 'staff' } }); await call('POST', `/organisations/${school.id}/invite/respond`, { token: liaison.token, body: { accept: true } });
  const cohort = await call('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: 'U16 Football Elite', coach_id: coach.id } });
  const NAMES = [['Aarav Mehta', 15, 'cbse', 'Grade 10'], ['Diya Kapoor', 16, 'cbse', 'Grade 11'], ['Kabir Nair', 14, 'ib', 'Year 10'], ['Ishaan Rao', 17, 'cbse', 'Grade 12'], ['Meera Pillai', 15, 'cbse', 'Grade 10'], ['Rohan Das', 16, 'ib', 'Year 11'], ['Sana Qureshi', 17, 'cbse', 'Grade 12'], ['Vihaan Shah', 14, 'cbse', 'Grade 9']];
  const kids = [];
  for (const [i, [name, age]] of NAMES.entries()) { const u = await reg(`ac_k${i}`, name); kids.push({ ...u, age }); }
  await call('POST', `/cohorts/${cohort.id}/enrolments`, { token: owner.token, body: { csv: `handle,consent\n${kids.map((k) => `${k.handle},yes`).join('\n')}` } });
  const enr = (await db.query('SELECT id, user_id FROM org_enrolments WHERE cohort_id=$1', [cohort.id])).rows;
  const guardians = [];
  for (const [i, k] of kids.entries()) if (k.age < 18) { await db.query('UPDATE users SET youth_until = current_date + 400 WHERE id=$1', [k.id]); const g = await reg(`ac_g${i}`, `${k.display_name.split(' ')[1]} family (guardian)`); await db.query("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [g.id, k.id]); guardians.push(g); } else guardians.push(null);
  const links = [];
  for (const [i, k] of kids.entries()) {
    const [, , cur, year] = NAMES[i], sc = i === 3 || i === 6 ? school2 : school;
    const l = await call('POST', `/organisations/${org.id}/academics/links`, { token: owner.token, body: { enrolment_id: enr.find((e) => e.user_id === k.id).id, school_org_id: sc.id, curriculum: cur, year_group: year, student_ref: `GF-${2000 + i}`, ...(sc.id === school.id ? { liaison_user_id: liaison.id } : {}) } });
    links.push(l);
  }
  // sharing choices: most granted (some summary only), one expiring soon, two not yet decided
  const grant = async (i, party, scopes, detail, exp) => { const k = kids[i], g = guardians[i], who = g ?? k; return call('POST', '/academics/consents', { token: who.token, body: { athlete_id: k.id, party_org_id: party, scopes, detail, ...(exp ? { expires_on: exp } : {}) } }); };
  const ALL3 = ['timetable', 'attendance', 'attainment'];
  for (const i of [0, 1, 2, 3, 4, 5]) { await grant(i, org.id, ALL3, i === 2 || i === 5 ? 'summary' : 'detail', i === 4 ? day(18) : undefined); await grant(i, i === 3 || i === 6 ? school2.id : school.id, ALL3, 'detail'); }
  await grant(6, org.id, ['timetable'], 'summary');
  const fw = await call('POST', `/organisations/${org.id}/academics/frameworks`, { token: lead.token, body: { name: 'CBSE grades', scale: 'cbse_grade', subjects: ['Mathematics', 'Science', 'English', 'Social Science', 'Hindi'], watch_below: 65, support_below: 50, attendance_floor_pct: 90 } });
  await call('POST', `/organisations/${org.id}/academics/frameworks`, { token: lead.token, body: { name: 'IB points', scale: 'numeric_1_7', subjects: ['Maths AA', 'Physics', 'English A', 'Economics'], watch_below: 55, support_below: 40, attendance_floor_pct: 92 } });
  const rec = (i, term, rows, extra = {}) => call('POST', `/academics/links/${links[i].id}/snapshots`, { token: liaison.token, body: { framework_id: fw.id, term_label: term, source_kind: 'school_report', source_ref: `Report ${term}`, reported_on: day(-12), rows, ...extra } });
  const G = [['A2', 'B1', 'A1', 'B2', 'B1'], ['B1', 'B2', 'A2', 'B1', 'C1'], ['C1', 'C2', 'B2', 'C1', 'D'], ['A1', 'A2', 'A2', 'B1', 'A2'], ['B2', 'C1', 'B1', 'C2', 'C1'], ['C2', 'D', 'C2', 'D', 'E1']];
  for (const i of [0, 1, 2, 3, 4, 5]) { const subj = ['Mathematics', 'Science', 'English', 'Social Science', 'Hindi']; if (i === 3 || i === 6) continue; await rec(i, 'Term 1', G[i].map((v, n) => ({ subject: subj[n], value: v }))); }
  await rec(1, 'Term 2', ['B2', 'B2', 'A2', 'B1', 'C1'].map((v, n) => ({ subject: ['Mathematics', 'Science', 'English', 'Social Science', 'Hindi'][n], value: v })));
  const att = (i, p, sessions, present, auth, unauth) => call('POST', `/academics/links/${links[i].id}/attendance`, { token: liaison.token, body: { period_from: day(-60), period_to: day(-1), sessions_total: sessions, present, late: 2, authorised_absent: auth, unauthorised_absent: unauth, source_ref: 'Term attendance register' } });
  await att(0, 0, 40, 38, 2, 0); await att(1, 0, 40, 37, 3, 0); await att(2, 0, 40, 33, 2, 5); await att(4, 0, 40, 36, 4, 0); await att(5, 0, 40, 30, 4, 6);
  // the school timetable: weekly lessons, exams, tutoring
  const dow = (n) => new Date(`${day(n)}T12:00:00Z`).getUTCDay();
  for (const i of [0, 1, 2, 4, 5]) await call('POST', `/academics/links/${links[i].id}/items`, { token: liaison.token, body: { items: [{ kind: 'class_block', weekdays: [1, 2, 3, 4, 5], start_time: '08:30', end_time: '13:30', from_on: day(-30), to_on: day(60), timezone: 'Asia/Kolkata', title: 'School day', blocks_sport: false }] } });
  await call('POST', `/academics/links/${links[0].id}/items`, { token: liaison.token, body: { items: [{ kind: 'exam', title: 'Mathematics board paper', starts_at: `${day(3)}T04:00:00Z`, ends_at: `${day(3)}T07:00:00Z`, timezone: 'Asia/Kolkata', high_stakes: true }, { kind: 'exam', title: 'Science unit test', starts_at: `${day(9)}T04:30:00Z`, ends_at: `${day(9)}T06:00:00Z`, timezone: 'Asia/Kolkata' }] } });
  await call('POST', `/academics/links/${links[1].id}/items`, { token: liaison.token, body: { items: [{ kind: 'exam', title: 'English literature', starts_at: `${day(3)}T05:00:00Z`, ends_at: `${day(3)}T07:30:00Z`, timezone: 'Asia/Kolkata' }, { kind: 'tutoring', title: 'Maths tutoring', starts_at: `${day(5)}T11:30:00Z`, ends_at: `${day(5)}T12:30:00Z`, timezone: 'Asia/Kolkata' }] } });
  await call('POST', `/academics/links/${links[4].id}/items`, { token: liaison.token, body: { items: [{ kind: 'exam', title: 'Physics practical', starts_at: `${day(10)}T04:00:00Z`, ends_at: `${day(10)}T06:00:00Z`, timezone: 'Asia/Kolkata' }] } });
  // academy sessions that clash (draft) and one that does not
  const sess = (d, hhmm) => call('POST', `/cohorts/${cohort.id}/academy/sessions`, { token: owner.token, body: { starts_at: `${day(d)}T${hhmm}:00Z`, duration_min: 90, title: 'Elite technical session', lead_id: coach.id } });
  await sess(3, '04:30'); await sess(5, '11:45'); await sess(7, '12:00');
  await call('POST', `/organisations/${org.id}/academics/exceptions/scan`, { token: lead.token, body: {} });
  const mk2 = (i, body) => call('POST', `/academics/links/${links[i].id}/tasks`, { token: lead.token, body });
  await mk2(5, { kind: 'coach_school_sync', title: 'Plan reduced training load around the January mocks', due_on: day(4), reason_code: 'needs_support', people: ['coach', 'school_liaison'], note: 'Agree a two-week lighter plan with the school.' });
  await mk2(2, { kind: 'guardian_meeting', title: 'Meet the family about attendance and exam preparation', due_on: day(6), reason_code: 'unauthorised_absence', people: ['coach', 'guardian'] });
  // one applied import in the history
  await call('POST', `/organisations/${school.id}/academics/imports`, { token: liaison.token, body: { kind: 'attendance', apply: true, records: [{ student_ref: 'GF-2000', period_from: day(-120), period_to: day(-61), sessions_total: 38, present: 37, authorised_absent: 1 }] } });
  const empty = await call('POST', '/organisations', { token: owner.token, body: { name: 'Hillside Cricket Academy', kind: 'academy', city: 'Mysuru' } });

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
  const inAcademics = async (p, orgId = org.id) => { await navTo(p, 'Org', { id: orgId, tab: 'academy', focus: { tab: 'academics' } }); };
  const rowOf = (p, name) => p.getByLabel(new RegExp(`^${name}`)).first();
  const SIZES = { phone: { width: 390, height: 2000 }, tablet: { width: 820, height: 1800 }, desktop: { width: 1280, height: 1500 } };
  const SCENES = {
    '1-overview': { run: async (p) => { await inAcademics(p); } },
    '2-athletes': { run: async (p) => { await inAcademics(p); await click(p, 'Athletes'); } },
    '3-athlete-file': { run: async (p) => { await inAcademics(p); await click(p, 'Athletes'); await rowOf(p, 'Aarav Mehta').click(); await wait(p, 2000); } },
    '4-attainment': { run: async (p) => { await inAcademics(p); await click(p, 'Athletes'); await rowOf(p, 'Diya Kapoor').click(); await wait(p, 1500); await click(p, 'Attainment'); } },
    '5-calendar': { run: async (p) => { await inAcademics(p); await click(p, 'School calendar'); } },
    '6-tasks': { run: async (p) => { await inAcademics(p); await click(p, 'Tasks'); } },
    '7-frameworks': { run: async (p) => { await inAcademics(p); await click(p, 'Frameworks'); } },
    '8-imports': { run: async (p) => { await inAcademics(p); await click(p, 'Imports'); await p.getByLabel('Paste the CSV').fill(`student_ref,period_from,period_to,sessions_total,present,late,authorised_absent,unauthorised_absent\nGF-2001,${day(-120)},${day(-61)},38,36,1,2,0\nGF-9999,${day(-120)},${day(-61)},38,36,1,2,0`).catch(() => {}); await click(p, 'Check and preview').catch(() => {}); await wait(p, 1500); } },
    '9-link-wizard': { run: async (p) => { await inAcademics(p); await click(p, 'Link an athlete to a school'); } },
    '10-coach-view': { who: coach, run: async (p) => { await inAcademics(p); await p.getByText('Athletes', { exact: true }).locator('visible=true').first().click({ timeout: 8000 }); await wait(p, 1500); } },
    '11-school-desk': { who: liaison, run: async (p) => { await navTo(p, 'Org', { id: school.id, tab: 'study' }); } },
    '12-school-athlete': { who: liaison, run: async (p) => { await navTo(p, 'Org', { id: school.id, tab: 'study' }); await rowOf(p, 'Aarav Mehta').click(); await wait(p, 2000); } },
    '13-my-study': { who: guardians[0], run: async (p) => { await navTo(p, 'Family'); } },
    '14-empty': { run: async (p) => { await inAcademics(p, empty.id); } },
    '15-add-exam': { run: async (p) => { await inAcademics(p); await click(p, 'Athletes'); await rowOf(p, 'Aarav Mehta').click(); await wait(p, 1500); await click(p, 'Add exam, lessons or tutoring'); } },
    '16-record-snapshot': { run: async (p) => { await inAcademics(p); await click(p, 'Athletes'); await rowOf(p, 'Aarav Mehta').click(); await wait(p, 1500); await click(p, 'Attainment'); await click(p, 'Record a term snapshot'); } },
  };
  const only = process.env.ONLY?.split(',');
  for (const [name, sc] of Object.entries(SCENES)) {
    if (only && !only.includes(name.split('-')[0])) continue;
    for (const [size, vp] of Object.entries(SIZES)) {
      for (const scheme of (size === 'tablet' ? ['light'] : ['light', 'dark'])) {
        if (scheme === 'dark' && !['1-overview', '3-athlete-file'].includes(name)) continue;
        const page = await open(vp, sc.who ?? owner, scheme);
        try { await sc.run(page); await wait(page, 600); await page.screenshot({ path: path.join(OUT, `academics-${name}-${size}${scheme === 'dark' ? '-dark' : ''}.png`) }); log(`PASS  ${name} ${size} ${scheme}`); }
        catch (e) { failures++; log(`FAIL  ${name} ${size} ${scheme}: ${e.message.split('\n')[0]}`); await page.screenshot({ path: `/tmp/academics-fail-${name}-${size}.png` }).catch(() => {}); }
        await page.context().close();
      }
    }
  }
  await browser.close();
} finally { api.kill(); web.close(); await db.end(); }
if (failures) { log(`${failures} scene(s) failed`); process.exit(1); }
