// Event Operations Centre (#586): prepare, run and close an event from one place, without re-entering what other domains own.
// Readiness is read LIVE from venue, teams, crew, accreditation, budget, sponsors, travel and media; incidents, contacts and the debrief are the only new records.
// Nothing is deleted: requirements are archived, contacts archived, incidents closed, debrief items archived.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { many, one, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { eventForOrganizer } from './events.js';
import { isOrganiser } from './event-departments.js';

const TAG = 'Event operations';
const AREAS = ['programme', 'venue', 'participants', 'officials', 'staff', 'suppliers', 'procurement', 'accreditation', 'tickets', 'transport', 'safety', 'medical', 'media', 'sponsors', 'finance', 'tasks', 'other'];
const AREA_LABEL = { programme: 'Programme / run of show', venue: 'Venue', participants: 'Participants', officials: 'Officials', staff: 'Staff & volunteers', suppliers: 'Suppliers', procurement: 'Procurement', accreditation: 'Accreditation', tickets: 'Tickets & attendance', transport: 'Transport & travel', safety: 'Safety & security', medical: 'Medical cover', media: 'Media & broadcast', sponsors: 'Sponsors', finance: 'Budget & insurance', tasks: 'Open tasks', other: 'Other' };
const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const INCIDENT_CATEGORIES = ['medical', 'safety', 'security', 'crowd', 'weather', 'facility', 'conduct', 'technical', 'supplier', 'transport', 'other'];
const CONTACT_AREAS = ['control_room', 'venue', 'medical', 'security', 'officials', 'media', 'transport', 'suppliers', 'sponsors', 'emergency', 'organiser', 'other'];
const area = z.enum(AREAS);
const date = z.string().date();
const text = (max) => z.string().trim().min(3).max(max);

// ---------------------------------------------------------------- access
/** organiser (or org admin / platform admin) · lead of a department · crew (active department member or accepted staff). Everyone else gets 404: operations are private. */
export async function opsAccess(user, ev, c) {
  const organiser = await isOrganiser(user, ev, c);
  const q = (c ?? pool);
  const lead = (await q.query(
    `SELECT 1 FROM event_departments d WHERE d.event_id=$1 AND d.status='active' AND d.lead_user_id=$2
     UNION SELECT 1 FROM event_department_members m WHERE m.event_id=$1 AND m.user_id=$2 AND m.status='active' AND m.role='lead'`, [ev.id, user.id])).rowCount > 0;
  const crew = organiser || lead || (await q.query(
    `SELECT 1 FROM event_department_members WHERE event_id=$1 AND user_id=$2 AND status='active'
     UNION SELECT 1 FROM event_staff_assignments WHERE event_id=$1 AND user_id=$2 AND status='accepted'`, [ev.id, user.id])).rowCount > 0;
  return { organiser, lead, crew, manager: organiser || lead };
}
async function loadEvent(user, eventId, need, c) {
  const ev = (await (c ?? pool).query('SELECT * FROM events WHERE id=$1', [eventId])).rows[0];
  if (!ev) throw notFound('Event');
  const a = await opsAccess(user, ev, c);
  if (!a.crew) throw notFound('Event operations');
  if (need === 'manager' && !a.manager) throw forbidden('Only the organiser or a department lead can do this');
  if (need === 'organiser' && !a.organiser) throw forbidden('Only the organiser can do this');
  return { ev, access: a };
}

// ---------------------------------------------------------------- readiness (derived from the owning domains)
const n = (rows) => Number(rows[0]?.n ?? 0);
const plural = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;

