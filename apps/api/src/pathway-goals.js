// What an athlete can pick when setting a pathway goal (issue #335): their sports, each sport's governed metrics and match stats with the unit,
// direction, valid range and the athlete's own current value (approved competition results and self-logged figures are never blended), plus
// direction-aware suggestions, and the academic measures with their real scales. Nothing is typed: the goal is built from these options.
import { many } from './db.js';
import { build, PROFILE_SQL } from './capabilities/player-insights.js';
import { one } from './db.js';
import { EVIDENCE_LABELS } from './scoring/performance-rules.js';

export const ACADEMIC = [
  { key: 'gpa_4', label: 'GPA (4.0 scale)', unit: 'GPA', min: 0, max: 4, step: 0.1 },
  { key: 'gpa_10', label: 'GPA (10-point scale)', unit: 'GPA', min: 0, max: 10, step: 0.1 },
  { key: 'percentage', label: 'Grade (%)', unit: '%', min: 0, max: 100, step: 1 },
  { key: 'sat', label: 'SAT', unit: 'points', min: 400, max: 1600, step: 10 },
  { key: 'act', label: 'ACT', unit: 'points', min: 1, max: 36, step: 1 },
  { key: 'ielts', label: 'IELTS', unit: 'band', min: 0, max: 9, step: 0.5 },
  { key: 'toefl', label: 'TOEFL iBT', unit: 'points', min: 0, max: 120, step: 1 },
  { key: 'credits', label: 'Credits', unit: 'credits', min: 0, max: 240, step: 1 },
];
export const MILESTONES = ['Make the squad', 'Earn a scholarship', 'Win a title', 'Qualify for a national event', 'Get a professional contract', 'Reach a ranking'];

const ORDER = ['approved_competition', 'self_reported', 'imported'];
const VALID = "((p.provenance='approved_competition' AND p.status='approved') OR (p.provenance IN ('self_reported','imported') AND p.status='recorded'))";
const round = (v, step) => Math.round(v / step) * step;
const fix = (v) => Math.round(v * 1000) / 1000;
const stepFor = (unit, integer, min, max) => (unit === 's' ? 0.01 : integer ? 1 : unit === '%' || (max - min) >= 100 ? 1 : 0.1);

/** Suggestions in the metric's good direction: beat my best, and match a cohort median when enough comparable players exist. */
function suggest(m, medians) {
  if (m.current === null || m.current === undefined) return [];
  const sign = m.direction === 'lower' ? -1 : 1;
  const out = [];
  const pcts = m.unit === 's' ? [1, 2] : [5, 10];
  for (const pct of pcts) {
    const v = fix(Math.min(m.max, Math.max(m.min, round(m.current * (1 + (sign * pct) / 100), m.step))));
    if (v !== m.current) out.push({ label: `Beat my best by ${pct}%`, value: v, basis: 'your own figure' });
  }
  for (const med of medians ?? []) {
    const better = sign > 0 ? med.value > m.current : med.value < m.current;
    if (better) out.push({ label: `Reach the median of ${med.label}`, value: fix(med.value), basis: `${med.players} comparable players, ${med.evidence_label.toLowerCase()}` });
  }
  return out;
}

