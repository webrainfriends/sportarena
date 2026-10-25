// Athlete season / career export packs (#332): the read model. One builder reads the canonical tables (unified match history, approved and
// self-reported results, player goals, awards, the career timeline, published coaching report versions) and returns a labelled snapshot.
// Nothing is calculated that the source does not already say, every row carries where it came from and how far it is verified, and the
// builder never touches private notes, health or wellness data, contact details or a date of birth.
import { createHash } from 'node:crypto';
import { many, one } from './db.js';
import { ACTIVITIES_CTE } from './athlete-history.js';
import { CAREER_VIEW_SQL } from './career.js';
import { CONSENT_OK } from './coaching-shared.js';
import { hasConsent } from './youth.js';

export const SECTIONS = ['matches', 'results', 'goals', 'awards', 'career', 'reports', 'evidence'];
export const SECTION_LABEL = { matches: 'Matches', results: 'Results', goals: 'Goals', awards: 'Awards', career: 'Career timeline', reports: 'Coaching reports', evidence: 'Evidence & provenance' };
/** Always excluded, whatever is selected. Listed in every pack so a reader sees what was left out on purpose. */
export const NEVER_INCLUDED = ['private_notes', 'health_and_wellness', 'contact_details', 'date_of_birth'];
export const ROW_CAP = 1000;

const PROVENANCE_TEXT = {
  matches: 'Matches marked official come from games and fixtures recorded on Sportarena. Matches marked self-reported or imported were entered by the athlete and are not verified.',
  results: 'Results marked approved competition were submitted by one official and approved by another. Self-reported and imported results are the athlete\'s own practice or device data and are not verified.',
  goals: 'Goals, targets and progress are the athlete\'s own claims. A coach\'s rating, where shown, is that coach\'s view and is labelled separately.',
  awards: 'Awards were granted by the organiser named on each row.',
  career: 'Memberships marked verified were confirmed by the club; the rest are self-reported or pending. Evidence files and references are never included, only how many exist.',
  reports: 'Coaching reports are the frozen published versions the viewer is allowed to read, shown with their version and fingerprint. Private coaching notes are never included.',
};

const yearRange = (year) => (year ? [`${year}-01-01`, `${year}-12-31`] : [null, null]);
export const scopeLabel = (scope, sport) => `${scope.kind === 'season' ? `Season ${scope.year}` : 'Career'}${sport ? ` · ${sport.name}` : ''}`;

/** Stable fingerprint of a snapshot. */
export const fingerprint = (snapshot) => createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');

/** Calendar years in which the athlete has anything a pack could show, newest first, with how many items each holds. */
export async function seasonsFor(athleteId) {
  return many(
    `${ACTIVITIES_CTE}
     SELECT y AS year, sum(m)::int AS matches, sum(r)::int AS results, sum(a)::int AS awards, sum(g)::int AS goals FROM (
       SELECT extract(year FROM played_on)::int AS y, 1 AS m, 0 AS r, 0 AS a, 0 AS g FROM acts
       UNION ALL SELECT extract(year FROM coalesce(achieved_on, recorded_at::date))::int, 0, 1, 0, 0 FROM performances WHERE user_id=$1 AND status IN ('approved','recorded','submitted')
       UNION ALL SELECT extract(year FROM awarded_at)::int, 0, 0, 1, 0 FROM awards WHERE user_id=$1
       UNION ALL SELECT extract(year FROM coalesce(starts_on, created_at::date))::int, 0, 0, 0, 1 FROM player_goals WHERE owner_id=$1) x
     WHERE y IS NOT NULL GROUP BY y ORDER BY y DESC`, [athleteId]);
}

