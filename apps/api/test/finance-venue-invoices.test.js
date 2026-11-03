import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Venue booking invoices on the canonical ledger: obligations (receivables), receipts for money taken at the venue, credit-note refunds, revised invoices and pro-rated tax.
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp', PLATFORM_ADMIN_EMAILS: 'rraja.edge@gmail.com,rrajas1978@icloud.com', PAYMENT_CURRENCY: 'INR',
});
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { blindIndex } = await import('../src/crypto.js');
const fin = await import('../src/finance.js');

let server, base, n = 0, boss, owner;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `fvi_${n}_${roles[0]}`, display_name: `Inv ${n}`, email: `fvi${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const dayOf = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const reconcile = async () => must(await api('POST', '/admin/finance/reconcile', { token: boss.token, body: {} }), 200);
const head = (s, cur = 'INR') => s.currencies.find((c) => c.currency === cur) ?? { gross: 0, receivable: 0, payable: 0, spend: 0, by_category: [] };
const row = async (key) => (await pool.query("SELECT *, to_char(due_on,'YYYY-MM-DD') AS due FROM fin_transactions WHERE idem_key=$1", [key])).rows[0];
const rowsOf = async (invoiceId, kind) => (await pool.query('SELECT * FROM fin_transactions WHERE source_type=$1 AND source_id=$2 AND kind=$3 ORDER BY idem_key', ['venue_invoice', invoiceId, kind])).rows;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  boss = await signup();
  await pool.query("UPDATE users SET roles='{athlete,admin,platform_admin}', email_idx=$2 WHERE id=$1", [boss.id, blindIndex('rraja.edge@gmail.com')]);
  owner = await signup();
});
after(async () => { server.close(); await pool.end(); });

/** a fresh organisation with one venue, so every test reads its own books */
const world = async () => {
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Venue Org ${++n}`, kind: 'academy' } }), 201);
  const venue = (await pool.query('INSERT INTO venues(name, owner_id, organisation_id) VALUES ($1,$2,$3) RETURNING id', [`Court ${++n}`, owner.id, org.id])).rows[0];
  const q = (extra = {}) => ({ organisation_id: org.id, ...extra });
  return {
    org, venue,
    sum: async () => must(await api('GET', '/finance/summary', { token: owner.token, query: q() })),
    age: async () => must(await api('GET', '/finance/ageing', { token: owner.token, query: q() })).currencies.find((c) => c.currency === 'INR'),
    obligations: async () => must(await api('GET', '/finance/obligations', { token: owner.token, query: q({ direction: 'in' }) })),
  };
};

let invSeq = 0;
/** a booking invoice (or credit note) row for a venue; walk-in guests are billed to the cashier, as the app does */
const invoice = async (w, o = {}) => {
  const user = o.user ?? (await signup());
  const rsv = o.reservationId ?? (await pool.query("INSERT INTO reservations(code, user_id, currency) VALUES ($1,$2,'INR') RETURNING id", [`R${Date.now()}${++invSeq}`, user.id])).rows[0].id;
  const kind = o.kind ?? 'invoice';
  const r = (await pool.query(
    `INSERT INTO invoices(kind, number, venue_id, reservation_id, user_id, parent_id, currency, status, total_cents, tax_cents, tax_name, tax_rate_bp, tax_inclusive, seller, lines, revision,
        payment_method, paid_at, walk_in, due_on, refund_status, refund_to_credits_cents, refunded_at)
     VALUES ($1,$2,$3,$4,$5,$6,'INR',$7,$8,$9,'GST',1800,true,'{}'::jsonb,'[]'::jsonb,$10,$11, CASE WHEN $7 = 'paid' THEN now() END,$12,$13,$14,$15, CASE WHEN $14 = 'done' THEN now() END) RETURNING id`,
    [kind, `FVI-${Date.now()}-${++invSeq}`, w.venue.id, rsv, user.id, o.parent ?? null, o.status ?? 'open', o.total ?? 11800, o.tax ?? 1800, o.revision ?? 1, o.method ?? null, o.walkIn ?? false,
      kind === 'invoice' ? (o.due ?? dayOf(5)) : null, o.refundStatus ?? null, o.refundToCredits ?? 0])).rows[0];
  return { id: r.id, user, reservationId: rsv };
};
const credit = (inv, source, amount) => pool.query('INSERT INTO invoice_credits(invoice_id, user_id, source, amount_cents) VALUES ($1,$2,$3,$4)', [inv.id, inv.user.id, source, amount]);
const onlinePayment = async (inv, amount, status = 'paid') => (await pool.query(
  "INSERT INTO payments(payer_id, provider, purpose_type, purpose_id, amount_cents, currency, status, provider_ref, provider_payment_ref, paid_at) VALUES ($1,'stripe','venue_invoice',$2,$3,'INR',$4,$5,$5, CASE WHEN $4 = 'paid' THEN now() END) RETURNING *",
  [inv.user.id, inv.id, amount, status, `pi_${Date.now()}_${++invSeq}`])).rows[0];

