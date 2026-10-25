// Governed sport metrics and match-format rulesets (#320): versioned, immutable definitions that results are scored under.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { audit, isAdmin, mustFind, sportBySlugOrId } from '../helpers.js';
import { rulesetSchema, builtinRuleset } from '../scoring/rulesets.js';
import { AGGREGATIONS, metricKey, rulesetHash, versionHash, standardOf, differsFromStandard } from '../scoring/metric-defs.js';

const TAG = 'Metric governance';
const EVIDENCE = ['self_reported', 'imported'];
const FIELDS = ['unit', 'direction', 'aggregation', 'value_kind', 'min_value', 'max_value', 'points_mode', 'points_value', 'evidence_required_for'];

/** Platform admins, or people an admin appointed for this sport (or all sports). */
export async function canGovern(user, sportId, c) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  const q = c ? (s, a) => c.query(s, a) : (s, a) => one(s, a).then((r) => ({ rows: r ? [r] : [] }));
  return !!(await q('SELECT 1 AS ok FROM metric_governors WHERE user_id=$1 AND revoked_at IS NULL AND (sport_id IS NULL OR sport_id=$2) LIMIT 1', [user.id, sportId])).rows[0];
}
const needGovern = async (user, sportId, c) => { if (!(await canGovern(user, sportId, c))) throw forbidden('Only platform admins or appointed rule governors can change sport rules'); };

const changesBetween = (prev, v) => FIELDS.filter((f) => JSON.stringify(Array.isArray(v[f]) ? [...v[f]].sort() : String(v[f])) !== JSON.stringify(prev ? (Array.isArray(prev[f]) ? [...prev[f]].sort() : String(prev[f])) : null))
  .map((f) => ({ field: f, from: prev?.[f] ?? null, to: v[f] }));

cap({
  name: 'list_metric_definitions', method: 'GET', path: '/metric-definitions', tag: TAG, auth: 'public',
  summary: 'The governed metrics of a sport with their current version: unit, ranking direction, aggregation, valid range, points rule and which evidence practice claims need. Retired metrics are hidden unless include_retired. can_govern tells the caller whether they may publish new versions.',
  input: z.object({ sport: z.string(), include_retired: z.coerce.boolean().default(false), ...page }),
  async handler({ user }, i) {
    const sport = await sportBySlugOrId(i.sport);
    if (!sport) throw notFound('Sport');
    const rows = await many(
      `SELECT d.id, d.key, d.label, d.status, d.current_version, d.created_at, v.id AS version_id, v.unit, v.direction, v.aggregation, v.value_kind, v.min_value, v.max_value,
              v.points_mode, v.points_value, v.rankable_provenance, v.evidence_required_for, v.effective_from
         FROM metric_definitions d LEFT JOIN metric_definition_versions v ON v.definition_id=d.id AND v.version=d.current_version
        WHERE d.sport_id=$1 AND ($2 OR d.status='published') ORDER BY d.key LIMIT $3 OFFSET $4`, [sport.id, i.include_retired, i.limit, i.offset]);
    const withStd = rows.map((m) => { const standard = standardOf(sport, m.key); return { ...m, standard, differs_from_standard: m.version_id ? differsFromStandard(m, standard) : [] }; });
    return { sport: sport.slug, can_govern: await canGovern(user, sport.id), metrics: withStd };
  },
});

cap({
  name: 'get_metric_definition', method: 'GET', path: '/metric-definitions/:id', tag: TAG, auth: 'public',
  summary: 'One metric with every version ever published (newest first), what changed in each, and how many stored results were scored under each. Old versions are never removed. Pass as_of to see the version that was in force at a moment.',
  input: z.object({ id, as_of: z.string().datetime().optional() }),
  async handler(_, i) {
    const d = await mustFind('metric_definitions', i.id);
    const sportRow = await mustFind('sports', d.sport_id);
    const vs = await many('SELECT v.*, u.display_name AS published_by, (SELECT count(*)::int FROM performances p WHERE p.metric_version_id=v.id) AS results FROM metric_definition_versions v LEFT JOIN users u ON u.id=v.created_by WHERE v.definition_id=$1 ORDER BY v.version', [d.id]);
    const standard = standardOf(sportRow, d.key);
    const withChanges = vs.map((v, k) => ({ ...v, changes: changesBetween(vs[k - 1], v), differs_from_standard: differsFromStandard(v, standard) })).reverse();
    const inForce = i.as_of ? ([...vs].reverse().find((v) => new Date(v.effective_from) <= new Date(i.as_of)) ?? null) : null;
    return { ...d, standard, versions: withChanges, ...(i.as_of ? { as_of: i.as_of, version_in_force: inForce } : {}) };
  },
});

