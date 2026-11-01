import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { capabilities } = await import('../src/capabilities/index.js');
const E = await import('../src/ratings/engine.js');
const { MODELS, modelOf } = await import('../src/ratings/models.js');
const { recomputeSport, recomputeAll, reliableLevel } = await import('../src/ratings/data.js');
const { levelFor } = await import('../src/open-games.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
let n = 0;
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `sr_${n}`, display_name: `Sr ${n}`, email: `sr${n}@example.com`, password: 'correct-horse-battery', roles } });
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

const sport = async (slug) => (await pool.query('SELECT * FROM sports WHERE slug=$1', [slug])).rows[0];
const mkEvent = async (org, slug, kind = 'tournament') =>
  (await pool.query("INSERT INTO events(name, sport_id, organizer_id, kind, status, city) VALUES ($1,$2,$3,$4,'completed','Pune') RETURNING id", [`Ev ${++n}`, (await sport(slug)).id, org.id, kind])).rows[0].id;
const mkTeam = async (slug, owner, members) => {
  const t = (await pool.query('INSERT INTO teams(name, sport_id, owner_id) VALUES ($1,$2,$3) RETURNING id', [`T${++n}`, (await sport(slug)).id, owner.id])).rows[0].id;
  for (const m of members) await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [t, m.id]);
  return t;
};
/** One verified game: a completed fixture with a published score sheet (what the official flow leaves behind). Each side is a team owned by its first player. */
const game = async (slug, ev, org, home, away, hs, as, { day = 1, sets = null, sheet = 'published', ownerOverride } = {}) => {
  const h = await mkTeam(slug, home[0], home), a = await mkTeam(slug, ownerOverride ?? away[0], away);
  const at = new Date(Date.now() - (100 - day) * 864e5).toISOString(); // recent, so reliability is not faded by months off the court
  const fx = (await pool.query("INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at, status, home_score, away_score, finished_at) VALUES ($1,$2,$3,$4,'completed',$5,$6,$4) RETURNING id", [ev, h, a, at, hs, as])).rows[0].id;
  const sh = (await pool.query("INSERT INTO score_sheets(fixture_id, event_id, status, home_score, away_score, totals, created_by, published_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id", [fx, ev, sheet, hs, as, JSON.stringify(sets ? { sets } : {}), org.id, at])).rows[0].id;
  return { fx, sheet: sh, h, a };
};
const level = async (user, slug) => (await api('GET', `/ratings/players/${user.id}?sport=${slug}`)).body.ratings[0];

// ------------------------------------------------------------------ pure engine
test('engine: matches the published Glicko-2 worked example', () => {
  const r = E.update({ r: 1500, rd: 200, sigma: 0.06 }, [{ r: 1400, rd: 30, s: 1 }, { r: 1550, rd: 100, s: 0 }, { r: 1700, rd: 300, s: 0 }]);
  assert.ok(Math.abs(r.r - 1464.05) < 0.1 && Math.abs(r.rd - 151.52) < 0.1, JSON.stringify(r));
});

test('engine: the same games give the same ratings in any arrival order, and invalid games are ignored', () => {
  const g = (i, a, b, sa, sb) => ({ id: `g${String(i).padStart(2, '0')}`, played_at: `2026-02-${String(10 + i).padStart(2, '0')}T10:00:00Z`, sides: [{ players: a, score: sa }, { players: b, score: sb }] });
  const games = [g(0, ['A'], ['B'], 2, 0), g(1, ['B'], ['C'], 2, 1), g(2, ['A', 'D'], ['C', 'E'], 2, 0), g(3, ['C'], ['A'], 0, 2)];
  const one = E.replay(games), two = E.replay([...games].reverse());
  assert.deepEqual([...one.ratings], [...two.ratings]);
  assert.equal(E.replay([g(9, ['A'], ['A'], 2, 0)]).changes.length, 0, 'the same person on both sides is not a rated game');
  assert.equal(E.replay([g(9, [], ['A'], 2, 0)]).changes.length, 0, 'an empty side is not a rated game');
});

