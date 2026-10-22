import { many } from './db.js';

// Reads of the canonical match record for coaching screens. Everything here is read-only and labelled official.
export const PLAYED = ['finished', 'completed'];

const cmp = { gte: (a, t) => a >= t, lte: (a, t) => a <= t, eq: (a, t) => a === t };

/** Official events of a fixture for one team (non-voided), oldest first. */
export const teamEvents = (fixtureId, teamId) => many(
  `SELECT e.id, e.seq, e.kind, e.period, e.clock_seconds, e.player_id, u.display_name AS player_name FROM match_events e LEFT JOIN users u ON u.id=e.player_id
    WHERE e.fixture_id=$1 AND e.team_id=$2 AND e.voided_at IS NULL ORDER BY e.seq`, [fixtureId, teamId]);

/** Evaluate a coach's objectives against the official record. `pending` until the match is played; never writes anything. */
export function evaluateObjectives(objectives, fixture, teamId, events) {
  const mine = fixture.home_team_id === teamId;
  // only a published (completed) result counts as official; 'finished' still awaits the score sheet
  const played = fixture.status === 'completed' && fixture.home_score != null && fixture.away_score != null;
  const forScore = mine ? fixture.home_score : fixture.away_score, againstScore = mine ? fixture.away_score : fixture.home_score;
  return objectives.map((o) => {
    if (!o.indicator) return { ...o, outcome: 'coach_judged' };
    const { metric, kind, comparator, target } = o.indicator;
    if (!played) return { ...o, outcome: 'pending' };
    let actual;
    if (metric === 'score_for') actual = forScore;
    else if (metric === 'score_against') actual = againstScore;
    else if (metric === 'goal_difference') actual = forScore - againstScore;
    else if (metric === 'clean_sheet') actual = againstScore === 0 ? 1 : 0;
    else if (metric === 'events') actual = events.filter((e) => e.kind === kind).length;
    return { ...o, actual, outcome: cmp[comparator](actual, target) ? 'met' : 'not_met', provenance: 'official' };
  });
}
