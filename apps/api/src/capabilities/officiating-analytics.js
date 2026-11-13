// Officiating analytics and season intelligence — self-view + organiser view (REF-R27 / issue #1025).
// No new tables: data lives in fixture_officials, fixtures, events, sports, official_reports,
// official_profile_sports, official_availability, organisations.
// fixture_officials does NOT have sport_id/scheduled_at: use JOIN fixtures f + events e.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one } from '../db.js';
import { audit, isAdmin } from '../helpers.js';
import { forbidden, notFound } from '../errors.js';
import { hasOrgGrant } from '../org-access.js';

const TAG = 'Officials analytics';

// ── shared helpers ─────────────────────────────────────────────────────────

function buildFilters(params, { from, to, sportId, alias = 'f' }) {
  if (from) { params.push(from); params._push(`${alias}.scheduled_at >= $${params.length}`); }
  if (to) { params.push(to); params._push(`${alias}.scheduled_at <= $${params.length}`); }
  if (sportId) { params.push(sportId); params._push(`e.sport_id = $${params.length}`); }
}

// Lightweight params builder that also accumulates WHERE clauses.
function mkParams(...initial) {
  const p = [...initial];
  p._clauses = [];
  p._push = (clause) => { p._clauses.push(clause); };
  p._where = () => p._clauses.length ? `AND ${p._clauses.join(' AND ')}` : '';
  return p;
}

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  if (/^[=+@-]/.test(s)) return `'${s}`;
  return s;
}

async function assertOrgAccess(user, orgId, roles = ['owner', 'admin', 'assessor']) {
  if (isAdmin(user)) return;
  const ok = await hasOrgGrant(user, orgId, roles);
  if (!ok) throw forbidden('Not authorised for this organisation');
}

// ── 1. KPIs ────────────────────────────────────────────────────────────────

cap({
  name: 'get_official_analytics_kpis',
  method: 'GET',
  path: '/me/officials/analytics/kpis',
  tag: TAG,
  summary: 'Key metrics for the authenticated official: total games, acceptance rate, utilisation estimate, sports covered, hours officiated. Date-range and sport optional.',
  input: z.object({
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    sport_id: z.string().uuid().optional(),
  }),
  async handler({ user }, i) {
    const params = mkParams(user.id);
    if (i.from) { params.push(i.from); params._push(`f.scheduled_at >= $${params.length}`); }
    if (i.to) { params.push(i.to); params._push(`f.scheduled_at <= $${params.length}`); }
    if (i.sport_id) { params.push(i.sport_id); params._push(`e.sport_id = $${params.length}`); }
    const where = params._where();

    const kpis = await one(
      `SELECT
         COUNT(*) FILTER (WHERE fo.status IN ('accepted','completed'))::int AS total_games,
         COUNT(*) FILTER (WHERE fo.status = 'accepted')::int AS accepted_count,
         COUNT(*) FILTER (WHERE fo.status = 'declined')::int AS declined_count,
         COUNT(*) FILTER (WHERE fo.status IN ('cancelled','released'))::int AS cancelled_count,
         COUNT(*) FILTER (WHERE fo.status = 'withdrawn')::int AS withdrawn_count,
         COALESCE(SUM(f.duration_min) FILTER (WHERE fo.status IN ('accepted','completed')), 0) / 60.0 AS total_hours_est,
         COUNT(DISTINCT e.sport_id)::int AS sports_count,
         COUNT(*)::int AS total_recorded
       FROM fixture_officials fo
       JOIN fixtures f ON f.id = fo.fixture_id
       JOIN events e ON e.id = f.event_id
       WHERE fo.user_id = $1
         AND fo.status != 'invited'
         ${where}`,
      [...params],
    );

    // acceptance_rate = accepted / (invited+accepted+declined) — needs separate query including invited
    const inviteTotal = await one(
      `SELECT COUNT(*) FILTER (WHERE fo.status = 'invited')::int AS invited_count,
              COUNT(*) FILTER (WHERE fo.status = 'accepted')::int AS accepted_in_pool,
              COUNT(*) FILTER (WHERE fo.status = 'declined')::int AS declined_in_pool
       FROM fixture_officials fo
       JOIN fixtures f ON f.id = fo.fixture_id
       JOIN events e ON e.id = f.event_id
       WHERE fo.user_id = $1
         ${where}`,
      [...params],
    );

    const pool = (inviteTotal.invited_count ?? 0) + (inviteTotal.accepted_in_pool ?? 0) + (inviteTotal.declined_in_pool ?? 0);
    const acceptanceRate = pool > 0 ? Math.round(((inviteTotal.accepted_in_pool ?? 0) / pool) * 100) : null;
    const utilisationRate = kpis.total_recorded > 0
      ? Math.round(((kpis.total_games ?? 0) / kpis.total_recorded) * 100)
      : null;

    // currencies used
    const currencyRows = await many(
      `SELECT DISTINCT fo.fee_currency AS currency
       FROM fixture_officials fo
       JOIN fixtures f ON f.id = fo.fixture_id
       JOIN events e ON e.id = f.event_id
       WHERE fo.user_id = $1
         AND fo.fee_currency IS NOT NULL
         ${where}
       ORDER BY currency`,
      [...params],
    );

    return {
      total_games: kpis.total_games ?? 0,
      accepted_count: kpis.accepted_count ?? 0,
      declined_count: kpis.declined_count ?? 0,
      cancelled_count: kpis.cancelled_count ?? 0,
      withdrawn_count: kpis.withdrawn_count ?? 0,
      total_hours_est: Number(kpis.total_hours_est ?? 0).toFixed(1),
      sports_count: kpis.sports_count ?? 0,
      utilisation_pct: utilisationRate,
      acceptance_rate: acceptanceRate,
      currencies: currencyRows.map((r) => r.currency),
    };
  },
});

