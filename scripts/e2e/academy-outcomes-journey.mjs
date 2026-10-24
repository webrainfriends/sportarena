// Browser-driven check of Academy OS 3/3 (#395): the executive home, progress (pathways, assessments, decisions), finance (P&L, receivables,
// costs, forecast), partners, the athlete 360 and the athlete/guardian progress view, on phone, tablet and desktop, plus role separation.
// Everything is created through the API/SQL at run time in a throwaway database (E2E_DATABASE_URL; its schema is recreated each run); no demo data is in the repo.
// Needs: a same-origin web build  EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir <dir>  (E2E_DIST, default /tmp/e2e-dist)
// and playwright-core (`npm i --no-save playwright-core`) with a Chromium (E2E_CHROMIUM). Run: node scripts/e2e/academy-outcomes-journey.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import pg from 'pg';
const E = { DATABASE_URL: process.env.E2E_DATABASE_URL ?? 'postgres://postgres:x@127.0.0.1:5432/sportarena_e2e', SPORTARENA_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), SPORTARENA_JWT_SECRET: Buffer.alloc(32, 9).toString('base64'),
  PORT: '4000', APP_URL: 'http://localhost:4100', CORS_ORIGINS: 'http://localhost:4100', PLATFORM_APPROVALS: 'off', RATE_LIMIT_DISABLED: 'true' };
