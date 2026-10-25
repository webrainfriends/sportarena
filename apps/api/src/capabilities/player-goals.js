import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, sportBySlugOrId } from '../helpers.js';
import { relationships, requireCoachingConsent, requireRelationship, sessionKinds, RELATIONSHIP_SQL } from '../coaching.js';
import { requireGuardian } from '../youth.js';
import { notify } from '../notify.js';
import { toCsv } from '../csv.js';
import { assessmentsOf, goalEvents, goalProgress, listGoals, listPlans, oneGoal, onePlan, planSessions, sharedFor } from '../player-goals.js';

// Player-owned goals and self-directed training (issue #325). The athlete owns and writes these records; a coach sees one only through a
// live, revocable share, and what a coach says about it (an assessment) or builds from it (an adoption) is stored as the coach's own
// record, labelled as such, so the athlete's claim and the coach's view are never mixed.
const TAG = 'Player goals';
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = (n) => z.string().trim().max(n);
const CATEGORIES = ['technical', 'tactical', 'physical', 'mental_performance', 'teamwork', 'match_objective', 'custom'];
const GOAL_STATUS = ['active', 'paused', 'achieved', 'dropped'];
const PLAN_STATUS = ['active', 'paused', 'completed', 'dropped'];
const RATINGS = ['ahead', 'on_track', 'needs_attention', 'not_enough_evidence', 'confirmed_achieved'];
const key = z.string().trim().min(8).max(80).optional().describe('idempotency key: a retried request with the same key returns the original record instead of creating a second');
const today = () => new Date().toISOString().slice(0, 10);

const dates = (d) => {
  if (d.starts_on && d.ends_on && d.ends_on < d.starts_on) throw badRequest('The end date is before the start date');
  if (d.review_on && d.starts_on && d.review_on < d.starts_on) throw badRequest('The review date is before the start date');
};

/** Whose records are being read or written: the signed-in athlete, or (read-only) a verified guardian of a young person. */
async function subject(user, athleteId) {
  if (!athleteId || athleteId === user.id) return user.id;
  await requireGuardian(user, athleteId);
  await requireCoachingConsent(athleteId, 'a guardian viewing their goals and plans');
  await audit(null, user.id, 'read_child_player_goals', 'users', athleteId);
  return athleteId;
}

const sessionIn = z.object({
  starts_at: z.string().datetime({ offset: true }),
  duration_min: z.number().int().min(15).max(480),
  kind: z.enum(sessionKinds),
  title: text(120).min(2),
  instructions: text(2000).optional(),
  target_rpe: z.number().int().min(1).max(10).optional().describe('non-clinical perceived-effort target'),
  client_key: key,
});
const futureOnly = (ss) => { if (ss.some((s) => Date.parse(s.starts_at) <= Date.now())) throw badRequest('Planned sessions must be in the future'); };

// ------------------------------------------------------------------------------------------------ goals
const goalFields = {
  title: text(160).min(2), category: z.enum(CATEGORIES).default('technical'), why: text(1000).optional(), measure: text(1000).optional().describe('how you will know you got there'),
  target_value: z.number().finite().optional(), unit: text(20).min(1).optional(), starts_on: day.optional(), review_on: day.optional(), ends_on: day.optional(),
  review_cadence_days: z.number().int().min(1).max(365).optional(),
};
const nextReview = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

cap({
  name: 'create_player_goal', method: 'POST', path: '/me/goals', tag: TAG, status: 201,
  summary: 'Set a personal goal of your own, with an optional measurable target and review date. It is private to you until you choose to share it with a coach, and its status is always your own claim - a coach\'s view is recorded separately.',
  input: z.object({ ...goalFields, sport: z.string().optional(), client_key: key }),
  async handler({ user }, i) {
    dates(i);
    if (i.target_value !== undefined && !i.unit) throw badRequest('Say what the target is measured in (unit)');
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    if (i.sport && !sport) throw notFound('Sport');
    return tx(async (c) => {
      const r = (await c.query(
        `INSERT INTO player_goals(owner_id, sport_id, title, category, why, measure, target_value, unit, starts_on, review_on, ends_on, review_cadence_days, client_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (owner_id, client_key) WHERE client_key IS NOT NULL DO NOTHING RETURNING id`,
        [user.id, sport?.id ?? null, i.title, i.category, i.why, i.measure, i.target_value, i.unit, i.starts_on, i.review_on ?? (i.review_cadence_days ? nextReview(i.review_cadence_days) : null), i.ends_on, i.review_cadence_days, i.client_key ?? null])).rows[0];
      const goalId = r?.id ?? (await c.query('SELECT id FROM player_goals WHERE owner_id=$1 AND client_key=$2', [user.id, i.client_key])).rows[0].id;
      if (r) await c.query("INSERT INTO player_goal_events(goal_id, to_status, by_user) VALUES ($1,'active',$2)", [goalId, user.id]);
      return goalId;
    }).then((goalId) => oneGoal(goalId, user.id));
  },
});

