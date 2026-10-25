import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { matchLength, minutesOn, ratesFrom, AUTHORITY } = await import('../src/appearances/minutes.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
let n = 0;
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `ap_${n}`, display_name: `Ap ${n}`, email: `ap${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const q = async (sql, args) => (await pool.query(sql, args)).rows;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

/** An event with one game, a referee, two managers and `count` rostered players per side. */
async function setup(count = 4) {
  const org = await signup(['organizer']), ref = await signup(['referee']), m1 = await signup(['coach']), m2 = await signup(['coach']), rando = await signup();
  const ev = (await api('POST', '/events', { token: org.token, body: { name: `Cup ${++n}`, sport: 'football' } })).body;
  const home = (await api('POST', '/teams', { token: m1.token, body: { name: `H${++n}`, sport: 'football' } })).body;
  const away = (await api('POST', '/teams', { token: m2.token, body: { name: `A${++n}`, sport: 'football' } })).body;
  const fx = (await q('INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at) VALUES ($1,$2,$3, now()) RETURNING id', [ev.id, home.id, away.id]))[0].id;
  await q("INSERT INTO fixture_officials(fixture_id, user_id, role, status) VALUES ($1,$2,'referee','accepted')", [fx, ref.id]);
  const hp = [], ap = [];
  for (let k = 0; k < count; k++) {
    const h = await signup(), a = await signup();
    await q("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active'), ($3,$4,'player','active')", [home.id, h.id, away.id, a.id]);
    hp.push(h); ap.push(a);
  }
  return { org, ref, m1, m2, rando, ev, home, away, fx, hp, ap };
}
const lineup = (u, s, side = 'home', starters, bench = []) => api('POST', `/fixtures/${s.fx}/lineup`, { token: u.token, body: { side, starters: starters.map((p) => p.id), bench: bench.map((p) => p.id) } });
const clock = (s, kind, secs, period = 1) => api('POST', `/fixtures/${s.fx}/events`, { token: s.ref.token, body: { kind, clock_seconds: secs, period } });
const list = async (s) => (await api('GET', `/fixtures/${s.fx}/appearances`, { token: s.ref.token })).body;
const rowOf = async (s, p) => (await list(s)).appearances.find((a) => a.user_id === p.id);

test('pure rules: valid time only, authority order, per-minute rates exclude unverified minutes', () => {
  assert.deepEqual(matchLength([{ kind: 'period_end', clock_seconds: 2700 }, { kind: 'period_end', clock_seconds: 5400 }, { kind: 'period_end', clock_seconds: 9999, voided_at: 'x' }], 90), { seconds: 5400, basis: 'match_clock' });
  assert.deepEqual(matchLength([], 90), { seconds: 5400, basis: 'scheduled_duration' });
  assert.equal(matchLength([], null).seconds, null);
  assert.equal(minutesOn({ status: 'started' }, 5400), 90);
  assert.equal(minutesOn({ status: 'started', off: 3600 }, 5400), 60);
  assert.equal(minutesOn({ status: 'substitute_on', on: 3600 }, 5400), 30);
  assert.equal(minutesOn({ status: 'substitute_on' }, 5400), null, 'no on-clock, no minutes');
  assert.equal(minutesOn({ status: 'started' }, null), null, 'unknown length is not zero');
  assert.equal(minutesOn({ status: 'started', off: 6000 }, 5400), null, 'off after the end of play is invalid');
  assert.equal(minutesOn({ status: 'unused_sub' }, 5400), 0);
  assert.ok(AUTHORITY.official_sheet > AUTHORITY.staff && AUTHORITY.staff > AUTHORITY.team_manager && AUTHORITY.team_manager > AUTHORITY.backfill);
  const r = ratesFrom([
    { minutes_played: 90, minutes_basis: 'match_clock', stats: { goals: 2 } },
    { minutes_played: 90, minutes_basis: 'scheduled_duration', stats: { goals: 5 } },
    { minutes_played: null, minutes_basis: null, stats: { goals: 9 } }]);
  assert.equal(r.rates.goals, 2); assert.equal(r.matches_counted, 1); assert.equal(r.matches_excluded, 2);
});

test('lineup → substitution → full time → minutes computed, then verified by publishing', async () => {
  const s = await setup();
  const [a, b, c, d] = s.hp;
  assert.equal((await lineup(s.rando, s, 'home', [a, b])).status, 403);
  assert.equal((await lineup(s.m2, s, 'home', [a, b])).status, 403, 'the other side\'s manager');
  assert.equal((await lineup(s.m1, s, 'home', [a, s.ap[0]])).status, 400, 'a player of the other team');
  const l = await lineup(s.m1, s, 'home', [a, b, c], [d]);
  assert.equal(l.status, 200, JSON.stringify(l.body));
  assert.deepEqual(l.body.map((r) => r.status), ['started', 'started', 'started', 'unused_sub']);
  await api('POST', `/fixtures/${s.fx}/start`, { token: s.ref.token });
  await clock(s, 'period_start', 0);
  assert.equal((await lineup(s.m1, s, 'home', [a, b])).status, 409, 'lineup is closed after kick-off');
  const sub = { side: 'home', player_off_id: c.id, player_on_id: d.id, clock_seconds: 3600, client_key: 'sub-1' };
  const r1 = await api('POST', `/fixtures/${s.fx}/substitutions`, { token: s.ref.token, body: sub });
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  const r2 = await api('POST', `/fixtures/${s.fx}/substitutions`, { token: s.ref.token, body: sub });
  assert.equal(r2.body.duplicate, true, 'retry is idempotent');
  assert.equal((await q('SELECT count(*)::int AS n FROM match_substitutions WHERE fixture_id=$1', [s.fx]))[0].n, 1);
  assert.equal((await api('POST', `/fixtures/${s.fx}/substitutions`, { token: s.ref.token, body: { ...sub, client_key: 'x', player_off_id: d.id, player_on_id: c.id } })).status, 409, 'c was subbed off and cannot return');
  assert.equal((await api('POST', `/fixtures/${s.fx}/substitutions`, { token: s.ref.token, body: { ...sub, client_key: 'y', player_off_id: a.id, player_on_id: b.id } })).status, 409, 'b is already on the field');
  await clock(s, 'period_end', 5400);
  assert.equal((await api('POST', `/fixtures/${s.fx}/end`, { token: s.ref.token })).status, 200);
  const fin = await api('POST', `/fixtures/${s.fx}/appearances/finalize`, { token: s.ref.token });
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  const mins = Object.fromEntries((await list(s)).appearances.map((x) => [x.user_id, [x.status, x.minutes_played, x.minutes_basis]]));
  assert.deepEqual(mins[a.id], ['started', 90, 'match_clock']);
  assert.deepEqual(mins[c.id], ['started', 60, 'match_clock']);
  assert.deepEqual(mins[d.id], ['substitute_on', 30, 'match_clock']);
  // publishing the result verifies the appearances
  const sheet = (await api('GET', `/fixtures/${s.fx}/score-sheet`, { token: s.org.token })).body;
  await api('PATCH', `/score-sheets/${sheet.id}`, { token: s.org.token, body: { home_score: 1, away_score: 0 } });
  const row = await rowOf(s, a);
  assert.equal(row.verified_at, null);
  await q("UPDATE score_sheets SET status='approved' WHERE id=$1", [sheet.id]);
  assert.equal((await api('POST', `/score-sheets/${sheet.id}/publish`, { token: s.org.token })).status, 200);
  const v = await rowOf(s, a);
  assert.ok(v.verified_at); assert.equal(v.authority, AUTHORITY.official_sheet);
  const revs = await api('GET', `/appearances/${v.id}/revisions`, { token: s.org.token });
  assert.deepEqual(revs.body.map((x) => x.action), ['lineup', 'computed', 'verified']);
});

test('corrections: stale version, reason, authority order, revision history', async () => {
  const s = await setup(2);
  const [a, b] = s.hp;
  await lineup(s.m1, s, 'home', [a], [b]);
  const row = await rowOf(s, a);
  const put = (u, body) => api('POST', `/appearances/${row.id}/correct`, { token: u.token, body });
  assert.equal((await put(s.rando, { row_version: row.row_version, reason: 'nope', minutes_played: 80 })).status, 403);
  assert.equal((await put(s.org, { row_version: row.row_version, reason: '' , minutes_played: 80 })).status, 400, 'a reason is required');
  const ok = await put(s.org, { row_version: row.row_version, reason: 'Scorer sheet says 80', minutes_played: 80 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.minutes_played, 80); assert.equal(ok.body.minutes_basis, 'staff_entry');
  assert.equal((await put(s.org, { row_version: row.row_version, reason: 'again', minutes_played: 70 })).status, 409, 'stale version');
  const mgr = await put(s.m1, { row_version: ok.body.row_version, reason: 'manager disagrees', minutes_played: 60 });
  assert.equal(mgr.status, 409); assert.match(JSON.stringify(mgr.body), /lower_authority/, 'a team manager cannot overwrite the organiser');
  assert.equal((await rowOf(s, a)).minutes_played, 80, 'source value preserved');
  const bad = await put(s.org, { row_version: ok.body.row_version, reason: 'impossible', on_clock_seconds: 3000, off_clock_seconds: 100 });
  assert.equal(bad.status, 400);
  const dnp = await put(s.org, { row_version: ok.body.row_version, reason: 'Did not play after all', status: 'dnp' });
  assert.equal(dnp.body.minutes_played, 0);
  const revs = (await api('GET', `/appearances/${row.id}/revisions`, { token: s.org.token })).body;
  assert.deepEqual(revs.map((x) => x.action), ['lineup', 'corrected', 'corrected']);
  assert.equal(revs[1].reason, 'Scorer sheet says 80');
});

test('history: only named players who played count; unused subs and DNP never do; verified minutes are used', async () => {
  const s = await setup(3);
  const [a, b, c] = s.hp;
  await q("UPDATE fixtures SET status='completed', home_score=1, away_score=0 WHERE id=$1", [s.fx]);
  for (const p of [a, b, c]) await q("INSERT INTO team_squads(team_id, fixture_id, user_id, role, status) VALUES ($1,$2,$3,'player','confirmed')", [s.home.id, s.fx, p.id]);
  const hist = async (u) => (await api('GET', '/me/matches', { token: u.token })).body;
  assert.equal((await hist(a)).length, 1, 'no appearance record: legacy inference still applies');
  await q("INSERT INTO match_appearances(fixture_id, team_id, user_id, status, minutes_played, minutes_basis, source) VALUES ($1,$2,$3,'unused_sub',0,'match_clock','lineup'), ($1,$2,$4,'started',75,'match_clock','lineup')", [s.fx, s.home.id, a.id, b.id]);
  assert.equal((await hist(a)).length, 0, 'confirmed in the squad but never took the field');
  const hb = await hist(b);
  assert.equal(hb.length, 1); assert.equal(hb[0].minutes, 75);
  // not in any squad slot, but verified as having played
  const d = s.hp[0];
  await q("UPDATE match_appearances SET status='substitute_on', on_clock_seconds=3000, minutes_played=40, minutes_basis='match_clock' WHERE fixture_id=$1 AND user_id=$2", [s.fx, a.id]);
  assert.equal((await hist(d)).length, 1);
  assert.equal((await api('GET', '/me/matches', { token: s.rando.token })).body.length, 0);
});

test('player view: minutes and per-90 only from verified time; youth need guardian consent; guardians read with audit', async () => {
  const s = await setup(2);
  const [a, kid] = s.hp;
  await q("UPDATE fixtures SET status='finished' WHERE id=$1", [s.fx]);
  await q("INSERT INTO match_appearances(fixture_id, team_id, user_id, status, minutes_played, minutes_basis, source) VALUES ($1,$2,$3,'started',90,'match_clock','lineup'), ($1,$2,$4,'started',90,'match_clock','lineup')", [s.fx, s.home.id, a.id, kid.id]);
  const mine = await api('GET', '/me/appearances', { token: a.token });
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.equal(mine.body.played, 1); assert.equal(mine.body.appearances[0].minutes_played, 90);
  assert.equal(mine.body.rates.matches_counted, 1);
  assert.equal((await api('GET', `/me/appearances?user_id=${a.id}`, { token: s.rando.token })).status, 403, 'a stranger');
  // young person
  const parent = await signup();
  await q('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);
  await q("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [parent.id, kid.id]);
  assert.equal((await api('GET', '/me/appearances', { token: kid.token })).status, 409, 'no consent');
  assert.equal((await api('GET', `/me/appearances?user_id=${kid.id}`, { token: parent.token })).status, 200);
  assert.ok((await q("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='read_appearances'", [parent.id])).length);
  const hidden = (await list(s)).appearances.find((x) => x.id && x.hidden);
  assert.ok(hidden, 'staff see a hidden placeholder, not the young person\'s data');
  await q("INSERT INTO youth_consents(child_id, purpose, granted_by, policy_version, expires_at) VALUES ($1,'participation',$2,1, now() + interval '30 days')", [kid.id, parent.id]);
  assert.equal((await api('GET', '/me/appearances', { token: kid.token })).status, 200);
  await q("UPDATE youth_consents SET revoked_at=now() WHERE child_id=$1", [kid.id]);
  assert.equal((await api('GET', '/me/appearances', { token: kid.token })).status, 409, 'live revocation');
});

test('youth without consent cannot be named in a lineup', async () => {
  const s = await setup(2);
  const kid = s.hp[0];
  await q('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);
  const r = await lineup(s.m1, s, 'home', [kid]);
  assert.equal(r.status, 409);
  assert.match(JSON.stringify(r.body), /guardian_consent_required/);
});