test('an open booking invoice is a receivable of the venue organisation; paid settles it and void cancels it', async () => {
  const w = await world();
  const a = await invoice(w, { total: 11800, tax: 1800, due: dayOf(-10) });
  const walk = await invoice(w, { total: 5900, tax: 900, due: dayOf(3), walkIn: true });
  const toVoid = await invoice(w, { total: 2000, tax: 305 });
  const run = await reconcile();
  assert.ok(run.synced.obligations >= 3);

  const r = await row(`obl:venue_invoice:${a.id}`);
  assert.equal(r.kind, 'charge'); assert.equal(r.status, 'open'); assert.equal(r.source_module, 'venue'); assert.equal(r.category, 'venue_service');
  assert.equal(r.payee_org_id, w.org.id); assert.equal(r.payee_id, owner.id); assert.equal(r.payer_id, a.user.id); assert.equal(r.gross_minor, 11800); assert.equal(r.tax_minor, 1800);
  assert.equal(r.due, dayOf(-10), 'due date comes from invoices.due_on');
  assert.equal((await row(`obl:venue_invoice:${walk.id}`)).payer_id, null, 'a walk-in guest has no payer account');
  assert.equal((await row(`obl:venue_invoice:${toVoid.id}`)).status, 'open');

  // dashboard, ageing and the obligations list agree
  const s = head(await w.sum());
  assert.equal(s.receivable, 11800 + 5900 + 2000);
  const age = await w.age();
  assert.equal(age.receivable.total, s.receivable, 'ageing total = dashboard receivable');
  assert.equal(age.receivable.buckets.d1_30, 11800, '10 days past due');
  assert.equal(age.receivable.buckets.current, 5900 + 2000);
  const list = await w.obligations();
  assert.deepEqual(new Set(list.map((x) => x.source_id)), new Set([a.id, walk.id, toVoid.id]));
  assert.ok(list.every((x) => x.source_type === 'venue_invoice'));
  assert.equal(list.reduce((t, x) => t + x.outstanding_minor, 0), s.receivable);
  assert.equal(list.find((x) => x.source_id === a.id).overdue, true);

  // paid -> settled (no longer a receivable); void -> cancelled
  await pool.query("UPDATE invoices SET status='paid', paid_at=now(), payment_method='cash' WHERE id=$1", [a.id]);
  await pool.query("UPDATE invoices SET status='void', voided_at=now() WHERE id=$1", [toVoid.id]);
  const run2 = await reconcile();
  assert.equal(run2.synced.obligations_updated, 2);
  assert.equal((await row(`obl:venue_invoice:${a.id}`)).status, 'settled');
  assert.equal((await row(`obl:venue_invoice:${toVoid.id}`)).status, 'cancelled');
  assert.equal(head(await w.sum()).receivable, 5900);
  assert.equal((await w.age()).receivable.total, 5900);
  assert.deepEqual((await w.obligations()).map((x) => x.source_id), [walk.id]);

  // a void invoice that was never posted is not posted at all; running again changes nothing
  const never = await invoice(w, { status: 'void', total: 700, tax: 100 });
  const again = await reconcile();
  assert.equal(again.synced.obligations, 0); assert.equal(again.synced.obligations_updated, 0);
  assert.equal(await row(`obl:venue_invoice:${never.id}`), undefined);
});

