// Ranking evidence loading, snapshots and "why this rank" (#507). The engine (engine.js) is pure; everything that touches the database lives here.
// A ranking only ever reads existing verified results (performances, appearances, fixtures) and never writes one.
import { createHash } from 'node:crypto';
import { query, many, one, tx } from '../db.js';
import { PUBLIC_USER, PUBLIC_ROLES_SQL } from '../helpers.js';
import { NOT_YOUTH_SQL } from '../youth.js';
import { metricKey } from '../scoring/metric-defs.js';
import { computeRanking, describeFormula } from './engine.js';
import { onRatingsEvidenceChanged, afterRatingsChange } from '../ratings/data.js';
import { toLevel, inflate, RELIABLE_RD } from '../ratings/engine.js';

const q = (c) => c ?? { query };
const sc = (v) => v.scope ?? {};

export const loadDefinition = async (id, c) => (await q(c).query('SELECT * FROM ranking_definitions WHERE id=$1', [id])).rows[0] ?? null;
export const loadVersion = async (defId, version, c) =>
  (await q(c).query('SELECT * FROM ranking_definition_versions WHERE definition_id=$1 AND version=$2', [defId, version])).rows[0] ?? null;

/** Everyone who may see a club ranking: active members of its team. */
export async function isClubMember(user, def, c) {
  if (def.visibility !== 'club') return true;
  if (!user) return false;
  return !!(await q(c).query("SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2 AND status='active'", [def.scope_team_id, user.id])).rows[0];
}

/**
 * Evidence for a skill-level ranking: one row per verified game of the player's current rating run, valued at the level after that game, so the
 * ordinary engine ranks the latest level (aggregation 'last') with the same sample, event, window and tie rules as every other ranking.
 * `reliable` is the player's reliability today; the engine leaves unreliable levels out as "not yet ranked".
 */
async function skillEvidence(def, v, c) {
  const s = sc(v);
  return (await q(c).query(
    `SELECT md5(ch.run_id::text || ch.user_id::text || ch.game_id::text)::uuid AS id, ch.user_id AS subject, ch.after_r, ch.event_id, ch.game_kind, ch.game_id, ch.played_at, r.rd, r.sigma, r.last_played_at
       FROM skill_ratings r
       JOIN skill_rating_changes ch ON ch.run_id = r.run_id AND ch.user_id = r.user_id AND ch.sport_id = r.sport_id
       JOIN users u ON u.id = r.user_id
      WHERE r.sport_id = $1 AND r.status = 'active' AND ${NOT_YOUTH_SQL} AND u.access_status = 'approved'
        AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM active_sport_profiles sp WHERE sp.user_id = u.id AND sp.sport_id = r.sport_id
                                            AND EXISTS (SELECT 1 FROM unnest(sp.positions) x WHERE lower(x) = lower($2))))
        AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = $3 AND tm.user_id = u.id AND tm.status = 'active'))
      ORDER BY ch.played_at, ch.id`,
    [def.sport_id, s.position ?? null, def.visibility === 'club' ? def.scope_team_id : null])).rows
    .map((r) => ({
      id: r.id, subject: r.subject, value: toLevel(r.after_r), on: new Date(r.played_at).toISOString(), event_id: r.event_id ?? null,
      fixture_id: r.game_kind === 'fixture' ? r.game_id : null,
      reliable: inflate({ rd: r.rd, sigma: r.sigma }, r.last_played_at ? (Date.now() - new Date(r.last_played_at).getTime()) / 86400000 : 0) <= RELIABLE_RD,
    }));
}

