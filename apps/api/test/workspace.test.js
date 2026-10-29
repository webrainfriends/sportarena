import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { linkFor, PERSONAS, PERSONA_KEYS, SECTIONS, WORK, CALENDAR_KINDS } = await import('../src/workspace.js');

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
const must = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const section = async (u, s, q = '') => must(await api('GET', `/me/workspace/${s}${q}`, { token: u.token }));
const actions = async (u, role, scope) => (await section(u, 'actions', `?role=${role}${scope ? `&scope_id=${scope}` : ''}`)).items;
const quick = (a, label) => a.quick.find((x) => x.label === label);
const runQuick = (u, q) => api(q.method, `/${q.path.replace(/^\//, '')}`, { token: u.token, body: q.body });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const team = async (owner, name) => (await api('POST', '/teams', { token: owner.token, body: { name: `${name} ${Math.random().toString(36).slice(2, 6)}`, sport: 'football' } })).body;
const fixture = async (eventId, h, a, at) => (await pool.query("INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at, status) VALUES ($1,$2,$3,$4,'scheduled') RETURNING id", [eventId, h, a, at])).rows[0].id;

test('persona 1 - athlete: a selection is answered from the Actions queue and disappears; availability is one tap', async () => {
  const mgr = await signup(['athlete']), ath = await signup(['athlete']);
  const ev = must(await api('POST', '/events', { token: mgr.token, body: { name: 'Cup', sport: 'football', kind: 'tournament', starts_on: day(3), ends_on: day(3) } }));
  const [h, a] = [await team(mgr, 'Home'), await team(mgr, 'Away')];
  const fx = await fixture(ev.id, h.id, a.id, new Date(Date.now() + 3 * 864e5));
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [h.id, ath.id]);
  const sq = (await pool.query("INSERT INTO team_squads(team_id, event_id, fixture_id, user_id, role, status, selected_by) VALUES ($1,$2,$3,$4,'player','selected',$5) RETURNING id", [h.id, ev.id, fx, ath.id, mgr.id])).rows[0].id;

  const ctx = must(await api('GET', '/me/workspace', { token: ath.token }));
  const c = ctx.contexts.find((x) => x.key === 'athlete');
  assert.ok(c && c.actions >= 2, 'a selection and an availability prompt are waiting');
  const items = await actions(ath, 'athlete');
  const sel = items.find((x) => x.id === `squad:${sq}`);
  assert.equal(sel.link.screen, 'Team'); assert.equal(sel.link.params.id, h.id);
  const av = items.find((x) => x.id === `availability:${h.id}`);
  must(await runQuick(ath, quick(av, 'Available')));
  must(await runQuick(ath, quick(sel, 'Confirm')));
  const after = await actions(ath, 'athlete');
  assert.ok(!after.some((x) => x.id === `squad:${sq}` || x.id === `availability:${h.id}`), 'answered items leave the queue');
  const today = await section(ath, 'calendar', '?role=athlete');
  assert.ok(today.items.some((x) => x.source_type === 'team_squad'), JSON.stringify(today.items.map((x) => [x.kind, x.source_type])));
  assert.deepEqual(today.kinds, CALENDAR_KINDS.athlete);
});

