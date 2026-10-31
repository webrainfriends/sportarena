import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { computeRankedStandings, rankMeet, tableModelOf, normaliseRules } = await import('../src/competition-standings.js');

// Season, division & league administration (#576) on top of #476: rollover, play-off stages, match-week administration, ranked-meet series, event link.
let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const day = (o) => new Date(Date.now() + o * 864e5).toISOString().slice(0, 10);
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `co_${n}_${roles[0]}`, display_name: `Co ${n}`, email: `co${n}@example.com`, password: 'correct-horse-battery-9', roles } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

/** A competition with one season, one division and `count` accepted teams, season in play. */
async function league({ sport = 'football', count = 4, divisions = ['Premier'], label = '2026/27' } = {}) {
  const org = await signup(['organizer']);
  const comp = must(await api('POST', '/competitions', { token: org.token, body: { name: `League ${++n}`, sport, level: 'amateur', is_public: true } }), 201);
  const season = must(await api('POST', `/competitions/${comp.id}/seasons`, { token: org.token, body: { label, starts_on: day(-40), ends_on: day(200) } }), 201);
  const divs = [];
  for (const [k, name] of divisions.entries()) divs.push(must(await api('POST', `/seasons/${season.id}/divisions`, { token: org.token, body: { name, tier: k + 1 } }), 201));
  must(await api('POST', `/seasons/${season.id}/status`, { token: org.token, body: { status: 'open' } }));
  const teams = [];
  for (const d of divs) {
    for (let k = 0; k < count; k++) {
      const m = await signup(['coach']);
      const t = must(await api('POST', '/teams', { token: m.token, body: { name: `${d.name}-${n}-${k}`, sport } }), 201);
      const m1 = must(await api('POST', `/seasons/${season.id}/memberships`, { token: m.token, body: { team_id: t.id, division_id: d.id } }), 201);
      must(await api('POST', `/memberships/${m1.id}/decision`, { token: org.token, body: { action: 'accept' } }));
      teams.push({ ...t, mgr: m, division_id: d.id });
    }
  }
  must(await api('POST', `/seasons/${season.id}/status`, { token: org.token, body: { status: 'active' } }));
  return { org, comp, season, divs, teams };
}
const playAll = (divisionId, score = [1, 0]) => pool.query("UPDATE fixtures f SET status='completed', home_score=$2, away_score=$3 FROM comp_fixture_links l WHERE l.fixture_id=f.id AND l.division_id=$1 AND f.status<>'completed'", [divisionId, ...score]);

// ------------------------------------------------------------------ pure
test('every scoring family has a native competition model: a head-to-head table or a ranked-meet series, never a silent default', async () => {
  const sports = (await pool.query('SELECT slug, scoring FROM sports')).rows;
  assert.ok(sports.length > 20);
  const models = new Set();
  for (const s of sports) { const m = tableModelOf(s.scoring); assert.ok(['head_to_head', 'ranked_meets'].includes(m.model), s.slug); assert.equal(m.native, true); models.add(m.model); }
  assert.deepEqual([...models].sort(), ['head_to_head', 'ranked_meets']);
  for (const [scoring, best] of [['time', 'lowest'], ['distance', 'highest'], ['weight', 'highest'], ['judged', 'highest']]) assert.equal(tableModelOf(scoring).best, best);
});

test('ranked meets: fastest time / highest mark wins, equal values share a place, series points and countback are deterministic', () => {
  assert.deepEqual(rankMeet([{ team_id: 'a', value: 50, status: 'finished' }, { team_id: 'b', value: 48, status: 'finished' }, { team_id: 'c', value: 50, status: 'finished' }, { team_id: 'd', status: 'dnf' }], 'lowest').map((r) => r.position), [2, 1, 2, null]);
  assert.deepEqual(rankMeet([{ team_id: 'a', value: 7.2, status: 'finished' }, { team_id: 'b', value: 7.9, status: 'finished' }], 'highest').map((r) => r.position), [2, 1]);
  const teams = ['X', 'Y', 'Z'].map((t) => ({ team_id: t, name: t }));
  const meets = [
    { results: [{ team_id: 'X', position: 1, status: 'finished' }, { team_id: 'Y', position: 2, status: 'finished' }, { team_id: 'Z', position: 3, status: 'finished' }] },
    { results: [{ team_id: 'Y', position: 1, status: 'finished' }, { team_id: 'X', position: 2, status: 'finished' }, { team_id: 'Z', status: 'dnf' }] },
  ];
  const t = computeRankedStandings(teams, meets, { tiebreakers: ['points', 'countback'] });
  assert.deepEqual(t.map((r) => [r.team_id, r.points]), [['X', 18], ['Y', 18], ['Z', 6]]);
  const adj = computeRankedStandings(teams, meets, { tiebreakers: ['points'] }, [{ team_id: 'X', points_delta: -5 }]);
  assert.equal(adj[0].team_id, 'Y');
  assert.deepEqual(normaliseRules({ placement_points: [5, 3] }).placement_points, [5, 3]);
});

