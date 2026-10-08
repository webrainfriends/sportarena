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
  if (req.url === '/v1/refunds') { const f = new URLSearchParams(raw); fake.refunds.push({ intent: f.get('payment_intent'), amount: Number(f.get('amount')) }); return setTimeout(() => send(200, { id: 're_1' }), fake.refundDelay ?? 0); }
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
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `wa_${n}_${roles[0]}`, display_name: `Wallet ${n}`, email: `wa${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const today = new Date().toISOString().slice(0, 10);
const at = (d, h) => fromLocal(addDays(today, d), h * 60, 'UTC').toISOString();
const wait = async (fn, ms = 4000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 40)); } };
const wallet = async (u, cur = 'INR') => Number(must(await api('GET', '/me/wallet', { token: u.token })).balances.find((b) => b.currency === cur)?.balance_cents ?? 0);
const adjust = (u, amount, cur = 'INR') => api('POST', '/admin/wallet/adjust', { token: admin.token, body: { user_id: u.id, currency: cur, amount_cents: amount, note: 'test credit' } });
const ledgerOk = async () => (await pool.query(`SELECT count(*)::int AS bad FROM wallet_accounts a WHERE a.balance_cents <> coalesce((SELECT sum(amount_cents) FROM wallet_ledger l WHERE l.user_id=a.user_id AND l.currency=a.currency),0)`)).rows[0].bad === 0;

async function checkout(u, type, id) {
  const p = must(await api('POST', '/payments', { token: u.token, body: { purpose_type: type, purpose_id: id, provider: 'stripe', return_url: 'http://app.test/' } }), 201);
  Object.values(fake.sessions).at(-1).payment_status = 'paid';
  return { p, done: must(await api('POST', `/payments/${p.id}/confirm`, { token: u.token, body: {} })) };
}
async function venue(mgr, over = {}) {
  const v = must(await api('POST', '/venues', { token: mgr.token, body: { name: `Wallet Arena ${Math.random().toString(36).slice(2, 6)}`, timezone: 'UTC', currency: 'INR', payment_mode: 'online_optional', ...over } }), 201);
  const court = must(await api('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'Court 1', hourly_rate_cents: 100000 } }), 201);
  return { v, court };
}
const book = (u, court, d, h, len = 1) => api('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: court.id, starts_at: at(d, h), ends_at: at(d, h + len) }] } });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('wa_root','Root','{admin}','x','x','wa_adminidx') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
});
after(async () => { server.close(); provider.close(); await pool.end(); });

test('wallet: top-up through checkout, per-currency balances, ledger, limits, admin adjustments', async () => {
  const u = await signup();
  assert.deepEqual(must(await api('GET', '/me/wallet', { token: u.token })).balances, []);
  assert.equal((await api('POST', '/me/wallet/topups', { token: u.token, body: { currency: 'INR', amount_cents: 50 } })).status, 400, 'below 1 rupee');
  assert.equal((await api('POST', '/me/wallet/topups', { token: u.token, body: { currency: 'INR', amount_cents: 2_000_000_000 } })).status, 400, 'above the cap');
  assert.equal((await api('POST', '/me/wallet/topups', { token: u.token, body: { currency: 'XXX', amount_cents: 1000 } })).status, 400);
  const t = must(await api('POST', '/me/wallet/topups', { token: u.token, body: { currency: 'INR', amount_cents: 150000 } }), 201);
  assert.equal(await wallet(u), 0, 'nothing until it is paid');
  assert.equal((await api('POST', '/payments', { token: (await signup()).token, body: { purpose_type: 'wallet_topup', purpose_id: t.id, provider: 'stripe', return_url: 'http://app.test/' } })).status, 403, "someone else's top-up");
  const { done } = await checkout(u, 'wallet_topup', t.id);
  assert.equal(done.status, 'paid');
  assert.equal(await wallet(u), 150000);
  // whole-yen currency in its own wallet
  const y = must(await api('POST', '/me/wallet/topups', { token: u.token, body: { currency: 'JPY', amount_cents: 3000 } }), 201);
  await checkout(u, 'wallet_topup', y.id);
  assert.equal(Object.values(fake.sessions).at(-1).amount_total, 3000);
  assert.equal(await wallet(u, 'JPY'), 3000);
  assert.equal(await wallet(u, 'INR'), 150000);
  // confirming again never credits twice
  assert.equal(await api('POST', `/payments/${done.id}/confirm`, { token: u.token, body: {} }).then((r) => r.body.status), 'paid');
  assert.equal(await wallet(u), 150000);
  const led = must(await api('GET', '/me/wallet/ledger', { token: u.token, query: { currency: 'INR' } }));
  assert.equal(led.length, 1);
  assert.deepEqual([led[0].amount_cents, led[0].balance_after, led[0].kind], [150000, 150000, 'topup']);
  assert.ok(must(await api('GET', '/notifications', { token: u.token })).items.some((x) => x.kind === 'wallet_credit'));

  // support adjustments: admin only, never below zero, audited
  assert.equal((await api('POST', '/admin/wallet/adjust', { token: u.token, body: { user_id: u.id, currency: 'INR', amount_cents: 100, note: 'nope' } })).status, 403);
  assert.equal((await adjust(u, -999999999)).status, 409);
  must(await adjust(u, -50000));
  assert.equal(await wallet(u), 100000);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='adjust_wallet'")).rowCount >= 1);
  assert.ok(await ledgerOk());
});

test('gift cards: buy, pay, share the code, redeem once, wrong-code lockout, expiry', async () => {
  const buyer = await signup(), friend = await signup();
  const g = must(await api('POST', '/gift-cards', { token: buyer.token, body: { currency: 'INR', amount_cents: 200000, message: 'Happy birthday!' } }), 201);
  assert.equal(g.status, 'awaiting_payment');
  assert.equal(must(await api('GET', `/gift-cards/${g.id}`, { token: buyer.token })).code, undefined, 'no code before it is paid');
  await checkout(buyer, 'gift_card', g.id);
  const card = must(await api('GET', `/gift-cards/${g.id}`, { token: buyer.token }));
  assert.equal(card.status, 'active');
  assert.match(card.code, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  assert.equal(card.code_hint, card.code.slice(-4));
  assert.ok(!JSON.stringify(must(await api('GET', '/me/gift-cards', { token: buyer.token }))).includes(card.code), 'the list never shows codes');
  assert.equal((await api('GET', `/gift-cards/${g.id}`, { token: friend.token })).status, 404, 'only the buyer sees the code');
  const row = JSON.stringify((await pool.query('SELECT * FROM gift_cards WHERE id=$1', [g.id])).rows);
  assert.ok(!row.includes(card.code) && !row.includes(card.code.replace(/-/g, '')), 'the code is not stored in plaintext');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE entity='gift_cards' AND action='read_pii'")).rowCount >= 1);

  // redeem: any spelling of the code, once
  const r = must(await api('POST', '/gift-cards/redeem', { token: friend.token, body: { code: card.code.toLowerCase().replace(/-/g, ' ') } }));
  assert.deepEqual([r.currency, r.amount_cents, r.wallet_balance_cents], ['INR', 200000, 200000]);
  assert.equal(await wallet(friend), 200000);
  assert.equal((await api('POST', '/gift-cards/redeem', { token: buyer.token, body: { code: card.code } })).status, 409, 'already used');
  assert.ok(must(await api('GET', '/notifications', { token: buyer.token })).items.some((x) => x.kind === 'gift_card_redeemed'));
  assert.equal(must(await api('GET', '/me/gift-cards', { token: buyer.token }))[0].status, 'redeemed');

  // guessing: ten wrong codes lock the person out for the hour (even a right code)
  const g2 = must(await api('POST', '/gift-cards', { token: buyer.token, body: { currency: 'INR', amount_cents: 10000 } }), 201);
  await checkout(buyer, 'gift_card', g2.id);
  const code2 = must(await api('GET', `/gift-cards/${g2.id}`, { token: buyer.token })).code;
  const guesser = await signup();
  for (let i = 0; i < 10; i++) assert.equal((await api('POST', '/gift-cards/redeem', { token: guesser.token, body: { code: `ABCD-EFGH-JK${String(i).padStart(2, '2')}` } })).status, 404);
  assert.equal((await api('POST', '/gift-cards/redeem', { token: guesser.token, body: { code: code2 } })).status, 429);
  assert.equal(await wallet(guesser), 0);
  // an expired card can't be redeemed
  await pool.query("UPDATE gift_cards SET expires_at = now() - interval '1 day' WHERE id=$1", [g2.id]);
  assert.equal((await api('POST', '/gift-cards/redeem', { token: friend.token, body: { code: code2 } })).status, 409);
  assert.ok(await ledgerOk());
});

test('paying invoices from the wallet: partial + card for the rest, full cover, guards', async () => {
  const mgr = await signup(['venue_manager']);
  const { court } = await venue(mgr);
  const u = await signup(), other = await signup();
  const b1 = must(await book(u, court, 3, 10), 201);
  const inv = b1.invoices[0];
  assert.equal((await api('POST', `/invoices/${inv.id}/wallet`, { token: u.token, body: {} })).status, 409, 'empty wallet');
  assert.equal((await api('POST', `/invoices/${inv.id}/wallet`, { token: other.token, body: {} })).status, 403);
  must(await adjust(u, 40000));
  const part = must(await api('POST', `/invoices/${inv.id}/wallet`, { token: u.token, body: {} }));
  assert.deepEqual([part.applied_cents, part.due_cents, part.paid, part.wallet_balance_cents], [40000, 60000, false, 0]);
  const doc = must(await api('GET', `/invoices/${inv.id}`, { token: u.token }));
  assert.equal(doc.amount_due_cents, 60000);
  assert.equal(doc.credits_cents, 40000);

  // the card is asked for only what is still due
  const { p, done } = await checkout(u, 'venue_invoice', inv.id);
  assert.equal(p.amount_cents, 60000);
  assert.equal(done.status, 'paid');
  assert.equal(must(await api('GET', `/invoices/${inv.id}`, { token: u.token })).status, 'paid');

  // cancelling an early booking: 400 goes straight back to the wallet, 600 back to the card
  fake.refundDelay = 400; // keep the first refund in flight so a racing caller would double-process it
  must(await api('DELETE', `/bookings/${b1.bookings[0].id}`, { token: u.token }));
  assert.equal(await wallet(u), 40000, 'wallet-funded part refunded instantly');
  await wait(async () => fake.refunds.length >= 1);
  assert.equal(fake.refunds.at(-1).amount, 60000, 'only the card-funded part goes back to the card');
  assert.equal((await pool.query("SELECT refund_status, refund_to_credits_cents FROM invoices WHERE kind='credit_note' AND reservation_id=$1", [b1.id])).rows[0].refund_to_credits_cents, 40000);
  // the post-cancellation kick may still be running: the explicit call must not double-process, and the refund ends 'done'
  await Promise.all([processRefunds(), processRefunds()]);
  await wait(async () => (await pool.query("SELECT refund_status FROM invoices WHERE kind='credit_note' AND reservation_id=$1", [b1.id])).rows[0].refund_status === 'done');
  assert.equal(fake.refunds.length, 1, 'the card was refunded exactly once, however many callers raced');
  fake.refundDelay = 0;

  // full cover: the invoice is simply paid, in the wallet
  must(await adjust(u, 100000));
  const b2 = must(await book(u, court, 4, 10), 201);
  const full = must(await api('POST', `/invoices/${b2.invoices[0].id}/wallet`, { token: u.token, body: {} }));
  assert.deepEqual([full.paid, full.due_cents], [true, 0]);
  assert.equal(must(await api('GET', `/invoices/${b2.invoices[0].id}`, { token: u.token })).payment_method, 'wallet');
  assert.equal((await api('POST', `/invoices/${b2.invoices[0].id}/wallet`, { token: u.token, body: {} })).status, 409, 'already paid');
  assert.equal(await wallet(u), 40000);

  // while a card checkout for an invoice is open, wallet changes are refused (no double payment)
  must(await adjust(u, 10000));
  const b3 = must(await book(u, court, 5, 10), 201);
  must(await api('POST', '/payments', { token: u.token, body: { purpose_type: 'venue_invoice', purpose_id: b3.invoices[0].id, provider: 'stripe', return_url: 'http://app.test/' } }), 201);
  assert.equal((await api('POST', `/invoices/${b3.invoices[0].id}/wallet`, { token: u.token, body: {} })).status, 409);
  assert.ok(await ledgerOk());
});

test('credit on an open invoice comes back when the invoice is cancelled or shrinks; never overspent', async () => {
  const mgr = await signup(['venue_manager']);
  const { court } = await venue(mgr, { payment_mode: 'pay_at_venue' });
  const u = await signup();
  must(await adjust(u, 150000));
  // cancelled before paying: everything returns
  const a = must(await book(u, court, 6, 10, 1), 201);
  must(await api('POST', `/invoices/${a.invoices[0].id}/wallet`, { token: u.token, body: { amount_cents: 30000 } }));
  assert.equal(await wallet(u), 120000);
  must(await api('DELETE', `/bookings/${a.bookings[0].id}`, { token: u.token }));
  assert.equal(await wallet(u), 150000);
  assert.equal(must(await api('GET', `/invoices/${a.invoices[0].id}`, { token: u.token })).status, 'void');

  // a 2-hour booking with 150000 of credit on it, shortened to 1 hour: the extra comes back, and it is now paid in full
  const b = must(await book(u, court, 7, 10, 2), 201);
  must(await api('POST', `/invoices/${b.invoices[0].id}/wallet`, { token: u.token, body: { amount_cents: 150000 } }));
  assert.equal(await wallet(u), 0);
  must(await api('PATCH', `/bookings/${b.bookings[0].id}`, { token: u.token, body: { ends_at: at(7, 11) } }));
  assert.equal(await wallet(u), 50000, 'the excess over the new price came back');
  const after = must(await api('GET', `/invoices/${b.invoices[0].id}`, { token: u.token }));
  assert.equal(after.status, 'paid', 'what was already applied now covers the whole invoice');
  assert.equal(after.total_cents, 100000);

  // two invoices racing for the same money: the wallet never goes negative
  must(await adjust(u, 50000)); // balance 100000
  const [c1, c2] = [must(await book(u, court, 8, 10), 201), must(await book(u, court, 9, 10), 201)];
  const [r1, r2] = await Promise.all([c1, c2].map((x) => api('POST', `/invoices/${x.invoices[0].id}/wallet`, { token: u.token, body: {} })));
  assert.equal(await wallet(u), 0);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409], 'one invoice gets the money, the other finds the wallet empty');
  assert.equal([r1, r2].find((r) => r.status === 200).body.applied_cents, 100000, 'and it got exactly what was there');
  assert.ok(await ledgerOk());
});
