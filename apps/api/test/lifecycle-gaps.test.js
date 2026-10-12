import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { createHmac } from 'node:crypto';

// stand-in for Stripe Checkout + refunds; can be told to refuse refunds
const fake = { sessions: {}, refunds: [], keys: [], n: 0, refuseRefund: false };
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
    await new Promise((r) => setTimeout(r, 100)); // widen the race window
    if (fake.refuseRefund) return send(500, { error: { message: 'refund refused' } });
    fake.refunds.push(new URLSearchParams(raw).get('payment_intent')); fake.keys.push(req.headers['idempotency-key']);
    return send(200, { id: `re_${fake.refunds.length}` });
  }
  send(404, {});
});
await new Promise((r) => stripe.listen(0, '127.0.0.1', r));
Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_API_BASE: `http://127.0.0.1:${stripe.address().port}`, APP_URL: 'http://app.test', CORS_ORIGINS: 'http://app.test' });
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
  const r = await api('POST', '/auth/register', { body: { handle: `lg_${n}_${roles[0]}`, display_name: `Lg ${n}`, email: `lg${n}@example.com`, password: 'correct-horse-battery', roles } });
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
  await pool.query("INSERT INTO verification_cases(type, subject_type, subject_id, requested_by, status, rules_version, decided_at, expires_at) VALUES ('doctor','user',$1,$1,'approved',1,now(), now() + interval '300 days')", [u.id]);
  return u;
};
const hire = async (athlete, coach) => ok(await api('POST', '/hires', { token: athlete.token, body: { coach_id: coach.id, sport: 'football', starts_at: inFuture(60 + slot++, 9), duration_min: 60 } }), 201);
const appt = async (athlete, doc) => ok(await api('POST', '/appointments', { token: athlete.token, body: { provider_id: doc.id, starts_at: inFuture(60 + slot++, 10) } }), 201);
const started = (table, id) => pool.query(`UPDATE ${table} SET starts_at = now() - interval '2 hours' WHERE id=$1`, [id]);
const pay = async (athlete, type, id) => {
  const p = ok(await api('POST', '/payments', { token: athlete.token, body: { purpose_type: type, purpose_id: id, provider: 'stripe' } }), 201);
  fake.sessions[p.checkout_url.split('/').pop()].payment_status = 'paid';
  assert.equal(ok(await api('POST', `/payments/${p.id}/confirm`, { token: athlete.token })).status, 'paid');
  return p;
};
// open a checkout and let the provider say it is paid, but do not settle it yet
const checkout = async (athlete, type, id) => {
  const p = ok(await api('POST', '/payments', { token: athlete.token, body: { purpose_type: type, purpose_id: id, provider: 'stripe' } }), 201);
  const sid = p.checkout_url.split('/').pop(); fake.sessions[sid].payment_status = 'paid';
  return { ...p, sid };
};
const rpc = async (name, args, token) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  return (await r.json()).result;
};
const count = async (sql, args) => (await pool.query(sql, args)).rows[0].n;
const rowOf = async (table, id) => (await pool.query(`SELECT status, payment_status FROM ${table} WHERE id=$1`, [id])).rows[0];

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); stripe.close(); await pool.end(); });

for (const [type, table, mk] of [['coach_hire', 'coach_hires', 'hire'], ['appointment', 'appointments', 'appt']]) {
  test(`${type}: a checkout opened before expiry or completion cannot revive it; the payment is refunded once`, async () => {
    const athlete = await signup(['athlete']), coach = await coachOf(), doc = await doctor();
    const make = () => (mk === 'hire' ? hire(athlete, coach) : appt(athlete, doc));
    const provider = mk === 'hire' ? coach : doc;

    // expired by the sweep after the checkout was opened
    const x = await make();
    const co = await checkout(athlete, type, x.id);
    await started(table, x.id);
    await expireStaleRequests();
    assert.equal((await rowOf(table, x.id)).status, 'expired');
    const b1 = fake.refunds.length;
    assert.equal(ok(await api('POST', `/payments/${co.id}/confirm`, { token: athlete.token })).status, 'refunded');
    await api('POST', `/payments/${co.id}/confirm`, { token: athlete.token });   // a repeat changes nothing
    assert.equal(fake.refunds.length - b1, 1, 'refunded once');
    assert.deepEqual(Object.values(await rowOf(table, x.id)), ['expired', 'unpaid'], 'stays expired and unpaid');
    assert.equal(await count("SELECT count(*)::int AS n FROM payments WHERE purpose_id=$1 AND status='refunded'", [x.id]), 1);

    // completed (payment not required by then) after the checkout was opened
    const y = await make();
    const co2 = await checkout(athlete, type, y.id);
    await pool.query(`UPDATE ${table} SET status='confirmed', payment_status='not_required' WHERE id=$1`, [y.id]);
    await started(table, y.id);
    ok(await patch(`${mk === 'hire' ? '/hires' : '/appointments'}/${y.id}`, provider, 'completed'));
    const b2 = fake.refunds.length;
    assert.equal(ok(await api('POST', `/payments/${co2.id}/confirm`, { token: athlete.token })).status, 'refunded');
    assert.equal(fake.refunds.length - b2, 1);
    const r2 = await rowOf(table, y.id);
    assert.equal(r2.status, 'completed'); assert.notEqual(r2.payment_status, 'paid');
  });
}

