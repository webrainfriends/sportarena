// Judged-bout and attempt-based scoring that is not a running score: the boxing 10-point must scorecard and weightlifting attempts.
// Pure functions, no database. Totals, round winners, decisions, bests and places are all worked out here from what the official wrote
// down (a card per judge, six attempts per lifter); a client never sends a total.

const other = (s) => (s === 'red' ? 'blue' : 'red');

/** Why one round on one card cannot be scored, or null. A round is out of 10 for each boxer; fouls and knockdowns lower a boxer's points, so 9-8 and 9-9 are legal. */
export function roundProblem(r) {
  if (!r) return 'empty round';
  const { red, blue } = r;
  if (![red, blue].every((n) => Number.isInteger(n) && n >= 0 && n <= 10)) return 'points must be whole numbers from 0 to 10';
  return null;
}

/**
 * The decision from the judges' cards. Each card is [{red, blue}] per round. A judge's winner is the boxer with more points over
 * the rounds; the bout goes to the boxer most judges picked: unanimous (all), majority (a clear lead with a draw card) or split.
 * @returns {{judges:{red:number, blue:number, winner:'red'|'blue'|'draw'|null, rounds:number}[], votes:{red:number, blue:number, draw:number}, kind:string|null, winner:'red'|'blue'|'draw'|null, problems:{judge:number, round:number, message:string}[]}}
 */
export function boxingDecision(cards, rounds, expectedJudges = (cards ?? []).length) {
  const problems = [];
  const judges = (cards ?? []).map((card, j) => {
    let red = 0, blue = 0, n = 0;
    (card.rounds ?? []).slice(0, rounds).forEach((r, i) => {
      const bad = roundProblem(r);
      if (bad) { problems.push({ judge: j + 1, round: i + 1, message: `Judge ${j + 1}, round ${i + 1}: ${bad}` }); return; }
      red += r.red; blue += r.blue; n++;
    });
    return { red, blue, rounds: n, winner: n === 0 ? null : red > blue ? 'red' : blue > red ? 'blue' : 'draw' };
  });
  const scored = judges.filter((j) => j.winner);
  const votes = { red: scored.filter((j) => j.winner === 'red').length, blue: scored.filter((j) => j.winner === 'blue').length, draw: scored.filter((j) => j.winner === 'draw').length };
  const complete = scored.length > 0 && scored.length >= expectedJudges && scored.every((j) => j.rounds === rounds);
  let winner = null, kind = null;
  if (scored.length) {
    if (votes.draw > Math.max(votes.red, votes.blue) && votes.red + votes.blue > 0) { winner = 'draw'; kind = 'majority draw'; }
    else if (votes.red === votes.blue) { winner = 'draw'; kind = votes.red === 0 ? 'draw' : 'split draw'; }
    else {
      winner = votes.red > votes.blue ? 'red' : 'blue';
      const lose = other(winner);
      kind = votes[lose] === 0 && votes.draw === 0 ? 'unanimous' : votes[lose] === 0 ? 'majority' : 'split';
    }
  }
  if (!complete && kind) kind = `${kind} (so far)`;
  return { judges, votes, kind, winner, complete, problems };
}

// ------------------------------------------------------------------------------------------------------------------ weightlifting
/** The kg of an attempt, or null when not attempted. Attempts: [{kg, ok}] with ok true (good lift), false (no lift) or null (not yet taken). */
const good = (a) => (a && a.ok === true && Number.isFinite(a.kg) ? a.kg : null);

/**
 * IWF ranking: the total is the best good snatch plus the best good clean and jerk (no total without a good lift in each). A heavier
 * total ranks first; equal totals: the lighter lifter, then whoever lifted the total first (earlier in the list stands in for that).
 * @param {{name?:string, body_kg?:number, attempts?:{kg:number, ok:boolean|null}[]}[]} rows  attempts 0-2 snatch, 3-5 clean and jerk (up to `n` each)
 */
export function rankLifts(rows, n = 3) {
  const out = rows.map((r, i) => {
    const at = r.attempts ?? [];
    const gone = ['DNS', 'DNF', 'DQ'].includes(r.status);
    const sn = at.slice(0, n).map(good).filter((x) => x != null), cj = at.slice(n, n * 2).map(good).filter((x) => x != null);
    const bestSn = sn.length ? Math.max(...sn) : null, bestCj = cj.length ? Math.max(...cj) : null;
    return { i, best_snatch: bestSn, best_cj: bestCj, total: !gone && bestSn != null && bestCj != null ? bestSn + bestCj : null, bust: at.slice(0, n).some((a) => a?.ok != null) && sn.length === 0 };
  });
  const ranked = out.filter((x) => x.total != null).sort((a, b) => b.total - a.total || (rows[a.i].body_kg ?? 1e9) - (rows[b.i].body_kg ?? 1e9) || a.i - b.i);
  const place = new Map();
  ranked.forEach((x, k) => {
    const p = ranked[k - 1];
    const tie = p && p.total === x.total && (rows[p.i].body_kg ?? 1e9) === (rows[x.i].body_kg ?? 1e9);
    place.set(x.i, tie ? place.get(p.i) : k + 1);
  });
  const warnings = [];
  rows.forEach((r, i) => {
    const at = r.attempts ?? [];
    for (const [from, name] of [[0, 'snatch'], [n, 'clean and jerk']]) {
      let prev = null;
      for (let k = 0; k < n; k++) {
        const a = at[from + k];
        if (!a || !Number.isFinite(a.kg)) continue;
        if (prev != null && a.kg < prev) warnings.push({ row: i, code: 'weight_decreased', message: `${r.name || `Lifter ${i + 1}`}: a ${name} attempt went down in weight (${prev} to ${a.kg} kg), which the rules do not allow` });
        prev = a.kg;
      }
    }
  });
  return { rows: rows.map((r, i) => ({ ...r, ...out[i], rank: place.get(i) ?? null })), warnings };
}
