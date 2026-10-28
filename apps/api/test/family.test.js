import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { backfillYouth } = await import('../src/youth.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const rpc = async (method, params, token) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return (await r.json()).result;
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const inst = (offsetDays) => new Date(Date.now() + offsetDays * 864e5).toISOString();
const signup = async (roles = ['athlete'], extra = {}) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `fm_${n}_${roles[0]}`, display_name: `Fam ${n}`, email: `fm${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const kid = (age = 12) => signup(['athlete'], { dob: yearsAgo(age) });
const evidence = { reference: 'https://example.com/birth-certificate-ref-123', label: 'Birth certificate' };

async function verifiedGuardian(parent, child, extra = {}) {
  const l = must(await api('POST', '/youth/guardian-links', { token: parent.token, body: { guardian_id: parent.id, child_id: child.id, relationship: 'parent' } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: child.token, body: { accept: true } }));
  must(await api('POST', `/youth/guardian-links/${l.id}/evidence`, { token: parent.token, body: { evidence } }), 201);
  return must(await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Documents match', ...extra } }));
}
const allow = async (parent, child, purpose) => must(await api('POST', `/youth/children/${child.id}/consents`, { token: parent.token, body: { purpose } }), 201);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('fm_root','fm_root','{admin}','x','x','fm_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  await backfillYouth();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

/** A guardian with two children in different teams of one competition, both on the same fixture day. */
async function household() {
  const org = await signup(['organizer']), mgr = await signup(['athlete']), mgr2 = await signup(['athlete']);
  const team = must(await api('POST', '/teams', { token: mgr.token, body: { name: `Bats ${++n}`, sport: 'cricket' } }), 201);
  const rival = must(await api('POST', '/teams', { token: mgr2.token, body: { name: `Rivals ${++n}`, sport: 'cricket' } }), 201);
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: `Cup ${n}`, sport: 'cricket', starts_on: day(5), ends_on: day(30) } }), 201);
  for (const [t, tok] of [[team, mgr.token], [rival, mgr2.token]]) {
    const en = must(await api('POST', `/events/${ev.id}/entries`, { token: tok, body: { team_id: t.id } }), 201);
    must(await api('PATCH', `/entries/${en.id}`, { token: org.token, body: { status: 'accepted' } }));
  }
  const fx = must(await api('POST', `/events/${ev.id}/fixtures`, { token: org.token, body: { home_team_id: team.id, away_team_id: rival.id, scheduled_at: inst(3) } }), 201);
  const parent = await signup(), c1 = await kid(12), c2 = await kid(10);
  await verifiedGuardian(parent, c1); await verifiedGuardian(parent, c2);
  await allow(parent, c1, 'participation'); await allow(parent, c2, 'participation');
  must(await api('POST', `/teams/${team.id}/members`, { token: mgr.token, body: { user_id: c1.id } }), 201);
  must(await api('POST', `/teams/${rival.id}/members`, { token: mgr2.token, body: { user_id: c2.id } }), 201);
  return { org, mgr, mgr2, team, rival, ev, fx, parent, c1, c2 };
}

test('one guardian sees both children on one dashboard, switches between them, and nobody else sees them', async () => {
  const h = await household();
  const d = must(await api('GET', '/me/family', { token: h.parent.token }));
  assert.deepEqual(d.dependents.map((x) => x.person.id).sort(), [h.c1.id, h.c2.id].sort());
  assert.ok(d.dependents.every((x) => x.upcoming.length >= 1), 'each child has the fixture coming up');
  // switch to one child
  const one = must(await api('GET', '/me/family', { token: h.parent.token, query: { child_id: h.c1.id } }));
  assert.deepEqual(one.dependents.map((x) => x.person.id), [h.c1.id]);
  // a stranger, the other child's team manager and the child themselves are not guardians: 404 for a child, empty for the dashboard
  const stranger = await signup();
  assert.equal((await api('GET', '/me/family', { token: stranger.token, query: { child_id: h.c1.id } })).status, 404);
  assert.deepEqual(must(await api('GET', '/me/family', { token: stranger.token })).dependents, []);
  assert.equal((await api('GET', '/me/family', { token: h.mgr.token, query: { child_id: h.c1.id } })).status, 404);
  assert.equal((await api('GET', '/me/family', { token: h.c1.token, query: { child_id: h.c1.id } })).status, 404);
  // a second guardian of c1 only: c2 stays hidden from them
  const other = await signup(); await verifiedGuardian(other, h.c1, { exceptional: true });
  assert.deepEqual(must(await api('GET', '/me/family', { token: other.token })).dependents.map((x) => x.person.id), [h.c1.id]);
  assert.equal((await api('GET', '/me/family', { token: other.token, query: { child_id: h.c2.id } })).status, 404);
  // ending the link removes the child from the dashboard at once
  const links = must(await api('GET', '/youth/guardian-links', { token: other.token }));
  must(await api('POST', `/youth/guardian-links/${links.find((l) => l.child_id === h.c1.id).id}/revoke`, { token: other.token, body: { reason: 'test' } }));
  assert.deepEqual(must(await api('GET', '/me/family', { token: other.token })).dependents, []);
});

test('RSVP for each child from one account, with access boundaries', async () => {
  const h = await household();
  must(await api('POST', `/teams/${h.team.id}/attendance/request`, { token: h.mgr.token, body: { fixture_id: h.fx.id } }));
  must(await api('POST', `/teams/${h.rival.id}/attendance/request`, { token: h.mgr2.token, body: { fixture_id: h.fx.id } }));
  // the guardians are asked too
  const inbox = must(await api('GET', '/notifications', { token: h.parent.token }));
  assert.ok(inbox.items.filter((x) => x.kind === 'team_attendance_request').length >= 2, 'guardian is notified for each child');
  const d = must(await api('GET', '/me/family', { token: h.parent.token }));
  const todo = d.todo.filter((t) => t.kind === 'rsvp');
  assert.equal(todo.length, 2);
  // answer for c1 (team) and c2 (rival) using the action the dashboard gave
  for (const t of todo) {
    const a = t.action;
    must(await api('POST', `/teams/${a.team_id}/attendance`, { token: h.parent.token, body: { fixture_id: a.fixture_id, rsvp: 'going', for_user_id: a.child_id } }));
  }
  assert.equal(must(await api('GET', '/me/family', { token: h.parent.token })).todo.filter((t) => t.kind === 'rsvp').length, 0);
  const rows = (await pool.query("SELECT user_id, rsvp FROM team_attendance WHERE fixture_id=$1 AND rsvp='going'", [h.fx.id])).rows.map((r) => r.user_id).sort();
  assert.deepEqual(rows, [h.c1.id, h.c2.id].sort());
  // boundaries: not for a child of someone else, not for an adult, not to a team the child is not on
  const stranger = await signup();
  assert.equal((await api('POST', `/teams/${h.team.id}/attendance`, { token: stranger.token, body: { fixture_id: h.fx.id, rsvp: 'going', for_user_id: h.c1.id } })).status, 403);
  assert.equal((await api('POST', `/teams/${h.team.id}/attendance`, { token: h.parent.token, body: { fixture_id: h.fx.id, rsvp: 'going', for_user_id: h.c2.id } })).status, 404, 'c2 is not on this team');
  assert.equal((await api('POST', `/teams/${h.team.id}/attendance`, { token: h.parent.token, body: { fixture_id: h.fx.id, rsvp: 'going', for_user_id: h.mgr.id } })).status, 403);
});

test('fees for both children land in one place and are paid by the guardian only', async () => {
  const h = await household();
  must(await api('POST', `/teams/${h.team.id}/charges`, { token: h.mgr.token, body: { kind: 'dues', title: 'Spring dues', amount_minor: 5000, audience: 'members', member_ids: [h.c1.id], idempotency_key: `fee-a-${n}-aaaa` } }), 201);
  must(await api('POST', `/teams/${h.rival.id}/charges`, { token: h.mgr2.token, body: { kind: 'season_fee', title: 'Season fee', amount_minor: 12000, audience: 'members', member_ids: [h.c2.id], idempotency_key: `fee-b-${n}-bbbb` } }), 201);
  const d = must(await api('GET', '/me/family', { token: h.parent.token }));
  const pay = d.todo.filter((t) => t.kind === 'payment');
  assert.equal(pay.length, 2);
  assert.ok(pay.every((t) => t.action.purpose?.purpose_type === 'team_charge'));
  assert.equal(d.due.reduce((s, x) => s + x.due_minor, 0), 17000);
  // a child's own dashboard never lists money, and neither does a stranger's
  assert.deepEqual(must(await api('GET', '/me/family', { token: h.c1.token })).due, []);
});

test('guardian registers a child; boundaries hold; registrations show with the household', async () => {
  const h = await household();
  must(await api('POST', `/events/${h.ev.id}/registration/policy`, { token: h.org.token, body: { rules: {}, expected_version: 0 } }), 201);
  let d = must(await api('GET', '/me/family', { token: h.parent.token }));
  const reg = d.todo.filter((t) => t.kind === 'registration');
  assert.equal(reg.length, 2, 'registration is open for both children');
  const stranger = await signup();
  assert.equal((await api('POST', `/events/${h.ev.id}/registrations`, { token: stranger.token, body: { team_id: h.team.id, user_id: h.c1.id } })).status, 404);
  assert.equal((await api('POST', `/events/${h.ev.id}/registrations`, { token: h.parent.token, body: { team_id: h.team.id, user_id: h.c2.id } })).status, 400, 'c2 is not on that team');
  for (const t of reg) must(await api('POST', `/events/${h.ev.id}/registrations`, { token: h.parent.token, body: { team_id: t.action.team_id, user_id: t.action.child_id } }), 201);
  d = must(await api('GET', '/me/family', { token: h.parent.token }));
  assert.equal(d.todo.filter((t) => t.kind === 'registration').length, 0);
  assert.equal(d.dependents.flatMap((x) => x.registrations).length, 2);
  const mine = must(await api('GET', '/me/registrations', { token: h.parent.token, query: { include_dependents: 'true' } }));
  assert.deepEqual(mine.map((r) => r.user_id).sort(), [h.c1.id, h.c2.id].sort());
  assert.deepEqual(must(await api('GET', '/me/registrations', { token: h.parent.token })), [], 'dependents only when asked');
});

test('combined family calendar flags a clash between two children, and consent withdrawal surfaces as a task', async () => {
  const h = await household();
  const cal = must(await api('GET', '/me/family/schedule', { token: h.parent.token, query: { from: day(0), to: day(10) } }));
  assert.ok(cal.items.some((x) => x.person.id === h.c1.id) && cal.items.some((x) => x.person.id === h.c2.id));
  assert.equal(cal.family_clashes.length, 1, 'two children on the same fixture time are one clash');
  assert.ok(cal.items.filter((x) => x.family_clash).length >= 2);
  assert.ok(cal.items.every((x) => !['health', 'recovery', 'external', 'duty'].includes(x.kind)), 'no private kinds for a child');
  const one = must(await api('GET', '/me/family/schedule', { token: h.parent.token, query: { from: day(0), to: day(10), child_id: h.c1.id } }));
  assert.ok(one.items.every((x) => x.person.id === h.c1.id));
  assert.equal((await api('GET', '/me/family/schedule', { token: (await signup()).token, query: { child_id: h.c1.id } })).status, 404);
  // withdrawing a permission becomes a task for the guardian
  must(await api('DELETE', `/youth/children/${h.c1.id}/consents/participation`, { token: h.parent.token }));
  const d = must(await api('GET', '/me/family', { token: h.parent.token }));
  const t = d.todo.find((x) => x.kind === 'consent' && x.action.child_id === h.c1.id);
  assert.equal(t.action.purpose, 'participation');
});

test('MCP and OpenAPI expose the family capabilities', async () => {
  const h = await household();
  const tools = (await rpc('tools/list', {}, h.parent.token)).tools.map((x) => x.name);
  for (const name of ['get_family_dashboard', 'get_family_schedule']) assert.ok(tools.includes(name), name);
  const call = await rpc('tools/call', { name: 'get_family_dashboard', arguments: {} }, h.parent.token);
  assert.equal(JSON.parse(call.content[0].text).dependents.length, 2);
  const spec = await (await fetch(`${base}/api/v1/openapi.json`)).json();
  assert.ok(spec.paths['/me/family'] && spec.paths['/me/family/schedule']);
  assert.equal((await api('GET', '/me/family')).status, 401);
});
