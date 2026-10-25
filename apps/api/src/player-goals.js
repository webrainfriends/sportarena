import { many, one } from './db.js';
import { RELATIONSHIP_SQL } from './coaching.js';
import { CONSENT_OK } from './coaching-shared.js';

// Reads for player-owned goals and self-directed plans (issue #325). The athlete owns every row; nothing here is a coach's record.
// Dates are returned as YYYY-MM-DD text so they never shift with the server's time zone.
export const GOAL_COLS = `g.id, g.owner_id, g.sport_id, g.title, g.category, g.why, g.measure, g.target_value::float8 AS target_value, g.unit, g.status,
  g.starts_on::text AS starts_on, g.review_on::text AS review_on, g.ends_on::text AS ends_on, g.review_cadence_days, g.claimed_at, g.row_version, g.created_at, g.updated_at`;
export const PLAN_COLS = `p.id, p.owner_id, p.sport_id, p.goal_id, p.title, p.intent, p.status, p.starts_on::text AS starts_on, p.review_on::text AS review_on, p.ends_on::text AS ends_on,
  p.row_version, p.created_at, p.updated_at`;
export const SESSION_COLS = `x.id, x.plan_id, x.starts_at, x.duration_min, x.kind, x.title, x.instructions, x.target_rpe, x.status, x.rpe, x.note, x.completed_at, x.row_version`;

/** Who the athlete's item is currently shared with (live shares only). */
const SHARED_WITH = (col, key) => `(SELECT coalesce(json_agg(json_build_object('share_id', sh.id, 'coach_id', sh.coach_id, 'coach_name', u.display_name, 'since', sh.created_at) ORDER BY sh.created_at, sh.id), '[]'::json)
    FROM player_shares sh JOIN users u ON u.id=sh.coach_id WHERE sh.${key}=${col}.id AND sh.revoked_at IS NULL)`;
const LATEST_ASSESSMENT = (col, key) => `(SELECT json_build_object('id', a.id, 'rating', a.rating, 'note', a.note, 'coach_name', u.display_name, 'at', a.created_at)
    FROM player_assessments a JOIN users u ON u.id=a.coach_id WHERE a.${key}=${col}.id ORDER BY a.created_at DESC, a.id LIMIT 1)`;
const ADOPTED_BY = (col, key) => `(SELECT coalesce(json_agg(json_build_object('coach_name', u.display_name, 'at', d.created_at) ORDER BY d.created_at, d.id), '[]'::json)
    FROM player_adoptions d JOIN users u ON u.id=d.coach_id WHERE d.${key}=${col}.id)`;

export const GOAL_SQL = `SELECT ${GOAL_COLS}, s.slug AS sport_slug, s.name AS sport,
    (SELECT count(*)::int FROM player_goal_progress q WHERE q.goal_id=g.id) AS progress_count,
    (SELECT q.value::float8 FROM player_goal_progress q WHERE q.goal_id=g.id AND q.value IS NOT NULL ORDER BY q.logged_on DESC, q.created_at DESC, q.id LIMIT 1) AS latest_value,
    ${SHARED_WITH('g', 'goal_id')} AS shared_with, ${LATEST_ASSESSMENT('g', 'goal_id')} AS latest_assessment, ${ADOPTED_BY('g', 'goal_id')} AS adopted_by
  FROM player_goals g LEFT JOIN sports s ON s.id=g.sport_id`;

export const PLAN_SQL = `SELECT ${PLAN_COLS}, s.slug AS sport_slug, s.name AS sport, pg.title AS goal_title,
    (SELECT count(*)::int FROM player_plan_sessions x WHERE x.plan_id=p.id AND x.status='completed') AS completed,
    (SELECT count(*)::int FROM player_plan_sessions x WHERE x.plan_id=p.id AND x.status IN ('scheduled','completed','skipped')) AS total,
    (SELECT min(x.starts_at) FROM player_plan_sessions x WHERE x.plan_id=p.id AND x.status='scheduled' AND x.starts_at > now()) AS next_session_at,
    ${SHARED_WITH('p', 'plan_id')} AS shared_with, ${LATEST_ASSESSMENT('p', 'plan_id')} AS latest_assessment, ${ADOPTED_BY('p', 'plan_id')} AS adopted_by
  FROM player_plans p LEFT JOIN sports s ON s.id=p.sport_id LEFT JOIN player_goals pg ON pg.id=p.goal_id`;

