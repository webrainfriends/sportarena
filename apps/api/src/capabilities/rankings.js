// Transparent player & team rankings (#507): governed, versioned, explainable projections of verified results. Nothing here creates a result;
// REST, OpenAPI and MCP all use these definitions, so eligibility and privacy are identical everywhere.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { audit, sportBySlugOrId } from '../helpers.js';
import { metricKey, resolveRule } from '../scoring/metric-defs.js';
import { canGovern } from './metric-governance.js';
import { canManageTeam } from './teams.js';
import { FAMILIES, familyOf, kindsFor } from '../rankings/families.js';
import { describeFormula } from '../rankings/engine.js';
import { publicRankingsOf, loadDefinition, loadVersion, isClubMember, runRanking, subjectsOf, strengthOf, takeSnapshot, explain } from '../rankings/data.js';

const TAG = 'Rankings';
const scopeShape = z.object({
  season: z.number().int().min(1900).max(2200).optional(),
  event_id: id.optional(),
  region: z.string().min(2).max(60).optional().describe('the city where the competition was played'),
  format: z.enum(['tournament', 'league', 'friendly', 'camp', 'trial']).optional(),
  position: z.string().min(1).max(40).optional(),
}).strict();

const TIE_RULES = {
  metric: 'Equal scores are split by whoever first achieved it, then by more eligible results; the same rank is shared only when all of those are equal.',
  team_form: 'Equal points per game are split by goal difference per game, then whoever played earlier, then more games; the same rank is shared only when all are equal.',
};
const EXCLUSIONS = (v, subject) => [
  'Practice, imported and self-reported results never count in official rankings.',
  'Youth accounts, accounts not approved, and results that are rejected, disputed or superseded are excluded.',
  'Duplicate results count once. Games between teams of the same owner are excluded.',
  subject === 'team' && !v.scope?.format ? 'Friendly events are excluded unless the ranking’s format is friendly.' : null,
  v.window_days || v.window_games ? 'Only results inside the stated window count.' : null,
].filter(Boolean).join(' ');

const visible = async (user, def) => def && def.visibility === 'public' ? def : def && (await isClubMember(user, def)) ? def : null;

const readDef = async (user, defId) => {
  const def = await visible(user, await loadDefinition(defId));
  if (!def) throw notFound('Ranking');
  return def;
};

const unitOf = async (def, v) => (v.formula_kind === 'rating' ? 'level' : v.metric ? (await resolveRule({ id: def.sport_id, scoring: (await one('SELECT scoring FROM sports WHERE id=$1', [def.sport_id])).scoring }, v.metric)).unit : null);

const publicVersion = (v) => v && ({
  version: v.version, formula_kind: v.formula_kind, metric: v.metric, aggregation: v.aggregation, direction: v.direction, evidence: v.evidence,
  min_samples: v.min_samples, min_distinct_events: v.min_distinct_events, window_days: v.window_days, window_games: v.window_games, scope: v.scope,
  tie_rules: v.tie_rules, exclusions: v.exclusions, formula_hash: v.formula_hash, note: v.note, published_at: v.created_at,
});

