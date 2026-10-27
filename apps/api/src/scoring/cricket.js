// Cricket scoring (T10 / T20 / ODI / Test): everything a scorer's book shows, worked out from the ball-by-ball log. Pure functions, no
// database and no clock. The log is the only source of truth: strike, batting cards, bowling figures, extras, fall of wickets, the over
// grid and the result are all derived here, so a client never sends (or can fake) a total.
//
// Entry kinds (tracking_sheet_entries): `side` is the BATTING side for every cricket entry.
//   ball       payload { bowler 0-10, runs 0-7 off the bat, extra: wd|nb|b|lb|pen|null, extra_runs 0-7, wicket?:{how, out:'striker'|'non_striker', fielder?}, bowler_change? }
//              period = innings number. Batters are numbered 0-10 by batting order; the next batter in is always the next number.
//   declare    the batting captain declares (Test only)         innings_end  an innings ends for another reason (light, time)
//   follow_on  the side that led by enough enforces the follow-on (Test only)
//   result     payload { outcome: draw|abandoned|no_result|tie }
//   lineup     payload { home?: [playerId ×≤11], away?: [...] } the batting order, so slots 0-10 map to verified players (no effect on the score)

export const CRICKET_KINDS = ['ball', 'declare', 'innings_end', 'follow_on', 'result', 'lineup'];
export const HOW_OUT = ['bowled', 'caught', 'lbw', 'run_out', 'stumped', 'hit_wicket', 'handled_ball', 'obstructing', 'hit_twice', 'timed_out', 'retired_out'];
const BOWLER_CREDIT = new Set(['bowled', 'caught', 'lbw', 'stumped', 'hit_wicket']);
const FREE_HIT_OUT = new Set(['run_out', 'obstructing', 'hit_twice', 'handled_ball']);
const WIDE_OUT = new Set(['stumped', 'run_out', 'hit_wicket', 'obstructing']);
const NOBALL_OUT = FREE_HIT_OUT;
const OUTCOMES = ['draw', 'abandoned', 'no_result', 'tie'];
const other = (s) => (s === 'home' ? 'away' : 'home');
export const oversText = (legal) => `${Math.floor(legal / 6)}${legal % 6 ? `.${legal % 6}` : ''}`;

const newInnings = (n, side) => ({
  n, side, runs: 0, wickets: 0, legal: 0, extras: { wd: 0, nb: 0, b: 0, lb: 0, pen: 0 },
  batters: Array.from({ length: 11 }, (_, idx) => ({ idx, runs: 0, balls: 0, fours: 0, sixes: 0, out: null, arrived: idx < 2 })),
  bowlers: {}, fow: [], overs: [], striker: 0, non_striker: 1, next_batter: 2,
  closed: false, closed_reason: null, free_hit: false, over_bowler: null, prev_over_bowler: null,
  partnerships: [], partnership: { runs: 0, balls: 0, a: 0, b: 1 },
});

const symbol = (e, p) => {
  const w = p.wicket ? 'W' : '';
  if (p.extra === 'wd') return `Wd${p.extra_runs ? `+${p.extra_runs}` : ''}${w}`;
  if (p.extra === 'nb') return `Nb${p.runs || p.extra_runs ? `+${(p.runs ?? 0) + (p.extra_runs ?? 0)}` : ''}${w}`;
  if (p.extra === 'b') return `B${p.extra_runs}${w}`;
  if (p.extra === 'lb') return `Lb${p.extra_runs}${w}`;
  if (p.extra === 'pen') return `P${p.extra_runs}`;
  if (p.wicket) return p.runs ? `${p.runs}W` : 'W';
  return p.runs ? String(p.runs) : '•';
};

