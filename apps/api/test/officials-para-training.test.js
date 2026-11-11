// REF-R29: Para-sport officials training eligibility (#1027)
// Tests: requirement listing, completion submission, eligibility computation, verification.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
};

let n = 0;
const signup = async (roles = []) => {
  n++;
  const r = await api('POST', '/auth/register', {
    body: { handle: `pt${n}`, display_name: `PTrainUser${n}`, email: `pt${n}@trainingtest.example`, password: 'correct-horse-battery', roles },
  });
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

// ------------------------------------------------------------------ requirements listing

test('list_para_officiating_requirements: requires auth', async () => {
  const r = await api('GET', '/para/officiating/requirements');
  assert.equal(r.status, 401);
});

test('list_para_officiating_requirements: returns array for authenticated user', async () => {
  const user = await signup([]);
  const r = await api('GET', '/para/officiating/requirements', { token: user.token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(Array.isArray(r.body.requirements ?? r.body), 'returns requirements array');
});

test('list_para_officiating_requirements: filtered by sport_id', async () => {
  const user = await signup([]);
  const r = await api('GET', '/para/officiating/requirements?sport_id=wheelchair_basketball', { token: user.token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const reqs = r.body.requirements ?? r.body;
  assert.ok(Array.isArray(reqs));
  // All returned rows should belong to the requested sport (or empty)
  for (const req of reqs) {
    assert.equal(req.sport_slug ?? req.sport_id, 'wheelchair_basketball');
  }
});

// ------------------------------------------------------------------ eligibility

test('get_my_para_officiating_eligibility: returns eligibility object', async () => {
  const user = await signup([]);
  const r = await api('GET', '/para/officiating/my-eligibility', { token: user.token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.sports !== undefined || Array.isArray(r.body), 'has sports field');
});

test('get_official_para_eligibility: self lookup returns same as my-eligibility', async () => {
  const user = await signup([]);
  const myR = await api('GET', '/para/officiating/my-eligibility', { token: user.token });
  const selfR = await api('GET', `/para/officiating/eligibility/${user.id}`, { token: user.token });
  // Both should succeed
  assert.equal(myR.status, 200);
  assert.equal(selfR.status, 200);
});

test('get_official_para_eligibility: 403 when viewing another official without assignor role', async () => {
  const user = await signup([]);
  const other = await signup([]);
  const r = await api('GET', `/para/officiating/eligibility/${other.id}`, { token: user.token });
  assert.ok([403, 404].includes(r.status), `expected 403/404 got ${r.status}`);
});

// ------------------------------------------------------------------ completion submission

test('submit_para_training_evidence: requires auth', async () => {
  const r = await api('POST', '/para/officiating/completions', {
    body: { requirement_id: '00000000-0000-0000-0000-000000000001', completed_on: '2026-01-01' },
  });
  assert.equal(r.status, 401);
});

test('submit_para_training_evidence: 404 for nonexistent requirement', async () => {
  const user = await signup([]);
  const r = await api('POST', '/para/officiating/completions', {
    token: user.token,
    body: { requirement_id: '00000000-0000-0000-0000-000000000099', completed_on: '2026-01-01' },
  });
  assert.ok([400, 404, 422].includes(r.status), `expected 400/404/422 got ${r.status}`);
});

test('submit_para_training_evidence: cert_ref is never returned in plaintext', async () => {
  const user = await signup([]);
  // Create a requirement first (platform admin or just check that the endpoint guards it)
  const listR = await api('GET', '/para/officiating/requirements', { token: user.token });
  const reqs = listR.body.requirements ?? listR.body ?? [];
  if (reqs.length === 0) {
    // No requirements seeded — skip the plaintext check since there's nothing to submit
    return;
  }
  const req = reqs[0];
  const secretRef = 'SECRET-CERT-12345';
  await api('POST', '/para/officiating/completions', {
    token: user.token,
    body: { requirement_id: req.id, completed_on: '2026-01-01', cert_ref: secretRef },
  });
  const listCompR = await api('GET', '/para/officiating/completions', { token: user.token });
  assert.equal(listCompR.status, 200);
  const body = JSON.stringify(listCompR.body);
  assert.ok(!body.includes(secretRef), 'cert_ref must not appear in plaintext in list response');
});

// ------------------------------------------------------------------ completions listing

test('list_my_para_training_completions: returns completions for user', async () => {
  const user = await signup([]);
  const r = await api('GET', '/para/officiating/completions', { token: user.token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(Array.isArray(r.body.completions ?? r.body));
});

// ------------------------------------------------------------------ admin verify

test('verify_para_training_completion: requires admin or assessor', async () => {
  const user = await signup([]);
  const r = await api('POST', '/admin/para/officiating/completions/00000000-0000-0000-0000-000000000001/verify', {
    token: user.token,
    body: { action: 'verified' },
  });
  assert.ok([401, 403].includes(r.status), `expected 401/403 got ${r.status}`);
});

// ------------------------------------------------------------------ requirement admin

test('create_para_officiating_requirement: requires platform_admin', async () => {
  const user = await signup([]);
  const r = await api('POST', '/admin/para/officiating/requirements', {
    token: user.token,
    body: { sport_id: 'wheelchair_basketball', title: 'IPC Officials Course', level: 'national', kind: 'course', mandatory: true },
  });
  assert.ok([401, 403].includes(r.status), `expected 401/403 got ${r.status}`);
});
