import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// #795 Academy student wellbeing & personal development: happy paths and every refusal the acceptance criteria name.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { capabilities } = await import('../src/capabilities/index.js');
const { screen, suppress, MIN_GROUP, TOPICS, SCOPES } = await import('../src/wellbeing.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const signup = async (roles = ['athlete'], extra = {}) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `wb_${n}_${roles[0]}`, display_name: `Wb ${n}`, email: `wb${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const inDays = (d, h = 10) => { const x = new Date(Date.now() + d * 864e5); x.setUTCHours(h, 0, 0, 0); return x.toISOString(); };
const ALL = ['tracks', 'mentoring', 'checkins', 'goals', 'guardian_updates', 'referrals'];

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('wb_root','wb_root','{admin}','x','x','wb_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

async function guardianOf(child) {
  const parent = await signup(['athlete'], { dob: yearsAgo(40) });
  const l = ok(await api('POST', '/youth/guardian-links', { token: parent.token, body: { guardian_id: parent.id, child_id: child.id, relationship: 'parent' } }), 201);
  ok(await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: child.token, body: { accept: true } }));
  ok(await api('POST', `/youth/guardian-links/${l.id}/evidence`, { token: parent.token, body: { evidence: { reference: 'https://example.com/birth-certificate-ref-123', label: 'Birth certificate' } } }), 201);
  ok(await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Documents match' } }));
  ok(await api('POST', `/youth/children/${child.id}/consents`, { token: parent.token, body: { purpose: 'participation' } }), 201);
  return parent;
}
/** An academy: owner, a mentor (mentor template), a safeguarding officer, a plain coach, one young athlete with a guardian, one adult athlete. */
async function academy() {
  const owner = await signup(), mentor = await signup(['coach']), officer = await signup(['coach']), coach = await signup(['coach']);
  const org = ok(await api('POST', '/organisations', { token: owner.token, body: { name: `Wellbeing ${n}`, kind: 'academy' } }), 201);
  for (const [u, role] of [[mentor, 'coach'], [officer, 'staff'], [coach, 'coach']]) {
    ok(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role } }), 201);
    ok(await api('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } }));
  }
  ok(await api('POST', `/organisations/${org.id}/academy/staff/${mentor.id}`, { token: owner.token, body: { job_title: 'Player care mentor', template: 'mentor' } }));
  ok(await api('POST', `/organisations/${org.id}/academy/staff/${officer.id}`, { token: owner.token, body: { job_title: 'Safeguarding lead', template: 'safeguarding' } }));
  const cohort = ok(await api('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: 'U14', coach_id: coach.id } }), 201);
  const kid = await signup(['athlete'], { dob: yearsAgo(13) }), parent = await guardianOf(kid);
  const adult = await signup(['athlete'], { dob: yearsAgo(22) });
  ok(await api('POST', `/cohorts/${cohort.id}/enrolments`, { token: owner.token, body: { csv: `handle,consent\n${kid.handle},yes\n${adult.handle},yes` } }), 201);
  return { owner, mentor, officer, coach, org, cohort, kid, parent, adult, W: `/organisations/${org.id}/academy/wellbeing` };
}
const consent = (a, who, athlete, scopes, token) => api('POST', '/me/wellbeing/consent', { token: token ?? who.token, body: { organisation_id: a.org.id, athlete_id: athlete.id, scopes } });
/** consent + mentor assigned: the common starting point */
async function mentored(scopes = ALL) {
  const a = await academy();
  ok(await consent(a, a.parent, a.kid, scopes), 201);
  ok(await api('POST', `${a.W}/mentors`, { token: a.owner.token, body: { athlete_id: a.kid.id, mentor_id: a.mentor.id } }), 201);
  return a;
}

test('the capabilities are REST routes, OpenAPI operations and MCP tools from one definition', async () => {
  const names = ['save_dev_track', 'archive_dev_track', 'list_dev_tracks', 'get_dev_track', 'enrol_in_dev_track', 'record_dev_track_progress', 'request_wellbeing_consent', 'assign_mentor', 'update_mentor_assignment', 'list_mentor_assignments',
    'schedule_wellbeing_checkin', 'update_wellbeing_checkin', 'list_wellbeing_checkins', 'propose_dev_goal', 'review_dev_goal', 'list_dev_goals', 'propose_wellbeing_referral', 'update_wellbeing_referral', 'list_wellbeing_referrals',
    'send_wellbeing_update', 'set_wellbeing_consent', 'get_my_wellbeing', 'respond_dev_goal', 'respond_wellbeing_referral', 'leave_dev_track', 'get_academy_wellbeing_overview', 'list_wellbeing_athletes', 'get_wellbeing_athlete'];
  const have = new Set(capabilities.map((c) => c.name));
  for (const x of names) assert.ok(have.has(x), x);
  const spec = (await api('GET', '/openapi.json')).body;
  const ids = new Set(Object.values(spec.paths ?? {}).flatMap((p) => Object.values(p).map((o) => o.operationId)));
  for (const x of names) assert.ok(ids.has(x), `${x} in OpenAPI`);
});

test('restricted content: counselling, diagnosis and safeguarding wording is refused, ordinary words pass; groups under five are suppressed', () => {
  for (const bad of ['talked about his depression', 'diagnosed with ADHD', 'started medication', 'disclosed abuse', 'self-harm risk', 'suicidal thoughts']) assert.throws(() => screen(bad), (e) => e.status === 422 && e.code === 'restricted_content', bad);
  for (const fine of ['Practise the breathing routine before matches', 'Lead the warm-up twice a week', 'Sleep eight hours on school nights']) assert.equal(screen(fine), fine);
  assert.equal(suppress(MIN_GROUP - 1), null); assert.equal(suppress(MIN_GROUP), MIN_GROUP);
  assert.ok(TOPICS.includes('sleep_and_routine') && SCOPES.length === 6);
});

test('consent: a guardian decides for a young person, the young person cannot, a stranger gets 404, and withdrawing is immediate and keeps history', async () => {
  const a = await academy();
  assert.equal((await consent(a, a.kid, a.kid, ALL)).status, 403);                      // a young person acts through a guardian
  assert.equal((await consent(a, a.mentor, a.kid, ALL)).status, 404);                   // staff cannot consent for anyone
  const g = ok(await consent(a, a.parent, a.kid, ALL), 201);
  assert.equal(g.granted_as, 'guardian'); assert.deepEqual(g.scopes.sort(), [...ALL].sort());
  ok(await api('POST', `${a.W}/mentors`, { token: a.owner.token, body: { athlete_id: a.kid.id, mentor_id: a.mentor.id } }), 201);
  ok(await api('POST', `${a.W}/checkins`, { token: a.mentor.token, body: { athlete_id: a.kid.id, scheduled_for: inDays(2) } }), 201);
  // narrow: check-ins and mentoring withdrawn -> scheduled check-ins cancelled, mentoring pauses
  ok(await consent(a, a.parent, a.kid, ['tracks', 'goals']), 201);
  const rows = (await pool.query("SELECT status FROM academy_wellbeing_checkins WHERE athlete_id=$1", [a.kid.id])).rows;
  assert.deepEqual(rows.map((r) => r.status), ['cancelled']);
  assert.equal((await pool.query("SELECT status FROM academy_mentor_assignments WHERE athlete_id=$1", [a.kid.id])).rows[0].status, 'paused');
  const mine = ok(await api('GET', '/me/wellbeing', { token: a.parent.token, query: { athlete_id: a.kid.id } }));
  assert.deepEqual(mine.academies[0].consent.scopes.sort(), ['goals', 'tracks']); assert.deepEqual(mine.academies[0].checkins, []);
  // withdraw everything; the earlier choices stay as history
  ok(await consent(a, a.parent, a.kid, []), 201);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM academy_wellbeing_consents WHERE athlete_id=$1 AND revoked_at IS NOT NULL', [a.kid.id])).rows[0].n, 2);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM academy_wellbeing_consents WHERE athlete_id=$1 AND revoked_at IS NULL", [a.kid.id])).rows[0].n, 0);
  assert.equal((await api('POST', `${a.W}/mentors`, { token: a.owner.token, body: { athlete_id: a.kid.id, mentor_id: a.mentor.id, replace: true } })).status, 409);   // consent_required
  // a stranger guardian of nobody cannot read the record
  assert.equal((await api('GET', '/me/wellbeing', { token: a.coach.token, query: { athlete_id: a.kid.id } })).status, 404);
});

test('an adult athlete consents for themself; a guardian\'s grant lapses when the guardian link is revoked', async () => {
  const a = await academy();
  const g = ok(await consent(a, a.adult, a.adult, ['mentoring', 'checkins']), 201);
  assert.equal(g.granted_as, 'self');
  ok(await consent(a, a.parent, a.kid, ALL), 201);
  ok(await api('POST', `${a.W}/mentors`, { token: a.owner.token, body: { athlete_id: a.kid.id, mentor_id: a.mentor.id } }), 201);
  await pool.query("UPDATE guardian_links SET revoked_at=now() WHERE child_id=$1", [a.kid.id]);
  const mentees = ok(await api('GET', `${a.W}/athletes`, { token: a.mentor.token }));
  assert.deepEqual(mentees.find((x) => x.athlete_id === a.kid.id).scopes, []);       // live consent: gone with the guardian's authority
  assert.equal((await api('POST', `${a.W}/checkins`, { token: a.mentor.token, body: { athlete_id: a.kid.id, scheduled_for: inDays(2) } })).status, 409);
});

test('mentors: only eligible staff, one live mentor, replace hands over, a plain coach and an outsider are refused', async () => {
  const a = await academy();
  ok(await consent(a, a.parent, a.kid, ALL), 201);
  const post = (token, body) => api('POST', `${a.W}/mentors`, { token, body: { athlete_id: a.kid.id, ...body } });
  assert.equal((await post(a.coach.token, { mentor_id: a.mentor.id })).status, 403);              // no wellbeing permission
  assert.equal((await post(a.mentor.token, { mentor_id: a.mentor.id })).status, 403);              // a mentor does not assign mentors
  assert.equal((await post(a.owner.token, { mentor_id: a.coach.id })).status, 409);                // coach lacks the permission
  assert.equal((await post(a.owner.token, { mentor_id: a.kid.id })).status, 409);
  const m = ok(await post(a.owner.token, { mentor_id: a.mentor.id, cadence_days: 7 }), 201);
  assert.equal((await post(a.owner.token, { mentor_id: a.officer.id })).status, 409);              // already mentored
  const m2 = ok(await post(a.owner.token, { mentor_id: a.officer.id, replace: true }), 201);
  assert.equal((await pool.query('SELECT status FROM academy_mentor_assignments WHERE id=$1', [m.id])).rows[0].status, 'ended');
  assert.equal(m2.status, 'active');
  // the former mentor no longer reaches the athlete
  assert.equal((await api('GET', `${a.W}/athletes/${a.kid.id}`, { token: a.mentor.token })).status, 404);
  assert.equal((await api('PATCH', `/academy/wellbeing/mentors/${m2.id}`, { token: a.mentor.token, body: { action: 'pause' } })).status, 404);
  ok(await api('PATCH', `/academy/wellbeing/mentors/${m2.id}`, { token: a.officer.token, body: { action: 'end', reason: 'athlete_request' } }));
  assert.equal((await api('PATCH', `/academy/wellbeing/mentors/${m2.id}`, { token: a.officer.token, body: { action: 'pause' } })).status, 409);
});

test('check-ins: schedule a series, record an outcome with a follow-up, restricted notes are refused, the director never sees content', async () => {
  const a = await mentored();
  const s = ok(await api('POST', `${a.W}/checkins`, { token: a.mentor.token, body: { athlete_id: a.kid.id, scheduled_for: inDays(1), repeat: 3, every_days: 7, topics: ['sleep_and_routine'], idempotency_key: 'series-key-0001' } }), 201);
  assert.equal(s.ids.length, 3);
  const again = ok(await api('POST', `${a.W}/checkins`, { token: a.mentor.token, body: { athlete_id: a.kid.id, scheduled_for: inDays(1), repeat: 3, every_days: 7, idempotency_key: 'series-key-0001' } }), 201);
  assert.equal(again.replayed, true);
  assert.equal((await api('POST', `${a.W}/checkins`, { token: a.mentor.token, body: { athlete_id: a.kid.id, scheduled_for: inDays(-3) } })).status, 400);
  assert.equal((await api('POST', `${a.W}/checkins`, { token: a.coach.token, body: { athlete_id: a.kid.id, scheduled_for: inDays(3) } })).status, 403);
  const list = ok(await api('GET', `${a.W}/checkins`, { token: a.mentor.token }));
  const first = list[0];
  const done = (extra) => api('PATCH', `/academy/wellbeing/checkins/${first.id}`, { token: a.mentor.token, body: { row_version: first.row_version, action: 'complete', ...extra } });
  assert.equal((await done({ outcome: 'on_track', next_step: 'He is struggling with depression' })).status, 422);
  assert.equal((await done({ outcome: 'follow_up' })).status, 400);                                 // follow-up needs a date
  assert.equal((await done({ outcome: 'concern_raised' })).status, 400);                            // a concern needs its summary
  const r = ok(await done({ outcome: 'follow_up', follow_up_due: new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10), next_step: 'Agree a wind-down routine before bed', topics: ['sleep_and_routine', 'school_and_study'] }));
  assert.equal(r.status, 'completed'); assert.equal(r.follow_up_status, 'open');
  assert.equal((await done({ outcome: 'on_track' })).status, 409);                                  // stale
  // the director's list: when/who/status, never topics, outcome or the agreed step
  const dir = ok(await api('GET', `${a.W}/checkins`, { token: a.owner.token }));
  const row = dir.find((x) => x.id === first.id);
  assert.equal(row.status, 'completed'); assert.equal(row.follow_up_status, 'open');
  for (const k of ['topics', 'outcome', 'next_step']) assert.equal(k in row, false, `director must not see ${k}`);
  assert.doesNotMatch(JSON.stringify(dir), /wind-down/);
  // the family sees it all, transparently
  const mine = ok(await api('GET', '/me/wellbeing', { token: a.parent.token, query: { athlete_id: a.kid.id } }));
  const fam = mine.academies[0].checkins.find((x) => x.id === first.id);
  assert.equal(fam.next_step, 'Agree a wind-down routine before bed'); assert.equal(mine.academies[0].follow_ups.length, 1);
  // only the mentor closes the follow-up
  const cur = ok(await api('GET', `${a.W}/checkins`, { token: a.mentor.token })).find((x) => x.id === first.id);
  assert.equal((await api('PATCH', `/academy/wellbeing/checkins/${first.id}`, { token: a.owner.token, body: { row_version: cur.row_version, action: 'follow_up_done' } })).status, 403);
  ok(await api('PATCH', `/academy/wellbeing/checkins/${first.id}`, { token: a.mentor.token, body: { row_version: cur.row_version, action: 'follow_up_done' } }));
});

test('a concern goes to the safeguarding workflow, encrypted, and is not shown to the director, the schedule or the family', async () => {
  const a = await mentored();
  ok(await api('POST', `${a.W}/checkins`, { token: a.mentor.token, body: { athlete_id: a.kid.id, scheduled_for: inDays(1) } }), 201);
  const k = ok(await api('GET', `${a.W}/checkins`, { token: a.mentor.token }))[0];
  ok(await api('PATCH', `/academy/wellbeing/checkins/${k.id}`, { token: a.mentor.token, body: { row_version: k.row_version, action: 'complete', outcome: 'concern_raised', concern_summary: 'Said something at home that worries me', concern_severity: 'high' } }));
  const ev = (await pool.query("SELECT id, kind, severity, summary_enc FROM academy_safety_events WHERE athlete_id=$1", [a.kid.id])).rows;
  assert.equal(ev.length, 1); assert.equal(ev[0].kind, 'welfare_concern'); assert.ok(!ev[0].summary_enc.includes('worries'));
  const detail = ok(await api('GET', `/academy/safety/events/${ev[0].id}`, { token: a.officer.token }));
  assert.match(detail.summary, /worries me/);
  assert.equal((await api('GET', `/academy/safety/events/${ev[0].id}`, { token: a.mentor.token })).status, 404);   // the mentor raised it; reading it is for safeguarding
  const dir = JSON.stringify(ok(await api('GET', `${a.W}/checkins`, { token: a.owner.token })));
  assert.doesNotMatch(dir, /concern/);
  const fam = ok(await api('GET', '/me/wellbeing', { token: a.parent.token, query: { athlete_id: a.kid.id } })).academies[0].checkins[0];
  assert.equal(fam.outcome, 'on_track');
  const overview = JSON.stringify(ok(await api('GET', `${a.W.replace('/academy/wellbeing', '')}/academy/wellbeing`, { token: a.owner.token })));
  assert.doesNotMatch(overview, /worries|welfare|concern_raised/);
});

test('goals: human-reviewed, family agrees before it starts, achieving needs a note, clinical wording is refused, consent is live', async () => {
  const a = await mentored();
  const goal = (body) => api('POST', `${a.W}/goals`, { token: a.mentor.token, body: { athlete_id: a.kid.id, ...body } });
  assert.equal((await goal({ title: 'Manage his anxiety disorder' })).status, 422);
  assert.equal((await api('POST', `${a.W}/goals`, { token: a.coach.token, body: { athlete_id: a.kid.id, title: 'Lead the warm-up' } })).status, 403);
  let g = ok(await goal({ title: 'Lead the warm-up twice a week', measure: 'Two sessions a week for a month' }), 201);
  assert.equal(g.status, 'proposed'); assert.equal(g.reviewer_id, a.mentor.id);
  const review = (body) => api('PATCH', `/academy/wellbeing/goals/${g.id}`, { token: a.mentor.token, body: { row_version: g.row_version, ...body } });
  assert.equal((await review({ action: 'start' })).status, 409);                                    // not agreed yet
  assert.equal((await api('POST', `/me/wellbeing/goals/${g.id}/respond`, { token: a.coach.token, body: { decision: 'agree' } })).status, 404);
  g = ok(await api('POST', `/me/wellbeing/goals/${g.id}/respond`, { token: a.parent.token, body: { decision: 'agree' } }));
  assert.equal(g.status, 'agreed');
  g = ok(await review({ action: 'start' }));
  assert.equal(g.status, 'active');
  assert.equal((await review({ action: 'achieve' })).status, 400);                                  // a note is required
  assert.equal((await review({ action: 'achieve', note: 'Started a course of therapy' })).status, 422);
  // the director sees status and dates, not the wording
  const dir = ok(await api('GET', `${a.W}/goals`, { token: a.owner.token }))[0];
  assert.equal(dir.status, 'active'); assert.equal(dir.title, null);
  // edit asks the family again
  g = ok(await review({ action: 'edit', title: 'Lead the warm-up three times a week' }));
  assert.equal(g.status, 'proposed'); assert.equal(g.guardian_agreed_at, null);
  // withdrawing the goals scope hides it at once
  ok(await consent(a, a.parent, a.kid, ['mentoring', 'checkins']), 201);
  assert.deepEqual(ok(await api('GET', `${a.W}/goals`, { token: a.mentor.token })), []);
});

test('referrals: the family must say yes, the reason is a category the director never sees, a yes can be taken back, handing over uses the existing provider suggestion', async () => {
  const a = await mentored();
  const prop = (token, body) => api('POST', `${a.W}/referrals`, { token, body: { athlete_id: a.kid.id, specialty: 'sports_psychology', reason: 'performance_pressure', ...body } });
  assert.equal((await prop(a.coach.token, {})).status, 403);
  const r = ok(await prop(a.mentor.token, {}), 201);
  assert.equal(r.status, 'proposed');
  const handover = (token) => api('PATCH', `/academy/wellbeing/referrals/${r.id}`, { token, body: { action: 'hand_over' } });
  assert.equal((await handover(a.mentor.token)).status, 409);                                       // no consent yet
  assert.equal((await api('POST', `/me/wellbeing/referrals/${r.id}/respond`, { token: a.kid.token, body: { decision: 'consent' } })).status, 403);   // a young person cannot decide
  assert.equal((await api('POST', `/me/wellbeing/referrals/${r.id}/respond`, { token: a.coach.token, body: { decision: 'consent' } })).status, 404);
  const c = ok(await api('POST', `/me/wellbeing/referrals/${r.id}/respond`, { token: a.parent.token, body: { decision: 'consent' } }));
  assert.equal(c.status, 'consented'); assert.equal(c.consent_as, 'guardian');
  const dir = ok(await api('GET', `${a.W}/referrals`, { token: a.owner.token }))[0];
  assert.equal(dir.reason, null); assert.equal(dir.status, 'consented');
  assert.equal(ok(await api('GET', `${a.W}/referrals`, { token: a.mentor.token }))[0].reason, 'performance_pressure');
  ok(await handover(a.mentor.token));                                                                // family-chosen specialist: guidance only
  assert.equal((await pool.query('SELECT status FROM academy_wellbeing_referrals WHERE id=$1', [r.id])).rows[0].status, 'handed_over');
  assert.equal((await api('POST', `/me/wellbeing/referrals/${r.id}/respond`, { token: a.parent.token, body: { decision: 'withdraw' } })).status, 409);   // too late once handed over
  // a second one, declined
  const r2 = ok(await prop(a.mentor.token, { specialty: 'nutrition', reason: 'nutrition_support' }), 201);
  ok(await api('POST', `/me/wellbeing/referrals/${r2.id}/respond`, { token: a.parent.token, body: { decision: 'decline' } }));
  // withdrawing the referrals scope withdraws what is still open
  const r3 = ok(await prop(a.mentor.token, { specialty: 'learning_support', reason: 'school_balance' }), 201);
  ok(await consent(a, a.parent, a.kid, ['mentoring', 'checkins']), 201);
  assert.equal((await pool.query('SELECT status FROM academy_wellbeing_referrals WHERE id=$1', [r3.id])).rows[0].status, 'withdrawn');
});

test('tracks: owner configures, age band and consent are enforced per athlete, progress is entered by a person, leaving is free, small groups are suppressed', async () => {
  const a = await academy();
  const track = (body) => api('POST', `${a.W}/tracks`, { token: a.owner.token, body: { category: 'life_skills', title: 'Away from home', age_min: 11, age_max: 15, modules: [{ title: 'Packing and routines', outcome: 'Pack own bag' }, { title: 'Homesickness plan' }], ...body } });
  assert.equal((await api('POST', `${a.W}/tracks`, { token: a.mentor.token, body: { category: 'values', title: 'Values and respect', age_min: 8, age_max: 12, modules: [{ title: 'One' }] } })).status, 403);
  const t = ok(await track({}), 201);
  assert.equal((await track({ age_min: 16, age_max: 12 })).status, 400);
  const enrol = (ids) => api('POST', `/academy/wellbeing/tracks/${t.id}/members`, { token: a.mentor.token, body: { athlete_ids: ids } });
  let res = ok(await enrol([a.kid.id, a.adult.id, a.mentor.id]), 200).results;
  assert.deepEqual(res.map((x) => x.reason), ['consent_missing', 'consent_missing', 'not_an_academy_athlete']);
  ok(await consent(a, a.parent, a.kid, ['tracks']), 201);
  ok(await consent(a, a.adult, a.adult, ['tracks']), 201);
  res = ok(await enrol([a.kid.id, a.adult.id])).results;
  assert.equal(res[0].result, 'enrolled'); assert.equal(res[1].reason, 'outside_age_band');          // the adult is 22
  assert.equal(ok(await enrol([a.kid.id])).results[0].reason, 'already_in_track');
  const prog = (body) => api('POST', `/academy/wellbeing/tracks/${t.id}/members/${a.kid.id}`, { token: a.mentor.token, body });
  assert.equal(ok(await prog({ action: 'module_done', module_index: 0 })).modules_done.length, 1);
  assert.equal((await prog({ action: 'module_done', module_index: 9 })).status, 400);
  // the tracks list suppresses a group under five; the track view names the consenting member
  const listed = ok(await api('GET', `${a.W}/tracks`, { token: a.mentor.token }))[0];
  assert.equal(listed.participants, null); assert.equal(listed.participants_hidden, true);
  const overview = ok(await api('GET', a.W, { token: a.owner.token }));
  assert.equal(overview.tracks[0].participants, null); assert.equal(overview.tracks[0].completion_pct, null); assert.equal(overview.tracks[0].suppressed, true);
  assert.equal(ok(await api('GET', `/academy/wellbeing/tracks/${t.id}`, { token: a.mentor.token })).members.length, 1);
  // modules are append-only
  assert.equal((await track({ track_id: t.id, modules: [{ title: 'Only one' }] })).status, 409);
  ok(await track({ track_id: t.id, modules: [{ title: 'Packing and routines' }, { title: 'Homesickness plan' }, { title: 'Staying in touch' }] }), 201);
  // the family leaves whenever they like, no reason asked
  ok(await api('POST', `/me/wellbeing/tracks/${t.id}/leave`, { token: a.parent.token, body: { athlete_id: a.kid.id } }));
  assert.equal((await api('POST', `/me/wellbeing/tracks/${t.id}/leave`, { token: a.parent.token, body: { athlete_id: a.kid.id } })).status, 404);
  // archived tracks take no new members
  ok(await api('POST', `/academy/wellbeing/tracks/${t.id}/archive`, { token: a.owner.token }));
  assert.equal((await enrol([a.kid.id])).status, 409);
});

test('the director sees what is due and who owns it, never content; mentors see only their own; indicators carry no person-level score', async () => {
  const a = await mentored();
  ok(await api('POST', `${a.W}/checkins`, { token: a.mentor.token, body: { athlete_id: a.kid.id, scheduled_for: inDays(1) } }), 201);
  await pool.query("UPDATE academy_wellbeing_checkins SET scheduled_for = now() - interval '3 days' WHERE athlete_id=$1", [a.kid.id]);
  ok(await api('POST', `${a.W}/goals`, { token: a.mentor.token, body: { athlete_id: a.kid.id, title: 'Keep a training diary' } }), 201);
  const dir = ok(await api('GET', a.W, { token: a.owner.token }));
  assert.equal(dir.scope, 'organisation');
  const due = dir.actions.find((x) => x.kind === 'checkin_to_record');
  assert.ok(due, JSON.stringify(dir.actions)); assert.equal(due.athlete_id, a.kid.id); assert.equal(due.owner_id, a.mentor.id);
  assert.deepEqual(Object.keys(due).sort(), ['athlete_id', 'athlete_name', 'due_on', 'kind', 'owner_id', 'owner_name', 'ref_id']);
  assert.ok(dir.actions.some((x) => x.kind === 'needs_mentor') === false);
  assert.doesNotMatch(JSON.stringify(dir), /training diary/);
  assert.equal(dir.kpis.academy_athletes, 2); assert.equal(dir.coverage.mentoring.athletes, 1); assert.equal(dir.kpis.mentor_coverage_pct, 100);
  for (const bad of ['risk', 'score', 'personality']) assert.doesNotMatch(JSON.stringify(Object.keys(dir.kpis)), new RegExp(bad));
  const mine = ok(await api('GET', a.W, { token: a.mentor.token }));
  assert.equal(mine.scope, 'my_mentees'); assert.ok(mine.actions.every((x) => x.owner_id === a.mentor.id));
  assert.equal((await api('GET', a.W, { token: a.coach.token })).status, 403);
  assert.equal((await api('GET', a.W, { token: a.kid.token })).status, 404);
});

test('a mentor reads their mentee\'s record, the director gets statuses only, every look is in the family\'s transparency log, outsiders get 404', async () => {
  const a = await mentored();
  ok(await api('POST', `${a.W}/goals`, { token: a.mentor.token, body: { athlete_id: a.kid.id, title: 'Keep a training diary' } }), 201);
  const asMentor = ok(await api('GET', `${a.W}/athletes/${a.kid.id}`, { token: a.mentor.token }));
  assert.equal(asMentor.role, 'mentor'); assert.equal(asMentor.goals[0].title, 'Keep a training diary');
  const asDirector = ok(await api('GET', `${a.W}/athletes/${a.kid.id}`, { token: a.owner.token }));
  assert.equal(asDirector.role, 'oversight'); assert.equal(asDirector.goals[0].title, null);
  assert.equal((await api('GET', `${a.W}/athletes/${a.adult.id}`, { token: a.mentor.token })).status, 404);   // not their mentee
  assert.equal((await api('GET', `${a.W}/athletes/${a.kid.id}`, { token: a.coach.token })).status, 403);
  const log = ok(await api('GET', '/me/wellbeing', { token: a.parent.token, query: { athlete_id: a.kid.id } })).academies[0].timeline;
  assert.ok(log.some((e) => e.kind === 'record_viewed' && e.actor_name === a.mentor.display_name));
  assert.ok(log.some((e) => e.kind === 'consent_granted'));
  // the log cannot be edited or deleted
  await assert.rejects(pool.query('DELETE FROM academy_wellbeing_events WHERE athlete_id=$1', [a.kid.id]));
  await assert.rejects(pool.query("UPDATE academy_wellbeing_events SET kind='x' WHERE athlete_id=$1", [a.kid.id]));
});

test('guardian updates need their own consent and screen the note; consent requests notify without revealing anything', async () => {
  const a = await mentored(['mentoring', 'checkins']);
  const send = (body) => api('POST', `${a.W}/updates`, { token: a.mentor.token, body: { athlete_id: a.kid.id, template: 'thank_you', ...body } });
  assert.equal((await send({})).status, 409);                                                       // no guardian_updates scope
  ok(await consent(a, a.parent, a.kid, ALL), 201);
  assert.equal((await send({ note: 'Please discuss his medication' })).status, 422);
  assert.equal(ok(await send({ note: 'Great attitude this month' }), 201).sent_to, 1);
  const ask = ok(await api('POST', `${a.W}/consent-requests`, { token: a.mentor.token, body: { athlete_ids: [a.adult.id] } }));
  assert.equal(ask.asked, 1);
  const n = (await pool.query("SELECT body FROM notifications WHERE user_id=$1 AND kind='academy_wellbeing'", [a.adult.id])).rows;
  assert.ok(n.length >= 1); assert.doesNotMatch(JSON.stringify(n), /mentor|goal|referral|concern/i);
});

test('migrations are additive: the new tables exist, nothing is cascaded on user data, and the permission is in the staff templates', async () => {
  const t = (await pool.query("SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'academy\\_%wellbeing\\_%' OR table_name LIKE 'academy\\_dev\\_%' OR table_name='academy_mentor_assignments' ORDER BY 1")).rows.map((r) => r.table_name);
  for (const x of ['academy_dev_goals', 'academy_dev_track_members', 'academy_dev_tracks', 'academy_mentor_assignments', 'academy_wellbeing_checkins', 'academy_wellbeing_consents', 'academy_wellbeing_events', 'academy_wellbeing_referrals']) assert.ok(t.includes(x), x);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM information_schema.referential_constraints WHERE constraint_name IN (SELECT constraint_name FROM information_schema.table_constraints WHERE table_name LIKE 'academy\\_%wellbeing%' OR table_name LIKE 'academy\\_dev\\_%') AND delete_rule='CASCADE'")).rows[0].n, 0);
  const { PERMS, TEMPLATES } = await import('../src/academy-ops.js');
  assert.ok(PERMS.includes('wellbeing') && TEMPLATES.mentor.permissions.includes('wellbeing') && !TEMPLATES.coach.permissions.includes('wellbeing'));
});
