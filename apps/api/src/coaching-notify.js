import { tx } from './db.js';
import { notify } from './notify.js';

// Coaching notifications (issue #269). Wording is generic on purpose: email and push leave the system in clear text, so they never
// carry a note, a goal criterion, a player's name or a report's content - only that something needs attention, with ids in `data`
// so the app can open the right screen. Each message has a dedupe_key, so a repeated tick or retry never notifies twice, and the
// recipient's channel switches and muted kinds apply as for every other notification.
export const KINDS = ['coaching_action_assigned', 'coaching_action_due', 'coaching_action_overdue', 'coaching_action_done', 'coaching_goal_review', 'coaching_review_due', 'coaching_debrief_due', 'coaching_report_published'];

const dayOf = (d) => new Date(d).toISOString().slice(0, 10);

/** Immediate: an action was shared with the athlete who owns it. Called in the caller's transaction (or with null). */
export const notifyActionAssigned = (c, a) => a.owner_id && a.owner_id !== a.coach_id && a.shared
  ? notify(c, a.owner_id, { kind: 'coaching_action_assigned', title: 'Your coach gave you an action', body: 'Open the app to see what to do and when.', data: { action_id: a.id, screen: 'MyCoaching' }, dedupe_key: `coaching_action_assigned:${a.id}` })
  : null;

/** Immediate: the athlete finished an action the coach assigned. */
export const notifyActionDone = (c, a) => notify(c, a.coach_id, { kind: 'coaching_action_done', title: 'An action was completed', body: 'A player marked a coaching action as done.', data: { action_id: a.id, screen: 'CoachGoals', athlete_id: a.athlete_id }, dedupe_key: `coaching_action_done:${a.id}` });

/** Immediate: a report version was published to its audience (the athlete, the guardians, or the team's other coaches). */
export async function notifyReportPublished(c, { report, version, recipients }) {
  for (const uid of recipients) {
    if (uid === report.coach_id) continue;
    await notify(c, uid, { kind: 'coaching_report_published', title: 'A new coaching report is ready', body: 'Open the app to read it.', data: { report_id: report.id, version, screen: 'CoachReportView' }, dedupe_key: `coaching_report_published:${report.id}:${version}` });
  }
}

/**
 * Scheduled (called from the worker tick): actions coming due or overdue, goal reviews approaching, sessions finished but not reviewed,
 * and matches played without a debrief. Everything is idempotent through dedupe_key; limits keep one tick bounded.
 */
export async function queueCoachingReminders({ limit = 200 } = {}) {
  let n = 0;
  const run = (fn) => tx(async (c) => { n += await fn(c); });
  // due within a day -> the owner (a shared athlete-owned action reminds the athlete, otherwise the coach)
  await run(async (c) => {
    const { rows } = await c.query(`SELECT id, owner_id, due_at FROM coaching_actions WHERE status IN ('open','in_progress') AND due_at > now() AND due_at <= now() + interval '24 hours' AND (owner_id = coach_id OR shared) ORDER BY due_at LIMIT $1`, [limit]);
    for (const a of rows) await notify(c, a.owner_id, { kind: 'coaching_action_due', title: 'A coaching action is due soon', body: `Due ${dayOf(a.due_at)}. Open the app to see it.`, data: { action_id: a.id, screen: 'CoachGoals' }, dedupe_key: `coaching_action_due:${a.id}` });
    return rows.length;
  });
  // overdue -> the coach (once per action)
  await run(async (c) => {
    const { rows } = await c.query(`SELECT id, coach_id, athlete_id, team_id FROM coaching_actions WHERE status IN ('open','in_progress') AND due_at < now() ORDER BY due_at LIMIT $1`, [limit]);
    for (const a of rows) await notify(c, a.coach_id, { kind: 'coaching_action_overdue', title: 'A coaching action is overdue', body: 'Open Performance Studio to follow it up.', data: { action_id: a.id, athlete_id: a.athlete_id, team_id: a.team_id, screen: 'PerformanceStudio' }, dedupe_key: `coaching_action_overdue:${a.id}` });
    return rows.length;
  });
  // goal review within 3 days (a new review date is a new reminder)
  await run(async (c) => {
    const { rows } = await c.query(`SELECT id, coach_id, review_on, athlete_id, team_id FROM coaching_goals WHERE status IN ('planned','active') AND review_on IS NOT NULL AND review_on <= current_date + 3 ORDER BY review_on LIMIT $1`, [limit]);
    for (const g of rows) await notify(c, g.coach_id, { kind: 'coaching_goal_review', title: 'A goal review is coming up', body: 'Open Performance Studio to review it.', data: { goal_id: g.id, athlete_id: g.athlete_id, team_id: g.team_id, screen: 'CoachGoals' }, dedupe_key: `coaching_goal_review:${g.id}:${dayOf(g.review_on)}` });
    return rows.length;
  });
  // finished a day ago, still no review
  await run(async (c) => {
    const { rows } = await c.query(`SELECT id, coach_id FROM coaching_session_records WHERE status='completed' AND reviewed_at IS NULL AND team_summary IS NULL AND private_summary IS NULL AND ended_at < now() - interval '24 hours' AND ended_at > now() - interval '14 days' ORDER BY ended_at LIMIT $1`, [limit]);
    for (const r of rows) await notify(c, r.coach_id, { kind: 'coaching_review_due', title: 'A session is waiting for your review', body: 'Open Performance Studio to add a short summary.', data: { session_record_id: r.id, screen: 'CoachSession' }, dedupe_key: `coaching_review_due:${r.id}` });
    return rows.length;
  });
  // a team's match finished 12+ hours ago and its coach has no reviewed record for it
  await run(async (c) => {
    const { rows } = await c.query(
      `SELECT f.id AS fixture_id, m.user_id AS coach_id, t.id AS team_id FROM fixtures f JOIN teams t ON t.id IN (f.home_team_id, f.away_team_id)
         JOIN team_members m ON m.team_id=t.id AND m.role='coach' AND m.status='active'
        WHERE f.status='completed' AND f.scheduled_at < now() - interval '12 hours' AND f.scheduled_at > now() - interval '7 days'
          AND NOT EXISTS (SELECT 1 FROM coaching_session_records r WHERE r.coach_id=m.user_id AND r.source_type='fixture' AND r.source_id=f.id::text AND r.status='completed' AND (r.reviewed_at IS NOT NULL OR r.team_summary IS NOT NULL OR r.private_summary IS NOT NULL))
        ORDER BY f.scheduled_at LIMIT $1`, [limit]);
    for (const r of rows) await notify(c, r.coach_id, { kind: 'coaching_debrief_due', title: 'A match is waiting for your debrief', body: 'Open Performance Studio to review it.', data: { fixture_id: r.fixture_id, team_id: r.team_id, screen: 'PerformanceStudio' }, dedupe_key: `coaching_debrief_due:${r.fixture_id}:${r.coach_id}` });
    return rows.length;
  });
  return n;
}
