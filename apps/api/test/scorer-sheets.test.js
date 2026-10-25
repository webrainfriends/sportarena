import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { rankRows, parseMark } = await import('../src/tracking/logic.js');

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
