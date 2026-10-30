// Unified Sports Analytics & Semantic Metrics Layer (#596). One governed definition of each shared KPI (src/kpi/catalogue.js), computed live from the
// canonical tables by one engine, so REST, MCP, dashboards, exports and scheduled reports return the same figure with the same provenance.
// This is the single home for cross-domain KPIs; the domain reports (sponsorship reports, partner finance, event and academy consoles) keep their
// domain-specific views and read governed numbers from here. (Per-sport scoring rules are a different thing: see metric-governance.js.)
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { conflict, notFound, unprocessable } from '../errors.js';
import { audit } from '../helpers.js';
import { exportReport } from '../sponsor-report-export.js';
import { kitOf, loadLogo, mustAccess } from './branded-documents.js';
import { METRICS, SCOPE_TYPES, byKey, describeMetric } from '../kpi/catalogue.js';
import { DIMENSIONS, computeKpi, definitionHistory, kpiRecords, listScopes, syncCatalogue } from '../kpi/engine.js';
import { COLS, canView, checkSharing, checkWidgets, listMine, loadDashboard, runWidgets, toReport } from '../kpi/service.js';

const TAG = 'Analytics';
const date = z.string().date();
const metricKey = z.string().min(2).max(60);
const scopeType = z.enum(SCOPE_TYPES);
const list = z.preprocess((v) => (typeof v === 'string' ? (v === '' ? undefined : v.split(',')) : v), z.array(z.string().uuid()).max(20).optional());
const preset = z.enum(['last_7', 'last_30', 'last_90', 'year_to_date', 'custom']);
const dim = z.enum(Object.keys(DIMENSIONS));
const SCOPE = { scope_type: scopeType, scope_id: id.optional().describe('the organisation, venue, event, team or brand (not needed for the whole platform)') };
const PERIOD = { preset: preset.default('last_30'), from: date.optional(), to: date.optional(), sport_ids: list.describe('limit to these sports (comma separated ids)') };
const query = (i) => ({ scope: { type: i.scope_type, id: i.scope_id }, range: { preset: i.preset, from: i.from, to: i.to }, sport_ids: i.sport_ids, group_by: i.group_by });
const widget = z.object({ id: z.string().min(1).max(40).optional(), metric: metricKey, scope_type: scopeType, scope_id: id.optional(), group_by: dim.optional(), title: z.string().max(80).optional() });
const fileOf = (f) => ({ filename: f.filename, content_type: f.type, encoding: typeof f.body === 'string' ? 'utf8' : 'base64', content: typeof f.body === 'string' ? f.body : f.body.toString('base64') });
const today = () => new Date().toISOString().slice(0, 10);

async function brandOf(user, kitId) {
  if (!kitId) return {};
  const kit = await kitOf(kitId);
  await mustAccess(user, kit, 'Brand kit');
  return { kit, logo: await loadLogo(kit.logo_asset_id) };
}
const dashboardOut = (d, user) => ({ ...d, mine: d.owner_id === user.id });

// ---- the governed catalogue -------------------------------------------------------------------------------------------------------
cap({
  name: 'list_kpi_catalogue', method: 'GET', path: '/analytics/metrics', tag: TAG,
  summary: 'The governed metric catalogue: every shared sports and business KPI (active athletes, registered participants, matches played, attendees, revenue, receivable, sponsor value and fulfilment, venue utilisation, athlete availability) with its current version, formula, owner, dimensions, data sources and the scope types it can be reported for. Every module quotes these definitions instead of defining its own.',
  async handler() {
    await syncCatalogue();
    return METRICS.map(describeMetric);
  },
});

cap({
  name: 'get_kpi_definition', method: 'GET', path: '/analytics/metrics/:key', tag: TAG,
  summary: 'One governed metric with every version ever published (newest first): formula, owner, provenance sources, dimensions and audience. Definitions are append-only; a changed formula is a new version and old versions stay readable so any quoted figure can be traced to the formula that produced it.',
  input: z.object({ key: metricKey }),
  async handler(_, { key }) {
    const m = byKey(key);
    if (!m) throw notFound('Metric');
    return { ...describeMetric(m), versions: await definitionHistory(key) };
  },
});

