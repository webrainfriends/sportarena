import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { computeStandings, roundRobin, proposeMovements, normaliseRules } = await import('../src/competition-standings.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const rpc = async (method, params, token) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return (await r.json()).result;
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `cp_${n}_${roles[0]}`, display_name: `Cp ${n}`, email: `cp${n}@example.com`, password: 'correct-horse-battery-9', roles } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

// ------------------------------------------------------------------ pure engine
const T = (...ids) => ids.map((x) => ({ team_id: x, name: x }));
const g = (h, a, hs, as, extra = {}) => ({ home_team_id: h, away_team_id: a, status: 'completed', home_score: hs, away_score: as, ...extra });

test('standings engine: head-to-head beats goal difference when the rules say so, and the rule version changes the order', () => {
  // A and B finish level on 6; B beat A directly, A has the better goal difference
  const fx = [g('A', 'B', 0, 1), g('A', 'C', 6, 0), g('A', 'D', 6, 0), g('B', 'C', 0, 1), g('B', 'D', 1, 0), g('C', 'D', 0, 0), g('C', 'A', 0, 0), g('D', 'B', 0, 0)];
  const h2h = computeStandings(T('A', 'B', 'C', 'D'), fx, { tiebreakers: ['points', 'head_to_head_points', 'diff'] });
  const diff = computeStandings(T('A', 'B', 'C', 'D'), fx, { tiebreakers: ['points', 'diff'] });
  assert.equal(h2h[0].points, h2h[1].points);
  assert.deepEqual([h2h[0].team_id, diff[0].team_id], ['B', 'A']);
});
test('standings engine: forfeits, adjustments and unplayed games', () => {
  const t = computeStandings(T('A', 'B', 'C'), [{ home_team_id: 'A', away_team_id: 'B', status: 'scheduled', outcome: 'forfeit_home' }, g('B', 'C', 1, 1), { home_team_id: 'A', away_team_id: 'C', status: 'scheduled' }], {}, [{ team_id: 'B', points_delta: -2 }]);
  const by = Object.fromEntries(t.map((r) => [r.team_id, r]));
  assert.deepEqual([by.B.won, by.B.points, by.B.adjustment, by.A.forfeits, by.A.points, by.C.played], [1, 2, -2, 1, 0, 1]);
});
test('round robin: everyone meets everyone once (twice when double), no team twice in a round', () => {
  for (const size of [2, 5, 6, 9]) {
    const r = roundRobin(Array.from({ length: size }, (_, i) => `t${i}`), { double: true });
    const games = r.flat(), seen = new Set(games.map(([h, a]) => `${h}>${a}`));
    assert.equal(seen.size, size * (size - 1), `size ${size}`);
    for (const round of r) { const ids = round.flat(); assert.equal(new Set(ids).size, ids.length); }
  }
});
test('movements: promote / relegate / playoff counts from final tables; the top tier cannot be promoted', () => {
  const tbl = (...ids) => ids.map((x, i) => ({ team_id: x, rank: i + 1 }));
  const m = proposeMovements([{ id: 'd1', tier: 1, table: tbl('a', 'b', 'c', 'd'), rules: { movement: { relegate: 1 } } }, { id: 'd2', tier: 2, table: tbl('e', 'f', 'g', 'h'), rules: { movement: { promote: 1, playoff: 1 } } }]);
  const by = Object.fromEntries(m.map((x) => [x.team_id, x.kind]));
  assert.deepEqual([by.a, by.d, by.e, by.f, by.h], ['champion', 'relegation', 'promotion', 'playoff', 'stay']);
  assert.equal(normaliseRules({ tiebreakers: ['diff'] }).tiebreakers[0], 'points');
});

