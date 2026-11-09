// Tests for officials-payout-account capability (#1018).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp',
  SETTLEMENT_CURRENCIES: 'GBP',
  SETTLEMENT_PAYOUTS: 'on',
  APP_URL: 'http://app.test',
  CORS_ORIGINS: 'http://app.test',
});

const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { capabilities } = await import('../src/registry.js');

let server, base, n = 0;

const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(
    `${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`,
    { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }
  );
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };

const mkUser = async (roles = ['referee']) => {
  n++;
  const id = (await pool.query(
    "INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ($1,$1,$2,'x','x',$1) RETURNING id",
    [`opat_${n}`, `{${roles.join(',')}}`])).rows[0].id;
  return { id, token: await signToken({ id, roles }) };
};
const mkAdmin = async () => {
  n++;
  const id = (await pool.query(
    "INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ($1,$1,'{admin,platform_admin}','x','x',$1) RETURNING id",
    [`opat_adm_${n}`])).rows[0].id;
  const emails = JSON.parse(process.env.PLATFORM_ADMIN_EMAILS ?? '[]');
  if (emails[0]) {
    const { blindIndex } = await import('../src/crypto.js');
    await pool.query('UPDATE users SET email_idx=$1 WHERE id=$2', [blindIndex(emails[0]), id]);
  }
  return { id, token: await signToken({ id, roles: ['admin', 'platform_admin'] }) };
};

const validAccount = (officialId, overrides = {}) => ({
  currency: 'GBP', payee_type: 'individual', legal_name: 'Jane Smith',
  tax_country: 'GB', tax_id: 'AB123456C', method: 'bank_transfer',
  holder_name: 'Jane Smith', account_number: '12345678', bank_code: '204060',
  payout_schedule: 'monthly', ...overrides,
});