test('engine: beating a stronger player moves you more; a heavier win moves you more; a draw moves nobody far; levels stay inside 1-7', () => {
  const ev = (a, b) => E.update({ r: 1500, rd: 100, sigma: 0.06 }, [{ r: b, rd: 100, s: a }]);
  assert.ok(ev(1, 1800).r - 1500 > ev(1, 1200).r - 1500, 'the upset is worth more');
  assert.ok(E.scoreOf(1, 12, 0) > E.scoreOf(1, 7, 6), 'a 12-0 win scores higher than a 7-6 win');
  assert.ok(Math.abs(ev(0.5, 1500).r - 1500) < 1, 'an even draw barely moves a level');
  for (const r of [-5000, 0, 1500, 3000, 9000]) { const l = E.toLevel(r); assert.ok(l >= 1 && l <= 7); }
  assert.equal(E.toLevel(1500), 4);
  assert.ok(Math.abs(E.toLevel(E.fromLevel(5.2)) - 5.2) < 0.01);
});

test('engine: reliability grows with games and fades with inactivity', () => {
  const games = Array.from({ length: 16 }, (_, i) => ({ id: `r${String(i).padStart(2, '0')}`, played_at: `2026-03-${String(1 + i).padStart(2, '0')}T10:00:00Z`, sides: [{ players: ['P'], score: i % 2 }, { players: [`Q${i % 4}`], score: 1 - (i % 2) }] }));
  const { ratings } = E.replay(games);
  const p = ratings.get('P');
  assert.ok(E.present(p).reliability > 50 && E.present(p).reliable, JSON.stringify(E.present(p)));
  assert.ok(E.present(p, { asOf: '2028-01-01' }).reliability < E.present(p).reliability, 'two years off the court lowers reliability');
  assert.equal(E.bucketOf(2.5), 'beginner'); assert.equal(E.bucketOf(4), 'amateur'); assert.equal(E.bucketOf(5), 'semi_pro'); assert.equal(E.bucketOf(6.5), 'pro');
});

// ------------------------------------------------------------------ every sport in the catalogue
test('catalogue: every sport has a rating model, and a sport without a native one is labelled a fallback', async () => {
  const sports = (await pool.query('SELECT slug, scoring, category FROM sports ORDER BY slug')).rows;
  assert.ok(sports.length > 20, 'the catalogue is loaded');
  const native = {}, fallback = [];
  for (const s of sports) {
    const fam = modelOf(s);
    assert.ok(MODELS[fam], `${s.slug} maps to a known model`);
    (MODELS[fam].native ? (native[fam] ??= []) : fallback).push(s.slug);
  }
  assert.ok(Object.keys(native).length >= 3, `native families: ${Object.keys(native)}`);
  assert.ok(MODELS.generic.native === false && /fallback/i.test(MODELS.generic.label), 'the generic model says it is a fallback');
  const r = await api('GET', '/ratings/models');
  assert.equal(r.status, 200);
  assert.equal(r.body.sports.length, sports.length, 'the capability lists every sport');
  assert.ok(r.body.sports.every((s) => typeof s.native === 'boolean' && s.model), 'each sport states native or fallback');
  assert.equal(r.body.sports.filter((s) => !s.native).length, fallback.length);
  assert.equal((await api('GET', '/ratings/models?sport=nope-sport')).status, 404);
});