cap({
  name: 'update_player_goal', method: 'PATCH', path: '/me/goals/:id', tag: TAG,
  summary: 'Edit your goal or change its status (active / paused / achieved / dropped). Marking it achieved is your own claim and needs a note; it does not confirm anything for a coach. Needs the row_version you loaded; a stale one is refused.',
  input: z.object({
    id, row_version: z.number().int().min(1), status: z.enum(GOAL_STATUS).optional(), status_note: text(1000).optional(),
    title: goalFields.title.optional(), category: z.enum(CATEGORIES).optional(), why: text(1000).nullable().optional(), measure: text(1000).nullable().optional(),
    target_value: z.number().finite().nullable().optional(), unit: text(20).min(1).nullable().optional(), review_on: day.nullable().optional(), ends_on: day.nullable().optional(),
    review_cadence_days: z.number().int().min(1).max(365).nullable().optional(),
  }),
  async handler({ user }, i) {
    if (i.status === 'achieved' && !i.status_note) throw badRequest('Say how you know you got there (status_note)');
    return tx(async (c) => {
      const g = (await c.query('SELECT *, starts_on::text AS starts_on, review_on::text AS review_on, ends_on::text AS ends_on FROM player_goals WHERE id=$1 AND owner_id=$2 FOR UPDATE', [i.id, user.id])).rows[0];
      if (!g) throw notFound('Goal');
      if (g.row_version !== i.row_version) throw conflict('This goal was changed elsewhere - reload it first');
      const n = { ...g };
      for (const k of ['title', 'category', 'why', 'measure', 'target_value', 'unit', 'review_on', 'ends_on', 'review_cadence_days']) if (i[k] !== undefined) n[k] = i[k];
      if (n.target_value !== null && n.target_value !== undefined && !n.unit) throw badRequest('Say what the target is measured in (unit)');
      dates({ starts_on: g.starts_on, ends_on: n.ends_on, review_on: n.review_on });
      if (i.status) n.status = i.status;
      if (i.status && i.status !== g.status && i.status === 'active' && n.review_cadence_days && i.review_on === undefined) n.review_on = nextReview(n.review_cadence_days);
      const r = (await c.query(
        `UPDATE player_goals SET title=$2, category=$3, why=$4, measure=$5, target_value=$6, unit=$7, status=$8, review_on=$9, ends_on=$10, review_cadence_days=$11,
                claimed_at = CASE WHEN $8='achieved' THEN coalesce(claimed_at, now()) ELSE NULL END, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING id`,
        [g.id, n.title, n.category, n.why, n.measure, n.target_value, n.unit, n.status, n.review_on, n.ends_on, n.review_cadence_days])).rows[0];
      if (n.status !== g.status || i.status_note) await c.query('INSERT INTO player_goal_events(goal_id, from_status, to_status, note, by_user) VALUES ($1,$2,$3,$4,$5)', [g.id, g.status, n.status, i.status_note, user.id]);
      return r.id;
    }).then((goalId) => oneGoal(goalId, user.id));
  },
});

cap({
  name: 'log_player_goal_progress', method: 'POST', path: '/me/goals/:id/progress', tag: TAG, status: 201,
  summary: 'Record your own progress on a goal: a measured value in the goal\'s unit and/or a note. Entries are append-only, always labelled as self-reported, and a retry with the same client_key does not duplicate.',
  input: z.object({ id, value: z.number().finite().optional(), note: text(1000).optional(), logged_on: day.optional(), client_key: key }),
  async handler({ user }, i) {
    if (i.value === undefined && !i.note) throw badRequest('Enter a value or a note');
    if (i.logged_on && i.logged_on > today()) throw badRequest('Progress cannot be dated in the future');
    return tx(async (c) => {
      const g = (await c.query('SELECT * FROM player_goals WHERE id=$1 AND owner_id=$2 FOR UPDATE', [i.id, user.id])).rows[0];
      if (!g) throw notFound('Goal');
      if (['achieved', 'dropped'].includes(g.status)) throw conflict(`This goal is ${g.status} - set it active again to log more progress`);
      if (i.value !== undefined && !g.unit) throw badRequest('This goal has no unit, so log a note instead or add a unit to the goal first');
      const r = (await c.query(
        `INSERT INTO player_goal_progress(goal_id, value, note, logged_on, client_key) VALUES ($1,$2,$3,coalesce($4::date, current_date),$5)
         ON CONFLICT (goal_id, client_key) WHERE client_key IS NOT NULL DO NOTHING RETURNING id`, [g.id, i.value, i.note, i.logged_on, i.client_key ?? null])).rows[0];
      const rowId = r?.id ?? (await c.query('SELECT id FROM player_goal_progress WHERE goal_id=$1 AND client_key=$2', [g.id, i.client_key])).rows[0].id;
      return (await c.query('SELECT id, goal_id, value::float8 AS value, note, logged_on::text AS logged_on, created_at, $2::text AS basis FROM player_goal_progress WHERE id=$1', [rowId, 'athlete_reported'])).rows[0];
    });
  },
});

