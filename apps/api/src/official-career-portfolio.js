// Official career portfolio helpers (#1009): assembles career data from canonical tables
// into a denormalised portfolio shape. Never duplicates source-of-truth tables.
import { pool } from './db.js';

/** Aggregate career summary + per-sport breakdown for an official */
export async function assemblePortfolio(userId, { sportId = null, publicOnly = false } = {}) {
  const sportFilter = sportId ? 'AND sp.id=$2' : '';
  const privacyFilter = publicOnly ? 'AND e.is_private = false' : '';
  const params = sportId ? [userId, sportId] : [userId];

  const sportRows = await pool.query(`
    SELECT
      sp.id AS sport_id, sp.name AS sport_name, sp.emoji AS sport_emoji,
      count(*)::int                                                  AS total_matches,
      count(*) FILTER (WHERE ov.id IS NOT NULL)::int                AS verified_matches,
      array_agg(DISTINCT fo.role ORDER BY fo.role)                  AS roles
    FROM fixture_officials fo
    JOIN fixtures f   ON f.id = fo.fixture_id
    JOIN events e     ON e.id = f.event_id
    JOIN sports sp    ON sp.id = e.sport_id
    LEFT JOIN official_verifications ov ON ov.user_id = fo.user_id AND ov.sport_id = e.sport_id AND ov.status = 'verified'
    WHERE fo.user_id = $1
      AND fo.status IN ('accepted','completed')
      ${sportFilter}
      ${privacyFilter}
    GROUP BY sp.id, sp.name, sp.emoji
    ORDER BY total_matches DESC
  `, params);

  const gradeRows = await pool.query(`
    SELECT
      osg.id, osg.scheme_id, ogsc.display_name AS scheme_name,
      ogsc.governing_body, ogsc.governing_body_abbr, ogsc.country_scope,
      sp.id AS sport_id, sp.name AS sport_name,
      ogsgl.level_code, ogsgl.display_name AS level_name, ogsgl.rank_order,
      osg.verification_status, osg.assigned_role, osg.effective_from, osg.effective_until,
      osg.status AS grade_status
    FROM official_scheme_grades osg
    JOIN official_grade_scheme_catalogue ogsc ON ogsc.id = osg.scheme_id
    LEFT JOIN sports sp ON sp.id = ogsc.sport_id
    JOIN official_grade_scheme_levels ogsgl ON ogsgl.id = osg.level_id
    WHERE osg.user_id = $1 AND osg.status = 'active'
    ORDER BY ogsgl.rank_order, sp.name
  `, [userId]);

  const licenceRows = await pool.query(`
    SELECT
      fl.id, flt.name AS licence_type_name, flt.grade, flt.sport_id,
      sp.name AS sport_name, sp.emoji AS sport_emoji,
      o.name AS body_name,
      fl.status, fl.issued_on, fl.expires_on
    FROM fed_licences fl
    JOIN fed_licence_types flt ON flt.id = fl.licence_type_id
    JOIN organisations o      ON o.id = fl.body_id
    LEFT JOIN sports sp       ON sp.id = flt.sport_id
    WHERE fl.holder_id = $1 AND flt.holder_role = 'official' AND fl.status IN ('active','expired')
    ORDER BY flt.sport_id, fl.issued_on DESC
  `, [userId]);

  const verRow = await pool.query(`
    SELECT DISTINCT ON (ov.sport_id)
      ov.sport_id, sp.name AS sport_name, ov.status, ov.verified_at, ov.expires_at
    FROM official_verifications ov
    JOIN sports sp ON sp.id = ov.sport_id
    WHERE ov.user_id = $1
    ORDER BY ov.sport_id, ov.verified_at DESC NULLS LAST
  `, [userId]);

  const spanRow = await pool.query(`
    SELECT
      min(f.scheduled_at)::date AS first_match,
      max(f.scheduled_at)::date AS last_match,
      count(*)::int AS total
    FROM fixture_officials fo
    JOIN fixtures f ON f.id = fo.fixture_id
    JOIN events e   ON e.id = f.event_id
    WHERE fo.user_id = $1
      AND fo.status IN ('accepted','completed')
      ${publicOnly ? 'AND e.is_private = false' : ''}
  `, [userId]);

  const activityRows = await pool.query(`
    SELECT
      to_char(date_trunc('month', f.scheduled_at), 'YYYY-MM') AS month,
      sp.id AS sport_id, sp.name AS sport_name,
      count(*)::int AS matches
    FROM fixture_officials fo
    JOIN fixtures f ON f.id = fo.fixture_id
    JOIN events e   ON e.id = f.event_id
    JOIN sports sp  ON sp.id = e.sport_id
    WHERE fo.user_id = $1
      AND fo.status IN ('accepted','completed')
      AND f.scheduled_at >= now() - interval '24 months'
      ${publicOnly ? 'AND e.is_private = false' : ''}
    GROUP BY month, sp.id, sp.name
    ORDER BY month DESC
  `, [userId]);

  const span = spanRow.rows[0];
  const yearsActive = span?.first_match
    ? Math.max(1, Math.round((new Date(span.last_match) - new Date(span.first_match)) / (365.25 * 24 * 3600 * 1000) + 1))
    : 0;

  return {
    summary: {
      total_matches: span?.total ?? 0,
      sports_count: sportRows.rows.length,
      years_active: yearsActive,
      first_match: span?.first_match ?? null,
      last_match: span?.last_match ?? null,
    },
    by_sport: sportRows.rows,
    grades: gradeRows.rows,
    licences: licenceRows.rows,
    verifications: verRow.rows,
    activity_months: activityRows.rows,
  };
}

/** Strip private/hidden data for the public portfolio view */
export function publicFilter(data, settings) {
  return {
    summary: settings.show_match_count
      ? data.summary
      : { sports_count: data.summary.sports_count, years_active: data.summary.years_active },
    by_sport: data.by_sport.map((s) => ({
      sport_id: s.sport_id, sport_name: s.sport_name, sport_emoji: s.sport_emoji,
      total_matches: settings.show_match_count ? s.total_matches : null,
      verified_matches: settings.show_match_count ? s.verified_matches : null,
      roles: s.roles,
    })),
    grades: settings.show_grades ? data.grades : [],
    licences: settings.show_grades ? data.licences : [],
    verifications: data.verifications,
    activity_months: settings.show_activity_chart ? data.activity_months : [],
  };
}