// ------------------------------------------------------------------ verified evidence only
test('racket: singles and doubles from published sheets become a level, a reliability and a ledger only the player sees', async () => {
  const org = await signup(['organizer']);
  const [a, b, c, d] = [await signup(), await signup(), await signup(), await signup()];
  const ev = await mkEvent(org, 'tennis');
  const W = [{ home: 6, away: 2 }, { home: 6, away: 3 }], L = [{ home: 2, away: 6 }, { home: 3, away: 6 }], T = [{ home: 6, away: 4 }, { home: 3, away: 6 }, { home: 6, away: 4 }];
  for (let i = 0; i < 9; i++) { // A is the strongest but loses now and then, as real players do
    await game('tennis', ev, org, [a], [b], i % 3 === 2 ? 0 : 2, i % 3 === 2 ? 2 : 0, { day: 1 + i * 2, sets: i % 3 === 2 ? L : W });
    await game('tennis', ev, org, [a], [c], i % 4 === 3 ? 1 : 2, i % 4 === 3 ? 2 : 1, { day: 2 + i * 2, sets: T });
    await game('tennis', ev, org, [b], [c], i % 2 ? 1 : 2, i % 2 ? 2 : 1, { day: 20 + i, sets: T });
  }
  await game('tennis', ev, org, [a, d], [b, c], 2, 0, { day: 40 });
  const ts = await sport('tennis');
  const run = await recomputeSport(ts, { reason: 'manual' });
  assert.equal(run.changed, true);
  const [ra, rb, rc] = [await level(a, 'tennis'), await level(b, 'tennis'), await level(c, 'tennis')];
  assert.ok(ra.level > rb.level && rb.level > rc.level, `A ${ra.level} > B ${rb.level} > C ${rc.level}`);
  assert.ok(ra.reliable && ra.reliability > 50 && ra.games === 19, JSON.stringify(ra));
  assert.ok(ra.level >= 1 && ra.level <= 7);
  assert.equal(ra.matches_as, E.bucketOf(ra.level), 'a reliable level says which open-game level it matches as');
  assert.equal((await level(d, 'tennis')).matches_as, null, 'a provisional level does not match anyone');
  assert.equal((await level(d, 'tennis')).games, 1, 'doubles credits both partners');
  assert.ok((await level(d, 'tennis')).level > 4 - 0.01 && !(await level(d, 'tennis')).reliable, 'one game is a provisional level');

  const own = await api('GET', `/ratings/players/${a.id}/tennis/history`, { token: a.token });
  assert.equal(own.status, 200);
  assert.equal(own.body.evidence_visible, true);
  assert.ok(own.body.history[0].result && own.body.history[0].expected_win_chance >= 0 && own.body.history[0].opponent_level >= 1 && own.body.history[0].event.id === ev);
  const other = await api('GET', `/ratings/players/${a.id}/tennis/history`, { token: b.token });
  assert.equal(other.body.evidence_visible, false);
  assert.equal(other.body.history[0].result, undefined, 'others see the level over time, not who beat whom');
  assert.equal((await api('GET', `/ratings/players/${a.id}/tennis/history`)).body.history[0].game, undefined);
  assert.equal(own.body.model.native, true);
});

test('only verified competition counts: friendlies, unpublished sheets, same-owner games and youth never move a level', async () => {
  const org = await signup(['organizer']);
  const [a, b, kid, z] = [await signup(), await signup(), await signup(), await signup()];
  await pool.query('UPDATE users SET youth_until = current_date + 400 WHERE id=$1', [kid.id]);
  const tour = await mkEvent(org, 'badminton'), friendly = await mkEvent(org, 'badminton', 'friendly');
  await game('badminton', tour, org, [a], [b], 2, 0, { day: 1 });
  await game('badminton', friendly, org, [a], [b], 2, 0, { day: 2 });
  await game('badminton', tour, org, [a], [b], 2, 0, { day: 3, sheet: 'approved' });
  await game('badminton', tour, org, [a], [b], 2, 0, { day: 4, sheet: 'superseded' });
  await game('badminton', tour, org, [a], [z], 2, 0, { day: 5, ownerOverride: a }); // both teams run by the same person
  await game('badminton', tour, org, [a], [kid], 2, 0, { day: 6 });
  await pool.query("INSERT INTO performances(user_id, sport_id, metric, value, points, recorded_by, provenance, status, official_points) VALUES ($1,$2,'rating',9,0,$1,'self_reported','approved',0)", [a.id, (await sport('badminton')).id]);
  await recomputeSport(await sport('badminton'), { reason: 'manual' });
  const ra = await level(a, 'badminton');
  assert.equal(ra.games, 1, 'only the one published tournament game counts');
  assert.equal((await level(z, 'badminton')), undefined, 'a game between two teams of one owner counts for nobody');
  assert.equal((await api('GET', `/ratings/players/${kid.id}`)).status, 404, 'a youth account is not rated and its existence is not confirmed');
  assert.equal((await api('GET', `/ratings/players/00000000-0000-4000-8000-000000000000`)).status, 404);
});

