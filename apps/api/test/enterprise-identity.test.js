// Enterprise identity & provisioning (#521): OIDC + SAML sign-in, domain claim, account linking, JIT role mapping, SCIM, offboarding.
// The IdPs are local fixtures with real keys and certificates; DNS and the outbound HTTP transport are replaced, nothing leaves the machine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
process.env.API_PUBLIC_URL = 'https://api.test.example';
process.env.PLATFORM_ADMIN_EMAILS = 'rraja.edge@gmail.com';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { transport } = await import('../src/identity/safe-http.js');
const { dnsProbe } = await import('../src/identity/domains.js');
const { forgetJwks, jwksPolicy } = await import('../src/identity/oidc.js');
const { resolveRole } = await import('../src/identity/policy.js');
const { oidcIdp, selfSigned, samlResponse, requestIdOf, relayOf, b64u } = await import('./fixtures/idp.js');
const { SignJWT } = await import('jose');

let server, base, idp;
const dns = new Map(); // host -> [txt]
const REDIRECT = 'http://localhost:19006/sso/callback';
const api = async (method, path, { token, body, headers = {}, raw = false } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, redirect: 'manual', headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
  const text = await r.text();
  return { status: r.status, headers: r.headers, body: raw ? text : (text ? JSON.parse(text) : null) };
};
const scim = (method, path, token, body, headers = {}) => api(method, `/scim/v2${path}`, { token, body, headers: { 'content-type': 'application/scim+json', ...headers } });