// ── 2. Assignment funnel ───────────────────────────────────────────────────

cap({
  name: 'get_official_assignment_funnel',
  method: 'GET',
  path: '/me/officials/analytics/funnel',
  tag: TAG,
  summary: 'Monthly or quarterly assignment funnel for the authenticated official: accepted / declined / cancelled / withdrawn / completed counts per period.',
  input: z.object({
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    sport_id: z.string().uuid().optional(),
    granularity: z.enum(['month', 'quarter']).default('month'),
  }),
  async handler({ user }, i) {
    const params = [user.id];
    const filters = [];
    if (i.from) { params.push(i.from); filters.push(`f.scheduled_at >= $${params.length}`); }
    if (i.to) { params.push(i.to); filters.push(`f.scheduled_at <= $${params.length}`); }
    if (i.sport_id) { params.push(i.sport_id); filters.push(`e.sport_id = $${params.length}`); }
    const whereExtra = filters.length ? `AND ${filters.join(' AND ')}` : '';

    const truncExpr = i.granularity === 'quarter'
      ? `DATE_TRUNC('quarter', f.scheduled_at)`
      : `DATE_TRUNC('month', f.scheduled_at)`;

    const rows = await many(
      `SELECT
         ${truncExpr}::date AS period,
         COUNT(*) FILTER (WHERE fo.status = 'accepted')::int AS accepted,
         COUNT(*) FILTER (WHERE fo.status = 'declined')::int AS declined,
         COUNT(*) FILTER (WHERE fo.status IN ('cancelled','released'))::int AS cancelled,
         COUNT(*) FILTER (WHERE fo.status = 'withdrawn')::int AS withdrawn,
         COUNT(*) FILTER (WHERE fo.status = 'completed')::int AS completed,
         COUNT(*) FILTER (WHERE fo.status = 'invited')::int AS pending
       FROM fixture_officials fo
       JOIN fixtures f ON f.id = fo.fixture_id
       JOIN events e ON e.id = f.event_id
       WHERE fo.user_id = $1
         AND f.scheduled_at IS NOT NULL
         ${whereExtra}
       GROUP BY ${truncExpr}
       ORDER BY period DESC`,
      params,
    );

    const totals = rows.reduce(
      (acc, r) => {
        acc.accepted += r.accepted;
        acc.declined += r.declined;
        acc.cancelled += r.cancelled;
        acc.withdrawn += r.withdrawn;
        acc.completed += r.completed;
        return acc;
      },
      { accepted: 0, declined: 0, cancelled: 0, withdrawn: 0, completed: 0 },
    );

    return { funnel: rows, totals, granularity: i.granularity };
  },
});

