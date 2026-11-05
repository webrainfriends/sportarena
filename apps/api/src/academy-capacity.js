// Academy OS P2 (#805): capacity, progression and workforce scenarios. A read-only what-if over the academy's real records:
// sessions, approved payroll, confirmed venue bookings, pathway decisions and consented School timetable blocks.
// It NEVER writes to a roster, booking, enrolment, cost, session, staffing or published curriculum. Anything it cannot know is reported as
// missing, and an impossible scenario returns reasons and no projection, never a precise-looking number.
import { createHash } from 'node:crypto';
import { pool } from './db.js';
import { payrollCost, venueCost } from './academy-cost-sources.js';
import { staffIssues } from './academy-ops.js';
import { academicClashes } from './academics.js';
import { addDays, fromLocal, hhmm, validTimezone, weekdayOf } from './booking/time.js';

export const MAX_OCCURRENCES = 80;
const day = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);
const round1 = (x) => Math.round(x * 10) / 10;
const stable = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

/** Documented formulas, shown next to every figure so a head coach or performance director can check the maths. */
export const FORMULAS = {
  demand: 'projected athletes in a programme = enrolled now + enrolment-mix change + athletes promoted in - athletes promoted out',
  congestion: 'congestion % = projected athletes / programme capacity (null when the programme has no capacity set)',
  required_coaches: 'required coaches = max(1, ceil(cohort athletes / athletes-per-coach ratio)); the ratio is the stricter of your override and the configured group ratio',
  coach_hours: 'weekly coach hours = sessions per week x session length in hours x required coaches',
  coach_load: 'coach load % = (current assigned hours per week + proposed hours per week) / recorded weekly availability hours',
  staff_cost: 'staff cost per coach-hour = approved payroll for timesheeted work in the last 90 days / timesheeted hours in the same period',
  venue_cost: 'venue cost per session = mean confirmed priced booking per academy session in the last 90 days (venue-specific when it has any, else the academy mean)',
  bottleneck: 'pathway bottleneck = projected athletes at a level exceed that level\'s seats (sum of capacities of the programmes the level points at); seats not defined = not assessed',
  conflicts: 'venue: every confirmed booking that overlaps an occurrence uses the resource; staff: the same checks used to publish a session; school: consented timetable blocks that overlap',
};

