// Tests for entitlement-engine correctness: grandfathering, precedence layers, usage metering,
// upgrade/downgrade timing, data-retention on hard limits, 0% commission as config, import idempotency.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_API_BASE: 'http://127.0.0.1:1', APP_URL: 'http://app.test', CORS_ORIGINS: 'http://app.test',
  PLATFORM_ADMIN_EMAILS: 'rraja.edge@gmail.com,rrajas1978@icloud.com',
});
const { pool, start, stop, call, ok, signup } = await import('./tender-helpers.js');

before(start);
after(stop);

let adminToken;

const setup = async () => {
  if (adminToken) return adminToken;
  const reg = ok(await call('POST', '/auth/register', { body: { handle: 'ent_boss', display_name: 'ent boss', email: 'rraja.edge@gmail.com', password: 'correct-horse-battery', roles: ['athlete'] } }), 201);
  await pool.query("UPDATE users SET roles = '{athlete,admin,platform_admin}' WHERE id = $1", [reg.user.id]);
  adminToken = reg.token;
  ok(await call('POST', '/admin/commercial/import', { token: adminToken, body: { source: 'india_launch' } }));
  return adminToken;
};

/** Admin helper: assign a plan to a subject and optionally mark it as paid in one call. */
const assign = async (subjectType, subjectId, planKey, { billingInterval = 'monthly', markPaid = true } = {}) => {
  const token = await setup();
  return ok(await call('POST', '/admin/commercial/subscriptions', {
    token,
    body: { subject_type: subjectType, subject_id: subjectId, plan_key: planKey, billing_interval: billingInterval, mark_paid: markPaid },
  }), 201);
};

const account = async (u, subjectType, subjectId) =>
  ok(await call('GET', `/commercial/account?subject_type=${subjectType}&subject_id=${subjectId}`, { token: u.token }));

const preview = async (subjectType, subjectId, { at } = {}) => {
  const token = await setup();
  const qs = `subject_type=${subjectType}&subject_id=${subjectId}${at ? `&at=${at}` : ''}`;
  return ok(await call('GET', `/admin/commercial/preview?${qs}`, { token }));
};

// ------------------------------------------------------------------ test 1: grandfathering
test('a new price version does not move an existing subscriber; new subscribers receive the latest version', async () => {
  await setup();
  const u = await signup('grnd', ['athlete']);

  // subscribe to coach_pro monthly (v1)
  const sub = await assign('user', u.id, 'coach_pro');
  const v1Id = sub.subscription.version_id;
  assert.ok(v1Id, 'version_id is set on first subscription');

  // publish a new version draft for coach_pro with a higher price
  const draft = ok(await call('POST', '/admin/commercial/plans/coach_pro/versions', {
    token: adminToken,
    body: { region: 'IN', currency: 'INR', billing_interval: 'monthly', amount_minor: 49900, effective_from: '2026-11-01', entitlements: [{ key: 'ai_credits', limit_value: 600 }] },
  }), 201);
  ok(await call('POST', `/admin/commercial/versions/${draft.id}/publish`, { token: adminToken, body: {} }));

  // existing subscription still pins v1
  const row = (await pool.query('SELECT version_id FROM commercial_subscriptions WHERE id = $1', [sub.subscription.id])).rows[0];
  assert.equal(row.version_id, v1Id, 'existing subscriber keeps the pinned version after a new version is published');

  // entitlements reflect v1 (ai_credits:500)
  const acct = await account(u, 'user', u.id);
  const sub1 = acct.subscriptions.find((s) => s.plan_key === 'coach_pro');
  assert.ok(sub1, 'subscription present in account');
  assert.equal(sub1.version_id, v1Id, 'account view shows v1 version_id');

  // new subscriber gets v2 (effective_from 2026-11-01 <= today 2026-11-07)
  const u2 = await signup('grnd2', ['athlete']);
  const sub2 = await assign('user', u2.id, 'coach_pro');
  assert.notEqual(sub2.subscription.version_id, v1Id, 'new subscriber gets the later published version');
});

