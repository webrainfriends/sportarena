// Sponsorship budget controls (#293): authorized annual / program / department / event budgets, derived balances, concurrent-award safety,
// proposals-are-not-income, separate currencies unless a sourced rate is explicit, approval thresholds, release/reversal reconciliation,
// server-side isolation and the additive migration.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `bg_${n}_${roles[0]}`, display_name: `Budget ${n}`, email: `bg${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); return { ...r.body.user, token: r.body.token }; };
const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** A brand run by an organisation: owner (manager) plus approver, finance, auditor, evaluator and legal members. */
const brand = async () => {
  const owner = await signup(['sponsor']);
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Acme ${n}`, kind: 'company' } }), 201);
  const b = must(await api('POST', '/sponsors', { token: owner.token, body: { name: `Corp ${n}` } }), 201);
  must(await api('POST', `/organisations/${org.id}/assets`, { token: owner.token, body: { kind: 'sponsor', asset_id: b.id } }));
  const staff = {};
  for (const role of ['approver', 'finance', 'auditor', 'evaluator']) {
    const u = await signup(['athlete']);
    must(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role } }), 201);
    must(await api('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } }));
    staff[role] = u;
  }
  return { owner, org, b, staff };
};
const mkBudget = (w, body, token = w.owner.token) => api('POST', '/sponsorship-budgets', { token, body: { sponsor_id: w.b.id, currency: 'USD', ...body } });
const annual = async (w, cents = 100000, extra = {}) => must(await mkBudget(w, { kind: 'annual', name: `FY ${n}`, fiscal_year: 2030, authorized_cents: cents, ...extra }), 201);
const get = async (w, id, token = w.owner.token) => must(await api('GET', `/sponsorship-budgets/${id}`, { token }));
const program = async (w, { budget, currency = 'USD', cents = 100000 } = {}) => {
  let p = must(await api('POST', '/sponsorship-programs', { token: w.owner.token, body: { sponsor_id: w.b.id, name: `Fund ${n}`, currency, budget_cents: cents } }), 201);
  const r = must(await api('POST', `/sponsorship-programs/${p.id}/rounds`, { token: w.owner.token, body: { opens_on: day(-1), closes_on: day(30) } }), 201);
  p = must(await api('POST', `/sponsorship-programs/${p.id}/status`, { token: w.owner.token, body: { status: 'published', version: p.row_version } }));
  if (budget) p = must(await api('POST', `/sponsorship-programs/${p.id}/budget`, { token: w.owner.token, body: { budget_id: budget.id, version: p.row_version } }));
  return { p, r };
};
const applyFor = async (r, cents = 20000, currency) => {
  const a = await signup(['athlete']);
  const app = must(await api('POST', `/program-rounds/${r.id}/applications`, { token: a.token, body: { target_type: 'athlete', target_id: a.id, requested_cents: cents, pitch: 'Please', ...(currency ? { currency } : {}) } }), 201);
  return { a, app };
};
const award = async (w, p, app, extra = {}) => {
  const v = (await api('GET', `/sponsorship-programs/${p.id}`, { token: w.owner.token })).body.row_version;
  return api('PATCH', `/program-applications/${app.id}`, { token: w.owner.token, body: { decision: 'award', program_version: v, ...extra } });
};
const accept = (a, awardId, v = 1) => api('POST', `/program-awards/${awardId}/respond`, { token: a.token, body: { decision: 'accept', offer_version: v } });
const offer = async (w, athlete, budgetId, cents = 20000, extra = {}) => {
  must(await api('POST', '/me/sponsorship-profile', { token: athlete.token, body: { open_to_sponsors: true } }));
  return api('POST', '/sponsorships', { token: w.owner.token, body: { sponsor_id: w.b.id, target_type: 'athlete', target_id: athlete.id, deliverables: 'Wear the kit', starts_on: '2030-01-01', ends_on: '2030-12-31', budget_id: budgetId, lines: [{ kind: 'money', label: 'Support', currency: 'USD', total_cents: cents, cadence: 'once', first_due_on: '2030-02-01' }], ...extra } });
};
const take = (athlete, dealId) => api('PATCH', `/sponsorships/${dealId}`, { token: athlete.token, body: { status: 'active', version: 1 } });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('budgets nest in one currency, a child never exceeds its parent, nothing drops below what is allocated, and stale edits are refused', async () => {
  const w = await brand();
  const a = await annual(w, 100000);
  assert.equal(a.available_cents, 100000);
  const eng = must(await mkBudget(w, { kind: 'program', name: 'Youth fund', parent_id: a.id, authorized_cents: 60000 }), 201);
  assert.equal((await get(w, a.id)).allocated_cents, 60000);
  assert.equal((await get(w, a.id)).available_cents, 40000);
  assert.equal((await mkBudget(w, { kind: 'program', name: 'Too big', parent_id: a.id, authorized_cents: 50000 })).status, 409, 'parent has 40000 left to allocate');
  assert.equal((await mkBudget(w, { kind: 'program', name: 'Euro child', parent_id: a.id, authorized_cents: 100, currency: 'EUR' })).status, 422, 'currencies are not mixed in a tree');
  assert.equal((await mkBudget(w, { kind: 'annual', name: 'No year', authorized_cents: 1 })).status, 400);
  assert.equal((await mkBudget(w, { kind: 'department', name: 'Dept', authorized_cents: 1 })).status, 400, 'a department is needed');
  assert.equal((await mkBudget(w, { kind: 'annual', name: a.name, fiscal_year: 2030, authorized_cents: 1 })).status, 409, 'unique name per year');
  // lowering the parent below its allocation is refused; stale version is refused
  assert.equal((await api('PATCH', `/sponsorship-budgets/${a.id}`, { token: w.owner.token, body: { version: a.row_version, authorized_cents: 50000 } })).status, 409);
  const lowered = must(await api('PATCH', `/sponsorship-budgets/${a.id}`, { token: w.owner.token, body: { version: a.row_version, authorized_cents: 70000 } }));
  assert.equal(lowered.available_cents, 10000);
  assert.equal((await api('PATCH', `/sponsorship-budgets/${a.id}`, { token: w.owner.token, body: { version: a.row_version, name: 'Stale edit' } })).status, 409, 'stale version');
  // the child cannot grow past the parent's room
  assert.equal((await api('PATCH', `/sponsorship-budgets/${eng.id}`, { token: w.owner.token, body: { version: eng.row_version, authorized_cents: 80000 } })).status, 409);
  must(await api('PATCH', `/sponsorship-budgets/${eng.id}`, { token: w.owner.token, body: { version: eng.row_version, authorized_cents: 70000 } }));
  // list: deterministic, roll-up adds children of the same currency
  const list = must(await api('GET', '/sponsorship-budgets', { token: w.owner.token, query: { sponsor_id: w.b.id } }));
  assert.deepEqual(list.map((x) => x.kind), ['annual', 'program']);
  assert.equal(list[0].rollup.authorized_cents, 70000);
  // archive: parent needs its children archived first; archived budgets stay readable
  assert.equal((await api('PATCH', `/sponsorship-budgets/${a.id}`, { token: w.owner.token, body: { version: lowered.row_version + 1, status: 'archived' } })).status, 409);
  const kid = await get(w, eng.id);
  must(await api('PATCH', `/sponsorship-budgets/${eng.id}`, { token: w.owner.token, body: { version: kid.row_version, status: 'archived' } }));
  assert.equal((await get(w, a.id)).allocated_cents, 0, 'an archived child frees the parent');
  assert.equal((await get(w, eng.id)).status, 'archived');
});

test('concurrent awards from two programs on one budget cannot exceed what was authorized; releases and acceptance reconcile', async () => {
  const w = await brand();
  const a = await annual(w, 100000);
  const one = await program(w, { budget: a }), two = await program(w, { budget: a });
  const x = await applyFor(one.r, 60000), y = await applyFor(two.r, 60000);
  const res = await Promise.all([award(w, one.p, x.app), award(w, two.p, y.app)]);
  assert.deepEqual(res.map((r) => r.status).sort(), [200, 409], JSON.stringify(res.map((r) => r.body)));
  const b = await get(w, a.id);
  assert.equal(b.reserved_cents, 60000);
  assert.equal(b.available_cents, 40000);
  assert.equal(b.committed_cents, 0, 'a reservation is not a commitment');
  // the loser can be awarded a smaller amount that fits
  const loser = res[0].status === 409 ? [one, x] : [two, y];
  const smaller = must(await award(w, loser[0].p, loser[1].app, { awarded_cents: 40000 }));
  assert.equal((await get(w, a.id)).available_cents, 0);
  // withdrawing releases the reservation back to the budget
  const winner = (res[0].status === 200 ? res[0] : res[1]).body.award;
  must(await api('POST', `/program-awards/${smaller.award.id}/withdraw`, { token: w.owner.token, body: { reason: 'changed plans' } }));
  assert.equal((await get(w, a.id)).available_cents, 40000, 'released');
  // acceptance converts the reservation into a commitment without changing what is available
  const winnerApp = res[0].status === 200 ? x : y;
  const done = must(await accept(winnerApp.a, winner.id, winner.offer_version));
  const after = await get(w, a.id);
  assert.equal(after.reserved_cents, 0);
  assert.equal(after.committed_cents, 60000);
  assert.equal(after.available_cents, 40000);
  assert.equal(after.paid_cents, 0, 'nothing is paid until the recipient confirms a payment');
  const rows = must(await api('GET', `/sponsorship-budgets/${a.id}/commitments`, { token: w.owner.token }));
  assert.deepEqual(rows.map((r) => r.kind), ['agreement']);
  assert.equal(done.sponsorship_id !== null, true);
});

test('offers are planned, never income; acceptance commits under lock; payments, reversals and ending an agreement reconcile', async () => {
  const w = await brand();
  const a = await annual(w, 50000);
  const ath1 = await signup(['athlete']), ath2 = await signup(['athlete']);
  const o1 = must(await offer(w, ath1, a.id, 30000), 201), o2 = must(await offer(w, ath2, a.id, 30000), 201);
  let b = await get(w, a.id);
  assert.equal(b.planned_cents, 60000, 'proposals are planned');
  assert.equal(b.committed_cents, 0);
  assert.equal(b.available_cents, 50000, 'a proposal does not reduce what is available');
  assert.equal(b.paid_cents, 0);
  // the first acceptance commits; the second would exceed the authorization
  must(await take(ath1, o1.id));
  b = await get(w, a.id);
  assert.equal(b.committed_cents, 30000);
  assert.equal(b.planned_cents, 30000);
  assert.equal(b.available_cents, 20000);
  const over = await take(ath2, o2.id);
  assert.equal(over.status, 409, JSON.stringify(over.body));
  assert.match(over.body.error?.message ?? over.body.message ?? '', /exceed the authorized budget/);
  // the recipient never sees which budget funds the offer
  const seen = must(await api('GET', `/sponsorships/${o1.id}`, { token: ath1.token }));
  assert.equal(seen.budget, undefined);
  assert.equal(must(await api('GET', '/sponsorships', { token: ath1.token })).find((d) => d.id === o1.id).budget_id, undefined);
  // a payment is paid only once the recipient confirms it; a reversal is a refund and re-opens the due
  const deal = must(await api('GET', `/sponsorships/${o1.id}`, { token: w.owner.token }));
  assert.equal(deal.budget.id, a.id);
  const due = deal.obligations[0];
  const pay = must(await api('POST', `/sponsorship-obligations/${due.id}/payments`, { token: w.owner.token, body: { amount_cents: 30000, currency: 'USD', method: 'bank_transfer', reference: 'WIRE-1', paid_on: day(0) } }), 201);
  b = await get(w, a.id);
  assert.equal(b.paid_cents, 0, 'a report is not a payment');
  assert.equal(b.reported_unverified_cents, 30000);
  must(await api('PATCH', `/sponsorship-payments/${pay.id}`, { token: ath1.token, body: { status: 'confirmed' } }));
  b = await get(w, a.id);
  assert.equal(b.paid_cents, 30000);
  assert.equal(b.outstanding_cents, 0);
  must(await api('PATCH', `/sponsorship-payments/${pay.id}`, { token: ath1.token, body: { status: 'reversed', note: 'bank returned it' } }));
  b = await get(w, a.id);
  assert.equal(b.paid_cents, 0);
  assert.equal(b.refunded_cents, 30000);
  assert.equal(b.committed_cents, 30000, 'the due is open again, so the commitment stays');
  assert.equal(b.outstanding_cents, 30000);
  // withdrawing the other offer drops it from planned; archive is refused while money is committed
  must(await api('POST', `/sponsorships/${o2.id}/withdraw`, { token: w.owner.token, body: {} }));
  assert.equal((await get(w, a.id)).planned_cents, 0);
  assert.equal((await api('PATCH', `/sponsorship-budgets/${a.id}`, { token: w.owner.token, body: { version: b.row_version, status: 'archived' } })).status, 409);
  // ending the agreement releases the dues that are not yet due and untouched
  const later = must(await offer(w, ath2, a.id, 10000, { lines: [{ kind: 'money', label: 'Support', currency: 'USD', total_cents: 10000, cadence: 'monthly', first_due_on: '2031-01-01', instalments: 2 }], ends_on: '2031-12-31' }), 201);
  must(await take(ath2, later.id));
  assert.equal((await get(w, a.id)).committed_cents, 40000);
  must(await api('PATCH', `/sponsorships/${later.id}`, { token: ath2.token, body: { status: 'ended', reason: 'cancelled' } }));
  assert.equal((await get(w, a.id)).committed_cents, 30000, 'future dues were released');
});

test('currencies stay separate unless a sourced FX rate is explicit; older commitments keep their own rate', async () => {
  const w = await brand();
  const a = await annual(w, 100000);
  const eur = await program(w, { currency: 'EUR', cents: 100000 });
  // no FX policy: a EUR program cannot draw on a USD budget
  assert.equal((await api('POST', `/sponsorship-programs/${eur.p.id}/budget`, { token: w.owner.token, body: { budget_id: a.id, version: eur.p.row_version } })).status, 422);
  // an explicit policy still needs a sourced rate
  const ex = await annual(w, 100000, { name: 'Explicit', fx_policy: 'explicit' });
  assert.equal((await api('POST', `/sponsorship-programs/${eur.p.id}/budget`, { token: w.owner.token, body: { budget_id: ex.id, version: eur.p.row_version } })).status, 422, 'no rate yet');
  assert.equal((await api('POST', `/sponsorship-budgets/${a.id}/fx-rates`, { token: w.owner.token, body: { currency: 'EUR', rate: 1.1, source: 'ECB', as_of: day(0) } })).status, 409, 'the other budget has no FX policy');
  assert.equal((await api('POST', `/sponsorship-budgets/${ex.id}/fx-rates`, { token: w.owner.token, body: { currency: 'EUR', rate: 1.1, source: '' , as_of: day(0) } })).status, 400, 'a source is required');
  assert.equal((await api('POST', `/sponsorship-budgets/${ex.id}/fx-rates`, { token: w.staff.finance.token, body: { currency: 'USD', rate: 1, source: 'Same currency', as_of: day(0) } })).status, 400);
  const r1 = must(await api('POST', `/sponsorship-budgets/${ex.id}/fx-rates`, { token: w.staff.finance.token, body: { currency: 'EUR', rate: 1.1, source: 'ECB reference rate', source_ref: 'https://www.ecb.europa.eu/stats/eurofxref', as_of: day(0) } }), 201);
  const linked = must(await api('POST', `/sponsorship-programs/${eur.p.id}/budget`, { token: w.owner.token, body: { budget_id: ex.id, version: eur.p.row_version } }));
  assert.equal(linked.budget_id, ex.id);
  const x = await applyFor(eur.r, 10000);
  const aw = must(await award(w, eur.p, x.app));
  let b = await get(w, ex.id);
  assert.equal(b.reserved_cents, 11000, '100 EUR at 1.10 = 110 USD');
  assert.deepEqual(b.by_currency.map((c) => [c.currency, c.reserved]), [['EUR', 10000]]);
  // a new rate applies to FUTURE awards only; what is reserved keeps its rate
  must(await api('POST', `/sponsorship-budgets/${ex.id}/fx-rates`, { token: w.owner.token, body: { currency: 'EUR', rate: 2, source: 'Treasury memo 12', as_of: day(0) } }), 201);
  assert.equal((await get(w, ex.id)).reserved_cents, 11000);
  const y = await applyFor(eur.r, 10000);
  must(await award(w, eur.p, y.app));
  assert.equal((await get(w, ex.id)).reserved_cents, 11000 + 20000, 'the second award is costed at the new rate 2.00; the first keeps 1.10');
  // resizing an award keeps the rate of its own reservation (1.10), not today's 2.00
  const resized = must(await api('PATCH', `/program-awards/${aw.award.id}`, { token: w.owner.token, body: { row_version: aw.award.row_version, amount_cents: 9000 } }));
  assert.equal((await get(w, ex.id)).reserved_cents, 9900 + 20000);
  const back = must(await api('PATCH', `/program-awards/${aw.award.id}`, { token: w.owner.token, body: { row_version: resized.row_version, amount_cents: 10000 } }));
  must(await api('POST', `/program-awards/${aw.award.id}/issue`, { token: w.owner.token, body: { offer_version: back.offer_version, idempotency_key: 'reissue-0001' } }));
  must(await accept(x.a, aw.award.id, back.offer_version));
  b = await get(w, ex.id);
  assert.equal(b.reserved_cents, 20000);
  assert.equal(b.committed_cents, 11000, 'reservation became a commitment at the same rate');
  assert.equal(b.fx_rates.filter((r) => !r.superseded_at).length, 1);
  assert.equal(b.fx_rates.length, 2, 'superseded rates are kept');
  assert.equal(r1.currency, 'EUR');
  // a direct offer in another currency obeys the same rule
  const ath = await signup(['athlete']);
  assert.equal((await offer(w, ath, a.id, 100, { lines: [{ kind: 'money', label: 'x', currency: 'EUR', total_cents: 100, cadence: 'once', first_due_on: '2030-02-01' }] })).status, 422, 'no FX policy on that budget');
  const fx = must(await offer(w, ath, ex.id, 100, { lines: [{ kind: 'money', label: 'x', currency: 'EUR', total_cents: 100, cadence: 'once', first_due_on: '2030-02-01' }] }), 201);
  assert.equal((await get(w, ex.id)).planned_cents, 200, '1 EUR at the current rate 2.00');
  assert.ok(fx.id);
  // goods and endorsements are never cash
  const ath2 = await signup(['athlete']);
  assert.equal((await offer(w, ath2, a.id, 1, { lines: [{ kind: 'goods', label: 'Kit', quantity: 2, unit: 'pcs', cadence: 'once', first_due_on: '2030-02-01', estimate_cents: 50000, currency: 'USD' }] })).status, 422);
});

test('an offer above the budget threshold waits for a second approver and is invisible to the recipient until approved', async () => {
  const w = await brand();
  const a = await annual(w, 100000, { approval_over_cents: 10000 });
  const ath = await signup(['athlete']);
  const o = must(await offer(w, ath, a.id, 20000), 201);
  assert.equal(o.budget_approval, 'pending');
  assert.equal((await api('GET', `/sponsorships/${o.id}`, { token: ath.token })).status, 404, 'the recipient is not told yet');
  assert.equal(must(await api('GET', '/sponsorships', { token: ath.token })).length, 0);
  assert.equal((await take(ath, o.id)).status, 404, 'and cannot accept (not even see)');
  assert.equal((await api('POST', `/sponsorships/${o.id}/budget-approval`, { token: w.owner.token, body: { decision: 'approve' } })).status, 403, 'the proposer cannot approve with others available');
  assert.equal((await api('POST', `/sponsorships/${o.id}/budget-approval`, { token: w.staff.evaluator.token, body: { decision: 'approve' } })).status, 403, 'wrong role');
  assert.equal((await api('POST', `/sponsorships/${o.id}/budget-approval`, { token: w.staff.approver.token, body: { decision: 'reject' } })).status, 400, 'a reason is required');
  must(await api('POST', `/sponsorships/${o.id}/budget-approval`, { token: w.staff.approver.token, body: { decision: 'approve' } }));
  assert.equal((await api('POST', `/sponsorships/${o.id}/budget-approval`, { token: w.staff.approver.token, body: { decision: 'approve' } })).status, 409, 'already decided');
  assert.equal((await api('GET', `/sponsorships/${o.id}`, { token: ath.token })).status, 200, 'visible after approval');
  must(await take(ath, o.id));
  // a rejected offer is withdrawn and never reaches the recipient
  const ath2 = await signup(['athlete']);
  const o2 = must(await offer(w, ath2, a.id, 20000), 201);
  must(await api('POST', `/sponsorships/${o2.id}/budget-approval`, { token: w.staff.finance.token, body: { decision: 'reject', note: 'not in plan' } }));
  assert.equal((await api('GET', `/sponsorships/${o2.id}`, { token: ath2.token })).status, 404);
  assert.equal((await pool.query('SELECT status FROM sponsorships WHERE id=$1', [o2.id])).rows[0].status, 'withdrawn');
  // an offer at or below the threshold needs no approval
  const ath3 = await signup(['athlete']);
  assert.equal(must(await offer(w, ath3, a.id, 10000), 201).budget_approval, null);
  // a program award above the threshold adds an approver sign-off even with no program threshold
  const pr = await program(w, { budget: a });
  const x = await applyFor(pr.r, 15000);
  const won = must(await award(w, pr.p, x.app));
  assert.equal(won.award.status, 'pending_approval');
  assert.equal((await pool.query('SELECT step FROM sponsorship_award_approvals WHERE award_id=$1', [won.award.id])).rows.map((r) => r.step).join(), 'approver');
});

test('budgets are server-side isolated: other brands, roles and the recipient get 404/403 on reads, writes and exports; exports are audit-logged', async () => {
  const w = await brand(), other = await brand();
  const a = await annual(w, 100000);
  const stranger = other.owner.token;
  assert.equal((await api('GET', `/sponsorship-budgets/${a.id}`, { token: stranger })).status, 404);
  assert.equal((await api('GET', `/sponsorship-budgets/${a.id}/commitments`, { token: stranger })).status, 404);
  assert.equal((await api('GET', `/sponsorship-budgets/${a.id}/export`, { token: stranger })).status, 404);
  assert.equal((await api('PATCH', `/sponsorship-budgets/${a.id}`, { token: stranger, body: { version: 1, name: 'Mine now' } })).status, 404);
  assert.equal((await api('POST', `/sponsorship-budgets/${a.id}/fx-rates`, { token: stranger, body: { currency: 'EUR', rate: 1, source: 'x y', as_of: day(0) } })).status, 404);
  assert.equal((await api('GET', '/sponsorship-budgets', { token: stranger, query: { sponsor_id: w.b.id } })).status, 404);
  assert.equal((await mkBudget(w, { kind: 'annual', name: 'Hijack', fiscal_year: 2030, authorized_cents: 1 }, stranger)).status, 404);
  assert.equal((await api('GET', '/sponsorship-budgets', { query: { sponsor_id: w.b.id } })).status, 401);
  // roles: auditor reads and exports but cannot write; evaluator cannot even read; finance writes
  assert.equal((await api('GET', `/sponsorship-budgets/${a.id}`, { token: w.staff.auditor.token })).status, 200);
  assert.equal((await api('PATCH', `/sponsorship-budgets/${a.id}`, { token: w.staff.auditor.token, body: { version: 1, name: 'Nope nope' } })).status, 403);
  assert.equal((await mkBudget(w, { kind: 'annual', name: 'Auditor try', fiscal_year: 2031, authorized_cents: 1 }, w.staff.auditor.token)).status, 403);
  assert.equal((await api('GET', `/sponsorship-budgets/${a.id}`, { token: w.staff.evaluator.token })).status, 403);
  assert.equal((await api('GET', `/sponsorship-budgets/${a.id}/export`, { token: w.staff.evaluator.token })).status, 403);
  must(await mkBudget(w, { kind: 'annual', name: 'Finance FY', fiscal_year: 2032, authorized_cents: 5 }, w.staff.finance.token).then((r) => (r.status === 201 ? { ...r, status: 200 } : r)));
  // a program cannot be linked to another brand's budget
  const mine = await program(w);
  const theirs = await annual(other, 1000);
  assert.equal((await api('POST', `/sponsorship-programs/${mine.p.id}/budget`, { token: w.owner.token, body: { budget_id: theirs.id, version: mine.p.row_version } })).status, 404);
  // a direct offer cannot use another brand's budget
  const ath = await signup(['athlete']);
  assert.equal((await offer(w, ath, theirs.id, 100)).status, 400);
  // export is CSV, audit-logged
  const csv = must(await api('GET', `/sponsorship-budgets/${a.id}/export`, { token: w.staff.auditor.token }));
  assert.match(csv.csv, /^section,kind,ref,status,currency,amount_cents/);
  assert.match(csv.csv, /balance,authorized,,,USD,100000/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='export' AND entity='sponsorship_budgets' AND entity_id=$1", [a.id])).rows[0].n, 1);
  // department-scoped members reach only their department's budget
  const dept = must(await api('POST', `/organisations/${w.org.id}/departments`, { token: w.owner.token, body: { name: 'Youth' } }), 201);
  const db = must(await mkBudget(w, { kind: 'department', name: 'Youth dept', fiscal_year: 2030, authorized_cents: 5000, department_id: dept.id, parent_id: a.id }), 201);
  assert.equal(db.department_id, dept.id);
  // a department budget only funds that department's offers
  assert.equal((await offer(w, ath, db.id, 100)).status, 422);
  const withDept = must(await offer(w, ath, db.id, 100, { department_id: dept.id }), 201);
  assert.equal(withDept.budget_id, db.id);
});

test('event budgets fund one event only; existing programs and agreements keep working with no budget; the migration is re-runnable', async () => {
  const w = await brand();
  const org = await signup(['organizer']);
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: 'Cup', sport: 'football' } }), 201);
  const ev2 = must(await api('POST', '/events', { token: org.token, body: { name: 'Other Cup', sport: 'football' } }), 201);
  const eb = must(await mkBudget(w, { kind: 'event', name: 'Cup sponsorship', authorized_cents: 30000, event_id: ev.id }), 201);
  assert.equal(eb.event_id, ev.id);
  const line = (cents) => [{ kind: 'money', label: 'Title sponsor', currency: 'USD', total_cents: cents, cadence: 'once', first_due_on: '2030-02-01' }];
  const wrong = await api('POST', '/sponsorships', { token: w.owner.token, body: { sponsor_id: w.b.id, target_type: 'event', target_id: ev2.id, budget_id: eb.id, lines: line(100), starts_on: '2030-01-01', ends_on: '2030-12-31' } });
  assert.equal(wrong.status, 422, 'the budget funds a different event');
  const good = must(await api('POST', '/sponsorships', { token: w.owner.token, body: { sponsor_id: w.b.id, target_type: 'event', target_id: ev.id, budget_id: eb.id, lines: line(20000), starts_on: '2030-01-01', ends_on: '2030-12-31' } }), 201);
  must(await api('PATCH', `/sponsorships/${good.id}`, { token: org.token, body: { status: 'active', version: 1 } }));
  const b = await get(w, eb.id);
  assert.equal(b.committed_cents, 20000);
  assert.equal(b.available_cents, 10000);
  // the organiser's event budget already shows the same agreement as sponsorship (not income lines)
  const evb = must(await api('GET', `/events/${ev.id}/budget`, { token: org.token }));
  assert.equal(evb.sponsorship.by_currency[0].committed_cents, 20000);
  // a program with no budget and an agreement with no budget behave exactly as before
  const plain = await program(w);
  const x = await applyFor(plain.r, 5000);
  const won = must(await award(w, plain.p, x.app));
  must(await accept(x.a, won.award.id, won.award.offer_version));
  assert.equal((await pool.query('SELECT budget_id FROM sponsorships WHERE application_id=$1', [x.app.id])).rows[0].budget_id, null);
  // unlinking a program that holds money on a budget is refused; moving an unused one is fine
  const a = await annual(w, 100000);
  const lp = await program(w, { budget: a });
  const y = await applyFor(lp.r, 5000);
  must(await award(w, lp.p, y.app));
  const cur = (await api('GET', `/sponsorship-programs/${lp.p.id}`, { token: w.owner.token })).body;
  assert.equal((await api('DELETE', `/sponsorship-programs/${lp.p.id}/budgets/${a.id}`, { token: w.owner.token, body: { version: cur.row_version }, query: { version: cur.row_version } })).status, 409);
  // re-running every migration changes nothing
  const before = (await pool.query('SELECT count(*)::int AS n FROM sponsorship_budgets')).rows[0].n;
  await migrate();
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sponsorship_budgets')).rows[0].n, before);
  // linking an existing program with held reservations moves them onto the budget, and refuses when they do not fit
  const tiny = await annual(w, 100, { name: 'Tiny' });
  const legacy = await program(w);
  const z = await applyFor(legacy.r, 5000);
  must(await award(w, legacy.p, z.app));
  const lv = (await api('GET', `/sponsorship-programs/${legacy.p.id}`, { token: w.owner.token })).body.row_version;
  assert.equal((await api('POST', `/sponsorship-programs/${legacy.p.id}/budget`, { token: w.owner.token, body: { budget_id: tiny.id, version: lv } })).status, 409, 'its existing reservation does not fit');
  assert.equal((await pool.query('SELECT budget_id FROM sponsorship_award_reservations WHERE program_id=$1', [legacy.p.id])).rows[0].budget_id, null, 'nothing moved');
  must(await api('POST', `/sponsorship-programs/${legacy.p.id}/budget`, { token: w.owner.token, body: { budget_id: a.id, version: lv } }));
  assert.equal((await get(w, a.id)).reserved_cents, 10000);
});
