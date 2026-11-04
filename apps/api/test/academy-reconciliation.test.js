// Academy cost & revenue reconciliation (#787): supplier spend and payment fees reach the P&L once, provenance is reported, double-count risks and unlinked
// entries land in the shared Finance queue, human decisions are audited and applied without touching canonical records, and multi-currency is never summed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { addDays } = await import('../src/booking/time.js');

let server, base, n = 0;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const must = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const today = new Date().toISOString().slice(0, 10);
const key = () => `k-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const dob = new Date(Date.now() - 30 * 365.25 * 864e5).toISOString().slice(0, 10);
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `cl_${n}_${roles[0]}`, display_name: `Cl ${n}`, email: `cl${n}@example.com`, password: 'correct-horse-battery', roles, dob } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

/** An academy with an owner, finance and a coach, one published programme and one cohort linked to it. */
async function academy(title = 'U12 Football') {
  const owner = await signup(), finance = await signup(), coach = await signup(['coach']);
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Closeout ${++n}`, kind: 'academy' } }), 201);
  must(await api('PATCH', `/organisations/${org.id}/academy`, { token: owner.token, body: { row_version: 0, sports: ['football'], currency: 'INR', listed: true } }));
  for (const [u, role] of [[finance, 'finance'], [coach, 'coach']]) {
    must(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role } }), 201);
    must(await api('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } }));
  }
  const prog = must(await api('POST', `/organisations/${org.id}/academy/programmes`, { token: owner.token, body: { sport: 'football', title, capacity: 20, admission_mode: 'direct', public: true } }), 201);
  const cohort = must(await api('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: `${title} cohort`, coach_id: coach.id } }), 201);
  await pool.query('UPDATE org_cohorts SET programme_id=$2 WHERE id=$1', [cohort.id, prog.id]);
  return { owner, finance, coach, org, programme: prog, cohort };
}
const session = async (a, { status = 'published', day = today, hour = 10, programme = a.programme } = {}) => (await pool.query(
  `INSERT INTO academy_sessions(organisation_id, cohort_id, programme_id, title, starts_at, ends_at, status, created_by)
   VALUES ($1,$2,$3,'Training', ($4::date + make_interval(hours => $5)) AT TIME ZONE 'UTC', ($4::date + make_interval(hours => $5 + 1)) AT TIME ZONE 'UTC', $6, $7) RETURNING *`,
  [a.org.id, a.cohort.id, programme.id, day, hour, status, a.owner.id])).rows[0];
/** A venue + court priced per hour in INR, and a booking of it for a session through the canonical engine. */
async function court(rate = 50000) {
  const mgr = await signup(['venue_manager']);
  const v = must(await api('POST', '/venues', { token: mgr.token, body: { name: `Arena ${++n}`, city: 'Pune', timezone: 'UTC', currency: 'INR' } }), 201);
  must(await api('POST', `/venues/${v.id}/hours`, { token: mgr.token, body: { hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '00:00', closes: '23:59' })) } }));
  const res = must(await api('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'Court A', sport: 'football', hourly_rate_cents: rate, max_players: 10 } }), 201);
  return { mgr, venue: v, resource: res };
}
/** An approved payroll run (the canonical shape written by the payroll capability) with one line per timesheet. */
async function approvedRun(a, { currency = 'INR', sheets, status = 'approved', unpriced = [] }) {
  const run = (await pool.query("INSERT INTO academy_payroll_runs(organisation_id, currency, period_start, period_end, idempotency_key, unpriced, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *", [a.org.id, currency, addDays(today, -10), addDays(today, 10), key(), JSON.stringify(unpriced), a.finance.id])).rows[0];
  const detail = sheets.map((s) => ({ timesheet_id: s.id, work_date: s.work_date, amount_minor: s.amount }));
  const total = sheets.reduce((x, s) => x + s.amount, 0);
  const line = (await pool.query("INSERT INTO academy_payroll_lines(run_id, user_id, base_minor, gross_minor, detail) VALUES ($1,$2,$3,$3,$4) RETURNING *", [run.id, a.coach.id, total, JSON.stringify(detail)])).rows[0];
  await pool.query('UPDATE academy_payroll_runs SET total_minor=$2 WHERE id=$1', [run.id, total]);
  for (const s of sheets) await pool.query("UPDATE academy_timesheets SET payroll_run_id=$2 WHERE id=$1", [s.id, run.id]);
  if (status !== 'draft') await pool.query("UPDATE academy_payroll_runs SET status=$2, approved_at=now(), approved_by=$3 WHERE id=$1", [run.id, status, a.finance.id]);
  return { run, line };
}
const sheet = async (a, sess, amount, programmeId = a.programme.id) => {
  const t = (await pool.query("INSERT INTO academy_timesheets(organisation_id, user_id, session_id, work_date, minutes, status, programme_id) VALUES ($1,$2,$3,$4,60,'approved',$5) RETURNING *", [a.org.id, a.coach.id, sess?.id ?? null, today, programmeId])).rows[0];
  return { id: t.id, work_date: today, amount };
};
const pnl = async (a, who = a.finance, q = '') => must(await api('GET', `/organisations/${a.org.id}/academy/pnl?from=${addDays(today, -30)}&to=${addDays(today, 30)}${q}`, { token: who.token }));
const inr = (r) => r.currencies.find((c) => c.currency === 'INR');


const { insert } = await import('../src/finance.js');
const cur = (r, k) => r.currencies.find((c) => c.currency === k);
const recon = (a, who = a.finance) => api('GET', `/organisations/${a.org.id}/academy/reconciliation`, { token: who.token });
const run = (a, who = a.finance) => api('POST', `/organisations/${a.org.id}/academy/reconciliation/run`, { token: who.token, body: {} });
const items = async (a, q = '', who = a.finance) => must(await api('GET', `/organisations/${a.org.id}/academy/reconciliation/items?${q}`, { token: who.token }));
const act = (item, body, who) => api('POST', `/academy/reconciliation/items/${item.id}/act`, { token: who.token, body });
/** A delivered supplier request with a final cost, created through the real capabilities. */
async function supplierJob(a, { amount = 300000, currency = 'INR', quote = amount, status = 'done', title = 'Court resurfacing' } = {}) {
  const sup = must(await api('POST', `/organisations/${a.org.id}/academy/suppliers`, { token: a.owner.token, body: { kind: 'maintenance', name: `Ace ${++n}`, all_venues: true } }), 201);
  let q = must(await api('POST', `/organisations/${a.org.id}/academy/supplier-requests`, { token: a.owner.token, body: { supplier_id: sup.id, title, currency, estimated_cost_minor: quote } }), 201);
  for (const st of ['approved', 'in_progress', status]) q = must(await api('PATCH', `/academy/supplier-requests/${q.id}`, { token: a.owner.token, body: { row_version: q.row_version, status: st, ...(st === status && amount ? { actual_cost_minor: amount, invoice_ref: 'INV-77' } : {}) } }));
  return q;
}
const charge = async (a, { programme = a.programme.id, amount = 10000, currency = 'INR', payer = a.owner, user = a.coach } = {}) => {
  const e = (await pool.query("INSERT INTO org_enrolments(cohort_id, user_id, consent_at, enrolled_by, programme_id) VALUES ($1,$2,now(),$3,$4) RETURNING *", [a.cohort.id, user.id, a.owner.id, programme])).rows[0];
  const ch = (await pool.query("INSERT INTO academy_charges(enrolment_id, organisation_id, payer_id, seq, kind, due_on, currency, gross_minor, amount_minor, status) VALUES ($1,$2,$3,0,'instalment',$4,$5,$6,$6,'paid') RETURNING *", [e.id, a.org.id, payer.id, today, currency, amount])).rows[0];
  return { enrolment: e, charge: ch };
};

test('an approved timesheet obligation counts once, with provenance and a trace to its canonical payroll line; running the check twice changes nothing', async () => {
  const a = await academy();
  const s1 = await session(a);
  const t = await sheet(a, s1, 600000);
  const { line, run: payrun } = await approvedRun(a, { sheets: [t] });
  const p = await pnl(a);
  assert.equal(inr(p).totals.staff_cost_minor, 600000, 'once');
  assert.equal(inr(p).programmes[0].sources.payroll_lines, 1);
  assert.ok(p.provenance.cut_off_at && p.provenance.cost_allocation_version === 0);
  assert.match(p.provenance.currency_policy, /never summed/);
  assert.equal(p.provenance.sources.staff, 'academy_payroll_line (approved runs)');
  const first = must(await run(a));
  const second = must(await run(a));
  assert.equal(second.opened, 0, 'idempotent');
  assert.equal(first.opened, 1, 'the only thing to reconcile is the session that has no confirmed booking');
  assert.deepEqual((await items(a)).map((i) => i.kind), ['venue_unbooked']);
  const s = must(await recon(a));
  assert.equal(s.coverage.by_source.find((x) => x.source === 'payroll').lines, 1);
  assert.equal(s.coverage.matched_pct, 100, 'every cost line comes from one canonical record');
  assert.equal(s.cost_allocation_version, 0);
  assert.ok(line.id && payrun.id);
});

test('a payroll adjustment with no programme opens a queue item; attributing it moves the cost into the programme, audited and append-only, without touching payroll', async () => {
  const a = await academy();
  const t = await sheet(a, null, 250000, null);
  const { line } = await approvedRun(a, { sheets: [t] });
  assert.equal(inr(await pnl(a)).totals.unattributed_cost_minor, 250000);
  must(await run(a));
  const [it] = (await items(a)).filter((i) => i.kind === 'cost_unlinked');
  assert.ok(it); assert.equal(it.amount_minor, 250000); assert.equal(it.currency, 'INR'); assert.equal(it.source_id, line.id);
  assert.deepEqual(it.allowed_decisions.sort(), ['attribute', 'dispute', 'note', 'overhead', 'resolve']);
  const detail = must(await api('GET', `/academy/reconciliation/items/${it.id}`, { token: a.finance.token }));
  assert.equal(detail.trace[0].source_type, 'academy_payroll_line'); assert.equal(detail.trace[0].source_id, line.id);

  assert.equal((await act(it, { decision: 'attribute', reason: 'Head coach time', programme_id: a.programme.id, cohort_id: a.cohort.id }, a.coach)).status, 403, 'a coach cannot decide');
  assert.equal((await act(it, { decision: 'attribute', reason: 'x' }, a.finance)).status, 400, 'a reason and a programme are required');
  assert.equal((await act(it, { decision: 'keep_manual', reason: 'not valid here' }, a.finance)).status, 400, 'the kind decides which decisions are allowed');
  const done = must(await act(it, { decision: 'attribute', reason: 'Head coach time', programme_id: a.programme.id, cohort_id: a.cohort.id }, a.finance));
  assert.equal(done.status, 'resolved');
  assert.equal((await act(it, { decision: 'resolve', reason: 'again' }, a.finance)).status, 409);

  const p = await pnl(a);
  assert.equal(inr(p).totals.unattributed_cost_minor, 0);
  assert.equal(inr(p).programmes[0].staff_cost_minor, 250000);
  assert.equal(p.provenance.cost_allocation_version, 1, 'the decision is a new allocation version');
  const cohort = inr(p).by_cohort.find((k) => k.cohort_id === a.cohort.id);
  assert.equal(cohort.staff_cost_minor, 250000, 'the person named the cohort, so it is attributable now');
  const canonical = (await pool.query('SELECT gross_minor FROM academy_payroll_lines WHERE id=$1', [line.id])).rows[0];
  assert.equal(Number(canonical.gross_minor), 250000, 'the payroll record is untouched');
  await assert.rejects(pool.query("UPDATE academy_cost_attributions SET reason='edited'"), /append-only/);
  await assert.rejects(pool.query('DELETE FROM academy_cost_attributions'), /append-only/);
  const aud = await pool.query("SELECT 1 FROM audit_log WHERE action='academy_recon_attribute' AND entity_id=$1", [it.id]);
  assert.equal(aud.rowCount, 1);
  assert.equal((await items(a, 'status=resolved')).length, 1);
});

test('delivered supplier work reaches the P&L once, by venue/branch not programme; missing cost is an item, recording it resolves it; currencies are never summed', async () => {
  const a = await academy();
  const done = await supplierJob(a, { amount: 300000, quote: 200000 });
  const gbp = await supplierJob(a, { amount: 120000, currency: 'GBP', title: 'Kit order' });
  const p = await pnl(a);
  assert.ok(inr(p).totals.supplier_cost_minor == null, 'supplier cost has no programme so it is unattributed, not invented onto one');
  assert.equal(inr(p).totals.unattributed_cost_minor, 300000);
  assert.equal(cur(p, 'GBP').totals.unattributed_cost_minor, 120000, 'GBP is its own block');
  assert.equal(p.cost_sources.supplier_requests, 2);

  // delivered but no final cost: unmatched
  const missing = await supplierJob(a, { amount: 0, quote: 90000, title: 'Net replacement' });
  must(await run(a));
  const q = await items(a);
  const kinds = q.map((i) => i.kind).sort();
  assert.ok(kinds.includes('supplier_unmatched') && kinds.includes('supplier_variance') && kinds.filter((k) => k === 'cost_unlinked').length === 2, kinds.join());
  const unmatched = q.find((i) => i.kind === 'supplier_unmatched');
  assert.equal(unmatched.source_id, missing.id);
  assert.equal((await act(unmatched, { decision: 'record_cost', reason: 'Invoice received', amount_minor: 95000, currency: 'GBP' }, a.finance)).status, 409, 'the quote is INR; a different currency is refused, never converted');
  must(await act(unmatched, { decision: 'record_cost', reason: 'Invoice received', amount_minor: 95000, invoice_ref: 'INV-9' }, a.finance));
  const r = (await pool.query('SELECT actual_cost_minor, invoice_ref, row_version FROM academy_supplier_requests WHERE id=$1', [missing.id])).rows[0];
  assert.equal(Number(r.actual_cost_minor), 95000); assert.equal(r.invoice_ref, 'INV-9');
  assert.equal(inr(await pnl(a)).totals.unattributed_cost_minor, 395000);

  // attribute the INR job to the programme: it now shows as supplier cost of that programme
  const cu = (await items(a)).find((i) => i.kind === 'cost_unlinked' && i.source_id === done.id);
  must(await act(cu, { decision: 'attribute', reason: 'Resurfacing the U12 court', programme_id: a.programme.id }, a.owner));
  const p2 = await pnl(a);
  assert.equal(inr(p2).programmes[0].supplier_cost_minor, 300000);
  assert.equal(inr(p2).totals.unattributed_cost_minor, 95000);
  assert.ok(gbp.id);
});

test('a manual entry that repeats a delivered supplier request is held out and queued as a double-count risk; the person decides which record counts', async () => {
  const a = await academy();
  const q = await supplierJob(a, { amount: 150000 });
  const m = must(await api('POST', `/organisations/${a.org.id}/academy/cost-entries`, { token: a.finance.token, body: { category: 'other_direct', programme_id: a.programme.id, currency: 'INR', amount_minor: 150000, incurred_on: today, description: 'Court resurfacing (manual)', idempotency_key: key() } }), 201);
  let p = await pnl(a);
  assert.equal(inr(p).programmes.length, 0, 'the manual copy is not counted next to the supplier record');
  assert.equal(inr(p).totals.unattributed_cost_minor, 150000);
  assert.equal(p.cost_sources.manual_entries_superseded, 1);
  must(await run(a));
  const risk = (await items(a)).find((i) => i.kind === 'double_count_risk');
  assert.ok(risk); assert.equal(risk.detail.held_out_minor, 150000); assert.equal(risk.detail.manual_entry_id, m.id);
  assert.equal((await recon(a)).body.held_out_by_currency[0].minor, 150000);
  must(await act(risk, { decision: 'keep_manual', reason: 'We booked it by hand against the programme' }, a.finance));
  p = await pnl(a);
  assert.equal(inr(p).programmes[0].other_direct_cost_minor, 150000, 'the manual entry now counts');
  assert.equal(inr(p).totals.unattributed_cost_minor, 0, 'and the supplier request is left out: still counted once');
  assert.equal(p.provenance.cost_allocation_version, 2);
  assert.ok(q.id);
});

test('a manual staff entry covered by approved payroll is superseded; keeping the canonical record leaves the P&L unchanged and resolves the item', async () => {
  const a = await academy();
  const s1 = await session(a);
  await approvedRun(a, { sheets: [await sheet(a, s1, 400000)] });
  const m = must(await api('POST', `/organisations/${a.org.id}/academy/cost-entries`, { token: a.finance.token, body: { category: 'staff', programme_id: a.programme.id, currency: 'INR', amount_minor: 410000, incurred_on: today, description: 'Coach fees', idempotency_key: key() } }), 201);
  must(await run(a));
  const risk = (await items(a)).find((i) => i.kind === 'double_count_risk');
  assert.ok(risk && risk.source_id === m.id);
  must(await act(risk, { decision: 'keep_canonical', reason: 'Payroll run covers it' }, a.owner));
  assert.equal(inr(await pnl(a)).programmes[0].staff_cost_minor, 400000);
  assert.equal(must(await run(a)).opened, 0, 'a resolved item is not reopened by the next check');
});

test('payment-provider fees come from the Finance ledger onto their charge programme and cohort; unlinked revenue can be attributed', async () => {
  const a = await academy();
  const { charge: ch } = await charge(a, { amount: 100000 });
  const pay = (await pool.query("INSERT INTO payments(purpose_type, purpose_id, payer_id, amount_cents, currency, status, provider, paid_at) VALUES ('academy_charge',$1,$2,100000,'INR','paid','stripe',now()) RETURNING *", [ch.id, a.owner.id])).rows[0];
  await insert(pool, { kind: 'payment', module: 'registration', sourceType: 'academy_charge', sourceId: ch.id, payeeOrgId: a.org.id, currency: 'INR', gross: 100000, fee: 2900, provider: 'stripe', paymentId: pay.id, key: `payment:${pay.id}` });
  const p = await pnl(a);
  assert.equal(inr(p).programmes[0].payment_fee_minor, 2900);
  assert.equal(inr(p).totals.payment_fee_minor, 2900);
  assert.equal(inr(p).programmes[0].contribution_minor, 100000 - 2900, 'revenue is gross, so the fee is a cost and is counted once');
  const k = inr(p).by_cohort.find((x) => x.cohort_id === a.cohort.id);
  assert.equal(k.payment_fee_minor, 2900); assert.equal(k.management_revenue_minor, 100000);
  const rest = inr(p).by_cohort.find((x) => x.cohort_id === null && x.programme_id === a.programme.id);
  assert.equal(rest.management_revenue_minor, 0, 'cohorts plus the remainder add back to the programme');
  assert.equal(rest.contribution_minor, null, 'the remainder is shown as unknown, never zero');

  const u = await charge(a, { programme: null, amount: 40000, user: a.finance });
  assert.equal((await pool.query('SELECT programme_id FROM org_enrolments WHERE id=$1', [u.enrolment.id])).rows[0].programme_id, null);
  must(await run(a));
  const rev = (await items(a)).find((i) => i.kind === 'revenue_unlinked');
  assert.equal(rev.source_id, u.charge.id);
  assert.equal(inr(await pnl(a)).programmes.find((x) => x.programme_id === null).management_revenue_minor, 40000);
  must(await act(rev, { decision: 'attribute', reason: 'Legacy enrolment belongs to U12', programme_id: a.programme.id }, a.finance));
  const p2 = await pnl(a);
  assert.equal(inr(p2).programmes.length, 1);
  assert.equal(inr(p2).programmes[0].management_revenue_minor, 140000);
  assert.equal(Number((await pool.query('SELECT amount_minor FROM academy_charges WHERE id=$1', [u.charge.id])).rows[0].amount_minor), 40000, 'the charge itself is untouched');
});

test('unbooked sessions and unpriced timesheets are queue items that close themselves when the records agree again; currency mismatch is flagged, not summed', async () => {
  const a = await academy();
  const c = await court(50000);
  const s1 = await session(a, { day: addDays(today, 2) });
  await approvedRun(a, { sheets: [await sheet(a, s1, 100000)], unpriced: [{ timesheet_id: '00000000-0000-0000-0000-000000000000', reason: 'no rate' }] });
  await pool.query("INSERT INTO academy_programme_versions(programme_id, version, currency, fee_minor) VALUES ($1,1,'GBP',5000)", [a.programme.id]);
  must(await api('POST', `/organisations/${a.org.id}/academy/cost-entries`, { token: a.finance.token, body: { category: 'other_direct', programme_id: a.programme.id, currency: 'INR', amount_minor: 7000, incurred_on: today, description: 'Water and kit', idempotency_key: key() } }), 201);
  must(await run(a));
  const k = (await items(a)).map((i) => i.kind).sort();
  assert.deepEqual(k, ['currency_mismatch', 'payroll_unpriced', 'venue_unbooked'], k.join());
  must(await api('POST', `/academy/sessions/${s1.id}/venue`, { token: a.owner.token, body: { resource_id: c.resource.id } }), 201);
  const again = must(await run(a));
  assert.equal(again.closed, 1, 'the booking exists now, so the unbooked item closes itself');
  const open = (await items(a)).map((i) => i.kind).sort();
  assert.deepEqual(open, ['currency_mismatch', 'payroll_unpriced']);
  const cm = (await items(a)).find((i) => i.kind === 'currency_mismatch');
  must(await act(cm, { decision: 'dispute', reason: 'Asking the head coach which currency applies' }, a.finance));
  assert.equal((await act(cm, { decision: 'dispute', reason: 'again' }, a.finance)).status, 409);
  assert.equal((await items(a, 'status=disputed')).length, 1);
  assert.equal(must(await run(a)).opened, 0, 'a disputed item is not duplicated by the next check');
  must(await act(cm, { decision: 'resolve', reason: 'Entry is correct: paid locally in INR' }, a.finance));
  const sum = must(await recon(a));
  assert.deepEqual(sum.counts, { open: 1, disputed: 0, resolved: 2 });
  const h = must(await api('GET', `/academy/reconciliation/items/${cm.id}`, { token: a.finance.token })).history.map((x) => x.action);
  assert.deepEqual(h, ['dispute', 'resolve']);
});

test('the queue is the shared Finance queue; access is owner/admin/finance only; other organisations get 404; contract is on REST, OpenAPI and MCP', async () => {
  const a = await academy(), b = await academy('Other');
  const t = await sheet(a, null, 99000, null);
  await approvedRun(a, { sheets: [t] });
  must(await run(a));
  const [it] = await items(a);
  assert.equal((await recon(a, a.coach)).status, 403);
  assert.equal((await recon(a, b.finance)).status, 404, 'no existence leak');
  assert.equal((await api('GET', `/academy/reconciliation/items/${it.id}`, { token: b.owner.token })).status, 404);
  assert.equal((await act(it, { decision: 'resolve', reason: 'not yours' }, b.owner)).status, 404);
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/reconciliation`)).status, 401);
  assert.equal((await items(b)).length, 0);
  // the same row shows in the Finance console's own queue for the organisation
  const shared = must(await api('GET', `/finance/reconciliation?organisation_id=${a.org.id}`, { token: a.finance.token }));
  assert.ok((shared.items ?? shared).some((x) => x.id === it.id), 'one queue, not two');
  const spec = await (await fetch(`${base}/api/v1/openapi.json`)).json();
  for (const p of ['/organisations/{id}/academy/reconciliation', '/organisations/{id}/academy/reconciliation/run', '/organisations/{id}/academy/reconciliation/items', '/academy/reconciliation/items/{id}', '/academy/reconciliation/items/{id}/act']) assert.ok(spec.paths[p], p);
  const tools = await (await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${a.finance.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).text();
  for (const nme of ['get_academy_cost_reconciliation', 'run_academy_reconciliation', 'list_academy_recon_items', 'get_academy_recon_item', 'act_on_academy_recon_item']) assert.ok(tools.includes(nme), nme);
});
