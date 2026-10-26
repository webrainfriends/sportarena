// Deterministic evaluation maths (pure functions, no I/O). The same functions produce the live ranking, the sensitivity analysis and the
// committed snapshot, so a re-run on the same locked scores always reproduces the same numbers. Formulae: docs/tender-zone.md.
import { z } from 'zod';

const TWO = 100; // results are rounded half-up to 2 decimals
export const round2 = (n) => Math.round((n + Number.EPSILON) * TWO) / TWO;

export const rubricSchema = z.object({
  weights: z.object({ technical: z.number().min(0).max(100), commercial: z.number().min(0).max(100) }),
  technical_pass_mark: z.number().min(0).max(100).default(0),
  min_reviewers: z.number().int().min(1).max(20).default(1),
  commercial_method: z.enum(['lowest_ratio']).default('lowest_ratio'),
  na_policy: z.enum(['exclude_and_reweight']).default('exclude_and_reweight'),
  tie_break: z.array(z.enum(['commercial_score', 'technical_score', 'earlier_submission'])).max(3).default(['commercial_score', 'technical_score', 'earlier_submission']),
  criteria: z.array(z.object({
    key: z.string().regex(/^[a-z0-9_]{2,40}$/), title: z.string().min(2).max(120), weight: z.number().gt(0).max(100),
    scale_min: z.number().default(0), scale_max: z.number().default(10), evidence_required: z.boolean().default(false),
    min_normalised: z.number().min(0).max(100).optional().describe('mandatory threshold on the 0-100 normalised score; below it the bid fails this criterion'),
    lot_code: z.string().max(30).optional(), blind_allowed: z.boolean().default(true),
  })).max(60).default([]),
});

/** Problems that must be fixed before a rubric can be frozen. */
export function rubricIssues(r) {
  const out = [];
  if (Math.abs(r.weights.technical + r.weights.commercial - 100) > 1e-9) out.push('Technical and commercial weights must add up to 100');
  const tw = r.criteria.reduce((a, c) => a + c.weight, 0);
  if (r.weights.technical > 0 && Math.abs(tw - 100) > 1e-9) out.push(`Technical criteria weights add up to ${tw}, not 100`);
  if (r.weights.technical > 0 && !r.criteria.length) out.push('Add at least one technical criterion');
  if (new Set(r.criteria.map((c) => c.key)).size !== r.criteria.length) out.push('Criterion keys must be unique');
  for (const c of r.criteria) if (!(c.scale_max > c.scale_min)) out.push(`Criterion "${c.title}" needs a scale where the maximum is above the minimum`);
  return out;
}

/** score on its own scale -> 0..100 */
export const normalise = (score, c) => ((score - c.scale_min) / (c.scale_max - c.scale_min)) * 100;

/**
 * Technical score of one bid.
 * scores: { [criterion_key]: [{ reviewer_id, score|null (N/A), weight }] } holding only LOCKED reviewer scores;
 * consensus: { [criterion_key]: score } overrides the reviewers' mean when the chair recorded one.
 * N/A criteria are dropped and the remaining weights are rescaled (na_policy). A criterion with fewer than min_reviewers inputs and no
 * consensus is "missing" and blocks the final ranking; it is never turned into a zero.
 */
export function technicalScore(rubric, scores = {}, consensus = {}) {
  let num = 0, den = 0; const missing = [], failed = [], byCriterion = {};
  for (const c of rubric.criteria) {
    const inputs = scores[c.key] ?? [];
    let raw;
    if (consensus[c.key] !== undefined && consensus[c.key] !== null) raw = consensus[c.key];
    else {
      const live = inputs.filter((x) => x.score !== null && x.score !== undefined);
      const na = inputs.filter((x) => x.score === null || x.score === undefined);
      if (inputs.length >= rubric.min_reviewers && na.length === inputs.length) { byCriterion[c.key] = { na: true }; continue; }
      if (inputs.length < rubric.min_reviewers) { missing.push(c.key); continue; }
      const wsum = live.reduce((a, x) => a + (x.weight ?? 1), 0);
      raw = live.reduce((a, x) => a + x.score * (x.weight ?? 1), 0) / wsum;
    }
    const n = normalise(raw, c);
    byCriterion[c.key] = { raw: round2(raw), normalised: round2(n) };
    if (c.min_normalised !== undefined && n < c.min_normalised) failed.push(c.key);
    num += c.weight * n; den += c.weight;
  }
  return { score: den ? round2(num / den) : null, missing, failed, by_criterion: byCriterion, complete: !missing.length && den > 0 };
}

