// Issue #328: unified training and match load history. Real HTTP + MCP against Postgres.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base, n = 0;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const rpc = async (name, args, token) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  return (await r.json()).result;
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const post = (t, p, body) => api('POST', p, { token: t, body });
const patch = (t, p, body) => api('PATCH', p, { token: t, body });
const get = (t, p) => api('GET', p, { token: t });
const q = async (sql, args) => (await pool.query(sql, args)).rows;
const day = (o = 0) => new Date(Date.now() + o * 864e5).toISOString().slice(0, 10);
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `lh_${n}_${roles[0]}`, display_name: `Load ${n}`, email: `lh${n}@example.com`, password: 'correct-horse-battery', roles } });
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

/** a completed training session for the athlete (planned 60 min, rated 7 by them) */
const trainingSession = async (ath, coach, { daysAgo = 1, status = 'completed', rpe = 7 } = {}) => {
  const plan = (await q("INSERT INTO training_plans(coach_id, athlete_id, title, status) VALUES ($1,$2,'Block A','active') RETURNING id", [coach.id, ath.id]))[0].id;
  return (await q("INSERT INTO training_sessions(plan_id, from_rev, starts_at, duration_min, kind, title, status, athlete_rpe, completed_at) VALUES ($1,1, now() - ($2 || ' day')::interval, 60, 'conditioning','Tempo run',$3,$4, now()) RETURNING id", [plan, String(daysAgo), status, status === 'completed' ? rpe : null]))[0].id;
};
/** a finished fixture with the athlete as a starter */
const match = async (ath, { daysAgo = 2, minutes = 80, basis = 'match_clock', status = 'started', fixtureStatus = 'finished' } = {}) => {
  const org = await signup(['organizer']), m1 = await signup(['coach']), m2 = await signup(['coach']);
  const ev = ok(await post(org.token, '/events', { name: `Cup ${++n}`, sport: 'football' }), 201);
  const home = ok(await post(m1.token, '/teams', { name: `H${++n}`, sport: 'football' }), 201), away = ok(await post(m2.token, '/teams', { name: `A${++n}`, sport: 'football' }), 201);
  const fx = (await q("INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at, status) VALUES ($1,$2,$3, now() - ($4 || ' day')::interval, $5) RETURNING id", [ev.id, home.id, away.id, String(daysAgo), fixtureStatus]))[0].id;
  const app = (await q("INSERT INTO match_appearances(fixture_id, team_id, user_id, status, minutes_played, minutes_basis, source) VALUES ($1,$2,$3,$4,$5,$6,'lineup') RETURNING id", [fx, home.id, ath.id, status, minutes, minutes === null ? null : basis]))[0].id;
  return { fx, app };
};

test('only confirmed completed sessions and played matches are pending; effort and minutes are never estimated', async () => {
  const ath = await signup(), coach = await signup(['coach']);
  const done = await trainingSession(ath, coach), skipped = await trainingSession(ath, coach, { status: 'skipped' }), sched = await trainingSession(ath, coach, { status: 'scheduled' });
  const played = await match(ath), bench = await match(ath, { status: 'unused_sub', minutes: null }), notFinished = await match(ath, { fixtureStatus: 'scheduled' });
  const h = ok(await get(ath.token, '/me/load-history'));
  assert.deepEqual(h.pending.map((p) => p.id).sort(), [done, played.app].sort(), 'skipped, scheduled, benched and unplayed are not offered');
  assert.equal(h.totals.entries, 0); assert.equal(h.workload.status, 'no_data', 'pending sessions add no load');
  void skipped; void sched; void bench; void notFinished;
  // training minutes are never assumed from the plan; match minutes come only from verified time
  const r1 = await post(ath.token, '/me/load-history/record', { source: 'match', source_id: played.app });
  assert.equal(r1.status, 400, 'RPE is required for a match');
  const noMin = await post(ath.token, '/me/load-history/record', { source: 'training_session', source_id: done, rpe: 6 });
  assert.equal(noMin.status, 400); assert.match(JSON.stringify(noMin.body), /minutes/i);
  assert.equal((await post(ath.token, '/me/load-history/record', { source: 'training_session', source_id: done, minutes: 55 })).status, 201, 'a session you already rated keeps that RPE');
});

