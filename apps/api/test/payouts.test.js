// One payout path (#701): officials fees, venue settlements and seller balances in the same batch flow.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';

const fake = { transfers: [], reject: false };
const stripe = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString(), send = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
  if (req.url === '/v1/transfers' && req.method === 'POST') {
    const f = new URLSearchParams(raw), key = req.headers['idempotency-key'];
    const seen = fake.transfers.find((t) => t.key === key);
    if (seen) return send(200, { id: seen.id });
    if (fake.reject) return send(400, { error: { message: 'No such destination' } });
    const t = { id: `tr_${fake.transfers.length + 1}`, key, amount: Number(f.get('amount')), destination: f.get('destination') };
    fake.transfers.push(t);
    return send(200, { id: t.id });
  }
  send(404, {});
});
await new Promise((r) => stripe.listen(0, '127.0.0.1', r));
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_API_BASE: `http://127.0.0.1:${stripe.address().port}`,
  STRIPE_WEBHOOK_SECRET: 'whsec_test', SETTLEMENT_PAYOUTS: 'on', SETTLEMENT_CURRENCIES: 'INR', PAYMENT_CURRENCY: 'INR', PLATFORM_APPROVALS: 'off',
});
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { encrypt, decrypt } = await import('../src/crypto.js');
const { balances } = await import('../src/settlement.js');
const { backfillPartnerAccounts } = await import('../src/payouts.js');

let server, base, n = 0, maker, checker, sport;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const user = async (roles = ['athlete']) => { n++; const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ($1,$1,$2,'x','x',$1) RETURNING id", [`po_${n}`, roles])).rows[0]; return { id: row.id, token: await signToken({ id: row.id, roles }) }; };
/** a verified payout account for a payee (the account itself is covered by settlement.test.js) */
const account = async (owner, extra = {}) => (await pool.query("INSERT INTO payout_accounts(owner_id, currency, details_enc, last4, status) VALUES ($1,'INR',$2,'4321','verified') RETURNING id",
  [owner.id, encrypt(JSON.stringify({ holder_name: 'Pat Payee', account_number: 'SECRET-ACCT-4321', bank_code: 'HDFC0001', ...extra }), 'payout_accounts.details')])).rows[0].id;
const earn = (seller, cents) => pool.query("INSERT INTO provider_ledger(seller_id, currency, kind, amount_cents, gross_cents, idempotency_key) VALUES ($1,'INR','sale',$2,$2,$3)", [seller.id, cents, `t-${seller.id}-${Math.random()}`]);
/** an accepted official with a fee the organiser marked due */
async function dueFee(official, fee = 10000) {
  const org = await user(['organizer']);
  const ev = (await pool.query('INSERT INTO events(name, sport_id, organizer_id) VALUES ($1,$2,$3) RETURNING id', [`Cup ${n}`, sport, org.id])).rows[0];
  const fx = (await pool.query('INSERT INTO fixtures(event_id, scheduled_at) VALUES ($1, now()) RETURNING id', [ev.id])).rows[0];
  return (await pool.query("INSERT INTO fixture_officials(fixture_id, user_id, role, status, fee_minor, fee_currency, pay_status) VALUES ($1,$2,'referee','accepted',$3,'INR','due') RETURNING id", [fx.id, official.id, fee])).rows[0].id;
}
async function approvedSettlement(owner, net = 50000) {
  const venue = (await pool.query('INSERT INTO venues(name, owner_id) VALUES ($1,$2) RETURNING id', [`Arena ${n}`, owner.id])).rows[0];
  const partner = (await pool.query("INSERT INTO partners(code, name, owner_id) VALUES ($1,$1,$2) RETURNING id", [`P${n}${Date.now()}`, owner.id])).rows[0];
  const contract = (await pool.query("INSERT INTO partner_contracts(contract_no, partner_id, terms, body, body_sha256, effective_from) VALUES ($1,$2,'{}','x','x',current_date) RETURNING id", [`C${n}${Date.now()}`, partner.id])).rows[0];
  return (await pool.query("INSERT INTO settlements(settlement_no, partner_id, venue_id, contract_id, currency, period_end, commission_bp, net_payable_cents, status) VALUES ($1,$2,$3,$4,'INR',current_date,0,$5,'approved') RETURNING id", [`S${n}${Date.now()}`, partner.id, venue.id, contract.id, net])).rows[0].id;
}
const batch = (u, items, extra = {}) => api('POST', '/admin/payout-batches', { token: u.token, body: { currency: 'INR', client_key: `key-${Math.random()}`, items, ...extra } });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  sport = (await pool.query('SELECT id FROM sports LIMIT 1')).rows[0].id;
  server = createApp().listen(0); base = `http://127.0.0.1:${server.address().port}`;
  maker = await user(['admin']); checker = await user(['admin']);
});
after(async () => { server.close(); stripe.close(); await pool.end(); });

