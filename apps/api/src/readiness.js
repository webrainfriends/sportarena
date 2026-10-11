// Pure maths for the athlete's readiness score and acute:chronic workload ratio (ACWR). No database access.
// Readiness is a simple, explainable 0-100 score from what the athlete logged; it is guidance, never a diagnosis.

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const WEIGHTS = { sleep: 0.4, soreness: 0.35, mood: 0.25 };

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

export function band(score) { return score >= 70 ? 'ready' : score >= 40 ? 'moderate' : 'rest'; }

/**
 * Weights are renormalised over what was logged, so a partial log still gives a score. A rising workload ratio takes points off.
 * Returns { score: null } when nothing relevant was logged.
 */
export function readiness({ wellness, pain = [], acwr = null }) {
  const comp = components({ wellness, pain });
  const present = Object.entries(comp).filter(([, v]) => v !== null);
  const factors = Object.keys(WEIGHTS).map((k) => ({ key: k, value: comp[k] === null ? null : Math.round(comp[k] * 100) }));
  if (!present.length) return { score: null, band: null, factors, penalty: 0 };
  const total = present.reduce((a, [k]) => a + WEIGHTS[k], 0);
  const base = present.reduce((a, [k, v]) => a + (WEIGHTS[k] / total) * v, 0) * 100;
  const ratio = acwr?.ratio ?? null;
  const penalty = ratio === null ? 0 : ratio > 1.5 ? 10 : ratio > 1.3 ? 5 : 0;
  const score = Math.round(clamp(base - penalty, 0, 100));
  return { score, band: band(score), factors, penalty };
}

const dayMs = 86400000;
const toDay = (d) => Date.parse(`${(d instanceof Date ? d.toISOString() : String(d)).slice(0, 10)}T00:00:00Z`);
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * ACWR: acute = total load over the last 7 days; chronic = average weekly load over the last 28 days. The ratio is only trusted once the
 * athlete has logged for 3+ weeks; before that it is "building". Bands: <0.8 low, 0.8-1.3 optimal, 1.3-1.5 caution, >1.5 high.
 * `loads` is [{ session_date, load }]. Also returns eight weekly totals ending on `date` for charting.
 */
export function workload(loads, date) {
  const end = toDay(date);
  const sum = (fromMs, toMs) => loads.reduce((a, l) => { const t = toDay(l.session_date); return t >= fromMs && t <= toMs ? a + Number(l.load) : a; }, 0);
  const acute = sum(end - 6 * dayMs, end);
  const chronic = sum(end - 27 * dayMs, end) / 4;
  const first = loads.length ? Math.min(...loads.map((l) => toDay(l.session_date))) : null;
  const enough = first !== null && end - first >= 20 * dayMs;
  const ratio = enough && chronic > 0 ? Math.round((acute / chronic) * 100) / 100 : null;
  const status = !loads.length ? 'no_data' : !enough ? 'building' : ratio === null ? 'no_data' : ratio < 0.8 ? 'low' : ratio <= 1.3 ? 'optimal' : ratio <= 1.5 ? 'caution' : 'high';
  const weeks = Array.from({ length: 8 }, (_, i) => { const to = end - (7 - i) * 7 * dayMs; const from = to - 6 * dayMs; return { week_ending: iso(to), load: sum(from, to) }; });
  return { date: iso(end), acute, chronic: Math.round(chronic), ratio, status, weeks };
}
