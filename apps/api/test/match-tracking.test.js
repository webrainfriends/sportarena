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
  const r = await api('POST', '/auth/register', { body: { handle: `mt_${n}_${roles[0]}`, display_name: `Mt ${n}`, email: `mt${n}@example.com`, password: 'correct-horse-battery', roles } });
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

const mkTeam = async (u, sport) => (await api('POST', '/teams', { token: u.token, body: { name: `Team ${++n}`, sport } })).body;
const setup = async (sport = 'football') => {
  const org = await signup(['organizer']), ref = await signup(['referee']), m1 = await signup(['coach']), m2 = await signup(['coach']), rando = await signup(['athlete']);
  const ev = (await api('POST', '/events', { token: org.token, body: { name: `Live Cup ${++n}`, sport } })).body;
  const home = await mkTeam(m1, sport), away = await mkTeam(m2, sport);
  const fx = (await pool.query("INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at) VALUES ($1,$2,$3, now()) RETURNING id", [ev.id, home.id, away.id])).rows[0].id;
  await pool.query("INSERT INTO fixture_officials(fixture_id, user_id, role, status) VALUES ($1,$2,'referee','accepted')", [fx, ref.id]);
  return { org, ref, m1, m2, rando, ev, home, away, fx };
};
const log = (u, fx, body) => api('POST', `/fixtures/${fx}/events`, { token: u.token, body });

test('only the organiser or accepted officials run a game; it must be started first', async () => {
  const { org, ref, m1, rando, fx } = await setup();
  assert.equal((await log(ref, fx, { kind: 'goal', side: 'home' })).status, 409, 'not started');
  assert.equal((await api('POST', `/fixtures/${fx}/start`, { token: rando.token })).status, 403);
  assert.equal((await api('POST', `/fixtures/${fx}/start`, { token: m1.token })).status, 403, 'team managers cannot score');
  const s = await api('POST', `/fixtures/${fx}/start`, { token: ref.token });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.fixture.status, 'live');
  assert.equal((await api('POST', `/fixtures/${fx}/start`, { token: org.token })).status, 409, 'already live');
  assert.equal((await log(rando, fx, { kind: 'goal', side: 'home' })).status, 403);
});

