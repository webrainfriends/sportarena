// Sponsorship portfolio dashboards, reports and branded exports (#305): financial ageing, award funnel, beneficiary outcomes, fulfilment and
// renewals, with CSV / XLSX / branded PDF export, saved filters and scheduled delivery. Everything is read live from the canonical sponsorship
// tables under the caller's current authority (see src/sponsor-reports.js); filters and schedules are the only things stored.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { conflict, notFound, unprocessable } from '../errors.js';
import { audit } from '../helpers.js';
import { KINDS, PARAMS, assertReportAccess, buildReport, pageOf } from '../sponsor-reports.js';
import { exportReport } from '../sponsor-report-export.js';
import { kitOf, loadLogo, mustAccess } from './branded-documents.js';

const TAG = 'Sponsors';
const kind = z.enum(KINDS);
const format = z.enum(['csv', 'xlsx', 'pdf']);
const date = z.string().date();
const FILTER_PARAMS = PARAMS.omit({ view: true }).partial();
const FILTER_COLS = "id, name, kind, view, params, row_version, created_at, updated_at";
const SCHEDULE_COLS = "s.id, s.filter_id, f.name AS filter_name, f.kind, f.view, s.cadence, s.format, s.recipient_ids, s.next_run_on::text AS next_run_on, s.last_run_on::text AS last_run_on, s.row_version, s.paused_at, s.created_at, s.updated_at";

const fileOf = (f) => ({ filename: f.filename, content_type: f.type, encoding: typeof f.body === 'string' ? 'utf8' : 'base64', content: typeof f.body === 'string' ? f.body : f.body.toString('base64') });
const today = () => new Date().toISOString().slice(0, 10);

/** The brand kit and logo for a branded PDF: the caller must be allowed to use the kit (the same rule as every other branded document). */
async function brandOf(user, kitId) {
  if (!kitId) return {};
  const kit = await kitOf(kitId);
  await mustAccess(user, kit, 'Brand kit');
  return { kit, logo: await loadLogo(kit.logo_asset_id) };
}

const REPORT_INPUT = PARAMS.extend({ kind });

cap({
  name: 'get_sponsorship_report', method: 'GET', path: '/sponsorship-reports/:kind', tag: TAG,
  summary: 'Portfolio dashboard: kind = ageing (instalments by days past due, cash apart from estimates), funnel (applications to offers to awards), outcomes (agreed objectives against the athlete\'s own shared results), fulfilment (goods and endorsements) or renewals. Read live under your current role: view = sponsor (the brands you run, needs a finance, manager, approver or auditor role) or recipient (agreements where you are the beneficiary). `basis` states the reporting date and currency basis; `sources` flags every missing or stale source; `totals` are per currency and never added across currencies; `rows` are paged deterministically.',
  input: REPORT_INPUT.extend(page),
  async handler({ user }, { kind: k, limit, offset, ...params }) {
    return pageOf(await buildReport(user, k, params), limit, offset);
  },
});

cap({
  name: 'export_sponsorship_report', method: 'GET', path: '/sponsorship-reports/:kind/export', tag: TAG,
  summary: 'Export a report as CSV, XLSX (report, totals and basis sheets) or a branded PDF (pass kit_id; the brand kit\'s name, colours and logo). Built from the same rows as the dashboard, so it reconciles to it exactly, and it honours your live role (export needs a manager, finance or auditor role) and the athlete\'s live consent. Amounts are minor units with their currency; cash and estimates stay in separate columns. Returns { filename, content_type, encoding (utf8|base64), content }.',
  input: REPORT_INPUT.extend({ format: format.default('csv'), kit_id: id.optional() }),
  async handler({ user }, { kind: k, format: fmt, kit_id, ...params }) {
    const brand = fmt === 'pdf' ? await brandOf(user, kit_id) : {};
    const report = await buildReport(user, k, params, { action: 'export' });
    await audit(null, user.id, 'export', `sponsorship_report_${k}`, null);
    return { ...fileOf(await exportReport(report, fmt, brand)), as_of: report.basis.as_of, rows: report.rows.length };
  },
});