cap({
  name: 'list_player_goals', method: 'GET', path: '/me/goals', tag: TAG,
  summary: 'Your personal goals (or, for a verified guardian, a young person\'s), open ones first then by review date. Each carries your own status, who it is shared with and the latest coach assessment, kept apart.',
  input: z.object({ athlete_id: id.optional(), status: z.enum(GOAL_STATUS).optional(), ...page }),
  async handler({ user }, i) {
    const owner = await subject(user, i.athlete_id);
    return listGoals(owner, i);
  },
});

cap({
  name: 'get_player_goal', method: 'GET', path: '/me/goals/:id', tag: TAG,
  summary: 'One goal with your progress entries (self-reported), status history and every coach assessment received (coach\'s view), each labelled with who wrote it.',
  input: z.object({ id, athlete_id: id.optional() }),
  async handler({ user }, i) {
    const owner = await subject(user, i.athlete_id);
    const g = await oneGoal(i.id, owner);
    if (!g) throw notFound('Goal');
    const [progress, events, assessments] = await Promise.all([goalProgress(g.id), goalEvents(g.id), assessmentsOf('goal', g.id)]);
    return { goal: g, progress: progress.map((p) => ({ ...p, basis: 'athlete_reported' })), events, assessments: assessments.map((a) => ({ ...a, basis: 'coach_assessment' })) };
  },
});

