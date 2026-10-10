import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// This suite runs with platform approvals ON (the rest of the suite switches them off to stay focused on its own module).
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp', PLATFORM_APPROVALS: 'on',
  PLATFORM_ADMIN_EMAIL: 'platform-owner@example.com', PLATFORM_ADMIN_PASSWORD: 'owner-test-pass', PLATFORM_ADMIN_HANDLE: 'platformarena',
});
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { initKeys } = await import('../src/crypto.js');
const { bootstrapPlatformOwner } = await import('../src/platform.js');
const { fromLocal, addDays } = await import('../src/booking/time.js');

let server, base, n = 0, owner;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `pt_${n}_${roles[0]}`, display_name: `Partner Test ${n}`, email: `pt${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const today = new Date().toISOString().slice(0, 10);
const at = (d, h) => fromLocal(addDays(today, d), h * 60, 'UTC').toISOString();

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  await initKeys();
  await bootstrapPlatformOwner({ log() {}, error() {} });
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  const l = must(await api('POST', '/auth/login', { body: { email: 'platform-owner@example.com', password: 'owner-test-pass' } }));
  owner = { ...l.user, token: l.token };
});
after(async () => { server.close(); await pool.end(); });

test('the platform owner is bootstrapped from the environment and is the only one who can add platform staff', async () => {
  assert.deepEqual(owner.roles.sort(), ['admin', 'platform_admin']);
  assert.equal(owner.handle, 'platformarena');
  // idempotent, never changes the password
  await bootstrapPlatformOwner({ log() {}, error() {} });
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM users WHERE 'platform_admin' = ANY(roles)")).rows[0].n, 1);
  // an ordinary account with the owner email is never promoted
  const user = await signup();
  process.env.PLATFORM_ADMIN_EMAIL = 'pt1@example.com';
  assert.equal(await bootstrapPlatformOwner({ log() {}, error() {} }), null);
  process.env.PLATFORM_ADMIN_EMAIL = 'platform-owner@example.com';
  assert.deepEqual((await api('GET', '/me', { token: user.token })).body.roles, ['athlete']);

  // nobody can self-assign platform rights
  assert.equal((await api('POST', '/auth/register', { body: { handle: 'sneaky', display_name: 'S', email: 'sneaky@example.com', password: 'correct-horse-battery', roles: ['admin'] } })).status, 400);
  assert.equal((await api('PATCH', '/me/roles', { token: user.token, body: { add: ['platform_admin'] } })).status, 400);
  assert.equal((await api('POST', '/admin/platform-users', { token: user.token, body: { handle: 'x_staff', display_name: 'X', email: 'xs@example.com', password: 'correct-horse-battery' } })).status, 403);

  const staff = must(await api('POST', '/admin/platform-users', { token: owner.token, body: { handle: 'staff_one', display_name: 'Staff One', email: 'staff1@example.com', password: 'correct-horse-battery' } }), 201);
  assert.deepEqual(staff.roles, ['admin']);
  const sl = must(await api('POST', '/auth/login', { body: { email: 'staff1@example.com', password: 'correct-horse-battery' } }));
  // platform staff can work the queues but cannot add more staff
  assert.equal((await api('GET', '/admin/partners', { token: sl.token })).status, 200);
  assert.equal((await api('POST', '/admin/platform-users', { token: sl.token, body: { handle: 'staff_two', display_name: 'S2', email: 'staff2@example.com', password: 'correct-horse-battery' } })).status, 403);
  assert.equal((await api('DELETE', `/admin/platform-users/${owner.id}`, { token: owner.token })).status, 403, 'owner account is protected');
  must(await api('DELETE', `/admin/platform-users/${staff.id}`, { token: owner.token }));
  assert.equal((await api('GET', '/admin/partners', { token: (await api('GET', '/me', { token: sl.token })).status && sl.token })).status, 403, 'removed staff lose access (roles reload from the database)');
  assert.equal((await pool.query('SELECT 1 FROM users WHERE id=$1', [staff.id])).rowCount, 1, 'the account itself is kept');
});

let mgr, partnerId, venue, court;

test('a new venue is pending: hidden, cannot self-activate, and creates a partner application', async () => {
  mgr = await signup(['venue_manager']);
  venue = must(await api('POST', '/venues', { token: mgr.token, body: { name: 'Approval Arena', city: 'Pune', timezone: 'UTC', currency: 'INR' } }), 201);
  assert.equal(venue.approval_status, 'pending');
  assert.equal(venue.active, false);
  court = must(await api('POST', `/venues/${venue.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'Court 1', hourly_rate_cents: 100000, sport: 'football' } }), 201);
  assert.equal(court.hourly_rate_cents, 100000, 'the application carries the proposed rate card');
  assert.equal(must(await api('GET', '/venues', { query: { q: 'Approval Arena' } })).length, 0, 'not searchable');
  assert.equal((await api('PATCH', `/venues/${venue.id}`, { token: mgr.token, body: { active: true } })).status, 403);

  const mine = must(await api('GET', '/me/partner', { token: mgr.token }));
  partnerId = mine.id;
  assert.equal(mine.status, 'applied');
  assert.equal(mine.venues_list[0].approval_status, 'pending');
  // only the platform team sees the queue and decides
  assert.equal((await api('GET', '/admin/venue-approvals', { token: mgr.token })).status, 403);
  const queue = must(await api('GET', '/admin/venue-approvals', { token: owner.token }));
  assert.ok(queue.some((v) => v.id === venue.id && v.resources.length === 1));
  assert.equal((await api('POST', `/admin/venues/${venue.id}/decision`, { token: mgr.token, body: { decision: 'approve' } })).status, 403);
});