cap({
  name: 'publish_metric_version', method: 'POST', path: '/metric-definitions', tag: TAG, status: 201,
  summary: 'Create a governed metric, or publish its next version (platform admin or appointed governor). Send expected_version = the version you edited (0 for a new metric); if someone published in between you get 409 and nothing changes. Versions are immutable and apply to results recorded afterwards — stored results are never re-scored. Send client_key to retry safely.',
  input: z.object({
    sport: z.string(), metric: z.string().min(1).max(40), label: z.string().min(1).max(60).optional(), expected_version: z.number().int().min(0),
    unit: z.string().min(1).max(12), direction: z.enum(['higher', 'lower']), aggregation: z.enum(AGGREGATIONS), value_kind: z.enum(['integer', 'decimal']),
    min_value: z.number(), max_value: z.number(), points_mode: z.enum(['flat', 'per_unit']), points_value: z.number().min(0).max(1000),
    evidence_required_for: z.array(z.enum(EVIDENCE)).default(['imported']), note: z.string().max(300).optional(), client_key: z.string().min(8).max(80).optional(),
    reset_to_standard: z.boolean().default(false).describe('publish a new version equal to the platform standard rule (history is kept)'),
  }),
  async handler({ user }, i) {
    const sport = await sportBySlugOrId(i.sport);
    if (!sport) throw notFound('Sport');
    const key = metricKey(i.metric);
    if (!key) throw unprocessable('Give the metric a name');
    const std = standardOf(sport, key);
    if (i.reset_to_standard) i = { ...i, ...std, note: i.note ?? 'Reset to the platform standard' };
    if (!(i.min_value < i.max_value)) throw unprocessable('The minimum must be lower than the maximum');
    if (i.value_kind === 'integer' && (!Number.isInteger(i.min_value) || !Number.isInteger(i.max_value))) throw unprocessable('A whole-number metric needs a whole-number range');
    return tx(async (c) => {
      await needGovern(user, sport.id, c);
      const diverges = differsFromStandard(i, std);
      if (diverges.length && !i.note?.trim()) throw unprocessable(`This differs from the standard rule (${diverges.map((f) => f.replace(/_/g, ' ')).join(', ')}). Say why in the note.`, { differs_from_standard: diverges });
      await c.query('INSERT INTO metric_definitions(sport_id, key, label, created_by) VALUES ($1,$2,$3,$4) ON CONFLICT (sport_id, key) DO NOTHING', [sport.id, key, i.label ?? i.metric.trim(), user.id]);
      const d = (await c.query('SELECT * FROM metric_definitions WHERE sport_id=$1 AND key=$2 FOR UPDATE', [sport.id, key])).rows[0];
      if (i.client_key) {
        const dup = (await c.query('SELECT * FROM metric_definition_versions WHERE definition_id=$1 AND client_key=$2', [d.id, i.client_key])).rows[0];
        if (dup) return { definition: d, version: dup, replayed: true };
      }
      if (d.current_version !== i.expected_version) throw conflict(`This metric is now at version ${d.current_version}; you edited version ${i.expected_version}. Reload and re-apply your change.`, { current_version: d.current_version });
      const v = { ...i, rankable_provenance: ['approved_competition'] };
      const prev = d.current_version ? (await c.query('SELECT * FROM metric_definition_versions WHERE definition_id=$1 AND version=$2', [d.id, d.current_version])).rows[0] : null;
      const hash = versionHash(v);
      if (prev && prev.hash === hash && d.status === 'published') throw unprocessable('Nothing changed from the current version');
      const row = (await c.query(
        `INSERT INTO metric_definition_versions(definition_id, version, unit, direction, aggregation, value_kind, min_value, max_value, points_mode, points_value, evidence_required_for, note, hash, client_key, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [d.id, d.current_version + 1, i.unit, i.direction, i.aggregation, i.value_kind, i.min_value, i.max_value, i.points_mode, i.points_value, i.evidence_required_for, i.note ?? null, hash, i.client_key ?? null, user.id])).rows[0];
      const def = (await c.query("UPDATE metric_definitions SET current_version=$2, status='published', retired_at=NULL, label=coalesce($3,label) WHERE id=$1 RETURNING *", [d.id, row.version, i.label ?? null])).rows[0];
      await audit(c, user.id, 'publish_metric_version', 'metric_definitions', d.id);
      return { definition: def, version: row, changes: changesBetween(prev, row) };
    });
  },
});

cap({
  name: 'set_metric_status', method: 'POST', path: '/metric-definitions/:id/status', tag: TAG,
  summary: 'Retire a metric (stops new results being recorded against the governed rule; history and old versions stay) or bring it back. Platform admin or appointed governor.',
  input: z.object({ id, retired: z.boolean() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const d = (await c.query('SELECT * FROM metric_definitions WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!d) throw notFound('Metric');
      await needGovern(user, d.sport_id, c);
      await audit(c, user.id, i.retired ? 'retire_metric' : 'restore_metric', 'metric_definitions', d.id);
      return (await c.query('UPDATE metric_definitions SET status=$2, retired_at=CASE WHEN $2=\'retired\' THEN now() END WHERE id=$1 RETURNING *', [d.id, i.retired ? 'retired' : 'published'])).rows[0];
    });
  },
});

cap({
  name: 'preview_metric_impact', method: 'GET', path: '/metric-definitions/:id/impact', tag: TAG,
  summary: 'Before publishing: how many stored results exist for this metric and how many sit outside a proposed range. Nothing is re-scored either way — a new version only applies to results recorded afterwards.',
  input: z.object({ id, min_value: z.coerce.number().optional(), max_value: z.coerce.number().optional() }),
  async handler({ user }, i) {
    const d = await mustFind('metric_definitions', i.id);
    await needGovern(user, d.sport_id);
    const r = await one(
      `SELECT count(*)::int AS stored_results, count(*) FILTER (WHERE status='approved' AND provenance='approved_competition')::int AS official_results,
              count(*) FILTER (WHERE ($2::numeric IS NOT NULL AND value < $2) OR ($3::numeric IS NOT NULL AND value > $3))::int AS outside_proposed_range
         FROM performances WHERE sport_id=$1 AND trim(both '_' from regexp_replace(lower(metric), '[^a-z0-9]+', '_', 'g'))=$4`, [d.sport_id, i.min_value ?? null, i.max_value ?? null, d.key]);
    return { ...r, rescored: 0, note: 'Stored results keep the version they were scored under.' };
  },
});

// ------------------------------------------------------------------ match formats / scoring rulesets
cap({
  name: 'list_ruleset_versions', method: 'GET', path: '/ruleset-versions', tag: TAG, auth: 'public',
  summary: 'Governed match formats and scoring rulesets for a sport, every version kept. format_key "default" is applied to the sport’s games automatically (a game pins the version when it starts); other formats (best_of_5, t20 …) can be picked for an event.',
  input: z.object({ sport: z.string(), format_key: z.string().optional(), ...page }),
  async handler({ user }, i) {
    const sport = await sportBySlugOrId(i.sport);
    if (!sport) throw notFound('Sport');
    const rows = await many('SELECT id, format_key, version, label, ruleset, ruleset_hash, note, created_at FROM ruleset_versions WHERE sport_id=$1 AND ($2::text IS NULL OR format_key=$2) ORDER BY format_key, version DESC LIMIT $3 OFFSET $4', [sport.id, i.format_key ?? null, i.limit, i.offset]);
    return { sport: sport.slug, can_govern: await canGovern(user, sport.id), versions: rows, starting_point: builtinRuleset(sport), standard: builtinRuleset(sport) };
  },
});

cap({
  name: 'publish_ruleset_version', method: 'POST', path: '/ruleset-versions', tag: TAG, status: 201,
  summary: 'Publish the next version of a sport’s match format / scoring ruleset (platform admin or appointed governor). Games already started keep the version they started with. expected_version guards against two people publishing at once (0 for a new format); client_key retries safely.',
  input: z.object({ sport: z.string(), format_key: z.string().regex(/^[a-z0-9][a-z0-9_]{0,39}$/).default('default'), label: z.string().min(2).max(60).optional(), expected_version: z.number().int().min(0), ruleset: rulesetSchema.optional(), reset_to_standard: z.boolean().default(false).describe('publish the platform standard ruleset as the new version'), note: z.string().max(300).optional(), client_key: z.string().min(8).max(80).optional() })
    .refine((v) => !!v.ruleset !== v.reset_to_standard, 'Send either a ruleset or reset_to_standard'),
  async handler({ user }, i) {
    const sport = await sportBySlugOrId(i.sport);
    if (!sport) throw notFound('Sport');
    const standard = builtinRuleset(sport);
    if (i.reset_to_standard) i = { ...i, ruleset: standard, note: i.note ?? 'Reset to the platform standard' };
    return tx(async (c) => {
      await needGovern(user, sport.id, c);
      if (rulesetHash(i.ruleset) !== rulesetHash(standard) && !i.note?.trim()) throw unprocessable('This differs from the standard rules. Say why in the note.', { differs_from_standard: true });
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ruleset:${sport.id}:${i.format_key}`]);
      if (i.client_key) {
        const dup = (await c.query('SELECT * FROM ruleset_versions WHERE sport_id=$1 AND format_key=$2 AND client_key=$3', [sport.id, i.format_key, i.client_key])).rows[0];
        if (dup) return { ...dup, replayed: true };
      }
      const cur = (await c.query('SELECT * FROM ruleset_versions WHERE sport_id=$1 AND format_key=$2 ORDER BY version DESC LIMIT 1', [sport.id, i.format_key])).rows[0];
      const curV = cur?.version ?? 0;
      if (curV !== i.expected_version) throw conflict(`This format is now at version ${curV}; you edited version ${i.expected_version}. Reload and re-apply your change.`, { current_version: curV });
      const hash = rulesetHash(i.ruleset);
      if (cur?.ruleset_hash === hash) throw unprocessable('Nothing changed from the current version');
      const row = (await c.query('INSERT INTO ruleset_versions(sport_id, format_key, version, label, ruleset, ruleset_hash, note, client_key, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
        [sport.id, i.format_key, curV + 1, i.label ?? i.ruleset.label, JSON.stringify(i.ruleset), hash, i.note ?? null, i.client_key ?? null, user.id])).rows[0];
      await audit(c, user.id, 'publish_ruleset_version', 'ruleset_versions', row.id);
      return row;
    });
  },
});