test('a refused provider refund leaves the engagement unchanged: no history row, no notification, still paid', async () => {
  const athlete = await signup(['athlete']), coach = await coachOf(), doc = await doctor();
  for (const [type, table, base_, x] of [['coach_hire', 'coach_hires', '/hires', await hire(athlete, coach)], ['appointment', 'appointments', '/appointments', await appt(athlete, doc)]]) {
    await pay(athlete, type, x.id);
    const hist = () => count('SELECT count(*)::int AS n FROM engagement_status_history WHERE subject_id=$1', [x.id]);
    const notes = () => count("SELECT count(*)::int AS n FROM notifications WHERE data->>'hire_id'=$1 OR data->>'appointment_id'=$1", [x.id]);
    const [h0, n0] = [await hist(), await notes()];
    fake.refuseRefund = true;
    const refused = await patch(`${base_}/${x.id}`, athlete, 'cancelled', 'nope');
    fake.refuseRefund = false;
    assert.ok(refused.status >= 400, `${type}: cancel fails when the provider refuses (${refused.status})`);
    assert.deepEqual(Object.values(await rowOf(table, x.id)), ['requested', 'paid']);
    assert.equal(await hist(), h0, 'no history row for a move that did not happen');
    assert.equal(await notes(), n0, 'no notification for it either');
    assert.equal(await count("SELECT count(*)::int AS n FROM payments WHERE purpose_id=$1 AND status='paid'", [x.id]), 1, 'payment still paid');
    ok(await patch(`${base_}/${x.id}`, athlete, 'cancelled'));   // a retry then succeeds
    assert.equal(await count("SELECT count(*)::int AS n FROM payments WHERE purpose_id=$1 AND status='refunded'", [x.id]), 1);
  }
});

