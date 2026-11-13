// Officiating season intelligence (REF-R27 / issue #1025).
// Pre-aggregated season summaries, leaderboard, snapshot reads, season intelligence for organisers.
// Reads from official_season_summaries and officiating_analytics_snapshots (migration 221).
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, tx } from '../db.js';
import { audit, isAdmin } from '../helpers.js';
import { forbidden, notFound } from '../errors.js';
import { hasOrgGrant } from '../org-access.js';

const TAG = 'Officials analytics';

async function assertOrgAccess(user, orgId, roles = ['owner', 'admin', 'assessor']) {
  if (isAdmin(user)) return;
  const ok = await hasOrgGrant(user, orgId, roles);
  if (!ok) throw forbidden('Not authorised for this organisation');
}

// ── 1. Self: get season summaries ──────────────────────────────────────────

cap({
  name: 'get_official_season_summary',
  method: 'GET',
  path: '/me/officials/analytics/season-summary',
  tag: TAG,
  summary: 'Per-sport season summaries for the authenticated official from pre-aggregated cache. Call recompute to refresh.',
  input: z.object({
    season_label: z.string().max(20).optional(),
    sport_id: z.string().uuid().optional(),
  }),
  async handler({ user }, i) {
    const params = [user.id];
    const filters = [];
    if (i.season_label) { params.push(i.season_label); filters.push(`oss.season_label = $${params.length}`); }
    if (i.sport_id) { params.push(i.sport_id); filters.push(`oss.sport_id = $${params.length}`); }
    const whereExtra = filters.length ? `AND ${filters.join(' AND ')}` : '';

    const rows = await many(
      `SELECT
         oss.*,
         s.name AS sport_name,
         s.emoji AS sport_emoji
       FROM official_season_summaries oss
       JOIN sports s ON s.id = oss.sport_id
       WHERE oss.user_id = $1
         ${whereExtra}
       ORDER BY oss.season_label DESC, s.name ASC`,
      params,
    );

    return { summaries: rows };
  },
});

// ── 2. Self: recompute season summary ─────────────────────────────────────

cap({
  name: 'recompute_official_season_summary',
  method: 'POST',
  path: '/me/officials/analytics/season-summary/recompute',
  tag: TAG,
  status: 201,
  summary: 'Recompute and upsert per-sport season summaries for the authenticated official for the given season window.',
  input: z.object({
    season_from: z.string().date(),
    season_to: z.string().date(),
    season_label: z.string().max(20),
  }),
  async handler({ user }, i) {
    // Aggregate per sport
    const sports = await many(
      `SELECT DISTINCT e.sport_id
       FROM fixture_officials fo
       JOIN fixtures f ON f.id = fo.fixture_id
       JOIN events e ON e.id = f.event_id
       WHERE fo.user_id = $1
         AND f.scheduled_at BETWEEN $2 AND $3`,
      [user.id, i.season_from, i.season_to],
    );

    if (!sports.length) return { summaries: [], message: 'No assignments found in this season window.' };

    const sportIds = sports.map((s) => s.sport_id);

    const rows = await many(
      `SELECT
         e.sport_id,
         COUNT(*) FILTER (WHERE fo.status IN ('accepted','completed'))::int AS total_games,
         COALESCE(SUM(f.duration_min) FILTER (WHERE fo.status IN ('accepted','completed')), 0) / 60.0 AS total_hours,
         COUNT(*) FILTER (WHERE fo.status = 'accepted')::int AS accepted_count,
         COUNT(*) FILTER (WHERE fo.status = 'declined')::int AS declined_count,
         COUNT(*) FILTER (WHERE fo.status IN ('cancelled','released'))::int AS cancelled_count,
         AVG(fo.fee_minor) FILTER (WHERE fo.status IN ('accepted','completed') AND fo.fee_minor IS NOT NULL)::int AS avg_fee_minor,
         MAX(fo.fee_currency) FILTER (WHERE fo.fee_currency IS NOT NULL) AS fee_currency,
         COUNT(DISTINCT e.org_id) FILTER (WHERE fo.status IN ('accepted','completed'))::int AS repeat_client_count
       FROM fixture_officials fo
       JOIN fixtures f ON f.id = fo.fixture_id
       JOIN events e ON e.id = f.event_id
       WHERE fo.user_id = $1
         AND f.scheduled_at BETWEEN $2 AND $3
         AND e.sport_id = ANY($4::uuid[])
       GROUP BY e.sport_id`,
      [user.id, i.season_from, i.season_to, sportIds],
    );

    const incidentRows = await many(
      `SELECT e.sport_id, COUNT(*)::int AS incident_count
       FROM official_reports orep
       JOIN fixtures f ON f.id = orep.fixture_id
       JOIN events e ON e.id = f.event_id
       WHERE orep.author_id = $1
         AND f.scheduled_at BETWEEN $2 AND $3
       GROUP BY e.sport_id`,
      [user.id, i.season_from, i.season_to],
    );

    const incidentMap = Object.fromEntries(incidentRows.map((r) => [r.sport_id, r.incident_count]));

    const upserted = [];
    for (const r of rows) {
      const row = await one(
        `INSERT INTO official_season_summaries
           (user_id, sport_id, season_label, season_from, season_to, total_games, total_hours,
            accepted_count, declined_count, cancelled_count, avg_fee_minor, fee_currency,
            repeat_client_count, incident_count, computed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
         ON CONFLICT (user_id, sport_id, season_label) DO UPDATE SET
           total_games = EXCLUDED.total_games,
           total_hours = EXCLUDED.total_hours,
           accepted_count = EXCLUDED.accepted_count,
           declined_count = EXCLUDED.declined_count,
           cancelled_count = EXCLUDED.cancelled_count,
           avg_fee_minor = EXCLUDED.avg_fee_minor,
           fee_currency = EXCLUDED.fee_currency,
           repeat_client_count = EXCLUDED.repeat_client_count,
           incident_count = EXCLUDED.incident_count,
           season_from = EXCLUDED.season_from,
           season_to = EXCLUDED.season_to,
           computed_at = now()
         RETURNING *`,
        [
          user.id, r.sport_id, i.season_label, i.season_from, i.season_to,
          r.total_games, Number(r.total_hours ?? 0).toFixed(2),
          r.accepted_count, r.declined_count, r.cancelled_count,
          r.avg_fee_minor, r.fee_currency,
          r.repeat_client_count, incidentMap[r.sport_id] ?? 0,
        ],
      );
      upserted.push(row);
    }

    await audit(null, user.id, 'recompute_season_summary', 'official_season_summaries', null);

    return { summaries: upserted, season_label: i.season_label };
  },
});

