import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

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
  const r = await api('POST', '/auth/register', { body: { handle: `ct_${n}_${roles[0]}`, display_name: `CT Person${n}`, email: `ct${n}@example.com`, password: 'correct-horse-battery', roles } });
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
after(async () => { server.close(); await pool.end(); });

const setup = async () => {
  const coach = await signup(['coach']), assistant = await signup(['coach']), outsider = await signup(['coach']);
  const a = await signup(['athlete']), b = await signup(['athlete']), c = await signup(['athlete']);
  const team = ok(await post(coach.token, '/teams', { name: `Tpl FC ${n}`, sport: 'football' }), 201);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'coach','active') ON CONFLICT (team_id, user_id) DO UPDATE SET role='coach', status='active'", [team.id, coach.id]);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'coach','active')", [team.id, assistant.id]);
  for (const p of [a, b, c]) await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [team.id, p.id]);
  const rec = ok(await post(coach.token, '/coaching/sessions', { source_type: 'team_session', source_id: randomUUID(), team_id: team.id, title: 'Tuesday', objective: 'Shape' }), 201);
  return { coach, assistant, outsider, a, b, c, team, rec };
};

test('groups: blocks can be aimed at a named group; unknown groups and outsiders are refused', async () => {
  const s = await setup();
  const stranger = await signup(['athlete']);
  assert.equal((await post(s.coach.token, `/coaching/sessions/${s.rec.id}/groups`, { groups: [{ name: 'Defenders', athlete_ids: [stranger.id] }] })).status, 400, 'must be on the roster');
  assert.equal((await post(s.coach.token, `/coaching/sessions/${s.rec.id}/groups`, { groups: [{ name: 'D', athlete_ids: [s.a.id] }, { name: 'd', athlete_ids: [s.b.id] }] })).status, 400, 'names must differ');
  const blocks = [{ kind: 'tactical_drill', title: 'Back-line shape', unit: 'Defenders', duration_min: 15 }];
  assert.equal((await post(s.coach.token, `/coaching/sessions/${s.rec.id}/plan`, { blocks })).status, 400, 'no such group yet');
  ok(await post(s.coach.token, `/coaching/sessions/${s.rec.id}/groups`, { groups: [{ name: 'Defenders', athlete_ids: [s.a.id, s.b.id] }, { name: 'Forwards', athlete_ids: [s.c.id] }] }));
  ok(await post(s.coach.token, `/coaching/sessions/${s.rec.id}/plan`, { blocks }));
  const ws = ok(await get(s.coach.token, `/coaching/sessions/${s.rec.id}`));
  assert.equal(ws.plan.blocks[0].unit, 'Defenders'); assert.equal(ws.session.groups.length, 2);
  assert.equal((await post(s.outsider.token, `/coaching/sessions/${s.rec.id}/groups`, { groups: [] })).status, 404);
});

