// The numbers of an evaluation, computed in one place so the coach's screen, the athlete's screen, the frozen versions and the PDF always agree.
// A score is the coach's own judgement on the sheet's own scale; everything derived from it (a pillar average, the overall, a change, a gap to the
// athlete's self-assessment) is labelled as computed and follows only the weights and direction the coach set on the sheet.
import { createHash } from 'node:crypto';

const r1 = (x) => Math.round(x * 10) / 10;

/** 0 to 100 position of a score on its scale; lower-is-better scales are turned round. Target-range criteria are shown but never averaged. */
export function normalise(dim, v) {
  if (v == null || !Number.isFinite(Number(v))) return null;
  const span = dim.scale_max - dim.scale_min;
  if (!(span > 0) || dim.direction === 'target_range') return null;
  const p = ((Number(v) - dim.scale_min) / span) * 100;
  return dim.direction === 'lower_is_better' ? 100 - p : p;
}

/** Overall and per-pillar scores (0 to 100, weighted) for a set of scores; only scored, weighted criteria count. */
export function summarise(dims, scores) {
  const pillars = {};
  let sum = 0, wsum = 0, scored = 0;
  for (const d of dims) {
    const entry = scores?.[d.key];
    if (entry?.score != null) scored++;
    const n = normalise(d, entry?.score);
    const w = d.weight ?? 1;
    if (n == null || !(w > 0)) continue;
    sum += n * w; wsum += w;
    const p = (pillars[d.pillar ?? 'other'] ??= { sum: 0, wsum: 0, count: 0 });
    p.sum += n * w; p.wsum += w; p.count++;
  }
  return {
    overall: wsum ? r1(sum / wsum) : null,
    pillars: Object.fromEntries(Object.entries(pillars).map(([k, p]) => [k, { score: r1(p.sum / p.wsum), criteria: p.count }])),
    coverage: { scored, total: dims.length },
  };
}

/** The evaluation as one object for a viewer: criteria with their sheet detail, scores, self-assessment, gaps and the change since the previous one. */
export function view(ev, dims, { previous = null, includePrivate = false, includeSelf = true } = {}) {
  const now = summarise(dims, ev.scores);
  const before = previous ? summarise(dims, previous.scores) : null;
  const selfSum = includeSelf && Object.keys(ev.self_scores ?? {}).length ? summarise(dims, ev.self_scores) : null;
  const criteria = dims.map((d) => {
    const c = ev.scores?.[d.key] ?? {}, s = includeSelf ? ev.self_scores?.[d.key] : null, p = previous?.scores?.[d.key];
    return {
      key: d.key, name: d.name, description: d.description ?? null, pillar: d.pillar ?? 'other', pillar_label: d.pillar_label ?? null, input: d.input ?? null, step: d.step ?? null, weight: d.weight ?? 1, scale_min: d.scale_min, scale_max: d.scale_max,
      direction: d.direction ?? 'higher_is_better', unit: d.unit ?? null, labels: d.labels ?? {}, anchors: d.anchors ?? {}, target: d.target ?? null, evidence_hint: d.evidence_hint ?? null,
      score: c.score ?? null, comment: c.comment ?? null, evidence: c.evidence ?? [],
      previous: p?.score ?? null, change: c.score != null && p?.score != null ? r1(c.score - p.score) : null,
      to_target: c.score != null && d.target != null ? r1(d.target - c.score) : null,
      self: s?.score ?? null, self_comment: s?.comment ?? null, gap: c.score != null && s?.score != null ? r1(s.score - c.score) : null,
      reaction: ev.response?.reactions?.[d.key] ?? null,
    };
  });
  const narrative = { ...(ev.narrative ?? {}) };
  if (!includePrivate) delete narrative.private;
  return {
    id: ev.id, title: ev.title, status: ev.status, context_type: ev.context_type, class_id: ev.class_id ?? null, period_from: ev.period_from, period_to: ev.period_to,
    rubric: { id: ev.rubric_id, version: ev.rubric_version }, athlete_id: ev.athlete_id, coach_id: ev.coach_id, version: ev.latest_version,
    summary: { overall: now.overall, pillars: now.pillars, coverage: now.coverage, previous_overall: before?.overall ?? null, change: now.overall != null && before?.overall != null ? r1(now.overall - before.overall) : null,
      pillar_change: Object.fromEntries(Object.entries(now.pillars).filter(([k]) => before?.pillars?.[k]).map(([k, p]) => [k, r1(p.score - before.pillars[k].score)])), self_overall: selfSum?.overall ?? null, self_pillars: selfSum?.pillars ?? null,
      computed_note: 'Computed from your weights on the sheet; the scores are the coach\'s own judgement.' },
    pillar_labels: Object.fromEntries(dims.filter((d) => d.pillar_label).map((d) => [d.pillar, d.pillar_label])),
    criteria, narrative, self_requested: !!ev.self_requested, self_submitted_at: ev.self_submitted_at, response: includeSelf ? { reactions: ev.response?.reactions ?? {}, comment: ev.response?.comment ?? null, questions: ev.response?.questions ?? null } : null,
    shared_at: ev.shared_at, responded_at: ev.responded_at, acknowledged_at: ev.acknowledged_at, closed_at: ev.closed_at, row_version: ev.row_version, updated_at: ev.updated_at,
  };
}

export const hashSnapshot = (obj) => createHash('sha256').update(JSON.stringify(obj)).digest('hex');