cap({
  name: 'list_ranking_definitions', method: 'GET', path: '/rankings', tag: TAG, auth: 'public',
  summary: 'The published rankings: sport, player or team, scope, formula and minimum sample. Public rankings use approved competition results only. Club rankings are listed only to members of that club. can_define tells the caller whether they may publish one; families lists the native model per kind of sport (and which sports use a labelled fallback).',
  input: z.object({ sport: z.string().optional(), subject: z.enum(['player', 'team']).optional(), include_retired: z.coerce.boolean().default(false), ...page }),
  async handler({ user }, i) {
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    if (i.sport && !sport) throw notFound('Sport');
    const rows = await many(
      `SELECT d.*, s.slug AS sport_slug, s.name AS sport_name, s.emoji AS sport_emoji, v.formula_kind, v.metric, v.direction, v.min_samples, v.min_distinct_events, v.scope, v.window_days, v.window_games, v.evidence, v.formula_hash
         FROM ranking_definitions d JOIN sports s ON s.id=d.sport_id LEFT JOIN ranking_definition_versions v ON v.definition_id=d.id AND v.version=d.current_version
        WHERE d.current_version > 0 AND ($1::uuid IS NULL OR d.sport_id=$1) AND ($2::text IS NULL OR d.subject=$2) AND ($3 OR d.status='published')
          AND (d.visibility='public' OR EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id=d.scope_team_id AND tm.user_id=$4 AND tm.status='active'))
        ORDER BY s.name, d.subject, d.name LIMIT $5 OFFSET $6`, [sport?.id ?? null, i.subject ?? null, i.include_retired, user?.id ?? null, i.limit, i.offset]);
    // the choices a definition form offers come from real data: positions people list for this sport and cities where it was played
    const info = sport ? {
      family: familyOf(sport), ...FAMILIES[familyOf(sport)], can_define: await canGovern(user, sport.id),
      metrics: (await many("SELECT DISTINCT trim(both '_' from regexp_replace(lower(metric), '[^a-z0-9]+', '_', 'g')) AS metric FROM performances WHERE sport_id=$1 AND provenance='approved_competition' AND status='approved' ORDER BY 1 LIMIT 60", [sport.id])).map((r) => r.metric),
      positions: (await many('SELECT DISTINCT x AS position FROM active_sport_profiles sp, unnest(sp.positions) x WHERE sp.sport_id=$1 ORDER BY 1 LIMIT 40', [sport.id])).map((r) => r.position),
      cities: (await many('SELECT DISTINCT city FROM events WHERE sport_id=$1 AND city IS NOT NULL ORDER BY 1 LIMIT 40', [sport.id])).map((r) => r.city),
    } : null;
    return { sport: sport ? { slug: sport.slug, name: sport.name } : null, sport_model: info, definitions: rows };
  },
});