cap({
  name: 'list_kpi_scopes', method: 'GET', path: '/analytics/scopes', tag: TAG,
  summary: 'Everything you can report on, read live from your current roles: your organisations (by role), venues, events you organise, teams you manage, brands you run, and the whole platform for platform administrators. Use it to fill a scope picker.',
  handler: ({ user }) => listScopes(user),
});

// ---- values and drill-down ----------------------------------------------------------------------------------------------------------
cap({
  name: 'get_kpi_value', method: 'GET', path: '/analytics/metrics/:key/value', tag: TAG,
  summary: 'Compute a governed metric for a scope and period. Returns the figure (money per currency, never summed across currencies), optional groups (sport, event, venue, team, month or channel), the definition version and hash used, scope, period, a reference and digest two callers can compare, per-source freshness (current, stale or no records) and data-quality warnings. Read live under your current role: a scope you cannot read is 404, and a role too narrow for the metric is 403.',
  input: z.object({ key: metricKey, ...SCOPE, ...PERIOD, group_by: dim.optional() }).refine((i) => i.preset !== 'custom' || (i.from && i.to), 'Give both dates for a custom period'),
  handler: ({ user }, i) => computeKpi(user, i.key, query(i)),
});

cap({
  name: 'list_kpi_records', method: 'GET', path: '/analytics/metrics/:key/records', tag: TAG,
  summary: 'Drill down from a figure to the source records it is made of (invoices, games, registrations, check-ins, deliverables...), with a link to each record. It reads the very same facts as get_kpi_value, so the totals returned reconcile to the figure. Narrow to one group with group_by and group_key, or one currency. Every drill-down is audit-logged; athlete availability is aggregate-only outside a team you manage.',
  input: z.object({ key: metricKey, ...SCOPE, ...PERIOD, group_by: dim.optional(), group_key: z.string().max(80).optional(), currency: z.string().length(3).toUpperCase().optional(), ...page }),
  async handler({ user }, i) {
    const out = await kpiRecords(user, i.key, { ...query(i), group_key: i.group_key, currency: i.currency }, { limit: i.limit, offset: i.offset });
    await audit(null, user.id, 'kpi_drilldown', `kpi_${i.key}`, i.scope_id ?? null);
    return out;
  },
});

// ---- dashboards ---------------------------------------------------------------------------------------------------------------------
const DASH = {
  title: z.string().min(1).max(80),
  visibility: z.enum(['private', 'organisation', 'roles']).default('private'),
  organisation_id: id.optional(), roles: z.array(z.string().min(2).max(30)).max(8).default([]),
  range_preset: preset.default('last_30'), range_from: date.optional(), range_to: date.optional(), sport_ids: z.array(id).max(20).default([]),
  widgets: z.array(widget).max(12).default([]),
};

