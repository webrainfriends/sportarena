import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin, PUBLIC_USER, sportBySlugOrId } from '../helpers.js';
import { hiddenYouth, relationships, requireRelationship } from '../coaching.js';
import { isYouth } from '../youth.js';
import { requireTeam } from './coaching-journal.js';

// Coaching goals, evidence, rubrics, measurements, actions, metrics and match context (issue #269, slice 2).
// Goal achievement is only ever a coach's decision; evidence is referenced, never copied; official match data is read, never written.
const TAG = 'Coaching journal';
const COACH = ['coach'];
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = (n) => z.string().trim().max(n);
const CATEGORIES = ['technical', 'tactical', 'physical', 'mental_performance', 'teamwork', 'match_objective', 'custom'];
const PRIORITY = ['low', 'medium', 'high'];
const MIN_COHORT = 5;

/** Coach may act for an athlete (current relationship) or a team (coaching authority). Returns the sport to default to. */
export async function authorise(user, { athlete_id, team_id }) {
  let sport_id = null;
  if (athlete_id) sport_id = (await requireRelationship(user, athlete_id))[0].sport_id;
  if (team_id) sport_id = (await requireTeam(user, team_id)).sport_id;
  if (athlete_id && team_id && !(await one("SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2 AND status='active'", [team_id, athlete_id]))) throw badRequest('That athlete is not on this team');
  return sport_id;
}
const scope = (x) => { if (!x.athlete_id && !x.team_id) throw badRequest('Name an athlete or a team'); };

// ------------------------------------------------------------------------------------------------ goals
const goalFields = {
  title: text(160).min(2), category: z.enum(CATEGORIES).default('technical'), criterion: text(1000).optional(), baseline: text(1000).optional(),
  priority: z.enum(PRIORITY).default('medium'), starts_on: day.optional(), review_on: day.optional(), ends_on: day.optional(),
  review_cadence_days: z.number().int().min(1).max(365).optional(),
  athlete_text: text(1000).optional().describe('wording the athlete may see; leave out to keep the goal private to you'),
  coach_notes: text(2000).optional(),
};

cap({
  name: 'create_coaching_goal', method: 'POST', path: '/coaching/goals', tag: TAG, auth: COACH, status: 201,
  summary: 'Define a development goal for an athlete you coach or a team, with a measurable criterion and review date. Goals are coaching goals, never medical or rehabilitation goals.',
  input: z.object({ athlete_id: id.optional(), team_id: id.optional(), plan_id: id.optional(), sport: z.string().optional(), ...goalFields }),
  async handler({ user }, i) {
    scope(i);
    let sportId = await authorise(user, i);
    if (i.sport) sportId = (await sportBySlugOrId(i.sport))?.id ?? sportId;
    if (i.plan_id && !(await one('SELECT 1 FROM training_plans WHERE id=$1 AND coach_id=$2 AND ($3::uuid IS NULL OR athlete_id=$3)', [i.plan_id, user.id, i.athlete_id ?? null]))) throw badRequest('That plan is not yours with this athlete');
    return tx(async (c) => {
      const g = (await c.query(
        `INSERT INTO coaching_goals(coach_id, athlete_id, team_id, sport_id, plan_id, title, category, criterion, baseline, priority, status, starts_on, review_on, ends_on, review_cadence_days, athlete_text, coach_notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'planned',$11,$12,$13,$14,$15,$16) RETURNING *`,
        [user.id, i.athlete_id ?? null, i.team_id ?? null, sportId, i.plan_id ?? null, i.title, i.category, i.criterion, i.baseline, i.priority, i.starts_on, i.review_on, i.ends_on, i.review_cadence_days, i.athlete_text, i.coach_notes])).rows[0];
      await c.query("INSERT INTO coaching_goal_events(goal_id, to_status, by_user) VALUES ($1,'planned',$2)", [g.id, user.id]);
      return g;
    });
  },
});