/** The standard requirements. `check` reads the owning domain live and returns [met, detail]. */
export const STANDARD = [
  { key: 'programme_scheduled', area: 'programme', title: 'Games or sessions are scheduled', check: async (q, ev) => { const k = n((await q('SELECT count(*) n FROM fixtures WHERE event_id=$1 AND status<>\'cancelled\'', [ev.id])).rows); return [k > 0, plural(k, 'game') + ' scheduled']; } },
  { key: 'seeds_set', area: 'programme', title: 'Teams are seeded', check: async (q, ev) => { const k = n((await q('SELECT count(*) n FROM event_seeds WHERE event_id=$1', [ev.id])).rows); return [k >= 2, k ? `${k} seeded` : 'No seeds yet']; } },
  { key: 'bracket_built', area: 'programme', title: 'Knockout bracket is built', check: async (q, ev) => { const k = n((await q("SELECT count(*) n FROM fixtures WHERE event_id=$1 AND round_kind IN ('round_of_32','round_of_16','quarter','semi','final','winners','grand_final')", [ev.id])).rows); return [k > 0, k ? plural(k, 'knockout game') : 'No bracket yet']; } },
  { key: 'venue_set', area: 'venue', title: 'A venue is chosen', check: async (q, ev) => [!!ev.venue_id, ev.venue_id ? 'Venue set' : 'No venue chosen'] },
  { key: 'courts_booked', area: 'venue', title: 'Courts are booked for the event days', check: async (q, ev) => { const k = n((await q("SELECT count(*) n FROM bookings WHERE event_id=$1 AND status='confirmed'", [ev.id])).rows); return [k > 0, plural(k, 'court booking')]; } },
  { key: 'teams_confirmed', area: 'participants', title: 'At least two entries are accepted', check: async (q, ev) => { const k = n((await q("SELECT count(*) n FROM event_entries WHERE event_id=$1 AND status='accepted'", [ev.id])).rows); return [k >= 2, plural(k, 'entry') + ' accepted' + (ev.capacity ? ` of ${ev.capacity}` : '')]; } },
  { key: 'officials_assigned', area: 'officials', title: 'Officials are confirmed', check: async (q, ev) => { const k = n((await q("SELECT count(*) n FROM event_staff_assignments a JOIN event_staff_roles r ON r.id=a.role_id WHERE a.event_id=$1 AND a.status='accepted' AND r.role IN ('referee','umpire','linesman','scorer')", [ev.id])).rows); return [k > 0, plural(k, 'official') + ' confirmed']; } },
  { key: 'crew_confirmed', area: 'staff', title: 'Staff and volunteers have joined departments', check: async (q, ev) => { const k = n((await q("SELECT count(*) n FROM event_department_members WHERE event_id=$1 AND status='active'", [ev.id])).rows); return [k > 0, plural(k, 'crew member') + ' active']; } },
  { key: 'suppliers_confirmed', area: 'suppliers', title: 'Suppliers and vendors are confirmed', check: async (q, ev) => { const k = n((await q(`SELECT (SELECT count(*) FROM event_vendors WHERE event_id=$1 AND status='accepted' AND kind<>'sponsor') + (SELECT count(*) FROM event_requests WHERE event_id=$1 AND kind='supplier' AND status='finalized') n`, [ev.id])).rows); return [k > 0, plural(k, 'supplier') + ' confirmed']; } },
  { key: 'accreditation_issued', area: 'accreditation', title: 'Accreditation badges are issued', check: async (q, ev) => { const k = n((await q("SELECT count(*) n FROM accreditations WHERE event_id=$1 AND status='approved'", [ev.id])).rows); return [k > 0, plural(k, 'badge') + ' issued']; } },
  { key: 'capacity_set', area: 'tickets', title: 'Attendance capacity is set', check: async (q, ev) => [!!ev.capacity, ev.capacity ? `Capacity ${ev.capacity}` : 'No capacity set'] },
  { key: 'tickets_on_sale', area: 'tickets', title: 'Spectator tickets are on sale', check: async (q, ev) => { const n = (await q("SELECT count(*)::int AS n FROM ticket_products WHERE event_id=$1 AND status='active'", [ev.id])).rows[0].n; return [n > 0, n ? `${n} ticket product${n === 1 ? '' : 's'} on sale` : 'No spectator tickets on sale']; } },
  { key: 'travel_linked', area: 'transport', title: 'Team travel is linked to the event', check: async (q, ev) => { const k = n((await q('SELECT count(*) n FROM trip_events WHERE event_id=$1 AND unlinked_at IS NULL', [ev.id])).rows); return [k > 0, plural(k, 'trip') + ' linked']; } },
  { key: 'safety_team', area: 'safety', title: 'A security / safety team is staffed', check: async (q, ev) => { const k = n((await q(`SELECT (SELECT count(*) FROM event_department_members m JOIN event_departments d ON d.id=m.department_id WHERE m.event_id=$1 AND m.status='active' AND d.kind='security' AND d.status='active') + (SELECT count(*) FROM event_staff_assignments a JOIN event_staff_roles r ON r.id=a.role_id WHERE a.event_id=$1 AND a.status='accepted' AND r.role='security') n`, [ev.id])).rows); return [k > 0, `${k} on the safety team`]; } },
  { key: 'medical_cover', area: 'medical', title: 'Medical cover is confirmed', check: async (q, ev) => { const k = n((await q(`SELECT (SELECT count(*) FROM event_department_members m JOIN event_departments d ON d.id=m.department_id WHERE m.event_id=$1 AND m.status='active' AND d.kind='medical' AND d.status='active') + (SELECT count(*) FROM event_staff_assignments a JOIN event_staff_roles r ON r.id=a.role_id WHERE a.event_id=$1 AND a.status='accepted' AND r.role IN ('doctor','physio','medic')) n`, [ev.id])).rows); return [k > 0, plural(k, 'medical staff member') + ' confirmed']; } },
  { key: 'media_plan', area: 'media', title: 'Media / broadcast crew is in place', check: async (q, ev) => { const k = n((await q(`SELECT (SELECT count(*) FROM event_department_members m JOIN event_departments d ON d.id=m.department_id WHERE m.event_id=$1 AND m.status='active' AND d.kind='media' AND d.status='active') + (SELECT count(*) FROM mr_crew WHERE event_id=$1 AND status IN ('assigned','acknowledged')) n`, [ev.id])).rows); return [k > 0, plural(k, 'media crew member') + ' assigned']; } },
  { key: 'sponsors_confirmed', area: 'sponsors', title: 'Sponsors are confirmed', check: async (q, ev) => { const k = n((await q("SELECT count(*) n FROM event_vendors WHERE event_id=$1 AND kind='sponsor' AND status='accepted'", [ev.id])).rows); return [k > 0, plural(k, 'sponsor') + ' confirmed']; } },
  { key: 'budget_set', area: 'finance', title: 'A budget is planned', check: async (q, ev) => { const k = n((await q("SELECT count(*) n FROM event_budget_lines WHERE event_id=$1 AND status<>'void'", [ev.id])).rows); return [k > 0, plural(k, 'budget line')]; } },
  { key: 'insurance_in_place', area: 'finance', title: 'Event insurance is arranged', check: async (q, ev) => { const k = n((await q("SELECT count(*) n FROM event_requests WHERE event_id=$1 AND kind='insurer' AND status='finalized'", [ev.id])).rows); return [k > 0, k ? 'Insurance finalized' : 'No insurer finalized']; } },
  { key: 'tasks_clear', area: 'tasks', title: 'No overdue or blocked tasks', check: async (q, ev) => { const k = n((await q("SELECT count(*) n FROM event_tasks WHERE event_id=$1 AND (status='blocked' OR (status IN ('todo','doing') AND due_on < current_date))", [ev.id])).rows); return [k === 0, k ? plural(k, 'task') + ' overdue or blocked' : 'All tasks on track']; } },
  { key: 'incidents_clear', area: 'safety', title: 'No unresolved high or critical incidents', check: async (q, ev) => { const k = n((await q("SELECT count(*) n FROM event_incidents WHERE event_id=$1 AND severity IN ('high','critical') AND status IN ('open','acknowledged','escalated')", [ev.id])).rows); return [k === 0, k ? plural(k, 'incident') + ' unresolved' : 'None open']; } },
];
const STANDARD_BY_KEY = Object.fromEntries(STANDARD.map((s) => [s.key, s]));

const reqRow = (r) => ({ id: r.id, area: r.area, area_label: AREA_LABEL[r.area], title: r.title, derived: !!r.derive_key, derive_key: r.derive_key, required: r.required, owner_id: r.owner_id, owner_name: r.owner_name ?? null, due_on: r.due_on, waived_reason: r.waived_reason, done_at: r.done_at });