test('paid at the venue: one offline receipt with pro-rated tax; online, points and pass post none', async () => {
  const w = await world();
  const cash = await invoice(w, { status: 'paid', method: 'cash', total: 11800, tax: 1800 });
  const upi = await invoice(w, { status: 'paid', method: 'upi', total: 5900, tax: 900 });
  const online = await invoice(w, { status: 'paid', method: 'online', total: 11800, tax: 1800 });
  const pay = await onlinePayment(online, 11800);
  const points = await invoice(w, { status: 'paid', method: 'points', total: 4000, tax: 610 });
  await credit(points, 'points', 4000);
  const pass = await invoice(w, { status: 'paid', method: 'pass', total: 3000, tax: 458 });
  await credit(pass, 'pass', 3000);
  const mixed = await invoice(w, { status: 'paid', method: 'cash', total: 11800, tax: 1800 });   // 3000 by points, the rest in cash
  await credit(mixed, 'points', 3000);

  await reconcile();
  const r = await row(`receipt:venue_invoice:${cash.id}:11800`);
  assert.equal(r.kind, 'payment'); assert.equal(r.status, 'settled'); assert.equal(r.provider, 'offline'); assert.equal(r.gross_minor, 11800); assert.equal(r.tax_minor, 1800);
  assert.equal(r.payee_org_id, w.org.id); assert.equal(r.payer_id, cash.user.id); assert.equal(r.source_module, 'venue'); assert.equal(r.meta.recorded_outside_provider, true);
  const u = await row(`receipt:venue_invoice:${upi.id}:5900`);
  assert.equal(u.provider, 'offline'); assert.equal(u.gross_minor, 5900); assert.equal(u.tax_minor, 900);

  // online: only the provider payment is on the ledger
  const rec = await rowsOf(online.id, 'payment');
  assert.equal(rec.length, 1); assert.equal(rec[0].idem_key, `payment:${pay.id}`); assert.equal(rec[0].gross_minor, 11800);
  // points / pass credits are not money
  assert.equal((await rowsOf(points.id, 'payment')).length, 0); assert.equal((await rowsOf(pass.id, 'payment')).length, 0);
  for (const i of [online, points, pass]) assert.equal((await row(`obl:venue_invoice:${i.id}`)).status, 'settled', 'the obligation is settled even without a receipt');
  // part points, rest cash: the receipt is the total less the points credits, tax pro-rated
  const mx = await rowsOf(mixed.id, 'payment');
  assert.equal(mx.length, 1); assert.equal(mx[0].idem_key, `receipt:venue_invoice:${mixed.id}:8800`); assert.equal(mx[0].gross_minor, 8800); assert.equal(mx[0].tax_minor, Math.round((1800 * 8800) / 11800));

  const s = head(await w.sum());
  assert.equal(s.receivable, 0, 'everything is paid');
  assert.equal(s.gross, 11800 + 5900 + 11800 + 8800);
  const again = await reconcile();
  assert.equal(again.synced.receipts, 0); assert.equal(again.synced.obligations, 0);
  assert.equal((await rowsOf(cash.id, 'payment')).length, 1);
});

test('wallet credit: the wallet tender and the cash remainder add up to the total, never double counted', async () => {
  const w = await world();
  const split = await invoice(w, { status: 'paid', method: 'cash', total: 11800, tax: 1800 });
  await credit(split, 'wallet', 4000);
  const all = await invoice(w, { status: 'paid', method: 'wallet', total: 5900, tax: 900 });
  await credit(all, 'wallet', 5900);
  const run = await reconcile();
  assert.equal(run.synced.wallet, 2);

  const pays = await rowsOf(split.id, 'payment');
  assert.equal(pays.length, 2);
  const wallet = pays.find((p) => p.provider === 'wallet'), cashRow = pays.find((p) => p.provider === 'offline');
  assert.equal(wallet.gross_minor, 4000); assert.match(wallet.idem_key, /^receipt:invoice_credit:/);
  assert.equal(cashRow.gross_minor, 7800); assert.equal(cashRow.idem_key, `receipt:venue_invoice:${split.id}:11800`); assert.equal(cashRow.tax_minor, Math.round((1800 * 7800) / 11800));
  assert.equal(pays.reduce((t, p) => t + Number(p.gross_minor), 0), 11800);

  const allPays = await rowsOf(all.id, 'payment');
  assert.equal(allPays.length, 1, 'fully paid from the wallet: no cash receipt on top'); assert.equal(allPays[0].provider, 'wallet'); assert.equal(allPays[0].gross_minor, 5900);

  assert.equal(head(await w.sum()).gross, 11800 + 5900);
  const again = await reconcile();
  assert.equal(again.synced.receipts, 0); assert.equal(again.synced.wallet, 0);
  assert.equal((await rowsOf(split.id, 'payment')).length, 2);
});