before(async () => {
  await migrate(pool);
  const app = createApp();
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

// ---- capability registration -----------------------------------------------
test('capability registered', () => {
  const names = capabilities.map(c => c.name);
  assert.ok(names.includes('set_official_payout_account'),     'set_official_payout_account missing');
  assert.ok(names.includes('get_official_payout_account'),     'get_official_payout_account missing');
  assert.ok(names.includes('get_official_fee_disclosure'),     'get_official_fee_disclosure missing');
  assert.ok(names.includes('list_official_payout_history'),    'list_official_payout_history missing');
  assert.ok(names.includes('list_official_payout_failures'),   'list_official_payout_failures missing');
  assert.ok(names.includes('resolve_official_payout_failure'), 'resolve_official_payout_failure missing');
  assert.ok(names.includes('list_admin_official_payout_accounts'), 'admin list missing');
  assert.ok(names.includes('hold_official_payout_account'),    'hold missing');
  assert.ok(names.includes('release_official_payout_account'),'release missing');
  assert.ok(names.includes('verify_official_payout_account'),  'verify missing');
  assert.ok(names.includes('reveal_official_payout_account'),  'reveal missing');
  assert.ok(names.includes('list_official_payout_audit'),      'audit trail missing');
});

// ---- 404 before account exists ----------------------------------------------
test('GET before account exists returns 404', async () => {
  const official = await mkUser();
  const r = await api('GET', `/officials/${official.id}/payout-account`, { token: official.token, query: { currency: 'GBP' } });
  assert.equal(r.status, 404);
});

// ---- create account ---------------------------------------------------------
test('PUT creates payout account', async () => {
  const official = await mkUser();
  const r = await api('PUT', `/officials/${official.id}/payout-account`, { token: official.token, body: validAccount(official.id) });
  const body = must(r, 201);
  assert.equal(body.status, 'pending');
  assert.equal(body.last4, '5678');
  assert.ok(!body.details_enc, 'details_enc must not be in response');
  assert.ok(!body.legal_name_enc, 'legal_name_enc must not be in response');
});

// ---- GET own account (masked) -----------------------------------------------
test('GET returns masked account', async () => {
  const official = await mkUser();
  await api('PUT', `/officials/${official.id}/payout-account`, { token: official.token, body: validAccount(official.id) });
  const body = must(await api('GET', `/officials/${official.id}/payout-account`, { token: official.token, query: { currency: 'GBP' } }));
  assert.equal(body.last4, '5678');
  assert.ok(!body.details_enc);
  assert.ok(!body.legal_name_enc);
  assert.ok(!body.tax_id_enc);
});

// ---- idempotency / replace ---------------------------------------------------
test('second PUT supersedes first and re-pends', async () => {
  const official = await mkUser();
  const r1 = must(await api('PUT', `/officials/${official.id}/payout-account`, { token: official.token, body: validAccount(official.id) }), 201);
  const r2 = must(await api('PUT', `/officials/${official.id}/payout-account`, { token: official.token, body: validAccount(official.id, { account_number: '87654321' }) }), 201);
  assert.equal(r2.last4, '4321');
  assert.equal(r2.status, 'pending');
  // old is superseded
  const rows = (await pool.query('SELECT status FROM payout_accounts WHERE id=$1', [r1.id])).rows;
  assert.equal(rows[0]?.status, 'superseded');
});

// ---- cross-official isolation (404 not 403) ----------------------------------
test('official A cannot read official B account — returns 404', async () => {
  const a = await mkUser();
  const b = await mkUser();
  await api('PUT', `/officials/${b.id}/payout-account`, { token: b.token, body: validAccount(b.id) });
  const r = await api('GET', `/officials/${b.id}/payout-account`, { token: a.token, query: { currency: 'GBP' } });
  assert.equal(r.status, 404, 'must return 404, not 403, to avoid leaking existence');
});

// ---- fee disclosure ---------------------------------------------------------
test('fee disclosure returns payor and fee structure', async () => {
  const official = await mkUser();
  const body = must(await api('GET', `/officials/${official.id}/payout-account/fee-disclosure`, { token: official.token, query: { currency: 'GBP' } }));
  assert.ok('platform_fee_bp' in body);
  assert.ok('payor' in body);
  assert.equal(body.currency, 'GBP');
});

// ---- payout schedule update -------------------------------------------------
test('PATCH schedule updates schedule', async () => {
  const official = await mkUser();
  await api('PUT', `/officials/${official.id}/payout-account`, { token: official.token, body: validAccount(official.id) });
  const body = must(await api('PATCH', `/officials/${official.id}/payout-account/schedule`, { token: official.token, body: { payout_schedule: 'weekly' } }));
  assert.equal(body.payout_schedule, 'weekly');
});

// ---- admin: list accounts ---------------------------------------------------
test('admin can list official payout accounts', async () => {
  const admin = await mkAdmin();
  const official = await mkUser();
  await api('PUT', `/officials/${official.id}/payout-account`, { token: official.token, body: validAccount(official.id) });
  const body = must(await api('GET', '/admin/officials/payout-accounts', { token: admin.token, query: { status: 'pending', limit: 10, offset: 0 } }));
  assert.ok(Array.isArray(body));
});

// ---- admin: verify / reject -------------------------------------------------
test('admin can verify then hold then release', async () => {
  const admin = await mkAdmin();
  const official = await mkUser();
  const { id: accId } = must(await api('PUT', `/officials/${official.id}/payout-account`, { token: official.token, body: validAccount(official.id) }), 201);

  // verify
  const v = must(await api('POST', `/admin/officials/payout-accounts/${accId}/verify`, { token: admin.token, body: { decision: 'verify', reason: 'ID documents checked' } }));
  assert.equal(v.status, 'verified');

  // hold
  const h = must(await api('POST', `/admin/officials/payout-accounts/${accId}/hold`, { token: admin.token, body: { reason: 'Fraud review' } }));
  assert.ok(h.held_at);

  // cannot hold again
  const h2 = await api('POST', `/admin/officials/payout-accounts/${accId}/hold`, { token: admin.token, body: { reason: 'Again' } });
  assert.equal(h2.status, 409);

  // release
  const rel = must(await api('POST', `/admin/officials/payout-accounts/${accId}/release`, { token: admin.token, body: {} }));
  assert.ok(rel.released_at);
});

test('admin cannot verify own account', async () => {
  const admin = await mkAdmin();
  const accId = must(await api('PUT', `/officials/${admin.id}/payout-account`, { token: admin.token, body: validAccount(admin.id) }), 201).id;
  const r = await api('POST', `/admin/officials/payout-accounts/${accId}/verify`, { token: admin.token, body: { decision: 'verify', reason: 'self-approve' } });
  assert.equal(r.status, 403);
});

// ---- admin: reveal (audit-logged) -------------------------------------------
test('reveal writes to official_payout_audit', async () => {
  const admin = await mkAdmin();
  const official = await mkUser();
  const { id: accId } = must(await api('PUT', `/officials/${official.id}/payout-account`, { token: official.token, body: validAccount(official.id) }), 201);

  must(await api('GET', `/admin/officials/payout-accounts/${accId}/reveal`, { token: admin.token, query: { fields: ['bank_details','legal_name'] } }));

  const audit = (await pool.query('SELECT action FROM official_payout_audit WHERE account_id=$1 ORDER BY created_at', [accId])).rows;
  const actions = audit.map(r => r.action);
  assert.ok(actions.includes('reveal_account_number'), 'bank reveal not audited');
  assert.ok(actions.includes('reveal_legal_name'), 'legal name reveal not audited');
});

// ---- payout history (empty) -------------------------------------------------
test('history returns empty array before any payouts', async () => {
  const official = await mkUser();
  await api('PUT', `/officials/${official.id}/payout-account`, { token: official.token, body: validAccount(official.id) });
  const body = must(await api('GET', `/officials/${official.id}/payout-account/history`, { token: official.token, query: { currency: 'GBP', limit: 25, offset: 0 } }));
  assert.ok(Array.isArray(body));
});

// ---- failures ---------------------------------------------------------------
test('failure lifecycle: create, list, resolve', async () => {
  const admin = await mkAdmin();
  const official = await mkUser();
  const { id: accId } = must(await api('PUT', `/officials/${official.id}/payout-account`, { token: official.token, body: validAccount(official.id) }), 201);

  // record a failure via admin endpoint
  const f = must(await api('POST', `/admin/officials/payout-accounts/${accId}/failures`, {
    token: admin.token,
    body: { accountId: accId, officialId: official.id, failure_code: 'invalid_account', failure_message: 'Account not found', amount_cents: 5000, currency: 'GBP' },
  }), 201);
  assert.ok(f.id);

  // official sees the failure
  const list = must(await api('GET', `/officials/${official.id}/payout-account/failures`, { token: official.token, query: { resolved: 'false', limit: 10, offset: 0 } }));
  assert.ok(list.some(x => x.id === f.id));

  // resolve
  const res = must(await api('POST', `/officials/${official.id}/payout-account/failures/${f.id}/resolve`, { token: official.token, body: {} }));
  assert.ok(res.resolved_at);

  // gone from open failures
  const list2 = must(await api('GET', `/officials/${official.id}/payout-account/failures`, { token: official.token, query: { resolved: 'false', limit: 10, offset: 0 } }));
  assert.ok(!list2.some(x => x.id === f.id));
});

// ---- audit trail ---------------------------------------------------------------
test('audit trail lists events for admin', async () => {
  const admin = await mkAdmin();
  const official = await mkUser();
  const { id: accId } = must(await api('PUT', `/officials/${official.id}/payout-account`, { token: official.token, body: validAccount(official.id) }), 201);
  await api('POST', `/admin/officials/payout-accounts/${accId}/verify`, { token: admin.token, body: { decision: 'verify', reason: 'All good' } });
  const trail = must(await api('GET', `/admin/officials/payout-accounts/${accId}/audit`, { token: admin.token, query: { limit: 25, offset: 0 } }));
  assert.ok(Array.isArray(trail));
  assert.ok(trail.some(e => e.action === 'admin_verify'));
});

// ---- non-admin cannot call admin routes -------------------------------------
test('regular user cannot access admin routes', async () => {
  const official = await mkUser();
  const r = await api('GET', '/admin/officials/payout-accounts', { token: official.token, query: { limit: 10, offset: 0 } });
  assert.ok([401, 403].includes(r.status));
});
