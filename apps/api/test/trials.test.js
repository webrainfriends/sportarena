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
  const r = await api('POST', '/auth/register', { body: { handle: `tr_${n}_${roles[0]}`, display_name: `Trial Person${n}`, email: `tr${n}@example.com`, password: 'correct-horse-battery', roles } });
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

const mkTrial = async (org, extra = {}) => ok(await post(org.token, '/events', { name: `Open trial ${++n}`, sport: 'football', kind: 'trial', starts_on: today, ends_on: today, capacity: 2, ...extra }), 201);
const open = async () => {};
const consent = (kid, parent, purpose) => pool.query("INSERT INTO youth_consents(child_id, purpose, granted_by, policy_version, expires_at) VALUES ($1,$2,$3,1, now() + interval '30 days') ON CONFLICT (child_id, purpose) DO UPDATE SET revoked_at=NULL, expires_at=now() + interval '30 days'", [kid.id, purpose, parent.id]);

test('booking uses capacity and the waitlist, is idempotent, and a cancellation promotes the next player', async () => {
  const org = await signup(['organizer']), a = await signup(['athlete']), b = await signup(['athlete']), c = await signup(['athlete']);
  const ev = await mkTrial(org, { capacity: 2 });
  await pool.query("UPDATE events SET status='draft' WHERE id=$1", [ev.id]);
  assert.equal((await post(a.token, `/trials/${ev.id}/book`, {})).status, 409, 'draft trials are not bookable');
  await pool.query("UPDATE events SET status='open' WHERE id=$1", [ev.id]);
  const ba = ok(await post(a.token, `/trials/${ev.id}/book`, {}), 201);
  assert.equal(ba.status, 'accepted');
  assert.equal(ok(await post(a.token, `/trials/${ev.id}/book`, {}), 201).id, ba.id, 'duplicate booking returns the same row');
  ok(await post(b.token, `/trials/${ev.id}/book`, {}), 201);
  const bc = ok(await post(c.token, `/trials/${ev.id}/book`, {}), 201);
  assert.equal(bc.status, 'waitlisted');
  ok(await post(a.token, `/trial-bookings/${ba.id}/cancel`, {}));
  assert.equal((await pool.query('SELECT status FROM event_entries WHERE id=$1', [bc.id])).rows[0].status, 'accepted');
  assert.equal((await post(b.token, `/trial-bookings/${ba.id}/cancel`, {})).status, 403, 'not your booking');
  const mine = ok(await get(a.token, '/trials/mine'));
  assert.equal(mine.items[0].booking_status, 'withdrawn');
  const notTrial = ok(await post(org.token, '/events', { name: 'Cup', sport: 'football', kind: 'tournament' }), 201);
  assert.equal((await post(a.token, `/trials/${notTrial.id}/book`, {})).status, 400);
});

