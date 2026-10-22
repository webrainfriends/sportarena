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
  const r = await api('POST', '/auth/register', { body: { handle: `co2_${n}_${roles[0]}`, display_name: `CO2 Person${n}`, email: `co2${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const post = (t, p, body) => api('POST', p, { token: t, body });
const get = (t, p) => api('GET', p, { token: t });
const today = new Date().toISOString().slice(0, 10);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { setAiTransport(null); server.close(); await pool.end(); });

const setup = async () => {
  const coach = await signup(['coach']), arjun = await signup(['athlete']), kabir = await signup(['athlete']);
  const team = ok(await post(coach.token, '/teams', { name: `Ops FC ${n}`, sport: 'football' }), 201);
  const rival = ok(await post(coach.token, '/teams', { name: `Ops Rival ${n}`, sport: 'football' }), 201);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'coach','active') ON CONFLICT (team_id, user_id) DO UPDATE SET role='coach', status='active'", [team.id, coach.id]);
  for (const p of [arjun, kabir]) await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [team.id, p.id]);
  const { rows: [sp] } = await pool.query("SELECT id FROM sports WHERE slug='football'");
  const { rows: [ev] } = await pool.query("INSERT INTO events(name, sport_id, organizer_id) VALUES ('Cup',$1,$2) RETURNING id", [sp.id, coach.id]);
  const fixture = async (status, offsetHours, scores = [null, null]) => (await pool.query('INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at, status, home_score, away_score) VALUES ($1,$2,$3, now() + make_interval(hours => $4), $5, $6, $7) RETURNING id', [ev.id, team.id, rival.id, offsetHours, status, scores[0], scores[1]])).rows[0].id;
  return { coach, arjun, kabir, team, rival, fixture };
};

test('home: every section the issue lists, and each filter narrows them', async () => {
  const s = await setup();
  // a team session today, an individual hire-less session record for one player, a running one
  const teamRec = ok(await post(s.coach.token, '/coaching/sessions', { source_type: 'team_session', source_id: randomUUID(), team_id: s.team.id, title: 'Team today', scheduled_at: new Date().toISOString() }), 201);
  ok(await post(s.coach.token, '/coaching/observations', { athlete_id: s.arjun.id, session_record_id: teamRec.id, note: 'n1', skill_tag: 'passing', follow_up: true }), 201);
  ok(await post(s.coach.token, '/coaching/actions', { athlete_id: s.arjun.id, title: 'Open one' }), 201);
  ok(await post(s.coach.token, '/coaching/actions', { athlete_id: s.kabir.id, title: 'Overdue one', due_at: new Date(Date.now() - 864e5).toISOString() }), 201);
  const upcoming = await s.fixture('scheduled', 48), played = await s.fixture('completed', -30, [2, 1]);
  const stale = ok(await post(s.coach.token, '/coaching/goals', { athlete_id: s.arjun.id, title: 'Old goal' }), 201);
  await pool.query("UPDATE coaching_goals SET status='active', created_at = now() - interval '60 days' WHERE id=$1", [stale.id]);
  ok(await post(s.coach.token, '/coaching/reports', { athlete_id: s.arjun.id, kind: 'athlete_progress', title: 'Draft report', audience: 'coach_private', from: '2026-01-01', to: today }), 201);
  setAiTransport(async () => JSON.stringify({ headline: 'h', items: [] }));
  ok(await post(s.coach.token, '/coaching/ai/drafts', { task: 'player_focus', athlete_id: s.arjun.id }), 201);

  const h = ok(await get(s.coach.token, '/coaching/home'));
  assert.deepEqual(h.today.map((x) => x.id), [teamRec.id]);
  assert.deepEqual(h.matches_to_prepare.map((x) => x.fixture_id), [upcoming], 'upcoming match with no prepared plan');
  assert.deepEqual(h.matches_to_debrief.map((x) => x.fixture_id), [played], 'played match with no reviewed record');
  assert.equal(h.open_actions.length, 2); assert.equal(h.overdue_actions.length, 1);
  assert.deepEqual(h.goals_stale.map((g) => g.id), [stale.id], 'active goal untouched for a month');
  assert.equal(h.draft_reports.length, 1); assert.equal(h.ai_waiting.length, 1); assert.equal(h.follow_ups.length, 1);

  // filters
  const by = async (q) => ok(await get(s.coach.token, `/coaching/home?${q}`));
  assert.equal((await by(`athlete_id=${s.kabir.id}`)).open_actions.length, 1);
  assert.equal((await by(`athlete_id=${s.kabir.id}`)).follow_ups.length, 0);
  assert.equal((await by('skill_tag=passing')).follow_ups.length, 1);
  assert.equal((await by('skill_tag=nothing')).follow_ups.length, 0);
  assert.equal((await by('skill_tag=nothing')).today.length, 0, 'sessions need a note with that skill');
  assert.equal((await by('scope=individual')).today.length, 0, 'the team session is not individual');
  assert.equal((await by('scope=team')).today.length, 1);
  assert.equal((await by('scope=team')).matches_to_prepare.length, 1);
  assert.equal((await by('scope=individual')).matches_to_prepare.length, 0);
  assert.equal((await by(`team_id=${s.rival.id}`)).matches_to_prepare.length, 0, 'a team you do not coach');
  assert.equal((await by('open_actions=true')).today.length, 1);
  assert.equal((await by('sport=football')).today.length, 1);
  const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  assert.equal((await by(`from=${tomorrow}&to=${tomorrow}`)).today.length, 0);
  assert.equal((await get(s.coach.token, `/coaching/home?from=${today}&to=2020-01-01`)).status, 400);
  // another coach sees none of it
  const other = await signup(['coach']);
  const o = ok(await get(other.token, '/coaching/home'));
  assert.equal(o.open_actions.length + o.matches_to_prepare.length + o.draft_reports.length + o.ai_waiting.length + o.goals_stale.length, 0);
});

test('filing a plan for a match removes it from "to prepare"; a reviewed debrief removes it from "to debrief"', async () => {
  const s = await setup();
  const upcoming = await s.fixture('scheduled', 24), played = await s.fixture('completed', -24, [1, 1]);
  const prep = ok(await post(s.coach.token, '/coaching/sessions', { source_type: 'fixture', source_id: upcoming, team_id: s.team.id }), 201);
  ok(await post(s.coach.token, `/coaching/sessions/${prep.id}/plan`, { blocks: [{ kind: 'review', title: 'Team talk', duration_min: 10 }] }));
  assert.equal(ok(await get(s.coach.token, '/coaching/home')).matches_to_prepare.length, 0);
  const deb = ok(await post(s.coach.token, '/coaching/sessions', { source_type: 'fixture', source_id: played, team_id: s.team.id }), 201);
  ok(await post(s.coach.token, `/coaching/sessions/${deb.id}/complete`, { team_summary: 'Drew 1-1, pressing worked' }));
  assert.equal(ok(await get(s.coach.token, '/coaching/home')).matches_to_debrief.length, 0);
});

test('timelines also carry goal decisions, actions, published reports and official matches - referenced, not copied', async () => {
  const s = await setup();
  const g = ok(await post(s.coach.token, '/coaching/goals', { athlete_id: s.arjun.id, title: 'TL goal' }), 201);
  ok(await api('PATCH', `/coaching/goals/${g.id}`, { token: s.coach.token, body: { row_version: 1, status: 'active' } }));
  ok(await post(s.coach.token, '/coaching/actions', { athlete_id: s.arjun.id, title: 'TL action' }), 201);
  const rep = ok(await post(s.coach.token, '/coaching/reports', { athlete_id: s.arjun.id, kind: 'athlete_progress', title: 'TL report', audience: 'coach_private', from: '2026-01-01', to: today }), 201);
  ok(await post(s.coach.token, `/coaching/reports/${rep.id}/publish`, { row_version: 1 }), 201);
  const played = await s.fixture('completed', -2, [3, 0]);
  const tl = ok(await get(s.coach.token, `/coaching/athletes/${s.arjun.id}/timeline`));
  const kinds = new Set(tl.map((x) => x.kind));
  for (const k of ['goal', 'action', 'report', 'match']) assert.ok(kinds.has(k), k);
  const match = tl.find((x) => x.kind === 'match');
  assert.equal(match.source_id, played); assert.match(match.detail, /Official result: 3-0/);
  assert.ok(tl.find((x) => x.kind === 'report').detail.includes('v1'));
  const tt = ok(await get(s.coach.token, `/coaching/teams/${s.team.id}/timeline`));
  assert.ok(tt.some((x) => x.kind === 'match') && tt.some((x) => x.kind === 'goal') === false, 'athlete goals are not team goals');
  const other = await signup(['coach']);
  assert.equal((await get(other.token, `/coaching/athletes/${s.arjun.id}/timeline`)).status, 403);
  const tag = ok(await get(s.coach.token, `/coaching/athletes/${s.arjun.id}/timeline?skill_tag=x`));
  assert.equal(tag.length, 0, 'tag filters only look at notes');
});
