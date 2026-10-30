import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { setAiTransport } = await import('../src/ai.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
let n = 0;
const signup = async (roles) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `cg_${n}_${roles[0]}`, display_name: `CG Person${n}`, email: `cg${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const post = (t, p, body) => api('POST', p, { token: t, body });
const get = (t, p) => api('GET', p, { token: t });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { setAiTransport(null); server.close(); await pool.end(); });

const setup = async () => {
  const coach = await signup(['coach']), other = await signup(['coach']);
  const a = await signup(['athlete']), b = await signup(['athlete']), c = await signup(['athlete']), stranger = await signup(['athlete']);
  const team = ok(await post(coach.token, '/teams', { name: `Grp FC ${n}`, sport: 'football' }), 201);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'coach','active') ON CONFLICT (team_id, user_id) DO UPDATE SET role='coach', status='active'", [team.id, coach.id]);
  for (const p of [a, b, c]) await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [team.id, p.id]);
  const rec = ok(await post(coach.token, '/coaching/sessions', { source_type: 'team_session', source_id: randomUUID(), team_id: team.id, title: 'Thursday', objective: 'Press' }), 201);
  return { coach, other, a, b, c, stranger, team, rec };
};

test('player groups: only people you coach, unique names, soft removal, versioned edits', async () => {
  const s = await setup();
  assert.equal((await post(s.coach.token, '/coaching/groups', { name: 'Back four', athlete_ids: [s.stranger.id] })).status, 403, 'not someone I coach');
  assert.equal((await post(s.other.token, '/coaching/groups', { name: 'Mine', athlete_ids: [s.a.id] })).status, 403, 'an unrelated coach cannot group them');
  assert.equal((await post(s.athleteToken ?? s.a.token, '/coaching/groups', { name: 'x', athlete_ids: [s.b.id] })).status, 403, 'coach-only');
  const g = ok(await post(s.coach.token, '/coaching/groups', { name: 'Back four', team_id: s.team.id, sport: 'football', athlete_ids: [s.a.id, s.b.id] }), 201);
  assert.equal(g.member_count, 2); assert.ok(g.members.every((m) => m.current)); assert.equal(g.sport_slug, 'football');
  assert.equal((await post(s.coach.token, '/coaching/groups', { name: 'back FOUR', athlete_ids: [s.c.id] })).status, 409, 'names are unique per coach');
  assert.equal((await post(s.coach.token, '/coaching/groups', { id: g.id, row_version: g.row_version, name: 'Back four', team_id: s.team.id, athlete_ids: [s.stranger.id] })).status, 403);
  const g2 = ok(await post(s.coach.token, '/coaching/groups', { id: g.id, row_version: g.row_version, name: 'Defence', team_id: s.team.id, athlete_ids: [s.b.id, s.c.id] }), 201);
  assert.equal(g2.row_version, 2); assert.deepEqual(g2.members.map((m) => m.id).sort(), [s.b.id, s.c.id].sort());
  assert.equal((await post(s.coach.token, '/coaching/groups', { id: g.id, row_version: 1, name: 'Stale', athlete_ids: [s.b.id] })).status, 409, 'stale edit refused');
  const removed = await pool.query('SELECT removed_at FROM coaching_player_group_members WHERE group_id=$1 AND athlete_id=$2', [g.id, s.a.id]);
  assert.ok(removed.rows[0].removed_at, 'removed, not deleted');
  assert.equal(ok(await get(s.other.token, '/coaching/groups')).length, 0, 'groups are private to the coach');
  assert.equal(ok(await get(s.coach.token, '/coaching/groups?q=defen')).length, 1);
  assert.equal(ok(await get(s.coach.token, '/coaching/groups?q=nothing')).length, 0);
});

test('using a group puts it on the session roster and as a named group; stale members are skipped, never added', async () => {
  const s = await setup();
  const g = ok(await post(s.coach.token, '/coaching/groups', { name: 'Press unit', team_id: s.team.id, athlete_ids: [s.a.id, s.b.id] }), 201);
  assert.equal((await post(s.other.token, `/coaching/sessions/${s.rec.id}/use-group`, { group_id: g.id })).status, 404, 'not my session');
  await pool.query("UPDATE team_members SET status='left' WHERE team_id=$1 AND user_id=$2", [s.team.id, s.b.id]); // no longer coached
  const r = ok(await post(s.coach.token, `/coaching/sessions/${s.rec.id}/use-group`, { group_id: g.id }));
  assert.equal(r.added, 1); assert.equal(r.skipped, 1);
  assert.deepEqual(r.groups, [{ name: 'Press unit', athlete_ids: [s.a.id] }]);
  const listed = ok(await get(s.coach.token, '/coaching/groups'))[0];
  assert.equal(listed.members.find((m) => m.id === s.b.id).current, false, 'the list shows who is no longer current');
  // blocks can now be aimed at the group, and using it twice does not duplicate it
  ok(await post(s.coach.token, `/coaching/sessions/${s.rec.id}/plan`, { blocks: [{ kind: 'tactical_drill', title: 'Press trigger', unit: 'Press unit', duration_min: 10 }] }));
  ok(await post(s.coach.token, `/coaching/sessions/${s.rec.id}/use-group`, { group_id: g.id }));
  assert.equal(ok(await get(s.coach.token, `/coaching/sessions/${s.rec.id}`)).session.groups.length, 1);
  await pool.query("UPDATE team_members SET status='left' WHERE team_id=$1 AND user_id=$2", [s.team.id, s.a.id]);
  assert.equal((await post(s.coach.token, `/coaching/sessions/${s.rec.id}/use-group`, { group_id: g.id })).status, 400, 'nobody left to add');
  // archived groups and completed sessions are refused; the group is kept
  const g3 = ok(await post(s.coach.token, '/coaching/groups', { name: 'Wide', athlete_ids: [s.c.id] }), 201);
  ok(await api('DELETE', `/coaching/groups/${g3.id}`, { token: s.coach.token }));
  assert.equal((await post(s.coach.token, `/coaching/sessions/${s.rec.id}/use-group`, { group_id: g3.id })).status, 404);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM coaching_player_groups WHERE id=$1', [g3.id])).rows[0].n, 1, 'archived, not deleted');
  await pool.query("UPDATE coaching_session_records SET status='completed' WHERE id=$1", [s.rec.id]);
  assert.equal((await post(s.coach.token, `/coaching/sessions/${s.rec.id}/use-group`, { group_id: g.id })).status, 409);
});

test('young people the guardian has not allowed are neither added to a group nor listed', async () => {
  const s = await setup();
  const g = ok(await post(s.coach.token, '/coaching/groups', { name: 'Under 15', team_id: s.team.id, athlete_ids: [s.a.id, s.c.id] }), 201);
  await pool.query("UPDATE users SET youth_until = current_date + 1000 WHERE id=$1", [s.c.id]);
  assert.equal((await post(s.coach.token, '/coaching/groups', { name: 'Under 15 b', athlete_ids: [s.c.id] })).status, 403);
  assert.ok(!ok(await get(s.coach.token, '/coaching/groups'))[0].members.some((m) => m.id === s.c.id), 'hidden from the list');
  const r = ok(await post(s.coach.token, `/coaching/sessions/${s.rec.id}/use-group`, { group_id: g.id }));
  assert.deepEqual(r.groups[0].athlete_ids, [s.a.id]);
});

test('drill library: search by word, sport and skill tag; sport on save; shared drills are found but private ones are not', async () => {
  const s = await setup();
  const blocks = (title, tags, instructions) => [{ kind: 'skill_drill', title, tags, instructions, cues: [], duration_min: 10 }];
  const d1 = ok(await post(s.coach.token, '/coaching/templates', { title: 'Rondo 4v2', scope: 'block', sport: 'football', blocks: blocks('Rondo', ['passing', 'Pressure'], 'Keep the ball in a tight square') }), 201);
  ok(await post(s.coach.token, '/coaching/templates', { title: 'Net rally', scope: 'block', sport: 'tennis', blocks: blocks('Rally', ['footwork'], 'Cross-court depth') }), 201);
  ok(await post(s.coach.token, '/coaching/templates', { title: 'No sport', scope: 'block', blocks: blocks('Free', [], 'Anything') }), 201);
  assert.equal((await post(s.coach.token, '/coaching/templates', { title: 'Bad', scope: 'block', sport: 'no-such-sport', blocks: blocks('Xyz', [], 'y') })).status, 404);
  const names = (r) => r.map((t) => t.title).sort();
  assert.deepEqual(names(ok(await get(s.coach.token, '/coach/templates?sport=football'))), ['Rondo 4v2']);
  assert.deepEqual(names(ok(await get(s.coach.token, '/coach/templates?tag=pressure'))), ['Rondo 4v2'], 'tags match without regard to case');
  assert.deepEqual(names(ok(await get(s.coach.token, '/coach/templates?q=cross-court'))), ['Net rally'], 'words in instructions are searched');
  assert.deepEqual(names(ok(await get(s.coach.token, '/coach/templates?q=rondo&sport=football&tag=passing'))), ['Rondo 4v2']);
  assert.equal(ok(await get(s.coach.token, '/coach/templates?q=rondo&sport=tennis')).length, 0);
  assert.equal(ok(await get(s.other.token, '/coach/templates?q=rondo')).length, 0, 'private drills stay private');
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'coach','active')", [s.team.id, s.other.id]);
  ok(await post(s.coach.token, `/coaching/templates/${d1.id}/share`, { with: 'team', team_id: s.team.id }));
  assert.deepEqual(names(ok(await get(s.other.token, '/coach/templates?q=rondo'))), ['Rondo 4v2'], 'shared with a team I coach');
});

test('coaching philosophy: saved on the one coach profile, public, from a catalogue of styles, and given to the copilot as the coach\'s own approach', async () => {
  const s = await setup();
  await pool.query("INSERT INTO sport_profiles(user_id, sport_id, role, level) SELECT $1, id, 'coach', 'pro' FROM sports WHERE slug='football'", [s.coach.id]);
  assert.equal((await post(s.coach.token, '/me/coach-profile', { philosophy: 'x', coaching_styles: ['made_up'] })).status, 400, 'styles come from the catalogue');
  assert.equal((await post(s.a.token, '/me/coach-profile', { philosophy: 'x' })).status, 403);
  ok(await post(s.coach.token, '/me/coach-profile', { headline: 'Press-first coach', philosophy: 'Players learn by playing; I coach the decision, not the outcome.', coaching_styles: ['game_based', 'player_led'] }), 200);
  ok(await post(s.coach.token, '/me/coach-profile', { tagline: 'Keep it simple' }), 200); // a later save leaves the philosophy alone
  const pub = ok(await api('GET', `/coaches/${s.coach.id}`));
  assert.match(pub.profile.philosophy, /decision, not the outcome/); assert.deepEqual(pub.profile.coaching_styles, ['game_based', 'player_led']);
  ok(await post(s.coach.token, '/me/coach-profile', { philosophy: null, coaching_styles: [] }), 200);
  assert.equal(ok(await api('GET', `/coaches/${s.coach.id}`)).profile.philosophy, null, 'can be cleared');
  ok(await post(s.coach.token, '/me/coach-profile', { philosophy: 'Joy first, then structure.', coaching_styles: ['fun_and_participation'] }), 200);
  let sent = [];
  setAiTransport(async (body) => { sent.push(JSON.stringify(body)); return JSON.stringify({ headline: 'ok', items: [] }); });
  ok(await post(s.coach.token, '/coaching/ai/drafts', { task: 'player_progress', team_id: s.team.id }), 201);
  assert.ok(sent[0].includes('Joy first, then structure.') && sent[0].includes('fun_and_participation'), 'the copilot is told how this coach coaches');
  assert.ok(!sent[0].includes(s.coach.id), 'no ids are sent');
});