function applyBall(inn, e, c) {
  const p = { runs: 0, extra: null, extra_runs: 0, ...(e.payload ?? {}) };
  const legalBefore = inn.legal, ovIdx = Math.floor(legalBefore / 6);
  const bw = (inn.bowlers[p.bowler] ??= { idx: p.bowler, legal: 0, runs: 0, wickets: 0, wd: 0, nb: 0, by_over: {} });
  const bo = (bw.by_over[ovIdx] ??= { legal: 0, runs: 0 });
  const striker = inn.batters[inn.striker];
  const legal = p.extra !== 'wd' && p.extra !== 'nb' && p.extra !== 'pen';
  let team = 0, running = 0;
  if (p.extra === 'pen') { team = p.extra_runs; inn.extras.pen += team; }
  else if (p.extra === 'wd') { team = (c.wide_runs ?? 1) + p.extra_runs; inn.extras.wd += team; bw.wd += team; bw.runs += team; bo.runs += team; running = p.extra_runs; }
  else if (p.extra === 'nb') {
    const pen = c.noball_runs ?? 1;
    team = pen + p.runs + p.extra_runs; inn.extras.nb += pen; bw.nb += pen; bw.runs += pen + p.runs; bo.runs += pen + p.runs;
    striker.runs += p.runs; striker.balls++; if (p.runs === 4) striker.fours++; if (p.runs === 6) striker.sixes++;
    running = p.runs + p.extra_runs; inn.extras.b += p.extra_runs; // byes run off a no-ball are kept with the extras
  } else if (p.extra === 'b' || p.extra === 'lb') {
    team = p.extra_runs; inn.extras[p.extra] += team; striker.balls++; running = team;
  } else {
    team = p.runs; striker.runs += p.runs; striker.balls++; if (p.runs === 4) striker.fours++; if (p.runs === 6) striker.sixes++; bw.runs += p.runs; bo.runs += p.runs; running = p.runs;
  }
  inn.runs += team;
  inn.partnership.runs += team;
  if (legal) { inn.legal++; bw.legal++; bo.legal++; inn.partnership.balls++; }
  const ov = (inn.overs[ovIdx] ??= []);
  ov.push({ sym: symbol(e, p), bowler: p.bowler, wicket: !!p.wicket, four: p.extra == null && p.runs === 4, six: p.extra == null && p.runs === 6, extra: p.extra, free_hit: inn.free_hit });
  if (running % 2) [inn.striker, inn.non_striker] = [inn.non_striker, inn.striker];
  if (p.wicket) {
    const outPos = p.wicket.out === 'non_striker' ? 'non_striker' : 'striker';
    const outIdx = inn[outPos], b = inn.batters[outIdx];
    b.out = { how: p.wicket.how, bowler: BOWLER_CREDIT.has(p.wicket.how) ? p.bowler : null, fielder: p.wicket.fielder ?? null };
    inn.wickets++; if (BOWLER_CREDIT.has(p.wicket.how)) bw.wickets++;
    inn.fow.push({ n: inn.wickets, runs: inn.runs, batter: outIdx, over: oversText(inn.legal) });
    const partner = outPos === 'striker' ? inn.non_striker : inn.striker;
    inn.partnerships.push({ wicket: inn.wickets, runs: inn.partnership.runs, balls: inn.partnership.balls, batters: [outIdx, partner], ended: true });
    if (inn.next_batter < 11 && inn.wickets < 10) { inn[outPos] = inn.next_batter; inn.batters[inn.next_batter].arrived = true; inn.next_batter++; }
    inn.partnership = { runs: 0, balls: 0, a: inn.striker, b: inn.non_striker };
  }
  if (legal) { inn.free_hit = false; if (inn.legal % 6 === 0) { [inn.striker, inn.non_striker] = [inn.non_striker, inn.striker]; inn.prev_over_bowler = p.bowler; inn.over_bowler = null; } else inn.over_bowler = p.bowler; }
  else if (p.extra === 'nb') { inn.free_hit = c.free_hit !== false && c.format !== 'Test'; inn.over_bowler = p.bowler; }
  else if (p.extra === 'wd') inn.over_bowler = p.bowler;
}

