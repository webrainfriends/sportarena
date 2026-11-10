// Academy OS P0 / Gap 05 (#785): the multidisciplinary athlete development plan. It COORDINATES; it owns no athlete, goal, score, attendance,
// school or clinical record. Season objectives sit in six separate domains (technical, tactical, physical, mental, academic, personal), each
// judged on its own canonical metric with its source and unit and never merged into a single talent score. Every figure is resolved at read
// time from the record that owns it (coaching rubrics/goals, academy attendance, approved performances, the athlete's own school records, the
// athlete's minimal fit status, the #395 pathway) and is shown with a link back to it. Human sign-off and human decisions only.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { orgRole, orgFor } from '../org-access.js';
import { guardianLink, guardiansOf, isYouth, hasConsent } from '../youth.js';
import { flag } from '../academy.js';
import { notify } from '../notify.js';
import { attendanceEvidence, officialEvidence } from '../academy-outcomes.js';
import { sharedClearance } from './academy-athlete360.js';
import { DOMAINS, judge, judgeMilestones, tally } from '../academy-dev-trend.js';
import { frameworkFor, matchDimension, PHASE_KINDS, PROTECTED_PHASES } from '../academy-dev-catalogue.js';

const TAG = 'Academy';
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a calendar date (YYYY-MM-DD)');
const today = () => new Date().toISOString().slice(0, 10);
const STAFF = ['owner', 'admin'];
const WORKERS = ['owner', 'admin', 'coach', 'manager', 'evaluator'];
const DISCIPLINES = ['head_coach', 'coach', 'conditioning', 'psychology', 'education', 'nutrition', 'physio_provider', 'welfare_liaison', 'other'];
const KINDS = ['training_block', 'conditioning', 'psychology_session', 'tutoring', 'guardian_meeting', 'provider_referral', 'load_adjustment', 'video_review', 'other'];
const DECISIONS = ['continue_plan', 'change_focus', 'adjust_load', 'extra_academic_support', 'psychology_support', 'provider_referral', 'pathway_review', 'pause_plan', 'close_season'];
const CLEARANCE_SEES = ['head_coach', 'coach', 'conditioning', 'physio_provider'];
const SCHOOL_SEES = ['education', 'head_coach'];
const sealT = (s, col) => (s ? encrypt(s, `academy_dev.${col}`) : null);
const openT = (s, col) => (s ? decrypt(s, `academy_dev.${col}`) : null);
const text = (n, m = 1000) => z.string().trim().min(n).max(m);
/** A calendar date as YYYY-MM-DD. node-pg hands `date` columns over as local-midnight Dates, so read them with local getters. */
const D = (x) => { if (!x) return null; if (x instanceof Date) return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; return String(x).slice(0, 10); };

// ---------------------------------------------------------------------------------------------- access
/** Who is this caller in relation to the plan? null = no relation at all (the caller gets a 404, so existence is never leaked). */
async function accessTo(user, plan, c) {
  const db = c ?? { query: (t, p) => many(t, p).then((rows) => ({ rows })) };
  if (user.id === plan.athlete_id) return { kind: 'athlete', can_manage: false, domains: [], write_domains: [] };
  if (await guardianLink(user.id, plan.athlete_id, c)) return { kind: 'guardian', can_manage: false, domains: [], write_domains: [] };
  const role = await orgRole(user, plan.organisation_id, c);
  const contrib = (await db.query('SELECT * FROM academy_dev_contributors WHERE plan_id=$1 AND user_id=$2 AND removed_at IS NULL', [plan.id, user.id])).rows[0];
  if (role && STAFF.includes(role)) return { kind: 'staff', role, can_manage: true, domains: DOMAINS, write_domains: DOMAINS };
  if (user.id === plan.lead_id && role) return { kind: 'lead', role, can_manage: true, domains: DOMAINS, write_domains: DOMAINS };
  if (role === 'coach') {
    const own = (await db.query("SELECT 1 FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.organisation_id=$1 AND e.user_id=$2 AND k.coach_id=$3 AND e.status IN ('enrolled','paused') LIMIT 1", [plan.organisation_id, plan.athlete_id, user.id])).rows.length;
    if (own) return { kind: 'coach', role, can_manage: false, domains: DOMAINS, write_domains: contrib?.domains ?? [], discipline: contrib?.discipline ?? 'coach' };
  }
  if (contrib) {
    if (contrib.discipline === 'physio_provider') {
      const live = (await db.query("SELECT 1 FROM org_provider_associations WHERE organisation_id=$1 AND provider_id=$2 AND status='active' LIMIT 1", [plan.organisation_id, user.id])).rows.length;
      if (!live) return null;                                              // association revoked: access ends on the next request
    } else if (!role) return null;                                         // left the organisation: access ends on the next request
    const dm = contrib.discipline === 'physio_provider' ? [] : contrib.domains;
    return { kind: 'contributor', role, can_manage: false, domains: dm, write_domains: dm, discipline: contrib.discipline };
  }
  return null;
}
async function planFor(user, planId, c) {
  const db = c ? (t, p) => c.query(t, p).then((r) => r.rows[0]) : one;
  const plan = await db('SELECT * FROM academy_dev_plans WHERE id=$1', [planId]);
  if (!plan) throw notFound('Plan');
  const a = await accessTo(user, plan, c);
  if (!a) throw notFound('Plan');
  return { plan, a };
}
const mayWrite = (a, domain) => a.can_manage || a.write_domains.includes(domain);
const needManage = (a) => { if (!a.can_manage) throw forbidden('Only the technical director or the plan lead can do that'); };
const live = (plan) => { if (plan.archived_at) throw conflict('This plan is archived and read-only'); if (plan.status === 'closed') throw conflict('This season is closed; start a new plan for the next season'); };

