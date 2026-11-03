import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Finance sources #2: travel claims and payments, front-desk cash tenders and wallet tenders all reach the organisation's canonical ledger exactly once.
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp', PLATFORM_ADMIN_EMAILS: 'rraja.edge@gmail.com,rrajas1978@icloud.com', PAYMENT_CURRENCY: 'INR',
});
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { blindIndex } = await import('../src/crypto.js');

let server, base, n = 0, boss, owner, outsider, org, other;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `fsc_${n}_${roles[0]}`, display_name: `Src ${n}`, email: `fsc${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const dayOf = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const reconcile = async () => must(await api('POST', '/admin/finance/reconcile', { token: boss.token, body: {} }), 200);
const q = (extra = {}) => ({ organisation_id: org.id, ...extra });
const sum = async (extra = {}) => must(await api('GET', '/finance/summary', { token: owner.token, query: q(extra) }));
const head = (s, cur = 'INR') => s.currencies.find((c) => c.currency === cur) ?? { gross: 0, receivable: 0, payable: 0, spend: 0, by_category: [] };
const cat = (s, c, cur = 'INR') => head(s, cur).by_category.find((x) => x.category === c) ?? { gross: 0, receivable: 0, spend: 0 };
const row = async (key) => (await pool.query('SELECT * FROM fin_transactions WHERE idem_key=$1', [key])).rows[0];
const rows = async (like) => (await pool.query('SELECT * FROM fin_transactions WHERE idem_key LIKE $1 ORDER BY idem_key', [like])).rows;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  boss = await signup();
  await pool.query("UPDATE users SET roles='{athlete,admin,platform_admin}', email_idx=$2 WHERE id=$1", [boss.id, blindIndex('rraja.edge@gmail.com')]);
  owner = await signup(); outsider = await signup();
  org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Cash Org ${++n}`, kind: 'academy' } }), 201);
  other = must(await api('POST', '/organisations', { token: outsider.token, body: { name: `Other Org ${++n}`, kind: 'academy' } }), 201);
});
after(async () => { server.close(); await pool.end(); });

const mkTrip = async ({ organisationId = null, teamId = null }) => {
  const t = (await pool.query(
    `INSERT INTO trips(name, origin, destination, timezone, depart_at, return_at, manager_id, created_by, organisation_id, team_id)
     VALUES ($1,'Chennai','Mumbai','Asia/Kolkata', now() + interval '10 days', now() + interval '14 days', $2, $2, $3, $4) RETURNING id`, [`Away trip ${++n}`, owner.id, organisationId, teamId])).rows[0];
  const user = await signup();
  const p = (await pool.query("INSERT INTO trip_participants(trip_id, user_id, role, status, basis, invited_by) VALUES ($1,$2,'coach','confirmed','organisation',$3) RETURNING id", [t.id, user.id, owner.id])).rows[0];
  return { id: t.id, participant: p.id, user };
};
const claim = async (trip, amount, status, incurred = dayOf(-3)) => (await pool.query(
  "INSERT INTO trip_claims(trip_id, participant_id, category, description, amount_minor, currency, incurred_on, status, created_by) VALUES ($1,$2,'transport','Taxi to ground',$3,'INR',$4,$5,$6) RETURNING id",
  [trip.id, trip.participant, amount, incurred, status, trip.user.id])).rows[0].id;
const tripPay = async (trip, { kind, claimId = null, amount, source }) => (await pool.query(
  'INSERT INTO trip_payments(trip_id, participant_id, kind, claim_id, amount_minor, currency, reference, source, recorded_by) VALUES ($1,$2,$3,$4,$5,\'INR\',\'UTR-1\',$6,$7) RETURNING id',
  [trip.id, trip.participant, kind, claimId, amount, source, owner.id])).rows[0].id;