test('onboarding assistant reviews the application; the partner completes details (encrypted, audit-logged)', async () => {
  const before = must(await api('GET', `/admin/partners/${partnerId}/review`, { token: owner.token }));
  assert.ok(before.missing.includes('tax id') && before.missing.includes('payout account'));
  must(await api('PATCH', `/partners/${partnerId}`, { token: mgr.token, body: { legal_name: 'Approval Sports Pvt Ltd', tax_id: '27AAAPL1234C1ZV', contact_email: 'ops@approval.example', contact_phone: '+91 90000 11111', contact_name: 'Ops', payout: { account_holder: 'Approval Sports', account_number: '000123456789' } } }));
  const raw = (await pool.query('SELECT tax_id_enc, payout_enc FROM partners WHERE id=$1', [partnerId])).rows[0];
  assert.ok(!raw.tax_id_enc.includes('27AAAPL') && !raw.payout_enc.includes('000123456789'), 'stored encrypted');
  const p = must(await api('GET', `/partners/${partnerId}`, { token: owner.token }));
  assert.equal(p.tax_id, '27AAAPL1234C1ZV');
  assert.equal(p.payout_last4, '6789');
  assert.ok(!('payout' in p) && !('payout_enc' in p));
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='read_pii' AND entity='partners' AND actor_id=$1", [owner.id])).rowCount >= 1);
  const after = must(await api('GET', `/admin/partners/${partnerId}/review`, { token: owner.token }));
  assert.ok(after.risk_score < before.risk_score);
  assert.equal(after.missing.length, 0);
  assert.equal((await api('PATCH', `/partners/${partnerId}`, { token: mgr.token, body: { checklist: { site_visit: true } } })).status, 403);
  must(await api('PATCH', `/partners/${partnerId}`, { token: owner.token, body: { checklist: { site_visit: true } } }));
  const other = await signup(['venue_manager']);
  assert.equal((await api('GET', `/partners/${partnerId}`, { token: other.token })).status, 404);
});

