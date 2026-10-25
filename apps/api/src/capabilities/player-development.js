import { z } from 'zod';
import { cap, capabilities, id, page } from '../registry.js';
import { many } from '../db.js';
import { audit } from '../helpers.js';
import { hasConsent, isYouth, requireGuardian } from '../youth.js';
import { CONSENT_OK, sharedActions, sharedGoals, sharedNotes, sharedReports, sharedSummaries } from '../coaching-shared.js';

const TAG = 'Player development';
export const SECTIONS = ['next_actions', 'goals', 'plans', 'feedback', 'assessments', 'reports'];

// How an item came to be, stated honestly on every row. 'basis' is the kind of evidence, 'source' the module that owns the record.
const SRC = {
  coaching_action: ['Coach action', 'coach_set'], coaching_goal: ['Coaching goal', 'coach_set'], training_plan: ['Training plan', 'coach_set'],
  plan_session: ['Plan session', 'coach_set'], plan_feedback: ['Session feedback', 'coach_observed'], coaching_note: ['Coach note', 'coach_observed'],
  coaching_summary: ['Session summary', 'coach_observed'], coaching_report: ['Coaching report', 'coach_observed'],
  trial_assessment: ['Trial assessment', 'assessor_rated'], academy_assessment: ['Academy assessment', 'assessor_rated'], trial_follow_up: ['Trial follow-up', 'staff_set'],
  academy_review: ['Academy review', 'derived'],
};
const prov = (type, by, at, record) => ({ source: type, source_label: SRC[type][0], basis: SRC[type][1], by: by ?? null, at: at ?? null, record });

const DAY = 864e5;
const rank = { overdue: 0, needs_response: 1, due_soon: 2, upcoming: 3, none: 4 };
const urgency = (due, now) => {
  if (!due) return 'none';
  const t = new Date(due).getTime();
  return t < now ? 'overdue' : t - now <= 7 * DAY ? 'due_soon' : 'upcoming';
};

/** Another capability's data, read through its own handler so its permission and consent rules apply unchanged. */
const through = (name, user, input) => capabilities.find((c) => c.name === name).handler({ user }, input);

const PLAN_SQL = `SELECT p.id, p.title, p.goal, p.status, p.updated_at, s.name AS sport, uc.display_name AS coach_name,
    (SELECT count(*)::int FROM training_sessions x WHERE x.plan_id=p.id AND x.status='completed') AS completed,
    (SELECT count(*)::int FROM training_sessions x WHERE x.plan_id=p.id AND x.status IN ('scheduled','completed','skipped')) AS total,
    (SELECT min(x.starts_at) FROM training_sessions x WHERE x.plan_id=p.id AND x.status='scheduled' AND x.starts_at > now()) AS next_session_at,
    ((SELECT response FROM training_plan_revisions r WHERE r.plan_id=p.id AND r.rev=p.current_rev) = 'pending') AS awaiting_answer
  FROM training_plans p JOIN users uc ON uc.id=p.coach_id LEFT JOIN sports s ON s.id=p.sport_id`;

const plans = (athleteId, { limit, offset }) => many(
  `${PLAN_SQL} WHERE p.athlete_id=$1 AND p.status <> 'draft' AND ${CONSENT_OK('p.athlete_id')}
    ORDER BY (p.status <> 'closed') DESC, p.updated_at DESC, p.id LIMIT $2 OFFSET $3`, [athleteId, limit, offset]);

const planFeedback = (athleteId, { limit, offset }) => many(
  `SELECT x.id, x.title, x.status, x.completed_at, x.coach_feedback, x.athlete_rpe, x.target_rpe, p.id AS plan_id, p.title AS plan_title, u.display_name AS coach_name
     FROM training_sessions x JOIN training_plans p ON p.id=x.plan_id JOIN users u ON u.id=p.coach_id
    WHERE p.athlete_id=$1 AND p.status <> 'draft' AND x.coach_feedback IS NOT NULL AND ${CONSENT_OK('p.athlete_id')}
    ORDER BY x.completed_at DESC NULLS LAST, x.id LIMIT $2 OFFSET $3`, [athleteId, limit, offset]);

