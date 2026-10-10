// DB-side helpers shared by the tournament capabilities.
import { rateTeams, ratingOf } from './ranking.js';

/** Strength of every team of a sport computed from all completed two-team games (any event) so far. */
export async function loadTeamRatings(c, sportId, now = new Date()) {
  const { rows } = await c.query(
    `SELECT f.home_team_id AS home, f.away_team_id AS away, f.home_score AS hs, f.away_score AS "as", f.scheduled_at AS at
       FROM fixtures f JOIN events e ON e.id=f.event_id
      WHERE e.sport_id=$1 AND f.status='completed' AND f.home_team_id IS NOT NULL AND f.away_team_id IS NOT NULL
        AND f.home_score IS NOT NULL AND f.away_score IS NOT NULL`, [sportId]);
  return rateTeams(rows, { now });
}

export { ratingOf };

export const acceptedTeams = async (c, eventId) => (await c.query(
  `SELECT e.id AS entry_id, t.id AS team_id, t.name, t.city FROM event_entries e JOIN teams t ON t.id=e.team_id
    WHERE e.event_id=$1 AND e.status='accepted' ORDER BY e.created_at, t.name`, [eventId])).rows;

/** Seeds in order (best first) for accepted teams: manual/computed seeds first, unseeded teams after by rating. */
export async function seededTeams(c, ev) {
  const teams = await acceptedTeams(c, ev.id);
  const seeds = new Map((await c.query('SELECT team_id, seed FROM event_seeds WHERE event_id=$1', [ev.id])).rows.map((r) => [r.team_id, r.seed]));
  const ratings = await loadTeamRatings(c, ev.sport_id);
  const r = (t) => ratingOf(ratings, t.team_id).rating;
  return teams.slice().sort((a, b) => (seeds.get(a.team_id) ?? 1e9) - (seeds.get(b.team_id) ?? 1e9) || r(b) - r(a) || a.name.localeCompare(b.name)).map((t) => ({ ...t, seed: seeds.get(t.team_id) ?? null, rating: r(t) }));
}