// ------------------------------------------------------------------------------------------------ plans
cap({
  name: 'create_player_plan', method: 'POST', path: '/me/personal-plans', tag: TAG, status: 201,
  summary: 'Make a training plan of your own, optionally tied to one of your goals, with sessions you schedule yourself. It is separate from any plan a coach proposes and stays private until you share it.',
  input: z.object({ title: text(120).min(2), intent: text(1000).optional(), sport: z.string().optional(), goal_id: id.optional(), starts_on: day.optional(), review_on: day.optional(), ends_on: day.optional(), sessions: z.array(sessionIn).max(50).default([]), client_key: key }),
  async handler({ user }, i) {
    dates(i); futureOnly(i.sessions);
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    if (i.sport && !sport) throw notFound('Sport');
    if (i.goal_id && !(await one('SELECT 1 FROM player_goals WHERE id=$1 AND owner_id=$2', [i.goal_id, user.id]))) throw badRequest('That goal is not yours');
    return tx(async (c) => {
      const r = (await c.query(
        `INSERT INTO player_plans(owner_id, sport_id, goal_id, title, intent, starts_on, review_on, ends_on, client_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (owner_id, client_key) WHERE client_key IS NOT NULL DO NOTHING RETURNING id`, [user.id, sport?.id ?? null, i.goal_id ?? null, i.title, i.intent, i.starts_on, i.review_on, i.ends_on, i.client_key ?? null])).rows[0];
      const planId = r?.id ?? (await c.query('SELECT id FROM player_plans WHERE owner_id=$1 AND client_key=$2', [user.id, i.client_key])).rows[0].id;
      if (r) for (const s of i.sessions) await c.query('INSERT INTO player_plan_sessions(plan_id, starts_at, duration_min, kind, title, instructions, target_rpe, client_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [planId, s.starts_at, s.duration_min, s.kind, s.title, s.instructions, s.target_rpe, s.client_key ?? null]);
      return planId;
    }).then((planId) => onePlan(planId, user.id));
  },
});

cap({
  name: 'update_player_plan', method: 'PATCH', path: '/me/personal-plans/:id', tag: TAG,
  summary: 'Edit your plan or change its status (active / paused / completed / dropped). Completing or dropping a plan cancels its future scheduled sessions (kept, not deleted); recorded sessions are never touched. Needs the row_version you loaded.',
  input: z.object({ id, row_version: z.number().int().min(1), status: z.enum(PLAN_STATUS).optional(), title: text(120).min(2).optional(), intent: text(1000).nullable().optional(), goal_id: id.nullable().optional(), review_on: day.nullable().optional(), ends_on: day.nullable().optional() }),
  async handler({ user }, i) {
    if (i.goal_id && !(await one('SELECT 1 FROM player_goals WHERE id=$1 AND owner_id=$2', [i.goal_id, user.id]))) throw badRequest('That goal is not yours');
    return tx(async (c) => {
      const p = (await c.query('SELECT *, starts_on::text AS starts_on, review_on::text AS review_on, ends_on::text AS ends_on FROM player_plans WHERE id=$1 AND owner_id=$2 FOR UPDATE', [i.id, user.id])).rows[0];
      if (!p) throw notFound('Plan');
      if (p.row_version !== i.row_version) throw conflict('This plan was changed elsewhere - reload it first');
      const n = { ...p };
      for (const k of ['title', 'intent', 'goal_id', 'review_on', 'ends_on', 'status']) if (i[k] !== undefined) n[k] = i[k];
      dates({ starts_on: p.starts_on, ends_on: n.ends_on, review_on: n.review_on });
      await c.query('UPDATE player_plans SET title=$2, intent=$3, goal_id=$4, review_on=$5, ends_on=$6, status=$7, row_version=row_version+1, updated_at=now() WHERE id=$1', [p.id, n.title, n.intent, n.goal_id, n.review_on, n.ends_on, n.status]);
      if (['completed', 'dropped'].includes(n.status)) await c.query("UPDATE player_plan_sessions SET status='cancelled' WHERE plan_id=$1 AND status='scheduled' AND starts_at > now()", [p.id]);
      return p.id;
    }).then((planId) => onePlan(planId, user.id));
  },
});

cap({
  name: 'add_player_plan_session', method: 'POST', path: '/me/personal-plans/:id/sessions', tag: TAG, status: 201,
  summary: 'Schedule a session in your own plan (future only). A retry with the same client_key returns the original.',
  input: z.object({ id }).merge(sessionIn),
  async handler({ user }, i) {
    futureOnly([i]);
    return tx(async (c) => {
      const p = (await c.query('SELECT * FROM player_plans WHERE id=$1 AND owner_id=$2 FOR UPDATE', [i.id, user.id])).rows[0];
      if (!p) throw notFound('Plan');
      if (['completed', 'dropped'].includes(p.status)) throw conflict(`This plan is ${p.status} - set it active again to add sessions`);
      const r = (await c.query(
        `INSERT INTO player_plan_sessions(plan_id, starts_at, duration_min, kind, title, instructions, target_rpe, client_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (plan_id, client_key) WHERE client_key IS NOT NULL DO NOTHING RETURNING id`, [p.id, i.starts_at, i.duration_min, i.kind, i.title, i.instructions, i.target_rpe, i.client_key ?? null])).rows[0];
      const sid = r?.id ?? (await c.query('SELECT id FROM player_plan_sessions WHERE plan_id=$1 AND client_key=$2', [p.id, i.client_key])).rows[0].id;
      if (r) await c.query('UPDATE player_plans SET updated_at=now() WHERE id=$1', [p.id]);
      return (await c.query('SELECT x.* FROM player_plan_sessions x WHERE x.id=$1', [sid])).rows[0];
    });
  },
});

cap({
  name: 'update_player_plan_session', method: 'PATCH', path: '/me/personal-plan-sessions/:id', tag: TAG,
  summary: 'Reschedule or cancel a future session, or record how it went (completed / skipped, effort 1-10, a non-clinical note). A recorded outcome cannot be changed; repeating the same outcome is accepted without overwriting it.',
  input: z.object({
    id, row_version: z.number().int().min(1).optional(), status: z.enum(['completed', 'skipped', 'cancelled']).optional(), rpe: z.number().int().min(1).max(10).optional(), note: text(1000).optional(),
    starts_at: z.string().datetime({ offset: true }).optional(), duration_min: z.number().int().min(15).max(480).optional(), title: text(120).min(2).optional(), instructions: text(2000).optional(), target_rpe: z.number().int().min(1).max(10).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s = (await c.query('SELECT x.*, p.owner_id FROM player_plan_sessions x JOIN player_plans p ON p.id=x.plan_id WHERE x.id=$1 AND p.owner_id=$2 FOR UPDATE OF x', [i.id, user.id])).rows[0];
      if (!s) throw notFound('Session');
      const edit = ['starts_at', 'duration_min', 'title', 'instructions', 'target_rpe'].some((k) => i[k] !== undefined);
      if (i.status && i.status !== 'cancelled' && s.status === i.status) return s; // a retry of the same outcome
      if (s.status !== 'scheduled') throw conflict(`Session is already ${s.status} and cannot be changed`);
      if (i.row_version !== undefined && s.row_version !== i.row_version) throw conflict('This session was changed elsewhere - reload it first');
      if (i.status === 'completed' || i.status === 'skipped') {
        if (edit) throw badRequest('Record the outcome or change the session, not both');
        if (new Date(s.starts_at).getTime() > Date.now() + 864e5) throw badRequest('You can record a session from the day it happens');
        return (await c.query('UPDATE player_plan_sessions SET status=$2, rpe=$3, note=$4, completed_at=now(), row_version=row_version+1 WHERE id=$1 RETURNING *', [s.id, i.status, i.rpe, i.note])).rows[0];
      }
      if (i.status === 'cancelled') return (await c.query("UPDATE player_plan_sessions SET status='cancelled', row_version=row_version+1 WHERE id=$1 RETURNING *", [s.id])).rows[0];
      if (!edit) throw badRequest('Nothing to change');
      if (i.starts_at && Date.parse(i.starts_at) <= Date.now()) throw badRequest('Planned sessions must be in the future');
      return (await c.query(
        'UPDATE player_plan_sessions SET starts_at=coalesce($2,starts_at), duration_min=coalesce($3,duration_min), title=coalesce($4,title), instructions=coalesce($5,instructions), target_rpe=coalesce($6,target_rpe), row_version=row_version+1 WHERE id=$1 RETURNING *',
        [s.id, i.starts_at, i.duration_min, i.title, i.instructions, i.target_rpe])).rows[0];
    });
  },
});