test('approving the venue activates the partner, takes it live and sends a customised contract', async () => {
  const r = must(await api('POST', `/admin/venues/${venue.id}/decision`, { token: owner.token, body: {
    decision: 'approve', note: 'Welcome aboard',
    contract: { terms: { commission_bp: 1000, reserve_bp: 0, settlement_cycle: 'biweekly' }, clauses: [{ title: 'Floodlights', text: 'The Partner keeps the floodlights serviced.' }] } } }));
  assert.equal(r.approval_status, 'approved');
  assert.equal(r.contract.status, 'sent');
  assert.match(r.contract.body, /10% commission/);
  assert.match(r.contract.body, /FLOODLIGHTS/);
  assert.equal(must(await api('GET', '/venues', { query: { q: 'Approval Arena' } })).length, 1, 'now searchable');
  assert.equal(must(await api('GET', `/partners/${partnerId}`, { token: owner.token })).status, 'active');
  // settlement needs an accepted contract
  assert.equal((await api('POST', '/admin/settlements', { token: owner.token, body: { venue_id: venue.id, period_end: today } })).status, 409);
  // the partner reviews and accepts the exact text
  const k = must(await api('GET', `/contracts/${r.contract.id}`, { token: mgr.token }));
  assert.equal(k.body_sha256, r.contract.body_sha256);
  const other = await signup(['venue_manager']);
  assert.equal((await api('POST', `/contracts/${r.contract.id}/response`, { token: other.token, body: { action: 'accept' } })).status, 404);
  assert.equal(must(await api('POST', `/contracts/${r.contract.id}/response`, { token: mgr.token, body: { action: 'accept' } })).status, 'active');
  // a revised version supersedes it only once accepted
  const v2 = must(await api('POST', '/admin/contracts', { token: owner.token, body: { partner_id: partnerId, venue_id: venue.id, terms: { commission_bp: 1200, reserve_bp: 0 }, send: true } }), 201);
  assert.equal(v2.version, 2);
  assert.equal(must(await api('GET', `/contracts/${r.contract.id}`, { token: mgr.token })).status, 'active');
  must(await api('POST', `/contracts/${v2.id}/response`, { token: mgr.token, body: { action: 'accept' } }));
  assert.equal(must(await api('GET', `/contracts/${r.contract.id}`, { token: mgr.token })).status, 'superseded');
  // drafts stay private to the platform
  const draft = must(await api('POST', '/admin/contracts', { token: owner.token, body: { partner_id: partnerId, venue_id: venue.id } }), 201);
  assert.equal((await api('GET', `/contracts/${draft.id}`, { token: mgr.token })).status, 404);
  must(await api('POST', `/admin/contracts/${draft.id}/terminate`, { token: owner.token, body: { reason: 'Not needed' } }));
  const preview = must(await api('POST', '/admin/contracts', { token: owner.token, body: { partner_id: partnerId, preview: true, terms: { commission_bp: 900 } } }), 201);
  assert.match(preview.body, /9% commission/);
});