/** The side that bats innings n, given who batted first and whether the follow-on was enforced. */
export function sideForInnings(n, first, followOn) {
  if (n === 1) return first;
  if (n === 2) return other(first);
  if (n === 3) return followOn ? other(first) : first;
  return followOn ? first : other(first);
}

const totalFor = (st, side) => st.innings.filter((i) => i.side === side).reduce((a, i) => a + i.runs, 0);
const wicketsFor = (st, side) => st.innings.filter((i) => i.side === side).reduce((a, i) => a + i.wickets, 0);

function decide(rs, st) {
  const c = rs.cricket;
  const [a, b] = [st.first_side, other(st.first_side)];
  if (!a) return null;
  if (st.outcome) return { kind: st.outcome, winner: null, margin: null, text: { draw: 'Match drawn', abandoned: 'Match abandoned', no_result: 'No result', tie: 'Match tied' }[st.outcome] };
  const last = st.innings[st.innings.length - 1];
  const name = (s) => (s === 'home' ? 'Home' : 'Away');
  if (st.innings.length === c.innings && last.closed) {
    const ta = totalFor(st, a), tb = totalFor(st, b);
    if (ta === tb) return { kind: 'tie', winner: null, margin: null, text: 'Match tied' };
    // a Test that stops for time or light with the last side still batting and behind is a draw, not a win for the other side
    if (c.format === 'Test' && last.closed_reason !== 'all_out' && last.closed_reason !== 'target') return { kind: 'draw', winner: null, margin: null, text: 'Match drawn' };
    const winner = ta > tb ? a : b;
    if (last.side === winner) return { kind: 'wickets', winner, margin: 10 - last.wickets, text: `${name(winner)} won by ${10 - last.wickets} wicket${10 - last.wickets === 1 ? '' : 's'}` };
    return { kind: 'runs', winner, margin: Math.abs(ta - tb), text: `${name(winner)} won by ${Math.abs(ta - tb)} run${Math.abs(ta - tb) === 1 ? '' : 's'}` };
  }
  // Test: a side that followed on and is bowled out (or declares) still behind the other's one innings has lost by an innings
  if (c.format === 'Test' && st.follow_on && st.innings.length === 3 && last.closed) {
    const lose = last.side, win = other(lose), gap = totalFor(st, win) - totalFor(st, lose);
    if (gap > 0) return { kind: 'innings', winner: win, margin: gap, text: `${name(win)} won by an innings and ${gap} run${gap === 1 ? '' : 's'}` };
  }
  return null;
}

