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
const signup = async () => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `ah_${n}`, display_name: `Athlete ${n}`, email: `ah${n}@example.com`, password: 'correct-horse-battery', roles: ['athlete'] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const q = async (sql, args) => (await pool.query(sql, args)).rows;
const sportId = async (slug) => (await q('SELECT id FROM sports WHERE slug=$1', [slug]))[0].id;
const team = async (u, name, sport = 'football') => (await api('POST', '/teams', { token: u.token, body: { name, sport } })).body;
const profile = async (u, sport) => (await api('POST', '/me/sport-profiles', { token: u.token, body: { sport, role: 'athlete', level: 'amateur' } })).body;
const history = async (u, qs = '') => (await api('GET', `/me/matches?${qs}`, { token: u.token })).body;
const card = async (u, slug) => (await api('GET', '/me/sport-profiles', { token: u.token })).body.find((p) => p.sport_slug === slug);

async function game(sport, { status = 'post-event', fixture = null, event = null, parts = [], days = -3 } = {}) {
  const owner = (await q('SELECT id FROM users LIMIT 1'))[0].id;
  const g = (await q('INSERT INTO games(sport_id, created_by, title, status, fixture_id, competition_id, starts_at) VALUES ($1,$2,$3,$4,$5,$6, now() + $7 * interval \'1 day\') RETURNING id',
    [await sportId(sport), owner, 'Test game', status, fixture, event, days]))[0].id;
  for (const p of parts) await q('INSERT INTO game_participants(game_id, team_id, user_id, side, outcome, score, rank, stats) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [g, p.team ?? null, p.user ?? null, p.side ?? null, p.outcome ?? null, p.score ?? null, p.rank ?? null, JSON.stringify(p.stats ?? {})]);
  return g;
}
async function fixtureOf(organizer, home, away, { status = 'completed', hs = 2, as = 1 } = {}) {
  const ev = (await q("INSERT INTO events(name, sport_id, organizer_id) VALUES ('Spring Cup', $1, $2) RETURNING id", [await sportId('football'), organizer.id]))[0].id;
  const fx = (await q('INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at, status, home_score, away_score) VALUES ($1,$2,$3, now() - interval \'2 day\', $4,$5,$6) RETURNING id', [ev, home, away, status, hs, as]))[0].id;
  return { ev, fx };
}
const squad = (teamId, fx, user, role = 'player', status = 'confirmed') => q('INSERT INTO team_squads(team_id, fixture_id, user_id, role, status) VALUES ($1,$2,$3,$4,$5)', [teamId, fx, user.id, role, status]);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('manual and imported matches still work and carry their provenance', async () => {
  const u = await signup();
  const p = await profile(u, 'football');
  const m = await api('POST', '/me/matches', { token: u.token, body: { sport_profile_id: p.id, played_on: '2026-01-10', opponent: 'Reds', score_for: 2, score_against: 1, stats: { goals: 2 } } });
  assert.equal(m.status, 201);
  const imp = await api('POST', '/me/matches/import', { token: u.token, body: { sport_profile_id: p.id, rows: [{ played_on: '2026-01-11', opponent: 'Blues', result: 'loss', goals: 1 }] } });
  assert.equal(imp.body.imported, 1);
  const again = await api('POST', '/me/matches/import', { token: u.token, body: { sport_profile_id: p.id, rows: [{ played_on: '2026-01-11', opponent: 'Blues', result: 'loss' }] } });
  assert.equal(again.body.skipped, 1, 'import duplicate rule unchanged');
  const h = await history(u);
  assert.deepEqual(h.map((x) => [x.provenance, x.verification, x.can_delete]), [['imported', 'imported', true], ['manual', 'self_reported', true]]);
  const c = await card(u, 'football');
  assert.equal(c.summary.matches, 2); assert.equal(c.summary.wins, 1); assert.equal(c.summary.losses, 1);
  assert.equal(c.official_summary.matches, 0); assert.equal(c.self_summary.matches, 2);
  assert.equal(c.metrics.find((x) => x.metric === 'goals').total, 3);
  assert.equal((await api('DELETE', `/me/matches/${m.body.id}`, { token: u.token })).status, 200);
  assert.equal((await history(u)).length, 1);
});

test('individual game: appears for the right user and sport, no profile → detected, score correction flows through', async () => {
  const a = await signup(), b = await signup();
  const g = await game('tennis', { parts: [{ user: a.id, outcome: 'win', score: 2 }, { user: b.id, outcome: 'loss', score: 0 }] });
  const ha = await history(a);
  assert.equal(ha.length, 1);
  assert.equal(ha[0].id, `game:${g}`); assert.equal(ha[0].provenance, 'official_game'); assert.equal(ha[0].result, 'win'); assert.equal(ha[0].opponent, 'Athlete ' + b.display_name.split(' ')[1]);
  assert.equal(ha[0].sport_profile_id, null); assert.equal(ha[0].can_delete, false);
  assert.equal(ha[0].score_for, 2); assert.equal(ha[0].score_against, 0);
  assert.deepEqual((await api('GET', '/me/detected-sports', { token: a.token })).body.map((s) => [s.sport_slug, s.matches, s.wins]), [['tennis', 1, 1]]);
  // a football profile does not receive tennis history
  await profile(a, 'football');
  assert.equal((await card(a, 'football')).summary.matches, 0);
  // adding the sport attaches everything at once, nothing invented
  const tp = await profile(a, 'tennis');
  assert.equal((await card(a, 'tennis')).summary.wins, 1);
  assert.equal((await history(a, `sport_profile_id=${tp.id}`))[0].sport_profile_id, tp.id);
  assert.deepEqual((await api('GET', '/me/detected-sports', { token: a.token })).body, []);
  // correction by the organiser changes the athlete's numbers
  await q("UPDATE game_participants SET outcome='loss' WHERE game_id=$1 AND user_id=$2", [g, a.id]);
  const c = await card(a, 'tennis');
  assert.equal(c.summary.wins, 0); assert.equal(c.summary.losses, 1); assert.equal(c.official_summary.matches, 1);
  // unfinished game and unrelated user
  await game('tennis', { status: 'pre-event', parts: [{ user: a.id }] });
  assert.equal((await history(a)).length, 1);
  const stranger = await signup();
  assert.equal((await history(stranger)).length, 0);
  // official rows cannot be deleted; sport card removal keeps them
  assert.equal((await api('DELETE', `/me/matches/game:${g}`, { token: a.token })).status, 403);
  await api('DELETE', `/me/sport-profiles/${tp.id}`, { token: a.token });
  assert.equal((await history(a)).length, 1);
});

test('ranked/timing games are not forced into W-D-L', async () => {
  const a = await signup(), b = await signup(), c = await signup();
  await game('athletics', { parts: [{ user: a.id, outcome: 'place', rank: 2, score: 11.4, stats: { lane: 3 } }, { user: b.id, outcome: 'place', rank: 1 }, { user: c.id, rank: 3 }] });
  const h = (await history(a))[0];
  assert.equal(h.kind, 'competition'); assert.equal(h.result, null); assert.equal(h.rank, 2); assert.equal(h.opponent, null);
  assert.equal(h.stats.lane, 3);
});

test('team fixture: only explicit playing evidence counts; game beats fixture; staff and non-selected never count', async () => {
  const org = await signup();
  const [p1, p2, p3, p4, p5, sub, coach, rosterOnly] = await Promise.all(Array.from({ length: 8 }, signup));
  const home = await team(org, 'Home FC'), away = await team(org, 'Away FC');
  const { ev, fx } = await fixtureOf(org, home.id, away.id, { hs: 3, as: 1 });
  await squad(home.id, fx, p1); await squad(home.id, fx, p2, 'captain'); await squad(home.id, fx, p3, 'player', 'selected');
  await squad(home.id, fx, p4, 'player', 'declined'); await squad(home.id, fx, p5, 'player', 'dropped'); await squad(home.id, fx, sub, 'substitute');
  await squad(home.id, fx, coach, 'coach'); await squad(away.id, fx, rosterOnly, 'player');   // rosterOnly is on the OTHER team's squad
  await q("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [home.id, (await signup()).id]);
  for (const [u, expect] of [[p1, 1], [p2, 1], [p3, 0], [p4, 0], [p5, 0], [sub, 0], [coach, 0]]) assert.equal((await history(u)).length, expect, u.handle);
  const h = (await history(p1))[0];
  assert.deepEqual([h.provenance, h.source_type, h.result, h.score_for, h.score_against, h.opponent, h.competition], ['official_fixture', 'fixture', 'win', 3, 1, 'Away FC', 'Spring Cup']);
  assert.equal((await history(rosterOnly))[0].result, 'loss', 'away player sees their own perspective');
  // a canonical game for the same fixture replaces the fixture row — exactly one item
  const g = await game('football', { fixture: fx, event: ev, parts: [{ team: home.id, side: 'home', outcome: 'win', score: 3 }, { team: away.id, side: 'away', outcome: 'loss', score: 1 }] });
  const after = await history(p1);
  assert.equal(after.length, 1); assert.equal(after[0].id, `game:${g}`); assert.equal(after[0].provenance, 'official_game');
  assert.equal((await history(p3)).length, 0, 'game does not widen who played');
  assert.equal((await history(coach)).length, 0);
  // association evidence: starter counts (with its numeric stats), bench / referee / non-roster do not
  const starter = await signup(), bench = await signup(), stranger = await signup();
  const g2 = await game('football', { parts: [{ team: home.id, side: 'home', outcome: 'tie', score: 1 }, { team: away.id, side: 'away', outcome: 'tie', score: 1 }] });
  for (const u of [starter, bench]) await q("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [home.id, u.id]);
  await q("INSERT INTO associations(user_id, role, target_type, target_id, status, player_status, attributes) VALUES ($1,'player','game',$2,'active','starter','{\"goals\":2,\"note\":\"x\"}')", [starter.id, g2]);
  await q("INSERT INTO associations(user_id, role, target_type, target_id, status, player_status) VALUES ($1,'player','game',$2,'active','bench')", [bench.id, g2]);
  await q("INSERT INTO associations(user_id, role, target_type, target_id, status, player_status) VALUES ($1,'player','game',$2,'active','starter')", [stranger.id, g2]);
  const sh = await history(starter);
  assert.equal(sh.length, 1); assert.equal(sh[0].result, 'draw'); assert.deepEqual(sh[0].stats, { goals: 2 });
  assert.equal((await history(bench)).length, 0); assert.equal((await history(stranger)).length, 0, 'not on a competing team');
});

test('reconcile a logged match with the official one: count once, ambiguity is never merged, links are safe', async () => {
  const org = await signup(), a = await signup(), other = await signup();
  const home = await team(org, 'Reds'), away = await team(org, 'Blues');
  const { fx } = await fixtureOf(org, home.id, away.id, { hs: 2, as: 1 });
  await squad(home.id, fx, a);
  const p = await profile(a, 'football');
  const day = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
  const mine = (await api('POST', '/me/matches', { token: a.token, body: { sport_profile_id: p.id, played_on: day, opponent: 'Blues', score_for: 2, score_against: 1, rating: 7, notes: 'felt good', stats: { goals: 1 } } })).body;
  assert.equal((await card(a, 'football')).summary.matches, 2, 'not merged silently');
  const cands = (await api('GET', `/me/matches/${mine.id}/link-candidates`, { token: a.token })).body;
  assert.equal(cands.length, 1); assert.equal(cands[0].opponent_matches, true);
  assert.equal((await api('GET', `/me/matches/${mine.id}/link-candidates`, { token: other.token })).status, 404);
  assert.equal((await api('POST', `/me/matches/${mine.id}/link`, { token: other.token, body: { source_type: 'fixture', source_id: fx } })).status, 404, 'not their manual row');
  const orgP = await profile(org, 'football');
  const foreign = (await api('POST', '/me/matches', { token: org.token, body: { sport_profile_id: orgP.id, played_on: day } })).body;
  assert.equal((await api('POST', `/me/matches/${foreign.id}/link`, { token: org.token, body: { source_type: 'fixture', source_id: fx } })).status, 400, 'organiser did not play in it');
  const link = { source_type: 'fixture', source_id: fx };
  assert.equal((await api('POST', `/me/matches/${mine.id}/link`, { token: a.token, body: link })).status, 200);
  assert.equal((await api('POST', `/me/matches/${mine.id}/link`, { token: a.token, body: link })).status, 200, 'retry is idempotent');
  assert.equal((await q('SELECT 1 FROM player_match_links WHERE removed_at IS NULL')).length, 1);
  const c = await card(a, 'football');
  assert.equal(c.summary.matches, 1, 'counted once'); assert.equal(c.official_summary.matches, 1); assert.equal(c.self_summary.matches, 0);
  assert.equal(c.metrics.find((x) => x.metric === 'goals'), undefined, 'official facts win over the self-reported stats');
  const h = await history(a);
  assert.equal(h.length, 1); assert.equal(h[0].notes, 'felt good'); assert.equal(h[0].rating, 7); assert.equal(h[0].linked_match_id, mine.id);
  // a second logged match cannot take the same official one
  const dup = (await api('POST', '/me/matches', { token: a.token, body: { sport_profile_id: p.id, played_on: day, opponent: 'Blues FC' } })).body;
  assert.equal((await api('POST', `/me/matches/${dup.id}/link`, { token: a.token, body: link })).status, 409);
  // personal note on the official row, then unlink
  assert.equal((await api('POST', `/me/official-matches/fixture/${fx}/note`, { token: a.token, body: { rating: 9, notes: 'MOTM' } })).status, 200);
  assert.equal((await history(a, 'source=official'))[0].rating, 9);
  assert.equal((await api('POST', `/me/official-matches/fixture/${fx}/note`, { token: other.token, body: { rating: 1 } })).status, 404);
  assert.equal((await api('POST', `/me/matches/${mine.id}/unlink`, { token: a.token })).status, 200);
  assert.equal((await card(a, 'football')).summary.matches, 3, 'logged match counts again: official + 2 logged');
  assert.deepEqual((await history(a, 'source=self')).map((x) => x.provenance), ['manual', 'manual']);
  // the official record is untouched by any of it
  assert.equal((await q('SELECT home_score FROM fixtures WHERE id=$1', [fx]))[0].home_score, 2);
});

test('official stats never double count, filters and pagination are deterministic', async () => {
  const a = await signup();
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(await game('tennis', { days: -10 + i, parts: [{ user: a.id, outcome: 'win', stats: { aces: 2 } }] }));
  const all = await history(a, 'limit=100');
  assert.equal(all.length, 5);
  assert.deepEqual(all.map((x) => x.id), ids.map((g) => `game:${g}`).reverse());
  const pages = [...(await history(a, 'limit=2&offset=0')), ...(await history(a, 'limit=2&offset=2')), ...(await history(a, 'limit=2&offset=4'))];
  assert.deepEqual(pages.map((x) => x.id), all.map((x) => x.id));
  assert.equal((await history(a, 'source=self')).length, 0);
  assert.equal((await history(a, 'sport=football')).length, 0);
  assert.equal((await history(a, 'verification=official')).length, 5);
  assert.equal((await api('GET', '/me/matches?source=bogus', { token: a.token })).status, 400);
  await profile(a, 'tennis');
  const c = await card(a, 'tennis');
  assert.equal(c.official_metrics.find((m) => m.metric === 'aces').total, 10);
  // an official performance row for the same fixture/game is not added on top of the participant stats
  assert.equal(c.metrics.find((m) => m.metric === 'aces').matches, 5);
});

test('openapi exposes the new capabilities', async () => {
  const spec = (await api('GET', '/openapi.json')).body;
  for (const p of ['/me/detected-sports', '/me/matches/{id}/link', '/me/matches/{id}/unlink', '/me/matches/{id}/link-candidates', '/me/official-matches/{source_type}/{source_id}/note']) assert.ok(spec.paths[p], p);
});
