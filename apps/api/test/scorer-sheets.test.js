import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { rankRows, parseMark } = await import('../src/tracking/logic.js');
const net = await import('node:net');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const type = r.headers.get('content-type') ?? '';
  return { status: r.status, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
};
let n = 0;
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `ss_${n}_${roles[0]}`, display_name: `Ss ${n}`, email: `ss${n}@example.com`, password: 'correct-horse-battery', roles } });
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

const start = (u, body) => api('POST', '/tracking/sheets', { token: u.token, body });
const patch = (u, id, body) => api('PATCH', `/tracking/sheets/${id}`, { token: u.token, body });
const ball = (u, id, side, payload) => patch(u, id, { add_entry: { kind: 'ball', side, payload } });
const rules = (u, sport, settings, extra = {}) => api('POST', '/local-rules', { token: u.token, body: { sport, name: `Local ${sport}`, settings, ...extra } });

test('parseMark and rankRows: times, distances, ties, DNS/DQ, Q and q, false start', () => {
  assert.equal(parseMark('9.83'), 9.83); assert.equal(parseMark('1:45.20'), 105.2); assert.equal(parseMark('2:03:15.4'), 7395.4); assert.equal(parseMark('fast'), null);
  const heat = rankRows([
    { name: 'A', result: '10.05', reaction: '0.150' }, { name: 'B', result: '9.98', reaction: '0.090' }, { name: 'C', result: '10.05' },
    { name: 'D', result: '10.30' }, { name: 'E', result: '10.31' }, { name: 'F', result: '10.40' }, { name: 'G', status: 'DNS' }, { name: 'H', result: '11.00', status: 'DQ' },
  ], 'time', { qp: 2, qt: 2, reactionMin: 0.1 });
  assert.deepEqual(heat.rows.map((r) => r.rank), [2, 1, 2, 4, 5, 6, null, null], 'ties share a place; DNS and DQ have none');
  assert.deepEqual(heat.rows.map((r) => r.q), ['Q', 'Q', 'Q', 'q', 'q', '', '', '']);
  assert.equal(heat.warnings.length, 1); assert.match(heat.warnings[0].message, /false start/);
  const jump = rankRows([{ result: '7.10' }, { result: '7.85' }, { result: '' }], 'distance');
  assert.deepEqual(jump.rows.map((r) => r.rank), [2, 1, null]);
});

test('football match report: local rules print on the sheet, team lists and officials are stored beside the score', async () => {
  const u = await signup();
  const lr = await rules(u, 'football', { half: 40, subs: 3 });
  assert.equal(lr.status, 201, JSON.stringify(lr.body));
  const s = await start(u, { sport: 'football', local_rules_id: lr.body.id, labels: { home: 'Reds', away: 'Blues' } });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.equal(s.body.rules.local.name, 'Local football'); assert.equal(s.body.rules.lines.length, 2);
  assert.ok(s.body.rules.lines.some((l) => /40 min/.test(l)));
  assert.equal(s.body.template.layout.form.title, 'Match report (FIFA style)');
  assert.ok(s.body.template.layout.form.sections.some((x) => x.t === 'note'), 'the rules box is printed');
  assert.ok(s.body.local_rule_version_id);
  const plain = await start(u, { sport: 'football' });
  assert.equal(plain.body.rules.lines.length, 0, 'standard rules: no changes to print');
  assert.notEqual(plain.body.template.id, s.body.template.id, 'a sheet under local rules pins its own template version');

  const players = { home: [{ no: '1', name: 'Keeper', gk: true }, { no: '9', name: 'Striker', captain: true }, { no: '14', name: 'Bench', role: 'sub' }], away: [{ no: '10', name: 'Ten' }] };
  const d = await patch(u, s.body.id, { details: { info: { competition: 'Junior League', weather: 'Dry' }, players, officials: { referee: 'A. Ref', var: 'B. Var' } } });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal(d.body.details.players.home.length, 3); assert.equal(d.body.details.players.home[1].captain, true);
  const d2 = await patch(u, s.body.id, { details: { info: { venue_notes: 'Pitch 2' } } });
  assert.equal(d2.body.details.info.competition, 'Junior League', 'details merge, they do not replace');
  assert.equal(d2.body.details.info.venue_notes, 'Pitch 2'); assert.equal(d2.body.details.officials.referee, 'A. Ref');
  assert.equal((await patch(u, s.body.id, { details: { players: { home: Array.from({ length: 40 }, () => ({})) } } })).status, 400);
  // a goal with a scorer rides on the entry payload; the score still comes from the engine
  await patch(u, s.body.id, { add_entry: { kind: 'period_start', period: 1 } });
  const g = await patch(u, s.body.id, { add_entry: { kind: 'goal', side: 'home', period: 1, payload: { player_no: '9', minute: 12, type: 'penalty' } } });
  assert.equal(g.body.result.home, 1);
  assert.equal(g.body.entries.at(-1).payload.player_no, '9');
  const pdf = await api('GET', `/tracking/sheets/${s.body.id}/pdf`, { token: u.token });
  assert.equal(pdf.status, 200); assert.equal(pdf.body.subarray(0, 4).toString(), '%PDF');
  const other = await signup();
  assert.equal((await patch(other, s.body.id, { details: { info: { competition: 'x' } } })).status, 404);
});

