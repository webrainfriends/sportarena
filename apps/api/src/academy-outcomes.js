// Academy OS 3/3: evidence gathering and criteria checking for pathway levels. Everything here is read-time: attendance, coach-shared
// observations and official performances stay in their own tables; an assessment stores only references and the counts it looked at.
// There is deliberately no combined "talent score": every figure keeps its source, unit, window and whether it is official,
// coach-observed or academy-recorded.
import { many, one } from './db.js';
import { hasConsent } from './youth.js';

/** Attendance recorded by this academy's staff in the window. Percentage is null (missing), never 0, when nothing was recorded. */
export async function attendanceEvidence(orgId, athleteId, from, to) {
  const r = await one(
    `SELECT count(*) FILTER (WHERE a.status='present')::int AS present, count(*) FILTER (WHERE a.status='absent')::int AS absent, count(*) FILTER (WHERE a.status='excused')::int AS excused
       FROM org_attendance a JOIN org_cohorts k ON k.id=a.cohort_id
      WHERE k.organisation_id=$1 AND a.user_id=$2 AND a.session_date BETWEEN $3 AND $4`, [orgId, athleteId, from, to]);
  const counted = r.present + r.absent;
  return { source: 'academy_attendance', origin: 'academy_recorded', unit: '% of recorded sessions attended (excused sessions excluded)', from, to,
    present: r.present, absent: r.absent, excused: r.excused, pct: counted ? Math.round((r.present / counted) * 1000) / 10 : null };
}

/** Scored rubric observations the coach SHARED with the athlete (visibility 'player'); coach-private notes never enter. A young person needs coaching consent. */
export async function observationEvidence(orgId, athleteId, from, to) {
  if (!(await hasConsent(athleteId, 'coaching'))) return { source: 'coaching_observations', origin: 'coach_observed', consent: false, dimensions: [] };
  const rows = await many(
    `SELECT o.rubric_id, o.rubric_version, o.dimension_key, r.name AS rubric, count(*)::int AS n, round(avg(o.score)::numeric, 2)::float8 AS avg_score, array_agg(o.id ORDER BY o.observed_at) AS observation_ids,
            min(o.observed_at)::date AS first_on, max(o.observed_at)::date AS last_on
       FROM coaching_observations o JOIN coaching_rubrics r ON r.id=o.rubric_id
      WHERE o.athlete_id=$2 AND o.visibility='player' AND o.score IS NOT NULL AND o.observed_at::date BETWEEN $3 AND $4
        AND (o.coach_id IN (SELECT coach_id FROM org_cohorts WHERE organisation_id=$1 AND coach_id IS NOT NULL)
             OR o.coach_id IN (SELECT user_id FROM organisation_members WHERE organisation_id=$1 AND status='active' AND role IN ('coach','owner','admin')))
      GROUP BY o.rubric_id, o.rubric_version, o.dimension_key, r.name ORDER BY r.name, o.dimension_key`, [orgId, athleteId, from, to]);
  return { source: 'coaching_observations', origin: 'coach_observed', consent: true, from, to, dimensions: rows };
}

/** Approved-competition results only: the official record, labelled as such. */
export async function officialEvidence(athleteId, from, to) {
  const rows = await many(
    `SELECT s.slug AS sport, p.metric, count(*)::int AS n, round(avg(p.value)::numeric, 2)::float8 AS avg_value, array_agg(p.id ORDER BY p.recorded_at) AS performance_ids
       FROM performances p JOIN sports s ON s.id=p.sport_id
      WHERE p.user_id=$1 AND p.provenance='approved_competition' AND p.status='approved' AND p.recorded_at::date BETWEEN $2 AND $3 GROUP BY s.slug, p.metric ORDER BY s.slug, p.metric`, [athleteId, from, to]);
  return { source: 'performances', origin: 'official', from, to, results: rows };
}