test('travel: approved claims are payables, paid ones settle, rejected ones are not posted, external payments post once and a void reverses', async () => {
  const team = must(await api('POST', '/teams', { token: owner.token, body: { name: `Travellers ${++n}`, sport: 'cricket' } }), 201);
  await pool.query('UPDATE teams SET organisation_id=$2 WHERE id=$1', [team.id, org.id]);
  const tripA = await mkTrip({ organisationId: org.id });     // organisation on the trip itself
  const tripB = await mkTrip({ teamId: team.id });            // organisation reached through the team
  const tripX = await mkTrip({ organisationId: other.id });   // another organisation's trip
  const c1 = await claim(tripA, 5000, 'approved');
  const c2 = await claim(tripA, 3000, 'approved');
  const c3 = await claim(tripA, 2000, 'rejected');
  const c4 = await claim(tripA, 1500, 'submitted');
  const c5 = await claim(tripB, 1000, 'approved');
  const cx = await claim(tripX, 7000, 'approved');

  await reconcile();
  for (const id of [c1, c2, c5]) {
    const r = await row(`obl:trip_claim:${id}`);
    assert.ok(r, `claim ${id} posted`); assert.equal(r.kind, 'charge'); assert.equal(r.status, 'open'); assert.equal(r.source_module, 'travel'); assert.equal(r.category, 'travel'); assert.equal(r.payer_org_id, org.id);
  }
  assert.equal((await row(`obl:trip_claim:${c1}`)).gross_minor, 5000);
  for (const id of [c3, c4]) assert.equal(await row(`obl:trip_claim:${id}`), undefined, 'rejected and unapproved claims are not posted');
  assert.equal((await row(`obl:trip_claim:${cx}`)).payer_org_id, other.id, 'another organisation\'s claim belongs to that organisation only');
  let s = await sum();
  assert.equal(head(s).payable, 9000, 'three approved claims are owed');
  assert.equal(cat(s, 'travel').payable ?? 9000, 9000);
  const age = must(await api('GET', '/finance/ageing', { token: owner.token, query: q() })).currencies.find((c) => c.currency === 'INR');
  assert.equal(age.payable.total, 9000);
  const list = must(await api('GET', '/finance/obligations', { token: owner.token, query: q({ direction: 'out' }) }));
  assert.equal(list.length, 3); assert.ok(list.every((x) => x.source_type === 'trip_claim'));
  assert.deepEqual(new Set(list.map((x) => x.source_id)), new Set([c1, c2, c5]));

  // payments recorded outside the app: a reimbursement of c1, a loose advance, and a budget-sourced advance that the event spend step owns
  const pReimb = await tripPay(tripA, { kind: 'reimbursement', claimId: c1, amount: 5000, source: 'external_record' });
  const pAdv = await tripPay(tripA, { kind: 'advance', amount: 2000, source: 'external_record' });
  const pBudget = await tripPay(tripA, { kind: 'advance', amount: 800, source: 'event_budget' });
  const run = await reconcile();
  assert.equal(run.synced.trip_payments, 2);
  assert.equal(await row(`receipt:trip_payment:${pBudget}`), undefined, 'event budget payments are not posted by the travel step');
  const reimb = await row(`receipt:trip_payment:${pReimb}`);
  assert.equal(reimb.kind, 'payment'); assert.equal(reimb.status, 'settled'); assert.equal(reimb.source_type, 'trip_claim'); assert.equal(reimb.source_id, c1);
  assert.equal(reimb.source_module, 'travel'); assert.equal(reimb.payer_org_id, org.id); assert.equal(reimb.payee_id, tripA.user.id); assert.equal(reimb.gross_minor, 5000);
  const adv = await row(`receipt:trip_payment:${pAdv}`);
  assert.equal(adv.source_type, 'trip_payment'); assert.equal(adv.source_id, pAdv); assert.equal(adv.status, 'settled');
  assert.equal((await row(`obl:trip_claim:${c1}`)).status, 'settled', 'a paid claim is settled');
  assert.equal((await row(`obl:trip_claim:${c2}`)).status, 'open');
  s = await sum();
  assert.equal(head(s).payable, 4000, 'c2 and c5 are still owed');
  assert.equal(head(s).spend, 7000, 'reimbursement and advance are spend of the organisation');
  assert.equal(cat(s, 'travel').spend, 7000);
  assert.equal(head(s).gross, 0, 'spend is never income');

  // idempotent
  const again = await reconcile();
  assert.equal(again.synced.trip_payments + again.synced.obligations, 0);
  assert.equal((await rows('receipt:trip_payment:%')).length, 2);

  // voiding the advance reverses it; voiding the reimbursement reverses it and re-opens the claim
  await pool.query('UPDATE trip_payments SET voided_at=now(), voided_by=$2 WHERE id=$1', [pAdv, owner.id]);
  await pool.query('UPDATE trip_payments SET voided_at=now(), voided_by=$2 WHERE id=$1', [pReimb, owner.id]);
  const v = await reconcile();
  assert.equal(v.synced.trip_payments, 0, 'a reversal posts nothing new');
  assert.equal((await row(`receipt:trip_payment:${pAdv}`)).status, 'reversed');
  assert.equal((await row(`receipt:trip_payment:${pReimb}`)).status, 'reversed');
  assert.equal((await row(`obl:trip_claim:${c1}`)).status, 'open');
  s = await sum();
  assert.equal(head(s).spend, 0); assert.equal(head(s).payable, 9000);
  assert.equal((await rows('receipt:trip_payment:%')).length, 2, 'reversed rows are kept');
});