/** Everything the scorer's book shows. `events` are the sheet's live entries in order (voided ones already removed). */
export function cricketState(rs, events) {
  const c = rs.cricket;
  const st = { innings: [], follow_on: false, outcome: null, first_side: null, lineup: null };
  let cur = null;
  for (const e of events.filter((x) => !x.voided_at)) {
    if (e.kind === 'lineup') { st.lineup = { ...(st.lineup ?? {}), ...Object.fromEntries(['home', 'away'].filter((side) => Array.isArray(e.payload?.[side])).map((side) => [side, e.payload[side]])) }; continue; }
    if (e.kind === 'follow_on') { st.follow_on = true; continue; }
    if (e.kind === 'result') { st.outcome = e.payload?.outcome ?? null; continue; }
    if (e.kind === 'declare' || e.kind === 'innings_end') { if (cur && !cur.closed) { cur.closed = true; cur.closed_reason = e.kind === 'declare' ? 'declared' : 'ended'; } continue; }
    if (e.kind !== 'ball') continue;
    if (!cur || cur.closed) {
      st.first_side ??= e.side;
      cur = newInnings(st.innings.length + 1, sideForInnings(st.innings.length + 1, st.first_side, st.follow_on));
      st.innings.push(cur);
    }
    applyBall(cur, e, c);
    if (cur.wickets >= 10) { cur.closed = true; cur.closed_reason = 'all_out'; }
    else if (c.overs && cur.legal >= c.overs * 6) { cur.closed = true; cur.closed_reason = 'overs'; }
    else if (st.innings.length === c.innings) {
      const target = totalFor(st, other(cur.side));
      if (totalFor(st, cur.side) > target) { cur.closed = true; cur.closed_reason = 'target'; }
    }
  }
  const home = totalFor(st, 'home'), away = totalFor(st, 'away');
  const result = decide(rs, st);
  const open = st.innings[st.innings.length - 1];
  const need = open && !open.closed && st.innings.length === c.innings ? totalFor(st, other(open.side)) - totalFor(st, open.side) + 1 : null;
  const ballsLeft = open && !open.closed && c.overs ? c.overs * 6 - open.legal : null;
  const rate = (runs, balls) => (balls > 0 ? Math.round((runs * 6 / balls) * 100) / 100 : null);
  for (const i of st.innings) {
    i.run_rate = rate(i.runs, i.legal);
    i.current_partnership = i.closed ? null : { ...i.partnership, batters: [i.partnership.a, i.partnership.b] };
    i.powerplay = !i.closed && (c.powerplays ?? []).some((w) => Math.floor(i.legal / 6) >= w.from_over && Math.floor(i.legal / 6) <= w.to_over);
  }
  const chasing = open && !open.closed && need != null && need > 0 && st.innings.length === c.innings;
  return {
    ...st, home, away, wickets: { home: wicketsFor(st, 'home'), away: wicketsFor(st, 'away') }, result,
    over: !!result, winner: result?.winner ?? null,
    current: open ? { n: open.n, side: open.side, closed: open.closed } : { n: 0, side: null, closed: true },
    to_win: need && need > 0 ? need : null,
    balls_left: ballsLeft,
    target: chasing ? totalFor(st, other(open.side)) + 1 : null,
    current_run_rate: open ? open.run_rate : null,
    required_run_rate: chasing && ballsLeft > 0 ? rate(need, ballsLeft) : null,
    lead: st.innings.length >= 2 && c.format === 'Test' ? totalFor(st, st.first_side) - totalFor(st, other(st.first_side)) : null,
  };
}

