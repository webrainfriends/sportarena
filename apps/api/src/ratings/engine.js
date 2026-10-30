// Skill ratings (#633): a pure, deterministic Glicko-2 engine. It never touches the database and never invents a result: it replays the verified games it is
// given, in a fixed order, so the same evidence always produces the same ratings (a corrected result re-runs the replay and the issued runs are kept).
// Shown to people as a level 1.0-7.0 plus a reliability bar; the Glicko numbers are an implementation detail exposed only in "explain".

export const START = { r: 1500, rd: 350, sigma: 0.06 };
const SCALE = 173.7178, TAU = 0.5, RD_MAX = 350, RD_MIN = 50, PERIOD_DAYS = 30;
/** A rating is trusted for matchmaking once its deviation is at or below this (roughly 7 evenly matched games against established players, more against newcomers or lopsided results). */
export const RELIABLE_RD = 130;
/** 80% of a game's score is who won, the other 20% how it went (sets, points, goals, runs), so a 6-0 6-0 moves a rating more than 7-6 7-6. */
export const OUTCOME_WEIGHT = 0.8;

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;

/** Rating (1500 = 4.0) to the 1.0-7.0 level people see: a logistic squeeze so the scale never runs out at either end. */
export const toLevel = (r) => r2(1 + 6 / (1 + Math.exp(-(r - 1500) / 300)));
export const fromLevel = (l) => r2(1500 - 300 * Math.log(6 / (l - 1) - 1));
/** 0-100 reliability from the deviation: 0 for someone brand new, 100 at the engine's floor. */
export const reliabilityOf = (rd) => Math.max(0, Math.min(100, Math.round(100 * (RD_MAX - rd) / (RD_MAX - RD_MIN))));
export const strengthLabel = (rd) => (rd <= RELIABLE_RD ? 'reliable' : rd <= 250 ? 'developing' : 'provisional');

/** The four coarse levels open games already use, so the computed level can stand in for a self-declared one where there is evidence. */
export const LEVEL_BUCKETS = [['beginner', 0, 3.0], ['amateur', 3.0, 4.5], ['semi_pro', 4.5, 5.8], ['pro', 5.8, 7.01]];
export const bucketOf = (level) => LEVEL_BUCKETS.find(([, lo, hi]) => level >= lo && level < hi)?.[0] ?? 'beginner';

const g = (phi) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const E = (mu, muJ, phiJ) => 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));

/** Deviation grows with inactivity (never past a brand-new player's). `days` since the player's last verified game. */
export function inflate(p, days) {
  if (!(days > 0)) return p.rd;
  const phi = p.rd / SCALE, sig = p.sigma;
  return Math.min(RD_MAX, SCALE * Math.sqrt(phi * phi + sig * sig * (days / PERIOD_DAYS)));
}

function newSigma(phi, sigma, v, delta) {
  const a = Math.log(sigma * sigma), eps = 1e-6;
  const f = (x) => (Math.exp(x) * (delta * delta - phi * phi - v - Math.exp(x))) / (2 * (phi * phi + v + Math.exp(x)) ** 2) - (x - a) / (TAU * TAU);
  let A = a, B;
  if (delta * delta > phi * phi + v) B = Math.log(delta * delta - phi * phi - v);
  else { let k = 1; while (f(a - k * TAU) < 0 && k < 50) k++; B = a - k * TAU; }
  let fA = f(A), fB = f(B), n = 0;
  while (Math.abs(B - A) > eps && n++ < 100) {
    const C = A + ((A - B) * fA) / (fB - fA), fC = f(C);
    if (fC * fB <= 0) { A = B; fA = fB; } else fA /= 2;
    B = C; fB = fC;
  }
  return Math.exp(A / 2);
}

/**
 * One rating period for one player: everything they played in a single game (one opponent side, or every other entrant of a heat).
 * @param {{r:number,rd:number,sigma:number}} p  rating before the game (inactivity already applied to rd)
 * @param {{r:number,rd:number,s:number}[]} opps  each opponent's rating and the score in [0,1] against them
 */
export function update(p, opps) {
  if (!opps.length) return { ...p };
  const mu = (p.r - 1500) / SCALE, phi = p.rd / SCALE;
  let vInv = 0, dSum = 0;
  for (const o of opps) {
    const muJ = (o.r - 1500) / SCALE, gj = g(o.rd / SCALE), Ej = E(mu, muJ, o.rd / SCALE);
    vInv += gj * gj * Ej * (1 - Ej);
    dSum += gj * (o.s - Ej);
  }
  const v = 1 / vInv, delta = v * dSum;
  const sigma = newSigma(phi, p.sigma, v, delta);
  const phiStar = Math.sqrt(phi * phi + sigma * sigma);
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muNew = mu + phiNew * phiNew * dSum;
  return { r: r4(SCALE * muNew + 1500), rd: r4(Math.max(RD_MIN, Math.min(RD_MAX, SCALE * phiNew))), sigma: r4(sigma) };
}

