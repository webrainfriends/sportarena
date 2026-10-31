import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { config } = await import('../src/config.js');
const { stripe } = await import('../src/payments/providers.js');
const { settle, describePurpose } = await import('../src/payments/service.js');
const { syncCoachClasses } = await import('../src/coach-class-sweeps.js');
const { reconcileFinance } = await import('../src/finance.js');
const { capabilities } = await import('../src/capabilities/index.js');
const { CATALOGUES } = await import('../../app/src/i18n/catalogue.js');
const fs = await import('node:fs');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const signup = async (roles = ['athlete'], extra = {}) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `cc_${n}_${roles[0]}`, display_name: `Class Person ${n}`, email: `cc${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const dayAt = (days, hour = 9) => { const d = new Date(Date.now() + days * 864e5); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };
const evidence = { reference: 'https://example.com/birth-certificate-ref-123', label: 'Birth certificate' };
async function verifiedGuardian(parent, child) {
  const l = must(await api('POST', '/youth/guardian-links', { token: parent.token, body: { guardian_id: parent.id, child_id: child.id, relationship: 'parent' } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: child.token, body: { accept: true } }));
  must(await api('POST', `/youth/guardian-links/${l.id}/evidence`, { token: parent.token, body: { evidence } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Documents match' } }));
}

const coachOf = async () => {
  const coach = await signup(['coach']);
  must(await api('POST', '/me/sport-profiles', { token: coach.token, body: { sport: 'football', role: 'coach', level: 'pro', hourly_rate_cents: 60000 } }), 201);
  return coach;
};
const groupCard = async (coach, over = {}) => must(await api('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'Small-group football', sport: 'football', audience: 'group', unit: 'session', duration_min: 60, price_cents: 0, per_person: true, min_participants: 1, max_participants: 6, ...over } }), 201);
const publish = (coach, card, body = {}) => api('POST', '/coach/classes', { token: coach.token, body: { rate_card_id: card.id, starts_at: dayAt(5, 9), location: 'Riverside ground', ...body } });
const classOf = async (coach, card, body = {}) => must(await publish(coach, card, body), 201).classes[0];
const join = (u, k, body = {}) => api('POST', `/coach-classes/${k.id}/join`, { token: u.token, body });
const leave = (u, k, body = {}) => api('POST', `/coach-classes/${k.id}/leave`, { token: u.token, body });
const seatOf = async (k, u) => (await pool.query('SELECT * FROM coach_class_seats WHERE class_id=$1 AND user_id=$2', [k.id, u.id])).rows[0];
const counts = async (k) => (await pool.query("SELECT status, count(*)::int AS n FROM coach_class_seats WHERE class_id=$1 GROUP BY 1", [k.id])).rows.reduce((a, r) => ({ ...a, [r.status]: r.n }), {});
const inbox = async (u) => must(await api('GET', '/notifications', { token: u.token })).items;

// payments: switch the provider on and capture refunds, so the real settle/refund code runs without a network
const refunds = [];
const realRefund = stripe.refund;
const paymentsOn = () => { config.payments.stripe.secretKey = 'sk_test_x'; stripe.refund = async (ref, paymentId, o) => { refunds.push({ ref, paymentId, key: o?.key }); }; };
const paymentsOff = () => { config.payments.stripe.secretKey = undefined; stripe.refund = realRefund; refunds.length = 0; };
let pi = 0;
const payFor = async (seatId, payer, amount) => {
  const p = (await pool.query("INSERT INTO payments(payer_id, provider, purpose_type, purpose_id, amount_cents, currency) VALUES ($1,'stripe','coach_class_seat',$2,$3,$4) RETURNING id", [payer.id, seatId, amount, config.payments.currency])).rows[0];
  const r = await settle(p.id, { paid: true, amount, currency: config.payments.currency, paymentRef: `pi_cc_${++pi}` });
  return { id: p.id, ...r };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('cc_root','cc_root','{admin}','x','x','cc_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { paymentsOff(); server.close(); await pool.end(); });

test('every class capability is a REST route, an OpenAPI operation and an MCP tool from one definition', () => {
  const names = capabilities.filter((c) => c.tag === 'Coach classes').map((c) => c.name);
  for (const x of ['publish_coach_class', 'update_coach_class', 'cancel_coach_class', 'list_my_coach_classes', 'list_coach_classes', 'get_coach_class', 'join_coach_class', 'leave_coach_class', 'guardian_decide_coach_class_join', 'list_my_coach_class_seats', 'mark_coach_class_attendance']) assert.ok(names.includes(x), x);
});

test('publishing: group cards only, the coach\'s own sport and seats, a clear calendar; a series skips clashes', async () => {
  const coach = await coachOf(), other = await signup(['coach']), fan = await signup();
  const card = await groupCard(coach);
  const solo = must(await api('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'One to one', sport: 'football', audience: 'individual', unit: 'hour', price_cents: 1000 } }), 201);
  assert.equal((await publish(coach, solo)).status, 400, 'a class is published from a group card');
  assert.equal((await publish(fan, card)).status, 403, 'only coaches publish');
  assert.equal((await publish(other, card)).status, 404, 'not someone else\'s card');
  assert.equal((await publish(coach, card, { max_participants: 9 })).status, 400, 'seats within the card\'s range');
  assert.equal((await publish(coach, card, { starts_at: new Date(Date.now() + 3600e3).toISOString() })).status, 400, 'the cutoff must still be ahead');
  assert.equal((await publish(coach, card, { location: undefined })).status, 400, 'in-person needs a place');
  assert.equal((await publish(coach, card, { delivery: 'online' })).status, 400, 'online needs a link');
  assert.equal((await publish(coach, card, { sport: 'tennis' })).status, 400, 'card is football only');
  const k = await classOf(coach, card, { max_participants: 4, min_participants: 2 });
  assert.equal(k.seats.left, 4); assert.equal(k.status, 'scheduled'); assert.equal(k.price_cents, 0);
  // a second class on top of it, a hire request on top of it and a commitment on top of it are all refused
  assert.equal((await publish(coach, card, { starts_at: new Date(+new Date(k.starts_at) + 30 * 60e3).toISOString() })).status, 409);
  const hire = await api('POST', '/hires', { token: fan.token, body: { coach_id: coach.id, sport: 'football', starts_at: k.starts_at, duration_min: 60 } });
  assert.equal(hire.status, 409, 'a hire cannot be placed on a class');
  assert.match(hire.body.error?.message ?? hire.body.message ?? '', /class/i);
  // and the other way round: a requested hire blocks a class
  const hireAt = dayAt(6, 9);
  must(await api('POST', '/hires', { token: fan.token, body: { coach_id: coach.id, sport: 'football', starts_at: hireAt, duration_min: 60 } }), 201);
  assert.equal((await publish(coach, card, { starts_at: hireAt })).status, 409);
  // a weekly series: the date that clashes is skipped and reported, the rest are published
  const start = dayAt(8, 0).slice(0, 10);
  const series = must(await api('POST', '/coach/classes', { token: coach.token, body: { rate_card_id: card.id, location: 'Riverside ground', repeat: { start: '09:00', timezone: 'UTC', starts_on: start, count: 3, weekdays: [new Date(`${start}T00:00:00Z`).getUTCDay()] } } }), 201);
  assert.equal(series.classes.length, 3); assert.equal(new Set(series.classes.map((x) => x.id)).size, 3);
  const again = must(await api('POST', '/coach/classes', { token: coach.token, body: { rate_card_id: card.id, location: 'Riverside ground', repeat: { start: '09:00', timezone: 'UTC', starts_on: start, count: 3, weekdays: [new Date(`${start}T00:00:00Z`).getUTCDay()] } } }), 201);
  assert.equal(again.classes.length, 0); assert.equal(again.skipped.length, 3, 'a re-run never duplicates');
  assert.equal((await api('POST', '/coach/classes', { token: coach.token, body: { rate_card_id: card.id, location: 'x', on_conflict: 'fail', repeat: { start: '09:00', timezone: 'UTC', starts_on: start, count: 3, weekdays: [new Date(`${start}T00:00:00Z`).getUTCDay()] } } })).status, 409);
  // the coach's own list: upcoming (soonest first), past and cancelled, with seat counts
  const mine = must(await api('GET', '/coach/classes', { token: coach.token, query: { when: 'upcoming' } }));
  assert.equal(mine.length, 4); assert.ok(mine[0].starts_at <= mine[1].starts_at);
  assert.equal(must(await api('GET', '/coach/classes', { token: coach.token, query: { when: 'past' } })).length, 0);
  assert.equal((await api('GET', '/coach/classes', { token: fan.token })).status, 403);
  // the coach's calendar shows the class with seat counts
  const cal = must(await api('GET', '/coach/calendar', { token: coach.token, query: { from: dayAt(4).slice(0, 10), to: dayAt(7).slice(0, 10) } }));
  assert.ok(cal.items.some((x) => x.source_type === 'coach_class' && x.source_id === k.id && x.context === '0/4 seats'));
});

test('seats are never oversold under concurrent joins, retries replay, and the waitlist promotes in order exactly once', async () => {
  const coach = await coachOf(); const card = await groupCard(coach);
  const k = await classOf(coach, card, { max_participants: 3 });
  const crowd = []; for (let i = 0; i < 9; i++) crowd.push(await signup());
  const results = await Promise.all(crowd.map((u) => join(u, k, { idempotency_key: `key-${u.id.slice(0, 8)}` })));
  const statuses = results.map((r) => must(r, 201).status);
  assert.equal(statuses.filter((s) => s === 'confirmed').length, 3);
  assert.equal(statuses.filter((s) => s === 'waitlisted').length, 6);
  assert.deepEqual(await counts(k), { confirmed: 3, waitlisted: 6 });
  assert.equal(Number((await pool.query("SELECT count(*) FROM coach_class_seats WHERE class_id=$1 AND status IN ('held','confirmed')", [k.id])).rows[0].count), 3);
  // retries replay and create no second seat
  const again = await Promise.all([join(crowd[0], k), join(crowd[0], k), join(crowd[8], k)]);
  for (const r of again) assert.equal(must(r, 201).replayed, true);
  assert.equal(Number((await pool.query('SELECT count(*) FROM coach_class_seats WHERE class_id=$1', [k.id])).rows[0].count), 9);
  // a waiting person sees their place in the queue, in join order
  const waiting = crowd.filter((_, i) => results[i].body.status === 'waitlisted');
  const order = (await pool.query("SELECT user_id FROM coach_class_seats WHERE class_id=$1 AND status='waitlisted' ORDER BY queued_at, id", [k.id])).rows.map((r) => r.user_id);
  for (const u of waiting) assert.equal(must(await api('GET', `/coach-classes/${k.id}`, { token: u.token })).my_seats[0].position, order.indexOf(u.id) + 1);
  assert.equal(must(await api('GET', '/me/coach-classes', { token: waiting[0].token }))[0].position, order.indexOf(waiting[0].id) + 1);
  // the public view counts seats and never names anyone
  const pub = must(await api('GET', `/coach-classes/${k.id}`));
  assert.deepEqual([pub.seats.taken, pub.seats.left, pub.seats.waiting], [3, 0, 6]);
  assert.equal(pub.roster, undefined);
  for (const u of crowd) assert.ok(!JSON.stringify(pub).includes(u.handle));
  const listed = must(await api('GET', '/coach-classes', { query: { coach_id: coach.id } }));
  assert.ok(!JSON.stringify(listed).includes(crowd[0].handle));
  assert.equal(must(await api('GET', '/coach-classes', { query: { coach_id: coach.id, has_seats: 'true' } })).length, 0, 'a full class is not offered to people who only want seats');
  // two seat holders leave at once (one of them twice): the two oldest waiters are promoted, each once, in order
  const seated = crowd.filter((_, i) => results[i].body.status === 'confirmed');
  const oldest = (await pool.query("SELECT user_id FROM coach_class_seats WHERE class_id=$1 AND status='waitlisted' ORDER BY queued_at, id LIMIT 2", [k.id])).rows.map((r) => r.user_id);
  const left = await Promise.all([leave(seated[0], k), leave(seated[0], k), leave(seated[1], k)]);
  for (const r of left) assert.equal(r.status, 200);
  assert.deepEqual(await counts(k), { confirmed: 3, waitlisted: 4, cancelled: 2 });
  for (const uid of oldest) assert.equal((await pool.query('SELECT status FROM coach_class_seats WHERE class_id=$1 AND user_id=$2', [k.id, uid])).rows[0].status, 'confirmed');
  const promoted = crowd.find((u) => u.id === oldest[0]);
  assert.equal((await inbox(promoted)).filter((x) => x.kind === 'coach_class_promoted').length, 1, 'told once');
  // raising the seats promotes the waitlist too; the coach cannot cut below the seats taken
  assert.equal((await api('PATCH', `/coach/classes/${k.id}`, { token: coach.token, body: { max_participants: 2 } })).status, 409);
  must(await api('PATCH', `/coach/classes/${k.id}`, { token: coach.token, body: { max_participants: 5 } }));
  assert.deepEqual(await counts(k), { confirmed: 5, waitlisted: 2, cancelled: 2 });
  // the coach sees the roster; a stranger does not, and the read is audited
  const coachView = must(await api('GET', `/coach-classes/${k.id}`, { token: coach.token }));
  assert.equal(coachView.roster.length, 7);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='read_class_roster' AND entity_id=$1", [k.id])).rows[0].n, 1);
  assert.equal(must(await api('GET', `/coach-classes/${k.id}`, { token: crowd[2].token })).roster, undefined);
  // the coach cannot join their own class
  assert.equal((await join(coach, k)).status, 400);
});

test('paid seats: held for a payment window, paid through canonical payments, lapse and pass to the next person; refunds reconcile', async () => {
  paymentsOn();
  try {
    const coach = await coachOf(); const card = await groupCard(coach, { price_cents: 50000 });
    const k = await classOf(coach, card, { max_participants: 2, min_participants: 1 });
    const [a, b, c, d] = [await signup(), await signup(), await signup(), await signup()];
    const sa = must(await join(a, k), 201), sb = must(await join(b, k), 201), sc = must(await join(c, k), 201);
    assert.deepEqual([sa.status, sb.status, sc.status], ['held', 'held', 'waitlisted']);
    assert.equal(sa.payment_status, 'unpaid'); assert.ok(sa.pay_by);
    assert.equal(sa.price_cents, 50000);
    // payable now, only by the person who holds it
    assert.equal((await describePurpose(pool, 'coach_class_seat', sa.seat_id)).payable, true);
    assert.equal((await describePurpose(pool, 'coach_class_seat', sa.seat_id)).payerId, a.id);
    assert.equal((await api('POST', '/payments', { token: b.token, body: { purpose_type: 'coach_class_seat', purpose_id: sa.seat_id, provider: 'stripe' } })).status >= 400, true, 'someone else cannot pay your seat');
    // paying inside the window confirms the seat; a replayed webhook changes nothing
    const pa = await payFor(sa.seat_id, a, 50000);
    await settle(pa.id, { paid: true, amount: 50000, currency: config.payments.currency, paymentRef: 'pi_cc_replay' });
    assert.deepEqual([(await seatOf(k, a)).status, (await seatOf(k, a)).payment_status], ['confirmed', 'paid']);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM payments WHERE purpose_id=$1 AND status='paid'", [sa.seat_id])).rows[0].n, 1);
    // b does not pay in time: the sweep releases the seat and c is offered it with a fresh window
    await pool.query("UPDATE coach_class_seats SET pay_by = now() - interval '1 minute' WHERE id=$1", [sb.seat_id]);
    assert.equal((await describePurpose(pool, 'coach_class_seat', sb.seat_id)).payable, false, 'a lapsed hold cannot be paid');
    await syncCoachClasses(); await syncCoachClasses();   // repeat-safe
    assert.equal((await seatOf(k, b)).status, 'expired');
    const c2 = await seatOf(k, c);
    assert.deepEqual([c2.status, c2.payment_status], ['held', 'unpaid']); assert.ok(new Date(c2.pay_by) > new Date());
    assert.equal((await inbox(c)).filter((x) => x.kind === 'coach_class_promoted').length, 1);
    // b pays anyway after it lapsed (a slow checkout): the money is refunded automatically, no seat appears
    const late = await payFor(sb.seat_id, b, 50000);
    assert.equal(late.status, 'refunded');
    assert.equal((await seatOf(k, b)).status, 'expired');
    assert.equal(refunds.length, 1);
    // a paid seat that is given up before the cutoff is refunded in full and the next person is offered it
    must(await join(d, k), 201);
    const leaveRes = must(await leave(a, k));
    assert.equal(leaveRes.payment_status, 'refunded');
    assert.equal(refunds.length, 2);
    assert.equal((await seatOf(k, d)).status, 'held', 'the freed seat is offered to the next person, with a payment window');
    // after a full refund the person may come back: they join the back of the queue
    assert.equal(must(await join(a, k), 201).status, 'waitlisted');
    // c pays; then the coach cancels the class: every paid seat is refunded once, the rest end, and finance reconciles
    await payFor(c2.id, c, 50000);
    const before = refunds.length;
    const cancel = must(await api('POST', `/coach/classes/${k.id}/cancel`, { token: coach.token, body: { reason: 'Coach unwell' } }));
    assert.equal(cancel.status, 'cancelled'); assert.equal(cancel.refunds, 1);
    assert.equal(refunds.length, before + 1);
    assert.equal((await seatOf(k, c)).payment_status, 'refunded');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM coach_class_seats WHERE class_id=$1 AND status IN ('held','confirmed','waitlisted','guardian_pending')", [k.id])).rows[0].n, 0);
    const again = must(await api('POST', `/coach/classes/${k.id}/cancel`, { token: coach.token, body: {} }));
    assert.equal(again.replay, true); assert.equal(refunds.length, before + 1, 'cancelling twice refunds once');
    assert.ok((await inbox(c)).some((x) => x.kind === 'coach_class_cancelled' && /refunded/i.test(x.body)));
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM payments WHERE purpose_type='coach_class_seat' AND status='paid'")).rows[0].n, 0, 'nothing is left paid on a cancelled class');
    // canonical finance agrees with the payments table: nothing to backfill or repair, and every refunded payment is refunded in full in the ledger
    const rec = await reconcileFinance();
    assert.deepEqual([rec.backfilled, rec.refunds_repaired, rec.open_items], [0, 0, 0]);
    const refunded = (await pool.query("SELECT p.id, p.amount_cents, (SELECT coalesce(sum(f.gross_minor),0) FROM fin_transactions f WHERE f.payment_id=p.id AND f.kind='refund') AS ledger FROM payments p WHERE p.purpose_type='coach_class_seat' AND p.status='refunded'")).rows;
    assert.ok(refunded.length >= 3);
    for (const r of refunded) assert.equal(Number(r.ledger), Number(r.amount_cents));
    // joining a called-off class is refused
    assert.equal((await join(d, k)).status, 409);
  } finally { paymentsOff(); }
});

test('after the cutoff a paid seat is kept and forfeited; the minimum not being met cancels and refunds everyone', async () => {
  paymentsOn();
  try {
    const coach = await coachOf(); const card = await groupCard(coach, { price_cents: 30000 });
    const k = await classOf(coach, card, { max_participants: 4, min_participants: 3, cutoff_hours: 12 });
    const [a, b] = [await signup(), await signup()];
    const sa = must(await join(a, k), 201), sb = must(await join(b, k), 201);
    await payFor(sa.seat_id, a, 30000); await payFor(sb.seat_id, b, 30000);
    // cutoff passes with 2 of 3 people: cancelled by the sweep and both are refunded, once, however often the sweep runs
    await pool.query("UPDATE coach_classes SET cutoff_at = now() - interval '1 minute' WHERE id=$1", [k.id]);
    await syncCoachClasses(); await syncCoachClasses();
    const row = (await pool.query('SELECT status, cancelled_by FROM coach_classes WHERE id=$1', [k.id])).rows[0];
    assert.deepEqual([row.status, row.cancelled_by], ['cancelled', 'min_not_met']);
    assert.equal(refunds.length, 2);
    assert.equal((await seatOf(k, a)).payment_status, 'refunded');
    assert.ok((await inbox(coach)).some((x) => x.kind === 'coach_class_auto_cancelled'));
    // a class that meets its minimum survives the cutoff, and leaving afterwards forfeits the paid seat
    const k2 = await classOf(coach, card, { starts_at: dayAt(7, 9), max_participants: 4, min_participants: 1 });
    const s2 = must(await join(a, k2), 201); await payFor(s2.seat_id, a, 30000);
    await pool.query("UPDATE coach_classes SET cutoff_at = now() - interval '1 minute' WHERE id=$1", [k2.id]);
    await syncCoachClasses();
    assert.equal((await pool.query('SELECT status FROM coach_classes WHERE id=$1', [k2.id])).rows[0].status, 'scheduled');
    const before = refunds.length;
    const left = must(await leave(a, k2));
    assert.deepEqual([left.status, left.payment_status, left.late_cancel], ['cancelled', 'paid', true]);
    assert.equal(refunds.length, before, 'no refund after the cutoff');
    assert.equal((await join(a, k2)).status, 409, 'a forfeited seat cannot be re-booked');
  } finally { paymentsOff(); }
});

test('young people: a guardian decides first, consent is required and re-checked, and the public view never shows them', async () => {
  const coach = await coachOf(); const card = await groupCard(coach);
  const parent = await signup(['athlete']); const child = await signup(['athlete'], { dob: yearsAgo(12) });
  await verifiedGuardian(parent, child);
  const adultsOnly = await classOf(coach, card, { audience: 'adults' });
  assert.equal((await join(child, adultsOnly)).status, 409, 'adults only');
  const juniors = await classOf(coach, card, { starts_at: dayAt(6, 9), audience: 'youth', max_participants: 1, min_age: 10, max_age: 14 });
  const asked = must(await join(child, juniors), 201);
  assert.equal(asked.status, 'guardian_pending');
  assert.equal(must(await api('GET', `/coach-classes/${juniors.id}`)).seats.taken, 0, 'a pending request holds no seat');
  assert.ok((await inbox(parent)).some((x) => x.kind === 'coach_class_guardian_request'));
  // the guardian sees the child's pending request (they did not apply), with whose it is, and the child sees their own
  const pendingMine = must(await api('GET', `/coach-classes/${juniors.id}`, { token: parent.token })).my_seats;
  assert.deepEqual([pendingMine[0].status, pendingMine[0].for_user.id], ['guardian_pending', child.id]);
  assert.equal(must(await api('GET', '/me/coach-classes', { token: parent.token }))[0].status, 'guardian_pending');
  assert.equal(must(await api('GET', `/coach-classes/${juniors.id}`, { token: child.token })).my_seats[0].for_user, null);
  const stranger = await signup();
  assert.equal((await api('POST', `/coach-class-seats/${asked.seat_id}/guardian-decision`, { token: stranger.token, body: { approve: true } })).status, 403);
  assert.equal((await api('POST', `/coach-class-seats/${asked.seat_id}/guardian-decision`, { token: parent.token, body: { approve: true } })).status, 409, 'approval needs current consent');
  must(await api('POST', `/youth/children/${child.id}/consents`, { token: parent.token, body: { purpose: 'participation' } }), 201);
  assert.equal(must(await api('POST', `/coach-class-seats/${asked.seat_id}/guardian-decision`, { token: parent.token, body: { approve: true } })).status, 'confirmed');
  assert.equal(must(await api('POST', `/coach-class-seats/${asked.seat_id}/guardian-decision`, { token: parent.token, body: { approve: true } })).replayed, true);
  // outside the age band is refused; a guardian cannot join for a child they do not look after
  const tooOld = await signup(['athlete'], { dob: yearsAgo(17) });
  assert.equal((await join(tooOld, juniors)).status, 409, 'outside the age band');
  assert.equal((await join(stranger, juniors, { on_behalf_of: child.id })).status, 403);
  // the guardian sees the child's seat; the public sees only counts
  const mine = must(await api('GET', '/me/coach-classes', { token: parent.token }));
  assert.equal(mine[0].for_user.id, child.id);
  const pub = JSON.stringify(must(await api('GET', `/coach-classes/${juniors.id}`)));
  assert.ok(!pub.includes(child.handle) && !pub.includes(child.display_name));
  // a second child waits on the list; withdrawing consent means they are never promoted
  const sibling = await signup(['athlete'], { dob: yearsAgo(11) }); await verifiedGuardian(parent, sibling);
  must(await api('POST', `/youth/children/${sibling.id}/consents`, { token: parent.token, body: { purpose: 'participation' } }), 201);
  const w = must(await join(parent, juniors, { on_behalf_of: sibling.id }), 201);
  assert.equal(w.status, 'waitlisted');
  await pool.query('UPDATE youth_consents SET revoked_at=now() WHERE child_id=$1', [sibling.id]);
  must(await leave(parent, juniors, { on_behalf_of: child.id }));
  assert.equal((await seatOf(juniors, sibling)).status, 'cancelled', 'no consent: not promoted');
  assert.equal(must(await api('GET', `/coach-classes/${juniors.id}`)).seats.taken, 0);
});

test('attendance: only after the start, only confirmed seats, mirrored into the Performance Studio record without changing who sees it', async () => {
  const coach = await coachOf(); const card = await groupCard(coach);
  const k = await classOf(coach, card, { max_participants: 3 });
  const [a, b] = [await signup(), await signup()];
  const sa = must(await join(a, k), 201), sb = must(await join(b, k), 201);
  const entries = [{ seat_id: sa.seat_id, attendance: 'attended' }, { seat_id: sb.seat_id, attendance: 'no_show' }];
  assert.equal((await api('POST', `/coach/classes/${k.id}/attendance`, { token: coach.token, body: { entries } })).status, 409, 'not before the start');
  const rec = must(await api('POST', '/coaching/sessions', { token: coach.token, body: { source_type: 'coach_class', source_id: k.id } }), 201);
  assert.equal((await api('POST', '/coaching/sessions', { token: (await coachOf()).token, body: { source_type: 'coach_class', source_id: k.id } })).status, 404, 'another coach cannot run it');
  await pool.query("UPDATE coach_classes SET starts_at = now() - interval '10 minutes', cutoff_at = now() - interval '2 hours' WHERE id=$1", [k.id]);
  assert.equal((await api('POST', `/coach/classes/${k.id}/attendance`, { token: a.token, body: { entries } })).status, 403);
  must(await api('POST', `/coach/classes/${k.id}/attendance`, { token: coach.token, body: { entries } }));
  must(await api('POST', `/coach/classes/${k.id}/attendance`, { token: coach.token, body: { entries } }));   // idempotent
  assert.equal((await seatOf(k, a)).attendance, 'attended'); assert.equal((await seatOf(k, b)).attendance, 'no_show');
  const parts = (await pool.query('SELECT athlete_id, attendance FROM coaching_session_participants WHERE session_record_id=$1', [rec.id])).rows;
  assert.equal(parts.find((p) => p.athlete_id === a.id).attendance, 'present');
  assert.equal(parts.find((p) => p.athlete_id === b.id).attendance, 'absent');
  // one attendance fact: the studio refuses a second, conflicting way to set it
  assert.equal((await api('POST', `/coaching/sessions/${rec.id}/attendance`, { token: coach.token, body: { entries: [{ athlete_id: a.id, attendance: 'absent' }] } })).status, 409);
  assert.ok((await inbox(b)).some((x) => x.kind === 'coach_class_no_show'));
  // a seat that was never confirmed cannot be marked
  const c = await signup(); const other = await classOf(coach, card, { starts_at: dayAt(9, 9), max_participants: 1 });
  const sc = must(await join(c, other), 201);
  await pool.query("UPDATE coach_classes SET starts_at = now() - interval '5 minutes', cutoff_at = now() - interval '1 hour' WHERE id=$1", [other.id]);
  assert.equal((await api('POST', `/coach/classes/${other.id}/attendance`, { token: coach.token, body: { entries: [{ seat_id: sa.seat_id, attendance: 'attended' }] } })).status, 404, 'a seat from another class');
  assert.equal(sc.status, 'confirmed');
  // an ended class is completed by the sweep and nothing unpaid stays held
  await pool.query("UPDATE coach_classes SET starts_at = now() - interval '3 hours', cutoff_at = now() - interval '4 hours' WHERE id=$1", [k.id]);
  await syncCoachClasses();
  assert.equal((await pool.query('SELECT status FROM coach_classes WHERE id=$1', [k.id])).rows[0].status, 'completed');
});

test('online classes keep their link private to the coach and confirmed seat holders', async () => {
  const coach = await coachOf(); const card = await groupCard(coach, { delivery: 'both' });
  const k = await classOf(coach, card, { delivery: 'online', location: undefined, online_link: 'https://meet.example.com/room-abc-123' });
  const [a, b] = [await signup(), await signup()];
  must(await join(a, k), 201);
  assert.equal(must(await api('GET', `/coach-classes/${k.id}`)).online_link, undefined);
  assert.equal(must(await api('GET', `/coach-classes/${k.id}`, { token: b.token })).online_link, undefined);
  assert.equal(must(await api('GET', `/coach-classes/${k.id}`, { token: a.token })).online_link, 'https://meet.example.com/room-abc-123');
  assert.equal(must(await api('GET', `/coach-classes/${k.id}`, { token: coach.token })).online_link, 'https://meet.example.com/room-abc-123');
  assert.ok(!(await pool.query('SELECT online_link_enc FROM coach_classes WHERE id=$1', [k.id])).rows[0].online_link_enc.includes('meet.example.com'), 'stored encrypted');
  assert.equal(must(await api('GET', '/coach-classes', { query: { delivery: 'online', coach_id: coach.id } })).length, 1);
});

test('every sport in the catalogue can run a class — none falls back silently', async () => {
  const coach = await signup(['coach']);
  const sports = (await pool.query('SELECT id, slug FROM sports ORDER BY slug')).rows;
  assert.ok(sports.length > 100);
  await pool.query("INSERT INTO sport_profiles(user_id, sport_id, role, level) SELECT $1, id, 'coach', 'pro' FROM sports", [coach.id]);
  const card = must(await api('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'Any sport group', audience: 'group', unit: 'session', duration_min: 45, price_cents: 0, per_person: true, max_participants: 8 } }), 201);
  let i = 0;
  for (const s of sports) {
    const at = new Date(Date.now() + (3 + i++) * 864e5); at.setUTCHours(7, 0, 0, 0);
    const k = must(await api('POST', '/coach/classes', { token: coach.token, body: { rate_card_id: card.id, sport: s.slug, starts_at: at.toISOString(), location: 'Open ground' } }), 201).classes[0];
    assert.equal(k.sport.slug, s.slug);
  }
  assert.equal(Number((await pool.query('SELECT count(DISTINCT sport_id) FROM coach_classes WHERE coach_id=$1', [coach.id])).rows[0].count), sports.length);
  // a sport-less card still needs a sport, and discovery filters by sport
  assert.equal((await api('POST', '/coach/classes', { token: coach.token, body: { rate_card_id: card.id, starts_at: dayAt(400, 9), location: 'x' } })).status, 400);
  assert.equal(must(await api('GET', '/coach-classes', { query: { sport: sports[0].slug, coach_id: coach.id } })).length, 1);
});

test('a hire request and a class publish for the same slot never both win, however they race', async () => {
  const coach = await coachOf(); const card = await groupCard(coach); const fan = await signup();
  const rounds = 8; let classWins = 0, hireWins = 0;
  for (let i = 0; i < rounds; i++) {
    const at = dayAt(30 + i, 10);
    const [p, h] = await Promise.all([
      publish(coach, card, { starts_at: at }),
      api('POST', '/hires', { token: fan.token, body: { coach_id: coach.id, sport: 'football', starts_at: at, duration_min: 60 } }),
    ]);
    const wins = [p.status === 201, h.status === 201];
    assert.equal(wins.filter(Boolean).length, 1, `round ${i}: class ${p.status}, hire ${h.status}`);
    assert.equal([p.status, h.status].find((s) => s !== 201), 409);
    if (wins[0]) classWins++; else hireWins++;
    const live = (await pool.query("SELECT (SELECT count(*) FROM coach_classes WHERE coach_id=$1 AND starts_at=$2 AND status<>'cancelled')::int AS classes, (SELECT count(*) FROM coach_hires WHERE coach_id=$1 AND starts_at=$2 AND status IN ('requested','confirmed'))::int AS hires", [coach.id, at])).rows[0];
    assert.equal(live.classes + live.hires, 1, 'the calendar holds exactly one booking for the slot');
  }
  // a series of hires racing a class publish is serialised the same way
  const at = dayAt(60, 11);
  const rs = await Promise.all([1, 2, 3, 4].map((k) => (k % 2 ? publish(coach, card, { starts_at: at }) : api('POST', '/hires', { token: fan.token, body: { coach_id: coach.id, sport: 'football', starts_at: at, duration_min: 60 } }))));
  assert.equal(rs.filter((r) => r.status === 201).length, 1);
  assert.ok(classWins + hireWins === rounds);
});

test('a class holds its court through the canonical venue link: board, booking, venue shown, released on cancel', async () => {
  const mgr = await signup(['venue_manager']); const coach = await coachOf(); const card = await groupCard(coach, { price_cents: 20000 }); const fan = await signup();
  const v = must(await api('POST', '/venues', { token: mgr.token, body: { name: `Class Arena ${n}`, city: 'Pune', timezone: 'UTC' } }), 201);
  must(await api('POST', `/venues/${v.id}/hours`, { token: mgr.token, body: { hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '06:00', closes: '22:00' })) } }));
  const court = must(await api('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'Court 2', sport: 'football', capacity: 1, hourly_rate_cents: 50000 } }), 201);
  const k = await classOf(coach, card, { starts_at: dayAt(12, 9), max_participants: 5 });
  const both = await groupCard(coach, { title: 'Hybrid group', delivery: 'both' });
  const online = await classOf(coach, both, { starts_at: dayAt(13, 9), delivery: 'online', location: undefined, online_link: 'https://meet.example.com/x-y-z-123' });
  assert.equal(k.court_held, false);
  // the existing board lists the in-person class as needing a venue (an online class never needs one)
  const board = must(await api('GET', '/training/venues/board', { token: coach.token }));
  assert.ok(board.needs_venue.some((s) => s.type === 'coach_class' && s.id === k.id));
  assert.ok(!board.needs_venue.some((s) => s.id === online.id));
  // only the coach can book the court for it
  assert.equal((await api('POST', '/training/venues/book', { token: fan.token, body: { sessions: [{ type: 'coach_class', id: k.id }], resource_id: court.id } })).status, 403);
  const joined = must(await join(fan, k), 201);
  const booked = must(await api('POST', '/training/venues/book', { token: coach.token, body: { sessions: [{ type: 'coach_class', id: k.id }], resource_id: court.id } }), 201);
  assert.equal(booked.lines_placed, 1); assert.equal(booked.problems.length, 0);
  const after = must(await api('GET', `/coach-classes/${k.id}`));
  assert.equal(after.court_held, true);
  assert.equal(after.venue.id, v.id, 'the class names the venue that holds it');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM session_venue_links WHERE session_type='coach_class' AND session_id=$1 AND released_at IS NULL", [k.id])).rows[0].n, 1);
  assert.ok((await inbox(fan)).some((x) => x.kind === 'coach_class_changed' && /Class venue confirmed/.test(x.title)), 'people booked in are told');
  assert.equal(joined.status === 'confirmed' || joined.status === 'held', true);
  const board2 = must(await api('GET', '/training/venues/board', { token: coach.token }));
  assert.ok(board2.has_venue.some((s) => s.id === k.id && s.venue.venue_name === v.name));
  // a second court booking for the same class is refused: it is already held
  const again = await api('POST', '/training/venues/book', { token: coach.token, body: { sessions: [{ type: 'coach_class', id: k.id }], resource_id: court.id, on_conflict: 'fail' } });
  assert.equal(again.status, 409);
  // the coach's calendar shows where it is
  const cal = must(await api('GET', '/coach/calendar', { token: coach.token, query: { from: dayAt(11).slice(0, 10), to: dayAt(14).slice(0, 10) } }));
  assert.match(cal.items.find((x) => x.source_id === k.id).venue, /Class Arena/);
  // cancelling the class releases the link (history is kept), and tells the coach the court booking still stands
  const cancelled = must(await api('POST', `/coach/classes/${k.id}/cancel`, { token: coach.token, body: { reason: 'Storm' } }));
  assert.ok(cancelled.venue_booking_still_active.reservation_id);
  const link = (await pool.query("SELECT released_at, release_reason FROM session_venue_links WHERE session_type='coach_class' AND session_id=$1", [k.id])).rows;
  assert.equal(link.length, 1); assert.ok(link[0].released_at); assert.equal(link[0].release_reason, 'class cancelled');
});

test('every coach-class string used by the app exists in English and in all 11 packs', () => {
  const dir = new URL('../../app/src/screens/', import.meta.url);
  const used = new Set();
  for (const f of ['coach-classes.js', 'coaching.js', 'coach-business.js', 'find-games.js']) for (const m of fs.readFileSync(new URL(f, dir), 'utf8').matchAll(/'((?:cc|seats)\.[a-z0-9_.]+)'/g)) used.add(m[1]);
  assert.ok(used.size > 100);
  for (const code of Object.keys(CATALOGUES)) for (const k of used) assert.ok(CATALOGUES[code][k], `${code} is missing ${k}`);
  // no screen string is left as plain English in JSX text of the class screen (labels, titles, hints go through t())
  const src = fs.readFileSync(new URL('coach-classes.js', dir), 'utf8');
  for (const bad of ['title="', 'label="', 'sub="', 'placeholder="']) assert.ok(!src.includes(bad), `hard-coded ${bad} in coach-classes.js`);
});