test('persona 2 - event manager: a registration is decided from the queue, scoped to one event', async () => {
  const org = await signup(['organizer']), p = await signup(['athlete']);
  const e1 = must(await api('POST', '/events', { token: org.token, body: { name: 'Open A', sport: 'football', kind: 'tournament', starts_on: day(9), ends_on: day(9) } }));
  const e2 = must(await api('POST', '/events', { token: org.token, body: { name: 'Open B', sport: 'football', kind: 'tournament', starts_on: day(10), ends_on: day(10) } }));
  const x = (await pool.query("INSERT INTO event_entries(event_id, user_id, status) VALUES ($1,$2,'pending') RETURNING id", [e1.id, p.id])).rows[0].id;
  await pool.query("INSERT INTO event_tasks(event_id, title, due_on, status, created_by) VALUES ($1,'Book medics',$2,'todo',$3)", [e2.id, day(1), org.id]);
  const ctx = must(await api('GET', '/me/workspace', { token: org.token })).contexts.find((c) => c.key === 'event_manager');
  assert.deepEqual(ctx.scopes.map((s) => s.id).sort(), [e1.id, e2.id].sort());
  const onlyB = await actions(org, 'event_manager', e2.id);
  assert.ok(onlyB.some((a) => a.kind === 'event_task') && !onlyB.some((a) => a.kind === 'entry'), 'scope narrows the queue');
  const all = await actions(org, 'event_manager');
  const entry = all.find((a) => a.id === `entry:${x}`);
  assert.equal(entry.link.screen, 'EventCommand'); assert.equal(entry.link.params.id, e1.id);
  must(await runQuick(org, quick(entry, 'Accept')));
  assert.equal((await pool.query('SELECT status FROM event_entries WHERE id=$1', [x])).rows[0].status, 'accepted');
  assert.ok(!(await actions(org, 'event_manager')).some((a) => a.id === `entry:${x}`));
  const work = await section(org, 'work', '?role=event_manager');
  assert.ok(work.items.every((i) => Number.isInteger(i.count)));
});

test('persona 3 - official and volunteer: appointments and crew posts are answered in place', async () => {
  const org = await signup(['organizer']), ref = await signup(['referee']), vol = await signup(['athlete']);
  must(await api('POST', '/me/sport-profiles', { token: ref.token, body: { sport: 'football', role: 'referee' } }));
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: 'League Day', sport: 'football', kind: 'tournament', starts_on: day(2), ends_on: day(2) } }));
  const [h, a] = [await team(org, 'H'), await team(org, 'A')];
  const fx = await fixture(ev.id, h.id, a.id, new Date(Date.now() + 2 * 864e5));
  const fo = (await pool.query("INSERT INTO fixture_officials(fixture_id, user_id, role, status) VALUES ($1,$2,'referee','invited') RETURNING id", [fx, ref.id])).rows[0].id;
  const st = (await pool.query("INSERT INTO event_staff(event_id, user_id, role, status) VALUES ($1,$2,'volunteer','invited') RETURNING id", [ev.id, vol.id])).rows[0].id;

  const roleKeys = (u) => api('GET', '/me/workspace', { token: u.token }).then((r) => r.body.contexts.map((c) => c.key));
  assert.ok((await roleKeys(ref)).includes('official')); assert.ok((await roleKeys(vol)).includes('volunteer'));
  const duty = (await actions(ref, 'official')).find((x) => x.id === `official:${fo}`);
  assert.equal(duty.link.screen, 'OfficialMatch'); assert.equal(duty.link.params.id, fx);
  must(await runQuick(ref, quick(duty, 'Accept')));
  assert.equal((await pool.query('SELECT status FROM fixture_officials WHERE id=$1', [fo])).rows[0].status, 'accepted');
  const post = (await actions(vol, 'volunteer')).find((x) => x.id === `crew:${st}`);
  must(await runQuick(vol, quick(post, 'Accept')));
  assert.equal((await pool.query('SELECT status FROM event_staff WHERE id=$1', [st])).rows[0].status, 'accepted');
  assert.equal((await actions(vol, 'volunteer')).length, 0);
  assert.equal((await section(vol, 'work', '?role=volunteer')).items[0].count, 1);
});

