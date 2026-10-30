import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { capabilities } = await import('../src/registry.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const q = async (sql, args) => (await pool.query(sql, args)).rows;
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `aj_${n}_${roles[0]}`, display_name: `Journey Person ${n}`, email: `aj${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const key = () => `idem-${++n}-${Math.random().toString(36).slice(2, 10)}`;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

/** An athlete with two seasons of real records: 2022 (one club stint, one match, a self-logged record) and 2023 (second club, match, win, award, approved record, goal achieved). */
async function career() {
  const mgr = await signup(['coach']), p = await signup(), t1 = await api('POST', '/teams', { token: mgr.token, body: { name: `North ${++n}`, sport: 'football' } }).then((r) => r.body), t2 = await api('POST', '/teams', { token: mgr.token, body: { name: `South ${++n}`, sport: 'football' } }).then((r) => r.body);
  const s1 = must(await api('POST', '/me/career', { token: p.token, body: { team_id: t1.id, starts_on: '2022-01-01', ends_on: '2022-12-31', competition_level: 'club', idempotency_key: key() } }), 201);
  const s2 = must(await api('POST', '/me/career', { token: p.token, body: { team_id: t2.id, starts_on: '2023-01-01', competition_level: 'club', idempotency_key: key() } }), 201);
  await q("UPDATE career_memberships SET verification_status='verified', verified_at=now() WHERE id=$1", [s2.id]);
  const ev = (await q("INSERT INTO events(name, sport_id, organizer_id, status, starts_on) VALUES ('Cup', (SELECT id FROM sports WHERE slug='football'), $1, 'completed', '2022-03-01') RETURNING id", [mgr.id]))[0].id;
  const fixture = async (day, home, away) => (await q("INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at, status, home_score, away_score) VALUES ($1,$2,$3,$4,'completed',1,0) RETURNING id", [ev, home, away, day]))[0].id;
  const f1 = await fixture('2022-03-05T15:00:00Z', t1.id, t2.id), f2 = await fixture('2023-03-05T15:00:00Z', t2.id, t1.id);
  await q("INSERT INTO match_appearances(fixture_id, team_id, user_id, status, source) VALUES ($1,$2,$3,'started','lineup')", [f1, t1.id, p.id]);
  await q("INSERT INTO match_appearances(fixture_id, team_id, user_id, status, minutes_played, minutes_basis, source, verified_at) VALUES ($1,$2,$3,'started',90,'match_clock','lineup',now())", [f2, t2.id, p.id]);
  await q("INSERT INTO awards(name, kind, event_id, user_id, awarded_by, awarded_at) VALUES ('Player of the Match','mvp',$1,$2,$3,'2023-03-05')", [ev, p.id, mgr.id]);
  const g = (await q("INSERT INTO games(sport_id, created_by, title, status, starts_at) VALUES ((SELECT id FROM sports WHERE slug='tennis'), $1, 'Club final', 'post-event', '2023-06-01') RETURNING id", [mgr.id]))[0].id;
  await q("INSERT INTO game_participants(game_id, user_id, outcome, rank) VALUES ($1,$2,'win',1)", [g, p.id]);
  const fb = "(SELECT id FROM sports WHERE slug='football')";
  await q(`INSERT INTO performances(user_id, sport_id, metric, value, recorded_by, provenance, status, unit, direction, achieved_on) VALUES ($1,${fb},'sprint_30m',4.9,$1,'self_reported','approved','s','lower','2022-05-01')`, [p.id]);
  await q(`INSERT INTO performances(user_id, sport_id, metric, value, recorded_by, provenance, status, unit, direction, achieved_on) VALUES ($1,${fb},'sprint_30m',4.6,$2,'approved_competition','approved','s','lower','2023-05-01')`, [p.id, mgr.id]);
  await q(`INSERT INTO performances(user_id, sport_id, metric, value, recorded_by, provenance, status, unit, direction, achieved_on) VALUES ($1,${fb},'vertical_jump',51,$1,'imported','approved','cm','higher','2023-06-01')`, [p.id]);
  await q(`INSERT INTO player_goals(owner_id, sport_id, title, status, starts_on, claimed_at) VALUES ($1,${fb},'Faster off the line','achieved','2023-01-10','2023-09-01')`, [p.id]);
  await q(`INSERT INTO player_goals(owner_id, sport_id, title, status, starts_on) VALUES ($1,${fb},'Strong left foot','active','2022-02-01')`, [p.id]);
  return { mgr, p, t1, t2, s1, s2 };
}
const timeline = (u, p, query = {}) => api('GET', '/graph/timeline', { token: u.token, query: { kind: 'person', id: p.id, ...query } });

test('every timeline row says whether it is verified, user-entered or external, and the filters narrow by sport, dates, season and stint', async () => {
  const { p, s1 } = await career();
  const all = must(await timeline(p, p, { limit: 100 }));
  assert.ok(all.items.every((i) => ['verified', 'user_entered', 'external'].includes(i.origin)), 'no row is unlabelled');
  assert.deepEqual(Object.keys(all.origins).sort(), ['external', 'user_entered', 'verified']);
  const originOf = (domain, type, title) => all.items.find((i) => i.domain === domain && (!type || i.type === type) && (!title || i.title.includes(title))).origin;
  assert.equal(originOf('career', 'joined', 'North'), 'user_entered', 'a self-entered stint no club has confirmed');
  assert.equal(originOf('career', 'joined', 'South'), 'verified');
  assert.equal(all.items.find((i) => i.domain === 'competition' && i.at.startsWith('2022')).origin, 'user_entered', 'an appearance with no verified minutes');
  assert.equal(all.items.find((i) => i.domain === 'competition' && i.minutes === 90).origin, 'verified');
  assert.equal(originOf('statistics', 'record', 'vertical'), 'external');
  assert.equal(all.items.filter((i) => i.domain === 'statistics').map((i) => i.origin).sort().join(), 'external,user_entered,verified');
  assert.equal(originOf('development', 'goal_set', 'Strong'), 'user_entered');
  assert.equal(originOf('achievement'), 'verified');

  const only = must(await timeline(p, p, { origin: 'external' }));
  assert.ok(only.items.length === 1 && only.items[0].domain === 'statistics');
  assert.equal((await timeline(p, p, { origin: 'rumour' })).status, 400);

  const y23 = must(await timeline(p, p, { from: '2023-01-01', to: '2023-12-31', limit: 100 }));
  assert.ok(y23.items.length && y23.items.every((i) => i.at >= '2023-01-01' && i.at <= '2023-12-31'));
  const tennis = must(await timeline(p, p, { sport: 'tennis', limit: 100 }));
  assert.deepEqual([...new Set(tennis.items.map((i) => i.domain))], ['result'], 'only rows that belong to the sport');
  const stint = must(await timeline(p, p, { membership_id: s1.id, limit: 100 }));
  assert.equal(stint.filters.sport, 'football'); assert.equal(stint.filters.from, '2022-01-01'); assert.equal(stint.filters.to, '2022-12-31');
  assert.ok(stint.items.every((i) => i.at >= '2022-01-01' && i.at <= '2022-12-31' && i.sport_slug === 'football'));
  assert.equal((await timeline(p, p, { membership_id: '00000000-0000-4000-8000-000000000000' })).status, 404);
  assert.equal((await timeline(p, p, { from: '2024-01-01', to: '2023-01-01' })).status, 400);

  const org = must(await api('POST', '/organisations', { token: p.token, body: { name: `Season Club ${++n}`, kind: 'club' } }), 201);
  const season = (await q("INSERT INTO org_seasons(organisation_id, name, starts_on, ends_on) VALUES ($1,'2022 season','2022-01-01','2022-12-31') RETURNING id", [org.id]))[0].id;
  const bySeason = must(await timeline(p, p, { season_id: season, limit: 100 }));
  assert.equal(bySeason.filters.label, '2022 season'); assert.ok(bySeason.items.every((i) => i.at.startsWith('2022')));
});

test('the 360 filters by period and sport, carries origins, and shows development goals only to the athlete and guardian', async () => {
  const { p } = await career();
  const viewer = await signup();
  const own = must(await api('GET', `/graph/athletes/${p.id}/360`, { token: p.token, query: { from: '2023-01-01', to: '2023-12-31' } }));
  assert.equal(own.sections.competitions.data.totals.matches, 1);
  assert.equal(own.sections.career.data.stints.length, 1, 'the 2022 stint ended before the period');
  assert.equal(own.sections.career.data.stints[0].origin, 'verified');
  assert.equal(own.sections.statistics.data.length, 2);
  assert.equal(own.sections.development.access, 'ok');
  assert.equal(own.sections.development.data.some((d) => d.type === 'goal_achieved'), true);
  assert.equal(own.sections.development.data.every((d) => d.origin === 'user_entered' && d.title && d.summary !== undefined), true);
  assert.equal(own.filters.from, '2023-01-01');
  const sport = must(await api('GET', `/graph/athletes/${p.id}/360`, { token: p.token, query: { sport: 'tennis' } }));
  assert.equal(sport.sections.competitions.data.totals.matches, 0); assert.equal(sport.sections.results.data.by_sport.length, 1);
  const other = must(await api('GET', `/graph/athletes/${p.id}/360`, { token: viewer.token })).sections;
  assert.equal(other.development.access, 'forbidden', 'sensitive domains stay hidden by permission');
  assert.equal(other.statistics.access, 'ok');
  const tl = must(await timeline(viewer, p, { limit: 100 }));
  assert.ok(tl.hidden_domains.includes('development') && tl.hidden_domains.includes('media'));
  assert.ok(!tl.items.some((i) => i.domain === 'development'));
});

test('two development periods compare side by side with origins, changes and permissions', async () => {
  const { p, s1, s2 } = await career();
  const viewer = await signup();
  const cmp = must(await api('GET', `/graph/athletes/${p.id}/compare`, { token: p.token, query: { a_from: '2022-01-01', a_to: '2022-12-31', b_from: '2023-01-01', b_to: '2023-12-31' } }));
  const m = Object.fromEntries(cmp.metrics.map((x) => [x.key, x]));
  assert.deepEqual([m.matches.a, m.matches.b, m.matches.change], [1, 1, 0]);
  assert.deepEqual([m.minutes.a, m.minutes.b], [0, 90]);
  assert.deepEqual([m.wins.a, m.wins.b, m.wins.change], [0, 1, 1]); assert.equal(m.wins.change_pct, null, 'no percentage from a zero base');
  assert.deepEqual([m.awards.a, m.awards.b], [0, 1]);
  assert.deepEqual([m.records.a, m.records.b], [1, 2]); assert.equal(m.records.change_pct, 100);
  assert.deepEqual([m.goals_set.a, m.goals_set.b, m.goals_achieved.b], [1, 1, 1]);
  assert.deepEqual([m.clubs_joined.a, m.clubs_joined.b, m.moves.b], [1, 1, 1]);
  assert.equal(cmp.periods.b.by_origin.verified > 0 && cmp.periods.a.by_origin.user_entered > 0, true);
  assert.ok(cmp.note.includes('not a verdict'));
  const byStint = must(await api('GET', `/graph/athletes/${p.id}/compare`, { token: p.token, query: { a_membership_id: s1.id, b_membership_id: s2.id } }));
  assert.equal(byStint.periods.a.label, byStint.periods.a.label); assert.equal(byStint.periods.a.sport, 'football');
  const football = must(await api('GET', `/graph/athletes/${p.id}/compare`, { token: p.token, query: { sport: 'football', a_from: '2022-01-01', a_to: '2022-12-31', b_from: '2023-01-01', b_to: '2023-12-31' } }));
  assert.equal(football.metrics.find((x) => x.key === 'wins').b, 0, 'the tennis win is outside the sport filter');
  const seen = must(await api('GET', `/graph/athletes/${p.id}/compare`, { token: viewer.token, query: { a_from: '2022-01-01', a_to: '2022-12-31', b_from: '2023-01-01', b_to: '2023-12-31' } }));
  assert.ok(seen.hidden_domains.includes('development')); assert.ok(!seen.metrics.some((x) => x.domain === 'development'));
  assert.ok(seen.metrics.some((x) => x.key === 'matches'));
  assert.ok(!seen.hidden_domains.includes('health') && !seen.metrics.some((x) => x.domain === 'health'), 'no health figure in a comparison');
  assert.equal((await api('GET', `/graph/athletes/${p.id}/compare`, { token: p.token, query: { a_from: '2022-01-01', a_to: '2022-12-31' } })).status, 400, 'both periods are needed');
  assert.equal((await api('GET', `/graph/athletes/${p.id}/compare`, { query: { a_from: '2022-01-01', a_to: '2022-12-31', b_from: '2023-01-01', b_to: '2023-12-31' } })).status, 401);
  assert.ok((await q("SELECT 1 FROM audit_log WHERE action='read_graph_compare' AND actor_id=$1", [viewer.id])).length);
});

test('a young person\'s journey is hidden from strangers everywhere, including comparison and the shared portfolio', async () => {
  const kid = await signup(), stranger = await signup();
  await q('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);
  const body = { a_from: '2022-01-01', a_to: '2022-12-31', b_from: '2023-01-01', b_to: '2023-12-31' };
  assert.equal((await api('GET', `/graph/athletes/${kid.id}/compare`, { token: stranger.token, query: body })).status, 404);
  assert.equal((await api('GET', `/graph/athletes/${kid.id}/compare`, { token: kid.token, query: body })).status, 200);
  assert.equal((await api('POST', '/me/passport-links', { token: kid.token, body: { show_journey: true } })).status, 403, 'a young person cannot share alone');
});

test('the portfolio is the passport: the journey and goals are two privacy switches, off by default, read live and without internal ids', async () => {
  const { p } = await career();
  const plain = must(await api('POST', '/me/passport-links', { token: p.token, body: { label: 'plain', expires_in_days: 7 } }), 201);
  assert.equal(plain.show_journey, false); assert.equal(plain.show_development, false);
  assert.equal(must(await api('GET', `/passport/${plain.token}`)).journey, null, 'a link made without the switch shows no journey');
  const j = must(await api('POST', '/me/passport-links', { token: p.token, body: { label: 'journey', expires_in_days: 7, show_journey: true } }), 201);
  const open = must(await api('GET', `/passport/${j.token}`));
  assert.ok(open.journey.items.length > 0);
  assert.ok(open.journey.items.every((i) => ['verified', 'user_entered', 'external'].includes(i.origin) && i.source === undefined), 'origin on every row, no internal ids');
  assert.ok(!open.journey.items.some((i) => i.domain === 'development') && open.journey.includes_development === false, 'goals need their own switch');
  assert.ok(!open.journey.items.some((i) => ['contract', 'health', 'payment', 'travel'].includes(i.domain)), 'sensitive domains never on a link');
  const dev = must(await api('PATCH', `/me/passport-links/${j.id}`, { token: p.token, body: { version: j.version, show_development: true } }));
  assert.equal(dev.show_development, true);
  const withGoals = must(await api('GET', `/passport/${j.token}`));
  assert.ok(withGoals.journey.items.some((i) => i.domain === 'development') && withGoals.journey.includes_development);
  assert.ok(!JSON.stringify(withGoals.journey).includes('why'), 'goal reasons are not shared');
  const file = must(await api('GET', `/passport/${j.token}/export`));
  assert.ok(file.passport.journey?.items?.length, 'the download carries the same journey');
  must(await api('POST', `/me/passport-links/${j.id}/revoke`, { token: p.token }));
  assert.equal((await api('GET', `/passport/${j.token}`)).status, 404, 'revocation is immediate');
});

test('every sport in the catalogue can be filtered and compared without a silent default', async () => {
  const p = await signup();
  const sports = await q('SELECT slug FROM sports ORDER BY slug');
  assert.ok(sports.length > 20);
  for (const { slug } of sports) {
    assert.equal((await timeline(p, p, { sport: slug })).status, 200, slug);
    assert.equal((await api('GET', `/graph/athletes/${p.id}/compare`, { token: p.token, query: { sport: slug, a_from: '2022-01-01', a_to: '2022-12-31', b_from: '2023-01-01', b_to: '2023-12-31' } })).status, 200, slug);
  }
});

test('the new capabilities are REST, OpenAPI and MCP from one definition', async () => {
  const names = capabilities.filter((c) => c.tag === 'Sports Graph').map((c) => c.name);
  assert.ok(names.includes('compare_athlete_periods') && names.includes('get_graph_timeline') && names.includes('get_athlete_360'));
  const cmp = capabilities.find((c) => c.name === 'compare_athlete_periods');
  assert.equal(cmp.method, 'GET'); assert.equal(cmp.path, '/graph/athletes/:id/compare');
});