cap({
  name: 'set_metric_governor', method: 'POST', path: '/metric-governors', tag: TAG,
  summary: 'Platform admin appoints (or revokes) someone to govern the rules of one sport, or of all sports when sport is omitted. Revoking keeps the record.',
  input: z.object({ user_id: id, sport: z.string().optional(), active: z.boolean() }),
  async handler({ user }, i) {
    if (!isAdmin(user)) throw forbidden('Only platform admins appoint rule governors');
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    if (i.sport && !sport) throw notFound('Sport');
    await mustFind('users', i.user_id, 'id');
    return tx(async (c) => {
      const act = (await c.query("SELECT id FROM metric_governors WHERE user_id=$1 AND coalesce(sport_id,'00000000-0000-0000-0000-000000000000')=coalesce($2::uuid,'00000000-0000-0000-0000-000000000000') AND revoked_at IS NULL FOR UPDATE", [i.user_id, sport?.id ?? null])).rows[0];
      await audit(c, user.id, i.active ? 'appoint_metric_governor' : 'revoke_metric_governor', 'users', i.user_id);
      if (i.active) return act ? (await c.query('SELECT * FROM metric_governors WHERE id=$1', [act.id])).rows[0] : (await c.query('INSERT INTO metric_governors(user_id, sport_id, granted_by) VALUES ($1,$2,$3) RETURNING *', [i.user_id, sport?.id ?? null, user.id])).rows[0];
      if (!act) throw notFound('Active appointment');
      return (await c.query('UPDATE metric_governors SET revoked_at=now() WHERE id=$1 RETURNING *', [act.id])).rows[0];
    });
  },
});
