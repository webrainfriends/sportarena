// Academy OS 2/3: the timetable. A session is one scheduled occurrence of an existing cohort (who / when / where). Programme, cohort,
// athletes and staff stay the canonical records; the venue is a canonical booking linked through session_venue_links; the coaching
// content stays in Performance Studio. Everything is checked live and refuses to double-book people, groups or courts.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { expandDates } from '../recurrence.js';
import { fromLocal, hhmm, validTimezone } from '../booking/time.js';
import { guardiansOf, isYouth } from '../youth.js';
import { badgesFor } from '../verification.js';
import { opsAccess, sessionFor, staffIssues, cohortIssues, checkSession, heldVenue, evaluateSession, ADMINS } from '../academy-ops.js';
import { placeBasket } from './reservations.js';
import { reservationView } from '../booking/engine.js';

const TAG = 'Academy operations';
const day = z.string().date();
const dt = z.string().datetime({ offset: true });
const time = z.string().regex(/^\d{1,2}:\d{2}$/);
const DELIVERY = ['training', 'assessment', 'trial', 'workshop', 'camp', 'classroom', 'match_prep', 'makeup', 'other'];

const lockStaff = (c, uid) => c.query("SELECT pg_advisory_xact_lock(hashtextextended('academy-staff:' || $1, 0))", [uid]);
const lockCohort = (c, cid) => c.query('SELECT id FROM org_cohorts WHERE id=$1 FOR UPDATE', [cid]);
const change = (c, sessionId, kind, actor, reason, before, after) => c.query('INSERT INTO academy_session_changes(session_id, kind, actor_id, reason, before, after) VALUES ($1,$2,$3,$4,$5,$6)', [sessionId, kind, actor, reason ?? null, before ?? null, after ?? null]);

/** Staff, enrolled athletes and (for young people) their guardians. Generic wording: no names or fees in previews. */
export async function audience(c, s, { staff = true, athletes = true } = {}) {
  const set = new Set();
  if (staff) for (const r of (await c.query("SELECT user_id FROM academy_session_staff WHERE session_id=$1 AND status IN ('assigned','confirmed')", [s.id])).rows) set.add(r.user_id);
  if (athletes) {
    const ids = (await c.query("SELECT user_id FROM org_enrolments WHERE cohort_id=$1 AND status='enrolled' UNION SELECT user_id FROM academy_attendance WHERE session_id=$2 AND guest", [s.cohort_id, s.id])).rows.map((r) => r.user_id);
    for (const a of ids) { if (await isYouth(a, c)) for (const g of await guardiansOf(a, c)) set.add(g); else set.add(a); }
  }
  return [...set];
}
export async function tellSession(c, s, kind, title, body, opts) {
  for (const uid of await audience(c, s, opts)) await notify(c, uid, { kind: `academy_session_${kind}`, title, body, data: { organisation_id: s.organisation_id, session_id: s.id, cohort_id: s.cohort_id }, dedupe_key: `academy-session:${kind}:${s.id}:${s.row_version}:${uid}` });
}

const view = async (c, s) => {
  const q = (t, p) => c.query(t, p).then((r) => r.rows);
  const [staff, changes, venue, cohort] = await Promise.all([
    q(`SELECT st.id, st.user_id, st.role, st.duty_label, st.status, u.display_name, u.handle FROM academy_session_staff st JOIN users u ON u.id=st.user_id WHERE st.session_id=$1 AND st.status <> 'removed' ORDER BY st.role, u.display_name, u.id`, [s.id]),
    q('SELECT kind, reason, before, after, created_at, actor_id FROM academy_session_changes WHERE session_id=$1 ORDER BY created_at, id', [s.id]),
    heldVenue(c, s.id),
    q('SELECT k.name, p.title AS programme FROM org_cohorts k LEFT JOIN academy_programmes p ON p.id=k.programme_id WHERE k.id=$1', [s.cohort_id]),
  ]);
  const compliance = await evaluateSession(c, s);
  return { ...s, cohort_name: cohort[0]?.name, programme_title: cohort[0]?.programme, staff, changes, venue, compliance: { level: compliance.level, checks: compliance.checks, expected: compliance.expected } };
};

cap({
  name: 'configure_cohort_staffing', method: 'PATCH', path: '/cohorts/:id/academy/staffing', tag: TAG,
  summary: 'Set the staffing rules new sessions of a group start with: minimum coaches, maximum athletes per coach, whether the lead needs a verified coach credential, and whether an unmet rule BLOCKS publishing (otherwise it only warns). A configured rule is an operating policy, not a claim of legal compliance.',
  input: z.object({ id, min_coaches: z.number().int().min(0).max(20).optional(), max_ratio: z.number().int().min(1).max(100).nullable().optional(), lead_credential_required: z.boolean().optional(), enforce_staffing: z.boolean().optional(), capacity: z.number().int().min(1).max(5000).nullable().optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { cohort } = await cohortOf(user, i.id, { write: true, c });
    const r = (await c.query(
      `UPDATE org_cohorts SET min_coaches=coalesce($2, min_coaches), max_ratio=CASE WHEN $3::boolean THEN $4 ELSE max_ratio END, lead_credential_required=coalesce($5, lead_credential_required), enforce_staffing=coalesce($6, enforce_staffing), capacity=CASE WHEN $7::boolean THEN $8 ELSE capacity END WHERE id=$1 RETURNING *`,
      [cohort.id, i.min_coaches ?? null, i.max_ratio !== undefined, i.max_ratio ?? null, i.lead_credential_required ?? null, i.enforce_staffing ?? null, i.capacity !== undefined, i.capacity ?? null])).rows[0];
    await audit(c, user.id, 'configure_cohort_staffing', 'org_cohorts', cohort.id);
    return { id: r.id, min_coaches: r.min_coaches, max_ratio: r.max_ratio, lead_credential_required: r.lead_credential_required, enforce_staffing: r.enforce_staffing, capacity: r.capacity, applies_to: 'sessions created from now on; existing sessions keep their own rules' };
  }),
});