test('venue price changes go to the platform; only approved prices go live, and platform pricing overrides venue pricing', async () => {
  // base rate and a peak rule are requests, not changes
  const req1 = must(await api('PATCH', `/resources/${court.id}`, { token: mgr.token, body: { hourly_rate_cents: 150000 } }));
  assert.equal(req1.pending_platform_approval, true);
  assert.equal((await pool.query('SELECT hourly_rate_cents FROM resources WHERE id=$1', [court.id])).rows[0].hourly_rate_cents, 100000, 'live price unchanged');
  const req2 = must(await api('POST', `/venues/${venue.id}/price-rules`, { token: mgr.token, body: { name: 'Evening peak', start: '18:00', end: '22:00', hourly_rate_cents: 200000 } }), 201);
  assert.equal(req2.pending_platform_approval, true);
  assert.equal(must(await api('GET', `/venues/${venue.id}/price-rules`)).rules.length, 0, 'public rate card shows only approved pricing');
  assert.equal(must(await api('GET', '/price-requests', { token: mgr.token, query: { venue_id: venue.id } })).length, 2);
  assert.equal((await api('GET', '/price-requests', { token: mgr.token })).status, 400);

  // platform counters the base-rate request, venue accepts
  assert.equal((await api('POST', `/admin/price-requests/${req1.request.id}/decision`, { token: mgr.token, body: { action: 'approve' } })).status, 403);
  must(await api('POST', `/admin/price-requests/${req1.request.id}/decision`, { token: owner.token, body: { action: 'counter', adjust: { hourly_rate_cents: 130000 }, note: 'Comparable venues charge about 1300' } }));
  assert.equal((await api('POST', `/price-requests/${req2.request.id}/response`, { token: mgr.token, body: { action: 'accept' } })).status, 409, 'nothing to accept yet');
  must(await api('POST', `/price-requests/${req1.request.id}/response`, { token: mgr.token, body: { action: 'accept' } }));
  const res = (await pool.query('SELECT hourly_rate_cents, rate_source FROM resources WHERE id=$1', [court.id])).rows[0];
  assert.deepEqual(res, { hourly_rate_cents: 130000, rate_source: 'platform' });

  // platform approves the peak rule with its own figure
  must(await api('POST', `/admin/price-requests/${req2.request.id}/decision`, { token: owner.token, body: { action: 'approve', adjust: { hourly_rate_cents: 180000 }, note: 'Adjusted' } }));
  const card = must(await api('GET', `/venues/${venue.id}/price-rules`));
  assert.equal(card.rules.length, 1);
  assert.equal(card.rules[0].hourly_rate_cents, 180000);
  assert.equal(card.rules[0].source, 'platform');

  // a legacy venue-set rule can never beat platform pricing
  await pool.query("INSERT INTO price_rules(venue_id, name, start_min, end_min, hourly_rate_cents, source, priority) VALUES ($1,'Old venue rule',1080,1320,50000,'venue',100)", [venue.id]);
  const d = must(await api('GET', `/venues/${venue.id}/availability`, { query: { date: addDays(today, 3) } }));
  const slots = JSON.stringify(d);
  assert.ok(slots.includes('180000'), 'platform peak price is what customers see');
  assert.ok(!slots.includes('"price_cents":50000'), 'venue-set rule is overridden');

  // direct platform price list + version history; venue sees the history, the public does not
  const plan = must(await api('POST', `/admin/venues/${venue.id}/pricing`, { token: owner.token, body: { base_rates: [{ resource_id: court.id, hourly_rate_cents: 120000 }], rules: [{ name: 'Weekend', weekdays: [0, 6], hourly_rate_cents: 160000 }], note: 'Weekend uplift' } }));
  assert.ok(plan.version >= 3);
  const hist = must(await api('GET', `/venues/${venue.id}/price-list-history`, { token: mgr.token }));
  assert.equal(hist[0].note, 'Weekend uplift');
  assert.equal((await api('GET', `/venues/${venue.id}/price-list-history`)).status, 401);
  // venue staff cannot rate-limit around it by editing an existing platform rule: that is a request too
  const ruleId = card.rules[0].id;
  assert.equal(must(await api('PATCH', `/price-rules/${ruleId}`, { token: mgr.token, body: { hourly_rate_cents: 1000 } })).pending_platform_approval, true);
  assert.equal((await pool.query('SELECT hourly_rate_cents FROM price_rules WHERE id=$1', [ruleId])).rows[0].hourly_rate_cents, 180000);
  assert.equal(must(await api('DELETE', `/price-rules/${ruleId}`, { token: mgr.token })).pending_platform_approval, true);
  // a new area on a live venue stays hidden until its rate is approved
  const ground = must(await api('POST', `/venues/${venue.id}/resources`, { token: mgr.token, body: { kind: 'ground', name: 'Pitch 2', hourly_rate_cents: 90000 } }), 201);
  assert.equal(ground.active, false);
  assert.equal(ground.pending_platform_approval, true);
  must(await api('POST', `/admin/price-requests/${ground.request.id}/decision`, { token: owner.token, body: { action: 'approve' } }));
  const live = (await pool.query('SELECT active, hourly_rate_cents FROM resources WHERE id=$1', [ground.id])).rows[0];
  assert.deepEqual(live, { active: true, hourly_rate_cents: 90000 });
  // timetable categories route the same way
  assert.equal(must(await api('POST', `/venues/${venue.id}/categories`, { token: mgr.token, body: { name: 'Peak', hourly_rate_cents: 250000 } }), 201).pending_platform_approval, true);
});

