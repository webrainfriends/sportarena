import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cricketRuleset } from '../src/scoring/rulesets.js';
import { cricketReject, cricketState, oversText } from '../src/scoring/cricket.js';
import { computeScore, rejectReason } from '../src/scoring/engine.js';

/** A tiny scorer: keeps the log, refuses what the engine refuses, like the capability does. */
const book = (rs, first = 'home') => {
  const log = [];
  const add = (kind, side, payload = {}, period) => {
    const e = { kind, side, payload, period, seq: log.length + 1 };
    const why = rejectReason(rs, log, e);
    if (why) throw new Error(why);
    log.push(e);
    return e;
  };
  const ball = (bowler, runs = 0, o = {}) => add('ball', o.side ?? cur(), { bowler, runs, ...o.extra }, o.period);
  let side = first;
  const cur = () => (log.length ? [...log].reverse().find((e) => e.kind === 'ball').side : side);
  return { log, add, ball, state: () => cricketState(rs, log), setSide: (s) => { side = s; } };
};
const over = (b, bowler, runsPerBall = [0, 0, 0, 0, 0, 0], side) => runsPerBall.forEach((r) => b.ball(bowler, r, { side }));

test('runs, strike, extras and a no-ball free hit are worked out from the log', () => {
  const b = book(cricketRuleset('T20'));
  b.ball(0, 4); b.ball(0, 1);                            // striker 0 hits four, then a single: batter 1 on strike
  b.ball(0, 0, { extra: { extra: 'wd', extra_runs: 0 } }); // wide: a run, not a legal ball
  b.ball(0, 2, { extra: { extra: 'nb' } });               // no-ball with 2 off the bat: 3 runs, free hit next
  assert.equal(b.state().innings[0].free_hit, true);
  assert.throws(() => b.ball(0, 0, { extra: { wicket: { how: 'bowled' } } }), /free hit/);
  b.ball(0, 0, { extra: { wicket: { how: 'run_out', out: 'striker' } } });
  b.ball(0, 1, { extra: { extra: 'b', extra_runs: 1, runs: 0 } });
  const st = b.state(), inn = st.innings[0];
  assert.equal(inn.runs, 4 + 1 + 1 + 3 + 0 + 1);
  assert.equal(inn.legal, 4, 'wide and no-ball are not legal balls');
  assert.deepEqual(inn.extras, { wd: 1, nb: 1, b: 1, lb: 0, pen: 0 });
  assert.equal(inn.batters[0].runs, 5); assert.equal(inn.batters[0].fours, 1);
  assert.equal(inn.batters[1].runs, 2, 'the no-ball runs are the batter\'s; the penalty run is an extra');
  assert.equal(inn.batters[1].out.how, 'run_out'); assert.equal(inn.fow[0].runs, 9);
});

test('over rotation, maidens, bowler limits and the over cap', () => {
  const b = book(cricketRuleset('T20'));
  over(b, 0);                                            // maiden
  assert.throws(() => b.ball(0, 1), /two overs in a row/);
  over(b, 1, [1, 0, 0, 0, 0, 0]);
  over(b, 0); over(b, 1); over(b, 0); over(b, 1); over(b, 0); over(b, 1);
  assert.throws(() => b.ball(0, 0), /maximum of 4 overs/, 'T20 bowler limit is four overs');
  const st = b.state();
  assert.equal(oversText(st.innings[0].legal), '8');
  assert.equal(st.innings[0].bowlers[0].wickets, 0);
  // a bowler cannot be swapped mid-over unless injured
  const c = book(cricketRuleset('T20'));
  c.ball(0, 1); c.ball(0, 1);
  assert.throws(() => c.ball(1, 0), /finish the over/);
  c.ball(1, 0, { extra: { bowler_change: true } });
  // an innings ends at the over cap
  const d = book(cricketRuleset('T10'));
  for (let o = 0; o < 10; o++) over(d, o % 5 + (o % 2 ? 5 : 0), [1, 0, 0, 0, 0, 0]);
  const dst = d.state();
  assert.equal(dst.innings[0].closed_reason, 'overs');
  assert.equal(dst.innings[0].runs, 10);
  assert.throws(() => d.ball(2, 0, { side: 'home' }), /turn to bat/, 'after the innings the other side bats');
});