const OUT = (process.env.E2E_SHOTS ?? '/tmp/e2e-shots') + '/'; fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
const db = new pg.Pool({ connectionString: E.DATABASE_URL });
await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
const sql = async (q, p) => (await db.query(q, p)).rows;
const api = spawn('node', ['src/server.js'], { cwd: new URL('../../apps/api/', import.meta.url).pathname, env: { ...process.env, ...E }, stdio: ['ignore', 'pipe', 'pipe'] });
api.stdout.on('data', (d) => process.env.V && log('[api]', String(d).trim())); api.stderr.on('data', (d) => process.env.V && log('[api!]', String(d).trim()));
for (let i = 0; i < 90; i++) { try { if ((await fetch('http://127.0.0.1:4000/api/v1/payments/methods')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }
const DIST = process.env.E2E_DIST ?? '/tmp/e2e-dist';
const web = http.createServer((req, res) => {
  if (req.url.startsWith('/api') || req.url.startsWith('/mcp')) { const p = http.request({ host: '127.0.0.1', port: 4000, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }); req.pipe(p); return; }
  let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
  const ext = path.extname(f); res.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf', '.ico': 'image/x-icon' }[ext] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => web.listen(4100, r));
const B = 'http://localhost:4100/api/v1';
const call = async (method, p, { token, body, query } = {}) => { const r = await fetch(`http://127.0.0.1:4000/api/v1${p}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${p} ${r.status} ${JSON.stringify(j)}`); return j; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const reg = async (h, name, roles = ['athlete']) => { const r = await call('POST', '/auth/register', { body: { handle: h, display_name: name, email: `${h}@example.com`, password: 'correct-horse-battery', roles, dob: yearsAgo(28) } }); return { ...r.user, token: r.token, email: `${h}@example.com` }; };
let failures = 0; const check = (ok, msg) => { log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const iso = (d) => d.toISOString().slice(0, 10);
const plus = (days) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + days); return d; };
try {
  // ---------- people, academy, programmes
  const owner = await reg('ada_owner', 'Ada Okafor', ['coach']), coach = await reg('ben_coach', 'Ben Hartley', ['coach']), fin = await reg('chloe_fin', 'Chloe Park', ['coach']);
  const names = ['Priya Nair', 'Tom Alvarez', 'Mia Chen', 'Jonas Weber', 'Sofia Rossi', 'Liam Murphy'];
  const ath = []; for (const [i, n] of names.entries()) ath.push(await reg(`athlete_${i}`, n));
  const org = await call('POST', '/organisations', { token: owner.token, body: { name: 'Riverside Football Academy', kind: 'academy', city: 'Leeds' } });
  await call('PATCH', `/organisations/${org.id}/academy`, { token: owner.token, body: { row_version: 0, sports: ['football'], currency: 'GBP', listed: true } });
  for (const [u, role] of [[coach, 'coach'], [fin, 'finance']]) await sql("INSERT INTO organisation_members(organisation_id, user_id, role, status, joined_at) VALUES ($1,$2,$3,'active',now())", [org.id, u.id, role]);
  const mkProg = async (title, capacity, fee, currency = 'GBP') => { const p = await call('POST', `/organisations/${org.id}/academy/programmes`, { token: owner.token, body: { sport: 'football', title, capacity, admission_mode: 'direct', public: true, focus: 'development' } }); const v = await call('POST', `/academy/programmes/${p.id}/versions`, { token: owner.token, body: { row_version: p.row_version, billing_model: 'one_time', currency, fee_minor: fee } }); return v.programme; };
  const dev = await mkProg('U14 Development Squad', 12, 18000), elite = await mkProg('Elite Performance Group', 8, 30000), camp = await mkProg('Easter Camp', 20, 9000, 'EUR');
  const enrol = async (u, prog) => { const e = await call('POST', `/academy/programmes/${prog.id}/applications`, { token: u.token, body: {} }); await call('POST', `/academy/applications/${e.id}/submit`, { token: u.token, body: { row_version: e.row_version, answers: {} } }); };
  for (const u of ath.slice(0, 4)) await enrol(u, dev); for (const u of ath.slice(4)) await enrol(u, elite); await enrol(ath[0], camp);
  await sql('UPDATE org_cohorts SET coach_id=$2 WHERE organisation_id=$1 AND programme_id IS NOT NULL', [org.id, coach.id]);
  // ---------- attendance: Priya strong, Tom falling away, Mia repeated absence
  const cohorts = await sql('SELECT id, programme_id FROM org_cohorts WHERE organisation_id=$1', [org.id]);
  const cohortOf = (p) => cohorts.find((k) => k.programme_id === p.id).id;
  const pattern = { 0: () => 'present', 1: (d) => (d > 28 ? 'present' : 'absent'), 2: (d) => (d <= 24 && d % 7 === 1 ? 'absent' : 'present') };
  for (const [i, u] of ath.slice(0, 4).entries()) for (let d = 3; d <= 56; d += 7) await sql('INSERT INTO org_attendance(cohort_id, user_id, session_date, status, recorded_by) VALUES ($1,$2,current_date - $3::int,$4,$5)', [cohortOf(dev), u.id, d, (pattern[i] ?? (() => 'present'))(d), coach.id]);
  for (const u of ath.slice(4)) for (let d = 2; d <= 42; d += 7) await sql("INSERT INTO org_attendance(cohort_id, user_id, session_date, status, recorded_by) VALUES ($1,$2,current_date - $3::int,'present',$4)", [cohortOf(elite), u.id, d, coach.id]);
  // ---------- money: payments, a scholarship, a sponsor, an overdue balance
  const charges = await sql("SELECT ch.*, e.user_id FROM academy_charges ch JOIN org_enrolments e ON e.id=ch.enrolment_id WHERE ch.organisation_id=$1 ORDER BY e.user_id, ch.created_at", [org.id]);
  const chargeOf = (u, prog) => charges.find((c) => c.user_id === u.id && c.currency === (prog === camp ? 'EUR' : 'GBP') && Number(c.gross_minor) === (prog === dev ? 18000 : prog === elite ? 30000 : 9000));
  const settle = async (ch, u, cents, cur) => { await sql("UPDATE academy_charges SET status='paid', paid_at=now() - interval '12 days' WHERE id=$1", [ch.id]); await sql("INSERT INTO payments(payer_id, provider, purpose_type, purpose_id, amount_cents, currency, status, provider_ref, paid_at) VALUES ($1,'stripe','academy_charge',$2,$3,$4,'paid',$5,now() - interval '12 days')", [u.id, ch.id, cents, cur, `ref-${ch.id.slice(0, 6)}`]); };
  for (const u of [ath[0], ath[2], ath[3]]) await settle(chargeOf(u, dev), u, 18000, 'GBP');
  for (const u of [ath[4], ath[5]]) await settle(chargeOf(u, elite), u, 30000, 'GBP');
  await settle(chargeOf(ath[0], camp), ath[0], 9000, 'EUR');
  await sql("UPDATE payments SET refunded_cents=4500, refunded_at=now() - interval '3 days' WHERE purpose_id=$1", [chargeOf(ath[3], dev).id]);
  await sql("UPDATE academy_charges SET due_on = current_date - 38 WHERE id=$1", [chargeOf(ath[1], dev).id]); // Tom owes an old fee
  const spOwner = await reg('northwind', 'Northwind Foods', ['sponsor']);
  const sp = (await sql("INSERT INTO sponsors(owner_id, name) VALUES ($1,'Northwind Foods') RETURNING id", [spOwner.id]))[0];
  const deal = (await sql("INSERT INTO sponsorships(sponsor_id, target_type, target_id, amount_cents, currency, status, proposed_by, starts_on, ends_on) VALUES ($1,'organisation',$2,600000,'GBP','active',$3,current_date - 30, current_date + 300) RETURNING id", [sp.id, org.id, spOwner.id]))[0];
  const line = (await sql("INSERT INTO sponsorship_lines(sponsorship_id, version, seq, kind, label, currency, amount_cents, cadence, instalments, first_due_on) VALUES ($1,1,1,'money','Scholarship fund','GBP',600000,'monthly',3,current_date - 30) RETURNING id", [deal.id]).catch(() => []))[0];
  if (line) { await sql("INSERT INTO sponsorship_obligations(sponsorship_id, version, line_id, seq, kind, due_on, amount_cents, currency, status) VALUES ($1,1,$2,1,'money',current_date - 30,200000,'GBP','fulfilled'),($1,1,$2,2,'money',current_date + 5,200000,'GBP','scheduled'),($1,1,$2,3,'money',current_date + 35,200000,'GBP','scheduled')", [deal.id, line.id]); }
  await call('POST', `/academy-charges/${chargeOf(ath[2], dev).id}/funding`, { token: fin.token, body: { funding_source: 'sponsor', funded_minor: 6000, sponsorship_id: deal.id } }).catch((e) => log('(funding on a paid charge is refused, as designed)'));
  const unpaid = chargeOf(ath[5], elite); await sql("UPDATE academy_charges SET status='awaiting_payment', paid_at=NULL, due_on=current_date + 6 WHERE id=$1", [unpaid.id]); await sql('DELETE FROM payments WHERE purpose_id=$1', [unpaid.id]);
  await call('POST', `/academy-charges/${unpaid.id}/funding`, { token: fin.token, body: { funding_source: 'sponsor', funded_minor: 10000, sponsorship_id: deal.id } });
  // ---------- costs and overhead
  const cost = (b) => call('POST', `/organisations/${org.id}/academy/cost-entries`, { token: fin.token, body: { currency: 'GBP', incurred_on: iso(plus(-20)), ...b } });
  await cost({ category: 'staff', programme_id: dev.id, amount_minor: 42000, description: 'Coach fees, spring term', idempotency_key: 'seed-staff-dev' });
  await cost({ category: 'venue', programme_id: dev.id, amount_minor: 18000, description: 'Pitch hire', idempotency_key: 'seed-venue-dev' });
  await cost({ category: 'staff', programme_id: elite.id, amount_minor: 52000, description: 'Head coach and analyst', idempotency_key: 'seed-staff-elite' });
  await cost({ category: 'overhead', amount_minor: 15000, allocation: { method: 'participants' }, description: 'Admin and insurance share', idempotency_key: 'seed-over' });
  // ---------- coaching evidence, pathway, decisions
  const rid = (await sql("INSERT INTO coaching_rubrics(coach_id, name) VALUES ($1,'Technical skills') RETURNING id", [coach.id]))[0].id;
  await sql("INSERT INTO coaching_rubric_versions(rubric_id, version, dimensions) VALUES ($1,1,$2)", [rid, JSON.stringify([{ key: 'passing', name: 'Passing' }, { key: 'first_touch', name: 'First touch' }])]);
  for (const [u, scores] of [[ath[0], [4, 5, 4]], [ath[1], [3, 2]], [ath[2], [4]], [ath[4], [5, 4]]]) for (const s of scores) await sql("INSERT INTO coaching_observations(coach_id, athlete_id, note, visibility, rubric_id, rubric_version, dimension_key, score, obs_type) VALUES ($1,$2,'scored in session','player',$3,1,'passing',$4,'progress')", [coach.id, u.id, rid, s]);
  await sql("INSERT INTO coaching_observations(coach_id, athlete_id, note, visibility, obs_type) VALUES ($1,$2,'PRIVATE: family circumstances','coach_private','general')", [coach.id, ath[1].id]);
  await sql("INSERT INTO coaching_goals(coach_id, athlete_id, title, athlete_text, coach_notes) VALUES ($1,$2,'First touch under pressure','Keep the ball under pressure in small-sided games','PRIVATE')", [coach.id, ath[0].id]);
  const path = await call('POST', `/organisations/${org.id}/academy/pathways`, { token: owner.token, body: { title: 'Outfield player pathway', sport: 'football' } });
  await call('POST', `/academy/pathways/${path.id}/versions`, { token: owner.token, body: { row_version: 1, levels: [
    { key: 'foundation', title: 'Foundation', position: 1, age_min: 10, age_max: 12, destinations: [{ kind: 'next_level', label: 'Development level' }] },
    { key: 'development', title: 'Development', position: 2, prerequisites: ['foundation'], min_attendance_pct: 75, programme_ids: [dev.id], criteria: [{ rubric_id: rid, dimension_key: 'passing', min_avg_score: 3.5, min_observations: 2 }], destinations: [{ kind: 'squad', label: 'Academy squad' }] },
    { key: 'performance', title: 'Performance', position: 3, prerequisites: ['development'], programme_ids: [elite.id], destinations: [{ kind: 'elite_programme', label: 'Elite programme' }, { kind: 'external', label: 'External trials' }] }] } });
  let k = 0; const decide = (u, body) => call('POST', `/academy/pathways/${path.id}/decisions`, { token: owner.token, body: { athlete_id: u.id, idempotency_key: `seed-dec-${++k}-${u.id.slice(0, 6)}`, reason: 'Seeded by the journey script', ...body } });
  await decide(ath[0], { decision: 'place', expected_from_level: null, to_level: 'foundation', reason: 'Initial placement after trial' });
  await decide(ath[0], { decision: 'promote', expected_from_level: 'foundation', acknowledge_unmet_criteria: true, reason: 'Ready for the development squad' });
  await decide(ath[1], { decision: 'place', expected_from_level: null, to_level: 'foundation', reason: 'Initial placement' });
  await decide(ath[4], { decision: 'place', expected_from_level: null, to_level: 'foundation', reason: 'Initial placement' });
  await decide(ath[4], { decision: 'promote', expected_from_level: 'foundation', acknowledge_unmet_criteria: true, reason: 'Moved up from the trial group' });
  const asm = await call('POST', `/academy/pathways/${path.id}/assessments`, { token: coach.token, body: { athlete_id: ath[0].id, level_key: 'development', period_from: iso(plus(-90)), period_to: iso(plus(0)), comment: 'Excellent passing range; keep working on the weaker foot.', comment_visibility: 'athlete' } });
  await call('POST', `/academy/assessments/${asm.id}/review`, { token: owner.token, body: { row_version: asm.row_version, action: 'approve' } });
  await call('POST', `/academy/pathways/${path.id}/assessments`, { token: coach.token, body: { athlete_id: ath[1].id, level_key: 'development', period_from: iso(plus(-90)), period_to: iso(plus(0)), comment: 'Not yet consistent.', comment_visibility: 'staff' } });
  // ---------- care network, legal, clearance
  const phys = await reg('riverside_physio', 'Dr Amara Singh', ['athlete']); await sql("UPDATE users SET roles='{physio}' WHERE id=$1", [phys.id]);
  await sql("INSERT INTO provider_profiles(user_id, provider_type, clinic, city, specialties) VALUES ($1,'physio','Riverside Sports Physio','Leeds','{sprains,rehab}')", [phys.id]);
  await sql("INSERT INTO verification_cases(type, subject_type, subject_id, requested_by, status, rules_version, expires_at) VALUES ('physio','user',$1,$1,'approved',1, now() + interval '1 year')", [phys.id]);
  await call('POST', `/organisations/${org.id}/academy/providers`, { token: owner.token, body: { provider_id: phys.id, relation: 'retained', note: 'Match-day cover and first call for sprains' } });
  const lawyer = await reg('lex_counsel', 'Lex Counsel', ['athlete']);
  await sql("INSERT INTO legal_intakes(client_id, lawyer_id, practice_area, jurisdiction, acting_as, acting_for_id, summary_enc, status) VALUES ($1,$2,'Employment contracts','GB','organisation',$3,'x','ready')", [owner.id, lawyer.id, org.id]);
  const doc = await reg('dr_doc', 'Dr Doc', ['athlete']);
  await sql("INSERT INTO clinical_clearances(athlete_id, doctor_id, status, restrictions_enc, assessed_on, valid_until) VALUES ($1,$2,'cleared',NULL,current_date,current_date + 90)", [ath[0].id, doc.id]);
  await call('POST', '/academy/clearance-shares', { token: ath[0].token, body: { organisation_id: org.id } });
  await call('POST', `/organisations/${org.id}/academy/scenarios`, { token: owner.token, body: { programme_id: dev.id, name: 'Add a Saturday cohort', idempotency_key: 'seed-scenario', assumptions: { renewal_pct: 85, new_athletes: 3, price_change_pct: 5, extra_cohorts: 1, extra_cohort_size: 10, extra_cohort_cost_minor: 20000, billing_periods: 1 } } });
  log('seeded');

  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const session = async (who, viewport) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, acceptDownloads: true }); const page = await ctx.newPage();
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } }); if (!r.ok()) throw new Error(`login ${r.status()} ${await r.text()}`);
    await page.goto('http://localhost:4100/'); await page.waitForTimeout(2500);
    return { ctx, page };
  };
  const wait = (p, ms = 1500) => p.waitForTimeout(ms);
  const shot = async (p, n, scrolls = 0) => { await p.screenshot({ path: `${OUT}${n}.png` });
    for (let i = 1; i <= scrolls; i++) { await p.mouse.move(p.viewportSize().width / 2, p.viewportSize().height / 2); await p.mouse.wheel(0, p.viewportSize().height * 0.85); await wait(p, 700); await p.screenshot({ path: `${OUT}${n}-scroll${i}.png` }); } };
  const vis = async (p, t) => (await p.getByText(t).count()) > 0;
  const click = async (p, t, ms = 1800) => { await p.getByText(t, { exact: true }).first().click(); await wait(p, ms); };
  const openOrgs = async (p) => { await p.getByText('More', { exact: true }).first().click(); await wait(p, 1200); await p.getByLabel('Organisations').first().click(); await wait(p, 1500); await p.getByLabel(/Organisations, selected/).first().click(); await wait(p, 2500); };
  const openAcademy = async (p) => { await openOrgs(p); await click(p, 'Riverside Football Academy', 2500); await click(p, 'Academy', 2500); };
  const side = async (p, name, ms = 2200) => { await p.getByRole('tab', { name: new RegExp(name) }).first().click(); await wait(p, ms); };

  // ---- 1. owner, desktop: executive home
  const { page: d } = await session(owner, { width: 1280, height: 1100 });
  await openAcademy(d);
  check(await vis(d, 'Executive view'), 'owner: the executive home is part of Academy Home');
  check(await vis(d, /Retention & engagement indicators/), 'owner: retention indicators are shown with their rules');
  check(await vis(d, /Attendance falling|Repeated absence|Balance overdue/), 'owner: an indicator names what fired');
  check(await vis(d, /Cancelled sessions: missing/), 'owner: what cannot be known yet is shown as missing, not zero');
  await shot(d, '01-executive-home-desktop', 3);
  await d.getByText('Ask', { exact: true }).last().scrollIntoViewIfNeeded(); await click(d, 'Why did margin move?', 600); await click(d, 'Ask', 2500);
  check(await vis(d, /calculated from your records/i), 'copilot: works without an AI model and says so');
  check((await d.getByText(/^fact$/i).count()) > 0, 'copilot: facts are marked as facts, with a source');
  await shot(d, '02-copilot-desktop');
  // ---- 2. progress
  await side(d, 'Progress');
  check(await vis(d, 'Who needs a look'), 'progress: the review queue opens');
  await shot(d, '03-progress-queue-desktop');
  await click(d, 'Tom Alvarez', 2500);
  check(await vis(d, /Coach observations shared with the athlete/), 'progress: evidence is listed with its source');
  check(!(await vis(d, /PRIVATE: family/)), 'progress: private coach notes never appear');
  check(await vis(d, /academy recorded/i) && await vis(d, /coach observed/i), 'progress: each figure carries its origin');
  await shot(d, '04-athlete-progress-desktop', 2);
  await click(d, 'Record a decision', 1500); await shot(d, '05-decision-form-desktop');
  await d.keyboard.press('Escape'); await wait(d, 600);
  await click(d, 'Pathways', 2000);
  check(await vis(d, 'Outfield player pathway'), 'progress: the pathway and its levels are shown');
  await shot(d, '06-pathways-desktop');
  await click(d, 'Edit levels (new version)', 1500); await shot(d, '07-levels-editor-desktop');
  // ---- 3. finance
  await openAcademy(d); await side(d, 'Finance'); await click(d, 'Profit & loss', 2500);
  check(await vis(d, /Management view|management view/), 'finance: the P&L states its basis');
  check(await vis(d, 'GBP — management view') && await vis(d, 'EUR — management view'), 'finance: each currency has its own P&L, never summed');
  check(await vis(d, /costs missing/i), 'finance: a programme with no cost entered shows costs missing, not 0');
  await shot(d, '08-pnl-desktop', 3);
  await d.getByText('Elite Performance Group').last().click(); await wait(d, 2200); check(await vis(d, /Behind the figures/), 'finance: a figure drills to its source charges and cost entries'); await shot(d, '09-pnl-drill-desktop');
  await click(d, 'Receivables', 2500); check(await vis(d, /outstanding/), 'finance: receivables ageing is shown by currency'); await shot(d, '10-receivables-desktop', 1);
  await click(d, 'Costs', 2000); check(await vis(d, /not payments or invoices/), 'finance: costs are labelled as management entries'); await shot(d, '11-costs-desktop');
  await click(d, '＋ Add cost', 1500); await shot(d, '12-add-cost-desktop'); await d.keyboard.press('Escape'); await wait(d, 500);
  await click(d, 'Forecast', 2000); check(await vis(d, /scenario — not actuals/i), 'finance: forecasts are marked as scenarios, not actuals'); await shot(d, '13-forecast-desktop', 1);
  // ---- 4. partners, athlete 360
  await openAcademy(d); await side(d, 'Partners');
  check(await vis(d, 'Northwind Foods') && await vis(d, /Dr Amara Singh/) && await vis(d, /Employment contracts/), 'partners: sponsor, provider and legal matter are listed');
  check(!(await vis(d, /SECRET|restrictions:/)), 'partners: no clinical content');
  await shot(d, '14-partners-desktop', 1);
  await openAcademy(d); await side(d, 'Families'); await click(d, 'Priya Nair', 2500);
  check(await vis(d, /Fit to take part/) && await vis(d, /Cleared/), 'athlete 360: the shared fit status is shown (status only)');
  check(await vis(d, /Keep the ball under pressure/) && !(await vis(d, /^PRIVATE$/)), 'athlete 360: shared coaching goal shown, private note not');
  await shot(d, '15-athlete-360-desktop', 3);
  await d.context().close();
  // ---- 5. phone and tablet
  const { page: ph } = await session(owner, { width: 390, height: 844 });
  await openAcademy(ph); await shot(ph, '16-executive-home-phone', 3);
  await side(ph, 'Progress'); await shot(ph, '17-progress-phone'); await click(ph, 'Tom Alvarez', 2500); await shot(ph, '18-athlete-progress-phone', 2);
  await ph.context().close();
  const { page: tb } = await session(fin, { width: 820, height: 1100 });
  await openAcademy(tb);
  check(await vis(tb, 'Finance') && !(await vis(tb, 'Families')) && !(await vis(tb, /^Progress$/)), 'finance role: sees Finance and Partners, not families or coaching');
  await click(tb, 'Profit & loss', 2500); await shot(tb, '19-finance-pnl-tablet', 1);
  check(!(await vis(tb, /^PRIVATE$|coach observed/i)), 'finance role: no coaching data on screen');
  await tb.context().close();
  // ---- 6. coach: progress only
  const { page: co } = await session(coach, { width: 390, height: 844 });
  await openAcademy(co);
  check(await vis(co, 'Who needs a look') && !(await vis(co, 'Finance')) && !(await vis(co, 'Partners')), 'coach: sees the progress queue only, with no finance or partners');
  check(!(await vis(co, /Northwind|Employment contracts/)), 'coach: no sponsor or legal data');
  await shot(co, '20-coach-progress-phone'); await co.context().close();
  // ---- 7. athlete: my progress
  const { page: at } = await session(ath[0], { width: 390, height: 844 });
  await openOrgs(at); await click(at, 'My academy', 2500); await at.screenshot({ path: `${OUT}00-myacademy.png` });
  await click(at, 'Progress', 2500);
  check(await vis(at, /Excellent passing range/), 'athlete: sees the assessment comment the assessor shared');
  check(await vis(at, /Stop sharing|Share fit status only/), 'athlete: controls what is shared about fitness');
  check(!(await vis(at, /^PRIVATE$|Not yet consistent/)), 'athlete: no staff-only or private notes');
  await shot(at, '21-athlete-progress-phone', 2); await at.context().close();
  await browser.close();
} catch (e) { console.error(e); failures++; }
finally { api.kill(); web.close(); await db.end(); log(failures ? `${failures} FAILED` : 'ALL PASSED'); process.exit(failures ? 1 : 0); }
