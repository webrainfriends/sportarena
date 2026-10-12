import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { capabilities } = await import('../src/capabilities/index.js');
const { sha256 } = await import('../src/crypto.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const rpc = async (name, args, token) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const res = (await r.json()).result;
  return res.isError ? { error: JSON.parse(res.content[0].text) } : { ok: res.structuredContent.result };
};
let n = 0;
const signup = async (roles) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `scope_${n}`, display_name: `Scope ${n}`, email: `scope${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const mint = async (u, body) => {
  const r = await api('POST', '/me/tokens', { token: u.token, body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};
const ZERO = '00000000-0000-4000-8000-000000000001';

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('every capability is classified into exactly one scope class', () => {
  const classes = new Set(capabilities.map((c) => c.scope));
  assert.deepEqual([...classes].sort(), ['admin', 'clinical', 'payment', 'read', 'write']);
  const by = Object.fromEntries(capabilities.map((c) => [c.name, c.scope]));
  assert.equal(by.get_me, 'read');
  assert.equal(by.create_booking, 'write');
  assert.equal(by.create_payment, 'payment');
  assert.equal(by.list_medical_records, 'clinical');
  assert.equal(by.add_medical_record, 'clinical');
  assert.equal(by.list_wellness, 'clinical');
  assert.equal(by.create_api_token, 'admin');
  assert.equal(by.refund_payment, 'admin');
});

test('a read-only token cannot book, pay or read clinical data - REST and MCP', async () => {
  const u = await signup(['athlete']);
  const ro = await mint(u, { name: 'reader' }); // default scope = read
  assert.deepEqual(ro.scopes, ['read']);
  assert.equal((await api('GET', '/me', { token: ro.token })).body.id, u.id, 'reads work');

  const booking = { resource_id: ZERO, starts_at: new Date(Date.now() + 864e5).toISOString(), ends_at: new Date(Date.now() + 864e5 + 36e5).toISOString() };
  const payment = { purpose_type: 'venue_invoice', purpose_id: ZERO, provider: 'stripe' };
  for (const [method, path, body] of [['POST', '/bookings', booking], ['POST', '/payments', payment], ['POST', '/teams', { name: 'T', sport: 'football' }]]) {
    const r = await api(method, path, { token: ro.token, body });
    assert.equal(r.status, 403, `${path}: ${JSON.stringify(r.body)}`);
  }
  assert.equal((await api('GET', '/medical/records', { token: ro.token })).status, 403, 'clinical read refused');
  assert.equal((await api('GET', '/me/wellness', { token: ro.token })).status, 403);
  // the same user session (no token restriction) is unaffected by the scope
  assert.equal((await api('GET', '/medical/records', { token: u.token })).status, 200);

  assert.equal((await rpc('get_me', {}, ro.token)).ok.id, u.id);
  assert.equal((await rpc('create_booking', booking, ro.token)).error.code, 'forbidden');
  assert.equal((await rpc('create_payment', payment, ro.token)).error.code, 'forbidden');
  assert.equal((await rpc('list_medical_records', {}, ro.token)).error.code, 'forbidden');
});

test('write does not imply payment or clinical; each scope must be granted; tokens cannot mint tokens', async () => {
  const u = await signup(['athlete']);
  const wr = await mint(u, { name: 'writer', scopes: ['write'] });
  assert.equal((await api('POST', '/teams', { token: wr.token, body: { name: 'Scoped FC', sport: 'football' } })).status, 201);
  assert.equal((await api('GET', '/teams', { token: wr.token })).status, 200, 'write implies read');
  assert.equal((await api('POST', '/payments', { token: wr.token, body: { purpose_type: 'venue_invoice', purpose_id: ZERO, provider: 'stripe' } })).status, 403);
  assert.equal((await api('GET', '/medical/records', { token: wr.token })).status, 403);
  assert.equal((await api('POST', '/me/tokens', { token: wr.token, body: { name: 'child', scopes: ['read'] } })).status, 403, 'a token cannot create tokens');
  assert.equal((await api('PATCH', '/me/roles', { token: wr.token, body: { add: ['coach'] } })).status, 403);

  const clin = await mint(u, { name: 'clin', scopes: ['clinical'] });
  assert.equal((await api('GET', '/medical/records', { token: clin.token })).status, 200);
  assert.equal((await api('POST', '/teams', { token: clin.token, body: { name: 'Nope FC', sport: 'football' } })).status, 403);

  // the user's own permissions still apply: an athlete's token cannot use the admin scope
  assert.equal((await api('POST', '/me/tokens', { token: u.token, body: { name: 'adm', scopes: ['admin'] } })).status, 400);
  assert.equal((await api('GET', '/admin/cases', { token: clin.token })).status, 403);
  // 'full' is never accepted on creation; unknown scopes are rejected
  assert.equal((await api('POST', '/me/tokens', { token: u.token, body: { name: 'f', scopes: ['full'] } })).status, 400);
  assert.equal((await api('POST', '/me/tokens', { token: u.token, body: { name: 'f', scopes: [] } })).status, 400);
});

test('expired and revoked tokens fail immediately (REST and MCP)', async () => {
  const u = await signup(['athlete']);
  const soon = await mint(u, { name: 'soon', scopes: ['read'], expires_at: new Date(Date.now() + 3600e3).toISOString() });
  assert.equal((await api('GET', '/me', { token: soon.token })).status, 200);
  assert.equal((await api('POST', '/me/tokens', { token: u.token, body: { name: 'past', expires_at: '2020-01-01T00:00:00Z' } })).status, 400, 'expiry must be in the future');
  await pool.query("UPDATE api_tokens SET expires_at = now() - interval '1 second' WHERE id=$1", [soon.id]);
  assert.equal((await api('GET', '/me', { token: soon.token })).status, 401);
  assert.equal((await rpc('get_me', {}, soon.token)).error.code, 'unauthorized');
  const list = (await api('GET', '/me/tokens', { token: u.token })).body.find((t) => t.id === soon.id);
  assert.equal(list.expired, true);

  const live = await mint(u, { name: 'live' });
  assert.equal((await api('GET', '/me', { token: live.token })).status, 200);
  assert.equal((await api('DELETE', `/me/tokens/${live.id}`, { token: u.token })).status, 200);
  assert.equal((await api('GET', '/me', { token: live.token })).status, 401);
  assert.equal((await rpc('get_me', {}, live.token)).error.code, 'unauthorized');
});

test('resource-restricted tokens only reach the venues/teams they name', async () => {
  const m = await signup(['venue_manager']);
  const a = (await api('POST', '/venues', { token: m.token, body: { name: 'Venue A' } })).body;
  const b = (await api('POST', '/venues', { token: m.token, body: { name: 'Venue B' } })).body;
  const t = await mint(m, { name: 'venue A only', scopes: ['write'], resources: [{ type: 'venue', id: a.id }] });
  assert.deepEqual(t.resources, [{ type: 'venue', id: a.id }]);
  assert.equal((await api('PATCH', `/venues/${a.id}`, { token: t.token, body: { city: 'Pune' } })).status, 200);
  assert.equal((await api('PATCH', `/venues/${b.id}`, { token: t.token, body: { city: 'Pune' } })).status, 403);
  assert.equal((await api('POST', '/teams', { token: t.token, body: { name: 'No resource ref', sport: 'football' } })).status, 403, 'calls that name no allowed resource are refused');
  assert.equal((await rpc('update_venue', { id: b.id, city: 'X' }, t.token)).error.code, 'forbidden');
  assert.equal((await rpc('update_venue', { id: a.id, city: 'Goa' }, t.token)).ok.city, 'Goa');
  assert.equal((await api('POST', '/me/tokens', { token: m.token, body: { name: 'bad', resources: [{ type: 'planet', id: a.id }] } })).status, 400);
});

test('legacy tokens are migrated to a visible full scope and keep working; they cannot be widened or narrowed silently', async () => {
  const u = await signup(['athlete']);
  const secret = 'sa_legacy_test_token_value_0001';
  // simulate a pre-migration row: it has no scopes column value supplied, as before - the migration default made it 'full'
  await pool.query("INSERT INTO api_tokens(user_id, name, token_hash, scopes) VALUES ($1,'old',$2,ARRAY['full'])", [u.id, sha256(secret)]);
  assert.equal((await api('POST', '/teams', { token: secret, body: { name: 'Legacy FC', sport: 'football' } })).status, 201);
  const row = (await api('GET', '/me/tokens', { token: u.token })).body.find((x) => x.name === 'old');
  assert.deepEqual(row.scopes, ['full']);
  assert.equal(row.legacy_full, true);
  const col = await pool.query("SELECT column_default FROM information_schema.columns WHERE table_name='api_tokens' AND column_name='scopes'");
  assert.match(col.rows[0].column_default, /read/, 'new rows default to read-only, not full');
  await assert.rejects(pool.query("INSERT INTO api_tokens(user_id, name, token_hash, scopes) VALUES ($1,'x',$2,ARRAY['root'])", [u.id, sha256('sa_x')]), /api_tokens_scopes_known/);
  // listing never returns the secret or its hash
  assert.ok(!JSON.stringify(row).includes(secret) && !('token_hash' in row));
});

test('MCP parity: a write token calls a write tool; a team-restricted token is refused for an unlisted team; dead tokens fail on /mcp', async () => {
  const u = await signup(['athlete']);
  const wr = await mint(u, { name: 'mcp writer', scopes: ['write'] });
  const made = await rpc('create_team', { name: 'MCP FC', sport: 'football' }, wr.token);
  assert.ok(made.ok?.id, JSON.stringify(made));
  assert.equal((await rpc('list_medical_records', {}, wr.token)).error.code, 'forbidden', 'write is not clinical');

  const mine = (await api('POST', '/teams', { token: u.token, body: { name: 'Allowed FC', sport: 'football' } })).body;
  const other = (await api('POST', '/teams', { token: u.token, body: { name: 'Unlisted FC', sport: 'football' } })).body;
  const rt = await mint(u, { name: 'one team', scopes: ['write'], resources: [{ type: 'team', id: mine.id }] });
  assert.equal((await rpc('update_team', { id: other.id, name: 'Hijack' }, rt.token)).error.code, 'forbidden', 'unlisted team denied over MCP');
  assert.equal((await api('PATCH', `/teams/${other.id}`, { token: rt.token, body: { name: 'Hijack' } })).status, 403, 'and over REST');
  assert.ok((await rpc('update_team', { id: mine.id, name: 'Renamed FC' }, rt.token)).ok, 'listed team allowed over MCP');

  // raw /mcp requests with an expired or revoked token are refused (no tool result is produced)
  const raw = (token) => fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_me', arguments: {} } }) }).then(async (r) => ({ status: r.status, text: await r.text() }));
  await pool.query("UPDATE api_tokens SET expires_at = now() - interval '1 second' WHERE id=$1", [rt.id]);
  assert.equal((await rpc('get_me', {}, rt.token)).error.code, 'unauthorized', 'expired');
  assert.equal((await api('DELETE', `/me/tokens/${wr.id}`, { token: u.token })).status, 200);
  const gone = await raw(wr.token);
  assert.doesNotMatch(gone.text, new RegExp(u.id), 'a revoked token never reaches the tool');
  assert.equal((await rpc('create_team', { name: 'After revoke', sport: 'football' }, wr.token)).error.code, 'unauthorized');
});
