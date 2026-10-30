// Dashboards, exports and scheduled delivery for the semantic layer (#596). Everything stored here is a recipe (which governed metric, which scope,
// which period); the figures are recomputed by the engine under the viewer's live access every time, so a shared dashboard shows each person only
// what they may see, and a revoked role stops showing data at once.
import { many, one, tx } from '../db.js';
import { AppError, forbidden, notFound, unprocessable } from '../errors.js';
import { isAdmin } from '../helpers.js';
import { notify } from '../notify.js';
import { toMajor } from '../currency.js';
import { nextRun } from '../sponsor-report-schedules.js';
import { byKey } from './catalogue.js';
import { computeKpi, resolveRange, resolveScope, syncCatalogue } from './engine.js';

export const MAX_WIDGETS = 12;
const today = () => new Date().toISOString().slice(0, 10);
const NOT_SHARABLE = new Set(['admin', 'platform_admin']);

/** A widget's recipe -> the engine's query. The dashboard's period and sports apply to every widget so the whole board speaks about one period. */
export const queryOf = (w, d, anchor) => ({ scope: { type: w.scope_type, id: w.scope_id }, range: { preset: d.range_preset, from: d.range_from, to: d.range_to }, sport_ids: d.sport_ids ?? [], group_by: w.group_by, as_of: anchor });

/** Validate a widget list for the person saving it: every metric must exist and every scope must be readable by them now. */
export async function checkWidgets(user, widgets) {
  if (widgets.length > MAX_WIDGETS) throw unprocessable(`A dashboard holds at most ${MAX_WIDGETS} tiles`);
  const out = [];
  for (const w of widgets) {
    const m = byKey(w.metric);
    if (!m) throw unprocessable(`Unknown metric "${w.metric}"`);
    if (w.group_by && !m.dimensions.includes(w.group_by)) throw unprocessable(`"${m.label}" cannot be split by ${w.group_by}`);
    await resolveScope(user, { type: w.scope_type, id: w.scope_id }, m);
    out.push({ id: w.id ?? Math.random().toString(36).slice(2, 10), metric: w.metric, scope_type: w.scope_type, scope_id: w.scope_id ?? null, group_by: w.group_by ?? null, title: w.title ?? null });
  }
  return out;
}

/** Evaluate every tile under the caller's access. A tile they may not read comes back as an explained gap, never as a zero and never as someone else's number. */
export async function runWidgets(user, d, anchor) {
  const tiles = [];
  for (const w of d.widgets) {
    try {
      tiles.push({ widget: w, result: await computeKpi(user, w.metric, queryOf(w, d, anchor)), error: null });
    } catch (e) {
      if (!(e instanceof AppError) || e.status >= 500) throw e;
      tiles.push({ widget: w, result: null, error: { status: e.status, code: e.status === 404 ? 'not_found' : e.status === 403 ? 'forbidden' : 'not_applicable', message: e.status === 404 ? 'You no longer have access to this scope.' : e.message } });
    }
  }
  const results = tiles.filter((t) => t.result);
  const stale = results.flatMap((t) => t.result.sources.filter((s) => s.status === 'stale')).length;
  const warnings = results.reduce((a, t) => a + t.result.warnings.filter((x) => x.severity === 'warn').length, 0);
  return { tiles, quality: { tiles: tiles.length, readable: results.length, hidden: tiles.length - results.length, stale_sources: stale, warnings, clean: stale === 0 && warnings === 0 && results.length === tiles.length } };
}

// ---------------------------------------------------------------- dashboard access
export const COLS = 'd.id, d.owner_id, d.title, d.visibility, d.organisation_id, d.roles, d.range_preset, d.range_from::text AS range_from, d.range_to::text AS range_to, d.sport_ids, d.widgets, d.row_version, d.created_at, d.updated_at';

