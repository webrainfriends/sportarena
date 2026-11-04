// Academy competition, squad & development calendar (#786). The plan POINTS at canonical records and copies none of them:
// teams (teams), fixtures and events (events, fixtures), a competition season (comp_seasons), trips (#485, trips) and appearances.
// Squads are published through the Team capability set_squad (never a shadow roster), conflicts are composed from the academy timetable,
// the school timetable (academics.js), venue/court bookings and trip consent, and the participation review reads official appearances
// with their provenance and never orders or ranks individual athletes.
import { z } from 'zod';
import { cap, id, capabilities } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { opsAccess } from '../academy-ops.js';
import { academicClashes, ymd } from '../academics.js';

const TAG = 'Academy competition';
const day = z.string().date();
const FIXTURE_MINUTES = 120;        // a fixture's planning window when the sport/competition gives no duration
const SEAL = (col) => `academy_competition.${col}`;
const seal = (v, col) => (v ? encrypt(v, SEAL(col)) : null);
const open = (v, col) => (v ? decrypt(v, SEAL(col)) : null);
export const CHECKLIST = ['medical_clearance', 'guardian_consent', 'registration', 'travel_booked', 'kit', 'staff_cover', 'exam_review'];
export const SEATS = ['head_coach', 'performance_director', 'safeguarding_lead', 'academy_director', 'other'];
export const METRICS = ['min_fixture_share_pct', 'min_minutes_per_athlete', 'max_consecutive_matches', 'min_rest_days'];
const BLOCKING = new Set(['training_vs_match', 'staff_double_booked', 'venue_clash', 'school_exam_high_stakes', 'school_exam_clash', 'school_class_block_clash', 'school_tutoring_clash', 'school_school_event_clash']);

const access = async (user, orgId, perm, write, c) => { const a = await opsAccess(user, orgId, { write, c }); return a.need(perm); };
async function planFor(user, planId, { write = false, perm = 'schedule', c } = {}) {
  const p = (await (c ?? pool).query('SELECT * FROM academy_season_plans WHERE id=$1', [planId])).rows[0];
  if (!p) throw notFound('Season plan');
  try { await access(user, p.organisation_id, perm, write, c); } catch { throw notFound('Season plan'); }   // never leak existence
  return p;
}
const shapePlan = (p) => ({ id: p.id, organisation_id: p.organisation_id, name: p.name, starts_on: ymd(p.starts_on), ends_on: ymd(p.ends_on), comp_season_id: p.comp_season_id, status: p.status, notes: open(p.notes_enc, 'notes'), row_version: p.row_version, created_at: p.created_at });

/** The window an entry occupies: its fixture (planning duration) or its event's days. */
async function windowOf(c, e) {
  if (e.fixture_id) {
    const f = (await c.query('SELECT f.scheduled_at, f.resource_id, f.status, ev.venue_id FROM fixtures f JOIN events ev ON ev.id=f.event_id WHERE f.id=$1', [e.fixture_id])).rows[0];
    if (!f) return null;
    const s = new Date(f.scheduled_at);
    return { start: s, end: new Date(s.getTime() + FIXTURE_MINUTES * 60000), resource_id: f.resource_id, venue_id: f.venue_id, cancelled: f.status === 'cancelled' };
  }
  const ev = (await c.query('SELECT starts_on, ends_on, venue_id, status FROM events WHERE id=$1', [e.event_id])).rows[0];
  if (!ev?.starts_on) return null;
  const s = new Date(`${ymd(ev.starts_on)}T00:00:00Z`), en = new Date(`${ymd(ev.ends_on ?? ev.starts_on)}T00:00:00Z`);
  return { start: s, end: new Date(en.getTime() + 864e5), resource_id: null, venue_id: ev.venue_id, cancelled: ev.status === 'cancelled' };
}