cap({
  name: 'get_ranking', method: 'GET', path: '/rankings/:id', tag: TAG, auth: 'public',
  summary: 'A ranking table. Always states its scope, formula, version, minimum sample, tie rules, exclusions and when it was produced; every row shows how many verified results it rests on. Pass snapshot_id to re-open an earlier published snapshot exactly as it was issued. Without it the table is computed now from the stored results, so a corrected result changes it deterministically.',
  input: z.object({ id, snapshot_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const def = await readDef(user, i.id);
    if (i.snapshot_id) {
      const snap = await one('SELECT * FROM ranking_snapshots WHERE id=$1 AND definition_id=$2', [i.snapshot_id, def.id]);
      if (!snap) throw notFound('Snapshot');
      const v = (await one('SELECT * FROM ranking_definition_versions WHERE id=$1', [snap.version_id]));
      const rows = await many('SELECT * FROM ranking_snapshot_entries WHERE snapshot_id=$1 ORDER BY rank, subject_id LIMIT $2 OFFSET $3', [snap.id, i.limit, i.offset]);
      const subs = await subjectsOf(def, rows.map((r) => r.subject_id));
      const unit = await unitOf(def, v);
      return { definition: pub(def), version: publicVersion(v), unit, formula: describeFormula(v, { unit }), source: 'snapshot', as_of: snap.as_of, snapshot_id: snap.id, snapshot_reason: snap.reason, total: snap.entries_n,
        entries: rows.map((r) => ({ rank: r.rank, score: Number(r.score), sample_n: r.sample_n, events_n: r.events_n, evidence_strength: strengthOf(r.sample_n, v.min_samples), subject: subs.get(r.subject_id) ?? null })) };
    }
    if (!def.current_version) throw notFound('Ranking');
    const v = await loadVersion(def.id, def.current_version);
    const asOf = new Date();
    const res = await runRanking(def, v, { asOf });
    const slice = res.entries.slice(i.offset, i.offset + i.limit);
    const subs = await subjectsOf(def, slice.map((e) => e.subject));
    const unit = await unitOf(def, v);
    return { definition: pub(def), version: publicVersion(v), unit, formula: describeFormula(v, { unit }), source: 'live', as_of: asOf.toISOString(), total: res.entries.length, not_yet_eligible: res.ineligible.length,
      entries: slice.map((e) => ({ rank: e.rank, score: e.score, ...(e.gd_per_game !== undefined ? { goal_difference_per_game: e.gd_per_game } : {}), sample_n: e.sample_n, events_n: e.events_n, evidence_strength: strengthOf(e.sample_n, v.min_samples), subject: subs.get(e.subject) ?? null })) };
  },
});
const pub = (d) => ({ id: d.id, name: d.name, subject: d.subject, family: d.family, family_label: FAMILIES[d.family]?.label, native_model: FAMILIES[d.family]?.native ?? false, visibility: d.visibility, status: d.status, sport_id: d.sport_id, current_version: d.current_version });

cap({
  name: 'get_ranking_history', method: 'GET', path: '/rankings/:id/subjects/:subject_id/history', tag: TAG, auth: 'public',
  summary: 'Where one player or team stood in each published snapshot of a ranking (newest first), with the version it was issued under. Snapshots are never rewritten, so last week’s rank stays what it was even after a formula change.',
  input: z.object({ id, subject_id: id, ...page }),
  async handler({ user }, i) {
    const def = await readDef(user, i.id);
    const rows = await many(
      `SELECT s.id AS snapshot_id, s.as_of, s.reason, s.version_id, v.version, e.rank, e.score, e.sample_n, e.events_n
         FROM ranking_snapshot_entries e JOIN ranking_snapshots s ON s.id=e.snapshot_id JOIN ranking_definition_versions v ON v.id=s.version_id
        WHERE s.definition_id=$1 AND e.subject_id=$2 ORDER BY s.as_of DESC, s.created_at DESC LIMIT $3 OFFSET $4`, [def.id, i.subject_id, i.limit, i.offset]);
    return { ranking: pub(def), history: rows.map((r) => ({ ...r, score: Number(r.score) })) };
  },
});

cap({
  name: 'why_this_rank', method: 'GET', path: '/rankings/:id/subjects/:subject_id/why', tag: TAG, auth: 'public',
  summary: '"Why am I here?" — the eligible results behind a rank, the formula and weighting, the exclusions and the data limits. Anyone can read it for a ranked player or team in a public ranking; a person who is not yet ranked (too few results) can see their own reasons only. Everything shown is already in the public ranking evidence; practice and youth data never appear.',
  input: z.object({ id, subject_id: id }),
  async handler({ user }, i) {
    const def = await readDef(user, i.id);
    if (!def.current_version) throw notFound('Ranking');
    const v = await loadVersion(def.id, def.current_version);
    const res = await runRanking(def, v, {});
    const self = def.subject === 'player' ? user?.id === i.subject_id : !!user && !!(await one("SELECT 1 AS ok FROM team_members WHERE team_id=$1 AND user_id=$2 AND status='active'", [i.subject_id, user.id]));
    const ranked = res.entries.some((e) => e.subject === i.subject_id);
    if (!ranked && !self) throw notFound('Ranking entry');
    const out = await explain(def, v, res, i.subject_id, { unit: await unitOf(def, v), full: self });
    if (!out) throw notFound('Ranking entry');
    return { ranking: pub(def), version: v.version, formula_hash: v.formula_hash, as_of: new Date().toISOString(), ...out };
  },
});

cap({
  name: 'publish_ranking_version', method: 'POST', path: '/rankings', tag: TAG, status: 201,
  summary: 'Define a ranking or publish its next version. Public rankings need a platform admin or an appointed rules governor for the sport; club rankings need a manager of that team. Direction comes from the governed metric, never from the caller, so cohorts stay comparable; the formula must be one the sport’s family supports. Public rankings require at least 3 results across at least 2 events unless scoped to a single event. Send expected_version (0 for new) and client_key to retry safely. Versions are immutable.',
  input: z.object({
    definition_id: id.optional(), sport: z.string(), subject: z.enum(['player', 'team']), name: z.string().min(2).max(80), expected_version: z.number().int().min(0),
    formula_kind: z.enum(['metric', 'per_90', 'per_match', 'team_form', 'rating']), metric: z.string().min(1).max(40).optional(), aggregation: z.enum(['best', 'sum', 'mean', 'last']).default('best'),
    evidence: z.enum(['official', 'development']).default('official'), visibility: z.enum(['public', 'club']).default('public'), scope_team_id: id.optional(),
    min_samples: z.number().int().min(1).max(500), min_distinct_events: z.number().int().min(1).max(100).default(2),
    window_days: z.number().int().min(1).max(3660).optional(), window_games: z.number().int().min(1).max(200).optional(),
    scope: scopeShape.default({}), note: z.string().max(300).optional(), client_key: z.string().min(8).max(80).optional(),
  }),
  async handler({ user }, i) {
    const sport = await sportBySlugOrId(i.sport);
    if (!sport) throw notFound('Sport');
    const family = i.subject === 'team' ? 'team_form' : familyOf(sport);
    if (!kindsFor(family).includes(i.formula_kind)) throw unprocessable(`${FAMILIES[family].label} supports: ${kindsFor(family).join(', ')}`);
    if (i.formula_kind === 'rating' && i.subject !== 'player') throw unprocessable('A skill level ranks players');
    if (['team_form', 'rating'].includes(i.formula_kind) ? !!i.metric : !i.metric) throw unprocessable(i.formula_kind === 'team_form' ? 'This formula does not use a metric' : 'Choose the metric to rank');
    if (i.formula_kind === 'team_form' && (i.window_days)) throw unprocessable('Team form uses a number of games, not days');
    if (i.formula_kind !== 'team_form' && i.window_games) throw unprocessable('Player rankings use a window in days');
    if (i.subject === 'team' && i.scope.position) throw unprocessable('Position applies to player rankings only');
    if (i.visibility === 'club' ? !i.scope_team_id || i.subject !== 'player' : !!i.scope_team_id) throw unprocessable('A club ranking is a player ranking for one team; public rankings have no team scope');
    if (i.evidence === 'development' && i.visibility !== 'club') throw unprocessable('Practice and imported data can power club development rankings only; public rankings use approved competition results');
    if (i.formula_kind !== 'rating' && i.visibility === 'public' && !i.scope.event_id && (i.min_samples < 3 || i.min_distinct_events < 2)) throw unprocessable('A public ranking needs at least 3 results across at least 2 events, unless it is scoped to one event');
    if (i.scope.event_id && !(await one('SELECT 1 AS ok FROM events WHERE id=$1 AND sport_id=$2', [i.scope.event_id, sport.id]))) throw unprocessable('That event is not in this sport');
    let direction = 'higher', unit = null;
    if (i.formula_kind === 'rating') { unit = 'level'; if (i.evidence !== 'official') throw unprocessable('A skill level is built from approved competition results only'); }
    else if (i.formula_kind !== 'team_form') {
      const rule = await resolveRule(sport, i.metric);
      unit = rule.unit; direction = rule.direction;
      if (i.formula_kind !== 'metric' && (rule.unit !== 'count')) throw unprocessable('Rates (per match, per 90) apply to counted metrics, not times or distances');
      if (i.formula_kind === 'metric' && i.aggregation === 'sum' && rule.unit !== 'count') throw unprocessable('A total only makes sense for counted metrics; use best, average or latest for times and distances');
    }
    return tx(async (c) => {
      if (i.visibility === 'club') {
        const team = (await c.query('SELECT * FROM teams WHERE id=$1 AND sport_id=$2', [i.scope_team_id, sport.id])).rows[0];
        if (!team) throw notFound('Team');
        if (!(await canManageTeam(user, team))) throw forbidden('Only a manager of this team can define its internal rankings');
      } else if (!(await canGovern(user, sport.id, c))) throw forbidden('Only platform admins or appointed rule governors can define public rankings');
      let def;
      if (i.definition_id) {
        def = (await c.query('SELECT * FROM ranking_definitions WHERE id=$1 FOR UPDATE', [i.definition_id])).rows[0];
        if (!def || def.sport_id !== sport.id || def.subject !== i.subject || def.visibility !== i.visibility || def.scope_team_id !== (i.scope_team_id ?? null)) throw notFound('Ranking');
      } else {
        if (i.client_key) {
          const dup = (await c.query('SELECT d.* FROM ranking_definitions d JOIN ranking_definition_versions v ON v.definition_id=d.id WHERE v.client_key=$1 AND v.created_by=$2 LIMIT 1', [i.client_key, user.id])).rows[0];
          if (dup) return { definition: pub(dup), version: publicVersion(await loadVersion(dup.id, dup.current_version, c)), replayed: true };
        }
        def = (await c.query('INSERT INTO ranking_definitions(sport_id, subject, name, family, visibility, scope_team_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
          [sport.id, i.subject, i.name, family, i.visibility, i.scope_team_id ?? null, user.id])).rows[0];
      }
      if (i.client_key && i.definition_id) {
        const dup = (await c.query('SELECT * FROM ranking_definition_versions WHERE definition_id=$1 AND client_key=$2', [def.id, i.client_key])).rows[0];
        if (dup) return { definition: pub(def), version: publicVersion(dup), replayed: true };
      }
      if (def.current_version !== i.expected_version) throw conflict(`This ranking is now at version ${def.current_version}; you edited version ${i.expected_version}. Reload and re-apply your change.`, { current_version: def.current_version });
      const v = { formula_kind: i.formula_kind, metric: i.formula_kind === 'rating' ? 'skill_level' : i.metric ? metricKey(i.metric) : null, aggregation: i.formula_kind === 'metric' ? i.aggregation : (i.formula_kind === 'rating' ? 'last' : 'sum'),
        direction, evidence: i.evidence, min_samples: i.formula_kind === 'rating' ? 1 : i.min_samples, min_distinct_events: i.formula_kind === 'rating' ? 1 : i.min_distinct_events, window_days: i.window_days ?? null, window_games: i.window_games ?? null, scope: i.scope };
      const hash = createHash('sha256').update(JSON.stringify(v)).digest('hex');
      const prev = def.current_version ? await loadVersion(def.id, def.current_version, c) : null;
      if (prev && prev.formula_hash === hash && def.status === 'published') throw unprocessable('Nothing changed from the current version');
      const row = (await c.query(
        `INSERT INTO ranking_definition_versions(definition_id, version, formula_kind, metric, aggregation, direction, evidence, min_samples, min_distinct_events, window_days, window_games, scope, tie_rules, exclusions, formula_hash, note, client_key, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
        [def.id, def.current_version + 1, v.formula_kind, v.metric, v.aggregation, v.direction, v.evidence, v.min_samples, v.min_distinct_events, v.window_days, v.window_games, JSON.stringify(v.scope),
          i.formula_kind === 'team_form' ? TIE_RULES.team_form : TIE_RULES.metric, EXCLUSIONS(v, i.subject), hash, i.note ?? null, i.client_key ?? null, user.id])).rows[0];
      def = (await c.query("UPDATE ranking_definitions SET current_version=$2, name=$3, status='published', retired_at=NULL WHERE id=$1 RETURNING *", [def.id, row.version, i.name])).rows[0];
      await audit(c, user.id, 'publish_ranking_version', 'ranking_definitions', def.id);
      return { definition: pub(def), version: publicVersion(row), unit, formula: describeFormula(row, { unit }) };
    });
  },
});

cap({
  name: 'set_ranking_status', method: 'POST', path: '/rankings/:id/status', tag: TAG,
  summary: 'Retire a ranking (it stops appearing and stops snapshotting; every version and snapshot is kept) or bring it back. Same permission as defining it.',
  input: z.object({ id, retired: z.boolean() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const def = (await c.query('SELECT * FROM ranking_definitions WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!def) throw notFound('Ranking');
      await assertManage(user, def, c);
      await audit(c, user.id, i.retired ? 'retire_ranking' : 'restore_ranking', 'ranking_definitions', def.id);
      return pub((await c.query("UPDATE ranking_definitions SET status=$2, retired_at=CASE WHEN $2='retired' THEN now() END WHERE id=$1 RETURNING *", [def.id, i.retired ? 'retired' : 'published'])).rows[0]);
    });
  },
});

async function assertManage(user, def, c) {
  if (def.visibility === 'club') {
    const team = (await c.query('SELECT * FROM teams WHERE id=$1', [def.scope_team_id])).rows[0];
    if (!(await canManageTeam(user, team))) throw notFound('Ranking');
  } else if (!(await canGovern(user, def.sport_id, c))) throw notFound('Ranking');
}

cap({
  name: 'snapshot_ranking', method: 'POST', path: '/rankings/:id/snapshot', tag: TAG,
  summary: 'Publish a snapshot of the ranking now (the worker also does this weekly and after a result is corrected). A rerun on identical results and version adds nothing. Integrity flags found while computing are recorded for review.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const def = await loadDefinition(i.id);
    if (!def || !def.current_version) throw notFound('Ranking');
    await assertManage(user, def, { query: (s, a) => one(s, a).then((r) => ({ rows: r ? [r] : [] })) });
    const snap = await takeSnapshot(def, await loadVersion(def.id, def.current_version), 'manual');
    return { snapshot: snap, unchanged: !snap };
  },
});

cap({
  name: 'list_ranking_flags', method: 'GET', path: '/rankings/:id/flags', tag: TAG,
  summary: 'Integrity flags raised on a ranking (duplicate evidence, rapid activity, self-generated fixtures). They ask a person to look; they never accuse anyone or remove anyone from the ranking by themselves. Governors and club managers only.',
  input: z.object({ id, status: z.enum(['open', 'confirmed', 'dismissed']).optional(), ...page }),
  async handler({ user }, i) {
    const def = await loadDefinition(i.id);
    if (!def) throw notFound('Ranking');
    await assertManage(user, def, { query: (s, a) => one(s, a).then((r) => ({ rows: r ? [r] : [] })) });
    return many('SELECT * FROM ranking_flags WHERE definition_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC, id LIMIT $3 OFFSET $4', [def.id, i.status ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'review_ranking_flag', method: 'POST', path: '/ranking-flags/:id/review', tag: TAG,
  summary: 'Record the outcome of looking at a flag: dismissed (nothing wrong) or confirmed (a real issue — fix the underlying result through the normal correction flow). The flag is kept either way.',
  input: z.object({ id, status: z.enum(['confirmed', 'dismissed']), note: z.string().min(2).max(300) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const f = (await c.query('SELECT * FROM ranking_flags WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!f) throw notFound('Flag');
      await assertManage(user, (await c.query('SELECT * FROM ranking_definitions WHERE id=$1', [f.definition_id])).rows[0], c);
      if (f.status !== 'open') throw conflict('This flag has already been reviewed');
      await audit(c, user.id, 'review_ranking_flag', 'ranking_flags', f.id);
      return (await c.query('UPDATE ranking_flags SET status=$2, review_note=$3, reviewed_by=$4, reviewed_at=now() WHERE id=$1 RETURNING *', [f.id, i.status, i.note, user.id])).rows[0];
    });
  },
});

cap({
  name: 'get_subject_rankings', method: 'GET', path: '/rankings/subjects/:subject_id', tag: TAG, auth: 'public',
  summary: 'Where a player or team stands in the public rankings (latest published snapshot of each), always with the version, how many verified results the rank rests on and an evidence-strength label, so a rank is never shown without its provenance. Optional sport filter. Youth accounts return nothing. Club rankings never appear here. Used by discovery and recruiter views.',
  input: z.object({ subject_id: id, sport: z.string().optional() }),
  async handler(_, i) {
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    if (i.sport && !sport) throw notFound('Sport');
    const youth = await one('SELECT 1 AS y FROM users u WHERE u.id=$1 AND u.youth_until IS NOT NULL AND u.youth_until > current_date', [i.subject_id]);
    return { subject_id: i.subject_id, rankings: youth ? [] : await publicRankingsOf(i.subject_id, sport?.id) };
  },
});
