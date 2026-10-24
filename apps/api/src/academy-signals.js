// Academy OS 3/3: retention and engagement indicators. Each one is a plain rule over canonical facts (attendance, enrolments, charges) and
// carries the evidence it fired on and what a person could do about it. There is no risk score and nothing here acts on its own.
import { many } from './db.js';

const day = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

export const SIGNAL_RULES = {
  attendance_decline: 'Attendance rate in the last 28 days is at least 25 points below the 28 days before (needs 3+ recorded sessions in each window).',
  repeated_absence: 'Three or more unexcused absences in the last 28 days.',
  programme_ending_without_next: 'Enrolled in a programme that ends within 30 days, with no other active enrolment or open application at this academy.',
  renewal_incomplete: 'An enrolment completed in the last 45 days and was not renewed or followed by a new enrolment.',
  overdue_balance: 'An unpaid charge is past its due date (finance and owner/admin only). Never used to change access or performance history.',
};

const ACTIONS = {
  attendance_decline: ['Contact the athlete or family', 'Offer an alternative session or group', 'Schedule a coach review'],
  repeated_absence: ['Contact the athlete or family', 'Check whether the schedule still suits them'],
  programme_ending_without_next: ['Offer the next-level programme', 'Send the renewal invitation'],
  renewal_incomplete: ['Offer a renewal or the next programme', 'Ask why they have not continued'],
  overdue_balance: ['Send a payment reminder', 'Offer a payment plan or review funding'],
};

export async function signals(orgId, { coachId = null, includeMoney = true, financeOnly = false } = {}) {
  const out = [];
  const push = (r, signal, evidence) => out.push({ athlete_id: r.athlete_id, athlete_name: r.athlete_name, signal, rule: SIGNAL_RULES[signal], evidence, suggested_actions: ACTIONS[signal] });
  if (!financeOnly) {
    const att = await many(
      `SELECT a.user_id AS athlete_id, u.display_name AS athlete_name,
              count(*) FILTER (WHERE a.session_date >= $2 AND a.status IN ('present','absent'))::int AS recent_n, count(*) FILTER (WHERE a.session_date >= $2 AND a.status='present')::int AS recent_present,
              count(*) FILTER (WHERE a.session_date >= $2 AND a.status='absent')::int AS recent_absent,
              count(*) FILTER (WHERE a.session_date >= $3 AND a.session_date < $2 AND a.status IN ('present','absent'))::int AS prior_n, count(*) FILTER (WHERE a.session_date >= $3 AND a.session_date < $2 AND a.status='present')::int AS prior_present
         FROM org_attendance a JOIN org_cohorts k ON k.id=a.cohort_id JOIN users u ON u.id=a.user_id
        WHERE k.organisation_id=$1 AND a.session_date >= $3 AND ($4::uuid IS NULL OR k.coach_id=$4) GROUP BY a.user_id, u.display_name ORDER BY u.display_name, a.user_id`, [orgId, day(28), day(56), coachId]);
    for (const r of att) {
      if (r.recent_n >= 3 && r.prior_n >= 3) {
        const recent = r.recent_present / r.recent_n, prior = r.prior_present / r.prior_n;
        if (prior - recent >= 0.25) push(r, 'attendance_decline', { window: 'last 28 days vs the 28 before', recent_pct: Math.round(recent * 100), prior_pct: Math.round(prior * 100), recent_sessions: r.recent_n, prior_sessions: r.prior_n, source: 'org_attendance' });
      }
      if (r.recent_absent >= 3) push(r, 'repeated_absence', { window: 'last 28 days', unexcused_absences: r.recent_absent, source: 'org_attendance' });
    }
    const ending = await many(
      `SELECT e.user_id AS athlete_id, u.display_name AS athlete_name, pr.title AS programme, pr.ends_on, e.id AS enrolment_id
         FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id JOIN academy_programmes pr ON pr.id=e.programme_id JOIN users u ON u.id=e.user_id
        WHERE k.organisation_id=$1 AND e.status='enrolled' AND pr.ends_on BETWEEN current_date AND current_date + 30 AND ($2::uuid IS NULL OR k.coach_id=$2)
          AND NOT EXISTS (SELECT 1 FROM org_enrolments e2 JOIN org_cohorts k2 ON k2.id=e2.cohort_id WHERE k2.organisation_id=$1 AND e2.user_id=e.user_id AND e2.id <> e.id AND e2.status IN ('enrolled','paused') AND (e2.programme_id IS DISTINCT FROM e.programme_id))
          AND NOT EXISTS (SELECT 1 FROM academy_applications ap WHERE ap.organisation_id=$1 AND ap.athlete_id=e.user_id AND ap.programme_id <> e.programme_id AND ap.stage NOT IN ('declined','withdrawn','expired','cancelled','enrolled'))`, [orgId, coachId]);
    for (const r of ending) push(r, 'programme_ending_without_next', { programme: r.programme, ends_on: r.ends_on, source: 'org_enrolments' });
    const done = await many(
      `SELECT e.user_id AS athlete_id, u.display_name AS athlete_name, pr.title AS programme, e.withdrawn_at AS ended_at
         FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id JOIN academy_programmes pr ON pr.id=e.programme_id JOIN users u ON u.id=e.user_id
        WHERE k.organisation_id=$1 AND e.status='completed' AND e.withdrawn_at >= now() - interval '45 days' AND ($2::uuid IS NULL OR k.coach_id=$2)
          AND NOT EXISTS (SELECT 1 FROM org_enrolments e2 WHERE e2.renewed_from=e.id)
          AND NOT EXISTS (SELECT 1 FROM org_enrolments e3 JOIN org_cohorts k3 ON k3.id=e3.cohort_id WHERE k3.organisation_id=$1 AND e3.user_id=e.user_id AND e3.status IN ('enrolled','paused'))`, [orgId, coachId]);
    for (const r of done) push(r, 'renewal_incomplete', { programme: r.programme, completed_on: r.ended_at, source: 'org_enrolments' });
  }
  if (includeMoney) {
    const due = await many(
      `SELECT coalesce(e.user_id, a.athlete_id) AS athlete_id, u.display_name AS athlete_name, ch.currency, count(*)::int AS charges, sum(ch.amount_minor)::bigint AS amount_minor, min(ch.due_on) AS oldest_due
         FROM academy_charges ch LEFT JOIN org_enrolments e ON e.id=ch.enrolment_id LEFT JOIN academy_applications a ON a.id=ch.application_id JOIN users u ON u.id=coalesce(e.user_id, a.athlete_id)
        WHERE ch.organisation_id=$1 AND ch.status='awaiting_payment' AND ch.due_on < current_date GROUP BY 1, 2, 3 ORDER BY min(ch.due_on), 1`, [orgId]);
    for (const r of due) push(r, 'overdue_balance', { currency: r.currency, charges: r.charges, amount_minor: Number(r.amount_minor), oldest_due: r.oldest_due, source: 'academy_charges' });
  }
  return out;
}