test('an officials fee is paid through a batch: maker-checker, bank file, result links the pay log, finance ledger posted', async () => {
  const ref = await user(['referee']); await account(ref);
  const fo = await dueFee(ref, 10000);
  must(await api('POST', '/admin/payout-settings/INR', { token: maker.token, body: { currency: 'INR', withholding_bp: 1000, fee_flat_minor: 100 } }));
  const due = must(await api('GET', '/admin/payouts/obligations', { token: maker.token, query: { source: 'official_fee' } }));
  assert.ok(due.some((d) => d.source_id === fo && d.blocker === null));
  const b = must(await batch(maker, [{ source_type: 'official_fee', source_id: fo }]), 201);
  assert.deepEqual([b.gross_minor, b.tax_minor, b.fee_minor, b.net_minor].map(Number), [10000, 1000, 100, 8900]);
  assert.equal(JSON.stringify(b).includes('SECRET-ACCT'), false, 'no bank details in the batch view');
  assert.equal((await api('POST', `/admin/payout-batches/${b.id}/export`, { token: maker.token })).status, 409, 'not approved yet');
  assert.equal((await api('POST', `/admin/payout-batches/${b.id}/approve`, { token: maker.token })).status, 409, 'the maker cannot approve their own batch');
  assert.equal(must(await api('POST', `/admin/payout-batches/${b.id}/approve`, { token: checker.token })).approval_basis, 'second_person');
  const file = must(await api('POST', `/admin/payout-batches/${b.id}/export`, { token: maker.token }));
  assert.match(file.csv, /SECRET-ACCT-4321/);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='read_payout_account' AND actor_id=$1", [maker.id])).rowCount >= 1, 'decrypt audit-logged');
  assert.ok(!(await pool.query('SELECT details_enc FROM payout_accounts WHERE owner_id=$1', [ref.id])).rows[0].details_enc.includes('SECRET'), 'encrypted at rest');
  const item = b.items[0];
  assert.equal((await api('POST', `/admin/payout-items/${item.id}/result`, { token: maker.token, body: { outcome: 'paid' } })).status, 400, 'reference required');
  must(await api('POST', `/admin/payout-items/${item.id}/result`, { token: maker.token, body: { outcome: 'paid', reference: 'UTR-OFF-1' } }));
  assert.equal(must(await api('POST', `/admin/payout-items/${item.id}/result`, { token: maker.token, body: { outcome: 'paid', reference: 'UTR-OFF-1' } })).replayed, true, 'idempotent');
  const row = (await pool.query('SELECT pay_status, payout_item_id FROM fixture_officials WHERE id=$1', [fo])).rows[0];
  assert.deepEqual([row.pay_status, row.payout_item_id], ['paid', item.id]);
  assert.equal((await pool.query('SELECT payout_item_id FROM fixture_official_pay_log WHERE fixture_official_id=$1 AND to_status=$2', [fo, 'paid'])).rows[0].payout_item_id, item.id, 'the pay log links the payout');
  const fin = (await pool.query("SELECT status, gross_minor, tax_minor, withheld_minor, fee_minor, net_minor, source_module FROM fin_transactions WHERE source_type='payout_item' AND source_id=$1", [item.id])).rows[0];
  assert.deepEqual([fin.status, Number(fin.gross_minor), Number(fin.tax_minor), Number(fin.withheld_minor), Number(fin.net_minor), fin.source_module], ['settled', 10000, 0, 1000, 8900, 'officials']);   // withholding is its own amount, never tax
  assert.equal(must(await api('GET', `/admin/payout-batches/${b.id}`, { token: maker.token })).status, 'closed');
  const mine = must(await api('GET', '/me/payout-items', { token: ref.token }));
  assert.equal(mine.length, 1);
  assert.match(must(await api('GET', '/me/payout-items', { token: ref.token, query: { format: 'csv' } })).csv, /UTR-OFF-1/);
  assert.equal((await api('GET', `/payout-items/${item.id}`, { token: maker.token })).status, 404, 'only the payee sees an item');
  // the same fee cannot be paid again, and the old shortcuts are closed
  assert.equal((await batch(maker, [{ source_type: 'official_fee', source_id: fo }])).status, 409);
  const org = (await pool.query('SELECT e.organizer_id FROM fixture_officials fo JOIN fixtures f ON f.id=fo.fixture_id JOIN events e ON e.id=f.event_id WHERE fo.id=$1', [fo])).rows[0].organizer_id;
  assert.equal((await api('POST', `/official-assignments/${fo}/fee`, { token: await signToken({ id: org, roles: ['organizer'] }), body: { fee_minor: 10000, currency: 'INR', status: 'paid' } })).status, 409);
  await pool.query('DELETE FROM payout_settings');
});

