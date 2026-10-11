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
  const r = await api('POST', '/auth/register', { body: { handle: `ss_${n}_${roles[0]}`, display_name: `Ss ${n}`, email: `ss${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const mkTeam = async (u, sport) => (await api('POST', '/teams', { token: u.token, body: { name: `Team ${++n}`, sport } })).body;
const setup = async (sport = 'football', fixtureExtra = {}) => {
  const org = await signup(['organizer']), ref = await signup(['referee']), m1 = await signup(['coach']), m2 = await signup(['coach']), rando = await signup(['athlete']);
  const ev = (await api('POST', '/events', { token: org.token, body: { name: `Sheet Cup ${++n}`, sport } })).body;
  const home = await mkTeam(m1, sport), away = await mkTeam(m2, sport);
  const fx = (await pool.query("INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at, round_kind) VALUES ($1,$2,$3, now(), $4) RETURNING id", [ev.id, home.id, away.id, fixtureExtra.round_kind ?? null])).rows[0].id;
  await pool.query("INSERT INTO fixture_officials(fixture_id, user_id, role, status) VALUES ($1,$2,'referee','accepted')", [fx, ref.id]);
  await pool.query("INSERT INTO event_entries(event_id, team_id, status) VALUES ($1,$2,'accepted'),($1,$3,'accepted')", [ev.id, home.id, away.id]);
  return { org, ref, m1, m2, rando, ev, home, away, fx };
};
const log = (u, fx, body) => api('POST', `/fixtures/${fx}/events`, { token: u.token, body });
const play = async (ref, fx, goals) => { // goals: ['home','away',…] inside one half
  await api('POST', `/fixtures/${fx}/start`, { token: ref.token });
  await log(ref, fx, { kind: 'period_start' });
  for (const side of goals) await log(ref, fx, { kind: 'goal', side });
};
const post = (u, path, body = {}) => api('POST', path, { token: u.token, body });
const fullFlow = async (t, sheetId) => { // submit, both sign, approve, publish
  assert.equal((await post(t.ref, `/score-sheets/${sheetId}/submit`)).status, 200);
  assert.equal((await post(t.m1, `/score-sheets/${sheetId}/sign`, { decision: 'signed' })).status, 200);
  assert.equal((await post(t.m2, `/score-sheets/${sheetId}/sign`, { decision: 'signed' })).status, 200);
  assert.equal((await post(t.org, `/score-sheets/${sheetId}/approve`)).status, 200);
  const p = await post(t.org, `/score-sheets/${sheetId}/publish`);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  return p.body;
};

test('full time opens a draft sheet pre-filled from the match log; nothing is official until published', async () => {
  const t = await setup();
  await play(t.ref, t.fx, ['home', 'away', 'home']);
  assert.equal((await post(t.rando, `/fixtures/${t.fx}/end`)).status, 403);
  const end = await post(t.ref, `/fixtures/${t.fx}/end`);
  assert.equal(end.status, 200, JSON.stringify(end.body));
  assert.deepEqual([end.body.status, end.body.source, end.body.home_score, end.body.away_score, end.body.winner_team_id], ['draft', 'match_log', 2, 1, t.home.id]);
  assert.equal(end.body.totals.periods.length, 1);
  const fixture = (await pool.query('SELECT status, home_score FROM fixtures WHERE id=$1', [t.fx])).rows[0];
  assert.deepEqual([fixture.status, fixture.home_score], ['finished', null], 'result not written yet');
  assert.equal((await post(t.ref, `/fixtures/${t.fx}/end`)).status, 409);
  assert.equal((await api('GET', `/events/${t.ev.id}/standings`)).body.every((r) => r.played === 0), true, 'standings unaffected until publish');
  assert.equal((await post(t.org, `/fixtures/${t.fx}/result`, { home_score: 9, away_score: 0 })).status, 409, 'the old direct result path is closed for a sheet-managed game');
  assert.equal((await api('GET', `/fixtures/${t.fx}/result`)).status, 404, 'no public result yet');
  const open = (await pool.query("SELECT count(*)::int AS n FROM match_events WHERE fixture_id=$1 AND kind='period_end'", [t.fx])).rows[0].n;
  assert.equal(open, 1, 'the open half was closed automatically');
});

test('editing away from the match log needs a reason; sheets are only visible to the people involved', async () => {
  const t = await setup();
  await play(t.ref, t.fx, ['home', 'away']);
  const sheet = (await post(t.ref, `/fixtures/${t.fx}/end`)).body;
  const bad = await api('PATCH', `/score-sheets/${sheet.id}`, { token: t.ref.token, body: { home_score: 3 } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /log adds up to 1–1/);
  const ok = await api('PATCH', `/score-sheets/${sheet.id}`, { token: t.ref.token, body: { home_score: 3, adjusted_reason: 'Late goal not logged' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.winner_team_id, t.home.id);
  const back = await api('PATCH', `/score-sheets/${sheet.id}`, { token: t.ref.token, body: { home_score: 1 } });
  assert.equal(back.body.adjusted_reason, null, 'matching the log again clears the reason');
  assert.equal((await api('PATCH', `/score-sheets/${sheet.id}`, { token: t.m1.token, body: { home_score: 0 } })).status, 403, 'managers cannot edit');
  assert.equal((await api('GET', `/fixtures/${t.fx}/score-sheet`, { token: t.rando.token })).status, 403);
  const seen = await api('GET', `/fixtures/${t.fx}/score-sheet`, { token: t.m2.token });
  assert.equal(seen.status, 200);
  assert.deepEqual(seen.body.pending_signoffs, ['referee', 'home_manager', 'away_manager']);
});

test('submit → sign/dispute → approve (or waive) → publish writes the result and standings', async () => {
  const t = await setup();
  await play(t.ref, t.fx, ['home', 'home', 'away']);
  const sheet = (await post(t.ref, `/fixtures/${t.fx}/end`)).body;
  assert.equal((await post(t.m1, `/score-sheets/${sheet.id}/sign`, { decision: 'signed' })).status, 409, 'not submitted yet');
  assert.equal((await post(t.rando, `/score-sheets/${sheet.id}/submit`)).status, 403);
  const sub = await post(t.ref, `/score-sheets/${sheet.id}/submit`);
  assert.equal(sub.body.status, 'submitted');
  assert.equal((await post(t.rando, `/score-sheets/${sheet.id}/sign`, { decision: 'signed' })).status, 403);
  assert.equal((await post(t.ref, `/score-sheets/${sheet.id}/sign`, { decision: 'signed' })).status, 403, 'the referee is not a team manager');
  assert.equal((await post(t.m1, `/score-sheets/${sheet.id}/sign`, { decision: 'signed' })).status, 200);
  assert.equal((await post(t.m1, `/score-sheets/${sheet.id}/sign`, { decision: 'signed' })).status, 409, 'once per round');
  assert.equal((await post(t.m2, `/score-sheets/${sheet.id}/sign`, { decision: 'disputed' })).status, 400, 'a dispute needs a comment');
  const disp = await post(t.m2, `/score-sheets/${sheet.id}/sign`, { decision: 'disputed', comment: 'We scored twice' });
  assert.equal(disp.body.disputes[0].comment, 'We scored twice');
  assert.equal((await post(t.ref, `/score-sheets/${sheet.id}/approve`)).status, 403, 'only the organiser approves');
  const blocked = await post(t.org, `/score-sheets/${sheet.id}/approve`);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.details.disputes[0].role, 'away_manager');
  assert.equal((await post(t.org, `/score-sheets/${sheet.id}/publish`)).status, 409, 'not approved');

  const rej = await post(t.org, `/score-sheets/${sheet.id}/reject`, { reason: 'Check the second half' });
  assert.equal(rej.body.status, 'rejected');
  const fixed = await api('PATCH', `/score-sheets/${sheet.id}`, { token: t.ref.token, body: { notes: 'Checked with the timekeeper' } });
  assert.equal(fixed.body.status, 'draft');
  const again = await post(t.ref, `/score-sheets/${sheet.id}/submit`);
  assert.equal(again.body.round, 2);
  assert.equal((await api('GET', `/fixtures/${t.fx}/score-sheet`, { token: t.org.token })).body.signoffs.length, 1, 'only the referee has signed round 2');
  const waived = await post(t.org, `/score-sheets/${sheet.id}/approve`, { waived_reason: 'Managers unreachable; referee confirmed' });
  assert.equal(waived.body.waived_reason, 'Managers unreachable; referee confirmed');

  const pub = await post(t.org, `/score-sheets/${sheet.id}/publish`);
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  assert.equal(pub.body.status, 'published');
  const fx = (await pool.query('SELECT status, home_score, away_score, winner_team_id FROM fixtures WHERE id=$1', [t.fx])).rows[0];
  assert.deepEqual(fx, { status: 'completed', home_score: 2, away_score: 1, winner_team_id: t.home.id });
  const table = (await api('GET', `/events/${t.ev.id}/standings`)).body;
  assert.equal(table.find((r) => r.team_id === t.home.id).points, 3);
  assert.equal((await api('PATCH', `/score-sheets/${sheet.id}`, { token: t.ref.token, body: { home_score: 5 } })).status, 409, 'published sheets are locked');

  const result = await api('GET', `/fixtures/${t.fx}/result`);
  assert.equal(result.status, 200);
  assert.deepEqual([result.body.home_score, result.body.away_score, result.body.version], [2, 1, 1]);
  assert.equal(JSON.stringify(result.body).includes('Managers unreachable'), false, 'internal notes are not public');
  assert.equal(JSON.stringify(result.body).includes('We scored twice'), false, 'dispute comments are not public');
  const all = await api('GET', `/events/${t.ev.id}/results`);
  assert.equal(all.body.length, 1);
  assert.equal(all.body[0].home_name, t.home.name);
  const queue = await api('GET', `/events/${t.ev.id}/score-sheets?status=published`, { token: t.org.token });
  assert.equal(queue.body.length, 1);
  assert.equal((await api('GET', `/events/${t.ev.id}/score-sheets`, { token: t.rando.token })).status, 403);
});

test('a published result is corrected as a new version; the old one is kept', async () => {
  const t = await setup();
  await play(t.ref, t.fx, ['home']);
  const sheet = (await post(t.ref, `/fixtures/${t.fx}/end`)).body;
  const v1 = await fullFlow(t, sheet.id);
  assert.equal(v1.version, 1);
  assert.equal((await post(t.rando, `/fixtures/${t.fx}/score-sheet/revise`, { reason: 'x'.repeat(5) })).status, 403);
  const rev = await post(t.org, `/fixtures/${t.fx}/score-sheet/revise`, { reason: 'Goal credited to the wrong side' });
  assert.equal(rev.status, 201, JSON.stringify(rev.body));
  assert.equal(rev.body.version, 2);
  assert.equal((await post(t.org, `/fixtures/${t.fx}/score-sheet/revise`, { reason: 'again again' })).status, 409, 'one correction at a time');
  assert.equal((await pool.query('SELECT home_score FROM fixtures WHERE id=$1', [t.fx])).rows[0].home_score, 1, 'v1 stays official meanwhile');
  assert.equal((await post(t.rando, `/fixtures/${t.fx}/score-sheet`)).status, 403);
  await api('PATCH', `/score-sheets/${rev.body.id}`, { token: t.ref.token, body: { home_score: 0, away_score: 1 } });
  const v2 = await fullFlow(t, rev.body.id);
  assert.equal(v2.version, 2);
  assert.equal((await pool.query("SELECT status FROM score_sheets WHERE id=$1", [v1.id])).rows[0].status, 'superseded');
  const fx = (await pool.query('SELECT home_score, away_score, winner_team_id FROM fixtures WHERE id=$1', [t.fx])).rows[0];
  assert.deepEqual(fx, { home_score: 0, away_score: 1, winner_team_id: t.away.id });
  const pub = await api('GET', `/fixtures/${t.fx}/result`);
  assert.equal(pub.body.version, 2);
  assert.deepEqual(pub.body.versions.map((v) => `${v.version}:${v.status}`), ['1:superseded', '2:published']);
  const away = (await api('GET', `/events/${t.ev.id}/standings`)).body.find((r) => r.team_id === t.away.id);
  assert.equal(away.points, 3, 'standings follow the correction');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM score_sheets WHERE fixture_id=$1', [t.fx])).rows[0].n, 2, 'both versions kept');
});

test('checks stop impossible sheets: level knockout, impossible sets, manual sports need totals', async () => {
  const ko = await setup('football', { round_kind: 'final' });
  await play(ko.ref, ko.fx, ['home', 'away']);
  const ks = (await post(ko.ref, `/fixtures/${ko.fx}/end`)).body;
  const stopped = await post(ko.ref, `/score-sheets/${ks.id}/submit`);
  assert.equal(stopped.status, 409);
  assert.equal(stopped.body.error.details.anomalies[0].code, 'knockout_needs_winner');
  assert.equal((await api('PATCH', `/score-sheets/${ks.id}`, { token: ko.ref.token, body: { winner_team_id: ko.rando.id } })).status, 400, 'winner must be one of the teams');
  await api('PATCH', `/score-sheets/${ks.id}`, { token: ko.ref.token, body: { winner_team_id: ko.away.id } });
  assert.equal((await post(ko.ref, `/score-sheets/${ks.id}/submit`)).status, 200, 'penalties winner named');
  await post(ko.m1, `/score-sheets/${ks.id}/sign`, { decision: 'signed' }); await post(ko.m2, `/score-sheets/${ks.id}/sign`, { decision: 'signed' });
  await post(ko.org, `/score-sheets/${ks.id}/approve`);
  await post(ko.org, `/score-sheets/${ks.id}/publish`);
  assert.equal((await pool.query('SELECT winner_team_id FROM fixtures WHERE id=$1', [ko.fx])).rows[0].winner_team_id, ko.away.id);

  const bd = await setup('badminton');
  const open = await post(bd.ref, `/fixtures/${bd.fx}/score-sheet`);
  assert.equal(open.status, 201, JSON.stringify(open.body));
  assert.equal((await post(bd.ref, `/score-sheets/${open.body.id}/submit`)).status, 409, 'no score yet');
  await api('PATCH', `/score-sheets/${open.body.id}`, { token: bd.ref.token, body: { home_score: 2, away_score: 2 } });
  const imp = await post(bd.ref, `/score-sheets/${open.body.id}/submit`);
  assert.equal(imp.body.error.details.anomalies.some((a) => a.code === 'impossible_sets'), true);
  await api('PATCH', `/score-sheets/${open.body.id}`, { token: bd.ref.token, body: { home_score: 2, away_score: 1 } });
  const okSub = await post(bd.ref, `/score-sheets/${open.body.id}/submit`);
  assert.equal(okSub.status, 200);
  assert.ok(okSub.body.anomalies.some((a) => a.code !== 'impossible_sets') || okSub.body.anomalies.length === 0);

  const ar = await setup('archery');
  await api('POST', `/fixtures/${ar.fx}/start`, { token: ar.ref.token });
  assert.equal((await log(ar.ref, ar.fx, { kind: 'foul', side: 'home' })).status, 400, 'manual sports are not event-scored');
  const ms = (await post(ar.ref, `/fixtures/${ar.fx}/end`)).body;
  assert.deepEqual([ms.source, ms.home_score], ['manual', null]);
});

test('an organiser acting as scorer can run a game, and the audit trail records every step', async () => {
  const t = await setup();
  await play(t.org, t.fx, ['away']);
  const sheet = (await post(t.org, `/fixtures/${t.fx}/end`)).body;
  const pub = await fullFlowOrg(t, sheet.id);
  assert.equal(pub.status, 'published');
  const view = await api('GET', `/fixtures/${t.fx}/score-sheet`, { token: t.org.token });
  assert.deepEqual(view.body.history.map((h) => h.action), ['created', 'submitted', 'signed', 'signed', 'approved', 'published']);
});
async function fullFlowOrg(t, sheetId) {
  await post(t.org, `/score-sheets/${sheetId}/submit`);
  await post(t.m1, `/score-sheets/${sheetId}/sign`, { decision: 'signed' });
  await post(t.m2, `/score-sheets/${sheetId}/sign`, { decision: 'signed' });
  await post(t.org, `/score-sheets/${sheetId}/approve`);
  return (await post(t.org, `/score-sheets/${sheetId}/publish`)).body;
}