// ------------------------------------------------------------------ baseline (sourced, read-only)
export async function capacityBaseline(orgId, c = pool) {
  const q = async (sql, p) => (await c.query(sql, p)).rows;
  const profile = (await q('SELECT timezone, currency FROM academy_profiles WHERE organisation_id=$1', [orgId]))[0] ?? {};
  const programmes = await q(
    `SELECT p.id, p.title, p.sport, p.capacity, p.session_minutes, p.venue_ids,
            (SELECT count(*)::int FROM org_enrolments e WHERE e.programme_id=p.id AND e.status IN ('enrolled','paused')) AS enrolled
       FROM academy_programmes p WHERE p.organisation_id=$1 AND p.status='published' ORDER BY p.title, p.id`, [orgId]);
  const pipe = await q("SELECT programme_id, stage, count(*)::int AS n FROM academy_applications WHERE organisation_id=$1 AND stage IN ('waitlisted','offered','under_review','submitted') GROUP BY 1,2", [orgId]);
  for (const p of programmes) { const mine = pipe.filter((x) => x.programme_id === p.id); p.waitlisted = mine.find((x) => x.stage === 'waitlisted')?.n ?? 0; p.offers_open = mine.find((x) => x.stage === 'offered')?.n ?? 0; p.in_review = mine.filter((x) => ['under_review', 'submitted'].includes(x.stage)).reduce((n, x) => n + x.n, 0); }
  const seasons = await q("SELECT id, name, starts_on::text AS starts_on, ends_on::text AS ends_on FROM org_seasons WHERE organisation_id=$1 AND status='active' ORDER BY starts_on, id", [orgId]);
  const cohorts = await q(
    `SELECT k.id, k.name, k.max_ratio, k.min_coaches, (SELECT count(*)::int FROM org_enrolments e WHERE e.cohort_id=k.id AND e.status IN ('enrolled','paused')) AS enrolled
       FROM org_cohorts k WHERE k.organisation_id=$1 AND k.status='active' ORDER BY k.name, k.id`, [orgId]);
  const coaches = await q(
    `SELECT m.user_id AS id, u.display_name AS name,
            coalesce((SELECT sum(a.end_min - a.start_min) FROM academy_staff_availability a WHERE a.organisation_id=$1 AND a.user_id=m.user_id AND a.kind='weekly' AND a.status='approved'),0)::int AS available_min_week,
            coalesce((SELECT sum(extract(epoch FROM s.ends_at - s.starts_at)/60) FROM academy_session_staff st JOIN academy_sessions s ON s.id=st.session_id
                       WHERE st.user_id=m.user_id AND st.status IN ('assigned','confirmed') AND s.organisation_id=$1 AND s.status IN ('draft','published') AND s.starts_at >= now() AND s.starts_at < now() + interval '28 days'),0)::int AS assigned_min_28d
       FROM organisation_members m JOIN users u ON u.id=m.user_id WHERE m.organisation_id=$1 AND m.status='active' AND m.role='coach' ORDER BY u.display_name, m.user_id`, [orgId]);
  const venues = await q(
    `SELECT v.id, v.name, v.city, (SELECT count(*)::int FROM resources r WHERE r.venue_id=v.id AND r.active) AS resources,
            (SELECT coalesce(array_agg(DISTINCT sp.name), '{}') FROM resources r JOIN sports sp ON sp.id=r.sport_id WHERE r.venue_id=v.id AND r.active) AS sports,
            (SELECT coalesce(array_agg(h), '{0,0,0,0,0,0,0}') FROM (SELECT round(coalesce(sum(extract(epoch FROM b.ends_at - b.starts_at)/3600) FILTER (WHERE extract(dow FROM b.starts_at)=d),0)/4, 1)::float AS h
               FROM generate_series(0,6) d LEFT JOIN (SELECT b.* FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE r.venue_id=v.id AND b.status='confirmed' AND b.starts_at >= now() AND b.starts_at < now() + interval '28 days') b ON true GROUP BY d ORDER BY d) w) AS booked_hours_by_weekday
       FROM venues v WHERE v.organisation_id=$1 OR v.id IN (SELECT unnest(venue_ids) FROM academy_programmes WHERE organisation_id=$1) ORDER BY v.name, v.id`, [orgId]);

  // pathways: athletes per level from the latest human decision, seats from the programmes each level points at
  const pathways = [];
  for (const p of await q("SELECT p.id, p.title, p.sport, v.levels FROM academy_pathways p JOIN academy_pathway_versions v ON v.pathway_id=p.id AND v.version=p.current_version WHERE p.organisation_id=$1 AND p.status='active' ORDER BY p.title, p.id", [orgId])) {
    const now = await q(
      `SELECT coalesce(to_level, from_level) AS level, count(*)::int AS n FROM (SELECT DISTINCT ON (athlete_id) * FROM academy_progression_decisions WHERE pathway_id=$1 ORDER BY athlete_id, created_at DESC, id DESC) d
        WHERE decision NOT IN ('graduate','pause') GROUP BY 1`, [p.id]);
    const by = new Map(now.map((r) => [r.level, r.n]));
    const levels = [...p.levels].sort((a, b) => a.position - b.position).map((l) => {
      const progs = programmes.filter((x) => (l.programme_ids ?? []).includes(x.id));
      const seats = progs.length && progs.every((x) => x.capacity != null) ? progs.reduce((s, x) => s + x.capacity, 0) : null;
      return { key: l.key, title: l.title, position: l.position, athletes: by.get(l.key) ?? 0, seats, programme_ids: l.programme_ids ?? [] };
    });
    pathways.push({ id: p.id, title: p.title, sport: p.sport, levels });
  }

  // cost per coach-hour and per venue session from the last 90 days of approved payroll and confirmed venue bookings
  const from = day(90), to = today();
  const [pay, ven] = await Promise.all([payrollCost(orgId, from, to), venueCost(orgId, from, to)]);
  const mins = await q(
    `SELECT r.currency, sum(t.minutes)::bigint AS minutes FROM academy_payroll_lines l JOIN academy_payroll_runs r ON r.id=l.run_id AND r.status='approved', jsonb_array_elements(l.detail) d
       JOIN academy_timesheets t ON t.id=(d->>'timesheet_id')::uuid WHERE r.organisation_id=$1 AND d ? 'timesheet_id' AND t.work_date BETWEEN $2 AND $3 GROUP BY 1`, [orgId, from, to]);
  const staff = mins.filter((m) => Number(m.minutes) > 0).map((m) => {
    const amount = pay.rows.filter((x) => x.currency === m.currency && !x.adjustment).reduce((s, x) => s + x.amount_minor, 0);
    return { currency: m.currency, per_hour_minor: Math.round((amount * 60) / Number(m.minutes)), hours: round1(Number(m.minutes) / 60) };
  }).sort((a, b) => b.hours - a.hours)[0] ?? null;
  const currency = staff?.currency ?? profile.currency ?? null;
  const venueRows = ven.rows.filter((r) => r.currency === currency);
  const mean = (rows) => (rows.length ? Math.round(rows.reduce((s, r) => s + r.amount_minor, 0) / rows.length) : null);
  const venue_cost = { currency, academy_mean_per_session_minor: mean(venueRows), by_venue: Object.fromEntries([...new Set(venueRows.map((r) => r.venue_id))].map((id) => [id, mean(venueRows.filter((r) => r.venue_id === id))])), sessions_priced: venueRows.length, unbooked_sessions: ven.unbooked_sessions };

  return {
    taken_at: new Date().toISOString(), timezone: profile.timezone ?? null, currency, seasons,
    programmes, cohorts, coaches: coaches.map((x) => ({ ...x, assigned_hours_week: round1(x.assigned_min_28d / 60 / 4), available_hours_week: round1(x.available_min_week / 60) })), venues, pathways,
    staff_cost: staff, venue_cost,
    sources: [
      { key: 'programmes', label: 'Published programmes and live enrolments', from: 'academy_programmes, org_enrolments' },
      { key: 'sessions', label: 'Coach hours already assigned in the next 28 days', from: 'academy_sessions, academy_session_staff' },
      { key: 'availability', label: 'Standing weekly availability', from: 'academy_staff_availability (approved)' },
      { key: 'payroll', label: 'Cost per coach-hour, last 90 days', from: 'approved payroll runs and timesheets' },
      { key: 'venue', label: 'Venue cost per session, last 90 days', from: 'confirmed venue bookings linked to sessions' },
      { key: 'pathway', label: 'Athletes per level', from: 'latest human progression decision per athlete' },
      { key: 'school', label: 'School timetable blocks', from: 'academic_items, only where the athlete has a live timetable consent' },
    ],
  };
}