/** Every conflict for one entry, from the canonical sources. `blocking` stops a squad being published; consent and checklist gaps are shown but chased, not blocked. */
export async function entryConflicts(c, plan, e) {
  const w = await windowOf(c, e);
  if (!w || w.cancelled) return [];
  const out = [];
  const push = (kind, code, message, extra = {}) => out.push({ entry_id: e.id, team_id: e.team_id, kind, code, message, blocking: BLOCKING.has(code), ...extra });
  if (e.cohort_id) {
    const tr = (await c.query("SELECT id, title, starts_at FROM academy_sessions WHERE cohort_id=$1 AND status<>'cancelled' AND starts_at < $3 AND ends_at > $2 ORDER BY starts_at", [e.cohort_id, w.start, w.end])).rows;
    for (const s of tr) push('training', 'training_vs_match', `Training "${s.title}" overlaps this match`, { session_id: s.id, at: s.starts_at });
    const clash = await academicClashes(c, { cohort_id: e.cohort_id, organisation_id: plan.organisation_id, starts_at: w.start, ends_at: w.end });
    for (const k of clash) push('exam', k.code, k.message);
  }
  // staff: the coaches picked for this team who are also on an overlapping academy session
  const staff = (await c.query(
    `SELECT DISTINCT ss.user_id, s.title, u.display_name FROM academy_session_staff ss JOIN academy_sessions s ON s.id=ss.session_id JOIN users u ON u.id=ss.user_id
      WHERE ss.status IN ('assigned','confirmed') AND s.status<>'cancelled' AND s.starts_at < $2 AND s.ends_at > $1
        AND ss.user_id IN (SELECT user_id FROM team_members WHERE team_id=$3 AND status='active' AND role IN ('coach','manager'))`, [w.start, w.end, e.team_id])).rows;
  for (const r of staff) push('staff', 'staff_double_booked', `${r.display_name} is rostered on "${r.title}" at the same time`, { user_id: r.user_id });
  if (w.resource_id) {
    const b = (await c.query("SELECT 1 FROM bookings WHERE resource_id=$1 AND status='confirmed' AND starts_at < $3 AND ends_at > $2 AND event_id IS DISTINCT FROM $4 LIMIT 1", [w.resource_id, w.start, w.end, e.event_id])).rowCount;
    if (b) push('venue', 'venue_clash', 'The court or pitch is booked by someone else at that time');
  }
  if (e.trip_id) {
    const miss = (await c.query(
      `SELECT u.display_name FROM trip_participants p JOIN users u ON u.id=p.user_id WHERE p.trip_id=$1 AND p.status IN ('invited','confirmed') AND p.role='athlete'
         AND EXISTS (SELECT 1 FROM guardian_links g WHERE g.child_id=p.user_id AND g.status='active' AND g.revoked_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM trip_consents t WHERE t.participant_id=p.id AND t.revoked_at IS NULL AND t.expires_at > now())`, [e.trip_id])).rows;
    if (miss.length) push('guardian', 'guardian_travel_consent_missing', `${miss.length} young traveller(s) have no current guardian trip consent`, { count: miss.length });
  }
  return out;
}

const liveEntries = (c, planId) => c.query('SELECT * FROM academy_plan_entries WHERE plan_id=$1 AND removed_at IS NULL ORDER BY added_at', [planId]).then((r) => r.rows);