cap({
  name: 'create_kpi_dashboard', method: 'POST', path: '/analytics/dashboards', tag: TAG, status: 201,
  summary: 'Save a dashboard: a titled set of tiles (each a governed metric for a scope, optionally split by a dimension) sharing one period and sport filter. A tile you cannot read now is refused. Share it privately, with an organisation you run, or with platform roles you hold. Only the recipe is stored; every viewer sees the figures their own role allows.',
  input: z.object(DASH),
  async handler({ user }, i) {
    if (i.range_preset === 'custom' && !(i.range_from && i.range_to)) throw unprocessable('Give both dates for a custom period');
    await checkSharing(user, i);
    const widgets = await checkWidgets(user, i.widgets);
    const row = await one(
      `INSERT INTO kpi_dashboards(owner_id, title, visibility, organisation_id, roles, range_preset, range_from, range_to, sport_ids, widgets)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [user.id, i.title.trim(), i.visibility, i.visibility === 'organisation' ? i.organisation_id : null, i.visibility === 'roles' ? i.roles : [], i.range_preset,
        i.range_preset === 'custom' ? i.range_from : null, i.range_preset === 'custom' ? i.range_to : null, i.sport_ids, JSON.stringify(widgets)]);
    return dashboardOut(await one(`SELECT ${COLS} FROM kpi_dashboards d WHERE d.id=$1`, [row.id]), user);
  },
});

cap({
  name: 'list_kpi_dashboards', method: 'GET', path: '/analytics/dashboards', tag: TAG,
  summary: 'Dashboards you can open: your own, those shared with an organisation you belong to, and those shared with a role you hold. Recipes only; open one to see its figures.',
  async handler({ user }) {
    return (await listMine(user)).map((d) => ({ ...d, widgets: undefined, tile_count: d.widgets.length, mine: d.mine }));
  },
});

cap({
  name: 'get_kpi_dashboard', method: 'GET', path: '/analytics/dashboards/:id', tag: TAG,
  summary: 'Open a dashboard and compute every tile under YOUR current access. A tile whose scope you cannot read comes back as an explained gap, never as a zero or as the owner\'s number. Pass as_of to see the period as it stood on an earlier date. `quality` summarises hidden tiles, stale sources and warnings.',
  input: z.object({ id, as_of: date.optional() }),
  async handler({ user }, i) {
    const d = await loadDashboard(user, i.id);
    return { dashboard: dashboardOut(d, user), ...(await runWidgets(user, d, i.as_of)) };
  },
});

cap({
  name: 'update_kpi_dashboard', method: 'PATCH', path: '/analytics/dashboards/:id', tag: TAG,
  summary: 'Change a dashboard you own (title, sharing, period, sports or tiles). Send row_version; if someone changed it meanwhile you get 409 and nothing is overwritten.',
  input: z.object({ id, row_version: z.number().int().min(1), ...Object.fromEntries(Object.entries(DASH).map(([k, v]) => [k, v.optional()])) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const d = (await c.query('SELECT * FROM kpi_dashboards WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [i.id])).rows[0];
      if (!d || d.owner_id !== user.id) throw notFound('Dashboard');
      if (d.row_version !== i.row_version) throw conflict('This dashboard was changed since you opened it. Reload and apply your change again.', { current_row_version: d.row_version });
      const next = { visibility: i.visibility ?? d.visibility, organisation_id: i.organisation_id ?? d.organisation_id, roles: i.roles ?? d.roles, range_preset: i.range_preset ?? d.range_preset,
        range_from: i.range_from ?? d.range_from?.toISOString?.().slice(0, 10) ?? d.range_from, range_to: i.range_to ?? d.range_to?.toISOString?.().slice(0, 10) ?? d.range_to };
      if (next.range_preset === 'custom' && !(next.range_from && next.range_to)) throw unprocessable('Give both dates for a custom period');
      await checkSharing(user, next);
      const widgets = i.widgets ? await checkWidgets(user, i.widgets) : d.widgets;
      await c.query(
        `UPDATE kpi_dashboards SET title=$2, visibility=$3, organisation_id=$4, roles=$5, range_preset=$6, range_from=$7, range_to=$8, sport_ids=$9, widgets=$10, row_version=row_version+1, updated_at=now() WHERE id=$1`,
        [d.id, (i.title ?? d.title).trim(), next.visibility, next.visibility === 'organisation' ? next.organisation_id : null, next.visibility === 'roles' ? next.roles : [], next.range_preset,
          next.range_preset === 'custom' ? next.range_from : null, next.range_preset === 'custom' ? next.range_to : null, i.sport_ids ?? d.sport_ids, JSON.stringify(widgets)]);
      return dashboardOut((await c.query(`SELECT ${COLS} FROM kpi_dashboards d WHERE d.id=$1`, [d.id])).rows[0], user);
    });
  },
});

cap({
  name: 'archive_kpi_dashboard', method: 'POST', path: '/analytics/dashboards/:id/archive', tag: TAG,
  summary: 'Archive a dashboard you own (it is hidden and its schedules stop; nothing is deleted).',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const d = (await c.query('SELECT * FROM kpi_dashboards WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [i.id])).rows[0];
      if (!d || d.owner_id !== user.id) throw notFound('Dashboard');
      await c.query('UPDATE kpi_dashboards SET archived_at=now(), row_version=row_version+1 WHERE id=$1', [d.id]);
      await c.query('UPDATE kpi_report_schedules SET archived_at=now() WHERE dashboard_id=$1 AND archived_at IS NULL', [d.id]);
      return { id: d.id, archived: true };
    });
  },
});

// ---- export -------------------------------------------------------------------------------------------------------------------------
cap({
  name: 'export_kpi_report', method: 'GET', path: '/analytics/export', tag: TAG,
  summary: 'Export as CSV, XLSX or a branded PDF (pass kit_id). Give a dashboard_id for the whole board, or one metric with its scope and period. It is built from the same engine output as the screen, so it reconciles exactly, under your live access (tiles you cannot read are left out and counted). Amounts are minor units with their currency; each row carries the definition version and reference. Returns { filename, content_type, encoding, content }.',
  input: z.object({
    dashboard_id: id.optional(), as_of: date.optional(), key: metricKey.optional(), scope_type: scopeType.optional(), scope_id: id.optional(), ...PERIOD, group_by: dim.optional(),
    format: z.enum(['csv', 'xlsx', 'pdf']).default('csv'), kit_id: id.optional(),
  }),
  async handler({ user }, i) {
    let d, title;
    if (i.dashboard_id) { d = await loadDashboard(user, i.dashboard_id); title = d.title; } else {
      if (!i.key || !i.scope_type) throw unprocessable('Give a dashboard_id, or a metric key with a scope');
      const m = byKey(i.key);
      if (!m) throw notFound('Metric');
      d = { range_preset: i.preset, range_from: i.from, range_to: i.to, sport_ids: i.sport_ids ?? [], widgets: [{ id: 'x', metric: i.key, scope_type: i.scope_type, scope_id: i.scope_id ?? null, group_by: i.group_by ?? null }] };
      title = m.label;
    }
    const brand = i.format === 'pdf' ? await brandOf(user, i.kit_id) : {};
    const ev = await runWidgets(user, d, i.as_of);
    if (!i.dashboard_id && !ev.quality.readable) throw ev.tiles[0].error.status === 404 ? notFound('Scope') : unprocessable(ev.tiles[0].error.message);
    const report = toReport(title, ev, i.as_of ?? today());
    await audit(null, user.id, 'export', 'kpi_report', i.dashboard_id ?? null);
    return { ...fileOf(await exportReport(report, i.format, brand)), as_of: report.basis.as_of, rows: report.rows.length, hidden_tiles: ev.quality.hidden };
  },
});

// ---- scheduled reports --------------------------------------------------------------------------------------------------------------
const SCHEDULE_COLS = "s.id, s.dashboard_id, d.title AS dashboard_title, s.cadence, s.format, s.recipient_ids, s.next_run_on::text AS next_run_on, s.last_run_on::text AS last_run_on, s.row_version, s.paused_at, s.created_at, s.updated_at";
const scheduleRow = (id_) => one(`SELECT ${SCHEDULE_COLS} FROM kpi_report_schedules s JOIN kpi_dashboards d ON d.id=s.dashboard_id WHERE s.id=$1`, [id_]);
const recipients = z.array(id).min(1).max(20);

cap({
  name: 'create_kpi_report_schedule', method: 'POST', path: '/analytics/schedules', tag: TAG, status: 201,
  summary: 'Deliver a dashboard on a weekly, monthly or quarterly cadence. Each recipient is notified (no figures in the message) and opens the report built under THEIR access at that moment; someone who lost access gets a skipped run and no notice. Recipients must be able to open the dashboard now. first_run_on defaults to tomorrow.',
  input: z.object({ dashboard_id: id, cadence: z.enum(['weekly', 'monthly', 'quarterly']), format: z.enum(['csv', 'xlsx', 'pdf']).default('pdf'), recipient_ids: recipients.optional(), first_run_on: date.optional() }),
  async handler({ user }, i) {
    const d = await loadDashboard(user, i.dashboard_id);
    if (d.owner_id !== user.id) throw notFound('Dashboard');
    const rec = [...new Set(i.recipient_ids ?? [user.id])];
    for (const r of rec) {
      const u = await one('SELECT id, roles FROM users WHERE id=$1', [r]);
      if (!u || !(await canView(u, d))) throw unprocessable('Every recipient must be able to open this dashboard. Share it with them first.');
    }
    const first = i.first_run_on ?? new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    if (first <= today()) throw unprocessable('The first delivery must be in the future');
    const r = await one('INSERT INTO kpi_report_schedules(dashboard_id, owner_id, cadence, format, recipient_ids, next_run_on) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [d.id, user.id, i.cadence, i.format, rec, first]);
    return scheduleRow(r.id);
  },
});

cap({
  name: 'list_kpi_report_schedules', method: 'GET', path: '/analytics/schedules', tag: TAG,
  summary: 'Your scheduled analytics reports.', input: z.object({ ...page }),
  handler: ({ user }, i) => many(`SELECT ${SCHEDULE_COLS} FROM kpi_report_schedules s JOIN kpi_dashboards d ON d.id=s.dashboard_id WHERE s.owner_id=$1 AND s.archived_at IS NULL ORDER BY s.next_run_on, s.id LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]),
});

