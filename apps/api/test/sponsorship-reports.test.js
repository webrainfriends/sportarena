// Sponsorship portfolio reports (#305): ageing/funnel/outcomes/fulfilment/renewals dashboards, CSV/XLSX/PDF exports that reconcile to the source,
// cash vs estimates, live access and consent, saved filters (stale-version), scheduled delivery that dedupes, and the additive migration.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { parseCsv } from '../src/csv.js';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { deliverDueReports, nextRun } = await import('../src/sponsor-report-schedules.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `rp_${n}_${roles[0]}`, display_name: `Reporter ${n}`, email: `rp${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toISOString().slice(0, 10); };
const brandOf = async (name) => { const owner = await signup(['sponsor']); const b = must(await api('POST', '/sponsors', { token: owner.token, body: { name: `${name} ${n}` } }), 201); return { owner, b }; };
const athlete = async (name) => { const a = await signup(['athlete']); must(await api('POST', '/me/sponsorship-profile', { token: a.token, body: { open_to_sponsors: true } })); await pool.query('UPDATE users SET display_name=$2 WHERE id=$1', [a.id, name]); return a; };
const offer = async (w, ath, { lines, endsOn = day(200) } = {}) => {
  const d = must(await api('POST', '/sponsorships', { token: w.owner.token, body: { sponsor_id: w.b.id, target_type: 'athlete', target_id: ath.id, deliverables: 'Wear the kit', starts_on: day(1), ends_on: endsOn,
    lines: lines ?? [{ kind: 'money', label: 'Support', currency: 'SGD', amount_cents: 10000, cadence: 'monthly', instalments: 3, first_due_on: day(30) }] } }), 201);
  must(await api('PATCH', `/sponsorships/${d.id}`, { token: ath.token, body: { status: 'active', version: 1 } }));
  return d;
};
const dues = async (w, id) => (await api('GET', '/sponsorship-obligations', { token: w.owner.token, query: { sponsorship_id: id } })).body;
const report = (u, kind, query = {}) => api('GET', `/sponsorship-reports/${kind}`, { token: u.token, query: { limit: 100, ...query } });
const exp = (u, kind, format, query = {}) => api('GET', `/sponsorship-reports/${kind}/export`, { token: u.token, query: { format, ...query } });
const cur = (rows, c) => rows.find((r) => r.currency === c);
const decode = (f) => (f.encoding === 'base64' ? Buffer.from(f.content, 'base64') : f.content);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('ageing reconciles with the source totals; cash, reported and estimates stay separate; an unconfirmed payment is never cash', async () => {
  const w = await brandOf('Ageing'), ath = await athlete('Ana Ageing');
  const d = await offer(w, ath, { lines: [
    { kind: 'money', label: 'Support', currency: 'SGD', amount_cents: 10000, cadence: 'monthly', instalments: 3, first_due_on: day(30) },
    { kind: 'goods', label: 'Kit', quantity: 10, currency: 'SGD', estimate_cents: 70000, first_due_on: day(40) },
  ] });
  const o = (await dues(w, d.id)).obligations.filter((x) => x.kind === 'money');
  assert.equal(o.length, 3);
  const pay = (i, cents, ref) => api('POST', `/sponsorship-obligations/${o[i].id}/payments`, { token: w.owner.token, body: { amount_cents: cents, currency: 'SGD', method: 'bank_transfer', reference: ref, paid_on: day(0) } });
  const p1 = must(await pay(0, 10000, 'AG-1'), 201);
  must(await pay(1, 4000, 'AG-2'), 201);
  must(await api('PATCH', `/sponsorship-payments/${p1.id}`, { token: ath.token, body: { status: 'confirmed' } }));
  // time passes: the first instalment (paid) and the second fell due 45 days ago, the third 5 days ago
  await pool.query('UPDATE sponsorship_obligations SET due_on=$2 WHERE id=$1', [o[1].id, day(-45)]);
  await pool.query('UPDATE sponsorship_obligations SET due_on=$2 WHERE id=$1', [o[2].id, day(-5)]);

  const r = must(await report(w.owner, 'ageing'));
  assert.equal(r.basis.cash_and_estimates, 'separate');
  assert.equal(r.basis.currency_basis, 'native');
  const t = cur(r.totals, 'SGD');
  assert.deepEqual([t.committed_cents, t.cash_confirmed_cents, t.reported_unverified_cents, t.outstanding_cents], [30000, 10000, 4000, 20000], 'reported 4000 is not cash');
  assert.deepEqual([t.d31_60_cents, t.d1_30_cents, t.current_cents], [10000, 10000, 0], 'each instalment is in its own age bucket');
  assert.equal(t.estimate_cents, 70000, 'the goods estimate is its own column');
  assert.equal(r.reconciles, true);
  const cash = r.rows.filter((x) => x.basis === 'cash'), est = r.rows.filter((x) => x.basis === 'estimate');
  assert.equal(cash.reduce((s, x) => s + x.outstanding_cents, 0), t.outstanding_cents, 'rows add up to the total');
  assert.ok(est.every((x) => x.outstanding_cents === null && x.estimate_cents === 70000), 'an estimate never carries a cash outstanding');
  assert.ok(r.sources.find((s) => s.key === 'agreements').status === 'ok');

  // identical to the existing source read models
  const src = (await dues(w, d.id)).totals.find((x) => x.currency === 'SGD');
  assert.deepEqual([t.committed_cents, t.cash_confirmed_cents, t.reported_unverified_cents, t.outstanding_cents], [Number(src.committed_cents), Number(src.confirmed_cents), Number(src.reported_unverified_cents), Number(src.outstanding_cents)]);
  const rec = must(await api('GET', '/sponsorship-reconciliation', { token: w.owner.token })).find((x) => x.currency === 'SGD');
  assert.deepEqual([t.committed_cents, t.cash_confirmed_cents, t.outstanding_cents], [rec.committed_cents, rec.confirmed_cents, rec.outstanding_cents]);

  // a past reporting date counts only payments confirmed by then; the future is refused
  const before = must(await report(w.owner, 'ageing', { as_of: day(-1) }));
  assert.equal(cur(before.totals, 'SGD').cash_confirmed_cents, 0, 'nothing was confirmed yesterday');
  assert.equal(must(await report(w.owner, 'ageing', { bucket: '31_60' })).rows.filter((x) => x.basis === 'cash').length, 1);
  assert.equal((await report(w.owner, 'ageing', { as_of: day(3) })).status, 422);
});

