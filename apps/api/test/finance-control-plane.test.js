import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Finance control plane, organisation edition (#593): every figure the organisation sees must reconcile to the source workflows it came from.
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp', PLATFORM_ADMIN_EMAILS: 'rraja.edge@gmail.com,rrajas1978@icloud.com', PAYMENT_CURRENCY: 'INR',
});
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { blindIndex } = await import('../src/crypto.js');
const fin = await import('../src/finance.js');

let server, base, n = 0, boss, owner, outsider, org, other;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `fcp_${n}_${roles[0]}`, display_name: `Fin ${n}`, email: `fcp${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const dayOf = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const reconcile = async () => must(await api('POST', '/admin/finance/reconcile', { token: boss.token, body: {} }), 200);
const q = (extra = {}) => ({ organisation_id: org.id, ...extra });
const sum = async (token, extra = {}) => must(await api('GET', '/finance/summary', { token, query: q(extra) }));
const head = (s, cur = 'INR') => s.currencies.find((c) => c.currency === cur) ?? { gross: 0, receivable: 0, payable: 0, spend: 0, by_category: [] };
const cat = (s, c, cur = 'INR') => head(s, cur).by_category.find((x) => x.category === c) ?? { gross: 0, receivable: 0, spend: 0 };
const addMember = (orgId, userId, role) => pool.query("INSERT INTO organisation_members(organisation_id, user_id, role, status) VALUES ($1,$2,$3,'active')", [orgId, userId, role]);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  boss = await signup();
  await pool.query("UPDATE users SET roles='{athlete,admin,platform_admin}', email_idx=$2 WHERE id=$1", [boss.id, blindIndex('rraja.edge@gmail.com')]);
  owner = await signup(); outsider = await signup();
  org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Finance Org ${++n}`, kind: 'academy' } }), 201);
  other = must(await api('POST', '/organisations', { token: outsider.token, body: { name: `Other Org ${++n}`, kind: 'academy' } }), 201);
});
after(async () => { server.close(); await pool.end(); });

/** a team of the organisation with `players` members, and a dues round raised with a due date `dueOffset` days from today */
const raise = async (players, amount, dueOffset) => {
  const team = must(await api('POST', '/teams', { token: owner.token, body: { name: `Falcons ${++n}`, sport: 'cricket' } }), 201);
  await pool.query('UPDATE teams SET organisation_id=$2 WHERE id=$1', [team.id, org.id]);
  for (let k = 0; k < players; k++) must(await api('POST', `/teams/${team.id}/members`, { token: owner.token, body: { user_id: (await signup()).id } }), 201);
  const made = must(await api('POST', `/teams/${team.id}/charges`, { token: owner.token, body: { kind: 'season_fee', title: `Season ${n}`, amount_minor: amount, due_on: dayOf(dueOffset), idempotency_key: `k${n}${Date.now()}` } }), 201);
  assert.equal(made.charges_raised, players);
  return { team, charges: (await pool.query('SELECT * FROM team_charges WHERE team_id=$1 ORDER BY created_at, id', [team.id])).rows };
};

test('unpaid team charges become canonical receivables with dimensions, and ageing reconciles to the dashboard', async () => {
  await pool.query("INSERT INTO org_seasons(organisation_id, name, starts_on, ends_on) VALUES ($1,'This season',$2,$3)", [org.id, dayOf(-300), dayOf(300)]);
  const { team, charges } = await raise(2, 150000, -45);
  const run = await reconcile();
  assert.equal(run.synced.obligations, 2);
  const rows = (await pool.query("SELECT * FROM fin_transactions WHERE idem_key LIKE 'obl:team_charge:%' AND team_id=$1", [team.id])).rows;
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.kind, 'charge'); assert.equal(r.status, 'open'); assert.equal(r.category, 'registration'); assert.equal(r.payee_org_id, org.id);
    assert.ok(r.season_id, 'season filled from the organisation season'); assert.equal(String(r.due_on).slice(0, 10) === dayOf(-45) || r.due_on.toISOString().slice(0, 10) === dayOf(-45), true);
  }
  const s = await sum(owner.token);
  assert.equal(head(s).receivable, 300000, 'dashboard receivable = what the two members still owe');
  assert.equal(cat(s, 'registration').receivable, 300000);
  const age = must(await api('GET', '/finance/ageing', { token: owner.token, query: q() }));
  const a = age.currencies.find((c) => c.currency === 'INR');
  assert.equal(a.receivable.total, head(s).receivable, 'ageing total = dashboard receivable');
  assert.equal(a.receivable.buckets.d31_60, 300000, '45 days past due lands in 31-60');
  assert.equal(a.payable.total, 0);
  // drill from the bucket to the source workflow
  const list = must(await api('GET', '/finance/obligations', { token: owner.token, query: q({ bucket: 'd31_60', direction: 'in' }) }));
  assert.equal(list.length, 2); assert.equal(list.reduce((t, x) => t + x.outstanding_minor, 0), 300000);
  assert.deepEqual(new Set(list.map((x) => x.source_id)), new Set(charges.map((c) => c.id)));
  assert.ok(list.every((x) => x.source_type === 'team_charge' && x.overdue && x.days_overdue >= 45));
  // the same figures filtered by team, by season and by category; another team shows nothing
  assert.equal(head(await sum(owner.token, { team_ids: team.id })).receivable, 300000);
  assert.equal(head(await sum(owner.token, { season_ids: rows[0].season_id, categories: 'registration' })).receivable, 300000);
  assert.equal(head(await sum(owner.token, { team_ids: '00000000-0000-4000-8000-000000000000' })).receivable, 0);
  assert.equal(head(await sum(owner.token, { categories: 'sponsorship' })).receivable, 0);
});

