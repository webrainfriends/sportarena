// Scheduled report DRAFTS (#807). The worker makes drafts only: a different person still reviews, approves and issues every report. One row per
// (schedule, period, subject, kind) makes the sweep safe to repeat and safe on two workers. Each draft is built under the schedule creator's LIVE
// authority: if they lost the role, the schedule is skipped (and paused) and nothing is produced.
import { tx, one, many } from './db.js';
import { notify } from './notify.js';
import { nextRun } from './sponsor-report-schedules.js';
import { draftPack } from './capabilities/academy-report-packs.js';
import { logger } from './logger.js';

const iso = (d) => d.toISOString().slice(0, 10);
const daysBefore = (d, n) => iso(new Date(Date.parse(`${d}T00:00:00Z`) - n * 864e5));

/** Draft every due scheduled report. @returns {Promise<number>} drafts made */
export async function draftDueReports(limit = 10) {
  let made = 0;
  for (let n = 0; n < limit; n++) {
    const s = await tx(async (c) => {
      const row = (await c.query("SELECT *, next_run_on::text AS run_on, current_date::text AS today FROM academy_report_schedules WHERE archived_at IS NULL AND paused_at IS NULL AND next_run_on <= current_date ORDER BY next_run_on, id LIMIT 1 FOR UPDATE SKIP LOCKED")).rows[0];
      if (!row) return null;
      await c.query('UPDATE academy_report_schedules SET last_run_on=$2, next_run_on=$3, row_version=row_version+1, updated_at=now() WHERE id=$1', [row.id, row.run_on, nextRun(row.run_on, row.cadence, row.today)]);
      return row;
    });
    if (!s) break;
    const user = await one('SELECT * FROM users WHERE id=$1', [s.created_by]);
    const to = s.run_on, from = daysBefore(to, s.lookback_days);
    const subjects = s.kind === 'campus' ? [s.scope.branch_id]
      : ['progress', 'term'].includes(s.kind) ? (await many("SELECT DISTINCT e.user_id FROM org_enrolments e WHERE e.cohort_id=$1 AND e.programme_id IS NOT NULL AND e.status IN ('enrolled','paused') ORDER BY 1 LIMIT 200", [s.scope.cohort_id])).map((r) => r.user_id) : [null];
    let drafted = 0;
    for (const subject_id of subjects) {
      try { const r = await draftPack(user, s.organisation_id, { kind: s.kind, subject_id, from, to, template_id: s.template_id ?? undefined, schedule_id: s.id }); if (!r.duplicate) drafted++; }
      catch (e) {
        if (e.status === 403 || e.status === 404) { await tx((c) => c.query('UPDATE academy_report_schedules SET paused_at=now(), row_version=row_version+1 WHERE id=$1 AND paused_at IS NULL', [s.id])); logger.warn('report schedule paused: creator lost access', { schedule: s.id }); break; }
        if (e.status && e.status < 500) continue; // e.g. nothing to report for this athlete yet (409)
        throw e;
      }
    }
    if (drafted) await tx(async (c) => {
      for (const r of (await c.query("SELECT DISTINCT user_id FROM organisation_members WHERE organisation_id=$1 AND role IN ('owner','admin') AND status='active'", [s.organisation_id])).rows)
        await notify(c, r.user_id, { kind: 'academy_report', title: 'Scheduled report drafts are ready', body: 'Open Academy, then Reports, to review them. Figures are not included in this message.', data: { organisation_id: s.organisation_id, schedule_id: s.id }, dedupe_key: `pack-sched:${s.id}:${s.run_on}:${r.user_id}` });
    });
    made += drafted;
  }
  return made;
}
