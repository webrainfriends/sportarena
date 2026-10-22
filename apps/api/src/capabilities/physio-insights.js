// Physio practice overview: the day's work, suggestions drawn from the clinician's own records, and practice analytics.
// Suggestions are deterministic prompts with their evidence (no model, nothing automatic); the clinician decides. Everything clinical is
// limited to patients whose full consent is active; appointment counts are the clinician's own business data.
import { z } from 'zod';
import { cap } from '../registry.js';
import { many, one } from '../db.js';
import { badRequest } from '../errors.js';
import { audit } from '../helpers.js';
import { clinicalCredential, requireVerifiedProvider } from '../clinical-access.js';
import { ACCESS, MEASURES, adherenceFor, addDays, buildSuggestions, today } from '../physio.js';

const TAG = 'Physio tracking';
const PROVIDER = ['physio', 'doctor'];
const day = z.string().date();

cap({
  name: 'get_physio_suggestions', credential: true, method: 'GET', path: '/physio/suggestions', tag: TAG, auth: PROVIDER,
  summary: 'Physio/doctor: prompts built from your own records for patients who granted full access, each with its reason: plan reviews due, home exercise not logged or low, rising or flat pain, goals due, overdue or apparently met, session notes missing or unsigned, outcomes not measured, progress reports not sent. Most urgent first. Snoozed prompts are left out. These are reminders from your data, not clinical advice.',
  input: z.object({}),
  async handler({ user }) {
    await requireVerifiedProvider(user.id, { action: 'get_physio_suggestions', types: PROVIDER });
    const items = await buildSuggestions(user.id);
    await audit(null, user.id, 'read_clinical', 'physio_suggestions', null);
    return { generated_at: new Date().toISOString(), counts: { high: items.filter((x) => x.priority === 'high').length, medium: items.filter((x) => x.priority === 'medium').length, low: items.filter((x) => x.priority === 'low').length }, items };
  },
});

cap({
  name: 'snooze_physio_suggestion', method: 'POST', path: '/physio/suggestions/snooze', tag: TAG, auth: PROVIDER,
  summary: 'Physio/doctor: hide one suggestion for a number of days (default 7, up to 90). It returns on its own afterwards if still true. Snoozes are only ever added, never deleted.',
  input: z.object({ key: z.string().trim().min(3).max(200), days: z.number().int().min(1).max(90).default(7) }),
  async handler({ user }, i) {
    return one("INSERT INTO physio_suggestion_snoozes(provider_id, key, until) VALUES ($1,$2, now() + make_interval(days => $3)) RETURNING key, until", [user.id, i.key, i.days]);
  },
});

cap({
  name: 'get_physio_home', method: 'GET', path: '/physio/home', tag: TAG, auth: PROVIDER,
  summary: 'Physio/doctor: practice overview: appointments waiting for your answer and coming up in the next 7 days, how many patients, active plans and open goals you have, and the most urgent suggestions. If your professional verification is not current the clinical parts are left out and `credential` explains why.',
  input: z.object({}),
  async handler({ user }) {
    const [waiting, upcoming] = await Promise.all([
      many("SELECT a.id, a.athlete_id, u.display_name AS athlete_name, a.starts_at, a.duration_min, a.status FROM appointments a JOIN users u ON u.id=a.athlete_id WHERE a.provider_id=$1 AND a.status='requested' AND a.starts_at >= now() ORDER BY a.starts_at LIMIT 20", [user.id]),
      many("SELECT a.id, a.athlete_id, u.display_name AS athlete_name, a.starts_at, a.duration_min, a.status, EXISTS (SELECT 1 FROM clinical_encounters e WHERE e.appointment_id=a.id AND e.kind='encounter' AND e.status<>'voided') AS has_note FROM appointments a JOIN users u ON u.id=a.athlete_id WHERE a.provider_id=$1 AND a.status='confirmed' AND a.starts_at >= now() - interval '12 hours' AND a.starts_at < now() + interval '7 days' ORDER BY a.starts_at LIMIT 20", [user.id]),
    ]);
    const cred = await clinicalCredential(user.id, { types: PROVIDER });
    const base = { appointments_waiting: waiting, upcoming };
    if (!cred.ok) return { ...base, credential: { ok: false, reason: cred.reason, type: cred.type }, counts: null, suggestions: { counts: { high: 0, medium: 0, low: 0 }, items: [] } };
    const [counts, items] = await Promise.all([
      one(`SELECT (SELECT count(*)::int FROM (${ACCESS}) x) AS patients,
                  (SELECT count(*)::int FROM treatment_plans p WHERE p.provider_id=$1 AND p.status='active' AND p.patient_id IN (${ACCESS})) AS active_plans,
                  (SELECT count(*)::int FROM physio_goals g WHERE g.provider_id=$1 AND g.status='active' AND g.patient_id IN (${ACCESS})) AS open_goals,
                  (SELECT count(*)::int FROM physio_reports r WHERE r.provider_id=$1 AND r.latest_version=0 AND r.patient_id IN (${ACCESS})) AS draft_reports`, [user.id]),
      buildSuggestions(user.id),
    ]);
    await audit(null, user.id, 'read_clinical', 'physio_home', null);
    return { ...base, credential: { ok: true, type: cred.type, expires_at: cred.expires_at }, counts, suggestions: { counts: { high: items.filter((x) => x.priority === 'high').length, medium: items.filter((x) => x.priority === 'medium').length, low: items.filter((x) => x.priority === 'low').length }, items: items.slice(0, 8), total: items.length } };
  },
});

