// Progression: once a bracket game has an official result, its winner (and, where the format says so, loser) takes the place waiting in
// the next game. Corrections follow one rule everywhere: a game that has NOT started is re-filled automatically; a game that has started or
// been played is never rewritten; the disagreement is recorded as an open conflict for the organiser to resolve (keep or replay).
import { badRequest, conflict } from '../errors.js';
import { aggregateState, seriesState } from './formats/series.js';

export const KNOCKOUT_KINDS = ['round_of_32', 'round_of_16', 'quarter', 'semi', 'final', 'third_place', 'winners', 'losers', 'grand_final', 'repechage', 'placement'];
/** A game that must produce a winner (a leg of a multi-leg tie may end level: the tie decides). */
export const isKnockout = (f) => KNOCKOUT_KINDS.includes(f.round_kind) && !f.winner_optional;
export const isStarted = (f) => !['scheduled', 'cancelled'].includes(f.status);

/** The winner of a game from its score (or the explicit winner after extra time / penalties). Throws the same errors record_result always has. */
export function decideWinner(f, home, away, explicit) {
  if (!KNOCKOUT_KINDS.includes(f.round_kind)) return null;
  if (!f.home_team_id || !f.away_team_id) throw conflict('The teams for this game are not decided yet');
  if (home !== away) {
    const w = home > away ? f.home_team_id : f.away_team_id;
    if (explicit && explicit !== w) throw badRequest('winner_team_id contradicts the score');
    return w;
  }
  if (explicit && [f.home_team_id, f.away_team_id].includes(explicit)) return explicit;
  if (f.winner_optional) return null;
  throw badRequest('A knockout game needs a winner: send winner_team_id (home or away team), e.g. after extra time or penalties');
}

const placeholderFor = (src, kind) => `${kind} ${src?.round ?? 'earlier game'}`;

async function releaseSlot(c, f) {
  if (!f.resource_id || !f.scheduled_at) return;
  await c.query(`UPDATE bookings SET status='cancelled' WHERE id=(SELECT id FROM bookings WHERE event_id=$1 AND resource_id=$2 AND starts_at=$3 AND source='fixture' AND status='confirmed' LIMIT 1)`, [f.event_id, f.resource_id, f.scheduled_at]);
}
async function reclaimSlot(c, f) {
  if (!f.resource_id || !f.scheduled_at) return;
  const { reserve } = await import('../capabilities/venues.js');
  const end = new Date(+new Date(f.scheduled_at) + f.duration_min * 60000).toISOString();
  try { await reserve(c, { resource_id: f.resource_id, user_id: (await c.query('SELECT organizer_id FROM events WHERE id=$1', [f.event_id])).rows[0].organizer_id, event_id: f.event_id, starts_at: f.scheduled_at, ends_at: end, note: f.round }); } catch { /* slot taken meanwhile: the schedule check flags a game without a booking */ }
}

/** Mark a game as not required (kept as history) / bring it back. */
export async function voidFixture(c, f, reason) {
  await c.query("UPDATE fixtures SET status='cancelled', void_reason=$2 WHERE id=$1", [f.id, reason]);
  await releaseSlot(c, f);
}
export async function reviveFixture(c, f) {
  await c.query("UPDATE fixtures SET status='scheduled', void_reason=NULL WHERE id=$1", [f.id]);
  await reclaimSlot(c, f);
}

async function openConflict(c, target, side, causedBy, expected) {
  const played = target[`${side}_team_id`];
  const r = await c.query(
    `INSERT INTO bracket_conflicts(event_id, stage_id, fixture_id, caused_by_fixture_id, side, played_team_id, expected_team_id) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (fixture_id, side) WHERE status='open' DO UPDATE SET expected_team_id=EXCLUDED.expected_team_id, caused_by_fixture_id=EXCLUDED.caused_by_fixture_id RETURNING *`,
    [target.event_id, target.stage_id, target.id, causedBy?.id ?? null, side, played, expected]);
  return r.rows[0];
}
/** If the new line-up again matches what was played, an open conflict on that place closes itself. */
async function settleConflictIfMatching(c, target, side, team) {
  await c.query("UPDATE bracket_conflicts SET status='kept', resolution_reason='Corrected again: the played line-up is now right', resolved_at=now() WHERE fixture_id=$1 AND side=$2 AND status='open' AND $3::uuid IS NOT DISTINCT FROM played_team_id", [target.id, side, team]);
}

/**
 * Put `teamId` (or nobody: back to the placeholder) into one side of a game. Returns what happened for the caller's report.
 * src = the fixture whose result causes it.
 */
