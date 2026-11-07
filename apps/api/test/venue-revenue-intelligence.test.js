import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
await import('../src/capabilities/venue-revenue-intelligence.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
let n = 0;
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `ri_${n}_${roles[0]}`, display_name: `RI ${n}`, email: `ri${n}@example.com`, password: 'correct-horse-battery', roles } });
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

async function setup() {
  const owner = await signup(['venue_manager']);
  const stranger = await signup();
  const venue = ok(await api('POST', '/venues', { token: owner.token, body: { name: `RI Venue ${n}`, city: 'Chennai', sports: ['tennis'], timezone: 'Asia/Kolkata' } }), 201);
  return { owner, stranger, venue };
}

test('demand_heatmap returns 7x24 grid', async () => {
  const { owner, venue } = await setup();
  const body = ok(await api('GET', `/venues/${venue.id}/revenue-intel/demand`, { token: owner.token }));
  assert.ok(Array.isArray(body.rows), 'rows is array');
  assert.equal(body.rows.length, 7, 'one row per weekday');
  for (const row of body.rows) {
    assert.equal(row.hours.length, 24, 'one cell per hour');
  }
  assert.equal(body.observed_facts_only, true);
});

test('demand_heatmap requires auth', async () => {
  const { venue } = await setup();
  const r = await api('GET', `/venues/${venue.id}/revenue-intel/demand`);
  assert.ok(r.status === 401 || r.status === 403, `expected 401/403, got ${r.status}`);
});

test('utilisation_forecast returns insufficient_history when no bookings', async () => {
  const { owner, venue } = await setup();
  const body = ok(await api('GET', `/venues/${venue.id}/revenue-intel/forecast`, { token: owner.token }));
  assert.equal(body.insufficient_history, true);
});

test('noshow_risk_insight returns empty arrays when no data', async () => {
  const { owner, venue } = await setup();
  const body = ok(await api('GET', `/venues/${venue.id}/revenue-intel/noshow-risk`, { token: owner.token }));
  assert.ok(Array.isArray(body.by_hour_band));
  assert.ok(Array.isArray(body.by_day));
  assert.ok(Array.isArray(body.by_channel));
});

test('list_pricing_recommendations returns empty array initially', async () => {
  const { owner, venue } = await setup();
  const body = ok(await api('GET', `/venues/${venue.id}/revenue-intel/pricing-recommendations`, { token: owner.token }));
  assert.ok(Array.isArray(body.rows));
  assert.equal(body.rows.length, 0);
});

test('configure_dynamic_pricing requires venue manager role', async () => {
  const { stranger, venue } = await setup();
  const r = await api('PUT', `/venues/${venue.id}/revenue-intel/config`, {
    token: stranger.token,
    body: { automation_mode: 'manual', max_change_pct: 15 },
  });
  assert.ok(r.status === 403 || r.status === 404, `expected 403/404, got ${r.status}`);
});

test('configure_dynamic_pricing succeeds for venue owner', async () => {
  const { owner, venue } = await setup();
  const body = ok(await api('PUT', `/venues/${venue.id}/revenue-intel/config`, {
    token: owner.token,
    body: { automation_mode: 'manual', max_change_pct: 20 },
  }));
  assert.equal(body.automation_mode, 'manual');
  assert.equal(body.max_change_pct, 20);
});

test('get_dynamic_pricing_config returns saved config', async () => {
  const { owner, venue } = await setup();
  await api('PUT', `/venues/${venue.id}/revenue-intel/config`, {
    token: owner.token,
    body: { automation_mode: 'bounded_auto', max_change_pct: 10, min_price_cents: 1000 },
  });
  const body = ok(await api('GET', `/venues/${venue.id}/revenue-intel/config`, { token: owner.token }));
  assert.equal(body.automation_mode, 'bounded_auto');
  assert.equal(body.min_price_cents, 1000);
});

test('list_utilisation_recommendations returns empty array initially', async () => {
  const { owner, venue } = await setup();
  const body = ok(await api('GET', `/venues/${venue.id}/revenue-intel/utilisation-recommendations`, { token: owner.token }));
  assert.ok(Array.isArray(body.rows));
});

test('list_pricing_experiments returns empty array initially', async () => {
  const { owner, venue } = await setup();
  const body = ok(await api('GET', `/venues/${venue.id}/revenue-intel/experiments`, { token: owner.token }));
  assert.ok(Array.isArray(body.rows));
  assert.equal(body.rows.length, 0);
});