test('record from a source: verified match minutes, rated session, idempotent, one load per source under concurrency', async () => {
  const ath = await signup(), coach = await signup(['coach']);
  const ts = await trainingSession(ath, coach, { rpe: 7 }), m = await match(ath, { minutes: 79.6 });
  const t = ok(await post(ath.token, '/me/load-history/record', { source: 'training_session', source_id: ts, minutes: 50 }), 201);
  assert.equal(t.minutes, 50); assert.equal(t.rpe, 7); assert.equal(t.load, 350); assert.equal(t.source, 'training_session'); assert.equal(t.minutes_basis, 'athlete_entered'); assert.equal(t.existing, false); assert.equal(t.kind, 'gym' === t.kind ? 'gym' : 'training');
  // the match uses its verified clock time (rounded) and the athlete's RPE
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => post(ath.token, '/me/load-history/record', { source: 'match', source_id: m.app, rpe: 8 })));
  assert.deepEqual([a.status, b.status, c.status].sort(), [201, 201, 201].sort().map(() => 201).slice(0, 3).sort());
  const ids = new Set([a, b, c].map((r) => r.body.id));
  assert.equal(ids.size, 1, 'three parallel requests make one record');
  assert.equal(a.body.minutes, 80); assert.equal(a.body.minutes_basis, 'match_verified'); assert.equal(a.body.kind, 'match'); assert.equal(a.body.load, 640);
  assert.equal((await q('SELECT count(*)::int AS c FROM session_loads WHERE appearance_id=$1', [m.app]))[0].c, 1);
  // repeating with different numbers is refused and points at the record
  const again = await post(ath.token, '/me/load-history/record', { source: 'match', source_id: m.app, rpe: 3 });
  assert.equal(again.status, 409); assert.equal(again.body.error.details?.code, 'already_recorded');
  // it counts once in the workload and the unified list
  const h = ok(await get(ath.token, '/me/load-history'));
  assert.equal(h.entries.length, 2); assert.equal(h.totals.load, 350 + 640); assert.equal(h.pending.length, 0);
  assert.equal(h.entries.find((e) => e.source === 'match').source_title !== undefined, true);
  // match without a verified clock needs the athlete's own minutes
  const unverified = await match(ath, { minutes: null, daysAgo: 3 });
  assert.equal((await post(ath.token, '/me/load-history/record', { source: 'match', source_id: unverified.app, rpe: 5 })).status, 400);
  assert.equal((await post(ath.token, '/me/load-history/record', { source: 'match', source_id: unverified.app, rpe: 5, minutes: 45 })).status, 201);
});

test('a source that is not yours or not confirmed is a plain 404; archiving frees it again', async () => {
  const ath = await signup(), other = await signup(), coach = await signup(['coach']);
  const ts = await trainingSession(ath, coach), future = await trainingSession(ath, coach, { status: 'scheduled' });
  assert.equal((await post(other.token, '/me/load-history/record', { source: 'training_session', source_id: ts, minutes: 40, rpe: 5 })).status, 404);
  assert.equal((await post(ath.token, '/me/load-history/record', { source: 'training_session', source_id: future, minutes: 40, rpe: 5 })).status, 404);
  assert.equal((await post(ath.token, '/me/load-history/record', { source: 'training_session', source_id: '00000000-0000-4000-8000-000000000000', minutes: 40, rpe: 5 })).status, 404);
  const r = ok(await post(ath.token, '/me/load-history/record', { source: 'training_session', source_id: ts, minutes: 40, rpe: 5 }), 201);
  assert.equal((await post(other.token, `/me/loads/${r.id}/archive`, {})).status, 404);
  ok(await post(ath.token, `/me/loads/${r.id}/archive`, { reason: 'wrong session' }));
  assert.equal(ok(await get(ath.token, '/me/load-history')).pending.length, 1, 'archived: the session is available again, nothing was deleted');
  const r2 = ok(await post(ath.token, '/me/load-history/record', { source: 'training_session', source_id: ts, minutes: 45, rpe: 6 }), 201);
  assert.notEqual(r2.id, r.id);
  assert.equal((await q('SELECT count(*)::int AS c FROM session_loads WHERE training_session_id=$1', [ts]))[0].c, 2, 'the archived row is kept');
  const hist = ok(await get(ath.token, `/me/loads/${r.id}/revisions`));
  assert.deepEqual(hist.map((x) => x.action), ['archived', 'created']); assert.equal(hist[0].reason, 'wrong session');
  assert.equal((await get(other.token, `/me/loads/${r.id}/revisions`)).status, 404);
});

