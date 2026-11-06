import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// PS-14 Adaptive Academy Enrolment-to-Training Integration: enrolment prompts, change-of-programme, guardian progress, session staff match.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');

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
  const r = await api('POST', '/auth/register', { body: { handle: `ioptest_${n}_${roles[0]}`, display_name: `IopTest ${n}`, email: `ioptest${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('iop_root','iop_root','{admin}','x','x','iop_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

async function setup() {
  const owner = await signup();
  const coach = await signup(['coach']);
  const org = ok(await api('POST', '/organisations', { token: owner.token, body: { name: `IncOps ${n}`, kind: 'academy' } }), 201);
  ok(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: coach.handle, role: 'coach' } }), 201);
  ok(await api('POST', `/organisations/${org.id}/invite/respond`, { token: coach.token, body: { accept: true } }));
  const athlete = await signup(['athlete'], { dob: yearsAgo(22) });

  // Insert two programmes directly
  const progA = (await pool.query(
    "INSERT INTO academy_programmes(organisation_id, sport, title, status, public, created_by) VALUES ($1,'wheelchair-basketball','Programme A','published',true,$2) RETURNING *",
    [org.id, owner.id],
  )).rows[0];
  const progB = (await pool.query(
    "INSERT INTO academy_programmes(organisation_id, sport, title, status, public, created_by) VALUES ($1,'wheelchair-basketball','Programme B','published',true,$2) RETURNING *",
    [org.id, owner.id],
  )).rows[0];

  // Insert inclusion config on progA
  await pool.query(
    "INSERT INTO academy_programme_inclusion(programme_id, organisation_id, offered_needs, requirements, updated_by) VALUES ($1,$2,'{mobility}','{}',$3) ON CONFLICT DO NOTHING",
    [progA.id, org.id, owner.id],
  );

  // Enrol athlete into progA
  const cohort = ok(await api('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: `Cohort ${n}`, coach_id: coach.id } }), 201);
  ok(await api('POST', `/cohorts/${cohort.id}/enrolments`, { token: owner.token, body: { csv: `handle,consent\n${athlete.handle},yes` } }), 201);
  const enrolment = (await pool.query('SELECT e.id FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.organisation_id=$1 AND e.user_id=$2 LIMIT 1', [org.id, athlete.id])).rows[0];
  // Link enrolment to programme
  await pool.query('UPDATE org_enrolments SET programme_id=$1 WHERE id=$2', [progA.id, enrolment.id]);

  return { org, owner, coach, athlete, progA, progB, enrolment };
}

test('enrolment_prompt: returns has_requirements true for inclusive programme', async () => {
  const { org, owner, athlete, progA } = await setup();
  const r = ok(await api('GET', `/organisations/${org.id}/academy/inclusion/enrolment-prompt`, { token: owner.token, query: { programme_id: progA.id, athlete_id: athlete.id } }));
  assert.equal(r.has_requirements, true);
  // Confirm no diagnosis fields
  assert.ok(!('diagnosis' in r));
  assert.ok(!('medical_notes' in r));
});

test('enrolment_prompt: returns has_requirements false for non-inclusive programme', async () => {
  const { org, owner, athlete, progB } = await setup();
  const r = ok(await api('GET', `/organisations/${org.id}/academy/inclusion/enrolment-prompt`, { token: owner.token, query: { programme_id: progB.id, athlete_id: athlete.id } }));
  assert.equal(r.has_requirements, false);
});

test('dismiss_enrolment_prompt: marks prompt dismissed', async () => {
  const { org, owner, athlete, progA, enrolment } = await setup();
  // Create the prompt record first
  await pool.query(
    'INSERT INTO academy_enrolment_inclusion_prompts(org_id, enrolment_id, athlete_id, programme_id) VALUES ($1,$2,$3,$4)',
    [org.id, enrolment.id, athlete.id, progA.id],
  );
  ok(await api('POST', `/organisations/${org.id}/academy/inclusion/enrolment-prompt/dismiss`, {
    token: owner.token,
    body: { enrolment_id: enrolment.id },
  }));
  const row = (await pool.query('SELECT dismissed_at FROM academy_enrolment_inclusion_prompts WHERE enrolment_id=$1', [enrolment.id])).rows[0];
  assert.ok(row.dismissed_at != null);
});

test('change_of_programme: moves athlete between programmes', async () => {
  const { org, owner, athlete, progA, progB } = await setup();
  const r = ok(await api('POST', `/organisations/${org.id}/academy/change-of-programme`, {
    token: owner.token,
    body: { athlete_id: athlete.id, from_programme_id: progA.id, to_programme_id: progB.id, reason: 'Level up' },
  }), 201);
  assert.ok(r.id);
  assert.equal(r.to_programme_id, progB.id);
  assert.equal(r.shares_revoked + r.shares_carried + r.shares_prompted >= 0, true);
  // Confirm no diagnosis in response
  assert.ok(!('diagnosis' in r));
});

test('change_of_programme: rejects non-member actor', async () => {
  const { org, athlete, progA, progB } = await setup();
  const outsider = await signup();
  const r = await api('POST', `/organisations/${org.id}/academy/change-of-programme`, {
    token: outsider.token,
    body: { athlete_id: athlete.id, from_programme_id: progA.id, to_programme_id: progB.id },
  });
  assert.ok(r.status === 403 || r.status === 404);
});

test('guardian_inclusive_progress: requires guardian or staff auth', async () => {
  const { org, athlete } = await setup();
  const outsider = await signup();
  const r = await api('GET', `/organisations/${org.id}/academy/guardian-progress/${athlete.id}`, { token: outsider.token });
  assert.ok(r.status === 403 || r.status === 404);
});

test('guardian_inclusive_progress: returns progress structure for org member', async () => {
  const { org, owner, athlete } = await setup();
  const r = ok(await api('GET', `/organisations/${org.id}/academy/guardian-progress/${athlete.id}`, { token: owner.token }));
  assert.ok('athlete_id' in r);
  assert.ok(Array.isArray(r.programmes));
  // No diagnosis fields
  assert.ok(!('diagnosis' in r));
  assert.ok(!('classification_details' in r));
});

test('get_session_staff_match: returns staff match for inclusive session', async () => {
  const { org, owner, coach, progA } = await setup();
  // Create a session for progA
  const cohort = (await pool.query('SELECT id FROM cohorts WHERE organisation_id=$1 LIMIT 1', [org.id])).rows[0];
  const sess = (await pool.query(
    "INSERT INTO academy_sessions(organisation_id, cohort_id, programme_id, status, sport, starts_at, ends_at, timezone) VALUES ($1,$2,$3,'scheduled','wheelchair-basketball', now()+interval '1 day', now()+interval '1 day'+interval '1 hour', 'UTC') RETURNING id",
    [org.id, cohort.id, progA.id],
  )).rows[0];
  // Assign coach to session
  await pool.query(
    "INSERT INTO academy_session_staff(session_id, user_id, role, status) VALUES ($1,$2,'coach','assigned')",
    [sess.id, coach.id],
  );
  const r = ok(await api('GET', `/academy/sessions/${sess.id}/staff-match`, { token: owner.token }));
  assert.ok(Array.isArray(r.staff));
  // Confirm no athlete data or diagnoses in response
  r.staff.forEach((p) => {
    assert.ok(!('athlete_id' in p));
    assert.ok(!('diagnosis' in p));
  });
});
