import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// ---- stand-in for Stripe with real idempotency-key semantics, so "money moved" can be counted ----
const fake = { sessions: {}, moved: new Map(), calls: 0, n: 0, dropAfterMoving: 0 };
const provider = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.url === '/v1/checkout/sessions' && req.method === 'POST') {
    const f = new URLSearchParams(raw); const id = `cs_${++fake.n}`;
    fake.sessions[id] = { id, amount_total: Number(f.get('line_items[0][price_data][unit_amount]')), currency: f.get('line_items[0][price_data][currency]'), payment_status: 'unpaid', payment_intent: `pi_${fake.n}` };
    return send(200, { id, url: `https://checkout.stripe.test/${id}` });
  }
  if (req.url.startsWith('/v1/checkout/sessions/')) { const s = fake.sessions[req.url.split('/').pop()]; return s ? send(200, s) : send(404, {}); }
  if (req.url === '/v1/refunds') {
    fake.calls++;
    const key = req.headers['idempotency-key']; const f = new URLSearchParams(raw);
    if (!fake.moved.has(key)) fake.moved.set(key, Number(f.get('amount'))); // the money moves once per key
    if (fake.dropAfterMoving > 0) { fake.dropAfterMoving--; return req.socket.destroy(); } // "crash": provider acted, caller never learns
    return send(200, { id: 're_1' });
  }
  send(404, {});
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
const pbase = `http://127.0.0.1:${provider.address().port}`;
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp',
  STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_API_BASE: pbase, APP_URL: 'http://app.test', CORS_ORIGINS: 'http://app.test',
});
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { config } = await import('../src/config.js');
const { signToken } = await import('../src/auth.js');
const { fromLocal, addDays } = await import('../src/booking/time.js');
const { maintenanceCycle } = await import('../src/worker.js');
const { processRefunds } = await import('../src/booking/refunds.js');
const { queueReminders, notifyHandlers } = await import('../src/notify.js');
const jobs = await import('../src/jobs.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `jb_${n}_${roles[0]}`, display_name: `Job ${n}`, email: `jb${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const today = new Date().toISOString().slice(0, 10);
const at = (d, h) => fromLocal(addDays(today, d), h * 60, 'UTC').toISOString();
const wait = async (fn, ms = 5000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)); } };
const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);