// ------------------------------------------------------------------ match-week administration
test('match weeks: windows are enforced, every kick-off change is logged, a week can be shifted or closed, and a closed week refuses changes', async () => {
  const L = await league({ count: 4 });
  const gen = must(await api('POST', `/divisions/${L.divs[0].id}/generate-fixtures`, { token: L.org.token, body: { first_round_on: day(2), days_between_rounds: 7 } }), 201);
  assert.equal(gen.rounds, 3);
  const cal = must(await api('GET', `/seasons/${L.season.id}/calendar`, { query: { limit: '100' } }));
  assert.equal(cal.items.length, 6);
  assert.equal(cal.changes, undefined, 'the schedule history is for administrators');
  const r1 = cal.items.filter((x) => x.round_number === 1);
  const g = r1[0];
  // a kick-off outside the round's one-day window needs an explicit confirmation
  const far = new Date(Date.now() + 20 * 864e5).toISOString();
  const free = await api('POST', `/competition-fixtures/${g.id}/decision`, { token: L.org.token, body: { scheduled_at: new Date(Date.now() + 25 * 864e5).toISOString(), reason: 'Windows are not enforced by default' } });
  assert.equal(free.status, 200, 'windows are advisory until a round opts in');
  must(await api('PATCH', `/rounds/${g.round_id}`, { token: L.org.token, body: { window_enforced: true } }));
  const refused = await api('POST', `/competition-fixtures/${g.id}/decision`, { token: L.org.token, body: { scheduled_at: far, reason: 'Pitch unavailable' } });
  assert.equal(refused.status, 409); assert.match(JSON.stringify(refused.body), /outside_round_window/);
  must(await api('POST', `/competition-fixtures/${g.id}/decision`, { token: L.org.token, body: { scheduled_at: far, outside_window: true, reason: 'Pitch unavailable' } }));
  const staff = must(await api('GET', `/seasons/${L.season.id}/calendar`, { token: L.org.token, query: { limit: '100' } }));
  assert.equal(staff.changes.length, 1); assert.equal(staff.changes[0].action, 'rescheduled');
  // update the window, then shift the whole of round 2 by two days
  const rid = cal.items.find((x) => x.round_number === 2).round_id;
  const before = cal.items.filter((x) => x.round_id === rid).map((x) => +new Date(x.scheduled_at));
  const shifted = must(await api('POST', `/rounds/${rid}/shift`, { token: L.org.token, body: { days: 2, reason: 'Public holiday' } }));
  assert.equal(shifted.games_moved, 2);
  const after = (await pool.query("SELECT f.scheduled_at FROM comp_fixture_links l JOIN fixtures f ON f.id=l.fixture_id WHERE l.round_id=$1 ORDER BY f.id", [rid])).rows.map((r) => +new Date(r.scheduled_at));
  assert.equal(after.reduce((a, b) => a + b, 0) - before.reduce((a, b) => a + b, 0), 2 * 2 * 864e5);
  assert.equal((await api('POST', `/rounds/${rid}/shift`, { token: L.mgrs?.[0]?.token ?? L.teams[0].mgr.token, body: { days: 1, reason: 'sneaky one' } })).status, 404);
  // closing is refused while games are open; once settled it closes; a closed week refuses changes; reopening needs a reason
  const refusedClose = await api('POST', `/rounds/${rid}/status`, { token: L.org.token, body: { action: 'close' } });
  assert.equal(refusedClose.status, 409);
  await pool.query("UPDATE fixtures f SET status='completed', home_score=1, away_score=0 FROM comp_fixture_links l WHERE l.fixture_id=f.id AND l.round_id=$1", [rid]);
  must(await api('POST', `/rounds/${rid}/status`, { token: L.org.token, body: { action: 'close' } }));
  const id2 = cal.items.find((x) => x.round_id === rid).id;
  assert.equal((await api('POST', `/competition-fixtures/${id2}/decision`, { token: L.org.token, body: { postpone: true, reason: 'Too late now' } })).status, 409);
  assert.equal((await api('PATCH', `/rounds/${rid}`, { token: L.org.token, body: { label: 'Match week 2' } })).status, 409);
  assert.equal((await api('POST', `/rounds/${rid}/status`, { token: L.org.token, body: { action: 'reopen' } })).status, 400);
  must(await api('POST', `/rounds/${rid}/status`, { token: L.org.token, body: { action: 'reopen', reason: 'A result was protested' } }));
  const renamed = must(await api('PATCH', `/rounds/${rid}`, { token: L.org.token, body: { label: 'Match week 2' } }));
  assert.equal(renamed.label, 'Match week 2');
  // the calendar filters by team
  const t0 = L.teams[0];
  const mine = must(await api('GET', `/seasons/${L.season.id}/calendar`, { query: { team_id: t0.id } }));
  assert.ok(mine.items.every((x) => x.home_team_id === t0.id || x.away_team_id === t0.id)); assert.equal(mine.items.length, 3);
});