// ---- saved filters -------------------------------------------------------------------------------------------------------------
cap({
  name: 'list_sponsorship_report_filters', method: 'GET', path: '/sponsorship-report-filters', tag: TAG,
  summary: 'Your saved report filters (private to you), optionally for one report kind.',
  input: z.object({ kind: kind.optional(), ...page }),
  handler: ({ user }, i) => many(`SELECT ${FILTER_COLS} FROM sponsor_report_filters WHERE owner_id=$1 AND archived_at IS NULL AND ($2::text IS NULL OR kind=$2) ORDER BY kind, lower(name), id LIMIT $3 OFFSET $4`, [user.id, i.kind ?? null, i.limit, i.offset]),
});

cap({
  name: 'save_sponsorship_report_filter', method: 'POST', path: '/sponsorship-report-filters', tag: TAG, status: 201,
  summary: 'Save the current report parameters (brands, program, dates, currency basis, bucket/state) under a name. A rolling filter omits as_of (it then reports as of the day it is opened or delivered). The filter holds no data and no access: every use re-checks your live role.',
  input: z.object({ name: z.string().trim().min(2).max(80), kind, view: z.enum(['sponsor', 'recipient']).default('sponsor'), params: FILTER_PARAMS.default({}) }),
  async handler({ user }, i) {
    await assertReportAccess(user, i.view);
    if (i.params.currency_basis === 'reporting' && !i.params.currency) throw unprocessable('Pick the reporting currency, or use the native basis');
    try {
      return await one(`INSERT INTO sponsor_report_filters(owner_id, name, kind, view, params) VALUES ($1,$2,$3,$4,$5) RETURNING ${FILTER_COLS}`, [user.id, i.name, i.kind, i.view, JSON.stringify(i.params)]);
    } catch (e) { if (e.code === '23505') throw conflict('You already have a filter with that name for this report'); throw e; }
  },
});

cap({
  name: 'update_sponsorship_report_filter', method: 'PATCH', path: '/sponsorship-report-filters/:id', tag: TAG,
  summary: 'Rename or change a saved filter. Send the row_version you loaded: if someone (you, on another device) changed it since, you get 409 and must reload.',
  input: z.object({ id, row_version: z.coerce.number().int().min(1), name: z.string().trim().min(2).max(80).optional(), params: FILTER_PARAMS.optional() }),
  async handler({ user }, i) {
    try {
      const row = await one(`UPDATE sponsor_report_filters SET name=coalesce($4,name), params=coalesce($5::jsonb,params), row_version=row_version+1, updated_at=now()
        WHERE id=$1 AND owner_id=$2 AND row_version=$3 AND archived_at IS NULL RETURNING ${FILTER_COLS}`, [i.id, user.id, i.row_version, i.name ?? null, i.params ? JSON.stringify(i.params) : null]);
      if (row) return row;
    } catch (e) { if (e.code === '23505') throw conflict('You already have a filter with that name for this report'); throw e; }
    if (!(await one('SELECT 1 FROM sponsor_report_filters WHERE id=$1 AND owner_id=$2 AND archived_at IS NULL', [i.id, user.id]))) throw notFound('Filter');
    throw conflict('This filter changed since you opened it. Reload it and try again.', { code: 'stale_version' });
  },
});

cap({
  name: 'archive_sponsorship_report_filter', method: 'POST', path: '/sponsorship-report-filters/:id/archive', tag: TAG,
  summary: 'Archive a saved filter (it is kept, not deleted) and stop the schedules that use it.',
  input: z.object({ id, row_version: z.coerce.number().int().min(1) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const row = (await c.query(`UPDATE sponsor_report_filters SET archived_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1 AND owner_id=$2 AND row_version=$3 AND archived_at IS NULL RETURNING ${FILTER_COLS}`, [i.id, user.id, i.row_version])).rows[0];
      if (!row) {
        if (!(await c.query('SELECT 1 FROM sponsor_report_filters WHERE id=$1 AND owner_id=$2 AND archived_at IS NULL', [i.id, user.id])).rows.length) throw notFound('Filter');
        throw conflict('This filter changed since you opened it. Reload it and try again.', { code: 'stale_version' });
      }
      await c.query('UPDATE sponsor_report_schedules SET archived_at=now(), updated_at=now() WHERE filter_id=$1 AND archived_at IS NULL', [i.id]);
      return row;
    });
  },
});

