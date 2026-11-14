// Generic performance analytics adapter (issue #506).
// Fallback for every sport not covered by a dedicated adapter.
// Uses governed metric definitions from metric_definitions + performances table.
// Direction, unit, aggregation are always read from the governance layer, never assumed.

import { percentileDirected, loadSelf, loadOfficial, round, MIN_COHORT } from '../benchmarks.js';

export const CALC_VERSION = 'generic_v1';
const MIN_RESULTS = 3;

const VALID_OFFICIAL = `(p.provenance='approved_competition' AND p.status='approved')`;
const VALID_SELF = `(p.provenance IN ('self_reported','imported') AND p.status='recorded')`;

export async function compute(db, userId, { sportId, evidence = 'approved_competition', from = null, to = null }) {
  const limitations = [];

  // Load governed metric definitions for this sport
  const defs = await db.query(
    `SELECT md.metric_key, md.name AS metric_name, mdv.direction, mdv.unit, mdv.aggregation, mdv.version
       FROM metric_definitions md
       JOIN metric_definition_versions mdv ON mdv.metric_definition_id = md.id AND mdv.id = md.current_version_id
      WHERE md.sport_id = $1 AND md.archived_at IS NULL
      ORDER BY md.metric_key`,
    [sportId]);
  const defMap = new Map(defs.rows.map((d) => [d.metric_key, d]));
  if (!defMap.size) limitations.push('No governed metric definitions found for this sport — analytics are based on self-reported metric names and inferred direction');

  const VALID = evidence === 'approved_competition' ? VALID_OFFICIAL : evidence === 'self_reported' ? VALID_SELF : `(${VALID_OFFICIAL} OR ${VALID_SELF})`;

  // Per-metric aggregation
  const rows = await db.query(
    `SELECT p.metric, p.provenance, coalesce(p.direction,'higher') AS direction, p.unit,
            p.value::float8 AS value, to_char(coalesce(p.achieved_on, p.recorded_at::date),'YYYY-MM-DD') AS on_date
       FROM performances p
      WHERE p.user_id=$1 AND p.sport_id=$2 AND ${VALID}
        AND ($3::date IS NULL OR coalesce(p.achieved_on, p.recorded_at::date) >= $3)
        AND ($4::date IS NULL OR coalesce(p.achieved_on, p.recorded_at::date) <= $4)
      ORDER BY p.metric, coalesce(p.achieved_on, p.recorded_at::date), p.recorded_at`,
    [userId, sportId, from, to]);

  // Group by metric + evidence
  const byMetric = new Map();
  for (const r of rows.rows) {
    const key = `${r.metric}:${r.provenance}`;
    if (!byMetric.has(key)) byMetric.set(key, { metric: r.metric, provenance: r.provenance, direction: r.direction, unit: r.unit, values: [] });
    byMetric.get(key).values.push({ value: r.value, on: r.on_date });
  }

  const metrics = [];
  for (const [, m] of byMetric) {
    if (m.values.length < MIN_RESULTS) {
      metrics.push({ metric: m.metric, evidence: m.provenance, insufficient: true, results: m.values.length, min_required: MIN_RESULTS });
      continue;
    }
    const def = defMap.get(m.metric);
    const dir = def?.direction ?? m.direction;
    const best = m.values.reduce((b, v) => (dir === 'lower' ? v.value < b.value : v.value > b.value) ? v : b);
    const vals = m.values.map((v) => v.value);
    const total = vals.reduce((a, b) => a + b, 0);
    const mean = round(total / vals.length, 2);
    metrics.push({
      metric: m.metric,
      metric_label: def?.metric_name ?? m.metric.replace(/_/g, ' '),
      evidence: m.provenance,
      governed: !!def,
      direction: dir,
      unit: def?.unit ?? m.unit,
      aggregation: def?.aggregation ?? 'sum',
      definition: def ? `Governed definition v${def.version}` : `Self-reported metric — direction inferred from key name`,
      sample_size: m.values.length,
      sample_unit: 'results',
      personal_best: { value: best.value, on: best.on },
      total,
      mean,
      calc_version: def?.version ?? CALC_VERSION,
      insufficient: false,
    });
  }

  if (!metrics.length) limitations.push('No performance data found for this sport in the selected period');

  return {
    sport: 'generic',
    calc_version: CALC_VERSION,
    period: { from, to },
    metrics,
    limitations,
    governed_definitions: defs.rows.length,
    governance_note: defs.rows.length ? `${defs.rows.length} governed metric definition${defs.rows.length === 1 ? '' : 's'} available for this sport` : 'No governed definitions — analytics rely on stored metric names',
  };
}