export async function collectEvidence(orgId, athleteId, from, to) {
  const [attendance, observations, official] = await Promise.all([attendanceEvidence(orgId, athleteId, from, to), observationEvidence(orgId, athleteId, from, to), officialEvidence(athleteId, from, to)]);
  return { attendance, observations, official };
}

/** Check a level's configured criteria against the evidence. `met` is true/false, or null when the data needed is missing. */
export function checkCriteria(level, evidence) {
  const checks = [];
  if (level.min_attendance_pct != null) {
    const pct = evidence.attendance.pct;
    checks.push({ kind: 'attendance', label: `Attendance at least ${level.min_attendance_pct}%`, required: level.min_attendance_pct, actual: pct, met: pct == null ? null : pct >= level.min_attendance_pct, source: 'academy_attendance', origin: 'academy_recorded' });
  }
  for (const c of level.criteria ?? []) {
    const d = evidence.observations.dimensions.find((x) => x.rubric_id === c.rubric_id && x.dimension_key === c.dimension_key);
    const needN = c.min_observations ?? 1;
    const label = d ? `${d.rubric}: ${c.dimension_key}` : `Rubric dimension ${c.dimension_key}`;
    checks.push({ kind: 'rubric', label: `${label} average at least ${c.min_avg_score}`, required: c.min_avg_score, required_observations: needN, actual: d?.avg_score ?? null, observations: d?.n ?? 0,
      met: !d || d.n < needN ? null : d.avg_score >= c.min_avg_score, source: 'coaching_observations', origin: 'coach_observed', rubric_id: c.rubric_id, rubric_version: d?.rubric_version ?? null, observation_ids: d?.observation_ids ?? [] });
  }
  const evaluable = checks.filter((c) => c.met !== null);
  const outcome = !checks.length || !evaluable.length ? 'pending' : checks.every((c) => c.met === true) ? 'criteria_met' : evaluable.some((c) => c.met === true) ? 'criteria_partly_met' : 'criteria_not_met';
  return { checks, outcome, missing: checks.filter((c) => c.met === null).length };
}

export const levelOf = (versionRow, key) => (versionRow?.levels ?? []).find((l) => l.key === key) ?? null;

/** Who needs a pathway look and why. `coachId` limits it to that coach's own groups. */
export async function reviewQueue(orgId, { coachId = null } = {}) {
  const pathways = await many("SELECT * FROM academy_pathways WHERE organisation_id=$1 AND status='active'", [orgId]);
  const people = await many(
    `SELECT DISTINCT u.id AS athlete_id, u.display_name FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id JOIN users u ON u.id=e.user_id
      WHERE k.organisation_id=$1 AND e.status IN ('enrolled','paused') AND ($2::uuid IS NULL OR k.coach_id=$2) ORDER BY u.display_name, u.id`, [orgId, coachId]);
  const out = [];
  for (const p of pathways) for (const a of people) {
    const last = await one('SELECT decision, to_level, from_level, created_at FROM academy_progression_decisions WHERE pathway_id=$1 AND athlete_id=$2 ORDER BY created_at DESC, id DESC LIMIT 1', [p.id, a.athlete_id]);
    const asm = await one("SELECT id, status, outcome, created_at FROM academy_assessments WHERE pathway_id=$1 AND athlete_id=$2 AND status <> 'reassessed' ORDER BY created_at DESC, id DESC LIMIT 1", [p.id, a.athlete_id]);
    let reason = null;
    if (!last) reason = 'not_placed';
    else if (asm?.status === 'approved' && new Date(asm.created_at) > new Date(last.created_at)) reason = 'assessment_awaiting_decision';
    else if (asm?.status === 'submitted' || asm?.status === 'appealed') reason = 'assessment_awaiting_review';
    else if (!asm || Date.now() - new Date(asm.created_at) > 90 * 864e5) reason = 'assessment_due';
    if (reason) out.push({ pathway_id: p.id, pathway: p.title, athlete_id: a.athlete_id, athlete_name: a.display_name, reason, level: last ? last.to_level ?? last.from_level : null, last_assessment_on: asm?.created_at ?? null });
  }
  return out;
}
