// Development plan: how a measured figure is shown on every client (web, iOS, iPadOS, Android). Pure functions with no React or native imports, so
// the same rules are unit-tested once. The API decides the state (src/academy-dev-trend.js); this file only decides how to say it, and makes sure
// "no data" is never drawn as a zero and a missing baseline is never drawn as a starting point.

export const DOMAINS = ['technical', 'tactical', 'physical', 'mental', 'academic', 'personal'];
export const DOMAIN_ICON = { technical: '🎯', tactical: '♟️', physical: '💪', mental: '🧠', academic: '🎓', personal: '🌱' };

/** icon + i18n key + theme token name for each state; the label is always printed, colour is never the only signal. */
export const STATE_META = {
  no_data: { icon: '∅', key: 'dp.state.no_data', tone: 'mute' },
  tracking: { icon: '〰', key: 'dp.state.tracking', tone: 'cyan' },
  on_track: { icon: '▲', key: 'dp.state.on_track', tone: 'lime' },
  behind: { icon: '▼', key: 'dp.state.behind', tone: 'orange' },
  achieved: { icon: '✓', key: 'dp.state.achieved', tone: 'lime' },
};
export const stateMeta = (s) => STATE_META[s] ?? STATE_META.no_data;

const isNum = (v) => v !== null && v !== undefined && v !== '' && !Number.isNaN(Number(v));

/** A figure for display: null/undefined is an em dash (missing), a real zero is "0". */
export function figure(v, digits = 1) {
  if (!isNum(v)) return '—';
  const n = Number(v);
  return Number.isInteger(n) ? String(n) : n.toFixed(digits).replace(/\.0+$/, '');
}

/**
 * Where baseline / now / expected / target sit on one bar, as 0..100 percentages of the span they cover. Missing values are null (not drawn),
 * so an objective with no data shows an empty bar and an honest caption instead of a bar stuck at zero.
 */
export function meterGeometry({ baseline, current, target, expected }) {
  const pts = [baseline, current, target, expected].filter(isNum).map(Number);
  if (!pts.length) return { span: null, baseline: null, current: null, target: null, expected: null };
  const lo = Math.min(...pts), hi = Math.max(...pts);
  const pad = hi === lo ? 1 : (hi - lo) * 0.08;
  const a = lo - pad, b = hi + pad;
  const at = (v) => (isNum(v) ? Math.round(((Number(v) - a) / (b - a)) * 1000) / 10 : null);
  return { span: [a, b], baseline: at(baseline), current: at(current), target: at(target), expected: at(expected) };
}

/** A short series as bar heights (0..100) with month labels; an empty series yields [] so the caller shows the empty state. */
export function seriesBars(series) {
  const pts = (series ?? []).filter((p) => isNum(p.value));
  if (!pts.length) return [];
  const hi = Math.max(...pts.map((p) => Number(p.value))), lo = Math.min(0, ...pts.map((p) => Number(p.value)));
  return pts.map((p) => ({ month: p.month, value: Number(p.value), n: p.n ?? null, height: Math.max(8, Math.round(((Number(p.value) - lo) / (hi - lo || 1)) * 100)) }));
}

/** Why a figure is missing, as an i18n key the screen translates. */
export function missingKey(objective) {
  if (objective.missing === 'no_consent') return 'dp.missing.no_consent';
  const e = objective.evidence ?? {};
  if (objective.metric_kind === 'milestones') return objective.milestones?.length ? null : 'dp.missing.no_milestones';
  if (objective.metric_kind === 'coach_goal') return e.goal ? null : 'dp.missing.goal_gone';
  if (e.value === null || e.value === undefined) return objective.metric_kind === 'official' ? 'dp.missing.no_official' : objective.metric_kind === 'attendance' ? 'dp.missing.no_sessions' : 'dp.missing.no_observations';
  return null;
}

/** Headline counts only; there is deliberately no sum or average across objectives or domains. */
export function countsOf(strip) {
  const s = strip ?? {};
  return { objectives: s.objectives ?? 0, on_track: (s.on_track ?? 0) + (s.achieved ?? 0), behind: s.behind ?? 0, no_data: s.no_data ?? 0, tracking: s.tracking ?? 0 };
}

export const OBJECTIVE_STATES = Object.keys(STATE_META);