test('a venue settlement is paid through the batch and linked; mark_paid is retired', async () => {
  const owner = await user(['venue_owner']); await account(owner);
  const st = await approvedSettlement(owner, 50000);
  const b = must(await batch(maker, [{ source_type: 'venue_settlement', source_id: st }]), 201);
  must(await api('POST', `/admin/payout-batches/${b.id}/approve`, { token: checker.token }));
  must(await api('POST', `/admin/payout-batches/${b.id}/export`, { token: checker.token }));
  must(await api('POST', `/admin/payout-items/${b.items[0].id}/result`, { token: checker.token, body: { outcome: 'paid', reference: 'UTR-VEN-1' } }));
  const s = (await pool.query('SELECT status, payout_ref, payout_item_id FROM settlements WHERE id=$1', [st])).rows[0];
  assert.deepEqual([s.status, s.payout_ref, s.payout_item_id], ['paid', 'UTR-VEN-1', b.items[0].id]);
  assert.equal((await api('POST', `/admin/settlements/${st}/decision`, { token: maker.token, body: { action: 'mark_paid', payout_ref: 'X-REF-1' } })).status, 409);
  assert.equal((await api('POST', `/admin/payout-items/${b.items[0].id}/result`, { token: maker.token, body: { outcome: 'paid', reference: 'UTR-VEN-2' } })).status, 409, 'a paid item is final');
  const st2 = await approvedSettlement(owner, 100);
  await pool.query("UPDATE settlements SET net_payable_cents=-100 WHERE id=$1", [st2]);
  assert.equal((await batch(maker, [{ source_type: 'venue_settlement', source_id: st2 }])).status, 409, 'an amount owed to the platform is not payable');
});

