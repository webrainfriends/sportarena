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
  const r = await api('POST', '/auth/register', { body: { handle: `pg_${n}_${roles[0]}`, display_name: `PG Person${n}`, email: `pg${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const post = (t, p, body) => api('POST', p, { token: t, body });
const patch = (t, p, body) => api('PATCH', p, { token: t, body });
const get = (t, p) => api('GET', p, { token: t });
const del = (t, p) => api('DELETE', p, { token: t });
const inFuture = (days, hour = 17) => { const d = new Date(Date.now() + days * 864e5); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

// a coach with an adult player and a young player (with a guardian) on their team, plus an unrelated coach and player
const setup = async () => {
  const coach = await signup(['coach']), other = await signup(['coach']), player = await signup(['athlete']), kid = await signup(['athlete']), parent = await signup(['athlete']), stranger = await signup(['athlete']);
  const team = ok(await post(coach.token, '/teams', { name: `Goals FC ${n}`, sport: 'football' }), 201);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'coach','active') ON CONFLICT (team_id, user_id) DO UPDATE SET role='coach', status='active'", [team.id, coach.id]);
  for (const u of [player, kid]) await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [team.id, u.id]);
  await pool.query('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);
  await pool.query("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [parent.id, kid.id]);
  const consent = (purpose) => pool.query("INSERT INTO youth_consents(child_id, purpose, granted_by, policy_version, expires_at) VALUES ($1,$2,$3,1, now() + interval '30 days') ON CONFLICT (child_id, purpose) DO UPDATE SET revoked_at=NULL, expires_at=now() + interval '30 days'", [kid.id, purpose, parent.id]);
  const withdraw = (purpose) => pool.query('UPDATE youth_consents SET revoked_at=now() WHERE child_id=$1 AND purpose=$2', [kid.id, purpose]);
  await consent('participation');
  return { coach, other, player, kid, parent, stranger, team, consent, withdraw };
};
const sess = (days, extra = {}) => ({ starts_at: inFuture(days), duration_min: 45, kind: 'skill', title: 'Wall passing', target_rpe: 6, ...extra });

test('personal goal: own status claim, validation, idempotent create, stale edits refused, append-only history', async () => {
  const s = await setup();
  const t = s.player.token;
  assert.equal((await post(t, '/me/goals', { title: 'x' })).status, 400, 'title too short');
  assert.equal((await post(t, '/me/goals', { title: 'Sprint faster', target_value: 12 })).status, 400, 'a target needs a unit');
  assert.equal((await post(t, '/me/goals', { title: 'Sprint faster', starts_on: '2026-05-01', ends_on: '2026-04-01' })).status, 400, 'end before start');
  assert.deepEqual(ok(await get(t, '/me/goals')), [], 'starts empty, no invented content');

  const body = { title: '40 m sprint', category: 'physical', measure: 'Timed with a stopwatch', target_value: 5.4, unit: 's', review_cadence_days: 14, client_key: 'goal-key-0001' };
  const g = ok(await post(t, '/me/goals', body), 201);
  assert.equal(g.status, 'active'); assert.equal(g.target_value, 5.4); assert.ok(g.review_on, 'cadence schedules the first review');
  const again = ok(await post(t, '/me/goals', body), 201);
  assert.equal(again.id, g.id, 'a retry with the same key returns the original');
  assert.equal(ok(await get(t, '/me/goals')).length, 1);

  assert.equal((await patch(s.stranger.token, `/me/goals/${g.id}`, { row_version: 1, title: 'mine now' })).status, 404, 'only the owner');
  const v2 = ok(await patch(t, `/me/goals/${g.id}`, { row_version: 1, why: 'Make the first team' }));
  assert.equal(v2.row_version, 2);
  assert.equal((await patch(t, `/me/goals/${g.id}`, { row_version: 1, title: 'stale' })).status, 409, 'stale version');
  assert.equal((await patch(t, `/me/goals/${g.id}`, { row_version: 2, status: 'achieved' })).status, 400, 'an achieved claim needs a note');

  const p1 = ok(await post(t, `/me/goals/${g.id}/progress`, { value: 5.9, note: 'Cold morning', client_key: 'prog-key-0001' }), 201);
  assert.equal(p1.basis, 'athlete_reported');
  const p1b = ok(await post(t, `/me/goals/${g.id}/progress`, { value: 5.9, note: 'Cold morning', client_key: 'prog-key-0001' }), 201);
  assert.equal(p1b.id, p1.id, 'a retried progress entry is not duplicated');
  assert.equal((await post(t, `/me/goals/${g.id}/progress`, {})).status, 400);
  assert.equal((await post(t, `/me/goals/${g.id}/progress`, { value: 5.8, logged_on: '2999-01-01' })).status, 400, 'no future dates');
  const noUnit = ok(await post(t, '/me/goals', { title: 'Be braver on the ball' }), 201);
  assert.equal((await post(t, `/me/goals/${noUnit.id}/progress`, { value: 3 })).status, 400, 'a number needs a unit on the goal');
  ok(await post(t, `/me/goals/${noUnit.id}/progress`, { note: 'Tried two take-ons' }), 201);

  ok(await patch(t, `/me/goals/${g.id}`, { row_version: 2, status: 'achieved', status_note: 'Ran 5.35 s twice' }));
  assert.equal((await post(t, `/me/goals/${g.id}/progress`, { value: 5.3 })).status, 409, 'closed goals take no progress until reopened');
  const full = ok(await get(t, `/me/goals/${g.id}`));
  assert.deepEqual(full.events.map((e) => e.to_status), ['active', 'achieved']);
  assert.equal(full.goal.status, 'achieved'); assert.ok(full.goal.claimed_at);
  assert.equal(full.progress.length, 1);
  assert.equal(full.assessments.length, 0, 'a claim is not a coach assessment');
  assert.equal((await get(s.stranger.token, `/me/goals/${g.id}`)).status, 404);
});

test('sharing: only with a current coach; coach sees only the shared item; assessment stays the coach\'s view; revoke is immediate', async () => {
  const s = await setup();
  const t = s.player.token;
  const g = ok(await post(t, '/me/goals', { title: 'Weak foot', measure: '8/10 accurate', target_value: 8, unit: 'passes' }), 201);
  const hidden = ok(await post(t, '/me/goals', { title: 'PRIVATE-GOAL' }), 201);
  assert.deepEqual(ok(await get(t, '/me/coaches')).map((x) => x.coach_id), [s.coach.id]);
  assert.equal((await post(t, '/me/shares', { goal_id: g.id, coach_id: s.other.id })).status, 400, 'not one of your coaches');
  assert.equal((await post(t, '/me/shares', { coach_id: s.coach.id })).status, 400, 'name a goal or a plan');
  assert.equal((await post(t, '/me/shares', { goal_id: g.id, plan_id: g.id, coach_id: s.coach.id })).status, 400);
  assert.equal((await post(s.stranger.token, '/me/shares', { goal_id: g.id, coach_id: s.coach.id })).status, 404, 'cannot share someone else\'s goal');

  assert.deepEqual(ok(await get(s.coach.token, '/coaching/player-shared?kind=goal')), [], 'nothing before sharing');
  assert.equal((await get(s.coach.token, `/coaching/player-shared/goal/${g.id}`)).status, 404);
  const sh = ok(await post(t, '/me/shares', { goal_id: g.id, coach_id: s.coach.id }), 201);
  const sh2 = ok(await post(t, '/me/shares', { goal_id: g.id, coach_id: s.coach.id }), 201);
  assert.equal(sh2.id, sh.id, 'sharing twice is the same share');
  assert.equal(ok(await get(t, '/me/goals')).find((x) => x.id === g.id).shared_with.length, 1);

  const list = ok(await get(s.coach.token, '/coaching/player-shared?kind=goal'));
  assert.deepEqual(list.map((x) => x.id), [g.id]);
  assert.ok(!JSON.stringify(list).includes('PRIVATE-GOAL'));
  assert.equal(list[0].shared_with, undefined, 'a coach never sees who else it was shared with');
  assert.equal((await get(s.coach.token, `/coaching/player-shared/goal/${hidden.id}`)).status, 404, 'unshared goals are not found');
  assert.equal((await get(s.other.token, `/coaching/player-shared/goal/${g.id}`)).status, 404, 'another coach cannot read it');
  assert.equal((await get(s.stranger.token, '/coaching/player-shared?kind=goal')).status, 403, 'coach role needed');
  const view = ok(await get(s.coach.token, `/coaching/player-shared/goal/${g.id}`));
  assert.equal(view.goal.title, 'Weak foot'); assert.equal(view.owner_id, s.player.id);

  assert.equal((await post(s.coach.token, `/coaching/player-shared/goal/${g.id}/assessments`, { rating: 'on_track' })).status, 400, 'a note is needed');
  assert.equal((await post(s.other.token, `/coaching/player-shared/goal/${g.id}/assessments`, { rating: 'on_track', note: 'nope' })).status, 404);
  const a = ok(await post(s.coach.token, `/coaching/player-shared/goal/${g.id}/assessments`, { rating: 'needs_attention', note: 'Plant foot is too far back', client_key: 'assess-key-001' }), 201);
  const a2 = ok(await post(s.coach.token, `/coaching/player-shared/goal/${g.id}/assessments`, { rating: 'needs_attention', note: 'Plant foot is too far back', client_key: 'assess-key-001' }), 201);
  assert.equal(a2.id, a.id, 'retry is idempotent');
  const mine = ok(await get(t, `/me/goals/${g.id}`));
  assert.equal(mine.goal.status, 'active', 'an assessment never changes the player\'s own status');
  assert.deepEqual(mine.assessments.map((x) => [x.basis, x.rating, x.coach_name]), [['coach_assessment', 'needs_attention', s.coach.display_name]]);
  assert.equal(ok(await get(t, '/me/goals')).find((x) => x.id === g.id).latest_assessment.rating, 'needs_attention');
  assert.equal(Number((await pool.query("SELECT count(*) FROM notifications WHERE user_id=$1 AND kind='player_assessment'", [s.player.id])).rows[0].count), 1, 'the player is told once, even after a retried request');
  assert.equal(Number((await pool.query("SELECT count(*) FROM notifications WHERE user_id=$1 AND kind='player_share'", [s.coach.id])).rows[0].count), 1, 'the coach is told once about a share, not on a repeat share');

  // revoke: effective at once for reads and writes; the player keeps the assessment; nothing deleted
  ok(await del(t, `/me/shares/${sh.id}`));
  ok(await del(t, `/me/shares/${sh.id}`));
  assert.equal((await del(s.stranger.token, `/me/shares/${sh.id}`)).status, 404);
  assert.deepEqual(ok(await get(s.coach.token, '/coaching/player-shared?kind=goal')), []);
  assert.equal((await get(s.coach.token, `/coaching/player-shared/goal/${g.id}`)).status, 404);
  assert.equal((await post(s.coach.token, `/coaching/player-shared/goal/${g.id}/assessments`, { rating: 'ahead', note: 'late' })).status, 404);
  assert.equal((await post(s.coach.token, `/coaching/player-shared/goal/${g.id}/adopt`)).status, 404);
  assert.equal(ok(await get(t, `/me/goals/${g.id}`)).assessments.length, 1);
  assert.equal(Number((await pool.query('SELECT count(*) FROM player_shares WHERE id=$1 AND revoked_at IS NOT NULL', [sh.id])).rows[0].count), 1, 'the share row is kept');
  // sharing again after a revoke makes a fresh live share
  const sh3 = ok(await post(t, '/me/shares', { goal_id: g.id, coach_id: s.coach.id }), 201);
  assert.notEqual(sh3.id, sh.id);
  assert.equal(ok(await get(s.coach.token, '/coaching/player-shared?kind=goal')).length, 1);

  // relationship ends -> the coach loses sight even though the share row is still live
  await pool.query("UPDATE team_members SET status='left' WHERE user_id=$1 AND role='coach'", [s.coach.id]);
  assert.deepEqual(ok(await get(s.coach.token, '/coaching/player-shared?kind=goal')), []);
  assert.equal((await get(s.coach.token, `/coaching/player-shared/goal/${g.id}`)).status, 404);
});

test('adoption: a goal becomes the coach\'s own coaching goal, a plan a coach-authored draft; originals untouched; adopting twice is the same adoption', async () => {
  const s = await setup();
  const t = s.player.token;
  const g = ok(await post(t, '/me/goals', { title: 'First touch', measure: 'Settle in one touch', target_value: 9, unit: 'of 10', review_on: '2027-03-01' }), 201);
  ok(await post(t, '/me/shares', { goal_id: g.id, coach_id: s.coach.id }), 201);
  const ad = ok(await post(s.coach.token, `/coaching/player-shared/goal/${g.id}/adopt`), 201);
  assert.equal(ad.already_adopted, false);
  const cg = ad.record;
  assert.equal(cg.coach_id, s.coach.id); assert.equal(cg.athlete_id, s.player.id); assert.equal(cg.status, 'planned'); assert.match(cg.criterion, /Settle in one touch.*Target: 9 of 10/);
  const again = ok(await post(s.coach.token, `/coaching/player-shared/goal/${g.id}/adopt`), 201);
  assert.equal(again.already_adopted, true);
  assert.equal(Number((await pool.query('SELECT count(*) FROM coaching_goals WHERE athlete_id=$1', [s.player.id])).rows[0].count), 1, 'no duplicate coaching goal');
  assert.equal(ok(await get(t, `/me/goals/${g.id}`)).goal.status, 'active', 'the athlete\'s original is untouched');
  assert.equal(ok(await get(t, '/me/goals')).find((x) => x.id === g.id).adopted_by[0].coach_name, s.coach.display_name);
  assert.deepEqual(ok(await get(t, '/me/coaching-goals')).map((x) => x.text), ['First touch'], 'the coach\'s copy reaches the athlete through the normal coaching-goal flow');

  const plan = ok(await post(t, '/me/personal-plans', { title: 'Summer fitness', intent: 'Be ready for pre-season', sport: 'football', goal_id: g.id, sessions: [sess(2), sess(4, { title: 'Intervals', kind: 'conditioning' })] }), 201);
  assert.equal(plan.total, 2);
  ok(await post(t, '/me/shares', { plan_id: plan.id, coach_id: s.coach.id }), 201);
  const pa = ok(await post(s.coach.token, `/coaching/player-shared/plan/${plan.id}/adopt`), 201);
  const tp = ok(await get(s.coach.token, `/training-plans/${pa.training_plan_id}`));
  assert.equal(tp.status, 'draft'); assert.equal(tp.coach_id, s.coach.id);
  assert.deepEqual(tp.revisions[0].content.sessions.map((x) => x.title), ['Wall passing', 'Intervals']);
  assert.equal(ok(await get(t, '/training-plans?as=athlete')).length, 0, 'the athlete sees nothing until the coach proposes it');
  assert.equal(ok(await post(s.coach.token, `/coaching/player-shared/plan/${plan.id}/adopt`), 201).already_adopted, true);
  assert.equal(ok(await get(t, `/me/personal-plans/${plan.id}`)).plan.status, 'active', 'original plan untouched');
});

test('self-directed plan: validation, sessions, outcomes are final, idempotent retries, completing a plan keeps history', async () => {
  const s = await setup();
  const t = s.player.token;
  assert.equal((await post(t, '/me/personal-plans', { title: 'Past', sessions: [sess(-1)] })).status, 400, 'future sessions only');
  assert.equal((await post(t, '/me/personal-plans', { title: 'Mine', goal_id: '00000000-0000-4000-8000-000000000000' })).status, 400, 'goal must be yours');
  const p = ok(await post(t, '/me/personal-plans', { title: 'Home circuit', client_key: 'plan-key-0001', sessions: [sess(1)] }), 201);
  assert.equal(ok(await post(t, '/me/personal-plans', { title: 'Home circuit', client_key: 'plan-key-0001', sessions: [sess(1)] }), 201).id, p.id);
  assert.equal(ok(await get(t, `/me/personal-plans/${p.id}`)).sessions.length, 1, 'a retried create does not add sessions twice');
  assert.equal((await get(s.stranger.token, `/me/personal-plans/${p.id}`)).status, 404);

  const x = ok(await post(t, `/me/personal-plans/${p.id}/sessions`, { ...sess(3), title: 'Core', client_key: 'sess-key-0001' }), 201);
  assert.equal(ok(await post(t, `/me/personal-plans/${p.id}/sessions`, { ...sess(3), title: 'Core', client_key: 'sess-key-0001' }), 201).id, x.id);
  assert.equal((await post(t, `/me/personal-plans/${p.id}/sessions`, sess(-2))).status, 400);
  const moved = ok(await patch(t, `/me/personal-plan-sessions/${x.id}`, { row_version: 1, starts_at: inFuture(5), title: 'Core + mobility' }));
  assert.equal(moved.title, 'Core + mobility');
  assert.equal((await patch(t, `/me/personal-plan-sessions/${x.id}`, { row_version: 1, title: 'stale' })).status, 409);
  assert.equal((await patch(t, `/me/personal-plan-sessions/${x.id}`, { status: 'completed', rpe: 7 })).status, 400, 'cannot record a session days before it happens');

  // an earlier session recorded after the fact
  const sid = (await pool.query('SELECT id FROM player_plan_sessions WHERE plan_id=$1 ORDER BY starts_at LIMIT 1', [p.id])).rows[0].id;
  await pool.query("UPDATE player_plan_sessions SET starts_at = now() - interval '2 hours' WHERE id=$1", [sid]);
  assert.equal((await patch(s.stranger.token, `/me/personal-plan-sessions/${sid}`, { status: 'completed' })).status, 404);
  const done = ok(await patch(t, `/me/personal-plan-sessions/${sid}`, { status: 'completed', rpe: 7, note: 'Felt strong' }));
  assert.equal(done.status, 'completed'); assert.equal(done.rpe, 7);
  const retry = ok(await patch(t, `/me/personal-plan-sessions/${sid}`, { status: 'completed', rpe: 2, note: 'overwrite?' }));
  assert.equal(retry.rpe, 7, 'a repeated outcome does not overwrite the first record');
  assert.equal((await patch(t, `/me/personal-plan-sessions/${sid}`, { status: 'skipped' })).status, 409, 'a recorded outcome is final');
  assert.equal((await patch(t, `/me/personal-plan-sessions/${sid}`, { title: 'rewrite history', row_version: 2 })).status, 409);

  const closed = ok(await patch(t, `/me/personal-plans/${p.id}`, { row_version: 1, status: 'completed' }));
  assert.equal(closed.status, 'completed'); assert.equal(closed.completed, 1);
  const after = ok(await get(t, `/me/personal-plans/${p.id}`)).sessions.map((q) => q.status).sort();
  assert.deepEqual(after, ['cancelled', 'completed'], 'future sessions are cancelled, not deleted; history stays');
  assert.equal((await post(t, `/me/personal-plans/${p.id}/sessions`, sess(6))).status, 409);
  assert.equal((await patch(t, `/me/personal-plans/${p.id}`, { row_version: 1, title: 'stale' })).status, 409);
});

test('young people: sharing needs guardian consent; withdrawing it hides shared items from the coach at once; guardian reads read-only and audited; coach plans unaffected', async () => {
  const s = await setup();
  const k = s.kid.token;
  const g = ok(await post(k, '/me/goals', { title: 'Dribbling', measure: 'Beat a defender', client_key: 'kid-goal-001' }), 201);
  assert.equal(ok(await get(k, '/me/goals')).length, 1, 'a young person keeps their own goals without any consent');
  assert.equal((await post(k, '/me/shares', { goal_id: g.id, coach_id: s.coach.id })).status, 409, 'no coaching consent yet');
  await s.consent('coaching');
  ok(await post(k, '/me/shares', { goal_id: g.id, coach_id: s.coach.id }), 201);
  await pool.query("INSERT INTO youth_consents(child_id, purpose, granted_by, policy_version, expires_at) VALUES ($1,'participation',$2,1, now() + interval '30 days') ON CONFLICT (child_id, purpose) DO NOTHING", [s.kid.id, s.parent.id]);
  assert.equal(ok(await get(s.coach.token, '/coaching/player-shared?kind=goal')).length, 1);
  ok(await post(s.coach.token, `/coaching/player-shared/goal/${g.id}/assessments`, { rating: 'on_track', note: 'Good first step' }), 201);

  // guardian: read-only, only their own child, audited
  const gv = ok(await get(s.parent.token, `/me/goals?athlete_id=${s.kid.id}`));
  assert.equal(gv.length, 1);
  assert.equal((await get(s.stranger.token, `/me/goals?athlete_id=${s.kid.id}`)).status, 403);
  assert.equal((await patch(s.parent.token, `/me/goals/${g.id}`, { row_version: 1, title: 'mine' })).status, 404, 'a guardian cannot edit the young person\'s goal');
  assert.equal((await post(s.parent.token, `/me/goals/${g.id}/progress`, { note: 'hi' })).status, 404);
  assert.ok(Number((await pool.query("SELECT count(*) FROM audit_log WHERE actor_id=$1 AND action='read_child_player_goals'", [s.parent.id])).rows[0].count) >= 1);
  const csv = ok(await get(s.parent.token, `/me/goals-export?athlete_id=${s.kid.id}`));
  assert.match(csv.csv, /goal_assessment/);
  assert.equal((await get(s.stranger.token, `/me/goals-export?athlete_id=${s.kid.id}`)).status, 403);

  // withdrawing coaching consent: the coach loses it immediately (reads and writes), the young person keeps it
  await s.withdraw('coaching');
  assert.deepEqual(ok(await get(s.coach.token, '/coaching/player-shared?kind=goal')), []);
  assert.equal((await get(s.coach.token, `/coaching/player-shared/goal/${g.id}`)).status, 404);
  assert.equal((await post(s.coach.token, `/coaching/player-shared/goal/${g.id}/assessments`, { rating: 'ahead', note: 'late' })).status, 404);
  assert.equal(ok(await get(k, '/me/goals')).length, 1, 'their own record is kept');
  assert.equal((await get(s.parent.token, `/me/goals?athlete_id=${s.kid.id}`)).status, 409, 'a guardian read needs current consent too');
  assert.equal((await get(s.parent.token, `/me/goals-export?athlete_id=${s.kid.id}`)).status, 409, 'exports for a young person need current consent too');
  const dev = ok(await get(k, '/me/development'));
  assert.equal(dev.consent, false); assert.equal(dev.sections.my_goals.items.length, 1, 'own goals still show when coaching sharing is off');
  assert.equal(ok(await get(s.parent.token, `/me/development?athlete_id=${s.kid.id}`)).sections.my_goals, undefined, 'guardian sees nothing while consent is off');
  await s.consent('coaching');
  assert.equal(ok(await get(s.coach.token, '/coaching/player-shared?kind=goal')).length, 1, 'allowing it again restores it');
});

test('development workspace and export carry the player\'s own items, labelled as their claims', async () => {
  const s = await setup();
  const t = s.player.token;
  const g = ok(await post(t, '/me/goals', { title: 'Endurance', review_on: new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10) }), 201);
  const p = ok(await post(t, '/me/personal-plans', { title: 'Base block', sessions: [sess(2)] }), 201);
  ok(await post(t, '/me/shares', { goal_id: g.id, coach_id: s.coach.id }), 201);
  ok(await post(s.coach.token, `/coaching/player-shared/goal/${g.id}/assessments`, { rating: 'ahead', note: 'Ahead of schedule' }), 201);
  const d = ok(await get(t, '/me/development'));
  assert.deepEqual(d.sections.my_goals.items.map((x) => [x.title, x.provenance.basis]), [['Endurance', 'athlete_set']]);
  assert.deepEqual(d.sections.my_training.items.map((x) => x.title), ['Base block']);
  assert.ok(d.sections.next_actions.items.some((x) => x.kind === 'player_goal_review'), 'a goal review due soon is a next action');
  assert.ok(d.sections.next_actions.items.some((x) => x.kind === 'player_plan_session'));
  const only = ok(await get(t, '/me/development?section=my_goals'));
  assert.deepEqual(Object.keys(only.sections), ['my_goals']);
  const e = ok(await get(t, '/me/goals-export'));
  const lines = e.csv.trim().split('\n');
  assert.equal(lines[0], 'record,title,date,status,value,unit,note,basis,by');
  assert.ok(lines.some((l) => l.startsWith('goal,Endurance') && l.includes('athlete_claim')));
  assert.ok(lines.some((l) => l.startsWith('goal_assessment') && l.includes('coach_assessment')), 'coach views are labelled apart from claims');
  assert.ok(lines.some((l) => l.startsWith('plan_session,Base block')));
  assert.ok(!ok(await get(s.stranger.token, '/me/goals-export')).csv.includes('Endurance'));
  void p;
});