cap({
  name: 'review_coaching_goal', method: 'PATCH', path: '/coaching/goals/:id', tag: TAG, auth: COACH,
  summary: 'Edit a goal or record a review decision (planned/active/achieved/paused/stopped). Achieving a goal is your decision and needs a note naming why; nothing marks it automatically. Needs the row_version you loaded.',
  input: z.object({
    id, row_version: z.number().int().min(1), status: z.enum(['planned', 'active', 'achieved', 'paused', 'stopped']).optional(), review_note: text(1000).optional(),
    title: goalFields.title.optional(), category: z.enum(CATEGORIES).optional(), criterion: text(1000).optional(), baseline: text(1000).optional(), priority: z.enum(PRIORITY).optional(),
    review_on: day.nullable().optional(), ends_on: day.nullable().optional(), review_cadence_days: z.number().int().min(1).max(365).nullable().optional(), athlete_text: text(1000).nullable().optional(), coach_notes: text(2000).optional(),
  }),
  async handler({ user }, i) {
    const cur = await one('SELECT * FROM coaching_goals WHERE id=$1 AND coach_id=$2', [i.id, user.id]);
    if (!cur) throw notFound('Goal');
    await authorise(user, cur);
    if (i.status === 'achieved' && !i.review_note) throw badRequest('Say why this goal is achieved (review_note)');
    return tx(async (c) => {
      const g = (await c.query('SELECT * FROM coaching_goals WHERE id=$1 FOR UPDATE', [cur.id])).rows[0];
      if (g.row_version !== i.row_version) throw conflict('This goal was changed elsewhere - reload it first');
      const n = { ...g };
      for (const k of ['title', 'category', 'criterion', 'baseline', 'priority', 'review_on', 'ends_on', 'review_cadence_days', 'athlete_text', 'coach_notes']) if (i[k] !== undefined) n[k] = i[k];
      if (i.status) n.status = i.status;
      // a review with a cadence schedules the next one
      if (i.status && i.status !== g.status && ['active', 'paused'].includes(i.status) && n.review_cadence_days && i.review_on === undefined) n.review_on = new Date(Date.now() + n.review_cadence_days * 86400000).toISOString().slice(0, 10);
      const r = (await c.query(
        `UPDATE coaching_goals SET title=$2, category=$3, criterion=$4, baseline=$5, priority=$6, status=$7, review_on=$8, ends_on=$9, review_cadence_days=$10, athlete_text=$11, coach_notes=$12,
                achieved_at = CASE WHEN $7='achieved' THEN coalesce(achieved_at, now()) ELSE NULL END, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`,
        [g.id, n.title, n.category, n.criterion, n.baseline, n.priority, n.status, n.review_on, n.ends_on, n.review_cadence_days, n.athlete_text, n.coach_notes])).rows[0];
      if (n.status !== g.status || i.review_note) await c.query('INSERT INTO coaching_goal_events(goal_id, from_status, to_status, note, by_user) VALUES ($1,$2,$3,$4,$5)', [g.id, g.status, n.status, i.review_note, user.id]);
      return r;
    });
  },
});

cap({
  name: 'list_coaching_goals', method: 'GET', path: '/coaching/goals', tag: TAG, auth: COACH,
  summary: 'Your goals, filtered by athlete, team or status, ordered by review date then id.',
  input: z.object({ athlete_id: id.optional(), team_id: id.optional(), status: z.enum(['planned', 'active', 'achieved', 'paused', 'stopped']).optional(), ...page }),
  handler: ({ user }, i) => many(
    `SELECT g.*, (SELECT count(*)::int FROM coaching_goal_evidence e WHERE e.goal_id=g.id) AS evidence_count FROM coaching_goals g
      WHERE g.coach_id=$1 AND ($2::uuid IS NULL OR g.athlete_id=$2) AND ($3::uuid IS NULL OR g.team_id=$3) AND ($4::text IS NULL OR g.status=$4)
      ORDER BY g.review_on NULLS LAST, g.created_at DESC, g.id LIMIT $5 OFFSET $6`, [user.id, i.athlete_id ?? null, i.team_id ?? null, i.status ?? null, i.limit, i.offset]),
});

cap({
  name: 'get_coaching_goal', method: 'GET', path: '/coaching/goals/:id', tag: TAG, auth: COACH,
  summary: 'One goal with its decision history and the evidence attached to it, each item resolved from its source (nothing copied).', input: z.object({ id }),
  async handler({ user }, i) {
    const g = await one('SELECT * FROM coaching_goals WHERE id=$1 AND coach_id=$2', [i.id, user.id]);
    if (!g) throw notFound('Goal');
    const [events, ev] = await Promise.all([
      many('SELECT from_status, to_status, note, created_at FROM coaching_goal_events WHERE goal_id=$1 ORDER BY created_at, id', [g.id]),
      many('SELECT evidence_type, evidence_id, note, created_at FROM coaching_goal_evidence WHERE goal_id=$1 ORDER BY created_at, evidence_id', [g.id]),
    ]);
    const evidence = [];
    for (const e of ev) {
      let src = null;
      if (e.evidence_type === 'observation') src = await one('SELECT id, note AS summary, observed_at AS at, skill_tag, score FROM coaching_observations WHERE id=$1 AND coach_id=$2', [e.evidence_id, user.id]);
      else if (e.evidence_type === 'session_record') src = await one('SELECT id, title AS summary, coalesce(started_at, scheduled_at, created_at) AS at FROM coaching_session_records WHERE id=$1 AND coach_id=$2', [e.evidence_id, user.id]);
      else if (e.evidence_type === 'training_session') src = await one('SELECT x.id, x.title AS summary, x.completed_at AS at, x.status FROM training_sessions x JOIN training_plans p ON p.id=x.plan_id WHERE x.id=$1 AND p.coach_id=$2', [e.evidence_id, user.id]);
      else if (e.evidence_type === 'measurement') src = await one('SELECT id, metric || \': \' || value || \' \' || unit AS summary, measured_on AS at FROM coaching_measurements WHERE id=$1 AND coach_id=$2', [e.evidence_id, user.id]);
      else src = await one('SELECT f.id, f.status, f.scheduled_at AS at FROM fixtures f WHERE f.id=$1', [e.evidence_id]);
      evidence.push({ ...e, source: src, provenance: { observation: 'coach_observed', session_record: 'coach_observed', training_session: 'athlete_reported', measurement: 'coach_entered', fixture: 'official' }[e.evidence_type] });
    }
    return { goal: g, events, evidence };
  },
});

