// A signed-in person can see the plans that fit their role, take one, pay for it through the hosted checkout, and the plan then really changes
// what they can do (event organiser tools). Every test creates its own people and data; the card provider is a local stand-in.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const fake = { sessions: {}, n: 0 };
const provider = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.url === '/v1/checkout/sessions' && req.method === 'POST') {
    const f = new URLSearchParams(raw); const id = `cs_${++fake.n}`;
    fake.sessions[id] = { id, amount_total: Number(f.get('line_items[0][price_data][unit_amount]')), currency: f.get('line_items[0][price_data][currency]'), payment_status: 'unpaid', payment_intent: `pi_${fake.n}` };
    return send(200, { id, url: `https://checkout.stripe.test/${id}` });
  }
  if (req.url.startsWith('/v1/checkout/sessions/')) { const s = fake.sessions[req.url.split('/').pop()]; return s ? send(200, s) : send(404, { error: { message: 'no such session' } }); }
  send(404, {});
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
Object.assign(process.env, {
  STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_API_BASE: `http://127.0.0.1:${provider.address().port}`, APP_URL: 'http://app.test', CORS_ORIGINS: 'http://app.test',
  PLATFORM_ADMIN_EMAILS: 'rraja.edge@gmail.com,rrajas1978@icloud.com',
});
const { pool, start, stop, call, ok, signup } = await import('./tender-helpers.js');

before(start);
after(async () => { provider.close(); await stop(); });

let adminToken;
const planKeys = (offers) => offers.products.flatMap((p) => p.plans.map((pl) => pl.key));
const payFor = async (u, subId) => {   // hosted checkout by `u`, settled by the provider stand-in
  const r = ok(await call('POST', '/payments', { token: u.token, body: { purpose_type: 'commercial_subscription', purpose_id: subId, provider: 'stripe', return_url: 'http://app.test/' } }), 201);
  const s = fake.sessions[r.checkout_url.split('/').pop()]; s.payment_status = 'paid';
  return { pay: r, session: s, confirm: ok(await call('POST', `/payments/${r.id}/confirm`, { token: u.token, body: {} })) };
};

test('plans on offer follow the role and the kind of account; outsiders get 404', async () => {
  const reg = ok(await call('POST', '/auth/register', { body: { handle: 'boss_one', display_name: 'boss', email: 'rraja.edge@gmail.com', password: 'correct-horse-battery', roles: ['athlete'] } }), 201);
  await pool.query("UPDATE users SET roles = '{athlete,admin,platform_admin}' WHERE id = $1", [reg.user.id]);
  const admin = { token: reg.token }; adminToken = reg.token;
  ok(await call('POST', '/admin/commercial/import', { token: admin.token, body: { source: 'india_launch' } }));

  const organiser = await signup('org', ['organizer']), athlete = await signup('ath', ['athlete']);
  const o = ok(await call('GET', `/commercial/offers?subject_type=user&subject_id=${organiser.id}`, { token: organiser.token }));
  assert.ok(planKeys(o).includes('organiser_pro'), 'an event organiser is offered Organiser Pro');
  assert.ok(!planKeys(o).includes('athlete_pro') && !planKeys(o).includes('club_pro'), 'not the athlete or club plans');
  const a = ok(await call('GET', `/commercial/offers?subject_type=user&subject_id=${athlete.id}`, { token: athlete.token }));
  assert.ok(planKeys(a).includes('athlete_pro') && !planKeys(a).includes('organiser_pro'));
  assert.equal((await call('GET', `/commercial/offers?subject_type=user&subject_id=${athlete.id}`, { token: organiser.token })).status, 404, 'someone else’s account is not leaked');

  const ev = ok(await call('POST', '/events', { token: organiser.token, body: { name: 'Plans Cup', sport: 'basketball' } }), 201);
  const e = ok(await call('GET', `/commercial/offers?subject_type=event&subject_id=${ev.id}`, { token: organiser.token }));
  assert.deepEqual(planKeys(e).sort(), ['event_basic', 'event_business'], 'an event is offered the event plans only');
});

