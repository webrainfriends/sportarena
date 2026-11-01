import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Finance control plane: academy charges, supplier invoices (+ credit notes) and sponsorship dues/payments reach the canonical ledger as
// obligations and receipts, and every organisation's receivable / payable reconciles to its own source records. All data is created by the tests.
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp', PLATFORM_ADMIN_EMAILS: 'rraja.edge@gmail.com,rrajas1978@icloud.com', PAYMENT_CURRENCY: 'INR',
});
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { blindIndex } = await import('../src/crypto.js');
const fin = await import('../src/finance.js');

let server, base, n = 0, boss;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `fso_${n}_${roles[0]}`, display_name: `Src ${n}`, email: `fso${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const dayOf = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const reconcile = async () => must(await api('POST', '/admin/finance/reconcile', { token: boss.token, body: {} }), 200);
/** a user with a fresh organisation they control */
const mkOrg = async (kind = 'academy') => { const user = await signup(); const org = must(await api('POST', '/organisations', { token: user.token, body: { name: `Src Org ${++n}`, kind } }), 201); return { user, org, id: org.id, token: user.token }; };
const ageing = async (o) => {
  const a = must(await api('GET', '/finance/ageing', { token: o.token, query: { organisation_id: o.id } })).currencies.find((c) => c.currency === 'INR');
  return { receivable: a?.receivable.total ?? 0, payable: a?.payable.total ?? 0 };
};
const summary = async (o) => {
  const s = must(await api('GET', '/finance/summary', { token: o.token, query: { organisation_id: o.id } })).currencies.find((c) => c.currency === 'INR');
  return { gross: s?.gross ?? 0, receivable: s?.receivable ?? 0, payable: s?.payable ?? 0 };
};
const obligations = async (o, direction) => must(await api('GET', '/finance/obligations', { token: o.token, query: { organisation_id: o.id, direction } }));
const row = async (key) => (await pool.query("SELECT *, to_char(due_on,'YYYY-MM-DD') AS due FROM fin_transactions WHERE idem_key=$1", [key])).rows[0];
const rowsLike = async (like) => (await pool.query('SELECT * FROM fin_transactions WHERE idem_key LIKE $1 ORDER BY occurred_at, idem_key', [like])).rows;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  boss = await signup();
  await pool.query("UPDATE users SET roles='{athlete,admin,platform_admin}', email_idx=$2 WHERE id=$1", [boss.id, blindIndex('rraja.edge@gmail.com')]);
});
after(async () => { server.close(); await pool.end(); });

test('academy charges: open with due date, paid posts a cumulative offline receipt, cancelled and waived are not posted', async () => {
  const a = await mkOrg();
  const parent = await signup();
  const athlete = await signup();
  const prog = (await pool.query("INSERT INTO academy_programmes(organisation_id, sport, title) VALUES ($1,'cricket','Junior squad') RETURNING id", [a.id])).rows[0];
  const app = (await pool.query('INSERT INTO academy_applications(organisation_id, programme_id, athlete_id, applicant_id) VALUES ($1,$2,$3,$4) RETURNING id', [a.id, prog.id, athlete.id, parent.id])).rows[0];
  const charge = async (kind, amount, status, dueOffset) => (await pool.query(
    `INSERT INTO academy_charges(application_id, organisation_id, payer_id, seq, kind, due_on, currency, gross_minor, amount_minor, status, paid_at)
     VALUES ($1,$2,$3,1,$4,$5,'INR',$6,$6,$7, CASE WHEN $7 = 'paid' THEN now() END) RETURNING id`, [app.id, a.id, parent.id, kind, dayOf(dueOffset), amount, status])).rows[0].id;
  const open = await charge('trial', 50000, 'awaiting_payment', -10);
  const paid = await charge('registration', 20000, 'paid', -3);
  const cancelled = await charge('deposit', 30000, 'cancelled', 5);
  const waived = await charge('tuition', 40000, 'waived', 5);

  const run = await reconcile();
  assert.ok(run.synced.obligations >= 2);
  const o = await row(`obl:academy_charge:${open}`);
  assert.equal(o.kind, 'charge'); assert.equal(o.status, 'open'); assert.equal(o.due, dayOf(-10)); assert.equal(o.payee_org_id, a.id); assert.equal(o.payer_id, parent.id); assert.equal(Number(o.gross_minor), 50000);
  assert.equal((await row(`obl:academy_charge:${paid}`)).status, 'settled');
  assert.equal(await row(`obl:academy_charge:${cancelled}`), undefined, 'a cancelled charge is not posted');
  assert.equal(await row(`obl:academy_charge:${waived}`), undefined, 'a waived charge is not posted');
  // the paid charge's money is one offline receipt of the full amount, for the same source and payee organisation
  const receipts = (await pool.query("SELECT * FROM fin_transactions WHERE kind='payment' AND source_type='academy_charge' AND source_id=$1", [paid])).rows;
  assert.equal(receipts.length, 1); assert.equal(Number(receipts[0].gross_minor), 20000); assert.equal(receipts[0].provider, 'offline'); assert.equal(receipts[0].payee_org_id, a.id);
  assert.equal(receipts[0].idem_key, `receipt:academy_charge:${paid}:20000`);
  assert.equal((await pool.query("SELECT count(*)::int AS c FROM fin_transactions WHERE source_type='academy_charge' AND source_id = ANY($1)", [[cancelled, waived]])).rows[0].c, 0);
  // receivable counts only the open charge, with its due date driving the ageing; the receipt is income
  assert.equal((await ageing(a)).receivable, 50000);
  const s = await summary(a);
  assert.equal(s.receivable, 50000); assert.equal(s.gross, 20000);
  const list = await obligations(a, 'in');
  assert.equal(list.length, 1); assert.equal(list[0].source_type, 'academy_charge'); assert.equal(list[0].source_id, open); assert.equal(list[0].outstanding_minor, 50000); assert.ok(list[0].overdue);

  // the open charge is paid later: the obligation settles and the receipt posts once; running again posts nothing
  await pool.query("UPDATE academy_charges SET status='paid', paid_at=now() WHERE id=$1", [open]);
  await reconcile();
  assert.equal((await row(`obl:academy_charge:${open}`)).status, 'settled');
  assert.equal(Number((await pool.query("SELECT coalesce(sum(gross_minor),0) AS g FROM fin_transactions WHERE kind='payment' AND source_type='academy_charge' AND source_id=$1", [open])).rows[0].g), 50000);
  assert.equal((await ageing(a)).receivable, 0);
  const again = await reconcile();
  assert.equal(again.synced.receipts + again.synced.obligations + again.synced.obligations_updated, 0);
  // a charge cancelled after it was posted closes the obligation instead of deleting it
  const later = await charge('pack', 10000, 'awaiting_payment', 2);
  await reconcile();
  assert.equal((await row(`obl:academy_charge:${later}`)).status, 'open');
  await pool.query("UPDATE academy_charges SET status='cancelled' WHERE id=$1", [later]);
  await reconcile();
  assert.equal((await row(`obl:academy_charge:${later}`)).status, 'cancelled');
  assert.equal((await ageing(a)).receivable, 0);
});

/** buyer and supplier organisations with an order, ready for invoices */
const supplierSetup = async () => {
  const buyer = await mkOrg('club'), supplier = await mkOrg('company');
  const profile = (await pool.query("INSERT INTO svc_profiles(owner_id, organisation_id, supplier_type, legal_name) VALUES ($1,$2,'company',$3) RETURNING id", [supplier.user.id, supplier.id, `Supplier ${++n}`])).rows[0];
  const sb = (await pool.query("INSERT INTO svc_buyers(owner_id, organisation_id, name, currency) VALUES ($1,$2,$3,'INR') RETURNING id", [buyer.user.id, buyer.id, `Buyer ${n}`])).rows[0];
  const order = (await pool.query("INSERT INTO svc_orders(number, buyer_id, profile_id, currency, net_minor, tax_minor, gross_minor, created_by) VALUES ($1,$2,$3,'INR',200000,36000,236000,$4) RETURNING id", [`PO-${n}-${Date.now()}`, sb.id, profile.id, buyer.user.id])).rows[0];
  const doc = async (docType, { gross, parent = null, status = 'issued', paid = 0, due = 30, payStatus = 'unpaid' }) => (await pool.query(
    `INSERT INTO svc_invoices(order_id, profile_id, buyer_id, doc_type, parent_id, supplier_number, status, currency, lines, net_minor, tax_minor, gross_minor, payable_minor, due_on, paid_minor, pay_status, issued_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'INR','[]',$8,$9,$10,$10,$11,$12,$13, CASE WHEN $7 = 'draft' THEN NULL ELSE now() END, $14) RETURNING id`,
    [order.id, profile.id, sb.id, docType, parent, `${docType.slice(0, 3).toUpperCase()}-${++n}`, status, Math.round(gross / 1.18), gross - Math.round(gross / 1.18), gross, dayOf(due), paid, payStatus, supplier.user.id])).rows[0].id;
  return { buyer, supplier, doc };
};

test('supplier invoices: payer is the buyer organisation, payee the supplier, paid_minor posts cumulative receipts; drafts are not posted', async () => {
  const { buyer, supplier, doc } = await supplierSetup();
  const inv = await doc('invoice', { gross: 118000, due: -40 });
  const draft = await doc('invoice', { gross: 50000, status: 'draft' });
  const proforma = await doc('proforma', { gross: 70000 });
  await reconcile();
  const o = await row(`obl:service_invoice:${inv}`);
  assert.equal(o.kind, 'charge'); assert.equal(o.status, 'open'); assert.equal(o.payer_org_id, buyer.id); assert.equal(o.payee_org_id, supplier.id); assert.equal(o.due, dayOf(-40));
  assert.equal(o.payee_id, supplier.user.id); assert.equal(o.payer_id, buyer.user.id);
  assert.equal(await row(`obl:service_invoice:${draft}`), undefined); assert.equal(await row(`obl:service_invoice:${proforma}`), undefined);
  assert.equal(o.category, 'suppliers');
  // the buyer owes it (payable), the supplier is owed it (receivable)
  assert.deepEqual(await ageing(buyer), { receivable: 0, payable: 118000 });
  assert.deepEqual(await ageing(supplier), { receivable: 118000, payable: 0 });
  const out = await obligations(buyer, 'out');
  assert.equal(out.length, 1); assert.equal(out[0].source_id, inv); assert.equal(out[0].outstanding_minor, 118000);

  // partly paid, then paid more: cumulative receipts, each posted once
  await pool.query("UPDATE svc_invoices SET paid_minor=40000, pay_status='partially_paid' WHERE id=$1", [inv]);
  await reconcile();
  const receipts1 = await rowsLike(`receipt:service_invoice:${inv}:%`);
  assert.deepEqual(receipts1.map((r) => [r.idem_key, Number(r.gross_minor), r.provider]), [[`receipt:service_invoice:${inv}:40000`, 40000, 'offline']]);
  assert.equal(receipts1[0].payer_org_id, buyer.id); assert.equal(receipts1[0].payee_org_id, supplier.id);
  assert.deepEqual(await ageing(buyer), { receivable: 0, payable: 78000 });
  assert.deepEqual(await ageing(supplier), { receivable: 78000, payable: 0 });
  await pool.query("UPDATE svc_invoices SET paid_minor=100000 WHERE id=$1", [inv]);
  await reconcile();
  const receipts2 = await rowsLike(`receipt:service_invoice:${inv}:%`);
  assert.equal(receipts2.length, 2);
  assert.equal(receipts2.reduce((t, r) => t + Number(r.gross_minor), 0), 100000, 'the second receipt is only the difference');
  assert.deepEqual(await ageing(buyer), { receivable: 0, payable: 18000 });
  const again = await reconcile();
  assert.equal(again.synced.receipts, 0);
  // fully paid: settled, nothing outstanding on either side
  await pool.query("UPDATE svc_invoices SET paid_minor=118000, pay_status='paid' WHERE id=$1", [inv]);
  await reconcile();
  assert.equal((await row(`obl:service_invoice:${inv}`)).status, 'settled');
  assert.deepEqual(await ageing(buyer), { receivable: 0, payable: 0 });
  assert.deepEqual(await ageing(supplier), { receivable: 0, payable: 0 });
  assert.equal((await summary(supplier)).gross, 118000);
  // an invoice voided after it was posted is cancelled, not removed
  const voided = await doc('invoice', { gross: 20000 });
  await reconcile();
  assert.equal((await row(`obl:service_invoice:${voided}`)).status, 'open');
  await pool.query("UPDATE svc_invoices SET status='void' WHERE id=$1", [voided]);
  await reconcile();
  assert.equal((await row(`obl:service_invoice:${voided}`)).status, 'cancelled');
});

test('supplier credit notes reduce the buyer payable and the supplier receivable, once', async () => {
  const { buyer, supplier, doc } = await supplierSetup();
  const inv = await doc('invoice', { gross: 118000, due: 10 });
  await reconcile();
  assert.deepEqual(await ageing(buyer), { receivable: 0, payable: 118000 });
  const cn = await doc('credit_note', { gross: 18000, parent: inv });
  const draftCn = await doc('credit_note', { gross: 5000, parent: inv, status: 'draft' });
  const run = await reconcile();
  assert.equal(run.synced.credit_notes, 1);
  const c = await row(`crn:service_invoice:${cn}`);
  assert.equal(c.kind, 'credit_note'); assert.equal(c.status, 'settled'); assert.equal(c.source_type, 'service_invoice'); assert.equal(c.source_id, inv);
  assert.equal(Number(c.gross_minor), 18000); assert.equal(c.payer_org_id, buyer.id); assert.equal(c.payee_org_id, supplier.id);
  assert.equal(await row(`crn:service_invoice:${draftCn}`), undefined, 'a draft credit note does not reduce anything');
  assert.equal(await row(`obl:service_invoice:${cn}`), undefined, 'a credit note is not an obligation of its own');
  assert.deepEqual(await ageing(buyer), { receivable: 0, payable: 100000 });
  assert.deepEqual(await ageing(supplier), { receivable: 100000, payable: 0 });
  assert.equal((await summary(buyer)).payable, 100000);
  assert.equal((await obligations(buyer, 'out'))[0].outstanding_minor, 100000);
  // the credit note is not income: it never shows as a payment received
  assert.equal((await summary(supplier)).gross, 0);
  // idempotent
  assert.equal((await reconcile()).synced.credit_notes, 0);
  assert.equal((await rowsLike(`crn:service_invoice:${cn}`)).length, 1);
  // payment of the remainder settles the books
  await pool.query("UPDATE svc_invoices SET paid_minor=100000 WHERE id=$1", [inv]);
  await reconcile();
  assert.deepEqual(await ageing(buyer), { receivable: 0, payable: 0 });
  assert.deepEqual(await ageing(supplier), { receivable: 0, payable: 0 });
});

/** a sponsor organisation paying an event of another organisation */
const sponsorSetup = async (amounts = [100000], dueOffset = -20) => {
  const sponsorOrg = await mkOrg('company'), eventOrg = await mkOrg('club');
  const ev = must(await api('POST', '/events', { token: eventOrg.token, body: { name: `Sponsored Cup ${++n}`, sport: 'football', starts_on: dayOf(1), ends_on: dayOf(3) } }), 201);
  await pool.query('UPDATE events SET organisation_id=$2 WHERE id=$1', [ev.id, eventOrg.id]);
  const sponsor = (await pool.query("INSERT INTO sponsors(owner_id, name, organisation_id) VALUES ($1,$2,$3) RETURNING id", [sponsorOrg.user.id, `Brand ${n}`, sponsorOrg.id])).rows[0];
  const sp = (await pool.query("INSERT INTO sponsorships(sponsor_id, target_type, target_id, amount_cents, status, proposed_by, currency) VALUES ($1,'event',$2,$3,'active',$4,'INR') RETURNING id", [sponsor.id, ev.id, amounts.reduce((a, b) => a + b, 0), sponsorOrg.user.id])).rows[0];
  const line = (await pool.query("INSERT INTO sponsorship_lines(sponsorship_id, version, position, kind, label, currency, amount_cents, total_cents) VALUES ($1,1,1,'money','Title sponsor','INR',$2,$2) RETURNING id", [sp.id, amounts[0]])).rows[0];
  const ids = [];
  for (const [i, amt] of amounts.entries()) ids.push((await pool.query("INSERT INTO sponsorship_obligations(sponsorship_id, version, line_id, seq, kind, due_on, amount_cents, currency) VALUES ($1,1,$2,$3,'money',$4,$5,'INR') RETURNING id", [sp.id, line.id, i + 1, dayOf(dueOffset), amt])).rows[0].id);
  const pay = async (obligation, amount, { method = 'bank_transfer', status = 'confirmed', refunded = 0 } = {}) => (await pool.query(
    "INSERT INTO sponsorship_payments(obligation_id, amount_cents, currency, method, reference, paid_on, status, reported_by, decided_by, decided_at, refunded_cents) VALUES ($1,$2,'INR',$3,$4,$5,$6,$7,$7,now(),$8) RETURNING id",
    [obligation, amount, method, `UTR-${++n}`, dayOf(-1), status, sponsorOrg.user.id, refunded])).rows[0].id;
  return { sponsorOrg, eventOrg, ev, sp, obligations: ids, pay };
};

test('sponsorship dues become obligations; confirmed offline payments net the outstanding and only the remainder ages', async () => {
  const s = await sponsorSetup([100000, 60000]);
  const [ob1, ob2] = s.obligations;
  // goods and unconfirmed claims never count
  const reported = await s.pay(ob1, 15000, { status: 'reported' });
  await reconcile();
  const o = await row(`obl:sponsorship_obligation:${ob1}`);
  assert.equal(o.kind, 'charge'); assert.equal(o.status, 'open'); assert.equal(o.due, dayOf(-20)); assert.equal(o.payer_org_id, s.sponsorOrg.id); assert.equal(o.payee_org_id, s.eventOrg.id); assert.equal(o.event_id, s.ev.id);
  assert.equal(o.category, 'sponsorship');
  assert.deepEqual(await ageing(s.eventOrg), { receivable: 160000, payable: 0 });
  assert.deepEqual(await ageing(s.sponsorOrg), { receivable: 0, payable: 160000 });
  assert.equal((await pool.query("SELECT count(*)::int AS c FROM fin_transactions WHERE idem_key = $1", [`receipt:sponsorship_payment:${reported}`])).rows[0].c, 0, 'a reported (unverified) payment is not posted');

  // a confirmed bank transfer for part of the first due
  const p1 = await s.pay(ob1, 30000);
  const run = await reconcile();
  assert.equal(run.synced.receipts, 1);
  const r = await row(`receipt:sponsorship_payment:${p1}`);
  assert.equal(r.kind, 'payment'); assert.equal(r.status, 'settled'); assert.equal(Number(r.gross_minor), 30000); assert.equal(r.provider, 'offline');
  assert.equal(r.source_type, 'sponsorship_obligation'); assert.equal(r.source_id, ob1); assert.equal(r.payer_org_id, s.sponsorOrg.id); assert.equal(r.payee_org_id, s.eventOrg.id);
  assert.equal((await row(`obl:sponsorship_obligation:${ob1}`)).status, 'open', 'still open: only part is paid');
  assert.deepEqual(await ageing(s.eventOrg), { receivable: 130000, payable: 0 }, 'the part-paid due shows only its remainder');
  assert.deepEqual(await ageing(s.sponsorOrg), { receivable: 0, payable: 130000 });
  const list = await obligations(s.eventOrg, 'in');
  assert.deepEqual(list.map((x) => [x.source_id, x.outstanding_minor]).sort(), [[ob1, 70000], [ob2, 60000]].sort());
  assert.equal((await summary(s.eventOrg)).gross, 30000);
  assert.equal((await reconcile()).synced.receipts, 0, 'the receipt posts once');

  // the rest of the first due: it settles
  await s.pay(ob1, 70000);
  await reconcile();
  assert.equal((await row(`obl:sponsorship_obligation:${ob1}`)).status, 'settled');
  assert.deepEqual(await ageing(s.eventOrg), { receivable: 60000, payable: 0 });
  assert.equal((await obligations(s.eventOrg, 'in')).length, 1);
});

test('online sponsorship payments on the ledger net the obligation through sponsorship_payments, and their organisations are filled', async () => {
  const s = await sponsorSetup([100000]);
  const [ob] = s.obligations;
  await reconcile();
  assert.deepEqual(await ageing(s.eventOrg), { receivable: 100000, payable: 0 });
  // an online checkout confirmed by the provider: the sponsorship_payments row plus the payment the provider flow posts for it (no organisations yet)
  const online = await s.pay(ob, 20000, { method: 'online' });
  const ins = (await pool.query(
    `INSERT INTO fin_transactions(kind, status, source_module, source_type, source_id, currency, gross_minor, net_minor, provider, idem_key)
     VALUES ('payment','settled','sponsorship','sponsorship_payment',$1,'INR',20000,20000,'razorpay',$2) RETURNING id, payer_org_id, payee_org_id, event_id`, [online, `payment:test-online-${online}`])).rows[0];
  assert.equal(ins.payer_org_id, null); assert.equal(ins.payee_org_id, null);
  // OUTSTANDING nets the online money through sponsorship_payments.obligation_id even before the organisations are known
  assert.equal((await obligations(s.eventOrg, 'in'))[0].outstanding_minor, 80000);
  await fin.applyDimensions(null, null);
  const filled = (await pool.query('SELECT * FROM fin_transactions WHERE id=$1', [ins.id])).rows[0];
  assert.equal(filled.payer_org_id, s.sponsorOrg.id); assert.equal(filled.payee_org_id, s.eventOrg.id); assert.equal(filled.event_id, s.ev.id, 'event dimension read from the sponsorship');
  assert.equal(filled.category, 'sponsorship');
  assert.equal(Number(filled.gross_minor), 20000, 'amounts are never touched');
  // the reconciliation does not post a second, offline receipt for it
  const run = await reconcile();
  assert.equal(run.synced.receipts, 0);
  assert.equal((await rowsLike(`receipt:sponsorship_payment:${online}`)).length, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS c FROM fin_transactions WHERE source_type='sponsorship_payment' AND source_id=$1", [online])).rows[0].c, 1);
  assert.deepEqual(await ageing(s.eventOrg), { receivable: 80000, payable: 0 });
  assert.deepEqual(await ageing(s.sponsorOrg), { receivable: 0, payable: 80000 });
  assert.equal((await summary(s.eventOrg)).gross, 20000, 'the online money is income of the event organisation');
  assert.equal((await row(`obl:sponsorship_obligation:${ob}`)).status, 'open');
  // an offline transfer adds to it, and the due is settled once the confirmed money covers it
  await s.pay(ob, 80000);
  await reconcile();
  assert.equal((await row(`obl:sponsorship_obligation:${ob}`)).status, 'settled');
  assert.deepEqual(await ageing(s.eventOrg), { receivable: 0, payable: 0 });
});

test('a refund on a confirmed offline sponsorship payment posts the delta once and reopens the obligation', async () => {
  const s = await sponsorSetup([100000], 5);
  const [ob] = s.obligations;
  const p = await s.pay(ob, 100000);
  await reconcile();
  assert.equal((await row(`obl:sponsorship_obligation:${ob}`)).status, 'settled');
  assert.deepEqual(await ageing(s.eventOrg), { receivable: 0, payable: 0 });
  assert.equal((await rowsLike(`refund:sponsorship_payment:${p}:%`)).length, 0);

  await pool.query('UPDATE sponsorship_payments SET refunded_cents=30000 WHERE id=$1', [p]);
  const run = await reconcile();
  assert.equal(run.synced.sponsorship_refunds, 1);
  const refunds = await rowsLike(`refund:sponsorship_payment:${p}:%`);
  assert.deepEqual(refunds.map((r) => [r.idem_key, Number(r.gross_minor), r.kind, r.status]), [[`refund:sponsorship_payment:${p}:30000`, 30000, 'refund', 'settled']]);
  const rf = refunds[0];
  assert.equal(rf.source_type, 'sponsorship_obligation'); assert.equal(rf.source_id, ob); assert.equal(rf.provider, 'offline');
  assert.equal(rf.payer_org_id, s.eventOrg.id, 'money goes back from the event organisation'); assert.equal(rf.payee_org_id, s.sponsorOrg.id);
  assert.equal((await row(`obl:sponsorship_obligation:${ob}`)).status, 'open', 'net confirmed 70000 < 100000: the obligation reopens');
  assert.equal((await ageing(s.eventOrg)).receivable, 30000, 'and the refunded 30000 is outstanding again, so it ages');
  assert.equal((await reconcile()).synced.sponsorship_refunds, 0, 'posted once');
  // a larger refund posts only the extra
  await pool.query('UPDATE sponsorship_payments SET refunded_cents=50000 WHERE id=$1', [p]);
  assert.equal((await reconcile()).synced.sponsorship_refunds, 1);
  const after = await rowsLike(`refund:sponsorship_payment:${p}:%`);
  assert.deepEqual(after.map((r) => Number(r.gross_minor)).sort((a, b) => a - b), [20000, 30000]);
  assert.equal(after.reduce((t, r) => t + Number(r.gross_minor), 0), 50000);
  assert.ok(after.some((r) => r.idem_key === `refund:sponsorship_payment:${p}:50000`));
  assert.equal((await row(`obl:sponsorship_obligation:${ob}`)).status, 'open');
});
