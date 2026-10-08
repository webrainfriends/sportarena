import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// ---- stand-in for Stripe ----
const fake = { sessions: {}, refunds: [], n: 0 };
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
  if (req.url === '/v1/refunds') { const f = new URLSearchParams(raw); fake.refunds.push({ intent: f.get('payment_intent'), amount: Number(f.get('amount')) }); return send(200, { id: 're_1' }); }
  send(404, {});
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp',
  STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_API_BASE: `http://127.0.0.1:${provider.address().port}`, APP_URL: 'http://app.test', CORS_ORIGINS: 'http://app.test',
});
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { fromLocal, addDays } = await import('../src/booking/time.js');
const { processRefunds } = await import('../src/booking/refunds.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `pl_${n}_${roles[0]}`, display_name: `Planner ${n}`, email: `pl${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const today = new Date().toISOString().slice(0, 10);
const at = (d, h) => fromLocal(addDays(today, d), h * 60, 'UTC').toISOString();
const wait = async (fn, ms = 4000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 40)); } };

async function checkout(u, type, id) {
  const p = must(await api('POST', '/payments', { token: u.token, body: { purpose_type: type, purpose_id: id, provider: 'stripe', return_url: 'http://app.test/' } }), 201);
  Object.values(fake.sessions).at(-1).payment_status = 'paid';
  return { p, done: must(await api('POST', `/payments/${p.id}/confirm`, { token: u.token, body: {} })) };
}
async function venue(mgr, over = {}) {
  const v = must(await api('POST', '/venues', { token: mgr.token, body: { name: `Plans Arena ${Math.random().toString(36).slice(2, 6)}`, timezone: 'UTC', currency: 'INR', payment_mode: 'online_optional', ...over } }), 201);
  const court = must(await api('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'Court 1', hourly_rate_cents: 100000 } }), 201);
  return { v, court };
}
const book = (u, court, d, h, len = 1) => api('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: court.id, starts_at: at(d, h), ends_at: at(d, h + len) }] } });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('pl_root','Root','{admin}','x','x','pl_adminidx') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
});
after(async () => { server.close(); provider.close(); await pool.end(); });



const plan = (mgr, v, body) => api('POST', `/venues/${v.id}/plans`, { token: mgr.token, body });
const mine = async (u) => must(await api('GET', '/me/plans', { token: u.token }));

test('plans: venue team defines them, validation and permissions, hidden once stopped', async () => {
  const mgr = await signup(['venue_manager']), rando = await signup(['venue_manager']);
  const { v } = await venue(mgr);
  assert.equal((await plan(rando, v, { kind: 'membership', name: 'Gold', price_cents: 100000, duration_days: 30, discount_bp: 1000 })).status, 403);
  assert.equal((await plan(mgr, v, { kind: 'membership', name: 'Gold', price_cents: 100000 })).status, 400, 'membership needs duration and discount');
  assert.equal((await plan(mgr, v, { kind: 'pass', name: '5 pack', price_cents: 100000, sessions: 5 })).status, 400, 'pass needs validity');
  const m = must(await plan(mgr, v, { kind: 'membership', name: 'Gold', price_cents: 100000, duration_days: 30, discount_bp: 2000 }), 201);
  const p = must(await plan(mgr, v, { kind: 'pass', name: '5 pack', price_cents: 400000, sessions: 5, valid_days: 60 }), 201);
  assert.equal(p.session_value_cents, 80000, 'defaults to price / sessions');
  assert.equal(must(await api('GET', `/venues/${v.id}/plans`, { token: mgr.token })).length, 2);
  assert.equal(must(await api('GET', `/venues/${v.id}`, { token: mgr.token })).plans.length, 2);
  assert.equal((await api('PATCH', `/venue-plans/${m.id}`, { token: rando.token, body: { active: false } })).status, 403);
  must(await api('PATCH', `/venue-plans/${m.id}`, { token: mgr.token, body: { active: false } }));
  assert.equal(must(await api('GET', `/venues/${v.id}/plans`, { token: mgr.token })).length, 1);
  const u = await signup();
  assert.equal((await api('POST', `/venue-plans/${m.id}/buy`, { token: u.token })).status, 404, 'no longer sold');
});

test('membership: pay to activate, member discount on bookings, one at a time, renewal window', async () => {
  const mgr = await signup(['venue_manager']);
  const { v, court } = await venue(mgr);
  const m = must(await plan(mgr, v, { kind: 'membership', name: 'Gold', price_cents: 100000, duration_days: 30, discount_bp: 2000 }), 201);
  const u = await signup(), other = await signup();
  const up = must(await api('POST', `/venue-plans/${m.id}/buy`, { token: u.token }), 201);
  assert.equal(up.status, 'awaiting_payment');
  assert.equal((await api('POST', `/venue-plans/${m.id}/buy`, { token: u.token })).status, 409, 'one waiting at a time');
  assert.equal((await api('POST', '/payments', { token: other.token, body: { purpose_type: 'venue_plan', purpose_id: up.id, provider: 'stripe', return_url: 'http://app.test/' } })).status, 403);
  const before = must(await book(u, court, 3, 10), 201);
  assert.equal(before.payable_cents, 100000, 'no discount until it is paid');
  const { p, done } = await checkout(u, 'venue_plan', up.id);
  assert.equal(p.amount_cents, 100000);
  assert.equal(done.status, 'paid');
  const got = (await mine(u))[0];
  assert.equal(got.status, 'active');
  assert.ok(new Date(got.expires_at) - new Date(got.starts_at) >= 29.9 * 86400e3);
  assert.equal(must(await api('GET', `/venues/${v.id}`, { token: u.token })).my_member_discount_bp, 2000);

  const after = must(await book(u, court, 4, 10), 201);
  assert.equal(after.payable_cents, 80000, '20% off for members');
  assert.equal(must(await book(other, court, 4, 12), 201).payable_cents, 100000, 'non-members pay full price');
  // already a member with plenty left: no second purchase until the last 30 days
  await pool.query("UPDATE user_plans SET expires_at = now() + interval '45 days' WHERE id=$1", [up.id]);
  assert.equal((await api('POST', `/venue-plans/${m.id}/buy`, { token: u.token })).status, 409);
  await pool.query("UPDATE user_plans SET expires_at = now() + interval '5 days' WHERE id=$1", [up.id]);
  const renew = must(await api('POST', `/venue-plans/${m.id}/buy`, { token: u.token }), 201);
  await checkout(u, 'venue_plan', renew.id);
  const [a, b] = (await mine(u)).filter((x) => x.status === 'active').sort((x, y) => new Date(x.starts_at) - new Date(y.starts_at));
  assert.ok(Math.abs(new Date(b.starts_at) - new Date(a.expires_at)) < 2000, 'the renewal starts when the current one ends');

  // it ends: no discount any more
  await pool.query("UPDATE user_plans SET expires_at = now() - interval '1 minute' WHERE user_id=$1", [u.id]);
  const { expireUserPlans } = await import('../src/booking/plans.js');
  assert.ok(await expireUserPlans() >= 1);
  assert.equal(must(await book(u, court, 5, 10), 201).payable_cents, 100000);
});

test('pass: sessions pay for bookings, come back on void or refund, expire, report', async () => {
  const mgr = await signup(['venue_manager']);
  const { v, court } = await venue(mgr);
  const five = must(await plan(mgr, v, { kind: 'pass', name: '5 pack', price_cents: 400000, sessions: 5, valid_days: 60 }), 201);
  const small = must(await plan(mgr, v, { kind: 'pass', name: 'Mini', price_cents: 60000, sessions: 2, valid_days: 30, session_value_cents: 30000 }), 201);
  const u = await signup(), other = await signup();
  const b0 = must(await book(u, court, 3, 10), 201);
  assert.equal((await api('POST', `/invoices/${b0.invoices[0].id}/pass`, { token: u.token, body: {} })).status, 409, 'no pass yet');
  const up = must(await api('POST', `/venue-plans/${five.id}/buy`, { token: u.token }), 201);
  assert.equal((await api('POST', `/invoices/${b0.invoices[0].id}/pass`, { token: u.token, body: {} })).status, 409, 'unpaid passes do not count');
  await checkout(u, 'venue_plan', up.id);
  assert.equal((await mine(u)).find((x) => x.id === up.id).sessions_left, 5);
  assert.equal((await api('POST', `/invoices/${b0.invoices[0].id}/pass`, { token: other.token, body: {} })).status, 403);

  // 100,000 booking at 80,000 a session = 2 sessions
  const used = must(await api('POST', `/invoices/${b0.invoices[0].id}/pass`, { token: u.token, body: {} }));
  assert.deepEqual([used.sessions_used, used.applied_cents, used.due_cents, used.paid, used.sessions_left], [2, 100000, 0, true, 3]);
  const doc = must(await api('GET', `/invoices/${b0.invoices[0].id}`, { token: u.token }));
  assert.deepEqual([doc.status, doc.payment_method], ['paid', 'pass']);

  // cancelling a pass-paid booking gives the sessions back, nothing goes to the card
  const refunds = fake.refunds.length;
  must(await api('DELETE', `/bookings/${b0.bookings[0].id}`, { token: u.token }));
  assert.equal((await mine(u)).find((x) => x.id === up.id).sessions_left, 5);
  assert.equal(fake.refunds.length, refunds);

  // a small pass only covers part; the rest is still due; voiding gives the sessions back
  const us = must(await api('POST', `/venue-plans/${small.id}/buy`, { token: u.token }), 201);
  await checkout(u, 'venue_plan', us.id);
  const b1 = must(await book(u, court, 4, 10), 201);
  const part = must(await api('POST', `/invoices/${b1.invoices[0].id}/pass`, { token: u.token, body: { user_plan_id: us.id } }));
  assert.deepEqual([part.sessions_used, part.applied_cents, part.due_cents, part.paid, part.sessions_left], [2, 60000, 40000, false, 0]);
  assert.equal((await mine(u)).find((x) => x.id === us.id).status, 'used_up');
  assert.equal((await api('POST', `/invoices/${b1.invoices[0].id}/pass`, { token: u.token, body: { user_plan_id: us.id } })).status, 409, 'used up');
  const { p } = await checkout(u, 'venue_invoice', b1.invoices[0].id);
  assert.equal(p.amount_cents, 40000, 'the card is asked only for what is left');
  must(await api('DELETE', `/bookings/${b1.bookings[0].id}`, { token: u.token }));
  const back = (await mine(u)).find((x) => x.id === us.id);
  assert.deepEqual([back.sessions_left, back.status], [2, 'active']);

  // expiry
  const { expireUserPlans } = await import('../src/booking/plans.js');
  await pool.query("UPDATE user_plans SET expires_at = now() - interval '1 minute' WHERE id=$1", [up.id]);
  assert.ok(await expireUserPlans() >= 1);
  const b2 = must(await book(u, court, 6, 10), 201);
  const viaSmall = must(await api('POST', `/invoices/${b2.invoices[0].id}/pass`, { token: u.token, body: {} }));
  assert.equal(viaSmall.sessions_used, 2, 'the expired pass is skipped; the other is used');

  // report
  assert.equal((await api('GET', `/venues/${v.id}/plans/report`, { token: other.token })).status, 403);
  const rep = must(await api('GET', `/venues/${v.id}/plans/report`, { token: mgr.token }));
  assert.equal(rep.revenue_cents, 460000);
  assert.equal(rep.plans.find((x) => x.name === 'Mini').sold, 1);

  // dropping an unpaid purchase
  const unpaid = must(await api('POST', `/venue-plans/${five.id}/buy`, { token: other.token }), 201);
  must(await api('DELETE', `/me/plans/${unpaid.id}`, { token: other.token }));
  assert.equal((await api('DELETE', `/me/plans/${us.id}`, { token: u.token })).status, 409, 'a paid plan is not dropped here');
});