// ── 3. Organiser season intelligence ──────────────────────────────────────

cap({
  name: 'get_organiser_season_intelligence',
  method: 'GET',
  path: '/organisations/:org_id/officiating-analytics/season-intelligence',
  tag: TAG,
  summary: 'Season-level officiating intelligence for an organisation: per-sport totals, acceptance trends, fee averages.',
  input: z.object({
    org_id: id,
    season_from: z.string().date().optional(),
    season_to: z.string().date().optional(),
  }),
  async handler({ user }, i) {
    await assertOrgAccess(user, i.org_id);

    const params = [i.org_id];
    const filters = [];
    if (i.season_from) { params.push(i.season_from); filters.push(`f.scheduled_at >= $${params.length}`); }
    if (i.season_to) { params.push(i.season_to); filters.push(`f.scheduled_at <= $${params.length}`); }
    const whereExtra = filters.length ? `AND ${filters.join(' AND ')}` : '';

    const rows = await many(
      `SELECT
         e.sport_id,
         s.name AS sport_name,
         s.emoji AS sport_emoji,
         COUNT(*)::int AS total_assignments,
         COUNT(DISTINCT fo.user_id)::int AS unique_officials,
         COUNT(*) FILTER (WHERE fo.status = 'accepted')::int AS accepted_count,
         COUNT(*) FILTER (WHERE fo.status IN ('invited','accepted','declined'))::int AS invite_pool,
         AVG(fo.fee_minor) FILTER (WHERE fo.fee_minor IS NOT NULL AND fo.status IN ('accepted','completed'))::int AS avg_fee_minor,
         MAX(fo.fee_currency) FILTER (WHERE fo.fee_currency IS NOT NULL) AS fee_currency,
         MIN(f.scheduled_at)::date AS season_from,
         MAX(f.scheduled_at)::date AS season_to
       FROM fixture_officials fo
       JOIN fixtures f ON f.id = fo.fixture_id
       JOIN events e ON e.id = f.event_id
       LEFT JOIN sports s ON s.id = e.sport_id
       WHERE e.org_id = $1
         ${whereExtra}
       GROUP BY e.sport_id, s.name, s.emoji
       ORDER BY total_assignments DESC`,
      params,
    );

    return {
      seasons: rows.map((r) => ({
        ...r,
        acceptance_rate: r.invite_pool > 0 ? Math.round((r.accepted_count / r.invite_pool) * 100) : null,
      })),
    };
  },
});

// ── 4. Season leaderboard ─────────────────────────────────────────────────