test('delegation: a team coach gets exactly the granted powers, sees none of the head coach\'s private material, and loses them when they leave the team', async () => {
  const s = await setup();
  ok(await post(s.coach.token, '/coaching/observations', { athlete_id: s.a.id, session_record_id: s.rec.id, note: 'HEAD-PRIVATE-NOTE' }), 201);
  await pool.query('UPDATE coaching_session_records SET private_summary=$2 WHERE id=$1', [s.rec.id, 'HEAD-PRIVATE-SUMMARY']);
  assert.equal((await get(s.assistant.token, `/coaching/sessions/${s.rec.id}`)).status, 404, 'no access before delegation');
  assert.equal((await post(s.coach.token, `/coaching/sessions/${s.rec.id}/delegates`, { user_id: s.outsider.id, permissions: ['observe'] })).status, 400, 'must coach the team');
  assert.equal((await post(s.outsider.token, `/coaching/sessions/${s.rec.id}/delegates`, { user_id: s.assistant.id, permissions: ['observe'] })).status, 404, 'only the head coach can delegate');
  ok(await post(s.coach.token, `/coaching/sessions/${s.rec.id}/delegates`, { user_id: s.assistant.id, permissions: ['attendance'] }), 201);
  const ws = ok(await get(s.assistant.token, `/coaching/sessions/${s.rec.id}`));
  assert.equal(ws.you_are, 'delegate'); assert.equal(ws.participants.length, 3);
  assert.ok(!JSON.stringify(ws).includes('HEAD-PRIVATE'), 'no private notes or summary');
  ok(await api('POST', `/coaching/sessions/${s.rec.id}/attendance`, { token: s.assistant.token, body: { entries: [{ athlete_id: s.a.id, attendance: 'present' }] } }));
  assert.equal((await post(s.assistant.token, '/coaching/observations', { athlete_id: s.a.id, session_record_id: s.rec.id, note: 'x1' })).status, 404, 'observe was not granted');
  assert.equal((await post(s.assistant.token, `/coaching/sessions/${s.rec.id}/plan`, { blocks: [] })).status, 404, 'cannot edit the plan');
  assert.equal((await post(s.assistant.token, `/coaching/sessions/${s.rec.id}/complete`, {})).status, 404, 'cannot finish it');
  ok(await post(s.coach.token, `/coaching/sessions/${s.rec.id}/delegates`, { user_id: s.assistant.id, permissions: ['attendance', 'observe'] }), 201);
  const mine = ok(await post(s.assistant.token, '/coaching/observations', { athlete_id: s.a.id, session_record_id: s.rec.id, note: 'ASSISTANT-STAFF-NOTE', visibility: 'staff', team_id: s.team.id }), 201);
  assert.equal(mine.coach_id, s.assistant.id, 'authored by the assistant');
  const own = ok(await get(s.coach.token, `/coaching/sessions/${s.rec.id}`));
  assert.ok(own.observations.some((o) => o.id === mine.id), 'staff-visible delegate notes show to the head coach');
  assert.equal(ok(await get(s.assistant.token, '/coaching/delegated-sessions')).length, 1);
  // leaving the team ends it, and so does revoking
  await pool.query("UPDATE team_members SET status='left' WHERE team_id=$1 AND user_id=$2", [s.team.id, s.assistant.id]);
  assert.equal((await get(s.assistant.token, `/coaching/sessions/${s.rec.id}`)).status, 404);
  await pool.query("UPDATE team_members SET status='active' WHERE team_id=$1 AND user_id=$2", [s.team.id, s.assistant.id]);
  assert.equal((await get(s.assistant.token, `/coaching/sessions/${s.rec.id}`)).status, 200);
  assert.equal(ok(await post(s.coach.token, `/coaching/sessions/${s.rec.id}/delegates`, { user_id: s.assistant.id, permissions: [] }), 201).revoked, true);
  assert.equal((await get(s.assistant.token, `/coaching/sessions/${s.rec.id}`)).status, 404);
});

test('player summaries and the team summary reach a player only when shared', async () => {
  const s = await setup();
  ok(await post(s.coach.token, `/coaching/sessions/${s.rec.id}/complete`, { team_summary: 'TEAM-SUMMARY', private_summary: 'PRIVATE-SUMMARY' }));
  ok(await post(s.coach.token, `/coaching/sessions/${s.rec.id}/player-summaries`, { athlete_id: s.a.id, summary: 'For Arjun only', shared: false }));
  assert.deepEqual(ok(await get(s.a.token, '/me/coaching-session-summaries')), [], 'unshared stays private');
  ok(await post(s.coach.token, `/coaching/sessions/${s.rec.id}/player-summaries`, { athlete_id: s.a.id, summary: 'Great scanning today', shared: true }));
  const mine = ok(await get(s.a.token, '/me/coaching-session-summaries'));
  assert.deepEqual(mine.map((x) => [x.kind, x.summary]), [['player', 'Great scanning today']]);
  assert.deepEqual(ok(await get(s.b.token, '/me/coaching-session-summaries')), [], 'another player sees nothing');
  ok(await post(s.coach.token, `/coaching/sessions/${s.rec.id}/player-summaries`, { athlete_id: s.b.id, summary: 'x1', shared: false, share_team_summary: true }));
  const b = ok(await get(s.b.token, '/me/coaching-session-summaries'));
  assert.deepEqual(b.map((x) => [x.kind, x.summary]), [['team', 'TEAM-SUMMARY']]);
  assert.ok(!JSON.stringify(b).includes('PRIVATE'));
  const stranger = await signup(['athlete']);
  assert.equal((await post(s.coach.token, `/coaching/sessions/${s.rec.id}/player-summaries`, { athlete_id: stranger.id, summary: 'x', shared: true })).status, 400);
  assert.equal((await post(s.outsider.token, `/coaching/sessions/${s.rec.id}/player-summaries`, { athlete_id: s.a.id, summary: 'x', shared: true })).status, 404);
});