// ------------------------------------------------------------------ play-offs
test('play-off stage: the top of a table plays a knockout made of ordinary fixtures, the winner advances through the normal result flow and the final decides the champion', async () => {
  const L = await league({ count: 4 });
  must(await api('POST', `/divisions/${L.divs[0].id}/generate-fixtures`, { token: L.org.token, body: { first_round_on: day(-30), days_between_rounds: 1 } }), 201);
  // table order: team k beats everyone below it
  const order = L.teams.map((t) => t.id);
  const fx = (await pool.query('SELECT f.id, f.home_team_id h, f.away_team_id a FROM comp_fixture_links l JOIN fixtures f ON f.id=l.fixture_id WHERE l.division_id=$1', [L.divs[0].id])).rows;
  for (const f of fx) { const homeWins = order.indexOf(f.h) < order.indexOf(f.a); await pool.query("UPDATE fixtures SET status='completed', home_score=$2, away_score=$3 WHERE id=$1", [f.id, homeWins ? 1 : 0, homeWins ? 0 : 1]); }
  assert.equal((await api('POST', `/seasons/${L.season.id}/playoff-stage`, { token: L.teams[0].mgr.token, body: { source_division_id: L.divs[0].id, teams: 4, first_round_on: day(1) } })).status, 404);
  const po = must(await api('POST', `/seasons/${L.season.id}/playoff-stage`, { token: L.org.token, body: { source_division_id: L.divs[0].id, teams: 4, third_place: true, first_round_on: day(1) } }), 201);
  assert.equal(po.division.kind, 'playoff'); assert.deepEqual(po.qualifiers.map((q) => q.team_id), order);
  assert.equal(po.fixtures, 4); // two semi-finals, a final and a third-place game
  assert.equal((await api('POST', `/seasons/${L.season.id}/playoff-stage`, { token: L.org.token, body: { source_division_id: L.divs[0].id, teams: 4, first_round_on: day(1) } })).status, 409, 'a stage name is unique');
  // no second match store: the games are fixtures of the season's event, linked once
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM fixtures WHERE event_id=$1', [L.season.event_id])).rows[0].n, 6 + 4);
  // the league members keep a single live membership
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM comp_memberships WHERE season_id=$1 AND status='accepted'", [L.season.id])).rows[0].n, 4);
  const games = (await pool.query("SELECT f.* FROM comp_fixture_links l JOIN fixtures f ON f.id=l.fixture_id WHERE l.division_id=$1 ORDER BY f.round_kind, f.bracket_slot", [po.division.id])).rows;
  const semis = games.filter((g) => g.round_kind === 'semi');
  assert.equal(semis.length, 2);
  // seed 1 v 4 and 2 v 3; the underdog 3 beats 2 and 1 beats 4: the final is 1 v 3
  for (const s of semis) {
    const upset = s.home_team_id === order[1] || s.away_team_id === order[1];
    const winner = upset ? order[2] : order[0];
    const homeWon = s.home_team_id === winner;
    must(await api('POST', `/fixtures/${s.id}/result`, { token: L.org.token, body: { home_score: homeWon ? 2 : 1, away_score: homeWon ? 1 : 2 } }));
  }
  const final = (await pool.query("SELECT * FROM fixtures f WHERE f.id IN (SELECT fixture_id FROM comp_fixture_links WHERE division_id=$1) AND round_kind='final'", [po.division.id])).rows[0];
  assert.deepEqual([final.home_team_id, final.away_team_id].sort(), [order[0], order[2]].sort(), 'winners advanced through the normal result flow');
  must(await api('POST', `/fixtures/${final.id}/result`, { token: L.org.token, body: { home_score: 0, away_score: 1 } }));
  const third = games.find((g) => g.round_kind === 'third_place');
  await pool.query("UPDATE fixtures SET status='completed', home_score=1, away_score=0, winner_team_id=home_team_id WHERE id=$1 AND status<>'completed'", [third.id]);
  const winner = (await pool.query('SELECT winner_team_id FROM fixtures WHERE id=$1', [final.id])).rows[0].winner_team_id;
  const done = must(await api('POST', `/seasons/${L.season.id}/complete`, { token: L.org.token, body: {} }));
  assert.equal(done.champion_team_id, winner, 'the play-off final decides the champion, not the league leader');
  assert.notEqual(winner, null);
  // a round-robin play-off also works
  const L2 = await league({ count: 4 });
  must(await api('POST', `/divisions/${L2.divs[0].id}/generate-fixtures`, { token: L2.org.token, body: { first_round_on: day(-30) } }), 201);
  await playAll(L2.divs[0].id);
  const rr = must(await api('POST', `/seasons/${L2.season.id}/playoff-stage`, { token: L2.org.token, body: { source_division_id: L2.divs[0].id, teams: 3, format: 'round_robin', first_round_on: day(1) } }), 201);
  assert.equal(rr.fixtures, 3);
  const tbl = must(await api('GET', `/divisions/${rr.division.id}/standings`));
  assert.equal(tbl.table.length, 3);
});

