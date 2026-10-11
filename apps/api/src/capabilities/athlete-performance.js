import { z } from 'zod';
import { cap } from '../registry.js';
import { many } from '../db.js';
import { badRequest } from '../errors.js';
import { EVIDENCE_LABELS } from '../scoring/performance-rules.js';

const TAG = 'Performance';
const RECENT_DAYS = 30;
const day = z.string().date();

// Derived read models over the athlete's own `performances` (nothing is stored here). Approved competition results and the athlete's own
// practice/imported figures are kept apart: a personal best is only ever compared with results of the same evidence, so practice can
// never masquerade as an official record. Direction comes from the stored rule (lower wins for times).
const VALID = `((p.provenance='approved_competition' AND p.status='approved') OR (p.provenance IN ('self_reported','imported') AND p.status='recorded'))`;
const ORDER = (dir, col) => `CASE WHEN ${dir}='lower' THEN ${col} ELSE -${col} END`;

cap({
  name: 'list_personal_records', method: 'GET', path: '/me/records', tag: TAG,
  summary: 'Your personal records: the best result per sport, metric and kind of evidence (approved competition, self-reported practice, imported), in the metric\'s direction (lowest time, highest distance). Each carries the date, the previous best, how much it improved and whether it is new (last 30 days). Records of different evidence are never mixed.',
  input: z.object({ sport: z.string().max(60).optional().describe('sport slug') }),
  async handler({ user }, i) {
    const rows = await many(
      `WITH p AS (
         SELECT p.id, s.slug AS sport, s.name AS sport_name, s.emoji, p.metric, p.provenance, p.unit, coalesce(p.direction,'higher') AS direction, p.value::float8 AS value,
                coalesce(p.achieved_on, p.recorded_at::date) AS on_date, p.recorded_at
           FROM performances p JOIN sports s ON s.id=p.sport_id
          WHERE p.user_id=$1 AND ($2::text IS NULL OR s.slug=$2) AND ${VALID}
       ), ranked AS (
         SELECT p.*, row_number() OVER (PARTITION BY sport, metric, provenance ORDER BY ${ORDER('direction', 'value')}, on_date, recorded_at) AS rn,
                count(*) OVER (PARTITION BY sport, metric, provenance)::int AS entries
           FROM p
       )
       SELECT r.sport, r.sport_name, r.emoji, r.metric, r.provenance, r.unit, r.direction, r.value, to_char(r.on_date,'YYYY-MM-DD') AS achieved_on, r.entries, prev.value AS previous_best,
              (r.on_date >= current_date - ${RECENT_DAYS}) AS recent
         FROM ranked r
         LEFT JOIN LATERAL (SELECT p2.value FROM p p2 WHERE p2.sport=r.sport AND p2.metric=r.metric AND p2.provenance=r.provenance AND p2.on_date < r.on_date
                             ORDER BY ${ORDER('r.direction', 'p2.value')} LIMIT 1) prev ON true
        WHERE r.rn=1 ORDER BY r.sport, r.metric, r.provenance`,
      [user.id, i.sport ?? null]);
    return rows.map(({ provenance, previous_best, ...r }) => ({
      ...r, evidence: provenance, evidence_label: EVIDENCE_LABELS[provenance], previous_best,
      improved_by: previous_best === null ? null : Math.round(Math.abs(r.value - previous_best) * 1000) / 1000,
    }));
  },
});

cap({
  name: 'get_performance_trend', method: 'GET', path: '/me/trends', tag: TAG,
  summary: 'Your results for one metric over time (oldest first) for a chart, each point flagged when it set a new personal best. Choose the evidence to chart; by default all valid results.',
  input: z.object({ sport: z.string().min(1).max(60), metric: z.string().min(1).max(40), evidence: z.enum(['approved_competition', 'self_reported', 'imported']).optional(), from: day.optional(), to: day.optional() }),
  async handler({ user }, i) {
    if (i.from && i.to && i.to < i.from) throw badRequest('to is before from');
    const rows = await many(
      `SELECT p.id, to_char(coalesce(p.achieved_on, p.recorded_at::date),'YYYY-MM-DD') AS on_day, p.value::float8 AS value, p.provenance AS evidence, coalesce(p.direction,'higher') AS direction, p.unit
         FROM performances p JOIN sports s ON s.id=p.sport_id
        WHERE p.user_id=$1 AND s.slug=$2 AND p.metric=$3 AND ${VALID} AND ($4::text IS NULL OR p.provenance=$4)
          AND ($5::date IS NULL OR coalesce(p.achieved_on, p.recorded_at::date) >= $5) AND ($6::date IS NULL OR coalesce(p.achieved_on, p.recorded_at::date) <= $6)
        ORDER BY coalesce(p.achieved_on, p.recorded_at::date), p.recorded_at LIMIT 1000`,
      [user.id, i.sport, i.metric, i.evidence ?? null, i.from ?? null, i.to ?? null]);
    const direction = rows[0]?.direction ?? 'higher';
    let best = null;
    const points = rows.map((r) => {
      const better = best === null || (direction === 'lower' ? r.value < best : r.value > best);
      if (better) best = r.value;
      return { id: r.id, on: r.on_day, value: r.value, evidence: r.evidence, is_pr: better };
    });
    return { sport: i.sport, metric: i.metric, evidence: i.evidence ?? null, unit: rows[0]?.unit ?? null, direction, best, points };
  },
});
