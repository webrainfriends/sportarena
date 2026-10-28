import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
let n = 0;
const signup = async (roles) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `ws_${n}_${roles[0]}`, display_name: `Ws ${n}`, email: `ws${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('the workspace needs a signed-in person', async () => {
  assert.equal((await api('GET', '/me/workspace')).status, 401);
});

test('a person with several roles can switch between them, and only between roles they hold', async () => {
  const u = await signup(['athlete', 'coach']);
  const first = await api('GET', '/me/workspace', { token: u.token });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.role, 'athlete');
  assert.deepEqual(first.body.roles.map((r) => r.key), ['athlete', 'coach']);
  const coach = await api('GET', '/me/workspace?role=coach', { token: u.token });
  assert.equal(coach.body.role, 'coach');
  assert.ok(coach.body.actions.some((a) => a.key === 'attendance'));
  assert.equal((await api('GET', '/me/workspace?role=venue_manager', { token: u.token })).status, 403, 'a role you do not hold is refused');
  assert.equal((await api('GET', '/me/workspace?role=admin', { token: u.token })).status, 400, 'platform roles are not workspaces');
});

test('every native role gets fast actions that name a screen, and platform roles never appear', async () => {
  for (const role of ['athlete', 'coach', 'organizer', 'referee', 'venue_manager']) {
    const u = await signup([role]);
    const w = await api('GET', '/me/workspace', { token: u.token });
    assert.equal(w.status, 200, `${role}: ${JSON.stringify(w.body)}`);
    assert.equal(w.body.role, role);
    assert.equal(w.body.generic, false, `${role} has a native workspace`);
    assert.ok(w.body.actions.length >= 3, `${role} has fast actions`);
    for (const a of w.body.actions) assert.ok(a.disabled || a.target?.screen || a.target?.tab, `${role}/${a.key} has a target or a reason it is off`);
    assert.ok(w.body.roles.every((r) => !['admin', 'platform_admin'].includes(r.key)));
  }
});

test('other roles get the labelled generic workspace, not a silent default', async () => {
  const u = await signup(['sponsor']);
  const w = await api('GET', '/me/workspace', { token: u.token });
  assert.equal(w.body.role, 'sponsor');
  assert.equal(w.body.generic, true);
  assert.equal(w.body.actions[0].target.screen, 'Sponsors');
});

test('an event manager sees what waits on them and the gate scanner opens on their event', async () => {
  const org = await signup(['organizer']), team = await signup(['athlete']);
  const ev = await api('POST', '/events', { token: org.token, body: { name: 'Gate Cup', sport: 'cricket', kind: 'friendly', starts_on: day(0), ends_on: day(1) } });
  assert.equal(ev.status, 201, JSON.stringify(ev.body));
  await pool.query("INSERT INTO event_entries(event_id, user_id, status) VALUES ($1,$2,'pending')", [ev.body.id, team.id]);
  const w = (await api('GET', '/me/workspace', { token: org.token })).body;
  assert.equal(w.today[0].title, 'Gate Cup');
  assert.ok(w.work.some((x) => x.kind === 'entries' && x.urgency === 'now'));
  const scan = w.actions.find((a) => a.key === 'scan');
  assert.equal(scan.target.screen, 'GateScan');
  assert.equal(scan.target.params.id, ev.body.id);
  assert.equal(scan.camera, true);
  assert.equal(w.summary.find((s) => s.key === 'approvals').value, 1);
  // another manager sees nothing of this event
  const other = await signup(['organizer']);
  const o = (await api('GET', '/me/workspace', { token: other.token })).body;
  assert.equal(o.work.length, 0);
  assert.ok(o.actions.find((a) => a.key === 'scan').disabled);
});

test('an athlete is asked to confirm a selection, and it reads from the selection capability', async () => {
  const owner = await signup(['organizer']), ath = await signup(['athlete']);
  const t = await api('POST', '/teams', { token: owner.token, body: { name: 'Ws XI', sport: 'cricket' } });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  const ev = await api('POST', '/events', { token: owner.token, body: { name: 'Ws Cup', sport: 'cricket', kind: 'friendly', starts_on: day(5), ends_on: day(5) } });
  const sq = await pool.query("INSERT INTO team_squads(team_id, event_id, user_id, status) VALUES ($1,$2,$3,'selected') RETURNING id", [t.body.id, ev.body.id, ath.id]);
  const w = (await api('GET', '/me/workspace', { token: ath.token })).body;
  const sel = w.work.find((x) => x.kind === 'selection');
  assert.ok(sel, JSON.stringify(w.work));
  assert.equal(w.summary.find((s) => s.key === 'selections').value, 1);
  // the one-tap answer is the selection capability's own endpoint, and the person who owns the selection is the only one who can use it
  const yes = sel.quick.find((q) => q.tone === 'yes');
  assert.equal(yes.path, `/squads/${sq.rows[0].id}`);
  assert.equal((await api(yes.method, yes.path, { token: owner.token, body: yes.body })).status, 403);
  assert.equal((await api(yes.method, yes.path, { token: ath.token, body: yes.body })).status, 200);
  assert.equal((await api(yes.method, yes.path, { token: ath.token, body: yes.body })).status, 200, 'answering twice (a retry after a dropped connection) is harmless');
  const after = (await api('GET', '/me/workspace', { token: ath.token })).body;
  assert.ok(!after.work.some((x) => x.kind === 'selection'), 'an answered selection leaves the queue');
});

test('a venue operator sees today\'s bookings and the venue-check shortcuts open on their venue', async () => {
  const owner = await signup(['venue_manager']);
  const v = await api('POST', '/venues', { token: owner.token, body: { name: 'Ws Arena', city: 'Pune' } });
  assert.equal(v.status, 201, JSON.stringify(v.body));
  const w = (await api('GET', '/me/workspace', { token: owner.token })).body;
  const checks = w.actions.find((a) => a.key === 'checks');
  assert.equal(checks.target.params.id, v.body.id);
  assert.equal(checks.target.params.tab, 'maintenance');
  assert.ok(w.work.some((x) => x.kind === 'no_insurance'), 'a venue with no insurance asks for attention');
});

test('every screen a workspace action or item points at is registered in the app', () => {
  const src = readFileSync(new URL('../src/capabilities/workspace.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../../app/src/App.js', import.meta.url), 'utf8');
  const pages = app.match(/const PAGES = \{([^\n]*)\}/)[1];
  const screens = [...new Set([...src.matchAll(/\bgo\('([A-Z][A-Za-z]+)'/g)].map((m) => m[1]).concat([...src.matchAll(/OWN_HOME = \{([^}]*)\}/g)].flatMap((m) => [...m[1].matchAll(/'([A-Z][A-Za-z]+)'/g)].map((x) => x[1]))))];
  assert.ok(screens.length > 10);
  const missing = screens.filter((s) => !new RegExp(`(?:^|[ ,])${s}(?:[:,]|$)`).test(pages));
  assert.deepEqual(missing, [], `workspace points at screens missing from PAGES: ${missing.join(', ')}`);
});
