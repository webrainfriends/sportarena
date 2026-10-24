// Academy OS 2/3 rules: scoped permissions, staff/venue conflicts, staffing compliance and compensation arithmetic.
// Sessions, staff and money are never copied: this module only reads the canonical records (users, organisation_members, cohorts,
// enrolments, venue bookings, coach hires/commitments, verification badges) and decides.
import { forbidden, notFound } from './errors.js';
import { pool } from './db.js';
import { orgFor } from './org-access.js';
import { badgesFor } from './verification.js';
import { commitmentBusy } from './coach-commitments.js';
import { toLocal } from './booking/time.js';

export const PERMS = ['schedule', 'attendance', 'roster', 'timesheets', 'payroll', 'safeguarding'];
export const ADMINS = ['owner', 'admin'];

/** Job-title templates: a starting permission set. Access is only ever the stored permissions, so templates never proliferate roles. */
export const TEMPLATES = {
  director: { title: 'Academy director', permissions: PERMS },
  administrator: { title: 'Academy administrator', permissions: ['schedule', 'attendance', 'roster', 'timesheets'] },
  head_coach: { title: 'Head coach / technical director', permissions: ['schedule', 'attendance', 'roster', 'timesheets'] },
  coach: { title: 'Coach', permissions: ['attendance', 'roster'] },
  assistant_coach: { title: 'Assistant coach', permissions: ['attendance'] },
  programme_lead: { title: 'Programme lead', permissions: ['schedule', 'attendance', 'roster'] },
  registrar: { title: 'Registrar / front desk', permissions: ['attendance', 'roster'] },
  operations: { title: 'Operations manager', permissions: ['schedule', 'attendance', 'roster', 'timesheets'] },
  payroll: { title: 'Finance / payroll', permissions: ['timesheets', 'payroll'] },
  safeguarding: { title: 'Safeguarding / youth coordinator', permissions: ['roster', 'safeguarding'] },
  medical_liaison: { title: 'Medical liaison (operational cover only, no clinical records)', permissions: ['roster'] },
  partnerships: { title: 'Sponsor / partnership manager', permissions: [] },
  communications: { title: 'Marketing / communications', permissions: [] },
  auditor: { title: 'Read-only auditor', permissions: ['schedule', 'attendance', 'roster', 'timesheets', 'payroll'] },
  custom: { title: 'Custom', permissions: [] },
};

/**
 * What the caller may do in an organisation's operations, read live on every call (revocation is immediate).
 * owner/admin: everything. coach: attendance + roster of their own cohorts/sessions. finance: timesheets + payroll.
 * Any member can additionally hold the permissions on their active engagement, limited to its sport/cohort scope.
 */
export async function opsAccess(user, orgId, { write = false, c } = {}) {
  const { org, role } = await orgFor(user, orgId, undefined, { write, c });
  const q = c ?? pool;
  const eng = (await q.query('SELECT * FROM org_staff_engagements WHERE organisation_id=$1 AND user_id=$2', [orgId, user.id])).rows[0] ?? null;
  const live = eng && eng.state === 'active' && (!eng.ends_on || new Date(eng.ends_on) >= new Date(new Date().toISOString().slice(0, 10)));
  const perms = new Set(), broad = new Set();      // broad = organisation-wide; the coach role alone only covers sessions the coach is part of
  const admin = ADMINS.includes(role);
  if (admin) PERMS.forEach((p) => { perms.add(p); broad.add(p); });
  else if (role === 'auditor') ['schedule', 'attendance', 'roster', 'timesheets', 'payroll'].forEach((p) => { perms.add(p); broad.add(p); });
  else if (!eng || live) {
    if (role === 'coach') ['attendance', 'roster'].forEach((p) => perms.add(p));
    if (role === 'finance') ['timesheets', 'payroll'].forEach((p) => { perms.add(p); broad.add(p); });
  }
  if (live) (eng.permissions ?? []).forEach((p) => { perms.add(p); broad.add(p); });
  const readOnly = role === 'auditor';
  if (write && readOnly) throw forbidden('Auditors have read-only access');
  const a = { org, role, eng: live ? eng : null, perms, broad, admin, readOnly, user };
  a.need = (p) => { if (!perms.has(p)) throw forbidden(`You do not have ${p} access to this academy`); return a; };
  a.has = (p) => perms.has(p);
  a.hasBroad = (p) => broad.has(p);
  /** Staff limited by an engagement scope see only matching sessions; owner/admin and role-based access are unscoped. */
  a.scopeOk = (s) => admin || role === 'auditor' || !live || ((!eng.scope_sports?.length || eng.scope_sports.includes(s.sport)) && (!eng.scope_cohort_ids?.length || eng.scope_cohort_ids.includes(s.cohort_id)));
  return a;
}