async function venue(mgr, over = {}) {
  const v = must(await api('POST', '/venues', { token: mgr.token, body: { name: `Job Arena ${Math.random().toString(36).slice(2, 6)}`, timezone: 'UTC', currency: 'JPY', ...over } }), 201);
  const court = must(await api('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'Court 1', hourly_rate_cents: over.rate ?? 5000 } }), 201);
  return { v, court };
}
// A paid online booking cancelled late: a credit note of 5000 that must go back to the card.
async function paidThenCancelled(u, mgrVenue, beforeCancel) {
  const soon = new Date(Date.now() + 5 * 3600e3); soon.setUTCMinutes(0, 0, 0);
  const s = must(await api('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: mgrVenue.court.id, starts_at: new Date(+soon + n * 0).toISOString(), ends_at: new Date(+soon + 7200e3).toISOString() }] } }), 201);
  const sp = must(await api('POST', '/payments', { token: u.token, body: { purpose_type: 'venue_invoice', purpose_id: s.invoices[0].id, provider: 'stripe', return_url: 'http://app.test/' } }), 201);
  Object.values(fake.sessions).at(-1).payment_status = 'paid';
  must(await api('POST', `/payments/${sp.id}/confirm`, { token: u.token, body: {} }));
  await beforeCancel?.();
  must(await api('DELETE', `/bookings/${s.bookings[0].id}`, { token: u.token }));
  const cn = (await pool.query("SELECT * FROM invoices WHERE kind='credit_note' AND reservation_id=$1", [s.id])).rows[0];
  return { s, cn, paymentId: sp.id };
}
const settled = (id) => wait(async () => { const r = (await pool.query('SELECT refund_status, refund_claimed_at, refund_attempts FROM invoices WHERE id=$1', [id])).rows[0]; return r.refund_status !== 'pending' || (r.refund_attempts >= 1 && r.refund_claimed_at === null) ? r : null; });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('jobs_root','Root','{admin}','x','x','jobs_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
});
after(async () => { server.close(); provider.close(); await pool.end(); });

test('backoff grows exponentially with jitter and is capped', () => {
  const lo = (a) => jobs.backoffMs(a, { baseMs: 1000, capMs: 60_000, random: () => 0 });
  const hi = (a) => jobs.backoffMs(a, { baseMs: 1000, capMs: 60_000, random: () => 1 });
  assert.equal(hi(1), 1000); assert.equal(hi(2), 2000); assert.equal(hi(4), 8000);
  assert.equal(lo(3), 2000, 'jitter keeps at least half');
  assert.equal(hi(20), 60_000, 'capped');
});

test('claiming is atomic across workers, leased, idempotent to enqueue, and expired leases are recovered', async () => {
  for (let i = 0; i < 6; i++) await jobs.enqueue(null, { category: 'unit', kind: 'unit.task', payload: { i }, dedupeKey: `k${i}` });
  assert.equal(await jobs.enqueue(null, { category: 'unit', kind: 'unit.task', dedupeKey: 'k0' }), null, 'same dedupe key is a no-op');
  const batches = await Promise.all([1, 2, 3].map((w) => jobs.claimJobs('unit', { limit: 4, workerId: `w${w}` })));
  const ids = batches.flat().map((j) => j.id);
  assert.equal(ids.length, 6);
  assert.equal(new Set(ids).size, 6, 'no job claimed twice');

  // a worker dies after claiming: nothing else can take it until the lease runs out, then it is recovered once
  const dead = batches.flat()[0];
  assert.equal((await jobs.claimJobs('unit', { workerId: 'other' })).length, 0, 'leased jobs are not re-claimed');
  await pool.query("UPDATE jobs SET leased_until = now() - interval '1 second' WHERE id=$1", [dead.id]);
  const [again] = await jobs.claimJobs('unit', { workerId: 'rescuer' });
  assert.equal(again.id, dead.id);
  assert.equal(again.attempts, 2);
  assert.equal(await jobs.completeJob(dead), false, 'the stale worker cannot finish a job it lost');
  assert.equal(await jobs.completeJob(again), true);
});

test('failures retry with backoff, then dead-letter; one failing job does not stop the others', async () => {
  await jobs.enqueue(null, { category: 'iso', kind: 'iso.bad', maxAttempts: 2 });
  await jobs.enqueue(null, { category: 'iso', kind: 'iso.good' });
  let ran = 0;
  const handlers = { 'iso.bad': async () => { throw new Error('nope'); }, 'iso.good': async () => { ran++; } };
  const r1 = await jobs.runJobs('iso', handlers);
  assert.deepEqual([r1.succeeded, r1.retried, r1.dead], [1, 1, 0]);
  assert.equal(ran, 1);
  const bad = (await pool.query("SELECT * FROM jobs WHERE kind='iso.bad'")).rows[0];
  assert.equal(bad.status, 'queued'); assert.ok(bad.run_at > new Date(), 'backs off'); assert.equal(bad.last_error, 'nope');
  assert.equal((await jobs.runJobs('iso', handlers)).claimed, 0, 'not due yet');
  await pool.query("UPDATE jobs SET run_at = now() WHERE id=$1", [bad.id]);
  assert.equal((await jobs.runJobs('iso', handlers)).dead, 1);
  assert.equal((await pool.query('SELECT status FROM jobs WHERE id=$1', [bad.id])).rows[0].status, 'dead');
});

test('crash after claiming a refund: lease expiry recovers it and the customer is refunded exactly once', async () => {
  const mgr = await signup(['venue_manager']);
  const jpy = await venue(mgr, { payment_mode: 'online_optional', cancel_free_hours: 24, late_cancel_refund_percent: 50 });
  const u = await signup();
  fake.dropAfterMoving = 1; // the provider moves the money, the connection dies before we hear back
  const { cn, paymentId } = await paidThenCancelled(u, jpy);
  assert.equal(cn.total_cents, 5000);
  const first = await settled(cn.id);
  assert.equal(first.refund_status, 'pending', 'the failed attempt is retried later');
  assert.equal(sum(fake.moved), 5000, 'money moved once already');
  const intent = (await pool.query('SELECT * FROM refund_intents WHERE invoice_id=$1', [cn.id])).rows[0];
  assert.equal(intent.status, 'intent');
  assert.equal(intent.amount_cents, 5000);
  assert.equal((await pool.query('SELECT refunded_cents FROM payments WHERE id=$1', [paymentId])).rows[0].refunded_cents, 0, 'not recorded yet: this is the crash window');

  // another worker still holds a live lease (the first one may just be slow): hands off
  await pool.query("UPDATE invoices SET refund_claimed_at = now(), refund_next_attempt_at = NULL WHERE id=$1", [cn.id]);
  assert.equal((await processRefunds()).done, 0);
  // the lease runs out: the next run finishes the job with the SAME key and amount
  await pool.query("UPDATE invoices SET refund_claimed_at = now() - interval '10 minutes' WHERE id=$1", [cn.id]);
  assert.equal((await processRefunds()).done, 1);
  assert.equal(sum(fake.moved), 5000, 'still only one refund at the provider');
  assert.equal(fake.moved.size, 1);
  assert.equal((await pool.query('SELECT refunded_cents FROM payments WHERE id=$1', [paymentId])).rows[0].refunded_cents, 5000);
  assert.equal((await pool.query('SELECT status FROM refund_intents WHERE invoice_id=$1', [cn.id])).rows[0].status, 'recorded');
  assert.equal((await processRefunds()).done, 0, 'and never again');
  assert.equal(sum(fake.moved), 5000);
});

test('a refund that keeps failing is dead-lettered; an admin can list and requeue it without double-refunding', async () => {
  const mgr = await signup(['venue_manager']);
  const jpy = await venue(mgr, { payment_mode: 'online_optional', cancel_free_hours: 24, late_cancel_refund_percent: 50 });
  const u = await signup();
  const savedBase = config.payments.stripe.base;
  let cn;
  try {
    ({ cn } = await paidThenCancelled(u, jpy, () => { config.payments.stripe.base = 'http://127.0.0.1:1'; })); // provider unreachable from now on
    await settled(cn.id);
  for (let i = 0; i < 6; i++) {
    await pool.query("UPDATE invoices SET refund_next_attempt_at = NULL, refund_claimed_at = NULL WHERE id=$1", [cn.id]);
    await processRefunds();
  }
  } finally { config.payments.stripe.base = savedBase; }
  const row = (await pool.query('SELECT refund_status, refund_attempts FROM invoices WHERE id=$1', [cn.id])).rows[0];
  assert.equal(row.refund_status, 'failed');
  const before = sum(fake.moved);

  const list = must(await api('GET', '/admin/jobs', { token: admin.token, query: { status: 'dead', category: 'refunds' } }));
  const job = list.find((j) => j.subject_id === cn.id);
  assert.ok(job); assert.equal(job.kind, 'refund.credit_note'); assert.equal(job.payload, undefined, 'payloads are never exposed');
  const stranger = await signup();
  assert.equal((await api('GET', '/admin/jobs', { token: stranger.token })).status, 403);
  assert.equal((await api('POST', `/admin/jobs/${job.id}/requeue`, { token: stranger.token })).status, 403);
  assert.equal((await api('POST', `/admin/jobs/${'00000000-0000-4000-8000-000000000000'}/requeue`, { token: admin.token })).status, 404);

  must(await api('POST', `/admin/jobs/${job.id}/requeue`, { token: admin.token }));
  assert.equal((await api('POST', `/admin/jobs/${job.id}/requeue`, { token: admin.token })).status, 409, 'only dead jobs');
  assert.equal((await processRefunds()).done, 1);
  assert.equal(sum(fake.moved) - before, 5000, 'exactly one refund after the requeue');
  assert.equal((await pool.query('SELECT status FROM jobs WHERE id=$1', [job.id])).rows[0].status, 'requeued');
});

test('a notification failure never rolls back a refund or a hold release; it is retried from a durable job', async () => {
  await pool.query(`CREATE OR REPLACE FUNCTION t61_fail() RETURNS trigger AS $$ BEGIN IF NEW.kind IN ('refund_issued','booking_expired','booking_reminder') THEN RAISE EXCEPTION 'notification store down'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
  await pool.query('CREATE TRIGGER t61_fail BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION t61_fail()');
  try {
    // refund
    const mgr = await signup(['venue_manager']);
    const jpy = await venue(mgr, { payment_mode: 'online_optional', cancel_free_hours: 24, late_cancel_refund_percent: 50 });
    const u = await signup();
    const { cn, paymentId } = await paidThenCancelled(u, jpy);
    await wait(async () => (await pool.query('SELECT refund_status FROM invoices WHERE id=$1', [cn.id])).rows[0].refund_status === 'done');
    assert.equal((await pool.query('SELECT refunded_cents FROM payments WHERE id=$1', [paymentId])).rows[0].refunded_cents, 5000);

    // hold release
    const req = await venue(mgr, { currency: 'INR', payment_mode: 'online_required', rate: 100000 });
    const r = must(await api('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: req.court.id, starts_at: at(8, 10), ends_at: at(8, 11) }] } }), 201);
    await pool.query("UPDATE reservations SET payment_deadline = now() - interval '1 minute' WHERE id=$1", [r.id]);
    const cycle = await maintenanceCycle();
    assert.equal(cycle.holds_released, 1);
    assert.equal(must(await api('GET', `/reservations/${r.id}`, { token: u.token })).status, 'cancelled');

    // reminder: the booking is accounted for even though the notification could not be stored
    const soon = new Date(Date.now() + 3 * 3600e3); soon.setUTCMinutes(0, 0, 0);
    const rem = must(await api('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: req.court.id, starts_at: new Date(+soon + 20 * 3600e3).toISOString(), ends_at: new Date(+soon + 21 * 3600e3).toISOString() }] } }), 201);
    await pool.query("UPDATE reservations SET payment_deadline = NULL WHERE id=$1", [rem.id]);
    assert.ok((await queueReminders()) >= 1);
    assert.ok((await pool.query('SELECT reminded_at FROM bookings WHERE id=$1', [rem.bookings[0].id])).rows[0].reminded_at);

    const retryKinds = (await pool.query("SELECT payload->>'kind' AS kind FROM jobs WHERE kind='notify.retry' AND status='queued'")).rows.map((x) => x.kind);
    for (const k of ['refund_issued', 'booking_expired', 'booking_reminder']) assert.ok(retryKinds.includes(k), `retry job for ${k}`);
  } finally {
    await pool.query('DROP TRIGGER t61_fail ON notifications');
  }
  // the store is back: the retry jobs deliver
  await pool.query("UPDATE jobs SET run_at = now() WHERE kind='notify.retry' AND status='queued'"); // skip the backoff wait
  const run = await jobs.runJobs('notify', notifyHandlers);
  assert.ok(run.succeeded >= 3);
  const kinds = (await pool.query('SELECT DISTINCT kind FROM notifications')).rows.map((x) => x.kind);
  for (const k of ['refund_issued', 'booking_expired', 'booking_reminder']) assert.ok(kinds.includes(k), `${k} delivered after recovery`);
});

test('email failures back off, then dead-letter, and never block holds or refunds', async () => {
  const mgr = await signup(['venue_manager']);
  const u = await signup();
  const req = await venue(mgr, { currency: 'INR', payment_mode: 'online_required', rate: 100000 });
  const r = must(await api('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: req.court.id, starts_at: at(9, 10), ends_at: at(9, 11) }] } }), 201);
  await pool.query("UPDATE reservations SET payment_deadline = now() - interval '1 minute' WHERE id=$1", [r.id]);
  const saved = config.notifyWebhook.url;
  config.notifyWebhook.url = 'http://127.0.0.1:1/email'; // bridge is down
  try {
    const cycle = await maintenanceCycle();
    assert.equal(cycle.holds_released, 1, 'hold released although email is down');
    assert.ok(cycle.failed >= 1, 'email failures are reported');
    assert.equal(must(await api('GET', `/reservations/${r.id}`, { token: u.token })).status, 'cancelled');
    const d = (await pool.query("SELECT * FROM notification_deliveries WHERE channel='email' AND status='pending' AND attempts=1 ORDER BY created_at DESC LIMIT 1")).rows[0];
    assert.ok(d.next_attempt_at > new Date(), 'backs off');
    assert.equal((await maintenanceCycle()).failed, 0, 'not retried before its backoff');

    // exhaust the attempts: dead-lettered with a visible record
    await pool.query("UPDATE notification_deliveries SET attempts=4, next_attempt_at=NULL, claimed_at=NULL WHERE id=$1", [d.id]);
    await maintenanceCycle();
    assert.equal((await pool.query('SELECT status FROM notification_deliveries WHERE id=$1', [d.id])).rows[0].status, 'failed');
    const dead = must(await api('GET', '/admin/jobs', { token: admin.token, query: { status: 'dead', category: 'email' } })).find((j) => j.subject_id === d.id);
    assert.ok(dead);
    must(await api('POST', `/admin/jobs/${dead.id}/requeue`, { token: admin.token }));
    const back = (await pool.query('SELECT status, attempts FROM notification_deliveries WHERE id=$1', [d.id])).rows[0];
    assert.deepEqual([back.status, back.attempts], ['pending', 0]);
  } finally { config.notifyWebhook.url = saved; }
});

test('maintenance categories are isolated: a crashing step is reported and the rest still run', async () => {
  const mod = await import('../src/worker.js');
  const original = mod.STEPS[0][2];
  mod.STEPS[0][2] = async () => { throw new Error('holds exploded'); };
  try {
    const out = await maintenanceCycle();
    assert.equal(out.errors.holds, 'holds exploded');
    assert.ok('refunds' in out && 'waitlist' in out, 'later steps ran');
  } finally { mod.STEPS[0][2] = original; }
});