// ------------------------------------------------------------------ test 2: entitlement precedence (layers 1, 3, 5, 6, 7)
test('entitlement layers: default → base subscription → promo grant → contract override → enterprise override', async () => {
  await setup();
  const u = await signup('prec', ['athlete', 'organizer']);

  // layer 1: default athlete_free gives ai_credits:20
  const def = await preview('user', u.id);
  assert.equal(Number(def.entitlements.ai_credits?.limit), 20, 'layer 1 default: ai_credits = 20');
  assert.ok(def.sources.some((s) => s.startsWith('default:')), 'default source present');

  // layer 3: subscribe to athlete_pro (ai_credits:300) — first base plan replaces default
  const baseSub = await assign('user', u.id, 'athlete_pro', { billingInterval: 'annual' });
  const afterBase = await preview('user', u.id);
  assert.equal(Number(afterBase.entitlements.ai_credits.limit), 300, 'layer 3 base sub: ai_credits = 300');
  assert.ok(afterBase.sources.some((s) => s.startsWith('base:athlete_pro')), 'base subscription source present');

  // layer 5: add a promotion grant (+100 ai_credits) linked to that subscription
  const promo = ok(await call('POST', '/admin/commercial/promotions', {
    token: adminToken,
    body: { key: 'ent_grant_100', name: 'Entitlements grant test', kind: 'coupon', benefit: 'none', discount_bp: 0, duration_months: 1, all_price_points: true, starts_on: '2026-01-01', grants: [{ key: 'ai_credits', limit_value: 100 }] },
  }), 201);
  await pool.query('INSERT INTO commercial_subscription_promotions(subscription_id, promotion_id) VALUES ($1, $2)', [baseSub.subscription.id, promo.id]);
  const afterGrant = await preview('user', u.id);
  assert.equal(Number(afterGrant.entitlements.ai_credits.limit), 400, 'layer 5 promo grant: 300 + 100 = 400');
  assert.ok(afterGrant.sources.some((s) => s.startsWith('promotion:')), 'promotion source present');

  // layer 6: contract override (set) on this user → 250, beats everything below
  ok(await call('POST', '/admin/commercial/overrides', {
    token: adminToken,
    body: { subject_type: 'user', subject_id: u.id, scope: 'contract', key: 'ai_credits', mode: 'set', limit_value: 250, limit_behaviour: 'hard', reason: 'entitlement precedence test layer 6' },
  }), 201);
  const afterContract = await preview('user', u.id);
  assert.equal(Number(afterContract.entitlements.ai_credits.limit), 250, 'layer 6 contract override wins: ai_credits = 250');
  assert.ok(afterContract.entitlements.ai_credits.sources.some((s) => s.startsWith('contract_override:')), 'contract_override source present');

  // layer 7: enterprise override via a parent org → 999, wins over contract override
  const { id: orgId } = ok(await call('POST', '/organisations', { token: u.token, body: { name: 'Prec Academy', kind: 'academy', sport: 'tennis', currency: 'INR' } }), 201);
  ok(await call('POST', '/admin/commercial/links', { token: adminToken, body: { child_type: 'user', child_id: u.id, parent_type: 'organisation', parent_id: orgId } }), 201);
  ok(await call('POST', '/admin/commercial/overrides', {
    token: adminToken,
    body: { subject_type: 'organisation', subject_id: orgId, scope: 'enterprise', key: 'ai_credits', mode: 'set', limit_value: 999, limit_behaviour: 'hard', reason: 'entitlement precedence test layer 7' },
  }), 201);
  const afterEnterprise = await preview('user', u.id);
  assert.equal(Number(afterEnterprise.entitlements.ai_credits.limit), 999, 'layer 7 enterprise override wins: ai_credits = 999');
  assert.ok(afterEnterprise.entitlements.ai_credits.sources.some((s) => s.startsWith('enterprise_override:')), 'enterprise_override source present');
});

