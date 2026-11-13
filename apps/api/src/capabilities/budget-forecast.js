// Sponsorship-budget forecasts and health reporting (#381 elite extension).
// A forecast is a scenario (best/base/worst/custom) that projects spend over monthly periods.
// get_budget_health gives an executive dashboard row per budget for the finance.js Budget Health tab.
import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { many, tx, pool } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { budgetFor, usageOf, KINDS } from '../sponsorship-budgets.js';
import { sponsorAccess, assertSponsorCan, actionsFor } from '../sponsor-access.js';
import { mustFind } from '../helpers.js';

const SCENARIOS = ['best', 'base', 'worst', 'custom'];
const SPREAD_METHODS = ['even', 's_curve', 'front', 'back', 'manual'];

const period = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM'),
  projected_cents: z.coerce.number().int().min(0),
  notes: z.string().trim().max(500).optional(),
});

/** Spread authorized_cents evenly across months (simple even distribution). */
function spreadEven(authorizedCents, months) {
  const base = Math.floor(authorizedCents / months.length);
  const rem = authorizedCents - base * months.length;
  return months.map((m, i) => ({ month: m, projected_cents: base + (i < rem ? 1 : 0) }));
}

/** Generate months from fiscal_year (Jan–Dec). */
function fiscalMonths(year) {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
}

/** Auto-spread when spread_method is set and no manual periods given. */
function autoSpread(method, authorized, year) {
  const months = fiscalMonths(year);
  if (method === 'even') return spreadEven(authorized, months);
  if (method === 'front') return months.map((m, i) => ({ month: m, projected_cents: i < 3 ? Math.round(authorized * 0.4 / 3) : i < 6 ? Math.round(authorized * 0.3 / 3) : Math.round(authorized * 0.3 / 6) }));
  if (method === 'back') return months.map((m, i) => ({ month: m, projected_cents: i >= 9 ? Math.round(authorized * 0.4 / 3) : i >= 6 ? Math.round(authorized * 0.3 / 3) : Math.round(authorized * 0.3 / 6) }));
  if (method === 's_curve') {
    // S-curve: slow/fast/slow pattern (10/15/25/25/15/10 weighted across halves)
    const weights = [0.04, 0.06, 0.08, 0.10, 0.12, 0.10, 0.12, 0.10, 0.10, 0.08, 0.06, 0.04];
    return months.map((m, i) => ({ month: m, projected_cents: Math.round(authorized * weights[i]) }));
  }
  return spreadEven(authorized, months);
}