test('local rules that change scoring reach a standalone racket sheet', async () => {
  const u = await signup();
  const lr = await rules(u, 'badminton', { points: 15, bestof: 1 });
  const s = await start(u, { sport: 'badminton', variant: 'Singles', local_rules_id: lr.body.id });
  assert.equal(s.body.template.ruleset.sets.points_to_win, 15); assert.equal(s.body.template.ruleset.sets.best_of, 1);
  let r;
  for (let i = 0; i < 15; i++) r = await patch(u, s.body.id, { add_entry: { kind: 'point', side: 'home' } });
  assert.equal(r.body.result.over, true); assert.equal(r.body.result.home, 1);
  assert.equal((await patch(u, s.body.id, { add_entry: { kind: 'point', side: 'away' } })).status, 409, 'the match is decided');
  // somebody else's private rules cannot be used
  const o = await signup();
  assert.equal((await start(o, { sport: 'badminton', local_rules_id: lr.body.id })).status, 404);
  assert.equal((await start(u, { sport: 'squash', local_rules_id: lr.body.id })).status, 400, 'rules for another sport');
});

test('cricket T20 scorebook over the API: the log makes the card, rules are enforced, nothing can be typed in as a total', async () => {
  const u = await signup();
  const lr = await rules(u, 'cricket', { ov_t20: 5, bq_t20: 1 }, { format: 'T20' });
  assert.equal(lr.status, 201, JSON.stringify(lr.body));
  const s = await start(u, { sport: 'cricket', variant: 'T20', local_rules_id: lr.body.id });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.equal(s.body.template.layout.mode, 'cricket'); assert.equal(s.body.template.ruleset.cricket.overs, 5); assert.equal(s.body.template.ruleset.cricket.bowler_max, 1);
  const id = s.body.id;
  await patch(u, id, { details: { players: { home: Array.from({ length: 11 }, (_, i) => ({ no: String(i + 1), name: `Home ${i + 1}` })), away: Array.from({ length: 11 }, (_, i) => ({ no: String(i + 1), name: `Away ${i + 1}` })) } } });
  let r = await ball(u, id, 'home', { bowler: 0, runs: 4 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.result.cricket.innings[0].batters[0].fours, 1);
  r = await ball(u, id, 'home', { bowler: 0, runs: 1 });
  assert.equal(r.body.result.cricket.innings[0].striker, 1);
  assert.equal((await ball(u, id, 'home', { bowler: 1, runs: 0 })).status, 409, 'the bowler finishes the over');
  for (let i = 0; i < 4; i++) r = await ball(u, id, 'home', { bowler: 0, runs: 0 });
  assert.equal(r.body.result.cricket.innings[0].legal, 6);
  assert.equal((await ball(u, id, 'home', { bowler: 0, runs: 0 })).status, 409, 'no two overs in a row, and the local limit is one over');
  assert.equal((await ball(u, id, 'away', { bowler: 1, runs: 0 })).status, 409, 'home is still batting');
  for (let o = 1; o < 5; o++) for (let b = 0; b < 6; b++) r = await ball(u, id, 'home', { bowler: o, runs: b === 0 ? 6 : 0 });
  const st = r.body.result.cricket;
  assert.equal(st.innings[0].closed_reason, 'overs'); assert.equal(st.innings[0].runs, 5 + 24);
  assert.equal(r.body.result.home, 29);
  assert.equal((await ball(u, id, 'home', { bowler: 5, runs: 1 })).status, 409);
  // second innings: a chase that is not enough
  for (let o = 0; o < 5; o++) for (let b = 0; b < 6; b++) r = await ball(u, id, 'away', { bowler: o, runs: 0 });
  assert.equal(r.body.result.over, true); assert.equal(r.body.result.winner, 'home');
  assert.equal(r.body.result.cricket.result.kind, 'runs'); assert.equal(r.body.result.cricket.result.margin, 29);
  const undo = await patch(u, id, { void_entry: { reason: 'wrong ball' } });
  assert.equal(undo.body.result.over, false, 'undo reopens the match; the entry is voided, not deleted');
  assert.equal(undo.body.entries.at(-1).voided_at !== null, true);
  assert.equal((await patch(u, id, { manual_totals: { home: 99, away: 0 } })).status, 409, 'a sheet with live entries cannot take typed totals');
  const done = await api('POST', `/tracking/sheets/${id}/complete`, { token: u.token });
  assert.equal(done.status, 200);
  const list = await api('GET', '/tracking/sheets?sport=cricket', { token: u.token });
  assert.equal(list.body[0].score.home, 29);
  const pdf = await api('GET', `/tracking/sheets/${id}/pdf`, { token: u.token });
  assert.equal(pdf.status, 200);
});

test('Test match: four innings, declaration, follow-on rules over the API', async () => {
  const u = await signup();
  const s = await start(u, { sport: 'cricket', variant: 'Test' });
  assert.equal(s.body.template.ruleset.cricket.innings, 4); assert.equal(s.body.template.ruleset.cricket.overs, null);
  const id = s.body.id;
  for (let i = 0; i < 12; i++) await ball(u, id, 'home', { bowler: Math.floor(i / 6) % 2, runs: 6 });
  assert.equal((await patch(u, id, { add_entry: { kind: 'declare', side: 'home' } })).status, 200);
  for (let i = 0; i < 10; i++) await ball(u, id, 'away', { bowler: Math.floor(i / 6) % 2 + 2, runs: 0, wicket: { how: 'lbw' } });
  const fo = await patch(u, id, { add_entry: { kind: 'follow_on', side: 'home' } });
  assert.equal(fo.status, 409, 'a lead of 72 is not enough'); assert.match(fo.body.error.message, /needs 200/);
  const draw = await patch(u, id, { add_entry: { kind: 'result', payload: { outcome: 'draw' } } });
  assert.equal(draw.status, 200); assert.equal(draw.body.result.cricket.result.kind, 'draw');
  assert.equal((await start(u, { sport: 'cricket', variant: 'Test' })).status, 201);
  const o = await start(u, { sport: 'cricket', variant: 'ODI' });
  assert.equal(o.body.template.ruleset.cricket.overs, 50); assert.equal(o.body.template.ruleset.cricket.bowler_max, 10);
  assert.equal((await patch(u, o.body.id, { add_entry: { kind: 'declare', side: 'home' } })).status, 409);
});

test('athletics heat: lanes, reaction and times are ranked and qualified by the rules, local settings included', async () => {
  const u = await signup();
  const lr = await rules(u, 'athletics', { qp: 2, qt: 1 });
  const s = await start(u, { sport: 'athletics', variant: 'Track heat', local_rules_id: lr.body.id });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.equal(s.body.template.layout.mode, 'results'); assert.equal(s.body.template.layout.results.unit, 'time');
  assert.equal(s.body.template.layout.form.title, 'Track heat sheet (Olympic style)');
  const rows = [
    { lane: '1', bib: '101', name: 'Ann', country: 'AAA', reaction: '0.142', result: '10.98' }, { lane: '2', bib: '102', name: 'Bea', country: 'BBB', reaction: '0.085', result: '10.80' },
    { lane: '3', name: 'Cy', result: '11.02' }, { lane: '4', name: 'Di', result: '11.20' }, { lane: '5', name: 'Ed', status: 'DNS' },
  ];
  const r = await patch(u, s.body.id, { rows });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.ranking.rows.map((x) => x.rank), [2, 1, 3, 4, null]);
  assert.deepEqual(r.body.ranking.rows.map((x) => x.q), ['Q', 'Q', 'q', '', ''], 'two by place and one by time, as the local rules say');
  assert.equal(r.body.ranking.warnings.length, 1); assert.match(r.body.ranking.warnings[0].message, /Bea/);
  const field = await start(u, { sport: 'athletics', variant: 'Horizontal jump / throw' });
  assert.equal(field.body.template.layout.results.unit, 'distance');
  const hj = await start(u, { sport: 'athletics', variant: 'High jump / pole vault' });
  assert.equal(hj.body.template.layout.form.title, 'Height ladder (vertical jumps)');
});

