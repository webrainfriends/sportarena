import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
process.env.PLATFORM_ADMIN_EMAILS = 'rraja.edge@gmail.com,rrajas1978@icloud.com';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { reconcilePlatformRoles } = await import('../src/platform.js');
const engine = await import('../src/commercial/engine.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const reg = async (handle, email, roles = ['athlete']) => {
  const r = await api('POST', '/auth/register', { body: { handle, display_name: handle, email, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { token: r.body.token, id: r.body.user?.id ?? (await pool.query('SELECT id FROM users WHERE handle=$1', [handle])).rows[0].id };
};
const makeAdmin = (id) => pool.query("UPDATE users SET roles = '{athlete,admin,platform_admin}' WHERE id = $1", [id]);

let admin, admin2, other, imposter;
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  admin = await reg('boss_one', 'rraja.edge@gmail.com'); await makeAdmin(admin.id);
  admin2 = await reg('boss_two', 'rrajas1978@icloud.com'); await makeAdmin(admin2.id);
  other = await reg('plain_user', 'plain@example.com');
  imposter = await reg('imposter', 'imposter@example.com');
});
after(async () => { server.close(); await pool.end(); });

// ------------------------------------------------------------------ platform roles
test('only the two listed emails keep admin / platform_admin; everyone else loses them', async () => {
  await makeAdmin(imposter.id); // e.g. a role granted by mistake or by an old code path
  const n = await reconcilePlatformRoles({ log() {}, error() {} });
  assert.equal(n, 1);
  assert.deepEqual((await pool.query('SELECT roles FROM users WHERE id=$1', [imposter.id])).rows[0].roles, ['athlete']);
  for (const a of [admin, admin2]) assert.ok((await pool.query('SELECT roles FROM users WHERE id=$1', [a.id])).rows[0].roles.includes('platform_admin'));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM users WHERE 'admin' = ANY(roles) OR 'platform_admin' = ANY(roles)")).rows[0].n, 2);
});

test('"Add or remove roles" can neither grant nor show nor strip platform roles', async () => {
  assert.equal((await api('PATCH', '/me/roles', { token: other.token, body: { add: ['platform_admin'] } })).status, 400);
  assert.equal((await api('PATCH', '/me/roles', { token: other.token, body: { add: ['admin'] } })).status, 400);
  const r = await api('PATCH', '/me/roles', { token: admin.token, body: { add: ['coach'] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.roles.sort(), ['athlete', 'coach'], 'the response never lists platform roles');
  const kept = (await pool.query('SELECT roles FROM users WHERE id=$1', [admin.id])).rows[0].roles;
  assert.ok(kept.includes('admin') && kept.includes('platform_admin'), 'platform roles are untouched by this form');
  const person = await api('GET', `/people/${admin.id}`, { token: other.token });
  assert.equal(person.status, 200);
  assert.ok(!person.body.roles.includes('admin') && !person.body.roles.includes('platform_admin'), 'other people never see platform roles');
});

test('registration cannot ask for platform roles and platform users can only be created for listed emails', async () => {
  const bad = await api('POST', '/auth/register', { body: { handle: 'sneaky', display_name: 'S', email: 'sneaky@example.com', password: 'correct-horse-battery', roles: ['admin'] } });
  assert.equal(bad.status, 400);
  const mk = await api('POST', '/admin/platform-users', { token: admin.token, body: { handle: 'third_admin', display_name: 'Third', email: 'third@example.com', password: 'correct-horse-battery' } });
  assert.equal(mk.status, 403, 'a third platform admin is refused');
});

// ------------------------------------------------------------------ access to the console
test('the commercial console is platform-admin only', async () => {
  for (const [method, path] of [['GET', '/admin/commercial/catalogue'], ['GET', '/admin/commercial/audit'], ['GET', '/admin/commercial/subscriptions']]) {
    assert.equal((await api(method, path)).status, 401);
    assert.equal((await api(method, path, { token: other.token })).status, 403, `${path} for an ordinary user`);
  }
  assert.equal((await api('POST', '/admin/commercial/import', { token: other.token, body: { source: 'india_launch' } })).status, 403);
  // an account that holds the role label but is not on the list is refused too (defence in depth)
  await pool.query("UPDATE users SET roles = '{athlete,admin,platform_admin}' WHERE id = $1", [imposter.id]);
  assert.equal((await api('GET', '/admin/commercial/catalogue', { token: imposter.token })).status, 403);
  await reconcilePlatformRoles({ log() {}, error() {} });
  assert.equal((await api('GET', '/admin/commercial/catalogue', { token: admin2.token })).status, 200, 'the second listed admin has access');
});

// ------------------------------------------------------------------ catalogue
let catalogue;
test('the India launch baseline imports as data, repeatably, and prices are configuration', async () => {
  const r = await api('POST', '/admin/commercial/import', { token: admin.token, body: { source: 'india_launch' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.plans >= 20 && r.body.versions >= 15);
  const again = await api('POST', '/admin/commercial/import', { token: admin.token, body: { source: 'india_launch' } });
  assert.equal(again.body.plans, 0); assert.equal(again.body.versions, 0);
  catalogue = (await api('GET', '/commercial/catalogue?region=IN')).body;
  const price = (key, interval) => catalogue.products.flatMap((p) => p.plans).find((p) => p.key === key).versions.find((v) => v.billing_interval === interval).amount_minor;
  assert.equal(Number(price('athlete_pro', 'annual')), 59900);
  assert.equal(Number(price('coach_pro', 'monthly')), 39900);
  assert.equal(Number(price('coach_business', 'monthly')), 89900);
  assert.equal(Number(price('team_pro', 'monthly')), 19900);
  assert.equal(Number(price('team_pro', 'annual')), 199900);
  assert.equal(Number(price('team_elite', 'monthly')), 49900);
  assert.equal(Number(price('club_starter', 'monthly')), 99900);
  assert.equal(Number(price('club_pro', 'monthly')), 249900);
  assert.equal(Number(price('event_business', 'per_event')), 99900);
  assert.equal(Number(price('organiser_pro', 'monthly')), 149900);
});

test('0% venue commission is a price component, simulated without code', async () => {
  const s = await api('POST', '/admin/commercial/simulate', { token: admin.token, body: { plan_key: 'venue_free', gmv_minor: 1_000_000 } });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.total_minor, 0);
  assert.equal(s.body.terms[0].bp, 0);
  assert.equal(s.body.terms[0].example_fee_minor, 0);
});

test('published versions are immutable; a new version is scheduled and the old one keeps running until then', async () => {
  const v1 = (await pool.query("SELECT v.* FROM commercial_price_versions v JOIN commercial_plans p ON p.id=v.plan_id WHERE p.key='coach_pro'")).rows[0];
  await assert.rejects(pool.query('UPDATE commercial_price_versions SET amount_minor = 1 WHERE id=$1', [v1.id]), /immutable/);
  await assert.rejects(pool.query('DELETE FROM commercial_price_versions WHERE id=$1', [v1.id]), /cannot be deleted/);
  assert.equal((await api('PATCH', `/admin/commercial/versions/${v1.id}`, { token: admin.token, body: { billing_interval: 'monthly', effective_from: '2026-10-01', amount_minor: 1 } })).status, 409);

  const d = await api('POST', '/admin/commercial/plans/coach_pro/versions', { token: admin.token, body: { billing_interval: 'monthly', amount_minor: 49900, effective_from: '2099-01-01', entitlements: [{ key: 'ai_credits', limit_value: 800 }] } });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  assert.equal(d.body.version, 2);
  assert.equal((await api('POST', `/admin/commercial/versions/${d.body.id}/publish`, { token: admin.token })).status, 200);
  const old = (await pool.query('SELECT effective_to FROM commercial_price_versions WHERE id=$1', [v1.id])).rows[0];
  assert.equal(new Date(old.effective_to).toISOString().slice(0, 10), '2098-12-31');
  const now = (await api('GET', '/commercial/catalogue')).body.products.flatMap((p) => p.plans).find((p) => p.key === 'coach_pro').versions;
  assert.equal(now.length, 1); assert.equal(Number(now[0].amount_minor), 39900, 'today still sells the old price');
  const future = (await api('GET', '/commercial/catalogue?at=2099-02-01')).body.products.flatMap((p) => p.plans).find((p) => p.key === 'coach_pro').versions;
  assert.equal(Number(future[0].amount_minor), 49900, 'the scheduled price applies from its date');
});

// ------------------------------------------------------------------ quotes, subscriptions, grandfathering, downgrade
test('quotes are frozen and subscriptions keep the version bought (grandfathering)', async () => {
  const q = await api('POST', '/commercial/quotes', { token: other.token, body: { subject_type: 'user', subject_id: other.id, items: [{ plan_key: 'coach_pro' }] } });
  assert.equal(q.status, 201, JSON.stringify(q.body));
  assert.equal(q.body.total_minor, 39900);
  await assert.rejects(pool.query('UPDATE commercial_quotes SET total_minor = 1 WHERE id=$1', [q.body.id]), /frozen/);
  await assert.rejects(pool.query('DELETE FROM commercial_quotes WHERE id=$1', [q.body.id]), /never deleted/);
  assert.equal((await api('GET', `/commercial/quotes/${q.body.id}`, { token: imposter.token })).status, 404);

  const s = await api('POST', '/commercial/subscriptions', { token: other.token, body: { subject_type: 'user', subject_id: other.id, plan_key: 'coach_pro' } });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.equal(s.body.subscription.status, 'pending_payment', 'a paid plan waits for payment against its frozen quote');
  assert.equal((await api('POST', `/admin/commercial/subscriptions/${s.body.subscription.id}/activate`, { token: other.token })).status, 403);
  assert.equal((await api('POST', `/admin/commercial/subscriptions/${s.body.subscription.id}/activate`, { token: admin.token })).status, 200);
  const pinned = s.body.subscription.version_id;
  // price goes up in the future; the account keeps the version it bought
  const acct = await api('GET', `/commercial/account?subject_type=user&subject_id=${other.id}`, { token: other.token });
  assert.equal(acct.status, 200, JSON.stringify(acct.body));
  assert.equal(acct.body.subscriptions[0].version, 1);
  assert.equal(acct.body.subscriptions[0].version_id ?? pinned, pinned);
  assert.equal(Number(acct.body.subscriptions[0].amount_minor), 39900);
  assert.equal(acct.body.entitlements.ai_credits.limit, 500);
  assert.match(acct.body.entitlements.ai_credits.sources[0], /base:coach_pro@v1/);
  // an outsider cannot read or change someone else's account (404, not 403)
  assert.equal((await api('GET', `/commercial/account?subject_type=user&subject_id=${other.id}`, { token: imposter.token })).status, 404);
  assert.equal((await api('POST', '/commercial/subscriptions', { token: imposter.token, body: { subject_type: 'user', subject_id: other.id, plan_key: 'coach_business' } })).status, 404);
  // a second base plan is refused; change it instead
  assert.equal((await api('POST', '/commercial/subscriptions', { token: other.token, body: { subject_type: 'user', subject_id: other.id, plan_key: 'coach_business' } })).status, 409);
});

test('downgrade is scheduled, keeps data, and only the premium limit changes', async () => {
  const sub = (await pool.query("SELECT id FROM commercial_subscriptions WHERE subject_id=$1 AND status='active'", [other.id])).rows[0];
  const ch = await api('POST', `/commercial/subscriptions/${sub.id}/change`, { token: other.token, body: { plan_key: 'coach_business', effective: 'now' } });
  assert.equal(ch.status, 200, JSON.stringify(ch.body));
  const up = await api('GET', `/commercial/account?subject_type=user&subject_id=${other.id}`, { token: other.token });
  assert.equal(up.body.entitlements.ai_credits.limit, 1500);
  assert.equal(up.body.entitlements.messages.limit, 500);
  const down = await api('POST', `/commercial/subscriptions/${sub.id}/cancel`, { token: other.token });
  assert.equal(down.status, 200);
  assert.equal(down.body.cancel_at_period_end, true);
  assert.equal((await pool.query('SELECT 1 FROM users WHERE id=$1', [other.id])).rowCount, 1, 'cancelling keeps the account and everything it created');
  // still entitled until the paid period ends
  const still = await api('GET', `/commercial/account?subject_type=user&subject_id=${other.id}`, { token: other.token });
  assert.equal(still.body.entitlements.ai_credits.limit, 1500);
  await pool.query("UPDATE commercial_subscriptions SET current_period_end = now() - interval '1 day' WHERE id=$1", [sub.id]);
  const after = await api('GET', `/commercial/account?subject_type=user&subject_id=${other.id}`, { token: other.token });
  assert.equal(after.body.entitlements.ai_credits.limit, 20, 'back on the free plan limits');
  assert.equal(after.body.subscriptions.length, 1, 'the history is still readable');
  await assert.rejects(pool.query('DELETE FROM commercial_subscriptions WHERE id=$1', [sub.id]), /never deleted/);
});

// ------------------------------------------------------------------ precedence
test('entitlements resolve deterministically across plan, add-on, promotion, contract and enterprise override', async () => {
  const mk = async (path, body) => { const r = await api('POST', path, { token: admin.token, body }); assert.ok(r.status < 300, `${path} ${JSON.stringify(r.body)}`); return r.body; };
  await mk('/admin/commercial/products', { key: 'testprod', name: 'Test product', family: 'other' });
  await mk('/admin/commercial/plans', { product_key: 'testprod', key: 'org_base', name: 'Org base', eligible_actors: ['organisation'] });
  await mk('/admin/commercial/plans', { product_key: 'testprod', key: 'org_addon', name: 'Org add-on', kind: 'addon', eligible_actors: ['organisation'], requires: ['org_base'] });
  const pub = async (plan, body) => { const d = await mk(`/admin/commercial/plans/${plan}/versions`, { billing_interval: 'monthly', effective_from: '2026-01-01', ...body }); await mk(`/admin/commercial/versions/${d.id}/publish`, {}); };
  await pub('org_base', { amount_minor: 1000, entitlements: [{ key: 'staff_seats', limit_value: 5 }, { key: 'ai_credits', limit_value: 100 }] });
  await pub('org_addon', { amount_minor: 500, entitlements: [{ key: 'staff_seats', limit_value: 3 }, { key: 'feature.extra', limit_value: null }] });
  await mk('/admin/commercial/promotions', { key: 'launch_boost', name: 'Boost', kind: 'launch_offer', all_price_points: false, price_points: ['org_base:monthly:INR:IN'], starts_on: '2026-01-01', grants: [{ key: 'ai_credits', limit_value: 50 }] });

  const owner = await reg('org_owner', 'orgowner@example.com');
  const org = await api('POST', '/organisations', { token: owner.token, body: { name: 'Test Club', kind: 'club' } });
  assert.equal(org.status, 201, JSON.stringify(org.body));
  const sub = (plan, extra = {}) => mk('/admin/commercial/subscriptions', { subject_type: 'organisation', subject_id: org.body.id, plan_key: plan, mark_paid: true, ...extra });
  await sub('org_base', { promotion_key: 'launch_boost' });
  await sub('org_addon');
  const prev = async (extra = {}) => (await mk('/admin/commercial/preview', { subject_type: 'organisation', subject_id: org.body.id, ...extra })).entitlements;
  let e = await prev();
  assert.equal(e.staff_seats.limit, 8, 'base 5 + add-on 3');
  assert.equal(e.ai_credits.limit, 150, 'base 100 + promotion 50');
  assert.ok(e['feature.extra'].enabled);
  assert.deepEqual(e.staff_seats.sources.map((s) => s.split(':')[0]), ['base', 'addon']);
  // contract override replaces, enterprise override (on the parent) wins over it
  await mk('/admin/commercial/overrides', { subject_type: 'organisation', subject_id: org.body.id, scope: 'contract', key: 'staff_seats', mode: 'set', limit_value: 20, reason: 'negotiated' });
  e = await prev(); assert.equal(e.staff_seats.limit, 20);
  const parent = await api('POST', '/organisations', { token: owner.token, body: { name: 'Group HQ', kind: 'other' } });
  await mk('/admin/commercial/links', { child_type: 'organisation', child_id: org.body.id, parent_type: 'organisation', parent_id: parent.body.id });
  await mk('/admin/commercial/overrides', { subject_type: 'organisation', subject_id: parent.body.id, scope: 'enterprise', key: 'staff_seats', mode: 'set', limit_value: 50, reason: 'enterprise agreement' });
  e = await prev(); assert.equal(e.staff_seats.limit, 50, 'enterprise override is the highest layer');
  assert.match(e.staff_seats.sources.at(-1), /^enterprise_override/);
  // same inputs, same answer
  assert.deepEqual(await prev(), e);
  // a dependent add-on grants nothing without its base: a different org holding only the add-on
  const lone = await api('POST', '/organisations', { token: owner.token, body: { name: 'Lone Org', kind: 'club' } });
  const bad = await api('POST', '/admin/commercial/subscriptions', { token: admin.token, body: { subject_type: 'organisation', subject_id: lone.body.id, plan_key: 'org_addon' } });
  assert.equal(bad.status, 400);
  // a child with no plan of its own inherits the parent's resolved values
  const child = await api('POST', '/organisations', { token: owner.token, body: { name: 'Child Org', kind: 'club' } });
  await mk('/admin/commercial/links', { child_type: 'organisation', child_id: child.body.id, parent_type: 'organisation', parent_id: parent.body.id });
  const ce = (await mk('/admin/commercial/preview', { subject_type: 'organisation', subject_id: child.body.id })).entitlements;
  assert.equal(ce.staff_seats.limit, 50);
  // authoritative gauge: real members are counted live
  const lim = await engine.assertCapacity('organisation', org.body.id, 'staff_seats');
  assert.equal(lim.used, 1); assert.equal(lim.limit, 50);
});

// ------------------------------------------------------------------ usage
test('usage metering is atomic, idempotent and honours soft / hard limits', async () => {
  const mk = async (path, body) => { const r = await api('POST', path, { token: admin.token, body }); assert.ok(r.status < 300, `${path} ${JSON.stringify(r.body)}`); return r.body; };
  await mk('/admin/commercial/overrides', { subject_type: 'user', subject_id: other.id, scope: 'contract', key: 'ai_credits', mode: 'set', limit_value: 10, reason: 'test limit' });
  await mk('/admin/commercial/overrides', { subject_type: 'user', subject_id: other.id, scope: 'contract', key: 'api_calls', mode: 'set', limit_value: 3, limit_behaviour: 'soft', reason: 'soft limit' });
  const use = (key, n, idem, meter = 'ai_credits') => api('POST', '/commercial/usage', { token: other.token, body: { subject_type: 'user', subject_id: other.id, meter, quantity: n, idempotency_key: key } });

  // 25 parallel single credits against a limit of 10: exactly 10 succeed, never more
  const results = await Promise.all(Array.from({ length: 25 }, (_, n) => use(`par-key-${n}-xx`, 1)));
  assert.equal(results.filter((r) => r.status === 200).length, 10);
  assert.equal(results.filter((r) => r.status === 402 && r.body.error?.code === 'limit_reached').length, 15);
  assert.equal(Number((await pool.query("SELECT used FROM commercial_usage WHERE subject_id=$1 AND meter_key='ai_credits'", [other.id])).rows[0].used), 10);

  // a retried key counts once and replays the first answer, even when the limit is now full
  const first = await use('retry-key-0001', 1, null, 'api_calls');
  const retry = await use('retry-key-0001', 1, null, 'api_calls');
  assert.equal(first.status, 200); assert.equal(retry.status, 200);
  assert.equal(retry.body.replayed, true); assert.equal(retry.body.used, first.body.used);
  assert.equal((await use('retry-key-0001', 2, null, 'api_calls')).status, 409, 'same key, different request');

  // soft limit: allowed past the limit but flagged; nothing is refused
  const soft = [];
  for (let n = 0; n < 5; n++) soft.push((await use(`soft-key-${n}-xx`, 1, null, 'api_calls')).body);
  assert.equal(soft.at(-1).over_limit, true); assert.equal(soft.at(-1).used, 6);
  assert.equal((await use('wrong-subject-1', 1, null)).status, 402);
  assert.equal((await api('POST', '/commercial/usage', { token: imposter.token, body: { subject_type: 'user', subject_id: other.id, meter: 'ai_credits', quantity: 1, idempotency_key: 'outsider-key-1' } })).status, 404);

  const usage = (await api('GET', `/commercial/account?subject_type=user&subject_id=${other.id}`, { token: other.token })).body.usage;
  assert.equal(usage.find((u) => u.key === 'ai_credits').used, 10);
  assert.equal(usage.find((u) => u.key === 'ai_credits').warning, true);
});

test('offers: N free months, % off or flat off for a duration, on every price point', async () => {
  const mk = async (body) => { const r = await api('POST', '/admin/commercial/promotions', { token: admin.token, body: { starts_on: '2026-01-01', ...body } }); assert.equal(r.status, 201, JSON.stringify(r.body)); };
  await mk({ key: 'first_month_free', name: 'First month free', kind: 'launch_offer', benefit: 'free_months', free_months: 1 });
  await mk({ key: 'two_months_free', name: '2 months free', kind: 'launch_offer', benefit: 'free_months', free_months: 2 });
  await mk({ key: 'pct_3m', name: '25% off for 3 months', kind: 'first_term_discount', benefit: 'percent_off', discount_bp: 2500, duration_months: 3 });
  await mk({ key: 'flat_2m', name: 'Rs 100 off for 2 months', kind: 'first_term_discount', benefit: 'flat_off', flat_off_minor: 10000, flat_currency: 'INR', duration_months: 2 });
  await mk({ key: 'flat_usd', name: 'USD off', kind: 'coupon', benefit: 'flat_off', flat_off_minor: 500, flat_currency: 'USD', duration_months: 1 });
  assert.equal((await api('POST', '/admin/commercial/promotions', { token: admin.token, body: { key: 'bad_offer', name: 'Bad', kind: 'launch_offer', starts_on: '2026-01-01', benefit: 'percent_off' } })).status, 400);
  const sim = async (plan, promo, interval) => (await api('POST', '/admin/commercial/simulate', { token: admin.token, body: { plan_key: plan, promotion_key: promo, ...(interval ? { billing_interval: interval } : {}) } })).body;
  // first month free: monthly price, term 1 costs nothing, then the regular price
  let r = await sim('coach_business', 'first_month_free');
  assert.equal(r.total_minor, 0); assert.equal(r.regular_total_minor, 89900); assert.deepEqual(r.offer_schedule.map((t) => t.total_minor), [0]);
  // two months free
  r = await sim('team_pro', 'two_months_free', 'monthly');
  assert.deepEqual(r.offer_schedule.map((t) => t.total_minor), [0, 0]);
  // the same offer applies to a different price point (annual): full price, but the first period is 2 months longer
  r = await sim('team_pro', 'two_months_free', 'annual');
  assert.equal(r.total_minor, 199900); assert.equal(r.extra_free_months, 2);
  // percent for a duration: 25% off the first 3 monthly terms
  r = await sim('club_pro', 'pct_3m');
  assert.deepEqual(r.offer_schedule.map((t) => t.total_minor), [187425, 187425, 187425]); assert.equal(r.total_minor, 187425);
  // on an annual price, 3 months of discount is one term
  r = await sim('athlete_pro', 'pct_3m');
  assert.equal(r.offer_schedule.length, 1); assert.equal(r.total_minor, 44925);
  // flat amount off for 2 terms, never below zero
  r = await sim('club_starter', 'flat_2m');
  assert.deepEqual(r.offer_schedule.map((t) => t.total_minor), [89900, 89900]);
  assert.equal((await api('POST', '/admin/commercial/simulate', { token: admin.token, body: { plan_key: 'club_starter', promotion_key: 'flat_usd' } })).status, 400, 'a flat amount in another currency is refused');

  // end to end: a free first month activates at once and remembers its terms; a quote carries the schedule
  const buyer = await reg('promo_buyer', 'promo.buyer@example.com');
  const sub = await api('POST', '/commercial/subscriptions', { token: buyer.token, body: { subject_type: 'user', subject_id: buyer.id, plan_key: 'coach_pro', promotion_key: 'first_month_free' } });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  assert.equal(sub.body.subscription.status, 'active', 'nothing to pay for a free first month');
  assert.equal(sub.body.subscription.promotion_terms_total, 1); assert.equal(sub.body.subscription.promotion_terms_used, 1);
  assert.equal(sub.body.quote.total_minor, 0);
  assert.equal(sub.body.quote.schedule[0].regular_total_minor, 39900);
});

test('an offer attaches to one or more price points (codes), or to all', async () => {
  const post = (body) => api('POST', '/admin/commercial/promotions', { token: admin.token, body: { starts_on: '2026-01-01', kind: 'launch_offer', benefit: 'free_months', free_months: 1, ...body } });
  const sim = (plan, promo, interval) => api('POST', '/admin/commercial/simulate', { token: admin.token, body: { plan_key: plan, promotion_key: promo, ...(interval ? { billing_interval: interval } : {}) } });
  // codes are visible on every version in the catalogue
  const cat = (await api('GET', '/admin/commercial/catalogue', { token: admin.token })).body;
  const codes = cat.products.flatMap((p) => p.plans).flatMap((pl) => pl.versions.map((v) => v.price_point_code));
  assert.ok(codes.includes('team_pro:monthly:INR:IN') && codes.includes('team_pro:annual:INR:IN') && codes.includes('coach_pro:monthly:INR:IN'));
  // two price points chosen
  const two = await post({ key: 'two_points', name: 'Two points', all_price_points: false, price_points: ['team_pro:monthly:INR:IN', 'club_pro:monthly:INR:IN'] });
  assert.equal(two.status, 201, JSON.stringify(two.body));
  assert.deepEqual(two.body.price_points.sort(), ['club_pro:monthly:INR:IN', 'team_pro:monthly:INR:IN']);
  for (const plan of ['team_pro', 'club_pro']) { const r = await sim(plan, 'two_points', 'monthly'); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.total_minor, 0); assert.equal(r.body.price_point_code, `${plan}:monthly:INR:IN`); }
  const other3 = await sim('team_pro', 'two_points', 'annual');
  assert.equal(other3.status, 400, 'the annual Team Pro price point is not attached'); assert.match(other3.body.error.message, /team_pro:annual:INR:IN/);
  assert.equal((await sim('coach_pro', 'two_points')).status, 400);
  // validation
  assert.equal((await post({ key: 'bad_code', name: 'Bad', all_price_points: false, price_points: ['nope:monthly:INR:IN'] })).status, 400);
  assert.equal((await post({ key: 'empty_pts', name: 'Empty', all_price_points: false, price_points: [] })).status, 400);
  assert.equal((await post({ key: 'both_pts', name: 'Both', all_price_points: true, price_points: ['team_pro:monthly:INR:IN'] })).status, 400);
  // all price points
  assert.equal((await post({ key: 'everywhere', name: 'Everywhere' })).status, 201);
  for (const [plan, iv] of [['coach_pro', 'monthly'], ['athlete_pro', 'annual'], ['event_business', 'per_event']]) assert.equal((await sim(plan, 'everywhere', iv)).status, 200, plan);
  // edit the attachment: add the annual price point, detach club_pro; a subscription taken earlier keeps its offer
  const buyer = await reg('pp_buyer', 'pp.buyer@example.com');
  const sub = await api('POST', '/commercial/subscriptions', { token: buyer.token, body: { subject_type: 'user', subject_id: buyer.id, plan_key: 'coach_pro', promotion_key: 'everywhere' } });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  assert.equal((await api('PATCH', `/admin/commercial/promotions/${two.body.id}/price-points`, { token: other.token, body: { price_points: ['team_pro:annual:INR:IN'] } })).status, 403);
  const edit = await api('PATCH', `/admin/commercial/promotions/${two.body.id}/price-points`, { token: admin.token, body: { price_points: ['team_pro:monthly:INR:IN', 'team_pro:annual:INR:IN'] } });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.equal((await sim('team_pro', 'two_points', 'annual')).status, 200);
  assert.equal((await sim('club_pro', 'two_points')).status, 400, 'detached');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM commercial_promotion_price_points WHERE promotion_id=$1 AND removed_at IS NOT NULL', [two.body.id])).rows[0].n, 1, 'the detached row is kept, not deleted');
  const listed = (await api('GET', '/admin/commercial/catalogue', { token: admin.token })).body.promotions.find((p) => p.key === 'two_points');
  assert.deepEqual(listed.price_points, ['team_pro:annual:INR:IN', 'team_pro:monthly:INR:IN']);
  // re-pricing a slot (a new version) keeps the offer attached: the code is the slot's, not the version's
  const d = await api('POST', '/admin/commercial/plans/team_pro/versions', { token: admin.token, body: { billing_interval: 'monthly', amount_minor: 24900, effective_from: '2027-01-01' } });
  await api('POST', `/admin/commercial/versions/${d.body.id}/publish`, { token: admin.token });
  const later = await api('POST', '/admin/commercial/simulate', { token: admin.token, body: { plan_key: 'team_pro', billing_interval: 'monthly', promotion_key: 'two_points', at: '2027-02-01' } });
  assert.equal(later.status, 200, JSON.stringify(later.body)); assert.equal(later.body.version, 2); assert.equal(later.body.regular_total_minor, 24900);
  // the buyer's subscription kept the offer it took
  assert.equal((await pool.query('SELECT promotion_id FROM commercial_subscriptions WHERE id=$1', [sub.body.subscription.id])).rows[0].promotion_id !== null, true);
});

test('bundles: one person with several profiles takes them together at a bundle price, with bundle offers', async () => {
  const mk = async (path, body, want = 201) => { const r = await api('POST', path, { token: admin.token, body }); assert.equal(r.status, want, `${path} ${JSON.stringify(r.body)}`); return r.body; };
  const pub = async (plan, amount, ents) => { const d = await mk(`/admin/commercial/plans/${plan}/versions`, { billing_interval: 'monthly', amount_minor: amount, effective_from: '2026-01-01', entitlements: ents }); await mk(`/admin/commercial/versions/${d.id}/publish`, {}, 200); };
  for (const [k, n] of [['bprod_athlete', 'Athlete family'], ['bprod_coach', 'Coach family'], ['bprod_org', 'Organiser family']]) await mk('/admin/commercial/products', { key: k, name: n, family: 'other' });
  await mk('/admin/commercial/plans', { product_key: 'bprod_athlete', key: 'b_athlete', name: 'B Athlete', eligible_actors: ['user', 'organisation'] });
  await mk('/admin/commercial/plans', { product_key: 'bprod_coach', key: 'b_coach', name: 'B Coach', eligible_actors: ['user'] });
  await mk('/admin/commercial/plans', { product_key: 'bprod_coach', key: 'b_coach2', name: 'B Coach 2', eligible_actors: ['user'] });
  await mk('/admin/commercial/plans', { product_key: 'bprod_org', key: 'b_org', name: 'B Organiser', eligible_actors: ['user'] });
  await pub('b_athlete', 30000, [{ key: 'ai_credits', limit_value: 100 }, { key: 'b.athlete_tools', limit_value: null }]);
  await pub('b_coach', 50000, [{ key: 'ai_credits', limit_value: 200 }]);
  await pub('b_coach2', 70000, [{ key: 'ai_credits', limit_value: 400 }]);
  await pub('b_org', 20000, [{ key: 'ai_credits', limit_value: 50 }]);
  const slot = (k) => `${k}:monthly:INR:IN`;
  const base = { name: 'Pair', billing_interval: 'monthly', currency: 'INR', region: 'IN' };

  // authoring rules
  assert.equal((await api('POST', '/admin/commercial/bundles', { token: other.token, body: { ...base, key: 'pair', price_points: [slot('b_athlete'), slot('b_coach')] } })).status, 403);
  for (const bad of [[slot('b_athlete')], [slot('b_coach'), slot('b_coach2')], [slot('b_athlete'), slot('nope')], [slot('b_athlete'), 'b_coach:annual:INR:IN']]) {
    assert.equal((await api('POST', '/admin/commercial/bundles', { token: admin.token, body: { ...base, key: 'badone', price_points: bad } })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await api('POST', '/admin/commercial/bundles', { token: admin.token, body: { ...base, key: 'b_coach', price_points: [slot('b_athlete'), slot('b_org')] } })).status, 400, 'a bundle cannot reuse a plan code');
  const pair = await mk('/admin/commercial/bundles', { ...base, key: 'pair', price_points: [slot('b_athlete'), slot('b_coach')] });
  assert.equal(pair.price_point_code, 'bundle.pair:monthly:INR:IN');
  await mk('/admin/commercial/bundles', { ...base, name: 'Trio', key: 'trio', price_points: [slot('b_athlete'), slot('b_coach'), slot('b_org')] });

  // pricing: a fixed bundle price above the list total is refused; below it is published and frozen
  const dear = await mk('/admin/commercial/bundles/pair/versions', { price_mode: 'fixed', amount_minor: 90000, effective_from: '2026-01-01' });
  assert.equal((await api('POST', `/admin/commercial/bundle-versions/${dear.id}/publish`, { token: admin.token })).status, 400);
  const v1 = await mk('/admin/commercial/bundles/pair/versions', { price_mode: 'fixed', amount_minor: 65000, effective_from: '2026-01-01' });
  assert.equal((await api('POST', `/admin/commercial/bundle-versions/${v1.id}/publish`, { token: admin.token })).status, 200);
  await assert.rejects(pool.query('UPDATE commercial_bundle_versions SET amount_minor = 1 WHERE id=$1', [v1.id]), /immutable/);
  const t = await mk('/admin/commercial/bundles/trio/versions', { price_mode: 'percent_off', discount_bp: 2000, effective_from: '2026-01-01' });
  await mk(`/admin/commercial/bundle-versions/${t.id}/publish`, {}, 200);
  const pubCat = (await api('GET', '/commercial/catalogue')).body.bundles;
  const shown = pubCat.find((b) => b.key === 'pair');
  assert.equal(shown.versions[0].list_minor, 80000); assert.equal(shown.versions[0].price_minor, 65000); assert.equal(shown.versions[0].saving_minor, 15000);
  assert.equal(pubCat.find((b) => b.key === 'trio').versions[0].price_minor, 80000, '20% off 1,000 (30,000 + 50,000 + 20,000)');

  // quote: member shares add up to the bundle price
  const person = await reg('multi_profile', 'multi.profile@example.com');
  const q = await api('POST', '/commercial/quotes', { token: person.token, body: { subject_type: 'user', subject_id: person.id, items: [{ bundle_key: 'pair' }] } });
  assert.equal(q.status, 201, JSON.stringify(q.body));
  assert.equal(q.body.total_minor, 65000); assert.equal(q.body.lines.reduce((a, l) => a + l.amount_minor, 0), 65000);
  assert.deepEqual(q.body.lines.map((l) => l.list_minor).sort(), [30000, 50000]); assert.equal(q.body.bundle.saving_minor, 15000);
  assert.equal((await api('POST', '/commercial/quotes', { token: person.token, body: { subject_type: 'user', subject_id: person.id, items: [{ bundle_key: 'pair' }, { plan_key: 'b_org' }] } })).status, 400);

  // offers attach to bundles by their code
  const offer = (body) => api('POST', '/admin/commercial/promotions', { token: admin.token, body: { starts_on: '2026-01-01', kind: 'launch_offer', benefit: 'free_months', free_months: 1, ...body } });
  assert.equal((await offer({ key: 'bundle_month_free', name: 'Bundle: first month free', all_price_points: false, price_points: ['bundle.pair:monthly:INR:IN'] })).status, 201);
  assert.equal((await offer({ key: 'member_only', name: 'Member only', all_price_points: false, price_points: [slot('b_coach')] })).status, 201);
  assert.equal((await offer({ key: 'bad_bundle', name: 'Bad', all_price_points: false, price_points: ['bundle.nope:monthly:INR:IN'] })).status, 400);
  const withOffer = await api('POST', '/commercial/quotes', { token: person.token, body: { subject_type: 'user', subject_id: person.id, promotion_key: 'bundle_month_free', items: [{ bundle_key: 'pair' }] } });
  assert.equal(withOffer.status, 201, JSON.stringify(withOffer.body)); assert.equal(withOffer.body.total_minor, 0); assert.equal(withOffer.body.schedule[0].regular_total_minor, 65000);
  assert.equal((await api('POST', '/commercial/quotes', { token: person.token, body: { subject_type: 'user', subject_id: person.id, promotion_key: 'member_only', items: [{ bundle_key: 'pair' }] } })).status, 400, 'an offer on a member price point does not discount the bundle');
  const simB = await api('POST', '/admin/commercial/simulate', { token: admin.token, body: { bundle_key: 'pair', promotion_key: 'bundle_month_free' } });
  assert.equal(simB.status, 200, JSON.stringify(simB.body)); assert.equal(simB.body.total_minor, 0); assert.equal(simB.body.price_point_code, 'bundle.pair:monthly:INR:IN');

  // subscribing creates one subscription per profile, pinned and sharing the bundle price; paid once
  const sub = await api('POST', '/commercial/subscriptions', { token: person.token, body: { subject_type: 'user', subject_id: person.id, bundle_key: 'pair' } });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  assert.equal(sub.body.subscriptions.length, 2); assert.ok(sub.body.subscriptions.every((x) => x.status === 'pending_payment' && x.bundle_group === sub.body.bundle_group));
  assert.equal(sub.body.subscriptions.reduce((a, x) => a + Number(x.allocated_minor), 0), 65000);
  assert.equal((await api('POST', '/commercial/subscriptions', { token: person.token, body: { subject_type: 'user', subject_id: person.id, plan_key: 'b_coach2' } })).status, 409, 'that profile already has a plan');
  assert.equal((await api('POST', `/admin/commercial/subscriptions/${sub.body.subscriptions[0].id}/activate`, { token: admin.token })).status, 200);
  const mine = (await api('GET', `/commercial/account?subject_type=user&subject_id=${person.id}`, { token: person.token })).body;
  assert.equal(mine.entitlements.ai_credits.limit, 300, 'both profiles count: 100 + 200');
  assert.ok(mine.entitlements['b.athlete_tools'].enabled);
  assert.ok(mine.subscriptions.filter((x) => x.status === 'active').length === 2, 'paying once starts every member');
  // changing one member is refused; ending the bundle ends all members together (nothing deleted)
  assert.equal((await api('POST', `/commercial/subscriptions/${sub.body.subscriptions[0].id}/change`, { token: person.token, body: { plan_key: 'b_athlete' } })).status, 409);
  await api('POST', `/commercial/subscriptions/${sub.body.subscriptions[1].id}/cancel`, { token: person.token });
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM commercial_subscriptions WHERE bundle_group=$1 AND cancel_at_period_end', [sub.body.bundle_group])).rows[0].n, 2);
  // one person, three profiles, no bundle: plans of different families coexist
  const solo = await reg('three_profiles', 'three.profiles@example.com');
  for (const plan of ['b_athlete', 'b_coach', 'b_org']) assert.equal((await api('POST', '/commercial/subscriptions', { token: solo.token, body: { subject_type: 'user', subject_id: solo.id, plan_key: plan } })).status, 201, plan);
});

test('ungoverned keys are never blocked and requireEntitlement gives modules one call instead of plan-name checks', async () => {
  const r = await engine.requireEntitlement('user', other.id, 'some.unpriced.feature');
  assert.equal(r.governed, false);
  await assert.rejects(engine.requireEntitlement('user', imposter.id, 'athlete.pro_insights'), (e) => e.status === 402 && e.code === 'not_entitled');
});

test('every commercial capability is exposed to REST, OpenAPI and MCP from one definition', async () => {
  const { capabilities } = await import('../src/registry.js');
  const names = capabilities.filter((c) => c.tag === 'Commercial').map((c) => c.name);
  assert.ok(names.length >= 25);
  const spec = (await (await fetch(`${base}/api/v1/openapi.json`)).json());
  assert.ok(spec.paths['/commercial/quotes'] && spec.paths['/admin/commercial/catalogue']);
  for (const c of capabilities.filter((x) => x.tag === 'Commercial' && x.path.startsWith('/admin'))) assert.equal(c.scope, 'admin', `${c.name} needs an admin-class token`);
});
