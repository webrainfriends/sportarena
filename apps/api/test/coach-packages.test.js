import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { config } = await import('../src/config.js');
const { settle } = await import('../src/payments/service.js');
const { syncCoachPackages } = await import('../src/coach-packages.js');
const { capabilities } = await import('../src/capabilities/index.js');

let server, base, n = 0, admin, slot = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const signup = async (roles = ['athlete'], extra = {}) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `cp_${n}_${roles[0]}`, display_name: `Person ${n}`, email: `cp${n}@example.com`, password: 'correct-horse-battery', roles, dob: yearsAgo(30), ...extra } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const nextTime = () => new Date(Date.now() + (30 + 3 * ++slot) * 36e5).toISOString();   // every booking gets its own hour, so the coach is never double-booked
const evidence = { reference: 'https://example.com/birth-certificate-ref-123', label: 'Birth certificate' };
async function verifiedGuardian(parent, child) {
  const l = must(await api('POST', '/youth/guardian-links', { token: parent.token, body: { guardian_id: parent.id, child_id: child.id, relationship: 'parent' } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: child.token, body: { accept: true } }));
  must(await api('POST', `/youth/guardian-links/${l.id}/evidence`, { token: parent.token, body: { evidence } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Documents match' } }));
}
const realFetch = globalThis.fetch;
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('cp_root','cp_root','{admin}','x','x','cp_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  config.payments.stripe.secretKey = 'sk_test_x'; config.payments.stripe.base = 'http://stripe.invalid';
  globalThis.fetch = async (url, init) => String(url).startsWith('http://stripe.invalid')
    ? new Response(JSON.stringify({ id: 're_1', status: 'succeeded' }), { status: 200, headers: { 'content-type': 'application/json' } }) : realFetch(url, init);
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { globalThis.fetch = realFetch; server.close(); await pool.end(); });

/** Settle a canonical payment for a package exactly as the provider webhook would. */
async function pay(packageId, user) {
  const k = (await pool.query('SELECT * FROM coach_package_purchases WHERE id=$1', [packageId])).rows[0];
  const p = (await pool.query("INSERT INTO payments(payer_id, provider, purpose_type, purpose_id, amount_cents, currency, status, provider_ref) VALUES ($1,'stripe','coach_package',$2,$3,$4,'pending',$5) RETURNING *", [user.id, packageId, k.price_cents, k.currency, `cs_${Math.random()}`])).rows[0];
  await pool.query("UPDATE payments SET provider_payment_ref='pi_test' WHERE id=$1", [p.id]);
  return settle(p.id, { paid: true, amount: Number(p.amount_cents), currency: p.currency, paymentRef: 'pi_test' });
}
const packRow = async (id) => (await pool.query('SELECT * FROM coach_package_purchases WHERE id=$1', [id])).rows[0];
async function coachWith(sport = 'football', extra = {}) {
  const coach = await signup(['coach']);
  must(await api('POST', '/me/sport-profiles', { token: coach.token, body: { sport, role: 'coach', level: 'pro', hourly_rate_cents: 70000 } }), 201);
  const card = must(await api('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'Ten-session pack', sport, audience: 'individual', unit: 'package', price_cents: 500000, sessions_included: 5, valid_days: 90, ...extra } }), 201);
  return { coach, card };
}
async function buyAndPay(athlete, card, extra = {}) {
  const r = must(await api('POST', '/coach-packages', { token: athlete.token, body: { rate_card_id: card.id, ...extra } }), 201);
  assert.equal(r.package.status, 'awaiting_payment');
  assert.deepEqual(r.pay, { purpose_type: 'coach_package', purpose_id: r.package.id });
  assert.equal((await pay(r.package.id, extra.payer ?? athlete)).status, 'paid');
  return r.package.id;
}
const book = (athlete, coach, extra = {}) => api('POST', '/hires', { token: athlete.token, body: { coach_id: coach.id, sport: 'football', starts_at: nextTime(), duration_min: 60, ...extra } });

test('the package capabilities are REST routes, OpenAPI operations and MCP tools from one definition', () => {
  const names = capabilities.filter((c) => c.tag === 'Coach packages').map((c) => c.name);
  for (const x of ['buy_coach_package', 'my_coach_packages', 'coach_package_buyers', 'refund_coach_package', 'cancel_unpaid_coach_package']) assert.ok(names.includes(x), x);
  assert.equal(capabilities.find((c) => c.name === 'buy_coach_package').scope, 'payment');
  assert.equal(capabilities.find((c) => c.name === 'refund_coach_package').scope, 'payment');
});

test('only one-to-one packages with sessions can be bought; buying waits for payment, activation is idempotent and starts the validity', async () => {
  const { coach, card } = await coachWith(); const athlete = await signup();
  assert.equal(card.valid_days, 90);
  const group = must(await api('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'Group pack', sport: 'football', audience: 'group', unit: 'package', price_cents: 100000, sessions_included: 3, duration_min: 60 } }), 201);
  assert.equal((await api('POST', '/coach-packages', { token: athlete.token, body: { rate_card_id: group.id } })).status, 400, 'a group pack is a price label, not a balance');
  assert.equal((await api('POST', '/coach-packages', { token: coach.token, body: { rate_card_id: card.id } })).status, 400, 'not your own');
  const first = must(await api('POST', '/coach-packages', { token: athlete.token, body: { rate_card_id: card.id } }), 201);
  const again = must(await api('POST', '/coach-packages', { token: athlete.token, body: { rate_card_id: card.id } }), 201);
  assert.equal(again.package.id, first.package.id, 'a retry returns the same unpaid purchase');
  assert.equal(first.package.sessions_left, 0, 'nothing usable before payment');
  assert.equal((await book(athlete, coach, { package_id: first.package.id })).status, 409, 'unpaid package cannot be spent');
  const id = first.package.id;
  assert.equal((await pay(id, athlete)).status, 'paid');
  const dup = await pay(id, athlete);
  assert.equal(dup.status, 'refunded', 'a second payment for the same package is refunded, never kept');
  const row = await packRow(id);
  assert.equal(row.status, 'active');
  assert.ok(new Date(row.expires_at) > new Date(Date.now() + 89 * 864e5) && new Date(row.expires_at) < new Date(Date.now() + 91 * 864e5), '90 days from payment');
  const mine = must(await api('GET', '/me/coach-packages', { token: athlete.token })).find((p) => p.id === id);
  assert.equal(mine.sessions_left, 5); assert.equal(mine.sessions_total, 5); assert.equal(mine.refund_estimate_cents, 500000);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM payments WHERE purpose_id=$1 AND status='paid'", [id])).rows[0].n, 1);
});

test('concurrency: parallel bookings never spend more than sessions_total', async () => {
  const { coach, card } = await coachWith(); const athlete = await signup();
  const id = await buyAndPay(athlete, card);
  const results = await Promise.all(Array.from({ length: 9 }, () => book(athlete, coach, { package_id: id })));
  const ok = results.filter((r) => r.status === 201), no = results.filter((r) => r.status === 409);
  assert.equal(ok.length, 5, JSON.stringify(results.map((r) => r.status)));
  assert.equal(no.length, 4);
  assert.ok(no.every((r) => r.body.error.details?.code === 'package_empty'));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM coach_package_redemptions WHERE purchase_id=$1', [id])).rows[0].n, 5);
  for (const r of ok) { assert.equal(Number(r.body.total_cents), 0); assert.equal(r.body.payment_status, 'not_required'); }
});

test('a cancelled hire returns its session, a completed one keeps it, and a stranger or the wrong coach gets a 404', async () => {
  const { coach, card } = await coachWith(); const other = await coachWith(); const athlete = await signup(); const stranger = await signup();
  const id = await buyAndPay(athlete, card);
  assert.equal((await book(stranger, coach, { package_id: id })).status, 404, 'existence is not leaked');
  assert.equal((await book(athlete, other.coach, { package_id: id })).status, 404, "a package is only good with the coach who sold it");
  const h1 = must(await book(athlete, coach, { package_id: id }), 201), h2 = must(await book(athlete, coach, { package_id: id }), 201);
  const left = async () => must(await api('GET', '/me/coach-packages', { token: athlete.token })).find((p) => p.id === id).sessions_left;
  assert.equal(await left(), 3);
  must(await api('PATCH', `/hires/${h1.id}`, { token: athlete.token, body: { status: 'cancelled' } }));
  assert.equal(await left(), 4, 'cancelling gives the session back');
  must(await api('PATCH', `/hires/${h2.id}`, { token: coach.token, body: { status: 'confirmed' } }));
  await pool.query("UPDATE coach_hires SET starts_at = now() - interval '2 hours' WHERE id=$1", [h2.id]);
  must(await api('PATCH', `/hires/${h2.id}`, { token: coach.token, body: { status: 'completed' } }));
  assert.equal(await left(), 4, 'a completed session stays spent');
  await pool.query("UPDATE coach_hires SET status='expired' WHERE id=$1", [h1.id]);
  assert.equal(await left(), 4);
  const hist = must(await api('GET', '/me/coach-packages', { token: athlete.token })).find((p) => p.id === id).history;
  assert.equal(hist.length, 2); assert.equal(hist.filter((x) => x.counts).length, 1);
  const wrongSport = await api('POST', '/hires', { token: athlete.token, body: { coach_id: coach.id, sport: 'tennis', starts_at: nextTime(), duration_min: 60, package_id: id } });
  assert.ok([400, 404].includes(wrongSport.status));
  assert.equal((await book(athlete, coach, { package_id: id, subscription_id: id })).status, 400, 'a package and a subscription are not combined');
});

test('expiry is enforced: expired and past-the-end bookings are refused, the sweep warns once and closes it', async () => {
  const { coach, card } = await coachWith('football', { valid_days: 10 }); const athlete = await signup();
  const id = await buyAndPay(athlete, card);
  const late = await api('POST', '/hires', { token: athlete.token, body: { coach_id: coach.id, sport: 'football', starts_at: new Date(Date.now() + 20 * 864e5).toISOString(), duration_min: 60, package_id: id } });
  assert.equal(late.status, 409, 'the session itself must fall inside the validity'); assert.equal(late.body.error.details.code, 'package_expired');
  await pool.query("UPDATE coach_package_purchases SET expires_at = now() + interval '3 days' WHERE id=$1", [id]);
  await Promise.all([syncCoachPackages(), syncCoachPackages()]);
  await syncCoachPackages();
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE kind='coach_package_expiring' AND user_id=$1", [athlete.id])).rows[0].n, 1, 'warned once');
  await pool.query("UPDATE coach_package_purchases SET expires_at = now() - interval '1 minute' WHERE id=$1", [id]);
  assert.equal((await book(athlete, coach, { package_id: id })).status, 409, 'expired before the sweep has even run');
  await syncCoachPackages(); await syncCoachPackages();
  assert.equal((await packRow(id)).status, 'expired');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE kind='coach_package_expired' AND user_id=$1", [athlete.id])).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM coach_package_purchases WHERE id=$1', [id])).rows[0].n, 1, 'nothing is deleted');
});

test('refund of the unused part is pro rata, reconciles to the payment, is audit-logged and cannot repeat', async () => {
  const { coach, card } = await coachWith(); const athlete = await signup(); const stranger = await signup();
  const id = await buyAndPay(athlete, card);
  must(await book(athlete, coach, { package_id: id }), 201); must(await book(athlete, coach, { package_id: id }), 201);
  assert.equal((await api('POST', `/coach-packages/${id}/refund`, { token: stranger.token, body: {} })).status, 404);
  const mine = must(await api('GET', '/me/coach-packages', { token: athlete.token })).find((p) => p.id === id);
  assert.equal(mine.refund_estimate_cents, 300000, '3 of 5 unused = 60% of 5,000.00');
  const r = must(await api('POST', `/coach-packages/${id}/refund`, { token: athlete.token, body: { reason: 'Moving away' } }));
  assert.equal(r.refunded_cents, 300000); assert.equal(r.sessions_refunded, 3);
  const pay1 = (await pool.query("SELECT * FROM payments WHERE purpose_type='coach_package' AND purpose_id=$1", [id])).rows[0];
  assert.equal(Number(pay1.refunded_cents), 300000, 'reconciles to the canonical payment'); assert.equal(pay1.status, 'paid', 'partially refunded, not fully');
  const row = await packRow(id);
  assert.equal(row.status, 'refunded'); assert.equal(Number(row.refunded_cents), 300000);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='refund_coach_package' AND entity_id=$1 AND actor_id=$2", [id, athlete.id])).rows[0].n, 1);
  assert.equal((await api('POST', `/coach-packages/${id}/refund`, { token: athlete.token, body: {} })).status, 409, 'no second refund');
  assert.equal(Number((await pool.query("SELECT refunded_cents FROM payments WHERE id=$1", [pay1.id])).rows[0].refunded_cents), 300000);
  assert.equal((await book(athlete, coach, { package_id: id })).status, 409, 'a refunded package accepts no new bookings');
  assert.equal(Number((await pool.query("SELECT count(*)::int AS n FROM coach_hires WHERE id IN (SELECT hire_id FROM coach_package_redemptions WHERE purchase_id=$1) AND status='requested'", [id])).rows[0].n), 2, 'the two booked sessions are still honoured');
  const view = must(await api('GET', '/coach/packages', { token: coach.token }));
  assert.equal(view.packages.length, 1); assert.equal(view.totals.unearned_cents, 0);
  assert.equal((await api('GET', '/coach/packages', { token: athlete.token })).status, 403);
});

test('an expired package is refunded by the coach only; an unpaid one is cancelled, not refunded', async () => {
  const { coach, card } = await coachWith(); const athlete = await signup();
  const unpaid = must(await api('POST', '/coach-packages', { token: athlete.token, body: { rate_card_id: card.id } }), 201).package.id;
  assert.equal((await api('POST', `/coach-packages/${unpaid}/refund`, { token: athlete.token, body: {} })).status, 409);
  must(await api('POST', `/coach-packages/${unpaid}/cancel`, { token: athlete.token }));
  assert.equal((await packRow(unpaid)).status, 'cancelled');
  const id = await buyAndPay(athlete, card);
  await pool.query("UPDATE coach_package_purchases SET expires_at = now() - interval '1 day' WHERE id=$1", [id]); await syncCoachPackages();
  assert.equal((await api('POST', `/coach-packages/${id}/refund`, { token: athlete.token, body: {} })).status, 409, 'the athlete cannot refund after expiry');
  const r = must(await api('POST', `/coach-packages/${id}/refund`, { token: coach.token, body: { reason: 'Goodwill' } }));
  assert.equal(r.refunded_cents, 500000);
});

test('a guardian buys for a young athlete, sees the balance and books with it; without a verified guardian nobody can', async () => {
  const { coach, card } = await coachWith(); const parent = await signup(); const stranger = await signup();
  const kid = await signup(['athlete'], { dob: yearsAgo(12) });
  assert.equal((await api('POST', '/coach-packages', { token: stranger.token, body: { rate_card_id: card.id, athlete_id: kid.id } })).status, 404);
  await verifiedGuardian(parent, kid);
  assert.equal((await api('POST', '/coach-packages', { token: kid.token, body: { rate_card_id: card.id } })).status, 403, 'a young person with a guardian cannot buy alone');
  assert.equal((await api('POST', '/coach-packages', { token: parent.token, body: { rate_card_id: card.id, athlete_id: kid.id } })).body.error.details.code, 'guardian_consent_required');
  must(await api('POST', `/youth/children/${kid.id}/consents`, { token: parent.token, body: { purpose: 'coaching' } }), 201);
  const id = await buyAndPay(parent, card, { athlete_id: kid.id });
  const row = await packRow(id); assert.equal(row.payer_id, parent.id); assert.equal(row.athlete_id, kid.id);
  assert.equal(must(await api('GET', '/me/coach-packages', { token: parent.token })).find((p) => p.id === id).sessions_left, 5, 'the guardian sees the balance');
  assert.equal(must(await api('GET', '/me/coach-packages', { token: stranger.token })).length, 0);
  must(await book(parent, coach, { package_id: id, athlete_id: kid.id }), 201);
  assert.equal(must(await api('GET', '/me/coach-packages', { token: parent.token })).find((p) => p.id === id).sessions_left, 4);
  assert.equal((await book(stranger, coach, { package_id: id, athlete_id: kid.id })).status, 404);
});

test('every sport in the catalogue can sell, pay for and redeem a package', async () => {
  const sports = (await pool.query('SELECT slug FROM sports ORDER BY slug')).rows.map((r) => r.slug);
  assert.ok(sports.length > 20);
  const coach = await signup(['coach']); const athlete = await signup();
  for (const sport of sports) {
    must(await api('POST', '/me/sport-profiles', { token: coach.token, body: { sport, role: 'coach', level: 'pro', hourly_rate_cents: 50000 } }), 201);
    const card = must(await api('POST', '/coach/rate-cards', { token: coach.token, body: { title: `${sport} pack`, sport, audience: 'individual', unit: 'package', price_cents: 100000, sessions_included: 2, valid_days: 400 } }), 201);
    const id = await buyAndPay(athlete, card);
    const h = await book(athlete, coach, { sport, package_id: id });
    assert.equal(h.status, 201, `${sport}: ${JSON.stringify(h.body)}`);
    assert.equal((await packRow(id)).sport_id, card.sport_id, `${sport}: the pack is tied to its sport`);
  }
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM coach_package_redemptions")).rows[0].n >= sports.length, true);
});
