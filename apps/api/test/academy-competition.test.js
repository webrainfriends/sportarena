import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { capabilities } = await import('../src/registry.js');

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
  const r = await api('POST', '/auth/register', { body: { handle: `cp_${n}_${roles[0]}`, display_name: `Comp ${n}`, email: `cp${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const day = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);

before(async () => { await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); await migrate(); server = createApp().listen(0); base = `http://localhost:${server.address().port}`; });
after(async () => { server.close(); await pool.end(); });

/** An academy (owner, coach, scheduler without roster access), a cohort, a canonical team of the academy with players, an event it is entered in, and a fixture. */
async function setup() {
  const owner = await signup(['venue_manager']), coach = await signup(['coach']), ops = await signup(), stranger = await signup(), p1 = await signup(), p2 = await signup();
  const org = ok(await api('POST', '/organisations', { token: owner.token, body: { name: `Comp Academy ${n}`, kind: 'academy', city: 'Madrid' } }), 201);
  const join = async (u, role) => { ok(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role } }), 201); ok(await api('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } })); };
  await join(coach, 'coach'); await join(ops, 'staff');
  ok(await api('POST', `/organisations/${org.id}/academy/staff/${ops.id}`, { token: owner.token, body: { job_title: 'Scheduler', template: 'custom', permissions: ['schedule'] } }));
  const cohort = ok(await api('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: `U16 ${n}`, coach_id: coach.id } }), 201);
  const sport = (await pool.query('SELECT id FROM sports LIMIT 1')).rows[0].id;
  const team = (await pool.query('INSERT INTO teams(name,sport_id,owner_id,organisation_id) VALUES ($1,$2,$3,$4) RETURNING id', [`U16 Boys ${n}`, sport, owner.id, org.id])).rows[0];
  const rival = (await pool.query('INSERT INTO teams(name,sport_id,owner_id) VALUES ($1,$2,$3) RETURNING id', [`Rival ${n}`, sport, stranger.id])).rows[0];
  for (const [u, r] of [[p1, 'player'], [p2, 'player'], [coach, 'coach']]) await pool.query('INSERT INTO team_members(team_id,user_id,role) VALUES ($1,$2,$3)', [team.id, u.id, r]);
  const ev = (await pool.query('INSERT INTO events(name,sport_id,organizer_id,starts_on,ends_on,status) VALUES ($1,$2,$3,$4,$5,\'open\') RETURNING id', [`Regional Cup ${n}`, sport, owner.id, day(10), day(11)])).rows[0];
  await pool.query("INSERT INTO event_entries(event_id,team_id,status) VALUES ($1,$2,'accepted'),($1,$3,'accepted')", [ev.id, team.id, rival.id]);
  const when = `${day(10)}T10:00:00Z`;
  const fx = (await pool.query('INSERT INTO fixtures(event_id,home_team_id,away_team_id,scheduled_at) VALUES ($1,$2,$3,$4) RETURNING id', [ev.id, team.id, rival.id, when])).rows[0];
  return { owner, coach, ops, stranger, p1, p2, org, cohort, team, rival, ev, fx, when };
}
const mkPlan = async (g, extra = {}) => ok(await api('POST', `/organisations/${g.org.id}/season-plans`, { token: g.owner.token, body: { name: 'Season 2026-27', starts_on: day(0), ends_on: day(200), ...extra } }), 201);
const addEntry = (g, plan, body = {}) => api('POST', `/season-plans/${plan.id}/entries`, { token: g.owner.token, body: { team_id: g.team.id, fixture_id: g.fx.id, cohort_id: g.cohort.id, age_group: 'U16', ...body } });

test('every capability is exposed over REST/OpenAPI and MCP from one definition', () => {
  for (const name of ['create_season_plan', 'list_season_plans', 'get_season_plan', 'set_season_plan_status', 'add_plan_entry', 'remove_plan_entry', 'set_plan_objective', 'set_plan_checklist_item', 'set_plan_committee', 'decide_plan_approval', 'get_plan_calendar', 'check_plan_conflicts', 'publish_plan_squad', 'get_participation_review', 'get_event_academy_plans'])
    assert.ok(capabilities.find((c) => c.name === name), name);
});

test('plan: create is idempotent, validated and scoped; outsiders get 404; a plan needs a real team/fixture and never copies them', async () => {
  const g = await setup();
  assert.equal((await api('POST', `/organisations/${g.org.id}/season-plans`, { token: g.owner.token, body: { name: 'Bad', starts_on: day(5), ends_on: day(1) } })).status, 400);
  assert.equal((await api('POST', `/organisations/${g.org.id}/season-plans`, { token: g.stranger.token, body: { name: 'XX', starts_on: day(0), ends_on: day(1) } })).status, 404);
  const p = await mkPlan(g);
  assert.equal((await mkPlan(g)).replayed, true, 'same name replays');
  assert.equal((await api('GET', `/season-plans/${p.id}`, { token: g.stranger.token })).status, 404);
  assert.equal((await addEntry(g, p, { team_id: g.rival.id })).status, 404, 'a team of another organisation');
  assert.equal((await addEntry(g, p, { fixture_id: undefined, event_id: undefined })).status, 400);
  const e = ok(await addEntry(g, p), 201);
  assert.equal((await addEntry(g, p)).body.replayed, true, 'no duplicate entry');
  assert.equal((await pool.query('SELECT count(*)::int n FROM fixtures')).rows[0].n, 1, 'no fixture was created');
  const got = ok(await api('GET', `/season-plans/${p.id}`, { token: g.owner.token }));
  assert.equal(got.entries.length, 1); assert.equal(got.metrics.checklist_total, 7);
  ok(await api('DELETE', `/season-plans/${p.id}/entries/${e.id}`, { token: g.owner.token }));
  assert.equal((await pool.query('SELECT 1 FROM academy_plan_entries WHERE id=$1', [e.id])).rowCount, 1, 'soft removal keeps the row');
});

test('conflicts: training vs match, venue and guardian consent are surfaced; blocking ones stop publishing the squad and the plan', async () => {
  const g = await setup();
  const p = await mkPlan(g);
  const e = ok(await addEntry(g, p), 201);
  assert.equal(ok(await api('GET', `/season-plans/${p.id}/conflicts`, { token: g.owner.token })).items.length, 0);
  await pool.query("INSERT INTO academy_sessions(organisation_id,cohort_id,title,starts_at,ends_at,status) VALUES ($1,$2,'Skills block',$3,$4,'published')", [g.org.id, g.cohort.id, `${day(10)}T10:30:00Z`, `${day(10)}T11:30:00Z`]);
  const c = ok(await api('GET', `/season-plans/${p.id}/conflicts`, { token: g.owner.token }));
  assert.equal(c.blocking, 1); assert.equal(c.items[0].code, 'training_vs_match');
  const members = [{ user_id: g.p1.id, role: 'player' }];
  const blocked = await api('POST', `/season-plans/${p.id}/entries/${e.id}/publish-squad`, { token: g.owner.token, body: { members } });
  assert.equal(blocked.status, 409); assert.ok(blocked.body.error?.details?.conflicts ?? JSON.stringify(blocked.body).includes('training_vs_match'));
  assert.equal((await api('POST', `/season-plans/${p.id}/status`, { token: g.owner.token, body: { status: 'review' } })).status, 200);
  ok(await api('POST', `/season-plans/${p.id}/status`, { token: g.owner.token, body: { status: 'committee' } }));
  assert.equal((await api('POST', `/season-plans/${p.id}/status`, { token: g.owner.token, body: { status: 'published' } })).status, 409, 'blocking conflict stops publishing');
  assert.equal((await api('POST', `/season-plans/${p.id}/status`, { token: g.owner.token, body: { status: 'draft' } })).status, 409, 'illegal transition');
});

test('squad publish goes through Team set_squad (no shadow roster), needs committee approval and roster access', async () => {
  const g = await setup();
  const p = await mkPlan(g);
  const e = ok(await addEntry(g, p), 201);
  const members = [{ user_id: g.p1.id, role: 'player' }, { user_id: g.p2.id, role: 'player' }];
  assert.equal((await api('POST', `/season-plans/${p.id}/entries/${e.id}/publish-squad`, { token: g.ops.token, body: { members } })).status, 404, 'scheduler without roster access');
  assert.equal((await api('POST', `/season-plans/${p.id}/entries/${e.id}/committee`, { token: g.owner.token, body: { members: [{ user_id: g.stranger.id, seat: 'other' }] } })).status, 400, 'non-members cannot sit');
  ok(await api('POST', `/season-plans/${p.id}/entries/${e.id}/committee`, { token: g.owner.token, body: { members: [{ user_id: g.owner.id, seat: 'academy_director' }, { user_id: g.coach.id, seat: 'head_coach' }] } }));
  const pending = await api('POST', `/season-plans/${p.id}/entries/${e.id}/publish-squad`, { token: g.owner.token, body: { members } });
  assert.equal(pending.status, 409);
  assert.equal((await api('POST', `/season-plans/${p.id}/entries/${e.id}/approval`, { token: g.stranger.token, body: { decision: 'approved', evidence: 'criteria met' } })).status, 404, 'not a committee member');
  ok(await api('POST', `/season-plans/${p.id}/entries/${e.id}/approval`, { token: g.owner.token, body: { decision: 'approved', evidence: 'Criteria: availability, load, form' } }));
  ok(await api('POST', `/season-plans/${p.id}/entries/${e.id}/approval`, { token: g.coach.token, body: { decision: 'approved', evidence: 'Reviewed attendance and load summary' } }));
  assert.ok((await pool.query('SELECT evidence_enc FROM academy_plan_approvals LIMIT 1')).rows[0].evidence_enc.length > 0);
  assert.ok(!(await pool.query('SELECT evidence_enc FROM academy_plan_approvals LIMIT 1')).rows[0].evidence_enc.includes('criteria'), 'evidence is encrypted at rest');
  const pub = ok(await api('POST', `/season-plans/${p.id}/entries/${e.id}/publish-squad`, { token: g.owner.token, body: { members } }));
  assert.equal(pub.published, true);
  const sq = (await pool.query('SELECT user_id,status FROM team_squads WHERE team_id=$1 AND fixture_id=$2', [g.team.id, g.fx.id])).rows;
  assert.equal(sq.length, 2, 'the squad lives in team_squads');
  assert.equal((await pool.query("SELECT count(*)::int n FROM information_schema.tables WHERE table_name LIKE 'academy_plan%' AND table_name LIKE '%squad%'")).rows[0].n, 0, 'no shadow roster table');
  const strip = ok(await api('GET', `/events/${g.ev.id}/academy-plans`, { token: g.owner.token }));
  assert.equal(strip.items.length, 1); assert.ok(strip.items[0].squad_published_at);
  assert.equal(ok(await api('GET', `/events/${g.ev.id}/academy-plans`, { token: g.stranger.token })).items.length, 0, 'invisible to outsiders');
});

test('checklist, objectives and the participation review: provenance retained, no ranking, reads audited', async () => {
  const g = await setup();
  const p = await mkPlan(g);
  const e = ok(await addEntry(g, p), 201);
  assert.equal((await api('POST', `/season-plans/${p.id}/entries/${e.id}/checklist`, { token: g.owner.token, body: { code: 'kit', state: 'waived' } })).status, 400, 'waiver needs a reason');
  ok(await api('POST', `/season-plans/${p.id}/entries/${e.id}/checklist`, { token: g.owner.token, body: { code: 'medical_clearance', state: 'done', evidence: 'Physio sign-off 3 Nov' } }));
  assert.equal(ok(await api('GET', `/season-plans/${p.id}`, { token: g.owner.token })).metrics.checklist_done, 1);
  assert.equal((await api('POST', `/season-plans/${p.id}/objectives`, { token: g.owner.token, body: { metric: 'min_fixture_share_pct', target: 150 } })).status, 400);
  ok(await api('POST', `/season-plans/${p.id}/objectives`, { token: g.owner.token, body: { metric: 'min_fixture_share_pct', target: 60, team_id: g.team.id } }), 201);
  await pool.query("UPDATE fixtures SET status='completed' WHERE id=$1", [g.fx.id]);
  await pool.query("INSERT INTO team_squads(team_id,fixture_id,event_id,user_id,role,status,selected_by) VALUES ($1,$2,$3,$4,'player','confirmed',$5),($1,$2,$3,$6,'player','confirmed',$5)", [g.team.id, g.fx.id, g.ev.id, g.p1.id, g.owner.id, g.p2.id]);
  await pool.query("INSERT INTO match_appearances(fixture_id,team_id,user_id,status,minutes_played,minutes_basis,source,authority) VALUES ($1,$2,$3,'started',70,'official_sheet','official_sheet',40)", [g.fx.id, g.team.id, g.p1.id]);
  assert.equal((await api('GET', `/season-plans/${p.id}/participation`, { token: g.ops.token })).status, 404, 'scheduler without roster access');
  const r = ok(await api('GET', `/season-plans/${p.id}/participation`, { token: g.owner.token }));
  const t = r.teams[0];
  assert.equal(t.ranked, false); assert.equal(t.completed_fixtures, 1);
  const a1 = t.athletes.find((a) => a.user_id === g.p1.id), a2 = t.athletes.find((a) => a.user_id === g.p2.id);
  assert.equal(a1.minutes, 70); assert.equal(a1.provenance[0].source, 'official_sheet'); assert.equal(a1.below_objective, false);
  assert.equal(a2.below_objective, true, 'did not feature: below the 60% objective');
  assert.deepEqual(t.athletes.map((a) => a.display_name), [...t.athletes.map((a) => a.display_name)].sort(), 'alphabetical, never by performance');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='read_participation_review'")).rowCount >= 1);
});

test('candidates feed the pickers from live records and are hidden from outsiders', async () => {
  const g = await setup();
  const p = await mkPlan(g);
  const c = ok(await api('GET', `/season-plans/${p.id}/candidates`, { token: g.owner.token }));
  assert.equal(c.teams.length, 1); assert.equal(c.teams[0].members.length, 3); assert.equal(c.fixtures.length, 1); assert.equal(c.events.length, 1); assert.equal(c.cohorts.length, 1);
  assert.equal((await api('GET', `/season-plans/${p.id}/candidates`, { token: g.stranger.token })).status, 404);
});