cap({
  name: 'list_player_plans', method: 'GET', path: '/me/personal-plans', tag: TAG,
  summary: 'Your self-directed training plans (or, for a verified guardian, a young person\'s), open ones first. Coach-proposed plans live under /training-plans.',
  input: z.object({ athlete_id: id.optional(), status: z.enum(PLAN_STATUS).optional(), ...page }),
  async handler({ user }, i) { return listPlans(await subject(user, i.athlete_id), i); },
});

cap({
  name: 'get_player_plan', method: 'GET', path: '/me/personal-plans/:id', tag: TAG,
  summary: 'A plan of your own with its sessions (outcomes are self-reported) and the coach assessments you have received.',
  input: z.object({ id, athlete_id: id.optional() }),
  async handler({ user }, i) {
    const owner = await subject(user, i.athlete_id);
    const p = await onePlan(i.id, owner);
    if (!p) throw notFound('Plan');
    const [sessions, assessments] = await Promise.all([planSessions(p.id), assessmentsOf('plan', p.id)]);
    return { plan: p, sessions: sessions.map((s) => ({ ...s, basis: 'athlete_reported' })), assessments: assessments.map((a) => ({ ...a, basis: 'coach_assessment' })) };
  },
});

// ------------------------------------------------------------------------------------------------ sharing
cap({
  name: 'list_my_coaches', method: 'GET', path: '/me/coaches', tag: TAG,
  summary: 'Coaches you currently work with (a confirmed hire, a team you share, a cohort they lead or a plan you accepted) - the only people you can share a goal or plan with.',
  input: z.object({}),
  handler: ({ user }) => many(
    `SELECT r.coach_id, u.display_name, array_agg(DISTINCT r.source ORDER BY r.source) AS sources FROM (${RELATIONSHIP_SQL}) r JOIN users u ON u.id=r.coach_id
      WHERE r.athlete_id=$1 AND r.coach_id <> $1 GROUP BY r.coach_id, u.display_name ORDER BY u.display_name, r.coach_id`, [user.id]),
});

cap({
  name: 'share_player_item', method: 'POST', path: '/me/shares', tag: TAG, status: 201,
  summary: 'Share one of your goals or plans with one of your coaches so they can see it, assess it and, if they choose, adopt it. Sharing is revocable at any time and the coach sees only that item. For a young person it needs a guardian\'s current coaching consent.',
  input: z.object({ goal_id: id.optional(), plan_id: id.optional(), coach_id: id }),
  async handler({ user }, i) {
    if (!!i.goal_id === !!i.plan_id) throw badRequest('Name either a goal or a plan to share');
    const kind = i.goal_id ? 'goal' : 'plan';
    const item = i.goal_id ? await oneGoal(i.goal_id, user.id) : await onePlan(i.plan_id, user.id);
    if (!item) throw notFound(kind === 'goal' ? 'Goal' : 'Plan');
    if (!(await relationships(i.coach_id, user.id)).length) throw badRequest('That person is not one of your coaches');
    try { await requireRelationship({ id: i.coach_id }, user.id); } catch { throw badRequest('A guardian has not allowed that coach to see your records'); }
    await requireCoachingConsent(user.id, 'sharing with a coach');
    return tx(async (c) => {
      const col = kind === 'goal' ? 'goal_id' : 'plan_id';
      const r = (await c.query(`INSERT INTO player_shares(${col}, coach_id, shared_by) VALUES ($1,$2,$3) ON CONFLICT (${col}, coach_id) WHERE revoked_at IS NULL AND ${col} IS NOT NULL DO NOTHING RETURNING *`, [item.id, i.coach_id, user.id])).rows[0];
      if (!r) return (await c.query(`SELECT * FROM player_shares WHERE ${col}=$1 AND coach_id=$2 AND revoked_at IS NULL`, [item.id, i.coach_id])).rows[0];
      await notify(c, i.coach_id, { kind: 'player_share', title: `A player shared a ${kind} with you: ${item.title}`, body: 'Open it from your athlete\'s goals to see it, assess it or adopt it.', data: { kind, id: item.id } });
      return r;
    });
  },
});

