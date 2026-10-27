// Racket-sport scoring that needs more than "first to N points": tennis and padel (points make games make sets make a match, with
// deuce / no-ad, tie-breaks and a super tie-break decider) and server tracking for rally sports. Pure functions, no database and no clock.
// It refines a `sets` ruleset through `racket{}`; every total is derived from the ordered `point` events, so a client never sends a score.
//
// Entry kinds (match_events): `point` (side = who won the point), `server` (side = who serves first, before the first point),
//   `retire` (side = the player/pair that cannot continue; the other side wins), `walkover` (side = the side that did not turn up).
// `side` is home | away. Voided events are removed by the caller.

const other = (s) => (s === 'home' ? 'away' : 'home');
const SIDES = ['home', 'away'];
export const RACKET_KINDS = ['point', 'server', 'retire', 'walkover'];
const CALL = ['0', '15', '30', '40'];

/** Spoken score of a game: 15-30, 40-40 shown as Deuce, Ad-40. */
export function gameCall(rs, pts) {
  const { home: h, away: a } = pts;
  if (rs.racket?.deuce === 'no_ad') return `${CALL[Math.min(h, 3)]}-${CALL[Math.min(a, 3)]}`;
  if (h >= 3 && a >= 3) return h === a ? 'Deuce' : h > a ? 'Ad-In (home)' : 'Ad-In (away)';
  return `${CALL[Math.min(h, 3)]}-${CALL[Math.min(a, 3)]}`;
}

/**
 * Tennis-style match from point events. Returns the same shape as the rally engine (`home`/`away` = sets won, `sets[]` = games per set,
 * `current_set` = games in the set being played) plus the live game, tie-break flag, server and how the match ended.
 */
export const isGames = (rs) => rs.kind === 'sets' && rs.racket?.scoring === 'games';

export function runRacket(rs, events) {
  const { best_of, points_to_win: gamesToWin, win_by, cap } = rs.sets;
  const R = rs.racket;
  const need = Math.ceil(best_of / 2);
  const stats = { home: {}, away: {} };
  const sets = [];
  const won = { home: 0, away: 0 };
  let games = { home: 0, away: 0 }, pts = { home: 0, away: 0 };
  let inTb = false, superTb = false, gamesPlayed = 0, tbOrder = 0;
  let over = false, outcome = null, retiredSide = null, firstServer = null, pointsLogged = 0, tbFirst = null;

  const decider = () => best_of > 1 && won.home === need - 1 && won.away === need - 1;
  const finishSet = (w, tb) => {
    sets.push(superTb ? { home: w === 'home' ? 1 : 0, away: w === 'away' ? 1 : 0, winner: w, tiebreak: tb } : { ...games, winner: w, tiebreak: tb });
    won[w]++;
    games = { home: 0, away: 0 }; pts = { home: 0, away: 0 };
    inTb = false; superTb = false; tbOrder = 0; tbFirst = null;
    gamesPlayed++;
    if (won[w] >= need) over = true;
  };
  const serverOfGame = () => (firstServer == null ? null : gamesPlayed % 2 === 0 ? firstServer : other(firstServer));

  for (const e of events) {
    if (!SIDES.includes(e.side)) continue;
    stats[e.side][e.kind] = (stats[e.side][e.kind] ?? 0) + 1;
    if (e.kind === 'server') { if (pointsLogged === 0) firstServer = e.side; continue; }
    if ((e.kind === 'retire' || e.kind === 'walkover') && !over) { over = true; outcome = e.kind === 'retire' ? 'retired' : 'walkover'; retiredSide = e.side; continue; }
    if (e.kind !== 'point' || over) continue;
    pointsLogged++;

    // a deciding set played as a match tie-break starts immediately and replaces the set
    if (!inTb && decider() && R.final_set === 'super_tiebreak' && games.home === 0 && games.away === 0 && pts.home === 0 && pts.away === 0) { inTb = true; superTb = true; tbFirst = serverOfGame(); }
    pts[e.side]++;

    if (inTb) {
      tbOrder++;
      const target = superTb ? R.super_tiebreak_points : R.tiebreak_points;
      const top = Math.max(pts.home, pts.away), lead = Math.abs(pts.home - pts.away);
      if (top >= target && lead >= 2) {
        const w = pts.home > pts.away ? 'home' : 'away';
        const tb = { ...pts };
        if (!superTb) games[w]++;
        finishSet(w, tb);
      }
      continue;
    }

    const top = Math.max(pts.home, pts.away), lead = Math.abs(pts.home - pts.away);
    const gameOver = R.deuce === 'no_ad' ? top >= 4 : top >= 4 && lead >= 2;
    if (!gameOver) continue;
    const gw = pts.home > pts.away ? 'home' : 'away';
    games[gw]++; pts = { home: 0, away: 0 }; gamesPlayed++;
    const gTop = Math.max(games.home, games.away), gLead = Math.abs(games.home - games.away);
    if ((gTop >= gamesToWin && gLead >= win_by) || (cap && gTop >= cap && R.tiebreak_at == null)) { gamesPlayed--; finishSet(gw, null); continue; }
    const advantageSet = decider() && R.final_set === 'advantage';
    if (!advantageSet && R.tiebreak_at != null && games.home === R.tiebreak_at && games.away === R.tiebreak_at) { inTb = true; tbFirst = serverOfGame(); }
  }

  let winner = null;
  if (outcome) winner = other(retiredSide);
  else if (over) winner = won.home > won.away ? 'home' : 'away';

  // who serves the next point
  let server = null;
  if (!over && firstServer != null) {
    if (inTb) { const n = tbOrder; server = (Math.floor((n + 1) / 2) % 2 === 0) ? tbFirst : other(tbFirst); }
    else server = serverOfGame();
  }
  return {
    home: outcome ? (winner === 'home' ? Math.max(won.home, need) : won.home) : won.home,
    away: outcome ? (winner === 'away' ? Math.max(won.away, need) : won.away) : won.away,
    sets, current_set: over ? null : { ...games },
    current_game: over ? null : { home: pts.home, away: pts.away, call: inTb ? `${pts.home}-${pts.away}` : gameCall(rs, pts), tiebreak: inTb, match_tiebreak: superTb },
    server, over, outcome, winner, stats,
  };
}