test('invoices owned by the front desk, a team or other modules are not venue obligations', async () => {
  const w = await world();
  const user = await signup();
  // 1. a booking invoice that a front-desk sale holds (pos_sale_invoices)
  const sale = (await pool.query("INSERT INTO pos_sales(venue_id, cashier_id, currency, status, total_cents) VALUES ($1,$2,'INR','awaiting_payment',9000) RETURNING id", [w.venue.id, owner.id])).rows[0];
  const held = await invoice(w, { total: 9000, tax: 1373, user });
  await pool.query("INSERT INTO pos_sale_invoices(sale_id, invoice_id, role) VALUES ($1,$2,'booking')", [sale.id, held.id]);
  // 2. the sale's own invoice (pos_sale_id set, no reservation)
  const posInv = (await pool.query(
    `INSERT INTO invoices(number, venue_id, pos_sale_id, user_id, currency, total_cents, tax_cents, tax_name, tax_rate_bp, tax_inclusive, seller, lines)
     VALUES ($1,$2,$3,$4,'INR',4000,610,'GST',1800,true,'{}'::jsonb,'[]'::jsonb) RETURNING id`, [`FVI-POS-${Date.now()}`, w.venue.id, sale.id, user.id])).rows[0];
  // 3. a team charge invoice (no venue at all)
  const team = must(await api('POST', '/teams', { token: owner.token, body: { name: `Dues Team ${++n}`, sport: 'cricket' } }), 201);
  await pool.query('UPDATE teams SET organisation_id=$2 WHERE id=$1', [team.id, w.org.id]);
  must(await api('POST', `/teams/${team.id}/members`, { token: owner.token, body: { user_id: user.id } }), 201);
  must(await api('POST', `/teams/${team.id}/charges`, { token: owner.token, body: { kind: 'season_fee', title: 'Dues', amount_minor: 30000, due_on: dayOf(7), idempotency_key: `fvi${Date.now()}` } }), 201);
  const tc = (await pool.query('SELECT id FROM team_charges WHERE team_id=$1', [team.id])).rows[0];
  // the team-charge invoice the app raised for it (or, failing that, one inserted here)
  const teamInv = (await pool.query('SELECT id FROM invoices WHERE team_charge_id=$1', [tc.id])).rows[0] ?? (await pool.query(
    `INSERT INTO invoices(number, team_id, team_charge_id, user_id, currency, total_cents, tax_cents, tax_name, tax_rate_bp, tax_inclusive, seller, lines)
     VALUES ($1,$2,$3,$4,'INR',30000,0,'GST',0,true,'{}'::jsonb,'[]'::jsonb) RETURNING id`, [`FVI-TC-${Date.now()}`, team.id, tc.id, user.id])).rows[0];
  // control: a plain invoice at the same venue is posted
  const plain = await invoice(w, { total: 1000, tax: 153 });

  await reconcile();
  for (const id of [held.id, posInv.id, teamInv.id]) assert.equal(await row(`obl:venue_invoice:${id}`), undefined, 'not a venue obligation');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM fin_transactions WHERE source_type='venue_invoice' AND source_id = ANY($1::uuid[])", [[held.id, posInv.id, teamInv.id]])).rows[0].n, 0);
  assert.ok(await row(`obl:venue_invoice:${plain.id}`));
  // the team charge keeps its own obligation, and the venue books only the plain invoice
  assert.equal((await row(`obl:team_charge:${tc.id}`)).status, 'open');
  assert.deepEqual((await w.obligations()).filter((x) => x.source_type === 'venue_invoice').map((x) => x.source_id), [plain.id]);
  // paying the held invoice at the venue posts no venue receipt either
  await pool.query("UPDATE invoices SET status='paid', paid_at=now(), payment_method='cash' WHERE id=$1", [held.id]);
  await reconcile();
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM fin_transactions WHERE idem_key LIKE 'receipt:venue_invoice:%' AND source_id=$1", [held.id])).rows[0].n, 0);
});