async function inScope(user, role, orgId, athleteId) {
  const q = STAFF.includes(role)
    ? 'SELECT 1 FROM academy_applications WHERE organisation_id=$1 AND athlete_id=$2 UNION SELECT 1 FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.organisation_id=$1 AND e.user_id=$2 LIMIT 1'
    : "SELECT 1 FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.organisation_id=$1 AND e.user_id=$2 AND k.coach_id=$3 AND e.status IN ('enrolled','paused') LIMIT 1";
  if (!(await one(q, STAFF.includes(role) ? [orgId, athleteId] : [orgId, athleteId, user.id]))) throw notFound('Athlete');
}
/** Anyone who can own work in the plan: an active org member or an academy-associated provider. */
async function assertWorker(orgId, userId, what, { providers = false } = {}) {
  const m = await one("SELECT role FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [orgId, userId]);
  if (m && WORKERS.includes(m.role)) return;
  if (providers && await one("SELECT 1 AS x FROM org_provider_associations WHERE organisation_id=$1 AND provider_id=$2 AND status='active'", [orgId, userId])) return;
  throw badRequest(`${what} must be an active member of this academy${providers ? ' or one of its associated providers' : ''}`);
}

// ---------------------------------------------------------------------------------------------- evidence (read time, never stored)
const rubricSeries = (athleteId, orgId, rubricId, dim, from, to) => many(
  `SELECT to_char(date_trunc('month', o.observed_at), 'YYYY-MM') AS month, round(avg(o.score)::numeric, 2)::float8 AS value, count(*)::int AS n
     FROM coaching_observations o WHERE o.athlete_id=$2 AND o.rubric_id=$3 AND o.dimension_key=$4 AND o.visibility='player' AND o.score IS NOT NULL AND o.observed_at::date BETWEEN $5 AND $6
      AND (o.coach_id IN (SELECT coach_id FROM org_cohorts WHERE organisation_id=$1 AND coach_id IS NOT NULL) OR o.coach_id IN (SELECT user_id FROM organisation_members WHERE organisation_id=$1 AND status='active' AND role IN ('coach','owner','admin')))
    GROUP BY 1 ORDER BY 1`, [orgId, athleteId, rubricId, dim, from, to]);

/** The current figure for an objective's metric, from the record that owns it. Returns {value,n,series,source,unit,origin,...} or a reason it is missing. */
async function measure(plan, ob, to) {
  const from = D(plan.starts_on);
  const base = { metric_kind: ob.metric_kind };
  if (ob.metric_kind === 'rubric') {
    if (!(await hasConsent(plan.athlete_id, 'coaching'))) return { ...base, value: null, n: 0, series: [], missing: 'no_consent', source: 'coaching_observations', origin: 'coach_observed', unit: 'rubric score' };
    const series = await rubricSeries(plan.athlete_id, plan.organisation_id, ob.rubric_id, ob.dimension_key, from, to);
    const total = series.reduce((s, r) => s + r.n, 0);
    const last = series.at(-1);
    const r = await one('SELECT r.name, v.dimensions FROM coaching_rubrics r JOIN coaching_rubric_versions v ON v.rubric_id=r.id WHERE r.id=$1 ORDER BY v.version DESC LIMIT 1', [ob.rubric_id]);
    const dim = (r?.dimensions ?? []).find((d) => d.key === ob.dimension_key);
    return { ...base, value: last ? Math.round((series.reduce((s, x) => s + x.value * x.n, 0) / total) * 100) / 100 : null, latest: last?.value ?? null, n: total, series, source: 'coaching_observations', origin: 'coach_observed',
      unit: 'rubric score (coach-shared observations)', label: r ? `${r.name}${dim ? ` · ${dim.name}` : ''}` : null, link: { type: 'rubric', id: ob.rubric_id } };
  }
  if (ob.metric_kind === 'attendance') {
    const e = await attendanceEvidence(plan.organisation_id, plan.athlete_id, from, to);
    const rows = await many(
      `SELECT to_char(date_trunc('month', a.session_date), 'YYYY-MM') AS month, round(100.0*count(*) FILTER (WHERE a.status='present')/NULLIF(count(*) FILTER (WHERE a.status IN ('present','absent')),0), 1)::float8 AS value, count(*) FILTER (WHERE a.status IN ('present','absent'))::int AS n
         FROM org_attendance a JOIN org_cohorts k ON k.id=a.cohort_id WHERE k.organisation_id=$1 AND a.user_id=$2 AND a.session_date BETWEEN $3 AND $4 GROUP BY 1 ORDER BY 1`, [plan.organisation_id, plan.athlete_id, from, to]);
    return { ...base, value: e.pct, n: e.present + e.absent, series: rows.filter((r) => r.value !== null), source: 'academy_attendance', origin: 'academy_recorded', unit: '% of recorded sessions attended (excused excluded)', link: { type: 'attendance' } };
  }
  if (ob.metric_kind === 'official') {
    const rows = await many(
      `SELECT to_char(date_trunc('month', p.recorded_at), 'YYYY-MM') AS month, round(avg(p.value)::numeric, 2)::float8 AS value, count(*)::int AS n
         FROM performances p WHERE p.user_id=$1 AND p.metric=$2 AND p.provenance='approved_competition' AND p.status='approved' AND p.recorded_at::date BETWEEN $3 AND $4 GROUP BY 1 ORDER BY 1`, [plan.athlete_id, ob.official_metric, from, to]);
    const n = rows.reduce((s, r) => s + r.n, 0);
    return { ...base, value: n ? Math.round((rows.reduce((s, r) => s + r.value * r.n, 0) / n) * 100) / 100 : null, latest: rows.at(-1)?.value ?? null, n, series: rows, source: 'performances (approved competition)', origin: 'official', unit: `${ob.official_metric} (approved competition results)`, link: { type: 'performances', metric: ob.official_metric } };
  }
  if (ob.metric_kind === 'coach_goal') {
    const g = await one('SELECT id, title, status, review_on, athlete_text FROM coaching_goals WHERE id=$1 AND athlete_id=$2', [ob.coach_goal_id, plan.athlete_id]);
    return { ...base, value: null, n: 0, series: [], goal: g ? { id: g.id, title: g.title, status: g.status, review_on: g.review_on } : null, source: 'coaching_goals', origin: 'coach_observed', unit: 'coach goal status', link: { type: 'coaching_goal', id: ob.coach_goal_id } };
  }
  return { ...base, value: null, n: 0, series: [], source: 'plan milestones', origin: 'academy_recorded', unit: 'milestones completed' };
}

async function judgeObjective(plan, ob, milestones, asOf) {
  const m = await measure(plan, ob, asOf < D(plan.ends_on) ? asOf : D(plan.ends_on));
  const ms = judgeMilestones(milestones, asOf);
  let verdict;
  if (ob.metric_kind === 'milestones') verdict = { state: ms.state, progress_pct: ms.progress_pct, expected: null, low_evidence: false, lower_is_better: false };
  else if (ob.metric_kind === 'coach_goal') {
    const s = m.goal?.status;
    verdict = { state: !m.goal ? 'no_data' : s === 'achieved' ? 'achieved' : s === 'stopped' || s === 'paused' ? 'behind' : 'tracking', progress_pct: s === 'achieved' ? 100 : null, expected: null, low_evidence: false, lower_is_better: false };
  } else verdict = judge({ baseline: ob.baseline_value, current: m.value, target: ob.target_value, n: m.n, from: D(plan.starts_on), to: D(plan.ends_on), today: asOf });
  return { ...verdict, ...(m.missing ? { missing: m.missing } : {}), evidence: m, milestones: ms };
}

// ---------------------------------------------------------------------------------------------- the orchestration view
async function buildView(user, plan, a, { asOf = today() } = {}) {
  const family = a.kind === 'athlete' || a.kind === 'guardian';
  const provider = a.kind === 'contributor' && !a.domains.length;
  const athlete = await one('SELECT id, handle, display_name, avatar_emoji, avatar_color, avatar_url FROM users WHERE id=$1', [plan.athlete_id]);
  const lead = await one('SELECT id, display_name, avatar_emoji, avatar_color FROM users WHERE id=$1', [plan.lead_id]);
  const org = await one('SELECT id, name FROM organisations WHERE id=$1', [plan.organisation_id]);
  const people = new Map();
  const nameOf = async (uid) => { if (!uid) return null; if (!people.has(uid)) people.set(uid, (await one('SELECT id, display_name, avatar_emoji, avatar_color FROM users WHERE id=$1', [uid]))); return people.get(uid); };

  const objs = await many('SELECT * FROM academy_dev_objectives WHERE plan_id=$1 AND archived_at IS NULL ORDER BY position, created_at, id', [plan.id]);
  const mss = await many('SELECT * FROM academy_dev_milestones WHERE objective_id = ANY($1) AND archived_at IS NULL ORDER BY due_on, id', [objs.map((o) => o.id)]);
  const ints = await many('SELECT * FROM academy_dev_interventions WHERE plan_id=$1 ORDER BY (status IN (\'done\',\'cancelled\')), due_on NULLS LAST, created_at, id', [plan.id]);
  const seeObj = (o) => (family ? o.visibility === 'athlete' : provider ? false : a.domains.includes(o.domain) || o.owner_id === user.id);
  const seeInt = (i) => (family ? i.visibility === 'athlete' : provider ? i.owner_id === user.id : a.can_manage || a.kind === 'coach' || i.owner_id === user.id || (i.objective_id && objs.find((o) => o.id === i.objective_id && a.domains.includes(o.domain))));

  const domains = Object.fromEntries(DOMAINS.map((d) => [d, { objectives: [], states: tally([]) }]));
  const states = [];
  for (const o of objs.filter(seeObj)) {
    const own = mss.filter((m) => m.objective_id === o.id);
    const j = await judgeObjective(plan, o, own.map((m) => ({ ...m, due_on: D(m.due_on) })), asOf);
    states.push(j.state);
    domains[o.domain].objectives.push({
      id: o.id, domain: o.domain, competency: o.competency, competency_key: o.competency_key, title: o.title, rationale: family ? null : openT(o.rationale_enc, 'rationale'), metric_kind: o.metric_kind, target_value: o.target_value === null ? null : Number(o.target_value),
      baseline_value: o.baseline_value === null ? null : Number(o.baseline_value), baseline_on: D(o.baseline_on), due_on: D(o.due_on), status: o.status, visibility: o.visibility, row_version: o.row_version,
      owner: await nameOf(o.owner_id), state: j.state, progress_pct: j.progress_pct, expected: j.expected, low_evidence: j.low_evidence, lower_is_better: j.lower_is_better, missing: j.missing ?? null,
      evidence: { ...j.evidence, series: j.evidence.series }, milestones: own.map((m) => ({ id: m.id, title: m.title, due_on: D(m.due_on), status: m.status, done_on: D(m.done_on) })), milestone_summary: j.milestones,
      interventions: ints.filter((i) => i.objective_id === o.id && seeInt(i)).length,
    });
    domains[o.domain].states = tally(domains[o.domain].objectives.map((x) => x.state));
  }
  const interventions = [];
  for (const i of ints.filter(seeInt)) interventions.push({ id: i.id, kind: i.kind, title: i.title, objective_id: i.objective_id, owner: await nameOf(i.owner_id), due_on: D(i.due_on), status: i.status, visibility: i.visibility, coaching_action_id: i.coaching_action_id,
    detail: family ? null : openT(i.detail_enc, 'detail'), completion_note: family ? null : openT(i.completion_note_enc, 'completion_note'), completed_at: i.completed_at, overdue: ['open', 'in_progress'].includes(i.status) && i.due_on && D(i.due_on) < asOf, row_version: i.row_version });

  const reviewRows = await many('SELECT * FROM academy_dev_reviews WHERE plan_id=$1 ORDER BY created_at DESC, id DESC', [plan.id]);
  const reviews = [];
  for (const r of reviewRows) {
    if (family && !(r.status === 'signed_off' && r.family_visible)) continue;
    if (provider) continue;
    const sign = await many('SELECT s.capacity, s.decision, s.created_at, s.user_id, s.comment_enc FROM academy_dev_signoffs s WHERE s.review_id=$1 ORDER BY s.created_at, s.id', [r.id]);
    reviews.push({ id: r.id, period_from: D(r.period_from), period_to: D(r.period_to), status: r.status, family_visible: r.family_visible, row_version: r.row_version, signed_off_at: r.signed_off_at, signed_off_by: await nameOf(r.signed_off_by),
      summary: r.status === 'draft' && family ? null : openT(r.summary_enc, 'summary'), domain_notes: family ? null : r.domain_notes_enc ? JSON.parse(openT(r.domain_notes_enc, 'domain_notes')) : {},
      snapshot: r.snapshot ? (family ? { ...r.snapshot, staff_tally: undefined, domains: Object.fromEntries(Object.entries(r.snapshot.domains).map(([k, v]) => [k, v.filter((x) => x.athlete_visible)])) } : r.snapshot) : null,
      signoffs: await Promise.all(sign.map(async (s) => ({ capacity: s.capacity, decision: s.decision, at: s.created_at, by: await nameOf(s.user_id), comment: family && s.capacity !== a.kind && s.capacity !== 'lead' ? null : openT(s.comment_enc, 'signoff') }))) });
  }
  const decRows = provider ? [] : await many('SELECT d.* FROM academy_dev_decisions d LEFT JOIN academy_dev_reviews r ON r.id=d.review_id WHERE d.plan_id=$1 AND ($2::boolean = false OR (r.family_visible AND r.status=\'signed_off\')) ORDER BY d.created_at DESC, d.id DESC LIMIT 50', [plan.id, family]);
  const decisions = [];
  for (const d of decRows) decisions.push({ id: d.id, kind: d.kind, reason: family ? null : openT(d.reason_enc, 'reason'), review_id: d.review_id, progression_decision_id: d.progression_decision_id, by: await nameOf(d.decided_by), at: d.created_at });

  const contributors = provider || family ? [] : await Promise.all((await many('SELECT c.*, u.display_name FROM academy_dev_contributors c JOIN users u ON u.id=c.user_id WHERE c.plan_id=$1 AND c.removed_at IS NULL ORDER BY c.added_at, c.id', [plan.id])).map(async (c) => ({ user_id: c.user_id, display_name: c.display_name, discipline: c.discipline, domains: c.domains })));

  // pathway (#395): where the athlete stands, read from the pathway tables; the move itself is made in Progress
  let pathway = null;
  if (plan.pathway_id && !provider) {
    const p = await one('SELECT id, title, current_version FROM academy_pathways WHERE id=$1', [plan.pathway_id]);
    const last = await one('SELECT id, decision, from_level, to_level, created_at FROM academy_progression_decisions WHERE pathway_id=$1 AND athlete_id=$2 ORDER BY created_at DESC, id DESC LIMIT 1', [plan.pathway_id, plan.athlete_id]);
    const asm = await one("SELECT id, outcome, created_at FROM academy_assessments WHERE pathway_id=$1 AND athlete_id=$2 AND status='approved' ORDER BY created_at DESC LIMIT 1", [plan.pathway_id, plan.athlete_id]);
    pathway = p ? { id: p.id, title: p.title, level: last ? last.to_level ?? last.from_level : null, last_decision: last ? { id: last.id, decision: last.decision, at: last.created_at } : null, latest_assessment: asm ? { id: asm.id, outcome: asm.outcome, at: asm.created_at } : null } : null;
  }
  // school summaries (athlete-chosen, metadata only) and the minimal fit status (athlete-shared) -- only to the roles that need them
  let school = null;
  if (family || a.can_manage || (a.kind === 'contributor' && SCHOOL_SEES.includes(a.discipline))) {
    const linked = await many(
      `SELECT l.id AS link_id, e.id, e.kind, e.institution, e.period_from, e.period_to, e.provenance FROM academy_dev_school_links l JOIN academic_evidence e ON e.id=l.evidence_id AND e.removed_at IS NULL WHERE l.plan_id=$1 AND l.revoked_at IS NULL ORDER BY e.period_to DESC NULLS LAST, e.id`, [plan.id]);
    school = { linked: linked.map((r) => ({ ...r, period_from: D(r.period_from), period_to: D(r.period_to) })), source: 'academic_evidence (chosen by the athlete or guardian; summary text is never copied)' };
    if (family) school.available = await many('SELECT e.id, e.kind, e.institution, e.period_from, e.period_to, e.provenance, (l.id IS NOT NULL) AS linked FROM academic_evidence e LEFT JOIN academy_dev_school_links l ON l.evidence_id=e.id AND l.plan_id=$1 AND l.revoked_at IS NULL WHERE e.user_id=$2 AND e.removed_at IS NULL ORDER BY e.period_to DESC NULLS LAST, e.id', [plan.id, plan.athlete_id]);
  }
  const clearance = (a.can_manage || a.kind === 'coach' || family || (a.kind === 'contributor' && CLEARANCE_SEES.includes(a.discipline))) ? await sharedClearance(plan.organisation_id, plan.athlete_id) : null;

  const open = interventions.filter((i) => ['open', 'in_progress'].includes(i.status));
  const draft = reviewRows.find((r) => r.status === 'draft');
  const lastSigned = reviewRows.find((r) => r.status === 'signed_off');
  const addDays = (d, n) => new Date(new Date(`${d}T12:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10);
  const nextReview = addDays(lastSigned ? D(lastSigned.period_to) : D(plan.starts_on), plan.review_every_days);
  const phases = (plan.phases ?? []).map((x) => ({ kind: x.kind, label: x.label ?? null, from: x.from, to: x.to }));
  const inProtected = (d) => (d ? phases.find((x) => PROTECTED_PHASES.includes(x.kind) && d >= x.from && d <= x.to) : null);
  const clashes = family || provider ? [] : [
    ...Object.values(domains).flatMap((dm) => dm.objectives.flatMap((o) => (['technical', 'tactical', 'physical'].includes(o.domain) ? o.milestones.filter((m) => m.status === 'pending' && inProtected(m.due_on)).map((m) => ({ type: 'milestone', id: m.id, title: m.title, due_on: m.due_on, phase: inProtected(m.due_on) })) : []))),
    ...interventions.filter((i) => ['training_block', 'conditioning'].includes(i.kind) && ['open', 'in_progress'].includes(i.status) && inProtected(i.due_on)).map((i) => ({ type: 'task', id: i.id, title: i.title, due_on: i.due_on, phase: inProtected(i.due_on) })),
  ];
  const strip = {
    objectives: states.length, ...tally(states), milestones_overdue: Object.values(domains).flatMap((d) => d.objectives).reduce((n, o) => n + o.milestone_summary.overdue, 0),
    interventions_open: open.length, interventions_overdue: open.filter((i) => i.overdue).length, next_review_on: nextReview, review_overdue: plan.status !== 'closed' && nextReview < asOf && !draft, review_in_progress: !!draft,
    days_left: Math.max(0, Math.round((new Date(`${D(plan.ends_on)}T12:00:00Z`) - new Date(`${asOf}T12:00:00Z`)) / 864e5)),
  };
  return {
    plan: { id: plan.id, organisation: org, athlete, sport: plan.sport, season_label: plan.season_label, starts_on: D(plan.starts_on), ends_on: D(plan.ends_on), status: plan.status, lead, focus: provider ? null : openT(plan.focus_enc, 'focus'), review_every_days: plan.review_every_days, row_version: plan.row_version, pathway_id: plan.pathway_id, archived_at: plan.archived_at },
    is_youth: await isYouth(plan.athlete_id), my_access: { kind: a.kind, can_manage: a.can_manage, discipline: a.discipline ?? null, domains: a.domains, write_domains: a.write_domains },
    strip, domains: provider ? {} : domains, interventions, reviews, decisions, contributors, pathway, school, clearance,
    phases, clashes, framework: family ? null : (({ family: fm, label, fallback }) => ({ family: fm, label, fallback }))(frameworkFor(plan.sport)),
    sources: ['coaching_observations', 'coaching_goals', 'academy_attendance', 'performances (approved competition)', 'academic_evidence', 'academy_progression_decisions', 'clinical_clearances (minimal share)'],
  };
}

cap({
  name: 'get_academy_dev_plan', method: 'GET', path: '/academy/dev-plans/:id', tag: TAG,
  summary: 'The development plan of one athlete for a season, assembled at read time from the canonical records and cut to the caller. The technical director and plan lead see everything in the plan; a coach sees their own athlete; a contributor (conditioning, psychology, education…) sees only their domains and their own tasks; a provider sees only tasks assigned to them; the athlete and guardian see only athlete-visible objectives, tasks and signed-off reviews. Six domains, each judged on its own metric with source, unit and "no data" as a state of its own: there is no combined score. Clinical notes and welfare details are never part of a plan. Reads by anyone other than the athlete are audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { plan, a } = await planFor(user, i.id);
    if (a.kind !== 'athlete') await audit(null, user.id, a.kind === 'guardian' ? 'read_child_academy_dev_plan' : 'read_academy_dev_plan', 'academy_dev_plans', plan.id);
    return buildView(user, plan, a);
  },
});

cap({
  name: 'list_academy_dev_plans', method: 'GET', path: '/organisations/:id/academy/dev-plans', tag: TAG,
  summary: 'The academy\'s development plans with the headline counts for each (objectives per state, overdue tasks, review status). Owner/admin see every plan; a coach sees plans of their own athletes and plans they lead or contribute to; other contributors see the plans they are named on. Filter by status, season or athlete name. Deterministic order: soonest season end first.',
  input: z.object({ id, status: z.enum(['draft', 'active', 'in_review', 'closed']).optional(), q: z.string().trim().max(80).optional(), mine: flag.optional(), ...page }),
  async handler({ user }, i) {
    const role = await orgRole(user, i.id);
    if (!role) throw notFound('Organisation');
    const rows = await many(
      `SELECT p.*, u.display_name AS athlete_name, l.display_name AS lead_name FROM academy_dev_plans p JOIN users u ON u.id=p.athlete_id JOIN users l ON l.id=p.lead_id
        WHERE p.organisation_id=$1 AND p.archived_at IS NULL AND ($2::text IS NULL OR p.status=$2) AND ($3::text IS NULL OR u.display_name ILIKE '%'||$3||'%' OR p.season_label ILIKE '%'||$3||'%')
        ORDER BY p.ends_on, p.id`, [i.id, i.status ?? null, i.q ?? null]);
    const out = [];
    for (const p of rows) {
      const a = await accessTo(user, p);
      if (!a || a.kind === 'athlete' || a.kind === 'guardian') continue;
      if (i.mine && p.lead_id !== user.id) continue;
      const v = await buildView(user, p, a);
      out.push({ id: p.id, athlete: v.plan.athlete, athlete_name: p.athlete_name, sport: p.sport, season_label: p.season_label, starts_on: v.plan.starts_on, ends_on: v.plan.ends_on, status: p.status, lead: v.plan.lead, strip: v.strip,
        domain_counts: Object.fromEntries(DOMAINS.map((d) => [d, v.domains[d]?.objectives.length ?? 0])), access: a.kind });
    }
    return { total: out.length, items: out.slice(i.offset, i.offset + i.limit) };
  },
});

cap({
  name: 'get_my_academy_dev_plans', method: 'GET', path: '/academy/my-dev-plans', tag: TAG,
  summary: 'Development plans about the signed-in athlete, or about a child when their verified guardian asks: season, lead, and the headline counts of what the athlete may see. Open one with get_academy_dev_plan. Guardian reads are audit-logged.',
  input: z.object({ athlete_id: id.optional() }),
  async handler({ user }, i) {
    const athleteId = i.athlete_id ?? user.id;
    if (athleteId !== user.id) { if (!(await guardianLink(user.id, athleteId))) throw notFound('Athlete'); await audit(null, user.id, 'read_child_academy_dev_plans', 'users', athleteId); }
    const rows = await many("SELECT p.*, o.name AS organisation FROM academy_dev_plans p JOIN organisations o ON o.id=p.organisation_id WHERE p.athlete_id=$1 AND p.archived_at IS NULL AND p.status <> 'draft' ORDER BY p.ends_on DESC, p.id", [athleteId]);
    const out = [];
    for (const p of rows) { const a = await accessTo(user, p); const v = await buildView(user, p, a); out.push({ id: p.id, organisation: p.organisation, season_label: p.season_label, sport: p.sport, status: p.status, starts_on: v.plan.starts_on, ends_on: v.plan.ends_on, lead: v.plan.lead, strip: v.strip, latest_review: v.reviews[0] ? { id: v.reviews[0].id, period_to: v.reviews[0].period_to, signed_off_at: v.reviews[0].signed_off_at } : null }); }
    return out;
  },
});

// ---------------------------------------------------------------------------------------------- pickers (real catalogues, nothing typed that can be chosen)
cap({
  name: 'get_academy_dev_options', method: 'GET', path: '/organisations/:id/academy/dev-plans/options', tag: TAG,
  summary: 'Everything the plan forms pick from, so nothing is typed that can be chosen: the athlete\'s sports (from their programmes), the pathways they could serve, the academy\'s rubrics with dimensions (sport-specific competencies), the athlete\'s open coaching goals, official metrics they have approved results for, and the people who can lead, own work or contribute (members and associated providers). Owner/admin/coach.',
  input: z.object({ id, athlete_id: id.optional() }),
  async handler({ user }, i) {
    const { role } = await orgFor(user, i.id, ['owner', 'admin', 'coach']);
    const out = { domains: DOMAINS, disciplines: DISCIPLINES, intervention_kinds: KINDS, decision_kinds: DECISIONS };
    out.people = await many(
      `SELECT m.user_id, m.role, u.display_name, u.avatar_emoji, u.avatar_color, e.job_title, 'member' AS source FROM organisation_members m JOIN users u ON u.id=m.user_id LEFT JOIN org_staff_engagements e ON e.organisation_id=m.organisation_id AND e.user_id=m.user_id
        WHERE m.organisation_id=$1 AND m.status='active' AND m.role = ANY($2) AND (e.id IS NULL OR e.state='active') ORDER BY u.display_name, u.id`, [i.id, WORKERS]);
    out.providers = await many(
      `SELECT a.provider_id AS user_id, u.display_name, p.provider_type, a.relation, 'provider' AS source FROM org_provider_associations a JOIN users u ON u.id=a.provider_id JOIN provider_profiles p ON p.user_id=a.provider_id WHERE a.organisation_id=$1 AND a.status='active' ORDER BY u.display_name, a.id`, [i.id]);
    out.rubrics = await many(
      `SELECT r.id, r.name, s.slug AS sport, v.dimensions FROM coaching_rubrics r LEFT JOIN sports s ON s.id=r.sport_id JOIN LATERAL (SELECT dimensions FROM coaching_rubric_versions WHERE rubric_id=r.id ORDER BY version DESC LIMIT 1) v ON true
        WHERE r.archived_at IS NULL AND (r.coach_id IN (SELECT coach_id FROM org_cohorts WHERE organisation_id=$1 AND coach_id IS NOT NULL) OR r.coach_id IN (SELECT user_id FROM organisation_members WHERE organisation_id=$1 AND status='active' AND role IN ('coach','owner','admin'))) ORDER BY r.name, r.id LIMIT 100`, [i.id]);
    if (!i.athlete_id) {
      out.athletes = await many(
        `SELECT u.id, u.display_name, u.avatar_emoji, u.avatar_color, array_agg(DISTINCT pr.sport ORDER BY pr.sport) AS sports, string_agg(DISTINCT k.name, ', ') AS groups
           FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id JOIN users u ON u.id=e.user_id LEFT JOIN academy_programmes pr ON pr.id=e.programme_id
          WHERE k.organisation_id=$1 AND e.status IN ('enrolled','paused') AND ($2 <> 'coach' OR k.coach_id=$3) GROUP BY u.id ORDER BY u.display_name, u.id LIMIT 500`, [i.id, role, user.id]);
    }
    if (i.athlete_id) {
      await inScope(user, role, i.id, i.athlete_id);
      out.sports = await many("SELECT DISTINCT pr.sport FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id JOIN academy_programmes pr ON pr.id=e.programme_id WHERE k.organisation_id=$1 AND e.user_id=$2 AND e.status IN ('enrolled','paused') ORDER BY 1", [i.id, i.athlete_id]);
      out.pathways = await many("SELECT id, title, sport FROM academy_pathways WHERE organisation_id=$1 AND status='active' ORDER BY title, id", [i.id]);
      if (await hasConsent(i.athlete_id, 'coaching')) out.coach_goals = await many(
        `SELECT g.id, g.title, g.category, g.status, g.review_on FROM coaching_goals g WHERE g.athlete_id=$1 AND g.status IN ('planned','active')
           AND g.coach_id IN (SELECT coach_id FROM org_cohorts WHERE organisation_id=$2 AND coach_id IS NOT NULL) ORDER BY g.updated_at DESC, g.id LIMIT 50`, [i.athlete_id, i.id]);
      else out.coach_goals = [];
      out.official_metrics = (await officialEvidence(i.athlete_id, '2000-01-01', today())).results.map((r) => ({ sport: r.sport, metric: r.metric, results: r.n }));
    }
    return out;
  },
});

// ---------------------------------------------------------------------------------------------- plan
cap({
  name: 'create_academy_dev_plan', method: 'POST', path: '/organisations/:id/academy/dev-plans', tag: TAG, status: 201,
  summary: 'Open a season development plan for an enrolled athlete (owner/admin, or a coach for an athlete in their own groups). Names the accountable lead, the season window, the #395 pathway it serves and the review rhythm. One live plan per athlete per season label. Idempotent with idempotency_key. The plan starts as a draft: add objectives and contributors, then activate it.',
  input: z.object({ id, athlete_id: id, season_label: text(2, 40), starts_on: day, ends_on: day, sport: text(2, 60).optional(), lead_id: id.optional(), pathway_id: id.optional(), focus: text(3, 1000).optional(), review_every_days: z.number().int().min(7).max(180).default(42), idempotency_key: z.string().max(80).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { role } = await orgFor(user, i.id, ['owner', 'admin', 'coach'], { write: true, c });
    await inScope(user, role, i.id, i.athlete_id);
    if (i.ends_on <= i.starts_on) throw badRequest('The season must end after it starts');
    if (i.idempotency_key) { const dup = (await c.query('SELECT * FROM academy_dev_plans WHERE created_by=$1 AND idempotency_key=$2', [user.id, i.idempotency_key])).rows[0]; if (dup) return dup; }
    const leadId = i.lead_id ?? user.id;
    await assertWorker(i.id, leadId, 'The plan lead');
    if (role === 'coach' && leadId !== user.id) throw forbidden('A coach opens a plan as its lead');
    let sport = i.sport;
    if (!sport) {
      const s = (await c.query("SELECT DISTINCT pr.sport FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id JOIN academy_programmes pr ON pr.id=e.programme_id WHERE k.organisation_id=$1 AND e.user_id=$2 AND e.status IN ('enrolled','paused')", [i.id, i.athlete_id])).rows;
      if (s.length !== 1) throw badRequest(s.length ? 'This athlete is in more than one sport; choose the sport for this plan' : 'This athlete has no programme; choose the sport for this plan');
      sport = s[0].sport;
    }
    if (i.pathway_id && !(await c.query('SELECT 1 FROM academy_pathways WHERE id=$1 AND organisation_id=$2', [i.pathway_id, i.id])).rows.length) throw badRequest('That pathway is not in this academy');
    if ((await c.query('SELECT 1 FROM academy_dev_plans WHERE organisation_id=$1 AND athlete_id=$2 AND lower(season_label)=lower($3) AND archived_at IS NULL', [i.id, i.athlete_id, i.season_label])).rows.length) throw conflict('This athlete already has a plan for that season');
    const p = (await c.query(
      `INSERT INTO academy_dev_plans(organisation_id, athlete_id, sport, season_label, starts_on, ends_on, lead_id, pathway_id, focus_enc, review_every_days, created_by, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [i.id, i.athlete_id, sport, i.season_label, i.starts_on, i.ends_on, leadId, i.pathway_id ?? null, sealT(i.focus, 'focus'), i.review_every_days, user.id, i.idempotency_key ?? null])).rows[0];
    await audit(c, user.id, 'create_academy_dev_plan', 'academy_dev_plans', p.id);
    return p;
  }),
});

