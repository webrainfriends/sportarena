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
  const r = await api('POST', '/auth/register', { body: { handle: `pd_${n}_${roles[0]}`, display_name: `PD Person${n}`, email: `pd${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const post = (t, p, body) => api('POST', p, { token: t, body });
const patch = (t, p, body) => api('PATCH', p, { token: t, body });
const get = (t, p) => api('GET', p, { token: t });
const today = new Date().toISOString().slice(0, 10);
const inFuture = (days, hour = 17) => { const d = new Date(Date.now() + days * 864e5); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

// a coach with a player on their team, a second adult, and a young player with a guardian
const setup = async () => {
  const coach = await signup(['coach']), player = await signup(['athlete']), kid = await signup(['athlete']), parent = await signup(['athlete']), stranger = await signup(['athlete']);
  const team = ok(await post(coach.token, '/teams', { name: `Dev FC ${n}`, sport: 'football' }), 201);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'coach','active') ON CONFLICT (team_id, user_id) DO UPDATE SET role='coach', status='active'", [team.id, coach.id]);
  for (const u of [player, kid]) await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [team.id, u.id]);
  await pool.query('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);
  await pool.query("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [parent.id, kid.id]);
  const consent = (purpose) => pool.query("INSERT INTO youth_consents(child_id, purpose, granted_by, policy_version, expires_at) VALUES ($1,$2,$3,1, now() + interval '30 days') ON CONFLICT (child_id, purpose) DO UPDATE SET revoked_at=NULL, expires_at=now() + interval '30 days'", [kid.id, purpose, parent.id]);
  await consent('participation');
  return { coach, player, kid, parent, stranger, team, consent };
};
const sess = (days, extra = {}) => ({ starts_at: inFuture(days), duration_min: 60, kind: 'skill', title: 'Passing drills', target_rpe: 6, ...extra });

test('one workspace joins goals, actions, plans, feedback and reports, each row saying where it came from; private material never appears', async () => {
  const s = await setup();
  const empty = ok(await get(s.player.token, '/me/development'));
  assert.equal(empty.consent, true); assert.equal(empty.viewer, 'self');
  for (const k of ['next_actions', 'goals', 'plans', 'feedback', 'assessments', 'reports']) assert.deepEqual(empty.sections[k].items, [], `${k} starts empty, with no invented content`);

  ok(await post(s.coach.token, '/coaching/goals', { athlete_id: s.player.id, title: 'First touch', athlete_text: 'Settle the ball in one touch' }), 201);
  ok(await post(s.coach.token, '/coaching/goals', { athlete_id: s.player.id, title: 'SECRET-GOAL' }), 201);
  ok(await post(s.coach.token, '/coaching/observations', { athlete_id: s.player.id, note: 'SHARED-NOTE', visibility: 'player' }), 201);
  ok(await post(s.coach.token, '/coaching/observations', { athlete_id: s.player.id, note: 'PRIVATE-NOTE' }), 201);
  const act = ok(await post(s.coach.token, '/coaching/actions', { athlete_id: s.player.id, owner_id: s.player.id, title: 'Film review', due_at: new Date(Date.now() - 864e5).toISOString() }), 201);
  const plan = ok(await post(s.coach.token, '/training-plans', { athlete_id: s.player.id, sport: 'football', title: 'Pre-season', content: { sessions: [sess(2), sess(5, { title: 'Tempo' })] } }), 201);
  ok(await post(s.coach.token, `/training-plans/${plan.id}/propose`));
  const rep = ok(await post(s.coach.token, '/coaching/reports', { athlete_id: s.player.id, kind: 'athlete_progress', title: 'Month one', audience: 'athlete', from: '2026-01-01', to: today, narrative: 'Good start' }), 201);
  ok(await post(s.coach.token, `/coaching/reports/${rep.id}/publish`, { row_version: 1 }), 201);

  let d = ok(await get(s.player.token, '/me/development'));
  const text = JSON.stringify(d);
  assert.ok(!text.includes('SECRET-GOAL') && !text.includes('PRIVATE-NOTE'), 'private coach material never reaches the workspace');
  assert.deepEqual(d.sections.goals.items.map((g) => g.title), ['First touch']);
  assert.deepEqual(d.sections.reports.items.map((r) => r.title), ['Month one']);
  assert.equal(d.sections.feedback.items.find((f) => f.kind === 'coaching_note').text, 'SHARED-NOTE');
  assert.equal(d.sections.plans.items[0].can_respond, true);
  // next actions: the overdue coach action first, then the plan waiting for an answer
  assert.deepEqual(d.sections.next_actions.items.map((x) => [x.kind, x.urgency]), [['coach_action', 'overdue'], ['plan_response', 'needs_response']]);
  const p0 = d.sections.next_actions.items[0].provenance;
  assert.deepEqual([p0.source, p0.basis, p0.record.type, p0.record.id], ['coaching_action', 'coach_set', 'coaching_actions', act.id]);
  assert.equal(d.sections.plans.items[0].provenance.by, d.sections.plans.items[0].coach_name);

  // accept the plan: it stops being an item to answer, and its upcoming sessions become next actions
  ok(await post(s.player.token, `/training-plans/${plan.id}/respond`, { response: 'accepted' }));
  d = ok(await get(s.player.token, '/me/development'));
  assert.deepEqual(d.sections.next_actions.items.map((x) => x.kind), ['coach_action', 'plan_session', 'plan_session']);
  assert.equal(d.sections.plans.items[0].can_respond, false);

  // coach feedback on a finished session appears as feedback with its plan as context
  const first = ok(await get(s.coach.token, `/training-plans/${plan.id}`)).sessions[0];
  ok(await patch(s.player.token, `/training-sessions/${first.id}`, { status: 'completed', athlete_rpe: 7 }));
  ok(await patch(s.coach.token, `/training-sessions/${first.id}`, { coach_feedback: 'Good tempo' }));
  d = ok(await get(s.player.token, '/me/development'));
  const fb = d.sections.feedback.items.find((f) => f.kind === 'plan_feedback');
  assert.equal(fb.text, 'Good tempo'); assert.equal(fb.provenance.basis, 'coach_observed'); assert.equal(fb.context, 'Pre-season');

  // completing the action from the workspace: stale versions are refused, the right one wins, and it leaves the list
  const item = d.sections.next_actions.items.find((x) => x.kind === 'coach_action');
  assert.equal(item.can_complete, true);
  assert.equal((await patch(s.player.token, `/coaching/actions/${item.id}`, { row_version: item.row_version + 5, status: 'done' })).status, 409);
  ok(await patch(s.player.token, `/coaching/actions/${item.id}`, { row_version: item.row_version, status: 'done', completion_note: 'Watched it' }));
  assert.equal((await patch(s.player.token, `/coaching/actions/${item.id}`, { row_version: item.row_version, status: 'done' })).status, 409, 'a retry with the old version cannot overwrite');
  d = ok(await get(s.player.token, '/me/development'));
  assert.ok(!d.sections.next_actions.items.some((x) => x.kind === 'coach_action'));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM coaching_actions WHERE id=$1 AND status=$2', [act.id, 'done'])).rows[0].n, 1, 'the source record was updated, not copied');
});

test('paging one section is deterministic and the section filter returns only that section', async () => {
  const s = await setup();
  for (let k = 0; k < 5; k++) ok(await post(s.coach.token, '/coaching/goals', { athlete_id: s.player.id, title: `Goal ${k}`, athlete_text: `Text ${k}` }), 201);
  const a = ok(await get(s.player.token, '/me/development?section=goals&limit=2&offset=0')), b = ok(await get(s.player.token, '/me/development?section=goals&limit=2&offset=2')), c = ok(await get(s.player.token, '/me/development?section=goals&limit=2&offset=4'));
  assert.deepEqual(Object.keys(a.sections), ['goals']);
  const ids = [...a.sections.goals.items, ...b.sections.goals.items, ...c.sections.goals.items].map((g) => g.id);
  assert.equal(new Set(ids).size, 5); assert.equal(a.sections.goals.has_more, true); assert.equal(c.sections.goals.has_more, false);
  assert.deepEqual(ok(await get(s.player.token, '/me/development?section=goals&limit=2&offset=2')).sections.goals.items.map((g) => g.id), b.sections.goals.items.map((g) => g.id));
  assert.equal((await get(s.player.token, '/me/development?section=nope')).status, 400);
  assert.equal((await api('GET', '/me/development')).status, 401);
});

test('a young person: guardian reads the same items read-only, consent gates reads and mutations live, strangers are refused', async () => {
  const s = await setup();
  await s.consent('coaching');
  ok(await post(s.coach.token, '/coaching/goals', { athlete_id: s.kid.id, title: 'Scan', athlete_text: 'Look up' }), 201);
  const act = ok(await post(s.coach.token, '/coaching/actions', { athlete_id: s.kid.id, owner_id: s.kid.id, title: 'Stretch' }), 201);
  const rep = ok(await post(s.coach.token, '/coaching/reports', { athlete_id: s.kid.id, kind: 'athlete_progress', title: 'For parents', audience: 'guardian', from: '2026-01-01', to: today, narrative: 'Fine' }), 201);
  ok(await post(s.coach.token, `/coaching/reports/${rep.id}/publish`, { row_version: 1 }), 201);

  const mine = ok(await get(s.kid.token, '/me/development'));
  const theirs = ok(await get(s.parent.token, `/me/development?athlete_id=${s.kid.id}`));
  assert.equal(theirs.viewer, 'guardian');
  assert.deepEqual(theirs.sections.goals.items.map((g) => g.id), mine.sections.goals.items.map((g) => g.id), 'child and guardian see the same goals');
  assert.deepEqual(theirs.sections.reports.items.map((r) => r.title), ['For parents'], 'a guardian gets the guardian-audience report');
  assert.equal(mine.sections.reports.items.length, 0, 'and the child only reports published for the athlete');
  assert.equal(theirs.sections.next_actions.items[0].can_complete, false, 'a guardian cannot act for the child here');
  assert.equal((await get(s.stranger.token, `/me/development?athlete_id=${s.kid.id}`)).status, 403);
  assert.equal((await get(s.coach.token, `/me/development?athlete_id=${s.kid.id}`)).status, 403);
  assert.equal((await get(s.player.token, `/me/development?athlete_id=${s.kid.id}`)).status, 403);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='read_child_development'", [s.parent.id])).rows.length >= 1, 'guardian reads are audit-logged');

  // withdraw coaching consent: reads hide at once, and the child can no longer change the shared action
  await pool.query("UPDATE youth_consents SET revoked_at=now() WHERE child_id=$1 AND purpose='coaching'", [s.kid.id]);
  for (const r of [await get(s.kid.token, '/me/development'), await get(s.parent.token, `/me/development?athlete_id=${s.kid.id}`)]) {
    const b = ok(r); assert.equal(b.consent, false); assert.deepEqual(Object.keys(b.sections).filter((k) => !['my_goals', 'my_training'].includes(k)), [], 'no coach-sourced section while consent is off (only the young person\'s own goals and plans remain)'); assert.deepEqual(b.next_actions, []); assert.ok(b.note);
  }
  assert.equal((await patch(s.kid.token, `/coaching/actions/${act.id}`, { row_version: 1, status: 'done' })).status, 404);
  assert.equal((await pool.query('SELECT status FROM coaching_actions WHERE id=$1', [act.id])).rows[0].status, 'open', 'nothing changed while hidden');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM coaching_goals WHERE athlete_id=$1', [s.kid.id])).rows[0].n, 1, 'and nothing was deleted');

  // allow again: everything is back and the child can act
  await s.consent('coaching');
  assert.equal(ok(await get(s.kid.token, '/me/development')).sections.goals.items.length, 1);
  ok(await patch(s.kid.token, `/coaching/actions/${act.id}`, { row_version: 1, status: 'done' }));

  // a revoked guardian link ends guardian access
  await pool.query("UPDATE guardian_links SET status='revoked', revoked_at=now() WHERE guardian_id=$1", [s.parent.id]);
  assert.equal((await get(s.parent.token, `/me/development?athlete_id=${s.kid.id}`)).status, 403);
});

// ---- assessments: trial feedback and academy assessments, through the same rules as their own screens
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); return d.toISOString().slice(0, 10); };

test('shared trial assessments appear with their assessor; private ones and held-back ones never do', async () => {
  const org = await signup(['organizer']), assessor = await signup(['coach']), assessor2 = await signup(['coach']), p = await signup(['athlete']);
  const ev = ok(await post(org.token, '/events', { name: `Open trial ${++n}`, sport: 'football', kind: 'trial', starts_on: today, ends_on: today, capacity: 5 }), 201);
  await pool.query("UPDATE events SET status='open' WHERE id=$1", [ev.id]);
  const bk = ok(await post(p.token, `/trials/${ev.id}/book`, {}), 201);
  for (const a of [assessor, assessor2]) {
    const role = (await pool.query("INSERT INTO event_staff_roles(event_id, role, created_by) VALUES ($1,'assessor',$2) RETURNING id", [ev.id, org.id])).rows[0];
    await pool.query("INSERT INTO event_staff_assignments(role_id, event_id, user_id, status, invited_by) VALUES ($1,$2,$3,'accepted',$4)", [role.id, ev.id, a.id, org.id]);
  }
  ok(await post(assessor.token, `/trial-bookings/${bk.id}/attendance`, { status: 'present' }));
  ok(await post(assessor.token, `/trial-bookings/${bk.id}/assessment`, { rubric_ref: 'standard:fifa_technical', scores: { passing: 4, first_touch: 5 }, feedback: 'SHARED-TRIAL-FEEDBACK', share: 'now' }), 201);
  ok(await post(assessor2.token, `/trial-bookings/${bk.id}/assessment`, { rubric_ref: 'standard:fifa_technical', scores: { passing: 1 }, feedback: 'PRIVATE-TRIAL-FEEDBACK', share: 'private' }), 201);
  ok(await post(org.token, `/trial-bookings/${bk.id}/outcome`, { decision: 'second_trial', note: 'Come back' }));
  ok(await post(org.token, `/trial-bookings/${bk.id}/release`, {}));
  await pool.query("INSERT INTO trial_follow_ups(event_id, entry_id, athlete_id, kind, title, due_on, created_by) VALUES ($1,$2,$3,'review','Review your trial', current_date + 3, $4)", [ev.id, bk.id, p.id, org.id]);

  const d = ok(await get(p.token, '/me/development'));
  const a = d.sections.assessments.items;
  assert.equal(a.length, 1); assert.equal(a[0].text, 'SHARED-TRIAL-FEEDBACK'); assert.equal(a[0].by, assessor.display_name);
  assert.deepEqual([a[0].provenance.source, a[0].provenance.basis, a[0].provenance.record.type], ['trial_assessment', 'assessor_rated', 'trial_assessments']);
  assert.ok(!JSON.stringify(d).includes('PRIVATE-TRIAL-FEEDBACK'));
  assert.ok(d.sections.next_actions.items.some((x) => x.kind === 'trial_follow_up' && x.title === 'Review your trial'), 'a released follow-up is a next action');
});

test('approved academy assessments appear only with their athlete-visible comment; the unapproved and the staff-only comment never do', async () => {
  const mk = async () => { n++; const r = await api('POST', '/auth/register', { body: { handle: `pda_${n}`, display_name: `PDA ${n}`, email: `pda${n}@example.com`, password: 'correct-horse-battery', roles: ['athlete'], dob: yearsAgo(30) } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
  const owner = await mk(), coach = await mk(), ath = await mk();
  const org = ok(await post(owner.token, '/organisations', { name: `Dev Academy ${n}`, kind: 'academy' }), 201);
  ok(await patch(owner.token, `/organisations/${org.id}/academy`, { row_version: 0, sports: ['football'], currency: 'GBP', listed: true }));
  const prog = ok(await post(owner.token, `/organisations/${org.id}/academy/programmes`, { sport: 'football', title: `U12 ${n}`, capacity: 10, admission_mode: 'direct', public: true }), 201);
  const pub = ok(await post(owner.token, `/academy/programmes/${prog.id}/versions`, { row_version: prog.row_version, billing_model: 'free', currency: 'GBP' }), 201);
  await pool.query("INSERT INTO organisation_members(organisation_id, user_id, role, status, joined_at) VALUES ($1,$2,'coach','active',now())", [org.id, coach.id]);
  const enq = ok(await post(ath.token, `/academy/programmes/${pub.programme.id}/applications`, {}), 201);
  ok(await post(ath.token, `/academy/applications/${enq.id}/submit`, { row_version: enq.row_version, answers: {} }));
  await pool.query('UPDATE org_cohorts SET coach_id=$2 WHERE programme_id=$1', [pub.programme.id, coach.id]);
  const path = ok(await post(owner.token, `/organisations/${org.id}/academy/pathways`, { title: 'Outfield pathway', sport: 'football' }), 201);
  ok(await post(owner.token, `/academy/pathways/${path.id}/versions`, { row_version: 1, levels: [{ key: 'foundation', title: 'Foundation', position: 1 }, { key: 'development', title: 'Development', position: 2, prerequisites: ['foundation'] }] }), 201);
  ok(await post(coach.token, `/academy/pathways/${path.id}/decisions`, { athlete_id: ath.id, decision: 'place', expected_from_level: null, reason: 'Initial placement', idempotency_key: 'place-pd-01' }), 201);
  const mkA = async (comment, visibility) => ok(await post(coach.token, `/academy/pathways/${path.id}/assessments`, { athlete_id: ath.id, level_key: 'foundation', period_from: '2020-01-01', period_to: today, comment, comment_visibility: visibility }), 201);
  const shown = await mkA('ATHLETE-VISIBLE-COMMENT', 'athlete');
  ok(await post(owner.token, `/academy/assessments/${shown.id}/review`, { row_version: shown.row_version, action: 'approve' }));
  const staff = await mkA('STAFF-ONLY-COMMENT', 'staff');
  ok(await post(owner.token, `/academy/assessments/${staff.id}/review`, { row_version: staff.row_version, action: 'approve' }));
  await mkA('NOT-APPROVED-YET', 'athlete');

  const d = ok(await get(ath.token, '/me/development'));
  const items = d.sections.assessments.items.filter((x) => x.kind === 'academy_assessment');
  assert.equal(items.length, 2, 'both approved assessments are listed, the draft is not');
  assert.deepEqual(items.map((x) => x.text).sort((a, b) => String(a).localeCompare(String(b))), ['ATHLETE-VISIBLE-COMMENT', null]);
  assert.ok(!JSON.stringify(d).includes('STAFF-ONLY') && !JSON.stringify(d).includes('NOT-APPROVED'));
  assert.equal(items[0].provenance.basis, 'assessor_rated'); assert.equal(items[0].by, org.name);
  assert.ok(d.sections.next_actions.items.some((x) => x.kind === 'academy_review'), 'the next academy review date is shown');
});