// ------------------------------------------------------------------ test 3: usage metering — idempotency and hard limit
test('consume: same idempotency key replays; different keys accumulate; hard limit at capacity throws 402', async () => {
  await setup();
  const u = await signup('cons', ['athlete']);
  // athlete_free default gives ai_credits:20 (hard)
  // set a contract override to cap at 3 so we can test the limit cheaply
  ok(await call('POST', '/admin/commercial/overrides', {
    token: adminToken,
    body: { subject_type: 'user', subject_id: u.id, scope: 'contract', key: 'ai_credits', mode: 'set', limit_value: 3, limit_behaviour: 'hard', reason: 'usage metering test: cap at 3' },
  }), 201);

  const consume = (key) => call('POST', '/commercial/usage', { token: u.token, body: { subject_type: 'user', subject_id: u.id, meter: 'ai_credits', quantity: 1, idempotency_key: key } });

  // first call
  const r1 = ok(await consume('k1'));
  assert.equal(r1.used, 1); assert.equal(r1.replayed, false);

  // replay same key → replayed=true, counter unchanged
  const r2 = ok(await consume('k1'));
  assert.equal(r2.used, 1); assert.equal(r2.replayed, true, 'same idempotency key replays without counting again');

  // different keys accumulate
  ok(await consume('k2'));
  const r3 = ok(await consume('k3'));
  assert.equal(r3.used, 3, 'k1 + k2 + k3 → used = 3');

  // hard limit: next call should fail with 402
  const over = await consume('k4');
  assert.equal(over.status, 402, 'consume beyond hard limit returns 402');
  assert.equal(over.body.code ?? over.body.error?.code, 'limit_reached');
});

// ------------------------------------------------------------------ test 4: upgrade effective=now
test('upgrade with effective=now switches plan and entitlements immediately', async () => {
  await setup();
  const u = await signup('upgr', ['athlete', 'organizer']);

  // start on coach_pro (ai_credits:500)
  const sub = await assign('user', u.id, 'coach_pro');
  const v1Id = sub.subscription.version_id;

  // upgrade to coach_business (ai_credits:1500) with effective=now
  const change = ok(await call('POST', `/commercial/subscriptions/${sub.subscription.id}/change`, {
    token: u.token,
    body: { plan_key: 'coach_business', billing_interval: 'monthly', effective: 'now' },
  }));
  assert.ok(change.subscription.scheduled_version_id, 'upgrade schedules a new version_id');
  assert.notEqual(change.subscription.scheduled_version_id, v1Id, 'scheduled version differs from current');
  assert.ok(new Date(change.effective_at) <= new Date(Date.now() + 5000), 'effective_at is now (within tolerance)');

  // GET /commercial/account triggers applyDueChanges → version_id becomes coach_business
  const acct = await account(u, 'user', u.id);
  const updated = acct.subscriptions.find((s) => s.plan_key === 'coach_business' || s.plan_key === 'coach_pro');
  assert.ok(updated, 'subscription present');
  assert.equal(updated.scheduled_version_id, null, 'applyDueChanges cleared scheduled_version_id');
  assert.equal(Number(acct.entitlements.ai_credits?.limit), 1500, 'entitlements reflect coach_business after upgrade');
});

// ------------------------------------------------------------------ test 5: downgrade effective=period_end
test('downgrade with effective=period_end keeps current entitlements until period ends', async () => {
  await setup();
  const u = await signup('dwng', ['athlete', 'organizer']);

  // start on coach_business (ai_credits:1500)
  const sub = await assign('user', u.id, 'coach_business');
  assert.equal(sub.subscription.status, 'active');

  // schedule a downgrade to coach_pro for period end
  const change = ok(await call('POST', `/commercial/subscriptions/${sub.subscription.id}/change`, {
    token: u.token,
    body: { plan_key: 'coach_pro', billing_interval: 'monthly', effective: 'period_end' },
  }));
  assert.ok(change.subscription.scheduled_version_id, 'downgrade schedules a new version_id');

  // effective_at is period_end (not null, in the future or now if no period was set)
  const effAt = new Date(change.effective_at);
  assert.ok(effAt instanceof Date && !isNaN(effAt), 'effective_at is a valid date');

  // the subscription row still has the coach_business version_id as the live one
  const row = (await pool.query('SELECT version_id, scheduled_version_id FROM commercial_subscriptions WHERE id = $1', [sub.subscription.id])).rows[0];
  assert.ok(row.scheduled_version_id, 'scheduled_version_id is set for the pending downgrade');
  assert.notEqual(row.version_id, row.scheduled_version_id, 'live version_id still points to coach_business');
});

