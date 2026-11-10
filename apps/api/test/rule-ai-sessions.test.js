// Tests for versioned rule AI sessions (#1021)
// Covers: start_rule_session, ask_rule_session, get_rule_session, list_rule_sessions,
//         escalate_rule_turn, list_rule_escalations, resolve_rule_escalation, get_offline_rule_pack
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
let n = 0;
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `rai_${n}_${roles[0]}`, display_name: `RAI ${n}`, email: `rai${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const day = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

async function setupFixture() {
  const owner = await signup(['venue_manager']);
  const official = await signup(['referee']);
  const stranger = await signup();
  const sport = (await pool.query("SELECT id,slug FROM sports WHERE slug='football' OR slug IS NOT NULL LIMIT 1")).rows[0];
  const team1 = (await pool.query('INSERT INTO teams(name,sport_id,owner_id) VALUES ($1,$2,$3) RETURNING id', [`T1 ${n}`, sport.id, owner.id])).rows[0];
  const team2 = (await pool.query('INSERT INTO teams(name,sport_id,owner_id) VALUES ($1,$2,$3) RETURNING id', [`T2 ${n}`, sport.id, owner.id])).rows[0];
  const event = ok(await api('POST', '/events', { token: owner.token, body: { name: `RA Event ${n}`, sport_id: sport.id, format: 'league', start_date: day(1), end_date: day(60), status: 'active' } }), 201);
  // Add owner as organiser
  await pool.query("INSERT INTO event_roles(event_id,user_id,role) VALUES ($1,$2,'organiser') ON CONFLICT DO NOTHING", [event.id, owner.id]);
  const fixture = ok(await api('POST', `/events/${event.id}/fixtures`, { token: owner.token, body: { home_team_id: team1.id, away_team_id: team2.id, scheduled_at: `${day(2)}T10:00:00Z`, status: 'scheduled' } }), 201);
  // Assign official to fixture
  await pool.query("INSERT INTO fixture_officials(fixture_id,user_id,role,status) VALUES ($1,$2,'referee','accepted') ON CONFLICT DO NOTHING", [fixture.id, official.id]);
  return { owner, official, stranger, sport, event, fixture };
}

test('start_rule_session — eligible official creates session', async () => {
  const { official, fixture } = await setupFixture();
  const r = ok(await api('POST', `/fixtures/${fixture.id}/rule-sessions`, { token: official.token, body: {} }), 201);
  assert.ok(r.session_id, 'session_id present');
  assert.ok(r.pack_hash, 'pack_hash present');
  assert.ok(r.sport, 'sport slug present');
});

test('start_rule_session — non-assigned user is rejected', async () => {
  const { stranger, fixture } = await setupFixture();
  const r = await api('POST', `/fixtures/${fixture.id}/rule-sessions`, { token: stranger.token, body: {} });
  assert.equal(r.status, 404, 'stranger gets 404');
});

test('start_rule_session — reopening closes previous open session', async () => {
  const { official, fixture } = await setupFixture();
  const s1 = ok(await api('POST', `/fixtures/${fixture.id}/rule-sessions`, { token: official.token, body: {} }), 201);
  const s2 = ok(await api('POST', `/fixtures/${fixture.id}/rule-sessions`, { token: official.token, body: {} }), 201);
  assert.notEqual(s1.session_id, s2.session_id, 'new session created');
  // s1 should now be closed
  const r1 = ok(await api('GET', `/rule-sessions/${s1.session_id}`, { token: official.token }));
  assert.equal(r1.status, 'closed', 'previous session closed');
});

test('ask_rule_session — returns answer or clarification with citations', async () => {
  const { official, fixture, sport } = await setupFixture();
  const sess = ok(await api('POST', `/fixtures/${fixture.id}/rule-sessions`, { token: official.token, body: {} }), 201);
  const r = ok(await api('POST', `/rule-sessions/${sess.session_id}/ask`, { token: official.token, body: { question: 'How does a free kick restart play?' } }));
  assert.ok(['answer', 'clarification', 'insufficient'].includes(r.type), `type is valid: ${r.type}`);
  assert.ok(r.turn_id, 'turn_id present');
  assert.ok(typeof r.turn_no === 'number', 'turn_no is number');
  assert.ok(typeof r.text === 'string', 'text is string');
});

test('ask_rule_session — on-field call is declined', async () => {
  const { official, fixture } = await setupFixture();
  const sess = ok(await api('POST', `/fixtures/${fixture.id}/rule-sessions`, { token: official.token, body: {} }), 201);
  const r = ok(await api('POST', `/rule-sessions/${sess.session_id}/ask`, { token: official.token, body: { question: 'Should I give a penalty?' } }));
  assert.equal(r.type, 'declined', 'on-field call is declined');
});

test('ask_rule_session — foreign user cannot ask into someone else\'s session', async () => {
  const { official, stranger, fixture } = await setupFixture();
  const sess = ok(await api('POST', `/fixtures/${fixture.id}/rule-sessions`, { token: official.token, body: {} }), 201);
  const r = await api('POST', `/rule-sessions/${sess.session_id}/ask`, { token: stranger.token, body: { question: 'What is offside?' } });
  assert.equal(r.status, 404, 'stranger cannot access session');
});

test('get_rule_session — returns turns and escalations', async () => {
  const { official, fixture } = await setupFixture();
  const sess = ok(await api('POST', `/fixtures/${fixture.id}/rule-sessions`, { token: official.token, body: {} }), 201);
  ok(await api('POST', `/rule-sessions/${sess.session_id}/ask`, { token: official.token, body: { question: 'What is a yellow card for?' } }));
  const r = ok(await api('GET', `/rule-sessions/${sess.session_id}`, { token: official.token }));
  assert.ok(Array.isArray(r.turns), 'turns is array');
  assert.ok(r.turns.length >= 1, 'at least one turn');
  assert.ok(Array.isArray(r.escalations), 'escalations is array');
});

test('list_rule_sessions — official sees own sessions, organiser sees all', async () => {
  const { owner, official, stranger, fixture } = await setupFixture();
  ok(await api('POST', `/fixtures/${fixture.id}/rule-sessions`, { token: official.token, body: {} }), 201);
  const mine = ok(await api('GET', `/fixtures/${fixture.id}/rule-sessions`, { token: official.token }));
  assert.ok(mine.sessions.length >= 1, 'official sees own sessions');
  const org = ok(await api('GET', `/fixtures/${fixture.id}/rule-sessions`, { token: owner.token }));
  assert.ok(org.sessions.length >= 1, 'organiser sees all sessions');
  const none = await api('GET', `/fixtures/${fixture.id}/rule-sessions`, { token: stranger.token });
  assert.equal(none.status, 404, 'stranger gets 404');
});

test('escalate_rule_turn — official can escalate a turn', async () => {
  const { official, fixture } = await setupFixture();
  const sess = ok(await api('POST', `/fixtures/${fixture.id}/rule-sessions`, { token: official.token, body: {} }), 201);
  const turn = ok(await api('POST', `/rule-sessions/${sess.session_id}/ask`, { token: official.token, body: { question: 'What is the goalkeeper\'s area?' } }));
  const esc = ok(await api('POST', `/rule-sessions/${sess.session_id}/turns/${turn.turn_id}/escalate`, { token: official.token, body: { reason: 'The answer seems ambiguous for youth matches — need human clarification.' } }), 201);
  assert.ok(esc.escalation_id, 'escalation_id present');
});

test('escalate_rule_turn — double escalation rejected', async () => {
  const { official, fixture } = await setupFixture();
  const sess = ok(await api('POST', `/fixtures/${fixture.id}/rule-sessions`, { token: official.token, body: {} }), 201);
  const turn = ok(await api('POST', `/rule-sessions/${sess.session_id}/ask`, { token: official.token, body: { question: 'Can a goalkeeper handle a back pass?' } }));
  ok(await api('POST', `/rule-sessions/${sess.session_id}/turns/${turn.turn_id}/escalate`, { token: official.token, body: { reason: 'Needs human review for local rule override.' } }), 201);
  const r2 = await api('POST', `/rule-sessions/${sess.session_id}/turns/${turn.turn_id}/escalate`, { token: official.token, body: { reason: 'Trying again.' } });
  assert.equal(r2.status, 400, 'double escalation rejected');
});

test('resolve_rule_escalation — organiser can resolve', async () => {
  const { owner, official, fixture } = await setupFixture();
  const sess = ok(await api('POST', `/fixtures/${fixture.id}/rule-sessions`, { token: official.token, body: {} }), 201);
  const turn = ok(await api('POST', `/rule-sessions/${sess.session_id}/ask`, { token: official.token, body: { question: 'What is a penalty shootout?' } }));
  const esc = ok(await api('POST', `/rule-sessions/${sess.session_id}/turns/${turn.turn_id}/escalate`, { token: official.token, body: { reason: 'Unclear in this competition context.' } }), 201);
  const res = ok(await api('POST', `/rule-escalations/${esc.escalation_id}/resolve`, { token: owner.token, body: { resolution_note: 'The standard IFAB rules apply; no local override for this competition.', outcome: 'confirmed' } }));
  assert.ok(res.resolved_at, 'resolved_at present');
  assert.equal(res.outcome, 'confirmed', 'outcome matches');
});

test('resolve_rule_escalation — non-organiser cannot resolve', async () => {
  const { official, stranger, fixture } = await setupFixture();
  const sess = ok(await api('POST', `/fixtures/${fixture.id}/rule-sessions`, { token: official.token, body: {} }), 201);
  const turn = ok(await api('POST', `/rule-sessions/${sess.session_id}/ask`, { token: official.token, body: { question: 'Is a free kick direct or indirect after handball?' } }));
  const esc = ok(await api('POST', `/rule-sessions/${sess.session_id}/turns/${turn.turn_id}/escalate`, { token: official.token, body: { reason: 'Ambiguous phrasing.' } }), 201);
  const r = await api('POST', `/rule-escalations/${esc.escalation_id}/resolve`, { token: stranger.token, body: { resolution_note: 'Fake resolution.', outcome: 'confirmed' } });
  assert.equal(r.status, 404, 'stranger cannot resolve');
});

test('get_offline_rule_pack — assigned official gets pack snapshot', async () => {
  const { official, fixture } = await setupFixture();
  const r = ok(await api('GET', `/fixtures/${fixture.id}/offline-rules`, { token: official.token }));
  assert.ok(r.pack_hash, 'pack_hash present');
  assert.ok(r.expires_at, 'expires_at present');
  assert.ok(r.content, 'content present');
  assert.ok(r.snap_id, 'snap_id present');
});

test('get_offline_rule_pack — non-assigned user is rejected', async () => {
  const { stranger, fixture } = await setupFixture();
  const r = await api('GET', `/fixtures/${fixture.id}/offline-rules`, { token: stranger.token });
  assert.equal(r.status, 404, 'stranger rejected');
});

test('append-only: UPDATE on rule_ai_turns row is silently swallowed', async () => {
  const { official, fixture } = await setupFixture();
  const sess = ok(await api('POST', `/fixtures/${fixture.id}/rule-sessions`, { token: official.token, body: {} }), 201);
  ok(await api('POST', `/rule-sessions/${sess.session_id}/ask`, { token: official.token, body: { question: 'What is a corner kick?' } }));
  const rows = (await pool.query('SELECT id,question FROM rule_ai_turns WHERE session_id=$1', [sess.session_id])).rows;
  assert.ok(rows.length > 0, 'turns created');
  const id = rows[0].id;
  // The append-only rule silently ignores the UPDATE
  await pool.query("UPDATE rule_ai_turns SET question='TAMPERED' WHERE id=$1", [id]);
  const after = (await pool.query('SELECT question FROM rule_ai_turns WHERE id=$1', [id])).rows[0];
  assert.equal(after.question, rows[0].question, 'question unchanged (append-only rule worked)');
});

test('append-only: DELETE on rule_ai_turns row is silently swallowed', async () => {
  const { official, fixture } = await setupFixture();
  const sess = ok(await api('POST', `/fixtures/${fixture.id}/rule-sessions`, { token: official.token, body: {} }), 201);
  ok(await api('POST', `/rule-sessions/${sess.session_id}/ask`, { token: official.token, body: { question: 'When is play restarted with a drop ball?' } }));
  const rows = (await pool.query('SELECT id FROM rule_ai_turns WHERE session_id=$1', [sess.session_id])).rows;
  assert.ok(rows.length > 0, 'turns created');
  await pool.query('DELETE FROM rule_ai_turns WHERE session_id=$1', [sess.session_id]);
  const after = (await pool.query('SELECT id FROM rule_ai_turns WHERE session_id=$1', [sess.session_id])).rows;
  assert.equal(after.length, rows.length, 'rows not deleted (append-only rule worked)');
});
