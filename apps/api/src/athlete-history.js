/**
 * Unified athlete history (#100): ONE read model over what an athlete logged themselves (player_matches) and what Gotmygame
 * officially knows (games, fixtures). Nothing is copied — canonical tables stay authoritative, so a corrected result changes the
 * athlete's history and totals immediately. `$1` is always the athlete's immutable user id.
 *
 * Who counts as having PLAYED (never a whole roster, never staff):
 *  - game, individual competitor: a game_participants row with their user_id.
 *  - game, team competitor: a confirmed playing squad slot (player/captain/vice_captain) for that game's fixture and team, OR an
 *    active player/captain game association marked starter (or unset) while on that team's active roster.
 *  - fixture with no finished game: a confirmed playing squad slot for that fixture on its home/away team.
 *  Only finished games ('post-event') and completed fixtures count. Substitutes/bench/selected-only/declined/dropped and
 *  coach/manager/physio/referee/scorer never count. A game always wins over its fixture (games.fixture_id) — shown once.
 */

const PLAY_ROLES = `('player','captain','vice_captain')`;
const numericOnly = (col) => `(SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each(${col}) e WHERE jsonb_typeof(e.value) = 'number')`;

export const ACTIVITIES_CTE = `
WITH credited AS (
  SELECT DISTINCT ON (g.id) g.id AS game_id, g.fixture_id, g.competition_id, g.sport_id, g.starts_at, g.title, g.created_by, g.venue_id, g.location,
         p.id AS pid, p.team_id, p.user_id AS p_user, p.outcome, p.outcome_type, p.score, p.rank, p.stats AS pstats
    FROM game_participants p JOIN games g ON g.id = p.game_id
   WHERE g.status = 'post-event' AND (
         p.user_id = $1
      OR (p.team_id IN (SELECT team_id FROM team_members WHERE user_id = $1 UNION SELECT team_id FROM team_squads WHERE user_id = $1) AND (
            EXISTS (SELECT 1 FROM team_squads q WHERE q.fixture_id = g.fixture_id AND q.team_id = p.team_id AND q.user_id = $1 AND q.status = 'confirmed' AND q.role IN ${PLAY_ROLES})
         OR EXISTS (SELECT 1 FROM associations a JOIN team_members tm ON tm.team_id = p.team_id AND tm.user_id = a.user_id AND tm.status = 'active'
                     WHERE a.user_id = $1 AND a.target_type = 'game' AND a.target_id = g.id AND a.status = 'active'
                       AND a.role IN ('player','captain') AND coalesce(a.player_status, 'starter') = 'starter'))))
   ORDER BY g.id, (p.user_id IS NOT NULL) DESC, p.team_id
), off_game AS (
  SELECT 'game:' || c.game_id AS activity_id, 'game' AS source_type, c.game_id AS source_id, c.game_id, c.fixture_id, c.competition_id AS event_id,
         c.sport_id, c.starts_at AS played_at,
         CASE WHEN c.p_user IS NOT NULL AND opp.n IS DISTINCT FROM 1 THEN 'competition' ELSE 'match' END AS kind,
         c.title, CASE WHEN opp.n = 1 THEN opp.name END AS opponent, ev.name AS competition, coalesce(vn.name, c.location) AS venue,
         CASE c.outcome WHEN 'win' THEN 'win' WHEN 'loss' THEN 'loss' WHEN 'tie' THEN 'draw' END AS result,
         c.rank, c.score AS score_for, CASE WHEN opp.n = 1 THEN opp.score END AS score_against,
         CASE WHEN jsonb_typeof(st.s -> 'minutes') = 'number' THEN (st.s ->> 'minutes')::numeric::int END AS minutes,
         st.s AS stats, c.created_by AS recorded_by, c.outcome_type
    FROM credited c
    LEFT JOIN events ev ON ev.id = c.competition_id
    LEFT JOIN venues vn ON vn.id = c.venue_id
    LEFT JOIN LATERAL (SELECT count(*)::int AS n, max(coalesce(t.name, u.display_name)) AS name, max(q.score) AS score
                         FROM game_participants q LEFT JOIN teams t ON t.id = q.team_id LEFT JOIN users u ON u.id = q.user_id
                        WHERE q.game_id = c.game_id AND q.id <> c.pid) opp ON true
    LEFT JOIN LATERAL (SELECT CASE WHEN c.p_user IS NOT NULL THEN ${numericOnly('c.pstats')}
                                   ELSE (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM associations a, jsonb_each(a.attributes) e
                                          WHERE a.user_id = $1 AND a.target_type = 'game' AND a.target_id = c.game_id AND a.status = 'active'
                                            AND a.role IN ('player','captain') AND jsonb_typeof(e.value) = 'number') END AS s) st ON true
), off_fixture AS (
  SELECT 'fixture:' || f.id AS activity_id, 'fixture' AS source_type, f.id AS source_id, NULL::uuid AS game_id, f.id AS fixture_id, f.event_id,
         ev.sport_id, f.scheduled_at AS played_at, 'match' AS kind,
         coalesce(ev.name, 'Fixture') || coalesce(' · ' || f.round, '') AS title, ot.name AS opponent, ev.name AS competition, vn.name AS venue,
         CASE WHEN f.home_score IS NULL OR f.away_score IS NULL THEN NULL
              WHEN (CASE WHEN sq.team_id = f.home_team_id THEN f.home_score ELSE f.away_score END) > (CASE WHEN sq.team_id = f.home_team_id THEN f.away_score ELSE f.home_score END) THEN 'win'
              WHEN (CASE WHEN sq.team_id = f.home_team_id THEN f.home_score ELSE f.away_score END) < (CASE WHEN sq.team_id = f.home_team_id THEN f.away_score ELSE f.home_score END) THEN 'loss'
              ELSE 'draw' END AS result,
         NULL::int AS rank,
         CASE WHEN sq.team_id = f.home_team_id THEN f.home_score ELSE f.away_score END AS score_for,
         CASE WHEN sq.team_id = f.home_team_id THEN f.away_score ELSE f.home_score END AS score_against,
         NULL::int AS minutes, '{}'::jsonb AS stats, ev.organizer_id AS recorded_by, NULL::text AS outcome_type
    FROM fixtures f
    JOIN events ev ON ev.id = f.event_id
    JOIN LATERAL (SELECT q.team_id FROM team_squads q
                   WHERE q.fixture_id = f.id AND q.user_id = $1 AND q.status = 'confirmed' AND q.role IN ${PLAY_ROLES}
                     AND q.team_id IN (f.home_team_id, f.away_team_id) ORDER BY q.team_id LIMIT 1) sq ON true
    LEFT JOIN teams ot ON ot.id = CASE WHEN sq.team_id = f.home_team_id THEN f.away_team_id ELSE f.home_team_id END
    LEFT JOIN resources rs ON rs.id = f.resource_id
    LEFT JOIN venues vn ON vn.id = rs.venue_id
   WHERE f.status = 'completed'
     AND NOT EXISTS (SELECT 1 FROM games g WHERE g.fixture_id = f.id AND g.status = 'post-event')
), off AS (
  SELECT * FROM off_game UNION ALL SELECT * FROM off_fixture
), acts AS (
  SELECT o.activity_id AS id, o.activity_id, 'official' AS source, true AS is_official,
         CASE o.source_type WHEN 'game' THEN 'official_game' ELSE 'official_fixture' END AS provenance, 'official' AS verification,
         o.source_type, o.source_id, o.game_id, o.fixture_id, o.event_id, o.sport_id, sp.id AS sport_profile_id, o.kind, o.title,
         o.played_at, (o.played_at AT TIME ZONE 'UTC')::date AS played_on, o.opponent, o.competition, o.venue, o.result, o.rank,
         o.score_for, o.score_against, o.minutes, coalesce(n.rating, lm.rating) AS rating, coalesce(n.notes, lm.notes) AS notes,
         o.stats, o.recorded_by, o.outcome_type, l.player_match_id AS linked_match_id, o.played_at AS created_at, NULL::text AS match_type
    FROM off o
    LEFT JOIN sport_profiles sp ON sp.user_id = $1 AND sp.sport_id = o.sport_id AND sp.role = 'athlete'
    LEFT JOIN player_match_links l ON l.user_id = $1 AND l.source_type = o.source_type AND l.source_id = o.source_id AND l.removed_at IS NULL
    LEFT JOIN player_matches lm ON lm.id = l.player_match_id AND lm.user_id = $1
    LEFT JOIN player_match_notes n ON n.user_id = $1 AND n.source_type = o.source_type AND n.source_id = o.source_id
  UNION ALL
  SELECT m.id::text, 'manual:' || m.id, m.source, false,
         CASE m.source WHEN 'import' THEN 'imported' ELSE 'manual' END, CASE m.source WHEN 'import' THEN 'imported' ELSE 'self_reported' END,
         'player_match', m.id, NULL::uuid, NULL::uuid, NULL::uuid, sp.sport_id, m.sport_profile_id, 'match', NULL::text,
         (m.played_on + time '12:00')::timestamp AT TIME ZONE 'UTC', m.played_on, m.opponent, m.competition, m.venue, m.result, NULL::int,
         m.score_for, m.score_against, m.minutes, m.rating, m.notes, m.stats, m.user_id, NULL::text, NULL::uuid, m.created_at, m.match_type
    FROM player_matches m JOIN sport_profiles sp ON sp.id = m.sport_profile_id
   WHERE m.user_id = $1 AND m.archived_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM player_match_links l JOIN off o ON o.source_type = l.source_type AND o.source_id = l.source_id
                      WHERE l.player_match_id = m.id AND l.user_id = $1 AND l.removed_at IS NULL)
)`;

/** Columns of one logical activity, as the API returns them (the viewer is always the athlete themselves). */
export const ACTIVITY_COLS = `a.id, a.activity_id, a.source, a.provenance, a.verification, a.source_type, a.source_id, a.game_id, a.fixture_id, a.event_id,
  a.sport_id, a.sport_profile_id, a.kind, a.title, a.played_at, to_char(a.played_on,'YYYY-MM-DD') AS played_on, a.opponent, a.competition, a.venue,
  a.result, a.rank, a.score_for, a.score_against, a.minutes, a.rating, a.notes, a.stats, a.recorded_by, a.outcome_type, a.linked_match_id, a.created_at, a.match_type,
  (NOT a.is_official) AS can_delete, false AS can_edit, true AS can_add_personal_note`;