test('persona 4 - venue operator: due maintenance is closed from the queue; staff removal removes the role', async () => {
  const owner = await signup(['venue_manager']), staff = await signup(['athlete']);
  const v = (await pool.query("INSERT INTO venues(name, city, owner_id) VALUES ('Arena One','Pune',$1) RETURNING id", [owner.id])).rows[0].id;
  await pool.query("INSERT INTO venue_staff(venue_id, user_id, role) VALUES ($1,$2,'staff')", [v, staff.id]);
  const m = (await pool.query("INSERT INTO venue_maintenance(venue_id, title, category, priority, status, due_on, created_by) VALUES ($1,'Fix floodlight','electrical','high','scheduled',$2,$3) RETURNING id", [v, day(-1), owner.id])).rows[0].id;
  const it = (await actions(owner, 'venue_operator', v)).find((x) => x.id === `maintenance:${m}`);
  assert.equal(it.urgent, true); assert.equal(it.link.params.tab, 'maintenance');
  assert.ok((await actions(staff, 'venue_operator')).some((x) => x.id === `maintenance:${m}`), 'staff share the queue');
  must(await runQuick(owner, quick(it, 'Mark done')));
  assert.equal((await actions(owner, 'venue_operator', v)).length, 0);
  await pool.query('UPDATE venue_staff SET removed_at=now() WHERE venue_id=$1 AND user_id=$2', [v, staff.id]);
  assert.ok(!(await api('GET', '/me/workspace', { token: staff.token })).body.contexts.some((c) => c.key === 'venue_operator'), 'revoked at once');
  assert.equal((await api('GET', `/me/workspace/actions?role=venue_operator`, { token: staff.token })).status, 403);
});