test('limited overs: chase to a win by wickets, a win by runs, a tie, and ten wickets', () => {
  const rs = cricketRuleset('T10');
  const chase = book(rs);
  over(chase, 0, [6, 6, 6, 6, 6, 6]); over(chase, 1, [4, 4, 4, 4, 4, 4]);   // home 60
  chase.add('innings_end', 'home');
  chase.ball(5, 6, { side: 'away' }); chase.ball(5, 6, { side: 'away' }); chase.ball(5, 6, { side: 'away' }); chase.ball(5, 6, { side: 'away' }); chase.ball(5, 6, { side: 'away' }); chase.ball(5, 6, { side: 'away' });
  chase.ball(6, 6, { side: 'away' }); chase.ball(6, 6, { side: 'away' }); chase.ball(6, 6, { side: 'away' }); chase.ball(6, 6, { side: 'away' });
  assert.equal(chase.state().over, false, '60 level is not enough');
  chase.ball(6, 1, { side: 'away' });
  const st = chase.state();
  assert.equal(st.over, true);
  assert.equal(st.result.kind, 'wickets');
  assert.equal(st.winner, 'away');
  assert.equal(st.result.margin, 10);
  assert.equal(st.innings[1].closed_reason, 'target');
  assert.throws(() => chase.ball(7, 1, { side: 'away' }), /already decided/);
  const sc = computeScore(rs, chase.log);
  assert.equal(sc.winner, 'away'); assert.ok(sc.home === 60 && sc.away > 60);

  const runs = book(rs);
  over(runs, 0, [1, 1, 1, 1, 1, 1]); runs.add('innings_end', 'home');
  over(runs, 5, [0, 0, 0, 0, 0, 0], 'away'); over(runs, 6, [1, 0, 0, 0, 0, 0], 'away'); over(runs, 5, [0, 0, 0, 0, 0, 0], 'away'); over(runs, 6, [0, 0, 0, 0, 0, 0], 'away');
  assert.equal(runs.state().to_win, 6, 'home made 6, away has 1: six more to win');
  for (const bwl of [7, 8, 7, 8, 9, 10]) over(runs, bwl, [0, 0, 0, 0, 0, 0], 'away');
  const rst = runs.state();
  assert.equal(rst.result.kind, 'runs'); assert.equal(rst.winner, 'home'); assert.equal(rst.result.margin, 6 - 1, 'won by five runs');

  const tie = book(rs);
  over(tie, 0, [1, 0, 0, 0, 0, 0]); tie.add('innings_end', 'home');
  tie.ball(5, 1, { side: 'away' }); tie.add('innings_end', 'away');
  assert.equal(tie.state().result.kind, 'tie'); assert.equal(tie.state().winner, null);

  const allOut = book(rs);
  for (let w = 0; w < 10; w++) allOut.ball(Math.floor(w / 6) % 2 + 4, 0, { extra: { wicket: { how: 'bowled' } } });
  const ao = allOut.state().innings[0];
  assert.equal(ao.wickets, 10); assert.equal(ao.closed_reason, 'all_out');
  assert.equal(ao.fow.length, 10);
  assert.equal(ao.batters.filter((x) => x.out).length, 10);
});

test('wickets: who is out, bowler credit, run out of the non-striker and delivery limits', () => {
  const b = book(cricketRuleset('ODI'));
  b.ball(0, 0, { extra: { wicket: { how: 'caught', fielder: 'A. Fielder' } } });    // striker 0 out, batter 2 in
  let inn = b.state().innings[0];
  assert.equal(inn.striker, 2); assert.equal(inn.non_striker, 1);
  assert.equal(inn.bowlers[0].wickets, 1);
  b.ball(0, 1, { extra: { wicket: { how: 'run_out', out: 'non_striker' } } });      // 1 run, ends swap, then non-striker (now batter 2... ) is out
  inn = b.state().innings[0];
  assert.equal(inn.wickets, 2); assert.equal(inn.bowlers[0].wickets, 1, 'a run out is not the bowler\'s wicket');
  assert.throws(() => b.ball(0, 0, { extra: { wicket: { how: 'bowled', out: 'non_striker' } } }), /non-striker/);
  assert.throws(() => b.ball(0, 0, { extra: { extra: 'wd', wicket: { how: 'caught' } } }), /wide/);
  assert.throws(() => b.ball(0, 9), /0 to 7/);
  assert.throws(() => b.ball(11, 0), /bowler/);
  assert.throws(() => b.ball(0, 0, { extra: { extra: 'lb', extra_runs: 0 } }), /number of runs/);
  assert.throws(() => b.ball(0, 0, { extra: { wicket: { how: 'magic' } } }), /way out/);
  assert.equal(cricketReject(cricketRuleset('ODI'), [], { kind: 'declare', side: 'home' }), 'A captain can only declare in a Test match');
});