cap({
  name: 'update_kpi_report_schedule', method: 'PATCH', path: '/analytics/schedules/:id', tag: TAG,
  summary: 'Change, pause/resume or archive a scheduled report. Send row_version for the optimistic lock.',
  input: z.object({ id, row_version: z.number().int().min(1), cadence: z.enum(['weekly', 'monthly', 'quarterly']).optional(), format: z.enum(['csv', 'xlsx', 'pdf']).optional(), recipient_ids: recipients.optional(), paused: z.boolean().optional(), archived: z.boolean().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s = (await c.query('SELECT * FROM kpi_report_schedules WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [i.id])).rows[0];
      if (!s || s.owner_id !== user.id) throw notFound('Schedule');
      if (s.row_version !== i.row_version) throw conflict('This schedule changed since you opened it. Reload and try again.', { current_row_version: s.row_version });
      if (i.recipient_ids) {
        const d = await loadDashboard(user, s.dashboard_id);
          for (const r of i.recipient_ids) { const u = (await c.query('SELECT id, roles FROM users WHERE id=$1', [r])).rows[0]; if (!u || !(await canView(u, d))) throw unprocessable('Every recipient must be able to open this dashboard.'); }
      }
      await c.query(
        `UPDATE kpi_report_schedules SET cadence=coalesce($2,cadence), format=coalesce($3,format), recipient_ids=coalesce($4,recipient_ids),
           paused_at=CASE WHEN $5::boolean IS NULL THEN paused_at WHEN $5 THEN coalesce(paused_at, now()) ELSE NULL END,
           next_run_on=CASE WHEN $5 IS FALSE AND next_run_on <= current_date THEN current_date + 1 ELSE next_run_on END,
           archived_at=CASE WHEN $6::boolean THEN now() ELSE archived_at END, row_version=row_version+1, updated_at=now() WHERE id=$1`,
        [s.id, i.cadence ?? null, i.format ?? null, i.recipient_ids ?? null, i.paused ?? null, i.archived ?? false]);
      return (await c.query(`SELECT ${SCHEDULE_COLS} FROM kpi_report_schedules s JOIN kpi_dashboards d ON d.id=s.dashboard_id WHERE s.id=$1`, [s.id])).rows[0];
    });
  },
});

cap({
  name: 'list_kpi_report_runs', method: 'GET', path: '/analytics/runs', tag: TAG,
  summary: 'Scheduled analytics reports prepared for you, newest first. A run is a pointer, not a copy: opening it recomputes the dashboard as of the run date under your access today.',
  input: z.object({ ...page }),
  handler: ({ user }, i) => many(
    `SELECT r.id, r.schedule_id, r.period_on::text AS period_on, r.status, r.widget_count, r.definitions, r.created_at, d.id AS dashboard_id, d.title AS dashboard_title, s.format
       FROM kpi_report_runs r JOIN kpi_report_schedules s ON s.id=r.schedule_id JOIN kpi_dashboards d ON d.id=s.dashboard_id WHERE r.recipient_id=$1 ORDER BY r.period_on DESC, r.id LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]),
});

cap({
  name: 'get_kpi_report_run', method: 'GET', path: '/analytics/runs/:id', tag: TAG,
  summary: 'Open a scheduled report: the dashboard computed as of the run date under your live access, together with the definition versions the run was prepared under (so a change of formula since is visible).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one(
      `SELECT r.*, r.period_on::text AS period_text, s.dashboard_id, s.format FROM kpi_report_runs r JOIN kpi_report_schedules s ON s.id=r.schedule_id WHERE r.id=$1 AND r.recipient_id=$2`, [i.id, user.id]);
    if (!r) throw notFound('Report');
    const d = await loadDashboard(user, r.dashboard_id);
    const ev = await runWidgets(user, d, r.period_text);
    const changed = (r.definitions ?? []).filter((p) => ev.tiles.some((t) => t.result && t.result.definition.key === p.metric && t.result.definition.version !== p.version)).map((p) => p.metric);
    return { run: { id: r.id, period_on: r.period_text, status: r.status, format: r.format, prepared_under: r.definitions, definitions_changed_since: changed }, dashboard: dashboardOut(d, user), ...ev };
  },
});