/** Requirements with their live state and the readiness percentage (waived and optional ones do not count against it). */
export async function readinessOf(ev, c) {
  const q = (s, p) => (c ?? pool).query(s, p);
  const rows = (await q(
    `SELECT r.*, u.display_name AS owner_name FROM event_ops_requirements r LEFT JOIN users u ON u.id=r.owner_id
      WHERE r.event_id=$1 AND r.archived_at IS NULL ORDER BY r.created_at, r.title`, [ev.id])).rows;
  const items = [];
  for (const r of rows) {
    let met = r.status === 'done', detail = null;
    if (r.derive_key) {
      const def = STANDARD_BY_KEY[r.derive_key];
      if (def) [met, detail] = await def.check(q, ev);
    }
    const state = r.status === 'waived' ? 'waived' : met ? 'met' : 'open';
    items.push({ ...reqRow(r), state, detail });
  }
  const counted = items.filter((i) => i.required && i.state !== 'waived');
  const met = counted.filter((i) => i.state === 'met').length;
  const byArea = {};
  for (const i of items) { const a = (byArea[i.area] ??= { area: i.area, label: AREA_LABEL[i.area], met: 0, total: 0 }); if (i.required && i.state !== 'waived') { a.total++; if (i.state === 'met') a.met++; } }
  return { percent: counted.length ? Math.round((met / counted.length) * 100) : 0, met, total: counted.length, waived: items.filter((i) => i.state === 'waived').length, areas: Object.values(byArea).filter((a) => a.total), items };
}

cap({
  name: 'get_event_readiness', method: 'GET', path: '/events/:id/ops/readiness', tag: TAG,
  summary: 'Pre-event readiness: every explicit requirement with its live state and the percentage met. Requirements marked derived are read from venue, teams, crew, accreditation, budget, sponsors, travel and media: nothing is typed twice. Waived and optional requirements do not count against the percentage.',
  input: z.object({ id }),
  async handler({ user }, i) { const { ev } = await loadEvent(user, i.id); return readinessOf(ev); },
});

cap({
  name: 'add_standard_event_requirements', method: 'POST', path: '/events/:id/ops/requirements/standard', tag: TAG, status: 201,
  summary: 'Add the standard set of readiness requirements (programme, venue, participants, officials, staff, suppliers, accreditation, attendance, travel, safety, medical, media, sponsors, budget, insurance, tasks, incidents). Safe to repeat: ones already there (even waived) are kept, none are duplicated. Pass `keys` for a subset.',
  input: z.object({ id, keys: z.array(z.string()).max(40).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ev } = await loadEvent(user, i.id, 'organiser', c);
      const want = (i.keys ?? STANDARD.map((s) => s.key));
      const bad = want.filter((k) => !STANDARD_BY_KEY[k]);
      if (bad.length) throw badRequest(`Unknown requirement: ${bad.join(', ')}`);
      let added = 0;
      for (const k of want) {
        const s = STANDARD_BY_KEY[k];
        const r = await c.query(
          'INSERT INTO event_ops_requirements(event_id, area, title, derive_key, created_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (event_id, derive_key) WHERE derive_key IS NOT NULL AND archived_at IS NULL DO NOTHING',
          [ev.id, s.area, s.title, s.key, user.id]);
        added += r.rowCount;
      }
      return { added, readiness: await readinessOf(ev, c) };
    });
  },
});

cap({
  name: 'list_standard_event_requirements', method: 'GET', path: '/event-ops/requirements/standard', tag: TAG, auth: 'public',
  summary: 'The standard readiness requirements and the areas they cover.',
  input: z.object({}),
  handler: async () => ({ areas: AREAS.map((a) => ({ key: a, label: AREA_LABEL[a] })), requirements: STANDARD.map(({ key, area: a, title }) => ({ key, area: a, title })) }),
});

cap({
  name: 'add_event_requirement', method: 'POST', path: '/events/:id/ops/requirements', tag: TAG, status: 201,
  summary: 'Add a manual requirement for something no other part of the platform tracks (e.g. "Sign off the fire-safety certificate"). The owner, or the organiser, marks it done.',
  input: z.object({ id, area, title: text(160), owner_id: id.optional(), due_on: date.optional(), required: z.boolean().default(true) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ev } = await loadEvent(user, i.id, 'organiser', c);
      const r = (await c.query('INSERT INTO event_ops_requirements(event_id, area, title, owner_id, due_on, required, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [ev.id, i.area, i.title, i.owner_id ?? null, i.due_on ?? null, i.required, user.id])).rows[0];
      if (i.owner_id && i.owner_id !== user.id) await notify(c, i.owner_id, { kind: 'event_ops', title: `Requirement for ${ev.name}`, body: i.title, data: { event_id: ev.id, ops_requirement: true } });
      return reqRow(r);
    });
  },
});

cap({
  name: 'update_event_requirement', method: 'PATCH', path: '/events/:id/ops/requirements/:requirement_id', tag: TAG,
  summary: 'Mark a manual requirement done / open, change owner or due date, make it optional, or waive any requirement with a reason (a derived one cannot be ticked: it follows the real data). Archive one you no longer need; it is kept.',
  input: z.object({ id, requirement_id: id, status: z.enum(['open', 'done', 'waived']).optional(), waived_reason: text(300).optional(), owner_id: id.nullable().optional(), due_on: date.nullable().optional(), required: z.boolean().optional(), archive: z.boolean().optional(), title: text(160).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ev, access } = await loadEvent(user, i.id, null, c);
      const r = (await c.query('SELECT * FROM event_ops_requirements WHERE id=$1 AND event_id=$2 AND archived_at IS NULL FOR UPDATE', [i.requirement_id, ev.id])).rows[0];
      if (!r) throw notFound('Requirement');
      const owner = r.owner_id === user.id;
      if (!access.organiser && !(owner && !r.derive_key && i.status && Object.keys(i).filter((k) => !['id', 'requirement_id', 'status'].includes(k)).length === 0)) throw forbidden('Only the organiser can change this requirement (an owner may tick their own)');
      if (i.status === 'done' && r.derive_key) throw badRequest('This requirement follows the real data and cannot be ticked by hand; fix the source or waive it with a reason');
      if (i.status === 'waived' && !i.waived_reason) throw badRequest('Say why it is waived');
      const status = i.status ?? r.status;
      const u = (await c.query(
        `UPDATE event_ops_requirements SET status=$2, waived_reason=CASE WHEN $2='waived' THEN coalesce($3,waived_reason) ELSE NULL END,
           owner_id=CASE WHEN $4::boolean THEN $5 ELSE owner_id END, due_on=CASE WHEN $6::boolean THEN $7 ELSE due_on END, required=coalesce($8,required), title=coalesce($9,title),
           done_by=CASE WHEN $2='done' THEN $10 WHEN $2<>'done' THEN NULL ELSE done_by END, done_at=CASE WHEN $2='done' THEN now() ELSE NULL END,
           archived_at=CASE WHEN $11::boolean THEN now() ELSE archived_at END
         WHERE id=$1 RETURNING *`,
        [r.id, status, i.waived_reason ?? null, 'owner_id' in i, i.owner_id ?? null, 'due_on' in i, i.due_on ?? null, i.required ?? null, i.title ?? null, user.id, !!i.archive])).rows[0];
      return reqRow(u);
    });
  },
});