/** A session with its cohort: 404 for outsiders, scope-checked for scoped staff. */
export async function sessionFor(user, sessionId, perm, { write = false, c } = {}) {
  const q = c ?? pool;
  const s = (await q.query(`SELECT s.*, k.name AS cohort_name, k.coach_id AS cohort_coach_id FROM academy_sessions s JOIN org_cohorts k ON k.id=s.cohort_id WHERE s.id=$1${c && write ? ' FOR UPDATE OF s' : ''}`, [sessionId])).rows[0];
  if (!s) throw notFound('Session');
  const a = await opsAccess(user, s.organisation_id, { write, c });
  // a coach or assigned staff member may always act on a session they are part of (attendance), the rest needs the permission and scope
  const mine = (await q.query("SELECT 1 FROM academy_session_staff WHERE session_id=$1 AND user_id=$2 AND status IN ('assigned','confirmed')", [s.id, user.id])).rowCount > 0 || s.cohort_coach_id === user.id;
  if (!(mine && (perm === 'attendance' || perm === 'roster' || perm === 'view'))) {
    if (perm === 'view') { if (!a.broad.size && !mine) throw forbidden('You are not part of this session'); }
    else if (!a.hasBroad(perm)) throw forbidden(`You do not have ${perm} access to this session`);
    if (!mine && !a.scopeOk(s)) throw forbidden('This session is outside your scope');
  }
  return { s, a, mine };
}

const overlap = (aS, aE, bS, bE) => new Date(aS) < new Date(bE) && new Date(bS) < new Date(aE);

/** Why a person cannot take this slot: other sessions, hires, commitments, approved leave and standing availability. */
export async function staffIssues(c, orgId, userId, start, end, { excludeSessionId = null, tz = 'UTC' } = {}) {
  const out = [];
  const sess = (await c.query(
    `SELECT s.id, s.title, s.starts_at, s.ends_at FROM academy_session_staff st JOIN academy_sessions s ON s.id=st.session_id
      WHERE st.user_id=$1 AND st.status IN ('assigned','confirmed') AND s.status IN ('draft','published') AND s.id IS DISTINCT FROM $4 AND s.starts_at < $3 AND s.ends_at > $2`, [userId, start, end, excludeSessionId])).rows;
  for (const r of sess) out.push({ kind: 'session', code: 'staff_double_booked', message: `Already assigned to "${r.title}" at the same time`, source_type: 'academy_session', source_id: r.id });
  const shifts = (await c.query("SELECT id, title FROM academy_shifts WHERE user_id=$1 AND status IN ('assigned','confirmed') AND starts_at < $3 AND ends_at > $2", [userId, start, end])).rows;
  for (const r of shifts) out.push({ kind: 'shift', code: 'shift_clash', message: `Already on shift: "${r.title}"`, source_type: 'academy_shift', source_id: r.id });
  const hires = (await c.query("SELECT id FROM coach_hires WHERE coach_id=$1 AND status IN ('requested','confirmed') AND starts_at < $3 AND starts_at + duration_min * interval '1 minute' > $2", [userId, start, end])).rows;
  for (const r of hires) out.push({ kind: 'hire', code: 'coach_hire_clash', message: 'Has a coaching hire at that time', source_type: 'coach_hire', source_id: r.id });
  const busy = await commitmentBusy(userId, new Date(start), new Date(end));
  if (busy.length) out.push({ kind: 'commitment', code: 'coach_commitment_clash', message: 'Has a coaching commitment at that time' });
  const off = (await c.query(
    `SELECT id, on_date, coalesce(ends_on, on_date) AS ends_on FROM academy_staff_availability
      WHERE organisation_id=$1 AND user_id=$2 AND kind='time_off' AND status='approved' AND on_date <= $4::date AND coalesce(ends_on, on_date) >= $3::date`,
    [orgId, userId, toLocal(start, tz).date, toLocal(end, tz).date])).rows;
  for (const r of off) out.push({ kind: 'time_off', code: 'on_leave', message: 'Has approved time off on that day', source_type: 'academy_staff_availability', source_id: r.id });
  const av = (await c.query("SELECT * FROM academy_staff_availability WHERE organisation_id=$1 AND user_id=$2 AND kind IN ('weekly','exception') AND status='approved'", [orgId, userId])).rows;
  if (av.length) {
    const a = toLocal(start, tz), b = toLocal(end, tz);
    const day = a.date;
    const exc = av.filter((r) => r.kind === 'exception' && String(r.on_date?.toISOString?.().slice(0, 10) ?? r.on_date).slice(0, 10) === day);
    const rules = exc.length ? exc : av.filter((r) => r.kind === 'weekly' && r.weekday === a.weekday);
    const fits = rules.some((r) => a.minutes >= r.start_min && (b.date === day ? b.minutes : 1440) <= r.end_min);
    if (!fits) out.push({ kind: 'availability', code: 'outside_availability', message: 'Outside their standing availability for that day' });
  }
  return out;
}