/** Published coaching report versions a viewer may put in a pack. self -> 'athlete' audience, guardian -> 'guardian' audience (youth consent in force), staff -> the coach's own. */
export async function eligibleReports(athleteId, viewer, scope) {
  const [from, to] = yearRange(scope.year);
  const range = '($3::date IS NULL OR (r.period_to >= $3 AND r.period_from <= $4))';
  if (viewer.kind === 'staff') {
    return many(
      `SELECT DISTINCT ON (r.id) r.id AS report_id, v.version, r.title, r.kind, r.period_from::text AS period_from, r.period_to::text AS period_to, v.published_at, u.display_name AS coach_name
         FROM coaching_reports r JOIN coaching_report_versions v ON v.report_id=r.id JOIN users u ON u.id=r.coach_id
        WHERE r.athlete_id=$1 AND r.coach_id=$2 AND ${range} AND ${CONSENT_OK('r.athlete_id')} ORDER BY r.id, v.version DESC`, [athleteId, viewer.userId, from, to]);
  }
  const audience = viewer.kind === 'guardian' ? 'guardian' : 'athlete';
  return many(
    `SELECT DISTINCT ON (r.id) r.id AS report_id, v.version, r.title, r.kind, r.period_from::text AS period_from, r.period_to::text AS period_to, v.published_at, u.display_name AS coach_name
       FROM coaching_reports r JOIN coaching_report_versions v ON v.report_id=r.id JOIN users u ON u.id=r.coach_id
      WHERE r.athlete_id=$1 AND v.audience=$2 AND ${range} AND ${CONSENT_OK('r.athlete_id')} ORDER BY r.id, v.version DESC`, [athleteId, audience, from, to]);
}

const count = (rows, key) => rows.reduce((m, r) => { const k = r[key] ?? 'unknown'; m[k] = (m[k] ?? 0) + 1; return m; }, {});

async function matchesSection(athleteId, scope) {
  const rows = await many(
    `${ACTIVITIES_CTE}
     SELECT a.id, a.provenance, a.verification, s.slug AS sport_slug, s.name AS sport, a.kind, a.title, to_char(a.played_on,'YYYY-MM-DD') AS played_on,
            a.opponent, a.competition, a.venue, a.result, a.score_for::float8 AS score_for, a.score_against::float8 AS score_against, a.minutes
       FROM acts a JOIN sports s ON s.id=a.sport_id
      WHERE ($2::int IS NULL OR extract(year FROM a.played_on)=$2) AND ($3::uuid IS NULL OR a.sport_id=$3)
      ORDER BY a.played_on DESC, a.id LIMIT ${ROW_CAP + 1}`, [athleteId, scope.year ?? null, scope.sportId ?? null]);
  const truncated = rows.length > ROW_CAP;
  const items = rows.slice(0, ROW_CAP).map(({ id, ...r }) => r);
  const bySport = new Map();
  for (const r of items) {
    const b = bySport.get(r.sport_slug) ?? { sport_slug: r.sport_slug, sport: r.sport, matches: 0, wins: 0, draws: 0, losses: 0, official: 0, self_reported: 0 };
    b.matches++; if (r.result === 'win') b.wins++; else if (r.result === 'draw') b.draws++; else if (r.result === 'loss') b.losses++;
    if (r.provenance === 'official_game' || r.provenance === 'official_fixture') b.official++; else b.self_reported++;
    bySport.set(r.sport_slug, b);
  }
  return { rows: items, summary: [...bySport.values()].sort((a, b) => b.matches - a.matches || a.sport_slug.localeCompare(b.sport_slug)), truncated, provenance: count(items, 'provenance') };
}

async function resultsSection(athleteId, scope) {
  const rows = await many(
    `SELECT s.slug AS sport_slug, s.name AS sport, p.metric, p.value::float8 AS value, p.unit, coalesce(p.direction,'higher') AS direction, p.provenance, p.status,
            coalesce(p.achieved_on, p.recorded_at::date)::text AS on_date, e.name AS event_name, (p.evidence_ref IS NOT NULL) AS has_evidence
       FROM performances p JOIN sports s ON s.id=p.sport_id LEFT JOIN events e ON e.id=p.event_id
      WHERE p.user_id=$1 AND p.status IN ('approved','recorded','submitted') AND ($2::int IS NULL OR extract(year FROM coalesce(p.achieved_on, p.recorded_at::date))=$2) AND ($3::uuid IS NULL OR p.sport_id=$3)
      ORDER BY coalesce(p.achieved_on, p.recorded_at::date) DESC, p.id LIMIT ${ROW_CAP + 1}`, [athleteId, scope.year ?? null, scope.sportId ?? null]);
  const truncated = rows.length > ROW_CAP;
  const items = rows.slice(0, ROW_CAP);
  // bests are computed from approved competition results only, the same rule the passport uses
  const best = new Map();
  for (const r of items.filter((x) => x.provenance === 'approved_competition' && x.status === 'approved')) {
    const k = `${r.sport_slug}|${r.metric}|${r.unit ?? ''}`, cur = best.get(k);
    if (!cur || (r.direction === 'lower' ? r.value < cur.value : r.value > cur.value)) best.set(k, { sport_slug: r.sport_slug, sport: r.sport, metric: r.metric, unit: r.unit, direction: r.direction, best: r.value, on_date: r.on_date });
  }
  return { rows: items, bests: [...best.values()].sort((a, b) => a.sport_slug.localeCompare(b.sport_slug) || a.metric.localeCompare(b.metric)), truncated, provenance: count(items, 'provenance') };
}