cap({
  name: 'revoke_player_share', method: 'DELETE', path: '/me/shares/:id', tag: TAG,
  summary: 'Stop sharing a goal or plan with a coach. Effective immediately for every read and action; the coach\'s past assessments stay with you and nothing is deleted.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const s = await one('SELECT * FROM player_shares WHERE id=$1 AND shared_by=$2', [i.id, user.id]);
    if (!s) throw notFound('Share');
    if (s.revoked_at) return s;
    return (await one('UPDATE player_shares SET revoked_at=now(), revoked_by=$2 WHERE id=$1 AND revoked_at IS NULL RETURNING *', [s.id, user.id])) ?? one('SELECT * FROM player_shares WHERE id=$1', [s.id]);
  },
});

// ------------------------------------------------------------------------------------------------ coach side
/** The item a coach may see right now: live share + current coaching relationship + (youth) current guardian consent. Anything else reads as not found. */
async function coachItem(user, kind, itemId) {
  const col = kind === 'goal' ? 'goal_id' : 'plan_id';
  const item = kind === 'goal'
    ? await one('SELECT g.*, g.starts_on::text AS starts_on, g.review_on::text AS review_on, g.ends_on::text AS ends_on FROM player_goals g JOIN player_shares sh ON sh.goal_id=g.id AND sh.coach_id=$2 AND sh.revoked_at IS NULL WHERE g.id=$1', [itemId, user.id])
    : await one('SELECT p.* FROM player_plans p JOIN player_shares sh ON sh.plan_id=p.id AND sh.coach_id=$2 AND sh.revoked_at IS NULL WHERE p.id=$1', [itemId, user.id]);
  if (!item) throw notFound(kind === 'goal' ? 'Shared goal' : 'Shared plan');
  try { await requireRelationship(user, item.owner_id); await requireCoachingConsent(item.owner_id, 'coaching'); } catch { throw notFound(kind === 'goal' ? 'Shared goal' : 'Shared plan'); }
  return { item, col };
}
const KIND = z.enum(['goal', 'plan']);