cap({
  name: 'update_academy_dev_plan', method: 'PATCH', path: '/academy/dev-plans/:id', tag: TAG,
  summary: 'Change a plan (technical director or plan lead): season window, lead, pathway, focus, review rhythm, or move it draft → active, or archive it. Send row_version from the last read; a stale version is refused. A closed season is read-only; closing is done by recording the "close season" decision.',
  input: z.object({ id, row_version: z.number().int().min(1), status: z.enum(['active']).optional(), season_label: text(2, 40).optional(), starts_on: day.optional(), ends_on: day.optional(), lead_id: id.optional(), pathway_id: id.nullable().optional(), focus: text(3, 1000).optional(), review_every_days: z.number().int().min(7).max(180).optional(), phases: z.array(z.object({ kind: z.enum(PHASE_KINDS), label: text(2, 60).optional(), from: day, to: day })).max(12).optional(), archive: z.boolean().optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { plan, a } = await planFor(user, i.id, c);
    needManage(a);
    if (plan.archived_at) throw conflict('This plan is archived and read-only');
    if (plan.row_version !== i.row_version) throw conflict('This plan changed since you opened it. Reload and try again.', { code: 'stale_version', row_version: plan.row_version });
    if (i.archive) { const r = (await c.query('UPDATE academy_dev_plans SET archived_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *', [plan.id])).rows[0]; await audit(c, user.id, 'archive_academy_dev_plan', 'academy_dev_plans', plan.id); return r; }
    live(plan);
    const from = i.starts_on ?? D(plan.starts_on), to = i.ends_on ?? D(plan.ends_on);
    if (to <= from) throw badRequest('The season must end after it starts');
    if (i.phases) {
      const ph = [...i.phases].sort((x, y) => x.from.localeCompare(y.from));
      for (const [n, x] of ph.entries()) {
        if (x.to < x.from) throw badRequest('A phase ends before it starts');
        if (x.from < from || x.to > to) throw badRequest('Every phase must fall inside the season');
        if (n && x.from <= ph[n - 1].to) throw badRequest('Phases cannot overlap');
      }
      i.phases = ph;
    }
    if (i.lead_id) await assertWorker(plan.organisation_id, i.lead_id, 'The plan lead');
    if (i.pathway_id && !(await c.query('SELECT 1 FROM academy_pathways WHERE id=$1 AND organisation_id=$2', [i.pathway_id, plan.organisation_id])).rows.length) throw badRequest('That pathway is not in this academy');
    if (i.status === 'active' && plan.status !== 'draft') throw conflict('Only a draft plan can be activated');
    if (i.status === 'active' && !(await c.query('SELECT 1 FROM academy_dev_objectives WHERE plan_id=$1 AND archived_at IS NULL', [plan.id])).rows.length) throw badRequest('Add at least one objective before activating the plan');
    const r = (await c.query(
      `UPDATE academy_dev_plans SET status=coalesce($2,status), season_label=coalesce($3,season_label), starts_on=$4, ends_on=$5, lead_id=coalesce($6,lead_id), pathway_id=CASE WHEN $7::boolean THEN $8 ELSE pathway_id END,
              focus_enc=coalesce($9,focus_enc), review_every_days=coalesce($10,review_every_days), phases=coalesce($11::jsonb,phases), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`,
      [plan.id, i.status ?? null, i.season_label ?? null, from, to, i.lead_id ?? null, i.pathway_id !== undefined, i.pathway_id ?? null, i.focus ? sealT(i.focus, 'focus') : null, i.review_every_days ?? null, i.phases ? JSON.stringify(i.phases) : null])).rows[0];
    await audit(c, user.id, 'update_academy_dev_plan', 'academy_dev_plans', plan.id);
    return r;
  }),
});

