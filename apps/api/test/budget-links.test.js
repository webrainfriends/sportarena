// Many-to-many program budgets: a program draws on several budgets and a budget funds several programs; each award names its budget; balances, trace and unlinking stay exact; budgets never leak to applicants.
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
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `bl_${n}_${roles[0]}`, display_name: `Budget ${n}`, email: `bl${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); return { ...r.body.user, token: r.body.token }; };
const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** A brand run by an organisation: owner (manager) plus approver, finance, auditor, evaluator and legal members. */
const brand = async () => {
  const owner = await signup(['sponsor']);
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Acme ${n}`, kind: 'company' } }), 201);
  const b = must(await api('POST', '/sponsors', { token: owner.token, body: { name: `Corp ${n}` } }), 201);
  must(await api('POST', `/sponsors/${b.id}/identity`, { token: owner.token, body: { sponsor_type: 'organization', organisation_id: org.id } }));
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
const fresh = async (w, id) => (await api('GET', `/sponsorship-programs/${id}`, { token: w.owner.token })).body;
const linkNow = async (w, p, budget, body = {}) => must(await api('POST', `/sponsorship-programs/${p.id}/budget`, { token: w.owner.token, body: { budget_id: budget.id, version: (await fresh(w, p.id)).row_version, ...body } }));

test('a program draws on several budgets and each award names the one it uses; balances and traces stay separate and exact', async () => {
  const w = await brand();
  const b1 = await annual(w, 100000, { name: 'Main' }), b2 = must(await mkBudget(w, { kind: 'program', name: 'Youth', authorized_cents: 50000 }), 201);
  const { p, r } = await program(w);
  assert.equal((await linkNow(w, p, b1)).budget_id, b1.id, 'the first budget linked is the default');
  assert.equal((await linkNow(w, p, b2)).budget_id, b1.id, 'a second link does not change the default');
  const links = must(await api('GET', `/sponsorship-programs/${p.id}/budgets`, { token: w.owner.token }));
  assert.deepEqual(links.map((l) => [l.code, l.is_default]), [[b1.code, true], [b2.code, false]]);

  const x = await applyFor(r, 5000), y = await applyFor(r, 3000);
  const wonX = must(await award(w, p, x.app));            // default budget
  const wonY = must(await award(w, p, y.app, { budget_id: b2.id })); // an explicit one
  assert.equal(wonX.award.budget_id, b1.id);
  assert.equal(wonY.award.budget_id, b2.id);
  const r1 = (await get(w, b1.id)).reserved_cents, r2 = (await get(w, b2.id)).reserved_cents;
  assert.ok(r1 > 0 && r2 > 0 && r1 !== r2, 'each award reserved on its own budget');
  const t1 = must(await api('GET', `/sponsorship-budgets/${b1.id}/trace`, { token: w.owner.token })), t2 = must(await api('GET', `/sponsorship-budgets/${b2.id}/trace`, { token: w.owner.token }));
  assert.deepEqual([t1.programs[0].totals.reserved_cents, t2.programs[0].totals.reserved_cents], [r1, r2]);
  assert.deepEqual([t1.reconciles, t2.reconciles], [true, true]);
  const slice = must(await api('GET', `/sponsorship-programs/${p.id}/budgets`, { token: w.owner.token }));
  assert.deepEqual(slice.map((l) => l.reserved_cents), [r1, r2]);

  // acceptance turns the reservation into an agreement that stays on the award's budget
  must(await accept(y.a, wonY.award.id, wonY.award.offer_version));
  assert.equal((await pool.query('SELECT budget_id FROM sponsorships WHERE application_id=$1', [y.app.id])).rows[0].budget_id, b2.id);
  assert.equal((await get(w, b2.id)).committed_cents, r2);

  // a budget that is not linked cannot be named
  const other = await annual(w, 1000, { name: 'Elsewhere', fiscal_year: 2031 });
  const z = await applyFor(r, 1000);
  assert.equal((await award(w, p, z.app, { budget_id: other.id })).status, 422);
});

