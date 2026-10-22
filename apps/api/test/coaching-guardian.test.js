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
  const r = await api('POST', '/auth/register', { body: { handle: `cg2_${n}_${roles[0]}`, display_name: `CG2 Person${n}`, email: `cg2${n}@example.com`, password: 'correct-horse-battery', roles } });
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
after(async () => { server.close(); await pool.end(); });

// a young player on a team, a verified guardian, and the participation consent teams already need
const setup = async () => {
  const coach = await signup(['coach']), kid = await signup(['athlete']), parent = await signup(['athlete']), stranger = await signup(['athlete']);
  const team = ok(await post(coach.token, '/teams', { name: `Youth FC ${n}`, sport: 'football' }), 201);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'coach','active') ON CONFLICT (team_id, user_id) DO UPDATE SET role='coach', status='active'", [team.id, coach.id]);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [team.id, kid.id]);
  await pool.query('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);
  await pool.query("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [parent.id, kid.id]);
  const consent = (purpose) => pool.query("INSERT INTO youth_consents(child_id, purpose, granted_by, policy_version, expires_at) VALUES ($1,$2,$3,1, now() + interval '30 days') ON CONFLICT (child_id, purpose) DO UPDATE SET revoked_at=NULL, expires_at=now() + interval '30 days'", [kid.id, purpose, parent.id]);
  await consent('participation');
  return { coach, kid, parent, stranger, team, consent };
};

test('sharing coaching records about a young person needs the guardian\'s coaching consent; private notes need none', async () => {
  const s = await setup();
  ok(await post(s.coach.token, '/coaching/observations', { athlete_id: s.kid.id, note: 'private is fine without it' }), 201);
  const refused = await post(s.coach.token, '/coaching/observations', { athlete_id: s.kid.id, note: 'shared', visibility: 'player' });
  assert.equal(refused.status, 409); assert.equal(refused.body.error.details?.code ?? refused.body.error.code, 'guardian_consent_required');
  assert.equal((await post(s.coach.token, '/coaching/goals', { athlete_id: s.kid.id, title: 'Goal', athlete_text: 'Show them' })).status, 409);
  assert.equal((await post(s.coach.token, '/coaching/actions', { athlete_id: s.kid.id, owner_id: s.kid.id, title: 'Act' })).status, 409);
  { const r = await post(s.coach.token, '/coaching/reports', { athlete_id: s.kid.id, kind: 'athlete_progress', title: 'Report', audience: 'athlete', from: '2026-01-01', to: today }); assert.equal(r.status, 409, JSON.stringify(r.body)); }
  ok(await post(s.coach.token, '/coaching/goals', { athlete_id: s.kid.id, title: 'Private goal' }), 201);
  await s.consent('coaching');
  ok(await post(s.coach.token, '/coaching/observations', { athlete_id: s.kid.id, note: 'Well played', visibility: 'player' }), 201);
});

test('the guardian sees exactly what the child sees, only while consent stands; withdrawing hides it everywhere and allowing it again restores it', async () => {
  const s = await setup();
  await s.consent('coaching');
  const shared = ok(await post(s.coach.token, '/coaching/observations', { athlete_id: s.kid.id, note: 'SHARED-NOTE', visibility: 'player' }), 201);
  ok(await post(s.coach.token, '/coaching/observations', { athlete_id: s.kid.id, note: 'PRIVATE-NOTE' }), 201);
  ok(await post(s.coach.token, '/coaching/goals', { athlete_id: s.kid.id, title: 'Scan', athlete_text: 'Look up' }), 201);
  ok(await post(s.coach.token, '/coaching/goals', { athlete_id: s.kid.id, title: 'SECRET-GOAL' }), 201);
  ok(await post(s.coach.token, '/coaching/actions', { athlete_id: s.kid.id, owner_id: s.kid.id, title: 'Shared action' }), 201);
  const rep = ok(await post(s.coach.token, '/coaching/reports', { athlete_id: s.kid.id, kind: 'athlete_progress', title: 'For parents', audience: 'guardian', from: '2026-01-01', to: today, narrative: 'Doing well' }), 201);
  ok(await post(s.coach.token, `/coaching/reports/${rep.id}/publish`, { row_version: 1 }), 201);

  const g = ok(await get(s.parent.token, `/guardian/children/${s.kid.id}/coaching`));
  assert.equal(g.consent, true);
  assert.deepEqual(g.notes.map((x) => x.id), [shared.id]);
  assert.deepEqual(g.goals.map((x) => x.text), ['Look up']);
  assert.equal(g.actions.length, 1); assert.equal(g.reports.length, 1);
  assert.ok(!JSON.stringify(g).includes('PRIVATE') && !JSON.stringify(g).includes('SECRET'));
  const mine = ok(await get(s.kid.token, '/me/coaching-notes'));
  assert.deepEqual(mine.map((x) => x.id), g.notes.map((x) => x.id), 'child and guardian see the same items');
  assert.equal((await get(s.parent.token, `/coaching/reports/${rep.id}/versions/1`)).status, 200);
  assert.equal((await get(s.stranger.token, `/guardian/children/${s.kid.id}/coaching`)).status, 403);
  assert.equal((await get(s.coach.token, `/guardian/children/${s.kid.id}/coaching`)).status, 403);

  // withdraw: hidden for everyone, data kept
  await pool.query("UPDATE youth_consents SET revoked_at=now() WHERE child_id=$1 AND purpose='coaching'", [s.kid.id]);
  const hidden = ok(await get(s.parent.token, `/guardian/children/${s.kid.id}/coaching`));
  assert.equal(hidden.consent, false); assert.deepEqual(hidden.notes, []);
  assert.deepEqual(ok(await get(s.kid.token, '/me/coaching-notes')), []);
  assert.deepEqual(ok(await get(s.kid.token, '/me/coaching-goals')), []);
  assert.deepEqual(ok(await get(s.kid.token, '/me/coaching-reports')), []);
  assert.equal((await get(s.kid.token, `/coaching/reports/${rep.id}/versions/1`)).status, 404);
  assert.equal((await get(s.parent.token, `/coaching/reports/${rep.id}/versions/1`)).status, 404);
  assert.equal(ok(await get(s.coach.token, `/coaching/reports/${rep.id}/versions/1`)).version, 1, 'the coach\'s own record is untouched');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM coaching_observations WHERE athlete_id=$1', [s.kid.id])).rows[0].n, 2);
  assert.equal((await post(s.coach.token, '/coaching/observations', { athlete_id: s.kid.id, note: 'new share', visibility: 'player' })).status, 409, 'and nothing new can be shared');
  await s.consent('coaching');
  assert.equal(ok(await get(s.kid.token, '/me/coaching-notes')).length, 1, 'allowing it again restores what was shared');
});

test('a revoked guardian link ends guardian access; adults are unaffected by the youth rules', async () => {
  const s = await setup();
  await s.consent('coaching');
  ok(await post(s.coach.token, '/coaching/observations', { athlete_id: s.kid.id, note: 'shared', visibility: 'player' }), 201);
  await pool.query("UPDATE guardian_links SET status='revoked', revoked_at=now() WHERE guardian_id=$1", [s.parent.id]);
  assert.equal((await get(s.parent.token, `/guardian/children/${s.kid.id}/coaching`)).status, 403);
  const adult = await signup(['athlete']);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [s.team.id, adult.id]);
  ok(await post(s.coach.token, '/coaching/observations', { athlete_id: adult.id, note: 'adult shared', visibility: 'player' }), 201);
  assert.equal(ok(await get(adult.token, '/me/coaching-notes')).length, 1);
});