test('every first-release sport starts a sport-specific sheet and prints it, with a variant where the sport has formats', async () => {
  const u = await signup();
  const plan = [['football'], ['futsal'], ['cricket', 'T20'], ['cricket', 'ODI'], ['cricket', 'Test'], ['athletics', 'Track heat'], ['table-tennis', 'Singles'], ['hockey'], ['chess', 'Classical'], ['chess', 'Blitz'], ['ice-hockey'], ['baseball'], ['american-football'], ['rugby', 'Union'], ['rugby', 'Sevens'], ['pickleball', 'Doubles'], ['racquetball', 'Singles'], ['squash', 'Singles'], ['boxing', 'Elite'], ['boxing', 'Professional'], ['judo'], ['karate', 'Kumite'], ['karate', 'Kata'], ['weightlifting'], ['badminton', 'Doubles']];
  const titles = new Set();
  for (const [sport, variant] of plan) {
    const s = await start(u, { sport, variant });
    assert.equal(s.status, 201, `${sport} ${variant}: ${JSON.stringify(s.body)}`);
    titles.add(s.body.template.layout.form.title);
    const pdf = await api('GET', `/tracking/sheets/${s.body.id}/pdf`, { token: u.token });
    assert.equal(pdf.status, 200, `${sport} ${variant}`);
  }
  for (const t of ['Match report (FIFA style)', 'Scorebook (T20)', 'Scorebook (ODI)', 'Scorebook (Test)', 'Chess scoresheet (FIDE)', 'Ice hockey game sheet (IIHF style)', 'Judo contest sheet (IJF)', 'Kumite scoresheet (WKF)', 'Kata judging sheet (WKF)', 'Weightlifting competition card (IWF)', 'Rugby sevens match report', 'Baseball scorebook', 'American football game sheet']) assert.ok(titles.has(t), `has ${t}`);
});