cap({
  name: 'add_coaching_goal_evidence', method: 'POST', path: '/coaching/goals/:id/evidence', tag: TAG, auth: COACH, status: 201,
  summary: 'Attach a record as evidence for a goal. It is referenced, not copied; you may only attach your own records for the same athlete or team. Adding evidence never changes the goal\'s status.',
  input: z.object({ id, evidence_type: z.enum(['observation', 'session_record', 'training_session', 'measurement', 'fixture']), evidence_id: z.string().max(80), note: text(500).optional() }),
  async handler({ user }, i) {
    const g = await one('SELECT * FROM coaching_goals WHERE id=$1 AND coach_id=$2', [i.id, user.id]);
    if (!g) throw notFound('Goal');
    await authorise(user, g);
    const who = [g.athlete_id, g.team_id];
    const checks = {
      observation: ['SELECT 1 FROM coaching_observations WHERE id::text=$1 AND coach_id=$2 AND ((athlete_id IS NOT NULL AND athlete_id=$3) OR (team_id IS NOT NULL AND team_id=$4))', [i.evidence_id, user.id, ...who]],
      session_record: ['SELECT 1 FROM coaching_session_records r WHERE r.id::text=$1 AND r.coach_id=$2 AND (r.team_id=$4 OR EXISTS (SELECT 1 FROM coaching_session_participants p WHERE p.session_record_id=r.id AND p.athlete_id=$3))', [i.evidence_id, user.id, ...who]],
      training_session: ['SELECT 1 FROM training_sessions x JOIN training_plans p ON p.id=x.plan_id WHERE x.id::text=$1 AND p.coach_id=$2 AND p.athlete_id=$3', [i.evidence_id, user.id, g.athlete_id]],
      measurement: ['SELECT 1 FROM coaching_measurements WHERE id::text=$1 AND coach_id=$2 AND athlete_id=$3', [i.evidence_id, user.id, g.athlete_id]],
      fixture: ['SELECT 1 FROM fixtures WHERE id::text=$1 AND (home_team_id=$3 OR away_team_id=$3)', [i.evidence_id, user.id, g.team_id]],
    };
    const [sql, args] = checks[i.evidence_type];
    if (!(await one(sql, args))) throw badRequest('That record is not yours or is not about this athlete/team');
    const r = await one('INSERT INTO coaching_goal_evidence(goal_id, evidence_type, evidence_id, note, added_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING *', [g.id, i.evidence_type, i.evidence_id, i.note, user.id]);
    return r ?? one('SELECT * FROM coaching_goal_evidence WHERE goal_id=$1 AND evidence_type=$2 AND evidence_id=$3', [g.id, i.evidence_type, i.evidence_id]);
  },
});

cap({
  name: 'my_coaching_goals', method: 'GET', path: '/me/coaching-goals', tag: TAG, auth: 'user',
  summary: 'Goals a coach chose to show you: only the wording written for you, never the coach\'s notes, criterion or evidence.', input: z.object({ ...page }),
  handler: ({ user }, i) => many(
    `SELECT g.id, g.title, g.category, g.athlete_text AS text, g.status, g.review_on, u.display_name AS coach_name FROM coaching_goals g JOIN users u ON u.id=g.coach_id
      WHERE g.athlete_id=$1 AND g.athlete_text IS NOT NULL AND g.status IN ('planned','active','achieved') ORDER BY g.review_on NULLS LAST, g.id LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]),
});

// ------------------------------------------------------------------------------------------------ rubrics and measurements
const dimension = z.object({
  key: z.string().regex(/^[a-z0-9_]{2,40}$/), name: text(80).min(2), description: text(300).optional(),
  scale_min: z.number().default(1), scale_max: z.number().default(5), labels: z.record(z.string(), text(80)).optional(),
  direction: z.enum(['higher_is_better', 'lower_is_better', 'target_range']).default('higher_is_better'),
}).refine((d) => d.scale_max > d.scale_min, 'scale_max must be above scale_min');

cap({
  name: 'save_coaching_rubric', method: 'POST', path: '/coaching/rubrics', tag: TAG, auth: COACH, status: 201,
  summary: 'Create a rubric, or send rubric_id to save a new version of it. Each score keeps the version it was given under, so history is never rewritten; scores on different scales are never mixed.',
  input: z.object({ rubric_id: id.optional(), name: text(80).min(2).optional(), sport: z.string().optional(), dimensions: z.array(dimension).min(1).max(20) }),
  async handler({ user }, i) {
    if (new Set(i.dimensions.map((d) => d.key)).size !== i.dimensions.length) throw badRequest('Dimension keys must be unique');
    return tx(async (c) => {
      let rubric;
      if (i.rubric_id) {
        rubric = (await c.query('SELECT * FROM coaching_rubrics WHERE id=$1 AND coach_id=$2 FOR UPDATE', [i.rubric_id, user.id])).rows[0];
        if (!rubric) throw notFound('Rubric');
      } else {
        if (!i.name) throw badRequest('name is required');
        const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
        rubric = (await c.query('INSERT INTO coaching_rubrics(coach_id, sport_id, name) VALUES ($1,$2,$3) RETURNING *', [user.id, sport?.id ?? null, i.name])).rows[0];
      }
      const version = (await c.query('SELECT coalesce(max(version),0)+1 AS v FROM coaching_rubric_versions WHERE rubric_id=$1', [rubric.id])).rows[0].v;
      await c.query('INSERT INTO coaching_rubric_versions(rubric_id, version, dimensions) VALUES ($1,$2,$3)', [rubric.id, version, JSON.stringify(i.dimensions)]);
      return { ...rubric, version, dimensions: i.dimensions };
    });
  },
});

cap({
  name: 'list_coaching_rubrics', method: 'GET', path: '/coaching/rubrics', tag: TAG, auth: COACH,
  summary: 'Your active rubrics with their latest version.', input: z.object({ ...page }),
  handler: ({ user }, i) => many(
    `SELECT r.id, r.name, r.sport_id, v.version, v.dimensions FROM coaching_rubrics r JOIN LATERAL (SELECT * FROM coaching_rubric_versions x WHERE x.rubric_id=r.id ORDER BY version DESC LIMIT 1) v ON true
      WHERE r.coach_id=$1 AND r.archived_at IS NULL ORDER BY r.name, r.id LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]),
});