test('cash received by a manager reconciles: partial then full, receipts post once, status follows the source', async () => {
  const { team, charges } = await raise(1, 100000, 10);
  await reconcile();
  const [c1] = charges;
  const before = head(await sum(owner.token, { team_ids: team.id }));
  assert.equal(before.receivable, 100000);
  must(await api('POST', `/team-charges/${c1.id}/payments`, { token: owner.token, body: { amount_minor: 40000, method: 'cash', idempotency_key: `cash-first-${n}` } }));
  let run = await reconcile();
  assert.equal(run.synced.receipts, 1);
  let s = head(await sum(owner.token, { team_ids: team.id }));
  assert.equal(s.gross, 40000, 'the cash shows as income');
  assert.equal(s.receivable, 60000, 'receivable nets what was received for the same source');
  const age = must(await api('GET', '/finance/ageing', { token: owner.token, query: q({ team_ids: team.id }) }));
  assert.equal(age.currencies[0].receivable.total, 60000);
  assert.equal(age.currencies[0].receivable.buckets.current, 60000, 'not yet due');
  must(await api('POST', `/team-charges/${c1.id}/payments`, { token: owner.token, body: { amount_minor: 60000, method: 'upi', idempotency_key: `upi-second-${n}` } }));
  run = await reconcile();
  assert.equal(run.synced.receipts, 1);
  s = head(await sum(owner.token, { team_ids: team.id }));
  assert.equal(s.gross, 100000); assert.equal(s.receivable, 0);
  assert.equal((await pool.query('SELECT status FROM fin_transactions WHERE idem_key=$1', [`obl:team_charge:${c1.id}`])).rows[0].status, 'settled');
  // idempotent: nothing is posted twice
  run = await reconcile();
  assert.equal(run.synced.receipts + run.synced.obligations + run.synced.spend, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM fin_transactions WHERE source_id=$1 AND kind='payment'", [c1.id])).rows[0].n, 2);
  // every canonical row traces back to its source and ledger key
  const tx = must(await api('GET', '/finance/transactions', { token: owner.token, query: q({ team_ids: team.id, kind: 'payment' }) }));
  assert.equal(tx.length, 2); assert.ok(tx.every((t) => t.source_type === 'team_charge' && t.source_id === c1.id && t.ledger_key.startsWith('receipt:team_charge_entry:')));
});

test('registration instalments and event budget spend land on the ledger; a voided payment is reversed, not removed', async () => {
  // a registration instalment owed to the organisation
  const u = await signup();
  const prog = (await pool.query("INSERT INTO rx_programmes(kind, title, owner_id, organisation_id, currency) VALUES ('membership','Club membership',$1,$2,'INR') RETURNING id", [owner.id, org.id])).rows[0];
  const entry = (await pool.query('INSERT INTO rx_entries(programme_id, version, submitted_by, participant_id, total_cents, currency) VALUES ($1,1,$2,$2,80000,\'INR\') RETURNING id', [prog.id, u.id])).rows[0];
  const inst = (await pool.query("INSERT INTO rx_instalments(entry_id, seq, due_on, amount_cents, currency) VALUES ($1,1,$2,80000,'INR') RETURNING id", [entry.id, dayOf(5)])).rows[0];
  // an event with a budget and a vendor payment
  const ev = must(await api('POST', '/events', { token: owner.token, body: { name: `Cup ${++n}`, sport: 'football', starts_on: dayOf(1), ends_on: dayOf(3) } }), 201);
  await pool.query('UPDATE events SET organisation_id=$2 WHERE id=$1', [ev.id, org.id]);
  await pool.query("INSERT INTO event_budgets(event_id, currency) VALUES ($1,'INR')", [ev.id]);
  const line = (await pool.query("INSERT INTO event_budget_lines(event_id, direction, category, name, planned_cents) VALUES ($1,'expense','venue','Ground hire',90000) RETURNING id", [ev.id])).rows[0];
  const bp = (await pool.query("INSERT INTO event_budget_payments(event_id, line_id, amount_cents, method, reference) VALUES ($1,$2,45000,'bank','UTR1') RETURNING id", [ev.id, line.id])).rows[0];
  const run = await reconcile();
  assert.ok(run.synced.spend >= 1);
  const base0 = await sum(owner.token, { event_ids: ev.id });
  assert.equal(head(base0).spend, 45000, 'event budget payment is spend of the organisation');
  assert.equal(cat(base0, 'event_budget').spend, 45000);
  assert.equal(head(base0).gross, 0, 'spend is never counted as income');
  const ob = (await pool.query("SELECT * FROM fin_transactions WHERE idem_key=$1", [`obl:registration_instalment:${inst.id}`])).rows[0];
  assert.equal(ob.status, 'open'); assert.equal(ob.payee_org_id, org.id);
  // the platform view does not mistake the organisation's own spend for revenue
  const plat = must(await api('GET', '/finance/summary', { token: boss.token }));
  assert.equal(plat.currencies.find((c) => c.currency === 'INR')?.by_module.find((m) => m.module === 'events')?.gross ?? 0, 0);
  // a voided payment is reversed on the ledger
  await pool.query("UPDATE event_budget_payments SET voided_at=now(), void_reason='entered twice' WHERE id=$1", [bp.id]);
  await reconcile();
  assert.equal((await pool.query('SELECT status FROM fin_transactions WHERE idem_key=$1', [`ebp:${bp.id}`])).rows[0].status, 'reversed');
  assert.equal(head(await sum(owner.token, { event_ids: ev.id })).spend, 0);
  // the instalment is paid outside the app: the obligation settles and the receipt posts once
  await pool.query("UPDATE rx_instalments SET status='paid', paid_at=now() WHERE id=$1", [inst.id]);
  const r2 = await reconcile();
  assert.equal(r2.synced.receipts, 1);
  assert.equal((await pool.query('SELECT status FROM fin_transactions WHERE idem_key=$1', [`obl:registration_instalment:${inst.id}`])).rows[0].status, 'settled');
  const ob2 = (await pool.query("SELECT sum(gross_minor)::int AS g FROM fin_transactions WHERE source_type='registration_instalment' AND source_id=$1 AND kind='payment'", [inst.id])).rows[0];
  assert.equal(ob2.g, 80000);
});

test('the ledger stays append-only and the new dimensions cannot be used to rewrite money', async () => {
  const r = (await pool.query("SELECT id FROM fin_transactions WHERE kind='charge' LIMIT 1")).rows[0];
  await assert.rejects(pool.query('UPDATE fin_transactions SET gross_minor = gross_minor + 1 WHERE id=$1', [r.id]), /cannot be edited/);
  await assert.rejects(pool.query('DELETE FROM fin_transactions WHERE id=$1', [r.id]), /append-only/);
});

test('permissioned finance access: levels, 404 for outsiders, grants take effect live and keep history', async () => {
  const coach = await signup(), viewer = await signup(), acct = await signup(), fin = await signup();
  await addMember(org.id, coach.id, 'coach');
  await addMember(org.id, fin.id, 'finance');
  assert.equal((await api('GET', '/finance/summary', { token: outsider.token, query: q() })).status, 404, 'outsiders learn nothing');
  assert.equal((await api('GET', '/finance/summary', { token: coach.token, query: q() })).status, 403, 'a member without a finance level is refused');
  assert.equal((await api('GET', '/finance/summary', { token: fin.token, query: q() })).status, 200, 'finance role keeps its access');
  assert.equal((await api('GET', '/finance/transactions/export', { token: fin.token, query: q() })).status, 200, 'and its export');
  // only a controller grants
  assert.equal((await api('POST', '/finance/access', { token: fin.token, body: { organisation_id: org.id, user_id: viewer.id, level: 'viewer' } })).status, 403);
  assert.equal((await api('POST', '/finance/access', { token: outsider.token, body: { organisation_id: org.id, user_id: viewer.id, level: 'viewer' } })).status, 404);
  must(await api('POST', '/finance/access', { token: owner.token, body: { organisation_id: org.id, user_id: viewer.id, level: 'viewer' } }));
  must(await api('POST', '/finance/access', { token: owner.token, body: { organisation_id: org.id, user_id: acct.id, level: 'accountant' } }));
  assert.equal((await api('POST', '/finance/access', { token: owner.token, body: { organisation_id: org.id, user_id: owner.id, level: 'viewer' } })).status, 409, 'owners keep full control');
  // viewer reads but cannot export, close items or read the audit history
  assert.equal((await api('GET', '/finance/summary', { token: viewer.token, query: q() })).status, 200);
  assert.equal((await api('GET', '/finance/transactions/export', { token: viewer.token, query: q() })).status, 403);
  assert.equal((await api('GET', '/finance/audit', { token: viewer.token, query: { organisation_id: org.id } })).status, 403);
  assert.equal((await api('POST', '/finance/reconciliation/00000000-0000-4000-8000-000000000000/resolve', { token: viewer.token, body: { organisation_id: org.id, reason: 'checked the bank statement' } })).status, 403);
  // an accountant exports with provenance that verifies against the file
  const ex = must(await api('GET', '/finance/transactions/export', { token: acct.token, query: q({ kind: 'payment' }) }));
  assert.ok(ex.rows >= 3);
  assert.equal(ex.manifest.sha256, createHash('sha256').update(ex.csv).digest('hex'));
  assert.equal(ex.manifest.organisation_id, org.id); assert.equal(ex.manifest.generated_by, acct.id); assert.equal(ex.manifest.rows, ex.rows);
  const cols = ex.csv.split('\n')[0].split(',');
  for (const c of ['source_type', 'source_id', 'ledger_key', 'category', 'event_id', 'team_id', 'season_id']) assert.ok(cols.includes(c), `export keeps ${c}`);
  assert.equal((await api('POST', '/finance/reconciliation/00000000-0000-4000-8000-000000000000/resolve', { token: acct.token, body: { organisation_id: org.id, reason: 'checked the bank statement' } })).status, 404, 'unknown item');
  // revoking takes effect on the next call, and the grant stays as history
  must(await api('POST', '/finance/access', { token: owner.token, body: { organisation_id: org.id, user_id: viewer.id, level: 'none' } }));
  assert.equal((await api('GET', '/finance/summary', { token: viewer.token, query: q() })).status, 404);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM fin_finance_access WHERE user_id=$1 AND status='revoked'", [viewer.id])).rows[0].n, 1);
  const people = must(await api('GET', '/finance/access', { token: owner.token, query: { organisation_id: org.id } }));
  assert.ok(people.members.some((m) => m.user_id === owner.id && m.level === 'controller') && people.grants.some((g) => g.user_id === acct.id && g.level === 'accountant') && !people.grants.some((g) => g.user_id === viewer.id));
  // the audit history shows who exported and who changed access
  const trail = must(await api('GET', '/finance/audit', { token: owner.token, query: { organisation_id: org.id, limit: 100 } }));
  const actions = trail.map((t) => t.action);
  assert.ok(actions.includes('export_finance_transactions') && actions.includes('set_finance_access'), actions.join(','));
});

test('organisations never see each other, and the settlements view is scoped', async () => {
  const mine = must(await api('GET', '/finance/transactions', { token: owner.token, query: q({ limit: 5 }) }));
  assert.ok(mine.length);
  assert.equal((await api('GET', `/finance/transactions/${mine[0].id}`, { token: outsider.token, query: { organisation_id: other.id } })).status, 404, 'a transaction of another organisation is a 404');
  assert.equal((await api('GET', '/finance/ageing', { token: outsider.token, query: { organisation_id: other.id } })).body.currencies.length, 0);
  assert.equal((await api('GET', '/finance/obligations', { token: outsider.token, query: { organisation_id: org.id } })).status, 404);
  const st = must(await api('GET', '/finance/settlements', { token: owner.token, query: q() }));
  assert.deepEqual(st.items, []);
  assert.equal((await api('GET', '/finance/summary', { token: owner.token })).status, 403, 'the whole-platform view is for the platform admin only');
  assert.equal((await api('GET', '/finance/summary', { token: boss.token })).status, 200);
});

test('every module is mapped to a canonical category, and the ledger key identifies each source', async () => {
  for (const m of Object.keys(fin.MODULE_LABEL)) assert.ok(fin.CATEGORY_LABEL[fin.categoryOf(m)], `${m} has a category`);
  const keys = (await pool.query("SELECT idem_key FROM fin_transactions WHERE idem_key LIKE 'obl:%' OR idem_key LIKE 'receipt:%' OR idem_key LIKE 'ebp:%'")).rows;
  assert.ok(keys.length >= 6);
  assert.equal(new Set(keys.map((k) => k.idem_key)).size, keys.length);
});