export const baselineHash = (b) => createHash('sha256').update(stable({ ...b, taken_at: undefined })).digest('hex');

// ------------------------------------------------------------------ validation: impossible inputs are reported, never forecast
export function validateInputs(a, base) {
  const reasons = [];
  const prog = new Map(base.programmes.map((p) => [p.id, p]));
  const path = new Map(base.pathways.map((p) => [p.id, p]));
  if (a.horizon.to < a.horizon.from) reasons.push({ code: 'horizon_reversed', message: 'The horizon ends before it starts' });
  if (addDays(a.horizon.from, 366) < a.horizon.to) reasons.push({ code: 'horizon_too_long', message: 'The horizon is longer than 12 months; choose a shorter range' });
  for (const m of a.enrolment_mix) {
    const p = prog.get(m.programme_id);
    if (!p) { reasons.push({ code: 'programme_unknown', message: 'A programme in the enrolment mix is not one of your published programmes', ref: m.programme_id }); continue; }
    if (p.enrolled + m.change < 0) reasons.push({ code: 'below_zero', message: `${p.title}: removing ${-m.change} athletes leaves fewer than none (${p.enrolled} enrolled)`, ref: p.id });
  }
  for (const m of a.promotions) {
    const pw = path.get(m.pathway_id), lv = pw?.levels.find((l) => l.key === m.from_level), idx = pw ? pw.levels.indexOf(lv) : -1;
    if (!pw || !lv) { reasons.push({ code: 'level_unknown', message: 'A promotion points at a pathway level that does not exist in the active version', ref: m.pathway_id }); continue; }
    if (idx === pw.levels.length - 1) reasons.push({ code: 'no_next_level', message: `${pw.title}: ${lv.title} is the last level, so there is no next stage to promote into`, ref: m.pathway_id });
    if (m.athletes > lv.athletes) reasons.push({ code: 'more_than_present', message: `${pw.title}: ${m.athletes} promotions from ${lv.title} but only ${lv.athletes} athletes are recorded there`, ref: m.pathway_id });
  }
  const coachIds = new Set(base.coaches.map((x) => x.id)), venueIds = new Set(base.venues.map((v) => v.id));
  a.cohorts.forEach((k, n) => {
    const where = `Cohort ${n + 1} (${k.name})`;
    if (Number.isNaN(hhmm(k.start_time)) || Number.isNaN(hhmm(k.end_time))) reasons.push({ code: 'bad_time', message: `${where}: use a valid start and end time` });
    else if (hhmm(k.end_time) <= hhmm(k.start_time)) reasons.push({ code: 'ends_before_start', message: `${where}: ends at or before it starts` });
    if (!prog.has(k.programme_id)) reasons.push({ code: 'programme_unknown', message: `${where}: the programme is not one of your published programmes` });
    if (k.venue_id && !venueIds.has(k.venue_id)) reasons.push({ code: 'venue_unknown', message: `${where}: the venue is not linked to this academy` });
    for (const id of k.coach_ids) if (!coachIds.has(id)) reasons.push({ code: 'coach_not_staff', message: `${where}: a chosen coach is not an active coach of this academy` });
    if (k.timezone && !validTimezone(k.timezone)) reasons.push({ code: 'bad_timezone', message: `${where}: unknown time zone` });
  });
  return reasons;
}

