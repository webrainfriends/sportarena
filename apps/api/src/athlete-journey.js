// Athlete 360 journey (#571): the vocabulary the timeline, the period comparison and the shared portfolio have in common. Nothing here is
// stored; every row still comes from its canonical table (graph-360.js, graph-sources.js) and carries one of three origins.
import { one } from './db.js';
import { badRequest, notFound } from './errors.js';
import { publicCareer } from './career.js';

/** How much a reader may trust a row: confirmed by someone other than the athlete (or the platform's own record), entered by a person and not yet confirmed, or brought in from outside. */
export const ORIGINS = {
  verified: 'Confirmed by a club, coach, organiser, doctor or the platform\'s own records',
  user_entered: 'Entered by the athlete or a staff member and not yet confirmed by anyone else',
  external: 'Imported from outside the platform',
};
export const ORIGIN_KEYS = Object.keys(ORIGINS);

export const careerOrigin = (m) => (m.verification_status === 'verified' ? 'verified' : 'user_entered');
export const edgeOrigin = (e) => (e.verification_state === 'verified' ? 'verified' : e.provenance === 'imported' ? 'external' : 'user_entered');
export const performanceOrigin = (p) => (p.provenance === 'approved_competition' ? 'verified' : p.provenance === 'imported' ? 'external' : p.decided_by && p.decided_by !== p.user_id ? 'verified' : 'user_entered');

/** One period: explicit dates, a season (its own dates), or one club stint (its dates and sport). Anything else is open-ended. */
export async function resolveWindow(personId, { from, to, season_id, membership_id, sport } = {}) {
  let w = { from: from ?? null, to: to ?? null, sport: sport ?? null, label: null };
  if (season_id) {
    const s = await one('SELECT name, starts_on::text AS starts_on, ends_on::text AS ends_on FROM org_seasons WHERE id=$1', [season_id]);
    if (!s) throw notFound('Season');
    w = { ...w, from: w.from ?? s.starts_on, to: w.to ?? s.ends_on, label: s.name };
  }
  if (membership_id) {
    const m = (await publicCareer(personId)).find((x) => x.id === membership_id);
    if (!m) throw notFound('Career entry');
    w = { ...w, from: w.from ?? m.starts_on, to: w.to ?? m.ends_on ?? new Date().toISOString().slice(0, 10), sport: w.sport ?? m.sport_slug, label: m.club };
  }
  if (w.from && w.to && w.to < w.from) throw badRequest('A period cannot end before it starts');
  return w;
}
const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
/** Is a date inside the window? A row with no date never is, once a window is set. */
export const within = (at, w) => (!w.from && !w.to) || (!!day(at) && (!w.from || day(at) >= w.from) && (!w.to || day(at) <= w.to));
/** Does a span (a club stint) overlap the window? An open end means "still going". */
export const overlaps = (start, end, w) => (!w.from || !day(end) || day(end) >= w.from) && (!w.to || !day(start) || day(start) <= w.to);

/** The figures two periods are compared on: where each comes from, and how to add up a timeline row. */
export const METRICS = [
  { key: 'matches', label: 'Matches played', domain: 'competition', of: (i) => (i.type === 'appearance' ? 1 : 0) },
  { key: 'minutes', label: 'Verified minutes', domain: 'competition', unit: 'min', of: (i) => (i.type === 'appearance' ? Number(i.minutes ?? 0) : 0) },
  { key: 'results', label: 'Results recorded', domain: 'result', of: () => 1 },
  { key: 'wins', label: 'Wins', domain: 'result', of: (i) => (i.outcome === 'win' ? 1 : 0) },
  { key: 'podiums', label: 'Podium finishes', domain: 'result', of: (i) => (i.rank && i.rank <= 3 ? 1 : 0) },
  { key: 'awards', label: 'Awards', domain: 'achievement', of: () => 1 },
  { key: 'records', label: 'Approved performance records', domain: 'statistics', of: () => 1 },
  { key: 'clubs_joined', label: 'Clubs joined', domain: 'career', of: (i) => (i.type === 'joined' ? 1 : 0) },
  { key: 'moves', label: 'Moves between clubs', domain: 'career', of: (i) => (i.type === 'transfer' ? 1 : 0) },
  { key: 'training', label: 'Training sessions', domain: 'training', of: () => 1 },
  { key: 'goals_set', label: 'Goals set', domain: 'development', of: (i) => (i.type === 'goal_set' ? 1 : 0) },
  { key: 'goals_achieved', label: 'Goals achieved', domain: 'development', of: (i) => (i.type === 'goal_achieved' ? 1 : 0) },
];
export const COMPARE_DOMAINS = [...new Set(METRICS.map((m) => m.domain))];

export function summarise(items, w) {
  const mine = items.filter((i) => within(i.at, w) && (!w.sport || i.sport_slug === w.sport));
  const by_origin = Object.fromEntries(ORIGIN_KEYS.map((k) => [k, mine.filter((i) => i.origin === k).length]));
  const metrics = Object.fromEntries(METRICS.map((m) => [m.key, mine.filter((i) => i.domain === m.domain).reduce((n, i) => n + m.of(i), 0)]));
  return { rows: mine.length, metrics, by_origin };
}