test('boxing: the judges\' cards make the decision, a bad round is flagged, local rules set the rounds', async () => {
  const u = await signup();
  const lr = await rules(u, 'boxing', { rounds_elite: 5, judges: 3 }, { format: 'Elite' });
  assert.equal(lr.status, 201, JSON.stringify(lr.body));
  const s = await start(u, { sport: 'boxing', variant: 'Elite', local_rules_id: lr.body.id, labels: { home: 'Red boxer', away: 'Blue boxer' } });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.equal(s.body.template.layout.mode, 'scorecard'); assert.equal(s.body.template.layout.scorecard.rounds, 5); assert.equal(s.body.template.layout.scorecard.judges, 3);
  const round = (red, blue) => ({ red, blue });
  const r = await patch(u, s.body.id, { details: { cards: [
    { judge: 'J1', rounds: [round(10, 9), round(10, 9), round(9, 10), round(10, 9), round(10, 9)] },
    { judge: 'J2', rounds: [round(10, 9), round(10, 9), round(10, 9), round(10, 9), round(10, 9)] },
    { judge: 'J3', rounds: [round(9, 10), round(9, 10), round(10, 9), round(9, 10), round(10, 9)] },
  ] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.scorecard.kind, 'split'); assert.equal(r.body.scorecard.winner, 'red');
  assert.deepEqual(r.body.scorecard.votes, { red: 2, blue: 1, draw: 0 });
  assert.equal(r.body.result.home, 2); assert.equal(r.body.result.away, 1); assert.equal(r.body.result.winner, 'home');
  assert.equal(r.body.scorecard.judges[0].red, 49); assert.equal(r.body.scorecard.judges[0].blue, 46);
  const bad = await patch(u, s.body.id, { details: { cards: [{ judge: 'J1', rounds: [round(9, 9)] }] } });
  assert.equal(bad.body.scorecard.problems.length, 1);
  assert.equal((await patch(u, s.body.id, { details: { cards: [{ judge: 'J1', rounds: [round(11, 9)] }] } })).status, 400, 'points above 10 are refused outright');
  const list = await api('GET', '/tracking/sheets?sport=boxing', { token: u.token });
  assert.deepEqual(list.body[0].score, { home: 0, away: 0 }, 'no round on the card was legal, so no judge has voted');
  await patch(u, s.body.id, { details: { cards: [{ judge: 'J1', rounds: [round(10, 9)] }] } });
  assert.equal((await api('GET', '/tracking/sheets?sport=boxing', { token: u.token })).body[0].score.home, 1);
});

test('weightlifting: attempts become bests, totals and places on the server', async () => {
  const u = await signup();
  const s = await start(u, { sport: 'weightlifting' });
  assert.equal(s.body.template.layout.mode, 'results'); assert.equal(s.body.template.layout.results.unit, 'lift');
  const at = (...a) => a.map(([kg, ok]) => ({ kg, ok }));
  const r = await patch(u, s.body.id, { rows: [
    { name: 'A', body_kg: 80, attempts: at([100, true], [105, false], [105, true], [130, true], [135, false], [135, false]) },
    { name: 'B', body_kg: 79, attempts: at([100, true], [105, true], [110, false], [125, true], [130, true], [135, false]) },
    { name: 'C', body_kg: 90, attempts: at([120, false], [120, false], [120, false], [150, true], [155, true], [160, true]) },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.ranking.rows.map((x) => x.total), [235, 235, null]);
  assert.deepEqual(r.body.ranking.rows.map((x) => x.rank), [2, 1, null]);
  assert.equal(r.body.ranking.rows[2].bust, true);
  assert.equal((await patch(u, s.body.id, { rows: [{ name: 'X', attempts: at([100, true], [100, true], [100, true], [100, true], [100, true], [100, true], [100, true]) }] })).status, 400, 'at most six attempts');
});

test('karate: kumite is scored by the WKF point values; kata is a results table of scores', async () => {
  const u = await signup();
  const k = await start(u, { sport: 'karate', variant: 'Kumite' });
  assert.equal(k.body.template.layout.mode, 'points_events');
  await patch(u, k.body.id, { add_entry: { kind: 'period_start', period: 1 } });
  await patch(u, k.body.id, { add_entry: { kind: 'ippon', side: 'home', period: 1 } });
  const r = await patch(u, k.body.id, { add_entry: { kind: 'waza_ari', side: 'away', period: 1 } });
  assert.equal(r.body.result.home, 3); assert.equal(r.body.result.away, 2);
  const kata = await start(u, { sport: 'karate', variant: 'Kata' });
  assert.equal(kata.body.template.layout.mode, 'results'); assert.equal(kata.body.template.layout.results.unit, 'score');
  const rr = await patch(u, kata.body.id, { rows: [{ name: 'A', result: '24.30' }, { name: 'B', result: '25.10' }] });
  assert.deepEqual(rr.body.ranking.rows.map((x) => x.rank), [2, 1], 'higher score wins');
});

test('judo and chess keep who won, how and the record beside manual totals', async () => {
  const u = await signup();
  const j = await start(u, { sport: 'judo', labels: { home: 'White', away: 'Blue' } });
  assert.equal(j.body.template.layout.mode, 'manual');
  const r = await patch(u, j.body.id, { manual_totals: { home: 1, away: 0 }, details: { contest: { winner: 'home', method: 'ippon' }, tally: { home_ippon: 1, away_shido: 2 } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.details.contest.method, 'ippon'); assert.equal(r.body.details.tally.away_shido, 2); assert.equal(r.body.result.winner, 'home');
  const c = await start(u, { sport: 'chess', variant: 'Classical' });
  const m = await patch(u, c.body.id, { details: { moves: [['e4', 'e5'], ['Nf3', 'Nc6'], ['Bb5', '']] }, manual_totals: { home: 0, away: 0 } });
  assert.equal(m.body.details.moves.length, 3);
  assert.equal((await patch(u, c.body.id, { details: { moves: Array.from({ length: 201 }, () => ['a', 'b']) } })).status, 400);
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const clamd = (reply) => new Promise((resolve) => {
  const srv = net.createServer((sock) => { let got = Buffer.alloc(0); sock.on('data', (d) => { got = Buffer.concat([got, d]); if (got.subarray(-4).equals(Buffer.alloc(4))) sock.end(`${reply}\0`); }); }).listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, close: () => srv.close() }));
});
const uploadPng = async (u, query, bytes) => {
  const r = await fetch(`${base}/api/v1/tracking/imports?${query}`, { method: 'POST', headers: { authorization: `Bearer ${u.token}` }, body: bytes });
  return { status: r.status, body: await r.json() };
};

test('uploads are virus scanned when a scanner is configured: infected is refused, a missing scanner refuses only when required', async () => {
  const u = await signup();
  const keep = { ...process.env };
  try {
    const bad = await clamd('stream: Eicar-Test-Signature FOUND');
    Object.assign(process.env, { CLAMD_HOST: '127.0.0.1', CLAMD_PORT: String(bad.port) }); delete process.env.UPLOAD_SCAN;
    const infected = await uploadPng(u, 'sport=football', PNG);
    assert.equal(infected.status, 422); assert.equal(infected.body.error.code, 'malware_detected');
    bad.close();
    process.env.CLAMD_PORT = '1'; // nothing listening
    process.env.UPLOAD_SCAN = 'required';
    const down = await uploadPng(u, 'sport=football', PNG);
    assert.equal(down.status, 503); assert.equal(down.body.error.code, 'scanner_unavailable');
    process.env.UPLOAD_SCAN = 'optional';
    const optional = await uploadPng(u, 'sport=football', PNG);
    assert.equal(optional.status, 201, JSON.stringify(optional.body));
    const rows = (await pool.query('SELECT scan_status FROM tracking_sheet_imports ORDER BY created_at DESC LIMIT 1')).rows;
    assert.equal(rows[0].scan_status, 'unavailable', 'the upload was accepted but is marked as not scanned');
    const ok = await clamd('stream: OK');
    Object.assign(process.env, { CLAMD_PORT: String(ok.port), UPLOAD_SCAN: 'required' });
    const other = await uploadPng(u, 'sport=badminton', Buffer.concat([PNG, Buffer.from('x')]));
    assert.equal(other.status, 201, JSON.stringify(other.body));
    assert.equal((await pool.query('SELECT scan_status FROM tracking_sheet_imports ORDER BY created_at DESC LIMIT 1')).rows[0].scan_status, 'clean');
    ok.close();
  } finally { for (const k of ['CLAMD_HOST', 'CLAMD_PORT', 'UPLOAD_SCAN']) { if (k in keep) process.env[k] = keep[k]; else delete process.env[k]; } }
});

test('templates can be shared with a team or an event: structure only, authority checked', async () => {
  const owner = await signup(['organizer']), member = await signup(['athlete']), outsider = await signup(['athlete']), coach = await signup(['coach']);
  const team = (await api('POST', '/teams', { token: owner.token, body: { name: `Shared ${++n}`, sport: 'football' } })).body;
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active'),($1,$3,'coach','active') ON CONFLICT DO NOTHING", [team.id, member.id, coach.id]);
  const mk = (u, body) => api('POST', '/tracking/templates', { token: u.token, body: { name: 'Match day', sport: 'football', customise: { notes_fields: ['Weather'] }, ...body } });
  assert.equal((await mk(member, { scope: 'team', team_id: team.id })).status, 403, 'a player cannot publish the team\'s templates');
  assert.equal((await mk(outsider, { scope: 'team', team_id: team.id })).status, 403);
  const t = await mk(coach, { scope: 'team', team_id: team.id });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  assert.equal((await api('POST', `/tracking/templates/${t.body.id}/publish`, { token: coach.token })).status, 200);
  const seen = await api('GET', '/tracking/templates?sport=football', { token: member.token });
  assert.deepEqual(seen.body.templates.map((x) => x.name), ['Match day'], 'a team member sees the shared template');
  assert.equal((await api('GET', '/tracking/templates?sport=football', { token: outsider.token })).body.templates.length, 0);
  const used = await start(member, { sport: 'football', template_id: t.body.id });
  assert.equal(used.status, 201, JSON.stringify(used.body));
  assert.deepEqual(used.body.template.layout.notes_fields.map((x) => x.label), ['Weather']);
  assert.equal(used.body.owner_id, member.id, 'the sheet belongs to the member; only the structure was shared');
  assert.equal((await start(outsider, { sport: 'football', template_id: t.body.id })).status, 404);

  const { rows: [sport] } = await pool.query("SELECT id FROM sports WHERE slug='football'");
  const ev = (await pool.query("INSERT INTO events(name, sport_id, organizer_id, status) VALUES ('Template Cup', $1, $2, 'open') RETURNING id", [sport.id, owner.id])).rows[0];
  assert.equal((await mk(outsider, { scope: 'event', event_id: ev.id })).status, 403, 'only the organiser');
  const et = await mk(owner, { scope: 'event', event_id: ev.id });
  assert.equal(et.status, 201, JSON.stringify(et.body));
  await api('POST', `/tracking/templates/${et.body.id}/publish`, { token: owner.token });
  assert.equal((await api('GET', `/tracking/templates?sport=football&event_id=${ev.id}`, { token: outsider.token })).body.templates.some((x) => x.scope === 'event'), true, 'visible for a public event');
  assert.equal((await api('GET', '/tracking/templates?sport=football', { token: outsider.token })).body.templates.some((x) => x.scope === 'event'), false, 'not offered outside the event');
  assert.equal((await start(owner, { sport: 'football', template_id: et.body.id })).status, 409, 'an event template is for that event\'s games');
});
