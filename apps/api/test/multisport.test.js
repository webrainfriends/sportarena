import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base;
const api = async (method, path, { token, body, query } = {}) => {
  const qs = query ? '?' + new URLSearchParams(query) : '';
  const r = await fetch(`${base}/api/v1${path}${qs}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
let n = 0;
const signup = async (roles) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `ms_${n}_${roles[0]}`, display_name: `MS ${n}`, email: `ms${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const at = (days, hour, min = 0) => { const d = new Date(Date.now() + days * 864e5); d.setUTCHours(hour, min, 0, 0); return d.toISOString(); };
const day = (days) => at(days, 0).slice(0, 10);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

/** A school sports day: organiser, event, three houses, `kids` participants spread over them. */
async function sportsDay({ kids = 9, programme = {}, managers = false } = {}) {
  const org = await signup(['organizer']);
  const ev = (await api('POST', '/events', { token: org.token, body: { name: `Sports Day ${n}`, sport: 'multi-sport', kind: 'tournament', starts_on: day(5), ends_on: day(5) } })).body;
  assert.ok(ev.id, JSON.stringify(ev));
  const prog = await api('PATCH', `/events/${ev.id}/programme`, { token: org.token, body: { rest_gap_min: 15, participation_points: 1, ...programme } });
  assert.equal(prog.status, 200, JSON.stringify(prog.body));
  const masters = managers ? [await signup(['athlete']), await signup(['athlete']), await signup(['athlete'])] : [];
  const houses = [];
  for (const [i, name] of ['Red', 'Blue', 'Green'].entries()) {
    const h = await api('POST', `/events/${ev.id}/houses`, { token: org.token, body: { name, color: ['#e11', '#11e', '#1a1'][i], manager_user_id: masters[i]?.id } });
    assert.equal(h.status, 201, JSON.stringify(h.body));
    houses.push(h.body);
  }
  const people = [];
  for (let k = 0; k < kids; k++) {
    const p = await api('POST', `/events/${ev.id}/participants`, { token: org.token, body: { full_name: `Kid ${n}-${k}`, house_id: houses[k % 3].id, gender: k % 2 ? 'female' : 'male', grade: '7', roll_no: `R${n}-${k}` } });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    people.push(p.body);
  }
  const disc = async (body) => {
    const r = await api('POST', `/events/${ev.id}/disciplines`, { token: org.token, body });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };
  return { org, ev, houses, people, masters, disc, T: org.token };
}
const nominate = (T, d, p, seed) => api('POST', `/disciplines/${d.id}/nominations`, { token: T, body: { participant_id: p.id, seed } });
const results = (T, sessionId, results, complete = true) => api('POST', `/sessions/${sessionId}/results`, { token: T, body: { results, complete } });

test('programme setup, roster import and nomination rules (limits, eligibility, house masters)', async () => {
  const org = await signup(['organizer']), stranger = await signup(['athlete']);
  const ev = (await api('POST', '/events', { token: org.token, body: { name: 'Games', sport: 'multi-sport' } })).body;
  assert.equal((await api('POST', `/events/${ev.id}/houses`, { token: org.token, body: { name: 'Red' } })).status, 409, 'no programme yet');
  assert.equal((await api('PATCH', `/events/${ev.id}/programme`, { token: stranger.token, body: {} })).status, 403);
  const prog = (await api('PATCH', `/events/${ev.id}/programme`, { token: org.token, body: { max_individual_entries: 2, public_names: false } })).body;
  assert.equal(prog.max_individual_entries, 2);
  assert.equal(prog.public_names, false);
  assert.equal((await api('PATCH', `/events/${ev.id}/programme`, { token: org.token, body: { rest_gap_min: 20 } })).body.max_individual_entries, 2, 'partial update keeps other rules');

  const master = await signup(['athlete']), kid = await signup(['athlete']);
  const red = (await api('POST', `/events/${ev.id}/houses`, { token: org.token, body: { name: 'Red', manager_user_id: master.id } })).body;
  const blue = (await api('POST', `/events/${ev.id}/houses`, { token: org.token, body: { name: 'Blue' } })).body;
  assert.equal((await api('POST', `/events/${ev.id}/houses`, { token: org.token, body: { name: 'red' } })).status, 409, 'house names are unique');

  const rows = [
    { full_name: 'Asha', house: 'Red', gender: 'female', grade: '7', roll_no: 'A1' }, { full_name: 'Ben', house: 'Blue', gender: 'male', grade: '8', roll_no: 'A2' },
    { full_name: 'Cara', house: 'Green', gender: 'female', grade: '7', roll_no: 'A3' }, { full_name: 'Dup', house: 'Red', roll_no: 'A1' },
  ];
  const dry = (await api('POST', `/events/${ev.id}/participants/import`, { token: org.token, body: { rows, dry_run: true } })).body;
  assert.deepEqual([dry.would_create.participants, dry.would_create.houses, dry.errors.length, dry.committed], [3, 1, 1, false]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM event_participants WHERE event_id=$1', [ev.id])).rows[0].n, 0, 'dry run writes nothing');
  assert.equal((await api('POST', `/events/${ev.id}/participants/import`, { token: org.token, body: { rows, dry_run: false } })).body.committed, true);
  const roster = (await api('GET', `/events/${ev.id}/participants`, { token: org.token })).body;
  assert.equal(roster.length, 3);
  const [asha, ben] = ['Asha', 'Ben'].map((nm) => roster.find((p) => p.full_name === nm));
  assert.equal((await api('GET', `/events/${ev.id}/participants`, { token: stranger.token })).status, 403);
  assert.deepEqual((await api('GET', `/events/${ev.id}/participants`, { token: master.token })).body.map((p) => p.full_name), ['Asha'], 'a house master sees only their house');
  // link the account to Ben
  assert.equal((await api('PATCH', `/participants/${ben.id}`, { token: org.token, body: { user_id: kid.id } })).status, 200);
  assert.equal((await api('PATCH', `/participants/${ben.id}`, { token: kid.token, body: { house_id: red.id } })).status, 403, 'only the organiser moves people');

  const disc = async (body) => (await api('POST', `/events/${ev.id}/disciplines`, { token: org.token, body })).body;
  const sprint = await disc({ sport: 'athletics', name: '100m', max_per_house: 1 });
  const girls = await disc({ sport: 'long-jump', name: 'Long jump (girls)', gender: 'female', eligible_grades: ['7'] });
  const hurdles = await disc({ sport: 'athletics', name: 'Hurdles' });
  assert.equal(sprint.result_type, 'time');
  assert.equal(girls.result_type, 'distance');
  assert.equal((await api('POST', `/events/${ev.id}/disciplines`, { token: org.token, body: { sport: 'football', name: 'Football', mode: 'team' } })).status, 400, 'team discipline needs a size');

  assert.equal((await nominate(org.token, girls, ben)).status, 400, 'boys cannot enter the girls event');
  assert.equal((await nominate(master.token, sprint, asha)).status, 201, 'house master nominates their own house');
  assert.equal((await nominate(master.token, sprint, ben)).status, 403, 'but not another house');
  assert.equal((await nominate(stranger.token, sprint, ben)).status, 403);
  assert.equal((await nominate(kid.token, sprint, ben)).status, 201, 'a participant nominates themself');
  assert.equal((await nominate(org.token, sprint, asha)).status, 409, 'already in');
  assert.equal((await nominate(org.token, hurdles, ben)).status, 201);
  const third = await disc({ sport: 'athletics', name: 'Relay-ish' });
  const over = await nominate(org.token, third, ben);
  assert.equal(over.status, 409);
  assert.match(over.body.error.message, /limit is 2/);
  const nom = (await api('GET', `/disciplines/${hurdles.id}/nominations`, { token: org.token })).body[0];
  assert.equal((await api('POST', `/nominations/${nom.id}/withdraw`, { token: kid.token })).body.status, 'withdrawn');
  assert.equal((await nominate(org.token, third, ben)).status, 201, 'withdrawing frees a place under the limit');
  // closing nominations stops everyone but the organiser
  await api('PATCH', `/events/${ev.id}/programme`, { token: org.token, body: { nominations_open: false } });
  const cara = roster.find((p) => p.full_name === 'Cara');
  assert.equal((await nominate(master.token, hurdles, asha)).status, 409);
  assert.equal((await nominate(org.token, hurdles, cara)).status, 201, 'the organiser can still add');
  // public card never carries names
  const card = (await api('GET', `/events/${ev.id}/programme`)).body;
  assert.equal(card.houses.length, 2 + 1);
  assert.ok(!JSON.stringify(card).includes('Asha'));
});

test('qualifying heats -> final, results, final places, points, privacy and certificates', async () => {
  const { ev, houses, people, T } = await sportsDay({ kids: 9 });
  const d = (await api('POST', `/events/${ev.id}/disciplines`, { token: T, body: { sport: 'athletics', name: '100m', officials_required: 0 } })).body;
  // seeds: kid k has personal best 12 + k seconds
  for (const [k, p] of people.entries()) assert.equal((await nominate(T, d, p, 12 + k)).status, 201);
  const gen = await api('POST', `/disciplines/${d.id}/heats`, { token: T, body: { lanes: 4 } });
  assert.equal(gen.status, 201, JSON.stringify(gen.body));
  assert.equal(gen.body.sessions.length, 3);
  assert.deepEqual(gen.body.sessions.map((s) => s.entries), [3, 3, 3]);
  assert.equal((await api('POST', `/disciplines/${d.id}/heats`, { token: T, body: {} })).status, 409, 'heats exist already');
  const list = (await api('GET', `/events/${ev.id}/sessions`, { query: { discipline_id: d.id } })).body;
  assert.equal(list.length, 3);
  const heats = [];
  for (const s of list) heats.push((await api('GET', `/sessions/${s.id}`, { token: T })).body);
  // the three best seeds (kids 0,1,2) are split across the three heats
  const bestPerHeat = heats.map((h) => h.entries.filter((e) => ['0', '1', '2'].includes(e.full_name.split('-')[1])).length);
  assert.deepEqual(bestPerHeat, [1, 1, 1]);
  assert.equal(heats.every((h) => h.entries.every((e) => e.lane >= 1 && e.lane <= 4)), true);
  // an unfinished heat cannot be completed
  assert.equal((await results(T, heats[0].id, [{ entry_id: heats[0].entries[0].id, value: 13.5 }])).status, 400);
  assert.equal((await api('POST', `/disciplines/${d.id}/advance`, { token: T, body: {} })).status, 409, 'heats are not done');
  // record all heats: within a heat the earlier-listed entry is faster; heat h gets base time 13 + h
  for (const [h, s] of heats.entries()) {
    const r = await results(T, s.id, s.entries.map((e, k) => ({ entry_id: e.id, value: 13 + h + k * 0.5 })));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.entries.map((e) => e.position).sort(), [1, 2, 3]);
  }
  // heat winners (13, 14, 15) + the single best of the rest (13.5) -> 4 finalists fit 4 lanes
  const adv = await api('POST', `/disciplines/${d.id}/advance`, { token: T, body: { qualifiers_per_session: 1, wildcards: 1, lanes: 4 } });
  assert.equal(adv.status, 201, JSON.stringify(adv.body));
  assert.equal(adv.body.qualified, 4);
  assert.equal(adv.body.sessions.length, 1);
  assert.equal(adv.body.sessions[0].stage ?? 'final', 'final');
  const fin = (await api('GET', `/sessions/${adv.body.sessions[0].id}`, { token: T })).body;
  assert.equal(fin.stage, 'final');
  assert.equal(fin.entries.length, 4);
  assert.equal((await api('POST', `/disciplines/${d.id}/finalize`, { token: T })).status, 409, 'final not run yet');
  const times = [10.9, 11.2, 11.2, 12.0]; // a tie for second
  const fr = await results(T, fin.id, fin.entries.map((e, k) => ({ entry_id: e.id, value: times[k] })));
  assert.deepEqual(fr.body.entries.map((e) => e.position), [1, 2, 2, 4], 'ties share a place');
  const fz = await api('POST', `/disciplines/${d.id}/finalize`, { token: T });
  assert.equal(fz.status, 200, JSON.stringify(fz.body));
  assert.deepEqual(fz.body.standings.map((s) => s.rank), [1, 2, 2, 4]);
  // 5 + 3 + 3 placement points; the other 6 of the 9 who finished a heat take 1 participation point each
  const placement = fz.body.ledger.filter((r) => r.kind === 'placement');
  assert.equal(placement.reduce((a, r) => a + r.points, 0), 11);
  assert.equal(fz.body.ledger.filter((r) => r.kind === 'participation').length, 6);

  const hb = (await api('GET', `/events/${ev.id}/leaderboard`)).body.rows;
  assert.equal(hb.reduce((a, r) => a + r.points, 0), 11 + 6);
  assert.deepEqual([hb[0].gold >= 0, typeof hb[0].rank], [true, 'number']);
  const anon = (await api('GET', `/events/${ev.id}/leaderboard`, { query: { scope: 'individual' } })).body.rows;
  assert.ok(anon.length >= 3 && anon.every((r) => r.name === null), 'names are private by default');
  const named = (await api('GET', `/events/${ev.id}/leaderboard`, { token: T, query: { scope: 'individual' } })).body.rows;
  assert.ok(named[0].name.startsWith('Kid'));
  assert.equal(named[0].points, 5);

  // correcting a heat after finalizing flags a re-finalize; re-finalizing voids (never deletes) the old points
  const fixed = await results(T, heats[0].id, heats[0].entries.map((e, k) => ({ entry_id: e.id, value: 13 + k * 0.5 })));
  assert.equal(fixed.body.refinalize_required, true);
  await api('POST', `/disciplines/${d.id}/finalize`, { token: T });
  const ledger = (await pool.query('SELECT count(*) FILTER (WHERE voided_at IS NOT NULL)::int AS voided, count(*) FILTER (WHERE voided_at IS NULL)::int AS live FROM event_points WHERE discipline_id=$1', [d.id])).rows[0];
  assert.deepEqual([ledger.voided, ledger.live], [9, 9]);
  assert.equal((await api('GET', `/events/${ev.id}/leaderboard`)).body.rows.reduce((a, r) => a + r.points, 0), 17, 'totals unchanged by a no-op correction');

  // manual bonus / penalty, and voiding
  const bonus = (await api('POST', `/events/${ev.id}/points`, { token: T, body: { house_id: houses[0].id, points: 4, reason: 'Best spirit' } })).body;
  assert.equal(bonus.kind, 'bonus');
  assert.equal((await api('POST', `/events/${ev.id}/points`, { token: T, body: { house_id: houses[0].id, points: 0, reason: 'nothing' } })).status, 400);
  assert.equal((await api('POST', `/points/${bonus.id}/void`, { token: T, body: { reason: 'Entered twice' } })).body.void_reason, 'Entered twice');
  assert.equal((await api('POST', `/points/${bonus.id}/void`, { token: T, body: { reason: 'again' } })).status, 409);

  // certificates: podium + participation, once only, verifiable by code, revocable
  const issue = await api('POST', `/disciplines/${d.id}/certificates`, { token: T, body: { places: 3, participation: true } });
  assert.equal(issue.status, 201, JSON.stringify(issue.body));
  assert.equal(issue.body.certificates.filter((c) => c.kind === 'winner').length, 1);
  assert.equal(issue.body.certificates.filter((c) => c.kind === 'runner_up').length, 2, 'both tied runners-up');
  assert.equal(issue.body.issued, 3 + 6, 'podium 1, 2, 2 plus 6 participants (rank 4 is not a podium place)');
  assert.equal((await api('POST', `/disciplines/${d.id}/certificates`, { token: T, body: { places: 3, participation: true } })).body.issued, 0, 'never duplicated');
  const cert = issue.body.certificates[0];
  const pub = await api('GET', `/certificates/${cert.code}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.body.valid, true);
  assert.equal(pub.body.event, ev.name);
  assert.equal((await api('POST', `/certificates/${cert.code}/revoke`, { token: T, body: { reason: 'Wrong spelling' } })).body.revoked_at !== null, true);
  assert.equal((await api('GET', `/certificates/${cert.code}`)).body.valid, false);
  assert.equal((await api('GET', `/certificates/NOSUCHCODE1`)).status, 404);

  // trophies: auto-award goes to the top house; ties are never broken silently
  const trophy = (await api('POST', `/events/${ev.id}/trophies`, { token: T, body: { name: 'Champion House Shield', scope: 'house' } })).body;
  const board = async () => (await api('GET', `/events/${ev.id}/leaderboard`)).body.rows;
  const bonusTo = (h, pts) => api('POST', `/events/${ev.id}/points`, { token: T, body: { house_id: h.id, points: pts, reason: 'Spirit' } });
  await bonusTo(houses[0], 100); await bonusTo(houses[1], 100);
  const rows = await board();
  const [x, y] = [houses[0], houses[1]].map((h) => rows.find((r) => r.house_id === h.id).points);
  if (x !== y) await bonusTo(x < y ? houses[0] : houses[1], Math.abs(x - y));
  const tied = await api('POST', `/trophies/${trophy.id}/award`, { token: T, body: { auto: true } });
  assert.equal(tied.status, 409, 'tied on points: never broken silently');
  assert.equal(tied.body.error.details.tied.length, 2);
  await bonusTo(houses[0], 1);
  const awarded = await api('POST', `/trophies/${trophy.id}/award`, { token: T, body: { auto: true, note: 'On a countback' } });
  assert.equal(awarded.status, 201, JSON.stringify(awarded.body));
  assert.equal(awarded.body.recipient, 'Red');
  assert.equal(awarded.body.certificate.kind, 'house_champion');
  const cabinet = (await api('GET', `/events/${ev.id}/trophies`)).body;
  assert.equal(cabinet[0].holder.house, 'Red');
});

test('team sports: house teams, knockout with a bye, ties must be decided, rounds in order', async () => {
  const { ev, houses, people, T, disc } = await sportsDay({ kids: 9 });
  const fb = await disc({ sport: 'football', name: 'Football', mode: 'team', team_size_min: 2, team_size_max: 3, max_per_house: 1 });
  // individual-style nomination is refused for team disciplines
  assert.equal((await nominate(T, fb, people[0])).status, 400);
  const bulk = await api('POST', `/disciplines/${fb.id}/nominations/bulk`, { token: T, body: { participant_ids: people.map((p) => p.id) } });
  assert.equal(bulk.status, 200, JSON.stringify(bulk.body));
  const built = await api('POST', `/disciplines/${fb.id}/teams/build`, { token: T, body: {} });
  assert.equal(built.status, 201, JSON.stringify(built.body));
  assert.equal(built.body.built.length, 3);
  assert.ok(built.body.built.every((t) => t.members === 3 && t.reserves === 0));
  assert.equal((await api('POST', `/disciplines/${fb.id}/teams`, { token: T, body: { name: 'Extra Reds', house_id: houses[0].id, member_ids: [people[0].id, people[3].id] } })).status, 409, 'one team per house');
  const teams = (await api('GET', `/disciplines/${fb.id}/teams`, { token: T })).body;
  assert.equal(teams.length, 3);
  const draw = await api('POST', `/disciplines/${fb.id}/draw`, { token: T, body: { format: 'knockout' } });
  assert.equal(draw.status, 201, JSON.stringify(draw.body));
  assert.equal(draw.body.sessions.length, 2, 'seed 1 gets a bye, seeds 2 and 3 play');
  const sess = (await api('GET', `/events/${ev.id}/sessions`, { query: { discipline_id: fb.id } })).body;
  const bye = sess.find((s) => s.status === 'completed'), match = sess.find((s) => s.status === 'draft');
  assert.ok(bye && match);
  assert.equal(match.stage, 'semi_final');
  const m = (await api('GET', `/sessions/${match.id}`, { token: T })).body;
  // a drawn knockout cannot be completed
  const tie = await results(T, m.id, m.entries.map((e) => ({ entry_id: e.id, score: 1 })));
  assert.equal(tie.status, 409);
  const won = await results(T, m.id, [{ entry_id: m.entries[0].id, score: 1, position: 2 }, { entry_id: m.entries[1].id, score: 1, position: 1 }]);
  assert.equal(won.status, 200, JSON.stringify(won.body));
  const adv = await api('POST', `/disciplines/${fb.id}/advance`, { token: T, body: { third_place: false } });
  assert.equal(adv.status, 201, JSON.stringify(adv.body));
  assert.equal(adv.body.sessions[0].stage, 'final');
  assert.equal(adv.body.sessions[0].entries, 2);
  assert.equal((await api('POST', `/disciplines/${fb.id}/advance`, { token: T, body: {} })).status, 409, 'the final is drawn');
  // the final cannot be put before the semi-final was played... it can, as the semi is complete; but not before the bye's session date constraints
  const final = adv.body.sessions[0];
  const fm = (await api('GET', `/sessions/${final.id}`, { token: T })).body;
  assert.equal((await results(T, final.id, [{ entry_id: fm.entries[0].id, score: 3 }, { entry_id: fm.entries[1].id, score: 2 }])).status, 200);
  const fz = await api('POST', `/disciplines/${fb.id}/finalize`, { token: T });
  assert.equal(fz.status, 200, JSON.stringify(fz.body));
  assert.deepEqual(fz.body.standings.map((s) => s.rank).sort(), [1, 2, 3]);
  const board = (await api('GET', `/events/${ev.id}/leaderboard`, { query: { scope: 'team' } })).body.rows;
  assert.equal(board[0].points, 5);
  const res = (await api('GET', `/disciplines/${fb.id}/results`)).body;
  assert.equal(res.final_places.length, 3);
  assert.ok(res.final_places.every((p) => p.participant_id === null));
  // certificates for a winning team go to every member
  const issue = await api('POST', `/disciplines/${fb.id}/certificates`, { token: T, body: {} });
  assert.equal(issue.body.issued, 9, 'three teams x three players (ranks 1, 2 and the joint 3)');
});

test('round robin table + the timetable never puts a person in two places (auto schedule, clashes, rest gap, round order)', async () => {
  const { ev, people, T, disc } = await sportsDay({ kids: 9 });
  const fb = await disc({ sport: 'football', name: 'Football', mode: 'team', team_size_min: 3, team_size_max: 3 });
  const sprint = await disc({ sport: 'athletics', name: '100m', officials_required: 0 });
  for (const p of people) await nominate(T, sprint, p, 12);
  await api('POST', `/disciplines/${fb.id}/nominations/bulk`, { token: T, body: { participant_ids: people.map((p) => p.id) } });
  await api('POST', `/disciplines/${fb.id}/teams/build`, { token: T, body: {} });
  const rr = await api('POST', `/disciplines/${fb.id}/draw`, { token: T, body: { format: 'round_robin', duration_min: 40 } });
  assert.equal(rr.body.sessions.length, 3, '3 teams -> 3 matches');
  const heats = await api('POST', `/disciplines/${sprint.id}/heats`, { token: T, body: { lanes: 4, duration_min: 15 } });
  assert.equal(heats.body.sessions.length, 3);

  // manual clash: football match at 10:00, a heat with the same kids at 10:20 / 10:45 / 11:00
  const matches = (await api('GET', `/events/${ev.id}/sessions`, { query: { discipline_id: fb.id } })).body;
  const [m1] = matches;
  const m1d = (await api('GET', `/sessions/${m1.id}`, { token: T })).body;
  const teamIds = m1d.entries.map((e) => e.team_id);
  const playing = (await pool.query('SELECT participant_id FROM discipline_nominations WHERE team_id = ANY($1::uuid[])', [teamIds])).rows.map((r) => r.participant_id);
  let clashHeat = null;
  for (const h of (await api('GET', `/events/${ev.id}/sessions`, { query: { discipline_id: sprint.id } })).body) {
    const hd = (await api('GET', `/sessions/${h.id}`, { token: T })).body;
    if (hd.entries.some((e) => playing.includes(e.participant_id))) { clashHeat = hd; break; }
  }
  assert.ok(clashHeat);
  assert.equal((await api('PATCH', `/sessions/${m1.id}`, { token: T, body: { scheduled_at: at(5, 10, 0), location: 'Main field' } })).status, 200);
  const overlap = await api('PATCH', `/sessions/${clashHeat.id}`, { token: T, body: { scheduled_at: at(5, 10, 20), location: 'Track' } });
  assert.equal(overlap.status, 409, 'same kids, overlapping');
  assert.ok(overlap.body.error.details.conflicts.some((c) => c.type === 'participant_overlap'));
  const tight = await api('PATCH', `/sessions/${clashHeat.id}`, { token: T, body: { scheduled_at: at(5, 10, 45), location: 'Track' } });
  assert.equal(tight.status, 409, '5 minutes of rest is less than the 15 minute gap');
  const ok = await api('PATCH', `/sessions/${clashHeat.id}`, { token: T, body: { scheduled_at: at(5, 11, 0), location: 'Track' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.status, 'scheduled');
  // same ground twice
  const other = matches[1];
  assert.equal((await api('PATCH', `/sessions/${other.id}`, { token: T, body: { scheduled_at: at(5, 10, 30), location: 'main field' } })).status, 409, 'ground double-booked');
  assert.equal((await api('GET', `/events/${ev.id}/schedule/conflicts`, { token: T })).body.ok, true);
  // allow_tight lets the organiser accept a short rest knowingly; the audit then reports it
  assert.equal((await api('PATCH', `/sessions/${clashHeat.id}`, { token: T, body: { scheduled_at: at(5, 10, 45), allow_tight: true } })).status, 200);
  const audit = (await api('GET', `/events/${ev.id}/schedule/conflicts`, { token: T })).body;
  assert.equal(audit.ok, false);
  assert.ok(audit.conflicts.every((c) => c.type === 'participant_tight'));
  await api('PATCH', `/sessions/${clashHeat.id}`, { token: T, body: { scheduled_at: null } }); // back to the draft pool

  // dry run changes nothing, real run places everything with no clash
  const body = { dates: [day(5), day(6)], day_start: '09:00', day_end: '13:00', breaks: [{ start: '11:00', end: '11:30' }], grounds: [{ name: 'Track' }, { name: 'Main field' }, { name: 'Side field' }] };
  const before = (await pool.query("SELECT count(*)::int AS n FROM event_sessions WHERE event_id=$1 AND status='draft'", [ev.id])).rows[0].n;
  const dry = (await api('POST', `/events/${ev.id}/schedule/auto`, { token: T, body })).body;
  assert.equal(dry.dry_run, true);
  assert.equal(dry.unplaced, 0, JSON.stringify(dry.unplaced_sessions));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM event_sessions WHERE event_id=$1 AND status='draft'", [ev.id])).rows[0].n, before);
  const real = (await api('POST', `/events/${ev.id}/schedule/auto`, { token: T, body: { ...body, dry_run: false } })).body;
  assert.equal(real.placed, before);
  const audit2 = (await api('GET', `/events/${ev.id}/schedule/conflicts`, { token: T })).body;
  assert.equal(audit2.ok, true, JSON.stringify(audit2.conflicts));
  assert.equal(audit2.unscheduled_sessions, 0);
  // nobody scheduled during the lunch break
  const all = (await api('GET', `/events/${ev.id}/sessions`, { query: { limit: 100 } })).body;
  for (const s of all) {
    const start = new Date(s.scheduled_at), end = new Date(start.getTime() + s.duration_min * 60000);
    const lunchS = new Date(start); lunchS.setUTCHours(11, 0, 0, 0); const lunchE = new Date(start); lunchE.setUTCHours(11, 30, 0, 0);
    assert.ok(end <= lunchS || start >= lunchE, `${s.label} overlaps lunch`);
  }
  // the person-level guarantee, checked straight from the database
  const clash = await pool.query(
    `WITH pe AS (SELECT e.session_id, e.participant_id FROM event_session_entries e WHERE e.participant_id IS NOT NULL
                 UNION SELECT e.session_id, nn.participant_id FROM event_session_entries e JOIN discipline_nominations nn ON nn.team_id=e.team_id)
     SELECT 1 FROM pe a JOIN pe b ON a.participant_id=b.participant_id AND a.session_id<b.session_id JOIN event_sessions x ON x.id=a.session_id JOIN event_sessions y ON y.id=b.session_id
      WHERE x.event_id=$1 AND x.scheduled_at < y.scheduled_at + y.duration_min * interval '1 minute' + interval '15 minutes' AND y.scheduled_at < x.scheduled_at + x.duration_min * interval '1 minute' + interval '15 minutes'`, [ev.id]);
  assert.equal(clash.rowCount, 0);

  // round-robin results -> table
  const ms = (await api('GET', `/events/${ev.id}/sessions`, { query: { discipline_id: fb.id } })).body;
  const scores = [[3, 0], [1, 1], [0, 2]];
  for (const [k, s] of ms.entries()) {
    const d = (await api('GET', `/sessions/${s.id}`, { token: T })).body;
    assert.equal((await results(T, d.id, d.entries.map((e, j) => ({ entry_id: e.id, score: scores[k][j] })))).status, 200);
  }
  const sheet = (await api('GET', `/disciplines/${fb.id}/results`)).body;
  assert.equal(sheet.table.length, 3);
  assert.equal(sheet.table[0].rank, 1);
  assert.ok(sheet.table[0].points >= sheet.table[1].points);
  const fz = await api('POST', `/disciplines/${fb.id}/finalize`, { token: T });
  assert.equal(fz.status, 200, JSON.stringify(fz.body));
});

test('hiring referees, physios and doctors; shifts never overlap; medical cover gaps; incidents are encrypted and gated', async () => {
  const { ev, people, houses, T, disc, org } = await sportsDay({ kids: 6 });
  const sprint = await disc({ sport: 'athletics', name: '100m', officials_required: 1 });
  for (const p of people) await nominate(T, sprint, p, 12);
  const gen = (await api('POST', `/disciplines/${sprint.id}/heats`, { token: T, body: { lanes: 3 } })).body;
  const [h1, h2] = gen.sessions;
  assert.equal((await api('PATCH', `/sessions/${h1.id}`, { token: T, body: { scheduled_at: at(5, 9, 0), location: 'Track' } })).status, 200);
  assert.equal((await api('PATCH', `/sessions/${h2.id}`, { token: T, body: { scheduled_at: at(5, 9, 10), location: 'Track B' } })).status, 200);

  const ref = await signup(['referee']), physio = await signup(['physio']), doctor = await signup(['doctor']), plain = await signup(['athlete']), tennisRef = await signup(['referee']);
  assert.equal((await api('POST', '/me/sport-profiles', { token: ref.token, body: { sport: 'athletics', role: 'referee' } })).status, 201);
  assert.equal((await api('POST', '/me/sport-profiles', { token: tennisRef.token, body: { sport: 'tennis', role: 'referee' } })).status, 201);
  const found = (await api('GET', `/events/${ev.id}/crew/search`, { token: T, query: { role: 'referee', sport: 'athletics' } })).body;
  assert.deepEqual(found.map((u) => u.id), [ref.id]);
  const inv = (role, user, extra = {}) => api('POST', `/events/${ev.id}/staff`, { token: T, body: { user_id: user.id, role, ...extra } });
  assert.equal((await inv('doctor', plain)).status, 400, 'a doctor post needs the doctor role');
  assert.equal((await inv('referee', tennisRef, { sport: 'athletics' })).status, 400, 'not an athletics referee');
  assert.equal((await api('POST', `/events/${ev.id}/staff`, { token: plain.token, body: { user_id: ref.id, role: 'referee' } })).status, 403);
  const refPost = (await inv('referee', ref, { sport: 'athletics', rate_cents: 150000 })).body;
  assert.equal(refPost.status, 'invited');
  assert.equal((await inv('referee', ref)).status, 409, 'already holds that post');
  const docPost = (await inv('doctor', doctor, { rate_cents: 500000 })).body;
  const phyPost = (await inv('physio', physio)).body;
  assert.equal((await api('POST', `/event-staff/${refPost.id}/shifts`, { token: T, body: { session_id: h1.id } })).status, 409, 'must accept first');
  assert.equal((await api('POST', `/event-staff/${refPost.id}/respond`, { token: plain.token, body: { response: 'accept' } })).status, 403);
  for (const [u, p] of [[ref, refPost], [doctor, docPost], [physio, phyPost]]) assert.equal((await api('POST', `/event-staff/${p.id}/respond`, { token: u.token, body: { response: 'accept' } })).body.status, 'accepted');

  // officiating: assigned to heat 1; heat 2 starts 10 minutes in -> clash for the same person
  const sh = await api('POST', `/event-staff/${refPost.id}/shifts`, { token: T, body: { session_id: h1.id } });
  assert.equal(sh.status, 201, JSON.stringify(sh.body));
  assert.equal(sh.body.kind, 'officiating');
  assert.equal((await api('POST', `/event-staff/${refPost.id}/shifts`, { token: T, body: { session_id: h2.id } })).status, 409, 'cannot be in two places');
  // rescheduling the session moves the shift, and is refused if it would clash
  assert.equal((await api('PATCH', `/sessions/${h1.id}`, { token: T, body: { scheduled_at: at(5, 14, 0) } })).status, 200);
  assert.equal(new Date((await api('GET', `/events/${ev.id}/shifts`, { token: T })).body.find((s) => s.id === sh.body.id).starts_at).toISOString(), at(5, 14, 0));
  assert.equal((await api('POST', `/event-staff/${refPost.id}/shifts`, { token: T, body: { session_id: h2.id } })).status, 201);
  assert.equal((await api('PATCH', `/sessions/${h1.id}`, { token: T, body: { scheduled_at: at(5, 9, 10), location: 'Track' } })).status, 409, 'moving h1 on top of h2 would double-book the referee');

  // gaps: h1 has no official? (it has one) -> h1 fine, both lack medical cover
  const gaps = (await api('GET', `/events/${ev.id}/staffing-gaps`, { token: T })).body;
  assert.equal(gaps.sessions_missing_officials.length, 0);
  assert.equal(gaps.sessions_without_medical_cover.length, 2);
  const cover = await api('POST', `/event-staff/${phyPost.id}/shifts`, { token: T, body: { starts_at: at(5, 8, 30), ends_at: at(5, 12, 0) } });
  assert.equal(cover.body.kind, 'medical_cover');
  const gaps2 = (await api('GET', `/events/${ev.id}/staffing-gaps`, { token: T })).body;
  assert.deepEqual(gaps2.sessions_without_medical_cover.map((s) => s.session_id), [h1.id], 'h2 at 09:10 is covered, h1 at 14:00 is not');
  assert.equal((await api('POST', `/event-staff/${phyPost.id}/shifts`, { token: T, body: { starts_at: at(5, 11, 0), ends_at: at(5, 13, 0) } })).status, 409, 'overlapping cover for one physio');

  // only an assigned official records the result
  const h2d = (await api('GET', `/sessions/${h2.id}`, { token: T })).body;
  const rows = h2d.entries.map((e, k) => ({ entry_id: e.id, value: 13 + k }));
  assert.equal((await results(plain.token, h2.id, rows)).status, 403);
  assert.equal((await results(ref.token, h2.id, rows)).status, 200, 'the assigned referee');
  const h1d = (await api('GET', `/sessions/${h1.id}`, { token: T })).body;
  assert.equal((await results(ref.token, h1.id, h1d.entries.map((e, k) => ({ entry_id: e.id, value: 13 + k })))).status, 200);
  assert.equal((await api('GET', `/sessions/${h2.id}`)).body.officials[0]?.role, 'referee');

  // a later round cannot start before the earlier round has finished
  const adv = await api('POST', `/disciplines/${sprint.id}/advance`, { token: T, body: { qualifiers_per_session: 3 } });
  assert.equal(adv.status, 201, JSON.stringify(adv.body));
  const finalId = adv.body.sessions[0].id;
  assert.equal((await api('PATCH', `/sessions/${finalId}`, { token: T, body: { scheduled_at: at(5, 12, 0), location: 'Track' } })).status, 409, 'heat 1 only ends at 14:15');
  assert.equal((await api('PATCH', `/sessions/${finalId}`, { token: T, body: { scheduled_at: at(5, 15, 0), location: 'Track' } })).status, 200);

  // release cancels shifts
  assert.equal((await api('POST', `/event-staff/${refPost.id}/release`, { token: T, body: {} })).body.status, 'released');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM event_shifts WHERE staff_id=$1 AND status='assigned'", [refPost.id])).rows[0].n, 0);
  assert.equal((await api('POST', `/event-staff/${refPost.id}/payments`, { token: T, body: { amount_cents: 150000 } })).body.paid_cents, 150000);
  assert.equal((await api('GET', `/events/${ev.id}/staff`, { token: ref.token })).body.length, 1, 'crew see only their own post');
  assert.equal((await api('GET', '/me/event-duties', { token: physio.token })).body.shifts.length, 1);

  // medical incidents: encrypted at rest, gated, audit-logged; "not cleared" = medical hold
  const kid = people[0];
  const report = { participant_id: kid.id, severity: 'moderate', outcome: 'referred', return_to_play: 'not_cleared', summary: 'Sprained ankle on the bend', details: 'Swelling, cold pack, referred for X-ray' };
  assert.equal((await api('POST', `/events/${ev.id}/medical-incidents`, { token: T, body: report })).status, 403, 'the organiser is not a clinician');
  const inc = await api('POST', `/events/${ev.id}/medical-incidents`, { token: physio.token, body: report });
  assert.equal(inc.status, 201, JSON.stringify(inc.body));
  const raw = (await pool.query('SELECT summary_enc FROM event_medical_incidents WHERE id=$1', [inc.body.id])).rows[0].summary_enc;
  assert.ok(!raw.includes('ankle'), 'clinical text is stored encrypted');
  const org_view = (await api('GET', `/events/${ev.id}/medical-incidents`, { token: T })).body[0];
  assert.equal(org_view.summary, undefined, 'the organiser sees no clinical text');
  assert.equal(org_view.return_to_play, 'not_cleared');
  const med_view = (await api('GET', `/events/${ev.id}/medical-incidents`, { token: physio.token })).body[0];
  assert.equal(med_view.summary, 'Sprained ankle on the bend');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='read_clinical'", [physio.id])).rowCount >= 1);
  assert.equal((await api('GET', `/events/${ev.id}/medical-incidents`, { token: plain.token })).status, 403);
  assert.equal((await pool.query('SELECT medical_hold FROM event_participants WHERE id=$1', [kid.id])).rows[0].medical_hold, true);
  const other = await disc({ sport: 'athletics', name: 'Hurdles' });
  assert.equal((await nominate(T, other, kid)).status, 409, 'on hold -> cannot be nominated');
  assert.ok((await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='event_medical'", [org.id])).rowCount >= 1);
  await api('POST', `/events/${ev.id}/medical-incidents`, { token: doctor.token, body: { participant_id: kid.id, severity: 'minor', outcome: 'treated_on_site', return_to_play: 'cleared', summary: 'X-ray clear' } });
  assert.equal((await nominate(T, other, kid)).status, 201, 'hold lifted');

  // dashboard
  const dash = (await api('GET', `/events/${ev.id}/dashboard`, { token: T })).body;
  assert.equal(dash.participants, 6);
  assert.ok(Array.isArray(dash.todo));
  assert.equal((await api('GET', `/events/${ev.id}/dashboard`, { token: plain.token })).status, 403);
  // the event cannot be closed while a discipline is still open, unless the organiser insists
  const closing = await api('POST', `/events/${ev.id}/complete`, { token: T });
  assert.equal(closing.status, 409);
  assert.ok(closing.body.error.details.disciplines.includes('100m'));
  assert.equal((await api('POST', `/events/${ev.id}/complete`, { token: T, body: { force: true } })).body.status, 'completed');
  void houses;
});

test('announcements reach the right people; participants and house masters see only what is theirs', async () => {
  const { ev, people, houses, masters, T, disc, org } = await sportsDay({ kids: 6, managers: true });
  const redKid = await signup(['athlete']), blueKid = await signup(['athlete']);
  await api('PATCH', `/participants/${people[0].id}`, { token: T, body: { user_id: redKid.id } }); // house 0 = Red
  await api('PATCH', `/participants/${people[1].id}`, { token: T, body: { user_id: blueKid.id } }); // house 1 = Blue
  const sprint = await disc({ sport: 'athletics', name: '100m' });
  await nominate(T, sprint, people[0], 12);

  const say = (token, body) => api('POST', `/events/${ev.id}/announcements`, { token, body });
  assert.equal((await say(masters[1].token, { audience: 'house', house_id: houses[0].id, title: 'Hello', body: 'Not your house' })).status, 403);
  assert.equal((await say(masters[0].token, { audience: 'all', title: 'Hello', body: 'Everyone' })).status, 403, 'house masters cannot broadcast');
  const mine = await say(masters[0].token, { audience: 'house', house_id: houses[0].id, title: 'Red assemble', body: 'Meet at the gate at 8' });
  assert.equal(mine.status, 201);
  assert.equal(mine.body.recipients, 1, 'the Red participant with an account (the sender is skipped)');
  const everyone = await say(T, { audience: 'all', title: 'Welcome', body: 'Sports day starts at 9', urgent: true });
  assert.equal(everyone.body.recipients, 2 + 3, '2 participant accounts + 3 house masters');
  const disc_msg = await say(T, { audience: 'discipline', discipline_id: sprint.id, title: '100m', body: 'Report to the track' });
  assert.equal(disc_msg.body.recipients, 2, 'the entrant and the house master of their house');
  assert.equal((await say(T, { audience: 'staff', title: 'Crew', body: 'Briefing at 8' })).body.recipients, 0);
  assert.ok((await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='event_announcement' AND title LIKE '%Welcome'", [redKid.id])).rowCount === 1);

  const redSees = (await api('GET', `/events/${ev.id}/announcements`, { token: redKid.token })).body.map((a) => a.title).sort();
  const blueSees = (await api('GET', `/events/${ev.id}/announcements`, { token: blueKid.token })).body.map((a) => a.title).sort();
  assert.deepEqual(redSees, ['100m', 'Red assemble', 'Welcome']);
  assert.deepEqual(blueSees, ['Welcome']);
  assert.equal((await api('GET', `/events/${ev.id}/announcements`, { token: T })).body.length, 4);

  const my = (await api('GET', '/me/games', { token: redKid.token })).body;
  assert.equal(my.participating.length, 1);
  assert.equal(my.participating[0].house, 'Red');
  assert.equal(my.participating[0].nominations[0].name, '100m');
  assert.equal((await api('GET', '/me/games', { token: masters[0].token })).body.managing_houses.length, 1);
  void org;
});

test('a participant sees their multi-sport sessions in the unified sport schedule', async () => {
  const { ev, people, T, disc } = await sportsDay({ kids: 3 });
  const kid = await signup(['athlete']);
  await api('PATCH', `/participants/${people[0].id}`, { token: T, body: { user_id: kid.id } });
  const sprint = await disc({ sport: 'athletics', name: '100m' });
  for (const p of people) await nominate(T, sprint, p, 12);
  const gen = (await api('POST', `/disciplines/${sprint.id}/heats`, { token: T, body: {} })).body;
  assert.equal(gen.sessions.length, 1);
  assert.equal(gen.sessions[0].stage, 'final', 'a field that fits one race goes straight to a final');
  await api('PATCH', `/sessions/${gen.sessions[0].id}`, { token: T, body: { scheduled_at: at(5, 10, 0), location: 'Track' } });
  const sched = (await api('GET', '/me/sport-schedule', { token: kid.token, query: { from: day(4), to: day(7) } })).body;
  const item = sched.items.find((x) => x.source_type === 'event_session');
  assert.ok(item, JSON.stringify(sched.items));
  assert.match(item.context, /Track/);
  assert.equal((await api('GET', '/me/sport-schedule', { token: (await signup(['athlete'])).token, query: { from: day(4), to: day(7) } })).body.items.length, 0);
  // mine=true filters the programme to my own sessions
  assert.equal((await api('GET', `/events/${ev.id}/sessions`, { token: kid.token, query: { mine: 'true' } })).body.length, 1);
});