export async function place(c, fixtureId, side, teamId, src, kind = 'Winner', opts = {}) {
  const t = (await c.query('SELECT * FROM fixtures WHERE id=$1 FOR UPDATE', [fixtureId])).rows[0];
  if (!t || (t.status === 'cancelled' && t.void_reason !== 'not_required')) return { fixture_id: fixtureId, action: 'ignored' };
  if (t.tie_id) return placeInTie(c, t, side, teamId, src, kind, opts);
  const current = t[`${side}_team_id`];
  if (current === (teamId ?? null)) { await settleConflictIfMatching(c, t, side, teamId); return { fixture_id: t.id, action: 'unchanged' }; }
  const other = side === 'home' ? t.away_team_id : t.home_team_id;
  if (teamId && other === teamId) throw conflict('That team already holds the other place in the next round');
  if (isStarted(t)) {
    if (!opts.allowConflicts) throw conflict('The next round has already started; its result must be corrected first', { fixture_id: t.id, hint: 'Preview the impact, then repeat with accept_downstream_conflicts to record it for an organiser decision' });
    const cf = await openConflict(c, t, side, src, teamId ?? null); return { fixture_id: t.id, action: 'conflict', conflict_id: cf.id }; }
  await c.query(`UPDATE fixtures SET ${side}_team_id=$2, ${side}_placeholder=$3 WHERE id=$1`, [t.id, teamId ?? null, teamId ? null : placeholderFor(src, kind)]);
  return { fixture_id: t.id, action: 'placed' };
}

async function placeInTie(c, t, side, teamId, src, kind, opts) {
  const tie = (await c.query('SELECT * FROM bracket_ties WHERE id=$1 FOR UPDATE', [t.tie_id])).rows[0];
  const col = side === 'home' ? 'a_team_id' : 'b_team_id';
  if (tie[col] === (teamId ?? null)) return { fixture_id: t.id, action: 'unchanged' };
  const games = (await c.query('SELECT * FROM fixtures WHERE tie_id=$1 ORDER BY leg_no FOR UPDATE', [tie.id])).rows;
  const otherTeam = tie[side === 'home' ? 'b_team_id' : 'a_team_id'];
  if (teamId && otherTeam === teamId) throw conflict('That team already holds the other place in the next round');
  const anchor = games.find((g) => g.leg_no === 1) ?? games[0];
  if (games.some((g) => isStarted(g))) {
    if (!opts.allowConflicts) throw conflict('The next round has already started; its result must be corrected first', { fixture_id: anchor.id });
    const cf = await openConflict(c, { ...anchor, [`${side}_team_id`]: tie[col] }, side, src, teamId ?? null); return { fixture_id: anchor.id, action: 'conflict', conflict_id: cf.id }; }
  await c.query(`UPDATE bracket_ties SET ${col}=$2 WHERE id=$1`, [tie.id, teamId ?? null]);
  const a = side === 'home' ? (teamId ?? null) : tie.a_team_id, b = side === 'away' ? (teamId ?? null) : tie.b_team_id;
  for (const g of games) {
    const homeTeam = g.leg_swap ? b : a, awayTeam = g.leg_swap ? a : b;
    const ph = placeholderFor(src, kind);
    await c.query('UPDATE fixtures SET home_team_id=$2, away_team_id=$3, home_placeholder=CASE WHEN $2::uuid IS NULL THEN coalesce(home_placeholder, $4) ELSE NULL END, away_placeholder=CASE WHEN $3::uuid IS NULL THEN coalesce(away_placeholder, $4) ELSE NULL END WHERE id=$1', [g.id, homeTeam, awayTeam, ph]);
  }
  return { fixture_id: anchor.id, action: 'placed' };
}

/** Push winner / loser of a finished game into their next places, then evaluate conditional games. */
export async function advanceKnockout(c, f, winnerId, opts = {}) {
  const loserId = winnerId === f.home_team_id ? f.away_team_id : f.home_team_id;
  const label = (x) => (x ? { round: f.round } : null);
  const out = [];
  if (f.win_feeds_fixture_id) out.push(await place(c, f.win_feeds_fixture_id, f.win_feeds_side, winnerId, label(f), 'Winner', opts));
  if (f.lose_feeds_fixture_id) out.push(await place(c, f.lose_feeds_fixture_id, f.lose_feeds_side, loserId, label(f), 'Loser', opts));
  await evaluateConditionals(c, f, winnerId);
  return out;
}