test('a corrected result re-runs the ratings: the new run is added, the earlier run and its ledger are kept, an identical rerun adds nothing', async () => {
  const org = await signup(['organizer']);
  const [a, b] = [await signup(), await signup()];
  const ev = await mkEvent(org, 'squash');
  const g = await game('squash', ev, org, [a], [b], 3, 0, { day: 1 });
  const sq = await sport('squash');
  const first = await recomputeSport(sq, { reason: 'manual' });
  assert.equal((await recomputeSport(sq, { reason: 'manual' })).changed, false, 'unchanged evidence adds no run');
  const before = (await level(a, 'squash')).level;
  // the organiser corrects the score: the old sheet is superseded and a new version is published
  await pool.query("UPDATE score_sheets SET status='superseded' WHERE id=$1", [g.sheet]);
  await pool.query("INSERT INTO score_sheets(fixture_id, event_id, version, status, home_score, away_score, totals, created_by, published_at) VALUES ($1,$2,2,'published',0,3,'{}',$3,now())", [g.fx, ev, org.id]);
  await pool.query('UPDATE fixtures SET home_score=0, away_score=3 WHERE id=$1', [g.fx]);
  const second = await recomputeSport(sq, { reason: 'correction' });
  assert.equal(second.changed, true);
  assert.ok((await level(a, 'squash')).level < before, 'the corrected loss lowers the level');
  const runs = (await pool.query('SELECT id, reason FROM skill_rating_runs WHERE sport_id=$1 ORDER BY created_at, id', [sq.id])).rows;
  assert.deepEqual(runs.map((r) => r.reason), ['first', 'correction']);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM skill_rating_changes WHERE run_id=$1', [first.run_id])).rows[0].n, 2, 'the earlier ledger is still there');
  // withdrawing the evidence marks the rating void, it does not delete it
  await pool.query("UPDATE score_sheets SET status='superseded' WHERE fixture_id=$1", [g.fx]);
  await recomputeSport(sq, { reason: 'correction' });
  assert.equal((await pool.query("SELECT status FROM skill_ratings WHERE user_id=$1 AND sport_id=$2", [a.id, sq.id])).rows[0].status, 'void');
  assert.equal((await api('GET', `/ratings/players/${a.id}?sport=squash`)).body.ratings.length, 0);
});

test('goal games credit verified appearances and cricket and measured events have their own models', async () => {
  const org = await signup(['organizer']);
  const xs = [await signup(), await signup(), await signup()], ys = [await signup(), await signup(), await signup()];
  const ev = await mkEvent(org, 'football');
  const fb = await sport('football');
  for (let i = 0; i < 3; i++) {
    const g = await game('football', ev, org, xs, ys, 3, 1, { day: 1 + i });
    for (const [team, side] of [[g.h, xs], [g.a, ys]]) for (const u of side) await pool.query("INSERT INTO match_appearances(fixture_id, team_id, user_id, status, source, verified_at) VALUES ($1,$2,$3,'started','official_sheet',now())", [g.fx, team, u.id]);
  }
  // a rostered player who never appeared is not credited
  const bench = await signup();
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) SELECT home_team_id, $2, 'player', 'active' FROM fixtures WHERE id=$1", [(await pool.query('SELECT id FROM fixtures ORDER BY scheduled_at DESC LIMIT 1')).rows[0].id, bench.id]);
  await recomputeSport(fb, { reason: 'manual' });
  assert.equal((await level(xs[0], 'football')).games, 3);
  assert.ok((await level(xs[0], 'football')).level > (await level(ys[0], 'football')).level);
  assert.equal(await level(bench, 'football'), undefined);
  const cricket = (await pool.query("SELECT * FROM sports WHERE slug LIKE 'cricket%' ORDER BY slug LIMIT 1")).rows[0];
  assert.ok(cricket, 'the catalogue has cricket');
  assert.equal(modelOf(cricket), 'cricket');
});

test('measured events: finishing places in a completed heat rate each runner against the field', async () => {
  const org = await signup(['organizer']);
  const runners = [await signup(), await signup(), await signup(), await signup()];
  const timed = (await pool.query("SELECT slug FROM sports WHERE scoring IN ('time','distance') ORDER BY slug LIMIT 1")).rows[0];
  assert.ok(timed, 'the catalogue has a timed or measured sport');
  const ev = await mkEvent(org, timed.slug);
  const sp = (await pool.query('SELECT * FROM sports WHERE id=(SELECT sport_id FROM events WHERE id=$1)', [ev])).rows[0];
  const disc = (await pool.query("INSERT INTO event_disciplines(event_id, sport_id, name) VALUES ($1,$2,'Final') RETURNING id", [ev, sp.id])).rows[0].id;
  for (let h = 0; h < 6; h++) {
    const s = (await pool.query("INSERT INTO event_sessions(event_id, discipline_id, stage, label, status, completed_at) VALUES ($1,$2,'heat',$3,'completed',$4) RETURNING id", [ev, disc, `H${h}`, new Date(Date.now() - (30 - h) * 864e5).toISOString()])).rows[0].id;
    for (const [i, u] of runners.entries()) {
      const part = (await pool.query("INSERT INTO event_participants(event_id, user_id, full_name) VALUES ($1,$2,$3) ON CONFLICT (event_id, user_id) WHERE user_id IS NOT NULL DO UPDATE SET full_name=EXCLUDED.full_name RETURNING id", [ev, u.id, u.display_name])).rows[0].id;
      await pool.query("INSERT INTO event_session_entries(session_id, participant_id, result_status, position) VALUES ($1,$2,'finished',$3)", [s, part, i + 1]);
    }
  }
  await recomputeSport(sp, { reason: 'manual' });
  const [r1, r2, r4] = [await level(runners[0], sp.slug), await level(runners[1], sp.slug), await level(runners[3], sp.slug)];
  assert.ok(r1.level > r2.level && r2.level > r4.level, `${r1.level} > ${r2.level} > ${r4.level}`);
  assert.equal(r1.games, 6);
  assert.equal(MODELS[modelOf(sp)].native, true);
});