/** Owner, a member of the organisation it is shared with, or a holder of one of the roles it is shared with. Anyone else gets a 404. */
export async function canView(user, d) {
  if (d.owner_id === user.id) return true;
  if (d.visibility === 'organisation') return !!(await one("SELECT 1 FROM organisation_members m JOIN organisations o ON o.id=m.organisation_id WHERE m.organisation_id=$1 AND m.user_id=$2 AND m.status='active' AND o.status='active'", [d.organisation_id, user.id]));
  if (d.visibility === 'roles') return d.roles.some((r) => (user.roles ?? []).includes(r));
  return false;
}
export async function loadDashboard(user, id) {
  const d = await one(`SELECT ${COLS} FROM kpi_dashboards d WHERE d.id=$1 AND d.archived_at IS NULL`, [id]);
  if (!d || !(await canView(user, d))) throw notFound('Dashboard');
  return d;
}
/** Who may share a dashboard: to an organisation you run, or to platform roles you hold yourself. */
export async function checkSharing(user, v) {
  if (v.visibility === 'organisation') {
    if (!v.organisation_id) throw unprocessable('Pick the organisation to share with');
    const ok = isAdmin(user) || (await one("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active' AND role = ANY($3)", [v.organisation_id, user.id, ['owner', 'admin', 'manager', 'finance']]));
    if (!ok) throw forbidden('Only an owner, admin, manager or finance lead of the organisation can share a dashboard with it');
  }
  if (v.visibility === 'roles') {
    if (!v.roles?.length) throw unprocessable('Pick at least one role to share with');
    if (v.roles.some((r) => NOT_SHARABLE.has(r))) throw unprocessable('A dashboard cannot be shared by platform-administrator role');
    if (!isAdmin(user) && v.roles.some((r) => !(user.roles ?? []).includes(r))) throw forbidden('You can only share a dashboard with roles you hold yourself');
  }
}

// ---------------------------------------------------------------- export (the same engine output, flattened)
const COLUMNS = [
  { key: 'metric', label: 'Metric', type: 'text' }, { key: 'scope', label: 'Scope', type: 'text' }, { key: 'period', label: 'Period', type: 'text' }, { key: 'group', label: 'Group', type: 'text' },
  { key: 'display', label: 'Value', type: 'text' }, { key: 'value', label: 'Number', type: 'text' }, { key: 'unit', label: 'Unit', type: 'text' }, { key: 'currency', label: 'Currency', type: 'text' },
  { key: 'numerator', label: 'Numerator', type: 'text' }, { key: 'denominator', label: 'Denominator', type: 'text' }, { key: 'version', label: 'Definition', type: 'text' }, { key: 'reference', label: 'Reference', type: 'text' },
];
export const display = (r, row) => (r.unit === 'percent' ? (row.value == null ? 'hidden' : `${row.value}%`) : r.unit === 'money' ? `${toMajor(row.cents, row.currency)} ${row.currency}` : String(row.value));
function rowsOf(t) {
  const r = t.result, base = { metric: r.definition.label, scope: r.scope.label, period: r.definition.point_in_time ? 'as of now' : `${r.range.from} to ${r.range.to}`, unit: r.unit, version: `v${r.definition.version}`, reference: r.reference };
  const flat = (label, x) => (r.unit === 'money'
    ? (x.amounts.length ? x.amounts : [{ currency: '', cents: 0 }]).map((a) => ({ ...base, group: label, display: a.currency ? display(r, { cents: a.cents, currency: a.currency }) : '0', value: a.cents, currency: a.currency }))
    : [{ ...base, group: label, display: display(r, x), value: x.value ?? '', currency: '', numerator: x.numerator ?? '', denominator: x.denominator ?? '' }]);
  return [...flat(r.group_by ? 'All' : '', r), ...(r.groups ?? []).flatMap((g) => flat(g.label, g))];
}
/** @returns the report object the CSV / XLSX / PDF builders already understand (same shape as the sponsorship reports). */
export function toReport(title, evaluated, asOf) {
  const results = evaluated.tiles.filter((t) => t.result);
  const sources = results.flatMap((t) => t.result.sources.map((s) => ({ key: `${t.widget.metric}.${s.key}`, label: `${t.result.definition.label}: ${s.label}`, status: s.status === 'current' ? 'ok' : s.status === 'stale' ? 'stale' : 'missing', detail: s.status === 'no_records' ? 'no records in this scope and period' : `${s.records} records, newest ${s.latest_at ? String(s.latest_at).slice(0, 10) : 'n/a'}` })));
  return {
    kind: 'kpi', view: 'analytics', title, columns: COLUMNS, rows: results.flatMap(rowsOf), totals: [{ tiles: evaluated.quality.tiles, readable: evaluated.quality.readable, hidden: evaluated.quality.hidden }],
    basis: { as_of: asOf, currency_basis: 'native', currency: null, generated_at: new Date().toISOString(), notes: [
      'Every figure comes from a governed metric definition (version and reference shown per row) computed live from the source records; nothing is copied.', 'Amounts are in each currency apart and are never added across currencies.',
      ...(evaluated.quality.hidden ? [`${evaluated.quality.hidden} tile(s) are left out because you cannot read their scope.`] : []), ...results.flatMap((t) => t.result.warnings.filter((w) => w.severity === 'warn').map((w) => `${t.result.definition.label}: ${w.text}`))] },
    sources, reconciles: true,
  };
}