cap({
  name: 'list_shared_player_items', method: 'GET', path: '/coaching/player-shared', tag: TAG, auth: ['coach'],
  summary: 'Goals or plans players have shared with you, newest share first. Only items whose share is live, whose player you currently coach and, for a young person, whose guardian consent is in force; revoking or withdrawing hides them at once.',
  input: z.object({ kind: KIND.default('goal'), athlete_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const rows = await sharedFor(user.id, i.kind, { athleteId: i.athlete_id ?? null, limit: i.limit, offset: i.offset });
    const out = [];
    for (const r of rows) { try { await requireRelationship(user, r.owner_id); out.push(r); } catch { /* youth a guardian has not opened to this coach */ } }
    return out;
  },
});

cap({
  name: 'get_shared_player_item', method: 'GET', path: '/coaching/player-shared/:kind/:id', tag: TAG, auth: ['coach'],
  summary: 'One shared goal or plan with the player\'s self-reported progress or session outcomes (labelled as the player\'s claims) and your own assessments. The read is audited.',
  input: z.object({ kind: KIND, id }),
  async handler({ user }, i) {
    const { item } = await coachItem(user, i.kind, i.id);
    await audit(null, user.id, `read_shared_player_${i.kind}`, i.kind === 'goal' ? 'player_goals' : 'player_plans', item.id);
    const owner = (await one('SELECT display_name FROM users WHERE id=$1', [item.owner_id])).display_name;
    const mine = await assessmentsOf(i.kind, item.id, user.id);
    const adopted = !!(await one(`SELECT 1 FROM player_adoptions WHERE ${i.kind === 'goal' ? 'goal_id' : 'plan_id'}=$1 AND coach_id=$2`, [item.id, user.id]));
    if (i.kind === 'goal') {
      const g = await oneGoal(item.id, item.owner_id);
      const { shared_with, adopted_by, latest_assessment, ...rest } = g;
      return { kind: 'goal', owner_id: item.owner_id, owner_name: owner, goal: rest, progress: (await goalProgress(item.id)).map((p) => ({ ...p, basis: 'athlete_reported' })), assessments: mine.map((a) => ({ ...a, basis: 'coach_assessment' })), adopted };
    }
    const p = await onePlan(item.id, item.owner_id);
    const { shared_with, adopted_by, latest_assessment, ...rest } = p;
    return { kind: 'plan', owner_id: item.owner_id, owner_name: owner, plan: rest, sessions: (await planSessions(item.id)).map((s) => ({ ...s, basis: 'athlete_reported' })), assessments: mine.map((a) => ({ ...a, basis: 'coach_assessment' })), adopted };
  },
});

cap({
  name: 'assess_player_item', method: 'POST', path: '/coaching/player-shared/:kind/:id/assessments', tag: TAG, auth: ['coach'], status: 201,
  summary: 'Record your own assessment of a goal or plan a player shared with you. It is stored as your view, separate from the player\'s claim, and the player sees it labelled as yours. It never changes the player\'s status.',
  input: z.object({ kind: KIND, id, rating: z.enum(RATINGS), note: text(1000).min(1), client_key: key }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { item, col } = await coachItem(user, i.kind, i.id);
      // re-check the share under lock so a revocation racing this write wins
      const live = (await c.query(`SELECT 1 FROM player_shares WHERE ${col}=$1 AND coach_id=$2 AND revoked_at IS NULL FOR SHARE`, [item.id, user.id])).rows[0];
      if (!live) throw notFound(i.kind === 'goal' ? 'Shared goal' : 'Shared plan');
      const r = (await c.query(
        `INSERT INTO player_assessments(${col}, coach_id, rating, note, client_key) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (coach_id, client_key) WHERE client_key IS NOT NULL DO NOTHING RETURNING *`,
        [item.id, user.id, i.rating, i.note, i.client_key ?? null])).rows[0];
      if (!r) return { ...(await c.query('SELECT * FROM player_assessments WHERE coach_id=$1 AND client_key=$2', [user.id, i.client_key])).rows[0], basis: 'coach_assessment' };
      await notify(c, item.owner_id, { kind: 'player_assessment', title: `Your coach added their view on your ${i.kind}: ${item.title}`, body: i.note.slice(0, 200), data: { kind: i.kind, id: item.id } });
      return { ...r, basis: 'coach_assessment' };
    });
  },
});

cap({
  name: 'adopt_player_item', method: 'POST', path: '/coaching/player-shared/:kind/:id/adopt', tag: TAG, auth: ['coach'], status: 201,
  summary: 'Adopt a shared goal into your own coaching goals, or a shared plan into a draft training plan you author. Your copy is yours to edit and follows the normal coach-led flow (the player still accepts a plan); the player\'s original is untouched. Adopting twice returns the first adoption.',
  input: z.object({ kind: KIND, id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { item, col } = await coachItem(user, i.kind, i.id);
      const live = (await c.query(`SELECT 1 FROM player_shares WHERE ${col}=$1 AND coach_id=$2 AND revoked_at IS NULL FOR UPDATE`, [item.id, user.id])).rows[0];
      if (!live) throw notFound(i.kind === 'goal' ? 'Shared goal' : 'Shared plan');
      const prior = (await c.query(`SELECT * FROM player_adoptions WHERE ${col}=$1 AND coach_id=$2`, [item.id, user.id])).rows[0];
      if (prior) return { already_adopted: true, adoption: prior };
      let made;
      if (i.kind === 'goal') {
        const criterion = [item.measure, item.target_value !== null ? `Target: ${Number(item.target_value)} ${item.unit}` : null].filter(Boolean).join(' - ').slice(0, 1000) || null;
        const cg = (await c.query(
          `INSERT INTO coaching_goals(coach_id, athlete_id, sport_id, title, category, criterion, priority, status, starts_on, review_on, ends_on, review_cadence_days, athlete_text)
           VALUES ($1,$2,$3,$4,$5,$6,'medium','planned',$7,$8,$9,$10,$11) RETURNING *`,
          [user.id, item.owner_id, item.sport_id, item.title, item.category, criterion, item.starts_on, item.review_on, item.ends_on, item.review_cadence_days, item.title])).rows[0];
        await c.query("INSERT INTO coaching_goal_events(goal_id, to_status, note, by_user) VALUES ($1,'planned',$2,$3)", [cg.id, 'Adopted from the player\'s own goal', user.id]);
        made = { coaching_goal_id: cg.id, record: cg };
      } else {
        const ss = (await c.query("SELECT * FROM player_plan_sessions WHERE plan_id=$1 AND status='scheduled' AND starts_at > now() ORDER BY starts_at, id LIMIT 100", [item.id])).rows;
        const content = { targets: [], sessions: ss.map((s) => ({ starts_at: new Date(s.starts_at).toISOString(), duration_min: s.duration_min, kind: s.kind, title: s.title, ...(s.instructions ? { instructions: s.instructions } : {}), ...(s.target_rpe ? { target_rpe: s.target_rpe } : {}) })) };
        const tp = (await c.query('INSERT INTO training_plans(coach_id, athlete_id, sport_id, title, goal) VALUES ($1,$2,$3,$4,$5) RETURNING *', [user.id, item.owner_id, item.sport_id, item.title, item.intent])).rows[0];
        await c.query('INSERT INTO training_plan_revisions(plan_id, rev, title, goal, content) VALUES ($1,1,$2,$3,$4)', [tp.id, item.title, item.intent, JSON.stringify(content)]);
        made = { training_plan_id: tp.id, record: tp };
      }
      const adoption = (await c.query(`INSERT INTO player_adoptions(${col}, coach_id, coaching_goal_id, training_plan_id) VALUES ($1,$2,$3,$4) RETURNING *`, [item.id, user.id, made.coaching_goal_id ?? null, made.training_plan_id ?? null])).rows[0];
      await notify(c, item.owner_id, { kind: 'player_adopted', title: `Your coach adopted your ${i.kind}: ${item.title}`, body: i.kind === 'plan' ? 'They will propose it back to you for your answer.' : 'It now appears in your coaching goals.', data: { kind: i.kind, id: item.id } });
      return { already_adopted: false, adoption, ...made };
    });
  },
});

