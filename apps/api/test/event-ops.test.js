import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

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
  const r = await api('POST', '/auth/register', { body: { handle: `ops_${n}_${roles[0]}`, display_name: `Ops ${n}`, email: `ops${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const day = (o) => new Date(Date.now() + o * 864e5).toISOString().slice(0, 10);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const item = (r, key) => r.items.find((x) => x.derive_key === key);

test('end-to-end: prepare, run and close an event from the operations centre', async () => {
  const org = await signup(['organizer']), vol = await signup(['athlete']), medic = await signup(['physio']), stranger = await signup(['athlete']), vm = await signup(['venue_manager']);
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: 'Ops Cup', sport: 'football', capacity: 500, starts_on: day(1), ends_on: day(2) } }), 201);
  const base_ = `/events/${ev.id}/ops`;

  // strangers learn nothing; the catalogue of standard requirements is public
  assert.equal((await api('GET', `${base_}/readiness`, { token: stranger.token })).status, 404);
  assert.ok(must(await api('GET', '/event-ops/requirements/standard')).requirements.length >= 15);

  // readiness: explicit requirements, derived live from the owning domains; repeating adds nothing
  const added = must(await api('POST', `${base_}/requirements/standard`, { token: org.token, body: {} }), 201);
  assert.ok(added.added >= 15);
  assert.equal(must(await api('POST', `${base_}/requirements/standard`, { token: org.token, body: {} }), 201).added, 0);
  let r = must(await api('GET', `${base_}/readiness`, { token: org.token }));
  const p0 = r.percent;
  assert.equal(item(r, 'capacity_set').state, 'met', 'capacity was set on the event: not asked again');
  assert.equal(item(r, 'venue_set').state, 'open');
  assert.equal(item(r, 'tasks_clear').state, 'met');
  assert.equal((await api('PATCH', `${base_}/requirements/${item(r, 'venue_set').id}`, { token: org.token, body: { status: 'done' } })).status, 400, 'a derived requirement cannot be ticked by hand');
  assert.equal((await api('PATCH', `${base_}/requirements/${item(r, 'venue_set').id}`, { token: org.token, body: { status: 'waived' } })).status, 400, 'waiving needs a reason');

  // data entered in the owning domains moves the percentage (nothing re-entered here)
  const venue = must(await api('POST', '/venues', { token: vm.token, body: { name: 'Ops Ground', city: 'Pune', country: 'IN', timezone: 'UTC' } }), 201);
  await pool.query('UPDATE events SET venue_id=$2 WHERE id=$1', [ev.id, venue.id]);
  const dept = must(await api('POST', `/events/${ev.id}/departments`, { token: org.token, body: { name: 'First aid', kind: 'medical', lead_user_id: medic.id } }), 201);
  const inv = must(await api('POST', `/departments/${dept.id}/members`, { token: org.token, body: { user_id: vol.id } }), 201);
  must(await api('POST', `/department-members/${inv.id}/respond`, { token: vol.token, body: { accept: true } }));
  r = must(await api('GET', `${base_}/readiness`, { token: org.token }));
  assert.equal(item(r, 'venue_set').state, 'met');
  assert.equal(item(r, 'medical_cover').state, 'met');
  assert.equal(item(r, 'crew_confirmed').state, 'met');
  assert.ok(r.percent > p0);

  // waive with a reason: leaves the percentage, stays visible
  const w = must(await api('PATCH', `${base_}/requirements/${item(r, 'bracket_built').id}`, { token: org.token, body: { status: 'waived', waived_reason: 'League format, no knockout' } }));
  assert.equal(w.derive_key, 'bracket_built');
  r = must(await api('GET', `${base_}/readiness`, { token: org.token }));
  assert.equal(item(r, 'bracket_built').state, 'waived');
  assert.equal(r.waived, 1);

  // manual requirement: owner ticks their own, nobody else can
  const man = must(await api('POST', `${base_}/requirements`, { token: org.token, body: { area: 'safety', title: 'Fire-safety certificate signed', owner_id: vol.id } }), 201);
  assert.equal((await api('PATCH', `${base_}/requirements/${man.id}`, { token: medic.token, body: { status: 'done' } })).status, 403);
  must(await api('PATCH', `${base_}/requirements/${man.id}`, { token: vol.token, body: { status: 'done' } }));
  assert.equal(must(await api('GET', `${base_}/readiness`, { token: org.token })).items.find((x) => x.id === man.id).state, 'met');

  // contacts: names for crew, phone only on request and audited; stored encrypted
  const ct = must(await api('POST', `${base_}/contacts`, { token: org.token, body: { area: 'emergency', name: 'Ambulance desk', phone: '+91 98000 00001' } }), 201);
  assert.equal(ct.phone, undefined);
  assert.equal((await api('POST', `${base_}/contacts`, { token: vol.token, body: { area: 'other', name: 'Nope' } })).status, 403, 'only managers add contacts');
  assert.match((await pool.query('SELECT phone_enc FROM event_ops_contacts WHERE id=$1', [ct.id])).rows[0].phone_enc, /^v1\./);
  const plain = must(await api('GET', `${base_}/contacts`, { token: vol.token }));
  assert.equal(plain[0].phone, undefined);
  const a0 = Number((await pool.query("SELECT count(*) FROM audit_log WHERE action='read_event_contacts'")).rows[0].count);
  assert.equal(must(await api('GET', `${base_}/contacts?include_contact=true`, { token: vol.token }))[0].phone, '+91 98000 00001');
  assert.equal(Number((await pool.query("SELECT count(*) FROM audit_log WHERE action='read_event_contacts'")).rows[0].count), a0 + 1);

  // event day: crew report incidents; high alerts the organiser; idempotent retry
  must(await api('PATCH', `/events/${ev.id}`, { token: org.token, body: { status: 'ongoing' } }));
  const inc = must(await api('POST', `${base_}/incidents`, { token: vol.token, body: { title: 'Player down near gate B', severity: 'high', category: 'medical', detail: 'Collapsed, conscious, name withheld', location: 'Gate B', client_key: 'offline-0001' } }), 201);
  assert.equal(inc.ref, 'INC-1');
  assert.equal(must(await api('POST', `${base_}/incidents`, { token: vol.token, body: { title: 'Player down near gate B', severity: 'high', category: 'medical', client_key: 'offline-0001' } }), 201).id, inc.id, 'a retry does not duplicate');
  assert.match((await pool.query('SELECT detail_enc FROM event_incidents WHERE id=$1', [inc.id])).rows[0].detail_enc, /^v1\./);
  assert.ok((await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='event_incident'", [org.id])).rowCount >= 1, 'organiser alerted');
  assert.equal((await api('POST', `${base_}/incidents`, { token: stranger.token, body: { title: 'Spam', severity: 'low', category: 'other' } })).status, 404);

  let board = must(await api('GET', `${base_}/board`, { token: vol.token }));
  assert.equal(board.incidents.open, 1);
  assert.equal(board.incidents.worst, 'high');
  assert.equal(item(must(await api('GET', `${base_}/readiness`, { token: org.token })), 'incidents_clear').state, 'open', 'an unresolved high incident holds readiness');

  // workflow: crew cannot manage; leads/organiser do; escalate needs a reason; history is kept and the read is audited
  assert.equal((await api('POST', `${base_}/incidents/${inc.id}/action`, { token: vol.token, body: { action: 'escalate', note: 'x' } })).status, 403);
  must(await api('POST', `${base_}/incidents/${inc.id}/action`, { token: medic.token, body: { action: 'acknowledge' } }));
  must(await api('POST', `${base_}/incidents/${inc.id}/action`, { token: medic.token, body: { action: 'assign', assignee_id: vol.id } }));
  assert.equal((await api('POST', `${base_}/incidents/${inc.id}/action`, { token: org.token, body: { action: 'escalate' } })).status, 400);
  const esc = must(await api('POST', `${base_}/incidents/${inc.id}/action`, { token: org.token, body: { action: 'escalate', note: 'Needs ambulance' } }));
  assert.equal(esc.escalation_level, 1);
  assert.equal(esc.status, 'escalated');
  assert.equal((await api('POST', `${base_}/incidents/${inc.id}/action`, { token: org.token, body: { action: 'close' } })).status, 409, 'resolve first');
  must(await api('POST', `${base_}/incidents/${inc.id}/action`, { token: vol.token, body: { action: 'resolve', note: 'Taken to hospital by ambulance' } }));
  const aud = Number((await pool.query("SELECT count(*) FROM audit_log WHERE action='read_event_incident'")).rows[0].count);
  const one = must(await api('GET', `${base_}/incidents/${inc.id}`, { token: org.token }));
  assert.equal(one.detail, 'Collapsed, conscious, name withheld');
  assert.equal(one.resolution, 'Taken to hospital by ambulance');
  assert.deepEqual(one.history.map((h) => h.action), ['reported', 'acknowledged', 'assigned', 'escalated', 'resolved']);
  assert.equal(Number((await pool.query("SELECT count(*) FROM audit_log WHERE action='read_event_incident'")).rows[0].count), aud + 1);
  assert.equal((await api('GET', `${base_}/incidents/${inc.id}`, { token: medic.token })).status, 200, 'a department lead may read');
  await assert.rejects(pool.query('DELETE FROM event_incident_log WHERE incident_id=$1', [inc.id]), /append-only/);
  must(await api('POST', `${base_}/incidents/${inc.id}/action`, { token: org.token, body: { action: 'close' } }));
  assert.equal(must(await api('GET', `${base_}/board`, { token: org.token })).incidents.open, 0);

  // closing needs: event ended, no active incidents, a debrief summary
  const open2 = must(await api('POST', `${base_}/incidents`, { token: vol.token, body: { title: 'Scoreboard flicker', severity: 'low', category: 'technical' } }), 201);
  let c = await api('POST', `${base_}/close`, { token: org.token });
  assert.equal(c.status, 409);
  assert.ok(c.body.error.details.blockers.length >= 2);
  must(await api('POST', `${base_}/incidents/${open2.id}/action`, { token: org.token, body: { action: 'resolve', note: 'Cable reseated' } }));
  must(await api('POST', `/events/${ev.id}/end`, { token: org.token, body: {} }));
  assert.equal((await api('POST', `${base_}/close`, { token: org.token })).status, 409, 'still needs the debrief');

  // debrief: lessons, follow-up tasks live in the event task list
  must(await api('POST', `${base_}/debrief`, { token: org.token, body: { summary: 'Smooth day; gate B queue was the only pain point.' } }));
  const lesson = must(await api('POST', `${base_}/debrief/items`, { token: org.token, body: { kind: 'improve', area: 'safety', body: 'Add a second scanner at gate B', follow_up: { owner_id: vol.id, due_on: day(30) } } }), 201);
  assert.ok(lesson.task_id);
  assert.equal((await pool.query('SELECT category FROM event_tasks WHERE id=$1', [lesson.task_id])).rows[0].category, 'safety');
  must(await api('POST', `${base_}/debrief/items`, { token: org.token, body: { kind: 'went_well', body: 'Medical response under two minutes' } }), 201);

  // report: facts, no personal text; export is CSV, audited, formula-safe
  const rep = must(await api('GET', `${base_}/report`, { token: org.token }));
  assert.equal(rep.incidents.length, 2);
  assert.ok(!JSON.stringify(rep).includes('Collapsed') && !JSON.stringify(rep).includes('98000'), 'no descriptions or phone numbers in the report');
  assert.equal(rep.debrief.items.length, 2);
  const csv = must(await api('GET', `${base_}/report/export`, { token: org.token }));
  assert.match(csv.csv, /^section,area_or_ref,item,state,detail/);
  assert.ok(csv.csv.includes('INC-1') && csv.csv.includes('Add a second scanner'));
  assert.equal((await api('GET', `${base_}/report`, { token: medic.token })).status, 403, 'organiser only');

  // close: finalizes the debrief and locks new incidents; reopen restores
  must(await api('POST', `${base_}/close`, { token: org.token }));
  assert.equal(must(await api('GET', `${base_}/debrief`, { token: org.token })).status, 'final');
  assert.equal((await api('POST', `${base_}/incidents`, { token: vol.token, body: { title: 'Late report', severity: 'low', category: 'other' } })).status, 409);
  must(await api('POST', `${base_}/reopen`, { token: org.token }));
  assert.equal(must(await api('GET', `${base_}/debrief`, { token: org.token })).status, 'draft');
  assert.equal((await api('POST', `${base_}/incidents`, { token: vol.token, body: { title: 'Late report', severity: 'low', category: 'other' } })).status, 201);
});

test('operations are on the capability surface: REST, OpenAPI and MCP share one definition', async () => {
  const { capabilities } = await import('../src/capabilities/index.js');
  const { buildOpenApi } = await import('../src/openapi.js');
  const names = capabilities.filter((c) => c.tag === 'Event operations').map((c) => c.name);
  for (const k of ['get_event_readiness', 'get_event_status_board', 'report_event_incident', 'update_event_incident', 'add_event_contact', 'save_event_debrief', 'close_event_operations', 'export_event_ops_report']) assert.ok(names.includes(k), k);
  const ids = new Set(Object.values(buildOpenApi().paths).flatMap((p) => Object.values(p)).map((o) => o.operationId));
  for (const k of names) assert.ok(ids.has(k), `${k} in OpenAPI`);
});