// ------------------------------------------------------------------ the slot checks for one proposed cohort
/** Dates in the horizon on which a cohort would meet. */
export function occurrences(k, horizon) {
  const out = [];
  for (let d = horizon.from; d <= horizon.to && out.length < MAX_OCCURRENCES + 1; d = addDays(d, 1)) if (k.weekdays.includes(weekdayOf(d))) out.push(d);
  return { dates: out.slice(0, MAX_OCCURRENCES), truncated: out.length > MAX_OCCURRENCES };
}

async function checkCohort(c, orgId, k, base, a) {
  const tz = k.timezone ?? base.timezone ?? 'UTC';
  const { dates, truncated } = occurrences(k, a.horizon);
  const s = hhmm(k.start_time), e = hhmm(k.end_time), venueConflicts = [], staffConflicts = [], schoolClashes = [];
  const venue = k.venue_id ? base.venues.find((v) => v.id === k.venue_id) : null;
  for (const date of dates) {
    const start = fromLocal(date, s, tz), end = fromLocal(date, e, tz);
    if (venue) {
      // free when at least one active resource still has a unit left across the slot
      const free = (await c.query(
        `SELECT r.id FROM resources r WHERE r.venue_id=$1 AND r.active
            AND r.capacity > coalesce((SELECT sum(b.quantity) FROM bookings b WHERE b.resource_id=r.id AND b.status='confirmed' AND b.starts_at < $3 AND b.ends_at > $2),0) LIMIT 1`, [venue.id, start, end])).rows[0];
      if (!free) {
        const who = (await c.query("SELECT b.id FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE r.venue_id=$1 AND b.status='confirmed' AND b.starts_at < $3 AND b.ends_at > $2 LIMIT 3", [venue.id, start, end])).rows;
        venueConflicts.push({ date, code: venue.resources ? 'venue_fully_booked' : 'venue_has_no_resources', message: venue.resources ? `${venue.name} has no free court or room on ${date}` : `${venue.name} has no bookable resources`, source_type: 'booking', source_ids: who.map((x) => x.id) });
      }
    }
    for (const id of k.coach_ids) {
      for (const issue of await staffIssues(c, orgId, id, start, end, { tz })) staffConflicts.push({ date, user_id: id, code: issue.code, message: issue.message, source_type: issue.source_type ?? null, source_id: issue.source_id ?? null });
    }
    if (k.source_cohort_id) {
      for (const x of await academicClashes(c, { cohort_id: k.source_cohort_id, organisation_id: orgId, starts_at: start, ends_at: end })) schoolClashes.push({ date, code: x.code, message: 'A consented School timetable block overlaps', source_type: x.source_type, source_id: x.source_id });
    }
  }
  return { dates, truncated, venue_conflicts: venueConflicts, staff_conflicts: staffConflicts, school_clashes: schoolClashes, tz };
}

