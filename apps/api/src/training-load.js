// Pro-level plan structure (issue #326): periodisation phases, session objectives and training load.
// Load uses the session-RPE method (Foster et al., 2001): load (arbitrary units) = perceived effort 1-10 x minutes.
// It is a coaching planning aid, not a medical or injury-risk measure, and every figure here is computed on read from the
// stored plan and the athlete's own records - nothing derived is stored.
import { z } from 'zod';
import { badRequest } from './errors.js';

export const PHASE_KINDS = ['preparation', 'pre_competition', 'competition', 'transition', 'return_to_play'];
export const FOCUS = ['speed', 'endurance', 'strength', 'power', 'technical', 'tactical', 'recovery'];
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !isNaN(Date.parse(d)), 'Not a valid date');

export const phaseIn = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  kind: z.enum(PHASE_KINDS),
  label: z.string().min(1).max(120),
  from: date, to: date,
  focus: z.string().max(300).optional().describe('what this phase is for, in a sentence'),
}).strict();
export const phasesIn = z.array(phaseIn).max(12);

export function validatePhases(phases) {
  const sorted = [...phases].sort((a, b) => a.from.localeCompare(b.from));
  sorted.forEach((p, i) => {
    if (p.from > p.to) throw badRequest(`Phase “${p.label}”: it ends before it starts`);
    if (i && sorted[i - 1].to >= p.from) throw badRequest(`Phases “${sorted[i - 1].label}” and “${p.label}” overlap`);
  });
  if (new Set(phases.map((p) => p.id)).size !== phases.length) throw badRequest('Two phases share an id');
}

const day = (iso) => new Date(iso).toISOString().slice(0, 10);
const monday = (iso) => { const d = new Date(iso); const k = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - k); return d.toISOString().slice(0, 10); };
export const phaseOn = (phases, iso) => (phases ?? []).find((p) => day(iso) >= p.from && day(iso) <= p.to) ?? null;
const load = (rpe, min) => (rpe && min ? rpe * min : null);

/**
 * Weekly microcycles: planned versus completed minutes and load, sessions done, average block compliance and the week-on-week change.
 * `athleteData` false (access revoked) leaves the athlete-recorded columns out.
 */
export function buildWeeks(sessions, phases, athleteData, compareFn) {
  const by = new Map();
  for (const s of sessions) {
    if (s.status === 'cancelled') continue;
    const k = monday(s.starts_at);
    const w = by.get(k) ?? { week_start: k, sessions: 0, completed: 0, skipped: 0, planned_min: 0, completed_min: 0, planned_load: 0, actual_load: 0, _pcts: [], _first: s.starts_at };
    if (new Date(s.starts_at) < new Date(w._first)) w._first = s.starts_at;
    w.sessions++; w.planned_min += s.duration_min; w.planned_load += load(s.target_rpe, s.duration_min) ?? 0;
    if (athleteData) {
      if (s.status === 'completed') {
        w.completed++; w.completed_min += s.duration_min; w.actual_load += load(s.athlete_rpe, s.duration_min) ?? 0;
        if (s.structure && s.actuals) w._pcts.push(compareFn(s.structure, s.actuals).pct);
      } else if (s.status === 'skipped') w.skipped++;
    }
    by.set(k, w);
  }
  const weeks = [...by.values()].sort((a, b) => a.week_start.localeCompare(b.week_start));
  weeks.forEach((w, i) => {
    const pcts = w._pcts.filter((x) => x !== null && x !== undefined); delete w._pcts;
    // a week belongs to the phase that is running at its first session; a plan that starts midweek still labels its first week (Monday alone would miss it)
    w.phase = (phaseOn(phases, w._first) ?? phaseOn(phases, `${w.week_start}T12:00:00Z`))?.label ?? null; delete w._first;
    w.compliance_pct = pcts.length ? Math.round(pcts.reduce((a, x) => a + x, 0) / pcts.length) : null;
    const prev = weeks[i - 1];
    w.planned_load_change_pct = prev?.planned_load ? Math.round(((w.planned_load - prev.planned_load) / prev.planned_load) * 100) : null;
    w.large_planned_increase = w.planned_load_change_pct !== null && w.planned_load_change_pct > 30;
    if (!athleteData) { w.completed = w.skipped = w.completed_min = w.actual_load = null; w.compliance_pct = null; }
  });
  return weeks;
}

export const sessionLoad = (s, athleteData) => ({ planned_load: load(s.target_rpe, s.duration_min), actual_load: athleteData && s.status === 'completed' ? load(s.athlete_rpe, s.duration_min) : null });
