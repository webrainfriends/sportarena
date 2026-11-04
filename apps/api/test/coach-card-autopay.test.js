// Automatic card-on-file charging for coach subscriptions (#680). Stripe is stubbed at the HTTP boundary (http://stripe.invalid); everything else is real.
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
const { sweepMandates } = await import('../src/payments/mandates.js');
const { capabilities } = await import('../src/capabilities/index.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const signup = async (roles = ['athlete'], extra = {}) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `ca_${n}_${roles[0]}`, display_name: `Person ${n}`, email: `ca${n}@example.com`, password: 'correct-horse-battery', roles, dob: yearsAgo(30), ...extra } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const evidence = { reference: 'https://example.com/birth-certificate-ref-123', label: 'Birth certificate' };
async function verifiedGuardian(parent, child) {
  const l = must(await api('POST', '/youth/guardian-links', { token: parent.token, body: { guardian_id: parent.id, child_id: child.id, relationship: 'parent' } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: child.token, body: { accept: true } }));
  must(await api('POST', `/youth/guardian-links/${l.id}/evidence`, { token: parent.token, body: { evidence } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Documents match' } }));
}
const monthly = async (coach) => {
  must(await api('POST', '/me/sport-profiles', { token: coach.token, body: { sport: 'football', role: 'coach', level: 'pro', hourly_rate_cents: 70000 } }), 201);
  return must(await api('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'Monthly mentoring', sport: 'football', audience: 'individual', unit: 'month', price_cents: 400000, sessions_included: 4, rollover_max: 2, grace_days: 3 } }), 201);
};

// ---- a tiny Stripe: customers, hosted setup sessions, off-session payment intents with real idempotency-key semantics ----
const stripeState = { intents: new Map(), calls: [], mode: 'ok', detached: [], setupDone: new Set() };
const realFetch = globalThis.fetch;
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const fakeStripe = async (url, init = {}) => {
  const u = new URL(url); const body = new URLSearchParams(String(init.body ?? ''));
  const key = init.headers?.['idempotency-key'];
  if (u.pathname === '/v1/customers') return json({ id: `cus_${++n}` });
  if (u.pathname === '/v1/checkout/sessions' && init.method === 'POST') return json({ id: `cs_setup_${body.get('client_reference_id')}`, url: `https://stripe.invalid/setup/${body.get('client_reference_id')}` });
  if (u.pathname.startsWith('/v1/checkout/sessions/')) {
    const id = decodeURIComponent(u.pathname.split('/').pop());
    const done = stripeState.setupDone.has(id);
    return json({ id, mode: 'setup', status: done ? 'complete' : 'open', customer: 'cus_saved', setup_intent: done ? { id: 'seti_1', status: 'succeeded', payment_method: { id: 'pm_saved_4242', card: { brand: 'visa', last4: '4242', exp_month: 7, exp_year: 2029 } } } : null });
  }
  if (u.pathname === '/v1/payment_intents') {
    stripeState.calls.push({ key, amount: Number(body.get('amount')), pm: body.get('payment_method'), offSession: body.get('off_session') });
    if (stripeState.intents.has(key)) return json(stripeState.intents.get(key).res, stripeState.intents.get(key).status);   // the same key never moves money twice
    const out = stripeState.mode === 'ok'
      ? { status: 200, res: { id: `pi_${stripeState.intents.size + 1}`, status: 'succeeded', amount: Number(body.get('amount')), amount_received: Number(body.get('amount')), currency: body.get('currency') } }
      : stripeState.mode === 'expired'
        ? { status: 402, res: { error: { type: 'card_error', code: 'expired_card', message: 'Your card has expired.' } } }
        : { status: 402, res: { error: { type: 'card_error', code: 'card_declined', decline_code: 'insufficient_funds', message: 'Your card has insufficient funds.' } } };
    stripeState.intents.set(key, out);
    return json(out.res, out.status);
  }
  if (u.pathname.endsWith('/detach')) { stripeState.detached.push(u.pathname.split('/')[3]); return json({ id: 'pm' }); }
  return json({ id: 're_1', status: 'succeeded' });
};
const charges = () => stripeState.calls.length;
const reset = () => { stripeState.calls.length = 0; stripeState.mode = 'ok'; };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('ca_root','ca_root','{admin}','x','x','ca_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  config.payments.stripe.secretKey = 'sk_test_x'; config.payments.stripe.base = 'http://stripe.invalid'; config.appUrl = 'http://localhost:8081';
  globalThis.fetch = async (url, init) => (String(url).startsWith('http://stripe.invalid') ? fakeStripe(url, init) : realFetch(url, init));
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { globalThis.fetch = realFetch; server.close(); await pool.end(); });

const periods = async (subId) => (await pool.query('SELECT * FROM user_plans WHERE subscription_id=$1 ORDER BY period_no', [subId])).rows;
const subRow = async (id) => (await pool.query('SELECT * FROM coach_subscriptions WHERE id=$1', [id])).rows[0];
const ageBy = async (subId, days) => pool.query(
  `UPDATE user_plans SET starts_at = starts_at - make_interval(days => $2), expires_at = expires_at - make_interval(days => $2), due_on = due_on - $2::int, created_at = created_at - make_interval(days => $2) WHERE subscription_id=$1`, [subId, days]);
async function payManually(periodId, user) {
  const per = (await pool.query('SELECT * FROM user_plans WHERE id=$1', [periodId])).rows[0];
  const p = (await pool.query("INSERT INTO payments(payer_id, provider, purpose_type, purpose_id, amount_cents, currency, status, provider_ref) VALUES ($1,'stripe','coach_subscription_period',$2,$3,$4,'pending',$5) RETURNING *", [user.id, periodId, per.price_cents, per.currency, `cs_${Math.random()}`])).rows[0];
  return settle(p.id, { paid: true, amount: Number(p.amount_cents), currency: p.currency, paymentRef: `pi_manual_${p.id}` });
}
/** A paid month one and a saved, confirmed card: the starting point of every scenario. */
async function optedIn(payer = null, athlete = null, coachIn = null) {
  const coach = coachIn ?? await signup(['coach']); const a = athlete ?? await signup(); const by = payer ?? a;
  const card = await monthly(coach);
  const r = must(await api('POST', '/coach-subscriptions', { token: by.token, body: { rate_card_id: card.id, ...(by.id !== a.id ? { athlete_id: a.id } : {}) } }), 201);
  await payManually(r.period.id, by);
  const m = must(await api('POST', '/payments/mandates', { token: by.token, body: { subject_kind: 'coach_subscription', subject_id: r.subscription.id, method: 'card' } }), 201);
  stripeState.setupDone.add(`cs_setup_${m.id}`);
  const ok = must(await api('POST', `/payments/mandates/${m.id}/confirm`, { token: by.token }));
  return { coach, athlete: a, by, sub: r.subscription, mandate: ok, rawMandate: m };
}
/** Raise month two and move the clock to its due day. */
async function dueNow(subId, past = 6) {
  await ageBy(subId, 25); await syncCoachSubscriptions();
  const before = (await periods(subId)).length;
  assert.equal(before, 2, 'month two was raised');
  await ageBy(subId, past);
}

test('the card mandate lives in the existing mandate capabilities (REST, OpenAPI and MCP from one definition); no second mandate system', () => {
  const names = capabilities.filter((c) => c.tag === 'Payments' && /mandate/.test(c.name)).map((c) => c.name).sort();
  assert.deepEqual(names, ['cancel_payment_mandate', 'confirm_payment_mandate', 'create_payment_mandate', 'list_my_payment_mandates']);
});

test('opting in saves a card on the hosted page: only brand, last four and expiry are shown, tokens are encrypted, nothing raw is stored', async () => {
  const o = await optedIn();
  assert.equal(o.mandate.status, 'active'); assert.equal(o.mandate.method, 'card');
  assert.deepEqual(o.mandate.card, { brand: 'visa', last4: '4242', exp: '07/29' });
  const row = (await pool.query('SELECT * FROM payment_mandates WHERE id=$1', [o.mandate.id])).rows[0];
  assert.ok(row.payment_method_enc && !row.payment_method_enc.includes('pm_saved_4242'), 'the provider token is encrypted');
  assert.ok(!JSON.stringify(o.mandate).includes('pm_saved'), 'the API never returns the token');
  const listed = must(await api('GET', '/payments/mandates', { token: o.by.token }));
  assert.equal(listed[0].card.last4, '4242');
  assert.equal((await api('GET', '/payments/mandates', { token: (await signup()).token })).body.length, 0, 'only the payer sees it');
  assert.equal((await api('POST', `/payments/mandates/${o.mandate.id}/cancel`, { token: (await signup()).token })).status, 404, 'a stranger gets 404');
});

test('an opted-in subscriber is charged exactly once per period, however often the sweep runs or races', async () => {
  reset();
  const o = await optedIn();
  await ageBy(o.sub.id, 25); await syncCoachSubscriptions();
  await runCollections();
  assert.equal(charges(), 0, 'nothing is charged before the month is due');
  await ageBy(o.sub.id, 6);                                   // month one ended yesterday: month two is due
  await Promise.all([runCollections(), runCollections(), runCollections()]);
  await runCollections();
  assert.equal(charges(), 1, 'one provider charge for the period');
  assert.equal(stripeState.calls[0].offSession, 'true'); assert.equal(stripeState.calls[0].amount, 400000);
  assert.equal(stripeState.calls[0].key, `coachsub:${o.sub.id}:2:0`, 'idempotency key per subscription and period');
  const ps = await periods(o.sub.id);
  assert.equal(ps[1].status, 'active', 'the month is paid and active'); assert.equal(ps[1].sessions_left, 6, 'four included plus the two sessions rolled over from month one');
  assert.equal(Number((await pool.query("SELECT count(*) FROM payments WHERE purpose_id=$1 AND status='paid'", [ps[1].id])).rows[0].count), 1, 'one canonical payment');
  assert.equal(Number((await pool.query("SELECT count(*) FROM mandate_charges WHERE subscription_id=$1 AND status='succeeded'", [o.sub.id])).rows[0].count), 1);
  assert.equal((await subRow(o.sub.id)).status, 'active');
  await assert.rejects(pool.query("INSERT INTO mandate_charges(mandate_id, subscription_id, period_no, attempt, amount_minor, currency, status) VALUES ($1,$2,2,7,1,'INR','succeeded')", [o.mandate.id, o.sub.id]), /mandate_charges_one_per_period/, 'the database itself refuses a second successful charge for the period');
  const hist = must(await api('GET', '/payments/mandates', { token: o.by.token }))[0];
  assert.equal(hist.last_charge.status, 'succeeded');
});

test('a retry of the same attempt after a lost response never takes a second charge (same idempotency key)', async () => {
  reset();
  const o = await optedIn();
  await dueNow(o.sub.id);
  await runCollections();
  assert.equal(charges(), 1);
  // simulate the transaction that recorded the charge being lost after Stripe said yes: forget our rows, keep the provider's memory
  await pool.query("DELETE FROM mandate_charges WHERE subscription_id=$1", [o.sub.id]);
  await pool.query("DELETE FROM collection_events WHERE kind IN ('auto_debit_started','auto_debit_failed')");
  await pool.query("UPDATE payments SET status='pending', paid_at=NULL WHERE purpose_type='coach_subscription_period' AND provider_ref LIKE 'pi_%'");
  await pool.query("UPDATE user_plans SET status='awaiting_payment' WHERE subscription_id=$1 AND period_no=2", [o.sub.id]);
  await pool.query("UPDATE collection_cases SET state='due', closed_at=NULL WHERE source_type='coach_subscription_period'");
  await runCollections();
  const keys = new Set(stripeState.calls.map((c) => c.key));
  assert.equal(keys.size, 1, 'both calls carried the same key, so Stripe returned the first charge instead of a second');
  assert.equal([...stripeState.intents.keys()].filter((k) => k.startsWith(`coachsub:${o.sub.id}:`)).length, 1, 'one charge exists at the provider for this subscription');
});

test('a declined charge falls back to grace, then lapse; the mandate and all data are kept', async () => {
  reset();
  const o = await optedIn();
  await dueNow(o.sub.id);
  stripeState.mode = 'declined';
  await runCollections();
  assert.equal(charges(), 1);
  const ps = await periods(o.sub.id);
  assert.equal(ps[1].status, 'awaiting_payment', 'not paid');
  assert.equal(Number((await pool.query("SELECT count(*) FROM payments WHERE purpose_id=$1 AND status='paid'", [ps[1].id])).rows[0].count), 0);
  const ev = await pool.query("SELECT kind FROM collection_events WHERE kind='auto_debit_failed'");
  assert.equal(ev.rowCount, 1, 'the failure is in the collections history');
  assert.ok((await pool.query("SELECT 1 FROM notifications WHERE kind='autopay_declined' AND user_id=$1", [o.by.id])).rowCount, 'the payer is told to update the card or pay');
  assert.equal(must(await api('GET', '/payments/mandates', { token: o.by.token }))[0].last_charge.status, 'failed');
  await syncCoachSubscriptions();
  assert.equal((await subRow(o.sub.id)).status, 'past_due', 'grace, with the entitlement kept');
  assert.equal((await pool.query("SELECT status FROM payment_mandates WHERE id=$1", [o.mandate.id])).rows[0].status, 'active', 'a plain decline keeps the mandate for the next try');
  // the payer can still pay it themselves inside grace
  const open = ps[1];
  await ageBy(o.sub.id, 10);                                  // beyond the 3 grace days
  await syncCoachSubscriptions();
  const s = await subRow(o.sub.id);
  assert.equal(s.status, 'lapsed'); assert.ok(s.lapsed_at);
  assert.equal((await periods(o.sub.id)).length, 2, 'nothing is deleted');
  assert.equal((await sweepMandates()).cancelled >= 1, true, 'the mandate of a lapsed subscription is stopped');
  assert.equal((await pool.query("SELECT status FROM payment_mandates WHERE id=$1", [o.mandate.id])).rows[0].status, 'cancelled');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM payment_mandates WHERE id=$1', [o.mandate.id])).rows[0].n, 1, 'the mandate row is kept');
  assert.ok(open.id);
});

test('a card that can no longer be charged stops the mandate (data kept) and the payer is asked to pay the month', async () => {
  reset();
  const o = await optedIn();
  await dueNow(o.sub.id);
  stripeState.mode = 'expired';
  await runCollections();
  assert.equal(charges(), 1);
  const m = (await pool.query('SELECT * FROM payment_mandates WHERE id=$1', [o.mandate.id])).rows[0];
  assert.equal(m.status, 'halted'); assert.match(m.revoked_reason, /no longer/);
  await runCollections();
  assert.equal(charges(), 1, 'a halted mandate is never charged again');
  assert.ok((await pool.query("SELECT 1 FROM notifications WHERE kind='autopay_stopped' AND user_id=$1", [o.by.id])).rowCount);
});

test('revoking the mandate stops charging immediately and detaches the saved card', async () => {
  reset(); stripeState.detached.length = 0;
  const o = await optedIn();
  await dueNow(o.sub.id);
  const r = must(await api('POST', `/payments/mandates/${o.mandate.id}/cancel`, { token: o.by.token }));
  assert.equal(r.status, 'cancelled');
  assert.deepEqual(stripeState.detached, ['pm_saved_4242'], 'the card is detached at the provider');
  await runCollections(); await runCollections();
  assert.equal(charges(), 0, 'not one charge after revoking');
  assert.equal((await periods(o.sub.id))[1].status, 'awaiting_payment', 'the month waits for the payer, as before automatic payment');
  assert.equal((await subRow(o.sub.id)).status, 'active', 'the subscription itself is untouched');
  assert.equal(must(await api('POST', `/payments/mandates/${o.mandate.id}/cancel`, { token: o.by.token })).status, 'cancelled', 'revoking twice is harmless');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='cancel_card_autopay' AND entity_id=$1", [o.mandate.id])).rowCount, 'audited');
});

test('a young athlete: only a verified guardian with coaching consent can opt in, and revoking consent stops the next charge', async () => {
  reset();
  const coach = await signup(['coach']); const parent = await signup(); const kid = await signup(['athlete'], { dob: yearsAgo(12) });
  const card = await monthly(coach);
  await verifiedGuardian(parent, kid);
  must(await api('POST', `/youth/children/${kid.id}/consents`, { token: parent.token, body: { purpose: 'coaching' } }), 201);
  const r = must(await api('POST', '/coach-subscriptions', { token: parent.token, body: { rate_card_id: card.id, athlete_id: kid.id } }), 201);
  await payManually(r.period.id, parent);
  const kidTry = await api('POST', '/payments/mandates', { token: kid.token, body: { subject_kind: 'coach_subscription', subject_id: r.subscription.id, method: 'card' } });
  assert.equal(kidTry.status, 404, 'the young person is not the payer, so the subscription is not theirs to automate');
  const m = must(await api('POST', '/payments/mandates', { token: parent.token, body: { subject_kind: 'coach_subscription', subject_id: r.subscription.id, method: 'card' } }), 201);
  stripeState.setupDone.add(`cs_setup_${m.id}`);
  const live = must(await api('POST', `/payments/mandates/${m.id}/confirm`, { token: parent.token }));
  assert.equal(live.status, 'active');
  const row = (await pool.query('SELECT consent_by FROM payment_mandates WHERE id=$1', [m.id])).rows[0];
  assert.equal(row.consent_by, parent.id, 'the guardian who allowed it is recorded');
  await dueNow(r.subscription.id);
  must(await api('DELETE', `/youth/children/${kid.id}/consents/coaching`, { token: parent.token }));
  await runCollections();
  assert.equal(charges(), 0, 'live revocation: consent was withdrawn, so no charge');
  const after = (await pool.query('SELECT status, revoked_reason FROM payment_mandates WHERE id=$1', [m.id])).rows[0];
  assert.equal(after.status, 'cancelled'); assert.match(after.revoked_reason, /consent/i);
  assert.ok((await pool.query("SELECT 1 FROM notifications WHERE kind='autopay_stopped' AND user_id=$1", [parent.id])).rowCount);
});

test('a second mandate for the same subscription is refused, and UPI AutoPay still works beside the card', async () => {
  reset();
  const o = await optedIn();
  const dup = await api('POST', '/payments/mandates', { token: o.by.token, body: { subject_kind: 'coach_subscription', subject_id: o.sub.id, method: 'card' } });
  assert.equal(dup.status, 409); assert.equal(dup.body.error.details.code, 'mandate_exists');
  const membership = await api('POST', '/payments/mandates', { token: o.by.token, body: { subject_kind: 'membership', subject_id: o.sub.id, method: 'card' } });
  assert.ok([404, 409].includes(membership.status), 'a card mandate is for coaching subscriptions');
});