/** Sessions and fixtures that overlap this session for the same cohort or team. */
export async function cohortIssues(c, s) {
  const out = [];
  const same = (await c.query("SELECT id, title FROM academy_sessions WHERE cohort_id=$1 AND status IN ('draft','published') AND id<>$2 AND starts_at < $4 AND ends_at > $3", [s.cohort_id, s.id ?? '00000000-0000-0000-0000-000000000000', s.starts_at, s.ends_at])).rows;
  for (const r of same) out.push({ kind: 'cohort', code: 'cohort_overlap', message: `This group already has "${r.title}" at that time`, source_type: 'academy_session', source_id: r.id });
  const fx = (await c.query(
    `SELECT f.id FROM fixtures f JOIN org_cohorts k ON k.id=$1 AND k.team_id IN (f.home_team_id, f.away_team_id)
      WHERE f.status IN ('scheduled','live') AND f.scheduled_at < $3 AND f.scheduled_at + interval '90 minutes' > $2`, [s.cohort_id, s.starts_at, s.ends_at])).rows;
  for (const r of fx) out.push({ kind: 'fixture', code: 'team_fixture_clash', message: "The group's team has a fixture at that time", source_type: 'fixture', source_id: r.id });
  return out;
}

/** The live held venue booking of a session, if any. */
export const heldVenue = async (c, sessionId) => (await c.query(
  `SELECT l.id AS link_id, l.reservation_id, b.id AS booking_id, b.status AS booking_status, b.starts_at, b.ends_at, r.name AS resource_name, v.id AS venue_id, v.name AS venue_name
     FROM session_venue_links l JOIN bookings b ON b.id=l.booking_id JOIN resources r ON r.id=b.resource_id JOIN venues v ON v.id=r.venue_id
    WHERE l.session_type='academy_session' AND l.session_id=$1 AND l.released_at IS NULL`, [sessionId])).rows[0] ?? null;

/** Expected headcount: the cohort's enrolled athletes plus guests, minus anyone already absent or excused. Derived live, never copied. */
export const expectedCount = async (c, s) => (await c.query(
  `SELECT count(*)::int AS n FROM (
     SELECT e.user_id FROM org_enrolments e WHERE e.cohort_id=$2 AND e.status='enrolled'
     UNION SELECT a.user_id FROM academy_attendance a WHERE a.session_id=$1 AND a.guest) r
    WHERE NOT EXISTS (SELECT 1 FROM academy_attendance a WHERE a.session_id=$1 AND a.user_id=r.user_id AND a.status IN ('absent','excused','not_held'))`, [s.id, s.cohort_id])).rows[0].n;

/**
 * Staffing compliance for a session: compliant | warning | blocked. Every non-ok check explains the missing requirement.
 * 'blocked' appears only when enforcement was explicitly configured; a configured rule is never a claim of legal compliance.
 */
export async function evaluateSession(c, s) {
  const staff = (await c.query(
    `SELECT st.user_id, st.role, st.status, st.duty_label, u.display_name FROM academy_session_staff st JOIN users u ON u.id=st.user_id
      WHERE st.session_id=$1 AND st.status IN ('assigned','confirmed') ORDER BY st.role, u.display_name, u.id`, [s.id])).rows;
  const coaches = staff.filter((x) => x.role === 'lead' || x.role === 'assistant');
  const lead = staff.find((x) => x.role === 'lead');
  const expected = await expectedCount(c, s);
  const checks = [];
  const add = (code, ok, message, severity = 'warning') => checks.push({ code, ok, message, severity: ok ? 'ok' : severity });
  const hard = s.enforce_staffing ? 'blocked' : 'warning';
  add('lead', !!lead, lead ? `Lead coach: ${lead.display_name}` : 'No lead coach is assigned', hard);
  add('min_coaches', coaches.length >= s.min_coaches, coaches.length >= s.min_coaches ? `${coaches.length} coach(es) assigned (minimum ${s.min_coaches})` : `${coaches.length} coach(es) assigned but at least ${s.min_coaches} are required`, hard);
  if (s.max_ratio) {
    const ok = expected === 0 || (coaches.length > 0 && expected / coaches.length <= s.max_ratio);
    add('ratio', ok, ok ? `Ratio ${expected}:${coaches.length || 0} is within 1:${s.max_ratio}` : `${expected} athletes with ${coaches.length} coach(es) exceeds the maximum ratio of ${s.max_ratio} athletes per coach; at least ${Math.ceil(expected / s.max_ratio)} coaches are needed`, hard);
  }
  if (s.capacity) add('capacity', expected <= s.capacity, expected <= s.capacity ? `${expected} of ${s.capacity} places expected` : `${expected} athletes are expected but the capacity is ${s.capacity}`);
  if (s.lead_credential_required && lead) {
    const badges = await badgesFor('user', [lead.user_id]);
    const ok = (badges.get(lead.user_id) ?? []).some((b) => b.type === 'coach' && new Date(b.expires_at) > new Date(s.starts_at));
    add('lead_credential', ok, ok ? 'Lead coach holds a verified coach credential valid on the day' : `${lead.display_name} has no verified coach credential valid on the session date`, hard);
  }
  for (const role of s.duty_roles ?? []) {
    const ok = staff.some((x) => x.role === 'duty' && x.duty_label === role) || staff.some((x) => x.duty_label === role);
    add(`duty_${role}`, ok, ok ? `${role} cover assigned` : `No staff member is assigned for ${role.replace(/_/g, ' ')} cover`);
  }
  const level = checks.some((x) => x.severity === 'blocked') ? 'blocked' : checks.some((x) => x.severity === 'warning') ? 'warning' : 'compliant';
  return { level, checks, expected, coaches: coaches.length, staff };
}