test('a budget funds several programs, can be made the default, and unlinking is refused while money sits on it', async () => {
  const w = await brand();
  const b1 = await annual(w, 100000, { name: 'Main' }), b2 = await annual(w, 100000, { name: 'Spare', fiscal_year: 2031 });
  const one = await program(w), two = await program(w);
  await linkNow(w, one.p, b1); await linkNow(w, two.p, b1);
  assert.deepEqual((await get(w, b1.id)).programs.map((x) => x.id).sort(), [one.p.id, two.p.id].sort());

  await linkNow(w, one.p, b2);
  assert.equal((await linkNow(w, one.p, b2, { make_default: true })).budget_id, b2.id, 'default changed for new awards');
  const x = await applyFor(one.r, 4000);
  assert.equal(must(await award(w, one.p, x.app)).award.budget_id, b2.id);

  const del = async (p, b) => api('DELETE', `/sponsorship-programs/${p.id}/budgets/${b.id}`, { token: w.owner.token, query: { version: (await fresh(w, p.id)).row_version } });
  assert.equal((await del(one.p, b2)).status, 409, 'an award is reserved on it');
  const gone = must(await del(one.p, b1));
  assert.equal(gone.budget_id, b2.id, 'the default stays on the budget that still carries the money');
  assert.equal((await get(w, b1.id)).programs.some((q) => q.id === one.p.id), false);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sponsorship_program_budgets WHERE program_id=$1 AND budget_id=$2 AND unlinked_at IS NOT NULL', [one.p.id, b1.id])).rows[0].n, 1, 'kept on record');
  // a budget cannot be archived while a live program is linked
  assert.equal((await api('PATCH', `/sponsorship-budgets/${b1.id}`, { token: w.owner.token, body: { version: (await get(w, b1.id)).row_version, status: 'archived' } })).status, 409);
});

test('budgets stay internal: applicants and outsiders never see links, budget ids or codes', async () => {
  const w = await brand();
  const b = await annual(w, 100000);
  const { p, r } = await program(w);
  await linkNow(w, p, b);
  const x = await applyFor(r, 5000);
  const won = must(await award(w, p, x.app));
  must(await accept(x.a, won.award.id, won.award.offer_version));
  const nosy = await signup(['athlete']);
  for (const [who, path] of [[x.a, `/funding-opportunities/${p.id}`], [nosy, `/funding-opportunities/${p.id}`], [x.a, '/my/program-applications'], [x.a, '/sponsorships']]) {
    const res = await api('GET', path, { token: who.token });
    const text = JSON.stringify(res.body);
    assert.equal(/budget_id|"budget"|BUD-\d/.test(text), false, `${path} must not expose a budget`);
  }
  const listed = await api('GET', `/sponsorship-programs/${p.id}/budgets`, { token: x.a.token });
  assert.notEqual(listed.status, 200, 'an applicant cannot read the program budgets');
  const auditor = must(await api('GET', `/sponsorship-programs/${p.id}/budgets`, { token: w.staff.auditor.token }));
  assert.equal(auditor.length, 1);
});

test('existing single-budget programs become links without moving any money, and the migration re-runs safely', async () => {
  const w = await brand();
  const b = await annual(w, 100000);
  const { p, r } = await program(w);
  await linkNow(w, p, b);
  const x = await applyFor(r, 5000);
  must(await award(w, p, x.app));
  const reserved = (await get(w, b.id)).reserved_cents;
  // simulate data written before links existed: only programs.budget_id and the award's reservation
  await pool.query('DELETE FROM sponsorship_program_budgets WHERE program_id=$1', [p.id]);
  await pool.query('UPDATE sponsorship_awards SET budget_id=NULL WHERE program_id=$1', [p.id]);
  await pool.query("DELETE FROM schema_migrations WHERE name='098_program_budget_links.sql'");
  await migrate();
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sponsorship_program_budgets WHERE program_id=$1 AND budget_id=$2 AND unlinked_at IS NULL', [p.id, b.id])).rows[0].n, 1);
  assert.equal((await pool.query('SELECT budget_id FROM sponsorship_awards WHERE program_id=$1', [p.id])).rows[0].budget_id, b.id);
  assert.equal((await get(w, b.id)).reserved_cents, reserved, 'no balance moved');
  await migrate();
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sponsorship_program_budgets WHERE program_id=$1', [p.id])).rows[0].n, 1);
});
