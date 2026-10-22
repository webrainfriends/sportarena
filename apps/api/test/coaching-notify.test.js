import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { queueCoachingReminders } = await import('../src/coaching-notify.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
let n = 0;
const signup = async (roles, admin) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `cn_${n}_${roles[0]}`, display_name: `CN Person${n}`, email: `cn${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const post = (t, p, body) => api('POST', p, { token: t, body });
const inbox = async (u) => ok(await api('GET', '/notifications', { token: u.token }));

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const setup = async () => {
  const coach = await signup(['coach']), arjun = await signup(['athlete']);
  const team = ok(await post(coach.token, '/teams', { name: `Notify FC ${n}`, sport: 'football' }), 201);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'coach','active') ON CONFLICT (team_id, user_id) DO UPDATE SET role='coach', status='active'", [team.id, coach.id]);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [team.id, arjun.id]);
  return { coach, arjun, team };
};
const kinds = (list) => (Array.isArray(list) ? list : list.items ?? list.notifications ?? []).map((x) => x.kind);

test('assigning a shared action tells the athlete without revealing its content; finishing it tells the coach', async () => {
  const s = await setup();
  const a = ok(await post(s.coach.token, '/coaching/actions', { athlete_id: s.arjun.id, owner_id: s.arjun.id, title: 'SECRET-ACTION-TITLE', detail: 'SECRET-DETAIL' }), 201);
  const list = await inbox(s.arjun);
  const mine = (Array.isArray(list) ? list : list.items ?? []).filter((x) => x.kind === 'coaching_action_assigned');
  assert.equal(mine.length, 1);
  assert.ok(!JSON.stringify(mine).includes('SECRET'), 'no content in the notification');
  // coach-owned and unshared: nobody is told
  ok(await post(s.coach.token, '/coaching/actions', { athlete_id: s.arjun.id, title: 'private to coach' }), 201);
  assert.equal(kinds(await inbox(s.arjun)).filter((k) => k === 'coaching_action_assigned').length, 1);
  ok(await api('PATCH', `/coaching/actions/${a.id}`, { token: s.arjun.token, body: { row_version: 1, status: 'done' } }));
  const coachBox = kinds(await inbox(s.coach));
  assert.ok(coachBox.includes('coaching_action_done'));
  assert.ok(!JSON.stringify(await inbox(s.coach)).includes('SECRET'));
});

test('scheduled reminders: due soon, overdue, goal review, session review, match debrief - once each, generic wording, muted kinds respected', async () => {
  const s = await setup();
  const soon = ok(await post(s.coach.token, '/coaching/actions', { athlete_id: s.arjun.id, title: 'SECRET-SOON', due_at: new Date(Date.now() + 6 * 3600e3).toISOString() }), 201);
  ok(await post(s.coach.token, '/coaching/actions', { athlete_id: s.arjun.id, title: 'SECRET-LATE', due_at: new Date(Date.now() - 3600e3).toISOString() }), 201);
  ok(await post(s.coach.token, '/coaching/goals', { athlete_id: s.arjun.id, title: 'SECRET-GOAL', review_on: new Date(Date.now() + 86400e3).toISOString().slice(0, 10) }), 201);
  const rec = ok(await post(s.coach.token, '/coaching/sessions', { source_type: 'team_session', source_id: randomUUID(), team_id: s.team.id, title: 'SECRET-SESSION' }), 201);
  ok(await post(s.coach.token, `/coaching/sessions/${rec.id}/complete`, { id: rec.id }));
  await pool.query("UPDATE coaching_session_records SET ended_at = now() - interval '2 days' WHERE id=$1", [rec.id]);
  const other = ok(await post(s.coach.token, '/teams', { name: `Rival ${n}`, sport: 'football' }), 201);
  const { rows: [sp] } = await pool.query("SELECT id FROM sports WHERE slug='football'");
  const { rows: [ev] } = await pool.query("INSERT INTO events(name, sport_id, organizer_id) VALUES ('Cup',$1,$2) RETURNING id", [sp.id, s.coach.id]);
  await pool.query("INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at, status, home_score, away_score) VALUES ($1,$2,$3, now() - interval '1 day','completed',1,0)", [ev.id, s.team.id, other.id]);
  assert.ok(await queueCoachingReminders() >= 5);
  const first = kinds(await inbox(s.coach));
  for (const k of ['coaching_action_overdue', 'coaching_goal_review', 'coaching_review_due', 'coaching_debrief_due', 'coaching_action_due']) assert.ok(first.includes(k), k);
  assert.ok(!JSON.stringify(await inbox(s.coach)).match(/SECRET/), 'reminders never carry content');
  await queueCoachingReminders();
  assert.deepEqual(kinds(await inbox(s.coach)).sort(), first.sort(), 'a second tick adds nothing');
  // filing the review ends that reminder source
  ok(await post(s.coach.token, `/coaching/sessions/${rec.id}/review`, { team_summary: 'Good tempo' }));
  const reviewed = (await pool.query('SELECT reviewed_at FROM coaching_session_records WHERE id=$1', [rec.id])).rows[0];
  assert.ok(reviewed.reviewed_at);
  // muted kinds are respected
  ok(await api('PATCH', '/me/notification-preferences', { token: s.arjun.token, body: { muted_kinds: ['coaching_action_assigned'] } }));
  ok(await post(s.coach.token, '/coaching/actions', { athlete_id: s.arjun.id, owner_id: s.arjun.id, title: 'muted one' }), 201);
  assert.equal(kinds(await inbox(s.arjun)).filter((k) => k === 'coaching_action_assigned').length, 0);
});

test('publishing a report notifies its audience only, without content; usage metrics are aggregate-only and admin-only', async () => {
  const s = await setup();
  const r = ok(await post(s.coach.token, '/coaching/reports', { athlete_id: s.arjun.id, kind: 'athlete_progress', title: 'SECRET-REPORT-TITLE', audience: 'athlete', from: '2026-01-01', to: new Date().toISOString().slice(0, 10), narrative: 'SECRET-NARRATIVE' }), 201);
  ok(await post(s.coach.token, `/coaching/reports/${r.id}/publish`, { row_version: 1 }), 201);
  const box = await inbox(s.arjun);
  assert.ok(kinds(box).includes('coaching_report_published'));
  assert.ok(!JSON.stringify(box).includes('SECRET'));
  const stranger = await signup(['athlete']);
  assert.ok(!kinds(await inbox(stranger)).includes('coaching_report_published'));
  assert.equal((await api('GET', '/admin/coaching-usage', { token: s.coach.token })).status, 403);
  const admin = await signup(['athlete']);
  await pool.query("UPDATE users SET roles='{admin}' WHERE id=$1", [admin.id]);
  const m = ok(await api('GET', '/admin/coaching-usage', { token: admin.token }));
  assert.ok(m.reports.versions_published >= 1);
  assert.ok(!JSON.stringify(m).includes('SECRET'));
  assert.ok(!JSON.stringify(m).match(/[0-9a-f]{8}-[0-9a-f]{4}/), 'no ids, nothing per person');
});