test('an open invoice edited in place is re-posted under :r<revision>; the checkout charge is replaced and never counted twice', async () => {
  const w = await world();
  const inv = await invoice(w, { total: 11800, tax: 1800 });
  // an online checkout started before the obligation existed raised its own open charge
  const p1 = (await onlinePayment(inv, 11800, 'pending'));
  assert.ok(await fin.recordCharge(null, p1));
  assert.equal((await row(`charge:${p1.id}`)).status, 'open');
  await reconcile();
  assert.equal((await row(`charge:${p1.id}`)).status, 'cancelled', 'the obligation replaces the checkout charge');
  assert.equal((await row(`obl:venue_invoice:${inv.id}`)).status, 'open');
  assert.equal(head(await w.sum()).receivable, 11800, 'counted once');

  // the booking changed: new amount, new revision
  await pool.query('UPDATE invoices SET total_cents=17700, tax_cents=2700, revision=2 WHERE id=$1', [inv.id]);
  const run = await reconcile();
  assert.equal(run.synced.obligations, 1);
  const old = await row(`obl:venue_invoice:${inv.id}`), next = await row(`obl:venue_invoice:${inv.id}:r2`);
  assert.equal(old.status, 'cancelled'); assert.equal(old.gross_minor, 11800, 'a posted amount never changes');
  assert.equal(next.status, 'open'); assert.equal(next.gross_minor, 17700); assert.equal(next.tax_minor, 2700); assert.equal(next.meta.supersedes, `obl:venue_invoice:${inv.id}`); assert.equal(next.meta.revision, 2);
  const open = (await pool.query("SELECT idem_key FROM fin_transactions WHERE kind='charge' AND status='open' AND source_type='venue_invoice' AND source_id=$1", [inv.id])).rows;
  assert.deepEqual(open.map((x) => x.idem_key), [`obl:venue_invoice:${inv.id}:r2`], 'only one open charge');
  assert.equal(head(await w.sum()).receivable, 17700);
  assert.equal((await w.age()).receivable.total, 17700);
  const list = await w.obligations();
  assert.equal(list.length, 1); assert.equal(list[0].outstanding_minor, 17700);

  // nothing more to post, and a later checkout does not raise a second receivable
  const again = await reconcile();
  assert.equal(again.synced.obligations, 0); assert.equal(again.synced.obligations_updated, 0);
  const p2 = await onlinePayment(inv, 17700, 'pending');
  assert.equal(await fin.recordCharge(null, p2), null, 'an obligation (including a :r<n> key) already carries the receivable');
  assert.equal(await row(`charge:${p2.id}`), undefined);
  assert.equal(head(await w.sum()).receivable, 17700);

  // a second revision supersedes the first
  await pool.query('UPDATE invoices SET total_cents=9000, tax_cents=1373, revision=3 WHERE id=$1', [inv.id]);
  await reconcile();
  assert.equal((await row(`obl:venue_invoice:${inv.id}:r2`)).status, 'cancelled');
  assert.equal((await row(`obl:venue_invoice:${inv.id}:r3`)).gross_minor, 9000);
  assert.equal(head(await w.sum()).receivable, 9000);

  // and once it is paid, the latest charge settles
  await pool.query("UPDATE invoices SET status='paid', paid_at=now(), payment_method='cash' WHERE id=$1", [inv.id]);
  await reconcile();
  assert.equal((await row(`obl:venue_invoice:${inv.id}:r3`)).status, 'settled');
  assert.equal(head(await w.sum()).receivable, 0);
});

