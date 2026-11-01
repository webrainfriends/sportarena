import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { config } = await import('../src/config.js');
const { settle } = await import('../src/payments/service.js');
const { syncCoachSubscriptions } = await import('../src/coach-subscriptions.js');
const { runCollections } = await import('../src/collections.js');
const { capabilities } = await import('../src/capabilities/index.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const signup = async (roles = ['athlete'], extra = {}) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `cs_${n}_${roles[0]}`, display_name: `Person ${n}`, email: `cs${n}@example.com`, password: 'correct-horse-battery', roles, dob: yearsAgo(30), ...extra } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const inHours = (h) => new Date(Date.now() + h * 36e5).toISOString();
const evidence = { reference: 'https://example.com/birth-certificate-ref-123', label: 'Birth certificate' };
async function verifiedGuardian(parent, child) {
  const l = must(await api('POST', '/youth/guardian-links', { token: parent.token, body: { guardian_id: parent.id, child_id: child.id, relationship: 'parent' } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: child.token, body: { accept: true } }));
  must(await api('POST', `/youth/guardian-links/${l.id}/evidence`, { token: parent.token, body: { evidence } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Documents match' } }));
}
const monthly = async (coach, body = {}) => {
  must(await api('POST', '/me/sport-profiles', { token: coach.token, body: { sport: 'football', role: 'coach', level: 'pro', hourly_rate_cents: 70000 } }), 201);
  return must(await api('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'Monthly mentoring', sport: 'football', audience: 'individual', unit: 'month', price_cents: 400000, sessions_included: 4, rollover_max: 2, grace_days: 3, ...body } }), 201);
};
const realFetch = globalThis.fetch;
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('cs_root','cs_root','{admin}','x','x','cs_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  config.payments.stripe.secretKey = 'sk_test_x'; config.payments.stripe.base = 'http://stripe.invalid';
  globalThis.fetch = async (url, init) => String(url).startsWith('http://stripe.invalid')
    ? new Response(JSON.stringify({ id: 're_1', status: 'succeeded' }), { status: 200, headers: { 'content-type': 'application/json' } }) : realFetch(url, init);
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { globalThis.fetch = realFetch; server.close(); await pool.end(); });

/** Settle a canonical payment for one period exactly as the provider webhook would. */
async function pay(periodId, user, { amount } = {}) {
  const per = (await pool.query('SELECT * FROM user_plans WHERE id=$1', [periodId])).rows[0];
  const p = (await pool.query("INSERT INTO payments(payer_id, provider, purpose_type, purpose_id, amount_cents, currency, status, provider_ref) VALUES ($1,'stripe','coach_subscription_period',$2,$3,$4,'pending',$5) RETURNING *", [user.id, periodId, amount ?? per.price_cents, per.currency, `cs_${Math.random()}`])).rows[0];
  await pool.query("UPDATE payments SET provider_payment_ref='pi_test' WHERE id=$1", [p.id]);
  return settle(p.id, { paid: true, amount: Number(p.amount_cents), currency: p.currency, paymentRef: 'pi_test' });
}
const periods = async (subId) => (await pool.query('SELECT * FROM user_plans WHERE subscription_id=$1 ORDER BY period_no', [subId])).rows;
const subRow = async (id) => (await pool.query('SELECT * FROM coach_subscriptions WHERE id=$1', [id])).rows[0];
/** Move a subscription's clock back by `days` so the next sweep sees a later "now" (the worker uses the real clock). */
const ageBy = async (subId, days) => pool.query(
  `UPDATE user_plans SET starts_at = starts_at - make_interval(days => $2), expires_at = expires_at - make_interval(days => $2), due_on = due_on - $2::int, created_at = created_at - make_interval(days => $2) WHERE subscription_id=$1`, [subId, days]);
async function subscribe(coach, athlete, extra = {}) {
  const card = extra.card ?? await monthly(coach);
  const r = must(await api('POST', '/coach-subscriptions', { token: (extra.by ?? athlete).token, body: { rate_card_id: card.id, ...(extra.athlete_id ? { athlete_id: extra.athlete_id } : {}) } }), 201);
  return { card, ...r };
}

test('the subscription capabilities are REST routes, OpenAPI operations and MCP tools from one definition', () => {
  const names = capabilities.filter((c) => c.tag === 'Coaching subscriptions').map((c) => c.name);
  for (const x of ['subscribe_to_coach', 'my_coach_subscriptions', 'pause_coach_subscription', 'resume_coach_subscription', 'cancel_coach_subscription', 'coach_subscribers']) assert.ok(names.includes(x), x);
});

test('a monthly card is for one athlete and needs a price; subscribing creates month one waiting for payment', async () => {
  const coach = await signup(['coach']); const athlete = await signup();
  must(await api('POST', '/me/sport-profiles', { token: coach.token, body: { sport: 'football', role: 'coach', level: 'pro', hourly_rate_cents: 70000 } }), 201);
  assert.equal((await api('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'Team retainer', sport: 'football', audience: 'team', unit: 'month', price_cents: 100000, duration_min: 60 } })).status, 400);
  const { subscription, period, pay: payRef } = await subscribe(coach, athlete);
  assert.equal(subscription.status, 'active'); assert.equal(period.status, 'awaiting_payment'); assert.equal(Number(period.price_cents), 400000);
  assert.deepEqual(payRef, { purpose_type: 'coach_subscription_period', purpose_id: period.id });
  const again = await api('POST', '/coach-subscriptions', { token: athlete.token, body: { rate_card_id: subscription.rate_card_id } });
  assert.equal(again.status, 409, 'one live subscription per athlete per card');
  assert.equal((await api('POST', '/coach-subscriptions', { token: coach.token, body: { rate_card_id: subscription.rate_card_id } })).status, 400, 'not to yourself');
});

test('paying month one activates it with the included sessions; paying the same period twice charges nothing twice', async () => {
  const coach = await signup(['coach']); const athlete = await signup();
  const { subscription, period } = await subscribe(coach, athlete);
  const r1 = await pay(period.id, athlete);
  assert.equal(r1.status, 'paid');
  const [p1] = await periods(subscription.id);
  assert.equal(p1.status, 'active'); assert.equal(p1.sessions_left, 4);
  assert.ok(new Date(p1.expires_at) > new Date(Date.now() + 27 * 864e5), 'about a month');
  const r2 = await pay(period.id, athlete);                 // a duplicate payment for the same period
  assert.equal(r2.status, 'refunded', 'the second payment is refunded, never kept');
  assert.equal((await periods(subscription.id)).length, 1);
  assert.equal(Number((await pool.query("SELECT count(*) FROM payments WHERE purpose_id=$1 AND status='paid'", [period.id])).rows[0].count), 1);
});

test('idempotency: running the billing sweep twice (or at once) raises exactly one next period', async () => {
  const coach = await signup(['coach']); const athlete = await signup();
  const { subscription, period } = await subscribe(coach, athlete);
  await pay(period.id, athlete);
  await ageBy(subscription.id, 25);                         // five days before the month ends: inside the raise window
  await Promise.all([syncCoachSubscriptions(), syncCoachSubscriptions(), syncCoachSubscriptions()]);
  await syncCoachSubscriptions();
  const ps = await periods(subscription.id);
  assert.equal(ps.length, 2); assert.equal(ps[1].status, 'awaiting_payment'); assert.equal(ps[1].period_no, 2);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE kind='coach_sub_renewal' AND user_id=$1", [athlete.id])).rows[0].n, 1, 'told once');
  await assert.rejects(pool.query("INSERT INTO user_plans(coach_id, subscription_id, period_no, user_id, kind, name, price_cents, currency, duration_days) VALUES ($1,$2,2,$3,'pass','x',1,'INR',30)", [coach.id, subscription.id, athlete.id]), /user_plans_sub_period/, 'the database itself refuses a second period 2');
  // paying it continues from the end of month one with no gap
  await pay(ps[1].id, athlete);
  const after2 = await periods(subscription.id);
  assert.equal(after2[1].status, 'active');
  assert.equal(new Date(after2[1].starts_at).toISOString(), new Date(after2[0].expires_at).toISOString());
});

test('failed payment: past due with notices, grace, then the entitlement lapses and nothing is deleted; paying inside grace keeps it', async () => {
  const coach = await signup(['coach']); const athlete = await signup();
  const a = await subscribe(coach, athlete);
  await pay(a.period.id, athlete);
  await ageBy(a.subscription.id, 25); await syncCoachSubscriptions();
  await ageBy(a.subscription.id, 6);                        // month one ended a day ago: due, in grace
  await syncCoachSubscriptions(); await syncCoachSubscriptions();
  await runCollections({ ownerId: coach.id }); await runCollections({ ownerId: coach.id });
  assert.equal((await subRow(a.subscription.id)).status, 'past_due');
  // the payer's reminder now comes from the collections engine, once, and the old sweep reminder is gone (no double notices)
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE kind='collections_reminder' AND user_id=$1", [athlete.id])).rows[0].n, 1, 'payer told once');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE kind='coach_sub_past_due' AND user_id=$1", [athlete.id])).rows[0].n, 0, 'sweep no longer sends its own');
  assert.ok((await pool.query("SELECT 1 FROM notifications WHERE kind='coach_sub_past_due_coach' AND user_id=$1", [coach.id])).rowCount, 'coach told');
  const open = (await periods(a.subscription.id))[1];
  await pay(open.id, athlete);                              // paying inside grace restores good standing
  assert.equal((await subRow(a.subscription.id)).status, 'active');
  // a second subscriber who never pays
  const b = await subscribe(coach, await signup());
  const bAthlete = (await pool.query('SELECT payer_id FROM coach_subscriptions WHERE id=$1', [b.subscription.id])).rows[0].payer_id;
  await pool.query("UPDATE users SET id=id WHERE id=$1", [bAthlete]);
  const payerB = { id: bAthlete };
  await pay(b.period.id, payerB);
  await ageBy(b.subscription.id, 25); await syncCoachSubscriptions();
  await ageBy(b.subscription.id, 10);                       // 4 days past due, grace is 3
  await syncCoachSubscriptions(); await syncCoachSubscriptions();
  const sb = await subRow(b.subscription.id);
  assert.equal(sb.status, 'lapsed'); assert.ok(sb.lapsed_at);
  const ps = await periods(b.subscription.id);
  assert.equal(ps.length, 2, 'rows are kept'); assert.equal(ps[1].status, 'cancelled'); assert.equal(ps[0].status, 'active');
  assert.ok((await pool.query("SELECT 1 FROM notifications WHERE kind='coach_sub_lapsed' AND user_id=$1", [bAthlete])).rowCount);
  // the lapsed month cannot be paid into
  const late = await api('POST', '/payments', { token: (await signup()).token, body: { provider: 'stripe', purpose_type: 'coach_subscription_period', purpose_id: ps[1].id } });
  assert.ok([403, 404, 409].includes(late.status));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM coach_subscriptions WHERE id=$1', [b.subscription.id])).rows[0].n, 1);
});

test('an unpaid first month simply expires without charging anyone', async () => {
  const coach = await signup(['coach']); const athlete = await signup();
  const a = await subscribe(coach, athlete);
  await ageBy(a.subscription.id, 4); await syncCoachSubscriptions();
  assert.equal((await subRow(a.subscription.id)).status, 'cancelled');
  assert.equal((await periods(a.subscription.id))[0].status, 'cancelled');
  const again = await api('POST', '/coach-subscriptions', { token: athlete.token, body: { rate_card_id: a.card.id } });
  assert.equal(again.status, 201, 'they may subscribe again later');
});

test('included sessions are redeemed on a hire, run out, come back on cancel, and roll over up to the cap', async () => {
  const coach = await signup(['coach']); const athlete = await signup();
  const a = await subscribe(coach, athlete);
  await pay(a.period.id, athlete);
  const book = (h, extra = {}) => api('POST', '/hires', { token: athlete.token, body: { coach_id: coach.id, sport: 'football', starts_at: inHours(h), duration_min: 60, subscription_id: a.subscription.id, ...extra } });
  const h1 = must(await book(48), 201);
  assert.equal(h1.payment_status, 'not_required'); assert.equal(Number(h1.total_cents), 0);
  assert.equal((await periods(a.subscription.id))[0].sessions_left, 3);
  assert.equal((await api('POST', '/hires', { token: (await signup()).token, body: { coach_id: coach.id, sport: 'football', starts_at: inHours(60), duration_min: 60, subscription_id: a.subscription.id } })).status, 404, 'someone else cannot spend it');
  must(await api('PATCH', `/hires/${h1.id}`, { token: athlete.token, body: { status: 'cancelled' } }));
  assert.equal((await periods(a.subscription.id))[0].sessions_left, 4, 'the session came back');
  assert.notEqual((await api('PATCH', `/hires/${h1.id}`, { token: coach.token, body: { status: 'cancelled' } })).status, 200, 'already final');
  assert.equal((await periods(a.subscription.id))[0].sessions_left, 4, 'and only once');
  for (const h of [50, 52, 54, 56]) must(await book(h), 201);
  const none = await book(58);
  assert.equal(none.status, 409); assert.equal(none.body.error.details.code, 'subscription_empty');
  // next month: unused sessions roll over up to the cap (2 of 4)
  const b = await subscribe(coach, await signup());
  const payerB = (await pool.query('SELECT payer_id AS id FROM coach_subscriptions WHERE id=$1', [b.subscription.id])).rows[0];
  await pay(b.period.id, payerB);
  await ageBy(b.subscription.id, 25); await syncCoachSubscriptions();
  const p2 = (await periods(b.subscription.id))[1];
  await pay(p2.id, payerB);
  await ageBy(b.subscription.id, 6); await syncCoachSubscriptions();
  const ps = await periods(b.subscription.id);
  assert.equal(ps[1].carried_sessions, 2); assert.equal(ps[1].sessions_left, 6); assert.equal(ps[0].sessions_left, 2);
  await syncCoachSubscriptions();
  assert.equal((await periods(b.subscription.id))[1].sessions_left, 6, 'carried once, not on every sweep');
});

test('pause stops new months; resume starts again; cancel runs to the end of the paid month and keeps every row', async () => {
  const coach = await signup(['coach']); const athlete = await signup(); const other = await signup();
  const a = await subscribe(coach, athlete);
  await pay(a.period.id, athlete);
  assert.equal((await api('POST', `/coach-subscriptions/${a.subscription.id}/pause`, { token: other.token })).status, 404, 'strangers learn nothing');
  must(await api('POST', `/coach-subscriptions/${a.subscription.id}/pause`, { token: athlete.token }));
  await ageBy(a.subscription.id, 25); await syncCoachSubscriptions();
  assert.equal((await periods(a.subscription.id)).length, 1, 'no month is raised while paused');
  must(await api('POST', `/coach-subscriptions/${a.subscription.id}/resume`, { token: athlete.token }));
  assert.equal((await periods(a.subscription.id)).length, 2, 'resuming raises the next month');
  await pay((await periods(a.subscription.id))[1].id, athlete);
  must(await api('POST', `/coach-subscriptions/${a.subscription.id}/cancel`, { token: athlete.token }));
  const s = await subRow(a.subscription.id);
  assert.equal(s.cancel_at_period_end, true); assert.equal(s.status, 'active', 'still active until the paid month ends');
  await ageBy(a.subscription.id, 70); await syncCoachSubscriptions();
  assert.equal((await subRow(a.subscription.id)).status, 'cancelled');
  assert.equal((await periods(a.subscription.id)).length, 2, 'nothing deleted');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM payments WHERE purpose_type=$1', ['coach_subscription_period'])).rows[0].n >= 2, true);
});

test('a guardian subscribes and pays for a young athlete; without a verified guardian nobody can', async () => {
  const coach = await signup(['coach']); const parent = await signup(); const stranger = await signup();
  const kid = await signup(['athlete'], { dob: yearsAgo(12) });
  const card = await monthly(coach);
  assert.equal((await api('POST', '/coach-subscriptions', { token: stranger.token, body: { rate_card_id: card.id, athlete_id: kid.id } })).status, 404);
  await verifiedGuardian(parent, kid);
  assert.equal((await api('POST', '/coach-subscriptions', { token: kid.token, body: { rate_card_id: card.id } })).status, 403, 'a young person with a guardian cannot subscribe alone');
  const noConsent = await api('POST', '/coach-subscriptions', { token: parent.token, body: { rate_card_id: card.id, athlete_id: kid.id } });
  assert.equal(noConsent.status, 409); assert.equal(noConsent.body.error.details.code, 'guardian_consent_required');
  must(await api('POST', `/youth/children/${kid.id}/consents`, { token: parent.token, body: { purpose: 'coaching' } }), 201);
  const r = must(await api('POST', '/coach-subscriptions', { token: parent.token, body: { rate_card_id: card.id, athlete_id: kid.id } }), 201);
  assert.equal(r.subscription.payer_id, parent.id); assert.equal(r.subscription.athlete_id, kid.id);
  await pay(r.period.id, parent);
  const mine = must(await api('GET', '/me/coach-subscriptions', { token: parent.token }));
  assert.equal(mine.length, 1); assert.equal(mine[0].athlete_name, kid.display_name);
  assert.equal((await api('GET', '/me/coach-subscriptions', { token: stranger.token })).body.length, 0);
});

test('the coach sees subscribers and MRR, and revenue reconciles to canonical payments', async () => {
  const coach = await signup(['coach']); const a1 = await signup(); const a2 = await signup(); const a3 = await signup();
  const card = await monthly(coach);
  const s1 = await subscribe(coach, a1, { card }); const s2 = await subscribe(coach, a2, { card }); await subscribe(coach, a3, { card });
  await pay(s1.period.id, a1); await pay(s2.period.id, a2);
  must(await api('POST', `/coach-subscriptions/${s2.subscription.id}/cancel`, { token: a2.token }));
  const rep = must(await api('GET', '/coach/subscriptions', { token: coach.token }));
  assert.equal(Number(rep.mrr[0].mrr_cents), 400000, 'only the paying, non-cancelling subscriber is recurring revenue'); assert.equal(rep.mrr[0].subscribers, 1);
  assert.equal(rep.items.length, 3); assert.equal(rep.counts.active, 3);
  const rv = rep.revenue[0];
  assert.equal(Number(rv.billed_cents), 800000); assert.equal(Number(rv.paid_cents), 800000); assert.equal(rv.reconciled, true); assert.equal(rv.periods_paid, 2);
  const fin = await pool.query("SELECT coalesce(sum(amount_cents),0)::bigint AS s FROM payments WHERE purpose_type='coach_subscription_period' AND status='paid' AND payer_id = ANY($1)", [[a1.id, a2.id]]);
  assert.equal(String(fin.rows[0].s), '800000', 'the report equals the canonical payments');
  assert.equal((await api('GET', '/coach/subscriptions', { token: a1.token })).status, 403, 'coach only');
});

test('a late subscription month is a case in the collections desk: same states, one reminder, coach-only, closes on payment (issue #681)', async () => {
  const coach = await signup(['coach']); const athlete = await signup(); const other = await signup(['coach']);
  const a = await subscribe(coach, athlete);
  await pay(a.period.id, athlete);
  await ageBy(a.subscription.id, 25); await syncCoachSubscriptions();
  await ageBy(a.subscription.id, 6);                                  // month one ended yesterday: month two is due, inside the card's 3 grace days
  await syncCoachSubscriptions();
  for (let i = 0; i < 3; i++) { await runCollections({ ownerId: coach.id }); await syncCoachSubscriptions(); }   // repeated runs add nothing
  const q = (token, extra = '') => api('GET', `/collections/cases?coach_id=${coach.id}${extra}`, { token });
  const list = must(await q(coach.token));
  assert.equal(list.owner.type, 'coach'); assert.equal(list.items.length, 1);
  const it = list.items[0];
  assert.equal(it.source_type, 'coach_subscription_period'); assert.equal(it.kind, 'coach_subscription'); assert.equal(it.state, 'due');
  assert.equal(it.programme, 'Monthly mentoring'); assert.equal(Number(it.balance_minor), 400000); assert.equal(list.totals[0].balance_minor, 400000);
  // only that coach (or an admin) sees the desk; everyone else gets a 404
  assert.equal((await q(athlete.token)).status, 404); assert.equal((await q(other.token)).status, 404); must(await q(admin.token));
  // no double notifications: the engine sends one reminder, the old sweep reminder is gone
  const count = async (kind) => (await pool.query('SELECT count(*)::int AS n FROM notifications WHERE kind=$1 AND user_id=$2', [kind, athlete.id])).rows[0].n;
  assert.equal(await count('collections_reminder'), 1); assert.equal(await count('coach_sub_past_due'), 0);
  // detail, promise and note work; access pausing does not apply
  const detail = must(await api('GET', `/collections/cases/${it.id}`, { token: coach.token }));
  assert.equal(detail.source.period_no, 2); assert.equal(detail.source.grace_days, 3);
  assert.equal((await api('GET', `/collections/cases/${it.id}`, { token: other.token })).status, 404);
  const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  must(await api('POST', `/collections/cases/${it.id}/actions`, { token: coach.token, body: { action: 'promise', promised_on: day(2) } }));
  assert.equal((await api('POST', `/collections/cases/${it.id}/actions`, { token: coach.token, body: { action: 'suspend', reason: 'not for subscriptions' } })).status, 422);
  assert.equal((await api('POST', `/collections/cases/${it.id}/actions`, { token: other.token, body: { action: 'note', note: 'hi there' } })).status, 404);
  assert.equal((await api('PATCH', '/collections/policy', { token: coach.token, body: { coach_id: coach.id, late_fee_enabled: true, late_fee_minor: 1000, late_fee_currency: 'INR', late_fee_basis: 'Written subscription terms' } })).status, 422);
  // paying the month closes the case, and nothing is deleted
  await pay((await periods(a.subscription.id))[1].id, athlete);
  await runCollections({ ownerId: coach.id });
  assert.equal(must(await q(coach.token)).items.length, 0);
  const closed = must(await q(coach.token, '&state=closed'));
  assert.equal(closed.items.length, 1); assert.ok(['paid', 'resolved'].includes(closed.items[0].state));
});

test('a young athlete\'s late month reminder goes to the guardian who pays, never to the child (issue #681)', async () => {
  const coach = await signup(['coach']); const parent = await signup();
  const kid = await signup(['athlete'], { dob: yearsAgo(12) });
  const card = await monthly(coach);
  await verifiedGuardian(parent, kid);
  must(await api('POST', `/youth/children/${kid.id}/consents`, { token: parent.token, body: { purpose: 'coaching' } }), 201);
  const r = must(await api('POST', '/coach-subscriptions', { token: parent.token, body: { rate_card_id: card.id, athlete_id: kid.id } }), 201);
  await pay(r.period.id, parent);
  await ageBy(r.subscription.id, 25); await syncCoachSubscriptions();
  await ageBy(r.subscription.id, 6); await syncCoachSubscriptions();
  for (let i = 0; i < 2; i++) await runCollections({ ownerId: coach.id });
  const count = async (uid) => (await pool.query("SELECT count(*)::int AS n FROM notifications WHERE kind='collections_reminder' AND user_id=$1", [uid])).rows[0].n;
  assert.equal(await count(parent.id), 1, 'the guardian is reminded once');
  assert.equal(await count(kid.id), 0, 'the child is never chased for money');
});

test('a month past the card grace lapses once: the case closes as cancelled, rows are kept, no extra reminders', async () => {
  const coach = await signup(['coach']); const athlete = await signup();
  const a = await subscribe(coach, athlete, { card: await monthly(coach, { grace_days: 1 }) });
  await pay(a.period.id, athlete);
  await ageBy(a.subscription.id, 25); await syncCoachSubscriptions();
  await ageBy(a.subscription.id, 6);
  await syncCoachSubscriptions(); await runCollections({ ownerId: coach.id });
  await ageBy(a.subscription.id, 3);                                  // now well past the one grace day
  await syncCoachSubscriptions(); await runCollections({ ownerId: coach.id }); await runCollections({ ownerId: coach.id });
  assert.equal((await subRow(a.subscription.id)).status, 'lapsed');
  const cs = (await pool.query("SELECT state FROM collection_cases WHERE owner_type='coach' AND owner_id=$1", [coach.id])).rows;
  assert.equal(cs.length, 1); assert.equal(cs[0].state, 'cancelled');
});