export async function goalOptionsFor(userId, sportSlug) {
  const sports = await many('SELECT DISTINCT s.id, s.slug, s.name, s.emoji FROM active_sport_profiles sp JOIN sports s ON s.id=sp.sport_id WHERE sp.user_id=$1 ORDER BY s.name', [userId]);
  const base = { sports: sports.map(({ id, ...s }) => s), academic: ACADEMIC, milestones: MILESTONES, metrics: [] };
  const sport = sports.find((s) => s.slug === sportSlug);
  if (!sport) return base;
  const defs = await many(
    `SELECT d.key, d.label, v.unit, v.direction, v.value_kind, v.min_value::float8 AS min, v.max_value::float8 AS max
       FROM metric_definitions d JOIN metric_definition_versions v ON v.definition_id=d.id AND v.version=d.current_version WHERE d.sport_id=$1 AND d.status='published' ORDER BY d.label`, [sport.id]);
  const best = await many(
    `SELECT DISTINCT ON (p.metric, p.provenance) p.metric, p.provenance, p.value::float8 AS value, coalesce(p.direction,'higher') AS direction
       FROM performances p WHERE p.user_id=$1 AND p.sport_id=$2 AND ${VALID}
      ORDER BY p.metric, p.provenance, CASE WHEN coalesce(p.direction,'higher')='lower' THEN p.value ELSE -p.value END`, [userId, sport.id]);
  const metrics = defs.map((d) => {
    const mine = ORDER.map((e) => best.find((b) => b.metric === d.key && b.provenance === e)).find(Boolean);
    const integer = d.value_kind === 'integer';
    const min = d.min ?? 0, max = d.max ?? (d.unit === '%' ? 100 : 1000);
    const m = { key: d.key, label: d.label, source: 'results', unit: d.unit, direction: d.direction === 'lower' ? 'lower' : 'higher', integer, min, max, step: stepFor(d.unit, integer, min, max),
      current: mine ? fix(mine.value) : null, evidence: mine?.provenance ?? null, evidence_label: mine ? EVIDENCE_LABELS[mine.provenance] : null, tracks_live: true };
    return { ...m, suggestions: suggest(m, []) };
  });
  // per-match figures (goals per match, first-serve %, errors) from the matches the athlete logged, with cohort medians when enough players compare
  const profile = await one(PROFILE_SQL, [userId, null]).then(async (p) => (p?.sport_id === sport.id ? p : (await one("SELECT p.id, p.sport_id, p.level, nullif(btrim(p.region), '') AS region, p.positions, p.position, s.slug AS sport_slug, s.name AS sport, s.emoji AS sport_emoji, s.category FROM active_sport_profiles p JOIN sports s ON s.id=p.sport_id WHERE p.user_id=$1 AND p.sport_id=$2 AND p.role='athlete' ORDER BY p.is_default DESC, p.created_at LIMIT 1", [userId, sport.id]))));
  if (profile) {
    for (const evidence of ['official', 'self_reported']) {
      let out;
      try { out = await build(userId, profile, { evidence }); } catch { out = null; }
      if (!out?.ready) continue;
      const track = evidence === 'official' ? 'approved_competition' : 'self_reported';
      for (const row of out.my_metrics) {
        if (['matches', 'win_rate', 'avg_rating'].includes(row.key) || row.direction === 'unknown' || metrics.some((x) => x.key === row.key)) continue;
        const medians = out.scopes.filter((s) => s.available).map((s) => { const c = s.comparisons.find((x) => x.key === row.key && x.status === 'ranked'); return c ? { label: s.label, value: c.cohort_median, players: c.n, evidence_label: out.evidence_label } : null; }).filter(Boolean);
        const unit = row.unit ?? '', integer = false, min = 0, max = unit === '%' ? 100 : 1000;
        const m = { key: row.key, label: row.label, source: 'matches', unit: unit || 'per match', direction: row.direction, integer, min, max, step: stepFor(unit, integer, min, max), current: fix(row.mine), evidence: track, evidence_label: out.evidence_label, tracks_live: false };
        metrics.push({ ...m, suggestions: suggest(m, medians) });
      }
    }
  }
  return { ...base, metrics };
}

/** The athlete's best figure now for a goal that follows a sport result metric, or null (then the goal is updated by hand). */
export async function liveCurrent(g) {
  if (!g.metric_key || !g.sport_id || !g.evidence) return null;
  const prov = g.evidence === 'official' ? 'approved_competition' : g.evidence;
  const status = prov === 'approved_competition' ? 'approved' : 'recorded';
  const r = await one(
    `SELECT p.value::float8 AS value FROM performances p WHERE p.user_id=$1 AND p.sport_id=$2 AND p.metric=$3 AND p.provenance=$4 AND p.status=$5
      ORDER BY CASE WHEN coalesce(p.direction,'higher')='lower' THEN p.value ELSE -p.value END LIMIT 1`, [g.user_id, g.sport_id, g.metric_key, prov, status]);
  return r ? fix(r.value) : null;
}
