// The ONE definition of a "completed activity" (#73), shared by the governed KPIs (first completed activity, repeat participation, activation) and the
// experiment outcomes, so they can never disagree. A completed activity is something a person actually took part in. A game that was created, still
// open, postponed, cancelled or forfeited is not; a booking that was cancelled or became a no-show is not; a booking nobody checked in to is not.
//
// Columns: rec_id, kind (the source: game_participation | appearance | booking_checkin | academy_attendance | team_checkin), user_id, at, and the
// attribution columns sport_id, event_id, venue_id, team_id, org_id. Read live from the canonical tables; nothing here is stored.

export const ACTIVITY_SOURCES = [
  { key: 'game_participation', label: 'Completed games (every sport)' },
  { key: 'appearance', label: 'Match appearances' },
  { key: 'booking_checkin', label: 'Confirmed venue bookings checked in' },
  { key: 'academy_attendance', label: 'Academy attendance' },
  { key: 'team_checkin', label: 'Team check-ins' },
];

/** A SELECT (no trailing semicolon) of every completed activity, one row per source record. */
export const completedActivitySql = () => `
  SELECT gp.id::text AS rec_id, 'game_participation'::text AS kind, gp.user_id, g.starts_at AS at, g.sport_id, g.competition_id AS event_id, g.venue_id, gp.team_id, e.organisation_id AS org_id
    FROM game_participants gp JOIN games g ON g.id=gp.game_id LEFT JOIN events e ON e.id=g.competition_id
   WHERE g.status = 'post-event'
  UNION ALL
  SELECT ma.id::text, 'appearance', ma.user_id, coalesce(fx.scheduled_at, fx.started_at), ev.sport_id, fx.event_id, ev.venue_id, ma.team_id, ev.organisation_id
    FROM match_appearances ma JOIN fixtures fx ON fx.id=ma.fixture_id JOIN events ev ON ev.id=fx.event_id
   WHERE ma.archived_at IS NULL AND ma.status IN ('started','substitute_on') AND coalesce(fx.scheduled_at, fx.started_at) IS NOT NULL
  UNION ALL
  SELECT b.id::text, 'booking_checkin', b.user_id, b.checked_in_at, rs.sport_id, b.event_id, rs.venue_id, b.team_id, NULL::uuid
    FROM bookings b JOIN resources rs ON rs.id=b.resource_id
   WHERE b.checked_in_at IS NOT NULL AND b.status = 'confirmed' AND b.user_id IS NOT NULL
  UNION ALL
  SELECT a.id::text, 'academy_attendance', a.user_id, a.session_date::timestamptz, NULL::uuid, NULL::uuid, NULL::uuid, k.team_id, k.organisation_id
    FROM org_attendance a JOIN org_cohorts k ON k.id=a.cohort_id
   WHERE a.status = 'present'
  UNION ALL
  SELECT ta.id::text, 'team_checkin', ta.user_id, ta.checked_in_at, t.sport_id, ta.event_id, NULL::uuid, ta.team_id, t.organisation_id
    FROM team_attendance ta JOIN teams t ON t.id=ta.team_id
   WHERE ta.checked_in_at IS NOT NULL`;
