// Budget planning: guidance from earlier budgets (authorized vs actually used), rationale, document references and the budget documents folder.
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
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `bp_${n}_${roles[0]}`, display_name: `Budget ${n}`, email: `bp${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); return { ...r.body.user, token: r.body.token }; };
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

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const putDoc = (token, qs, body = PDF) => fetch(`${base}/api/v1/documents?${new URLSearchParams(qs)}`, { method: 'PUT', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/pdf' }, body });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('guidance compares earlier budgets with what was really used, suggests from actual use and never mixes currencies', async () => {
  const w = await brand();
  // nothing earlier: no comparables, no suggestion
  const none = must(await api('GET', '/budget-guidance', { token: w.owner.token, query: { sponsor_id: w.b.id, kind: 'annual', fiscal_year: 2030 } }));
  assert.deepEqual([none.comparable, none.suggestion, none.existing], [[], null, null]);

  const last = must(await mkBudget(w, { kind: 'annual', name: 'Last year', fiscal_year: 2029, authorized_cents: 100000 }), 201);
  const { p, r } = await program(w, { budget: last });
  const x = await applyFor(r, 5000);
  must(await award(w, p, x.app));
  const used = (await get(w, last.id)).reserved_cents;
  assert.ok(used > 0);
  // a euro budget of the same kind must not feed a dollar suggestion
  must(await mkBudget(w, { kind: 'annual', name: 'Euro year', fiscal_year: 2028, authorized_cents: 50000, currency: 'EUR' }), 201);

  const g = must(await api('GET', '/budget-guidance', { token: w.owner.token, query: { sponsor_id: w.b.id, kind: 'annual', fiscal_year: 2030, currency: 'USD' } }));
  assert.equal(g.comparable[0].id, last.id);
  assert.equal(g.comparable[0].used_cents, used);
  assert.equal(g.comparable[0].unspent_cents, 100000 - used);
  assert.equal(g.comparable[0].utilisation_pct, Math.round((used / 100000) * 1000) / 10);
  assert.deepEqual([g.suggestion.basis_budget_id, g.suggestion.suggested_cents, g.suggestion.currency], [last.id, used, 'USD']);
  assert.equal(g.average_utilisation_pct, g.comparable[0].utilisation_pct, 'only dollar budgets are averaged');
  assert.equal(g.existing, null);

  // an active budget for the same year is flagged; archived history still counts as guidance
  const cur = await annual(w, 70000, { name: 'This year' });
  assert.equal(must(await api('GET', '/budget-guidance', { token: w.owner.token, query: { sponsor_id: w.b.id, kind: 'annual', fiscal_year: 2030 } })).existing.id, cur.id);
  assert.deepEqual(must(await api('GET', '/budget-guidance', { token: w.owner.token, query: { sponsor_id: w.b.id, kind: 'annual', fiscal_year: 2030 } })).year_authorized, [{ currency: 'USD', authorized_cents: 70000 }]);

  // read access only: the auditor sees it, an outsider does not
  assert.equal((await api('GET', '/budget-guidance', { token: w.staff.auditor.token, query: { sponsor_id: w.b.id, kind: 'annual' } })).status, 200);
  const nosy = await signup(['athlete']);
  assert.equal((await api('GET', '/budget-guidance', { token: nosy.token, query: { sponsor_id: w.b.id, kind: 'annual' } })).status, 404);
});

test('a budget keeps its rationale, basis and references; only managers and finance change them; removing hides', async () => {
  const w = await brand();
  const basis = await annual(w, 50000, { name: 'Basis', fiscal_year: 2029 });
  const b = await annual(w, 80000, { notes: 'Grow the youth fund', basis_budget_id: basis.id, references: [{ kind: 'approval', title: 'Board memo', url: 'https://example.com/memo.pdf' }, { kind: 'purchase_order', title: 'PO', ref_no: 'PO-77' }] });
  const full = await get(w, b.id);
  assert.equal(full.notes, 'Grow the youth fund');
  assert.equal(full.basis.id, basis.id);
  assert.deepEqual(full.references.map((x) => x.title).sort(), ['Board memo', 'PO']);
  // a reference needs a link or a number; links must be https; another brand's budget cannot be the basis
  assert.equal((await api('POST', `/sponsorship-budgets/${b.id}/references`, { token: w.owner.token, body: { kind: 'other', title: 'Empty one' } })).status, 400);
  assert.equal((await api('POST', `/sponsorship-budgets/${b.id}/references`, { token: w.owner.token, body: { kind: 'other', title: 'Plain http', url: 'http://example.com' } })).status, 400);
  const other = await brand();
  const foreign = await annual(other, 1000, { name: 'Foreign' });
  assert.equal((await mkBudget(w, { kind: 'annual', name: 'Bad basis', fiscal_year: 2031, authorized_cents: 10, basis_budget_id: foreign.id })).status, 400);
  // staff roles
  assert.equal((await api('POST', `/sponsorship-budgets/${b.id}/references`, { token: w.staff.auditor.token, body: { kind: 'other', title: 'Nope', ref_no: '1' } })).status, 403);
  const added = must(await api('POST', `/sponsorship-budgets/${b.id}/references`, { token: w.staff.finance.token, body: { kind: 'forecast', title: 'Q3 forecast', url: 'https://example.com/f' } }), 201);
  must(await api('PATCH', `/sponsorship-budgets/${b.id}`, { token: w.owner.token, body: { version: full.row_version, notes: null } }));
  assert.equal((await get(w, b.id)).notes, null);
  must(await api('DELETE', `/sponsorship-budgets/${b.id}/references/${added.id}`, { token: w.owner.token }));
  assert.equal((await get(w, b.id)).references.some((x) => x.id === added.id), false);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sponsorship_budget_references WHERE id=$1 AND removed_at IS NOT NULL', [added.id])).rows[0].n, 1, 'kept on record');
  assert.equal((await api('DELETE', `/sponsorship-budgets/${b.id}/references/${added.id}`, { token: w.owner.token })).status, 404);
});

test('budget documents: managers and finance upload, auditors read, outsiders get nothing; files are hidden, never deleted', async () => {
  const w = await brand();
  const b = await annual(w, 10000);
  const up = await putDoc(w.staff.finance.token, { subject_type: 'budget', subject_id: b.id, kind: 'approval', title: 'Signed approval' });
  assert.equal(up.status, 201);
  const doc = await up.json();
  assert.equal((await putDoc(w.staff.auditor.token, { subject_type: 'budget', subject_id: b.id, kind: 'report' })).status, 403);
  const nosy = await signup(['athlete']);
  assert.equal((await putDoc(nosy.token, { subject_type: 'budget', subject_id: b.id })).status, 404);
  assert.equal((await api('GET', '/documents', { token: nosy.token, query: { subject_type: 'budget', subject_id: b.id } })).status, 404);
  const list = must(await api('GET', '/documents', { token: w.staff.auditor.token, query: { subject_type: 'budget', subject_id: b.id } }));
  assert.deepEqual(list.map((d) => [d.title, d.kind]), [['Signed approval', 'approval']]);
  const dl = await fetch(`${base}/api/v1/documents/${doc.id}/file`, { headers: { authorization: `Bearer ${w.staff.auditor.token}` } });
  assert.equal(dl.status, 200);
  assert.equal((await api('DELETE', `/documents/${doc.id}`, { token: w.staff.auditor.token })).status, 403);
  must(await api('DELETE', `/documents/${doc.id}`, { token: w.owner.token }));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM subject_documents WHERE id=$1', [doc.id])).rows[0].n, 1, 'the row and file are kept');
  await migrate(); // re-runnable
});