test('exports are built from the dashboard rows: CSV, XLSX and PDF reconcile; reporting basis converts only at a sourced rate', async () => {
  const w = await brandOf('Export'), ath = await athlete('Eve Export');
  const d = await offer(w, ath, { lines: [{ kind: 'money', label: 'Support', currency: 'SGD', amount_cents: 12345, cadence: 'once', first_due_on: day(10) }] });
  const dash = must(await report(w.owner, 'ageing'));
  const csv = must(await exp(w.owner, 'ageing', 'csv'));
  assert.match(csv.filename, /^sponsorship-ageing-\d{4}-\d{2}-\d{2}\.csv$/);
  const rows = parseCsv(csv.content), head = rows[0];
  const sum = (key) => rows.slice(1).reduce((s, r) => s + Number(r[head.indexOf(key)] || 0), 0);
  assert.equal(rows.length - 1, dash.rows.length);
  assert.equal(sum('outstanding_cents'), cur(dash.totals, 'SGD').outstanding_cents, 'CSV total equals the dashboard total');
  assert.equal(sum('outstanding_cents'), 12345);

  const x = must(await exp(w.owner, 'ageing', 'xlsx'));
  const xb = decode(x);
  assert.equal(xb.subarray(0, 2).toString(), 'PK');
  const names = ['xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/worksheets/sheet3.xml'];
  for (const nm of names) assert.ok(xb.includes(nm), nm);
  // read sheet1 back out of the zip: the exported amount is the dashboard amount
  const at = xb.indexOf('xl/worksheets/sheet1.xml'), local = at - 30, size = xb.readUInt32LE(local + 18);
  const xml = inflateRawSync(xb.subarray(at + 'xl/worksheets/sheet1.xml'.length, at + 'xl/worksheets/sheet1.xml'.length + size)).toString();
  assert.match(xml, /<v>12345<\/v>/);
  const pdf = must(await exp(w.owner, 'ageing', 'pdf'));
  assert.equal(decode(pdf).subarray(0, 4).toString(), '%PDF');

  // spreadsheet formulas in text cannot run: a hostile name is neutralised in CSV
  await pool.query("UPDATE sponsors SET name='=HYPERLINK(\"x\")' WHERE id=$1", [w.b.id]);
  assert.ok(must(await exp(w.owner, 'ageing', 'csv')).content.includes("'=HYPERLINK"));

  // reporting basis: no sourced rate -> stays SGD and is flagged; with an explicit rate it converts
  const none = must(await report(w.owner, 'ageing', { currency_basis: 'reporting', currency: 'USD' }));
  assert.equal(cur(none.totals, 'SGD').outstanding_cents, 12345);
  assert.equal(none.sources.find((s) => s.key === 'fx').status, 'missing');
  assert.equal((await report(w.owner, 'ageing', { currency_basis: 'reporting' })).status, 422, 'a reporting basis needs its currency');
  assert.ok(d.id);
});

