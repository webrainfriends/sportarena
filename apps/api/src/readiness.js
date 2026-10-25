// Pure maths for the athlete's readiness score and acute:chronic workload ratio (ACWR). No database access.
// Readiness is a simple, explainable 0-100 score from what the athlete logged; it is guidance, never a diagnosis.

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Bump when the maths change (not when a qualified person adjusts the settings below: that is a config version). */
export const FORMULA = { id: 'readiness', version: '1.0', evidence: 'heuristic' };

/** The standard settings. Everything adjustable lives here, with the range a qualified coach or clinician may move it within. */
export const DEFAULT_CONFIG = {
  weights: { sleep: 0.4, soreness: 0.35, mood: 0.25 },
  bands: { ready_min: 70, moderate_min: 40 },
  workload: { low_below: 0.8, optimal_max: 1.3, caution_max: 1.5, caution_penalty: 5, high_penalty: 10, min_span_days: 20 },
};
export const BOUNDS = {
  weights: { min: 0.1, max: 0.7 },
  bands: { ready_min: [50, 90], moderate_min: [20, 60] },
  workload: { low_below: [0.5, 1.0], optimal_max: [1.1, 1.6], caution_max: [1.3, 2.0], caution_penalty: [0, 15], high_penalty: [0, 25], min_span_days: [14, 35] },
};
/** What is deliberately not adjustable, so the explanation can say so. */
export const FIXED = [
  'Sleep is scored as 70% hours slept (8 h = full marks) and 30% sleep quality.',
  'Soreness counts 0 (fresh) to 10 (very sore) against you; mood 1 to 5 counts for you.',
  'Workload is this week\'s load against your 28-day weekly average; load is minutes x effort (RPE).',
  'An open body-map entry stands in for soreness only when you did not log soreness that day.',
];
export const LIMITATIONS = [
  'A simple, explainable heuristic built from what you logged. It has not been validated to predict injury, illness or performance.',
  'It is not a diagnosis, medical advice or clearance to train or play. Pain that does not settle needs a physio or doctor.',
  'Everything is self-reported. A missing day or input is not estimated: the score uses only what was logged and says how much that is.',
  'The workload ratio needs weeks of logged sessions. Until then it is shown as building and does not change the score.',
  'Thresholds and weights are fixed rules of thumb unless a qualified coach or clinician has adjusted them for you; any change is shown here with who and why.',
];

const r3 = (n) => Math.round(n * 1000) / 1000;
/** Validate a full config; returns an array of plain-language problems (empty = valid). */
export function configProblems(cfg) {
  const out = [];
  const w = cfg?.weights, b = cfg?.bands, k = cfg?.workload;
  if (!w || !b || !k) return ['Weights, bands and workload settings are all required'];
  for (const key of Object.keys(DEFAULT_CONFIG.weights)) if (!(w[key] >= BOUNDS.weights.min && w[key] <= BOUNDS.weights.max)) out.push(`${key} weight must be between ${BOUNDS.weights.min * 100}% and ${BOUNDS.weights.max * 100}%`);
  const sum = Object.keys(DEFAULT_CONFIG.weights).reduce((a, key) => a + (w[key] ?? 0), 0);
  if (Math.abs(sum - 1) > 0.001) out.push(`Weights must add up to 100% (they add up to ${Math.round(sum * 1000) / 10}%)`);
  for (const [key, [lo, hi]] of Object.entries(BOUNDS.bands)) if (!(b[key] >= lo && b[key] <= hi)) out.push(`${key} must be between ${lo} and ${hi}`);
  if (b.moderate_min >= b.ready_min) out.push('The "take it steady" threshold must be below the "ready" threshold');
  for (const [key, [lo, hi]] of Object.entries(BOUNDS.workload)) if (!(k[key] >= lo && k[key] <= hi)) out.push(`${key} must be between ${lo} and ${hi}`);
  if (!(k.low_below < k.optimal_max && k.optimal_max < k.caution_max)) out.push('Workload thresholds must rise: low, then optimal, then caution');
  if (k.high_penalty < k.caution_penalty) out.push('The high-workload penalty cannot be smaller than the caution penalty');
  return out;
}

/** Fill any gaps from the standard settings so older or partial configs still work. */
export const withDefaults = (cfg) => ({
  weights: { ...DEFAULT_CONFIG.weights, ...cfg?.weights },
  bands: { ...DEFAULT_CONFIG.bands, ...cfg?.bands },
  workload: { ...DEFAULT_CONFIG.workload, ...cfg?.workload },
});
const normalise = (cfg) => { const c = withDefaults(cfg); for (const k of Object.keys(c.weights)) c.weights[k] = r3(c.weights[k]); return c; };
export { normalise as normaliseConfig };

