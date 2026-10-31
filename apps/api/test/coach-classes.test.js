import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { config } = await import('../src/config.js');
const { settle } = await import('../src/payments/service.js');
const { syncCoachClasses } = await import('../src/coach-classes-sweeps.js');
const { capabilities } = await import('../src/capabilities/index.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const signup = async (roles = ['athlete'], extra = {}) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `cc_${n}_${roles[0]}`, display_name: `Person ${n}`, email: `cc${n}@example.com`, password: 'correct-horse-battery', roles, dob: yearsAgo(30), ...extra } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const inHours = (h) => new Date(Date.now() + h * 36e5).toISOString();
const evidence = { reference: 'https://example.com/birth-certificate-ref-123', label: 'Birth certificate' };
async function verifiedGuardian(parent, child) {
  const l = must(await api('POST', '/youth/guardian-links', { token: parent.token, body: { guardian_id: parent.id, child_id: child.id, relationship: 'parent' } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: child.token, body: { accept: true } }));
  must(await api('POST', `/youth/guardian-links/${l.id}/evidence`, { token: parent.token, body: { evidence } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Documents match' } }));
}
const coaches = new Set();
const card = async (coach, body = {}) => { // a coach lists a sport on their profile before pricing it
  const sport = body.sport ?? 'football';
  if (!coaches.has(`${coach.id}:${sport}`)) { must(await api('POST', '/me/sport-profiles', { token: coach.token, body: { sport, role: 'coach', level: 'pro', hourly_rate_cents: 70000 } }), 201); coaches.add(`${coach.id}:${sport}`); }
  return cardFor(coach, body);
};
const cardFor = async (coach, body = {}) => must(await api('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'Group clinic', sport: 'football', audience: 'group', delivery: 'both', unit: 'session', duration_min: 60, price_cents: 50000, per_person: true, min_participants: 1, max_participants: 10, ...body } }), 201);
const publish = async (coach, c, body = {}) => api('POST', '/coach/classes', { token: coach.token, body: { rate_card_id: c.id, starts_at: inHours(48), online_url: 'https://meet.example.com/clinic', ...body } });
const join = (u, k, body = {}) => api('POST', `/coach/classes/${k.id}/join`, { token: u.token, body });
const leave = (u, k, body = {}) => api('POST', `/coach/classes/${k.id}/leave`, { token: u.token, body });
const seatsOf = async (k, ...st) => (await pool.query('SELECT * FROM coach_class_seats WHERE class_id=$1 AND status = ANY($2) ORDER BY created_at, id', [k.id, st])).rows;

const realFetch = globalThis.fetch;
let refunds = [];
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('cc_root','cc_root','{admin}','x','x','cc_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { globalThis.fetch = realFetch; server.close(); await pool.end(); });

/** Turn paid seats on with a stand-in Stripe that records refunds, so the money path is exercised without a network. */
function stripeOn() {
  config.payments.stripe.secretKey = 'sk_test_x';
  config.payments.stripe.base = 'http://stripe.invalid';
  refunds = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('http://stripe.invalid')) { refunds.push({ url: String(url), key: init.headers['idempotency-key'] }); return new Response(JSON.stringify({ id: 're_1', status: 'succeeded' }), { status: 200, headers: { 'content-type': 'application/json' } }); }
    return realFetch(url, init);
  };
}
const stripeOff = () => { config.payments.stripe.secretKey = undefined; globalThis.fetch = realFetch; };
async function pay(seat, user) {
  const p = (await pool.query("INSERT INTO payments(payer_id, provider, purpose_type, purpose_id, amount_cents, currency, status, provider_ref) VALUES ($1,'stripe','coach_class_seat',$2,$3,$4,'pending',$5) RETURNING *", [user.id, seat.seat_id ?? seat.id, seat.amount_cents, config.payments.currency, `cs_${Math.random()}`])).rows[0];
  await pool.query("UPDATE payments SET provider_payment_ref='pi_test' WHERE id=$1", [p.id]);
  await settle(p.id, { paid: true, amount: Number(p.amount_cents), currency: p.currency, paymentRef: 'pi_test' });
  return p;
}

test('every coach-class capability is a REST route, an OpenAPI operation and an MCP tool from one definition', () => {
  const names = capabilities.filter((c) => c.tag === 'Coach classes').map((c) => c.name);
  for (const x of ['publish_coach_class', 'get_coach_class', 'list_coach_classes', 'join_coach_class', 'leave_coach_class', 'cancel_coach_class', 'record_coach_class_attendance', 'complete_coach_class', 'guardian_decide_coach_class_join']) assert.ok(names.includes(x), x);
});

test('publishing is for coaches, from a group card, and the calendar must be free', async () => {
  const coach = await signup(['coach']); const athlete = await signup();
  const g = await card(coach); const solo = must(await api('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'One to one', sport: 'football', audience: 'individual', unit: 'hour', price_cents: 70000 } }), 201);
  assert.equal((await publish(athlete, g)).status, 403, 'only a coach publishes');
  assert.equal((await publish(coach, solo)).status, 400, 'an individual card cannot be a class');
  assert.equal((await api('POST', '/coach/classes', { token: coach.token, body: { rate_card_id: g.id, starts_at: inHours(48) } })).status, 400, 'a venue or link is required');
  assert.equal((await publish(coach, g, { starts_at: inHours(-2) })).status, 400);
  assert.equal((await publish(coach, g, { max_participants: 11 })).status, 400, 'cannot exceed the card');
  const k = must(await publish(coach, g, { starts_at: inHours(48), max_participants: 4, min_participants: 2 }), 201);
  assert.equal(k.max_participants, 4); assert.equal(k.price_cents, 50000); assert.equal(k.seats_left, 4); assert.equal(k.sport_slug, 'football');
  const clash = await publish(coach, g, { starts_at: inHours(48.5) });
  assert.equal(clash.status, 409); assert.equal(clash.body.error.details.code, 'coach_busy');
  // a hire on the same calendar blocks a class too
  const hirer = await signup();
  const hire = must(await api('POST', '/hires', { token: hirer.token, body: { coach_id: coach.id, sport: 'football', starts_at: inHours(100), duration_min: 60 } }), 201);
  assert.ok(hire.id);
  assert.equal((await publish(coach, g, { starts_at: inHours(100.25) })).status, 409);
});

test('seats are never oversold under concurrency, and the public sees counts only', async () => {
  const coach = await signup(['coach']); const g = await card(coach);
  const k = must(await publish(coach, g, { max_participants: 3 }), 201);
  const people = await Promise.all(Array.from({ length: 8 }, () => signup()));
  const results = await Promise.all(people.map((p) => join(p, k)));
  for (const r of results) assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((await seatsOf(k, 'confirmed')).length, 3, 'exactly the seat count is confirmed');
  assert.equal((await seatsOf(k, 'waitlisted')).length, 5);
  const pub = must(await api('GET', `/coach/classes/${k.id}`));
  assert.equal(pub.seats_left, 0); assert.equal(pub.is_full, true); assert.equal(pub.waitlist, 5);
  assert.equal(pub.seats, undefined, 'no seat list for the public'); assert.equal(JSON.stringify(pub).includes(people[0].handle), false);
  assert.equal(pub.online_url, undefined, 'the online link is for seat holders');
  const holder = (await seatsOf(k, 'confirmed'))[0];
  const who = people.find((p) => p.id === holder.user_id);
  assert.ok(must(await api('GET', `/coach/classes/${k.id}`, { token: who.token })).online_url);
  const listed = must(await api('GET', '/coach/classes', { query: { coach_id: coach.id } }));
  assert.equal(listed.length, 1); assert.equal(listed[0].seats_left, 0);
  assert.equal(must(await api('GET', '/coach/classes', { query: { coach_id: coach.id, has_seats: 'true' } })).length, 0);
});

test('joining is idempotent, and the waitlist promotes in order exactly once', async () => {
  const coach = await signup(['coach']); const g = await card(coach);
  const k = must(await publish(coach, g, { max_participants: 2 }), 201);
  const [a, b, c1, d] = await Promise.all([signup(), signup(), signup(), signup()]);
  must(await join(a, k, { idempotency_key: 'retry-key-1' }), 201);
  const again = must(await join(a, k, { idempotency_key: 'retry-key-1' }), 201);
  assert.equal(again.replayed, true); assert.equal((await seatsOf(k, 'confirmed')).length, 1);
  must(await join(b, k), 201); must(await join(c1, k), 201); must(await join(d, k), 201);
  assert.deepEqual((await seatsOf(k, 'waitlisted')).map((s) => s.user_id), [c1.id, d.id]);
  must(await leave(a, k));
  assert.equal((await seatsOf(k, 'confirmed')).map((s) => s.user_id).sort().join(), [b.id, c1.id].sort().join(), 'the first in line gets the seat');
  must(await leave(a, k)); // repeating changes nothing
  assert.equal((await seatsOf(k, 'confirmed')).length, 2); assert.equal((await seatsOf(k, 'waitlisted')).length, 1);
  assert.equal(must(await api('GET', '/notifications', { token: c1.token })).items.filter((x) => x.kind === 'coach_class_promoted').length, 1, 'told once');
  // a returning member rejoins at the back, not their old place
  must(await join(a, k), 201);
  assert.deepEqual((await seatsOf(k, 'waitlisted')).map((s) => s.user_id), [d.id, a.id]);
});

test('paid seats are held, paid, refunded on a coach cancel, and a lapsed hold is offered to the next person', async () => {
  stripeOn();
  try {
    const coach = await signup(['coach']); const g = await card(coach);
    const k = must(await publish(coach, g, { max_participants: 1, payment_window_minutes: 5 }), 201);
    const [a, b] = await Promise.all([signup(), signup()]);
    const sa = must(await join(a, k), 201);
    assert.equal(sa.status, 'held'); assert.equal(sa.payment_status, 'unpaid'); assert.equal(sa.amount_cents, 50000);
    must(await join(b, k), 201);
    assert.equal((await seatsOf(k, 'waitlisted')).length, 1, 'a held seat counts against capacity');
    // the hold lapses: released and offered to the waitlist with its own window
    await pool.query("UPDATE coach_class_seats SET hold_expires_at = now() - interval '1 minute' WHERE id=$1", [sa.seat_id]);
    await syncCoachClasses(); await syncCoachClasses();
    assert.equal((await pool.query('SELECT status FROM coach_class_seats WHERE id=$1', [sa.seat_id])).rows[0].status, 'cancelled');
    const heldB = (await seatsOf(k, 'held'))[0];
    assert.equal(heldB.user_id, b.id); assert.ok(new Date(heldB.hold_expires_at) > new Date());
    await pay(heldB, b);
    assert.equal((await seatsOf(k, 'confirmed'))[0].user_id, b.id); assert.equal((await seatsOf(k, 'confirmed'))[0].payment_status, 'paid');
    // the coach cancels: refunded through the provider, once, with a stable key
    must(await api('POST', `/coach/classes/${k.id}/cancel`, { token: coach.token, body: { reason: 'Coach unwell' } }));
    assert.equal((await pool.query('SELECT payment_status, status FROM coach_class_seats WHERE id=$1', [heldB.id])).rows[0].payment_status, 'refunded');
    assert.equal(refunds.length, 1);
    must(await api('POST', `/coach/classes/${k.id}/cancel`, { token: coach.token, body: { reason: 'Coach unwell' } }));
    assert.equal(refunds.length, 1, 'repeating never refunds twice');
    assert.equal((await pool.query("SELECT status, refunded_cents, amount_cents FROM payments WHERE purpose_id=$1", [heldB.id])).rows[0].status, 'refunded');
    assert.equal(must(await api('GET', '/notifications', { token: b.token })).items.some((x) => x.kind === 'coach_class_cancelled'), true);
  } finally { stripeOff(); }
});

test('a late leave is not refunded, an early leave is', async () => {
  stripeOn();
  try {
    const coach = await signup(['coach']); const g = await card(coach);
    const early = must(await publish(coach, g, { starts_at: inHours(72), cancel_before_hours: 12 }), 201);
    const late = must(await publish(coach, g, { starts_at: inHours(6), cancel_before_hours: 12, min_cutoff_hours: 0 }), 201);
    const [a, b] = await Promise.all([signup(), signup()]);
    const sa = must(await join(a, early), 201); await pay(sa, a);
    const sb = must(await join(b, late), 201); await pay(sb, b);
    const ra = must(await leave(a, early)); assert.equal(ra.payment_status, 'refunded'); assert.equal(ra.late_cancel, false);
    const rb = must(await leave(b, late)); assert.equal(rb.payment_status, 'not_refundable'); assert.equal(rb.late_cancel, true);
    assert.equal(refunds.length, 1);
  } finally { stripeOff(); }
});

test('under the minimum at the cut-off the class cancels itself and refunds everyone', async () => {
  stripeOn();
  try {
    const coach = await signup(['coach']); const g = await card(coach);
    const k = must(await publish(coach, g, { starts_at: inHours(24), min_participants: 3, max_participants: 6, min_cutoff_hours: 6 }), 201);
    const [a, b] = await Promise.all([signup(), signup()]);
    const sa = must(await join(a, k), 201); await pay(sa, a);
    const sb = must(await join(b, k), 201); await pay(sb, b);
    await syncCoachClasses();
    assert.equal(must(await api('GET', `/coach/classes/${k.id}`)).status, 'open', 'not yet at the cut-off');
    await pool.query("UPDATE coach_classes SET starts_at = now() + interval '5 hours', min_cutoff_hours = 6 WHERE id=$1", [k.id]);
    await syncCoachClasses(); await syncCoachClasses();
    assert.equal(must(await api('GET', `/coach/classes/${k.id}`)).status, 'cancelled');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM coach_class_seats WHERE class_id=$1 AND payment_status='refunded'", [k.id])).rows[0].n, 2);
    assert.equal(refunds.length, 2);
    assert.equal(must(await api('GET', '/notifications', { token: coach.token })).items.some((x) => x.kind === 'coach_class_auto_cancelled'), true);
  } finally { stripeOff(); }
});

test('young people need a guardian: adult-only classes refuse them and consent is checked live', async () => {
  const coach = await signup(['coach']); const parent = await signup(['athlete']); const child = await signup(['athlete'], { dob: yearsAgo(12) });
  await verifiedGuardian(parent, child);
  const g = await card(coach);
  const adults = must(await publish(coach, g, { starts_at: inHours(50) }), 201);
  assert.equal((await join(child, adults)).status, 409);
  assert.equal((await join(parent, adults, { on_behalf_of: child.id })).status, 409);
  const juniors = must(await publish(coach, g, { starts_at: inHours(60), audience: 'youth', min_age: 8, max_age: 14 }), 201);
  const stranger = await signup();
  assert.equal((await join(stranger, juniors, { on_behalf_of: child.id })).status, 403, 'only a guardian can join for a child');
  const asked = must(await join(child, juniors), 201);
  assert.equal(asked.status, 'guardian_pending');
  assert.equal((await seatsOf(juniors, 'confirmed', 'held')).length, 0, 'no seat before the guardian approves');
  assert.equal(must(await api('GET', '/notifications', { token: parent.token })).items.some((x) => x.kind === 'coach_class_guardian_request'), true);
  assert.equal((await api('POST', `/coach/classes/${juniors.id}/seats/${asked.seat_id}/guardian-decision`, { token: parent.token, body: { decision: 'approve' } })).status, 409, 'approval needs the guardian\'s current consent');
  must(await api('POST', `/youth/children/${child.id}/consents`, { token: parent.token, body: { purpose: 'participation' } }), 201);
  const ok = must(await api('POST', `/coach/classes/${juniors.id}/seats/${asked.seat_id}/guardian-decision`, { token: parent.token, body: { decision: 'approve' } }));
  assert.equal(ok.status, 'confirmed');
  const pub = JSON.stringify(must(await api('GET', `/coach/classes/${juniors.id}`)));
  assert.equal(pub.includes(child.display_name), false, 'a young person is never named publicly');
  const coachView = must(await api('GET', `/coach/classes/${juniors.id}`, { token: coach.token }));
  assert.equal(coachView.seats[0].person.is_youth, true); assert.equal(coachView.seats[0].person.handle, undefined, 'no handle for a young person');
});

test('the coach records attendance, it mirrors into the coaching journal, and nothing is labelled automatically', async () => {
  const coach = await signup(['coach']); const g = await card(coach);
  const k = must(await publish(coach, g, { starts_at: inHours(48) }), 201);
  const [a, b] = await Promise.all([signup(), signup()]);
  const sa = must(await join(a, k), 201); const sb = must(await join(b, k), 201);
  assert.equal((await api('POST', `/coach/classes/${k.id}/seats/${sa.seat_id}/attendance`, { token: coach.token, body: { attendance: 'attended' } })).status, 409, 'not before it starts');
  const rec = must(await api('POST', '/coaching/sessions', { token: coach.token, body: { source_type: 'coach_class', source_id: k.id } }), 201);
  assert.ok(rec.id ?? rec.session?.id, 'the class is a journal source');
  await pool.query("UPDATE coach_classes SET starts_at = now() - interval '10 minutes' WHERE id=$1", [k.id]);
  must(await api('POST', `/coach/classes/${k.id}/seats/${sa.seat_id}/attendance`, { token: coach.token, body: { attendance: 'attended' } }));
  must(await api('POST', `/coach/classes/${k.id}/seats/${sb.seat_id}/attendance`, { token: coach.token, body: { attendance: 'no_show' } }));
  assert.equal((await api('POST', `/coach/classes/${k.id}/seats/${sa.seat_id}/attendance`, { token: a.token, body: { attendance: 'attended' } })).status, 403);
  const ws = must(await api('GET', `/coaching/sessions/${rec.id ?? rec.session.id}`, { token: coach.token }));
  const byId = Object.fromEntries(ws.participants.map((p) => [p.id, p.attendance]));
  assert.equal(byId[a.id], 'present'); assert.equal(byId[b.id], 'absent');
  assert.equal((await api('POST', `/coaching/sessions/${rec.id ?? rec.session.id}/attendance`, { token: coach.token, body: { entries: [{ athlete_id: a.id, attendance: 'late' }] } })).status, 409, 'one attendance fact, written in the class');
  must(await api('POST', `/coach/classes/${k.id}/complete`, { token: coach.token }));
  assert.equal(must(await api('GET', `/coach/classes/${k.id}`)).status, 'completed');
});

test('every sport in the catalogue can have a class published, joined and found', async () => {
  const coach = await signup(['coach']); const player = await signup();
  const sports = (await pool.query('SELECT slug FROM sports ORDER BY slug')).rows;
  assert.ok(sports.length > 20);
  let t = 0;
  for (const { slug } of sports) {
    const c = await card(coach, { sport: slug, title: `Clinic ${slug}` });
    const k = must(await publish(coach, c, { starts_at: inHours(200 + t * 3), max_participants: 2 }), 201); t++;
    assert.equal(k.sport_slug, slug);
    must(await join(player, k), 201);
  }
  let found = [];
  for (let offset = 0; ; offset += 100) { const pg = must(await api('GET', '/coach/classes', { query: { coach_id: coach.id, limit: '100', offset: String(offset) } })); found = found.concat(pg); if (pg.length < 100) break; }
  assert.equal(found.length, sports.length);
  assert.equal(must(await api('GET', '/coach/classes', { query: { coach_id: coach.id, sport: sports[0].slug } })).length, 1);
});