test('payment webhook racing a cancel: the money is returned exactly once whoever wins', async () => {
  const athlete = await signup(['athlete']), coach = await coachOf();
  for (let round = 0; round < 3; round++) {
    const h = await hire(athlete, coach);
    const co = await checkout(athlete, 'coach_hire', h.id);
    const evt = JSON.stringify({ type: 'checkout.session.completed', data: { object: { ...fake.sessions[co.sid] } } });
    const t = Math.floor(Date.now() / 1000), sig = `t=${t},v1=${createHmac('sha256', 'whsec_test').update(`${t}.${evt}`).digest('hex')}`;
    const before_ = fake.refunds.length;
    const [hook, cancel] = await Promise.all([
      fetch(`${base}/api/v1/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': sig, 'content-type': 'application/json' }, body: evt }),
      patch(`/hires/${h.id}`, athlete, 'cancelled'),
    ]);
    assert.equal(hook.status, 200); assert.equal(cancel.status, 200);
    assert.equal((await rowOf('coach_hires', h.id)).status, 'cancelled');
    assert.equal(fake.refunds.length - before_, 1, `round ${round}: one refund`);
    assert.equal(await count("SELECT count(*)::int AS n FROM payments WHERE purpose_id=$1 AND status='refunded'", [h.id]), 1);
    assert.equal(await count("SELECT count(*)::int AS n FROM payments WHERE purpose_id=$1 AND status='paid'", [h.id]), 0, 'nothing left paid on a cancelled session');
  }
});

test('authorization: strangers cannot confirm, complete or read the timeline; an admin may cancel but never confirm', async () => {
  const athlete = await signup(['athlete']), coach = await coachOf(), doc = await doctor(), stranger = await signup(['athlete']), admin = await signup(['athlete']);
  await pool.query("UPDATE users SET roles = roles || '{admin}' WHERE id=$1", [admin.id]);
  for (const [base_, x, provider] of [['/hires', await hire(athlete, coach), coach], ['/appointments', await appt(athlete, doc), doc]]) {
    for (const s of ['confirmed', 'completed', 'cancelled']) assert.equal((await patch(`${base_}/${x.id}`, stranger, s)).status, 403, `stranger ${s}`);
    assert.equal((await api('GET', `${base_}/${x.id}/timeline`, { token: stranger.token })).status, 403);
    assert.equal((await patch(`${base_}/${x.id}`, admin, 'confirmed')).status, 403, 'admin never confirms');
    assert.equal((await patch(`${base_}/${x.id}`, athlete, 'completed')).status, 403, 'customer never completes');
    await pay(athlete, base_ === '/hires' ? 'coach_hire' : 'appointment', x.id);
    ok(await patch(`${base_}/${x.id}`, provider, 'confirmed'));
    assert.equal((await patch(`${base_}/${x.id}`, stranger, 'completed')).status, 403);
    ok(await patch(`${base_}/${x.id}`, admin, 'cancelled', 'Support intervention'));
    const e = ok(await api('GET', `${base_}/${x.id}/timeline`, { token: athlete.token })).entries.at(-1);
    assert.deepEqual([e.to_status, e.actor_id, e.reason], ['cancelled', admin.id, 'Support intervention']);
  }
});

test('update_hire, update_appointment and both timelines are in OpenAPI and MCP with the same permissions', async () => {
  const spec = (await api('GET', '/openapi.json')).body;
  for (const [path, method] of [['/hires/{id}', 'patch'], ['/appointments/{id}', 'patch'], ['/hires/{id}/timeline', 'get'], ['/appointments/{id}/timeline', 'get']]) assert.ok(spec.paths[path]?.[method], `${method} ${path}`);
  const athlete = await signup(['athlete']), coach = await coachOf(), doc = await doctor(), stranger = await signup(['athlete']);
  const h = await hire(athlete, coach), a = await appt(athlete, doc);
  const list = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  const names = (await list.json()).result.tools.map((t) => t.name);
  for (const n_ of ['update_hire', 'update_appointment', 'get_hire_timeline', 'get_appointment_timeline']) assert.ok(names.includes(n_), n_);
  for (const [n_, args] of [['update_hire', { id: h.id, status: 'confirmed' }], ['update_appointment', { id: a.id, status: 'confirmed' }], ['get_hire_timeline', { id: h.id }], ['get_appointment_timeline', { id: a.id }]]) {
    const anon = await rpc(n_, args); assert.equal(anon.isError, true); assert.equal(JSON.parse(anon.content[0].text).code, 'unauthorized', `${n_} anonymous`);
    const str = await rpc(n_, args, stranger.token); assert.equal(str.isError, true); assert.equal(JSON.parse(str.content[0].text).code, 'forbidden', `${n_} stranger`);
  }
  assert.equal((await rpc('update_hire', { id: h.id, status: 'confirmed' }, athlete.token)).isError, true, 'customer cannot confirm via MCP either');
  await pay(athlete, 'coach_hire', h.id);
  assert.equal((await rpc('update_hire', { id: h.id, status: 'confirmed', reason: 'ok' }, coach.token)).structuredContent.result.status, 'confirmed');
  assert.equal((await rpc('update_appointment', { id: a.id, status: 'cancelled', reason: 'later' }, athlete.token)).structuredContent.result.status, 'cancelled');
  assert.deepEqual((await rpc('get_hire_timeline', { id: h.id }, athlete.token)).structuredContent.result.entries.map((e) => e.to_status), ['requested', 'confirmed']);
  const at = (await rpc('get_appointment_timeline', { id: a.id }, doc.token)).structuredContent.result.entries;
  assert.deepEqual(at.map((e) => [e.to_status, e.reason]), [['requested', null], ['cancelled', 'later']]);
});

// last: this one rebuilds the schema
test('migration 042 only widens the status checks: existing rows are untouched', async () => {
  const dir = new URL('../migrations/', import.meta.url);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE TABLE schema_migrations (name text PRIMARY KEY, at timestamptz DEFAULT now())');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql') && x < '042').sort()) { await pool.query(readFileSync(new URL(f, dir), 'utf8')); await pool.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]); }
  const mk = async (h) => (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ($1,$1,'{athlete}','x','x',$1) RETURNING id", [h])).rows[0].id;
  const [a, p] = [await mk('m42_a'), await mk('m42_p')];
  for (const s of ['requested', 'confirmed', 'completed', 'cancelled']) {
    await pool.query("INSERT INTO appointments(athlete_id, provider_id, starts_at, duration_min, reason_enc, status) VALUES ($1,$2,now() + interval '2 days',30,'enc',$3)", [a, p, s]);
    await pool.query("INSERT INTO coach_hires(hirer_id, coach_id, starts_at, total_cents, note, status) VALUES ($1,$2,now() + interval '2 days',500,'n',$3)", [a, p, s]);
  }
  const snap = async () => ({
    appts: (await pool.query('SELECT to_jsonb(t) AS j FROM appointments t ORDER BY id')).rows.map((r) => r.j),
    hires: (await pool.query('SELECT to_jsonb(t) AS j FROM coach_hires t ORDER BY id')).rows.map((r) => r.j),
  });
  const beforeRows = await snap();
  await pool.query(readFileSync(new URL('042_expired_status.sql', dir), 'utf8'));
  assert.deepEqual(await snap(), beforeRows, '042 leaves every column of every row as it was');
  await migrate();   // the rest of the chain keeps them too
  const after_ = await snap();
  assert.equal(after_.appts.length, 4); assert.equal(after_.hires.length, 4);
  assert.deepEqual(after_.appts.map((r) => r.status).sort(), ['cancelled', 'completed', 'confirmed', 'requested']);
  assert.deepEqual(after_.hires.map((r) => [r.total_cents, r.note].join()), Array(4).fill('500,n'));
});
