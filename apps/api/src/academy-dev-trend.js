// Academy development plan: the one place that turns a measured figure into an honest state. Pure functions, no I/O, so the same rules are
// tested once and every client (web, iOS, iPadOS, Android) simply renders what the API says. There is deliberately NO combined score: each
// objective is judged on its own metric, in its own unit, and "no data" is a state of its own, never a zero.

export const DOMAINS = ['technical', 'tactical', 'physical', 'mental', 'academic', 'personal'];
export const STATES = ['no_data', 'tracking', 'on_track', 'behind', 'achieved'];

const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const day = (d) => (d instanceof Date ? d : new Date(`${String(d).slice(0, 10)}T12:00:00Z`));

/** Share of the season window that has elapsed on `today`, 0..1. */
export function elapsed(from, to, today) {
  const a = day(from).getTime(), b = day(to).getTime(), t = day(today).getTime();
  if (!(b > a)) return 1;
  return Math.min(1, Math.max(0, (t - a) / (b - a)));
}

/**
 * Judge one objective.
 *  - no current figure                      -> 'no_data' (never treated as 0)
 *  - no target                              -> 'tracking' (there is a figure, nothing to compare it with)
 *  - current reached the target             -> 'achieved' (direction-aware: a lower target, e.g. a time, is reached from above)
 *  - no baseline                            -> 'tracking' (we will not claim on/behind without a starting point)
 *  - otherwise compare with the straight line from baseline to target across the season window.
 * `low_evidence` is raised when fewer than `minN` observations back the figure, so the screen can say so instead of overstating it.
 */
export function judge({ baseline, current, target, n = null, minN = 2, from, to, today }) {
  const b = num(baseline), cur = num(current), tgt = num(target);
  const lower = b !== null && tgt !== null && tgt < b;
  const low_evidence = n !== null && n < minN;
  if (cur === null) return { state: 'no_data', lower_is_better: lower, progress_pct: null, expected: null, low_evidence: false };
  if (tgt === null) return { state: 'tracking', lower_is_better: lower, progress_pct: null, expected: null, low_evidence };
  const reached = lower ? cur <= tgt : cur >= tgt;
  const progress_pct = b !== null && b !== tgt ? Math.round(Math.max(0, Math.min(1.2, (cur - b) / (tgt - b))) * 100) : reached ? 100 : null;
  if (reached) return { state: 'achieved', lower_is_better: lower, progress_pct, expected: tgt, low_evidence };
  if (b === null) return { state: 'tracking', lower_is_better: lower, progress_pct, expected: null, low_evidence };
  const expected = Math.round((b + (tgt - b) * elapsed(from, to, today)) * 100) / 100;
  const ok = lower ? cur <= expected : cur >= expected;
  return { state: ok ? 'on_track' : 'behind', lower_is_better: lower, progress_pct, expected, low_evidence };
}

/** Milestones are their own metric: done / counted (skipped ones do not count), overdue pending ones make it 'behind'. */
export function judgeMilestones(list, today) {
  const counted = list.filter((m) => m.status !== 'skipped');
  const done = counted.filter((m) => m.status === 'done').length;
  const overdue = counted.filter((m) => m.status === 'pending' && String(m.due_on).slice(0, 10) < String(today).slice(0, 10)).length;
  if (!counted.length) return { state: 'no_data', done: 0, total: 0, overdue: 0, progress_pct: null };
  const state = done === counted.length ? 'achieved' : overdue ? 'behind' : 'on_track';
  return { state, done, total: counted.length, overdue, progress_pct: Math.round((done / counted.length) * 100) };
}

/** Count objectives per state for the headline strip. Counts only: nothing is averaged or added across domains. */
export function tally(items) {
  const out = { no_data: 0, tracking: 0, on_track: 0, behind: 0, achieved: 0 };
  for (const s of items) if (s in out) out[s] += 1;
  return out;
}
