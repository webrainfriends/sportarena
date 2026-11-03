import { z } from 'zod';
import { cap } from '../registry.js';
import { one, many } from '../db.js';

const TAG = 'Coach';

// One read for "all my evaluations and feedback": the evaluations a coach has written (and what each is waiting on), the written feedback
// the coach still owes on athletes' completed sessions, and the reviews athletes have left. It owns no data; every row is scoped to the
// signed-in coach in SQL, so another person's numbers can never appear here. It reads only metadata (titles, counts, ratings), never the
// private coach note or the athlete's self-assessment, so it needs no decryption and no audit entry.
cap({
  name: 'coach_feedback_overview', method: 'GET', path: '/coach/feedback-overview', tag: TAG, auth: ['coach'],
  summary: 'Coach: all your evaluations and feedback in one view. Evaluations by status with what is waiting on you, session feedback you still owe, the reviews athletes left (average and recent), and a 6-month trend of evaluations written and review rating.',
  input: z.object({ waiting: z.coerce.number().int().min(1).max(20).default(8) }),
  async handler({ user }, i) {
    const [byStatus, last90, waiting, owed, reviews, recentReviews, evalTrend, ratingTrend] = await Promise.all([
      many('SELECT status, count(*)::int AS n FROM coaching_evaluations WHERE coach_id=$1 GROUP BY status', [user.id]),
      one("SELECT count(*)::int AS n FROM coaching_evaluations WHERE coach_id=$1 AND status <> 'draft' AND coalesce(shared_at, updated_at) > now() - interval '90 days'", [user.id]),
      many(
        `SELECT e.id, e.title, e.status, e.athlete_id, u.display_name AS athlete_name, e.updated_at, e.responded_at
           FROM coaching_evaluations e JOIN users u ON u.id=e.athlete_id
          WHERE e.coach_id=$1 AND e.status IN ('draft','responded') ORDER BY e.updated_at DESC, e.id LIMIT $2`, [user.id, i.waiting]),
      many(
        `SELECT s.id, s.title, s.completed_at, p.id AS plan_id, a.display_name AS athlete_name
           FROM training_sessions s JOIN training_plans p ON p.id=s.plan_id JOIN users a ON a.id=p.athlete_id
          WHERE p.coach_id=$1 AND s.status IN ('completed','skipped') AND s.coach_feedback IS NULL AND s.completed_at > now() - interval '30 days'
          ORDER BY s.completed_at DESC, s.id LIMIT 20`, [user.id]),
      one('SELECT round(avg(rating)::numeric, 2)::float8 AS avg, count(*)::int AS n FROM coach_reviews WHERE coach_id=$1', [user.id]),
      many(
        `SELECT r.id, r.rating, r.body, r.reply IS NOT NULL AS replied, r.created_at, a.display_name AS author_name
           FROM coach_reviews r JOIN users a ON a.id=r.reviewer_id WHERE r.coach_id=$1 ORDER BY r.created_at DESC, r.id LIMIT 5`, [user.id]),
      many(
        `SELECT to_char(date_trunc('month', coalesce(shared_at, created_at)), 'YYYY-MM') AS month, count(*)::int AS n
           FROM coaching_evaluations WHERE coach_id=$1 AND status <> 'draft' AND coalesce(shared_at, created_at) >= date_trunc('month', now()) - interval '5 months' GROUP BY 1 ORDER BY 1`, [user.id]),
      many(
        `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month, round(avg(rating)::numeric, 2)::float8 AS avg, count(*)::int AS n
           FROM coach_reviews WHERE coach_id=$1 AND created_at >= date_trunc('month', now()) - interval '5 months' GROUP BY 1 ORDER BY 1`, [user.id]),
    ]);
    const counts = Object.fromEntries(['draft', 'shared', 'responded', 'closed'].map((s) => [s, byStatus.find((r) => r.status === s)?.n ?? 0]));
    return {
      evaluations: { ...counts, total: Object.values(counts).reduce((a, b) => a + b, 0), last_90_days: last90.n, waiting_on_me: waiting.slice(0, i.waiting) },
      session_feedback: { owed: owed.length, items: owed.slice(0, i.waiting) },
      reviews: { average: reviews.avg ?? null, count: reviews.n, recent: recentReviews },
      trend: { evaluations: evalTrend, rating: ratingTrend },
    };
  },
});
