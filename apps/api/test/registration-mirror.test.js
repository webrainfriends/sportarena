import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `mx_${n}_${roles[0]}`, display_name: `Mx ${n}`, email: `mx${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('mx_root','mx_root','{admin}','x','x','mx_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const report = async () => must(await api('GET', '/admin/registration-mirror', { token: admin.token }));
const mirrorProgramme = async (org, legacyId) => (must(await api('GET', '/registration-programmes', { token: org.token, query: { scope: 'managed' } })).find((p) => p.legacy_type && p.event_id === legacyId));

test('competition roster registrations are mirrored live, read-only in the engine, and in parity', async () => {
  const org = await signup(['organizer']), mgr = await signup(), pl = await signup();
  const team = must(await api('POST', '/teams', { token: mgr.token, body: { name: `Bats ${++n}`, sport: 'cricket' } }), 201);
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: `Cup ${n}`, sport: 'cricket', starts_on: day(5), ends_on: day(30) } }), 201);
  const en = must(await api('POST', `/events/${ev.id}/entries`, { token: mgr.token, body: { team_id: team.id } }), 201);
  must(await api('PATCH', `/entries/${en.id}`, { token: org.token, body: { status: 'accepted' } }));
  must(await api('POST', `/teams/${team.id}/members`, { token: mgr.token, body: { user_id: pl.id } }), 201);
  const reg = must(await api('POST', `/events/${ev.id}/registrations`, { token: mgr.token, body: { team_id: team.id, user_id: pl.id } }), 201);
  const prog = await mirrorProgramme(org, ev.id);
  assert.ok(prog, 'the competition has a mirrored programme'); assert.equal(prog.status, 'closed'); assert.equal(prog.legacy_type, 'event_registration');
  let list = must(await api('GET', `/registration-programmes/${prog.id}/entries`, { token: org.token }));
  assert.equal(list.length, 1); assert.equal(list[0].status, 'submitted'); assert.equal(list[0].legacy_type, 'roster_registration');
  // the legacy flow decides; the mirror follows in the same transaction, history included
  must(await api('POST', `/registrations/${reg.id}/review`, { token: org.token, body: { action: 'register', row_version: reg.row_version } }));
  list = must(await api('GET', `/registration-programmes/${prog.id}/entries`, { token: org.token }));
  assert.equal(list[0].status, 'approved');
  const view = must(await api('GET', `/registration-entries/${list[0].id}`, { token: org.token }));
  assert.ok(view.history.length >= 2); assert.equal(view.managed_in.kind, 'roster_registration'); assert.equal(view.can.decide, false);
  // the player and the manager see it in their own list, with the right status
  assert.equal(must(await api('GET', '/me/registration-entries', { token: pl.token }))[0].status, 'approved');
  // nobody can change it through the engine
  const refused = await api('POST', `/registration-entries/${list[0].id}/decision`, { token: org.token, body: { action: 'reject', row_version: view.row_version, note: 'no' } });
  assert.equal(refused.status, 409); assert.equal(refused.body.error.details.code, 'managed_elsewhere');
  assert.equal((await api('POST', `/registration-programmes/${prog.id}/entries`, { token: pl.token, body: { answers: {} } })).status, 409, 'a mirrored programme is never open for new engine registrations');
  assert.equal((await api('POST', `/registration-programmes/${prog.id}/status`, { token: org.token, body: { status: 'open' } })).status, 409);
  const w = must(await api('POST', `/registrations/${reg.id}/withdraw`, { token: mgr.token, body: { row_version: (await pool.query('SELECT row_version FROM reg_registrations WHERE id=$1', [reg.id])).rows[0].row_version } }));
  assert.equal(must(await api('GET', `/registration-programmes/${prog.id}/entries`, { token: org.token }))[0].status, 'withdrawn');
  assert.equal(w.status, 'withdrawn');
  const r = await report(); assert.equal(r.in_parity, true); assert.equal(r.roster_registrations.legacy, 1);
  assert.equal((await api('GET', '/admin/registration-mirror', { token: mgr.token })).status, 403);
});

test('backfill: rows written while the mirror was off are found by the report and repaired by the same functions', async () => {
  const org = await signup(['organizer']), mgr = await signup(), pl = await signup();
  const team = must(await api('POST', '/teams', { token: mgr.token, body: { name: `Owls ${++n}`, sport: 'cricket' } }), 201);
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: `Shield ${n}`, sport: 'cricket', starts_on: day(5), ends_on: day(30) } }), 201);
  const en = must(await api('POST', `/events/${ev.id}/entries`, { token: mgr.token, body: { team_id: team.id } }), 201);
  must(await api('PATCH', `/entries/${en.id}`, { token: org.token, body: { status: 'accepted' } }));
  must(await api('POST', `/teams/${team.id}/members`, { token: mgr.token, body: { user_id: pl.id } }), 201);
  await pool.query('ALTER TABLE reg_registrations DISABLE TRIGGER rx_mirror_roster; ALTER TABLE reg_history DISABLE TRIGGER rx_mirror_roster_history');
  must(await api('POST', `/events/${ev.id}/registrations`, { token: mgr.token, body: { team_id: team.id, user_id: pl.id } }), 201);
  await pool.query('ALTER TABLE reg_registrations ENABLE TRIGGER rx_mirror_roster; ALTER TABLE reg_history ENABLE TRIGGER rx_mirror_roster_history');
  const before = await report();
  assert.equal(before.in_parity, false); assert.equal(before.roster_registrations.missing, 1); assert.ok(before.roster_registrations.history_missing >= 1);
  // the migration's backfill, re-run: idempotent and additive
  const legacyBefore = (await pool.query('SELECT count(*) FROM reg_registrations')).rows[0].count;
  await pool.query('SELECT rx_mirror_roster(r) FROM reg_registrations r');
  await pool.query("SELECT rx_mirror_history('roster_registration', h.id, h.registration_id, h.action, rx_map_roster_status(h.from_status), rx_map_roster_status(coalesce(h.to_status, h.from_status)), h.actor_id, h.created_at) FROM reg_history h");
  await pool.query('SELECT rx_mirror_roster(r) FROM reg_registrations r');
  const after = await report();
  assert.equal(after.in_parity, true);
  assert.equal((await pool.query('SELECT count(*) FROM reg_registrations')).rows[0].count, legacyBefore, 'legacy rows untouched');
  assert.equal(Number((await pool.query("SELECT count(*) FROM rx_entries WHERE legacy_type='roster_registration' AND participant_id=$1", [pl.id])).rows[0].count), 1, 'no duplicates');
});

test('academy admissions are mirrored with the stage mapped, and are read-only in the engine', async () => {
  const owner = await signup(), ath = await signup();
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Mirror Academy ${++n}`, kind: 'academy' } }), 201);
  const pr = (await pool.query("INSERT INTO academy_programmes(organisation_id, sport, title) VALUES ($1,'football',$2) RETURNING id", [org.id, `U12 ${n}`])).rows[0];
  const app = (await pool.query("INSERT INTO academy_applications(organisation_id, programme_id, athlete_id, applicant_id, stage) VALUES ($1,$2,$3,$3,'enquiry') RETURNING id", [org.id, pr.id, ath.id])).rows[0];
  await pool.query("INSERT INTO academy_application_events(application_id, to_stage, actor_id) VALUES ($1,'enquiry',$2)", [app.id, ath.id]);
  const mine = must(await api('GET', '/me/registration-entries', { token: ath.token }));
  assert.equal(mine.length, 1); assert.equal(mine[0].status, 'draft'); assert.equal(mine[0].kind, 'course');
  for (const [stage, want] of [['submitted', 'submitted'], ['offered', 'under_review'], ['waitlisted', 'waitlisted'], ['enrolled', 'approved'], ['declined', 'rejected'], ['expired', 'expired']]) {
    await pool.query('UPDATE academy_applications SET stage=$2 WHERE id=$1', [app.id, stage]);
    await pool.query("INSERT INTO academy_application_events(application_id, from_stage, to_stage, actor_id) VALUES ($1,'enquiry',$2,$3)", [app.id, stage, owner.id]);
    assert.equal((await pool.query("SELECT status FROM rx_entries WHERE legacy_type='academy_application' AND legacy_id=$1", [app.id])).rows[0].status, want, stage);
  }
  const eid = (await pool.query("SELECT id FROM rx_entries WHERE legacy_type='academy_application'")).rows[0].id;
  const view = must(await api('GET', `/registration-entries/${eid}`, { token: ath.token }));
  assert.equal(view.managed_in.kind, 'academy_application'); assert.equal(view.programme.kind, 'course'); assert.ok(view.history.length >= 7);
  assert.equal((await api('POST', `/registration-entries/${eid}/withdraw`, { token: ath.token, body: { row_version: view.row_version } })).status, 409);
  assert.equal((await api('GET', `/registration-entries/${eid}`, { token: (await signup()).token })).status, 404, 'outsiders still get 404');
  const r = await report(); assert.equal(r.in_parity, true); assert.equal(r.academy_applications.legacy, 1);
  assert.ok(r.not_mirrored[0].startsWith('sponsorship_applications'));
});

test('a mirror failure never breaks a legacy write', async () => {
  const owner = await signup(), ath = await signup();
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Safe Academy ${++n}`, kind: 'academy' } }), 201);
  const pr = (await pool.query("INSERT INTO academy_programmes(organisation_id, sport, title) VALUES ($1,'football',$2) RETURNING id", [org.id, `U10 ${n}`])).rows[0];
  await pool.query('ALTER TABLE rx_programmes RENAME TO rx_programmes_off');
  try {
    const a = (await pool.query("INSERT INTO academy_applications(organisation_id, programme_id, athlete_id, applicant_id, stage) VALUES ($1,$2,$3,$3,'submitted') RETURNING id", [org.id, pr.id, ath.id])).rows[0];
    assert.ok(a.id, 'the legacy insert succeeded even though the mirror could not write');
  } finally { await pool.query('ALTER TABLE rx_programmes_off RENAME TO rx_programmes'); }
  assert.equal((await report()).academy_applications.missing, 1, 'and the report shows the gap');
});
