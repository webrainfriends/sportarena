import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Finance control plane: people-money sources (#593) - agent commissions, player payout lines and official fees reach the canonical ledger
// from the module that owns them, idempotently, and the organisation's dashboard and ageing agree.
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp', PLATFORM_ADMIN_EMAILS: 'rraja.edge@gmail.com,rrajas1978@icloud.com', PAYMENT_CURRENCY: 'INR',
});
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { blindIndex } = await import('../src/crypto.js');

let server, base, n = 0, boss;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `fsp_${n}_${roles[0]}`, display_name: `Ppl ${n}`, email: `fsp${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const dayOf = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const reconcile = async () => must(await api('POST', '/admin/finance/reconcile', { token: boss.token, body: {} }), 200);
const newOrg = async (label) => { const owner = await signup(); const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `${label} ${++n}`, kind: 'academy' } }), 201); return { owner, org }; };
const sum = async (o, extra = {}) => must(await api('GET', '/finance/summary', { token: o.owner.token, query: { organisation_id: o.org.id, ...extra } }));
const head = (s, cur = 'INR') => s.currencies.find((c) => c.currency === cur) ?? { gross: 0, receivable: 0, payable: 0, spend: 0, by_category: [] };
const cat = (s, c, cur = 'INR') => head(s, cur).by_category.find((x) => x.category === c) ?? { gross: 0, receivable: 0, payable: 0, spend: 0 };
const ageing = async (o) => must(await api('GET', '/finance/ageing', { token: o.owner.token, query: { organisation_id: o.org.id } })).currencies.find((c) => c.currency === 'INR') ?? { receivable: { total: 0 }, payable: { total: 0 } };
const obligations = async (o, direction) => must(await api('GET', '/finance/obligations', { token: o.owner.token, query: { organisation_id: o.org.id, direction } }));
const byKey = async (key) => (await pool.query('SELECT * FROM fin_transactions WHERE idem_key=$1', [key])).rows[0];
const count = async (where, args = []) => (await pool.query(`SELECT count(*)::int AS n FROM fin_transactions WHERE ${where}`, args)).rows[0].n;
const total = async () => (await pool.query('SELECT count(*)::int AS n FROM fin_transactions')).rows[0].n;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  boss = await signup();
  await pool.query("UPDATE users SET roles='{athlete,admin,platform_admin}', email_idx=$2 WHERE id=$1", [boss.id, blindIndex('rraja.edge@gmail.com')]);
});
after(async () => { server.close(); await pool.end(); });

const makeTeam = async (o) => {
  const team = must(await api('POST', '/teams', { token: o.owner.token, body: { name: `Hawks ${++n}`, sport: 'cricket' } }), 201);
  await pool.query('UPDATE teams SET organisation_id=$2 WHERE id=$1', [team.id, o.org.id]);
  return team;
};
const makeEvent = async (o) => {
  const ev = must(await api('POST', '/events', { token: o.owner.token, body: { name: `Open ${++n}`, sport: 'football', starts_on: dayOf(1), ends_on: dayOf(3) } }), 201);
  await pool.query('UPDATE events SET organisation_id=$2 WHERE id=$1', [ev.id, o.org.id]);
  return ev;
};

test('agent commissions: statements are receivables of the agency, settled payments allocate oldest first, void cancels, refunds post, re-run is a no-op', async () => {
  const agency = await newOrg('Agency');
  const agentUser = agency.owner, athlete = await signup();
  const agent = (await pool.query("INSERT INTO agent_profiles(kind, user_id, organisation_id, display_name) VALUES ('agency',$1,$2,'Agency Rep') RETURNING id", [agentUser.id, agency.org.id])).rows[0];
  const mandate = (await pool.query('INSERT INTO representation_mandates(mandate_no, athlete_id, agent_id, created_by) VALUES ($1,$2,$3,$2) RETURNING id', [`M-${randomUUID()}`, athlete.id, agent.id])).rows[0];
  const deal = (await pool.query("INSERT INTO representation_deals(mandate_id, term_key, term_version, deal_type, deal_id, currency, proposed_by) VALUES ($1,'commission',1,'player_contract',$2,'INR',$3) RETURNING id", [mandate.id, randomUUID(), agentUser.id])).rows[0];
  const stmt = async (amount, issuedOffset, dueOffset) => (await pool.query("INSERT INTO representation_statements(statement_no, deal_id, currency, amount_cents, due_on, lines, sha256, issued_by, issued_at) VALUES ($1,$2,'INR',$3,$4,'[]','x',$5,$6) RETURNING id", [`S-${randomUUID()}`, deal.id, amount, dayOf(dueOffset), agentUser.id, new Date(Date.now() + issuedOffset * 86400000)])).rows[0];
  const entry = async (kind, amount, key) => (await pool.query("INSERT INTO representation_commission_entries(deal_id, currency, kind, amount_cents, idem_key) VALUES ($1,'INR',$2,$3,$4) RETURNING id", [deal.id, kind, amount, key])).rows[0];
  const A = await stmt(100000, -30, -20), B = await stmt(50000, -10, -5), C = await stmt(20000, -2, 10);
  const pay = await entry('payment_settled', 120000, 'pay-1');

  let run = await reconcile();
  assert.equal(run.synced.commissions, 5, '3 statements + 2 allocated receipts');
  for (const s of [A, B, C]) {
    const r = await byKey(`obl:representation_statement:${s.id}`);
    assert.equal(r.kind, 'charge'); assert.equal(r.source_module, 'agents'); assert.equal(r.category, 'commissions'); assert.equal(r.payee_org_id, agency.org.id); assert.equal(r.payer_id, athlete.id);
  }
  assert.equal((await byKey(`obl:representation_statement:${A.id}`)).status, 'settled', 'oldest statement is fully covered');
  assert.equal((await byKey(`obl:representation_statement:${B.id}`)).status, 'open', 'next one is only part covered');
  assert.equal((await byKey(`obl:representation_statement:${C.id}`)).status, 'open');
  const ra = await byKey(`receipt:representation_commission_entry:${pay.id}:${A.id}`), rb = await byKey(`receipt:representation_commission_entry:${pay.id}:${B.id}`);
  assert.equal(Number(ra.gross_minor), 100000); assert.equal(Number(rb.gross_minor), 20000);
  assert.ok(ra.kind === 'payment' && ra.status === 'settled' && rb.kind === 'payment');
  // the agency's receivable: B (50000 - 20000) + C (20000), nets receipts, and ageing agrees
  let s = await sum(agency);
  assert.equal(head(s).receivable, 50000);
  assert.equal(cat(s, 'commissions').receivable, 50000);
  let age = await ageing(agency);
  assert.equal(age.receivable.total, head(s).receivable, 'ageing total = dashboard receivable');
  const list = await obligations(agency, 'in');
  assert.equal(list.reduce((t, x) => t + x.outstanding_minor, 0), 50000);
  assert.ok(list.every((x) => x.source_type === 'representation_statement'));
  assert.deepEqual(new Set(list.map((x) => x.source_id)), new Set([B.id, C.id]));

  // idempotent
  const before = await total();
  run = await reconcile();
  assert.equal(run.synced.commissions, 0);
  assert.equal(await total(), before, 'nothing posted twice');

  // void the unpaid statement: it is cancelled and leaves the receivable
  await pool.query("UPDATE representation_statements SET status='void', voided_at=now(), void_reason='issued in error' WHERE id=$1", [C.id]);
  await reconcile();
  assert.equal((await byKey(`obl:representation_statement:${C.id}`)).status, 'cancelled');
  s = await sum(agency);
  assert.equal(head(s).receivable, 30000);
  assert.equal((await ageing(agency)).receivable.total, 30000);

  // a refund of settled commission posts a refund row once
  const ref = await entry('refund', -5000, 'refund-1');
  run = await reconcile();
  assert.equal(run.synced.commissions, 1);
  const rr = await byKey(`refund:representation_commission_entry:${ref.id}`);
  assert.equal(rr.kind, 'refund'); assert.equal(rr.status, 'settled'); assert.equal(Number(rr.gross_minor), 5000); assert.equal(rr.source_module, 'agents');
  assert.equal(rr.payer_id, agentUser.id); assert.equal(rr.payee_id, athlete.id);
  const again = await total();
  await reconcile();
  assert.equal(await total(), again);
  assert.equal(await count("source_type='representation_statement' AND kind='payment' AND source_id=$1", [A.id]), 1);
});

test('player payout lines: approved runs are payables of the team organisation, a paid line settles with a cumulative receipt, drafts are not posted', async () => {
  const club = await newOrg('Club');
  const team = await makeTeam(club), draftTeam = await makeTeam(club);
  const p1 = await signup(), p2 = await signup(), p3 = await signup();
  const contract = async (t, payee) => (await pool.query("INSERT INTO player_contracts(contract_no, team_id, payee_id, title, currency, created_by) VALUES ($1,$2,$3,'Season deal','INR',$4) RETURNING id", [`C-${randomUUID()}`, t.id, payee.id, club.owner.id])).rows[0];
  const approved = (await pool.query("INSERT INTO player_payout_runs(run_no, team_id, currency, as_of, status, prepared_by, approved_by, approved_at, approval_basis) VALUES ($1,$2,'INR',$3,'approved',$4,$4,now(),'sole_authority') RETURNING id", [`R-${randomUUID()}`, team.id, dayOf(-12), club.owner.id])).rows[0];
  const draft = (await pool.query("INSERT INTO player_payout_runs(run_no, team_id, currency, as_of, status, prepared_by) VALUES ($1,$2,'INR',$3,'draft',$4) RETURNING id", [`R-${randomUUID()}`, draftTeam.id, dayOf(-12), club.owner.id])).rows[0];
  const line = async (runId, t, payee, gross, withheld, status = 'ready') => (await pool.query("INSERT INTO player_payout_lines(run_id, contract_id, payee_id, gross_cents, withheld_cents, net_cents, status, paid_at, reference) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
    [runId, (await contract(t, payee)).id, payee.id, gross, withheld, gross - withheld, status, status === 'paid' ? new Date() : null, status === 'paid' ? `UTR-${randomUUID()}` : null])).rows[0];
  const open = await line(approved.id, team, p1, 100000, 10000);
  const paid = await line(approved.id, team, p2, 50000, 5000, 'paid');
  const inDraft = await line(draft.id, draftTeam, p3, 70000, 0);

  let run = await reconcile();
  assert.equal(run.synced.obligations, 2, 'only the two lines of the approved run');
  assert.equal(await byKey(`obl:player_payout_line:${inDraft.id}`), undefined, 'a draft run is not posted');
  const o1 = await byKey(`obl:player_payout_line:${open.id}`), o2 = await byKey(`obl:player_payout_line:${paid.id}`);
  for (const [r, who] of [[o1, p1], [o2, p2]]) {
    assert.equal(r.kind, 'charge'); assert.equal(r.source_module, 'contracts'); assert.equal(r.payer_org_id, club.org.id); assert.equal(r.payee_id, who.id); assert.equal(r.team_id, team.id);
  }
  assert.equal(o1.status, 'open'); assert.equal(Number(o1.gross_minor), 100000); assert.equal(Number(o1.tax_minor), 0, 'withholding is not tax'); assert.equal(Number(o1.withheld_minor), 10000, 'withheld is its own amount');
  assert.equal(o2.status, 'settled'); assert.equal(Number(o2.tax_minor), 0); assert.equal(Number(o2.withheld_minor), 5000);
  const rc = await byKey(`receipt:player_payout_line:${paid.id}:50000`);
  assert.ok(rc, 'the paid line posts a cumulative receipt'); assert.equal(rc.kind, 'payment'); assert.equal(rc.status, 'settled'); assert.equal(Number(rc.gross_minor), 50000); assert.equal(Number(rc.tax_minor), 0); assert.equal(Number(rc.withheld_minor), 5000);
  assert.equal(await count("source_type='player_payout_line' AND kind='payment' AND source_id=$1", [open.id]), 0);

  let s = await sum(club);
  assert.equal(head(s).payable, 100000, 'the club still owes the open line');
  assert.equal(cat(s, 'contracts').payable, 100000);
  assert.equal((await ageing(club)).payable.total, 100000);
  const list = await obligations(club, 'out');
  assert.deepEqual(list.map((x) => x.source_id), [open.id]);
  assert.equal(list[0].outstanding_minor, 100000);

  const before = await total();
  run = await reconcile();
  assert.equal(run.synced.obligations + run.synced.receipts, 0);
  assert.equal(await total(), before);

  // the open line is paid: it settles and its receipt posts once
  await pool.query("UPDATE player_payout_lines SET status='paid', paid_at=now(), reference=$2 WHERE id=$1", [open.id, `UTR-${randomUUID()}`]);
  run = await reconcile();
  assert.equal(run.synced.receipts, 1);
  assert.equal((await byKey(`obl:player_payout_line:${open.id}`)).status, 'settled');
  assert.ok(await byKey(`receipt:player_payout_line:${open.id}:100000`));
  assert.equal(head(await sum(club)).payable, 0);
  assert.equal((await ageing(club)).payable.total, 0);
  const again = await total();
  await reconcile();
  assert.equal(await total(), again);
  // the draft run stays out until it is approved
  await pool.query("UPDATE player_payout_runs SET status='approved', approved_by=$2, approved_at=now(), approval_basis='sole_authority' WHERE id=$1", [draft.id, club.owner.id]);
  await reconcile();
  assert.ok(await byKey(`obl:player_payout_line:${inDraft.id}`));
});

test('official fees: due is a payable, paid directly settles with a receipt, paid through a payout batch settles with none, non-accepted is not posted', async () => {
  const org = await newOrg('Organiser');
  const ev = await makeEvent(org);
  const fixture = async () => (await pool.query("INSERT INTO fixtures(event_id, scheduled_at) VALUES ($1, now() + interval '2 days') RETURNING id", [ev.id])).rows[0];
  const official = async (user, fee, { status = 'accepted', pay = 'none', confirmed = null, item = null } = {}) =>
    (await pool.query("INSERT INTO fixture_officials(fixture_id, user_id, role, status, fee_minor, fee_currency, pay_status, pay_updated_at, pay_confirmed_at, payout_item_id) VALUES ($1,$2,'referee',$3,$4,'INR',$5,now(),$6,$7) RETURNING id",
      [(await fixture()).id, user.id, status, fee, pay, confirmed, item]))
      .rows[0];
  const [u1, u2, u3, u4, u5] = [await signup(), await signup(), await signup(), await signup(), await signup()];
  // the payout item behind the third fee
  const acct = (await pool.query("INSERT INTO payout_accounts(owner_id, currency, details_enc, last4, status) VALUES ($1,'INR','x','1234','verified') RETURNING id", [u3.id])).rows[0];
  const batch = (await pool.query("INSERT INTO payout_batches(currency, client_key, created_by, status) VALUES ('INR',$1,$2,'closed') RETURNING id", [`batch-${randomUUID()}`, boss.id])).rows[0];
  const feeC = randomUUID();
  const item = (await pool.query("INSERT INTO payout_items(batch_id, source_type, source_id, payee_id, account_id, currency, gross_minor, net_minor, status, idem_key, reference) VALUES ($1,'official_fee',$2,$3,$4,'INR',30000,30000,'paid',$5,$6) RETURNING id", [batch.id, feeC, u3.id, acct.id, `item-${randomUUID()}`, `UTR-${randomUUID()}`])).rows[0];

  const due = await official(u1, 10000, { pay: 'due' });
  const direct = await official(u2, 20000, { pay: 'paid', confirmed: new Date() });
  const viaBatch = await official(u3, 30000, { pay: 'paid', confirmed: new Date(), item: item.id });
  const invited = await official(u4, 40000, { status: 'invited', pay: 'due' });
  const agreed = await official(u5, 60000, { pay: 'agreed' });

  const run = await reconcile();
  assert.ok(run.synced.obligations >= 3);
  const rows = (await pool.query("SELECT * FROM fin_transactions WHERE source_type='official_fee' AND event_id=$1", [ev.id])).rows;
  assert.equal(await byKey(`obl:official_fee:${invited.id}`), undefined, 'a fee on a non-accepted assignment is not posted');
  assert.equal(await byKey(`obl:official_fee:${agreed.id}`), undefined, 'an agreed (not yet due) fee is not posted');
  const od = await byKey(`obl:official_fee:${due.id}`);
  assert.equal(od.kind, 'charge'); assert.equal(od.status, 'open'); assert.equal(od.source_module, 'officials'); assert.equal(od.payer_org_id, org.org.id); assert.equal(od.payee_id, u1.id); assert.equal(Number(od.gross_minor), 10000);
  assert.equal((await byKey(`obl:official_fee:${direct.id}`)).status, 'settled');
  assert.equal((await byKey(`obl:official_fee:${viaBatch.id}`)).status, 'settled');
  const rd = await byKey(`receipt:official_fee:${direct.id}:20000`);
  assert.ok(rd && rd.kind === 'payment' && rd.status === 'settled' && Number(rd.gross_minor) === 20000, 'paid directly adds a receipt');
  assert.equal(rows.filter((r) => r.kind === 'payment').length, 1, 'only the directly paid fee has a receipt');
  assert.equal(await count("source_type='official_fee' AND kind='payment' AND source_id=$1", [viaBatch.id]), 0, 'paid through a batch: the payout row is the money, no second receipt');
  assert.equal(await count("source_id=$1", [due.id]), 1);

  const s = await sum(org);
  assert.equal(head(s).payable, 10000, 'only the fee still due');
  assert.equal(cat(s, 'contracts').payable, 10000);
  assert.equal((await ageing(org)).payable.total, 10000);
  const list = await obligations(org, 'out');
  assert.deepEqual(list.map((x) => x.source_id), [due.id]);

  const before = await total();
  const again = await reconcile();
  assert.equal(again.synced.obligations + again.synced.receipts, 0);
  assert.equal(await total(), before);

  // the fee is marked paid directly: settles, receipt once; a withdrawn assignment cancels
  await pool.query("UPDATE fixture_officials SET pay_status='paid', pay_confirmed_at=now() WHERE id=$1", [due.id]);
  await reconcile();
  assert.equal((await byKey(`obl:official_fee:${due.id}`)).status, 'settled');
  assert.ok(await byKey(`receipt:official_fee:${due.id}:10000`));
  assert.equal(head(await sum(org)).payable, 0);
});