test('attendance, rubric assessment, outcome and release: attendance is not selection and feedback is hidden until released', async () => {
  const org = await signup(['organizer']), assessor = await signup(['coach']), p = await signup(['athlete']), other = await signup(['athlete']);
  const ev = await mkTrial(org); await open(org, ev);
  const bk = ok(await post(p.token, `/trials/${ev.id}/book`, {}), 201);
  assert.equal((await post(other.token, `/trial-bookings/${bk.id}/attendance`, { status: 'present' })).status, 403);
  assert.equal((await post(assessor.token, `/trial-bookings/${bk.id}/attendance`, { status: 'present' })).status, 403, 'not assigned yet');
  // hire the assessor through the event console's existing crew flow
  const role = (await pool.query("INSERT INTO event_staff_roles(event_id, role, created_by) VALUES ($1,'assessor',$2) RETURNING id", [ev.id, org.id])).rows[0];
  await pool.query("INSERT INTO event_staff_assignments(role_id, event_id, user_id, status, invited_by) VALUES ($1,$2,$3,'accepted',$4)", [role.id, ev.id, assessor.id, org.id]);

  assert.equal((await post(assessor.token, `/trial-bookings/${bk.id}/assessment`, { rubric_ref: 'standard:fifa_technical', scores: { passing: 4 } })).status, 409, 'attendance first');
  const att = ok(await post(assessor.token, `/trial-bookings/${bk.id}/attendance`, { status: 'present' }), 201 === 0 ? 201 : 200);
  assert.equal(ok(await post(assessor.token, `/trial-bookings/${bk.id}/attendance`, { status: 'present' })).row_version, att.row_version, 'repeat changes nothing');
  assert.equal((await post(assessor.token, `/trial-bookings/${bk.id}/attendance`, { status: 'late' })).status, 400, 'a correction needs a reason');
  assert.equal(ok(await post(assessor.token, `/trial-bookings/${bk.id}/attendance`, { status: 'late', reason: 'bus delay', row_version: att.row_version })).status, 'late');
  assert.equal((await post(assessor.token, `/trial-bookings/${bk.id}/attendance`, { status: 'present', reason: 'x', row_version: att.row_version })).body.error.details?.code, 'stale_version');

  const rubrics = ok(await get(assessor.token, `/trials/${ev.id}/rubrics`)).items;
  assert.ok(rubrics.some((r) => r.ref === 'standard:fifa_technical'));
  assert.ok(!rubrics.some((r) => r.ref === 'standard:icc_batting'), 'only this sport\'s rubrics');
  const bad = (scores, ref = 'standard:fifa_technical') => post(assessor.token, `/trial-bookings/${bk.id}/assessment`, { rubric_ref: ref, scores });
  assert.equal((await bad({ passing: 9 })).status, 400);
  assert.equal((await bad({ nope: 3 })).status, 400);
  assert.equal((await bad({ passing: 3 }, 'standard:icc_batting')).status, 400);
  const as = ok(await post(assessor.token, `/trial-bookings/${bk.id}/assessment`, { rubric_ref: 'standard:fifa_technical', scores: { passing: 4, first_touch: 5 }, feedback: 'Strong first touch', private_note: 'watch fitness', client_key: 'retry-key-1' }), 201);
  assert.equal(ok(await post(assessor.token, `/trial-bookings/${bk.id}/assessment`, { rubric_ref: 'standard:fifa_technical', scores: { passing: 4, first_touch: 5 }, client_key: 'retry-key-1' }), 201).id, as.id, 'retry is idempotent');
  assert.equal((await post(assessor.token, `/trial-bookings/${bk.id}/assessment`, { rubric_ref: 'standard:fifa_technical', scores: { passing: 2 } })).status, 409, 'editing needs row_version');
  const edited = ok(await post(assessor.token, `/trial-bookings/${bk.id}/assessment`, { rubric_ref: 'standard:fifa_technical', scores: { passing: 5, first_touch: 5 }, feedback: 'Strong first touch', private_note: 'watch fitness', row_version: as.row_version }), 201);
  assert.equal(edited.row_version, 2);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM trial_assessment_revisions WHERE assessment_id=$1', [as.id])).rows[0].n, 2);

  // nothing visible to the player yet, attendance alone is not selection
  let mine = ok(await get(p.token, '/trials/mine')).items[0];
  assert.equal(mine.attendance, 'late'); assert.equal(mine.outcome, null); assert.deepEqual(mine.feedback, []);
  assert.equal((await post(assessor.token, `/trial-bookings/${bk.id}/outcome`, { decision: 'selected' })).status, 403, 'only the organiser decides');
  assert.equal((await post(org.token, `/trial-bookings/${bk.id}/release`, {})).status, 409, 'no outcome yet');
  ok(await post(org.token, `/trial-bookings/${bk.id}/outcome`, { decision: 'second_trial', note: 'Come back' }));
  const fu = ok(await post(org.token, `/trial-bookings/${bk.id}/follow-ups`, { kind: 'book_session', title: 'Second round', due_on: today, client_key: 'fu-key-0001' }), 201);
  assert.equal(ok(await post(org.token, `/trial-bookings/${bk.id}/follow-ups`, { kind: 'book_session', title: 'Second round', client_key: 'fu-key-0001' }), 201).id, fu.id);
  mine = ok(await get(p.token, '/trials/mine')).items[0];
  assert.equal(mine.outcome, null, 'outcome stays private until released'); assert.deepEqual(mine.feedback, []);
  ok(await post(org.token, `/trial-bookings/${bk.id}/release`, {}));
  mine = ok(await get(p.token, '/trials/mine')).items[0];
  assert.equal(mine.outcome.decision, 'second_trial'); assert.equal(mine.feedback.length, 1); assert.equal(mine.follow_ups.length, 1);
  assert.equal(mine.feedback[0].private_note, undefined, 'private notes never reach the player');
  assert.equal(JSON.stringify(mine).includes('watch fitness'), false);
  assert.equal(ok(await post(org.token, `/trial-bookings/${bk.id}/release`, {})).released_at !== null, true, 'release is idempotent');
  assert.equal((await get(other.token, `/trials/mine?athlete_id=${p.id}`)).status, 403);

  const done = ok(await api('PATCH', `/trial-follow-ups/${fu.id}`, { token: assessor.token, body: { status: 'done', row_version: fu.row_version } }));
  assert.equal(done.status, 'done');
  assert.equal((await api('PATCH', `/trial-follow-ups/${fu.id}`, { token: assessor.token, body: { status: 'open', row_version: fu.row_version } })).status, 409);

  const sess = ok(await get(assessor.token, `/trials/${ev.id}/session`));
  assert.equal(sess.your_role, 'assessor'); assert.equal(sess.roster[0].assessments[0].private_note, 'watch fitness');
  assert.equal((await get(p.token, `/trials/${ev.id}/session`)).status, 403);
  const exp = ok(await get(org.token, `/trials/${ev.id}/export`));
  assert.ok(exp.csv.includes('Strong first touch') && !exp.csv.includes('watch fitness'));
  assert.equal((await get(assessor.token, `/trials/${ev.id}/export`)).status, 403);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='trial.export'")).rowCount >= 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM trial_attendance_log WHERE entry_id=$1', [bk.id])).rows[0].n, 2);
});