// ------------------------------------------------------------------ rollover
test('rollover: the next season gets the divisions, the final rules and invited teams; the source season, its results and its movements are untouched', async () => {
  const L = await league({ count: 4, divisions: ['Premier', 'First'] });
  must(await api('POST', `/seasons/${L.season.id}/rules`, { token: L.org.token, body: { rules: { points: { win: 2 }, movement: { relegate: 1, promote: 1 } }, note: 'Two-point wins' } }), 201);
  for (const d of L.divs) { must(await api('POST', `/divisions/${d.id}/generate-fixtures`, { token: L.org.token, body: { first_round_on: day(-30), days_between_rounds: 1 } }), 201); await playAll(d.id); }
  assert.equal((await api('POST', `/seasons/${L.season.id}/rollover`, { token: L.org.token, body: { label: '2027/28', starts_on: day(210), ends_on: day(400) } })).status, 409, 'only a finished season rolls over');
  must(await api('POST', `/seasons/${L.season.id}/complete`, { token: L.org.token, body: {} }));
  must(await api('POST', `/seasons/${L.season.id}/movements/propose`, { token: L.org.token, body: {} }));
  const frozen = (await pool.query('SELECT hash FROM comp_standing_snapshots WHERE season_id=$1 ORDER BY hash', [L.season.id])).rows;
  assert.equal((await api('POST', `/seasons/${L.season.id}/rollover`, { token: L.teams[0].mgr.token, body: { label: '2027/28', starts_on: day(210), ends_on: day(400) } })).status, 404);
  assert.equal((await api('POST', `/seasons/${L.season.id}/rollover`, { token: L.org.token, body: { label: '2027/28', starts_on: day(400), ends_on: day(210) } })).status, 400);
  assert.equal((await api('POST', `/seasons/${L.season.id}/rollover`, { token: L.org.token, body: { label: '2027/28', starts_on: day(210), ends_on: day(400), invite_teams: true, copy_divisions: false } })).status, 400);
  const roll = must(await api('POST', `/seasons/${L.season.id}/rollover`, { token: L.org.token, body: { label: '2027/28', starts_on: day(210), ends_on: day(400), registration_opens_on: day(150), registration_closes_on: day(200), invite_teams: true } }), 201);
  assert.equal(roll.season.status, 'draft'); assert.equal(roll.divisions, 2);
  assert.equal(roll.season.previous_season_id, L.season.id);
  assert.notEqual(roll.season.event_id, L.season.event_id, 'a new canonical event; nothing is copied into the old one');
  assert.equal(roll.rolled_from, L.season.id);
  // promoted / relegated teams are left to the confirmed movement decision, the others are invited into their own division
  assert.equal(roll.teams_invited + roll.teams_left_to_movements, 8);
  assert.ok(roll.teams_invited >= 4);
  const nx = must(await api('GET', `/seasons/${roll.season.id}`, { token: L.org.token }));
  assert.deepEqual(nx.divisions.map((d) => d.name).sort(), ['First', 'Premier']);
  assert.equal(nx.rules.points.win, 2, 'the final rule version is carried forward');
  const mem = must(await api('GET', `/seasons/${roll.season.id}/memberships`, { token: L.org.token, query: { status: 'invited' } }));
  assert.equal(mem.items.length, roll.teams_invited);
  // the team manager still accepts their own invitation once the season is open
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM fixtures WHERE event_id=$1', [roll.season.event_id])).rows[0].n, 0, 'no fixtures are copied');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM comp_adjustments WHERE season_id=$1', [roll.season.id])).rows[0].n, 0);
  const after = (await pool.query('SELECT hash FROM comp_standing_snapshots WHERE season_id=$1 ORDER BY hash', [L.season.id])).rows;
  assert.deepEqual(after, frozen, 'the frozen tables of the finished season are unchanged');
  assert.equal((await api('POST', `/seasons/${L.season.id}/rollover`, { token: L.org.token, body: { label: '2027/28', starts_on: day(210), ends_on: day(400) } })).status, 409, 'the label is taken');
  // archive afterwards, and roll over again from the archived season under a new label
  must(await api('POST', `/seasons/${L.season.id}/status`, { token: L.org.token, body: { status: 'archived' } }));
  must(await api('POST', `/seasons/${L.season.id}/rollover`, { token: L.org.token, body: { label: '2028/29', starts_on: day(410), ends_on: day(600) } }), 201);
});