/** Server for a rally sport (badminton, volleyball, squash, table tennis) derived from the point log, per `racket.serve`. Null when unknown. */
export function rallyServer(rs, events) {
  const R = rs.racket;
  if (!R || R.serve === 'none') return null;
  const pts = events.filter((e) => e.kind === 'point' && SIDES.includes(e.side));
  const first = events.find((e) => e.kind === 'server' && SIDES.includes(e.side));
  if (R.serve === 'rally_winner') return pts.length ? pts[pts.length - 1].side : first?.side ?? null;
  // alternate: swap every `serve_every` points inside the current set (and every point once both sides are within one of the target)
  if (!first) return null;
  const set = currentSetPoints(rs, pts);
  const target = rs.sets.points_to_win;
  let server = first.side, served = 0;
  const sc = { home: 0, away: 0 };
  for (const p of set) {
    sc[p.side]++; served++;
    const late = sc.home >= target - 1 && sc.away >= target - 1;
    if (served >= (late ? 1 : R.serve_every)) { server = other(server); served = 0; }
  }
  return server;
}

function currentSetPoints(rs, pts) {
  const { best_of, points_to_win, win_by, cap, deciding_points } = rs.sets;
  const need = Math.ceil(best_of / 2);
  let cur = [], sc = { home: 0, away: 0 };
  const won = { home: 0, away: 0 };
  for (const p of pts) {
    cur.push(p); sc[p.side]++;
    const decider = best_of > 1 && won.home === need - 1 && won.away === need - 1;
    const target = decider && deciding_points ? deciding_points : points_to_win;
    const top = Math.max(sc.home, sc.away), lead = Math.abs(sc.home - sc.away);
    if ((top >= target && lead >= win_by) || (cap && top >= cap)) { won[sc.home > sc.away ? 'home' : 'away']++; cur = []; sc = { home: 0, away: 0 }; }
  }
  return cur;
}

/** Why a racket entry cannot be logged, or null. `live` has no voided events. */
export function racketReject(rs, live, next, state) {
  if (!RACKET_KINDS.includes(next.kind)) return null; // other kinds (aces, faults) are plain stats, validated by the generic path
  if (!SIDES.includes(next.side)) return 'side must be home or away';
  const st = state ?? runRacket(rs, live);
  if (st.over) return 'The match is already decided';
  if (next.kind === 'server' && live.some((e) => e.kind === 'point')) return 'The first server is set before the first point';
  if (next.kind === 'walkover' && live.some((e) => e.kind === 'point')) return 'A walkover cannot be recorded once play has started; record a retirement instead';
  return null;
}