test('Test match: four innings, follow-on, declaration, innings win and a draw', () => {
  const rs = cricketRuleset('Test');
  assert.equal(rs.cricket.overs, null); assert.equal(rs.cricket.follow_on, 200);
  const t = book(rs);
  // innings 1: home bats and declares on 300
  const bw = (n, a = 1) => Math.floor(n / 6) % 2 + a; // the bowler changes every six balls
  for (let i = 0; i < 50; i++) t.ball(bw(i), 6, { side: 'home' }); // 300
  assert.throws(() => t.add('follow_on', 'home'), /second innings has ended/);
  t.add('declare', 'home', { }); 
  assert.equal(t.state().innings[0].closed_reason, 'declared');
  // innings 2: away is bowled out cheaply
  for (let w = 0; w < 10; w++) t.ball(bw(w, 3), 0, { side: 'away', extra: { wicket: { how: 'lbw' } } });
  assert.equal(t.state().lead, 300);
  t.add('follow_on', 'home');
  assert.throws(() => t.add('follow_on', 'home'), /already been enforced/);
  // away bat again (innings 3), home cannot
  assert.throws(() => t.ball(1, 1, { side: 'home' }), /Away's turn to bat/);
  t.ball(bw(0), 1, { side: 'away' });
  assert.equal(t.state().current.n, 3); assert.equal(t.state().current.side, 'away');
  for (let w = 1; w < 11; w++) t.ball(bw(w), 0, { side: 'away', extra: { wicket: { how: 'bowled' } } });
  const st = t.state();
  assert.equal(st.result.kind, 'innings');
  assert.equal(st.winner, 'home');
  assert.match(st.result.text, /an innings and/);
  assert.equal(st.innings.length, 3);

  const d = book(rs);
  for (let i = 0; i < 5; i++) d.ball(1, 4, { side: 'home' });
  d.add('declare', 'home');
  d.add('result', 'home', { outcome: 'draw' });
  assert.equal(d.state().result.kind, 'draw'); assert.equal(d.state().winner, null);
  assert.throws(() => d.ball(1, 1, { side: 'away' }), /already decided/);

  // no follow-on when the lead is too small
  const s = book(rs);
  for (let i = 0; i < 10; i++) s.ball(bw(i), 6, { side: 'home' }); s.add('declare', 'home');
  for (let w = 0; w < 10; w++) s.ball(bw(w), w ? 0 : 7, { side: 'away', extra: { wicket: { how: 'bowled' } } });
  assert.match(cricketReject(rs, s.log, { kind: 'follow_on', side: 'home' }) ?? '', /needs 200/);
});

test('voided entries are ignored and the engine never trusts the payload for a total', () => {
  const rs = cricketRuleset('T20');
  const b = book(rs);
  b.ball(0, 6); b.ball(0, 4);
  b.log[1].voided_at = '2026-01-01';
  assert.equal(computeScore(rs, b.log).home, 6);
  assert.equal(cricketState(rs, b.log).innings[0].batters[0].fours, 0);
});

test('an over under way belongs to its bowler even when it started with a wide; a Test stopped by time is a draw; one fifth of the overs rounds up', () => {
  const b = book(cricketRuleset('T20'));
  b.ball(0, 0, { extra: { extra: 'wd', extra_runs: 0 } });         // the over opens with a wide: bowler 0 is on
  assert.throws(() => b.ball(1, 1), /finish the over/);
  b.ball(0, 1, { extra: { bowler_change: true } });                 // unless he is hurt
  assert.equal(cricketRuleset('T20', { ov_t20: 12 }).cricket.bowler_max, 3, '12 overs: a bowler may bowl 3, not 2');
  assert.equal(cricketRuleset('T20', { ov_t20: 18 }).cricket.bowler_max, 4);
  assert.equal(cricketRuleset('T10').cricket.bowler_max, 2);

  const rs = cricketRuleset('Test');
  const t = book(rs);
  const bw = (n, a = 1) => Math.floor(n / 6) % 2 + a;
  for (let i = 0; i < 60; i++) t.ball(bw(i), 6, { side: 'home' }); t.add('declare', 'home');                          // home 360
  for (let w = 0; w < 10; w++) t.ball(bw(w, 3), 0, { side: 'away', extra: { wicket: { how: 'bowled' } } });          // away 0 all out
  t.add('follow_on', 'home', {}); 
  const x = book(rs);
  for (let i = 0; i < 12; i++) x.ball(bw(i), 6, { side: 'home' }); x.add('declare', 'home');                          // home 72
  for (let i = 0; i < 12; i++) x.ball(bw(i, 3), 6, { side: 'away' }); x.add('declare', 'away');                       // away 72 and declares level
  for (let i = 0; i < 6; i++) x.ball(bw(i, 5), 1, { side: 'home' });                                                  // home bats again on 78
  x.add('innings_end', 'home');                                                                                       // ... and the light fails
  for (let i = 0; i < 2; i++) x.ball(bw(i, 7), 1, { side: 'away' });                                                  // away 2 more
  x.add('innings_end', 'away');                                                                                       // time: away are still batting and behind
  const st = x.state();
  assert.equal(st.innings.length, 4);
  assert.equal(st.result.kind, 'draw', 'not a win for the side that was bowling when time ran out');
  assert.equal(st.winner, null);
});
