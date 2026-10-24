// Academy OS 2/3: "Academy Operations Today" and operational analytics. Pure read models over the canonical records (sessions, staff,
// attendance, bookings, timesheets, payroll runs): nothing is stored here and every action deep-links to the workflow that owns it.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { many, one, tx, pool } from '../db.js';
import { badRequest } from '../errors.js';
import { fromLocal } from '../booking/time.js';
import { createHash } from 'node:crypto';
import { notify } from '../notify.js';
import { opsAccess, sessionFor, checkSession, evaluateSession } from '../academy-ops.js';
import { audience } from './academy-sessions.js';

const TAG = 'Academy operations';
const day = z.string().date();
const PRESENT = ['present', 'late', 'left_early'];

cap({
  name: 'get_academy_ops_today', method: 'GET', path: '/organisations/:id/academy/today', tag: TAG,
  summary: 'Academy Operations Today: every session of a day (default today in the academy time zone) with its cohort and programme, staff, expected headcount and attendance progress, staffing / credential / ratio warnings, venue, conflicts and open cover; plus an action inbox (understaffed sessions, cover, leave, timesheets to approve, draft payroll). Coaches see their own sessions. Each action names the screen that owns the work.',
  input: z.object({ id, date: day.optional() }),
  async handler({ user }, i) {
    const a = await opsAccess(user, i.id);
    const prof = await one('SELECT timezone FROM academy_profiles WHERE organisation_id=$1', [i.id]);
    const tz = prof?.timezone ?? 'UTC';
    const date = i.date ?? new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const start = fromLocal(date, 0, tz), end = new Date(+start + 24 * 3600000);
    const all = a.hasBroad('schedule') || a.hasBroad('attendance') || a.hasBroad('roster');
    const cohorts = a.hasBroad('schedule') ? await many("SELECT id, name, programme_id, sport FROM (SELECT k.id, k.name, k.programme_id, p.sport FROM org_cohorts k LEFT JOIN academy_programmes p ON p.id=k.programme_id WHERE k.organisation_id=$1 AND k.status='active') x ORDER BY name, id", [i.id]) : [];
    if (!all && !a.has('attendance') && !a.has('roster')) return { date, timezone: tz, my_role: a.role, permissions: [...a.perms], sessions: [], cohorts, next_session_id: null, inbox: {}, notes: {} };
    const rows = await many(
      `SELECT s.*, k.name AS cohort_name, k.coach_id AS cohort_coach_id, p.title AS programme_title,
              (SELECT count(*)::int FROM org_enrolments e WHERE e.cohort_id=s.cohort_id AND e.status='enrolled') AS enrolled,
              (SELECT count(*)::int FROM academy_attendance t WHERE t.session_id=s.id AND t.status IN ('present','late','left_early')) AS present,
              (SELECT count(*)::int FROM academy_attendance t WHERE t.session_id=s.id AND t.status IN ('absent','excused')) AS absent,
              EXISTS (SELECT 1 FROM academy_cover_requests r WHERE r.session_id=s.id AND r.status='open') AS cover_open
         FROM academy_sessions s JOIN org_cohorts k ON k.id=s.cohort_id LEFT JOIN academy_programmes p ON p.id=s.programme_id
        WHERE s.organisation_id=$1 AND s.starts_at >= $2 AND s.starts_at < $3 AND s.status <> 'cancelled'
          AND ($4 OR k.coach_id=$5 OR EXISTS (SELECT 1 FROM academy_session_staff st WHERE st.session_id=s.id AND st.user_id=$5 AND st.status IN ('assigned','confirmed')))
        ORDER BY s.starts_at, s.id`, [i.id, start, end, all, user.id]);
    const now = Date.now(), sessions = [];
    for (const s of rows.filter((x) => all ? a.scopeOk(x) : true)) {
      const chk = await checkSession(pool, s);
      const staff = chk.compliance.staff.map((x) => ({ user_id: x.user_id, display_name: x.display_name, role: x.role, status: x.status, duty_label: x.duty_label }));
      const venue = chk.venue;
      sessions.push({
        id: s.id, title: s.title, cohort_id: s.cohort_id, cohort: s.cohort_name, programme: s.programme_title, sport: s.sport, delivery_type: s.delivery_type, starts_at: s.starts_at, ends_at: s.ends_at, timezone: s.timezone, status: s.status,
        phase: new Date(s.ends_at) < now ? 'done' : new Date(s.starts_at) <= now ? 'current' : 'upcoming',
        staff, enrolled: s.enrolled, expected: chk.compliance.expected, present: s.present, absent: s.absent, attendance_progress: chk.compliance.expected ? Math.round(((s.present + s.absent) / chk.compliance.expected) * 100) : null,
        compliance: { level: chk.compliance.level, issues: chk.compliance.checks.filter((c) => c.severity !== 'ok') }, conflicts: chk.conflicts,
        venue: venue ? { reservation_id: venue.reservation_id, booking_id: venue.booking_id, name: `${venue.venue_name} · ${venue.resource_name}`, confirmed: venue.booking_status === 'confirmed' } : null,
        cover_open: s.cover_open,
        actions: [
          { key: 'attendance', label: 'Take attendance', screen: 'AcademySession', params: { id: s.id, tab: 'attendance' }, enabled: s.status === 'published' },
          { key: 'assign', label: 'Assign / replace coach', screen: 'AcademySession', params: { id: s.id, tab: 'staff' }, enabled: a.has('schedule') },
          { key: 'substitute', label: 'Find substitute', screen: 'AcademySession', params: { id: s.id, tab: 'staff', find: true }, enabled: a.has('schedule') },
          { key: 'move', label: 'Move / reschedule', screen: 'AcademySession', params: { id: s.id, tab: 'details' }, enabled: a.has('schedule') },
          { key: 'venue', label: venue ? 'Open venue booking' : 'Book a venue', screen: venue ? 'Reservation' : 'AcademySession', params: venue ? { id: venue.reservation_id } : { id: s.id, tab: 'venue' }, enabled: a.has('schedule') || !!venue },
          { key: 'notify', label: 'Notify group', screen: 'AcademySession', params: { id: s.id, tab: 'details', notify: true }, enabled: a.has('schedule') },
          { key: 'studio', label: 'Open in Performance Studio', screen: 'PerformanceStudio', params: { source_type: 'academy_session', source_id: s.id }, enabled: staff.some((x) => x.user_id === user.id && ['lead', 'assistant'].includes(x.role)) },
        ],
      });
    }
    const inbox = {
      understaffed: sessions.filter((s) => s.compliance.level !== 'compliant').length,
      conflicts: sessions.filter((s) => s.conflicts.length).length,
      cover_open: all ? (await one("SELECT count(*)::int AS n FROM academy_cover_requests r JOIN academy_sessions s ON s.id=r.session_id WHERE s.organisation_id=$1 AND r.status='open' AND s.starts_at > now() - interval '1 day'", [i.id])).n : 0,
      drafts: all ? (await one("SELECT count(*)::int AS n FROM academy_sessions WHERE organisation_id=$1 AND status='draft' AND starts_at > now()", [i.id])).n : 0,
      time_off_pending: a.admin ? (await one("SELECT count(*)::int AS n FROM academy_staff_availability WHERE organisation_id=$1 AND kind='time_off' AND status='pending'", [i.id])).n : 0,
      timesheets_to_approve: a.has('timesheets') ? (await one("SELECT count(*)::int AS n FROM academy_timesheets WHERE organisation_id=$1 AND status='submitted'", [i.id])).n : 0,
      timesheet_exceptions: a.has('timesheets') ? (await one("SELECT count(*)::int AS n FROM academy_timesheets WHERE organisation_id=$1 AND status='open' AND clock_in IS NOT NULL AND clock_out IS NULL AND clock_in < now() - interval '12 hours'", [i.id])).n : 0,
      payroll_drafts: a.has('payroll') ? (await one("SELECT count(*)::int AS n FROM academy_payroll_runs WHERE organisation_id=$1 AND status='draft'", [i.id])).n : 0,
      unpaid_commercial: a.has('roster') && all ? (await one("SELECT count(*)::int AS n FROM academy_charges WHERE organisation_id=$1 AND status='awaiting_payment' AND due_on < current_date", [i.id])).n : 0,
    };
    const next = sessions.find((s) => s.phase !== 'done') ?? null;
    return { date, timezone: tz, my_role: a.role, permissions: [...a.perms], sessions, cohorts, next_session_id: next?.id ?? null, inbox, notes: { unpaid_commercial: 'Overdue tuition is owned by Academy billing; this count only links you there.' } };
  },
});

