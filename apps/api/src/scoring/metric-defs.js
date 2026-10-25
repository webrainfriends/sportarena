// Governed metric definitions: the stored, versioned rule for a metric in a sport. Falls back to the built-in rule (performance-rules.js)
// when nobody has published a definition, so existing behaviour is unchanged until a sport is governed.
import crypto from 'node:crypto';
import { pool } from '../db.js';
import { ruleFor } from './performance-rules.js';

const q = (c) => c ?? pool;
export const metricKey = (m) => String(m).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
export const AGGREGATIONS = ['best', 'sum', 'mean', 'last'];

/** Shape a stored version like the built-in rule so validateValue / officialPoints work on either. */
export const ruleFromVersion = (v, def) => ({
  version: v.version, version_id: v.id, definition_id: v.definition_id, governed: true, key: def?.key ?? v.key, label: def?.label ?? v.label,
  unit: v.unit, direction: v.direction, aggregation: v.aggregation, integer: v.value_kind === 'integer',
  min: Number(v.min_value), max: Number(v.max_value),
  per_unit: v.points_mode === 'per_unit' ? Number(v.points_value) : 0, per_result: v.points_mode === 'flat' ? Number(v.points_value) : 0,
  points_mode: v.points_mode, rankable_provenance: v.rankable_provenance, evidence_required_for: v.evidence_required_for, effective_from: v.effective_from,
});

export const builtinRule = (sport, metric) => ({ ...ruleFor(sport, metric), governed: false, version_id: null, aggregation: 'best', rankable_provenance: ['approved_competition'], evidence_required_for: ['imported'] });

/** The rule in force for a metric — the current published version, or the one that was in force at `asOf`. */
export async function resolveRule(sport, metric, { c, asOf } = {}) {
  const key = metricKey(metric);
  const row = (await q(c).query(
    `SELECT v.*, d.key, d.label FROM metric_definitions d JOIN metric_definition_versions v ON v.definition_id=d.id
      WHERE d.sport_id=$1 AND d.key=$2 AND d.status='published' AND ($3::timestamptz IS NULL OR v.effective_from <= $3)
      ORDER BY v.version DESC LIMIT 1`, [sport.id, key, asOf ?? null])).rows[0];
  return row ? ruleFromVersion(row, row) : builtinRule(sport, metric);
}

/** The exact version a stored result was scored under (so corrections and audits use it, not today's rule). */
export async function ruleOfVersion(versionId, c) {
  const row = (await q(c).query('SELECT v.*, d.key, d.label FROM metric_definition_versions v JOIN metric_definitions d ON d.id=v.definition_id WHERE v.id=$1', [versionId])).rows[0];
  return row ? ruleFromVersion(row, row) : null;
}

export const versionHash = (v) => crypto.createHash('sha256').update(JSON.stringify([v.unit, v.direction, v.aggregation, v.value_kind, Number(v.min_value), Number(v.max_value), v.points_mode, Number(v.points_value), [...v.rankable_provenance].sort(), [...v.evidence_required_for].sort()])).digest('hex');
export const rulesetHash = (r) => crypto.createHash('sha256').update(JSON.stringify(r)).digest('hex');

/** Per sport+metric aggregation lookup for read models (stats, leaderboard). */
export async function aggregationFor(sportId, metric, c) {
  const row = (await q(c).query(
    `SELECT v.aggregation FROM metric_definitions d JOIN metric_definition_versions v ON v.definition_id=d.id AND v.version=d.current_version
      WHERE d.sport_id=$1 AND d.key=$2 AND d.status='published'`, [sportId, metricKey(metric)])).rows[0];
  return row?.aggregation ?? 'best';
}

/** The built-in (standard) rule in the same flat shape as a stored version, so the two can be compared field by field. */
export function standardOf(sport, metric) {
  const r = ruleFor(sport, metric);
  return { unit: r.unit, direction: r.direction, aggregation: 'best', value_kind: r.integer ? 'integer' : 'decimal', min_value: r.min, max_value: r.max,
    points_mode: r.per_unit ? 'per_unit' : 'flat', points_value: r.per_unit || r.per_result };
}
const STD_FIELDS = ['unit', 'direction', 'aggregation', 'value_kind', 'min_value', 'max_value', 'points_mode', 'points_value'];
/** Which fields of a metric version differ from the standard rule (empty = it is the standard). */
export const differsFromStandard = (v, std) => STD_FIELDS.filter((f) => String(Number.isNaN(Number(v[f])) ? v[f] : Number(v[f])) !== String(Number.isNaN(Number(std[f])) ? std[f] : Number(std[f])));
/** The standard kinds of metric a sport can have, for people reading the rules. */
export const standardMetricKinds = (sport) => [['Time', 'time_s'], ['Distance or height', 'distance_m'], ['Count (goals, points, wickets …)', 'count']]
  .map(([label, probe]) => ({ kind: label, probe, ...standardOf({ ...sport, scoring: 'points' }, probe) }));
