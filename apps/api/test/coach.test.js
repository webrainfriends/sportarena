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
  const r = await api('POST', '/auth/register', { body: { handle: `co_${n}_${roles[0]}`, display_name: `Co ${n}`, email: `co${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const inFuture = (days, hour = 9) => { const d = new Date(Date.now() + days * 864e5); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const coachWithAthlete = async ({ confirm = true } = {}) => {
  const coach = await signup(['coach']), athlete = await signup(['athlete']);
  ok(await api('POST', '/me/sport-profiles', { token: coach.token, body: { sport: 'football', role: 'coach', level: 'pro', hourly_rate_cents: 50000 } }), 201);
  const hire = ok(await api('POST', '/hires', { token: athlete.token, body: { coach_id: coach.id, sport: 'football', starts_at: inFuture(3), duration_min: 60 } }), 201);
  if (confirm) ok(await api('PATCH', `/hires/${hire.id}`, { token: coach.token, body: { status: 'confirmed' } }));
  return { coach, athlete, hire };
};
const sess = (days, extra = {}) => ({ starts_at: inFuture(days, 17), duration_min: 60, kind: 'skill', title: 'Passing drills', target_rpe: 6, ...extra });

test('my athletes: only active relationships; unaccepted request and strangers excluded', async () => {
  const { coach, athlete } = await coachWithAthlete({ confirm: false });
  const stranger = await signup(['athlete']);
  assert.equal(ok(await api('GET', '/coach/athletes', { token: coach.token })).length, 0, 'unaccepted request is not a relationship');
  assert.equal((await api('POST', '/training-plans', { token: coach.token, body: { athlete_id: athlete.id, sport: 'football', title: 'Plan' } })).status, 403);
  const hires = ok(await api('GET', '/hires', { token: coach.token }));
  ok(await api('PATCH', `/hires/${hires[0].id}`, { token: coach.token, body: { status: 'confirmed' } }));
  const list = ok(await api('GET', '/coach/athletes', { token: coach.token }));
  assert.deepEqual(list.map((a) => a.id), [athlete.id]);
  assert.deepEqual(list[0].relationships, ['hire']);
  assert.ok(!/email|dob|medical|diagnos/i.test(JSON.stringify(list)));
  assert.equal((await api('POST', '/training-plans', { token: coach.token, body: { athlete_id: stranger.id, sport: 'football', title: 'Plan' } })).status, 403);
  assert.equal((await api('GET', '/coach/athletes', { token: athlete.token })).status, 403, 'athletes cannot use coach endpoints');
});

test('plan lifecycle: propose, accept, revise needs re-acceptance, history immutable', async () => {
  const { coach, athlete } = await coachWithAthlete();
  const plan = ok(await api('POST', '/training-plans', { token: coach.token, body: { athlete_id: athlete.id, sport: 'football', title: 'Pre-season', goal: 'Fitness', content: { sessions: [sess(5), sess(6)] } } }), 201);
  assert.equal((await api('GET', `/training-plans/${plan.id}`, { token: athlete.token })).body.revisions.length, 0, 'drafts are private to the coach');
  ok(await api('POST', `/training-plans/${plan.id}/propose`, { token: coach.token }));
  assert.equal((await api('POST', `/training-plans/${plan.id}/respond`, { token: coach.token, body: { response: 'accepted' } })).status, 403);
  assert.equal(ok(await api('POST', `/training-plans/${plan.id}/respond`, { token: athlete.token, body: { response: 'accepted' } })).status, 'active');
  assert.equal(ok(await api('GET', `/training-plans/${plan.id}`, { token: coach.token })).sessions.length, 2);

  // revision: move one session, add one
  const full = ok(await api('GET', `/training-plans/${plan.id}`, { token: coach.token }));
  ok(await api('POST', `/training-plans/${plan.id}/revisions`, { token: coach.token }), 201);
  const [a, b] = full.sessions;
  ok(await api('PATCH', `/training-plans/${plan.id}/draft`, { token: coach.token, body: { content: { sessions: [{ ...sess(8, { title: 'Moved' }), session_id: a.id }, sess(9, { title: 'New' })] } } }));
  ok(await api('POST', `/training-plans/${plan.id}/propose`, { token: coach.token }));
  const mid = ok(await api('GET', `/training-plans/${plan.id}`, { token: athlete.token }));
  assert.equal(mid.status, 'active', 'accepted plan stays active while a revision is pending');
  assert.equal(mid.sessions.find((s) => s.id === a.id).title, 'Passing drills', 'nothing changes before re-acceptance');
  assert.equal((await api('PATCH', `/training-plans/${plan.id}/draft`, { token: coach.token, body: { title: 'sneaky' } })).status, 409, 'proposed revision is immutable');
  ok(await api('POST', `/training-plans/${plan.id}/respond`, { token: athlete.token, body: { response: 'accepted' } }));
  const after = ok(await api('GET', `/training-plans/${plan.id}`, { token: coach.token }));
  assert.equal(after.sessions.find((s) => s.id === a.id).title, 'Moved');
  assert.equal(after.sessions.find((s) => s.id === b.id).status, 'cancelled', 'dropped session is cancelled, not deleted');
  assert.equal(after.revisions.find((r) => r.rev === 1).response, 'superseded');
  assert.equal(after.sessions.length, 3);
});

test('completed sessions cannot be rewritten; feedback flow; close keeps history', async () => {
  const { coach, athlete } = await coachWithAthlete();
  const plan = ok(await api('POST', '/training-plans', { token: coach.token, body: { athlete_id: athlete.id, sport: 'football', title: 'Plan P', content: { sessions: [sess(2), sess(4)] } } }), 201);
  ok(await api('POST', `/training-plans/${plan.id}/propose`, { token: coach.token }));
  ok(await api('POST', `/training-plans/${plan.id}/respond`, { token: athlete.token, body: { response: 'accepted' } }));
  const [s1, s2] = ok(await api('GET', `/training-plans/${plan.id}`, { token: coach.token })).sessions;
  assert.equal((await api('PATCH', `/training-sessions/${s1.id}`, { token: coach.token, body: { status: 'completed' } })).status, 403);
  ok(await api('PATCH', `/training-sessions/${s1.id}`, { token: athlete.token, body: { status: 'completed', athlete_rpe: 7, athlete_feedback: 'Felt good' } }));
  assert.equal((await api('PATCH', `/training-sessions/${s1.id}`, { token: athlete.token, body: { status: 'skipped' } })).status, 409, 'recorded outcome is final');
  ok(await api('PATCH', `/training-sessions/${s1.id}`, { token: coach.token, body: { coach_feedback: 'Good tempo' } }));
  assert.equal((await api('PATCH', `/training-sessions/${s2.id}`, { token: coach.token, body: { coach_feedback: 'early' } })).status, 409);
  // revision trying to change the completed session is refused
  ok(await api('POST', `/training-plans/${plan.id}/revisions`, { token: coach.token }), 201);
  assert.equal((await api('PATCH', `/training-plans/${plan.id}/draft`, { token: coach.token, body: { content: { sessions: [{ ...sess(7), session_id: s1.id }] } } })).status, 400);
  const list = ok(await api('GET', '/coach/athletes', { token: coach.token }));
  assert.equal(list[0].adherence_pct, 100);
  // athlete revokes by closing: future cancelled, history kept, coach loses authority
  ok(await api('POST', `/training-plans/${plan.id}/close`, { token: athlete.token }));
  const closed = ok(await api('GET', `/training-plans/${plan.id}`, { token: coach.token }));
  assert.equal(closed.sessions.find((s) => s.id === s1.id).coach_feedback, 'Good tempo');
  assert.equal(closed.sessions.find((s) => s.id === s2.id).status, 'cancelled');
  assert.equal((await api('POST', `/training-plans/${plan.id}/revisions`, { token: coach.token })).status, 409);
});

test('concurrent proposals of the same draft: exactly one wins; change request surfaces in the inbox', async () => {
  const { coach, athlete } = await coachWithAthlete();
  const plan = ok(await api('POST', '/training-plans', { token: coach.token, body: { athlete_id: athlete.id, sport: 'football', title: 'Plan C', content: { sessions: [sess(3)] } } }), 201);
  const res = await Promise.all([1, 2, 3].map(() => api('POST', `/training-plans/${plan.id}/propose`, { token: coach.token })));
  assert.deepEqual(res.map((r) => r.status).sort(), [200, 409, 409]);
  assert.equal((await api('POST', `/training-plans/${plan.id}/respond`, { token: athlete.token, body: { response: 'change_requested' } })).status, 400, 'a note is required');
  ok(await api('POST', `/training-plans/${plan.id}/respond`, { token: athlete.token, body: { response: 'change_requested', note: 'Too early' } }));
  const home = ok(await api('GET', '/coach/home', { token: coach.token }));
  assert.ok(home.inbox.some((x) => x.kind === 'plan_reply' && x.link.source_id === plan.id));
  assert.equal(home.counts.athletes, 1);
  assert.equal(home.verification, null);
  assert.ok(home.warnings.some((w) => w.kind === 'credential'));
});

test('revoked relationship: cancelled hire stops new plans; youth hidden without consent', async () => {
  const { coach, athlete, hire } = await coachWithAthlete();
  ok(await api('PATCH', `/hires/${hire.id}`, { token: athlete.token, body: { status: 'cancelled' } }));
  assert.equal(ok(await api('GET', '/coach/athletes', { token: coach.token })).length, 0);
  assert.equal((await api('POST', '/training-plans', { token: coach.token, body: { athlete_id: athlete.id, sport: 'football', title: 'Late' } })).status, 403);

  const c2 = await coachWithAthlete();
  await pool.query("UPDATE users SET youth_until = current_date + 365 WHERE id=$1", [c2.athlete.id]);
  assert.equal(ok(await api('GET', '/coach/athletes', { token: c2.coach.token })).length, 0, 'youth without guardian consent is not visible');
  assert.equal((await api('POST', '/training-plans', { token: c2.coach.token, body: { athlete_id: c2.athlete.id, sport: 'football', title: 'Plan Y' } })).status, 403);
});

test('team coach: scoped roster access, no settlement/owner powers; calendar composes sources and flags clashes', async () => {
  const owner = await signup(['athlete']), coach = await signup(['coach']), player = await signup(['athlete']), other = await signup(['coach']);
  const team = ok(await api('POST', '/teams', { token: owner.token, body: { name: 'Coached FC', sport: 'football' } }), 201);
  ok(await api('POST', `/teams/${team.id}/members`, { token: owner.token, body: { user_id: coach.id, role: 'coach' } }), 201);
  ok(await api('POST', `/teams/${team.id}/members`, { token: owner.token, body: { user_id: player.id } }), 201);
  for (const u of [coach, player]) await pool.query("UPDATE team_members SET status='active' WHERE team_id=$1 AND user_id=$2", [team.id, u.id]);

  const roster = ok(await api('GET', `/coach/teams/${team.id}/roster`, { token: coach.token }));
  assert.ok(roster.members.some((m) => m.id === player.id));
  assert.ok(!/rate|settlement|payout|email/i.test(JSON.stringify(roster)));
  assert.equal((await api('GET', `/coach/teams/${team.id}/roster`, { token: other.token })).status, 403);
  assert.equal((await api('GET', `/teams/${team.id}/settlement`, { token: coach.token })).status, 403, 'coach role alone gets no finance access');
  assert.equal((await api('PATCH', `/teams/${team.id}`, { token: coach.token, body: { name: 'Hijack' } })).status, 403);
  const mine = ok(await api('GET', '/coach/athletes', { token: coach.token }));
  assert.deepEqual(mine.map((a) => a.id), [player.id], 'team coaching is a relationship');
  assert.deepEqual(mine[0].relationships, ['team']);

  // calendar: a hire and a plan session overlapping
  ok(await api('POST', '/me/sport-profiles', { token: coach.token, body: { sport: 'football', role: 'coach', hourly_rate_cents: 1000 } }), 201);
  const hire = ok(await api('POST', '/hires', { token: player.token, body: { coach_id: coach.id, sport: 'football', starts_at: inFuture(5, 17), duration_min: 60 } }), 201);
  ok(await api('PATCH', `/hires/${hire.id}`, { token: coach.token, body: { status: 'confirmed' } }));
  const plan = ok(await api('POST', '/training-plans', { token: coach.token, body: { athlete_id: player.id, sport: 'football', title: 'Plan T', content: { sessions: [sess(5)] } } }), 201);
  ok(await api('POST', `/training-plans/${plan.id}/propose`, { token: coach.token }));
  ok(await api('POST', `/training-plans/${plan.id}/respond`, { token: player.token, body: { response: 'accepted' } }));
  const from = new Date().toISOString().slice(0, 10), to = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
  const cal = ok(await api('GET', `/coach/calendar?from=${from}&to=${to}`, { token: coach.token }));
  assert.deepEqual(cal.items.map((x) => x.source_type).sort(), ['coach_hire', 'training_session']);
  assert.ok(cal.items.every((x) => x.source_id && x.conflict), 'overlap flagged on both');
  assert.equal(cal.conflicts, 2);
  assert.equal(ok(await api('GET', `/coach/calendar?from=${from}&to=${to}&team_id=${team.id}`, { token: coach.token })).items.length, 0);

  // templates: private, archived not deleted
  const t = ok(await api('POST', '/coach/templates', { token: coach.token, body: { title: 'Rondo', sport: 'football', kind: 'skill', structure: { drills: ['5v2'] } } }), 201);
  assert.equal(ok(await api('GET', '/coach/templates', { token: coach.token })).length, 1);
  assert.equal(ok(await api('GET', '/coach/templates', { token: other.token })).length, 0);
  ok(await api('DELETE', `/coach/templates/${t.id}`, { token: coach.token }));
  assert.equal((await pool.query('SELECT 1 FROM coach_templates WHERE id=$1', [t.id])).rowCount, 1);
});
