import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { setAiTransport } = await import('../src/ai.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
let n = 0;
const signup = async (roles) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `cm_${n}_${roles[0]}`, display_name: `CM Person${n}`, email: `cm${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const post = (t, p, body) => api('POST', p, { token: t, body });
const get = (t, p) => api('GET', p, { token: t });
const iso = (d) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { setAiTransport(null); server.close(); await pool.end(); });

const setup = async (players = 6) => {
  const coach = await signup(['coach']), outsider = await signup(['coach']);
  const ps = []; for (let k = 0; k < players; k++) ps.push(await signup(['athlete']));
  const team = ok(await post(coach.token, '/teams', { name: `Match FC ${n}`, sport: 'football' }), 201);
  const rival = ok(await post(outsider.token, '/teams', { name: `Match Rival ${n}`, sport: 'football' }), 201);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'coach','active') ON CONFLICT (team_id, user_id) DO UPDATE SET role='coach', status='active'", [team.id, coach.id]);
  for (const [k, p] of ps.entries()) await pool.query("INSERT INTO team_members(team_id, user_id, role, status, position) VALUES ($1,$2,'player','active',$3)", [team.id, p.id, k < 5 ? 'Midfielder' : 'Striker']);
  const { rows: [sp] } = await pool.query("SELECT id FROM sports WHERE slug='football'");
  const { rows: [ev] } = await pool.query("INSERT INTO events(name, sport_id, organizer_id) VALUES ('League',$1,$2) RETURNING id", [sp.id, coach.id]);
  const fixture = async (status, hrs, scores = [null, null]) => (await pool.query('INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at, status, home_score, away_score) VALUES ($1,$2,$3, now() + make_interval(hours => $4), $5, $6, $7) RETURNING id', [ev.id, team.id, rival.id, hrs, status, scores[0], scores[1]])).rows[0].id;
  const event = async (fixtureId, seq, kind, player, teamId = team.id) => (await pool.query("INSERT INTO match_events(fixture_id, event_id, seq, kind, side, team_id, player_id, recorded_by) VALUES ($1,$2,$3,$4,'home',$5,$6,$7) RETURNING id", [fixtureId, ev.id, seq, kind, teamId, player?.id ?? null, coach.id])).rows[0].id;
  return { coach, outsider, ps, team, rival, fixture, event };
};

test('match prep sits beside the fixture record; objectives are checked against the OFFICIAL result only after it is published', async () => {
  const s = await setup();
  const fx = await s.fixture('scheduled', 24);
  const rec = ok(await post(s.coach.token, '/coaching/sessions', { source_type: 'fixture', source_id: fx, team_id: s.team.id }), 201);
  const body = { opponent_notes: 'Press high, weak on the left', checklist: [{ text: 'Confirm kit', done: true }, { text: 'Brief the keeper' }], objectives: [
    { text: 'Keep a clean sheet', indicator: { metric: 'clean_sheet', comparator: 'gte', target: 1 } },
    { text: 'Score two', indicator: { metric: 'score_for', comparator: 'gte', target: 2 } },
    { text: 'Five shots', indicator: { metric: 'events', kind: 'shot', comparator: 'gte', target: 5 } },
    { text: 'Play out from the back' },
  ] };
  const prep = ok(await post(s.coach.token, `/coaching/sessions/${rec.id}/match-prep`, body));
  assert.equal(prep.row_version, 1);
  assert.equal((await post(s.coach.token, `/coaching/sessions/${rec.id}/match-prep`, body)).status, 409, 'stale save refused');
  assert.equal((await post(s.coach.token, `/coaching/sessions/${rec.id}/match-prep`, { ...body, expected_version: 1, objectives: [{ text: 'x', indicator: { metric: 'events', comparator: 'gte', target: 1 } }] })).status, 400, 'an event objective needs a kind');
  assert.equal((await post(s.outsider.token, `/coaching/sessions/${rec.id}/match-prep`, body)).status, 404);
  const ctx = ok(await get(s.coach.token, `/coaching/fixtures/${fx}?team_id=${s.team.id}`));
  assert.equal(ctx.prep.opponent_notes, 'Press high, weak on the left');
  assert.deepEqual(ctx.prep.objectives.map((o) => o.outcome), ['pending', 'pending', 'pending', 'coach_judged']);
  // the match is played and published: outcomes come from the official record
  await pool.query("UPDATE fixtures SET status='finished', home_score=3, away_score=0 WHERE id=$1", [fx]);
  assert.deepEqual(ok(await get(s.coach.token, `/coaching/fixtures/${fx}?team_id=${s.team.id}`)).prep.objectives.map((o) => o.outcome), ['pending', 'pending', 'pending', 'coach_judged'], 'finished is not yet official');
  for (let k = 1; k <= 5; k++) await s.event(fx, k, 'shot', s.ps[0]);
  await pool.query("UPDATE fixtures SET status='completed' WHERE id=$1", [fx]);
  const after = ok(await get(s.coach.token, `/coaching/fixtures/${fx}?team_id=${s.team.id}`));
  assert.deepEqual(after.prep.objectives.map((o) => [o.outcome, o.actual]), [['met', 1], ['met', 3], ['met', 5], ['coach_judged', undefined]]);
  assert.equal(after.prep.objectives[0].provenance, 'official');
  assert.equal(after.official_events.length, 5); assert.ok(after.official_events.every((e) => e.provenance === 'official'));
  const { rows: [still] } = await pool.query('SELECT home_score, away_score, status FROM fixtures WHERE id=$1', [fx]);
  assert.deepEqual([still.home_score, still.away_score, still.status], [3, 0, 'completed'], 'coaching never alters the official record');
  assert.equal((await post(s.coach.token, `/coaching/sessions/${(ok(await post(s.coach.token, '/coaching/sessions', { source_type: 'team_session', source_id: randomUUID(), team_id: s.team.id, title: 'Tue' }), 201)).id}/match-prep`, body)).status, 400, 'only fixture records have match prep');
});

test('bookmarks point at your team\'s official events, can be removed, and never touch the event', async () => {
  const s = await setup();
  const fx = await s.fixture('completed', -5, [1, 1]);
  const mine = await s.event(fx, 1, 'goal', s.ps[0]);
  const theirs = await s.event(fx, 2, 'goal', null, s.rival.id);
  const rec = ok(await post(s.coach.token, '/coaching/sessions', { source_type: 'fixture', source_id: fx, team_id: s.team.id }), 201);
  const bm = ok(await post(s.coach.token, `/coaching/sessions/${rec.id}/event-bookmarks`, { match_event_id: mine, note: 'Great build-up' }), 201);
  assert.equal(bm.athlete_id, s.ps[0].id, 'defaults to the player the event is attributed to');
  assert.equal((await post(s.coach.token, `/coaching/sessions/${rec.id}/event-bookmarks`, { match_event_id: theirs })).status, 404, 'not your team\'s event');
  assert.equal((await post(s.outsider.token, `/coaching/sessions/${rec.id}/event-bookmarks`, { match_event_id: mine })).status, 404);
  const ctx = ok(await get(s.coach.token, `/coaching/fixtures/${fx}?team_id=${s.team.id}`));
  assert.equal(ctx.bookmarks.length, 1); assert.equal(ctx.official_events.find((e) => e.id === mine).bookmarked, true);
  ok(await post(s.coach.token, `/coaching/sessions/${rec.id}/event-bookmarks`, { match_event_id: mine, remove: true }), 201);
  assert.equal(ok(await get(s.coach.token, `/coaching/fixtures/${fx}?team_id=${s.team.id}`)).bookmarks.length, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM coaching_event_bookmarks')).rows[0].n, 1, 'the row is kept');
  assert.equal((await pool.query('SELECT voided_at FROM match_events WHERE id=$1', [mine])).rows[0].voided_at, null);
});

test('official figures join the metrics with their own provenance; voided events and other coaches\' matches do not count', async () => {
  const s = await setup();
  const fx = await s.fixture('completed', -48, [2, 0]);
  await s.event(fx, 1, 'goal', s.ps[0]); await s.event(fx, 2, 'goal', s.ps[0]);
  const voided = await s.event(fx, 3, 'goal', s.ps[0]);
  await pool.query('UPDATE match_events SET voided_at=now(), voided_by=$2, void_reason=$3 WHERE id=$1', [voided, s.coach.id, 'wrong player']);
  const live = await s.fixture('live', -1, [1, 0]); await s.event(live, 1, 'goal', s.ps[0]);
  const m = ok(await get(s.coach.token, `/coaching/athletes/${s.ps[0].id}/metrics?from=${iso(30)}`)).metrics;
  const goals = m.find((x) => x.key === 'official:event:goal'), matches = m.find((x) => x.key === 'official:matches');
  assert.equal(goals.value, 2); assert.equal(goals.provenance, 'official'); assert.equal(goals.unit, 'count'); assert.equal(goals.sample, 1);
  assert.equal(matches.value, 1);
  assert.equal(m.find((x) => x.key === 'attendance_rate').provenance, 'coach_observed', 'subjective and official stay distinct');
  const other = ok(await get(s.coach.token, `/coaching/athletes/${s.ps[1].id}/metrics?from=${iso(30)}`)).metrics;
  assert.equal(other.find((x) => x.key === 'official:event:goal'), undefined, 'no events for this player: nothing assumed');
});

test('position comparison uses only the same position, needs a cohort of five adults, and shows no names', async () => {
  const s = await setup(6);          // 5 midfielders + 1 striker
  const fx = await s.fixture('completed', -48, [3, 0]);
  let seq = 1;
  for (const [k, p] of s.ps.entries()) for (let g = 0; g <= k; g++) await s.event(fx, seq++, 'goal', p);
  const q = (athlete, mode) => get(s.coach.token, `/coaching/athletes/${athlete.id}/compare?metric=${encodeURIComponent('official:event:goal')}&mode=${mode}&team_id=${s.team.id}&from=${iso(30)}`);
  const pos = ok(await q(s.ps[0], 'position'));
  assert.equal(pos.result, 'insufficient_sample', 'only four other midfielders');
  assert.equal(pos.cohort.group, 'Midfielder group');
  const team = ok(await q(s.ps[0], 'team'));
  assert.equal(team.result, 'compared'); assert.equal(team.cohort.size, 5);
  assert.ok(!JSON.stringify(team).includes(s.ps[1].id));
  const striker = await q(s.ps[5], 'position');
  assert.equal(striker.status, 200); assert.equal(striker.body.result, 'insufficient_sample');
  await pool.query("UPDATE team_members SET position=NULL WHERE user_id=$1", [s.ps[0].id]);
  assert.equal((await q(s.ps[0], 'position')).status, 400, 'no position recorded');
  assert.equal((await get(s.coach.token, `/coaching/athletes/${s.ps[0].id}/compare?metric=official:matches&mode=team&team_id=${s.team.id}`)).status, 400, 'match counts are not a distribution to rank');
});

test('AI: compare_metrics explains selected metrics from the numbers only, refuses mixed units, and ask finds the notes that mention the topic', async () => {
  const s = await setup(2);
  const calls = [];
  setAiTransport(async (b) => { calls.push(b); return JSON.stringify({ headline: 'Sprint improved', items: [{ title: 'Sprint', detail: 'Faster', basis: 'observed', source_refs: ['M1', 'M9'] }] }); });
  const meas = (on, v, unit = 's') => post(s.coach.token, '/coaching/measurements', { athlete_id: s.ps[0].id, metric: 'Sprint', unit, value: v, measured_on: on });
  ok(await meas(iso(40), 3.8), 201); ok(await meas(iso(10), 3.5), 201);
  assert.equal((await post(s.coach.token, '/coaching/ai/drafts', { task: 'compare_metrics', athlete_id: s.ps[0].id })).status, 400, 'choose the metrics');
  const d = ok(await post(s.coach.token, '/coaching/ai/drafts', { task: 'compare_metrics', athlete_id: s.ps[0].id, metric_keys: ['measurement:Sprint', 'attendance_rate'], from: iso(30), to: iso(0) }), 201);
  assert.deepEqual(d.output.items[0].source_refs, ['M1'], 'forged ref dropped');
  assert.ok(d.sources.every((x) => x.type === 'metric'));
  const sent = JSON.stringify(calls[0]);
  assert.ok(sent.includes('coach_entered') && sent.includes('"previous"') && !sent.includes('Person') && !sent.includes(s.ps[0].id));
  setAiTransport(null);
  const plain = ok(await post(s.coach.token, '/coaching/ai/drafts', { task: 'compare_metrics', athlete_id: s.ps[0].id, metric_keys: ['measurement:Sprint'], from: iso(30), to: iso(0) }), 201);
  assert.equal(plain.ai, false); assert.match(plain.output.items[0].detail, /3\.8 → 3\.5/);
  ok(await meas(iso(5), 35, 'dm'), 201);
  assert.equal((await post(s.coach.token, '/coaching/ai/drafts', { task: 'compare_metrics', athlete_id: s.ps[0].id, metric_keys: ['measurement:Sprint'], from: iso(30), to: iso(0) })).status, 400, 'mixed units cannot be compared');
  assert.equal((await post(s.outsider.token, '/coaching/ai/drafts', { task: 'compare_metrics', athlete_id: s.ps[0].id, metric_keys: ['attendance_rate'] })).status, 403);
  // ask: retrieval by keyword, older than the default eight weeks
  ok(await post(s.coach.token, '/coaching/observations', { athlete_id: s.ps[1].id, note: 'First touch under pressure keeps deserting him', skill_tag: 'first touch', observed_at: new Date(Date.now() - 200 * 864e5).toISOString() }), 201);
  ok(await post(s.coach.token, '/coaching/observations', { athlete_id: s.ps[1].id, note: 'Unrelated remark about warm-up' }), 201);
  calls.length = 0;
  setAiTransport(async (b) => { calls.push(b); return JSON.stringify({ headline: 'ok', items: [] }); });
  ok(await post(s.coach.token, '/coaching/ai/drafts', { task: 'ask', athlete_id: s.ps[1].id, question: 'What have I repeatedly noted about first touch under pressure?' }), 201);
  const prompt = JSON.stringify(calls[0]);
  assert.ok(prompt.includes('deserting') && !prompt.includes('warm-up'), 'only the notes that mention the topic were sent');
});