cap({
  name: 'archive_coaching_rubric', method: 'DELETE', path: '/coaching/rubrics/:id', tag: TAG, auth: COACH,
  summary: 'Archive a rubric (kept, hidden, existing scores unchanged).', input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one('UPDATE coaching_rubrics SET archived_at=coalesce(archived_at, now()) WHERE id=$1 AND coach_id=$2 RETURNING id, archived_at', [i.id, user.id]);
    if (!r) throw notFound('Rubric');
    return r;
  },
});

cap({
  name: 'record_coaching_measurement', method: 'POST', path: '/coaching/measurements', tag: TAG, auth: COACH, status: 201,
  summary: 'Record a measurement you took (e.g. sprint time, in seconds) for an athlete you coach. A unit is mandatory and the value is always labelled coach-entered. A client_key makes retries safe.',
  input: z.object({ athlete_id: id, metric: text(60).min(2), unit: text(20).min(1), value: z.number(), higher_is_better: z.boolean().optional(), measured_on: day.optional(), note: text(500).optional(), session_record_id: id.optional(), client_key: z.string().min(8).max(80).optional() }),
  async handler({ user }, i) {
    const sportId = await authorise(user, { athlete_id: i.athlete_id });
    if (i.session_record_id && !(await one('SELECT 1 FROM coaching_session_records WHERE id=$1 AND coach_id=$2', [i.session_record_id, user.id]))) throw notFound('Coaching session');
    const row = await one(
      `INSERT INTO coaching_measurements(coach_id, athlete_id, sport_id, session_record_id, metric, unit, value, higher_is_better, measured_on, note, client_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9::date, current_date),$10,$11) ON CONFLICT (coach_id, client_key) WHERE client_key IS NOT NULL DO NOTHING RETURNING *`,
      [user.id, i.athlete_id, sportId, i.session_record_id ?? null, i.metric, i.unit, i.value, i.higher_is_better ?? null, i.measured_on ?? null, i.note, i.client_key ?? null]);
    return row ?? one('SELECT * FROM coaching_measurements WHERE coach_id=$1 AND client_key=$2', [user.id, i.client_key]);
  },
});

// ------------------------------------------------------------------------------------------------ actions
const nowOrNull = (s) => (s ? new Date(s) : null);

cap({
  name: 'create_coaching_action', method: 'POST', path: '/coaching/actions', tag: TAG, auth: COACH, status: 201,
  summary: 'Create a follow-up action for an athlete or team, optionally from a session, observation or goal. The owner is you, the athlete (they see it only if shared) or another coach of the team. A client_key makes retries safe.',
  input: z.object({
    athlete_id: id.optional(), team_id: id.optional(), owner_id: id.optional(), title: text(160).min(2), detail: text(1000).optional(), due_at: z.string().datetime({ offset: true }).optional(),
    priority: z.enum(PRIORITY).default('medium'), shared: z.boolean().default(false), follow_up_next_session: z.boolean().default(false),
    session_record_id: id.optional(), observation_id: id.optional(), goal_id: id.optional(), client_key: z.string().min(8).max(80).optional(),
  }),
  async handler({ user }, i) {
    if (i.client_key) { const dup = await one('SELECT * FROM coaching_actions WHERE coach_id=$1 AND client_key=$2', [user.id, i.client_key]); if (dup) return dup; }
    let athlete_id = i.athlete_id, team_id = i.team_id;
    // a link can supply the subject, but only if it is the coach's own record
    if (i.observation_id) {
      const o = await one('SELECT athlete_id, team_id FROM coaching_observations WHERE id=$1 AND coach_id=$2', [i.observation_id, user.id]);
      if (!o) throw notFound('Observation');
      athlete_id ??= o.athlete_id ?? undefined; team_id ??= o.team_id ?? undefined;
    }
    if (i.session_record_id && !(await one('SELECT 1 FROM coaching_session_records WHERE id=$1 AND coach_id=$2', [i.session_record_id, user.id]))) throw notFound('Coaching session');
    if (i.goal_id && !(await one('SELECT 1 FROM coaching_goals WHERE id=$1 AND coach_id=$2', [i.goal_id, user.id]))) throw notFound('Goal');
    scope({ athlete_id, team_id });
    await authorise(user, { athlete_id, team_id });
    const owner = i.owner_id ?? user.id;
    if (owner !== user.id && owner !== athlete_id && !(team_id && (await one("SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2 AND status='active' AND role='coach'", [team_id, owner])))) throw badRequest('The owner must be you, the athlete or a coach of the team');
    if (owner === athlete_id && owner !== user.id && !i.shared) i.shared = true; // an athlete cannot own something they cannot see
    const row = await one(
      `INSERT INTO coaching_actions(coach_id, athlete_id, team_id, owner_id, title, detail, due_at, priority, shared, follow_up_next_session, session_record_id, observation_id, goal_id, client_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (coach_id, client_key) WHERE client_key IS NOT NULL DO NOTHING RETURNING *`,
      [user.id, athlete_id ?? null, team_id ?? null, owner, i.title, i.detail, nowOrNull(i.due_at), i.priority, i.shared, i.follow_up_next_session, i.session_record_id ?? null, i.observation_id ?? null, i.goal_id ?? null, i.client_key ?? null]);
    return row ?? one('SELECT * FROM coaching_actions WHERE coach_id=$1 AND client_key=$2', [user.id, i.client_key]);
  },
});

