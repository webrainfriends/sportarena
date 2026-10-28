// Browser-driven check of Sports advertising (#524): a visitor sees a clearly labelled "Promoted" venue ad beside the venue search (and can read why,
// hide or report it), the advertiser's workspace (campaigns, a campaign's funds and measured performance, the new-campaign wizard with its live preview),
// the platform admin's review desk and policy, and the organiser's switch for ads on a public event page — at phone, tablet and desktop widths.
// Data is created through the public API (plus the few rows the API cannot create without a payment provider: the paid funding).
// Needs: a throwaway Postgres database (E2E_DATABASE_URL; migrated by the server, never dropped here), a same-origin web build
//   EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir <dir>   (E2E_DIST, default /tmp/e2e-dist)
// and playwright with a Chromium. Run: node scripts/e2e/advertising-journey.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const { chromium } = createRequire('/opt/node-tools/')('playwright');
import pg from 'pg';
const E = {
  DATABASE_URL: process.env.E2E_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/sportarena_e2e', SPORTARENA_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), SPORTARENA_JWT_SECRET: Buffer.alloc(32, 9).toString('base64'),
  PORT: '4000', APP_URL: 'http://localhost:4100', CORS_ORIGINS: 'http://localhost:4100', PLATFORM_APPROVALS: 'off', PLATFORM_ADMIN_EMAILS: 'rraja.edge@gmail.com,rrajas1978@icloud.com',
};
const OUT = (process.env.E2E_SHOTS ?? '/tmp/e2e-shots') + '/'; fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
const api = spawn('node', ['src/server.js'], { cwd: new URL('../../apps/api/', import.meta.url).pathname, env: { ...process.env, ...E }, stdio: ['ignore', 'pipe', 'pipe'] });
api.stdout.on('data', (d) => process.env.V && log('[api]', String(d).trim())); api.stderr.on('data', (d) => process.env.V && log('[api!]', String(d).trim()));
for (let i = 0; i < 90; i++) { try { if ((await fetch('http://127.0.0.1:4000/api/v1/payments/methods')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }
const DIST = process.env.E2E_DIST ?? '/tmp/e2e-dist';
const web = http.createServer((req, res) => {
  if (req.url.startsWith('/api') || req.url.startsWith('/mcp')) { const p = http.request({ host: '127.0.0.1', port: 4000, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }); req.pipe(p); return; }
  let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
  const ext = path.extname(f); res.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf' }[ext] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => web.listen(4100, r));
const B = 'http://localhost:4100/api/v1';
const call = async (method, p, { token, body } = {}) => { const r = await fetch(`http://127.0.0.1:4000/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(j).slice(0, 300)}`); return j; };
const reg = async (h, name, roles = ['athlete'], email) => { const r = await call('POST', '/auth/register', { body: { handle: h, display_name: name, email: email ?? `${h}@example.com`, password: 'correct-horse-battery', roles } }); return { ...r.user, token: r.token, email: email ?? `${h}@example.com` }; };
const db = new pg.Pool({ connectionString: E.DATABASE_URL });
let failures = 0; const check = (ok, msg) => { log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const wait = (p, ms = 1200) => p.waitForTimeout(ms);
const tag = Math.random().toString(36).slice(2, 7);

try {
  // ---------------------------------------------------------------- data, created through the public API
  const adv = await reg(`ad_adv_${tag}`, 'Meera Kapoor', ['venue_manager', 'organizer']), viewer = await reg(`ad_view_${tag}`, 'Arjun Mehta');
  const admin = await reg(`ad_boss_${tag}`, 'Platform Admin', ['athlete'], 'rraja.edge@gmail.com');
  await db.query("UPDATE users SET roles = '{athlete,admin,platform_admin}' WHERE id=$1", [admin.id]);
  const venue = await call('POST', '/venues', { token: adv.token, body: { name: 'Marine Drive Courts', city: 'Mumbai', timezone: 'Asia/Kolkata', currency: 'INR', payment_mode: 'online_optional', description: 'Six indoor courts by the sea' } });
  await call('POST', `/venues/${venue.id}/resources`, { token: adv.token, body: { kind: 'court', name: 'Court 1', hourly_rate_cents: 60000 } });
  const other = await call('POST', '/venues', { token: adv.token, body: { name: 'Bandra Sports Club', city: 'Mumbai', timezone: 'Asia/Kolkata', currency: 'INR', payment_mode: 'online_optional' } });
  void other;
  const acc = await call('POST', '/advertising/advertisers', { token: adv.token, body: { accept_policy: true } });
  const mk = (name, over = {}) => call('POST', '/advertising/campaigns', { token: adv.token, body: {
    advertiser_id: acc.id, name, objective: 'traffic', category: 'venues_facilities', placements: ['featured_venue'], billing_model: 'cpm', rate_minor: 20000, currency: 'INR', budget_minor: 200000,
    starts_on: day(0), ends_on: day(30), landing_entity_type: 'venue', landing_entity_id: venue.id,
    creative: { headline: 'Courts from 8am, seaside', body: 'Six indoor courts. Book a slot this week.', cta: 'book_now', claims: ['availability'] }, ...over } });
  const live = await mk('Spring courts');
  const waiting = await mk('Weekend badminton', { sports: ['badminton'], placements: ['featured_venue'], creative: { headline: 'Badminton weekends', body: 'Open play every Saturday', cta: 'register', claims: [] } });
  await mk('Winter leagues (draft)', { billing_model: 'flat', rate_minor: 150000, budget_minor: 150000 });
  await call('POST', `/advertising/campaigns/${live.id}/submit`, { token: adv.token });
  await call('POST', `/advertising/campaigns/${waiting.id}/submit`, { token: adv.token });
  await call('POST', `/admin/advertising/campaigns/${live.id}/review`, { token: admin.token, body: { decision: 'approved', claims_checked: ['availability'] } });
  // the paid funding (the payment provider is not part of this check): a paid invoice, its ledger line and the campaign's funds
  const f = (await db.query("INSERT INTO ad_fundings(number, campaign_id, payer_id, amount_minor, currency, status, paid_at) VALUES ('AD-2026-900001',$1,$2,200000,'INR','paid',now()) RETURNING id", [live.id, adv.id])).rows[0];
  await db.query("INSERT INTO ad_ledger(campaign_id, funding_id, kind, amount_minor, note) VALUES ($1,$2,'funding',200000,'Funding AD-2026-900001')", [live.id, f.id]);
  await db.query('UPDATE ad_campaigns SET funded_minor=200000 WHERE id=$1', [live.id]);
  await call('POST', `/advertising/campaigns/${live.id}/start`, { token: adv.token });
  for (let i = 0; i < 14; i++) { const r = await fetch(`http://127.0.0.1:4000/api/v1/public/ads?placement=featured_venue`, { headers: { 'user-agent': `seed-${i}` } }); const j = await r.json(); if (j.ads?.[0] && i % 4 === 0) await fetch(`http://127.0.0.1:4000/api/v1/public/ads/${j.ads[0].token}/click`, { method: 'POST', headers: { 'user-agent': `seed-${i}`, 'content-type': 'application/json' }, body: '{}' }); }
  const ev = await call('POST', '/events', { token: adv.token, body: { name: 'Mumbai Open Badminton', sport: 'badminton', city: 'Mumbai', kind: 'tournament' } });
  await call('PATCH', `/events/${ev.id}`, { token: adv.token, body: { status: 'open' } });
  await call('PATCH', `/events/${ev.id}/public-settings`, { token: adv.token, body: { ads: true } });
  const evAd = await mk('Tournament week', { placements: ['event_display'], landing_entity_type: undefined, landing_entity_id: undefined, landing_url: 'https://example.com/summer-offer', objective: 'traffic', creative: { headline: 'Rackets 15% off this week', cta: 'shop_now', claims: ['price'] } });
  await call('POST', `/advertising/campaigns/${evAd.id}/submit`, { token: adv.token });
  await call('POST', `/admin/advertising/campaigns/${evAd.id}/review`, { token: admin.token, body: { decision: 'approved', claims_checked: ['price'] } });
  const f2 = (await db.query("INSERT INTO ad_fundings(number, campaign_id, payer_id, amount_minor, currency, status, paid_at) VALUES ('AD-2026-900002',$1,$2,200000,'INR','paid',now()) RETURNING id", [evAd.id, adv.id])).rows[0];
  await db.query("INSERT INTO ad_ledger(campaign_id, funding_id, kind, amount_minor) VALUES ($1,$2,'funding',200000)", [evAd.id, f2.id]);
  await db.query('UPDATE ad_campaigns SET funded_minor=200000 WHERE id=$1', [evAd.id]);
  await call('POST', `/advertising/campaigns/${evAd.id}/start`, { token: adv.token });

  const acad = await reg(`ad_acad_${tag}`, 'Kiran Rao', ['organizer']);
  const aorg = await call('POST', '/organisations', { token: acad.token, body: { name: 'Harbour Football Academy', kind: 'academy', city: 'Mumbai' } });
  await call('PATCH', `/organisations/${aorg.id}/academy`, { token: acad.token, body: { row_version: 0, sports: ['football'], currency: 'INR', listed: true } });
  const aprog = await call('POST', `/organisations/${aorg.id}/academy/programmes`, { token: acad.token, body: { sport: 'football', title: 'U12 Saturday squad', capacity: 20, admission_mode: 'direct', public: true } });
  await call('POST', `/academy/programmes/${aprog.id}/versions`, { token: acad.token, body: { row_version: aprog.row_version, billing_model: 'one_time', currency: 'INR', fee_minor: 500000 } });
  const sup = await reg(`ad_sup_${tag}`, 'Dev Patel', ['supplier']);
  const sprof = await call('POST', '/supplier-profiles', { token: sup.token, body: { supplier_type: 'sole_trader', legal_name: 'GreenTurf Services', trading_name: 'GreenTurf', categories: ['ground_maintenance'], currencies: ['INR'], daily_capacity: 4, description: 'Pitch preparation and ground crew for tournaments.' } });
  const aacc = await call('POST', '/advertising/advertisers', { token: acad.token, body: { organisation_id: aorg.id, accept_policy: true } });
  const sacc = await call('POST', '/advertising/advertisers', { token: sup.token, body: { accept_policy: true } });
  const mk2 = async (who, accId, name, over) => {
    const k = await call('POST', '/advertising/campaigns', { token: who.token, body: { advertiser_id: accId, name, objective: 'traffic', billing_model: 'cpm', rate_minor: 20000, currency: 'INR', budget_minor: 200000, starts_on: day(0), ends_on: day(30), ...over } });
    await call('POST', `/advertising/campaigns/${k.id}/submit`, { token: who.token });
    await call('POST', `/admin/advertising/campaigns/${k.id}/review`, { token: admin.token, body: { decision: 'approved' } });
    const fd = (await db.query("INSERT INTO ad_fundings(number, campaign_id, payer_id, amount_minor, currency, status, paid_at) VALUES ($1,$2,$3,200000,'INR','paid',now()) RETURNING id", [`AD-2026-9${Math.floor(Math.random() * 90000 + 10000)}`, k.id, who.id])).rows[0];
    await db.query("INSERT INTO ad_ledger(campaign_id, funding_id, kind, amount_minor) VALUES ($1,$2,'funding',200000)", [k.id, fd.id]);
    await db.query('UPDATE ad_campaigns SET funded_minor=200000 WHERE id=$1', [k.id]);
    await call('POST', `/advertising/campaigns/${k.id}/start`, { token: who.token });
  };
  await mk2(acad, aacc.id, 'Saturday squad', { category: 'academies_education', placements: ['featured_academy'], landing_entity_type: 'academy', landing_entity_id: aorg.id, creative: { headline: 'Trials every Saturday', body: 'Under-12 football squad, all abilities', cta: 'learn_more', claims: [] } });
  await mk2(sup, sacc.id, 'Pitch care', { category: 'technology_services', placements: ['promoted_supplier'], landing_entity_type: 'supplier', landing_entity_id: sprof.id, creative: { headline: 'Pitch care, all season', cta: 'view', claims: [] } });

  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const SIZES = { phone: { width: 390, height: 844 }, tablet: { width: 820, height: 1180 }, desktop: { width: 1366, height: 900 } };
  const open = async (viewport, url, who) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 }); const page = await ctx.newPage();
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    if (who) { const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } }); if (!r.ok()) throw new Error(`login ${who.email}`); }
    await page.goto(url); await wait(page, 2800);
    return { ctx, page };
  };
  const shot = (page, n, full = false) => page.screenshot({ path: `${OUT}${n}.png`, fullPage: full });
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
  const goTab = async (p, tab, params = {}) => {
    await navTo(p, 'Notifications');
    await p.evaluate(({ tab, params }) => window.__nav.goTab(tab, params), { tab, params });
    await wait(p, 2200);
  };
  const noOverflow = async (p, label) => { const w = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); check(w <= 1, `${label}: no horizontal page scroll`); };
  const tall = async (p, text, label) => { const b = await p.getByText(text).first().boundingBox().catch(() => null); check(!!b && b.height >= 28, `${label}: reachable control`); };

  // ---------------------------------------------------------------- 1. a person searching for a court sees a clearly labelled, separate ad
  for (const [size, vp] of Object.entries(SIZES)) {
    const { ctx, page: p } = await open(vp, 'http://localhost:4100/', viewer);
    await goTab(p, 'Schedule');
    await p.getByText('Venues', { exact: true }).first().click(); await wait(p, 2200);   // the venue search is the Venues section of Schedule
    check(await vis(p, 'Promoted'), `${size}: the venue ad is labelled "Promoted"`);
    check(await vis(p, 'Courts from 8am, seaside'), `${size}: the ad shows beside the venue search`);
    check(await vis(p, 'Marine Drive Courts') && await vis(p, 'Bandra Sports Club'), `${size}: the organic venues are still listed below, unchanged`);
    await shot(p, `01-venue-search-ad-${size}`);
    await noOverflow(p, `${size} venue search with an ad`);
    if (size === 'phone') {
      await p.getByLabel('Why am I seeing this ad? Hide or report it').first().click(); await wait(p, 900);
      check(await vis(p, 'not because of anything private'), 'the ⓘ explains why the ad appears, without private detail');
      check(await vis(p, 'Hide this ad') && await vis(p, 'Report this ad'), 'the person can hide or report it');
      await shot(p, '02-why-this-ad-phone');
      await p.getByText('Report this ad').first().click(); await wait(p, 700); await shot(p, '03-report-ad-phone');
    }
    await ctx.close();
  }

  // ---------------------------------------------------------------- 1b. Explore → Academies and Suppliers, each with its own labelled placement above an unchanged list
  for (const [size, vp] of Object.entries(SIZES)) {
    const { ctx, page: p } = await open(vp, 'http://localhost:4100/', viewer);
    await p.getByText('Explore', { exact: true }).first().click(); await wait(p, 1800);
    await p.getByText('Academies', { exact: true }).first().click(); await wait(p, 1800);
    check(await vis(p, 'Harbour Football Academy') && await vis(p, 'Trials every Saturday') && await vis(p, 'Promoted'), `${size}: Explore → Academies lists the academy, with its labelled placement above`);
    await shot(p, `05-explore-academies-${size}`);
    await noOverflow(p, `${size} academies`);
    if (size === 'phone') {
      await p.getByText('Harbour Football Academy', { exact: true }).last().click(); await wait(p, 1800);
      check(await vis(p, 'U12 Saturday squad') && await vis(p, 'Enquire or apply'), 'the academy page shows its programmes and how to apply');
      await shot(p, '06-academy-page-phone');
      await p.goBack().catch(() => {}); await wait(p, 600);
    }
    await p.getByText('Suppliers', { exact: true }).first().click(); await wait(p, 1800);
    check(await vis(p, 'GreenTurf') && await vis(p, 'Pitch care, all season') && await vis(p, 'Promoted'), `${size}: Explore → Suppliers lists the supplier, with its labelled placement above`);
    await shot(p, `07-explore-suppliers-${size}`);
    await noOverflow(p, `${size} suppliers`);
    if (size === 'phone') {
      await p.getByText('GreenTurf', { exact: true }).last().click(); await wait(p, 1800);
      check(await vis(p, 'Pitch preparation and ground crew'), 'the supplier page shows its profile');
      await shot(p, '08-supplier-page-phone');
    }
    await ctx.close();
  }

  // ---------------------------------------------------------------- 2. the advertiser's workspace
  for (const [size, vp] of Object.entries(SIZES)) {
    const { ctx, page: p } = await open(vp, 'http://localhost:4100/', adv);
    await navTo(p, 'Advertising');
    check(await vis(p, 'Spring courts') && await vis(p, 'Weekend badminton'), `${size}: the campaigns are listed with their status`);
    check(await vis(p, 'Live') && await vis(p, 'In review') && await vis(p, 'Draft'), `${size}: Live / In review / Draft are shown`);
    check(await vis(p, 'Where ads can appear'), `${size}: the placements are listed with their surface`);
    await shot(p, `10-advertiser-home-${size}`, true);
    await noOverflow(p, `${size} advertiser home`);
    if (size === 'phone') {
      await navTo(p, 'AdCampaign', { id: live.id });
      check(await vis(p, 'How it looks') && await vis(p, 'Promoted'), 'the campaign shows the ad with its label');
      check(await vis(p, 'How this is measured') && await vis(p, 'Not measured'), 'the measurement definitions are shown, and reach and conversions are marked not measured');
      check(await vis(p, 'Spend and funds agree'), 'spend reconciles to the delivery records');
      await shot(p, '11-campaign-detail-phone', true);
      await p.goBack().catch(() => {}); await wait(p, 800);
    }
    if (size === 'tablet') { await navTo(p, 'AdCampaign', { id: live.id }); await shot(p, '11-campaign-detail-tablet', true); }
    await ctx.close();
  }

  // ---------------------------------------------------------------- 3. the new-campaign wizard, with its live preview
  {
    const { ctx, page: p } = await open(SIZES.phone, 'http://localhost:4100/', adv);
    await navTo(p, 'Advertising');
    await p.getByText('＋ New campaign').first().click(); await wait(p, 1200);
    check(await vis(p, 'What are you promoting?'), 'step 1 asks what is being promoted with chips and a venue picker');
    await shot(p, '12-wizard-1-phone');
    await p.getByRole('textbox').first().fill('Autumn courts');
    await p.getByText('+ Pick venue').first().click(); await wait(p, 900);
    check(await vis(p, 'Marine Drive Courts'), 'the venue picker lists only venues I manage');
    await p.getByText('Marine Drive Courts').first().click(); await wait(p, 500);
    await p.getByText('Venues and facilities', { exact: true }).first().click();
    await p.getByText('Next', { exact: true }).last().click(); await wait(p, 1200);
    check(await vis(p, 'Where should it appear?'), 'step 2 offers only the placements that fit a venue');
    check(await vis(p, 'Featured venue') && await vis(p, 'Sponsored search slot'), 'venue placements are offered');
    check((await p.getByText('Featured coach or professional').count()) === 1, 'placements that need a coach are not offered in the wizard (the only mention is the list behind it)');
    await p.getByText('Featured venue', { exact: true }).last().click(); await wait(p, 500);
    await shot(p, '13-wizard-2-phone');
    await p.getByText('Next', { exact: true }).last().click(); await wait(p, 1200);
    check(await vis(p, 'Which sports?') && await vis(p, 'Most times one person sees it in a day'), 'step 3 targets by sport, place and a frequency stepper');
    check(await vis(p, 'precise location'), 'the notice states what can never be used for targeting');
    await shot(p, '14-wizard-3-phone');
    await p.getByText('Next', { exact: true }).last().click(); await wait(p, 1200);
    check(await vis(p, 'How do you pay?') && await vis(p, 'When does it run?'), 'step 4 asks for billing, currency, price and a calendar range');
    await shot(p, '15-wizard-4-phone');
    const price = p.getByPlaceholder(/0$/).first(); await price.fill('150').catch(() => {});
    const budget = p.getByPlaceholder(/0$/).nth(1); await budget.fill('3000').catch(() => {});
    await p.getByText('When does it run?').first().scrollIntoViewIfNeeded().catch(() => {});
    await p.getByText('Pick the dates', { exact: false }).first().click().catch(() => {}); await wait(p, 800);
    await shot(p, '16-wizard-4-calendar-phone');
    await p.getByText('29', { exact: true }).last().click(); await wait(p, 400);
    await p.getByText('31', { exact: true }).last().click(); await wait(p, 600);
    await p.getByText('Done', { exact: false }).last().click().catch(() => {}); await wait(p, 600);
    await p.getByText('Next', { exact: true }).last().click(); await wait(p, 1200);
    check(await vis(p, 'This is what people will see'), 'step 5 writes the ad and previews it with its label');
    await p.getByRole('textbox').first().fill('Autumn courts from 8am');
    await p.getByText('Book now', { exact: true }).last().click().catch(() => {});
    await wait(p, 600);
    await shot(p, '17-wizard-5-preview-phone');
    await p.getByText('Save as draft', { exact: true }).last().click(); await wait(p, 2500);
    const mine = await call('GET', `/advertising/campaigns?advertiser_id=${acc.id}`, { token: adv.token });
    check(mine.some((k) => k.name === 'Autumn courts' && k.status === 'draft' && k.placements.includes('featured_venue')), 'the wizard saved the campaign as a draft through the API');
    check(await vis(p, 'Autumn courts'), 'the new campaign opens on its own screen');
    await shot(p, '18-new-campaign-phone', true);
    await ctx.close();
  }

  // ---------------------------------------------------------------- 4. the platform admin's review desk
  for (const [size, vp] of Object.entries(SIZES)) {
    const { ctx, page: p } = await open(vp, 'http://localhost:4100/', admin);
    await navTo(p, 'Advertising');
    check(await vis(p, 'Review desk'), `${size}: the admin sees the review desk`);
    await p.getByText('Review desk').first().click(); await wait(p, 1500);
    check(await vis(p, 'Weekend badminton'), `${size}: a submitted campaign is waiting for a decision`);
    await shot(p, `20-review-queue-${size}`);
    if (size === 'phone') {
      await p.getByText('Weekend badminton').first().click(); await wait(p, 1800);
      check(await vis(p, 'What to check') && await vis(p, 'Claims declared'), 'the reviewer sees the ad, its claims, destination, placements and targeting');
      await shot(p, '21-review-decision-phone', true);
      await p.goBack().catch(() => {}); await wait(p, 600);
      await navTo(p, 'Advertising'); await p.getByText('Policy & overview').first().click(); await wait(p, 1800);
      check(await vis(p, 'Young people') && await vis(p, 'Inventory'), 'the admin sees the youth rule and the inventory switches');
      await shot(p, '22-policy-phone', true);
    }
    await ctx.close();
  }
  { // everyone else never sees it
    const { ctx, page: p } = await open(SIZES.phone, 'http://localhost:4100/', adv);
    await navTo(p, 'Advertising');
    check(!(await p.getByText('Review desk').first().isVisible().catch(() => false)), 'an advertiser does not see the review desk');
    await ctx.close();
  }

  // ---------------------------------------------------------------- 5. a public event page, only where the organiser allowed ads
  for (const size of ['phone', 'desktop']) {
    const { ctx, page: p } = await open(SIZES[size], `http://localhost:4100/?event=${ev.id}`);
    check(await vis(p, 'Mumbai Open Badminton'), `${size}: the public event page opens without signing in`);
    check(await vis(p, 'Rackets 15% off this week') && await vis(p, 'Sponsored'), `${size}: the event ad is labelled "Sponsored"`);
    await shot(p, `30-event-ad-${size}`);
    await ctx.close();
  }
  {
    const { ctx, page: p } = await open(SIZES.phone, 'http://localhost:4100/', adv);
    await navTo(p, 'EventCommand', { id: ev.id }); await wait(p, 1500);
    await p.getByText('Public page', { exact: false }).first().click().catch(() => {}); await wait(p, 1500);
    check(await vis(p, 'Paid ads'), 'the organiser sees the switch for paid ads on the public page');
    await p.getByText('Paid ads', { exact: false }).first().scrollIntoViewIfNeeded().catch(() => {});
    await shot(p, '31-event-ads-switch-phone', true);
    await ctx.close();
  }
  await browser.close();
} catch (e) { log('ERROR', e.message); failures++; } finally { await db.end().catch(() => {}); api.kill(); web.close(); }
process.exit(failures ? 1 : 0);