/** Each component is 0..1 (1 = best), or null when the athlete has not logged it. */
export function components({ wellness, pain = [] }) {
  const w = wellness ?? {};
  const hs = w.sleep_hours == null ? null : clamp(Number(w.sleep_hours) / 8, 0, 1);
  const sq = w.sleep_quality == null ? null : (w.sleep_quality - 1) / 4;
  const sleep = hs !== null && sq !== null ? 0.7 * hs + 0.3 * sq : hs ?? sq;
  // soreness: what they logged today, otherwise the worst open body-map entry
  const worst = pain.length ? Math.max(...pain.map((p) => p.severity)) : null;
  const sore = w.soreness ?? worst;
  return { sleep, soreness: sore == null ? null : 1 - clamp(sore, 0, 10) / 10, mood: w.mood == null ? null : (w.mood - 1) / 4 };
}

export function band(score, cfg = DEFAULT_CONFIG) { const b = withDefaults(cfg).bands; return score >= b.ready_min ? 'ready' : score >= b.moderate_min ? 'moderate' : 'rest'; }

/**
 * Weights are renormalised over what was logged, so a partial log still gives a score. A rising workload ratio takes points off.
 * Returns { score: null } when nothing relevant was logged.
 */
export function readiness({ wellness, pain = [], acwr = null, config = null }) {
  const cfg = withDefaults(config), WEIGHTS = cfg.weights;
  const comp = components({ wellness, pain });
  const present = Object.entries(comp).filter(([, v]) => v !== null);
  const factors = Object.keys(WEIGHTS).map((k) => ({ key: k, value: comp[k] === null ? null : Math.round(comp[k] * 100) }));
  if (!present.length) return { score: null, band: null, factors, penalty: 0, base: null };
  const total = present.reduce((a, [k]) => a + WEIGHTS[k], 0);
  const base = present.reduce((a, [k, v]) => a + (WEIGHTS[k] / total) * v, 0) * 100;
  const ratio = acwr?.ratio ?? null;
  const penalty = ratio === null ? 0 : ratio > cfg.workload.caution_max ? cfg.workload.high_penalty : ratio > cfg.workload.optimal_max ? cfg.workload.caution_penalty : 0;
  const score = Math.round(clamp(base - penalty, 0, 100));
  return { score, band: band(score, cfg), factors, penalty, base: Math.round(base) };
}

const dayMs = 86400000;
const toDay = (d) => Date.parse(`${(d instanceof Date ? d.toISOString() : String(d)).slice(0, 10)}T00:00:00Z`);
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * ACWR: acute = total load over the last 7 days; chronic = average weekly load over the last 28 days. The ratio is only trusted once the
 * athlete has logged for 3+ weeks; before that it is "building". Bands: <0.8 low, 0.8-1.3 optimal, 1.3-1.5 caution, >1.5 high.
 * `loads` is [{ session_date, load }]. Also returns eight weekly totals ending on `date` for charting.
 */
export function workload(loads, date, config = null) {
  const k = withDefaults(config).workload;
  const end = toDay(date);
  const sum = (fromMs, toMs) => loads.reduce((a, l) => { const t = toDay(l.session_date); return t >= fromMs && t <= toMs ? a + Number(l.load) : a; }, 0);
  const acute = sum(end - 6 * dayMs, end);
  const chronic = sum(end - 27 * dayMs, end) / 4;
  const first = loads.length ? Math.min(...loads.map((l) => toDay(l.session_date))) : null;
  const enough = first !== null && end - first >= k.min_span_days * dayMs;
  const ratio = enough && chronic > 0 ? Math.round((acute / chronic) * 100) / 100 : null;
  const status = !loads.length ? 'no_data' : !enough ? 'building' : ratio === null ? 'no_data' : ratio < k.low_below ? 'low' : ratio <= k.optimal_max ? 'optimal' : ratio <= k.caution_max ? 'caution' : 'high';
  const weeks = Array.from({ length: 8 }, (_, i) => { const to = end - (7 - i) * 7 * dayMs; const from = to - 6 * dayMs; return { week_ending: iso(to), load: sum(from, to) }; });
  return { date: iso(end), acute, chronic: Math.round(chronic), ratio, status, weeks, sessions: loads.filter((l) => { const t = toDay(l.session_date); return t >= end - 27 * dayMs && t <= end; }).length, first_session_on: first === null ? null : iso(first), span_days: first === null ? 0 : Math.max(0, Math.round((end - first) / dayMs)) };
}

const LABEL = { sleep: 'Sleep', soreness: 'Soreness', mood: 'Mood' };
const FIX = { sleep: 'Log last night\'s sleep hours (and quality) in the quick log.', soreness: 'Log how sore you feel today, or add a body-map entry.', mood: 'Log your mood in the quick log.' };
const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Everything needed to understand one day's score: each input, where it came from, its weight and the points it adds, what is missing,
 * how much of the formula the logs cover, the workload basis, and the limits. Pure; `shown` (a Set of 'sleep'|'soreness'|'mood'|'workload')
 * hides raw values a staff member was not given, while still reporting that the input counted.
 * `daysLogged` = { d7, d28 } wellness logs in the last 7 / 28 days.
 */
