import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// stand-in for Stripe Checkout + refunds
const fake = { sessions: {}, refunds: [], n: 0 };
const stripe = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString(), send = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
  if (req.url === '/v1/checkout/sessions' && req.method === 'POST') {
    const f = new URLSearchParams(raw); const id = `cs_${++fake.n}`;
    fake.sessions[id] = { id, amount_total: Number(f.get('line_items[0][price_data][unit_amount]')), currency: f.get('line_items[0][price_data][currency]'), name: f.get('line_items[0][price_data][product_data][name]'), payment_status: 'unpaid', payment_intent: `pi_${fake.n}` };
    return send(200, { id, url: `https://checkout.stripe.test/${id}` });
  }
  if (req.url.startsWith('/v1/checkout/sessions/')) { const s = fake.sessions[req.url.split('/').pop()]; return s ? send(200, s) : send(404, { error: { message: 'no such session' } }); }
  if (req.url === '/v1/refunds') { fake.refunds.push(new URLSearchParams(raw).get('payment_intent')); return send(200, { id: 're_1' }); }
  send(404, {});
});
await new Promise((r) => stripe.listen(0, '127.0.0.1', r));
Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_API_BASE: `http://127.0.0.1:${stripe.address().port}`, APP_URL: 'http://app.test', CORS_ORIGINS: 'http://app.test' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { queueHealthReminders } = await import('../src/notify.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `tp_${n}_${roles[0]}`, display_name: `Appt ${n}`, email: `tp${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const provider = async (role = 'physio', profile = {}) => {
  const u = await signup([role]);
  must(await api('POST', '/me/sport-profiles', { token: u.token, body: { sport: 'football', role } }), 201);
  must(await api('POST', '/me/provider-profile', { token: u.token, body: { provider_type: role, ...profile } }));
  await pool.query("INSERT INTO verification_cases(type, subject_type, subject_id, requested_by, status, rules_version, decided_at, expires_at) VALUES ($1,'user',$2,$2,'approved',1,now(), now() + interval '300 days')", [role, u.id]);
  return u;
};
const at = (days, hour = 10) => { const d = new Date(Date.now() + days * 864e5); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };
const day = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const book = (ath, doc, days = 5, extra = {}) => api('POST', '/appointments', { token: ath.token, body: { provider_id: doc.id, starts_at: at(days), reason: 'private knee problem', ...extra } });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); stripe.close(); await pool.end(); });