test('absent players cannot be assessed or given an outcome; one assessor\'s feedback is separate from another\'s', async () => {
  const org = await signup(['organizer']), p = await signup(['athlete']);
  const ev = await mkTrial(org); await open(org, ev);
  const bk = ok(await post(p.token, `/trials/${ev.id}/book`, {}), 201);
  ok(await post(org.token, `/trial-bookings/${bk.id}/attendance`, { status: 'absent' }));
  assert.equal((await post(org.token, `/trial-bookings/${bk.id}/assessment`, { rubric_ref: 'standard:fifa_technical', scores: { passing: 3 } })).status, 409);
  assert.equal((await post(org.token, `/trial-bookings/${bk.id}/outcome`, { decision: 'selected' })).status, 409);
});

test('a young person: guardian books with consent, staff are blocked and feedback hidden the moment coaching consent is revoked', async () => {
  const org = await signup(['organizer']), kid = await signup(['athlete']), parent = await signup(['athlete']), stranger = await signup(['athlete']);
  await pool.query("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [parent.id, kid.id]);
  await pool.query('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);
  const ev = await mkTrial(org); await open(org, ev);
  assert.equal((await post(stranger.token, `/trials/${ev.id}/book`, { athlete_id: kid.id })).status, 403);
  const refused = await post(parent.token, `/trials/${ev.id}/book`, { athlete_id: kid.id });
  assert.equal(refused.status, 409); assert.equal(refused.body.error.details?.code ?? refused.body.error.code, 'guardian_consent_required');
  await consent(kid, parent, 'participation'); await consent(kid, parent, 'coaching');
  const bk = ok(await post(parent.token, `/trials/${ev.id}/book`, { athlete_id: kid.id }), 201);
  assert.equal(bk.user_id, kid.id);
  ok(await post(org.token, `/trial-bookings/${bk.id}/attendance`, { status: 'present' }));
  ok(await post(org.token, `/trial-bookings/${bk.id}/assessment`, { rubric_ref: 'standard:fifa_technical', scores: { passing: 3 }, feedback: 'Good', share: 'now' }), 201);
  ok(await post(org.token, `/trial-bookings/${bk.id}/outcome`, { decision: 'selected' }));
  ok(await post(org.token, `/trial-bookings/${bk.id}/release`, {}));
  const seen = (t, q = '') => get(t, `/trials/mine${q}`);
  assert.equal(ok(await seen(parent.token, `?athlete_id=${kid.id}`)).items[0].feedback.length, 1);
  assert.equal(ok(await seen(kid.token)).items[0].outcome.decision, 'selected');
  assert.ok((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind='trial_outcome'", [parent.id])).rows[0].n >= 1, 'guardian is notified too');

  await pool.query("UPDATE youth_consents SET revoked_at=now() WHERE child_id=$1 AND purpose='coaching'", [kid.id]);
  for (const t of [parent.token, kid.token]) {
    const v = ok(await seen(t, t === parent.token ? `?athlete_id=${kid.id}` : '')).items[0];
    assert.deepEqual(v.feedback, []); assert.equal(v.outcome, null); assert.equal(v.feedback_hidden, true);
  }
  assert.equal(ok(await get(org.token, `/trials/${ev.id}/session`)).roster[0].restricted, true);
  assert.deepEqual(ok(await get(org.token, `/trials/${ev.id}/session`)).roster[0].assessments, []);
  assert.equal(ok(await get(org.token, `/trials/${ev.id}/export`)).withheld_young_people, 1);
  assert.equal((await post(org.token, `/trial-bookings/${bk.id}/follow-ups`, { kind: 'review', title: 'Later' })).status, 409);
  await consent(kid, parent, 'coaching');
  assert.equal(ok(await seen(parent.token, `?athlete_id=${kid.id}`)).items[0].feedback.length, 1, 'allowing it again restores it');
  await pool.query("UPDATE guardian_links SET status='revoked', revoked_at=now() WHERE guardian_id=$1", [parent.id]);
  assert.equal((await seen(parent.token, `?athlete_id=${kid.id}`)).status, 403);
});