/** Commercial score: the lowest comparable evaluated cost scores 100, others 100 x lowest / own cost. Unknown costs are not scored. */
export function commercialScores(costs) {
  const known = Object.entries(costs).filter(([, v]) => Number.isInteger(v) && v > 0);
  if (!known.length) return {};
  const lowest = Math.min(...known.map(([, v]) => v));
  return Object.fromEntries(known.map(([k, v]) => [k, round2((100 * lowest) / v)]));
}

/**
 * Rank bids. entries: [{ id, eligibility: 'eligible'|'ineligible'|'pending'|'withdrawn', technical: technicalScore(...)|null, cost_minor|null, submitted_at }]
 * Only eligible bids that pass the technical mark and every mandatory threshold are ranked. Anything missing blocks `final`.
 */
export function rank(rubric, entries) {
  const eligible = entries.filter((e) => e.eligibility === 'eligible');
  // The lowest-cost baseline is taken among bids that can still rank: eligible, technically complete, at or above the pass mark and with
  // no mandatory threshold failed. A bid that cannot rank never pulls the commercial scores of the others down.
  const technicallyOk = (e) => rubric.weights.technical <= 0 || (e.technical?.complete && !e.technical.failed?.length && e.technical.score >= rubric.technical_pass_mark);
  const comm = commercialScores(Object.fromEntries(eligible.filter(technicallyOk).map((e) => [e.id, e.cost_minor])));
  const blockers = [];
  const rows = entries.map((e) => {
    const reasons = [];
    const t = e.technical;
    if (e.eligibility !== 'eligible') reasons.push(e.eligibility);
    if (e.eligibility === 'eligible') {
      if (rubric.weights.technical > 0 && (!t || !t.complete)) { reasons.push('scores incomplete'); blockers.push(`${e.id}: technical scores incomplete`); }
      if (t?.failed?.length) reasons.push(`below threshold: ${t.failed.join(', ')}`);
      if (t?.complete && t.score < rubric.technical_pass_mark) reasons.push('below technical pass mark');
      if (rubric.weights.commercial > 0 && comm[e.id] === undefined) { reasons.push('evaluated cost unknown'); blockers.push(`${e.id}: evaluated cost unknown`); }
    }
    const technical = t?.score ?? null, commercial = comm[e.id] ?? null;
    const total = !reasons.length ? round2((rubric.weights.technical * (technical ?? 0) + rubric.weights.commercial * (commercial ?? 0)) / 100) : null;
    return { id: e.id, eligibility: e.eligibility, technical, commercial, total, cost_minor: e.cost_minor ?? null, submitted_at: e.submitted_at, exceptions: reasons, completeness: t ? (t.complete ? 100 : round2(100 * (rubric.criteria.length - t.missing.length) / Math.max(1, rubric.criteria.length))) : 0 };
  });
  const ranked = rows.filter((r) => r.total !== null);
  const cmp = (a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    for (const k of rubric.tie_break) {
      if (k === 'commercial_score' && b.commercial !== a.commercial) return (b.commercial ?? 0) - (a.commercial ?? 0);
      if (k === 'technical_score' && b.technical !== a.technical) return (b.technical ?? 0) - (a.technical ?? 0);
      if (k === 'earlier_submission' && a.submitted_at !== b.submitted_at) return new Date(a.submitted_at) - new Date(b.submitted_at);
    }
    return 0;
  };
  ranked.sort(cmp);
  ranked.forEach((r, i) => { r.rank = i && cmp(ranked[i - 1], r) === 0 ? ranked[i - 1].rank : i + 1; });
  for (const r of ranked) r.tied = ranked.filter((o) => o.rank === r.rank).length > 1;
  const out = [...ranked, ...rows.filter((r) => r.total === null).map((r) => ({ ...r, rank: null, tied: false }))];
  return { rows: out, final: !blockers.length && ranked.length > 0, blockers, formula_version: 1 };
}

/** What would change in the ranking if allowed weights moved? Never persisted; the official award uses the frozen rubric. */
export function sensitivity(rubric, entries, alternatives) {
  const base = rank(rubric, entries);
  return alternatives.map((w) => {
    const r = rank({ ...rubric, weights: w }, entries);
    return { weights: w, order: r.rows.filter((x) => x.rank).map((x) => x.id), changed: JSON.stringify(r.rows.filter((x) => x.rank).map((x) => x.id)) !== JSON.stringify(base.rows.filter((x) => x.rank).map((x) => x.id)) };
  });
}