cap({
  name: 'notify_academy_session_group', method: 'POST', path: '/academy/sessions/:id/notify', tag: TAG,
  summary: 'Send a short message about a session to its athletes and, for young people, their verified guardians (and optionally the assigned staff) through the shared notification system. Schedule access. Repeating the same text for the same session is delivered once.',
  input: z.object({ id, title: z.string().trim().min(2).max(80), body: z.string().trim().min(2).max(300), include_staff: z.boolean().default(false) }),
  handler: ({ user }, i) => tx(async (c) => {
    const { s } = await sessionFor(user, i.id, 'schedule', { write: true, c });
    const h = createHash('sha256').update(`${i.title}|${i.body}`).digest('hex').slice(0, 16);
    const to = await audience(c, s, { staff: i.include_staff, athletes: true });
    for (const uid of to) await notify(c, uid, { kind: 'academy_session_message', title: i.title, body: i.body, data: { session_id: s.id, organisation_id: s.organisation_id }, dedupe_key: `academy-msg:${s.id}:${h}:${uid}` });
    return { recipients: to.length };
  }),
});

cap({
  name: 'get_academy_ops_analytics', method: 'GET', path: '/organisations/:id/academy/analytics', tag: TAG,
  summary: 'Operational analytics for a period (schedule access; payroll cost needs payroll access): planned vs delivered sessions, cancellation and reschedule rate, attendance rate by group and programme, absence by weekday, coach utilisation and substitutions, staffing ratio exceptions, scheduled vs worked staff hours, approved compensation cost by programme (per currency, never summed across currencies) and venue usage. Programme profitability is out of scope here.',
  input: z.object({ id, from: day, to: day }),
  async handler({ user }, i) {
    const a = await opsAccess(user, i.id);
    a.need('schedule');
    if (i.to < i.from || Date.parse(i.to) - Date.parse(i.from) > 186 * 86400000) throw badRequest('Choose a period of at most six months');
    const w = [i.id, i.from, i.to];
    const [totals, byCohort, byWeekday, staffRows, subs, hours, venues, ratio] = await Promise.all([
      one(`SELECT count(*) FILTER (WHERE status <> 'draft')::int AS planned, count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled, count(*) FILTER (WHERE status IN ('published','completed') AND ends_at < now())::int AS delivered,
                  (SELECT count(*)::int FROM academy_session_changes ch JOIN academy_sessions x ON x.id=ch.session_id WHERE x.organisation_id=$1 AND ch.kind='rescheduled' AND x.starts_at >= $2::date AND x.starts_at < $3::date + 1) AS rescheduled
             FROM academy_sessions WHERE organisation_id=$1 AND starts_at >= $2::date AND starts_at < $3::date + 1`, w),
      many(`SELECT k.id AS cohort_id, k.name AS cohort, p.title AS programme, count(*) FILTER (WHERE t.status IN ('present','late','left_early'))::int AS present, count(*) FILTER (WHERE t.status IN ('present','late','left_early','absent','excused'))::int AS marked, count(*) FILTER (WHERE t.status='late')::int AS late
              FROM academy_attendance t JOIN academy_sessions s ON s.id=t.session_id JOIN org_cohorts k ON k.id=s.cohort_id LEFT JOIN academy_programmes p ON p.id=s.programme_id
             WHERE s.organisation_id=$1 AND s.starts_at >= $2::date AND s.starts_at < $3::date + 1 GROUP BY k.id, k.name, p.title ORDER BY k.name, k.id`, w),
      many(`SELECT extract(dow FROM s.starts_at AT TIME ZONE s.timezone)::int AS weekday, count(*) FILTER (WHERE t.status IN ('absent','excused'))::int AS absences, count(*)::int AS marked
              FROM academy_attendance t JOIN academy_sessions s ON s.id=t.session_id WHERE s.organisation_id=$1 AND s.starts_at >= $2::date AND s.starts_at < $3::date + 1 AND t.status IN ('present','late','left_early','absent','excused') GROUP BY 1 ORDER BY 1`, w),
      many(`SELECT u.id AS user_id, u.display_name, count(*)::int AS sessions, (sum(extract(epoch FROM (s.ends_at - s.starts_at)) / 60))::int AS scheduled_minutes
              FROM academy_session_staff st JOIN academy_sessions s ON s.id=st.session_id JOIN users u ON u.id=st.user_id
             WHERE s.organisation_id=$1 AND st.status IN ('assigned','confirmed') AND s.status IN ('published','completed') AND s.starts_at >= $2::date AND s.starts_at < $3::date + 1 GROUP BY u.id, u.display_name ORDER BY u.display_name, u.id`, w),
      one(`SELECT count(*)::int AS n FROM academy_session_changes ch JOIN academy_sessions s ON s.id=ch.session_id WHERE s.organisation_id=$1 AND ch.kind='staff_replaced' AND s.starts_at >= $2::date AND s.starts_at < $3::date + 1`, w),
      a.has('timesheets') ? one(`SELECT coalesce(sum(extract(epoch FROM (scheduled_end - scheduled_start)) / 60) FILTER (WHERE scheduled_start IS NOT NULL), 0)::int AS scheduled_minutes, coalesce(sum(minutes) FILTER (WHERE scheduled_start IS NOT NULL), 0)::int AS worked_minutes, coalesce(sum(minutes) FILTER (WHERE scheduled_start IS NULL), 0)::int AS unscheduled_minutes FROM academy_timesheets WHERE organisation_id=$1 AND work_date BETWEEN $2 AND $3 AND status IN ('submitted','approved')`, w) : null,
      many(`SELECT v.id AS venue_id, v.name AS venue, count(DISTINCT s.id)::int AS sessions, (sum(extract(epoch FROM (s.ends_at - s.starts_at)) / 60))::int AS minutes
              FROM academy_sessions s JOIN session_venue_links l ON l.session_type='academy_session' AND l.session_id=s.id AND l.released_at IS NULL JOIN bookings b ON b.id=l.booking_id AND b.status='confirmed' JOIN resources r ON r.id=b.resource_id JOIN venues v ON v.id=r.venue_id
             WHERE s.organisation_id=$1 AND s.status <> 'cancelled' AND s.starts_at >= $2::date AND s.starts_at < $3::date + 1 GROUP BY v.id, v.name ORDER BY v.name, v.id`, w),
      many(`SELECT s.* FROM academy_sessions s WHERE s.organisation_id=$1 AND s.status IN ('published','completed') AND s.starts_at >= $2::date AND s.starts_at < $3::date + 1 ORDER BY s.starts_at, s.id LIMIT 400`, w),
    ]);
    const exceptions = [];
    for (const s of ratio) { const e = await evaluateSession(pool, s); const bad = e.checks.filter((x) => ['ratio', 'min_coaches', 'lead', 'lead_credential'].includes(x.code) && !x.ok); if (bad.length) exceptions.push({ session_id: s.id, title: s.title, starts_at: s.starts_at, issues: bad.map((x) => x.message) }); }
    const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
    const cost = a.has('payroll') ? await many(
      `SELECT r.currency, p.id AS programme_id, coalesce(p.title, 'Not tied to a programme') AS programme, sum((d->>'amount_minor')::bigint)::bigint AS amount_minor
         FROM academy_payroll_lines l JOIN academy_payroll_runs r ON r.id=l.run_id AND r.status='approved', jsonb_array_elements(l.detail) d
         JOIN academy_timesheets t ON t.id = (d->>'timesheet_id')::uuid LEFT JOIN academy_programmes p ON p.id=t.programme_id
        WHERE r.organisation_id=$1 AND t.work_date BETWEEN $2 AND $3 AND d ? 'timesheet_id' GROUP BY r.currency, p.id, p.title ORDER BY r.currency, programme`, w) : null;
    return {
      period: { from: i.from, to: i.to },
      sessions: { ...totals, cancellation_rate_pct: pct(totals.cancelled, totals.planned), reschedule_rate_pct: pct(totals.rescheduled, totals.planned) },
      attendance_by_group: byCohort.map((r) => ({ ...r, attendance_rate_pct: pct(r.present, r.marked) })),
      absence_by_weekday: byWeekday.map((r) => ({ ...r, absence_rate_pct: pct(r.absences, r.marked) })),
      coach_utilisation: staffRows, substitutions: subs.n, staffing_exceptions: exceptions,
      staff_hours: hours ? { scheduled_hours: Math.round(hours.scheduled_minutes / 6) / 10, worked_hours: Math.round(hours.worked_minutes / 6) / 10, unscheduled_hours: Math.round(hours.unscheduled_minutes / 6) / 10 } : null,
      compensation_by_programme: cost, venue_usage: venues,
    };
  },
});
