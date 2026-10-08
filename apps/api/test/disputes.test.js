import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// stand-in for the Stripe refund API
const fake = { refunds: [] };
const provider = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const f = new URLSearchParams(Buffer.concat(chunks).toString());
  if (req.url === '/v1/refunds') { fake.refunds.push({ pi: f.get('payment_intent'), amount: f.get('amount'), key: req.headers['idempotency-key'] }); res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"id":"re_1"}'); }
  res.writeHead(404); res.end('{}');
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_API_BASE: `http://127.0.0.1:${provider.address().port}` });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');

let server, base, n = 0, admin, admin2;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `ds_${n}_${roles[0]}`, display_name: `Dispute ${n}`, email: `ds${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const mkAdmin = async (h) => { const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ($1,$1,'{admin}','x','x',$1) RETURNING id", [h])).rows[0]; return { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) }; };
const dispute = (u, category, links, details, extra = {}) => api('POST', '/cases', { token: u.token, body: { kind: 'dispute', category, subject: `Dispute ${category}`, description: 'Please look into this', links, details, ...extra } });
const mkPayment = async (payer, purposeType, purposeId, cents = 100000, paid = true) => (await pool.query("INSERT INTO payments(payer_id, provider, purpose_type, purpose_id, amount_cents, currency, status, provider_payment_ref, paid_at) VALUES ($1,'stripe',$2,$3,$4,'INR',$5,'pi_test',now()) RETURNING id", [payer, purposeType, purposeId, cents, paid ? 'paid' : 'pending'])).rows[0].id;
const future = (d) => new Date(Date.now() + d * 864e5).toISOString();

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  admin = await mkAdmin('ds_root'); admin2 = await mkAdmin('ds_root2');
});
after(async () => { server.close(); provider.close(); await pool.end(); });

test('booking charge dispute: typed rules, currency from the payment, staff context, refund through the payment capability', async () => {
  const u = await signup(), stranger = await signup();
  const resv = (await pool.query("INSERT INTO reservations(code, user_id, currency, total_cents) VALUES ('DSP001',$1,'INR',100000) RETURNING id", [u.id])).rows[0].id;
  const pay = await mkPayment(u.id, 'shop_order', crypto.randomUUID(), 100000);
  const links = [{ type: 'payment', id: pay }];
  assert.equal((await dispute(u, 'booking_charge', [{ type: 'event', id: crypto.randomUUID() }], { disputed_amount_cents: 100 })).status, 404); // unknown event
  assert.equal((await dispute(u, 'payment_transfer', [{ type: 'reservation', id: resv }], { disputed_amount_cents: 100 })).status, 400); // needs a payment
  assert.equal((await dispute(u, 'booking_charge', links, {})).status, 400); // amount required
  assert.equal((await dispute(u, 'booking_charge', links, { disputed_amount_cents: 100001 })).status, 400); // more than the payment
  assert.equal((await dispute(stranger, 'booking_charge', links, { disputed_amount_cents: 100 })).status, 404); // not their payment
  assert.equal((await dispute(u, 'booking_charge', [...links, { type: 'shop_order', id: crypto.randomUUID() }], { disputed_amount_cents: 100 })).status, 404); // unknown order

  assert.equal((await dispute(u, 'booking_charge', [...links, { type: 'reservation', id: resv }], { disputed_amount_cents: 40000, contested_field: 'score' })).status, 400); // game fields are not for money disputes
  const c = must(await dispute(u, 'booking_charge', [...links, { type: 'reservation', id: resv }], { disputed_amount_cents: 40000, currency: 'USD' }), 201);
  const mine = must(await api('GET', `/cases/${c.id}`, { token: u.token }));
  assert.equal(mine.details.disputed_amount_cents, 40000);
  assert.equal(mine.details.currency, 'INR', 'currency comes from the payment, not the client');

  // staff see safe facts about the linked records, audited
  const rec = must(await api('GET', `/admin/cases/${c.id}/records`, { token: admin.token }));
  const p = rec.find((r) => r.entity_type === 'payment').record;
  assert.equal(Number(p.amount_cents), 100000); assert.equal(p.provider_payment_ref, undefined);
  assert.equal(rec.find((r) => r.entity_type === 'reservation').record.code, 'DSP001');
  assert.equal((await api('GET', `/admin/cases/${c.id}/records`, { token: u.token })).status, 403);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='read_case_records'")).rowCount >= 1);

  // refund through the canonical payment capability, recorded on the dispute timeline
  assert.equal((await api('POST', `/admin/payments/${pay}/refund`, { token: u.token, body: { amount_cents: 100, reason: 'self service' } })).status, 403);
  assert.equal((await api('POST', `/admin/payments/${pay}/refund`, { token: admin.token, body: { amount_cents: 200000, reason: 'too much for this payment' } })).status, 409);
  const resv2 = (await pool.query("INSERT INTO reservations(code, user_id, currency, total_cents) VALUES ('DSP002',$1,'INR',5000) RETURNING id", [u.id])).rows[0].id;
  const unrelated = must(await dispute(u, 'refund', [{ type: 'reservation', id: resv2 }], { disputed_amount_cents: 100 }), 201);
  assert.equal((await api('POST', `/admin/payments/${pay}/refund`, { token: admin.token, body: { amount_cents: 100, reason: 'wrong case', case_id: unrelated.id } })).status, 400); // that case does not link this payment
  const r1 = must(await api('POST', `/admin/payments/${pay}/refund`, { token: admin.token, body: { amount_cents: 40000, reason: 'Charged twice, confirmed with the venue', case_id: c.id } }));
  assert.equal(Number(r1.refunded_cents), 40000); assert.equal(r1.status, 'paid');
  assert.equal(fake.refunds.at(-1).amount, '40000'); assert.match(fake.refunds.at(-1).key, /admin-refund-.*-0-40000$/);
  const r2 = must(await api('POST', `/admin/payments/${pay}/refund`, { token: admin.token, body: { reason: 'Refund the rest as a goodwill gesture' } }));
  assert.equal(r2.status, 'refunded'); assert.equal(Number(r2.refunded_now), 60000);
  assert.equal((await api('POST', `/admin/payments/${pay}/refund`, { token: admin.token, body: { reason: 'nothing left to give back' } })).status, 409);
  const tl = must(await api('GET', `/cases/${c.id}`, { token: admin2.token })).history.find((h) => h.action === 'refund_payment');
  assert.equal(tl.data.amount_cents, 40000);
  assert.ok((await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='refund_issued'", [u.id])).rowCount >= 1);
  // resolving cites the refund; the reservation itself is untouched
  must(await api('POST', `/admin/cases/${c.id}/resolve`, { token: admin.token, body: { resolution: 'Refunded in full.', action_ref: `refund:${pay}` } }));
  assert.equal((await pool.query('SELECT status FROM reservations WHERE id=$1', [resv])).rows[0].status, 'confirmed');
  // the timeline cannot be rewritten
  await assert.rejects(pool.query('UPDATE case_events SET reason=$1 WHERE case_id=$2', ['x', c.id]), /append-only/);
  await assert.rejects(pool.query('DELETE FROM case_events WHERE case_id=$1', [c.id]), /append-only/);
});

test('provider payment dispute: payee or payer, tied to the engagement, no clinical detail reaches staff', async () => {
  const coach = await signup(['coach']), hirer = await signup(), third = await signup();
  await api('POST', '/me/sport-profiles', { token: coach.token, body: { sport: 'football', role: 'coach', hourly_rate_cents: 80000 } });
  const hire = must(await api('POST', '/hires', { token: hirer.token, body: { coach_id: coach.id, sport: 'football', starts_at: future(3), duration_min: 60 } }), 201);
  const pay = await mkPayment(hirer.id, 'coach_hire', hire.id, 80000);
  const other = await mkPayment(hirer.id, 'coach_hire', crypto.randomUUID(), 80000);
  const links = [{ type: 'payment', id: pay }, { type: 'coach_hire', id: hire.id }];
  assert.equal((await dispute(coach, 'provider_payment', [{ type: 'payment', id: pay }], { disputed_amount_cents: 80000 })).status, 400); // engagement reference required
  assert.equal((await dispute(third, 'provider_payment', links, { disputed_amount_cents: 80000 })).status, 404);
  assert.equal((await dispute(coach, 'provider_payment', [{ type: 'payment', id: other }, links[1]], { disputed_amount_cents: 80000 })).status, 404); // someone else's payment
  assert.equal((await dispute(hirer, 'provider_payment', [{ type: 'payment', id: other }, links[1]], { disputed_amount_cents: 80000 })).status, 400); // payment is not for that hire
  const c = must(await dispute(coach, 'provider_payment', links, { disputed_amount_cents: 80000 }), 201); // the coach (payee) can raise it
  assert.equal(must(await api('GET', `/cases/${c.id}`, { token: coach.token })).details.currency, 'INR');
  assert.equal((await dispute(hirer, 'provider_payment', links, { disputed_amount_cents: 1000 })).status, 201); // the payer can too
  const hire2 = must(await api('POST', '/hires', { token: hirer.token, body: { coach_id: coach.id, sport: 'football', starts_at: future(6), duration_min: 60 } }), 201);
  assert.equal((await dispute(coach, 'provider_payment', [{ type: 'coach_hire', id: hire2.id }], { disputed_amount_cents: 100 })).status, 400); // nothing was ever paid for it
  const pay2 = await mkPayment(hirer.id, 'coach_hire', hire2.id, 80000);
  const auto = must(await dispute(coach, 'provider_payment', [{ type: 'coach_hire', id: hire2.id }], { disputed_amount_cents: 100 }), 201);
  assert.deepEqual(must(await api('GET', `/cases/${auto.id}`, { token: coach.token })).links.map((l) => l.entity_id).sort(), [hire2.id, pay2].sort()); // payment found for the engagement

  // a physio/doctor appointment can be linked as the engagement; staff never see its clinical text
  const physio = await signup(['physio']);
  await api('POST', '/me/sport-profiles', { token: physio.token, body: { sport: 'football', role: 'physio' } });
  const appt = must(await api('POST', '/appointments', { token: hirer.token, body: { provider_id: physio.id, starts_at: future(5), reason: 'secret knee injury details' } }), 201);
  const c2 = must(await dispute(physio, 'other', [{ type: 'appointment', id: appt.id }], undefined, { description: 'Not yet paid for the session' }), 201);
  const rec = must(await api('GET', `/admin/cases/${c2.id}/records`, { token: admin.token }));
  assert.ok(!JSON.stringify(rec).includes('knee'));
  assert.deepEqual(Object.keys(rec[0].record).sort(), ['created_at', 'duration_min', 'starts_at', 'status']);
  assert.equal((await dispute(third, 'other', [{ type: 'appointment', id: appt.id }])).status, 404);
});

test('game data dispute: captured, routed to officials, corrected through the result capability with before/after kept', async () => {
  const host = await signup(), p1 = await signup(), p2 = await signup(), outsider = await signup();
  const g = must(await api('POST', '/games', { token: host.token, body: { sport: 'tennis', title: 'Final', starts_at: future(1), participants: [{ user_id: p1.id }, { user_id: p2.id }] } }), 201);
  const part = g.participants.find((x) => x.user_id === p1.id);
  must(await api('PATCH', `/games/${g.id}/participants/${part.id}`, { token: host.token, body: { score: 5, outcome: 'loss' } }));
  const links = [{ type: 'game', id: g.id }], d = { contested_field: 'score', claimed_value: 6, participant_id: part.id };
  assert.equal((await dispute(outsider, 'game_data', links, d)).status, 404); // not in the game
  assert.equal((await dispute(p1, 'game_data', links, { ...d, contested_field: 'stats' })).status, 400);
  assert.equal((await dispute(p1, 'game_data', links, { ...d, claimed_value: 'lots' })).status, 400);
  assert.equal((await dispute(p1, 'game_data', links, { contested_field: 'score', claimed_value: 6 })).status, 400); // participant required
  assert.equal((await dispute(p1, 'game_data', links, { ...d, disputed_amount_cents: 5 })).status, 400);
  const c = must(await dispute(p1, 'game_data', links, d), 201);
  assert.equal(c.routed_to, 'game_officials');
  const seen = must(await api('GET', `/cases/${c.id}`, { token: p1.token }));
  assert.equal(seen.details.current_value, 5); // source data untouched on submission
  assert.equal(Number((await pool.query('SELECT score FROM game_participants WHERE id=$1', [part.id])).rows[0].score), 5);

  // routing: the game's organiser sees it, others cannot; the requester cannot decide
  assert.deepEqual(must(await api('GET', '/game-disputes', { token: host.token })).map((x) => x.id), [c.id]);
  assert.deepEqual(must(await api('GET', '/game-disputes', { token: outsider.token })), []);
  assert.equal(must(await api('GET', `/cases/${c.id}`, { token: host.token })).id, c.id);
  assert.equal((await api('GET', `/cases/${c.id}`, { token: outsider.token })).status, 404);
  assert.equal((await api('POST', `/game-disputes/${c.id}/decision`, { token: p1.token, body: { decision: 'accept', reason: 'I say so myself' } })).status, 404);
  assert.equal((await api('POST', `/game-disputes/${c.id}/decision`, { token: outsider.token, body: { decision: 'accept', reason: 'not my game at all' } })).status, 404);

  const out = must(await api('POST', `/game-disputes/${c.id}/decision`, { token: host.token, body: { decision: 'accept', reason: 'Scorer sheet confirms 6 points' } }));
  assert.deepEqual(out.correction, { field: 'score', before: 5, after: 6 });
  assert.equal(Number((await pool.query('SELECT score FROM game_participants WHERE id=$1', [part.id])).rows[0].score), 6);
  const ledger = (await pool.query('SELECT * FROM case_corrections WHERE case_id=$1', [c.id])).rows;
  assert.equal(ledger.length, 1); assert.deepEqual([ledger[0].before, ledger[0].after], [5, 6]);
  await assert.rejects(pool.query('UPDATE case_corrections SET after=$1 WHERE case_id=$2', ['7', c.id]), /append-only/);
  const done = must(await api('GET', `/cases/${c.id}`, { token: p1.token }));
  assert.equal(done.status, 'resolved'); assert.ok(done.history.some((h) => h.action === 'correction_accepted'));
  for (const u of [p1, p2]) assert.ok((await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND title='A result was corrected'", [u.id])).rowCount >= 1, 'participants are told');
  assert.equal((await api('POST', `/game-disputes/${c.id}/decision`, { token: host.token, body: { decision: 'reject', reason: 'already decided once' } })).status, 409);

  // rejection leaves the data alone
  const c2 = must(await dispute(p2, 'game_data', links, { contested_field: 'rank', claimed_value: 1, participant_id: g.participants.find((x) => x.user_id === p2.id).id }), 201);
  must(await api('POST', `/game-disputes/${c2.id}/decision`, { token: admin.token, body: { decision: 'reject', reason: 'Scorer sheet shows rank 2' } }));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM case_corrections WHERE case_id=$1', [c2.id])).rows[0].n, 0);
});

test('fixture score dispute uses record_result and respects its permissions', async () => {
  const org = await signup(['organizer']), cap1 = await signup(), cap2 = await signup(), outsider = await signup();
  const t1 = must(await api('POST', '/teams', { token: cap1.token, body: { name: 'Reds', sport: 'football' } }), 201);
  const t2 = must(await api('POST', '/teams', { token: cap2.token, body: { name: 'Blues', sport: 'football' } }), 201);
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: 'Cup', sport: 'football' } }), 201);
  for (const [cp, t] of [[cap1, t1], [cap2, t2]]) {
    const e = must(await api('POST', `/events/${ev.id}/entries`, { token: cp.token, body: { team_id: t.id } }), 201);
    must(await api('PATCH', `/entries/${e.id}`, { token: org.token, body: { status: 'accepted' } }));
  }
  const fx = must(await api('POST', `/events/${ev.id}/fixtures`, { token: org.token, body: { home_team_id: t1.id, away_team_id: t2.id, scheduled_at: future(1) } }), 201);
  const links = [{ type: 'fixture', id: fx.id }], d = { contested_field: 'home_score', claimed_value: 3 };
  must(await api('POST', `/fixtures/${fx.id}/result`, { token: org.token, body: { home_score: 2, away_score: 1 } }));
  assert.equal((await dispute(outsider, 'game_data', links, d)).status, 404); // not in either team
  assert.equal((await dispute(cap1, 'game_data', links, { ...d, contested_field: 'status' })).status, 400);
  const c = must(await dispute(cap1, 'game_data', links, d), 201);
  assert.equal(must(await api('GET', `/cases/${c.id}`, { token: cap1.token })).details.current_value, 2);
  assert.deepEqual(must(await api('GET', '/game-disputes', { token: org.token })).map((x) => x.id), [c.id]);
  assert.equal((await api('POST', `/game-disputes/${c.id}/decision`, { token: cap2.token, body: { decision: 'accept', reason: 'I am the other captain' } })).status, 404);
  const out = must(await api('POST', `/game-disputes/${c.id}/decision`, { token: org.token, body: { decision: 'accept', reason: 'Match sheet shows 3-1' } }));
  assert.deepEqual(out.correction, { field: 'home_score', before: 2, after: 3 });
  const row = (await pool.query('SELECT home_score, away_score FROM fixtures WHERE id=$1', [fx.id])).rows[0];
  assert.deepEqual([row.home_score, row.away_score], [3, 1]);
  for (const u of [cap1, cap2]) assert.ok((await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND title='A result was corrected'", [u.id])).rowCount >= 1);
});
