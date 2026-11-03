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
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `fpc_${n}_${roles[0]}`, display_name: `Ppl ${n}`, email: `fpc${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
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
const makeContract = async (o, payee, { team = null, event = null, terms = null } = {}) => {
  const c = (await pool.query("INSERT INTO player_contracts(contract_no, team_id, event_id, payee_id, title, currency, created_by) VALUES ($1,$2,$3,$4,'Season deal','INR',$5) RETURNING id", [`C-${randomUUID()}`, team?.id ?? null, event?.id ?? null, payee.id, o.owner.id])).rows[0];
  if (terms !== null) await pool.query("INSERT INTO player_contract_versions(contract_id, version, kind, status, starts_on, ends_on, effective_from, currency, pay_terms_days, proposed_by) VALUES ($1,1,'initial','in_force',$2,$3,$2,'INR',$4,$5)", [c.id, dayOf(-30), dayOf(300), terms, o.owner.id]);
  return c;
};
const makeRun = async (o, team, status = 'approved') => (await pool.query("INSERT INTO player_payout_runs(run_no, team_id, currency, as_of, status, prepared_by, approved_by, approved_at, approval_basis) VALUES ($1,$2,'INR',$3,$4,$5,$5,now(),'sole_authority') RETURNING id", [`R-${randomUUID()}`, team.id, dayOf(-1), status, o.owner.id])).rows[0];
const makeLine = async (runId, contract, payee, gross, withheld = 0, status = 'ready') => (await pool.query("INSERT INTO player_payout_lines(run_id, contract_id, payee_id, gross_cents, withheld_cents, net_cents, status) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id", [runId, contract.id, payee.id, gross, withheld, gross - withheld, status])).rows[0];
const makeExpense = async (contract, payee, amount, status = 'approved', { line = null, decided = new Date() } = {}) =>
  (await pool.query("INSERT INTO player_contract_expenses(contract_id, payee_id, category, incurred_on, amount_cents, currency, status, decided_at, run_line_id) VALUES ($1,$2,'travel',$3,$4,'INR',$5,$6,$7) RETURNING id", [contract.id, payee.id, dayOf(-3), amount, status, status === 'submitted' ? null : decided, line])).rows[0];
const entry = async (contract, payee, kind, amount) => (await pool.query("INSERT INTO player_contract_entries(contract_id, payee_id, currency, kind, amount_cents, occurred_on, label, idem_key) VALUES ($1,$2,'INR',$3,$4,current_date,$5,$6) RETURNING id", [contract.id, payee.id, kind, amount, `${kind} entry`, `k-${randomUUID()}`])).rows[0];
const creditNote = async (contract, payee, amount, issuedOffset = 0) => {
  const cn = (await pool.query("INSERT INTO player_contract_invoices(number, scope_key, kind, contract_id, payee_id, currency, gross_cents, withheld_cents, net_cents, status, issued_at) VALUES ($1,$2,'credit_note',$3,$4,'INR',$5,0,$5,'issued',$6) RETURNING id", [`CN-${randomUUID()}`, `s-${randomUUID()}`, contract.id, payee.id, -amount, new Date(Date.now() + issuedOffset * 86400000)])).rows[0];
  await entry(contract, payee, 'adjustment', -amount);
  return cn;
};

test('expenses: approved and not yet on a payout line is a payable of the team organisation with due date from the contract terms; other statuses are not posted', async () => {
  const club = await newOrg('Club');
  const team = await makeTeam(club), ev = await makeEvent(club);
  const p = await signup(), q = await signup();
  const withTerms = await makeContract(club, p, { team, terms: 14 });
  const noTerms = await makeContract(club, q, { event: ev });
  const decided = new Date(Date.now() - 2 * 86400000);
  const a = await makeExpense(withTerms, p, 12000, 'approved', { decided });
  const b = await makeExpense(noTerms, q, 8000, 'approved', { decided });
  const skipped = [];
  for (const s of ['submitted', 'declined', 'withdrawn']) skipped.push(await makeExpense(withTerms, p, 1000, s));

  await reconcile();
  const ra = await byKey(`obl:player_contract_expense:${a.id}`), rb = await byKey(`obl:player_contract_expense:${b.id}`);
  assert.equal(ra.kind, 'charge'); assert.equal(ra.status, 'open'); assert.equal(ra.source_module, 'contracts'); assert.equal(ra.category, 'contracts');
  assert.equal(ra.payer_org_id, club.org.id); assert.equal(ra.payee_id, p.id); assert.equal(Number(ra.gross_minor), 12000); assert.equal(ra.team_id, team.id); assert.equal(ra.event_id, null);
  assert.equal(String(ra.due_on instanceof Date ? ra.due_on.toISOString().slice(0, 10) : ra.due_on).slice(0, 10), new Date(decided.getTime() + 14 * 86400000).toISOString().slice(0, 10), 'decided date + contract pay terms');
  assert.equal(rb.payer_org_id, club.org.id); assert.equal(rb.event_id, ev.id); assert.equal(rb.team_id, null); assert.equal(rb.payee_id, q.id);
  assert.equal(rb.due_on instanceof Date ? rb.due_on.toISOString().slice(0, 10) : String(rb.due_on).slice(0, 10), new Date(decided.getTime() + 7 * 86400000).toISOString().slice(0, 10), 'default terms are 7 days');
  for (const s of skipped) assert.equal(await byKey(`obl:player_contract_expense:${s.id}`), undefined);
  assert.equal(head(await sum(club)).payable, 20000);
  assert.equal((await ageing(club)).payable.total, 20000);

  const before = await total();
  await reconcile();
  assert.equal(await total(), before, 'no double posting');

  // reimbursed leaves the payable
  await pool.query("UPDATE player_contract_expenses SET status='reimbursed', paid_at=now() WHERE id=$1", [a.id]);
  await reconcile();
  assert.notEqual((await byKey(`obl:player_contract_expense:${a.id}`)).status, 'open');
  assert.equal(head(await sum(club)).payable, 8000);
});

test('expenses on a payout line: the line carries them (no double count); a cancelled run or failed line brings the expense back; a draft run keeps it open', async () => {
  const club = await newOrg('Club');
  const team = await makeTeam(club);
  const p = await signup();
  const contract = await makeContract(club, p, { team });
  const run = await makeRun(club, team);
  const line = await makeLine(run.id, contract, p, 100000, 10000);
  const x = await makeExpense(contract, p, 20000);
  const obl = () => byKey(`obl:player_contract_expense:${x.id}`);

  await reconcile();
  assert.equal((await obl()).status, 'open');
  assert.equal(head(await sum(club)).payable, 120000, 'before linking: line + loose expense');

  await pool.query('UPDATE player_contract_expenses SET run_line_id=$2 WHERE id=$1', [x.id, line.id]);
  await reconcile();
  assert.equal((await obl()).status, 'cancelled');
  let s = await sum(club);
  assert.equal(head(s).payable, 100000, 'only the line gross');
  assert.equal((await ageing(club)).payable.total, 100000);
  assert.equal(cat(s, 'contracts').payable, 100000);
  const before = await total();
  await reconcile();
  assert.equal(await total(), before, 'idempotent');

  // a failed line returns the expense
  await pool.query("UPDATE player_payout_lines SET status='failed' WHERE id=$1", [line.id]);
  await reconcile();
  assert.equal((await obl()).status, 'open');
  await pool.query("UPDATE player_payout_lines SET status='ready' WHERE id=$1", [line.id]);
  await reconcile();
  assert.equal((await obl()).status, 'cancelled');

  // a cancelled run returns it, and the run's own line is cancelled
  await pool.query("UPDATE player_payout_runs SET status='cancelled' WHERE id=$1", [run.id]);
  await reconcile();
  assert.equal((await obl()).status, 'open');
  assert.equal((await byKey(`obl:player_payout_line:${line.id}`)).status, 'cancelled');
  s = await sum(club);
  assert.equal(head(s).payable, 20000);
  assert.equal((await ageing(club)).payable.total, 20000);

  // a draft run keeps the expense open (the line is not posted yet)
  const club2 = await newOrg('Club');
  const team2 = await makeTeam(club2), p2 = await signup();
  const c2 = await makeContract(club2, p2, { team: team2 });
  const draft = await makeRun(club2, team2, 'draft');
  const dl = await makeLine(draft.id, c2, p2, 50000);
  const x2 = await makeExpense(c2, p2, 5000, 'approved', { line: dl.id });
  await reconcile();
  assert.equal((await byKey(`obl:player_contract_expense:${x2.id}`)).status, 'open');
  assert.equal(await byKey(`obl:player_payout_line:${dl.id}`), undefined);
  assert.equal(head(await sum(club2)).payable, 5000);

  // reimbursed is not open
  await pool.query("UPDATE player_contract_expenses SET status='reimbursed', paid_at=now() WHERE id=$1", [x2.id]);
  await reconcile();
  assert.notEqual((await byKey(`obl:player_contract_expense:${x2.id}`)).status, 'open');
  assert.equal(head(await sum(club2)).payable, 0);
});

test('credit notes: a receivable of the club from the player; netting settles without income, cash repayment settles as income, partial keeps the remainder ageing', async () => {
  // netting
  const club = await newOrg('Club');
  const team = await makeTeam(club), p = await signup();
  const contract = await makeContract(club, p, { team });
  const cn = await creditNote(contract, p, 30000);
  await reconcile();
  const r = await byKey(`obl:player_contract_credit_note:${cn.id}`);
  assert.equal(r.kind, 'charge'); assert.equal(r.status, 'open'); assert.equal(r.source_module, 'contracts'); assert.equal(r.payee_org_id, club.org.id); assert.equal(r.payer_id, p.id); assert.equal(Number(r.gross_minor), 30000); assert.equal(r.team_id, team.id);
  assert.ok(r.due_on, 'has a due date');
  let s = await sum(club);
  assert.equal(head(s).receivable, 30000);
  let age = await ageing(club);
  assert.equal(age.receivable.total, 30000);
  assert.equal(age.payable.total, 0);
  const list = await obligations(club, 'in');
  assert.deepEqual(list.map((x) => x.source_id), [cn.id]);
  const grossBefore = head(s).gross;

  await entry(contract, p, 'fee', 30000); // a later payout reduces it: balance back to 0 with no cash
  await reconcile();
  assert.equal((await byKey(`obl:player_contract_credit_note:${cn.id}`)).status, 'settled');
  const net = await byKey(`crn:player_contract_credit_note:${cn.id}:30000`);
  assert.ok(net); assert.equal(net.kind, 'credit_note'); assert.equal(net.status, 'settled'); assert.equal(Number(net.gross_minor), 30000);
  assert.equal(await count("source_type='player_contract_credit_note' AND kind='payment' AND source_id=$1", [cn.id]), 0);
  s = await sum(club);
  assert.equal(head(s).gross, grossBefore, 'netting is not income');
  assert.equal(head(s).receivable, 0);
  assert.equal((await ageing(club)).receivable.total, 0);
  const before = await total();
  await reconcile();
  assert.equal(await total(), before);

  // cash repayment, partial then full
  const club2 = await newOrg('Club');
  const team2 = await makeTeam(club2), p2 = await signup();
  const c2 = await makeContract(club2, p2, { team: team2 });
  const cn2 = await creditNote(c2, p2, 50000);
  await reconcile();
  await entry(c2, p2, 'refund', 20000);
  await reconcile();
  assert.equal((await byKey(`obl:player_contract_credit_note:${cn2.id}`)).status, 'open');
  const part = await byKey(`receipt:player_contract_credit_note:${cn2.id}:20000`);
  assert.ok(part); assert.equal(part.kind, 'payment'); assert.equal(part.provider, 'offline'); assert.equal(Number(part.gross_minor), 20000);
  s = await sum(club2);
  assert.equal(head(s).gross, 20000, 'cash repayment is income of the club');
  assert.equal(head(s).receivable, 30000);
  assert.equal((await ageing(club2)).receivable.total, 30000, 'the remainder ages');
  await entry(c2, p2, 'refund', 30000);
  await reconcile();
  assert.equal((await byKey(`obl:player_contract_credit_note:${cn2.id}`)).status, 'settled');
  assert.equal(await count("source_type='player_contract_credit_note' AND kind='payment' AND status='settled' AND source_id=$1", [cn2.id]), 2);
  s = await sum(club2);
  assert.equal(head(s).gross, 50000); assert.equal(head(s).receivable, 0);
  assert.equal((await ageing(club2)).receivable.total, 0);
  const again = await total();
  await reconcile();
  assert.equal(await total(), again);
  assert.equal(await count("source_type='player_contract_credit_note' AND kind='credit_note' AND source_id=$1", [cn2.id]), 0);

  // two notes on one contract clear oldest first
  const club3 = await newOrg('Club');
  const team3 = await makeTeam(club3), p3 = await signup();
  const c3 = await makeContract(club3, p3, { team: team3 });
  const old = await creditNote(c3, p3, 30000, -10), recent = await creditNote(c3, p3, 20000, -1);
  await entry(c3, p3, 'refund', 30000);
  await reconcile();
  assert.equal((await byKey(`obl:player_contract_credit_note:${old.id}`)).status, 'settled');
  assert.equal((await byKey(`obl:player_contract_credit_note:${recent.id}`)).status, 'open');
  assert.ok(await byKey(`receipt:player_contract_credit_note:${old.id}:30000`));
  assert.equal(await count("source_type='player_contract_credit_note' AND kind='payment' AND source_id=$1", [recent.id]), 0);
  assert.equal(head(await sum(club3)).receivable, 20000);
  assert.equal((await ageing(club3)).receivable.total, 20000);
});

test('withholding: payout-line obligations and receipts carry withheld_minor, never tax_minor', async () => {
  const club = await newOrg('Club');
  const team = await makeTeam(club), p = await signup();
  const contract = await makeContract(club, p, { team });
  const run = await makeRun(club, team);
  const line = await makeLine(run.id, contract, p, 80000, 8000);
  await reconcile();
  const o = await byKey(`obl:player_payout_line:${line.id}`);
  assert.equal(Number(o.tax_minor), 0); assert.equal(Number(o.withheld_minor), 8000);
  await pool.query("UPDATE player_payout_lines SET status='paid', paid_at=now(), reference=$2 WHERE id=$1", [line.id, `UTR-${randomUUID()}`]);
  await reconcile();
  const rc = await byKey(`receipt:player_payout_line:${line.id}:80000`);
  assert.ok(rc); assert.equal(Number(rc.tax_minor), 0); assert.equal(Number(rc.withheld_minor), 8000);
});