test('credit notes: a hand-paid refund posts once for the part not returned to the wallet; online, pending and manual ones post none', async () => {
  const w = await world();
  const mk = async (opts = {}) => {
    const parent = await invoice(w, { status: 'paid', method: opts.method ?? 'cash', total: 11800, tax: 1800 });
    const cn = await invoice(w, { kind: 'credit_note', status: 'paid', parent: parent.id, reservationId: parent.reservationId, user: parent.user, total: 5900, tax: 900, refundStatus: opts.refundStatus ?? 'done', refundToCredits: opts.toCredits ?? 0 });
    return { parent, cn };
  };
  const hand = await mk({ toCredits: 1000 });
  const cashOnly = await mk({ toCredits: 0 });
  const online = await mk({ method: 'online' });
  await onlinePayment(online.parent, 11800);
  const pending = await mk({ refundStatus: 'pending' });
  const manual = await mk({ refundStatus: 'manual' });
  const allWallet = await mk({ toCredits: 5900 });

  const run = await reconcile();
  assert.equal(run.synced.venue_credit_notes, 2);
  const r = await row(`refund:venue_credit_note:${hand.cn.id}`);
  assert.equal(r.kind, 'refund'); assert.equal(r.status, 'settled'); assert.equal(r.provider, 'offline'); assert.equal(r.gross_minor, 4900); assert.equal(r.tax_minor, Math.round((900 * 4900) / 5900));
  assert.equal(r.source_type, 'venue_invoice'); assert.equal(r.source_id, hand.parent.id); assert.equal(r.payee_org_id, w.org.id);
  assert.equal((await row(`refund:venue_credit_note:${cashOnly.cn.id}`)).gross_minor, 5900);
  for (const x of [online, pending, manual, allWallet]) assert.equal(await row(`refund:venue_credit_note:${x.cn.id}`), undefined);
  // the online refund is posted from payments, not here
  assert.equal((await rowsOf(online.parent.id, 'refund')).length, 0);

  // the manual refund is later settled by hand: it posts then, once
  await pool.query("UPDATE invoices SET refund_status='done', refunded_at=now() WHERE id=$1", [pending.cn.id]);
  assert.equal((await reconcile()).synced.venue_credit_notes, 1);
  assert.equal((await row(`refund:venue_credit_note:${pending.cn.id}`)).gross_minor, 5900);
  assert.equal((await reconcile()).synced.venue_credit_notes, 0, 'posted once');
});

test('recordPayment pro-rates the invoice tax to the part an online payment covers', async () => {
  const w = await world();
  const inv = await invoice(w, { total: 11800, tax: 1800 });
  const part = await onlinePayment(inv, 5900);
  const part2 = await onlinePayment(inv, 3000);
  await reconcile();
  const a = await row(`payment:${part.id}`), b = await row(`payment:${part2.id}`);
  assert.equal(a.gross_minor, 5900); assert.equal(a.tax_minor, 900, 'half the invoice, half the tax - not the whole 1800');
  assert.equal(b.tax_minor, Math.round((1800 * 3000) / 11800)); assert.ok(b.tax_minor < 1800);
  assert.equal(a.payee_org_id, w.org.id); assert.equal(a.source_module, 'venue');
  // the obligation nets both payments while the invoice is still open
  assert.equal(head(await w.sum()).receivable, 11800 - 5900 - 3000);
  assert.equal((await w.age()).receivable.total, 11800 - 5900 - 3000);

  // the direct call, inside a transaction, with a payments-like object
  const direct = await onlinePayment(inv, 2000);
  const { tx } = await import('../src/db.js');
  await tx((c) => fin.recordPayment(c, direct));
  assert.equal((await row(`payment:${direct.id}`)).tax_minor, Math.round((1800 * 2000) / 11800));
  // the whole invoice paid in one go carries the whole tax, and never more
  const full = await invoice(w, { total: 5900, tax: 900 });
  const fp = await onlinePayment(full, 5900);
  await tx((c) => fin.recordPayment(c, fp));
  assert.equal((await row(`payment:${fp.id}`)).tax_minor, 900);
});
