// Referee/umpire earnings dashboard (#1019). Read-only aggregation over assignment fees, payout items and transaction ledger.
// No new tables: data lives in fixture_officials, fixture_official_pay_log, payout_items, fin_transactions.
// Every route is scoped to req.user.id — 404 replaces 403 to avoid existence leaks.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one } from '../db.js';
import { audit } from '../helpers.js';
import { notFound } from '../errors.js';

const TAG = 'Officials';

// ── helpers ────────────────────────────────────────────────────────────────

function dateFilter(from, to) {
  if (from && to) return { sql: 'AND fo.scheduled_at BETWEEN $<from> AND $<to>', params: { from, to } };
  if (from) return { sql: 'AND fo.scheduled_at >= $<from>', params: { from } };
  if (to) return { sql: 'AND fo.scheduled_at <= $<to>', params: { to } };
  return { sql: '', params: {} };
}

// Replace named placeholders ($<key>) with positional $N starting from offset
function namedToPos(sql, named, offset = 1) {
  const params = [];
  let idx = offset;
  const out = sql.replace(/\$<([a-z_]+)>/g, (_, k) => {
    params.push(named[k]);
    return `$${idx++}`;
  });
  return { sql: out, params };
}

// ── earnings summary (per currency) ───────────────────────────────────────

cap({
  name: 'get_official_earnings_summary',
  method: 'GET',
  path: '/me/officials/earnings',
  tag: TAG,
  summary: 'Per-currency earnings summary for the authenticated official: total agreed, due, paid, disputed, pending payout, and lifetime ledger credit. Date-range optional.',
  input: z.object({
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    sport_id: z.string().uuid().optional(),
  }),
  async handler({ user }, i) {
    const df = dateFilter(i.from, i.to);
    const sportClause = i.sport_id ? 'AND fo.sport_id = $<sport>' : '';
    const named = { uid: user.id, ...df.params, ...(i.sport_id ? { sport: i.sport_id } : {}) };
    const { sql: posFilters, params: posParams } = namedToPos(
      `${df.sql} ${sportClause}`,
      named,
      2, // $1 = user.id
    );

    const rows = await many(
      `SELECT
         fo.fee_currency AS currency,
         COUNT(*) FILTER (WHERE fo.pay_status = 'agreed')::int AS agreed_count,
         COALESCE(SUM(fo.fee_minor) FILTER (WHERE fo.pay_status = 'agreed'), 0)::bigint AS agreed_minor,
         COUNT(*) FILTER (WHERE fo.pay_status = 'due')::int AS due_count,
         COALESCE(SUM(fo.fee_minor) FILTER (WHERE fo.pay_status = 'due'), 0)::bigint AS due_minor,
         COUNT(*) FILTER (WHERE fo.pay_status = 'paid')::int AS paid_count,
         COALESCE(SUM(fo.fee_minor) FILTER (WHERE fo.pay_status = 'paid'), 0)::bigint AS paid_minor,
         COUNT(*) FILTER (WHERE fo.pay_status = 'disputed')::int AS disputed_count,
         COALESCE(SUM(fo.fee_minor) FILTER (WHERE fo.pay_status = 'disputed'), 0)::bigint AS disputed_minor,
         COUNT(*) FILTER (WHERE fo.status IN ('invited','accepted') AND fo.pay_status IS NULL)::int AS unpaid_count
       FROM fixture_officials fo
       WHERE fo.user_id = $1
         AND fo.fee_currency IS NOT NULL
         ${posFilters}
       GROUP BY fo.fee_currency
       ORDER BY paid_minor DESC`,
      [user.id, ...posParams],
    );

    // payout items pending/paid
    const payoutRows = await many(
      `SELECT
         pi.currency,
         COALESCE(SUM(pi.gross_minor) FILTER (WHERE pi.status = 'pending'), 0)::bigint AS payout_pending_minor,
         COALESCE(SUM(pi.net_minor) FILTER (WHERE pi.status = 'paid'), 0)::bigint AS payout_net_minor,
         COALESCE(SUM(pi.tax_minor) FILTER (WHERE pi.status = 'paid'), 0)::bigint AS payout_tax_minor,
         COALESCE(SUM(pi.fee_minor) FILTER (WHERE pi.status = 'paid'), 0)::bigint AS payout_fee_minor,
         COUNT(*) FILTER (WHERE pi.status = 'paid')::int AS payout_paid_count,
         COUNT(*) FILTER (WHERE pi.status = 'pending')::int AS payout_pending_count
       FROM payout_items pi
       WHERE pi.payee_id = $1 AND pi.source_type = 'official_fee'
       GROUP BY pi.currency`,
      [user.id],
    );

    const payoutByCurrency = Object.fromEntries(payoutRows.map((r) => [r.currency, r]));

    const summary = rows.map((r) => ({
      currency: r.currency,
      agreed: { count: r.agreed_count, minor: r.agreed_minor },
      due: { count: r.due_count, minor: r.due_minor },
      paid: { count: r.paid_count, minor: r.paid_minor },
      disputed: { count: r.disputed_count, minor: r.disputed_minor },
      unpaid_assignments: r.unpaid_count,
      payout: payoutByCurrency[r.currency] ?? {
        payout_pending_minor: 0,
        payout_net_minor: 0,
        payout_tax_minor: 0,
        payout_fee_minor: 0,
        payout_paid_count: 0,
        payout_pending_count: 0,
      },
    }));

    return { summary };
  },
});

