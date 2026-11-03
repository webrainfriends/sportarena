// The frozen content of a team / batch performance report. Built on the server from live records at preview and at publish; the PDF only prints this.
// Aggregates only. For the organisation audience (an academy, club or sponsor) nothing individual is ever included: no names, scores, notes or sessions
// by title, and the report is refused outright when fewer than MIN_SHARED_COHORT athletes stand behind it.
import { badRequest } from './errors.js';
import { teamPerformance, MIN_SHARED_COHORT } from './team-performance.js';
import { findingsFor } from './team-findings.js';

const wk = (d) => `Week of ${new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}`;
const TONE = { risk: 'Needs attention', watch: 'Watch', good: 'Going well', info: 'Note' };

export async function buildTeamPerformance(user, r, { coachName, shortDate }) {
  const outward = r.audience === 'organisation';
  const perf = await teamPerformance(user, { team_id: r.team_id, cohort_id: r.cohort_id, from: shortDate(r.period_from), to: shortDate(r.period_to), rubric_id: r.rubric_id ?? undefined, min_cohort: outward ? MIN_SHARED_COHORT : 1 });
  if (outward && !perf.shareable) throw badRequest(`Only ${perf.athletes.n} athlete${perf.athletes.n === 1 ? '' : 's'} stand behind this report. A report for an organisation needs at least ${MIN_SHARED_COHORT} so no one can be picked out. Keep it for yourself or your staff, or widen the period.`, { code: 'group_too_small' });
  if (!perf.sessions.total) throw badRequest('No sessions of yours fall in this period for this team or batch', { code: 'no_sessions' });
  const sel = r.selection;
  const sections = [];
  if (r.narrative) sections.push({ key: 'summary', title: 'Summary', kind: 'text', body: r.narrative });
  const na = (v, f) => (v == null ? 'No data' : f(v));
  sections.push({ key: 'overview', title: 'At a glance', kind: 'items', items: [
    { title: 'Sessions run', value: String(perf.sessions.total), meta: `${perf.sessions.completed} completed · ${perf.sessions.with_plan} with a plan` },
    { title: 'Athletes', value: String(perf.athletes.n), meta: perf.athletes.scored_rate == null ? undefined : `${perf.athletes.scored_rate}% scored or evaluated` },
    { title: 'Attendance', value: na(perf.attendance.rate, (x) => `${x}%`), meta: `${perf.attendance.recorded_slots} recorded places` },
    { title: 'Planned load', value: perf.load.total_au ? `${perf.load.total_au} AU` : 'No data', meta: perf.load.avg_rpe != null ? `Average effort RPE ${perf.load.avg_rpe} · ${perf.load.minutes} planned minutes` : 'Set a target effort on blocks to build load' },
    { title: 'Plan delivered', value: na(perf.delivery.completion_rate, (x) => `${x}%`), meta: perf.delivery.logged ? `${perf.delivery.completed} completed, ${perf.delivery.modified} modified, ${perf.delivery.skipped} skipped` : 'Block progress was not logged' },
    { title: 'Goals', value: String(perf.goals.active + perf.goals.achieved), meta: `${perf.goals.achieved} achieved · ${perf.goals.active} active` },
  ] });
  if (sel.metrics) {
    if (perf.attendance.by_week.length) sections.push({ key: 'attendance_trend', title: 'Attendance by week (%)', kind: 'bars', rows: perf.attendance.by_week.map((w) => ({ label: wk(w.week), value: w.rate, max: 100, note: `${w.recorded} places` })) });
    if (perf.load.by_week.some((w) => w.au)) {
      const max = Math.max(...perf.load.by_week.map((w) => w.au), 1);
      sections.push({ key: 'load_trend', title: 'Planned load by week (AU)', kind: 'bars', rows: perf.load.by_week.map((w) => ({ label: wk(w.week), value: w.au, max, note: `${w.sessions} session${w.sessions === 1 ? '' : 's'}${w.avg_rpe != null ? ` · RPE ${w.avg_rpe}` : ''}` })) });
    }
    const shown = perf.criteria.filter((c) => !c.suppressed && c.avg != null);
    if (shown.length) sections.push({ key: 'criteria', title: `Group scores on ${perf.sheet.name}`, kind: 'bars', rows: shown.map((c) => ({ label: c.name, value: c.avg, max: c.scale_max, min: c.scale_min, note: `${c.n} athletes${c.change != null ? ` · change ${c.change > 0 ? '+' : ''}${c.change}` : ''}` })) });
    else if (perf.criteria.length) sections.push({ key: 'criteria', title: 'Group scores', kind: 'text', body: `Criterion figures are withheld when fewer than ${perf.min_cohort} athletes have a score, so no individual can be identified.` });
  }
  if (sel.findings) {
    const findings = await findingsFor(user, perf);
    const staff = !outward;
    if (findings.length) sections.push({ key: 'findings', title: 'Findings and recommendations', kind: 'items', items: findings.map((x) => ({
      title: x.title, meta: TONE[x.tone], body: [x.detail, `Why it matters: ${x.why}`, x.recommendation ? `Next: ${x.recommendation}` : null, staff && x.drills?.length ? `Your drills: ${x.drills.map((d) => d.title).join(', ')}` : null].filter(Boolean).join(' '),
    })) });
  }
  return {
    title: r.title, kind: r.kind, audience: r.audience, subject: `${perf.scope.name} (${perf.scope.kind === 'team' ? 'team' : 'batch'})`, period: { from: shortDate(r.period_from), to: shortDate(r.period_to) }, coach_name: coachName, sections,
    disclosure: outward ? `Aggregate only: no athlete names, individual scores or coach notes. Based on ${perf.sessions.total} sessions and ${perf.athletes.n} athletes.` : `Prepared for ${r.audience.replace('_', ' ')}. Based on ${perf.sessions.total} sessions and ${perf.athletes.n} athletes. Coach-private notes are never included.`,
  };
}
