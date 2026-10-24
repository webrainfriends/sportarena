// Scheduled report delivery (#305). The worker sweeps due schedules; one row per (schedule, period, recipient) makes the sweep safe to repeat
// and safe on two workers: the unique key means a report is prepared and announced exactly once. Each recipient's report is built under THEIR live
// authority at that moment (a person who lost their role gets a `skipped_no_access` row and no notice), and the notice carries no figures:
// it links to the run, which is re-read under the recipient's access whenever it is opened.
import { tx } from './db.js';
import { notify } from './notify.js';
import { buildReport } from './sponsor-reports.js';

const iso = (d) => d.toISOString().slice(0, 10);
const DAYS = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
/** The next occurrence of a cadence after `from`, strictly later than `after` (so a long-paused schedule delivers once, then resumes on its rhythm). */
export function nextRun(from, cadence, after) {
  let d = new Date(`${from}T00:00:00Z`);
  const anchor = d.getUTCDate();
  do {
    if (cadence === 'weekly') d = new Date(d.getTime() + 7 * 864e5);
    else { const m = d.getUTCMonth() + (cadence === 'monthly' ? 1 : 3), y = d.getUTCFullYear() + Math.floor(m / 12), mm = m % 12; d = new Date(Date.UTC(y, mm, Math.min(anchor, DAYS(y, mm)))); }
  } while (iso(d) <= after);
  return iso(d);
}

const KIND_LABEL = { ageing: 'financial ageing', funnel: 'award funnel', outcomes: 'beneficiary outcomes', fulfilment: 'fulfilment', renewals: 'renewals' };

/** Prepare and announce every due scheduled report. @returns {Promise<number>} runs prepared */
export async function deliverDueReports(limit = 25) {
  let made = 0;
  for (let i = 0; i < limit; i++) {
    const n = await tx(async (c) => {
      const s = (await c.query(
        `SELECT s.id, s.recipient_ids, s.cadence, s.next_run_on::text AS period_on, current_date::text AS today, f.kind, f.view, f.params
           FROM sponsor_report_schedules s JOIN sponsor_report_filters f ON f.id=s.filter_id
          WHERE s.archived_at IS NULL AND s.paused_at IS NULL AND f.archived_at IS NULL AND s.next_run_on <= current_date
          ORDER BY s.next_run_on, s.id LIMIT 1 FOR UPDATE OF s SKIP LOCKED`)).rows[0];
      if (!s) return 0;
      let runs = 0;
      for (const rid of s.recipient_ids) {
        const claim = await c.query("INSERT INTO sponsor_report_runs(schedule_id, period_on, recipient_id, as_of, status) VALUES ($1,$2,$3,$2,'delivered') ON CONFLICT (schedule_id, period_on, recipient_id) DO NOTHING RETURNING id", [s.id, s.period_on, rid]);
        if (!claim.rowCount) continue;
        const runId = claim.rows[0].id;
        try {
          const r = await buildReport({ id: rid }, s.kind, { ...s.params, view: s.view, as_of: s.period_on });
          await c.query('UPDATE sponsor_report_runs SET row_count=$2, sources=$3 WHERE id=$1', [runId, r.rows.length, JSON.stringify(r.sources.map(({ key, label, status, detail }) => ({ key, label, status, detail })))]);
          await notify(c, rid, { kind: 'sponsorship_report', title: `Your ${KIND_LABEL[s.kind]} report is ready`, body: `Open Sponsorship reports to view the report as of ${s.period_on}. Figures are not included in this message.`,
            data: { report_run_id: runId, schedule_id: s.id }, dedupe_key: `report:${s.id}:${s.period_on}:${rid}` });
          runs++;
        } catch (e) {
          if (!e.status || e.status >= 500) throw e; // a transient failure rolls the whole sweep back and is retried next cycle
          await c.query("UPDATE sponsor_report_runs SET status=$2, error=$3 WHERE id=$1", [runId, e.status === 403 ? 'skipped_no_access' : 'failed', String(e.message).slice(0, 300)]);
        }
      }
      await c.query('UPDATE sponsor_report_schedules SET last_run_on=$2, next_run_on=$3, row_version=row_version+1, updated_at=now() WHERE id=$1', [s.id, s.period_on, nextRun(s.period_on, s.cadence, s.today)]);
      return Math.max(runs, 1);
    });
    if (!n) break;
    made += n;
  }
  return made;
}
