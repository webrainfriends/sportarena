// Versioned sport rules for individual results: unit, ranking direction, allowed range and how official points are derived.
// Official points are always computed here, on the server — a client can never send them. Bump RULES_VERSION when a rule changes;
// each stored result keeps the version it was scored with, so old results are not silently re-scored.
export const RULES_VERSION = 1;

const TIME = /(^|_)time(_s|_sec)?$|_s$/;
const DISTANCE = /(^|_)(distance|throw|jump)(_m)?$|_m$/;
const POINTS_PER_UNIT = { goals: 3, assists: 1, points: 1, runs: 1, wickets: 3, aces: 1 };
const PARTICIPATION_POINTS = 5;

/** The rule for a metric in a sport (sport.scoring is 'points'|'time'|'distance'|'goals'|'sets'). */
export function ruleFor(sport, metric) {
  const m = String(metric).toLowerCase();
  if (sport.scoring === 'time' || TIME.test(m)) return { version: RULES_VERSION, unit: 's', direction: 'lower', min: 0.01, max: 86400, integer: false, per_unit: 0, per_result: PARTICIPATION_POINTS };
  if (sport.scoring === 'distance' || DISTANCE.test(m)) return { version: RULES_VERSION, unit: 'm', direction: 'higher', min: 0.01, max: 100000, integer: false, per_unit: 0, per_result: PARTICIPATION_POINTS };
  return { version: RULES_VERSION, unit: 'count', direction: 'higher', min: 0, max: 1000, integer: true, per_unit: POINTS_PER_UNIT[m] ?? 1, per_result: 0 };
}

/** Check a value against the rule; returns an error message or null. */
export function validateValue(rule, value) {
  if (!Number.isFinite(value)) return 'The value must be a number';
  if (rule.integer && !Number.isInteger(value)) return `This metric is counted in whole numbers`;
  if (value < rule.min || value > rule.max) return `The value must be between ${rule.min} and ${rule.max} ${rule.unit === 'count' ? '' : rule.unit}`.trim();
  return null;
}

/** Official points for one result under a rule. */
export const officialPoints = (rule, value) => Math.round((value * rule.per_unit + rule.per_result) * 100) / 100;

export const EVIDENCE_LABELS = {
  self_reported: 'Self-reported practice',
  imported: 'Imported evidence',
  approved_competition: 'Approved competition result',
};
export const RANKING_RULES = {
  by_points: 'Official points (higher wins). Ties: more approved results, then the earliest-approved result, then the same rank is shared.',
  by_metric_higher: 'Best approved value (higher wins). Ties: earlier achieved, then more official points.',
  by_metric_lower: 'Best approved value (lower wins, for times). Ties: earlier achieved, then more official points.',
};