/** A reset game after the grand final is only played when the losers-bracket champion (the grand final's away side) wins the first one. */
async function evaluateConditionals(c, f, winnerId) {
  for (const fid of [f.win_feeds_fixture_id, f.lose_feeds_fixture_id]) {
    if (!fid) continue;
    const t = (await c.query('SELECT * FROM fixtures WHERE id=$1 FOR UPDATE', [fid])).rows[0];
    if (!t?.conditional || t.conditional.kind !== 'reset') continue;
    const notNeeded = winnerId === f.home_team_id;
    if (notNeeded && t.status === 'scheduled') await voidFixture(c, t, 'not_required');
    else if (!notNeeded && t.status === 'cancelled' && t.void_reason === 'not_required') await reviveFixture(c, t);
  }
}

/** The state of a tie from its games. */
export function tieState(tie, games) {
  const sideOf = (teamId) => (teamId && teamId === tie.a_team_id ? 'a' : teamId && teamId === tie.b_team_id ? 'b' : null);
  const live = games.filter((g) => g.status !== 'cancelled' || g.void_reason !== 'not_required').filter((g) => g.status !== 'cancelled');
  if (tie.kind === 'best_of') {
    const s = seriesState(tie.config.best_of, games.filter((g) => g.status !== 'cancelled' || g.void_reason === 'not_required').map((g) => ({ winner: g.status === 'completed' ? sideOf(g.winner_team_id) : null, status: g.status })));
    return { ...s, method: s.decided ? 'series' : null };
  }
  const legs = live.map((g) => {
    const aHome = !g.leg_swap;
    return { done: g.status === 'completed', a_score: aHome ? g.home_score : g.away_score, b_score: aHome ? g.away_score : g.home_score, a_home: aHome, winner: g.status === 'completed' ? sideOf(g.winner_team_id) : null };
  });
  return aggregateState(legs, { legs: tie.config.legs, away_goals: tie.config.away_goals === true });
}

/** Recompute a tie after any of its games changed: decide it, void/revive unused games, advance or retract its winner. */
export async function settleTie(c, tieId, opts = {}) {
  const tie = (await c.query('SELECT * FROM bracket_ties WHERE id=$1 FOR UPDATE', [tieId])).rows[0];
  const games = (await c.query('SELECT * FROM fixtures WHERE tie_id=$1 ORDER BY leg_no FOR UPDATE', [tieId])).rows;
  const st = tieState(tie, games);
  const winner = st.decided ? (st.winner === 'a' ? tie.a_team_id : tie.b_team_id) : null;
  const status = st.decided ? 'decided' : st.needs_decider ? 'needs_decider' : games.some((g) => g.status === 'completed') ? 'in_progress' : 'pending';
  if (tie.kind === 'best_of') {
    // games after the deciding one are not required; if a correction reopens the series they come back
    const decidedIdx = st.decided ? games.findIndex((g, i, arr) => arr.slice(0, i + 1).filter((x) => x.status === 'completed' && x.winner_team_id === winner).length >= st.needed) : -1;
    for (const [i, g] of games.entries()) {
      if (st.decided && i > decidedIdx && g.status === 'scheduled') await voidFixture(c, g, 'not_required');
      else if (!st.decided && g.status === 'cancelled' && g.void_reason === 'not_required') await reviveFixture(c, g);
    }
  }
  const changed = tie.winner_team_id !== winner;
  await c.query('UPDATE bracket_ties SET status=$2, winner_team_id=$3, method=$4, decided_at=CASE WHEN $3::uuid IS NULL THEN NULL WHEN winner_team_id IS DISTINCT FROM $3 THEN now() ELSE decided_at END WHERE id=$1', [tieId, status, winner, st.method ?? null]);
  if (changed) {
    const loser = winner ? (winner === tie.a_team_id ? tie.b_team_id : tie.a_team_id) : null;
    const src = { round: tie.config.label ?? tie.key };
    if (tie.win_feeds_fixture_id) await place(c, tie.win_feeds_fixture_id, tie.win_feeds_side, winner, src, 'Winner', opts);
    if (tie.lose_feeds_fixture_id) await place(c, tie.lose_feeds_fixture_id, tie.lose_feeds_side, loser, src, 'Loser', opts);
  }
  return { status, winner_team_id: winner, ...st };
}

/** The one call every result path makes after saving an official result. */
export async function afterResult(c, f, winnerId, opts = {}) {
  if (f.tie_id) return settleTie(c, f.tie_id, opts);
  if (winnerId) return advanceKnockout(c, f, winnerId, opts);
  return null;
}