test('templates: saved without player data, applied as a copy, shared only through teams/orgs, and edits never rewrite sessions', async () => {
  const s = await setup();
  ok(await post(s.coach.token, `/coaching/sessions/${s.rec.id}/groups`, { groups: [{ name: 'Defenders', athlete_ids: [s.a.id] }] }));
  const plan = ok(await post(s.coach.token, `/coaching/sessions/${s.rec.id}/plan`, { blocks: [
    { kind: 'warm_up', title: 'Rondo', duration_min: 10, scope: [s.a.id], unit: 'Defenders', coach_notes: 'ARJUN-IS-SLOW', cues: ['head up'] },
    { kind: 'skill_drill', title: 'Gates', duration_min: 15 },
  ] }));
  const tpl = ok(await post(s.coach.token, '/coaching/templates', { title: 'My Tuesday', session_record_id: s.rec.id }), 201);
  const text = JSON.stringify(tpl.blocks);
  assert.ok(!text.includes('ARJUN') && !text.includes(s.a.id) && !text.includes('Defenders'), 'no player data in a template');
  assert.deepEqual(tpl.blocks.map((b) => b.title), ['Rondo', 'Gates']);
  const one = ok(await post(s.coach.token, '/coaching/templates', { title: 'Just gates', scope: 'block', session_record_id: s.rec.id, block_id: plan.plan.blocks[1].id }), 201);
  assert.equal(one.blocks.length, 1);
  // apply to a fresh session
  const rec2 = ok(await post(s.coach.token, '/coaching/sessions', { source_type: 'team_session', source_id: randomUUID(), team_id: s.team.id, title: 'Thursday' }), 201);
  const applied = ok(await post(s.coach.token, `/coaching/sessions/${rec2.id}/apply-template`, { template_id: tpl.id }));
  assert.equal(applied.plan.blocks.length, 2);
  const pv = (await pool.query('SELECT from_template_id, from_template_version FROM coaching_session_plan_versions WHERE session_record_id=$1', [rec2.id])).rows[0];
  assert.deepEqual([pv.from_template_id, pv.from_template_version], [tpl.id, 1]);
  // editing the template does not touch the session
  const edited = ok(await api('PATCH', `/coaching/templates/${tpl.id}`, { token: s.coach.token, body: { version: 1, title: 'Renamed', blocks: [{ kind: 'review', title: 'Different', duration_min: 5 }] } }));
  assert.equal(edited.version, 2);
  assert.equal((await api('PATCH', `/coaching/templates/${tpl.id}`, { token: s.coach.token, body: { version: 1, title: 'stale' } })).status, 409);
  assert.deepEqual(ok(await get(s.coach.token, `/coaching/sessions/${rec2.id}`)).plan.blocks.map((b) => b.title), ['Rondo', 'Gates'], 'history is not rewritten');
  // visibility of templates
  const visibleTo = async (u) => ok(await get(u.token, '/coach/templates')).map((t) => t.id);
  assert.ok(!(await visibleTo(s.assistant)).includes(tpl.id), 'private by default');
  assert.equal((await post(s.assistant.token, `/coaching/sessions/${rec2.id}/apply-template`, { template_id: tpl.id })).status, 404);
  assert.equal((await post(s.outsider.token, `/coaching/templates/${tpl.id}/share`, { with: 'team', team_id: s.team.id })).status, 404, 'only the author shares');
  assert.equal((await post(s.coach.token, `/coaching/templates/${tpl.id}/share`, { with: 'team', team_id: randomUUID() })).status, 404);
  ok(await post(s.coach.token, `/coaching/templates/${tpl.id}/share`, { with: 'team', team_id: s.team.id }));
  assert.ok((await visibleTo(s.assistant)).includes(tpl.id));
  assert.ok(!(await visibleTo(s.outsider)).includes(tpl.id), 'not a coach of that team');
  assert.equal((await api('PATCH', `/coaching/templates/${tpl.id}`, { token: s.assistant.token, body: { version: 2, title: 'hijack' } })).status, 404, 'shared means usable, not editable');
  ok(await post(s.coach.token, `/coaching/templates/${tpl.id}/share`, { with: 'private' }));
  assert.ok(!(await visibleTo(s.assistant)).includes(tpl.id));
});