test('access: strangers are denied, other brands are invisible, the athlete sees their own agreements only', async () => {
  const w1 = await brandOf('Iso A'), w2 = await brandOf('Iso B'), a1 = await athlete('Iso Athlete'), a2 = await athlete('Other Athlete');
  await offer(w1, a1);
  await offer(w2, a2);
  const stranger = await signup(['coach']);
  assert.equal((await report(stranger, 'ageing')).status, 403, 'no brand role -> denied');
  assert.equal((await exp(stranger, 'ageing', 'csv')).status, 403);
  const mine = must(await report(w1.owner, 'ageing'));
  assert.ok(mine.rows.every((r) => r.sponsor_name.startsWith('Iso A')), 'only my brand');
  const forBrand2 = must(await report(w1.owner, 'ageing', { sponsor_ids: w2.b.id }));
  assert.equal(forBrand2.rows.length, 0, 'asking for another brand returns nothing, not its data');
  const own = must(await report(a1, 'ageing', { view: 'recipient' }));
  assert.ok(own.rows.length > 0 && own.rows.every((r) => r.recipient === 'Iso Athlete'));
  assert.equal(must(await report(a2, 'fulfilment', { view: 'recipient' })).rows.length, 0);
  assert.equal(must(await report(stranger, 'ageing', { view: 'recipient' })).rows.length, 0, 'a recipient view is always your own data');
  const csv = must(await exp(a1, 'ageing', 'csv', { view: 'recipient' }));
  assert.ok(!csv.content.includes('Iso B'));
});

test('outcomes honour the athlete\'s live consent, in the dashboard and in the export', async () => {
  const w = await brandOf('Outcomes'), ath = await athlete('Olive Outcomes');
  const d = await offer(w, ath);
  let r = must(await report(w.owner, 'outcomes'));
  assert.equal(r.rows[0].consent, 'not_shared');
  assert.equal(r.rows[0].agreed_objectives, null, 'nothing is read until the athlete shares');
  assert.equal(r.sources.find((s) => s.key === 'consent').status, 'missing');
  must(await api('POST', `/sponsorships/${d.id}/performance-access`, { token: ath.token, body: { enabled: true, scope: 'official' } }));
  r = must(await report(w.owner, 'outcomes'));
  assert.equal(r.rows[0].consent, 'shared');
  assert.equal(r.rows[0].agreed_objectives, 0);
  assert.equal(r.rows[0].scope, 'official only');
  must(await api('POST', `/sponsorships/${d.id}/performance-access`, { token: ath.token, body: { enabled: false, scope: 'official' } }));
  const csv = must(await exp(w.owner, 'outcomes', 'csv'));
  const rows = parseCsv(csv.content);
  assert.equal(rows[1][rows[0].indexOf('consent')], 'not_shared', 'the export follows the revocation at once');
  assert.equal(rows[1][rows[0].indexOf('agreed_objectives')], '');
});