test('paid plan: pending until the provider confirms, then it is active and its entitlements apply; the event tools are gated by the plan', async () => {
  const organiser = await signup('host', ['organizer']);
  const ev = ok(await call('POST', '/events', { token: organiser.token, body: { name: 'Gate Cup', sport: 'basketball' } }), 201);
  const sponsorUser = await signup('vend', ['supplier']);
  const invite = () => call('POST', `/events/${ev.id}/vendors`, { token: organiser.token, body: { kind: 'catering', vendor_user_id: sponsorUser.id } });

  const blocked = await invite();
  assert.equal(blocked.status, 402, JSON.stringify(blocked.body));
  assert.equal(blocked.body.error?.code ?? blocked.body.code, 'not_entitled');

  const sub = ok(await call('POST', '/commercial/subscriptions', { token: organiser.token, body: { subject_type: 'event', subject_id: ev.id, plan_key: 'event_business' } }), 201);
  assert.equal(sub.subscription.status, 'pending_payment');
  assert.equal(Number(sub.quote.total_minor), 99900);
  assert.equal((await invite()).status, 402, 'an unpaid plan grants nothing');
  const stranger = await signup('nosy', ['organizer']);
  assert.equal((await call('POST', '/payments', { token: stranger.token, body: { purpose_type: 'commercial_subscription', purpose_id: sub.subscription.id, provider: 'stripe', return_url: 'http://app.test/' } })).status, 403, 'only the buyer can pay it');

  const p = await payFor(organiser, sub.subscription.id);
  assert.equal(p.session.amount_total, 99900); assert.equal(p.session.currency, 'inr');
  assert.equal(p.confirm.status, 'paid');
  const acct = ok(await call('GET', `/commercial/account?subject_type=event&subject_id=${ev.id}`, { token: organiser.token }));
  assert.equal(acct.subscriptions.find((s) => s.plan_key === 'event_business').status, 'active');
  assert.ok(acct.entitlements['event.business_tools']?.enabled);
  assert.equal((await invite()).status, 201, 'Event Business opens the sponsor and vendor tools');
  assert.equal((await call('POST', '/payments', { token: organiser.token, body: { purpose_type: 'commercial_subscription', purpose_id: sub.subscription.id, provider: 'stripe', return_url: 'http://app.test/' } })).status, 409, 'a paid plan cannot be paid twice');
});

test('Organiser Pro on the person opens the tools of all their events; a free plan starts at once; cancelling an unpaid plan keeps the record', async () => {
  const organiser = await signup('pro', ['organizer']);
  const ev = ok(await call('POST', '/events', { token: organiser.token, body: { name: 'Pro Cup', sport: 'basketball' } }), 201);
  const vendor = await signup('cater', ['supplier']);
  const invite = () => call('POST', `/events/${ev.id}/vendors`, { token: organiser.token, body: { kind: 'catering', vendor_user_id: vendor.id } });
  assert.equal((await invite()).status, 402);

  const sub = ok(await call('POST', '/commercial/subscriptions', { token: organiser.token, body: { subject_type: 'user', subject_id: organiser.id, plan_key: 'organiser_pro' } }), 201);
  assert.equal(sub.subscription.status, 'pending_payment');
  ok(await call('POST', `/commercial/subscriptions/${sub.subscription.id}/cancel`, { token: organiser.token }));
  assert.equal((await pool.query('SELECT status FROM commercial_subscriptions WHERE id=$1', [sub.subscription.id])).rows[0].status, 'cancelled', 'cancelled, never deleted');

  const again = ok(await call('POST', '/commercial/subscriptions', { token: organiser.token, body: { subject_type: 'user', subject_id: organiser.id, plan_key: 'organiser_pro' } }), 201);
  await payFor(organiser, again.subscription.id);
  assert.equal((await invite()).status, 201, 'Organiser Pro covers every event the organiser runs');

  const ath = await signup('free', ['athlete']);
  const freePlan = ok(await call('POST', '/commercial/subscriptions', { token: ath.token, body: { subject_type: 'user', subject_id: ath.id, plan_key: 'athlete_free' } }), 201);
  assert.equal(freePlan.subscription.status, 'active', 'a free plan starts at once');
});

// ------------------------------------------------------------------ offers: auto-apply, stacking, codes
const today = () => new Date().toISOString().slice(0, 10);
const offer = async (body) => ok(await call('POST', '/admin/commercial/promotions', { token: adminToken, body: { starts_on: today(), kind: 'coupon', benefit: 'percent_off', discount_bp: 1000, duration_months: 1, all_price_points: true, ...body } }), 201);
const quote = (u, body) => call('POST', '/commercial/quotes', { token: u.token, body: { subject_type: 'user', subject_id: u.id, items: [{ plan_key: 'organiser_pro', billing_interval: 'monthly' }], ...body } });