// ---- scheduled delivery --------------------------------------------------------------------------------------------------------
async function checkRecipients(user, filter, recipientIds) {
  const ids = [...new Set(recipientIds)];
  if (filter.view === 'recipient' && (ids.length !== 1 || ids[0] !== user.id)) throw unprocessable('A recipient-side report shows your own agreements, so it can only be delivered to you');
  for (const rid of ids) {
    if (!(await one('SELECT 1 FROM users WHERE id=$1', [rid]))) throw unprocessable('A recipient is not a Sportarena user');
    try { await assertReportAccess({ id: rid }, filter.view, 'report'); } catch { throw unprocessable('Every recipient needs a role that may read sponsorship reports on a brand you can see'); }
  }
  return ids;
}

cap({
  name: 'list_sponsorship_report_schedules', method: 'GET', path: '/sponsorship-report-schedules', tag: TAG,
  summary: 'Your scheduled report deliveries, with the next run and the last run.',
  input: z.object({ ...page }),
  handler: ({ user }, i) => many(`SELECT ${SCHEDULE_COLS} FROM sponsor_report_schedules s JOIN sponsor_report_filters f ON f.id=s.filter_id WHERE s.owner_id=$1 AND s.archived_at IS NULL ORDER BY s.created_at DESC, s.id LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]),
});

cap({
  name: 'create_sponsorship_report_schedule', method: 'POST', path: '/sponsorship-report-schedules', tag: TAG, status: 201,
  summary: 'Deliver a saved filter weekly, monthly or quarterly as CSV, XLSX or PDF to people with a reporting role. Each delivery is prepared once per period and recipient (a repeated sweep or a second worker never duplicates it), built under the recipient\'s role at that moment, and announced by a notification that carries no figures. Needs the finance or manager role.',
  input: z.object({ filter_id: id, cadence: z.enum(['weekly', 'monthly', 'quarterly']), format, recipient_ids: z.array(id).min(1).max(20).optional(), first_run_on: date.optional() }),
  async handler({ user }, i) {
    const f = await one('SELECT id, view FROM sponsor_report_filters WHERE id=$1 AND owner_id=$2 AND archived_at IS NULL', [i.filter_id, user.id]);
    if (!f) throw notFound('Filter');
    await assertReportAccess(user, f.view, f.view === 'sponsor' ? 'report_schedule' : 'report');
    const first = i.first_run_on ?? new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    if (first <= today()) throw unprocessable('The first delivery must be in the future');
    const recipients = await checkRecipients(user, f, i.recipient_ids ?? [user.id]);
    return one(`WITH s AS (INSERT INTO sponsor_report_schedules(filter_id, owner_id, cadence, format, recipient_ids, next_run_on) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *)
      SELECT ${SCHEDULE_COLS} FROM s JOIN sponsor_report_filters f ON f.id=s.filter_id`, [f.id, user.id, i.cadence, i.format, recipients, first]);
  },
});

cap({
  name: 'update_sponsorship_report_schedule', method: 'PATCH', path: '/sponsorship-report-schedules/:id', tag: TAG,
  summary: 'Change a schedule (cadence, format, recipients), pause or resume it, or archive it. Send the row_version you loaded; a stale one gets 409.',
  input: z.object({ id, row_version: z.coerce.number().int().min(1), cadence: z.enum(['weekly', 'monthly', 'quarterly']).optional(), format: format.optional(), recipient_ids: z.array(id).min(1).max(20).optional(), paused: z.boolean().optional(), archived: z.boolean().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s = (await c.query('SELECT s.*, f.view FROM sponsor_report_schedules s JOIN sponsor_report_filters f ON f.id=s.filter_id WHERE s.id=$1 AND s.owner_id=$2 AND s.archived_at IS NULL FOR UPDATE OF s', [i.id, user.id])).rows[0];
      if (!s) throw notFound('Schedule');
      if (s.row_version !== i.row_version) throw conflict('This schedule changed since you opened it. Reload it and try again.', { code: 'stale_version' });
      await assertReportAccess(user, s.view, s.view === 'sponsor' ? 'report_schedule' : 'report');
      const recipients = i.recipient_ids ? await checkRecipients(user, s, i.recipient_ids) : s.recipient_ids;
      await c.query(`UPDATE sponsor_report_schedules SET cadence=coalesce($2,cadence), format=coalesce($3,format), recipient_ids=$4,
          paused_at=CASE WHEN $5::boolean IS NULL THEN paused_at WHEN $5 THEN coalesce(paused_at, now()) ELSE NULL END, archived_at=CASE WHEN $6::boolean THEN now() ELSE archived_at END, row_version=row_version+1, updated_at=now() WHERE id=$1`,
        [s.id, i.cadence ?? null, i.format ?? null, recipients, i.paused ?? null, i.archived ?? null]);
      return (await c.query(`SELECT ${SCHEDULE_COLS} FROM sponsor_report_schedules s JOIN sponsor_report_filters f ON f.id=s.filter_id WHERE s.id=$1`, [s.id])).rows[0];
    });
  },
});

cap({
  name: 'list_sponsorship_report_runs', method: 'GET', path: '/sponsorship-report-runs', tag: TAG,
  summary: 'Scheduled reports addressed to you (newest first), and for schedules you own, how each delivery went. A run holds no figures: open it to read the report under your role at that moment.',
  input: z.object({ ...page }),
  handler: ({ user }, i) => many(
    `SELECT r.id, r.schedule_id, f.name AS filter_name, f.kind, f.view, s.format, r.period_on::text AS period_on, r.as_of::text AS as_of, r.status, r.row_count, r.sources, r.created_at, r.recipient_id = $1 AS mine
       FROM sponsor_report_runs r JOIN sponsor_report_schedules s ON s.id=r.schedule_id JOIN sponsor_report_filters f ON f.id=s.filter_id
      WHERE r.recipient_id=$1 OR s.owner_id=$1 ORDER BY r.created_at DESC, r.id LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]),
});