async function awardsSection(athleteId, scope) {
  const rows = await many(
    `SELECT a.kind, a.name, e.name AS event_name, to_char(a.awarded_at,'YYYY-MM-DD') AS awarded_on, ob.display_name AS awarded_by
       FROM awards a LEFT JOIN events e ON e.id=a.event_id LEFT JOIN users ob ON ob.id=a.awarded_by
      WHERE a.user_id=$1 AND ($2::int IS NULL OR extract(year FROM a.awarded_at)=$2) AND ($3::uuid IS NULL OR e.sport_id=$3)
      ORDER BY a.awarded_at DESC, a.id LIMIT ${ROW_CAP}`, [athleteId, scope.year ?? null, scope.sportId ?? null]);
  return { rows, provenance: { organiser_awarded: rows.length } };
}

async function careerSection(athleteId, scope) {
  const [from, to] = yearRange(scope.year);
  const rows = await many(
    `SELECT x.sport, x.sport_slug, x.club, x.unlisted, x.season_label, x.starts_on, x.ends_on, x.current, x.position, x.competition_level, x.source, x.verification_status, x.verified_at,
            (SELECT count(*)::int FROM career_membership_evidence ev WHERE ev.membership_id=x.id AND ev.archived_at IS NULL) AS evidence_items
       FROM (${CAREER_VIEW_SQL} WHERE c.user_id=$1 AND c.archived_at IS NULL AND c.verification_status <> 'rejected'
                AND ($2::date IS NULL OR (c.starts_on <= $3::date AND (c.ends_on IS NULL OR c.ends_on >= $2::date))) AND ($4::uuid IS NULL OR c.sport_id=$4)) x
      ORDER BY x.starts_on DESC, x.id LIMIT ${ROW_CAP}`, [athleteId, from, to, scope.sportId ?? null]);
  return { rows, provenance: count(rows, 'verification_status') };
}

/** Goals. The athlete (and guardian) see all of theirs; a coach sees only goals shared with them through a live goal share. Only the athlete's own claims are included: no reasons, no progress notes. */
async function goalsSection(athleteId, scope, viewer) {
  const [from, to] = yearRange(scope.year);
  const staff = viewer.kind === 'staff';
  const rows = await many(
    `SELECT g.title, g.category, g.status, g.measure, g.target_value::float8 AS target_value, g.unit, g.starts_on::text AS starts_on, g.review_on::text AS review_on, g.ends_on::text AS ends_on,
            s.slug AS sport_slug, s.name AS sport,
            (SELECT p.value::float8 FROM player_goal_progress p WHERE p.goal_id=g.id AND p.value IS NOT NULL ORDER BY p.logged_on DESC, p.created_at DESC, p.id LIMIT 1) AS latest_value,
            (SELECT p.logged_on::text FROM player_goal_progress p WHERE p.goal_id=g.id AND p.value IS NOT NULL ORDER BY p.logged_on DESC, p.created_at DESC, p.id LIMIT 1) AS latest_on,
            (SELECT count(*)::int FROM player_goal_progress p WHERE p.goal_id=g.id) AS progress_entries
            ${staff ? '' : `, (SELECT a.rating FROM player_assessments a WHERE a.goal_id=g.id ORDER BY a.created_at DESC, a.id LIMIT 1) AS coach_rating`}
       FROM player_goals g LEFT JOIN sports s ON s.id=g.sport_id
      WHERE g.owner_id=$1 AND ($4::uuid IS NULL OR g.sport_id=$4)
        AND ($2::date IS NULL OR (coalesce(g.starts_on, g.created_at::date) <= $3::date AND coalesce(g.ends_on, CASE WHEN g.status IN ('achieved','dropped') THEN g.updated_at::date END, 'infinity'::date) >= $2::date))
        ${staff ? 'AND EXISTS (SELECT 1 FROM player_shares sh WHERE sh.goal_id=g.id AND sh.coach_id=$5 AND sh.revoked_at IS NULL)' : ''}
      ORDER BY coalesce(g.starts_on, g.created_at::date) DESC, g.id LIMIT ${ROW_CAP}`,
    staff ? [athleteId, from, to, scope.sportId ?? null, viewer.userId] : [athleteId, from, to, scope.sportId ?? null]);
  return { rows: rows.map((r) => ({ ...r, basis: 'athlete_claim' })), provenance: { athlete_claim: rows.length } };
}