/** Why an entry cannot be added now, or null. */
export function cricketReject(rs, live, next) {
  const c = rs.cricket;
  if (next.kind === 'note' || next.kind === 'period_start' || next.kind === 'period_end') return null; // the match log's period markers carry no cricket meaning
  if (!CRICKET_KINDS.includes(next.kind)) return `"${next.kind}" is not part of cricket scoring`;
  const st = cricketState(rs, live);
  const p = next.payload ?? {};
  if (next.kind === 'result') return OUTCOMES.includes(p.outcome) ? null : `outcome must be one of ${OUTCOMES.join(', ')}`;
  if (next.kind === 'lineup') {
    const bad = ['home', 'away'].find((side) => p[side] != null && !(Array.isArray(p[side]) && p[side].length <= 11 && new Set(p[side]).size === p[side].length && p[side].every((x) => typeof x === 'string' && x)));
    return bad ? `The ${bad} batting order must be up to 11 different players` : null;
  }
  if (st.over) return 'The match is already decided';
  const cur = st.innings[st.innings.length - 1];
  if (next.kind === 'declare') {
    if (c.format !== 'Test') return 'A captain can only declare in a Test match';
    return cur && !cur.closed ? null : 'There is no innings in progress to declare';
  }
  if (next.kind === 'innings_end') return cur && !cur.closed ? null : 'There is no innings in progress';
  if (next.kind === 'follow_on') {
    if (c.format !== 'Test' || !c.follow_on) return 'The follow-on only applies in Test matches';
    if (st.follow_on) return 'The follow-on has already been enforced';
    if (st.innings.length !== 2 || !st.innings[1].closed) return 'The follow-on can be enforced once the second innings has ended';
    const lead = totalFor(st, st.first_side) - totalFor(st, other(st.first_side));
    return lead >= c.follow_on ? null : `The lead is ${lead} runs; the follow-on needs ${c.follow_on}`;
  }
  // ball
  if (!['home', 'away'].includes(next.side)) return 'side must be the batting side (home or away)';
  const n = cur && !cur.closed ? cur.n : st.innings.length + 1;
  if (n > c.innings) return 'All innings are complete';
  const expected = cur && !cur.closed ? cur.side : n === 1 ? next.side : sideForInnings(n, st.first_side ?? next.side, st.follow_on);
  if (next.side !== expected) return `It is ${expected === 'home' ? 'Home' : 'Away'}'s turn to bat in innings ${n}`;
  if (next.period != null && next.period !== n) return `This is innings ${n}`;
  const inn = cur && !cur.closed ? cur : null;
  const bowler = p.bowler;
  if (!Number.isInteger(bowler) || bowler < 0 || bowler > 10) return 'Pick the bowler (1 to 11)';
  if (!Number.isInteger(p.runs ?? 0) || (p.runs ?? 0) < 0 || (p.runs ?? 0) > 7) return 'Runs off the bat must be 0 to 7';
  if (p.extra != null && !['wd', 'nb', 'b', 'lb', 'pen'].includes(p.extra)) return 'extra must be wd, nb, b, lb or pen';
  if (!Number.isInteger(p.extra_runs ?? 0) || (p.extra_runs ?? 0) < 0 || (p.extra_runs ?? 0) > 7) return 'Extra runs must be 0 to 7';
  if ((p.extra === 'wd' || p.extra === 'b' || p.extra === 'lb' || p.extra === 'pen') && (p.runs ?? 0) !== 0) return 'Only a no-ball or a ball in play scores runs off the bat';
  if ((p.extra === 'b' || p.extra === 'lb' || p.extra === 'pen') && !(p.extra_runs >= 1)) return 'Give the number of runs';
  if (p.extra === 'pen' && p.wicket) return 'A penalty entry cannot take a wicket';
  if (inn && inn.over_bowler != null) {
    // an over is under way (a legal ball, a wide or a no-ball has been bowled in it): only its bowler carries on, unless injured
    if (inn.over_bowler !== bowler && !p.bowler_change) return 'The bowler must finish the over (tick injury change if they could not)';
  } else if (p.extra !== 'pen') {
    if (inn && inn.prev_over_bowler === bowler) return 'A bowler cannot bowl two overs in a row';
    const bw = inn?.bowlers[bowler];
    if (c.bowler_max && bw && bw.legal >= c.bowler_max * 6) return `This bowler has bowled the maximum of ${c.bowler_max} overs`;
  }
  if (p.wicket) {
    if (!HOW_OUT.includes(p.wicket.how)) return `The way out must be one of ${HOW_OUT.join(', ')}`;
    const out = p.wicket.out ?? 'striker';
    if (!['striker', 'non_striker'].includes(out)) return 'out must be striker or non_striker';
    if (out === 'non_striker' && !['run_out', 'obstructing', 'handled_ball', 'retired_out'].includes(p.wicket.how)) return 'Only a run out or an obstruction can dismiss the non-striker';
    if (inn?.free_hit && !FREE_HIT_OUT.has(p.wicket.how)) return 'Off a free hit a batter can only be run out, or out for obstruction, handling the ball or hitting it twice';
    if (p.extra === 'nb' && !NOBALL_OUT.has(p.wicket.how)) return 'Off a no-ball a batter can only be run out, or out for obstruction, handling the ball or hitting it twice';
    if (p.extra === 'wd' && !WIDE_OUT.has(p.wicket.how)) return 'Off a wide a batter can only be stumped, run out, hit wicket or out for obstruction';
  }
  return null;
}