// ---------------------------------------------------------------- live status board
async function boardOf(ev, c) {
  const q = (s, p) => (c ?? pool).query(s, p);
  const games = (await q("SELECT status, count(*)::int n FROM fixtures WHERE event_id=$1 GROUP BY status", [ev.id])).rows;
  const g = Object.fromEntries(games.map((x) => [x.status, x.n]));
  const next = (await q(
    `SELECT f.id, f.scheduled_at, f.status, f.round_kind, h.name AS home, a.name AS away FROM fixtures f LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id
      WHERE f.event_id=$1 AND f.status IN ('scheduled','live','paused') ORDER BY (f.status='live') DESC, f.scheduled_at LIMIT 3`, [ev.id])).rows;
  const inc = (await q("SELECT severity, status, count(*)::int n FROM event_incidents WHERE event_id=$1 GROUP BY severity, status", [ev.id])).rows;
  const openInc = inc.filter((x) => ['open', 'acknowledged', 'escalated'].includes(x.status));
  const scans = (await q("SELECT count(*) FILTER (WHERE at > now() - interval '1 hour')::int AS last_hour, count(*) FILTER (WHERE result='valid' AND direction='in')::int AS checked_in, count(*) FILTER (WHERE result NOT IN ('valid'))::int AS refused FROM accreditation_scans WHERE event_id=$1", [ev.id])).rows[0];
  const tasks = (await q("SELECT count(*) FILTER (WHERE status='blocked')::int blocked, count(*) FILTER (WHERE status IN ('todo','doing') AND due_on < current_date)::int overdue FROM event_tasks WHERE event_id=$1", [ev.id])).rows[0];
  const cards = (await q("SELECT count(*) FILTER (WHERE column_key='blocked')::int blocked FROM event_cards WHERE event_id=$1 AND status='active'", [ev.id])).rows[0];
  const linked = (await q(
    `SELECT (SELECT count(*) FROM mr_incidents WHERE event_id=$1 AND status='open')::int AS media_open,
            (SELECT count(*) FROM trip_incidents ti JOIN trip_events te ON te.trip_id=ti.trip_id AND te.event_id=$1 AND te.unlinked_at IS NULL WHERE ti.status NOT IN ('resolved','closed'))::int AS travel_open`, [ev.id]).catch(() => ({ rows: [{ media_open: 0, travel_open: 0 }] }))).rows[0];
  const ready = await readinessOf(ev, c);
  const crew = (await q("SELECT count(*)::int n FROM event_department_members WHERE event_id=$1 AND status='active'", [ev.id])).rows[0].n;
  const worst = ['critical', 'high', 'medium', 'low'].find((s) => openInc.some((x) => x.severity === s)) ?? null;
  return {
    event: { id: ev.id, name: ev.name, status: ev.status, pause_reason: ev.pause_reason ?? null, closed: !!ev.ops_closed_at },
    games: { live: g.live ?? 0, paused: g.paused ?? 0, scheduled: g.scheduled ?? 0, finished: (g.finished ?? 0) + (g.completed ?? 0), postponed: g.postponed ?? 0, abandoned: g.abandoned ?? 0 },
    next_up: next,
    incidents: { open: openInc.reduce((s, x) => s + x.n, 0), worst, by_severity: Object.fromEntries(SEVERITIES.map((s) => [s, openInc.filter((x) => x.severity === s).reduce((t, x) => t + x.n, 0)])), media_open: linked.media_open, travel_open: linked.travel_open },
    access: { checked_in: scans.checked_in, scans_last_hour: scans.last_hour, refused: scans.refused },
    tasks: { overdue: tasks.overdue, blocked: tasks.blocked + (cards.blocked ?? 0) },
    crew: { active: crew },
    readiness: { percent: ready.percent, open: ready.items.filter((x) => x.required && x.state === 'open').length },
    as_of: new Date().toISOString(),
  };
}

cap({
  name: 'get_event_status_board', method: 'GET', path: '/events/:id/ops/board', tag: TAG,
  summary: 'The live event-day board: games live / next up, open incidents by severity (plus open media and travel incidents from their own desks), gate check-ins and refusals, blocked and overdue work, crew count and readiness. Poll it. Visible to the organiser, department leads and crew.',
  input: z.object({ id }),
  async handler({ user }, i) { const { ev } = await loadEvent(user, i.id); return boardOf(ev); },
});

// ---------------------------------------------------------------- incidents
const incRow = (r, detail) => ({
  id: r.id, ref: `INC-${r.number}`, number: r.number, severity: r.severity, category: r.category, status: r.status, title: r.title, location: r.location, fixture_id: r.fixture_id, department_id: r.department_id,
  reported_by: r.reported_by, reporter_name: r.reporter_name ?? null, assigned_to: r.assigned_to, assignee_name: r.assignee_name ?? null, escalation_level: r.escalation_level,
  occurred_at: r.occurred_at, acknowledged_at: r.acknowledged_at, resolved_at: r.resolved_at, closed_at: r.closed_at, ...(detail ?? {}),
});
const INC_SELECT = `SELECT i.*, r.display_name AS reporter_name, a.display_name AS assignee_name FROM event_incidents i JOIN users r ON r.id=i.reported_by LEFT JOIN users a ON a.id=i.assigned_to`;
const logIncident = (c, incidentId, actor, action, note) => c.query('INSERT INTO event_incident_log(incident_id, actor_id, action, note_enc) VALUES ($1,$2,$3,$4)', [incidentId, actor, action, note ? encrypt(note, 'event_incident_log.note_enc') : null]);