async function reportsSection(athleteId, scope, viewer, reportIds) {
  const eligible = await eligibleReports(athleteId, viewer, scope);
  const chosen = viewer.kind === 'staff' ? eligible : eligible.filter((r) => reportIds.includes(r.report_id));
  const rows = [];
  for (const r of chosen) {
    const v = await one('SELECT snapshot, snapshot_sha256 FROM coaching_report_versions WHERE report_id=$1 AND version=$2', [r.report_id, r.version]);
    rows.push({ report_id: r.report_id, version: r.version, title: r.title, kind: r.kind, coach_name: r.coach_name, period_from: r.period_from, period_to: r.period_to, published_at: r.published_at, sha256: v.snapshot_sha256, sections: v.snapshot.sections ?? [], disclosure: v.snapshot.disclosure ?? null });
  }
  return { rows, provenance: { published_version: rows.length } };
}

/** What backs the numbers: counts by source and verification, plus the fingerprints of any reports. */
function evidenceSection(parts) {
  const out = { notes: [] };
  if (parts.matches) { out.matches = parts.matches.provenance; out.notes.push(PROVENANCE_TEXT.matches); }
  if (parts.results) { out.results = parts.results.provenance; out.notes.push(PROVENANCE_TEXT.results); }
  if (parts.goals) { out.goals = parts.goals.provenance; out.notes.push(PROVENANCE_TEXT.goals); }
  if (parts.awards) { out.awards = parts.awards.provenance; out.notes.push(PROVENANCE_TEXT.awards); }
  if (parts.career) { out.career = parts.career.provenance; out.career_evidence_items = parts.career.rows.reduce((n, r) => n + r.evidence_items, 0); out.notes.push(PROVENANCE_TEXT.career); }
  if (parts.reports) { out.reports = parts.reports.rows.map((r) => ({ title: r.title, version: r.version, sha256: r.sha256 })); out.notes.push(PROVENANCE_TEXT.reports); }
  return out;
}

/**
 * Build the pack snapshot.
 *  viewer.kind: 'self' (the adult athlete), 'guardian' (a young person's verified guardian) or 'staff' (a coach, through a live share).
 *  sections the viewer was allowed to ask for; a section that cannot be shown is listed under `withheld` with the reason, never silently dropped.
 */
export async function buildPack({ athleteId, viewer, scope, sections, reportIds = [] }) {
  const athlete = await one('SELECT id, display_name, handle FROM users WHERE id=$1', [athleteId]);
  const sport = scope.sportId ? await one('SELECT id, slug, name FROM sports WHERE id=$1', [scope.sportId]) : null;
  const youthNeedsConsent = viewer.kind === 'guardian';
  const consent = youthNeedsConsent ? await hasConsent(athleteId, 'coaching') : true;
  const want = SECTIONS.filter((s) => sections.includes(s) && s !== 'evidence');
  const withheld = [];
  const parts = {};
  for (const s of want) {
    if ((s === 'goals' || s === 'reports') && !consent) { withheld.push({ section: s, reason: 'A guardian has not given current coaching consent.' }); continue; }
    if (s === 'matches') parts.matches = await matchesSection(athleteId, scope);
    else if (s === 'results') parts.results = await resultsSection(athleteId, scope);
    else if (s === 'goals') parts.goals = await goalsSection(athleteId, scope, viewer);
    else if (s === 'awards') parts.awards = await awardsSection(athleteId, scope);
    else if (s === 'career') parts.career = await careerSection(athleteId, scope);
    else if (s === 'reports') parts.reports = await reportsSection(athleteId, scope, viewer, reportIds);
  }
  const included = Object.keys(parts);
  const snapshot = {
    schema: 1,
    athlete: { id: athlete.id, display_name: athlete.display_name, handle: athlete.handle },
    scope: { kind: scope.kind, year: scope.year ?? null, sport: sport ? { slug: sport.slug, name: sport.name } : null, label: scopeLabel(scope, sport) },
    prepared_for: viewer.kind,
    generated_at: new Date().toISOString(),
    included: sections.includes('evidence') ? [...included, 'evidence'] : included,
    withheld,
    never_included: NEVER_INCLUDED,
    ...parts,
    ...(sections.includes('evidence') ? { evidence: evidenceSection(parts) } : {}),
    notice: 'Prepared from Sportarena records at the time shown. Self-reported items are labelled and are not verified. Private notes, health and wellness data, contact details and date of birth are never included.',
  };
  return snapshot;
}