// ------------------------------------------------------------------ timetable generation
const timetable = z.object({
  starts_on: day, ends_on: day, weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  extra_dates: z.array(day).max(60).default([]).describe('one-off dates added to the pattern'),
  skip_dates: z.array(day).max(120).default([]), closures: z.array(z.object({ from: day, to: day, label: z.string().max(60).optional() })).max(20).default([]).describe('holiday / closure ranges'),
  start_time: time, duration_min: z.number().int().min(10).max(600), timezone: z.string().max(60).optional(),
  title: z.string().trim().min(2).max(120).optional(), delivery_type: z.enum(DELIVERY).default('training'),
  lead_id: id.optional(), assistant_ids: z.array(id).max(10).default([]), duty_roles: z.array(z.string().max(40)).max(6).default([]),
  capacity: z.number().int().min(1).max(500).optional(), min_coaches: z.number().int().min(0).max(20).optional(), max_ratio: z.number().int().min(1).max(100).optional(),
});

async function plan(c, a, cohort, i) {
  const tz = i.timezone ?? (await c.query('SELECT timezone FROM academy_profiles WHERE organisation_id=$1', [cohort.organisation_id])).rows[0]?.timezone ?? 'UTC';
  if (!validTimezone(tz)) throw badRequest('Unknown time zone');
  const start = hhmm(i.start_time);
  if (Number.isNaN(start) || start + i.duration_min > 1440) throw badRequest('The session must start and end on the same day');
  const closed = new Set();
  for (const r of i.closures) { if (r.to < r.from) throw badRequest('A closure ends before it starts'); for (let d = r.from; d <= r.to; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)) closed.add(d); }
  const dates = expandDates({ starts_on: i.starts_on, ends_on: i.ends_on, weekdays: i.weekdays, extra_dates: i.extra_dates, exclude_dates: [...i.skip_dates, ...closed] });
  const lead = i.lead_id ?? cohort.coach_id ?? null;
  const team = [...(lead ? [{ user_id: lead, role: 'lead' }] : []), ...i.assistant_ids.filter((x) => x !== lead).map((u) => ({ user_id: u, role: 'assistant' }))];
  for (const t of team) if (!(await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [cohort.organisation_id, t.user_id])).rowCount) throw badRequest('Only active members of the organisation can be assigned');
  const rows = [];
  for (const date of dates) {
    const starts_at = fromLocal(date, start, tz), ends_at = new Date(+starts_at + i.duration_min * 60000);
    const exists = (await c.query("SELECT id FROM academy_sessions WHERE cohort_id=$1 AND starts_at=$2 AND status<>'cancelled'", [cohort.id, starts_at])).rows[0];
    const issues = exists ? [] : [...(await cohortIssues(c, { cohort_id: cohort.id, starts_at, ends_at }))];
    const staff = [];
    for (const t of team) staff.push({ ...t, issues: exists ? [] : await staffIssues(c, cohort.organisation_id, t.user_id, starts_at, ends_at, { tz }) });
    rows.push({ date, starts_at: starts_at.toISOString(), ends_at: ends_at.toISOString(), existing_session_id: exists?.id ?? null, cohort_issues: issues, staff });
  }
  return { tz, rows, team };
}

const cohortOf = async (user, cohortId, { write = false, c } = {}) => {
  const q = c ? (t, p) => c.query(t, p).then((r) => r.rows[0]) : one;
  const cohort = await q('SELECT * FROM org_cohorts WHERE id=$1', [cohortId]);
  if (!cohort) throw notFound('Cohort');
  const a = await opsAccess(user, cohort.organisation_id, { write, c });
  a.need('schedule');
  if (!a.scopeOk({ sport: null, cohort_id: cohort.id }) && a.eng?.scope_cohort_ids?.length) throw forbidden('This cohort is outside your scope');
  if (write && cohort.status !== 'active') throw conflict('This cohort is archived and read-only');
  return { cohort, a };
};

cap({
  name: 'preview_academy_timetable', method: 'POST', path: '/cohorts/:id/academy/timetable/preview', tag: TAG,
  summary: 'Preview a term timetable for a cohort before anything is created: the dates (weekdays, extra dates, minus skip dates and closures), which already exist, and the staff and group conflicts each date would have. Writes nothing.',
  input: z.object({ id, ...timetable.shape }),
  async handler({ user }, i) {
    const { cohort } = await cohortOf(user, i.id);
    const p = await plan(pool, null, cohort, i);
    const conflicts = p.rows.reduce((n, r) => n + r.cohort_issues.length + r.staff.reduce((m, s) => m + s.issues.length, 0), 0);
    return { cohort_id: cohort.id, timezone: p.tz, sessions: p.rows, new_sessions: p.rows.filter((r) => !r.existing_session_id).length, existing: p.rows.filter((r) => r.existing_session_id).length, conflicts };
  },
});

