// Team / batch performance across the sessions a coach ran: one read that rolls the coaching journal up for a team or an academy batch.
// Aggregates only: attendance, load, plan delivery, evaluation coverage and the evaluation-sheet criteria. Nothing here names an athlete.
//  * Only the coach's own sessions count.
//  * A young person counts only while a guardian's coaching consent is live (CONSENT_OK); withdrawing it removes them from every future read.
//  * Per-criterion figures need a minimum group size (`min_cohort`), so a small group cannot reveal one person's score. The report that leaves the coach
//    always uses MIN_SHARED_COHORT; the coach's own screen may look at smaller groups and is told they are not shareable.
//  * Missing data stays missing: an unrecorded attendance is not an absence, an unscored criterion is not zero.
import { one, many } from './db.js';
import { badRequest, notFound } from './errors.js';
import { CONSENT_OK } from './coaching-shared.js';
import { requireTeam } from './capabilities/coaching-journal.js';

export const MIN_SHARED_COHORT = 5;
const PRESENT = ['present', 'late', 'left_early'];
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const round1 = (n) => Math.round(n * 10) / 10;
const AT = 'coalesce(r.scheduled_at, r.started_at, r.created_at)';

/** Which team or batch (academy cohort) the coach is asking about. The server checks the coach really runs it. */
export async function resolveScope(user, { team_id, cohort_id }) {
  if (Boolean(team_id) === Boolean(cohort_id)) throw badRequest('Choose a team or a batch');
  if (team_id) {
    const t = await requireTeam(user, team_id);
    return { kind: 'team', id: team_id, name: t.name, team_id, cohort_id: null, sport_id: t.sport_id ?? null };
  }
  const k = await one(
    `SELECT c.id, c.name, c.organisation_id FROM org_cohorts c WHERE c.id=$1 AND (c.coach_id=$2 OR EXISTS (
        SELECT 1 FROM academy_sessions s JOIN academy_session_staff st ON st.session_id=s.id
         WHERE s.cohort_id=c.id AND st.user_id=$2 AND st.role IN ('lead','assistant') AND st.status IN ('assigned','confirmed')))`, [cohort_id, user.id]);
  if (!k) throw notFound('Batch');
  return { kind: 'batch', id: k.id, name: k.name, team_id: null, cohort_id: k.id, organisation_id: k.organisation_id, sport_id: null };
}

/** The teams and batches this coach can analyse. */
export async function listScopes(user) {
  const teams = await many(
    `SELECT t.id, t.name, t.sport_id FROM teams t JOIN team_members m ON m.team_id=t.id AND m.user_id=$1 AND m.status='active' AND m.role='coach' ORDER BY t.name`, [user.id]);
  const batches = await many(
    `SELECT c.id, c.name, o.name AS organisation FROM org_cohorts c JOIN organisations o ON o.id=c.organisation_id
      WHERE c.status='active' AND (c.coach_id=$1 OR EXISTS (SELECT 1 FROM academy_sessions s JOIN academy_session_staff st ON st.session_id=s.id
            WHERE s.cohort_id=c.id AND st.user_id=$1 AND st.role IN ('lead','assistant') AND st.status IN ('assigned','confirmed'))) ORDER BY c.name`, [user.id]);
  return { teams, batches };
}

const recsCte = (scope) => `recs AS (SELECT r.* FROM coaching_session_records r WHERE r.coach_id=$1 AND ${scope.kind === 'team'
  ? 'r.team_id=$2'
  : "r.source_type='academy_session' AND r.source_id IN (SELECT id::text FROM academy_sessions WHERE cohort_id=$2)"}
   AND ${AT} >= $3::date AND ${AT} < ($4::date + 1))`;

/**
 * @param {{ team_id?: string, cohort_id?: string, from: string, to: string, rubric_id?: string, min_cohort?: number }} i
 */
