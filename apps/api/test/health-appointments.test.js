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
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `ha_${n}_${roles[0]}`, display_name: `Appt ${n}`, email: `ha${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const provider = async (role = 'physio', profile = {}) => {
  const u = await signup([role]);
  must(await api('POST', '/me/sport-profiles', { token: u.token, body: { sport: 'football', role } }), 201);
  must(await api('POST', '/me/provider-profile', { token: u.token, body: { provider_type: role, ...profile } }));
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

test('paid appointments: unpaid until checkout, provider cannot confirm first, cancel refunds, no clinical text at the payment provider', async () => {
  const doc = await provider('doctor', { consult_fee_cents: 120000 });
  const ath = await signup(), other = await signup();
  const a = must(await book(ath, doc), 201);
  assert.deepEqual([a.fee_cents, a.payment_status, a.currency], [120000, 'unpaid', 'INR']);
  assert.equal((await api('PATCH', `/appointments/${a.id}`, { token: doc.token, body: { status: 'confirmed' } })).status, 409, 'waiting for payment');
  assert.equal((await api('POST', '/payments', { token: other.token, body: { purpose_type: 'appointment', purpose_id: a.id, provider: 'stripe' } })).status, 403, 'only the athlete pays');
  const pay = must(await api('POST', '/payments', { token: ath.token, body: { purpose_type: 'appointment', purpose_id: a.id, provider: 'stripe' } }), 201);
  assert.equal(pay.amount_cents, 120000);
  const sess = fake.sessions[pay.checkout_url.split('/').pop()];
  assert.equal(sess.amount_total, 120000); assert.ok(!/knee/i.test(JSON.stringify(sess)), 'the reason never reaches the payment provider');
  assert.equal(must(await api('POST', `/payments/${pay.id}/confirm`, { token: ath.token })).status, 'pending');
  sess.payment_status = 'paid';
  assert.equal(must(await api('POST', `/payments/${pay.id}/confirm`, { token: ath.token })).status, 'paid');
  assert.equal(must(await api('GET', '/appointments', { token: ath.token }))[0].payment_status, 'paid');
  assert.equal((await api('POST', '/payments', { token: ath.token, body: { purpose_type: 'appointment', purpose_id: a.id, provider: 'stripe' } })).status, 409, 'already paid');
  must(await api('PATCH', `/appointments/${a.id}`, { token: doc.token, body: { status: 'confirmed' } }));
  const out = must(await api('PATCH', `/appointments/${a.id}`, { token: ath.token, body: { status: 'cancelled' } }));
  assert.equal(out.payment_status, 'refunded'); assert.deepEqual(fake.refunds, ['pi_1']);
  assert.equal(must(await api('GET', '/payments', { token: ath.token }))[0].status, 'refunded');

  // no fee, no payment step
  const free = await provider('physio', { consult_fee_cents: 0 });
  const f = must(await book(ath, free, 6), 201);
  assert.equal(f.payment_status, 'not_required');
  must(await api('PATCH', `/appointments/${f.id}`, { token: free.token, body: { status: 'confirmed' } }));
  // an unpaid appointment that is cancelled can no longer be paid
  const a2 = must(await book(ath, doc, 7), 201);
  must(await api('PATCH', `/appointments/${a2.id}`, { token: ath.token, body: { status: 'cancelled' } }));
  assert.equal((await api('POST', '/payments', { token: ath.token, body: { purpose_type: 'appointment', purpose_id: a2.id, provider: 'stripe' } })).status, 409);
});

test('follow-ups: summary for the athlete, sensitive details encrypted and consent-gated, book/complete/cancel flow, reminders', async () => {
  const doc = await provider('physio', { consult_fee_cents: 0 });
  const ath = await signup(), stranger = await signup();
  const a = must(await book(ath, doc), 201);
  const mk = (body) => api('POST', '/followups', { token: doc.token, body: { appointment_id: a.id, due_on: day(14), instruction_summary: 'Gentle mobility work, review the knee', ...body } });
  assert.equal((await mk({})).status, 409, 'appointment not confirmed yet');
  must(await api('PATCH', `/appointments/${a.id}`, { token: doc.token, body: { status: 'confirmed' } }));
  assert.equal((await api('POST', '/followups', { token: stranger.token, body: { appointment_id: a.id, due_on: day(14), instruction_summary: 'x y z' } })).status, 403, 'not a provider');
  assert.equal((await mk({ due_on: day(-2) })).status, 400);
  assert.equal((await mk({ window_end: day(3) })).status, 400);
  assert.equal((await mk({ details: 'ACL grade 2 suspected' })).status, 403, 'sensitive details need consent');
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: doc.id } }), 201);
  const f = must(await mk({ details: 'ACL grade 2 suspected', window_end: day(21) }), 201);
  assert.ok(!(await pool.query('SELECT details_enc FROM appointment_followups WHERE id=$1', [f.id])).rows[0].details_enc.includes('ACL'));
  assert.ok((await pool.query("SELECT body FROM notifications WHERE user_id=$1 AND kind='followup_created'", [ath.id])).rows.every((r) => !/ACL|knee|mobility/i.test(r.body)));

  const list = must(await api('GET', '/followups', { token: ath.token }));
  assert.equal(list.length, 1); assert.deepEqual([list[0].status, list[0].has_details, list[0].overdue, list[0].provider_name], ['due', true, false, doc.display_name]);
  assert.ok(!JSON.stringify(list).includes('ACL'), 'listing never carries details');
  assert.deepEqual(must(await api('GET', '/followups', { token: stranger.token })), []);
  assert.equal((await api('GET', `/followups/${f.id}`, { token: stranger.token })).status, 404);
  assert.equal(must(await api('GET', `/followups/${f.id}`, { token: ath.token })).details, 'ACL grade 2 suspected');
  assert.equal(must(await api('GET', `/followups/${f.id}`, { token: doc.token })).details, 'ACL grade 2 suspected');
  const audits = (await pool.query("SELECT actor_id FROM audit_log WHERE action='read_clinical' AND entity='appointment_followups'")).rows.map((r) => r.actor_id);
  assert.ok(audits.includes(ath.id) && audits.includes(doc.id), 'details reads are audit-logged');
  must(await api('DELETE', `/medical/grants/${doc.id}`, { token: ath.token }));
  const hidden = must(await api('GET', `/followups/${f.id}`, { token: doc.token }));
  assert.deepEqual([hidden.details, hidden.details_visible, hidden.instruction_summary], [null, false, 'Gentle mobility work, review the knee'], 'consent withdrawn: the provider keeps the summary only');

  // reschedule, then book the visit from the follow-up
  must(await api('PATCH', `/followups/${f.id}`, { token: ath.token, body: { due_on: day(10), window_end: null } }));
  assert.equal((await api('PATCH', `/followups/${f.id}`, { token: ath.token, body: { due_on: day(-1) } })).status, 400);
  assert.equal((await api('PATCH', `/followups/${f.id}`, { token: stranger.token, body: { status: 'done' } })).status, 404);
  const visit = must(await api('POST', '/appointments', { token: ath.token, body: { provider_id: doc.id, starts_at: at(9, 15), followup_id: f.id } }), 201);
  assert.equal(must(await api('GET', `/followups/${f.id}`, { token: ath.token })).status, 'booked');
  assert.equal((await api('POST', '/appointments', { token: ath.token, body: { provider_id: doc.id, starts_at: at(9, 17), followup_id: f.id } })).status, 409, 'already booked');
  must(await api('PATCH', `/appointments/${visit.id}`, { token: ath.token, body: { status: 'cancelled' } }));
  assert.equal(must(await api('GET', `/followups/${f.id}`, { token: ath.token })).status, 'due', 'cancelled visit puts it back to due');
  const visit2 = must(await api('POST', '/appointments', { token: ath.token, body: { provider_id: doc.id, starts_at: at(9, 16), followup_id: f.id } }), 201);
  must(await api('PATCH', `/appointments/${visit2.id}`, { token: doc.token, body: { status: 'confirmed' } }));
  must(await api('PATCH', `/appointments/${visit2.id}`, { token: doc.token, body: { status: 'completed' } }));
  const done = must(await api('GET', `/followups/${f.id}`, { token: ath.token }));
  assert.equal(done.status, 'done'); assert.ok(done.completed_at);
  assert.equal((await api('PATCH', `/followups/${f.id}`, { token: ath.token, body: { status: 'cancelled' } })).status, 409, 'closed follow-ups are final');

  // reminders: once, generic, only when due soon
  const soon = must(await mk({ due_on: day(1), instruction_summary: 'Check swelling and send a photo' }), 201);
  const far = must(await mk({ due_on: day(40), instruction_summary: 'Routine review in a while' }), 201);
  const sent = await queueHealthReminders();
  assert.ok(sent >= 1);
  const rem = (await pool.query("SELECT body FROM notifications WHERE user_id=$1 AND kind='followup_reminder'", [ath.id])).rows;
  assert.equal(rem.length, 1); assert.ok(!/swelling|photo|knee/i.test(rem[0].body));
  assert.equal(await queueHealthReminders(), 0, 'not sent twice');
  assert.equal((await pool.query('SELECT reminder_sent_at FROM appointment_followups WHERE id=$1', [far.id])).rows[0].reminder_sent_at, null);
  assert.ok((await pool.query('SELECT reminder_sent_at FROM appointment_followups WHERE id=$1', [soon.id])).rows[0].reminder_sent_at);
  await pool.query("UPDATE appointment_followups SET status='due', due_on = current_date - 3 WHERE id=$1", [soon.id]);
  assert.equal(must(await api('GET', '/followups', { token: ath.token, query: { status: 'open' } })).find((x) => x.id === soon.id).overdue, true);
});

test('external booking: validated links with a disclosure, one appointment per reference, reconciled status, no credentials stored', async () => {
  const doc = await provider('physio', { consult_fee_cents: 50000 });
  const ath = await signup(), other = await signup();
  const cfg = (external_booking) => api('POST', '/me/provider-profile', { token: doc.token, body: { provider_type: 'physio', external_booking } });
  assert.equal((await cfg({ provider: 'generic', url: 'http://clinic.example/book' })).status, 400, 'https only');
  assert.equal((await cfg({ provider: 'generic', url: 'https://user:pw@clinic.example/book' })).status, 400, 'no credentials in links');
  assert.equal((await cfg({ provider: 'calendly', url: 'https://evil.example/book' })).status, 400, 'host must match the adapter');
  assert.equal((await api('GET', `/providers/${doc.id}/external-booking`, { token: ath.token })).status, 404, 'nothing configured yet');
  assert.equal((await api('POST', '/appointments/external', { token: ath.token, body: { provider_id: doc.id, external_reference: 'EXT-1', starts_at: at(8) } })).status, 409);
  must(await cfg({ provider: 'calendly', url: 'https://calendly.com/dr-physio/30min' }));
  const prof = must(await api('GET', `/providers/${doc.id}`));
  assert.deepEqual(prof.external_booking, { provider: 'calendly', label: 'Calendly', url: 'https://calendly.com/dr-physio/30min' });
  assert.equal(must(await api('GET', '/providers/search', { query: { q: 'Appt' } })).find((p) => p.id === doc.id).external_booking.provider, 'calendly');

  const start = must(await api('GET', `/providers/${doc.id}/external-booking`, { token: ath.token }));
  assert.equal(start.external.url, 'https://calendly.com/dr-physio/30min'); assert.match(start.disclosure, /leave SportArena/);
  assert.ok(!start.external.url.includes(ath.id) && !start.external.url.includes('@'), 'no personal data in the link');

  const body = { provider_id: doc.id, external_reference: 'EXT-100', starts_at: at(8), duration_min: 30 };
  assert.equal((await api('POST', '/appointments/external', { token: ath.token, body: { ...body, status: 'confirmed' } })).status, 403, 'athlete cannot self-confirm');
  const a = must(await api('POST', '/appointments/external', { token: ath.token, body }), 201);
  assert.deepEqual([a.status, a.source, a.external_provider, a.external_sync_status, a.existing], ['requested', 'external', 'calendly', 'linked', false]);
  const again = must(await api('POST', '/appointments/external', { token: ath.token, body }), 201);
  assert.equal(again.id, a.id); assert.equal(again.existing, true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM appointments WHERE external_reference=$1', ['EXT-100'])).rows[0].n, 1, 'no duplicate');
  assert.equal((await api('POST', '/appointments/external', { token: other.token, body })).status, 409, 'cannot claim somebody else\'s reference');
  assert.equal((await api('POST', '/appointments/external', { token: other.token, body: { ...body, external_reference: 'EXT-101' } })).status, 409, 'slot is taken');
  const cols = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='appointments' AND column_name ~ 'password|token|secret|credential'")).rows;
  assert.deepEqual(cols, [], 'no place to keep third-party credentials');

  // status comes back from the provider's side
  assert.equal((await api('POST', '/appointments/external/reconcile', { token: ath.token, body: { external_reference: 'EXT-100', status: 'confirmed' } })).status, 403);
  assert.equal((await api('POST', '/appointments/external/reconcile', { token: doc.token, body: { external_reference: 'NOPE-1', status: 'confirmed' } })).status, 404);
  const c1 = must(await api('POST', '/appointments/external/reconcile', { token: doc.token, body: { external_reference: 'EXT-100', status: 'confirmed', starts_at: at(8, 11) } }));
  assert.deepEqual([c1.status, c1.external_sync_status], ['confirmed', 'synced']); assert.ok(c1.external_synced_at);
  assert.equal(new Date(c1.starts_at).getUTCHours(), 11, 'rescheduled on the other system');
  must(await api('POST', '/appointments/external/reconcile', { token: doc.token, body: { external_reference: 'EXT-100', status: 'confirmed' } })); // repeating is harmless
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM appointments WHERE external_reference='EXT-100'")).rows[0].n, 1);
  assert.ok((await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='appointment_update'", [ath.id])).rowCount >= 1);
  must(await api('POST', '/appointments/external/reconcile', { token: doc.token, body: { external_reference: 'EXT-100', status: 'cancelled' } }));
  const bad = await api('POST', '/appointments/external/reconcile', { token: doc.token, body: { external_reference: 'EXT-100', status: 'confirmed' } });
  assert.equal(bad.status, 409); assert.equal((await pool.query("SELECT external_sync_status FROM appointments WHERE external_reference='EXT-100'")).rows[0].external_sync_status, 'error');

  // a provider registers one for a patient; it cannot be linked twice or to someone else
  const reg = must(await api('POST', '/appointments/external', { token: doc.token, body: { athlete_id: other.id, external_reference: 'EXT-200', starts_at: at(12), status: 'confirmed' } }), 201);
  assert.deepEqual([reg.athlete_id, reg.status], [other.id, 'confirmed']);
  assert.equal((await api('POST', '/appointments/external', { token: ath.token, body: { provider_id: doc.id, external_reference: 'EXT-200', starts_at: at(12) } })).status, 409);
  assert.equal((await api('POST', '/appointments/external', { token: ath.token, body: { athlete_id: other.id, external_reference: 'EXT-300', starts_at: at(14) } })).status, 403, 'only providers register for patients');
  assert.equal(must(await api('GET', '/appointments', { token: other.token })).find((x) => x.external_reference === 'EXT-200').source, 'external');
});

test('migration keeps existing appointments and adds the new defaults', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../migrations/', import.meta.url);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE TABLE schema_migrations (name text PRIMARY KEY, at timestamptz DEFAULT now())');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql') && x < '020_health_appointments.sql').sort()) { await pool.query(readFileSync(new URL(f, dir), 'utf8')); await pool.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]); }
  const mk = async (h) => (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ($1,$1,'{athlete}','x','x',$1) RETURNING id", [h])).rows[0].id;
  const [a, p] = [await mk('m_a'), await mk('m_p')];
  await pool.query("INSERT INTO appointments(athlete_id, provider_id, starts_at, duration_min, reason_enc, status) VALUES ($1,$2,now() + interval '2 days',30,'enc','confirmed')", [a, p]);
  await migrate();
  const r = (await pool.query('SELECT status, fee_cents, payment_status, source, mode, reason_enc FROM appointments')).rows[0];
  assert.deepEqual([r.status, Number(r.fee_cents), r.payment_status, r.source, r.mode, r.reason_enc], ['confirmed', 0, 'not_required', 'sportarena', 'in_person', 'enc']);
});
