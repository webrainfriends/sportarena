import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';

// stand-in for Stripe Checkout + refunds; records the idempotency key of every refund
const fake = { sessions: {}, refunds: [], keys: [], n: 0 };
const stripe = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString(), send = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
  if (req.url === '/v1/checkout/sessions' && req.method === 'POST') {
    const f = new URLSearchParams(raw); const id = `cs_${++fake.n}`;
    fake.sessions[id] = { id, amount_total: Number(f.get('line_items[0][price_data][unit_amount]')), currency: f.get('line_items[0][price_data][currency]'), name: 'x', payment_status: 'unpaid', payment_intent: `pi_${fake.n}` };
    return send(200, { id, url: `https://checkout.stripe.test/${id}` });
  }
  if (req.url.startsWith('/v1/checkout/sessions/')) { const s = fake.sessions[req.url.split('/').pop()]; return s ? send(200, s) : send(404, { error: { message: 'no such session' } }); }
  if (req.url === '/v1/refunds') {
    await new Promise((r) => setTimeout(r, 150)); // widen the race window
    fake.refunds.push(new URLSearchParams(raw).get('payment_intent')); fake.keys.push(req.headers['idempotency-key']);
    return send(200, { id: `re_${fake.refunds.length}` });
  }
  send(404, {});
});
await new Promise((r) => stripe.listen(0, '127.0.0.1', r));
Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_API_BASE: `http://127.0.0.1:${stripe.address().port}`, APP_URL: 'http://app.test', CORS_ORIGINS: 'http://app.test' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { expireStaleRequests } = await import('../src/lifecycle.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const signup = async (roles) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `lh_${n}_${roles[0]}`, display_name: `Lh ${n}`, email: `lh${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const inFuture = (days, hour = 9) => { const d = new Date(Date.now() + days * 864e5); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };
const patch = (path, user, status, reason) => api('PATCH', path, { token: user.token, body: { status, ...(reason ? { reason } : {}) } });
let slot = 0;
const coachOf = async () => {
  const coach = await signup(['coach']);
  ok(await api('POST', '/me/sport-profiles', { token: coach.token, body: { sport: 'football', role: 'coach', level: 'pro', hourly_rate_cents: 5000 } }), 201);
  return coach;
};
const doctor = async () => {
  const u = await signup(['doctor']);
  ok(await api('POST', '/me/sport-profiles', { token: u.token, body: { sport: 'football', role: 'doctor' } }), 201);
  ok(await api('POST', '/me/provider-profile', { token: u.token, body: { provider_type: 'doctor', consult_fee_cents: 120000 } }));
  await pool.query("INSERT INTO verification_cases(type, subject_type, subject_id, requested_by, status, rules_version, decided_at, expires_at) VALUES ('doctor','user',$1,$1,'approved',1,now(), now() + interval '300 days')", [u.id]);   // current credential, as clinical actions now require
  return u;
};
const hire = async (athlete, coach) => ok(await api('POST', '/hires', { token: athlete.token, body: { coach_id: coach.id, sport: 'football', starts_at: inFuture(30 + slot++, 9), duration_min: 60 } }), 201);
const appt = async (athlete, doc, reason) => ok(await api('POST', '/appointments', { token: athlete.token, body: { provider_id: doc.id, starts_at: inFuture(30 + slot++, 10), ...(reason ? { reason } : {}) } }), 201);
const pay = async (athlete, type, id) => {
  const p = ok(await api('POST', '/payments', { token: athlete.token, body: { purpose_type: type, purpose_id: id, provider: 'stripe' } }), 201);
  fake.sessions[p.checkout_url.split('/').pop()].payment_status = 'paid';
  assert.equal(ok(await api('POST', `/payments/${p.id}/confirm`, { token: athlete.token })).status, 'paid');
  return p;
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); stripe.close(); await pool.end(); });