// ------------------------------------------------------------------ lifecycle (PostgreSQL)
const league = async (teamCount = 4) => {
  const org = await signup(['organizer']);
  const comp = must(await api('POST', '/competitions', { token: org.token, body: { name: `City League ${++n}`, sport: 'football', country: 'IN', level: 'amateur', is_public: true } }), 201);
  const season = must(await api('POST', `/competitions/${comp.id}/seasons`, { token: org.token, body: { label: '2026/27', starts_on: day(1), ends_on: day(200), registration_opens_on: day(-1), registration_closes_on: day(10), rules: { movement: { promote: 1, relegate: 1 } } } }), 201);
  const div = must(await api('POST', `/seasons/${season.id}/divisions`, { token: org.token, body: { name: 'Premier', tier: 1, capacity: 8 } }), 201);
  const mgrs = [], teams = [];
  for (let i = 0; i < teamCount; i++) {
    const m = await signup(); mgrs.push(m);
    teams.push(must(await api('POST', '/teams', { token: m.token, body: { name: `FC ${n}-${i}`, sport: 'football' } }), 201));
  }
  return { org, comp, season, div, mgrs, teams };
};
const openAndFill = async (L) => {
  must(await api('POST', `/seasons/${L.season.id}/status`, { token: L.org.token, body: { status: 'open' } }));
  const ms = [];
  for (const [i, t] of L.teams.entries()) ms.push(must(await api('POST', `/seasons/${L.season.id}/memberships`, { token: L.mgrs[i].token, body: { team_id: t.id, division_id: L.div.id } }), 201));
  for (const m of ms) must(await api('POST', `/memberships/${m.id}/decision`, { token: L.org.token, body: { action: 'accept' } }));
  return ms;
};