test('an auto-apply offer is on the quote before checkout without any code; offers stack; the total never goes below zero', async () => {
  const u = await signup('stack', ['organizer']);
  const before = ok(await quote(u, {}), 201);
  assert.equal(Number(before.total_minor), 149900); assert.deepEqual(before.promotions, []);

  await offer({ key: 'launch_auto', name: 'Launch 10% off', kind: 'launch_offer', discount_bp: 1000, auto_apply: true });
  await offer({ key: 'code_only', name: 'Needs a code', discount_bp: 5000 });
  const auto = ok(await quote(u, {}), 201);
  assert.deepEqual(auto.promotions.map((o) => [o.key, o.auto]), [['launch_auto', true]], 'applied automatically; the code-only offer is not');
  assert.equal(Number(auto.discount_minor), 14990);

  await offer({ key: 'flat_500', name: 'Rs 500 off', benefit: 'flat_off', flat_off_minor: 50000, flat_currency: 'INR' });
  const both = ok(await quote(u, { promotion_keys: [' CODE_ONLY ', 'flat_500'] }), 201);
  assert.deepEqual(both.promotions.map((o) => o.key).sort(), ['code_only', 'flat_500', 'launch_auto'], 'codes are trimmed and case-insensitive, and everything stacks');
  assert.equal(Number(both.discount_minor), 14990 + 74950 + 50000);
  assert.equal(Number(both.total_minor), 149900 - 14990 - 74950 - 50000);

  await offer({ key: 'huge_a', name: 'Huge A', discount_bp: 8000 }); await offer({ key: 'huge_b', name: 'Huge B', discount_bp: 8000 });
  const capped = ok(await quote(u, { promotion_keys: ['huge_a', 'huge_b', 'launch_auto'] }), 201);
  assert.equal(Number(capped.total_minor), 0, 'stacked offers never take more than the price');
});

test('a code is validated: unknown, not started, ended, wrong plan, exhausted, reused', async () => {
  const u = await signup('codes', ['organizer']);
  const bad = async (key, text) => { const r = await quote(u, { promotion_keys: [key] }); assert.equal(r.status, 400, `${key}: ${JSON.stringify(r.body)}`); assert.match(JSON.stringify(r.body), text, key); };
  await bad('nope_nope', /not valid/);
  await offer({ key: 'future_one', name: 'Future', starts_on: new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10) }); await bad('future_one', /not started/);
  await offer({ key: 'old_one', name: 'Old', starts_on: '2026-01-01', ends_on: '2026-02-01' }); await bad('old_one', /ended/);
  await offer({ key: 'athlete_only', name: 'Athlete only', all_price_points: false, price_points: ['athlete_pro:annual:INR:IN'] }); await bad('athlete_only', /does not apply/);

  await offer({ key: 'one_use', name: 'First one wins', max_redemptions: 1, discount_bp: 2000 });
  const sub = ok(await call('POST', '/commercial/subscriptions', { token: u.token, body: { subject_type: 'user', subject_id: u.id, plan_key: 'organiser_pro', billing_interval: 'monthly', promotion_keys: ['one_use'] } }), 201);
  assert.deepEqual(sub.quote.promotions.map((o) => o.key).sort(), ['launch_auto', 'one_use'], 'the code and the auto offer both apply');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM commercial_subscription_promotions WHERE subscription_id=$1', [sub.subscription.id])).rows[0].n, 2, 'both redemptions are recorded');
  await bad('one_use', /already used/);
  const other = await signup('late', ['organizer']);
  const r = await quote(other, { promotion_keys: ['one_use'] });
  assert.equal(r.status, 400); assert.match(JSON.stringify(r.body), /fully redeemed/);

  ok(await call('POST', `/commercial/subscriptions/${sub.subscription.id}/cancel`, { token: u.token }));
  const again = await quote(other, { promotion_keys: ['one_use'] });
  assert.equal(again.status, 201, 'an unpaid plan that was cancelled does not burn the offer');
});

test('offer grants follow the subscription that took the offer', async () => {
  const u = await signup('grant', ['organizer']);
  await offer({ key: 'bonus_ai', name: 'Bonus AI credits', benefit: 'none', discount_bp: 0, kind: 'coupon', grants: [{ key: 'ai_credits', limit_value: 100 }] });
  const sub = ok(await call('POST', '/commercial/subscriptions', { token: u.token, body: { subject_type: 'user', subject_id: u.id, plan_key: 'organiser_pro', billing_interval: 'monthly', promotion_keys: ['bonus_ai'] } }), 201);
  await payFor(u, sub.subscription.id);
  const acct = ok(await call('GET', `/commercial/account?subject_type=user&subject_id=${u.id}`, { token: u.token }));
  assert.equal(Number(acct.entitlements.ai_credits.limit), 600, '500 from Organiser Pro + 100 from the offer');
  assert.ok(acct.sources.includes('promotion:bonus_ai'));
});