cap({
  name: 'get_sponsorship_report_run', method: 'GET', path: '/sponsorship-report-runs/:id', tag: TAG,
  summary: 'Open a delivered scheduled report (recipient only). The report is re-read as of the run\'s date under your role and the athlete\'s consent at this moment, so a revoked role or consent shows nothing. `download=true` returns the file in the schedule\'s format instead.',
  input: z.object({ id, download: z.coerce.boolean().default(false), kit_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const r = await one(
      `SELECT r.id, r.recipient_id, r.as_of::text AS as_of, r.status, r.sources, s.format, f.kind, f.view, f.params FROM sponsor_report_runs r JOIN sponsor_report_schedules s ON s.id=r.schedule_id JOIN sponsor_report_filters f ON f.id=s.filter_id WHERE r.id=$1`, [i.id]);
    if (!r || r.recipient_id !== user.id) throw notFound('Report');
    const report = await buildReport(user, r.kind, { ...r.params, view: r.view, as_of: r.as_of }, { action: i.download ? 'export' : 'report' });
    if (i.download) {
      const brand = r.format === 'pdf' ? await brandOf(user, i.kit_id) : {};
      await audit(null, user.id, 'export', `sponsorship_report_${r.kind}`, null);
      return { run_id: r.id, ...fileOf(await exportReport(report, r.format, brand)) };
    }
    return { run_id: r.id, prepared_sources: r.sources, ...pageOf(report, i.limit, i.offset) };
  },
});