// ── 3. Sport breakdown ─────────────────────────────────────────────────────

cap({
  name: 'get_official_sport_breakdown',
  method: 'GET',
  path: '/me/officials/analytics/sport-breakdown',
  tag: TAG,
  summary: 'Per-sport, per-role breakdown of games, estimated hours and average fee for the authenticated official.',
  input: z.object({
    from: z.string().date().optional(),
    to: z.string().date().optional(),
  }),
  async handler({ user }, i) {
    const params = [user.id];
    const filters = [];
    if (i.from) { params.push(i.from); filters.push(`f.scheduled_at >= $${params.length}`); }
    if (i.to) { params.push(i.to); filters.push(`f.scheduled_at <= $${params.length}`); }
    const whereExtra = filters.length ? `AND ${filters.join(' AND ')}` : '';

    const rows = await many(
      `SELECT
         e.sport_id,
         s.name AS sport_name,
         s.emoji AS sport_emoji,
         fo.role,
         ops.level AS level,
         COUNT(*) FILTER (WHERE fo.status IN ('accepted','completed'))::int AS games_count,
         COALESCE(SUM(f.duration_min) FILTER (WHERE fo.status IN ('accepted','completed')), 0) / 60.0 AS hours_est,
         AVG(fo.fee_minor) FILTER (WHERE fo.status IN ('accepted','completed') AND fo.fee_minor IS NOT NULL)::int AS avg_fee_minor,
         MAX(fo.fee_currency) FILTER (WHERE fo.fee_currency IS NOT NULL) AS fee_currency
       FROM fixture_officials fo
       JOIN fixtures f ON f.id = fo.fixture_id
       JOIN events e ON e.id = f.event_id
       LEFT JOIN sports s ON s.id = e.sport_id
       LEFT JOIN official_profile_sports ops
         ON ops.user_id = fo.user_id AND ops.sport_id = e.sport_id AND ops.role = fo.role
       WHERE fo.user_id = $1
         ${whereExtra}
       GROUP BY e.sport_id, s.name, s.emoji, fo.role, ops.level
       ORDER BY games_count DESC`,
      params,
    );

    return { rows: rows.map((r) => ({ ...r, hours_est: Number(r.hours_est ?? 0).toFixed(1) })) };
  },
});

// ── 4. Utilisation trend ───────────────────────────────────────────────────