export async function teamPerformance(user, i) {
  const scope = await resolveScope(user, i);
  const minCohort = i.min_cohort ?? 1;
  const base = [user.id, scope.id, i.from, i.to];
  const W = `WITH ${recsCte(scope)}`;

  const sessions = await one(`${W} SELECT count(*)::int AS total, count(*) FILTER (WHERE status='completed')::int AS completed, count(*) FILTER (WHERE plan_version>0)::int AS with_plan FROM recs`, base);

  const weeks = await many(
    `${W}, att AS (SELECT date_trunc('week', ${AT})::date AS wk, p.attendance, p.athlete_id FROM recs r JOIN coaching_session_participants p ON p.session_record_id=r.id WHERE ${CONSENT_OK('p.athlete_id')})
     SELECT wk::text, count(*) FILTER (WHERE attendance <> 'expected')::int AS recorded, count(*) FILTER (WHERE attendance = ANY($5::text[]))::int AS present, count(DISTINCT athlete_id)::int AS athletes FROM att GROUP BY wk ORDER BY wk`, [...base, PRESENT]);
  const recorded = weeks.reduce((s, w) => s + w.recorded, 0), present = weeks.reduce((s, w) => s + w.present, 0);

  const loadRows = await many(
    `${W}, blk AS (SELECT r.id, date_trunc('week', ${AT})::date AS wk, b, r.block_log FROM recs r JOIN coaching_session_plan_versions v ON v.session_record_id=r.id AND v.version=r.plan_version, jsonb_array_elements(v.blocks) b)
     SELECT wk::text, count(DISTINCT id)::int AS sessions, coalesce(sum((b->>'duration_min')::int),0)::int AS minutes,
            coalesce(sum(CASE WHEN b->>'target_rpe' IS NOT NULL THEN (b->>'duration_min')::int END),0)::int AS rpe_minutes,
            coalesce(sum(CASE WHEN b->>'target_rpe' IS NOT NULL THEN (b->>'duration_min')::int * (b->>'target_rpe')::int END),0)::int AS au,
            count(*)::int AS blocks,
            count(*) FILTER (WHERE block_log->(b->>'id')->>'status'='completed')::int AS completed,
            count(*) FILTER (WHERE block_log->(b->>'id')->>'status'='modified')::int AS modified,
            count(*) FILTER (WHERE block_log->(b->>'id')->>'status'='skipped')::int AS skipped
       FROM blk GROUP BY wk ORDER BY wk`, base);
  const sum = (k) => loadRows.reduce((s, w) => s + w[k], 0);
  const logged = sum('completed') + sum('modified') + sum('skipped');

  const roster = await one(`${W} SELECT count(DISTINCT p.athlete_id)::int AS n FROM recs r JOIN coaching_session_participants p ON p.session_record_id=r.id WHERE ${CONSENT_OK('p.athlete_id')}`, base);
  const goals = await many(
    `${W}, who AS (SELECT DISTINCT p.athlete_id FROM recs r JOIN coaching_session_participants p ON p.session_record_id=r.id WHERE ${CONSENT_OK('p.athlete_id')})
     SELECT g.status, count(*)::int AS n FROM coaching_goals g WHERE g.coach_id=$1 AND g.athlete_id IN (SELECT athlete_id FROM who) GROUP BY g.status`, base);
  const evals = await many(
    `${W} SELECT e.status, count(*)::int AS n FROM coaching_evaluations e WHERE e.coach_id=$1 AND e.session_record_id IN (SELECT id FROM recs) AND ${CONSENT_OK('e.athlete_id')} GROUP BY e.status`, base);
  const scored = await one(`${W} SELECT count(DISTINCT o.athlete_id)::int AS n FROM coaching_observations o WHERE o.coach_id=$1 AND o.session_record_id IN (SELECT id FROM recs) AND o.score IS NOT NULL AND ${CONSENT_OK('o.athlete_id')}`, base);

  // criteria of one evaluation sheet: the average of each person's first and latest score in the period, and the change between them
  let sheet = null, criteria = [];
  const rubricId = i.rubric_id ?? (await one(`${W} SELECT o.rubric_id FROM coaching_observations o WHERE o.coach_id=$1 AND o.session_record_id IN (SELECT id FROM recs) AND o.rubric_id IS NOT NULL AND o.score IS NOT NULL GROUP BY o.rubric_id ORDER BY count(*) DESC LIMIT 1`, base))?.rubric_id ?? null;
  if (rubricId) {
    sheet = await one('SELECT r.id, r.name, v.version, v.dimensions FROM coaching_rubrics r JOIN LATERAL (SELECT * FROM coaching_rubric_versions x WHERE x.rubric_id=r.id ORDER BY version DESC LIMIT 1) v ON true WHERE r.id=$1 AND r.coach_id=$2', [rubricId, user.id]);
    if (!sheet) throw notFound('Evaluation sheet');
    const obs = await many(
      `${W} SELECT o.athlete_id, o.dimension_key, o.score::float AS score FROM coaching_observations o
        WHERE o.coach_id=$1 AND o.session_record_id IN (SELECT id FROM recs) AND o.rubric_id=$5 AND o.score IS NOT NULL AND ${CONSENT_OK('o.athlete_id')} ORDER BY o.observed_at, o.id LIMIT 20000`, [...base, rubricId]);
    for (const d of sheet.dimensions) {
      const by = new Map();
      for (const o of obs) if (o.dimension_key === d.key) { const a = by.get(o.athlete_id) ?? []; a.push(o.score); by.set(o.athlete_id, a); }
      const n = by.size;
      const row = { key: d.key, name: d.name, pillar: d.pillar ?? null, scale_min: d.scale_min, scale_max: d.scale_max, direction: d.direction ?? 'higher_is_better', n };
      if (n < minCohort) { criteria.push({ ...row, suppressed: true, reason: 'small_group' }); continue; }
      if (!n) { criteria.push({ ...row, avg: null, change: null, n_change: 0 }); continue; }
      const last = [...by.values()].map((a) => a.at(-1));
      const multi = [...by.values()].filter((a) => a.length > 1);
      const avg = last.reduce((s, x) => s + x, 0) / last.length;
      const change = multi.length >= minCohort ? multi.reduce((s, a) => s + (a.at(-1) - a[0]), 0) / multi.length : null;
      criteria.push({ ...row, avg: round1(avg), first_avg: multi.length >= minCohort ? round1(multi.reduce((s, a) => s + a[0], 0) / multi.length) : null, change: change == null ? null : round1(change), n_change: multi.length });
    }
  }

  const sessionsList = await many(
    `${W} SELECT r.id, r.title, r.source_type, r.source_id, r.team_id, ${AT} AS at, r.status, r.plan_version,
        (SELECT count(*)::int FROM coaching_session_participants p WHERE p.session_record_id=r.id AND p.attendance <> 'expected') AS recorded,
        (SELECT count(*)::int FROM coaching_session_participants p WHERE p.session_record_id=r.id AND p.attendance = ANY($5::text[])) AS present
       FROM recs r ORDER BY ${AT} DESC, r.id LIMIT 60`, [...base, PRESENT]);

  const wkKey = (w) => w.wk;
  const loadByWeek = loadRows.map((w) => ({ week: wkKey(w), sessions: w.sessions, minutes: w.minutes, au: w.au, avg_rpe: w.rpe_minutes ? round1(w.au / w.rpe_minutes) : null }));
  const goalCount = (s) => goals.find((g) => g.status === s)?.n ?? 0;
  const evalCount = (s) => evals.find((e) => e.status === s)?.n ?? 0;
  const athletes = roster.n;
  return {
    scope: { kind: scope.kind, id: scope.id, name: scope.name }, period: { from: i.from, to: i.to },
    shareable: athletes >= MIN_SHARED_COHORT,
    min_cohort: minCohort,
    sessions: { total: sessions.total, completed: sessions.completed, with_plan: sessions.with_plan },
    athletes: { n: athletes, scored: scored.n, scored_rate: pct(scored.n, athletes) },
    attendance: { rate: pct(present, recorded), recorded_slots: recorded, by_week: weeks.map((w) => ({ week: wkKey(w), rate: pct(w.present, w.recorded), recorded: w.recorded })).filter((w) => w.recorded > 0), sessions_without_record: Math.max(0, sessions.total - sessionsList.filter((s) => s.recorded > 0).length) },
    load: { total_au: sum('au'), minutes: sum('minutes'), avg_rpe: sum('rpe_minutes') ? round1(sum('au') / sum('rpe_minutes')) : null, by_week: loadByWeek },
    delivery: { blocks: sum('blocks'), completed: sum('completed'), modified: sum('modified'), skipped: sum('skipped'), logged, completion_rate: pct(sum('completed') + sum('modified'), logged) },
    goals: { active: goalCount('active') + goalCount('planned'), achieved: goalCount('achieved'), paused: goalCount('paused') },
    evaluations: { draft: evalCount('draft'), shared: evalCount('shared') + evalCount('responded'), closed: evalCount('closed') },
    sheet: sheet ? { id: sheet.id, name: sheet.name, version: sheet.version } : null,
    criteria,
    sessions_list: sessionsList.map((s) => ({ id: s.id, title: s.title, source_type: s.source_type, source_id: s.source_id, team_id: s.team_id, at: s.at, status: s.status, attendance_rate: pct(s.present, s.recorded) })),
  };
}