// ------------------------------------------------------------------ the scenario
/** Run one scenario against a baseline. Read-only: the only writes anywhere are made by the capability that stores the snapshot. */
export async function evaluateCapacity(orgId, a, c = pool, baseline = null) {
  const base = baseline ?? await capacityBaseline(orgId, c);
  const reasons = validateInputs(a, base);
  const hash = baselineHash(base);
  if (reasons.length) return { outcome: 'impossible', baseline: base, baseline_hash: hash, result: { outcome: 'impossible', reasons, missing: [], projection: null, note: 'No forecast is shown for an impossible scenario. Fix the listed inputs.', formulas: FORMULAS } };

  const prog = new Map(base.programmes.map((p) => [p.id, { ...p, delta: 0, in: 0, out: 0 }]));
  for (const m of a.enrolment_mix) prog.get(m.programme_id).delta += m.change;

  // promotions move athletes from a level to the next level of the same pathway
  const levels = base.pathways.map((p) => ({ ...p, levels: p.levels.map((l) => ({ ...l, in: 0, out: 0 })) }));
  for (const m of a.promotions) {
    const pw = levels.find((p) => p.id === m.pathway_id), i = pw.levels.findIndex((l) => l.key === m.from_level);
    pw.levels[i].out += m.athletes; pw.levels[i + 1].in += m.athletes;
  }
  for (const pw of levels) for (const l of pw.levels) {
    l.projected = l.athletes - l.out + l.in;
    l.bottleneck = l.seats == null ? null : l.projected > l.seats;
    l.over_by = l.seats == null ? null : Math.max(0, l.projected - l.seats);
    // seats only move programme demand when the level maps to exactly one programme: otherwise the split is a human decision
    const only = l.programme_ids.length === 1 ? prog.get(l.programme_ids[0]) : null;
    if (only) { only.in += l.in; only.out += l.out; }
  }

  const missing = [];
  const demand = [...prog.values()].map((p) => {
    const projected = p.enrolled + p.delta + p.in - p.out;
    return { programme_id: p.id, title: p.title, enrolled: p.enrolled, change: p.delta, promoted_in: p.in, promoted_out: p.out, projected, capacity: p.capacity, congestion_pct: p.capacity ? round1((projected / p.capacity) * 100) : null, over_capacity_by: p.capacity ? Math.max(0, projected - p.capacity) : null };
  });
  if (demand.some((d) => d.capacity == null && (d.change || d.promoted_in || d.promoted_out))) missing.push({ code: 'programme_capacity', message: 'Some changed programmes have no capacity set, so their congestion is not assessed' });

  const cohorts = [];
  for (const k of a.cohorts) {
    const p = prog.get(k.programme_id), chk = await checkCohort(c, orgId, k, base, a);
    const minutes = hhmm(k.end_time) - hhmm(k.start_time), perWeek = k.weekdays.length;
    const configured = base.cohorts.map((x) => x.max_ratio).filter(Boolean);
    const ratio = [k.max_ratio, ...configured.length ? [Math.min(...configured)] : []].filter(Boolean).sort((x, y) => x - y)[0] ?? null;
    const required = ratio ? Math.max(1, Math.ceil(k.athletes / ratio)) : null;
    const hoursWeek = required ? round1((perWeek * minutes * required) / 60) : null;
    const coaches = k.coach_ids.map((id) => {
      const co = base.coaches.find((x) => x.id === id), added = round1((perWeek * minutes) / 60);
      const load = co.available_hours_week > 0 ? round1(((co.assigned_hours_week + added) / co.available_hours_week) * 100) : null;
      return { user_id: id, name: co.name, assigned_hours_week: co.assigned_hours_week, proposed_hours_week: added, available_hours_week: co.available_hours_week, load_pct: load, overloaded: load != null && load > 100, availability_recorded: co.available_hours_week > 0 };
    });
    const venueCost = k.venue_id ? (base.venue_cost.by_venue[k.venue_id] ?? base.venue_cost.academy_mean_per_session_minor) : null;
    const sessions = chk.dates.length, perHour = base.staff_cost?.per_hour_minor ?? null;
    const staffCost = perHour != null && required ? Math.round(perHour * (minutes / 60) * required * sessions) : null;
    const venueTotal = venueCost != null ? venueCost * sessions : null;
    const notes = [];
    if (!ratio) notes.push({ code: 'ratio', message: 'No athletes-per-coach ratio is configured or entered, so coaches needed are not assessed' });
    if (k.coach_ids.length === 0) notes.push({ code: 'coaches_unchosen', message: 'No coach chosen, so coach conflicts and load are not assessed' });
    if (coaches.some((x) => !x.availability_recorded)) notes.push({ code: 'availability', message: 'A chosen coach has no standing availability recorded, so their load is not assessed' });
    if (!k.venue_id) notes.push({ code: 'venue_unchosen', message: 'No venue chosen, so venue conflicts and cost are not assessed' });
    if (!k.source_cohort_id) notes.push({ code: 'school_not_assessed', message: 'No source cohort chosen, so School timetable blocks are not assessed' });
    if (perHour == null) notes.push({ code: 'staff_cost', message: 'No approved payroll with timesheeted hours in the last 90 days, so staff cost is not assessed' });
    if (k.venue_id && venueCost == null) notes.push({ code: 'venue_cost', message: 'No priced venue booking in the last 90 days, so venue cost is not assessed' });
    if (chk.truncated) notes.push({ code: 'truncated', message: `Only the first ${MAX_OCCURRENCES} meetings were checked` });
    cohorts.push({
      name: k.name, programme_id: p.id, programme: p.title, athletes: k.athletes, weekdays: k.weekdays, start_time: k.start_time, end_time: k.end_time, timezone: chk.tz, sessions_in_horizon: sessions,
      ratio, coaches_required: required, coaches_chosen: k.coach_ids.length, coach_gap: required == null || !k.coach_ids.length ? null : Math.max(0, required - k.coach_ids.length), coach_hours_week: hoursWeek,
      coaches, venue: k.venue_id ? { id: k.venue_id, name: base.venues.find((v) => v.id === k.venue_id)?.name } : null,
      conflicts: { venue: chk.venue_conflicts, staff: chk.staff_conflicts, school: chk.school_clashes },
      cost: { currency: base.currency, staff_minor: staffCost, venue_minor: venueTotal, total_minor: staffCost != null && (venueTotal != null || !k.venue_id) ? staffCost + (venueTotal ?? 0) : null },
      notes,
    });
  }
  for (const k of cohorts) for (const n of k.notes) if (!missing.some((m) => m.code === n.code && m.cohort === k.name)) missing.push({ ...n, cohort: k.name });

  const extraCoaches = a.extra_coaches;
  const totalRequired = cohorts.reduce((s, k) => s + (k.coaches_required ?? 0), 0);
  const chosen = new Set(cohorts.flatMap((k) => k.coaches.map((x) => x.user_id))).size;
  const workforce = { coaches_required: cohorts.some((k) => k.coaches_required == null) ? null : totalRequired, coaches_chosen: chosen, extra_coaches_assumed: extraCoaches, coach_hours_week: cohorts.some((k) => k.coach_hours_week == null) ? null : round1(cohorts.reduce((s, k) => s + k.coach_hours_week, 0)),
    overloaded_coaches: cohorts.flatMap((k) => k.coaches.filter((x) => x.overloaded)).length };
  const weeks = Math.max(1, Math.ceil((Date.parse(`${a.horizon.to}T00:00:00Z`) - Date.parse(`${a.horizon.from}T00:00:00Z`)) / 864e5 / 7));
  const hirePerHour = base.staff_cost?.per_hour_minor ?? null;
  const hireCost = !extraCoaches || !a.extra_coach_hours_week ? 0 : hirePerHour == null ? null : Math.round(hirePerHour * a.extra_coach_hours_week * extraCoaches * weeks);
  if (hireCost == null) missing.push({ code: 'hire_cost', message: 'Extra coaches are assumed but no approved payroll gives a cost per coach-hour, so their cost is not assessed' });
  const cohortCost = cohorts.length && cohorts.every((k) => k.cost.total_minor != null) ? cohorts.reduce((s, k) => s + k.cost.total_minor, 0) : cohorts.length ? null : 0;
  const costTotals = cohortCost == null || hireCost == null ? null : cohortCost + hireCost;
  const budget = a.budget_minor == null ? null : { budget_minor: a.budget_minor, within: costTotals == null ? null : costTotals <= a.budget_minor, headroom_minor: costTotals == null ? null : a.budget_minor - costTotals };
  const conflictCount = cohorts.reduce((s, k) => s + k.conflicts.venue.length + k.conflicts.staff.length + k.conflicts.school.length, 0);

  // recommendation candidates: explainable rules over the figures above, each needing a person's decision. Nothing selects or excludes an athlete.
  const candidates = [];
  for (const d of demand) if (d.over_capacity_by > 0) candidates.push({ key: `capacity:${d.programme_id}`, kind: 'add_capacity', title: `Create room for ${d.over_capacity_by} more athletes in ${d.title}`, why: `Projected ${d.projected} athletes against a capacity of ${d.capacity} (${d.congestion_pct}%).`, rule: FORMULAS.congestion, owner_screen: 'Programmes', evidence: { programme_id: d.programme_id } });
  for (const pw of levels) for (const l of pw.levels) if (l.bottleneck) candidates.push({ key: `bottleneck:${pw.id}:${l.key}`, kind: 'relieve_bottleneck', title: `${pw.title}: ${l.title} needs ${l.over_by} more seats`, why: `Projected ${l.projected} athletes against ${l.seats} seats after the assumed promotions.`, rule: FORMULAS.bottleneck, owner_screen: 'Progress', evidence: { pathway_id: pw.id, level: l.key } });
  for (const k of cohorts) {
    if (k.coach_gap > 0) candidates.push({ key: `coach_gap:${k.name}`, kind: 'staff_cohort', title: `${k.name}: needs ${k.coach_gap} more coach${k.coach_gap > 1 ? 'es' : ''}`, why: `${k.coaches_required} required at 1:${k.ratio}, ${k.coaches_chosen} chosen.`, rule: FORMULAS.required_coaches, owner_screen: 'Staff', evidence: { cohort: k.name } });
    for (const x of k.coaches.filter((y) => y.overloaded)) candidates.push({ key: `overload:${k.name}:${x.user_id}`, kind: 'rebalance_load', title: `${x.name} would be at ${x.load_pct}% of their availability`, why: `${x.assigned_hours_week} h already assigned plus ${x.proposed_hours_week} h proposed against ${x.available_hours_week} h available.`, rule: FORMULAS.coach_load, owner_screen: 'Staff', evidence: { user_id: x.user_id } });
    if (k.conflicts.venue.length) candidates.push({ key: `venue:${k.name}`, kind: 'change_slot', title: `${k.name}: ${k.conflicts.venue.length} meeting${k.conflicts.venue.length > 1 ? 's' : ''} cannot get a venue`, why: k.conflicts.venue[0].message + (k.conflicts.venue.length > 1 ? ` and ${k.conflicts.venue.length - 1} more` : ''), rule: FORMULAS.conflicts, owner_screen: 'Operations', evidence: { cohort: k.name } });
    if (k.conflicts.school.length) candidates.push({ key: `school:${k.name}`, kind: 'change_slot', title: `${k.name}: ${k.conflicts.school.length} overlap${k.conflicts.school.length > 1 ? 's' : ''} with School timetable blocks`, why: 'Counted from consented blocks only; no subject or athlete is shown here.', rule: FORMULAS.conflicts, owner_screen: 'Academics', evidence: { cohort: k.name } });
  }
  if (budget?.within === false) candidates.push({ key: 'budget', kind: 'over_budget', title: `Over budget by ${-budget.headroom_minor / 100}`, why: 'Projected staff, venue and extra-hire cost exceed the ceiling you set.', rule: 'cost = staff + venue + extra coach hires; compared with your budget ceiling', owner_screen: 'Finance', evidence: {} });
  const outcome = missing.length ? 'incomplete' : 'complete';
  return {
    outcome, baseline: base, baseline_hash: hash,
    result: {
      outcome, reasons: [], missing,
      projection: { demand, pathways: levels.map((p) => ({ id: p.id, title: p.title, levels: p.levels.map((l) => ({ key: l.key, title: l.title, athletes: l.athletes, promoted_out: l.out, promoted_in: l.in, projected: l.projected, seats: l.seats, bottleneck: l.bottleneck, over_by: l.over_by })) })), cohorts, workforce,
        totals: { conflicts: conflictCount, cost_currency: base.currency, cost_minor: costTotals, cost_complete: costTotals != null, hire_cost_minor: hireCost, cohort_cost_minor: cohortCost, weeks, budget } },
      candidates, approval_required: true,
      note: 'A what-if over your own records. It changes no roster, booking, enrolment, cost or curriculum, and it does not select or exclude any young athlete. Every candidate needs a person to decide.',
      formulas: FORMULAS,
    },
  };
}