test('outcomes measure agreed objectives against the shared evidence only, and reporting currency converts at the agreement\'s sourced rate', async () => {
  const w = await brandOf('Measured'), ath = await athlete('Mia Measured');
  const d = await offer(w, ath, { lines: [{ kind: 'money', label: 'Support', currency: 'SGD', amount_cents: 10000, cadence: 'once', first_due_on: day(10) }] });
  const sport = (await pool.query("SELECT id FROM sports WHERE slug='athletics'")).rows[0].id;
  const obj = (evidence, target) => pool.query(`INSERT INTO sponsorship_objectives(sponsorship_id, sport_id, metric, direction, evidence, target_value, window_start, window_end, status, proposed_by)
    VALUES ($1,$2,'sprint_time','lower',$3,$4,$5,$6,'agreed',$7)`, [d.id, sport, evidence, target, day(-30), day(30), w.owner.id]);
  await obj('approved_competition', 12); await obj('self_reported', 12);
  const perf = (prov, status, value) => pool.query(`INSERT INTO performances(user_id, sport_id, metric, value, points, recorded_by, provenance, status, unit, direction, achieved_on)
    VALUES ($1,$2,'sprint_time',$3,0,$1,$4,$5,'s','lower',$6)`, [ath.id, sport, value, prov, status, day(-2)]);
  await perf('approved_competition', 'approved', 11.5); await perf('self_reported', 'recorded', 11.0);
  must(await api('POST', `/sponsorships/${d.id}/performance-access`, { token: ath.token, body: { enabled: true, scope: 'official' } }));
  let row = must(await report(w.owner, 'outcomes')).rows[0];
  assert.deepEqual([row.agreed_objectives, row.measured, row.met, row.not_shared], [2, 1, 1, 1], 'official-only sharing: the self-reported objective is not read');
  must(await api('POST', `/sponsorships/${d.id}/performance-access`, { token: ath.token, body: { enabled: true, scope: 'all_evidence' } }));
  row = must(await report(w.owner, 'outcomes')).rows[0];
  assert.deepEqual([row.agreed_objectives, row.measured, row.met, row.not_shared], [2, 2, 2, 0]);
  assert.equal(row.latest_result_on, day(-2));
  assert.deepEqual(must(await report(ath, 'outcomes', { view: 'recipient' })).rows.map((r) => r.measured), [2], 'the athlete sees their own');

  // a sourced SGD->USD rate on the agreement's budget converts; without it the money stays SGD
  const b = (await pool.query(`INSERT INTO sponsorship_budgets(sponsor_id, kind, name, fiscal_year, currency, authorized_cents, fx_policy, created_by) VALUES ($1,'annual','FY',2026,'USD',1000000,'explicit',$2) RETURNING id`, [w.b.id, w.owner.id])).rows[0].id;
  const fx = (await pool.query(`INSERT INTO sponsorship_budget_fx_rates(budget_id, currency, rate, source, as_of, created_by) VALUES ($1,'SGD',0.75,'treasury',$2,$3) RETURNING id`, [b, day(0), w.owner.id])).rows[0].id;
  assert.equal(cur(must(await report(w.owner, 'ageing', { currency_basis: 'reporting', currency: 'USD' })).totals, 'SGD').outstanding_cents, 10000, 'no rate on the agreement yet');
  await pool.query('UPDATE sponsorships SET budget_id=$2, budget_fx_rate_id=$3 WHERE id=$1', [d.id, b, fx]);
  const conv = must(await report(w.owner, 'ageing', { currency_basis: 'reporting', currency: 'USD' }));
  assert.equal(cur(conv.totals, 'USD').outstanding_cents, 7500);
  assert.equal(cur(conv.totals, 'SGD'), undefined, 'nothing is left unconverted');
  assert.equal(conv.sources.find((x) => x.key === 'fx').status, 'ok');
  assert.equal(conv.rows[0].native_currency, 'SGD');
  assert.equal(conv.rows[0].fx_rate, 0.75);
});