test('a payout can never exceed the reconciled balance: concurrent batches pay a seller once', async () => {
  const seller = await user(['supplier']); await account(seller); await earn(seller, 70000);
  const results = await Promise.all(Array.from({ length: 6 }, () => batch(maker, [{ source_type: 'provider_balance', payee_id: seller.id }])));
  assert.equal(results.filter((r) => r.status === 201).length, 1, JSON.stringify(results.map((r) => r.status)));
  assert.ok(results.filter((r) => r.status !== 201).every((r) => r.status === 409));
  const bal = (await balances(seller.id)).find((b) => b.currency === 'INR');
  assert.equal(bal.available_cents, 0);
  assert.equal(bal.payout_in_progress_cents, 70000);
  assert.equal(bal.reconciles, true);
  const ok = results.find((r) => r.status === 201).body;
  must(await api('POST', `/admin/payout-batches/${ok.id}/approve`, { token: checker.token }));
  must(await api('POST', `/admin/payout-batches/${ok.id}/export`, { token: maker.token }));
  must(await api('POST', `/admin/payout-items/${ok.items[0].id}/result`, { token: maker.token, body: { outcome: 'paid', reference: 'UTR-BAL-1' } }));
  const after = (await balances(seller.id)).find((b) => b.currency === 'INR');
  assert.deepEqual([after.paid_out_cents, after.payable_cents, after.available_cents], [70000, 0, 0]);
  assert.equal((await batch(maker, [{ source_type: 'provider_balance', payee_id: seller.id }])).status, 409, 'nothing left to pay');
  // a balance that does not reconcile is refused
  const odd = await user(['supplier']); await account(odd); await earn(odd, 5000);
  await pool.query("UPDATE payout_accounts SET status='verified' WHERE owner_id=$1", [odd.id]);
  assert.equal(must(await api('POST', '/admin/payouts/reconcile', { token: maker.token })).findings, 0);
});