test('reconciliation: a manual log of the same day is linked, not counted twice', async () => {
  const ath = await signup(), coach = await signup(['coach']);
  const ts = await trainingSession(ath, coach, { daysAgo: 1, rpe: 7 });
  const manual = ok(await post(ath.token, '/me/loads', { date: day(-1), kind: 'training', minutes: 62, rpe: 6 }), 201);
  assert.equal(manual.possible_sources.length, 1); assert.equal(manual.possible_sources[0].source_id, ts);
  assert.equal(ok(await get(ath.token, '/me/load-history')).possible_duplicates.length, 1);
  // recording the session alongside the manual log is refused until the athlete decides
  const refused = await post(ath.token, '/me/load-history/record', { source: 'training_session', source_id: ts, minutes: 60 });
  assert.equal(refused.status, 409); assert.equal(refused.body.error.details?.code, 'possible_duplicate'); assert.equal(refused.body.error.details.candidates[0].id, manual.id);
  // link it: the athlete's own minutes and RPE stay, the record now belongs to the session
  const stale = await post(ath.token, `/me/loads/${manual.id}/link`, { source: 'training_session', source_id: ts, expected_version: 5 });
  assert.equal(stale.status, 409); assert.equal(stale.body.error.details?.code, 'stale_version');
  const linked = ok(await post(ath.token, `/me/loads/${manual.id}/link`, { source: 'training_session', source_id: ts, expected_version: manual.row_version }));
  assert.equal(linked.id, manual.id); assert.equal(linked.source, 'training_session'); assert.equal(linked.minutes, 62); assert.equal(linked.rpe, 6); assert.equal(linked.row_version, 2);
  const h = ok(await get(ath.token, '/me/load-history'));
  assert.equal(h.entries.length, 1); assert.equal(h.totals.load, 62 * 6); assert.equal(h.pending.length, 0); assert.equal(h.possible_duplicates.length, 0);
  assert.equal((await post(ath.token, `/me/loads/${manual.id}/link`, { source: 'training_session', source_id: ts, expected_version: 2 })).status, 409, 'already linked');
  // "separate" keeps both when they really are two sessions
  const ts2 = await trainingSession(ath, coach, { daysAgo: 3 });
  const m2 = ok(await post(ath.token, '/me/loads', { date: day(-3), kind: 'gym', minutes: 30, rpe: 5 }), 201);
  assert.equal((await post(ath.token, '/me/load-history/record', { source: 'training_session', source_id: ts2, minutes: 60 })).status, 409);
  ok(await post(ath.token, '/me/load-history/record', { source: 'training_session', source_id: ts2, minutes: 60, separate: true }), 201);
  assert.equal(ok(await get(ath.token, '/me/load-history')).entries.length, 3); void m2;
  // link_load_id on the record call does the same reconciliation in one step
  const ts3 = await trainingSession(ath, coach, { daysAgo: 5 }), m3 = ok(await post(ath.token, '/me/loads', { date: day(-5), kind: 'training', minutes: 58, rpe: 7 }), 201);
  const one = ok(await post(ath.token, '/me/load-history/record', { source: 'training_session', source_id: ts3, link_load_id: m3.id }), 201);
  assert.equal(one.id, m3.id); assert.equal(one.linked, true); assert.equal(one.minutes, 58);
  // a manual log from a different week cannot be linked
  const far = ok(await post(ath.token, '/me/loads', { date: day(-20), kind: 'training', minutes: 40, rpe: 5 }), 201);
  const ts4 = await trainingSession(ath, coach, { daysAgo: 7 });
  const bad = await post(ath.token, `/me/loads/${far.id}/link`, { source: 'training_session', source_id: ts4, expected_version: far.row_version });
  assert.equal(bad.status, 400); assert.equal(bad.body.error.details?.code, 'date_mismatch');
});