test('persona 5 - guardian: children are scoped, consent is respected and every child read is audited', async () => {
  const g = await signup(['athlete']), other = await signup(['athlete']), kid = await signup(['athlete']), mgr = await signup(['organizer']);
  await pool.query("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [g.id, kid.id]);
  await pool.query("UPDATE users SET youth_until = current_date + 1000 WHERE id=$1", [kid.id]);
  const ev = must(await api('POST', '/events', { token: mgr.token, body: { name: 'U12 Cup', sport: 'football', kind: 'tournament', starts_on: day(1), ends_on: day(1) } }));
  const [h, a] = [await team(mgr, 'H'), await team(mgr, 'A')];
  const fx = await fixture(ev.id, h.id, a.id, new Date(Date.now() + 864e5));
  await pool.query("INSERT INTO team_squads(team_id, event_id, fixture_id, user_id, role, status, selected_by) VALUES ($1,$2,$3,$4,'player','selected',$5)", [h.id, ev.id, fx, kid.id, mgr.id]);
  const ctx = must(await api('GET', '/me/workspace', { token: g.token })).contexts.find((c) => c.key === 'guardian');
  assert.deepEqual(ctx.scopes.map((s) => s.id), [kid.id]);
  assert.ok((await actions(g, 'guardian')).some((x) => x.kind === 'consent'), 'no participation consent yet');
  assert.equal((await section(g, 'calendar', '?role=guardian&from=' + day(0) + '&to=' + day(3))).items.length, 0, 'no consent, no schedule');
  must(await api('POST', `/youth/children/${kid.id}/consents`, { token: g.token, body: { purpose: 'participation' } }));
  const cal = await section(g, 'calendar', `?role=guardian&from=${day(0)}&to=${day(3)}`);
  assert.equal(cal.items.length, 1); assert.match(cal.items[0].title, /v /);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='read_child_schedule' AND entity_id=$2", [g.id, kid.id])).rowCount >= 1);
  assert.ok(!(await actions(g, 'guardian')).some((x) => x.kind === 'consent'));
  assert.equal((await api('GET', `/me/workspace/today?role=guardian&scope_id=${kid.id}`, { token: other.token })).status, 403, 'another person cannot borrow the role');
});

test('permissions: roles and scopes are never trusted from the client', async () => {
  const mgr = await signup(['organizer']), rival = await signup(['organizer']), plain = await signup(['athlete']);
  const t = await team(mgr, 'Mine'), e = must(await api('POST', '/events', { token: mgr.token, body: { name: 'Mine Cup', sport: 'football', kind: 'tournament', starts_on: day(5), ends_on: day(5) } }));
  assert.equal((await api('GET', '/me/workspace')).status, 401);
  assert.equal((await api('GET', '/me/workspace/today', { token: plain.token, body: undefined })).status, 200);
  assert.equal((await api('GET', '/me/workspace/actions?role=sponsor', { token: plain.token })).status, 403);
  assert.equal((await api('GET', `/me/workspace/actions?role=event_manager&scope_id=${e.id}`, { token: rival.token })).status, 404, 'a foreign scope does not exist for you');
  assert.equal((await api('GET', '/me/workspace/bogus', { token: plain.token })).status, 400);
  assert.equal((await api('PATCH', '/me/workspace/prefs', { token: plain.token, body: { active_role: 'coach' } })).status, 403);
  assert.equal((await api('POST', '/me/workspace/pins', { token: rival.token, body: { type: 'team', id: t.id } })).status, 404);
  assert.equal((await api('POST', '/me/workspace/pins', { token: rival.token, body: { type: 'event', id: e.id } })).status, 404);
  const admin = (await api('GET', '/me/workspace', { token: plain.token })).body.contexts.map((c) => c.key);
  assert.ok(!admin.includes('admin') && !admin.includes('platform_admin'));
  assert.equal((await api('PATCH', '/me/workspace/prefs', { token: rival.token, body: { default_org_id: '00000000-0000-4000-8000-000000000000' } })).status, 404);
});

test('preferences: active role, default organisation, pins and saved filters persist, and pins stay behind live access', async () => {
  const u = await signup(['organizer', 'coach']);
  const t = await team(u, 'Pinned'), e = must(await api('POST', '/events', { token: u.token, body: { name: 'Pinned Cup', sport: 'football', kind: 'tournament', starts_on: day(4), ends_on: day(4) } }));
  const org = must(await api('POST', '/organisations', { token: u.token, body: { name: 'Pune FC', kind: 'club' } }));
  const ctx = must(await api('GET', '/me/workspace', { token: u.token }));
  assert.ok(ctx.contexts.some((c) => c.key === 'org_admin') && ctx.contexts.some((c) => c.key === 'team_manager'));
  must(await api('PATCH', '/me/workspace/prefs', { token: u.token, body: { active_role: 'team_manager', active_scope_id: t.id, default_org_id: org.id } }));
  must(await api('POST', '/me/workspace/pins', { token: u.token, body: { type: 'team', id: t.id } }));
  must(await api('POST', '/me/workspace/pins', { token: u.token, body: { type: 'event', id: e.id } }));
  must(await api('POST', '/me/workspace/pins', { token: u.token, body: { type: 'event', id: e.id } })); // idempotent
  const f = must(await api('POST', '/me/workspace/filters', { token: u.token, body: { name: 'Matches only', role: 'team_manager', section: 'calendar', kinds: ['match'] } }));
  const p = must(await api('GET', '/me/workspace', { token: u.token })).prefs;
  assert.equal(p.active_role, 'team_manager'); assert.equal(p.active_scope_id, t.id); assert.equal(p.default_org.id, org.id);
  assert.deepEqual(p.pins.map((x) => x.type), ['team', 'event']); assert.equal(p.pins[0].link.screen, 'Team');
  assert.equal(p.saved_filters[0].id, f.id);
  assert.equal((await api('GET', '/me/workspace/today', { token: u.token })).body.role, 'team_manager', 'the active role is the default');
  must(await api('DELETE', `/me/workspace/pins/event/${e.id}`, { token: u.token }));
  must(await api('DELETE', `/me/workspace/filters/${f.id}`, { token: u.token }));
  assert.equal((await api('DELETE', `/me/workspace/filters/${f.id}`, { token: u.token })).status, 404);
  assert.deepEqual(must(await api('GET', '/me/workspace', { token: u.token })).prefs.pins.map((x) => x.type), ['team']);
  await pool.query("UPDATE team_members SET status='left' WHERE team_id=$1", [t.id]);
  await pool.query('UPDATE teams SET owner_id=$2 WHERE id=$1', [t.id, (await signup(['athlete'])).id]);
  assert.deepEqual(must(await api('GET', '/me/workspace', { token: u.token })).prefs.pins.map((x) => x.type), [], 'a pin never outlives access');
  assert.ok((await pool.query('SELECT 1 FROM teams WHERE id=$1', [t.id])).rowCount === 1, 'the team itself is untouched');
});

test('inbox: every notification opens the exact record; the calendar and today reuse the unified schedule', async () => {
  const u = await signup(['athlete']);
  const ev = must(await api('POST', '/events', { token: u.token, body: { name: 'My Day', sport: 'football', kind: 'friendly', starts_on: day(0), ends_on: day(0) } }));
  await pool.query("INSERT INTO notifications(user_id, kind, title, body, data) VALUES ($1,'event_staff','Crew update','x',$2), ($1,'misc','Hello','y','{}')", [u.id, JSON.stringify({ event_id: ev.id, staff_id: ev.id })]);
  const inbox = await section(u, 'inbox', '?role=athlete');
  assert.equal(inbox.unread, 2);
  assert.deepEqual(inbox.items.find((x) => x.title === 'Crew update').link, { screen: 'EventCommand', params: { id: ev.id } });
  assert.equal(inbox.items.find((x) => x.title === 'Hello').link, null);
  assert.equal((await section(u, 'inbox', '?role=athlete&unread=true')).items.length, 2);
  const today = await section(u, 'today');
  assert.equal(today.unread, 2); assert.ok(today.schedule.some((x) => x.source_id === ev.id));
  assert.equal((await api('GET', '/me/workspace/calendar?from=2026-02-01&to=2026-01-01', { token: u.token })).status, 400);
});

test('every role and section answers for a person who holds all of them (no SQL error on empty data)', async () => {
  const u = await signup(['athlete', 'coach', 'organizer', 'referee', 'doctor', 'physio', 'sponsor', 'supplier', 'venue_manager', 'recruiter']);
  const ctx = must(await api('GET', '/me/workspace', { token: u.token })).contexts;
  const keys = ctx.map((c) => c.key);
  for (const k of ['athlete', 'coach', 'event_manager', 'official', 'doctor', 'physio', 'sponsor', 'supplier', 'venue_operator', 'agent']) assert.ok(keys.includes(k), `holds ${k}`);
  for (const k of keys) for (const s of SECTIONS) must(await api('GET', `/me/workspace/${s}?role=${k}`, { token: u.token }));
});

test('the catalogue is complete: fifteen personas, six sections, queues and calendars for each, and valid links', () => {
  assert.equal(PERSONAS.length, 15);
  for (const k of PERSONA_KEYS) { assert.ok(WORK[k]?.length, `${k} has a work queue`); assert.ok(CALENDAR_KINDS[k]?.length, `${k} has calendar kinds`); }
  assert.deepEqual(SECTIONS, ['today', 'actions', 'calendar', 'inbox', 'work', 'insights']);
  assert.deepEqual(linkFor('x', { reservation_id: 'r1' }), { screen: 'Reservation', params: { id: 'r1' } });
  assert.deepEqual(linkFor('official_assigned', { fixture_id: 'f1' }), { screen: 'OfficialMatch', params: { id: 'f1' } });
  assert.equal(linkFor('coach_review', {}).screen, 'CoachDesk');
  assert.equal(linkFor('nothing', {}), null);
  // every screen the server can link to exists in the app, so no deep link can land nowhere
  const app = readFileSync(new URL('../../app/src/App.js', import.meta.url), 'utf8');
  const pages = new Set([...app.matchAll(/\b([A-Z][A-Za-z0-9]+)(?::|,| \})/g)].map((m) => m[1]));
  const src = readFileSync(new URL('../src/workspace.js', import.meta.url), 'utf8');
  for (const m of src.matchAll(/screen: '([A-Za-z]+)'/g)) assert.ok(pages.has(m[1]) || ['Schedule', 'Player'].includes(m[1]), `screen ${m[1]} exists in the app`);
  for (const p of PERSONAS) assert.ok(p.home.tab || pages.has(p.home.screen), `${p.key} home exists`);
});
