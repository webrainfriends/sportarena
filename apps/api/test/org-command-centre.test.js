import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { capabilities } = await import('../src/registry.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const person = async () => {
  n++;
  const r = await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ($1,$2,'{}','x','x',$1) RETURNING id", [`cc_${n}`, `Person ${n}`]);
  return { id: r.rows[0].id, token: await signToken({ id: r.rows[0].id, roles: [] }) };
};
const join = (org, u, role) => pool.query("INSERT INTO organisation_members(organisation_id, user_id, role, status, joined_at) VALUES ($1,$2,$3,'active',now())", [org, u.id, role]);
const day = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

async function setup() {
  const owner = await person();
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Command Club ${++n}`, kind: 'club' } }), 201);
  return { owner, org };
}

test('every area is reported, per role, and outsiders get a 404', async () => {
  const { owner, org } = await setup();
  const coach = await person(), fin = await person(), sponsor = await person(), outsider = await person();
  await join(org.id, coach, 'coach'); await join(org.id, fin, 'finance'); await join(org.id, sponsor, 'manager');

  const full = must(await api('GET', `/organisations/${org.id}/command-centre`, { token: owner.token }));
  assert.deepEqual(full.tiles.map((t) => t.key).sort(), ['athletes', 'compliance', 'documents', 'events', 'finance', 'registrations', 'sponsors', 'staff', 'suppliers', 'tasks', 'teams', 'venues']);
  assert.equal(full.waiting.total, 0);
  assert.ok(full.tiles.every((t) => typeof t.summary === 'string' && t.summary.length));

  const c = must(await api('GET', `/organisations/${org.id}/command-centre`, { token: coach.token }));
  assert.deepEqual(c.tiles.map((t) => t.key).sort(), ['athletes', 'tasks', 'teams']);
  const f = must(await api('GET', `/organisations/${org.id}/command-centre`, { token: fin.token }));
  assert.deepEqual(f.tiles.map((t) => t.key).sort(), ['finance', 'sponsors', 'suppliers']);

  assert.equal((await api('GET', `/organisations/${org.id}/command-centre`, { token: outsider.token })).status, 404);
  assert.equal((await api('GET', `/organisations/${org.id}/command-centre/approvals`, { token: outsider.token })).status, 404);
  assert.equal((await api('GET', `/organisations/${org.id}/command-centre`, { token: sponsor.token })).status, 403); // sponsor-side roles have their own tab
  assert.equal((await api('GET', `/organisations/${org.id}/command-centre`)).status, 401);
});

test('an org admin who is not the organiser decides an event entry from the queue', async () => {
  const { owner, org } = await setup();
  const admin = await person(), entrant = await person();
  await join(org.id, admin, 'admin');
  const ev = must(await api('POST', '/events', { token: owner.token, body: { name: 'Command Cup', sport: 'football', kind: 'tournament', organisation_id: org.id, starts_on: day(10), ends_on: day(11) } }), 201);
  await pool.query('UPDATE events SET organisation_id=$2 WHERE id=$1', [ev.id, org.id]);
  const team = must(await api('POST', '/teams', { token: entrant.token, body: { name: `Entrants ${n}`, sport: 'football' } }), 201);
  await pool.query("INSERT INTO event_entries(event_id, team_id, status) VALUES ($1,$2,'pending')", [ev.id, team.id]);

  const q = must(await api('GET', `/organisations/${org.id}/command-centre/approvals`, { token: admin.token, query: { domain: 'registrations' } }));
  assert.equal(q.total, 1);
  const item = q.items[0];
  assert.equal(item.can_act, true);
  const accept = item.actions.find((a) => a.label === 'Accept');
  assert.equal(accept.cap, 'decide_entry');
  assert.ok(capabilities.some((c) => c.name === accept.cap && c.method === accept.method), 'the action names a real capability');
  must(await api(accept.method, accept.path, { token: admin.token, body: accept.body }));
  assert.equal((await pool.query('SELECT status FROM event_entries WHERE event_id=$1', [ev.id])).rows[0].status, 'accepted');
  assert.equal(must(await api('GET', `/organisations/${org.id}/command-centre/approvals`, { token: admin.token })).total, 0);

  // someone with no grant still cannot decide
  await pool.query("INSERT INTO event_entries(event_id, user_id, status) VALUES ($1,$2,'pending')", [ev.id, entrant.id]);
  const e2 = (await pool.query("SELECT id FROM event_entries WHERE user_id=$1", [entrant.id])).rows[0];
  assert.equal((await api('PATCH', `/entries/${e2.id}`, { token: entrant.token, body: { status: 'accepted' } })).status, 403);
});

test('time off and timesheets are queued for others, never for the person who asked', async () => {
  const { owner, org } = await setup();
  const staff = await person();
  await join(org.id, staff, 'coach');
  await pool.query("INSERT INTO academy_staff_availability(organisation_id, user_id, kind, on_date, status) VALUES ($1,$2,'time_off',$3,'pending')", [org.id, staff.id, day(5)]);
  await pool.query("INSERT INTO academy_timesheets(organisation_id, user_id, kind, work_date, minutes, status) VALUES ($1,$2,'manual',$3,90,'submitted')", [org.id, staff.id, day(-1)]);
  const q = must(await api('GET', `/organisations/${org.id}/command-centre/approvals`, { token: owner.token, query: { domain: 'staff' } }));
  assert.equal(q.total, 2);
  assert.ok(q.items.every((i) => i.actions.length >= 2 && i.can_act));
  const off = q.items.find((i) => i.key.startsWith('staff:off'));
  must(await api(off.actions[0].method, off.actions[0].path, { token: owner.token, body: off.actions[0].body }));
  assert.equal(must(await api('GET', `/organisations/${org.id}/command-centre/approvals`, { token: owner.token, query: { domain: 'staff' } })).total, 1);
  // a coach has no decisions to make and sees no staff queue
  assert.equal(must(await api('GET', `/organisations/${org.id}/command-centre/approvals`, { token: staff.token })).total, 0);
  const tile = must(await api('GET', `/organisations/${org.id}/command-centre`, { token: owner.token })).tiles.find((t) => t.key === 'staff');
  assert.equal(tile.severity, 'warn');
});

test('agreements are decided by owners only; overdue tasks are listed with their record', async () => {
  const { owner, org } = await setup();
  const admin = await person();
  await join(org.id, admin, 'admin');
  await pool.query("INSERT INTO org_agreements(organisation_id, kind, title, status, submitted_at, created_by) VALUES ($1,'participation','Participation terms','submitted',now(),$2)", [org.id, owner.id]);
  assert.equal(must(await api('GET', `/organisations/${org.id}/command-centre/approvals`, { token: admin.token, query: { domain: 'compliance' } })).total, 0);
  const q = must(await api('GET', `/organisations/${org.id}/command-centre/approvals`, { token: owner.token, query: { domain: 'compliance' } }));
  assert.equal(q.total, 1);
  assert.deepEqual(q.items[0].actions.find((a) => a.label === 'Reject').ask.map((f) => f.key), ['note']);
  assert.deepEqual(q.items[0].record, { screen: 'Org', params: { id: org.id, tab: 'agreements' } });

  const team = must(await api('POST', '/teams', { token: owner.token, body: { name: `Board ${n}`, sport: 'football', organisation_id: org.id } }), 201);
  must(await api('POST', `/teams/${team.id}/tasks`, { token: owner.token, body: { title: 'Book the minibus', due_on: day(-3), assignee_ids: [owner.id] } }), 201);
  must(await api('POST', `/teams/${team.id}/tasks`, { token: owner.token, body: { title: 'Order bibs', due_on: day(7) } }), 201);
  const tasks = must(await api('GET', `/organisations/${org.id}/command-centre/tasks`, { token: owner.token }));
  assert.deepEqual(tasks.map((t) => [t.title, t.overdue]), [['Book the minibus', true], ['Order bibs', false]]);
  assert.equal(tasks[0].context_id, team.id);
  const mine = must(await api('GET', `/organisations/${org.id}/command-centre/tasks`, { token: admin.token }));
  assert.equal(mine.length, 2); // owner/admin see all
  const coach = await person(); await join(org.id, coach, 'coach');
  assert.equal(must(await api('GET', `/organisations/${org.id}/command-centre/tasks`, { token: coach.token })).length, 0);
  const overdue = must(await api('GET', `/organisations/${org.id}/command-centre/approvals`, { token: owner.token, query: { domain: 'tasks' } }));
  assert.deepEqual(overdue.items.map((i) => i.title), ['Book the minibus']);
  assert.deepEqual(overdue.items[0].record, { screen: 'TeamWorkspace', params: { id: team.id } });
});

test('season rollover copies the structure, not the people or money, and is safe to repeat', async () => {
  const { owner, org } = await setup();
  const coach = await person(), ex = await person(), athlete = await person();
  await join(org.id, coach, 'coach');
  const s1 = must(await api('POST', `/organisations/${org.id}/seasons`, { token: owner.token, body: { name: '2026', starts_on: '2026-01-01', ends_on: '2026-12-31' } }), 201);
  const team = must(await api('POST', '/teams', { token: owner.token, body: { name: `Squad ${n}`, sport: 'football', organisation_id: org.id } }), 201);
  const k1 = must(await api('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: 'Under 12', season_id: s1.id, team_id: team.id, coach_id: coach.id, capacity: 20 } }), 201);
  must(await api('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: 'Under 14', season_id: s1.id, capacity: 16 } }), 201);
  await pool.query("INSERT INTO org_enrolments(cohort_id, user_id, status, consent_at, enrolled_by) VALUES ($1,$2,'enrolled',now(),$3)", [k1.id, athlete.id, owner.id]);
  await join(org.id, ex, 'coach');
  const body = { name: '2027', starts_on: '2027-01-01', ends_on: '2027-12-31' };

  const dry = must(await api('POST', `/organisations/${org.id}/seasons/${s1.id}/rollover`, { token: owner.token, body: { ...body, dry_run: true } }), 201);
  assert.equal(dry.dry_run, true);
  assert.deepEqual(dry.cohorts.map((c) => c.name), ['Under 12', 'Under 14']);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM org_seasons WHERE name='2027'")).rows[0].n, 0);

  const done = must(await api('POST', `/organisations/${org.id}/seasons/${s1.id}/rollover`, { token: owner.token, body }), 201);
  const rows = (await pool.query('SELECT name, capacity, coach_id, team_id, rolled_from_id FROM org_cohorts WHERE season_id=$1 ORDER BY name', [done.season.id])).rows;
  assert.deepEqual(rows.map((r) => [r.name, r.capacity]), [['Under 12', 20], ['Under 14', 16]]);
  assert.equal(rows[0].coach_id, coach.id); assert.equal(rows[0].team_id, team.id); assert.equal(rows[0].rolled_from_id, k1.id);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.season_id=$1', [done.season.id])).rows[0].n, 0, 'enrolments stay with the old season');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.season_id=$1', [s1.id])).rows[0].n, 1);
  assert.equal((await pool.query('SELECT status FROM org_seasons WHERE id=$1', [s1.id])).rows[0].status, 'active');

  assert.equal((await api('POST', `/organisations/${org.id}/seasons/${s1.id}/rollover`, { token: owner.token, body })).status, 409); // repeating cannot duplicate
  assert.equal((await api('POST', `/organisations/${org.id}/seasons/${s1.id}/rollover`, { token: owner.token, body: { ...body, name: '2028', starts_on: '2025-01-01', ends_on: '2025-06-01' } })).status, 400);
  assert.equal((await api('POST', `/organisations/${org.id}/seasons/${s1.id}/rollover`, { token: coach.token, body: { ...body, name: '2029' } })).status, 403);

  // a coach who has since left is dropped from the copy, with the reason shown
  await pool.query("UPDATE organisation_members SET status='left' WHERE user_id=$1", [coach.id]);
  const again = must(await api('POST', `/organisations/${org.id}/seasons/${s1.id}/rollover`, { token: owner.token, body: { name: '2028', starts_on: '2028-01-01', ends_on: '2028-12-31', archive_previous: true, carry: { cohorts: true, coaches: true, team_links: false } } }), 201);
  assert.ok(again.cohorts[0].dropped.includes('coach is no longer active staff'));
  assert.equal((await pool.query('SELECT status FROM org_seasons WHERE id=$1', [s1.id])).rows[0].status, 'archived');
});

test('templates carry structure only and are visible only to people who run the source organisation', async () => {
  const { owner, org } = await setup();
  const { org: other } = await (async () => { const o = await api('POST', '/organisations', { token: owner.token, body: { name: `Second ${++n}`, kind: 'club' } }); return { org: must(o, 201) }; })();
  const stranger = await person();
  const stranger_org = must(await api('POST', '/organisations', { token: stranger.token, body: { name: `Stranger ${++n}`, kind: 'club' } }), 201);
  must(await api('POST', `/organisations/${org.id}/departments`, { token: owner.token, body: { name: 'Youth' } }), 201);
  const s = must(await api('POST', `/organisations/${org.id}/seasons`, { token: owner.token, body: { name: '2026', starts_on: '2026-01-01', ends_on: '2026-12-31' } }), 201);
  must(await api('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: 'Under 10', season_id: s.id, capacity: 12 } }), 201);
  const t = must(await api('POST', `/organisations/${org.id}/templates`, { token: owner.token, body: { name: 'Junior club', season_id: s.id } }), 201);
  assert.deepEqual(t.structure, { departments: ['Youth'], cohorts: [{ name: 'Under 10', capacity: 12 }] });
  assert.equal((await api('POST', `/organisations/${org.id}/templates`, { token: owner.token, body: { name: 'junior CLUB' } })).status, 409);

  assert.equal(must(await api('GET', `/organisations/${other.id}/templates`, { token: owner.token })).length, 1);
  assert.equal(must(await api('GET', `/organisations/${stranger_org.id}/templates`, { token: stranger.token })).length, 0);
  assert.equal((await api('POST', `/organisations/${stranger_org.id}/templates/${t.id}/apply`, { token: stranger.token, body: { season_id: s.id } })).status, 404);

  const s2 = must(await api('POST', `/organisations/${other.id}/seasons`, { token: owner.token, body: { name: '2026', starts_on: '2026-01-01', ends_on: '2026-12-31' } }), 201);
  assert.equal((await api('POST', `/organisations/${other.id}/templates/${t.id}/apply`, { token: owner.token, body: {} })).status, 400); // groups need a season
  const dry = must(await api('POST', `/organisations/${other.id}/templates/${t.id}/apply`, { token: owner.token, body: { season_id: s2.id, dry_run: true } }));
  assert.deepEqual([dry.departments_added, dry.cohorts_added], [['Youth'], ['Under 10']]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM org_cohorts WHERE organisation_id=$1', [other.id])).rows[0].n, 0);
  must(await api('POST', `/organisations/${other.id}/templates/${t.id}/apply`, { token: owner.token, body: { season_id: s2.id } }));
  const twice = must(await api('POST', `/organisations/${other.id}/templates/${t.id}/apply`, { token: owner.token, body: { season_id: s2.id } }));
  assert.deepEqual([twice.departments_added, twice.cohorts_added, twice.skipped], [[], [], { departments: 1, cohorts: 1 }]);
  must(await api('DELETE', `/organisations/${org.id}/templates/${t.id}`, { token: owner.token }));
  assert.equal(must(await api('GET', `/organisations/${other.id}/templates`, { token: owner.token })).length, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM org_templates')).rows[0].n, 1, 'retired, not deleted');
});
