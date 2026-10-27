// Beneficiary performance and community impact (#303): the pieces shared by the agreement view, the export and the pre-award evidence read.
// Nothing here writes to payments, obligations or agreement status: impact is a review aid, never a payment condition.
import { conflict, forbidden } from './errors.js';
import { guardianLink } from './youth.js';
import { liveAuthority } from './youth-sponsorship.js';

export const RUNNING = ['active', 'paused', 'ended', 'term_expired', 'completed'];
export const SOURCE_LABELS = { platform_records: 'Platform game and entry records', organiser_record: 'Organiser record', third_party: 'Third-party record', self_reported: 'Self-reported' };
/** Which stored sources a sponsor may see: `official` shares organiser records only, `all_evidence` also third-party and self-reported figures (always labelled). */
export const sourcesFor = (ctx) => (ctx.role === 'sponsor' && ctx.d.performance_scope === 'official' ? ['organiser_record'] : ['organiser_record', 'third_party', 'self_reported']);

/**
 * The one gate for a sponsor reading anything about the beneficiary's performance or impact: brand permission, a running agreement, the
 * beneficiary's live switch, and for a young athlete a guardian whose authority is still in force. Re-read on every call, so revoking blocks the next read and export.
 */
export async function assertSponsorMayRead(c, ctx, what = 'read the beneficiary\'s results') {
  if (ctx.role !== 'sponsor') return;
  ctx.need('performance', what);
  if (!RUNNING.includes(ctx.d.status)) throw conflict('Results are available once the agreement has been accepted');
  if (!ctx.d.performance_access) throw forbidden('The beneficiary has not shared their results for this agreement');
  if (ctx.youth && !(await liveAuthority(c, ctx.d.sponsor_id, ctx.d.target_id) && ctx.d.performance_access_by && await guardianLink(ctx.d.performance_access_by, ctx.d.target_id))) throw forbidden('The guardian\'s permission to share these results is no longer in force');
}

const label = (official) => (official ? 'approved_competition' : 'self_reported');
const DAY = 'g.starts_at::date';

/**
 * Participation and results of a team or an event, read live from the canonical games and entries (never copied, so a corrected score shows at once).
 * One row per sport and evidence kind: sports are never merged into a combined score. Every row states its source, period and sample size (games counted).
 */
export async function teamEventResults(c, targetType, targetId, { from = null, to = null } = {}) {
  if (targetType !== 'team' && targetType !== 'event') return { participation: null, results: [] };
  const where = targetType === 'team' ? 'gp.team_id=$1' : 'g.competition_id=$1';
  const results = (await c.query(
    `SELECT s.slug AS sport, s.name AS sport_name, (g.competition_id IS NOT NULL OR g.fixture_id IS NOT NULL) AS official, count(DISTINCT g.id)::int AS sample_size,
            count(*) FILTER (WHERE gp.outcome='win')::int AS wins, count(*) FILTER (WHERE gp.outcome='loss')::int AS losses, count(*) FILTER (WHERE gp.outcome='tie')::int AS ties,
            to_char(min(${DAY}),'YYYY-MM-DD') AS first_on, to_char(max(${DAY}),'YYYY-MM-DD') AS latest_on
       FROM game_participants gp JOIN games g ON g.id=gp.game_id JOIN sports s ON s.id=g.sport_id
      WHERE ${where} AND g.status='post-event' AND ($2::date IS NULL OR ${DAY} >= $2) AND ($3::date IS NULL OR ${DAY} <= $3)
        ${targetType === 'event' ? 'AND gp.team_id IS NOT NULL' : ''}
      GROUP BY s.slug, s.name, 3 ORDER BY s.slug, 3 DESC`, [targetId, from, to])).rows;
  const participation = targetType === 'event'
    ? (await c.query(`SELECT count(*) FILTER (WHERE status='accepted' AND team_id IS NOT NULL)::int AS teams, count(*) FILTER (WHERE status='accepted' AND user_id IS NOT NULL)::int AS individuals,
                             count(*) FILTER (WHERE status='accepted')::int AS accepted FROM event_entries WHERE event_id=$1`, [targetId])).rows[0]
    : (await c.query(`SELECT count(*)::int AS members FROM team_members WHERE team_id=$1 AND status='active'`, [targetId])).rows[0];
  return {
    participation: { ...participation, source: 'platform_records', source_label: SOURCE_LABELS.platform_records, unit: targetType === 'event' ? 'accepted entries' : 'active members' },
    results: results.map((r) => ({
      sport: r.sport, sport_name: r.sport_name, evidence: label(r.official), evidence_label: r.official ? 'Official fixture or competition' : 'Friendly or self-organised game',
      source: 'platform_records', source_label: SOURCE_LABELS.platform_records, unit: 'games', sample_size: r.sample_size,
      wins: r.wins, losses: r.losses, ties: r.ties, first_on: r.first_on, latest_on: r.latest_on,
    })),
  };
}

export const ymd = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : null);
/** Stored record -> API shape. The note is decrypted by the caller (and audit-logged when a sponsor reads it). */
export const shapeRecord = (r, note) => ({
  id: r.id, kind: r.kind, title: r.title, metric: r.metric, value: r.value === null ? null : Number(r.value), unit: r.unit, sample_size: r.sample_size,
  source: r.source, source_label: SOURCE_LABELS[r.source], source_ref: r.source_ref, occurred_on: ymd(r.occurred_on), period_end: ymd(r.period_end), note,
  status: r.status, supersedes_id: r.supersedes_id, correction_reason: r.correction_reason, corrected: !!r.supersedes_id, row_version: r.row_version, recorded_by: r.recorded_by_name, created_at: r.created_at,
});
export const listRecords = async (c, sponsorshipId, { sources, history = false, limit, offset }) => (await c.query(
  `SELECT r.*, u.display_name AS recorded_by_name, count(*) OVER()::int AS total
     FROM sponsorship_impact_records r JOIN users u ON u.id=r.recorded_by
    WHERE r.sponsorship_id=$1 AND r.source = ANY($2::text[]) AND ($3::boolean OR r.status='current')
    ORDER BY r.occurred_on DESC, r.created_at DESC, r.id LIMIT $4 OFFSET $5`, [sponsorshipId, sources, history, limit, offset])).rows;