export const listGoals = (ownerId, { status = null, limit, offset }) => many(
  `${GOAL_SQL} WHERE g.owner_id=$1 AND ($2::text IS NULL OR g.status=$2)
    ORDER BY (g.status IN ('active','paused')) DESC, g.review_on NULLS LAST, g.created_at DESC, g.id LIMIT $3 OFFSET $4`, [ownerId, status, limit, offset]);

export const listPlans = (ownerId, { status = null, limit, offset }) => many(
  `${PLAN_SQL} WHERE p.owner_id=$1 AND ($2::text IS NULL OR p.status=$2)
    ORDER BY (p.status IN ('active','paused')) DESC, p.updated_at DESC, p.id LIMIT $3 OFFSET $4`, [ownerId, status, limit, offset]);

export const goalProgress = (goalId) => many(
  'SELECT id, value::float8 AS value, note, logged_on::text AS logged_on, created_at FROM player_goal_progress WHERE goal_id=$1 ORDER BY logged_on, created_at, id', [goalId]);
export const goalEvents = (goalId) => many(
  'SELECT from_status, to_status, note, created_at FROM player_goal_events WHERE goal_id=$1 ORDER BY created_at, id', [goalId]);
export const planSessions = (planId) => many(
  `SELECT ${SESSION_COLS} FROM player_plan_sessions x WHERE x.plan_id=$1 ORDER BY x.starts_at, x.id`, [planId]);

/** Coach assessments of one item, newest first. `coachId` narrows to one coach (a coach never sees another coach's). */
export const assessmentsOf = (kind, itemId, coachId = null) => many(
  `SELECT a.id, a.rating, a.note, a.created_at, a.coach_id, u.display_name AS coach_name FROM player_assessments a JOIN users u ON u.id=a.coach_id
    WHERE a.${kind === 'goal' ? 'goal_id' : 'plan_id'}=$1 AND ($2::uuid IS NULL OR a.coach_id=$2) ORDER BY a.created_at DESC, a.id`, [itemId, coachId]);

/**
 * Items a coach may currently see: a live share, a current coaching relationship with the owner, and (for a young person)
 * a guardian's current 'coaching' consent. Revoking the share, ending the relationship or withdrawing consent hides them at once.
 */
export const sharedFor = (coachId, kind, { athleteId = null, limit, offset }) => {
  const goal = kind === 'goal';
  const t = goal ? 'g' : 'p';
  return many(
    `${goal ? GOAL_SQL : PLAN_SQL} JOIN player_shares sh0 ON sh0.${goal ? 'goal_id' : 'plan_id'}=${t}.id AND sh0.revoked_at IS NULL AND sh0.coach_id=$1
      WHERE ($2::uuid IS NULL OR ${t}.owner_id=$2)
        AND EXISTS (SELECT 1 FROM (${RELATIONSHIP_SQL}) r WHERE r.coach_id=$1 AND r.athlete_id=${t}.owner_id)
        AND ${CONSENT_OK(`${t}.owner_id`)}
      ORDER BY sh0.created_at DESC, ${t}.id LIMIT $3 OFFSET $4`, [coachId, athleteId, limit, offset]).then(async (rows) => {
    const names = new Map((await many('SELECT id, display_name FROM users WHERE id = ANY($1::uuid[])', [rows.map((r) => r.owner_id)])).map((u) => [u.id, u.display_name]));
    const out = [];
    for (const r of rows) {
      // a coach never learns who else the athlete shared with, who else assessed, or who else adopted it
      const { shared_with, adopted_by, latest_assessment, ...rest } = r;
      const mine = (await assessmentsOf(kind, r.id, coachId))[0] ?? null;
      const adopted = await one(`SELECT id FROM player_adoptions WHERE ${goal ? 'goal_id' : 'plan_id'}=$1 AND coach_id=$2`, [r.id, coachId]);
      out.push({ ...rest, owner_name: names.get(r.owner_id), my_assessment: mine, adopted: !!adopted });
    }
    return out;
  });
};

export const oneGoal = (id, ownerId) => one(`${GOAL_SQL} WHERE g.id=$1 AND g.owner_id=$2`, [id, ownerId]);
export const onePlan = (id, ownerId) => one(`${PLAN_SQL} WHERE p.id=$1 AND p.owner_id=$2`, [id, ownerId]);
