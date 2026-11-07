// Academy OS P1 (#800): promotion, squad transfer and graduation workflow. Every action is done by the canonical capability; a run never claims success early,
// retries never double up, graduation needs a final human approval, and the athlete, coach and staff each see only their own view.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base, n = 0;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const must = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const today = new Date().toISOString().slice(0, 10);
const key = () => `k-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const dob = new Date(Date.now() - 30 * 365.25 * 864e5).toISOString().slice(0, 10);
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `cl_${n}_${roles[0]}`, display_name: `Cl ${n}`, email: `cl${n}@example.com`, password: 'correct-horse-battery', roles, dob } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

/** An academy with an owner, finance and a coach, one published programme and one cohort linked to it. */
async function academy(title = 'U12 Football') {
  const owner = await signup(), finance = await signup(), coach = await signup(['coach']);
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Closeout ${++n}`, kind: 'academy' } }), 201);
  must(await api('PATCH', `/organisations/${org.id}/academy`, { token: owner.token, body: { row_version: 0, sports: ['football'], currency: 'INR', listed: true } }));
  for (const [u, role] of [[finance, 'finance'], [coach, 'coach']]) {
    must(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role } }), 201);
    must(await api('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } }));
  }
  const prog = must(await api('POST', `/organisations/${org.id}/academy/programmes`, { token: owner.token, body: { sport: 'football', title, capacity: 20, admission_mode: 'direct', public: true } }), 201);
  const cohort = must(await api('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: `${title} cohort`, coach_id: coach.id } }), 201);
  await pool.query('UPDATE org_cohorts SET programme_id=$2 WHERE id=$1', [cohort.id, prog.id]);
  return { owner, finance, coach, org, programme: prog, cohort };
}
const { expireAcademyPromotions } = await import('../src/academy-sweeps.js');

let seq = 0;
async function decided(a, decision, { status = 'enrolled' } = {}) {
  const ath = await signup();
  const e = (await pool.query('INSERT INTO org_enrolments(cohort_id, user_id, status, programme_id, consent_at, enrolled_by) VALUES ($1,$2,$3,$4,now(),$5) RETURNING *', [a.cohort.id, ath.id, status, a.programme.id, a.owner.id])).rows[0];
  const pw = (await pool.query("INSERT INTO academy_pathways(organisation_id, sport, title, status, current_version, created_by) VALUES ($1,'football','Pathway','active',1,$2) RETURNING *", [a.org.id, a.owner.id])).rows[0];
  const v = (await pool.query("INSERT INTO academy_pathway_versions(pathway_id, version, levels, created_by) VALUES ($1,1,'[]',$2) RETURNING *", [pw.id, a.owner.id])).rows[0];
  const d = (await pool.query("INSERT INTO academy_progression_decisions(organisation_id, athlete_id, pathway_id, version_id, decision, from_level, to_level, reason, decided_by, idempotency_key, criteria_snapshot) VALUES ($1,$2,$3,$4,$5,'u12','u14','because',$6,$7,'{\"outcome\":\"criteria_met\"}') RETURNING *", [a.org.id, ath.id, pw.id, v.id, decision, a.owner.id, `k${++seq}-${Date.now()}`])).rows[0];
  return { ath, enrolment: e, decision: d };
}
const cohortOf = async (a, name, capacity) => { const k = must(await api('POST', `/organisations/${a.org.id}/cohorts`, { token: a.owner.token, body: { name } }), 201); await pool.query('UPDATE org_cohorts SET programme_id=$2, capacity=$3 WHERE id=$1', [k.id, a.programme.id, capacity ?? null]); return k; };
const plan = (a, d, body, who = a.owner) => api('POST', `/academy/decisions/${d.id}/promotion`, { token: who.token, body });
const approve = (r, who, stage = 'plan') => api('POST', `/academy/promotions/${r.id}/approve`, { token: who.token, body: { stage, row_version: r.row_version } });
const live = (uid, cid) => pool.query("SELECT count(*)::int AS n FROM org_enrolments WHERE user_id=$1 AND cohort_id=$2 AND status='enrolled'", [uid, cid]).then((r) => r.rows[0].n);

test('promotion: pre-flight blocks a full group; approval moves the athlete once and invites to the squad; the athlete\'s own answer completes it', async () => {
  const a = await academy();
  const g = await decided(a, 'promote');
  const to = await cohortOf(a, 'U14', 1);
  await pool.query("INSERT INTO org_enrolments(cohort_id, user_id, status, programme_id, consent_at, enrolled_by) VALUES ($1,$2,'enrolled',$3,now(),$4)", [to.id, (await signup()).id, a.programme.id, a.owner.id]);
  const team = must(await api('POST', '/teams', { token: a.owner.token, body: { name: 'Academy Squad', sport: 'football' } }), 201);
  assert.equal((await plan(a, g.decision, { enrolment_id: g.enrolment.id, to_cohort_id: to.id }, a.coach)).status, 403, 'coaches recommend; staff carry out');
  const p = must(await plan(a, g.decision, { enrolment_id: g.enrolment.id, to_cohort_id: to.id, team_id: team.id }), 201);
  assert.equal(p.status, 'pending_approval');
  assert.ok(p.checks.find((x) => x.key === 'capacity' && x.status === 'fail'), 'a full destination is a failing check');
  assert.equal(p.id, must(await plan(a, g.decision, { enrolment_id: g.enrolment.id, to_cohort_id: to.id, team_id: team.id }), 201).id, 'one decision, one run');
  assert.equal((await approve(p, a.owner)).status, 409, 'cannot approve past a failing check');
  assert.equal(await live(g.ath.id, to.id), 0, 'nothing moved');

  await pool.query('UPDATE org_cohorts SET capacity=5 WHERE id=$1', [to.id]);
  const ok = must(await approve(p, a.owner));
  assert.equal(ok.status, 'awaiting_acceptance', 'moved and invited; the athlete still has to accept');
  assert.equal(await live(g.ath.id, to.id), 1);
  assert.equal((await pool.query("SELECT status FROM org_enrolments WHERE id=$1", [g.enrolment.id])).rows[0].status, 'transferred');
  assert.equal((await pool.query('SELECT status FROM team_members WHERE team_id=$1 AND user_id=$2', [team.id, g.ath.id])).rows[0].status, 'invited');
  assert.equal((await approve(p, a.owner)).status, 409, 'a stale approval changes nothing');
  assert.equal(must(await api('POST', `/academy/promotions/${p.id}/advance`, { token: a.owner.token })).status, 'awaiting_acceptance');
  assert.equal(await live(g.ath.id, to.id), 1, 'advancing again never moves twice');

  must(await api('POST', `/teams/${team.id}/invitations/respond`, { token: g.ath.token, body: { accept: true } }));
  const done = must(await api('POST', `/academy/promotions/${p.id}/advance`, { token: a.owner.token }));
  assert.equal(done.status, 'completed');
  assert.ok(done.steps.every((s) => s.state === 'done'));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM org_enrolments WHERE user_id=$1', [g.ath.id])).rows[0].n, 2, 'old record kept as transferred, one new live one: no duplicate');
});

test('promotion: a failing step leaves the run partial, never completed; rollback moves the athlete back and keeps the history', async () => {
  const a = await academy();
  const g = await decided(a, 'promote');
  const to = await cohortOf(a, 'U14b', 10);
  const stranger = await signup();
  const team = must(await api('POST', '/teams', { token: stranger.token, body: { name: 'Not ours', sport: 'football' } }), 201);
  const p = must(await plan(a, g.decision, { enrolment_id: g.enrolment.id, to_cohort_id: to.id, team_id: team.id }), 201);
  const r = must(await approve(p, a.owner));
  assert.equal(r.status, 'partial', 'the invitation failed (the academy does not manage that team)');
  assert.equal(r.steps.find((s) => s.kind === 'cohort_transfer').state, 'done');
  assert.equal(r.steps.find((s) => s.kind === 'squad_invite').state, 'failed');
  assert.equal(await live(g.ath.id, to.id), 1);
  const rb = must(await api('POST', `/academy/promotions/${p.id}/rollback`, { token: a.owner.token, body: { reason: 'Wrong squad chosen' } }));
  assert.equal(rb.status, 'rolled_back');
  assert.equal(await live(g.ath.id, a.cohort.id), 1, 'back in the original group');
  assert.equal(await live(g.ath.id, to.id), 0);
  const detail = must(await api('GET', `/academy/promotions/${p.id}`, { token: a.owner.token }));
  assert.ok(detail.events.some((e) => e.event === 'step_squad_invite_failed') && detail.events.some((e) => e.event === 'rolled_back'));
  await assert.rejects(() => pool.query('DELETE FROM academy_promotion_events'), /append-only/);
});

test('graduation: no certificate before the final approval; then one verifiable certificate; the graduation cannot be rolled back', async () => {
  const a = await academy();
  const g = await decided(a, 'graduate');
  const p = must(await plan(a, g.decision, { enrolment_id: g.enrolment.id, cert_title: 'U12 Graduate' }), 201);
  const first = must(await approve(p, a.owner));
  assert.equal(first.status, 'awaiting_final_approval');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM credentials WHERE enrolment_id=$1', [g.enrolment.id])).rows[0].n, 0, 'nothing is issued yet');
  assert.equal((await pool.query('SELECT status FROM org_enrolments WHERE id=$1', [g.enrolment.id])).rows[0].status, 'enrolled');
  assert.equal((await approve(first, a.owner, 'plan')).status, 409);
  const fin = must(await approve(first, a.owner, 'final'));
  assert.equal(fin.status, 'completed');
  const cred = (await pool.query('SELECT * FROM credentials WHERE enrolment_id=$1', [g.enrolment.id])).rows;
  assert.equal(cred.length, 1); assert.equal(cred[0].title, 'U12 Graduate'); assert.ok(cred[0].code);
  assert.equal((await api('POST', `/academy/promotions/${p.id}/rollback`, { token: a.owner.token, body: { reason: 'Changed my mind' } })).status, 409);
});

test('promotion views: staff see the money line, the coach does not, the athlete only their own steps, strangers get 404', async () => {
  const a = await academy();
  const g = await decided(a, 'promote');
  const to = await cohortOf(a, 'U14c', 10);
  const p = must(await plan(a, g.decision, { enrolment_id: g.enrolment.id, to_cohort_id: to.id, note: 'Private reasoning' }), 201);
  assert.ok(p.checks.some((x) => x.key === 'obligations'));
  assert.equal(p.note, 'Private reasoning');
  const coach = must(await api('GET', `/academy/promotions/${p.id}`, { token: a.coach.token }));
  assert.ok(!coach.checks.some((x) => x.key === 'obligations') && coach.note === undefined);
  assert.equal(must(await api('GET', `/organisations/${a.org.id}/academy/promotions`, { token: a.coach.token })).items.length, 1);
  assert.equal(must(await api('GET', `/me/academy/promotions`, { token: g.ath.token })).length, 0, 'a plan nobody approved is not shown to the athlete');
  must(await approve(p, a.owner));
  const mine = must(await api('GET', `/me/academy/promotions`, { token: g.ath.token }));
  assert.equal(mine.length, 1); assert.equal(mine[0].checks, undefined); assert.equal(mine[0].note, undefined);
  const outsider = await academy();
  assert.equal((await api('GET', `/academy/promotions/${p.id}`, { token: outsider.owner.token })).status, 404);
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/promotions`, { token: outsider.owner.token })).status, 404);
});

test('promotion expiry: an unanswered squad invitation is withdrawn, the history is kept', async () => {
  const a = await academy();
  const g = await decided(a, 'invite_squad');
  const team = must(await api('POST', '/teams', { token: a.owner.token, body: { name: 'Expiry squad', sport: 'football' } }), 201);
  const p = must(await plan(a, g.decision, { team_id: team.id, expires_in_days: 1 }), 201);
  must(await approve(p, a.owner));
  await pool.query("UPDATE academy_promotion_runs SET expires_at = now() - interval '1 minute' WHERE id=$1", [p.id]);
  assert.ok(await expireAcademyPromotions() >= 1);
  assert.equal((await pool.query('SELECT status FROM team_members WHERE team_id=$1 AND user_id=$2', [team.id, g.ath.id])).rows[0].status, 'left');
  assert.equal(must(await api('GET', `/academy/promotions/${p.id}`, { token: a.owner.token })).status, 'expired');
});

test('the old follow-through endpoint stands aside once a decision has a promotion run', async () => {
  const a = await academy();
  const g = await decided(a, 'move_programme');
  const to = await cohortOf(a, 'U14d', 10);
  must(await plan(a, g.decision, { enrolment_id: g.enrolment.id, to_cohort_id: to.id }), 201);
  const r = await api('POST', `/academy/decisions/${g.decision.id}/follow-through`, { token: a.owner.token, body: { action: 'move_cohort', enrolment_id: g.enrolment.id, to_cohort_id: to.id } });
  assert.equal(r.status, 409);
});