const upcomingSessions = (athleteId) => many(
  `SELECT x.id, x.title, x.starts_at, x.kind, x.duration_min, p.id AS plan_id, p.title AS plan_title, u.display_name AS coach_name
     FROM training_sessions x JOIN training_plans p ON p.id=x.plan_id JOIN users u ON u.id=p.coach_id
    WHERE p.athlete_id=$1 AND p.status='active' AND x.status='scheduled' AND x.starts_at > now() AND x.starts_at < now() + interval '14 days' AND ${CONSENT_OK('p.athlete_id')}
    ORDER BY x.starts_at, x.id LIMIT 5`, [athleteId]);

/** Everything the athlete (or a verified guardian) is asked to do next, from the sources that own each item. */
function nextActions({ actions, goals, planRows, sessions, trials, academy, self }) {
  const now = Date.now();
  const out = [];
  for (const a of actions.filter((x) => x.status === 'open' || x.status === 'in_progress')) {
    out.push({ kind: 'coach_action', id: a.id, title: a.title, detail: a.detail, due_at: a.due_at, urgency: urgency(a.due_at, now), priority: a.priority, status: a.status, row_version: a.row_version,
      can_complete: self, link: null, provenance: prov('coaching_action', a.coach_name, a.due_at, { type: 'coaching_actions', id: a.id }) });
  }
  if (self) for (const p of planRows.filter((x) => x.awaiting_answer)) {
    out.push({ kind: 'plan_response', id: p.id, title: `Answer your coach: ${p.title}`, detail: 'A new plan or revision is waiting for you to accept, ask for changes or decline.', due_at: null, urgency: 'needs_response',
      link: { screen: 'CoachPlan', params: { id: p.id } }, provenance: prov('training_plan', p.coach_name, p.updated_at, { type: 'training_plans', id: p.id }) });
  }
  for (const s of sessions) {
    out.push({ kind: 'plan_session', id: s.id, title: s.title, detail: `${s.plan_title} · ${s.duration_min} min ${s.kind}`, due_at: s.starts_at, urgency: urgency(s.starts_at, now),
      link: { screen: 'CoachPlan', params: { id: s.plan_id } }, provenance: prov('plan_session', s.coach_name, s.starts_at, { type: 'training_sessions', id: s.id }) });
  }
  for (const g of goals.filter((x) => (x.status === 'planned' || x.status === 'active') && x.review_on && new Date(`${String(x.review_on).slice(0, 10)}T23:59:59Z`).getTime() - now <= 14 * DAY)) {
    const due = `${String(g.review_on).slice(0, 10)}T23:59:59Z`;
    out.push({ kind: 'goal_review', id: g.id, title: `Review goal: ${g.title}`, detail: g.text, due_at: due, urgency: urgency(due, now), link: null,
      provenance: prov('coaching_goal', g.coach_name, due, { type: 'coaching_goals', id: g.id }) });
  }
  for (const t of trials) for (const f of t.follow_ups ?? []) {
    if (f.status !== 'open') continue;
    const due = f.due_on ? `${String(f.due_on).slice(0, 10)}T23:59:59Z` : null;
    out.push({ kind: 'trial_follow_up', id: f.id, title: f.title, detail: f.detail, due_at: due, urgency: urgency(due, now), link: { screen: 'Trials' },
      provenance: prov('trial_follow_up', null, due, { type: 'trial_follow_ups', id: f.id }) });
  }
  for (const a of academy) if (a.next_review_on) {
    const due = `${a.next_review_on}T23:59:59Z`;
    out.push({ kind: 'academy_review', id: a.pathway_id, title: `Academy review: ${a.title}`, detail: 'Next pathway look is due about then; nothing is needed from you.', due_at: due, urgency: urgency(due, now),
      link: { screen: 'Orgs' }, provenance: prov('academy_review', null, due, { type: 'academy_pathways', id: a.pathway_id }) });
  }
  return out.sort((x, y) => rank[x.urgency] - rank[y.urgency] || (x.due_at ? new Date(x.due_at).getTime() : Infinity) - (y.due_at ? new Date(y.due_at).getTime() : Infinity) || 0 || x.kind.localeCompare(y.kind) || String(x.id).localeCompare(String(y.id)));
}