/** Eligible evidence for a player ranking. Official rankings read approved competition results only; youth accounts and unapproved accounts never appear. */
async function playerEvidence(def, v, c) {
  if (v.formula_kind === 'skill_level') return skillEvidence(def, v, c);
  const s = sc(v);
  const development = v.evidence === 'development';
  return (await q(c).query(
    `SELECT p.id, p.user_id AS subject, p.value, p.event_id, p.fixture_id, coalesce(p.achieved_on, p.recorded_at::date)::text AS "on",
            m.minutes_played AS minutes, coalesce(h.owner_id = a.owner_id, false) AS same_owner
       FROM performances p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN events e ON e.id = p.event_id
       LEFT JOIN fixtures f ON f.id = p.fixture_id
       LEFT JOIN teams h ON h.id = f.home_team_id
       LEFT JOIN teams a ON a.id = f.away_team_id
       LEFT JOIN match_appearances m ON m.fixture_id = p.fixture_id AND m.user_id = p.user_id AND m.archived_at IS NULL AND m.verified_at IS NOT NULL
      WHERE p.sport_id = $1
        AND trim(both '_' from regexp_replace(lower(p.metric), '[^a-z0-9]+', '_', 'g')) = $2
        AND (($3::boolean = false AND p.provenance = 'approved_competition' AND p.status = 'approved')
          OR ($3::boolean AND p.status NOT IN ('rejected','superseded','disputed')))
        AND ${NOT_YOUTH_SQL} AND u.access_status = 'approved'
        AND ($4::int IS NULL OR extract(year FROM coalesce(p.achieved_on, p.recorded_at::date)) = $4)
        AND ($5::uuid IS NULL OR p.event_id = $5)
        AND ($6::text IS NULL OR lower(e.city) = lower($6))
        AND ($7::text IS NULL OR e.kind = $7)
        AND ($8::text IS NULL OR EXISTS (SELECT 1 FROM active_sport_profiles sp WHERE sp.user_id = u.id AND sp.sport_id = p.sport_id
                                            AND EXISTS (SELECT 1 FROM unnest(sp.positions) x WHERE lower(x) = lower($8))))
        AND ($9::uuid IS NULL OR EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = $9 AND tm.user_id = u.id AND tm.status = 'active'))
      ORDER BY p.id`,
    [def.sport_id, metricKey(v.metric), development, s.season ?? null, s.event_id ?? null, s.region ?? null, s.format ?? null, s.position ?? null, def.visibility === 'club' ? def.scope_team_id : null])).rows
    .map((r) => ({ ...r, value: Number(r.value), minutes: r.minutes == null ? null : Number(r.minutes) }));
}

/** Completed fixtures with a published score, one row per team. Friendlies only count when the ranking's format says so. */
async function teamEvidence(def, v, c) {
  const s = sc(v);
  return (await q(c).query(
    `SELECT f.id, t.team AS subject, f.event_id, coalesce(f.finished_at, f.scheduled_at)::date::text AS "on", t.gf, t.ga,
            CASE WHEN t.gf > t.ga THEN e.points_win WHEN t.gf = t.ga THEN e.points_draw ELSE e.points_loss END AS points,
            coalesce(tm.owner_id = o.owner_id, false) AS same_owner
       FROM fixtures f
       JOIN events e ON e.id = f.event_id
       CROSS JOIN LATERAL (VALUES (f.home_team_id, f.home_score, f.away_score, f.away_team_id), (f.away_team_id, f.away_score, f.home_score, f.home_team_id)) AS t(team, gf, ga, opp)
       JOIN teams tm ON tm.id = t.team
       LEFT JOIN teams o ON o.id = t.opp
      WHERE e.sport_id = $1 AND f.status IN ('completed','finished') AND f.home_score IS NOT NULL AND f.away_score IS NOT NULL AND t.team IS NOT NULL
        AND ($2::int IS NULL OR extract(year FROM f.scheduled_at) = $2)
        AND ($3::uuid IS NULL OR f.event_id = $3)
        AND ($4::text IS NULL OR lower(coalesce(e.city, tm.city)) = lower($4))
        AND (($5::text IS NULL AND e.kind <> 'friendly') OR e.kind = $5)
      ORDER BY f.id, t.team`,
    [def.sport_id, s.season ?? null, s.event_id ?? null, s.region ?? null, s.format ?? null])).rows
    .map((r) => ({ ...r, points: Number(r.points), gf: Number(r.gf), ga: Number(r.ga) }));
}

export const evidenceFor = (def, v, c) => (def.subject === 'team' ? teamEvidence(def, v, c) : playerEvidence(def, v, c));

/** Run a ranking now (or as of a moment). Deterministic for a given set of stored results. */
export async function runRanking(def, v, { asOf = new Date(), client } = {}) {
  const rows = await evidenceFor(def, v, client);
  return { ...computeRanking(rows, v, { asOf }), rows };
}

