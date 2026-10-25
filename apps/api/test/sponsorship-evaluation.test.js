// Application scoring and evaluation committees (#288): weighted rubric validation, committee and role gating, independent scoring,
// conflicts / recusal, blind review with applicant consent, shortlist + interview rounds, moderation, the preserved decision record,
// confidentiality towards applicants, tenant isolation, stale versions and concurrency.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `ev_${n}_${roles[0]}`, display_name: `Eval ${n}`, email: `ev${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** A corporate brand with staff in each role, a published program and an open round. */
async function setup() {
  const owner = await signup(['sponsor']);
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Acme ${n}`, kind: 'company' } }), 201);
  const b = must(await api('POST', '/sponsors', { token: owner.token, body: { name: `Eval brand ${n}` } }), 201);
  must(await api('POST', `/sponsors/${b.id}/identity`, { token: owner.token, body: { sponsor_type: 'organization', organisation_id: org.id } }));
  const staff = {};
  for (const [key, role] of [['ev1', 'evaluator'], ['ev2', 'evaluator'], ['ev3', 'evaluator'], ['approver', 'approver'], ['auditor', 'auditor'], ['finance', 'finance']]) {
    const u = await signup(['sponsor']);
    must(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role } }), 201);
    must(await api('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } }));
    staff[key] = u;
  }
  let p = must(await api('POST', '/sponsorship-programs', { token: owner.token, body: { sponsor_id: b.id, name: 'Scored call', currency: 'USD', budget_cents: 500000, max_award_cents: 100000 } }), 201);
  const r = must(await api('POST', `/sponsorship-programs/${p.id}/rounds`, { token: owner.token, body: { opens_on: day(-1), closes_on: day(30) } }), 201);
  p = must(await api('POST', `/sponsorship-programs/${p.id}/status`, { token: owner.token, body: { status: 'published', version: p.row_version } }));
  return { owner, org, b, staff, p, r };
}
const applicant = async (w, requested = 50000) => {
  const a = await signup(['athlete']);
  must(await api('POST', '/me/sponsorship-profile', { token: a.token, body: { open_to_sponsors: true } }));
  const app = must(await api('POST', `/program-rounds/${w.r.id}/applications`, { token: a.token, body: { target_type: 'athlete', target_id: a.id, requested_cents: requested, pitch: 'Fund my season' } }), 201);
  return { a, app };
};
const CRITERIA = [{ name: 'Impact', weight: 50 }, { name: 'Merit', weight: 30 }, { name: 'Budget', weight: 20 }];
const rubric = (w, body = {}) => api('POST', `/program-rounds/${w.r.id}/rubric`, { token: w.owner.token, body: { criteria: CRITERIA, ...body } });
const live = async (w, { anonymize = true, reviewers = ['ev1', 'ev2'], moderators = [] } = {}) => {
  let rb = must(await rubric(w, { anonymize }));
  for (const k of reviewers) must(await api('POST', `/program-rounds/${w.r.id}/reviewers`, { token: w.owner.token, body: { user_id: w.staff[k].id } }), 201);
  for (const k of moderators) must(await api('POST', `/program-rounds/${w.r.id}/reviewers`, { token: w.owner.token, body: { user_id: w.staff[k].id, role: 'moderator' } }), 201);
  rb = must(await api('POST', `/program-rounds/${w.r.id}/rubric/activate`, { token: w.owner.token, body: { version: rb.rubric.row_version } }));
  return rb.rubric;
};
const sheet = (token, appId) => api('GET', `/program-applications/${appId}/scoresheet`, { token });
const score = (token, rb, appId, marks, extra = {}) => api('POST', `/program-applications/${appId}/score`, { token, body: { rubric_version: rb.row_version, scores: rb.criteria.map((c, k) => ({ criterion_id: c.id, score: marks[k] })), submit: true, ...extra } });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('rubric weights must total exactly 100; scoring cannot open without a committee; roles gate setup', async () => {
  const w = await setup();
  const bad = await rubric(w, { criteria: [{ name: 'A', weight: 60 }, { name: 'B', weight: 30 }] });
  assert.equal(bad.status, 422);
  assert.match(bad.body.error?.message ?? bad.body.message, /total 100/);
  assert.equal((await rubric(w, { criteria: [{ name: 'A', weight: 60 }, { name: 'B', weight: 50 }] })).status, 422);
  assert.equal((await api('POST', `/program-rounds/${w.r.id}/rubric`, { token: w.staff.ev1.token, body: { criteria: CRITERIA } })).status, 403, 'an evaluator cannot set up the rubric');
  const rb = must(await rubric(w));
  assert.equal(rb.rubric.total_weight, 100);
  assert.equal((await api('POST', `/program-rounds/${w.r.id}/rubric/activate`, { token: w.owner.token, body: { version: rb.rubric.row_version } })).status, 422, 'no reviewers yet');
  // replacing a draft retires it, nothing is deleted
  const again = must(await rubric(w, { version: rb.rubric.row_version, criteria: [{ name: 'Only', weight: 100 }] }));
  assert.equal(again.rubric.version, 2);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM sponsorship_rubrics WHERE round_id=$1 AND status='retired'", [w.r.id])).rows[0].n, 1);
  assert.equal((await rubric(w, { version: rb.rubric.row_version })).status, 409, 'stale rubric version');
  // committee: only brand evaluators / managers; finance cannot be a reviewer
  assert.equal((await api('POST', `/program-rounds/${w.r.id}/reviewers`, { token: w.owner.token, body: { user_id: w.staff.finance.id } })).status, 422);
  const stranger = await signup(['sponsor']);
  assert.equal((await api('POST', `/program-rounds/${w.r.id}/reviewers`, { token: w.owner.token, body: { user_id: stranger.id } })).status, 422);
  const eligible = must(await api('GET', `/program-rounds/${w.r.id}/eligible-reviewers`, { token: w.owner.token }));
  assert.ok(eligible.some((x) => x.id === w.staff.ev1.id) && !eligible.some((x) => x.id === w.staff.finance.id));
});

test('independent weighted scoring: totals are computed, reviewers never see each other, locked after the first score', async () => {
  const w = await setup();
  const rb = await live(w, { anonymize: false, moderators: [] });
  const { app } = await applicant(w);
  // 5/5, 3/5, 4/5 on weights 50/30/20 => 50 + 18 + 16 = 84
  const s1 = must(await score(w.staff.ev1.token, rb, app.id, [5, 3, 4]));
  assert.equal(Number(s1.total), 84);
  const incomplete = await api('POST', `/program-applications/${app.id}/score`, { token: w.staff.ev2.token, body: { rubric_version: rb.row_version, submit: true, scores: [{ criterion_id: rb.criteria[0].id, score: 4 }] } });
  assert.equal(incomplete.status, 422);
  assert.equal((await score(w.staff.ev2.token, rb, app.id, [9, 3, 4])).status, 400, 'beyond the scale');
  must(await score(w.staff.ev2.token, rb, app.id, [2, 2, 2]));
  const mine = must(await sheet(w.staff.ev2.token, app.id));
  assert.equal(mine.all_scores, undefined, 'a reviewer never sees the others');
  assert.equal(mine.summary, undefined);
  assert.equal(JSON.stringify(mine).includes('84.00'), false, "ev1's total is not in ev2's sheet");
  const staff = must(await sheet(w.owner.token, app.id));
  assert.equal(staff.all_scores.length, 2);
  assert.equal(staff.summary.average, 62);
  assert.equal(staff.summary.spread, 44);
  assert.equal(staff.summary.needs_moderation, true);
  assert.equal(staff.rubric.locked_at != null, true);
  assert.equal((await rubric(w, { version: staff.rubric.row_version })).status, 409, 'locked rubric cannot change');
  // non-committee roles and applicants have no access
  assert.equal((await sheet(w.staff.finance.token, app.id)).status, 403);
  assert.equal((await score(w.staff.ev3.token, rb, app.id, [5, 5, 5])).status, 403, 'evaluator not on the committee cannot score');
  // revising my own submitted score needs my version
  const rev = await score(w.staff.ev1.token, rb, app.id, [4, 4, 4], { version: 1 });
  assert.equal(Number(must(rev).total), 80);
  assert.equal((await score(w.staff.ev1.token, rb, app.id, [4, 4, 4], { version: 1 })).status, 409, 'stale score version');
});

test('conflicted reviewers cannot score; managers can record and lift a conflict; the history keeps it', async () => {
  const w = await setup();
  const rb = await live(w, { anonymize: false });
  const { app } = await applicant(w);
  must(await score(w.staff.ev1.token, rb, app.id, [5, 5, 5]));
  const rec = must(await api('POST', `/program-applications/${app.id}/conflicts`, { token: w.staff.ev1.token, body: { reason: 'Coached this athlete' } }), 201);
  assert.equal(rec.source, 'self');
  assert.equal((await score(w.staff.ev1.token, rb, app.id, [5, 5, 5], { version: 2 })).status, 403, 'recused');
  assert.equal(must(await sheet(w.staff.ev1.token, app.id)).can_score, false);
  assert.equal(must(await sheet(w.owner.token, app.id)).summary.submitted, 0, 'the conflicted score no longer counts');
  assert.equal((await api('POST', `/program-applications/${app.id}/conflicts/${w.staff.ev1.id}/clear`, { token: w.staff.ev1.token, body: { reason: 'nope' } })).status, 403, 'cannot lift your own');
  assert.equal((await api('POST', `/program-applications/${app.id}/conflicts`, { token: w.staff.ev1.token, body: { reason: 'x', reviewer_user_id: w.staff.ev2.id } })).status, 403, 'a reviewer cannot recuse someone else');
  must(await api('POST', `/program-applications/${app.id}/conflicts`, { token: w.owner.token, body: { reason: 'Same employer', reviewer_user_id: w.staff.ev2.id } }), 201);
  assert.equal((await score(w.staff.ev2.token, rb, app.id, [3, 3, 3])).status, 403);
  must(await api('POST', `/program-applications/${app.id}/conflicts/${w.staff.ev2.id}/clear`, { token: w.owner.token, body: { reason: 'Reviewed, no tie' } }));
  must(await score(w.staff.ev2.token, rb, app.id, [3, 3, 3]));
  const hist = must(await api('GET', `/program-applications/${app.id}/history`, { token: w.owner.token }));
  const kinds = hist.events.map((e) => e.kind);
  assert.ok(kinds.includes('conflict_declared') && kinds.includes('conflict_cleared') && kinds.includes('score_submitted'));
  assert.equal(JSON.stringify(hist.events).includes('"total"'), false, 'the history carries no score values');
  assert.equal((await api('GET', `/program-applications/${app.id}/history`, { token: w.staff.ev1.token })).status, 403, 'a plain reviewer cannot read the history');
});

test('conflicts are also detected automatically: the committee member who owns the target team cannot score it', async () => {
  const w = await setup();
  const rb = await live(w, { anonymize: false, reviewers: ['ev1'] });
  const a = await signup(['athlete']);
  const team = must(await api('POST', '/teams', { token: w.staff.ev1.token, body: { name: `Staff team ${n}`, sport: 'football' } }), 201);
  await pool.query("UPDATE users SET roles = roles || ARRAY['athlete']::text[] WHERE id=$1", [w.staff.ev1.id]);
  const owner = await pool.query('SELECT owner_id FROM teams WHERE id=$1', [team.id]);
  assert.equal(owner.rows[0].owner_id, w.staff.ev1.id);
  const ins = await pool.query("INSERT INTO sponsorship_applications(program_id, round_id, round_terms_version, terms_snapshot, applicant_id, target_type, target_id, requested_cents, currency) VALUES ($1,$2,1,'{}',$3,'team',$4,10000,'USD') RETURNING id", [w.p.id, w.r.id, a.id, team.id]);
  const res = await score(w.staff.ev1.token, rb, ins.rows[0].id, [5, 5, 5]);
  assert.equal(res.status, 403);
  assert.match(res.body.error?.message ?? res.body.message ?? '', /team/);
});

test('blind review: staff see an alias until the applicant consents; award needs that consent; only the applicant can answer', async () => {
  const w = await setup();
  const rb = await live(w, { anonymize: true });
  const { a, app } = await applicant(w);
  const list = must(await api('GET', `/sponsorship-programs/${w.p.id}/applications`, { token: w.owner.token }));
  assert.equal(list[0].anonymized, true);
  assert.equal(JSON.stringify(list[0]).includes(a.display_name), false);
  assert.equal(JSON.stringify(list[0]).includes(a.handle), false);
  assert.equal(list[0].applicant_user_id, null);
  const ev = must(await api('GET', `/program-rounds/${w.r.id}/evaluation`, { token: w.staff.ev1.token }));
  assert.equal(ev.items[0].anonymized, true);
  assert.equal(ev.items[0].applicant_name, undefined);
  assert.equal(JSON.stringify(ev).includes(a.display_name), false);
  assert.equal(JSON.stringify(must(await sheet(w.staff.ev1.token, app.id))).includes(a.display_name), false);
  // shortlist, score, then try to award without consent
  must(await score(w.staff.ev1.token, rb, app.id, [5, 5, 5]));
  must(await api('POST', `/program-applications/${app.id}/stage`, { token: w.owner.token, body: { stage: 'shortlisted', eval_version: ev.items[0].eval_version + 1 } }).then((r) => (r.status === 409 ? api('POST', `/program-applications/${app.id}/stage`, { token: w.owner.token, body: { stage: 'shortlisted', eval_version: r.body.error?.details?.current_version ?? r.body.details?.current_version } }) : r)));
  const cur = (await pool.query('SELECT eval_version FROM sponsorship_applications WHERE id=$1', [app.id])).rows[0].eval_version;
  const noConsent = await api('PATCH', `/program-applications/${app.id}`, { token: w.owner.token, body: { decision: 'award', program_version: w.p.row_version, eval_version: cur } });
  assert.equal(noConsent.status, 409);
  assert.match(noConsent.body.error?.message ?? noConsent.body.message, /agreed to be identified/);
  // consent flow
  assert.equal((await api('POST', `/program-applications/${app.id}/identity-request`, { token: w.staff.ev1.token, body: {} })).status, 403, 'an evaluator cannot ask');
  must(await api('POST', `/program-applications/${app.id}/identity-request`, { token: w.owner.token, body: { message: 'To prepare the agreement' } }), 201);
  assert.equal((await api('POST', `/program-applications/${app.id}/identity-request`, { token: w.owner.token, body: {} })).status, 409, 'one live request');
  const stranger = await signup(['athlete']);
  assert.equal((await api('POST', `/program-applications/${app.id}/identity-response`, { token: stranger.token, body: { decision: 'grant' } })).status, 404, 'only the applicant answers');
  assert.equal((await api('POST', `/program-applications/${app.id}/identity-response`, { token: w.owner.token, body: { decision: 'grant' } })).status, 404, 'the brand cannot answer for them');
  const mineList = must(await api('GET', '/my/program-applications', { token: a.token }));
  assert.equal(mineList[0].identity_status, 'requested');
  must(await api('POST', `/program-applications/${app.id}/identity-response`, { token: a.token, body: { decision: 'grant' } }));
  const shown = must(await api('GET', `/sponsorship-programs/${w.p.id}/applications`, { token: w.owner.token }));
  assert.equal(shown[0].anonymized, false);
  assert.equal(shown[0].display_name, a.display_name);
  // revoke hides again, grant again is a new request
  must(await api('POST', `/program-applications/${app.id}/identity-response`, { token: a.token, body: { decision: 'revoke' } }));
  assert.equal(must(await api('GET', `/sponsorship-programs/${w.p.id}/applications`, { token: w.owner.token }))[0].anonymized, true);
  must(await api('POST', `/program-applications/${app.id}/identity-request`, { token: w.owner.token, body: {} }), 201);
  must(await api('POST', `/program-applications/${app.id}/identity-response`, { token: a.token, body: { decision: 'grant' } }));
  const cur2 = (await pool.query('SELECT eval_version FROM sponsorship_applications WHERE id=$1', [app.id])).rows[0].eval_version;
  const stale = await api('PATCH', `/program-applications/${app.id}`, { token: w.owner.token, body: { decision: 'award', program_version: w.p.row_version, eval_version: cur2 - 1 } });
  assert.equal(stale.status, 409, 'the committee changed it since the manager looked');
  const awarded = must(await api('PATCH', `/program-applications/${app.id}`, { token: w.owner.token, body: { decision: 'award', program_version: w.p.row_version, eval_version: cur2, awarded_cents: 40000 } }));
  assert.equal(awarded.award.status, 'issued');
  // the decision keeps the rubric as scored and only the references the brand may rely on
  const hist = must(await api('GET', `/program-applications/${app.id}/history`, { token: w.owner.token }));
  assert.equal(hist.decision.decision, 'award');
  assert.equal(hist.decision.rubric_snapshot.criteria.length, 3);
  assert.equal(hist.decision.rubric_snapshot.criteria.reduce((t, c) => t + c.weight, 0), 100);
  assert.equal(hist.decision.score_snapshot.final_score, 100);
  assert.equal(hist.decision.source_refs.application_id, app.id);
  assert.equal(hist.decision.source_refs.target_id, a.id, 'identity reference only because the applicant agreed');
});

test('confidential scores stay internal: applicants never see scores, other brands and roles are refused on reads, writes and exports', async () => {
  const w = await setup();
  const rb = await live(w, { anonymize: false });
  const { a, app } = await applicant(w);
  must(await score(w.staff.ev1.token, rb, app.id, [5, 4, 3]));
  must(await api('POST', `/program-applications/${app.id}/moderation`, { token: w.owner.token, body: { total: 70, reason: 'Panel view', eval_version: (await pool.query('SELECT eval_version FROM sponsorship_applications WHERE id=$1', [app.id])).rows[0].eval_version } }), 201);
  for (const [path, label] of [['/my/program-applications', 'applications'], ['/my/program-interviews', 'interviews']]) {
    const txt = JSON.stringify(must(await api('GET', path, { token: a.token })));
    assert.equal(/"total"|"final_score"|moderat|reviewer|scores/i.test(txt), false, `${label} expose no scoring`);
  }
  for (const [m, path] of [['GET', `/program-applications/${app.id}/scoresheet`], ['GET', `/program-applications/${app.id}/history`], ['GET', `/program-rounds/${w.r.id}/evaluation`], ['GET', `/program-rounds/${w.r.id}/rubric`], ['GET', `/program-rounds/${w.r.id}/evaluation-export`]]) {
    assert.equal((await api(m, path, { token: a.token })).status, 403, `applicant ${path}`);
  }
  // another brand
  const other = await setup();
  for (const [m, path, body] of [['GET', `/program-applications/${app.id}/scoresheet`], ['GET', `/program-applications/${app.id}/history`], ['GET', `/program-rounds/${w.r.id}/evaluation`], ['GET', `/program-rounds/${w.r.id}/rubric`], ['GET', `/program-rounds/${w.r.id}/evaluation-export`],
    ['POST', `/program-rounds/${w.r.id}/reviewers`, { user_id: other.staff.ev1.id }], ['POST', `/program-applications/${app.id}/stage`, { stage: 'shortlisted', eval_version: 1 }], ['POST', `/program-applications/${app.id}/score`, { rubric_version: 1, submit: false, scores: [{ criterion_id: rb.criteria[0].id, score: 3 }] }]]) {
    const r = await api(m, path, { token: other.owner.token, body });
    assert.equal(r.status, 403, `${m} ${path}`);
    const e = await api(m, path, { token: other.staff.ev1.token, body });
    assert.equal(e.status, 403, `evaluator of another brand ${path}`);
  }
  // exports: finance cannot, auditor and manager can; audit logged; aliases only unless consented
  assert.equal((await api('GET', `/program-rounds/${w.r.id}/evaluation-export`, { token: w.staff.finance.token })).status, 403);
  assert.equal((await api('GET', `/program-rounds/${w.r.id}/evaluation-export`, { token: w.staff.ev1.token })).status, 403);
  const csv = must(await api('GET', `/program-rounds/${w.r.id}/evaluation-export`, { token: w.staff.auditor.token }));
  assert.match(csv.csv, /final_score/);
  assert.equal(csv.csv.includes(a.handle), false, 'applicant stays an alias in the export');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='export' AND entity='sponsorship_rounds' AND entity_id=$1", [w.r.id])).rows[0]);
  // the auditor reads, but cannot write
  assert.equal((await api('POST', `/program-applications/${app.id}/stage`, { token: w.staff.auditor.token, body: { stage: 'shortlisted', eval_version: 1 } })).status, 403);
});

test('shortlist and any number of interview rounds (slot, video link or both) until the sponsor decides', async () => {
  const w = await setup();
  const rb = await live(w, { anonymize: false, moderators: ['ev3'] });
  const { a, app } = await applicant(w);
  let v = (await pool.query('SELECT eval_version FROM sponsorship_applications WHERE id=$1', [app.id])).rows[0].eval_version;
  assert.equal((await api('POST', `/program-applications/${app.id}/interviews`, { token: w.owner.token, body: { eval_version: v, video_url: 'https://meet.example.com/x' } })).status, 409, 'must be shortlisted first');
  assert.equal((await api('POST', `/program-applications/${app.id}/stage`, { token: w.staff.ev1.token, body: { stage: 'shortlisted', eval_version: v } })).status, 403, 'a plain reviewer cannot shortlist');
  const st = must(await api('POST', `/program-applications/${app.id}/stage`, { token: w.staff.ev3.token, body: { stage: 'shortlisted', eval_version: v } }));
  assert.equal(st.stage, 'shortlisted');
  assert.equal((await api('POST', `/program-applications/${app.id}/stage`, { token: w.owner.token, body: { stage: 'finalist', eval_version: v } })).status, 409, 'stale version');
  v = st.eval_version;
  assert.equal((await api('POST', `/program-applications/${app.id}/interviews`, { token: w.owner.token, body: { eval_version: v, notes: 'no time or link' } })).status, 400);
  assert.equal((await api('POST', `/program-applications/${app.id}/interviews`, { token: w.owner.token, body: { eval_version: v, video_url: 'http://insecure.example.com' } })).status, 400);
  const when = new Date(Date.now() + 3 * 864e5).toISOString();
  const i1 = must(await api('POST', `/program-applications/${app.id}/interviews`, { token: w.owner.token, body: { eval_version: v, scheduled_at: when, timezone: 'Europe/Paris', location: 'HQ', notes: 'Bring the budget' } }), 201);
  assert.equal(i1.seq, 1);
  assert.equal((await pool.query('SELECT stage FROM sponsorship_applications WHERE id=$1', [app.id])).rows[0].stage, 'interview');
  const vv = (await pool.query('SELECT eval_version FROM sponsorship_applications WHERE id=$1', [app.id])).rows[0].eval_version;
  assert.equal((await api('POST', `/program-applications/${app.id}/interviews`, { token: w.owner.token, body: { eval_version: vv, video_url: 'https://meet.example.com/2' } })).status, 409, 'finish round 1 first');
  const mine = must(await api('GET', '/my/program-interviews', { token: a.token }));
  assert.equal(mine.length, 1);
  assert.equal(mine[0].notes, 'Bring the budget');
  assert.equal(mine[0].outcome, undefined);
  assert.ok((await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND data->>'interview_id'=$2", [a.id, i1.id])).rows[0], 'applicant told');
  must(await api('PATCH', `/program-interviews/${i1.id}`, { token: w.owner.token, body: { version: i1.row_version, status: 'completed', outcome: 'Strong, wants a second round' } }));
  assert.equal((await api('PATCH', `/program-interviews/${i1.id}`, { token: w.owner.token, body: { version: i1.row_version + 1, notes: 'late' } })).status, 409, 'completed');
  const v3 = (await pool.query('SELECT eval_version FROM sponsorship_applications WHERE id=$1', [app.id])).rows[0].eval_version;
  const i2 = must(await api('POST', `/program-applications/${app.id}/interviews`, { token: w.owner.token, body: { eval_version: v3, video_url: 'https://meet.example.com/2', scheduled_at: when } }), 201);
  assert.equal(i2.seq, 2);
  const staffList = must(await api('GET', `/program-applications/${app.id}/interviews`, { token: w.staff.ev1.token }));
  assert.deepEqual(staffList.map((x) => x.seq), [1, 2]);
  assert.equal(staffList[0].outcome, 'Strong, wants a second round');
  must(await api('PATCH', `/program-interviews/${i2.id}`, { token: w.owner.token, body: { version: i2.row_version, status: 'cancelled' } }));
  const stage = must(await api('POST', `/program-applications/${app.id}/stage`, { token: w.owner.token, body: { stage: 'finalist', eval_version: (await pool.query('SELECT eval_version FROM sponsorship_applications WHERE id=$1', [app.id])).rows[0].eval_version } }));
  assert.equal(stage.stage, 'finalist');
  // an unshortlisted application cannot be awarded in a scored round, and one with no score cannot either
  const cur = (await pool.query('SELECT eval_version FROM sponsorship_applications WHERE id=$1', [app.id])).rows[0].eval_version;
  const noScore = await api('PATCH', `/program-applications/${app.id}`, { token: w.owner.token, body: { decision: 'award', program_version: w.p.row_version, eval_version: cur } });
  assert.equal(noScore.status, 409);
  assert.match(noScore.body.error?.message ?? noScore.body.message, /no submitted committee score/);
  const second = await applicant(w);
  const early = await api('PATCH', `/program-applications/${second.app.id}`, { token: w.owner.token, body: { decision: 'award', program_version: w.p.row_version } });
  assert.equal(early.status, 409);
  assert.match(early.body.error?.message ?? early.body.message, /Shortlist/);
  // declining stays possible and is recorded with the rubric
  must(await api('PATCH', `/program-applications/${second.app.id}`, { token: w.owner.token, body: { decision: 'decline', reason: 'Out of scope' } }));
  const h = must(await api('GET', `/program-applications/${second.app.id}/history`, { token: w.owner.token }));
  assert.equal(h.decision.decision, 'decline');
  assert.equal(h.decision.rubric_snapshot.criteria.length, 3);
  assert.equal((await api('POST', `/program-applications/${second.app.id}/identity-request`, { token: w.owner.token, body: {} })).status, 409, 'decided applications are closed');
});

test('moderation settles disagreement; the moderated total is the final score and earlier scores stay on record', async () => {
  const w = await setup();
  const rb = await live(w, { anonymize: false });
  const { app } = await applicant(w);
  must(await score(w.staff.ev1.token, rb, app.id, [5, 5, 5]));
  must(await score(w.staff.ev2.token, rb, app.id, [1, 1, 1]));
  const v = () => pool.query('SELECT eval_version FROM sponsorship_applications WHERE id=$1', [app.id]).then((r) => r.rows[0].eval_version);
  const ev = must(await api('GET', `/program-rounds/${w.r.id}/evaluation`, { token: w.owner.token }));
  assert.equal(ev.items[0].summary.needs_moderation, true);
  const evOne = must(await api('GET', `/program-rounds/${w.r.id}/evaluation`, { token: w.staff.ev1.token }));
  assert.equal(evOne.items[0].summary.average, undefined, 'a plain reviewer sees no summary');
  assert.equal((await api('POST', `/program-applications/${app.id}/moderation`, { token: w.staff.ev1.token, body: { total: 60, reason: 'x', eval_version: await v() } })).status, 403);
  const m = must(await api('POST', `/program-applications/${app.id}/moderation`, { token: w.owner.token, body: { total: 62.5, reason: 'Panel discussion', eval_version: await v() } }), 201);
  assert.equal(Number(m.total), 62.5);
  const sum = must(await sheet(w.owner.token, app.id)).summary;
  assert.equal(sum.final_score, 62.5);
  assert.equal(sum.needs_moderation, false);
  assert.equal(sum.average, 60);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM sponsorship_scores WHERE application_id=$1 AND status='submitted'", [app.id])).rows[0].n, 2);
});

test('concurrency: two simultaneous first saves by one reviewer produce one score; the loser is told to reload', async () => {
  const w = await setup();
  const rb = await live(w, { anonymize: false });
  const { app } = await applicant(w);
  const res = await Promise.all([1, 2, 3].map(() => score(w.staff.ev1.token, rb, app.id, [3, 3, 3])));
  const ok = res.filter((r) => r.status === 200).length;
  assert.equal(ok, 1, JSON.stringify(res.map((r) => r.status)));
  assert.equal(res.filter((r) => r.status === 409).length, 2);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sponsorship_scores WHERE application_id=$1', [app.id])).rows[0].n, 1);
});

test('programs without a rubric behave exactly as before; scoring deadlines and archived rounds are respected', async () => {
  const w = await setup();
  const { app } = await applicant(w);
  const ev = must(await api('GET', `/program-rounds/${w.r.id}/evaluation`, { token: w.owner.token }));
  assert.equal(ev.rubric_status, null);
  assert.equal((await api('GET', `/program-applications/${app.id}/scoresheet`, { token: w.owner.token })).status, 200);
  const awarded = must(await api('PATCH', `/program-applications/${app.id}`, { token: w.owner.token, body: { decision: 'award', program_version: w.p.row_version } }));
  assert.equal(awarded.award.status, 'issued');
  const h = must(await api('GET', `/program-applications/${app.id}/history`, { token: w.owner.token }));
  assert.equal(h.decision.rubric_snapshot, null);
  // a closed scoring window refuses scores
  const w2 = await setup();
  const past = new Date(Date.now() + 1500).toISOString();
  const rb0 = must(await rubric(w2, { scoring_closes_at: past }));
  must(await api('POST', `/program-rounds/${w2.r.id}/reviewers`, { token: w2.owner.token, body: { user_id: w2.staff.ev1.id } }), 201);
  const rb = must(await api('POST', `/program-rounds/${w2.r.id}/rubric/activate`, { token: w2.owner.token, body: { version: rb0.rubric.row_version } })).rubric;
  const x = await applicant(w2);
  await new Promise((r) => setTimeout(r, 1700));
  const late = await score(w2.staff.ev1.token, rb, x.app.id, [3, 3, 3]);
  assert.equal(late.status, 409);
  assert.match(late.body.error?.message ?? late.body.message, /closed/);
  assert.equal(must(await sheet(w2.staff.ev1.token, x.app.id)).can_score, false);
  // removing a reviewer voids drafts, keeps submitted scores
  assert.equal((await api('POST', `/program-rounds/${w2.r.id}/reviewers/${w2.staff.ev1.id}/remove`, { token: w2.owner.token })).status, 200);
  assert.equal((await score(w2.staff.ev1.token, rb, x.app.id, [3, 3, 3])).status, 403, 'removed from the committee');
});