cap({
  name: 'get_official_utilisation_trend',
  method: 'GET',
  path: '/me/officials/analytics/utilisation',
  tag: TAG,
  summary: 'Monthly utilisation trend for the authenticated official: availability windows vs filled assignments over the past N months (default 24).',
  input: z.object({
    months: z.coerce.number().int().min(3).max(36).default(24),
  }),
  async handler({ user }, i) {
    const cutoff = `DATE_TRUNC('month', now()) - ($2::int - 1) * INTERVAL '1 month'`;

    const filled = await many(
      `SELECT
         TO_CHAR(DATE_TRUNC('month', f.scheduled_at), 'YYYY-MM') AS month,
         COUNT(*)::int AS filled_slots
       FROM fixture_officials fo
       JOIN fixtures f ON f.id = fo.fixture_id
       WHERE fo.user_id = $1
         AND fo.status IN ('accepted','completed')
         AND f.scheduled_at >= ${cutoff}
       GROUP BY DATE_TRUNC('month', f.scheduled_at)
       ORDER BY month ASC`,
      [user.id, i.months],
    );

    // Weekly availability: count distinct weekday slots as a proxy for monthly availability
    const hasAvail = await one(
      `SELECT COUNT(*)::int AS n FROM official_availability WHERE user_id=$1 AND kind='weekly' AND archived_at IS NULL`,
      [user.id],
    );

    // Approximate: each weekly slot fires ~4.33 times per month
    const weeklySlots = hasAvail.n ?? 0;
    const approxMonthly = Math.round(weeklySlots * 4.33);

    const filledByMonth = Object.fromEntries(filled.map((r) => [r.month, r.filled_slots]));

    // Build month series
    const trend = [];
    for (let m = i.months - 1; m >= 0; m--) {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - m);
      const label = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const filledSlots = filledByMonth[label] ?? 0;
      const availableSlots = approxMonthly > 0 ? approxMonthly : null;
      const utilisationPct = availableSlots && availableSlots > 0
        ? Math.min(100, Math.round((filledSlots / availableSlots) * 100))
        : null;
      trend.push({ month: label, available_slots: availableSlots, filled_slots: filledSlots, utilisation_pct: utilisationPct });
    }

    return { trend, months: i.months, availability_setup: weeklySlots > 0 };
  },
});

// ── 5. Repeat clients ──────────────────────────────────────────────────────

cap({
  name: 'get_official_repeat_clients',
  method: 'GET',
  path: '/me/officials/analytics/repeat-clients',
  tag: TAG,
  summary: 'Organisations that have booked the authenticated official more than once, ranked by assignment count.',
  input: z.object({
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  }),
  async handler({ user }, i) {
    const params = [user.id];
    const filters = [];
    if (i.from) { params.push(i.from); filters.push(`f.scheduled_at >= $${params.length}`); }
    if (i.to) { params.push(i.to); filters.push(`f.scheduled_at <= $${params.length}`); }
    const whereExtra = filters.length ? `AND ${filters.join(' AND ')}` : '';

    params.push(i.limit);
    const rows = await many(
      `SELECT
         e.org_id,
         o.name AS org_name,
         COUNT(*)::int AS assignment_count,
         MAX(f.scheduled_at) AS last_assignment_at,
         ARRAY_AGG(DISTINCT s.name) FILTER (WHERE s.name IS NOT NULL) AS sport_names
       FROM fixture_officials fo
       JOIN fixtures f ON f.id = fo.fixture_id
       JOIN events e ON e.id = f.event_id
       LEFT JOIN organisations o ON o.id = e.org_id
       LEFT JOIN sports s ON s.id = e.sport_id
       WHERE fo.user_id = $1
         AND fo.status IN ('accepted','completed')
         AND e.org_id IS NOT NULL
         ${whereExtra}
       GROUP BY e.org_id, o.name
       ORDER BY assignment_count DESC
       LIMIT $${params.length}`,
      params,
    );

    return { clients: rows };
  },
});

// ── 6. Accreditation progress ──────────────────────────────────────────────