const subjectCols = (subject) => (subject === 'team'
  ? ['SELECT id, name, emoji, color, city FROM teams WHERE id = ANY($1)']
  : [`SELECT ${PUBLIC_USER.replace(`${PUBLIC_ROLES_SQL}, `, '')} FROM users u WHERE u.id = ANY($1)`]);
export async function subjectsOf(def, ids, c) {
  if (!ids.length) return new Map();
  const [sql] = subjectCols(def.subject);
  return new Map((await q(c).query(sql, [ids])).rows.map((r) => [r.id, r]));
}

export const strengthOf = (n, min) => (n >= min * 5 ? 'strong' : n >= min * 2 ? 'solid' : 'limited');

const hashOf = (versionId, entries) => createHash('sha256').update(JSON.stringify([versionId, entries.map((e) => [e.subject, e.rank, e.score, e.sample_n])])).digest('hex');

/** Store a snapshot (and any integrity flags). A rerun on identical evidence and version adds nothing. Returns the snapshot, or null when unchanged. */
export async function takeSnapshot(def, v, reason, { asOf = new Date(), client } = {}) {
  const res = await runRanking(def, v, { asOf, client });
  const run = async (c) => {
    for (const f of res.flags) {
      await c.query(
        `INSERT INTO ranking_flags(definition_id, subject_id, kind, detail, evidence_ids, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [def.id, f.subject, f.kind, flagText(f), f.ids ?? [f.id, f.with].filter(Boolean), f.key]);
    }
    if (!res.entries.length) return null;
    const hash = hashOf(v.id, res.entries);
    const last = (await c.query('SELECT content_hash FROM ranking_snapshots WHERE definition_id=$1 AND version_id=$2 ORDER BY as_of DESC, created_at DESC LIMIT 1', [def.id, v.id])).rows[0];
    if (last?.content_hash === hash) return null;
    const snap = (await c.query('INSERT INTO ranking_snapshots(definition_id, version_id, as_of, reason, entries_n, content_hash) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [def.id, v.id, asOf, reason, res.entries.length, hash])).rows[0];
    for (const e of res.entries) {
      await c.query('INSERT INTO ranking_snapshot_entries(snapshot_id, subject_id, rank, score, sample_n, events_n, evidence_ids) VALUES ($1,$2,$3,$4,$5,$6,$7)', [snap.id, e.subject, e.rank, e.score, e.sample_n, e.events_n, e.evidence_ids]);
    }
    return snap;
  };
  return client ? run(client) : tx(run);
}

const flagText = (f) => ({
  duplicate_evidence: 'Two results look identical (same person, metric, value, date and event); only the first counts. Please review.',
  rapid_activity: 'Many results were recorded for one person within 24 hours. This is flagged for review only; nothing has been concluded.',
  self_generated_fixtures: 'A game was played between teams run by the same owner, which this ranking excludes. Please review.',
}[f.kind]);

/** Snapshot every published ranking (optionally just one sport). Used by the weekly worker step and after results are corrected. */
export async function snapshotAll(reason, { sportId, skill } = {}) { // skill: 'only' or 'skip' limits it to (or leaves out) skill-level rankings
  const defs = await many(
    `SELECT d.* FROM ranking_definitions d LEFT JOIN ranking_definition_versions v ON v.definition_id = d.id AND v.version = d.current_version
      WHERE d.status='published' AND d.current_version > 0 AND ($1::uuid IS NULL OR d.sport_id=$1) AND ($2::text IS NULL OR (v.formula_kind = 'skill_level') = ($2 = 'only'))`, [sportId ?? null, skill ?? null]);
  let n = 0;
  for (const def of defs) {
    try { if (await takeSnapshot(def, await loadVersion(def.id, def.current_version), reason)) n++; } catch { /* one broken ranking never stops the rest */ }
  }
  return n;
}
/** Called after a result is approved, corrected or superseded; never blocks or fails the caller. */
export const onResultsChanged = (sportId) => Promise.all([snapshotAll('correction', { sportId, skill: 'skip' }).catch(() => 0), onRatingsEvidenceChanged(sportId)]).then(([n]) => n);
// a recompute that changed ratings re-snapshots that sport's skill-level rankings (earlier snapshots are kept)
afterRatingsChange(async (sportIds) => { for (const sportId of sportIds) await snapshotAll('correction', { sportId, skill: 'only' }).catch(() => 0); });

/** The plain-language "Why am I here?" for one subject in a ranking. */
export async function explain(def, v, res, subjectId, { unit, full }) {
  const entry = res.entries.find((e) => e.subject === subjectId);
  const out = res.ineligible.find((e) => e.subject === subjectId);
  if (!entry && !out) return null;
  const ids = (entry ?? out).evidence_ids;
  const byId = new Map(res.rows.filter((r) => ids.includes(r.id)).map((r) => [r.id, r]));
  const excluded = res.excluded.get(subjectId) ?? [];
  const included = ids.map((id) => byId.get(id)).filter(Boolean).map((r) => ({
    id: r.id, on: r.on, event_id: r.event_id ?? null, fixture_id: r.fixture_id ?? null,
    ...(def.subject === 'team' ? { goals_for: r.gf, goals_against: r.ga, points: r.points } : { value: r.value, ...(v.formula_kind === 'per_90' ? { minutes: r.minutes } : {}) }),
  })).sort((a, b) => (a.on < b.on ? 1 : -1));
  const counts = {};
  for (const x of excluded) counts[x.reason] = (counts[x.reason] ?? 0) + 1;
  return {
    status: entry ? 'ranked' : 'not_yet_ranked',
    rank: entry?.rank ?? null, score: entry?.score ?? null, sample_n: (entry ?? out).sample_n, events_n: (entry ?? out).events_n,
    formula: describeFormula(v, { unit }),
    weighting: v.formula_kind === 'skill_level' ? 'A level weighs who you beat (a stronger opponent moves you more), the score and how long ago; there is no boost for paid plans. The per-game reasons are on the player’s own level card.' : 'Every eligible result counts equally; there is no hidden weighting and no boost for paid plans.',
    included, excluded: full ? excluded : [], excluded_counts: counts,
    unmet: out ? out.reasons : [],
    limits: limitsOf(def, v, res),
  };
}

const limitsOf = (def, v, res) => [
  `Based on ${v.evidence === 'official' ? 'approved competition results only' : 'development data (practice and imported results are allowed and never public)'}.`,
  ...(v.formula_kind === 'skill_level' ? ['A level is ranked only while it is reliable; it fades back to “not yet ranked” if a player stops playing verified games.'] : []),
  `A person needs at least ${v.min_samples} eligible ${def.subject === 'team' ? 'games' : 'results'}${sc(v).event_id ? '' : ` across at least ${v.min_distinct_events} events`} to appear.`,
  'Youth accounts are never ranked. Results still awaiting approval or under dispute do not count.',
  `Ranked from ${res.rows.length} eligible ${def.subject === 'team' ? 'team-games' : 'results'} as at the time shown; a corrected result re-runs this ranking and the earlier snapshot is kept.`,
];

/**
 * Where a player or team stands in the public rankings, from the latest published snapshot of each (so it is the rank that was issued, with its version).
 * Always carries the sample size and evidence strength: a rank number is never shown without what it rests on. Used by discovery and recruiter views.
 */
export async function publicRankingsOf(subjectId, sportId, c) {
  const rows = (await q(c).query(
    `SELECT DISTINCT ON (d.id) d.id AS ranking_id, d.name, d.subject, d.family, v.version, v.min_samples, v.formula_hash, s.id AS snapshot_id, s.as_of, s.entries_n AS ranked_total, e.rank, e.score, e.sample_n, e.events_n
       FROM ranking_definitions d
       JOIN ranking_snapshots s ON s.definition_id = d.id
       JOIN ranking_definition_versions v ON v.id = s.version_id
       JOIN ranking_snapshot_entries e ON e.snapshot_id = s.id AND e.subject_id = $1
      WHERE d.visibility = 'public' AND d.status = 'published' AND ($2::uuid IS NULL OR d.sport_id = $2)
      ORDER BY d.id, s.as_of DESC, s.created_at DESC`, [subjectId, sportId ?? null])).rows;
  return rows.map(({ min_samples, ...r }) => ({ ...r, score: Number(r.score), evidence_strength: strengthOf(r.sample_n, min_samples) }));
}
