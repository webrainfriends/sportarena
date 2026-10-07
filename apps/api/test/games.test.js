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
  const r = await api('POST', '/auth/register', { body: { handle: `g_${n}_${roles[0]}`, display_name: `Gamer ${n}`, email: `g${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const inFuture = (days) => new Date(Date.now() + days * 864e5).toISOString();

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('ontology: classes, vocabularies and per-sport game fields are served', async () => {
  const o = (await api('GET', '/ontology')).body;
  const names = o.classes.map((c) => c.name);
  for (const c of ['Event', 'Competition', 'Team', 'Athlete', 'Official', 'Associate', 'Membership', 'Participation', 'Action']) assert.ok(names.includes(c), c);
  assert.equal(o.classes.find((c) => c.name === 'Athlete').parent, 'Individual');
  assert.ok(o.roles.find((r) => r.key === 'referee' && r.class === 'Official'));
  assert.deepEqual((await api('GET', '/ontology/vocabularies/playerStatus')).body.terms.slice(0, 2), ['starter', 'bench']);
  assert.equal((await api('GET', '/ontology/vocabularies/nope')).status, 404);
  const f = (await api('GET', '/sports/football/game-fields')).body.fields;
  assert.ok(f.association.some((x) => x.key === 'goals' && x.origin === 'template'));
  assert.ok(f.game.some((x) => x.key === 'attendance' && x.origin === 'core'));
  const t = (await api('GET', '/sports/tennis/game-fields')).body.fields;
  assert.ok(t.game.some((x) => x.key === 'surface') && !t.association.some((x) => x.key === 'goals'));
});

test('any user adds a game; people are associated by role, with consent and profile checks', async () => {
  const host = await signup(['athlete']);               // any profile may add a game
  const owner2 = await signup(['athlete']);
  const coach = await signup(['coach']);
  const ref = await signup(['referee']);
  const striker = await signup(['athlete']);
  const rando = await signup(['athlete']);
  const t1 = (await api('POST', '/teams', { token: host.token, body: { name: 'Hosts FC', sport: 'football' } })).body;
  const t2 = (await api('POST', '/teams', { token: owner2.token, body: { name: 'Visitors FC', sport: 'football' } })).body;
  const bball = (await api('POST', '/teams', { token: host.token, body: { name: 'Hoops', sport: 'basketball' } })).body;

  // validation against the sport's fields
  const base_ = { sport: 'football', title: 'Hosts vs Visitors', starts_at: inFuture(2), participants: [{ team_id: t1.id, side: 'home' }, { team_id: t2.id, side: 'away' }] };
  assert.equal((await api('POST', '/games', { token: host.token, body: { ...base_, attributes: { wickets: 3 } } })).status, 400, 'cricket field on football');
  assert.equal((await api('POST', '/games', { token: host.token, body: { ...base_, attributes: { attendance: 'lots' } } })).status, 400, 'bad type');
  assert.equal((await api('POST', '/games', { token: host.token, body: { ...base_, participants: [{ team_id: bball.id }] } })).status, 400, 'team of another sport');
  assert.equal((await api('POST', '/games', { body: base_ })).status, 401);

  const g = await api('POST', '/games', { token: host.token, body: { ...base_, attributes: { attendance: 120, periods: 2, period_minutes: 45 } } });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  assert.equal(g.body.participants.length, 2);
  assert.equal(g.body.attributes.attendance, 120);
  assert.deepEqual(g.body.people.map((p) => p.role), ['organizer'], 'creator becomes organizer');
  const gid = g.body.id;

  // invitation flow: manager invites, person accepts
  assert.equal((await api('POST', '/associations', { token: host.token, body: { user_id: striker.id, role: 'coach', target_type: 'game', target_id: gid } })).status, 409, 'no coach profile');
  assert.equal((await api('POST', '/associations', { token: host.token, body: { user_id: coach.id, role: 'coach', target_type: 'game', target_id: gid } })).body.status, 'invited');
  const pending = await api('GET', `/associations?target_type=game&target_id=${gid}&status=invited`);
  assert.equal(pending.status, 403, 'pending associations are not public');
  const mine = (await api('GET', '/associations?mine=true&status=invited', { token: coach.token })).body;
  assert.equal(mine.length, 1);
  assert.equal((await api('POST', `/associations/${mine[0].association_id}/respond`, { token: host.token, body: { decision: 'accept' } })).status, 403, 'only the invitee answers');
  assert.equal((await api('POST', `/associations/${mine[0].association_id}/respond`, { token: coach.token, body: { decision: 'accept' } })).body.status, 'active');

  // join request flow: person asks, manager approves
  const req = await api('POST', '/associations', { token: ref.token, body: { role: 'referee', target_type: 'game', target_id: gid } });
  assert.equal(req.body.status, 'requested');
  assert.equal((await api('POST', `/associations/${req.body.id}/respond`, { token: rando.token, body: { decision: 'accept' } })).status, 403);
  assert.equal((await api('POST', `/associations/${req.body.id}/respond`, { token: host.token, body: { decision: 'accept' } })).body.status, 'active');
  assert.equal((await api('POST', '/associations', { token: rando.token, body: { user_id: striker.id, role: 'player', target_type: 'game', target_id: gid } })).status, 403, 'strangers cannot associate others');
  assert.equal((await api('POST', '/associations', { token: rando.token, body: { role: 'player', target_type: 'team', target_id: t1.id } })).status, 403 );
  assert.equal((await api('POST', '/associations', { token: host.token, body: { user_id: striker.id, role: 'referee', target_type: 'team', target_id: t1.id } })).status, 400, 'referee cannot join a roster');

  // team roster via the ontology API writes the real roster and shows in the person view
  const m = await api('POST', '/associations', { token: host.token, body: { user_id: striker.id, role: 'player', target_type: 'team', target_id: t1.id, uniform_no: 9 } });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  assert.equal((await api('GET', `/teams/${t1.id}`)).body.members.find((x) => x.id === striker.id).jersey_no, 9);
  const view = (await api('GET', `/associations?user_id=${striker.id}`)).body;
  assert.deepEqual(view.map((a) => [a.target_type, a.role, a.target_name]), [['team', 'player', 'Hosts FC']]);

  // lineup + per-game stats on the person's association
  const sa = await api('POST', '/associations', { token: host.token, body: { user_id: striker.id, role: 'player', target_type: 'game', target_id: gid, position: 'ST', uniform_no: 9, player_status: 'starter' } });
  assert.equal(sa.body.status, 'invited');
  await api('POST', `/associations/${sa.body.id}/respond`, { token: striker.token, body: { decision: 'accept' } });
  assert.equal((await api('PATCH', `/associations/${sa.body.id}`, { token: host.token, body: { attributes: { wickets: 1 } } })).status, 400);
  assert.equal((await api('PATCH', `/associations/${sa.body.id}`, { token: rando.token, body: { attributes: { goals: 1 } } })).status, 403);
  const upd = await api('PATCH', `/associations/${sa.body.id}`, { token: ref.token, body: { attributes: { goals: 2, assists: 1 } } });
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  assert.equal((await api('PATCH', `/associations/${sa.body.id}`, { token: ref.token, body: { position: 'GK' } })).status, 403, 'officials only record stats');

  // officials log actions and results; strangers cannot
  const act = { action_class: 'score', action_type: 'goal', minute: 23, period: 1, team_id: t1.id, user_id: striker.id };
  assert.equal((await api('POST', `/games/${gid}/actions`, { token: rando.token, body: act })).status, 403);
  assert.equal((await api('POST', `/games/${gid}/actions`, { token: ref.token, body: { ...act, team_id: bball.id } })).status, 400);
  assert.equal((await api('POST', `/games/${gid}/actions`, { token: ref.token, body: act })).status, 201);
  const parts = (await api('GET', `/games/${gid}`)).body.participants;
  const home = parts.find((p) => p.side === 'home'), away = parts.find((p) => p.side === 'away');
  assert.equal((await api('PATCH', `/games/${gid}/participants/${home.id}`, { token: ref.token, body: { score: 2, outcome: 'win', stats: { shots: 11, shots_on_target: 6 } } })).status, 200);
  assert.equal((await api('PATCH', `/games/${gid}/participants/${away.id}`, { token: ref.token, body: { score: 1, outcome: 'loss', outcome_type: 'regular' } })).status, 200);
  assert.equal((await api('PATCH', `/games/${gid}/participants/${away.id}`, { token: ref.token, body: { outcome: 'victory' } })).status, 400, 'vocabulary enforced');
  assert.equal((await api('PATCH', `/games/${gid}`, { token: ref.token, body: { status: 'post-event' } })).status, 403, 'officials cannot edit the game itself');
  assert.equal((await api('PATCH', `/games/${gid}`, { token: host.token, body: { status: 'post-event', attributes: { attendance: null } } })).body.status, 'post-event');

  const full = (await api('GET', `/games/${gid}`)).body;
  assert.equal(full.attributes.attendance, undefined, 'null clears a value');
  assert.equal(full.actions.length, 1);
  assert.deepEqual(full.people.map((p) => p.role).sort(), ['coach', 'organizer', 'player', 'referee']);
  assert.equal(full.people.find((p) => p.role === 'player').attributes.goals, 2);

  // JSON-LD uses the IPTC vocabulary and never leaks PII
  const ld = (await api('GET', `/games/${gid}/jsonld`)).body;
  const types = ld['@graph'].flatMap((x) => [x['@type']].flat());
  for (const t of ['sport:Event', 'sport:Team', 'sport:Athlete', 'sport:Official', 'sport:Associate', 'sport:CompetitorParticipation', 'sport:Action']) assert.ok(types.includes(t), t);
  assert.equal(ld['@graph'].find((x) => x['@type'] === 'sport:Event')['sport:eventStatus'], 'post-event');
  assert.ok(!JSON.stringify(ld).includes('example.com'));

  // discovery: by sport, by person (player, coach and team-mate all find it)
  assert.equal((await api('GET', `/games?sport=football&user_id=${coach.id}`)).body.length, 1);
  assert.equal((await api('GET', `/games?user_id=${rando.id}`)).body.length, 0);
  assert.equal((await api('GET', `/games?team_id=${t2.id}`)).body[0].participants.length, 2);
  assert.equal((await api('GET', '/games?mine=true', { token: host.token })).body.length, 1);

  // ending an association, deleting a game
  assert.equal((await api('DELETE', `/associations/${req.body.id}`, { token: rando.token })).status, 403);
  assert.equal((await api('DELETE', `/associations/${req.body.id}`, { token: ref.token })).body.status, 'ended');
  assert.equal((await api('DELETE', `/games/${gid}`, { token: coach.token })).status, 403);
  assert.equal((await api('DELETE', `/games/${gid}`, { token: host.token })).status, 200);
  assert.equal((await api('GET', `/games/${gid}`)).status, 404);
});

test('competition games need the organizer; custom fields extend a sport and are enforced', async () => {
  const org = await signup(['organizer']);
  const player = await signup(['athlete']);
  const ev = (await api('POST', '/events', { token: org.token, body: { name: 'City Cup', sport: 'badminton' } })).body;
  const mk = (token, extra = {}) => api('POST', '/games', { token, body: { sport: 'badminton', title: 'Semi 1', starts_at: inFuture(3), competition_id: ev.id, ...extra } });
  assert.equal((await mk(player.token)).status, 403);
  assert.equal((await mk(org.token, { sport: 'tennis' })).status, 400, 'sport must match the competition');
  assert.equal((await mk(org.token)).status, 201);

  assert.equal((await api('POST', '/field-definitions', { token: player.token, body: { sport: 'badminton', scope: 'game', key: 'court_no', label: 'Court', datatype: 'integer' } })).status, 403);
  assert.equal((await api('POST', '/field-definitions', { token: org.token, body: { sport: 'badminton', scope: 'game', key: 'attendance', label: 'x', datatype: 'integer' } })).status, 409, 'built-in key');
  const def = await api('POST', '/field-definitions', { token: org.token, body: { sport: 'badminton', scope: 'game', key: 'shuttle_brand', label: 'Shuttle brand', datatype: 'enum', options: ['yonex', 'li-ning'], required: true } });
  assert.equal(def.status, 201, JSON.stringify(def.body));
  assert.ok((await api('GET', '/sports/badminton/game-fields')).body.fields.game.some((x) => x.key === 'shuttle_brand' && x.origin === 'custom'));
  assert.ok(!(await api('GET', '/sports/tennis/game-fields')).body.fields.game.some((x) => x.key === 'shuttle_brand'), 'scoped to its sport');
  assert.equal((await mk(org.token)).status, 400, 'required custom field');
  assert.equal((await mk(org.token, { attributes: { shuttle_brand: 'wilson' } })).status, 400);
  assert.equal((await mk(org.token, { attributes: { shuttle_brand: 'yonex', discipline: 'singles' } })).status, 201);
  assert.equal((await api('DELETE', `/field-definitions/${def.body.id}`, { token: player.token })).status, 403);
  assert.equal((await api('DELETE', `/field-definitions/${def.body.id}`, { token: org.token })).status, 200);
  assert.equal((await mk(org.token)).status, 201);
});