test('front desk: cash, terminal and bank tenders post once, refunds go out, online and pending tenders are ignored', async () => {
  const venue = (await pool.query("INSERT INTO venues(name, owner_id, organisation_id) VALUES ($1,$2,$3) RETURNING id", [`Desk Venue ${++n}`, owner.id, org.id])).rows[0];
  const customer = await signup();
  const sale = (await pool.query(
    "INSERT INTO pos_sales(venue_id, cashier_id, customer_id, currency, status, subtotal_cents, tax_cents, total_cents, paid_at) VALUES ($1,$2,$3,'INR','paid',10000,1800,11800,now()) RETURNING id",
    [venue.id, owner.id, customer.id])).rows[0];
  const tender = async (kind, method, status, amount, ref = 'REF-1') => (await pool.query(
    "INSERT INTO pos_sale_payments(sale_id, kind, method, status, amount_cents, reference, recorded_by, confirmed_at) VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $4 = 'confirmed' THEN now() END) RETURNING id",
    [sale.id, kind, method, status, amount, ref, owner.id])).rows[0].id;
  const cash = await tender('payment', 'cash', 'confirmed', 5900, null);
  const upi = await tender('payment', 'upi_manual', 'confirmed', 5900);
  const pendingCash = await tender('payment', 'cash', 'pending', 700, null);
  const onlineRefund = await tender('refund', 'online', 'confirmed', 300);
  const cashRefund = await tender('refund', 'cash', 'confirmed', 1180, null);

  const run = await reconcile();
  assert.equal(run.synced.pos, 3);
  const c = await row(`receipt:pos_sale_payment:${cash}`);
  assert.equal(c.kind, 'payment'); assert.equal(c.status, 'settled'); assert.equal(c.provider, 'cash'); assert.equal(c.gross_minor, 5900); assert.equal(c.tax_minor, 900);
  assert.equal(c.payee_org_id, org.id); assert.equal(c.payee_id, owner.id); assert.equal(c.payer_id, customer.id); assert.equal(c.source_type, 'pos_sale'); assert.equal(c.source_id, sale.id); assert.equal(c.source_module, 'venue');
  const u = await row(`receipt:pos_sale_payment:${upi}`);
  assert.equal(u.provider, 'upi_manual'); assert.equal(u.tax_minor, 900);
  const r = await row(`refund:pos_sale_payment:${cashRefund}`);
  assert.equal(r.kind, 'refund'); assert.equal(r.provider, 'cash'); assert.equal(r.gross_minor, 1180); assert.equal(r.tax_minor, 180); assert.equal(r.payee_org_id, org.id);
  assert.equal(await row(`receipt:pos_sale_payment:${pendingCash}`), undefined, 'pending tender is not money yet');
  assert.equal(await row(`refund:pos_sale_payment:${onlineRefund}`), undefined, 'online tenders are posted from payments');
  assert.equal(await row(`receipt:pos_sale_payment:${onlineRefund}`), undefined);

  const s = await sum();
  assert.equal(head(s).gross, 11800, 'organisation gross includes the cash and bank tenders');
  const again = await reconcile();
  assert.equal(again.synced.pos, 0, 'posted once');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM fin_transactions WHERE source_type='pos_sale' AND source_id=$1", [sale.id])).rows[0].n, 3);

  // the pending tender is confirmed at the till: it now posts, once
  await pool.query("UPDATE pos_sale_payments SET status='confirmed', confirmed_at=now() WHERE id=$1", [pendingCash]);
  assert.equal((await reconcile()).synced.pos, 1);
  assert.equal((await row(`receipt:pos_sale_payment:${pendingCash}`)).gross_minor, 700);
});