/** Who must hear about an incident at this level: 0 organiser (high+) · 1 organiser + department leads · 2/3 organiser + all leads + platform-facing note. */
async function alertManagers(c, ev, inc, why) {
  const leads = (await c.query("SELECT DISTINCT lead_user_id AS u FROM event_departments WHERE event_id=$1 AND status='active' AND lead_user_id IS NOT NULL", [ev.id])).rows.map((x) => x.u);
  const targets = new Set([ev.organizer_id, ...(inc.escalation_level >= 1 || inc.severity === 'critical' ? leads : []), ...(inc.assigned_to ? [inc.assigned_to] : [])]);
  for (const u of targets) await notify(c, u, { kind: 'event_incident', title: `${why}: INC-${inc.number} (${inc.severity}) at ${ev.name}`, body: inc.title, data: { event_id: ev.id, ops_incident_id: inc.id } });
}

cap({
  name: 'report_event_incident', method: 'POST', path: '/events/:id/ops/incidents', tag: TAG, status: 201,
  summary: 'Report an incident from anywhere on the crew (any department member or accepted staff). High and critical incidents alert the organiser at once; critical ones also alert every department lead. The description is field-encrypted. Idempotent with `client_key` for offline retries.',
  input: z.object({ id, title: text(160), severity: z.enum(SEVERITIES), category: z.enum(INCIDENT_CATEGORIES), detail: z.string().trim().max(4000).optional(), location: z.string().trim().max(120).optional(), fixture_id: id.optional(), department_id: id.optional(), occurred_at: z.string().datetime({ offset: true }).optional(), client_key: z.string().min(8).max(80).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ev } = await loadEvent(user, i.id, null, c);
      if (ev.ops_closed_at) throw conflict('Operations are closed for this event; reopen before reporting');
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`inc:${ev.id}`]);
      if (i.client_key) {
        const dup = (await c.query('SELECT * FROM event_incidents WHERE event_id=$1 AND reported_by=$2 AND client_key=$3', [ev.id, user.id, i.client_key])).rows[0];
        if (dup) return incRow(dup);
      }
      if (i.fixture_id && !(await c.query('SELECT 1 FROM fixtures WHERE id=$1 AND event_id=$2', [i.fixture_id, ev.id])).rowCount) throw badRequest('That game is not part of this event');
      if (i.department_id && !(await c.query('SELECT 1 FROM event_departments WHERE id=$1 AND event_id=$2', [i.department_id, ev.id])).rowCount) throw badRequest('That department is not part of this event');
      const num = (await c.query('SELECT coalesce(max(number),0)+1 AS n FROM event_incidents WHERE event_id=$1', [ev.id])).rows[0].n;
      const inc = (await c.query(
        `INSERT INTO event_incidents(event_id, number, severity, category, title, detail_enc, location, fixture_id, department_id, reported_by, occurred_at, client_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,coalesce($11,now()),$12) RETURNING *`,
        [ev.id, num, i.severity, i.category, i.title, i.detail ? encrypt(i.detail, 'event_incidents.detail_enc') : null, i.location ?? null, i.fixture_id ?? null, i.department_id ?? null, user.id, i.occurred_at ?? null, i.client_key ?? null])).rows[0];
      await logIncident(c, inc.id, user.id, 'reported', null);
      if (['high', 'critical'].includes(i.severity)) await alertManagers(c, ev, inc, 'New incident');
      return incRow(inc);
    });
  },
});

cap({
  name: 'list_event_incidents', method: 'GET', path: '/events/:id/ops/incidents', tag: TAG,
  summary: 'Incidents of the event, worst and newest first. Crew see titles, severity, status and who handles them; the encrypted description and resolution are returned by get_event_incident (audit-logged).',
  input: z.object({ id, status: z.enum(['active', 'resolved', 'closed', 'all']).default('active') }),
  async handler({ user }, i) {
    const { ev } = await loadEvent(user, i.id);
    const where = i.status === 'all' ? '' : i.status === 'active' ? "AND i.status IN ('open','acknowledged','escalated')" : `AND i.status='${i.status}'`;
    const rows = (await many(`${INC_SELECT} WHERE i.event_id=$1 ${where} ORDER BY array_position(ARRAY['critical','high','medium','low'], i.severity), i.created_at DESC LIMIT 300`, [ev.id]));
    return rows.map((r) => incRow(r));
  },
});

cap({
  name: 'get_event_incident', method: 'GET', path: '/events/:id/ops/incidents/:incident_id', tag: TAG,
  summary: 'One incident with its description, resolution and full history. Reading the decrypted text is audit-logged. Reporter, handler, organiser and department leads only.',
  input: z.object({ id, incident_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ev, access } = await loadEvent(user, i.id, null, c);
      const r = (await c.query(`${INC_SELECT} WHERE i.id=$1 AND i.event_id=$2`, [i.incident_id, ev.id])).rows[0];
      if (!r) throw notFound('Incident');
      if (!access.manager && ![r.reported_by, r.assigned_to].includes(user.id)) throw notFound('Incident');
      await audit(c, user.id, 'read_event_incident', 'event_incident', r.id);
      const log = (await c.query('SELECT l.id, l.action, l.note_enc, l.at, u.display_name AS actor_name FROM event_incident_log l LEFT JOIN users u ON u.id=l.actor_id WHERE l.incident_id=$1 ORDER BY l.at', [r.id])).rows;
      return incRow(r, {
        detail: r.detail_enc ? decrypt(r.detail_enc, 'event_incidents.detail_enc') : null, resolution: r.resolution_enc ? decrypt(r.resolution_enc, 'event_incidents.resolution_enc') : null,
        history: log.map((l) => ({ id: l.id, action: l.action, actor_name: l.actor_name, at: l.at, note: l.note_enc ? decrypt(l.note_enc, 'event_incident_log.note_enc') : null })),
      });
    });
  },
});