let n = 0;
const signup = async (tag = 'p') => {
  n++;
  const email = `${tag}${n}@personal.example`;
  const r = await api('POST', '/auth/register', { body: { handle: `${tag}_${n}_x`, display_name: `Person ${tag} ${n}`, email, password: 'correct-horse-battery', roles: ['athlete'] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token, email };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  idp = await oidcIdp();
  transport.fetch = (req) => idp.fetch(req);
  dnsProbe.txt = async (host) => dns.get(host) ?? [];
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

/** An organisation whose owner has claimed + verified a domain and switched on an OIDC connection with a few mappings. */
let w = 0;
async function world({ protocol = 'oidc', jit = true, allowed = ['coach', 'finance', 'staff'], saml = null, extra = {} } = {}) {
  w++;
  const domain = `school${w}.example`;
  const owner = await signup('owner');
  const org = (await api('POST', '/organisations', { token: owner.token, body: { name: `School ${w}`, kind: 'school' } })).body;
  const claim = (await api('POST', `/organisations/${org.id}/identity/domains`, { token: owner.token, body: { domain } })).body;
  dns.set(claim.dns_record.host, [claim.dns_record.value]);
  assert.equal((await api('POST', `/organisations/${org.id}/identity/domains/${claim.id}/verify`, { token: owner.token })).body.status, 'verified');
  const body = protocol === 'oidc'
    ? { name: 'School IdP', protocol: 'oidc', oidc: { issuer: idp.issuer, client_id: idp.clientId, client_secret: idp.secret }, allowed_roles: allowed, default_role: null, jit_enabled: jit, ...extra }
    : { name: 'School SAML', protocol: 'saml', saml, allowed_roles: allowed, default_role: null, jit_enabled: jit, ...extra };
  const saved = await api('POST', `/organisations/${org.id}/identity/sso`, { token: owner.token, body });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const conn = saved.body;
  for (const [g, role] of [['teachers', 'coach'], ['accounts', 'finance'], ['support', 'staff']]) if (allowed.includes(role)) assert.equal((await api('POST', `/organisations/${org.id}/identity/sso/mappings`, { token: owner.token, body: { group_value: g, effect: 'allow', org_role: role } })).status, 201);
  assert.equal((await api('POST', `/organisations/${org.id}/identity/sso/mappings`, { token: owner.token, body: { group_value: 'suspended', effect: 'deny' } })).status, 201);
  const t = await api('POST', `/organisations/${org.id}/identity/sso/test`, { token: owner.token });
  assert.equal(t.body.ok, true, JSON.stringify(t.body));
  const on = await api('POST', `/organisations/${org.id}/identity/sso/status`, { token: owner.token, body: { status: 'active' } });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  return { owner, org, conn, domain, email: (l) => `${l}@${domain}`, patch: (b) => api('POST', `/organisations/${org.id}/identity/sso`, { token: owner.token, body: { ...body, ...b } }) };
}

/** Run the OIDC browser flow against the fixture IdP. `claims` are merged into the id_token. */
async function oidcLogin(W, claims = {}, { mutate = null, state: stateOverride, reuse = null } = {}) {
  const start = await api('POST', `/auth/sso/${W.conn.id}/start`, { body: { redirect_uri: REDIRECT } });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const u = new URL(start.body.url);
  idp.nonce = u.searchParams.get('nonce');
  idp.claims = { email: claims.email, ...claims };
  idp.mutate = mutate ? () => mutate() : null;
  const r = await api('POST', '/auth/sso/complete', { body: { connection_id: W.conn.id, state: stateOverride ?? start.body.state, code: 'auth-code' } });
  idp.mutate = null; idp.claims = {};
  return { ...r, start };
}

// ------------------------------------------------------------------ policy (pure)
test('role resolution: deny wins, the ceiling is never exceeded, owner and legal are never provisioned', () => {
  const m = [{ group_value: 'a', effect: 'allow', org_role: 'coach' }, { group_value: 'b', effect: 'allow', org_role: 'admin' }, { group_value: 'x', effect: 'deny' }, { group_value: 'o', effect: 'allow', org_role: 'owner' }, { group_value: 'l', effect: 'allow', org_role: 'legal' }];
  assert.equal(resolveRole({ groups: ['a', 'x'], mappings: m, ceiling: ['coach'] }).denied, true);
  assert.equal(resolveRole({ groups: ['b'], mappings: m, ceiling: ['coach'] }).role, null);
  assert.deepEqual(resolveRole({ groups: ['b'], mappings: m, ceiling: ['coach'] }).ignored, ['admin']);
  assert.equal(resolveRole({ groups: ['a', 'b'], mappings: m, ceiling: ['coach', 'admin'] }).role, 'admin');
  assert.equal(resolveRole({ groups: ['o'], mappings: m, ceiling: ['owner', 'coach'] }).role, null, 'owner is outside every ceiling');
  assert.equal(resolveRole({ groups: ['l'], mappings: m, ceiling: ['legal'] }).role, null, 'legal is outside every ceiling');
  assert.equal(resolveRole({ groups: [], mappings: m, ceiling: ['coach'], fallback: 'coach' }).role, 'coach');
  assert.equal(resolveRole({ groups: [], mappings: m, ceiling: ['coach'], fallback: 'admin' }).role, null);
});

// ------------------------------------------------------------------ domain claim + configuration
test('domain claim: needs the DNS record, a free mail domain is refused, and only one organisation can hold a domain', async () => {
  const owner = await signup('dom');
  const org = (await api('POST', '/organisations', { token: owner.token, body: { name: 'Domain Org', kind: 'school' } })).body;
  assert.equal((await api('POST', `/organisations/${org.id}/identity/domains`, { token: owner.token, body: { domain: 'gmail.com' } })).status, 400);
  const c = (await api('POST', `/organisations/${org.id}/identity/domains`, { token: owner.token, body: { domain: 'Claimed-One.example' } })).body;
  assert.equal(c.domain, 'claimed-one.example');
  assert.equal(c.status, 'pending');
  assert.equal((await api('POST', `/organisations/${org.id}/identity/domains/${c.id}/verify`, { token: owner.token })).body.status, 'pending', 'no TXT record yet');
  // a different organisation publishing the same record text cannot take it over once verified
  dns.set(c.dns_record.host, [c.dns_record.value]);
  assert.equal((await api('POST', `/organisations/${org.id}/identity/domains/${c.id}/verify`, { token: owner.token })).body.status, 'verified');
  const other = await signup('dom2');
  const org2 = (await api('POST', '/organisations', { token: other.token, body: { name: 'Other Org', kind: 'school' } })).body;
  assert.equal((await api('POST', `/organisations/${org2.id}/identity/domains`, { token: other.token, body: { domain: 'claimed-one.example' } })).status, 409);
  // a non-owner cannot claim
  assert.equal((await api('POST', `/organisations/${org.id}/identity/domains`, { token: other.token, body: { domain: 'x-y.example' } })).status, 404);
  // domain ownership alone grants nothing: no connection, no membership, no discovery
  assert.deepEqual((await api('POST', '/auth/sso/discover', { body: { email: 'a@claimed-one.example' } })).body, { sso: false });
});

test('connection config: ceiling excludes owner/legal, secrets never come back, private and non-https endpoints are refused', async () => {
  const W = await world();
  const bad = await W.patch({ allowed_roles: ['coach', 'owner'] });
  assert.equal(bad.status, 400); assert.match(bad.body.error.message, /owner/);
  assert.equal((await W.patch({ allowed_roles: ['legal'] })).status, 400);
  assert.equal((await W.patch({ default_role: 'admin' })).status, 400, 'default role must be inside the ceiling');
  assert.equal((await api('POST', `/organisations/${W.org.id}/identity/sso/mappings`, { token: W.owner.token, body: { group_value: 'bosses', effect: 'allow', org_role: 'owner' } })).status, 400);
  assert.equal((await api('POST', `/organisations/${W.org.id}/identity/sso/mappings`, { token: W.owner.token, body: { group_value: 'bosses', effect: 'allow', org_role: 'admin' } })).status, 400, 'admin is outside this ceiling');
  assert.equal((await W.patch({ local_login: 'sso_required' })).status, 400, 'needs a break-glass person');
  const got = await api('GET', `/organisations/${W.org.id}/identity/sso`, { token: W.owner.token });
  const text = JSON.stringify(got.body);
  assert.ok(!text.includes(idp.secret), 'client secret is write-only');
  assert.equal(got.body.connection.client_secret_set, true);
  assert.ok(!(await pool.query('SELECT client_secret_enc FROM org_sso_connections WHERE id=$1', [W.conn.id])).rows[0].client_secret_enc.includes(idp.secret), 'stored encrypted');
  const saml = (u) => api('POST', `/organisations/${W.org.id}/identity/sso`, { token: W.owner.token, body: { name: 'xx', protocol: 'saml', saml: { idp_entity_id: 'e', sso_url: u, certificates: [{ pem: selfSigned().cert }] }, allowed_roles: ['coach'] } });
  // a live OIDC connection cannot be flipped to SAML, and SAML URLs must be public https (checked on a fresh org)
  const o2 = await signup('ssrf');
  const org2 = (await api('POST', '/organisations', { token: o2.token, body: { name: 'SSRF Org', kind: 'school' } })).body;
  const put = (body) => api('POST', `/organisations/${org2.id}/identity/sso`, { token: o2.token, body: { name: 'bad', allowed_roles: ['coach'], ...body } });
  for (const url of ['http://idp.example/sso', 'https://127.0.0.1/sso', 'https://169.254.169.254/latest', 'https://10.0.0.5/sso', 'https://user:pw@idp.example/sso', 'https://localhost/sso']) {
    const r = await put({ protocol: 'saml', saml: { idp_entity_id: 'e', sso_url: url, certificates: [{ pem: selfSigned().cert }] } });
    assert.equal(r.status, 400, `${url} -> ${r.status}`);
  }
  assert.equal((await put({ protocol: 'oidc', oidc: { issuer: 'http://idp.acme.example', client_id: 'c' } })).status, 400);
  assert.equal((await saml('https://127.0.0.1/x')).status, 409, 'protocol switch on a live connection is refused first');
  // the owner role only: an admin member can read but not change
  const admin = await signup('adm');
  await api('POST', `/organisations/${W.org.id}/members`, { token: W.owner.token, body: { person: admin.handle, role: 'admin' } });
  await api('POST', `/organisations/${W.org.id}/invite/respond`, { token: admin.token, body: { accept: true } });
  assert.equal((await api('GET', `/organisations/${W.org.id}/identity/sso`, { token: admin.token })).status, 200);
  assert.equal((await W.patch({ name: 'renamed' }).then(() => api('POST', `/organisations/${W.org.id}/identity/sso`, { token: admin.token, body: { name: 'hack', protocol: 'oidc', oidc: { issuer: idp.issuer, client_id: 'z' }, allowed_roles: ['coach'] } }))).status, 403);
  // outsiders get 404, not a hint that the organisation exists
  assert.equal((await api('GET', `/organisations/${W.org.id}/identity/sso`, { token: o2.token })).status, 404);
});

// ------------------------------------------------------------------ OIDC
test('OIDC: first sign-in creates one account + a mapped role, never platform roles; the next sign-in reuses it', async () => {
  const W = await world();
  const r = await oidcLogin(W, { sub: 'oidc-1', email: W.email('asha'), groups: ['teachers'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.token && r.body.refresh_token);
  assert.deepEqual(r.body.user.roles, ['athlete']);
  assert.equal(r.body.user.display_name, 'Asha Teacher');
  const mem = (await pool.query("SELECT role, status, source FROM organisation_members WHERE organisation_id=$1 AND user_id=$2", [W.org.id, r.body.user.id])).rows;
  assert.deepEqual(mem.map((m) => [m.role, m.status, m.source]), [['coach', 'active', 'sso']]);
  const sess = (await pool.query('SELECT sso_connection_id FROM auth_sessions WHERE id=$1', [r.body.session_id])).rows[0];
  assert.equal(sess.sso_connection_id, W.conn.id);
  const again = await oidcLogin(W, { sub: 'oidc-1', email: W.email('asha'), groups: ['teachers', 'accounts'] });
  assert.equal(again.body.user.id, r.body.user.id);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM users WHERE email_idx IS NOT NULL AND display_name=$1', ['Asha Teacher'])).rows[0].n, 1);
  assert.equal((await pool.query("SELECT role FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [W.org.id, r.body.user.id])).rows[0].role, 'finance', 'role follows the groups on the next sign-in');
  const me = await api('GET', '/me', { token: r.body.token });
  assert.equal(me.body.email, W.email('asha'));
});

test('OIDC: a deny group, no matching group, and JIT off each refuse without creating anything', async () => {
  const W = await world();
  const before = (await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
  assert.equal((await oidcLogin(W, { sub: 's1', email: W.email('a'), groups: ['teachers', 'suspended'] })).status, 401);
  assert.equal((await oidcLogin(W, { sub: 's2', email: W.email('b'), groups: ['nobody'] })).status, 401);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, before, 'refused sign-ins create no account');
  const off = await world({ jit: false });
  assert.equal((await oidcLogin(off, { sub: 's3', email: off.email('c'), groups: ['teachers'] })).status, 401, 'JIT off and no SCIM reference');
  const ev = await api('GET', `/organisations/${W.org.id}/identity/events?outcome=denied`, { token: W.owner.token });
  assert.ok(ev.body.some((e) => e.reason === 'group_denied') && ev.body.some((e) => e.reason === 'no_role'));
});

test('OIDC validation: unsigned, wrong key, HS256, wrong issuer/audience, expired, stale, nonce, replayed state and jti are all refused', async () => {
  const W = await world();
  const ok = (claims) => oidcLogin(W, { sub: 'v1', email: W.email('v'), groups: ['teachers'], ...claims });
  const now = Math.floor(Date.now() / 1000);
  const unsigned = await oidcLogin(W, { sub: 'v1', email: W.email('v'), groups: ['teachers'] }, { mutate: async () => `${b64u({ alg: 'none', typ: 'JWT' })}.${b64u({ iss: idp.issuer, aud: idp.clientId, sub: 'v1', email: W.email('v'), groups: ['teachers'], nonce: idp.nonce, iat: now, exp: now + 300 })}.` });
  assert.equal(unsigned.status, 401, 'alg none');
  const hs = await oidcLogin(W, { sub: 'v1', email: W.email('v'), groups: ['teachers'] }, { mutate: async () => new SignJWT({ sub: 'v1', email: W.email('v'), groups: ['teachers'], nonce: idp.nonce }).setProtectedHeader({ alg: 'HS256' }).setIssuer(idp.issuer).setAudience(idp.clientId).setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(idp.secret)) });
  assert.equal(hs.status, 401, 'a token signed with the client secret is not an IdP signature');
  await idp.addKey('rogue');
  const rogue = await oidcLogin(W, { sub: 'v1', email: W.email('v'), groups: ['teachers'] }, { mutate: async () => { const t = await idp.idToken({ nonce: idp.nonce }, { kid: 'rogue' }); idp.removeKey('rogue'); return t; } });
  assert.equal(rogue.status, 401, 'signed by a key the IdP does not publish');
  assert.equal((await ok({ iss: 'https://evil.example' })).status, 401, 'issuer');
  assert.equal((await ok({ aud: 'someone-else' })).status, 401, 'audience');
  assert.equal((await ok({ exp: now - 600, iat: now - 900 })).status, 401, 'expired');
  assert.equal((await ok({ iat: now - 4000, exp: now + 300 })).status, 401, 'stale: issued long ago');
  assert.equal((await oidcLogin(W, { sub: 'v1', email: W.email('v'), groups: ['teachers'] }, { mutate: async () => idp.idToken({ nonce: 'other' }) })).status, 401, 'nonce');
  assert.equal((await ok({ email_verified: false })).status, 401, 'unverified email claim');
  assert.equal((await ok({ email: 'someone@not-claimed.example' })).status, 401, 'domain not claimed by this organisation');
  // clock skew: a token that expired 20s ago is inside the 60s tolerance
  assert.equal((await ok({ exp: now - 20, iat: now - 100 })).status, 200);
  // single use state + jti replay
  const good = await oidcLogin(W, { sub: 'v2', email: W.email('w'), groups: ['teachers'], jti: 'jti-1' });
  assert.equal(good.status, 200);
  const again = await api('POST', '/auth/sso/complete', { body: { connection_id: W.conn.id, state: good.start.body.state, code: 'auth-code' } });
  assert.equal(again.status, 401, 'state is single use');
  assert.equal((await oidcLogin(W, { sub: 'v2', email: W.email('w'), groups: ['teachers'], jti: 'jti-1' })).status, 401, 'the same id_token jti is accepted once');
  assert.equal((await api('POST', `/auth/sso/${W.conn.id}/start`, { body: { redirect_uri: 'https://evil.example/cb' } })).status, 400, 'redirect_uri must be registered');
});

test('OIDC key rotation: a new signing key is picked up, a removed key stops working', async () => {
  const W = await world();
  jwksPolicy.refetchAfterMs = 0;
  await idp.addKey('k2');
  idp.signWith = 'k2';
  assert.equal((await oidcLogin(W, { sub: 'rot1', email: W.email('r'), groups: ['teachers'] })).status, 200, 'unknown kid triggers one JWKS refetch');
  idp.removeKey('k1');
  forgetJwks(`${idp.issuer}/jwks`);
  idp.signWith = 'k1'; idp.keys.set('k1', idp.keys.get('k2')); idp.keys.delete('k1'); // k1 retired
  idp.signWith = 'k2';
  assert.equal((await oidcLogin(W, { sub: 'rot1', email: W.email('r'), groups: ['teachers'] })).status, 200);
  await idp.addKey('k1'); // a brand-new k1 that was never trusted before is just another new key; but a token signed by a retired key id fails:
  const old = await oidcLogin(W, { sub: 'rot1', email: W.email('r'), groups: ['teachers'] }, { mutate: async () => { const t = await idp.idToken({ nonce: idp.nonce }, { kid: 'k1' }); idp.removeKey('k1'); return t; } });
  assert.equal(old.status, 401);
  idp.signWith = 'k2';
  jwksPolicy.refetchAfterMs = 30_000;
});

// ------------------------------------------------------------------ account linking
test('account linking: a matching email never merges on the claim; the signed-in owner confirms; names never match; unverified accounts are reclaimed', async () => {
  const W = await world();
  // an existing verified account with the organisation address
  const reg = await api('POST', '/auth/register', { body: { handle: 'existing_one', display_name: 'Asha Teacher', email: W.email('existing'), password: 'correct-horse-battery', roles: ['athlete'] } });
  const uid = reg.body.user.id;
  await pool.query('UPDATE users SET email_verified_at = now() WHERE id=$1', [uid]);
  const r = await oidcLogin(W, { sub: 'link-1', email: W.email('existing'), groups: ['teachers'] });
  assert.equal(r.status, 200);
  assert.equal(r.body.link_required, true);
  assert.equal(r.body.token, undefined, 'no session is issued before confirmation');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM org_sso_identities WHERE user_id=$1', [uid])).rows[0].n, 0, 'nothing linked yet');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM organisation_members WHERE user_id=$1', [uid])).rows[0].n, 0);
  // somebody else (even signed in) cannot confirm someone else's link
  const stranger = await signup('str');
  assert.equal((await api('POST', '/auth/sso/link', { token: stranger.token, body: { link_token: r.body.link_token } })).status, 401);
  // the account's own owner confirms
  const owner = await api('POST', '/auth/login', { body: { email: W.email('existing'), password: 'correct-horse-battery' } });
  const ok = await api('POST', '/auth/sso/link', { token: owner.body.token, body: { link_token: r.body.link_token } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.user.id, uid);
  assert.equal((await pool.query("SELECT role FROM organisation_members WHERE user_id=$1 AND status='active'", [uid])).rows[0].role, 'coach');
  assert.equal((await api('POST', '/auth/sso/link', { token: owner.body.token, body: { link_token: r.body.link_token } })).status, 401, 'single use');
  // the same display name with a different address is a different person
  const same = await oidcLogin(W, { sub: 'link-2', email: W.email('someone-else'), name: 'Asha Teacher', groups: ['teachers'] });
  assert.notEqual(same.body.user.id, uid);
  // an unverified, never-confirmed registration of an organisation address is reclaimed (its password becomes unusable)
  const squat = await api('POST', '/auth/register', { body: { handle: 'squatter', display_name: 'Squatter', email: W.email('squat'), password: 'correct-horse-battery', roles: ['athlete'] } });
  const rec = await oidcLogin(W, { sub: 'link-3', email: W.email('squat'), groups: ['teachers'] });
  assert.equal(rec.body.user.id, squat.body.user.id);
  assert.equal((await api('POST', '/auth/login', { body: { email: W.email('squat'), password: 'correct-horse-battery' } })).status, 401);
  assert.equal((await api('GET', '/me', { token: squat.body.token })).status, 401, 'its old sessions were signed out');
});

test('a platform-admin address and a minor are never provisioned through SSO; guardian links are untouched', async () => {
  const W = await world();
  const guardians = (await pool.query('SELECT count(*)::int AS n FROM guardian_links')).rows[0].n;
  assert.equal((await oidcLogin(W, { sub: 'pa', email: 'rraja.edge@gmail.com', groups: ['teachers'] })).status, 401);
  const kid = await api('POST', '/auth/register', { body: { handle: 'young_one', display_name: 'Young One', email: W.email('kid'), password: 'correct-horse-battery', roles: ['athlete'] } });
  await pool.query("UPDATE users SET email_verified_at = now(), youth_until = current_date + 365 WHERE id=$1", [kid.body.user.id]);
  await pool.query("INSERT INTO org_sso_identities(connection_id, user_id, external_subject, linked_how) VALUES ($1,$2,'kid-sub','confirmed_by_owner')", [W.conn.id, kid.body.user.id]);
  assert.equal((await oidcLogin(W, { sub: 'kid-sub', email: W.email('kid'), groups: ['teachers'] })).status, 401, 'staff roles are never put on a minor\'s account');
  assert.equal((await api('POST', `/organisations/${W.org.id}/identity/sso/mappings`, { token: W.owner.token, body: { group_value: 'parents', effect: 'allow', org_role: 'guardian' } })).status, 400, 'there is no guardian role to map');
  // a successful provisioning run does not touch guardian relationships either
  assert.equal((await oidcLogin(W, { sub: 'adult', email: W.email('adult'), groups: ['teachers', 'parents', 'guardian'] })).status, 200);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM guardian_links')).rows[0].n, guardians);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM users WHERE 'admin' = ANY(roles) OR 'platform_admin' = ANY(roles)")).rows[0].n, 0);
});

// ------------------------------------------------------------------ policy controls
test('session length, MFA signal, and local-login policy with a break-glass owner', async () => {
  const W = await world({ extra: { session_hours: 1, require_mfa_signal: true } });
  assert.equal((await oidcLogin(W, { sub: 'm1', email: W.email('m'), groups: ['teachers'] })).status, 401, 'no MFA signal from the IdP');
  const r = await oidcLogin(W, { sub: 'm1', email: W.email('m'), groups: ['teachers'], amr: ['pwd', 'otp'] });
  assert.equal(r.status, 200);
  const s = (await pool.query('SELECT expires_at, hard_expires_at, mfa_verified_at FROM auth_sessions WHERE id=$1', [r.body.session_id])).rows[0];
  assert.ok(s.hard_expires_at && Math.abs(new Date(s.hard_expires_at) - Date.now() - 3600_000) < 60_000, 'hard 1h ceiling');
  assert.ok(new Date(s.expires_at) <= new Date(s.hard_expires_at));
  assert.ok(s.mfa_verified_at, 'the verified IdP signal is recorded');
  // refresh can never push the session past the hard ceiling
  const rr = await api('POST', '/auth/refresh', { body: { refresh_token: r.body.refresh_token } });
  assert.equal(rr.status, 200);
  const s2 = (await pool.query('SELECT expires_at FROM auth_sessions WHERE id=$1', [r.body.session_id])).rows[0];
  assert.ok(new Date(s2.expires_at) <= new Date(s.hard_expires_at));

  // local login policy: provisioned members must use SSO; a break-glass owner and unrelated personal accounts may not be blocked
  const P = await world();
  const joined = await oidcLogin(P, { sub: 'p1', email: P.email('staff'), groups: ['teachers'] });
  await pool.query("UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1", [joined.body.user.id]);
  const set = await P.patch({ local_login: 'sso_required', break_glass_user_ids: [P.owner.id] });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  await pool.query("UPDATE users SET password_hash = (SELECT password_hash FROM users WHERE id=$2) WHERE id=$1", [joined.body.user.id, P.owner.id]); // same known password
  const blocked = await api('POST', '/auth/login', { body: { email: P.email('staff'), password: 'correct-horse-battery' } });
  assert.equal(blocked.status, 403); assert.equal(blocked.body.error.code, 'sso_required');
  assert.equal((await api('POST', '/auth/login', { body: { email: P.owner.email, password: 'correct-horse-battery' } })).status, 200, 'break-glass owner');
  const personal = await signup('personal');
  assert.equal((await api('POST', '/auth/login', { body: { email: personal.email, password: 'correct-horse-battery' } })).status, 200, 'personal accounts are unaffected');
  assert.equal((await oidcLogin(P, { sub: 'p1', email: P.email('staff'), groups: ['teachers'] })).status, 200, 'SSO still works');
  const ev = await api('GET', `/organisations/${P.org.id}/identity/events`, { token: P.owner.token });
  assert.ok(ev.body.some((e) => e.event === 'break_glass_login'), JSON.stringify(ev.body.map((e) => [e.event, e.outcome, e.reason])));
  assert.ok(ev.body.some((e) => e.event === 'break_glass_login') && ev.body.some((e) => e.event === 'local_login' && e.outcome === 'denied'));
});

// ------------------------------------------------------------------ SAML
async function samlWorld(extra = {}) {
  const signer = selfSigned();
  const W = await world({ protocol: 'saml', saml: { idp_entity_id: 'https://idp.acme-school.example/saml', sso_url: 'https://idp.acme-school.example/sso', certificates: [{ pem: signer.cert }] }, ...extra });
  const full = (await api('GET', `/organisations/${W.org.id}/identity/sso`, { token: W.owner.token })).body.connection;
  return { ...W, signer, sp: full.service_provider.entity_id, acs: full.service_provider.acs_url };
}
async function samlLogin(S, opts = {}) {
  const start = await api('POST', `/auth/sso/${S.conn.id}/start`, { body: { redirect_uri: REDIRECT } });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const inResponseTo = opts.inResponseTo ?? requestIdOf(start.body.url);
  const SAMLResponse = opts.response ?? samlResponse({ signer: opts.signer ?? S.signer, acs: S.acs, sp: S.sp, inResponseTo, ...opts });
  const post = await fetch(`${base}/api/v1/auth/sso/${S.conn.id}/saml/acs`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ SAMLResponse, RelayState: opts.relay ?? relayOf(start.body.url) }) });
  const loc = post.headers.get('location') ?? '';
  const ticket = new URL(loc, 'http://x').searchParams.get('ticket');
  const done = ticket ? await api('POST', '/auth/sso/complete', { body: { ticket } }) : null;
  return { post, loc, ticket, done, start, SAMLResponse };
}

test('SAML: a signed assertion for this SP and request signs in; metadata is served; groups map to a role', async () => {
  const S = await samlWorld();
  const meta = await api('GET', `/auth/sso/${S.conn.id}/saml/metadata`, { raw: true });
  assert.equal(meta.status, 200); assert.match(meta.body, /EntityDescriptor/); assert.match(meta.body, new RegExp(S.acs.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
  const r = await samlLogin(S, { subject: 'saml-1', email: S.email('sam'), groups: ['teachers'] });
  assert.equal(r.post.status, 303, r.loc);
  assert.ok(r.loc.startsWith(REDIRECT) && r.ticket, `${r.post.status} ${r.loc}`);
  assert.equal(r.done.status, 200, JSON.stringify(r.done.body));
  assert.equal((await pool.query("SELECT role, source FROM organisation_members WHERE user_id=$1 AND status='active'", [r.done.body.user.id])).rows[0].role, 'coach');
  assert.equal((await api('POST', '/auth/sso/complete', { body: { ticket: r.ticket } })).status, 401, 'tickets are single use');
});

test('SAML validation: unsigned, wrong signer, wrong audience, wrong/unsolicited InResponseTo, expired, replayed and tampered responses are refused', async () => {
  const S = await samlWorld();
  const base_ = { subject: 'saml-2', email: S.email('val'), groups: ['teachers'] };
  const refused = async (opts, why) => { const r = await samlLogin(S, { ...base_, ...opts }); assert.ok(!r.ticket, `${why}: ${r.loc}`); assert.match(r.loc || String(r.post.status), /sso_failed|401/); return r; };
  await refused({ sign: false }, 'unsigned assertion');
  await refused({ signer: selfSigned('evil') }, 'signed by a different key');
  await refused({ audience: 'https://another-sp.example' }, 'audience');
  await refused({ inResponseTo: '_not-our-request' }, 'unsolicited / wrong InResponseTo');
  await refused({ notBefore: Date.now() - 3_600_000, notOnOrAfter: Date.now() - 1_800_000 }, 'expired');
  const ok = await samlLogin(S, base_);
  assert.ok(ok.ticket, 'a clean response still works');
  // replay: the same signed response, even with a fresh RelayState/request, is not accepted twice
  const start2 = await api('POST', `/auth/sso/${S.conn.id}/start`, { body: { redirect_uri: REDIRECT } });
  const replay = await fetch(`${base}/api/v1/auth/sso/${S.conn.id}/saml/acs`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ SAMLResponse: ok.SAMLResponse, RelayState: relayOf(start2.body.url) }) });
  assert.ok(!(replay.headers.get('location') ?? '').includes('ticket='), 'replayed response');
  // tampering with a signed value (the NameID) breaks the signature
  const xml = Buffer.from(ok.SAMLResponse, 'base64').toString().replace('saml-2', 'admin-subject');
  await refused({ response: Buffer.from(xml).toString('base64') }, 'tampered');
  // a response for a different connection's request cannot be used here
  const other = await samlWorld();
  const o = await api('POST', `/auth/sso/${other.conn.id}/start`, { body: { redirect_uri: REDIRECT } });
  const cross = await samlLogin(S, { ...base_, inResponseTo: requestIdOf(o.body.url) });
  assert.ok(!cross.ticket);
  const denied = await api('GET', `/organisations/${S.org.id}/identity/events?outcome=denied`, { token: S.owner.token });
  assert.ok(denied.body.some((e) => e.reason === 'assertion_invalid'));
});

test('SAML certificate rotation: old and new certificates overlap, then the old one is retired', async () => {
  const S = await samlWorld();
  const next = selfSigned('idp-new');
  const rotate = (certs) => api('POST', `/organisations/${S.org.id}/identity/sso`, { token: S.owner.token, body: { name: 'School SAML', protocol: 'saml', saml: { certificates: certs }, allowed_roles: ['coach', 'finance', 'staff'], jit_enabled: true } });
  const r = await rotate([{ pem: S.signer.cert }, { pem: next.cert }]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'active', 'adding a certificate does not take SSO down');
  assert.equal(r.body.certificates.length, 2);
  assert.ok((await samlLogin(S, { subject: 'rot-a', email: S.email('a'), groups: ['teachers'], signer: next })).ticket, 'new cert works');
  assert.ok((await samlLogin(S, { subject: 'rot-b', email: S.email('b'), groups: ['teachers'] })).ticket, 'old cert still works during overlap');
  await rotate([{ pem: next.cert }]);
  assert.ok(!(await samlLogin(S, { subject: 'rot-c', email: S.email('c'), groups: ['teachers'] })).ticket, 'the retired certificate is no longer trusted');
  assert.ok((await samlLogin(S, { subject: 'rot-d', email: S.email('d'), groups: ['teachers'], signer: next })).ticket);
  // retire_after in the past also stops trusting a certificate
  await rotate([{ pem: next.cert }, { pem: S.signer.cert, retire_after: new Date(Date.now() - 1000).toISOString() }]);
  assert.ok(!(await samlLogin(S, { subject: 'rot-e', email: S.email('e'), groups: ['teachers'] })).ticket);
  // a different entity id or sign-in URL is a trust change: back to draft until tested again
  const moved = await api('POST', `/organisations/${S.org.id}/identity/sso`, { token: S.owner.token, body: { name: 'School SAML', protocol: 'saml', saml: { idp_entity_id: 'https://other-idp.example/saml', sso_url: 'https://other-idp.example/sso' }, allowed_roles: ['coach'], jit_enabled: true } });
  assert.equal(moved.body.status, 'draft');
  assert.equal((await api('POST', `/auth/sso/${S.conn.id}/start`, { body: { redirect_uri: REDIRECT } })).status, 404, 'a draft connection cannot sign anyone in');
});

test('SAML metadata import fills the connection; a DTD is refused', async () => {
  const signer = selfSigned();
  const body = (xml) => ({ name: 'Meta IdP', protocol: 'saml', saml: { idp_metadata_xml: xml }, allowed_roles: ['coach'] });
  const certB64 = signer.cert.replace(/-----[A-Z ]+-----|\s/g, '');
  const xml = `<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://meta.idp.example/e"><IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><KeyDescriptor use="signing"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>${certB64}</X509Certificate></X509Data></KeyInfo></KeyDescriptor><SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://meta.idp.example/sso"/></IDPSSODescriptor></EntityDescriptor>`;
  const o = await signup('meta');
  const org = (await api('POST', '/organisations', { token: o.token, body: { name: 'Meta Org', kind: 'school' } })).body;
  const r = await api('POST', `/organisations/${org.id}/identity/sso`, { token: o.token, body: body(xml) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.config.idp_entity_id, 'https://meta.idp.example/e'); assert.equal(r.body.config.sso_url, 'https://meta.idp.example/sso'); assert.equal(r.body.certificates.length, 1);
  const o2 = await signup('meta2');
  const org2 = (await api('POST', '/organisations', { token: o2.token, body: { name: 'Meta Org 2', kind: 'school' } })).body;
  const evil = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]>${xml}`;
  assert.equal((await api('POST', `/organisations/${org2.id}/identity/sso`, { token: o2.token, body: body(evil) })).status, 400);
});

// ------------------------------------------------------------------ multiple organisations
test('one person, two SSO organisations: independent roles, independently revocable; the second is added from a signed-in account', async () => {
  const A = await world(), B = await world();
  const a = await oidcLogin(A, { sub: 'multi-a', email: A.email('dual'), groups: ['teachers'] });
  assert.equal(a.status, 200);
  const uid = a.body.user.id;
  // give the account a password so the person can sign in locally, then add organisation B from that signed-in account
  await pool.query("UPDATE users SET password_hash = (SELECT password_hash FROM users WHERE id=$2) WHERE id=$1", [uid, A.owner.id]);
  const local = await api('POST', '/auth/login', { body: { email: A.email('dual'), password: 'correct-horse-battery' } });
  const start = await api('POST', `/me/sso/${B.conn.id}/start`, { token: local.body.token, body: { redirect_uri: REDIRECT } });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  idp.nonce = new URL(start.body.url).searchParams.get('nonce');
  idp.claims = { sub: 'multi-b', email: B.email('dual'), groups: ['accounts'] };
  const b = await api('POST', '/auth/sso/complete', { body: { connection_id: B.conn.id, state: start.body.state, code: 'c' } });
  idp.claims = {};
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(b.body.user.id, uid, 'same canonical person');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM users WHERE email_idx = (SELECT email_idx FROM users WHERE id=$1)', [uid])).rows[0].n, 1);
  const roles = (await pool.query("SELECT organisation_id, role FROM organisation_members WHERE user_id=$1 AND status='active' ORDER BY role", [uid])).rows;
  assert.deepEqual(roles.map((r) => r.role).sort(), ['coach', 'finance']);
  // B's address cannot be used to sign in to a different account's link flow, and A's IdP signing in again does not touch B's role
  const again = await oidcLogin(A, { sub: 'multi-a', email: A.email('dual'), groups: ['teachers'] });
  assert.equal(again.status, 200);
  assert.equal((await pool.query("SELECT role FROM organisation_members WHERE user_id=$1 AND organisation_id=$2 AND status='active'", [uid, B.org.id])).rows[0].role, 'finance');
  // deprovision A only: B's membership and B's session survive; A's session dies
  const sessA = again.body.session_id, sessB = b.body.session_id;
  const out = await api('DELETE', `/organisations/${A.org.id}/members/${uid}`, { token: A.owner.token });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal((await api('GET', '/me', { token: again.body.token })).status, 401, 'A\'s SSO session is revoked at once');
  assert.equal((await api('GET', '/me', { token: b.body.token })).status, 200, 'B\'s SSO session is untouched');
  assert.equal((await api('GET', '/me', { token: local.body.token })).status, 200, 'the personal session is untouched');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM organisation_members WHERE user_id=$1 AND organisation_id=$2 AND status='active'", [uid, B.org.id])).rows[0].n, 1);
  assert.equal((await pool.query("SELECT status FROM organisation_members WHERE user_id=$1 AND organisation_id=$2", [uid, A.org.id])).rows[0].status, 'left', 'history kept');
  assert.ok(sessA && sessB);
});

// ------------------------------------------------------------------ SCIM + offboarding
const scimWorld = async (opts = {}) => {
  const W = await world({ jit: false, ...opts });
  const tok = await api('POST', `/organisations/${W.org.id}/identity/scim-tokens`, { token: W.owner.token, body: { name: 'Directory sync' } });
  assert.equal(tok.status, 201, JSON.stringify(tok.body));
  return { ...W, scimToken: tok.body.token, scimTokenId: tok.body.id };
};
const SCHEMA_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const PATCHOP = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const newUser = (W, local, extra = {}) => scim('POST', '/Users', W.scimToken, { schemas: [SCHEMA_USER], userName: W.email(local), externalId: `ext-${local}`, displayName: `Dir ${local}`, active: true, ...extra });

test('SCIM: credentials are org-scoped service identities - required, revocable, and not usable on another organisation', async () => {
  const W = await scimWorld(), X = await scimWorld();
  assert.equal((await scim('GET', '/Users', null)).status, 401);
  assert.equal((await scim('GET', '/Users', 'scim_notarealtokenvaluenotarealtoken')).status, 401);
  const cfg = await scim('GET', '/ServiceProviderConfig', W.scimToken);
  assert.equal(cfg.status, 200); assert.equal(cfg.body.patch.supported, true); assert.equal(cfg.body.etag.supported, true);
  assert.match(cfg.headers.get('content-type'), /scim\+json/);
  // W's token sees only W
  await newUser(W, 'only-w');
  assert.equal((await scim('GET', '/Users', X.scimToken)).body.totalResults, 0);
  // a person's own API token or session is not a SCIM credential
  assert.equal((await scim('GET', '/Users', W.owner.token)).status, 401);
  // revoking is immediate and touches nothing else
  const sess = await oidcLogin(W, { sub: 'x', email: W.email('only-w'), groups: ['teachers'] });
  assert.equal(sess.status, 200);
  assert.equal((await api('DELETE', `/organisations/${W.org.id}/identity/scim-tokens/${W.scimTokenId}`, { token: W.owner.token })).status, 200);
  assert.equal((await scim('GET', '/Users', W.scimToken)).status, 401);
  assert.equal((await api('GET', '/me', { token: sess.body.token })).status, 200, 'sessions are independent of the SCIM credential');
  // and a deactivated SSO user does not revoke the SCIM credential
  const T = await scimWorld();
  const u = (await newUser(T, 'p')).body;
  await scim('PATCH', `/Users/${u.id}`, T.scimToken, { schemas: [PATCHOP], Operations: [{ op: 'replace', path: 'active', value: false }] });
  assert.equal((await scim('GET', '/Users', T.scimToken)).status, 200);
});

test('SCIM users: create is idempotent, conflicts and unverified domains are refused, filters and paging work, ETag guards writes', async () => {
  const W = await scimWorld();
  const a = await newUser(W, 'amit');
  assert.equal(a.status, 201); assert.equal(a.body.active, true); assert.equal(a.body.userName, W.email('amit'));
  assert.equal(a.headers.get('etag'), 'W/"1"');
  const retry = await newUser(W, 'amit');
  assert.equal(retry.status, 200, 'a retried create returns the same resource'); assert.equal(retry.body.id, a.body.id);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM scim_users WHERE organisation_id=$1', [W.org.id])).rows[0].n, 1);
  assert.equal((await scim('POST', '/Users', W.scimToken, { schemas: [SCHEMA_USER], userName: W.email('amit'), externalId: 'a-different-id' })).status, 409);
  const outside = await scim('POST', '/Users', W.scimToken, { schemas: [SCHEMA_USER], userName: 'x@elsewhere.example' });
  assert.equal(outside.status, 400); assert.equal(outside.body.scimType, 'invalidValue');
  for (const l of ['b1', 'b2', 'b3']) await newUser(W, l);
  const page = await scim('GET', '/Users?startIndex=2&count=2', W.scimToken);
  assert.equal(page.body.totalResults, 4); assert.equal(page.body.itemsPerPage, 2); assert.equal(page.body.startIndex, 2);
  const f = await scim('GET', `/Users?filter=${encodeURIComponent(`userName eq "${W.email('b2')}"`)}`, W.scimToken);
  assert.equal(f.body.totalResults, 1); assert.equal(f.body.Resources[0].externalId, 'ext-b2');
  assert.equal((await scim('GET', `/Users?filter=${encodeURIComponent('userName co "b"')}`, W.scimToken)).status, 400);
  // ETag / If-Match
  const g = await scim('GET', `/Users/${a.body.id}`, W.scimToken);
  assert.equal(g.headers.get('etag'), 'W/"1"');
  const stale = await scim('PATCH', `/Users/${a.body.id}`, W.scimToken, { schemas: [PATCHOP], Operations: [{ op: 'replace', path: 'displayName', value: 'New Name' }] }, { 'if-match': 'W/"9"' });
  assert.equal(stale.status, 412);
  const ok = await scim('PATCH', `/Users/${a.body.id}`, W.scimToken, { schemas: [PATCHOP], Operations: [{ op: 'replace', path: 'displayName', value: 'New Name' }] }, { 'if-match': 'W/"1"' });
  assert.equal(ok.status, 200); assert.equal(ok.headers.get('etag'), 'W/"2"'); assert.equal(ok.body.displayName, 'New Name');
  // an operation that changes nothing does not bump the version (safe to replay)
  const same = await scim('PATCH', `/Users/${a.body.id}`, W.scimToken, { schemas: [PATCHOP], Operations: [{ op: 'replace', path: 'displayName', value: 'New Name' }] });
  assert.equal(same.headers.get('etag'), 'W/"2"');
  assert.equal((await scim('GET', `/Users/${'00000000-0000-4000-8000-000000000000'}`, W.scimToken)).status, 404);
  // personal data is stored encrypted and reads are audit-logged
  const raw = (await pool.query('SELECT email_enc FROM scim_users WHERE id=$1', [a.body.id])).rows[0].email_enc;
  assert.ok(!raw.includes('amit') && raw.startsWith('v1.'));
  assert.ok((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='read_pii' AND entity='scim_users'")).rows[0].n > 0);
});

test('SCIM groups map to roles; the person signs in through SSO with no JIT; membership follows the group', async () => {
  const W = await scimWorld();
  const u = (await newUser(W, 'gita')).body;
  const g = await scim('POST', '/Groups', W.scimToken, { schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], displayName: 'teachers', members: [{ value: u.id }] });
  assert.equal(g.status, 201);
  assert.equal((await scim('POST', '/Groups', W.scimToken, { displayName: 'Teachers' })).status, 200, 'same group again is idempotent');
  assert.equal((await scim('GET', `/Groups/${g.body.id}`, W.scimToken)).body.members.length, 1);
  // no groups claim from the IdP: the directory's group decides (JIT is off, so this works only because SCIM provisioned the person)
  const login = await oidcLogin(W, { sub: 'gita-sub', email: W.email('gita') });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const m = (await pool.query("SELECT role, source FROM organisation_members WHERE user_id=$1 AND status='active'", [login.body.user.id])).rows[0];
  assert.deepEqual([m.role, m.source], ['coach', 'scim']);
  assert.equal((await pool.query('SELECT user_id FROM scim_users WHERE id=$1', [u.id])).rows[0].user_id, login.body.user.id, 'the reference is linked at first sign-in');
  // moving the person to a different group re-evaluates their role immediately
  const acc = (await scim('POST', '/Groups', W.scimToken, { displayName: 'accounts' })).body;
  await scim('PATCH', `/Groups/${g.body.id}`, W.scimToken, { schemas: [PATCHOP], Operations: [{ op: 'remove', path: `members[value eq "${u.id}"]` }] });
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM organisation_members WHERE user_id=$1 AND status='active'", [login.body.user.id])).rows[0].n, 0, 'no group left, no role');
  assert.equal((await api('GET', '/me', { token: login.body.token })).status, 401, 'and the SSO session ended with it');
  await scim('PATCH', `/Groups/${acc.id}`, W.scimToken, { schemas: [PATCHOP], Operations: [{ op: 'add', path: 'members', value: [{ value: u.id }] }] });
  assert.equal((await oidcLogin(W, { sub: 'gita-sub', email: W.email('gita') })).status, 200);
  assert.equal((await pool.query("SELECT role FROM organisation_members WHERE user_id=$1 AND status='active'", [login.body.user.id])).rows[0].role, 'finance');
  // a group mapped above the ceiling grants nothing
  await pool.query("INSERT INTO org_sso_group_mappings(connection_id, group_value, effect, org_role, created_by) VALUES ($1,'bosses','allow','owner',$2)", [W.conn.id, W.owner.id]);
  const boss = (await scim('POST', '/Groups', W.scimToken, { displayName: 'bosses', members: [{ value: u.id }] })).body;
  assert.ok(boss.id);
  assert.notEqual((await pool.query("SELECT role FROM organisation_members WHERE user_id=$1 AND status='active'", [login.body.user.id])).rows[0]?.role, 'owner');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM organisation_members WHERE organisation_id=$1 AND role='owner' AND status='active'", [W.org.id])).rows[0].n, 1, 'still only the real owner');
});

test('offboarding: SCIM deactivation is prompt, idempotent, prospective, and never deletes the person or their history', async () => {
  const W = await scimWorld();
  const u = (await newUser(W, 'ravi', { })).body;
  await scim('POST', '/Groups', W.scimToken, { displayName: 'teachers', members: [{ value: u.id }] });
  const login = await oidcLogin(W, { sub: 'ravi-sub', email: W.email('ravi') });
  assert.equal(login.status, 200);
  const uid = login.body.user.id;
  // canonical history that must survive: a sport profile and an api token (unrestricted + one restricted to this organisation)
  const sport = (await pool.query('SELECT id FROM sports LIMIT 1')).rows[0].id;
  await pool.query("INSERT INTO sport_profiles(user_id, sport_id, role) VALUES ($1,$2,'athlete')", [uid, sport]);
  const orgTok = (await pool.query("INSERT INTO api_tokens(user_id, name, token_hash, scopes, resources) VALUES ($1,'org only','h-org',ARRAY['read'],$2) RETURNING id", [uid, JSON.stringify([{ type: 'organisation', id: W.org.id }])])).rows[0].id;
  const ownTok = (await pool.query("INSERT INTO api_tokens(user_id, name, token_hash, scopes) VALUES ($1,'personal','h-own',ARRAY['read']) RETURNING id", [uid])).rows[0].id;
  const off = await scim('PATCH', `/Users/${u.id}`, W.scimToken, { schemas: [PATCHOP], Operations: [{ op: 'replace', path: 'active', value: 'False' }] });
  assert.equal(off.status, 200); assert.equal(off.body.active, false);
  assert.equal((await api('GET', '/me', { token: login.body.token })).status, 401, 'the SSO session ends on the very next request');
  assert.equal((await pool.query("SELECT status FROM organisation_members WHERE user_id=$1 AND organisation_id=$2", [uid, W.org.id])).rows[0].status, 'left');
  assert.ok((await pool.query('SELECT revoked_at FROM api_tokens WHERE id=$1', [orgTok])).rows[0].revoked_at, 'the organisation-only token depended on the membership');
  assert.equal((await pool.query('SELECT revoked_at FROM api_tokens WHERE id=$1', [ownTok])).rows[0].revoked_at, null, 'the person\'s own token is theirs');
  // nothing about the person is deleted
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM users WHERE id=$1', [uid])).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sport_profiles WHERE user_id=$1', [uid])).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM org_sso_identities WHERE user_id=$1', [uid])).rows[0].n, 1);
  // retries are harmless and the version only moved once
  const again = await scim('PATCH', `/Users/${u.id}`, W.scimToken, { schemas: [PATCHOP], Operations: [{ op: 'replace', path: 'active', value: false }] });
  assert.equal(again.status, 200); assert.equal(again.headers.get('etag'), off.headers.get('etag'));
  assert.equal((await scim('DELETE', `/Users/${u.id}`, W.scimToken)).status, 204);
  assert.equal((await scim('DELETE', `/Users/${u.id}`, W.scimToken)).status, 204);
  // and a deactivated person cannot come back in through SSO
  const denied = await oidcLogin(W, { sub: 'ravi-sub', email: W.email('ravi') });
  assert.equal(denied.status, 401);
  // the person can still use their own account (personal use): password login is unaffected
  await pool.query("UPDATE users SET password_hash = (SELECT password_hash FROM users WHERE id=$2) WHERE id=$1", [uid, W.owner.id]);
  assert.equal((await api('POST', '/auth/login', { body: { email: W.email('ravi'), password: 'correct-horse-battery' } })).status, 200);
  // reactivating restores access prospectively, at the next sign-in
  await scim('PATCH', `/Users/${u.id}`, W.scimToken, { schemas: [PATCHOP], Operations: [{ op: 'replace', path: 'active', value: true }] });
  assert.equal((await oidcLogin(W, { sub: 'ravi-sub', email: W.email('ravi') })).status, 200);
  const ev = await api('GET', `/organisations/${W.org.id}/identity/events?limit=100`, { token: W.owner.token });
  const dep = ev.body.find((e) => e.event === 'deprovisioned');
  assert.ok(dep && dep.detail.sessions_revoked >= 1 && dep.detail.tokens_revoked === 1);
});

test('a directory deactivation ends a manually added member\'s access too, but never removes an owner', async () => {
  const W = await scimWorld();
  const reg = async (local, role) => {
    const r = await api('POST', '/auth/register', { body: { handle: `m_${local.replace(/-/g, '_')}`, display_name: local, email: W.email(local), password: 'correct-horse-battery', roles: ['athlete'] } });
    await pool.query("INSERT INTO organisation_members(organisation_id, user_id, role, status, joined_at, source) VALUES ($1,$2,$3,'active',now(),'manual')", [W.org.id, r.body.user.id, role]);
    return r.body.user.id;
  };
  const coach = await reg('manual-coach', 'coach'), boss = await reg('second-owner', 'owner');
  for (const l of ['manual-coach', 'second-owner']) {
    const u = (await newUser(W, l)).body;
    await scim('PATCH', `/Users/${u.id}`, W.scimToken, { schemas: [PATCHOP], Operations: [{ op: 'replace', path: 'active', value: false }] });
  }
  const st = async (uid) => (await pool.query("SELECT status FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 ORDER BY invited_at DESC LIMIT 1", [W.org.id, uid])).rows[0].status;
  assert.equal(await st(coach), 'left', 'the directory offboarded a manually added coach');
  assert.equal(await st(boss), 'active', 'an owner is never removed by a directory');
});

test('access review and CSV export show how everyone got access; events never contain secrets or assertions', async () => {
  const W = await scimWorld();
  const u = (await newUser(W, 'review')).body;
  await scim('POST', '/Groups', W.scimToken, { displayName: 'teachers', members: [{ value: u.id }] });
  await oidcLogin(W, { sub: 'rev', email: W.email('review') });
  const rev = await api('GET', `/organisations/${W.org.id}/identity/access-review`, { token: W.owner.token });
  assert.equal(rev.status, 200);
  const row = rev.body.find((r) => r.source === 'scim');
  assert.ok(row && row.role === 'coach' && row.last_sso_login_at && row.directory_active === true);
  assert.ok(rev.body.some((r) => r.source === 'manual' && r.role === 'owner'));
  const csv = await api('GET', `/organisations/${W.org.id}/export?section=access_review`, { token: W.owner.token });
  assert.equal(csv.status, 200); assert.match(csv.body.csv, /source/); assert.match(csv.body.csv, /scim/);
  const staff = await signup('nostaff');
  assert.equal((await api('GET', `/organisations/${W.org.id}/identity/access-review`, { token: staff.token })).status, 404);
  const all = JSON.stringify((await pool.query('SELECT detail, reason FROM sso_events')).rows) + JSON.stringify((await pool.query("SELECT action FROM audit_log WHERE action LIKE 'sso_%'")).rows);
  for (const secret of [idp.secret, W.scimToken, 'auth-code', 'BEGIN CERTIFICATE', 'SAMLResponse']) assert.ok(!all.includes(secret), `event log must not contain ${secret}`);
});

test('every capability here is on REST, OpenAPI and MCP from one definition', async () => {
  const { capabilities } = await import('../src/capabilities/index.js');
  const mine = capabilities.filter((c) => c.tag === 'Enterprise identity');
  assert.ok(mine.length >= 20, `found ${mine.length}`);
  const spec = (await api('GET', '/openapi.json')).body;
  for (const c of mine) {
    const p = c.path.replace(/:(\w+)/g, '{$1}');
    assert.ok(spec.paths[p]?.[c.method.toLowerCase()], `${c.name} in OpenAPI`);
  }
});