test('corrections: reason required, stale versions refused, history keeps before and after, linked date locked', async () => {
  const ath = await signup(), coach = await signup(['coach']);
  const ts = await trainingSession(ath, coach);
  const rec = ok(await post(ath.token, '/me/load-history/record', { source: 'training_session', source_id: ts, minutes: 60 }), 201);
  assert.equal((await patch(ath.token, `/me/loads/${rec.id}`, { expected_version: 1, minutes: 50 })).status, 400, 'a reason is required');
  assert.equal((await patch(ath.token, `/me/loads/${rec.id}`, { expected_version: 1, reason: 'no change' })).status, 400, 'say what to correct');
  assert.equal((await patch(ath.token, `/me/loads/${rec.id}`, { expected_version: 1, reason: 'same', minutes: 60 })).status, 400, 'nothing changed');
  const fixed = ok(await patch(ath.token, `/me/loads/${rec.id}`, { expected_version: 1, minutes: 48, rpe: 8, reason: 'Left early, felt harder' }));
  assert.equal(fixed.minutes, 48); assert.equal(fixed.rpe, 8); assert.equal(fixed.load, 384); assert.equal(fixed.row_version, 2); assert.equal(fixed.corrected, true);
  assert.equal((await patch(ath.token, `/me/loads/${rec.id}`, { expected_version: 1, rpe: 5, reason: 'stale copy' })).status, 409, 'stale version');
  assert.equal((await patch(ath.token, `/me/loads/${rec.id}`, { expected_version: 2, date: day(-4), reason: 'moved' })).status, 400, 'linked date is locked');
  const hist = ok(await get(ath.token, `/me/loads/${rec.id}/revisions`));
  assert.deepEqual(hist.map((h) => h.action), ['corrected', 'created']);
  assert.equal(hist[0].before.minutes, 60); assert.equal(hist[0].after.minutes, 48); assert.equal(hist[0].reason, 'Left early, felt harder');
  const raw = (await q('SELECT reason_enc FROM session_load_revisions WHERE load_id=$1 AND action=$2', [rec.id, 'corrected']))[0].reason_enc;
  assert.ok(raw && !raw.includes('Left early'), 'the reason is encrypted at rest');
  assert.ok((await q("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='read_load_revisions'", [ath.id])).length);
  assert.equal((await patch(ath.token, `/me/loads/${rec.id}`, { expected_version: 2, rpe: 4, reason: 'x' })).status, 400, 'reason too short');
  // a manual log can change its date; future dates are refused; the minutes basis follows the athlete's entry
  const man = ok(await post(ath.token, '/me/loads', { date: day(-2), kind: 'training', minutes: 30, rpe: 4 }), 201);
  const moved = ok(await patch(ath.token, `/me/loads/${man.id}`, { expected_version: 1, date: day(-3), kind: 'gym', reason: 'wrong day' }));
  assert.equal(moved.session_date, day(-3)); assert.equal(moved.kind, 'gym');
  assert.equal((await patch(ath.token, `/me/loads/${man.id}`, { expected_version: 2, date: day(10), reason: 'future' })).status, 400);
  const m = await match(ath, { minutes: 90 });
  const mr = ok(await post(ath.token, '/me/load-history/record', { source: 'match', source_id: m.app, rpe: 6 }), 201);
  assert.equal(mr.minutes_basis, 'match_verified');
  const mc = ok(await patch(ath.token, `/me/loads/${mr.id}`, { expected_version: 1, minutes: 70, reason: 'Subbed off early' }));
  assert.equal(mc.minutes_basis, 'athlete_entered', 'a corrected figure is no longer labelled verified');
  // the original appearance row is untouched by the correction
  assert.equal(Number((await q('SELECT minutes_played FROM match_appearances WHERE id=$1', [m.app]))[0].minutes_played), 90);
});