test('idempotent batches; failure returns the money; retry is a new attempt and never double pays', async () => {
  const seller = await user(['supplier']); await account(seller); await earn(seller, 30000);
  const body = { currency: 'INR', client_key: 'idem-key-0001', items: [{ source_type: 'provider_balance', payee_id: seller.id }] };
  const a = must(await api('POST', '/admin/payout-batches', { token: maker.token, body }), 201);
  const again = must(await api('POST', '/admin/payout-batches', { token: maker.token, body }), 201);
  assert.equal(again.id, a.id); assert.equal(again.replayed, true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM payout_items WHERE batch_id=$1', [a.id])).rows[0].n, 1);
  must(await api('POST', `/admin/payout-batches/${a.id}/approve`, { token: checker.token }));
  must(await api('POST', `/admin/payout-batches/${a.id}/export`, { token: maker.token }));
  const failed = must(await api('POST', `/admin/payout-items/${a.items[0].id}/result`, { token: maker.token, body: { outcome: 'failed', failure_code: 'bank_rejected', reason: 'The bank refused the credit' } }));
  assert.equal(failed.items[0].status, 'failed'); assert.equal(failed.items[0].explanation.title.length > 0, true);
  assert.equal((await balances(seller.id)).find((b) => b.currency === 'INR').available_cents, 30000, 'money returned to the balance');
  assert.ok((await pool.query("SELECT 1 FROM settlement_exceptions WHERE kind='payout_failed' AND status='open' AND detail->>'payout_item_id'=$1", [a.items[0].id])).rowCount);
  const retried = must(await api('POST', `/admin/payout-items/${a.items[0].id}/retry`, { token: checker.token }));
  assert.equal(retried.items[0].attempt, 2); assert.equal(retried.status, 'approved');
  assert.equal(must(await api('POST', `/admin/payout-items/${a.items[0].id}/retry`, { token: checker.token })).replayed, true, 'retry twice = one attempt');
  assert.equal((await balances(seller.id)).find((b) => b.currency === 'INR').available_cents, 0);
  must(await api('POST', `/admin/payout-batches/${a.id}/export`, { token: maker.token }));
  must(await api('POST', `/admin/payout-items/${a.items[0].id}/result`, { token: maker.token, body: { outcome: 'paid', reference: 'UTR-RETRY-1' } }));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM provider_ledger WHERE seller_id=$1 AND kind='payout'", [seller.id])).rows[0].n, 2, 'two debits, one reversal: net one payout');
  assert.equal((await balances(seller.id)).find((b) => b.currency === 'INR').paid_out_cents, 30000);
  assert.equal((await api('POST', `/admin/payout-items/${a.items[0].id}/retry`, { token: checker.token })).status, 409, 'a paid item cannot be retried');
  // the old single-payout result path refuses a batch-owned payout
  const po = (await pool.query('SELECT id FROM provider_payouts WHERE seller_id=$1 ORDER BY created_at LIMIT 1', [seller.id])).rows[0].id;
  assert.equal((await api('POST', `/admin/provider-payouts/${po}/result`, { token: maker.token, body: { outcome: 'paid', reference: 'ZZZ-OLD-1' } })).status, 409);
});

test('cancel returns balances; threshold and sole authority; payee cannot approve or export own batch', async () => {
  const seller = await user(['supplier']); await account(seller); await earn(seller, 12000);
  const c = must(await batch(maker, [{ source_type: 'provider_balance', payee_id: seller.id }]), 201);
  must(await api('POST', `/admin/payout-batches/${c.id}/cancel`, { token: maker.token, body: { reason: 'Wrong period' } }));
  assert.equal((await balances(seller.id)).find((b) => b.currency === 'INR').available_cents, 12000);
  assert.equal(must(await api('GET', `/admin/payout-batches/${c.id}`, { token: maker.token })).items[0].status, 'cancelled');
  assert.equal((await api('POST', `/admin/payout-batches/${c.id}/approve`, { token: checker.token })).status, 409);
  must(await api('POST', '/admin/payout-settings/INR', { token: maker.token, body: { currency: 'INR', approval_threshold_minor: 20000 } }));
  const small = must(await batch(maker, [{ source_type: 'provider_balance', payee_id: seller.id }]), 201);
  assert.equal(must(await api('POST', `/admin/payout-batches/${small.id}/approve`, { token: maker.token })).approval_basis, 'below_threshold');
  must(await api('POST', `/admin/payout-batches/${small.id}/cancel`, { token: maker.token, body: { reason: 'Test cleanup' } }));
  await pool.query('DELETE FROM payout_settings');
  const sellerAdmin = await user(['admin']); await account(sellerAdmin); await earn(sellerAdmin, 9000);
  assert.equal((await batch(sellerAdmin, [{ source_type: 'provider_balance', payee_id: sellerAdmin.id }])).status, 409, 'cannot pay yourself');
  assert.equal((await api('POST', '/admin/payout-batches', { token: (await user(['athlete'])).token, body: { currency: 'INR', client_key: 'no-access-1', items: [{ source_type: 'official_fee', source_id: (await user()).id }] } })).status, 403);
});

test('Stripe rail: transfer with the item key, rejection fails only that item, re-execute never pays twice', async () => {
  const good = await user(['supplier']); await account(good, { stripe_account_id: 'acct_good' }); await earn(good, 20000);
  const bad = await user(['supplier']); await account(bad); await earn(bad, 15000);
  const b = must(await batch(maker, [{ source_type: 'provider_balance', payee_id: good.id }, { source_type: 'provider_balance', payee_id: bad.id }], { rail: 'stripe' }), 201);
  assert.equal((await api('POST', `/admin/payout-batches/${b.id}/export`, { token: maker.token })).status, 409, 'a stripe batch has no bank file');
  must(await api('POST', `/admin/payout-batches/${b.id}/approve`, { token: checker.token }));
  const done = must(await api('POST', `/admin/payout-batches/${b.id}/execute`, { token: maker.token }));
  assert.equal(fake.transfers.length, 1); assert.equal(fake.transfers[0].destination, 'acct_good'); assert.equal(fake.transfers[0].amount, 20000);
  assert.deepEqual(done.items.map((i) => i.status).sort(), ['failed', 'paid']);
  assert.equal(done.status, 'closed');
  const failedItem = done.items.find((i) => i.status === 'failed');
  assert.equal(failedItem.failure_code, 'invalid_account');
  assert.equal((await api('POST', `/admin/payout-batches/${b.id}/execute`, { token: maker.token })).status, 409, 'a closed batch cannot be executed again');
  assert.equal(fake.transfers.length, 1, 'no second transfer');
  assert.equal((await balances(bad.id)).find((x) => x.currency === 'INR').available_cents, 15000, 'failed item returned to the balance');
});

const stripeSig = (payload) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${createHmac('sha256', 'whsec_test').update(`${t}.${payload}`).digest('hex')}`; };
const hook = (event) => { const body = JSON.stringify(event); return fetch(`${base}/api/v1/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': stripeSig(body), 'content-type': 'application/json' }, body }); };

test('Stripe webhooks: a lost synchronous result is settled by transfer.created once; a reversal opens an exception and never edits a paid item', async () => {
  const seller = await user(['supplier']); await account(seller, { stripe_account_id: 'acct_hook' }); await earn(seller, 8000);
  const b = must(await batch(maker, [{ source_type: 'provider_balance', payee_id: seller.id }], { rail: 'stripe' }), 201);
  must(await api('POST', `/admin/payout-batches/${b.id}/approve`, { token: checker.token }));
  await pool.query("UPDATE payout_batches SET status='executing' WHERE id=$1", [b.id]); // the provider accepted the transfer but we never heard back
  const itemId = b.items[0].id;
  const ev = (type, id, amount = 8000) => ({ id, type, data: { object: { id: `tr_hook_${id}`, amount, currency: 'inr', metadata: { payout_item_id: itemId } } } });
  assert.equal((await fetch(`${base}/api/v1/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': 't=1,v1=bad', 'content-type': 'application/json' }, body: '{}' })).status, 400, 'unsigned events are refused');
  assert.equal((await hook(ev('transfer.created', 'evt_wrong', 7999))).status, 200);
  assert.equal((await pool.query('SELECT status FROM payout_items WHERE id=$1', [itemId])).rows[0].status, 'pending', 'an amount that does not match settles nothing');
  assert.ok((await pool.query("SELECT 1 FROM settlement_exceptions WHERE detail->>'payout_item_id'=$1 AND status='open'", [itemId])).rowCount);
  assert.equal((await hook(ev('transfer.created', 'evt_ok'))).status, 200);
  assert.equal((await hook(ev('transfer.created', 'evt_ok'))).status, 200, 'a replay is harmless');
  assert.equal((await hook(ev('transfer.created', 'evt_ok_again'))).status, 200, 'a second event for a paid item is a no-op');
  const it = (await pool.query('SELECT status, reference, decided_by FROM payout_items WHERE id=$1', [itemId])).rows[0];
  assert.deepEqual([it.status, it.reference, it.decided_by], ['paid', 'tr_hook_evt_ok', null]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM fin_transactions WHERE source_id=$1 AND status='settled'", [seller.id])).rows[0].n >= 0, true);
  assert.equal((await balances(seller.id)).find((x) => x.currency === 'INR').paid_out_cents, 8000);
  assert.equal(must(await api('GET', `/admin/payout-batches/${b.id}`, { token: maker.token })).status, 'closed');
  assert.equal((await hook(ev('transfer.reversed', 'evt_rev'))).status, 200);
  assert.equal((await pool.query('SELECT status FROM payout_items WHERE id=$1', [itemId])).rows[0].status, 'paid', 'a reversal never rewrites a paid item');
  assert.ok((await pool.query("SELECT 1 FROM settlement_exceptions WHERE kind='payout_failed' AND dedupe_key LIKE 'payout_transfer_reversed:%' AND status='open'")).rowCount, 'a reversal is raised for the platform team');
});

test('payee PDF statement is the payee\'s alone; the organiser sees payout status read-only', async () => {
  const ref = await user(['referee']); await account(ref);
  const fo = await dueFee(ref, 20000);
  const orgId = (await pool.query('SELECT e.organizer_id FROM fixture_officials fo JOIN fixtures f ON f.id=fo.fixture_id JOIN events e ON e.id=f.event_id WHERE fo.id=$1', [fo])).rows[0].organizer_id;
  const evId = (await pool.query('SELECT f.event_id FROM fixture_officials fo JOIN fixtures f ON f.id=fo.fixture_id WHERE fo.id=$1', [fo])).rows[0].event_id;
  const org = { token: await signToken({ id: orgId, roles: ['organizer'] }) };
  assert.equal(must(await api('GET', `/events/${evId}/official-payouts`, { token: org.token }))[0].payout_status, null, 'due, not in a batch yet');
  assert.equal((await api('GET', `/events/${evId}/official-payouts`, { token: ref.token })).status, 403, 'only the organiser');
  const b = must(await batch(maker, [{ source_type: 'official_fee', source_id: fo }]), 201);
  assert.equal(must(await api('GET', `/events/${evId}/official-payouts`, { token: org.token }))[0].payout_status, 'pending');
  const pdf = (id, token) => fetch(`${base}/api/v1/payout-items/${id}/statement.pdf`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal((await pdf(b.items[0].id, ref.token)).status, 404, 'not available until it is paid');
  must(await api('POST', `/admin/payout-batches/${b.id}/approve`, { token: checker.token }));
  must(await api('POST', `/admin/payout-batches/${b.id}/export`, { token: maker.token }));
  must(await api('POST', `/admin/payout-items/${b.items[0].id}/result`, { token: maker.token, body: { outcome: 'paid', reference: 'UTR-PDF-1' } }));
  const ok = await pdf(b.items[0].id, ref.token);
  assert.equal(ok.status, 200); assert.equal(ok.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await ok.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
  assert.equal((await pdf(b.items[0].id, maker.token)).status, 404, 'staff are not the payee');
  assert.equal((await pdf(b.items[0].id, org.token)).status, 404, 'nor is the organiser');
  assert.equal((await pdf('not-an-id', ref.token)).status, 404);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='read_payout_statement' AND actor_id=$1", [ref.id])).rowCount);
  const row = must(await api('GET', `/events/${evId}/official-payouts`, { token: org.token }))[0];
  assert.deepEqual([row.payout_status, row.reference, row.pay_status], ['paid', 'UTR-PDF-1', 'paid']);
});

test('venue bank details are copied once into payout accounts as pending, re-encrypted, partner record untouched', async () => {
  const owner = await user(['venue_manager']);
  const enc = encrypt(JSON.stringify({ account_holder: 'Marine Arena Ltd', account_number: '9988776655', bank_code: 'ICIC0000042' }), 'partners.payout');
  const p = (await pool.query("INSERT INTO partners(code, name, owner_id, payout_enc, payout_last4) VALUES ($1,'MA',$2,$3,'6655') RETURNING id", [`BF${Date.now()}`, owner.id, enc])).rows[0];
  assert.ok(await backfillPartnerAccounts() >= 1);
  const a = (await pool.query('SELECT * FROM payout_accounts WHERE owner_id=$1', [owner.id])).rows;
  assert.equal(a.length, 1); assert.equal(a[0].status, 'pending'); assert.equal(a[0].last4, '6655');
  assert.equal(JSON.parse(decrypt(a[0].details_enc, 'payout_accounts.details')).account_number, '9988776655');
  assert.ok(!a[0].details_enc.includes('9988776655'));
  assert.equal((await pool.query('SELECT payout_enc FROM partners WHERE id=$1', [p.id])).rows[0].payout_enc, enc, 'the partner record is kept');
  await backfillPartnerAccounts();
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM payout_accounts WHERE owner_id=$1', [owner.id])).rows[0].n, 1, 'idempotent');
  await pool.query("UPDATE payout_accounts SET status='superseded' WHERE owner_id=$1", [owner.id]);
  await backfillPartnerAccounts();
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM payout_accounts WHERE owner_id=$1', [owner.id])).rows[0].n, 1, 'a superseded account is not resurrected');
});

test('REST, OpenAPI and MCP expose the payout capabilities; bank details are never in responses', async () => {
  const spec = await (await fetch(`${base}/api/v1/openapi.json`)).json();
  for (const op of ['create_payout_batch', 'approve_payout_batch', 'export_payout_batch', 'execute_payout_batch', 'record_payout_item_result', 'retry_payout_item', 'cancel_payout_batch', 'list_payable_obligations', 'reconcile_payouts'])
    assert.ok(Object.values(spec.paths).some((p) => Object.values(p).some((o) => o.operationId === op)), op);
  assert.equal(decrypt(encrypt('x', 'payout_accounts.details'), 'payout_accounts.details'), 'x');
  assert.equal((await api('GET', '/admin/payout-batches')).status, 401);
});