cap({
  name: 'update_coaching_action', method: 'PATCH', path: '/coaching/actions/:id', tag: TAG, auth: 'user',
  summary: 'Update an action. The coach who created it can change anything while the coaching relationship is current (and can always cancel or complete it); an athlete who owns a shared action can only set its status and add a completion note. Completing an action never marks a goal achieved. Needs the row_version you loaded.',
  input: z.object({ id, row_version: z.number().int().min(1), status: z.enum(['open', 'in_progress', 'done', 'cancelled']).optional(), completion_note: text(1000).optional(), title: text(160).min(2).optional(), detail: text(1000).optional(), due_at: z.string().datetime({ offset: true }).nullable().optional(), priority: z.enum(PRIORITY).optional(), shared: z.boolean().optional(), follow_up_next_session: z.boolean().optional() }),
  async handler({ user }, i) {
    const a = await one('SELECT * FROM coaching_actions WHERE id=$1', [i.id]);
    const author = a && a.coach_id === user.id;
    const athlete = a && a.owner_id === user.id && a.athlete_id === user.id && a.shared;
    if (!a || !(author || athlete || (a.owner_id === user.id && a.shared))) throw notFound('Action');
    const limited = !author;
    if (limited && ['title', 'detail', 'due_at', 'priority', 'shared', 'follow_up_next_session'].some((k) => i[k] !== undefined)) throw forbidden('You can only update the status and completion note of an action you own');
    if (author && !['done', 'cancelled'].includes(i.status ?? '') && Object.keys(i).some((k) => !['id', 'row_version', 'status', 'completion_note'].includes(k) || (k === 'status'))) await authorise(user, a);
    return tx(async (c) => {
      const cur = (await c.query('SELECT * FROM coaching_actions WHERE id=$1 FOR UPDATE', [a.id])).rows[0];
      if (cur.row_version !== i.row_version) throw conflict('This action was changed elsewhere - reload it first');
      const n = { ...cur };
      for (const k of ['status', 'completion_note', 'title', 'detail', 'due_at', 'priority', 'shared', 'follow_up_next_session']) if (i[k] !== undefined) n[k] = k === 'due_at' ? nowOrNull(i[k]) : i[k];
      return (await c.query(
        `UPDATE coaching_actions SET status=$2, completion_note=$3, title=$4, detail=$5, due_at=$6, priority=$7, shared=$8, follow_up_next_session=$9,
                completed_at = CASE WHEN $2='done' THEN coalesce(completed_at, now()) ELSE NULL END, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`,
        [cur.id, n.status, n.completion_note, n.title, n.detail, n.due_at, n.priority, n.shared, n.follow_up_next_session])).rows[0];
    });
  },
});

cap({
  name: 'list_coaching_actions', method: 'GET', path: '/coaching/actions', tag: TAG, auth: COACH,
  summary: 'Actions you created, open first, then by due date. overdue=true keeps only open items past their due time.',
  input: z.object({ athlete_id: id.optional(), team_id: id.optional(), status: z.enum(['open', 'in_progress', 'done', 'cancelled']).optional(), overdue: z.coerce.boolean().optional(), ...page }),
  handler: ({ user }, i) => many(
    `SELECT a.*, u.display_name AS athlete_name, (a.status IN ('open','in_progress') AND a.due_at < now()) AS overdue FROM coaching_actions a LEFT JOIN users u ON u.id=a.athlete_id
      WHERE a.coach_id=$1 AND ($2::uuid IS NULL OR a.athlete_id=$2) AND ($3::uuid IS NULL OR a.team_id=$3) AND ($4::text IS NULL OR a.status=$4) AND (NOT coalesce($5,false) OR (a.status IN ('open','in_progress') AND a.due_at < now()))
      ORDER BY (a.status IN ('open','in_progress')) DESC, a.due_at NULLS LAST, a.id LIMIT $6 OFFSET $7`, [user.id, i.athlete_id ?? null, i.team_id ?? null, i.status ?? null, i.overdue ?? null, i.limit, i.offset]),
});