/** Rank conflict-free start times for a proposed slot. Scans the first meetings only (stated in the result), never writes. */
export async function suggestSlots(orgId, q, c = pool) {
  const base = await capacityBaseline(orgId, c);
  const tz = q.timezone ?? base.timezone ?? 'UTC';
  const venue = q.venue_id ? base.venues.find((v) => v.id === q.venue_id) : null;
  const probe = { weekdays: q.weekdays };
  const { dates } = occurrences(probe, q.horizon);
  const sample = dates.slice(0, 8), out = [];
  for (let m = q.earliest; m + q.duration_min <= q.latest; m += 30) {
    const k = { weekdays: q.weekdays, start_time: `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`, end_time: `${String(Math.floor((m + q.duration_min) / 60)).padStart(2, '0')}:${String((m + q.duration_min) % 60).padStart(2, '0')}`, venue_id: venue?.id, coach_ids: q.coach_ids, source_cohort_id: q.source_cohort_id, timezone: tz };
    const chk = await checkCohort(c, orgId, k, base, { horizon: { from: q.horizon.from, to: sample.at(-1) ?? q.horizon.to } });
    out.push({ start_time: k.start_time, end_time: k.end_time, meetings_checked: chk.dates.length, venue_conflicts: chk.venue_conflicts.length, staff_conflicts: chk.staff_conflicts.length, school_clashes: chk.school_clashes.length, total: chk.venue_conflicts.length + chk.staff_conflicts.length + chk.school_clashes.length });
  }
  out.sort((x, y) => x.total - y.total || x.start_time.localeCompare(y.start_time));
  return { suggestions: out.slice(0, 6), assessed: { venue: !!venue, coaches: q.coach_ids.length > 0, school: !!q.source_cohort_id }, note: `Checked the first ${Math.min(8, dates.length)} meetings in the period at 30-minute steps. A suggestion is a starting point; the full scenario checks every meeting.` };
}