test('legacy manual logs keep working and every old row has a history', async () => {
  const ath = await signup();
  await q("INSERT INTO session_loads(user_id, session_date, kind, minutes, rpe) VALUES ($1,current_date,'training',45,6)", [ath.id]);
  // the migration is additive and idempotent: running it again gives the pre-existing row its history and changes nothing else
  await pool.query((await import('node:fs')).readFileSync(new URL('../migrations/113_load_history.sql', import.meta.url), 'utf8'));
  const h = ok(await get(ath.token, '/me/load-history'));
  assert.equal(h.entries[0].source, 'manual'); assert.equal(h.entries[0].load, 270); assert.equal(h.entries[0].minutes_label, 'entered by the athlete');
  assert.equal(ok(await get(ath.token, '/me/loads'))[0].source, 'manual');
  assert.equal(ok(await get(ath.token, '/me/workload')).acute, 270);
  assert.equal((await get(ath.token, '/me/load-history?from=2026-01-10&to=2026-01-01')).status, 400);
  assert.equal((await get(ath.token, '/me/load-history?from=2020-01-01&to=2026-01-01')).status, 400);
  assert.equal((await post(ath.token, '/me/loads', { kind: 'training', minutes: 0, rpe: 5 })).status, 400);
  assert.equal((await get('bad-token', '/me/load-history')).status, 401);
  const rows = await q('SELECT count(*)::int AS c FROM session_load_revisions r JOIN session_loads l ON l.id=r.load_id WHERE l.user_id=$1', [ath.id]);
  assert.equal(rows[0].c, 1);
});

test('pagination is deterministic and totals cover the window, not just the page', async () => {
  const ath = await signup();
  for (let k = 0; k < 5; k++) ok(await post(ath.token, '/me/loads', { date: day(-1), kind: 'training', minutes: 10 + k, rpe: 5 }), 201);
  const p1 = ok(await get(ath.token, '/me/load-history?limit=2&offset=0')), p2 = ok(await get(ath.token, '/me/load-history?limit=2&offset=2')), p3 = ok(await get(ath.token, '/me/load-history?limit=2&offset=4'));
  const ids = [...p1.entries, ...p2.entries, ...p3.entries].map((e) => e.id);
  assert.equal(new Set(ids).size, 5); assert.equal(p3.entries.length, 1);
  assert.equal(p1.totals.entries, 5);
});

