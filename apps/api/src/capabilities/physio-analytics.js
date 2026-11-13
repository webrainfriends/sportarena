// Physio practice analytics (#210) — clinical adherence/outcomes, operational utilisation, financial by currency.
// Financial figures are NEVER summed across currencies; each currency is a separate row.
import { z } from 'zod';
import { cap } from '../registry.js';
import { many, one } from '../db.js';

const dateRange = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

cap({
  name: 'physio_clinical_analytics', method: 'GET', path: '/physio/analytics/clinical',
  tag: 'Physio', auth: true, summary: 'Clinical adherence trends, session outcomes and milestone completion for the practice',
  input: dateRange,
  handler: async ({ user }, i) => {
    const from = i.from ?? new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const to = i.to ?? new Date().toISOString().slice(0, 10);

    const [sessions, milestones, intakes] = await Promise.all([
      many(
        `SELECT
           patient_id,
           count(*) FILTER (WHERE session_date BETWEEN $2 AND $3)::int AS total,
           count(*) FILTER (WHERE session_date BETWEEN $2 AND $3 AND pain_before IS NOT NULL AND pain_after IS NOT NULL)::int AS with_pain_scores,
           round(avg(pain_before) FILTER (WHERE session_date BETWEEN $2 AND $3), 1)::numeric AS avg_pain_before,
           round(avg(pain_after)  FILTER (WHERE session_date BETWEEN $2 AND $3), 1)::numeric AS avg_pain_after
         FROM physio_session_logs
         WHERE provider_id = $1
         GROUP BY patient_id`,
        [user.id, from, to],
      ),
      many(
        `SELECT status, count(*)::int AS cnt
         FROM physio_milestones
         WHERE provider_id = $1
         GROUP BY status`,
        [user.id],
      ),
      one(
        `SELECT
           count(*)::int AS total,
           count(*) FILTER (WHERE flagged)::int AS flagged
         FROM physio_intake_forms f
         JOIN physio_intake_submissions s ON s.form_id = f.id
         WHERE f.provider_id = $1 AND s.created_at::date BETWEEN $2 AND $3`,
        [user.id, from, to],
      ),
    ]);

    return {
      period: { from, to },
      session_summary: sessions,
      milestone_counts: milestones,
      intake_summary: intakes,
      measurement_note: 'Pain trends are directional only. Adherence denominator excludes sessions with no log entry.',
    };
  },
});

cap({
  name: 'physio_financial_analytics', method: 'GET', path: '/physio/analytics/financial',
  tag: 'Physio', auth: true, summary: 'Revenue, collections and outstanding receivables by currency (never summed across currencies)',
  input: dateRange,
  handler: async ({ user }, i) => {
    const from = i.from ?? new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const to = i.to ?? new Date().toISOString().slice(0, 10);

    const rows = await many(
      `SELECT
         currency,
         count(*)::int AS invoice_count,
         sum(total_cents) FILTER (WHERE status NOT IN ('draft','archived'))::bigint AS billed_cents,
         sum(total_cents) FILTER (WHERE status = 'paid')::bigint AS collected_cents,
         sum(total_cents) FILTER (WHERE status NOT IN ('paid','draft','archived') AND (due_date IS NULL OR due_date >= CURRENT_DATE))::bigint AS current_outstanding_cents,
         sum(total_cents) FILTER (WHERE status NOT IN ('paid','draft','archived') AND due_date < CURRENT_DATE)::bigint AS overdue_cents,
         sum(tax_cents)::bigint AS total_tax_cents,
         count(*) FILTER (WHERE status NOT IN ('paid','draft','archived') AND due_date < CURRENT_DATE)::int AS overdue_count
       FROM physio_invoices
       WHERE provider_id = $1
         AND issued_at::date BETWEEN $2 AND $3
         AND archived_at IS NULL
       GROUP BY currency`,
      [user.id, from, to],
    );

    return {
      period: { from, to },
      by_currency: rows,
      basis_note: 'Billed = issued total; Collected = paid invoices. Never summed across currencies.',
    };
  },
});

cap({
  name: 'physio_ops_analytics', method: 'GET', path: '/physio/analytics/ops',
  tag: 'Physio', auth: true, summary: 'Appointment utilisation, no-show rate, new vs returning patients',
  input: dateRange,
  handler: async ({ user }, i) => {
    const from = i.from ?? new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const to = i.to ?? new Date().toISOString().slice(0, 10);

    const [appts, patients] = await Promise.all([
      one(
        `SELECT
           count(*)::int AS total,
           count(*) FILTER (WHERE status = 'completed')::int AS completed,
           count(*) FILTER (WHERE status = 'no_show')::int AS no_shows,
           count(*) FILTER (WHERE status = 'cancelled_by_patient')::int AS cancellations
         FROM appointments
         WHERE provider_id = $1 AND scheduled_at::date BETWEEN $2 AND $3`,
        [user.id, from, to],
      ),
      one(
        `SELECT
           count(DISTINCT patient_id)::int AS unique_patients,
           count(DISTINCT patient_id) FILTER (WHERE first_seen = session_date)::int AS new_patients
         FROM (
           SELECT patient_id, session_date,
                  min(session_date) OVER (PARTITION BY patient_id) AS first_seen
           FROM physio_session_logs WHERE provider_id = $1 AND session_date BETWEEN $2 AND $3
         ) x`,
        [user.id, from, to],
      ),
    ]);

    return { period: { from, to }, appointments: appts, patients };
  },
});