// ------------------------------------------------------------------ matching, access and the admin run
test('open games match on the computed level once it is reliable, and on the stated level before that', async () => {
  const org = await signup(['organizer']);
  const [pro, rookie, ...field] = [await signup(), await signup(), await signup(), await signup(), await signup()];
  const ts = await sport('table-tennis'), ev = await mkEvent(org, 'table-tennis');
  for (const u of [pro, rookie]) await pool.query("INSERT INTO sport_profiles(user_id, sport_id, role, level) VALUES ($1,$2,'athlete','beginner')", [u.id, ts.id]);
  assert.equal(await levelFor(pool, pro.id, ts.id), 'beginner', 'no verified games: the stated level stands');
  for (let i = 0; i < 18; i++) await game('table-tennis', ev, org, [pro], [field[i % 3]], i % 3 === 2 ? 2 : 3, i % 3 === 2 ? 3 : 0, { day: 1 + i }); // wins two in three
  for (let i = 0; i < 3; i++) await game('table-tennis', ev, org, [rookie], [field[i]], 0, 3, { day: 30 + i });
  await recomputeSport(ts, { reason: 'manual' });
  assert.ok((await reliableLevel(pro.id, ts.id)), 'a long winning record is reliable');
  assert.notEqual(await levelFor(pool, pro.id, ts.id), 'beginner', 'the computed level replaces the declared beginner');
  assert.equal(await reliableLevel(rookie.id, ts.id), null, 'three games is not enough to override anyone');
  assert.equal(await levelFor(pool, rookie.id, ts.id), 'beginner');
  // the open-game card carries the viewer's own reliable level (never anyone else's)
  const startsAt = new Date(Date.now() + 2 * 864e5).toISOString();
  const hosted = await api('POST', '/open-games', { token: field[0].token, body: { sport: 'table-tennis', starts_at: startsAt, duration_minutes: 60, location: 'Club hall', max_players: 4, approval_mode: 'auto' } });
  assert.equal(hosted.status, 201, JSON.stringify(hosted.body));
  const mine = (await api('GET', '/open-games?sport=table-tennis&limit=50', { token: pro.token })).body.find((x) => x.id === hosted.body.id);
  assert.ok(mine?.my_level?.verified && mine.my_level.level > 3, JSON.stringify(mine?.my_level));
  const rook = (await api('GET', '/open-games?sport=table-tennis&limit=50', { token: rookie.token })).body.find((x) => x.id === hosted.body.id);
  assert.equal(rook.my_level, null, 'an unreliable level is not shown as a level');
});

test('recompute is admin-only and the capabilities carry REST, OpenAPI and MCP names', async () => {
  const user = await signup();
  assert.equal((await api('POST', '/ratings/recompute', { token: user.token, body: {} })).status, 403);
  assert.equal((await api('POST', '/ratings/recompute', { body: {} })).status, 401);
  const admin = await signup();
  await pool.query("UPDATE users SET roles = roles || '{admin}' WHERE id=$1", [admin.id]);
  assert.equal((await api('POST', '/ratings/recompute', { token: admin.token, body: { sport: 'tennis' } })).status, 200);
  assert.equal((await api('POST', '/ratings/recompute', { token: admin.token, body: { sport: 'nope-sport' } })).status, 404);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='recompute_skill_ratings' AND actor_id=$1", [admin.id])).rows[0].n, 1);
  const names = capabilities.filter((c) => c.tag === 'Skill ratings').map((c) => c.name).sort();
  assert.deepEqual(names, ['explain_skill_rating_change', 'get_skill_rating_history', 'get_skill_ratings', 'list_rating_models', 'recompute_skill_ratings']);
  const spec = (await (await fetch(`${base}/api/v1/openapi.json`)).json());
  for (const nm of names) assert.ok(JSON.stringify(spec).includes(`"${nm}"`), `${nm} is in the OpenAPI document`);
  assert.equal(await recomputeAll('sweep') >= 0, true);
});

