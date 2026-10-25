// Browser-driven check of the merged sponsor team (#347): one Team & identity screen for individual, company and organization sponsors,
// organisation staff mirrored onto the team, invitations answered from the Sponsors home, and revocation that is immediate, on phone,
// tablet and desktop. Everything is created through the API at run time in a throwaway database (E2E_DATABASE_URL; its schema is
// recreated each run); no demo data is in the repo.
// Needs: a same-origin web build  EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir <dir>  (E2E_DIST, default /tmp/e2e-dist)
// and playwright-core (`npm i --no-save playwright-core`) with a Chromium (E2E_CHROMIUM). Run: node scripts/e2e/sponsor-team-journey.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import pg from 'pg';
const E = { DATABASE_URL: process.env.E2E_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/sportarena_e2e', SPORTARENA_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), SPORTARENA_JWT_SECRET: Buffer.alloc(32, 9).toString('base64'),
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
const call = async (method, p, { token, body } = {}) => { const r = await fetch(`http://127.0.0.1:4000/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${p} ${r.status} ${JSON.stringify(j)}`); return j; };
const reg = async (h, name, roles = ['athlete']) => { const r = await call('POST', '/auth/register', { body: { handle: h, display_name: name, email: `${h}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); return { ...r.user, token: r.token, email: `${h}@example.com` }; };
let failures = 0; const check = (ok, msg) => { log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const wait = (p, ms = 1500) => p.waitForTimeout(ms);
try {
  // ---------- an organization sponsor run by an organisation, an invited guest and an individual brand
  const owner = await reg('ada_owner', 'Ada Okafor', ['sponsor']), fin = await reg('chloe_fin', 'Chloe Park'), ev = await reg('ben_eval', 'Ben Hartley');
  const guest = await reg('gia_guest', 'Gia Moretti'), invitee = await reg('ivo_invitee', 'Ivo Bianchi'), solo = await reg('sam_solo', 'Sam Lee', ['sponsor']);
  const org = await call('POST', '/organisations', { token: owner.token, body: { name: 'Acme Sports Group', kind: 'company' } });
  const dept = await call('POST', `/organisations/${org.id}/departments`, { token: owner.token, body: { name: 'Marketing' } });
  const brand = await call('POST', '/sponsors', { token: owner.token, body: { name: 'Acme Energy' } });
  const idn = await call('POST', `/sponsors/${brand.id}/identity`, { token: owner.token, body: { sponsor_type: 'organization', legal_name: 'Acme Sports Group', organisation_id: org.id } });
  for (const [u, role, department_id] of [[fin, 'finance', dept.id], [ev, 'evaluator', undefined]]) {
    await call('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role, department_id } });
    await call('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } });
  }
  const gi = await call('POST', `/sponsor-entities/${idn.entity_id}/representatives`, { token: owner.token, body: { user_id: guest.id, role: 'legal', department_id: dept.id } });
  await call('POST', `/sponsor-representatives/${gi.id}/response`, { token: guest.token, body: { accept: true } });
  await call('POST', `/sponsor-entities/${idn.entity_id}/representatives`, { token: owner.token, body: { user_id: invitee.id, role: 'approver' } }); // left pending
  const soloBrand = await call('POST', '/sponsors', { token: solo.token, body: { name: 'Sam Solo Kits' } });

  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const session = async (who, viewport, open) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 }); const page = await ctx.newPage();
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } }); if (!r.ok()) throw new Error(`login ${r.status()} ${await r.text()}`);
    await page.goto(`http://localhost:4100/?open=${open}`); await wait(page, 3500);
    return { ctx, page };
  };
  const shot = (page, n) => page.screenshot({ path: `${OUT}${n}.png`, fullPage: false });

  // ---- 1. owner, phone: Sponsors home -> Team & identity
  const { ctx: c1, page: p } = await session(owner, { width: 390, height: 844 }, 'sponsors');
  await shot(p, '01-sponsors-home-phone');
  check(await p.getByText('Team & identity').first().isVisible(), 'Your brands offers Team & identity');
  await p.getByText('Team & identity').first().click(); await wait(p, 2500); await shot(p, '02-team-phone');
  check(await p.getByText('Team', { exact: true }).first().isVisible(), 'phone: the Team section is shown');
  check(await p.getByText(/through the organisation/i).count() >= 2, 'phone: organisation staff are marked as coming through the organisation');
  check(await p.getByText(/Gia Moretti/).first().isVisible(), 'phone: the person invited by hand is on the team');
  check(await p.getByText(/Marketing/).first().isVisible(), 'phone: a department scope is shown');
  check((await p.getByText(/Change role/).count()) >= 1, 'phone: hand-invited people can be changed');
  await p.getByText('+ Invite person').first().click(); await wait(p, 1500); await shot(p, '03-invite-sheet-phone');
  for (const label of ['Manager', 'Approver', 'Finance', 'Legal', 'Evaluator', 'Auditor', 'Viewer']) check(await p.getByText(label, { exact: true }).first().isVisible(), `invite sheet offers the ${label} role`);
  await c1.close();

  // ---- 2. revocation in the organisation ends the team access at once
  check((await call('GET', `/sponsors/${brand.id}`, { token: ev.token })).id === brand.id, 'before: the evaluator reaches the brand');
  await call('DELETE', `/organisations/${org.id}/members/${ev.id}`, { token: owner.token });
  let denied = false; try { await call('GET', '/sponsors?mine=true', { token: ev.token }).then((r) => { denied = !r.some((b) => b.id === brand.id); }); } catch { denied = true; }
  check(denied, 'after: the removed evaluator no longer sees the brand on their list');
  const { ctx: c2, page: q } = await session(owner, { width: 390, height: 844 }, `sponsor-team:${brand.id}`); await shot(q, '04-team-after-revoke');
  check(await q.getByText(/Ben Hartley/).count() === 0, 'the removed person is gone from the team screen');
  await c2.close();

  // ---- 3. invitee answers from the Sponsors home
  const { ctx: c3, page: i } = await session(invitee, { width: 390, height: 844 }, 'sponsors'); await shot(i, '05-invitation-phone');
  check(await i.getByText('Invitations to a sponsor team').first().isVisible(), 'the invited person sees the invitation');
  await i.getByText('Accept', { exact: true }).first().click(); await wait(i, 2500); await shot(i, '06-after-accept');
  check((await sql("SELECT status FROM sponsor_representatives WHERE user_id=$1", [invitee.id]))[0].status === 'active', 'accepting made them an active team member');
  await c3.close();

  // ---- 4. tablet and desktop: two panes; the individual brand keeps working
  for (const [n, vp] of [['tablet', { width: 820, height: 1100 }], ['desktop', { width: 1280, height: 900 }]]) {
    const { ctx, page: w } = await session(owner, vp, `sponsor-team:${brand.id}`); await shot(w, `07-team-${n}`);
    const t = await w.getByText('Team', { exact: true }).first().boundingBox(), idb = await w.getByText('Legal & billing identity').first().boundingBox();
    check(t && idb && Math.abs(t.y - idb.y) < 80 && t.x < idb.x, `${n}: Team and identity sit side by side`);
    await ctx.close();
  }
  const { ctx: c5, page: s } = await session(solo, { width: 390, height: 844 }, `sponsor-team:${soloBrand.id}`); await shot(s, '08-individual-brand');
  check(await s.getByText('Identity not confirmed').first().isVisible(), 'an individual brand without an identity still opens, with no invented data');
  await c5.close();
  await browser.close();
} catch (e) { console.error(e); failures++; }
finally { api.kill(); web.close(); await db.end(); log(failures ? `${failures} FAILED` : 'ALL PASSED'); process.exit(failures ? 1 : 0); }
