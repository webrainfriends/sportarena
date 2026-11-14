// Athletics / swimming / cycling / rowing / triathlon performance analytics adapter (issue #506).
// PB/SB, progression, split/attempt trends, event/discipline comparisons.
// Direction semantics are ALWAYS read from the stored metric_definition (never hard-coded here).
// Multi-event athletes see each event/discipline separately.

export const CALC_VERSION = 'athletics_v1';
const MIN_ATTEMPTS = 3;

const round2 = (n) => Math.round(n * 100) / 100;

function direction(storedDir, metricKey) {
  if (storedDir === 'lower' || storedDir === 'higher') return storedDir;
  const lower = /\b(time|sec|second|min|minute|hour|pace|split)\b/i.test(metricKey);
  return lower ? 'lower' : 'higher';
}

function isBetter(a, b, dir) {
  return dir === 'lower' ? a < b : a > b;
}

function pbIndex(values, dir) {
  // Returns index of PB in the array
  let best = null, bestIdx = -1;
  for (let i = 0; i < values.length; i++) {
    if (best === null || isBetter(values[i], best, dir)) { best = values[i]; bestIdx = i; }
  }
  return bestIdx;
}

function progression(points, dir) {
  if (points.length < 2) return null;
  const first = points[0].value, last = points[points.length - 1].value;
  const delta = last - first;
  const improving = isBetter(last, first, dir);
  return { from: first, to: last, delta: round2(delta), improving, over_attempts: points.length };
}

function variance(values) {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const std = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1));
  return { mean: round2(mean), std_dev: round2(std), cv_pct: mean ? round2((std / mean) * 100) : null };
}

export async function compute(db, userId, { sportId, evidence = 'approved_competition', from = null, to = null }) {
  const limitations = [];

  // Load metric definitions for this sport (direction, unit, aggregation from governance)
  const defs = await db.query(
    `SELECT md.metric_key, mdv.direction, mdv.unit, mdv.aggregation, mdv.range_min, mdv.range_max
       FROM metric_definitions md
       JOIN metric_definition_versions mdv ON mdv.metric_definition_id = md.id AND mdv.id = md.current_version_id
      WHERE md.sport_id = $1 AND md.archived_at IS NULL`,
    [sportId]);
  const defMap = new Map(defs.rows.map((d) => [d.metric_key, d]));

  const VALID_OFFICIAL = `(p.provenance='approved_competition' AND p.status='approved')`;
  const VALID_SELF = `(p.provenance IN ('self_reported','imported') AND p.status='recorded')`;
  const VALID = evidence === 'approved_competition' ? VALID_OFFICIAL : evidence === 'self_reported' ? VALID_SELF : `(${VALID_OFFICIAL} OR ${VALID_SELF})`;

  const rows = await db.query(
    `SELECT p.metric, p.provenance, p.unit, coalesce(p.direction,'higher') AS stored_direction,
            p.value::float8 AS value, to_char(coalesce(p.achieved_on, p.recorded_at::date),'YYYY-MM-DD') AS on_date,
            p.id
       FROM performances p
       JOIN sports s ON s.id = p.sport_id
      WHERE p.user_id=$1 AND p.sport_id=$2 AND ${VALID}
        AND ($3::date IS NULL OR coalesce(p.achieved_on, p.recorded_at::date) >= $3)
        AND ($4::date IS NULL OR coalesce(p.achieved_on, p.recorded_at::date) <= $4)
      ORDER BY p.metric, coalesce(p.achieved_on, p.recorded_at::date), p.recorded_at`,
    [userId, sportId, from, to]);

  // Group by metric, then by evidence
  const byMetric = new Map();
  for (const r of rows.rows) {
    if (!byMetric.has(r.metric)) byMetric.set(r.metric, []);
    byMetric.get(r.metric).push(r);
  }

  const events = [];
  for (const [metric, points] of byMetric) {
    const def = defMap.get(metric);
    const dir = direction(points[0].stored_direction ?? def?.direction, metric);
    const unit = def?.unit ?? points[0].unit ?? null;

    // Split by evidence track
    const official = points.filter((p) => p.provenance === 'approved_competition');
    const self = points.filter((p) => p.provenance !== 'approved_competition');

    function buildEventAnalytics(pts, evid) {
      if (!pts.length) return null;
      if (pts.length < MIN_ATTEMPTS) return { insufficient: true, min_required: MIN_ATTEMPTS, attempts: pts.length, evidence: evid };
      const values = pts.map((p) => p.value);
      const pbIdx = pbIndex(values, dir);
      const sbIdx = pbIndex(values.slice(values.length - 10), dir) + Math.max(0, values.length - 10);
      const pointsAnnotated = pts.map((p, i) => ({
        on: p.on_date, value: p.value, evidence: p.provenance,
        is_pb: i === pbIdx, is_sb: i === sbIdx,
      }));
      return {
        evidence: evid, attempts: pts.length,
        personal_best: { value: values[pbIdx], on: pts[pbIdx].on_date, direction: dir },
        season_best: values.length > 1 ? { value: values[sbIdx], on: pts[sbIdx].on_date, direction: dir } : null,
        progression: progression(pts, dir),
        variance: variance(values),
        points: pointsAnnotated,
        insufficient: false,
      };
    }

    const tracks = {};
    if (evidence === 'approved_competition' || evidence === 'combined') {
      const t = buildEventAnalytics(official, 'approved_competition');
      if (t) tracks.approved_competition = t;
    }
    if (evidence === 'self_reported' || evidence === 'combined') {
      const t = buildEventAnalytics(self, 'self_reported');
      if (t) tracks.self_reported = t;
    }

    if (!Object.keys(tracks).length) continue;

    events.push({
      metric,
      metric_label: metric.replace(/_/g, ' '),
      unit,
      direction: dir,
      definition: def ? undefined : `Metric '${metric}' — direction: ${dir}`,
      governed: !!def,
      governed_definition: def ? { direction: def.direction, unit: def.unit, aggregation: def.aggregation } : null,
      tracks,
    });
  }

  if (!events.length) limitations.push('No performance data found for this sport in the selected period and evidence track');

  return {
    sport: 'athletics',
    calc_version: CALC_VERSION,
    period: { from, to },
    events,
    limitations,
  };
}