// ------------------------------------------------------------------ explain a change and the rating ranking formula
const seedLadder = async () => {
  const org = await signup(['organizer']);
  const [pro, mid, rookie, ...field] = [await signup(), await signup(), await signup(), await signup(), await signup(), await signup()];
  const ts = await sport('table-tennis'), ev = await mkEvent(org, 'table-tennis');
  for (let i = 0; i < 18; i++) await game('table-tennis', ev, org, [pro], [field[i % 3]], i % 3 === 2 ? 2 : 3, i % 3 === 2 ? 3 : 0, { day: 1 + i });
  for (let i = 0; i < 18; i++) await game('table-tennis', ev, org, [mid], [field[i % 3]], i % 2 ? 3 : 0, i % 2 ? 0 : 3, { day: 1 + i });
  for (let i = 0; i < 2; i++) await game('table-tennis', ev, org, [rookie], [field[i]], 3, 0, { day: 30 + i });
  await recomputeSport(ts, { reason: 'manual' });
  return { org, pro, mid, rookie, ts, ev };
};

test('explain a change: only the player (or an admin) sees why a game moved the level; others get 404', async () => {
  const { pro, mid, ts } = await seedLadder();
  const hist = await api('GET', `/ratings/players/${pro.id}/${ts.slug}/history?limit=5`, { token: pro.token });
  const gameId = hist.body.history[0].game.id;
  const ok = await api('GET', `/ratings/players/${pro.id}/${ts.slug}/games/${gameId}`, { token: pro.token });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.result, hist.body.history[0].result);
  assert.match(ok.body.explanation, /chance of winning/);
  assert.equal((await api('GET', `/ratings/players/${pro.id}/${ts.slug}/games/${gameId}`, { token: mid.token })).status, 404, 'a stranger learns nothing');
  assert.equal((await api('GET', `/ratings/players/${pro.id}/${ts.slug}/games/${gameId}`)).status, 401);
  const admin = await signup();
  await pool.query("UPDATE users SET roles = roles || '{admin}' WHERE id=$1", [admin.id]);
  assert.equal((await api('GET', `/ratings/players/${pro.id}/${ts.slug}/games/${gameId}`, { token: admin.token })).status, 200);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='read_rating_evidence' AND actor_id=$1", [admin.id])).rows[0].n, 1);
});

test('rankings: skill level is a ranking formula on the existing engine, reliable levels only, no youth', async () => {
  const { pro, mid, rookie, ts } = await seedLadder();
  const admin = await signup();
  await pool.query("UPDATE users SET roles = roles || '{admin}' WHERE id=$1", [admin.id]);
  const bad = await api('POST', '/rankings', { token: admin.token, body: { sport: ts.slug, subject: 'team', name: 'Levels', expected_version: 0, formula_kind: 'rating', min_samples: 1 } });
  assert.equal(bad.status, 422, 'levels rank players, not teams');
  const made = await api('POST', '/rankings', { token: admin.token, body: { sport: ts.slug, subject: 'player', name: 'Table tennis levels', expected_version: 0, formula_kind: 'rating', min_samples: 1, min_distinct_events: 1 } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.version.formula_kind, 'rating');
  assert.match(made.body.formula, /skill level/i);
  const { loadDefinition, loadVersion, runRanking } = await import('../src/rankings/data.js');
  const def = await loadDefinition(made.body.definition.id);
  const res = await runRanking(def, await loadVersion(def.id, def.current_version));
  const rank = (u) => res.entries.find((e) => e.subject === u.id)?.rank;
  assert.ok(rank(pro) && rank(mid) && rank(pro) < rank(mid), 'the player winning two in three outranks the 50% player');
  assert.equal(rank(rookie), undefined, 'two games is not reliable, so the rookie is not ranked');
  await pool.query("UPDATE users SET youth_until = now() + interval '2 years' WHERE id=$1", [mid.id]);
  const res2 = await runRanking(def, await loadVersion(def.id, def.current_version));
  assert.equal(res2.entries.find((e) => e.subject === mid.id), undefined, 'a youth account is never ranked');
});