cap({
  name: 'get_official_accreditation_progress',
  method: 'GET',
  path: '/me/officials/analytics/accreditation',
  tag: TAG,
  summary: 'Per-sport accreditation progress for the authenticated official: current level, games completed, and simple on-track indicator.',
  input: z.object({}),
  async handler({ user }) {
    const profileSports = await many(
      `SELECT
         ops.sport_id,
         s.name AS sport_name,
         s.emoji AS sport_emoji,
         ops.role,
         ops.level AS current_level
       FROM official_profile_sports ops
       JOIN sports s ON s.id = ops.sport_id
       WHERE ops.user_id = $1
       ORDER BY s.name, ops.role`,
      [user.id],
    );

    if (!profileSports.length) return { progress: [] };

    const sportIds = [...new Set(profileSports.map((r) => r.sport_id))];
    const gameCounts = await many(
      `SELECT
         e.sport_id,
         fo.role,
         COUNT(*)::int AS games_completed
       FROM fixture_officials fo
       JOIN fixtures f ON f.id = fo.fixture_id
       JOIN events e ON e.id = f.event_id
       WHERE fo.user_id = $1
         AND fo.status IN ('accepted','completed')
         AND e.sport_id = ANY($2::uuid[])
       GROUP BY e.sport_id, fo.role`,
      [user.id, sportIds],
    );

    const countMap = {};
    for (const r of gameCounts) {
      countMap[`${r.sport_id}:${r.role}`] = r.games_completed;
    }

    const GAMES_ON_TRACK = 10;

    const progress = profileSports.map((ps) => {
      const gamesCompleted = countMap[`${ps.sport_id}:${ps.role}`] ?? 0;
      return {
        sport_id: ps.sport_id,
        sport_name: ps.sport_name,
        sport_emoji: ps.sport_emoji,
        role: ps.role,
        current_level: ps.current_level,
        games_completed: gamesCompleted,
        games_target: GAMES_ON_TRACK,
        status: gamesCompleted >= GAMES_ON_TRACK ? 'on_track' : 'needs_attention',
      };
    });

    return { progress };
  },
});

// ── 7. Incident trend ──────────────────────────────────────────────────────