test('young athletes: sources need a guardian\'s live consent; guardians read with an audit row; strangers get 403', async () => {
  const kid = await signup(), parent = await signup(), stranger = await signup(), coach = await signup(['coach']);
  const ts = await trainingSession(kid, coach), m = await match(kid, { minutes: 60 });
  await q('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);
  await q("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [parent.id, kid.id]);
  const none = ok(await get(kid.token, '/me/load-history'));
  assert.equal(none.pending.length, 0); assert.deepEqual(none.hidden_sources.map((s) => s.source).sort(), ['match', 'training_session']);
  const refused = await post(kid.token, '/me/load-history/record', { source: 'match', source_id: m.app, rpe: 5 });
  assert.equal(refused.status, 409); assert.equal(refused.body.error.details?.code, 'guardian_consent_required');
  await q("INSERT INTO youth_consents(child_id, purpose, granted_by, policy_version, expires_at) VALUES ($1,'participation',$2,1, now() + interval '30 days'), ($1,'coaching',$2,1, now() + interval '30 days')", [kid.id, parent.id]);
  const rec = ok(await post(kid.token, '/me/load-history/record', { source: 'match', source_id: m.app, rpe: 5 }), 201);
  assert.equal(ok(await post(kid.token, '/me/load-history/record', { source: 'training_session', source_id: ts, minutes: 45 }), 201).rpe, 7);
  assert.ok(ok(await get(kid.token, '/me/load-history')).entries.find((e) => e.id === rec.id).source_title);
  // revocation is live: the numbers stay the athlete's own but the team and competition disappear and sources can't be added
  await q("UPDATE youth_consents SET revoked_at=now() WHERE child_id=$1 AND purpose='participation'", [kid.id]);
  const after = ok(await get(kid.token, '/me/load-history')).entries.find((e) => e.id === rec.id);
  assert.equal(after.source_hidden, true); assert.equal(after.source_title, null); assert.equal(after.minutes, 60);
  assert.equal(ok(await get(parent.token, `/me/load-history?user_id=${kid.id}`)).user_id, kid.id);
  assert.ok((await q("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='read_load_history'", [parent.id])).length);
  assert.equal((await get(stranger.token, `/me/load-history?user_id=${kid.id}`)).status, 403);
  assert.equal((await get(parent.token, `/me/loads/${rec.id}/revisions`)).status, 200, 'a guardian reads the history');
  assert.equal((await get(stranger.token, `/me/loads/${rec.id}/revisions`)).status, 404);
});

test('shared with a coach: entries, source and correction flag only while the share, the relationship and consent stand; exports carry them', async () => {
  const ath = await signup(), coach = await signup(['coach']);
  const team = ok(await post(coach.token, '/teams', { name: `Load FC ${n}`, sport: 'football' }), 201);
  await q("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'coach','active') ON CONFLICT (team_id, user_id) DO UPDATE SET role='coach', status='active'", [team.id, coach.id]);
  await q("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [team.id, ath.id]);
  const ts = await trainingSession(ath, coach);
  const rec = ok(await post(ath.token, '/me/load-history/record', { source: 'training_session', source_id: ts, minutes: 50 }), 201);
  ok(await patch(ath.token, `/me/loads/${rec.id}`, { expected_version: 1, rpe: 8, reason: 'PRIVATE-REASON-ZZZ' }));
  const only = ok(await post(ath.token, '/me/wellness-shares', { recipient_id: coach.id, purpose: 'training_load', fields: ['sleep'], history_days: 30, expires_on: day(30) }), 201);
  assert.equal(ok(await get(coach.token, `/wellness-shared/${only.id}`)).workload, undefined, 'workload not shared');
  ok(await post(ath.token, `/me/wellness-shares/${only.id}/revoke`, {}));
  const sh = ok(await post(ath.token, '/me/wellness-shares', { recipient_id: coach.id, purpose: 'training_load', fields: ['workload'], history_days: 30, expires_on: day(30) }), 201);
  const v = ok(await get(coach.token, `/wellness-shared/${sh.id}`));
  assert.equal(v.workload.entries.length, 1); assert.equal(v.workload.entries[0].source, 'training_session'); assert.equal(v.workload.entries[0].corrected, true); assert.equal(v.workload.entries[0].load, 400);
  assert.ok(!JSON.stringify(v).includes('PRIVATE-REASON-ZZZ') && !JSON.stringify(v).includes('Tempo run'), 'reasons and session titles stay private');
  const ex = ok(await get(coach.token, `/wellness-shared/${sh.id}/export`));
  assert.match(ex.loads_csv, /training_session/); assert.equal(ex.load_rows, 1);
  assert.equal((await get(ath.token, `/wellness-shared/${sh.id}`)).status, 404, 'not the recipient');
  ok(await post(ath.token, `/me/wellness-shares/${sh.id}/revoke`, {}));
  assert.equal((await get(coach.token, `/wellness-shared/${sh.id}`)).status, 403, 'revocation is live');
  assert.equal((await get(coach.token, `/wellness-shared/${sh.id}/export`)).status, 403);
});

test('MCP exposes the same capabilities and a read-only token cannot reach health load data', async () => {
  const ath = await signup(), coach = await signup(['coach']);
  const ts = await trainingSession(ath, coach);
  const res = await rpc('record_load_from_source', { source: 'training_session', source_id: ts, minutes: 40 }, ath.token);
  assert.ok(!res.isError, JSON.stringify(res));
  assert.equal(JSON.parse(res.content[0].text).load, 280);
  const hist = await rpc('list_load_history', {}, ath.token);
  assert.equal(JSON.parse(hist.content[0].text).entries.length, 1);
  const spec = await (await fetch(`${base}/api/v1/openapi.json`)).json();
  for (const p of ['/me/load-history', '/me/load-history/record', '/me/loads/{id}/link', '/me/loads/{id}/revisions']) assert.ok(spec.paths[p], `OpenAPI has ${p}`);
  const ro = ok(await post(ath.token, '/me/tokens', { name: 'ro', scopes: ['read'] }), 201), cl = ok(await post(ath.token, '/me/tokens', { name: 'cl', scopes: ['clinical'] }), 201);
  assert.equal((await get(ro.token, '/me/load-history')).status, 403, 'clinical class: a read-only token is refused');
  assert.equal((await get(cl.token, '/me/load-history')).status, 200);
  const again = ok(await post(cl.token, '/me/load-history/record', { source: 'training_session', source_id: ts, minutes: 40 }), 201);
  assert.equal(again.existing, true, 'REST and MCP share one idempotent handler');
  assert.equal((await q('SELECT count(*)::int AS c FROM session_loads WHERE training_session_id=$1', [ts]))[0].c, 1);
});