test('pricing assistant explains its suggestion from location, demand, rating, facilities and discounts', async () => {
  const s = must(await api('GET', `/admin/venues/${venue.id}/pricing-suggestion`, { token: owner.token }));
  assert.deepEqual(s.factors.map((f) => f.key).sort(), ['demand', 'discounts', 'facilities', 'location', 'rating']);
  assert.ok(s.resources.length >= 1 && s.suggested_rules.length >= 3);
  assert.equal((await api('GET', `/admin/venues/${venue.id}/pricing-suggestion`, { token: mgr.token })).status, 403);
});

let invoices;
test('revenue is settled per contract: platform-collected vs venue-collected, commission, no double counting', async () => {
  const fan = await signup(['athlete']), fan2 = await signup(['athlete']);
  must(await api('POST', '/reservations', { token: fan.token, body: { items: [{ resource_id: court.id, starts_at: at(1, 10), ends_at: at(1, 11) }] } }), 201);
  const ov = must(await api('POST', `/venues/${venue.id}/override-bookings`, { token: mgr.token, body: { items: [{ resource_id: court.id, starts_at: at(2, 10), ends_at: at(2, 12) }], guest_name: 'Walk-in', reason: 'Phone booking' } }), 201);
  void ov;
  invoices = (await pool.query("SELECT id, total_cents, tax_cents FROM invoices WHERE venue_id=$1 AND kind='invoice' ORDER BY issued_at", [venue.id])).rows;
  assert.ok(invoices.length >= 1);
  // one collected online (platform), the rest at the counter (venue)
  await pool.query("UPDATE invoices SET status='paid', paid_at=now() - interval '1 day', payment_method='online' WHERE id=$1", [invoices[0].id]);
  for (const inv of invoices.slice(1)) await pool.query("UPDATE invoices SET status='paid', paid_at=now() - interval '1 day', payment_method='cash' WHERE id=$1", [inv.id]);
  void fan2;

  const prev = must(await api('POST', '/admin/settlements', { token: owner.token, body: { venue_id: venue.id, period_end: today, dry_run: true } }), 201);
  assert.equal(prev.dry_run, true);
  assert.equal(prev.invoices_count, invoices.length);
  const sales = invoices.reduce((s, i) => s + i.total_cents - i.tax_cents, 0);
  assert.equal(prev.sales_cents, sales);
  assert.equal(prev.commission_cents, Math.round(sales * 0.12), 'v2 contract: 12%');
  assert.equal(prev.platform_collected_cents, invoices[0].total_cents);
  assert.equal(prev.venue_collected_cents, invoices.slice(1).reduce((s, i) => s + i.total_cents, 0));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM settlements')).rows[0].n, 0, 'dry run saves nothing');

  const s = must(await api('POST', '/admin/settlements', { token: owner.token, body: { venue_id: venue.id, period_end: today } }), 201);
  assert.equal(s.status, 'draft');
  assert.equal(s.net_payable_cents, s.platform_collected_cents - s.commission_cents - s.commission_tax_cents - s.gateway_fee_cents - s.reserve_held_cents + s.reserve_released_cents + s.adjustments_cents);
  // nothing is settled twice
  const again = must(await api('POST', '/admin/settlements', { token: owner.token, body: { venue_id: venue.id, period_end: today } }), 201);
  assert.equal(again.invoices_count, 0);
  assert.ok(again.flags.some((f) => f.code === 'empty'));
  must(await api('POST', `/admin/settlements/${again.id}/decision`, { token: owner.token, body: { action: 'void', reason: 'empty run' } }));

  // adjustments only on drafts; partner sees nothing until approval
  const adj = must(await api('POST', `/admin/settlements/${s.id}/adjustments`, { token: owner.token, body: { amount_cents: -5000, reason: 'Late cancellation penalty' } }), 201);
  assert.equal(adj.net_payable_cents, s.net_payable_cents - 5000);
  assert.equal(must(await api('GET', '/settlements', { token: mgr.token })).length, 0);
  assert.equal((await api('GET', `/settlements/${s.id}`, { token: mgr.token })).status, 404);
  must(await api('POST', `/admin/settlements/${s.id}/decision`, { token: owner.token, body: { action: 'approve' } }));
  assert.equal(must(await api('GET', '/settlements', { token: mgr.token })).length, 1);
  const stmt = must(await api('GET', `/settlements/${s.id}`, { token: mgr.token, query: { format: 'csv' } }));
  assert.match(stmt.csv, /net payable/);
  assert.equal((await api('POST', `/admin/settlements/${s.id}/adjustments`, { token: owner.token, body: { amount_cents: 1, reason: 'too late' } })).status, 409);
  assert.equal((await api('POST', `/admin/settlements/${s.id}/decision`, { token: owner.token, body: { action: 'mark_paid' } })).status, 400, 'payout reference required');
  must(await api('POST', `/admin/settlements/${s.id}/decision`, { token: owner.token, body: { action: 'mark_paid', payout_ref: 'UTR123456' } }));
  assert.equal((await api('POST', `/admin/settlements/${s.id}/decision`, { token: owner.token, body: { action: 'void', reason: 'x' } })).status, 409, 'paid is final');
});

