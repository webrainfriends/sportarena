// Streaks and achievements (#595 tracking, benchmark gap 9). Pure and deterministic: the same verified facts always give the same streaks and
// badges, so nothing here can be gamed by self-reporting. Only approved competition results and granted medals count; practice and imported
// figures never do. Each family of sport has its own milestone model (a cricket innings is not a goal game is not a timed event); a sport with
// no native model gets only the generic, labelled milestones and is never silently defaulted.
import { FAMILIES } from '../rankings/families.js';

const DAY = 86400000;
const toDay = (d) => Math.floor(new Date(`${String(d).slice(0, 10)}T00:00:00Z`).getTime() / DAY);
/** Monday-based week number, so a streak week always runs Monday to Sunday. */
export const weekOf = (d) => Math.floor((toDay(d) + 3) / 7);

/** Consecutive weeks with at least one verified result. The current run stays alive through this week and the one before. */
export function weeklyStreak(dates, today) {
  const weeks = [...new Set(dates.map(weekOf))].sort((a, b) => a - b);
  let longest = 0, run = 0, prev = null;
  for (const w of weeks) { run = prev !== null && w === prev + 1 ? run + 1 : 1; longest = Math.max(longest, run); prev = w; }
  const now = weekOf(today);
  const current = weeks.length && now - weeks[weeks.length - 1] <= 1 ? run : 0;
  return { current, longest, last_week_on: weeks.length ? dates.map((d) => String(d).slice(0, 10)).sort().pop() : null, weeks: weeks.length };
}

/** Consecutive results that each beat every earlier one (oldest first). The first result sets the baseline and does not count. */
export function personalBestRun(values, direction = 'higher') {
  const better = direction === 'lower' ? (a, b) => a < b : (a, b) => a > b;
  let best = null, run = 0, longest = 0;
  for (const v of values) {
    if (best === null) best = v;
    else if (better(v, best)) { best = v; run += 1; longest = Math.max(longest, run); }
    else run = 0;
  }
  return { current: run, longest };
}

/** The native milestone model for each family: [metric, label, tiers]. Metrics are the governed performance metrics. */
export const FAMILY_MILESTONES = {
  cricket: [['runs', 'Runs', [100, 500, 1000]], ['wickets', 'Wickets', [10, 50, 100]]],
  goal_game: [['goals', 'Goals', [10, 50, 100]], ['assists', 'Assists', [10, 50, 100]]],
  racket: [],
  measured: [],
  generic: [],
  team_form: [],
};
const PB_TIERS = [3, 10, 25];
const RESULT_TIERS = [1, 10, 50, 100];
const WEEK_TIERS = [4, 12, 26];
const SPORT_TIERS = [2, 3, 5];
const EVENT_TIERS = [1, 5, 10];
const MEDAL_TIERS = [1, 5, 10];
const TIER_NAMES = ['Bronze', 'Silver', 'Gold', 'Platinum'];

/** What a family offers, for the catalogue and the "every sport" check. Racket, timed/measured and generic sports earn the shared
 *  milestones; only the generic family is a labelled fallback. */
export function modelFor(family) {
  const f = FAMILIES[family] ?? FAMILIES.generic;
  return { family, label: f.label, native: f.native, milestones: (FAMILY_MILESTONES[family] ?? []).map(([metric, label, tiers]) => ({ metric, label, tiers })), shared: ['results', 'personal_bests', 'weekly_streak', 'sports', 'events', 'medals'], note: f.native ? f.note : 'Labelled fallback: this sport earns only the shared milestones until it has a dedicated model.' };
}

const tierDefs = (key, family, label, unit, tiers, value, evidence) => tiers.map((threshold, i) => ({
  key: `${key}:${threshold}`, group: key, family, label: `${label} ${TIER_NAMES[Math.min(i, 3)]}`, tier: TIER_NAMES[Math.min(i, 3)], threshold, unit,
  progress: Math.min(value, threshold), earned: value >= threshold, evidence: evidence.slice(0, 5),
}));

/**
 * facts: { today, results: [{ id, sport, family, metric, value, direction, on, event_id }], medals: [{ id, kind, on }] }
 * results are verified (approved competition) only; the caller guarantees that.
 */
export function evaluate(facts) {
  const { today, results = [], medals = [] } = facts;
  const ordered = [...results].sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : String(a.id).localeCompare(String(b.id))));
  const ref = (r) => ({ id: r.id, on: String(r.on).slice(0, 10), sport: r.sport, metric: r.metric, value: r.value });

  // streaks: weekly activity overall, and a personal-best run per sport and metric
  const weekly = weeklyStreak(ordered.map((r) => r.on), today);
  const groups = new Map();
  for (const r of ordered) { const k = `${r.sport}|${r.metric}`; (groups.get(k) ?? groups.set(k, []).get(k)).push(r); }
  const personal_best = [...groups.entries()].map(([k, rs]) => {
    const run = personalBestRun(rs.map((r) => Number(r.value)), rs[0].direction);
    const [sport, metric] = k.split('|');
    return { sport, metric, family: rs[0].family, results: rs.length, ...run };
  }).filter((s) => s.longest > 0 || s.results > 1).sort((a, b) => b.current - a.current || b.longest - a.longest || a.sport.localeCompare(b.sport));
  const bestPbCurrent = personal_best.reduce((m, s) => Math.max(m, s.current), 0);
  const bestPbLongest = personal_best.reduce((m, s) => Math.max(m, s.longest), 0);

  // achievements
  const sports = [...new Set(ordered.map((r) => r.sport))];
  const events = [...new Set(ordered.map((r) => r.event_id).filter(Boolean))];
  const families = [...new Set(ordered.map((r) => r.family))];
  const a = [
    ...tierDefs('results', 'all', 'Verified results', 'results', RESULT_TIERS, ordered.length, ordered.map(ref)),
    ...tierDefs('weekly_streak', 'all', 'Weekly streak', 'weeks', WEEK_TIERS, weekly.longest, ordered.map(ref)),
    ...tierDefs('personal_bests', 'all', 'Personal-best run', 'records', PB_TIERS, bestPbLongest, ordered.map(ref)),
    ...tierDefs('sports', 'all', 'Multi-sport', 'sports', SPORT_TIERS, sports.length, ordered.map(ref)),
    ...tierDefs('events', 'all', 'Events competed', 'events', EVENT_TIERS, events.length, ordered.map(ref)),
    ...tierDefs('medals', 'all', 'Podium', 'medals', MEDAL_TIERS, medals.length, medals.map((m) => ({ id: m.id, on: String(m.on).slice(0, 10), sport: null, metric: m.kind, value: 1 }))),
  ];
  for (const fam of families) {
    for (const [metric, label, tiers] of FAMILY_MILESTONES[fam] ?? []) {
      const rs = ordered.filter((r) => r.family === fam && r.metric === metric);
      a.push(...tierDefs(`${fam}_${metric}`, fam, label, metric, tiers, rs.reduce((s, r) => s + Number(r.value), 0), rs.map(ref)));
    }
  }
  // only a tier you can see: all earned tiers, plus the very next one of each group as progress
  const earned = a.filter((x) => x.earned);
  const next = [];
  for (const g of new Set(a.map((x) => x.group))) { const n = a.find((x) => x.group === g && !x.earned); if (n && (earned.some((e) => e.group === g) || n.progress > 0)) next.push(n); }
  return {
    streaks: { weekly, personal_best, current_best_run: bestPbCurrent },
    achievements: earned, next_up: next,
    totals: { results: ordered.length, sports: sports.length, events: events.length, medals: medals.length },
    families: families.map((f) => modelFor(f)),
  };
}