/** Full pre-publish check: staff conflicts for everyone assigned, cohort overlaps, venue state and compliance. */
export async function checkSession(c, s) {
  const staff = (await c.query("SELECT user_id FROM academy_session_staff WHERE session_id=$1 AND status IN ('assigned','confirmed')", [s.id])).rows;
  const conflicts = [...(await cohortIssues(c, s))];
  for (const st of staff) for (const i of await staffIssues(c, s.organisation_id, st.user_id, s.starts_at, s.ends_at, { excludeSessionId: s.id, tz: s.timezone })) conflicts.push({ ...i, user_id: st.user_id });
  const venue = await heldVenue(c, s.id);
  const compliance = await evaluateSession(c, s);
  if (venue && venue.booking_status !== 'confirmed') conflicts.push({ kind: 'venue', code: 'venue_booking_not_confirmed', message: 'The venue booking is no longer confirmed' });
  if (venue && (new Date(venue.starts_at) > new Date(s.starts_at) || new Date(venue.ends_at) < new Date(s.ends_at))) conflicts.push({ kind: 'venue', code: 'venue_window_mismatch', message: 'The venue booking does not cover the whole session' });
  return { conflicts, compliance, venue, publishable: compliance.level !== 'blocked' && conflicts.length === 0 };
}

// ------------------------------------------------------------------ compensation
/** The rule version in force on a date: the latest effective_from on or before it, most specific first. */
export async function ruleFor(c, orgId, userId, role, programmeId, onDate) {
  const { rows } = await c.query(
    `SELECT * FROM academy_comp_rules WHERE organisation_id=$1 AND user_id=$2 AND role IN ($3,'any') AND effective_from <= $5::date AND (programme_id IS NULL OR programme_id IS NOT DISTINCT FROM $4)
      ORDER BY (programme_id IS NOT NULL) DESC, (role <> 'any') DESC, effective_from DESC, created_at DESC LIMIT 1`, [orgId, userId, role, programmeId, onDate]);
  return rows[0] ?? null;
}

/** Amount (minor units) for one approved timesheet under one rule. Integer arithmetic only, rounded half up. */
export function priceTimesheet(rule, ts) {
  const worked = ts.minutes ?? 0;
  const scheduled = ts.scheduled_start && ts.scheduled_end ? Math.round((new Date(ts.scheduled_end) - new Date(ts.scheduled_start)) / 60000) : worked;
  if (rule.model === 'volunteer') return { amount: 0, basis: 'volunteer' };
  if (rule.model === 'per_session') return { amount: Number(rule.rate_minor), basis: 'per session' };
  if (rule.model === 'programme_fixed') return { amount: 0, basis: 'fixed programme amount is added once per run', fixed: Number(rule.rate_minor) };
  if (rule.model === 'day_rate') return { amount: 0, basis: 'day rate', day: true };
  const normal = Math.min(worked, Math.max(scheduled, 0) || worked), extra = Math.max(0, worked - normal);
  const base = Math.floor((normal * Number(rule.rate_minor) * 2 + 60) / 120);
  const over = Math.floor((extra * Number(rule.rate_minor) * rule.overtime_bp * 2 + 60 * 10000) / (120 * 10000));
  return { amount: base + over, basis: extra ? `${normal} min + ${extra} min overtime` : `${normal} min` };
}