test('voiding a draft frees its invoices to be settled again', async () => {
  const inv = (await pool.query("INSERT INTO invoices(number, venue_id, reservation_id, user_id, currency, status, total_cents, tax_cents, tax_name, tax_rate_bp, tax_inclusive, seller, lines, payment_method, paid_at) SELECT 'X-' || gen_random_uuid(), venue_id, reservation_id, user_id, currency, 'paid', 50000, 0, tax_name, tax_rate_bp, tax_inclusive, seller, lines, 'cash', now() FROM invoices WHERE venue_id=$1 AND kind='invoice' LIMIT 1 RETURNING id", [venue.id])).rows[0];
  const d = must(await api('POST', '/admin/settlements', { token: owner.token, body: { venue_id: venue.id, period_end: today } }), 201);
  assert.equal(d.invoices_count, 1);
  must(await api('POST', `/admin/settlements/${d.id}/decision`, { token: owner.token, body: { action: 'void', reason: 'recount' } }));
  const d2 = must(await api('POST', '/admin/settlements', { token: owner.token, body: { venue_id: venue.id, period_end: today, dry_run: true } }), 201);
  assert.equal(d2.invoices_count, 1, 'the invoice is settleable again');
  assert.ok((await pool.query('SELECT 1 FROM settlement_lines WHERE invoice_id=$1', [inv.id])).rowCount === 1, 'history is kept');
});