// ------------------------------------------------------------------ ranked sports
test('ranked-meet sports (time, distance, weight, judged) run as a meet series with their own points table through the same competition structure', async () => {
  const sports = (await pool.query("SELECT DISTINCT ON (scoring) slug, scoring FROM sports WHERE scoring IN ('time','distance','weight','judged') ORDER BY scoring, slug")).rows;
  assert.equal(sports.length, 4);
  for (const sport of sports) {
    const L = await league({ sport: sport.slug, count: 3 });
    const d = L.divs[0];
    assert.equal((await api('POST', `/divisions/${d.id}/generate-fixtures`, { token: L.org.token, body: { first_round_on: day(-20) } })).status, 400, 'a meet series needs its number of meets');
    const gen = must(await api('POST', `/divisions/${d.id}/generate-fixtures`, { token: L.org.token, body: { first_round_on: day(-20), meets: 2, days_between_rounds: 14 } }), 201);
    assert.equal(gen.model, 'ranked_meets'); assert.equal(gen.fixtures, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM fixtures WHERE event_id=$1', [L.season.event_id])).rows[0].n, 0, 'no fixture rows for a meet series');
    const meets = must(await api('GET', `/divisions/${d.id}/meets`)).items;
    assert.equal(meets.length, 2);
    const [x, y, z] = L.teams; const low = sport.scoring === 'time';
    const v = low ? [10, 11, 12] : [12, 11, 10];
    assert.equal((await api('POST', `/rounds/${meets[0].id}/results`, { token: x.mgr.token, body: { results: [{ team_id: x.id, value: v[0] }] } })).status, 404);
    must(await api('POST', `/rounds/${meets[0].id}/results`, { token: L.org.token, body: { results: [{ team_id: x.id, value: v[0] }, { team_id: y.id, value: v[1] }, { team_id: z.id, value: v[2] }] } }));
    must(await api('POST', `/rounds/${meets[1].id}/results`, { token: L.org.token, body: { results: [{ team_id: y.id, value: v[0] }, { team_id: x.id, value: v[1] }, { team_id: z.id, status: 'dnf' }] } }));
    const t = must(await api('GET', `/divisions/${d.id}/standings`));
    assert.deepEqual(t.table.map((r) => r.points), [18, 18, 6]);
    assert.equal(t.table[2].team_id, z.id);
    must(await api('POST', `/divisions/${d.id}/adjustments`, { token: L.org.token, body: { team_id: x.id, points_delta: -5, reason: 'Late arrival penalty' } }), 201);
    assert.equal(must(await api('GET', `/divisions/${d.id}/standings`)).table[0].team_id, y.id);
    // a correction replaces the listed results and keeps the earlier publication in the log
    must(await api('POST', `/rounds/${meets[0].id}/results`, { token: L.org.token, body: { results: [{ team_id: x.id, value: v[2] }, { team_id: z.id, value: v[0] }], reason: 'Timing correction' } }));
    const withLog = must(await api('GET', `/divisions/${d.id}/meets`, { token: L.org.token, query: { log: 'true' } })).items[0];
    assert.equal(withLog.log.length, 2);
    assert.equal((await api('POST', `/divisions/${d.id}/playoff-stage`, { token: L.org.token, body: {} })).status, 404);
    // a meet without results blocks completion; closing the first meet needs its results; with both the season completes
    must(await api('POST', `/rounds/${meets[0].id}/status`, { token: L.org.token, body: { action: 'close' } }));
    assert.equal((await api('POST', `/rounds/${meets[0].id}/results`, { token: L.org.token, body: { results: [{ team_id: x.id, value: v[0] }] } })).status, 409, 'a closed meet is closed');
    const done = must(await api('POST', `/seasons/${L.season.id}/complete`, { token: L.org.token, body: {} }));
    assert.equal(done.divisions_frozen, 1);
    const hist = must(await api('GET', `/competitions/${L.comp.id}/history`));
    assert.equal(hist.items[0].divisions[0].table.length, 3);
    // a closed season refuses new meet results at the database
    await assert.rejects(pool.query("INSERT INTO comp_meet_results(round_id,season_id,division_id,team_id,value,position,status,entered_by) VALUES ($1,$2,$3,$4,1,1,'finished',$5)", [meets[1].id, L.season.id, d.id, z.id, L.org.id]), /closed/);
  }
});

test('a head-to-head sport cannot take meet results, and a meet series cannot take a play-off or fixtures', async () => {
  const L = await league({ count: 3 });
  must(await api('POST', `/divisions/${L.divs[0].id}/generate-fixtures`, { token: L.org.token, body: { first_round_on: day(-5) } }), 201);
  const rid = (await pool.query('SELECT id FROM comp_rounds WHERE division_id=$1 LIMIT 1', [L.divs[0].id])).rows[0].id;
  assert.equal((await api('POST', `/rounds/${rid}/results`, { token: L.org.token, body: { results: [{ team_id: L.teams[0].id, value: 1 }] } })).status, 422);
});

// ------------------------------------------------------------------ event workspace link + MCP
test('the season event knows its competition (private ones stay private) so the event workspace and the competition point at each other; every action is also an MCP tool', async () => {
  const L = await league({ count: 2 });
  const ev = must(await api('GET', `/events/${L.season.event_id}`, { token: L.org.token }));
  assert.equal(ev.competition.id, L.comp.id); assert.equal(ev.competition.season, '2026/27');
  const stranger = await signup(['athlete']);
  must(await api('PATCH', `/competitions/${L.comp.id}`, { token: L.org.token, body: { is_public: false } }));
  assert.equal(must(await api('GET', `/events/${L.season.event_id}`, { token: stranger.token })).competition ?? null, null);
  assert.equal(must(await api('GET', `/events/${L.season.event_id}`, { token: L.org.token })).competition.id, L.comp.id);
  const plain = must(await api('POST', '/events', { token: L.org.token, body: { name: 'Plain cup', sport: 'football' } }), 201);
  assert.equal(must(await api('GET', `/events/${plain.id}`)).competition ?? null, null);
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${L.org.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  const names = (await r.json()).result.tools.map((t) => t.name);
  for (const t of ['rollover_season', 'create_playoff_stage', 'shift_round', 'set_round_status', 'update_round', 'list_season_calendar', 'record_meet_results', 'list_division_meets']) assert.ok(names.includes(t), t);
});