// ------------------------------------------------------------------------------------------------ plans
cap({
  name: 'create_season_plan', method: 'POST', path: '/organisations/:id/season-plans', tag: TAG, status: 201,
  summary: 'Start an academy competition season plan (schedule access). It references a competition season if one applies and links squads to canonical teams, fixtures and events.',
  input: z.object({ id, name: z.string().trim().min(2).max(120), starts_on: day, ends_on: day, comp_season_id: id.optional(), notes: z.string().max(2000).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    await access(user, i.id, 'schedule', true, c);
    if (i.ends_on < i.starts_on) throw badRequest('The end date is before the start date');
    if (i.comp_season_id && !(await c.query('SELECT 1 FROM comp_seasons WHERE id=$1', [i.comp_season_id])).rowCount) throw notFound('Competition season');
    const dup = (await c.query("SELECT * FROM academy_season_plans WHERE organisation_id=$1 AND lower(name)=lower($2) AND archived_at IS NULL", [i.id, i.name])).rows[0];
    if (dup) return { ...shapePlan(dup), replayed: true };
    const r = (await c.query('INSERT INTO academy_season_plans(organisation_id,name,starts_on,ends_on,comp_season_id,notes_enc,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [i.id, i.name, i.starts_on, i.ends_on, i.comp_season_id ?? null, seal(i.notes, 'notes'), user.id])).rows[0];
    await audit(c, user.id, 'create_season_plan', 'academy_season_plans', r.id);
    return shapePlan(r);
  }),
});

cap({
  name: 'list_season_plans', method: 'GET', path: '/organisations/:id/season-plans', tag: TAG,
  summary: 'The academy\'s season plans with entry counts, plus the competition seasons its teams are entered in (season_options) to reference from a new plan.',
  input: z.object({ id, include_archived: z.coerce.boolean().default(false) }),
  handler: async ({ user }, i) => {
    await access(user, i.id, 'schedule', false);
    const plans = await many(`SELECT * FROM academy_season_plans WHERE organisation_id=$1 ${i.include_archived ? '' : 'AND archived_at IS NULL'} ORDER BY starts_on DESC`, [i.id]);
    const out = [];
    for (const p of plans) {
      const es = await many('SELECT squad_published_at FROM academy_plan_entries WHERE plan_id=$1 AND removed_at IS NULL', [p.id]);
      out.push({ ...shapePlan(p), entries: es.length, squads_published: es.filter((e) => e.squad_published_at).length });
    }
    const seasons = await many(`SELECT s.id, s.label, s.starts_on, s.ends_on, c.name AS competition FROM comp_seasons s JOIN comp_competitions c ON c.id=s.competition_id
      WHERE EXISTS (SELECT 1 FROM event_entries ee JOIN teams t ON t.id=ee.team_id WHERE ee.event_id=s.event_id AND t.organisation_id=$1 AND ee.status IN ('pending','accepted')) ORDER BY s.starts_on DESC LIMIT 50`, [i.id]);
    return { items: out, season_options: seasons.map((x) => ({ id: x.id, label: `${x.competition} · ${x.label}`, starts_on: ymd(x.starts_on), ends_on: ymd(x.ends_on) })) };
  },
});

cap({
  name: 'get_season_plan', method: 'GET', path: '/season-plans/:id', tag: TAG,
  summary: 'One plan with its entries (team, cohort, event/fixture, trip), objectives, readiness checklist, selection committee and the readiness/coverage metric strip. Everything is a pointer: open the event console, team or trip for the record itself.',
  input: z.object({ id }),
  handler: async ({ user }, i) => {
    const p = await planFor(user, i.id);
    const es = await many(
      `SELECT e.*, t.name AS team_name, k.name AS cohort_name, ev.name AS event_name, f.scheduled_at AS fixture_at, tr.name AS trip_name, tr.status AS trip_status
         FROM academy_plan_entries e JOIN teams t ON t.id=e.team_id LEFT JOIN org_cohorts k ON k.id=e.cohort_id LEFT JOIN events ev ON ev.id=e.event_id
         LEFT JOIN fixtures f ON f.id=e.fixture_id LEFT JOIN trips tr ON tr.id=e.trip_id WHERE e.plan_id=$1 AND e.removed_at IS NULL ORDER BY coalesce(f.scheduled_at, ev.starts_on::timestamptz)`, [p.id]);
    const ids = es.map((e) => e.id);
    const checks = ids.length ? await many('SELECT entry_id, code, state, updated_at FROM academy_plan_checklist WHERE entry_id = ANY($1)', [ids]) : [];
    const appr = ids.length ? await many('SELECT a.id, a.entry_id, a.user_id, a.seat, a.decision, a.decided_at, u.display_name FROM academy_plan_approvals a JOIN users u ON u.id=a.user_id WHERE a.entry_id = ANY($1) AND a.removed_at IS NULL', [ids]) : [];
    const objectives = (await many('SELECT * FROM academy_plan_objectives WHERE plan_id=$1 AND removed_at IS NULL', [p.id])).map((o) => ({ id: o.id, team_id: o.team_id, metric: o.metric, target: Number(o.target), note: open(o.note_enc, 'note') }));
    const items = es.map((e) => ({
      id: e.id, team_id: e.team_id, team_name: e.team_name, cohort_id: e.cohort_id, cohort_name: e.cohort_name, age_group: e.age_group, event_id: e.event_id, event_name: e.event_name, fixture_id: e.fixture_id,
      at: e.fixture_at, trip_id: e.trip_id, trip_name: e.trip_name, trip_status: e.trip_status, squad_target: e.squad_target, squad_published_at: e.squad_published_at,
      checklist: CHECKLIST.map((code) => ({ code, state: checks.find((x) => x.entry_id === e.id && x.code === code)?.state ?? 'open' })),
      committee: appr.filter((a) => a.entry_id === e.id),
    }));
    const done = items.reduce((n, e) => n + e.checklist.filter((x) => x.state !== 'open').length, 0);
    const c0 = await tx(async (c) => (await Promise.all(es.map((e) => entryConflicts(c, p, e)))).flat());
    return { ...shapePlan(p), comp_season_label: p.comp_season_id ? ((await one('SELECT c.name || \' · \' || s.label AS l FROM comp_seasons s JOIN comp_competitions c ON c.id=s.competition_id WHERE s.id=$1', [p.comp_season_id]))?.l ?? null) : null, entries: items, objectives,
      metrics: { entries: items.length, squads_published: items.filter((e) => e.squad_published_at).length, checklist_done: done, checklist_total: items.length * CHECKLIST.length,
        open_conflicts: c0.length, blocking_conflicts: c0.filter((x) => x.blocking).length } };
  },
});

const NEXT = { draft: ['review', 'archived'], review: ['draft', 'committee', 'archived'], committee: ['review', 'published', 'archived'], published: ['archived'], archived: [] };
cap({
  name: 'set_season_plan_status', method: 'POST', path: '/season-plans/:id/status', tag: TAG,
  summary: 'Move a plan through draft → review → committee → published (or archive it; plans are never deleted). Publishing needs no blocking conflict.',
  input: z.object({ id, status: z.enum(['draft', 'review', 'committee', 'published', 'archived']), row_version: z.number().int().optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const p = await planFor(user, i.id, { write: true, c });
    if (i.row_version && i.row_version !== p.row_version) throw conflict('The plan changed; reload it');
    if (!NEXT[p.status].includes(i.status)) throw conflict(`A plan cannot go from ${p.status} to ${i.status}`);
    if (i.status === 'published') {
      const cs = (await Promise.all((await liveEntries(c, p.id)).map((e) => entryConflicts(c, p, e)))).flat().filter((x) => x.blocking);
      if (cs.length) throw conflict('Resolve the blocking conflicts before publishing', { conflicts: cs });
    }
    const r = (await c.query('UPDATE academy_season_plans SET status=$2, row_version=row_version+1, updated_at=now(), archived_at=CASE WHEN $2=\'archived\' THEN now() ELSE archived_at END WHERE id=$1 RETURNING *', [p.id, i.status])).rows[0];
    await audit(c, user.id, `season_plan_${i.status}`, 'academy_season_plans', p.id);
    return shapePlan(r);
  }),
});

// ------------------------------------------------------------------------------------------------ entries (pointers)
cap({
  name: 'add_plan_entry', method: 'POST', path: '/season-plans/:id/entries', tag: TAG, status: 201,
  summary: 'Link a canonical team of this academy to an event or fixture (and optionally the cohort that trains it and a confirmed #485 trip). Nothing is copied or created: add teams to an event, fixtures and trips in the event console / trips, then link them here.',
  input: z.object({ id, team_id: id, event_id: id.optional(), fixture_id: id.optional(), cohort_id: id.optional(), trip_id: id.optional(), age_group: z.string().trim().max(20).optional(), squad_target: z.number().int().min(1).max(80).optional() })
    .refine((v) => v.event_id || v.fixture_id, 'Give an event or a fixture'),
  handler: ({ user }, i) => tx(async (c) => {
    const p = await planFor(user, i.id, { write: true, c });
    if (p.status === 'archived') throw conflict('The plan is archived');
    const team = (await c.query('SELECT id, organisation_id FROM teams WHERE id=$1', [i.team_id])).rows[0];
    if (!team || team.organisation_id !== p.organisation_id) throw notFound('Team');
    if (i.cohort_id && !(await c.query('SELECT 1 FROM org_cohorts WHERE id=$1 AND organisation_id=$2', [i.cohort_id, p.organisation_id])).rowCount) throw notFound('Cohort');
    let eventId = i.event_id ?? null;
    if (i.fixture_id) {
      const f = (await c.query('SELECT * FROM fixtures WHERE id=$1', [i.fixture_id])).rows[0];
      if (!f || (f.home_team_id !== team.id && f.away_team_id !== team.id)) throw notFound('Fixture');
      if (eventId && eventId !== f.event_id) throw badRequest('The fixture belongs to a different event');
      eventId = f.event_id;
    } else if (!(await c.query("SELECT 1 FROM event_entries WHERE event_id=$1 AND team_id=$2 AND status IN ('pending','accepted')", [eventId, team.id])).rowCount) {
      throw badRequest('The team is not entered in that event: enter it in the event console first');
    }
    if (i.trip_id) {
      const t = (await c.query('SELECT organisation_id, team_id, status FROM trips WHERE id=$1', [i.trip_id])).rows[0];
      if (!t || (t.organisation_id !== p.organisation_id && t.team_id !== team.id)) throw notFound('Trip');
      if (t.status === 'cancelled') throw conflict('That trip is cancelled');
    }
    const dup = (await c.query('SELECT * FROM academy_plan_entries WHERE plan_id=$1 AND team_id=$2 AND event_id IS NOT DISTINCT FROM $3 AND fixture_id IS NOT DISTINCT FROM $4 AND removed_at IS NULL', [p.id, team.id, eventId, i.fixture_id ?? null])).rows[0];
    if (dup) return { ...dup, replayed: true };
    const r = (await c.query('INSERT INTO academy_plan_entries(plan_id,team_id,cohort_id,age_group,event_id,fixture_id,trip_id,squad_target,added_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [p.id, team.id, i.cohort_id ?? null, i.age_group ?? null, eventId, i.fixture_id ?? null, i.trip_id ?? null, i.squad_target ?? null, user.id])).rows[0];
    await audit(c, user.id, 'add_plan_entry', 'academy_plan_entries', r.id);
    return r;
  }),
});

cap({
  name: 'remove_plan_entry', method: 'DELETE', path: '/season-plans/:id/entries/:entry_id', tag: TAG,
  summary: 'Unlink an entry (kept as history; the team, fixture, event and trip are untouched).',
  input: z.object({ id, entry_id: id }),
  handler: ({ user }, i) => tx(async (c) => {
    const p = await planFor(user, i.id, { write: true, c });
    const r = (await c.query('UPDATE academy_plan_entries SET removed_at=now() WHERE id=$1 AND plan_id=$2 AND removed_at IS NULL RETURNING id', [i.entry_id, p.id])).rows[0];
    if (!r) throw notFound('Entry');
    await audit(c, user.id, 'remove_plan_entry', 'academy_plan_entries', r.id);
    return { id: r.id, removed: true };
  }),
});

const entryOf = async (c, p, entryId) => { const e = (await c.query('SELECT * FROM academy_plan_entries WHERE id=$1 AND plan_id=$2 AND removed_at IS NULL', [entryId, p.id])).rows[0]; if (!e) throw notFound('Entry'); return e; };

// ------------------------------------------------------------------------------------------------ objectives, checklist, committee
cap({
  name: 'set_plan_objective', method: 'POST', path: '/season-plans/:id/objectives', tag: TAG, status: 201,
  summary: 'Set a measurable participation objective (for the whole plan or one team), e.g. every athlete features in at least 60% of fixtures. Replaces the previous target for that metric.',
  input: z.object({ id, team_id: id.optional(), metric: z.enum(METRICS), target: z.number().min(0).max(100000), note: z.string().max(500).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const p = await planFor(user, i.id, { write: true, c });
    if (i.team_id && !(await c.query('SELECT 1 FROM teams WHERE id=$1 AND organisation_id=$2', [i.team_id, p.organisation_id])).rowCount) throw notFound('Team');
    if (i.metric === 'min_fixture_share_pct' && i.target > 100) throw badRequest('A share is between 0 and 100');
    await c.query('UPDATE academy_plan_objectives SET removed_at=now() WHERE plan_id=$1 AND team_id IS NOT DISTINCT FROM $2 AND metric=$3 AND removed_at IS NULL', [p.id, i.team_id ?? null, i.metric]);
    const r = (await c.query('INSERT INTO academy_plan_objectives(plan_id,team_id,metric,target,note_enc,set_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [p.id, i.team_id ?? null, i.metric, i.target, seal(i.note, 'note'), user.id])).rows[0];
    await audit(c, user.id, 'set_plan_objective', 'academy_plan_objectives', r.id);
    return { id: r.id, team_id: r.team_id, metric: r.metric, target: Number(r.target) };
  }),
});

cap({
  name: 'set_plan_checklist_item', method: 'POST', path: '/season-plans/:id/entries/:entry_id/checklist', tag: TAG,
  summary: 'Mark a readiness item (medical clearance, guardian consent, registration, travel booked, kit, staff cover, exam review) open, done or waived, with encrypted evidence of who confirmed it.',
  input: z.object({ id, entry_id: id, code: z.enum(CHECKLIST), state: z.enum(['open', 'done', 'waived']), evidence: z.string().trim().max(500).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const p = await planFor(user, i.id, { write: true, c });
    const e = await entryOf(c, p, i.entry_id);
    if (i.state === 'waived' && !i.evidence) throw badRequest('A waived item needs a reason');
    const r = (await c.query(`INSERT INTO academy_plan_checklist(entry_id,code,state,evidence_enc,updated_by) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (entry_id,code) DO UPDATE SET state=EXCLUDED.state, evidence_enc=EXCLUDED.evidence_enc, updated_by=EXCLUDED.updated_by, updated_at=now() RETURNING entry_id, code, state, updated_at`,
      [e.id, i.code, i.state, seal(i.evidence, 'evidence'), user.id])).rows[0];
    await audit(c, user.id, 'set_plan_checklist_item', 'academy_plan_entries', e.id);
    return r;
  }),
});

cap({
  name: 'set_plan_committee', method: 'POST', path: '/season-plans/:id/entries/:entry_id/committee', tag: TAG,
  summary: 'Name the selection committee for an entry (each member holds a seat). Members must be active staff of the academy. Changing the list keeps earlier decisions as history.',
  input: z.object({ id, entry_id: id, members: z.array(z.object({ user_id: id, seat: z.enum(SEATS) })).min(1).max(12) }),
  handler: ({ user }, i) => tx(async (c) => {
    const p = await planFor(user, i.id, { write: true, c });
    const e = await entryOf(c, p, i.entry_id);
    const ids = i.members.map((m) => m.user_id);
    if (new Set(ids).size !== ids.length) throw badRequest('A person is on the committee twice');
    const ok = (await c.query("SELECT user_id FROM organisation_members WHERE organisation_id=$1 AND status='active' AND user_id = ANY($2)", [p.organisation_id, ids])).rows.map((r) => r.user_id);
    const bad = ids.filter((u) => !ok.includes(u));
    if (bad.length) throw badRequest('Committee members must be active members of the academy', { user_ids: bad });
    await c.query('UPDATE academy_plan_approvals SET removed_at=now() WHERE entry_id=$1 AND removed_at IS NULL AND NOT (user_id = ANY($2))', [e.id, ids]);
    for (const m of i.members) await c.query(`INSERT INTO academy_plan_approvals(entry_id,user_id,seat,added_by) VALUES ($1,$2,$3,$4)
      ON CONFLICT (entry_id,user_id) WHERE removed_at IS NULL DO UPDATE SET seat=EXCLUDED.seat`, [e.id, m.user_id, m.seat, user.id]);
    await audit(c, user.id, 'set_plan_committee', 'academy_plan_entries', e.id);
    return { entry_id: e.id, members: (await c.query('SELECT user_id, seat, decision FROM academy_plan_approvals WHERE entry_id=$1 AND removed_at IS NULL', [e.id])).rows };
  }),
});

cap({
  name: 'decide_plan_approval', method: 'POST', path: '/season-plans/:id/entries/:entry_id/approval', tag: TAG,
  summary: 'A committee member approves or rejects the selection for an entry with evidence (the criteria note, the data reviewed). Only the member themself can decide their seat.',
  input: z.object({ id, entry_id: id, decision: z.enum(['approved', 'rejected']), evidence: z.string().trim().min(3).max(1000) }),
  handler: ({ user }, i) => tx(async (c) => {
    const p = (await c.query('SELECT * FROM academy_season_plans WHERE id=$1', [i.id])).rows[0];
    if (!p) throw notFound('Season plan');
    const e = await entryOf(c, p, i.entry_id).catch(() => { throw notFound('Season plan'); });
    const r = (await c.query('UPDATE academy_plan_approvals SET decision=$3, evidence_enc=$4, decided_at=now() WHERE entry_id=$1 AND user_id=$2 AND removed_at IS NULL RETURNING seat, decision, decided_at', [e.id, user.id, i.decision, seal(i.evidence, 'evidence')])).rows[0];
    if (!r) throw notFound('Season plan');          // not on the committee: indistinguishable from not existing
    await audit(c, user.id, `plan_selection_${i.decision}`, 'academy_plan_entries', e.id);
    return r;
  }),
});

// ------------------------------------------------------------------------------------------------ calendar + conflicts
cap({
  name: 'get_plan_calendar', method: 'GET', path: '/season-plans/:id/calendar', tag: TAG,
  summary: 'The squad calendar: every linked fixture/event, plus the cohort\'s training sessions and the competition season rounds, read live from their own tables (nothing stored here).',
  input: z.object({ id }),
  handler: async ({ user }, i) => {
    const p = await planFor(user, i.id);
    const items = [];
    await tx(async (c) => {
      for (const e of await liveEntries(c, p.id)) {
        const w = await windowOf(c, e);
        if (w) items.push({ type: e.fixture_id ? 'fixture' : 'event', entry_id: e.id, team_id: e.team_id, starts_at: w.start, ends_at: w.end });
        if (e.cohort_id && w) for (const s of (await c.query("SELECT id, title, starts_at, ends_at FROM academy_sessions WHERE cohort_id=$1 AND status<>'cancelled' AND starts_at >= $2 AND starts_at < $3", [e.cohort_id, new Date(w.start.getTime() - 7 * 864e5), new Date(w.end.getTime() + 7 * 864e5)])).rows)
          items.push({ type: 'training', entry_id: e.id, team_id: e.team_id, session_id: s.id, title: s.title, starts_at: s.starts_at, ends_at: s.ends_at });
      }
    });
    items.sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
    return { plan_id: p.id, items };
  },
});

cap({
  name: 'check_plan_conflicts', method: 'GET', path: '/season-plans/:id/conflicts', tag: TAG,
  summary: 'Training-vs-match, staff, venue, school-exam and guardian-trip-consent conflicts for the plan (or one entry), composed from the academy timetable, school timetable, bookings and trips. Blocking ones stop a squad or plan being published.',
  input: z.object({ id, entry_id: id.optional() }),
  handler: async ({ user }, i) => {
    const p = await planFor(user, i.id);
    return tx(async (c) => {
      const es = (await liveEntries(c, p.id)).filter((e) => !i.entry_id || e.id === i.entry_id);
      const items = (await Promise.all(es.map((e) => entryConflicts(c, p, e)))).flat();
      return { plan_id: p.id, items, blocking: items.filter((x) => x.blocking).length };
    });
  },
});

// ------------------------------------------------------------------------------------------------ publish through the Team capability
cap({
  name: 'publish_plan_squad', method: 'POST', path: '/season-plans/:id/entries/:entry_id/publish-squad', tag: TAG,
  summary: 'Publish the selected squad for an entry THROUGH the Team squad capability (invites, availability, consent and eligibility rules all apply; no parallel roster). Blocked by any blocking conflict and, if a committee is set, until every seat has approved.',
  input: z.object({ id, entry_id: id, members: z.array(z.object({ user_id: id, role: z.enum(['player', 'captain', 'vice_captain', 'substitute', 'coach', 'manager', 'physio']).default('player'), position: z.string().max(40).optional() })).min(1).max(80) }),
  handler: async ({ user }, i) => {
    const p = await planFor(user, i.id, { write: true, perm: 'roster' });
    const pre = await tx(async (c) => {
      const e = await entryOf(c, p, i.entry_id);
      const cs = (await entryConflicts(c, p, e)).filter((x) => x.blocking);
      if (cs.length) throw conflict('Resolve the blocking conflicts before publishing the squad', { conflicts: cs });
      const seats = (await c.query('SELECT decision FROM academy_plan_approvals WHERE entry_id=$1 AND removed_at IS NULL', [e.id])).rows;
      if (seats.some((s) => s.decision !== 'approved')) throw conflict('The selection committee has not fully approved this squad', { pending: seats.filter((s) => s.decision === 'pending').length, rejected: seats.filter((s) => s.decision === 'rejected').length });
      return e;
    });
    const setSquad = capabilities.find((x) => x.name === 'set_squad');
    const squad = await setSquad.handler({ user }, { id: pre.team_id, event_id: pre.fixture_id ? undefined : pre.event_id, fixture_id: pre.fixture_id ?? undefined, allow_unavailable: false, members: i.members });
    await tx(async (c) => {
      await c.query('UPDATE academy_plan_entries SET squad_published_at=now(), squad_published_by=$2 WHERE id=$1', [pre.id, user.id]);
      await audit(c, user.id, 'publish_plan_squad', 'academy_plan_entries', pre.id);
    });
    return { entry_id: pre.id, published: true, squad };
  },
});

// ------------------------------------------------------------------------------------------------ participation & exposure review
cap({
  name: 'get_participation_review', method: 'GET', path: '/season-plans/:id/participation', tag: TAG,
  summary: 'Fixtures played, minutes and exposure per athlete against the plan\'s objectives, each figure traced to the official appearance record (minutes basis, source, verification). Athletes are listed alphabetically; there is deliberately no ranking or ordering by performance. Every read is audit-logged.',
  input: z.object({ id }),
  handler: async ({ user }, i) => {
    const p = await planFor(user, i.id, { perm: 'roster' });
    return tx(async (c) => {
      const es = await liveEntries(c, p.id);
      const objs = (await c.query('SELECT * FROM academy_plan_objectives WHERE plan_id=$1 AND removed_at IS NULL', [p.id])).rows;
      const teams = [...new Set(es.map((e) => e.team_id))], out = [];
      for (const teamId of teams) {
        const fixtureIds = es.filter((e) => e.team_id === teamId && e.fixture_id).map((e) => e.fixture_id);
        const fx = fixtureIds.length ? (await c.query("SELECT id FROM fixtures WHERE id = ANY($1) AND status='completed'", [fixtureIds])).rows.map((r) => r.id) : [];
        const squad = (await c.query(`SELECT DISTINCT s.user_id, u.display_name FROM team_squads s JOIN users u ON u.id=s.user_id WHERE s.team_id=$1 AND s.status<>'dropped' AND s.role IN ('player','captain','vice_captain','substitute')
          AND (s.fixture_id = ANY($2) OR s.event_id = ANY($3)) ORDER BY u.display_name`, [teamId, fixtureIds, es.filter((e) => e.team_id === teamId && !e.fixture_id).map((e) => e.event_id)])).rows;
        const ap = fx.length ? (await c.query('SELECT fixture_id, user_id, status, minutes_played, minutes_basis, source, authority, verified_by IS NOT NULL AS verified FROM match_appearances WHERE fixture_id = ANY($1) AND team_id=$2 AND archived_at IS NULL', [fx, teamId])).rows : [];
        const obj = (m) => Number((objs.find((o) => o.team_id === teamId && o.metric === m) ?? objs.find((o) => !o.team_id && o.metric === m))?.target ?? NaN);
        const share = obj('min_fixture_share_pct'), mins = obj('min_minutes_per_athlete');
        const athletes = squad.map((s) => {
          const mine = ap.filter((a) => a.user_id === s.user_id && a.status !== 'dnp');
          const minutes = mine.reduce((n, a) => n + Number(a.minutes_played ?? 0), 0);
          const unverified = mine.filter((a) => a.minutes_played == null).length;
          const pct = fx.length ? Math.round((mine.length / fx.length) * 100) : null;
          return { user_id: s.user_id, display_name: s.display_name, fixtures_featured: mine.length, minutes, minutes_unverified_fixtures: unverified,
            provenance: mine.map((a) => ({ fixture_id: a.fixture_id, minutes_basis: a.minutes_basis, source: a.source, authority: a.authority, verified: a.verified })),
            below_objective: (Number.isFinite(share) && pct != null && pct < share) || (Number.isFinite(mins) && fx.length > 0 && minutes < mins) };
        });
        out.push({ team_id: teamId, completed_fixtures: fx.length, planned_fixtures: fixtureIds.length, athletes, objectives: objs.filter((o) => !o.team_id || o.team_id === teamId).map((o) => ({ metric: o.metric, target: Number(o.target) })), ranked: false });
      }
      await audit(c, user.id, 'read_participation_review', 'academy_season_plans', p.id);
      return { plan_id: p.id, teams: out, note: 'Source: official match appearances. Individual athletes are not ranked.' };
    });
  },
});

// ------------------------------------------------------------------------------------------------ the read-only strip in the event console
cap({
  name: 'get_event_academy_plans', method: 'GET', path: '/events/:id/academy-plans', tag: TAG,
  summary: 'For the event console: the academy plans (of organisations the caller has schedule access to) that link this event, with squad and conflict counts. Read-only; teams, seeding and invitations stay in the event console.',
  input: z.object({ id }),
  handler: async ({ user }, i) => {
    const rows = await many(`SELECT e.*, p.name AS plan_name, p.organisation_id, t.name AS team_name FROM academy_plan_entries e JOIN academy_season_plans p ON p.id=e.plan_id JOIN teams t ON t.id=e.team_id
      WHERE e.event_id=$1 AND e.removed_at IS NULL AND p.archived_at IS NULL`, [i.id]);
    const items = [];
    for (const r of rows) {
      try { await access(user, r.organisation_id, 'schedule', false); } catch { continue; }
      const plan = (await one('SELECT * FROM academy_season_plans WHERE id=$1', [r.plan_id]));
      const cs = await tx((c) => entryConflicts(c, plan, r));
      items.push({ plan_id: r.plan_id, plan_name: r.plan_name, team_id: r.team_id, team_name: r.team_name, squad_published_at: r.squad_published_at, open_conflicts: cs.length, blocking_conflicts: cs.filter((x) => x.blocking).length });
    }
    return { items };
  },
});

// ------------------------------------------------------------------------------------------------ pickers
cap({
  name: 'get_plan_candidates', method: 'GET', path: '/season-plans/:id/candidates', tag: TAG,
  summary: 'Everything the plan screen can pick from, read live: the academy\'s teams (with active members and availability), cohorts, staff for the committee, and each team\'s upcoming fixtures, entered events and the organisation\'s trips. Nothing is created here.',
  input: z.object({ id }),
  handler: async ({ user }, i) => {
    const p = await planFor(user, i.id);
    const teams = await many('SELECT t.id, t.name FROM teams t WHERE t.organisation_id=$1 AND t.archived_at IS NULL ORDER BY t.name', [p.organisation_id]);
    const ids = teams.map((t) => t.id);
    const members = ids.length ? await many("SELECT m.team_id, m.user_id, m.role, m.availability, u.display_name FROM team_members m JOIN users u ON u.id=m.user_id WHERE m.team_id = ANY($1) AND m.status='active' ORDER BY u.display_name", [ids]) : [];
    const fixtures = ids.length ? await many(`SELECT f.id, f.event_id, f.scheduled_at, f.status, e.name AS event_name, CASE WHEN f.home_team_id = ANY($1) THEN f.home_team_id ELSE f.away_team_id END AS team_id
      FROM fixtures f JOIN events e ON e.id=f.event_id WHERE (f.home_team_id = ANY($1) OR f.away_team_id = ANY($1)) AND f.status IN ('scheduled','live','completed') AND f.scheduled_at BETWEEN $2::date - 30 AND $3::date + 30 ORDER BY f.scheduled_at`, [ids, p.starts_on, p.ends_on]) : [];
    const events = ids.length ? await many("SELECT ee.team_id, e.id, e.name, e.starts_on, e.ends_on FROM event_entries ee JOIN events e ON e.id=ee.event_id WHERE ee.team_id = ANY($1) AND ee.status IN ('pending','accepted') AND e.status<>'cancelled' ORDER BY e.starts_on", [ids]) : [];
    const cohorts = await many('SELECT id, name FROM org_cohorts WHERE organisation_id=$1 ORDER BY name', [p.organisation_id]);
    const staff = await many("SELECT m.user_id, u.display_name FROM organisation_members m JOIN users u ON u.id=m.user_id WHERE m.organisation_id=$1 AND m.status='active' ORDER BY u.display_name", [p.organisation_id]);
    const trips = await many("SELECT id, name, status, team_id FROM trips WHERE (organisation_id=$1 OR team_id = ANY($2)) AND status<>'cancelled' ORDER BY depart_at", [p.organisation_id, ids]);
    return { teams: teams.map((t) => ({ ...t, members: members.filter((m) => m.team_id === t.id) })), cohorts, staff, fixtures, events, trips };
  },
});