test('clone: copies the generic plan only - no attendance, notes, summaries or actions', async () => {
  const s = await setup();
  ok(await post(s.coach.token, `/coaching/sessions/${s.rec.id}/plan`, { blocks: [{ kind: 'warm_up', title: 'Rondo', duration_min: 10, coach_notes: 'PRIVATE-BLOCK-NOTE' }] }));
  ok(await post(s.coach.token, `/coaching/sessions/${s.rec.id}/attendance`, { entries: [{ athlete_id: s.a.id, attendance: 'present' }] }));
  ok(await post(s.coach.token, '/coaching/observations', { athlete_id: s.a.id, session_record_id: s.rec.id, note: 'OLD-NOTE' }), 201);
  ok(await post(s.coach.token, `/coaching/sessions/${s.rec.id}/complete`, { team_summary: 'OLD-SUMMARY' }));
  const copy = ok(await post(s.coach.token, `/coaching/sessions/${s.rec.id}/clone`, { source_type: 'team_session', source_id: randomUUID(), team_id: s.team.id, title: 'Next week' }), 201);
  const ws = ok(await get(s.coach.token, `/coaching/sessions/${copy.id}`));
  assert.equal(ws.plan.blocks[0].title, 'Rondo'); assert.equal(ws.session.status, 'planned');
  assert.ok(ws.participants.every((p) => p.attendance === 'expected'));
  const { previous_notes: lastTime, ...rest } = ws; // "what I said last time" is a separate, intended feature
  assert.ok(lastTime.some((x) => x.note === 'OLD-NOTE'));
  const text = JSON.stringify(rest);
  assert.ok(!text.includes('OLD-NOTE') && !text.includes('OLD-SUMMARY') && !text.includes('PRIVATE-BLOCK-NOTE'));
  assert.equal(ws.session.team_summary, null);
  assert.equal((await post(s.outsider.token, `/coaching/sessions/${s.rec.id}/clone`, { source_type: 'team_session', source_id: randomUUID(), team_id: s.team.id })).status, 404);
});

test('a recurring action schedules its next occurrence once, when first finished', async () => {
  const s = await setup();
  const due = new Date(Date.now() + 2 * 864e5).toISOString();
  assert.equal((await post(s.coach.token, '/coaching/actions', { athlete_id: s.a.id, title: 'Stretch routine', recurrence_days: 7 })).status, 400, 'needs a due date');
  const a = ok(await post(s.coach.token, '/coaching/actions', { athlete_id: s.a.id, title: 'Weekly video review', due_at: due, recurrence_days: 7 }), 201);
  const done = ok(await api('PATCH', `/coaching/actions/${a.id}`, { token: s.coach.token, body: { row_version: 1, status: 'done' } }));
  assert.ok(done.next_action_id);
  const next = (await pool.query('SELECT * FROM coaching_actions WHERE id=$1', [done.next_action_id])).rows[0];
  assert.equal(next.status, 'open'); assert.equal(next.recurs_from, a.id);
  assert.ok(Math.abs(new Date(next.due_at) - (new Date(due).getTime() + 7 * 864e5)) < 5000);
  // re-saving the finished one does not spawn again
  ok(await api('PATCH', `/coaching/actions/${a.id}`, { token: s.coach.token, body: { row_version: 2, completion_note: 'ok' } }));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM coaching_actions WHERE recurs_from=$1', [a.id])).rows[0].n, 1);
});