cap({
  name: 'update_event_incident', method: 'POST', path: '/events/:id/ops/incidents/:incident_id/action', tag: TAG,
  summary: 'Move an incident through its workflow: acknowledge, assign (to a crew member), escalate (one level up, reason required; alerts the organiser and every department lead), note, resolve (with what was done), reopen, close. Organiser and department leads manage; the reporter may add notes. Every step is appended to the history.',
  input: z.object({ id, incident_id: id, action: z.enum(['acknowledge', 'assign', 'escalate', 'note', 'resolve', 'reopen', 'close']), assignee_id: id.optional(), note: z.string().trim().max(2000).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ev, access } = await loadEvent(user, i.id, null, c);
      const r = (await c.query('SELECT * FROM event_incidents WHERE id=$1 AND event_id=$2 FOR UPDATE', [i.incident_id, ev.id])).rows[0];
      if (!r) throw notFound('Incident');
      const mine = r.reported_by === user.id || r.assigned_to === user.id;
      if (i.action === 'note') { if (!access.manager && !mine) throw notFound('Incident'); }
      else if (!access.manager && !(i.action === 'acknowledge' && r.assigned_to === user.id) && !(i.action === 'resolve' && r.assigned_to === user.id)) throw forbidden('Only the organiser or a department lead can do this');
      const active = ['open', 'acknowledged', 'escalated'].includes(r.status);
      const need = (ok, msg) => { if (!ok) throw conflict(msg); };
      let set = '', args = [];
      switch (i.action) {
        case 'acknowledge': need(r.status === 'open' || r.status === 'escalated', 'Only an open incident can be acknowledged'); set = "status='acknowledged', acknowledged_at=coalesce(acknowledged_at, now())"; break;
        case 'assign': {
          need(active, 'The incident is not active');
          if (!i.assignee_id) throw badRequest('Choose who handles it');
          const ok = (await c.query(`SELECT 1 FROM event_department_members WHERE event_id=$1 AND user_id=$2 AND status='active' UNION SELECT 1 FROM event_staff_assignments WHERE event_id=$1 AND user_id=$2 AND status='accepted' UNION SELECT 1 FROM events WHERE id=$1 AND organizer_id=$2`, [ev.id, i.assignee_id])).rowCount;
          if (!ok) throw badRequest('Assign to someone on the event crew');
          set = 'assigned_to=$3'; args = [i.assignee_id]; break;
        }
        case 'escalate': need(active, 'The incident is not active'); need(r.escalation_level < 3, 'Already at the highest escalation level'); if (!i.note) throw badRequest('Say why you are escalating'); set = "status='escalated', escalation_level=escalation_level+1"; break;
        case 'resolve': need(active, 'The incident is not active'); if (!i.note) throw badRequest('Say what was done'); set = "status='resolved', resolved_at=now(), resolution_enc=$3"; args = [encrypt(i.note, 'event_incidents.resolution_enc')]; break;
        case 'reopen': need(['resolved', 'closed'].includes(r.status), 'Only a resolved or closed incident can be reopened'); if (ev.ops_closed_at) throw conflict('Operations are closed for this event'); if (!i.note) throw badRequest('Say why it is reopened'); set = "status='open', resolved_at=NULL, closed_at=NULL"; break;
        case 'close': need(r.status === 'resolved', 'Resolve the incident before closing it'); set = "status='closed', closed_at=now()"; break;
        case 'note': if (!i.note) throw badRequest('Write the note'); break;
      }
      const u = set ? (await c.query(`UPDATE event_incidents SET ${set} WHERE id=$1 AND event_id=$2 RETURNING *`, [r.id, ev.id, ...args])).rows[0] : r;
      await logIncident(c, r.id, user.id, { acknowledge: 'acknowledged', assign: 'assigned', escalate: 'escalated', note: 'note', resolve: 'resolved', reopen: 'reopened', close: 'closed' }[i.action], i.note ?? null);
      if (i.action === 'escalate') await alertManagers(c, ev, u, `Escalated to level ${u.escalation_level}`);
      if (i.action === 'assign') await notify(c, i.assignee_id, { kind: 'event_incident', title: `You are handling INC-${u.number} at ${ev.name}`, body: u.title, data: { event_id: ev.id, ops_incident_id: u.id } });
      return incRow(u);
    });
  },
});

// ---------------------------------------------------------------- operational contacts
const contactRow = (r, pii) => ({ id: r.id, area: r.area, name: r.name, role_title: r.role_title, user_id: r.user_id, on_duty: r.on_duty, has_phone: !!r.phone_enc, has_email: !!r.email_enc, ...(pii ? { phone: r.phone_enc ? decrypt(r.phone_enc, 'event_ops_contacts.phone_enc') : null, email: r.email_enc ? decrypt(r.email_enc, 'event_ops_contacts.email_enc') : null } : {}) });

cap({
  name: 'list_event_contacts', method: 'GET', path: '/events/:id/ops/contacts', tag: TAG,
  summary: 'Operational contacts (control room, venue, medical, security, officials, media, transport, suppliers, sponsors, emergency). Names and roles are visible to crew; phone numbers and emails are returned with include_contact=true and every such read is audit-logged.',
  input: z.object({ id, include_contact: z.coerce.boolean().default(false) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ev } = await loadEvent(user, i.id, null, c);
      const rows = (await c.query('SELECT * FROM event_ops_contacts WHERE event_id=$1 AND archived_at IS NULL ORDER BY array_position($2::text[], area), name', [ev.id, CONTACT_AREAS])).rows;
      if (i.include_contact && rows.length) await audit(c, user.id, 'read_event_contacts', 'event', ev.id);
      return rows.map((r) => contactRow(r, i.include_contact));
    });
  },
});

cap({
  name: 'add_event_contact', method: 'POST', path: '/events/:id/ops/contacts', tag: TAG, status: 201,
  summary: 'Add an operational contact. Pick a platform user (`user_id`) or give a name; phone and email are field-encrypted.',
  input: z.object({ id, area: z.enum(CONTACT_AREAS), name: z.string().trim().min(2).max(100), role_title: z.string().trim().max(80).optional(), user_id: id.optional(), phone: z.string().trim().regex(/^\+?[0-9 ()-]{6,20}$/, 'enter a phone number').optional(), email: z.string().trim().email().optional(), on_duty: z.string().trim().max(120).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ev } = await loadEvent(user, i.id, 'manager', c);
      if (i.user_id && !(await c.query('SELECT 1 FROM users WHERE id=$1', [i.user_id])).rowCount) throw notFound('User');
      const r = (await c.query('INSERT INTO event_ops_contacts(event_id, area, name, role_title, user_id, phone_enc, email_enc, on_duty, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
        [ev.id, i.area, i.name, i.role_title ?? null, i.user_id ?? null, i.phone ? encrypt(i.phone, 'event_ops_contacts.phone_enc') : null, i.email ? encrypt(i.email, 'event_ops_contacts.email_enc') : null, i.on_duty ?? null, user.id])).rows[0];
      return contactRow(r, false);
    });
  },
});

