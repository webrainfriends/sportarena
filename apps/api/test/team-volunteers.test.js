import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
await import('../src/capabilities/index.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const yearsAgo = y => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); return d.toISOString().slice(0, 10); };
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `tv_${n}_${roles[0]}`, display_name: `TV ${n}`, email: `tv${n}@example.com`, password: 'correct-horse-battery', roles, dob: yearsAgo(25) } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('tv_root','TV Root','{admin}','x','x','tv_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(() => server?.close());

test('volunteer lifecycle: create position, apply, approve, check-in, check-out', async () => {
  const manager = await signup(['coach']);
  const player = await signup(['athlete']);

  // Create a team
  const teamRow = (await pool.query(
    "INSERT INTO teams(name,slug,sport_slug) VALUES ('Vol FC','vol-fc','football') RETURNING id"
  )).rows[0];
  const teamId = teamRow.id;
  await pool.query("INSERT INTO team_members(team_id,user_id,role) VALUES ($1,$2,'manager')", [teamId, manager.id]);
  await pool.query("INSERT INTO team_members(team_id,user_id,role) VALUES ($1,$2,'player')", [teamId, player.id]);

  const shift = new Date(Date.now() + 86400000);
  const shiftEnd = new Date(Date.now() + 86400000 + 7200000);

  // Manager creates position
  const pos = ok(await api('POST', '/volunteer-positions', { token: manager.token, body: {
    team_id: teamId,
    title: 'Match Day Check-in',
    role_category: 'check_in',
    shift_start: shift.toISOString(),
    shift_end: shiftEnd.toISOString(),
    capacity: 2,
  } }), 201);
  assert.ok(pos.position?.id);
  const posId = pos.position.id;

  // Player applies
  const app = ok(await api('POST', `/volunteer-positions/${posId}/apply`, { token: player.token, body: { shirt_size: 'M' } }), 201);
  assert.equal(app.application.status, 'pending');
  const appId = app.application.id;

  // Manager approves
  ok(await api('POST', `/volunteer-applications/${appId}/respond`, { token: manager.token, body: { decision: 'approved' } }));

  // Player checks in
  ok(await api('POST', `/volunteer-applications/${appId}/check-in`, { token: manager.token, body: {} }));

  // Player checks out
  const out = ok(await api('POST', `/volunteer-applications/${appId}/check-out`, { token: manager.token, body: {} }));
  assert.ok(out.application.hours_logged >= 0);
});

test('non-manager cannot create volunteer position', async () => {
  const rando = await signup(['athlete']);
  const teamRow = (await pool.query(
    "INSERT INTO teams(name,slug,sport_slug) VALUES ('NM FC','nm-fc','football') RETURNING id"
  )).rows[0];
  await pool.query("INSERT INTO team_members(team_id,user_id,role) VALUES ($1,$2,'player')", [teamRow.id, rando.id]);

  const r = await api('POST', '/volunteer-positions', { token: rando.token, body: {
    team_id: teamRow.id, title: 'Hacker', role_category: 'general',
    shift_start: new Date().toISOString(), shift_end: new Date().toISOString(), capacity: 1,
  } });
  assert.equal(r.status, 403);
});