test('timeline records every committed transition with actor, reason and payment state; parties only', async () => {
  const athlete = await signup(['athlete']), coach = await coachOf(), stranger = await signup(['athlete']);
  const h = await hire(athlete, coach);
  assert.equal((await patch(`/hires/${h.id}`, athlete, 'confirmed')).status, 403);
  assert.equal((await patch(`/hires/${h.id}`, coach, 'completed')).status, 409, 'a refused move leaves no history');
  await pay(athlete, 'coach_hire', h.id);
  ok(await patch(`/hires/${h.id}`, coach, 'confirmed'));
  ok(await patch(`/hires/${h.id}`, athlete, 'cancelled', 'Injured my ankle'));
  const t = ok(await api('GET', `/hires/${h.id}/timeline`, { token: athlete.token }));
  assert.deepEqual(t.entries.map((e) => [e.from_status, e.to_status]), [[null, 'requested'], ['requested', 'confirmed'], ['confirmed', 'cancelled']]);
  assert.equal(t.entries[0].actor_id, athlete.id, 'creation is attributed to the person who booked');
  assert.equal(t.entries[1].actor_id, coach.id); assert.equal(t.entries[1].actor_name, coach.display_name);
  assert.equal(t.entries[2].reason, 'Injured my ankle'); assert.equal(t.entries[2].actor_id, athlete.id);
  const stored = (await pool.query("SELECT reason_enc FROM engagement_status_history WHERE kind='hire' AND subject_id=$1 AND to_status='cancelled'", [h.id])).rows[0].reason_enc;
  assert.ok(stored && !stored.includes('ankle'), 'reason is encrypted at rest');
  assert.deepEqual(ok(await api('GET', `/hires/${h.id}/timeline`, { token: coach.token })).entries.map((e) => e.to_status), ['requested', 'confirmed', 'cancelled'], 'both parties see the same timeline');
  assert.equal((await api('GET', `/hires/${h.id}/timeline`, { token: stranger.token })).status, 403);
  assert.equal((await api('GET', `/hires/${h.id}/timeline`)).status, 401);
  assert.equal(ok(await api('GET', `/hires/${h.id}/timeline`, { token: athlete.token, query: { limit: 1, offset: 1 } })).entries.length, 1, 'paginated');
  assert.equal((await api('PATCH', `/hires/${h.id}`, { token: coach.token, body: { status: 'confirmed', reason: 'x'.repeat(501) } })).status, 400);

  const doc = await doctor();
  const a = await appt(athlete, doc, 'knee pain');
  await pay(athlete, 'appointment', a.id);
  ok(await patch(`/appointments/${a.id}`, doc, 'confirmed'));
  ok(await patch(`/appointments/${a.id}`, doc, 'cancelled', 'Clinic closed'));
  const at = ok(await api('GET', `/appointments/${a.id}/timeline`, { token: athlete.token }));
  assert.deepEqual(at.entries.map((e) => e.to_status), ['requested', 'confirmed', 'cancelled']);
  assert.equal(at.entries[2].reason, 'Clinic closed');
  assert.equal((await api('GET', `/appointments/${a.id}/timeline`, { token: stranger.token })).status, 403);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='read_clinical' AND entity='appointments' AND entity_id=$2", [athlete.id, a.id])).rowCount >= 1, 'decrypted reads are audit-logged');
});

test('history is append-only: update, delete and truncate are refused', async () => {
  const athlete = await signup(['athlete']), coach = await coachOf();
  const h = await hire(athlete, coach);
  await assert.rejects(pool.query("UPDATE engagement_status_history SET reason_enc='x' WHERE subject_id=$1", [h.id]), /append-only/);
  await assert.rejects(pool.query('DELETE FROM engagement_status_history WHERE subject_id=$1', [h.id]), /append-only/);
  await assert.rejects(pool.query('TRUNCATE engagement_status_history'), /append-only/);
});

test('expiry is recorded as a system transition; existing rows get one backfilled entry', async () => {
  const athlete = await signup(['athlete']), coach = await coachOf();
  const h = await hire(athlete, coach);
  await pool.query("UPDATE coach_hires SET starts_at = now() - interval '2 hours' WHERE id=$1", [h.id]);
  await expireStaleRequests();
  const t = ok(await api('GET', `/hires/${h.id}/timeline`, { token: coach.token })).entries;
  assert.deepEqual(t.map((e) => e.to_status), ['requested', 'expired']);
  assert.equal(t[1].actor_id, null); assert.equal(t[1].by_system, true); assert.match(t[1].reason, /start time/);

  // a row created before the history existed: no trigger fired, the migration backfill adds its current status once
  await pool.query('ALTER TABLE coach_hires DISABLE TRIGGER coach_hires_status_history');
  const old = await hire(athlete, coach);
  await pool.query('ALTER TABLE coach_hires ENABLE TRIGGER coach_hires_status_history');
  assert.equal(ok(await api('GET', `/hires/${old.id}/timeline`, { token: athlete.token })).entries.length, 0);
  const sql = readFileSync(new URL('../migrations/043_engagement_status_history.sql', import.meta.url), 'utf8');
  await pool.query(sql); await pool.query(sql); // re-running is harmless
  const back = ok(await api('GET', `/hires/${old.id}/timeline`, { token: athlete.token })).entries;
  assert.equal(back.length, 1); assert.deepEqual([back[0].to_status, back[0].backfilled], ['requested', true]);
});

test('paid session: concurrent cancels refund once, with an idempotency key, and the timeline shows the refund', async () => {
  const athlete = await signup(['athlete']), coach = await coachOf(), doc = await doctor();
  for (const [type, base_, mk, other] of [['coach_hire', '/hires', () => hire(athlete, coach), coach], ['appointment', '/appointments', () => appt(athlete, doc), doc]]) {
    const before_ = fake.refunds.length;
    const x = await mk();
    await pay(athlete, type, x.id);
    const race = await Promise.all([patch(`${base_}/${x.id}`, athlete, 'cancelled', 'Changed plans'), patch(`${base_}/${x.id}`, other, 'cancelled'), patch(`${base_}/${x.id}`, athlete, 'cancelled')]);
    assert.deepEqual(race.map((r) => r.status).sort(), [200, 409, 409], `${type}: one cancel wins`);
    assert.equal(fake.refunds.length - before_, 1, `${type}: exactly one provider refund`);
    assert.match(fake.keys.at(-1), new RegExp(`${type}-${x.id}-cancel`), 'refund carries a deterministic idempotency key');
    const entries = ok(await api('GET', `${base_}/${x.id}/timeline`, { token: other.token })).entries;
    assert.deepEqual(entries.map((e) => [e.to_status, e.payment_status]), [['requested', 'unpaid'], ['cancelled', 'refunded']]);
    assert.equal((await pool.query("SELECT payment_status FROM " + (type === 'coach_hire' ? 'coach_hires' : 'appointments') + ' WHERE id=$1', [x.id])).rows[0].payment_status, 'refunded');
  }
});