/** Rows for the CSV: one flat table, every row labelled with its section, provenance and verification. */
export const CSV_COLUMNS = ['section', 'date', 'sport', 'item', 'detail', 'outcome', 'value', 'unit', 'provenance', 'verification', 'source'];
export function packRows(p) {
  const out = [];
  const add = (section, r) => out.push({ section, date: '', sport: '', item: '', detail: '', outcome: '', value: '', unit: '', provenance: '', verification: '', source: '', ...r });
  add('about', { item: p.athlete.display_name, detail: p.scope.label, provenance: `prepared_for_${p.prepared_for}`, source: `generated ${p.generated_at}` });
  for (const m of p.matches?.rows ?? []) add('matches', { date: m.played_on, sport: m.sport, item: m.title ?? m.competition ?? m.kind, detail: [m.opponent && `vs ${m.opponent}`, m.competition, m.venue].filter(Boolean).join(' · '), outcome: m.result ?? '', value: m.score_for == null ? '' : `${m.score_for}${m.score_against == null ? '' : `-${m.score_against}`}`, unit: m.minutes == null ? '' : `${m.minutes} min`, provenance: m.provenance, verification: m.verification, source: m.provenance.startsWith('official') ? 'sportarena_record' : 'athlete_entered' });
  for (const r of p.results?.rows ?? []) add('results', { date: r.on_date, sport: r.sport, item: r.metric, detail: r.event_name ?? '', outcome: r.status, value: r.value, unit: r.unit ?? '', provenance: r.provenance, verification: r.provenance === 'approved_competition' ? 'approved' : 'unverified', source: r.has_evidence ? 'evidence_attached' : '' });
  for (const g of p.goals?.rows ?? []) add('goals', { date: g.review_on ?? g.starts_on ?? '', sport: g.sport ?? '', item: g.title, detail: g.measure ?? g.category, outcome: g.status, value: g.latest_value ?? g.target_value ?? '', unit: g.unit ?? '', provenance: 'athlete_claim', verification: g.coach_rating ? `coach_rating:${g.coach_rating}` : 'unverified', source: g.progress_entries ? `${g.progress_entries} progress entries` : '' });
  for (const a of p.awards?.rows ?? []) add('awards', { date: a.awarded_on, item: a.name, detail: a.event_name ?? '', outcome: a.kind, provenance: 'organiser_awarded', verification: 'awarded', source: a.awarded_by ?? '' });
  for (const c of p.career?.rows ?? []) add('career', { date: c.starts_on, sport: c.sport, item: c.club, detail: [c.season_label, c.position, c.competition_level].filter(Boolean).join(' · '), outcome: c.ends_on ? `until ${c.ends_on}` : 'current', provenance: c.source, verification: c.verification_status, source: c.evidence_items ? `${c.evidence_items} evidence items` : '' });
  for (const r of p.reports?.rows ?? []) add('reports', { date: String(r.published_at).slice(0, 10), item: r.title, detail: `${r.period_from} to ${r.period_to} · coach ${r.coach_name}`, outcome: `version ${r.version}`, provenance: 'published_report', verification: 'frozen_version', source: `sha256:${r.sha256}` });
  for (const w of p.withheld) add('withheld', { item: w.section, detail: w.reason });
  return out;
}
