// Org billing profile: versioning, effective-dating, history (#503).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base, n = 0;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `obp_${n}_${roles[0]}`, display_name: `Obp ${n}`, email: `obp${n}@example.com`, password: 'correct-horse-battery', roles } }); return { ...must(r, 201).user, token: r.body.token }; };

before(async () => {
  await migrate();
  const app = await createApp();
  server = app.listen(0);
  await new Promise((res) => server.once('listening', res));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => { server?.close(); await pool.end(); });

let ownerToken, orgId;

test('create org and owner', async () => {
  const owner = await signup(['org_owner']);
  ownerToken = owner.token;
  const r = await api('POST', '/organisations', { token: ownerToken, body: { name: 'Billing Profile Test Org', kind: 'academy' } });
  orgId = must(r, 201).organisation.id;
});

test('set_org_billing_profile: creates first profile', async () => {
  const r = await api('POST', `/org-billing-profiles/${orgId}`, {
    token: ownerToken,
    body: {
      legal_name: 'Test Academy India Pvt Ltd',
      trade_name: 'Test Academy',
      entity_type: 'private_limited',
      state_code: '27',
      invoice_prefix: 'TAC',
      invoice_series: '2025-26',
      gst_registration_status: 'regular',
      default_rate_bp: 1800,
      rounding_policy: 'half_up',
    },
  });
  const b = must(r);
  assert.ok(b.profile?.id, 'profile id expected');
  assert.equal(b.profile.legal_name, 'Test Academy India Pvt Ltd');
  assert.equal(b.profile.invoice_series, '2025-26');
});

test('get_org_billing_profile: returns current profile', async () => {
  const r = await api('GET', `/org-billing-profiles/${orgId}`, { token: ownerToken });
  const b = must(r);
  assert.ok(b.profile?.legal_name, 'profile expected');
  assert.equal(b.profile.invoice_series, '2025-26');
});

test('set_org_billing_profile: second version archives first', async () => {
  const r = await api('POST', `/org-billing-profiles/${orgId}`, {
    token: ownerToken,
    body: {
      legal_name: 'Test Academy India Pvt Ltd',
      trade_name: 'Test Academy v2',
      state_code: '27',
      invoice_prefix: 'TAC',
      invoice_series: '2026-27',
      gst_registration_status: 'regular',
      default_rate_bp: 1800,
      effective_from: '2026-04-01',
    },
  });
  const b = must(r);
  assert.equal(b.profile.invoice_series, '2026-27');
});

test('list_org_billing_profile_history: shows 2 versions', async () => {
  const r = await api('GET', `/org-billing-profiles/${orgId}/history`, { token: ownerToken });
  const b = must(r);
  assert.ok(b.history.length >= 2, `expected ≥ 2 versions, got ${b.history.length}`);
  assert.ok(b.history[0].effective_from >= b.history[1].effective_from, 'most recent first');
});
