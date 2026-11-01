import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// stand-in for Stripe Checkout + refunds that records every refund amount
const fake = { sessions: {}, refunds: [], n: 0 };
const stripe = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString(), send = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
  if (req.url === '/v1/checkout/sessions' && req.method === 'POST') {
    const f = new URLSearchParams(raw); const id = `cs_${++fake.n}`;
    fake.sessions[id] = { id, amount_total: Number(f.get('line_items[0][price_data][unit_amount]')), currency: f.get('line_items[0][price_data][currency]'), name: 'x', payment_status: 'unpaid', payment_intent: `pi_${fake.n}` };
    return send(200, { id, url: `https://checkout.stripe.test/${id}` });
  }
  if (req.url.startsWith('/v1/checkout/sessions/')) { const s = fake.sessions[req.url.split('/').pop()]; return s ? send(200, s) : send(404, {}); }
  if (req.url === '/v1/refunds') {
    const f = new URLSearchParams(raw);
    fake.refunds.push({ intent: f.get('payment_intent'), amount: f.get('amount') ? Number(f.get('amount')) : null, key: req.headers['idempotency-key'] });
    return send(200, { id: `re_${fake.refunds.length}` });
  }
  send(404, {});
});
await new Promise((r) => stripe.listen(0, '127.0.0.1', r));
Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_API_BASE: `http://127.0.0.1:${stripe.address().port}`, APP_URL: 'http://app.test', CORS_ORIGINS: 'http://app.test' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const signup = async (roles) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `cs_${n}_${roles[0]}`, display_name: `Cs ${n}`, email: `cs${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const dayPlus = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
let off = 20;
// a coach with a 1,000.00 session card (INR minor units) carrying a 10 % block discount from 4 sessions
const coachOf = async (card = {}) => {
  const coach = await signup(['coach']);
  ok(await api('POST', '/me/sport-profiles', { token: coach.token, body: { sport: 'football', role: 'coach', level: 'pro', hourly_rate_cents: 60000 } }), 201);
  const rc = ok(await api('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'Weekly', sport: 'football', audience: 'individual', unit: 'session', duration_min: 60, price_cents: 100001, block_discount_pct: 10, block_min_sessions: 4, ...card } }), 201);
  return { coach, rc };
};
const seriesBody = (coach, rc, over = {}) => ({ coach_id: coach.id, sport: 'football', rate_card_id: rc.id, start: '17:00', timezone: 'UTC', duration_min: 60, starts_on: dayPlus(off), weekdays: [1, 3], count: 4, ...over });
const next = () => { off += 40; };
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const pay = async (user, hireId) => {
  const p = ok(await api('POST', '/payments', { token: user.token, body: { purpose_type: 'coach_hire', purpose_id: hireId, provider: 'stripe' } }), 201);
  fake.sessions[p.checkout_url.split('/').pop()].payment_status = 'paid';
  assert.equal(ok(await api('POST', `/payments/${p.id}/confirm`, { token: user.token })).status, 'paid');
  return p;
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); stripe.close(); await pool.end(); });

test('preview shows list, discount and exact total, and the booking charges exactly that', async () => {
  next();
  const { coach, rc } = await coachOf();
  const me = await signup(['athlete']);
  const pv = ok(await api('POST', '/hires/series', { token: me.token, body: { ...seriesBody(coach, rc), preview: true } }), 201);
  assert.equal(pv.bookable, 4);
  assert.equal(pv.list_total_cents, 400004);
  assert.equal(pv.discount_pct, 10);
  assert.equal(pv.discount_cents, 40000);   // round(400004 * 10 / 100)
  assert.equal(pv.total_cents, 360004);
  assert.equal(sum(pv.dates.map((d) => d.price_cents)), pv.total_cents, 'per-date shares add up exactly');
  const booked = ok(await api('POST', '/hires/series', { token: me.token, body: seriesBody(coach, rc) }), 201);
  assert.equal(booked.total_cents, pv.total_cents, 'preview total === charged total');
  assert.equal(sum(booked.hires.map((h) => Number(h.total_cents))), pv.total_cents);
  const s = ok(await api('GET', `/hires/series/${booked.series_id}`, { token: me.token }));
  assert.equal(s.total_cents, pv.total_cents);
  assert.equal(s.dates.length, 4);
});

test('below the block size there is no discount', async () => {
  next();
  const { coach, rc } = await coachOf();
  const me = await signup(['athlete']);
  const pv = ok(await api('POST', '/hires/series', { token: me.token, body: { ...seriesBody(coach, rc, { count: 3 }), preview: true } }), 201);
  assert.equal(pv.discount_cents, 0); assert.equal(pv.total_cents, pv.list_total_cents);
});

test('legacy behaviour: no card -> priced from the hourly rate, per-date, no discount', async () => {
  next();
  const coach = await signup(['coach']);
  ok(await api('POST', '/me/sport-profiles', { token: coach.token, body: { sport: 'football', role: 'coach', hourly_rate_cents: 60000 } }), 201);
  const me = await signup(['athlete']);
  const r = ok(await api('POST', '/hires/series', { token: me.token, body: { coach_id: coach.id, sport: 'football', start: '17:00', timezone: 'UTC', duration_min: 60, starts_on: dayPlus(off), weekdays: [2], count: 3 } }), 201);
  assert.equal(r.pay_mode, 'per_date'); assert.equal(r.discount_cents, 0); assert.equal(r.total_cents, 180000);
});

test('pay once: one payment covers the block; cancel refunds exactly the unused dates', async () => {
  next();
  const { coach, rc } = await coachOf();
  const me = await signup(['athlete']);
  const booked = ok(await api('POST', '/hires/series', { token: me.token, body: seriesBody(coach, rc, { pay_mode: 'once' }) }), 201);
  assert.ok(booked.pay_hire_id);
  const p = await pay(me, booked.pay_hire_id);
  assert.equal(p.amount_cents, booked.total_cents);
  const s = ok(await api('GET', `/hires/series/${booked.series_id}`, { token: me.token }));
  assert.ok(s.dates.every((d) => d.payment_status === 'paid'));
  // one date has already been delivered (it started), so it is never refunded
  await pool.query("UPDATE coach_hires SET status='confirmed' WHERE id=$1", [s.dates[0].id]);
  await pool.query("UPDATE coach_hires SET starts_at = now() - interval '2 hours' WHERE id=$1", [s.dates[0].id]);
  await pool.query("UPDATE coach_hires SET status='completed', completed_at=now() WHERE id=$1", [s.dates[0].id]);
  const unused = s.dates.slice(1).reduce((a, d) => a + Number(d.total_cents), 0);
  const pv = ok(await api('POST', `/hires/series/${booked.series_id}/cancel`, { token: me.token, body: { preview: true } }), 200);
  assert.equal(pv.refund_cents, unused); assert.equal(pv.cancelled.length, 3); assert.equal(pv.kept, 1);
  const before = fake.refunds.length;
  const done = ok(await api('POST', `/hires/series/${booked.series_id}/cancel`, { token: me.token, body: { reason: 'injury' } }), 200);
  assert.equal(done.refunded_cents, unused);
  assert.equal(sum(fake.refunds.slice(before).map((r) => r.amount)), unused, 'provider refunded exactly the unused dates');
  assert.equal(done.series.status, 'cancelled');
  assert.equal(done.series.dates.filter((d) => d.status === 'completed').length, 1, 'history kept');
  assert.equal(done.series.dates.filter((d) => d.status === 'cancelled').length, 3);
  assert.equal(ok(await api('POST', `/hires/series/${booked.series_id}/cancel`, { token: me.token, body: {} }), 409) && 0, 0);
});

test('pay per date: skipping a date refunds that date only; the rest carry on', async () => {
  next();
  const { coach, rc } = await coachOf();
  const me = await signup(['athlete']);
  const booked = ok(await api('POST', '/hires/series', { token: me.token, body: seriesBody(coach, rc, { pay_mode: 'per_date' }) }), 201);
  const [h1, h2] = booked.hires;
  await pay(me, h1.id); await pay(me, h2.id);
  const before = fake.refunds.length;
  const sk = ok(await api('POST', `/hires/series/${booked.series_id}/skip`, { token: me.token, body: { hire_ids: [h1.id] } }), 200);
  assert.equal(sk.refund_cents, Number(h1.total_cents));
  assert.equal(fake.refunds.length - before, 1);
  const s = sk.series;
  assert.equal(s.status, 'active'); assert.equal(s.upcoming, 3);
  assert.equal(s.dates.find((d) => d.id === h1.id).series_state, 'skipped');
  assert.equal(s.dates.find((d) => d.id === h2.id).payment_status, 'paid', 'other dates untouched');
  assert.equal(s.total_cents, sum(booked.hires.slice(1).map((h) => Number(h.total_cents))), 'the block price already agreed stays; only the skipped share leaves');
});

test('skipping a date range refunds nothing for unpaid dates and charges only the rest', async () => {
  next();
  const { coach, rc } = await coachOf();
  const me = await signup(['athlete']);
  const booked = ok(await api('POST', '/hires/series', { token: me.token, body: seriesBody(coach, rc, { pay_mode: 'once' }) }), 201);
  const dates = ok(await api('GET', `/hires/series/${booked.series_id}`, { token: me.token })).dates;
  const from = dates[0].starts_at.slice(0, 10), to = dates[1].starts_at.slice(0, 10);
  const r = ok(await api('POST', `/hires/series/${booked.series_id}/skip`, { token: me.token, body: { from, to } }), 200);
  assert.equal(r.skipped.length, 2); assert.equal(r.refund_cents, 0, 'nothing was paid yet');
  const p = await pay(me, r.series.pay_hire_id);
  assert.equal(p.amount_cents, Number(dates[2].total_cents) + Number(dates[3].total_cents), 'only the remaining dates are charged');
});

test('reschedule moves one date, keeps price and payment, and refuses a clash', async () => {
  next();
  const { coach, rc } = await coachOf();
  const me = await signup(['athlete']);
  const booked = ok(await api('POST', '/hires/series', { token: me.token, body: seriesBody(coach, rc) }), 201);
  const h = booked.hires[0];
  const target = dayPlus(off + 30);
  const mv = ok(await api('POST', `/hires/series/${booked.series_id}/reschedule`, { token: me.token, body: { hire_id: h.id, date: target, start: '09:00' } }), 200);
  assert.equal(mv.starts_at.slice(0, 16), `${target}T09:00`); assert.ok(mv.rescheduled_from);
  assert.equal(Number(mv.total_cents), Number(h.total_cents));
  const clash = booked.hires[1].starts_at.slice(0, 10);
  const bad = await api('POST', `/hires/series/${booked.series_id}/reschedule`, { token: me.token, body: { hire_id: h.id, date: clash, start: '17:30' } });
  assert.equal(bad.status, 409);
});

test('dates skipped for conflicts are never charged', async () => {
  next();
  const { coach, rc } = await coachOf();
  const other = await signup(['athlete']), me = await signup(['athlete']);
  const body = seriesBody(coach, rc);
  const first = ok(await api('POST', '/hires/series', { token: other.token, body: { ...body, count: 1 } }), 201);   // takes the first date
  const pv = ok(await api('POST', '/hires/series', { token: me.token, body: { ...body, preview: true } }), 201);
  assert.equal(pv.bookable, 3); assert.equal(pv.skipped.length, 1); assert.equal(pv.discount_cents, 0, '3 dates is below the block size');
  assert.equal(pv.total_cents, 300003);
  const booked = ok(await api('POST', '/hires/series', { token: me.token, body }), 201);
  assert.equal(booked.hires.length, 3); assert.equal(booked.total_cents, pv.total_cents); assert.ok(first.series_id);
});

test('a coach can require payment up front; per-date is then refused', async () => {
  next();
  const { coach, rc } = await coachOf({ allow_pay_per_date: false });
  const me = await signup(['athlete']);
  const bad = await api('POST', '/hires/series', { token: me.token, body: seriesBody(coach, rc, { pay_mode: 'per_date' }) });
  assert.equal(bad.status, 400);
  const dflt = ok(await api('POST', '/hires/series', { token: me.token, body: { ...seriesBody(coach, rc), preview: true } }), 201);
  assert.deepEqual(dflt.pay_modes, ['once']); assert.equal(dflt.pay_mode, 'once');
});

test('only the hirer, coach (or admin) can see or change a series; others get 404', async () => {
  next();
  const { coach, rc } = await coachOf();
  const me = await signup(['athlete']), stranger = await signup(['athlete']);
  const booked = ok(await api('POST', '/hires/series', { token: me.token, body: seriesBody(coach, rc) }), 201);
  assert.equal((await api('GET', `/hires/series/${booked.series_id}`, { token: stranger.token })).status, 404);
  assert.equal((await api('POST', `/hires/series/${booked.series_id}/cancel`, { token: stranger.token, body: {} })).status, 404);
  assert.equal((await api('GET', `/hires/series/${booked.series_id}`, { token: coach.token })).status, 200);
  const mine = ok(await api('GET', '/hires/series', { token: me.token }));
  assert.ok(mine.some((s) => s.id === booked.series_id));
});

test('block discount fields are validated on the rate card', async () => {
  const coach = await signup(['coach']);
  ok(await api('POST', '/me/sport-profiles', { token: coach.token, body: { sport: 'football', role: 'coach', hourly_rate_cents: 60000 } }), 201);
  const bad = await api('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'x', sport: 'football', unit: 'session', duration_min: 60, price_cents: 1000, block_discount_pct: 95 } });
  assert.equal(bad.status, 400);
});

test('every sport in the catalogue can be priced as a series (sport-agnostic)', async () => {
  const sports = ok(await api('GET', '/sports')).slice(0, 400);
  assert.ok(sports.length > 10);
  const me = await signup(['athlete']);
  for (const sp of sports) {   // walks the catalogue's sport slugs through the same pricing
    const coach = await signup(['coach']);
    const prof = await api('POST', '/me/sport-profiles', { token: coach.token, body: { sport: sp.slug, role: 'coach', hourly_rate_cents: 50000 } });
    assert.equal(prof.status, 201, `${sp.slug}: ${JSON.stringify(prof.body)}`);
    const rc = ok(await api('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'Block', sport: sp.slug, unit: 'session', duration_min: 60, price_cents: 10000, block_discount_pct: 20, block_min_sessions: 2 } }), 201);
    next();
    const pv = ok(await api('POST', '/hires/series', { token: me.token, body: { coach_id: coach.id, sport: sp.slug, rate_card_id: rc.id, start: '10:00', timezone: 'UTC', starts_on: dayPlus(off), weekdays: [1], count: 2, preview: true } }), 201);
    assert.equal(pv.total_cents, 16000, sp.slug);
  }
});

test('pause holds every upcoming date, keeps the payment, frees the coach, and resume restores them', async () => {
  next();
  const { coach, rc } = await coachOf();
  const me = await signup(['athlete']), other = await signup(['athlete']);
  const booked = ok(await api('POST', '/hires/series', { token: me.token, body: seriesBody(coach, rc, { pay_mode: 'once' }) }), 201);
  await pay(me, booked.pay_hire_id);
  const before = fake.refunds.length;
  const pv = ok(await api('POST', `/hires/series/${booked.series_id}/pause`, { token: me.token, body: { preview: true } }), 200);
  assert.equal(pv.held.length, 4);
  const paused = ok(await api('POST', `/hires/series/${booked.series_id}/pause`, { token: me.token, body: {} }), 200);
  assert.equal(paused.series.status, 'paused');
  assert.ok(paused.series.dates.every((d) => d.series_state === 'paused' && d.payment_status === 'paid'), 'held dates stay paid');
  assert.equal(fake.refunds.length, before, 'pausing refunds nothing');
  assert.equal(paused.series.total_cents, booked.total_cents, 'price unchanged');
  // the coach's time is free while held: someone else can take the first date
  const taken = await api('POST', '/hires', { token: other.token, body: { coach_id: coach.id, sport: 'football', rate_card_id: rc.id, starts_at: booked.hires[0].starts_at } });
  assert.equal(taken.status, 201, JSON.stringify(taken.body));
  // a held date cannot be confirmed
  assert.equal((await api('PATCH', `/hires/${booked.hires[1].id}`, { token: coach.token, body: { status: 'confirmed' } })).status, 409);
  const again = await api('POST', `/hires/series/${booked.series_id}/pause`, { token: me.token, body: {} });
  assert.equal(again.status, 409);
  // resume: the date someone else took is reported, the other three come back
  const back = ok(await api('POST', `/hires/series/${booked.series_id}/resume`, { token: coach.token, body: {} }), 200);
  assert.equal(back.resumed, 3); assert.equal(back.problems.length, 1); assert.equal(back.problems[0].hire_id, booked.hires[0].id);
  assert.equal(back.series.status, 'paused', 'stays paused while a date is still held');
  // the held date can still be skipped: refunded its own share
  const sk = ok(await api('POST', `/hires/series/${booked.series_id}/skip`, { token: me.token, body: { hire_ids: [booked.hires[0].id] } }), 200);
  assert.equal(sk.refund_cents, Number(booked.hires[0].total_cents));
  assert.equal(sk.series.status, 'active');
});

test('pay-once amount excludes held unpaid dates; non-parties get 404', async () => {
  next();
  const { coach, rc } = await coachOf();
  const me = await signup(['athlete']), stranger = await signup(['athlete']);
  const booked = ok(await api('POST', '/hires/series', { token: me.token, body: seriesBody(coach, rc, { pay_mode: 'once' }) }), 201);
  assert.equal((await api('POST', `/hires/series/${booked.series_id}/pause`, { token: stranger.token, body: {} })).status, 404);
  ok(await api('POST', `/hires/series/${booked.series_id}/pause`, { token: me.token, body: {} }), 200);
  const resumed = ok(await api('POST', `/hires/series/${booked.series_id}/resume`, { token: me.token, body: {} }), 200);
  assert.equal(resumed.resumed, 4); assert.equal(resumed.series.status, 'active');
  const p = await pay(me, resumed.series.pay_hire_id);
  assert.equal(p.amount_cents, booked.total_cents, 'everything is due again once resumed');
  assert.equal((await api('POST', `/hires/series/${booked.series_id}/resume`, { token: me.token, body: {} })).status, 409);
});