test('funnel, fulfilment (dispatched is not delivered) and renewals dashboards', async () => {
  const w = await brandOf('Mixed'), ath = await athlete('Max Mixed');
  const d = await offer(w, ath, { endsOn: day(40), lines: [
    { kind: 'goods', label: 'Boots', quantity: 4, currency: 'SGD', estimate_cents: 20000, first_due_on: day(5) },
    { kind: 'endorsement', label: 'Posts', promoter: 'recipient', first_due_on: day(5) },
  ] });
  const goods = (await dues(w, d.id)).obligations.find((x) => x.kind === 'goods');
  await pool.query('UPDATE sponsorship_obligations SET due_on=$2 WHERE id=$1', [goods.id, day(-3)]); // time passes
  let f = must(await report(w.owner, 'fulfilment'));
  assert.equal(f.rows.find((x) => x.label === 'Boots').state, 'overdue');
  const del = must(await api('POST', `/sponsorship-obligations/${goods.id}/deliveries`, { token: w.owner.token, body: { quantity: 4 } }), 201);
  f = must(await report(w.owner, 'fulfilment'));
  assert.equal(f.rows.find((x) => x.label === 'Boots').state, 'in_transit', 'dispatched is not delivered');
  must(await api('PATCH', `/sponsorship-deliveries/${del.id}`, { token: ath.token, body: { status: 'received' } }));
  f = must(await report(w.owner, 'fulfilment'));
  assert.equal(f.rows.find((x) => x.label === 'Boots').state, 'fulfilled');
  assert.equal(f.totals.find((t) => t.kind === 'goods').fulfilled, 1);
  assert.equal(must(await report(w.owner, 'fulfilment', { state: 'upcoming' })).rows.length, 1);

  const rn = must(await report(w.owner, 'renewals'));
  assert.equal(rn.rows.length, 1);
  assert.equal(rn.rows[0].days_left, 40);
  assert.equal(rn.sources.find((s) => s.key === 'assessments').status, 'missing', 'no renewal intention recorded yet');
  assert.equal(must(await report(w.owner, 'renewals', { window_days: 7 })).rows.length, 0);

  // funnel: one application becomes an offer; offers are not awards until accepted
  let prog = must(await api('POST', '/sponsorship-programs', { token: w.owner.token, body: { sponsor_id: w.b.id, name: 'Funnel', currency: 'USD', budget_cents: 100000, max_award_cents: 60000 } }), 201);
  const rd = must(await api('POST', `/sponsorship-programs/${prog.id}/rounds`, { token: w.owner.token, body: { opens_on: day(-1), closes_on: day(30) } }), 201);
  prog = must(await api('POST', `/sponsorship-programs/${prog.id}/status`, { token: w.owner.token, body: { status: 'published', version: prog.row_version } }));
  const ap = must(await api('POST', `/program-rounds/${rd.id}/applications`, { token: ath.token, body: { target_type: 'athlete', target_id: ath.id, requested_cents: 30000, pitch: 'Please' } }), 201);
  let fu = must(await report(w.owner, 'funnel'));
  assert.deepEqual([fu.rows[0].applications, fu.rows[0].requested_cents, fu.rows[0].awarded_cents], [1, 30000, 0]);
  const v = (await api('GET', `/sponsorship-programs/${prog.id}`, { token: w.owner.token })).body.row_version;
  const won = must(await api('PATCH', `/program-applications/${ap.id}`, { token: w.owner.token, body: { decision: 'award', program_version: v, awarded_cents: 20000 } }));
  fu = must(await report(w.owner, 'funnel'));
  assert.deepEqual([fu.rows[0].offers_open, fu.rows[0].offered_cents, fu.rows[0].awarded_cents], [1, 20000, 0], 'an issued offer is offered, not awarded');
  must(await api('POST', `/program-awards/${won.award.id}/respond`, { token: ath.token, body: { decision: 'accept', offer_version: won.award.offer_version } }));
  fu = must(await report(w.owner, 'funnel'));
  assert.deepEqual([fu.rows[0].offers_accepted, fu.rows[0].offered_cents], [1, 0]);
});

