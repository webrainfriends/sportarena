import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { capabilities } = await import('../src/registry.js');
const { severityOf, PHASE_ORDER } = await import('../src/capabilities/event-control-tower.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
let n = 0;
const signup = async (roles) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `tw_${n}_${roles[0]}`, display_name: `Tower ${n}`, email: `tower${n}@example.com`, password: 'correct-horse-battery', roles } });
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

test('severity tightens near the event, and safety / medical are never low', () => {
  assert.equal(severityOf({ area: 'venue', due_on: null }, 90, '2026-01-01'), 'low');
  assert.equal(severityOf({ area: 'venue', due_on: null }, 20, '2026-01-01'), 'medium');
  assert.equal(severityOf({ area: 'venue', due_on: null }, 5, '2026-01-01'), 'high');
  assert.equal(severityOf({ area: 'medical', due_on: null }, 90, '2026-01-01'), 'high');
  assert.equal(severityOf({ area: 'medical', due_on: null }, 10, '2026-01-01'), 'critical');
  assert.equal(severityOf({ area: 'venue', due_on: '2025-12-31' }, 90, '2026-01-01'), 'critical', 'past its due date');
  for (const o of Object.values(PHASE_ORDER)) assert.equal(new Set(o).size, 16, 'each phase orders every card exactly once');
});

test('the control tower: organiser sees every card, strangers get 404, the phase orders the cards', async () => {
  const org = await signup(['organizer']), stranger = await signup(['athlete']), crew = await signup(['athlete']);
  assert.ok(capabilities.some((c) => c.name === 'get_event_control_tower'), 'exposed to REST, OpenAPI and MCP from one definition');
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: 'Tower Cup', sport: 'football', capacity: 500, starts_on: day(10), ends_on: day(11) } }), 201);

  assert.equal((await api('GET', `/events/${ev.id}/control-tower`, { token: stranger.token })).status, 404);
  assert.equal((await api('GET', `/events/${ev.id}/control-tower`)).status, 401);

  // before the event; nothing set up yet is a purposeful state, not a zero
  let t = must(await api('GET', `/events/${ev.id}/control-tower`, { token: org.token }));
  assert.equal(t.phase, 'before');
  assert.equal(t.event.days_to_go, 10);
  assert.deepEqual(t.stage.steps, ['setup', 'registration', 'event_day', 'close']);
  assert.equal(t.stage.index, 1, 'a new event is open for registration');
  await pool.query("UPDATE events SET status='draft' WHERE id=$1", [ev.id]);
  assert.equal(must(await api('GET', `/events/${ev.id}/control-tower`, { token: org.token })).stage.index, 0);
  await pool.query("UPDATE events SET status='open' WHERE id=$1", [ev.id]);
  assert.equal(t.card_order[0], 'readiness');
  assert.equal(t.cards.readiness.needs_setup, true);
  for (const k of ['participants', 'finance', 'venue', 'workforce', 'tickets', 'commercial', 'procurement', 'compliance', 'media', 'travel', 'results', 'operations']) {
    assert.notEqual(t.cards[k].available, false, `${k} is available to the organiser`);
  }
  assert.ok(t.cards.ai.can_plan);
  assert.ok(t.cards.ai.recommendations.some((r) => r.kind === 'checklist_missing'));

  // the standard checklist gives readiness real blockers, each with where to fix it
  must(await api('POST', `/events/${ev.id}/ops/requirements/standard`, { token: org.token, body: {} }), 201);
  t = must(await api('GET', `/events/${ev.id}/control-tower`, { token: org.token }));
  assert.equal(t.cards.readiness.needs_setup, false);
  assert.ok(t.cards.readiness.total >= 15);
  assert.ok(t.cards.readiness.blockers.length && t.cards.readiness.blockers.every((b) => b.fix?.tab && ['critical', 'high', 'medium', 'low'].includes(b.severity)));
  assert.ok(t.cards.attention.total >= 1);

  // participants and money come from the owning modules
  const team = must(await api('POST', '/teams', { token: org.token, body: { name: 'Tower FC', sport: 'football' } }), 201);
  await pool.query("INSERT INTO event_entries(event_id, team_id, status) VALUES ($1,$2,'pending')", [ev.id, team.id]);
  t = must(await api('GET', `/events/${ev.id}/control-tower`, { token: org.token }));
  assert.equal(t.cards.participants.entries.pending, 1);
  assert.ok(t.cards.attention.items.some((a) => a.kind === 'entries_pending' && a.fix.tab === 'teams'));
  assert.equal(t.cards.finance.currency, ev.currency);

  // during the event the live operations card leads; after it the results card does
  await pool.query("UPDATE events SET status='ongoing' WHERE id=$1", [ev.id]);
  t = must(await api('GET', `/events/${ev.id}/control-tower`, { token: org.token }));
  assert.equal(t.phase, 'during');
  assert.equal(t.card_order[0], 'operations');
  assert.equal(t.stage.index, 2);
  await pool.query("UPDATE events SET status='completed' WHERE id=$1", [ev.id]);
  t = must(await api('GET', `/events/${ev.id}/control-tower`, { token: org.token }));
  assert.equal(t.phase, 'after');
  assert.equal(t.card_order[0], 'results');

  // a department lead sees operations, but not the money
  await pool.query("UPDATE events SET status='open' WHERE id=$1", [ev.id]);
  const dept = must(await api('POST', `/events/${ev.id}/departments`, { token: org.token, body: { name: 'Gates', kind: 'operations', lead_user_id: crew.id } }), 201);
  assert.ok(dept.id);
  const c = must(await api('GET', `/events/${ev.id}/control-tower`, { token: crew.token }));
  assert.equal(c.cards.finance.available, false);
  assert.equal(c.cards.tickets.available, false);
  assert.notEqual(c.cards.operations.available, false);
  assert.equal(c.access.organiser, false);
});

test('the organiser workspace carries the strip of events and which need attention', async () => {
  const org = await signup(['organizer']);
  must(await api('POST', '/events', { token: org.token, body: { name: 'Soon Cup', sport: 'football', starts_on: day(3), ends_on: day(4) } }), 201);
  must(await api('POST', '/events', { token: org.token, body: { name: 'Later Cup', sport: 'football', starts_on: day(60), ends_on: day(61) } }), 201);
  const w = must(await api('GET', '/me/role-workspace?role=organizer', { token: org.token }));
  assert.equal(w.tower.total, 2);
  assert.equal(w.tower.events.length, 2);
  assert.equal(w.tower.attention + w.tower.on_track + w.tower.events.filter((e) => e.bucket === 'soon').length, 2, 'each event is in exactly one bucket');
  assert.ok(w.tower.events.every((e) => e.phase === 'before'));
  const ath = await signup(['athlete']);
  assert.equal(must(await api('GET', '/me/role-workspace?role=athlete', { token: ath.token })).tower, null, 'only the event role gets the tower');
});
