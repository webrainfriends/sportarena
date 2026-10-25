import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { metricDirection, percentileDirected, selfRatingTrend } = await import('../src/benchmarks.js');

let server, base, n = 0;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `bm_${n}`, display_name: `Bench ${n}`, email: `bm${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
// a football player whose matches are described by `rows` (stat keys go in as stats), optionally with positions
const player = async ({ rows, positions, region = 'Chennai', level = 'amateur' }) => {
  const u = await signup();
  const p = (await api('POST', '/me/sport-profiles', { token: u.token, body: { sport: 'football', role: 'athlete', level, region } })).body;
  if (positions) await pool.query('UPDATE sport_profiles SET positions=$2 WHERE id=$1', [p.id, positions]);
  const r = await api('POST', '/me/matches/import', { token: u.token, body: { sport_profile_id: p.id, rows } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { ...u, profile: p };
};
const day = (k) => `2026-02-${String(1 + k).padStart(2, '0')}`;
const matches = (count, extra) => Array.from({ length: count }, (_, k) => ({ played_on: day(k), result: 'win', ...(typeof extra === 'function' ? extra(k) : extra) }));
const insights = (u, q = '') => api('GET', `/me/insights${q}`, { token: u.token });
const row = (r, scope, key) => r.body.scopes.find((s) => s.scope === scope).comparisons.find((c) => c.key === key);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('metric direction and directed percentiles are pure and tie-aware', () => {
  assert.equal(metricDirection('turnovers'), 'lower');
  assert.equal(metricDirection('runs_against'), 'lower');
  assert.equal(metricDirection('goals'), 'higher');
  assert.equal(metricDirection('sprint_time'), 'lower');
  assert.notEqual(metricDirection('cardio_score'), 'lower', '"cardio" is not a "card"');
  assert.equal(metricDirection('vibes'), 'unknown');
  assert.equal(metricDirection('anything', 'lower'), 'lower', 'a stored direction wins');
  assert.equal(percentileDirected(1, [2, 3, 4, 5, 6], 'lower'), 100);
  assert.equal(percentileDirected(1, [2, 3, 4, 5, 6], 'higher'), 0);
  assert.equal(percentileDirected(3, [3, 3], 'higher'), 50);
});

test('lower-is-better stats rank the low value first; unknown direction is shown but not ranked', async () => {
  const me = await player({ rows: matches(4, { goals: 2, turnovers: 1, vibes: 3 }) });
  for (let k = 0; k < 5; k++) await player({ rows: matches(4, { goals: 1, turnovers: 4, vibes: 1 }) });
  const r = await insights(me);
  assert.equal(row(r, 'sport', 'turnovers').direction, 'lower');
  assert.equal(row(r, 'sport', 'turnovers').percentile, 100, 'few turnovers is the strong end');
  assert.equal(row(r, 'sport', 'goals').percentile, 100);
  const vibes = row(r, 'sport', 'vibes');
  assert.equal(vibes.status, 'unranked_direction'); assert.equal(vibes.percentile, undefined);
  // the worst player has the most turnovers: bottom of the cohort
  const worst = await insights(await player({ rows: matches(4, { goals: 1, turnovers: 9 }) }));
  assert.equal(row(worst, 'sport', 'turnovers').percentile, 0);
});

test('a stat is averaged over the matches that recorded it and says how many; too few recorded is flagged, not ranked', async () => {
  // goals recorded in 3 of 6 matches (3 each) -> 3 per recorded match, not 1.5 diluted over all six
  const me = await player({ rows: matches(6, (k) => (k < 3 ? { goals: 3 } : { rating: 6 })) });
  for (let k = 0; k < 5; k++) await player({ rows: matches(4, { goals: 2 }) });
  let r = await insights(me);
  const g = row(r, 'sport', 'goals');
  assert.equal(g.mine, 3); assert.deepEqual(g.coverage, { recorded: 3, total: 6 }); assert.equal(g.percentile, 100);
  // saves in only 2 matches: below the 3 recorded matches needed
  const two = await player({ rows: matches(5, (k) => (k < 2 ? { saves: 4 } : {})) });
  r = await insights(two);
  const mm = r.body.my_metrics.find((m) => m.key === 'saves');
  assert.equal(mm.status, 'insufficient_data'); assert.deepEqual(mm.coverage, { recorded: 2, total: 5 });
});

test('position and match-format cohorts narrow the comparison, still need 5 others, and bad filters are refused', async () => {
  const me = await player({ positions: ['Striker'], rows: matches(4, { goals: 2, match_type: 'full_match' }) });
  for (let k = 0; k < 5; k++) await player({ positions: ['Goalkeeper'], rows: matches(4, { goals: 1, match_type: 'full_match' }) });
  for (let k = 0; k < 4; k++) await player({ positions: ['striker'], rows: matches(4, { goals: 1, match_type: 'full_match' }) });
  let r = await insights(me, '?position=Striker');
  assert.equal(r.body.scopes.find((s) => s.scope === 'sport').available, false, '4 other strikers is below the floor');
  assert.equal(r.body.scopes.find((s) => s.scope === 'sport').size, 4);
  await player({ positions: ['STRIKER'], rows: matches(4, { goals: 1, match_type: 'full_match' }) });
  r = await insights(me, '?position=striker');
  assert.equal(r.body.scopes.find((s) => s.scope === 'sport').size, 5, 'position match ignores case');
  assert.equal(row(r, 'sport', 'goals').percentile, 100);
  assert.deepEqual(r.body.options.positions, ['Striker']);
  assert.equal(r.body.filters.position, 'striker');
  // a format nobody logged leaves me with nothing to compare
  r = await insights(me, '?match_type=nonsense');
  assert.equal(r.status, 400);
  assert.equal((await insights(me, '?position=Goalkeeper')).body.ready, false, 'I do not list that position');
  assert.equal((await insights(me, '?evidence=official&match_type=full_match')).status, 400, 'format does not apply to official results');
  assert.equal((await insights(me, '?evidence=bogus')).status, 400);
  assert.equal((await api('GET', '/me/insights')).status, 401);
});

test('self-logged and official evidence are compared separately and never blended', async () => {
  const me = await player({ rows: matches(4, { goals: 5 }) });
  const peers = [];
  for (let k = 0; k < 5; k++) peers.push(await player({ rows: matches(4, { goals: 1 }) }));
  const sport = (await pool.query("SELECT id FROM sports WHERE slug='football'")).rows[0].id;
  const official = (u, value) => pool.query(`INSERT INTO performances(user_id, sport_id, metric, value, points, recorded_by, provenance, status, unit, direction, achieved_on)
                                             VALUES ($1,$2,'goals',$3,3,$1,'approved_competition','approved','count','higher','2026-02-01')`, [u.id, sport, value]);
  for (const u of [me, ...peers]) for (let k = 0; k < 3; k++) await official(u, u === me ? 0 : 2);
  const self = await insights(me);
  assert.equal(self.body.evidence, 'self_reported'); assert.equal(row(self, 'sport', 'goals').mine, 5);
  const off = await insights(me, '?evidence=official');
  assert.equal(off.body.evidence, 'official'); assert.equal(row(off, 'sport', 'goals').mine, 0, 'official track ignores the self-logged goals');
  assert.equal(row(off, 'sport', 'goals').percentile, 0);
  assert.match(off.body.evidence_label, /Approved competition/);
  // unapproved or practice rows never count as official
  await pool.query(`INSERT INTO performances(user_id, sport_id, metric, value, points, recorded_by, provenance, status, unit, direction, achieved_on)
                    VALUES ($1,$2,'goals',99,0,$1,'self_reported','recorded','count','higher','2026-02-02')`, [me.id, sport]);
  assert.equal(row(await insights(me, '?evidence=official'), 'sport', 'goals').mine, 0);
});

test('self-rating trend is the player\'s own ratings only, with counts', async () => {
  const me = await player({ rows: [...matches(5, (k) => ({ rating: 8, played_on: `2026-03-${String(10 + k).padStart(2, '0')}` })), ...matches(5, (k) => ({ rating: 6, played_on: `2026-02-${String(10 + k).padStart(2, '0')}` }))] });
  const t = (await insights(me)).body.self_rating_trend;
  assert.equal(t.source, 'self'); assert.match(t.label, /not peer or coach/);
  assert.deepEqual([t.recent.n, t.recent.avg, t.previous.n, t.previous.avg, t.change, t.trend], [5, 8, 5, 6, 2, 'up']);
  const few = selfRatingTrend([7, 7]);
  assert.equal(few.sufficient, false); assert.equal(few.trend, null);
});

test('a young person counts in a cohort, and sees one, only while a guardian\'s coaching consent stands', async () => {
  const kid = await player({ rows: matches(4, { goals: 3 }) });
  const peers = [];
  for (let k = 0; k < 5; k++) peers.push(await player({ rows: matches(4, { goals: 1 }) }));
  const size = async () => (await insights(kid)).body.scopes.find((s) => s.scope === 'sport').size;
  const before = await size();
  await pool.query('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [peers[0].id]);
  assert.equal(await size(), before - 1, 'a young peer without consent is not counted');
  await pool.query("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) SELECT $2,$1,'parent','active',$2", [peers[0].id, peers[1].id]);
  await pool.query("INSERT INTO youth_consents(child_id, purpose, granted_by, policy_version, expires_at) VALUES ($1,'coaching',$2,1, now() + interval '30 days')", [peers[0].id, peers[1].id]);
  assert.equal(await size(), before, 'counted again while a guardian consents');
  await pool.query("UPDATE youth_consents SET revoked_at=now() WHERE child_id=$1", [peers[0].id]);
  assert.equal(await size(), before - 1, 'and dropped again on revocation');
  await pool.query('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);
  const r = await insights(kid);
  assert.equal(r.body.ready, false); assert.equal(r.body.code, 'guardian_consent_required');
});

test('coaches and guardians read an athlete\'s benchmarks only with a current relationship and consent; every read is audited', async () => {
  const kid = await player({ rows: matches(4, { goals: 3 }) });
  for (let k = 0; k < 5; k++) await player({ rows: matches(4, { goals: 1 }) });
  const coach = await signup(['coach']), parent = await signup(), stranger = await signup(['coach']);
  const url = `/athletes/${kid.id}/benchmarks`;
  assert.equal((await api('GET', url)).status, 401);
  assert.equal((await api('GET', url, { token: coach.token })).status, 403, 'no relationship');
  assert.equal((await api('GET', url, { token: kid.token })).body.viewer, 'self');

  const team = (await api('POST', '/teams', { token: coach.token, body: { name: 'Bench FC', sport: 'football' } })).body;
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'coach','active') ON CONFLICT (team_id, user_id) DO UPDATE SET role='coach', status='active'", [team.id, coach.id]);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [team.id, kid.id]);
  const seen = await api('GET', url, { token: coach.token });
  assert.equal(seen.status, 200); assert.equal(seen.body.viewer, 'coach'); assert.equal(seen.body.summary, undefined, 'aggregates only, no AI read-out');
  assert.ok(!JSON.stringify(seen.body).includes('bm_'), 'no other player is identifiable');
  assert.equal((await api('GET', url, { token: stranger.token })).status, 403);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='view_player_benchmarks'", [coach.id])).rows.length >= 1);

  // a young person: guardian and coach both need the guardian's current coaching consent, re-checked on every read
  await pool.query('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);
  await pool.query("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [parent.id, kid.id]);
  await pool.query("INSERT INTO youth_consents(child_id, purpose, granted_by, policy_version, expires_at) VALUES ($1,'participation',$2,1, now() + interval '30 days')", [kid.id, parent.id]);
  assert.equal((await api('GET', url, { token: parent.token })).status, 409, 'no coaching consent yet');
  assert.equal((await api('GET', url, { token: coach.token })).status, 409);
  await pool.query("INSERT INTO youth_consents(child_id, purpose, granted_by, policy_version, expires_at) VALUES ($1,'coaching',$2,1, now() + interval '30 days')", [kid.id, parent.id]);
  assert.equal((await api('GET', url, { token: parent.token })).body.viewer, 'guardian');
  assert.equal((await api('GET', url, { token: coach.token })).status, 200);
  await pool.query("UPDATE youth_consents SET revoked_at=now() WHERE child_id=$1 AND purpose='coaching'", [kid.id]);
  assert.equal((await api('GET', url, { token: parent.token })).status, 409, 'revocation takes effect on the next read');
  assert.equal((await api('GET', url, { token: coach.token })).status, 409);
  assert.equal((await api('GET', url, { token: stranger.token })).status, 403);
});