cap({
  name: 'update_event_contact', method: 'PATCH', path: '/events/:id/ops/contacts/:contact_id', tag: TAG,
  summary: 'Change a contact, or archive it (kept, hidden).',
  input: z.object({ id, contact_id: id, area: z.enum(CONTACT_AREAS).optional(), name: z.string().trim().min(2).max(100).optional(), role_title: z.string().trim().max(80).nullable().optional(), phone: z.string().trim().regex(/^\+?[0-9 ()-]{6,20}$/).nullable().optional(), email: z.string().trim().email().nullable().optional(), on_duty: z.string().trim().max(120).nullable().optional(), archive: z.boolean().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ev } = await loadEvent(user, i.id, 'manager', c);
      const r = (await c.query('SELECT * FROM event_ops_contacts WHERE id=$1 AND event_id=$2 AND archived_at IS NULL FOR UPDATE', [i.contact_id, ev.id])).rows[0];
      if (!r) throw notFound('Contact');
      const u = (await c.query(
        `UPDATE event_ops_contacts SET area=coalesce($2,area), name=coalesce($3,name), role_title=CASE WHEN $4::boolean THEN $5 ELSE role_title END, phone_enc=CASE WHEN $6::boolean THEN $7 ELSE phone_enc END,
           email_enc=CASE WHEN $8::boolean THEN $9 ELSE email_enc END, on_duty=CASE WHEN $10::boolean THEN $11 ELSE on_duty END, archived_at=CASE WHEN $12::boolean THEN now() ELSE archived_at END WHERE id=$1 RETURNING *`,
        [r.id, i.area ?? null, i.name ?? null, 'role_title' in i, i.role_title ?? null, 'phone' in i, i.phone ? encrypt(i.phone, 'event_ops_contacts.phone_enc') : null, 'email' in i, i.email ? encrypt(i.email, 'event_ops_contacts.email_enc') : null, 'on_duty' in i, i.on_duty ?? null, !!i.archive])).rows[0];
      return contactRow(u, false);
    });
  },
});

// ---------------------------------------------------------------- debrief and closure
async function debriefOf(ev, c) {
  const q = (s, p) => (c ?? pool).query(s, p);
  const d = (await q('SELECT * FROM event_debriefs WHERE event_id=$1', [ev.id])).rows[0] ?? null;
  const items = (await q(`SELECT b.id, b.kind, b.area, b.body, b.owner_id, o.display_name AS owner_name, b.task_id, t.status AS task_status FROM event_debrief_items b LEFT JOIN users o ON o.id=b.owner_id LEFT JOIN event_tasks t ON t.id=b.task_id WHERE b.event_id=$1 AND b.archived_at IS NULL ORDER BY b.created_at`, [ev.id])).rows;
  return { summary: d?.summary ?? null, status: d?.status ?? 'none', finalized_at: d?.finalized_at ?? null, items };
}

cap({
  name: 'get_event_debrief', method: 'GET', path: '/events/:id/ops/debrief', tag: TAG,
  summary: 'The post-event debrief: summary and the went-well / improve / lesson items. Improvement items can carry a follow-up task that lives in the event task list.',
  input: z.object({ id }),
  async handler({ user }, i) { const { ev } = await loadEvent(user, i.id, 'manager'); return debriefOf(ev); },
});

cap({
  name: 'save_event_debrief', method: 'POST', path: '/events/:id/ops/debrief', tag: TAG,
  summary: 'Write or update the debrief summary (draft). Finalizing is a separate step and locks nothing you cannot reopen: add items any time.',
  input: z.object({ id, summary: z.string().trim().max(4000) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ev } = await loadEvent(user, i.id, 'organiser', c);
      await c.query(`INSERT INTO event_debriefs(event_id, summary, created_by) VALUES ($1,$2,$3) ON CONFLICT (event_id) DO UPDATE SET summary=EXCLUDED.summary, updated_at=now(), status=CASE WHEN event_debriefs.status='final' THEN 'draft' ELSE event_debriefs.status END`, [ev.id, i.summary, user.id]);
      return debriefOf(ev, c);
    });
  },
});

cap({
  name: 'add_debrief_item', method: 'POST', path: '/events/:id/ops/debrief/items', tag: TAG, status: 201,
  summary: 'Record what went well, what to improve, or a lesson learned, optionally for an area. For an improvement you can create the follow-up as an event task (`follow_up: {owner_id, due_on}`) so it is tracked once, in the task list.',
  input: z.object({ id, kind: z.enum(['went_well', 'improve', 'lesson']), area: area.optional(), body: text(1000), follow_up: z.object({ owner_id: id.optional(), due_on: date.optional() }).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ev } = await loadEvent(user, i.id, 'organiser', c);
      let taskId = null;
      if (i.follow_up) {
        const cat = { venue: 'venue', officials: 'officials', medical: 'medical', suppliers: 'equipment', sponsors: 'sponsors', finance: 'finance', safety: 'safety', transport: 'logistics' }[i.area] ?? 'general';
        const t = await c.query("INSERT INTO event_tasks(event_id, title, category, owner_id, due_on, priority, notes, created_by) VALUES ($1,$2,$3,$4,$5,'normal','From the post-event debrief',$6) ON CONFLICT DO NOTHING RETURNING id",
          [ev.id, `Follow up: ${i.body.slice(0, 120)}`, cat, i.follow_up.owner_id ?? null, i.follow_up.due_on ?? null, user.id]);
        taskId = t.rows[0]?.id ?? null;
      }
      const r = (await c.query('INSERT INTO event_debrief_items(event_id, kind, area, body, owner_id, task_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [ev.id, i.kind, i.area ?? null, i.body, i.follow_up?.owner_id ?? null, taskId, user.id])).rows[0];
      return { id: r.id, task_id: taskId };
    });
  },
});

