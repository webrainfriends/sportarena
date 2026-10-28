// Cover: someone else pays a person's bills under an agreement both sides approved. One time / a period / unlimited, caps, org payers, youth,
// revocation, privacy. Every test creates its own people; the card provider is a local stand-in.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

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
Object.assign(process.env, { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_API_BASE: `http://127.0.0.1:${provider.address().port}`, APP_URL: 'http://app.test', CORS_ORIGINS: 'http://app.test' });
const { pool, start, stop, call, ok, signup, orgWith } = await import('./tender-helpers.js');
const { fromLocal, addDays } = await import('../src/booking/time.js');
const { tx } = await import('../src/db.js');
const { expireCover } = await import('../src/cover.js');

before(start);
after(async () => { provider.close(); await stop(); });

const today = new Date().toISOString().slice(0, 10);
const at = (d, h) => fromLocal(addDays(today, d), h * 60, 'UTC').toISOString();
let seq = 0;
async function venue(mgr, rate = 40000) {
  const v = ok(await call('POST', '/venues', { token: mgr.token, body: { name: `Cover Arena ${++seq}`, timezone: 'UTC', currency: 'INR', payment_mode: 'online_optional' } }), 201);
  const court = ok(await call('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'Court 1', hourly_rate_cents: rate } }), 201);
  return { v, court };
}
const book = async (u, court, d, h) => (await call('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: court.id, starts_at: at(d, h), ends_at: at(d, h + 1) }] } })).body;
const bill = (b) => ({ purpose_type: 'venue_invoice', purpose_id: b.invoices[0].id });
const pay = async (u, b) => {                                  // hosted checkout by `u`, settled by the provider stand-in
  const r = await call('POST', '/payments', { token: u.token, body: { ...bill(b), provider: 'stripe', return_url: 'http://app.test/' } });
  if (r.status !== 201) return r;
  Object.values(fake.sessions).at(-1).payment_status = 'paid';
  return { ...r, confirm: ok(await call('POST', `/payments/${r.body.id}/confirm`, { token: u.token, body: {} })) };
};
const terms = (o = {}) => ({ purposes: ['venue_invoice'], term: 'unlimited', ...o });
const invoice = (b) => pool.query('SELECT status FROM invoices WHERE id=$1', [b.invoices[0].id]).then((r) => r.rows[0].status);
const mandate = (id) => pool.query('SELECT * FROM cover_mandates WHERE id=$1', [id]).then((r) => r.rows[0]);
const accept = (u, m) => call('POST', `/cover/${m.id}/decision`, { token: u.token, body: { decision: 'accept' } });

test('one bill, one time: the payer pays it, the agreement closes, nobody else can pay', async () => {
  const mgr = await signup('mgr', ['venue_manager']);
  const { court } = await venue(mgr);
  const athlete = await signup('athlete'), sponsor = await signup('sponsor', ['sponsor']), stranger = await signup('stranger');
  const b1 = await book(athlete, court, 3, 9), b2 = await book(athlete, court, 4, 9);
  assert.equal((await pay(sponsor, b1)).status, 403, 'not yours to pay without an agreement');

  const req = ok(await call('POST', '/cover/requests', { token: athlete.token, body: { payer_user_id: sponsor.id, ...terms({ term: 'one_time' }), bill: bill(b1), note: 'Match fee' } }), 201);
  assert.equal(req.status, 'requested');
  assert.equal((await pay(sponsor, b1)).status, 403, 'a request is not an agreement until it is approved');
  assert.equal((await accept(athlete, req)).status, 403, 'you cannot approve your own request');
  assert.equal((await accept(stranger, req)).status, 404, 'outsiders do not even see it');
  const act = ok(await accept(sponsor, req));
  assert.equal(act.status, 'active');
  assert.ok(ok(await call('GET', '/cover/inbox', { token: sponsor.token })).some((x) => x.purpose_id === b1.invoices[0].id && x.payable));

  assert.equal((await pay(stranger, b1)).status, 403, 'only the named payer');
  assert.equal((await pay(sponsor, b2)).status, 403, 'only that one bill');
  const paid = await pay(sponsor, b1);
  assert.equal(paid.confirm.status, 'paid');
  assert.equal(await invoice(b1), 'paid', 'the athlete\'s invoice is paid');
  const p = (await pool.query('SELECT payer_id, cover_mandate_id FROM payments WHERE id=$1', [paid.body.id])).rows[0];
  assert.deepEqual([p.payer_id, p.cover_mandate_id], [sponsor.id, req.id], 'the payment records who paid and under what');
  assert.equal((await mandate(req.id)).status, 'used_up', 'one time: closed after the payment settled');
  const notes = await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='cover_paid'", [athlete.id]);
  assert.equal(notes.rowCount, 1, 'the athlete is told');
  assert.equal((await pay(sponsor, b1)).status, 403, 'the agreement is used up');
});

test('unlimited and capped: auto-send, per-bill cap, total cap, and a period that ends', async () => {
  const mgr = await signup('mgr', ['venue_manager']);
  const { court } = await venue(mgr, 40000);
  const athlete = await signup('athlete'), family = await signup('family');
  const offer = ok(await call('POST', '/cover/offers', { token: family.token, body: { beneficiary_id: athlete.id, ...terms({ auto_send: true, currency: 'INR', max_per_bill_minor: 50000, max_total_minor: 100000 }) } }), 201);
  assert.equal((await accept(family, offer)).status, 403, 'the offerer cannot accept their own offer');
  ok(await accept(athlete, offer));
  const bills = [await book(athlete, court, 3, 9), await book(athlete, court, 4, 9), await book(athlete, court, 5, 9)];
  const inbox = ok(await call('GET', '/cover/inbox', { token: family.token }));
  assert.equal(inbox.filter((x) => x.payable).length, 3, 'auto-send: every open bill in scope reaches the payer');
  assert.equal((await pay(family, bills[0])).confirm.status, 'paid'); assert.equal((await pay(family, bills[1])).confirm.status, 'paid');
  const after2 = ok(await call('GET', '/cover/inbox', { token: family.token }));
  assert.deepEqual([after2[0].payable, after2[0].blocked_by], [false, 'over_total_cap'], '80 of 100 used: a third 40 does not fit');
  assert.equal((await pay(family, bills[2])).status, 403);
  assert.equal(await invoice(bills[2]), 'open');
  assert.equal((await call('GET', `/cover/${offer.id}`, { token: athlete.token })).body.used_minor, 80000);

  // a per-bill cap smaller than the bill blocks it
  const pricey = await venue(mgr, 90000);
  const o2 = ok(await call('POST', '/cover/offers', { token: family.token, body: { beneficiary_id: athlete.id, ...terms({ auto_send: true, currency: 'INR', max_per_bill_minor: 50000 }) } }), 201);
  ok(await accept(athlete, o2));
  const big = await book(athlete, pricey.court, 6, 9);
  assert.equal((await pay(family, big)).status, 403);

  // a period: valid until a date; once past, nothing is covered and the sweep marks it expired
  const mgr2 = await signup('mgr2', ['venue_manager']);
  const w = await venue(mgr2, 30000);
  const friend = await signup('friend');
  const dur = ok(await call('POST', '/cover/offers', { token: friend.token, body: { beneficiary_id: athlete.id, ...terms({ term: 'duration', valid_until: new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10), auto_send: true }) } }), 201);
  ok(await accept(athlete, dur));
  const wb = await book(athlete, w.court, 3, 9);
  assert.equal((await pay(friend, wb)).confirm.status, 'paid');
  await pool.query("UPDATE cover_mandates SET valid_until = current_date - 1 WHERE id=$1", [dur.id]);
  const wb2 = await book(athlete, w.court, 4, 9);
  assert.equal((await pay(friend, wb2)).status, 403, 'past its end date');
  assert.equal(await tx((c) => expireCover(c)), 1);
  assert.equal((await mandate(dur.id)).status, 'expired');
  assert.equal((await call('POST', '/cover/offers', { token: friend.token, body: { beneficiary_id: athlete.id, ...terms({ term: 'duration' }) } })).status, 400, 'a period needs an end date');
});

test('only what was sent: without auto-send the payer sees and pays only bills the person sends; kind and revocation are enforced', async () => {
  const mgr = await signup('mgr', ['venue_manager']);
  const { court } = await venue(mgr);
  const athlete = await signup('athlete'), club = await signup('club');
  const req = ok(await call('POST', '/cover/requests', { token: athlete.token, body: { payer_user_id: club.id, ...terms({ purposes: ['venue_invoice', 'coach_hire'] }) } }), 201);
  ok(await accept(club, req));
  const b1 = await book(athlete, court, 3, 9), b2 = await book(athlete, court, 4, 9);
  assert.equal(ok(await call('GET', '/cover/inbox', { token: club.token })).length, 0, 'nothing is sent yet');
  assert.equal((await pay(club, b1)).status, 403, 'a bill that was never sent cannot be pulled by the payer');
  const opts = ok(await call('GET', `/cover/options?purpose_type=venue_invoice&purpose_id=${b1.invoices[0].id}`, { token: athlete.token }));
  assert.equal(opts.options[0].payer_name, club.display_name);
  const sent = ok(await call('POST', `/cover/${req.id}/bills`, { token: athlete.token, body: bill(b1) }), 201);
  assert.equal(sent.label, 'Venue booking');
  assert.equal(ok(await call('POST', `/cover/${req.id}/bills`, { token: athlete.token, body: bill(b1) }), 201).already, true);
  assert.equal((await call('POST', `/cover/${req.id}/bills`, { token: club.token, body: bill(b1) })).status, 404, 'only the person covered sends bills');
  assert.equal(ok(await call('GET', '/cover/inbox', { token: club.token })).length, 1);
  assert.equal((await pay(club, b2)).status, 403);
  assert.equal((await pay(club, b1)).confirm.status, 'paid');

  // a kind the agreement does not name cannot be sent
  const narrow = ok(await call('POST', '/cover/requests', { token: athlete.token, body: { payer_user_id: club.id, ...terms({ purposes: ['coach_hire'] }) } }), 201);
  ok(await accept(club, narrow));
  assert.equal((await call('POST', `/cover/${narrow.id}/bills`, { token: athlete.token, body: bill(b2) })).status, 409);

  // either side can end it, and the very next use is refused
  ok(await call('POST', `/cover/${req.id}/bills`, { token: athlete.token, body: bill(b2) }), 201);
  assert.equal(ok(await call('GET', '/cover/inbox', { token: club.token })).length, 1);
  ok(await call('POST', `/cover/${req.id}/end`, { token: athlete.token, body: { reason: 'sorted it myself' } }));
  assert.equal((await pay(club, b2)).status, 403, 'revoked: refused straight away');
  assert.equal(ok(await call('GET', '/cover/inbox', { token: club.token })).filter((x) => x.mandate_id === req.id).length, 0);
  assert.equal((await call('POST', `/cover/${req.id}/end`, { token: club.token, body: {} })).status, 409, 'already ended');
  const trail = ok(await call('GET', `/cover/${req.id}`, { token: club.token })).events.map((e) => e.action);
  assert.deepEqual(trail.filter((a) => ['requested', 'accepted', 'bill_sent', 'paid', 'ended'].includes(a)).slice(0, 2), ['requested', 'accepted']);
  assert.ok(trail.includes('paid') && trail.includes('ended'));
});

test('requests: decline, withdraw, yourself, and who may answer', async () => {
  const a = await signup('a'), b = await signup('b'), c = await signup('c');
  assert.equal((await call('POST', '/cover/requests', { token: a.token, body: { payer_user_id: a.id, ...terms() } })).status, 400);
  assert.equal((await call('POST', '/cover/requests', { token: a.token, body: { payer_user_id: b.id, payer_org_id: '00000000-0000-4000-8000-000000000000', ...terms() } })).status, 400, 'one payer only');
  const r1 = ok(await call('POST', '/cover/requests', { token: a.token, body: { payer_user_id: b.id, ...terms() } }), 201);
  assert.equal(ok(await call('POST', `/cover/${r1.id}/decision`, { token: b.token, body: { decision: 'decline', reason: 'not this season' } })).status, 'declined');
  assert.equal((await accept(b, r1)).status, 409, 'already answered');
  const r2 = ok(await call('POST', '/cover/requests', { token: a.token, body: { payer_user_id: b.id, ...terms() } }), 201);
  assert.equal(ok(await call('POST', `/cover/${r2.id}/end`, { token: a.token, body: {} })).status, 'cancelled', 'withdrawing your own request');
  const r3 = ok(await call('POST', '/cover/requests', { token: a.token, body: { payer_user_id: b.id, ...terms() } }), 201);
  assert.equal((await accept(c, r3)).status, 404);
  assert.equal((await call('POST', `/cover/${r3.id}/end`, { token: c.token, body: {} })).status, 404);
  const mine = ok(await call('GET', '/cover?view=i_pay', { token: b.token }));
  assert.ok(mine.some((x) => x.id === r3.id && x.can_answer));
  assert.ok(ok(await call('GET', '/cover?view=for_me', { token: a.token })).some((x) => x.id === r3.id && !x.can_answer));
  assert.equal(ok(await call('GET', '/cover?view=for_me', { token: c.token })).length, 0);
});

test('organisations: owners and admins approve, finance staff pay, outsiders cannot', async () => {
  const mgr = await signup('mgr', ['venue_manager']);
  const { court } = await venue(mgr);
  const athlete = await signup('athlete'), owner = await signup('owner', ['sponsor']), finance = await signup('finance'), outsider = await signup('outsider');
  const org = await orgWith(owner, [{ user: finance, role: 'finance' }]);
  const req = ok(await call('POST', '/cover/requests', { token: athlete.token, body: { payer_org_id: org.id, ...terms({ auto_send: true }) } }), 201);
  assert.equal((await accept(finance, req)).status, 403, 'finance staff pay but do not approve');
  assert.equal((await accept(outsider, req)).status, 404);
  ok(await accept(owner, req));
  const b = await book(athlete, court, 3, 9);
  assert.equal((await pay(outsider, b)).status, 403);
  assert.equal(ok(await call('GET', '/cover/inbox', { token: finance.token })).length, 1, 'org staff see the org\'s inbox');
  const paid = await pay(finance, b);
  assert.equal(paid.confirm.status, 'paid');
  assert.equal(ok(await call('GET', `/cover/${req.id}`, { token: athlete.token })).payer_name, org.name);
  assert.equal(ok(await call('GET', '/cover?view=i_pay', { token: finance.token })).length, 1);
  assert.equal((await call('POST', `/cover/${req.id}/end`, { token: finance.token, body: {} })).status, 403, 'finance cannot end it');
  // an organisation can offer, but only its owners/admins
  assert.equal((await call('POST', '/cover/offers', { token: finance.token, body: { beneficiary_id: athlete.id, as_org_id: org.id, ...terms() } })).status, 403);
  ok(await call('POST', '/cover/offers', { token: owner.token, body: { beneficiary_id: athlete.id, as_org_id: org.id, ...terms() } }), 201);
});

test('young people: a guardian asks and answers for them; the young person cannot act alone; they are never searchable', async () => {
  const guardian = await signup('guardian'), kid = await signup('kid'), sponsor = await signup('sponsor', ['sponsor']);
  await pool.query('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);
  await pool.query("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by, decided_at) VALUES ($1,$2,'parent','active',$1, now())", [guardian.id, kid.id]);
  assert.equal((await call('POST', '/cover/requests', { token: kid.token, body: { payer_user_id: sponsor.id, ...terms() } })).status, 403, 'a young person with a guardian cannot ask alone');
  const stranger = await signup('stranger');
  assert.equal((await call('POST', '/cover/requests', { token: stranger.token, body: { beneficiary_id: kid.id, payer_user_id: sponsor.id, ...terms() } })).status, 403);
  const req = ok(await call('POST', '/cover/requests', { token: guardian.token, body: { beneficiary_id: kid.id, payer_user_id: sponsor.id, ...terms() } }), 201);
  ok(await accept(sponsor, req));
  assert.ok(ok(await call('GET', '/cover?view=for_me', { token: guardian.token })).some((x) => x.id === req.id), 'the guardian sees the child\'s agreements');
  const offer = ok(await call('POST', '/cover/offers', { token: sponsor.token, body: { beneficiary_id: kid.id, ...terms({ purposes: ['coach_hire'] }) } }), 201);
  assert.equal((await accept(kid, offer)).status, 403, 'only the guardian answers an offer to a young person');
  ok(await accept(guardian, offer));
  const found = ok(await call('GET', `/cover/payers?q=${kid.handle.slice(0, 6)}`, { token: sponsor.token }));
  assert.equal(found.people.some((p) => p.id === kid.id), false, 'young people are never listed');
});

test('privacy and surface: generic labels only, REST/OpenAPI/MCP parity, outsiders get 404', async () => {
  const athlete = await signup('athlete'), coach = await signup('coach', ['coach']), payer = await signup('payer'), outsider = await signup('outsider');
  const hire = (await pool.query("INSERT INTO coach_hires(hirer_id, coach_id, starts_at, duration_min, rate_cents_hour, total_cents, status, payment_status) VALUES ($1,$2, now() + interval '2 days', 60, 50000, 50000, 'confirmed', 'unpaid') RETURNING id", [athlete.id, coach.id])).rows[0];
  const m = ok(await call('POST', '/cover/offers', { token: payer.token, body: { beneficiary_id: athlete.id, ...terms({ purposes: ['coach_hire'], auto_send: true }) } }), 201);
  ok(await accept(athlete, m));
  const inbox = ok(await call('GET', '/cover/inbox', { token: payer.token }));
  assert.equal(inbox[0].label, 'Coaching session');
  assert.doesNotMatch(JSON.stringify(inbox), new RegExp(coach.display_name), 'the payer never learns who the coach is');
  assert.equal(inbox[0].purpose_id, hire.id);
  assert.equal((await call('GET', `/cover/${m.id}`, { token: outsider.token })).status, 404);
  const { capabilities } = await import('../src/capabilities/index.js');
  const names = capabilities.filter((c) => c.tag === 'Cover').map((c) => c.name);
  for (const n of ['request_cover', 'offer_cover', 'decide_cover', 'end_cover', 'list_cover', 'get_cover', 'cover_inbox', 'cover_options', 'send_bill_to_payer', 'search_cover_payers']) assert.ok(names.includes(n), n);
  const { buildOpenApi } = await import('../src/openapi.js');
  assert.ok(Object.values(buildOpenApi().paths).flatMap((p) => Object.values(p)).some((o) => o.operationId === 'decide_cover'));
  // a read-only token cannot approve anything
  const ro = ok(await call('POST', '/me/tokens', { token: athlete.token, body: { name: 'ro', scopes: ['read'] } }), 201);
  assert.equal((await call('POST', `/cover/${m.id}/end`, { token: ro.token, body: {} })).status, 403);
  assert.equal((await call('GET', '/cover', { token: ro.token })).status, 200);
});