// ── earnings line items (paginated) ───────────────────────────────────────

cap({
  name: 'list_official_earnings_entries',
  method: 'GET',
  path: '/me/officials/earnings/entries',
  tag: TAG,
  summary: 'Paginated list of every assignment fee for the authenticated official, with fixture detail, pay status and linked payout item.',
  input: z.object({
    ...page,
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
    pay_status: z.enum(['agreed', 'due', 'paid', 'disputed']).optional(),
    sport_id: z.string().uuid().optional(),
  }),
  async handler({ user }, i) {
    const limit = i.limit ?? 50;
    const offset = i.offset ?? 0;
    const filters = [];
    const params = [user.id];

    if (i.from) { params.push(i.from); filters.push(`fo.scheduled_at >= $${params.length}`); }
    if (i.to) { params.push(i.to); filters.push(`fo.scheduled_at <= $${params.length}`); }
    if (i.currency) { params.push(i.currency); filters.push(`fo.fee_currency = $${params.length}`); }
    if (i.pay_status) { params.push(i.pay_status); filters.push(`fo.pay_status = $${params.length}`); }
    if (i.sport_id) { params.push(i.sport_id); filters.push(`fo.sport_id = $${params.length}`); }

    const whereExtra = filters.length ? `AND ${filters.join(' AND ')}` : '';

    const rows = await many(
      `SELECT
         fo.id,
         fo.role,
         fo.status AS assignment_status,
         fo.pay_status,
         fo.fee_minor,
         fo.fee_currency AS currency,
         fo.pay_updated_at,
         fo.pay_confirmed_at,
         fo.scheduled_at,
         f.name AS fixture_name,
         f.id AS fixture_id,
         e.name AS event_name,
         e.id AS event_id,
         s.name AS sport_name,
         s.emoji AS sport_emoji,
         o.name AS organiser_name,
         pi.id AS payout_item_id,
         pi.status AS payout_status,
         pi.net_minor AS payout_net_minor,
         pi.decided_at AS payout_decided_at
       FROM fixture_officials fo
       JOIN fixtures f ON f.id = fo.fixture_id
       JOIN events e ON e.id = f.event_id
       LEFT JOIN sports s ON s.id = fo.sport_id
       LEFT JOIN organisations o ON o.id = e.org_id
       LEFT JOIN payout_items pi ON pi.id = fo.payout_item_id
       WHERE fo.user_id = $1
         AND fo.fee_currency IS NOT NULL
         ${whereExtra}
       ORDER BY fo.scheduled_at DESC NULLS LAST
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );

    const total = (await one(
      `SELECT COUNT(*)::int AS n FROM fixture_officials fo
       WHERE fo.user_id = $1 AND fo.fee_currency IS NOT NULL ${whereExtra}`,
      params,
    )).n;

    return { entries: rows, total, limit, offset };
  },
});

// ── earnings aggregated by dimension ──────────────────────────────────────

cap({
  name: 'get_official_earnings_aggregated',
  method: 'GET',
  path: '/me/officials/earnings/summary-by',
  tag: TAG,
  summary: 'Aggregated earnings for the authenticated official grouped by sport, month, year, or event.',
  input: z.object({
    group_by: z.enum(['sport', 'month', 'year', 'event']),
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
  }),
  async handler({ user }, i) {
    const params = [user.id];
    const filters = [];
    if (i.currency) { params.push(i.currency); filters.push(`fo.fee_currency = $${params.length}`); }
    if (i.from) { params.push(i.from); filters.push(`fo.scheduled_at >= $${params.length}`); }
    if (i.to) { params.push(i.to); filters.push(`fo.scheduled_at <= $${params.length}`); }
    const whereExtra = filters.length ? `AND ${filters.join(' AND ')}` : '';

    let groupExpr, labelExpr, orderExpr;
    if (i.group_by === 'sport') {
      groupExpr = 's.id, s.name, s.emoji';
      labelExpr = "s.name AS label, s.emoji AS emoji, s.id AS group_id";
      orderExpr = 'paid_minor DESC';
    } else if (i.group_by === 'month') {
      groupExpr = "DATE_TRUNC('month', fo.scheduled_at)";
      labelExpr = "TO_CHAR(DATE_TRUNC('month', fo.scheduled_at), 'Mon YYYY') AS label, DATE_TRUNC('month', fo.scheduled_at)::text AS group_id, NULL::text AS emoji";
      orderExpr = 'group_id DESC';
    } else if (i.group_by === 'year') {
      groupExpr = "DATE_PART('year', fo.scheduled_at)";
      labelExpr = "DATE_PART('year', fo.scheduled_at)::text AS label, DATE_PART('year', fo.scheduled_at)::text AS group_id, NULL::text AS emoji";
      orderExpr = 'group_id DESC';
    } else {
      // event
      groupExpr = 'e.id, e.name';
      labelExpr = "e.name AS label, e.id AS group_id, NULL::text AS emoji";
      orderExpr = 'paid_minor DESC';
    }

    const rows = await many(
      `SELECT
         ${labelExpr},
         fo.fee_currency AS currency,
         COUNT(*)::int AS total_assignments,
         COALESCE(SUM(fo.fee_minor) FILTER (WHERE fo.pay_status = 'paid'), 0)::bigint AS paid_minor,
         COALESCE(SUM(fo.fee_minor) FILTER (WHERE fo.pay_status = 'due'), 0)::bigint AS due_minor,
         COALESCE(SUM(fo.fee_minor) FILTER (WHERE fo.pay_status = 'agreed'), 0)::bigint AS agreed_minor,
         COALESCE(SUM(fo.fee_minor) FILTER (WHERE fo.pay_status = 'disputed'), 0)::bigint AS disputed_minor
       FROM fixture_officials fo
       JOIN fixtures f ON f.id = fo.fixture_id
       JOIN events e ON e.id = f.event_id
       LEFT JOIN sports s ON s.id = fo.sport_id
       WHERE fo.user_id = $1
         AND fo.fee_currency IS NOT NULL
         AND fo.scheduled_at IS NOT NULL
         ${whereExtra}
       GROUP BY ${groupExpr}, fo.fee_currency
       ORDER BY ${orderExpr}`,
      params,
    );

    return { rows, group_by: i.group_by };
  },
});

// ── CSV export ─────────────────────────────────────────────────────────────

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

cap({
  name: 'export_official_earnings_csv',
  method: 'GET',
  path: '/me/officials/earnings/export',
  tag: TAG,
  summary: 'Export all assignment fees as a CSV for the authenticated official (optional date range). Every export is audit-logged.',
  input: z.object({
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
    pay_status: z.enum(['agreed', 'due', 'paid', 'disputed']).optional(),
  }),
  async handler({ user }, i) {
    const params = [user.id];
    const filters = [];
    if (i.from) { params.push(i.from); filters.push(`fo.scheduled_at >= $${params.length}`); }
    if (i.to) { params.push(i.to); filters.push(`fo.scheduled_at <= $${params.length}`); }
    if (i.currency) { params.push(i.currency); filters.push(`fo.fee_currency = $${params.length}`); }
    if (i.pay_status) { params.push(i.pay_status); filters.push(`fo.pay_status = $${params.length}`); }
    const whereExtra = filters.length ? `AND ${filters.join(' AND ')}` : '';

    const rows = await many(
      `SELECT
         fo.role,
         fo.pay_status,
         fo.fee_minor,
         fo.fee_currency,
         fo.scheduled_at,
         fo.pay_updated_at,
         fo.pay_confirmed_at,
         f.name AS fixture_name,
         e.name AS event_name,
         s.name AS sport_name,
         o.name AS organiser_name,
         pi.status AS payout_status,
         pi.net_minor AS payout_net_minor,
         pi.decided_at AS payout_date
       FROM fixture_officials fo
       JOIN fixtures f ON f.id = fo.fixture_id
       JOIN events e ON e.id = f.event_id
       LEFT JOIN sports s ON s.id = fo.sport_id
       LEFT JOIN organisations o ON o.id = e.org_id
       LEFT JOIN payout_items pi ON pi.id = fo.payout_item_id
       WHERE fo.user_id = $1
         AND fo.fee_currency IS NOT NULL
         ${whereExtra}
       ORDER BY fo.scheduled_at DESC NULLS LAST`,
      params,
    );

    await audit(null, user.id, 'export_official_earnings_csv', 'fixture_officials', null);

    const headers = ['Date', 'Fixture', 'Event', 'Sport', 'Organiser', 'Role', 'Currency', 'Fee (minor units)', 'Fee (major units)', 'Pay Status', 'Pay Updated', 'Confirmed At', 'Payout Status', 'Payout Net (minor)', 'Payout Date'];
    const csvLines = [
      headers.map(csvCell).join(','),
      ...rows.map((r) =>
        [
          r.scheduled_at ? new Date(r.scheduled_at).toISOString().slice(0, 10) : '',
          r.fixture_name,
          r.event_name,
          r.sport_name ?? '',
          r.organiser_name ?? '',
          r.role,
          r.fee_currency,
          r.fee_minor,
          r.fee_minor != null ? (r.fee_minor / 100).toFixed(2) : '',
          r.pay_status ?? '',
          r.pay_updated_at ? new Date(r.pay_updated_at).toISOString().slice(0, 10) : '',
          r.pay_confirmed_at ? new Date(r.pay_confirmed_at).toISOString().slice(0, 10) : '',
          r.payout_status ?? '',
          r.payout_net_minor ?? '',
          r.payout_date ? new Date(r.payout_date).toISOString().slice(0, 10) : '',
        ].map(csvCell).join(','),
      ),
    ];

    return {
      filename: `official-earnings-${new Date().toISOString().slice(0, 10)}.csv`,
      content_type: 'text/csv',
      encoding: 'utf8',
      content: csvLines.join('\r\n'),
    };
  },
});

// ── monthly trend (sparkline data) ────────────────────────────────────────

cap({
  name: 'get_official_earnings_trend',
  method: 'GET',
  path: '/me/officials/earnings/trend',
  tag: TAG,
  summary: 'Monthly paid-fee totals for the past N months for the authenticated official (default 24). Used for sparklines and trend charts.',
  input: z.object({
    months: z.coerce.number().int().min(3).max(60).default(24),
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  }),
  async handler({ user }, i) {
    const params = [user.id, i.months];
    const currencyClause = i.currency ? `AND fo.fee_currency = $3` : '';
    if (i.currency) params.push(i.currency);

    const rows = await many(
      `SELECT
         TO_CHAR(DATE_TRUNC('month', fo.scheduled_at), 'YYYY-MM') AS month,
         fo.fee_currency AS currency,
         COALESCE(SUM(fo.fee_minor) FILTER (WHERE fo.pay_status = 'paid'), 0)::bigint AS paid_minor,
         COALESCE(SUM(fo.fee_minor) FILTER (WHERE fo.pay_status = 'due'), 0)::bigint AS due_minor,
         COUNT(*) FILTER (WHERE fo.pay_status = 'paid')::int AS paid_count
       FROM fixture_officials fo
       WHERE fo.user_id = $1
         AND fo.fee_currency IS NOT NULL
         AND fo.scheduled_at >= DATE_TRUNC('month', now()) - ($2::int - 1) * INTERVAL '1 month'
         ${currencyClause}
       GROUP BY DATE_TRUNC('month', fo.scheduled_at), fo.fee_currency
       ORDER BY month ASC`,
      params,
    );

    return { trend: rows, months: i.months };
  },
});

// ── top event earners (for official's own context) ─────────────────────────

cap({
  name: 'list_official_top_events',
  method: 'GET',
  path: '/me/officials/earnings/top-events',
  tag: TAG,
  summary: 'Top 10 events by paid fees for the authenticated official.',
  input: z.object({
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
  }),
  async handler({ user }, i) {
    const params = [user.id];
    const filters = [];
    if (i.currency) { params.push(i.currency); filters.push(`fo.fee_currency = $${params.length}`); }
    if (i.from) { params.push(i.from); filters.push(`fo.scheduled_at >= $${params.length}`); }
    if (i.to) { params.push(i.to); filters.push(`fo.scheduled_at <= $${params.length}`); }
    const whereExtra = filters.length ? `AND ${filters.join(' AND ')}` : '';

    const rows = await many(
      `SELECT
         e.id AS event_id,
         e.name AS event_name,
         fo.fee_currency AS currency,
         COUNT(*)::int AS assignment_count,
         COALESCE(SUM(fo.fee_minor) FILTER (WHERE fo.pay_status = 'paid'), 0)::bigint AS paid_minor,
         MIN(fo.scheduled_at) AS first_fixture,
         MAX(fo.scheduled_at) AS last_fixture
       FROM fixture_officials fo
       JOIN fixtures f ON f.id = fo.fixture_id
       JOIN events e ON e.id = f.event_id
       WHERE fo.user_id = $1
         AND fo.fee_currency IS NOT NULL
         ${whereExtra}
       GROUP BY e.id, e.name, fo.fee_currency
       ORDER BY paid_minor DESC
       LIMIT 10`,
      params,
    );

    return { events: rows };
  },
});