cap({
  name: 'generate_academy_timetable', method: 'POST', path: '/cohorts/:id/academy/timetable', tag: TAG, status: 201,
  summary: 'Create the draft sessions of a term from the same input as the preview. Idempotent: the same idempotency_key returns the first result; dates that already have a live session are skipped, never duplicated. Staff who would clash are left unassigned and reported.',
  input: z.object({ id, idempotency_key: z.string().min(8).max(80), ...timetable.shape }),
  handler: ({ user }, i) => tx(async (c) => {
    const { cohort, a } = await cohortOf(user, i.id, { write: true, c });
    await lockCohort(c, cohort.id);
    const prior = (await c.query('SELECT result FROM academy_generation_runs WHERE organisation_id=$1 AND idempotency_key=$2', [cohort.organisation_id, i.idempotency_key])).rows[0];
    if (prior) return { ...prior.result, replayed: true };
    const p = await plan(c, a, cohort, i);
    const programme = cohort.programme_id ? (await c.query('SELECT sport, title, season_id FROM academy_programmes WHERE id=$1', [cohort.programme_id])).rows[0] : null;
    const created = [], skipped = [], unassigned = [];
    for (const r of p.rows) {
      if (r.existing_session_id) { skipped.push({ date: r.date, session_id: r.existing_session_id, reason: 'already scheduled' }); continue; }
      const s = (await c.query(
        `INSERT INTO academy_sessions(organisation_id, cohort_id, programme_id, season_id, sport, title, delivery_type, timezone, starts_at, ends_at, capacity, min_coaches, max_ratio, lead_credential_required, enforce_staffing, duty_roles, generation_key, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT DO NOTHING RETURNING *`,
        [cohort.organisation_id, cohort.id, cohort.programme_id, cohort.season_id ?? programme?.season_id ?? null, programme?.sport ?? null, i.title ?? `${cohort.name}${programme ? ` · ${programme.title}` : ''}`.slice(0, 120), i.delivery_type, p.tz, r.starts_at, r.ends_at,
          i.capacity ?? cohort.capacity, i.min_coaches ?? cohort.min_coaches ?? 1, i.max_ratio ?? cohort.max_ratio, cohort.lead_credential_required, cohort.enforce_staffing, i.duty_roles, i.idempotency_key, user.id])).rows[0];
      if (!s) { skipped.push({ date: r.date, reason: 'already scheduled' }); continue; }
      await change(c, s.id, 'created', user.id, null, null, { starts_at: s.starts_at, ends_at: s.ends_at });
      created.push({ id: s.id, date: r.date, starts_at: r.starts_at });
      for (const t of r.staff) {
        if (t.issues.length) { unassigned.push({ session_id: s.id, date: r.date, user_id: t.user_id, issues: t.issues.map((x) => x.message) }); continue; }
        await c.query("INSERT INTO academy_session_staff(session_id, user_id, role, assigned_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [s.id, t.user_id, t.role, user.id]);
      }
    }
    await audit(c, user.id, 'generate_academy_timetable', 'org_cohorts', cohort.id);
    const result = { cohort_id: cohort.id, created, skipped, unassigned, created_count: created.length };
    await c.query('INSERT INTO academy_generation_runs(organisation_id, idempotency_key, cohort_id, result, created_by) VALUES ($1,$2,$3,$4,$5)', [cohort.organisation_id, i.idempotency_key, cohort.id, result, user.id]);
    return { ...result, replayed: false };
  }),
});

cap({
  name: 'create_academy_session', method: 'POST', path: '/cohorts/:id/academy/sessions', tag: TAG, status: 201,
  summary: 'Add one session to a cohort: a special session, a trial, or a make-up for a cancelled one (makeup_for).',
  input: z.object({ id, starts_at: dt, duration_min: z.number().int().min(10).max(600), title: z.string().trim().min(2).max(120).optional(), delivery_type: z.enum(DELIVERY).default('training'), timezone: z.string().max(60).optional(),
    makeup_for: id.optional(), capacity: z.number().int().min(1).max(500).optional(), lead_id: id.optional(), assistant_ids: z.array(id).max(10).default([]), duty_roles: z.array(z.string().max(40)).max(6).default([]), self_checkin: z.boolean().default(false) }),
  handler: ({ user }, i) => tx(async (c) => {
    const { cohort } = await cohortOf(user, i.id, { write: true, c });
    await lockCohort(c, cohort.id);
    const tz = i.timezone ?? (await c.query('SELECT timezone FROM academy_profiles WHERE organisation_id=$1', [cohort.organisation_id])).rows[0]?.timezone ?? 'UTC';
    if (!validTimezone(tz)) throw badRequest('Unknown time zone');
    const ends = new Date(Date.parse(i.starts_at) + i.duration_min * 60000);
    const iss = await cohortIssues(c, { cohort_id: cohort.id, starts_at: i.starts_at, ends_at: ends });
    if (iss.length) throw conflict('That time clashes', { conflicts: iss });
    if (i.makeup_for && !(await c.query("SELECT 1 FROM academy_sessions WHERE id=$1 AND cohort_id=$2 AND status='cancelled'", [i.makeup_for, cohort.id])).rowCount) throw badRequest('A make-up must be for a cancelled session of the same cohort');
    const programme = cohort.programme_id ? (await c.query('SELECT sport, title, season_id FROM academy_programmes WHERE id=$1', [cohort.programme_id])).rows[0] : null;
    const s = (await c.query(
      `INSERT INTO academy_sessions(organisation_id, cohort_id, programme_id, season_id, sport, title, delivery_type, timezone, starts_at, ends_at, capacity, min_coaches, max_ratio, lead_credential_required, enforce_staffing, duty_roles, makeup_for, self_checkin, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [cohort.organisation_id, cohort.id, cohort.programme_id, cohort.season_id ?? programme?.season_id ?? null, programme?.sport ?? null, i.title ?? `${cohort.name}${i.makeup_for ? ' · make-up' : ''}`, i.makeup_for ? 'makeup' : i.delivery_type, tz, i.starts_at, ends, i.capacity ?? cohort.capacity, cohort.min_coaches ?? 1, cohort.max_ratio, cohort.lead_credential_required, cohort.enforce_staffing, i.duty_roles, i.makeup_for ?? null, i.self_checkin, user.id]
    )).rows[0];
    await change(c, s.id, 'created', user.id, i.makeup_for ? 'make-up session' : null, null, { starts_at: s.starts_at });
    const lead = i.lead_id ?? cohort.coach_id;
    const unassigned = [];
    for (const [uid, role] of [...(lead ? [[lead, 'lead']] : []), ...i.assistant_ids.filter((x) => x !== lead).map((x) => [x, 'assistant'])]) {
      await lockStaff(c, uid);
      const iss2 = await staffIssues(c, cohort.organisation_id, uid, s.starts_at, s.ends_at, { tz });
      if (iss2.length) { unassigned.push({ user_id: uid, issues: iss2.map((x) => x.message) }); continue; }
      await c.query('INSERT INTO academy_session_staff(session_id, user_id, role, assigned_by) VALUES ($1,$2,$3,$4)', [s.id, uid, role, user.id]);
    }
    return { ...(await view(c, s)), unassigned };
  }),
});

// ------------------------------------------------------------------ reading
cap({
  name: 'list_academy_sessions', method: 'GET', path: '/organisations/:id/academy/sessions', tag: TAG,
  summary: 'The timetable: sessions in a date range with staff, headcount, venue and staffing status. Filter by cohort, programme, sport, coach or status. Deterministic order (start time, then id). Scoped staff see only their scope; coaches see their own sessions.',
  input: z.object({ id, from: day, to: day, cohort_id: id.optional(), programme_id: id.optional(), sport: z.string().max(40).optional(), coach_id: id.optional(), status: z.enum(['draft', 'published', 'cancelled', 'completed']).optional(), mine: z.coerce.boolean().optional(), ...page, limit: z.coerce.number().int().min(1).max(300).default(100) }),
  async handler({ user }, i) {
    const a = await opsAccess(user, i.id);
    if (!a.perms.size && !a.eng) throw forbidden('You do not have access to the academy timetable');
    if (Date.parse(i.to) - Date.parse(i.from) > 93 * 86400000) throw badRequest('Range is limited to 93 days');
    const own = i.mine || !a.has('schedule');
    const rows = await many(
      `SELECT s.*, k.name AS cohort_name, k.coach_id AS cohort_coach_id,
              (SELECT coalesce(json_agg(json_build_object('user_id', st.user_id, 'role', st.role, 'status', st.status, 'display_name', u.display_name, 'duty_label', st.duty_label) ORDER BY st.role, u.display_name), '[]') FROM academy_session_staff st JOIN users u ON u.id=st.user_id WHERE st.session_id=s.id AND st.status IN ('assigned','confirmed')) AS staff,
              (SELECT count(*)::int FROM academy_attendance t WHERE t.session_id=s.id AND t.status NOT IN ('expected')) AS marked,
              (SELECT count(*)::int FROM org_enrolments e WHERE e.cohort_id=s.cohort_id AND e.status='enrolled') AS enrolled,
              (SELECT v.name || ' · ' || r.name FROM session_venue_links l JOIN bookings b ON b.id=l.booking_id AND b.status='confirmed' JOIN resources r ON r.id=b.resource_id JOIN venues v ON v.id=r.venue_id WHERE l.session_type='academy_session' AND l.session_id=s.id AND l.released_at IS NULL LIMIT 1) AS venue
         FROM academy_sessions s JOIN org_cohorts k ON k.id=s.cohort_id
        WHERE s.organisation_id=$1 AND s.starts_at >= $2::date AND s.starts_at < $3::date + 1
          AND ($4::uuid IS NULL OR s.cohort_id=$4) AND ($5::uuid IS NULL OR s.programme_id=$5) AND ($6::text IS NULL OR s.sport=$6) AND ($7::text IS NULL OR s.status=$7)
          AND ($8::uuid IS NULL OR EXISTS (SELECT 1 FROM academy_session_staff st WHERE st.session_id=s.id AND st.user_id=$8 AND st.status IN ('assigned','confirmed')))
          AND (NOT $9 OR k.coach_id=$10 OR EXISTS (SELECT 1 FROM academy_session_staff st WHERE st.session_id=s.id AND st.user_id=$10 AND st.status IN ('assigned','confirmed')))
        ORDER BY s.starts_at, s.id LIMIT $11 OFFSET $12`,
      [i.id, i.from, i.to, i.cohort_id ?? null, i.programme_id ?? null, i.sport ?? null, i.status ?? null, i.coach_id ?? null, own, user.id, i.limit, i.offset]);
    const out = [];
    for (const s of rows.filter((x) => own || a.scopeOk(x))) {
      const comp = await evaluateSession(pool, s);
      out.push({ ...s, compliance: { level: comp.level, checks: comp.checks.filter((x) => !x.severity || x.severity !== 'ok'), expected: comp.expected } });
    }
    return out;
  },
});

cap({
  name: 'get_academy_session', method: 'GET', path: '/academy/sessions/:id', tag: TAG,
  summary: 'One session: cohort and programme, staff and their responses, the held venue booking, staffing compliance with explanations, and the change history. Also runs the pre-publish conflict check.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { s, a } = await sessionFor(user, i.id, 'view');
    const v = await view(pool, s);
    const chk = await checkSession(pool, s);
    return { ...v, conflicts: chk.conflicts, publishable: chk.publishable, can_edit: a.hasBroad('schedule') && a.scopeOk(s) && !a.readOnly };
  },
});

// ------------------------------------------------------------------ change, publish, cancel
cap({
  name: 'update_academy_session', method: 'PATCH', path: '/academy/sessions/:id', tag: TAG,
  summary: 'Reschedule or edit a session. Needs the current row_version (a stale edit gets 409) and a reason when the time of a published session moves; history is kept and staff, athletes and guardians are notified. A held venue booking is never changed automatically: the response tells you to move it through the booking.',
  input: z.object({ id, row_version: z.number().int(), starts_at: dt.optional(), duration_min: z.number().int().min(10).max(600).optional(), title: z.string().trim().min(2).max(120).optional(), capacity: z.number().int().min(1).max(500).nullable().optional(), self_checkin: z.boolean().optional(), duty_roles: z.array(z.string().max(40)).max(6).optional(), reason: z.string().trim().min(3).max(300).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { s } = await sessionFor(user, i.id, 'schedule', { write: true, c });
    if (s.row_version !== i.row_version) throw conflict('This session was changed by someone else. Reload and try again.', { row_version: s.row_version });
    if (['cancelled', 'completed'].includes(s.status)) throw conflict(`A ${s.status} session cannot be edited`);
    const start = i.starts_at ?? s.starts_at.toISOString();
    const end = i.starts_at || i.duration_min ? new Date(Date.parse(start) + (i.duration_min ?? Math.round((s.ends_at - s.starts_at) / 60000)) * 60000) : s.ends_at;
    const moved = +new Date(start) !== +s.starts_at || +end !== +s.ends_at;
    if (moved && s.status === 'published' && !i.reason) throw badRequest('Say why the session is moving');
    if (moved) {
      await lockCohort(c, s.cohort_id);
      const iss = await cohortIssues(c, { ...s, starts_at: start, ends_at: end });
      if (iss.length) throw conflict('That time clashes', { conflicts: iss });
      for (const st of (await c.query("SELECT user_id FROM academy_session_staff WHERE session_id=$1 AND status IN ('assigned','confirmed')", [s.id])).rows) {
        await lockStaff(c, st.user_id);
        const si = await staffIssues(c, s.organisation_id, st.user_id, start, end, { excludeSessionId: s.id, tz: s.timezone });
        if (si.length) throw conflict('An assigned staff member would be unavailable at that time', { conflicts: si.map((x) => ({ ...x, user_id: st.user_id })) });
      }
    }
    const next = (await c.query(
      `UPDATE academy_sessions SET starts_at=$2, ends_at=$3, title=coalesce($4,title), capacity=CASE WHEN $5::boolean THEN $6 ELSE capacity END, self_checkin=coalesce($7,self_checkin), duty_roles=coalesce($8,duty_roles), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`,
      [s.id, start, end, i.title ?? null, i.capacity !== undefined, i.capacity ?? null, i.self_checkin ?? null, i.duty_roles ?? null])).rows[0];
    await change(c, s.id, moved ? 'rescheduled' : 'edited', user.id, i.reason, { starts_at: s.starts_at, ends_at: s.ends_at, title: s.title }, { starts_at: next.starts_at, ends_at: next.ends_at, title: next.title });
    if (moved && s.status === 'published') await tellSession(c, next, 'rescheduled', 'A session was rescheduled', 'Open Gotmygame to see the new time.');
    const venue = await heldVenue(c, s.id);
    return { ...(await view(c, next)), venue_needs_review: !!venue && moved, notice: venue && moved ? 'The venue booking was not changed. Move or re-book it from the booking so cancellation and change rules apply.' : undefined };
  }),
});

cap({
  name: 'publish_academy_sessions', method: 'POST', path: '/organisations/:id/academy/sessions/publish', tag: TAG,
  summary: 'Publish draft sessions after the conflict and staffing check. A clash with another session, the group, a fixture or the venue refuses the session; a staffing warning needs acknowledge_warnings; a blocked staffing rule (only when explicitly enforced) cannot be overridden. Each session gets its own result so one bad session never stops the rest. Published sessions appear in coach calendars and athlete schedules.',
  input: z.object({ id, session_ids: z.array(id).min(1).max(100), acknowledge_warnings: z.boolean().default(false) }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await opsAccess(user, i.id, { write: true, c });
    a.need('schedule');
    const results = [];
    for (const sid of [...new Set(i.session_ids)].sort()) {
      const s = (await c.query('SELECT * FROM academy_sessions WHERE id=$1 AND organisation_id=$2 FOR UPDATE', [sid, i.id])).rows[0];
      if (!s) { results.push({ session_id: sid, published: false, reason: 'not found' }); continue; }
      if (s.status === 'published') { results.push({ session_id: sid, published: true, already: true }); continue; }
      if (s.status !== 'draft') { results.push({ session_id: sid, published: false, reason: `a ${s.status} session cannot be published` }); continue; }
      const chk = await checkSession(c, s);
      if (chk.conflicts.length) { results.push({ session_id: sid, published: false, reason: 'conflicts', conflicts: chk.conflicts }); continue; }
      if (chk.compliance.level === 'blocked') { results.push({ session_id: sid, published: false, reason: 'staffing rule not met', compliance: chk.compliance }); continue; }
      if (chk.compliance.level === 'warning' && !i.acknowledge_warnings) { results.push({ session_id: sid, published: false, reason: 'staffing warnings need acknowledgement', compliance: chk.compliance }); continue; }
      const next = (await c.query("UPDATE academy_sessions SET status='published', row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *", [sid])).rows[0];
      await change(c, sid, 'published', user.id, chk.compliance.level === 'warning' ? 'published with acknowledged warnings' : null, null, { level: chk.compliance.level });
      await tellSession(c, next, 'published', 'A session was scheduled', 'Open Gotmygame to see the schedule.', { staff: true, athletes: true });
      results.push({ session_id: sid, published: true, compliance: chk.compliance.level });
    }
    return { results, published: results.filter((r) => r.published).length };
  }),
});

cap({
  name: 'cancel_academy_session', method: 'POST', path: '/academy/sessions/:id/cancel', tag: TAG,
  summary: 'Cancel a session with a reason. Attendance becomes "not held", staff, athletes and guardians are told, and the history is kept. A held venue booking is NOT cancelled here: paid venue commitments follow the booking cancellation rules, so the response links to the booking to cancel it. A make-up can then be created for it.',
  input: z.object({ id, reason: z.string().trim().min(3).max(300) }),
  handler: ({ user }, i) => tx(async (c) => {
    const { s } = await sessionFor(user, i.id, 'schedule', { write: true, c });
    if (s.status === 'cancelled') return view(c, s);
    if (s.status === 'completed') throw conflict('A completed session cannot be cancelled');
    const next = (await c.query("UPDATE academy_sessions SET status='cancelled', cancel_reason=$2, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *", [s.id, i.reason])).rows[0];
    await change(c, s.id, 'cancelled', user.id, i.reason, { status: s.status }, { status: 'cancelled' });
    await c.query(
      `INSERT INTO academy_attendance_log(session_id, user_id, from_status, to_status, source, actor_id, reason) SELECT session_id, user_id, status, 'not_held', 'system', $2, 'session cancelled' FROM academy_attendance WHERE session_id=$1 AND status <> 'not_held'`, [s.id, user.id]);
    await c.query("UPDATE academy_attendance SET status='not_held', row_version=row_version+1 WHERE session_id=$1", [s.id]);
    if (s.status === 'published') await tellSession(c, next, 'cancelled', 'A session was cancelled', 'Open Gotmygame to see what changed.');
    await c.query("UPDATE academy_session_staff SET status='removed', updated_at=now() WHERE session_id=$1 AND status IN ('assigned','confirmed')", [s.id]);
    return { ...(await view(c, next)), venue_booking_to_review: await heldVenue(c, s.id) };
  }),
});

// ------------------------------------------------------------------ staff on a session
cap({
  name: 'assign_academy_staff', method: 'POST', path: '/academy/sessions/:id/staff', tag: TAG, status: 201,
  summary: 'Assign a coach or staff member (role lead, assistant, or duty with a label such as first_aid). Takes a per-person lock and refuses a double booking, a hire or commitment clash, approved leave, or time outside standing availability. Re-assigning someone already on the session is idempotent. Pass replaces to swap out a coach in one step.',
  input: z.object({ id, user_id: id, role: z.enum(['lead', 'assistant', 'duty']).default('assistant'), duty_label: z.string().max(40).optional(), replaces: id.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { s } = await sessionFor(user, i.id, 'schedule', { write: true, c });
    if (['cancelled', 'completed'].includes(s.status)) throw conflict(`A ${s.status} session cannot be staffed`);
    const m = (await c.query("SELECT role FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [s.organisation_id, i.user_id])).rows[0];
    if (!m) throw badRequest('Only active members of the organisation can be assigned');
    const eng = (await c.query('SELECT state FROM org_staff_engagements WHERE organisation_id=$1 AND user_id=$2', [s.organisation_id, i.user_id])).rows[0];
    if (eng && eng.state !== 'active') throw conflict(`This person is ${eng.state} and cannot be assigned`);
    await lockStaff(c, i.user_id);
    const same = (await c.query("SELECT * FROM academy_session_staff WHERE session_id=$1 AND user_id=$2 AND status IN ('assigned','confirmed')", [s.id, i.user_id])).rows[0];
    if (same && same.role === i.role && !i.replaces) return view(c, s);
    const iss = await staffIssues(c, s.organisation_id, i.user_id, s.starts_at, s.ends_at, { excludeSessionId: s.id, tz: s.timezone });
    if (iss.length) throw conflict('This person cannot take that session', { conflicts: iss });
    if (i.replaces) {
      await c.query("UPDATE academy_session_staff SET status='removed', updated_at=now() WHERE session_id=$1 AND user_id=$2 AND status IN ('assigned','confirmed')", [s.id, i.replaces]);
      await c.query("UPDATE academy_cover_requests SET status='filled', cover_user_id=$3, decided_by=$4, decided_at=now() WHERE session_id=$1 AND requester_id=$2 AND status='open'", [s.id, i.replaces, i.user_id, user.id]);
    }
    if (same) await c.query("UPDATE academy_session_staff SET status='removed', updated_at=now() WHERE id=$1", [same.id]);
    if (i.role === 'lead') await c.query("UPDATE academy_session_staff SET status='removed', updated_at=now() WHERE session_id=$1 AND role='lead' AND status IN ('assigned','confirmed')", [s.id]);
    await c.query('INSERT INTO academy_session_staff(session_id, user_id, role, duty_label, assigned_by, replaced_for) VALUES ($1,$2,$3,$4,$5,$6)', [s.id, i.user_id, i.role, i.role === 'duty' ? (i.duty_label ?? 'duty') : null, user.id, i.replaces ?? null]);
    await change(c, s.id, i.replaces ? 'staff_replaced' : 'staff_assigned', user.id, null, i.replaces ? { user_id: i.replaces } : null, { user_id: i.user_id, role: i.role });
    await notify(c, i.user_id, { kind: 'academy_assignment', title: 'You were assigned to an academy session', body: 'Open Gotmygame to confirm.', data: { session_id: s.id, organisation_id: s.organisation_id }, dedupe_key: `academy-assign:${s.id}:${i.user_id}:${s.row_version}:${i.role}` });
    if (i.replaces) await notify(c, i.replaces, { kind: 'academy_assignment_removed', title: 'You were replaced on an academy session', body: 'Open Gotmygame for details.', data: { session_id: s.id }, dedupe_key: `academy-replaced:${s.id}:${i.replaces}:${s.row_version}` });
    return view(c, s);
  }),
});

cap({
  name: 'remove_academy_staff', method: 'DELETE', path: '/academy/sessions/:id/staff/:user_id', tag: TAG,
  summary: 'Take someone off a session (kept in the history). The session shows the staffing gap again.',
  input: z.object({ id, user_id: id, reason: z.string().max(200).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { s } = await sessionFor(user, i.id, 'schedule', { write: true, c });
    const r = await c.query("UPDATE academy_session_staff SET status='removed', updated_at=now() WHERE session_id=$1 AND user_id=$2 AND status IN ('assigned','confirmed') RETURNING role", [s.id, i.user_id]);
    if (!r.rowCount) throw notFound('Assignment');
    await change(c, s.id, 'staff_removed', user.id, i.reason, { user_id: i.user_id, role: r.rows[0].role }, null);
    await notify(c, i.user_id, { kind: 'academy_assignment_removed', title: 'You were removed from an academy session', body: 'Open Gotmygame for details.', data: { session_id: s.id } });
    return view(c, s);
  }),
});

cap({
  name: 'respond_academy_assignment', method: 'POST', path: '/academy/sessions/:id/staff/respond', tag: TAG,
  summary: 'Acknowledge (accept) or decline your own assignment. Declining opens a cover request automatically.',
  input: z.object({ id, accept: z.boolean(), reason: z.string().max(300).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = (await c.query('SELECT * FROM academy_sessions WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!s) throw notFound('Session');
    const r = await c.query(`UPDATE academy_session_staff SET status=$3, responded_at=now(), updated_at=now() WHERE session_id=$1 AND user_id=$2 AND status IN ('assigned','confirmed') RETURNING role`, [s.id, user.id, i.accept ? 'confirmed' : 'declined']);
    if (!r.rowCount) throw notFound('Assignment');
    await change(c, s.id, i.accept ? 'staff_confirmed' : 'staff_declined', user.id, i.reason, null, { user_id: user.id });
    if (!i.accept) {
      await c.query("INSERT INTO academy_cover_requests(session_id, requester_id, reason) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [s.id, user.id, i.reason ?? 'Declined the assignment']);
      const admins = (await c.query("SELECT user_id FROM organisation_members WHERE organisation_id=$1 AND role = ANY($2) AND status='active'", [s.organisation_id, ADMINS])).rows;
      for (const x of admins) await notify(c, x.user_id, { kind: 'academy_cover_needed', title: 'A session needs cover', body: 'Open Academy Operations to find a substitute.', data: { session_id: s.id, organisation_id: s.organisation_id }, dedupe_key: `academy-cover:${s.id}:${user.id}:${x.user_id}` });
    }
    return view(c, s);
  }),
});

cap({
  name: 'recommend_academy_staff', method: 'GET', path: '/academy/sessions/:id/recommendations', tag: TAG,
  summary: 'Ranked, explainable candidates for a session. Only deterministic facts: active member and engagement, no clash or leave, within standing availability, sport scope, required credential, and workload that week. A manager confirms; nothing is assigned or removed automatically.',
  input: z.object({ id, role: z.enum(['lead', 'assistant', 'duty']).default('assistant') }),
  async handler({ user }, i) {
    const { s } = await sessionFor(user, i.id, 'schedule');
    const cands = (await pool.query(
      `SELECT m.user_id, u.display_name, e.job_title, e.scope_sports, e.scope_cohort_ids, e.state,
              (SELECT coalesce(sum(extract(epoch FROM (x.ends_at - x.starts_at)) / 60), 0)::int FROM academy_session_staff st JOIN academy_sessions x ON x.id=st.session_id
                WHERE st.user_id=m.user_id AND st.status IN ('assigned','confirmed') AND x.status IN ('draft','published') AND x.starts_at >= date_trunc('week', $2::timestamptz) AND x.starts_at < date_trunc('week', $2::timestamptz) + interval '7 days') AS week_minutes
         FROM organisation_members m JOIN users u ON u.id=m.user_id LEFT JOIN org_staff_engagements e ON e.organisation_id=m.organisation_id AND e.user_id=m.user_id
        WHERE m.organisation_id=$1 AND m.status='active' AND m.role IN ('coach','admin','owner','staff') AND (e.state IS NULL OR e.state='active') AND NOT EXISTS (SELECT 1 FROM academy_session_staff st WHERE st.session_id=$3 AND st.user_id=m.user_id AND st.status IN ('assigned','confirmed'))`,
      [s.organisation_id, s.starts_at, s.id])).rows;
    const badges = await badgesFor('user', cands.map((x) => x.user_id));
    const out = [];
    for (const cd of cands) {
      const issues = await staffIssues(pool, s.organisation_id, cd.user_id, s.starts_at, s.ends_at, { excludeSessionId: s.id, tz: s.timezone });
      const why = [], against = [];
      let score = 100;
      if (issues.length) { against.push(...issues.map((x) => x.message)); score -= 1000; }
      if (cd.scope_sports?.length && s.sport && !cd.scope_sports.includes(s.sport)) { against.push(`Not scoped to ${s.sport}`); score -= 200; } else if (cd.scope_sports?.includes(s.sport)) { why.push(`Works in ${s.sport}`); score += 20; }
      if (cd.scope_cohort_ids?.length && !cd.scope_cohort_ids.includes(s.cohort_id)) { against.push('Not scoped to this group'); score -= 200; } else if (cd.scope_cohort_ids?.includes(s.cohort_id)) { why.push('Assigned to this group'); score += 30; }
      const cred = (badges.get(cd.user_id) ?? []).some((b) => b.type === 'coach' && new Date(b.expires_at) > new Date(s.starts_at));
      if (i.role === 'lead' && s.lead_credential_required) { if (cred) { why.push('Verified coach credential'); score += 40; } else { against.push('No verified coach credential on the day'); score -= 500; } } else if (cred) { why.push('Verified coach credential'); score += 10; }
      why.push(`${Math.round(cd.week_minutes / 60 * 10) / 10} h already scheduled that week`);
      score -= Math.round(cd.week_minutes / 30);
      out.push({ user_id: cd.user_id, display_name: cd.display_name, job_title: cd.job_title, eligible: !issues.length && !against.some((x) => /credential|scoped/.test(x)), score, reasons: why, concerns: against });
    }
    out.sort((x, y) => y.score - x.score || x.display_name.localeCompare(y.display_name) || x.user_id.localeCompare(y.user_id));
    return { session_id: s.id, role: i.role, candidates: out.slice(0, 20), note: 'Suggestions only. A manager confirms every assignment.' };
  },
});

// ------------------------------------------------------------------ venue (canonical booking engine)
cap({
  name: 'book_academy_session_venue', method: 'POST', path: '/academy/sessions/:id/venue', tag: TAG, status: 201,
  summary: 'Reserve a court / room / field for the session through the canonical reservation engine (opening hours, blocks, capacity, pricing and holds all apply; nothing paid or booked is ever overwritten) and link the booking to the session. The booking keeps its own price, currency and terms. Fails with the engine\'s reason if the slot is not available.',
  input: z.object({ id, resource_id: id, quantity: z.number().int().min(1).max(1000).default(1), players: z.number().int().min(1).max(1000).optional(), note: z.string().max(300).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { s } = await sessionFor(user, i.id, 'schedule', { write: true, c });
    if (['cancelled', 'completed'].includes(s.status)) throw conflict(`A ${s.status} session cannot book a venue`);
    if (await heldVenue(c, s.id)) throw conflict('This session already holds a venue booking. Release it first.');
    const made = await placeBasket(c, user, { items: [{ resource_id: i.resource_id, starts_at: s.starts_at.toISOString(), ends_at: s.ends_at.toISOString(), quantity: i.quantity, players: i.players, note: i.note }], note: `Academy session ${s.title}`.slice(0, 300) }, { collect: true });
    if (made.problems.length) throw conflict(made.problems[0].message, { problems: made.problems });
    await c.query('INSERT INTO session_venue_links(reservation_id, booking_id, session_type, session_id, linked_by) VALUES ($1,$2,$3,$4,$5)', [made.reservationId, made.lines[0].id, 'academy_session', s.id, user.id]);
    await change(c, s.id, 'venue_booked', user.id, null, null, { reservation_id: made.reservationId, booking_id: made.lines[0].id });
    const rv = await reservationView(c, made.reservationId);
    return { ...(await view(c, s)), reservation: { id: rv.id, code: rv.code, totals: rv.totals, awaiting_payment: rv.awaiting_payment } };
  }),
});

cap({
  name: 'release_academy_session_venue', method: 'DELETE', path: '/academy/sessions/:id/venue', tag: TAG,
  summary: 'Detach the venue from the session. The booking itself is untouched (cancel or change it through the booking so refund and change rules apply); the response returns it.',
  input: z.object({ id, reason: z.string().max(200).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { s } = await sessionFor(user, i.id, 'schedule', { write: true, c });
    const held = await heldVenue(c, s.id);
    if (!held) throw notFound('Venue booking');
    await c.query("UPDATE session_venue_links SET released_at=now(), release_reason=$2 WHERE id=$1", [held.link_id, i.reason ?? 'released from the academy session']);
    await change(c, s.id, 'venue_released', user.id, i.reason, { booking_id: held.booking_id }, null);
    return { ...(await view(c, s)), released_booking: held };
  }),
});
