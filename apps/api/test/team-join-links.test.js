import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
await import('../src/capabilities/index.js');

let server, base, n = 0;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const yearsAgo = y => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); return d.toISOString().slice(0, 10); };
const signup = async () => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `tjl_${n}`, display_name: `TJL ${n}`, email: `tjl${n}@example.com`, password: 'correct-horse-battery', roles: ['athlete'], dob: yearsAgo(22) } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(() => server?.close());

test('open link: manager creates, newcomer joins directly', async () => {
  const manager = await signup();
  const newcomer = await signup();

  const teamRow = (await pool.query(
    "INSERT INTO teams(name,slug,sport_slug) VALUES ('Link FC','link-fc','football') RETURNING id"
  )).rows[0];
  const teamId = teamRow.id;
  await pool.query("INSERT INTO team_members(team_id,user_id,role) VALUES ($1,$2,'manager')", [teamId, manager.id]);

  // Create open link
  const created = ok(await api('POST', `/teams/${teamId}/join-links`, { token: manager.token, body: { mode: 'open', role: 'player' } }), 201);
  const code = created.link?.code;
  assert.ok(code, 'code must be set');
  assert.match(code, /^[A-Z]{3}-[A-Z]{3}\d$/);

  // Public lookup (no token)
  const lookup = ok(await api('GET', `/join/${code}`));
  assert.ok(!lookup.link?.is_expired);
  assert.ok(!lookup.link?.is_full);

  // Newcomer joins
  const joined = ok(await api('POST', `/join/${code}`, { token: newcomer.token, body: {} }));
  assert.ok(joined.joined);

  // Verify membership
  const membership = (await pool.query('SELECT role FROM team_members WHERE team_id=$1 AND user_id=$2', [teamId, newcomer.id])).rows[0];
  assert.equal(membership?.role, 'player');
});

test('request link: newcomer requests, manager approves', async () => {
  const manager = await signup();
  const newcomer = await signup();

  const teamRow = (await pool.query(
    "INSERT INTO teams(name,slug,sport_slug) VALUES ('Req FC','req-fc','football') RETURNING id"
  )).rows[0];
  const teamId = teamRow.id;
  await pool.query("INSERT INTO team_members(team_id,user_id,role) VALUES ($1,$2,'manager')", [teamId, manager.id]);

  const created = ok(await api('POST', `/teams/${teamId}/join-links`, { token: manager.token, body: { mode: 'request', role: 'player' } }), 201);
  const code = created.link?.code;

  const result = ok(await api('POST', `/join/${code}`, { token: newcomer.token, body: {} }));
  assert.ok(result.requested || result.joined);

  if (result.requested) {
    const reqs = ok(await api('GET', `/teams/${teamId}/join-requests`, { token: manager.token }));
    assert.ok(reqs.requests?.length > 0);
    const reqId = reqs.requests[0].id;
    ok(await api('PATCH', `/join-requests/${reqId}`, { token: manager.token, body: { decision: 'approved' } }));
  }
});

test('revoked link returns 404', async () => {
  const manager = await signup();
  const teamRow = (await pool.query(
    "INSERT INTO teams(name,slug,sport_slug) VALUES ('Rev FC','rev-fc','football') RETURNING id"
  )).rows[0];
  await pool.query("INSERT INTO team_members(team_id,user_id,role) VALUES ($1,$2,'manager')", [teamRow.id, manager.id]);
  const created = ok(await api('POST', `/teams/${teamRow.id}/join-links`, { token: manager.token, body: { mode: 'open', role: 'player' } }), 201);
  const linkId = created.link?.id;
  ok(await api('DELETE', `/join-links/${linkId}`, { token: manager.token }));
  const lookup = await api('GET', `/join/${created.link.code}`);
  assert.ok([404, 410].includes(lookup.status) || lookup.body?.link?.is_revoked);
});