test('one competition holds many seasons without copying teams or events; registration is authorised, windowed and capacity-checked', async () => {
  const L = await league();
  assert.equal(L.season.rule_version, 1);
  // a draft season is invisible to the public; the competition is visible
  assert.equal((await api('GET', `/seasons/${L.season.id}`)).status, 404);
  assert.equal((await api('GET', `/competitions/${L.comp.id}`)).status, 200);
  // a stranger cannot manage; a team manager cannot apply before the season is open or for someone else's team
  const stranger = await signup(['organizer']);
  assert.equal((await api('POST', `/competitions/${L.comp.id}/seasons`, { token: stranger.token, body: { label: 'x', starts_on: day(1), ends_on: day(2) } })).status, 404);
  assert.equal((await api('POST', `/seasons/${L.season.id}/memberships`, { token: L.mgrs[0].token, body: { team_id: L.teams[0].id } })).status, 404, 'a draft season is invisible to teams');
  must(await api('POST', `/seasons/${L.season.id}/status`, { token: L.org.token, body: { status: 'open' } }));
  assert.equal((await api('POST', `/seasons/${L.season.id}/memberships`, { token: L.mgrs[1].token, body: { team_id: L.teams[0].id } })).status, 404, 'not their team');
  const wrongSport = must(await api('POST', '/teams', { token: L.mgrs[0].token, body: { name: `Swim ${n}`, sport: 'swimming' } }), 201);
  assert.equal((await api('POST', `/seasons/${L.season.id}/memberships`, { token: L.mgrs[0].token, body: { team_id: wrongSport.id } })).status, 400);
  const m = must(await api('POST', `/seasons/${L.season.id}/memberships`, { token: L.mgrs[0].token, body: { team_id: L.teams[0].id, division_id: L.div.id } }), 201);
  assert.equal(m.status, 'applied');
  assert.equal(m.eligibility.checks.find((c) => c.rule === 'sport').pass, true);
  assert.equal((await api('POST', `/seasons/${L.season.id}/memberships`, { token: L.mgrs[0].token, body: { team_id: L.teams[0].id } })).status, 409, 'one live membership per season');
  // a team can neither accept its own application nor remove another; the organiser accepts and the canonical entry appears once
  assert.equal((await api('POST', `/memberships/${m.id}/decision`, { token: L.mgrs[0].token, body: { action: 'accept' } })).status, 403);
  must(await api('POST', `/memberships/${m.id}/decision`, { token: L.org.token, body: { action: 'accept' } }));
  const entries = (await pool.query("SELECT count(*)::int AS n FROM event_entries WHERE event_id=$1 AND team_id=$2 AND status='accepted'", [L.season.event_id, L.teams[0].id])).rows[0].n;
  assert.equal(entries, 1);
  assert.equal((await api('GET', `/seasons/${L.season.id}`)).status, 200, 'open season is public');
  // a second season of the same competition reuses the rules and the teams stay canonical
  const s2 = must(await api('POST', `/competitions/${L.comp.id}/seasons`, { token: L.org.token, body: { label: '2027/28', starts_on: day(300), ends_on: day(500) } }), 201);
  assert.equal(s2.rules.movement.promote, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM teams WHERE id=$1', [L.teams[0].id])).rows[0].n, 1);
  assert.equal(must(await api('GET', `/competitions/${L.comp.id}`, { token: L.org.token })).seasons.length, 2);
  assert.equal(must(await api('GET', `/competitions/${L.comp.id}`)).seasons.length, 1, 'the public does not see the draft season');
});

test('registration windows are enforced on calendar dates and seasons return plain dates', async () => {
  const L = await league(2);
  assert.match(L.season.starts_on, /^\d{4}-\d{2}-\d{2}$/);
  must(await api('POST', `/seasons/${L.season.id}/status`, { token: L.org.token, body: { status: 'open' } }));
  const team = (i) => ({ token: L.mgrs[i].token, body: { team_id: L.teams[i].id } });
  must(await api('PATCH', `/seasons/${L.season.id}`, { token: L.org.token, body: { registration_opens_on: day(2), registration_closes_on: day(9) } }));
  assert.equal((await api('POST', `/seasons/${L.season.id}/memberships`, team(0))).body.error.details.code, 'window_closed', 'not open yet');
  must(await api('PATCH', `/seasons/${L.season.id}`, { token: L.org.token, body: { registration_opens_on: day(-9), registration_closes_on: day(-2) } }));
  assert.equal((await api('POST', `/seasons/${L.season.id}/memberships`, team(0))).status, 409, 'already closed');
  assert.equal(must(await api('GET', `/seasons/${L.season.id}`)).registration_window.open_now, false);
  must(await api('PATCH', `/seasons/${L.season.id}`, { token: L.org.token, body: { registration_opens_on: day(-1), registration_closes_on: day(3) } }));
  assert.equal(must(await api('GET', `/seasons/${L.season.id}`)).registration_window.open_now, true);
  must(await api('POST', `/seasons/${L.season.id}/memberships`, team(0)), 201);
  assert.equal((await api('POST', `/seasons/${L.season.id}/memberships`, { ...team(1), body: { team_id: L.teams[1].id, accept: true } })).status, 403, 'a team cannot accept itself');
});

test('capacity holds under concurrent acceptance (the database, not the client, stops overselling)', async () => {
  const L = await league(5);
  must(await api('PATCH', `/divisions/${L.div.id}`, { token: L.org.token, body: { capacity: 2 } }));
  must(await api('POST', `/seasons/${L.season.id}/status`, { token: L.org.token, body: { status: 'open' } }));
  const ms = [];
  for (const [i, t] of L.teams.entries()) ms.push(must(await api('POST', `/seasons/${L.season.id}/memberships`, { token: L.mgrs[i].token, body: { team_id: t.id, division_id: L.div.id } }), 201));
  const res = await Promise.all(ms.map((m) => api('POST', `/memberships/${m.id}/decision`, { token: L.org.token, body: { action: 'accept' } })));
  assert.equal(res.filter((r) => r.status === 200).length, 2, JSON.stringify(res.map((r) => r.status)));
  assert.ok(res.filter((r) => r.status !== 200).every((r) => r.status === 409));
  assert.equal((await api('PATCH', `/divisions/${L.div.id}`, { token: L.org.token, body: { capacity: 2 } })).status, 200);
});

test('full season: schedule, results, forfeit, postponement, rule versions, adjustments, completion, frozen history, movements and next-season invitations', async () => {
  const L = await league(4);
  const ms = await openAndFill(L);
  const [a, b, c, d] = L.teams;
  must(await api('POST', `/seasons/${L.season.id}/status`, { token: L.org.token, body: { status: 'active' } }));
  const gen = must(await api('POST', `/divisions/${L.div.id}/generate-fixtures`, { token: L.org.token, body: { first_round_on: day(2), kickoff: '10:30' } }), 201);
  assert.deepEqual([gen.rounds, gen.fixtures], [3, 6]);
  assert.equal((await api('POST', `/divisions/${L.div.id}/generate-fixtures`, { token: L.org.token, body: { first_round_on: day(2) } })).status, 409, 'not twice');
  const list = must(await api('GET', `/divisions/${L.div.id}/fixtures`, { query: { limit: 50 } }));
  assert.equal(list.items.length, 6);
  const fx = (h, aw) => list.items.find((f) => (f.home_team_id === h.id && f.away_team_id === aw.id) || (f.home_team_id === aw.id && f.away_team_id === h.id));
  // canonical results flow through record_result; the standings follow
  const score = async (h, aw, hs, as) => { const f = fx(h, aw); const [x, y] = f.home_team_id === h.id ? [hs, as] : [as, hs]; must(await api('POST', `/fixtures/${f.id}/result`, { token: L.org.token, body: { home_score: x, away_score: y } })); };
  await score(a, b, 2, 0); await score(a, c, 1, 1); await score(b, c, 0, 3); await score(c, d, 2, 0);
  // postpone, then forfeit with a reason; a result is never edited
  const pf = fx(a, d);
  must(await api('POST', `/competition-fixtures/${pf.id}/decision`, { token: L.org.token, body: { postpone: true, reason: 'Ground unavailable' } }));
  assert.equal((await pool.query('SELECT status FROM fixtures WHERE id=$1', [pf.id])).rows[0].status, 'postponed');
  assert.equal((await api('POST', `/competition-fixtures/${pf.id}/decision`, { token: L.org.token, body: { outcome: 'forfeit_home', reason: 'x' } })).status, 400, 'reason too short');
  must(await api('POST', `/competition-fixtures/${pf.id}/decision`, { token: L.org.token, body: { outcome: 'forfeit_home', reason: 'Team did not attend' } }));
  const bd = fx(b, d); must(await api('POST', `/competition-fixtures/${bd.id}/decision`, { token: L.org.token, body: { postpone: true, reason: 'Weather' } }));
  assert.equal((await api('POST', `/seasons/${L.season.id}/complete`, { token: L.org.token, body: {} })).status, 409, 'games still open');
  must(await api('POST', `/competition-fixtures/${bd.id}/decision`, { token: L.org.token, body: { postpone: false, scheduled_at: new Date(Date.now() + 5 * 864e5).toISOString(), reason: 'Rescheduled' } }));
  const bdf = fx(b, d); await score(b, d, 1, 1);
  void bdf;
  let st = must(await api('GET', `/divisions/${L.div.id}/standings`));
  assert.equal(st.source, 'live');
  const row = (t) => st.table.find((r) => r.team_id === t.id);
  assert.deepEqual([row(c).points, row(a).forfeits, row(d).won], [7, 1, 1]);
  assert.equal(st.table[0].team_id, c.id);
  // adjustments are explicit, reasoned, append-only and reversible; results are untouched
  assert.equal((await api('POST', `/divisions/${L.div.id}/adjustments`, { token: L.org.token, body: { team_id: c.id, points_delta: -3, reason: 'x' } })).status, 400);
  const adj = must(await api('POST', `/divisions/${L.div.id}/adjustments`, { token: L.org.token, body: { team_id: c.id, points_delta: -3, reason: 'Fielded an ineligible player' } }), 201);
  st = must(await api('GET', `/divisions/${L.div.id}/standings`));
  assert.equal(row(c).points, 4); assert.equal(row(c).adjustment, -3);
  await assert.rejects(pool.query('UPDATE comp_adjustments SET points_delta=0 WHERE id=$1', [adj.id]), /append-only/);
  await assert.rejects(pool.query('DELETE FROM comp_adjustments WHERE id=$1', [adj.id]), /append-only/);
  must(await api('POST', `/divisions/${L.div.id}/adjustments`, { token: L.org.token, body: { team_id: c.id, reverses_id: adj.id, reason: 'Appeal upheld' } }), 201);
  assert.equal((await api('POST', `/divisions/${L.div.id}/adjustments`, { token: L.org.token, body: { team_id: c.id, reverses_id: adj.id, reason: 'Again please' } })).status, 409);
  // versioned rules: a new version re-scores the live table; the old version is still on record
  must(await api('POST', `/seasons/${L.season.id}/rules`, { token: L.org.token, body: { rules: { points: { win: 2 } }, note: 'Two for a win' } }), 201);
  const before2 = must(await api('GET', `/divisions/${L.div.id}/standings`));
  assert.equal(before2.rule_version, 2);
  assert.equal(must(await api('GET', `/seasons/${L.season.id}/rules`)).items.length, 2);
  must(await api('POST', `/seasons/${L.season.id}/rules`, { token: L.org.token, body: { rules: { points: { win: 3 } }, note: 'Back to three' } }), 201);
  // complete: tables frozen with rule version + hash, champion recorded
  const done = must(await api('POST', `/seasons/${L.season.id}/complete`, { token: L.org.token, body: {} }));
  assert.equal(done.status, 'completed'); assert.equal(done.champion_team_id, c.id);
  const frozen = must(await api('GET', `/divisions/${L.div.id}/standings`));
  assert.equal(frozen.source, 'snapshot'); assert.equal(frozen.rule_version, 3);
  // completed seasons stay reproducible after rule, team or structure changes
  assert.equal((await api('POST', `/seasons/${L.season.id}/rules`, { token: L.org.token, body: { rules: { points: { win: 9 } } } })).status, 409);
  assert.equal((await api('POST', `/divisions/${L.div.id}/adjustments`, { token: L.org.token, body: { team_id: a.id, points_delta: 5, reason: 'Late change' } })).status, 409);
  assert.equal((await api('POST', `/memberships/${ms[0].id}/decision`, { token: L.org.token, body: { action: 'remove', reason: 'Too late' } })).status, 409);
  await assert.rejects(pool.query("UPDATE comp_memberships SET status='removed' WHERE id=$1", [ms[0].id]), /history is closed/);
  await assert.rejects(pool.query('UPDATE comp_standing_snapshots SET hash=$1 WHERE division_id=$2', ['x', L.div.id]), /append-only/);
  await pool.query("UPDATE teams SET name='Renamed' WHERE id=$1", [a.id]);
  const again = must(await api('GET', `/divisions/${L.div.id}/standings`));
  assert.deepEqual(again.table, frozen.table); assert.equal(again.hash, frozen.hash);
  const hist = must(await api('GET', `/competitions/${L.comp.id}/history`));
  assert.equal(hist.items[0].champion_name, again.table[0].name); assert.equal(hist.items[0].divisions[0].table.length, 4);
  assert.ok(must(await api('GET', `/seasons/${L.season.id}/membership-history`)).items.some((e) => e.action === 'accepted'), 'public once completed');
  // movements: proposals only until a person confirms; confirming creates invitations, not entries
  must(await api('POST', `/seasons/${L.season.id}/movements/propose`, { token: L.org.token, body: {} }));
  const mv = must(await api('GET', `/seasons/${L.season.id}/movements`, { token: L.org.token })).items;
  assert.equal(mv.length, 4); assert.ok(mv.some((x) => x.kind === 'relegation'));
  const s2 = must(await api('POST', `/competitions/${L.comp.id}/seasons`, { token: L.org.token, body: { label: '2027/28', starts_on: day(300), ends_on: day(500) } }), 201);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM comp_memberships WHERE season_id=$1', [s2.id])).rows[0].n, 0, 'nothing before confirmation');
  const d2 = must(await api('POST', `/seasons/${s2.id}/divisions`, { token: L.org.token, body: { name: 'Premier', tier: 1 } }), 201);
  const rel = mv.find((x) => x.kind === 'relegation');
  assert.equal((await api('POST', `/seasons/${L.season.id}/movements/confirm`, { token: L.org.token, body: { next_season_id: s2.id, decisions: [{ movement_id: rel.id, action: 'confirm' }] } })).status, 400, 'a division must be chosen');
  assert.equal((await api('POST', `/seasons/${L.season.id}/movements/confirm`, { token: L.mgrs[0].token, body: { next_season_id: s2.id, decisions: [{ movement_id: rel.id, action: 'confirm', division_id: d2.id }] } })).status, 404);
  const conf = must(await api('POST', `/seasons/${L.season.id}/movements/confirm`, { token: L.org.token, body: { next_season_id: s2.id, decisions: [{ movement_id: rel.id, action: 'confirm', division_id: d2.id }, ...mv.filter((x) => x.kind === 'champion').map((x) => ({ movement_id: x.id, action: 'decline' }))] } }));
  assert.deepEqual([conf.invited, conf.declined], [1, 1]);
  const inv = (await pool.query("SELECT * FROM comp_memberships WHERE season_id=$1", [s2.id])).rows;
  assert.deepEqual([inv.length, inv[0].status], [1, 'invited']);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM event_entries WHERE event_id=$1', [s2.event_id])).rows[0].n, 0, 'no entry until the team accepts');
  const mgr = L.mgrs[L.teams.findIndex((t) => t.id === rel.team_id)];
  must(await api('POST', `/memberships/${inv[0].id}/decision`, { token: mgr.token, body: { action: 'accept' } }));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM event_entries WHERE event_id=$1 AND status='accepted'", [s2.event_id])).rows[0].n, 1);
  assert.equal((await api('POST', `/seasons/${L.season.id}/movements/confirm`, { token: L.org.token, body: { next_season_id: s2.id, decisions: [{ movement_id: rel.id, action: 'confirm', division_id: d2.id }] } })).status, 409, 'decided once');
  const rep = must(await api('GET', `/seasons/${L.season.id}/report`, { token: L.org.token }));
  assert.deepEqual([rep.divisions[0].teams, rep.divisions[0].frozen], [4, true]);
  assert.match(must(await api('GET', `/seasons/${L.season.id}/report`, { token: L.org.token, query: { format: 'csv' } })).content, /Premier/);
});

test('a team already in a division keeps its place: moves are reasoned, history is append-only, results pin a team', async () => {
  const L = await league(3);
  const ms = await openAndFill(L);
  const d2 = must(await api('POST', `/seasons/${L.season.id}/divisions`, { token: L.org.token, body: { name: 'Championship', tier: 2 } }), 201);
  assert.equal((await api('POST', `/memberships/${ms[0].id}/move`, { token: L.org.token, body: { division_id: d2.id, reason: '' } })).status, 400);
  must(await api('POST', `/memberships/${ms[0].id}/move`, { token: L.org.token, body: { division_id: d2.id, reason: 'Requested lower division' } }));
  const h = must(await api('GET', `/seasons/${L.season.id}/membership-history`, { token: L.org.token })).items;
  assert.ok(h.some((e) => e.action === 'moved' && e.from_division_name === 'Premier'));
  await assert.rejects(pool.query('UPDATE comp_membership_events SET reason=$1', ['x']), /append-only/);
  assert.equal((await api('GET', `/seasons/${L.season.id}/membership-history`)).status, 404, 'staff only while running');
});

test('every sport in the catalogue can run a competition; cricket and tennis label their scores natively, others get the labelled fallback', async () => {
  const org = await signup(['organizer']);
  const sports = (await pool.query('SELECT slug,scoring FROM sports ORDER BY slug')).rows;
  assert.ok(sports.length > 0);
  const generic = [];
  for (const s of sports) {
    const c = must(await api('POST', '/competitions', { token: org.token, body: { name: `${s.slug} league ${++n}`, sport: s.slug, is_public: true } }), 201);
    const home = must(await api('GET', `/competitions/${c.id}`, { token: org.token }));
    assert.ok(home.scoring.unit, s.slug);
    if (home.scoring.generic) generic.push(s.slug);
  }
  assert.ok(generic.length < sports.length, `native units for most sports; generic fallback: ${generic.join(', ') || 'none'}`);
});

test('REST, OpenAPI and MCP share the competition capabilities; list is public, paginated and never leaks drafts', async () => {
  const org = await signup(['organizer']);
  const hidden = must(await api('POST', '/competitions', { token: org.token, body: { name: `Hidden ${++n}`, sport: 'football', is_public: false } }), 201);
  const pub = must(await api('POST', '/competitions', { token: org.token, body: { name: `Open ${++n}`, sport: 'football', is_public: true } }), 201);
  const anon = must(await api('GET', '/competitions', { query: { limit: 100 } }));
  assert.ok(anon.items.some((c) => c.id === pub.id) && !anon.items.some((c) => c.id === hidden.id));
  assert.equal((await api('GET', `/competitions/${hidden.id}`)).status, 404);
  assert.equal(must(await api('GET', '/competitions', { token: org.token, query: { mine: 'true', limit: 1 } })).items.length, 1);
  const tools = (await rpc('tools/list', {}, org.token)).tools.map((t) => t.name);
  for (const t of ['create_competition', 'create_season', 'set_season_rules', 'create_division', 'apply_to_season', 'decide_membership', 'generate_division_fixtures', 'get_division_standings', 'add_standing_adjustment', 'complete_season', 'propose_season_movements', 'confirm_season_movements', 'get_competition_history']) assert.ok(tools.includes(t), t);
  const { buildOpenApi } = await import('../src/openapi.js');
  assert.ok(buildOpenApi().paths['/competitions/{id}/seasons']);
});