cap({
  name: 'get_official_season_leaderboard',
  method: 'GET',
  path: '/organisations/:org_id/officiating-analytics/leaderboard',
  tag: TAG,
  summary: 'Officials leaderboard for an organisation ranked by games, hours, or acceptance rate. Privacy: display names are first-name only unless the caller is an assessor.',
  input: z.object({
    org_id: id,
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    rank_by: z.enum(['games', 'hours', 'acceptance_rate']).default('games'),
    limit: z.coerce.number().int().min(5).max(50).default(20),
  }),
  async handler({ user }, i) {
    // Leaderboard requires owner or admin — not just assessor
    await assertOrgAccess(user, i.org_id, ['owner', 'admin']);

    const params = [i.org_id];
    const filters = [];
    if (i.from) { params.push(i.from); filters.push(`f.scheduled_at >= $${params.length}`); }
    if (i.to) { params.push(i.to); filters.push(`f.scheduled_at <= $${params.length}`); }
    const whereExtra = filters.length ? `AND ${filters.join(' AND ')}` : '';

    params.push(i.limit);
    const limitParam = `$${params.length}`;

    const orderExpr = {
      games: 'games DESC',
      hours: 'hours_est DESC',
      acceptance_rate: 'acceptance_rate DESC NULLS LAST',
    }[i.rank_by];

    const rows = await many(
      `SELECT
         fo.user_id,
         u.name AS full_name,
         COUNT(*) FILTER (WHERE fo.status IN ('accepted','completed'))::int AS games,
         COALESCE(SUM(f.duration_min) FILTER (WHERE fo.status IN ('accepted','completed')), 0) / 60.0 AS hours_est,
         COUNT(*) FILTER (WHERE fo.status = 'accepted')::int AS accepted_count,
         COUNT(*) FILTER (WHERE fo.status IN ('invited','accepted','declined'))::int AS invite_pool,
         ARRAY_AGG(DISTINCT s.name) FILTER (WHERE s.name IS NOT NULL) AS sport_names
       FROM fixture_officials fo
       JOIN fixtures f ON f.id = fo.fixture_id
       JOIN events e ON e.id = f.event_id
       JOIN users u ON u.id = fo.user_id
       LEFT JOIN sports s ON s.id = e.sport_id
       WHERE e.org_id = $1
         AND fo.status != 'invited'
         ${whereExtra}
       GROUP BY fo.user_id, u.name
       ORDER BY ${orderExpr}
       LIMIT ${limitParam}`,
      params,
    );

    // Privacy: return first name only
    const officials = rows.map((r, idx) => {
      const displayName = r.full_name
        ? r.full_name.split(' ')[0]
        : `Official ${idx + 1}`;
      const acceptanceRate = r.invite_pool > 0
        ? Math.round((r.accepted_count / r.invite_pool) * 100)
        : null;
      return {
        rank: idx + 1,
        user_id: r.user_id,
        display_name: displayName,
        games: r.games,
        hours_est: Number(r.hours_est ?? 0).toFixed(1),
        acceptance_rate: acceptanceRate,
        sport_names: r.sport_names ?? [],
      };
    });

    return { officials, rank_by: i.rank_by };
  },
});

// ── 5. Season snapshot list ────────────────────────────────────────────────

cap({
  name: 'list_official_season_snapshots',
  method: 'GET',
  path: '/organisations/:org_id/officiating-analytics/snapshots',
  tag: TAG,
  summary: 'Paginated list of officiating analytics snapshots for an organisation (populated by background aggregation jobs).',
  input: z.object({
    org_id: id,
    ...page,
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    sport_id: z.string().uuid().optional(),
    role: z.string().max(50).optional(),
  }),
  async handler({ user }, i) {
    await assertOrgAccess(user, i.org_id);

    const limit = i.limit ?? 50;
    const offset = i.offset ?? 0;
    const params = [i.org_id];
    const filters = [];
    if (i.from) { params.push(i.from); filters.push(`oas.snapshot_date >= $${params.length}`); }
    if (i.to) { params.push(i.to); filters.push(`oas.snapshot_date <= $${params.length}`); }
    if (i.sport_id) { params.push(i.sport_id); filters.push(`oas.sport_id = $${params.length}`); }
    if (i.role) { params.push(i.role); filters.push(`oas.role = $${params.length}`); }
    const whereExtra = filters.length ? `AND ${filters.join(' AND ')}` : '';

    const rows = await many(
      `SELECT oas.*, s.name AS sport_name, s.emoji AS sport_emoji
       FROM officiating_analytics_snapshots oas
       LEFT JOIN sports s ON s.id = oas.sport_id
       WHERE oas.scope_type = 'organisation'
         AND oas.scope_id = $1
         ${whereExtra}
       ORDER BY oas.snapshot_date DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );

    const total = (await one(
      `SELECT COUNT(*)::int AS n
       FROM officiating_analytics_snapshots oas
       WHERE oas.scope_type = 'organisation'
         AND oas.scope_id = $1
         ${whereExtra}`,
      params,
    )).n;

    return { snapshots: rows, total, limit, offset };
  },
});