cap({
  name: 'my_coaching_actions', method: 'GET', path: '/me/coaching-actions', tag: TAG, auth: 'user',
  summary: 'Actions a coach assigned to you and shared with you.', input: z.object({ ...page }),
  handler: ({ user }, i) => many(
    `SELECT a.id, a.title, a.detail, a.due_at, a.priority, a.status, a.completion_note, a.row_version, u.display_name AS coach_name FROM coaching_actions a JOIN users u ON u.id=a.coach_id
      WHERE a.owner_id=$1 AND a.athlete_id=$1 AND a.shared ORDER BY (a.status IN ('open','in_progress')) DESC, a.due_at NULLS LAST, a.id LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]),
});

// ------------------------------------------------------------------------------------------------ metrics and comparisons
export const PROVENANCE = { coach_observed: 'Coach-observed', athlete_reported: 'Athlete-reported', coach_entered: 'Coach-entered measurement', derived: 'Derived from your records', official: 'Official match record' };

/** Points for one metric key in a window. Every series states its definition, unit, provenance and what is excluded as missing. */
export async function series(user, athleteId, key, from, to) {
  const win = [user.id, athleteId, from, `${to}T23:59:59Z`];
  if (key === 'attendance_rate') {
    const r = await one(`SELECT count(*) FILTER (WHERE p.attendance IN ('present','late','left_early'))::int AS attended, count(*) FILTER (WHERE p.attendance IN ('present','late','left_early','absent'))::int AS recorded, count(*) FILTER (WHERE p.attendance='expected')::int AS not_recorded,
        count(*) FILTER (WHERE p.attendance='excused')::int AS excused
      FROM coaching_session_participants p JOIN coaching_session_records r ON r.id=p.session_record_id WHERE r.coach_id=$1 AND p.athlete_id=$2 AND coalesce(r.started_at, r.scheduled_at, r.created_at) BETWEEN $3::timestamptz AND $4::timestamptz`, win);
    return { key, label: 'Attendance', unit: '%', provenance: 'coach_observed', definition: 'Sessions attended (present, late or left early) out of sessions with a recorded present/absent outcome. Excused and not-recorded sessions are left out, not counted as absent.', direction: 'higher_is_better', sample: r.recorded, excluded: { excused: r.excused, not_recorded: r.not_recorded }, value: r.recorded ? Math.round((1000 * r.attended) / r.recorded) / 10 : null };
  }
  if (key === 'plan_completion') {
    const r = await one(`SELECT count(*) FILTER (WHERE x.status='completed')::int AS done, count(*)::int AS recorded FROM training_sessions x JOIN training_plans p ON p.id=x.plan_id
      WHERE p.coach_id=$1 AND p.athlete_id=$2 AND x.status IN ('completed','skipped') AND x.completed_at BETWEEN $3::timestamptz AND $4::timestamptz`, win);
    return { key, label: 'Plan sessions completed', unit: '%', provenance: 'athlete_reported', definition: 'Plan sessions the athlete marked completed out of those they marked completed or skipped.', direction: 'higher_is_better', sample: r.recorded, excluded: {}, value: r.recorded ? Math.round((1000 * r.done) / r.recorded) / 10 : null };
  }
  if (key === 'effort_gap') {
    const r = await one(`SELECT count(*)::int AS n, avg(x.athlete_rpe - x.target_rpe) AS gap FROM training_sessions x JOIN training_plans p ON p.id=x.plan_id
      WHERE p.coach_id=$1 AND p.athlete_id=$2 AND x.status='completed' AND x.athlete_rpe IS NOT NULL AND x.target_rpe IS NOT NULL AND x.completed_at BETWEEN $3::timestamptz AND $4::timestamptz`, win);
    return { key, label: 'Reported effort minus target', unit: 'RPE points', provenance: 'athlete_reported', definition: 'Average of (athlete-reported effort − planned target effort) on completed sessions that have both. Non-clinical.', direction: 'target_range', sample: r.n, excluded: {}, value: r.n ? Math.round(Number(r.gap) * 10) / 10 : null };
  }
  if (key === 'action_completion') {
    const r = await one(`SELECT count(*) FILTER (WHERE status='done')::int AS done, count(*) FILTER (WHERE status<>'cancelled')::int AS total FROM coaching_actions WHERE coach_id=$1 AND athlete_id=$2 AND created_at BETWEEN $3::timestamptz AND $4::timestamptz`, win);
    return { key, label: 'Actions completed', unit: '%', provenance: 'derived', definition: 'Actions created in the period that are done, out of those not cancelled.', direction: 'higher_is_better', sample: r.total, excluded: {}, value: r.total ? Math.round((1000 * r.done) / r.total) / 10 : null };
  }
  if (key.startsWith('measurement:')) {
    const metric = key.slice(12);
    const pts = await many(`SELECT measured_on AS at, value::float8 AS value, unit, higher_is_better FROM coaching_measurements WHERE coach_id=$1 AND athlete_id=$2 AND metric=$5 AND measured_on BETWEEN $3::date AND $4::date ORDER BY measured_on, id`, [user.id, athleteId, from, to, metric]);
    const units = [...new Set(pts.map((p) => p.unit))];
    return { key, label: metric, unit: units.length === 1 ? units[0] : null, units, provenance: 'coach_entered', definition: `Values you entered for "${metric}".`, direction: pts[0]?.higher_is_better == null ? 'target_range' : pts[0].higher_is_better ? 'higher_is_better' : 'lower_is_better', sample: pts.length, excluded: {}, points: pts.map((p) => ({ at: p.at, value: p.value })), value: pts.length ? Math.round((pts.reduce((a, p) => a + p.value, 0) / pts.length) * 100) / 100 : null };
  }
  if (key.startsWith('rubric:')) {
    const [, rubricId, dim] = key.split(':');
    const pts = await many(`SELECT o.observed_at AS at, o.score::float8 AS score, o.rubric_version AS version FROM coaching_observations o WHERE o.coach_id=$1 AND o.athlete_id=$2 AND o.rubric_id=$5 AND o.dimension_key=$6 AND o.observed_at BETWEEN $3::timestamptz AND $4::timestamptz ORDER BY o.observed_at, o.id`, [...win, rubricId, dim]);
    const versions = [...new Set(pts.map((p) => p.version))];
    const def = await one('SELECT v.version, v.dimensions FROM coaching_rubric_versions v JOIN coaching_rubrics r ON r.id=v.rubric_id WHERE r.id=$1 AND r.coach_id=$2 ORDER BY v.version DESC LIMIT 1', [rubricId, user.id]);
    const d = def?.dimensions.find((x) => x.key === dim);
    if (!d) throw notFound('Rubric dimension');
    return { key, label: d.name, unit: `score ${d.scale_min}–${d.scale_max}`, provenance: 'coach_observed', definition: `Your subjective rubric score for "${d.name}". It is not an official statistic.`, direction: d.direction, versions, sample: pts.length, excluded: {}, points: pts.map((p) => ({ at: p.at, value: p.score, version: p.version })), value: pts.length ? Math.round((pts.reduce((a, p) => a + p.score, 0) / pts.length) * 100) / 100 : null };
  }
  throw badRequest('Unknown metric');
}

async function athleteAccess(user, athleteId) {
  const rels = await relationships(user.id, athleteId);
  if (!rels.length && !isAdmin(user)) throw forbidden('You have no active coaching relationship with this athlete');
  await requireRelationship(user, athleteId);
}

const dates = (i) => {
  const to = i.to ?? new Date().toISOString().slice(0, 10);
  const from = i.from ?? new Date(Date.parse(to) - 56 * 86400000).toISOString().slice(0, 10);
  if (to < from) throw badRequest('to is before from');
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > 366) throw badRequest('Range is limited to a year');
  return { from, to };
};

cap({
  name: 'get_coaching_metrics', method: 'GET', path: '/coaching/athletes/:athlete_id/metrics', tag: TAG, auth: COACH,
  summary: 'Metrics for one athlete over a date window (default 8 weeks), each with definition, unit, provenance, sample size and what was excluded as missing. Missing data is null, never zero, and subjective, self-reported and official values are never merged into one score.',
  input: z.object({ athlete_id: id, from: day.optional(), to: day.optional() }),
  async handler({ user }, i) {
    await athleteAccess(user, i.athlete_id);
    const { from, to } = dates(i);
    const keys = ['attendance_rate', 'plan_completion', 'effort_gap', 'action_completion'];
    const extra = await many(`SELECT DISTINCT 'measurement:' || metric AS k FROM coaching_measurements WHERE coach_id=$1 AND athlete_id=$2 AND measured_on BETWEEN $3::date AND $5::date
                               UNION SELECT DISTINCT 'rubric:' || rubric_id || ':' || dimension_key FROM coaching_observations WHERE coach_id=$1 AND athlete_id=$2 AND rubric_id IS NOT NULL AND observed_at BETWEEN $3::timestamptz AND $4::timestamptz ORDER BY 1`, [user.id, i.athlete_id, from, `${to}T23:59:59Z`, to]);
    const metrics = [];
    for (const k of [...keys, ...extra.map((x) => x.k)]) metrics.push({ ...(await series(user, i.athlete_id, k, from, to)), provenance_label: undefined });
    return { athlete_id: i.athlete_id, from, to, metrics: metrics.map((m) => ({ ...m, provenance_label: PROVENANCE[m.provenance] })) };
  },
});

const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

cap({
  name: 'compare_coaching_metrics', method: 'GET', path: '/coaching/athletes/:athlete_id/compare', tag: TAG, auth: COACH,
  summary: 'Compare one metric for an athlete: against the previous period of the same length (prior_period), against a target you give (target), or against your other athletes in the same team on the same measurement/rubric dimension (team). Refuses incompatible units or rubric versions, says when a sample is too small, and never ranks or names other athletes.',
  input: z.object({ athlete_id: id, metric: z.string().max(120), mode: z.enum(['prior_period', 'target', 'team']), target: z.coerce.number().optional(), team_id: id.optional(), from: day.optional(), to: day.optional() }),
  async handler({ user }, i) {
    await athleteAccess(user, i.athlete_id);
    const { from, to } = dates(i);
    const cur = await series(user, i.athlete_id, i.metric, from, to);
    const out = { metric: { key: cur.key, label: cur.label, unit: cur.unit, provenance: cur.provenance, provenance_label: PROVENANCE[cur.provenance], definition: cur.definition, direction: cur.direction }, window: { from, to }, current: { value: cur.value, sample: cur.sample } };
    if (cur.units?.length > 1) throw badRequest(`Values for this measurement use different units (${cur.units.join(', ')}); they cannot be compared`);
    if (cur.versions?.length > 1) throw badRequest('Scores in this window were given under different rubric versions; compare within one version');
    if (i.mode === 'target') {
      if (i.target === undefined) throw badRequest('target is required');
      if (cur.value == null) return { ...out, result: 'no_data', note: 'No values in this window; nothing is assumed.' };
      return { ...out, result: 'compared', target: i.target, difference: Math.round((cur.value - i.target) * 100) / 100 };
    }
    if (i.mode === 'prior_period') {
      const span = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
      const pTo = new Date(Date.parse(from) - 86400000).toISOString().slice(0, 10), pFrom = new Date(Date.parse(pTo) - (span - 1) * 86400000).toISOString().slice(0, 10);
      const prev = await series(user, i.athlete_id, i.metric, pFrom, pTo);
      if (prev.units?.length > 1 || (prev.unit && cur.unit && prev.unit !== cur.unit)) throw badRequest('The previous period uses a different unit');
      if (prev.versions?.length && cur.versions?.length && (prev.versions.length > 1 || prev.versions[0] !== cur.versions[0])) throw badRequest('The previous period used a different rubric version; the scales are not comparable');
      const base = { ...out, previous: { from: pFrom, to: pTo, value: prev.value, sample: prev.sample } };
      if (cur.value == null || prev.value == null) return { ...base, result: 'insufficient_data', note: 'One of the periods has no values, so no change is calculated (missing is not zero).' };
      return { ...base, result: 'compared', difference: Math.round((cur.value - prev.value) * 100) / 100 };
    }
    // team distribution: statistics only, youth excluded, small cohorts refused
    if (!i.metric.startsWith('measurement:') && !i.metric.startsWith('rubric:')) throw badRequest('Team comparison is available for measurements and rubric dimensions only');
    if (!i.team_id) throw badRequest('team_id is required');
    await requireTeam(user, i.team_id);
    const members = (await many("SELECT user_id FROM team_members WHERE team_id=$1 AND status='active' AND role IN ('player','captain')", [i.team_id])).map((m) => m.user_id);
    if (!members.includes(i.athlete_id)) throw badRequest('That athlete is not on this team');
    const hidden = await hiddenYouth(user, members);
    const values = [];
    for (const m of members) {
      if (m === i.athlete_id || hidden.has(m) || (await isYouth(m))) continue;
      if (!(await relationships(user.id, m)).length) continue;
      const s = await series(user, m, i.metric, from, to);
      if (s.value != null && s.unit === cur.unit && !(s.versions?.length > 1) && (!cur.versions?.length || s.versions?.[0] === cur.versions[0])) values.push(s.value);
    }
    if (values.length < MIN_COHORT) return { ...out, result: 'insufficient_sample', cohort: { size: values.length, minimum: MIN_COHORT }, note: `Needs at least ${MIN_COHORT} comparable athletes (adults you coach on this team); only ${values.length} have values.` };
    return { ...out, result: 'compared', cohort: { size: values.length, median: Math.round(median(values) * 100) / 100, min: Math.min(...values), max: Math.max(...values) }, difference_from_median: cur.value == null ? null : Math.round((cur.value - median(values)) * 100) / 100, note: 'Adults only; individuals are not shown or ranked.' };
  },
});

// ------------------------------------------------------------------------------------------------ match preparation and review
cap({
  name: 'get_coaching_match_context', method: 'GET', path: '/coaching/fixtures/:fixture_id', tag: TAG, auth: COACH,
  summary: 'Match preparation / debrief context for a fixture of a team you coach: the fixture and official result (read-only, labelled official), roster availability, active goals, open actions and your session record if one exists. Your coaching notes never change the official score or events.',
  input: z.object({ fixture_id: id, team_id: id }),
  async handler({ user }, i) {
    const f = await one(`SELECT f.id, f.round, f.status, f.scheduled_at, f.home_team_id, f.away_team_id, f.home_score, f.away_score, e.name AS event_name, h.name AS home_name, a.name AS away_name
                           FROM fixtures f JOIN events e ON e.id=f.event_id LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id WHERE f.id=$1`, [i.fixture_id]);
    if (!f || ![f.home_team_id, f.away_team_id].includes(i.team_id)) throw notFound('Fixture');
    await requireTeam(user, i.team_id);
    const mine = f.home_team_id === i.team_id;
    const [squad, goals, actions, record] = await Promise.all([
      many(`SELECT ${PUBLIC_USER}, m.role, m.jersey_no, m.availability, m.availability_note FROM team_members m JOIN users u ON u.id=m.user_id WHERE m.team_id=$1 AND m.status='active' AND m.role IN ('player','captain') ORDER BY u.display_name, u.id`, [i.team_id]),
      many("SELECT id, title, category, athlete_id, team_id, review_on FROM coaching_goals WHERE coach_id=$1 AND status='active' AND (team_id=$2 OR athlete_id IN (SELECT user_id FROM team_members WHERE team_id=$2 AND status='active')) ORDER BY review_on NULLS LAST, id LIMIT 50", [user.id, i.team_id]),
      many("SELECT id, title, athlete_id, team_id, due_at, priority FROM coaching_actions WHERE coach_id=$1 AND status IN ('open','in_progress') AND (team_id=$2 OR athlete_id IN (SELECT user_id FROM team_members WHERE team_id=$2 AND status='active')) ORDER BY due_at NULLS LAST, id LIMIT 50", [user.id, i.team_id]),
      one("SELECT id, status, team_summary FROM coaching_session_records WHERE coach_id=$1 AND source_type='fixture' AND source_id=$2", [user.id, f.id]),
    ]);
    const hidden = await hiddenYouth(user, squad.map((s) => s.id));
    return {
      fixture: { id: f.id, event: f.event_name, round: f.round, status: f.status, scheduled_at: f.scheduled_at, home: f.home_name, away: f.away_name, official_result: f.status === 'completed' ? { home_score: f.home_score, away_score: f.away_score, provenance: 'official' } : null, you_are: mine ? 'home' : 'away' },
      squad: squad.filter((s) => !hidden.has(s.id)), goals, actions, session_record: record,
      next: record ? null : { create_with: 'create_coaching_session', source_type: 'fixture', source_id: f.id, team_id: i.team_id },
    };
  },
});