export function explain({ date, wellness, pain = [], loads = [], config = null, daysLogged = { d7: 0, d28: 0 }, shown = null }) {
  const cfg = withDefaults(config);
  const wl = workload(loads, date, cfg);
  const r = readiness({ wellness, pain, acwr: wl, config: cfg });
  const comp = components({ wellness, pain });
  const present = Object.keys(cfg.weights).filter((k) => comp[k] !== null);
  const total = present.reduce((a, k) => a + cfg.weights[k], 0);
  const see = (k) => !shown || shown.has(k);
  const worst = pain.length ? Math.max(...pain.map((p) => p.severity)) : null;
  const raw = (k) => {
    if (comp[k] === null || !see(k)) return null;
    if (k === 'sleep') return { sleep_hours: wellness?.sleep_hours == null ? null : Number(wellness.sleep_hours), sleep_quality: wellness?.sleep_quality ?? null };
    if (k === 'soreness') return wellness?.soreness != null ? { soreness: wellness.soreness } : { worst_open_body_map_severity: worst };
    return { mood: wellness?.mood };
  };
  const inputs = Object.keys(cfg.weights).map((k) => {
    const logged = comp[k] !== null;
    const eff = logged ? cfg.weights[k] / total : 0;
    return {
      key: k, label: LABEL[k], weight: cfg.weights[k], logged,
      source: !logged ? 'missing' : k === 'soreness' && wellness?.soreness == null ? 'body_map' : 'daily_log',
      effective_weight: r3(eff), value_pct: logged && see(k) ? Math.round(comp[k] * 100) : null,
      points: logged && see(k) ? round1(eff * comp[k] * 100) : null, raw: raw(k), shown: logged ? see(k) : true,
    };
  });
  const weightCovered = r3(total);
  const level = !present.length ? 'none' : present.length === 3 ? 'full' : 'partial';
  const confidence = !present.length ? 'none' : weightCovered >= 0.99 && daysLogged.d7 >= 4 ? 'good' : weightCovered >= 0.6 && daysLogged.d7 >= 2 ? 'moderate' : 'low';
  const trusted = wl.ratio !== null;
  return {
    date, formula: { ...FORMULA, validated_for_injury_prediction: false, medical_clearance: false },
    score: r.score, band: r.band, base_score: r.base, workload_adjustment: see('workload') ? -r.penalty : null,
    inputs,
    coverage: { level, inputs_logged: present.length, inputs_total: 3, weight_covered: weightCovered, days_logged_7: daysLogged.d7, days_logged_28: daysLogged.d28 },
    missing: inputs.filter((i) => !i.logged).map((i) => ({ key: i.key, label: i.label, how_to_fix: FIX[i.key] })),
    confidence,
    workload: see('workload') ? {
      status: wl.status, ratio: wl.ratio, acute: wl.acute, chronic: wl.chronic, sessions_28d: wl.sessions, first_session_on: wl.first_session_on,
      span_days: wl.span_days, days_needed: cfg.workload.min_span_days, trusted,
      counts_toward_score: trusted && r.penalty > 0, adjustment_points: -r.penalty,
      reason: wl.status === 'no_data' ? 'No sessions logged in the last 90 days, so no workload adjustment is made.' : trusted ? null : `Needs ${cfg.workload.min_span_days} days of logged sessions before the ratio is trusted (${wl.span_days} so far), so no adjustment is made.`,
    } : { hidden: true },
    thresholds: { bands: cfg.bands, workload: { low_below: cfg.workload.low_below, optimal_max: cfg.workload.optimal_max, caution_max: cfg.workload.caution_max, caution_penalty: cfg.workload.caution_penalty, high_penalty: cfg.workload.high_penalty } },
    fixed_rules: FIXED, limitations: LIMITATIONS,
  };
}

/** Per-day scores for `from..to`, from the same logs and settings. Body-map entries count on the days they were open. */
export function history({ from, to, wellnessRows, painRows, loads, config = null }) {
  const byDate = new Map(wellnessRows.map((w) => [String(w.log_date).slice(0, 10), w]));
  const out = [];
  for (let t = toDay(from); t <= toDay(to); t += dayMs) {
    const d = iso(t);
    const wellness = byDate.get(d) ?? null;
    // the reading in force on day d for each region / side / kind, if it was still open
    const latest = new Map();
    for (const p of painRows) {
      if (toDay(p.created_at) > t + dayMs - 1) continue;
      const key = `${p.region}|${p.side}|${p.kind}`;
      if (!latest.has(key) || new Date(p.created_at) > new Date(latest.get(key).created_at)) latest.set(key, p);
    }
    const pain = [...latest.values()].filter((p) => !p.resolved_at || toDay(p.resolved_at) > t + dayMs - 1);
    const visibleLoads = loads.filter((l) => toDay(l.session_date) <= t);
    const wl = workload(visibleLoads, d, config);
    const r = readiness({ wellness, pain, acwr: wl, config });
    const present = r.factors.filter((f) => f.value !== null).length;
    out.push({ date: d, score: r.score, band: r.band, inputs_logged: present, logged: !!wellness, workload_status: wl.status });
  }
  return out;
}
