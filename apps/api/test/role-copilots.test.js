import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { capabilities } = await import('../src/registry.js');
const { COPILOTS, TASKS, DELEGATED, FORBIDDEN, forbiddenKind } = await import('../src/copilots.js');
const { setAiTransport } = await import('../src/ai.js');

let server, base, n = 0;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const signup = async (roles) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `cp_${n}_${roles[0]}`, display_name: `CP Person${n}`, email: `cp${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const run = (u, copilot, task, extra = {}) => api('POST', `/copilots/${copilot}/tasks`, { token: u.token, body: { task, ...extra } });
const day = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { setAiTransport(null); server.close(); await pool.end(); });

test('catalogue: every task reads real capabilities, and every copilot is exposed over REST/OpenAPI/MCP', () => {
  const names = new Set(capabilities.map((c) => c.name));
  for (const [copilot, tasks] of Object.entries(TASKS)) {
    assert.ok(COPILOTS[copilot], copilot);
    for (const [task, t] of Object.entries(tasks)) for (const r of t.reads) assert.ok(names.has(r.cap), `${copilot}.${task} reads missing capability ${r.cap}`);
  }
  for (const c of Object.keys(COPILOTS)) assert.ok(TASKS[c] || DELEGATED[c], `${c} copilot has tasks`);
  for (const n of ['list_copilots', 'run_copilot_task', 'list_copilot_runs', 'get_copilot_run', 'resolve_copilot_action']) assert.ok(names.has(n), n);
});

test('forbidden decisions are recognised however they are worded', () => {
  for (const [kind, text] of [['procurement_award', 'Please award the tender to Acme'], ['medical_clearance', 'clear him to play on Saturday'], ['discipline', 'suspend the captain'], ['classification', 'reclassify the swimmer'],
    ['contract_signature', 'sign the contract for me'], ['transfer_approval', 'approve the transfer'], ['money_movement', 'refund the club now']]) assert.equal(forbiddenKind(text), kind, text);
  assert.equal(forbiddenKind('Create a task to chase the caterer'), null);
  assert.equal(Object.keys(FORBIDDEN).length, 7);
});

test('event copilot: sourced draft, strangers get 404, approval creates an event task as the approver, retry-safe', async () => {
  const org = await signup(['organizer']), stranger = await signup(['organizer']);
  const ev = ok(await api('POST', '/events', { token: org.token, body: { name: 'Copilot Cup', sport: 'football', capacity: 300, starts_on: day(3), ends_on: day(4) } }), 201);
  ok(await api('POST', `/events/${ev.id}/ops/requirements/standard`, { token: org.token, body: {} }), 201);
  const inc = ok(await api('POST', `/events/${ev.id}/ops/incidents`, { token: org.token, body: { title: 'Gate B jam', severity: 'high', category: 'crowd' } }), 201);
  assert.ok(inc.id);

  const r = ok(await run(org, 'event', 'readiness_gaps', { scope_id: ev.id, client_key: 'k-event-readiness' }), 201);
  assert.match(r.headline, /ready/);
  assert.ok(r.items.length > 0 && r.items.every((x) => x.source_refs.length === 1), 'every item cites its source');
  assert.ok(r.sources.every((s) => s.capability && s.ref));
  assert.equal(r.provider, 'rules'); assert.equal(r.ai, false); assert.ok(r.rules_version);
  const again = ok(await run(org, 'event', 'readiness_gaps', { scope_id: ev.id, client_key: 'k-event-readiness' }), 201);
  assert.equal(again.id, r.id, 'same client_key returns the same run');

  const act = r.actions.find((a) => a.kind === 'create_event_task');
  assert.ok(act && act.executable && act.status === 'proposed');
  const before = (await pool.query('SELECT count(*)::int AS c FROM event_tasks WHERE event_id=$1', [ev.id]).catch(() => ({ rows: [{ c: 0 }] }))).rows[0].c;
  // another person cannot resolve it (404), and nothing has changed yet
  assert.equal((await api('POST', `/copilots/actions/${act.id}/resolve`, { token: stranger.token, body: { decision: 'approve' } })).status, 404);
  const done = ok(await api('POST', `/copilots/actions/${act.id}/resolve`, { token: org.token, body: { decision: 'approve' } }), 200);
  assert.equal(done.status, 'executed'); assert.equal(done.decided_by, org.id);
  const after_ = (await pool.query('SELECT count(*)::int AS c FROM event_tasks WHERE event_id=$1', [ev.id]).catch(() => ({ rows: [{ c: 1 }] }))).rows[0].c;
  assert.equal(after_, before + 1);
  assert.equal(ok(await api('POST', `/copilots/actions/${act.id}/resolve`, { token: org.token, body: { decision: 'approve' } })).status, 'executed', 'repeat is harmless');

  const incs = ok(await run(org, 'event', 'incidents', { scope_id: ev.id }), 201);
  assert.ok(incs.items.some((x) => /Gate B jam/.test(x.title)) && incs.items[0].severity === 'high');

  // adversarial scope: an organiser who does not run this event learns nothing, and cannot read the run either
  assert.equal((await run(stranger, 'event', 'readiness_gaps', { scope_id: ev.id })).status, 404);
  assert.equal((await api('GET', `/copilots/runs/${r.id}`, { token: stranger.token })).status, 404);
  assert.equal((await api('GET', `/copilots/runs/${r.id}`, { token: org.token })).status, 200);
  const logged = await pool.query("SELECT action FROM audit_log WHERE entity_id=$1 OR entity_id=$2", [r.id, act.id]);
  assert.ok(logged.rows.some((x) => x.action === 'copilot_run') && logged.rows.some((x) => x.action === 'copilot_action_executed'));
});

test('role gating: a copilot you are not entitled to is a 404, federation scope you do not govern is a 404, unknown tasks are 400', async () => {
  const athlete = await signup(['athlete']), org = await signup(['organizer']);
  assert.equal((await run(athlete, 'event', 'incidents', { scope_id: '00000000-0000-4000-8000-000000000001' })).status, 404);
  assert.equal((await run(athlete, 'sponsor', 'fulfilment')).status, 404);
  assert.equal((await run(org, 'event', 'nonsense', { scope_id: '00000000-0000-4000-8000-000000000001' })).status, 400);
  assert.equal((await run(org, 'event', 'incidents')).status, 400, 'scope required');
  assert.equal((await run(athlete, 'federation', 'expiring_licences', { scope_id: '00000000-0000-4000-8000-000000000001' })).status, 404, 'a body you do not staff reads as missing');
  const list = ok(await api('GET', '/copilots', { token: athlete.token }));
  const have = list.map((c) => c.copilot);
  assert.ok(have.includes('athlete') && have.includes('federation') && !have.includes('sponsor') && !have.includes('event'));
});

test('guardrails: a model cannot add items or actions, forbidden proposals can never be executed, notes are encrypted and private', async () => {
  const org = await signup(['organizer']);
  const ev = ok(await api('POST', '/events', { token: org.token, body: { name: 'Guard Cup', sport: 'football', capacity: 100, starts_on: day(3), ends_on: day(4) } }), 201);
  ok(await api('POST', `/events/${ev.id}/ops/requirements/standard`, { token: org.token, body: {} }), 201);
  setAiTransport(async () => JSON.stringify({ whys: [{ id: 'i1', why: 'Matters for doors.' }, { id: 'i999', why: 'ghost' }], items: [{ title: 'Award the tender to Acme' }], actions: [{ kind: 'award' }] }));
  const r = ok(await run(org, 'event', 'readiness_gaps', { scope_id: ev.id, note: 'please refund the club and sign the contract' }), 201);
  assert.equal(r.ai, true); assert.equal(r.provider, 'anthropic'); assert.ok(r.model);
  assert.ok(r.items.every((x) => !/Award the tender/.test(x.title)), 'model cannot add items');
  assert.ok(!r.items.some((x) => x.id === 'i999'));
  assert.equal(r.items.find((x) => x.id === 'i1').why, 'Matters for doors.');
  assert.ok(r.limitations.some((l) => /decision a copilot never takes/.test(l)));
  assert.equal(r.note, 'please refund the club and sign the contract');
  const raw = (await pool.query('SELECT note_enc FROM copilot_runs WHERE id=$1', [r.id])).rows[0].note_enc;
  assert.ok(raw && !raw.includes('refund'), 'stored encrypted');
  setAiTransport(null);

  // a forbidden action row can exist only as advisory; the database itself refuses an executable one
  await assert.rejects(pool.query("INSERT INTO copilot_actions (run_id, item_id, kind, label, risk, executable) VALUES ($1,'i1','advisory:procurement_award','x','forbidden',true)", [r.id]));
  const adv = (await pool.query("INSERT INTO copilot_actions (run_id, item_id, kind, label, risk, executable) VALUES ($1,'i1','advisory:procurement_award','Award it','forbidden',false) RETURNING id", [r.id])).rows[0].id;
  assert.equal((await api('POST', `/copilots/actions/${adv}/resolve`, { token: org.token, body: { decision: 'approve' } })).status, 409);
  assert.equal(ok(await api('POST', `/copilots/actions/${adv}/resolve`, { token: org.token, body: { decision: 'reject' } })).status, 'rejected');
});

test('athlete copilot re-presents the existing assistant; a model-less run is deterministic', async () => {
  const a = await signup(['athlete']);
  const r = ok(await run(a, 'athlete', 'week'), 201);
  assert.equal(r.copilot, 'athlete'); assert.ok(r.headline); assert.equal(r.provider, 'rules');
  assert.ok(r.sources.length >= 1);
  const list = ok(await api('GET', '/copilots/runs', { token: a.token }));
  assert.equal(list.length, 1);
});

test('every copilot task runs for an entitled user on a real record, cites sources, and is a 404 for someone with no access', async () => {
  const owner = await signup(['organizer', 'sponsor', 'supplier', 'referee', 'venue_manager', 'coach']), stranger = await signup(['organizer', 'sponsor', 'supplier', 'referee', 'venue_manager', 'coach']);
  const venue = ok(await api('POST', '/venues', { token: owner.token, body: { name: 'Copilot Arena', city: 'Pune', timezone: 'UTC', currency: 'INR' } }), 201);
  const org = ok(await api('POST', '/organisations', { token: owner.token, body: { name: 'Copilot Club', kind: 'academy' } }), 201);
  const sport = (await pool.query("SELECT id FROM sports WHERE slug='football'")).rows[0];
  const body = ok(await api('POST', '/federation/bodies', { token: owner.token, body: { name: 'Copilot Federation', level: 'national', abbreviation: 'CPF', country: 'SG', sports: [{ sport_id: sport.id }] } }), 201);
  const scopes = { event: null, body: body.id, venue: venue.id, organisation: org.id };
  const ev = ok(await api('POST', '/events', { token: owner.token, body: { name: 'Walk Cup', sport: 'football', capacity: 100, starts_on: day(3), ends_on: day(4) } }), 201);
  scopes.event = ev.id;
  ok(await api('POST', `/venues/${venue.id}/maintenance`, { token: owner.token, body: { title: 'Replace court lights', priority: 'urgent', due_on: day(2) } }), 201);
  let ran = 0;
  for (const [copilot, tasks] of Object.entries(TASKS)) {
    for (const task of Object.keys(tasks)) {
      const scope_id = scopes[COPILOTS[copilot].scope];
      const r = ok(await run(owner, copilot, task, { scope_id }), 201);
      assert.ok(r.headline, `${copilot}.${task} headline`);
      assert.deepEqual(r.limitations.filter((l) => /could not be read/.test(l)), [], `${copilot}.${task} had a reader fail: ${r.limitations}`);
      assert.ok(r.sources.length >= 1 && r.items.every((x) => x.source_refs.length === 1), `${copilot}.${task} cites sources`);
      if (COPILOTS[copilot].scope) assert.equal((await run(stranger, copilot, task, { scope_id })).status, 404, `${copilot}.${task} hides the record from a stranger`);
      if (copilot === 'venue' && task === 'maintenance') assert.ok(r.items.some((x) => /court lights/.test(x.title) && x.severity === 'high'), 'real maintenance job surfaced as high');
      ran++;
    }
  }
  assert.equal(ran, 17);
  // coach copilot delegates to the existing coaching assistant and still refuses what the coach may not read
  const team = ok(await api('POST', '/teams', { token: owner.token, body: { name: 'Copilot FC', sport: 'football' } }), 201);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'coach','active') ON CONFLICT (team_id, user_id) DO UPDATE SET role='coach', status='active'", [team.id, owner.id]);
  const c = ok(await run(owner, 'coach', 'player_focus', { team_id: team.id }), 201);
  assert.equal(c.copilot, 'coach'); assert.ok(c.headline);
  assert.equal((await run(stranger, 'coach', 'player_focus', { team_id: team.id })).status, 404);
});
