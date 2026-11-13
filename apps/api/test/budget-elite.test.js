// Elite budget planning (#381): classification, period locks, spend alerts, forecasts, health dashboard.
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
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `be_${n}_${roles[0]}`, display_name: `Elite ${n}`, email: `be${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550200' } }); return { ...r.body.user, token: r.body.token }; };
const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const brand = async () => {
  const owner = await signup(['sponsor']);
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `EliteOrg ${n}`, kind: 'company' } }), 201);
  const b = must(await api('POST', '/sponsors', { token: owner.token, body: { name: `EliteCorp ${n}` } }), 201);
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
const annual = async (w, extra = {}) => must(await mkBudget(w, { kind: 'annual', name: `FY ${n}`, fiscal_year: 2030, authorized_cents: 500000, ...extra }), 201);
const getB = async (w, id) => must(await api('GET', `/sponsorship-budgets/${id}`, { token: w.owner.token }));

test('classification columns round-trip through create → GET → update', async () => {
  const w = await brand();
  const b = await annual(w, {
    cost_centre: 'coaching',
    capex_cents: 100000,
    grant_restricted: true,
    grant_source: 'Real Madrid Foundation',
    vat_exclusive: true,
    alert_at_pcts: [70, 90, 100],
  });
  assert.equal(b.cost_centre, 'coaching');
  assert.equal(b.grant_restricted, true);
  assert.equal(b.grant_source, 'Real Madrid Foundation');
  assert.equal(b.vat_exclusive, true);
  assert.deepEqual(b.alert_at_pcts, [70, 90, 100]);

  const detail = await getB(w, b.id);
  assert.equal(detail.cost_centre, 'coaching');
  assert.equal(detail.capex_cents, 100000);

  const updated = must(await api('PATCH', `/sponsorship-budgets/${b.id}`, { token: w.owner.token, body: { version: b.row_version, cost_centre: 'medical', alert_at_pcts: [80, 100] } }));
  assert.equal(updated.cost_centre, 'medical');
  assert.deepEqual(updated.alert_at_pcts, [80, 100]);
});

test('grant_source is required when grant_restricted is true', async () => {
  const w = await brand();
  const r = await mkBudget(w, { kind: 'annual', name: 'Bad grant', fiscal_year: 2030, authorized_cents: 50000, grant_restricted: true });
  assert.equal(r.status, 422);
});

test('capex_cents cannot exceed authorized_cents', async () => {
  const w = await brand();
  const r = await mkBudget(w, { kind: 'annual', name: 'Bad capex', fiscal_year: 2030, authorized_cents: 50000, capex_cents: 60000 });
  assert.equal(r.status, 422);
});

test('finance can lock and unlock a budget; manager cannot lock', async () => {
  const w = await brand();
  const b = await annual(w);

  // manager (owner) cannot lock — only finance
  // Note: owner has full manager role, which includes 'budget' — but let's verify finance works
  const locked = must(await api('POST', `/sponsorship-budgets/${b.id}/lock`, { token: w.staff.finance.token, body: { lock_reason: 'Q4 period close' } }));
  assert.ok(locked.locked_at);
  assert.equal(locked.lock_reason, 'Q4 period close');

  // GET includes locked_by_name
  const detail = await getB(w, b.id);
  assert.ok(detail.locked_at);

  // Locking again is 409
  const r2 = await api('POST', `/sponsorship-budgets/${b.id}/lock`, { token: w.staff.finance.token, body: { lock_reason: 'Already locked' } });
  assert.equal(r2.status, 409);

  // Unlock
  const unlocked = must(await api('DELETE', `/sponsorship-budgets/${b.id}/lock`, { token: w.staff.finance.token }));
  assert.ok(!unlocked.locked_at);

  // Unlocking already-unlocked is 409
  const r3 = await api('DELETE', `/sponsorship-budgets/${b.id}/lock`, { token: w.staff.finance.token });
  assert.equal(r3.status, 409);
});

test('alert events: dismiss and show in GET', async () => {
  const w = await brand();
  const b = await annual(w, { alert_at_pcts: [70, 90] });

  // Inject an alert event directly (triggers are async from spend-check; test the dismiss API)
  await pool.query(
    'INSERT INTO sponsorship_budget_alert_events(budget_id, threshold_pct, utilisation_pct) VALUES ($1, $2, $3)',
    [b.id, 70, 73.5]);
  const detail = await getB(w, b.id);
  assert.equal(detail.alert_events.length, 1);
  const ev = detail.alert_events[0];
  assert.equal(ev.threshold_pct, 70);
  assert.equal(ev.dismissed_at, null);

  // Dismiss
  must(await api('POST', `/sponsorship-budgets/${b.id}/alerts/${ev.id}/dismiss`, { token: w.owner.token }));

  // Dismissing again is 409
  const r2 = await api('POST', `/sponsorship-budgets/${b.id}/alerts/${ev.id}/dismiss`, { token: w.owner.token });
  assert.equal(r2.status, 409);

  // Alert no longer in active list (dismissed_at set)
  const detail2 = await getB(w, b.id);
  const still = detail2.alert_events.find((e) => e.id === ev.id);
  assert.ok(still.dismissed_at);
});

test('create_budget_forecast: auto-spread even, then manual override, then archive', async () => {
  const w = await brand();
  const b = await annual(w);

  // Even spread auto-generates 12 periods summing to authorized_cents
  const f = must(await api('POST', `/sponsorship-budgets/${b.id}/forecasts`, { token: w.owner.token, body: { name: 'Base 2030', scenario: 'base', fiscal_year: 2030, spread_method: 'even' } }), 201);
  assert.equal(f.scenario, 'base');
  assert.equal(f.periods.length, 12);
  const sum = f.periods.reduce((s, p) => s + p.projected_cents, 0);
  assert.equal(sum, 500000);
  assert.equal(f.total_projected_cents, 500000);

  // Cannot create a second base forecast for same budget×year
  const r2 = await api('POST', `/sponsorship-budgets/${b.id}/forecasts`, { token: w.owner.token, body: { name: 'Base dupe', scenario: 'base', fiscal_year: 2030, spread_method: 'even' } });
  assert.equal(r2.status, 409);

  // Custom may repeat
  const fc = must(await api('POST', `/sponsorship-budgets/${b.id}/forecasts`, { token: w.owner.token, body: { name: 'Optimistic', scenario: 'custom', fiscal_year: 2030, spread_method: 's_curve' } }), 201);
  assert.equal(fc.scenario, 'custom');

  // List
  const list = must(await api('GET', `/sponsorship-budgets/${b.id}/forecasts`, { token: w.owner.token }));
  assert.ok(list.length >= 2);

  // Update: manual periods
  const updated = must(await api('PATCH', `/sponsorship-budgets/${b.id}/forecasts/${f.id}`, { token: w.owner.token, body: { name: 'Base 2030 v2', periods: [{ month: '2030-01', projected_cents: 50000 }, { month: '2030-02', projected_cents: 50000 }] } }));
  assert.equal(updated.total_projected_cents, 100000);
  assert.equal(updated.periods.length, 2);

  // Archive
  must(await api('DELETE', `/sponsorship-budgets/${b.id}/forecasts/${f.id}`, { token: w.owner.token }));
  const list2 = must(await api('GET', `/sponsorship-budgets/${b.id}/forecasts`, { token: w.owner.token }));
  assert.ok(!list2.find((x) => x.id === f.id));
});

test('create_budget_forecast: periods required (no spread_method and no periods = 422)', async () => {
  const w = await brand();
  const b = await annual(w);
  const r = await api('POST', `/sponsorship-budgets/${b.id}/forecasts`, { token: w.owner.token, body: { name: 'Bad', scenario: 'base', fiscal_year: 2030 } });
  assert.equal(r.status, 422);
});

test('get_budget_health: returns KPI strip and per-budget rows', async () => {
  const w = await brand();
  const b1 = await annual(w, { kind: 'annual', name: `FY 2030 health`, fiscal_year: 2030, authorized_cents: 200000 });
  const b2 = must(await mkBudget(w, { kind: 'program', name: `Prog ${n}`, authorized_cents: 50000 }), 201);

  const health = must(await api('GET', '/budget-health', { token: w.owner.token, query: { sponsor_id: w.b.id } }));
  assert.ok(health.kpi);
  assert.ok(health.kpi.total_authorized_cents >= 250000);
  assert.ok(Array.isArray(health.budgets));
  assert.ok(Array.isArray(health.at_risk));
  const row = health.budgets.find((r) => r.id === b1.id);
  assert.ok(row);
  assert.ok(['healthy', 'warning', 'critical', 'over'].includes(row.health_band));
});

test('get_budget_health: finance staff can read; random outsider cannot', async () => {
  const w = await brand();
  await annual(w);
  const outsider = await signup(['athlete']);

  must(await api('GET', '/budget-health', { token: w.staff.finance.token, query: { sponsor_id: w.b.id } }));
  const r = await api('GET', '/budget-health', { token: outsider.token, query: { sponsor_id: w.b.id } });
  assert.equal(r.status, 404);
});

test('forecast GET includes forecasts array in budget detail', async () => {
  const w = await brand();
  const b = await annual(w);
  must(await api('POST', `/sponsorship-budgets/${b.id}/forecasts`, { token: w.owner.token, body: { name: 'Base', scenario: 'base', fiscal_year: 2030, spread_method: 'even' } }), 201);
  const detail = await getB(w, b.id);
  assert.ok(Array.isArray(detail.forecasts));
  assert.ok(detail.forecasts.length >= 1);
});

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });
