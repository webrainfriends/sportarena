// Budget traceability: unique budget codes, the end-to-end trace (program -> award -> agreement -> due -> payment) tying to the balances, and coverage of spending that is not on any budget.
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
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `bt_${n}_${roles[0]}`, display_name: `Budget ${n}`, email: `bt${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); return { ...r.body.user, token: r.body.token }; };
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

test('every budget gets its own code, and the migration backfills codes without touching anything else', async () => {
  const w = await brand();
  const a = await annual(w, 1000, { name: 'One' });
  const b = must(await mkBudget(w, { kind: 'program', name: 'Two', authorized_cents: 500 }), 201);
  assert.match(a.code, /^BUD-\d{5}$/);
  assert.notEqual(a.code, b.code);
  assert.equal((await get(w, a.id)).code, a.code);
  // a budget that predates codes is filled in on re-run; existing ones keep theirs
  await pool.query('ALTER TABLE sponsorship_budgets ALTER COLUMN code DROP NOT NULL');
  await pool.query('UPDATE sponsorship_budgets SET code=NULL WHERE id=$1', [b.id]);
  await pool.query("DELETE FROM schema_migrations WHERE name='097_budget_codes.sql'");
  await migrate();
  const rows = (await pool.query('SELECT id, code FROM sponsorship_budgets WHERE id = ANY($1)', [[a.id, b.id]])).rows;
  assert.equal(rows.find((r) => r.id === a.id).code, a.code);
  assert.match(rows.find((r) => r.id === b.id).code, /^BUD-\d{5}$/);
  assert.equal(new Set(rows.map((r) => r.code)).size, 2);
});

test('the trace follows a budget from program to award, agreement, due and payment and ties to the balances', async () => {
  const w = await brand();
  const bud = await annual(w, 100000);
  const { p, r } = await program(w, { budget: bud });
  const x = await applyFor(r, 5000);
  const won = must(await award(w, p, x.app));
  let t = must(await api('GET', `/sponsorship-budgets/${bud.id}/trace`, { token: w.owner.token }));
  assert.equal(t.budget.code, bud.code);
  assert.equal(t.programs.length, 1);
  assert.equal(t.programs[0].program.id, p.id);
  assert.equal(t.programs[0].awards.length, 1, 'the held award reserves budget');
  assert.equal(t.programs[0].totals.reserved_cents, (await get(w, bud.id)).reserved_cents);
  assert.equal(t.reconciles, true);

  must(await accept(x.a, won.award.id, won.award.offer_version));
  t = must(await api('GET', `/sponsorship-budgets/${bud.id}/trace`, { token: w.owner.token }));
  const ag = t.programs[0].agreements[0];
  assert.equal(t.programs[0].awards.length, 0, 'the reservation became an agreement');
  assert.ok(ag.obligations.length >= 1);
  assert.equal(ag.totals.committed_cents, (await get(w, bud.id)).committed_cents);

  const due = ag.obligations[0];
  const pay = must(await api('POST', `/sponsorship-obligations/${due.id}/payments`, { token: w.owner.token, body: { amount_cents: due.amount_cents, currency: due.currency, method: 'bank_transfer', reference: 'WIRE-T1', paid_on: day(0) } }), 201);
  t = must(await api('GET', `/sponsorship-budgets/${bud.id}/trace`, { token: w.owner.token }));
  assert.deepEqual(t.programs[0].agreements[0].obligations[0].payments.map((q) => [q.reference, q.status]), [['WIRE-T1', 'reported']]);
  assert.equal(t.programs[0].totals.paid_cents, 0, 'a report is not a payment');
  must(await api('PATCH', `/sponsorship-payments/${pay.id}`, { token: x.a.token, body: { status: 'confirmed' } }));
  t = must(await api('GET', `/sponsorship-budgets/${bud.id}/trace`, { token: w.owner.token }));
  assert.equal(t.programs[0].totals.paid_cents, due.amount_cents);
  assert.equal(t.reconciles, true);

  // a direct offer on the budget (no program) is traced as planned under `direct`
  const ath = await signup(['athlete']);
  const o = must(await offer(w, ath, bud.id, 7000), 201);
  t = must(await api('GET', `/sponsorship-budgets/${bud.id}/trace`, { token: w.owner.token }));
  assert.equal(t.direct.agreements[0].id, o.id);
  assert.equal(t.direct.agreements[0].planned, true);
  assert.equal(t.direct.totals.planned_cents, 7000);
  assert.equal(t.reconciles, true);

  // read-only roles can follow it; an outsider cannot see it exists
  assert.equal((await api('GET', `/sponsorship-budgets/${bud.id}/trace`, { token: w.staff.auditor.token })).status, 200);
  const nosy = await signup(['athlete']);
  assert.equal((await api('GET', `/sponsorship-budgets/${bud.id}/trace`, { token: nosy.token })).status, 404);
  assert.equal((await api('GET', `/sponsorship-budgets/${bud.id}/trace`, { token: x.a.token })).status, 404, 'the recipient never sees the budget');
});

test('coverage lists spending that is not on any budget and shrinks as programs are linked', async () => {
  const w = await brand();
  const bud = await annual(w, 100000);
  const empty = must(await api('GET', '/budget-coverage', { token: w.owner.token, query: { sponsor_id: w.b.id } }));
  assert.deepEqual([empty.unmapped_programs.length, empty.unmapped_agreements.length, empty.mapped_programs], [0, 0, 0]);

  const loose = await program(w);
  const x = await applyFor(loose.r, 5000);
  must(await award(w, loose.p, x.app));
  const ath = await signup(['athlete']);
  const o = must(await offer(w, ath, undefined, 9000), 201);
  let cov = must(await api('GET', '/budget-coverage', { token: w.owner.token, query: { sponsor_id: w.b.id } }));
  assert.equal(cov.unmapped_programs.length, 1);
  assert.equal(cov.unmapped_programs[0].id, loose.p.id);
  assert.equal(cov.unmapped_programs[0].spend[0].reserved_cents > 0, true, 'its reserved award is spend with no budget behind it');
  assert.deepEqual(cov.unmapped_agreements.map((d) => d.id), [o.id]);

  const v = (await api('GET', `/sponsorship-programs/${loose.p.id}`, { token: w.owner.token })).body.row_version;
  must(await api('POST', `/sponsorship-programs/${loose.p.id}/budget`, { token: w.owner.token, body: { budget_id: bud.id, version: v } }));
  cov = must(await api('GET', '/budget-coverage', { token: w.owner.token, query: { sponsor_id: w.b.id } }));
  assert.deepEqual([cov.unmapped_programs.length, cov.mapped_programs], [0, 1]);
  assert.equal((await get(w, bud.id)).programs[0].row_version > 0, true, 'the budget page can link further programs');

  assert.equal((await api('GET', '/budget-coverage', { token: w.staff.auditor.token, query: { sponsor_id: w.b.id } })).status, 200);
  const nosy = await signup(['athlete']);
  assert.equal((await api('GET', '/budget-coverage', { token: nosy.token, query: { sponsor_id: w.b.id } })).status, 404);
});