/** A side of one or more players meets the opponent as their average rating; its deviation is the root-mean-square so one new partner keeps the pair uncertain. */
export function aggregate(ps) {
  const n = ps.length || 1;
  return { r: ps.reduce((s, p) => s + p.r, 0) / n, rd: Math.sqrt(ps.reduce((s, p) => s + p.rd * p.rd, 0) / n) };
}

/** Score in [0,1] for side A against B: the outcome, blended with a smoothed share of the points that game was played for. */
export function scoreOf(outcome, a, b) {
  const share = a == null || b == null ? outcome : (a + 0.5) / (a + b + 1);
  return r4(OUTCOME_WEIGHT * outcome + (1 - OUTCOME_WEIGHT) * share);
}

const ms = (iso) => new Date(iso).getTime();
const gameOrder = (x, y) => ms(x.played_at) - ms(y.played_at) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

/**
 * Replay verified games. A game is either
 *   { id, played_at, sides: [{ players: [userId], score }, { players, score }], margin?: [a, b] }   a contest between two sides, or
 *   { id, played_at, field: [{ player, position }] }                                                    a placing against the field (heats, races, measured events).
 * Returns the final rating of everyone and one change per player per game (the "why did my level move" ledger).
 */
export function replay(games) {
  const state = new Map();
  const get = (u) => state.get(u) ?? { ...START, games: 0, wins: 0, losses: 0, draws: 0, last: null, peak: START.r };
  const changes = [];
  for (const game of [...games].sort(gameOrder)) {
    const when = ms(game.played_at);
    const before = new Map();
    const touch = (u) => {
      if (before.has(u)) return;
      const p = get(u);
      before.set(u, { ...p, rd: p.last ? inflate(p, (when - p.last) / 86400000) : p.rd });
    };
    let plan; // userId -> { opps, result }
    if (game.field) {
      const field = game.field.filter((e, i, all) => all.findIndex((x) => x.player === e.player) === i);
      if (field.length < 2) continue;
      field.forEach((e) => touch(e.player));
      plan = new Map(field.map((e) => [e.player, {
        opps: field.filter((o) => o !== e).map((o) => ({ r: before.get(o.player).r, rd: before.get(o.player).rd, s: e.position < o.position ? 1 : e.position === o.position ? 0.5 : 0 })),
        result: field.every((o) => o === e || e.position < o.position) ? 'win' : field.some((o) => o !== e && o.position < e.position) ? 'loss' : 'draw',
      }]));
    } else {
      const [A, B] = game.sides;
      const players = [...A.players, ...B.players];
      if (!A.players.length || !B.players.length || new Set(players).size !== players.length) continue; // an empty side, or one person on both sides, is not a rated game
      players.forEach(touch);
      const a = aggregate(A.players.map((u) => before.get(u))), b = aggregate(B.players.map((u) => before.get(u)));
      const outA = A.score > B.score ? 1 : A.score < B.score ? 0 : 0.5;
      const [ma, mb] = game.margin ?? [A.score, B.score];
      const sA = scoreOf(outA, ma, mb), sB = scoreOf(1 - outA, mb, ma);
      plan = new Map([
        ...A.players.map((u) => [u, { opps: [{ ...b, s: sA }], result: outA === 1 ? 'win' : outA === 0 ? 'loss' : 'draw' }]),
        ...B.players.map((u) => [u, { opps: [{ ...a, s: sB }], result: outA === 0 ? 'win' : outA === 1 ? 'loss' : 'draw' }]),
      ]);
    }
    for (const [u, { opps, result }] of plan) {
      const p = before.get(u), next = update(p, opps);
      const exp = opps.reduce((s, o) => s + E((p.r - 1500) / SCALE, (o.r - 1500) / SCALE, o.rd / SCALE), 0) / opps.length;
      const prev = get(u);
      state.set(u, { ...next, games: prev.games + 1, wins: prev.wins + (result === 'win'), losses: prev.losses + (result === 'loss'), draws: prev.draws + (result === 'draw'), last: when, peak: Math.max(prev.peak, next.r) });
      changes.push({ game_id: game.id, user_id: u, played_at: game.played_at, result, expected: r4(exp), before_r: r4(prev.r), before_rd: r4(prev.rd), after_r: next.r, after_rd: next.rd, sigma: next.sigma, opponent_r: r2(opps.reduce((s, o) => s + o.r, 0) / opps.length) });
    }
  }
  return { ratings: state, changes };
}

/** What a rating row looks like to people: the level and how far to trust it, never the raw numbers. */
export const present = (s, { asOf } = {}) => {
  const rd = s.last && asOf ? inflate(s, (ms(asOf) - s.last) / 86400000) : s.rd;
  return { level: toLevel(s.r), reliability: reliabilityOf(rd), strength: strengthLabel(rd), reliable: rd <= RELIABLE_RD, matches_as: rd <= RELIABLE_RD ? bucketOf(toLevel(s.r)) : null, games: s.games, wins: s.wins, losses: s.losses, draws: s.draws, peak_level: toLevel(s.peak) };
};