// ---------------------------------------------------------------- scheduled delivery
/** Prepare and announce every due scheduled analytics report. One row per (schedule, period, recipient) makes the sweep safe to repeat. */
export async function deliverDueKpiReports(limit = 25) {
  await syncCatalogue();
  let made = 0;
  for (let i = 0; i < limit; i++) {
    const n = await tx(async (c) => {
      const s = (await c.query(
        `SELECT s.id AS schedule_id, s.recipient_ids, s.cadence, s.next_run_on::text AS period_on, d.id AS dashboard_id, ${COLS}
           FROM kpi_report_schedules s JOIN kpi_dashboards d ON d.id=s.dashboard_id
          WHERE s.archived_at IS NULL AND s.paused_at IS NULL AND d.archived_at IS NULL AND s.next_run_on <= current_date
          ORDER BY s.next_run_on, s.id LIMIT 1 FOR UPDATE OF s SKIP LOCKED`)).rows[0];
      if (!s) return null;
      let runs = 0;
      for (const rid of s.recipient_ids) {
        const claim = await c.query("INSERT INTO kpi_report_runs(schedule_id, period_on, recipient_id, status) VALUES ($1,$2,$3,'delivered') ON CONFLICT (schedule_id, period_on, recipient_id) DO NOTHING RETURNING id", [s.schedule_id, s.period_on, rid]);
        if (!claim.rowCount) continue;
        const runId = claim.rows[0].id;
        const user = await c.query('SELECT id, roles FROM users WHERE id=$1', [rid]).then((r) => r.rows[0]);
        try {
          if (!user || !(await canView(user, s))) throw forbidden('No access to the dashboard');
          const ev = await runWidgets(user, s, s.period_on);
          if (!ev.quality.readable) throw forbidden('None of the tiles can be read with your current access');
          await c.query('UPDATE kpi_report_runs SET widget_count=$2, definitions=$3 WHERE id=$1', [runId, ev.quality.readable,
            JSON.stringify(ev.tiles.filter((t) => t.result).map((t) => ({ metric: t.result.definition.key, version: t.result.definition.version, definition_hash: t.result.definition.definition_hash })))]);
          await notify(c, rid, { kind: 'kpi_report', title: `Your analytics report “${s.title}” is ready`, body: `Open Analytics to view it as of ${s.period_on}. Figures are not included in this message.`,
            data: { kpi_report_run_id: runId, schedule_id: s.schedule_id, dashboard_id: s.dashboard_id }, dedupe_key: `kpi_report:${s.schedule_id}:${s.period_on}:${rid}` });
          runs++;
        } catch (e) {
          if (!(e instanceof AppError) || e.status >= 500) throw e; // a transient failure rolls the sweep back and is retried next cycle
          await c.query('UPDATE kpi_report_runs SET status=$2, error=$3 WHERE id=$1', [runId, e.status === 403 || e.status === 404 ? 'skipped_no_access' : 'failed', String(e.message).slice(0, 300)]);
        }
      }
      await c.query('UPDATE kpi_report_schedules SET last_run_on=next_run_on, next_run_on=$2, updated_at=now() WHERE id=$1', [s.schedule_id, nextRun(s.period_on, s.cadence, today())]);
      return { runs };
    });
    if (!n) break;
    made += n.runs;
  }
  return made;
}
export { resolveRange };
export const listMine = (user) => many(
  `SELECT ${COLS}, (d.owner_id = $1) AS mine FROM kpi_dashboards d
    WHERE d.archived_at IS NULL AND (d.owner_id = $1
       OR (d.visibility='organisation' AND EXISTS (SELECT 1 FROM organisation_members m JOIN organisations o ON o.id=m.organisation_id WHERE m.organisation_id=d.organisation_id AND m.user_id=$1 AND m.status='active' AND o.status='active'))
       OR (d.visibility='roles' AND d.roles && $2::text[]))
    ORDER BY (d.owner_id = $1) DESC, lower(d.title), d.id`, [user.id, user.roles ?? []]);