cap({
  name: 'create_budget_forecast', method: 'POST', path: '/sponsorship-budgets/:id/forecasts', tag: 'Sponsors', status: 201,
  summary: 'Brand manager/finance: create a spend forecast for a budget. A scenario (best/base/worst) may exist only once per budget × fiscal year (409 if one already exists). `custom` scenarios may repeat. Provide `periods` manually or choose a `spread_method` to auto-generate them from the authorized amount. The projected total is stored and updated whenever a forecast is edited.',
  input: z.object({
    id, name: z.string().trim().min(2).max(160), scenario: z.enum(SCENARIOS).default('base'),
    fiscal_year: z.coerce.number().int().min(2000).max(2200),
    spread_method: z.enum(SPREAD_METHODS).optional(),
    periods: z.array(period).max(36).optional(),
    basis_actual_pct: z.coerce.number().min(0).max(999).optional(),
  }).refine((v) => v.periods?.length || v.spread_method, { message: 'Provide periods or a spread_method', path: ['periods'] }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { b } = await budgetFor(user, i.id, 'budget', c, false);
      if (b.status !== 'active') throw conflict('This budget is archived');
      let periods = i.periods ?? autoSpread(i.spread_method, Number(b.authorized_cents), i.fiscal_year);
      // Normalise: deduplicate by month (last wins), sort
      const byMonth = {};
      for (const p of periods) byMonth[p.month] = p;
      periods = Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month));
      const total = periods.reduce((s, p) => s + p.projected_cents, 0);
      const row = (await c.query(
        `INSERT INTO sponsorship_budget_forecasts(budget_id, name, scenario, fiscal_year, periods, total_projected_cents, basis_actual_pct, spread_method, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [b.id, i.name, i.scenario, i.fiscal_year, JSON.stringify(periods), total, i.basis_actual_pct ?? null, i.spread_method ?? null, user.id])
        .catch((e) => { if (e.code === '23505') throw conflict(`A ${i.scenario} forecast already exists for this budget in ${i.fiscal_year}; archive it first`); throw e; })).rows[0];
      await audit(c, user.id, 'create', 'sponsorship_budget_forecasts', row.id);
      return { ...row, total_projected_cents: Number(row.total_projected_cents) };
    });
  },
});

cap({
  name: 'list_budget_forecasts', method: 'GET', path: '/sponsorship-budgets/:id/forecasts', tag: 'Sponsors',
  summary: 'All active forecasts for a budget, newest fiscal year first. Visible to anyone with budget_read on the brand.',
  input: z.object({ id, fiscal_year: z.coerce.number().int().optional(), scenario: z.enum(SCENARIOS).optional(), ...page }),
  async handler({ user }, i) {
    await budgetFor(user, i.id, 'budget_read', pool);
    const rows = await many(
      `SELECT f.*, u.display_name AS created_by_name FROM sponsorship_budget_forecasts f JOIN users u ON u.id=f.created_by
        WHERE f.budget_id=$1 AND f.archived_at IS NULL
          AND ($2::int IS NULL OR f.fiscal_year=$2)
          AND ($3::text IS NULL OR f.scenario=$3)
        ORDER BY f.fiscal_year DESC, f.scenario, f.id
        LIMIT $4 OFFSET $5`,
      [i.id, i.fiscal_year ?? null, i.scenario ?? null, i.limit, i.offset]);
    return rows.map((r) => ({ ...r, total_projected_cents: Number(r.total_projected_cents) }));
  },
});

cap({
  name: 'update_budget_forecast', method: 'PATCH', path: '/sponsorship-budgets/:id/forecasts/:fid', tag: 'Sponsors',
  summary: 'Brand manager/finance: update a forecast\'s name, periods or spread method. The total_projected_cents is recalculated.',
  input: z.object({
    id, fid: id, name: z.string().trim().min(2).max(160).optional(),
    spread_method: z.enum(SPREAD_METHODS).nullable().optional(),
    periods: z.array(period).max(36).optional(),
    basis_actual_pct: z.coerce.number().min(0).max(999).nullable().optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { b } = await budgetFor(user, i.id, 'budget', c, false);
      const f = (await c.query('SELECT * FROM sponsorship_budget_forecasts WHERE id=$1 AND budget_id=$2 AND archived_at IS NULL', [i.fid, i.id])).rows[0];
      if (!f) throw notFound('Forecast');
      let periods = f.periods;
      if (i.periods) {
        const byMonth = {};
        for (const p of i.periods) byMonth[p.month] = p;
        periods = Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month));
      } else if (i.spread_method) {
        periods = autoSpread(i.spread_method, Number(b.authorized_cents), f.fiscal_year);
      }
      const total = periods.reduce((s, p) => s + p.projected_cents, 0);
      const row = (await c.query(
        `UPDATE sponsorship_budget_forecasts SET name=coalesce($2,name), periods=$3, total_projected_cents=$4, basis_actual_pct=coalesce($5,basis_actual_pct), spread_method=coalesce($6,spread_method), updated_at=now() WHERE id=$1 RETURNING *`,
        [f.id, i.name ?? null, JSON.stringify(periods), total, i.basis_actual_pct ?? null, i.spread_method ?? null])).rows[0];
      await audit(c, user.id, 'update', 'sponsorship_budget_forecasts', f.id);
      return { ...row, total_projected_cents: Number(row.total_projected_cents) };
    });
  },
});

cap({
  name: 'archive_budget_forecast', method: 'DELETE', path: '/sponsorship-budgets/:id/forecasts/:fid', tag: 'Sponsors', status: 200,
  summary: 'Brand manager/finance: archive (soft-delete) a forecast. The data is never erased.',
  input: z.object({ id, fid: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await budgetFor(user, i.id, 'budget', c, false);
      const f = (await c.query('SELECT * FROM sponsorship_budget_forecasts WHERE id=$1 AND budget_id=$2 AND archived_at IS NULL', [i.fid, i.id])).rows[0];
      if (!f) throw notFound('Forecast');
      await c.query('UPDATE sponsorship_budget_forecasts SET archived_at=now() WHERE id=$1', [f.id]);
      await audit(c, user.id, 'archive', 'sponsorship_budget_forecasts', f.id);
      return { archived: true, id: f.id };
    });
  },
});

cap({
  name: 'get_budget_health', method: 'GET', path: '/budget-health', tag: 'Sponsors',
  summary: 'Manager/finance/auditor: executive health dashboard for all budgets of one brand. Returns per-budget utilisation %, health band (healthy/warning/critical/over), lock status, pending alert count, plus an aggregate KPI strip. Powers the Budget Health tab in the finance screen.',
  input: z.object({ sponsor_id: id, fiscal_year: z.coerce.number().int().optional(), kind: z.enum(KINDS).optional() }),
  async handler({ user }, i) {
    // Authorization: anyone with budget_read on the brand
    const sp = await mustFind('sponsors', i.sponsor_id, '*', pool);
    if (!isAdmin(user)) {
      const access = await sponsorAccess(user, sp, pool);
      if (!access) throw notFound('Sponsor');
      assertSponsorCan(access, 'budget_read', { departmentId: null, what: 'see budget health' });
    }
    const budgets = (await pool.query(
      `SELECT b.* FROM sponsorship_budgets b WHERE b.sponsor_id=$1 AND b.status='active'
         AND ($2::int IS NULL OR b.fiscal_year=$2) AND ($3::text IS NULL OR b.kind=$3)
         ORDER BY b.fiscal_year DESC NULLS LAST, b.kind, lower(b.name)`,
      [i.sponsor_id, i.fiscal_year ?? null, i.kind ?? null])).rows;

    let totalAuthorized = 0, totalCommitted = 0, totalReserved = 0, totalAvailable = 0;
    let atRiskCount = 0, lockedCount = 0;
    const rows = [];
    for (const b of budgets) {
      const u = await usageOf(pool, b);
      const util = u.authorized_cents > 0 ? Math.round(((u.committed_cents + u.reserved_cents) / u.authorized_cents) * 100) : 0;
      const band = util >= 100 ? 'over' : util >= 90 ? 'critical' : util >= 70 ? 'warning' : 'healthy';
      const pendingAlerts = (await pool.query('SELECT count(*)::int AS n FROM sponsorship_budget_alert_events WHERE budget_id=$1 AND dismissed_at IS NULL', [b.id])).rows[0].n;
      const activeForecast = (await pool.query("SELECT id, name, total_projected_cents, scenario FROM sponsorship_budget_forecasts WHERE budget_id=$1 AND scenario='base' AND archived_at IS NULL ORDER BY fiscal_year DESC LIMIT 1", [b.id])).rows[0] ?? null;
      totalAuthorized += u.authorized_cents;
      totalCommitted += u.committed_cents;
      totalReserved += u.reserved_cents;
      totalAvailable += u.available_cents;
      if (util >= 90) atRiskCount++;
      if (b.locked_at) lockedCount++;
      rows.push({ id: b.id, name: b.name, kind: b.kind, fiscal_year: b.fiscal_year, currency: b.currency, cost_centre: b.cost_centre, authorized_cents: u.authorized_cents, committed_cents: u.committed_cents, reserved_cents: u.reserved_cents, available_cents: u.available_cents, utilisation_pct: util, health_band: band, locked: !!b.locked_at, locked_at: b.locked_at, pending_alerts: pendingAlerts, grant_restricted: b.grant_restricted, active_forecast: activeForecast ? { ...activeForecast, total_projected_cents: Number(activeForecast.total_projected_cents) } : null });
    }

    // Top 5 at-risk (by utilisation desc)
    const atRisk = [...rows].filter((r) => r.utilisation_pct >= 90).sort((a, b) => b.utilisation_pct - a.utilisation_pct).slice(0, 5);
    const commitPct = totalAuthorized > 0 ? Math.round((totalCommitted / totalAuthorized) * 100) : 0;
    const reservePct = totalAuthorized > 0 ? Math.round((totalReserved / totalAuthorized) * 100) : 0;
    return {
      kpi: { total_authorized_cents: totalAuthorized, committed_pct: commitPct, reserved_pct: reservePct, available_cents: totalAvailable, at_risk_count: atRiskCount, locked_count: lockedCount },
      budgets: rows,
      at_risk: atRisk,
    };
  },
});