cap({
  name: 'get_official_incident_trend',
  method: 'GET',
  path: '/me/officials/analytics/incidents',
  tag: TAG,
  summary: 'Monthly count of incident reports filed by the authenticated official (counts only — content is never returned here).',
  input: z.object({
    months: z.coerce.number().int().min(3).max(36).default(24),
  }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT
         TO_CHAR(DATE_TRUNC('month', orep.created_at), 'YYYY-MM') AS month,
         orep.category,
         COUNT(*)::int AS count
       FROM official_reports orep
       WHERE orep.author_id = $1
         AND orep.created_at >= DATE_TRUNC('month', now()) - ($2::int - 1) * INTERVAL '1 month'
       GROUP BY DATE_TRUNC('month', orep.created_at), orep.category
       ORDER BY month DESC, orep.category`,
      [user.id, i.months],
    );

    // Pivot categories per month
    const byMonth = {};
    for (const r of rows) {
      if (!byMonth[r.month]) byMonth[r.month] = { month: r.month, incident_count: 0, categories: {} };
      byMonth[r.month].incident_count += r.count;
      byMonth[r.month].categories[r.category] = (byMonth[r.month].categories[r.category] ?? 0) + r.count;
    }

    const trend = Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month));

    return { trend, months: i.months };
  },
});

// ── 8. CSV export (self) ───────────────────────────────────────────────────

cap({
  name: 'export_officiating_analytics_csv',
  method: 'GET',
  path: '/me/officials/analytics/export',
  tag: TAG,
  summary: 'Export officiating analytics as CSV for the authenticated official. Audit-logged.',
  input: z.object({
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    sport_id: z.string().uuid().optional(),
  }),
  async handler({ user }, i) {
    const params = [user.id];
    const filters = [];
    if (i.from) { params.push(i.from); filters.push(`f.scheduled_at >= $${params.length}`); }
    if (i.to) { params.push(i.to); filters.push(`f.scheduled_at <= $${params.length}`); }
    if (i.sport_id) { params.push(i.sport_id); filters.push(`e.sport_id = $${params.length}`); }
    const whereExtra = filters.length ? `AND ${filters.join(' AND ')}` : '';

    const rows = await many(
      `SELECT
         f.scheduled_at,
         s.name AS sport_name,
         fo.role,
         fo.status,
         f.duration_min,
         fo.fee_minor,
         fo.fee_currency,
         fo.pay_status,
         e.name AS event_name,
         o.name AS org_name
       FROM fixture_officials fo
       JOIN fixtures f ON f.id = fo.fixture_id
       JOIN events e ON e.id = f.event_id
       LEFT JOIN sports s ON s.id = e.sport_id
       LEFT JOIN organisations o ON o.id = e.org_id
       WHERE fo.user_id = $1
         ${whereExtra}
       ORDER BY f.scheduled_at DESC NULLS LAST`,
      params,
    );

    await audit(null, user.id, 'export_officiating_analytics', 'fixture_officials', null);

    const headers = ['Date', 'Event', 'Organisation', 'Sport', 'Role', 'Status', 'Duration (min)', 'Fee (minor)', 'Fee Currency', 'Pay Status'];
    const lines = [
      headers.map(csvCell).join(','),
      ...rows.map((r) => [
        r.scheduled_at ? new Date(r.scheduled_at).toISOString().slice(0, 10) : '',
        r.event_name ?? '',
        r.org_name ?? '',
        r.sport_name ?? '',
        r.role,
        r.status,
        r.duration_min ?? '',
        r.fee_minor ?? '',
        r.fee_currency ?? '',
        r.pay_status ?? '',
      ].map(csvCell).join(',')),
    ];

    return {
      filename: `officiating-analytics-${new Date().toISOString().slice(0, 10)}.csv`,
      content_type: 'text/csv',
      encoding: 'utf8',
      content: lines.join('\r\n'),
    };
  },
});

// ── 9. Organiser KPIs ─────────────────────────────────────────────────────

cap({
  name: 'get_organiser_officiating_kpis',
  method: 'GET',
  path: '/organisations/:org_id/officiating-analytics/kpis',
  tag: TAG,
  summary: 'Key officiating metrics for an organisation: pool size, acceptance rate, total assignments, avg fee, incident rate. Requires owner/admin/assessor access.',
  input: z.object({
    org_id: id,
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    sport_id: z.string().uuid().optional(),
  }),
  async handler({ user }, i) {
    await assertOrgAccess(user, i.org_id);

    const params = [i.org_id];
    const filters = [];
    if (i.from) { params.push(i.from); filters.push(`f.scheduled_at >= $${params.length}`); }
    if (i.to) { params.push(i.to); filters.push(`f.scheduled_at <= $${params.length}`); }
    if (i.sport_id) { params.push(i.sport_id); filters.push(`e.sport_id = $${params.length}`); }
    const whereExtra = filters.length ? `AND ${filters.join(' AND ')}` : '';

    const kpis = await one(
      `SELECT
         COUNT(DISTINCT fo.user_id)::int AS pool_size,
         COUNT(*)::int AS total_assignments,
         COUNT(*) FILTER (WHERE fo.status = 'accepted')::int AS accepted_count,
         COUNT(*) FILTER (WHERE fo.status = 'declined')::int AS declined_count,
         COUNT(*) FILTER (WHERE fo.status IN ('invited','accepted','declined'))::int AS invite_pool,
         AVG(fo.fee_minor) FILTER (WHERE fo.fee_minor IS NOT NULL AND fo.status IN ('accepted','completed'))::int AS avg_fee_minor,
         MAX(fo.fee_currency) FILTER (WHERE fo.fee_currency IS NOT NULL) AS fee_currency
       FROM fixture_officials fo
       JOIN fixtures f ON f.id = fo.fixture_id
       JOIN events e ON e.id = f.event_id
       WHERE e.org_id = $1
         ${whereExtra}`,
      params,
    );

    const incidentCount = await one(
      `SELECT COUNT(*)::int AS n
       FROM official_reports orep
       JOIN fixtures f ON f.id = orep.fixture_id
       JOIN events e ON e.id = f.event_id
       WHERE e.org_id = $1
         ${whereExtra}`,
      params,
    );

    const sports = await many(
      `SELECT DISTINCT e.sport_id, s.name AS sport_name, s.emoji AS sport_emoji
       FROM fixture_officials fo
       JOIN fixtures f ON f.id = fo.fixture_id
       JOIN events e ON e.id = f.event_id
       LEFT JOIN sports s ON s.id = e.sport_id
       WHERE e.org_id = $1 ${whereExtra}
       ORDER BY s.name`,
      params,
    );

    const invitePool = kpis.invite_pool ?? 0;
    const avgAcceptanceRate = invitePool > 0
      ? Math.round(((kpis.accepted_count ?? 0) / invitePool) * 100)
      : null;
    const incidentRate = kpis.total_assignments > 0
      ? Number(((incidentCount.n ?? 0) / kpis.total_assignments) * 100).toFixed(1)
      : null;

    return {
      pool_size: kpis.pool_size ?? 0,
      total_assignments: kpis.total_assignments ?? 0,
      accepted_count: kpis.accepted_count ?? 0,
      declined_count: kpis.declined_count ?? 0,
      avg_acceptance_rate: avgAcceptanceRate,
      avg_fee_minor: kpis.avg_fee_minor,
      fee_currency: kpis.fee_currency,
      incident_count: incidentCount.n ?? 0,
      incident_rate: incidentRate,
      sports,
    };
  },
});

// ── 10. Organiser pool breakdown ───────────────────────────────────────────

cap({
  name: 'get_organiser_pool_breakdown',
  method: 'GET',
  path: '/organisations/:org_id/officiating-analytics/pool',
  tag: TAG,
  summary: 'Per-sport, per-role breakdown of the officiating pool used by an organisation.',
  input: z.object({
    org_id: id,
    from: z.string().date().optional(),
    to: z.string().date().optional(),
  }),
  async handler({ user }, i) {
    await assertOrgAccess(user, i.org_id);

    const params = [i.org_id];
    const filters = [];
    if (i.from) { params.push(i.from); filters.push(`f.scheduled_at >= $${params.length}`); }
    if (i.to) { params.push(i.to); filters.push(`f.scheduled_at <= $${params.length}`); }
    const whereExtra = filters.length ? `AND ${filters.join(' AND ')}` : '';

    const rows = await many(
      `SELECT
         e.sport_id,
         s.name AS sport_name,
         s.emoji AS sport_emoji,
         fo.role,
         COUNT(*)::int AS assignment_count,
         COUNT(DISTINCT fo.user_id)::int AS unique_officials,
         COUNT(*) FILTER (WHERE fo.status = 'accepted')::int AS accepted_count,
         COUNT(*) FILTER (WHERE fo.status IN ('invited','accepted','declined'))::int AS invite_pool
       FROM fixture_officials fo
       JOIN fixtures f ON f.id = fo.fixture_id
       JOIN events e ON e.id = f.event_id
       LEFT JOIN sports s ON s.id = e.sport_id
       WHERE e.org_id = $1
         ${whereExtra}
       GROUP BY e.sport_id, s.name, s.emoji, fo.role
       ORDER BY assignment_count DESC`,
      params,
    );

    return {
      rows: rows.map((r) => ({
        ...r,
        acceptance_rate: r.invite_pool > 0 ? Math.round((r.accepted_count / r.invite_pool) * 100) : null,
      })),
    };
  },
});

// ── 11. Organiser assignment funnel ────────────────────────────────────────

cap({
  name: 'get_organiser_assignment_funnel',
  method: 'GET',
  path: '/organisations/:org_id/officiating-analytics/funnel',
  tag: TAG,
  summary: 'Monthly or quarterly assignment funnel for an organisation.',
  input: z.object({
    org_id: id,
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    granularity: z.enum(['month', 'quarter']).default('month'),
  }),
  async handler({ user }, i) {
    await assertOrgAccess(user, i.org_id);

    const params = [i.org_id];
    const filters = [];
    if (i.from) { params.push(i.from); filters.push(`f.scheduled_at >= $${params.length}`); }
    if (i.to) { params.push(i.to); filters.push(`f.scheduled_at <= $${params.length}`); }
    const whereExtra = filters.length ? `AND ${filters.join(' AND ')}` : '';

    const truncExpr = i.granularity === 'quarter'
      ? `DATE_TRUNC('quarter', f.scheduled_at)`
      : `DATE_TRUNC('month', f.scheduled_at)`;

    const rows = await many(
      `SELECT
         ${truncExpr}::date AS period,
         COUNT(*) FILTER (WHERE fo.status = 'accepted')::int AS accepted,
         COUNT(*) FILTER (WHERE fo.status = 'declined')::int AS declined,
         COUNT(*) FILTER (WHERE fo.status IN ('cancelled','released'))::int AS cancelled,
         COUNT(*) FILTER (WHERE fo.status = 'withdrawn')::int AS withdrawn,
         COUNT(*) FILTER (WHERE fo.status = 'completed')::int AS completed,
         COUNT(*) FILTER (WHERE fo.status = 'invited')::int AS pending
       FROM fixture_officials fo
       JOIN fixtures f ON f.id = fo.fixture_id
       JOIN events e ON e.id = f.event_id
       WHERE e.org_id = $1
         AND f.scheduled_at IS NOT NULL
         ${whereExtra}
       GROUP BY ${truncExpr}
       ORDER BY period DESC`,
      params,
    );

    return { funnel: rows, granularity: i.granularity };
  },
});

// ── 12. Organiser CSV export ───────────────────────────────────────────────

cap({
  name: 'export_organiser_officiating_csv',
  method: 'GET',
  path: '/organisations/:org_id/officiating-analytics/export',
  tag: TAG,
  summary: 'Export organisation officiating analytics as CSV. Requires owner/admin access. Audit-logged.',
  input: z.object({
    org_id: id,
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    sport_id: z.string().uuid().optional(),
  }),
  async handler({ user }, i) {
    if (!isAdmin(user)) {
      const ok = await hasOrgGrant(user, i.org_id, ['owner', 'admin']);
      if (!ok) throw forbidden('Not authorised for this organisation');
    }

    const params = [i.org_id];
    const filters = [];
    if (i.from) { params.push(i.from); filters.push(`f.scheduled_at >= $${params.length}`); }
    if (i.to) { params.push(i.to); filters.push(`f.scheduled_at <= $${params.length}`); }
    if (i.sport_id) { params.push(i.sport_id); filters.push(`e.sport_id = $${params.length}`); }
    const whereExtra = filters.length ? `AND ${filters.join(' AND ')}` : '';

    const rows = await many(
      `SELECT
         f.scheduled_at,
         e.name AS event_name,
         s.name AS sport_name,
         fo.role,
         fo.status,
         f.duration_min,
         fo.fee_minor,
         fo.fee_currency,
         fo.pay_status,
         COUNT(DISTINCT fo.user_id) OVER (PARTITION BY e.sport_id, fo.role) AS pool_officials
       FROM fixture_officials fo
       JOIN fixtures f ON f.id = fo.fixture_id
       JOIN events e ON e.id = f.event_id
       LEFT JOIN sports s ON s.id = e.sport_id
       WHERE e.org_id = $1
         ${whereExtra}
       ORDER BY f.scheduled_at DESC NULLS LAST`,
      params,
    );

    await audit(null, user.id, 'export_organiser_officiating_analytics', 'organisations', i.org_id);

    const headers = ['Date', 'Event', 'Sport', 'Role', 'Status', 'Duration (min)', 'Fee (minor)', 'Currency', 'Pay Status'];
    const lines = [
      headers.map(csvCell).join(','),
      ...rows.map((r) => [
        r.scheduled_at ? new Date(r.scheduled_at).toISOString().slice(0, 10) : '',
        r.event_name ?? '',
        r.sport_name ?? '',
        r.role,
        r.status,
        r.duration_min ?? '',
        r.fee_minor ?? '',
        r.fee_currency ?? '',
        r.pay_status ?? '',
      ].map(csvCell).join(',')),
    ];

    return {
      filename: `org-officiating-analytics-${new Date().toISOString().slice(0, 10)}.csv`,
      content_type: 'text/csv',
      encoding: 'utf8',
      content: lines.join('\r\n'),
    };
  },
});