test('football flow: periods, goals scored by the ruleset, parameters, idempotent retries, void recomputes', async () => {
  const { ref, home, away, fx } = await setup();
  await api('POST', `/fixtures/${fx}/start`, { token: ref.token });
  assert.equal((await log(ref, fx, { kind: 'three_pointer', side: 'home' })).status, 400, 'not a football event');
  assert.equal((await log(ref, fx, { kind: 'goal' })).status, 400, 'needs a side');
  let r = await log(ref, fx, { kind: 'period_start' });
  assert.equal(r.body.event.period, 1);
  assert.equal((await log(ref, fx, { kind: 'period_start' })).status, 409, 'period already running');
  r = await log(ref, fx, { kind: 'goal', side: 'home', clock_seconds: 600, client_key: 'k1' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.event.team_id, home.id);
  assert.equal(r.body.event.seq, 2);
  assert.deepEqual([r.body.state.score.home, r.body.state.score.away], [1, 0]);
  const again = await log(ref, fx, { kind: 'goal', side: 'home', client_key: 'k1' });
  assert.equal(again.body.duplicate, true);
  assert.equal(again.body.state.score.home, 1, 'a retry does not score twice');
  await log(ref, fx, { kind: 'foul', side: 'away' });
  const g2 = await log(ref, fx, { kind: 'goal', side: 'away', clock_seconds: 1300 });
  assert.equal(g2.body.state.score.away, 1);
  await log(ref, fx, { kind: 'period_end' });
  assert.equal((await log(ref, fx, { kind: 'goal', side: 'home' })).status, 409, 'between periods');
  assert.equal((await log(ref, fx, { kind: 'foul', side: 'home' })).status, 201, 'parameters are fine anytime');
  await log(ref, fx, { kind: 'period_start' });
  const g3 = await log(ref, fx, { kind: 'goal', side: 'home' });
  assert.equal(g3.body.event.period, 2);
  assert.deepEqual([g3.body.state.score.home, g3.body.state.score.away], [2, 1]);
  assert.deepEqual(g3.body.state.score.periods, [{ period: 1, home: 1, away: 1 }, { period: 2, home: 1, away: 0 }]);
  const v = await api('POST', `/match-events/${g3.body.event.id}/void`, { token: ref.token, body: { reason: 'Offside, goal disallowed' } });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.deepEqual([v.body.score.home, v.body.score.away], [1, 1]);
  assert.equal((await api('POST', `/match-events/${g3.body.id ?? g3.body.event.id}/void`, { token: ref.token, body: { reason: 'again' } })).status, 409);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM match_events WHERE fixture_id=$1', [fx])).rows[0].n, 8, 'nothing deleted');
  assert.equal(away.id, g2.body.event.team_id);
});

test('pausing a match blocks scoring; the event pause freezes and restores it', async () => {
  const { org, ref, ev, fx } = await setup();
  await api('PATCH', `/events/${ev.id}`, { token: org.token, body: { status: 'ongoing' } });
  await api('POST', `/fixtures/${fx}/start`, { token: ref.token });
  await log(ref, fx, { kind: 'period_start' });
  assert.equal((await api('POST', `/fixtures/${fx}/pause`, { token: ref.token })).body.fixture.status, 'paused');
  assert.equal((await log(ref, fx, { kind: 'goal', side: 'home' })).status, 409);
  assert.equal((await api('POST', `/fixtures/${fx}/resume`, { token: ref.token })).body.fixture.status, 'live');
  await api('POST', `/events/${ev.id}/pause`, { token: org.token, body: { reason: 'Storm' } });
  const live = await api('GET', `/fixtures/${fx}/live`);
  assert.equal(live.body.fixture.status, 'paused');
  assert.equal(live.body.fixture.pause_reason, 'Storm');
  assert.equal((await api('POST', `/fixtures/${fx}/resume`, { token: ref.token })).status, 409, 'event is paused');
  await api('POST', `/events/${ev.id}/resume`, { token: org.token, body: {} });
  assert.equal((await api('GET', `/fixtures/${fx}/live`)).body.fixture.status, 'live');
});

test('badminton: rally points make sets, the match closes itself', async () => {
  const { ref, fx } = await setup('badminton');
  await api('POST', `/fixtures/${fx}/start`, { token: ref.token });
  const rs = await api('GET', `/fixtures/${fx}/live`);
  assert.equal(rs.body.ruleset.kind, 'sets');
  assert.equal(rs.body.ruleset.sets.best_of, 3);
  let last;
  for (let set = 0; set < 2; set++) for (let k = 0; k < 21; k++) last = await log(ref, fx, { kind: 'point', side: 'home', client_key: `s${set}-${k}` });
  assert.deepEqual([last.body.state.score.home, last.body.state.score.away, last.body.state.score.over], [2, 0, true]);
  assert.equal(last.body.state.phase.can_score, false);
  assert.equal((await log(ref, fx, { kind: 'point', side: 'away' })).status, 400, 'match already decided');
  assert.equal((await log(ref, fx, { kind: 'goal', side: 'home' })).status, 400);
});

test('live reads are public, pollable by since_seq; voids are only shown to officials; event ticker lists open games', async () => {
  const { ref, ev, fx } = await setup();
  await api('POST', `/fixtures/${fx}/start`, { token: ref.token });
  await log(ref, fx, { kind: 'period_start' });
  const g = await log(ref, fx, { kind: 'goal', side: 'home' });
  await log(ref, fx, { kind: 'goal', side: 'away' });
  await api('POST', `/match-events/${g.body.event.id}/void`, { token: ref.token, body: { reason: 'Wrong side' } });
  const pub = await api('GET', `/fixtures/${fx}/live`);
  assert.equal(pub.status, 200);
  assert.deepEqual(pub.body.events.map((e) => e.kind), ['period_start', 'goal']);
  assert.deepEqual([pub.body.score.home, pub.body.score.away], [0, 1]);
  assert.equal((await api('GET', `/fixtures/${fx}/live?since_seq=2`)).body.events.length, 1);
  const off = await api('GET', `/fixtures/${fx}/live`, { token: ref.token });
  assert.equal(off.body.events.length, 3);
  assert.deepEqual(off.body.viewer, { can_score: true, organiser: false, manages: null });
  assert.deepEqual(pub.body.viewer, { can_score: false, organiser: false, manages: null }, 'a visitor can only watch');
  assert.equal(off.body.events.find((e) => e.voided_at).void_reason, 'Wrong side');
  const tick = await api('GET', `/events/${ev.id}/live`);
  assert.equal(tick.body.length, 1);
  assert.equal(tick.body[0].score.away, 1);
  const draft = (await pool.query("INSERT INTO events(name, sport_id, organizer_id, status) SELECT 'Hidden', sport_id, organizer_id, 'draft' FROM events WHERE id=$1 RETURNING id", [ev.id])).rows[0].id;
  assert.equal((await api('GET', `/events/${draft}/live`)).status, 404);
});

test('organisers can set their own rules until scoring starts; bad rules are refused', async () => {
  const { org, ref, ev, fx, rando } = await setup();
  const rules = { kind: 'points_events', label: 'Street ball', periods: { count: 1, label: 'Game' }, events: [{ kind: 'basket', label: 'Basket', points: 2 }, { kind: 'long', label: 'Long shot', points: 3 }], stats: [{ kind: 'foul', label: 'Foul' }] };
  assert.equal((await api('POST', `/events/${ev.id}/scoring-template`, { token: rando.token, body: { ruleset: rules } })).status, 403);
  assert.equal((await api('POST', `/events/${ev.id}/scoring-template`, { token: org.token, body: { ruleset: { kind: 'sets', label: 'Broken' } } })).status, 400);
  assert.equal((await api('POST', `/events/${ev.id}/scoring-template`, { token: org.token, body: { ruleset: rules } })).status, 201);
  const got = await api('GET', `/events/${ev.id}/scoring-ruleset`);
  assert.equal(got.body.source, 'template');
  assert.equal(got.body.label, 'Street ball');
  await api('POST', `/fixtures/${fx}/start`, { token: ref.token });
  const r = await log(ref, fx, { kind: 'long', side: 'home' });
  assert.equal(r.body.state.score.home, 3);
  assert.equal((await api('POST', `/events/${ev.id}/scoring-template`, { token: org.token, body: { ruleset: rules } })).status, 409, 'locked once scoring began');
  assert.ok((await api('GET', '/scoring/rulesets')).body.includes('kabaddi'));
});

test('schedule check finds court, team, rest and official clashes', async () => {
  const { org, ref, ev, home, away, m1 } = await setup();
  const sport = (await pool.query('SELECT sport_id FROM events WHERE id=$1', [ev.id])).rows[0].sport_id;
  const other = await mkTeam(m1, 'football');
  const venue = (await pool.query('INSERT INTO venues(name, owner_id, city) VALUES ($1,$2,$3) RETURNING id', ['Clash Arena', org.id, 'Pune'])).rows[0];
  const court = (await pool.query("INSERT INTO resources(venue_id, kind, name, sport_id) VALUES ($1,'court','Court 1',$2) RETURNING id", [venue.id, sport])).rows[0].id;
  const mk = async (h, a, minutes, resource = null) => (await pool.query("INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at, resource_id, duration_min) VALUES ($1,$2,$3, now() + $4 * interval '1 minute', $5, 60) RETURNING id", [ev.id, h, a, minutes, resource])).rows[0].id;
  const a = await mk(home.id, other.id, 10000, court), b = await mk(away.id, other.id, 10030, court), c = await mk(away.id, home.id, 10100);
  await pool.query("INSERT INTO fixture_officials(fixture_id, user_id, role, status) VALUES ($1,$2,'referee','accepted'),($3,$2,'referee','accepted')", [a, ref.id, b]);
  const out = await api('GET', `/events/${ev.id}/schedule-check?min_rest_min=30`, { token: org.token });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const by = (kind) => out.body.clashes.filter((x) => x.kind === kind);
  assert.deepEqual(by('court')[0].fixture_ids.sort(), [a, b].sort(), 'same court, overlapping');
  assert.equal(by('court')[0].who, court);
  assert.equal(by('team_overlap')[0].who, other.id, 'the same team in two games at once');
  assert.equal(by('official')[0].who, ref.id, 'the same referee in two games at once');
  assert.deepEqual(by('team_rest')[0].fixture_ids.sort(), [b, c].sort(), 'only 10 minutes between games');
  assert.equal(by('team_rest')[0].who, away.id);
  assert.equal(out.body.ok, false);
  const relaxed = await api('GET', `/events/${ev.id}/schedule-check?min_rest_min=5`, { token: org.token });
  assert.equal(relaxed.body.clashes.filter((x) => x.kind === 'team_rest').length, 0, '10 minutes is enough when only 5 are required');
  assert.equal((await api('GET', `/events/${ev.id}/schedule-check`, { token: ref.token })).status, 403);
});

test('a live stream (SSE) pushes the new score the moment an event is logged', async () => {
  const { ref, fx } = await setup();
  await api('POST', `/fixtures/${fx}/start`, { token: ref.token });
  await log(ref, fx, { kind: 'period_start' });
  const ctl = new AbortController();
  const res = await fetch(`${base}/api/v1/live/fixtures/${fx}`, { signal: ctl.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const next = async () => {
    for (;;) {
      const i = buf.indexOf('\n\n');
      if (i >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); const data = chunk.split('\n').find((l) => l.startsWith('data: ')); if (data) return JSON.parse(data.slice(6)); continue; }
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended');
      buf += dec.decode(value);
    }
  };
  const first = await next();
  assert.equal(first.score.home, 0);
  await log(ref, fx, { kind: 'goal', side: 'home' });
  const pushed = await next();
  assert.equal(pushed.score.home, 1);
  assert.equal(pushed.events.at(-1).kind, 'goal');
  ctl.abort();
  assert.equal((await fetch(`${base}/api/v1/live/fixtures/00000000-0000-4000-8000-000000000000`)).status, 404);
  assert.equal((await fetch(`${base}/api/v1/live/fixtures/not-a-uuid`)).status, 404);
});