test('saved filters: private, unique by name, and a stale edit gets 409', async () => {
  const w = await brandOf('Filters'), other = await brandOf('Filters other');
  const f = must(await api('POST', '/sponsorship-report-filters', { token: w.owner.token, body: { name: 'Monthly ageing', kind: 'ageing', params: { currency_basis: 'native', bucket: 'over_90' } } }), 201);
  assert.equal(f.row_version, 1);
  assert.equal((await api('POST', '/sponsorship-report-filters', { token: w.owner.token, body: { name: 'monthly AGEING', kind: 'ageing' } })).status, 409, 'unique per owner and report, ignoring case');
  assert.equal((await api('POST', '/sponsorship-report-filters', { token: (await signup(['coach'])).token, body: { name: 'No role', kind: 'ageing' } })).status, 403);
  assert.equal((await api('PATCH', `/sponsorship-report-filters/${f.id}`, { token: other.owner.token, body: { row_version: 1, name: 'Hijack' } })).status, 404, 'not yours');
  const u = must(await api('PATCH', `/sponsorship-report-filters/${f.id}`, { token: w.owner.token, body: { row_version: 1, name: 'Quarterly ageing' } }));
  assert.equal(u.row_version, 2);
  const stale = await api('PATCH', `/sponsorship-report-filters/${f.id}`, { token: w.owner.token, body: { row_version: 1, name: 'Late' } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.details?.code, 'stale_version');
  assert.deepEqual(must(await api('GET', '/sponsorship-report-filters', { token: w.owner.token })).map((x) => x.name), ['Quarterly ageing']);
  assert.deepEqual(must(await api('GET', '/sponsorship-report-filters', { token: other.owner.token })), []);
  must(await api('POST', `/sponsorship-report-filters/${f.id}/archive`, { token: w.owner.token, body: { row_version: 2 } }));
  assert.deepEqual(must(await api('GET', '/sponsorship-report-filters', { token: w.owner.token })), []);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sponsor_report_filters WHERE id=$1', [f.id])).rows[0].n, 1, 'archived, not deleted');
});

test('scheduled delivery is exactly-once across repeated sweeps and concurrent workers, follows live access, and carries no figures', async () => {
  const w = await brandOf('Schedule'), ath = await athlete('Sam Schedule');
  await offer(w, ath);
  const f = must(await api('POST', '/sponsorship-report-filters', { token: w.owner.token, body: { name: 'Weekly', kind: 'ageing' } }), 201);
  assert.equal((await api('POST', '/sponsorship-report-schedules', { token: w.owner.token, body: { filter_id: f.id, cadence: 'weekly', format: 'csv', first_run_on: day(0) } })).status, 422, 'must start in the future');
  const stranger = await signup(['coach']);
  assert.equal((await api('POST', '/sponsorship-report-schedules', { token: w.owner.token, body: { filter_id: f.id, cadence: 'weekly', format: 'csv', recipient_ids: [stranger.id] } })).status, 422, 'recipients need a reporting role');
  const s = must(await api('POST', '/sponsorship-report-schedules', { token: w.owner.token, body: { filter_id: f.id, cadence: 'weekly', format: 'xlsx', first_run_on: day(1) } }), 201);
  assert.deepEqual(s.recipient_ids, [w.owner.id]);
  assert.equal(await deliverDueReports(), 0, 'nothing is due yet');

  await pool.query('UPDATE sponsor_report_schedules SET next_run_on=current_date WHERE id=$1', [s.id]);
  const made = await Promise.all([deliverDueReports(), deliverDueReports(), deliverDueReports()]);
  assert.equal(made.reduce((a, b) => a + b, 0), 1, 'three workers prepare one run');
  assert.equal(await deliverDueReports(), 0, 'a repeated sweep does nothing');
  const runs = (await pool.query('SELECT * FROM sponsor_report_runs WHERE schedule_id=$1', [s.id])).rows;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'delivered');
  const notes = (await pool.query("SELECT * FROM notifications WHERE user_id=$1 AND kind='sponsorship_report'", [w.owner.id])).rows;
  assert.equal(notes.length, 1);
  assert.ok(!/SGD|\d+\.\d\d|\b\d{4,}\b/.test(notes[0].body.replace(/\d{4}-\d\d-\d\d/g, '')), 'the notice carries no figures');
  const after = (await pool.query('SELECT next_run_on::text AS n, last_run_on::text AS l, row_version FROM sponsor_report_schedules WHERE id=$1', [s.id])).rows[0];
  assert.equal(after.l, day(0));
  assert.ok(after.n > day(0));

  // opening the run re-reads under the recipient's live access; only the recipient can open it
  const run = must(await api('GET', `/sponsorship-report-runs/${runs[0].id}`, { token: w.owner.token }));
  assert.equal(run.kind, 'ageing');
  assert.equal(run.basis.as_of, day(0));
  assert.equal((await api('GET', `/sponsorship-report-runs/${runs[0].id}`, { token: stranger.token })).status, 404);
  const dl = must(await api('GET', `/sponsorship-report-runs/${runs[0].id}`, { token: w.owner.token, query: { download: 'true' } }));
  assert.match(dl.filename, /\.xlsx$/);
  assert.ok(must(await api('GET', '/sponsorship-report-runs', { token: w.owner.token })).some((x) => x.id === runs[0].id && x.mine));

  // a recipient who lost their role gets a skipped row and no notice
  await pool.query('UPDATE sponsor_report_schedules SET next_run_on=current_date, recipient_ids=$2 WHERE id=$1', [s.id, [stranger.id]]);
  assert.equal(await deliverDueReports(), 1);
  const skipped = (await pool.query('SELECT status FROM sponsor_report_runs WHERE schedule_id=$1 AND recipient_id=$2', [s.id, stranger.id])).rows[0];
  assert.equal(skipped.status, 'skipped_no_access');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind='sponsorship_report'", [stranger.id])).rows[0].n, 0);

  // pause stops it; a stale edit is refused
  const cur1 = (await api('GET', '/sponsorship-report-schedules', { token: w.owner.token })).body.find((x) => x.id === s.id);
  const paused = must(await api('PATCH', `/sponsorship-report-schedules/${s.id}`, { token: w.owner.token, body: { row_version: cur1.row_version, paused: true } }));
  assert.ok(paused.paused_at);
  assert.equal((await api('PATCH', `/sponsorship-report-schedules/${s.id}`, { token: w.owner.token, body: { row_version: cur1.row_version, paused: false } })).status, 409);
  await pool.query('UPDATE sponsor_report_schedules SET next_run_on=current_date WHERE id=$1', [s.id]);
  assert.equal(await deliverDueReports(), 0, 'paused schedules do not run');
});

test('nextRun advances on its rhythm and always lands in the future', () => {
  assert.equal(nextRun('2026-01-31', 'monthly', '2026-01-31'), '2026-02-28');
  assert.equal(nextRun('2026-01-05', 'weekly', '2026-03-01'), '2026-03-02');
  assert.equal(nextRun('2026-01-15', 'quarterly', '2026-01-15'), '2026-04-15');
});

test('migration is additive and repeatable: existing agreements and payments survive', async () => {
  const before = (await pool.query('SELECT (SELECT count(*) FROM sponsorships)::int AS d, (SELECT count(*) FROM sponsorship_payments)::int AS p, (SELECT count(*) FROM sponsorship_obligations)::int AS o')).rows[0];
  assert.ok(before.d > 0 && before.p > 0);
  await migrate();
  const after = (await pool.query('SELECT (SELECT count(*) FROM sponsorships)::int AS d, (SELECT count(*) FROM sponsorship_payments)::int AS p, (SELECT count(*) FROM sponsorship_obligations)::int AS o')).rows[0];
  assert.deepEqual(after, before);
  const t = (await pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name IN ('sponsor_report_filters','sponsor_report_schedules','sponsor_report_runs')")).rows[0].n;
  assert.equal(t, 3);
});