test('wallet: a venue invoice paid from the wallet posts once; returned credit posts only the difference', async () => {
  const venue = (await pool.query("INSERT INTO venues(name, owner_id, organisation_id) VALUES ($1,$2,$3) RETURNING id", [`Wallet Venue ${++n}`, owner.id, org.id])).rows[0];
  const payer = await signup();
  const sale = (await pool.query("INSERT INTO pos_sales(venue_id, cashier_id, currency, status, total_cents) VALUES ($1,$2,'INR','awaiting_payment',10000) RETURNING id", [venue.id, owner.id])).rows[0];
  const inv = (await pool.query(
    `INSERT INTO invoices(number, venue_id, pos_sale_id, user_id, currency, total_cents, tax_cents, tax_name, tax_rate_bp, tax_inclusive, seller, lines)
     VALUES ($1,$2,$3,$4,'INR',10000,1000,'GST',1000,true,'{}'::jsonb,'[]'::jsonb) RETURNING id`, [`WAL-${Date.now()}-${++n}`, venue.id, sale.id, payer.id])).rows[0];
  const ic = (await pool.query("INSERT INTO invoice_credits(invoice_id, user_id, source, amount_cents) VALUES ($1,$2,'wallet',4000) RETURNING id", [inv.id, payer.id])).rows[0];

  const gross0 = head(await sum()).gross;
  let run = await reconcile();
  assert.equal(run.synced.wallet, 1);
  const p = await row(`receipt:invoice_credit:${ic.id}`);
  assert.equal(p.kind, 'payment'); assert.equal(p.status, 'settled'); assert.equal(p.provider, 'wallet'); assert.equal(p.source_module, 'wallet'); assert.equal(p.gross_minor, 4000); assert.equal(p.tax_minor, 400);
  assert.equal(p.source_type, 'venue_invoice'); assert.equal(p.source_id, inv.id); assert.equal(p.payee_org_id, org.id); assert.equal(p.payer_id, payer.id);
  let s = await sum();
  assert.equal(head(s).gross - gross0, 4000);
  run = await reconcile();
  assert.equal(run.synced.wallet, 0, 'repeated runs post nothing');

  const refunds = async () => (await pool.query("SELECT gross_minor::int AS g, idem_key, meta FROM fin_transactions WHERE kind='refund' AND meta->>'invoice_credit_id' = $1 ORDER BY idem_key", [ic.id])).rows;
  await pool.query('UPDATE invoice_credits SET returned_cents=1500 WHERE id=$1', [ic.id]);
  run = await reconcile();
  assert.equal(run.synced.wallet, 1);
  let rf = await refunds();
  assert.equal(rf.length, 1); assert.equal(rf[0].g, 1500); assert.equal(rf[0].meta.invoice_credit_id, ic.id);
  assert.equal((await reconcile()).synced.wallet, 0);

  await pool.query('UPDATE invoice_credits SET returned_cents=2500 WHERE id=$1', [ic.id]);
  assert.equal((await reconcile()).synced.wallet, 1);
  rf = await refunds();
  assert.equal(rf.length, 2); assert.deepEqual(rf.map((x) => x.g).sort((a, b) => a - b), [1000, 1500]);
  assert.equal(rf.reduce((t, x) => t + x.g, 0), 2500, 'refunds add up to what was returned');
  assert.equal((await reconcile()).synced.wallet, 0);
  assert.equal((await rows('receipt:invoice_credit:%')).length, 1, 'the payment was posted once');
});
