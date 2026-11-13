import { z } from 'zod';
import { cap } from '../registry.js';
import { one, many } from '../db.js';

cap({
  name: 'get_physio_practice_dashboard', method: 'GET', path: '/physio/dashboard',
  tag: 'Physio', auth: true, summary: 'Clinician practice dashboard: appointments, revenue, compliance and flare-ups',
  input: z.object({}),
  handler: async ({ user }) => {
    const [appts, flareups, compliance, recentSessions] = await Promise.all([
      one(
        `SELECT
           count(*) FILTER (WHERE status='confirmed' AND scheduled_at::date = CURRENT_DATE)::int AS today,
           count(*) FILTER (WHERE status='confirmed' AND scheduled_at::date BETWEEN CURRENT_DATE AND CURRENT_DATE+6)::int AS week,
           count(*) FILTER (WHERE status='no_show' AND scheduled_at::date >= CURRENT_DATE-29)::int AS no_shows_30d,
           count(*) FILTER (WHERE status='confirmed' AND scheduled_at::date < CURRENT_DATE)::int AS overdue
         FROM appointments WHERE provider_id=$1`,
        [user.id],
      ),
      one(
        `SELECT count(*) FILTER (WHERE resolved_at IS NULL)::int AS open,
                count(*)::int AS total_30d
         FROM physio_flareup_reports
         WHERE provider_id=$1 AND reported_at >= CURRENT_DATE-29`,
        [user.id],
      ),
      one(
        `SELECT
           count(*) FILTER (WHERE acknowledged_at IS NOT NULL)::int AS done,
           count(*)::int AS total
         FROM physio_reminders WHERE provider_id=$1 AND scheduled_for >= CURRENT_DATE-6`,
        [user.id],
      ),
      many(
        `SELECT psl.session_date, psl.patient_id, psl.pain_before, psl.pain_after, psl.duration_min
         FROM physio_session_logs psl
         WHERE psl.provider_id=$1
         ORDER BY psl.session_date DESC, psl.created_at DESC
         LIMIT 10`,
        [user.id],
      ),
    ]);

    const invoiceRevenue = await one(
      `SELECT
         COALESCE(SUM(total_cents) FILTER (WHERE status='paid' AND paid_at >= date_trunc('month', CURRENT_DATE)), 0)::bigint AS month_paid_cents,
         COALESCE(SUM(total_cents) FILTER (WHERE status='issued'), 0)::bigint AS outstanding_cents,
         MAX(currency) AS currency
       FROM physio_invoices WHERE provider_id=$1`,
      [user.id],
    );

    return {
      appointments: appts,
      flareups,
      compliance_rate: compliance.total > 0 ? Math.round(compliance.done / compliance.total * 100) : null,
      revenue: invoiceRevenue,
      recent_sessions: recentSessions,
    };
  },
});

cap({
  name: 'get_patient_physio_summary', method: 'GET', path: '/physio/patients/:patient_id/summary',
  tag: 'Physio', auth: true, summary: 'Rehabilitation summary for a specific patient',
  input: z.object({ patient_id: z.string().uuid() }),
  handler: async ({ user }, i) => {
    const [sessions, milestones, flareups, latestIntake, outcomeTrend] = await Promise.all([
      many(
        `SELECT session_date, duration_min, pain_before, pain_after, home_program_given
         FROM physio_session_logs
         WHERE patient_id=$1 AND (provider_id=$2 OR patient_id=$2)
         ORDER BY session_date DESC LIMIT 12`,
        [i.patient_id, user.id],
      ),
      many(
        `SELECT id, title, milestone_type, target_date, achieved_at
         FROM physio_milestones
         WHERE patient_id=$1 AND archived_at IS NULL AND (provider_id=$2 OR patient_id=$2)
         ORDER BY sort_order, target_date NULLS LAST`,
        [i.patient_id, user.id],
      ),
      many(
        `SELECT id, reported_at, pain_scale, region, resolved_at
         FROM physio_flareup_reports WHERE patient_id=$1
         ORDER BY reported_at DESC LIMIT 5`,
        [i.patient_id],
      ),
      one(
        `SELECT pain_scale, pain_locations, sport, training_load_hrs_week, consent_given
         FROM physio_intake_forms WHERE patient_id=$1 AND archived_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
        [i.patient_id],
      ),
      many(
        `SELECT measure_type, score, max_score, measured_at
         FROM physio_outcome_measures
         WHERE patient_id=$1 AND (provider_id=$2 OR patient_id=$2)
         ORDER BY measured_at DESC LIMIT 20`,
        [i.patient_id, user.id],
      ),
    ]);

    const milestones_achieved = milestones.filter((m) => m.achieved_at).length;
    const milestones_pending = milestones.filter((m) => !m.achieved_at).length;
    const pain_trend = sessions.map((s) => ({ date: s.session_date, before: s.pain_before, after: s.pain_after }));

    return { sessions, milestones, milestones_achieved, milestones_pending, flareups, latestIntake, outcome_trend: outcomeTrend, pain_trend };
  },
});

cap({
  name: 'list_provider_patients', method: 'GET', path: '/physio/patients',
  tag: 'Physio', auth: true, summary: 'Provider: list patients who have had a session or intake with me',
  input: z.object({}),
  handler: async ({ user }) => {
    return many(
      `SELECT DISTINCT ON (patient_id)
         patient_id,
         MAX(session_date) OVER (PARTITION BY patient_id) AS last_session,
         COUNT(*) OVER (PARTITION BY patient_id)::int AS session_count
       FROM physio_session_logs WHERE provider_id=$1
       ORDER BY patient_id, session_date DESC`,
      [user.id],
    );
  },
});