cap({
  name: 'set_academy_dev_contributor', method: 'POST', path: '/academy/dev-plans/:id/contributors', tag: TAG, status: 201,
  summary: 'Name (or remove) a contributor on a plan (technical director or plan lead): an academy member or an associated provider, their discipline, and the domains they may see. A provider sees only the tasks assigned to them. Removing keeps the history; access ends immediately.',
  input: z.object({ id, user_id: id, discipline: z.enum(DISCIPLINES), domains: z.array(z.enum(DOMAINS)).max(6).default([]), remove: z.boolean().optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { plan, a } = await planFor(user, i.id, c);
    needManage(a); live(plan);
    if (i.remove) { await c.query('UPDATE academy_dev_contributors SET removed_at=now() WHERE plan_id=$1 AND user_id=$2 AND removed_at IS NULL', [plan.id, i.user_id]); await audit(c, user.id, 'remove_academy_dev_contributor', 'academy_dev_plans', plan.id); return { removed: true }; }
    const isProvider = i.discipline === 'physio_provider';
    if (isProvider) { if (!(await c.query("SELECT 1 FROM org_provider_associations WHERE organisation_id=$1 AND provider_id=$2 AND status='active'", [plan.organisation_id, i.user_id])).rows.length) throw badRequest('A provider must be associated with this academy'); }
    else await assertWorker(plan.organisation_id, i.user_id, 'A contributor');
    if (!isProvider && !i.domains.length) throw badRequest('Choose the domains this person works in');
    await c.query('UPDATE academy_dev_contributors SET removed_at=now() WHERE plan_id=$1 AND user_id=$2 AND removed_at IS NULL', [plan.id, i.user_id]);
    const r = (await c.query('INSERT INTO academy_dev_contributors(plan_id, user_id, discipline, domains, added_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [plan.id, i.user_id, i.discipline, isProvider ? [] : i.domains, user.id])).rows[0];
    await audit(c, user.id, 'set_academy_dev_contributor', 'academy_dev_plans', plan.id);
    return r;
  }),
});

// ---------------------------------------------------------------------------------------------- objectives and milestones
const objectiveShape = {
  domain: z.enum(DOMAINS), competency: text(2, 80).optional(), competency_key: z.string().regex(/^[a-z0-9_]{2,40}$/).optional(), title: text(3, 140), rationale: text(3, 1000).optional(),
  metric_kind: z.enum(['rubric', 'attendance', 'coach_goal', 'official', 'milestones']).default('milestones'),
  rubric_id: id.optional(), dimension_key: z.string().max(60).optional(), coach_goal_id: id.optional(), official_metric: z.string().max(60).optional(),
  target_value: z.number().optional(), baseline_value: z.number().optional(), owner_id: id.optional(), due_on: day.optional(), visibility: z.enum(['staff', 'athlete']).default('athlete'),
};
async function checkMetric(c, plan, o) {
  if (o.metric_kind === 'rubric') {
    const r = (await c.query(
      `SELECT v.dimensions FROM coaching_rubrics r JOIN LATERAL (SELECT dimensions FROM coaching_rubric_versions WHERE rubric_id=r.id ORDER BY version DESC LIMIT 1) v ON true
        WHERE r.id=$1 AND r.archived_at IS NULL AND (r.coach_id IN (SELECT coach_id FROM org_cohorts WHERE organisation_id=$2 AND coach_id IS NOT NULL) OR r.coach_id IN (SELECT user_id FROM organisation_members WHERE organisation_id=$2 AND status='active' AND role IN ('coach','owner','admin')))`, [o.rubric_id, plan.organisation_id])).rows[0];
    if (!r || !(r.dimensions ?? []).some((d) => d.key === o.dimension_key)) throw badRequest('Choose a rubric dimension used by this academy\'s coaches');
    if (o.target_value === undefined) throw badRequest('Set the target score for a rubric objective');
  } else if (o.metric_kind === 'coach_goal') {
    if (!(await c.query("SELECT 1 FROM coaching_goals g WHERE g.id=$1 AND g.athlete_id=$2 AND g.status IN ('planned','active','achieved') AND g.coach_id IN (SELECT coach_id FROM org_cohorts WHERE organisation_id=$3 AND coach_id IS NOT NULL)", [o.coach_goal_id, plan.athlete_id, plan.organisation_id])).rows.length) throw badRequest('Choose one of this athlete\'s coaching goals set by an academy coach');
  } else if (o.metric_kind === 'official') {
    if (!o.official_metric || o.target_value === undefined) throw badRequest('Choose the official metric and set a target');
  } else if (o.metric_kind === 'attendance') { if (o.target_value === undefined || o.target_value < 0 || o.target_value > 100) throw badRequest('Set an attendance target between 0 and 100%'); }
}
const metricGuard = (o) => { if (o.metric_kind === 'rubric' && (!o.rubric_id || !o.dimension_key)) throw badRequest('Choose the rubric and dimension to measure'); if (o.metric_kind === 'coach_goal' && !o.coach_goal_id) throw badRequest('Choose the coaching goal to follow'); };

cap({
  name: 'add_academy_dev_objective', method: 'POST', path: '/academy/dev-plans/:id/objectives', tag: TAG, status: 201,
  summary: 'Add a season objective in one domain. The measurable target points at a canonical metric: a coach rubric dimension, academy attendance, an approved official result, one of the athlete\'s coaching goals, or plan milestones. The figure at the time is captured once as a dated baseline so a trend can be drawn honestly; if no data exists yet the baseline stays empty (missing, not zero). The technical director/lead can add to any domain; a contributor only to their own. Optional milestones are created with it.',
  input: z.object({ id, ...objectiveShape, milestones: z.array(z.object({ title: text(3, 140), due_on: day })).max(20).default([]),
    tasks: z.array(z.object({ kind: z.enum(KINDS), title: text(3, 140), due_on: day.optional(), owner_id: id.optional() })).max(10).default([]) }),
  handler: ({ user }, i) => tx(async (c) => {
    const { plan, a } = await planFor(user, i.id, c);
    live(plan);
    if (!mayWrite(a, i.domain)) throw forbidden('You do not work in that domain on this plan');
    metricGuard(i);
    await checkMetric(c, plan, i);
    const ownerId = i.owner_id ?? user.id;
    await assertWorker(plan.organisation_id, ownerId, 'The objective owner', { providers: true });
    if (i.due_on && (i.due_on < D(plan.starts_on) || i.due_on > D(plan.ends_on))) throw badRequest('The due date must fall inside the season');
    for (const m of i.milestones) if (m.due_on < D(plan.starts_on) || m.due_on > D(plan.ends_on)) throw badRequest('Every milestone must fall inside the season');
    let baseline = i.baseline_value ?? null, baselineOn = baseline !== null ? today() : null;
    if (baseline === null && ['rubric', 'attendance', 'official'].includes(i.metric_kind)) {
      const m = await measure(plan, { ...i, baseline_on: null }, today() < D(plan.ends_on) ? today() : D(plan.ends_on));
      if (m.value !== null) { baseline = m.value; baselineOn = today(); }
    }
    const pos = (await c.query('SELECT coalesce(max(position),0)+1 AS p FROM academy_dev_objectives WHERE plan_id=$1', [plan.id])).rows[0].p;
    const o = (await c.query(
      `INSERT INTO academy_dev_objectives(plan_id, domain, competency, competency_key, title, rationale_enc, metric_kind, rubric_id, dimension_key, coach_goal_id, official_metric, target_value, baseline_value, baseline_on, owner_id, due_on, visibility, position, created_by)
       VALUES ($1,$2,$3,$19,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [plan.id, i.domain, i.competency ?? null, i.title, sealT(i.rationale, 'rationale'), i.metric_kind, i.rubric_id ?? null, i.dimension_key ?? null, i.coach_goal_id ?? null, i.official_metric ?? null, i.target_value ?? null, baseline, baselineOn, ownerId, i.due_on ?? null, i.visibility, pos, user.id, i.competency_key ?? null])).rows[0];
    for (const m of i.milestones) await c.query('INSERT INTO academy_dev_milestones(objective_id, title, due_on, created_by) VALUES ($1,$2,$3,$4)', [o.id, m.title, m.due_on, user.id]);
    for (const tk of i.tasks) {
      const owner = tk.owner_id ?? ownerId;
      await assertWorker(plan.organisation_id, owner, 'The task owner', { providers: true });
      await c.query('INSERT INTO academy_dev_interventions(plan_id, objective_id, kind, title, owner_id, due_on, visibility, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [plan.id, o.id, tk.kind, tk.title, owner, tk.due_on ?? null, i.visibility, user.id]);
      if (owner !== user.id) await notify(c, owner, { kind: 'academy_dev_task', title: 'You have a new development task', body: 'Open GotMyGame to see what you have been asked to do.', data: { plan_id: plan.id }, dedupe_key: `academy:dev:task:${o.id}:${owner}:${tk.title.slice(0, 20)}` });
    }
    await audit(c, user.id, 'add_academy_dev_objective', 'academy_dev_objectives', o.id);
    return o;
  }),
});

cap({
  name: 'update_academy_dev_objective', method: 'PATCH', path: '/academy/dev-objectives/:id', tag: TAG,
  summary: 'Change an objective: title, owner, due date, target, visibility to the athlete and family, or status (planned/active/achieved/deferred/dropped), or archive it. The technical director/lead, or the named owner of the objective. Send row_version; a stale version is refused. History is kept: objectives are archived, never deleted.',
  input: z.object({ id, row_version: z.number().int().min(1), title: text(3, 140).optional(), competency: text(2, 80).optional(), rationale: text(3, 1000).optional(), owner_id: id.optional(), due_on: day.nullable().optional(), target_value: z.number().optional(), visibility: z.enum(['staff', 'athlete']).optional(), status: z.enum(['planned', 'active', 'achieved', 'deferred', 'dropped']).optional(), archive: z.boolean().optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const o = (await c.query('SELECT * FROM academy_dev_objectives WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!o) throw notFound('Objective');
    const { plan, a } = await planFor(user, o.plan_id, c);
    live(plan);
    if (!(a.can_manage || (o.owner_id === user.id && mayWrite(a, o.domain)))) throw forbidden('Only the technical director, the plan lead or the objective owner can change it');
    if (o.archived_at) throw conflict('This objective is archived');
    if (o.row_version !== i.row_version) throw conflict('This objective changed since you opened it. Reload and try again.', { code: 'stale_version', row_version: o.row_version });
    if (i.owner_id) await assertWorker(plan.organisation_id, i.owner_id, 'The objective owner', { providers: true });
    const r = (await c.query(
      `UPDATE academy_dev_objectives SET title=coalesce($2,title), competency=coalesce($3,competency), rationale_enc=coalesce($4,rationale_enc), owner_id=coalesce($5,owner_id), due_on=CASE WHEN $6::boolean THEN $7 ELSE due_on END,
              target_value=coalesce($8,target_value), visibility=coalesce($9,visibility), status=coalesce($10,status), archived_at=CASE WHEN $11::boolean THEN now() ELSE archived_at END, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`,
      [o.id, i.title ?? null, i.competency ?? null, i.rationale ? sealT(i.rationale, 'rationale') : null, i.owner_id ?? null, i.due_on !== undefined, i.due_on ?? null, i.target_value ?? null, i.visibility ?? null, i.status ?? null, !!i.archive])).rows[0];
    await audit(c, user.id, i.archive ? 'archive_academy_dev_objective' : 'update_academy_dev_objective', 'academy_dev_objectives', o.id);
    return r;
  }),
});

cap({
  name: 'set_academy_dev_milestone', method: 'POST', path: '/academy/dev-objectives/:id/milestones', tag: TAG, status: 201,
  summary: 'Add a milestone to an objective, or mark one done / skipped / pending again (milestone_id). The technical director/lead or the objective owner. Marking done records who and when.',
  input: z.object({ id, milestone_id: id.optional(), title: text(3, 140).optional(), due_on: day.optional(), status: z.enum(['pending', 'done', 'skipped']).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const o = (await c.query('SELECT * FROM academy_dev_objectives WHERE id=$1', [i.id])).rows[0];
    if (!o || o.archived_at) throw notFound('Objective');
    const { plan, a } = await planFor(user, o.plan_id, c);
    live(plan);
    if (!(a.can_manage || (o.owner_id === user.id && mayWrite(a, o.domain)))) throw forbidden('Only the technical director, the plan lead or the objective owner can change milestones');
    if (i.milestone_id) {
      const m = (await c.query('SELECT * FROM academy_dev_milestones WHERE id=$1 AND objective_id=$2 AND archived_at IS NULL', [i.milestone_id, o.id])).rows[0];
      if (!m) throw notFound('Milestone');
      const st = i.status ?? m.status;
      const r = (await c.query('UPDATE academy_dev_milestones SET title=coalesce($2,title), due_on=coalesce($3,due_on), status=$4::text, done_on=CASE WHEN $4::text=\'done\' THEN coalesce(done_on, current_date) ELSE NULL END, done_by=CASE WHEN $4::text=\'done\' THEN $5::uuid ELSE NULL END WHERE id=$1 RETURNING *', [m.id, i.title ?? null, i.due_on ?? null, st, user.id])).rows[0];
      await audit(c, user.id, 'set_academy_dev_milestone', 'academy_dev_milestones', m.id);
      return r;
    }
    if (!i.title || !i.due_on) throw badRequest('A milestone needs a title and a due date');
    if (i.due_on < D(plan.starts_on) || i.due_on > D(plan.ends_on)) throw badRequest('The milestone must fall inside the season');
    const r = (await c.query('INSERT INTO academy_dev_milestones(objective_id, title, due_on, created_by) VALUES ($1,$2,$3,$4) RETURNING *', [o.id, i.title, i.due_on, user.id])).rows[0];
    await audit(c, user.id, 'set_academy_dev_milestone', 'academy_dev_milestones', r.id);
    return r;
  }),
});

// ---------------------------------------------------------------------------------------------- intervention tasks
cap({
  name: 'add_academy_dev_intervention', method: 'POST', path: '/academy/dev-plans/:id/interventions', tag: TAG, status: 201,
  summary: 'Add an intervention task: what a named person will do (training block, conditioning, psychology session, tutoring, guardian meeting, provider referral, load adjustment, video review). Optionally tied to an objective and to an existing coaching action (linked, not copied). The owner is notified with a generic message that carries no detail. Technical director/lead, or a contributor for their own domains.',
  input: z.object({ id, kind: z.enum(KINDS), title: text(3, 140), detail: text(3, 1000).optional(), objective_id: id.optional(), owner_id: id.optional(), due_on: day.optional(), visibility: z.enum(['staff', 'athlete']).default('staff'), coaching_action_id: id.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { plan, a } = await planFor(user, i.id, c);
    live(plan);
    let ob = null;
    if (i.objective_id) { ob = (await c.query('SELECT * FROM academy_dev_objectives WHERE id=$1 AND plan_id=$2 AND archived_at IS NULL', [i.objective_id, plan.id])).rows[0]; if (!ob) throw badRequest('That objective is not in this plan'); }
    if (!(a.can_manage || (ob ? a.write_domains.includes(ob.domain) : a.write_domains.length))) throw forbidden('You do not work on this part of the plan');
    const ownerId = i.owner_id ?? user.id;
    await assertWorker(plan.organisation_id, ownerId, 'The task owner', { providers: true });
    if (i.coaching_action_id && !(await c.query('SELECT 1 FROM coaching_actions WHERE id=$1 AND athlete_id=$2', [i.coaching_action_id, plan.athlete_id])).rows.length) throw badRequest('That coaching action is not for this athlete');
    const r = (await c.query(
      `INSERT INTO academy_dev_interventions(plan_id, objective_id, kind, title, detail_enc, owner_id, due_on, visibility, coaching_action_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [plan.id, i.objective_id ?? null, i.kind, i.title, sealT(i.detail, 'detail'), ownerId, i.due_on ?? null, i.visibility, i.coaching_action_id ?? null, user.id])).rows[0];
    if (ownerId !== user.id) await notify(c, ownerId, { kind: 'academy_dev_task', title: 'You have a new development task', body: 'Open GotMyGame to see what you have been asked to do.', data: { plan_id: plan.id, intervention_id: r.id }, dedupe_key: `academy:dev:task:${r.id}` });
    await audit(c, user.id, 'add_academy_dev_intervention', 'academy_dev_interventions', r.id);
    return r;
  }),
});

cap({
  name: 'update_academy_dev_intervention', method: 'PATCH', path: '/academy/dev-interventions/:id', tag: TAG,
  summary: 'Move a task along (open → in progress → done / cancelled) with an optional completion note, change its due date, owner or visibility. The task owner can update their own task; the technical director/lead can change any. Send row_version; a stale version is refused.',
  input: z.object({ id, row_version: z.number().int().min(1), status: z.enum(['open', 'in_progress', 'done', 'cancelled']).optional(), due_on: day.nullable().optional(), owner_id: id.optional(), visibility: z.enum(['staff', 'athlete']).optional(), completion_note: text(2, 1000).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const t = (await c.query('SELECT * FROM academy_dev_interventions WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!t) throw notFound('Task');
    const { plan, a } = await planFor(user, t.plan_id, c);
    if ((a.kind === 'athlete' || a.kind === 'guardian') && t.visibility !== 'athlete') throw notFound('Task');
    live(plan);
    if (!(a.can_manage || t.owner_id === user.id)) throw forbidden('Only the task owner, the plan lead or the technical director can change this task');
    if (!a.can_manage && (i.owner_id || i.visibility)) throw forbidden('Only the plan lead or the technical director can reassign a task or change who sees it');
    if (t.row_version !== i.row_version) throw conflict('This task changed since you opened it. Reload and try again.', { code: 'stale_version', row_version: t.row_version });
    if (i.owner_id) await assertWorker(plan.organisation_id, i.owner_id, 'The task owner', { providers: true });
    const r = (await c.query(
      `UPDATE academy_dev_interventions SET status=coalesce($2,status), due_on=CASE WHEN $3::boolean THEN $4 ELSE due_on END, owner_id=coalesce($5,owner_id), visibility=coalesce($6,visibility), completion_note_enc=coalesce($7,completion_note_enc),
              completed_at=CASE WHEN coalesce($2,status)='done' THEN coalesce(completed_at, now()) ELSE NULL END, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`,
      [t.id, i.status ?? null, i.due_on !== undefined, i.due_on ?? null, i.owner_id ?? null, i.visibility ?? null, i.completion_note ? sealT(i.completion_note, 'completion_note') : null])).rows[0];
    await audit(c, user.id, 'update_academy_dev_intervention', 'academy_dev_interventions', t.id);
    return r;
  }),
});

// ---------------------------------------------------------------------------------------------- reviews, sign-off, decisions
const snapshotOf = (view) => ({
  taken_at: new Date().toISOString(), note: 'Frozen at sign-off. Later changes to the source records do not alter this review.',
  domains: Object.fromEntries(DOMAINS.map((d) => [d, view.domains[d].objectives.map((o) => ({
    objective_id: o.id, title: o.title, competency: o.competency, athlete_visible: o.visibility === 'athlete', status: o.status, state: o.state, progress_pct: o.progress_pct, baseline: o.baseline_value, target: o.target_value,
    current: o.evidence.value ?? null, n: o.evidence.n, unit: o.evidence.unit, source: o.evidence.source, origin: o.evidence.origin, series: o.evidence.series, milestones: o.milestone_summary,
  }))])),
  pathway: view.pathway ? { title: view.pathway.title, level: view.pathway.level } : null, clearance: view.clearance, staff_tally: Object.fromEntries(DOMAINS.map((d) => [d, view.domains[d].states])),
});

cap({
  name: 'start_academy_dev_review', method: 'POST', path: '/academy/dev-plans/:id/reviews', tag: TAG, status: 201,
  summary: 'Open a development review for a period (technical director or plan lead). One draft review per plan at a time; the plan moves to "in review". Contributors then add their sign-off or raise concerns, and the lead completes it.',
  input: z.object({ id, period_from: day, period_to: day }),
  handler: ({ user }, i) => tx(async (c) => {
    const { plan, a } = await planFor(user, i.id, c);
    needManage(a); live(plan);
    if (plan.status === 'draft') throw conflict('Activate the plan before reviewing it');
    if (i.period_to < i.period_from) throw badRequest('The review period ends before it starts');
    if ((await c.query("SELECT 1 FROM academy_dev_reviews WHERE plan_id=$1 AND status='draft'", [plan.id])).rows.length) throw conflict('A review is already open for this plan');
    const r = (await c.query('INSERT INTO academy_dev_reviews(plan_id, period_from, period_to, created_by) VALUES ($1,$2,$3,$4) RETURNING *', [plan.id, i.period_from, i.period_to, user.id])).rows[0];
    await c.query("UPDATE academy_dev_plans SET status='in_review', row_version=row_version+1, updated_at=now() WHERE id=$1", [plan.id]);
    await audit(c, user.id, 'start_academy_dev_review', 'academy_dev_reviews', r.id);
    return r;
  }),
});

cap({
  name: 'update_academy_dev_review', method: 'PATCH', path: '/academy/dev-reviews/:id', tag: TAG,
  summary: 'Write the review (technical director or plan lead; a contributor may write the note for their own domain): a family-facing summary and a staff-only note per domain. Send row_version; a stale version is refused. A signed-off review is frozen.',
  input: z.object({ id, row_version: z.number().int().min(1), summary: text(3, 2000).optional(), domain_notes: z.record(z.string(), text(2, 1500)).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const r = (await c.query('SELECT * FROM academy_dev_reviews WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!r) throw notFound('Review');
    const { plan, a } = await planFor(user, r.plan_id, c);
    if (r.status !== 'draft') throw conflict('A signed-off review cannot be changed');
    if (r.row_version !== i.row_version) throw conflict('This review changed since you opened it. Reload and try again.', { code: 'stale_version', row_version: r.row_version });
    if (Object.keys(i.domain_notes ?? {}).some((d) => !DOMAINS.includes(d))) throw badRequest('Unknown domain in the notes');
    if (i.summary && !a.can_manage) throw forbidden('Only the plan lead or the technical director writes the summary');
    if (!a.can_manage && !(a.write_domains.length && Object.keys(i.domain_notes ?? {}).every((d) => a.write_domains.includes(d)))) throw forbidden('You can only write notes for your own domains');
    const cur = r.domain_notes_enc ? JSON.parse(openT(r.domain_notes_enc, 'domain_notes')) : {};
    const notes = { ...cur, ...(i.domain_notes ?? {}) };
    const u = (await c.query('UPDATE academy_dev_reviews SET summary_enc=coalesce($2,summary_enc), domain_notes_enc=$3, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *', [r.id, i.summary ? sealT(i.summary, 'summary') : null, sealT(JSON.stringify(notes), 'domain_notes')])).rows[0];
    await audit(c, user.id, 'update_academy_dev_review', 'academy_dev_reviews', r.id);
    return { ...u, domain_notes_enc: undefined, summary_enc: undefined, plan_id: plan.id };
  }),
});

cap({
  name: 'sign_academy_dev_review', method: 'POST', path: '/academy/dev-reviews/:id/sign', tag: TAG, status: 201,
  summary: 'Sign a development review. The technical director/plan lead completes it ("approve"): it needs a summary and a note for every domain that has objectives, and any concern a contributor raised must be answered in the comment. Completing freezes a labelled snapshot of the evidence and, if share_with_family is true, makes the athlete-visible parts readable to the athlete and guardians (who are notified). Contributors approve or raise a concern before completion. After completion the athlete — or for a young athlete a verified guardian — acknowledges or raises a concern. Sign-offs are append-only; each person signs once.',
  input: z.object({ id, decision: z.enum(['approve', 'acknowledge', 'raise_concern']), comment: text(2, 1000).optional(), share_with_family: z.boolean().default(true) }),
  handler: ({ user }, i) => tx(async (c) => {
    const r = (await c.query('SELECT * FROM academy_dev_reviews WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!r) throw notFound('Review');
    const { plan, a } = await planFor(user, r.plan_id, c);
    const family = a.kind === 'athlete' || a.kind === 'guardian';
    if (family) {
      if (r.status !== 'signed_off' || !r.family_visible) throw notFound('Review');
      if (i.decision === 'approve') throw badRequest('Acknowledge the review, or raise a concern');
    } else if (r.status !== 'draft') throw conflict('This review is already signed off');
    if (i.decision === 'raise_concern' && !i.comment) throw badRequest('Say what your concern is');
    if (!family && i.decision === 'acknowledge') throw badRequest('Approve the review, or raise a concern');
    const capacity = family ? a.kind : a.can_manage ? 'lead' : 'contributor';
    if (capacity === 'contributor' && !a.write_domains.length) throw forbidden('Only people named as contributors to the plan sign its review');
    const dup = (await c.query('SELECT 1 FROM academy_dev_signoffs WHERE review_id=$1 AND user_id=$2 AND capacity=$3', [r.id, user.id, capacity])).rows.length;
    if (dup) throw conflict('You have already signed this review');
    let review = r;
    if (capacity === 'lead' && i.decision === 'approve') {
      if (!r.summary_enc) throw badRequest('Write the summary before signing off');
      const view = await buildView(user, plan, a);
      const notes = r.domain_notes_enc ? JSON.parse(openT(r.domain_notes_enc, 'domain_notes')) : {};
      const missing = DOMAINS.filter((d) => view.domains[d].objectives.length && !notes[d]);
      if (missing.length) throw badRequest(`Add a note for: ${missing.join(', ')}`);
      const concerns = (await c.query("SELECT 1 FROM academy_dev_signoffs WHERE review_id=$1 AND decision='raise_concern'", [r.id])).rows.length;
      if (concerns && !i.comment) throw badRequest('A contributor raised a concern. Answer it in your comment before signing off');
      review = (await c.query("UPDATE academy_dev_reviews SET status='signed_off', family_visible=$2, snapshot=$3, signed_off_by=$4, signed_off_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *", [r.id, i.share_with_family, JSON.stringify(snapshotOf(view)), user.id])).rows[0];
      await c.query("UPDATE academy_dev_plans SET status='active', row_version=row_version+1, updated_at=now() WHERE id=$1 AND status='in_review'", [plan.id]);
      if (i.share_with_family) {
        const to = await guardiansOf(plan.athlete_id, c);
        for (const uid of new Set([plan.athlete_id, ...to])) await notify(c, uid, { kind: 'academy_dev_review', title: 'A development review is ready to read', body: 'Open GotMyGame to read it and let the academy know you have seen it.', data: { plan_id: plan.id, review_id: r.id }, dedupe_key: `academy:dev:review:${r.id}:${uid}` });
      }
    }
    const s = (await c.query('INSERT INTO academy_dev_signoffs(review_id, user_id, capacity, decision, comment_enc) VALUES ($1,$2,$3,$4,$5) RETURNING id, review_id, capacity, decision, created_at', [r.id, user.id, capacity, i.decision, sealT(i.comment, 'signoff')])).rows[0];
    if (family && i.decision === 'raise_concern') await notify(c, plan.lead_id, { kind: 'academy_dev_concern', title: 'A family raised a concern on a development review', body: 'Open the plan to read and respond.', data: { plan_id: plan.id, review_id: r.id }, dedupe_key: `academy:dev:concern:${r.id}:${user.id}` });
    await audit(c, user.id, 'sign_academy_dev_review', 'academy_dev_reviews', r.id);
    return { signoff: s, review_status: review.status, family_visible: review.family_visible };
  }),
});

cap({
  name: 'record_academy_dev_decision', method: 'POST', path: '/academy/dev-plans/:id/decisions', tag: TAG, status: 201,
  summary: 'Record a human decision taken on the plan (technical director or plan lead): continue, change focus, adjust load, extra academic or psychology support, provider referral, pathway review, pause, or close the season. It must give a reason, is tied to a signed-off review where one exists and is append-only. It never moves an athlete on the pathway itself: a pathway decision is made in Progress and is linked here. Closing the season locks the plan. Idempotent with idempotency_key.',
  input: z.object({ id, kind: z.enum(DECISIONS), reason: text(3, 1000), review_id: id.optional(), progression_decision_id: id.optional(), idempotency_key: z.string().max(80).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { plan, a } = await planFor(user, i.id, c);
    needManage(a);
    if (plan.archived_at) throw conflict('This plan is archived and read-only');
    if (i.idempotency_key) { const dup = (await c.query('SELECT id, plan_id, kind, review_id, created_at FROM academy_dev_decisions WHERE decided_by=$1 AND idempotency_key=$2', [user.id, i.idempotency_key])).rows[0]; if (dup) return dup; }
    if (plan.status === 'closed') throw conflict('This season is closed');
    if (i.review_id && !(await c.query("SELECT 1 FROM academy_dev_reviews WHERE id=$1 AND plan_id=$2 AND status='signed_off'", [i.review_id, plan.id])).rows.length) throw badRequest('Decisions are taken on a signed-off review of this plan');
    if (i.kind === 'close_season' && (await c.query("SELECT 1 FROM academy_dev_reviews WHERE plan_id=$1 AND status='draft'", [plan.id])).rows.length) throw conflict('Finish or sign off the open review before closing the season');
    if (i.progression_decision_id && !(await c.query('SELECT 1 FROM academy_progression_decisions WHERE id=$1 AND organisation_id=$2 AND athlete_id=$3', [i.progression_decision_id, plan.organisation_id, plan.athlete_id])).rows.length) throw badRequest('That pathway decision is not for this athlete in this academy');
    const d = (await c.query('INSERT INTO academy_dev_decisions(plan_id, review_id, kind, reason_enc, progression_decision_id, decided_by, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, plan_id, kind, review_id, progression_decision_id, created_at', [plan.id, i.review_id ?? null, i.kind, sealT(i.reason, 'reason'), i.progression_decision_id ?? null, user.id, i.idempotency_key ?? null])).rows[0];
    if (i.kind === 'close_season') await c.query("UPDATE academy_dev_plans SET status='closed', row_version=row_version+1, updated_at=now() WHERE id=$1", [plan.id]);
    await audit(c, user.id, 'record_academy_dev_decision', 'academy_dev_decisions', d.id);
    return d;
  }),
});

// ---------------------------------------------------------------------------------------------- school summaries (athlete / guardian only)
cap({
  name: 'set_academy_dev_school_link', method: 'POST', path: '/academy/dev-plans/:id/school-links', tag: TAG,
  summary: 'The athlete, or a verified guardian of a young athlete, chooses whether one of the athlete\'s own school records (academic evidence) is shown on this plan, as kind, institution, period and provenance only; the summary text is never copied. Turn it off at any time: it disappears from the plan on the next read.',
  input: z.object({ id, evidence_id: id, shared: z.boolean() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { plan, a } = await planFor(user, i.id, c);
    if (a.kind !== 'athlete' && a.kind !== 'guardian') throw forbidden('Only the athlete or their guardian chooses what school information is shown');
    if (plan.status === 'draft' || plan.archived_at) throw conflict('This plan is not open to the family yet');
    if (!(await c.query('SELECT 1 FROM academic_evidence WHERE id=$1 AND user_id=$2 AND removed_at IS NULL', [i.evidence_id, plan.athlete_id])).rows.length) throw notFound('School record');
    if (i.shared) await c.query('INSERT INTO academy_dev_school_links(plan_id, evidence_id, linked_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [plan.id, i.evidence_id, user.id]);
    else await c.query('UPDATE academy_dev_school_links SET revoked_at=now(), revoked_by=$3 WHERE plan_id=$1 AND evidence_id=$2 AND revoked_at IS NULL', [plan.id, i.evidence_id, user.id]);
    await audit(c, user.id, i.shared ? 'link_academy_dev_school_record' : 'unlink_academy_dev_school_record', 'academy_dev_plans', plan.id);
    return { evidence_id: i.evidence_id, shared: i.shared };
  }),
});

// ---------------------------------------------------------------------------------------------- competency insight (the objective builder's evidence)
const quantile = (sorted, q) => { const p = (sorted.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p); return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo); };
const r1 = (x) => Math.round(x * 10) / 10;
const MIN_PEERS = 5;

/** Least-squares line through the monthly series, projected to the season end. Only with 3+ months of data; says how sure it is. */
export function project(series, endMonth) {
  const pts = series.filter((s) => s.value !== null);
  if (pts.length < 3) return { state: 'not_enough_data', months: pts.length };
  const idx = (m) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7));
  const x0 = idx(pts[0].month), xs = pts.map((p) => idx(p.month) - x0), ys = pts.map((p) => p.value);
  const n = pts.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  const den = xs.reduce((a, x) => a + (x - mx) ** 2, 0) || 1;
  const slope = xs.reduce((a, x, k) => a + (x - mx) * (ys[k] - my), 0) / den;
  const at = idx(endMonth) - x0;
  return { state: 'projected', slope_per_month: Math.round(slope * 100) / 100, end_value: r1(my + slope * (at - mx)), months: n, confidence: n >= 5 ? 'medium' : 'low' };
}

cap({
  name: 'get_academy_dev_insight', method: 'GET', path: '/academy/dev-plans/:id/insight', tag: TAG,
  summary: 'The evidence behind choosing an objective, for one domain of a plan (technical director, plan lead or a contributor for their domain). It returns the sport\'s own competency framework for that domain (every sport in the catalogue has one, or a labelled generic fallback), and for each competency: the coach rubric dimension that already measures it, the athlete\'s figure with its monthly series and number of data points, an anonymised peer benchmark from the athlete\'s own academy groups (quartiles only, and only when at least five peers have scores, never a name or an individual score), a suggested target with the method spelled out, a straight-line projection to the season end when there are three or more months of data, and the interventions coaches usually schedule for it. Academic and personal competencies are universal. Suggestions are never applied without the person choosing them.',
  input: z.object({ id, domain: z.enum(DOMAINS) }),
  async handler({ user }, i) {
    const { plan, a } = await planFor(user, i.id);
    if (!mayWrite(a, i.domain) && !a.can_manage) throw forbidden('You do not work in that domain on this plan');
    const fw = frameworkFor(plan.sport);
    const comps = fw.domains[i.domain];
    const rubrics = await many(
      `SELECT r.id, r.name, v.dimensions FROM coaching_rubrics r JOIN LATERAL (SELECT dimensions FROM coaching_rubric_versions WHERE rubric_id=r.id ORDER BY version DESC LIMIT 1) v ON true
        WHERE r.archived_at IS NULL AND (r.coach_id IN (SELECT coach_id FROM org_cohorts WHERE organisation_id=$1 AND coach_id IS NOT NULL) OR r.coach_id IN (SELECT user_id FROM organisation_members WHERE organisation_id=$1 AND status='active' AND role IN ('coach','owner','admin')))`, [plan.organisation_id]);
    const consent = await hasConsent(plan.athlete_id, 'coaching');
    const from = D(plan.starts_on) < D(new Date(Date.now() - 365 * 864e5)) ? D(new Date(Date.now() - 365 * 864e5)) : D(plan.starts_on);
    const to = today() < D(plan.ends_on) ? today() : D(plan.ends_on);
    const out = [];
    for (const comp of comps) {
      const dim = i.domain === 'academic' || i.domain === 'personal' ? null : matchDimension(comp, rubrics);
      const row = { key: comp.key, label: comp.label, tasks: comp.tasks, measure: dim ? { kind: 'rubric', rubric_id: dim.rubric_id, rubric: dim.rubric, dimension_key: dim.dimension_key, dimension: dim.dimension } : { kind: 'milestones' } };
      if (dim) {
        if (!consent) row.evidence = { state: 'no_consent' };
        else {
          const series = await rubricSeries(plan.athlete_id, plan.organisation_id, dim.rubric_id, dim.dimension_key, from, to);
          const n = series.reduce((s, r) => s + r.n, 0);
          const value = n ? r1(series.reduce((s, x) => s + x.value * x.n, 0) / n) : null;
          row.evidence = { state: n ? 'measured' : 'no_data', value, n, series, projection: project(series, D(plan.ends_on).slice(0, 7)) };
          // peers: athletes in the same academy groups with shared scores on this very dimension; quartiles only
          const peers = await many(
            `SELECT o.athlete_id, avg(o.score)::float8 AS v, count(*)::int AS n FROM coaching_observations o
              WHERE o.rubric_id=$1 AND o.dimension_key=$2 AND o.visibility='player' AND o.score IS NOT NULL AND o.observed_at::date BETWEEN $3 AND $4 AND o.athlete_id <> $5
                AND o.athlete_id IN (SELECT e.user_id FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.organisation_id=$6 AND e.status IN ('enrolled','paused')
                                       AND e.cohort_id IN (SELECT e2.cohort_id FROM org_enrolments e2 WHERE e2.user_id=$5))
              GROUP BY o.athlete_id HAVING count(*) >= 2`, [dim.rubric_id, dim.dimension_key, from, to, plan.athlete_id, plan.organisation_id]);
          const vals = [];
          for (const p of peers) if (await hasConsent(p.athlete_id, 'coaching')) vals.push(p.v);
          vals.sort((x, y) => x - y);
          if (vals.length >= MIN_PEERS) {
            const q1 = r1(quantile(vals, 0.25)), med = r1(quantile(vals, 0.5)), q3 = r1(quantile(vals, 0.75));
            row.benchmark = { state: 'ok', peers: vals.length, q1, median: med, q3, athlete_band: value === null ? null : value >= q3 ? 'top_quartile' : value >= med ? 'upper_middle' : value >= q1 ? 'lower_middle' : 'bottom_quartile', note: 'Peers are the other athletes in this athlete\'s academy groups with shared scores on this dimension. Quartiles only; no names or individual scores.' };
          } else row.benchmark = { state: 'not_enough_peers', peers: vals.length, needed: MIN_PEERS };
          // a suggestion with its method spelled out
          if (value !== null) {
            const q3 = row.benchmark.state === 'ok' ? row.benchmark.q3 : null;
            const target = q3 !== null ? (value >= q3 ? r1(value + Math.max(0.2, (row.benchmark.q3 - row.benchmark.median) * 0.5)) : r1(value + (q3 - value) * 0.8)) : r1(value + 0.5);
            row.suggestion = { target, method: q3 !== null ? (value >= q3 ? 'already in the top quartile of peers: a further half of the gap between median and top quartile' : 'four fifths of the way from the current average to the peer top quartile') : 'half a point above the current average (no peer benchmark yet)' };
          }
        }
      }
      out.push(row);
    }
    await audit(null, user.id, 'read_academy_dev_insight', 'academy_dev_plans', plan.id);
    return { domain: i.domain, sport: plan.sport, framework: { family: fw.family, label: fw.label, fallback: fw.fallback }, window: { from, to }, competencies: out, rubrics_available: rubrics.length };
  },
});

// ---------------------------------------------------------------------------------------------- squad board
const WORST = ['behind', 'no_data', 'tracking', 'on_track', 'achieved'];
cap({
  name: 'get_academy_dev_board', method: 'GET', path: '/organisations/:id/academy/dev-plans/board', tag: TAG,
  summary: 'The squad board: one row per athlete with a live plan (owner/admin see all; a coach their own athletes and plans they lead), a cell per domain showing how many objectives sit in each state and the weakest state, and an explained attention list. Attention reasons are rules, never a score: review overdue, objectives behind the season line, objectives with no data, overdue tasks, a domain with no objective, work scheduled inside an exam or recovery phase, and a fit status that is not cleared (only when the athlete shared it). Ordered by number of reasons, then name.',
  input: z.object({ id, sport: z.string().max(60).optional() }),
  async handler({ user }, i) {
    const role = await orgRole(user, i.id);
    if (!role) throw notFound('Organisation');
    const rows = await many("SELECT p.*, u.display_name AS athlete_name FROM academy_dev_plans p JOIN users u ON u.id=p.athlete_id WHERE p.organisation_id=$1 AND p.archived_at IS NULL AND p.status IN ('active','in_review') AND ($2::text IS NULL OR p.sport=$2) ORDER BY u.display_name, p.id", [i.id, i.sport ?? null]);
    const out = [];
    for (const p of rows) {
      const a = await accessTo(user, p);
      if (!a || !['staff', 'lead', 'coach'].includes(a.kind)) continue;
      const v = await buildView(user, p, a);
      const cells = Object.fromEntries(DOMAINS.map((d) => {
        const list = v.domains[d].objectives, st = tally(list.map((x) => x.state));
        return [d, { objectives: list.length, states: st, worst: list.length ? WORST.find((w) => st[w]) : 'empty' }];
      }));
      const reasons = [];
      if (v.strip.review_overdue) reasons.push({ code: 'review_overdue', on: v.strip.next_review_on });
      if (v.strip.behind) reasons.push({ code: 'behind', n: v.strip.behind });
      if (v.strip.no_data) reasons.push({ code: 'no_data', n: v.strip.no_data });
      if (v.strip.interventions_overdue) reasons.push({ code: 'tasks_overdue', n: v.strip.interventions_overdue });
      const empty = DOMAINS.filter((d) => !cells[d].objectives);
      if (empty.length) reasons.push({ code: 'domains_uncovered', domains: empty });
      if (v.clashes.length) reasons.push({ code: 'phase_clash', n: v.clashes.length });
      if (v.clearance?.state === 'shared' && ['not_cleared', 'expired', 'restricted'].includes(v.clearance.status)) reasons.push({ code: 'fit_status', status: v.clearance.status });
      out.push({ plan_id: p.id, athlete: v.plan.athlete, athlete_name: p.athlete_name, sport: p.sport, season_label: p.season_label, lead: v.plan.lead, status: p.status, cells, reasons, phase_now: v.phases.find((x) => x.from <= today() && today() <= x.to) ?? null });
    }
    out.sort((x, y) => y.reasons.length - x.reasons.length || x.athlete_name.localeCompare(y.athlete_name));
    return { total: out.length, sports: [...new Set(rows.map((r) => r.sport))].sort(), items: out };
  },
});
