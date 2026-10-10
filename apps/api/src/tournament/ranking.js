// Team strength computed from past results — no ratings table. Recent games weigh more (exponential decay), a goal-difference
// term separates teams level on points, and teams with few games are pulled toward the field average (so one lucky win is not a #1).
const RESULT_POINTS = { win: 3, draw: 1, loss: 0 };

/**
 * @param {{home:string, away:string, hs:number, as:number, at:Date|string}[]} games completed games
 * @returns {Map<string,{rating:number, played:number, won:number, drawn:number, lost:number, goal_diff:number}>}
 */
export function rateTeams(games, { now = new Date(), halfLifeDays = 365, prior = 3 } = {}) {
  const acc = new Map();
  const slot = (t) => { if (!acc.has(t)) acc.set(t, { w: 0, pts: 0, gd: 0, played: 0, won: 0, drawn: 0, lost: 0, rawGd: 0 }); return acc.get(t); };
  for (const g of games) {
    const age = Math.max(0, (new Date(now) - new Date(g.at)) / 864e5);
    const w = Math.pow(0.5, age / halfLifeDays);
    for (const [team, gf, ga] of [[g.home, g.hs, g.as], [g.away, g.as, g.hs]]) {
      const a = slot(team);
      const res = gf > ga ? 'win' : gf === ga ? 'draw' : 'loss';
      a.w += w; a.pts += w * RESULT_POINTS[res]; a.gd += w * Math.max(-3, Math.min(3, gf - ga));
      a.played++; a.rawGd += gf - ga;
      if (res === 'win') a.won++; else if (res === 'draw') a.drawn++; else a.lost++;
    }
  }
  const raw = (a) => (a.w ? a.pts / a.w + 0.25 * (a.gd / a.w) : 0);
  const teams = [...acc.values()];
  const mean = teams.length ? teams.reduce((s, a) => s + raw(a), 0) / teams.length : 0;
  const out = new Map();
  for (const [team, a] of acc) {
    out.set(team, { rating: round3((a.w * raw(a) + prior * mean) / (a.w + prior)), played: a.played, won: a.won, drawn: a.drawn, lost: a.lost, goal_diff: a.rawGd });
  }
  out.mean = round3(mean);
  return out;
}

/** A team nobody has seen play gets the field average and `played: 0`. */
export const ratingOf = (map, team) => map.get(team) ?? { rating: map.mean ?? 0, played: 0, won: 0, drawn: 0, lost: 0, goal_diff: 0 };

const round3 = (n) => Math.round(n * 1000) / 1000;