test('reports: dashboard, revenue, settlements, P&L with ledger entries, partner statement, CSV', async () => {
  const from = addDays(today, -30), to = addDays(today, 30);
  const dash = must(await api('GET', '/admin/partner-dashboard', { token: owner.token }));
  assert.equal(dash.partners.active, 1);
  assert.equal((await api('GET', '/admin/partner-dashboard', { token: mgr.token })).status, 403);
  const rev = must(await api('GET', '/admin/reports/revenue', { token: owner.token, query: { from, to, group_by: 'month', dimension: 'venue' } }));
  assert.ok(rev.rows.length >= 1 && rev.totals[0].sales_cents > 0 && rev.totals[0].estimated_commission_cents > 0);
  assert.match(must(await api('GET', '/admin/reports/revenue', { token: owner.token, query: { from, to, format: 'csv' } })).csv, /sales_cents/);
  const rep = must(await api('GET', '/admin/reports/settlements', { token: owner.token, query: { from, to } }));
  assert.ok(rep.rows.length >= 1 && rep.by_partner.length >= 1);

  must(await api('POST', '/admin/ledger', { token: owner.token, body: { entry_date: today, kind: 'cost', category: 'marketing', amount_cents: 20000, currency: 'INR', description: 'Launch campaign' } }), 201);
  must(await api('POST', '/admin/ledger', { token: owner.token, body: { entry_date: today, kind: 'revenue', category: 'subscription_fee', amount_cents: 50000, currency: 'INR', partner_id: partnerId } }), 201);
  const pnl = must(await api('GET', '/admin/reports/pnl', { token: owner.token, query: { from, to } }));
  const inr = pnl.by_currency.find((x) => x.currency === 'INR');
  assert.ok(inr.revenue.commission_cents > 0);
  assert.equal(inr.costs.entries[0].category, 'marketing');
  assert.equal(inr.net_profit_cents, inr.revenue.total_cents - inr.costs.total_cents);
  const st = must(await api('GET', `/partners/${partnerId}/statement`, { token: mgr.token, query: { from, to } }));
  assert.ok(st.venues[0].sales_cents > 0 && st.venues[0].paid_cents !== 0);
  assert.equal((await api('GET', '/admin/ledger', { token: mgr.token })).status, 403);
});

test('suspending pauses venues; offboarding is blocked by upcoming bookings; nothing is deleted', async () => {
  must(await api('POST', `/admin/partners/${partnerId}/decision`, { token: owner.token, body: { action: 'suspend', reason: 'Compliance review' } }));
  assert.equal((await pool.query('SELECT active, paused_by_partner FROM venues WHERE id=$1', [venue.id])).rows[0].active, false);
  assert.equal((await api('PATCH', `/venues/${venue.id}`, { token: mgr.token, body: { active: true } })).status, 403, 'the owner cannot un-pause');
  assert.equal(must(await api('GET', '/venues', { query: { q: 'Approval Arena' } })).length, 0);
  must(await api('POST', `/admin/partners/${partnerId}/decision`, { token: owner.token, body: { action: 'reinstate', reason: 'Cleared' } }));
  assert.equal((await pool.query('SELECT active FROM venues WHERE id=$1', [venue.id])).rows[0].active, true);

  assert.equal((await api('POST', `/admin/partners/${partnerId}/decision`, { token: owner.token, body: { action: 'offboard', reason: 'Leaving' } })).status, 409, 'upcoming bookings exist');
  await pool.query("UPDATE bookings SET status='cancelled' WHERE status='confirmed' AND starts_at > now()");
  const off = must(await api('POST', `/admin/partners/${partnerId}/decision`, { token: owner.token, body: { action: 'offboard', reason: 'Leaving' } }));
  assert.equal(off.status, 'offboarded');
  assert.equal(off.final_settlement_due, true);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM partner_contracts WHERE partner_id=$1 AND status='active'", [partnerId])).rows[0].n, 0);
  for (const t of ['partners', 'venues', 'bookings', 'settlements', 'partner_contracts']) assert.ok((await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n >= 1, `${t} kept`);
  const tl = must(await api('GET', `/partners/${partnerId}`, { token: owner.token })).timeline.map((e) => e.action);
  assert.ok(['offboard', 'suspend', 'reinstate'].every((a) => tl.includes(a)));
});

test('the platform module is exposed through REST, OpenAPI and MCP from the same definitions', async () => {
  const spec = (await (await fetch(`${base}/api/v1/openapi.json`)).json());
  const ops = Object.values(spec.paths).flatMap(Object.values).map((o) => o.operationId);
  for (const name of ['onboard_partner', 'decide_venue', 'decide_price_request', 'apply_pricing_plan', 'generate_contract', 'generate_settlement', 'pnl_report', 'create_platform_user']) assert.ok(ops.includes(name), name);
});