// ------------------------------------------------------------------------------------------------ export
cap({
  name: 'export_player_goals', method: 'GET', path: '/me/goals-export', tag: TAG,
  summary: 'Download your goals, progress, self-directed plans, session outcomes and the coach assessments you received as one CSV. Every row says whether it is your own claim or a coach\'s view. A verified guardian may export a young person\'s while coaching consent is in force.',
  input: z.object({ athlete_id: id.optional() }),
  async handler({ user }, i) {
    const owner = await subject(user, i.athlete_id);
    const goals = await many(`SELECT g.id, g.title, g.category, g.status, g.measure, g.target_value::float8 AS target_value, g.unit, g.review_on::text AS review_on, g.claimed_at FROM player_goals g WHERE g.owner_id=$1 ORDER BY g.created_at, g.id`, [owner]);
    const rows = [];
    for (const g of goals) {
      rows.push({ record: 'goal', title: g.title, date: g.review_on, status: g.status, value: g.target_value, unit: g.unit, note: g.measure, basis: 'athlete_claim', by: 'player' });
      for (const p of await goalProgress(g.id)) rows.push({ record: 'goal_progress', title: g.title, date: p.logged_on, status: '', value: p.value, unit: g.unit, note: p.note, basis: 'athlete_reported', by: 'player' });
      for (const a of await assessmentsOf('goal', g.id)) rows.push({ record: 'goal_assessment', title: g.title, date: new Date(a.created_at).toISOString().slice(0, 10), status: a.rating, value: '', unit: '', note: a.note, basis: 'coach_assessment', by: a.coach_name });
    }
    for (const p of await many('SELECT id, title, status, review_on::text AS review_on FROM player_plans WHERE owner_id=$1 ORDER BY created_at, id', [owner])) {
      rows.push({ record: 'plan', title: p.title, date: p.review_on, status: p.status, value: '', unit: '', note: '', basis: 'athlete_claim', by: 'player' });
      for (const s of await planSessions(p.id)) rows.push({ record: 'plan_session', title: `${p.title}: ${s.title}`, date: new Date(s.starts_at).toISOString().slice(0, 10), status: s.status, value: s.rpe ?? '', unit: s.rpe ? 'RPE 1-10' : '', note: s.note, basis: 'athlete_reported', by: 'player' });
      for (const a of await assessmentsOf('plan', p.id)) rows.push({ record: 'plan_assessment', title: p.title, date: new Date(a.created_at).toISOString().slice(0, 10), status: a.rating, value: '', unit: '', note: a.note, basis: 'coach_assessment', by: a.coach_name });
    }
    return { filename: 'my-goals-and-training.csv', rows: rows.length, csv: toCsv(['record', 'title', 'date', 'status', 'value', 'unit', 'note', 'basis', 'by'], rows) };
  },
});