test('treatment plans: versioned, immutable once published, gated by credential + full consent, private notes stay private', async () => {
  const doc = await provider('physio'), stranger = await provider('physio'), ath = await signup(), fin = await signup();
  const ex = (token, extra = {}) => api('POST', '/me/exercises', { token, body: { title: 'Heel slide', body_region: 'knee', equipment: ['towel'], difficulty: 'beginner', goal: 'mobility', instructions: 'Lie on your back and slide the heel towards you.', ...extra } });
  const e1 = must(await ex(doc.token));
  assert.equal((await ex(doc.token, { media_url: 'https://cdn.example.com/a.mp4' })).status, 400, 'media needs source and licence');
  assert.equal((await ex(ath.token)).status, 403);
  const e2 = must(await ex(doc.token, { id: e1.id, instructions: 'Lie on your back and slowly slide the heel towards you.' }));
  assert.deepEqual([e2.version, e2.id === e1.id], [2, true]);
  const lib = must(await api('GET', '/me/exercises', { token: doc.token, query: { body_region: 'knee', equipment: 'towel' } }));
  assert.equal(lib.total, 1);
  assert.equal(must(await api('GET', '/me/exercises', { token: doc.token, query: { body_region: 'neck' } })).total, 0);

  const body = { patient_id: ath.id, title: 'Knee rehab', goals: 'Climb stairs without pain', patient_instructions: 'Daily, gently', private_notes: 'possible ACL grade 2 - watch', items: [{ exercise_id: e1.id, sets: 3, reps: 10, side: 'both', times_per_week: 5, notes: 'slow', stop_instructions: 'stop if sharp pain' }] };
  assert.equal((await api('POST', '/treatment-plans', { token: doc.token, body })).status, 403, 'no consent yet');
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: doc.id, scope: 'clearance' } }), 201);
  assert.equal((await api('POST', '/treatment-plans', { token: doc.token, body })).status, 403, 'clearance-only consent is not enough');
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: doc.id, scope: 'full' } }), 201);
  assert.equal((await api('POST', '/treatment-plans', { token: stranger.token, body })).status, 403, 'unrelated provider');
  assert.equal((await api('POST', '/treatment-plans', { token: doc.token, body: { ...body, items: [{ exercise_id: (must(await ex(stranger.token))).id }] } })).status, 400, "someone else's exercise");

  const plan = must(await api('POST', '/treatment-plans', { token: doc.token, body }), 201);
  assert.deepEqual([plan.status, plan.versions[0].status, plan.versions[0].private_notes], ['draft', 'draft', 'possible ACL grade 2 - watch']);
  assert.equal((await api('GET', `/treatment-plans/${plan.id}`, { token: ath.token })).status, 404, 'a draft is invisible to the patient');
  const raw = (await pool.query('SELECT private_notes_enc, goals_enc FROM treatment_plan_versions')).rows[0];
  assert.ok(!/ACL|stairs/.test(JSON.stringify(raw)), 'encrypted at rest');

  const upd = { base_version: 1, goals: 'Climb stairs', items: [{ ...body.items[0], reps: 12 }, { exercise_id: e1.id, phase: 2, sets: 2, hold_sec: 30 }] };
  assert.equal((await api('PATCH', `/treatment-plans/${plan.id}/draft`, { token: doc.token, body: { ...upd, base_version: 9 } })).status, 409, 'stale edit refused');
  assert.equal(must(await api('PATCH', `/treatment-plans/${plan.id}/draft`, { token: doc.token, body: upd })).versions[0].items.length, 2);
  assert.equal((await api('POST', `/treatment-plans/${plan.id}/publish`, { token: stranger.token, body: { base_version: 1 } })).status, 404);
  const pub = must(await api('POST', `/treatment-plans/${plan.id}/publish`, { token: doc.token, body: { base_version: 1 } }));
  assert.deepEqual([pub.status, pub.versions[0].status], ['active', 'published']);
  assert.equal((await api('PATCH', `/treatment-plans/${plan.id}/draft`, { token: doc.token, body: upd })).status, 409, 'published is immutable');

  const seen = must(await api('GET', `/treatment-plans/${plan.id}`, { token: ath.token }));
  assert.equal(seen.versions[0].private_notes, undefined, 'patient never sees private notes');
  assert.deepEqual([seen.versions[0].goals, seen.versions[0].items[0].stop_instructions, seen.versions[0].items[0].reps], ['Climb stairs', 'stop if sharp pain', 12]);
  assert.equal((await api('GET', `/treatment-plans/${plan.id}`, { token: fin.token })).status, 404, 'unrelated user');
  assert.equal(must(await api('POST', `/treatment-plans/${plan.id}/acknowledge`, { token: ath.token })).version, 1);
  assert.equal(must(await api('GET', '/treatment-plans', { token: ath.token })).length, 1);

  // revise -> new draft; version 1 stays in force and unchanged until v2 is published
  const rev = must(await api('POST', `/treatment-plans/${plan.id}/revise`, { token: doc.token }), 201);
  assert.deepEqual(rev.versions.map((v) => [v.version, v.status]), [[2, 'draft'], [1, 'published']]);
  assert.equal((await api('POST', `/treatment-plans/${plan.id}/revise`, { token: doc.token })).status, 409);
  must(await api('PATCH', `/treatment-plans/${plan.id}/draft`, { token: doc.token, body: { base_version: 2, items: [{ exercise_id: e1.id, sets: 1, reps: 5 }] } }));
  assert.equal(must(await api('GET', `/treatment-plans/${plan.id}`, { token: ath.token })).versions.length, 1, 'draft v2 hidden');
  must(await api('POST', `/treatment-plans/${plan.id}/publish`, { token: doc.token, body: { base_version: 2 } }));
  const after = must(await api('GET', `/treatment-plans/${plan.id}`, { token: ath.token }));
  assert.deepEqual(after.versions.map((v) => [v.version, v.status, v.items.length]), [[2, 'published', 1], [1, 'superseded', 2]], 'history kept');
  must(await api('POST', `/treatment-plans/${plan.id}/status`, { token: doc.token, body: { status: 'paused' } }));

  // revocation: the provider loses access at once, the patient keeps theirs
  must(await api('DELETE', `/medical/grants/${doc.id}`, { token: ath.token }));
  assert.equal((await api('GET', `/treatment-plans/${plan.id}`, { token: doc.token })).status, 403);
  assert.equal((await api('POST', `/treatment-plans/${plan.id}/revise`, { token: doc.token })).status, 403);
  assert.equal(must(await api('GET', `/treatment-plans/${plan.id}`, { token: ath.token })).versions.length, 2);
  assert.equal(must(await api('GET', '/treatment-plans', { token: doc.token })).length, 0, 'revoked patients drop out of the provider list');
  // the exercise version used by the plan is unchanged by later edits
  must(await ex(doc.token, { id: e1.id, title: 'Heel slide (new)' }));
  assert.equal(must(await api('GET', `/treatment-plans/${plan.id}`, { token: ath.token })).versions[1].items[0].title, 'Heel slide');
});