cap({
  name: 'get_my_development', method: 'GET', path: '/me/development', tag: TAG, auth: 'user',
  summary: 'The player development workspace: next actions, coaching goals, training plans, coach feedback, shared assessments and reports in one view, each row labelled with the record that owns it, who made it and what kind of evidence it is. Reads existing coaching, plan, trial and academy records (nothing is copied). Pass athlete_id as a verified guardian to see the same for a young person, read-only; for a young person everything is hidden unless a guardian\'s current coaching consent stands, and withdrawing it hides it again at once. Private coach notes never appear. Pass section to page through one section (limit/offset, stable order).',
  input: z.object({ athlete_id: id.optional(), section: z.enum(SECTIONS).optional(), ...page, limit: z.coerce.number().int().min(1).max(50).default(10) }),
  async handler({ user }, i) {
    const athleteId = i.athlete_id ?? user.id;
    const self = athleteId === user.id;
    if (!self) { await requireGuardian(user, athleteId); await audit(null, user.id, 'read_child_development', 'users', athleteId); }
    const youth = await isYouth(athleteId);
    const base = { athlete_id: athleteId, viewer: self ? 'self' : 'guardian', is_youth: youth, generated_at: new Date().toISOString() };
    if (youth && !(await hasConsent(athleteId, 'coaching'))) {
      return { ...base, consent: false, note: self ? 'Coaching sharing is switched off by your guardian, so nothing from your coach is shown. Your guardian can allow it under Family & guardians.' : 'Coaching sharing is not allowed for this child. Allow it under Family & guardians to see their development workspace.', sections: {}, counts: {}, next_actions: [] };
    }
    const only = i.section;
    const want = (s) => !only || only === s;
    const win = only ? { limit: i.limit + 1, offset: i.offset } : { limit: i.limit + 1, offset: 0 };
    const big = { limit: 100, offset: 0 };
    const cut = (rows) => ({ items: rows.slice(0, i.limit), has_more: rows.length > i.limit });
    const audience = self ? 'athlete' : 'guardian';

    // next actions need a wider read than one page of each source, then are merged and cut once
    const needNext = want('next_actions');
    const [actions, goalsAll, planAll, sessions, trialsRes, academyRes] = await Promise.all([
      needNext ? sharedActions(athleteId, big) : [], needNext ? sharedGoals(athleteId, big) : [], needNext ? plans(athleteId, big) : [],
      needNext ? upcomingSessions(athleteId) : [],
      want('next_actions') || want('assessments') ? through('my_trials', user, { athlete_id: athleteId }) : { items: [] },
      want('next_actions') || want('assessments') ? through('get_my_academy_progress', user, { athlete_id: athleteId }) : { academies: [] },
    ]);
    const trials = trialsRes.items ?? [];
    const academy = (academyRes.academies ?? []).flatMap((a) => a.pathways.map((p) => ({ ...p, organisation: a.organisation })));
    const sections = {};

    if (want('next_actions')) {
      const merged = nextActions({ actions, goals: goalsAll, planRows: planAll, sessions, trials, academy, self });
      const slice = merged.slice(only ? i.offset : 0, (only ? i.offset : 0) + i.limit);
      sections.next_actions = { items: slice, has_more: merged.length > (only ? i.offset : 0) + i.limit, total: merged.length };
    }
    if (want('goals')) sections.goals = cut((await sharedGoals(athleteId, win)).map((g) => ({ ...g, provenance: prov('coaching_goal', g.coach_name, g.review_on, { type: 'coaching_goals', id: g.id }) })));
    if (want('plans')) sections.plans = cut((await plans(athleteId, win)).map((p) => ({ ...p, can_respond: self && !!p.awaiting_answer, provenance: prov('training_plan', p.coach_name, p.updated_at, { type: 'training_plans', id: p.id }) })));
    if (want('feedback')) {
      // three sources, newest first, cut once: coach feedback on plan sessions, notes shared with the player, session summaries
      const span = { limit: i.offset + i.limit + 1, offset: 0 };
      const [fb, notes, sums] = await Promise.all([planFeedback(athleteId, span), sharedNotes(athleteId, span), sharedSummaries(athleteId, span)]);
      const all = [
        ...fb.map((f) => ({ kind: 'plan_feedback', id: f.id, title: f.title, text: f.coach_feedback, at: f.completed_at, by: f.coach_name, context: f.plan_title, link: { screen: 'CoachPlan', params: { id: f.plan_id } }, provenance: prov('plan_feedback', f.coach_name, f.completed_at, { type: 'training_sessions', id: f.id }) })),
        ...notes.map((n) => ({ kind: 'coaching_note', id: n.id, title: [n.skill_tag, n.obs_type].filter(Boolean).join(' · '), text: n.note, at: n.observed_at, by: n.coach_name, context: n.visibility === 'team' ? 'Shared with the team' : 'Shared with you', link: null, provenance: prov('coaching_note', n.coach_name, n.observed_at, { type: 'coaching_observations', id: n.id }) })),
        ...sums.map((s) => ({ kind: 'coaching_summary', id: `${s.session_record_id}:${s.kind}`, title: s.title, text: s.summary, at: s.at, by: s.coach_name, context: s.kind === 'team' ? 'Team summary' : 'Just for you', link: null, provenance: prov('coaching_summary', s.coach_name, s.at, { type: 'coaching_session_records', id: s.session_record_id }) })),
      ].sort((a, b) => (new Date(b.at ?? 0).getTime() - new Date(a.at ?? 0).getTime()) || String(a.id).localeCompare(String(b.id)));
      sections.feedback = { items: all.slice(i.offset, i.offset + i.limit), has_more: all.length > i.offset + i.limit };
    }
    if (want('assessments')) {
      const list = [];
      for (const t of trials) for (const f of t.feedback ?? []) {
        list.push({ kind: 'trial_assessment', id: f.id, title: `${t.name} · ${f.rubric_name}`, outcome: null, scores: f.scores, dimensions: f.dimensions, text: f.feedback, at: f.assessed_at, by: f.assessor_name, link: { screen: 'Trials' },
          provenance: prov('trial_assessment', f.assessor_name, f.assessed_at, { type: 'trial_assessments', id: f.id }) });
      }
      for (const p of academy) for (const a of p.assessments ?? []) {
        list.push({ kind: 'academy_assessment', id: a.id, title: `${p.title}${p.level_title ? ` · ${p.level_title}` : ''}`, outcome: a.outcome, scores: null, text: a.comment, at: a.created_at, by: p.organisation.name, period: [a.period_from, a.period_to], link: { screen: 'Orgs' },
          provenance: prov('academy_assessment', p.organisation.name, a.created_at, { type: 'academy_assessments', id: a.id }) });
      }
      list.sort((a, b) => (new Date(b.at ?? 0).getTime() - new Date(a.at ?? 0).getTime()) || String(a.id).localeCompare(String(b.id)));
      sections.assessments = { items: list.slice(i.offset, i.offset + i.limit), has_more: list.length > i.offset + i.limit };
    }
    if (want('reports')) sections.reports = cut((await sharedReports(athleteId, audience, win)).map((r) => ({ ...r, id: r.report_id, text: `${r.kind.replace(/_/g, ' ')} · version ${r.version}`, link: { screen: 'CoachReportView', params: { id: r.report_id, version: r.version } }, provenance: prov('coaching_report', r.coach_name, r.published_at, { type: 'coaching_reports', id: r.report_id }) })));

    return { ...base, consent: true, note: null, sections, counts: Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, v.items.length])) };
  },
});