const pct = (n, d) => (d ? Math.round((100 * n) / d) : null);

cap({
  name: 'physio_analytics', credential: true, method: 'GET', path: '/physio/analytics', tag: TAG, auth: PROVIDER,
  summary: 'Physio/doctor: practice analytics for a period (default last 90 days, max 366): appointments completed/cancelled, patients seen, new and returning, session-note completion, plans by status, home-exercise adherence, outcome change by measure (patients with two or more readings in the period), goals closed and their results, and reports sent and read. Clinical figures only count patients whose consent is still active. Revenue is in the practice report.',
  input: z.object({ from: day.optional(), to: day.optional() }),
  async handler({ user }, i) {
    await requireVerifiedProvider(user.id, { action: 'physio_analytics', types: PROVIDER });
    const to = i.to ?? today(), from = i.from ?? addDays(to, -89);
    if (to < from) throw badRequest('to is before from');
    if (new Date(to) - new Date(from) > 366 * 864e5) throw badRequest('Choose a period of at most a year');
    const W = [user.id, from, to];
    const inRange = 'a.provider_id=$1 AND a.starts_at >= $2::date AND a.starts_at < $3::date + 1';
    const [appts, mix, noted, months, plans, readings, goals, reports, activePlans] = await Promise.all([
      one(`SELECT count(*) FILTER (WHERE a.status='completed')::int AS completed, count(*) FILTER (WHERE a.status='cancelled')::int AS cancelled, count(*) FILTER (WHERE a.status='cancelled' AND a.cancelled_by=a.provider_id)::int AS cancelled_by_you,
                  count(*) FILTER (WHERE a.status='expired')::int AS expired, count(*) FILTER (WHERE a.status IN ('requested','confirmed') AND a.starts_at >= now())::int AS upcoming,
                  count(DISTINCT a.athlete_id) FILTER (WHERE a.status='completed')::int AS patients_seen, coalesce(sum(a.duration_min) FILTER (WHERE a.status='completed'), 0)::int AS minutes FROM appointments a WHERE ${inRange}`, W),
      one(`SELECT count(*) FILTER (WHERE first_at >= $2::date AND first_at < $3::date + 1)::int AS new_patients, count(*) FILTER (WHERE n >= 2)::int AS returning_patients
             FROM (SELECT a.athlete_id, min(a.starts_at) AS first_at, count(*) FILTER (WHERE a.starts_at >= $2::date AND a.starts_at < $3::date + 1) AS n FROM appointments a WHERE a.provider_id=$1 AND a.status='completed' GROUP BY a.athlete_id) x WHERE n >= 1`, W),
      one(`SELECT count(*)::int AS completed_with_note FROM appointments a WHERE ${inRange} AND a.status='completed' AND EXISTS (SELECT 1 FROM clinical_encounters e WHERE e.appointment_id=a.id AND e.kind='encounter' AND e.status='signed')`, W),
      many(`SELECT m AS month, coalesce(s.n, 0)::int AS sessions, coalesce(n.n, 0)::int AS signed_notes FROM (SELECT to_char(d, 'YYYY-MM') AS m FROM generate_series(date_trunc('month', $2::date), date_trunc('month', $3::date), interval '1 month') d) k
              LEFT JOIN (SELECT to_char(date_trunc('month', a.starts_at), 'YYYY-MM') AS m, count(*) AS n FROM appointments a WHERE ${inRange} AND a.status='completed' GROUP BY 1) s USING (m)
              LEFT JOIN (SELECT to_char(date_trunc('month', e.signed_at), 'YYYY-MM') AS m, count(*) AS n FROM clinical_encounters e WHERE e.provider_id=$1 AND e.kind='encounter' AND e.status='signed' AND e.signed_at >= $2::date AND e.signed_at < $3::date + 1 GROUP BY 1) n USING (m) ORDER BY 1`, W),
      many("SELECT p.status, count(*)::int AS n FROM treatment_plans p WHERE p.provider_id=$1 AND p.status<>'draft' GROUP BY p.status", [user.id]),
      many(`SELECT o.patient_id, o.measure, o.body_region, o.side, o.value, o.measured_at, o.id FROM physio_outcomes o WHERE o.provider_id=$1 AND o.voided_at IS NULL AND o.measured_at >= $2::date AND o.measured_at < $3::date + 1 AND o.patient_id IN (${ACCESS}) ORDER BY o.measured_at`, W),
      one(`SELECT count(*) FILTER (WHERE g.created_at >= $2::date AND g.created_at < $3::date + 1)::int AS set, count(*) FILTER (WHERE g.status='achieved' AND g.closed_at >= $2::date AND g.closed_at < $3::date + 1)::int AS achieved,
                  count(*) FILTER (WHERE g.status='not_met' AND g.closed_at >= $2::date AND g.closed_at < $3::date + 1)::int AS not_met, count(*) FILTER (WHERE g.status='discontinued' AND g.closed_at >= $2::date AND g.closed_at < $3::date + 1)::int AS discontinued,
                  count(*) FILTER (WHERE g.status='active')::int AS open, count(*) FILTER (WHERE g.status='active' AND g.target_date < current_date)::int AS overdue FROM physio_goals g WHERE g.provider_id=$1 AND g.patient_id IN (${ACCESS})`, W),
      one(`SELECT count(*)::int AS published, count(x.report_id)::int AS read FROM physio_report_versions v JOIN physio_reports r ON r.id=v.report_id LEFT JOIN physio_report_reads x ON x.report_id=v.report_id AND x.version=v.version
            WHERE r.provider_id=$1 AND v.audience='patient' AND v.published_at >= $2::date AND v.published_at < $3::date + 1`, W),
      many(`SELECT p.id FROM treatment_plans p WHERE p.provider_id=$1 AND p.status='active' AND p.patient_id IN (${ACCESS}) AND EXISTS (SELECT 1 FROM treatment_plan_versions v WHERE v.plan_id=p.id AND v.status='published' AND v.published_at < now() - interval '14 days')`, [user.id]),
    ]);
    // outcomes: per patient and series, first vs last reading inside the period (two or more readings), summarised per measure
    const bySeries = new Map();
    for (const r of readings) { const k = `${r.patient_id}|${r.measure}|${r.body_region ?? ''}|${r.side ?? ''}`; if (!bySeries.has(k)) bySeries.set(k, []); bySeries.get(k).push(r); }
    const byMeasure = new Map();
    for (const list of bySeries.values()) {
      if (list.length < 2) continue;
      const m = list[0].measure, change = Number(list.at(-1).value) - Number(list[0].value), lower = MEASURES[m].better === 'lower';
      const e = byMeasure.get(m) ?? { measure: m, label: MEASURES[m].label, unit: MEASURES[m].unit, series: 0, improved: 0, unchanged: 0, worse: 0, total_change: 0 };
      e.series++; e.total_change += change; if (change === 0) e.unchanged++; else if ((change < 0) === lower) e.improved++; else e.worse++;
      byMeasure.set(m, e);
    }
    const adh = await adherenceFor(activePlans.map((p) => p.id), addDays(today(), -27), today());
    const rates = [...adh.values()].filter((a) => a.percent != null);
    return {
      from, to,
      appointments: { ...appts, hours: Math.round((appts.minutes / 60) * 10) / 10, cancellation_pct: pct(appts.cancelled, appts.completed + appts.cancelled + appts.expired), patients_per_session_avg: appts.patients_seen ? Math.round((appts.completed / appts.patients_seen) * 10) / 10 : null },
      patients: { seen: appts.patients_seen, new: mix?.new_patients ?? 0, returning: mix?.returning_patients ?? 0, return_pct: pct(mix?.returning_patients ?? 0, appts.patients_seen) },
      notes: { completed_with_signed_note: noted.completed_with_note, of_completed: appts.completed, pct: pct(noted.completed_with_note, appts.completed) },
      by_month: months,
      plans: Object.fromEntries(['active', 'paused', 'completed', 'discharged'].map((s) => [s, plans.find((p) => p.status === s)?.n ?? 0])),
      adherence: { basis: 'last 28 days, active plans published at least 14 days ago', plans: activePlans.length, with_logs: rates.filter((a) => a.days_logged > 0).length, without_logs: activePlans.length - rates.filter((a) => a.days_logged > 0).length, avg_percent: rates.length ? Math.round(rates.reduce((s, a) => s + a.percent, 0) / rates.length) : null },
      outcomes: { basis: 'first against last reading in the period, for patients with two or more readings of the same measure', by_measure: [...byMeasure.values()].map((e) => ({ ...e, avg_change: Math.round((e.total_change / e.series) * 10) / 10, total_change: undefined })) },
      goals: { ...goals, achieved_pct: pct(goals.achieved, goals.achieved + goals.not_met + goals.discontinued) },
      reports: { published_to_patients: reports.published, read: reports.read, read_pct: pct(reports.read, reports.published) },
    };
  },
});
