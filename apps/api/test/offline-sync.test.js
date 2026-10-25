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
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `os_${n}_${roles[0]}`, display_name: `OS Person${n}`, email: `os${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const post = (t, p, body) => api('POST', p, { token: t, body });
const get = (t, p) => api('GET', p, { token: t });
const patch = (t, p, body) => api('PATCH', p, { token: t, body });
const del = (t, p) => api('DELETE', p, { token: t });
const inFuture = (days, hour = 9) => { const d = new Date(Date.now() + days * 864e5); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

let k = 0;
const key = () => `k${Date.now()}-${++k}-abcdef`;
const device = (id = 'device-phone-0001', platform = 'ios') => ({ id, label: 'My phone', platform });
const sync = (u, ops, dev = device()) => post(u.token, '/me/sync', { device: dev, ops });
const player = async () => {
  const u = await signup();
  const p = ok(await post(u.token, '/me/sport-profiles', { sport: 'football', role: 'athlete', level: 'amateur' }), 201);
  return { u, p };
};
const matchOp = (p, extra = {}, client_key = key()) => ({ kind: 'match_create', client_key, data: { sport_profile_id: p.id, played_on: '2026-01-10', opponent: 'Reds', score_for: 2, score_against: 1, minutes: 90, notes: 'Strong second half', stats: { goals: 1 }, ...extra } });

test('a match log captured offline is applied once, however many times it is uploaded', async () => {
  const { u, p } = await player();
  const op = matchOp(p);
  const first = ok(await sync(u, [op]));
  assert.equal(first.applied, 1); assert.equal(first.results[0].status, 'applied'); assert.equal(first.results[0].row_version, 1);
  const again = ok(await sync(u, [op]));
  assert.equal(again.duplicate, 1); assert.equal(again.results[0].target_id, first.results[0].target_id);
  // two uploads racing each other (two devices, or a retry while the first is in flight)
  const racing = matchOp(p, { opponent: 'Blues' });
  const both = await Promise.all([sync(u, [racing]), sync(u, [racing], device('device-tablet-0002', 'ipados'))]);
  both.forEach((r) => ok(r));
  const ids = new Set(both.map((r) => r.body.results[0].target_id));
  assert.equal(ids.size, 1, 'one record');
  const rows = (await pool.query("SELECT count(*)::int AS n FROM player_matches WHERE user_id=$1", [u.id])).rows[0].n;
  assert.equal(rows, 2);
  // the plain API is idempotent too
  const body = { sport_profile_id: p.id, played_on: '2026-02-01', client_key: key() };
  const a = ok(await post(u.token, '/me/matches', body), 201), b = ok(await post(u.token, '/me/matches', body), 201);
  assert.equal(a.id, b.id);
  assert.equal(ok(await get(u.token, '/me/sync/devices')).length, 2);
});

test('bad drafts are refused with a reason and kept, one bad item does not stop the rest, and the same key cannot change kind', async () => {
  const { u, p } = await player();
  const stranger = await player();
  const bad = matchOp(p, { played_on: 'not-a-date' });
  const foreign = matchOp(stranger.p);
  const good = matchOp(p);
  const r = ok(await sync(u, [bad, foreign, good, { kind: 'load_log', client_key: good.client_key, data: { minutes: 30, rpe: 5 } }]));
  assert.deepEqual(r.results.map((x) => x.status), ['rejected', 'rejected', 'applied', 'rejected']);
  assert.equal(r.results[1].code, 'not_found', 'someone else\'s profile looks like it does not exist');
  assert.equal(r.results[0].code, 'bad_request');
  const refused = ok(await get(u.token, '/me/sync/operations?status=rejected'));
  assert.equal(refused.length, 2);
  assert.equal(refused.find((x) => x.client_key === bad.client_key).draft.data.played_on, 'not-a-date', 'the draft stays with the player');
  // fixed and re-sent under the same key: now applied
  const fixed = ok(await sync(u, [{ ...bad, data: { ...bad.data, played_on: '2026-01-12' } }]));
  assert.equal(fixed.results[0].status, 'applied');
  assert.equal((await post(u.token, '/me/sync', { device: device(), ops: [] })).status, 400, 'empty batch');
  assert.equal((await post(u.token, '/me/sync', { device: device(), ops: Array.from({ length: 51 }, () => matchOp(p)) })).status, 400, 'at most 50');
  assert.equal(ok(await sync(u, [matchOp(p, {}, 'dup-key-0001'), matchOp(p, {}, 'dup-key-0001')])).results[1].status, 'rejected');
  assert.equal((await post(u.token, '/me/sync', { device: device(), ops: [{ kind: 'load_log', client_key: 'short', data: { minutes: 30, rpe: 5 } }] })).status, 400, 'key too short');
  assert.equal((await api('POST', '/me/sync', { body: { device: device(), ops: [matchOp(p)] } })).status, 401);
});

test('an edit from an out-of-date copy becomes a conflict; the player settles it and nothing is lost', async () => {
  const { u, p } = await player();
  const made = ok(await sync(u, [matchOp(p)])).results[0];
  // another device edits first
  const second = ok(await sync(u, [{ kind: 'match_update', client_key: key(), target_id: made.target_id, base_version: 1, changes: { minutes: 74 } }], device('device-tablet-0002', 'ipados'))).results[0];
  assert.equal(second.status, 'applied'); assert.equal(second.row_version, 2);
  // the phone, still on version 1, edits minutes and notes
  const stale = { kind: 'match_update', client_key: key(), target_id: made.target_id, base_version: 1, changes: { minutes: 85, notes: 'Played on the wing' } };
  const c = ok(await sync(u, [stale])).results[0];
  assert.equal(c.status, 'conflict'); assert.equal(c.code, 'stale_version');
  assert.equal(ok(await sync(u, [stale])).results[0].status, 'conflict', 'a retry returns the same conflict');
  assert.equal((await pool.query('SELECT minutes FROM player_matches WHERE id=$1', [made.target_id])).rows[0].minutes, 74, 'the server copy was not overwritten');

  const [item] = ok(await get(u.token, '/me/sync/operations?status=conflict'));
  assert.equal(item.draft.changes.minutes, 85); assert.equal(item.server.minutes, 74); assert.equal(item.server.row_version, 2);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='read_sync_drafts'", [u.id])).rows.length, 'reading drafts is audited');
  const raw = (await pool.query('SELECT payload_enc FROM sync_operations WHERE id=$1', [item.id])).rows[0].payload_enc;
  assert.ok(raw.startsWith('v1.') && !raw.includes('wing'), 'the draft is encrypted at rest');

  const other = await signup();
  assert.equal((await post(other.token, `/me/sync/operations/${item.id}/resolve`, { resolution: 'keep_mine' })).status, 404, 'nobody else can settle it');
  assert.equal((await post(u.token, `/me/sync/operations/${item.id}/resolve`, { resolution: 'merge' })).status, 400, 'merge needs fields');
  const merged = ok(await post(u.token, `/me/sync/operations/${item.id}/resolve`, { resolution: 'merge', fields: ['notes'] }));
  assert.equal(merged.row_version, 3);
  const row = (await pool.query('SELECT minutes, notes FROM player_matches WHERE id=$1', [made.target_id])).rows[0];
  assert.equal(row.minutes, 74); assert.equal(row.notes, 'Played on the wing');
  assert.equal(ok(await post(u.token, `/me/sync/operations/${item.id}/resolve`, { resolution: 'merge', fields: ['notes'] })).status, 'resolved', 'settling twice is safe');
  assert.equal((await post(u.token, `/me/sync/operations/${item.id}/resolve`, { resolution: 'keep_mine' })).status, 409);
  const revisions = (await pool.query('SELECT row_version, reason FROM player_match_revisions WHERE match_id=$1 ORDER BY row_version', [made.target_id])).rows;
  assert.deepEqual(revisions.map((r) => r.reason), ['sync_update', 'conflict_merge'], 'every replaced version is kept');

  // keep_mine and keep_server on a fresh conflict
  const stale2 = { kind: 'match_update', client_key: key(), target_id: made.target_id, base_version: 1, changes: { minutes: 60 } };
  ok(await sync(u, [stale2]));
  const c2 = ok(await get(u.token, '/me/sync/operations?status=conflict'))[0];
  ok(await post(u.token, `/me/sync/operations/${c2.id}/resolve`, { resolution: 'keep_server' }));
  assert.equal((await pool.query('SELECT minutes FROM player_matches WHERE id=$1', [made.target_id])).rows[0].minutes, 74);
  const kept = ok(await get(u.token, '/me/sync/operations?status=resolved')).find((x) => x.id === c2.id);
  assert.equal(kept.resolution, 'keep_server'); assert.equal((await pool.query('SELECT payload_enc IS NOT NULL AS has FROM sync_operations WHERE id=$1', [c2.id])).rows[0].has, true, 'the losing draft is kept');
  const stale3 = { kind: 'match_update', client_key: key(), target_id: made.target_id, base_version: 1, changes: { minutes: 61 } };
  ok(await sync(u, [stale3]));
  const c3 = ok(await get(u.token, '/me/sync/operations?status=conflict'))[0];
  ok(await post(u.token, `/me/sync/operations/${c3.id}/resolve`, { resolution: 'keep_mine' }));
  assert.equal((await pool.query('SELECT minutes FROM player_matches WHERE id=$1', [made.target_id])).rows[0].minutes, 61);
  // an update to someone else's match is not found
  const { u: v, p: vp } = await player();
  const theirs = ok(await sync(v, [matchOp(vp)])).results[0];
  assert.equal(ok(await sync(u, [{ kind: 'match_update', client_key: key(), target_id: theirs.target_id, base_version: 1, changes: { minutes: 1 } }])).results[0].code, 'not_found');
});

test('training loads are idempotent and a future date is refused', async () => {
  const { u } = await player();
  const op = { kind: 'load_log', client_key: key(), data: { kind: 'gym', minutes: 45, rpe: 7 } };
  assert.equal(ok(await sync(u, [op])).results[0].status, 'applied');
  assert.equal(ok(await sync(u, [op])).results[0].status, 'duplicate');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM session_loads WHERE user_id=$1', [u.id])).rows[0].n, 1);
  const future = ok(await sync(u, [{ kind: 'load_log', client_key: key(), data: { date: '2999-01-01', minutes: 10, rpe: 3 } }])).results[0];
  assert.equal(future.status, 'rejected');
});

// a coach and athlete with a confirmed hire, and one structured session the athlete has accepted
const workout = async (athlete) => {
  const coach = await signup(['coach']);
  ok(await post(coach.token, '/me/sport-profiles', { sport: 'athletics', role: 'coach', level: 'pro', hourly_rate_cents: 50000 }), 201);
  const hire = ok(await post(athlete.token, '/hires', { coach_id: coach.id, sport: 'athletics', starts_at: inFuture(2), duration_min: 60 }), 201);
  ok(await patch(coach.token, `/hires/${hire.id}`, { status: 'confirmed' }));
  const reps = { id: 'rep800', kind: 'interval', label: '800 m repeats', sets: 5, work_m: 800, rest_sec: 120 };
  const plan = ok(await post(coach.token, '/training-plans', { athlete_id: athlete.id, sport: 'athletics', title: 'Block', content: { sessions: [{ starts_at: inFuture(3, 17), duration_min: 60, kind: 'conditioning', title: 'Reps', blocks: [reps] }] } }), 201);
  ok(await post(coach.token, `/training-plans/${plan.id}/propose`));
  ok(await post(athlete.token, `/training-plans/${plan.id}/respond`, { response: 'accepted' }));
  return { coach, session: ok(await get(athlete.token, `/training-plans/${plan.id}`)).sessions[0] };
};

test('a workout log is applied once; a stale copy conflicts and can be re-applied on top of the newer version', async () => {
  const u = await signup();
  const { session } = await workout(u);
  const half = [{ block_id: 'rep800', completed: false, sets_done: 3, distance_m: 2400 }];
  const op = { kind: 'workout_log', client_key: key(), session_id: session.id, expected_version: 1, actuals: half };
  assert.equal(ok(await sync(u, [op])).results[0].status, 'applied');
  assert.equal(ok(await sync(u, [op])).results[0].status, 'duplicate', 'a retry does not bump the version again');
  assert.equal((await pool.query('SELECT version FROM training_sessions WHERE id=$1', [session.id])).rows[0].version, 2);
  const stale = { kind: 'workout_log', client_key: key(), session_id: session.id, expected_version: 1, status: 'completed', athlete_rpe: 8, actuals: [{ block_id: 'rep800', completed: true, sets_done: 5, distance_m: 4000 }] };
  const c = ok(await sync(u, [stale])).results[0];
  assert.equal(c.status, 'conflict');
  const [item] = ok(await get(u.token, '/me/sync/operations?status=conflict'));
  assert.equal(item.server.row_version, 2); assert.equal(item.draft.athlete_rpe, 8);
  assert.equal((await post(u.token, `/me/sync/operations/${item.id}/resolve`, { resolution: 'merge', fields: ['notes'] })).status, 400, 'workouts cannot be merged field by field');
  const done = ok(await post(u.token, `/me/sync/operations/${item.id}/resolve`, { resolution: 'keep_mine' }));
  assert.equal(done.row_version, 3);
  assert.equal((await pool.query('SELECT status, athlete_rpe FROM training_sessions WHERE id=$1', [session.id])).rows[0].status, 'completed');
  // someone else's session and a session id that does not exist look the same
  const stranger = await signup();
  assert.equal(ok(await sync(stranger, [{ ...op, client_key: key() }])).results[0].code, 'not_found');
});

test('guardian consent is checked again at sync time: a draft written before withdrawal is refused, kept, and applies once consent returns', async () => {
  const kid = await signup(), parent = await signup();
  const { session } = await workout(kid);
  await pool.query('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);
  await pool.query("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [parent.id, kid.id]);
  const consent = () => pool.query("INSERT INTO youth_consents(child_id, purpose, granted_by, policy_version, expires_at) VALUES ($1,'coaching',$2,1, now() + interval '30 days') ON CONFLICT (child_id, purpose) DO UPDATE SET revoked_at=NULL, expires_at=now() + interval '30 days'", [kid.id, parent.id]);
  await consent();
  await pool.query("UPDATE youth_consents SET revoked_at=now() WHERE child_id=$1 AND purpose='coaching'", [kid.id]);
  const op = { kind: 'workout_log', client_key: key(), session_id: session.id, expected_version: 1, actuals: [{ block_id: 'rep800', completed: true, sets_done: 5 }] };
  const r = ok(await sync(kid, [op])).results[0];
  assert.equal(r.status, 'rejected'); assert.equal(r.code, 'guardian_consent_required'); assert.equal(r.retryable, true);
  assert.equal((await pool.query('SELECT version FROM training_sessions WHERE id=$1', [session.id])).rows[0].version, 1, 'nothing was written');
  assert.equal(ok(await get(kid.token, '/me/sync/operations?status=rejected'))[0].draft.session_id, session.id, 'the draft is still there');
  await consent();
  assert.equal(ok(await sync(kid, [op])).results[0].status, 'applied');
  // a refused draft can be given up; the server keeps only the outcome
  const op2 = { kind: 'workout_log', client_key: key(), session_id: session.id, expected_version: 2, status: 'skipped' };
  await pool.query("UPDATE youth_consents SET revoked_at=now() WHERE child_id=$1 AND purpose='coaching'", [kid.id]);
  ok(await sync(kid, [op2]));
  const rej = ok(await get(kid.token, '/me/sync/operations?status=rejected'))[0];
  ok(await post(kid.token, `/me/sync/operations/${rej.id}/discard`));
  assert.equal((await pool.query('SELECT payload_enc FROM sync_operations WHERE id=$1', [rej.id])).rows[0].payload_enc, null);
  assert.equal((await post(kid.token, `/me/sync/operations/${rej.id}/discard`)).status, 200, 'repeat is harmless');
});

test('devices: listed with queue size, signed out remotely, told to wipe, and unable to sync again', async () => {
  const { u, p } = await player();
  // each device has its own login session; the tablet signs in separately
  const tabletLogin = ok(await api('POST', '/auth/login', { body: { email: `os${n}@example.com`, password: 'correct-horse-battery' } }));
  const tablet_ = { ...u, token: tabletLogin.token };
  ok(await post(u.token, '/me/sync/devices', device('device-phone-0001', 'ios')), 201);
  ok(await sync(tablet_, [matchOp(p)], device('device-tablet-0002', 'ipados')));
  const list = ok(await get(u.token, '/me/sync/devices'));
  assert.equal(list.length, 2);
  const tablet = list.find((d) => d.device_id === 'device-tablet-0002');
  assert.ok(tablet.last_sync_at); assert.equal(tablet.platform, 'ipados');
  assert.equal(ok(await sync(tablet_, [matchOp(p)], { ...device('device-tablet-0002', 'ipados'), label: 'Kitchen iPad' })).applied, 1);
  const gone = ok(await del(u.token, `/me/sync/devices/${tablet.id}`));
  assert.ok(gone.revoked_at);
  // the tablet's login session was ended with it, so it cannot even reach the API; the same install on a new login is told to wipe
  assert.equal((await sync(tablet_, [matchOp(p)], device('device-tablet-0002', 'ipados'))).status, 401);
  const refused = await sync(u, [matchOp(p)], device('device-tablet-0002', 'ipados'));
  assert.equal(refused.status, 403); assert.equal(refused.body.error.code, 'device_revoked'); assert.equal(refused.body.error.details.wipe, true);
  assert.equal((await post(u.token, '/me/sync/devices', device('device-tablet-0002', 'ipados'))).status, 403);
  assert.equal(ok(await sync(u, [matchOp(p)], device('device-tablet-0003', 'ipados'))).applied, 1, 'a fresh install registers anew');
  assert.equal((await del(u.token, `/me/sync/devices/${tablet.id}`)).status, 200, 'revoking twice is harmless');
  const stranger = await signup();
  assert.equal((await del(stranger.token, `/me/sync/devices/${tablet.id}`)).status, 404);
  assert.equal((await post(u.token, '/me/sync/devices', { id: 'x', platform: 'ios' })).status, 400);
  assert.equal((await post(u.token, '/me/sync/devices', { id: 'device-ok-0001', platform: 'palm' })).status, 400);
});
