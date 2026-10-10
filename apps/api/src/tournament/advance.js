// Knockout progression: once a bracket game has a result, its winner (and, for semi-finals, loser) takes the placeholder in the next game.
import { conflict } from '../errors.js';

export const KNOCKOUT_KINDS = ['round_of_32', 'round_of_16', 'quarter', 'semi', 'final', 'third_place'];
export const isKnockout = (f) => KNOCKOUT_KINDS.includes(f.round_kind);

async function place(c, fixtureId, side, teamId) {
  const target = (await c.query('SELECT * FROM fixtures WHERE id=$1 FOR UPDATE', [fixtureId])).rows[0];
  if (!target) return;
  if (['live', 'completed'].includes(target.status)) throw conflict('The next round has already started; its result must be corrected first');
  const other = side === 'home' ? target.away_team_id : target.home_team_id;
  if (other && other === teamId) throw conflict('That team already holds the other place in the next round');
  await c.query(`UPDATE fixtures SET ${side}_team_id=$2, ${side}_placeholder=NULL WHERE id=$1`, [fixtureId, teamId]);
}

/** Work out the winner of a knockout fixture (draws need an explicit winner, e.g. after penalties) and push winner/loser forward. */
export async function advanceKnockout(c, f, winnerId) {
  const loserId = winnerId === f.home_team_id ? f.away_team_id : f.home_team_id;
  if (f.win_feeds_fixture_id) await place(c, f.win_feeds_fixture_id, f.win_feeds_side, winnerId);
  if (f.lose_feeds_fixture_id) await place(c, f.lose_feeds_fixture_id, f.lose_feeds_side, loserId);
}