cap({
  name: 'archive_debrief_item', method: 'DELETE', path: '/events/:id/ops/debrief/items/:item_id', tag: TAG,
  summary: 'Archive a debrief item (kept, hidden). Any follow-up task stays in the task list.',
  input: z.object({ id, item_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ev } = await loadEvent(user, i.id, 'organiser', c);
      const r = await c.query('UPDATE event_debrief_items SET archived_at=now() WHERE id=$1 AND event_id=$2 AND archived_at IS NULL', [i.item_id, ev.id]);
      if (!r.rowCount) throw notFound('Debrief item');
      return { archived: true };
    });
  },
});

cap({
  name: 'close_event_operations', method: 'POST', path: '/events/:id/ops/close', tag: TAG,
  summary: 'Close the event’s operations. Needs the event to be completed or cancelled, no active incidents, and a finalized debrief with a summary. Closing finalizes the debrief and locks new incidents until reopened (reopen_event_operations). Nothing is deleted.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ev } = await loadEvent(user, i.id, 'organiser', c);
      if (ev.ops_closed_at) throw conflict('Operations are already closed');
      const blockers = [];
      if (!['completed', 'cancelled'].includes(ev.status)) blockers.push('The event has not ended');
      const act = n((await c.query("SELECT count(*) n FROM event_incidents WHERE event_id=$1 AND status IN ('open','acknowledged','escalated')", [ev.id])).rows);
      if (act) blockers.push(`${plural(act, 'incident')} still active`);
      const d = (await c.query('SELECT summary FROM event_debriefs WHERE event_id=$1', [ev.id])).rows[0];
      if (!d?.summary || d.summary.length < 10) blockers.push('Write the debrief summary');
      if (blockers.length) throw conflict('Operations cannot be closed yet', { blockers });
      await c.query("UPDATE event_debriefs SET status='final', finalized_by=$2, finalized_at=now() WHERE event_id=$1", [ev.id, user.id]);
      await c.query('UPDATE events SET ops_closed_at=now(), ops_closed_by=$2 WHERE id=$1', [ev.id, user.id]);
      return { closed: true };
    });
  },
});

cap({
  name: 'reopen_event_operations', method: 'POST', path: '/events/:id/ops/reopen', tag: TAG,
  summary: 'Reopen a closed event’s operations (e.g. a late incident). The debrief goes back to draft.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ev } = await loadEvent(user, i.id, 'organiser', c);
      if (!ev.ops_closed_at) throw conflict('Operations are not closed');
      await c.query('UPDATE events SET ops_closed_at=NULL, ops_closed_by=NULL WHERE id=$1', [ev.id]);
      await c.query("UPDATE event_debriefs SET status='draft', finalized_at=NULL, finalized_by=NULL WHERE event_id=$1", [ev.id]);
      return { closed: false };
    });
  },
});

// ---------------------------------------------------------------- report
/** Facts only, no personal data: counts, readiness, incident log without descriptions, debrief. */
async function reportOf(ev, c) {
  const q = (s, p) => (c ?? pool).query(s, p);
  const [readiness, board, debrief] = [await readinessOf(ev, c), await boardOf(ev, c), await debriefOf(ev, c)];
  const incidents = (await q(`${INC_SELECT} WHERE i.event_id=$1 ORDER BY i.number`, [ev.id])).rows.map((r) => incRow(r));
  const contacts = (await q('SELECT area, name, role_title, on_duty FROM event_ops_contacts WHERE event_id=$1 AND archived_at IS NULL ORDER BY name', [ev.id])).rows;
  const budget = (await q("SELECT direction, sum(planned_cents)::bigint planned, sum(committed_cents)::bigint committed FROM event_budget_lines WHERE event_id=$1 AND status<>'void' GROUP BY direction", [ev.id])).rows;
  const paid = (await q("SELECT l.direction, sum(p.amount_cents)::bigint paid FROM event_budget_payments p JOIN event_budget_lines l ON l.id=p.line_id WHERE p.event_id=$1 AND p.voided_at IS NULL GROUP BY l.direction", [ev.id])).rows;
  return {
    event: { id: ev.id, name: ev.name, status: ev.status, starts_on: ev.starts_on, ends_on: ev.ends_on, currency: ev.currency, operations_closed_at: ev.ops_closed_at },
    generated_at: new Date().toISOString(), readiness, day_board: board, incidents, contacts, debrief,
    money: budget.map((b) => ({ direction: b.direction, planned_cents: Number(b.planned), committed_cents: Number(b.committed), paid_cents: Number(paid.find((p) => p.direction === b.direction)?.paid ?? 0) })),
  };
}

cap({
  name: 'get_event_ops_report', method: 'GET', path: '/events/:id/ops/report', tag: TAG,
  summary: 'The event operations report: readiness by area, the day-board numbers, the incident log (titles, severity, handling times: no descriptions), contacts without phone or email, the debrief and the money summary. Organiser only; the read is audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => { const { ev } = await loadEvent(user, i.id, 'organiser', c); await audit(c, user.id, 'read_event_ops_report', 'event', ev.id); return reportOf(ev, c); });
  },
});

cap({
  name: 'export_event_ops_report', method: 'GET', path: '/events/:id/ops/report/export', tag: TAG,
  summary: 'The operations report as CSV (readiness, incidents, debrief items) to share or archive. Organiser only; audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ev } = await loadEvent(user, i.id, 'organiser', c);
      await audit(c, user.id, 'export_event_ops_report', 'event', ev.id);
      const r = await reportOf(ev, c);
      const esc = (v) => { const s = String(v ?? ''); return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`; };
      const rows = [['section', 'area_or_ref', 'item', 'state', 'detail'].join(',')];
      for (const x of r.readiness.items) rows.push(['readiness', x.area_label, esc(x.title), x.state, esc(x.detail ?? x.waived_reason ?? '')].join(','));
      for (const x of r.incidents) rows.push(['incident', x.ref, esc(x.title), x.status, esc(`${x.severity} ${x.category}; escalation ${x.escalation_level}; occurred ${new Date(x.occurred_at).toISOString()}${x.resolved_at ? `; resolved ${new Date(x.resolved_at).toISOString()}` : ''}`)].join(','));
      for (const x of r.debrief.items) rows.push(['debrief', x.kind, esc(x.body), x.task_status ?? '', esc(x.area ?? '')].join(','));
      return { filename: `${ev.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-operations-report.csv`, rows: rows.length - 1, csv: rows.join('\n') };
    });
  },
});
