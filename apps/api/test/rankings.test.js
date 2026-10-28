import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { capabilities } = await import('../src/capabilities/index.js');
const { computeRanking } = await import('../src/rankings/engine.js');
const { FAMILIES, familyOf } = await import('../src/rankings/families.js');
const { snapshotAll } = await import('../src/rankings/data.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
let n = 0;
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `rk_${n}`, display_name: `Rk ${n}`, email: `rk${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token, email: `rk${n}@example.com` };
};
const makeAdmin = async () => {
  const a = await signup();
  await pool.query("UPDATE users SET roles = roles || '{admin}' WHERE id=$1", [a.id]);
  return a; // the registration token keeps working (roles are read live); signing in again would drop the label, since the account is not on the platform-admin list
};
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const sportId = async (slug) => (await pool.query('SELECT id FROM sports WHERE slug=$1', [slug])).rows[0].id;
const mkEvent = async (org, slug, { city = 'Pune', kind = 'tournament' } = {}) =>
  (await pool.query("INSERT INTO events(name, sport_id, organizer_id, kind, status, city) VALUES ($1,$2,$3,$4,'completed',$5) RETURNING id", [`Ev ${++n}`, await sportId(slug), org.id, kind, city])).rows[0].id;
/** Approved competition result (what the verified flow leaves behind), written directly so each test owns its data. */
const perf = async (user, slug, metric, value, eventId, on, { fixtureId = null, provenance = 'approved_competition', status = 'approved', by } = {}) =>
  (await pool.query(
    `INSERT INTO performances(user_id, sport_id, event_id, fixture_id, metric, value, points, recorded_by, provenance, status, achieved_on, official_points)
     VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,$9,$10,0) RETURNING id`, [user.id, await sportId(slug), eventId, fixtureId, metric, value, by.id, provenance, status, on])).rows[0].id;

const define = (token, body) => api('POST', '/rankings', { token, body: { expected_version: 0, subject: 'player', aggregation: 'best', evidence: 'official', visibility: 'public', min_samples: 3, min_distinct_events: 2, scope: {}, ...body } });

// ---------------------------------------------------------------- pure engine
const row = (id, subject, value, on, extra = {}) => ({ id, subject, value, on, event_id: `e-${on}`, ...extra });
const V = { formula_kind: 'metric', aggregation: 'best', direction: 'higher', min_samples: 3, min_distinct_events: 2, scope: {} };
const asOf = '2026-06-30';

test('engine: same evidence and version always give the same table, whatever order it arrives in or what else is on the rows', () => {
  const rows = [row('a1', 'A', 5, '2026-01-01'), row('a2', 'A', 7, '2026-02-01'), row('a3', 'A', 6, '2026-03-01'), row('b1', 'B', 9, '2026-01-02'), row('b2', 'B', 2, '2026-02-02'), row('b3', 'B', 3, '2026-03-02')];
  const one = computeRanking(rows, V, { asOf });
  const two = computeRanking([...rows].reverse().map((r) => ({ ...r, plan: 'pro', subscription: 'platinum' })), V, { asOf });
  assert.deepEqual(one.entries.map((e) => [e.subject, e.rank, e.score]), two.entries.map((e) => [e.subject, e.rank, e.score]));
  assert.deepEqual(one.entries.map((e) => e.subject), ['B', 'A'], 'best value, higher wins');
});

test('engine: minimum sample, single-event and lower-is-better rules', () => {
  const rows = [row('a1', 'A', 10.5, '2026-01-01'), row('a2', 'A', 10.1, '2026-02-01'), row('a3', 'A', 10.3, '2026-03-01'),
    row('b1', 'B', 9.9, '2026-01-01'), // one lucky result
    { id: 'c1', subject: 'C', value: 9.8, on: '2026-01-01', event_id: 'same' }, { id: 'c2', subject: 'C', value: 9.7, on: '2026-01-02', event_id: 'same' }, { id: 'c3', subject: 'C', value: 9.6, on: '2026-01-03', event_id: 'same' }];
  const r = computeRanking(rows, { ...V, direction: 'lower' }, { asOf });
  assert.deepEqual(r.entries.map((e) => e.subject), ['A']);
  assert.equal(r.entries[0].score, 10.1, 'lowest time wins');
  assert.equal(r.ineligible.find((e) => e.subject === 'B').reasons[0].code, 'below_min_samples');
  assert.equal(r.ineligible.find((e) => e.subject === 'C').reasons[0].code, 'too_few_events', 'three results at one event are one event, not three');
  // an event-scoped ranking explicitly represents that event, so it is allowed
  const scoped = computeRanking(rows, { ...V, direction: 'lower', scope: { event_id: 'same' } }, { asOf });
  assert.ok(scoped.entries.some((e) => e.subject === 'C'));
});

test('engine: ties share a rank only when every tie rule is equal', () => {
  const rows = ['X', 'Y', 'Z'].flatMap((s, k) => [1, 2, 3].map((d) => row(`${s}${d}`, s, 5, `2026-0${d}-0${k === 2 ? 2 : 1}`)));
  const r = computeRanking(rows, V, { asOf });
  assert.deepEqual(r.entries.map((e) => [e.subject, e.rank]), [['X', 1], ['Y', 1], ['Z', 3]], 'X and Y are level on score, date and sample; Z reached it later');
});

test('engine: per-90 refuses unverified minutes, duplicates count once, windows apply, and self-generated games are excluded and flagged', () => {
  const v = { ...V, formula_kind: 'per_90', min_samples: 2, min_distinct_events: 1 };
  const rows = [row('p1', 'P', 2, '2026-05-01', { minutes: 90 }), row('p2', 'P', 1, '2026-05-08', { minutes: 90 }), row('p3', 'P', 4, '2026-05-15', { minutes: null }),
    row('p4', 'P', 1, '2026-05-08', { minutes: 90, event_id: 'e-2026-05-08' }), row('p5', 'P', 9, '2026-05-20', { minutes: 90, same_owner: true, fixture_id: 'fx' })];
  const r = computeRanking(rows, v, { asOf });
  assert.equal(r.entries[0].score, 1.5, '(2+1) goals / 180 minutes x 90');
  const why = r.excluded.get('P').map((x) => x.reason).sort();
  assert.deepEqual(why, ['duplicate', 'minutes_not_verified', 'self_generated']);
  assert.deepEqual(r.flags.map((f) => f.kind).sort(), ['duplicate_evidence', 'self_generated_fixtures']);
  const windowed = computeRanking(rows, { ...v, window_days: 30 }, { asOf: '2026-05-31' });
  assert.equal(windowed.entries[0].sample_n, 2);
  assert.equal(computeRanking(rows, { ...v, window_days: 3 }, { asOf: '2026-05-31' }).entries.length, 0, 'results outside the window do not count');
});

test('engine: many results in one day are flagged for review, never excluded', () => {
  const rows = Array.from({ length: 9 }, (_, k) => row(`r${k}`, 'R', k + 1, '2026-04-01', { event_id: `ev${k}` }));
  const r = computeRanking(rows, { ...V, aggregation: 'sum' }, { asOf });
  assert.equal(r.flags.filter((f) => f.kind === 'rapid_activity').length, 1);
  assert.equal(r.entries[0].sample_n, 9, 'flagged results still count; a person decides');
});

test('engine: team form is points per game, goal difference splits ties', () => {
  const g = (id, team, points, gf, ga, on) => ({ id, subject: team, points, gf, ga, on, event_id: 'lg' });
  const rows = [g('1', 'T1', 3, 3, 0, '2026-01-01'), g('2', 'T1', 0, 0, 1, '2026-01-08'), g('3', 'T2', 3, 1, 0, '2026-01-01'), g('4', 'T2', 0, 0, 3, '2026-01-08'), g('5', 'T3', 3, 2, 0, '2026-01-01')];
  const r = computeRanking(rows, { formula_kind: 'team_form', direction: 'higher', min_samples: 2, min_distinct_events: 1, scope: {} }, { asOf });
  assert.deepEqual(r.entries.map((e) => [e.subject, e.rank]), [['T1', 1], ['T2', 2]], 'T1 and T2 both 1.5 per game; T1 has the better goal difference');
  assert.equal(r.ineligible[0].subject, 'T3');
});

// ---------------------------------------------------------------- every sport has a model, native or labelled
test('the whole sport catalogue maps to a native ranking model or a labelled fallback', async () => {
  const sports = (await pool.query('SELECT slug, scoring, category FROM sports')).rows;
  assert.ok(sports.length >= 200, `catalogue has ${sports.length} sports`);
  const by = {};
  for (const s of sports) {
    const f = familyOf(s);
    assert.ok(FAMILIES[f], `${s.slug} has a family`);
    (by[f] ??= []).push(s.slug);
  }
  assert.equal(FAMILIES.generic.native, false);
  assert.match(FAMILIES.generic.label, /fallback/i, 'the generic model says it is a fallback');
  assert.equal(familyOf({ slug: 'cricket', scoring: 'points' }), 'cricket');
  assert.equal(familyOf({ slug: 'football', scoring: 'goals' }), 'goal_game');
  assert.equal(familyOf({ slug: 'futsal', scoring: 'goals' }), 'goal_game');
  assert.equal(familyOf({ slug: 'tennis', scoring: 'sets', category: 'racquet' }), 'racket');
  assert.equal(familyOf({ slug: 'athletics', scoring: 'time' }), 'measured');
  console.log('ranking models:', Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.length])));
});

test('rankings are in OpenAPI and MCP, and every ranking read is public-safe', () => {
  const names = ['list_ranking_definitions', 'get_ranking', 'get_ranking_history', 'why_this_rank', 'publish_ranking_version', 'set_ranking_status', 'snapshot_ranking', 'list_ranking_flags', 'review_ranking_flag'];
  for (const nm of names) assert.ok(capabilities.some((c) => c.name === nm), nm);
  for (const nm of ['get_ranking', 'get_ranking_history', 'why_this_rank', 'list_ranking_definitions']) assert.equal(capabilities.find((c) => c.name === nm).auth, 'public');
});

// ---------------------------------------------------------------- end-to-end journeys
test('defining rankings: governors only, sport-appropriate formulas, honest minimum samples', async () => {
  const gov = await makeAdmin(), nobody = await signup();
  const body = { sport: 'athletics', name: '100m best', formula_kind: 'metric', metric: '100m_time_s' };
  assert.equal((await define(nobody.token, body)).status, 403);
  assert.equal((await define(gov.token, { ...body, min_samples: 1 })).status, 422, 'a public ranking cannot rest on one result');
  assert.equal((await define(gov.token, { ...body, formula_kind: 'per_90' })).status, 422, 'athletics has no per-90 model');
  assert.equal((await define(gov.token, { ...body, aggregation: 'sum' })).status, 422, 'a total of times is meaningless');
  assert.equal((await define(gov.token, { ...body, evidence: 'development' })).status, 422, 'practice data can never power a public ranking');
  const ok = await define(gov.token, body);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.version.direction, 'lower', 'direction comes from the governed metric, not the caller');
  assert.match(ok.body.version.exclusions, /Practice, imported and self-reported/);
  assert.ok(ok.body.version.formula_hash);
  assert.equal((await api('POST', '/rankings', { token: gov.token, body: { ...body, definition_id: ok.body.definition.id, expected_version: 0, subject: 'player', aggregation: 'best', evidence: 'official', visibility: 'public', min_samples: 3, min_distinct_events: 2, scope: {}, min_samples: 4 } })).status, 409, 'stale edit is refused');
  const list = (await api('GET', '/rankings?sport=athletics')).body;
  assert.equal(list.sport_model.family, 'measured');
  assert.equal(list.definitions.length, 1);
});

test('a public ranking uses verified evidence only, shows sample sizes, and keeps youth, practice and unapproved data out', async () => {
  const gov = await makeAdmin(), org = await signup(['organizer']);
  const e1 = await mkEvent(org, 'athletics'), e2 = await mkEvent(org, 'athletics'), e3 = await mkEvent(org, 'athletics');
  const [fast, steady, practiceOnly, kid, unapproved] = [await signup(), await signup(), await signup(), await signup(), await signup()];
  await pool.query("UPDATE users SET youth_until = current_date + 400 WHERE id=$1", [kid.id]);
  for (const [u, vals] of [[fast, [10.2, 10.0, 10.4]], [steady, [10.6, 10.5, 10.7]], [kid, [9.0, 9.1, 9.2]]]) {
    for (const [k, e] of [e1, e2, e3].entries()) await perf(u, 'athletics', '100m_time_s', vals[k], e, `2026-0${k + 1}-10`, { by: org });
  }
  for (const [k, e] of [e1, e2, e3].entries()) {
    await perf(practiceOnly, 'athletics', '100m_time_s', 9.5, e, `2026-0${k + 1}-11`, { by: practiceOnly, provenance: 'self_reported', status: 'recorded' });
    await perf(unapproved, 'athletics', '100m_time_s', 9.4, e, `2026-0${k + 1}-12`, { by: org, status: 'submitted' });
  }
  const d = (await define(gov.token, { sport: 'athletics', name: '100m best', formula_kind: 'metric', metric: '100m_time_s' })).body;
  const t = (await api('GET', `/rankings/${d.definition.id}`)).body;
  assert.deepEqual(t.entries.map((e) => e.subject.id), [fast.id, steady.id]);
  assert.equal(t.entries[0].score, 10, 'lowest time ranks first');
  assert.equal(t.entries[0].sample_n, 3);
  assert.ok(['limited', 'solid', 'strong'].includes(t.entries[0].evidence_strength));
  assert.equal(t.version.min_samples, 3);
  assert.ok(t.formula && t.version.tie_rules && t.version.exclusions && t.as_of, 'scope, formula, tie rules, exclusions and timestamp always travel with the table');
  assert.equal(JSON.stringify(t).includes('roles'), false, 'no roles leak from ranked profiles');
  // no subscription input exists: paying cannot move a rank
  await pool.query("INSERT INTO user_plans(user_id, plan_id, status) SELECT $1, id, 'active' FROM plans LIMIT 1", [steady.id]).catch(() => {});
  assert.deepEqual((await api('GET', `/rankings/${d.definition.id}`)).body.entries.map((e) => e.subject.id), [fast.id, steady.id]);
  // the kid (youth), practice-only and unapproved athletes are invisible
  for (const hidden of [kid, practiceOnly, unapproved]) assert.equal((await api('GET', `/rankings/${d.definition.id}/subjects/${hidden.id}/why`)).status, 404);
});

test('why this rank: ranked people are explainable; unranked people see only their own reasons', async () => {
  const gov = await makeAdmin(), org = await signup(['organizer']);
  const e1 = await mkEvent(org, 'athletics'), e2 = await mkEvent(org, 'athletics'), e3 = await mkEvent(org, 'athletics');
  const a = await signup(), b = await signup(), watcher = await signup();
  for (const [k, e] of [e1, e2, e3].entries()) await perf(a, 'athletics', '100m_time_s', 10 + k / 10, e, `2026-0${k + 1}-10`, { by: org });
  await perf(b, 'athletics', '100m_time_s', 9.9, e1, '2026-01-10', { by: org });
  const d = (await define(gov.token, { sport: 'athletics', name: '100m best', formula_kind: 'metric', metric: '100m_time_s' })).body;
  const why = await api('GET', `/rankings/${d.definition.id}/subjects/${a.id}/why`, { token: watcher.token });
  assert.equal(why.status, 200);
  assert.equal(why.body.status, 'ranked');
  assert.equal(why.body.included.length, 3);
  assert.match(why.body.formula, /Lowest 100m_time_s/);
  assert.match(why.body.weighting, /no boost for paid plans/);
  assert.ok(why.body.limits.length >= 3);
  assert.equal((await api('GET', `/rankings/${d.definition.id}/subjects/${b.id}/why`, { token: watcher.token })).status, 404, 'others cannot probe an unranked athlete');
  const own = await api('GET', `/rankings/${d.definition.id}/subjects/${b.id}/why`, { token: b.token });
  assert.equal(own.body.status, 'not_yet_ranked');
  assert.equal(own.body.unmet[0].code, 'below_min_samples');
});

test('snapshots stay reproducible after a formula change, and a corrected result re-runs the ranking without rewriting history', async () => {
  const gov = await makeAdmin(), org = await signup(['organizer']);
  const e1 = await mkEvent(org, 'athletics'), e2 = await mkEvent(org, 'athletics'), e3 = await mkEvent(org, 'athletics');
  const a = await signup(), b = await signup();
  const ids = {};
  for (const [u, vals] of [[a, [10.0, 10.1, 10.2]], [b, [10.3, 10.4, 10.5]]]) for (const [k, e] of [e1, e2, e3].entries()) ids[`${u.id}${k}`] = await perf(u, 'athletics', '100m_time_s', vals[k], e, `2026-0${k + 1}-10`, { by: org });
  const d = (await define(gov.token, { sport: 'athletics', name: '100m best', formula_kind: 'metric', metric: '100m_time_s' })).body;
  const s1 = (await api('POST', `/rankings/${d.definition.id}/snapshot`, { token: gov.token })).body.snapshot;
  assert.ok(s1);
  assert.equal((await api('POST', `/rankings/${d.definition.id}/snapshot`, { token: gov.token })).body.unchanged, true, 'a rerun on identical results adds nothing');
  const before1 = (await api('GET', `/rankings/${d.definition.id}?snapshot_id=${s1.id}`)).body;
  // new formula version: average instead of best
  const v2 = await api('POST', '/rankings', { token: gov.token, body: { definition_id: d.definition.id, expected_version: 1, sport: 'athletics', subject: 'player', name: '100m average', formula_kind: 'metric', metric: '100m_time_s', aggregation: 'mean', evidence: 'official', visibility: 'public', min_samples: 3, min_distinct_events: 2, scope: {} } });
  assert.equal(v2.status, 201, JSON.stringify(v2.body));
  assert.equal((await api('GET', `/rankings/${d.definition.id}?snapshot_id=${s1.id}`)).body.entries[0].score, before1.entries[0].score);
  assert.deepEqual((await api('GET', `/rankings/${d.definition.id}?snapshot_id=${s1.id}`)).body.version, before1.version, 'an issued snapshot still shows the version that made it');
  assert.equal((await api('GET', `/rankings/${d.definition.id}`)).body.version.version, 2);
  // a result is corrected: b's first time was wrongly recorded; the corrected value moves b up
  await pool.query("UPDATE performances SET status='superseded' WHERE id=$1", [ids[`${b.id}0`]]);
  await perf(b, 'athletics', '100m_time_s', 9.0, e1, '2026-01-10', { by: org });
  const live = (await api('GET', `/rankings/${d.definition.id}`)).body;
  assert.equal(live.entries[0].subject.id, b.id, 'the corrected result deterministically changes the live table');
  assert.equal(live.entries[0].sample_n, 3, 'the superseded result no longer counts');
  const sCorr = await snapshotAll('correction');
  assert.ok(sCorr >= 1);
  const hist = (await api('GET', `/rankings/${d.definition.id}/subjects/${b.id}/history`)).body.history;
  assert.equal(hist.length, 2);
  assert.equal(hist[0].rank, 1, 'after the correction');
  assert.ok(hist[1].rank > 1, 'the original snapshot still shows where b stood before the correction');
  // snapshots cannot be edited
  await assert.rejects(pool.query('UPDATE ranking_snapshot_entries SET rank=99'), /immutable/);
  await assert.rejects(pool.query('DELETE FROM ranking_definition_versions'), /immutable/);
});

test('integrity flags ask for a review and are kept either way', async () => {
  const gov = await makeAdmin(), org = await signup(['organizer']);
  const e = [await mkEvent(org, 'athletics'), await mkEvent(org, 'athletics'), await mkEvent(org, 'athletics')];
  const a = await signup();
  for (const [k, ev] of e.entries()) await perf(a, 'athletics', '100m_time_s', 10 + k, ev, `2026-0${k + 1}-10`, { by: org });
  await perf(a, 'athletics', '100m_time_s', 10, e[0], '2026-01-10', { by: org }); // a double entry
  const d = (await define(gov.token, { sport: 'athletics', name: '100m best', formula_kind: 'metric', metric: '100m_time_s' })).body;
  await api('POST', `/rankings/${d.definition.id}/snapshot`, { token: gov.token });
  const flags = (await api('GET', `/rankings/${d.definition.id}/flags`, { token: gov.token })).body;
  assert.equal(flags.length, 1);
  assert.equal(flags[0].kind, 'duplicate_evidence');
  assert.equal((await api('GET', `/rankings/${d.definition.id}/flags`, { token: a.token })).status, 404, 'only governors see flags');
  const rv = await api('POST', `/ranking-flags/${flags[0].id}/review`, { token: gov.token, body: { status: 'dismissed', note: 'Same figure at a re-run heat' } });
  assert.equal(rv.status, 200);
  assert.equal(rv.body.status, 'dismissed');
  assert.equal((await api('POST', `/ranking-flags/${flags[0].id}/review`, { token: gov.token, body: { status: 'confirmed', note: 'again' } })).status, 409);
});

test('football per-90 uses verified minutes only; cricket totals; racket per match', async () => {
  const gov = await makeAdmin(), org = await signup(['organizer']);
  const mkTeam = async (slug, owner, name) => (await pool.query('INSERT INTO teams(name, sport_id, owner_id) VALUES ($1,$2,$3) RETURNING id', [name, await sportId(slug), owner.id])).rows[0].id;
  // football
  const ho = await signup(), ao = await signup();
  const home = await mkTeam('football', ho, 'H'), away = await mkTeam('football', ao, 'A');
  const star = await signup(), bench = await signup();
  const fixtures = [];
  for (let k = 0; k < 3; k++) {
    const ev = await mkEvent(org, 'football');
    const fx = (await pool.query("INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at, status, home_score, away_score) VALUES ($1,$2,$3,$4,'completed',2,1) RETURNING id", [ev, home, away, `2026-0${k + 1}-05`])).rows[0].id;
    fixtures.push([ev, fx]);
    await perf(star, 'football', 'goals', 1 + (k % 2), ev, `2026-0${k + 1}-05`, { fixtureId: fx, by: org });
    await perf(bench, 'football', 'goals', 1, ev, `2026-0${k + 1}-05`, { fixtureId: fx, by: org });
    await pool.query("INSERT INTO match_appearances(fixture_id, team_id, user_id, status, minutes_played, minutes_basis, source, verified_at) VALUES ($1,$2,$3,'started',90,'official_sheet','official_sheet',now())", [fx, home, star.id]);
    await pool.query("INSERT INTO match_appearances(fixture_id, team_id, user_id, status, source) VALUES ($1,$2,$3,'substitute_on','backfill')", [fx, home, bench.id]); // minutes unknown
  }
  const f = await define(gov.token, { sport: 'football', name: 'Goals per 90', formula_kind: 'per_90', metric: 'goals', min_samples: 3 });
  assert.equal(f.status, 201, JSON.stringify(f.body));
  const t = (await api('GET', `/rankings/${f.body.definition.id}`)).body;
  assert.deepEqual(t.entries.map((e) => e.subject.id), [star.id], 'a player whose minutes were never verified is not given a per-90 rate');
  assert.equal(t.entries[0].score, 1.3333, '(1+2+1) goals over 270 verified minutes x 90');
  const whyBench = await api('GET', `/rankings/${f.body.definition.id}/subjects/${bench.id}/why`, { token: bench.token });
  assert.equal(whyBench.status, 404, 'excluded for lack of minutes, so there is no entry to explain');
  // team form for the same sport
  const tf = await define(gov.token, { sport: 'football', subject: 'team', name: 'Team form', formula_kind: 'team_form', min_samples: 3, min_distinct_events: 2, window_games: 5 });
  assert.equal(tf.status, 201, JSON.stringify(tf.body));
  const teams = (await api('GET', `/rankings/${tf.body.definition.id}`)).body;
  assert.equal(teams.entries[0].subject.id, home);
  assert.equal(teams.entries[0].score, 3);
  assert.equal(teams.entries[0].subject.roles, undefined);
  // the same teams run by one owner are excluded as self-generated
  await pool.query('UPDATE teams SET owner_id=$1 WHERE id IN ($2,$3)', [ho.id, home, away]);
  assert.equal((await api('GET', `/rankings/${tf.body.definition.id}`)).body.entries.length, 0);
  // cricket: total runs
  const bats = await signup();
  for (let k = 0; k < 3; k++) await perf(bats, 'cricket', 'runs', 30 + k, await mkEvent(org, 'cricket'), `2026-0${k + 1}-05`, { by: org });
  const cr = await define(gov.token, { sport: 'cricket', name: 'Run scorers', formula_kind: 'metric', metric: 'runs', aggregation: 'sum' });
  assert.equal(cr.status, 201, JSON.stringify(cr.body));
  assert.equal((await api('GET', `/rankings/${cr.body.definition.id}`)).body.entries[0].score, 93);
  assert.equal((await define(gov.token, { sport: 'cricket', name: 'xx', formula_kind: 'per_90', metric: 'runs' })).status, 422, 'cricket has no per-90 model');
  // racket (tennis): aces per match
  const srv = await signup();
  for (let k = 0; k < 3; k++) await perf(srv, 'tennis', 'aces', 4 * (k + 1), await mkEvent(org, 'tennis'), `2026-0${k + 1}-05`, { by: org });
  const tn = await define(gov.token, { sport: 'tennis', name: 'Aces per match', formula_kind: 'per_match', metric: 'aces' });
  assert.equal(tn.status, 201, JSON.stringify(tn.body));
  assert.equal((await api('GET', `/rankings/${tn.body.definition.id}`)).body.entries[0].score, 8);
});

test('club rankings are private to the team, may use development data, and never appear publicly', async () => {
  const org = await signup(['organizer']);
  const manager = await signup(), member = await signup(), outsider = await signup();
  const teamId = (await pool.query('INSERT INTO teams(name, sport_id, owner_id) VALUES ($1,$2,$3) RETURNING id', ['Club', await sportId('athletics'), manager.id])).rows[0].id;
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'captain','active'),($1,$3,'player','active')", [teamId, manager.id, member.id]);
  const evs = [await mkEvent(org, 'athletics'), await mkEvent(org, 'athletics'), await mkEvent(org, 'athletics')];
  for (const [k, e] of evs.entries()) await perf(member, 'athletics', '100m_time_s', 11 + k, e, `2026-0${k + 1}-10`, { by: member, provenance: 'self_reported', status: 'recorded' });
  const body = { sport: 'athletics', name: 'Squad sprint', formula_kind: 'metric', metric: '100m_time_s', visibility: 'club', scope_team_id: teamId, evidence: 'development' };
  assert.equal((await define(outsider.token, body)).status, 403);
  const d = await define(manager.token, body);
  assert.equal(d.status, 201, JSON.stringify(d.body));
  const id = d.body.definition.id;
  assert.equal((await api('GET', `/rankings/${id}`, { token: member.token })).body.entries[0].subject.id, member.id);
  assert.equal((await api('GET', `/rankings/${id}`, { token: outsider.token })).status, 404, 'existence is not leaked');
  assert.equal((await api('GET', `/rankings/${id}`)).status, 404);
  assert.equal((await api('GET', '/rankings?sport=athletics', { token: outsider.token })).body.definitions.filter((x) => x.visibility === 'club').length, 0);
  assert.equal((await api('GET', '/rankings?sport=athletics', { token: member.token })).body.definitions.filter((x) => x.visibility === 'club').length, 1);
  // and the practice data is absent from a public ranking of the same metric
  const gov = await makeAdmin();
  const pub = (await define(gov.token, { sport: 'athletics', name: 'Public 100m', formula_kind: 'metric', metric: '100m_time_s' })).body;
  assert.ok(!(await api('GET', `/rankings/${pub.definition.id}`)).body.entries.some((e) => e.subject.id === member.id), 'practice data never reaches a public ranking');
});

test('the definition form is fed from real data: metrics, positions and cities for the sport', async () => {
  const org = await signup(['organizer']);
  const a = await signup();
  await pool.query("INSERT INTO sport_profiles(user_id, sport_id, role, positions) VALUES ($1,$2,'athlete','{striker,winger}')", [a.id, await sportId('hockey')]);
  await mkEvent(org, 'hockey', { city: 'Nagpur' });
  await perf(a, 'hockey', 'goals', 2, await mkEvent(org, 'hockey'), '2026-02-02', { by: org });
  const m = (await api('GET', '/rankings?sport=hockey')).body.sport_model;
  assert.deepEqual(m.positions, ['striker', 'winger']);
  assert.ok(m.cities.includes('Nagpur'));
  assert.ok(m.metrics.includes('goals'));
  assert.equal(m.family, 'goal_game');
});

test('discovery: a subject’s public ranks carry provenance; youth and club rankings never appear', async () => {
  const gov = await makeAdmin(), org = await signup(['organizer']);
  const evs = [await mkEvent(org, 'futsal'), await mkEvent(org, 'futsal'), await mkEvent(org, 'futsal')];
  const a = await signup(), kid = await signup();
  await pool.query('UPDATE users SET youth_until = current_date + 400 WHERE id=$1', [kid.id]);
  for (const [k, e] of evs.entries()) { await perf(a, 'futsal', 'goals', 2, e, `2026-0${k + 1}-03`, { by: org }); await perf(kid, 'futsal', 'goals', 5, e, `2026-0${k + 1}-03`, { by: org }); }
  const d = await define(gov.token, { sport: 'futsal', name: 'Futsal goals', formula_kind: 'metric', metric: 'goals', aggregation: 'sum' });
  assert.equal(d.status, 201, 'futsal is a native goal-games ranking: ' + JSON.stringify(d.body));
  assert.equal(d.body.definition.family, 'goal_game');
  assert.equal((await api('GET', `/rankings/${d.body.definition.id}`)).body.entries[0].score, 6);
  await api('POST', `/rankings/${d.body.definition.id}/snapshot`, { token: gov.token });
  const mine = (await api('GET', `/rankings/subjects/${a.id}`)).body.rankings;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].rank, 1);
  assert.equal(mine[0].sample_n, 3, 'the rank always comes with how many verified results it rests on');
  assert.ok(mine[0].version && mine[0].evidence_strength && mine[0].formula_hash && mine[0].as_of);
  assert.deepEqual((await api('GET', `/rankings/subjects/${kid.id}`)).body.rankings, []);
});

test('a result corrected through the real approval flow changes the ranking and snapshots it, keeping the old snapshot', async () => {
  const gov = await makeAdmin();
  const org = await signup(['organizer']), other = await signup(['referee']);
  const evs = [];
  for (let k = 0; k < 3; k++) evs.push((await api('POST', '/events', { token: org.token, body: { name: `Flow ${++n}`, sport: 'athletics' } })).body.id);
  for (const e of evs) await pool.query("INSERT INTO event_staff(event_id, user_id, role, status) VALUES ($1,$2,'timekeeper','accepted')", [e, other.id]);
  const [a, b] = [await signup(), await signup()];
  const first = {};
  for (const e of evs) for (const [u, t] of [[a, 10.0], [b, 10.5]]) {
    await pool.query("INSERT INTO event_entries(event_id, user_id, status) VALUES ($1,$2,'accepted')", [e, u.id]);
    const r = await api('POST', '/performances', { token: org.token, body: { user_id: u.id, sport: 'athletics', metric: '400m_time_s', value: t, event_id: e } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((await api('POST', `/performances/${r.body.id}/approve`, { token: other.token })).status, 200);
    first[`${u.id}${e}`] = r.body;
  }
  const d = (await define(gov.token, { sport: 'athletics', name: 'Flow 400m', formula_kind: 'metric', metric: '400m_time_s', aggregation: 'mean' })).body;
  assert.equal((await api('GET', `/rankings/${d.definition.id}`)).body.entries[0].subject.id, a.id);
  const s1 = (await api('POST', `/rankings/${d.definition.id}/snapshot`, { token: gov.token })).body.snapshot;
  // b's times were mis-keyed: correct each to 9.0 via the official correction flow (submit, then a different official approves)
  for (const e of evs) {
    const corr = await api('POST', `/performances/${first[`${b.id}${e}`].id}/correct`, { token: org.token, body: { value: 9.0, reason: 'Timing sheet re-read' } });
    assert.equal(corr.status, 201, JSON.stringify(corr.body));
    assert.equal((await api('POST', `/performances/${corr.body.id}/approve`, { token: other.token })).status, 200);
  }
  await new Promise((r) => setTimeout(r, 1500)); // the re-run after approval is fire-and-forget
  const live = (await api('GET', `/rankings/${d.definition.id}`)).body;
  assert.equal(live.entries[0].subject.id, b.id, 'the corrected results moved b to first');
  assert.equal(live.entries[0].score, 9);
  assert.equal(live.entries[0].sample_n, 3, 'superseded originals no longer count');
  const hist = (await api('GET', `/rankings/${d.definition.id}/subjects/${b.id}/history`)).body.history;
  assert.ok(hist.length >= 2, 'approving the correction took a new snapshot');
  assert.equal(hist.at(-1).rank, 2, 'the issued snapshot still shows b second');
  assert.equal((await api('GET', `/rankings/${d.definition.id}?snapshot_id=${s1.id}`)).body.entries[0].subject.id, a.id);
});
