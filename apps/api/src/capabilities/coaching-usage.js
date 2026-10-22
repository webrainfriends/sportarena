import { z } from 'zod';
import { cap } from '../registry.js';
import { one } from '../db.js';

// Product usage of the coaching workspace (issue #269). Aggregates only, over counts and timestamps: no note, goal, summary or report
// text is read, and nothing is broken down per coach or per athlete, so it cannot become a ranking of people or of their ratings.
const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);

cap({
  name: 'get_coaching_usage_metrics', method: 'GET', path: '/admin/coaching-usage', tag: 'Coaching journal', auth: ['admin'],
  summary: 'Platform-wide adoption of the coaching workspace over a window (default 30 days): reviewed sessions, time to review, goal-linked sessions, action completion, template reuse, report and AI draft outcomes, and active coaches. Counts only; never contents; never per person.',
  input: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }),
  async handler(_ctx, i) {
    const w = `now() - make_interval(days => ${i.days})`;
    const r = await one(`
      SELECT
        (SELECT count(*)::int FROM coaching_session_records WHERE status='completed' AND ended_at >= ${w}) AS sessions_completed,
        (SELECT count(*)::int FROM coaching_session_records WHERE status='completed' AND ended_at >= ${w} AND (reviewed_at IS NOT NULL OR team_summary IS NOT NULL OR private_summary IS NOT NULL)) AS sessions_reviewed,
        (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM reviewed_at - ended_at) / 3600) FROM coaching_session_records WHERE status='completed' AND ended_at >= ${w} AND reviewed_at IS NOT NULL) AS median_hours_to_review,
        (SELECT count(*)::int FROM coaching_session_records s WHERE s.status='completed' AND s.ended_at >= ${w} AND EXISTS (SELECT 1 FROM coaching_observations o JOIN coaching_goal_evidence e ON e.evidence_type='observation' AND e.evidence_id=o.id::text WHERE o.session_record_id=s.id)) AS sessions_with_goal_evidence,
        (SELECT count(*)::int FROM coaching_actions WHERE created_at >= ${w} AND status <> 'cancelled') AS actions_created,
        (SELECT count(*)::int FROM coaching_actions WHERE created_at >= ${w} AND status = 'done') AS actions_done,
        (SELECT count(*)::int FROM coaching_reports WHERE created_at >= ${w}) AS reports_created,
        (SELECT count(*)::int FROM coaching_report_versions WHERE published_at >= ${w}) AS report_versions_published,
        (SELECT count(*)::int FROM coaching_ai_drafts WHERE created_at >= ${w}) AS ai_drafts,
        (SELECT count(*)::int FROM coaching_ai_drafts WHERE created_at >= ${w} AND status='accepted') AS ai_accepted,
        (SELECT count(*)::int FROM coaching_ai_drafts WHERE created_at >= ${w} AND status='edited') AS ai_edited,
        (SELECT count(*)::int FROM coaching_ai_drafts WHERE created_at >= ${w} AND status='discarded') AS ai_discarded,
        (SELECT count(DISTINCT coach_id)::int FROM (SELECT coach_id, created_at FROM coaching_session_records UNION ALL SELECT coach_id, created_at FROM coaching_observations UNION ALL SELECT coach_id, created_at FROM coaching_actions) x WHERE created_at >= ${w}) AS active_coaches,
        (SELECT count(DISTINCT coach_id)::int FROM (SELECT coach_id, created_at FROM coaching_session_records UNION ALL SELECT coach_id, created_at FROM coaching_observations UNION ALL SELECT coach_id, created_at FROM coaching_actions) x WHERE created_at >= ${w} - make_interval(days => ${i.days}) AND created_at < ${w}) AS previous_active_coaches,
        (SELECT count(DISTINCT coach_id)::int FROM (SELECT coach_id, created_at FROM coaching_session_records UNION ALL SELECT coach_id, created_at FROM coaching_observations UNION ALL SELECT coach_id, created_at FROM coaching_actions) x WHERE created_at >= ${w} AND coach_id IN (SELECT coach_id FROM coaching_session_records WHERE created_at >= ${w} - make_interval(days => ${i.days}) AND created_at < ${w})) AS retained_coaches`);
    return {
      window_days: i.days, note: 'Counts and timestamps only. No contents, and nothing per coach or athlete.',
      sessions: { completed: r.sessions_completed, with_structured_review_pct: pct(r.sessions_reviewed, r.sessions_completed), median_hours_to_review: r.median_hours_to_review == null ? null : Math.round(Number(r.median_hours_to_review) * 10) / 10, with_goal_linked_note_pct: pct(r.sessions_with_goal_evidence, r.sessions_completed) },
      actions: { created: r.actions_created, completion_pct: pct(r.actions_done, r.actions_created) },
      reports: { created: r.reports_created, versions_published: r.report_versions_published, share_rate_pct: pct(r.report_versions_published, r.reports_created) },
      ai: { drafts: r.ai_drafts, accepted_pct: pct(r.ai_accepted, r.ai_drafts), edited_pct: pct(r.ai_edited, r.ai_drafts), discarded_pct: pct(r.ai_discarded, r.ai_drafts) },
      coaches: { active: r.active_coaches, active_in_previous_window: r.previous_active_coaches, retained_pct: pct(r.retained_coaches, r.previous_active_coaches) },
    };
  },
});
