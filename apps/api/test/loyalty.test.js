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
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `lo_${n}_${roles[0]}`, display_name: `Loyal ${n}`, email: `lo${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const today = new Date().toISOString().slice(0, 10);
const at = (d, h) => fromLocal(addDays(today, d), h * 60, 'UTC').toISOString();
const wait = async (fn, ms = 4000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 40)); } };

async function checkout(u, type, id) {
  const p = must(await api('POST', '/payments', { token: u.token, body: { purpose_type: type, purpose_id: id, provider: 'stripe', return_url: 'http://app.test/' } }), 201);
  Object.values(fake.sessions).at(-1).payment_status = 'paid';
  return { p, done: must(await api('POST', `/payments/${p.id}/confirm`, { token: u.token, body: {} })) };
}
async function venue(mgr, over = {}) {
  const v = must(await api('POST', '/venues', { token: mgr.token, body: { name: `Loyalty Arena ${Math.random().toString(36).slice(2, 6)}`, timezone: 'UTC', currency: 'INR', payment_mode: 'online_optional', ...over } }), 201);
  const court = must(await api('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'Court 1', hourly_rate_cents: 100000 } }), 201);
  return { v, court };
}
const book = (u, court, d, h, len = 1) => api('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: court.id, starts_at: at(d, h), ends_at: at(d, h + len) }] } });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('lo_root','Root','{admin}','x','x','lo_adminidx') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
});
after(async () => { server.close(); provider.close(); await pool.end(); });


const pts = async (u, venueId) => Number(must(await api('GET', '/me/loyalty', { token: u.token })).find((p) => p.venue_id === venueId)?.points ?? 0);
const bonus = (mgr, v, u, points) => api('POST', `/venues/${v.id}/loyalty/bonus`, { token: mgr.token, body: { user_handle: u.handle, points, note: 'test goodwill' } });

test('loyalty: earned once per paid invoice, spent with a cap, restored on void, clawed back on refund', async () => {
  const mgr = await signup(['venue_manager']);
  const { v, court } = await venue(mgr, { loyalty_earn_bp: 1000, loyalty_max_redeem_bp: 5000, loyalty_expiry_months: 6 });
  assert.equal(v.loyalty_earn_bp, 1000);
  const u = await signup(), other = await signup();
  assert.equal(must(await api('GET', `/venues/${v.id}`, { token: u.token })).my_points, 0);

  // paying earns 10% of the invoice; confirming again does not earn twice
  const b1 = must(await book(u, court, 3, 10), 201);
  const { p } = await checkout(u, 'venue_invoice', b1.invoices[0].id);
  must(await api('POST', `/payments/${p.id}/confirm`, { token: u.token, body: {} }));
  assert.equal(await pts(u, v.id), 10000);
  assert.equal(must(await api('GET', `/venues/${v.id}`, { token: u.token })).my_points, 10000);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM loyalty_lots WHERE invoice_id=$1 AND kind='earn'", [b1.invoices[0].id])).rows[0].n, 1);

  // spend part of it; the card pays the rest; points paid with earn nothing
  const b2 = must(await book(u, court, 4, 10), 201);
  const inv2 = b2.invoices[0].id;
  assert.equal((await api('POST', `/invoices/${inv2}/points`, { token: other.token, body: {} })).status, 403);
  const part = must(await api('POST', `/invoices/${inv2}/points`, { token: u.token, body: { points: 4000 } }));
  assert.deepEqual([part.points_used, part.due_cents, part.paid, part.points_left], [4000, 96000, false, 6000]);
  const { p: p2 } = await checkout(u, 'venue_invoice', inv2);
  assert.equal(p2.amount_cents, 96000);
  assert.equal(await pts(u, v.id), 6000 + 9600, 'earned on the 960 paid, not on the points');

  // the cap: points pay at most half of one invoice
  must(await bonus(mgr, v, u, 100000));
  const b3 = must(await book(u, court, 5, 10), 201);
  const inv3 = b3.invoices[0].id;
  const big = must(await api('POST', `/invoices/${inv3}/points`, { token: u.token, body: {} }));
  assert.equal(big.points_used, 50000);
  assert.equal((await api('POST', `/invoices/${inv3}/points`, { token: u.token, body: {} })).status, 409, 'cap reached');
  assert.equal(await pts(u, v.id), 115600 - 50000);

  // cancelling before paying gives the points back
  must(await api('DELETE', `/bookings/${b3.bookings[0].id}`, { token: u.token }));
  assert.equal(await pts(u, v.id), 115600);
  assert.equal(must(await api('GET', `/invoices/${inv3}`, { token: u.token })).status, 'void');

  // refunding a paid booking takes back what it earned, as far as those points are still unspent
  const b4 = must(await book(u, court, 8, 10), 201);
  const { p: p4 } = await checkout(u, 'venue_invoice', b4.invoices[0].id);
  assert.equal(await pts(u, v.id), 115600 + 10000);
  must(await api('DELETE', `/bookings/${b4.bookings[0].id}`, { token: u.token }));
  assert.equal(await pts(u, v.id), 115600);
  must(await api('DELETE', `/bookings/${b1.bookings[0].id}`, { token: u.token }));
  assert.equal(await pts(u, v.id), 115600, 'b1 points were already spent: nothing left to take back');

  // statement
  const kinds = must(await api('GET', '/me/loyalty/history', { token: u.token, query: { venue_id: v.id } })).map((e) => e.kind);
  for (const k of ['earn', 'redeem', 'restore', 'clawback', 'bonus']) assert.ok(kinds.includes(k), k);
  assert.equal((await pool.query('SELECT count(*)::int AS bad FROM loyalty_lots WHERE remaining > points').then((r) => r.rows[0].bad)), 0);
});

test('loyalty: oldest points go first, expired points are gone and recorded, venue summary and permissions', async () => {
  const mgr = await signup(['venue_manager']);
  const { v, court } = await venue(mgr, { loyalty_earn_bp: 500 });
  const u = await signup();
  must(await bonus(mgr, v, u, 3000));
  must(await bonus(mgr, v, u, 2000));
  // make the second lot the older one
  await pool.query("UPDATE loyalty_lots SET expires_at = now() + interval '10 days' WHERE user_id=$1 AND points=2000", [u.id]);
  const b = must(await book(u, court, 6, 10), 201);
  must(await api('POST', `/invoices/${b.invoices[0].id}/points`, { token: u.token, body: { points: 2500 } }));
  const lots = (await pool.query('SELECT points, remaining FROM loyalty_lots WHERE user_id=$1 ORDER BY points', [u.id])).rows;
  assert.deepEqual(lots.map((l) => l.remaining), [0, 2500], 'the sooner-expiring lot is used first, then the next');
  const mine = must(await api('GET', '/me/loyalty', { token: u.token })).find((p) => p.venue_id === v.id);
  assert.equal(mine.points, 2500);
  assert.equal(mine.expiring_soon, 0);

  await pool.query("UPDATE loyalty_lots SET expires_at = now() - interval '1 day' WHERE user_id=$1", [u.id]);
  const { expireLoyalty } = await import('../src/booking/loyalty.js');
  assert.ok((await expireLoyalty()) >= 2500);
  assert.equal(await pts(u, v.id), 0);
  assert.equal(must(await api('GET', '/me/loyalty/history', { token: u.token })).filter((e) => e.kind === 'expire').reduce((s, e) => s + e.delta, 0), -2500);
  assert.equal(await expireLoyalty(), 0, 'nothing is expired twice');

  // venue summary
  const sum = must(await api('GET', `/venues/${v.id}/loyalty`, { token: mgr.token }));
  assert.deepEqual([sum.issued, sum.redeemed, sum.expired, sum.outstanding.points, sum.programme.enabled], [5000, 2500, 2500, 0, true]);

  // permissions and input
  const rando = await signup(['venue_manager']);
  assert.equal((await api('GET', `/venues/${v.id}/loyalty`, { token: rando.token })).status, 403);
  assert.equal((await bonus(rando, v, u, 100)).status, 403);
  assert.equal((await api('POST', `/venues/${v.id}/loyalty/bonus`, { token: mgr.token, body: { user_handle: 'nobody_here', points: 5, note: 'hello there' } })).status, 404);
  assert.equal((await api('POST', `/venues/${v.id}/loyalty/bonus`, { token: mgr.token, body: { user_handle: u.handle, points: 5 } })).status, 400, 'a note is required');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='grant_loyalty_points' AND actor_id=$1", [mgr.id])).rowCount >= 2);
  // a venue with the programme off earns nothing
  const off = await venue(mgr);
  const b2 = must(await book(u, off.court, 7, 10), 201);
  const { p } = await checkout(u, 'venue_invoice', b2.invoices[0].id);
  assert.equal(p.amount_cents, 100000);
  assert.equal(await pts(u, off.v.id), 0);
  assert.equal((await api('POST', `/invoices/${b2.invoices[0].id}/points`, { token: u.token, body: {} })).status, 409);
});