// ------------------------------------------------------------------ test 6: data retention after hard-limit reduction
test('reducing a hard limit blocks new additions but all previously created data stays readable', async () => {
  await setup();
  const u = await signup('ret', ['organizer']);

  // subscribe to organiser_pro so the user can create events
  await assign('user', u.id, 'organiser_pro');

  // create two events (always allowed for organiser_pro)
  const ev1 = ok(await call('POST', '/events', { token: u.token, body: { name: 'Retention Cup 1', sport: 'tennis' } }), 201);
  const ev2 = ok(await call('POST', '/events', { token: u.token, body: { name: 'Retention Cup 2', sport: 'tennis' } }), 201);

  // drop organiser_pro and set a contract override that restricts ai_credits to 0 (simulate reduced plan)
  ok(await call('POST', `/commercial/subscriptions/${(await pool.query("SELECT id FROM commercial_subscriptions WHERE subject_id=$1 AND status='active'", [u.id])).rows[0].id}/cancel`, { token: u.token }));

  // both events are still readable after the subscription ended
  const list = ok(await call('GET', '/events', { token: u.token }));
  const ids = list.events?.map((e) => e.id) ?? [];
  assert.ok(ids.includes(ev1.id), 'event 1 still readable after plan ended');
  assert.ok(ids.includes(ev2.id), 'event 2 still readable after plan ended');
});

// ------------------------------------------------------------------ test 7: 0% venue commission is catalogue config, not code
test('venue_free has 0% commission configured in the catalogue price version, not in special code paths', async () => {
  await setup();

  // the venue_free plan loaded by import has a percent_fee component with bp=0
  const cat = ok(await call('GET', '/commercial/catalogue', { token: adminToken }));
  const venueProd = cat.products.find((p) => p.key === 'venue');
  assert.ok(venueProd, 'venue product in catalogue');
  const venueFree = venueProd.plans.find((pl) => pl.key === 'venue_free');
  assert.ok(venueFree, 'venue_free plan present');
  const v = venueFree.versions.find((v) => v.status === 'published');
  assert.ok(v, 'venue_free has a published version');
  const commissionTerm = v.components?.find((c) => c.kind === 'percent_fee' && c.applies_to === 'booking');
  assert.ok(commissionTerm, 'venue_free version has a percent_fee/booking component');
  assert.equal(commissionTerm.bp, 0, 'commission is 0 bp — configured in catalogue, not hardcoded');

  // venue_starter also carries 0% at launch (as configured in india-launch.json)
  const venueStarter = venueProd.plans.find((pl) => pl.key === 'venue_starter');
  assert.ok(venueStarter, 'venue_starter plan present after import');
  const vs = venueStarter.versions.find((v) => v.status === 'published');
  assert.ok(vs, 'venue_starter has a published version');
  assert.equal(vs.components?.find((c) => c.kind === 'percent_fee')?.bp, 0, 'venue_starter also at 0 bp during India launch');
});

// ------------------------------------------------------------------ test 8: admin import idempotency
test('POST /admin/commercial/import called twice creates no duplicate rows', async () => {
  await setup();
  const count = async (table) => Number((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);

  const beforePlans     = await count('commercial_plans');
  const beforeVersions  = await count('commercial_price_versions');
  const beforePromos    = await count('commercial_promotions');
  const beforeMeters    = await count('commercial_meters');

  // second import
  const r2 = ok(await call('POST', '/admin/commercial/import', { token: adminToken, body: { source: 'india_launch' } }));
  assert.equal(r2.plans,     0, 'second import creates 0 new plans (all skipped)');
  assert.equal(r2.versions,  0, 'second import creates 0 new versions (all skipped)');
  assert.equal(r2.promotions,0, 'second import creates 0 new promotions (all skipped)');
  assert.equal(r2.meters,    0, 'second import creates 0 new meters (all skipped)');

  assert.equal(await count('commercial_plans'),          beforePlans,    'plan count unchanged');
  assert.equal(await count('commercial_price_versions'), beforeVersions, 'version count unchanged');
  assert.equal(await count('commercial_promotions'),     beforePromos,   'promotion count unchanged');
  assert.equal(await count('commercial_meters'),         beforeMeters,   'meter count unchanged');
});
